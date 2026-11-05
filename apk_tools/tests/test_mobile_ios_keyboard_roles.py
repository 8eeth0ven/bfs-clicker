"""Native semantic form role boundaries, using only synthetic XML and stdlib.

KeyboardKey is a declared role, including when provided by an app. Excluding
that role from form planning neither proves OS ownership nor grants key access.
"""
import copy
from types import SimpleNamespace
import unittest
from unittest.mock import Mock
import xml.etree.ElementTree as ET

from apk_inventory.mobile_planner import _classify
from apk_inventory.mobile_stages import inspect_stage
from apk_inventory.mobile_ui import (Budget, MobileError, MobileSession,
                                     WebDriverBackend, locate, parse_tree)


APP = 'com.example.native_roles'
FORM = '''<AppiumAUT>
  <Application type="XCUIElementTypeApplication" bundleId="com.example.native_roles">
    <Other type="XCUIElementTypeOther" name="form">
      <TextField type="XCUIElementTypeTextField" name="query" value="seed-query"/>
      <SegmentedControl type="XCUIElementTypeSegmentedControl" name="route">
        <Button type="XCUIElementTypeButton" name="left" traits="Selected, Button"/>
        <Button type="XCUIElementTypeButton" name="right" traits="Button"/>
      </SegmentedControl>
      <Button type="XCUIElementTypeButton" name="next" label="Next" accessible="true"/>
    </Other>
  </Application>
</AppiumAUT>'''


def configured_session():
    identify = lambda name: {'accessibilityId': name}
    actions = [('type', 'query'), ('select', 'route'), ('check', 'left'),
               ('check', 'right'), ('click', 'next')]
    value = SimpleNamespace(config={
        'actionAllowlist': [{'kind': kind, 'selector': identify(name), 'effect': 'read'}
                            for kind, name in actions],
        'nativeStagePlanning': {'workflowId': 'lookup', 'seedInputs': [
            {'kind': 'type', 'selector': identify('query'), 'value': 'seed-query'},
            {'kind': 'select', 'selector': identify('route'), 'value': 'left'}]}})
    value.policy = lambda action: MobileSession.policy(value, action)
    return value


def with_accessory(fragment):
    root = ET.fromstring(FORM)
    application = next(node for node in root if node.attrib.get('type') == 'XCUIElementTypeApplication')
    application.append(ET.fromstring(fragment))
    return ET.tostring(root, encoding='unicode')


