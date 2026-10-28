"""apk_verify: passive device capture or reproducible observation/HAR import."""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from .reconcile import (VerificationError, atomic_json, finalize_inventory, har_events,
                        iter_jsonl, normalize_url, origin, read_json, sha256_file,
                        utc_now, within)


def parse_duration(value: str) -> float:
    match = re.fullmatch(r"(\d+(?:\.\d+)?)(ms|s|m|h)?", value)
    if not match:
        raise argparse.ArgumentTypeError("Duration must look like 30s or 5m")
    seconds = float(match[1]) * {"ms": .001, "s": 1, "m": 60, "h": 3600, None: 1}[match[2]]
    if not .01 <= seconds <= 43200:
        raise argparse.ArgumentTypeError("Duration must be between 10ms and 12h")
    return seconds


def load_scope(path: Path | None, static: list[dict[str, Any]]) -> set[str]:
    if path is None:
        result = set()
        for item in static:
            try:
                result.add(origin(normalize_url(item["url"])[0]))
            except (VerificationError, KeyError, TypeError):
                pass
        return result
    try:
        if path.stat().st_size > 1024 * 1024:
            raise VerificationError("SCOPE_INVALID", "Scope configuration exceeds its byte budget")
        text = path.read_text(encoding="utf-8")
        if len(text.encode("utf-8")) > 1024 * 1024:
            raise VerificationError("SCOPE_INVALID", "Scope configuration exceeds its byte budget")
        try:
            value = json.loads(text)
        except ValueError:
            try:
                import yaml
            except ImportError:
                raise VerificationError("DEPENDENCY_MISSING", "YAML scope needs the verify optional dependencies; JSON scope is also accepted") from None
            value = yaml.safe_load(text)
        entries = value.get("origins", value.get("allowed_origins")) if isinstance(value, dict) else value
        if not isinstance(entries, list) or not all(isinstance(entry, str) for entry in entries):
            raise VerificationError("SCOPE_INVALID", "Scope must contain an origins array")
        result = set()
        for entry in entries:
            base, query = normalize_url(entry)
            if query or base != origin(base) + "/":
                raise VerificationError("SCOPE_INVALID", "Scope entries must be exact HTTP(S) origins")
            result.add(origin(base))
        return result
    except OSError:
        raise VerificationError("SCOPE_INVALID", "Scope configuration could not be read") from None


