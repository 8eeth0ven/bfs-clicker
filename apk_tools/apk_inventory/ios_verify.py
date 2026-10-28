"""iOS observations/HAR reconciliation and manually configured mitmdump capture.

No device installation, signing, proxy changes or process attribution is inferred.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import re
import shutil
import signal
import socket
import sys
import uuid
from pathlib import Path

from .common import InventoryError
from .reconcile import (VerificationError, finalize_inventory, har_events,
                        iter_jsonl, read_json, within)
from .verify import DeviceCapture, load_scope, parse_duration


class ManualIOSCapture(DeviceCapture):
    """Reuse only the proxy lifecycle; never invoke Android/device methods."""

    def preflight(self):
        if shutil.which(self.args.mitmdump) is None:
            raise VerificationError("DEPENDENCY_MISSING", "mitmdump must be installed before live capture")
        if not re.fullmatch(r"[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+", self.package):
            raise VerificationError("BUNDLE_INVALID", "Inventory bundle identifier is invalid")
        address = ipaddress.ip_address(self.args.listen_host)
        family = socket.AF_INET6 if address.version == 6 else socket.AF_INET
        with socket.socket(family) as listener:
            try:
                listener.bind((str(address), self.args.proxy))
            except OSError:
                raise VerificationError("PROXY_PORT_BUSY", "The selected proxy address/port is unavailable") from None
        self.cleanup.update(device="not_operated", proxy="manual_unchanged", reverse="not_created")
        self.diagnostics.extend(["IOS_PROXY_AND_CA_MANUALLY_CONFIGURED", "NO_IOS_PROCESS_ATTRIBUTION"])


def parser():
    result = argparse.ArgumentParser(description="Verify iOS endpoint candidates from HAR/events or a manually configured proxy")
    result.add_argument("artifact", type=Path, help="The same IPA or .app used for extraction")
    result.add_argument("--inventory", type=Path)
    result.add_argument("--duration", type=parse_duration, default=300.0)
    result.add_argument("--proxy", type=int, default=8080)
    result.add_argument("--listen-host", default="127.0.0.1", help="Local numeric bind address; specify your LAN address for a test device")
    result.add_argument("--scope", type=Path)
    imports = result.add_mutually_exclusive_group()
    imports.add_argument("--har", type=Path)
    imports.add_argument("--observations", type=Path)
    result.add_argument("--isolated-device", action="store_true", help="Assert a dedicated isolated test capture; otherwise flows remain unattributed")
    result.add_argument("--mitmdump", default="mitmdump")
    result.add_argument("--ca-dir")
    result.add_argument("--ready-timeout", type=float, default=15.0)
    result.add_argument("--body-limit", type=int, default=32768)
    result.add_argument("--session-id", help=argparse.SUPPRESS)
    return result


def verify(args):
    from .ios import artifact_hash, extract_ios
    artifact = args.artifact.expanduser()
    digest = artifact_hash(artifact)
    artifact = artifact.resolve()
    directory = args.inventory.expanduser().resolve() if args.inventory else Path(".ios-inventory", digest[:16]).resolve()
    if not (directory / "source.json").is_file():
        extract_ios(artifact, directory)
    descriptor = read_json(directory / "source.json")
    if not isinstance(descriptor, dict) or descriptor.get("format") != "endpoint-inventory" or not isinstance(descriptor.get("app"), dict):
        raise VerificationError("INVENTORY_INVALID", "Source descriptor must contain mobile inventory metadata")
    if descriptor.get("kind") != "ios" or descriptor.get("app", {}).get("artifact_sha256") != digest:
        raise VerificationError("ARTIFACT_MISMATCH", "iOS artifact identity does not match this inventory")
    baseline = read_json(within(directory, descriptor.get("static_inventory", "endpoints.static.json")))
    if not isinstance(baseline, list):
        raise VerificationError("INVENTORY_INVALID", "Static inventory must be a JSON array")
    scope = load_scope(args.scope, baseline)
    if not 1 <= args.proxy <= 65535 or not 0 <= args.body_limit <= 1024 * 1024 or not 0 < args.ready_timeout <= 120:
        raise VerificationError("ARGUMENT_INVALID", "Capture port, body budget or ready timeout is invalid")
    try:
        ipaddress.ip_address(args.listen_host)
    except ValueError:
        raise VerificationError("ARGUMENT_INVALID", "Listen host must be a local numeric IP address") from None
    session_id = args.session_id or "capture_" + uuid.uuid4().hex
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", session_id):
        raise VerificationError("SESSION_INVALID", "Session identifier has an invalid format")
    if args.observations or args.har:
        events = iter_jsonl(args.observations) if args.observations else har_events(args.har, session_id, "isolated_session" if args.isolated_device else "unattributed")
        summary = finalize_inventory(directory, artifact, events, session_id=session_id, allowed_origins=scope, source_kind="ios",
                                     extra_report={"capture_backend": "observations_import" if args.observations else "har_import",
                                                   "scope": sorted(scope), "cleanup": {"device": "not_operated"},
                                                   "diagnostics": ["NO_IOS_PROCESS_ATTRIBUTION"]})
        return summary, 0
    # DeviceCapture's constructor needs this field, but no device method is used.
    args.device = None
    capture = ManualIOSCapture(args, descriptor["app"].get("bundle_id", ""), directory, session_id, scope)
    failure = None
    try:
        capture.preflight()
        capture.start_proxy()
        print("请在专用 iOS 测试设备上手动配置代理、信任测试 CA 并运行 App；本工具不更改设备设置。", file=sys.stderr)
        capture.capture()
    except KeyboardInterrupt:
        capture.interrupted = True
        failure = VerificationError("CAPTURE_INTERRUPTED", "Capture was interrupted; partial observations were preserved")
    except VerificationError as exc:
        failure = exc
    finally:
        capture.close()
    if capture.cleanup.get("process") == "stop_failed" and failure is None:
        failure = VerificationError("CLEANUP_FAILED", "Proxy process cleanup needs attention")
    events = iter_jsonl(capture.events_path) if capture.events_path.is_file() else iter(())
    summary = finalize_inventory(directory, artifact, events, session_id=session_id, allowed_origins=scope, source_kind="ios", promote=failure is None,
                                 extra_report={"capture_backend": "mitmdump_manual_ios", "scope": sorted(scope),
                                               "duration_requested_ms": round(args.duration * 1000),
                                               "duration_captured_ms": round(capture.duration_captured * 1000),
                                               "cleanup": capture.cleanup, "diagnostics": capture.diagnostics,
                                               **({"run_status": "partial", "error": {"code": failure.code, "message": failure.message}} if failure else {})})
    if failure:
        summary["error"] = {"code": failure.code, "message": failure.message}
    return summary, (130 if capture.interrupted else 6) if failure else 0


def main(argv=None):
    args = parser().parse_args(argv)
    previous = signal.getsignal(signal.SIGTERM)
    def terminate(signum, frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, terminate)
    try:
        summary, code = verify(args)
    except KeyboardInterrupt:
        summary, code = {"status": "partial", "error": {"code": "CAPTURE_INTERRUPTED", "message": "Verification interrupted"}}, 130
    except (VerificationError, InventoryError) as exc:
        summary, code = {"status": "failed", "error": {"code": exc.code, "message": str(exc)}}, 2
    except (OSError, ValueError, TypeError, KeyError):
        summary, code = {"status": "failed", "error": {"code": "VERIFY_FAILED", "message": "Verification input or output could not be processed"}}, 2
    finally:
        signal.signal(signal.SIGTERM, previous)
    print(json.dumps(summary, ensure_ascii=False, allow_nan=False))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
