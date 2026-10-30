"""Explicit caret-policy contracts, protocol mocks and real PNG comparisons.

These tests never start a device, simulator, WDA or Appium service.
"""
import copy
import json
import os
import struct
import sys
import tempfile
import time
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

import psutil

from apk_inventory import mobile_visual_ios_keyboard as keyboard
from apk_inventory import mobile_visual_ios_text as visual
from apk_inventory.mobile_ui import MobileError, digest
from test_mobile_visual_ios_keyboard import DEF, PLAN, Harness, session

CARET = {"enabled": True, "color": [66, 107, 242], "background": [255, 255, 255], "colorTolerance": 2,
         "maxWidthPoints": 3, "minHeightPoints": 8, "maxHeightPoints": 48, "maxAreaPoints": 144}
CARET_PLAN = {**PLAN, "caret": CARET}
IMAGE_DEF = {**DEF, "valueRegion": {"x": .1, "y": .1, "width": .8, "height": .3},
             "resultRegion": {"x": .1, "y": .45, "width": .8, "height": .04}}


def image(path, color=None, extra=None):
    width, height = 300, 600
    rows = []
    for y in range(height):
        row = bytearray([255, 255, 255, 255] * width)
        if color and 90 <= y < 204:
            for x in range(60, 66):
                row[x * 4:x * 4 + 4] = bytes([*color, 255])
        if extra and y == extra[1]:
            row[extra[0] * 4:extra[0] * 4 + 4] = bytes([0, 0, 0, 255])
        rows.append(b'\0' + row)
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 6, 0, 0, 0))
                     + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b''))
    return {"width": width, "height": height, "_imagePath": str(path.resolve())}


def masks(config):
    return [config['keyboard']['region'], IMAGE_DEF['resultRegion']]


class CaretConfigurationTests(unittest.TestCase):
    def test_policy_is_explicit_strict_and_bound_into_local_identity_and_recipe_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            strict = session(directory)
            opted = session(directory, plan=CARET_PLAN)
            self.assertIs(keyboard.caret_contract(CARET), CARET)
            self.assertEqual(visual.config_contract(opted, DEF, True)['keyboard']['caret'], CARET)
            self.assertNotEqual(strict.identity, opted.identity)
            self.assertNotEqual(digest(PLAN), digest(CARET_PLAN))
            self.assertFalse(any('same_colored' in gap for gap in visual._gaps(strict.config['nativeVisualWorkflow'])))
            self.assertIn('same_colored_narrow_glyph_changes_may_match_approved_caret_policy',
                          visual._gaps(opted.config['nativeVisualWorkflow']))
            with Harness(self, directory, plan=CARET_PLAN) as h:
                h.run()
                self.assertEqual(h.contracts['_keyboard']['configDigest'], digest(CARET_PLAN))
                changed = copy.deepcopy(CARET_PLAN)
                changed['caret']['colorTolerance'] = 1
                with self.assertRaisesRegex(MobileError, 'VISUAL_RECIPE_INVALID'):
                    keyboard.validate_learned(changed, h.contracts['_keyboard'], h.contracts['focus'])

    def test_unknown_fields_nonfinite_bool_and_unbounded_policy_are_rejected(self):
        invalid = [None, {**CARET, 'enabled': False}, {**CARET, 'extra': True}, {**CARET, 'color': [66, True, 242]},
                   {**CARET, 'color': [66, 107, 256]}, {**CARET, 'colorTolerance': True}, {**CARET, 'colorTolerance': 3},
                   {**CARET, 'background': CARET['color']}, {**CARET, 'maxWidthPoints': 3.1},
                   {**CARET, 'minHeightPoints': 7.9}, {**CARET, 'maxHeightPoints': 48.1},
                   {**CARET, 'maxAreaPoints': 145}, {**CARET, 'maxWidthPoints': False},
                   {**CARET, 'maxAreaPoints': float('nan')}, {**CARET, 'maxAreaPoints': float('inf')},
                   {key: value for key, value in CARET.items() if key != 'background'}]
        for value in invalid:
            with self.subTest(value=value), self.assertRaisesRegex(MobileError, 'VISUAL_CARET_CONFIG_INVALID'):
                keyboard.keyboard_contract({**PLAN, 'caret': value}, DEF)


