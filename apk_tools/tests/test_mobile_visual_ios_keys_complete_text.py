"""Pure mocked acceptance of an explicit final-echo policy; no device or OCR."""
import copy
import tempfile
import unittest
from unittest.mock import patch

from apk_inventory import mobile_visual_ios_keys as keys
from apk_inventory import mobile_visual_ios_keyboard as keyboard
from apk_inventory.mobile_ui import MobileError, digest
from test_mobile_visual_ios_keys import DEF, INPUT, KEY_PLAN, KeyHarness
from test_mobile_visual_ios_keyboard import session


def plan(confirmation='complete_text', clear_plan=None):
    value = copy.deepcopy(KEY_PLAN)
    value['keyInput']['confirmation'] = confirmation
    if clear_plan is not None:
        value['keyInput']['clearPlan'] = clear_plan
    return value


class CompleteHarness(KeyHarness):
    def __init__(self, test, directory, **options):
        super().__init__(test, directory, plan=options.pop('plan', plan()), **options)
        self.value = ''

    def observation(self):
        if self.options.get('stateError') and self.physical:
            raise MobileError(self.options['stateError'])
        image = super().observation()
        omit = self.options.get('omitUpTo', 0)
        if self.visible and 0 < len(self.value) <= omit:
            image['tokens'] = [token for token in image['tokens'] if token['text'] != self.value]
        if self.visible and self.value == self.options.get('wrongFinal'):
            for token in image['tokens']:
                if token['text'] == self.value:
                    token['text'] = 'other'
        if self.physical and self.physical[-1] == 'shift' and self.options.get('postSwitchConflict'):
            # The already observed OCR frame is conflicting. A subsequent
            # _fresh_key capture would recover, which must not hide this frame.
            image[self.options['postSwitchConflict']] = 'transient-conflict'
        return image


