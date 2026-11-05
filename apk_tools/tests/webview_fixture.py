"""Independent offline W3C protocol model; never imports production modules.

This server does not evaluate JavaScript or represent a browser/device. The
fixed-probe digest identifies a protocol message; DOM semantics are separately
verified by the Node DOM fixture and real installed-driver acceptance.
"""
from contextlib import contextmanager
import argparse
import copy
import hashlib
import http.server
import json
import sys
import threading
import time
from urllib.parse import unquote

APP = "com.example.bfsmcp.webview"
ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf"
PROBE_VERSION = "webview-dom-probe-2"
PROBE_SHA256 = "439f5411f7fa90765586385c4c161794d093db74b1e6a10b35dd79e2acb5a32d"
FOCUS_WRITE_SHA256 = "46c30fd206011a0b36d28dfb95f29808801f703b717d7835d533ede6e29dd08c"
FOCUS_READ_SHA256 = "d8d73d8cf463120badffdaf0ebb3c5c0dc41284412e77a5297b7bf8e1db6ce22"


@contextmanager
def webview_fixture(platform="ios"):
    """A bounded local fake W3C endpoint with independent command accounting."""
    if platform not in {"ios", "android"}:
        raise ValueError("FIXTURE_PLATFORM_UNSUPPORTED")
    state = {"platform": platform, "input": "", "detail": "", "result": "Idle", "effects": [], "ledger": [], "calls": [], "generation": 0,
             "active": APP, "bundleId": APP, "context": "WEBVIEW_7.1", "window": "7.1", "handles": ["7.1"],
             "settings": {"nativeWebTap": False, "nativeWebTapStrict": False}, "contractChanges": {},
             "probeCount": 0, "focus": None, "unconfigured": [], "html": "<!DOCTYPE html><html><body>fixture</body></html>"}

    def element(name):
        suffix = "@" + str(state["probeCount"]) if state.get("opaqueAliases") else ""
        value = str(state["generation"]) + ":" + name + suffix
        shape = state.get("referenceShape", "w3c")
        if shape == "dual":
            return {ELEMENT_KEY: value, "ELEMENT": value}
        if shape == "legacy":
            return {"ELEMENT": value}
        if shape == "conflict":
            return {ELEMENT_KEY: value, "ELEMENT": value + "-other"}
        if shape == "extra":
            return {ELEMENT_KEY: value, "unexpected": value}
        return {ELEMENT_KEY: "" if shape == "empty" else 7 if shape == "number" else value}

    def probe(specs, pins):
        state["lastSpecs"] = copy.deepcopy(specs)
        state["probeCount"] += 1
        if state.get("onProbe"):
            state["onProbe"](state["probeCount"])
        refs, rows, groups, inventory = [element("html"), element("body")], {}, {}, []
        for spec in specs:
            group = spec["group"]
            if group is not None and group not in groups:
                groups[group] = {"id": group[1:], "tag": "form", "bounds": [0, 0, 600, 600]}
                refs.append(element(group[1:]))
            kind = spec["kind"]
            contract = {"selector": spec["selector"], "kind": kind,
                        "tag": "input" if kind == "input" else "button" if kind == "button" else "div",
                        "type": "text" if kind == "input" else "submit" if kind == "button" else "",
                        "id": spec["selector"][1:], "name": spec["id"], "role": "", "ariaLabel": "",
                        "groupSelector": group, "groupId": group[1:] if group else None, "groupTag": "form" if group else None,
                        "formId": group[1:] if group and kind != "output" else None,
                        "formAction": state["documentUrl"] if group and kind != "output" else None,
                        "formMethod": "get" if group and kind != "output" else None,
                        "parentId": group[1:] if group else "", "parentTag": "form" if group else "body",
                        "label": "Search" if kind == "button" else ""}
            contract.update(state["contractChanges"].get(spec["id"], {}))
            row = {"contract": contract, "bounds": [10, 10, 120, 30]}
            if kind == "input":
                row["value"] = state["detail" if spec["id"] == "detail" else "input"]
            if kind == "output":
                row["text"] = state["result"]
            refs.extend([element(spec["selector"][1:]), element(group[1:]) if group and kind != "output" else None,
                         element(group[1:] if group else "body")])
            rows[spec["id"]] = row
            inventory.append({"selector": spec["selector"], "dataTestId": "", "tag": contract["tag"], "type": contract["type"],
                              "role": "", "configured": True, "dispatchAuthorized": False})
        inventory.extend(copy.deepcopy(state["unconfigured"]))
        def semantic_refs(items):
            return [item[ELEMENT_KEY].split("@")[0] if isinstance(item, dict) and ELEMENT_KEY in item else item for item in items]
        if pins is not None and semantic_refs(pins) != semantic_refs(refs):
            return {"error": "javascript error", "message": "WEBVIEW_DOM:IDENTITY"}
        return {"probeVersion": PROBE_VERSION, "url": state["documentUrl"], "origin": state["origin"], "top": True,
                "readyState": "complete", "pinsMatched": pins is not None, "refs": refs, "rows": rows, "groups": groups,
                "inventory": inventory, "inventoryTotal": len(inventory), "inventoryTruncated": False}

    def after_effect(name, command):
        if state.get("afterEffect"):
            state["afterEffect"](name, command)
        result, status = ({"error": "unknown error"}, 500) if state.get("failCommand") == command else (None, 200)
        if state.get("replaceAfterCommand") == command:
            state["generation"] += 1
        if state.get("timeoutCommand") == command:
            time.sleep(1.5)
        return result, status

    def focus_reply(args, write):
        if not isinstance(args, list) or len(args) != 8:
            return {"error": "javascript error"}, 500
        selector, target, html, body, owner, parent, url, source_origin = args
        spec = next((row for row in state.get("lastSpecs", []) if row["selector"] == selector and row["kind"] == "input"), None)
        if spec is None:
            return {"error": "javascript error"}, 500
        expected = [element(selector[1:]), element("html"), element("body"),
                    element(spec["group"][1:]), element(spec["group"][1:])]
        def identity(ref):
            return ref.get(ELEMENT_KEY, "").split("@")[0] if isinstance(ref, dict) else None
        if list(map(identity, [target, html, body, owner, parent])) != list(map(identity, expected)) or url != state["documentUrl"] or source_origin != state["origin"]:
            return {"error": "javascript error"}, 500
        name = selector[1:]
        if write:
            state["effects"].append((name, "focus"))
            if not state.get("noopFocus"):
                state["focus"] = name
            result, status = after_effect(name, "focus")
            if status != 200:
                return result, status
        elif state.get("loseFocusOnRead"):
            state["focus"] = "other"
        return {"probeVersion": "webview-focus-1", "focused": state["focus"] == name,
                "value": state["detail" if name == "detail" else "input"]}, 200

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def handle_command(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length)) if length else None
            route = self.path.removeprefix("/session/webview-session")
            state["calls"].append((self.command, route))
            value, status = None, 200
            if state.get("onRequest"):
                state["onRequest"](self.command, route)
            if route == "/execute/sync" and self.command == "POST":
                script = body["script"]
                if script == "mobile: activeAppInfo":
                    if platform == "android":
                        value, status = {"error": "unknown command"}, 404
                    else:
                        value = {"bundleId": state["active"]}
                        if "pid" in state:
                            value["pid"] = state["pid"]
                elif script == "mobile: getContexts":
                    if platform == "android":
                        value = copy.deepcopy(state["androidContexts"])
                    else:
                        value = [{"id": "NATIVE_APP"}, {"id": "WEBVIEW_7.1", "bundleId": state["bundleId"], "url": state["contextUrl"]}]
                        if state.get("missingBundle"):
                            value[1].pop("bundleId")
                        if state.get("duplicateContext"):
                            value.append(copy.deepcopy(value[1]))
                elif hashlib.sha256(script.encode()).hexdigest() == PROBE_SHA256:
                    value = probe(*body["args"])
                    if isinstance(value, dict) and value.get("error"):
                        status = 500
                elif platform == "android" and hashlib.sha256(script.encode()).hexdigest() in {FOCUS_WRITE_SHA256, FOCUS_READ_SHA256}:
                    value, status = focus_reply(body["args"], hashlib.sha256(script.encode()).hexdigest() == FOCUS_WRITE_SHA256)
                else:
                    value, status = {"error": "unknown script"}, 500
            elif route == "/context" and self.command == "GET":
                value = state["context"]
            elif route == "/window" and self.command == "GET":
                value = state["window"]
            elif route == "/window/handles" and self.command == "GET":
                value = state["handles"]
            elif route == "/url" and self.command == "GET":
                value = state["documentUrl"]
            elif route == "/appium/settings" and self.command == "GET":
                value = state["settings"]
            elif route == "/appium/device/current_package" and self.command == "GET" and platform == "android":
                value = state["active"]
            elif route == "/source" and self.command == "GET":
                value = state["html"]
            elif route == "/goog/cdp/execute" and self.command == "POST" and platform == "android":
                if set(body) != {"cmd", "params"} or body["cmd"] != "Input.insertText" or not isinstance(body["params"], dict) or set(body["params"]) != {"text"} or not isinstance(body["params"]["text"], str) or state["focus"] not in {"query", "detail"}:
                    value, status = {"error": "invalid argument"}, 400
                else:
                    name, command = state["focus"], "insertText"
                    state["effects"].append((name, command))
                    key = "detail" if name == "detail" else "input"
                    if state.get("noopCommand") != command:
                        state[key] += body["params"]["text"]
                    if state.get("normalizeValue"):
                        import unicodedata
                        state[key] = unicodedata.normalize("NFC", state[key])
                    value, status = after_effect(name, command)
            elif route.startswith("/element/") and self.command == "POST":
                name, command = route.split("/")[-2:]
                name = unquote(name).split(":")[-1].split("@")[0]
                state["effects"].append((name, command))
                if command == "clear":
                    if not state.get("failClear") and state.get("noopCommand") != command:
                        state["detail" if name == "detail" else "input"] = ""
                elif command == "value":
                    if state.get("noopCommand") != command:
                        state["detail" if name == "detail" else "input"] += body["text"]
                    if state.get("normalizeValue"):
                        import unicodedata
                        state["input"] = unicodedata.normalize("NFC", state["input"])
                elif command == "click":
                    state["clicks"] = state.get("clicks", 0) + 1
                    state["ledger"].append({"sequence": len(state["ledger"]) + 1, "query": state["input"], "detail": state["detail"], "button": name})
                    if not state.get("freezeResult") and state.get("noopCommand") != command:
                        state["result"] = "Query:" + state["input"] + ";Detail:" + state["detail"]
                value, status = after_effect(name, command)
            else:
                value, status = {"error": "unknown command"}, 404
            raw = json.dumps({"value": value}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            try:
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError):
                pass  # A timeout test deliberately drops its client socket.

        do_GET = handle_command
        do_POST = handle_command

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    state["transportUrl"] = "http://127.0.0.1:" + str(server.server_port)
    state["origin"] = state["transportUrl"]
    state["documentUrl"] = state["contextUrl"] = state["origin"] + "/form"
    if platform == "android":
        page = "0123456789ABCDEF" * 2
        state.update(context="WEBVIEW_" + APP, window=page, handles=[page],
                     settings={}, androidContexts=[{"proc": "@webview_devtools_remote_73", "webview": "WEBVIEW_73",
                     "webviewName": "WEBVIEW_" + APP, "info": {"Android-Package": APP, "Browser": "Chrome/model"},
                     "pages": [{"id": page, "type": "page", "url": state["documentUrl"], "title": "Independent protocol model"}]}])
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=3)