class DeviceCapture:
    """Own only the proxy setting and reverse mapping created by this run."""
    def __init__(self, args: argparse.Namespace, package: str, directory: Path, session_id: str, scope: set[str]):
        self.args, self.package, self.directory, self.session_id, self.scope = args, package, directory, session_id, scope
        self.device = args.device
        self.child: subprocess.Popen | None = None
        self.previous_proxy: str | None = None
        self.proxy_value: str | None = None
        self.reverse_port: int | None = None
        self.proxy_owned = False
        self.cleanup: dict[str, Any] = {"proxy": "not_changed", "reverse": "not_created", "process": "not_started"}
        self.diagnostics: list[str] = []
        self.capture_started: float | None = None
        self.duration_captured = 0.0
        self.interrupted = False
        self.events_path = directory / "verified" / session_id / "capture.events.jsonl"

    def _command(self, command: list[str], timeout: float = 30) -> str:
        try:
            result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise VerificationError("DEVICE_COMMAND_FAILED", "A required capture tool failed or timed out") from None
        if result.returncode:
            raise VerificationError("DEVICE_COMMAND_FAILED", "A required capture command was rejected")
        return result.stdout.strip()

    def _adb(self, *args: str, timeout: float = 30) -> str:
        return self._command([self.args.adb, "-s", self.device, *args], timeout)

    def _shell(self, *args: str) -> str:
        # adb shell joins its arguments through the Android shell. Quote every value.
        return self._adb("shell", shlex.join(args))

    def _settings(self) -> dict[str, str]:
        lines = self._shell("settings", "list", "global").splitlines()
        return dict(line.split("=", 1) for line in lines if "=" in line)

    def preflight(self) -> None:
        for binary in (self.args.adb, self.args.mitmdump):
            if shutil.which(binary) is None:
                raise VerificationError("DEPENDENCY_MISSING", "adb and mitmdump must be installed before live capture")
        if not self.device:
            output = self._command([self.args.adb, "devices"])
            devices = [line.split()[0] for line in output.splitlines()[1:] if len(line.split()) >= 2 and line.split()[1] == "device"]
            if len(devices) != 1:
                raise VerificationError("DEVICE_SELECTION", "Specify --device when exactly one authorized device is not available")
            self.device = devices[0]
        if self._adb("get-state") != "device":
            raise VerificationError("DEVICE_UNAVAILABLE", "Selected device is not online and authorized")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+", self.package):
            raise VerificationError("PACKAGE_INVALID", "Inventory package name is invalid")
        with socket.socket() as listener:
            try:
                listener.bind(("127.0.0.1", self.args.proxy))
            except OSError:
                raise VerificationError("PROXY_PORT_BUSY", "The selected proxy port is unavailable") from None
        if self.args.manage_proxy == "auto":
            settings = self._settings()
            if settings.get("global_proxy_pac_url", "") not in {"", "null"}:
                raise VerificationError("PROXY_CONFIGURATION", "An existing PAC configuration requires --manage-proxy manual")
            self.previous_proxy = settings.get("http_proxy")

    def start_proxy(self) -> None:
        output = self.events_path.parent
        output.mkdir(parents=True, exist_ok=True)
        ready = output / "capture.ready.json"
        if ready.exists():
            raise VerificationError("SESSION_EXISTS", "Capture session already contains ready-state evidence")
        config_path = output / "capture.config.json"
        atomic_json(config_path, {"output": str(self.events_path), "ready": str(ready), "session_id": self.session_id,
                                 "package_name": self.package, "origins": sorted(self.scope),
                                 "attribution": "isolated_session" if self.args.isolated_device else "unattributed",
                                 "body_limit": self.args.body_limit})
        env = os.environ.copy()
        env["APK_VERIFY_CONFIG"] = str(config_path)
        addon = Path(__file__).with_name("mitm_addon.py")
        # A stable CA directory allows the tester to install its public certificate once.
        confdir = Path(self.args.ca_dir).expanduser().resolve() if self.args.ca_dir else self.directory / ".mitmproxy"
        confdir.mkdir(parents=True, exist_ok=True)
        command = [self.args.mitmdump, "--mode", "regular", "--listen-host", getattr(self.args, "listen_host", "127.0.0.1"), "--listen-port", str(self.args.proxy),
                   "-q", "-s", str(addon), "--set", "flow_detail=0", "--set", "store_streamed_bodies=false",
                   "--set", "confdir=" + str(confdir)]
        try:
            self.child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                          stderr=subprocess.DEVNULL, env=env)
        except OSError:
            raise VerificationError("PROXY_START_FAILED", "mitmdump could not be started") from None
        self.cleanup["process"] = "running"
        deadline = time.monotonic() + self.args.ready_timeout
        while time.monotonic() < deadline:
            if self.child.poll() is not None:
                raise VerificationError("PROXY_START_FAILED", "mitmdump exited before capture-ready")
            if ready.is_file():
                value = read_json(ready, 65536)
                if value.get("session_id") == self.session_id and value.get("event") == "capture_ready":
                    return
            time.sleep(.05)
        raise VerificationError("PROXY_READY_TIMEOUT", "mitmdump did not confirm capture-ready")

    def configure_device(self) -> None:
        if self.args.manage_proxy == "manual":
            self.diagnostics.append("MANUAL_DEVICE_PROXY_MUST_ALREADY_BE_CONFIGURED")
            return
        host = self.args.proxy_host
        if not host and self.device.startswith("emulator-"):
            host = "10.0.2.2"
        if not host:
            port = self.args.proxy
            mappings = self._adb("reverse", "--list")
            occupied = {int(value) for value in re.findall(r"tcp:(\d+)", mappings)}
            while port in occupied:
                port += 1
                if port > 65535:
                    raise VerificationError("REVERSE_UNAVAILABLE", "No device-side proxy port is available")
            self._adb("reverse", "--no-rebind", "tcp:" + str(port), "tcp:" + str(self.args.proxy))
            self.reverse_port = port
            self.cleanup["reverse"] = "created"
            host = "127.0.0.1"
        else:
            port = self.args.proxy
        if not re.fullmatch(r"[A-Za-z0-9.:[\]_-]+", host):
            raise VerificationError("PROXY_HOST_INVALID", "Device-visible proxy host is invalid")
        self.proxy_value = host + ":" + str(port)
        # Mark intent before writing: an adb transport failure can lose the ACK
        # after Android has already changed the setting. close() compares values.
        self.proxy_owned = True
        self._shell("settings", "put", "global", "http_proxy", self.proxy_value)
        if self._settings().get("http_proxy") != self.proxy_value:
            raise VerificationError("PROXY_CONFIGURATION", "Device did not retain the requested system proxy setting")
        self.cleanup["proxy"] = "changed"

    def start_app(self, apk: Path, descriptor: dict[str, Any]) -> None:
        if not self.args.no_install:
            try:
                self._adb("install", "-r", str(apk), timeout=120)
            except VerificationError:
                raise VerificationError("APP_INSTALL_FAILED", "APK installation failed; no existing application was uninstalled or cleared") from None
        elif not self._shell("pm", "path", self.package).startswith("package:"):
            raise VerificationError("APP_NOT_INSTALLED", "The selected package is not installed")
        if self.args.no_launch:
            self.diagnostics.append("APP_LAUNCH_MANUAL")
            return
        app = descriptor.get("app", {})
        activity = app.get("launchable_activity") or app.get("main_activity") or app.get("launcher_activity")
        if activity:
            activity = str(activity)
            component = activity if "/" in activity else self.package + "/" + activity
        else:
            resolved = self._shell("cmd", "package", "resolve-activity", "--brief", "-a", "android.intent.action.MAIN",
                                   "-c", "android.intent.category.LAUNCHER", self.package)
            components = [line.strip() for line in resolved.splitlines() if "/" in line]
            if not components:
                raise VerificationError("APP_LAUNCH_FAILED", "No launcher component was resolved; use --no-launch for manual startup")
            component = components[-1]
        if not re.fullmatch(r"[A-Za-z0-9_.$]+/[A-Za-z0-9_.$]+", component) or component.split("/", 1)[0] != self.package:
            raise VerificationError("APP_LAUNCH_FAILED", "Resolved launcher component is invalid")
        result = self._shell("am", "start", "-n", component)
        if "Error:" in result or "Exception" in result:
            raise VerificationError("APP_LAUNCH_FAILED", "Android rejected the launcher component")

    def capture(self) -> None:
        self.capture_started = time.monotonic()
        deadline = self.capture_started + self.args.duration
        print("采集已开始，请人工操作测试 App；HTTPS 需要 App 信任本轮测试 CA。", file=sys.stderr)
        if not self.args.isolated_device:
            self.diagnostics.append("DEVICE_ISOLATION_NOT_ASSERTED_FLOWS_UNATTRIBUTED")
        while time.monotonic() < deadline:
            if self.child is None or self.child.poll() is not None:
                raise VerificationError("PROXY_EXITED", "mitmdump exited during capture")
            time.sleep(min(.1, max(0, deadline - time.monotonic())))
        self.duration_captured = time.monotonic() - self.capture_started

    def close(self) -> None:
        if self.capture_started is not None:
            self.duration_captured = time.monotonic() - self.capture_started
        if self.child is not None:
            try:
                if self.child.poll() is None:
                    self.child.send_signal(signal.SIGINT)
                    try:
                        self.child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        self.child.terminate()
                        try:
                            self.child.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            self.child.kill()
                            self.child.wait(timeout=2)
                self.cleanup["process"] = "stopped"
            except (OSError, subprocess.TimeoutExpired):
                self.cleanup["process"] = "stop_failed"
                self.diagnostics.append("PROXY_PROCESS_STOP_FAILED")
        if self.proxy_owned:
            try:
                current = self._settings().get("http_proxy")
                if current != self.proxy_value:
                    self.cleanup["proxy"] = "changed_externally_not_overwritten"
                elif self.previous_proxy is None:
                    self._shell("settings", "delete", "global", "http_proxy")
                    self.cleanup["proxy"] = "restored"
                else:
                    self._shell("settings", "put", "global", "http_proxy", self.previous_proxy)
                    self.cleanup["proxy"] = "restored"
            except VerificationError:
                self.cleanup["proxy"] = "restore_failed"
                self.diagnostics.append("DEVICE_PROXY_RESTORE_FAILED")
        if self.reverse_port is not None:
            try:
                mappings = self._adb("reverse", "--list")
                owned = any(line.split()[-2:] == ["tcp:" + str(self.reverse_port), "tcp:" + str(self.args.proxy)]
                            for line in mappings.splitlines())
                if owned:
                    self._adb("reverse", "--remove", "tcp:" + str(self.reverse_port))
                    self.cleanup["reverse"] = "removed"
                else:
                    self.cleanup["reverse"] = "changed_externally_not_removed"
            except VerificationError:
                self.cleanup["reverse"] = "remove_failed"
                self.diagnostics.append("DEVICE_REVERSE_CLEANUP_FAILED")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Capture an authorized APK's real HTTP traffic without root, or import observations/HAR")
    result.add_argument("apk", type=Path)
    result.add_argument("--inventory", type=Path, help="apk_extract output directory")
    result.add_argument("--duration", type=parse_duration, default=300.0)
    result.add_argument("--proxy", type=int, default=8080, help="Host mitmdump listening port")
    result.add_argument("--device")
    result.add_argument("--scope", type=Path, help="JSON/YAML with exact origins")
    imports = result.add_mutually_exclusive_group()
    imports.add_argument("--observations", type=Path, help="Import collector JSONL without operating a device")
    imports.add_argument("--har", type=Path, help="Import HTTP HAR without operating a device")
    result.add_argument("--isolated-device", action="store_true", help="Assert this run uses a dedicated isolated test device/session")
    result.add_argument("--manage-proxy", choices=["auto", "manual"], default="auto")
    result.add_argument("--proxy-host", help="Proxy host visible to the device; physical USB devices default to adb reverse")
    result.add_argument("--ca-dir", help="mitmproxy confdir containing the test CA; default inventory/.mitmproxy")
    result.add_argument("--no-install", action="store_true")
    result.add_argument("--no-launch", action="store_true")
    result.add_argument("--adb", default="adb")
    result.add_argument("--mitmdump", default="mitmdump")
    result.add_argument("--ready-timeout", type=float, default=15.0)
    result.add_argument("--body-limit", type=int, default=32768)
    result.add_argument("--session-id", help=argparse.SUPPRESS)
    return result


