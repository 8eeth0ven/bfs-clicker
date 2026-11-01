"""Mocked WDA/OCR sequencing plus actual local PNG fingerprint tests.

No iOS Simulator, WDA service, or real software keyboard is started here.
"""
import base64
import copy
import hashlib
import json
import shutil
import struct
import tempfile
import unittest
import zlib
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from apk_inventory import mobile_visual_ios_text as visual
from apk_inventory import mobile_visual_ios_keyboard as keyboard
from apk_inventory.mobile_ui import DeviceLease, MobileError, MobileSession, digest

DEF = {
    "kind": "native-visual-workflow", "schemaVersion": 1, "mode": "text-replace",
    "id": "query", "name": "keyboard fixture", "effect": "read", "inputName": "query",
    "inputSchema": {"type": "string", "minLength": 1, "maxLength": 16, "pattern": "^[A-Za-z0-9]+$"},
    "focusAnchor": "Query", "submitAnchor": "Search", "resultPrefix": "RESULT",
    "valueRegion": {"x": .4, "y": .1, "width": .5, "height": .1},
    "resultRegion": {"x": .1, "y": .6, "width": .8, "height": .1},
}
PLAN = {"enabled": True, "region": {"x": 0, "y": .5, "width": 1, "height": .5}, "dismissAnchor": "Dismiss"}
APP = "com.example.fixture"


def xml(visible=False, rect=(0, 100, 100, 100), keys=True, duplicate=False, app=APP):
    x, y, w, h = rect
    key = '<XCUIElementTypeKey type="XCUIElementTypeKey" visible="true" x="5" y="110" width="20" height="20"/>' if keys else ''
    node = f'<XCUIElementTypeKeyboard type="XCUIElementTypeKeyboard" visible="{str(visible).lower()}" x="{x}" y="{y}" width="{w}" height="{h}">{key}</XCUIElementTypeKeyboard>'
    return f'<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" bundleId="{app}">{node}{node if duplicate else ""}</XCUIElementTypeApplication></AppiumAUT>'


def session(directory, definition=None, plan=PLAN):
    definition = definition or DEF
    approved = Path(directory) / 'approved.json'
    approved.write_text(json.dumps(definition))
    return MobileSession({
        'source': {'id': 'ios_keyboard_fixture', 'kind': 'ios'},
        'backend': {'type': 'webdriver', 'platform': 'ios', 'appId': APP,
                    'url': 'http://127.0.0.1:1', 'sessionId': 'mocked-not-real'},
        'actionAllowlist': [],
        'nativeVisualWorkflow': {'enabled': True, 'node': shutil.which('node'), 'allowedWorkflows': ['query'],
                                 'approvedDefinitions': {'query': str(approved)},
                                 **({'keyboard': copy.deepcopy(plan)} if plan is not None else {})},
    }, Path(directory))


class Harness:
    def __init__(self, test, directory, **options):
        self.test, self.options = test, options
        self.definition = copy.deepcopy(options.get('definition', DEF))
        self.session = session(directory, self.definition, options.get('plan', PLAN))
        self.calls, self.observations, self.captures = [], [], []
        self.visible, self.value, self.result = False, 'old', 'RESULT NONE'
        self.phase, self.count, self.body = 0, 0, 'original'
        self.keyboard_pixels = 'restored-app-pixels'
        self.source_flipped = False
        self.source_reads = 0
        self.contradiction_reads = dict(options.get('preparationContradictionReads', {}))
        self.frames = 0
        self.backend = self.session.backend
        self.backend.foreground = lambda: None
        self.backend.verify_artifact = lambda: self.backend.artifact_verification
        self.backend.request = self.request

    def request(self, method, route, body=None):
        if route == '/orientation': return 'PORTRAIT'
        if route == '/window/rect': return {'x': 0, 'y': 0, 'width': 100, 'height': 200}
        if route == '/source':
            self.source_reads += 1
            if self.options.get('sourceError'): raise MobileError('WEBDRIVER_UNAVAILABLE', 'needs_device')
            key_calls = len([route for route, _ in self.calls if route == '/keys'])
            if self.phase == 1 and self.contradiction_reads.get(key_calls, 0):
                self.contradiction_reads[key_calls] -= 1
                return xml(True, (0, 205, 100, 100)).replace('x="5" y="110"', 'x="5" y="215"')
            if self.phase == 1 and key_calls == self.options.get('flipPreparationStage'):
                self.visible = not self.visible
            rect = (0, 90, 100, 110) if self.visible and self.options.get('wrongKeyboardRect') else (0, 100, 100, 100)
            if not self.visible and self.options.get('offscreenHiddenSource'):
                rect = (0, 205, 100, 100)
            if (self.options.get('flipHiddenSourceDuringPreparation') and not self.source_flipped
                    and self.phase == 1 and not self.visible and len([route for route, _ in self.calls if route == '/keys']) == 1):
                self.source_flipped = True
                raw = xml(False, rect, app=self.options.get('app', APP))
                self.visible = True
                return raw
            return xml(self.visible, rect, app=self.options.get('app', APP))
        if method == 'POST' and route in ('/actions', '/execute/sync', '/keys'):
            intent = json.loads((self.session.output / 'write-intent.json').read_text())
            self.test.assertEqual(intent, {'effect': self.definition['effect'], 'status': 'unknown', 'automaticRetry': False})
            self.test.assertTrue(self.session._visual_dispatched)
            self.calls.append((route, body))
            if route == self.options.get('failRoute'): raise MobileError('WEBDRIVER_COMMAND_UNSUPPORTED', 'unsupported')
            if route == '/actions':
                if self.phase == 0: self.visible, self.phase = not self.options.get('focusIgnored', False), 1
                elif self.phase == 1:
                    if not self.options.get('dismissIgnored'): self.visible = False
                    self.phase = 2
                    if self.options.get('restoredBodyChanged'): self.body = 'changed-lower-page'
                    if self.options.get('dismissChangesInput'): self.value = 'other'
                else:
                    self.count += 1
                    if not self.options.get('submitNoop'): self.result = f'RESULT {self.value} {self.count}'
                    self.phase = 0  # another sample refocuses after this submit
            elif route == '/execute/sync' and self.options.get('hardwareHidesKeyboard'):
                self.visible = False
            elif route == '/keys':
                text = ''.join(body['value'])
                if '\b' in text:
                    self.test.assertEqual(text, '\b' * self.definition['inputSchema']['maxLength'])
                    if not self.options.get('clearIgnored'): self.value = ''
                    if self.options.get('clearHidesKeyboard'): self.visible = False
                    if self.options.get('hiddenLayoutChange'): self.keyboard_pixels = 'changed-app-pixels'
                else:
                    if not self.options.get('inputIgnored'): self.value = text
                    if self.options.get('typeHidesKeyboard'): self.visible = False
                    if self.options.get('typeShowsKeyboard'): self.visible = True
                if self.options.get('autoUpdate'): self.result = 'RESULT ' + self.value + ' AUTO'
            return None
        raise AssertionError('unexpected route ' + route)

    def observation(self):
        self.frames += 1
        def token(text, x, y, w): return {'text': text, 'confidence': .99, 'bounds': {'x': x, 'y': y, 'width': w, 'height': 20}}
        tokens = [token('Query', 30, 65, 50), token('Search', 30, 215, 60), token('Dismiss', 150, 215, 75)]
        if self.value: tokens.append(token(self.value, 135, 65, 100))
        if self.visible:
            # OS return key duplicates the application submit word.
            tokens.append(token('Search', 215, 500, 60))
            tokens.append(token('Dismiss', 30, 500, 75))
        else:
            for index, word in enumerate(self.result.split()): tokens.append(token(word, 40 + index * 80, 370, 70))
        image = {'width': 300, 'height': 600, 'tokens': tokens, '_imagePath': f'mocked-{self.frames}.png',
                 'imageSha256': hashlib.sha256(str(self.frames).encode()).hexdigest(),
                 '_valuePixels': self.value, '_bodyPixels': self.body, '_caret': 'on', '_keyboardPixels': self.keyboard_pixels}
        self.observations.append(copy.deepcopy(image))
        return image

    def capture(self, *_):
        data = {'width': 300, 'height': 600, 'imagePath': 'mocked-fresh.png', '_valuePixels': self.value,
                '_bodyPixels': self.body, '_caret': 'on', '_keyboardPixels': self.keyboard_pixels, 'imageSha256': 'f' * 64}
        if self.options.get('lateInputChange'): data['_valuePixels'] = 'late-tamper'
        if self.options.get('lateBodyChange'): data['_bodyPixels'] = 'late-tamper'
        if self.options.get('caretMismatchOnce') and not self.captures: data['_caret'] = 'off'
        if not self.visible and self.phase == 1:
            if self.options.get('lateHiddenInputChange'): data['_valuePixels'] = 'changed-input'
            if self.options.get('lateHiddenKeyboardChange'): data['_keyboardPixels'] = 'changed-app-pixels'
            if self.options.get('hiddenCaretMismatch'): data['_caret'] = 'off'
        self.captures.append(copy.deepcopy(data))
        return data

    def masked(self, node, current, observation, masks):
        if len(masks) == 3: return 'b' * 64
        if PLAN['region'] in masks:
            payload = [observation['_valuePixels'], observation['_bodyPixels'], observation['_caret']]
            return hashlib.sha256(json.dumps(payload).encode()).hexdigest()
        if len(masks) == 1:
            payload = [observation['_valuePixels'], observation['_bodyPixels'], observation['_caret'], observation['_keyboardPixels']]
        else:
            payload = [observation['_bodyPixels'], observation['_keyboardPixels']]
        return hashlib.sha256(json.dumps(payload).encode()).hexdigest()

    def unchanged(self, *_):
        self.test.assertFalse(self.visible, 'legacy full-image stale guard may not silently run against an animated keyboard')
        if self.options.get('hiddenSubmitStale') and self.phase == 2: raise MobileError('VISUAL_FRAME_CHANGED')

    def __enter__(self):
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(visual, '_observe', side_effect=lambda *_: self.observation()))
        self.stack.enter_context(patch.object(visual.ios, '_masked', side_effect=self.masked))
        self.stack.enter_context(patch.object(keyboard, 'capture_locked', side_effect=self.capture))
        self.stack.enter_context(patch.object(visual, 'unchanged_locked', side_effect=self.unchanged))
        self.stack.enter_context(patch.object(visual.time, 'sleep'))
        return self

    def run(self, text='alpha', contracts=None):
        self.contracts = {} if contracts is None else contracts
        return visual._text_run(self.session, object(), self.session.config['nativeVisualWorkflow'], self.definition,
                                {'query': text}, self.contracts)

    def __exit__(self, *args): self.stack.__exit__(*args)


