"""Exercise the launchers without installing software or changing host state."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "checkout with spaces"
        self.root.mkdir()
        source = Path(__file__).resolve().parents[2]
        for name in ("capture-setup.sh", "capture-setup.command"):
            shutil.copy2(source / name, self.root / name)
        (self.root / "apk_tools").mkdir()
        shutil.copy2(source / "apk_tools/pyproject.toml", self.root / "apk_tools/pyproject.toml")
        self.log = Path(self.temp.name) / "argv.jsonl"
        self.fake = Path(self.temp.name) / "python path with spaces"
        self.fake.write_text("#!" + sys.executable + "\nimport json,os,sys\nwith open(os.environ['BOOTSTRAP_TEST_LOG'],'a') as stream:stream.write(json.dumps(sys.argv[1:])+chr(10))\n")
        self.fake.chmod(0o755)
        self.env = {**os.environ, "BFS_CAPTURE_PYTHON": str(self.fake), "BOOTSTRAP_TEST_LOG": str(self.log)}

    def invoke(self, name, *args):
        return subprocess.run(["bash", str(self.root / name), *args], cwd=self.temp.name, env=self.env,
                              capture_output=True, text=True, timeout=15)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_dry_run_preserves_space_arguments_without_creating_environment(self):
        artifact = "/path/to/Fixture App.ipa"
        result = self.invoke("capture-setup.sh", "--dry-run", "--target", "ios", artifact)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), [["-m", "apk_inventory.capture_setup", "--dry-run", "--target", "ios", artifact]])
        self.assertFalse((self.root / ".capture-setup").exists())

    def test_double_click_launcher_delegates_interactive_and_all_arguments(self):
        result = self.invoke("capture-setup.command", "--dry-run", "--target", "ios-simulator", "/path/to/Simulator App.app")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls()[0], ["-m", "apk_inventory.capture_setup", "--interactive", "--dry-run", "--target", "ios-simulator", "/path/to/Simulator App.app"])

    def test_no_install_switch_is_consumed_by_bootstrap_and_never_creates_venv(self):
        result = self.invoke("capture-setup.sh", "--no-install-deps", "--target", "macos")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls()[0], ["-m", "apk_inventory.capture_setup", "--target", "macos"])
        self.assertFalse((self.root / ".capture-setup").exists())

    def test_dependency_stamp_reuses_environment_without_pip(self):
        environment = self.root / ".capture-setup/venv"
        (environment / "bin").mkdir(parents=True)
        shutil.copy2(self.fake, environment / "bin/python")
        stamp = hashlib.sha256((self.root / "apk_tools/pyproject.toml").read_bytes()).hexdigest()
        (environment / ".capture-dependencies").write_text(stamp + "\n")
        self.env["BFS_CAPTURE_PYTHON"] = sys.executable
        result = self.invoke("capture-setup.sh", "--target", "ios")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any("pip" in argv for argv in self.calls()))
        self.assertEqual(self.calls()[-1], ["-m", "apk_inventory.capture_setup", "--target", "ios"])

    def test_state_root_symlink_is_rejected_before_pip_or_module_execution(self):
        destination = Path(self.temp.name) / "other"
        destination.mkdir()
        (self.root / ".capture-setup").symlink_to(destination, target_is_directory=True)
        result = self.invoke("capture-setup.sh", "--target", "ios")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.calls(), [])
        self.assertFalse(any(destination.iterdir()))


if __name__ == "__main__":
    unittest.main()
