"""Turn passive HTTP observations into a derived endpoint inventory.

An observation proves that a request was seen, not that it was successful or that
the proxy identified an Android process.  Original extraction files are immutable.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator
from urllib.parse import parse_qsl, urlsplit, urlunsplit

HTTP_METHODS = {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"}
SELECTOR_KEYS = {"action", "op", "operation", "cmd", "method"}
MAX_JSON_BYTES = 128 * 1024 * 1024
SENSITIVE = {
    "authorization", "proxyauthorization", "cookie", "setcookie", "password", "passwd",
    "pwd", "secret", "token", "accesstoken", "refreshtoken", "idtoken", "apikey",
    "session", "sessionid", "clientsecret", "privatekey", "credential", "credentials",
}


class VerificationError(Exception):
    def __init__(self, code: str, message: str):
        self.code, self.message = code, message
        super().__init__(message)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, value: Any) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            os.chmod(name, 0o600)
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read_json(path: Path, max_bytes: int = MAX_JSON_BYTES) -> Any:
    path = Path(path)
    if not path.is_file() or path.stat().st_size > max_bytes:
        raise VerificationError("INPUT_LIMIT", "JSON input is absent or exceeds its byte budget")
    try:
        with path.open(encoding="utf-8") as stream:
            return json.load(stream)
    except (ValueError, UnicodeError):
        raise VerificationError("INPUT_INVALID", "Input is not valid UTF-8 JSON") from None


def within(root: Path, relative: str, *, must_exist: bool = True) -> Path:
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        raise VerificationError("ARTIFACT_PATH", "Artifact references must be relative paths")
    root = root.resolve()
    result = (root / relative).resolve()
    if not result.is_relative_to(root) or result == root:
        raise VerificationError("ARTIFACT_PATH", "Artifact reference escapes its inventory directory")
    if must_exist and not result.is_file():
        raise VerificationError("ARTIFACT_PATH", "Referenced artifact is not a regular file")
    return result


def sensitive_key(key: str) -> bool:
    compact = re.sub(r"[^a-z0-9]", "", str(key).lower())
    return compact in SENSITIVE or compact.endswith(("token", "secret", "password", "apikey"))


class CaptureRedactor:
    """Only safe request fields are exported; body values are never exported."""
    def __init__(self) -> None:
        self.secrets: set[str] = set()

    def remember_headers(self, headers: Iterable[tuple[str, str]]) -> None:
        for name, raw in headers:
            if sensitive_key(name):
                value = str(raw)
                if value:
                    self.secrets.add(value)
                if name.lower() in {"authorization", "proxy-authorization"}:
                    bits = value.split(" ", 1)
                    if len(bits) == 2 and bits[1]:
                        self.secrets.add(bits[1])
                if name.lower() == "cookie":
                    for part in value.split(";"):
                        if "=" in part:
                            cookie_value = part.split("=", 1)[1].strip()
                            if cookie_value:
                                self.secrets.add(cookie_value)

    def text(self, value: str) -> str:
        # Protect generated markers so repeated redaction is idempotent, including
        # when a newly remembered short secret happens to occur inside the marker.
        secrets = [secret for secret in sorted(self.secrets, key=len, reverse=True) if secret and secret != "[REDACTED]"]
        if not secrets:
            return value
        pattern = re.compile("|".join(re.escape(secret) for secret in secrets))
        return "[REDACTED]".join(pattern.sub(lambda _: "[REDACTED]", chunk) for chunk in value.split("[REDACTED]"))

    def value(self, value: Any) -> Any:
        if isinstance(value, dict):
            return {self.text(str(key)): clean_shape(item) if key in {"body_shape", "query_shape"} else
                    "[REDACTED]" if sensitive_key(str(key)) else self.value(item)
                    for key, item in value.items()}
        if isinstance(value, list):
            return [self.value(item) for item in value]
        if isinstance(value, str):
            return self.text(value)
        return value


def normalize_url(value: str) -> tuple[str, dict[str, str | list[str]]]:
    try:
        url = urlsplit(value)
        if url.scheme.lower() not in {"http", "https"} or not url.hostname or url.username or url.password:
            raise ValueError()
        if any(ord(char) < 32 for char in value):
            raise ValueError()
        scheme = url.scheme.lower()
        host = url.hostname.encode("idna").decode("ascii").lower()
        if ":" in host:
            host = "[" + host + "]"
        port = url.port
        authority = host + (":" + str(port) if port and port != (443 if scheme == "https" else 80) else "")
        base = urlunsplit((scheme, authority, url.path or "/", "", ""))
        query: dict[str, str | list[str]] = {}
        for key, item in parse_qsl(url.query, keep_blank_values=True, max_num_fields=1000):
            if key in query:
                previous = query[key]
                query[key] = previous + [item] if isinstance(previous, list) else [previous, item]
            else:
                query[key] = item
        return base, query
    except (ValueError, UnicodeError, AttributeError):
        raise VerificationError("URL_INVALID", "Observation URL is not a valid HTTP(S) URL") from None


def origin(value: str) -> str:
    url = urlsplit(value)
    return url.scheme + "://" + url.netloc


def shape(value: Any, depth: int = 0) -> dict[str, Any]:
    if depth >= 8:
        return {}
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "boolean"}
    if isinstance(value, int):
        return {"type": "integer"}
    if isinstance(value, float):
        return {"type": "number"}
    if isinstance(value, str):
        return {"type": "string"}
    if isinstance(value, list):
        distinct = {json.dumps(shape(item, depth + 1), sort_keys=True) for item in value[:100]}
        items = [json.loads(item) for item in sorted(distinct)]
        return {"type": "array", "items": items[0] if len(items) == 1 else {"anyOf": items} if items else {}}
    if isinstance(value, dict):
        return {"type": "object", "properties": {str(key): shape(item, depth + 1)
                for key, item in list(value.items())[:200]}}
    return {}


def _safe_headers(value: Any, redactor: CaptureRedactor) -> dict[str, str]:
    if isinstance(value, dict):
        pairs = [(str(key), str(item)) for key, item in value.items()]
    elif isinstance(value, list):
        pairs = [(str(item.get("name", "")), str(item.get("value", ""))) for item in value if isinstance(item, dict)]
    else:
        pairs = []
    redactor.remember_headers(pairs)
    return {name.lower(): redactor.text(item) for name, item in pairs
            if name.lower() in {"accept", "content-type", "accept-language"}}


def iter_jsonl(path: Path, max_line_bytes: int = 256 * 1024) -> Iterator[dict[str, Any]]:
    with Path(path).open("rb") as stream:
        for number in range(1, 1_000_001):
            raw = stream.readline(max_line_bytes + 1)
            if not raw:
                return
            if len(raw) > max_line_bytes:
                raise VerificationError("EVENT_LIMIT", "Observation event exceeds its byte budget")
            try:
                event = json.loads(raw)
            except (ValueError, UnicodeError):
                raise VerificationError("EVENT_INVALID", "Observation JSONL contains an invalid event") from None
            if not isinstance(event, dict):
                raise VerificationError("EVENT_INVALID", "Observation events must be JSON objects")
            yield event
        if stream.read(1):
            raise VerificationError("EVENT_LIMIT", "Observation event count exceeds its budget")


def har_events(path: Path, session_id: str, attribution: str = "unattributed") -> Iterator[dict[str, Any]]:
    value = read_json(path)
    entries = value.get("log", {}).get("entries", []) if isinstance(value, dict) else []
    if not isinstance(entries, list):
        raise VerificationError("HAR_INVALID", "HAR entries must be an array")
    for number, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        req = entry.get("request", {})
        if not isinstance(req, dict):
            continue
        flow_id = "har_" + str(number)
        event = {"event": "http_request_seen", "session_id": session_id, "flow_id": flow_id,
                 "method": req.get("method"), "url": req.get("url"),
                 "headers": req.get("headers", []), "attribution": attribution,
                 "capture_backend": "har_import", "timestamp": entry.get("startedDateTime")}
        yield event
        post = req.get("postData")
        if isinstance(post, dict):
            mime = str(post.get("mimeType", "")).split(";", 1)[0].lower()
            text = post.get("text", "")
            captured = "unknown"
            body_shape: dict[str, Any] = {}
            if isinstance(text, str) and len(text.encode("utf-8")) <= 32768:
                if mime == "application/json" or mime.endswith("+json"):
                    try:
                        body_shape = shape(json.loads(text))
                        captured = "shape_only"
                    except ValueError:
                        pass
                elif mime == "application/x-www-form-urlencoded":
                    try:
                        body_shape = {"type": "object", "properties": {key: {"type": "string"}
                                      for key, _ in parse_qsl(text, keep_blank_values=True, max_num_fields=1000)}}
                        captured = "shape_only"
                    except ValueError:
                        pass
            elif isinstance(text, str):
                captured = "truncated"
            if isinstance(post.get("params"), list):
                body_shape = {"type": "object", "properties": {str(p.get("name")): {"type": "string"}
                              for p in post["params"][:200] if isinstance(p, dict) and "name" in p}}
                captured = "shape_only"
            yield {"event": "http_request_shape", "flow_id": flow_id, "body_shape": body_shape,
                   "body_capture": captured, "body_present": True}
        else:
            yield {"event": "http_request_shape", "flow_id": flow_id, "body_capture": "absent", "body_present": False}
        response = entry.get("response", {})
        status = response.get("status") if isinstance(response, dict) else None
        if isinstance(status, int) and 100 <= status <= 599:
            yield {"event": "http_response_seen", "flow_id": flow_id, "status": status,
                   "duration_ms": max(0, entry.get("time", 0)) if isinstance(entry.get("time", 0), (int, float)) else None}


def collect_observations(events: Iterable[dict[str, Any]], allowed_origins: set[str] | None = None,
                         max_flows: int = 100000) -> tuple[list[dict[str, Any]], dict[str, int]]:
    flows: dict[str, dict[str, Any]] = {}
    pending: dict[str, dict[str, Any]] = {}
    redactor = CaptureRedactor()
    counters = {"tls_failed_count": 0, "out_of_scope_flows": 0, "ignored_events": 0, "invalid_urls": 0, "capture_limit_count": 0}
    for event in events:
        kind = event.get("event")
        if kind == "tls_diagnostic":
            counters["tls_failed_count"] += 1
            continue
        if kind == "capture_diagnostic" and event.get("code") in {"EVENT_BUDGET_EXHAUSTED", "METADATA_BUDGET_EXHAUSTED", "INFLIGHT_BODY_BUDGET"}:
            counters["capture_limit_count"] += 1
            continue
        key = str(event.get("flow_id", ""))[:256]
        if not key:
            continue
        if kind == "http_request_seen":
            method = str(event.get("method", "")).upper()
            if method not in HTTP_METHODS or method == "CONNECT":
                counters["ignored_events"] += 1
                continue
            headers = _safe_headers(event.get("headers", {}), redactor)
            try:
                url, query = normalize_url(str(event.get("url", "")))
            except VerificationError:
                counters["invalid_urls"] += 1
                continue
            if allowed_origins is not None and origin(url) not in allowed_origins:
                counters["out_of_scope_flows"] += 1
                continue
            if isinstance(event.get("query"), dict):
                query.update(event["query"])
            if key not in flows and len(flows) >= max_flows:
                raise VerificationError("FLOW_LIMIT", "Observed flow count exceeds its budget")
            # Multiple HTTP events for one flow update one observation.
            old = flows.get(key, {})
            item = {"flow_id": key, "session_id": str(event.get("session_id", ""))[:256],
                    "method": method, "url": url, "query": query, "headers": headers,
                    "body": None, "body_capture": "unknown", "body_present": None,
                    "transport": "request_only", "status": None,
                    "attribution": event.get("attribution") if event.get("attribution") in
                    {"isolated_session", "app_filtered_capture"} else "unattributed",
                    "capture_backend": str(event.get("capture_backend", "mitmdump_live"))[:64]}
            item.update({name: value for name, value in old.items() if name in
                         {"transport", "status", "duration_ms", "body_capture", "body_present", "body_shape"}})
            item.update(pending.pop(key, {}))
            flows[key] = item
        elif kind in {"http_request_shape", "http_response_seen", "http_transport_error"}:
            update: dict[str, Any] = {}
            if kind == "http_request_shape":
                capture = event.get("body_capture", "unknown")
                update["body_capture"] = capture if capture in {"absent", "complete", "shape_only", "truncated", "unknown"} else "unknown"
                update["body_present"] = event.get("body_present") if isinstance(event.get("body_present"), bool) else None
                if isinstance(event.get("body_shape"), dict):
                    # Shape is a schema, not a raw body; strip examples/defaults recursively.
                    update["body_shape"] = clean_shape(event["body_shape"])
            elif kind == "http_response_seen":
                status = event.get("status")
                if isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599:
                    update.update(transport="response_seen", status=status)
                elapsed = event.get("duration_ms")
                if isinstance(elapsed, (int, float)) and 0 <= elapsed <= 86400000:
                    update["duration_ms"] = elapsed
            else:
                update["transport"] = "error"
            if key in flows:
                flows[key].update(update)
            elif len(pending) < max_flows:
                pending.setdefault(key, {}).update(update)
    output = []
    for item in flows.values():
        safe = redactor.value(item)
        # This is collector-generated correlation metadata, not query.session_id.
        safe["session_id"] = item["session_id"]
        output.append(safe)
    return output, counters


def clean_shape(value: Any, depth: int = 0) -> dict[str, Any]:
    if not isinstance(value, dict) or depth > 8:
        return {}
    result: dict[str, Any] = {}
    if isinstance(value.get("type"), str) and value.get("type") in {"object", "array", "string", "number", "integer", "boolean", "null"}:
        result["type"] = value["type"]
    if isinstance(value.get("properties"), dict):
        result["properties"] = {str(k): clean_shape(v, depth + 1) for k, v in list(value["properties"].items())[:200]}
    if isinstance(value.get("items"), dict):
        result["items"] = clean_shape(value["items"], depth + 1)
    if isinstance(value.get("anyOf"), list):
        result["anyOf"] = [clean_shape(v, depth + 1) for v in value["anyOf"][:10]]
    return result


def merge_shapes(left: dict[str, Any] | None, right: dict[str, Any] | None) -> dict[str, Any]:
    """Conservative sample union: no sample introduces required/default/enum."""
    left, right = clean_shape(left or {}), clean_shape(right or {})
    if not left:
        return right
    if not right:
        return left
    if left == right:
        return left
    if left.get("type") == right.get("type") == "object":
        a, b = left.get("properties", {}), right.get("properties", {})
        return {"type": "object", "properties": {key: merge_shapes(a.get(key), b.get(key)) for key in sorted(set(a) | set(b))[:200]}}
    if left.get("type") == right.get("type") == "array":
        return {"type": "array", "items": merge_shapes(left.get("items"), right.get("items"))}
    variants = left.get("anyOf", [left]) + right.get("anyOf", [right])
    unique = {json.dumps(item, sort_keys=True, ensure_ascii=False) for item in variants}
    return {"anyOf": [json.loads(item) for item in sorted(unique)[:10]]}


def _selectors(record: dict[str, Any]) -> dict[str, Any]:
    query = record.get("query", {})
    return {str(key): value for key, value in query.items() if str(key).lower() in SELECTOR_KEYS} if isinstance(query, dict) else {}


def _selector_fingerprint(record: dict[str, Any]) -> str:
    return json.dumps(_selectors(record), sort_keys=True, ensure_ascii=False)


def _selector_match(candidate: dict[str, Any], observed: dict[str, Any]) -> bool:
    actual = _selectors(observed)
    return all(value != "[REDACTED]" and key in actual and actual[key] == value
               for key, value in _selectors(candidate).items())


def _route(record: dict[str, Any]) -> tuple[str | None, str, str]:
    method = record.get("method")
    return str(method).upper() if method else None, normalize_url(str(record["url"]))[0], _selector_fingerprint(record)


def _template_match(template: str, actual: str) -> bool:
    pattern = re.escape(template)
    pattern = re.sub(r"\\\{[A-Za-z_][A-Za-z0-9_]*\\\}", r"[^/]+", pattern)
    return bool(re.fullmatch(pattern, actual))


def _merge_record(target: dict[str, Any], other: dict[str, Any]) -> None:
    for field in ("evidence_ids", "extraction_sources"):
        target[field] = sorted(set(target.get(field, [])) | set(other.get(field, [])))
    target["query_shape"] = merge_shapes(target.get("query_shape") or shape(target.get("query", {})),
                                         other.get("query_shape") or shape(other.get("query", {})))
    target.setdefault("query", {}).update(other.get("query", {}))
    target.setdefault("headers", {}).update(other.get("headers", {}))
    if "observed" in other.get("categories", []):
        target["categories"] = sorted((set(target.get("categories", [])) | set(other["categories"]) | {"observed"}) - {"static_candidate"})
    if target.get("source") == "network" and other.get("source") != "network":
        target["source"], target["package"] = other.get("source"), other.get("package")
    if other.get("body_shape"):
        target["body_shape"] = merge_shapes(target.get("body_shape"), other["body_shape"])
        target["body_capture"] = other.get("body_capture", "shape_only")
        target["body_present"] = other.get("body_present")
    target.setdefault("observations", []).extend(other.get("observations", []))
    target["observations"] = target["observations"][-20:]


def reconcile_records(static: list[dict[str, Any]], observations: list[dict[str, Any]],
                      allowed_origins: set[str] | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    baseline: dict[tuple[str | None, str, str], dict[str, Any]] = {}
    redactor = CaptureRedactor()
    invalid_static = 0
    for raw in static:
        if isinstance(raw.get("headers"), dict):
            redactor.remember_headers([(str(k), str(v)) for k, v in raw["headers"].items()])
        try:
            route = _route(raw)
        except (VerificationError, KeyError, TypeError):
            invalid_static += 1
            continue
        if route not in baseline:
            baseline[route] = copy.deepcopy(raw)
            baseline[route]["url"] = route[1]
        else:
            _merge_record(baseline[route], raw)
    eligible = {key for key in baseline if allowed_origins is None or origin(key[1]) in allowed_origins}
    matched: set[tuple[str | None, str, str]] = set()
    known_matched: set[tuple[str | None, str, str]] = set()
    seen_operations: set[tuple[str, str, str]] = set()
    new_operations: set[tuple[str, str, str]] = set()
    upgraded: dict[tuple[str, str, str], dict[str, Any]] = {}
    ambiguous: list[dict[str, Any]] = []
    unattributed = 0
    response_count = transport_errors = 0
    for obs in observations:
        method, actual = obs["method"], obs["url"]
        if obs.get("attribution") not in {"isolated_session", "app_filtered_capture"}:
            unattributed += 1
            continue
        if allowed_origins is not None and origin(actual) not in allowed_origins:
            continue
        response_count += obs.get("transport") == "response_seen"
        transport_errors += obs.get("transport") == "error"
        operation = (method, actual, _selector_fingerprint(obs))
        seen_operations.add(operation)
        possible = [key for key in eligible if key[0] in {None, method} and key[1] == actual and _selector_match(baseline[key], obs)]
        if not possible:
            candidates = [key for key in eligible if key[0] in {None, method} and "{" in key[1]
                          and _template_match(key[1], actual) and _selector_match(baseline[key], obs)]
            paths = {key[1] for key in candidates}
            if len(paths) == 1:
                possible = candidates
            elif len(paths) > 1:
                ambiguous.append({"method": method, "url": actual, "candidates": sorted(paths)})
        evidence_id = "ev_network_" + hashlib.sha256((obs.get("session_id", "") + ":" + obs["flow_id"]).encode()).hexdigest()[:24]
        observation_meta = {key: obs.get(key) for key in ("session_id", "flow_id", "capture_backend", "attribution", "transport", "status", "duration_ms")}
        observation_meta["evidence_id"] = evidence_id
        if not possible:
            new_operations.add(operation)
            record: dict[str, Any] = {"method": method, "url": actual, "headers": obs.get("headers", {}),
                "query": obs.get("query", {}), "body": None, "categories": ["observed"], "source": "network",
                "package": None, "evidence_ids": [evidence_id], "extraction_sources": ["network"]}
            records = [record]
        else:
            records = []
            for key in possible:
                matched.add(key)
                if key[0] is not None:
                    known_matched.add(key)
                record = copy.deepcopy(baseline[key])
                record["method"] = method
                record["categories"] = sorted((set(record.get("categories", [])) | {"observed"}) - {"static_candidate"})
                record["evidence_ids"] = sorted(set(record.get("evidence_ids", [])) | {evidence_id})
                record["extraction_sources"] = sorted(set(record.get("extraction_sources", [])) | {record.get("source", "network")})
                record.setdefault("query", {}).update(obs.get("query", {}))
                record.setdefault("headers", {}).update(obs.get("headers", {}))
                if key[0] is None:
                    record["method_origin"] = "network"
                records.append(record)
        for record in records:
            record["query_shape"] = shape(obs.get("query", {}))
            record["body_capture"] = obs.get("body_capture", "unknown")
            record["body_present"] = obs.get("body_present")
            if obs.get("body_shape"):
                record["body_shape"] = clean_shape(obs["body_shape"])
            record["observations"] = [observation_meta]
            result_key = (method, record["url"], _selector_fingerprint(record))
            if result_key in upgraded:
                _merge_record(upgraded[result_key], record)
            else:
                upgraded[result_key] = record
    result = [value for key, value in baseline.items() if key not in matched] + list(upgraded.values())
    result.sort(key=lambda rec: (rec["url"], rec.get("method") or ""))
    known = {key for key in eligible if key[0] is not None}
    unknown = eligible - known
    report = {"static_total": len(baseline), "static_eligible": len(eligible),
              "static_known_method": len(known), "static_unknown_method": len(unknown),
              "matched_static_candidates": len(matched), "matched_known_operations": len(known_matched),
              "matched_unknown_method_candidates": len(matched & unknown),
              "observed_unique_operations": len(seen_operations), "new_observed_operations": len(new_operations),
              "ambiguous_matches": ambiguous[:100], "ambiguous_match_count": len(ambiguous),
              "unattributed_flows": unattributed, "invalid_static_candidates": invalid_static,
              "response_seen_count": response_count, "transport_error_count": transport_errors,
              "coverage": len(matched) / len(eligible) if eligible else None,
              "known_method_coverage": len(known_matched) / len(known) if known else None,
              "coverage_denominator": "unique_static_candidates_in_scope",
              "evidence_scope": "request_observations"}
    public_result = []
    for item in result:
        safe = redactor.value(item)
        for index, observation in enumerate(item.get("observations", [])):
            safe["observations"][index]["session_id"] = observation.get("session_id", "")
        public_result.append(safe)
    return public_result, report


def finalize_inventory(directory: Path, apk: Path, events: Iterable[dict[str, Any]], *, session_id: str,
                       allowed_origins: set[str] | None = None, promote: bool = True,
                       extra_report: dict[str, Any] | None = None) -> dict[str, Any]:
    directory, apk = Path(directory).resolve(), Path(apk).resolve()
    descriptor = read_json(directory / "source.json")
    if not isinstance(descriptor, dict) or descriptor.get("format") != "endpoint-inventory" or descriptor.get("kind") != "apk":
        raise VerificationError("INVENTORY_INVALID", "Input directory is not an APK endpoint inventory")
    if descriptor.get("app", {}).get("apk_sha256") != sha256_file(apk):
        raise VerificationError("APK_MISMATCH", "APK hash does not match the extraction inventory")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", session_id):
        raise VerificationError("SESSION_INVALID", "Session identifier has an invalid format")
    # Always compare against the original static baseline, not a previous run.
    static_reference = descriptor.get("static_inventory", "endpoints.static.json")
    baseline_path = within(directory, static_reference)
    static = read_json(baseline_path)
    if not isinstance(static, list) or not all(isinstance(row, dict) for row in static):
        raise VerificationError("INVENTORY_INVALID", "Static inventory must be a JSON array of objects")
    observations, counters = collect_observations(events, allowed_origins)
    merged, report = reconcile_records(static, observations, allowed_origins)
    report.update(counters)
    report.update({"schema_version": "1.1", "session_id": session_id, "apk_sha256": descriptor["app"]["apk_sha256"],
                   "package_name": descriptor.get("app", {}).get("package_name"), "finished_at": utc_now(),
                   "static_sha256": sha256_file(baseline_path),
                   "run_status": "complete" if report["observed_unique_operations"] and not counters["capture_limit_count"] and not counters["tls_failed_count"] else "partial",
                   "limitations": ["observed is a captured request, not proof of HTTP or business success",
                                   "session association is not Android process attribution"]})
    if extra_report:
        report.update(extra_report)
    output = within(directory, "verified/" + session_id, must_exist=False)
    if (output / "verification_report.json").exists():
        raise VerificationError("SESSION_EXISTS", "Verification session already has committed artifacts")
    output.mkdir(parents=True, exist_ok=True)
    atomic_json(output / "endpoints.json", merged)
    atomic_json(output / "observations.json", observations)
    # Normalized evidence is safe to consume independently of raw event ordering.
    descriptor_fd, temp_name = tempfile.mkstemp(prefix=".observations.", dir=output)
    try:
        with os.fdopen(descriptor_fd, "w", encoding="utf-8") as stream:
            for observation in observations:
                stream.write(json.dumps(observation, ensure_ascii=False, allow_nan=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, output / "observations.jsonl")
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    report["promoted"] = bool(promote)
    atomic_json(output / "verification_report.json", report)
    if promote:
        descriptor["static_inventory"] = static_reference
        descriptor["inventory"] = (output / "endpoints.json").relative_to(directory).as_posix()
        descriptor["verification_report"] = (output / "verification_report.json").relative_to(directory).as_posix()
        descriptor["inventory_sha256"] = sha256_file(output / "endpoints.json")
        atomic_json(directory / "source.json", descriptor)
    return {"status": report["run_status"], "source_id": descriptor.get("source_id"),
            "inventory": str(output / "endpoints.json"), "report": str(output / "verification_report.json"),
            "observed_unique_operations": report["observed_unique_operations"], "coverage": report["coverage"],
            "promoted": bool(promote)}
