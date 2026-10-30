"""Mocked transport/OCR tests; these are explicitly not iOS device evidence."""
import copy
import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from apk_inventory import mobile_visual_ios_text as visual
from apk_inventory.mobile_ui import MobileError, MobileSession, WebDriverBackend, digest


DEF = {
    "kind": "native-visual-workflow", "schemaVersion": 1, "mode": "text-replace",
    "id": "query", "name": "iOS visual text fixture", "effect": "read", "inputName": "query",
    "inputSchema": {"type": "string", "minLength": 1, "maxLength": 16, "pattern": "^[A-Za-z0-9]+$"},
    "focusAnchor": "Query", "submitAnchor": "Search",
    "valueRegion": {"x": .4, "y": .1, "width": .5, "height": .1},
    "resultRegion": {"x": .1, "y": .6, "width": .8, "height": .1}, "resultPrefix": "RESULT",
}


def session(output, definition=None):
    approved = Path(output) / "approved.json"
    approved.write_text(json.dumps(definition or DEF))
    return MobileSession({
        "source": {"id": "ios_fixture", "kind": "ios"},
        "backend": {"type": "webdriver", "platform": "ios", "appId": "com.example.fixture",
                    "url": "http://127.0.0.1:1", "sessionId": "mocked-not-real"},
        "actionAllowlist": [],
        "nativeVisualWorkflow": {"enabled": True, "node": "/usr/bin/env", "allowedWorkflows": ["query"],
                                 "approvedDefinitions": {"query": str(approved)}},
    }, Path(output))


def observation(value, result="RESULT NONE"):
    def token(text, x, y, width):
        return {"text": text, "confidence": .99, "bounds": {"x": x, "y": y, "width": width, "height": 20}}
    words = [token("Query", 30, 65, 50), token("Search", 30, 215, 60)]
    if value:
        words.append(token(value, 135, 65, 100))
    for index, text in enumerate(result.split()):
        words.append(token(text, 40 + index * 90, 370, 80))
    return {"width": 300, "height": 600, "tokens": words, "_imagePath": "mocked-not-real.png"}


class TransportHarness:
    """Run production sequencing/grounding with fabricated OCR and WDA replies."""
    def __init__(self, test, output, observations, fail_path=None, definition=None):
        self.definition = copy.deepcopy(definition or DEF)
        self.session = session(output, self.definition)
        self.calls = []
        self.fail_path = fail_path
        backend = self.session.backend
        backend.foreground = lambda: None
        backend.verify_artifact = lambda: backend.artifact_verification
        self.test = test
        self.observations = observations

        def request(method, path, body=None):
            if path in ("/actions", "/execute/sync", "/keys"):
                intent = json.loads((self.session.output / "write-intent.json").read_text())
                test.assertEqual(intent["status"], "unknown")
                test.assertFalse(intent["automaticRetry"])
                test.assertTrue(self.session._visual_dispatched)
                self.calls.append((method, path, body))
                if path == self.fail_path:
                    raise MobileError("WEBDRIVER_COMMAND_UNSUPPORTED", "unsupported")
                return None
            if path == "/orientation":
                return "PORTRAIT"
            if path == "/window/rect":
                return {"x": 0, "y": 0, "width": 100, "height": 200}
            raise AssertionError("Unexpected route " + path)
        backend.request = request

    def __enter__(self):
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(visual, "_observe", side_effect=self.observations))
        self.stack.enter_context(patch.object(visual.ios, "_masked", return_value="a" * 64))
        self.fresh = self.stack.enter_context(patch.object(visual, "unchanged_locked"))
        self.stack.enter_context(patch.object(visual.time, "sleep"))
        return self

    def run(self, contracts=None, text="alpha"):
        self.contracts = contracts if contracts is not None else {}
        return visual._text_run(self.session, object(), self.session.config["nativeVisualWorkflow"], self.definition,
                                {"query": text}, self.contracts)

    def __exit__(self, *args):
        self.stack.__exit__(*args)


