"""Real local proxy/TLS orchestration with a no-op OS adapter.

Never installs a CA into the host, changes its proxy or operates a device.
"""
from __future__ import annotations

import contextlib
import hashlib
import http.client
import io
import json
import os
import ssl
import sys
import tempfile
import unittest
from pathlib import Path

from apk_inventory.capture_setup import parser, run_setup


@unittest.skipUnless(Path(sys.executable).with_name("mitmdump").is_file(), "setup extra with mitmdump is required")
class RealSetupProxyTests(unittest.TestCase):
    def test_real_proxy_https_proof_frontend_and_project_ca_reuse(self):
        events = []
        confirmed = []

        class NoHostChanges:
            def __init__(self, options):
                self.options = options

            def plan(self):
                return {"target": "macos", "ready": True}

            def apply(self):
                confirmed.append(self.options["ca_confirmed"])
                session = Path(self.options["state_dir"]).parent
                config = json.loads((session / "canary-config.json").read_text())
                port = self.options["proxy_port"]
                front = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                front.request("GET", "http://" + config["front_host"] + "/" + config["portal_token"] + "/state")
                response = front.getresponse()
                self_check = json.loads(response.read())
                if response.status != 200 or self_check["phase"] != "applying":
                    raise AssertionError("Proxy frontend did not reach the bounded local portal")
                front.close()
                # An absolute HTTPS URL on a plaintext client connection cannot
                # become a TLS-trust success, even with the correct token.
                plain = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                plain.request("GET", "https://" + config["host"] + "/check/" + config["token"],
                              headers={"Origin": config["portal_origins"][0]})
                response = plain.getresponse()
                response.read()
                plain.close()
                if Path(config["result"]).exists():
                    raise AssertionError("Plain HTTP forged TLS proof")
                context = ssl.create_default_context(cafile=self.options["ca_cert"])
                secure = http.client.HTTPSConnection("127.0.0.1", port, timeout=5, context=context)
                secure.set_tunnel(config["host"], 443)
                secure.request("GET", "/check/" + config["token"], headers={"Origin": config["portal_origins"][0]})
                response = secure.getresponse()
                proof = json.loads(response.read())
                secure.close()
                if response.status != 200 or not proof.get("ok"):
                    raise AssertionError("Real project-CA TLS canary failed")
                events.append("tls_verified")
                return {"target": "macos", "proof": config["result"]}

            def launch(self, state):
                if not Path(state["proof"]).is_file():
                    raise AssertionError("Target launched before HTTPS proof")
                events.append("launch")
                return {"status": "not_requested"}

            def restore(self, state, remove_ca=False):
                events.append("restore_noop")
                return {"status": "restored", "host_settings_changed": False}

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "setup"
            args = parser().parse_args(["--target", "macos", "--state-root", str(root),
                                        "--proxy", "18880", "--portal-port", "0", "--no-open",
                                        "--duration", "10ms", "--setup-timeout", "15s", "--finish-grace", "0"])
            with contextlib.redirect_stderr(io.StringIO()):
                first = run_setup(args, adapter_factory=lambda target, options: NoHostChanges(options))
                self.assertTrue(first["ok"], first)
                self.assertTrue(first["https_verified"])
                private = root / "authority/mitmproxy-ca.pem"
                original = hashlib.sha256(private.read_bytes()).hexdigest()
                second = run_setup(args, adapter_factory=lambda target, options: NoHostChanges(options))
            self.assertTrue(second["ok"], second)
            self.assertEqual(original, hashlib.sha256(private.read_bytes()).hexdigest())
            self.assertEqual([False, True], confirmed)
            self.assertEqual(["tls_verified", "launch", "restore_noop"] * 2, events)
            latest = json.loads((root / "latest.json").read_text())
            self.assertEqual("finished", latest["phase"])
            self.assertEqual("selected_browser_proxy_and_tls_path", latest["https_verification"]["evidence_scope"])
            self.assertEqual(0o600, (root / "latest.json").stat().st_mode & 0o777)
            self.assertFalse(latest["cleanup"]["platforms"][0]["host_settings_changed"])


if __name__ == "__main__":
    unittest.main()
