"""Trusted, observed two-arm native stage trees.

The public candidate describes one logical workflow. Both paths must have real
stage receipts; selection at replay uses a fresh positive screen contract after
the shared fork command, with the declared enum/boolean input checked separately.
"""
from __future__ import annotations

import copy
import json
import re

from .mobile_ui import MobileError, digest, selection_selector
from . import mobile_stages as stages

MODE = 'native-branch-stages-v1'
MAX_BYTES = 2 * 1024 * 1024
ID = re.compile(r'[A-Za-z][A-Za-z0-9_]{0,39}')


def fail(code):
    raise MobileError(code, 'blocked')


def validate_config(config):
    value = config.get('nativeBranchPlanning')
    if value is None:
        return None
    if (config.get('nativeStagePlanning') is not None or not isinstance(value, dict) or
            set(value) != {'workflowId', 'forkInput', 'arms'} or
            not isinstance(value.get('workflowId'), str) or not ID.fullmatch(value['workflowId']) or
            value['workflowId'] in {'constructor', 'prototype'} or
            not isinstance(value.get('forkInput'), dict) or set(value['forkInput']) != {'kind', 'selector'} or
            value['forkInput'].get('kind') not in {'check', 'select'} or
            not isinstance(value.get('arms'), list) or len(value['arms']) != 2):
        fail('NATIVE_BRANCH_CONFIG_INVALID')
    fork = value['forkInput']
    selection_selector(fork['selector'])
    ids, values = set(), []
    for arm in value['arms']:
        if (not isinstance(arm, dict) or set(arm) != {'id', 'value', 'seedInputs'} or
                not isinstance(arm.get('id'), str) or not ID.fullmatch(arm['id']) or
                arm['id'] in {'constructor', 'prototype'} or arm['id'] in ids):
            fail('NATIVE_BRANCH_CONFIG_INVALID')
        ids.add(arm['id'])
        branch_value = arm['value']
        if fork['kind'] == 'check':
            if not isinstance(branch_value, bool):
                fail('NATIVE_BRANCH_CONFIG_INVALID')
        elif not isinstance(branch_value, str) or not 1 <= len(branch_value) <= 128 or '\0' in branch_value:
            fail('NATIVE_BRANCH_CONFIG_INVALID')
        values.append(branch_value)
        # Reuse the exact seed-kind/selector/value grammar without replacing
        # the caller's trusted config or its source identity.
        stages.validate_config({'nativeStagePlanning': {'workflowId': value['workflowId'], 'seedInputs': arm['seedInputs']}})
        seeds = [row for row in arm['seedInputs'] if row['kind'] == fork['kind'] and row['selector'] == fork['selector']]
        if len(seeds) != 1 or type(seeds[0]['value']) is not type(branch_value) or seeds[0]['value'] != branch_value:
            fail('NATIVE_BRANCH_FORK_SEED_INVALID')
        # Every configured path's input permission is checked before either
        # path can perform a command, including the initially unselected arm.
        for seed in arm['seedInputs']:
            if not any(row.get('kind', 'click') == seed['kind'] and row.get('selector') == seed['selector'] and row.get('effect') == 'read'
                       for row in config.get('actionAllowlist', [])):
                fail('NATIVE_BRANCH_ACTION_NOT_APPROVED')
    if values[0] == values[1]:
        fail('NATIVE_BRANCH_DOMAIN_INVALID')
    return value


class _ArmSession:
    """Internal view: same source, backend, lease, budget and durable progress."""
    def __init__(self, parent, cfg, arm):
        object.__setattr__(self, '_parent', parent)
        object.__setattr__(self, '_native_branch_arm_id', arm['id'])
        object.__setattr__(self, 'config', {**parent.config, 'nativeStagePlanning': {
            'workflowId': cfg['workflowId'], 'seedInputs': arm['seedInputs']}})

    def __getattr__(self, key):
        return getattr(self._parent, key)

    def __setattr__(self, key, value):
        if key in {'_parent', 'config', '_native_stage_replay_run', '_native_branch_arm_id'}:
            object.__setattr__(self, key, value)
        else:
            setattr(self._parent, key, value)

    def _native_branch_check_stage(self, stage):
        cfg = self.config['nativeBranchPlanning']
        fork = cfg['forkInput']
        matching = [field for field in stage['fields'] if field['selector'] == fork['selector']]
        if matching:
            values = [arm['value'] for arm in cfg['arms']]
            field = matching[0]
            if len(matching) != 1 or field['kind'] != fork['kind']:
                fail('NATIVE_BRANCH_DOMAIN_NOT_PROVEN')
            if field['kind'] == 'select' and (len(field['options']) != 2 or {row['value'] for row in field['options']} != set(values)):
                fail('NATIVE_BRANCH_DOMAIN_NOT_PROVEN')
        observed = [row for arm in self.progress.get('nativeBranchTrace', {}).get('arms', []) for row in arm['trace']['stages']]
        observed += self.progress.get('nativeStageTrace', {}).get('stages', []) + [stage]
        if len({digest(_structure(row)) for row in observed}) > 16:
            fail('NATIVE_BRANCH_NODE_LIMIT')


