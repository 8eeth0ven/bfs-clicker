"""Explicit docked-keyboard phases for the native iOS visual text adapter.

The server owner supplies a fixed visual envelope, a matching AX-source region
(the same rectangle when omitted), and an outside-keyboard
OCR dismissal anchor. WDA's bounded hierarchy must show exactly that rectangle
as one visible keyboard with visible keys. The rectangle is masked only while
that evidence is present; the original full layout is required after dismissal.
This is not proof that WDA's hierarchy identifies an OS-owned window or handler.
"""
from __future__ import annotations

import json
import math
import os
import re
import select
import signal
import subprocess
import time
import uuid
import xml.etree.ElementTree as ET

from .mobile_ui import MAX_XML, MobileError, atomic_json, digest
from .mobile_visual import capture_locked
from .mobile_visual_workflow import _region, ground_anchor, region_text

GAPS = [
    "trusted_fixed_docked_keyboard_region_required",
    "trusted_keyboard_visual_envelope_temporarily_masked_while_ax_source_region_matches",
    "keyboard_envelope_padding_is_local_authority_not_os_ownership_proof",
    "wda_keyboard_tree_does_not_prove_os_window_ownership",
    "keyboard_hierarchy_and_pixels_are_not_atomic",
    "outside_keyboard_dismiss_anchor_required",
    "other_keyboard_layouts_physical_and_third_party_coverage_pending",
    "visible_keyboard_freshness_uses_post_ocr_pixels_with_keyboard_and_result_masks",
]
CARET_GAPS = [
    "local_caret_color_shape_equivalence_is_not_system_caret_identity_proof",
    "same_colored_narrow_glyph_changes_may_match_approved_caret_policy",
]
CARET_JS = """import {visualCaretEquivalent} from './src/visual-caret.js';
let s='';for await(const x of process.stdin){s+=x;if(Buffer.byteLength(s)>16384)throw Error('input limit');}
const a=JSON.parse(s);process.stdout.write(JSON.stringify(visualCaretEquivalent(a.before,a.after,a.options)));"""


def fail(code):
    raise MobileError(code, "blocked")


def _visual():
    from . import mobile_visual_ios_text
    return mobile_visual_ios_text


def caret_contract(value):
    keys = {"enabled", "color", "background", "colorTolerance", "maxWidthPoints",
            "minHeightPoints", "maxHeightPoints", "maxAreaPoints"}
    if not isinstance(value, dict) or set(value) != keys or value.get("enabled") is not True:
        fail("VISUAL_CARET_CONFIG_INVALID")
    for key in ("color", "background"):
        if (not isinstance(value[key], list) or len(value[key]) != 3
                or any(not isinstance(channel, int) or isinstance(channel, bool)
                       or not 0 <= channel <= 255 for channel in value[key])):
            fail("VISUAL_CARET_CONFIG_INVALID")
    if max(abs(a - b) for a, b in zip(value["color"], value["background"])) < 64:
        fail("VISUAL_CARET_CONFIG_INVALID")
    tolerance = value["colorTolerance"]
    if not isinstance(tolerance, int) or isinstance(tolerance, bool) or not 0 <= tolerance <= 2:
        fail("VISUAL_CARET_CONFIG_INVALID")
    for key in ("maxWidthPoints", "minHeightPoints", "maxHeightPoints", "maxAreaPoints"):
        if (not isinstance(value[key], (int, float)) or isinstance(value[key], bool)
                or not math.isfinite(value[key])):
            fail("VISUAL_CARET_CONFIG_INVALID")
    if (not 0 < value["maxWidthPoints"] <= 3 or not 8 <= value["minHeightPoints"] <= value["maxHeightPoints"] <= 48
            or not 0 < value["maxAreaPoints"] <= 144):
        fail("VISUAL_CARET_CONFIG_INVALID")
    return value


def gaps(config):
    return GAPS + (CARET_GAPS if "caret" in config else [])


