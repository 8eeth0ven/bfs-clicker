"""Opt-in iOS visual text workflows, pending real-device acceptance.

No element selector, accessibility source or input sample is persisted. A trusted
definition names OCR anchors and regions; keyboard command receipts alone never
establish that a value was entered. Unsupported keyboard transports, changed
layout, ambiguous OCR and post-dispatch uncertainty fail without retry.

This module deliberately has no CLI. ``mobile_visual_ios`` delegates its text
mode to ``learn``/``execute``; real keyboard and device acceptance remain separate.
"""
from __future__ import annotations

import math
import os
import re
import time

from . import mobile_visual_ios as ios
from .mobile_ui import DeviceLease, MobileError, WebDriverBackend, atomic_json, digest, read_json
from .mobile_visual_workflow import _region, ground_anchor, observe_locked, region_text, unchanged_locked
from .mobile_workflows import approve_workflow, pattern

NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}")
GAPS = ios.GAPS + [
    "input_region_masked_not_layout_verified",
    "keyboard_receipt_not_input_proof",
    "ocr_language_and_recognition_limit_input_domain",
    "keyboard_or_selection_ui_layout_change_may_prevent_execution",
    "visual_echo_does_not_prove_underlying_text_buffer",
    "ios_text_physical_and_third_party_coverage_pending",
]


def fail(code, status="blocked"):
    raise MobileError(code, status)


def definition_contract(value):
    required = {
        "kind", "schemaVersion", "mode", "id", "name", "effect", "inputName",
        "inputSchema", "focusAnchor", "submitAnchor", "valueRegion",
        "resultRegion", "resultPrefix",
    }
    if (
        not isinstance(value, dict) or set(value) != required
        or value.get("kind") != "native-visual-workflow"
        or value.get("schemaVersion") != 1 or isinstance(value.get("schemaVersion"), bool)
        or value.get("mode") != "text-replace" or value.get("effect") not in ("read", "write")
        or not isinstance(value.get("id"), str) or not NAME.fullmatch(value["id"])
        or not isinstance(value.get("inputName"), str) or not NAME.fullmatch(value["inputName"])
        or not isinstance(value.get("name"), str) or not 1 <= len(value["name"]) <= 120
    ):
        fail("VISUAL_DEFINITION_INVALID")
    for key in ("focusAnchor", "submitAnchor", "resultPrefix"):
        if not isinstance(value[key], str) or not re.fullmatch(r"[A-Za-z0-9_]{1,32}", value[key]):
            fail("VISUAL_DEFINITION_INVALID")
    if value["focusAnchor"] == value["submitAnchor"]:
        fail("VISUAL_ANCHOR_AMBIGUOUS")
    spec = value["inputSchema"]
    if (
        not isinstance(spec, dict) or set(spec) != {"type", "minLength", "maxLength", "pattern"}
        or spec["type"] != "string"
        or not isinstance(spec["minLength"], int) or isinstance(spec["minLength"], bool)
        or not isinstance(spec["maxLength"], int) or isinstance(spec["maxLength"], bool)
        or not 1 <= spec["minLength"] <= spec["maxLength"] <= 128
    ):
        fail("VISUAL_TEXT_SCHEMA_INVALID")
    pattern(spec["pattern"])
    first, second = _region(value["valueRegion"]), _region(value["resultRegion"])
    if _intersects(_box(first, 1, 1, rounded=False), _box(second, 1, 1, rounded=False)):
        fail("VISUAL_REGION_OVERLAP")
    return value


def _text_value(definition, inputs):
    name, spec = definition["inputName"], definition["inputSchema"]
    value = inputs.get(name) if isinstance(inputs, dict) and set(inputs) == {name} else None
    if (
        not isinstance(value, str) or not spec["minLength"] <= len(value) <= spec["maxLength"]
        or any(ord(c) < 32 or 127 <= ord(c) <= 159 or 0xE000 <= ord(c) <= 0xF8FF
               or c in "\u2028\u2029" for c in value)
        or not pattern(spec["pattern"]).fullmatch(value)
    ):
        fail("VISUAL_TEXT_INPUT_INVALID")
    try:
        value.encode("utf8")
    except UnicodeError:
        fail("VISUAL_TEXT_INPUT_INVALID")
    return value