class NativeIosKeyboardRoleTests(unittest.TestCase):
    def inspect(self, xml):
        tree = parse_tree(xml, 'ios', APP)
        session = configured_session()
        gaps = set()
        inputs, buttons, _ = _classify(session, tree, gaps)
        stage = inspect_stage(session, tree)
        self.assertEqual(gaps, set())
        self.assertEqual({row['selector']['accessibilityId'] for row in inputs}, {'query', 'route'})
        self.assertEqual([row['selector'] for row in buttons], [{'accessibilityId': 'next'}])
        return tree, stage

    def assert_code(self, expected, callback):
        with self.assertRaises(MobileError) as raised:
            callback()
        self.assertEqual(raised.exception.code, expected)

    def test_keyboard_accessories_preserve_the_app_form_contract(self):
        # WDA can expose these role nodes outside the Keyboard class subtree.
        xml = with_accessory('''<Other name="input-assistant">
          <Button type="XCUIElementTypeButton" name="dictation" traits="KeyboardKey, Button"/>
          <Button type="XCUIElementTypeButton" name="dictation" traits="KeyboardKey, Button"/>
          <Cell type="XCUIElementTypeCell" name="candidate" traits="KeyboardKey, Button">
            <StaticText type="XCUIElementTypeStaticText" name="candidate" label="candidate"/>
          </Cell>
        </Other>''')
        original, expected = self.inspect(FORM)
        observed, actual = self.inspect(xml)
        self.assertEqual(actual, expected)
        for name in ['query', 'route', 'left', 'right', 'next']:
            self.assertEqual(locate(observed, {'accessibilityId': name}),
                             locate(original, {'accessibilityId': name}))

    def test_ordinary_duplicates_and_similar_traits_still_block(self):
        cases = [('dictation', ''), ('KeyboardKey', ''), ('duplicate', 'NotKeyboardKey'),
                 ('duplicate', 'KeyboardKeySuffix'), ('duplicate', 'PrefixKeyboardKey'),
                 ('duplicate', 'keyboardkey'), ('duplicate', 'Keyboard Key'),
                 ('duplicate', 'KeyboardKey Button'), ('duplicate', 'Button, NotKeyboardKey')]
        for name, traits in cases:
            with self.subTest(name=name, traits=traits):
                root = ET.Element('Other')
                for _ in range(2):
                    ET.SubElement(root, 'Button', type='XCUIElementTypeButton', name=name, traits=traits)
                tree = parse_tree(with_accessory(ET.tostring(root, encoding='unicode')), 'ios', APP)
                self.assert_code('SELECTOR_AMBIGUOUS', lambda: locate(tree, {'accessibilityId': name}))
                self.assert_code('NATIVE_STAGE_CONTROLS_NOT_PROVEN',
                                 lambda: inspect_stage(configured_session(), tree))

    def test_exact_role_tokens_exclude_the_whole_declared_subtree(self):
        traits = ['KeyboardKey', 'KeyboardKey, Button', 'Button, KeyboardKey',
                  'Button, KeyboardKey, StaticText', ' Button ,  KeyboardKey , StaticText ',
                  'Button,\tKeyboardKey\r\n, StaticText']
        for role in traits:
            with self.subTest(traits=role):
                root = ET.Element('Other', type='XCUIElementTypeOther', name='app-key', traits=role)
                ET.SubElement(root, 'Button', type='XCUIElementTypeButton', name='traitless-child')
                tree, actual = self.inspect(with_accessory(ET.tostring(root, encoding='unicode')))
                self.assertEqual(actual, self.inspect(FORM)[1])
                for name in ['app-key', 'traitless-child']:
                    self.assert_code('SELECTOR_NOT_FOUND', lambda: locate(tree, {'accessibilityId': name}))

    def test_declared_role_and_traitless_children_cannot_dispatch_actions(self):
        # This is an app-declared role; the test makes no system identity claim.
        xml = with_accessory('''<Button type="XCUIElementTypeButton" name="app-key" traits="KeyboardKey">
          <TextField type="XCUIElementTypeTextField" name="key-input" value="private"/>
          <Button type="XCUIElementTypeButton" name="key-button"/>
        </Button>''')
        tree = parse_tree(xml, 'ios', APP)
        for kind, name in [('click', 'app-key'), ('type', 'key-input'), ('click', 'key-button')]:
            with self.subTest(kind=kind, name=name):
                backend = WebDriverBackend({'appId': APP, 'platform': 'ios',
                                            'url': 'http://localhost', 'sessionId': 'offline'}, Budget({}))
                backend.foreground = Mock()
                backend.request = Mock(return_value=[{'element-6066-11e4-a52e-4f735466cecf': 'element'}])
                backend._type_verified = Mock()
                self.assert_code('SELECTOR_NOT_FOUND', lambda: backend.perform(
                    {'kind': kind, 'selector': {'accessibilityId': name}, 'input': 'text', 'replace': True},
                    tree, {'text': 'unsubmitted'}))
                backend.request.assert_not_called()
                backend._type_verified.assert_not_called()

    def test_app_target_survives_a_keyboard_role_name_collision(self):
        xml = with_accessory('''<Other traits="KeyboardKey">
          <TextField type="XCUIElementTypeTextField" name="query" value="shadow"/>
          <Button type="XCUIElementTypeButton" name="next"/>
        </Other>''')
        tree, stage = self.inspect(xml)
        self.assertEqual(stage, self.inspect(FORM)[1])
        self.assertEqual(locate(tree, {'accessibilityId': 'query'})['className'], 'XCUIElementTypeTextField')
        self.assertEqual(locate(tree, {'accessibilityId': 'next'})['className'], 'XCUIElementTypeButton')

    def test_existing_keyboard_class_boundary_is_preserved(self):
        xml = with_accessory('''<Keyboard type="XCUIElementTypeKeyboard">
          <TextField type="XCUIElementTypeTextField" name="query" value="shadow"/>
          <Button type="XCUIElementTypeButton" name="next"/>
        </Keyboard>''')
        tree, stage = self.inspect(xml)
        self.assertEqual(stage, self.inspect(FORM)[1])
        self.assertFalse(any(node['className'] == 'XCUIElementTypeKeyboard' for node in tree['nodes']))

    def test_ios_role_boundary_does_not_change_android_controls(self):
        xml = '''<hierarchy>
          <node class="android.widget.EditText" resource-id="app:id/query" text="exact" traits="KeyboardKey"/>
          <node class="android.widget.Button" resource-id="app:id/search" clickable="true" traits="KeyboardKey">
            <node class="android.widget.TextView" resource-id="app:id/child" text="child"/>
          </node>
        </hierarchy>'''
        tree = parse_tree(xml, 'android', APP)
        for name in ['query', 'search', 'child']:
            self.assertEqual(locate(tree, {'resourceId': 'app:id/' + name})['resourceId'], 'app:id/' + name)
        self.assertEqual(tree, parse_tree(xml.replace(' traits="KeyboardKey"', ''), 'android', APP))

    def test_ordinary_input_and_selection_guards_remain_strict(self):
        for defect in ['readonly', 'duplicate-query', 'multiple-selected', 'unknown-state', 'missing-option']:
            with self.subTest(defect=defect):
                root = ET.fromstring(FORM)
                query = next(node for node in root.iter() if node.attrib.get('name') == 'query')
                right = next(node for node in root.iter() if node.attrib.get('name') == 'right')
                group = next(node for node in root.iter() if node.attrib.get('name') == 'route')
                if defect == 'readonly':
                    query.set('readOnly', 'true')
                elif defect == 'duplicate-query':
                    next(node for node in root.iter() if node.attrib.get('name') == 'form').append(copy.deepcopy(query))
                elif defect == 'multiple-selected':
                    right.set('traits', 'Selected, Button')
                elif defect == 'unknown-state':
                    right.attrib.pop('traits')
                else:
                    group.remove(right)
                tree = parse_tree(ET.tostring(root, encoding='unicode'), 'ios', APP)
                self.assert_code('NATIVE_STAGE_CONTROLS_NOT_PROVEN',
                                 lambda: inspect_stage(configured_session(), tree))


if __name__ == '__main__':
    unittest.main()
