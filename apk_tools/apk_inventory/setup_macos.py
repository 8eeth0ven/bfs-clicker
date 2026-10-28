"""Reversible macOS HTTP(S) proxy and per-user test-CA preparation.

Only apply/restore mutate the host. plan performs read-only command checks.
The injected runner accepts (argv, timeout=seconds), returning text or a
subprocess.CompletedProcess; it must never use shell=True.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import re
import shlex
import subprocess
import sys
from pathlib import Path

from .common import InventoryError, atomic_json

NETWORKSETUP = "/usr/sbin/networksetup"
SECURITY = "/usr/bin/security"
ADMIN_SCRIPT = "on run argv\n do shell script (item 1 of argv) with administrator privileges\nend run"
_PROTOCOLS = {"http": ("webproxy", "webproxystate"), "https": ("securewebproxy", "securewebproxystate")}
_HASH = re.compile(r"^[A-F0-9]{64}$")


class MacOSSetupError(InventoryError):
    """Failure carrying the durable recovery state, if mutation began."""
    state = None
    cleanup = None


def _default_runner(argv, timeout=30):
    return subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True,
                          text=True, timeout=timeout, check=False)


def _text(value, label, maximum=255):
    if not isinstance(value, str) or not value or len(value) > maximum or any(ord(c) < 32 for c in value):
        raise MacOSSetupError("MACOS_ARGUMENT_INVALID", label + " is invalid")
    return value


def _proxy(value):
    fields = {}
    for line in value.splitlines():
        if ":" in line:
            key, val = line.split(":", 1)
            fields[key.strip().lower()] = val.strip()
    enabled = fields.get("enabled", "").lower()
    auth = fields.get("authenticated proxy enabled", "").lower()
    if enabled not in {"yes", "no", "1", "0"} or auth not in {"yes", "no", "1", "0"}:
        raise MacOSSetupError("MACOS_PROXY_STATE_INVALID", "Could not parse network service proxy state")
    try:
        port = int(fields["port"])
    except (ValueError, KeyError):
        raise MacOSSetupError("MACOS_PROXY_STATE_INVALID", "Proxy port is unavailable") from None
    server = fields.get("server", "")
    if not 0 <= port <= 65535 or len(server) > 255 or any(ord(c) < 32 for c in server):
        raise MacOSSetupError("MACOS_PROXY_STATE_INVALID", "Proxy endpoint is not reversible")
    return {"enabled": enabled in {"yes", "1"}, "server": server, "port": port,
            "authenticated": auth in {"yes", "1"}}


def _enabled(value):
    match = re.search(r"(?im)^(?:Enabled|Auto Proxy Discovery):\s*(Yes|No|1|0|On|Off)\s*$", value)
    if not match:
        raise MacOSSetupError("MACOS_PROXY_STATE_INVALID", "Could not read automatic proxy state")
    return match[1].lower() in {"yes", "1", "on"}


class MacOSSetup:
    def __init__(self, options, runner=None):
        self.options = dict(options)
        self.runner = runner or _default_runner
        self.injected = runner is not None
        self.host = _text(self.options.get("proxy_host", "127.0.0.1"), "Proxy host")
        try:
            ipaddress.ip_address(self.host)
        except ValueError:
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,252}", self.host):
                raise MacOSSetupError("MACOS_ARGUMENT_INVALID", "Proxy host must be an IP or DNS name") from None
        self.port = self.options.get("proxy_port", 8080)
        if isinstance(self.port, bool) or not isinstance(self.port, int) or not 1 <= self.port <= 65535:
            raise MacOSSetupError("MACOS_ARGUMENT_INVALID", "Proxy port must be in 1..65535")
        self.ca = Path(self.options.get("ca_cert", "")).expanduser()
        self.state_dir = Path(self.options.get("state_dir", ".capture-setup")).expanduser()
        if self.ca.is_symlink() or self.state_dir.is_symlink():
            raise MacOSSetupError("MACOS_PATH_INVALID", "CA and state roots must not be symlinks")
        self.ca, self.state_dir = self.ca.resolve(), self.state_dir.resolve()
        self.keychain = str(Path.home() / "Library/Keychains/login.keychain-db")
        ledger = Path(self.options.get("ca_ownership_path", self.ca.parent / "macos-ca-ownership.json")).expanduser()
        if ledger.is_symlink():
            raise MacOSSetupError("MACOS_PATH_INVALID", "CA ownership ledger must not be a symlink")
        self.ledger = ledger.resolve()
        self.state = None

    def _call(self, argv, *, allow_failure=False, timeout=30):
        try:
            result = self.runner(list(argv), timeout=timeout)
        except (OSError, subprocess.TimeoutExpired, subprocess.CalledProcessError):
            if allow_failure:
                return False, ""
            raise MacOSSetupError("MACOS_COMMAND_FAILED", "A required macOS command failed or timed out") from None
        code = getattr(result, "returncode", 0)
        value = result if isinstance(result, str) else getattr(result, "stdout", "")
        if isinstance(value, bytes):
            value = value.decode("utf-8", "replace")
        if not isinstance(value, str) or len(value.encode()) > 2 * 1024 * 1024:
            raise MacOSSetupError("MACOS_COMMAND_OUTPUT_LIMIT", "macOS command output exceeds its budget")
        if code and not allow_failure:
            raise MacOSSetupError("MACOS_COMMAND_REJECTED", "macOS rejected a required command or authorization")
        return code == 0, value

    def _admin(self, argv):
        # Only these fixed networksetup actions can reach the administrator shell.
        if len(argv) < 4 or argv[0] != NETWORKSETUP or argv[1] not in {
            "-setwebproxy", "-setsecurewebproxy", "-setwebproxystate", "-setsecurewebproxystate"
        }:
            raise MacOSSetupError("MACOS_COMMAND_INVALID", "Unsupported privileged action")
        return self._call(["/usr/bin/osascript", "-e", ADMIN_SCRIPT, shlex.join(argv)], timeout=180)[1]

    def _certificate(self):
        if not self.ca.is_file() or self.ca.stat().st_size > 128 * 1024:
            raise MacOSSetupError("MACOS_CA_INVALID", "CA must be a bounded public certificate file")
        raw = self.ca.read_bytes()
        if b"PRIVATE KEY" in raw or raw.count(b"-----BEGIN CERTIFICATE-----") > 1:
            raise MacOSSetupError("MACOS_CA_INVALID", "Only one public CA certificate may be installed")
        try:
            from cryptography import x509
            cert = x509.load_pem_x509_certificate(raw) if b"-----BEGIN CERTIFICATE-----" in raw else x509.load_der_x509_certificate(raw)
            if not cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca or cert.issuer != cert.subject:
                raise ValueError()
            from cryptography.hazmat.primitives import serialization
            return hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest().upper()
        except Exception:
            raise MacOSSetupError("MACOS_CA_INVALID", "Certificate must be a self-issued CA with CA basic constraints") from None

    def _cert_status(self, fingerprint):
        ok, output = self._call([SECURITY, "find-certificate", "-a", "-Z", self.keychain], allow_failure=True)
        present = ok and fingerprint in {m.upper() for m in re.findall(r"(?im)^SHA-256 hash:\s*([a-f0-9]{64})\s*$", output)}
        trusted, _ = self._call([SECURITY, "verify-cert", "-c", str(self.ca), "-p", "ssl", "-l", "-L", "-q"], allow_failure=True)
        return present, trusted

    def _ownership(self):
        if self.ledger.is_symlink():
            raise MacOSSetupError("MACOS_STATE_INVALID", "CA ownership ledger must not be a symlink")
        if not self.ledger.exists():
            return {"version": 1, "certificates": {}}
        if self.ledger.stat().st_size > 1024 * 1024:
            raise MacOSSetupError("MACOS_STATE_INVALID", "CA ownership ledger exceeds budget")
        try:
            value = json.loads(self.ledger.read_text())
            if value.get("version") != 1 or not isinstance(value.get("certificates"), dict):
                raise ValueError()
            if not all(isinstance(k, str) and _HASH.fullmatch(k) and isinstance(v, dict) and isinstance(v.get("keychain"), str) for k, v in value["certificates"].items()):
                raise ValueError()
            return value
        except (ValueError, AttributeError, TypeError):
            raise MacOSSetupError("MACOS_STATE_INVALID", "CA ownership ledger is invalid") from None

    def _write(self):
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        target = self.state_dir / "macos-state.json"
        atomic_json(target, self.state)
        target.chmod(0o600)

    def _write_ownership(self, value):
        self.ledger.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        atomic_json(self.ledger, value)
        self.ledger.chmod(0o600)

    def _service(self):
        chosen = self.options.get("service")
        if chosen:
            return _text(chosen, "Network service")
        _, route = self._call(["/sbin/route", "-n", "get", "default"])
        match = re.search(r"(?m)^\s*interface:\s*(\S+)\s*$", route)
        if not match:
            raise MacOSSetupError("MACOS_SERVICE_SELECTION", "Specify --service when no default network interface is available")
        _, order = self._call([NETWORKSETUP, "-listnetworkserviceorder"])
        current, candidates = None, []
        for line in order.splitlines():
            header = re.match(r"^\((\*?\d+)\) (.+)$", line)
            if header:
                current = None if header[1].startswith("*") else header[2]
            elif current and re.search(r"\bDevice:\s*" + re.escape(match[1]) + r"\)", line):
                candidates.append(current)
        if len(candidates) != 1:
            raise MacOSSetupError("MACOS_SERVICE_SELECTION", "Specify --service when the active service is ambiguous (for example a VPN)")
        return _text(candidates[0], "Network service")

    def _read_proxy(self, service, protocol):
        return _proxy(self._call([NETWORKSETUP, "-get" + _PROTOCOLS[protocol][0], service])[1])

    def plan(self):
        if not self.injected and sys.platform != "darwin":
            raise MacOSSetupError("MACOS_UNSUPPORTED", "macOS target requires a macOS host")
        fingerprint = self._certificate()
        service = self._service()
        before = {p: self._read_proxy(service, p) for p in _PROTOCOLS}
        pac = _enabled(self._call([NETWORKSETUP, "-getautoproxyurl", service])[1])
        discovery = _enabled(self._call([NETWORKSETUP, "-getproxyautodiscovery", service])[1])
        socks = _proxy(self._call([NETWORKSETUP, "-getsocksfirewallproxy", service])[1])
        present, trusted = self._cert_status(fingerprint)
        reasons = []
        if pac or discovery or socks["enabled"]:
            reasons.append("MACOS_PROXY_CONFLICT")
        if any(p["authenticated"] for p in before.values()):
            reasons.append("MACOS_AUTHENTICATED_PROXY")
        if present and not trusted:
            reasons.append("MACOS_EXISTING_CA_UNTRUSTED")
        artifact = self.options.get("artifact")
        if artifact:
            app = Path(artifact).expanduser()
            if app.is_symlink() or not app.is_dir() or app.suffix.lower() != ".app":
                raise MacOSSetupError("MACOS_APP_INVALID", "Optional artifact must be a local .app directory")
            artifact = str(app.resolve())
        bundle = self.options.get("bundle_id")
        if bundle and not re.fullmatch(r"[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+", bundle):
            raise MacOSSetupError("MACOS_APP_INVALID", "Bundle identifier is invalid")
        owner = self._ownership()["certificates"].get(fingerprint, {})
        owned = present and owner.get("keychain") == self.keychain
        return {"target": "macos", "description": "Prepare the active macOS service HTTP/HTTPS proxy and per-user TLS test CA",
                "ready": not reasons, "blocking_reasons": reasons, "service": service, "before": before,
                "proxy": {"host": self.host, "port": self.port}, "ca_sha256": fingerprint,
                "ca": {"present": present, "trusted": trusted, "owned": owned},
                "artifact": artifact, "bundle_id": bundle,
                "actions": ["reuse_trusted_ca" if trusted else "install_user_ssl_ca", "set_http_https_proxy"] + (["request_app_launch"] if artifact or bundle else []),
                "manual_steps": ["Approve macOS certificate trust and administrator authorization dialogs when shown"],
                "limitations": ["Only applications using macOS system proxy and trust settings are covered", "Initial empty proxy endpoints are cleared where supported; otherwise their disabled state is restored and a partial endpoint result is reported"]}

    def apply(self):
        plan = self.plan()
        if not plan["ready"]:
            raise MacOSSetupError(plan["blocking_reasons"][0], "Existing macOS proxy/trust settings require explicit manual adjustment")
        expected = {"enabled": True, "server": self.host, "port": self.port, "authenticated": False}
        self.state = {"version": 1, "target": "macos", "service": plan["service"], "before": plan["before"],
                      "expected": expected, "changed": [], "keep_ca": bool(self.options.get("keep_ca", True)),
                      "ca": {"sha256": plan["ca_sha256"], "cert": str(self.ca), "keychain": self.keychain,
                             "owned": bool(plan["ca"]["owned"]), "initially_present": plan["ca"]["present"],
                             "new_in_this_apply": False, "status": "reused" if plan["ca"]["trusted"] else "pending"},
                      "app": {"status": "deferred" if plan["artifact"] or plan["bundle_id"] else "not_requested",
                              "artifact": plan["artifact"], "bundle_id": plan["bundle_id"]}, "status": "applying"}
        self._write()
        try:
            if not plan["ca"]["trusted"]:
                self.state["ca"].update(owned=True, new_in_this_apply=True, status="install_intent")
                self._write()
                # User domain only: no -d and no root process that would change another user's trust.
                self._call([SECURITY, "add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-k", self.keychain, str(self.ca)], timeout=180)
                present, trusted = self._cert_status(plan["ca_sha256"])
                if not present or not trusted:
                    raise MacOSSetupError("MACOS_CA_NOT_TRUSTED", "macOS did not confirm the requested user CA trust")
                self.state["ca"]["status"] = "installed_trusted"
                ledger = self._ownership()
                ledger["certificates"][plan["ca_sha256"]] = {"keychain": self.keychain}
                self._write_ownership(ledger)
                self._write()
            for protocol, (setting, _) in _PROTOCOLS.items():
                # Mark intent before the command: a lost ACK must still be recoverable.
                self.state["changed"].append(protocol)
                self._write()
                self._admin([NETWORKSETUP, "-set" + setting, plan["service"], self.host, str(self.port), "off"])
                if self._read_proxy(plan["service"], protocol) != expected:
                    raise MacOSSetupError("MACOS_PROXY_NOT_APPLIED", "macOS did not retain the requested proxy state")
            if self.options.get("launch", True):
                self.launch(self.state)
            self.state["status"] = "applied"
            self._write()
            return self.state
        except Exception as exc:
            try:
                cleanup = self.restore(self.state, remove_ca=not self.state["keep_ca"])
            except Exception:
                cleanup = {"status": "partial", "error": "MACOS_ROLLBACK_FAILED"}
            error = exc if isinstance(exc, MacOSSetupError) else MacOSSetupError("MACOS_SETUP_FAILED", "macOS setup failed")
            error.state, error.cleanup = self.state, cleanup
            raise error from None

    def launch(self, state):
        """Request app launch only after the coordinator's readiness canary."""
        if not isinstance(state, dict) or state.get("target") != "macos" or not isinstance(state.get("app"), dict):
            raise MacOSSetupError("MACOS_STATE_INVALID", "App launch state is invalid")
        self.state = state
        app = state["app"]
        if app.get("status") == "launch_requested":
            return app
        artifact, bundle = app.get("artifact"), app.get("bundle_id")
        if not artifact and not bundle:
            return app
        if any(self._read_proxy(state["service"], protocol) != state["expected"] for protocol in _PROTOCOLS):
            raise MacOSSetupError("MACOS_PROXY_CHANGED", "Proxy changed before app launch")
        if artifact:
            local = Path(artifact)
            if local.is_symlink() or not local.is_dir() or local.suffix.lower() != ".app":
                raise MacOSSetupError("MACOS_APP_INVALID", "App launch artifact changed or is invalid")
            self._call(["/usr/bin/open", "-a", str(local.resolve())])
        else:
            if not isinstance(bundle, str) or not re.fullmatch(r"[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+", bundle):
                raise MacOSSetupError("MACOS_APP_INVALID", "App launch identifier is invalid")
            self._call(["/usr/bin/open", "-b", bundle])
        app["status"] = "launch_requested"
        self._write()
        return app

    def restore(self, state, remove_ca=False):
        if not isinstance(state, dict) or state.get("version") != 1 or state.get("target") != "macos":
            raise MacOSSetupError("MACOS_STATE_INVALID", "Recovery state is not a macOS setup record")
        service = _text(state.get("service"), "Recovery network service")
        if not isinstance(state.get("before"), dict) or not isinstance(state.get("expected"), dict) or not isinstance(state.get("ca"), dict):
            raise MacOSSetupError("MACOS_STATE_INVALID", "Recovery proxy/CA snapshots are missing")
        changed = state.get("changed", [])
        if not isinstance(changed, list) or len(changed) > 2 or any(p not in _PROTOCOLS for p in changed) or len(set(changed)) != len(changed):
            raise MacOSSetupError("MACOS_STATE_INVALID", "Recovery protocol list is invalid")
        expected = state["expected"]
        if not isinstance(expected.get("enabled"), bool) or not isinstance(expected.get("server"), str) or not isinstance(expected.get("port"), int) or isinstance(expected.get("port"), bool) or not 1 <= expected["port"] <= 65535 or len(expected["server"]) > 255 or any(ord(c) < 32 for c in expected["server"]):
            raise MacOSSetupError("MACOS_STATE_INVALID", "Expected owned proxy state is invalid")
        self.state = state
        results = {"proxy": {}, "ca": "retained" if state.get("ca", {}).get("owned") else "preexisting_not_removed"}
        for protocol in reversed(state.get("changed", [])):
            if protocol not in _PROTOCOLS:
                raise MacOSSetupError("MACOS_STATE_INVALID", "Recovery protocol is invalid")
            before = state["before"].get(protocol)
            if not isinstance(before, dict) or not isinstance(before.get("enabled"), bool) or before.get("authenticated") or not isinstance(before.get("server"), str) or len(before["server"]) > 255 or any(ord(c) < 32 for c in before["server"]) or not isinstance(before.get("port"), int) or isinstance(before.get("port"), bool) or not 0 <= before["port"] <= 65535:
                raise MacOSSetupError("MACOS_STATE_INVALID", "Recovery endpoint is invalid or authenticated")
            try:
                current = self._read_proxy(service, protocol)
                if current == before:
                    results["proxy"][protocol] = "already_restored"
                    continue
                if current != state["expected"]:
                    results["proxy"][protocol] = "changed_externally_not_overwritten"
                    continue
                setting, toggle = _PROTOCOLS[protocol]
                endpoint_failed = False
                try:
                    self._admin([NETWORKSETUP, "-set" + setting, service, before["server"], str(before["port"]), "off"])
                except MacOSSetupError:
                    endpoint_failed = True
                # Even when an old endpoint cannot be restored, stop routing to
                # the owned capture proxy and retain a retryable failure record.
                self._admin([NETWORKSETUP, "-set" + toggle, service, "on" if before["enabled"] and not endpoint_failed else "off"])
                actual = self._read_proxy(service, protocol)
                if actual == before:
                    results["proxy"][protocol] = "restored"
                elif endpoint_failed and not before["enabled"] and not actual["enabled"]:
                    results["proxy"][protocol] = "disabled_endpoint_not_cleared"
                else:
                    results["proxy"][protocol] = "restore_failed"
            except MacOSSetupError:
                results["proxy"][protocol] = "restore_failed"
        ca = state.get("ca", {})
        if remove_ca and ca.get("owned"):
            fingerprint = ca.get("sha256", "")
            ledger = self._ownership()
            owner = ledger["certificates"].get(fingerprint, {})
            owns_intent = ca.get("new_in_this_apply") and not ca.get("initially_present")
            if not _HASH.fullmatch(fingerprint) or ca.get("keychain") != self.keychain or not (owner.get("keychain") == self.keychain or owns_intent):
                results["ca"] = "ownership_not_verified"
            else:
                try:
                    _, output = self._call([SECURITY, "find-certificate", "-a", "-Z", self.keychain], allow_failure=True)
                    if fingerprint not in {x.upper() for x in re.findall(r"(?im)^SHA-256 hash:\s*([A-F0-9]{64})\s*$", output)}:
                        results["ca"] = "already_absent"
                    else:
                        # Exact SHA and user keychain, never name-based or System.keychain deletion.
                        self._call([SECURITY, "delete-certificate", "-t", "-Z", fingerprint, self.keychain], timeout=180)
                        results["ca"] = "removed_owned_ca"
                    ledger["certificates"].pop(fingerprint, None)
                    self._write_ownership(ledger)
                    state["ca"]["owned"] = False
                except MacOSSetupError:
                    results["ca"] = "remove_failed"
        incomplete = {"restore_failed", "disabled_endpoint_not_cleared", "remove_failed", "ownership_not_verified"}
        results["status"] = "partial" if any(v in incomplete for v in results["proxy"].values()) or results["ca"] in incomplete else "restored"
        state["status"], state["cleanup"] = results["status"], results
        self._write()
        return results