class DefinitionTests(unittest.TestCase):
    def test_exact_ios_text_contract_and_bounded_input_schema(self):
        self.assertEqual(visual.definition_contract(copy.deepcopy(DEF)), DEF)
        for change in ({"activity": "com.example.AndroidOnly"}, {"schemaVersion": True},
                       {"inputSchema": {**DEF["inputSchema"], "maxLength": 129}},
                       {"inputSchema": {**DEF["inputSchema"], "maxLength": True}},
                       {"inputSchema": {**DEF["inputSchema"], "pattern": "^(a+)+$"}}):
            with self.subTest(change=change), self.assertRaises(MobileError):
                visual.definition_contract({**copy.deepcopy(DEF), **change})

    def test_regions_must_be_disjoint_and_anchors_distinct(self):
        for change in ({"resultRegion": DEF["valueRegion"]}, {"focusAnchor": "Search"}):
            with self.subTest(change=change), self.assertRaises(MobileError):
                visual.definition_contract({**copy.deepcopy(DEF), **change})

    def test_bad_values_rejected_and_unicode_opt_in_does_not_claim_device_support(self):
        self.assertEqual(visual._text_value(DEF, {"query": "alpha"}), "alpha")
        for value in ({}, {"query": "alpha", "extra": "x"}, {"query": ""}, {"query": "中文"}, {"query": "x" * 17}):
            with self.subTest(value=value), self.assertRaises(MobileError):
                visual._text_value(DEF, value)
        unicode_def = {**DEF, "inputSchema": {**DEF["inputSchema"], "pattern": "^[\\u4e00-\\u9fff]+$"}}
        self.assertEqual(visual._text_value(unicode_def, {"query": "中文"}), "中文")

    def test_control_and_webdriver_special_keys_cannot_enter_text_transport(self):
        permissive = {**DEF, "inputSchema": {**DEF["inputSchema"], "pattern": "^[\\s\\S]+$"}}
        for value in ("a\n", "a\0", "\b", "\u0085", "\ue003", "\u2028", "\ud800"):
            with self.subTest(value=repr(value)), self.assertRaisesRegex(MobileError, "VISUAL_TEXT_INPUT_INVALID"):
                visual._text_value(permissive, {"query": value})