def config_contract(session, definition, learning):
    config = session.config.get("nativeVisualWorkflow")
    required = {"enabled", "node", "allowedWorkflows", "approvedDefinitions"}
    if (
        not isinstance(config, dict) or not required <= set(config) or set(config) - required - {"ocr", "keyboard"}
        or config.get("enabled") is not True or not isinstance(config.get("allowedWorkflows"), list)
        or definition["id"] not in config["allowedWorkflows"]
    ):
        fail("VISUAL_WORKFLOW_NOT_APPROVED")
    approved = config["approvedDefinitions"]
    spec = approved.get(definition["id"]) if isinstance(approved, dict) else None
    if not isinstance(spec, str) or not os.path.isabs(spec):
        fail("VISUAL_DEFINITION_NOT_APPROVED")
    try:
        authorized = definition_contract(read_json(spec, 524288))
    except (MobileError, OSError, ValueError, TypeError):
        fail("VISUAL_DEFINITION_NOT_APPROVED")
    if digest(authorized) != digest(definition):
        fail("VISUAL_DEFINITION_NOT_APPROVED")
    if not isinstance(config["node"], str) or not os.path.isabs(config["node"]) or not os.path.isfile(config["node"]):
        fail("VISUAL_OCR_CONFIG_INVALID")
    ocr = config.get("ocr", {"engine": {"type": "tesseract"}, "language": "eng"})
    if (
        not isinstance(ocr, dict) or set(ocr) != {"engine", "language"}
        or not isinstance(ocr["engine"], dict) or ocr["engine"].get("type") not in ("tesseract", "vision")
        or not isinstance(ocr["language"], str) or not re.fullmatch(r"\w+(?:\+\w+)*", ocr["language"])
    ):
        fail("VISUAL_OCR_CONFIG_INVALID")
    if (
        session.source["kind"] != "ios" or not isinstance(session.backend, WebDriverBackend)
        or session.backend.platform != "ios"
    ):
        fail("VISUAL_PLATFORM_UNSUPPORTED")
    if session.config.get("expectedArtifact") is not None:
        fail("VISUAL_ARTIFACT_VERIFICATION_UNSUPPORTED")
    if "keyboard" in config:
        from .mobile_visual_ios_keyboard import keyboard_contract
        keyboard_contract(config["keyboard"], definition)
    if definition["effect"] == "write":
        approve_workflow(session, definition, learning)
    return config


def _box(region, width, height, rounded=True):
    points = (region["x"] * width, region["y"] * height,
              (region["x"] + region["width"]) * width, (region["y"] + region["height"]) * height)
    return (math.floor(points[0]), math.floor(points[1]), math.ceil(points[2]), math.ceil(points[3])) if rounded else points


def _gaps(config):
    if "keyboard" in config:
        from .mobile_visual_ios_keyboard import gaps as keyboard_gaps
        return GAPS + keyboard_gaps(config["keyboard"])
    return GAPS


def _intersects(first, second):
    return first[0] < second[2] and first[2] > second[0] and first[1] < second[3] and first[3] > second[1]


def _observe(session, lease, config):
    ocr = config.get("ocr", {"engine": {"type": "tesseract"}, "language": "eng"})
    return observe_locked(session, lease, session.output / "visual-private", node=config["node"],
                          engine=ocr["engine"], language=ocr["language"])