class ConfigurationTests(unittest.TestCase):
    def test_config_is_local_exact_opt_in_and_default_stays_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            current = session(directory)
            self.assertEqual(visual.config_contract(current, DEF, True)['keyboard'], PLAN)
            current.config['nativeVisualWorkflow']['keyboard']['region']['y'] = .6
            current.config['nativeVisualWorkflow']['keyboard']['region']['height'] = .4
            self.assertEqual(visual.config_contract(current, DEF, True)['keyboard']['region']['y'], .6)
            # A changed config changes MobileSession identity, even though it is
            # absent from the caller-controlled workflow parameters.
            self.assertNotEqual(current.identity, session(directory, plan=current.config['nativeVisualWorkflow']['keyboard']).identity)
            absent = session(directory, plan=None)
            self.assertNotIn('keyboard', visual.config_contract(absent, DEF, True))

    def test_invalid_rectangles_names_fields_and_input_occlusion_rejected(self):
        for plan in ({**PLAN, 'enabled': False}, {**PLAN, 'dismissAnchor': 'Search'}, {**PLAN, 'surprise': True},
                     {**PLAN, 'region': {'x': .1, 'y': .5, 'width': .9, 'height': .5}},
                     {**PLAN, 'region': {'x': 0, 'y': .2, 'width': 1, 'height': .8}},
                     {**PLAN, 'region': {'x': 0, 'y': .5, 'width': 1, 'height': .3}}):
            with self.subTest(plan=plan), self.assertRaises(MobileError): keyboard.keyboard_contract(plan, DEF)
        with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_OCCLUDES_INPUT'):
            keyboard.keyboard_contract(PLAN, {**DEF, 'valueRegion': {'x': .2, 'y': .4, 'width': .5, 'height': .2}})

    def test_actual_ios_home_indicator_gap_is_not_added_to_the_approved_mask(self):
        # Geometry observed by the parent in the real iOS27.1 calibration:
        # Keyboard y=418,h=245 in a 466x678-point viewport, leaving 15 points.
        region = {'x': 0, 'y': 418 / 678, 'width': 1, 'height': 245 / 678}
        plan = {**PLAN, 'region': region}
        self.assertIs(keyboard.keyboard_contract(plan, DEF), plan)
        actual = keyboard.inspect_source(xml(True, rect=(0, 418, 466, 245)).replace('x="5" y="110"', 'x="5" y="430"'), (466, 678), APP)
        self.assertEqual(actual['region'], region)
        self.assertLess(region['y'] + region['height'], 1)
        for other in ({'x': 0, 'y': .55, 'width': 1, 'height': .35},
                      {'x': .1, 'y': .55, 'width': .8, 'height': .4}):
            with self.subTest(region=other), self.assertRaises(MobileError):
                keyboard.keyboard_contract({**PLAN, 'region': other}, DEF)

    def test_visual_envelope_requires_explicit_source_region_and_bounded_padding(self):
        source = {'x': 0, 'y': 418 / 678, 'width': 1, 'height': 245 / 678}
        envelope = {'x': 0, 'y': 412 / 678, 'width': 1, 'height': 266 / 678}
        plan = {**PLAN, 'region': envelope, 'sourceRegion': source}
        self.assertIs(keyboard.keyboard_contract(plan, DEF), plan)
        backend = SimpleNamespace(app_id=APP, foreground=lambda: None,
                                  request=lambda *_: xml(True, rect=(0, 418, 466, 245)).replace('x="5" y="110"', 'x="5" y="430"'))
        current = SimpleNamespace(backend=backend)
        observation = {'width': 1398, 'height': 2034}
        self.assertEqual(keyboard.keyboard_state(current, plan, observation, (466, 678), True), source)
        # Approving only a visual rectangle does not silently authorize a
        # different source rectangle or vice versa.
        with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_REGION_MISMATCH'):
            keyboard.keyboard_state(current, {**PLAN, 'region': envelope}, observation, (466, 678), True)
        for rect in ({'x': 0, 'y': .55, 'width': 1, 'height': .45},
                     {'x': 0, 'y': .63, 'width': 1, 'height': .37}):
            with self.subTest(rect=rect), self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_PADDING_INVALID'):
                keyboard.keyboard_contract({**plan, 'region': rect}, DEF)

    def test_padding_logical_point_caps_apply_in_addition_to_normalized_caps(self):
        for source_y, source_h, envelope_y in ((600, 385, 585), (600, 370, 600)):
            source = {'x': 0, 'y': source_y / 1000, 'width': 1, 'height': source_h / 1000}
            envelope = {'x': 0, 'y': envelope_y / 1000, 'width': 1, 'height': 1 - envelope_y / 1000}
            plan = {**PLAN, 'region': envelope, 'sourceRegion': source}
            keyboard.keyboard_contract(plan, DEF)
            backend = SimpleNamespace(app_id=APP, foreground=lambda: None,
                                      request=lambda *_: xml(True, rect=(0, source_y, 100, source_h)).replace('x="5" y="110"', 'x="5" y="610"'))
            with self.subTest(source=source), self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_PADDING_INVALID'):
                keyboard.keyboard_state(SimpleNamespace(backend=backend), plan, {'width': 300, 'height': 3000}, (100, 1000), True)

    def test_write_learning_and_execution_grants_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            definition = {**DEF, 'effect': 'write'}
            current = session(directory, definition)
            with self.assertRaisesRegex(MobileError, 'WORKFLOW_WRITE_NOT_APPROVED'): visual.config_contract(current, definition, True)


