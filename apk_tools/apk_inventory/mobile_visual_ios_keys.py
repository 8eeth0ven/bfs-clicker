"""Explicit local AX-key pointer transport; never a fallback from /keys.

AX key metadata and fresh pixels are temporal evidence, not OS window ownership.
No caller supplies a coordinate, control identity, keyboard policy, or key route.
"""
from __future__ import annotations

import hashlib
import re
import string
import time
import uuid

from .mobile_ui import MobileError, atomic_json, digest
from .mobile_visual import capture_locked
from .mobile_visual_workflow import region_text

ALPHABETS = {"lower": frozenset(string.ascii_lowercase),
             "upper": frozenset(string.ascii_uppercase),
             "digits": frozenset(string.digits)}
ALNUM = frozenset(string.ascii_letters + string.digits)
CONTROLS = frozenset(("shift", "numbers", "letters", "delete"))
POINTER_ID = "keyboard-key"
GAPS = ["onscreen_key_source_and_pixels_do_not_prove_os_window_ownership",
        "onscreen_key_transport_requires_trusted_three_layer_ascii_keyboard",
        "persistent_overlay_before_observation_is_not_disproved_by_pixel_freshness"]


def fail(code):
    raise MobileError(code, "blocked")


def _keyboard():
    from . import mobile_visual_ios_keyboard
    return mobile_visual_ios_keyboard


def key_input_contract(value, definition):
    if (not isinstance(value, dict) or not {"mode", "controls"} <= set(value)
            or set(value) - {"mode", "controls", "confirmation", "clearPlan"}
            or value.get("mode") != "onscreen" or not isinstance(value.get("controls"), dict)
            or set(value["controls"]) != CONTROLS
            or value.get("confirmation", "each_prefix") not in ("each_prefix", "complete_text")
            or value.get("clearPlan", "observed_shortening") not in ("observed_shortening", "fixed_max_length")):
        fail("VISUAL_KEY_INPUT_CONFIG_INVALID")
    identities = set()
    for control in value["controls"].values():
        if (not isinstance(control, dict) or set(control) != {"type", "name", "label"}
                or control["type"] not in ("XCUIElementTypeKey", "XCUIElementTypeButton")
                or any(not isinstance(control[field], str) or not 1 <= len(control[field]) <= 64
                       or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in control[field])
                       for field in ("name", "label"))):
            fail("VISUAL_KEY_INPUT_CONFIG_INVALID")
        identity = tuple(control[field] for field in ("type", "name", "label"))
        if identity in identities or control["type"] == "XCUIElementTypeKey" and control["name"] == control["label"] and control["name"] in ALNUM:
            fail("VISUAL_KEY_INPUT_CONFIG_INVALID")
        identities.add(identity)
    spec = definition["inputSchema"]
    if (spec["pattern"] != "^[A-Za-z0-9]+$" or type(spec["maxLength"]) is not int
            or not 1 <= spec["maxLength"] <= 16):
        fail("VISUAL_KEY_INPUT_CONFIG_INVALID")
    return value


def validate_text(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9]{1,16}", value):
        fail("VISUAL_KEY_INPUT_UNSUPPORTED")
    return value