def keyboard_contract(value, definition):
    if (
        not isinstance(value, dict) or not {"enabled", "region", "dismissAnchor"} <= set(value)
        or set(value) - {"enabled", "region", "sourceRegion", "dismissAnchor", "caret"}
        or value.get("enabled") is not True
        or not isinstance(value.get("dismissAnchor"), str)
        or not re.fullmatch(r"[A-Za-z0-9_]{1,32}", value["dismissAnchor"])
        or value["dismissAnchor"] in {definition["focusAnchor"], definition["submitAnchor"]}
    ):
        fail("VISUAL_KEYBOARD_CONFIG_INVALID")
    if "caret" in value:
        caret_contract(value["caret"])
    region = _region(value["region"])
    source = _region(value.get("sourceRegion", region))
    # A single owner-approved full-width near-bottom keyboard, not an arbitrary
    # collection of areas whose changes could conceal application navigation.
    # iOS may exclude its home-indicator strip from AX Keyboard bounds. Without
    # a separate locally approved visual envelope, that gap is never masked.
    for rectangle in (region, source):
        if rectangle["x"] != 0 or rectangle["width"] != 1 or not .4 <= rectangle["y"] <= .85 or not .95 <= rectangle["y"] + rectangle["height"] <= 1:
            fail("VISUAL_KEYBOARD_CONFIG_INVALID")
    top = source["y"] - region["y"]
    bottom = region["y"] + region["height"] - source["y"] - source["height"]
    # The AX keyboard may omit a narrow shadow/background and home indicator.
    # Their separate visual envelope must be explicitly approved locally. Never
    # grow it from MCP parameters or silently round it to the screen bottom.
    if top < -1e-9 or bottom < -1e-9 or top > .025 + 1e-9 or bottom > .05 + 1e-9:
        fail("VISUAL_KEYBOARD_PADDING_INVALID")
    v = _visual()
    if v._intersects(v._box(region, 1, 1, rounded=False), v._box(definition["valueRegion"], 1, 1, rounded=False)):
        fail("VISUAL_KEYBOARD_OCCLUDES_INPUT")
    return value


def _anchor(value, name, dimensions):
    if (
        not isinstance(value, dict) or set(value) != {"anchor", "width", "height", "normalized"}
        or value["anchor"] != name or (value["width"], value["height"]) != dimensions
        or any(not isinstance(value[key], int) or isinstance(value[key], bool)
               or not 1 <= value[key] <= 20000 for key in ("width", "height"))
    ):
        fail("VISUAL_RECIPE_INVALID")
    try:
        _region(value["normalized"])
    except MobileError:
        fail("VISUAL_RECIPE_INVALID")


def validate_learned(config, learned, focus):
    if (
        not isinstance(learned, dict) or set(learned) != {"configDigest", "dismiss", "visiblePixels"}
        or learned["configDigest"] != digest(config)
        or not isinstance(learned["visiblePixels"], str)
        or not re.fullmatch(r"[a-f0-9]{64}", learned["visiblePixels"])
    ):
        fail("VISUAL_RECIPE_INVALID")
    _anchor(learned["dismiss"], config["dismissAnchor"], (focus["width"], focus["height"]))
    return learned


def _rect(node):
    try:
        values = tuple(float(node.attrib[key]) for key in ("x", "y", "width", "height"))
    except (KeyError, TypeError, ValueError):
        fail("VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED")
    if any(not math.isfinite(x) for x in values) or values[0] < 0 or values[1] < 0 or values[2] <= 0 or values[3] <= 0:
        fail("VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED")
    return values


