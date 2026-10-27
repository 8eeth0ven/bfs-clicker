"""Hermes capability probing and budgeted optional CLI adapters."""
from __future__ import annotations

import os
import ast
import re
import shutil
import signal
import struct
import subprocess
import tempfile
import time
from pathlib import Path
from .budget import rss_tree

HBC_MAGIC = bytes.fromhex("c61fbc03c103191f")
HBC_TOOL_VERSIONS = {59, 62, 74, 76}
HERMES_DEC_VERSIONS = {72, 73, 76, 80, 81, 82, 83, 84, 85, 86, 87, 89, 90, 92, 93, 94, 95, 96}
HERMES_RS_VERSIONS = {76, 89, 90, 93, 94, 95, 96}


def probe_header(header: bytes) -> dict:
    if header[:8] == HBC_MAGIC and len(header) >= 12:
        return {"format": "hermes", "hbc_version": struct.unpack_from("<I", header, 8)[0]}
    return {"format": "javascript" if header.lstrip().startswith((b"var ", b"function", b"(()=>", b"__d(", b"/**", b"const ", b"!function")) else "unknown", "hbc_version": None}


def run_bounded(argv: list[str], output: Path, timeout: float = 30, max_output: int = 32 * 1024 * 1024, watch_dir: Path | None = None, env: dict | None = None, memory_limit: int = 768 * 1024 * 1024) -> dict:
    """Write tool output to disk; never accumulate disassembly in memory."""
    started = time.monotonic()
    limit_file_size = None
    if os.name == "posix":
        import resource
        def limit_file_size():
            resource.setrlimit(resource.RLIMIT_FSIZE, (max_output, max_output))
    with output.open("wb") as stream, tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(argv, stdout=stream, stderr=errors, shell=False, start_new_session=True, env=env, preexec_fn=limit_file_size)
        timed_out = too_large = memory_limited = False
        peak_rss = 0
        try:
            while process.poll() is None:
                if time.monotonic() - started > timeout:
                    timed_out = True
                    break
                resident = rss_tree(process.pid)
                peak_rss = max(peak_rss, resident)
                if resident > memory_limit:
                    memory_limited = True
                    break
                directory_bytes = sum(p.stat().st_size for p in watch_dir.rglob("*") if p.is_file()) if watch_dir and watch_dir.exists() else 0
                if output.stat().st_size + os.fstat(errors.fileno()).st_size + directory_bytes > max_output:
                    too_large = True
                    break
                time.sleep(0.05)
            if timed_out or too_large or memory_limited:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=2)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        final_directory_bytes = sum(p.stat().st_size for p in watch_dir.rglob("*") if p.is_file()) if watch_dir and watch_dir.exists() else 0
        too_large = too_large or output.stat().st_size + os.fstat(errors.fileno()).st_size + final_directory_bytes > max_output
    return {"returncode": process.returncode, "timed_out": timed_out, "memory_limited": memory_limited, "peak_rss_bytes": peak_rss, "output_limited": too_large, "elapsed_ms": round((time.monotonic() - started) * 1000)}


def available_backend(version: int, requested: str = "auto", executable: str | None = None) -> tuple[str, str] | None:
    candidates = [("hermes-dec", "hbc-disassembler"), ("hbctool", "hbctool")]
    if requested not in {"auto", "off", "required"}:
        candidates = [(requested, executable or requested)]
    for name, command in candidates:
        if name == "hbctool" and version not in HBC_TOOL_VERSIONS:
            continue
        # hermes-dec itself warns newer HBC formats are not formally supported.
        if name == "hermes-dec" and version not in HERMES_DEC_VERSIONS:
            continue
        if name == "hermes_rs" and version not in HERMES_RS_VERSIONS:
            continue
        path = executable if requested == name and executable else shutil.which(command)
        if path:
            return name, path
    return None


def tool_version(binary: str, temp_dir: Path) -> str | None:
    output = temp_dir / "tool-version.txt"
    try:
        result = run_bounded([binary, "--version"], output, timeout=3, max_output=16384)
        if result["returncode"] != 0:
            return None
        text = output.read_text(encoding="utf-8", errors="replace").strip().splitlines()
        # Version diagnostics are identifiers, never arbitrary tool logs.
        return text[0][:160] if text and re.fullmatch(r"[A-Za-z0-9_. +/():-]{1,160}", text[0][:160]) else None
    except (OSError, subprocess.SubprocessError):
        return None


