"""Apple device preparation through supported tools and public profiles.

The adapter never supervises/erases a device or changes signing identities.
A successful install command is not proof of TLS trust; the coordinator's TLS
canary determines readiness. Only a public CA certificate enters a profile.
"""
from __future__ import annotations

import contextlib
import hashlib
import ipaddress
import json
import os
import plistlib
import re
import shutil
import subprocess
import tempfile
import uuid
import zipfile
from pathlib import Path
from urllib.parse import urlsplit


class IOSSetupError(Exception):
    def __init__(self, code, message, state=None):
        super().__init__(message)
        self.code, self.state = code, state


def _public_ca(path):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    path = Path(path).expanduser()
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
        raise IOSSetupError("CA_INVALID", "Public CA certificate is absent, linked or oversized")
    data = path.read_bytes()
    if b"PRIVATE KEY" in data:
        raise IOSSetupError("CA_PRIVATE_KEY", "Only the public CA certificate may be distributed")
    try:
        cert = x509.load_pem_x509_certificate(data) if b"-----BEGIN CERTIFICATE" in data else x509.load_der_x509_certificate(data)
        if not cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
            raise ValueError()
    except (ValueError, x509.ExtensionNotFound):
        raise IOSSetupError("CA_INVALID", "A valid CA certificate is required") from None
    return cert.public_bytes(serialization.Encoding.DER), cert.fingerprint(hashes.SHA256()).hex()


def _value(value, label, maximum=1024):
    if not isinstance(value, str) or not value or len(value) > maximum or any(ord(c) < 32 for c in value):
        raise IOSSetupError("OPTIONS_INVALID", label + " is invalid")
    return value


def _base(identifier, name, payload_type):
    return {"PayloadType": payload_type, "PayloadVersion": 1, "PayloadIdentifier": identifier,
            "PayloadUUID": str(uuid.uuid5(uuid.NAMESPACE_URL, identifier)).upper(), "PayloadDisplayName": name}


