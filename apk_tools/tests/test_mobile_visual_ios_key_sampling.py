"""Bounded key-freshness candidate timing; no device/Appium/OCR.

Optional private PNG replay runs existing local pixel comparators on saved
frames only. It does not change the fixed OCR reference or approve new pixels.
"""
import copy
import hashlib
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from apk_inventory import mobile_visual_ios_keys as keys
from apk_inventory import mobile_visual_ios_keyboard as keyboard
from apk_inventory import mobile_visual_ios_text as visual
from apk_inventory.mobile_ui import Budget, MobileError
from test_mobile_visual_ios_keys import KeyHarness


class Clock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []
        self.on_sleep = None
    def monotonic(self):
        return self.now
    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds
        if self.on_sleep:
            self.on_sleep(self)


class SamplingProbe:
    def __init__(self, test, directory, *, frames=None, stage_hook=None):
        self.test, self.clock = test, Clock()
        self.frames = frames or [{'global': False, 'keyboard': True, 'caret': False}]
        self.stage_hook = stage_hook
        self.current, self.captures, self.source_checks, self.scopes = 0, 0, 0, 0
        self.events, self.comparisons, self.references = [], [], []
        self.h = KeyHarness(test, directory)
        self.h.visible, self.h.value = True, ''
        self.session = self.h.session
        self.config = self.session.config['nativeVisualWorkflow']
        self.definition = self.h.definition
        self.observation = self.h.observation()
        self.observation['_imagePath'] = '/private/owner/do-not-persist-input-reference.png'
        self.observation['_rawInput'] = 'do-not-persist-this-input'
        self.source = keys.read_source(self.session, self.config, self.observation, (100, 200))
        self.geometry = (100, 200)

    def frame(self):
        return self.frames[min(max(0, self.current - 1), len(self.frames) - 1)]

    def stage(self, name):
        self.events.append((self.current, name))
        self.session.budget.check()
        if self.stage_hook:
            self.stage_hook(self, name)

    def read_source(self, *_):
        self.source_checks += 1
        self.stage('source_before' if self.source_checks % 2 else 'source_after')
        return copy.deepcopy(self.source)

    def capture(self, *_):
        self.captures += 1
        self.current = self.captures
        self.stage('capture')
        return {'width': 300, 'height': 600, 'imagePath': '/private/owner/fresh-input.png',
                'imageSha256': 'c' * 64, '_candidate': self.current}

    def geometry_check(self, *_):
        self.stage('geometry')
        return self.geometry

    def task(self, *_):
        owner = self
        index = self.scopes
        self.scopes += 1
        class Task:
            def __enter__(self):
                owner.stage('reference_start' if index == 0 else 'pixel_start')
                return self
            def __exit__(self, kind, value, traceback):
                # Tests can force late worker failure after a legal result.
                if kind is None:
                    owner.stage('reference_exit' if index == 0 else 'pixel_exit')
                return False
            def fingerprint(self, observation, masks):
                global_mask = masks == [owner.definition['resultRegion']]
                owner.comparisons.append((index, 'global' if global_mask else 'keyboard'))
                if index == 0:
                    owner.references.append(observation)
                    return 'a' * 64 if global_mask else 'b' * 64
                owner.test.assertIsNot(observation, owner.observation)
                owner.stage('global_pixels' if global_mask else 'keyboard_pixels')
                if global_mask:
                    return 'a' * 64 if owner.frame().get('global', False) else 'd' * 64
                return 'b' * 64 if owner.frame().get('keyboard', True) else 'e' * 64
        return Task()

    def caret(self, session, config, definition, before, after, geometry, masks, *, task):
        self.test.assertIs(before, self.observation)
        self.test.assertEqual(masks, [self.definition['resultRegion']])
        self.stage('caret')
        return self.frame().get('caret', False)

    def run(self):
        with patch.object(keys, 'time', self.clock), \
                patch.object(keys, 'read_source', side_effect=self.read_source), \
                patch.object(keys, 'capture_locked', side_effect=self.capture), \
                patch.object(visual, '_geometry', side_effect=self.geometry_check), \
                patch.object(visual.ios, '_pixel_task', side_effect=self.task), \
                patch.object(keyboard, '_caret_equivalent', side_effect=self.caret):
            return keys._fresh_key(self.session, object(), self.config, self.definition,
                                   self.observation, self.geometry, self.source, 'a', True)

    def record(self):
        paths = list((self.session.output / 'visual-private').glob('keyboard-key-sampling-*.json'))
        self.test.assertEqual(len(paths), 1)
        return json.loads(paths[0].read_text())