def arm_session(session, branch_plan, arm):
    cfg = validate_config(session.config)
    if cfg is None or not isinstance(arm, dict):
        fail('NATIVE_BRANCH_NOT_APPROVED')
    approved = next((row for row in cfg['arms'] if row['id'] == arm.get('id')), None)
    if approved is None or type(approved['value']) is not type(arm.get('value')) or approved['value'] != arm['value']:
        fail('NATIVE_BRANCH_ARM_INVALID')
    return _ArmSession(session, cfg, approved)


def _structure(stage):
    return {key: stage[key] for key in ['group', 'fields', 'button', 'outputs']}


def _events_for(events, run_id):
    if (not isinstance(events, list) or
            any(not isinstance(row, dict) or not isinstance(row.get('kind'), str) for row in events)):
        fail('NATIVE_BRANCH_EVENT_IDS_INVALID')
    ids = [row.get('evidenceId') for row in events]
    if any(not isinstance(ident, str) for ident in ids) or len(ids) != len(set(ids)):
        fail('NATIVE_BRANCH_EVENT_IDS_INVALID')
    return [copy.deepcopy(row) for row in events if row.get('kind', '').startswith('native_') and row.get('stageRunId') == run_id]


def _linear_plan(session, cfg_arm, trace, events):
    proxy = arm_session(session, None, cfg_arm)
    return stages.plan(proxy, {'schemaVersion': 1, 'identity': session.identity, 'nativeStageTrace': trace}, events)


def explore(session):
    cfg = validate_config(session.config)
    if cfg is None:
        fail('NATIVE_BRANCH_NOT_APPROVED')
    if session.progress.get('pending') or session.progress.get('nativeBranchTrace') or session.progress.get('nativeStageTrace'):
        fail('NATIVE_BRANCH_RESUME_REQUIRES_FRESH_RUN')
    branch = {'schemaVersion': 1, 'planningMode': MODE, 'identity': session.identity,
              'workflowId': cfg['workflowId'], 'arms': [], 'completed': False}
    session.progress['nativeBranchTrace'] = branch
    session.checkpoint()
    from .mobile_planner import _read_events
    for number, arm in enumerate(cfg['arms']):
        proxy = arm_session(session, None, arm)
        stages.explore(proxy)
        trace = copy.deepcopy(session.progress['nativeStageTrace'])
        events = _events_for(_read_events(session.output), trace['runId'])
        linear = _linear_plan(session, arm, trace, events)
        definition = next(iter(linear['specs'].values()))
        branch['arms'].append({'id': arm['id'], 'trace': trace})
        if len(json.dumps(branch).encode()) > MAX_BYTES:
            fail('NATIVE_BRANCH_EVIDENCE_LIMIT')
        # Recovery commands receive their own replay run id. They are never
        # spliced into either arm's completed discovery receipts.
        session.progress.pop('nativeStageTrace')
        session.checkpoint()
        if number == 0:
            stages.restore_entry(proxy, definition['stagePlan'])
            session.budget.check()
    # Compilation also verifies both paths' shared prefix, complete domain and
    # unique suffix structures before marking this exploration complete.
    branch['completed'] = True
    try:
        plan(session, session.progress, _read_events(session.output))
    except Exception:
        branch['completed'] = False
        session.progress['status'] = 'failed'
        session.checkpoint()
        raise
    session.progress['status'] = 'completed'
    session.checkpoint()
    return {'ok': True, 'status': 'completed', 'branches': 2,
            'states': sum(len(row['trace']['stages']) for row in branch['arms']),
            'actions': session.budget.count, 'capabilities': 0,
            'gaps': ['two_distinct_samples_per_branch_required']}