def verify(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    apk = args.apk.expanduser().resolve()
    if not apk.is_file():
        raise VerificationError("APK_INVALID", "APK must be a readable regular file")
    apk_hash = sha256_file(apk)
    directory = args.inventory.expanduser().resolve() if args.inventory else Path(".apk-inventory", apk_hash[:16]).resolve()
    if not (directory / "source.json").is_file():
        from .extract import extract_apk
        extract_apk(apk, directory)
    descriptor = read_json(directory / "source.json")
    if descriptor.get("app", {}).get("apk_sha256") != apk_hash:
        raise VerificationError("APK_MISMATCH", "APK hash does not match the extraction inventory")
    baseline = read_json(within(directory, descriptor.get("static_inventory", "endpoints.static.json")))
    if not isinstance(baseline, list):
        raise VerificationError("INVENTORY_INVALID", "Static inventory must be a JSON array")
    scope = load_scope(args.scope, baseline)
    if not 1 <= args.proxy <= 65535 or not 0 <= args.body_limit <= 1024 * 1024 or not 0 < args.ready_timeout <= 120:
        raise VerificationError("ARGUMENT_INVALID", "Capture port, body budget or ready timeout is invalid")
    session_id = args.session_id or "capture_" + uuid.uuid4().hex
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", session_id):
        raise VerificationError("SESSION_INVALID", "Session identifier has an invalid format")
    if args.observations or args.har:
        events = iter_jsonl(args.observations) if args.observations else har_events(args.har, session_id, "isolated_session" if args.isolated_device else "unattributed")
        summary = finalize_inventory(directory, apk, events, session_id=session_id, allowed_origins=scope,
                                     extra_report={"capture_backend": "observations_import" if args.observations else "har_import", "scope": sorted(scope),
                                                   "cleanup": {"device": "not_operated"}})
        return summary, 0
    package = descriptor.get("app", {}).get("package_name")
    if not isinstance(package, str):
        raise VerificationError("PACKAGE_INVALID", "Inventory does not contain an Android package name")
    capture = DeviceCapture(args, package, directory, session_id, scope)
    failure: VerificationError | None = None
    try:
        capture.preflight()
        capture.start_proxy()
        capture.configure_device()
        capture.start_app(apk, descriptor)
        capture.capture()
    except KeyboardInterrupt:
        capture.interrupted = True
        failure = VerificationError("CAPTURE_INTERRUPTED", "Capture was interrupted; partial observations were preserved")
    except VerificationError as exc:
        failure = exc
    finally:
        capture.close()
    cleanup_failed = any(value in {"restore_failed", "remove_failed", "stop_failed"} for value in capture.cleanup.values())
    if cleanup_failed and failure is None:
        failure = VerificationError("CLEANUP_FAILED", "Capture finished but device cleanup needs attention")
    events = iter_jsonl(capture.events_path) if capture.events_path.is_file() else iter(())
    summary = finalize_inventory(directory, apk, events, session_id=session_id, allowed_origins=scope,
                                 promote=failure is None, extra_report={
                                     "capture_backend": "mitmdump_live", "scope": sorted(scope),
                                     "duration_requested_ms": round(args.duration * 1000),
                                     "duration_captured_ms": round(capture.duration_captured * 1000),
                                     "cleanup": capture.cleanup, "diagnostics": capture.diagnostics,
                                     **({"run_status": "partial", "error": {"code": failure.code, "message": failure.message}} if failure else {})})
    if failure:
        summary["error"] = {"code": failure.code, "message": failure.message}
    return summary, (130 if capture.interrupted else 6) if failure else 0


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    previous_termination = signal.getsignal(signal.SIGTERM)
    def terminate_capture(signum, frame):
        # A second termination request must not interrupt device restoration.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, terminate_capture)
    try:
        summary, code = verify(args)
    except KeyboardInterrupt:
        summary, code = {"status": "partial", "error": {"code": "CAPTURE_INTERRUPTED", "message": "Verification was interrupted"}}, 130
    except VerificationError as exc:
        summary, code = {"status": "failed", "error": {"code": exc.code, "message": exc.message}}, 2
    except (OSError, ValueError, TypeError, KeyError):
        summary, code = {"status": "failed", "error": {"code": "VERIFY_FAILED", "message": "Verification input or output could not be processed"}}, 2
    finally:
        signal.signal(signal.SIGTERM, previous_termination)
    print(json.dumps(summary, ensure_ascii=False, allow_nan=False))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