def _parse_source(raw, app_id):
    if not isinstance(app_id, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,256}", app_id):
        fail("VISUAL_KEYBOARD_APP_UNVERIFIED")
    try:
        size = len(raw.encode("utf8")) if isinstance(raw, str) else MAX_XML + 1
    except UnicodeError:
        fail("VISUAL_KEYBOARD_SOURCE_INVALID")
    if size > MAX_XML or re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", raw, re.I):
        fail("VISUAL_KEYBOARD_SOURCE_INVALID")
    try:
        root = ET.fromstring(raw)
    except (ET.ParseError, ValueError):
        fail("VISUAL_KEYBOARD_SOURCE_INVALID")
    stack, keyboards, applications, count = [(root, 0)], [], [], 0
    while stack:
        node, depth = stack.pop()
        count += 1
        if count > 10000 or depth > 64:
            fail("VISUAL_KEYBOARD_SOURCE_LIMIT")
        kind = node.attrib.get("type", node.tag)
        if kind == "XCUIElementTypeApplication":
            applications.append(node)
        if kind == "XCUIElementTypeKeyboard":
            # A hidden keyboard may be translated below the viewport (as in
            # the captured WDA evidence), but malformed geometry is not a phase.
            _rect(node)
            if node.attrib.get("visible") not in ("true", "false"):
                fail("VISUAL_KEYBOARD_SOURCE_INVALID")
            if node.attrib["visible"] == "true":
                keyboards.append(node)
        stack.extend((child, depth + 1) for child in node)
    if len(applications) != 1 or applications[0].attrib.get("bundleId") != app_id:
        fail("VISUAL_KEYBOARD_APP_UNVERIFIED")
    if any(keyboard not in set(applications[0].iter()) for keyboard in keyboards):
        fail("VISUAL_KEYBOARD_APP_UNVERIFIED")
    if len(keyboards) > 1:
        fail("VISUAL_KEYBOARD_AMBIGUOUS")
    return keyboards


def inspect_source(raw, geometry, app_id):
    """Observation only: a calibration proposal, never an action grant.

    The owner must approve the returned rectangle in local device configuration.
    This function deliberately does not dispatch, alter settings, or mask pixels.
    """
    keyboards = _parse_source(raw, app_id)
    if not keyboards:
        return None
    if (not isinstance(geometry, (tuple, list)) or len(geometry) != 2
            or any(not isinstance(value, (int, float)) or isinstance(value, bool)
                   or not math.isfinite(value) or not 0 < value <= 16384 for value in geometry)):
        fail("VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED")
    keyboard = keyboards[0]
    x, y, width, height = _rect(keyboard)
    screen_width, screen_height = geometry
    if x + width > screen_width or y + height > screen_height:
        fail("VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED")
    keys = [node for node in keyboard.iter()
            if node.attrib.get("type", node.tag) == "XCUIElementTypeKey" and node.attrib.get("visible") == "true"]
    if not keys:
        fail("VISUAL_KEYBOARD_KEYS_UNVERIFIED")
    for key in keys:
        kx, ky, kw, kh = _rect(key)
        if kx < x or ky < y or kx + kw > x + width or ky + kh > y + height:
            fail("VISUAL_KEYBOARD_KEYS_UNVERIFIED")
    return {"region": {"x": x / screen_width, "y": y / screen_height,
                       "width": width / screen_width, "height": height / screen_height},
            "keyCount": len(keys)}


def keyboard_state(session, config, observation, geometry, visible):
    """Read a bounded WDA hierarchy; no role or dismissal receipt is proof."""
    session.backend.foreground()
    raw = session.backend.request("GET", "/source")
    if visible is False:
        if _parse_source(raw, session.backend.app_id):
            fail("VISUAL_KEYBOARD_NOT_HIDDEN")
        session.backend.foreground()
        return None
    proposal = inspect_source(raw, geometry, session.backend.app_id)
    session.backend.foreground()
    if proposal is None:
        if visible is True:
            fail("VISUAL_KEYBOARD_NOT_VISIBLE")
        # None requests observation of the preparation phase, never permission
        # to mask a missing keyboard or to repeat an input action.
        return None
    actual = proposal["region"]
    v = _visual()
    # Exact outward-rounded pixel bounds: no owner-approved extra area beyond
    # the observed keyboard is silently excluded from change detection.
    source = config.get("sourceRegion", config["region"])
    if v._box(actual, observation["width"], observation["height"]) != v._box(source, observation["width"], observation["height"]):
        fail("VISUAL_KEYBOARD_REGION_MISMATCH")
    actual_box = v._box(actual, observation["width"], observation["height"])
    envelope_box = v._box(config["region"], observation["width"], observation["height"])
    if any(actual_box[index] < envelope_box[index] for index in (0, 1)) or any(actual_box[index] > envelope_box[index] for index in (2, 3)):
        fail("VISUAL_KEYBOARD_PADDING_INVALID")
    top = (source["y"] - config["region"]["y"]) * geometry[1]
    bottom = (config["region"]["y"] + config["region"]["height"] - source["y"] - source["height"]) * geometry[1]
    if top > 12 + 1e-9 or bottom > 24 + 1e-9 or top < -1e-9 or bottom < -1e-9:
        fail("VISUAL_KEYBOARD_PADDING_INVALID")
    return actual


