"""Actual protocol exploration and staged replay; no manually constructed stage proof."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace

from apk_inventory.mobile_ui import Budget, MobileError, MobileSession, parse_tree
from apk_inventory.mobile_planner import plan_tree
from apk_inventory.mobile_workflows import learn_workflow
from native_stage_fixture import stage_app


class NativeStagesTests(unittest.TestCase):
    def discover(self, app, root):
        explorer = MobileSession(app['config'], root / 'explore')
        explorer.explore()
        checkpoint = json.loads((root / 'explore/checkpoint.json').read_text())
        events = [json.loads(row) for row in (root / 'explore/events.jsonl').read_text().splitlines()]
        planner = MobileSession(app['config'], root / 'plan')
        plan = plan_tree(planner, planner.backend.observe(), checkpoint, events)
        candidate = next(row for row in plan['items'] if row.get('planningMode') == 'native-stages-v1')
        return explorer, checkpoint, events, planner, plan, candidate

    def test_real_android_ios_discovery_then_two_samples_and_third_replay(self):
        for platform in ['android', 'ios']:
            with self.subTest(platform=platform), stage_app(platform) as app, tempfile.TemporaryDirectory() as out:
                root = Path(out)
                explorer, checkpoint, events, planner, plan, item = self.discover(app, root)
                self.assertEqual(app['business'], [{'first': 'seed-first', 'second': 'seed-second', 'enabled': True, 'mode': 'open'}])
                self.assertEqual(set(item['inputSchema']['properties']), {'first', 'second', 'enabled', 'mode'})
                self.assertEqual(item['readiness'], 'candidate')
                self.assertEqual(item['inputSchema']['properties']['mode']['enum'], ['open', 'closed'])
                public = json.dumps({key: value for key, value in plan.items() if key != 'specs'})
                for secret in ['seed-first', 'seed-second', 'selector', app['url'], 'stages']:
                    if secret != 'stages':
                        self.assertNotIn(secret, public)
                trace = json.dumps(checkpoint['nativeStageTrace'])
                for secret in ['seed-first', 'seed-second', '_inputSha256', '_inputValue', 'afterStateId']:
                    self.assertNotIn(secret, trace)
                definition = copy.deepcopy(plan['specs'][item['id']])
                target = definition.pop('outcomeCandidates')[0]
                for param in ['first', 'second', 'enabled', 'mode']:
                    definition['steps'].append({'kind': 'assert', 'selector': target['selector'], 'expect': {'containsInput': param, 'changed': True}, 'timeoutMs': 300})
                definition['steps'].append({'kind': 'extract', 'selector': target['selector'], 'output': 'result'})
                learner = MobileSession(app['config'], root / 'learn')
                learn_workflow(learner, definition, [{'first': 'alpha', 'second': 'one', 'enabled': True, 'mode': 'open'}, {'first': 'beta', 'second': 'two', 'enabled': False, 'mode': 'closed'}])
                recipe = next(iter(learner.progress['recipes'].values()))
                result = MobileSession(app['config'], root / 'execute').execute(recipe, recipe['revision'], {'first': 'gamma', 'second': 'three', 'enabled': True, 'mode': 'closed'})
                self.assertEqual(result['outputs']['result'], 'RESULT gamma / three / true / closed')
                self.assertEqual(len(app['business']), 4)
                self.assertTrue(result['resultFreshness']['outputs']['result']['inputCorrelated'])
                self.assertTrue(result['resultFreshness']['outputs']['result']['changedSinceStart'])

    def test_corrupt_missing_duplicate_late_or_uncertain_preparation_has_no_candidate(self):
        with stage_app() as app, tempfile.TemporaryDirectory() as out:
            root = Path(out)
            _, checkpoint, events, planner, _, _ = self.discover(app, root)
            before = len(app['calls'])
            for defect in ['missing', 'duplicate', 'late', 'uncertain', 'snapshot', 'execution_duplicate', 'foreign_run', 'malformed', 'checkpoint_identity', 'unreferenced_execution', 'reverification_missing', 'reverification_late']:
                with self.subTest(defect=defect):
                    cp, rows = copy.deepcopy(checkpoint), copy.deepcopy(events)
                    receipt = next(row for row in rows if row['kind'] == 'native_preparation_verified')
                    if defect == 'missing':
                        rows.remove(receipt)
                    elif defect == 'duplicate':
                        rows.append(copy.deepcopy(receipt))
                    elif defect == 'late':
                        rows.remove(receipt)
                        rows.append(receipt)
                    elif defect == 'uncertain':
                        rows.append({'kind': 'native_stage_action_uncertain', 'executionId': receipt['executionId'], 'evidenceId': 'extra-uncertain'})
                    elif defect == 'execution_duplicate':
                        row = copy.deepcopy(next(r for r in rows if r['kind'] == 'native_stage_action_started'))
                        row['evidenceId'] = 'duplicate-start-new-evidence'
                        rows.append(row)
                    elif defect == 'foreign_run':
                        receipt['stageRunId'] = 'run_' + 'f' * 32
                    elif defect in {'reverification_missing', 'reverification_late'}:
                        row = next(r for r in rows if r['kind'] == 'native_stage_inputs_reverified')
                        rows.remove(row)
                        if defect == 'reverification_late':
                            rows.append(row)
                    elif defect == 'checkpoint_identity':
                        cp['identity'] = 'foreign'
                    elif defect == 'unreferenced_execution':
                        start = copy.deepcopy(next(r for r in rows if r['kind'] == 'native_stage_action_started'))
                        end = copy.deepcopy(next(r for r in rows if r['kind'] == 'native_stage_action_finished'))
                        start.update(evidenceId='unreferenced-start', executionId='unreferenced-execution')
                        end.update(evidenceId='unreferenced-end', executionId='unreferenced-execution', startedEvidenceId='unreferenced-start')
                        rows.extend([start, end])
                    elif defect == 'malformed':
                        cp['nativeStageTrace']['stages'][0].pop('fields')
                    else:
                        cp['nativeStageTrace']['stages'][0]['fields'][0]['selector'] = {'accessibilityId': 'forged'}
                    plan = plan_tree(planner, planner.backend.observe(), cp, rows)
                    self.assertFalse(any(row.get('planningMode') == 'native-stages-v1' for row in plan['items']))
            added = app['calls'][before:]
            self.assertFalse(any(method == 'POST' and ('/element/' in route or route.endswith('/back')) for method, route, body in added))
            self.assertEqual(len(app['business']), 1)

    def test_wrong_input_echo_stops_before_next_without_retry(self):
        with stage_app() as app, tempfile.TemporaryDirectory() as out:
            app['wrongEcho'] = True
            session = MobileSession(app['config'], out)
            with self.assertRaises(MobileError):
                session.explore()
            self.assertEqual(app['nextCount'], 0)
            self.assertEqual(len(app['business']), 0)
            sends = [route for method, route, body in app['calls'] if method == 'POST' and route.endswith('/value')]
            self.assertEqual(len(sends), 1)

    def test_missing_seed_permission_or_late_domain_rejects_before_that_screen_actions(self):
        for defect in ['seed', 'policy', 'domain']:
            with self.subTest(defect=defect), stage_app() as app, tempfile.TemporaryDirectory() as out:
                if defect == 'seed':
                    app['config']['nativeStagePlanning']['seedInputs'].pop()
                elif defect == 'policy':
                    app['config']['actionAllowlist'] = [r for r in app['config']['actionAllowlist'] if r['selector'] != {'accessibilityId': 'closed'}]
                else:
                    app['duplicateOption'] = True
                session = MobileSession(app['config'], out)
                with self.assertRaises(MobileError):
                    session.explore()
                self.assertEqual(len(app['business']), 0)
                self.assertFalse(any('/element/' in route and any(name in route for name in ['_second/', '_enabled/', '_open/', '_closed/', '_search/']) for method, route, body in app['calls']))

    def test_noop_preparation_has_fresh_receipt_without_fabricated_command(self):
        with stage_app() as app, tempfile.TemporaryDirectory() as out:
            next(row for row in app['config']['nativeStagePlanning']['seedInputs'] if row['kind'] == 'check')['value'] = False
            _, checkpoint, events, _, plan, _ = self.discover(app, Path(out))
            receipts = [row for row in events if row['kind'] == 'native_preparation_verified' and row['actionKind'] == 'check']
            self.assertEqual(len(receipts), 1)
            self.assertIs(receipts[0]['commandPerformed'], False)
            self.assertIsNone(receipts[0]['executionId'])
            self.assertIsNone(receipts[0]['startedEvidenceId'])
            self.assertFalse(any('_enabled/click' in route for method, route, body in app['calls']))
            self.assertEqual(len(plan['items']), 1)

    def test_later_domain_drift_after_learning_stops_before_later_field_actions(self):
        with stage_app() as app, tempfile.TemporaryDirectory() as out:
            root = Path(out)
            _, _, _, _, plan, item = self.discover(app, root)
            definition = copy.deepcopy(plan['specs'][item['id']])
            target = definition.pop('outcomeCandidates')[0]
            for param in ['first', 'second', 'enabled', 'mode']:
                definition['steps'].append({'kind': 'assert', 'selector': target['selector'], 'expect': {'containsInput': param}})
            definition['steps'].append({'kind': 'extract', 'selector': target['selector'], 'output': 'result'})
            learner = MobileSession(app['config'], root / 'learn')
            learn_workflow(learner, definition, [{'first': 'alpha', 'second': 'one', 'enabled': True, 'mode': 'open'}, {'first': 'beta', 'second': 'two', 'enabled': False, 'mode': 'closed'}])
            recipe = next(iter(learner.progress['recipes'].values()))
            app.update(page='first', generation=app['generation'] + 1, duplicateOption=True)
            before = len(app['calls'])
            with self.assertRaises(MobileError):
                MobileSession(app['config'], root / 'drift').execute(recipe, recipe['revision'], {'first': 'gamma', 'second': 'three', 'enabled': True, 'mode': 'open'})
            added = app['calls'][before:]
            self.assertTrue(any('_next/click' in route for method, route, body in added))
            self.assertFalse(any(any(name in route for name in ['_second/', '_enabled/', '_open/', '_closed/', '_search/']) for method, route, body in added))
            self.assertEqual(len(app['business']), 3)
            app.update(page='first', generation=app['generation'] + 1, duplicateOption=False, rewriteModeOnSecond=True)
            with self.assertRaises(MobileError) as drift:
                MobileSession(app['config'], root / 'cross-field-drift').execute(recipe, recipe['revision'], {'first': 'gamma', 'second': 'three', 'enabled': True, 'mode': 'open'})
            self.assertEqual(drift.exception.code, 'NATIVE_STAGE_INPUT_STATE_CHANGED')
            self.assertEqual(len(app['business']), 3)
            # A forged write definition never inherits deferred stage preflight.
            spec = copy.deepcopy(definition)
            spec['effect'] = 'write'
            cfg = copy.deepcopy(app['config'])
            cfg['workflowPermissions'] = {'allowWrite': [spec['id']], 'allowWriteLearning': [spec['id']]}
            before = len(app['calls'])
            with self.assertRaises(MobileError) as caught:
                learn_workflow(MobileSession(cfg, root / 'forged-write'), spec, [{'first': 'a', 'second': 'b', 'enabled': True, 'mode': 'open'}, {'first': 'c', 'second': 'd', 'enabled': False, 'mode': 'closed'}])
            self.assertEqual(caught.exception.code, 'NATIVE_STAGE_DEFINITION_INVALID')
            self.assertEqual(len(app['calls']), before)

    def test_reflected_text_seed_never_enters_stage_metadata_or_value_hashes(self):
        import hashlib
        for defect in ['reflectButton', 'reflectResultId']:
            with self.subTest(defect=defect), stage_app() as app, tempfile.TemporaryDirectory() as out:
                app[defect] = True
                session = MobileSession(app['config'], out)
                with self.assertRaises(MobileError) as caught:
                    session.explore()
                self.assertEqual(caught.exception.code, 'NATIVE_STAGE_SENSITIVE_METADATA')
                trace = json.dumps(json.loads(Path(out, 'checkpoint.json').read_text())['nativeStageTrace'])
                events = Path(out, 'events.jsonl').read_text()
                for value in ['seed-first', 'seed-second']:
                    self.assertNotIn(value, trace + events)
                    self.assertNotIn(hashlib.sha256(value.encode()).hexdigest(), trace + events)
                self.assertEqual(app['nextCount'], 0 if defect == 'reflectButton' else 1)
                self.assertEqual(len(app['business']), 0 if defect == 'reflectButton' else 1)
                self.assertFalse(session.progress['recipes'])

    def test_later_input_handler_cannot_silently_rewrite_prepared_selection(self):
        with stage_app() as app, tempfile.TemporaryDirectory() as out:
            app['rewriteModeOnSecond'] = True
            error = None
            try:
                MobileSession(app['config'], out).explore()
            except MobileError as caught:
                error = caught
            self.assertIsNotNone(error, 'Cross-field drift allowed: ' + json.dumps({'business': len(app['business']), 'next': app['nextCount'], 'search': app['searchCount']}))
            self.assertEqual(error.code, 'NATIVE_STAGE_INPUT_STATE_CHANGED')
            self.assertEqual(len(app['business']), 0)
            self.assertEqual(app['searchCount'], 0)

    def test_first_learning_sample_result_control_drift_never_publishes_ready(self):
        with stage_app() as app, tempfile.TemporaryDirectory() as out:
            root = Path(out)
            _, _, _, _, plan, item = self.discover(app, root)
            definition = copy.deepcopy(plan['specs'][item['id']])
            target = definition.pop('outcomeCandidates')[0]
            for param in ['first', 'second', 'enabled', 'mode']:
                definition['steps'].append({'kind': 'assert', 'selector': target['selector'], 'expect': {'containsInput': param}})
            definition['steps'].append({'kind': 'extract', 'selector': target['selector'], 'output': 'result'})
            app.update(resultControlAfterSearch=2, result='RESULT neutral')
            learner = MobileSession(app['config'], root / 'drift-first-sample')
            with self.assertRaises(MobileError) as caught:
                learn_workflow(learner, definition, [{'first': 'alpha', 'second': 'one', 'enabled': True, 'mode': 'open'}, {'first': 'beta', 'second': 'two', 'enabled': False, 'mode': 'closed'}])
            self.assertEqual(caught.exception.code, 'WORKFLOW_CONTROL_CONTRACT_CHANGED')
            self.assertFalse(learner.progress['recipes'])
            self.assertEqual(len(app['business']), 2)

    def test_unknown_search_outcome_is_not_automatically_replayed_after_resume(self):
        with stage_app() as app, tempfile.TemporaryDirectory() as out:
            app['disconnectSearch'] = True
            with self.assertRaises(MobileError):
                MobileSession(app['config'], out).explore()
            self.assertEqual(len(app['business']), 1)
            with self.assertRaises(MobileError):
                MobileSession(app['config'], out, resume=True).explore()
            self.assertEqual(app['searchCount'], 1)
            self.assertEqual(len(app['business']), 1)


class NativeStageEntryRestoreTests(unittest.TestCase):
    """Pure parser and in-memory transport: no HTTP service, device or lease."""

    def fixture(self, platform='android', start=2, max_depth=5):
        from apk_inventory.mobile_stages import inspect_stage
        app = 'com.example.stages'
        identify = lambda name: {'resourceId': app + ':id/' + name} if platform == 'android' else {'accessibilityId': name}

        def xml(number):
            name, button = ('first', 'next') if number == 0 else ('second', 'search')
            if platform == 'android':
                node = lambda key, cls, **attrs: '<node package="' + app + '" resource-id="' + app + ':id/' + key + '" class="android.widget.' + cls + '" enabled="true" visible="true" bounds="[0,0][160,40]" ' + ' '.join(k + '="' + str(v) + '"' for k, v in attrs.items()) + '/>'
                body = node('result', 'TextView', text='RESULT') if number == 2 else node(name, 'EditText', text='') + node(button, 'Button', text=button, clickable='true')
                return '<hierarchy>' + body + '</hierarchy>'
            node = lambda key, cls, **attrs: '<XCUIElementType' + cls + ' type="XCUIElementType' + cls + '" name="' + key + '" enabled="true" visible="true" x="0" y="0" width="160" height="40" ' + ' '.join(k + '="' + str(v) + '"' for k, v in attrs.items()) + '/>'
            body = node('result', 'StaticText', label='RESULT') if number == 2 else node(name, 'TextField', label=name, value='') + node(button, 'Button', label=button)
            return '<AppiumAUT>' + body + '</AppiumAUT>'

        trees = [parse_tree(xml(i), platform, app) for i in range(3)]
        unknown = parse_tree(xml(2).replace('result', 'unrelated_modal'), platform, app)
        empty = parse_tree('<hierarchy/>', platform, app)
        config = {'nativeStagePlanning': {'workflowId': 'native_lookup', 'seedInputs': [{'kind': 'type', 'selector': identify(name), 'value': 'synthetic-' + name} for name in ['first', 'second']]}, 'actionAllowlist': [{'kind': kind, 'selector': identify(name), 'effect': 'read'} for kind, name in [('type', 'first'), ('type', 'second'), ('click', 'next'), ('click', 'search')]]}
        budget = Budget({'maxActions': 10, 'maxDepth': max_depth, 'maxDurationMs': 3000})
        calls, events = [], []
        backend = SimpleNamespace(current=start, observe_count=0, after=[], observe_hook=None, perform_hook=None)

        def observe():
            budget.check()
            calls.append({'kind': 'observe'})
            backend.observe_count += 1
            if backend.observe_hook:
                backend.observe_hook()
            return trees[backend.current] if isinstance(backend.current, int) else backend.current

        def perform(action, tree, inputs):
            self.assertEqual(action, {'kind': 'back'})
            calls.append({'kind': 'command', 'action': action})
            if backend.perform_hook:
                backend.perform_hook()
            backend.current = backend.after.pop(0) if backend.after else backend.current - 1

        def event(kind, **fields):
            events.append({'kind': kind, **fields})
            return 'test_event_' + str(len(events))

        backend.observe, backend.perform = observe, perform
        backend.foreground = lambda: calls.append({'kind': 'foreground'})
        session = SimpleNamespace(config=config, source={'id': 'synthetic', 'kind': 'apk' if platform == 'android' else 'ios'}, identity='synthetic_identity', progress={}, budget=budget, backend=backend, event=event, checkpoint=lambda: None)
        session.policy = lambda action: MobileSession.policy(session, action)
        plan = {'proof': {'trace': {'stages': [inspect_stage(session, tree) for tree in trees]}}}
        return SimpleNamespace(session=session, backend=backend, plan=plan, trees=trees, unknown=unknown, empty=empty, calls=calls, events=events)

    def commands(self, f):
        return [row for row in f.calls if row['kind'] == 'command']

    def restore(self, f):
        from apk_inventory.mobile_stages import restore_entry
        return restore_entry(f.session, f.plan)

    def test_entry_needs_no_navigation(self):
        for platform in ['android', 'ios']:
            with self.subTest(platform=platform):
                f = self.fixture(platform, start=0)
                self.restore(f)
                self.assertEqual(self.commands(f), [])

    def test_observed_later_and_terminal_stages_restore_only_adjacent_steps(self):
        for platform in ['android', 'ios']:
            for start in [1, 2]:
                with self.subTest(platform=platform, start=start):
                    f = self.fixture(platform, start=start)
                    self.restore(f)
                    self.assertEqual(f.backend.current, 0)
                    self.assertEqual(len(self.commands(f)), start)
                    self.assertFalse(f.session.progress.get('pending'))

    def test_unknown_result_or_empty_screen_never_navigates(self):
        for platform in ['android', 'ios']:
            for kind in ['unknown', 'empty']:
                with self.subTest(platform=platform, kind=kind):
                    f = self.fixture(platform)
                    f.backend.current = getattr(f, kind)
                    with self.assertRaises(MobileError):
                        self.restore(f)
                    self.assertEqual(self.commands(f), [])

    def test_ambiguous_input_screen_never_navigates(self):
        f = self.fixture()
        # Two approved buttons for the same ungrouped input do not prove a route.
        ambiguous = copy.deepcopy(f.trees[0])
        ambiguous['nodes'].append(copy.deepcopy(f.trees[1]['nodes'][-1]))
        f.backend.current = ambiguous
        with self.assertRaises(MobileError):
            self.restore(f)
        self.assertEqual(self.commands(f), [])

    def test_duplicate_observed_stage_contract_never_navigates(self):
        f = self.fixture()
        f.plan['proof']['trace']['stages'].append(copy.deepcopy(f.plan['proof']['trace']['stages'][-1]))
        with self.assertRaises(MobileError) as caught:
            self.restore(f)
        self.assertEqual(caught.exception.code, 'WORKFLOW_STAGE_ROUTE_CHANGED')
        self.assertEqual(self.commands(f), [])

    def test_wrong_or_skipped_post_back_stage_never_gets_another_back(self):
        for platform in ['android', 'ios']:
            for destination in ['unknown', 0, 2]:
                with self.subTest(platform=platform, destination=destination):
                    f = self.fixture(platform)
                    f.backend.after = [f.unknown if destination == 'unknown' else destination]
                    with self.assertRaises(MobileError):
                        self.restore(f)
                    self.assertEqual(len(self.commands(f)), 1)

    def test_drift_between_back_steps_stops_before_second_back(self):
        for destination in ['unknown', 0, 2]:
            with self.subTest(destination=destination):
                f = self.fixture()
                value = f.unknown if destination == 'unknown' else destination
                f.backend.observe_hook = lambda: setattr(f.backend, 'current', value) if f.backend.observe_count == 3 else None
                with self.assertRaises(MobileError):
                    self.restore(f)
                self.assertEqual(len(self.commands(f)), 1)

    def test_lowered_depth_budget_bounds_restoration(self):
        from apk_inventory.mobile_stages import inspect_stage
        f = self.fixture(start=3, max_depth=0)
        third = copy.deepcopy(f.trees[1])
        for node in third['nodes']:
            node['resourceId'] += '_third'
            f.session.config['actionAllowlist'].append({'kind': 'type' if node['editable'] else 'click', 'selector': {'resourceId': node['resourceId']}, 'effect': 'read'})
        f.trees.insert(2, third)
        f.plan['proof']['trace']['stages'].insert(2, inspect_stage(f.session, third))
        with self.assertRaises(MobileError) as caught:
            self.restore(f)
        self.assertEqual(caught.exception.code, 'NATIVE_STAGE_ENTRY_UNREACHABLE')
        self.assertEqual(len(self.commands(f)), 2)

    def test_source_observation_failure_never_becomes_back_permission(self):
        for failing_read in [1, 2]:
            with self.subTest(failing_read=failing_read):
                f = self.fixture()
                def failure():
                    if f.backend.observe_count == failing_read:
                        raise MobileError('APP_OUT_OF_SCOPE', 'blocked')
                f.backend.observe_hook = failure
                with self.assertRaises(MobileError) as caught:
                    self.restore(f)
                self.assertEqual(caught.exception.code, 'APP_OUT_OF_SCOPE')
                self.assertEqual(len(self.commands(f)), failing_read - 1)

    def test_timeout_or_cancellation_before_restore_never_navigates(self):
        for defect in ['timeout', 'cancel']:
            with self.subTest(defect=defect):
                f = self.fixture()
                if defect == 'timeout':
                    f.session.budget.started -= 10
                else:
                    f.session.budget.cancelled = True
                with self.assertRaises(MobileError):
                    self.restore(f)
                self.assertEqual(self.commands(f), [])

    def test_timeout_or_cancellation_after_dispatch_has_no_retry(self):
        for defect in ['timeout', 'cancel']:
            with self.subTest(defect=defect):
                f = self.fixture()
                f.backend.perform_hook = (lambda: setattr(f.session.budget, 'started', f.session.budget.started - 10)) if defect == 'timeout' else (lambda: setattr(f.session.budget, 'cancelled', True))
                with self.assertRaises(MobileError):
                    self.restore(f)
                self.assertEqual(len(self.commands(f)), 1)
                self.assertTrue(f.session.progress.get('pending'))

    def test_unknown_back_outcome_has_one_dispatch_and_pending_receipt(self):
        f = self.fixture()
        def disconnect():
            raise MobileError('WEBDRIVER_COMMAND_FAILED', 'partial')
        f.backend.perform_hook = disconnect
        with self.assertRaises(MobileError) as caught:
            self.restore(f)
        self.assertEqual(caught.exception.code, 'WEBDRIVER_COMMAND_FAILED')
        self.assertEqual(len(self.commands(f)), 1)
        self.assertTrue(f.session.progress.get('pending'))
        with self.assertRaises(MobileError) as resumed:
            self.restore(f)
        self.assertEqual(resumed.exception.code, 'NATIVE_STAGE_RESUME_REQUIRES_FRESH_RUN')
        self.assertEqual(len(self.commands(f)), 1)

    def test_pre_action_budget_expiry_does_not_dispatch_back(self):
        f = self.fixture()
        # Simulate a slow full contract comparison consuming the remaining time.
        f.backend.observe_hook = lambda: setattr(f.session.budget, 'started', f.session.budget.started - 10)
        with self.assertRaises(MobileError):
            self.restore(f)
        self.assertEqual(self.commands(f), [])

    def test_native_pending_is_rejected_before_shared_launch_or_observe(self):
        for pending in [{'executionId': 'synthetic_unknown'}, {}]:
            for launch in [False, True]:
                with self.subTest(pending=pending, launch=launch):
                    f = self.fixture()
                    f.session.config.update(launchApp=launch, allowLaunch=True)
                    f.session.progress['pending'] = pending
                    launches = []
                    f.session.step = lambda action, expected: launches.append(action)
                    with self.assertRaises(MobileError) as caught:
                        MobileSession._explore(f.session)
                    self.assertEqual(caught.exception.code, 'NATIVE_STAGE_RESUME_REQUIRES_FRESH_RUN')
                    self.assertEqual(launches, [])
                    self.assertEqual(f.calls, [])

    def test_native_prior_trace_is_rejected_before_shared_launch_or_observe(self):
        for trace in [{'runId': 'synthetic_prior_run', 'completed': False}, {}]:
            for launch in [False, True]:
                with self.subTest(trace=trace, launch=launch):
                    f = self.fixture()
                    f.session.config.update(launchApp=launch, allowLaunch=True)
                    f.session.progress['nativeStageTrace'] = trace
                    launches = []
                    f.session.step = lambda action, expected: launches.append(action)
                    with self.assertRaises(MobileError) as caught:
                        MobileSession._explore(f.session)
                    self.assertEqual(caught.exception.code, 'NATIVE_STAGE_RESUME_REQUIRES_FRESH_RUN')
                    self.assertEqual(launches, [])
                    self.assertEqual(f.calls, [])

    def test_fresh_native_startup_preserves_separate_launch_permission(self):
        for approved in [False, True]:
            with self.subTest(approved=approved):
                f = self.fixture()
                f.session.config.update(launchApp=True, allowLaunch=approved)
                launches = []
                f.session.step = lambda action, expected: launches.append(action)
                def stop_on_first_read():
                    raise MobileError('SYNTHETIC_FRESH_SOURCE_READ', 'blocked')
                f.backend.observe_hook = stop_on_first_read
                with self.assertRaises(MobileError) as caught:
                    MobileSession._explore(f.session)
                self.assertEqual(caught.exception.code, 'SYNTHETIC_FRESH_SOURCE_READ' if approved else 'LAUNCH_NOT_ENABLED')
                self.assertEqual(launches, [{'kind': 'launch'}] if approved else [])
                self.assertEqual(f.backend.observe_count, 1 if approved else 0)

    def test_legacy_default_and_explicit_none_keep_shared_launch_flow(self):
        for explicit_none in [False, True]:
            with self.subTest(explicit_none=explicit_none):
                f = self.fixture()
                if explicit_none:
                    f.session.config['nativeStagePlanning'] = None
                else:
                    del f.session.config['nativeStagePlanning']
                f.session.config.update(launchApp=True, allowLaunch=True)
                f.session.progress = {'states': {'synthetic_entry': {}}, 'queue': [], 'capabilities': {}, 'gaps': []}
                f.session.prior_actions, f.session.features = 0, {}
                launches = []
                f.session.step = lambda action, expected: launches.append(action)
                result = MobileSession._explore(f.session)
                self.assertTrue(result['ok'])
                self.assertEqual(launches, [{'kind': 'launch'}])
                self.assertEqual(f.calls, [])


if __name__ == '__main__':
    unittest.main()
