"""Bounded native UI adapters. No installation, proxy, CA, or settings changes.

The config is trusted local data. Public manifests never contain transport URLs,
session IDs, selectors, XML, or entered values. Recipes are private preconditioned
UI paths; a successful UI command is not proof of HTTP or business success.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import quote, urlsplit
import uuid
import xml.etree.ElementTree as ET
from . import android_unicode

try:
    import fcntl
except ImportError:  # Observation still works; mutation requires an exclusive lease.
    fcntl = None

MAX_JSON = 8 * 1024 * 1024
MAX_XML = 4 * 1024 * 1024
SELECTOR_KEYS = {"resourceId", "accessibilityId", "text", "className"}
RISK = re.compile(r"delete|remove|logout|sign.?out|pay|purchase|submit|send|confirm|revoke|reset|post\b|删除|注销|退出|支付|购买|提交|发送|确认|重置", re.I)
READ = re.compile(r"\bget\b|open|view|show|detail|next|previous|menu|tab|list|search|查看|打开|详情|下一|上一|菜单|列表|搜索|展开", re.I)


class MobileError(Exception):
    def __init__(self, code, status="failed"):
        super().__init__(code)
        self.code, self.status = code, status


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def safe_text(value, maximum=160):
    text = str(value or "")[:1024]
    text = re.sub(r"(?i)(bearer|basic)\s+\S+", r"\1 [REDACTED]", text)
    text = re.sub(r"(?i)(token|password|secret|api[_-]?key|authorization|cookie)\s*[:=]\s*[^\s,;]+", r"\1=[REDACTED]", text)
    return text[:maximum]


def read_json(path, limit=MAX_JSON):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise MobileError("JSON_FILE_REJECTED")
    try:
        value = json.loads(path.read_bytes())
    except (ValueError, OSError):
        raise MobileError("JSON_INVALID") from None
    return value


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise MobileError("OUTPUT_SYMLINK_REJECTED")
    fd, name = tempfile.mkstemp(prefix=".mobile-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(value, stream, ensure_ascii=False, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def selector(value):
    if not isinstance(value, dict) or not value or set(value) - SELECTOR_KEYS:
        raise MobileError("SELECTOR_INVALID")
    if any(not isinstance(v, str) or not v or len(v) > 512 for v in value.values()):
        raise MobileError("SELECTOR_INVALID")
    return dict(value)


def xpath_literal(value):
    if "'" not in value:
        return "'" + value + "'"
    if '"' not in value:
        return '"' + value + '"'
    return "concat(" + ',"\'",'.join("'" + part + "'" for part in value.split("'")) + ")"


def bounds(attrs):
    found = re.fullmatch(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]", attrs.get("bounds", ""))
    try:
        if found:
            x, y, right, bottom = map(int, found.groups())
            result = [x, y, right - x, bottom - y]
        else:
            result = [int(float(attrs.get(k, 0))) for k in ("x", "y", "width", "height")]
    except (ValueError, OverflowError):
        return None
    return result if result[0] >= 0 and result[1] >= 0 and 0 < result[2] <= 20000 and 0 < result[3] <= 20000 and result[0] + result[2] <= 20000 and result[1] + result[3] <= 20000 else None


def parse_tree(xml, platform, app_id, input_suffix=None):
    if not isinstance(xml, str) or len(xml.encode()) > MAX_XML or re.search(r"<!DOCTYPE|<!ENTITY", xml, re.I):
        raise MobileError("UI_SOURCE_REJECTED")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        raise MobileError("UI_SOURCE_INVALID") from None
    nodes, stack, visited = [], [(root, 0, [], None, False)], 0
    while stack:
        element, depth, ancestors, selection_group, accessible_button_ancestor = stack.pop()
        visited += 1
        if visited > 10000 or depth > 64:
            raise MobileError("UI_SOURCE_LIMIT")
        attrs = element.attrib
        cls = attrs.get("class", attrs.get("type", element.tag))[:512]
        # System keyboard keys are not application controls, even when WDA
        # serializes the keyboard underneath the foreground application.
        if platform == "ios" and cls == "XCUIElementTypeKeyboard":
            continue
        container = {"resourceId": attrs.get("resource-id", attrs.get("resourceId", ""))[:512], "accessibilityId": attrs.get("content-desc", attrs.get("name", ""))[:512], "className": cls}
        is_container = bool(list(element)) and bool(container["resourceId"] or container["accessibilityId"]) and not re.search(r"Application|Window|DecorView", cls, re.I)
        if platform == "android" and (container["resourceId"].startswith("android:") or attrs.get("package") not in {None, "", app_id}):
            is_container = False
        descendants = (ancestors + [container])[-8:] if is_container else ancestors
        selection_kind = "radio" if platform == "android" and cls == "android.widget.RadioGroup" else "segmented" if platform == "ios" and cls == "XCUIElementTypeSegmentedControl" else ""
        next_selection_group = {"kind": selection_kind, **container} if selection_kind else selection_group
        stack.extend((child, depth + 1, descendants, next_selection_group, accessible_button_ancestor or platform == "ios" and cls == "XCUIElementTypeButton" and attrs.get("accessible") == "true") for child in reversed(list(element)))
        if platform == "android" and attrs.get("package") and attrs["package"] != app_id:
            continue
        secure = attrs.get("password") == "true" or "securetextfield" in cls.lower()
        editable = bool(re.search(r"EditText|TextField|TextView", cls, re.I)) and (platform == "ios" or "EditText" in cls)
        text = "" if secure or editable else attrs.get("text", attrs.get("label", ""))[:512]
        data = {"resourceId": attrs.get("resource-id", attrs.get("resourceId", ""))[:512],
                "accessibilityId": attrs.get("content-desc", attrs.get("name", ""))[:512],
                "text": text, "className": cls}
        # iOS name can mirror a field's current value. Keep a distinct stable
        # accessibility identifier, never the value used as a fallback name.
        if editable and platform == "ios" and data["accessibilityId"] == attrs.get("value", "") and not (data["accessibilityId"] == attrs.get("placeholderValue") and data["accessibilityId"] != attrs.get("label", "")):
            data["accessibilityId"] = ""
        # UIKit exposes a button title as a non-accessible StaticText descendant
        # with the same fallback name. It is decoration, not a second ID target.
        if platform == "ios" and cls == "XCUIElementTypeStaticText" and attrs.get("accessible") == "false" and accessible_button_ancestor:
            data["accessibilityId"] = ""
        enabled = attrs.get("enabled", "true") not in {"false", "0"}
        visible = attrs.get("visible", attrs.get("displayed", "true")) not in {"false", "0"}
        clickable = attrs.get("clickable") == "true" or platform == "ios" and bool(re.search(r"Button|Cell|Link", cls))
        check_kind = ("switch" if re.search(r"(?:^|\.)(?:Switch|SwitchCompat|SwitchMaterial|MaterialSwitch)$", cls) else "checkbox" if re.search(r"(?:^|\.)CheckBox$", cls) else "radio" if re.search(r"(?:^|\.)RadioButton$", cls) else "") if platform == "android" else "switch" if cls == "XCUIElementTypeSwitch" else ""
        checkable = attrs.get("checkable") == "true" if platform == "android" else bool(check_kind)
        raw_checked = attrs.get("checked") if platform == "android" else attrs.get("value")
        checked = ({"true": True, "false": False} if platform == "android" else {"1": True, "0": False}).get(raw_checked) if checkable else None
        option_kind = "radio" if selection_group and selection_group["kind"] == "radio" and check_kind == "radio" else "segmented" if selection_group and selection_group["kind"] == "segmented" and cls == "XCUIElementTypeButton" else ""
        selection_state = checked if option_kind == "radio" else {"true": True, "false": False, "1": True, "0": False}.get(attrs.get("selected")) if option_kind == "segmented" else None
        if option_kind == "segmented" and "selected" not in attrs and isinstance(attrs.get("traits"), str):
            traits = {part.strip() for part in attrs["traits"].split(",") if part.strip()}
            if "Button" in traits:
                selection_state = "Selected" in traits
        nodes.append({**data, "bounds": bounds(attrs), "enabled": enabled, "visible": visible,
                      "clickable": clickable, "editable": editable, "scrollable": attrs.get("scrollable") == "true" or bool(re.search(r"ScrollView|CollectionView|Table", cls)), "secure": secure,
                      "containerPath": list(ancestors), "inputType": str(attrs.get("input-type", attrs.get("inputType", attrs.get("keyboardType", ""))))[:128],
                      "readOnly": any(attrs.get(key) in {"true", "1"} for key in ("readonly", "read-only", "readOnly")),
                      "checkKind": check_kind, "checkable": checkable, "checked": checked,
                      "selectionGroupKind": selection_kind, "selectionGroup": selection_group, "selectionOptionKind": option_kind, "selectionState": selection_state})
        if editable:
            # Only transient length is needed to clear ADB fields. It is neither
            # a public observation nor part of a parameter-dependent fingerprint.
            nodes[-1]["_inputLength"] = len(attrs.get("text", "") if platform == "android" else attrs.get("value", ""))
            input_value = attrs.get("text", "") if platform == "android" else attrs.get("value", "")
            nodes[-1]["_inputUtf16Length"] = len(input_value.encode("utf-16-le")) // 2
            if input_suffix is not None:
                nodes[-1]["_inputSuffixMatched"] = input_value.endswith(input_suffix)
                nodes[-1]["_inputPrefixSha256"] = hashlib.sha256((input_value[:-len(input_suffix)] if input_suffix else input_value).encode("utf-8")).hexdigest()
            nodes[-1]["_inputFocused"] = {"true": True, "false": False}.get(attrs.get("focused"))
            nodes[-1]["_inputSha256"] = hashlib.sha256((attrs.get("text", "") if platform == "android" else attrs.get("value", "")).encode("utf-8")).hexdigest()
    canonical = [{k: v for k, v in n.items() if k not in {"bounds", "containerPath", "inputType", "readOnly", "checkKind", "checkable", "checked", "selectionGroupKind", "selectionGroup", "selectionOptionKind", "selectionState"} and not k.startswith("_")} for n in nodes]
    return {"fingerprint": digest([platform, app_id, canonical]), "nodes": nodes}


def node_selector(node):
    for key in ("resourceId", "accessibilityId"):
        if node.get(key):
            return {key: node[key]}
    if node.get("text"):
        return {"text": node["text"], "className": node["className"]}
    return {"className": node["className"]}


def locate(tree, wanted):
    wanted = selector(wanted)
    found = [n for n in tree["nodes"] if n["enabled"] and n["visible"] and all(n.get(k) == v for k, v in wanted.items())]
    if len(found) != 1:
        raise MobileError("SELECTOR_AMBIGUOUS" if found else "SELECTOR_NOT_FOUND", "blocked")
    return found[0]


class Budget:
    def __init__(self, config, count=0):
        self.max_actions = config.get("maxActions", 20)
        self.max_depth = config.get("maxDepth", 3)
        self.duration = config.get("maxDurationMs", 60000)
        for value, lower, upper in ((self.max_actions, 0, 10000), (self.max_depth, 0, 30), (self.duration, 1, 3600000)):
            if not isinstance(value, int) or isinstance(value, bool) or not lower <= value <= upper:
                raise MobileError("LIMITS_INVALID")
        self.count, self.started, self.cancelled = count, time.monotonic(), False

    def check(self):
        if self.cancelled:
            raise MobileError("STOPPED", "partial")
        if (time.monotonic() - self.started) * 1000 >= self.duration:
            raise MobileError("DURATION_BUDGET", "partial")

    def action(self):
        self.check()
        if self.count >= self.max_actions:
            raise MobileError("ACTION_BUDGET", "partial")
        self.count += 1

    def timeout(self, maximum=15.):
        self.check()
        remaining = self.duration / 1000 - (time.monotonic() - self.started)
        if remaining <= 0:
            raise MobileError("DURATION_BUDGET", "partial")
        return min(maximum, remaining)


class DeviceLease:
    """Cross-process ownership for the same ADB device or WebDriver session."""
    def __init__(self, backend):
        self.backend, self.stream = backend, None

    def __enter__(self):
        if fcntl is None:
            raise MobileError("DEVICE_LOCK_UNSUPPORTED", "unsupported")
        directory = Path(tempfile.gettempdir()) / ("bfs-mobile-ui-" + str(os.getuid()))
        if directory.is_symlink():
            raise MobileError("DEVICE_LOCK_REJECTED", "blocked")
        directory.mkdir(mode=0o700, exist_ok=True)
        if isinstance(self.backend, AdbBackend):
            identity = ["adb", self.backend.device]
        else:
            identity = ["webdriver", self.backend.config["url"], self.backend.session]
        # A trusted shared leaseKey can join ADB and Appium access to one device.
        key = self.backend.config.get("leaseKey") or identity
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        try:
            self.stream = os.fdopen(os.open(directory / (digest(key) + ".lock"), flags, 0o600), "r+")
            fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, BlockingIOError):
            if self.stream:
                self.stream.close()
            raise MobileError("DEVICE_BUSY", "blocked") from None
        return self

    def __exit__(self, *_):
        if self.stream:
            fcntl.flock(self.stream.fileno(), fcntl.LOCK_UN)
            self.stream.close()


class AdbBackend:
    def __init__(self, config, budget):
        self.config, self.budget = config, budget
        self.app_id = config["appId"]
        self.platform = "android"
        self.executable = config.get("adb", "adb")
        self.device = config.get("deviceId")
        self.expected_artifact = config.get("expectedArtifact")
        self.unicode_input = android_unicode.validate(config.get("unicodeInput"), MobileError)
        self.unicode_error = MobileError
        self.artifact_verification = {"status": "unverified", "kind": "apk", "reason": "expected_artifact_not_configured"}

    def command(self, args):
        timeout = self.budget.timeout()
        try:
            child = subprocess.Popen([self.executable, *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except FileNotFoundError:
            raise MobileError("ADB_UNAVAILABLE", "unsupported") from None
        except OSError:
            raise MobileError("ADB_COMMAND_FAILED") from None
        chunks, exceeded = [[], []], threading.Event()
        def drain(stream, index, maximum):
            total = 0
            try:
                while True:
                    block = stream.read(65536)
                    if not block:
                        break
                    total += len(block)
                    if total > maximum:
                        exceeded.set()
                        try:
                            child.kill()
                        except OSError:
                            pass
                        break
                    chunks[index].append(block)
            finally:
                stream.close()
        readers = [threading.Thread(target=drain, args=(child.stdout, 0, MAX_XML), daemon=True), threading.Thread(target=drain, args=(child.stderr, 1, 65536), daemon=True)]
        for reader in readers:
            reader.start()
        timed_out = False
        try:
            child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            child.kill()
            child.wait(timeout=2)
        finally:
            for reader in readers:
                reader.join(timeout=2)
        if exceeded.is_set():
            raise MobileError("ADB_OUTPUT_LIMIT")
        if timed_out or any(reader.is_alive() for reader in readers):
            raise MobileError("ADB_COMMAND_FAILED")
        if child.returncode:
            raise MobileError("ADB_COMMAND_UNAVAILABLE", "unsupported") if child.returncode in {126, 127} else MobileError("ADB_COMMAND_FAILED")
        return b"".join(chunks[0]).decode("utf-8", "replace").strip()

    def shell(self, *args):
        if args and (args[0] == "input" or args[:2] == ("am", "start")):
            callback = getattr(self, "_before_workflow_ui_command", None)
            if callback:
                callback()
        return self.command(["-s", self.device, "shell", shlex.join(args)])

    def probe(self):
        if shutil.which(self.executable) is None:
            raise MobileError("ADB_UNAVAILABLE", "unsupported")
        lines = self.command(["devices", "-l"]).splitlines()
        devices = [line.split() for line in lines[1:] if len(line.split()) >= 2]
        online = [row[0] for row in devices if row[1] == "device"]
        if self.device is None:
            if len(online) != 1:
                raise MobileError("DEVICE_SELECTION_REQUIRED" if online else "DEVICE_NOT_FOUND", "needs_device")
            self.device = online[0]
        if self.device not in online:
            raise MobileError("DEVICE_NOT_AUTHORIZED_OR_OFFLINE", "needs_device")
        if not re.fullmatch(r"[A-Za-z0-9_.:\[\]-]{1,180}", self.device):
            raise MobileError("DEVICE_ID_INVALID")
        self.verify_artifact()
        if self.unicode_input:
            android_unicode.preflight(self)
        return {"backend": "adb", "platform": self.platform, "features": ["source", "click", "type_unicode" if self.unicode_input else "type_ascii", "swipe", "back", "launch"], "artifactVerification": dict(self.artifact_verification), "appArtifactVerified": self.artifact_verification["status"] == "verified", "networkScopeEnforced": False, "captureScopeEnforced": False}

    def verify_artifact(self):
        """Prove a single installed base APK, without exposing remote paths."""
        expected = self.expected_artifact
        if expected is None:
            return self.artifact_verification
        proof = {"status": "unverified", "kind": "apk", "expectedSha256": expected["sha256"]}
        self.artifact_verification = proof
        try:
            located = self.shell("pm", "path", self.app_id)
            entries = [line.strip() for line in located.splitlines() if line.strip()]
            if len(entries) != 1 or not entries[0].startswith("package:"):
                proof["reason"] = "split_or_missing_apk"
                raise MobileError("APK_ARTIFACT_UNVERIFIED", "blocked")
            remote = entries[0][8:]
            if not re.fullmatch(r"/data/app/[A-Za-z0-9_~.+/=-]+/base\.apk", remote) or ".." in remote.split("/"):
                proof["reason"] = "single_base_apk_required"
                raise MobileError("APK_ARTIFACT_UNVERIFIED", "blocked")
            hashed = self.shell("sha256sum", remote)
            match = re.fullmatch(r"([a-fA-F0-9]{64})[ \t]+\*?(.+)", hashed)
            if not match or match[2] != remote:
                proof["reason"] = "hash_output_unverified"
                raise MobileError("APK_ARTIFACT_UNVERIFIED", "blocked")
            proof["actualSha256"] = match[1].lower()
            if self.shell("pm", "path", self.app_id).strip() != entries[0]:
                proof["reason"] = "installed_artifact_changed_during_verification"
                raise MobileError("APK_ARTIFACT_UNVERIFIED", "blocked")
            if proof["actualSha256"] != expected["sha256"]:
                proof.update(status="mismatch", reason="installed_apk_hash_mismatch")
                raise MobileError("APK_ARTIFACT_MISMATCH", "blocked")
            proof["status"] = "verified"
            return proof
        except MobileError as exc:
            if exc.code.startswith("APK_ARTIFACT_"):
                raise
            proof["reason"] = "verification_interrupted" if exc.status == "partial" else "device_hash_unavailable"
            if exc.status == "partial":
                raise
            raise MobileError("APK_ARTIFACT_UNVERIFIED", "blocked") from None

    def foreground(self):
        text = self.shell("dumpsys", "activity", "activities")
        matches = re.findall(r"(?:mResumedActivity|topResumedActivity)[^\n]*?\s([A-Za-z0-9_.]+)/[A-Za-z0-9_.$]+", text)
        if not matches:
            raise MobileError("FOREGROUND_APP_UNVERIFIED", "blocked")
        if matches[-1] != self.app_id:
            raise MobileError("APP_OUT_OF_SCOPE", "blocked")

    def observe(self, input_suffix=None):
        self.foreground()
        target = "/sdcard/bfs-ui-" + uuid.uuid4().hex + ".xml"
        try:
            self.shell("uiautomator", "dump", target)
            return parse_tree(self.shell("cat", target), self.platform, self.app_id, input_suffix=input_suffix)
        finally:
            # Only the temporary file created by this observation is removed.
            try:
                self.shell("rm", "-f", target)
            except MobileError:
                pass

    def perform(self, action, tree, inputs):
        self.verify_artifact()
        kind = action["kind"]
        if kind != "launch":
            self.foreground()
        node = locate(tree, action["selector"]) if kind in {"click", "type", "swipe", "check", "select"} else None
        check_target(kind, node)
        if kind in {"check", "select"}:
            def tap(target):
                box = target["bounds"]
                if box is None:
                    raise MobileError("TARGET_BOUNDS_UNAVAILABLE", "blocked")
                self.shell("input", "tap", str(box[0] + box[2] // 2), str(box[1] + box[3] // 2))
            return (perform_check if kind == "check" else perform_select)(self, action, tree, inputs, tap)
        if kind in {"click", "type"}:
            box = node["bounds"]
            if box is None:
                raise MobileError("TARGET_BOUNDS_UNAVAILABLE", "blocked")
            if kind == "type":
                value = inputs.get(action.get("input", "text"))
                if not isinstance(value, str) or len(value) > 2048:
                    raise MobileError("INPUT_REQUIRED", "blocked")
                if self.unicode_input:
                    try:
                        value.encode("utf-8")
                    except UnicodeError:
                        raise MobileError("INPUT_REQUIRED", "blocked") from None
                    if "\0" in value:
                        raise MobileError("INPUT_REQUIRED", "blocked")
                    android_unicode.preflight(self)
                elif not value.isascii() or "%s" in value or any(ord(c) < 32 for c in value):
                    raise MobileError("ADB_INPUT_UNSUPPORTED", "unsupported")
            self.shell("input", "tap", str(box[0] + box[2] // 2), str(box[1] + box[3] // 2))
            if kind == "type":
                if self.unicode_input:
                    # Recheck foreground and selected IME after focusing the field.
                    focused = locate(self.observe(), action["selector"])
                    if focused.get("_inputFocused") is not True:
                        raise MobileError("UNICODE_IME_TARGET_NOT_FOCUSED", "blocked")
                    android_unicode.preflight(self)
                    android_unicode.commit(self, value, bool(action.get("replace")) and focused.get("_inputLength") != 0, append_at=focused.get("_inputUtf16Length", 0))
                    if action.get("replace") and locate(self.observe(), action["selector"]).get("_inputSha256") != hashlib.sha256(value.encode("utf-8")).hexdigest():
                        raise MobileError("UNICODE_IME_RESULT_UNKNOWN")
                    if not action.get("replace"):
                        after_input = locate(self.observe(input_suffix=value), action["selector"])
                        if not after_input.get("_inputSuffixMatched") or after_input.get("_inputPrefixSha256") != focused.get("_inputSha256"):
                            raise MobileError("UNICODE_IME_RESULT_UNKNOWN")
                    return
                if action.get("replace"):
                    length = node.get("_inputLength")
                    if not isinstance(length, int) or not 0 <= length <= 2048:
                        raise MobileError("TYPE_CLEAR_LENGTH_UNAVAILABLE", "blocked")
                    if length:
                        self.shell("input", "keyevent", "123")
                        self.shell("input", "keyevent", *(["67"] * length))
                    cleared = locate(self.observe(), action["selector"])
                    if cleared.get("_inputLength") != 0:
                        raise MobileError("TYPE_CLEAR_UNVERIFIED", "blocked")
                self.shell("input", "text", value.replace(" ", "%s"))
        elif kind == "swipe":
            points = swipe_points(node["bounds"], action.get("direction", "up"))
            self.shell("input", "swipe", *map(str, points), "300")
        elif kind == "back":
            self.shell("input", "keyevent", "4")
        elif kind == "launch":
            resolved = self.shell("cmd", "package", "resolve-activity", "--brief", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", self.app_id)
            component = resolved.splitlines()[-1] if resolved else ""
            if not re.fullmatch(re.escape(self.app_id) + r"/[A-Za-z0-9_.$]+", component):
                raise MobileError("APP_LAUNCHER_UNVERIFIED", "blocked")
            result = self.shell("am", "start", "-n", component)
            if re.search(r"Error:|Exception", result):
                raise MobileError("APP_LAUNCH_FAILED")
        else:
            raise MobileError("ACTION_UNSUPPORTED", "unsupported")


def swipe_points(box, direction):
    if box is None or direction not in {"up", "down", "left", "right"}:
        raise MobileError("SWIPE_INVALID", "blocked")
    x, y, w, h = box
    pairs = {"up": (.5, .8, .5, .2), "down": (.5, .2, .5, .8), "left": (.8, .5, .2, .5), "right": (.2, .5, .8, .5)}
    a, b, c, d = pairs[direction]
    return [int(x + w * a), int(y + h * b), int(x + w * c), int(y + h * d)]


def check_target(kind, node):
    if kind == "select" and (node.get("selectionGroupKind") not in {"radio", "segmented"} or node.get("secure") or node.get("readOnly") or not node["enabled"] or not node["visible"]):
        raise MobileError("SELECT_GROUP_INVALID", "blocked")
    if kind == "check":
        if not node.get("checkable") or node.get("checkKind") not in {"checkbox", "switch", "radio"} or node.get("secure") or node.get("readOnly"):
            raise MobileError("CHECK_TARGET_MISMATCH", "blocked")
        if not isinstance(node.get("checked"), bool):
            raise MobileError("CHECK_STATE_UNAVAILABLE", "blocked")
    if kind == "type" and (not node["editable"] or node.get("readOnly") is True) or kind == "click" and not node["clickable"] or kind == "swipe" and not node["scrollable"]:
        raise MobileError("ACTION_TARGET_MISMATCH", "blocked")


def check_value(action, node, inputs):
    check_target("check", node)
    if ("input" in action) == ("value" in action):
        raise MobileError("CHECK_INPUT_INVALID", "blocked")
    desired = inputs.get(action["input"]) if "input" in action else action["value"]
    if not isinstance(desired, bool):
        raise MobileError("CHECK_INPUT_INVALID", "blocked")
    if node["checkKind"] == "radio" and desired is False:
        raise MobileError("CHECK_RADIO_FALSE_UNSUPPORTED", "blocked")
    return desired


def check_identity(node):
    return {key: node.get(key) for key in ("className", "resourceId", "accessibilityId", "secure", "readOnly", "checkKind", "checkable")}


def perform_check(backend, action, tree, inputs, tap):
    """One conditional tap followed only by observations, never a toggle retry."""
    node = locate(tree, action["selector"])
    desired = check_value(action, node, inputs)
    performed = node["checked"] != desired
    if performed:
        tap(node)
    deadline = time.monotonic() + action.get("timeoutMs", 1500) / 1000
    while True:
        backend.budget.check()
        after = locate(backend.observe(), action["selector"])
        backend.budget.check()
        check_target("check", after)
        if check_identity(after) != check_identity(node):
            raise MobileError("CHECK_CONTROL_CHANGED", "blocked")
        if after["checked"] == desired:
            return {"commandPerformed": performed, "stateObserved": True, "checked": desired}
        if not performed or time.monotonic() >= deadline:
            raise MobileError("CHECK_STATE_NOT_OBSERVED", "blocked")
        time.sleep(min(.05, max(0, deadline - time.monotonic())))


def selection_selector(wanted):
    wanted = selector(wanted)
    if set(wanted) - {"resourceId", "accessibilityId", "className"} or not (wanted.get("resourceId") or wanted.get("accessibilityId")):
        raise MobileError("SELECT_STABLE_SELECTOR_REQUIRED", "blocked")
    return wanted


def selection_identity(node):
    return {key: node.get(key) for key in ("className", "resourceId", "accessibilityId", "secure", "editable", "readOnly", "selectionGroupKind", "selectionOptionKind", "checkKind", "checkable")}


def selection_members(tree, group):
    check_target("select", group)
    selection_selector(node_selector(group))
    descriptor = {"kind": group["selectionGroupKind"], **{key: group.get(key, "") for key in ("resourceId", "accessibilityId", "className")}}
    members = [node for node in tree["nodes"] if node.get("selectionGroup") == descriptor and (node.get("selectionOptionKind") or node.get("checkable"))]
    if not 2 <= len(members) <= 20:
        raise MobileError("SELECT_GROUP_DOMAIN_INVALID", "blocked")
    for node in members:
        if node.get("selectionOptionKind") != group["selectionGroupKind"] or not node["enabled"] or not node["visible"] or node.get("readOnly") or node.get("secure"):
            raise MobileError("SELECT_OPTION_INVALID", "blocked")
        selection_selector(node_selector(node))
        if not isinstance(node.get("selectionState"), bool):
            raise MobileError("SELECT_STATE_UNAVAILABLE", "blocked")
    if sum(node["selectionState"] for node in members) != 1:
        raise MobileError("SELECT_EXCLUSIVE_STATE_INVALID", "blocked")
    return members


def selection_state(tree, action):
    group = locate(tree, selection_selector(action["selector"]))
    members = selection_members(tree, group)
    options = action.get("options")
    if not isinstance(options, list) or len(options) != len(members):
        raise MobileError("SELECT_GROUP_DOMAIN_CHANGED", "blocked")
    mapped, selected, seen = [], None, set()
    for option in options:
        node = locate(tree, selection_selector(option["selector"]))
        if not any(node is member for member in members) or id(node) in seen:
            raise MobileError("SELECT_OPTION_WRONG_GROUP", "blocked")
        seen.add(id(node))
        mapped.append({"value": option["value"], "node": node})
        if node["selectionState"]:
            selected = option["value"]
    contract = {"group": selection_identity(group), "options": [{"value": row["value"], "node": selection_identity(row["node"])} for row in mapped]}
    return {"selected": selected, "options": mapped, "contract": contract}


def select_value(action, inputs):
    desired = inputs.get(action.get("input"))
    if not isinstance(desired, str) or desired not in [row["value"] for row in action.get("options", [])]:
        raise MobileError("SELECT_INPUT_INVALID", "blocked")
    return desired


def perform_select(backend, action, tree, inputs, tap):
    before = selection_state(tree, action)
    desired = select_value(action, inputs)
    performed = before["selected"] != desired
    if performed:
        tap(next(row["node"] for row in before["options"] if row["value"] == desired))
    deadline = time.monotonic() + action.get("timeoutMs", 1500) / 1000
    while True:
        backend.budget.check()
        after = selection_state(backend.observe(), action)
        backend.budget.check()
        if before["contract"] != after["contract"]:
            raise MobileError("SELECT_CONTROL_CHANGED", "blocked")
        if after["selected"] == desired:
            return {"commandPerformed": performed, "stateObserved": True, "selected": desired}
        if not performed or time.monotonic() >= deadline:
            raise MobileError("SELECT_STATE_NOT_OBSERVED", "blocked")
        time.sleep(min(.05, max(0, deadline - time.monotonic())))


class WebDriverBackend:
    def __init__(self, config, budget):
        self.config, self.budget = config, budget
        self.app_id, self.platform = config["appId"], config.get("platform", "ios")
        self.url = urlsplit(config.get("url", ""))
        self.session = config.get("sessionId", "")
        self.expected_artifact = config.get("expectedArtifact")
        self.command_timeout_ms = config.get("commandTimeoutMs", 15000)
        if not isinstance(self.command_timeout_ms, int) or isinstance(self.command_timeout_ms, bool) or not 1 <= self.command_timeout_ms <= 120000:
            raise MobileError("WEBDRIVER_COMMAND_TIMEOUT_INVALID")
        self.artifact_verification = {"status": "unverified", "reason": "existing_webdriver_session_does_not_prove_installed_artifact"}
        if self.url.scheme not in {"http", "https"} or not self.url.hostname or self.url.username or self.url.password or self.url.query or self.url.fragment or not re.fullmatch(r"[A-Za-z0-9._:-]{1,256}", self.session):
            raise MobileError("WEBDRIVER_CONFIG_INVALID")
        if self.platform not in {"android", "ios"}:
            raise MobileError("PLATFORM_UNSUPPORTED", "unsupported")

    def request(self, method, suffix, body=None):
        self.budget.check()
        connection_class = http.client.HTTPSConnection if self.url.scheme == "https" else http.client.HTTPConnection
        connection = connection_class(self.url.hostname, self.url.port, timeout=self.budget.timeout(self.command_timeout_ms / 1000))
        route = self.url.path.rstrip("/") + "/session/" + quote(self.session, safe="") + suffix
        try:
            payload = json.dumps(body).encode() if body is not None else None
            if method == "POST" and (suffix in {"/actions", "/back", "/appium/device/activate_app"} or re.fullmatch(r"/element/[^/]+/(?:click|clear|value)", suffix)):
                callback = getattr(self, "_before_workflow_ui_command", None)
                if callback:
                    callback()
            connection.request(method, route, body=payload, headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            raw = response.read(MAX_XML + 1)
            if len(raw) > MAX_XML:
                raise MobileError("WEBDRIVER_OUTPUT_LIMIT")
            if response.status < 200 or response.status >= 300:
                raise MobileError("WEBDRIVER_COMMAND_UNSUPPORTED" if response.status in {404, 405, 501} else "WEBDRIVER_COMMAND_FAILED", "unsupported" if response.status in {404, 405, 501} else "failed")
            value = json.loads(raw).get("value")
            if isinstance(value, dict) and value.get("error"):
                raise MobileError("WEBDRIVER_COMMAND_FAILED")
            return value
        except (OSError, ValueError, http.client.HTTPException):
            raise MobileError("WEBDRIVER_UNAVAILABLE", "needs_device") from None
        finally:
            connection.close()

    def probe(self):
        self.verify_artifact()
        self.request("GET", "/source")
        return {"backend": "webdriver", "platform": self.platform, "features": ["source", "click", "type", "swipe", "back", "launch_appium_extension"], "artifactVerification": dict(self.artifact_verification), "appArtifactVerified": False, "networkScopeEnforced": False, "captureScopeEnforced": False, "gaps": ["existing_trusted_session_required", "appium_active_app_extension_required_for_execution"]}

    def verify_artifact(self):
        if self.expected_artifact is not None:
            self.artifact_verification = {"status": "unsupported", "kind": self.expected_artifact["kind"], "expectedSha256": self.expected_artifact["sha256"], "reason": "webdriver_artifact_hash_verification_unsupported"}
            raise MobileError("APK_ARTIFACT_VERIFICATION_UNSUPPORTED", "unsupported")
        return self.artifact_verification

    def foreground(self):
        if self.platform == "android":
            actual = self.request("GET", "/appium/device/current_package")
        else:
            data = self.request("POST", "/execute/sync", {"script": "mobile: activeAppInfo", "args": []})
            actual = data.get("bundleId") if isinstance(data, dict) else None
        if actual != self.app_id:
            raise MobileError("APP_OUT_OF_SCOPE" if actual else "FOREGROUND_APP_UNVERIFIED", "blocked")

    def observe(self):
        self.foreground()
        return parse_tree(self.request("GET", "/source"), self.platform, self.app_id)

    def element(self, wanted):
        fields = {"resourceId": ("resource-id", "resourceId"), "accessibilityId": ("content-desc", "name"), "text": ("text", "label"), "className": ("class", "type")}
        predicates = []
        for key, value in selector(wanted).items():
            predicates.append("(" + " or ".join("@" + attr + "=" + xpath_literal(value) for attr in fields[key]) + ")")
        if self.platform == "ios":
            predicates.append("not(ancestor-or-self::*[@type='XCUIElementTypeKeyboard'])")
            predicates.append("not(@type='XCUIElementTypeStaticText' and @accessible='false' and ancestor::*[@type='XCUIElementTypeButton' and @accessible='true'])")
        result = self.request("POST", "/elements", {"using": "xpath", "value": "//*[" + " and ".join(predicates) + "]"})
        if not isinstance(result, list) or len(result) != 1:
            raise MobileError("SELECTOR_AMBIGUOUS" if result else "SELECTOR_NOT_FOUND", "blocked")
        element = result[0].get("element-6066-11e4-a52e-4f735466cecf")
        if not isinstance(element, str) or not element or len(element) > 256:
            raise MobileError("WEBDRIVER_ELEMENT_INVALID")
        return quote(element, safe="")

    def perform(self, action, tree, inputs):
        self.verify_artifact()
        kind = action["kind"]
        if kind != "launch":
            self.foreground()
        node = locate(tree, action["selector"]) if kind in {"click", "type", "swipe", "check", "select"} else None
        check_target(kind, node)
        if kind == "check":
            return perform_check(self, action, tree, inputs, lambda _: self.request("POST", "/element/" + self.element(action["selector"]) + "/click", {}))
        if kind == "select":
            def tap(target):
                option = next(option for option in action["options"] if all(target.get(key) == value for key, value in option["selector"].items()))
                return self.request("POST", "/element/" + self.element(option["selector"]) + "/click", {})
            return perform_select(self, action, tree, inputs, tap)
        if kind in {"click", "type"}:
            element = self.element(action["selector"])
            if kind == "click":
                self.request("POST", "/element/" + element + "/click", {})
            else:
                value = inputs.get(action.get("input", "text"))
                if not isinstance(value, str) or len(value) > 2048:
                    raise MobileError("INPUT_REQUIRED", "blocked")
                if action.get("replace"):
                    self.request("POST", "/element/" + element + "/clear", {})
                self.request("POST", "/element/" + element + "/value", {"text": value, "value": list(value)})
        elif kind == "swipe":
            x1, y1, x2, y2 = swipe_points(node["bounds"], action.get("direction", "up"))
            self.request("POST", "/actions", {"actions": [{"type": "pointer", "id": "finger", "parameters": {"pointerType": "touch"}, "actions": [{"type": "pointerMove", "duration": 0, "x": x1, "y": y1, "origin": "viewport"}, {"type": "pointerDown", "button": 0}, {"type": "pointerMove", "duration": 300, "x": x2, "y": y2, "origin": "viewport"}, {"type": "pointerUp", "button": 0}]}]})
        elif kind == "back":
            self.request("POST", "/back", {})
        elif kind == "launch":
            self.request("POST", "/appium/device/activate_app", {"appId": self.app_id})
        else:
            raise MobileError("ACTION_UNSUPPORTED", "unsupported")


class MobileSession:
    def __init__(self, config, output, resume=False):
        self.config, self.output = config, Path(output)
        if not isinstance(config, dict) or not isinstance(config.get("source"), dict) or not isinstance(config.get("backend"), dict):
            raise MobileError("CONFIG_INVALID")
        source, backend = config["source"], config["backend"]
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", source.get("id", "")) or source.get("kind") not in {"apk", "ios"} or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+", backend.get("appId", "")):
            raise MobileError("CONFIG_INVALID")
        if source["kind"] == "ios" and backend.get("type") == "adb" or backend.get("type") == "webdriver" and (source["kind"] == "apk") != (backend.get("platform", "ios") == "android"):
            raise MobileError("SOURCE_PLATFORM_MISMATCH")
        expected = config.get("expectedArtifact")
        if expected is not None and (not isinstance(expected, dict) or set(expected) != {"kind", "sha256"} or expected.get("kind") != "apk" or source["kind"] != "apk" or not isinstance(expected.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", expected["sha256"])):
            raise MobileError("EXPECTED_ARTIFACT_INVALID")
        backend = {**backend, **({"expectedArtifact": expected} if expected is not None else {})}
        allowlist = config.get("actionAllowlist", [])
        if not isinstance(allowlist, list) or len(allowlist) > 1000:
            raise MobileError("ALLOWLIST_INVALID")
        for row in allowlist:
            if not isinstance(row, dict) or row.get("kind", "click") not in {"click", "type", "swipe", "check", "select"}:
                raise MobileError("ALLOWLIST_INVALID")
            selector(row.get("selector"))
        # Exploration budgets can be raised on resume without changing identity.
        self.identity = digest({k: v for k, v in config.items() if k not in {"limits", "workflowPermissions"}})
        self.source = {"id": source["id"], "kind": source["kind"]}
        self.budget = Budget(config.get("limits", {}))
        self.backend = AdbBackend(backend, self.budget) if backend.get("type") == "adb" else WebDriverBackend(backend, self.budget) if backend.get("type") == "webdriver" else None
        if self.backend is None:
            raise MobileError("BACKEND_UNSUPPORTED", "unsupported")
        self.progress = {"schemaVersion": 1, "identity": self.identity, "states": {}, "queue": [], "capabilities": {}, "recipes": {}, "gaps": [], "actions": 0, "status": "new"}
        if resume:
            self.progress = read_json(self.output / "checkpoint.json")
            if self.progress.get("identity") != self.identity or self.progress.get("schemaVersion") != 1:
                raise MobileError("RESUME_IDENTITY_MISMATCH", "blocked")
        self.prior_actions = self.progress.get("totalActions", self.progress.get("actions", 0)) if resume else 0
        self.features = None
        self.last_execution = None

    def event(self, kind, **fields):
        self.output.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = self.output / "events.jsonl"
        if path.is_symlink() or path.exists() and path.stat().st_size > 64 * 1024 * 1024:
            raise MobileError("UI_EVENT_FILE_REJECTED", "partial")
        event_id = "ui_" + uuid.uuid4().hex
        row = {"schemaVersion": 1, "kind": kind, "evidenceId": event_id, "timestampMs": round(time.time() * 1000), **fields}
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(path, flags, 0o600), "w", encoding="utf-8") as stream:
            stream.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        return event_id

    def checkpoint(self):
        self.progress["actions"] = self.budget.count
        self.progress["totalActions"] = self.prior_actions + self.budget.count
        atomic_json(self.output / "checkpoint.json", self.progress)
        caps = list(self.progress["capabilities"].values())
        verification = dict(self.backend.artifact_verification)
        verified = verification["status"] == "verified"
        if self.config.get("expectedArtifact") is not None and not verified:
            caps = [{**cap, "readiness": "candidate", "gaps": list(dict.fromkeys(cap["gaps"] + ["app_artifact_not_verified"]))} for cap in caps]
        source_gaps = list(dict.fromkeys(self.progress["gaps"] + ([] if verified else ["app_artifact_not_verified"]) + ["network_scope_not_enforced", "ui_commands_not_business_assertions"]))
        revision = digest({"identity": self.identity, "capabilities": caps, "status": self.progress["status"], "gaps": source_gaps, "artifactVerification": verification})
        source = {**self.source, "revision": revision, "gaps": source_gaps, "status": self.progress["status"], "appArtifactVerified": verified, "artifactVerification": verification, "captureScopeEnforced": False, "networkScopeEnforced": False}
        atomic_json(self.output / "manifest.json", {"schemaVersion": 1, "source": source, "capabilities": caps})
        atomic_json(self.output / "recipes.json", self.progress["recipes"])

    def policy(self, action):
        wanted = action.get("selector", {})
        allowlist = self.config.get("actionAllowlist", [])
        label = " ".join(wanted.values())
        for row in allowlist:
            if isinstance(row, dict) and row.get("kind", "click") == action["kind"] and row.get("selector") == wanted:
                if action["kind"] in {"check", "select"}:
                    return True, row.get("effect") if row.get("effect") in {"read", "write"} else "unknown"
                inferred = "write" if RISK.search(label) else "read" if READ.search(label) else "unknown"
                return True, row.get("effect") if row.get("effect") in {"read", "write", "unknown"} else inferred
        if action["kind"] == "click" and READ.search(label) and not RISK.search(label):
            return True, "read"
        if action["kind"] == "swipe":
            return True, "read"
        return False, "unknown"

    def candidates(self, tree):
        result, seen = [], set()
        for node in tree["nodes"]:
            if not node["enabled"] or not node["visible"]:
                continue
            if node.get("selectionGroupKind") or node.get("selectionOptionKind"):
                continue  # Group selection requires a complete private options contract.
            kind = "check" if node.get("checkKind") or node.get("checkable") else "type" if node["editable"] else "click" if node["clickable"] else "swipe" if node["scrollable"] else None
            if kind is None:
                continue
            wanted = node_selector(node)
            action = {"kind": kind, "selector": wanted, **({"input": "checked" if kind == "check" else "text"} if kind in {"type", "check"} else {}), **({"direction": "up"} if kind == "swipe" else {})}
            key = digest(action)
            if key in seen:
                continue
            seen.add(key)
            try:
                locate(tree, wanted)
                action["gap"] = None
            except MobileError as exc:
                action["gap"] = exc.code
            result.append(action)
        return result[:300]

    def add_capability(self, state, action, path, outcome=None, gap=None):
        ident = "mobile_" + digest([self.source["id"], state["fingerprint"], action])
        recipe = {"schemaVersion": 1, "sourceId": self.source["id"], "identity": self.identity, "capabilityId": ident, "steps": path, "expectedFinalFp": outcome}
        recipe["revision"] = digest(recipe)
        allowed, effect = self.policy(action)
        replayable = all(self.policy(step["action"])[1] == "read" for step in path)
        ready = bool(outcome) and not gap and allowed and replayable
        name = safe_text(action.get("selector", {}).get("text") or action.get("selector", {}).get("accessibilityId") or action.get("selector", {}).get("resourceId") or action["kind"])
        gaps = [gap] if gap else []
        if not allowed:
            gaps.append("action_requires_allowlist")
        if action["kind"] in {"type", "check"}:
            gaps.append("input_and_observed_path_required")
        if not outcome:
            gaps.append("execution_not_observed")
        if not replayable:
            gaps.append("path_not_safe_replay")
        execution = path[-1].get("executionId") if outcome and path else None
        input_schema = {"type": "object", "properties": {}, "additionalProperties": False}
        if action["kind"] in {"type", "check"}:
            key = action.get("input", "text")
            input_schema["properties"][key] = {"type": "boolean"} if action["kind"] == "check" else {"type": "string", "maxLength": 2048, "description": "执行时提供的文本；未自动绑定，实际值不保存在录制路径中。"}
            input_schema["required"] = [key]
        self.progress["capabilities"][ident] = {"id": ident, "name": name, "description": "在配置的目标应用内执行已记录UI路径，逐步校验状态；不证明HTTP或业务成功。", "kind": "mobile", "inputSchema": input_schema, "readiness": "ready" if ready else "candidate", "evidence": {"stateId": state["fingerprint"], "executionId": execution, "executionObserved": bool(outcome), "networkObserved": False, "scope": "ui_state_and_command; effect is a policy classification"}, "effect": effect, "revision": recipe["revision"], "gaps": gaps}
        if ready:
            self.progress["recipes"][ident] = recipe

    def step(self, action, expected_before, expected_after=None, inputs=None):
        self.budget.check()
        if action.get("kind") == "launch":
            if not self.config.get("allowLaunch", False):
                raise MobileError("LAUNCH_NOT_ENABLED", "blocked")
            self.budget.action()
            tree = {"nodes": []}
        else:
            tree = self.backend.observe()
            if tree["fingerprint"] != expected_before:
                raise MobileError("STATE_CHANGED", "blocked")
            if action["kind"] != "back" and not self.policy(action)[0]:
                raise MobileError("ACTION_NOT_ALLOWLISTED", "blocked")
            if action["kind"] in {"click", "type", "swipe"}:
                check_target(action["kind"], locate(tree, action["selector"]))
            self.budget.action()
        execution_id = "execution_" + uuid.uuid4().hex
        started = self.event("ui_action_started", executionId=execution_id, actionId=digest(action), actionKind=action["kind"], beforeStateId=expected_before)
        self.progress["pending"] = {"executionId": execution_id, "startedEvidenceId": started, "beforeStateId": expected_before, "actionId": digest(action)}
        self.checkpoint()
        try:
            self.backend.perform(action, tree, inputs or {})
            after = self.backend.observe()
            if expected_after is not None and after["fingerprint"] != expected_after:
                raise MobileError("STATE_CHANGED", "blocked")
        except MobileError as exc:
            self.event("ui_action_uncertain", executionId=execution_id, code=exc.code, beforeStateId=expected_before)
            raise
        finished = self.event("ui_action_finished", executionId=execution_id, startedEvidenceId=started, afterStateId=after["fingerprint"], status="observed")
        self.last_execution = {"executionId": execution_id, "startedEvidenceId": started, "finishedEvidenceId": finished}
        self.progress["pending"] = None
        self.checkpoint()
        return after

    def reach(self, path):
        current = self.backend.observe()
        target = path[-1]["after"] if path else self.progress["entry"]
        if current["fingerprint"] == target:
            return current
        for _ in range(self.budget.max_depth + 2):
            if current["fingerprint"] == self.progress["entry"]:
                break
            current = self.step({"kind": "back"}, current["fingerprint"])
        if current["fingerprint"] != self.progress["entry"]:
            raise MobileError("ENTRY_STATE_UNREACHABLE", "blocked")
        for step in path:
            current = self.step(step["action"], step["before"], step["after"])
        return current

    def inventory_state(self, tree, path, depth):
        # Metadata is evidence for planning, not permission to grow checkpoints
        # with an unbounded copy of every UI tree. Keep the full live fingerprint
        # and explicitly record truncation of this separate inventory projection.
        prior_bytes = sum(len(json.dumps(state.get("workflowInventory", {}), ensure_ascii=False).encode()) for state in self.progress["states"].values())
        maximum = min(128 * 1024, max(0, 2 * 1024 * 1024 - prior_bytes))
        inventory = {"fingerprint": tree["fingerprint"], "nodes": [], "totalNodes": len(tree["nodes"]), "truncated": False}
        used = len(json.dumps(inventory, ensure_ascii=False).encode())
        for node in tree["nodes"]:
            safe = {key: value for key, value in node.items() if not key.startswith("_")}
            added = len(json.dumps(safe, ensure_ascii=False).encode()) + 2
            if len(inventory["nodes"]) >= 1000 or used + added > maximum:
                inventory["truncated"] = True
                self.progress["gaps"] = list(dict.fromkeys(self.progress["gaps"] + ["workflow_inventory_budget"]))
                break
            inventory["nodes"].append(safe)
            used += added
        inventory_digest = digest(inventory)
        evidence = self.event("ui_state_observed", stateId=tree["fingerprint"], inventoryDigest=inventory_digest)
        return {"fingerprint": tree["fingerprint"], "path": path, "depth": depth, "next": 0, "actions": self.candidates(tree),
                "workflowInventory": inventory, "workflowInventoryDigest": inventory_digest, "stateEvidenceId": evidence}

    def explore(self):
        self.features = self.backend.probe()
        with DeviceLease(self.backend):
            return self._explore()

    def _explore(self):
        if self.config.get("launchApp", False):
            if not self.config.get("allowLaunch", False):
                raise MobileError("LAUNCH_NOT_ENABLED", "blocked")
            self.step({"kind": "launch"}, None)
        if not self.progress["states"]:
            tree = self.backend.observe()
            self.progress["entry"] = tree["fingerprint"]
            self.progress["states"][tree["fingerprint"]] = self.inventory_state(tree, [], 0)
            self.progress["queue"].append(tree["fingerprint"])
        if self.progress.get("pending"):
            self.progress["gaps"].append("interrupted_action_outcome_unknown")
            # Do not silently repeat a possibly effective command after a crash.
            self.progress["pending"] = None
        self.progress["status"] = "running"
        self.checkpoint()
        while self.progress["queue"]:
            self.budget.check()
            state = self.progress["states"][self.progress["queue"][0]]
            if state["next"] >= len(state["actions"]):
                self.progress["queue"].pop(0)
                self.checkpoint()
                continue
            action = state["actions"][state["next"]]
            state["next"] += 1
            allowed, effect = self.policy(action)
            if action["gap"] or not allowed or effect != "read" or action["kind"] in {"type", "check"} or state["depth"] >= self.budget.max_depth:
                self.add_capability(state, action, state["path"], gap=action["gap"] or ("depth_budget" if state["depth"] >= self.budget.max_depth else "input_required" if action["kind"] in {"type", "check"} else "unsafe_or_unknown_effect" if allowed and effect != "read" else "action_requires_allowlist"))
                self.checkpoint()
                continue
            try:
                self.reach(state["path"])
            except MobileError:
                state["next"] -= 1
                raise
            clean = {k: v for k, v in action.items() if k != "gap"}
            try:
                after = self.step(clean, state["fingerprint"])
            except MobileError as exc:
                if exc.status == "partial" and not self.progress.get("pending"):
                    state["next"] -= 1
                self.add_capability(state, clean, state["path"], gap=exc.code)
                raise
            record = {"before": state["fingerprint"], "after": after["fingerprint"], "action": clean, "executionId": self.last_execution["executionId"]}
            path = state["path"] + [record]
            self.add_capability(state, clean, path, outcome=after["fingerprint"])
            self.progress["pending"] = None
            if after["fingerprint"] not in self.progress["states"]:
                if len(self.progress["states"]) >= 1000:
                    raise MobileError("STATE_BUDGET", "partial")
                self.progress["states"][after["fingerprint"]] = self.inventory_state(after, path, state["depth"] + 1)
                self.progress["queue"].append(after["fingerprint"])
            self.checkpoint()
        self.progress["status"] = "completed" if not self.progress["gaps"] else "partial"
        return {"ok": True, "status": self.progress["status"], "states": len(self.progress["states"]), "actions": self.budget.count, "totalActions": self.prior_actions + self.budget.count, "capabilities": len(self.progress["capabilities"]), "features": self.features, "gaps": self.progress["gaps"]}

    def execute(self, recipe, revision, inputs):
        write = isinstance(recipe, dict) and recipe.get("recipeType") == "workflow" and isinstance(recipe.get("definition"), dict) and recipe["definition"].get("effect") == "write"
        if write:
            self.progress["writeOutcome"] = {"status": "not_started", "automaticRetry": False}
        try:
            return self._execute_recipe(recipe, revision, inputs)
        except Exception as error:
            if write and not hasattr(error, "writeOutcome"):
                error.writeOutcome = dict(self.progress["writeOutcome"])
            raise

    def _execute_recipe(self, recipe, revision, inputs):
        if not isinstance(recipe, dict) or recipe.get("schemaVersion") != 1 or recipe.get("identity") != self.identity or recipe.get("sourceId") != self.source["id"]:
            raise MobileError("RECIPE_IDENTITY_MISMATCH", "blocked")
        canonical = {k: v for k, v in recipe.items() if k != "revision"}
        if revision is None or revision != recipe.get("revision") or digest(canonical) != revision:
            raise MobileError("RECIPE_REVISION_MISMATCH", "blocked")
        if recipe.get("recipeType") == "workflow":
            from .mobile_workflows import execute_workflow
            return execute_workflow(self, recipe, revision, inputs)
        steps = recipe.get("steps")
        if not isinstance(steps, list) or not steps or len(steps) > 80:
            raise MobileError("RECIPE_INVALID", "blocked")
        previous_after = None
        required_inputs = set()
        for index, step in enumerate(steps):
            if not isinstance(step, dict) or not isinstance(step.get("action"), dict):
                raise MobileError("RECIPE_INVALID", "blocked")
            action = step["action"]
            if set(action) - {"kind", "selector", "input", "direction"} or action.get("kind") not in {"click", "type", "swipe", "back", "launch"}:
                raise MobileError("RECIPE_ACTION_INVALID", "blocked")
            if action["kind"] in {"click", "type", "swipe"}:
                selector(action.get("selector"))
                if not self.policy(action)[0]:
                    raise MobileError("ACTION_NOT_ALLOWLISTED", "blocked")
            if action["kind"] == "launch" and not self.config.get("allowLaunch", False):
                raise MobileError("LAUNCH_NOT_ENABLED", "blocked")
            if action["kind"] == "type":
                key = action.get("input", "text")
                if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", key):
                    raise MobileError("INPUT_INVALID", "blocked")
                required_inputs.add(key)
            if index < len(steps) - 1 and action["kind"] != "launch" and self.policy(action)[1] != "read":
                raise MobileError("UNSAFE_REPLAY_PREFIX", "blocked")
            if not isinstance(step.get("after"), str) or not re.fullmatch(r"[a-f0-9]{64}", step["after"]) or (action["kind"] != "launch" and (not isinstance(step.get("before"), str) or not re.fullmatch(r"[a-f0-9]{64}", step["before"]))):
                raise MobileError("RECIPE_STATE_INVALID", "blocked")
            if index and step["before"] != previous_after:
                raise MobileError("RECIPE_PATH_DISCONNECTED", "blocked")
            previous_after = step["after"]
        if recipe.get("expectedFinalFp") != previous_after or set(inputs) != required_inputs or any(not isinstance(value, str) or len(value) > 2048 for value in inputs.values()):
            raise MobileError("RECIPE_INPUT_OR_OUTCOME_INVALID", "blocked")
        self.features = self.backend.probe()
        with DeviceLease(self.backend):
            return self._execute_validated(recipe, revision, inputs)

    def _execute_validated(self, recipe, revision, inputs):
        steps = recipe["steps"]
        self.progress["status"] = "running"
        for index, step in enumerate(steps):
            if not isinstance(step, dict) or not isinstance(step.get("action"), dict):
                raise MobileError("RECIPE_INVALID", "blocked")
            self.step(step["action"], step["before"], step["after"], inputs)
            self.progress["pending"] = None
            self.checkpoint()
        self.progress["status"] = "completed"
        return {"ok": True, "status": "completed", "capabilityId": recipe["capabilityId"], "revision": revision, "actions": self.budget.count, "stateId": steps[-1]["after"], "executionObserved": True, "networkObserved": False, "gaps": ["ui_completion_does_not_prove_business_success", "network_scope_not_enforced"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--operation", required=True, choices=["observe", "explore", "execute", "workflow-learn", "workflow-execute"])
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--recipe", type=Path)
    parser.add_argument("--capability")
    parser.add_argument("--revision")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--workflow", type=Path)
    parser.add_argument("--samples", type=Path)
    args = parser.parse_args(argv)
    session = None
    previous = {}
    try:
        config = read_json(args.config)
        if args.output.is_symlink():
            raise MobileError("OUTPUT_SYMLINK_REJECTED")
        session = MobileSession(config, args.output, args.resume)
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous[signum] = signal.getsignal(signum)
            signal.signal(signum, lambda *_: setattr(session.budget, "cancelled", True))
        if args.operation == "observe":
            session.features = session.backend.probe()
            tree = session.backend.observe()
            actions = session.candidates(tree)
            for action in actions:
                session.add_capability(tree, action, [], gap=action.get("gap"))
            controls = [{"id": cap["id"], "name": cap["name"], "readiness": cap["readiness"], "gaps": cap["gaps"]} for cap in session.progress["capabilities"].values()]
            result = {"ok": True, "status": "observed", "stateId": tree["fingerprint"], "controls": controls[:100], "controlCount": len(controls), "truncated": len(controls) > 100, "features": session.features, "networkObserved": False}
            session.progress["status"] = "observed"
        elif args.operation == "explore":
            result = session.explore()
        elif args.operation == "workflow-learn":
            if args.workflow is None or args.samples is None:
                raise MobileError("WORKFLOW_AND_SAMPLES_REQUIRED")
            from .mobile_workflows import learn_workflow
            definition = read_json(args.workflow)
            if isinstance(definition, dict) and definition.get("effect") == "write":
                session.progress["writeOutcome"] = {"status": "not_started", "automaticRetry": False}
            result = learn_workflow(session, definition, read_json(args.samples, 65536))
        else:
            recipes = read_json(args.recipe or args.output / "recipes.json")
            recipe = recipes if isinstance(recipes, dict) and ("steps" in recipes or recipes.get("recipeType") == "workflow") else recipes.get(args.capability) if isinstance(recipes, dict) else None
            if isinstance(recipe, dict) and isinstance(recipe.get("definition"), dict) and recipe["definition"].get("effect") == "write":
                session.progress["writeOutcome"] = {"status": "not_started", "automaticRetry": False}
            raw = sys.stdin.buffer.read(65537)
            if len(raw) > 65536:
                raise MobileError("INPUT_LIMIT")
            payload = json.loads(raw) if raw.strip() else {}
            inputs = payload.get("inputs", {})
            if not isinstance(inputs, dict):
                raise MobileError("INPUT_INVALID")
            result = session.execute(recipe, args.revision, inputs)
    except MobileError as exc:
        result = {"ok": False, "status": exc.status, "error": {"code": exc.code}, "gaps": [exc.code, "network_scope_not_enforced"]}
        if session:
            session.progress["status"] = exc.status
            session.progress["gaps"] = list(dict.fromkeys(session.progress["gaps"] + [exc.code]))
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        result = {"ok": False, "status": "failed", "error": {"code": "MOBILE_OPERATION_FAILED"}, "gaps": ["MOBILE_OPERATION_FAILED"]}
        if session:
            session.progress["status"] = "failed"
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)
    try:
        if session:
            if "writeOutcome" in session.progress:
                result["writeOutcome"] = dict(session.progress["writeOutcome"])
            result["artifactVerification"] = dict(session.backend.artifact_verification)
            result["appArtifactVerified"] = session.backend.artifact_verification["status"] == "verified"
            session.checkpoint()
        atomic_json(args.output / "result.json", result)
    except (OSError, MobileError):
        result = {"ok": False, "status": "failed", "error": {"code": "OUTPUT_FAILED"}}
        if session and "writeOutcome" in session.progress:
            result["writeOutcome"] = {"status": "not_started" if session.progress["writeOutcome"]["status"] == "not_started" else "unknown", "automaticRetry": False}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 0 if session is not None else 2


if __name__ == "__main__":
    # Lazy workflow imports must share this module's exception/session classes
    # when the CLI was launched with python -m rather than imported normally.
    sys.modules.setdefault("apk_inventory.mobile_ui", sys.modules[__name__])
    raise SystemExit(main())