def _compile(session, traces, arm_events):
    cfg = validate_config(session.config)
    if cfg is None or len(traces) != 2 or len({trace.get('runId') for trace in traces}) != 2:
        fail('NATIVE_BRANCH_PROOF_INVALID')
    event_ids = [row.get('evidenceId') for events in arm_events for row in events]
    executions = [row.get('executionId') for events in arm_events for row in events if row.get('kind') == 'native_stage_action_started']
    occurrences = [stage.get('occurrenceId') for trace in traces for stage in trace.get('stages', [])]
    if (len(event_ids) != len(set(event_ids)) or len(executions) != len(set(executions)) or
            len(occurrences) != len(set(occurrences))):
        fail('NATIVE_BRANCH_CROSS_RUN_RECEIPT')
    children = []
    for cfg_arm, trace, events in zip(cfg['arms'], traces, arm_events):
        linear = _linear_plan(session, cfg_arm, trace, events)
        children.append(next(iter(linear['specs'].values())))
    paths = [trace['stages'] for trace in traces]
    if len(paths[0]) != len(paths[1]):
        fail('NATIVE_BRANCH_SCHEMA_MISMATCH')
    shared = 0
    while shared < len(paths[0]) and _structure(paths[0][shared]) == _structure(paths[1][shared]):
        shared += 1
    if shared < 1 or shared == len(paths[0]):
        fail('NATIVE_BRANCH_FORK_NOT_PROVEN')
    fork_index = shared - 1
    merged = [_structure(stage) for stage in paths[0][:shared]]
    merged += [_structure(stage) for path in paths for stage in path[shared:]]
    if len(merged) > 16 or len({digest(row) for row in merged}) != len(merged):
        fail('NATIVE_BRANCH_JOIN_OR_CYCLE_NOT_PROVEN')
    fork = cfg['forkInput']
    fork_fields = [(stage['index'], field) for stage in paths[0][:shared] for field in stage['fields']
                   if field['kind'] == fork['kind'] and field['selector'] == fork['selector']]
    if len(fork_fields) != 1:
        fail('NATIVE_BRANCH_FORK_INPUT_NOT_PROVEN')
    fork_field = fork_fields[0][1]
    values = [arm['value'] for arm in cfg['arms']]
    if fork['kind'] == 'select':
        domain = [row['value'] for row in fork_field['options']]
        if len(domain) != 2 or set(domain) != set(values):
            fail('NATIVE_BRANCH_DOMAIN_NOT_PROVEN')
    elif set(values) != {True, False}:
        fail('NATIVE_BRANCH_DOMAIN_NOT_PROVEN')
    shapes = [[[(field['kind'], field.get('options') and [row['value'] for row in field['options']])
                for field in stage['fields']] for stage in path] for path in paths]
    if shapes[0] != shapes[1]:
        fail('NATIVE_BRANCH_SCHEMA_MISMATCH')
    bindings = [[step for step in child['steps'] if step['kind'] in {'type', 'check', 'select'}] for child in children]
    global_names = [step['input'] for step in bindings[0]]
    if len(global_names) != len(set(global_names)):
        fail('NATIVE_BRANCH_SCHEMA_MISMATCH')
    schema = copy.deepcopy(children[0]['inputSchema'])
    branch_input = next((step['input'] for step in bindings[0] if step['kind'] == fork['kind'] and step['selector'] == fork['selector']), None)
    if not branch_input:
        fail('NATIVE_BRANCH_FORK_INPUT_NOT_PROVEN')
    arms = []
    for cfg_arm, child, bound in zip(cfg['arms'], children, bindings):
        if len(bound) != len(global_names):
            fail('NATIVE_BRANCH_SCHEMA_MISMATCH')
        mapping = {global_name: step['input'] for global_name, step in zip(global_names, bound)}
        if (len(set(mapping.values())) != len(mapping) or set(mapping.values()) != set(child['inputSchema']['properties']) or
                any(schema['properties'][key] != child['inputSchema']['properties'][local] for key, local in mapping.items())):
            fail('NATIVE_BRANCH_SCHEMA_MISMATCH')
        prefix_end = child['stagePlan']['ranges'][fork_index]['end'] + 1
        if child['steps'][:prefix_end] != children[0]['steps'][:prefix_end]:
            fail('NATIVE_BRANCH_PREFIX_NOT_PROVEN')
        arms.append({'id': cfg_arm['id'], 'value': cfg_arm['value'], 'inputMap': mapping, 'definition': child})
    target_count = len(children[0]['outcomeCandidates'])
    if target_count != len(children[1]['outcomeCandidates']):
        fail('NATIVE_BRANCH_OUTPUT_SCHEMA_MISMATCH')
    structural = [[_structure(stage) for stage in path] for path in paths]
    ident = 'mobile_branch_plan_' + digest([session.source, session.identity, structural])
    targets = [{'id': 'output_' + digest([ident, index]), 'kind': 'text',
                'armTargets': {arm['id']: copy.deepcopy(arm['definition']['outcomeCandidates'][index]) for arm in arms}}
               for index in range(target_count)]
    branch_plan = {'schemaVersion': 1, 'forkStageIndex': fork_index, 'branchInput': branch_input, 'arms': arms}
    definition = {'schemaVersion': 1, 'id': 'native_branch_' + digest([ident])[:40],
                  'name': '原生条件分支查询流程', 'effect': 'read', 'inputSchema': schema,
                  'branchPlan': branch_plan, 'outcomeCandidates': targets}
    if len(json.dumps(definition).encode()) > 524288:
        fail('NATIVE_BRANCH_EVIDENCE_LIMIT')
    item = {'id': ident, 'name': '原生条件分支查询候选', 'planningMode': MODE,
            'kind': 'mobile_workflow', 'readiness': 'candidate', 'effect': 'unknown', 'inputSchema': schema,
            'nativeInputs': [{'param': name, 'inputType': step['kind'], 'businessRequiredObserved': False}
                             for name, step in zip(global_names, bindings[0])],
            'outputTargets': [{'id': row['id'], 'kind': 'text', 'label': '结果区域'} for row in targets],
            'evidence': {'parameterizationValidated': False, 'branchesObserved': 2,
                         'inputPreparationProven': True, 'uniquePositiveBranchContracts': True},
            'gaps': ['two_distinct_samples_per_branch_required', 'parameter_related_assertion_required',
                     'native_business_required_not_observed']}
    return {'schemaVersion': 1, 'source': {**session.source, 'revision': digest([session.identity, structural])},
            'items': [item], 'specs': {ident: definition}, 'total': 1, 'nextOffset': None,
            'truncated': False, 'gaps': []}