class CompleteTextTests(unittest.TestCase):
    def outside(self, harness):
        return [body for route, body in harness.calls if route == '/actions' and body['actions'][0]['id'] != keys.POINTER_ID]

    def test_confirmation_is_local_exact_digest_and_session_identity_bound(self):
        self.assertIs(keys.key_input_contract(INPUT, DEF), INPUT)
        for confirmation in ('each_prefix', 'complete_text'):
            value = plan(confirmation)
            self.assertIs(keyboard.keyboard_contract(value, DEF), value)
        for invalid in ('auto', '', None, True, {}, []):
            with self.subTest(confirmation=invalid), self.assertRaisesRegex(MobileError, 'VISUAL_KEY_INPUT_CONFIG_INVALID'):
                keyboard.keyboard_contract(plan(invalid), DEF)
        self.assertNotEqual(digest(KEY_PLAN), digest(plan()))
        with tempfile.TemporaryDirectory() as directory:
            self.assertNotEqual(session(directory, plan=KEY_PLAN).identity, session(directory, plan=plan()).identity)

    def test_clear_plan_is_explicit_local_exact_and_revision_bound(self):
        fixed = plan(clear_plan='fixed_max_length')
        observed = plan(clear_plan='observed_shortening')
        self.assertIs(keyboard.keyboard_contract(fixed, DEF), fixed)
        self.assertIs(keyboard.keyboard_contract(observed, DEF), observed)
        self.assertNotEqual(digest(fixed), digest(plan()))
        for invalid in ('auto', '', True, {}, []):
            with self.subTest(clear_plan=invalid), self.assertRaisesRegex(MobileError, 'VISUAL_KEY_INPUT_CONFIG_INVALID'):
                keyboard.keyboard_contract(plan(clear_plan=invalid), DEF)
        invalid = plan()
        invalid['keyInput']['clearPlan'] = None
        with self.assertRaisesRegex(MobileError, 'VISUAL_KEY_INPUT_CONFIG_INVALID'):
            keyboard.keyboard_contract(invalid, DEF)

    def test_missing_intermediate_prefixes_are_not_retried_and_complete_echo_is_required(self):
        with tempfile.TemporaryDirectory() as directory, CompleteHarness(self, directory, omitUpTo=4) as h:
            self.assertEqual(h.run('alpha'), {'text': 'RESULT alpha 1'})
            self.assertEqual(h.physical, list('alpha'))
            self.assertEqual(len(self.outside(h)), 3)
            self.assertEqual(h.session.budget.count, 8)
            self.assertEqual(len(h.observations), 9)  # before/focus + five keys + restored/result

    def test_default_and_explicit_each_prefix_still_reject_the_first_missing_prefix(self):
        for current in (KEY_PLAN, plan('each_prefix')):
            with self.subTest(plan=current), tempfile.TemporaryDirectory() as directory, CompleteHarness(self, directory, plan=current, omitUpTo=4) as h:
                with self.assertRaisesRegex(MobileError, 'VISUAL_INPUT_NOT_VERIFIED') as caught:
                    h.run('alpha')
                self.assertEqual(h.physical, ['a'])
                self.assertEqual(len(self.outside(h)), 1)
                self.assertEqual(caught.exception.writeOutcome, {'status': 'unknown', 'automaticRetry': False})

    def test_wrong_or_ignored_final_echo_never_dismisses_or_submits_and_is_unknown(self):
        for options in ({'wrongFinal': 'alpha'}, {'inputIgnored': True}):
            with self.subTest(options=options), tempfile.TemporaryDirectory() as directory, CompleteHarness(self, directory, **options) as h:
                with self.assertRaisesRegex(MobileError, 'VISUAL_INPUT_NOT_VERIFIED') as caught:
                    h.run('alpha')
                self.assertEqual(h.physical, list('alpha'))
                self.assertEqual(len(self.outside(h)), 1)
                self.assertEqual(caught.exception.writeOutcome, {'status': 'unknown', 'automaticRetry': False})

    def test_a_single_unrecognized_a_is_final_and_must_still_fail(self):
        with tempfile.TemporaryDirectory() as directory, CompleteHarness(self, directory, omitUpTo=1) as h:
            with self.assertRaisesRegex(MobileError, 'VISUAL_INPUT_NOT_VERIFIED'):
                h.run('a')
            self.assertEqual(h.physical, ['a'])
            self.assertEqual(len(self.outside(h)), 1)

    def test_switch_compares_the_two_observed_frames_before_any_recovery_capture(self):
        for conflict in ('_valuePixels', '_bodyPixels'):
            for confirmation in ('complete_text', 'each_prefix'):
                with self.subTest(conflict=conflict, confirmation=confirmation), tempfile.TemporaryDirectory() as directory, CompleteHarness(self, directory, plan=plan(confirmation), postSwitchConflict=conflict) as h:
                    with self.assertRaisesRegex(MobileError, 'VISUAL_FRAME_CHANGED') as caught:
                        h.run('A')
                    self.assertEqual(h.physical, ['shift'])
                    self.assertEqual(len(self.outside(h)), 1)
                    self.assertEqual(h.captures[-1]['_valuePixels'], '')
                    self.assertEqual(h.captures[-1]['_bodyPixels'], 'original')
                    self.assertEqual(caught.exception.writeOutcome, {'status': 'unknown', 'automaticRetry': False})

    def test_mixed_layers_use_full_fresh_observations_without_missing_prefix_recovery_actions(self):
        with tempfile.TemporaryDirectory() as directory, CompleteHarness(self, directory, omitUpTo=3) as h:
            self.assertEqual(h.run('Ab7z'), {'text': 'RESULT Ab7z 1'})
            self.assertEqual(h.physical, ['shift', 'A', 'b', 'numbers', '7', 'letters', 'z'])
            self.assertEqual(len(self.outside(h)), 3)
            self.assertEqual(h.session.budget.count, 10)
            self.assertGreaterEqual(len(h.observations), 11)

    def test_full_ocr_source_orientation_errors_are_not_swallowed_as_intermediate_text(self):
        for code in ('VISUAL_OCR_FAILED', 'VISUAL_PROVENANCE_INVALID', 'VISUAL_COORDINATES_UNVERIFIED', 'VISUAL_LAYOUT_CHANGED'):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory, CompleteHarness(self, directory, stateError=code) as h:
                with self.assertRaisesRegex(MobileError, code):
                    h.run('alpha')
                self.assertEqual(h.physical, ['a'])
                self.assertEqual(len(self.outside(h)), 1)
        with tempfile.TemporaryDirectory() as directory, CompleteHarness(self, directory) as h:
            original = keys.region_text
            def check(observation, region):
                if h.physical:
                    raise MobileError('VISUAL_TEXT_BOUNDARY')
                return original(observation, region)
            with patch.object(keys, 'region_text', side_effect=check), self.assertRaisesRegex(MobileError, 'VISUAL_TEXT_BOUNDARY'):
                h.run('alpha')
            self.assertEqual(h.physical, ['a'])

    def test_clear_shorten_and_empty_proof_are_unchanged(self):
        with tempfile.TemporaryDirectory() as directory, CompleteHarness(self, directory, deleteNoop=True) as h:
            h.value = 'old'
            with self.assertRaisesRegex(MobileError, 'VISUAL_INPUT_CLEAR_NOT_VERIFIED'):
                h.run('alpha')
            self.assertEqual(h.physical, ['delete'])
            self.assertEqual(len(self.outside(h)), 1)

    def test_fixed_plan_performs_exactly_sixteen_deletes_despite_empty_or_missing_intermediate_ocr(self):
        for old in ('', 'a'):
            with self.subTest(old=old), tempfile.TemporaryDirectory() as directory, CompleteHarness(self, directory, plan=plan(clear_plan='fixed_max_length'), omitUpTo=1) as h:
                h.value = old
                self.assertEqual(h.run('alpha'), {'text': 'RESULT alpha 1'})
                self.assertEqual(h.physical, ['delete'] * 16 + list('alpha'))
                self.assertEqual(h.session.budget.count, 24)
                self.assertEqual(len(self.outside(h)), 3)

    def test_fixed_plan_noop_or_overlong_existing_value_fails_final_empty_proof_before_typing(self):
        for options, old in [({'deleteNoop': True}, 'old'), ({}, 'x' * 32)]:
            with self.subTest(options=options, old=old), tempfile.TemporaryDirectory() as directory, CompleteHarness(self, directory, plan=plan(clear_plan='fixed_max_length'), **options) as h:
                h.value = old
                with self.assertRaisesRegex(MobileError, 'VISUAL_INPUT_CLEAR_NOT_VERIFIED') as caught:
                    h.run('alpha')
                self.assertEqual(h.physical, ['delete'] * 16)
                self.assertEqual(len(self.outside(h)), 1)
                self.assertEqual(caught.exception.writeOutcome, {'status': 'unknown', 'automaticRetry': False})

    def test_fixed_plan_process_error_at_nth_delete_stops_without_retry_or_typing(self):
        with tempfile.TemporaryDirectory() as directory, CompleteHarness(self, directory, plan=plan(clear_plan='fixed_max_length')) as h:
            original = h.observation
            def observation():
                if len(h.physical) == 5:
                    raise MobileError('VISUAL_OCR_FAILED')
                return original()
            h.observation = observation
            with self.assertRaisesRegex(MobileError, 'VISUAL_OCR_FAILED') as caught:
                h.run('alpha')
            self.assertEqual(h.physical, ['delete'] * 5)
            self.assertEqual(h.session.budget.count, 6)
            self.assertEqual(caught.exception.writeOutcome, {'status': 'unknown', 'automaticRetry': False})

    def test_two_learning_samples_fit_the_unchanged_fifty_action_budget_exactly_forty_seven(self):
        with tempfile.TemporaryDirectory() as directory, CompleteHarness(self, directory, plan=plan(clear_plan='fixed_max_length'), maxActions=50) as h:
            self.assertEqual(h.run('alpha'), {'text': 'RESULT alpha 1'})
            learned = h.contracts
            self.assertEqual(h.run('beta', learned), {'text': 'RESULT beta 2'})
            self.assertEqual(h.physical, ['delete'] * 16 + list('alpha') + ['delete'] * 16 + list('beta'))
            self.assertEqual(h.session.budget.count, 47)
            self.assertEqual(h.session.budget.max_actions, 50)
            self.assertEqual(len(self.outside(h)), 6)


if __name__ == '__main__':
    unittest.main()
