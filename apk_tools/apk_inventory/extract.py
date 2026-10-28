"""APK -> evidence-backed, versioned HTTP inventory (offline)."""
from __future__ import annotations

import argparse
import contextlib
import importlib.metadata
import json
import math
import multiprocessing
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import time
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from .common import (InventoryError, METHODS, SCHEMA_VERSION, atomic_json, infer_shape,
                     normalize_url, clean_url_literal, redact, redact_text, safe_source_id, sha256_file, stable_id)
from .budget import rss_tree
from .hermes import disassemble, literal_objects, probe_header, run_bounded, tool_version
from .parsers import parse_arsc, parse_dex, parse_manifest

URL_BYTES = re.compile(rb"https?://[^\x00-\x20<>\"'`\\]+", re.I)
URL_TEXT = re.compile(r"https?://[^\s<>\"'`\\]+", re.I)
RELATIVE = re.compile(r"^/(?:api|v\d+|graphql|users|items|auth|config)(?:/|$)")


@dataclass
class ExtractOptions:
    profile: str = "fast"
    hermes: str = "auto"
    hermes_executable: str | None = None
    jadx: str | None = None
    max_apk_bytes: int = 1024 * 1024 * 1024
    max_members: int = 10000
    max_member_bytes: int = 128 * 1024 * 1024
    max_total_bytes: int = 1024 * 1024 * 1024
    max_ratio: int = 1000
    max_parser_bytes: int = 64 * 1024 * 1024
    max_candidates: int = 20000
    max_evidence: int = 100000
    max_tool_output: int = 64 * 1024 * 1024
    max_jadx_classes: int = 8
    worker_timeout: float = 30
    worker_memory_bytes: int = 768 * 1024 * 1024
    chunk_bytes: int = 65536
    strict: bool = False
    base_url: str | None = None
    native: bool = True
    max_native_sections: int = 4096
    max_native_symbols: int = 20000
    max_native_slices: int = 32
    max_native_scan_bytes: int = 128 * 1024 * 1024


def scan_urls(stream, chunk_size=65536, max_url=8192):
    """Bounded sliding scanner, including ASCII/UTF-16 URLs across chunks.

    A printable 34MB run never becomes one Python string. Absolute offsets
    suppress matches repeated by overlap windows.
    """
    windows = {"ascii": b"", "utf16le": b"", "utf16be": b""}
    last = {key: -1 for key in windows}
    offset = 0
    pending_byte = b""
    while True:
        chunk = stream.read(chunk_size)
        eof = not chunk
        for encoding in windows:
            if encoding != "ascii" and b"\0" not in chunk and not windows[encoding]:
                continue
            if encoding == "ascii":
                transformed = chunk
                scale = 1
                chunk_start = offset
            else:
                # Keep alignment independent of chunk boundaries. Both byte
                # orders are scanned; non-ASCII code units delimit URLs.
                raw = pending_byte + chunk
                usable = len(raw) - len(raw) % 2
                pairs = raw[:usable]
                little = encoding == "utf16le"
                transformed = bytes(pairs[i] if pairs[i + 1] == 0 else 0 for i in range(0, usable, 2)) if little else bytes(pairs[i + 1] if pairs[i] == 0 else 0 for i in range(0, usable, 2))
                scale = 2
                chunk_start = offset - len(pending_byte)
            old = windows[encoding]
            window = old + transformed
            start = chunk_start - len(old) * scale
            for match in URL_BYTES.finditer(window):
                absolute = start + match.start() * scale
                if absolute <= last[encoding] or (match.end() == len(window) and not eof):
                    continue
                last[encoding] = absolute
                if match.end() - match.start() > max_url:
                    continue
                value = clean_url_literal(match.group().decode("ascii", "replace"))
                yield value, absolute, encoding
            windows[encoding] = window[-(max_url + 16):]
        if eof:
            return
        pending_byte = chunk[-1:] if (offset + len(chunk)) % 2 else b""
        offset += len(chunk)


def _worker(kind, data, connection, memory_limit):
    try:
        if sys.platform != "darwin":
            import resource
            resource.setrlimit(resource.RLIMIT_AS, (memory_limit, memory_limit))
        # Third-party warnings can contain package literals. Only our stable
        # diagnostic codes leave the worker, never parser debug/stdout text.
        with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            if kind == "native":
                from .native import analyze_native
                value = analyze_native(Path(data["path"]), data["location"], ExtractOptions(**data["options"]))
            else:
                value = {"manifest": parse_manifest, "arsc": parse_arsc, "dex": parse_dex}[kind](data)
        encoded = json.dumps(value, ensure_ascii=False)
        if len(encoded.encode()) > 32 * 1024 * 1024:
            raise InventoryError("PARSER_OUTPUT_LIMIT", "Parser output exceeds budget")
        connection.send((True, value))
    except Exception as error:
        try:
            connection.send((False, {"code": getattr(error, "code", "PARSER_FAILED"), "error_type": type(error).__name__}))
        except (BrokenPipeError, EOFError, OSError):
            pass  # Parent cancelled or enforced a budget.
    finally:
        connection.close()