def plan(session, checkpoint, events):
    cfg = validate_config(session.config)
    if not isinstance(checkpoint, dict):
        fail('NATIVE_BRANCH_PROOF_INVALID')
    branch = checkpoint.get('nativeBranchTrace')
    if (cfg is None or checkpoint.get('schemaVersion') != 1 or checkpoint.get('identity') != session.identity or
            not isinstance(branch, dict) or set(branch) != {'schemaVersion', 'planningMode', 'identity', 'workflowId', 'arms', 'completed'} or
            branch.get('schemaVersion') != 1 or branch.get('planningMode') != MODE or
            branch.get('identity') != session.identity or branch.get('workflowId') != cfg['workflowId'] or
            branch.get('completed') is not True or not isinstance(branch.get('arms'), list) or len(branch['arms']) != 2 or
            len(json.dumps(branch).encode()) > MAX_BYTES):
        fail('NATIVE_BRANCH_PROOF_INVALID')
    traces, proofs = [], []
    for cfg_arm, row in zip(cfg['arms'], branch['arms']):
        if not isinstance(row, dict) or set(row) != {'id', 'trace'} or row['id'] != cfg_arm['id'] or not isinstance(row['trace'], dict):
            fail('NATIVE_BRANCH_PROOF_INVALID')
        traces.append(row['trace'])
        proofs.append(_events_for(events, row['trace'].get('runId')))
    return _compile(session, traces, proofs)