class CandidateTimingTests(unittest.TestCase):
    def test_slow_first_mismatch_opens_window_only_after_it_completes(self):
        def stage(p, name):
            if name == 'pixel_exit' and p.current == 1:
                p.clock.now = 3
        with tempfile.TemporaryDirectory() as directory:
            p = SamplingProbe(self, directory, frames=[{'global': False}, {'global': True}], stage_hook=stage)
            result = p.run()
            self.assertEqual(result['layout'], p.source['layout'])
            self.assertEqual((p.captures, p.source_checks), (2, 4))
            record = p.record()
            self.assertEqual(record['firstMismatchAtMs'], 3000)
            self.assertEqual(record['candidates'][1]['result'], 'exact')
            self.assertTrue(record['windowLimitsCandidateStartOnly'])

    def test_exact_fast_path_keeps_one_capture_and_no_wait_window_or_sleep(self):
        with tempfile.TemporaryDirectory() as directory:
            p = SamplingProbe(self, directory, frames=[{'global': True}])
            p.run()
            self.assertEqual((p.captures, p.source_checks, p.scopes), (1, 2, 2))
            self.assertEqual(p.clock.sleeps, [])
            self.assertIsNone(p.record()['firstMismatchAtMs'])
            self.assertEqual(p.references, [p.observation, p.observation])
            self.assertEqual(p.comparisons, [(0, 'global'), (0, 'keyboard'), (1, 'keyboard'), (1, 'global')])

    def test_slow_exact_fast_path_has_no_new_two_second_completion_deadline(self):
        def stage(p, name):
            if name in ('reference_exit', 'pixel_exit'):
                p.clock.now += 3
        with tempfile.TemporaryDirectory() as directory:
            p = SamplingProbe(self, directory, frames=[{'global': True}], stage_hook=stage)
            p.run()
            self.assertEqual(p.clock.now, 6)
            self.assertEqual(p.captures, 1)
            self.assertIsNone(p.record()['firstMismatchAtMs'])

    def test_admitted_late_candidate_may_finish_but_must_complete_all_checks(self):
        def stage(p, name):
            if p.current == 2 and name == 'capture':
                p.clock.now = 4
        with tempfile.TemporaryDirectory() as directory:
            p = SamplingProbe(self, directory, frames=[{'global': False}, {'global': True}], stage_hook=stage)
            p.run()
            self.assertEqual((p.captures, p.source_checks), (2, 4))
            self.assertEqual([name for candidate, name in p.events if candidate == 2][-5:],
                             ['source_after', 'pixel_start', 'keyboard_pixels', 'global_pixels', 'pixel_exit'])
            self.assertEqual(p.record()['candidates'][1]['completedAtMs'], 4000)

    def test_deadline_expired_after_mismatch_cannot_start_another_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            p = SamplingProbe(self, directory)
            p.clock.on_sleep = lambda clock: setattr(clock, 'now', 2)
            with self.assertRaisesRegex(MobileError, 'VISUAL_FRAME_CHANGED'):
                p.run()
            self.assertEqual((p.captures, p.source_checks), (1, 2))
            self.assertEqual(p.record()['stopReason'], 'candidate_window_expired')

    def test_repeated_mismatches_never_renew_window(self):
        def stage(p, name):
            if name == 'pixel_exit':
                p.clock.now = [0, 1.5, 2.5][min(p.current - 1, 2)]
        with tempfile.TemporaryDirectory() as directory:
            p = SamplingProbe(self, directory, stage_hook=stage)
            with self.assertRaisesRegex(MobileError, 'VISUAL_FRAME_CHANGED'):
                p.run()
            self.assertEqual((p.captures, p.source_checks), (3, 6))
            record = p.record()
            self.assertEqual(record['firstMismatchAtMs'], 0)
            self.assertEqual(record['stopReason'], 'candidate_window_expired')

    def test_six_frames_is_hard_limit_and_seventh_is_never_captured(self):
        with tempfile.TemporaryDirectory() as directory:
            p = SamplingProbe(self, directory, frames=[{'global': False}] * 6 + [{'global': True}])
            with self.assertRaisesRegex(MobileError, 'VISUAL_FRAME_CHANGED'):
                p.run()
            self.assertEqual((p.captures, p.source_checks, p.scopes), (6, 12, 7))
            self.assertEqual(len(p.record()['candidates']), 6)
            self.assertEqual(p.record()['stopReason'], 'maximum_candidates')

    def test_keyboard_pixels_still_short_circuit_global_and_caret(self):
        with tempfile.TemporaryDirectory() as directory:
            p = SamplingProbe(self, directory, frames=[{'keyboard': False}])
            p.config['keyboard']['caret'] = {}
            with self.assertRaisesRegex(MobileError, 'VISUAL_FRAME_CHANGED'):
                p.run()
            self.assertEqual(p.comparisons[2:], [(i, 'keyboard') for i in range(1, 7)])
            self.assertFalse(any(name == 'caret' for _, name in p.events))
            self.assertEqual({row['result'] for row in p.record()['candidates']}, {'keyboard_pixels_changed'})

    def test_approved_caret_uses_original_reference_and_unmasked_input_then_returns(self):
        with tempfile.TemporaryDirectory() as directory:
            p = SamplingProbe(self, directory, frames=[{'global': False}, {'global': False, 'caret': True}])
            p.config['keyboard']['caret'] = {}
            p.run()
            self.assertEqual(p.captures, 2)
            self.assertEqual(p.record()['candidates'][-1]['result'], 'caret_equivalent')
            self.assertEqual(len([1 for _, name in p.events if name == 'caret']), 2)

    def test_any_observation_error_stops_without_resampling_or_window(self):
        for stage, code in [('source_before', 'VISUAL_KEYBOARD_KEY_AMBIGUOUS'),
                            ('capture', 'WEBDRIVER_UNAVAILABLE'), ('geometry', 'VISUAL_COORDINATES_UNVERIFIED'),
                            ('source_after', 'VISUAL_KEYBOARD_LAYOUT_CHANGED'),
                            ('keyboard_pixels', 'VISUAL_PIXELS_UNAVAILABLE'), ('pixel_exit', 'VISUAL_PIXELS_UNAVAILABLE')]:
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as directory:
                def broken(p, name):
                    if name == stage:
                        raise MobileError(code)
                p = SamplingProbe(self, directory, frames=[{'global': True}], stage_hook=broken)
                with self.assertRaisesRegex(MobileError, code):
                    p.run()
                self.assertLessEqual(p.captures, 1)
                self.assertIsNone(p.record()['firstMismatchAtMs'])
                self.assertEqual(p.record()['stopReason'], code)

    def test_new_candidate_source_error_after_mismatch_does_not_become_another_wait(self):
        def stage(p, name):
            if name == 'source_before' and p.captures == 1:
                raise MobileError('VISUAL_KEYBOARD_NOT_VISIBLE')
        with tempfile.TemporaryDirectory() as directory:
            p = SamplingProbe(self, directory, stage_hook=stage)
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_NOT_VISIBLE'):
                p.run()
            self.assertEqual(p.captures, 1)
            self.assertEqual(p.record()['stopReason'], 'VISUAL_KEYBOARD_NOT_VISIBLE')

    def test_cancellation_or_total_budget_during_candidate_never_authorizes_or_retries(self):
        for stage in ('capture', 'pixel_exit'):
            for code in ('STOPPED', 'DURATION_BUDGET'):
                with self.subTest(stage=stage, code=code), tempfile.TemporaryDirectory() as directory:
                    def expire(p, name):
                        if name == stage:
                            if code == 'STOPPED':
                                p.session.budget.cancelled = True
                            else:
                                p.session.budget.started -= p.session.budget.duration / 1000
                    p = SamplingProbe(self, directory, frames=[{'global': True}], stage_hook=expire)
                    with self.assertRaisesRegex(MobileError, code):
                        p.run()
                    self.assertEqual(p.captures, 1)
                    self.assertEqual(p.session.budget.count, 0)
                    self.assertEqual(p.record()['stopReason'], code)

    def test_cancel_between_candidates_prevents_the_next_source_capture(self):
        with tempfile.TemporaryDirectory() as directory:
            p = SamplingProbe(self, directory)
            p.clock.on_sleep = lambda _: setattr(p.session.budget, 'cancelled', True)
            with self.assertRaisesRegex(MobileError, 'STOPPED'):
                p.run()
            self.assertEqual((p.captures, p.source_checks), (1, 2))

    def test_cancel_or_duration_during_trace_write_cannot_authorize_return(self):
        for code in ('STOPPED', 'DURATION_BUDGET'):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                p = SamplingProbe(self, directory, frames=[{'global': True}])
                original = keys.atomic_json
                def audit(path, record):
                    original(path, record)
                    if record['status'] == 'accepted':
                        if code == 'STOPPED':
                            p.session.budget.cancelled = True
                        else:
                            p.session.budget.started -= p.session.budget.duration / 1000
                with patch.object(keys, 'atomic_json', side_effect=audit), self.assertRaisesRegex(MobileError, code):
                    p.run()
                self.assertEqual((p.captures, p.source_checks, p.session.budget.count), (1, 2, 0))
                self.assertEqual(p.record()['status'], 'rejected')
                self.assertEqual(p.record()['stopReason'], code)

    def test_trace_is_bounded_and_contains_no_input_key_path_or_source_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            p = SamplingProbe(self, directory, frames=[{'global': True}])
            p.run()
            record = p.record()
            raw = json.dumps(record)
            for private in ('do-not-persist', '/private/', p.source['sourceSha256'], p.source['layout']):
                self.assertNotIn(private, raw)
            self.assertNotIn('name', record)
            self.assertEqual(record['maximumCandidates'], 6)
            self.assertEqual(record['uiActionRetried'], False)
            self.assertLess(len(raw), 8192)

    def test_unknown_exception_message_is_never_copied_to_trace(self):
        def broken(p, name):
            if name == 'capture':
                raise ValueError('/private/person/input=a')
        with tempfile.TemporaryDirectory() as directory:
            p = SamplingProbe(self, directory, stage_hook=broken)
            with self.assertRaisesRegex(ValueError, '/private/person'):
                p.run()
            record = p.record()
            self.assertEqual(record['stopReason'], 'OBSERVATION_ERROR')
            self.assertNotIn('/private/person', json.dumps(record))