def literal_objects(stream):
    """Read only literal dict comments emitted by hermes-dec.

    Python AST is inspected but never executed. JavaScript primitive names are
    accepted only as Name nodes; calls/attributes/expressions are rejected.
    """
    def convert(node, depth=0):
        if depth > 12:
            raise ValueError()
        if isinstance(node, ast.Constant) and isinstance(node.value, (str, int, float, bool, type(None))):
            return node.value
        if isinstance(node, ast.Name) and node.id in {"null", "undefined", "true", "false"}:
            return {"null": None, "undefined": None, "true": True, "false": False}[node.id]
        if isinstance(node, ast.Dict) and len(node.keys) <= 256:
            values = [(convert(k, depth + 1), convert(v, depth + 1)) for k, v in zip(node.keys, node.values)]
            if not all(isinstance(k, str) for k, _ in values):
                raise ValueError()
            return dict(values)
        if isinstance(node, (ast.List, ast.Tuple)) and len(node.elts) <= 256:
            return [convert(v, depth + 1) for v in node.elts]
        raise ValueError()
    line_number = 0
    while True:
        line = stream.readline(65537)
        if not line:
            break
        line_number += 1
        if len(line) > 65536:
            while line and not line.endswith("\n"):
                line = stream.readline(65537)
            continue
        if "# Object: " not in line:
            continue
        try:
            expression = ast.parse(line.split("# Object: ", 1)[1].strip(), mode="eval")
            result = convert(expression.body)
            if isinstance(result, dict):
                yield result, line_number
        except (ValueError, SyntaxError, RecursionError):
            continue


def disassemble(path: Path, temp_dir: Path, version: int, requested="auto", executable=None, timeout=30, max_output=32 * 1024 * 1024, memory_limit=768 * 1024 * 1024) -> dict:
    if requested == "off":
        return {"status": "fallback", "code": "HERMES_DISABLED"}
    backend = available_backend(version, requested, executable)
    if backend is None:
        return {"status": "fallback", "code": "HERMES_BACKEND_UNAVAILABLE", "hbc_version": version}
    name, binary = backend
    output = temp_dir / "hermes-output.txt"
    output_format = "text"
    if name == "hermes-dec":
        argv = [binary, str(path)]
        # pip console entry points identify the exact Python environment where
        # hermes-dec is installed. Use that environment for a stable JSONL
        # strings/object bridge instead of parsing a 40MB disassembly listing.
        try:
            with open(binary, "rb") as stream:
                shebang = stream.readline(512).decode("utf-8", "strict").strip()
            interpreter = shebang[2:] if shebang.startswith("#!/") and "python" in shebang.lower() and " " not in shebang[2:] else None
            if interpreter and Path(interpreter).is_file():
                argv = [interpreter, str(Path(__file__).with_name("hermes_bridge.py")), str(path)]
                output_format = "jsonl"
        except (OSError, UnicodeError):
            pass
    elif name == "hbctool":
        target = temp_dir / "hbctool-output"
        argv = [binary, "disasm", str(path), str(target)]
    elif name in {"hbcdump", "official"}:
        # Dump mode only; no bytecode execution.
        argv = [binary, str(path), "-c", "disassemble;quit"]
    elif name == "hermes_rs":
        # A user-configured strings-only binary is accepted. Its text output is
        # scanned as evidence, never treated as a stable JSON protocol.
        argv = [binary, str(path)]
    else:
        return {"status": "fallback", "code": "HERMES_BACKEND_UNSUPPORTED"}
    outcome = run_bounded(argv, output, timeout, max_output, temp_dir / "hbctool-output" if name == "hbctool" else None, memory_limit=memory_limit)
    if outcome["returncode"] or outcome["timed_out"] or outcome["output_limited"] or outcome["memory_limited"]:
        return {"status": "fallback", "code": "HERMES_TOOL_FAILED", "backend": name, **outcome}
    files = [output]
    if name == "hbctool":
        files = [p for p in (temp_dir / "hbctool-output").rglob("*") if p.is_file()]
        if sum(p.stat().st_size for p in files) > max_output:
            return {"status": "fallback", "code": "HERMES_OUTPUT_LIMIT", "backend": name}
    return {"status": "complete", "backend": name, "backend_version": tool_version(binary, temp_dir), "hbc_version": version, "files": files, "format": output_format, "fixture_verified": False, **outcome}
