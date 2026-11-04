#!/usr/bin/env python3
"""Offline audit of retained proxy requests, key events and AX XML originals.

No HTTP, device, screenshot or OCR calls. Run from the same frozen source tree
as the accepted native implementation. --allow-final-prefix is diagnostic only
and always emits complete:false / usableForSuccessAcceptance:false.
Outside finger coordinates require the separate grounded request-window audit.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
from types import SimpleNamespace
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apk_tools"))
from apk_inventory import mobile_visual_ios_keys as native

MAX_FILE = 32 * 1024 * 1024
MAX_XML = 4 * 1024 * 1024
sha = lambda value: hashlib.sha256(value).hexdigest()


class AuditError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def need(value, code):
    if not value:
        raise AuditError(code)


def integer(value):
    return type(value) is int and 0 <= value < 2 ** 53


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and 0 <= value < 2 ** 53


def exact(value, names):
    return type(value) is dict and set(value) == set(names)


def no_duplicate_keys(pairs):
    value = {}
    for key, item in pairs:
        need(key not in value, "DUPLICATE_JSON_KEY")
        value[key] = item
    return value


def parse_json(value):
    try:
        return json.loads(value, object_pairs_hook=no_duplicate_keys,
                          parse_constant=lambda _: (_ for _ in ()).throw(AuditError("NONFINITE_JSON")))
    except (ValueError, UnicodeError):
        raise AuditError("INVALID_JSON") from None


def read_bytes(path, limit):
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_size <= limit, "FILE_NOT_REGULAR_OR_OVER_LIMIT")
        chunks, size = [], 0
        while size <= limit:
            chunk = os.read(fd, min(65536, limit + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        need(size == info.st_size and size <= limit, "FILE_CHANGED_OR_OVER_LIMIT")
        return b"".join(chunks)
    finally:
        os.close(fd)


def source_code_snapshot():
    names = ["test/ios-keyboard-key-sequence-audit.py",
             "apk_tools/apk_inventory/mobile_visual_ios_keys.py",
             "apk_tools/apk_inventory/mobile_visual_ios_keyboard.py",
             "apk_tools/apk_inventory/mobile_visual_ios_text.py",
             "apk_tools/apk_inventory/mobile_visual_workflow.py",
             "apk_tools/apk_inventory/mobile_ui.py"]
    return [{"path": name, "sha256": sha(read_bytes(ROOT / name, MAX_FILE))} for name in names]


def pointer(body, width, height):
    need(exact(body, ["actions"]) and type(body["actions"]) is list and len(body["actions"]) == 1,
         "POINTER_BODY_INVALID")
    p = body["actions"][0]
    need(exact(p, ["type", "id", "parameters", "actions"]) and p["type"] == "pointer"
         and p["id"] in ("finger", "keyboard-key") and p["parameters"] == {"pointerType": "touch"},
         "POINTER_IDENTITY_INVALID")
    need(type(p["actions"]) is list and len(p["actions"]) == 3, "POINTER_SEQUENCE_INVALID")
    move, down, up = p["actions"]
    need(exact(move, ["type", "duration", "x", "y", "origin"])
         and move["type"] == "pointerMove" and type(move["duration"]) is int and move["duration"] == 0
         and move["origin"] == "viewport" and integer(move["x"]) and integer(move["y"])
         and move["x"] < width and move["y"] < height, "POINTER_MOVE_INVALID")
    for item, kind in [(down, "pointerDown"), (up, "pointerUp")]:
        need(exact(item, ["type", "button"]) and item["type"] == kind
             and type(item["button"]) is int and item["button"] == 0, "POINTER_BUTTON_INVALID")
    return p["id"], (move["x"], move["y"])


def audit(rows, events, source_dir, device_config, width, height, plan, allow_final_prefix=False):
    need(type(allow_final_prefix) is bool, "PREFIX_FLAG_INVALID")
    need(number(width) and number(height) and 0 < width <= 16384 and 0 < height <= 16384, "GEOMETRY_INVALID")
    need(type(rows) is list and 0 < len(rows) <= 100000, "REQUESTS_INVALID")
    need(type(events) is list and len(events) <= 10000, "EVENTS_INVALID")
    need(type(plan) is list and 0 < len(plan) <= 64, "PLAN_INVALID")
    for index, entry in enumerate(plan):
        need(type(entry) is dict and {"input", "clear"} <= set(entry)
             and not set(entry) - {"input", "clear", "finalOutside"} and type(entry["input"]) is str
             and re.fullmatch(r"[A-Za-z0-9]{1,16}", entry["input"])
             and integer(entry["clear"]) and entry["clear"] <= 16
             and type(entry.get("finalOutside", 2)) is int and entry.get("finalOutside", 2) in (0, 2)
             and (index == len(plan) - 1 or entry.get("finalOutside", 2) == 2), "PLAN_INVALID")
    need(type(device_config) is dict and type(device_config.get("backend")) is dict, "DEVICE_CONFIG_INVALID")
    backend = device_config["backend"]
    session_id, app_id = backend.get("sessionId"), backend.get("appId")
    need(backend.get("type") == "webdriver" and backend.get("platform") == "ios"
         and type(session_id) is str and re.fullmatch(r"[A-Za-z0-9._:-]{1,256}", session_id)
         and type(app_id) is str and re.fullmatch(r"[A-Za-z0-9_.-]{1,256}", app_id), "DEVICE_CONFIG_INVALID")
    config = device_config.get("nativeVisualWorkflow")
    need(type(config) is dict and type(config.get("keyboard")) is dict, "DEVICE_CONFIG_INVALID")
    keyboard = config["keyboard"]
    try:
        native.key_input_contract(keyboard["keyInput"], {"inputSchema": {"pattern": "^[A-Za-z0-9]+$", "maxLength": 16}})
        region = keyboard["region"]
        need(exact(region, ["x", "y", "width", "height"])
             and all(number(v) for v in region.values()) and region["width"] > 0 and region["height"] > 0
             and region["x"] + region["width"] <= 1 and region["y"] + region["height"] <= 1,
             "DEVICE_CONFIG_INVALID")
    except (KeyError, TypeError, native.MobileError):
        raise AuditError("DEVICE_CONFIG_INVALID") from None
    source_dir = Path(source_dir)
    need(source_dir.is_dir() and not source_dir.is_symlink(), "SOURCE_DIRECTORY_INVALID")
    source_dir = source_dir.resolve()
    prefix = "/session/" + quote(session_id, safe="")
    sources, key_rows, fingers, receipts, total_source_bytes = [], [], [], [], 0
    previous_id, previous_started = None, None
    for row in rows:
        need(type(row) is dict and integer(row.get("id")) and number(row.get("started"))
             and number(row.get("finished")) and row["finished"] >= row["started"]
             and type(row.get("responseStatus")) is int and 200 <= row["responseStatus"] < 300
             and not row.get("error"), "REQUEST_UNFINISHED_OR_FAILED")
        need(previous_id is None or row["id"] == previous_id + 1, "REQUEST_IDS_NOT_CONTIGUOUS")
        need(previous_started is None or row["started"] >= previous_started, "REQUEST_TIME_ORDER")
        previous_id, previous_started = row["id"], row["started"]
        need(type(row.get("path")) is str and row["path"].startswith(prefix + "/"), "REQUEST_SESSION_MISMATCH")
        route = row["path"][len(prefix):]
        need("?" not in route and "#" not in route, "REQUEST_ROUTE_INVALID")
        method, body = row.get("method"), row.get("body", "")
        need(type(body) is str and len(body.encode("utf8")) <= 65536, "REQUEST_BODY_INVALID")
        if method == "GET" and route in ("/source", "/screenshot", "/orientation", "/window/rect"):
            need(body == "", "GET_BODY_INVALID")
            if route == "/source":
                artifact = row.get("sourceArtifact")
                need(not row.get("sourceCaptureError") and exact(artifact, ["file", "sha256", "bytes"])
                     and artifact["file"] == "source-response-" + str(row["id"]) + ".xml"
                     and type(artifact["sha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", artifact["sha256"])
                     and integer(artifact["bytes"]), "SOURCE_ARTIFACT_INVALID")
                file = source_dir / artifact["file"]
                need(not file.is_symlink() and file.parent == source_dir, "SOURCE_PATH_INVALID")
                data = read_bytes(file, MAX_XML)
                total_source_bytes += len(data)
                need(total_source_bytes <= 128 * 1024 * 1024, "SOURCE_TOTAL_LIMIT")
                need(len(data) == artifact["bytes"] and sha(data) == artifact["sha256"], "SOURCE_HASH_MISMATCH")
                try:
                    raw = data.decode("utf8", errors="strict")
                except UnicodeError:
                    raise AuditError("SOURCE_UTF8_INVALID") from None
                sources.append({"row": row, "raw": raw, "sha256": artifact["sha256"]})
                receipts.append({"requestId": row["id"], **artifact})
            continue
        parsed = parse_json(body)
        if method == "POST" and route == "/execute/sync":
            need(parsed == {"script": "mobile: activeAppInfo", "args": []}, "EXECUTE_NOT_FOREGROUND")
            continue
        need(method == "POST" and route == "/actions", "EXTRA_REQUEST_ROUTE")
        identity, point = pointer(parsed, width, height)
        k = region
        inside = k["x"] * width <= point[0] < (k["x"] + k["width"]) * width and k["y"] * height <= point[1] < (k["y"] + k["height"]) * height
        if identity == "keyboard-key":
            need(inside, "KEY_POINT_OUTSIDE_KEYBOARD")
            key_rows.append({"row": row, "point": point})
        else:
            need(not inside, "FINGER_INSIDE_KEYBOARD")
            fingers.append(row)

    pairs, opened, last_event_time = [], None, None
    for event in events:
        need(type(event) is dict and type(event.get("kind")) is str, "EVENT_INVALID")
        kind = event["kind"]
        if not kind.startswith("visual_keyboard_key_"):
            continue
        need(kind in ("visual_keyboard_key_started", "visual_keyboard_key_finished"), "UNKNOWN_KEY_EVENT")
        need(event.get("schemaVersion") == 1 and type(event.get("schemaVersion")) is int
             and number(event.get("timestampMs")) and integer(event.get("ordinal")) and 1 <= event["ordinal"] <= 64
             and event.get("phase") in ("clear", "switch", "type") and event.get("control") in ("literal", "delete", "shift", "numbers", "letters")
             and event.get("automaticRetry") is False and type(event.get("sourceSha256")) is str
             and re.fullmatch(r"[a-f0-9]{64}", event["sourceSha256"]), "KEY_EVENT_INVALID")
        need(last_event_time is None or event["timestampMs"] >= last_event_time, "EVENT_TIME_ORDER")
        last_event_time = event["timestampMs"]
        if kind.endswith("_started"):
            need(opened is None and event.get("status") == "unknown", "KEY_EVENT_DUPLICATE_START")
            opened = event
        else:
            need(opened is not None and event.get("status") == "dispatched", "KEY_EVENT_WITHOUT_START")
            need(all(opened[k] == event[k] for k in ("ordinal", "phase", "control", "sourceSha256", "automaticRetry")), "KEY_EVENT_PAIR_MISMATCH")
            pairs.append((opened, event))
            opened = None
    need(opened is None, "KEY_EVENT_UNFINISHED")
    need(len(pairs) == len(key_rows), "KEY_EVENT_REQUEST_COUNT_MISMATCH")
    parsed_sources = {}

    def parse_source(item):
        key = item["sha256"]
        if key not in parsed_sources:
            def request(method, route):
                need(method == "GET" and route == "/source", "OFFLINE_PARSER_REQUEST_INVALID")
                return item["raw"]
            session = SimpleNamespace(budget=SimpleNamespace(check=lambda: None), backend=SimpleNamespace(
                foreground=lambda: None, request=request, app_id=app_id))
            try:
                state = native.read_source(session, config, {"width": width, "height": height}, (width, height))
                k = native._keyboard()
                keyboard_node, = k._parse_source(item["raw"], app_id, unique=True)
                state["_allVisibleKeyTargets"] = [k._rect(node) for node in keyboard_node.iter()
                    if node.attrib.get("type", node.tag) in ("XCUIElementTypeKey", "XCUIElementTypeButton")
                    and node.attrib.get("visible") == "true"]
                parsed_sources[key] = state
            except native.MobileError:
                raise AuditError("NATIVE_SOURCE_INVALID") from None
        return parsed_sources[key]

    resolved = []
    for (begin, finish), action in zip(pairs, key_rows):
        row = action["row"]
        need(begin["timestampMs"] <= row["started"] <= row["finished"] <= finish["timestampMs"], "KEY_REQUEST_EVENT_TIME_MISMATCH")
        eligible = [s for s in sources if s["row"]["id"] < row["id"] and s["row"]["finished"] <= row["started"]]
        need(eligible, "LATEST_SOURCE_MISSING")
        latest = max(eligible, key=lambda s: (s["row"]["finished"], s["row"]["id"]))
        need(latest["row"]["id"] < row["id"] and latest["sha256"] == begin["sourceSha256"], "LATEST_SOURCE_EVENT_HASH_MISMATCH")
        need(not any(latest["row"]["id"] < previous["id"] < row["id"]
                     for previous in fingers + [item["row"] for item in key_rows]), "SOURCE_NOT_FRESH_SINCE_ACTION")
        need(not any(s["row"]["id"] < row["id"] and s["row"]["started"] <= row["started"] < s["row"]["finished"] for s in sources), "SOURCE_IN_FLIGHT_AT_KEY")
        source, matches = parse_source(latest), []
        for literal, target in source["literals"].items():
            matches.append(("literal", literal, target))
        for control, target in source["controls"].items():
            matches.append(("control", control, target))
        x, y = action["point"]
        matches = [(kind, value, target) for kind, value, target in matches
                   if target["rect"][0] <= x < target["rect"][0] + target["rect"][2]
                   and target["rect"][1] <= y < target["rect"][1] + target["rect"][3]]
        need(len(matches) == 1, "KEY_TARGET_NOT_UNIQUE")
        kind, value, target = matches[0]
        need(sum(tx <= x < tx + tw and ty <= y < ty + th
                 for tx, ty, tw, th in source["_allVisibleKeyTargets"]) == 1, "KEY_TARGET_NOT_UNIQUE")
        try:
            native._target(source, value, kind == "literal")
        except native.MobileError:
            raise AuditError("KEY_TARGET_INVALID") from None
        tx, ty, tw, th = target["rect"]
        need(action["point"] == (int(tx + tw / 2), int(ty + th / 2)), "KEY_POINT_NOT_CENTER")
        need((begin["phase"] == "type" and kind == "literal" and begin["control"] == "literal")
             or (begin["phase"] == "clear" and kind == "control" and value == begin["control"] == "delete")
             or (begin["phase"] == "switch" and kind == "control" and value == begin["control"] and value in ("shift", "numbers", "letters")),
             "KEY_PHASE_CONTROL_MISMATCH")
        resolved.append({"ordinal": begin["ordinal"], "phase": begin["phase"], "targetKind": kind, "target": value,
                         "sourceLayer": source["layer"], "sourceSha256": latest["sha256"],
                         "sourceRequestId": latest["row"]["id"], "sourceArtifact": latest["row"]["sourceArtifact"]["file"],
                         "requestId": row["id"], "point": {"x": x, "y": y}})

    flows, current = [], None

    def done(flow):
        wanted = plan[flow["index"]]
        return flow["cleared"] == wanted["clear"] and flow["typed"] == len(wanted["input"]) and not flow["pendingSwitch"]

    for key in resolved:
        if key["ordinal"] == 1:
            need(current is None or done(current), "FLOW_RESET_BEFORE_PLAN_COMPLETE")
            need(len(flows) < len(plan), "EXTRA_FLOW")
            current = {"index": len(flows), "cleared": 0, "typed": 0, "switchesForCharacter": 0, "pendingSwitch": None, "keys": []}
            flows.append(current)
        need(current is not None and key["ordinal"] == len(current["keys"]) + 1, "ORDINAL_SEQUENCE_INVALID")
        if current["pendingSwitch"]:
            need(key["sourceLayer"] in current["pendingSwitch"], "SWITCH_LAYER_NOT_CHANGED")
            current["pendingSwitch"] = None
        wanted = plan[current["index"]]
        if key["phase"] == "clear":
            need(current["typed"] == 0 and current["switchesForCharacter"] == 0
                 and current["cleared"] < wanted["clear"], "CLEAR_COUNT_OR_ORDER_INVALID")
            current["cleared"] += 1
        else:
            need(current["cleared"] == wanted["clear"] and current["typed"] < len(wanted["input"]), "TYPE_BEFORE_CLEAR_OR_EXTRA_KEY")
            char = wanted["input"][current["typed"]]
            expected_layer = "digits" if char.isdigit() else "upper" if char.isupper() else "lower"
            if key["phase"] == "switch":
                need(key["sourceLayer"] != expected_layer and current["switchesForCharacter"] < 2, "UNNECESSARY_OR_EXTRA_SWITCH")
                expected = "letters" if key["sourceLayer"] == "digits" else "numbers" if expected_layer == "digits" else "shift"
                need(key["target"] == expected, "WRONG_SWITCH_CONTROL")
                current["switchesForCharacter"] += 1
                current["pendingSwitch"] = ("lower", "upper") if expected == "letters" else (expected_layer,)
            else:
                need(key["target"] == char and key["sourceLayer"] == expected_layer, "TYPE_LITERAL_MISMATCH")
                current["typed"] += 1
                current["switchesForCharacter"] = 0
        key["flow"] = current["index"] + 1
        current["keys"].append(key)

    if current and current["pendingSwitch"]:
        last_action = key_rows[-1]["row"]
        after = [s for s in sources if s["row"]["id"] > last_action["id"] and s["row"]["started"] >= last_action["finished"]]
        need(after, "SWITCH_POST_SOURCE_MISSING")
        final_source = parse_source(max(after, key=lambda s: (s["row"]["finished"], s["row"]["id"])))
        need(final_source["layer"] in current["pendingSwitch"], "SWITCH_LAYER_NOT_CHANGED")
        current["pendingSwitch"] = None
    plans_complete = len(flows) == len(plan) and all(done(flow) for flow in flows)
    need(allow_final_prefix or plans_complete, "PLAN_NOT_COMPLETE")
    need(all(done(flow) for flow in flows[:-1]), "NONFINAL_FLOW_INCOMPLETE")
    # The separate request auditor grounds these finger actions to real anchors.
    # Here enforce only exact count/placement, never infer their semantic role.
    if resolved:
        first = flows[0]["keys"][0]["requestId"]
        need(len([r for r in fingers if r["id"] < first]) == 1, "OUTSIDE_ACTIONS_BEFORE_FLOW")
        for left, right in zip(flows, flows[1:]):
            lo, hi = left["keys"][-1]["requestId"], right["keys"][0]["requestId"]
            need(len([r for r in fingers if lo < r["id"] < hi]) == 3, "OUTSIDE_ACTIONS_BETWEEN_FLOWS")
        for flow in flows:
            lo, hi = flow["keys"][0]["requestId"], flow["keys"][-1]["requestId"]
            need(not any(lo < r["id"] < hi for r in fingers), "OUTSIDE_ACTION_DURING_KEYS")
        tail = len([r for r in fingers if r["id"] > resolved[-1]["requestId"]])
        expected_tail = plan[len(flows) - 1].get("finalOutside", 2)
        need(tail in range(expected_tail + 1) if allow_final_prefix and plans_complete else tail == 0 if allow_final_prefix else tail == expected_tail,
             "OUTSIDE_ACTIONS_AFTER_FLOW")
    else:
        need(allow_final_prefix and len(fingers) <= 1, "NO_KEY_FLOW")
    for receipt in receipts:
        file = source_dir / receipt["file"]
        need(not file.is_symlink() and sha(read_bytes(file, MAX_XML)) == receipt["sha256"], "SOURCE_CHANGED_DURING_AUDIT")
    return {"schemaVersion": 1, "kind": "ios_keyboard_key_sequence_audit", "auditPassed": True,
            "complete": plans_complete and not allow_final_prefix, "keyPlansComplete": plans_complete,
            "mcpAcceptance": False, "keyPlanGateOnly": True,
            "diagnosticFinalPrefixMode": allow_final_prefix,
            "usableForSuccessAcceptance": plans_complete and not allow_final_prefix,
            "requests": len(rows), "keyActions": len(resolved), "pairedKeyEvents": len(pairs),
            "outsideFingerActions": len(fingers), "outsideAnchorsGroundedHere": False,
            "requiresSeparateGroundedRequestAudit": True, "expectedFlows": len(plan), "observedFlows": len(flows),
            "flows": [{"flow": f["index"] + 1, "expectedInputSha256": sha(plan[f["index"]]["input"].encode()),
                       "expectedCharacters": len(plan[f["index"]]["input"]), "expectedClear": plan[f["index"]]["clear"],
                       "expectedFinalOutside": plan[f["index"]].get("finalOutside", 2),
                       "actualClear": f["cleared"], "actualCharacters": f["typed"], "complete": done(f), "keys": f["keys"]} for f in flows],
            "sourceArtifacts": receipts,
            "limits": ["Complete means the key plan only, never MCP acceptance. Business outcome and anchor audit must pass separately.",
                       "Retained AX identity/geometry and key plan only; no OCR/input echo, business outcome or OS window ownership proof.",
                       "Outside finger roles/coordinates must also pass the separate grounded request audit.",
                       "Prefix diagnostic mode never counts as successful complete device acceptance."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("requests", "events", "source-dir", "device-config", "plan", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--width", required=True, type=float)
    parser.add_argument("--height", required=True, type=float)
    parser.add_argument("--allow-final-prefix", action="store_true")
    args = parser.parse_args()
    input_paths = [args.requests, args.events, args.device_config, args.plan]
    try:
        need(args.output.resolve() not in {p.resolve() for p in input_paths}
             and not re.fullmatch(r"source-response-\d+\.xml", args.output.name), "OUTPUT_WOULD_OVERWRITE_INPUT")
        before = source_code_snapshot()
        payloads = [read_bytes(p, MAX_FILE if i == 0 else 8 * 1024 * 1024) for i, p in enumerate(input_paths)]
        events = [parse_json(line) for line in payloads[1].decode("utf8", errors="strict").splitlines() if line.strip()]
        report = audit(parse_json(payloads[0]), events, args.source_dir, parse_json(payloads[2]),
                       args.width, args.height, parse_json(payloads[3]), args.allow_final_prefix)
        need(before == source_code_snapshot(), "NATIVE_SOURCE_CHANGED_DURING_AUDIT")
        need(all(read_bytes(p, MAX_FILE if i == 0 else 8 * 1024 * 1024) == b for i, (p, b) in enumerate(zip(input_paths, payloads))),
             "INPUT_CHANGED_DURING_AUDIT")
        report["nativeSourceSnapshot"] = before
        report["inputSha256"] = dict(zip(("requests", "events", "deviceConfig", "plan"), map(sha, payloads)))
        exit_code = 0
    except (AuditError, OSError, ValueError, TypeError, KeyError, native.MobileError) as exc:
        report = {"schemaVersion": 1, "kind": "ios_keyboard_key_sequence_audit", "auditPassed": False,
                  "complete": False, "usableForSuccessAcceptance": False, "mcpAcceptance": False,
                  "errorCode": exc.code if isinstance(exc, AuditError) else "AUDIT_INPUT_INVALID"}
        exit_code = 1
    encoded = (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode()
    need(len(encoded) <= 8 * 1024 * 1024, "AUDIT_OUTPUT_LIMIT")
    # Exclusive creation protects originals and earlier audit receipts.
    try:
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except OSError:
        print(json.dumps({"auditPassed": False, "complete": False, "usableForSuccessAcceptance": False, "mcpAcceptance": False,
                          "errorCode": "OUTPUT_UNAVAILABLE"}))
        return 1
    with os.fdopen(fd, "wb") as stream:
        stream.write(encoded)
    print(json.dumps({k: report[k] for k in ("auditPassed", "complete", "usableForSuccessAcceptance", "mcpAcceptance")}
                     | ({"errorCode": report["errorCode"]} if "errorCode" in report else {})))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
