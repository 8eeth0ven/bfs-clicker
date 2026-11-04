"""Opt-in, read-approved native stage discovery and strict local evidence replay.

Only metadata contracts and execution receipts are persisted. Input values and
value hashes remain transient; source identity keeps the existing config contract.
"""
import copy
import hashlib
import json
import re
import uuid

from .mobile_ui import (MobileError, check_target, check_value, digest, locate,
                        node_selector, selection_selector, selection_state, select_value)

MODE = 'native-stages-v1'
MAX_BYTES = 2 * 1024 * 1024


def fail(code):
    raise MobileError(code, 'blocked')


def validate_config(config):
    value = config.get('nativeStagePlanning')
    if value is None:
        return None
    if (not isinstance(value, dict) or set(value) != {'workflowId', 'seedInputs'} or
            not isinstance(value['workflowId'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', value['workflowId']) or
            value['workflowId'] in {'__proto__', 'constructor', 'prototype'} or
            not isinstance(value['seedInputs'], list) or not 1 <= len(value['seedInputs']) <= 16):
        fail('NATIVE_STAGE_CONFIG_INVALID')
    seen = set()
    for row in value['seedInputs']:
        if not isinstance(row, dict) or set(row) != {'kind', 'selector', 'value'} or row['kind'] not in {'type', 'check', 'select'}:
            fail('NATIVE_STAGE_CONFIG_INVALID')
        selection_selector(row['selector'])
        key = digest([row['kind'], row['selector']])
        if key in seen:
            fail('NATIVE_STAGE_CONFIG_INVALID')
        seen.add(key)
        if row['kind'] == 'check':
            if not isinstance(row['value'], bool):
                fail('NATIVE_STAGE_CONFIG_INVALID')
        elif not isinstance(row['value'], str) or len(row['value']) > (128 if row['kind'] == 'select' else 2048) or '\0' in row['value']:
            fail('NATIVE_STAGE_CONFIG_INVALID')
    return value


def approved(session, action):
    return any(row.get('kind', 'click') == action['kind'] and row.get('selector') == action['selector'] and row.get('effect') == 'read' for row in session.config.get('actionAllowlist', []))


def emit(session, kind, **fields):
    trace = session.progress.get('nativeStageTrace')
    if trace is None:
        if not hasattr(session, '_native_stage_replay_run'):
            session._native_stage_replay_run = 'replay_' + uuid.uuid4().hex
        run_id = session._native_stage_replay_run
    else:
        run_id = trace['runId']
    arm_id = getattr(session, '_native_branch_arm_id', None)
    if arm_id is not None:
        fields['nativeBranchArmId'] = arm_id
    return session.event(kind, stageRunId=run_id, sourceIdentity=session.identity, workflowId=session.config['nativeStagePlanning']['workflowId'], **fields)


def input_key(row):
    return digest([row['kind'], row['selector']])


def discovery_action(field):
    return {'kind': field['kind'], 'selector': field['selector'], 'input': 'seed',
            **({'replace': True} if field['kind'] == 'type' else {}),
            **({'options': field['options']} if field['kind'] == 'select' else {})}


def sensitive_metadata(session, tree):
    # Text seed values are exclusion data only, held in this call's memory.
    # Complete enum domains remain contracts; the actually selected value is never recorded.
    seeds = []
    seed_inputs = session.config['nativeStagePlanning']['seedInputs']
    if getattr(session, '_native_branch_arm_id', None) is not None:
        seed_inputs = [row for arm in session.config['nativeBranchPlanning']['arms'] for row in arm['seedInputs']]
    for row in seed_inputs:
        if row['kind'] == 'type' and row['value']:
            for value in [row['value'], re.sub(r'^(?:Bearer|Basic)\s+', '', row['value'], flags=re.I)]:
                seeds.extend([value, ' '.join(value.split())])
    seeds = [value for value in set(seeds) if value]
    def contains(value):
        return isinstance(value, str) and any(seed in value or seed in ' '.join(value.split()) for seed in seeds)
    for node in tree['nodes']:
        metadata = [node.get(key) for key in ['resourceId', 'accessibilityId', 'className']]
        metadata += [value for parent in node.get('containerPath', []) for value in parent.values()]
        if node.get('clickable') and not node.get('editable'):
            metadata.append(node.get('text'))
        if any(contains(value) for value in metadata):
            fail('NATIVE_STAGE_SENSITIVE_METADATA')


def inspect_stage(session, tree):
    sensitive_metadata(session, tree)
    from .mobile_planner import _classify, _group_controls
    from .mobile_workflows import control_contract
    gaps = set()
    inputs, buttons, _ = _classify(session, tree, gaps)
    groups = _group_controls(inputs, buttons, [], gaps)
    groups = [row for row in groups if approved(session, {'kind': 'click', 'selector': row[2]['selector']})]
    if inputs:
        if gaps:
            fail("NATIVE_STAGE_CONTROLS_NOT_PROVEN")
        if len(groups) != 1:
            fail('NATIVE_STAGE_GROUP_OR_BRANCH_NOT_PROVEN')
        group, fields, button, _ = groups[0]
        if len(fields) != len(inputs):
            fail('NATIVE_STAGE_GROUP_OR_BRANCH_NOT_PROVEN')
        metadata = []
        for row in fields:
            action = {'kind': row['inputKind'], 'selector': row['selector']}
            if not approved(session, action):
                fail('NATIVE_STAGE_ACTION_NOT_APPROVED')
            if row['inputKind'] == 'select':
                if any(not approved(session, {'kind': 'check', 'selector': o['selector']}) for o in row['options']):
                    fail('NATIVE_STAGE_ACTION_NOT_APPROVED')
                contract = selection_state(tree, {'selector': row['selector'], 'options': row['options']})['contract']
            else:
                check_target(row['inputKind'], row['node'])
                contract = control_contract(row['node'], row['inputKind'])
            metadata.append({'kind': row['inputKind'], 'selector': row['selector'], 'contract': contract,
                             **({'options': row['options']} if row['inputKind'] == 'select' else {})})
        return {'group': group, 'fields': metadata,
                'button': {'kind': 'click', 'selector': button['selector'], 'contract': control_contract(button['node'], 'click')}, 'outputs': []}
    # Incomplete/unauthorized controls cannot become an apparent terminal screen.
    if any(n.get('editable') or n.get('checkKind') or n.get('checkable') or n.get('selectionGroupKind') for n in tree['nodes'] if n.get('visible') and n.get('enabled')):
        fail('NATIVE_STAGE_CONTROLS_NOT_PROVEN')
    outputs = []
    for node in tree['nodes']:
        if (node.get('visible') and node.get('enabled') and node.get('text') and
                not any(node.get(k) for k in ['editable', 'secure', 'clickable', 'checkable', 'checkKind', 'selectionGroupKind', 'selectionOptionKind']) and
                (node.get('resourceId') or node.get('accessibilityId'))):
            wanted = node_selector(node)
            locate(tree, wanted)
            outputs.append({'kind': 'text', 'selector': wanted, 'contract': control_contract(node, 'extract')})
    if not outputs or len(outputs) > 12:
        fail('NATIVE_STAGE_RESULT_NOT_PROVEN')
    return {'group': None, 'fields': [], 'button': None, 'outputs': outputs}


def static_part(stage):
    return {k: v for k, v in stage.items() if k not in {'digest', 'observationEvidenceId', 'preparations', 'transition', 'reverificationEvidenceId'}}


def capture(session, tree, index):
    stage = {'index': index, 'occurrenceId': 'stage_' + uuid.uuid4().hex, **inspect_stage(session, tree)}
    branch_check = getattr(session, '_native_branch_check_stage', None)
    if branch_check is not None:
        branch_check(stage)
    stage['digest'] = digest(static_part(stage))
    stage['observationEvidenceId'] = emit(session, 'native_stage_observed', occurrenceId=stage['occurrenceId'], stageDigest=stage['digest'])
    stage['preparations'] = []
    return stage


def verify_input(tree, action, inputs):
    if action['kind'] == 'type':
        node = locate(tree, action['selector'])
        value = inputs.get(action['input'])
        if (not isinstance(value, str) or node.get('_inputValuePresent') is not True or
                node.get('_inputPlaceholderOnly') or node.get('_inputSha256') != hashlib.sha256(value.encode('utf8')).hexdigest()):
            fail('NATIVE_STAGE_INPUT_STATE_CHANGED')
    elif action['kind'] == 'check':
        node = locate(tree, action['selector'])
        if node['checked'] != check_value(action, node, inputs):
            fail('NATIVE_STAGE_INPUT_STATE_CHANGED')
    elif action['kind'] == 'select':
        if selection_state(tree, action)['selected'] != select_value(action, inputs):
            fail('NATIVE_STAGE_INPUT_STATE_CHANGED')
    else:
        fail('NATIVE_STAGE_PREPARATION_NOT_PROVEN')


def command(session, action, tree, inputs, *, unchanged=False):
    from .mobile_workflows import control_contract
    if unchanged:
        result = session.backend.perform(action, tree, inputs)
        session.budget.check()
        if result.get('commandPerformed') is not False or result.get('stateObserved') is not True:
            fail('NATIVE_STAGE_NOOP_NOT_PROVEN')
        return {'executionId': None, 'startedEvidenceId': None, 'finishedEvidenceId': None, 'commandPerformed': False}, session.backend.observe()
    session.budget.action()
    execution = 'execution_' + uuid.uuid4().hex
    started = emit(session, 'native_stage_action_started', executionId=execution, actionId=digest(action), actionKind=action['kind'])
    session.progress['pending'] = {'executionId': execution, 'startedEvidenceId': started, 'actionId': digest(action)}
    session.checkpoint()
    try:
        session.backend.perform(action, tree, inputs)
        session.budget.check()
        after = session.backend.observe()
        session.budget.check()
        if action['kind'] == 'type':
            before_node, after_node = locate(tree, action['selector']), locate(after, action['selector'])
            if (control_contract(before_node, 'type') != control_contract(after_node, 'type') or
                    after_node.get('_inputValuePresent') is not True or after_node.get('_inputPlaceholderOnly') or
                    after_node.get('_inputSha256') != hashlib.sha256(inputs[action['input']].encode('utf8')).hexdigest()):
                fail('NATIVE_STAGE_INPUT_NOT_VERIFIED')
        session.backend.foreground()
        session.budget.check()
    except MobileError as error:
        emit(session, 'native_stage_action_uncertain', executionId=execution, code=error.code)
        raise
    finished = emit(session, 'native_stage_action_finished', executionId=execution, startedEvidenceId=started, status='observed')
    session.progress['pending'] = None
    session.checkpoint()
    return {'executionId': execution, 'startedEvidenceId': started, 'finishedEvidenceId': finished, 'commandPerformed': True}, after


def explore(session):
    cfg = validate_config(session.config)
    if session.progress.get('pending') or session.progress.get('nativeStageTrace'):
        fail('NATIVE_STAGE_RESUME_REQUIRES_FRESH_RUN')
    tree = session.backend.observe()
    trace = {'schemaVersion': 1, 'runId': 'run_' + uuid.uuid4().hex, 'planningMode': MODE, 'identity': session.identity, 'workflowId': cfg['workflowId'], 'stages': [], 'completed': False}
    session.progress['entry'] = tree['fingerprint']  # Existing entry contract; first-screen inputs are excluded by parse_tree.
    session.progress['nativeStageTrace'] = trace
    session.progress['status'] = 'running'
    previous = None
    for index in range(min(session.budget.max_depth + 1, 16)):
        session.budget.check()
        stage = capture(session, tree, index)
        structural = {k: stage[k] for k in ['group', 'fields', 'button', 'outputs']}
        if any({k: old[k] for k in structural} == structural for old in trace['stages']):
            fail('NATIVE_STAGE_CYCLE_NOT_PROVEN')
        trace['stages'].append(stage)
        if previous is not None:
            prior, receipt = previous
            event = emit(session, 'native_stage_transition_observed', executionId=receipt['executionId'],
                                  fromOccurrenceId=prior['occurrenceId'], toOccurrenceId=stage['occurrenceId'],
                                  preparationReceiptIds=[r['evidenceId'] for r in prior['preparations']])
            prior['transition'] = {**receipt, 'evidenceId': event, 'toOccurrenceId': stage['occurrenceId']}
        if len(json.dumps(trace).encode()) > MAX_BYTES:
            fail('NATIVE_STAGE_EVIDENCE_LIMIT')
        session.checkpoint()
        if not stage['fields']:
            if index < 2:
                fail('NATIVE_STAGE_REQUIRES_TWO_INPUT_SCREENS')
            session.backend.verify_artifact()
            session.backend.foreground()
            session.budget.check()
            trace['completed'] = True
            session.progress['status'] = 'completed'
            session.checkpoint()
            return {'ok': True, 'status': 'completed', 'states': len(trace['stages']), 'actions': session.budget.count, 'capabilities': 0, 'gaps': ['two_distinct_samples_required']}
        seeds = {}
        # Validate every local field/enum/seed before any local mutation.
        for field in stage['fields']:
            seed = next((r for r in cfg['seedInputs'] if r['kind'] == field['kind'] and r['selector'] == field['selector']), None)
            if seed is None:
                fail('NATIVE_STAGE_SEED_MISSING')
            action = discovery_action(field)
            if field['kind'] == 'check':
                check_value(action, locate(tree, field['selector']), {'seed': seed['value']})
            elif field['kind'] == 'select':
                selection_state(tree, action)
                select_value(action, {'seed': seed['value']})
            seeds[input_key(field)] = seed['value']
        for field in stage['fields']:
            fresh = session.backend.observe()
            session.budget.check()
            if inspect_stage(session, fresh) != {k: stage[k] for k in ['group', 'fields', 'button', 'outputs']}:
                fail('NATIVE_STAGE_ROUTE_CHANGED')
            action = discovery_action(field)
            value = seeds[input_key(field)]
            unchanged = (field['kind'] == 'check' and locate(fresh, field['selector'])['checked'] == value or
                         field['kind'] == 'select' and selection_state(fresh, action)['selected'] == value)
            receipt, tree = command(session, action, fresh, {'seed': value}, unchanged=unchanged)
            receipt = {**receipt, 'inputSlotId': input_key(field), 'actionKind': field['kind'], 'stageOccurrenceId': stage['occurrenceId'], 'inputVerified': True}
            receipt['evidenceId'] = emit(session, 'native_preparation_verified', **receipt)
            stage['preparations'].append(receipt)
        fresh = session.backend.observe()
        session.budget.check()
        if inspect_stage(session, fresh) != {k: stage[k] for k in ['group', 'fields', 'button', 'outputs']}:
            fail('NATIVE_STAGE_ROUTE_CHANGED')
        for field in stage['fields']:
            verify_input(fresh, discovery_action(field), {'seed': seeds[input_key(field)]})
        stage['reverificationEvidenceId'] = emit(session, 'native_stage_inputs_reverified',
                                                   stageOccurrenceId=stage['occurrenceId'], inputVerified=True,
                                                   preparationReceiptIds=[r['evidenceId'] for r in stage['preparations']])
        button = {k: stage['button'][k] for k in ['kind', 'selector']}
        receipt, tree = command(session, button, fresh, {})
        previous = stage, receipt
    fail('NATIVE_STAGE_DEPTH_LIMIT')


def verify_trace(session, trace, events):
    cfg = validate_config(session.config)
    if (not cfg or not isinstance(trace, dict) or trace.get('schemaVersion') != 1 or trace.get('planningMode') != MODE or
            trace.get('identity') != session.identity or trace.get('workflowId') != cfg['workflowId'] or trace.get('completed') is not True or
            not isinstance(trace.get('runId'), str) or not re.fullmatch(r'run_[a-f0-9]{32}', trace['runId']) or
            not isinstance(trace.get('stages'), list) or not 3 <= len(trace['stages']) <= 16):
        fail('NATIVE_STAGE_PROOF_INVALID')
    rows, positions = {}, {}
    uncertain = set()
    starts_seen, finishes_seen = set(), set()
    for position, event in enumerate(events):
        ident = event.get('evidenceId')
        if not isinstance(ident, str) or ident in rows:
            fail('NATIVE_STAGE_EVENT_IDS_INVALID')
        rows[ident], positions[ident] = event, position
        if event.get('kind', '').startswith('native_'):
            if event.get('stageRunId') != trace['runId'] or event.get('sourceIdentity') != session.identity or event.get('workflowId') != cfg['workflowId']:
                fail('NATIVE_STAGE_EVENT_IDENTITY_MISMATCH')
            branch_arm = getattr(session, '_native_branch_arm_id', None)
            if branch_arm is None and 'nativeBranchArmId' in event:
                fail('NATIVE_STAGE_EVENT_IDENTITY_MISMATCH')
            if branch_arm is not None and event.get('nativeBranchArmId') != branch_arm:
                fail('NATIVE_BRANCH_EVENT_ARM_MISMATCH')
            executions = starts_seen if event['kind'] == 'native_stage_action_started' else finishes_seen if event['kind'] == 'native_stage_action_finished' else None
            if executions is not None:
                if not isinstance(event.get('executionId'), str) or event['executionId'] in executions:
                    fail('NATIVE_STAGE_EXECUTION_IDS_INVALID')
                executions.add(event['executionId'])
        if event.get('kind') == 'native_stage_action_uncertain':
            uncertain.add(event.get('executionId'))
    def pair(receipt, action):
        execution = receipt.get('executionId')
        start, finish = rows.get(receipt.get('startedEvidenceId'), {}), rows.get(receipt.get('finishedEvidenceId'), {})
        if (not execution or execution in uncertain or start.get('kind') != 'native_stage_action_started' or finish.get('kind') != 'native_stage_action_finished' or
                start.get('executionId') != execution or finish.get('executionId') != execution or start.get('actionId') != digest(action) or start.get('actionKind') != action['kind'] or
                finish.get('startedEvidenceId') != receipt['startedEvidenceId'] or finish.get('status') != 'observed' or
                positions[receipt['startedEvidenceId']] >= positions[receipt['finishedEvidenceId']]):
            fail('NATIVE_STAGE_EXECUTION_NOT_PROVEN')
        return positions[receipt['startedEvidenceId']], positions[receipt['finishedEvidenceId']]
    used_receipts, used_executions, occurrences = set(), set(), set()
    for number, stage in enumerate(trace['stages']):
        if stage.get('index') != number or stage.get('occurrenceId') in occurrences or stage.get('digest') != digest(static_part(stage)):
            fail('NATIVE_STAGE_SNAPSHOT_NOT_PROVEN')
        occurrences.add(stage['occurrenceId'])
        observation = rows.get(stage.get('observationEvidenceId'), {})
        if (observation.get('kind') != 'native_stage_observed' or observation.get('occurrenceId') != stage['occurrenceId'] or
                observation.get('stageDigest') != stage['digest'] or observation.get('workflowId') != cfg['workflowId']):
            fail('NATIVE_STAGE_SNAPSHOT_NOT_PROVEN')
        if number == len(trace['stages']) - 1:
            if stage['fields'] or stage['button'] is not None or not stage['outputs'] or stage.get('transition') or stage['preparations']:
                fail('NATIVE_STAGE_RESULT_NOT_PROVEN')
            continue
        if not stage['fields'] or not stage['button'] or len(stage['fields']) != len(stage['preparations']):
            fail('NATIVE_STAGE_PREPARATION_NOT_PROVEN')
        last = positions[stage['observationEvidenceId']]
        for field, receipt in zip(stage['fields'], stage['preparations']):
            ident = receipt.get('evidenceId')
            if (ident in used_receipts or rows.get(ident, {}).get('kind') != 'native_preparation_verified' or {k: v for k, v in rows.get(ident, {}).items() if k not in {'schemaVersion', 'kind', 'timestampMs', 'evidenceId', 'stageRunId', 'sourceIdentity', 'workflowId', 'nativeBranchArmId'}} != {k: v for k, v in receipt.items() if k != 'evidenceId'} or
                    receipt.get('inputVerified') is not True or receipt.get('stageOccurrenceId') != stage['occurrenceId'] or receipt.get('inputSlotId') != input_key(field) or receipt.get('actionKind') != field['kind']):
                fail('NATIVE_STAGE_PREPARATION_NOT_PROVEN')
            used_receipts.add(ident)
            action = discovery_action(field)
            if not approved(session, action):
                fail('NATIVE_STAGE_ACTION_NOT_APPROVED')
            if receipt['commandPerformed']:
                begin, end = pair(receipt, action)
                if receipt['executionId'] in used_executions or not last < begin < end < positions[ident]:
                    fail('NATIVE_STAGE_PREPARATION_NOT_PROVEN')
                used_executions.add(receipt['executionId'])
            elif field['kind'] not in {'check', 'select'} or any(receipt.get(k) is not None for k in ['executionId', 'startedEvidenceId', 'finishedEvidenceId']):
                fail('NATIVE_STAGE_PREPARATION_NOT_PROVEN')
            if positions[ident] <= last:
                fail('NATIVE_STAGE_PREPARATION_NOT_PROVEN')
            last = positions[ident]
        reverified = rows.get(stage.get('reverificationEvidenceId'), {})
        if (reverified.get('kind') != 'native_stage_inputs_reverified' or reverified.get('stageOccurrenceId') != stage['occurrenceId'] or
                reverified.get('inputVerified') is not True or reverified.get('preparationReceiptIds') != [r['evidenceId'] for r in stage['preparations']] or
                positions[stage['reverificationEvidenceId']] <= last):
            fail('NATIVE_STAGE_INPUT_STATE_NOT_PROVEN')
        last = positions[stage['reverificationEvidenceId']]
        transition = stage.get('transition', {})
        action = {k: stage['button'][k] for k in ['kind', 'selector']}
        if not approved(session, action):
            fail('NATIVE_STAGE_ACTION_NOT_APPROVED')
        begin, end = pair(transition, action)
        after = trace['stages'][number + 1]
        edge = rows.get(transition.get('evidenceId'), {})
        if (transition.get('executionId') in used_executions or transition.get('toOccurrenceId') != after['occurrenceId'] or edge.get('kind') != 'native_stage_transition_observed' or
                edge.get('executionId') != transition.get('executionId') or edge.get('fromOccurrenceId') != stage['occurrenceId'] or edge.get('toOccurrenceId') != after['occurrenceId'] or
                edge.get('preparationReceiptIds') != [r['evidenceId'] for r in stage['preparations']] or
                not last < begin < end < positions[after['observationEvidenceId']] < positions[transition['evidenceId']]):
            fail('NATIVE_STAGE_TRANSITION_NOT_PROVEN')
        used_executions.add(transition['executionId'])
    if uncertain or starts_seen != used_executions or finishes_seen != used_executions:
        fail('NATIVE_STAGE_UNREFERENCED_EXECUTION')
    structural = [{k: stage[k] for k in ['group', 'fields', 'button', 'outputs']} for stage in trace['stages']]
    if len({digest(row) for row in structural}) != len(structural):
        fail('NATIVE_STAGE_CYCLE_NOT_PROVEN')
    # Terminal locators cannot be reused input, check, group or option identities.
    input_selectors = {digest(f['selector']) for s in trace['stages'] for f in s['fields']}
    input_selectors.update(digest(o['selector']) for s in trace['stages'] for f in s['fields'] for o in f.get('options', []))
    for output in trace['stages'][-1]['outputs']:
        if digest(output['selector']) in input_selectors or output['contract'].get('editable') or output['contract'].get('secure'):
            fail('NATIVE_STAGE_RESULT_NOT_PROVEN')
    return trace


def plan(session, checkpoint, events):
    from .mobile_planner import _parameter_name
    if checkpoint.get('schemaVersion') != 1 or checkpoint.get('identity') != session.identity:
        fail('NATIVE_STAGE_CHECKPOINT_IDENTITY_MISMATCH')
    trace = verify_trace(session, checkpoint.get('nativeStageTrace'), events)
    stages, steps, ranges, contracts, properties, native_inputs, used = trace['stages'], [], [], [], {}, [], set()
    for stage in stages[:-1]:
        start = len(steps)
        for field in stage['fields']:
            node = field['contract']['group'] if field['kind'] == 'select' else field['contract']
            name = _parameter_name(node, used)
            properties[name] = {'type': 'boolean'} if field['kind'] == 'check' else {'type': 'string', 'enum': [o['value'] for o in field['options']]} if field['kind'] == 'select' else {'type': 'string', 'maxLength': 2048}
            action = discovery_action(field)
            action['input'] = name
            steps.append(action)
            contracts.append(field['contract'])
            native_inputs.append({'param': name, 'inputType': field['kind'], 'businessRequiredObserved': False})
        steps.append({k: stage['button'][k] for k in ['kind', 'selector']})
        contracts.append(stage['button']['contract'])
        ranges.append({'start': start, 'end': len(steps) - 1, 'stageIndex': stage['index']})
    if len(properties) > 16 or len(steps) + len(properties) + 1 > 30:
        fail('NATIVE_STAGE_STEP_LIMIT')
    structural = [{k: stage[k] for k in ['group', 'fields', 'button', 'outputs']} for stage in stages]
    ident = 'mobile_plan_' + digest([session.source, session.identity, structural])
    schema = {'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': False}
    targets = [{'id': 'output_' + digest([ident, row['selector']]), 'kind': 'text', 'selector': row['selector']} for row in stages[-1]['outputs']]
    evidence_events = [copy.deepcopy(row) for row in events if row.get('kind', '').startswith('native_')]
    definition = {'schemaVersion': 1, 'id': 'native_stage_' + digest([ident])[:40], 'name': '原生跨屏查询流程', 'effect': 'read', 'inputSchema': schema, 'steps': steps, 'outcomeCandidates': targets,
                  'stagePlan': {'schemaVersion': 1, 'ranges': ranges, 'controlContracts': contracts, 'proof': {'trace': copy.deepcopy(trace), 'events': evidence_events}}}
    if len(json.dumps(definition).encode()) > 524288:
        fail('NATIVE_STAGE_EVIDENCE_LIMIT')
    item = {'id': ident, 'name': '原生跨屏查询候选', 'planningMode': MODE, 'kind': 'mobile_workflow', 'readiness': 'candidate', 'effect': 'unknown', 'inputSchema': schema, 'nativeInputs': native_inputs,
            'outputTargets': [{'id': row['id'], 'kind': 'text', 'label': '结果区域'} for row in targets], 'evidence': {'parameterizationValidated': False, 'stagesObserved': len(stages), 'inputPreparationProven': True},
            'gaps': ['two_distinct_samples_required', 'parameter_related_assertion_required', 'native_business_required_not_observed']}
    return {'schemaVersion': 1, 'source': {**session.source, 'revision': digest([session.identity, structural])}, 'items': [item], 'specs': {ident: definition}, 'total': 1, 'nextOffset': None, 'truncated': False, 'gaps': []}


def validate_definition(session, definition):
    stage_plan = definition.get('stagePlan')
    if not isinstance(stage_plan, dict) or set(stage_plan) != {'schemaVersion', 'ranges', 'controlContracts', 'proof'} or stage_plan.get('schemaVersion') != 1 or definition.get('effect') != 'read':
        fail('NATIVE_STAGE_DEFINITION_INVALID')
    proof = stage_plan['proof']
    trace = verify_trace(session, proof['trace'], proof['events'])
    compiled = plan(session, {'schemaVersion': 1, 'identity': session.identity, 'nativeStageTrace': trace}, proof['events'])
    expected = next(iter(compiled['specs'].values()))
    count = len(expected['steps'])
    if (definition['steps'][:count] != expected['steps'] or stage_plan != expected['stagePlan'] or
            definition['inputSchema'] != expected['inputSchema'] or definition['id'] != expected['id']):
        fail('NATIVE_STAGE_DEFINITION_INVALID')
    allowed = {digest(row['selector']) for row in trace['stages'][-1]['outputs']}
    if any(s['kind'] not in {'assert', 'extract'} or digest(s['selector']) not in allowed for s in definition['steps'][count:]):
        fail('NATIVE_STAGE_RESULT_NOT_PROVEN')
    return stage_plan


def guard(session, tree, stage):
    current = inspect_stage(session, tree)
    if current != {k: stage[k] for k in ['group', 'fields', 'button', 'outputs']}:
        fail('WORKFLOW_STAGE_ROUTE_CHANGED')


def restore_entry(session, stage_plan):
    if session.progress.get('pending'):
        fail('NATIVE_STAGE_RESUME_REQUIRES_FRESH_RUN')
    session.budget.check()
    stages = stage_plan['proof']['trace']['stages']
    expected_index = None
    for _ in range(session.budget.max_depth + 2):
        tree = session.backend.observe()
        session.budget.check()
        current = inspect_stage(session, tree)
        matches = [number for number, stage in enumerate(stages)
                   if current == {k: stage[k] for k in ['group', 'fields', 'button', 'outputs']}]
        if len(matches) != 1 or expected_index is not None and matches[0] != expected_index:
            fail('WORKFLOW_STAGE_ROUTE_CHANGED')
        number = matches[0]
        if number == 0:
            return
        # Back is permitted only from a uniquely proved later stage, never as
        # recovery from an unknown/ambiguous screen. Verify the exact preceding
        # stage on the same fresh post-command source before doing anything else.
        _, after = command(session, {'kind': 'back'}, tree, {})
        expected_index = number - 1
        guard(session, after, stages[expected_index])
        session.budget.check()
        if expected_index == 0:
            return
    fail('NATIVE_STAGE_ENTRY_UNREACHABLE')
