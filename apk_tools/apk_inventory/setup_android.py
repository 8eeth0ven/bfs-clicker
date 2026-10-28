"""Reversible, non-root Android capture preparation.

The user CA installer is a human hand-off. Opening an installer is never evidence
that a certificate was installed or that an application's TLS policy accepts it.
"""
from __future__ import annotations

import hashlib
import ipaddress
import os
import re
import shlex
import subprocess
import uuid
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

from .common import InventoryError, atomic_json

PROXY_KEYS = ("http_proxy", "global_http_proxy_host", "global_http_proxy_port",
              "global_http_proxy_exclusion_list", "global_proxy_pac_url")
LIMITATIONS = ["Android user-CA installation requires system confirmation",
               "Apps targeting Android 7+ do not trust user CAs by default",
               "No root, system-CA modification or TLS-pinning bypass is performed"]
SERIAL = re.compile(r"[A-Za-z0-9_.:\[\]-]{1,180}")
PACKAGE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+")
REMOTE_CERT = re.compile(r"/sdcard/Download/bfs-capture-ca-[a-f0-9]{32}\.crt")


class AndroidSetupError(InventoryError):
    def __init__(self, code, message, state=None):
        super().__init__(code, message)
        self.state = state


def _runner(argv, timeout=30):
    return subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True, timeout=timeout, check=False)