def read_source(session, config, observation, geometry):
    """A new source only; stale/disappearing/ambiguous layers are not retried."""
    k = _keyboard()
    session.budget.check()
    session.backend.foreground()
    raw = session.backend.request("GET", "/source")
    proposal = k._inspect_source(raw, geometry, session.backend.app_id, unique=True)
    if proposal is None:
        fail("VISUAL_KEYBOARD_NOT_VISIBLE")
    source = config["keyboard"].get("sourceRegion", config["keyboard"]["region"])
    if k._visual()._box(proposal["region"], observation["width"], observation["height"]) != k._visual()._box(source, observation["width"], observation["height"]):
        fail("VISUAL_KEYBOARD_REGION_MISMATCH")
    keyboard, = k._parse_source(raw, session.backend.app_id, unique=True)
    keyboard_box = k._rect(keyboard)
    rows, literals, controls = [], {}, {}
    for node in keyboard.iter():
        kind = node.attrib.get("type", node.tag)
        if kind not in ("XCUIElementTypeKey", "XCUIElementTypeButton") or node.attrib.get("visible") != "true":
            continue
        rect = k._rect(node)
        row = {field: node.attrib.get(field) for field in ("name", "label", "enabled")}
        row.update(type=kind, rect=rect)
        rows.append(row)
        name = row["name"]
        if kind == "XCUIElementTypeKey" and name in ALNUM and row["label"] == name:
            if name in literals:
                fail("VISUAL_KEYBOARD_KEY_AMBIGUOUS")
            if row["enabled"] != "true":
                fail("VISUAL_KEYBOARD_KEY_DISABLED")
            literals[name] = row
        for control_name, identity in config["keyboard"]["keyInput"]["controls"].items():
            if all(row[field] == identity[field] for field in ("type", "name", "label")):
                if control_name in controls:
                    fail("VISUAL_KEYBOARD_KEY_AMBIGUOUS")
                controls[control_name] = row
    layer = next((name for name, alphabet in ALPHABETS.items() if set(literals) == alphabet), None)
    if layer is None:
        fail("VISUAL_KEYBOARD_LAYER_UNVERIFIED")
    session.backend.foreground()
    session.budget.check()
    return {"layer": layer, "literals": literals, "controls": controls, "rows": rows, "keyboardBox": keyboard_box,
            "layout": digest(sorted(rows, key=lambda row: (row["type"], row["name"] or "", row["label"] or "", row["rect"]))),
            "sourceSha256": hashlib.sha256(raw.encode("utf8")).hexdigest()}


def _key_point(row):
    x, y, width, height = row["rect"]
    return int(x + width / 2), int(y + height / 2)


def _contains(row, point):
    x, y, width, height = row["rect"]
    return x <= point[0] < x + width and y <= point[1] < y + height


def _target(source, name, literal=False):
    row = source["literals" if literal else "controls"].get(name)
    if row is None:
        fail("VISUAL_KEYBOARD_KEY_UNVERIFIED")
    if row["enabled"] != "true":
        fail("VISUAL_KEYBOARD_KEY_DISABLED")
    x, y, width, height = row["rect"]
    kx, ky, kw, kh = source["keyboardBox"]
    if x < kx or y < ky or x + width > kx + kw or y + height > ky + kh:
        fail("VISUAL_KEYBOARD_KEYS_UNVERIFIED")
    point = _key_point(row)
    if not _contains(row, point):
        fail("VISUAL_COORDINATES_UNVERIFIED")
    # Names alone cannot grant a tap: another visible AX Key/Button can cover
    # its actual integer center, including an unknown or disabled control.
    # Exclude only this same parsed node, never another equal-valued row.
    if any(other is not row and _contains(other, point) for other in source["rows"]):
        fail("VISUAL_KEYBOARD_KEY_AMBIGUOUS")
    return row


def _keyboard_only_masks(config, observation):
    """Complement of the outward pixel keyboard box, without rounding into it."""
    k = _keyboard()
    width, height = observation["width"], observation["height"]
    left, top, right, bottom = k._visual()._box(config["keyboard"]["region"], width, height)
    if left != 0 or right != width or not 0 < top < bottom <= height:
        fail("VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED")
    masks = [{"x": 0, "y": 0, "width": 1, "height": (top - .25) / height}]
    if bottom < height:
        masks.append({"x": 0, "y": (bottom + .25) / height, "width": 1, "height": (height - bottom - .5) / height})
    expected = [(0, 0, width, top)] + ([(0, bottom, width, height)] if bottom < height else [])
    if [k._visual()._box(mask, width, height) for mask in masks] != expected:
        fail("VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED")
    return masks


