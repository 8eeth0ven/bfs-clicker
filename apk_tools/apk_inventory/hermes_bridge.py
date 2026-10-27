"""JSONL bridge executed by the configured hermes-dec CLI's Python.

This file only parses HBC data. It never invokes the Hermes VM or evaluates JS.
It intentionally uses stdlib + hermes_dec so its host need not install this
Python package. The parent supplies process/time/output/RSS budgets.
"""
import json
import sys
import os
import contextlib
from importlib.metadata import version


def emit(reader, parse_hbc_bytecode, publish):
    publish({"event": "header", "hbc_version": reader.header.version,
             "backend_version": version("hermes_dec")})
    for index, value in enumerate(reader.strings):
        publish({"event": "string", "index": index, "value": value})
    instructions = 0
    failures = 0
    for function_index, header in enumerate(reader.function_headers):
        try:
            for instruction in parse_hbc_bytecode(header, reader):
                instructions += 1
                if instructions > 2_000_000:
                    publish({"event": "diagnostic", "code": "HERMES_INSTRUCTION_BUDGET"})
                    return 0
                if instruction.inst.name not in {"NewObjectWithBuffer", "NewObjectWithBufferLong"}:
                    continue
                # hermes-dec already associates the object's key/value buffers
                # with this exact instruction; never evaluate any app code.
                representation = repr(instruction)
                if "# Object: " in representation:
                    publish({"event": "object", "function": function_index,
                             "offset": instruction.original_pos,
                             "literal": representation.split("# Object: ", 1)[1]})
        except Exception:
            failures += 1
            publish({"event": "diagnostic", "code": "HERMES_FUNCTION_PARSE_FAILED", "function": function_index})
            if failures >= 64:
                return 0
    return 0


def main():
    if len(sys.argv) != 2:
        return 2
    protocol_stdout = sys.stdout
    def publish(value):
        protocol_stdout.write(json.dumps(value, ensure_ascii=True) + "\n")
    # Third-party debug output can contain package literals. It never enters
    # stdout or stderr; only versioned events above leave this bridge.
    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        from hermes_dec.parsers.hbc_file_parser import HBCReader
        from hermes_dec.parsers.hbc_bytecode_parser import parse_hbc_bytecode
        reader = HBCReader()
        # HBCReader retains file_buffer and seeks it during instruction parsing.
        with open(sys.argv[1], "rb") as stream:
            reader.read_whole_file(stream)
            return emit(reader, parse_hbc_bytecode, publish)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        # Stable machine error, no arbitrary HBC string in a traceback.
        print(json.dumps({"event": "diagnostic", "code": "HERMES_BRIDGE_FAILED"}))
        raise SystemExit(2)
