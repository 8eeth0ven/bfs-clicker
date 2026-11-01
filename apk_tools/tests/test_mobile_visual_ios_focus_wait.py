"""Bounded post-focus observations; pure WDA/OCR mocks, no device or OCR.

The two-second window admits a new candidate, not a substitute deadline for
an already admitted source/capture/full-OCR/source validation chain.
"""
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from apk_inventory import mobile_visual_ios_keyboard as keyboard
from apk_inventory import mobile_visual_ios_text as visual
from apk_inventory.mobile_ui import DeviceLease, MobileError
from test_mobile_visual_ios_keyboard import APP, Harness, PLAN, session, xml


class FocusProbe:
    def __init__(self, directory, sources, *, source_hook=None, foreground_hook=None,
                 observe_hook=None, geometry_hook=None):
        self.session = session(directory)
        self.original = self.session.budget
        self.sources = sources
        self.source_hook, self.foreground_hook = source_hook, foreground_hook
        self.observe_hook, self.geometry_hook = observe_hook, geometry_hook
        self.reads, self.foregrounds = 0, 0
        self.events, self.observations = [], []
        self.geometry = (100, 200)
        self.reference = {'width': 300, 'height': 600}
        self.session.backend.foreground = self.foreground
        self.session.backend.request = self.request

    def foreground(self):
        self.original.check()
        self.foregrounds += 1
        self.events.append('foreground')
        if self.foreground_hook:
            self.foreground_hook(self)

    def request(self, method, route, body=None):
        assert (method, route, body) == ('GET', '/source', None), 'no UI or other requests'
        self.original.check()
        self.reads += 1
        self.events.append('source')
        if self.source_hook:
            self.source_hook(self)
        value = self.sources[min(self.reads - 1, len(self.sources) - 1)]
        if isinstance(value, Exception):
            raise value
        return value

    def observe(self, actual, lease, config):
        assert actual is self.session and actual.budget is self.original
        actual.budget.check()
        self.events.append('full-observe')
        image = {'width': 300, 'height': 600, 'tokens': [],
                 '_imagePath': 'new-frame-' + str(len(self.observations)),
                 'imageSha256': hashlib.sha256(str(len(self.observations)).encode()).hexdigest()}
        self.observations.append(image)
        if self.observe_hook:
            self.observe_hook(self)
        return image

    def check_geometry(self, actual, observation, expected):
        assert actual is self.session and expected == self.geometry
        self.original.check()
        self.events.append('geometry')
        if self.geometry_hook:
            self.geometry_hook(self)
        return self.geometry

    def run(self):
        with patch.object(visual, '_observe', side_effect=self.observe), \
                patch.object(visual, '_geometry', side_effect=self.check_geometry), \
                patch.object(visual, 'unchanged_locked', side_effect=AssertionError('hidden cannot authorize')):
            return keyboard._focus_observe(self.session, object(), self.session.config['nativeVisualWorkflow'],
                                           self.geometry, self.reference)

    def record(self):
        records = list((self.session.output / 'visual-private').glob('keyboard-focus-observation-*.json'))
        assert len(records) == 1
        return json.loads(records[0].read_text())


