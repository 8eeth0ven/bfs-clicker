"""Real WDA emits native segmented selection as accessibility traits, not selected."""
import unittest
from apk_inventory.mobile_ui import parse_tree, selection_members, selection_state, MobileError

APP = 'com.example.bfsmcp.ioscontrols'

def tree(first='traits="Selected, Button"', second='traits="Button"'):
    return parse_tree(f'''<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="{APP}">
      <XCUIElementTypeSegmentedControl type="XCUIElementTypeSegmentedControl" name="StatusGroup" enabled="true" visible="true">
        <XCUIElementTypeButton type="XCUIElementTypeButton" name="All" enabled="true" visible="true" {first}/>
        <XCUIElementTypeButton type="XCUIElementTypeButton" name="Open" enabled="true" visible="true" {second}/>
      </XCUIElementTypeSegmentedControl></XCUIElementTypeApplication></AppiumAUT>''', 'ios', APP)

class RealWdaSegmentedTraitsTests(unittest.TestCase):
    def test_standard_real_wda_traits_prove_complete_exclusive_group(self):
        observed = tree()
        group = next(node for node in observed['nodes'] if node['selectionGroupKind'])
        members = selection_members(observed, group)
        self.assertEqual([node['selectionState'] for node in members], [True, False])
        action = {'selector': {'accessibilityId': 'StatusGroup'}, 'options': [{'value': 'all', 'selector': {'accessibilityId': 'All'}}, {'value': 'open', 'selector': {'accessibilityId': 'Open'}}]}
        self.assertEqual(selection_state(observed, action)['selected'], 'all')

    def test_missing_traits_never_invent_false_or_complete_domain(self):
        observed = tree(second='')
        self.assertIsNone(next(node for node in observed['nodes'] if node['accessibilityId'] == 'Open')['selectionState'])

    def test_explicit_selected_has_priority_and_invalid_selected_stays_unknown(self):
        observed = tree(first='selected="false" traits="Selected, Button"', second='selected="invalid" traits="Button"')
        self.assertIs(next(node for node in observed['nodes'] if node['accessibilityId'] == 'All')['selectionState'], False)
        self.assertIsNone(next(node for node in observed['nodes'] if node['accessibilityId'] == 'Open')['selectionState'])

    def test_selected_substrings_are_not_selected_tokens(self):
        observed = tree(first='traits="NotSelected, Button"', second='traits="Selected, Button"')
        self.assertIs(next(node for node in observed['nodes'] if node['accessibilityId'] == 'All')['selectionState'], False)
        self.assertIs(next(node for node in observed['nodes'] if node['accessibilityId'] == 'Open')['selectionState'], True)

    def test_multiple_selected_traits_do_not_pass_exclusivity(self):
        observed = tree(second='traits="Selected, Button"')
        action = {'selector': {'accessibilityId': 'StatusGroup'}, 'options': [{'value': 'all', 'selector': {'accessibilityId': 'All'}}, {'value': 'open', 'selector': {'accessibilityId': 'Open'}}]}
        with self.assertRaises(MobileError) as error:
            selection_state(observed, action)
        self.assertEqual(error.exception.code, 'SELECT_EXCLUSIVE_STATE_INVALID')

    def test_value_alone_never_becomes_selected(self):
        observed = tree(first='value="1"', second='value="0"')
        self.assertTrue(all(node['selectionState'] is None for node in observed['nodes'] if node['selectionOptionKind']))

if __name__ == '__main__':
    unittest.main()
