#!/usr/bin/env python3
"""Exercise only this repository's synthetic debug APK on a dedicated device.

Example (already booted dedicated emulator):
  PYTHONPATH=apk_tools python apk_tools/examples/device_e2e.py \
    --apk /path/to/demo.apk --inventory /path/to/inventory --device emulator-5554 \
    --adb-port 5038 --out output-apk-demo/device-e2e.json

The helper taps exactly the fixture's two HTTP buttons.  It refuses other package
names, starts only a loopback mock API, and leaves device/proxy cleanup to
apk_verify.  It neither roots devices nor patches APKs.
"""
from __future__ import annotations

import argparse
import http.server
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

from apk_inventory.reconcile import atomic_json, sha256_file


class MockAPI(http.server.BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *args):
        pass

    def handle_fixture(self):
        body = self.rfile.read(min(int(self.headers.get("Content-Length", "0")), 32768))
        self.requests.append({"method": self.command, "path": self.path, "body_bytes": len(body)})
        output = json.dumps({"items": [{"id": "fixture", "name": "Local fixture"}], "method": self.command}).encode()
        self.send_response(200 if self.command == "GET" else 201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(output)))
        self.end_headers()
        self.wfile.write(output)

    do_GET = do_POST = handle_fixture


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", required=True, type=Path)
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--device", required=True)
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--adb-port", type=int, default=5037)
    parser.add_argument("--mitmdump", default="mitmdump")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--api-port", type=int, default=8765)
    args = parser.parse_args()
    descriptor = json.loads((args.inventory / "source.json").read_text())
    package = descriptor.get("app", {}).get("package_name")
    if package != "com.example.inventorydemo":
        raise SystemExit("This helper only automates the repository's com.example.inventorydemo fixture")
    if descriptor.get("app", {}).get("apk_sha256") != sha256_file(args.apk):
        raise SystemExit("APK hash does not match the extraction directory")
    env = os.environ.copy()
    env["ADB_SERVER_SOCKET"] = "tcp:127.0.0.1:" + str(args.adb_port)
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])

    def adb(*values, timeout=20):
        command = [args.adb, "-P", str(args.adb_port), "-s", args.device, *values]
        return subprocess.check_output(command, text=True, stderr=subprocess.STDOUT, timeout=timeout).strip()

    def shell(*values):
        return adb("shell", shlex.join(values))

    if adb("get-state") != "device":
        raise SystemExit("Dedicated test device is not online and authorized")
    proxy_before = shell("settings", "get", "global", "http_proxy")
    scope_path = args.out.with_suffix(".scope.json")
    atomic_json(scope_path, {"origins": ["http://127.0.0.1:" + str(args.api_port)]})
    with socket.socket() as temporary:
        temporary.bind(("127.0.0.1", 0))
        proxy_port = temporary.getsockname()[1]
    MockAPI.requests = []
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.api_port), MockAPI)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    session = "device_" + uuid.uuid4().hex
    command = [sys.executable, "-m", "apk_inventory.verify", str(args.apk.resolve()), "--inventory", str(args.inventory.resolve()),
               "--device", args.device, "--adb", args.adb, "--mitmdump", args.mitmdump,
               "--proxy", str(proxy_port), "--scope", str(scope_path.resolve()), "--duration", "20s",
               "--isolated-device", "--session-id", session]
    child = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    ui_path = "/sdcard/inventory-fixture-" + uuid.uuid4().hex + ".xml"
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError("apk_verify stopped: " + child.communicate()[0])
            resumed = shell("dumpsys", "activity", "activities")
            if any(package in line for line in resumed.splitlines() if "topResumedActivity" in line or "mResumedActivity" in line):
                break
            time.sleep(.2)
        else:
            raise RuntimeError("Fixture activity was not resumed")
        # Explicit fixture-only intent configuration avoids depending on a fixed proxy port.
        shell("am", "force-stop", package)
        shell("am", "start", "-n", package + "/.DemoActivity", "--es", "base_url", "http://127.0.0.1:" + str(args.api_port),
              "--es", "proxy_host", "10.0.2.2" if args.device.startswith("emulator-") else "127.0.0.1",
              "--ei", "proxy_port", str(proxy_port))
        time.sleep(.5)
        for wanted in ("GET /items", "POST /items"):
            shell("uiautomator", "dump", ui_path)
            tree = ET.fromstring(shell("cat", ui_path))
            target = next((node for node in tree.iter("node") if node.get("text") == wanted and node.get("package") == package), None)
            if target is None:
                raise RuntimeError("Fixture button is not visible: " + wanted)
            numbers = list(map(int, re.findall(r"\d+", target.get("bounds", ""))))
            if len(numbers) != 4:
                raise RuntimeError("Fixture button bounds are unavailable")
            shell("input", "tap", str((numbers[0] + numbers[2]) // 2), str((numbers[1] + numbers[3]) // 2))
            expected = 1 if wanted.startswith("GET") else 2
            request_deadline = time.monotonic() + 5
            while len(MockAPI.requests) < expected and time.monotonic() < request_deadline:
                time.sleep(.05)
            if len(MockAPI.requests) < expected:
                raise RuntimeError("Fixture request did not reach the local mock API")
        stdout, stderr = child.communicate(timeout=30)
        if child.returncode:
            raise RuntimeError("apk_verify failed: " + stdout)
        summary = json.loads(stdout)
        report = json.loads(Path(summary["report"]).read_text())
        inventory = json.loads(Path(summary["inventory"]).read_text())
        observed = [row for row in inventory if "observed" in row.get("categories", [])]
        methods = {row["method"] for row in observed}
        if not {"GET", "POST"}.issubset(methods):
            raise RuntimeError("Both fixture methods were not observed")
        proxy_after = shell("settings", "get", "global", "http_proxy")
        if proxy_after != proxy_before:
            raise RuntimeError("Device proxy was not restored")
        result = {"status": "passed", "real_device": True, "device": args.device,
                  "android_api": shell("getprop", "ro.build.version.sdk"),
                  "shell_identity": shell("id"), "apk_sha256": sha256_file(args.apk),
                  "fixture_package": package, "mock_requests": MockAPI.requests,
                  "observed_methods": sorted(methods), "verification": report,
                  "inventory": summary["inventory"], "proxy_restored": True}
        atomic_json(args.out, result)
        print(json.dumps({"status": "passed", "report": str(args.out), "observed_methods": sorted(methods), "proxy_restored": True}))
    finally:
        if child.poll() is None:
            child.terminate()
            child.communicate(timeout=12)
        try:
            shell("rm", "-f", ui_path)
        except (subprocess.SubprocessError, OSError):
            pass
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
