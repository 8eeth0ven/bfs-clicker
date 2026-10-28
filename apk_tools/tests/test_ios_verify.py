from __future__ import annotations

import io
import json
import plistlib
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from apk_inventory.extract import ExtractOptions
from apk_inventory.ios import extract_ios
from apk_inventory.ios_verify import main
from apk_inventory.reconcile import VerificationError, finalize_inventory


class IOSVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / "Fixture.app"
        self.app.mkdir()
        (self.app / "Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": "test.example.iosfixture",
                                                            "CFBundleShortVersionString": "1.0"}))
        (self.app / "network.json").write_text(json.dumps({"url": "https://api.example.test/items"}))
        self.inventory = self.root / "inventory"
        extract_ios(self.app, self.inventory, ExtractOptions(native=False))
        self.static_pointer = (self.inventory / "source.json").read_bytes()
        self.har = self.root / "capture.har"
        self.har.write_text(json.dumps({"log": {"entries": [{"request": {
            "method": "GET", "url": "https://api.example.test/items?page=2", "headers": [
                {"name": "Authorization", "value": "Bearer SYNTHETIC_IOS_CAPTURE_CREDENTIAL"}],
            "queryString": [{"name": "page", "value": "2"}]}, "response": {"status": 200}, "time": 1}]}}))

    def invoke(self, *extra):
        out = io.StringIO()
        with redirect_stdout(out):
            code = main([str(self.app), "--inventory", str(self.inventory), *extra])
        return code, json.loads(out.getvalue())

    def test_ios_har_upgrades_only_isolated_and_keeps_artifact_identity(self):
        code, summary = self.invoke("--har", str(self.har), "--isolated-device", "--session-id", "isolated")
        self.assertEqual(code, 0)
        self.assertEqual(summary["observed_unique_operations"], 1)
        descriptor = json.loads((self.inventory / "source.json").read_text())
        records = json.loads((self.inventory / descriptor["inventory"]).read_text())
        endpoint = next(r for r in records if r["url"] == "https://api.example.test/items")
        self.assertEqual(endpoint["method"], "GET")
        self.assertEqual(endpoint["categories"], ["observed"])
        report = json.loads(Path(summary["report"]).read_text())
        self.assertEqual(report["kind"], "ios")
        self.assertEqual(report["artifact_type"], "app")
        self.assertNotIn("apk_sha256", report)
        self.assertNotIn("ipa_sha256", report)
        self.assertEqual(report["cleanup"]["device"], "not_operated")
        for p in (self.inventory / "verified").rglob("*.json*"):
            self.assertNotIn("SYNTHETIC_IOS_CAPTURE_CREDENTIAL", p.read_text())

    def test_unattributed_har_does_not_upgrade_ios_candidates(self):
        code, summary = self.invoke("--har", str(self.har), "--session-id", "unattributed")
        self.assertEqual(code, 0)
        descriptor = json.loads((self.inventory / "source.json").read_text())
        records = json.loads((self.inventory / descriptor["inventory"]).read_text())
        self.assertTrue(all(r["categories"] == ["static_candidate"] for r in records))
        self.assertEqual(summary["observed_unique_operations"], 0)

    def test_changed_app_bundle_is_rejected_before_merge(self):
        (self.app / "network.json").write_text('{"url":"https://api.example.test/changed"}')
        code, summary = self.invoke("--har", str(self.har), "--isolated-device")
        self.assertEqual(code, 2)
        self.assertEqual(summary["error"]["code"], "ARTIFACT_MISMATCH")
        self.assertEqual((self.inventory / "source.json").read_bytes(), self.static_pointer)

    def test_failed_host_proxy_keeps_pointer_and_never_calls_device_commands(self):
        with mock.patch("apk_inventory.ios_verify.ManualIOSCapture.preflight"), \
             mock.patch("apk_inventory.ios_verify.ManualIOSCapture.start_proxy", side_effect=VerificationError("PROXY_START_FAILED", "fixture failure")), \
             mock.patch("apk_inventory.verify.DeviceCapture.configure_device", side_effect=AssertionError("must not configure Android")), \
             mock.patch("apk_inventory.verify.DeviceCapture.start_app", side_effect=AssertionError("must not install an APK")):
            code, summary = self.invoke("--duration", "10ms", "--session-id", "failed")
        self.assertEqual(code, 6)
        self.assertFalse(summary["promoted"])
        self.assertEqual((self.inventory / "source.json").read_bytes(), self.static_pointer)

    def test_ios_inventory_cannot_be_passed_as_an_apk(self):
        with self.assertRaises(VerificationError) as error:
            finalize_inventory(self.inventory, self.app, [], session_id="wrong_kind")
        self.assertEqual(error.exception.code, "INVENTORY_INVALID")

    def test_malformed_source_is_a_json_error_before_proxy_start(self):
        for value in ([], {"format": "endpoint-inventory", "kind": "ios", "app": []},
                      {"format": "wrong", "kind": "ios", "app": {}}):
            with self.subTest(value=value), mock.patch("apk_inventory.ios_verify.ManualIOSCapture.start_proxy", side_effect=AssertionError("invalid source must not start capture")):
                (self.inventory / "source.json").write_text(json.dumps(value))
                code, summary = self.invoke("--duration", "10ms")
                self.assertEqual(code, 2)
                self.assertEqual(summary["error"]["code"], "INVENTORY_INVALID")


if __name__ == "__main__":
    unittest.main()
