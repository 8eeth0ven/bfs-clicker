"""Local paired-underlay authority/configuration and phase-isolation mocks.

No device, Appium, HTTP, OCR or screenshot is started. Pixel math lives in the
separate pure-PNG Node tests; these doubles only verify native routing/guards.
"""
import copy
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

from apk_inventory import mobile_visual_ios_keyboard as keyboard
from apk_inventory import mobile_visual_ios_keys as keys
from apk_inventory import mobile_visual_ios_text as visual
from apk_inventory.mobile_ui import MobileError, digest
from test_mobile_visual_ios_keyboard import DEF, session
from test_mobile_visual_ios_keys import INPUT, KEY_PLAN, KeyHarness
from test_mobile_visual_ios_caret import CARET
from test_mobile_visual_ios_key_sampling import SamplingProbe

UNDERLAY = {"mode": "paired_revealed_grayscale", "maxUnderlayPixels": 16,
            "minWhiteCoreFraction": .8, "minSharedOpacity": .125}
OPT = {**KEY_PLAN, "caret": CARET, "keyInput": {**INPUT, "caretUnderlay": UNDERLAY}}


class ConfigurationTests(unittest.TestCase):
    def test_local_key_input_authority_is_digest_bound_and_does_not_change_base_eight_fields(self):
        self.assertIs(keyboard.keyboard_contract(OPT, DEF), OPT)
        self.assertIs(keyboard.caret_contract(CARET), CARET)
        with self.assertRaisesRegex(MobileError, 'VISUAL_CARET_CONFIG_INVALID'):
            keyboard.caret_contract({**CARET, 'underlay': UNDERLAY})
        with tempfile.TemporaryDirectory() as directory:
            strict = session(directory, plan={**KEY_PLAN, 'caret': CARET})
            opted = session(directory, plan=OPT)
            self.assertNotEqual(strict.identity, opted.identity)
            self.assertNotEqual(digest(strict.config['nativeVisualWorkflow']['keyboard']), digest(OPT))
        self.assertTrue(any('underlay' in gap for gap in keyboard.gaps(OPT)))
        self.assertFalse(any('underlay' in gap for gap in keyboard.gaps({**KEY_PLAN, 'caret': CARET})))

    def test_exact_schema_numeric_hard_limits_and_required_chromatic_white_base(self):
        bad = [None, {**UNDERLAY, 'mode': 'auto'}, {**UNDERLAY, 'extra': True},
               {**UNDERLAY, 'maxUnderlayPixels': 0}, {**UNDERLAY, 'maxUnderlayPixels': 65},
               {**UNDERLAY, 'maxUnderlayPixels': True}, {**UNDERLAY, 'maxUnderlayPixels': 1.5},
               {**UNDERLAY, 'minWhiteCoreFraction': .79}, {**UNDERLAY, 'minWhiteCoreFraction': 1.01},
               {**UNDERLAY, 'minSharedOpacity': .124}, {**UNDERLAY, 'minSharedOpacity': float('inf')},
               {**UNDERLAY, 'minWhiteCoreFraction': float('nan')},
               {**UNDERLAY, 'minSharedOpacity': True}]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(MobileError):
                keyboard.keyboard_contract({**OPT, 'keyInput': {**INPUT, 'caretUnderlay': value}}, DEF)
        for caret in [None, {**CARET, 'background': [254, 254, 254]}, {**CARET, 'color': [0, 0, 0]}]:
            value = copy.deepcopy(OPT)
            if caret is None:
                value.pop('caret')
            else:
                value['caret'] = caret
            with self.subTest(caret=caret), self.assertRaises(MobileError):
                keyboard.keyboard_contract(value, DEF)
        for value in [{**UNDERLAY, 'maxUnderlayPixels': 1}, {**UNDERLAY, 'maxUnderlayPixels': 64},
                      {**UNDERLAY, 'minWhiteCoreFraction': 1, 'minSharedOpacity': 1}]:
            self.assertIsNotNone(keyboard.keyboard_contract({**OPT, 'keyInput': {**INPUT, 'caretUnderlay': value}}, DEF))

    def test_learning_and_replay_bind_the_authority_without_more_ui_actions(self):
        with tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory, plan=OPT) as h:
            self.assertEqual(h.run()['text'], 'RESULT alpha 1')
            self.assertEqual(h.contracts['_keyboard']['configDigest'], digest(OPT))
            changed = copy.deepcopy(OPT)
            changed['keyInput']['caretUnderlay']['maxUnderlayPixels'] = 15
            with self.assertRaisesRegex(MobileError, 'VISUAL_RECIPE_INVALID'):
                keyboard.validate_learned(changed, h.contracts['_keyboard'], h.contracts['focus'])


