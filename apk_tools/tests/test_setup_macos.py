from __future__ import annotations

import copy
import datetime
import hashlib
import json
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from apk_inventory.setup_macos import MacOSSetup, MacOSSetupError, NETWORKSETUP, SECURITY


def proxy(server="", port=0, enabled=False, authenticated=False):
    return dict(server=server, port=port, enabled=enabled, authenticated=authenticated)


def public_ca(path):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Synthetic setup test CA")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(minutes=1))
            .not_valid_after(now+datetime.timedelta(days=1)).add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .sign(key, hashes.SHA256()))
    path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest().upper()


class Host:
    """A stateful command fake: no host proxy or keychain command is executed."""
    def __init__(self, fingerprint):
        self.fingerprint = fingerprint
        self.proxies = {"http": proxy(), "https": proxy("old-proxy.example.test", 3128, True)}
        self.pac = self.discovery = self.socks = False
        self.cert_present = self.cert_trusted = False
        self.calls, self.writes = [], []
        self.fail_https_once = self.fail_ca_once = self.reject_clear = False
        self.service = "Lab Wi-Fi"

    def __call__(self, argv, timeout=30):
        self.calls.append(list(argv))
        code, text = 0, ""
        if argv[0] == "/usr/bin/osascript":
            # shlex recovers exactly one argv vector; shell metacharacters remain
            # literal service values instead of becoming a second command.
            self.assert_admin_script(argv[2])
            argv = shlex.split(argv[3])
        binary, args = argv[0], argv[1:]
        if binary == "/sbin/route":
            text = "route to: default\n interface: en0\n"
        elif binary == NETWORKSETUP:
            action = args[0]
            if action == "-listnetworkserviceorder":
                text = f"(1) {self.service}\n(Hardware Port: Wi-Fi, Device: en0)\n"
            elif action in {"-getwebproxy", "-getsecurewebproxy", "-getsocksfirewallproxy"}:
                p = proxy(enabled=self.socks) if action == "-getsocksfirewallproxy" else self.proxies["http" if action == "-getwebproxy" else "https"]
                text = f'Enabled: {"Yes" if p["enabled"] else "No"}\nServer: {p["server"]}\nPort: {p["port"]}\nAuthenticated Proxy Enabled: {int(p["authenticated"])}\n'
            elif action == "-getautoproxyurl":
                text = f'URL: https://pac.example.test/proxy.pac\nEnabled: {"Yes" if self.pac else "No"}\n'
            elif action == "-getproxyautodiscovery":
                text = "Auto Proxy Discovery: " + ("On" if self.discovery else "Off") + "\n"
            elif action in {"-setwebproxy", "-setsecurewebproxy"}:
                self.writes.append(list(argv))
                assert args[1] == self.service
                if self.reject_clear and args[2] == "" and args[3] == "0":
                    return subprocess.CompletedProcess(argv, 4, "", "fixture refuses empty endpoint")
                p = "http" if action == "-setwebproxy" else "https"
                self.proxies[p] = proxy(args[2], int(args[3]), True)
                if p == "https" and self.fail_https_once:
                    self.fail_https_once = False
                    code = 1  # simulate lost acknowledgement after the OS changed it
            elif action in {"-setwebproxystate", "-setsecurewebproxystate"}:
                self.writes.append(list(argv))
                self.proxies["http" if action == "-setwebproxystate" else "https"]["enabled"] = args[2] == "on"
            else:
                raise AssertionError(argv)
        elif binary == SECURITY:
            if args[0] == "find-certificate":
                text = "SHA-256 hash: " + self.fingerprint + "\n" if self.cert_present else ""
            elif args[0] == "verify-cert":
                code = 0 if self.cert_trusted else 1
            elif args[0] == "add-trusted-cert":
                self.writes.append(list(argv)); self.cert_present = True
                if self.fail_ca_once:
                    self.fail_ca_once = False; code = 1
                else:
                    self.cert_trusted = True
            elif args[0] == "delete-certificate":
                self.writes.append(list(argv)); assert args[1:4] == ["-t", "-Z", self.fingerprint]
                self.cert_present = self.cert_trusted = False
            else:
                raise AssertionError(argv)
        elif binary == "/usr/bin/open":
            self.writes.append(list(argv))
        else:
            raise AssertionError(argv)
        return subprocess.CompletedProcess(argv, code, text, "")

    @staticmethod
    def assert_admin_script(script):
        assert "with administrator privileges" in script
        assert "item 1 of argv" in script
        assert "password" not in script


class MacOSSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cert = self.root / "ca.pem"
        fingerprint = public_ca(self.cert)
        self.host = Host(fingerprint)
        self.options = {"proxy_host": "127.0.0.1", "proxy_port": 8080,
                        "ca_cert": str(self.cert), "state_dir": str(self.root / "state"), "keep_ca": True}
        self.setup = MacOSSetup(self.options, runner=self.host)

    def test_plan_is_read_only_and_discovers_active_service(self):
        plan = self.setup.plan()
        self.assertTrue(plan["ready"])
        self.assertEqual(plan["service"], self.host.service)
        self.assertEqual([], self.host.writes)
        self.assertFalse((self.root / "state").exists())
        self.assertIn("install_user_ssl_ca", plan["actions"])

    def test_apply_restore_and_reuse_owned_ca_without_reauthorization(self):
        before = copy.deepcopy(self.host.proxies)
        state = self.setup.apply()
        self.assertTrue(state["ca"]["owned"])
        self.assertTrue(all(p["enabled"] and p["port"] == 8080 for p in self.host.proxies.values()))
        self.assertEqual("restored", self.setup.restore(state)["status"])
        self.assertEqual(before, self.host.proxies)
        self.assertTrue(self.host.cert_trusted)
        count = sum(x[:2] == [SECURITY, "add-trusted-cert"] for x in self.host.writes)
        reused = MacOSSetup(self.options, runner=self.host)
        state2 = reused.apply()
        self.assertEqual(count, sum(x[:2] == [SECURITY, "add-trusted-cert"] for x in self.host.writes))
        self.assertTrue(state2["ca"]["owned"])
        result = reused.restore(state2, remove_ca=True)
        self.assertEqual("removed_owned_ca", result["ca"])
        self.assertFalse(self.host.cert_present)
        saved = json.loads((self.root / "state/macos-state.json").read_text())
        self.assertFalse(saved["ca"]["owned"])
        self.assertEqual(0o600, (self.root / "state/macos-state.json").stat().st_mode & 0o777)

    def test_partial_proxy_failure_rolls_back_owned_values_and_exposes_state(self):
        before = copy.deepcopy(self.host.proxies)
        self.host.fail_https_once = True
        with self.assertRaises(MacOSSetupError) as error:
            self.setup.apply()
        self.assertEqual(before, self.host.proxies)
        self.assertEqual("restored", error.exception.cleanup["status"])
        self.assertTrue(error.exception.state["ca"]["owned"])
        json.dumps(error.exception.state)

    def test_certificate_authorization_failure_only_removes_new_owned_certificate(self):
        self.host.fail_ca_once = True
        self.options["keep_ca"] = False
        with self.assertRaises(MacOSSetupError) as error:
            MacOSSetup(self.options, runner=self.host).apply()
        self.assertFalse(self.host.cert_present)
        self.assertEqual("removed_owned_ca", error.exception.cleanup["ca"])
        self.assertFalse(any(x[0] == NETWORKSETUP for x in self.host.writes))

    def test_preexisting_external_certificate_is_never_deleted(self):
        self.host.cert_present = self.host.cert_trusted = True
        state = self.setup.apply()
        self.assertFalse(state["ca"]["owned"])
        self.assertEqual("preexisting_not_removed", self.setup.restore(state, remove_ca=True)["ca"])
        self.assertTrue(self.host.cert_present)
        self.assertFalse(any(x[:2] == [SECURITY, "delete-certificate"] for x in self.host.writes))

    def test_concurrent_proxy_change_is_not_overwritten(self):
        state = self.setup.apply()
        self.host.proxies["http"] = proxy("manual.example.test", 9090, True)
        result = self.setup.restore(state)
        self.assertEqual("changed_externally_not_overwritten", result["proxy"]["http"])
        self.assertEqual("manual.example.test", self.host.proxies["http"]["server"])
        self.assertEqual(state["before"]["https"], self.host.proxies["https"])

    def test_unsafe_prior_proxy_modes_fail_before_mutation(self):
        for flag in ("pac", "discovery", "socks", "authenticated", "existing_untrusted"):
            with self.subTest(flag=flag):
                self.host.pac = flag == "pac"; self.host.discovery = flag == "discovery"; self.host.socks = flag == "socks"
                self.host.proxies["http"]["authenticated"] = flag == "authenticated"
                self.host.cert_present = flag == "existing_untrusted"; self.host.cert_trusted = False
                self.assertFalse(self.setup.plan()["ready"])
                with self.assertRaises(MacOSSetupError):self.setup.apply()
                self.assertEqual([], self.host.writes)

    def test_shell_metacharacters_stay_inside_single_service_argument(self):
        self.host.service = "Lab's Wi-Fi $(not-a-command)"
        state = self.setup.apply()
        writes = [x for x in self.host.writes if x[0] == NETWORKSETUP]
        self.assertTrue(writes)
        self.assertTrue(all(x[2] == self.host.service for x in writes))
        self.setup.restore(state)

    def test_empty_endpoint_refusal_still_disables_owned_proxy_and_reports_partial(self):
        state = self.setup.apply(); self.host.reject_clear = True
        result = self.setup.restore(state)
        self.assertEqual("partial", result["status"])
        self.assertEqual("disabled_endpoint_not_cleared", result["proxy"]["http"])
        self.assertFalse(self.host.proxies["http"]["enabled"])

    def test_private_key_or_invalid_ca_cannot_be_imported(self):
        self.cert.write_text("-----BEGIN PRIVATE KEY-----\nSYNTHETIC_ONLY\n-----END PRIVATE KEY-----\n")
        with self.assertRaises(MacOSSetupError) as error:self.setup.plan()
        self.assertEqual("MACOS_CA_INVALID", error.exception.code)
        self.assertEqual([], self.host.writes)

    def test_optional_app_launch_is_only_requested_after_proxy_is_applied(self):
        app = self.root / "Fixture.app"; app.mkdir()
        self.options["artifact"] = str(app)
        state = MacOSSetup(self.options, runner=self.host).apply()
        self.assertEqual("launch_requested", state["app"]["status"])
        self.assertEqual(["/usr/bin/open", "-a", str(app.resolve())], self.host.writes[-1])

    def test_launch_can_be_deferred_until_after_coordinator_canary(self):
        app = self.root / "Fixture.app"; app.mkdir()
        self.options.update(artifact=str(app), launch=False)
        setup = MacOSSetup(self.options, runner=self.host)
        state = setup.apply()
        self.assertEqual("deferred", state["app"]["status"])
        self.assertFalse(any(x[0] == "/usr/bin/open" for x in self.host.writes))
        self.assertEqual("launch_requested", setup.launch(state)["status"])
        setup.launch(state)
        self.assertEqual(1, sum(x[0] == "/usr/bin/open" for x in self.host.writes))

    def test_malformed_recovery_state_is_rejected_before_system_commands(self):
        state = self.setup.apply()
        self.setup.restore(state)
        self.host.writes.clear()
        malformed = copy.deepcopy(state); malformed["expected"]["port"] = 0
        with self.assertRaises(MacOSSetupError):self.setup.restore(malformed)
        self.assertEqual([], self.host.writes)


if __name__ == "__main__":
    unittest.main()