def _layout(session, config, definition, observation, contracts):
    width, height = observation["width"], observation["height"]
    masks = [definition["valueRegion"], definition["resultRegion"]]
    boxes = [_box(region, width, height) for region in masks]
    if _intersects(*boxes):
        fail("VISUAL_REGION_OVERLAP")
    anchors, anchor_boxes = {}, []
    for key, name in (("focus", definition["focusAnchor"]), ("submit", definition["submitAnchor"])):
        anchor = ground_anchor(observation, name, contracts.get(key))
        bounds = anchor["normalized"]
        # Match the anchor rounding used by the existing native visual modules;
        # masks round outward so even a one-pixel overlap is rejected.
        box = tuple(round(item) for item in _box(bounds, width, height, rounded=False))
        if any(_intersects(box, mask) for mask in boxes):
            fail("VISUAL_MASK_OVERLAPS_ANCHOR")
        anchors[key] = anchor
        anchor_boxes.append(box)
    if _intersects(*anchor_boxes):
        fail("VISUAL_ANCHOR_AMBIGUOUS")
    fingerprint = ios._masked(config["node"], session, observation, masks)
    if contracts.get("_pixels") not in (None, fingerprint):
        fail("VISUAL_LAYOUT_CHANGED")
    return anchors, fingerprint


def _geometry(session, observation, expected=None):
    session.backend.verify_artifact()
    geometry = ios._geometry(session.backend, observation["width"], observation["height"])
    if expected is not None and geometry != expected:
        fail("VISUAL_COORDINATES_UNVERIFIED")
    return geometry


def _dispatch(session, lease, definition, observation, geometry, method, path, body):
    _geometry(session, observation, geometry)
    unchanged_locked(session, lease, session.output / "visual-private", observation)
    _geometry(session, observation, geometry)
    session.budget.action()
    atomic_json(session.output / "write-intent.json", {
        "effect": definition["effect"], "status": "unknown", "automaticRetry": False,
    })
    session._visual_dispatched = True
    return session.backend.request(method, path, body)


def _tap(session, lease, definition, observation, geometry, anchor):
    box = anchor["normalized"]
    x = int((box["x"] + box["width"] / 2) * geometry[0])
    y = int((box["y"] + box["height"] / 2) * geometry[1])
    if not 0 <= x < geometry[0] or not 0 <= y < geometry[1]:
        fail("VISUAL_COORDINATES_UNVERIFIED")
    return _dispatch(session, lease, definition, observation, geometry, "POST", "/actions", {
        "actions": [{"type": "pointer", "id": "finger", "parameters": {"pointerType": "touch"},
                     "actions": [{"type": "pointerMove", "duration": 0, "x": x, "y": y, "origin": "viewport"},
                                 {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}]}],
    })


def _settle(session):
    session.budget.check()
    time.sleep(min(.5, session.budget.timeout()))
    session.budget.check()