def _observe(session, lease, config, geometry=None, visible=False, reference=None):
    v = _visual()
    # Dimensions from geometry are needed to compare the source rectangle;
    # the initial hidden check does not use rectangle math.
    provisional = reference or ({"width": 1, "height": 1} if geometry is None else {"width": geometry[0], "height": geometry[1]})
    keyboard_state(session, config["keyboard"], provisional, geometry, visible)
    observation = v._observe(session, lease, config)
    actual_geometry = v._geometry(session, observation, geometry)
    keyboard_state(session, config["keyboard"], observation, actual_geometry, visible)
    # Hidden phases retain the original exact-image guard. Visible actions
    # separately verify post-OCR pixels without masking the input region.
    if not visible:
        v.unchanged_locked(session, lease, session.output / "visual-private", observation)
    return observation, actual_geometry


def _prepare_observe(session, lease, config, geometry, reference):
    """Lock the source-observed phase around OCR after one clear/type action.

    Unlike the post-Dismiss hidden observation, preparation can retain an
    active caret. Its dispatch guard checks decoded pixels with only the result
    masked when hidden; it never borrows a keyboard mask from an earlier phase.
    """
    v = _visual()
    visible = keyboard_state(session, config["keyboard"], reference, geometry, None) is not None
    observation = v._observe(session, lease, config)
    actual_geometry = v._geometry(session, observation, geometry)
    keyboard_state(session, config["keyboard"], observation, actual_geometry, visible)
    return observation, actual_geometry, visible


def _dismiss_anchor(observation, definition, keyboard, expected=None):
    v = _visual()
    anchor = ground_anchor(observation, keyboard["dismissAnchor"], expected)
    masks = [definition["valueRegion"], definition["resultRegion"], keyboard["region"]]
    box = tuple(round(x) for x in v._box(anchor["normalized"], observation["width"], observation["height"], rounded=False))
    if any(v._intersects(box, v._box(mask, observation["width"], observation["height"])) for mask in masks):
        fail("VISUAL_KEYBOARD_MASK_OVERLAPS_ANCHOR")
    return anchor


def _visible_layout(session, config, definition, observation, bound):
    v = _visual()
    region = config["keyboard"]["region"]
    keyboard_box = v._box(region, observation["width"], observation["height"])
    # A system key named Search must not become a duplicate application
    # submit anchor. Only tokens fully outside the proven keyboard participate.
    tokens = []
    for token in observation["tokens"]:
        b = token["bounds"]
        box = (b["x"], b["y"], b["x"] + b["width"], b["y"] + b["height"])
        if not v._intersects(box, keyboard_box):
            tokens.append(token)
    outside = {**observation, "tokens": tokens}
    masks = [definition["valueRegion"], definition["resultRegion"], region]
    for name, key in ((definition["focusAnchor"], "focus"), (definition["submitAnchor"], "submit")):
        anchor = ground_anchor(outside, name, bound[key])
        box = tuple(round(x) for x in v._box(anchor["normalized"], observation["width"], observation["height"], rounded=False))
        if any(v._intersects(box, v._box(mask, observation["width"], observation["height"])) for mask in masks):
            fail("VISUAL_KEYBOARD_MASK_OVERLAPS_ANCHOR")
    dismissal = _dismiss_anchor(outside, definition, config["keyboard"], bound["_keyboard"]["dismiss"])
    if v.ios._masked(config["node"], session, observation, masks) != bound["_keyboard"]["visiblePixels"]:
        fail("VISUAL_LAYOUT_CHANGED")
    return dismissal


