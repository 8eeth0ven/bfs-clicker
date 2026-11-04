"""Observed branch evidence, strict compilation and unique recovery contracts."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from apk_inventory.mobile_branches import MODE, restore_entry, select_arm, validate_definition
from apk_inventory.mobile_planner import plan_tree
from apk_inventory.mobile_ui import MobileError, MobileSession
from native_branch_fixture import branch_app
from native_stage_fixture import stage_app


class NativeBranchesTests(unittest.TestCase):
    def discover(self, app, root):
        session = MobileSession(app['config'], root / 'explore')
        session.explore()
        checkpoint = json.loads((root / 'explore/checkpoint.json').read_text())
        events = [json.loads(row) for row in (root / 'explore/events.jsonl').read_text().splitlines()]
        planner = MobileSession(app['config'], root / 'plan')
        plan = plan_tree(planner, planner.backend.observe(), checkpoint, events)
        self.assertEqual(plan['total'], 1, plan['gaps'])
        return session, checkpoint, events, planner, plan

    def completed_definition(self, plan):
        definition = copy.deepcopy(next(iter(plan['specs'].values())))
        target = definition.pop('outcomeCandidates')[0]
        for arm in definition['branchPlan']['arms']:
            child = arm['definition']
            child.pop('outcomeCandidates')
            selector = target['armTargets'][arm['id']]['selector']
            for local in arm['inputMap'].values():
                child['steps'].append({'kind': 'assert', 'selector': selector,
                                       'expect': {'containsInput': local, 'changed': True}, 'timeoutMs': 100})
            child['steps'].append({'kind': 'extract', 'selector': selector, 'output': 'result'})
        return definition

    def test_both_platforms_observe_enum_and_boolean_branches_without_mutating_config(self):
        for platform in ['android', 'ios']:
            for kind in ['select', 'check']:
                with self.subTest(platform=platform, kind=kind), branch_app(platform, kind) as app, tempfile.TemporaryDirectory() as out:
                    root = Path(out)
                    config = copy.deepcopy(app['config'])
                    session, checkpoint, events, planner, plan = self.discover(app, root)
                    self.assertEqual(config, app['config'])
                    self.assertNotIn('nativeStagePlanning', session.config)
                    self.assertNotIn('nativeStageTrace', checkpoint)
                    self.assertEqual(len(app['business']), 2)
                    self.assertEqual([row['route'] for row in app['business']], ['left', 'right'] if kind == 'select' else [False, True])
                    candidate = plan['items'][0]
                    self.assertEqual(candidate['planningMode'], MODE)
                    self.assertEqual(set(candidate['inputSchema']['properties']), {'route', 'query', 'detail'})
                    self.assertEqual(candidate['inputSchema']['properties']['route']['type'], 'string' if kind == 'select' else 'boolean')
                    definition = self.completed_definition(plan)
                    branch = validate_definition(planner, definition)
                    self.assertEqual(branch['forkStageIndex'], 0)
                    self.assertEqual(branch['branchInput'], 'route')
                    self.assertEqual(branch['arms'][1]['inputMap']['detail'], 'alternate_detail')
                    public = json.dumps({key: value for key, value in plan.items() if key != 'specs'})
                    for private in ['seed-query', 'seed-left-detail', 'seed-right-detail', 'selector', app['url']]:
                        self.assertNotIn(private, public)
                    stored = json.dumps(checkpoint['nativeBranchTrace'])
                    for value in ['seed-query', 'seed-left-detail', 'seed-right-detail', '_inputSha256', '_inputValue']:
                        self.assertNotIn(value, stored)

    def test_incomplete_or_spliced_evidence_never_falls_back_to_single_screen(self):
        with branch_app() as app, tempfile.TemporaryDirectory() as out:
            _, checkpoint, events, planner, _ = self.discover(app, Path(out))
            tree = planner.backend.observe()
            calls = len(app['calls'])
            self.assertEqual(plan_tree(planner, tree)['total'], 0)
            for defect in ['missing_arm', 'incomplete', 'source', 'same_run', 'swapped_arms', 'missing_receipt',
                           'missing_arm_binding', 'wrong_arm_binding', 'duplicate_event', 'malformed_event', 'uncertain']:
                with self.subTest(defect=defect):
                    cp, rows = copy.deepcopy(checkpoint), copy.deepcopy(events)
                    arms = cp['nativeBranchTrace']['arms']
                    if defect == 'missing_arm':
                        arms.pop()
                    elif defect == 'incomplete':
                        cp['nativeBranchTrace']['completed'] = False
                    elif defect == 'source':
                        cp['identity'] = 'foreign'
                    elif defect == 'same_run':
                        arms[1]['trace']['runId'] = arms[0]['trace']['runId']
                    elif defect == 'swapped_arms':
                        arms[0]['trace'], arms[1]['trace'] = arms[1]['trace'], arms[0]['trace']
                    elif defect == 'missing_receipt':
                        rows.remove(next(row for row in rows if row['kind'] == 'native_preparation_verified'))
                    elif defect in {'missing_arm_binding', 'wrong_arm_binding'}:
                        row = next(row for row in rows if row['kind'] == 'native_stage_observed')
                        if defect == 'missing_arm_binding':
                            row.pop('nativeBranchArmId')
                        else:
                            row['nativeBranchArmId'] = 'right'
                    elif defect == 'duplicate_event':
                        rows.append(copy.deepcopy(rows[0]))
                    elif defect == 'malformed_event':
                        rows.append([])
                    else:
                        row = copy.deepcopy(next(row for row in rows if row['kind'] == 'native_stage_action_started'))
                        row.update(kind='native_stage_action_uncertain', evidenceId='extra_uncertain')
                        rows.append(row)
                    result = plan_tree(planner, tree, cp, rows)
                    self.assertEqual(result['total'], 0)
                    self.assertTrue(result['gaps'])
            self.assertEqual(len(app['calls']), calls)

    def test_branch_arm_marker_cannot_be_smuggled_into_legacy_linear_receipts(self):
        with stage_app() as app, tempfile.TemporaryDirectory() as out:
            root = Path(out)
            session = MobileSession(app['config'], root / 'explore')
            session.explore()
            checkpoint = json.loads((root / 'explore/checkpoint.json').read_text())
            events = [json.loads(row) for row in (root / 'explore/events.jsonl').read_text().splitlines()]
            planner = MobileSession(app['config'], root / 'plan')
            tree = planner.backend.observe()
            self.assertEqual(plan_tree(planner, tree, checkpoint, events)['total'], 1)
            next(row for row in events if row['kind'] == 'native_stage_observed')['nativeBranchArmId'] = 'left'
            before = len(app['calls'])
            result = plan_tree(planner, tree, checkpoint, events)
            self.assertEqual(result['total'], 0)
            self.assertIn('NATIVE_STAGE_EVENT_IDENTITY_MISMATCH', result['gaps'])
            self.assertEqual(len(app['calls']), before)

    def test_both_arm_seed_permissions_and_values_preflight_before_any_ui(self):
        for defect in ['other_permission', 'same_value', 'fork_seed', 'legacy_opt_in']:
            with self.subTest(defect=defect), branch_app() as app, tempfile.TemporaryDirectory() as out:
                cfg = copy.deepcopy(app['config'])
                if defect == 'other_permission':
                    cfg['actionAllowlist'] = [row for row in cfg['actionAllowlist'] if row['selector'] != app['identify']('alternate_detail')]
                elif defect == 'same_value':
                    cfg['nativeBranchPlanning']['arms'][1]['value'] = 'left'
                    cfg['nativeBranchPlanning']['arms'][1]['seedInputs'][1]['value'] = 'left'
                elif defect == 'fork_seed':
                    cfg['nativeBranchPlanning']['arms'][1]['seedInputs'][1]['value'] = 'left'
                else:
                    cfg['nativeStagePlanning'] = {'workflowId': 'other', 'seedInputs': []}
                with self.assertRaises(MobileError):
                    MobileSession(cfg, Path(out))
                self.assertEqual(app['calls'], [])
                self.assertEqual(app['business'], [])

    def test_unselected_seed_reflection_is_blocked_before_input_dispatch(self):
        with branch_app() as app, tempfile.TemporaryDirectory() as out:
            app['sourceTransform'] = lambda xml: xml.replace('"Next"', '"seed-right-detail"')
            session = MobileSession(app['config'], Path(out))
            with self.assertRaises(MobileError) as error:
                session.explore()
            self.assertEqual(error.exception.code, 'NATIVE_STAGE_SENSITIVE_METADATA')
            self.assertFalse(any(method == 'POST' and '/element/' in route for method, route, _ in app['calls']))
            self.assertEqual(app['business'], [])

    def test_third_domain_value_is_rejected_before_any_ui_even_if_action_is_allowlisted(self):
        with branch_app() as app, tempfile.TemporaryDirectory() as out:
            app['thirdOption'] = True
            app['config']['actionAllowlist'].append({'kind': 'check', 'selector': app['identify']('third'), 'effect': 'read'})
            session = MobileSession(app['config'], Path(out))
            with self.assertRaises(MobileError) as error:
                session.explore()
            self.assertEqual(error.exception.code, 'NATIVE_BRANCH_DOMAIN_NOT_PROVEN')
            self.assertFalse(any(method == 'POST' and '/element/' in route for method, route, _ in app['calls']))
            self.assertEqual(app['business'], [])

    def test_shared_terminal_is_not_promoted_to_a_branch_candidate(self):
        with branch_app() as app, tempfile.TemporaryDirectory() as out:
            app['commonTerminal'] = True
            root = Path(out)
            session = MobileSession(app['config'], root / 'explore')
            with self.assertRaises(MobileError) as error:
                session.explore()
            self.assertEqual(error.exception.code, 'NATIVE_BRANCH_JOIN_OR_CYCLE_NOT_PROVEN')
            self.assertEqual(len(app['business']), 2)
            checkpoint = json.loads((root / 'explore/checkpoint.json').read_text())
            events = [json.loads(row) for row in (root / 'explore/events.jsonl').read_text().splitlines()]
            self.assertFalse(checkpoint['nativeBranchTrace']['completed'])
            planner = MobileSession(app['config'], root / 'plan')
            tree = planner.backend.observe()
            before = len(app['calls'])
            self.assertEqual(plan_tree(planner, tree, checkpoint, events)['total'], 0)
            self.assertEqual(len(app['calls']), before)

    def test_only_exact_recompiled_graph_and_children_are_accepted(self):
        with branch_app() as app, tempfile.TemporaryDirectory() as out:
            _, _, _, planner, plan = self.discover(app, Path(out))
            definition = self.completed_definition(plan)
            validate_definition(planner, definition)
            before = len(app['calls'])
            for defect in ['mapping', 'fork', 'boolean_index', 'domain', 'child_prefix', 'child_branch', 'source', 'arm_events']:
                with self.subTest(defect=defect):
                    bad = copy.deepcopy(definition)
                    arm = bad['branchPlan']['arms'][1]
                    if defect == 'mapping':
                        arm['inputMap']['detail'] = 'query'
                    elif defect == 'fork':
                        bad['branchPlan']['forkStageIndex'] = 1
                    elif defect == 'boolean_index':
                        bad['branchPlan']['forkStageIndex'] = False
                    elif defect == 'domain':
                        arm['value'] = 'third'
                    elif defect == 'child_prefix':
                        arm['definition']['entryPrefix'] = {'steps': []}
                    elif defect == 'child_branch':
                        arm['definition']['branchPlan'] = {}
                    elif defect == 'source':
                        arm['definition']['stagePlan']['proof']['trace']['identity'] = 'foreign'
                    else:
                        arm['definition']['stagePlan']['proof']['events'][0]['nativeBranchArmId'] = 'left'
                    with self.assertRaises(MobileError):
                        validate_definition(planner, bad)
            self.assertEqual(len(app['calls']), before)

    def test_positive_branch_selection_checks_observed_screen_and_input_domain(self):
        with branch_app() as app, tempfile.TemporaryDirectory() as out:
            _, _, _, planner, plan = self.discover(app, Path(out))
            branch = validate_definition(planner, self.completed_definition(plan))
            app.update(page='left', detail='')
            tree = planner.backend.observe()
            before = len(app['calls'])
            self.assertEqual(select_arm(planner, branch, tree, {'route': 'left'})['id'], 'left')
            for value in ['right', 'third', True, None]:
                with self.subTest(value=value), self.assertRaises(MobileError):
                    select_arm(planner, branch, tree, {'route': value})
            self.assertEqual(len(app['calls']), before)
            app['ambiguousBranch'] = True
            with self.assertRaises(MobileError):
                select_arm(planner, branch, planner.backend.observe(), {'route': 'left'})

    def test_restore_uses_known_unique_predecessors_and_never_backs_from_unknown(self):
        with branch_app() as app, tempfile.TemporaryDirectory() as out:
            _, _, _, planner, plan = self.discover(app, Path(out))
            branch = validate_definition(planner, self.completed_definition(plan))
            before_business = len(app['business'])
            restore_entry(planner, branch)
            self.assertEqual(app['page'], 'first')
            self.assertEqual(len(app['business']), before_business)
            backs = sum(route.endswith('/back') for _, route, _ in app['calls'])
            app['page'] = 'unknown'
            with self.assertRaises(MobileError):
                restore_entry(planner, branch)
            self.assertEqual(sum(route.endswith('/back') for _, route, _ in app['calls']), backs)
            planner.progress['pending'] = {'executionId': 'unknown_fork'}
            before = len(app['calls'])
            with self.assertRaises(MobileError):
                restore_entry(planner, branch)
            self.assertEqual(len(app['calls']), before)


if __name__ == '__main__':
    unittest.main()