def _text_run(session, lease, config, definition, inputs, contracts):
    if "keyboard" in config:
        from .mobile_visual_ios_keyboard import run
        return run(session, lease, config, definition, inputs, contracts)
    text = _text_value(definition, inputs)
    try:
        # A foreground check precedes the first private screenshot. It does not
        # establish exact window/handler ownership; the limitation stays public.
        session.backend.verify_artifact()
        session.backend.foreground()
        before = _observe(session, lease, config)
        anchors, fingerprint = _layout(session, config, definition, before, contracts)
        bound = {**anchors, "_pixels": fingerprint}
        geometry = _geometry(session, before)
        _tap(session, lease, definition, before, geometry, anchors["focus"])
        _settle(session)
        focused = _observe(session, lease, config)
        _geometry(session, focused, geometry)
        _layout(session, config, definition, focused, bound)
        # XCUITest's application-level keyboardInput needs no accessibility
        # element id. Command+A=16 comes from XCUIKeyModifierCommand in Xcode.
        # Unsupported transports are terminal for this attempt, with no fallback.
        _dispatch(session, lease, definition, focused, geometry, "POST", "/execute/sync", {
            "script": "mobile: keys",
            "args": [{"keys": [{"key": "a", "modifierFlags": 16}, "XCUIKeyboardKeyDelete"]}],
        })
        _settle(session)
        selected = _observe(session, lease, config)
        _geometry(session, selected, geometry)
        _layout(session, config, definition, selected, bound)
        # This fixed, bounded deletion is part of the original clear plan, not
        # a retry after a failed observation. XCUITest maps Delete to U+0008 and
        # WDA sends this character through the same FBTypeText event path used
        # by its own clear implementation. Only the final OCR can prove empty.
        _dispatch(session, lease, definition, selected, geometry, "POST", "/keys", {
            "value": ["\b" * definition["inputSchema"]["maxLength"]],
        })
        _settle(session)
        cleared = _observe(session, lease, config)
        _geometry(session, cleared, geometry)
        _layout(session, config, definition, cleared, bound)
        if region_text(cleared, definition["valueRegion"]) != "":
            fail("VISUAL_INPUT_CLEAR_NOT_VERIFIED")
        # /keys is the public Appium session route. /wda/keys is an internal
        # driver-to-WDA endpoint and is not registered by the Appium router.
        _dispatch(session, lease, definition, cleared, geometry, "POST", "/keys", {"value": [text]})
        _settle(session)
        filled = _observe(session, lease, config)
        _geometry(session, filled, geometry)
        filled_anchors, _ = _layout(session, config, definition, filled, bound)
        if region_text(filled, definition["valueRegion"]) != text:
            fail("VISUAL_INPUT_NOT_VERIFIED")
        # This baseline is taken after verified input and from the very same
        # screenshot as the submit anchor, preventing auto-update-on-type from
        # establishing evidence for an otherwise ineffective submit.
        old = region_text(filled, definition["resultRegion"])
        _tap(session, lease, definition, filled, geometry, filled_anchors["submit"])
        _settle(session)
        after = _observe(session, lease, config)
        _geometry(session, after, geometry)
        _layout(session, config, definition, after, bound)
        result = region_text(after, definition["resultRegion"])
        if (
            region_text(after, definition["valueRegion"]) != text or result == old
            or not result.startswith(definition["resultPrefix"] + " ")
            or not re.search(r"(?:^|\s)" + re.escape(text) + r"(?:$|\s)", result)
        ):
            fail("VISUAL_RESULT_NOT_VERIFIED")
        unchanged_locked(session, lease, session.output / "visual-private", after)
        _geometry(session, after, geometry)
        contracts.update(bound)
        return {"text": result}
    except Exception as exc:
        if getattr(session, "_visual_dispatched", False):
            exc.writeOutcome = {"status": "unknown", "automaticRetry": False}
        raise


def learn(session, definition, samples):
    definition = definition_contract(definition)
    config = config_contract(session, definition, True)
    if not isinstance(samples, list) or len(samples) != 2:
        fail("VISUAL_TWO_DISTINCT_SAMPLES_REQUIRED")
    for sample in samples:
        _text_value(definition, sample)
    if samples[0] == samples[1]:
        fail("VISUAL_TWO_DISTINCT_SAMPLES_REQUIRED")
    contracts, outputs = {}, []
    with DeviceLease(session.backend) as lease:
        for sample in samples:
            outputs.append(_text_run(session, lease, config, definition, sample, contracts))
    if len({digest(output) for output in outputs}) != 2:
        fail("VISUAL_TWO_DISTINCT_RESULTS_REQUIRED")
    capability = "mobile_visual_" + digest([session.source["id"], definition["id"]])
    recipe = {
        "schemaVersion": 1, "recipeType": "ios_visual_workflow", "sourceId": session.source["id"],
        "identity": session.identity, "capabilityId": capability, "definition": definition,
        "controlContracts": contracts,
        "learningEvidence": {"sampleCount": 2, "distinctInputSamples": 2, "distinctResultSamples": 2},
    }
    recipe["revision"] = digest(recipe)
    cap = {
        "id": capability, "name": definition["name"],
        "description": "可信文字锚点执行输入替换并从独立结果区域读取文字。",
        "kind": "mobile", "effect": definition["effect"], "readiness": "ready",
        "inputSchema": {"type": "object", "properties": {definition["inputName"]: dict(definition["inputSchema"])},
                        "required": [definition["inputName"]], "additionalProperties": False},
        "outputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "additionalProperties": False},
        "revision": recipe["revision"],
        "evidence": {"workflowObserved": True, "sampleCount": 2, "resultVariationObserved": True}, "gaps": _gaps(config),
    }
    session.progress["capabilities"][capability] = cap
    session.progress["recipes"][capability] = recipe
    session.progress["status"] = "completed"
    session.checkpoint()
    return {"ok": True, "status": "completed", "capabilityId": capability, "revision": recipe["revision"],
            "sampleCount": 2, "writeOutcome": {"status": "observed", "automaticRetry": False}, "gaps": _gaps(config)}