def snapshot(state):
    keys = ("input", "detail", "result", "effects", "ledger", "generation", "active", "bundleId", "context", "window", "handles", "settings",
            "probeCount", "clicks", "origin", "documentUrl", "contextUrl", "pid")
    android = {"platform": "android", "androidContexts": copy.deepcopy(state["androidContexts"]), "focus": state["focus"]} if state["platform"] == "android" else {}
    return {**{key: copy.deepcopy(state.get(key)) for key in keys}, **android, "callsTotal": len(state["calls"]),
            "calls": copy.deepcopy(state["calls"][-4096:]), "protocolModelOnly": True, "productionImports": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=["ios", "android"], default="ios")
    args = parser.parse_args()
    def emit(value):
        print(json.dumps(value, ensure_ascii=False), flush=True)
    with webview_fixture(args.platform) as state:
        emit({"ok": True, "ready": {"url": state["transportUrl"], "origin": state["origin"], "documentUrl": state["documentUrl"],
                                    "context": state["context"], "windowHandle": state["window"], "appId": APP, "sessionId": "webview-session",
                                    **({"textTransport": {"mode": "chromedriver_cdp_insert_text_v1"}} if args.platform == "android" else {})},
              "protocolModelOnly": True, "productionImports": 0})
        allowed = {"input", "detail", "result", "generation", "active", "bundleId", "context", "window", "handles", "settings", "contractChanges",
                   "unconfigured", "html", "missingBundle", "duplicateContext", "documentUrl", "contextUrl", "origin", "failClear", "normalizeValue",
                   "freezeResult", "failCommand", "noopCommand", "replaceAfterCommand", "timeoutCommand", "opaqueAliases", "pid", "referenceShape", "androidContexts", "focus", "noopFocus", "loseFocusOnRead"}
        while True:
            raw = sys.stdin.buffer.readline(65537)
            if not raw:
                break
            try:
                if len(raw) > 65536:
                    raise ValueError()
                request = json.loads(raw)
                if not isinstance(request, dict):
                    raise ValueError()
                operation = request.get("op")
                if operation == "quit":
                    emit({"ok": True, "stopped": True})
                    break
                if operation == "set":
                    changes = request.get("changes")
                    if not isinstance(changes, dict) or set(changes) - allowed:
                        raise ValueError()
                    state.update(copy.deepcopy(changes))
                elif operation != "snapshot":
                    raise ValueError()
                emit({"ok": True, "snapshot": snapshot(state)})
            except (ValueError, TypeError, KeyError):
                emit({"ok": False, "error": "FIXTURE_INPUT_INVALID"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