class VisibleSequenceTests(unittest.TestCase):
    def test_explicit_caret_policy_also_applies_to_hidden_preparation_with_one_result_mask(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory, plan=CARET_PLAN,
                                                                 clearHidesKeyboard=True, hiddenCaretMismatch=True) as h:
            def approved(current, config, definition, before, after, geometry, masked):
                self.assertFalse(h.visible)
                self.assertEqual(h.phase, 1, 'final hidden business submit may not use caret equivalence')
                self.assertEqual(masked, [DEF['resultRegion']])
                return True
            with patch.object(keyboard, '_caret_equivalent', side_effect=approved) as helper:
                self.assertEqual(h.run()['text'], 'RESULT alpha 1')
                self.assertEqual(helper.call_count, 2)
                self.assertEqual(len(h.calls), 5)

    def test_hidden_preparation_without_explicit_caret_policy_remains_exact(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory, clearHidesKeyboard=True, hiddenCaretMismatch=True) as h, \
                patch.object(keyboard, '_caret_equivalent', side_effect=AssertionError('not authorized')):
            with self.assertRaisesRegex(MobileError, 'VISUAL_FRAME_CHANGED'):
                h.run()
            self.assertEqual(len(h.calls), 2)

    def test_no_policy_keeps_exact_pixels_and_does_not_invoke_caret_helper(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory, caretMismatchOnce=True) as h, \
                patch.object(keyboard, '_caret_equivalent', side_effect=AssertionError('not authorized')):
            self.assertEqual(h.run()['text'], 'RESULT alpha 1')
            self.assertEqual(len(h.captures), 4)
            self.assertEqual(len(h.calls), 5)

    def test_explicit_policy_only_changes_visible_freshness_and_never_retries_actions(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory, plan=CARET_PLAN, caretMismatchOnce=True) as h, \
                patch.object(keyboard, '_caret_equivalent', return_value=True) as helper:
            self.assertEqual(h.run()['text'], 'RESULT alpha 1')
            self.assertEqual(helper.call_count, 1)
            self.assertEqual(len(h.captures), 3)
            self.assertEqual([route for route, _ in h.calls], ['/actions', '/keys', '/keys', '/actions', '/actions'])

    def test_hidden_submission_still_requires_original_full_frame_guard(self):
        with tempfile.TemporaryDirectory() as directory, Harness(self, directory, plan=CARET_PLAN,
                                                                 caretMismatchOnce=True, hiddenSubmitStale=True) as h, \
                patch.object(keyboard, '_caret_equivalent', return_value=True):
            with self.assertRaisesRegex(MobileError, 'VISUAL_FRAME_CHANGED') as caught:
                h.run()
            self.assertEqual(len(h.calls), 4)
            self.assertEqual(caught.exception.writeOutcome, {'status': 'unknown', 'automaticRetry': False})