def _fresh_key(session, lease, config, definition, observation, geometry, source, name, literal):
    k, v = _keyboard(), _keyboard()._visual()
    target = _target(source, name, literal)
    masks = [definition["resultRegion"]]
    keyboard_masks = _keyboard_only_masks(config, observation)
    expected = v.ios._masked(config["node"], session, observation, masks)
    expected_keyboard = v.ios._masked(config["node"], session, observation, keyboard_masks)
    deadline = time.monotonic() + 2
    for attempt in range(6):
        session.budget.check()
        before = read_source(session, config, observation, geometry)
        if before["layout"] != source["layout"] or _target(before, name, literal) != target:
            fail("VISUAL_KEYBOARD_LAYOUT_CHANGED")
        captured = capture_locked(session, session.output / "visual-private" / ("key-fresh-" + uuid.uuid4().hex), lease)
        fresh = {**captured, "_imagePath": captured["imagePath"]}
        v._geometry(session, fresh, geometry)
        after = read_source(session, config, fresh, geometry)
        if after["layout"] != source["layout"] or _target(after, name, literal) != target:
            fail("VISUAL_KEYBOARD_LAYOUT_CHANGED")
        if v.ios._masked(config["node"], session, fresh, keyboard_masks) == expected_keyboard:
            if v.ios._masked(config["node"], session, fresh, masks) == expected:
                return after
            if "caret" in config["keyboard"] and k._caret_equivalent(session, config, definition, observation, fresh, geometry, masks):
                return after
        if attempt == 5 or time.monotonic() >= deadline:
            break
        time.sleep(min(.05, session.budget.timeout()))
    fail("VISUAL_FRAME_CHANGED")


def dispatch_key(session, lease, config, definition, observation, geometry, bound, source, name, quota, *, literal=False, phase):
    """One physical key; deliberately separate from /actions→Dismiss dispatch."""
    k, v = _keyboard(), _keyboard()._visual()
    v._geometry(session, observation, geometry)
    k._visible_layout(session, config, definition, observation, bound)
    fresh_source = _fresh_key(session, lease, config, definition, observation, geometry, source, name, literal)
    current = read_source(session, config, observation, geometry)
    if current["layout"] != fresh_source["layout"]:
        fail("VISUAL_KEYBOARD_LAYOUT_CHANGED")
    target = _target(current, name, literal)
    if target != _target(source, name, literal):
        fail("VISUAL_KEYBOARD_LAYOUT_CHANGED")
    x, y, width, height = target["rect"]
    point = _key_point(target)
    if (not 0 <= point[0] < geometry[0] or not 0 <= point[1] < geometry[1]
            or not x <= point[0] < x + width or not y <= point[1] < y + height):
        fail("VISUAL_COORDINATES_UNVERIFIED")
    v._geometry(session, observation, geometry)
    if quota["keys"] >= 64:
        fail("VISUAL_KEY_INPUT_BUDGET")
    session.budget.action()
    quota["keys"] += 1
    atomic_json(session.output / "write-intent.json", {"effect": definition["effect"], "status": "unknown", "automaticRetry": False})
    session._visual_dispatched = True
    trace = {"ordinal": quota["keys"], "phase": phase, "control": "literal" if literal else name,
             "sourceSha256": current["sourceSha256"], "automaticRetry": False}
    session.event("visual_keyboard_key_started", **trace, status="unknown")
    body = {"actions": [{"type": "pointer", "id": POINTER_ID, "parameters": {"pointerType": "touch"},
                         "actions": [{"type": "pointerMove", "duration": 0, "x": point[0], "y": point[1], "origin": "viewport"},
                                     {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}]}]}
    result = session.backend.request("POST", "/actions", body)
    session.event("visual_keyboard_key_finished", **trace, status="dispatched")
    return result


def _state(session, lease, config, definition, geometry, bound, observation=None):
    k = _keyboard()
    if observation is None:
        observation, _ = k._observe(session, lease, config, geometry, True)
    k._visible_layout(session, config, definition, observation, bound)
    return observation, read_source(session, config, observation, geometry)


