from __future__ import annotations

import datetime
import hashlib
import json
import os
import shlex
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from apk_inventory.setup_android import AndroidSetup, AndroidSetupError, PROXY_KEYS


class FakeADB:
    def __init__(self, serial="emulator-5554"):
        self.serial = serial
        self.devices = [(serial, "device")]
        self.settings = {"http_proxy": "old.example.test:3128"}
        self.reverse = {}
        self.files = {}
        self.calls = []
        self.fail_install = False
        self.fail_launch = False
        self.fail_installer = False
        self.lose_setting_ack = False

    def __call__(self, argv, timeout=30):
        self.calls.append(argv)
        def result(value="", code=0):
            return subprocess.CompletedProcess(argv, code, value, "")
        if argv[1:3] == ["devices", "-l"]:
            return result("List of devices attached\n" + "\n".join(s + " " + state for s, state in self.devices))
        assert argv[:3] == ["adb", "-s", self.serial], argv
        args = argv[3:]
        if args == ["get-state"]:
            return result("device")
        if args[:1] == ["reverse"]:
            if args[1:] == ["--list"]:
                return result("\n".join(self.serial + " " + left + " " + right for left, right in self.reverse.items()))
            if args[1] == "--no-rebind":
                if args[2] in self.reverse:
                    return result("", 1)
                self.reverse[args[2]] = args[3]
            elif args[1] == "--remove":
                self.reverse.pop(args[2], None)
            return result()
        if args[:1] == ["install"]:
            return result("Failure [FIXTURE_INSTALL_FAILED]" if self.fail_install else "Success", int(self.fail_install))
        if args[:1] == ["push"]:
            self.files[args[2]] = Path(args[1]).read_bytes()
            return result("1 file pushed")
        assert args[0] == "shell", args
        shell = shlex.split(args[1])
        if shell == ["settings", "list", "global"]:
            return result("\n".join(k + "=" + v for k, v in self.settings.items()))
        if shell[:3] == ["settings", "put", "global"]:
            self.settings[shell[3]] = shell[4]
            if self.lose_setting_ack:
                self.lose_setting_ack = False
                raise subprocess.TimeoutExpired(argv, timeout)
            return result()
        if shell[:3] == ["settings", "delete", "global"]:
            self.settings.pop(shell[3], None)
            return result()
        if shell[:2] == ["test", "-e"]:
            return result("", 0 if shell[2] in self.files else 1)
        if shell[:1] == ["sha256sum"]:
            data = self.files.get(shell[1])
            return result(hashlib.sha256(data).hexdigest() + "  " + shell[1]) if data is not None else result("", 1)
        if shell[:2] == ["rm", "--"]:
            self.files.pop(shell[2], None)
            return result()
        if shell[:3] == ["cmd", "package", "resolve-activity"]:
            return result(shell[-1] + "/.MainActivity")
        if shell[:3] == ["am", "start", "-n"]:
            return result("Error: fixture launch failure" if self.fail_launch else "Starting: Intent")
        if shell[:3] == ["am", "start", "-a"]:
            return result("Error: Activity not found" if self.fail_installer and "file://" in " ".join(shell) else "Starting: Intent")
        raise AssertionError(shell)


class AndroidSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Synthetic capture setup CA")])
        now = datetime.datetime.now(datetime.timezone.utc)
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                .serial_number(1).not_valid_before(now - datetime.timedelta(minutes=1))
                .not_valid_after(now + datetime.timedelta(days=1))
                .add_extension(x509.BasicConstraints(ca=True, path_length=None), True)
                .sign(key, hashes.SHA256()))
        self.ca = self.root / "public CA ; literal.crt"
        self.ca.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        self.options = {"proxy_port": 8080, "state_dir": str(self.root / "state")}

    def adapter(self, fake=None, **options):
        fake = fake or FakeADB()
        return AndroidSetup({**self.options, **options}, fake), fake

    def test_usb_authorization_is_a_retryable_plan_without_mutations(self):
        fake = FakeADB("USB123")
        fake.devices = [("USB123", "unauthorized")]
        adapter, _ = self.adapter(fake)
        self.assertEqual(adapter.plan()["code"], "ANDROID_USB_AUTH_REQUIRED")
        self.assertTrue(all(c[1:3] == ["devices", "-l"] for c in fake.calls))
        with self.assertRaises(AndroidSetupError):
            adapter.apply()

    def test_multiple_devices_are_not_silently_reduced_to_one(self):
        fake = FakeADB()
        fake.devices.append(("USB123", "unauthorized"))
        adapter, _ = self.adapter(fake)
        self.assertEqual(adapter.plan()["code"], "ANDROID_DEVICE_SELECTION")
        selected, _ = self.adapter(fake, device="emulator-5554")
        self.assertEqual(selected.plan()["status"], "ready")

    def test_emulator_proxy_and_absent_settings_are_restored(self):
        fake = FakeADB()
        fake.settings = {}
        adapter, _ = self.adapter(fake)
        state = adapter.apply()
        self.assertEqual(fake.settings["http_proxy"], "10.0.2.2:8080")
        self.assertFalse(state["reverse"]["owned"])
        self.assertEqual(adapter.restore(state)["proxy"], "restored")
        self.assertEqual(fake.settings, {})
        self.assertEqual(adapter.restore(state)["proxy"], "already_restored")

    def test_physical_reverse_port_is_owned_without_rebinding_existing_mapping(self):
        fake = FakeADB("USB123")
        fake.reverse["tcp:8080"] = "tcp:9999"
        adapter, _ = self.adapter(fake)
        before = fake.settings.copy()
        state = adapter.apply()
        self.assertEqual(fake.settings["http_proxy"], "127.0.0.1:8081")
        self.assertEqual(fake.reverse["tcp:8080"], "tcp:9999")
        self.assertEqual(adapter.restore(state)["reverse"], "removed")
        self.assertEqual(fake.reverse, {"tcp:8080": "tcp:9999"})
        self.assertEqual(fake.settings, before)
        self.assertTrue(any(c[3:5] == ["reverse", "--no-rebind"] for c in fake.calls))

    def test_concurrent_proxy_or_reverse_edits_are_not_overwritten(self):
        fake = FakeADB("USB123")
        adapter, _ = self.adapter(fake)
        state = adapter.apply()
        fake.settings["http_proxy"] = "human.example.test:9000"
        fake.reverse["tcp:8080"] = "tcp:9090"
        result = adapter.restore(state)
        self.assertEqual(result["proxy"], "changed_externally_not_overwritten")
        self.assertEqual(result["reverse"], "changed_externally_not_removed")
        self.assertEqual(fake.settings["http_proxy"], "human.example.test:9000")

    def test_pac_is_never_overwritten_and_manual_mode_preserves_it(self):
        fake = FakeADB()
        fake.settings["global_proxy_pac_url"] = "https://pac.example.test/proxy.pac"
        before = fake.settings.copy()
        adapter, _ = self.adapter(fake)
        self.assertEqual(adapter.plan()["code"], "ANDROID_PAC_ACTIVE")
        with self.assertRaises(AndroidSetupError):
            adapter.apply()
        manual, _ = self.adapter(fake, manage_proxy="manual")
        self.assertEqual(manual.apply()["proxy_status"], "manual_unchanged")
        self.assertEqual(fake.settings, before)

    def test_lost_write_ack_rolls_back_the_setting_and_reverse(self):
        fake = FakeADB("USB123")
        before = fake.settings.copy()
        fake.lose_setting_ack = True
        adapter, _ = self.adapter(fake)
        with self.assertRaises(AndroidSetupError) as error:
            adapter.apply()
        self.assertEqual(error.exception.state["rollback"]["proxy"], "restored")
        self.assertEqual(fake.settings, before)
        self.assertEqual(fake.reverse, {})

    def test_launcher_failure_rolls_back_without_uninstalling_or_clearing(self):
        fake = FakeADB("USB123")
        fake.fail_launch = True
        adapter, _ = self.adapter(fake, bundle_id="com.example.fixture")
        before = fake.settings.copy()
        with self.assertRaises(AndroidSetupError) as error:
            adapter.apply()
        self.assertEqual(error.exception.state["rollback"]["reverse"], "removed")
        self.assertEqual(fake.settings, before)
        self.assertFalse(any("uninstall" in c or any("pm clear" in x for x in c) for c in fake.calls))

    def test_install_failure_does_not_change_proxy_or_delete_existing_app(self):
        fake = FakeADB()
        fake.fail_install = True
        adapter, _ = self.adapter(fake)
        adapter._metadata = {"artifact": str(self.root / "local APK.apk"), "package_name": "com.example.fixture"}
        before = fake.settings.copy()
        with self.assertRaises(AndroidSetupError) as error:
            adapter.apply()
        self.assertEqual(error.exception.code, "ANDROID_INSTALL_FAILED")
        self.assertEqual(fake.settings, before)
        self.assertFalse(any(c[3:4] == ["uninstall"] for c in fake.calls))
        install = next(c for c in fake.calls if c[3:4] == ["install"])
        self.assertEqual(install[4:], ["-r", str(self.root / "local APK.apk")])

    def test_local_apk_identity_is_parsed_and_mismatch_is_rejected(self):
        artifact = self.root / "synthetic fixture.apk"
        manifest = b'<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.fixture"><application/></manifest>'
        with zipfile.ZipFile(artifact, "w") as archive:
            archive.writestr("AndroidManifest.xml", manifest)
        adapter, fake = self.adapter(artifact=str(artifact), launch=False)
        state = adapter.apply()
        self.assertEqual(state["app"]["package_name"], "com.example.fixture")
        self.assertTrue(state["app"]["installed_by_run"])
        adapter.restore(state)
        rejected, second = self.adapter(artifact=str(artifact), bundle_id="com.example.different")
        with self.assertRaises(AndroidSetupError) as error:
            rejected.plan()
        self.assertEqual(error.exception.code, "ANDROID_PACKAGE_MISMATCH")
        self.assertEqual(second.calls, [])

    def test_ca_handoff_keeps_manual_status_even_when_intent_opens(self):
        adapter, fake = self.adapter(ca_cert=str(self.ca))
        state = adapter.apply()
        self.assertEqual(state["status"], "action_required")
        self.assertIsNone(state["ca"]["trusted"])
        self.assertEqual(state["ca"]["status"], "manual_confirmation_required")
        self.assertTrue(state["ca"]["installer_requested"])
        push = next(c for c in fake.calls if c[3:4] == ["push"])
        self.assertEqual(len(push), 6)
        self.assertNotIn(b"PRIVATE KEY", Path(push[4]).read_bytes())
        result = adapter.restore(state)
        self.assertEqual(result["certificate_file"], "removed")
        self.assertEqual(result["ca_trust"], "retained")

    def test_certificate_settings_and_local_download_fallback(self):
        fake = FakeADB()
        fake.fail_installer = True
        adapter, _ = self.adapter(fake, ca_cert=str(self.ca), ca_url="http://127.0.0.1:8090/local-token/ca.crt")
        state = adapter.apply()
        self.assertTrue(state["ca"]["settings_requested"])
        self.assertTrue(state["ca"]["browser_requested"])
        self.assertEqual(state["ca"]["status"], "manual_confirmation_required")
        self.assertFalse(any("root" in c or "remount" in c for c in fake.calls))

    def test_replaced_certificate_file_is_preserved_and_ca_removal_is_explicit(self):
        adapter, fake = self.adapter(ca_cert=str(self.ca))
        state = adapter.apply()
        remote = state["ca"]["remote_file"]
        fake.files[remote] = b"human replacement"
        result = adapter.restore(state, remove_ca=True)
        self.assertEqual(result["certificate_file"], "changed_or_unverified_not_removed")
        self.assertEqual(result["ca_trust"], "manual_removal_required")
        self.assertEqual(fake.files[remote], b"human replacement")

    def test_confirmed_project_ca_does_not_reopen_installer(self):
        adapter, fake = self.adapter(ca_cert=str(self.ca), ca_confirmed=True)
        state = adapter.apply()
        self.assertEqual(state["ca"]["trusted"], "user_asserted")
        self.assertFalse(any(c[3:4] == ["push"] for c in fake.calls))

    def test_private_key_ca_input_rolls_back(self):
        path = self.root / "private.pem"
        path.write_text("-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----")
        adapter, fake = self.adapter(ca_cert=str(path))
        before = fake.settings.copy()
        with self.assertRaises(AndroidSetupError) as error:
            adapter.apply()
        self.assertEqual(error.exception.code, "ANDROID_CA_INVALID")
        self.assertEqual(fake.settings, before)

    def test_target_launch_can_be_deferred_until_after_ca_confirmation(self):
        adapter, fake = self.adapter(bundle_id="com.example.fixture", ca_cert=str(self.ca), launch=False)
        state = adapter.apply()
        self.assertFalse(state["app"]["launched"])
        self.assertFalse(any(c[3:4] == ["shell"] and "am start -n" in c[4] for c in fake.calls))
        self.assertTrue(adapter.launch(state)["app"]["launched"])

    def test_stderr_launcher_error_is_not_mistaken_for_success(self):
        fake = FakeADB()
        def runner(argv, timeout=30):
            result = fake(argv, timeout)
            if len(argv) == 5 and argv[3] == "shell" and shlex.split(argv[4])[:3] == ["am", "start", "-n"]:
                return subprocess.CompletedProcess(argv, 0, "", "Error: fixture activity not found")
            return result
        adapter = AndroidSetup({**self.options, "bundle_id": "com.example.fixture", "launch": False}, runner)
        before = fake.settings.copy()
        state = adapter.apply()
        with self.assertRaises(AndroidSetupError) as error:
            adapter.launch(state)
        self.assertEqual(error.exception.code, "ANDROID_LAUNCH_FAILED")
        self.assertFalse(state["app"]["launched"])
        self.assertEqual(fake.settings, before)

    def test_recovery_checkpoint_precedes_proxy_write_and_is_private(self):
        fake = FakeADB("USB123")
        checkpoint = Path(self.options["state_dir"]) / "android-state.json"
        observed = []
        def runner(argv, timeout=30):
            if len(argv) == 5 and argv[3] == "shell" and shlex.split(argv[4])[:4] == ["settings", "put", "global", "http_proxy"]:
                data = json.loads(checkpoint.read_text())
                if data["status"] == "applying":
                    observed.append(data)
                    self.assertTrue(data["proxy_intended"])
                    self.assertTrue(data["reverse"]["owned"])
            return fake(argv, timeout)
        adapter = AndroidSetup(self.options, runner)
        state = adapter.apply()
        self.assertTrue(observed)
        self.assertEqual(checkpoint.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(checkpoint.read_text())["proxy_target"], state["proxy_target"])
        adapter.restore(state)

    def test_new_process_receipt_recovers_after_abrupt_write_interruption(self):
        fake = FakeADB("USB123")
        original = fake.settings.copy()
        checkpoint = Path(self.options["state_dir"]) / "android-state.json"
        def runner(argv, timeout=30):
            result = fake(argv, timeout)
            if len(argv) == 5 and argv[3] == "shell" and shlex.split(argv[4])[:4] == ["settings", "put", "global", "http_proxy"]:
                raise SystemExit("synthetic abrupt process interruption")
            return result
        interrupted = AndroidSetup(self.options, runner)
        with self.assertRaises(SystemExit):
            interrupted.apply()
        saved = json.loads(checkpoint.read_text())
        self.assertTrue(saved["proxy_intended"])
        self.assertNotIn("proxy_after", saved)
        recovered = AndroidSetup(self.options, fake).restore(saved)
        self.assertEqual(recovered["proxy"], "restored")
        self.assertEqual(recovered["reverse"], "removed")
        self.assertEqual(fake.settings, original)
        self.assertEqual(fake.reverse, {})

    def test_journal_io_failure_after_proxy_write_does_not_block_rollback(self):
        fake = FakeADB("USB123")
        adapter = AndroidSetup(self.options, fake)
        original = fake.settings.copy()
        from apk_inventory import setup_android
        real_atomic = setup_android.atomic_json
        def fail_after_write(path, value):
            if value.get("proxy_after"):
                raise OSError("synthetic disk write failure")
            return real_atomic(path, value)
        with mock.patch("apk_inventory.setup_android.atomic_json", side_effect=fail_after_write):
            with self.assertRaises(AndroidSetupError) as error:
                adapter.apply()
        self.assertEqual(error.exception.code, "ANDROID_CHECKPOINT_FAILED")
        self.assertEqual(error.exception.state["rollback"]["proxy"], "restored")
        self.assertEqual(error.exception.state["rollback"]["checkpoint"], "write_failed_recovery_kept_in_memory")
        self.assertEqual(fake.settings, original)
        self.assertEqual(fake.reverse, {})

    def test_reverse_ack_loss_persists_uncertain_intent_without_stealing_mapping(self):
        fake = FakeADB("USB123")
        checkpoint = Path(self.options["state_dir"]) / "android-state.json"
        seen_intent = []
        def runner(argv, timeout=30):
            if argv[3:5] == ["reverse", "--no-rebind"]:
                seen_intent.append(json.loads(checkpoint.read_text())["reverse"])
                fake(argv, timeout)
                raise subprocess.TimeoutExpired(argv, timeout)
            return fake(argv, timeout)
        adapter = AndroidSetup(self.options, runner)
        with self.assertRaises(AndroidSetupError) as error:
            adapter.apply()
        self.assertTrue(seen_intent[0]["intended"])
        saved = json.loads(checkpoint.read_text())
        self.assertTrue(saved["reverse"]["intended"])
        self.assertFalse(saved["reverse"]["owned"])
        self.assertEqual(error.exception.state["rollback"]["reverse"], "pending_creation_requires_review")
        self.assertEqual(fake.reverse, {"tcp:8080": "tcp:8080"})

    def test_symlink_checkpoint_is_rejected_before_device_mutation(self):
        directory = Path(self.options["state_dir"])
        directory.mkdir()
        victim = self.root / "unrelated.json"
        victim.write_text("unchanged")
        (directory / "android-state.json").symlink_to(victim)
        adapter, fake = self.adapter()
        before = fake.settings.copy()
        with self.assertRaises(AndroidSetupError) as error:
            adapter.apply()
        self.assertEqual(error.exception.code, "ANDROID_STATE_PATH_INVALID")
        self.assertEqual(fake.settings, before)
        self.assertEqual(victim.read_text(), "unchanged")

    def test_first_ca_setup_opens_guide_before_installer(self):
        url = "http://setup-0123456789ab.capture.invalid/local-token/"
        adapter, fake = self.adapter(ca_cert=str(self.ca), onboarding_url=url)
        state = adapter.apply()
        opened = [shlex.split(c[4]) for c in fake.calls if len(c) == 5 and c[3] == "shell" and shlex.split(c[4])[:3] == ["am", "start", "-a"]]
        guide = next(i for i, command in enumerate(opened) if url in command)
        certificate = next(i for i, command in enumerate(opened) if any(x.startswith("file://") for x in command))
        self.assertLess(guide, certificate)
        self.assertEqual(state["ca"]["status"], "manual_confirmation_required")

    def test_remote_shell_restoration_quotes_literal_previous_values(self):
        fake = FakeADB()
        original = "old.example.test:3128; echo LITERAL_NOT_EXECUTED"
        fake.settings["http_proxy"] = original
        adapter, _ = self.adapter(fake)
        state = adapter.apply()
        adapter.restore(state)
        self.assertEqual(fake.settings["http_proxy"], original)
        restored = [c[4] for c in fake.calls if len(c) == 5 and c[3] == "shell" and "LITERAL_NOT_EXECUTED" in c[4]]
        self.assertTrue(restored)
        self.assertTrue(any(shlex.split(c) == ["settings", "put", "global", "http_proxy", original] for c in restored))


if __name__ == "__main__":
    unittest.main()