def _prepare_layout(session, config, definition, observation, bound, visible):
    if visible:
        return _visible_layout(session, config, definition, observation, bound)
    # The original two-region layout fingerprint includes the whole area that
    # used to contain the keyboard. Only input and result are layout-dynamic.
    _visual()._layout(session, config, definition, observation, bound)
    return _dismiss_anchor(observation, definition, config["keyboard"], bound["_keyboard"]["dismiss"])


def _pointer(anchor, geometry):
    box = anchor["normalized"]
    x, y = int((box["x"] + box["width"] / 2) * geometry[0]), int((box["y"] + box["height"] / 2) * geometry[1])
    if not 0 <= x < geometry[0] or not 0 <= y < geometry[1]:
        fail("VISUAL_COORDINATES_UNVERIFIED")
    return {"actions": [{"type": "pointer", "id": "finger", "parameters": {"pointerType": "touch"},
                         "actions": [{"type": "pointerMove", "duration": 0, "x": x, "y": y, "origin": "viewport"},
                                     {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}]}]}


def _visible_fresh(session, lease, config, definition, observation, geometry, bound, visible=True):
    v = _visual()
    # The result may be obscured and is not used until restoration. The INPUT
    # IS NOT MASKED here: new characters, erased glyphs or moved app anchors
    # after OCR invalidate dispatch. Keyboard/candidate-row animations alone
    # may differ. Without the explicit local caret policy, read-only captures
    # may only wait for the exact same caret phase. The optional comparator is
    # restricted to a bounded single approved color-line bar inside the input.
    masks = ([config["keyboard"]["region"]] if visible else []) + [definition["resultRegion"]]
    expected = v.ios._masked(config["node"], session, observation, masks)
    deadline = time.monotonic() + 2
    # Preserve the existing visible same-phase read bound. A newly supported
    # hidden preparation phase adds no polling or extra settling wait.
    attempts = 6 if visible else 1
    for attempt in range(attempts):
        session.budget.check()
        keyboard_state(session, config["keyboard"], observation, geometry, visible)
        captured = capture_locked(session, session.output / "visual-private" / ("keyboard-fresh-" + uuid.uuid4().hex), lease)
        fresh = {**captured, "_imagePath": captured["imagePath"]}
        v._geometry(session, fresh, geometry)
        keyboard_state(session, config["keyboard"], fresh, geometry, visible)
        if (fresh["width"], fresh["height"]) != (observation["width"], observation["height"]):
            fail("VISUAL_COORDINATES_UNVERIFIED")
        if v.ios._masked(config["node"], session, fresh, masks) == expected:
            return
        if "caret" in config["keyboard"] and _caret_equivalent(session, config, definition, observation, fresh, geometry, masks):
            return
        if attempt == attempts - 1 or time.monotonic() >= deadline:
            break
        time.sleep(min(.05, session.budget.timeout()))
    fail("VISUAL_FRAME_CHANGED")


