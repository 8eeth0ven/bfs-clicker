"""Exclusive integer key-center checks using XML/mocks only; no device/OCR."""
import copy
import tempfile
import unittest
import xml.etree.ElementTree as ET

from apk_inventory import mobile_visual_ios_keys as keys
from apk_inventory.mobile_ui import MobileError
from test_mobile_visual_ios_keys import KeyHarness


def overlay(raw, kind='literal', enabled='true'):
    tree = ET.fromstring(raw)
    keyboard, = [n for n in tree.iter() if n.attrib.get('type', n.tag) == 'XCUIElementTypeKeyboard']
    a, = [n for n in keyboard.iter() if n.attrib.get('name') == 'a']
    box = {field: a.attrib[field] for field in ('x', 'y', 'width', 'height')}
    if kind in ('literal', 'control'):
        node, = [n for n in keyboard.iter() if n.attrib.get('name') == ('b' if kind == 'literal' else 'delete')]
        node.attrib.update(box)
    elif kind == 'shift-target':
        shift, = [n for n in keyboard.iter() if n.attrib.get('name') == 'shift']
        a.attrib.update({field: shift.attrib[field] for field in box})
    elif kind in ('unknown-button', 'unknown-key'):
        tag = 'XCUIElementTypeButton' if kind == 'unknown-button' else 'XCUIElementTypeKey'
        ET.SubElement(keyboard, tag, type=tag, name='unknown', label='unknown', enabled=enabled, visible='true', **box)
    elif kind in ('adjacent', 'partial'):
        b, = [n for n in keyboard.iter() if n.attrib.get('name') == 'b']
        b.set('x', '10' if kind == 'adjacent' else '8')
    elif kind == 'narrow':
        a.set('x', '2.1')
        a.set('width', '.1')
    else:
        raise AssertionError(kind)
    return ET.tostring(tree, encoding='unicode')


class CenterTests(unittest.TestCase):
    def set_source(self, harness, transform):
        original = harness.session.backend.request
        def request(method, route, body=None):
            value = original(method, route, body)
            return transform(value) if route == '/source' else value
        harness.session.backend.request = request

    def test_named_literal_and_approved_control_cannot_share_the_integer_target_center(self):
        for kind in ('literal', 'control', 'shift-target'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory) as h:
                h.value = ''
                self.set_source(h, lambda raw: overlay(raw, kind))
                with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_KEY_AMBIGUOUS') as caught:
                    h.run('A' if kind == 'shift-target' else 'a')
                self.assertEqual(h.physical, [])
                self.assertEqual(h.session.budget.count, 1)  # only the independently validated Focus
                self.assertEqual(caught.exception.writeOutcome, {'status': 'unknown', 'automaticRetry': False})

    def test_unknown_visible_key_or_button_blocks_the_center_even_when_disabled(self):
        for kind in ('unknown-key', 'unknown-button'):
            for enabled in ('true', 'false'):
                with self.subTest(kind=kind, enabled=enabled), tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory) as h:
                    h.value = ''
                    self.set_source(h, lambda raw: overlay(raw, kind, enabled))
                    with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_KEY_AMBIGUOUS'):
                        h.run('a')
                    self.assertEqual(h.physical, [])
                    self.assertEqual(h.session.budget.count, 1)

    def test_rows_retain_parsed_node_identity_and_do_not_exclude_an_equal_other_node(self):
        with tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory) as h:
            h.visible = True
            source = keys.read_source(h.session, h.session.config['nativeVisualWorkflow'], h.observation(), (100, 200))
            a = keys._target(source, 'a', True)
            self.assertTrue(any(row is a for row in source['rows']))
            source['rows'].append(copy.deepcopy(a))
            with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_KEY_AMBIGUOUS'):
                keys._target(source, 'a', True)
            self.assertEqual(h.physical, [])

    def test_adjacent_and_noncentral_overlap_preserve_the_original_action_count(self):
        for kind in ('adjacent', 'partial'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory) as h:
                h.value = ''
                self.set_source(h, lambda raw: overlay(raw, kind))
                self.assertEqual(h.run('a'), {'text': 'RESULT a 1'})
                self.assertEqual(h.physical, ['a'])
                self.assertEqual(h.session.budget.count, 4)

    def test_source_drift_before_after_fresh_capture_or_at_final_source_never_dispatches(self):
        # Focused observation bracketing reads1,2; _state read3; fresh before4,
        # fresh after5; final pre-dispatch source6. Only mutate a later source.
        for at in (4, 5, 6):
            with self.subTest(visible_source_read=at), tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory) as h:
                h.value = ''
                reads = [0]
                def transform(raw):
                    node = ET.fromstring(raw).find('.//XCUIElementTypeKeyboard')
                    if node.attrib['visible'] == 'true':
                        reads[0] += 1
                        if reads[0] == at:
                            return overlay(raw, 'unknown-button')
                    return raw
                self.set_source(h, transform)
                with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_(?:LAYOUT_CHANGED|KEY_AMBIGUOUS)'):
                    h.run('a')
                self.assertEqual(h.physical, [])
                self.assertEqual(h.session.budget.count, 1)
                self.assertEqual(reads[0], at)

    def test_fractional_narrow_rect_still_rejects_an_integer_center_outside_itself(self):
        with tempfile.TemporaryDirectory() as directory, KeyHarness(self, directory) as h:
            h.value = ''
            self.set_source(h, lambda raw: overlay(raw, 'narrow'))
            with self.assertRaisesRegex(MobileError, 'VISUAL_COORDINATES_UNVERIFIED'):
                h.run('a')
            self.assertEqual(h.physical, [])
            self.assertEqual(h.session.budget.count, 1)


if __name__ == '__main__':
    unittest.main()