def _switch_unchanged(session, config, definition, before, after, geometry):
    """A switch must not change input/upper pixels in the two actual OCR frames.

    Do not replace either already observed frame with a later fresh capture: a
    transient conflicting input may have recovered by then. Only the locally
    approved Keyboard/result regions and existing caret exception may differ.
    """
    k, v = _keyboard(), _keyboard()._visual()
    masks = [config["keyboard"]["region"], definition["resultRegion"]]
    if v.ios._masked(config["node"], session, before, masks) == v.ios._masked(config["node"], session, after, masks):
        return
    if "caret" in config["keyboard"] and k._caret_equivalent(session, config, definition, before, after, geometry, masks):
        return
    fail("VISUAL_FRAME_CHANGED")


def replace_text(session, lease, config, definition, text, bound, geometry, focused):
    """Full ASCII domain with at most two proven layer switches per character."""
    validate_text(text)
    complete_text = config["keyboard"]["keyInput"].get("confirmation", "each_prefix") == "complete_text"
    fixed_clear = config["keyboard"]["keyInput"].get("clearPlan", "observed_shortening") == "fixed_max_length"
    quota = {"keys": 0}
    observation, source = _state(session, lease, config, definition, geometry, bound, focused)
    echo = region_text(observation, definition["valueRegion"])
    for _ in range(definition["inputSchema"]["maxLength"]):
        if not fixed_clear and echo == "":
            break
        dispatch_key(session, lease, config, definition, observation, geometry, bound, source, "delete", quota, phase="clear")
        _keyboard()._visual()._settle(session)
        observation, source = _state(session, lease, config, definition, geometry, bound)
        shortened = region_text(observation, definition["valueRegion"])
        # A fixed plan is chosen locally before any UI action. An intermediate
        # empty/missing glyph cannot shorten it or trigger an extra delete.
        # maxLength bounds the requested value, not arbitrary existing contents;
        # final empty OCR is an echo condition, not proof of a hidden buffer.
        if not fixed_clear and len(shortened) >= len(echo):
            fail("VISUAL_INPUT_CLEAR_NOT_VERIFIED")
        echo = shortened
    if echo != "":
        fail("VISUAL_INPUT_CLEAR_NOT_VERIFIED")
    prefix = ""
    for char in text:
        expected_layer = "digits" if char.isdigit() else "upper" if char.isupper() else "lower"
        for _ in range(2):
            if char in source["literals"]:
                break
            control = "letters" if source["layer"] == "digits" else "numbers" if expected_layer == "digits" else "shift"
            before_switch = observation
            dispatch_key(session, lease, config, definition, observation, geometry, bound, source, control, quota, phase="switch")
            _keyboard()._visual()._settle(session)
            observation, source = _state(session, lease, config, definition, geometry, bound)
            _switch_unchanged(session, config, definition, before_switch, observation, geometry)
            observed_echo = region_text(observation, definition["valueRegion"])
            if not complete_text and observed_echo != prefix:
                fail("VISUAL_INPUT_NOT_VERIFIED")
            if control == "letters":
                if source["layer"] not in ("lower", "upper"):
                    fail("VISUAL_KEYBOARD_LAYER_NOT_VERIFIED")
            elif source["layer"] != expected_layer:
                fail("VISUAL_KEYBOARD_LAYER_NOT_VERIFIED")
        if char not in source["literals"]:
            fail("VISUAL_KEYBOARD_KEY_UNVERIFIED")
        dispatch_key(session, lease, config, definition, observation, geometry, bound, source, char, quota, literal=True, phase="type")
        _keyboard()._visual()._settle(session)
        observation, source = _state(session, lease, config, definition, geometry, bound)
        prefix += char
        # complete_text still captures/validates a new full OCR observation after
        # every physical key. Its intermediate text does not alter this fixed
        # finite key program, and never triggers a retry or an inferred delete.
        observed_echo = region_text(observation, definition["valueRegion"])
        if not complete_text and observed_echo != prefix:
            fail("VISUAL_INPUT_NOT_VERIFIED")
    if region_text(observation, definition["valueRegion"]) != text:
        fail("VISUAL_INPUT_NOT_VERIFIED")
    return observation