class HierarchyTests(unittest.TestCase):
    def test_hidden_keyboard_may_be_offscreen_but_its_geometry_must_be_finite(self):
        self.assertIsNone(keyboard.inspect_source(xml(False, rect=(0, 205, 100, 100)), (100, 200), APP))
        with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED'):
            keyboard.inspect_source(xml(False, rect=(0, 205, 100, float('nan'))), (100, 200), APP)

    def test_inspection_is_only_a_geometry_proposal(self):
        self.assertIsNone(keyboard.inspect_source(xml(False), (100, 200), APP))
        self.assertEqual(keyboard.inspect_source(xml(True), (100, 200), APP), {'region': PLAN['region'], 'keyCount': 1})

    def test_bad_source_bounds_duplicate_or_missing_keys_and_wrong_app_fail(self):
        for raw in ('<!DOCTYPE a><a/>', '<broken>', '\ud800', xml(True, duplicate=True), xml(True, keys=False),
                    xml(True, rect=(0, 100, 100, float('nan'))), xml(True, rect=(0, 100, 100, 101)), xml(True, app='other'),
                    xml(True).replace('bundleId="'+APP+'"', ''), xml(True).replace('visible="true"', 'visible="maybe"', 1)):
            with self.subTest(raw=raw[:100]), self.assertRaises(MobileError): keyboard.inspect_source(raw, (100, 200), APP)

    def test_source_resource_limits_and_key_containment(self):
        nested = '<AppiumAUT><XCUIElementTypeApplication bundleId="'+APP+'">' + '<a>' * 66 + '</a>' * 66 + '</XCUIElementTypeApplication></AppiumAUT>'
        with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_SOURCE_LIMIT'): keyboard.inspect_source(nested, (100, 200), APP)
        with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_KEYS_UNVERIFIED'):
            keyboard.inspect_source(xml(True).replace('x="5" y="110"', 'x="105" y="110"'), (100, 200), APP)