class AndroidSetup:
    def __init__(self, options, runner=None):
        self.options = dict(options)
        self.runner = runner or _runner
        self.adb = str(self.options.get("adb", "adb"))
        self.device = self.options.get("device")
        self.state = None
        self._metadata = None

    def _checkpoint(self):
        try:
            self._write_checkpoint()
        except (OSError, AndroidSetupError) as error:
            if getattr(self, "_recovering", False):
                # A failed disk write must not strand the device proxy: retain
                # the in-memory receipt and continue conservative rollback.
                self.state["checkpoint_error"] = getattr(error, "code", "ANDROID_CHECKPOINT_FAILED")
                return
            if isinstance(error, AndroidSetupError):
                raise
            raise AndroidSetupError("ANDROID_CHECKPOINT_FAILED", "Android recovery state could not be persisted", self.state) from None

    def _write_checkpoint(self):
        if self.state is None:
            return
        directory = Path(self.options.get("state_dir", ".capture-setup")).expanduser()
        if directory.is_symlink() or directory.parent.is_symlink():
            raise AndroidSetupError("ANDROID_STATE_PATH_INVALID", "Android state directory cannot be a symlink", self.state)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = directory / "android-state.json"
        if path.is_symlink() or path.exists() and path.stat().st_uid != os.getuid():
            raise AndroidSetupError("ANDROID_STATE_PATH_INVALID", "Android recovery file must be owned and not a symlink", self.state)
        atomic_json(path, self.state)
        os.chmod(path, 0o600)

    def _run(self, argv, *, timeout=30, optional=False):
        try:
            value = self.runner(list(map(str, argv)), timeout=timeout)
            if isinstance(value, str):
                value = subprocess.CompletedProcess(argv, 0, value, "")
            elif isinstance(value, dict):
                value = subprocess.CompletedProcess(argv, value.get("returncode", 0), value.get("stdout", ""), value.get("stderr", ""))
            code = value.returncode
            output = value.stdout or ""
            if isinstance(output, bytes):
                output = output.decode("utf-8", "replace")
            errors = value.stderr or ""
            if isinstance(errors, bytes):
                errors = errors.decode("utf-8", "replace")
            if len(output) > 1024 * 1024 or len(errors) > 1024 * 1024:
                raise AndroidSetupError("ANDROID_OUTPUT_LIMIT", "An adb command exceeded its output budget")
            if code and not optional:
                raise AndroidSetupError("ANDROID_COMMAND_FAILED", "An Android preparation command was rejected")
            return subprocess.CompletedProcess(argv, code, output.strip(), errors.strip())
        except AndroidSetupError:
            raise
        except (OSError, subprocess.TimeoutExpired):
            raise AndroidSetupError("ANDROID_TOOL_UNAVAILABLE", "adb could not run or exceeded its deadline") from None

    def _adb(self, *args, timeout=30, optional=False):
        if not isinstance(self.device, str) or not SERIAL.fullmatch(self.device):
            raise AndroidSetupError("ANDROID_DEVICE_INVALID", "Selected Android serial has an invalid format")
        return self._run([self.adb, "-s", self.device, *args], timeout=timeout, optional=optional)

    def _shell(self, *args, **kwargs):
        # adb shell joins values into a remote shell command; quote every argument.
        return self._adb("shell", shlex.join(map(str, args)), **kwargs)

    def _settings(self):
        output = self._shell("settings", "list", "global").stdout
        settings = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
        return {key: settings.get(key) for key in PROXY_KEYS}

    def _artifact(self):
        if self._metadata is not None:
            return self._metadata
        bundle = self.options.get("bundle_id")
        if bundle is not None and (not isinstance(bundle, str) or not PACKAGE.fullmatch(bundle)):
            raise AndroidSetupError("ANDROID_PACKAGE_INVALID", "Android bundle_id must be a package identifier")
        metadata = {"package_name": bundle, "launcher_activity": self.options.get("launcher_activity")}
        artifact = self.options.get("artifact")
        if artifact:
            path = Path(artifact).expanduser().resolve()
            if path.suffix.lower() != ".apk" or not path.is_file() or path.stat().st_size > 1024 * 1024 * 1024:
                raise AndroidSetupError("ANDROID_APK_INVALID", "Installation input must be a bounded local APK")
            try:
                with zipfile.ZipFile(path) as archive:
                    info = archive.getinfo("AndroidManifest.xml")
                    if info.file_size > 8 * 1024 * 1024:
                        raise ValueError()
                    with archive.open(info) as stream:
                        data = stream.read(8 * 1024 * 1024 + 1)
                    if len(data) > 8 * 1024 * 1024:
                        raise ValueError()
                from .extract import ExtractOptions, run_parser
                parsed = run_parser("manifest", data, ExtractOptions(native=False))
                if bundle and parsed.get("package_name") != bundle:
                    raise AndroidSetupError("ANDROID_PACKAGE_MISMATCH", "APK identity differs from bundle_id")
                metadata.update(package_name=parsed.get("package_name"), launcher_activity=parsed.get("launcher_activity"))
            except AndroidSetupError:
                raise
            except Exception:
                raise AndroidSetupError("ANDROID_APK_INVALID", "APK identity could not be decoded") from None
            if not isinstance(metadata["package_name"], str) or not PACKAGE.fullmatch(metadata["package_name"]):
                raise AndroidSetupError("ANDROID_PACKAGE_INVALID", "APK package identifier is invalid")
            metadata["artifact"] = str(path)
        self._metadata = metadata
        return metadata

    def plan(self):
        metadata = self._artifact()
        port = self.options.get("proxy_port", 8080)
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise AndroidSetupError("ANDROID_PROXY_INVALID", "Proxy port must be between 1 and 65535")
        if self.options.get("proxy_host"):
            try:
                ipaddress.ip_address(self.options["proxy_host"])
            except ValueError:
                raise AndroidSetupError("ANDROID_PROXY_INVALID", "Android proxy_host must be a numeric IP address") from None
        devices = []
        output = self._run([self.adb, "devices", "-l"]).stdout
        for line in output.splitlines():
            fields = line.split()
            if len(fields) >= 2 and fields[1] in {"device", "offline", "unauthorized", "recovery", "sideload"}:
                devices.append({"serial": fields[0], "state": fields[1]})
        base = {"platform": "android", "limitations": LIMITATIONS.copy(), "bundle_id": metadata.get("package_name")}
        if self.device:
            selected = next((row for row in devices if row["serial"] == self.device), None)
        elif len(devices) == 1:
            selected = devices[0]
        else:
            return {**base, "status": "action_required", "code": "ANDROID_DEVICE_SELECTION", "device": None,
                    "actions": ["Connect one authorized Android test device or select --device"], "devices": devices}
        if selected is None:
            return {**base, "status": "action_required", "code": "ANDROID_DEVICE_MISSING", "device": self.device,
                    "actions": ["Connect and unlock the selected Android device"]}
        self.device = selected["serial"]
        if selected["state"] != "device":
            return {**base, "status": "action_required", "code": "ANDROID_USB_AUTH_REQUIRED" if selected["state"] == "unauthorized" else "ANDROID_DEVICE_NOT_READY",
                    "device": self.device, "actions": ["Unlock the device and approve its USB debugging authorization dialog"]}
        if self._adb("get-state").stdout != "device":
            raise AndroidSetupError("ANDROID_DEVICE_NOT_READY", "Selected device is no longer online")
        settings = self._settings()
        if self.options.get("manage_proxy", "auto") != "manual" and settings["global_proxy_pac_url"] not in {None, "", "null"}:
            return {**base, "status": "blocked", "code": "ANDROID_PAC_ACTIVE", "device": self.device,
                    "actions": ["Keep the existing PAC; choose manual proxy management for this capture"]}
        return {**base, "status": "ready", "device": self.device,
                "actions": ["Install/launch the selected local APK if supplied", "Configure and later restore this run's proxy",
                            "Open Android CA installation/settings for the user's confirmation"]}

    def _configure_proxy(self):
        state = self.state
        state["proxy_before"] = self._settings()
        if self.options.get("manage_proxy", "auto") == "manual":
            state["proxy_status"] = "manual_unchanged"
            return
        if state["proxy_before"]["global_proxy_pac_url"] not in {None, "", "null"}:
            raise AndroidSetupError("ANDROID_PAC_ACTIVE", "An existing PAC will not be overwritten")
        host, port = self.options.get("proxy_host"), self.options.get("proxy_port", 8080)
        if not host and self.device.startswith("emulator-"):
            host = "10.0.2.2"
        if not host:
            mappings = self._adb("reverse", "--list").stdout
            occupied = {int(fields[-2][4:]) for line in mappings.splitlines()
                        if len(fields := line.split()) >= 2 and re.fullmatch(r"tcp:\d+", fields[-2])}
            device_port = port
            while device_port in occupied:
                device_port += 1
                if device_port > 65535:
                    raise AndroidSetupError("ANDROID_REVERSE_BUSY", "No free device reverse port is available")
            state["reverse"] = {"owned": False, "intended": True, "device_port": device_port, "host_port": port}
            self._checkpoint()
            self._adb("reverse", "--no-rebind", f"tcp:{device_port}", f"tcp:{port}")
            state["reverse"].update(owned=True, intended=False)
            self._checkpoint()
            host, port = "127.0.0.1", device_port
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            raise AndroidSetupError("ANDROID_PROXY_INVALID", "Android proxy_host must be a numeric IP address") from None
        target = (f"[{address}]" if address.version == 6 else str(address)) + ":" + str(port)
        state.update(proxy_target=target, proxy_host=str(address), proxy_device_port=port, proxy_intended=True)
        # Save intent before writing: adb can lose its ACK after the setting changes.
        self._checkpoint()
        self._shell("settings", "put", "global", "http_proxy", target)
        state["proxy_after"] = self._settings()
        if state["proxy_after"]["http_proxy"] != target:
            raise AndroidSetupError("ANDROID_PROXY_REJECTED", "Android did not retain the requested proxy")
        state["proxy_status"] = "configured"
        self._checkpoint()

    def _open_onboarding(self, url):
        if not url:
            return
        parts = urlsplit(str(url))
        try:
            address = ipaddress.ip_address(parts.hostname or "")
            local_host = address.is_private or address.is_loopback or address.is_link_local
        except ValueError:
            local_host = parts.hostname == "localhost" or bool(re.fullmatch(r"setup-[a-f0-9]{12}\.capture\.invalid", parts.hostname or ""))
        if parts.scheme not in {"http", "https"} or not local_host or parts.username or parts.password or len(str(url)) > 4096 or any(ord(c) < 32 for c in str(url)):
            raise AndroidSetupError("ANDROID_CA_URL_INVALID", "Certificate onboarding must use a local setup endpoint")
        ca = self.state["ca"]
        ca["browser_intended"] = True
        self._checkpoint()
        opened = self._shell("am", "start", "-a", "android.intent.action.VIEW", "-d", str(url), optional=True)
        ca["browser_requested"] = opened.returncode == 0 and not re.search(r"Error:|Exception", opened.stdout + " " + opened.stderr)
        ca["browser_intended"] = False
        self._checkpoint()

    def _prepare_ca(self):
        source = self.options.get("ca_cert")
        self.state["ca"] = {"status": "not_provided", "trusted": None}
        if not source:
            return
        try:
            from cryptography import x509
            from cryptography.hazmat.primitives.serialization import Encoding
            path = Path(source).expanduser().resolve()
            with path.open("rb") as stream:
                raw = stream.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError()
            if b"PRIVATE KEY" in raw:
                raise ValueError()
            cert = x509.load_pem_x509_certificate(raw) if b"-----BEGIN CERTIFICATE-----" in raw else x509.load_der_x509_certificate(raw)
            if not cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
                raise ValueError()
            public = cert.public_bytes(Encoding.DER)
        except Exception:
            raise AndroidSetupError("ANDROID_CA_INVALID", "CA input must contain only a bounded public CA certificate") from None
        fingerprint = hashlib.sha256(public).hexdigest()
        ca = self.state["ca"] = {"status": "manual_confirmation_required", "trusted": None,
                                  "sha256": fingerprint, "keep_ca": bool(self.options.get("keep_ca", True))}
        if self.options.get("ca_confirmed"):
            ca.update(status="user_confirmed_previous_install", trusted="user_asserted")
            self._checkpoint()
            return
        # Put the continuing guide behind the system installer, so Back returns
        # to the local page instead of covering the consent dialog afterward.
        self._open_onboarding(self.options.get("onboarding_url") or self.options.get("ca_url"))
        directory = Path(self.options.get("state_dir", ".capture-setup")).expanduser().resolve()
        directory.mkdir(parents=True, exist_ok=True)
        local = directory / ("android-public-ca-" + fingerprint[:16] + ".crt")
        if local.is_symlink() or local.exists() and local.read_bytes() != public:
            raise AndroidSetupError("ANDROID_CA_PATH_CONFLICT", "Public certificate output path already contains different data")
        local.write_bytes(public)
        remote = "/sdcard/Download/bfs-capture-ca-" + uuid.uuid4().hex + ".crt"
        exists = self._shell("test", "-e", remote, optional=True)
        if exists.returncode == 0:
            raise AndroidSetupError("ANDROID_CA_PATH_CONFLICT", "The device certificate staging path already exists")
        ca.update(remote_file=remote, remote_file_owned=True, push_intended=True)
        self._checkpoint()
        pushed = self._adb("push", str(local), remote, optional=True)
        if pushed.returncode == 0:
            ca.update(push_intended=False, pushed=True, installer_intended=True)
            self._checkpoint()
            opened = self._shell("am", "start", "-a", "android.intent.action.VIEW", "-d", "file://" + remote,
                                 "-t", "application/x-x509-ca-cert", optional=True)
            ca["installer_requested"] = opened.returncode == 0 and not re.search(r"Error:|Exception", opened.stdout + " " + opened.stderr)
            ca["installer_intended"] = False
            self._checkpoint()
        else:
            ca["push_failed"] = True
        if not ca.get("installer_requested"):
            ca["settings_intended"] = True
            self._checkpoint()
            opened = self._shell("am", "start", "-a", "android.settings.SECURITY_SETTINGS", optional=True)
            ca["settings_requested"] = opened.returncode == 0 and not re.search(r"Error:|Exception", opened.stdout + " " + opened.stderr)
            ca["settings_intended"] = False
            self._checkpoint()
        ca["actions"] = ["Confirm installation of this CA in Android Security settings; choose the staged Download certificate",
                         "Opening an installer does not prove user-CA trust or acceptance by the target App"]

    def _launch_app(self, metadata):
        package = metadata.get("package_name")
        if not package or self.options.get("no_launch"):
            return
        activity = metadata.get("launcher_activity")
        if activity:
            component = activity if "/" in activity else package + "/" + activity
        else:
            output = self._shell("cmd", "package", "resolve-activity", "--brief", "-a", "android.intent.action.MAIN",
                                 "-c", "android.intent.category.LAUNCHER", package).stdout
            components = [line.strip() for line in output.splitlines() if "/" in line]
            if not components:
                raise AndroidSetupError("ANDROID_LAUNCH_FAILED", "No launcher activity was resolved")
            component = components[-1]
        if not re.fullmatch(r"[A-Za-z0-9_.$]+/[A-Za-z0-9_.$]+", component) or component.split("/", 1)[0] != package:
            raise AndroidSetupError("ANDROID_LAUNCH_FAILED", "Launcher component does not belong to the selected App")
        self.state["app"]["launch_intended"] = True
        self._checkpoint()
        launched = self._shell("am", "start", "-n", component)
        if re.search(r"Error:|Exception", launched.stdout + " " + launched.stderr):
            raise AndroidSetupError("ANDROID_LAUNCH_FAILED", "Android rejected the selected launcher")
        self.state["app"].update(launched=True, launch_intended=False)
        self._checkpoint()

    def apply(self):
        plan = self.plan()
        if plan["status"] != "ready":
            raise AndroidSetupError(plan["code"], "Android requires the action reported by plan()")
        metadata = self._artifact()
        self.state = {"version": 1, "platform": "android", "device": self.device, "status": "applying",
                      "reverse": {"owned": False}, "proxy_intended": False,
                      "app": {"installed_by_run": False, "launched": False, "package_name": metadata.get("package_name"),
                              "launcher_activity": metadata.get("launcher_activity")},
                      "limitations": LIMITATIONS.copy()}
        self._checkpoint()
        try:
            if metadata.get("artifact") and not self.options.get("no_install"):
                self.state["app"]["install_intended"] = True
                self._checkpoint()
                result = self._adb("install", "-r", metadata["artifact"], timeout=120, optional=True)
                if result.returncode or re.search(r"Failure\s*\[|Error:", result.stdout):
                    raise AndroidSetupError("ANDROID_INSTALL_FAILED", "APK installation failed; existing data was not cleared or uninstalled")
                self.state["app"].update(installed_by_run=True, install_intended=False)
                self._checkpoint()
            self._configure_proxy()
            self._prepare_ca()
            if self.options.get("launch", True):
                self._launch_app(metadata)
            self.state["status"] = "action_required" if self.state["ca"]["status"] == "manual_confirmation_required" else "ready"
            self._checkpoint()
            return self.state
        except Exception as exc:
            self.state["status"] = "failed"
            self.state["rollback"] = self.restore(self.state)
            if isinstance(exc, AndroidSetupError):
                exc.state = self.state
                raise
            raise AndroidSetupError("ANDROID_SETUP_FAILED", "Android preparation failed; see rollback state", self.state) from None

    def launch(self, state=None):
        """Launch after the coordinator's TLS/user-consent readiness check."""
        state = self.state if state is None else state
        if not isinstance(state, dict) or state.get("platform") != "android" or state.get("version") != 1 or not isinstance(state.get("app"), dict):
            raise AndroidSetupError("ANDROID_STATE_INVALID", "Android launch state has an unsupported format")
        self.device, self.state = state.get("device"), state
        package = state["app"].get("package_name")
        if package is not None and (not isinstance(package, str) or not PACKAGE.fullmatch(package)):
            raise AndroidSetupError("ANDROID_PACKAGE_INVALID", "Stored Android package identifier is invalid", state)
        try:
            self._launch_app(state["app"])
            return state
        except AndroidSetupError as exc:
            state["status"] = "failed"
            state["rollback"] = self.restore(state)
            exc.state = state
            raise

    def restore(self, state=None, remove_ca=False):
        previous = getattr(self, "_recovering", False)
        self._recovering = True
        try:
            return self._restore(state, remove_ca)
        finally:
            self._recovering = previous

    def _restore(self, state=None, remove_ca=False):
        state = self.state if state is None else state
        if not isinstance(state, dict) or state.get("platform") != "android" or state.get("version") != 1:
            raise AndroidSetupError("ANDROID_STATE_INVALID", "Android recovery state has an unsupported format")
        self.device, self.state = state.get("device"), state
        if not isinstance(self.device, str) or not SERIAL.fullmatch(self.device):
            raise AndroidSetupError("ANDROID_STATE_INVALID", "Android recovery serial is invalid")
        if state.get("proxy_intended") and (not isinstance(state.get("proxy_before"), dict)
                                               or state.get("proxy_after") is not None and not isinstance(state["proxy_after"], dict)):
            raise AndroidSetupError("ANDROID_STATE_INVALID", "Android proxy recovery state is invalid")
        result = {"proxy": "not_changed", "reverse": "not_created", "certificate_file": "not_created", "ca_trust": "retained", "app": "not_removed"}
        if state.get("proxy_intended"):
            try:
                current, before = self._settings(), state["proxy_before"]
                after = state.get("proxy_after")
                intent = state.get("restore_intent")
                if isinstance(after, dict) and isinstance(intent, dict):
                    key = intent.get("key")
                    if key in PROXY_KEYS and current.get(key) == before.get(key) and all(current.get(other) == after.get(other) for other in PROXY_KEYS if other != key):
                        after = current
                if after is None:
                    # A lost ACK can leave the write applied. Only claim recovery
                    # when all other fields remain consistent with this write.
                    consistent = current["http_proxy"] == state["proxy_target"] and current["global_proxy_pac_url"] == before["global_proxy_pac_url"]
                    consistent &= current["global_http_proxy_host"] in {before["global_http_proxy_host"], state.get("proxy_host")}
                    consistent &= current["global_http_proxy_port"] in {before["global_http_proxy_port"], str(state.get("proxy_device_port"))}
                    consistent &= current["global_http_proxy_exclusion_list"] in {before["global_http_proxy_exclusion_list"], ""}
                    after = current if consistent else None
                if current == before:
                    result["proxy"] = "already_restored"
                elif after is None or any(current.get(k) != after.get(k) for k in PROXY_KEYS):
                    result["proxy"] = "changed_externally_not_overwritten"
                else:
                    for key in PROXY_KEYS:
                        if before.get(key) == after.get(key):
                            continue
                        value = before.get(key)
                        state["restore_intent"] = {"key": key, "value": value}
                        self._checkpoint()
                        self._shell("settings", "delete", "global", key) if value is None else self._shell("settings", "put", "global", key, value)
                        state["proxy_after"] = self._settings()
                        state.pop("restore_intent", None)
                        self._checkpoint()
                    if self._settings() != before:
                        raise AndroidSetupError("ANDROID_PROXY_RESTORE_FAILED", "Proxy restoration could not be verified")
                    result["proxy"] = "restored"
            except (AndroidSetupError, KeyError, TypeError):
                result["proxy"] = "restore_failed"
        mapping = state.get("reverse", {})
        if not isinstance(mapping, dict):
            raise AndroidSetupError("ANDROID_STATE_INVALID", "Android reverse recovery state is invalid")
        if mapping.get("owned"):
            try:
                left, right = f'tcp:{int(mapping["device_port"])}', f'tcp:{int(mapping["host_port"])}'
                mappings = [line.split()[-2:] for line in self._adb("reverse", "--list").stdout.splitlines()]
                if [left, right] in mappings:
                    mapping["removal_intended"] = True
                    self._checkpoint()
                    self._adb("reverse", "--remove", left)
                    mapping.update(owned=False, removed=True, removal_intended=False)
                    self._checkpoint()
                    result["reverse"] = "removed"
                else:
                    result["reverse"] = "changed_externally_not_removed"
            except (AndroidSetupError, KeyError, TypeError, ValueError):
                result["reverse"] = "remove_failed"
        if mapping.get("intended") and not mapping.get("owned"):
            result["reverse"] = "pending_creation_requires_review"
        ca = state.get("ca", {})
        if not isinstance(ca, dict):
            raise AndroidSetupError("ANDROID_STATE_INVALID", "Android CA recovery state is invalid")
        remote = ca.get("remote_file")
        if ca.get("remote_file_owned") and isinstance(remote, str) and REMOTE_CERT.fullmatch(remote):
            try:
                output = self._shell("sha256sum", remote, optional=True)
                if output.returncode == 0 and output.stdout.split()[0].lower() == ca.get("sha256"):
                    ca["file_removal_intended"] = True
                    self._checkpoint()
                    self._shell("rm", "--", remote)
                    ca.update(remote_file_owned=False, removed=True, file_removal_intended=False)
                    self._checkpoint()
                    result["certificate_file"] = "removed"
                elif self._shell("test", "-e", remote, optional=True).returncode:
                    result["certificate_file"] = "already_absent"
                else:
                    result["certificate_file"] = "changed_or_unverified_not_removed"
            except (AndroidSetupError, IndexError):
                result["certificate_file"] = "remove_failed"
        if remove_ca and ca.get("sha256"):
            try:
                self._shell("am", "start", "-a", "android.settings.SECURITY_SETTINGS", optional=True)
                result["ca_trust"] = "manual_removal_required"
                result["ca_sha256"] = ca["sha256"]
                result["actions"] = ["Remove only this project CA from Android's user credentials; do not clear all credentials"]
            except AndroidSetupError:
                result["ca_trust"] = "manual_removal_required"
        state["cleanup"] = result
        self._checkpoint()
        if state.get("checkpoint_error"):
            result["checkpoint"] = "write_failed_recovery_kept_in_memory"
        return result