class FocusWaitTests(unittest.TestCase):
    def test_first_visible_pair_preserves_source_full_ocr_geometry_source_order(self):
        with tempfile.TemporaryDirectory() as directory:
            p = FocusProbe(directory, [xml(True)])
            result, geometry = p.run()
            self.assertIs(result, p.observations[0])
            self.assertEqual(geometry, (100, 200))
            self.assertEqual((p.reads, len(p.observations), p.original.count), (2, 1, 0))
            self.assertEqual(p.events, ['foreground', 'source', 'foreground', 'full-observe',
                                        'geometry', 'foreground', 'source', 'foreground'])

    def test_hidden_then_visible_requires_one_new_complete_observation(self):
        for hidden in (1, 2):
            with self.subTest(hidden=hidden), tempfile.TemporaryDirectory() as directory:
                p = FocusProbe(directory, [xml(False)] * hidden + [xml(True)])
                result, _ = p.run()
                self.assertIs(result, p.observations[0])
                self.assertEqual((p.reads, len(p.observations)), (hidden + 2, 1))
                record = p.record()
                self.assertEqual((record['attempts'], record['sourceReads'], record['newObservations']), (hidden + 1, hidden + 2, 1))
                self.assertFalse(record['uiActionRetried'])

    def test_visible_hidden_discards_image_and_requires_whole_new_pair(self):
        with tempfile.TemporaryDirectory() as directory:
            p = FocusProbe(directory, [xml(True), xml(False), xml(True), xml(True)])
            result, _ = p.run()
            self.assertIs(result, p.observations[1])
            self.assertIsNot(result, p.observations[0])
            self.assertNotEqual(result['imageSha256'], p.observations[0]['imageSha256'])
            self.assertEqual((p.reads, len(p.observations)), (4, 2))
            self.assertEqual(p.record()['phaseMismatches'], 1)

    def test_persistent_hidden_is_bounded_and_never_captures_or_authorizes(self):
        with tempfile.TemporaryDirectory() as directory:
            p = FocusProbe(directory, [xml(False)])
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_NOT_VISIBLE'):
                p.run()
            self.assertEqual((p.reads, len(p.observations), p.original.count), (3, 0, 0))
            self.assertEqual(p.record()['status'], 'rejected')

    def test_three_visible_hidden_pairs_stop_at_six_sources_three_new_observations(self):
        with tempfile.TemporaryDirectory() as directory:
            p = FocusProbe(directory, [xml(True), xml(False)] * 3)
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_NOT_VISIBLE'):
                p.run()
            self.assertEqual((p.reads, len(p.observations)), (6, 3))
            self.assertEqual(p.record()['attempts'], 3)

    def test_last_attempt_can_succeed_without_a_fourth_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            p = FocusProbe(directory, [xml(True), xml(False)] * 2 + [xml(True), xml(True)])
            result, _ = p.run()
            self.assertIs(result, p.observations[2])
            self.assertEqual((p.reads, len(p.observations)), (6, 3))

    def test_all_invalid_source_or_geometry_errors_are_immediate_in_both_endpoints(self):
        below = xml(True, (0, 205, 100, 100)).replace('x="5" y="110"', 'x="5" y="215"')
        hidden_node = xml(False).split(f'bundleId="{APP}">', 1)[1].split('</XCUIElementTypeApplication>', 1)[0]
        mixed = xml(True).replace('</XCUIElementTypeApplication>', hidden_node + '</XCUIElementTypeApplication>')
        cases = [('<broken', 'VISUAL_KEYBOARD_SOURCE_INVALID'),
                 (xml(True, app='wrong.app'), 'VISUAL_KEYBOARD_APP_UNVERIFIED'),
                 (xml(False, duplicate=True), 'VISUAL_KEYBOARD_AMBIGUOUS'),
                 (xml(True, duplicate=True), 'VISUAL_KEYBOARD_AMBIGUOUS'),
                 (mixed, 'VISUAL_KEYBOARD_AMBIGUOUS'),
                 (xml(True, keys=False), 'VISUAL_KEYBOARD_KEYS_UNVERIFIED'),
                 (xml(True).replace('x="5" y="110"', 'x="95" y="110"'), 'VISUAL_KEYBOARD_KEYS_UNVERIFIED'),
                 (xml(True, (0, 100, 100, 101)), 'VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED'),
                 (below, 'VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED'),
                 (xml(True, (0, 99, 100, 101)), 'VISUAL_KEYBOARD_REGION_MISMATCH')]
        for bad, code in cases:
            for endpoint in (0, 1):
                with self.subTest(code=code, endpoint=endpoint), tempfile.TemporaryDirectory() as directory:
                    p = FocusProbe(directory, [xml(True)] * endpoint + [bad, xml(True), xml(True)])
                    with self.assertRaisesRegex(MobileError, code):
                        p.run()
                    self.assertEqual((p.reads, len(p.observations)), (endpoint + 1, endpoint))

    def test_transport_foreground_ocr_geometry_errors_are_not_retried(self):
        for stage, code in [('source', 'WEBDRIVER_UNAVAILABLE'), ('foreground', 'APP_OUT_OF_SCOPE'),
                            ('observe', 'VISUAL_OCR_FAILED'), ('geometry', 'VISUAL_COORDINATES_UNVERIFIED')]:
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as directory:
                def broken(_):
                    raise MobileError(code)
                p = FocusProbe(directory, [MobileError(code)] if stage == 'source' else [xml(True)],
                               **({stage + '_hook': broken} if stage != 'source' else {}))
                with self.assertRaisesRegex(MobileError, code):
                    p.run()
                self.assertLessEqual(p.reads, 1)
                self.assertIs(p.session.budget, p.original)
                self.assertIs(p.session.backend.budget, p.original)

    def test_attempt_window_starts_at_hidden_classification_before_post_foreground(self):
        now = [0]
        def delay_post(p):
            if p.foregrounds == 2:
                now[0] = 2
        with tempfile.TemporaryDirectory() as directory, patch.object(keyboard, 'time', SimpleNamespace(monotonic=lambda: now[0])):
            p = FocusProbe(directory, [xml(False), xml(True)], foreground_hook=delay_post)
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_NOT_VISIBLE'):
                p.run()
            self.assertEqual((p.reads, p.foregrounds, len(p.observations)), (1, 2, 0))

    def test_admitted_candidate_may_finish_full_validation_after_window_without_reclassifying_frame(self):
        now = [0]
        def slow_full_observation(_):
            now[0] = 4
        with tempfile.TemporaryDirectory() as directory, patch.object(keyboard, 'time', SimpleNamespace(monotonic=lambda: now[0])):
            p = FocusProbe(directory, [xml(False), xml(True), xml(True)], observe_hook=slow_full_observation)
            result, _ = p.run()
            self.assertIs(result, p.observations[0])
            self.assertEqual((p.reads, len(p.observations)), (3, 1))
            self.assertEqual(p.events[-4:], ['geometry', 'foreground', 'source', 'foreground'])
            self.assertTrue(p.record()['windowLimitsAttemptStartOnly'])

    def test_first_normal_visible_pair_has_no_additional_deadline(self):
        now = [0]
        with tempfile.TemporaryDirectory() as directory, patch.object(keyboard, 'time', SimpleNamespace(monotonic=lambda: now[0])):
            p = FocusProbe(directory, [xml(True)], observe_hook=lambda _: now.__setitem__(0, 4))
            self.assertIs(p.run()[0], p.observations[0])
            self.assertEqual(p.reads, 2)

    def test_real_twelfth_first_visible_pair_timing_can_complete_after_admission_window(self):
        root = Path(__file__).resolve().parents[2]
        path = root / 'output-vision-implementation/ios-keyboard-complete-twelfth-20261101/forwarded-requests.json'
        if not path.is_file():
            self.skipTest('private archived timing is not distributed')
        rows = json.loads(path.read_text())
        start = rows[37]['started']
        self.assertEqual(rows[48]['finished'] - start, 2070)
        now = [0]
        foregrounds = {3: 37, 4: 39, 5: 46, 6: 48}
        def foreground(p):
            if p.foregrounds in foregrounds:
                now[0] = (rows[foregrounds[p.foregrounds]]['finished'] - start) / 1000
        def source(p):
            if p.reads in (2, 3):
                now[0] = (rows[38 if p.reads == 2 else 47]['finished'] - start) / 1000
        # The real archived clock is replayed onto synthetic valid source/OCR
        # evidence. This is not another device run or a repair of old evidence.
        with tempfile.TemporaryDirectory() as directory, patch.object(keyboard, 'time', SimpleNamespace(monotonic=lambda: now[0])):
            p = FocusProbe(directory, [xml(False), xml(True), xml(True)],
                           foreground_hook=foreground, source_hook=source,
                           observe_hook=lambda _: now.__setitem__(0, (rows[43]['started'] - start) / 1000),
                           geometry_hook=lambda _: now.__setitem__(0, (rows[45]['finished'] - start) / 1000))
            self.assertIs(p.run()[0], p.observations[0])
            self.assertEqual(now[0], 2.07)
            self.assertEqual((p.reads, len(p.observations)), (3, 1))

    def test_shared_observer_starts_a_separate_capture_and_ocr_child_for_each_candidate(self):
        from apk_inventory import mobile_visual_workflow as workflow
        with tempfile.TemporaryDirectory() as directory:
            p = FocusProbe(Path(directory).resolve(), [xml(False), xml(True), xml(False), xml(True), xml(True)])
            lease = DeviceLease(p.session.backend)
            lease.stream = SimpleNamespace(closed=False)
            captures = []
            def capture(actual, output, owned):
                self.assertIs(actual, p.session)
                self.assertIs(owned, lease)
                self.assertIs(actual.budget, p.original)
                result = {'width': 300, 'height': 600, 'imagePath': str(output / 'new.png'),
                          'imageSha256': hashlib.sha256(str(len(captures)).encode()).hexdigest(),
                          'capturedAt': '2026-11-02T00:00:00.000Z', 'artifactVerification': {}}
                captures.append(result)
                return result
            def start(*args, **kwargs):
                self.assertTrue(kwargs['start_new_session'])
                result = {key: captures[-1][key] for key in ('width', 'height', 'imageSha256')}
                return SimpleNamespace(returncode=0, poll=lambda: 0, wait=lambda: 0,
                                       communicate=lambda **_: (json.dumps(result).encode(), b''))
            with patch.object(workflow, 'capture_locked', side_effect=capture) as capture_call, \
                    patch.object(workflow.subprocess, 'Popen', side_effect=start) as start_call, \
                    patch.object(visual, '_geometry', side_effect=p.check_geometry):
                result, _ = keyboard._focus_observe(p.session, lease, p.session.config['nativeVisualWorkflow'],
                                                     p.geometry, p.reference)
            self.assertEqual((p.reads, capture_call.call_count, start_call.call_count), (5, 2, 2))
            self.assertEqual(result['imageSha256'], captures[1]['imageSha256'])
            self.assertNotEqual(result['imageSha256'], captures[0]['imageSha256'])
            self.assertIs(p.session.budget, p.original)
            self.assertIs(p.session.backend.budget, p.original)
            self.assertEqual(p.original.count, 0)

    def test_mismatch_does_not_renew_a_previously_started_window(self):
        now = [0]
        def observed(_):
            now[0] = 2
        with tempfile.TemporaryDirectory() as directory, patch.object(keyboard, 'time', SimpleNamespace(monotonic=lambda: now[0])):
            p = FocusProbe(directory, [xml(False), xml(True), xml(False), xml(True)], observe_hook=observed)
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_NOT_VISIBLE'):
                p.run()
            self.assertEqual((p.reads, len(p.observations)), (3, 1))
            self.assertEqual(p.record()['firstInstability'], 'focus_hidden_source')

    def test_first_mismatch_opens_window_after_full_initial_observation(self):
        now = [0]
        def slow_first(p):
            now[0] = 5 if len(p.observations) == 1 else 5.5
        with tempfile.TemporaryDirectory() as directory, patch.object(keyboard, 'time', SimpleNamespace(monotonic=lambda: now[0])):
            p = FocusProbe(directory, [xml(True), xml(False), xml(True), xml(True)], observe_hook=slow_first)
            self.assertIs(p.run()[0], p.observations[1])
            self.assertEqual(p.record()['firstInstability'], 'focus_phase_mismatch')

    def test_cancellation_or_original_duration_budget_stops_without_a_new_candidate(self):
        for code in ('STOPPED', 'DURATION_BUDGET'):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                p = FocusProbe(directory, [xml(False), xml(True)])
                def expire(probe):
                    if code == 'STOPPED':
                        probe.original.cancelled = True
                    else:
                        probe.original.started -= probe.original.duration / 1000
                p.source_hook = expire
                with self.assertRaisesRegex(MobileError, code):
                    p.run()
                self.assertEqual((p.reads, len(p.observations)), (1, 0))
                self.assertIs(p.session.budget, p.original)

    def test_post_ocr_budget_expiration_cannot_authorize_missing_post_source(self):
        with tempfile.TemporaryDirectory() as directory:
            p = FocusProbe(directory, [xml(False), xml(True)], observe_hook=lambda p: setattr(p.original, 'cancelled', True))
            with self.assertRaisesRegex(MobileError, 'STOPPED'):
                p.run()
            self.assertEqual((p.reads, len(p.observations)), (2, 1))

    def test_post_hidden_foreground_failure_and_nested_observation_do_not_retry(self):
        def app_switched(p):
            if p.foregrounds == 2:
                raise MobileError('APP_OUT_OF_SCOPE')
        with tempfile.TemporaryDirectory() as directory:
            p = FocusProbe(directory, [xml(False), xml(True)], foreground_hook=app_switched)
            with self.assertRaisesRegex(MobileError, 'APP_OUT_OF_SCOPE'):
                p.run()
            self.assertEqual((p.reads, len(p.observations)), (1, 0))
            self.assertFalse(hasattr(p.session, '_focus_observing'))
            p.session._focus_observing = True
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_SOURCE_INVALID'):
                p.run()
            self.assertEqual(p.reads, 1)

    def test_archived_fourteenth_hidden_xml_remains_hidden_and_never_starts_ocr(self):
        root = Path(__file__).resolve().parents[2]
        path = root / 'output-vision-implementation/ios-onscreen-compiler15-frozen-source-20261101/output-vision-implementation/ios-keyboard-compiler15-fourteenth-20261101/source-response-38.xml'
        if not path.is_file():
            self.skipTest('private archived evidence is not distributed')
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), 'c3fef85aeddbd9ea93f6bebeb27069d855031c7fb481ad45017a52ea5937b9c6')
        with tempfile.TemporaryDirectory() as directory:
            p = FocusProbe(directory, [path.read_text()]);p.session.backend.app_id = 'com.example.bfsmcp.iosvisualkeyboard'
            p.geometry = (466, 678);p.reference = {'width': 1398, 'height': 2034}
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_NOT_VISIBLE'):
                p.run()
            self.assertEqual((p.reads, len(p.observations), p.original.count), (3, 0, 0))


