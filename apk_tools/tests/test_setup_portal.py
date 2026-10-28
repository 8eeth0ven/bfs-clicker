"""Local HTTP and fake-flow tests; never change system/device trust or proxies."""
from __future__ import annotations

import copy
import http.client
import json
import os
import plistlib
import tempfile
import threading
import types
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from cryptography import x509
from cryptography.hazmat.primitives import serialization
from mitmproxy import http as mitm_http

from apk_inventory.setup_ca import ensure_authority
from apk_inventory.setup_canary import SetupCanary
from apk_inventory.setup_portal import SetupPortal, public_profile


def payload(kind, **values):
    return {"PayloadType": kind, "PayloadVersion": 1, "PayloadIdentifier": "test.example." + uuid.uuid4().hex,
            "PayloadUUID": str(uuid.uuid4()), "PayloadDisplayName": "Synthetic setup fixture", **values}


def flow(host, path, *, scheme="https", method="GET", origin=None, body=b"", tls=True, established=True, headers=None):
    values = dict(headers or {})
    if origin is not None:
        values["origin"] = origin
    return types.SimpleNamespace(request=types.SimpleNamespace(host=host, path=path, scheme=scheme, method=method,
                                 headers=mitm_http.Headers(**{str(k): str(v) for k, v in values.items()}), raw_content=body),
                                 client_conn=types.SimpleNamespace(tls=tls, tls_established=established), response=None)


class SetupPortalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="setup-portal-tests-")
        cls.root = Path(cls.temp.name)
        cls.authority = ensure_authority(cls.root / "authority")
        cls.der = Path(cls.authority["der_certificate"]).read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.portal = SetupPortal(status={"phase": "preparing", "summary": "synthetic setup"}).start()
        self.addCleanup(self.portal.close)
        self.port = self.portal.server.server_address[1]
        self.origin = f"http://127.0.0.1:{self.port}"
        self.prefix = "/" + self.portal.token + "/"

    def request(self, path, *, method="GET", headers=None, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=4)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            with connection.getresponse() as response:
                return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def profile_path(self, value):
        path = self.root / (uuid.uuid4().hex + ".mobileconfig")
        path.write_bytes(plistlib.dumps(value))
        return path

    def valid_profile(self):
        return payload("Configuration", PayloadContent=[
            payload("com.apple.security.root", PayloadContent=self.der),
            payload("com.apple.wifi.managed", SSID_STR="Synthetic test WiFi", AutoJoin=False,
                    EncryptionType="Any", ProxyType="Auto", ProxyPACURL=self.portal.url + "proxy.pac")])

    def test_project_authority_is_reused_and_only_public_ca_is_downloadable(self):
        reused = ensure_authority(self.authority["directory"])
        self.assertEqual(reused["sha256"], self.authority["sha256"])
        if os.name == "posix":
            self.assertEqual(Path(reused["directory"]).stat().st_mode & 0o777, 0o700)
            self.assertEqual(Path(reused["certificate"]).stat().st_mode & 0o777, 0o600)
        self.portal.certificate(self.authority["certificate"])
        status, headers, public = self.request(self.prefix + "ca.cer")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/x-x509-ca-cert")
        self.assertEqual(public, self.der)
        self.assertTrue(x509.load_der_x509_certificate(public).extensions.get_extension_for_class(x509.BasicConstraints).value.ca)
        self.assertNotIn(b"PRIVATE KEY", public)
        private = Path(reused["directory"]) / "mitmproxy-ca.pem"
        self.assertIn(b"PRIVATE KEY", private.read_bytes())
        with self.assertRaises(ValueError):
            self.portal.certificate(private)
        for name in ("mitmproxy-ca.pem", "authority/mitmproxy-ca.pem", "session.json", "capture.events.jsonl"):
            self.assertEqual(self.request(self.prefix + name)[0], 404)

    def test_capability_host_and_traversal_boundaries(self):
        self.portal.certificate(self.authority["certificate"])
        self.assertEqual(self.request(self.prefix)[0], 200)
        for path in ("/", "/wrong/ca.cer", self.prefix + "../authority/mitmproxy-ca.pem",
                     self.prefix + "%2e%2e/authority/mitmproxy-ca.pem", self.prefix + "ca.cer/../mitmproxy-ca.pem"):
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 404)
        self.assertEqual(self.request(self.prefix + "state", headers={"Host": "attacker.invalid"})[0], 404)
        self.assertEqual(self.request(self.prefix + "state", headers={"Host": f"127.0.0.1:{self.port}.attacker.invalid"})[0], 404)
        code, headers, _ = self.request(self.prefix)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])

    def test_state_actions_require_origin_and_csrf_and_have_body_budget(self):
        for headers in ({}, {"Origin": self.origin}, {"X-Setup-Token": self.portal.token},
                        {"Origin": "http://attacker.invalid", "X-Setup-Token": self.portal.token},
                        {"Origin": self.origin, "X-Setup-Token": "wrong"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request(self.prefix + "stop", method="POST", headers=headers, body=b"{}")[0], 403)
                self.assertFalse(self.portal.stop_requested.is_set())
        valid = {"Origin": self.origin, "X-Setup-Token": self.portal.token}
        self.assertEqual(self.request(self.prefix + "stop", method="POST", headers=valid, body=b"x" * 1025)[0], 413)
        self.assertFalse(self.portal.stop_requested.is_set())
        self.assertEqual(self.request(self.prefix + "continue", method="POST", headers=valid, body=b"{}")[0], 200)
        self.assertTrue(self.portal.continue_requested.is_set())
        self.assertEqual(self.request(self.prefix + "stop", method="POST", headers=valid, body=b"{}")[0], 200)
        self.assertTrue(self.portal.stop_requested.is_set())

    def test_only_credential_free_profiles_can_be_registered(self):
        valid = self.valid_profile()
        self.portal.profile(self.profile_path(valid))
        status, headers, raw = self.request(self.prefix + "setup.mobileconfig")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/x-apple-aspen-config")
        self.assertEqual(plistlib.loads(raw), valid)
        for key in ("Password", "ProxyPassword", "ProxyUsername", "UserPassword", "EAPClientConfiguration"):
            bad = copy.deepcopy(valid)
            bad["PayloadContent"][1][key] = "SYNTHETIC_CREDENTIAL_SHOULD_NOT_LEAVE"
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.portal.profile(self.profile_path(bad))
        bad = copy.deepcopy(valid)
        bad["PayloadContent"][1]["ProxyPACURL"] = "http://user:synthetic-password@127.0.0.1/proxy.pac"
        with self.assertRaises(ValueError):
            public_profile(self.profile_path(bad))
        _, _, still_public = self.request(self.prefix + "setup.mobileconfig")
        self.assertNotIn(b"SYNTHETIC_CREDENTIAL_SHOULD_NOT_LEAVE", still_public)

    def test_profile_opaque_private_bytes_and_malformed_roots_are_rejected(self):
        bad = self.valid_profile()
        bad["PayloadContent"][0]["PayloadContent"] = b"-----BEGIN PRIVATE KEY-----\nsynthetic-only\n"
        encoded = plistlib.dumps(bad)
        self.assertNotIn(b"PRIVATE KEY", encoded)  # plist data encoding must not bypass validation.
        with self.assertRaises(ValueError):
            public_profile(self.profile_path(bad))
        for root in ("synthetic secret", b"synthetic opaque data", [], {"PayloadType": "Configuration", "PayloadContent": "not payloads"},
                     payload("Configuration", PayloadContent=["synthetic plain text"]),
                     payload("Configuration", PayloadContent=[{"Unknown": "synthetic plain text"}])):
            with self.subTest(root=str(root)), self.assertRaises(ValueError):
                public_profile(self.profile_path(root))

    def test_pac_transitions_from_capture_proxy_to_direct(self):
        self.portal.pac_proxy = "127.0.0.1:8080"
        self.portal.pac_active = True
        code, headers, active = self.request(self.prefix + "proxy.pac")
        self.assertEqual(code, 200)
        self.assertIn(b"PROXY 127.0.0.1:8080; DIRECT", active)
        self.assertIn((self.origin + "/").encode(), active)
        self.portal.pac_active = False
        direct = self.request(self.prefix + "proxy.pac")[2]
        self.assertNotIn(b"PROXY ", direct)
        self.assertIn(b"DIRECT", direct)

    def test_qr_encodes_only_the_tokenized_device_frontend_url(self):
        shared = "http://setup-0123456789ab.capture.invalid/" + self.portal.token + "/"
        self.portal.share_url = shared
        captures = []
        qrcode = types.ModuleType("qrcode")
        qrcode.__path__ = []
        image = types.ModuleType("qrcode.image")
        image.__path__ = []
        svg = types.ModuleType("qrcode.image.svg")
        svg.SvgPathImage = object
        class QR:
            def save(self, stream):
                stream.write(b'<svg xmlns="http://www.w3.org/2000/svg"/>')
        def make(value, **_):
            captures.append(value)
            return QR()
        qrcode.make, qrcode.image, image.svg = make, image, svg
        with mock.patch.dict("sys.modules", {"qrcode": qrcode, "qrcode.image": image, "qrcode.image.svg": svg}):
            self.assertEqual(self.request(self.prefix + "qr.svg")[0], 200)
        self.assertEqual(captures, [shared])
        self.assertNotIn("PRIVATE KEY", captures[0])


class SetupCanaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="setup-canary-tests-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.portal = SetupPortal(status={"phase": "synthetic"}).start()
        self.addCleanup(self.portal.close)
        self.origin = "http://127.0.0.1:" + str(self.portal.server.server_address[1])
        self.front = "setup-0123456789ab.capture.invalid"
        self.front_origin = "http://" + self.front
        self.portal.origins.add(self.front_origin)
        self.config = {"host": "check-0123456789ab.capture.invalid", "token": "synthetic-canary-token",
                       "portal_token": self.portal.token, "portal_origins": [self.front_origin],
                       "front_host": self.front, "portal_local_origin": self.origin,
                       "result": str(self.root / "canary.json"), "session_id": "synthetic-session"}
        self.canary = self.load(self.config)

    def load(self, config):
        path = self.root / (uuid.uuid4().hex + ".json")
        path.write_text(json.dumps(config))
        instance = SetupCanary()
        with mock.patch("mitmproxy.ctx.options", types.SimpleNamespace(setup_config=str(path)), create=True):
            instance.running()
        return instance

    def test_only_established_browser_tls_with_origin_and_token_produces_proof(self):
        path = "/check/" + self.config["token"]
        for changes in ({"scheme": "http"}, {"origin": "http://attacker.invalid"}, {"path": "/check/wrong"},
                        {"tls": False}, {"established": False}, {"method": "POST"}):
            args = {"host": self.config["host"], "path": path, "origin": self.front_origin, **changes}
            request = flow(**args)
            self.canary.request(request)
            self.assertEqual(request.response.status_code, 404)
            self.assertFalse(Path(self.config["result"]).exists())
        valid = flow(self.config["host"], path, origin=self.front_origin)
        self.canary.request(valid)
        self.assertEqual(valid.response.status_code, 200)
        proof = json.loads(Path(self.config["result"]).read_text())
        self.assertEqual(proof["evidence_scope"], "selected_browser_proxy_and_tls_path")
        self.assertTrue(proof["ok"])
        self.assertEqual(valid.response.headers["access-control-allow-origin"], self.front_origin)

    def test_cors_preflight_and_unrelated_hosts_never_assert_trust(self):
        preflight = flow(self.config["host"], "/check/" + self.config["token"], origin=self.front_origin, method="OPTIONS", tls=False)
        self.canary.request(preflight)
        self.assertEqual(preflight.response.status_code, 204)
        self.assertFalse(Path(self.config["result"]).exists())
        unrelated = flow("api.example.test", "/items", origin=self.front_origin)
        self.canary.request(unrelated)
        self.assertIsNone(unrelated.response)
        self.assertFalse(Path(self.config["result"]).exists())

    def test_frontend_relay_reaches_only_fixed_loopback_portal_and_preserves_csrf(self):
        request = flow(self.front, "/" + self.portal.token + "/state", scheme="http", tls=False,
                       headers={"Host": "external.example.test"})
        self.canary.request(request)
        self.assertEqual(request.response.status_code, 200)
        self.assertEqual(json.loads(request.response.content)["phase"], "synthetic")
        stopped = flow(self.front, "/" + self.portal.token + "/stop", scheme="http", method="POST",
                       origin=self.front_origin, headers={"X-Setup-Token": self.portal.token}, body=b"{}", tls=False)
        self.canary.request(stopped)
        self.assertEqual(stopped.response.status_code, 200)
        self.assertTrue(self.portal.stop_requested.is_set())
        for path in ("http://attacker.invalid/", "//attacker.invalid/", "/wrong/state"):
            rejected = flow(self.front, path, scheme="http", tls=False)
            self.canary.request(rejected)
            self.assertEqual(rejected.response.status_code, 404)

    def test_non_loopback_forward_origins_are_rejected_before_network(self):
        for origin in ("http://192.0.2.10:8080", "http://example.test", "https://127.0.0.1:8080",
                       "http://name:password@127.0.0.1:8080", "http://127.0.0.1:8080/path", "http://127.0.0.1:8080?query"):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                self.load({**self.config, "portal_local_origin": origin})

    def test_failed_config_cannot_leave_an_external_forwarder_active(self):
        bad = {**self.config, "portal_local_origin": "http://192.0.2.10:8080"}
        path = self.root / "invalid-config.json"
        path.write_text(json.dumps(bad))
        addon = SetupCanary()
        with mock.patch("mitmproxy.ctx.options", types.SimpleNamespace(setup_config=str(path)), create=True):
            with self.assertRaises(ValueError):
                addon.running()
        request = flow(self.front, "/" + self.portal.token + "/state", scheme="http", tls=False)
        with mock.patch("urllib.request.build_opener") as opener:
            addon.request(request)
            opener.assert_not_called()
        self.assertIsNotNone(request.response)
        self.assertNotEqual(request.response.status_code, 200)

    def test_frontend_redirect_is_not_followed_to_another_origin(self):
        seen = []
        class Trap(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.path)
                self.send_response(200);self.end_headers();self.wfile.write(b"must not fetch")
            def log_message(self, *_):
                pass
        trap = ThreadingHTTPServer(("127.0.0.1", 0), Trap)
        thread = threading.Thread(target=trap.serve_forever, daemon=True);thread.start()
        self.addCleanup(trap.server_close);self.addCleanup(thread.join, 2);self.addCleanup(trap.shutdown)
        destination = "http://127.0.0.1:" + str(trap.server_address[1]) + "/private"
        class Redirect(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302);self.send_header("Location", destination);self.end_headers()
            def log_message(self, *_):
                pass
        redirect = ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
        running = threading.Thread(target=redirect.serve_forever, daemon=True);running.start()
        self.addCleanup(redirect.server_close);self.addCleanup(running.join, 2);self.addCleanup(redirect.shutdown)
        addon = self.load({**self.config, "portal_local_origin": "http://127.0.0.1:" + str(redirect.server_address[1])})
        request = flow(self.front, "/" + self.portal.token + "/state", scheme="http", tls=False)
        addon.request(request)
        self.assertEqual(request.response.status_code, 502)
        self.assertEqual(seen, [])


if __name__ == "__main__":
    unittest.main()