def run_parser(kind, data, options):
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe(duplex=False)
    process = context.Process(target=_worker, args=(kind, data, child, options.worker_memory_bytes))
    process.start()
    child.close()
    try:
        deadline = time.monotonic() + options.worker_timeout
        while not parent.poll(0.05):
            if time.monotonic() >= deadline:
                raise InventoryError("PARSER_TIMEOUT", f"{kind} parser exceeded time budget")
            if rss_tree(process.pid) > options.worker_memory_bytes:
                raise InventoryError("PARSER_MEMORY_LIMIT", f"{kind} parser exceeded resident-memory budget")
        try:
            ok, value = parent.recv()
        except EOFError:
            raise InventoryError("PARSER_FAILED", f"{kind} parser exited without a result") from None
        if not ok:
            raise InventoryError(value["code"], kind + ": " + value["error_type"])
        return value
    finally:
        parent.close()
        process.join(timeout=0.5)
        if process.is_alive():
            process.terminate()
            process.join(timeout=1)
        if process.is_alive():
            process.kill()
            process.join()


def _atomic_array(path: Path, records):
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name, dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write("[\n")
            first = True
            for record in records:
                if not first:
                    stream.write(",\n")
                json.dump(record, stream, ensure_ascii=False, allow_nan=False)
                first = False
            stream.write("\n]\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Collector:
    def __init__(self, db_path, options):
        self.db = sqlite3.connect(db_path)
        self.db.execute("CREATE TABLE endpoints (id TEXT PRIMARY KEY, record TEXT)")
        self.db.execute("CREATE TABLE evidence (id TEXT PRIMARY KEY, record TEXT)")
        self.db.execute("CREATE TABLE unique_urls (url TEXT PRIMARY KEY)")
        self.options = options
        self.hosts = {}
        self.fragments = []
        self.count = self.evidence_count = 0
        self.limited = False
        self.unsupported_query = False
        self.backend_versions = {}

    def fragment(self, value):
        if len(self.fragments) < self.options.max_candidates:
            self.fragments.append(redact(value))
        else:
            self.limited = True

    def add(self, url, source, location, *, method=None, backend="stream_scan", backend_version=None, mode="strings", query=None, body=None, headers=None, body_present=False, parameters=None, candidate_kind="endpoint", offset=None, evidence_metadata=None):
        try:
            canonical, url_query = normalize_url(url)
        except InventoryError:
            return
        method = method.upper() if isinstance(method, str) and method.upper() in METHODS else None
        original_query = {**url_query, **(query or {})}
        scalar = lambda value: value is None or isinstance(value, (str, bool, int)) or isinstance(value, float) and math.isfinite(value)
        unsupported_query = [key for key, value in original_query.items() if not scalar(value) and not (isinstance(value, list) and all(scalar(item) and item is not None for item in value))]
        self.unsupported_query = self.unsupported_query or bool(unsupported_query)
        # The public query dictionary follows the shared scalar/repeated-scalar
        # wire contract. Preserve unsupported object types as schema evidence,
        # rather than guessing a deepObject/JSON query serialization.
        safe_query = redact({key: None if key in unsupported_query else value for key, value in original_query.items()})
        safe_headers = {k: v for k, v in (headers or {}).items() if isinstance(k, str) and isinstance(v, str) and len(v) <= 8192 and "\r" not in v and "\n" not in v and k.lower() in {"accept", "content-type", "accept-language"}}
        safe_body = redact(body)
        body_shape = infer_shape(body) if body_present else None
        evidence = {"source": source, "member": redact_text(location), "backend": backend, "mode": mode,
                    "method_origin": "explicit" if method else "unknown", "query_shape": infer_shape(original_query),
                    "body_shape": body_shape}
        if backend_version is None and backend in {"androguard", "pyaxmlparser"}:
            if backend not in self.backend_versions:
                try:
                    self.backend_versions[backend] = importlib.metadata.version(backend)
                except importlib.metadata.PackageNotFoundError:
                    self.backend_versions[backend] = None
            backend_version = self.backend_versions[backend]
        evidence["backend_version"] = backend_version
        if offset is not None:
            evidence["offset"] = offset
        if evidence_metadata:
            # Format-aware locators only. URL/query values still go through the
            # shared collector redactor, never into raw binary snippets.
            evidence["native"] = redact(evidence_metadata)
        evid = stable_id("ev_", [canonical, method, safe_query, safe_body, evidence])
        if self.db.execute("SELECT 1 FROM evidence WHERE id=?", (evid,)).fetchone():
            return
        if self.evidence_count >= self.options.max_evidence:
            self.limited = True
            return
        # Evidence contains generated schemas and public locator metadata only.
        # Applying the value redactor here would turn properties.token's schema
        # into '[REDACTED]' and destroy the parameter contract.
        self.db.execute("INSERT INTO evidence VALUES (?,?)", (evid, json.dumps(evidence, ensure_ascii=False)))
        self.evidence_count += 1
        key = stable_id("candidate_", [method, canonical])
        existing = self.db.execute("SELECT record FROM endpoints WHERE id=?", (key,)).fetchone()
        if existing:
            record = json.loads(existing[0])
            if len(record["evidence_ids"]) < 128:
                record["evidence_ids"].append(evid)
            record["extraction_sources"] = sorted(set(record["extraction_sources"] + [source]))
            if location not in record["locations"] and len(record["locations"]) < 128:
                record["locations"].append(location)
            if parameters:
                target_parameters = record.setdefault("parameters", {})
                for key, names in parameters.items():
                    target_parameters[key] = sorted(set(target_parameters.get(key, []) + names))
            if body_present and record["body_capture"] == "unknown":
                record.update(body=safe_body, body_capture="complete", body_shape=body_shape)
            record["query"].update({k: v for k, v in safe_query.items() if k not in record["query"]})
            record.setdefault("query_shape", {"type": "object", "properties": {}})["properties"].update(infer_shape(original_query).get("properties", {}))
            if unsupported_query:
                record["unsupported_query_parameters"] = sorted(set(record.get("unsupported_query_parameters", []) + unsupported_query))
            sample = {"query": safe_query, "body_shape": body_shape}
            if sample not in record["parameter_variants"] and len(record["parameter_variants"]) < 16:
                record["parameter_variants"].append(sample)
            self.db.execute("UPDATE endpoints SET record=? WHERE id=?", (json.dumps(record, ensure_ascii=False), key))
        else:
            if self.count >= self.options.max_candidates:
                self.limited = True
                return
            record = {"method": method, "url": canonical, "headers": safe_headers, "query": safe_query,
                      "body": safe_body, "categories": ["static_candidate"], "source": source,
                      "package": location, "body_capture": "complete" if body_present else "unknown",
                      "body_shape": body_shape, "query_shape": infer_shape(original_query),
                      "candidate_id": key, "candidate_kind": candidate_kind, "evidence_ids": [evid],
                      "extraction_sources": [source], "locations": [location], "parameter_variants": [{"query": safe_query, "body_shape": body_shape}]}
            if parameters:
                record["parameters"] = parameters
            if unsupported_query:
                record["unsupported_query_parameters"] = unsupported_query
            self.db.execute("INSERT INTO endpoints VALUES (?,?)", (key, json.dumps(record, ensure_ascii=False)))
            self.count += 1
        origin = urlsplit(canonical)
        host = origin.hostname
        summary = self.hosts.setdefault(host, {"host": host, "occurrence_count": 0, "unique_url_count": 0, "sources": {}, "environment_hint": "unknown"})
        summary["occurrence_count"] += 1
        cursor = self.db.execute("INSERT OR IGNORE INTO unique_urls VALUES (?)", (canonical,))
        summary["unique_url_count"] += cursor.rowcount
        summary["sources"][source] = summary["sources"].get(source, 0) + 1
        for label in host.split("."):
            if label in {"stg", "stage", "staging", "dev", "uat", "test", "sandbox"}:
                summary["environment_hint"] = label
                break

    def records(self):
        self.db.commit()
        for row in self.db.execute("SELECT record FROM endpoints ORDER BY id"):
            yield json.loads(row[0])

    def write_evidence(self, path):
        with path.open("w", encoding="utf-8") as stream:
            for ident, value in self.db.execute("SELECT id,record FROM evidence ORDER BY id"):
                stream.write(json.dumps({"id": ident, **json.loads(value)}, ensure_ascii=False) + "\n")


def collect_json(value, collector, source, location, depth=0, backend="json_config", backend_version=None):
    if depth > 20:
        return
    if isinstance(value, dict):
        endpoint = next((value[k] for k in ("url", "endpoint", "requestUrl") if isinstance(value.get(k), str)), None)
        base = next((value[k] for k in ("baseURL", "baseUrl", "base_url") if isinstance(value.get(k), str)), None)
        path = value.get("path") if isinstance(value.get("path"), str) else None
        if endpoint or (base and path):
            target = endpoint or path
            if target.startswith("/") and base:
                target = urljoin(base, target)
            elif base and not target.startswith(("http://", "https://")):
                target = urljoin(base, target)
            collector.add(target, source, location, method=value.get("method"), backend=backend, backend_version=backend_version, mode="linked_object", query=value.get("params") if isinstance(value.get("params"), dict) else None, body=value.get("body"), body_present="body" in value, headers=value.get("headers") if isinstance(value.get("headers"), dict) else None)
        for key, item in list(value.items())[:10000]:
            collect_json(item, collector, source, location + "#" + str(key), depth + 1, backend, backend_version)
    elif isinstance(value, list):
        for i, item in enumerate(value[:10000]):
            collect_json(item, collector, source, location + f"[{i}]", depth + 1, backend, backend_version)
    elif isinstance(value, str):
        for match in URL_TEXT.finditer(value):
            collector.add(clean_url_literal(match.group()), source, location, backend=backend, backend_version=backend_version)
        if RELATIVE.match(value):
            collector.fragment({"kind": "relative_path", "value": value, "source": source, "package": location})


def collect_js(text, collector, source, location, backend="javascript"):
    # Restricted literal call patterns only; expressions and distant string
    # pairs are deliberately not evaluated or cross-combined.
    for match in re.finditer(r"\b(?:axios|client|httpClient)\.(get|head|post|put|patch|delete|options)\s*\(\s*(['\"])(https?://[^'\"\n]+)\2", text, re.I):
        collector.add(match[3], source, location, method=match[1], backend=backend, mode="literal_call", offset=match.start())
    for match in re.finditer(r"\bfetch\s*\(\s*(['\"])(https?://[^'\"\n]+)\1\s*(?:,\s*\{([^}]{0,4096})\})?\s*\)", text):
        explicit = re.search(r"\bmethod\s*:\s*['\"]([A-Z]+)['\"]", match[3] or "", re.I)
        method = explicit[1] if explicit else "GET" if match[3] is None else None
        collector.add(match[2], source, location, method=method, backend=backend, mode="literal_call", offset=match.start())


def _read_member(archive, info, maximum):
    with archive.open(info) as stream:
        value = stream.read(maximum + 1)
    if len(value) > maximum:
        raise InventoryError("MEMBER_LIMIT", "Member exceeds parser byte budget")
    return value


def extract_apk(apk_path, out_dir, options=None):
    options = options or ExtractOptions()
    if isinstance(options, dict):
        options = ExtractOptions(**options)
    apk_path, out_dir = Path(apk_path).resolve(), Path(out_dir).resolve()
    if not apk_path.is_file() or apk_path.stat().st_size > options.max_apk_bytes:
        raise InventoryError("APK_INVALID", "APK is absent or exceeds input limit")
    out_dir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    warnings, stages, frameworks, network_classes = [], [], set(), set()
    native_libraries = []
    native_metadata_bytes = 0
    app = {"package_name": "unknown", "apk_sha256": sha256_file(apk_path)}
    try:
        archive = zipfile.ZipFile(apk_path)
    except zipfile.BadZipFile:
        raise InventoryError("APK_INVALID", "Input is not a ZIP/APK archive") from None
    with archive, tempfile.TemporaryDirectory(prefix="apk-inventory-") as temporary, contextlib.ExitStack() as resources:
        temp = Path(temporary)
        collector = Collector(temp / "candidates.sqlite", options)
        resources.callback(collector.db.close)
        infos = archive.infolist()
        if len(infos) > options.max_members:
            raise InventoryError("ZIP_MEMBER_LIMIT", "APK has too many members")
        names = [i.filename for i in infos]
        if len(set(names)) != len(names):
            raise InventoryError("ZIP_DUPLICATE_MEMBER", "Ambiguous duplicate ZIP members")
        if "AndroidManifest.xml" not in names:
            raise InventoryError("MANIFEST_MISSING", "APK has no AndroidManifest.xml")
        total = 0
        for info in infos:
            if info.is_dir():
                continue
            if info.filename.startswith(("/", "\\")) or ".." in Path(info.filename).parts or "\\" in info.filename:
                raise InventoryError("ZIP_PATH_INVALID", "Unsafe member path")
            if info.flag_bits & 1:
                raise InventoryError("ZIP_ENCRYPTED", "Encrypted APK members are unsupported")
            if info.file_size > options.max_member_bytes or info.file_size / max(1, info.compress_size) > options.max_ratio:
                raise InventoryError("ZIP_SIZE_LIMIT", "APK member exceeds unpacking budget")
            total += info.file_size
        if total > options.max_total_bytes:
            raise InventoryError("ZIP_SIZE_LIMIT", "APK unpacked total exceeds budget")
        manifest_data = _read_member(archive, archive.getinfo("AndroidManifest.xml"), min(options.max_parser_bytes, 8 * 1024 * 1024))
        try:
            manifest = run_parser("manifest", manifest_data, options)
            for key in ("package_name", "version_name", "version_code", "launcher_activity"):
                app[key] = manifest.get(key)
            for url, locator in manifest["urls"]:
                collector.add(url, "manifest", "AndroidManifest.xml#" + locator, backend=manifest["backend"], candidate_kind="deep_link" if "intent-filter" in locator else "endpoint")
            for fragment in manifest["fragments"]:
                collector.fragment(fragment)
            stages.append({"stage": "manifest", "status": "complete", "backend": manifest["backend"]})
        except Exception as error:
            raise InventoryError("MANIFEST_INVALID", "Manifest metadata could not be decoded: " + getattr(error, "code", type(error).__name__)) from None
        for info in infos:
            name = info.filename
            if info.is_dir() or name == "AndroidManifest.xml":
                continue
            try:
                if name == "resources.arsc":
                    for value, locator in run_parser("arsc", _read_member(archive, info, options.max_parser_bytes), options):
                        for match in URL_TEXT.finditer(value):
                            collector.add(clean_url_literal(match.group()), "strings", "resources.arsc#" + locator, backend="pyaxmlparser")
                    stages.append({"stage": name, "status": "complete"})
                elif re.fullmatch(r"classes\d*\.dex", name):
                    result = run_parser("dex", _read_member(archive, info, options.max_parser_bytes), options)
                    for i, value in enumerate(result["strings"]):
                        for match in URL_TEXT.finditer(value):
                            collector.add(clean_url_literal(match.group()), "dex", f"{name}#string:{i}", backend=result["backend"])
                        if RELATIVE.match(value):
                            collector.fragment({"kind": "relative_path", "value": value, "source": "dex", "package": f"{name}#string:{i}"})
                    for endpoint in result["retrofit"]:
                        if endpoint["path"].startswith(("http://", "https://")):
                            collector.add(endpoint["path"], "dex", endpoint["package"], method=endpoint["method"], backend=result["backend"], mode="retrofit_annotation", parameters=endpoint["parameters"])
                        elif options.base_url:
                            collector.add(urljoin(options.base_url, endpoint["path"]), "dex", endpoint["package"], method=endpoint["method"], backend=result["backend"], mode="configured_base_annotation", parameters=endpoint["parameters"])
                        else:
                            collector.fragment({"kind": "retrofit_relative", **endpoint, "source": "dex", "reason": "BASE_URL_UNBOUND"})
                    warnings.extend(result["diagnostics"])
                    network_classes.update(result["network_classes"])
                    stages.append({"stage": name, "status": "partial" if result["diagnostics"] else "complete", "backend": result["backend"], "network_libraries": result["network_libraries"]})
                    frameworks.add("native")
                elif name.endswith(".so"):
                    if name.endswith("/libflutter.so"):
                        frameworks.add("flutter")
                        warnings.append("FLUTTER_AOT_NOT_RECOVERED")
                    if not options.native:
                        warnings.append("NATIVE_DISABLED")
                        stages.append({"stage": name, "status": "skipped", "code": "NATIVE_DISABLED"})
                        continue
                    binary_path = temp / "native-input.so"
                    used = 0
                    with archive.open(info) as incoming, binary_path.open("wb") as outgoing:
                        while chunk := incoming.read(options.chunk_bytes):
                            used += len(chunk)
                            if used > options.max_member_bytes:
                                raise InventoryError("MEMBER_LIMIT", "Native member exceeds byte budget")
                            outgoing.write(chunk)
                    result = run_parser("native", {"path": str(binary_path), "location": name, "options": asdict(options)}, options)
                    for endpoint in result.get("endpoints", []):
                        collector.add(endpoint["url"], "native", endpoint.get("package", name),
                                      method=endpoint.get("method"), backend=endpoint.get("backend", "native"),
                                      backend_version=endpoint.get("backend_version"), mode=endpoint.get("mode", "native_strings"),
                                      offset=endpoint.get("offset"), evidence_metadata={key: endpoint[key] for key in ("section", "architecture", "slice_offset", "virtual_address", "encoding") if key in endpoint})
                    for fragment in result.get("fragments", []):
                        collector.fragment(fragment)
                    limitations = result.get("limitations", [])
                    warnings.extend(item.get("code", "NATIVE_LIMITATION") for item in limitations)
                    metadata = {"member": name, **redact(result.get("metadata", {})), "limitations": redact(limitations)}
                    metadata_size = len(json.dumps(metadata, ensure_ascii=False).encode())
                    if native_metadata_bytes + metadata_size <= min(options.max_tool_output, 32 * 1024 * 1024):
                        native_libraries.append(metadata)
                        native_metadata_bytes += metadata_size
                    else:
                        warnings.append("NATIVE_METADATA_LIMIT")
                    stages.append({"stage": name, "status": "partial" if limitations else "complete", "backend": result.get("metadata", {}).get("backend", "native"), "endpoint_count": len(result.get("endpoints", []))})
                    frameworks.add("native_library")
                elif name.startswith(("assets/", "res/raw/", "res/values/")):
                    with archive.open(info) as stream:
                        header = stream.read(32)
                    probe = probe_header(header)
                    is_bundle = name.endswith((".bundle", ".hbc")) or probe["format"] == "hermes"
                    source = "hermes" if probe["format"] == "hermes" else "strings" if name.startswith("res/values/") else "asset"
                    if is_bundle:
                        frameworks.add("react_native")
                    raw_resource_xml = name.startswith("res/values/") and name.endswith(".xml")
                    if raw_resource_xml:
                        xml_data = _read_member(archive, info, options.max_parser_bytes)
                        if b"<!DOCTYPE" in xml_data.upper() or b"<!ENTITY" in xml_data.upper():
                            raise InventoryError("XML_UNSAFE", "Resource XML has external declarations")
                        root = ET.fromstring(xml_data)
                        for element in root.iter():
                            value = "".join(element.itertext()) if element.tag == "string" else element.text or ""
                            for match in URL_TEXT.finditer(value):
                                collector.add(clean_url_literal(match.group()), "strings", name + "#" + element.get("name", element.tag), backend="resource_xml")
                    elif probe["format"] != "hermes":
                        with archive.open(info) as stream:
                            for url, offset, encoding in scan_urls(stream, options.chunk_bytes):
                                collector.add(url, source, name, mode="binary_printable" if probe["format"] == "hermes" else "stream_strings", offset=offset)
                    if probe["format"] == "hermes":
                        with tempfile.TemporaryDirectory(dir=temp) as hbc_dir:
                            hbc_temp = Path(hbc_dir)
                            bundle = hbc_temp / "bundle.hbc"
                            with archive.open(info) as incoming, bundle.open("wb") as output:
                                shutil.copyfileobj(incoming, output, options.chunk_bytes)
                            result = disassemble(bundle, hbc_temp, probe["hbc_version"], options.hermes, options.hermes_executable, options.worker_timeout, options.max_tool_output, options.worker_memory_bytes)
                            if result["status"] == "complete":
                                for output in result["files"]:
                                    if result.get("format") == "jsonl":
                                        with output.open(encoding="utf-8") as stream:
                                            while True:
                                                line = stream.readline(65537)
                                                if not line:
                                                    break
                                                if len(line) > 65536:
                                                    while line and not line.endswith("\n"):
                                                        line = stream.readline(65537)
                                                    warnings.append("HERMES_EVENT_LIMIT")
                                                    result["status"] = "partial"
                                                    continue
                                                event = json.loads(line)
                                                if event.get("event") == "string" and isinstance(event.get("value"), str):
                                                    for match in URL_TEXT.finditer(event["value"]):
                                                        collector.add(clean_url_literal(match.group()), "hermes", name + f"#string:{event['index']}", backend=result["backend"], backend_version=result.get("backend_version"), mode="structured_strings")
                                                elif event.get("event") == "object" and isinstance(event.get("literal"), str):
                                                    import io
                                                    for obj, _ in literal_objects(io.StringIO("# Object: " + event["literal"])):
                                                        collect_json(obj, collector, "hermes", name + f"#function:{event.get('function')}:offset:{event.get('offset')}", backend=result["backend"], backend_version=result.get("backend_version"))
                                                elif event.get("event") == "diagnostic":
                                                    warnings.append(event.get("code", "HERMES_PARTIAL"))
                                                    result["status"] = "partial"
                                    else:
                                        with output.open("rb") as stream:
                                            for url, offset, _ in scan_urls(stream, options.chunk_bytes):
                                                collector.add(url, "hermes", name, backend=result["backend"], backend_version=result.get("backend_version"), mode="disassembly_strings", offset=offset)
                                    if result["backend"] == "hermes-dec" and result.get("format") != "jsonl":
                                        with output.open(encoding="utf-8", errors="replace") as stream:
                                            for obj, line_number in literal_objects(stream):
                                                collect_json(obj, collector, "hermes", name + f"#object_line:{line_number}", backend=result["backend"], backend_version=result.get("backend_version"))
                            else:
                                warnings.append(result["code"])
                                with archive.open(info) as stream:
                                    for url, offset, encoding in scan_urls(stream, options.chunk_bytes):
                                        collector.add(url, "hermes", name, mode="binary_printable", offset=offset)
                            stages.append({"stage": name, "status": "complete" if result["status"] == "complete" else "partial", "format": "hermes", "hbc_version": probe["hbc_version"], "backend": result.get("backend", "stream_scan"), "backend_version": result.get("backend_version"), "fixture_verified": False, "peak_rss_bytes": result.get("peak_rss_bytes")})
                    elif info.file_size <= min(options.max_parser_bytes, 4 * 1024 * 1024):
                        data = _read_member(archive, info, options.max_parser_bytes)
                        if name.endswith(".json"):
                            try:
                                collect_json(json.loads(data), collector, source, name)
                            except (ValueError, UnicodeError):
                                warnings.append("ASSET_JSON_INVALID")
                        elif name.endswith((".js", ".bundle")):
                            collect_js(data.decode("utf-8", "replace"), collector, source, name)
                    elif name.endswith((".json", ".js", ".bundle")):
                        warnings.append("ASSET_STRUCTURE_BUDGET")
                        stages.append({"stage": name, "status": "partial", "backend": "stream_scan", "code": "ASSET_STRUCTURE_BUDGET"})
                    if name.startswith(("assets/www/", "assets/public/")):
                        frameworks.add("webview")
            except Exception as error:
                code = getattr(error, "code", "MEMBER_PARSE_FAILED")
                warnings.append(code)
                stages.append({"stage": name, "status": "partial", "code": code})
        if options.profile == "deep":
            binary = options.jadx or shutil.which("jadx")
            if not binary:
                warnings.append("JADX_UNAVAILABLE")
            elif not network_classes:
                warnings.append("JADX_NO_TARGET_CLASSES")
            else:
                decoded = temp / "jadx"
                outcomes = []
                backend_version = tool_version(binary, temp)
                class_list = sorted(network_classes)
                if len(class_list) > options.max_jadx_classes:
                    warnings.append("JADX_CLASS_LIMIT")
                for index, cls in enumerate(class_list[:options.max_jadx_classes]):
                    target = cls[1:-1].replace("/", ".") if cls.startswith("L") and cls.endswith(";") else cls
                    environment = {**os.environ, "JAVA_TOOL_OPTIONS": "-Xmx512m"}
                    try:
                        outcomes.append(run_bounded([binary, "--no-res", "--no-debug-info", "--threads-count", "1", "--single-class", target, "--output-dir", str(decoded), str(apk_path)], temp / f"jadx-{index}.log", options.worker_timeout, options.max_tool_output, decoded, environment, options.worker_memory_bytes))
                    except OSError:
                        warnings.append("JADX_START_FAILED")
                        outcomes.append({"returncode": 127, "timed_out": False, "memory_limited": False, "output_limited": False, "peak_rss_bytes": 0})
                        break
                outcome = {"returncode": 1 if any(o["returncode"] != 0 for o in outcomes) else 0, "timed_out": any(o["timed_out"] for o in outcomes), "memory_limited": any(o["memory_limited"] for o in outcomes), "output_limited": any(o["output_limited"] for o in outcomes), "peak_rss_bytes": max((o["peak_rss_bytes"] for o in outcomes), default=0), "target_classes": len(outcomes), "backend_version": backend_version}
                used = 0
                for source_file in decoded.rglob("*.java") if decoded.exists() else []:
                    used += source_file.stat().st_size
                    if used > options.max_tool_output:
                        warnings.append("JADX_OUTPUT_LIMIT")
                        break
                    if source_file.stat().st_size > 4 * 1024 * 1024:
                        continue
                    text = source_file.read_text(encoding="utf-8", errors="replace")
                    locator = str(source_file.relative_to(decoded))
                    with source_file.open("rb") as stream:
                        for url, offset, _ in scan_urls(stream, options.chunk_bytes):
                            collector.add(url, "dex", locator, backend="jadx", backend_version=backend_version, offset=offset)
                    # Associate only directly adjacent Retrofit annotations with
                    # literals, and use a base solely when explicitly configured.
                    for match in re.finditer(r'@(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s*\(\s*"([^"\n]+)"\s*\)', text):
                        target = match[2]
                        if options.base_url:
                            target = urljoin(options.base_url, target)
                        if target.startswith(("http://", "https://")):
                            collector.add(target, "dex", locator, method=match[1], backend="jadx", backend_version=backend_version, mode="retrofit_literal", offset=match.start())
                        else:
                            collector.fragment({"kind": "retrofit_relative", "method": match[1], "path": target, "source": "dex", "package": locator, "reason": "BASE_URL_UNBOUND"})
                stages.append({"stage": "jadx", "status": "complete" if outcome["returncode"] == 0 and not outcome["timed_out"] else "partial", **outcome})
                if outcome["returncode"] or outcome["timed_out"]:
                    warnings.append("JADX_FAILED")
        if collector.limited:
            warnings.append("CANDIDATE_BUDGET_REACHED")
        if collector.unsupported_query:
            warnings.append("UNSUPPORTED_QUERY_ENCODING")
        _atomic_array(out_dir / "endpoints.static.json", collector.records())
        collector.write_evidence(out_dir / "evidence.jsonl")
        with (out_dir / "fragments.jsonl").open("w", encoding="utf-8") as stream:
            for fragment in collector.fragments:
                stream.write(json.dumps(fragment, ensure_ascii=False) + "\n")
        atomic_json(out_dir / "hosts_summary.json", {"schema_version": SCHEMA_VERSION, "hosts": sorted(collector.hosts.values(), key=lambda h: (-h["occurrence_count"], h["host"]))})
        atomic_json(out_dir / "native_libraries.json", {"schema_version": SCHEMA_VERSION, "libraries": native_libraries})
        versions = {}
        for library in ("androguard", "pyaxmlparser", "pyelftools", "macholib"):
            try:
                versions[library] = importlib.metadata.version(library)
            except importlib.metadata.PackageNotFoundError:
                versions[library] = None
        status = "partial" if warnings else "complete"
        report = {"schema_version": SCHEMA_VERSION, "status": status, "app": app, "frameworks": sorted(frameworks), "tool_versions": versions,
                  "stages": stages, "warnings": sorted(set(warnings)), "endpoint_count": collector.count, "evidence_count": collector.evidence_count,
                  "fragment_count": len(collector.fragments), "duration_ms": round((time.monotonic() - started) * 1000),
                  "limits": {field.name: getattr(options, field.name) for field in fields(options) if field.name.startswith("max_") or field.name in {"worker_timeout", "worker_memory_bytes", "chunk_bytes"}},
                  "memory_budget_mode": "parent_process_tree_rss_polling",
                  "limitations": ["Static observations do not prove runtime use or business validity", "Unknown HTTP methods remain null", "Packed/encrypted strings and dynamic signatures may be unresolved", "Hermes decoding depends on bytecode-version compatibility"]}
        atomic_json(out_dir / "extraction_report.json", report)
        descriptor = {"format": "endpoint-inventory", "schema_version": SCHEMA_VERSION, "kind": "apk", "source_id": safe_source_id(app["package_name"]),
                      "inventory": "endpoints.static.json", "static_inventory": "endpoints.static.json", "evidence": "evidence.jsonl", "app": app,
                      "inventory_sha256": sha256_file(out_dir / "endpoints.static.json")}
        atomic_json(out_dir / "source.json", descriptor)
    return {"status": status, "source_id": descriptor["source_id"], "output": str(out_dir), "manifest": str(out_dir / "source.json"), "endpoint_count": report["endpoint_count"], "warnings": report["warnings"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Offline APK to evidence-backed HTTP inventory")
    parser.add_argument("apk")
    parser.add_argument("--out", required=True)
    parser.add_argument("--profile", choices=["fast", "deep"], default="fast")
    parser.add_argument("--hermes", choices=["auto", "off", "required", "hermes-dec", "hbctool", "hbcdump", "official", "hermes_rs"], default="auto")
    parser.add_argument("--hermes-executable")
    parser.add_argument("--jadx")
    parser.add_argument("--base-url", help="Explicit trusted base for relative Retrofit paths")
    parser.add_argument("--no-native", action="store_true", help="Skip native shared-library analysis")
    parser.add_argument("--limits", help="JSON or YAML ExtractOptions overrides")
    parser.add_argument("--strict", action="store_true")
    arguments = parser.parse_args(argv)
    try:
        overrides = {}
        if arguments.limits:
            if Path(arguments.limits).stat().st_size > 65536:
                raise InventoryError("CONFIG_LIMIT", "Limits file is too large")
            with open(arguments.limits, encoding="utf-8") as stream:
                if arguments.limits.endswith(".json"):
                    overrides = json.load(stream)
                else:
                    import yaml
                    overrides = yaml.safe_load(stream)
            if not isinstance(overrides, dict) or set(overrides) - {f.name for f in fields(ExtractOptions) if f.name.startswith("max_") or f.name in {"worker_timeout", "worker_memory_bytes", "chunk_bytes"}}:
                raise InventoryError("CONFIG_INVALID", "Unknown limit names")
        for key, val in overrides.items():
            if not isinstance(val, (int, float)) or isinstance(val, bool) or val <= 0:
                raise InventoryError("CONFIG_INVALID", "Limits must be positive numbers")
            if key not in {"worker_timeout", "max_ratio"} and not isinstance(val, int):
                raise InventoryError("CONFIG_INVALID", "Byte/count limits must be integers")
        options = ExtractOptions(profile=arguments.profile, hermes=arguments.hermes, hermes_executable=arguments.hermes_executable,
                                 jadx=arguments.jadx, base_url=arguments.base_url, native=not arguments.no_native, strict=arguments.strict, **overrides)
        summary = extract_apk(arguments.apk, arguments.out, options)
        print(json.dumps(summary, ensure_ascii=False))
        required_failed = options.hermes == "required" and any(code.startswith("HERMES_") for code in summary["warnings"])
        return 3 if (options.strict and summary["status"] == "partial") or required_failed else 0
    except Exception as error:
        print(json.dumps({"status": "failed", "error": {"code": getattr(error, "code", "EXTRACTION_FAILED"), "message": str(error) if isinstance(error, InventoryError) else type(error).__name__}}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