def _caret_equivalent(session, config, definition, before, after, geometry, masks):
    """Bounded local Node helper; all failure paths reap the owned process."""
    policy = caret_contract(config["keyboard"]["caret"])
    payload = json.dumps({"before": before["_imagePath"], "after": after["_imagePath"], "options": {
        "masks": masks, "valueRegion": definition["valueRegion"], "geometry": geometry, "policy": policy,
    }}).encode()
    if len(payload) > 16384:
        fail("VISUAL_CARET_UNAVAILABLE")
    child, completed = None, False
    try:
        session.budget.check()
        child = subprocess.Popen([config["node"], "--input-type=module", "-e", CARET_JS], cwd=_visual().ios.PROJECT,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        child.stdin.write(payload)
        child.stdin.close()
        blocks, size = [], 0
        while True:
            session.budget.check()
            ready, _, _ = select.select([child.stdout], [], [], min(.1, session.budget.timeout()))
            if not ready:
                continue
            block = os.read(child.stdout.fileno(), 4097 - size)
            if not block:
                break
            size += len(block)
            if size > 4096:
                fail("VISUAL_CARET_UNAVAILABLE")
            blocks.append(block)
        if child.wait(timeout=session.budget.timeout()) != 0:
            fail("VISUAL_CARET_UNAVAILABLE")
        result = json.loads(b"".join(blocks))
        if (not isinstance(result, dict) or set(result) != {"width", "height", "equivalent", "mode", "changedPixels"}
                or any(not isinstance(result[key], int) or isinstance(result[key], bool)
                       or result[key] != before[key] for key in ("width", "height"))
                or not isinstance(result["equivalent"], bool)
                or result["mode"] not in ("exact", "caret", "changed")
                or result["equivalent"] != (result["mode"] in ("exact", "caret"))
                or not isinstance(result["changedPixels"], int) or isinstance(result["changedPixels"], bool)
                or not 0 <= result["changedPixels"] <= before["width"] * before["height"]
                or (result["mode"] == "exact") != (result["changedPixels"] == 0)):
            raise ValueError()
        session.budget.check()
        completed = True
        return result["equivalent"]
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        fail("VISUAL_CARET_UNAVAILABLE")
    finally:
        if child is not None:
            if not completed:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            if child.poll() is None:
                child.kill()
            child.wait()
            for stream in (child.stdin, child.stdout):
                if stream is not None and not stream.closed:
                    try:
                        stream.close()
                    except OSError:
                        pass


def _dispatch(session, lease, config, definition, observation, geometry, visible, method, route, body, bound=None, preparing=False):
    v = _visual()
    v._geometry(session, observation, geometry)
    if visible or preparing:
        if bound is None:
            fail("VISUAL_RECIPE_INVALID")
        # The supplied phase observation has fresh full-region OCR. Validate its
        # anchors/layout, then prove the input and upper page pixels still match
        # with a post-OCR capture. Do not use a hidden-input mask for freshness.
        dismissal = _prepare_layout(session, config, definition, observation, bound, visible)
        _visible_fresh(session, lease, config, definition, observation, geometry, bound, visible)
        if route == "/actions":
            body = _pointer(dismissal, geometry)
    else:
        keyboard_state(session, config["keyboard"], observation, geometry, False)
        v.unchanged_locked(session, lease, session.output / "visual-private", observation)
    keyboard_state(session, config["keyboard"], observation, geometry, visible)
    v._geometry(session, observation, geometry)
    session.budget.action()
    atomic_json(session.output / "write-intent.json", {"effect": definition["effect"], "status": "unknown", "automaticRetry": False})
    session._visual_dispatched = True
    return session.backend.request(method, route, body)


def _tap(session, lease, config, definition, observation, geometry, visible, anchor, bound=None, preparing=False):
    return _dispatch(session, lease, config, definition, observation, geometry, visible,
                     "POST", "/actions", _pointer(anchor, geometry), bound, preparing)


def run(session, lease, config, definition, inputs, contracts):
    v = _visual()
    text = v._text_value(definition, inputs)
    keyboard = keyboard_contract(config.get("keyboard"), definition)
    try:
        before, geometry = _observe(session, lease, config, visible=False)
        anchors, fingerprint = v._layout(session, config, definition, before, contracts)
        dismissal = _dismiss_anchor(before, definition, keyboard, contracts.get("_keyboard", {}).get("dismiss"))
        masked = v.ios._masked(config["node"], session, before,
                               [definition["valueRegion"], definition["resultRegion"], keyboard["region"]])
        # Retain the approved learned anchor contract after ground_anchor has
        # checked the newly observed box; do not turn permitted OCR-box jitter
        # into an unrelated exact-dict comparison failure.
        previous = contracts.get("_keyboard")
        learned = {"configDigest": digest(keyboard),
                   "dismiss": previous["dismiss"] if previous is not None else dismissal,
                   "visiblePixels": masked}
        if contracts.get("_keyboard") not in (None, learned):
            fail("VISUAL_LAYOUT_CHANGED")
        bound = {**anchors, "_pixels": fingerprint, "_keyboard": learned}
        # Full initial OCR has already grounded all application anchors. Do
        # not let any owner-approved keyboard mask intersect an actual target.
        keyboard_box = v._box(keyboard["region"], before["width"], before["height"])
        if v._intersects(keyboard_box, v._box(definition["valueRegion"], before["width"], before["height"])):
            fail("VISUAL_KEYBOARD_OCCLUDES_INPUT")
        target_boxes = [tuple(round(x) for x in v._box(a["normalized"], before["width"], before["height"], rounded=False))
                        for a in [anchors["focus"], anchors["submit"], dismissal]]
        if any(v._intersects(box, keyboard_box) for box in target_boxes):
            fail("VISUAL_KEYBOARD_MASK_OVERLAPS_ANCHOR")
        if any(v._intersects(box, other) for index, box in enumerate(target_boxes) for other in target_boxes[index+1:]):
            fail("VISUAL_ANCHOR_AMBIGUOUS")
        _tap(session, lease, config, definition, before, geometry, False, anchors["focus"])
        v._settle(session)
        focused, _ = _observe(session, lease, config, geometry, True, before)
        _visible_layout(session, config, definition, focused, bound)
        # Hardware typeKey Cmd+A/Delete can switch off the software keyboard
        # even after its visibility was proved. The explicit software-keyboard
        # path uses one fixed text-event clear request instead; this is not a
        # fallback after failure, and complete empty OCR is still mandatory.
        _dispatch(session, lease, config, definition, focused, geometry, True, "POST", "/keys", {
            "value": ["\b" * definition["inputSchema"]["maxLength"]]}, bound)
        v._settle(session)
        cleared, _, cleared_visible = _prepare_observe(session, lease, config, geometry, before)
        _prepare_layout(session, config, definition, cleared, bound, cleared_visible)
        if region_text(cleared, definition["valueRegion"]) != "":
            fail("VISUAL_INPUT_CLEAR_NOT_VERIFIED")
        _dispatch(session, lease, config, definition, cleared, geometry, cleared_visible, "POST", "/keys", {"value": [text]}, bound, preparing=True)
        v._settle(session)
        filled, _, filled_visible = _prepare_observe(session, lease, config, geometry, before)
        dismissal = _prepare_layout(session, config, definition, filled, bound, filled_visible)
        if region_text(filled, definition["valueRegion"]) != text:
            fail("VISUAL_INPUT_NOT_VERIFIED")
        # No result baseline is read while the keyboard can cover the output.
        _tap(session, lease, config, definition, filled, geometry, filled_visible, dismissal, bound, preparing=True)
        v._settle(session)
        restored, _ = _observe(session, lease, config, geometry, False)
        restored_anchors, _ = v._layout(session, config, definition, restored, bound)
        _dismiss_anchor(restored, definition, keyboard, dismissal)
        if region_text(restored, definition["valueRegion"]) != text:
            fail("VISUAL_INPUT_NOT_VERIFIED")
        old = region_text(restored, definition["resultRegion"])
        _tap(session, lease, config, definition, restored, geometry, False, restored_anchors["submit"])
        v._settle(session)
        after, _ = _observe(session, lease, config, geometry, False)
        v._layout(session, config, definition, after, bound)
        result = region_text(after, definition["resultRegion"])
        if (region_text(after, definition["valueRegion"]) != text or result == old
                or not result.startswith(definition["resultPrefix"] + " ")
                or not re.search(r"(?:^|\s)" + re.escape(text) + r"(?:$|\s)", result)):
            fail("VISUAL_RESULT_NOT_VERIFIED")
        v.unchanged_locked(session, lease, session.output / "visual-private", after)
        keyboard_state(session, keyboard, after, geometry, False)
        contracts.update(bound)
        return {"text": result}
    except Exception as exc:
        if getattr(session, "_visual_dispatched", False):
            exc.writeOutcome = {"status": "unknown", "automaticRetry": False}
        raise
