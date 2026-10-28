"""Lifecycle regression tests; all platform commands and proxy processes are fake."""
from __future__ import annotations

import copy
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import psutil

from apk_inventory.capture_setup import (SessionLock, cleanup_state, parser,
                                         run_setup, stop_owned_proxy)
from apk_inventory.common import InventoryError


class CleanupLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def state(self, names=("macos", "ios-simulator")):
        return {"version": 1, "target": names[-1], "receipts": [
            {"target": name, "options": {"state_dir": str(self.root/name)}, "state": {"marker": name}}
            for name in names], "pending_adapters": []}

    def test_network_restores_in_reverse_before_proxy_shutdown(self):
        timeline = []
        def factory(target, options):
            return SimpleNamespace(restore=lambda state, remove_ca=False:
                                   timeline.append(("restore", target, remove_ca)) or {"status": "restored"})
        state = self.state()
        with mock.patch("apk_inventory.capture_setup.stop_owned_proxy", side_effect=lambda _: timeline.append(("stop_proxy",)) or "stopped"):
            result = cleanup_state(state, remove_ca=True, adapter_factory=factory)
        self.assertEqual([("restore", "ios-simulator", True), ("restore", "macos", True), ("stop_proxy",)], timeline)
        self.assertEqual("stopped", result["proxy_process"])
        self.assertEqual(result, state["cleanup"])

    def test_restore_exception_does_not_skip_other_platform_or_proxy(self):
        timeline = []
        def factory(target, options):
            def restore(state, remove_ca=False):
                timeline.append(target)
                if target == "ios-simulator":
                    raise InventoryError("SYNTHETIC_RESTORE_FAILURE", "fixture")
                return {"status": "restored"}
            return SimpleNamespace(restore=restore)
        with mock.patch("apk_inventory.capture_setup.stop_owned_proxy", side_effect=lambda _: timeline.append("proxy") or "stopped"):
            result = cleanup_state(self.state(), adapter_factory=factory)
        self.assertEqual(["ios-simulator", "macos", "proxy"], timeline)
        self.assertTrue(any(p.get("code") == "SYNTHETIC_RESTORE_FAILURE" for p in result["platforms"]))

    def test_incomplete_apply_checkpoint_is_recovered_without_duplicate_receipt(self):
        state = self.state(("macos",))
        pending_dir = self.root/"android"; pending_dir.mkdir()
        (pending_dir/"android-state.json").write_text(json.dumps({"marker": "pending-android"}))
        state["pending_adapters"] = [
            {"target": "macos", "options": {"state_dir": str(self.root/"macos")}},
            {"target": "android", "options": {"state_dir": str(pending_dir)}}]
        seen = []
        def factory(target, options):
            return SimpleNamespace(restore=lambda value, remove_ca=False:
                                   seen.append((target, value["marker"])) or {"status": "restored"})
        with mock.patch("apk_inventory.capture_setup.stop_owned_proxy", return_value="already_stopped"):
            cleanup_state(state, adapter_factory=factory)
        self.assertEqual([("macos", "macos"), ("android", "pending-android")], seen)

    def test_invalid_receipt_rejected_without_system_actions(self):
        with mock.patch("apk_inventory.capture_setup.stop_owned_proxy") as stop:
            with self.assertRaises(InventoryError):
                cleanup_state([], adapter_factory=lambda *_: self.fail("must not restore invalid state"))
        stop.assert_not_called()

    def test_pid_reuse_with_identical_command_cannot_stop_new_process(self):
        state = {"proxy_process": {"pid": 4242, "command": ["synthetic-proxy"], "create_time": 10.0}}
        process = mock.Mock()
        process.uids.return_value = SimpleNamespace(real=os.getuid())
        process.cmdline.return_value = ["synthetic-proxy"]
        process.create_time.return_value = 20.0
        with mock.patch("psutil.Process", return_value=process):
            result = stop_owned_proxy(state)
        self.assertNotEqual("stopped", result)
        process.send_signal.assert_not_called()
        process.terminate.assert_not_called()
        process.kill.assert_not_called()

    def test_inaccessible_process_is_not_signalled_and_does_not_raise(self):
        state = {"proxy_process": {"pid": 4242, "command": ["synthetic-proxy"], "create_time": 10.0}}
        with mock.patch("psutil.Process", side_effect=psutil.AccessDenied(4242)):
            result = stop_owned_proxy(state)
        self.assertIsInstance(result, str)
        self.assertNotEqual("stopped", result)