def _contracts(definition, value, keyboard=None):
    if (
        not isinstance(value, dict) or set(value) != ({"focus", "submit", "_pixels", "_keyboard"} if keyboard is not None else {"focus", "submit", "_pixels"})
        or not isinstance(value["_pixels"], str) or not re.fullmatch(r"[a-f0-9]{64}", value["_pixels"])
    ):
        fail("VISUAL_RECIPE_INVALID")
    for key, name in (("focus", definition["focusAnchor"]), ("submit", definition["submitAnchor"])):
        anchor = value[key]
        if (
            not isinstance(anchor, dict) or set(anchor) != {"anchor", "width", "height", "normalized"}
            or anchor["anchor"] != name
            or any(not isinstance(anchor[k], int) or isinstance(anchor[k], bool)
                   or not 1 <= anchor[k] <= 20000 for k in ("width", "height"))
        ):
            fail("VISUAL_RECIPE_INVALID")
        try:
            _region(anchor["normalized"])
        except MobileError:
            fail("VISUAL_RECIPE_INVALID")
    if any(value["focus"][key] != value["submit"][key] for key in ("width", "height")):
        fail("VISUAL_RECIPE_INVALID")
    if keyboard is not None:
        from .mobile_visual_ios_keyboard import validate_learned
        validate_learned(keyboard, value["_keyboard"], value["focus"])
    return value


def execute(session, recipe, revision, inputs):
    if (
        not isinstance(recipe, dict) or recipe.get("recipeType") != "ios_visual_workflow"
        or recipe.get("identity") != session.identity or recipe.get("sourceId") != session.source["id"]
        or recipe.get("revision") != revision or digest({key: value for key, value in recipe.items() if key != "revision"}) != revision
    ):
        fail("VISUAL_RECIPE_REVISION_MISMATCH")
    definition = definition_contract(recipe.get("definition"))
    config = config_contract(session, definition, False)
    if (
        set(recipe) != {"schemaVersion", "recipeType", "sourceId", "identity", "capabilityId",
                        "definition", "controlContracts", "learningEvidence", "revision"}
        or recipe.get("schemaVersion") != 1 or isinstance(recipe.get("schemaVersion"), bool)
        or recipe.get("capabilityId") != "mobile_visual_" + digest([session.source["id"], definition["id"]])
        or recipe.get("learningEvidence") != {"sampleCount": 2, "distinctInputSamples": 2, "distinctResultSamples": 2}
    ):
        fail("VISUAL_RECIPE_INVALID")
    contracts = _contracts(definition, recipe.get("controlContracts"), config.get("keyboard"))
    _text_value(definition, inputs)
    # A failed execution may not mutate persisted learned anchor contracts.
    working_contracts = dict(contracts)
    with DeviceLease(session.backend) as lease:
        output = _text_run(session, lease, config, definition, inputs, working_contracts)
    session.progress["status"] = "completed"
    session.checkpoint()
    return {"ok": True, "status": "completed", "capabilityId": recipe["capabilityId"], "revision": revision,
            "outputs": output, "executionObserved": True,
            "writeOutcome": {"status": "observed", "automaticRetry": False}, "gaps": _gaps(config)}