class ActualHelperTests(unittest.TestCase):
    def test_real_hidden_preparation_caret_helper_keeps_old_keyboard_pixels(self):
        with tempfile.TemporaryDirectory() as directory:
            current = session(directory, plan=CARET_PLAN)
            config = current.config['nativeVisualWorkflow']
            base = image(Path(directory) / 'base.png')
            faded = image(Path(directory) / 'fade.png', [114, 144, 246])
            keyboard_changed = image(Path(directory) / 'old-keyboard.png', [114, 144, 246], (30, 350))
            only_result = [IMAGE_DEF['resultRegion']]
            self.assertTrue(keyboard._caret_equivalent(current, config, IMAGE_DEF, base, faded, (100, 200), only_result))
            self.assertFalse(keyboard._caret_equivalent(current, config, IMAGE_DEF, base, keyboard_changed, (100, 200), only_result))
            captured = {'width': faded['width'], 'height': faded['height'], 'imagePath': faded['_imagePath']}
            with patch.object(keyboard, 'keyboard_state'), patch.object(visual, '_geometry'), \
                    patch.object(keyboard, 'capture_locked', return_value=captured) as capture:
                keyboard._visible_fresh(current, object(), config, IMAGE_DEF, base, (100, 200), {}, visible=False)
                self.assertEqual(capture.call_count, 1)

    def test_real_decoded_png_fade_is_accepted_and_black_text_change_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            current = session(directory, plan=CARET_PLAN)
            config = current.config['nativeVisualWorkflow']
            base = image(Path(directory) / 'base.png')
            faded = image(Path(directory) / 'fade.png', [114, 144, 246])
            black = image(Path(directory) / 'black.png', [0, 0, 0])
            self.assertTrue(keyboard._caret_equivalent(current, config, IMAGE_DEF, base, faded, (100, 200), masks(config)))
            self.assertFalse(keyboard._caret_equivalent(current, config, IMAGE_DEF, base, black, (100, 200), masks(config)))
            captured = {'width': faded['width'], 'height': faded['height'], 'imagePath': faded['_imagePath']}
            with patch.object(keyboard, 'keyboard_state'), patch.object(visual, '_geometry'), \
                    patch.object(keyboard, 'capture_locked', return_value=captured) as capture:
                keyboard._visible_fresh(current, object(), config, IMAGE_DEF, base, (100, 200), {})
                self.assertEqual(capture.call_count, 1)

    def test_bad_helper_output_is_bounded_rejected_and_process_is_reaped(self):
        with tempfile.TemporaryDirectory() as directory:
            current = session(directory, plan=CARET_PLAN)
            config = current.config['nativeVisualWorkflow']
            base = image(Path(directory) / 'base.png')
            for index, output in enumerate(('x' * 4097, '{}', json.dumps({'width': True, 'height': 600, 'equivalent': True,
                                                                         'mode': 'exact', 'changedPixels': 0}))):
                marker = Path(directory) / ('pid-' + str(index))
                wrapper = Path(directory) / ('engine-' + str(index))
                wrapper.write_text('#!' + sys.executable + '\nimport os,sys\nsys.stdin.read()\nopen(' + repr(str(marker))
                                   + ',"w").write(str(os.getpid()))\nsys.stdout.write(' + repr(output) + ')\n')
                wrapper.chmod(0o700)
                with self.subTest(index=index), self.assertRaisesRegex(MobileError, 'VISUAL_CARET_UNAVAILABLE'):
                    keyboard._caret_equivalent(current, {**config, 'node': str(wrapper)}, IMAGE_DEF, base, base, (100, 200), masks(config))
                with self.assertRaises(ProcessLookupError): os.kill(int(marker.read_text()), 0)

    def test_budget_failure_kills_owned_process_group_before_returning(self):
        with tempfile.TemporaryDirectory() as directory:
            current = session(directory, plan=CARET_PLAN)
            config = current.config['nativeVisualWorkflow']
            base = image(Path(directory) / 'base.png')
            marker = Path(directory) / 'processes.json'
            wrapper = Path(directory) / 'hanging-engine'
            wrapper.write_text('#!' + sys.executable + '\nimport json,os,subprocess,sys,time\nsys.stdin.read()\n'
                               + 'child=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"])\n'
                               + 'open(' + repr(str(marker)) + ',"w").write(json.dumps([os.getpid(),child.pid]))\n'
                               + 'time.sleep(30)\n')
            wrapper.chmod(0o700)
            started = time.monotonic()
            class Budget:
                def check(self):
                    if marker.exists() or time.monotonic() - started > 3:
                        raise MobileError('FIXTURE_BUDGET_EXCEEDED', 'blocked')
                def timeout(self): return .05
            current.budget = Budget()
            with self.assertRaisesRegex(MobileError, 'FIXTURE_BUDGET_EXCEEDED'):
                keyboard._caret_equivalent(current, {**config, 'node': str(wrapper)}, IMAGE_DEF, base, base, (100, 200), masks(config))
            parent, child = json.loads(marker.read_text())
            with self.assertRaises(ProcessLookupError): os.kill(parent, 0)
            def active(pid):
                try:
                    return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
                except psutil.NoSuchProcess:
                    return False
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and active(child):
                time.sleep(.01)
            self.assertFalse(active(child))


if __name__ == '__main__': unittest.main()