class SetupLockTests(unittest.TestCase):
    def test_lock_excludes_another_process_and_is_reusable_after_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)/"capture.lock"
            repo = Path(__file__).resolve().parents[2]
            code = '''from apk_inventory.capture_setup import SessionLock
from apk_inventory.common import InventoryError
import sys
try:
 with SessionLock(sys.argv[1]):
  raise SystemExit(0)
except InventoryError as e:
 raise SystemExit(9 if e.code == "SETUP_BUSY" else 8)
'''
            env = {**os.environ, "PYTHONPATH": str(repo/"apk_tools")}
            with SessionLock(path):
                result = subprocess.run([sys.executable, "-c", code, str(path)], env=env,
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(9, result.returncode, result.stderr)
            result = subprocess.run([sys.executable, "-c", code, str(path)], env=env,
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertEqual(0o600, path.stat().st_mode & 0o777)

    def test_symlink_lock_does_not_touch_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); target = root/"original.txt"; target.write_text("synthetic unchanged")
            link = root/"capture.lock"; link.symlink_to(target)
            with self.assertRaises(InventoryError) as error:
                with SessionLock(link):self.fail("must reject symlink")
            self.assertEqual("SETUP_PATH_INVALID", error.exception.code)
            self.assertEqual("synthetic unchanged", target.read_text())


class ReadinessLifecycleTests(unittest.TestCase):
    def exercise(self, *, consent, fixture_failure=False, wrong_proof=False, previous=False, retry_after_failure=False):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        root = (Path(temp.name)/"setup").resolve()
        if previous:
            previous_dir = root/"sessions/previous"
            previous_dir.mkdir(parents=True)
            old = {"version": 1, "target": "macos", "session_id": "previous", "phase": "failed",
                   "state_path": str(previous_dir/"session.json"), "root": str(root),
                   "receipts": [{"target": "macos", "options": {"state_dir": str(previous_dir/"macos")},
                                 "state": {"marker": "previous-newer"}}], "pending_adapters": [],
                   "cleanup": {"platforms": [{"status": "partial"}], "proxy_process": "stopped"}}
            (previous_dir/"session.json").write_text(json.dumps(old))
            old["receipts"][0]["state"]["marker"] = "previous-stale"
            (root/"latest.json").write_text(json.dumps(old))
        args = parser().parse_args(["--target", "macos", "--state-root", str(root), "--no-open",
                                    "--duration", "10ms", "--setup-timeout", "1s", "--finish-grace", "0"])
        args.no_open = not retry_after_failure
        timeline = []
        context = {"proof": False, "config": None, "child": None, "portal": None}
        fingerprint = "ab"*32
        authority = {"certificate": str(root/"authority/ca.pem"), "sha256": fingerprint, "directory": str(root/"authority")}
        class Child:
            pid = 424242
            def poll(self):return None
            def wait(self, timeout=None):return 0
            def send_signal(self, value):pass
            def terminate(self):pass
            def kill(self):pass
        class Portal:
            def __init__(self, *_, **__):
                self.local_url = "http://127.0.0.1:8766/" + "b"*48 + "/"
                self.url = self.local_url; self.origins = set(); self.stop_requested = threading.Event()
                self.retry_requested = threading.Event(); self.reinstall_requested = threading.Event()
                self.pac_active = False; self.pac_proxy = None
                context["portal"] = self
            def start(self):return self
            def certificate(self, value):pass
            def profile(self, value):pass
            def update(self, **value):
                phase = value.get("phase")
                if phase == "awaiting_consent":
                    timeline.append("awaiting_canary")
                    if consent:
                        cfg = context["config"]
                        Path(cfg["result"]).write_text(json.dumps({"ok": True, "session_id": "another-session" if wrong_proof else cfg["session_id"]}))
                        context["proof"] = True
                        timeline.append("canary_passed")
                    else:
                        self.stop_requested.set()
                elif phase == "capturing":
                    self.stop_requested.set()
                elif phase == "failed" and retry_after_failure:
                    import signal
                    assert signal.getsignal(signal.SIGINT) != signal.SIG_IGN, "approval retries must remain interruptible after restoration"
                    timeline.append("retry_ui")
                    self.retry_requested.set()
            def close(self):timeline.append("portal_closed")
        class Adapter:
            def __init__(self, options):self.options = options
            def plan(self):
                return {"ready": True, "device": {"id": "synthetic-local"}, "manual_steps": []}
            def apply(self):
                timeline.append("apply")
                if fixture_failure:
                    error = KeyboardInterrupt() if fixture_failure == "interrupt" else InventoryError("SYNTHETIC_APPLY_FAILED", "fixture")
                    error.state = {"marker": "intent-before-failure"}
                    raise error
                return {"marker": "applied"}
            def launch(self, state):
                assert context["proof"], "target must not launch before HTTPS readiness"
                timeline.append("launch")
                return {"status": "launch_requested"}
            def restore(self, state, remove_ca=False):
                timeline.append("restore:" + state["marker"])
                return {"status": "restored"}
        def factory(target, options):return Adapter(options)
        def popen(argv, **kwargs):
            config_ref = next(v.split("=", 1)[1] for v in argv if v.startswith("setup_config="))
            context["config"] = json.loads(Path(config_ref).read_text())
            capture = json.loads(Path(kwargs["env"]["APK_VERIFY_CONFIG"]).read_text())
            Path(capture["ready"]).write_text('{"event":"capture_ready"}')
            process = Child();context["child"] = process;context["command"] = argv
            return process
        def process(_):
            return SimpleNamespace(cmdline=lambda: context["command"], create_time=lambda: 123.0,
                                   uids=lambda: SimpleNamespace(real=os.getuid()))
        def stop(_):timeline.append("stop_proxy");return "stopped"
        with mock.patch("apk_inventory.setup_ca.ensure_authority", return_value=authority), \
             mock.patch("apk_inventory.capture_setup.sys.platform", "linux"), \
             mock.patch("apk_inventory.setup_portal.SetupPortal", Portal), \
             mock.patch("apk_inventory.capture_setup.inventory_for", return_value=(None, None, set())), \
             mock.patch("apk_inventory.capture_setup.available_port", return_value=18080), \
             mock.patch("apk_inventory.capture_setup.subprocess.Popen", side_effect=popen), \
             mock.patch("psutil.Process", side_effect=process), \
             mock.patch("apk_inventory.capture_setup.stop_owned_proxy", side_effect=stop):
            summary = run_setup(args, adapter_factory=factory)
        return summary, timeline, root, fingerprint

    def test_canary_precedes_launch_capture_and_trust_cache(self):
        summary, timeline, root, fingerprint = self.exercise(consent=True)
        self.assertTrue(summary["ok"], summary)
        self.assertLess(timeline.index("canary_passed"), timeline.index("launch"))
        self.assertLess(timeline.index("restore:applied"), timeline.index("stop_proxy"))
        cache = json.loads((root/"verified-devices.json").read_text())
        key = hashlib.sha256(b"macos:synthetic-local").hexdigest()
        self.assertEqual(fingerprint, cache[key])
        self.assertEqual("portal_closed", timeline[-1])

    def test_no_canary_means_no_target_launch_and_no_trust_cache(self):
        summary, timeline, root, _ = self.exercise(consent=False)
        self.assertFalse(summary["ok"])
        self.assertNotIn("launch", timeline)
        self.assertFalse((root/"verified-devices.json").exists())
        self.assertIn("restore:applied", timeline)

    def test_retry_ui_is_available_only_after_owned_settings_are_restored(self):
        summary, timeline, root, _ = self.exercise(consent=False, fixture_failure=True, retry_after_failure=True)
        self.assertFalse(summary["ok"])
        self.assertEqual("SETUP_RETRY_REQUESTED", summary["error"]["code"])
        self.assertLess(timeline.index("restore:intent-before-failure"), timeline.index("retry_ui"))
        self.assertLess(timeline.index("stop_proxy"), timeline.index("retry_ui"))
        self.assertNotIn("launch", timeline)
        self.assertEqual("portal_closed", timeline[-1])

    def test_apply_exception_state_is_recovered_even_without_success_receipt(self):
        summary, timeline, root, _ = self.exercise(consent=False, fixture_failure=True)
        self.assertFalse(summary["ok"])
        self.assertEqual("SYNTHETIC_APPLY_FAILED", summary["error"]["code"])
        self.assertIn("restore:intent-before-failure", timeline)
        self.assertNotIn("launch", timeline)
        saved = json.loads(Path(summary["state"]).read_text())
        self.assertEqual("intent-before-failure", saved["receipts"][0]["state"]["marker"])


    def test_failed_previous_cleanup_recovers_fresher_session_before_new_apply(self):
        summary, timeline, root, _ = self.exercise(consent=True, previous=True)
        self.assertTrue(summary["ok"], summary)
        self.assertIn("restore:previous-newer", timeline)
        self.assertNotIn("restore:previous-stale", timeline)
        self.assertLess(timeline.index("restore:previous-newer"), timeline.index("apply"))

    def test_wrong_session_canary_never_launches_or_stamps_cache(self):
        summary, timeline, root, _ = self.exercise(consent=True, wrong_proof=True)
        self.assertFalse(summary["ok"])
        self.assertEqual("CA_PROOF_INVALID", summary["error"]["code"])
        self.assertNotIn("launch", timeline)
        self.assertFalse((root/"verified-devices.json").exists())

    def test_keyboard_interrupt_during_apply_recovers_intent(self):
        summary, timeline, root, _ = self.exercise(consent=False, fixture_failure="interrupt")
        self.assertFalse(summary["ok"])
        self.assertEqual("SETUP_INTERRUPTED", summary["error"]["code"])
        self.assertIn("restore:intent-before-failure", timeline)
        self.assertNotIn("launch", timeline)

    def test_unresolved_previous_recovery_blocks_new_ca_or_proxy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            old = {"version": 1, "target": "macos", "session_id": "previous", "phase": "failed",
                   "receipts": [{"target": "macos", "options": {"state_dir": str(root/"missing-checkpoint")},
                                 "state": {"marker": "failed-cleanup"}}], "pending_adapters": [],
                   "cleanup": {"platforms": [{"status": "partial"}], "proxy_process": "stopped"}}
            (root/"latest.json").write_text(json.dumps(old))
            args = parser().parse_args(["--target", "macos", "--state-root", str(root), "--no-open"])
            factory = lambda *_: SimpleNamespace(restore=lambda *a, **k: {"status": "partial"})
            with mock.patch("apk_inventory.setup_ca.ensure_authority") as ca, \
                 mock.patch("apk_inventory.setup_portal.SetupPortal") as portal, \
                 mock.patch("apk_inventory.capture_setup.stop_owned_proxy", return_value="already_stopped"):
                with self.assertRaises(InventoryError) as error:
                    run_setup(args, adapter_factory=factory)
            self.assertEqual("RECOVERY_REQUIRED", error.exception.code)
            ca.assert_not_called();portal.assert_not_called()
            self.assertEqual("previous", json.loads((root/"latest.json").read_text())["session_id"])


if __name__ == "__main__":
    unittest.main()