class SamplingTraceFailureTests(unittest.TestCase):
    def test_initial_cancellation_remains_primary_when_trace_write_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            p = SamplingProbe(self, directory)
            p.session.budget.cancelled = True
            with patch.object(keys, 'atomic_json', side_effect=OSError('audit unavailable')), \
                    self.assertRaisesRegex(MobileError, 'STOPPED'):
                p.run()
            self.assertEqual((p.captures, p.source_checks, p.session.budget.count), (0, 0, 0))

    def test_observation_failure_object_survives_trace_write_failure(self):
        for stage, primary in [('source_before', MobileError('WEBDRIVER_COMMAND_FAILED')),
                               ('source_after', MobileError('VISUAL_KEYBOARD_LAYOUT_CHANGED')),
                               ('pixel_exit', MobileError('VISUAL_PIXELS_UNAVAILABLE'))]:
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as directory:
                def broken(_, name):
                    if name == stage:
                        raise primary
                p = SamplingProbe(self, directory, frames=[{'global': True}], stage_hook=broken)
                with patch.object(keys, 'atomic_json', side_effect=OSError('audit unavailable')), \
                        self.assertRaises(MobileError) as caught:
                    p.run()
                self.assertIs(caught.exception, primary)
                self.assertLessEqual(p.captures, 1)
                self.assertEqual(p.session.budget.count, 0)

    def test_rejected_pixels_remain_primary_when_trace_write_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            p = SamplingProbe(self, directory)
            with patch.object(keys, 'atomic_json', side_effect=OSError('audit unavailable')), \
                    self.assertRaisesRegex(MobileError, 'VISUAL_FRAME_CHANGED'):
                p.run()
            self.assertEqual((p.captures, p.source_checks, p.session.budget.count), (6, 12, 0))

    def test_accepted_candidate_cannot_return_after_first_trace_write_failure(self):
        for caller_error in (False, True):
            with self.subTest(caller_error=caller_error), tempfile.TemporaryDirectory() as directory:
                p = SamplingProbe(self, directory, frames=[{'global': True}])
                audit_error = OSError('audit unavailable')
                with patch.object(keys, 'atomic_json', side_effect=audit_error), \
                        self.assertRaises(OSError) as caught:
                    if caller_error:
                        try:
                            raise ValueError('unrelated caller exception context')
                        except ValueError:
                            p.run()
                    else:
                        p.run()
                self.assertIs(caught.exception, audit_error)
                self.assertEqual((p.captures, p.source_checks, p.session.budget.count), (1, 2, 0))

    def test_postwrite_budget_failure_survives_rejected_trace_rewrite_failure(self):
        for code in ('STOPPED', 'DURATION_BUDGET'):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                p = SamplingProbe(self, directory, frames=[{'global': True}])
                writes = []
                def audit(_, record):
                    writes.append(copy.deepcopy(record))
                    if len(writes) == 1:
                        if code == 'STOPPED':
                            p.session.budget.cancelled = True
                        else:
                            p.session.budget.started -= p.session.budget.duration / 1000
                    else:
                        raise OSError('audit unavailable')
                with patch.object(keys, 'atomic_json', side_effect=audit), \
                        self.assertRaisesRegex(MobileError, code):
                    p.run()
                self.assertEqual([row['status'] for row in writes], ['accepted', 'rejected'])
                self.assertEqual(writes[-1]['stopReason'], code)
                self.assertEqual((p.captures, p.source_checks, p.session.budget.count), (1, 2, 0))

    def test_base_interrupt_is_not_replaced_by_trace_storage_failure(self):
        primary = KeyboardInterrupt()
        def interrupted(_, name):
            if name == 'source_before':
                raise primary
        with tempfile.TemporaryDirectory() as directory:
            p = SamplingProbe(self, directory, stage_hook=interrupted)
            with patch.object(keys, 'atomic_json', side_effect=OSError('audit unavailable')), \
                    self.assertRaises(KeyboardInterrupt) as caught:
                p.run()
            self.assertIs(caught.exception, primary)
            self.assertEqual((p.captures, p.source_checks, p.session.budget.count), (0, 1, 0))


