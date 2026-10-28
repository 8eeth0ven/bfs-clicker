from __future__ import annotations

import datetime
import json
import os
import plistlib
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from apk_inventory.setup_ios import IOSSetup, IOSSetupError, build_profile


def device(identifier="CORE-ONE", udid="UDID-ONE", paired=True):
    return {"identifier": identifier, "hardwareProperties": {"udid": udid},
            "deviceProperties": {"name": "Synthetic iPhone", "developerModeStatus": "enabled"},
            "connectionProperties": {"pairingState": "paired" if paired else "unpaired", "tunnelState": "connected"}}


class Runner:
    def __init__(self, physical=None, simulators=None, cfg=None, fail=None, help_text=None):
        self.physical = physical
        self.simulators = simulators
        self.cfg = cfg
        self.fail = fail or {}
        self.help_text = help_text
        self.calls = []

    def __call__(self, argv, timeout=30):
        self.calls.append(argv)
        joined = " ".join(argv)
        for needle, code in self.fail.items():
            if needle in joined:
                return SimpleNamespace(returncode=code, stdout="", stderr="fixture failure")
        if "simctl list devices --json" in joined:
            if self.simulators is None:
                return SimpleNamespace(returncode=72, stdout="", stderr="")
            return SimpleNamespace(returncode=0, stdout=json.dumps({"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-18-0": self.simulators}}), stderr="")
        if "simctl help keychain" in joined:
            return SimpleNamespace(returncode=0, stdout="keychain <device> add-root-cert certificate | reset", stderr="")
        if "devicectl list devices" in joined:
            if self.physical is None:
                return SimpleNamespace(returncode=72, stdout="", stderr="")
            payload = {"result": {"devices": self.physical}}
            destination = Path(argv[argv.index("--json-output") + 1])
            destination.write_text(json.dumps(payload))
            return SimpleNamespace(returncode=0, stdout="human output is intentionally ignored", stderr="")
        if "cfg-fixture" in argv[0]:
            if "help" in argv or "--help" in argv:
                return SimpleNamespace(returncode=0, stdout=self.help_text if self.help_text is not None else "--ecid --format list install-profile install-app", stderr="")
            if argv[-1] == "list":
                return SimpleNamespace(returncode=0, stdout=json.dumps({"Type": "DeviceList", "Devices": self.cfg or []}), stderr="")
        if "devicectl help manage pair" in joined:
            return SimpleNamespace(returncode=0, stdout="manage pair --device <identifier>", stderr="")
        return SimpleNamespace(returncode=0, stdout="", stderr="")


class IOSSetupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        now = datetime.datetime.now(datetime.timezone.utc)
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "bfs-clicker synthetic test CA")])
        cls.certificate = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
                           .serial_number(1).not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=30))
                           .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True).sign(key, hashes.SHA256()))
        cls.private_key = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ca = self.root / "public-ca.pem"
        self.ca.write_bytes(self.certificate.public_bytes(serialization.Encoding.PEM))
        self.options = {"target": "ios", "proxy_host": "192.0.2.10", "proxy_port": 8080,
                        "ca_cert": str(self.ca), "state_dir": str(self.root / "state"), "keep_ca": True}

    def adapter(self, runner=None, **options):
        with mock.patch("apk_inventory.setup_ios.shutil.which", return_value=None):
            return IOSSetup({**self.options, **options}, runner=runner or Runner())

    def app(self):
        path = self.root / "Fixture App.app"
        path.mkdir()
        (path / "Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": "test.example.fixture", "CFBundleExecutable": "Fixture"}))
        (path / "Fixture").write_bytes(b"synthetic executable fixture")
        (path / "Fixture").chmod(0o755)
        return path

    def test_profile_contains_only_public_ca_and_stable_project_identity(self):
        first, metadata = build_profile(self.options)
        second, again = build_profile({**self.options, "state_dir": str(self.root / "another")})
        self.assertEqual(first, second)
        self.assertEqual(metadata["identifier"], again["identifier"])
        profile = plistlib.loads(first)
        self.assertEqual(profile["PayloadContent"][0]["PayloadContent"], self.certificate.public_bytes(serialization.Encoding.DER))
        self.assertFalse(profile["PayloadRemovalDisallowed"])
        self.assertNotIn(b"PRIVATE KEY", first)
        self.assertEqual(metadata["trust"], "verification_required")

    def test_wifi_profile_has_proxy_but_never_wifi_or_proxy_password(self):
        data, meta = build_profile({**self.options, "wifi_ssid": "Fixture Wi-Fi"})
        wifi = plistlib.loads(data)["PayloadContent"][1]
        self.assertEqual(wifi["PayloadType"], "com.apple.wifi.managed")
        self.assertEqual(wifi["ProxyType"], "Manual")
        self.assertEqual(wifi["EncryptionType"], "Any")
        self.assertNotIn("Password", wifi)
        self.assertNotIn("ProxyPassword", wifi)
        self.assertEqual(meta["proxy_mode"], "wifi")
        for option in ("wifi_password", "proxy_password"):
            with self.assertRaises(IOSSetupError):
                build_profile({**self.options, option: "SYNTHETIC_NOT_TO_DISTRIBUTE"})

    def test_pac_profile_is_stable_across_capture_ports_and_has_direct_fallback(self):
        options = {**self.options, "wifi_ssid": "Fixture Wi-Fi", "pac_url": "http://192.0.2.10:9090/project-fixture/proxy.pac"}
        first, metadata = build_profile(options)
        second, again = build_profile({**options, "proxy_port": 18080})
        self.assertEqual(first, second)
        self.assertEqual(metadata["identifier"], again["identifier"])
        wifi = plistlib.loads(first)["PayloadContent"][1]
        self.assertEqual(wifi["ProxyType"], "Auto")
        self.assertEqual(wifi["ProxyPACURL"], options["pac_url"])
        self.assertTrue(wifi["ProxyPACFallbackAllowed"])
        self.assertNotIn("ProxyServerPort", wifi)
        self.assertNotIn("Password", wifi)
        adapter = self.adapter(pac_url=options["pac_url"], wifi_ssid="Fixture Wi-Fi")
        restored = adapter.restore(adapter.apply())
        self.assertEqual(restored["proxy"], "pac_direct_or_unreachable_fallback")
        self.assertFalse(restored["original_wifi_settings_restored"])
        self.assertFalse(restored["action_required"])
        with self.assertRaises(IOSSetupError):
            build_profile({**options, "pac_url": "http://user:password@192.0.2.10/proxy.pac"})

    def test_global_proxy_requires_explicit_supervised_mode(self):
        data, meta = build_profile({**self.options, "supervised": True})
        self.assertEqual(plistlib.loads(data)["PayloadContent"][1]["PayloadType"], "com.apple.proxy.http.global")
        self.assertTrue(meta["requires_supervision"])
        with self.assertRaises(IOSSetupError):
            build_profile({**self.options, "supervised": True, "wifi_ssid": "Fixture"})

    def test_private_key_and_oversized_ssid_are_rejected(self):
        self.ca.write_bytes(self.private_key)
        with self.assertRaises(IOSSetupError) as failure:
            build_profile(self.options)
        self.assertEqual(failure.exception.code, "CA_PRIVATE_KEY")
        self.ca.write_bytes(self.certificate.public_bytes(serialization.Encoding.PEM))
        with self.assertRaises(IOSSetupError):
            build_profile({**self.options, "wifi_ssid": "测" * 20})

    def test_missing_xcode_still_produces_profile_and_accurate_portal_steps(self):
        adapter = self.adapter()
        plan = adapter.plan()
        self.assertFalse(plan["capabilities"]["devicectl"])
        self.assertFalse((self.root / "state").exists())
        state = adapter.apply()
        self.assertTrue(Path(state["profile"]["path"]).is_file())
        self.assertEqual(Path(state["profile"]["path"]).stat().st_mode & 0o777, 0o600)
        self.assertFalse(state["profile"]["installed"])
        self.assertEqual(state["trust"], "verification_required")
        self.assertIn("CA_FULL_TRUST_REQUIRED", [x["code"] for x in state["action_required"]])

    def test_cfgutil_installs_profile_only_for_exact_ecid_and_no_trust_claim(self):
        runner = Runner(physical=[device()], cfg=[{"ECID": "0x1234", "UDID": "UDID-ONE", "Name": "Fixture"}])
        adapter = self.adapter(runner, cfgutil="cfg-fixture", device="CORE-ONE", wifi_ssid="Fixture Wi-Fi")
        state = adapter.apply()
        installs = [x for x in runner.calls if "install-profile" in x]
        self.assertEqual(len(installs), 1)
        self.assertEqual(installs[0][installs[0].index("--ecid") + 1], "0x1234")
        self.assertTrue(state["profile"]["installed"])
        self.assertEqual(state["trust"], "verification_required")
        self.assertFalse(any("--foreach" in x for x in runner.calls))

    def test_cfgutil_ambiguous_or_unmatched_device_never_installs_any_profile(self):
        for selector in (None, "UNRELATED-CORE-ID"):
            runner = Runner(cfg=[{"ECID": "0x1234", "UDID": "ONE"}, {"ECID": "0x5678", "UDID": "TWO"}])
            self.adapter(runner, cfgutil="cfg-fixture", device=selector).apply()
            self.assertFalse(any("install-profile" in x for x in runner.calls))

    def test_unsupported_cfgutil_capability_falls_back_without_mutation(self):
        runner = Runner(cfg=[{"ECID": "0x1234"}], help_text="unsupported tool")
        state = self.adapter(runner, cfgutil="cfg-fixture").apply()
        self.assertFalse(state["capabilities"]["cfgutil"]["available"])
        self.assertFalse(any("install-profile" in x for x in runner.calls))

    def test_cfgutil_denial_preserves_recovery_receipt_and_manual_steps(self):
        runner = Runner(cfg=[{"ECID": "0x1234"}], fail={" install-profile ": 1})
        state = self.adapter(runner, cfgutil="cfg-fixture").apply()
        self.assertFalse(state["profile"]["installed"])
        self.assertTrue(Path(state["profile"]["path"]).exists())
        self.assertIn("CA_FULL_TRUST_REQUIRED", [x["code"] for x in state["action_required"]])

    def test_simulator_selection_and_ca_actions_do_not_touch_other_devices(self):
        sims = [{"udid": "SIM-ONE", "name": "iPhone Fixture", "state": "Booted", "isAvailable": True},
                {"udid": "SIM-TWO", "name": "iPhone Other", "state": "Shutdown", "isAvailable": True}]
        runner = Runner(simulators=sims)
        state = self.adapter(runner, target="ios-simulator", onboarding_url="http://127.0.0.1:9000/setup-fixture").apply()
        root_calls = [x for x in runner.calls if "add-root-cert" in x]
        self.assertEqual(root_calls[0][3], "SIM-ONE")
        self.assertTrue(state["ca_added"])
        self.assertEqual(state["trust"], "verification_required")
        self.assertFalse(any("reset" in x or "erase" in x for x in runner.calls))
        self.assertTrue(state["onboarding_opened"])

    def test_multiple_booted_simulators_require_selection(self):
        runner = Runner(simulators=[{"udid": n, "state": "Booted", "isAvailable": True} for n in ("SIM-ONE", "SIM-TWO")])
        state = self.adapter(runner, target="ios-simulator").apply()
        self.assertIsNone(state["device"])
        self.assertFalse(any("add-root-cert" in x for x in runner.calls))

    def test_explicit_shutdown_simulator_boots_before_certificate_import(self):
        runner = Runner(simulators=[{"udid": "SIM-ONE", "state": "Shutdown", "isAvailable": True}])
        state = self.adapter(runner, target="ios-simulator", device="SIM-ONE").apply()
        boot = next(i for i, x in enumerate(runner.calls) if x[1:3] == ["simctl", "boot"])
        cert = next(i for i, x in enumerate(runner.calls) if "add-root-cert" in x)
        self.assertLess(boot, cert)
        self.assertTrue(state["simulator_booted_by_run"])

    def test_deferred_launch_is_one_separate_action_after_preparation(self):
        runner = Runner(simulators=[{"udid": "SIM-ONE", "state": "Booted", "isAvailable": True}])
        adapter = self.adapter(runner, target="ios-simulator", artifact=str(self.app()), launch=False)
        state = adapter.apply()
        self.assertTrue(state["app"]["installed"])
        self.assertFalse(any(x[1:3] == ["simctl", "launch"] for x in runner.calls))
        result = adapter.launch(state)
        self.assertEqual(result["status"], "launched")
        self.assertEqual([x for x in runner.calls if x[1:3] == ["simctl", "launch"]][0][-1], "test.example.fixture")

    def test_codesign_or_install_failure_does_not_uninstall_existing_application(self):
        runner = Runner(physical=[device()], fail={"codesign --verify": 1})
        state = self.adapter(runner, artifact=str(self.app())).apply()
        self.assertIn("APP_SIGNATURE_REQUIRED", [x["code"] for x in state["action_required"]])
        self.assertFalse(any("uninstall" in x or "erase" in x for x in runner.calls))
        self.assertFalse(any(x[1:5] == ["devicectl", "device", "install", "app"] for x in runner.calls))

    def test_ipa_devicectl_path_is_extracted_app_with_executable_mode(self):
        app = self.app()
        ipa = self.root / "Fixture Signed.ipa"
        with zipfile.ZipFile(ipa, "w") as archive:
            for path in app.iterdir():
                info = zipfile.ZipInfo("Payload/Fixture.app/" + path.name)
                info.external_attr = ((0o100755 if path.name == "Fixture" else 0o100644) << 16)
                archive.writestr(info, path.read_bytes())
        runner = Runner(physical=[device()])
        observed = {}
        def invoke(argv, timeout=30):
            if argv[:2] == ["codesign", "--verify"]:
                observed["mode"] = (Path(argv[-1]) / "Fixture").stat().st_mode & 0o777
            return runner(argv, timeout=timeout)
        state = self.adapter(invoke, artifact=str(ipa), launch=False).apply()
        self.assertTrue(state["app"]["installed"])
        call = next(x for x in runner.calls if x[1:5] == ["devicectl", "device", "install", "app"])
        self.assertTrue(call[-1].endswith(".app"))
        self.assertNotEqual(call[-1], str(ipa))
        self.assertEqual(observed["mode"], 0o755)
        self.assertFalse(any("uninstall" in x for x in runner.calls))

    def test_unpaired_device_requests_system_pairing_but_does_not_install_when_denied(self):
        runner = Runner(physical=[device(paired=False)], fail={"devicectl manage pair": 1})
        state = self.adapter(runner, artifact=str(self.app()), launch=False).apply()
        self.assertTrue(state["pairing_attempted"])
        self.assertFalse(state["device"]["paired"])
        self.assertIn("APP_INSTALL_REQUIRED", [x["code"] for x in state["action_required"]])
        self.assertFalse(any(x[1:5] == ["devicectl", "device", "install", "app"] for x in runner.calls))

    def test_connected_device_is_preferred_over_an_offline_cached_entry(self):
        offline = device(identifier="OLD-CORE", udid="OLD-UDID")
        offline["connectionProperties"]["tunnelState"] = "disconnected"
        plan = self.adapter(Runner(physical=[offline, device()])).plan()
        self.assertEqual(plan["device"]["id"], "CORE-ONE")

    def test_supported_devicectl_opens_phone_onboarding_without_private_settings_url(self):
        runner = Runner(physical=[device()])
        def invoke(argv, timeout=30):
            if argv[1:] == ["devicectl", "help", "device", "process", "launch"]:
                runner.calls.append(argv)
                return SimpleNamespace(returncode=0, stdout="launch --device --payload-url", stderr="")
            return runner(argv, timeout=timeout)
        url = "http://192.0.2.10:9000/project-fixture/onboarding"
        state = self.adapter(invoke, onboarding_url=url).apply()
        self.assertTrue(state["onboarding_opened"])
        call = next(x for x in runner.calls if "--payload-url" in x)
        self.assertEqual(call[call.index("--device") + 1], "CORE-ONE")
        self.assertEqual(call[-1], "com.apple.mobilesafari")
        self.assertIn(url, call)
        self.assertNotIn("prefs:", " ".join(call))

    def test_failed_requested_app_is_not_replaced_by_launching_an_old_bundle(self):
        runner = Runner(physical=[device()], fail={"codesign --verify": 1})
        adapter = self.adapter(runner, artifact=str(self.app()), bundle_id="test.example.fixture", launch=False)
        state = adapter.apply()
        result = adapter.launch(state)
        self.assertEqual(result["code"], "APP_INSTALL_REQUIRED")
        self.assertFalse(any(x[1:5] == ["devicectl", "device", "process", "launch"] for x in runner.calls))

    def test_existing_verified_path_skips_redundant_profile_install(self):
        runner = Runner(cfg=[{"ECID": "0x1234"}])
        state = self.adapter(runner, cfgutil="cfg-fixture", ca_ready=True).apply()
        self.assertEqual(state["profile"]["install_state"], "existing_path_verified_by_coordinator")
        self.assertFalse(any("install-profile" in x for x in runner.calls))

    def test_default_restore_keeps_ca_and_explains_ios_proxy_recovery(self):
        adapter = self.adapter()
        state = adapter.apply()
        result = adapter.restore(state)
        self.assertEqual(result["ca"], "kept")
        self.assertEqual(result["proxy"], "manual_reset_required")
        removal = adapter.restore(state, remove_ca=True)
        self.assertIn(state["profile"]["identifier"], removal["action_required"][0]["message"])
        simulator_state = {**state, "target": "ios-simulator"}
        runner = Runner()
        result = self.adapter(runner, target="ios-simulator").restore(simulator_state, remove_ca=True)
        self.assertEqual(result["ca"], "manual_removal_required")
        self.assertEqual(runner.calls, [])

    def test_profile_install_intent_survives_interruption_before_receipt_return(self):
        runner = Runner(cfg=[{"ECID": "0x1234"}])
        checkpoint = self.root / "state" / "ios-state.json"
        observed = {}
        def invoke(argv, timeout=30):
            if "install-profile" in argv:
                observed.update(json.loads(checkpoint.read_text()))
                raise KeyboardInterrupt()
            return runner(argv, timeout=timeout)
        adapter = self.adapter(invoke, cfgutil="cfg-fixture", wifi_ssid="Fixture Wi-Fi", pac_url="http://192.0.2.10:9090/fixture/proxy.pac")
        with self.assertRaises(KeyboardInterrupt):
            adapter.apply()
        self.assertEqual(observed["operations"]["profile_install"]["status"], "intent")
        self.assertEqual(observed["operations"]["profile_install"]["ecid"], "0x1234")
        saved = json.loads(checkpoint.read_text())
        self.assertEqual(checkpoint.stat().st_mode & 0o777, 0o600)
        self.assertEqual(saved["profile"]["identifier"], observed["profile"]["identifier"])
        self.assertIn(saved["profile"]["identifier"], adapter.restore(saved, remove_ca=True)["action_required"][0]["message"])

    def test_simulator_ca_intent_is_durable_when_tool_loses_acknowledgement(self):
        runner = Runner(simulators=[{"udid": "SIM-ONE", "state": "Booted", "isAvailable": True}])
        checkpoint = self.root / "state" / "ios-simulator-state.json"
        def invoke(argv, timeout=30):
            if "add-root-cert" in argv:
                saved = json.loads(checkpoint.read_text())
                self.assertEqual(saved["operations"]["ca_import"]["status"], "intent")
                self.assertEqual(saved["operations"]["ca_import"]["device"], "SIM-ONE")
                raise SystemExit(137)
            return runner(argv, timeout=timeout)
        adapter = self.adapter(invoke, target="ios-simulator")
        with self.assertRaises(SystemExit):
            adapter.apply()
        saved = json.loads(checkpoint.read_text())
        self.assertEqual(saved["trust"], "verification_required")
        self.assertFalse(saved.get("ca_added", False))
        self.assertEqual(adapter.restore(saved)["ca"], "kept")
        self.assertFalse(any("reset" in argv or "erase" in argv for argv in runner.calls))

    def test_profile_history_removal_lists_only_exact_project_profile_identifiers(self):
        adapter = self.adapter(wifi_ssid="Fixture Wi-Fi", pac_url="http://192.0.2.10:9090/fixture/proxy.pac")
        state = adapter.apply()
        _, old = build_profile(self.options)
        state["profile_history"] = [{"target": "ios", "profile": old}]
        result = adapter.restore(state, remove_ca=True)
        descriptions = " ".join(action["message"] for action in result["action_required"])
        self.assertIn(state["profile"]["identifier"], descriptions)
        self.assertIn(old["identifier"], descriptions)
        state["profile_history"] = [{"identifier": "com.other.vendor.profile"}]
        with self.assertRaises(IOSSetupError):
            adapter.restore(state, remove_ca=True)

    def test_apply_exception_includes_state_for_recovery(self):
        app = self.app()
        (app / "Info.plist").write_bytes(b"invalid plist")
        runner = Runner(simulators=[{"udid": "SIM-ONE", "state": "Booted", "isAvailable": True}])
        with self.assertRaises(IOSSetupError) as failure:
            self.adapter(runner, target="ios-simulator", artifact=str(app)).apply()
        self.assertTrue(failure.exception.state["profile"]["path"])
        self.assertTrue(failure.exception.state.get("ca_added"))


if __name__ == "__main__":
    unittest.main()
