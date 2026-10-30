#!/usr/bin/env python3
"""Device acceptance inspector; business actions in the test use MCP.

All operations use the real MobileSession/WebDriver/OCR implementation. There
are no synthetic WebDriver responses or injected OCR blocks in this bridge.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import signal
import sys

from apk_inventory.mobile_ui import DeviceLease, MobileError, MobileSession, atomic_json, read_json
from apk_inventory.mobile_visual_workflow import region_text
from apk_inventory import mobile_visual_ios_text as visual


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation", choices=("learn", "execute", "inspect"), required=True)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--definition", type=Path)
    parser.add_argument("--samples", type=Path)
    parser.add_argument("--recipe", type=Path)
    parser.add_argument("--inputs", type=Path)
    parser.add_argument("--revision")
    args = parser.parse_args()
    session, handlers = None, {}
    try:
        if args.output.is_symlink():
            raise MobileError("OUTPUT_SYMLINK_REJECTED", "blocked")
        session = MobileSession(read_json(args.config), args.output)
        for sig in (signal.SIGINT, signal.SIGTERM):
            handlers[sig] = signal.getsignal(sig)
            signal.signal(sig, lambda *_: setattr(session.budget, "cancelled", True))
        if args.operation == "learn":
            result = visual.learn(session, read_json(args.definition), read_json(args.samples, 65536))
        elif args.operation == "execute":
            recipe = read_json(args.recipe)
            result = visual.execute(session, recipe, args.revision, read_json(args.inputs, 65536))
        else:
            definition = visual.definition_contract(read_json(args.definition))
            config = visual.config_contract(session, definition, False)
            session.backend.verify_artifact()
            session.backend.foreground()
            with DeviceLease(session.backend) as lease:
                observation = visual._observe(session, lease, config)
                result = {"ok": True, "status": "observed", "outputs": {
                    "value": region_text(observation, definition["valueRegion"]),
                    "text": region_text(observation, definition["resultRegion"]),
                }, "writeOutcome": {"status": "not_started", "automaticRetry": False}}
    except (MobileError, OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        result = {"ok": False, "status": getattr(error, "status", "failed"),
                  "error": {"code": getattr(error, "code", "VISUAL_TEXT_TEST_FAILED")},
                  "writeOutcome": getattr(error, "writeOutcome", {
                      "status": "unknown" if session is not None and getattr(session, "_visual_dispatched", False) else "not_started",
                      "automaticRetry": False})}
        if session is not None:
            session.progress["status"] = result["status"]
            session.progress["gaps"] = list(dict.fromkeys(session.progress["gaps"] + [result["error"]["code"]]))
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
    if session is not None:
        result["artifactVerification"] = dict(session.backend.artifact_verification)
        result["appArtifactVerified"] = session.backend.artifact_verification["status"] == "verified"
        session.checkpoint()
    atomic_json(args.output / "result.json", result)
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 0 if session is not None else 2


if __name__ == "__main__":
    sys.exit(main())