class SamplingWorkflowTests(unittest.TestCase):
    def test_delayed_pixel_recovery_keeps_the_single_physical_key_and_business_plan(self):
        with tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory) as h:
            h.value = ''
            clock, original = Clock(), h.capture
            def capture(*args):
                frame = original(*args)
                if len(h.captures) == 1:
                    clock.now = 3
                    frame['_valuePixels'] = 'transient-unapproved-input-pixels'
                return frame
            with patch.object(keys, 'time', clock), patch.object(keys, 'capture_locked', side_effect=capture):
                self.assertEqual(h.run('a'), {'text': 'RESULT a 1'})
            self.assertEqual(h.physical, ['a'])
            self.assertEqual(h.session.budget.count, 4)  # Focus, literal, Dismiss, submit, each once


class ArchivedFrameTests(unittest.TestCase):
    def test_current_two_fifteenth_fresh_pngs_remain_rejected_by_real_pixel_worker(self):
        root = Path(__file__).resolve().parents[2]
        report = root / 'output-vision-implementation/compiler16-ios-fifteenth-diagnosis.json'
        if not report.is_file() or not shutil.which('node'):
            self.skipTest('private stored-frame replay requires local evidence and existing Node')
        diagnosis = json.loads(report.read_text())
        run = Path(diagnosis['run'])
        config = json.loads((run / 'device.json').read_text())['nativeVisualWorkflow']
        config['node'] = shutil.which('node')
        definition = json.loads((run / 'approved-definition.json').read_text())
        gate = diagnosis['freshnessGate']
        reference = Path(gate['referenceImage']['path'])
        fresh = [Path(row['file']['path']) for row in gate['records']]
        for file in [reference, *fresh]:
            self.assertTrue(file.resolve().is_relative_to(root.resolve()))
        hashes = {file: hashlib.sha256(file.read_bytes()).hexdigest() for file in [reference, *fresh]}
        self.assertEqual(hashes[reference], gate['referenceImage']['sha256'])
        self.assertEqual([hashes[file] for file in fresh], [row['file']['sha256'] for row in gate['records']])
        raw = (run / 'source-response-1582.xml').read_text()
        budget = Budget({'maxActions': 50, 'maxDurationMs': 60000})
        backend = SimpleNamespace(app_id=json.loads((run / 'device.json').read_text())['backend']['appId'], foreground=lambda: budget.check())
        backend.request = lambda method, route: raw if (method, route) == ('GET', '/source') else self.fail('no live or UI request allowed')
        captured = []
        observation = {'width': 1398, 'height': 2034, '_imagePath': str(reference), 'imageSha256': hashes[reference]}
        clock = Clock()
        with tempfile.TemporaryDirectory() as directory:
            session = SimpleNamespace(budget=budget, backend=backend, output=Path(directory).resolve())
            source = keys.read_source(session, config, observation, (466, 678))
            def capture(*_):
                path = fresh[len(captured) % 2]
                captured.append(path)
                return {'width': 1398, 'height': 2034, 'imagePath': str(path), 'imageSha256': hashes[path]}
            with patch.object(keys, 'time', clock), patch.object(keys, 'capture_locked', side_effect=capture), \
                    patch.object(visual, '_geometry', return_value=(466, 678)):
                with self.assertRaisesRegex(MobileError, 'VISUAL_FRAME_CHANGED'):
                    keys._fresh_key(session, object(), config, definition, observation, (466, 678), source, 'e', True)
            self.assertEqual(len(captured), 6)
            self.assertEqual(budget.count, 0)
            self.assertEqual({file: hashlib.sha256(file.read_bytes()).hexdigest() for file in hashes}, hashes)
            record, = list((session.output / 'visual-private').glob('keyboard-key-sampling-*.json'))
            result = json.loads(record.read_text())
            self.assertEqual([row['result'] for row in result['candidates']], ['unapproved_pixels_changed'] * 6)
            self.assertEqual(result['stopReason'], 'maximum_candidates')


if __name__ == '__main__':
    unittest.main()
