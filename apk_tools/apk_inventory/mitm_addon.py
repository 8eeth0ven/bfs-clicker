"""mitmdump passive inventory collector.

Use APK_VERIFY_CONFIG=/absolute/path/capture.json or the apk_* mitm options.
No raw request body or authentication header values are written to disk.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from apk_inventory.reconcile import (CaptureRedactor, VerificationError, atomic_json,
                                     normalize_url, origin, shape, utc_now)

try:
    from mitmproxy import ctx
except ImportError:  # Pure collector tests do not require the optional proxy runtime.
    ctx = None


class BodyCapture:
    def __init__(self, limit: int):
        self.limit = limit
        self.prefix = bytearray()
        self.total = 0

    def tee(self, chunk: bytes) -> bytes:
        self.total += len(chunk)
        if len(self.prefix) < self.limit:
            self.prefix.extend(chunk[:self.limit - len(self.prefix)])
        return chunk

    def describe(self, content_type: str, encoding: str = "") -> dict[str, Any]:
        if self.total == 0:
            return {"body_present": False, "body_capture": "absent"}
        result: dict[str, Any] = {"body_present": True, "body_bytes_seen": self.total}
        if self.total > self.limit:
            return {**result, "body_capture": "truncated"}
        if encoding and encoding.lower() not in {"identity"}:
            return {**result, "body_capture": "unknown", "body_diagnostic": "COMPRESSED_BODY_NOT_DECODED"}
        mime = content_type.split(";", 1)[0].strip().lower()
        try:
            text = self.prefix.decode("utf-8")
            if mime == "application/json" or mime.endswith("+json"):
                return {**result, "body_capture": "shape_only", "body_shape": shape(json.loads(text))}
            if mime == "application/x-www-form-urlencoded":
                properties: dict[str, Any] = {}
                for key, _ in parse_qsl(text, keep_blank_values=True, max_num_fields=1000):
                    properties[key] = {"type": "string"}
                return {**result, "body_capture": "shape_only", "body_shape": {"type": "object", "properties": properties}}
            if mime.startswith("text/"):
                return {**result, "body_capture": "shape_only", "body_shape": {"type": "string"}}
        except (UnicodeError, ValueError):
            pass
        return {**result, "body_capture": "unknown"}


class CaptureAddon:
    def __init__(self, config: dict[str, Any] | None = None):
        self.config = config
        self.stream = None
        self.redactor = CaptureRedactor()
        self.active: dict[str, BodyCapture] = {}
        self.eligible: set[str] = set()
        self.started: dict[str, float] = {}
        self.count = 0
        self.events_written = 0
        self.events_dropped = 0
        self.metadata_warning = False

    def load(self, loader: Any) -> None:
        loader.add_option("apk_output", str, "", "Inventory event JSONL path")
        loader.add_option("apk_ready", str, "", "Capture-ready JSON path")
        loader.add_option("apk_session", str, "", "Inventory capture session identifier")
        loader.add_option("apk_attribution", str, "unattributed", "unattributed or isolated_session")
        loader.add_option("apk_body_limit", int, 32768, "Maximum request prefix bytes used for shape inference")

    def running(self) -> None:
        if self.config is None:
            path = os.environ.get("APK_VERIFY_CONFIG")
            if path:
                with open(path, encoding="utf-8") as source:
                    self.config = json.load(source)
            else:
                if ctx is None:
                    raise RuntimeError("mitmproxy runtime is required")
                self.config = {"output": ctx.options.apk_output, "ready": ctx.options.apk_ready,
                               "session_id": ctx.options.apk_session, "attribution": ctx.options.apk_attribution,
                               "body_limit": ctx.options.apk_body_limit}
        if not self.config.get("output"):
            raise RuntimeError("Set APK_VERIFY_CONFIG or apk_output")
        output = Path(self.config["output"])
        output.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        self.stream = os.fdopen(fd, "a", encoding="utf-8", buffering=1)
        self.config["body_limit"] = min(max(int(self.config.get("body_limit", 32768)), 0), 1024 * 1024)
        self.emit("capture_ready")
        if self.config.get("ready"):
            atomic_json(Path(self.config["ready"]), {"event": "capture_ready", "session_id": self.config.get("session_id"), "pid": os.getpid()})

    def emit(self, event: str, **fields: Any) -> None:
        if self.stream is None:
            return
        if self.events_written >= int(self.config.get("max_events", 200000)) and event != "capture_finalized":
            self.events_dropped += 1
            if self.events_dropped == 1:
                self.stream.write(json.dumps({"event": "capture_diagnostic", "code": "EVENT_BUDGET_EXHAUSTED", "session_id": self.config.get("session_id", "")}) + "\n")
            return
        data = {"event": event, "timestamp": utc_now(), "session_id": self.config.get("session_id", ""), **fields}
        public = self.redactor.value(data)
        # Correlation ID belongs to this collector. Network query/body fields
        # named session_id remain redacted by the normal recursive rules.
        public["session_id"] = self.config.get("session_id", "")
        self.stream.write(json.dumps(public, ensure_ascii=False, allow_nan=False) + "\n")
        self.events_written += 1

    def requestheaders(self, flow: Any) -> None:
        request = flow.request
        if request.method.upper() == "CONNECT":
            return
        headers = list(request.headers.items(multi=True))
        self.redactor.remember_headers([(str(k), str(v)) for k, v in headers])
        try:
            base, query = normalize_url(request.url)
        except VerificationError:
            self.emit("capture_diagnostic", code="URL_INVALID")
            return
        allowed = self.config.get("origins")
        if allowed is not None and origin(base) not in allowed:
            self.emit("out_of_scope", origin=origin(base))
            request.stream = True
            return
        key = str(flow.id)
        tracking = len(self.eligible) < int(self.config.get("max_tracked", 4096))
        if tracking:
            self.eligible.add(key)
            self.started[key] = time.monotonic()
        elif not self.metadata_warning:
            self.emit("capture_diagnostic", code="METADATA_BUDGET_EXHAUSTED")
            self.metadata_warning = True
        public_headers = {name.lower(): value for name, value in headers if name.lower() in {"accept", "content-type", "accept-language"}}
        self.emit("http_request_seen", flow_id=key, method=request.method.upper(), url=base, query=query,
                  headers=public_headers, attribution=self.config.get("attribution", "unattributed"), capture_backend="mitmdump_live")
        if tracking and len(self.active) < int(self.config.get("max_inflight", 256)):
            capture = BodyCapture(self.config["body_limit"])
            self.active[key] = capture
            request.stream = capture.tee
        else:
            request.stream = True
            self.emit("http_request_shape", flow_id=key, body_capture="unknown", body_diagnostic="INFLIGHT_BODY_BUDGET")
            self.emit("capture_diagnostic", code="INFLIGHT_BODY_BUDGET")
        self.count += 1

    def request(self, flow: Any) -> None:
        key = str(flow.id)
        capture = self.active.pop(key, None)
        if capture is not None:
            description = capture.describe(flow.request.headers.get("content-type", ""), flow.request.headers.get("content-encoding", ""))
            self.emit("http_request_shape", flow_id=key, **description)

    def responseheaders(self, flow: Any) -> None:
        # Streaming response bodies avoids retaining them in mitmproxy.
        flow.response.stream = True
        key = str(flow.id)
        if key in self.eligible:
            self.emit("http_response_seen", flow_id=key, status=flow.response.status_code,
                      content_type=flow.response.headers.get("content-type", ""),
                      duration_ms=round((time.monotonic() - self.started.get(key, time.monotonic())) * 1000, 3))

    def response(self, flow: Any) -> None:
        key = str(flow.id)
        self.active.pop(key, None)
        self.eligible.discard(key)
        self.started.pop(key, None)

    def error(self, flow: Any) -> None:
        key = str(flow.id)
        if key in self.eligible:
            self.emit("http_transport_error", flow_id=key, code="UPSTREAM_TRANSPORT_ERROR")
        self.active.pop(key, None)
        self.eligible.discard(key)
        self.started.pop(key, None)

    def tls_failed_client(self, data: Any) -> None:
        self._tls_diagnostic(data, "client", "TLS_CLIENT_FAILED")

    def tls_failed_server(self, data: Any) -> None:
        self._tls_diagnostic(data, "upstream", "TLS_UPSTREAM_FAILED")

    def _tls_diagnostic(self, data: Any, side: str, code: str) -> None:
        allowed = self.config.get("origins")
        if allowed is not None:
            hosts = {urlsplit(item).hostname for item in allowed if item.startswith("https://")}
            if not hosts:
                return  # A plaintext fixture's scope cannot have TLS failures.
            connection = getattr(data, "conn", None)
            context = getattr(data, "context", None)
            server = getattr(context, "server", None)
            address = getattr(server, "address", None)
            host = getattr(connection, "sni", None) or (address[0] if address else None)
            if not isinstance(host, str) or host.lower() not in hosts:
                return
        self.emit("tls_diagnostic", side=side, code=code)

    def done(self) -> None:
        if self.stream is not None:
            self.emit("capture_finalized", request_count=self.count, dropped_events=self.events_dropped)
            self.stream.flush()
            self.stream.close()
            self.stream = None
        self.active.clear()
        self.eligible.clear()
        self.started.clear()


addons = [CaptureAddon()]