def validate_definition(session, definition):
    cfg = validate_config(session.config)
    if (cfg is None or not isinstance(definition, dict) or definition.get('schemaVersion') != 1 or
            definition.get('effect') != 'read' or
            set(definition) - {'schemaVersion', 'id', 'name', 'description', 'effect', 'inputSchema', 'branchPlan'} or
            len(json.dumps(definition).encode()) > 524288):
        fail('NATIVE_BRANCH_DEFINITION_INVALID')
    branch = definition.get('branchPlan')
    if (not isinstance(branch, dict) or set(branch) != {'schemaVersion', 'forkStageIndex', 'branchInput', 'arms'} or
            branch.get('schemaVersion') != 1 or type(branch.get('forkStageIndex')) is not int or
            not 0 <= branch['forkStageIndex'] < 16 or not isinstance(branch.get('branchInput'), str) or
            not isinstance(branch.get('arms'), list) or len(branch['arms']) != 2):
        fail('NATIVE_BRANCH_DEFINITION_INVALID')
    traces, events = [], []
    for cfg_arm, arm in zip(cfg['arms'], branch['arms']):
        if (not isinstance(arm, dict) or set(arm) != {'id', 'value', 'inputMap', 'definition'} or
                arm.get('id') != cfg_arm['id'] or type(arm.get('value')) is not type(cfg_arm['value']) or arm['value'] != cfg_arm['value']):
            fail('NATIVE_BRANCH_DEFINITION_INVALID')
        child = arm['definition']
        if (not isinstance(child, dict) or
                set(child) - {'schemaVersion', 'id', 'name', 'description', 'effect', 'inputSchema', 'steps', 'stagePlan'}):
            fail('NATIVE_BRANCH_CHILD_DEFINITION_INVALID')
        stages.validate_definition(arm_session(session, branch, arm), child)
        traces.append(child['stagePlan']['proof']['trace'])
        events.append(child['stagePlan']['proof']['events'])
    expected = next(iter(_compile(session, traces, events)['specs'].values()))
    if (definition['id'] != expected['id'] or definition['inputSchema'] != expected['inputSchema'] or
            any(branch[key] != expected['branchPlan'][key] for key in ['schemaVersion', 'forkStageIndex', 'branchInput'])):
        fail('NATIVE_BRANCH_DEFINITION_INVALID')
    for arm, original in zip(branch['arms'], expected['branchPlan']['arms']):
        if any(arm[key] != original[key] for key in ['id', 'value', 'inputMap']):
            fail('NATIVE_BRANCH_DEFINITION_INVALID')
    return branch


def select_arm(session, branch_plan, tree, global_inputs):
    # One fresh positive observation is matched against both contracts. No
    # missing-control condition and no caller-supplied branch label is accepted.
    cfg = validate_config(session.config)
    proxy = arm_session(session, branch_plan, branch_plan['arms'][0])
    current = stages.inspect_stage(proxy, tree)
    matches = [arm for arm in branch_plan['arms']
               if current == _structure(arm['definition']['stagePlan']['proof']['trace']['stages'][branch_plan['forkStageIndex'] + 1])]
    if len(matches) != 1:
        fail('NATIVE_BRANCH_ROUTE_NOT_UNIQUE')
    selected = matches[0]
    supplied = global_inputs.get(branch_plan['branchInput'])
    if type(supplied) is not type(selected['value']) or supplied != selected['value']:
        fail('NATIVE_BRANCH_ROUTE_INPUT_MISMATCH')
    if cfg is None:
        fail('NATIVE_BRANCH_NOT_APPROVED')
    return selected


def restore_entry(session, branch_plan):
    if session.progress.get('pending'):
        fail('NATIVE_BRANCH_RESUME_REQUIRES_FRESH_RUN')
    nodes = {}
    for arm in branch_plan['arms']:
        path = arm['definition']['stagePlan']['proof']['trace']['stages']
        previous = None
        for stage in path:
            key = digest(_structure(stage))
            if key in nodes and nodes[key]['previous'] != previous:
                fail('NATIVE_BRANCH_JOIN_OR_CYCLE_NOT_PROVEN')
            nodes[key] = {'stage': stage, 'previous': previous, 'arm': arm}
            previous = key
    expected = None
    for _ in range(min(16, session.budget.max_depth + 2)):
        session.budget.check()
        tree = session.backend.observe()
        proxy = arm_session(session, branch_plan, branch_plan['arms'][0])
        current = digest(stages.inspect_stage(proxy, tree))
        if current not in nodes or expected is not None and current != expected:
            fail('NATIVE_BRANCH_ROUTE_NOT_UNIQUE')
        node = nodes[current]
        previous = node['previous']
        if previous is None:
            return
        proxy = arm_session(session, branch_plan, node['arm'])
        _, after = stages.command(proxy, {'kind': 'back'}, tree, {})
        expected = previous
        stages.guard(arm_session(session, branch_plan, nodes[previous]['arm']), after, nodes[previous]['stage'])
        if nodes[previous]['previous'] is None:
            return
    fail('NATIVE_BRANCH_ENTRY_UNREACHABLE')