class FocusWorkflowTests(unittest.TestCase):
    def test_delayed_onscreen_fixed_clear_two_sample_plan_retains_fifty_action_budget(self):
        from test_mobile_visual_ios_keys_complete_text import CompleteHarness, plan
        from apk_inventory import mobile_visual_ios_keys as keys
        with tempfile.TemporaryDirectory() as directory, CompleteHarness(self, directory,
                plan=plan(clear_plan='fixed_max_length'), maxActions=50) as h:
            h.session.budget.duration = 480000
            original = h.request
            pending, focus_count = [0], [0]
            def delayed(method, route, body=None):
                if route == '/source' and pending[0]:
                    pending[0] -= 1
                    return xml(False)
                is_focus = (method == 'POST' and route == '/actions' and h.phase == 0
                            and body['actions'][0]['id'] != keys.POINTER_ID)
                result = original(method, route, body)
                if is_focus:
                    focus_count[0] += 1
                    pending[0] = focus_count[0]
                return result
            h.backend.request = delayed
            self.assertEqual(h.run('alpha'), {'text': 'RESULT alpha 1'})
            self.assertEqual(h.run('beta', copy.deepcopy(h.contracts)), {'text': 'RESULT beta 2'})
            self.assertEqual(h.physical, ['delete'] * 16 + list('alpha') + ['delete'] * 16 + list('beta'))
            outside = [body for route, body in h.calls if route == '/actions' and body['actions'][0]['id'] != keys.POINTER_ID]
            self.assertEqual((focus_count[0], len(outside), h.session.budget.count), (2, 6, 47))
            self.assertEqual((h.session.budget.max_actions, h.session.budget.duration), (50, 480000))
            self.assertFalse(any(route == '/keys' for route, _ in h.calls))

    def test_delayed_focus_completes_two_samples_without_repeating_focus_or_submit(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory) as h:
            original = h.request
            hidden_reads = {1: 1, 2: 2}
            def delayed(method, route, body=None):
                if route == '/source' and h.phase == 1:
                    focuses = len([1 for r, _ in h.calls if r == '/actions']) // 3 + 1
                    if hidden_reads.get(focuses, 0):
                        hidden_reads[focuses] -= 1
                        return xml(False)
                return original(method, route, body)
            h.backend.request = delayed
            self.assertEqual(h.run('alpha'), {'text': 'RESULT alpha 1'})
            contracts = copy.deepcopy(h.contracts)
            self.assertEqual(h.run('beta', contracts), {'text': 'RESULT beta 2'})
            self.assertEqual([r for r, _ in h.calls], ['/actions', '/keys', '/keys', '/actions', '/actions'] * 2)
            self.assertEqual(h.session.budget.count, 10)

    def test_persistent_hidden_keeps_one_focus_and_unknown_no_retry(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory, focusIgnored=True) as h:
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_NOT_VISIBLE') as caught:
                h.run()
            self.assertEqual([r for r, _ in h.calls], ['/actions'])
            self.assertEqual(caught.exception.writeOutcome, {'status': 'unknown', 'automaticRetry': False})
            self.assertEqual(h.session.budget.count, 1)

    def test_delayed_keyboard_does_not_bypass_later_input_freshness_or_echo_gates(self):
        for option, error in [('lateInputChange', 'VISUAL_FRAME_CHANGED'), ('inputIgnored', 'VISUAL_INPUT_NOT_VERIFIED'),
                              ('dismissIgnored', 'VISUAL_KEYBOARD_NOT_HIDDEN'), ('submitNoop', 'VISUAL_RESULT_NOT_VERIFIED')]:
            with self.subTest(option=option), tempfile.TemporaryDirectory() as directory, Harness(self, directory, **{option: True}) as h:
                original = h.request
                hidden = [False]
                def delayed(method, route, body=None):
                    if route == '/source' and h.phase == 1 and not hidden[0]:
                        hidden[0] = True
                        return xml(False)
                    return original(method, route, body)
                h.backend.request = delayed
                with self.assertRaisesRegex(MobileError, error) as caught:
                    h.run()
                self.assertEqual(caught.exception.writeOutcome, {'status': 'unknown', 'automaticRetry': False})
                self.assertLessEqual(len([1 for route, _ in h.calls if route == '/keys']), 2)


if __name__ == '__main__':
    unittest.main()