class ConfigTests(unittest.TestCase):
    def test_full_definition_approval_and_optional_ocr(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = session(tmp)
            config = current.config["nativeVisualWorkflow"]
            self.assertIs(visual.config_contract(current, DEF, True), config)
            config["ocr"] = {"engine": {"type": "vision"}, "language": "chi_sim+eng"}
            self.assertIs(visual.config_contract(current, DEF, True), config)
            with self.assertRaisesRegex(MobileError, "VISUAL_DEFINITION_NOT_APPROVED"):
                visual.config_contract(current, {**DEF, "submitAnchor": "Other"}, True)

    def test_wrong_source_platform_or_artifact_claim_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = session(tmp)
            current.source["kind"] = "apk"
            with self.assertRaisesRegex(MobileError, "VISUAL_PLATFORM_UNSUPPORTED"):
                visual.config_contract(current, DEF, True)
            current.source["kind"] = "ios"
            current.backend.platform = "android"
            with self.assertRaisesRegex(MobileError, "VISUAL_PLATFORM_UNSUPPORTED"):
                visual.config_contract(current, DEF, True)
            current.backend.platform = "ios"
            current.config["expectedArtifact"] = {"kind": "apk", "sha256": "a" * 64}
            with self.assertRaisesRegex(MobileError, "VISUAL_ARTIFACT_VERIFICATION_UNSUPPORTED"):
                visual.config_contract(current, DEF, True)

    def test_write_execution_and_learning_grants_remain_independent(self):
        with tempfile.TemporaryDirectory() as tmp:
            definition = {**DEF, "effect": "write"}
            current = session(tmp, definition)
            with self.assertRaisesRegex(MobileError, "WORKFLOW_WRITE_NOT_APPROVED"):
                visual.config_contract(current, definition, True)
            current.config["workflowPermissions"] = {"allowWrite": ["query"], "allowWriteLearning": []}
            visual.config_contract(current, definition, False)
            with self.assertRaisesRegex(MobileError, "WORKFLOW_WRITE_LEARNING_NOT_APPROVED"):
                visual.config_contract(current, definition, True)
            current.config["workflowPermissions"]["allowWriteLearning"] = ["query"]
            visual.config_contract(current, definition, True)


class TransportTests(unittest.TestCase):
    def sequence(self, after="RESULT alpha", filled="RESULT NONE", text="alpha"):
        return [observation("old"), observation("old"), observation("old"), observation(""), observation(text, filled), observation(text, after)]

    def test_mocked_success_requires_echo_and_post_submit_result_with_one_dispatch_each(self):
        with tempfile.TemporaryDirectory() as tmp, TransportHarness(self, tmp, self.sequence()) as harness:
            self.assertEqual(harness.run(), {"text": "RESULT alpha"})
            self.assertEqual([call[1] for call in harness.calls], ["/actions", "/execute/sync", "/keys", "/keys", "/actions"])
            self.assertEqual(harness.calls[1][2], {"script": "mobile: keys", "args": [{"keys": [{"key": "a", "modifierFlags": 16}, "XCUIKeyboardKeyDelete"]}]})
            self.assertEqual(harness.calls[2][2], {"value": ["\b" * 16]})
            self.assertEqual(harness.calls[3][2], {"value": ["alpha"]})
            self.assertEqual(set(harness.contracts), {"focus", "submit", "_pixels"})
            self.assertEqual(harness.fresh.call_count, 6)
            self.assertFalse(harness.session.backend.artifact_verification["status"] == "verified")

    def test_successful_clear_receipt_with_unchanged_text_never_types_or_submits(self):
        with tempfile.TemporaryDirectory() as tmp, TransportHarness(self, tmp, [observation("old")] * 4) as harness:
            with self.assertRaisesRegex(MobileError, "VISUAL_INPUT_CLEAR_NOT_VERIFIED") as caught:
                harness.run()
            self.assertEqual([call[1] for call in harness.calls], ["/actions", "/execute/sync", "/keys"])
            self.assertEqual(caught.exception.writeOutcome, {"status": "unknown", "automaticRetry": False})

    def test_bounded_clear_is_always_planned_from_trusted_maximum_including_empty_selection(self):
        for maximum, text in ((1, "a"), (128, "alpha")):
            definition = {**copy.deepcopy(DEF), "inputSchema": {**DEF["inputSchema"], "maxLength": maximum}}
            for selected in ("old", ""):
                observations = self.sequence(after="RESULT " + text, text=text)
                observations[2] = observation(selected)
                with self.subTest(maximum=maximum, selected=selected), tempfile.TemporaryDirectory() as tmp:
                    with TransportHarness(self, tmp, observations, definition=definition) as harness:
                        self.assertEqual(harness.run(text=text), {"text": "RESULT " + text})
                        self.assertEqual(harness.calls[2][1:], ("/keys", {"value": ["\b" * maximum]}))
                        # One bounded deletion request regardless of the select-all
                        # result, followed by one typing request; no fallback loop.
                        self.assertEqual([call[1] for call in harness.calls].count("/keys"), 2)

    def test_stale_selection_frame_prevents_bounded_delete_dispatch(self):
        with tempfile.TemporaryDirectory() as tmp, TransportHarness(self, tmp, self.sequence()) as harness:
            harness.fresh.side_effect = [None, None, MobileError("VISUAL_FRAME_CHANGED")]
            with self.assertRaisesRegex(MobileError, "VISUAL_FRAME_CHANGED") as caught:
                harness.run()
            self.assertEqual([call[1] for call in harness.calls], ["/actions", "/execute/sync"])
            self.assertEqual(caught.exception.writeOutcome, {"status": "unknown", "automaticRetry": False})

    def test_unsupported_bounded_delete_has_no_typing_submit_or_retry(self):
        with tempfile.TemporaryDirectory() as tmp, TransportHarness(self, tmp, self.sequence(), fail_path="/keys") as harness:
            with self.assertRaisesRegex(MobileError, "WEBDRIVER_COMMAND_UNSUPPORTED") as caught:
                harness.run()
            self.assertEqual([call[1] for call in harness.calls], ["/actions", "/execute/sync", "/keys"])
            self.assertEqual(caught.exception.writeOutcome, {"status": "unknown", "automaticRetry": False})

    def test_successful_typing_receipt_with_wrong_echo_never_submits(self):
        observations = self.sequence()
        observations[4] = observation("wrong")
        with tempfile.TemporaryDirectory() as tmp, TransportHarness(self, tmp, observations) as harness:
            with self.assertRaisesRegex(MobileError, "VISUAL_INPUT_NOT_VERIFIED") as caught:
                harness.run()
            self.assertEqual([call[1] for call in harness.calls], ["/actions", "/execute/sync", "/keys", "/keys"])
            self.assertFalse(caught.exception.writeOutcome["automaticRetry"])

    def test_typing_auto_update_cannot_prove_noop_submit(self):
        with tempfile.TemporaryDirectory() as tmp, TransportHarness(self, tmp, self.sequence(filled="RESULT alpha")) as harness:
            with self.assertRaisesRegex(MobileError, "VISUAL_RESULT_NOT_VERIFIED") as caught:
                harness.run()
            self.assertEqual(len(harness.calls), 5)
            self.assertEqual(harness.contracts, {})
            self.assertEqual(caught.exception.writeOutcome, {"status": "unknown", "automaticRetry": False})

    def test_expected_value_cannot_be_only_a_result_substring(self):
        with tempfile.TemporaryDirectory() as tmp, TransportHarness(self, tmp, self.sequence(after="RESULT alphabet")) as harness:
            with self.assertRaisesRegex(MobileError, "VISUAL_RESULT_NOT_VERIFIED"):
                harness.run()

    def test_unsupported_select_all_command_is_unknown_without_fallback_or_retry(self):
        with tempfile.TemporaryDirectory() as tmp, TransportHarness(self, tmp, self.sequence(), fail_path="/execute/sync") as harness:
            with self.assertRaisesRegex(MobileError, "WEBDRIVER_COMMAND_UNSUPPORTED") as caught:
                harness.run()
            self.assertEqual([call[1] for call in harness.calls], ["/actions", "/execute/sync"])
            self.assertFalse(caught.exception.writeOutcome["automaticRetry"])

    def test_wrong_foreground_and_stale_first_frame_never_dispatch(self):
        with tempfile.TemporaryDirectory() as tmp, TransportHarness(self, tmp, self.sequence()) as harness:
            harness.session.backend.foreground = lambda: (_ for _ in ()).throw(MobileError("APP_OUT_OF_SCOPE"))
            with self.assertRaisesRegex(MobileError, "APP_OUT_OF_SCOPE") as caught:
                harness.run()
            self.assertFalse(hasattr(caught.exception, "writeOutcome"))
            self.assertEqual(harness.calls, [])
            harness.session.backend.foreground = lambda: None
            harness.fresh.side_effect = MobileError("VISUAL_FRAME_CHANGED")
            with self.assertRaisesRegex(MobileError, "VISUAL_FRAME_CHANGED"):
                harness.run()
            self.assertEqual(harness.calls, [])

    def test_changed_keyboard_layout_stops_before_clear(self):
        with tempfile.TemporaryDirectory() as tmp, TransportHarness(self, tmp, self.sequence()) as harness:
            with patch.object(visual.ios, "_masked", side_effect=["a" * 64, "b" * 64]):
                with self.assertRaisesRegex(MobileError, "VISUAL_LAYOUT_CHANGED") as caught:
                    harness.run()
            self.assertEqual([call[1] for call in harness.calls], ["/actions"])
            self.assertEqual(caught.exception.writeOutcome["status"], "unknown")

    def test_stale_input_frame_prevents_submit_after_typing(self):
        with tempfile.TemporaryDirectory() as tmp, TransportHarness(self, tmp, self.sequence()) as harness:
            harness.fresh.side_effect = [None, None, None, None, MobileError("VISUAL_FRAME_CHANGED")]
            with self.assertRaisesRegex(MobileError, "VISUAL_FRAME_CHANGED") as caught:
                harness.run()
            self.assertEqual([call[1] for call in harness.calls], ["/actions", "/execute/sync", "/keys", "/keys"])
            self.assertEqual(caught.exception.writeOutcome["status"], "unknown")

    def test_ambiguous_or_masked_anchor_prevents_first_dispatch(self):
        duplicate = observation("old")
        duplicate["tokens"].append(copy.deepcopy(duplicate["tokens"][0]))
        with tempfile.TemporaryDirectory() as tmp, TransportHarness(self, tmp, [duplicate]) as harness:
            with self.assertRaisesRegex(MobileError, "VISUAL_ANCHOR_AMBIGUOUS"):
                harness.run()
            self.assertEqual(harness.calls, [])
        overlap = observation("old")
        overlap["tokens"][0]["bounds"]["x"] = 140
        with tempfile.TemporaryDirectory() as tmp, TransportHarness(self, tmp, [overlap]) as harness:
            with self.assertRaisesRegex(MobileError, "VISUAL_MASK_OVERLAPS_ANCHOR"):
                harness.run()
            self.assertEqual(harness.calls, [])

    def test_write_intent_persistence_failure_prevents_first_touch(self):
        with tempfile.TemporaryDirectory() as tmp, TransportHarness(self, tmp, self.sequence()) as harness:
            with patch.object(visual, "atomic_json", side_effect=OSError("mocked storage failure")):
                with self.assertRaises(OSError):
                    harness.run()
            self.assertEqual(harness.calls, [])
            self.assertFalse(getattr(harness.session, "_visual_dispatched", False))


class LearningTests(unittest.TestCase):
    def fake_run(self, current, lease, config, definition, inputs, contracts):
        contracts.update(focus={"anchor": "Query", "width": 300, "height": 600,
                                "normalized": {"x": .1, "y": .1, "width": .2, "height": .05}},
                         submit={"anchor": "Search", "width": 300, "height": 600,
                                 "normalized": {"x": .1, "y": .35, "width": .2, "height": .05}},
                         _pixels="a" * 64)
        return {"text": "RESULT " + inputs["query"]}

    def test_mocked_learning_publishes_schema_without_samples_and_keeps_unverified_artifact(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = session(tmp)
            with patch.object(visual, "DeviceLease") as lease, patch.object(visual, "_text_run", side_effect=self.fake_run):
                result = visual.learn(current, copy.deepcopy(DEF), [{"query": "alpha"}, {"query": "beta"}])
            lease.assert_called_once_with(current.backend)
            manifest = json.loads((Path(tmp) / "manifest.json").read_text())
            recipes_text = (Path(tmp) / "recipes.json").read_text()
            self.assertNotIn("alpha", recipes_text)
            self.assertNotIn("beta", recipes_text)
            self.assertEqual(manifest["capabilities"][0]["inputSchema"]["properties"]["query"], DEF["inputSchema"])
            self.assertIn("ios_text_physical_and_third_party_coverage_pending", manifest["capabilities"][0]["gaps"])
            self.assertFalse(manifest["source"]["appArtifactVerified"])
            self.assertTrue(result["ok"])

    def test_duplicate_inputs_or_results_cannot_publish(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = session(tmp)
            with patch.object(visual, "DeviceLease"), patch.object(visual, "_text_run", return_value={"text": "RESULT same"}) as run:
                with self.assertRaisesRegex(MobileError, "VISUAL_TWO_DISTINCT_SAMPLES_REQUIRED"):
                    visual.learn(current, DEF, [{"query": "alpha"}, {"query": "alpha"}])
                run.assert_not_called()
                with self.assertRaisesRegex(MobileError, "VISUAL_TWO_DISTINCT_RESULTS_REQUIRED"):
                    visual.learn(current, DEF, [{"query": "alpha"}, {"query": "beta"}])
            self.assertEqual(current.progress["capabilities"], {})

    def test_revision_source_and_input_rejected_before_device_lease(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = session(tmp)
            with patch.object(visual, "DeviceLease"), patch.object(visual, "_text_run", side_effect=self.fake_run):
                result = visual.learn(current, DEF, [{"query": "alpha"}, {"query": "beta"}])
            recipe = current.progress["recipes"][result["capabilityId"]]
            with patch.object(visual, "DeviceLease") as lease:
                for change in ({"sourceId": "other"}, {"identity": "different"}, {"definition": {**DEF, "name": "Changed"}}):
                    with self.assertRaisesRegex(MobileError, "VISUAL_RECIPE_REVISION_MISMATCH"):
                        visual.execute(current, {**recipe, **change}, recipe["revision"], {"query": "gamma"})
                with self.assertRaisesRegex(MobileError, "VISUAL_TEXT_INPUT_INVALID"):
                    visual.execute(current, recipe, recipe["revision"], {"query": "bad value"})
                lease.assert_not_called()

    def test_mocked_transport_learning_and_unseen_value_execution_use_production_sequence(self):
        observations = []
        for value, previous in (("alpha", "old"), ("beta", "alpha"), ("gamma", "beta")):
            observations.extend([observation(previous), observation(previous), observation(previous), observation(""),
                                 observation(value), observation(value, "RESULT " + value)])
        with tempfile.TemporaryDirectory() as tmp, TransportHarness(self, tmp, observations) as harness:
            with patch.object(visual, "DeviceLease") as lease:
                # Exercise the real existing iOS entry, including its text-mode
                # dispatch, through the full learned workflow and unseen value.
                learned = visual.ios.learn(harness.session, DEF, [{"query": "alpha"}, {"query": "beta"}])
                recipe = harness.session.progress["recipes"][learned["capabilityId"]]
                executed = visual.ios.execute(harness.session, recipe, recipe["revision"], {"query": "gamma"})
            self.assertEqual(lease.call_count, 2)
            self.assertEqual(executed["outputs"], {"text": "RESULT gamma"})
            self.assertEqual(len(harness.calls), 15)
            self.assertEqual(harness.session.budget.count, 15)
            recipes_text = (Path(tmp) / "recipes.json").read_text()
            self.assertNotIn("alpha", recipes_text)
            self.assertNotIn("beta", recipes_text)
            self.assertNotIn("gamma", recipes_text)

    def test_incomplete_anchor_contract_or_missing_capability_id_rejected_before_lease(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = session(tmp)
            with patch.object(visual, "DeviceLease"), patch.object(visual, "_text_run", side_effect=self.fake_run):
                learned = visual.learn(current, DEF, [{"query": "alpha"}, {"query": "beta"}])
            original = current.progress["recipes"][learned["capabilityId"]]
            with patch.object(visual, "DeviceLease") as lease:
                bad_anchor = copy.deepcopy(original)
                bad_anchor["controlContracts"]["focus"] = {}
                missing_capability = copy.deepcopy(original)
                missing_capability.pop("capabilityId")
                for recipe in (bad_anchor, missing_capability):
                    recipe["revision"] = digest({key: value for key, value in recipe.items() if key != "revision"})
                    with self.assertRaisesRegex(MobileError, "VISUAL_RECIPE_INVALID"):
                        visual.execute(current, recipe, recipe["revision"], {"query": "gamma"})
                lease.assert_not_called()


if __name__ == "__main__":
    unittest.main()
