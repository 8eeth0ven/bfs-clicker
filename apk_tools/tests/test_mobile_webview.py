"""Offline W3C adapter contracts; these are not real-device acceptance tests."""
import copy
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from apk_inventory.mobile_ui import DeviceLease, MobileError, locate, read_json
from apk_inventory.mobile_webview import DOM_PROBE, ELEMENT_KEY, MODALITY, WebViewSession, normalize_reference

from webview_fixture import APP, webview_fixture


def config_for(state, directory, *, second_input=False, outside_output=False):
    specs = [{"id": "query", "selector": "#query", "kind": "input", "group": "#searchForm"}]
    if second_input:
        specs.append({"id": "detail", "selector": "#detail", "kind": "input", "group": "#searchForm"})
    specs.extend([{"id": "run", "selector": "#run", "kind": "button", "group": "#searchForm"},
                  {"id": "result", "selector": "#result", "kind": "output", "group": None if outside_output else "#searchForm"}])
    return {"source": {"id": "webview_fixture", "kind": "ios"},
            "backend": {"type": "appium-webview", "platform": "ios", "url": state["transportUrl"], "sessionId": "webview-session", "appId": APP,
                        "intentJournal": str(Path(directory).resolve() / "shared-intent.json"),
                        "webview": {"context": "WEBVIEW_7.1", "windowHandle": "7.1", "origin": state["origin"],
                                    "url": state["documentUrl"], "controls": specs}},
            "limits": {"maxActions": 30, "maxDurationMs": 60000},
            "actionAllowlist": [{"kind": "type" if spec["kind"] == "input" else "click", "selector": {"resourceId": spec["selector"]}, "effect": "read"}
                                for spec in specs if spec["kind"] != "output"]}


def type_query(session, value):
    tree = session.backend.observe()
    session.backend.perform({"kind": "type", "selector": {"resourceId": "#query"}, "input": "query", "replace": True}, tree, {"query": value})


