"""Exercise the real ADB source/IME path with an in-memory command boundary.

No ADB process, device, IME installation, OCR, or network service is started.
"""
import base64
import hashlib
import json
from pathlib import Path
import shlex
import tempfile
from types import SimpleNamespace
import unittest
from xml.sax.saxutils import quoteattr

from apk_inventory import android_unicode
from apk_inventory.mobile_ui import AdbBackend, Budget, MobileError, locate, parse_tree
from apk_inventory.mobile_workflows import _with_write_outcome


APP = "com.example.presence"
FIELD = {"resourceId": APP + ":id/query"}
SEARCH = {"resourceId": APP + ":id/search"}


class SourceBackend(AdbBackend):
    """Keep foreground/source/parser/shell/perform/IME logic unmodified."""

    def __init__(self, faults=None, value=""):
        super().__init__({"appId": APP, "deviceId": "fixture",
                          "unicodeInput": {"component": android_unicode.COMPONENT,
                                           "apkSha256": "a" * 64}}, Budget({}))
        self.faults = faults or {}
        self.value = value
        self.phase = "before"
        self.calls = []
        self.commits = self.focus_taps = self.business_submissions = 0

    def source(self):
        fault = self.faults.get(self.phase)
        attrs = {"resource-id": FIELD["resourceId"], "text": self.value,
                 "class": "android.widget.EditText", "package": APP,
                 "enabled": "true", "visible": "true", "bounds": "[0,0][200,40]",
                 "focused": str(self.phase != "before").lower()}
        if fault == "missing_value":
            attrs.pop("text")
        elif fault == "secure":
            attrs["password"] = "true"
        elif fault == "readonly":
            attrs["readOnly"] = "true"
        elif fault == "disabled":
            attrs["enabled"] = "false"
        elif isinstance(fault, tuple) and fault[0] == "literal":
            attrs["text"] = fault[1]
        field = "" if fault == "missing_node" else "<node " + " ".join(
            key + "=" + quoteattr(value) for key, value in attrs.items()) + "/>"
        return ('<hierarchy rotation="0">' + field + '<node resource-id="' +
                SEARCH["resourceId"] + '" text="Search" class="android.widget.Button" '
                'package="' + APP + '" clickable="true" enabled="true" '
                'bounds="[0,80][200,120]"/></hierarchy>')

    def command(self, args):
        # The sole fake boundary is where production would launch an ADB process.
        if args[:3] != ["-s", "fixture", "shell"]:
            raise AssertionError("Unexpected non-shell ADB command")
        command = tuple(shlex.split(args[3]))
        self.calls.append(command)
        if command == ("dumpsys", "activity", "activities"):
            return "mResumedActivity: ActivityRecord{0 " + APP + "/.MainActivity}"
        if command[:2] == ("uiautomator", "dump") or command[:2] == ("rm", "-f"):
            return ""
        if command[0] == "cat":
            return self.source()
        if command[:2] == ("pm", "path"):
            return "package:/data/app/fixture/base.apk"
        if command[0] == "sha256sum":
            return "a" * 64 + "  /data/app/fixture/base.apk"
        if command == ("settings", "get", "secure", "default_input_method"):
            return android_unicode.COMPONENT
        if command[:2] == ("input", "tap"):
            if command[-1] == "20":
                self.focus_taps += 1
                self.phase = "focused"
            elif command[-1] == "100":
                self.business_submissions += 1
            else:
                raise AssertionError("Unexpected tap target")
            return ""
        if command[:2] == ("am", "broadcast"):
            self.commits += 1
            value = base64.b64decode(command[command.index("data") + 1]).decode("utf-8")
            if command[command.index("replace") + 1] == "true":
                self.value = value
            else:
                self.value += value
            self.phase = "committed"
            nonce = command[command.index("nonce") + 1]
            return ('Broadcast completed: result=-1, data="BFS_IME:' + nonce + ':' +
                    hashlib.sha256(value.encode("utf-8")).hexdigest() + '"')
        raise AssertionError("Unexpected ADB command")


def flow(backend, value="", replace=True):
    backend.perform({"kind": "type", "selector": FIELD, "input": "query", "replace": replace},
                    backend.observe(), {"query": value})
    backend.perform({"kind": "click", "selector": SEARCH}, backend.observe(), {})
    return {"ok": True}