class SourceStabilizationTests(unittest.TestCase):
    def below(self, **options):
        return xml(True, rect=(0, 205, 100, 100), **options).replace('x="5" y="110"', 'x="5" y="215"')

    def run_sources(self, directory, sources, budget=None, foreground=None):
        current = session(directory)
        current.backend.request = lambda method, route: self._source_call(method, route, sources)
        current.backend.foreground = foreground or (lambda: None)
        if budget is not None:
            current.budget = budget
        self.source_count = 0
        self.current = current
        return keyboard.keyboard_state(current, PLAN, {'width': 300, 'height': 600}, (100, 200), None, stabilize=True)

    def _source_call(self, method, route, sources):
        self.assertEqual((method, route), ('GET', '/source'))
        value = sources[self.source_count] if self.source_count < len(sources) else sources[-1]
        self.source_count += 1
        return value

    def diagnostics(self, directory):
        return [json.loads(path.read_text()) for path in (Path(directory) / 'visual-private').glob('keyboard-source-stabilization-*.json')]

    def test_contradiction_requires_new_hidden_or_valid_visible_evidence(self):
        for final, expected in ((xml(False, rect=(0, 205, 100, 100)), None), (xml(True), PLAN['region'])):
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as directory, patch.object(keyboard.time, 'sleep'):
                self.assertEqual(self.run_sources(directory, [self.below(), final]), expected)
                self.assertEqual(self.source_count, 2)
                record, = self.diagnostics(directory)
                self.assertEqual(record['sourceReads'], 2)
                self.assertEqual(record['contradictions'], 1)
                self.assertEqual(record['status'], 'observed_hidden' if expected is None else 'observed_visible')
                self.assertFalse(record['uiActionRetried'])
                self.assertFalse(record['offscreenVisibleAcceptedAsHidden'])

    def test_persistent_contradiction_stops_at_three_reads(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(keyboard.time, 'sleep'):
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED'):
                self.run_sources(directory, [self.below()])
            self.assertEqual(self.source_count, 3)
            record, = self.diagnostics(directory)
            self.assertEqual((record['sourceReads'], record['contradictions'], record['status']), (3, 3, 'rejected'))

    def test_consistent_evidence_can_arrive_on_the_third_and_final_read(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(keyboard.time, 'sleep'):
            self.assertIsNone(self.run_sources(directory, [self.below(), self.below(), xml(False)]))
            self.assertEqual(self.source_count, 3)
            record, = self.diagnostics(directory)
            self.assertEqual((record['sourceReads'], record['contradictions'], record['status']), (3, 2, 'observed_hidden'))

    def test_other_invalid_snapshots_never_trigger_a_retry(self):
        bad_key = self.below().replace('x="5" y="215"', 'x="105" y="215"')
        partial = xml(True, rect=(0, 190, 100, 100)).replace('x="5" y="110"', 'x="5" y="195"')
        duplicate_hidden = self.below().replace('</XCUIElementTypeApplication>',
            '<XCUIElementTypeKeyboard visible="false" x="0" y="205" width="100" height="100"/></XCUIElementTypeApplication>')
        cases = ((bad_key, 'VISUAL_KEYBOARD_KEYS_UNVERIFIED'),
                 (partial, 'VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED'),
                 (self.below(keys=False), 'VISUAL_KEYBOARD_KEYS_UNVERIFIED'),
                 (self.below(duplicate=True), 'VISUAL_KEYBOARD_AMBIGUOUS'),
                 (duplicate_hidden, 'VISUAL_KEYBOARD_AMBIGUOUS'),
                 (self.below(app='other.app'), 'VISUAL_KEYBOARD_APP_UNVERIFIED'),
                 (self.below().replace('width="100"', 'width="101"', 1), 'VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED'),
                 (self.below().replace('width="100"', 'width="90"', 1), 'VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED'),
                 (self.below().replace('height="100"', 'height="300"', 1), 'VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED'),
                 ('<broken>', 'VISUAL_KEYBOARD_SOURCE_INVALID'))
        for raw, code in cases:
            with self.subTest(code=code, raw=raw[:100]), tempfile.TemporaryDirectory() as directory:
                with self.assertRaisesRegex(MobileError, code):
                    self.run_sources(directory, [raw, xml(False)])
                self.assertEqual(self.source_count, 1)
                self.assertEqual(self.diagnostics(directory), [])

    def test_foreground_switch_during_contradiction_stops_before_another_read(self):
        calls = []
        def foreground():
            calls.append(1)
            if len(calls) == 2:
                raise MobileError('APP_OUT_OF_SCOPE', 'blocked')
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(MobileError, 'APP_OUT_OF_SCOPE'):
                self.run_sources(directory, [self.below(), xml(False)], foreground=foreground)
            self.assertEqual(self.source_count, 1)
            record, = self.diagnostics(directory)
            self.assertEqual(record['status'], 'rejected')

    def test_new_invalid_source_during_stabilization_is_not_retried(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(keyboard.time, 'sleep'):
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_SOURCE_INVALID'):
                self.run_sources(directory, [self.below(), '<broken>', xml(False)])
            self.assertEqual(self.source_count, 2)
            record, = self.diagnostics(directory)
            self.assertEqual((record['sourceReads'], record['contradictions'], record['status']), (2, 1, 'rejected'))

    def test_nominal_deadline_prevents_starting_another_source_request(self):
        for expire_after in (2, 3):
            now, calls = [0], []
            def foreground():
                calls.append(1)
                if len(calls) == expire_after:
                    now[0] = 3
            clock = SimpleNamespace(monotonic=lambda: now[0], sleep=lambda *_: None)
            with self.subTest(expire_after=expire_after), tempfile.TemporaryDirectory() as directory, patch.object(keyboard, 'time', clock):
                budget = SimpleNamespace(check=lambda: None, timeout=lambda: 10)
                with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED'):
                    self.run_sources(directory, [self.below(), xml(False)], budget=budget, foreground=foreground)
                self.assertEqual(self.source_count, 1)

    def test_deadline_expiring_during_foreground_check_prevents_the_next_source_read(self):
        now, foreground_calls = [0], []
        def foreground():
            foreground_calls.append(1)
            if len(foreground_calls) == 3:
                now[0] = 3
        clock = SimpleNamespace(monotonic=lambda: now[0], sleep=lambda *_: None)
        budget = SimpleNamespace(check=lambda: None, timeout=lambda: 10)
        with tempfile.TemporaryDirectory() as directory, patch.object(keyboard, 'time', clock):
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED'):
                self.run_sources(directory, [self.below(), xml(False)], budget=budget, foreground=foreground)
            self.assertEqual(self.source_count, 1)

    def test_overall_duration_budget_failure_does_not_sample_again(self):
        calls = []
        def check():
            calls.append(1)
            if len(calls) == 3:
                raise MobileError('DURATION_BUDGET', 'partial')
        budget = SimpleNamespace(check=check, timeout=lambda: 10)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(MobileError, 'DURATION_BUDGET'):
                self.run_sources(directory, [self.below(), xml(False)], budget=budget)
            self.assertEqual(self.source_count, 1)

    def test_initial_focus_and_later_strict_observations_do_not_stabilize(self):
        for visible in (True, None, False):
            with self.subTest(visible=visible), tempfile.TemporaryDirectory() as directory:
                current = session(directory)
                reads = []
                current.backend.foreground = lambda: None
                def request(*args):
                    reads.append(args)
                    return self.below()
                current.backend.request = request
                code = 'VISUAL_KEYBOARD_NOT_HIDDEN' if visible is False else 'VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED'
                with self.assertRaisesRegex(MobileError, code):
                    keyboard.keyboard_state(current, PLAN, {'width': 300, 'height': 600}, (100, 200), visible)
                self.assertEqual(len(reads), 1)


class PreparationPairTests(unittest.TestCase):
    def below(self):
        return xml(True, rect=(0, 205, 100, 100)).replace('x="5" y="110"', 'x="5" y="215"')

    def run_pair(self, directory, sources, on_observe=None, on_source=None, geometry_error=None):
        current = session(directory)
        self.current, self.source_count, self.observed = current, 0, []
        current.backend.foreground = lambda: None
        def request(method, route):
            self.assertEqual((method, route), ('GET', '/source'))
            value = sources[min(self.source_count, len(sources) - 1)]
            self.source_count += 1
            if on_source is not None:
                on_source(self.source_count)
            return value
        current.backend.request = request
        def observe(actual, lease, config):
            self.assertIs(actual, current)
            observation = {'width': 300, 'height': 600, 'tokens': [],
                           '_imagePath': 'mocked-new-frame-' + str(len(self.observed) + 1),
                           'imageSha256': hashlib.sha256(str(len(self.observed)).encode()).hexdigest()}
            self.observed.append(observation)
            if on_observe is not None:
                on_observe(len(self.observed), current)
            return observation
        with patch.object(visual, '_observe', side_effect=observe), \
                patch.object(visual, '_geometry', side_effect=geometry_error, return_value=(100, 200)):
            return keyboard._prepare_observe(current, object(), current.config['nativeVisualWorkflow'],
                                             (100, 200), {'width': 300, 'height': 600})

    def diagnostics(self, directory):
        return [json.loads(path.read_text()) for path in (Path(directory) / 'visual-private').glob('keyboard-pair-stabilization-*.json')]

    def test_legal_phase_flip_requires_a_complete_new_pair_in_either_direction(self):
        for before, after in ((False, True), (True, False)):
            with self.subTest(before=before), tempfile.TemporaryDirectory() as directory:
                result, geometry, visible = self.run_pair(directory, [xml(before), xml(after), xml(after), xml(after)])
                self.assertIs(result, self.observed[1])
                self.assertIsNot(result, self.observed[0])
                self.assertEqual((geometry, visible, self.source_count, len(self.observed)), ((100, 200), after, 4, 2))
                self.assertEqual(self.current.budget.count, 0)
                record, = self.diagnostics(directory)
                self.assertEqual((record['pairs'], record['sourceReads'], record['completedObservations'], record['phaseMismatches']), (2, 4, 2, 1))
                self.assertFalse(record['uiActionRetried'])
                self.assertFalse(record['discardedFrameReused'])

    def test_stable_first_pair_does_not_open_a_retry_window(self):
        for visible in (False, True):
            with self.subTest(visible=visible), tempfile.TemporaryDirectory() as directory:
                result = self.run_pair(directory, [xml(visible)])
                self.assertIs(result[0], self.observed[0])
                self.assertEqual((self.source_count, len(self.observed)), (2, 1))
                self.assertEqual(self.diagnostics(directory), [])

    def test_third_pair_is_the_last_opportunity_for_consistent_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_pair(directory, [xml(False), xml(True), xml(True), xml(False), xml(True), xml(True)])
            self.assertIs(result[0], self.observed[2])
            self.assertEqual((self.source_count, len(self.observed)), (6, 3))
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_PHASE_UNSTABLE'):
                self.run_pair(directory, [xml(False), xml(True)] * 3)
            self.assertEqual((self.source_count, len(self.observed)), (6, 3))
            record, = self.diagnostics(directory)
            self.assertEqual((record['pairs'], record['phaseMismatches'], record['status']), (3, 3, 'rejected'))

    def test_below_sampler_and_pair_retries_have_a_shared_twelve_source_ceiling(self):
        clock = SimpleNamespace(monotonic=lambda: 0, sleep=lambda *_: None)
        with tempfile.TemporaryDirectory() as directory, patch.object(keyboard, 'time', clock):
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_PHASE_UNSTABLE'):
                self.run_pair(directory, [self.below(), self.below(), xml(True), xml(False)] * 3)
            self.assertEqual((self.source_count, len(self.observed)), (12, 3))
            record, = self.diagnostics(directory)
            self.assertEqual((record['sourceReads'], record['firstInstability']), (12, 'below_visible_source'))

    def test_invalid_xml_app_keys_geometry_region_or_unique_owner_on_either_end_is_not_retried(self):
        duplicate_hidden = xml(False).replace('</XCUIElementTypeApplication>',
            '<XCUIElementTypeKeyboard visible="false" x="0" y="205" width="100" height="100"/></XCUIElementTypeApplication>')
        cases = [('<broken>', 'VISUAL_KEYBOARD_SOURCE_INVALID'), (xml(True, app='other.app'), 'VISUAL_KEYBOARD_APP_UNVERIFIED'),
                 (xml(True, duplicate=True), 'VISUAL_KEYBOARD_AMBIGUOUS'), (duplicate_hidden, 'VISUAL_KEYBOARD_AMBIGUOUS'),
                 (xml(True, keys=False), 'VISUAL_KEYBOARD_KEYS_UNVERIFIED'),
                 (xml(True).replace('x="5" y="110"', 'x="105" y="110"'), 'VISUAL_KEYBOARD_KEYS_UNVERIFIED'),
                 (xml(True, rect=(0, 190, 100, 100)).replace('y="110"', 'y="195"'), 'VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED'),
                 (xml(True, rect=(0, 100, 100, float('nan'))), 'VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED'),
                 (xml(True, rect=(0, 90, 100, 110)), 'VISUAL_KEYBOARD_REGION_MISMATCH')]
        for raw, code in cases:
            for endpoint in (0, 1):
                values = [raw] if endpoint == 0 else [xml(False), raw]
                with self.subTest(code=code, endpoint=endpoint), tempfile.TemporaryDirectory() as directory:
                    with self.assertRaisesRegex(MobileError, code):
                        self.run_pair(directory, values)
                    self.assertEqual((self.source_count, len(self.observed)), (endpoint + 1, endpoint))

    def test_after_source_below_visible_is_not_reclassified_or_sampled_again(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED'):
                self.run_pair(directory, [xml(False), self.below(), xml(False), xml(False)])
            self.assertEqual((self.source_count, len(self.observed)), (2, 1))

    def test_geometry_or_ocr_failures_do_not_start_another_pair_and_restore_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(MobileError, 'VISUAL_COORDINATES_UNVERIFIED'):
                self.run_pair(directory, [xml(False)], geometry_error=MobileError('VISUAL_COORDINATES_UNVERIFIED'))
            self.assertEqual((self.source_count, len(self.observed)), (1, 1))
            self.assertIs(self.current.budget, self.current.backend.budget)
        def broken(index, current):
            raise MobileError('VISUAL_OCR_FAILED')
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(MobileError, 'VISUAL_OCR_FAILED'):
                self.run_pair(directory, [xml(False)], on_observe=broken)
            self.assertEqual((self.source_count, len(self.observed)), (1, 1))
            self.assertIs(self.current.budget, self.current.backend.budget)
            self.assertFalse(hasattr(self.current, '_preparation_observing'))

    def test_window_starts_at_first_mismatch_and_is_not_renewed_by_later_pairs(self):
        now = [0]
        clock = SimpleNamespace(monotonic=lambda: now[0], sleep=lambda *_: None)
        def delayed_observe(index, current):
            now[0] = 5 if index == 1 else 8
        with tempfile.TemporaryDirectory() as directory, patch.object(keyboard, 'time', clock):
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_PHASE_UNSTABLE'):
                self.run_pair(directory, [xml(False), xml(True), xml(True)], on_observe=delayed_observe)
            # The ordinary first pair can exceed two seconds. Its mismatch at
            # t=5 permits a new pair, but not a new source after that OCR at t=8.
            self.assertEqual((self.source_count, len(self.observed)), (3, 2))

    def test_earlier_below_deadline_cannot_be_reset_by_later_phase_mismatch(self):
        now = [0]
        clock = SimpleNamespace(monotonic=lambda: now[0], sleep=lambda *_: None)
        def source_time(index):
            if index == 3:
                now[0] = 1.5
        def observe_time(index, current):
            if index == 2:
                now[0] = 2.1
        with tempfile.TemporaryDirectory() as directory, patch.object(keyboard, 'time', clock):
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_PHASE_UNSTABLE'):
                self.run_pair(directory, [self.below(), xml(False), xml(True), xml(True)],
                              on_source=source_time, on_observe=observe_time)
            self.assertEqual((self.source_count, len(self.observed)), (4, 2))
            record, = self.diagnostics(directory)
            self.assertEqual(record['firstInstability'], 'below_visible_source')

    def test_deadline_exhausted_by_first_below_source_does_not_open_pair_window(self):
        now, foreground_calls = [0], []
        with tempfile.TemporaryDirectory() as directory, patch.object(keyboard, 'time', SimpleNamespace(monotonic=lambda: now[0], sleep=lambda *_: None)):
            current = session(directory)
            def foreground():
                foreground_calls.append(1)
                if len(foreground_calls) == 2:
                    now[0] = 3
            current.backend.foreground = foreground
            current.backend.request = lambda *_: self.below()
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED'), patch.object(visual, '_observe') as observe:
                keyboard._prepare_observe(current, object(), current.config['nativeVisualWorkflow'], (100, 200), {'width': 300, 'height': 600})
            observe.assert_not_called()


class ObservationBudgetTests(unittest.TestCase):
    def real_observer(self, directory, now, *, capture_crosses=False, ocr_crosses=False):
        from apk_inventory import mobile_visual_workflow as workflow
        from apk_inventory.mobile_visual import capture_locked as real_capture
        directory = Path(directory).resolve()
        current = session(directory)
        original = current.budget
        lease = DeviceLease(current.backend)
        lease.stream = SimpleNamespace(closed=False)
        sampling = keyboard._preparation_sampling()
        keyboard._sampling_unstable(sampling, 'phase_mismatch')
        image = png(directory / 'capture-fixture.png')
        encoded = base64.b64encode(Path(image['_imagePath']).read_bytes()).decode()
        current.backend.foreground = lambda: None
        def screenshot(method, route, body=None):
            self.assertEqual((method, route), ('GET', '/screenshot'))
            self.assertIs(current.backend.budget, original)
            self.assertFalse(current.budget.ocr_started)
            return encoded
        current.backend.request = screenshot
        captured = {}
        def capture(actual, output, owned):
            self.assertIs(actual, current)
            self.assertIs(owned, lease)
            self.assertIs(current.backend.budget, original)
            self.assertIsNot(current.budget, original)
            self.assertFalse(current.budget.ocr_started, 'capture must not consume the OCR timeout start check')
            captured.update(real_capture(actual, output, owned))
            self.assertFalse(current.budget.ocr_started, 'real iOS capture must not ask session budget for an OCR timeout')
            now[0] = 3 if capture_crosses else .1
            return captured
        child = SimpleNamespace(returncode=0, poll=lambda: 0, wait=lambda: 0)
        def communicate(**kwargs):
            self.assertIs(current.backend.budget, original)
            current.budget.check()
            current.budget.timeout()
            return json.dumps({key: captured[key] for key in ('width', 'height', 'imageSha256')}).encode(), b''
        child.communicate = communicate
        def start(*args, **kwargs):
            self.assertTrue(current.budget.ocr_started)
            if ocr_crosses:
                now[0] = 3
            return child
        self.current, self.original, self.sampling, self.captured = current, original, sampling, captured
        with patch.object(workflow, 'capture_locked', side_effect=capture) as capture_call, \
                patch.object(workflow.subprocess, 'Popen', side_effect=start) as popen:
            self.capture_call, self.popen = capture_call, popen
            return keyboard._preparation_observation(current, lease, current.config['nativeVisualWorkflow'], sampling)

    def test_actual_shared_observer_capture_crossing_deadline_never_starts_ocr(self):
        now = [0]
        with tempfile.TemporaryDirectory() as directory, patch.object(keyboard, 'time', SimpleNamespace(monotonic=lambda: now[0])):
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_PHASE_UNSTABLE'):
                self.real_observer(directory, now, capture_crosses=True)
            self.assertEqual((self.capture_call.call_count, self.popen.call_count), (1, 0))
            self.assertEqual(self.sampling['ocrStartChecks'], 0)
            self.assertIs(self.current.budget, self.original)
            self.assertEqual(self.original.count, 0)

    def test_started_ocr_may_finish_after_nominal_window_under_original_budget(self):
        now = [0]
        with tempfile.TemporaryDirectory() as directory, patch.object(keyboard, 'time', SimpleNamespace(monotonic=lambda: now[0])):
            observation = self.real_observer(directory, now, ocr_crosses=True)
            self.assertEqual(observation['imageSha256'], self.captured['imageSha256'])
            self.assertEqual((self.capture_call.call_count, self.popen.call_count), (1, 1))
            self.assertEqual((self.sampling['ocrStartChecks'], self.sampling['completedObservations']), (1, 1))
            self.assertIs(self.current.budget, self.original)
            self.assertIs(self.current.backend.budget, self.original)
            self.assertEqual(self.original.count, 0)

    def test_expired_window_starts_neither_capture_nor_ocr(self):
        now = [3]
        with tempfile.TemporaryDirectory() as directory, patch.object(keyboard, 'time', SimpleNamespace(monotonic=lambda: now[0])):
            current = session(directory)
            sampling = keyboard._preparation_sampling()
            sampling['deadline'] = 2
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_PHASE_UNSTABLE'), patch.object(visual, '_observe') as observe:
                keyboard._preparation_observation(current, object(), current.config['nativeVisualWorkflow'], sampling)
            observe.assert_not_called()
            self.assertIs(current.budget, current.backend.budget)

    def test_proxy_delegates_budget_counters_methods_and_always_restores_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            current = session(directory)
            original = current.budget
            def broken(actual, owned, config):
                self.assertIs(current.backend.budget, original)
                self.assertEqual(current.budget.max_actions, original.max_actions)
                current.budget.action()
                self.assertEqual(current.budget.count, 1)
                raise MobileError('VISUAL_OCR_FAILED')
            with patch.object(visual, '_observe', side_effect=broken), self.assertRaisesRegex(MobileError, 'VISUAL_OCR_FAILED'):
                keyboard._preparation_observation(current, object(), current.config['nativeVisualWorkflow'], keyboard._preparation_sampling())
            self.assertIs(current.budget, original)
            self.assertEqual(original.count, 1)
            self.assertFalse(hasattr(current, '_preparation_observing'))

    def test_wrong_backend_budget_or_nested_observation_is_rejected_before_capture(self):
        for nested in (False, True):
            with self.subTest(nested=nested), tempfile.TemporaryDirectory() as directory:
                current = session(directory)
                if nested:
                    current._preparation_observing = True
                else:
                    current.backend.budget = object()
                with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_SOURCE_INVALID'), patch.object(visual, '_observe') as observe:
                    keyboard._preparation_observation(current, object(), current.config['nativeVisualWorkflow'], keyboard._preparation_sampling())
                observe.assert_not_called()


class SequenceTests(unittest.TestCase):
    def test_persistent_clear_or_type_phase_mismatch_stays_unknown_without_repeating_ui_actions(self):
        for stage in (1, 2):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as directory, Harness(self, directory, flipPreparationStage=stage) as h:
                with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_PHASE_UNSTABLE') as caught:
                    h.run()
                self.assertEqual([route for route, _ in h.calls], ['/actions'] + ['/keys'] * stage)
                self.assertEqual(h.session.budget.count, stage + 1)
                self.assertEqual(caught.exception.writeOutcome, {'status': 'unknown', 'automaticRetry': False})
                record, = PreparationPairTests().diagnostics(directory)
                self.assertEqual((record['pairs'], record['sourceReads'], record['completedObservations']), (3, 6, 3))

    def test_clear_and_type_contradictions_only_add_read_only_samples(self):
        for hidden in (False, True):
            with self.subTest(hidden=hidden), tempfile.TemporaryDirectory() as directory, \
                    Harness(self, directory, clearHidesKeyboard=hidden, preparationContradictionReads={1: 1, 2: 1}) as h:
                self.assertEqual(h.run(), {'text': 'RESULT alpha 1'})
                self.assertEqual([route for route, _ in h.calls], ['/actions', '/keys', '/keys', '/actions', '/actions'])
                self.assertEqual(h.session.budget.count, 5)
                records = SourceStabilizationTests().diagnostics(directory)
                self.assertEqual([record['sourceReads'] for record in records], [2, 2])

    def test_persistent_clear_contradiction_remains_unknown_without_typing_retry_or_dismiss(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory, preparationContradictionReads={1: 9}) as h:
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED') as caught:
                h.run()
            self.assertEqual([route for route, _ in h.calls], ['/actions', '/keys'])
            self.assertEqual(h.session.budget.count, 2)
            self.assertEqual(caught.exception.writeOutcome, {'status': 'unknown', 'automaticRetry': False})
            record, = SourceStabilizationTests().diagnostics(directory)
            self.assertEqual(record['sourceReads'], 3)

    def test_clear_or_type_can_hide_keyboard_without_repeating_any_action_or_skipping_dismiss(self):
        for options in ({'clearHidesKeyboard': True}, {'typeHidesKeyboard': True},
                        {'clearHidesKeyboard': True, 'typeShowsKeyboard': True}):
            with self.subTest(options=options), tempfile.TemporaryDirectory() as directory, Harness(self, directory, offscreenHiddenSource=True, **options) as h:
                self.assertEqual(h.run(), {'text': 'RESULT alpha 1'})
                self.assertEqual([route for route, _ in h.calls], ['/actions', '/keys', '/keys', '/actions', '/actions'])
                self.assertEqual([body for route, body in h.calls if route == '/keys'], [{'value': ['\b' * 16]}, {'value': ['alpha']}])
                targets = [body['actions'][0]['actions'][0]['x'] for route, body in h.calls if route == '/actions']
                self.assertEqual(targets, [18, 62, 20])

    def test_first_focus_still_requires_a_real_visible_keyboard(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory, focusIgnored=True) as h:
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_NOT_VISIBLE'):
                h.run()
            self.assertEqual([route for route, _ in h.calls], ['/actions'])

    def test_hidden_preparation_rejects_original_keyboard_area_or_input_changes(self):
        for options in ({'lateHiddenInputChange': True}, {'lateHiddenKeyboardChange': True}):
            with self.subTest(options=options), tempfile.TemporaryDirectory() as directory, Harness(self, directory, clearHidesKeyboard=True, **options) as h:
                with self.assertRaisesRegex(MobileError, 'VISUAL_FRAME_CHANGED') as caught:
                    h.run()
                self.assertEqual([route for route, _ in h.calls], ['/actions', '/keys'])
                self.assertEqual(len(h.captures), 2, 'one original visible clear capture plus one hidden preparation capture')
                self.assertEqual(caught.exception.writeOutcome, {'status': 'unknown', 'automaticRetry': False})

    def test_hidden_preparation_layout_uses_the_full_original_keyboard_area(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory, clearHidesKeyboard=True, hiddenLayoutChange=True) as h:
            with self.assertRaisesRegex(MobileError, 'VISUAL_LAYOUT_CHANGED'):
                h.run()
            self.assertEqual([route for route, _ in h.calls], ['/actions', '/keys'])

    def test_hidden_preparation_never_accepts_a_false_empty_or_wrong_filled_echo(self):
        for options, code, actions in (({'clearIgnored': True}, 'VISUAL_INPUT_CLEAR_NOT_VERIFIED', 2),
                                       ({'inputIgnored': True}, 'VISUAL_INPUT_NOT_VERIFIED', 3)):
            with self.subTest(options=options), tempfile.TemporaryDirectory() as directory, Harness(self, directory, clearHidesKeyboard=True, **options) as h:
                with self.assertRaisesRegex(MobileError, code):
                    h.run()
                self.assertEqual(len(h.calls), actions)

    def test_preparation_phase_mismatch_discards_frame_and_recaptures_without_any_ui_retry(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory, clearHidesKeyboard=True, flipHiddenSourceDuringPreparation=True) as h:
            self.assertEqual(h.run(), {'text': 'RESULT alpha 1'})
            self.assertEqual([route for route, _ in h.calls], ['/actions', '/keys', '/keys', '/actions', '/actions'])
            self.assertEqual(len(h.observations), 7)
            self.assertEqual(h.session.budget.count, 5)

    def test_hidden_preparation_keeps_final_hidden_full_sha_guard(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory, clearHidesKeyboard=True, hiddenSubmitStale=True) as h:
            with self.assertRaisesRegex(MobileError, 'VISUAL_FRAME_CHANGED'):
                h.run()
            self.assertEqual(len(h.calls), 4, 'Dismiss is dispatched once, business Submit is blocked')

    def test_ordinary_keyboard_path_dismisses_before_same_frame_result_baseline_and_submit(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory) as h:
            self.assertEqual(h.run(), {'text': 'RESULT alpha 1'})
            self.assertEqual([x[0] for x in h.calls], ['/actions', '/keys', '/keys', '/actions', '/actions'])
            self.assertEqual(len(h.observations), 6)
            self.assertEqual(len(h.captures), 3)
            self.assertEqual(set(h.contracts), {'focus', 'submit', '_pixels', '_keyboard'})
            self.assertEqual(h.contracts['_keyboard']['configDigest'], digest(PLAN))
            keyboard.validate_learned(PLAN, h.contracts['_keyboard'], h.contracts['focus'])
            # While visible, the output is absent from OCR. It cannot contribute
            # a result baseline until the original hidden layout is restored.
            self.assertFalse(any(t['text'] == 'RESULT' for t in h.observations[3]['tokens']))
            self.assertTrue(any(t['text'] == 'RESULT' for t in h.observations[4]['tokens']))

    def test_software_keyboard_never_dispatches_hardware_select_all_events(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory, hardwareHidesKeyboard=True) as h:
            self.assertEqual(h.run(), {'text': 'RESULT alpha 1'})
            self.assertNotIn('/execute/sync', [route for route, _ in h.calls])
            self.assertEqual([body for route, body in h.calls if route == '/keys'],
                             [{'value': ['\b' * 16]}, {'value': ['alpha']}])
            self.assertEqual(len(h.calls), 5)

    def test_caret_phase_read_wait_never_repeats_an_action(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory, caretMismatchOnce=True) as h:
            self.assertEqual(h.run()['text'], 'RESULT alpha 1')
            self.assertEqual(len(h.captures), 4)
            self.assertEqual(len(h.calls), 5)

    def test_post_ocr_input_pixels_are_never_hidden_by_keyboard_freshness(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory, lateInputChange=True) as h:
            with self.assertRaisesRegex(MobileError, 'VISUAL_FRAME_CHANGED') as caught: h.run()
            self.assertEqual([x[0] for x in h.calls], ['/actions'])
            self.assertEqual(caught.exception.writeOutcome, {'status': 'unknown', 'automaticRetry': False})
            self.assertLessEqual(len(h.captures), 6)

    def test_post_ocr_fixed_application_pixels_must_also_match(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory, lateBodyChange=True) as h:
            with self.assertRaisesRegex(MobileError, 'VISUAL_FRAME_CHANGED'): h.run()
            self.assertEqual([x[0] for x in h.calls], ['/actions'])

    def test_keyboard_region_mismatch_stops_after_first_focus(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory, wrongKeyboardRect=True) as h:
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_REGION_MISMATCH'): h.run()
            self.assertEqual(len(h.calls), 1)

    def test_source_failure_or_wrong_application_prevents_first_focus(self):
        for options in ({'sourceError': True}, {'app': 'wrong.app'}):
            with self.subTest(options=options), tempfile.TemporaryDirectory() as directory, Harness(self, directory, **options) as h:
                with self.assertRaises(MobileError): h.run()
                self.assertFalse(h.calls)
                self.assertFalse((h.session.output / 'write-intent.json').exists())

    def test_clear_or_input_receipt_without_echo_never_dismisses_or_submits(self):
        for options, code, count in (({'clearIgnored': True}, 'VISUAL_INPUT_CLEAR_NOT_VERIFIED', 2),
                                     ({'inputIgnored': True}, 'VISUAL_INPUT_NOT_VERIFIED', 3)):
            with self.subTest(options=options), tempfile.TemporaryDirectory() as directory, Harness(self, directory, **options) as h:
                with self.assertRaisesRegex(MobileError, code): h.run()
                self.assertEqual(len(h.calls), count)

    def test_dismiss_receipt_without_hiding_or_restored_layout_never_submits(self):
        for options, code in (({'dismissIgnored': True}, 'VISUAL_KEYBOARD_NOT_HIDDEN'),
                              ({'restoredBodyChanged': True}, 'VISUAL_LAYOUT_CHANGED'),
                              ({'dismissChangesInput': True}, 'VISUAL_INPUT_NOT_VERIFIED'),
                              ({'hiddenSubmitStale': True}, 'VISUAL_FRAME_CHANGED')):
            with self.subTest(options=options), tempfile.TemporaryDirectory() as directory, Harness(self, directory, **options) as h:
                with self.assertRaisesRegex(MobileError, code): h.run()
                self.assertEqual(len(h.calls), 4)

    def test_typing_auto_update_plus_noop_submit_fails_against_restored_baseline(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory, autoUpdate=True, submitNoop=True) as h:
            with self.assertRaisesRegex(MobileError, 'VISUAL_RESULT_NOT_VERIFIED') as caught: h.run()
            self.assertEqual(len(h.calls), 5)
            self.assertEqual(caught.exception.writeOutcome, {'status': 'unknown', 'automaticRetry': False})

    def test_keyboard_cannot_cover_any_actual_app_anchor(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory) as h:
            h.definition['resultRegion'] = {'x': .1, 'y': .8, 'width': .8, 'height': .1}
            original = h.observation
            def moved():
                o = original()
                next(t for t in o['tokens'] if t['text'] == 'Search')['bounds']['y'] = 320
                return o
            with patch.object(visual, '_observe', side_effect=lambda *_: moved()):
                with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_MASK_OVERLAPS_ANCHOR'): h.run()
            self.assertFalse(h.calls)

    def test_recipe_keyboard_contract_and_source_identity_are_bound(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory) as h:
            h.run()
            valid = copy.deepcopy(h.contracts)
            self.assertEqual(visual._contracts(DEF, valid, PLAN), valid)
            for value in ({**valid, '_keyboard': {**valid['_keyboard'], 'configDigest': '0' * 64}},
                          {k: v for k, v in valid.items() if k != '_keyboard'}):
                with self.subTest(value=value), self.assertRaises(MobileError): visual._contracts(DEF, value, PLAN)
            with self.assertRaises(MobileError): visual._contracts(DEF, valid)

    def test_approved_dismiss_contract_tolerates_only_existing_ocr_box_tolerance(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory) as h:
            h.run()
            learned = copy.deepcopy(h.contracts)
            original_dismissal = copy.deepcopy(learned['_keyboard']['dismiss'])
            original = h.observation
            def small_jitter():
                o = original()
                next(t for t in o['tokens'] if t['text'] == 'Dismiss')['bounds']['x'] += 1
                return o
            with patch.object(visual, '_observe', side_effect=lambda *_: small_jitter()):
                self.assertEqual(h.run(text='beta', contracts=learned), {'text': 'RESULT beta 2'})
            self.assertEqual(learned['_keyboard']['dismiss'], original_dismissal)

    def test_two_sample_learning_and_execute_use_existing_ios_entry_and_publish_no_samples(self):
        from apk_inventory import mobile_visual_ios as entry
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory) as h:
            learned = entry.learn(h.session, DEF, [{'query': 'alpha'}, {'query': 'beta'}])
            self.assertTrue(learned['ok'])
            recipe = h.session.progress['recipes'][learned['capabilityId']]
            self.assertIn('other_keyboard_layouts_physical_and_third_party_coverage_pending', h.session.progress['capabilities'][learned['capabilityId']]['gaps'])
            self.assertNotIn('alpha', json.dumps(recipe))
            result = entry.execute(h.session, recipe, recipe['revision'], {'query': 'gamma'})
            self.assertEqual(result['outputs'], {'text': 'RESULT gamma 3'})
            bad = copy.deepcopy(recipe); bad['controlContracts']['_keyboard']['configDigest'] = 'f' * 64; bad['revision'] = digest({k: v for k, v in bad.items() if k != 'revision'})
            before = len(h.calls)
            with self.assertRaisesRegex(MobileError, 'VISUAL_RECIPE_INVALID'): entry.execute(h.session, bad, bad['revision'], {'query': 'delta'})
            self.assertEqual(len(h.calls), before)


def png(path, changed=None):
    path = path.resolve()
    width, height = 40, 80
    rows = []
    for y in range(height):
        row = bytearray([255, 255, 255, 255] * width)
        if changed and y == changed[1]: row[changed[0] * 4:changed[0] * 4 + 4] = bytes([0, 0, 0, 255])
        rows.append(b'\0' + bytes(row))
    def chunk(kind, data): return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b''))
    return {'width': width, 'height': height, '_imagePath': str(path)}


class PixelTests(unittest.TestCase):
    def test_hidden_preparation_real_pngs_mask_only_result_and_capture_once(self):
        with tempfile.TemporaryDirectory() as directory:
            current = session(directory)
            config = current.config['nativeVisualWorkflow']
            base = png(Path(directory) / 'base.png')
            for name, point in (('input', (25, 12)), ('old-keyboard', (25, 70))):
                changed = png(Path(directory) / (name + '.png'), point)
                captured = {'width': changed['width'], 'height': changed['height'], 'imagePath': changed['_imagePath']}
                with self.subTest(name=name), patch.object(keyboard, 'keyboard_state'), patch.object(visual, '_geometry'), \
                        patch.object(keyboard, 'capture_locked', return_value=captured) as capture:
                    with self.assertRaisesRegex(MobileError, 'VISUAL_FRAME_CHANGED'):
                        keyboard._visible_fresh(current, object(), config, DEF, base, (100, 200), {}, visible=False)
                    self.assertEqual(capture.call_count, 1)

    def test_actual_png_fingerprints_exempt_keyboard_but_never_input_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            current = session(directory)
            base = png(Path(directory) / 'base.png')
            keyboard_changed = png(Path(directory) / 'keyboard.png', (25, 70))
            input_changed = png(Path(directory) / 'input.png', (25, 12))
            masks = [PLAN['region'], DEF['resultRegion']]
            actual = lambda observation: visual.ios._masked(current.config['nativeVisualWorkflow']['node'], current, observation, masks)
            self.assertEqual(actual(base), actual(keyboard_changed))
            self.assertNotEqual(actual(base), actual(input_changed))

    def test_actual_png_home_indicator_gap_pixels_remain_in_the_fingerprint(self):
        with tempfile.TemporaryDirectory() as directory:
            current = session(directory)
            base = png(Path(directory) / 'base.png')
            below_keyboard = png(Path(directory) / 'home-indicator.png', (25, 79))
            real_region = {'x': 0, 'y': 418 / 678, 'width': 1, 'height': 245 / 678}
            masks = [real_region, DEF['resultRegion']]
            actual = lambda o: visual.ios._masked(current.config['nativeVisualWorkflow']['node'], current, o, masks)
            self.assertNotEqual(actual(base), actual(below_keyboard))

    def test_real_png_explicit_envelope_exempts_only_locally_approved_padding(self):
        with tempfile.TemporaryDirectory() as directory:
            current = session(directory)
            base = png(Path(directory) / 'base.png')
            home_area = png(Path(directory) / 'home.png', (25, 79))
            above_envelope = png(Path(directory) / 'above.png', (25, 47))
            envelope = {'x': 0, 'y': 412 / 678, 'width': 1, 'height': 266 / 678}
            masks = [envelope, DEF['resultRegion']]
            actual = lambda o: visual.ios._masked(current.config['nativeVisualWorkflow']['node'], current, o, masks)
            self.assertEqual(actual(base), actual(home_area))
            self.assertNotEqual(actual(base), actual(above_envelope))

    def test_production_freshness_with_real_pngs_rejects_value_change_and_waits_for_same_pixels(self):
        with tempfile.TemporaryDirectory() as directory:
            current = session(directory)
            config = current.config['nativeVisualWorkflow']
            base = png(Path(directory) / 'base.png')
            changed = png(Path(directory) / 'changed.png', (25, 12))
            captured = lambda o: {'width': o['width'], 'height': o['height'], 'imagePath': o['_imagePath']}
            # Real PNG decoding and pixel fingerprints; only capture/source
            # transports are mocked. A changed value cannot be masked away.
            with patch.object(keyboard, 'keyboard_state'), patch.object(visual, '_geometry'), \
                    patch.object(keyboard, 'capture_locked', return_value=captured(changed)) as capture:
                with self.assertRaisesRegex(MobileError, 'VISUAL_FRAME_CHANGED'):
                    keyboard._visible_fresh(current, object(), config, DEF, base, (100, 200), {})
                self.assertLessEqual(capture.call_count, 6)
            with patch.object(keyboard, 'keyboard_state'), patch.object(visual, '_geometry'), \
                    patch.object(keyboard, 'capture_locked', side_effect=[captured(changed), captured(base)]) as capture:
                keyboard._visible_fresh(current, object(), config, DEF, base, (100, 200), {})
                self.assertEqual(capture.call_count, 2)


if __name__ == '__main__': unittest.main()