class WebViewBackendTests(unittest.TestCase):
    def test_only_w3c_or_equal_dual_key_references_are_normalized_without_mutating_wire_data(self):
        for ref in ({ELEMENT_KEY: "opaque"}, {ELEMENT_KEY: "opaque", "ELEMENT": "opaque"}):
            before = copy.deepcopy(ref)
            self.assertEqual(normalize_reference(ref), {ELEMENT_KEY: "opaque"})
            self.assertEqual(ref, before)
        self.assertIsNone(normalize_reference(None))
        for ref in ({"ELEMENT": "opaque"}, {ELEMENT_KEY: "opaque", "ELEMENT": "other"},
                    {ELEMENT_KEY: "opaque", "unexpected": True}, {ELEMENT_KEY: "opaque", "ELEMENT": "opaque", "extra": True},
                    {ELEMENT_KEY: ""}, {ELEMENT_KEY: 7}, {ELEMENT_KEY: "opaque", "ELEMENT": 7}, {ELEMENT_KEY: "x" * 1025}):
            with self.subTest(ref=ref), self.assertRaises(MobileError) as caught:
                normalize_reference(ref)
            self.assertEqual(caught.exception.code, "WEBVIEW_REFERENCE_INVALID")

    def test_actual_dual_key_protocol_shape_roundtrips_but_ambiguous_shapes_block_before_effects(self):
        for shape in ("w3c", "dual", "legacy", "conflict", "extra", "empty", "number"):
            with self.subTest(shape=shape), webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
                state["referenceShape"] = shape
                session = WebViewSession(config_for(state, directory), directory)
                if shape in {"w3c", "dual"}:
                    session.backend.observe()
                    self.assertTrue(all(ref is None or set(ref) == {ELEMENT_KEY} for ref in session.backend.refs))
                    with session.execution():
                        type_query(session, "same live reference")
                    self.assertEqual(state["input"], "same live reference")
                else:
                    with self.assertRaises(MobileError) as caught:
                        session.backend.observe()
                    self.assertEqual(caught.exception.code, "WEBVIEW_REFERENCE_INVALID")
                    self.assertEqual(state["effects"], [])

    def test_live_unicode_exact_readback_stable_revision_and_fresh_worker_attachment(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            config = config_for(state, directory, second_input=True)
            first = WebViewSession(config, Path(directory) / "first")
            before = first.backend.observe()
            with first.execution():
                type_query(first, "中文 e\u0301 🦊")
                tree = first.backend.observe()
                first.backend.perform({"kind": "click", "selector": {"resourceId": "#run"}}, tree, {})
                self.assertEqual(locate(first.backend.observe(), {"resourceId": "#result"})["text"], "Query:中文 e\u0301 🦊;Detail:")
            after = first.backend.observe()
            self.assertEqual(before["sourceRevision"], after["sourceRevision"])
            self.assertNotEqual(before["fingerprint"], after["fingerprint"])
            self.assertEqual(state["effects"], [("query", "clear"), ("query", "value"), ("run", "click")])
            fresh = WebViewSession(config, Path(directory) / "fresh")
            attached = fresh.backend.observe()
            self.assertEqual(attached["sourceRevision"], before["sourceRevision"])
            self.assertNotEqual(attached["_documentLease"], before["_documentLease"])
            with fresh.execution():
                type_query(fresh, "another")
            self.assertIsNone(fresh.backend._pending())
            self.assertIsNotNone(read_json(Path(directory) / "shared-intent.json")["pending"])
            self.assertTrue(fresh.backend.completion_path.is_file())
            self.assertEqual(fresh.backend.probe()["modality"], MODALITY)

    def test_input_values_and_live_refs_never_persist_in_inventory(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            state["input"] = "private input e\u0301"
            session = WebViewSession(config_for(state, directory), Path(directory) / "observe")
            result = session.explore()
            self.assertTrue(result["ok"])
            self.assertEqual(state["effects"], [])
            serialized = "".join(path.read_text() for path in (Path(directory) / "observe").glob("*.json*"))
            self.assertNotIn(state["input"], serialized)
            self.assertNotIn(ELEMENT_KEY, serialized)
            self.assertNotIn(session.backend.document_lease, serialized)

    def test_actual_context_bundle_id_is_required_not_filled_from_trusted_app_id(self):
        for change in ({"missingBundle": True}, {"bundleId": "com.other.app"}, {"active": "com.other.app"}, {"duplicateContext": True}):
            with self.subTest(change=change), webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
                state.update(change)
                session = WebViewSession(config_for(state, directory), directory)
                with self.assertRaises(MobileError):
                    session.backend.observe()
                self.assertEqual(state["effects"], [])

    def test_explicit_main_pid_profile_keeps_raw_alias_and_fresh_observed_pid(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            config = config_for(state, directory)
            state.update(pid=7, bundleId="process-BFSWebViewFixture")
            config["backend"]["webview"]["association"] = {"mode": "xcuitest_app_main_pid_v1", "reportedBundleId": "process-BFSWebViewFixture"}
            session = WebViewSession(config, directory)
            tree = session.backend.observe()
            identity = tree["sourceIdentity"]
            self.assertEqual(identity["associationMethod"], "xcuitest_app_main_pid_v1")
            self.assertEqual(identity["appMainPid"], "7")
            self.assertEqual(identity["contextBundleId"], "process-BFSWebViewFixture")
            self.assertEqual(identity["appId"], APP)
            self.assertNotEqual(identity["contextBundleId"], identity["appId"])
            with session.execution():
                type_query(session, "observed association")
            self.assertEqual(state["input"], "observed association")

    def test_default_bundle_profile_does_not_require_pid_or_implicitly_accept_process_alias(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            config = config_for(state, directory)
            state["pid"] = "not a PID"
            identity = WebViewSession(config, directory).backend.observe()["sourceIdentity"]
            self.assertEqual(identity["associationMethod"], "reported_bundle_id_v1")
            self.assertNotIn("appMainPid", identity)
            state.update(pid=7, bundleId="process-BFSWebViewFixture")
            with self.assertRaises(MobileError) as caught:
                WebViewSession(config, directory).backend.observe()
            self.assertEqual(caught.exception.code, "WEBVIEW_CONTEXT_APP_UNVERIFIED")

    def test_pid_profile_rejects_missing_invalid_main_or_child_process_pid_without_dispatch(self):
        for pid in (None, True, False, "7", 0, -1, 2147483648, 7.0, 8):
            with self.subTest(pid=repr(pid)), webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
                config = config_for(state, directory)
                state.update(bundleId="process-BFSWebViewFixture")
                if pid is not None:
                    state["pid"] = pid
                config["backend"]["webview"]["association"] = {"mode": "xcuitest_app_main_pid_v1", "reportedBundleId": "process-BFSWebViewFixture"}
                with self.assertRaises(MobileError) as caught:
                    WebViewSession(config, directory).backend.observe()
                self.assertIn(caught.exception.code, {"WEBVIEW_MAIN_PID_UNVERIFIED", "WEBVIEW_CONTEXT_MAIN_PID_MISMATCH"})
                self.assertEqual(state["effects"], [])

    def test_pid_profile_does_not_override_foreign_bundle_conflicts_or_fresh_pid_drift(self):
        for change in ({"bundleId": "com.other.app"}, {"bundleId": "process-OtherApp"}, {"active": "com.other.app"}, {"missingBundle": True}):
            with self.subTest(change=change), webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
                config = config_for(state, directory)
                state.update(pid=7, bundleId="process-BFSWebViewFixture")
                state.update(change)
                config["backend"]["webview"]["association"] = {"mode": "xcuitest_app_main_pid_v1", "reportedBundleId": "process-BFSWebViewFixture"}
                with self.assertRaises(MobileError):
                    WebViewSession(config, directory).backend.observe()
                self.assertEqual(state["effects"], [])
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            config = config_for(state, directory)
            state.update(pid=7, bundleId="process-BFSWebViewFixture")
            config["backend"]["webview"]["association"] = {"mode": "xcuitest_app_main_pid_v1", "reportedBundleId": "process-BFSWebViewFixture"}
            state["onProbe"] = lambda count: state.update(pid=8) if count == 2 else None
            with self.assertRaises(MobileError):
                WebViewSession(config, directory).backend.observe()
            self.assertEqual(state["effects"], [])

    def test_pid_profile_config_cannot_inject_observed_pid_or_accept_unknown_context_encoding(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            original = config_for(state, directory)
            original["backend"]["webview"]["association"] = {"mode": "xcuitest_app_main_pid_v1", "reportedBundleId": "process-BFSWebViewFixture"}
            for alias in ("*", "process-*", "com.other.app", "process-com.apple.WebKit.WebContent"):
                changed = copy.deepcopy(original)
                changed["backend"]["webview"]["association"]["reportedBundleId"] = alias
                with self.subTest(alias=alias), self.assertRaises(MobileError):
                    WebViewSession(changed, directory)
            for context in ("WEBVIEW_07.1", "WEBVIEW_7.01", "WEBVIEW_0.1", "WEBVIEW_7.0", "WEBVIEW_7.1.2", "WEBVIEW_7", "WEBVIEW_2147483648.1"):
                changed = copy.deepcopy(original)
                changed["backend"]["webview"]["context"] = context
                with self.subTest(context=context), self.assertRaises(MobileError):
                    WebViewSession(changed, directory)
            changed = copy.deepcopy(original)
            changed["backend"]["webview"]["association"]["pid"] = 7
            with self.assertRaises(MobileError):
                WebViewSession(changed, directory)
            self.assertEqual(state["calls"], [])
            injected = copy.deepcopy(original)
            injected["backend"]["pid"] = 7
            state["bundleId"] = "process-BFSWebViewFixture"
            with self.assertRaises(MobileError) as missing:
                WebViewSession(injected, directory).backend.observe()
            self.assertEqual(missing.exception.code, "WEBVIEW_MAIN_PID_UNVERIFIED")
            self.assertEqual(state["effects"], [])

    def test_context_window_native_placeholder_and_tap_fallback_rejected_without_switching(self):
        for change in ({"context": "NATIVE_APP"}, {"window": "1"}, {"handles": ["7.1", "other"]},
                       {"settings": {"nativeWebTap": True, "nativeWebTapStrict": False}},
                       {"settings": {"nativeWebTap": False}}):
            with self.subTest(change=change), webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
                state.update(change)
                session = WebViewSession(config_for(state, directory), directory)
                with self.assertRaises(MobileError):
                    session.backend.observe()
                self.assertFalse(any(method == "POST" and route in {"/context", "/window", "/url"} for method, route in state["calls"]))
                self.assertEqual(state["effects"], [])

    def test_context_and_foreground_are_rechecked_after_source_and_dom_reads(self):
        for field, changed in (("context", "NATIVE_APP"), ("active", "com.other.app"), ("window", "different")):
            with self.subTest(field=field), webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
                state["onProbe"] = lambda count: state.update({field: changed}) if count == 2 else None
                session = WebViewSession(config_for(state, directory), directory)
                with self.assertRaises(MobileError):
                    session.backend.observe()
                self.assertEqual(state["effects"], [])

    def test_html_source_is_not_parsed_as_native_xml(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            state["html"] = '<AppiumAUT><XCUIElementTypeTextField name="query" value="x"/></AppiumAUT>'
            with self.assertRaises(MobileError) as caught:
                WebViewSession(config_for(state, directory), directory).backend.observe()
            self.assertEqual(caught.exception.code, "WEBVIEW_HTML_SOURCE_UNVERIFIED")

    def test_reload_same_url_invalidates_live_pins_but_fresh_worker_can_rebind(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            config = config_for(state, directory)
            session = WebViewSession(config, directory)
            observed = session.backend.observe()
            state["generation"] += 1
            with self.assertRaises(MobileError):
                with session.execution():
                    session.backend.perform({"kind": "click", "selector": {"resourceId": "#run"}}, observed, {})
            self.assertEqual(state["effects"], [])
            self.assertEqual(WebViewSession(config, Path(directory) / "fresh").backend.observe()["sourceRevision"], observed["sourceRevision"])

    def test_old_worker_tree_lease_cannot_authorize_a_new_worker_command(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            config = config_for(state, directory)
            old = WebViewSession(config, Path(directory) / "old").backend.observe()
            new = WebViewSession(config, Path(directory) / "new")
            new.backend.observe()
            with self.assertRaises(MobileError) as caught:
                with new.execution():
                    new.backend.perform({"kind": "click", "selector": {"resourceId": "#run"}}, old, {})
            self.assertEqual(caught.exception.code, "WEBVIEW_OBSERVATION_LEASE_INVALID")
            self.assertEqual(state["effects"], [])

    def test_contract_drift_and_cross_origin_form_action_block_before_dispatch(self):
        for change in ({"label": "Delete"}, {"formAction": "https://other.invalid/action"}, {"parentId": "replacement"}):
            with self.subTest(change=change), webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
                session = WebViewSession(config_for(state, directory), directory)
                before = session.backend.observe()
                state["contractChanges"]["run"] = change
                with self.assertRaises(MobileError):
                    with session.execution():
                        session.backend.perform({"kind": "click", "selector": {"resourceId": "#run"}}, before, {})
                self.assertEqual(state["effects"], [])

    def test_clear_value_and_click_each_have_a_durable_pre_dispatch_intent(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            session = WebViewSession(config_for(state, directory), directory)
            observed = []
            def effect(name, command):
                pending = read_json(Path(directory) / "shared-intent.json")["pending"]
                observed.append(pending["commands"][-1]["command"])
                self.assertEqual(pending["status"], "unknown")
                self.assertFalse(pending["automaticRetry"])
            state["afterEffect"] = effect
            with session.execution():
                type_query(session, "echo")
                tree = session.backend.observe()
                session.backend.perform({"kind": "click", "selector": {"resourceId": "#run"}}, tree, {})
            self.assertEqual(observed, ["clear", "value", "click"])

    def test_failed_ack_is_unknown_and_new_output_worker_cannot_replay(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            config = config_for(state, directory)
            session = WebViewSession(config, Path(directory) / "first")
            state["failCommand"] = "value"
            with self.assertRaises(MobileError):
                with session.execution():
                    type_query(session, "one")
            self.assertEqual(state["input"], "one")
            self.assertEqual(session.progress["webviewOutcome"]["status"], "unknown")
            effects = list(state["effects"])
            retry = WebViewSession(config, Path(directory) / "different-output")
            with self.assertRaises(MobileError) as caught:
                with retry.execution():
                    type_query(retry, "two")
            self.assertEqual(caught.exception.code, "WEBVIEW_PENDING_UNKNOWN")
            self.assertEqual(effects, state["effects"])

    def test_real_http_timeout_after_value_dispatch_is_unknown_and_never_replayed(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            config = config_for(state, directory)
            config["backend"]["commandTimeoutMs"] = 250
            state["timeoutCommand"] = "value"
            session = WebViewSession(config, Path(directory) / "first")
            with self.assertRaises(MobileError) as caught:
                with session.execution():
                    type_query(session, "once")
            self.assertEqual(caught.exception.code, "WEBVIEW_DRIVER_UNAVAILABLE")
            self.assertEqual(state["input"], "once")
            before = list(state["effects"])
            with self.assertRaises(MobileError) as retry:
                with WebViewSession(config, Path(directory) / "retry").execution():
                    pass
            self.assertEqual(retry.exception.code, "WEBVIEW_PENDING_UNKNOWN")
            self.assertEqual(before, state["effects"])

    def test_world_readable_intent_journal_cannot_authorize_commands(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            config = config_for(state, directory)
            session = WebViewSession(config, directory)
            with session.execution():
                type_query(session, "first")
            path = Path(directory) / "shared-intent.json"
            path.chmod(0o644)
            before = len(state["calls"])
            with self.assertRaises(MobileError) as caught:
                with WebViewSession(config, Path(directory) / "new").execution():
                    pass
            self.assertEqual(caught.exception.code, "WEBVIEW_JOURNAL_INVALID")
            self.assertEqual(len(state["calls"]), before)

    def test_unicode_normalization_is_not_accepted_as_exact_input(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            state["normalizeValue"] = True
            session = WebViewSession(config_for(state, directory), directory)
            with self.assertRaises(MobileError) as caught:
                with session.execution():
                    type_query(session, "e\u0301")
            self.assertEqual(caught.exception.code, "WEBVIEW_INPUT_VALUE_UNVERIFIED")
            self.assertEqual(state["effects"], [("query", "clear"), ("query", "value")])

    def test_failed_clear_never_sends_value_or_retries(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            state["input"], state["failClear"] = "old", True
            session = WebViewSession(config_for(state, directory), directory)
            with self.assertRaises(MobileError) as caught:
                with session.execution():
                    type_query(session, "new")
            self.assertEqual(caught.exception.code, "WEBVIEW_INPUT_CLEAR_UNVERIFIED")
            self.assertEqual(state["effects"], [("query", "clear")])

    def test_cancel_after_dispatch_keeps_journal_and_never_resends(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            config = config_for(state, directory)
            session = WebViewSession(config, directory)
            state["afterEffect"] = lambda name, command: setattr(session.budget, "cancelled", True)
            with self.assertRaises(MobileError) as caught:
                with session.execution():
                    type_query(session, "new")
            self.assertEqual(caught.exception.code, "STOPPED")
            self.assertEqual(state["effects"], [("query", "clear")])
            with self.assertRaises(MobileError):
                with WebViewSession(config, Path(directory) / "retry").execution():
                    pass

    def test_result_freshness_failure_after_ack_preserves_unknown(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            config = config_for(state, directory)
            session = WebViewSession(config, directory)
            with self.assertRaises(MobileError):
                with session.execution():
                    type_query(session, "new")
                    tree = session.backend.observe()
                    session.backend.perform({"kind": "click", "selector": {"resourceId": "#run"}}, tree, {})
                    raise MobileError("WORKFLOW_FRESHNESS_NOT_OBSERVED", "blocked")
            self.assertEqual(state["clicks"], 1)
            self.assertIsNotNone(read_json(Path(directory) / "shared-intent.json")["pending"])

    def test_checkpoint_or_completion_journal_failure_never_erases_intent(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            session = WebViewSession(config_for(state, directory), directory)
            with self.assertRaises(OSError):
                with session.execution():
                    type_query(session, "value")
                    raise OSError("checkpoint unavailable")
            self.assertIsNotNone(read_json(Path(directory) / "shared-intent.json")["pending"])
            self.assertTrue(session.backend.poisoned)

    def test_completion_journal_write_failure_retains_pre_dispatch_intent(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            session = WebViewSession(config_for(state, directory), directory)
            from apk_inventory import mobile_webview
            original = mobile_webview._save_journal
            def save(path, record):
                if "completion" in record:
                    raise OSError("completion write unavailable")
                return original(path, record)
            with patch.object(mobile_webview, "_save_journal", side_effect=save), self.assertRaises(OSError):
                with session.execution():
                    type_query(session, "value")
            self.assertIsNotNone(read_json(Path(directory) / "shared-intent.json")["pending"])
            self.assertTrue(session.backend.poisoned)

    def test_same_live_dom_nodes_may_have_new_opaque_cache_ids(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            state["opaqueAliases"] = True
            session = WebViewSession(config_for(state, directory), directory)
            before = session.backend.observe()
            refs = copy.deepcopy(session.backend.refs)
            for _ in range(2):
                self.assertEqual(session.backend.observe()["sourceRevision"], before["sourceRevision"])
            self.assertEqual(session.backend.refs, refs)
            with session.execution():
                type_query(session, "live")
            self.assertEqual(state["input"], "live")

    def test_published_completion_receipt_remains_observed_when_all_later_writes_fail(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            config = config_for(state, directory)
            session = WebViewSession(config, directory)
            from apk_inventory import mobile_webview
            original = mobile_webview._save_journal
            original_atomic = mobile_webview.atomic_json
            blocked, attempted_later_writes = [False], []
            def atomic(path, record):
                if blocked[0]:
                    attempted_later_writes.append(str(path))
                    raise OSError("all subsequent writes fail")
                return original_atomic(path, record)
            def save(path, record):
                if blocked[0]:
                    attempted_later_writes.append(str(path))
                    raise OSError("all subsequent writes fail")
                original(path, record)
                if "completion" in record:
                    blocked[0] = True
                    raise OSError("directory fsync failed after completion replace")
            with patch.object(mobile_webview, "_save_journal", side_effect=save), patch.object(mobile_webview, "atomic_json", side_effect=atomic), self.assertRaises(OSError):
                with session.execution():
                    type_query(session, "once")
            self.assertIsNotNone(read_json(Path(directory) / "shared-intent.json")["pending"])
            self.assertEqual(attempted_later_writes, [])
            self.assertEqual(session.progress["webviewOutcome"]["status"], "observed")
            self.assertIn("storageWarning", session.progress["webviewOutcome"])
            fresh = WebViewSession(config, Path(directory) / "fresh")
            self.assertIsNone(fresh.backend._pending())
            self.assertEqual(state["effects"], [("query", "clear"), ("query", "value")])
            with fresh.execution():
                type_query(fresh, "explicit next call")
            self.assertEqual(state["input"], "explicit next call")

    def test_completion_must_bind_every_intent_field_and_cannot_replay_an_old_receipt(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            config = config_for(state, directory)
            session = WebViewSession(config, directory)
            with session.execution():
                type_query(session, "first")
            receipt = read_json(session.backend.completion_path)
            for key, value in (("executionId", "0" * 32), ("intentSha256", "0" * 64), ("commandCount", 999),
                               ("sourceRevision", "0" * 64), ("probeSha256", "0" * 64), ("status", "unknown")):
                changed = copy.deepcopy(receipt)
                changed["completion"][key] = value
                session.backend.completion_path.write_text(json.dumps(changed))
                with self.subTest(key=key):
                    self.assertIsNotNone(WebViewSession(config, directory).backend._pending())
            session.backend.completion_path.write_text(json.dumps(receipt))
            self.assertIsNone(WebViewSession(config, directory).backend._pending())
            next_session = WebViewSession(config, Path(directory) / "second")
            with self.assertRaises(MobileError):
                with next_session.execution():
                    type_query(next_session, "second")
                    raise MobileError("WORKFLOW_FRESHNESS_NOT_OBSERVED", "blocked")
            self.assertEqual(read_json(next_session.backend.completion_path), receipt)
            self.assertIsNotNone(WebViewSession(config, directory).backend._pending())

    def test_new_intent_published_then_failed_write_never_matches_the_old_receipt(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            config = config_for(state, directory)
            first = WebViewSession(config, directory)
            with first.execution():
                type_query(first, "first")
            from apk_inventory import mobile_webview
            original = mobile_webview._save_journal
            def save(path, record):
                original(path, record)
                raise OSError("prepared intent published, fsync then failed")
            effects = list(state["effects"])
            fresh = WebViewSession(config, Path(directory) / "second")
            with patch.object(mobile_webview, "_save_journal", side_effect=save), self.assertRaises(OSError):
                with fresh.execution():
                    type_query(fresh, "second")
            self.assertIsNotNone(WebViewSession(config, directory).backend._pending())
            self.assertEqual(effects, state["effects"])

    def test_missing_or_bad_completion_receipt_remains_unknown(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            config = config_for(state, directory)
            session = WebViewSession(config, directory)
            with session.execution():
                type_query(session, "first")
            receipt = session.backend.completion_path.read_bytes()
            for content in (b"{}", b"not json"):
                session.backend.completion_path.write_bytes(content)
                self.assertIsNotNone(WebViewSession(config, directory).backend._pending())
            session.backend.completion_path.unlink()
            self.assertIsNotNone(WebViewSession(config, directory).backend._pending())
            session.backend.completion_path.write_bytes(receipt)
            session.backend.completion_path.chmod(0o600)
            self.assertIsNone(WebViewSession(config, directory).backend._pending())

    def test_fresh_python_process_reads_unknown_and_successful_calls_can_repeat(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            config = config_for(state, directory)
            path = Path(directory) / "config.json"
            path.write_text(json.dumps(config))
            path.chmod(0o600)
            code = '''
import json,os,sys
from apk_inventory.mobile_webview import WebViewSession,require
from apk_inventory.mobile_ui import MobileError,locate,read_json
s=WebViewSession(read_json(sys.argv[1]),sys.argv[2])
try:
 with s.execution():
  before=s.backend.observe(); old=locate(before,{'resourceId':'#result'})['text']
  s.backend.perform({'kind':'type','selector':{'resourceId':'#query'},'input':'query','replace':True},before,{'query':sys.argv[3]})
  s.backend.perform({'kind':'click','selector':{'resourceId':'#run'}},s.backend.observe(),{})
  result=locate(s.backend.observe(),{'resourceId':'#result'})['text']
  require(result!=old and sys.argv[3] in result,'WORKFLOW_FRESHNESS_NOT_OBSERVED')
 print(json.dumps({'ok':True,'pid':os.getpid(),'outcome':s.progress.get('webviewOutcome')}))
except MobileError as e:
 print(json.dumps({'ok':False,'pid':os.getpid(),'code':e.code,'outcome':s.progress.get('webviewOutcome')}))
'''
            env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
            def child(number, value):
                run = subprocess.run([sys.executable, "-B", "-c", code, str(path), str(Path(directory) / str(number)), value],
                                     env=env, capture_output=True, text=True, timeout=15)
                self.assertEqual(run.returncode, 0, run.stderr)
                result = json.loads(run.stdout)
                self.assertNotEqual(result["pid"], os.getpid())
                return result
            self.assertTrue(child(1, "first e\u0301")["ok"])
            self.assertTrue(child(2, "second 中文")["ok"])
            self.assertEqual([row["query"] for row in state["ledger"]], ["first e\u0301", "second 中文"])
            state["failCommand"] = "value"
            self.assertFalse(child(3, "uncertain")["ok"])
            calls, effects = len(state["calls"]), list(state["effects"])
            blocked = child(4, "must not replay")
            self.assertEqual(blocked["code"], "WEBVIEW_PENDING_UNKNOWN")
            self.assertEqual(blocked["outcome"]["status"], "unknown")
            self.assertEqual(len(state["calls"]), calls)
            self.assertEqual(state["effects"], effects)

    def test_final_result_write_failure_preserves_observed_or_unknown_scope(self):
        from apk_inventory import mobile_webview, mobile_webview_planner
        for fail_command in (None, "value"):
            with self.subTest(fail_command=fail_command), webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
                config = config_for(state, directory)
                planner_session = WebViewSession(config, Path(directory) / "plan")
                tree = planner_session.backend.observe()
                plan = mobile_webview_planner.plan_tree(planner_session, tree)
                definition = copy.deepcopy(next(iter(plan["specs"].values())))
                target = definition.pop("outcomeCandidates")[0]["selector"]
                definition["steps"].extend([{"kind": "assert", "selector": target, "expect": {"changed": True, "containsInput": "query"}},
                                            {"kind": "extract", "selector": target, "output": "text"}])
                files = {"config": config, "workflow": definition, "samples": [{"query": "alpha"}, {"query": "beta"}]}
                for name, value in files.items():
                    path = Path(directory) / (name + ".json")
                    path.write_text(json.dumps(value))
                    path.chmod(0o600)
                state["failCommand"] = fail_command
                original = mobile_webview.atomic_json
                def save(path, value):
                    if Path(path).name == "result.json":
                        raise OSError("final result storage unavailable")
                    return original(path, value)
                stream = io.StringIO()
                argv = ["--operation", "workflow-learn", "--output", str(Path(directory) / "learn")]
                for flag in ("config", "workflow", "samples"):
                    argv.extend(["--" + flag, str(Path(directory) / (flag + ".json"))])
                with patch.object(mobile_webview, "atomic_json", side_effect=save), redirect_stdout(stream):
                    mobile_webview.main(argv)
                result = json.loads(stream.getvalue())
                self.assertEqual(result["error"]["code"], "OUTPUT_FAILED")
                self.assertFalse(result["automaticRetry"])
                if fail_command:
                    self.assertEqual(result["webviewOutcome"]["status"], "unknown")
                    self.assertIsNotNone(planner_session.backend._pending())
                else:
                    self.assertEqual(result["webviewOutcome"]["status"], "observed")
                    self.assertIn("storageWarning", result["webviewOutcome"])
                    self.assertIsNone(planner_session.backend._pending())

    def test_cli_first_intent_prepublish_failure_is_not_started_but_published_intent_is_unknown(self):
        from apk_inventory import mobile_webview, mobile_webview_planner
        for published in (False, True):
            with self.subTest(published=published), webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
                config = config_for(state, directory)
                session = WebViewSession(config, Path(directory) / "plan")
                plan = mobile_webview_planner.plan_tree(session, session.backend.observe())
                definition = copy.deepcopy(next(iter(plan["specs"].values())))
                target = definition.pop("outcomeCandidates")[0]["selector"]
                definition["steps"].extend([{"kind": "assert", "selector": target, "expect": {"changed": True, "containsInput": "query"}},
                                            {"kind": "extract", "selector": target, "output": "text"}])
                for name, value in {"config": config, "workflow": definition, "samples": [{"query": "alpha"}, {"query": "beta"}]}.items():
                    path = Path(directory) / (name + ".json")
                    path.write_text(json.dumps(value))
                    path.chmod(0o600)
                original = mobile_webview._save_journal
                def fail(path, record):
                    if published:
                        original(path, record)
                    raise OSError("first intent persistence fault")
                stream = io.StringIO()
                argv = ["--operation", "workflow-learn", "--output", str(Path(directory) / "learn")]
                for flag in ("config", "workflow", "samples"):
                    argv.extend(["--" + flag, str(Path(directory) / (flag + ".json"))])
                with patch.object(mobile_webview, "_save_journal", side_effect=fail), redirect_stdout(stream):
                    mobile_webview.main(argv)
                result = json.loads(stream.getvalue())
                self.assertEqual(result["webviewOutcome"]["status"], "unknown" if published else "not_started")
                self.assertEqual(state["effects"], [])
                fresh = WebViewSession(config, Path(directory) / "fresh")
                calls = len(state["calls"])
                if published:
                    self.assertIsNotNone(fresh.backend._pending())
                    with self.assertRaises(MobileError) as caught:
                        with fresh.execution():
                            pass
                    self.assertEqual(caught.exception.code, "WEBVIEW_PENDING_UNKNOWN")
                else:
                    self.assertIsNone(fresh.backend._pending())
                    with fresh.execution():
                        pass
                self.assertEqual(len(state["calls"]), calls)

    def test_all_inputs_can_be_prevalidated_before_first_field_clear(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            session = WebViewSession(config_for(state, directory, second_input=True), directory)
            for bad in ("bad\x00", "bad\n", "bad\x85", "bad\ue007", "\ud800", "x" * 2049):
                with self.subTest(bad=repr(bad)), self.assertRaises(MobileError):
                    session.backend.validate_literal_inputs({"query": "valid", "detail": bad})
            self.assertEqual(state["effects"], [])
            self.assertEqual(state["calls"], [])

    def test_unconfigured_standard_controls_are_visible_gaps_and_not_dispatch_targets(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            state["unconfigured"] = [{"selector": "#extra", "dataTestId": "extra-toggle", "tag": "input", "type": "checkbox", "role": "",
                                      "configured": False, "dispatchAuthorized": False}]
            session = WebViewSession(config_for(state, directory, outside_output=True), directory)
            tree = session.backend.observe()
            self.assertEqual(tree["unconfiguredControls"], state["unconfigured"])
            self.assertIn("unconfigured_visible_controls_observed", tree["gaps"])
            self.assertNotIn("#extra", [node["resourceId"] for node in tree["nodes"]])
            output = locate(tree, {"resourceId": "#result"})
            self.assertEqual(output["containerPath"], [])
            self.assertIsNone(output["domContract"]["groupSelector"])

    def test_implicit_read_heuristic_arbitrary_script_context_switch_and_native_actions_are_absent(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            session = WebViewSession(config_for(state, directory), directory)
            self.assertEqual(session.policy({"kind": "click", "selector": {"text": "Search"}}), (False, "unknown"))
            for method, route, body in (("POST", "/execute/sync", {"script": "return 1", "args": []}),
                                        ("POST", "/context", {"name": "NATIVE_APP"}), ("POST", "/back", {})):
                with self.subTest(route=route), self.assertRaises(MobileError):
                    session.backend.request(method, route, body)
            self.assertEqual(state["calls"], [])

    def test_android_unknown_profiles_and_unsafe_selectors_rejected_without_transport(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            original = config_for(state, directory)
            changes = [lambda c: c["backend"].update(platform="android"), lambda c: c["backend"].update(type="webdriver"),
                       lambda c: c["backend"]["webview"]["controls"][0].update(selector="input"),
                       lambda c: c["backend"]["webview"]["controls"][0].update(group=None)]
            for change in changes:
                config = copy.deepcopy(original)
                change(config)
                with self.assertRaises(MobileError):
                    WebViewSession(config, directory)
            self.assertEqual(state["calls"], [])

    def test_native_and_webview_share_existing_webdriver_session_lease(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            session = WebViewSession(config_for(state, directory), directory)
            from apk_inventory.mobile_ui import Budget, WebDriverBackend
            native = WebDriverBackend({"url": state["transportUrl"], "sessionId": "webview-session", "appId": APP, "platform": "ios"}, Budget({}))
            with DeviceLease(native):
                with self.assertRaises(MobileError) as caught:
                    with DeviceLease(session.backend):
                        pass
            self.assertEqual(caught.exception.code, "DEVICE_BUSY")

    def test_another_process_native_lease_blocks_new_webview_cli_before_any_http(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            config = config_for(state, directory)
            path = Path(directory) / "config.json"
            path.write_text(json.dumps(config))
            path.chmod(0o600)
            code = ("import json,sys; from apk_inventory.mobile_ui import Budget,DeviceLease,WebDriverBackend; "
                    "c=json.load(open(sys.argv[1]))['backend']; b=WebDriverBackend(c,Budget({})); "
                    "lease=DeviceLease(b); lease.__enter__(); print('READY',flush=True); sys.stdin.readline(); lease.__exit__()")
            env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
            writer = subprocess.Popen([sys.executable, "-B", "-c", code, str(path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True, env=env)
            try:
                self.assertEqual(writer.stdout.readline().strip(), "READY")
                result = subprocess.run([sys.executable, "-B", "-m", "apk_inventory.mobile_webview", "--config", str(path),
                                         "--output", str(Path(directory) / "reader"), "--operation", "observe"],
                                        input="", text=True, capture_output=True, timeout=10, env=env)
                self.assertEqual(json.loads(result.stdout)["error"]["code"], "DEVICE_BUSY")
                self.assertEqual(state["calls"], [])
            finally:
                writer.communicate(input="release\n", timeout=10)
            self.assertEqual(writer.returncode, 0)

    def test_intent_and_output_files_are_private(self):
        with webview_fixture() as state, tempfile.TemporaryDirectory() as directory:
            session = WebViewSession(config_for(state, directory), Path(directory) / "output")
            with session.execution():
                type_query(session, "value")
            session.checkpoint()
            for path in Path(directory).rglob("*.json"):
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)


class FixedDOMProbeTests(unittest.TestCase):
    def test_fixed_probe_executes_against_local_dom_fixture(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node.js required for the fixed DOM probe fixture")
        fixture = Path(__file__).parent / "fixtures" / "webview-dom-probe.cjs"
        result = subprocess.run([node, str(fixture)], input=json.dumps({"script": DOM_PROBE}), text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertGreaterEqual(report["checks"], 20)
        self.assertEqual(report["failures"], [])


if __name__ == "__main__":
    unittest.main()
