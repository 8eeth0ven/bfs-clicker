"""Offline iOS IPA/App Bundle evidence extraction; never launches an app."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import math
import os
import plistlib
import re
import shutil
import stat
import tempfile
import time
import uuid
import zipfile
from dataclasses import asdict, fields
from pathlib import Path, PurePosixPath

from .common import (InventoryError, SCHEMA_VERSION, atomic_json, clean_url_literal,
                     redact, redact_text, sha256_file)
from .extract import (Collector, ExtractOptions, URL_TEXT, _atomic_array,
                      collect_js, collect_json, run_parser, scan_urls)
from .hermes import disassemble, literal_objects, probe_header

MACHO_MAGICS = {bytes.fromhex(v) for v in (
    "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"
)}
PLIST_CAP = 4 * 1024 * 1024
SKIP_PREFIXES = ("_CodeSignature/",)
SKIP_FILES = {"embedded.mobileprovision", "CodeResources", "PkgInfo"}


def _options(value=None):
    options = ExtractOptions(**value) if isinstance(value, dict) else value or ExtractOptions()
    for item in fields(options):
        name, val = item.name, getattr(options, item.name)
        if not (name.startswith("max_") or name in {"worker_timeout", "worker_memory_bytes", "chunk_bytes"}):
            continue
        if isinstance(val, bool) or not isinstance(val, (int, float)) or not math.isfinite(val) or val <= 0:
            raise InventoryError("CONFIG_INVALID", "Limits must be finite positive numbers")
        if name not in {"worker_timeout", "max_ratio"} and not isinstance(val, int):
            raise InventoryError("CONFIG_INVALID", "Byte/count limits must be integers")
    return options


def _tree_files(root: Path, options):
    """Validate before reading; no symlink, device, escape or unlimited walk."""
    if root.is_symlink() or not root.is_dir():
        raise InventoryError("IOS_APP_INVALID", "App input must be a regular directory without symlinks")
    pending, files_, members, total = [root], [], 0, 0
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                members += 1
                if members > options.max_members:
                    raise InventoryError("IOS_MEMBER_LIMIT", "App Bundle has too many members")
                path = Path(entry.path)
                rel = path.relative_to(root).as_posix()
                try:
                    rel.encode("utf-8", "strict")
                except UnicodeError:
                    raise InventoryError("IOS_PATH_INVALID", "App member name is not valid UTF-8") from None
                if "\\" in rel or any(ord(c) < 32 for c in rel):
                    raise InventoryError("IOS_PATH_INVALID", "Unsafe App member path")
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode):
                    raise InventoryError("IOS_SYMLINK", "App Bundle symlinks are unsupported")
                if stat.S_ISDIR(info.st_mode):
                    pending.append(path)
                elif stat.S_ISREG(info.st_mode):
                    if info.st_size > options.max_member_bytes:
                        raise InventoryError("IOS_SIZE_LIMIT", "App member exceeds byte budget")
                    total += info.st_size
                    if total > min(options.max_total_bytes, options.max_apk_bytes):
                        raise InventoryError("IOS_SIZE_LIMIT", "App Bundle exceeds total byte budget")
                    files_.append((rel, path, info))
                else:
                    raise InventoryError("IOS_FILE_TYPE", "Special App Bundle members are unsupported")
    return sorted(files_, key=lambda item: item[0])


def _stat_key(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def _file_digest(path: Path, expected=None, copy_to: Path | None = None, chunk=65536):
    before = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(before.st_mode) or expected is not None and _stat_key(before) != _stat_key(expected):
        raise InventoryError("IOS_INPUT_CHANGED", "App member changed during extraction")
    h, count = hashlib.sha256(), 0
    output = copy_to.open("wb") if copy_to else contextlib.nullcontext()
    with path.open("rb") as incoming, output as outgoing:
        for data in iter(lambda: incoming.read(chunk), b""):
            count += len(data)
            if count > before.st_size:
                raise InventoryError("IOS_INPUT_CHANGED", "App member changed during extraction")
            h.update(data)
            if outgoing is not None:
                outgoing.write(data)
    if count != before.st_size or _stat_key(path.stat(follow_symlinks=False)) != _stat_key(before):
        raise InventoryError("IOS_INPUT_CHANGED", "App member changed during extraction")
    return h.digest()


def _tree_digest(entries, *, snapshot: Path | None = None, chunk=65536):
    h = hashlib.sha256(b"ios-app-tree-v1\0")
    for relative, path, info in entries:
        name = relative.encode("utf-8")
        target = snapshot / relative if snapshot is not None else None
        if target is not None:
            target.parent.mkdir(parents=True, exist_ok=True)
        digest = _file_digest(path, info, target, chunk)
        h.update(len(name).to_bytes(4, "big"))
        h.update(name)
        h.update(info.st_size.to_bytes(8, "big"))
        h.update(digest)
    return h.hexdigest()


def artifact_hash(path: str | Path, options=None) -> str:
    """SHA-256 for IPA; deterministic relative-name/size/file-hash tree for .app.

    The tree hash includes regular files only, in Unicode path order. Empty
    directories and timestamps do not change identity. Symlinks are rejected.
    """
    options, path = _options(options), Path(path).expanduser()
    if path.is_symlink():
        raise InventoryError("IOS_SYMLINK", "iOS artifact symlinks are unsupported")
    if path.is_dir():
        if path.suffix.lower() != ".app":
            raise InventoryError("IOS_APP_INVALID", "Directory input must be an .app Bundle")
        return _tree_digest(_tree_files(path, options), chunk=options.chunk_bytes)
    if not path.is_file() or path.stat().st_size > options.max_apk_bytes:
        raise InventoryError("IOS_INVALID", "IPA is absent or exceeds input byte budget")
    return _file_digest(path, chunk=options.chunk_bytes).hex()


def _zip_entries(archive, options):
    infos = archive.infolist()
    if len(infos) > options.max_members:
        raise InventoryError("ZIP_MEMBER_LIMIT", "IPA has too many members")
    names, total = set(), 0
    for info in infos:
        name = info.filename
        if name in names:
            raise InventoryError("ZIP_DUPLICATE_MEMBER", "Ambiguous duplicate ZIP members")
        names.add(name)
        normalized = PurePosixPath(name).as_posix()
        if (name.startswith(("/", "\\")) or "\\" in name or ".." in PurePosixPath(name).parts
                or normalized != name.rstrip("/") or any(ord(c) < 32 for c in name)
                or any(ord(c) < 32 for c in getattr(info, "orig_filename", name))
                or re.match(r"^[A-Za-z]:", name)):
            raise InventoryError("ZIP_PATH_INVALID", "Unsafe IPA member path")
        mode = (info.external_attr >> 16) & 0xFFFF
        if stat.S_ISLNK(mode):
            raise InventoryError("IOS_SYMLINK", "IPA member symlinks are unsupported")
        if mode and stat.S_IFMT(mode) not in {0, stat.S_IFREG, stat.S_IFDIR}:
            raise InventoryError("IOS_FILE_TYPE", "Special IPA members are unsupported")
        if info.flag_bits & 1:
            raise InventoryError("ZIP_ENCRYPTED", "Encrypted ZIP containers are unsupported")
        if info.file_size > options.max_member_bytes or info.file_size / max(1, info.compress_size) > options.max_ratio:
            raise InventoryError("ZIP_SIZE_LIMIT", "IPA member exceeds unpacking budget")
        total += info.file_size
        if total > options.max_total_bytes:
            raise InventoryError("ZIP_SIZE_LIMIT", "IPA unpacked total exceeds budget")
    return infos


def _snapshot(artifact: Path, temporary: Path, options, selection=None):
    if artifact.is_dir():
        if selection:
            raise InventoryError("IOS_APP_SELECTION_INVALID", "--app is only used to select a Bundle inside an IPA")
        if artifact.suffix.lower() != ".app":
            raise InventoryError("IOS_APP_INVALID", "Directory input must be an .app Bundle")
        entries = _tree_files(artifact, options)
        root = temporary / "input.app"
        root.mkdir()
        digest = _tree_digest(entries, snapshot=root, chunk=options.chunk_bytes)
        if [row[0] for row in _tree_files(artifact, options)] != [row[0] for row in entries]:
            raise InventoryError("IOS_INPUT_CHANGED", "App membership changed during extraction")
        return root, digest, "app", artifact.name
    if artifact.is_symlink() or not artifact.is_file() or artifact.stat().st_size > options.max_apk_bytes:
        raise InventoryError("IOS_INVALID", "IPA is absent or exceeds input byte budget")
    before = artifact.stat()
    digest = artifact_hash(artifact, options)
    try:
        archive = zipfile.ZipFile(artifact)
    except zipfile.BadZipFile:
        raise InventoryError("IOS_INVALID", "IPA input is not a ZIP archive") from None
    with archive:
        infos = _zip_entries(archive, options)
        candidates = sorted({str(PurePosixPath(info.filename).parent) for info in infos
                             if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", info.filename)})
        if selection:
            candidates = [name for name in candidates if name == selection.rstrip("/") or PurePosixPath(name).name == selection]
        if not candidates:
            raise InventoryError("IOS_APP_SELECTION_INVALID" if selection else "IOS_APP_MISSING", "IPA has no matching top-level App Bundle")
        if len(candidates) != 1:
            raise InventoryError("IOS_APP_AMBIGUOUS", "IPA has multiple Apps; use --app Bundle.app or Payload/Bundle.app")
        selected, root = candidates[0], temporary / "input.app"
        root.mkdir()
        prefix = selected + "/"
        for info in infos:
            if info.is_dir() or not info.filename.startswith(prefix):
                continue
            relative = info.filename[len(prefix):]
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as incoming, target.open("wb") as outgoing:
                count = 0
                while data := incoming.read(options.chunk_bytes):
                    count += len(data)
                    if count > info.file_size or count > options.max_member_bytes:
                        raise InventoryError("ZIP_SIZE_LIMIT", "IPA member changed or exceeded unpacking budget")
                    outgoing.write(data)
                if count != info.file_size:
                    raise InventoryError("ZIP_SIZE_LIMIT", "IPA member length does not match archive metadata")
    if _stat_key(artifact.stat()) != _stat_key(before):
        raise InventoryError("IOS_INPUT_CHANGED", "IPA changed during extraction")
    return root, digest, "ipa", selected


def _read_small(path: Path, maximum):
    with path.open("rb") as stream:
        data = stream.read(maximum + 1)
    if len(data) > maximum:
        raise InventoryError("MEMBER_LIMIT", "Resource exceeds structured-parser byte budget")
    return data


def _plist_metadata(info, collector):
    schemes = info.get("CFBundleURLTypes", [])
    for item in schemes[:256] if isinstance(schemes, list) else []:
        if not isinstance(item, dict):
            continue
        values = item.get("CFBundleURLSchemes", [])
        for scheme in values[:256] if isinstance(values, list) else []:
            if isinstance(scheme, str):
                collector.fragment({"kind": "deep_link_scheme", "source": "plist", "package": "Info.plist#CFBundleURLTypes", "scheme": scheme[:1024]})
    ats = info.get("NSAppTransportSecurity")
    if isinstance(ats, dict):
        flags = {key: value for key, value in ats.items() if key.startswith("NSAllows") and isinstance(value, bool)}
        collector.fragment({"kind": "ats_policy", "source": "plist", "package": "Info.plist#NSAppTransportSecurity", "flags": flags})
        domains = ats.get("NSExceptionDomains", {})
        for domain, policy in list(domains.items())[:256] if isinstance(domains, dict) else []:
            collector.fragment({"kind": "ats_exception_domain", "source": "plist", "package": "Info.plist#NSAppTransportSecurity", "host": str(domain)[:253],
                                "flags": {str(k)[:128]: v for k, v in policy.items() if isinstance(v, (bool, int))} if isinstance(policy, dict) else {}})


def _strings_object(data):
    """Limited literal Apple .strings reader, with no escape/code evaluation."""
    text = data.decode("utf-16" if data.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig", "strict")
    result = {}
    pattern = r'"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;'
    for match in re.finditer(pattern, text):
        pair = []
        for literal in match.groups():
            try:
                pair.append(json.loads('"' + literal + '"'))
            except ValueError:
                pair.append(literal.replace('\\"', '"').replace('\\\\', '\\'))
        result[pair[0]] = pair[1]
        if len(result) >= 10000:
            break
    return result or None


def _hermes(path, name, collector, options, temporary, warnings):
    with path.open("rb") as stream:
        probe = probe_header(stream.read(32))
    hbc_dir = Path(tempfile.mkdtemp(prefix="hbc-", dir=temporary))
    result = disassemble(path, hbc_dir, probe["hbc_version"], options.hermes, options.hermes_executable,
                         options.worker_timeout, options.max_tool_output, options.worker_memory_bytes)
    if result["status"] == "complete":
        for output in result["files"]:
            if result.get("format") == "jsonl":
                with output.open(encoding="utf-8") as stream:
                    while line := stream.readline(65537):
                        if len(line) > 65536:
                            while line and not line.endswith("\n"):
                                line = stream.readline(65537)
                            warnings.append("HERMES_EVENT_LIMIT")
                            result["status"] = "partial"
                            continue
                        event = json.loads(line)
                        if event.get("event") == "string" and isinstance(event.get("value"), str):
                            for match in URL_TEXT.finditer(event["value"]):
                                collector.add(clean_url_literal(match.group()), "hermes", name + f"#string:{event.get('index')}", backend=result["backend"], backend_version=result.get("backend_version"), mode="structured_strings")
                        elif event.get("event") == "object" and isinstance(event.get("literal"), str):
                            for obj, _ in literal_objects(io.StringIO("# Object: " + event["literal"])):
                                collect_json(redact(obj), collector, "hermes", name + f"#function:{event.get('function')}:offset:{event.get('offset')}", backend=result["backend"], backend_version=result.get("backend_version"))
                        elif event.get("event") == "diagnostic":
                            warnings.append(event.get("code", "HERMES_PARTIAL"))
                            result["status"] = "partial"
            else:
                with output.open("rb") as stream:
                    for url, offset, _ in scan_urls(stream, options.chunk_bytes):
                        collector.add(url, "hermes", name, backend=result["backend"], backend_version=result.get("backend_version"), mode="disassembly_strings", offset=offset)
                if result["backend"] == "hermes-dec":
                    with output.open(encoding="utf-8", errors="replace") as stream:
                        for obj, line in literal_objects(stream):
                            collect_json(redact(obj), collector, "hermes", name + f"#object_line:{line}", backend=result["backend"], backend_version=result.get("backend_version"))
    else:
        warnings.append(result.get("code", "HERMES_PARTIAL"))
        with path.open("rb") as stream:
            for url, offset, _ in scan_urls(stream, options.chunk_bytes):
                collector.add(url, "hermes", name, mode="binary_printable", offset=offset)
    return {"stage": name, "status": result["status"], "format": "hermes", "hbc_version": probe["hbc_version"],
            "backend": result.get("backend", "stream_scan"), "backend_version": result.get("backend_version"), "fixture_verified": False}


def _copy_atomic(source: Path, target: Path):
    descriptor, temporary = tempfile.mkstemp(prefix="." + target.name + ".", dir=target.parent)
    try:
        with os.fdopen(descriptor, "wb") as outgoing, source.open("rb") as incoming:
            shutil.copyfileobj(incoming, outgoing, 65536)
            outgoing.flush()
            os.fsync(outgoing.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def extract_ios(artifact: str | Path, out: str | Path, options=None, *, app=None):
    options = _options(options)
    artifact, out = Path(artifact).expanduser(), Path(out).expanduser()
    if artifact.is_symlink() or out.is_symlink():
        raise InventoryError("IOS_SYMLINK", "Input/output root symlinks are unsupported")
    artifact, out = artifact.resolve(), out.resolve()
    if artifact.is_dir() and (out == artifact or artifact in out.parents):
        raise InventoryError("IOS_OUTPUT_INVALID", "Output must be outside the input App Bundle")
    started, warnings, stages, frameworks = time.monotonic(), [], [], set()
    with tempfile.TemporaryDirectory(prefix="ios-inventory-") as temporary, contextlib.ExitStack() as resources:
        temporary = Path(temporary)
        root, digest, artifact_type, selection = _snapshot(artifact, temporary, options, app)
        info_path = root / "Info.plist"
        try:
            info = plistlib.loads(_read_small(info_path, min(options.max_parser_bytes, PLIST_CAP)))
        except Exception:
            raise InventoryError("IOS_INFO_INVALID", "Info.plist is absent, oversized or cannot be decoded") from None
        if not isinstance(info, dict) or not isinstance(info.get("CFBundleIdentifier"), str) or not info["CFBundleIdentifier"].strip():
            raise InventoryError("IOS_INFO_INVALID", "Info.plist has no valid CFBundleIdentifier")
        bundle = info["CFBundleIdentifier"]
        if len(bundle) > 255 or any(ord(c) < 32 for c in bundle):
            raise InventoryError("IOS_INFO_INVALID", "CFBundleIdentifier exceeds identity limits")
        app_info = {"package_name": bundle, "bundle_id": bundle, "version_name": str(info.get("CFBundleShortVersionString", ""))[:256],
                    "version_code": str(info.get("CFBundleVersion", ""))[:256], "artifact_sha256": digest, "artifact_type": artifact_type}
        if artifact_type == "ipa":
            app_info["ipa_sha256"] = digest
        collector = Collector(temporary / "candidates.sqlite", options)
        resources.callback(collector.db.close)
        _plist_metadata(info, collector)
        files_ = _tree_files(root, options)
        metadata_bytes = 0
        executable = info.get("CFBundleExecutable")
        if isinstance(executable, str) and ("/" in executable or "\\" in executable or executable in {"", ".", ".."}):
            raise InventoryError("IOS_INFO_INVALID", "CFBundleExecutable must be a Bundle-local filename")
        found_main = False
        for name, path, file_info in files_:
            if collector.limited:
                break
            location = redact_text(name)
            if name.startswith(SKIP_PREFIXES) or name in SKIP_FILES:
                continue
            try:
                with path.open("rb") as stream:
                    header = stream.read(32)
                is_native = header[:4] in MACHO_MAGICS
                if is_native or name == executable or path.suffix == ".dylib":
                    found_main |= name == executable
                    if not getattr(options, "native", True):
                        warnings.append("NATIVE_DISABLED")
                        stages.append({"stage": location, "status": "partial", "code": "NATIVE_DISABLED"})
                        continue
                    native = run_parser("native", {"path": str(path), "location": location, "options": asdict(options)}, options)
                    for record in native.get("endpoints", []):
                        extra = {key: value for key, value in record.items() if key in {"section", "architecture", "slice", "slice_offset", "encoding", "virtual_address"}}
                        collector.add(record["url"], "native", location, method=None, backend=record.get("backend", "native"), backend_version=record.get("backend_version"), mode=record.get("mode", "section_strings"), offset=record.get("offset"), evidence_metadata=extra)
                    for fragment in native.get("fragments", []):
                        collector.fragment(fragment)
                    codes = [item.get("code", "NATIVE_PARTIAL") for item in native.get("limitations", []) if isinstance(item, dict)]
                    warnings.extend(codes)
                    metadata = redact(native.get("metadata", {}))
                    length = len(json.dumps(metadata, ensure_ascii=False).encode())
                    metadata_bytes += length
                    if metadata_bytes > options.max_tool_output:
                        warnings.append("IOS_NATIVE_REPORT_BUDGET")
                        metadata = {"code": "IOS_NATIVE_REPORT_BUDGET"}
                    stages.append({"stage": location, "status": "partial" if codes else "complete", "backend": "native", "metadata": metadata})
                    frameworks.add("native")
                    continue
                probe = probe_header(header)
                if probe["format"] == "hermes":
                    frameworks.add("react_native")
                    stages.append(_hermes(path, location, collector, options, temporary, warnings))
                    continue
                if name.endswith((".hbc", ".jsbundle", "index.ios.bundle", "main.jsbundle")):
                    frameworks.add("react_native")
                source = "plist" if path.suffix in {".plist", ".strings", ".stringsdict"} else "asset"
                structured = path.suffix in {".plist", ".strings", ".stringsdict", ".json"}
                if structured and file_info.st_size <= min(options.max_parser_bytes, PLIST_CAP):
                    data = _read_small(path, min(options.max_parser_bytes, PLIST_CAP))
                    value, backend = None, None
                    if path.suffix == ".json":
                        value, backend = json.loads(data), "json_config"
                    elif path.suffix != ".strings" or data.startswith((b"bplist", b"<?xml", b"<plist")):
                        value, backend = plistlib.loads(data), "plistlib"
                    else:
                        value = _strings_object(data)
                        if value is not None:
                            backend = "apple_strings_literals"
                    if backend:
                        # Do not turn URL scheme/ATS declarations into HTTP calls.
                        if name == "Info.plist":
                            value = {k: v for k, v in value.items() if k not in {"CFBundleURLTypes", "NSAppTransportSecurity", "LSApplicationQueriesSchemes"}}
                        collect_json(redact(value), collector, source, location, backend=backend)
                        stages.append({"stage": location, "status": "complete", "backend": backend})
                        continue
                elif structured:
                    warnings.append("IOS_RESOURCE_STRUCTURE_BUDGET")
                    stages.append({"stage": location, "status": "partial", "code": "IOS_RESOURCE_STRUCTURE_BUDGET"})
                with path.open("rb") as stream:
                    for url, offset, _ in scan_urls(stream, options.chunk_bytes):
                        collector.add(url, source, location, offset=offset, mode="stream_strings")
                if path.suffix in {".js", ".bundle", ".jsbundle"} and file_info.st_size <= min(options.max_parser_bytes, PLIST_CAP):
                    collect_js(_read_small(path, min(options.max_parser_bytes, PLIST_CAP)).decode("utf-8", "replace"), collector, "asset", location)
                elif path.suffix in {".js", ".bundle", ".jsbundle"}:
                    warnings.append("IOS_RESOURCE_STRUCTURE_BUDGET")
            except Exception as error:
                code = getattr(error, "code", "IOS_MEMBER_PARSE_FAILED")
                warnings.append(code)
                stages.append({"stage": location, "status": "partial", "code": code})
        if not executable:
            warnings.append("IOS_EXECUTABLE_UNDECLARED")
        elif not found_main:
            warnings.append("IOS_EXECUTABLE_MISSING")
        if collector.limited:
            warnings.append("CANDIDATE_BUDGET_REACHED")
        if collector.unsupported_query:
            warnings.append("UNSUPPORTED_QUERY_ENCODING")
        status = "partial" if warnings else "complete"
        report = {"schema_version": SCHEMA_VERSION, "status": status, "app": app_info, "artifact_type": artifact_type,
                  "selected_app": selection, "frameworks": sorted(frameworks), "stages": stages, "warnings": sorted(set(warnings)),
                  "endpoint_count": collector.count, "evidence_count": collector.evidence_count, "fragment_count": len(collector.fragments),
                  "duration_ms": round((time.monotonic() - started) * 1000),
                  "limits": {item.name: getattr(options, item.name) for item in fields(options) if item.name.startswith("max_") or item.name in {"worker_timeout", "worker_memory_bytes", "chunk_bytes"}},
                  "memory_budget_mode": "bounded_resource_reads_and_native_worker_process_tree_rss",
                  "limitations": ["Static candidates do not prove runtime use or HTTP method", "Encrypted Mach-O is not decrypted and encrypted ranges are not evidence", "Stripped symbols, Swift/ObjC indirection, string encryption and dynamic signatures may remain unresolved", "No iOS device launch, jailbreak, TLS bypass or pinning bypass is performed", "Hermes support depends on a compatible explicitly installed backend"]}
        out.mkdir(parents=True, exist_ok=True)
        static = out / "static"
        if static.is_symlink() or static.exists() and not static.is_dir():
            raise InventoryError("IOS_OUTPUT_INVALID", "Static generation path must be a local directory")
        static.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".ios-stage-", dir=out) as staging:
            generation = Path(staging) / "generation"
            generation.mkdir()
            _atomic_array(generation / "endpoints.static.json", collector.records())
            collector.write_evidence(generation / "evidence.jsonl")
            with (generation / "fragments.jsonl").open("w", encoding="utf-8") as stream:
                for fragment in collector.fragments:
                    stream.write(json.dumps(fragment, ensure_ascii=False) + "\n")
            atomic_json(generation / "hosts_summary.json", {"schema_version": SCHEMA_VERSION, "hosts": sorted(collector.hosts.values(), key=lambda h: (-h["occurrence_count"], h["host"]))})
            atomic_json(generation / "extraction_report.json", report)
            relative = "static/" + uuid.uuid4().hex
            published = out / relative
            os.replace(generation, published)
            for name in ("endpoints.static.json", "evidence.jsonl", "fragments.jsonl", "hosts_summary.json", "extraction_report.json"):
                _copy_atomic(published / name, out / name)
            source_id = "ios_" + re.sub(r"[^a-zA-Z0-9_-]", "_", bundle)[:120]
            descriptor = {"format": "endpoint-inventory", "schema_version": SCHEMA_VERSION, "kind": "ios", "source_id": source_id,
                          "inventory": relative + "/endpoints.static.json", "static_inventory": relative + "/endpoints.static.json",
                          "evidence": relative + "/evidence.jsonl", "app": app_info,
                          "inventory_sha256": sha256_file(published / "endpoints.static.json")}
            atomic_json(out / "source.json", descriptor)
    return {"status": status, "source_id": descriptor["source_id"], "output": str(out), "manifest": str(out / "source.json"),
            "endpoint_count": report["endpoint_count"], "warnings": report["warnings"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Offline IPA/App Bundle to evidence-backed HTTP inventory")
    parser.add_argument("artifact", help=".ipa file or .app directory")
    parser.add_argument("--out", required=True)
    parser.add_argument("--app", help="Select a top-level App Bundle in a multi-App IPA")
    parser.add_argument("--hermes", choices=["auto", "off", "required", "hermes-dec", "hbctool", "hbcdump", "official", "hermes_rs"], default="auto")
    parser.add_argument("--hermes-executable")
    parser.add_argument("--no-native", action="store_true")
    parser.add_argument("--limits", help="JSON or YAML extraction limits")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args(argv)
    try:
        overrides = {}
        if args.limits:
            data = _read_small(Path(args.limits), 65536)
            if args.limits.endswith(".json"):
                overrides = json.loads(data)
            else:
                import yaml
                overrides = yaml.safe_load(data)
            allowed = {item.name for item in fields(ExtractOptions) if item.name.startswith("max_") or item.name in {"worker_timeout", "worker_memory_bytes", "chunk_bytes"}}
            if not isinstance(overrides, dict) or set(overrides) - allowed:
                raise InventoryError("CONFIG_INVALID", "Unknown limit names")
        arguments = {"hermes": args.hermes, "hermes_executable": args.hermes_executable, "strict": args.strict, **overrides}
        if "native" in {item.name for item in fields(ExtractOptions)}:
            arguments["native"] = not args.no_native
        options = _options(ExtractOptions(**arguments))
        if args.no_native and not hasattr(options, "native"):
            options.native = False
        summary = extract_ios(args.artifact, args.out, options, app=args.app)
        print(json.dumps(summary, ensure_ascii=False))
        required_failed = args.hermes == "required" and any(code.startswith("HERMES_") for code in summary["warnings"])
        return 3 if args.strict and summary["status"] == "partial" or required_failed else 0
    except Exception as error:
        print(json.dumps({"status": "failed", "error": {"code": getattr(error, "code", "IOS_EXTRACTION_FAILED"),
                        "message": str(error) if isinstance(error, InventoryError) else type(error).__name__}}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