class RoutingTests(unittest.TestCase):
    def test_actual_local_pixel_worker_accepts_only_explicit_underlay_with_unchanged_typed_reply(self):
        def picture(path, covered):
            width, height, rows = 300, 600, []
            for y in range(height):
                row = bytearray([255, 255, 255, 255] * width)
                for x in range(60, 66):
                    gray = 171 if x == 60 and 90 <= y < 106 else 255
                    rgb = ([round(gray + .25 * (c - gray)) for c in CARET['color']]
                           if covered and 90 <= y < 204 else [gray] * 3)
                    row[x * 4:x * 4 + 4] = bytes([*rgb, 255])
                rows.append(b'\0' + row)
            def chunk(kind, data):
                return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)
            path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 6, 0, 0, 0))
                             + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b''))
            return {'width': width, 'height': height, '_imagePath': str(path.resolve())}
        with tempfile.TemporaryDirectory() as directory:
            current = session(directory, plan=OPT)
            config = current.config['nativeVisualWorkflow']
            before, after = picture(Path(directory) / 'covered.png', True), picture(Path(directory) / 'revealed.png', False)
            definition = {**DEF, 'valueRegion': {'x': .1, 'y': .1, 'width': .8, 'height': .3},
                          'resultRegion': {'x': .1, 'y': .45, 'width': .8, 'height': .04}}
            for permission in [False, True]:
                with visual.ios._pixel_task(config['node'], current) as task:
                    kwargs = {'task': task, **({'underlay': UNDERLAY} if permission else {})}
                    self.assertEqual(keyboard._caret_equivalent(current, config, definition, before, after,
                                                               (100, 200), [definition['resultRegion']], **kwargs), permission)
            self.assertEqual(current.budget.count, 0)

    def test_raw_config_option_cannot_enable_other_caret_callers_without_private_keyword(self):
        with tempfile.TemporaryDirectory() as directory:
            current = session(directory, plan=OPT)
            config = current.config['nativeVisualWorkflow']
            before = {'width': 300, 'height': 600, '_imagePath': '/mock/reference.png'}
            seen = []
            class Task:
                def caret(self, old, fresh, options):
                    seen.append(copy.deepcopy(options))
                    return False
            self.assertFalse(keyboard._caret_equivalent(current, config, DEF, before, before,
                                                       (100, 200), [DEF['resultRegion']], task=Task()))
            self.assertEqual(seen[-1]['policy'], CARET)
            self.assertFalse(keyboard._caret_equivalent(current, config, DEF, before, before,
                                                       (100, 200), [DEF['resultRegion']],
                                                       task=Task(), underlay=UNDERLAY))
            self.assertEqual(seen[-1]['policy'], {**CARET, 'underlay': UNDERLAY})
            self.assertEqual(config['keyboard']['caret'], CARET, 'never mutate the base policy')

    def test_only_key_freshness_passes_the_validated_local_option(self):
        class Probe(SamplingProbe):
            def caret(self, *args, task, underlay=None):
                self.permission_seen = underlay
                return super().caret(*args, task=task)
        for opted in [False, True]:
            with self.subTest(opted=opted), tempfile.TemporaryDirectory() as directory:
                p = Probe(self, directory, frames=[{'global': False, 'caret': True}])
                p.config['keyboard']['caret'] = copy.deepcopy(CARET)
                if opted:
                    p.config['keyboard']['keyInput']['caretUnderlay'] = copy.deepcopy(UNDERLAY)
                p.run()
                self.assertEqual(p.permission_seen, UNDERLAY if opted else None)
                self.assertEqual(p.captures, 1)
                self.assertEqual(p.h.calls, [])
                self.assertFalse(p.record()['uiActionRetried'])

    def test_optional_acceptance_cannot_survive_worker_exit_error_or_cancellation(self):
        class Probe(SamplingProbe):
            def caret(self, *args, task, underlay=None):
                self.permission_seen = underlay
                return super().caret(*args, task=task)
        for code in ['VISUAL_CARET_UNAVAILABLE', 'STOPPED']:
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                def stop(p, name):
                    if name == 'pixel_exit':
                        if code == 'STOPPED':
                            p.session.budget.cancelled = True
                        else:
                            raise MobileError(code)
                p = Probe(self, directory, frames=[{'global': False, 'caret': True}], stage_hook=stop)
                p.config['keyboard']['caret'] = copy.deepcopy(CARET)
                p.config['keyboard']['keyInput']['caretUnderlay'] = copy.deepcopy(UNDERLAY)
                with self.assertRaisesRegex(MobileError, code):
                    p.run()
                self.assertEqual(p.permission_seen, UNDERLAY)
                self.assertEqual((p.captures, p.source_checks, p.session.budget.count), (1, 2, 0))
                self.assertEqual(p.h.calls, [])
                self.assertEqual(p.record()['stopReason'], code)

    def test_layer_switch_and_hidden_preparation_do_not_forward_new_authority(self):
        with tempfile.TemporaryDirectory() as directory:
            current = session(directory, plan=OPT)
            config = current.config['nativeVisualWorkflow']
            old = {'width': 300, 'height': 600, '_imagePath': '/mock/old.png'}
            fresh = {'width': 300, 'height': 600, 'imagePath': '/mock/fresh.png'}
            def denied(*args, **kwargs):
                self.assertNotIn('underlay', kwargs)
                return False
            with patch.object(visual.ios, '_masked', side_effect=['a', 'b']), \
                    patch.object(keyboard, '_caret_equivalent', side_effect=denied):
                with self.assertRaisesRegex(MobileError, 'VISUAL_FRAME_CHANGED'):
                    keys._switch_unchanged(current, config, DEF, old, fresh, (100, 200))
            with patch.object(visual.ios, '_masked', side_effect=['a', 'b']), \
                    patch.object(keyboard, 'keyboard_state'), patch.object(visual, '_geometry'), \
                    patch.object(keyboard, 'capture_locked', return_value=fresh), \
                    patch.object(keyboard, '_caret_equivalent', side_effect=denied):
                with self.assertRaisesRegex(MobileError, 'VISUAL_FRAME_CHANGED'):
                    keyboard._visible_fresh(current, object(), config, DEF, old, (100, 200), {}, visible=False)


if __name__ == '__main__':
    unittest.main()
