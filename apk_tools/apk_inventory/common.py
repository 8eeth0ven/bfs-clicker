"""Small, shared, side-effect-free inventory primitives."""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit, urlunsplit

SCHEMA_VERSION = "1.1"
METHODS = {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}
SENSITIVE = re.compile(r"(?:password|passwd|secret|token$|authorization|^cookie$|session(?:id|_id)?$|api[_-]?key|client[_-]?secret|^(?:sig|sign|signature)$)", re.I)


class InventoryError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def stable_id(prefix: str, value) -> str:
    raw = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return prefix + hashlib.sha256(raw.encode()).hexdigest()


def atomic_json(path: str | Path, value) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def read_json(path: str | Path):
    with open(path, encoding="utf-8") as stream:
        return json.load(stream)


def safe_source_id(package_name: str) -> str:
    return "apk_" + re.sub(r"[^a-zA-Z0-9_-]", "_", package_name or "unknown")[:120]


def normalize_url(value: str) -> tuple[str, dict]:
    value = value.strip().replace("\\/", "/")
    if len(value) > 8192 or any(ord(c) < 32 for c in value):
        raise InventoryError("URL_INVALID", "URL exceeds length/control-character limits")
    try:
        value.encode("utf-8", "strict")
        parts = urlsplit(value)
        if parts.scheme.lower() not in {"http", "https"} or not parts.hostname or parts.username is not None:
            raise ValueError()
        host = parts.hostname.encode("idna").decode("ascii").lower()
        if ":" in host:
            host = "[" + host + "]"
        port = parts.port
        authority = host + (f":{port}" if port and (parts.scheme.lower(), port) not in {("http", 80), ("https", 443)} else "")
        query: dict[str, str | list[str]] = {}
        for key, val in parse_qsl(parts.query, keep_blank_values=True, max_num_fields=4096):
            if key in query:
                if isinstance(query[key], list):
                    query[key].append(val)
                else:
                    query[key] = [query[key], val]
            else:
                query[key] = val
        return urlunsplit((parts.scheme.lower(), authority, parts.path or "/", "", "")), query
    except (ValueError, UnicodeError):
        raise InventoryError("URL_INVALID", "Not a supported absolute HTTP(S) URL") from None


def clean_url_literal(value: str) -> str:
    value = value.rstrip(".,;")
    # Preserve explicit {id} templates and IPv6 hosts, removing only unmatched
    # prose delimiters. Blind rstrip('}') would corrupt /items/{id}.
    while value and value[-1] in ")]}":
        closing = value[-1]
        opening = {")": "(", "]": "[", "}": "{"}[closing]
        if value.count(closing) <= value.count(opening):
            break
        value = value[:-1]
    return value


def redact_text(text: str) -> str:
    text = re.sub(r"\bBearer\s+[A-Za-z0-9._~+/-]+=*", "Bearer [REDACTED]", text, flags=re.I)
    text = re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[REDACTED]", text)
    text = re.sub(r"(?i)((?:access_token|refresh_token|api_key|password|secret|authorization|cookie)\s*[=:]\s*)[^\s,;\"'<>]+", r"\1[REDACTED]", text)
    return text


def redact(value):
    if isinstance(value, dict):
        return {str(k): "[REDACTED]" if SENSITIVE.search(str(k)) else redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, str):
        return redact_text(value)
    return value


def infer_shape(value, depth: int = 0) -> dict:
    if depth >= 12:
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
        options = {json.dumps(infer_shape(v, depth + 1), sort_keys=True) for v in value[:100]}
        schemas = [json.loads(v) for v in sorted(options)]
        return {"type": "array", "items": schemas[0] if len(schemas) == 1 else {"anyOf": schemas} if schemas else {}}
    if isinstance(value, dict):
        return {"type": "object", "properties": {str(k): infer_shape(v, depth + 1) for k, v in list(value.items())[:256]}, "additionalProperties": True}
    return {}