def build_profile(options):
    """Return (XML profile bytes, public metadata); contains no Wi-Fi password."""
    der, fingerprint = _public_ca(options["ca_cert"])
    host = _value(options.get("proxy_host", "127.0.0.1"), "Proxy host", 253)
    # Numeric local addresses or ordinary DNS names only; no URI/auth delimiters.
    if not re.fullmatch(r"[A-Za-z0-9._:\[\]-]+", host):
        raise IOSSetupError("OPTIONS_INVALID", "Proxy host must be an address or hostname")
    port = options.get("proxy_port", 8080)
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise IOSSetupError("OPTIONS_INVALID", "Proxy port is invalid")
    ssid = options.get("wifi_ssid")
    if ssid is not None:
        _value(ssid, "Wi-Fi SSID", 32)
    if ssid and len(ssid.encode("utf-8")) > 32:
        raise IOSSetupError("OPTIONS_INVALID", "Wi-Fi SSID exceeds 32 bytes")
    if options.get("supervised") and ssid:
        raise IOSSetupError("OPTIONS_INVALID", "Choose Wi-Fi or supervised global proxy, not both")
    if any(options.get(k) for k in ("wifi_password", "password", "proxy_password")):
        raise IOSSetupError("PROFILE_CREDENTIALS", "Passwords must be entered on the device, not placed in a public profile")
    mode = "global" if options.get("supervised") else "wifi" if ssid else "manual"
    pac_url = options.get("pac_url")
    if pac_url is not None:
        _value(pac_url, "PAC URL", 4096)
        try:
            parsed = urlsplit(pac_url)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
                raise ValueError()
            _ = parsed.port
        except ValueError:
            raise IOSSetupError("OPTIONS_INVALID", "PAC URL must be HTTP(S) without userinfo or fragment") from None
    identity = [fingerprint, ssid, mode, pac_url] if pac_url else [fingerprint, host, port, ssid, mode]
    suffix = hashlib.sha256(json.dumps(identity, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()[:24]
    identifier = "com.bfs-clicker.capture." + suffix
    ca = _base(identifier + ".ca", "bfs-clicker Test CA " + fingerprint[:12], "com.apple.security.root")
    ca.update(PayloadContent=der, PayloadCertificateFileName="bfs-clicker-test-ca.cer")
    payloads = [ca]
    if mode == "wifi":
        wifi = _base(identifier + ".wifi", "bfs-clicker Test Wi-Fi Proxy", "com.apple.wifi.managed")
        wifi.update(SSID_STR=ssid, AutoJoin=True, EncryptionType="Any")
        wifi.update({"ProxyType": "Auto", "ProxyPACURL": pac_url, "ProxyPACFallbackAllowed": True}
                    if pac_url else {"ProxyType": "Manual", "ProxyServer": host, "ProxyServerPort": port})
        payloads.append(wifi)
    elif mode == "global":
        proxy = _base(identifier + ".proxy", "bfs-clicker Supervised Test Proxy", "com.apple.proxy.http.global")
        proxy.update({"ProxyType": "Auto", "ProxyPACURL": pac_url, "ProxyPACFallbackAllowed": True}
                     if pac_url else {"ProxyType": "Manual", "ProxyServer": host, "ProxyServerPort": port})
        payloads.append(proxy)
    profile = _base(identifier, "bfs-clicker Capture " + fingerprint[:12], "Configuration")
    profile.update(PayloadContent=payloads, PayloadRemovalDisallowed=False, PayloadOrganization="bfs-clicker",
                   PayloadDescription="Local test CA and optional proxy. Remove this exact profile to undo its settings.")
    return plistlib.dumps(profile, fmt=plistlib.FMT_XML, sort_keys=True), {
        "identifier": identifier, "uuid": profile["PayloadUUID"], "ca_fingerprint": fingerprint,
        "proxy_mode": mode, "proxy_host": host, "proxy_port": port, "wifi_ssid": ssid,
        "trust": "verification_required", "requires_supervision": mode == "global", "pac_url": pac_url,
        "proxy_type": "Auto" if pac_url else "Manual", "pac_fallback_allowed": bool(pac_url)}


def _normal_result(value):
    if isinstance(value, str):
        return 0, value, ""
    if isinstance(value, dict):
        return int(value.get("returncode", value.get("code", 0))), str(value.get("stdout", "")), str(value.get("stderr", ""))
    return int(value.returncode), value.stdout or "", value.stderr or ""


class IOSSetup:
    def __init__(self, options, runner=None):
        self.options = dict(options)
        self.runner = runner or self._subprocess
        self.xcrun = self.options.get("xcrun", "xcrun")
        self.cfgutil = self.options.get("cfgutil") or shutil.which("cfgutil")
        if not self.cfgutil:
            for candidate in ("/Applications/Apple Configurator.app/Contents/MacOS/cfgutil", "/Applications/Apple Configurator 2.app/Contents/MacOS/cfgutil"):
                if Path(candidate).is_file():
                    self.cfgutil = candidate
                    break
        self.target = self.options.get("target", "ios")
        if self.target not in {"ios", "ios-simulator"}:
            raise IOSSetupError("TARGET_INVALID", "Apple adapter requires ios or ios-simulator")

    @staticmethod
    def _subprocess(argv, timeout=30):
        return subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout, check=False)

    def _run(self, argv, timeout=30):
        try:
            return _normal_result(self.runner([str(v) for v in argv], timeout=timeout))
        except (OSError, subprocess.TimeoutExpired):
            return 127, "", ""

    def _json_command(self, args):
        # Apple directs automation clients to JSON, never human Terminal tables.
        with tempfile.TemporaryDirectory(prefix="bfs-device-query-") as tmp:
            destination = Path(tmp) / "result.json"
            rc, out, _ = self._run([self.xcrun, "devicectl", *args, "--json-output", str(destination)])
            if rc:
                return None
            try:
                if destination.exists() and destination.stat().st_size <= 4 * 1024 * 1024:
                    return json.loads(destination.read_text())
                # Also accommodates injected test runners returning JSON directly.
                return json.loads(out) if out else None
            except (ValueError, OSError):
                return None

    def _physical_devices(self):
        value = self._json_command(["list", "devices"])
        if not isinstance(value, dict):
            return [], False
        rows = value.get("result", {}).get("devices", []) if isinstance(value.get("result"), dict) else []
        if not isinstance(rows, list):
            return [], False
        devices = []
        for row in rows[:256]:
            if not isinstance(row, dict) or not isinstance(row.get("identifier"), str):
                continue
            properties = row.get("deviceProperties") or {}
            connection = row.get("connectionProperties") or {}
            hardware = row.get("hardwareProperties") or {}
            if not all(isinstance(x, dict) for x in (properties, connection, hardware)):
                continue
            devices.append({"id": row["identifier"], "udid": str(hardware.get("udid", "")),
                            "name": str(properties.get("name", ""))[:128],
                            "paired": connection.get("pairingState") == "paired",
                            "connection": str(connection.get("tunnelState", connection.get("transportType", "unknown"))),
                            "developer_mode": properties.get("developerModeStatus", "unknown")})
        return devices, True

    def _simulators(self):
        rc, out, _ = self._run([self.xcrun, "simctl", "list", "devices", "--json"])
        if rc:
            return [], False
        try:
            value = json.loads(out)
            groups = value["devices"]
            if not isinstance(groups, dict):
                raise ValueError()
            rows = []
            for runtime, devices in list(groups.items())[:128]:
                if not isinstance(devices, list) or not any(s in runtime.lower() for s in ("ios", "iphone")):
                    continue
                for row in devices[:256]:
                    if isinstance(row, dict) and isinstance(row.get("udid"), str) and row.get("isAvailable", True):
                        rows.append({"id": row["udid"], "name": str(row.get("name", ""))[:128], "state": row.get("state"), "runtime": runtime})
            return rows, True
        except (ValueError, KeyError, TypeError):
            return [], False

    def _cfg_capabilities(self):
        if not self.cfgutil:
            return {"available": False, "install_profile": False, "install_app": False, "devices": []}
        rc, help_text, help_error = self._run([self.cfgutil, "help"])
        if rc:
            rc, help_text, help_error = self._run([self.cfgutil, "--help"])
        help_text += "\n" + help_error
        supported = rc == 0 and all(term in help_text for term in ("--ecid", "--format"))
        result = {"available": supported, "install_profile": supported and "install-profile" in help_text,
                  "install_app": supported and "install-app" in help_text, "devices": []}
        if not supported:
            return result
        rc, out, _ = self._run([self.cfgutil, "--format", "JSON", "list"])
        try:
            value = json.loads(out) if rc == 0 else None
            rows = value.get("Devices", []) if isinstance(value, dict) else value if isinstance(value, list) else []
            if isinstance(rows, list):
                for row in rows[:256]:
                    if not isinstance(row, dict):
                        continue
                    ecid = row.get("ECID", row.get("ecid"))
                    if isinstance(ecid, int):
                        ecid = str(ecid)
                    if isinstance(ecid, str) and re.fullmatch(r"(?:0x)?[0-9A-Fa-f]{1,32}", ecid):
                        result["devices"].append({"ecid": ecid, "udid": str(row.get("UDID", row.get("udid", ""))),
                                                   "name": str(row.get("Name", row.get("name", "")))[:128]})
        except (ValueError, TypeError):
            pass
        return result

    @staticmethod
    def _select(devices, requested, keys, prefer_booted=False):
        if requested:
            found = [row for row in devices if any(str(row.get(key, "")) == requested for key in keys)]
        else:
            found = [row for row in devices if not prefer_booted or row.get("state") == "Booted"]
        return found[0] if len(found) == 1 else None

    def plan(self):
        _, profile = build_profile(self.options)
        requested = self.options.get("device")
        if requested is not None:
            _value(requested, "Device selector", 255)
        if self.target == "ios-simulator":
            devices, available = self._simulators()
            selected = self._select(devices, requested, ("id", "name"), prefer_booted=True)
            return {"target": self.target, "profile": profile, "devices": devices, "device": selected,
                    "capabilities": {"simctl": available}, "action_required": [] if selected else ["select_or_boot_simulator"],
                    "proxy": "host_network_setup_required", "trust": "verification_required"}
        devices, available = self._physical_devices()
        cfg = self._cfg_capabilities()
        cfg_selected = self._select(cfg["devices"], requested, ("ecid", "udid", "name"))
        connected = [row for row in devices if row["connection"].lower() in {"connected", "wired", "usb"}]
        selected = self._select(devices if requested else connected or devices, requested, ("id", "udid", "name"))
        if cfg_selected and not selected and cfg_selected["udid"]:
            selected = self._select(devices, cfg_selected["udid"], ("udid",))
        if selected and not cfg_selected and selected["udid"]:
            cfg_selected = self._select(cfg["devices"], selected["udid"], ("udid",))
        actions = []
        if selected and not selected["paired"]:
            actions.append("unlock_and_trust_this_computer")
        if not selected and not cfg_selected:
            actions.append("connect_or_select_device" if available or cfg["available"] else "use_profile_portal_or_install_apple_tools")
        return {"target": self.target, "profile": profile, "devices": devices, "device": selected,
                "cfg_device": cfg_selected, "capabilities": {"devicectl": available, "cfgutil": cfg},
                "action_required": actions, "proxy": "profile_or_manual_required", "trust": "verification_required"}

    @staticmethod
    def _action(state, code, message):
        if not any(a["code"] == code for a in state["action_required"]):
            state["action_required"].append({"code": code, "message": message})

    def _write_profile(self, state):
        data, metadata = build_profile(self.options)
        directory = Path(self.options["state_dir"]).expanduser()
        if directory.is_symlink():
            raise IOSSetupError("STATE_INVALID", "State directory must not be a symlink", state)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        destination = directory / (metadata["identifier"] + ".mobileconfig")
        if destination.is_symlink():
            raise IOSSetupError("STATE_INVALID", "Profile destination must not be a symlink", state)
        if destination.exists() and destination.stat().st_size > 256 * 1024:
            raise IOSSetupError("STATE_INVALID", "Existing profile exceeds its byte budget", state)
        if not destination.exists() or destination.read_bytes() != data:
            fd, temporary = tempfile.mkstemp(prefix=".profile-", dir=directory)
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.chmod(temporary, 0o600)
                os.replace(temporary, destination)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        state["profile"] = {**metadata, "path": str(destination.resolve()), "installed": False}

    def _checkpoint(self, state):
        from .common import atomic_json
        directory = Path(self.options["state_dir"]).expanduser()
        destination = directory / (self.target + "-state.json")
        if directory.is_symlink() or destination.is_symlink():
            raise IOSSetupError("STATE_INVALID", "Apple checkpoint cannot be a symlink", state)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        atomic_json(destination, state)
        os.chmod(destination, 0o600)

    def _mutate(self, state, name, argv, timeout=30, **metadata):
        # Write intent before invoking a tool: it may commit its device-side
        # change and lose the acknowledgement if the host process is interrupted.
        operations = state.setdefault("operations", {})
        operations[name] = {"status": "intent", **metadata}
        self._checkpoint(state)
        rc, out, err = self._run(argv, timeout=timeout)
        operations[name] = {"status": "command_succeeded" if rc == 0 else "command_failed", "returncode": rc, **metadata}
        self._checkpoint(state)
        return rc, out, err

    def _app_bundle(self, artifact, temporary):
        from .extract import ExtractOptions
        from .ios import _snapshot
        # Snapshot preserves signed bytes but the extractor intentionally omits
        # POSIX modes, so restore ZIP modes before codesign/device installation.
        artifact = Path(artifact).expanduser()
        if artifact.is_symlink():
            raise IOSSetupError("ARTIFACT_INVALID", "App artifact must not be a symlink")
        root, _, kind, selected = _snapshot(artifact.resolve(), temporary, ExtractOptions(), self.options.get("app"))
        if kind == "ipa":
            with zipfile.ZipFile(artifact) as archive:
                prefix = selected + "/"
                for info in archive.infolist():
                    if info.filename.startswith(prefix) and not info.is_dir():
                        target = root / info.filename[len(prefix):]
                        mode = (info.external_attr >> 16) & 0o777
                        if mode:
                            target.chmod(mode)
        else:
            for source in artifact.rglob("*"):
                if source.is_file():
                    (root / source.relative_to(artifact)).chmod(source.stat().st_mode & 0o777)
        info = plistlib.loads((root / "Info.plist").read_bytes())
        bundle = info.get("CFBundleIdentifier") if isinstance(info, dict) else None
        if not isinstance(bundle, str) or not re.fullmatch(r"[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+", bundle):
            raise IOSSetupError("APP_INVALID", "App Bundle identifier is invalid")
        explicit = self.options.get("bundle_id")
        if explicit and explicit != bundle:
            raise IOSSetupError("APP_IDENTITY_MISMATCH", "Requested bundle identifier differs from the artifact")
        return root, bundle

    def _install_app(self, state):
        artifact = self.options.get("artifact")
        bundle = self.options.get("bundle_id")
        if bundle and not re.fullmatch(r"[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+", bundle):
            raise IOSSetupError("OPTIONS_INVALID", "Bundle identifier is invalid", state)
        device = state.get("device")
        if self.target == "ios-simulator":
            if not device:
                self._action(state, "SIMULATOR_SELECTION", "启动并选择一个 iOS Simulator 后重试，或指定 --device。")
                return
            if device["state"] != "Booted":
                self._action(state, "SIMULATOR_BOOT", "Simulator 尚未 ready，请完成启动后重试。")
                return
            if artifact:
                path = Path(artifact).expanduser()
                if path.suffix.lower() != ".app" or not path.is_dir() or path.is_symlink():
                    raise IOSSetupError("ARTIFACT_INVALID", "Simulator installation requires a Simulator .app Bundle", state)
                info = plistlib.loads((path / "Info.plist").read_bytes())
                installed_bundle = info.get("CFBundleIdentifier")
                if bundle and installed_bundle != bundle:
                    raise IOSSetupError("APP_IDENTITY_MISMATCH", "Requested bundle identifier differs from the Simulator App", state)
                if not isinstance(installed_bundle, str) or not re.fullmatch(r"[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+", installed_bundle):
                    raise IOSSetupError("APP_INVALID", "Simulator App Bundle identifier is invalid", state)
                rc, _, _ = self._mutate(state, "app_install", [self.xcrun, "simctl", "install", device["id"], str(path.resolve())], timeout=120, device=device["id"], bundle_id=installed_bundle)
                if rc:
                    self._action(state, "APP_INSTALL_REQUIRED", "Simulator App 安装未成功；没有卸载或清除原 App。")
                    return
                bundle = installed_bundle
                state["app"] = {"bundle_id": bundle, "installed": True}
            if bundle and self.options.get("launch", True):
                rc, _, _ = self._mutate(state, "app_launch", [self.xcrun, "simctl", "launch", device["id"], bundle], device=device["id"], bundle_id=bundle)
                state["app"] = {**state.get("app", {}), "bundle_id": bundle, "launched": rc == 0}
                if rc:
                    self._action(state, "APP_LAUNCH_REQUIRED", "请在 Simulator 中确认 App 可运行。")
            return
        cfg = state["capabilities"]["cfgutil"]
        cfg_device = state.get("cfg_device")
        if artifact:
            with tempfile.TemporaryDirectory(prefix="bfs-ios-install-") as temporary:
                root, actual_bundle = self._app_bundle(artifact, Path(temporary))
                rc, _, _ = self._run(["codesign", "--verify", "--deep", "--strict", str(root)])
                if rc:
                    self._action(state, "APP_SIGNATURE_REQUIRED", "请提供签名有效且适配该设备的 App；脚本不重签或清除现有 App。")
                    return
                if cfg_device and cfg["install_app"] and Path(artifact).suffix.lower() == ".ipa":
                    rc, _, _ = self._mutate(state, "app_install", [self.cfgutil, "--format", "JSON", "--ecid", cfg_device["ecid"], "install-app", str(Path(artifact).resolve())], timeout=120, ecid=cfg_device["ecid"], bundle_id=actual_bundle)
                elif device and device.get("paired"):
                    rc, _, _ = self._mutate(state, "app_install", [self.xcrun, "devicectl", "device", "install", "app", "--device", device["id"], str(root)], timeout=120, device=device["id"], bundle_id=actual_bundle)
                else:
                    self._action(state, "APP_INSTALL_REQUIRED", "连接并信任目标设备，或安装 Apple Configurator Automation Tools 后重试。")
                    return
                if rc:
                    self._action(state, "APP_INSTALL_REQUIRED", "App 安装未成功，请在设备确认授权和签名；原 App 未被先行卸载。")
                    return
                bundle = actual_bundle
                state["app"] = {"bundle_id": bundle, "installed": True}
        if bundle and self.options.get("launch", True):
            if device and device.get("paired"):
                rc, _, _ = self._mutate(state, "app_launch", [self.xcrun, "devicectl", "device", "process", "launch", "--device", device["id"], bundle], device=device["id"], bundle_id=bundle)
                state["app"] = {**state.get("app", {}), "bundle_id": bundle, "launched": rc == 0}
                if rc:
                    self._action(state, "APP_LAUNCH_REQUIRED", "请在设备完成开发者信任/Developer Mode，并打开目标 App。")
            else:
                self._action(state, "APP_LAUNCH_REQUIRED", "请在目标设备打开 App；没有已配对的 devicectl 设备可自动启动。")

    def apply(self):
        state = {"target": self.target, "action_required": [], "trust": "verification_required", "proxy": "verification_required",
                 "ca_owned": False, "keep_ca": bool(self.options.get("keep_ca", True)), "simulator_booted_by_run": False}
        try:
            state.update(self.plan())
            state["action_required"] = [{"code": code.upper(), "message": code.replace("_", " ")} for code in state["action_required"]]
            self._checkpoint(state)
            self._write_profile(state)
            self._checkpoint(state)
            selected = state.get("device")
            if self.target == "ios" and selected and not selected.get("paired") and self.options.get("pair", True):
                rc, help_text, _ = self._run([self.xcrun, "devicectl", "help", "manage", "pair"])
                if not rc and "--device" in help_text:
                    state["pairing_attempted"] = True
                    self._mutate(state, "pair", [self.xcrun, "devicectl", "manage", "pair", "--device", selected["id"]], timeout=90, device=selected["id"])
                    refreshed, _ = self._physical_devices()
                    paired = self._select(refreshed, selected["id"], ("id",))
                    if paired and paired.get("paired"):
                        state["device"] = paired
                        state["action_required"] = [a for a in state["action_required"] if a["code"] != "UNLOCK_AND_TRUST_THIS_COMPUTER"]
            if self.target == "ios-simulator":
                device = state.get("device")
                if device and device["state"] != "Booted":
                    rc, _, _ = self._mutate(state, "simulator_boot", [self.xcrun, "simctl", "boot", device["id"]], device=device["id"])
                    if not rc:
                        state["simulator_booted_by_run"] = True
                        rc, _, _ = self._run([self.xcrun, "simctl", "bootstatus", device["id"], "-b"], timeout=120)
                    if rc:
                        self._action(state, "SIMULATOR_BOOT", "Simulator 启动未完成，请在系统中完成后重试。")
                    else:
                        device["state"] = "Booted"
                if device and device["state"] == "Booted":
                    # Query runtime support, not assumptions about installed Xcode.
                    rc, help_text, _ = self._run([self.xcrun, "simctl", "help", "keychain"])
                    if rc == 0 and "add-root-cert" in help_text and not self.options.get("ca_ready"):
                        rc, _, _ = self._mutate(state, "ca_import", [self.xcrun, "simctl", "keychain", device["id"], "add-root-cert", str(Path(self.options["ca_cert"]).resolve())], device=device["id"], ca_fingerprint=state["profile"]["ca_fingerprint"])
                        state["ca_install_attempted"] = True
                        state["ca_added"] = rc == 0
                        if not rc:
                            self._action(state, "CA_TRUST_VERIFICATION", "等待 HTTPS 自测；若未通过，在 Simulator 的证书信任设置中启用项目 CA。")
                        if rc:
                            self._action(state, "CA_INSTALL_REQUIRED", "请在选定 Simulator 中安装项目 CA。")
                    elif not self.options.get("ca_ready"):
                        self._action(state, "CA_INSTALL_REQUIRED", "当前 simctl 不支持自动导入 CA，请在 Simulator 安装项目 CA。")
                    url = self.options.get("onboarding_url")
                    if url:
                        self._open_simulator_url(state, url)
                self._action(state, "HOST_PROXY_REQUIRED", "Simulator 使用宿主机网络；请由本次 macOS 适配器设置并恢复宿主代理。")
            elif self.options.get("ca_ready"):
                state["profile"]["install_state"] = "existing_path_verified_by_coordinator"
            else:
                cfg, selected = state["capabilities"]["cfgutil"], state.get("cfg_device")
                if selected and cfg["install_profile"]:
                    rc, _, _ = self._mutate(state, "profile_install", [self.cfgutil, "--format", "JSON", "--ecid", selected["ecid"], "install-profile", state["profile"]["path"]], timeout=90, ecid=selected["ecid"], profile_identifier=state["profile"]["identifier"])
                    state["profile"]["installed"] = rc == 0
                    state["profile"]["install_state"] = "configurator_requested" if rc == 0 else "device_confirmation_required"
                    if rc:
                        self._action(state, "PROFILE_INSTALL_REQUIRED", "Configurator 未确认安装成功，请解锁/允许设备授权；也可在引导页下载描述文件。")
                else:
                    self._action(state, "PROFILE_INSTALL_REQUIRED", "在设备打开引导页下载描述文件，然后在设置 > 通用 > VPN 与设备管理中安装。")
                if not state["profile"].get("installed"):
                    self._action(state, "CA_FULL_TRUST_REQUIRED", "安装后打开设置 > 通用 > 关于本机 > 证书信任设置，启用该项目 CA 的完整信任。")
                if state["profile"]["proxy_mode"] == "manual":
                    if state["profile"].get("pac_url"):
                        self._action(state, "DEVICE_PROXY_REQUIRED", "在当前 Wi-Fi 的 HTTP 代理选择自动，填入本轮 PAC 地址；传入 SSID 可把此项合并进描述文件。")
                    else:
                        self._action(state, "DEVICE_PROXY_REQUIRED", f"将本次 Wi-Fi HTTP 代理设为 {state['profile']['proxy_host']}:{state['profile']['proxy_port']}；传入 SSID 可生成合并代理描述文件。")
                elif state["profile"]["proxy_mode"] == "wifi":
                    self._action(state, "WIFI_PROFILE_CONFIRMATION", "确认加入描述文件中的测试 Wi-Fi；系统需要密码时在设备输入，脚本不保存密码。")
                else:
                    self._action(state, "SUPERVISION_REQUIRED", "全局代理描述文件仅适用于已经受监督的设备；脚本不会创建监督状态。")
            if self.target == "ios" and self.options.get("onboarding_url") and not self.options.get("ca_ready"):
                self._open_physical_url(state, self.options["onboarding_url"])
            self._install_app(state)
            # The caller replaces this status only after an actual HTTPS canary.
            state["status"] = "verification_required"
            self._checkpoint(state)
            return state
        except IOSSetupError as error:
            error.state = state
            with contextlib.suppress(OSError, IOSSetupError):
                self._checkpoint(state)
            raise
        except Exception as error:
            with contextlib.suppress(OSError, IOSSetupError):
                self._checkpoint(state)
            raise IOSSetupError(getattr(error, "code", "IOS_SETUP_FAILED"), "Apple preparation could not complete", state) from error

    def _open_physical_url(self, state, value):
        parts = urlsplit(value) if isinstance(value, str) and len(value) <= 4096 else None
        if not parts or parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
            raise IOSSetupError("OPTIONS_INVALID", "Onboarding URL must be HTTP(S) without userinfo", state)
        device = state.get("device")
        if device and device.get("paired"):
            rc, help_text, _ = self._run([self.xcrun, "devicectl", "help", "device", "process", "launch"])
            if not rc and "--payload-url" in help_text:
                rc, _, _ = self._run([self.xcrun, "devicectl", "device", "process", "launch", "--device", device["id"], "--payload-url", value, "com.apple.mobilesafari"])
                state["onboarding_opened"] = rc == 0
                if not rc:
                    return
        self._action(state, "OPEN_ONBOARDING", "在目标设备 Safari 打开本轮引导页，或扫描终端/面板中的二维码。")

    def _open_simulator_url(self, state, value):
        if not isinstance(value, str) or len(value) > 4096:
            raise IOSSetupError("OPTIONS_INVALID", "Onboarding URL is invalid", state)
        parts = urlsplit(value)
        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
            raise IOSSetupError("OPTIONS_INVALID", "Onboarding URL must be HTTP(S) without userinfo", state)
        rc, _, _ = self._run([self.xcrun, "simctl", "openurl", state["device"]["id"], value])
        state["onboarding_opened"] = rc == 0
        if rc:
            self._action(state, "OPEN_ONBOARDING", "请在 Simulator 的 Safari 打开本轮引导页。")

    def launch(self, state):
        """Start the target only when the coordinator has completed readiness."""
        if not isinstance(state, dict) or state.get("target") != self.target:
            raise IOSSetupError("STATE_INVALID", "Apple receipt is invalid")
        app = state.get("app", {})
        if self.options.get("artifact") and (not isinstance(app, dict) or app.get("installed") is not True):
            return {"status": "action_required", "code": "APP_INSTALL_REQUIRED", "message": "本次 App 尚未确认安装成功；不启动设备上可能存在的旧版本。"}
        bundle = app.get("bundle_id") if isinstance(app, dict) else None
        bundle = bundle or self.options.get("bundle_id")
        if not bundle:
            return {"status": "not_requested"}
        if not re.fullmatch(r"[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+", bundle):
            raise IOSSetupError("STATE_INVALID", "Bundle identifier is invalid")
        device = state.get("device")
        if not isinstance(device, dict):
            return {"status": "action_required", "code": "APP_LAUNCH_REQUIRED", "message": "请在选定设备打开测试 App。"}
        if self.target == "ios-simulator":
            argv = [self.xcrun, "simctl", "launch", device["id"], bundle]
        elif device.get("paired"):
            argv = [self.xcrun, "devicectl", "device", "process", "launch", "--device", device["id"], bundle]
        else:
            return {"status": "action_required", "code": "PAIRING_REQUIRED", "message": "请解锁并信任本机，然后重试启动。"}
        rc, _, _ = self._mutate(state, "app_launch", argv, device=device["id"], bundle_id=bundle)
        result = {"status": "launched" if rc == 0 else "action_required", "bundle_id": bundle,
                  **({"code": "APP_LAUNCH_REQUIRED", "message": "请在设备确认开发者信任并打开测试 App。"} if rc else {})}
        state["launch"] = result
        self._checkpoint(state)
        return result

    def restore(self, state, remove_ca=False):
        if not isinstance(state, dict) or state.get("target") not in {"ios", "ios-simulator"}:
            raise IOSSetupError("STATE_INVALID", "Apple receipt is invalid")
        result = {"target": state["target"], "status": "preserved", "proxy": "profile_or_host_managed", "ca": "kept", "action_required": []}
        if not remove_ca:
            profile = state.get("profile", {})
            if state["target"] == "ios" and isinstance(profile, dict) and profile.get("pac_url"):
                result.update(proxy="pac_direct_or_unreachable_fallback", original_wifi_settings_restored=False,
                              note="保留项目 CA/描述文件；协调器切换 PAC 为 DIRECT，不可达时按 payload 允许直连。")
            elif state["target"] == "ios" and isinstance(profile, dict):
                result.update(status="action_required", proxy="manual_reset_required")
                result["action_required"].append({"code": "RESET_IOS_PROXY", "message": "测试结束后在该 Wi-Fi 关闭 HTTP 代理；若代理由描述文件锁定，移除项目描述文件。保留其他设备配置。"})
            return result
        profile = state.get("profile", {})
        if not isinstance(profile, dict):
            raise IOSSetupError("STATE_INVALID", "Apple profile receipt is invalid")
        identifier = profile.get("identifier", "")
        if not re.fullmatch(r"com\.bfs-clicker\.capture\.[a-f0-9]{24}", identifier):
            raise IOSSetupError("STATE_INVALID", "Project profile identifier is invalid")
        # simctl exposes reset, but it would remove unrelated user credentials.
        # Do not turn a single-CA cleanup request into a keychain-wide reset.
        result.update(status="action_required", ca="manual_removal_required")
        if state["target"] == "ios-simulator":
            message = "在本次选定 Simulator 的证书信任设置中停用项目 CA。simctl 没有单证书移除能力，本工具不重置整个 keychain。CA 指纹：" + str(profile.get("ca_fingerprint", ""))
        else:
            message = "在设备设置 > 通用 > VPN 与设备管理中移除该项目描述文件：" + identifier
        result["action_required"].append({"code": "REMOVE_PROJECT_CA", "message": message})
        if state["target"] == "ios":
            history = state.get("profile_history", [])
            if not isinstance(history, list) or len(history) > 64:
                raise IOSSetupError("STATE_INVALID", "Project profile history is invalid")
            identifiers = {identifier}
            for entry in history:
                if not isinstance(entry, dict):
                    raise IOSSetupError("STATE_INVALID", "Project profile history entry is invalid")
                previous = entry.get("profile", entry)
                old_identifier = previous.get("identifier") if isinstance(previous, dict) else None
                if not isinstance(old_identifier, str) or not re.fullmatch(r"com\.bfs-clicker\.capture\.[a-f0-9]{24}", old_identifier):
                    raise IOSSetupError("STATE_INVALID", "Historical project profile identifier is invalid")
                if old_identifier not in identifiers:
                    identifiers.add(old_identifier)
                    result["action_required"].append({"code": "REMOVE_PROJECT_PROFILE", "message": "同时移除本次流程此前安装的项目描述文件：" + old_identifier})
        return result
