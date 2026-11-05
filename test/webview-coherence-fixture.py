"""Independent paired-probe result model; no production imports or JS eval."""
from pathlib import Path
import copy
import json
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apk_tools/tests"))
from webview_fixture import APP, snapshot, webview_fixture

MAX_LINE = 65536
MAX_OUTPUT = 8 * 1024 * 1024
MAX_FRAMES = 1024
MAX_CALLS = 4096


def main():
    production_imports = [name for name in sys.modules if name == "apk_inventory" or name.startswith("apk_inventory.")]
    if production_imports:
        raise RuntimeError("PRODUCTION_IMPORT_IN_MODEL")

    def emit(value):
        raw = json.dumps(value, ensure_ascii=False, allow_nan=False)
        if len(raw.encode("utf-8")) > MAX_OUTPUT:
            raw = json.dumps({"ok": False, "error": "FIXTURE_OUTPUT_LIMIT"})
        print(raw, flush=True)

    with webview_fixture("android") as state:
        lock = threading.RLock()
        model = {"mode": "stable", "firstParam": None, "frames": [],
                 "frameCount": 0, "overflow": False, "modeStartPair": 0}

        def on_request(_method, _route):
            if len(state["calls"]) > MAX_CALLS:
                model["overflow"] = True
                raise ValueError("FIXTURE_REQUEST_LIMIT")

        def on_probe(number):
            with lock:
                # Both fixed DOM probes in one complete observation receive the
                # same result. Only a new complete observation may alternate.
                pair = (number - 1) // 2
                submitted = state["ledger"][-1] if state["ledger"] else None
                first = model["firstParam"]
                second = "query" if first == "detail" else "detail"
                side = "both"
                if submitted is not None and first is not None:
                    if model["mode"] == "torn":
                        side = "first" if (pair - model["modeStartPair"]) % 2 == 0 else "second"
                        parameter = first if side == "first" else second
                        state["result"] = "ONLY_" + side.upper() + ":" + submitted[parameter]
                    else:
                        state["result"] = "Query:" + submitted["query"] + ";Detail:" + submitted["detail"]
                text = state["result"]
                has_first = submitted is not None and first is not None and submitted[first] in text
                has_second = submitted is not None and first is not None and submitted[second] in text
                model["frameCount"] += 1
                if len(model["frames"]) < MAX_FRAMES:
                    model["frames"].append({"probe": number, "observation": pair,
                                            "mode": model["mode"], "side": side,
                                            "firstParam": first,
                                            "submission": submitted["sequence"] if submitted else 0,
                                            "text": text, "firstPresent": bool(has_first),
                                            "secondPresent": bool(has_second)})
                else:
                    model["overflow"] = True

        state["onRequest"] = on_request
        state["onProbe"] = on_probe

        def current():
            with lock:
                value = snapshot(state)
                value["coherence"] = copy.deepcopy(model)
                value["captureComplete"] = not model["overflow"] and value["callsTotal"] == len(value["calls"])
                value["javascriptEvaluated"] = False
                return value

        emit({"ok": True, "protocolModelOnly": True, "productionImports": len(production_imports),
              "javascriptEvaluated": False,
              "ready": {"url": state["transportUrl"], "origin": state["origin"],
                        "documentUrl": state["documentUrl"], "context": state["context"],
                        "windowHandle": state["window"], "appId": APP,
                        "sessionId": "webview-session"}})
        while True:
            raw = sys.stdin.buffer.readline(MAX_LINE + 1)
            if not raw:
                break
            try:
                if len(raw) > MAX_LINE:
                    emit({"ok": False, "error": "FIXTURE_INPUT_LIMIT"})
                    break
                request = json.loads(raw)
                if not isinstance(request, dict):
                    raise ValueError()
                op = request.get("op")
                if op == "quit" and set(request) == {"op"}:
                    emit({"ok": True, "stopped": True})
                    break
                if op == "setMode" and set(request) == {"op", "mode", "firstParam"}:
                    if request["mode"] not in {"stable", "torn"} or request["firstParam"] not in {"query", "detail"}:
                        raise ValueError()
                    with lock:
                        if state["probeCount"] % 2:
                            raise ValueError()
                        model.update(mode=request["mode"], firstParam=request["firstParam"],
                                     modeStartPair=state["probeCount"] // 2)
                elif op != "snapshot" or set(request) != {"op"}:
                    raise ValueError()
                emit({"ok": True, "snapshot": current()})
            except (ValueError, TypeError, KeyError, UnicodeError):
                emit({"ok": False, "error": "FIXTURE_INPUT_INVALID"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
