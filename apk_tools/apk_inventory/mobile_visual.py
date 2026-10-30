"""Capture a private screenshot from an already trusted mobile device session."""
import argparse
import base64
import binascii
from datetime import datetime, timezone
import hashlib
import json
import os
import select
import signal
import subprocess
import sys
import time
from pathlib import Path
from .mobile_ui import AdbBackend, DeviceLease, MobileError, MobileSession

MAX_IMAGE = 16 * 1024 * 1024

def _safe_dir(path):
    path = Path(os.path.abspath(path))
    for item in [*reversed(path.parents), path]:
        if item.is_symlink():
            raise MobileError('VISUAL_PATH_REJECTED', 'blocked')
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not path.is_dir():
        raise MobileError('VISUAL_PATH_REJECTED', 'blocked')
    return path

def _adb_png(backend):
    backend.budget.check()
    try:
        child = subprocess.Popen([backend.executable, '-s', backend.device, 'exec-out', 'screencap', '-p'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        raise MobileError('ADB_UNAVAILABLE', 'needs_device') from None
    chunks, size, completed = [], 0, False
    try:
        # Establish the deadline inside the ownership scope: if the budget
        # expires immediately after spawn, the child still must be reaped.
        deadline = time.monotonic() + backend.budget.timeout()
        while True:
            backend.budget.check()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise MobileError('VISUAL_CAPTURE_TIMEOUT', 'partial')
            ready, _, _ = select.select([child.stdout], [], [], min(.1, remaining))
            if not ready:
                continue
            block = os.read(child.stdout.fileno(), 65536)
            if not block:
                break
            size += len(block)
            if size > MAX_IMAGE:
                raise MobileError('VISUAL_IMAGE_LIMIT', 'blocked')
            chunks.append(block)
        if child.wait(timeout=max(.001, deadline-time.monotonic())) != 0:
            raise MobileError('VISUAL_CAPTURE_FAILED', 'needs_device')
        completed = True
        return b''.join(chunks)
    finally:
        if not completed:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        if child.poll() is None:
            child.kill()
        child.wait()
        child.stdout.close()

def capture(config, output):
    session = MobileSession(config, _safe_dir(output))
    if isinstance(session.backend, AdbBackend) and not session.backend.device:
        raise MobileError('DEVICE_SELECTION_REQUIRED', 'needs_device')
    with DeviceLease(session.backend) as lease:
        return capture_locked(session, output, lease)


def capture_locked(session, output, lease):
    """Capture only while the caller owns this exact backend's lease."""
    if not isinstance(lease, DeviceLease) or lease.backend is not session.backend or lease.stream is None or lease.stream.closed:
        raise MobileError('DEVICE_LEASE_REQUIRED', 'blocked')
    output = _safe_dir(output)
    backend = session.backend
    if isinstance(backend, AdbBackend) and not backend.device:
        raise MobileError('DEVICE_SELECTION_REQUIRED', 'needs_device')
    # Screenshot observation does not require the optional input method.
    # Probe device identity without activating or requiring that transport.
    if isinstance(backend, AdbBackend):
        unicode_input = backend.unicode_input
        backend.unicode_input = None
        try:
            backend.probe()
        finally:
            backend.unicode_input = unicode_input
    # W3C foreground verification below is a live session check.  Do not
    # require /source: visual observation must work when no semantic tree
    # is provided or the hierarchy endpoint is unsupported.
    backend.verify_artifact()
    backend.foreground()
    if isinstance(backend, AdbBackend):
        data = _adb_png(backend)
    else:
        value = backend.request('GET', '/screenshot')
        if not isinstance(value, str) or len(value) > ((MAX_IMAGE + 2) // 3) * 4:
            raise MobileError('VISUAL_IMAGE_LIMIT', 'blocked')
        try:
            data = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError):
            raise MobileError('VISUAL_IMAGE_INVALID', 'blocked') from None
    captured_at = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    if len(data) > MAX_IMAGE or len(data) < 33 or data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR':
        raise MobileError('VISUAL_IMAGE_INVALID', 'blocked')
    width, height = int.from_bytes(data[16:20], 'big'), int.from_bytes(data[20:24], 'big')
    if not width or not height or width > 16384 or height > 16384 or width * height > 16000000:
        raise MobileError('VISUAL_IMAGE_LIMIT', 'blocked')
    backend.foreground()
    backend.verify_artifact()
    session.budget.check()
    target = output / 'screenshot.png'
    try:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
    except FileExistsError:
        raise MobileError('VISUAL_PATH_REJECTED', 'blocked') from None
    return {'schemaVersion': 1, 'source': session.source, 'provenance': 'device_screenshot', 'untrusted': True, 'coordinateSpace': 'image_pixels', 'capturedAt': captured_at, 'width': width, 'height': height, 'imageSha256': hashlib.sha256(data).hexdigest(), 'imagePath': str(target), 'artifactVerification': backend.artifact_verification, 'appArtifactVerified': backend.artifact_verification.get('status') == 'verified', 'gaps': ['screenshot_does_not_identify_controls', 'screenshot_does_not_verify_business_outcomes', 'screenshot_may_include_system_ui_or_other_windows', *([] if backend.artifact_verification.get('status') == 'verified' else ['app_artifact_not_verified'])]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    def stop(_signum, _frame):
        raise MobileError('STOPPED', 'partial')
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        config_path = Path(args.config)
        if config_path.is_symlink() or not config_path.is_file() or config_path.stat().st_size > 1048576:
            raise MobileError('CONFIG_INVALID', 'blocked')
        result = capture(json.loads(config_path.read_text()), args.output)
        print(json.dumps(result, ensure_ascii=False))
    except (MobileError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(json.dumps({'ok': False, 'error': {'code': getattr(error, 'code', 'VISUAL_CAPTURE_FAILED'), 'status': getattr(error, 'status', 'failed')}}))
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