class AdbInputPresenceTests(unittest.TestCase):
    def rejected(self, backend, *, focus, commits, value="", replace=True, before_ui=False):
        with tempfile.TemporaryDirectory() as out:
            session = SimpleNamespace(backend=backend, budget=backend.budget,
                                      output=Path(out), progress={}, checkpoint=lambda: None)
            error = None
            try:
                _with_write_outcome(session, {"effect": "write"},
                                    lambda: flow(backend, value, replace))
            except MobileError as caught:
                error = caught
            self.assertEqual(backend.business_submissions, 0,
                             "An unverified type must not dispatch the following Search")
            self.assertIsNotNone(error, "Missing input evidence must not report success")
            self.assertEqual((backend.focus_taps, backend.commits), (focus, commits))
            status = "not_started" if before_ui else "unknown"
            self.assertEqual(error.writeOutcome, {"status": status, "automaticRetry": False})
            intent = Path(out) / "write-intent.json"
            if before_ui:
                self.assertFalse(intent.exists())
            else:
                self.assertEqual(json.loads(intent.read_text())["status"], "unknown")

    def test_parser_preserves_empty_presence_and_rejects_non_string_source(self):
        for fault, present in [(None, True), ("missing_value", False), ("secure", True)]:
            backend = SourceBackend({"before": fault})
            node = locate(backend.observe(), FIELD)
            self.assertIs(node["_inputValuePresent"], present)
            self.assertEqual(node["_inputSha256"], hashlib.sha256(b"").hexdigest())
            self.assertEqual(node["secure"], fault == "secure")
        for value in (None, b"<root/>", {}, 1):
            with self.subTest(value=repr(value)), self.assertRaisesRegex(MobileError, "UI_SOURCE_REJECTED"):
                parse_tree(value, "android", APP)

    def test_explicit_empty_replace_and_append_remain_valid(self):
        for replace in (True, False):
            with self.subTest(replace=replace):
                backend = SourceBackend()
                self.assertEqual(flow(backend, replace=replace), {"ok": True})
                self.assertEqual((backend.focus_taps, backend.commits, backend.business_submissions), (1, 1, 1))

    def test_missing_initial_value_blocks_before_focus(self):
        for replace in (True, False):
            with self.subTest(replace=replace):
                self.rejected(SourceBackend({"before": "missing_value"}),
                              focus=0, commits=0, replace=replace, before_ui=True)

    def test_value_disappearing_after_focus_blocks_commit(self):
        for replace in (True, False):
            with self.subTest(replace=replace):
                self.rejected(SourceBackend({"focused": "missing_value"}),
                              focus=1, commits=0, replace=replace)

    def test_value_disappearing_after_commit_is_unknown_without_search_or_retry(self):
        for replace in (True, False):
            with self.subTest(replace=replace):
                self.rejected(SourceBackend({"committed": "missing_value"}),
                              focus=1, commits=1, replace=replace)

    def test_secure_field_is_never_an_empty_provider_value_proof(self):
        for phase, focus, commits in [("before", 0, 0), ("focused", 1, 0), ("committed", 1, 1)]:
            with self.subTest(phase=phase):
                self.rejected(SourceBackend({phase: "secure"}), focus=focus, commits=commits,
                              before_ui=phase == "before")

    def test_missing_target_and_nonempty_false_echo_stop_the_search(self):
        for phase, focus, commits in [("before", 0, 0), ("focused", 1, 0), ("committed", 1, 1)]:
            with self.subTest(phase=phase):
                self.rejected(SourceBackend({phase: "missing_node"}), focus=focus, commits=commits,
                              before_ui=phase == "before")
        for literal in ("null", "None", "0", "[]"):
            with self.subTest(literal=literal):
                self.rejected(SourceBackend({"committed": ("literal", literal)}), focus=1, commits=1)

    def test_non_string_inputs_never_dispatch_focus_or_commit(self):
        for value in (None, 0, [], {}, True):
            with self.subTest(value=repr(value)):
                self.rejected(SourceBackend(), focus=0, commits=0, value=value, before_ui=True)

    def test_unicode_replace_and_append_keep_exact_original_codepoints(self):
        for replace, initial in [(True, "old"), (False, "前缀 ")]:
            with self.subTest(replace=replace):
                value = " 上  海🙂e\u0301 "
                backend = SourceBackend(value=initial)
                flow(backend, value=value, replace=replace)
                self.assertEqual(backend.value, value if replace else initial + value)
                self.assertEqual((backend.focus_taps, backend.commits, backend.business_submissions), (1, 1, 1))


if __name__ == "__main__":
    unittest.main()
