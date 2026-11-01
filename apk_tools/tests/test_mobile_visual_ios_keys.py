"""Mocked three-layer WDA key transport plus real local PNG fingerprints.

No device/WDA/session is created; transport acceptance is the root's next gate.
"""
import copy
import hashlib
import json
import shutil
import string
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from apk_inventory import mobile_visual_ios_keys as keys
from apk_inventory import mobile_visual_ios_keyboard as keyboard
from apk_inventory import mobile_visual_ios_text as visual
from apk_inventory.mobile_ui import MobileError, digest
from test_mobile_visual_ios_keyboard import APP, DEF, PLAN, Harness, session, png

INPUT = {"mode": "onscreen", "controls": {
    "shift": {"type": "XCUIElementTypeButton", "name": "shift", "label": "shift"},
    "numbers": {"type": "XCUIElementTypeKey", "name": "more", "label": "numbers"},
    "letters": {"type": "XCUIElementTypeKey", "name": "more", "label": "letters"},
    "delete": {"type": "XCUIElementTypeKey", "name": "delete", "label": "delete"},
}}
KEY_PLAN = {**PLAN, "keyInput": INPUT}


def key_rows(layer):
    values = string.ascii_lowercase if layer == 'lower' else string.ascii_uppercase if layer == 'upper' else string.digits
    rows = [{'type': 'XCUIElementTypeKey', 'name': char, 'label': char, 'rect': (2 + (index % 10) * 9, 102 + (index // 10) * 20, 8, 18)} for index, char in enumerate(values)]
    rows += [{**INPUT['controls']['delete'], 'rect': (70, 164, 20, 14)},
             {**INPUT['controls']['letters' if layer == 'digits' else 'numbers'], 'rect': (22, 164, 24, 14)},
             {'type': 'XCUIElementTypeButton', 'name': 'shift', 'label': 'symbols' if layer == 'digits' else 'shift', 'rect': (2, 164, 18, 14)}]
    return rows


class KeyHarness(Harness):
    def __init__(self, test, directory, plan=KEY_PLAN, **options):
        super().__init__(test, directory, plan=plan, **options)
        self.layer = 'lower'
        self.physical = []
        self.session.budget.max_actions = options.get('maxActions', 100)

    def request(self, method, route, body=None):
        if route == '/source':
            self.source_reads += 1
            visible = self.visible
            if self.options.get('keyboardDisappears') and self.physical:
                visible = False
            rows = key_rows(self.layer)
            if self.options.get('duplicateLiteral'):
                rows.append(copy.deepcopy(rows[0]))
            if self.options.get('duplicateShift'):
                rows.append(copy.deepcopy(rows[-1]))
            entries = []
            for row in rows:
                x, y, width, height = row['rect']
                if self.options.get('offscreenLiteral') and row['name'] == 'q':
                    x = 101
                if self.options.get('offscreenShift') and row['name'] == 'shift':
                    x = 101
                enabled = 'false' if self.options.get('disabledLiteral') and row['name'] == 'q' or self.options.get('disabledShift') and row['name'] == 'shift' else 'true'
                entries.append(f'<{row["type"]} type="{row["type"]}" name="{row["name"]}" label="{row["label"]}" enabled="{enabled}" visible="true" x="{x}" y="{y}" width="{width}" height="{height}"/>')
            return f'<AppiumAUT><XCUIElementTypeApplication bundleId="{APP}"><XCUIElementTypeKeyboard visible="{str(visible).lower()}" x="0" y="100" width="100" height="100">{"".join(entries)}</XCUIElementTypeKeyboard></XCUIElementTypeApplication></AppiumAUT>'
        if method == 'POST' and route == '/actions' and body['actions'][0]['id'] == keys.POINTER_ID:
            self.test.assertEqual(json.loads((self.session.output / 'write-intent.json').read_text()), {'effect': self.definition['effect'], 'status': 'unknown', 'automaticRetry': False})
            point = body['actions'][0]['actions'][0]
            matches = [row for row in key_rows(self.layer) if row['rect'][0] <= point['x'] < row['rect'][0] + row['rect'][2] and row['rect'][1] <= point['y'] < row['rect'][1] + row['rect'][3]]
            self.test.assertEqual(len(matches), 1)
            target = matches[0]
            self.calls.append((route, body))
            self.physical.append(target['label'])
            if target['name'] == 'delete':
                if not self.options.get('deleteNoop'):
                    self.value = self.value[:-1]
            elif target['name'] == 'shift':
                if not self.options.get('toggleNoop') and self.options.get('noopControl') != target['label']:
                    self.layer = 'upper' if self.layer == 'lower' else 'lower'
            elif target['name'] == 'more':
                if not self.options.get('toggleNoop') and self.options.get('noopControl') != target['label']:
                    self.layer = 'lower' if self.layer == 'digits' else 'digits'
            else:
                if not self.options.get('inputIgnored'):
                    self.value += target['name']
                if self.layer == 'upper':
                    self.layer = 'lower'
            self.keyboard_pixels = 'layer-' + self.layer
            if self.options.get('autoUpdate'):
                self.result = 'RESULT ' + self.value + ' AUTO'
            return None
        result = super().request(method, route, body)
        if method == 'POST' and route == '/actions' and not self.visible:
            self.keyboard_pixels = 'restored-app-pixels'
        return result

    def masked(self, node, current, observation, masks):
        if len(masks) == 3:
            return 'b' * 64
        if masks == [self.definition['resultRegion']]:
            payload = [observation['_valuePixels'], observation['_bodyPixels'], observation['_caret'], observation['_keyboardPixels']]
            return hashlib.sha256(json.dumps(payload).encode()).hexdigest()
        if len(masks) == 1 and masks[0]['y'] == 0 and masks[0]['height'] < .5:
            return hashlib.sha256(observation['_keyboardPixels'].encode()).hexdigest()
        return super().masked(node, current, observation, masks)

    def capture(self, *args):
        captured = super().capture(*args)
        if self.options.get('lateKeyboardOverlay'):
            captured['_keyboardPixels'] = 'late-overlay'
        if self.options.get('layoutChangesDuringFresh') and not self.physical:
            self.layer = 'upper'
            self.keyboard_pixels = 'layer-upper'
        return captured

    def __enter__(self):
        super().__enter__()
        self.stack.enter_context(patch.object(keys, 'capture_locked', side_effect=self.capture))
        return self


class ContractTests(unittest.TestCase):
    def test_public_onscreen_device_example_validates_with_its_real_sixteen_character_definition(self):
        project = Path(__file__).resolve().parents[2]
        example = json.loads((project / 'examples/software/ios-visual-onscreen-device.example.json').read_text())
        definition = json.loads((project / 'examples/software/ios-visual-keyboard-workflow.example.json').read_text())
        self.assertEqual(definition['inputSchema']['maxLength'], 16)
        with tempfile.TemporaryDirectory() as directory:
            approved = Path(directory).resolve() / 'approved.json'
            approved.write_text(json.dumps(definition))
            example['nativeVisualWorkflow']['node'] = shutil.which('node')
            example['nativeVisualWorkflow']['approvedDefinitions'][definition['id']] = str(approved)
            from apk_inventory.mobile_ui import MobileSession
            current = MobileSession(example, Path(directory).resolve())
            config = visual.config_contract(current, definition, False)
            self.assertEqual(config['keyboard']['keyInput'], INPUT)
            self.assertEqual((current.budget.max_actions, current.budget.duration), (50, 480000))

    def test_opt_in_is_exact_digest_bound_and_requires_the_complete_ascii_domain(self):
        self.assertIs(keys.key_input_contract(INPUT, DEF), INPUT)
        self.assertIs(keyboard.keyboard_contract(KEY_PLAN, DEF), KEY_PLAN)
        self.assertNotEqual(digest(KEY_PLAN), digest(PLAN))
        for invalid in ({**INPUT, 'mode': 'auto'}, {**INPUT, 'fallback': True}, {**INPUT, 'controls': {}},
                        {**INPUT, 'controls': {**INPUT['controls'], 'shift': {'type': 'XCUIElementTypeKey', 'name': 'A', 'label': 'A'}}}):
            with self.subTest(invalid=invalid), self.assertRaises(MobileError):
                keys.key_input_contract(invalid, DEF)
        for schema in ({**DEF['inputSchema'], 'pattern': '^[a-z]+$'}, {**DEF['inputSchema'], 'maxLength': 17}):
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEY_INPUT_CONFIG_INVALID'):
                keys.key_input_contract(INPUT, {**DEF, 'inputSchema': schema})
        for char in string.ascii_letters + string.digits:
            self.assertEqual(keys.validate_text(char), char)
        for value in ('', '中文', 'a b', 'a\n', 'a' * 17):
            with self.assertRaises(MobileError):
                keys.validate_text(value)

    def test_all_sixty_two_literal_keys_are_read_from_full_proved_layers(self):
        with tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory) as h:
            h.visible = True
            observed = h.observation()
            for layer, alphabet in keys.ALPHABETS.items():
                h.layer = layer
                source = keys.read_source(h.session, h.session.config['nativeVisualWorkflow'], observed, (100, 200))
                self.assertEqual(source['layer'], layer)
                self.assertEqual(set(source['literals']), alphabet)
                for char in alphabet:
                    self.assertEqual(keys._target(source, char, True)['name'], char)


class SequenceTests(unittest.TestCase):
    def test_mixed_Ab7z_uses_physical_keys_without_dismiss_rewrite_or_global_keys(self):
        with tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory) as h:
            self.assertEqual(h.run('Ab7z'), {'text': 'RESULT Ab7z 1'})
            self.assertEqual(h.physical, ['delete'] * 3 + ['shift', 'A', 'b', 'numbers', '7', 'letters', 'z'])
            outside = [body for route, body in h.calls if route == '/actions' and body['actions'][0]['id'] != keys.POINTER_ID]
            self.assertEqual(len(outside), 3)
            self.assertNotIn('/keys', [route for route, _ in h.calls])
            self.assertEqual(h.session.budget.count, len(h.physical) + 3)
            events = [json.loads(line) for line in (h.session.output / 'events.jsonl').read_text().splitlines()]
            started = [event for event in events if event['kind'] == 'visual_keyboard_key_started']
            self.assertEqual(len(started), len(h.physical))
            self.assertFalse(any('literalValue' in event or 'text' in event for event in started))
            self.assertTrue(all(event['automaticRetry'] is False for event in started))

    def test_empty_clear_stops_immediately_and_sixteen_mixed_characters_are_not_schema_narrowed(self):
        for value in ('a' * 16, 'A7' * 8, 'z0Z9aB12cD34eF56'):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory) as h:
                h.value = ''
                self.assertEqual(h.run(value)['text'], 'RESULT ' + value + ' 1')
                self.assertNotIn('delete', h.physical)
                self.assertLessEqual(len(h.physical), 64)

    def test_toggle_receipt_without_a_changed_layer_is_not_retried(self):
        for control, value, expected in [('shift', 'A', ['shift']), ('numbers', '7', ['numbers']), ('letters', '7a', ['numbers', '7', 'letters'])]:
            with self.subTest(control=control), tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory, noopControl=control) as h:
                with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_LAYER_NOT_VERIFIED') as caught:
                    h.run(value)
                self.assertEqual(h.physical, ['delete'] * 3 + expected)
                self.assertEqual(caught.exception.writeOutcome, {'status': 'unknown', 'automaticRetry': False})

    def test_source_layout_changing_during_fresh_capture_is_not_reinterpreted(self):
        with tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory, layoutChangesDuringFresh=True) as h:
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_LAYOUT_CHANGED'):
                h.run('Ab7z')
            self.assertEqual(h.physical, [])

    def test_explicit_physical_key_quota_does_not_dispatch_a_sixty_fifth_key(self):
        with tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory) as h:
            h.run('a')
            h.visible = True
            observation = h.observation()
            config = h.session.config['nativeVisualWorkflow']
            source = keys.read_source(h.session, config, observation, (100, 200))
            before = (len(h.physical), h.session.budget.count)
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEY_INPUT_BUDGET'):
                keys.dispatch_key(h.session, object(), config, h.definition, observation, (100, 200), h.contracts, source, 'a', {'keys': 64}, literal=True, phase='type')
            self.assertEqual((len(h.physical), h.session.budget.count), before)

    def test_missing_duplicate_disabled_or_offscreen_keys_and_controls_fail_without_typing(self):
        for option in ('duplicateLiteral', 'disabledLiteral', 'offscreenLiteral', 'duplicateShift', 'disabledShift', 'offscreenShift'):
            with self.subTest(option=option), tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory, **{option: True}) as h:
                with self.assertRaises(MobileError):
                    h.run('Ab7z')
                self.assertFalse(any(char in h.physical for char in ('A', 'b', '7', 'z')))
                self.assertNotIn('/keys', [route for route, _ in h.calls])

    def test_delete_or_literal_noop_stops_at_first_failed_echo_without_a_retry(self):
        for option, expected in [('deleteNoop', ['delete']), ('inputIgnored', ['delete'] * 3 + ['a'])]:
            with self.subTest(option=option), tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory, **{option: True}) as h:
                with self.assertRaisesRegex(MobileError, 'VISUAL_INPUT_CLEAR_NOT_VERIFIED' if option == 'deleteNoop' else 'VISUAL_INPUT_NOT_VERIFIED'):
                    h.run('alpha')
                self.assertEqual(h.physical, expected)
                self.assertEqual(len([route for route, body in h.calls if route == '/actions' and body['actions'][0]['id'] != keys.POINTER_ID]), 1)

    def test_disappeared_keyboard_or_late_overlay_prevents_the_next_physical_key(self):
        for option in ('keyboardDisappears', 'lateKeyboardOverlay'):
            with self.subTest(option=option), tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory, **{option: True}) as h:
                with self.assertRaises(MobileError):
                    h.run('alpha')
                self.assertEqual(h.physical, ['delete'] if option == 'keyboardDisappears' else [])

    def test_global_action_limit_and_failed_intent_persistence_do_not_dispatch_an_extra_key(self):
        with tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory, maxActions=2) as h:
            with self.assertRaisesRegex(MobileError, 'ACTION_BUDGET'):
                h.run('alpha')
            self.assertEqual(h.physical, ['delete'])
        with tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory) as h, patch.object(keys, 'atomic_json', side_effect=MobileError('OUTPUT_REJECTED')):
            with self.assertRaisesRegex(MobileError, 'OUTPUT_REJECTED'):
                h.run('alpha')
            self.assertEqual(h.physical, [])

    def test_auto_updated_result_cannot_certify_a_noop_business_submit_and_final_whole_sha_is_kept(self):
        for options, code, outside_count in [({'autoUpdate': True, 'submitNoop': True}, 'VISUAL_RESULT_NOT_VERIFIED', 3), ({'hiddenSubmitStale': True}, 'VISUAL_FRAME_CHANGED', 2)]:
            with self.subTest(options=options), tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory, **options) as h:
                with self.assertRaisesRegex(MobileError, code):
                    h.run('alpha')
                self.assertEqual(len([body for route, body in h.calls if route == '/actions' and body['actions'][0]['id'] != keys.POINTER_ID]), outside_count)


class PixelTests(unittest.TestCase):
    def test_keyboard_fingerprint_keeps_every_keyboard_pixel_even_with_an_overlapping_result_mask(self):
        with tempfile.TemporaryDirectory() as directory:
            current = session(directory, plan=KEY_PLAN)
            base = png(Path(directory) / 'base.png')
            changed = png(Path(directory) / 'key-overlay.png', (20, 52))
            masks = keys._keyboard_only_masks(current.config['nativeVisualWorkflow'], base)
            fingerprint = lambda image, selected: visual.ios._masked(current.config['nativeVisualWorkflow']['node'], current, image, selected)
            # Pixel (20,52) is in both approved result and keyboard regions.
            self.assertEqual(fingerprint(base, [DEF['resultRegion']]), fingerprint(changed, [DEF['resultRegion']]))
            self.assertNotEqual(fingerprint(base, masks), fingerprint(changed, masks))
