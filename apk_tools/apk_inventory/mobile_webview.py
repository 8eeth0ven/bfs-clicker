"""Explicit, bounded DOM access to an owner-selected existing WebView.

This adapter never selects a context/window, navigates, installs, or executes
caller-supplied JavaScript. Its DOM values are provider observations, not proof
of a native application's hidden buffer or arbitrary business success. Recipes
are private; live element references never enter a recipe or public manifest.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
import tempfile
import time
from urllib.parse import quote, urlsplit
import uuid

from .mobile_ui import (Budget, DeviceLease, MAX_XML, MobileError, MobileSession,
                        atomic_json, check_target, digest, locate, read_json)

MODALITY = "appium_webview_dom"
PROBE_VERSION = "webview-dom-probe-2"
ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf"
ID_SELECTOR = re.compile(r"#[A-Za-z][A-Za-z0-9_-]{0,63}")
PID_ASSOCIATION = "xcuitest_app_main_pid_v1"
BUNDLE_ASSOCIATION = "reported_bundle_id_v1"
ANDROID_ASSOCIATION = "uiautomator2_devtools_v1"
ANDROID_IDENTITY_KEYS = {"devtoolsSocket", "devtoolsWebview", "devtoolsProcessId", "devtoolsAndroidPackage", "devtoolsPageId"}
TEXT_TRANSPORT_MODE = "chromedriver_cdp_insert_text_v1"
CDP_TEXT_ROUTE = "/goog/cdp/execute"
CDP_TEXT_COMMAND = "Input.insertText"

# Flat element arguments follow the same wire rule as DOM_PROBE. The guard is
# shared, but the write and read scripts remain separate, pinned capabilities.
_FOCUS_GUARD = r"""
const selector=arguments[0], el=arguments[1], html=arguments[2], body=arguments[3],
      owner=arguments[4], parent=arguments[5], url=arguments[6], origin=arguments[7];
function deny(code) { throw new Error('WEBVIEW_FOCUS:' + code); }
if (typeof selector!=='string' || !/^#[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(selector)) deny('SELECTOR');
if (window.top!==window || document.documentElement!==html || document.body!==body ||
    document.URL!==url || window.location.origin!==origin ||
    !['interactive','complete'].includes(document.readyState)) deny('DOCUMENT');
const found=document.querySelectorAll(selector);
if (found.length!==1 || found[0]!==el || !el.isConnected || el.ownerDocument!==document ||
    el.getRootNode()!==document || el.parentElement!==parent || (el.form || null)!==owner ||
    !parent || !parent.isConnected || parent.ownerDocument!==document ||
    (owner && (!owner.isConnected || owner.ownerDocument!==document))) deny('IDENTITY');
const tag=String(el.tagName).toLowerCase(), type=String(el.type || '').toLowerCase();
if (!(tag==='textarea' || tag==='input' && ['text','search','email','tel','url'].includes(type)) ||
    el.disabled || el.readOnly || el.isContentEditable || el.getAttribute('aria-disabled')==='true') deny('INPUT');
if (typeof el.value!=='string' || Array.from(el.value).length>2048) deny('VALUE');
"""
FOCUS_WRITE_SCRIPT = _FOCUS_GUARD + r"""
el.focus({preventScroll:true});
return {probeVersion:'webview-focus-1', focused:document.activeElement===el, value:el.value};
"""
FOCUS_READ_SCRIPT = _FOCUS_GUARD + r"""
return {probeVersion:'webview-focus-1', focused:document.activeElement===el, value:el.value};
"""
FOCUS_WRITE_SHA256 = hashlib.sha256(FOCUS_WRITE_SCRIPT.encode("utf-8")).hexdigest()
FOCUS_READ_SHA256 = hashlib.sha256(FOCUS_READ_SCRIPT.encode("utf-8")).hexdigest()
TEXT_TRANSPORT_CONTRACT = {"schemaVersion": 1, "mode": TEXT_TRANSPORT_MODE, "writeScript": FOCUS_WRITE_SCRIPT,
                           "readScript": FOCUS_READ_SCRIPT, "route": CDP_TEXT_ROUTE, "cdpCommand": CDP_TEXT_COMMAND}
TEXT_TRANSPORT_SHA256 = digest(TEXT_TRANSPORT_CONTRACT)

# Fixed, read-only script. Element arguments deliberately use flat arrays:
# XCUITest atoms converts array entries to live elements, not arbitrary nested
# object members. Never replace this constant with input from a tool caller.
DOM_PROBE = r"""
const specs = arguments[0], pins = arguments[1];
function deny(code) { throw new Error('WEBVIEW_DOM:' + code); }
function bounded(value, max, code) {
  if (typeof value !== 'string' || Array.from(value).length > max) deny(code);
  return value;
}
function unique(sel) {
  if (typeof sel !== 'string' || !/^#[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(sel)) deny('SELECTOR');
  const found = document.querySelectorAll(sel);
  if (found.length !== 1) deny('AMBIGUOUS');
  const el = found[0];
  if (!el.isConnected || el.ownerDocument !== document || el.getRootNode() !== document) deny('DETACHED');
  return el;
}
function visible(el) {
  const style = window.getComputedStyle(el), box = el.getBoundingClientRect();
  if (el.hidden || el.closest('[hidden],[inert],[aria-hidden="true"]') ||
      style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 ||
      ![box.x,box.y,box.width,box.height].every(Number.isFinite) || box.x < 0 || box.y < 0 ||
      box.width <= 0 || box.height <= 0 || box.x + box.width > 20000 || box.y + box.height > 20000) deny('HIDDEN');
  return [box.x,box.y,box.width,box.height].map(Math.round);
}
function identity(el) {
  return {id: bounded(el.id || '',64,'ID'), tag: String(el.tagName).toLowerCase()};
}
if (!Array.isArray(specs) || specs.length < 3 || specs.length > 32) deny('SPEC');
if (window.top !== window || !document.documentElement || !document.body) deny('DOCUMENT');
if (!['interactive','complete'].includes(document.readyState)) deny('LOADING');
const refs = [document.documentElement, document.body], groups = {}, rows = {};
for (const spec of specs) {
  if (!spec || !['input','button','output'].includes(spec.kind)) deny('KIND');
  const el = unique(spec.selector), group = spec.group === null && spec.kind === 'output' ? null : unique(spec.group);
  if (group && (!['form','div','section'].includes(String(group.tagName).toLowerCase()) || group === el ||
      el.closest(spec.group) !== group || !group.contains(el))) deny('GROUP');
  const groupBox = group ? visible(group) : null, box = visible(el);
  if (group && !groups[spec.group]) {
    groups[spec.group] = {id: bounded(group.id,64,'GROUP_ID'), tag: String(group.tagName).toLowerCase(), bounds: groupBox};
    refs.push(group);
  }
  const tag = String(el.tagName).toLowerCase(), type = String(el.type || '').toLowerCase();
  const owner = el.form || null, parent = el.parentElement;
  if (!parent || !parent.isConnected || parent.ownerDocument !== document ||
      (owner && (!owner.isConnected || owner.ownerDocument !== document))) deny('OWNER');
  if (el.isContentEditable) deny('EDITABLE');
  if (spec.kind !== 'output' && (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true')) deny('DISABLED');
  if (spec.kind === 'input' && !(tag === 'textarea' || (tag === 'input' && ['text','search','email','tel','url'].includes(type)))) deny('INPUT_TYPE');
  if (spec.kind === 'button' && !(tag === 'button' || (tag === 'input' && ['button','submit'].includes(type)))) deny('BUTTON_TYPE');
  if (spec.kind === 'output' && !['output','div','p','span'].includes(tag)) deny('OUTPUT_TYPE');
  if (spec.kind !== 'output' && owner && owner !== group) deny('FORM_GROUP');
  const contract = {selector: spec.selector, kind: spec.kind, tag, type,
    id: bounded(el.id,64,'ID'), name: bounded(el.getAttribute('name') || '',128,'NAME'),
    role: bounded(el.getAttribute('role') || '',64,'ROLE'), ariaLabel: bounded(el.getAttribute('aria-label') || '',256,'LABEL'),
    groupSelector: group ? spec.group : null, groupId: group ? bounded(group.id,64,'GROUP_ID') : null, groupTag: group ? String(group.tagName).toLowerCase() : null,
    formId: owner ? bounded(owner.id || '',64,'FORM') : null,
    formAction: owner ? bounded(owner.action || '',2048,'FORM_ACTION') : null,
    formMethod: owner ? bounded(owner.method || '',16,'FORM_METHOD') : null,
    parentId: bounded(parent.id || '',64,'PARENT_ID'), parentTag: String(parent.tagName).toLowerCase(),
    label: spec.kind === 'button' ? bounded(tag === 'input' ? el.value : el.textContent,512,'LABEL') : ''};
  const row = {contract, bounds: box};
  if (spec.kind === 'input') row.value = bounded(el.value,2048,'VALUE');
  if (spec.kind === 'output') row.text = bounded(el.textContent,4096,'TEXT');
  refs.push(el, owner, parent);
  rows[spec.id] = row;
}
const inventory = [], configured = new Set(specs.map(spec => spec.selector));
let inventoryTotal = 0;
const inventoryElements = document.querySelectorAll('input,textarea,button,select,output,[role="button"],[role="textbox"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[role="status"],[role="alert"]');
for (let inventoryIndex=0; inventoryIndex<Math.min(inventoryElements.length,1024); inventoryIndex++) {
  const el = inventoryElements[inventoryIndex];
  try { visible(el); } catch (_) { continue; }
  inventoryTotal++;
  if (inventory.length >= 256) continue;
  const id = el.id || '', testId = el.getAttribute('data-testid') || '';
  const stableSelector = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) && document.querySelectorAll('#' + id).length === 1 ? '#' + id : null;
  inventory.push({selector: stableSelector, dataTestId: bounded(testId,128,'TEST_ID'),
    tag:String(el.tagName).toLowerCase(), type:String(el.type || '').toLowerCase(), role:bounded(el.getAttribute('role') || '',64,'ROLE'),
    configured:stableSelector !== null && configured.has(stableSelector),
    dispatchAuthorized:false});
}
if (pins !== null) {
  if (!Array.isArray(pins) || pins.length !== refs.length) deny('PINS');
  for (let i=0; i<refs.length; i++) if (pins[i] !== refs[i]) deny('IDENTITY');
}
return {probeVersion:'webview-dom-probe-2', url:bounded(document.URL,2048,'URL'),
  origin:bounded(window.location.origin,2048,'ORIGIN'), top:true, readyState:document.readyState,
  pinsMatched:pins !== null, refs, rows, groups, inventory, inventoryTotal, inventoryTruncated:inventoryTotal > 256 || inventoryElements.length > 1024};
"""
PROBE_SHA256 = hashlib.sha256(DOM_PROBE.encode("utf-8")).hexdigest()


def require(condition, code, status="blocked"):
    if not condition:
        raise MobileError(code, status)


def normalize_reference(ref):
    """Accept only unambiguous W3C references, including equal dual-key wire form."""
    if ref is None:
        return None
    require(isinstance(ref, dict) and set(ref) in ({ELEMENT_KEY}, {ELEMENT_KEY, "ELEMENT"}), "WEBVIEW_REFERENCE_INVALID")
    value = ref[ELEMENT_KEY]
    require(isinstance(value, str) and 0 < len(value) <= 1024, "WEBVIEW_REFERENCE_INVALID")
    if "ELEMENT" in ref:
        require(isinstance(ref["ELEMENT"], str) and ref["ELEMENT"] == value, "WEBVIEW_REFERENCE_INVALID")
    return {ELEMENT_KEY: value}


def origin(value):
    require(isinstance(value, str) and 0 < len(value) <= 2048, "WEBVIEW_URL_INVALID")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise MobileError("WEBVIEW_URL_INVALID", "blocked") from None
    require(parsed.scheme in {"http", "https"} and parsed.hostname and
            not parsed.username and not parsed.password and not parsed.fragment,
            "WEBVIEW_URL_INVALID")
    host = parsed.hostname.lower()
    if ":" in host:
        host = "[" + host + "]"
    if port is not None and port != {"http": 80, "https": 443}[parsed.scheme]:
        host += ":" + str(port)
    return parsed.scheme + "://" + host


def context_coordinates(value):
    match = re.fullmatch(r"WEBVIEW_([1-9][0-9]{0,9})\.([1-9][0-9]{0,15})", value) if isinstance(value, str) else None
    require(match is not None, "WEBVIEW_PID_CONTEXT_INVALID")
    pid, page = map(int, match.groups())
    require(pid <= 2147483647 and page <= 9007199254740991, "WEBVIEW_PID_CONTEXT_INVALID")
    return pid, page


def association_profile(webview, platform="ios"):
    association = webview.get("association")
    if platform == "android":
        require(association == {"mode": ANDROID_ASSOCIATION}, "WEBVIEW_ASSOCIATION_CONFIG_INVALID")
        return association
    if association is None:
        return None
    require(isinstance(association, dict) and set(association) == {"mode", "reportedBundleId"} and
            association.get("mode") == PID_ASSOCIATION and isinstance(association.get("reportedBundleId"), str) and
            re.fullmatch(r"process-[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", association["reportedBundleId"]) and
            not association["reportedBundleId"].startswith("process-com.apple.WebKit"), "WEBVIEW_ASSOCIATION_CONFIG_INVALID")
    context_coordinates(webview.get("context"))
    return association


def text_transport_profile(webview, platform):
    if platform == "android":
        require(webview.get("textTransport") == {"mode": TEXT_TRANSPORT_MODE}, "WEBVIEW_TEXT_TRANSPORT_REQUIRED", "unsupported")
        return TEXT_TRANSPORT_MODE
    require("textTransport" not in webview, "WEBVIEW_TEXT_TRANSPORT_CONFIG_INVALID")
    return None


def android_provenance(value, app_id, context, window):
    """Validate the observed UiA2 DevTools join, never capabilities or caller PIDs.

    UiA2's mapping joins the Unix socket PID to an adb-observed process name;
    info and pages are separately read from that socket's CDP endpoints. This
    profile accepts a single main-process page, not colon-suffixed processes,
    Chrome tabs or custom sockets with an unverified ownership relationship.
    """
    require(isinstance(value, dict) and set(value) == ANDROID_IDENTITY_KEYS and
            all(isinstance(item, str) and 0 < len(item) <= 2048 for item in value.values()), "WEBVIEW_ANDROID_PROVENANCE_UNAVAILABLE")
    pid = value["devtoolsProcessId"]
    require(re.fullmatch(r"[1-9][0-9]{0,9}", pid) and int(pid) <= 2147483647 and
            value["devtoolsSocket"] == "@webview_devtools_remote_" + pid and value["devtoolsWebview"] == "WEBVIEW_" + pid,
            "WEBVIEW_ANDROID_SOCKET_PID_MISMATCH")
    require(value["devtoolsAndroidPackage"] == app_id and context == "WEBVIEW_" + app_id, "WEBVIEW_ANDROID_PACKAGE_MISMATCH")
    page = value["devtoolsPageId"]
    require(re.fullmatch(r"[A-Fa-f0-9]{32}", page) and window == page, "WEBVIEW_ANDROID_PAGE_WINDOW_MISMATCH")
    return copy.deepcopy(value)


def validate_config(config):
    require(isinstance(config, dict) and isinstance(config.get("backend"), dict) and
            isinstance(config.get("source"), dict), "WEBVIEW_CONFIG_INVALID")
    source, backend = config["source"], config["backend"]
    platform = backend.get("platform")
    require((source.get("kind"), platform) in {("ios", "ios"), ("apk", "android")} and
            backend.get("type") == "appium-webview", "WEBVIEW_DRIVER_PROFILE_UNVERIFIED", "unsupported")
    require(isinstance(source.get("id"), str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", source["id"]), "WEBVIEW_CONFIG_INVALID")
    require(isinstance(backend.get("appId"), str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+", backend["appId"]), "WEBVIEW_CONFIG_INVALID")
    require(isinstance(backend.get("sessionId"), str) and re.fullmatch(r"[A-Za-z0-9._:-]{1,256}", backend["sessionId"]), "WEBVIEW_CONFIG_INVALID")
    transport = urlsplit(backend.get("url", ""))
    require(transport.scheme in {"http", "https"} and transport.hostname and not transport.username and
            not transport.password and not transport.query and not transport.fragment, "WEBVIEW_CONFIG_INVALID")
    try:
        transport.port
    except ValueError:
        raise MobileError("WEBVIEW_CONFIG_INVALID", "blocked") from None
    webview = backend.get("webview")
    allowed_keys = ({"context", "windowHandle", "origin", "url", "controls", "association", "textTransport"},) if platform == "android" else (
                   {"context", "windowHandle", "origin", "url", "controls"}, {"context", "windowHandle", "origin", "url", "controls", "association"})
    require(isinstance(webview, dict) and set(webview) in allowed_keys, "WEBVIEW_CONFIG_INVALID")
    association_profile(webview, platform)
    text_transport_profile(webview, platform)
    require(isinstance(webview["context"], str) and re.fullmatch(r"WEBVIEW_[A-Za-z0-9._:-]{1,256}", webview["context"]), "WEBVIEW_CONFIG_INVALID")
    require(isinstance(webview["windowHandle"], str) and 0 < len(webview["windowHandle"]) <= 256, "WEBVIEW_CONFIG_INVALID")
    require(origin(webview["url"]) == webview["origin"] == origin(webview["origin"]) and
            urlsplit(webview["origin"]).path == "" and not urlsplit(webview["origin"]).query,
            "WEBVIEW_ORIGIN_INVALID")
    controls = webview["controls"]
    require(isinstance(controls, list) and 3 <= len(controls) <= 32, "WEBVIEW_CONTROLS_INVALID")
    ids, selectors, kinds = set(), set(), set()
    for row in controls:
        require(isinstance(row, dict) and set(row) == {"id", "selector", "kind", "group"}, "WEBVIEW_CONTROLS_INVALID")
        require(isinstance(row["id"], str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", row["id"]) and row["id"] not in ids,
                "WEBVIEW_CONTROLS_INVALID")
        require(isinstance(row["selector"], str) and ID_SELECTOR.fullmatch(row["selector"]) and row["selector"] not in selectors and
                (isinstance(row["group"], str) and ID_SELECTOR.fullmatch(row["group"]) and row["group"] != row["selector"] or
                 row["group"] is None and row["kind"] == "output") and
                row["kind"] in {"input", "button", "output"}, "WEBVIEW_CONTROLS_INVALID")
        ids.add(row["id"]); selectors.add(row["selector"]); kinds.add(row["kind"])
    require(kinds == {"input", "button", "output"} and not selectors.intersection(row["group"] for row in controls), "WEBVIEW_CONTROLS_INVALID")
    allowlist = config.get("actionAllowlist", [])
    require(isinstance(allowlist, list) and len(allowlist) <= 64, "WEBVIEW_ALLOWLIST_INVALID")
    for row in allowlist:
        require(isinstance(row, dict) and set(row) <= {"kind", "selector", "effect"} and row.get("kind") in {"type", "click"} and
                isinstance(row.get("selector"), dict) and set(row["selector"]) == {"resourceId"} and row.get("effect") == "read",
                "WEBVIEW_ALLOWLIST_INVALID")
        require(any(row["selector"]["resourceId"] == spec["selector"] and
                    spec["kind"] == ("input" if row["kind"] == "type" else "button") for spec in controls), "WEBVIEW_ALLOWLIST_INVALID")
    require(not any(config.get(key) for key in ("allowLaunch", "nativeStagePlanning", "nativeBranchPlanning")), "WEBVIEW_NATIVE_PATH_REJECTED")
    require(config.get("expectedArtifact") is None, "WEBVIEW_ARTIFACT_VERIFICATION_UNSUPPORTED", "unsupported")
    timeout = backend.get("commandTimeoutMs", 15000)
    require(isinstance(timeout, int) and not isinstance(timeout, bool) and 1 <= timeout <= 120000, "WEBVIEW_CONFIG_INVALID")
    journal = backend.get("intentJournal")
    require(journal is None or isinstance(journal, str) and Path(journal).is_absolute(), "WEBVIEW_JOURNAL_INVALID")
    return copy.deepcopy(config)


def _save_journal(path, record):
    atomic_json(path, record)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class WebViewBackend:
    def __init__(self, config, budget):
        self.config, self.budget = config, budget
        self.app_id, self.platform, self.session = config["appId"], config["platform"], config["sessionId"]
        self.url, self.webview = urlsplit(config["url"]), config["webview"]
        self.text_transport = text_transport_profile(self.webview, self.platform)
        self.command_timeout_ms = config.get("commandTimeoutMs", 15000)
        self.artifact_verification = {"status": "unverified", "reason": "webview_session_does_not_prove_installed_artifact"}
        self.transport_identity = digest([config["url"], self.session])
        directory = Path(tempfile.gettempdir()) / ("bfs-mobile-webview-" + str(os.getuid()))
        self.journal_path = Path(config["intentJournal"]) if config.get("intentJournal") else directory / (self.transport_identity + ".json")
        self.completion_path = self.journal_path.with_name(self.journal_path.name + ".completed.json")
        require(not self.journal_path.is_symlink() and not self.journal_path.parent.is_symlink(), "WEBVIEW_JOURNAL_INVALID")
        self.refs = None
        self.contracts = None
        self.source_identity = None
        self.source_revision = None
        self.document_lease = uuid.uuid4().hex
        self.execution_id = None
        self.intents = []
        self.acknowledged_commands = 0
        self.completion_verified = None
        self.execution_outcome = "not_started"
        self.ui_attempted = False
        self.poisoned = False
        self.observation_count = 0
        self._dispatching = False

    def request(self, method, suffix, body=None):
        self.budget.check()
        is_ui = method == "POST" and bool(re.fullmatch(r"/element/[^/]+/(?:clear|value|click)", suffix)) and not (
                self.platform == "android" and suffix.endswith("/value"))
        text_mode = self.platform == "android" and self.text_transport == TEXT_TRANSPORT_MODE
        focus_read = text_mode and method == "POST" and suffix == "/execute/sync" and isinstance(body, dict) and set(body) == {"script", "args"} and body["script"] == FOCUS_READ_SCRIPT
        focus_write = text_mode and self._dispatching and method == "POST" and suffix == "/execute/sync" and isinstance(body, dict) and set(body) == {"script", "args"} and body["script"] == FOCUS_WRITE_SCRIPT
        insert = text_mode and self._dispatching and method == "POST" and suffix == CDP_TEXT_ROUTE and isinstance(body, dict) and set(body) == {"cmd", "params"} and body["cmd"] == CDP_TEXT_COMMAND and isinstance(body["params"], dict) and set(body["params"]) == {"text"}
        if insert:
            self.validate_literal_inputs(body["params"])
        require((method == "GET" and suffix in {"/context", "/window/handles", "/window", "/url", "/source", "/appium/settings"}) or
                (method == "GET" and suffix == "/appium/device/current_package" and self.platform == "android") or
                (method == "POST" and suffix == "/execute/sync" and isinstance(body, dict) and body.get("script") in
                 ({DOM_PROBE, "mobile: getContexts"} | ({"mobile: activeAppInfo"} if self.platform == "ios" else set()))) or
                is_ui and self._dispatching or focus_read or focus_write or insert,
                "WEBVIEW_COMMAND_REJECTED")
        connection_class = http.client.HTTPSConnection if self.url.scheme == "https" else http.client.HTTPConnection
        connection = connection_class(self.url.hostname, self.url.port, timeout=self.budget.timeout(self.command_timeout_ms / 1000))
        try:
            payload = json.dumps(body, ensure_ascii=False, allow_nan=False).encode() if body is not None else None
            path = self.url.path.rstrip("/") + "/session/" + quote(self.session, safe="") + suffix
            connection.request(method, path, body=payload, headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            raw = response.read(MAX_XML + 1)
            require(len(raw) <= MAX_XML, "WEBVIEW_DRIVER_OUTPUT_LIMIT")
            require(200 <= response.status < 300, "WEBVIEW_DRIVER_COMMAND_FAILED")
            envelope = json.loads(raw)
            require(isinstance(envelope, dict) and "value" in envelope, "WEBVIEW_DRIVER_RESPONSE_INVALID")
            value = envelope["value"]
            require(not isinstance(value, dict) or not value.get("error"), "WEBVIEW_DRIVER_COMMAND_FAILED")
            self.budget.check()
            return value
        except (OSError, ValueError, http.client.HTTPException):
            raise MobileError("WEBVIEW_DRIVER_UNAVAILABLE", "needs_device") from None
        finally:
            connection.close()

    def _execute(self, script, args):
        return self.request("POST", "/execute/sync", {"script": script, "args": args})

    def _ambient(self):
        if self.platform == "android":
            return self._android_ambient()
        wanted = self.webview
        active = self._execute("mobile: activeAppInfo", [])
        require(isinstance(active, dict) and active.get("bundleId") == self.app_id, "WEBVIEW_FOREGROUND_APP_UNVERIFIED")
        contexts = self._execute("mobile: getContexts", [{"waitForWebviewMs": 0}])
        require(isinstance(contexts, list), "WEBVIEW_CONTEXT_PROVENANCE_UNAVAILABLE")
        matched = [row for row in contexts if isinstance(row, dict) and row.get("id") == wanted["context"]]
        require(len(matched) == 1, "WEBVIEW_CONTEXT_PROVENANCE_UNAVAILABLE")
        context = matched[0]
        association = association_profile(wanted)
        if association is None:
            require(context.get("bundleId") == active["bundleId"], "WEBVIEW_CONTEXT_APP_UNVERIFIED")
        else:
            pid = active.get("pid")
            require(isinstance(pid, int) and not isinstance(pid, bool) and 1 <= pid <= 2147483647, "WEBVIEW_MAIN_PID_UNVERIFIED")
            context_pid, _ = context_coordinates(context.get("id"))
            require(context_pid == pid, "WEBVIEW_CONTEXT_MAIN_PID_MISMATCH")
            require(context.get("bundleId") == association["reportedBundleId"], "WEBVIEW_CONTEXT_RAW_BUNDLE_MISMATCH")
        require(context.get("url") == wanted["url"] and origin(context["url"]) == wanted["origin"], "WEBVIEW_CONTEXT_URL_CHANGED")
        current = self.request("GET", "/context")
        require(current == context["id"], "WEBVIEW_CONTEXT_CHANGED")
        handles = self.request("GET", "/window/handles")
        window = self.request("GET", "/window")
        require(isinstance(handles, list) and handles == [wanted["windowHandle"]] and window == wanted["windowHandle"], "WEBVIEW_WINDOW_CHANGED")
        current_url = self.request("GET", "/url")
        require(current_url == context["url"], "WEBVIEW_URL_CHANGED")
        settings = self.request("GET", "/appium/settings")
        require(isinstance(settings, dict) and settings.get("nativeWebTap") is False and settings.get("nativeWebTapStrict") is False,
                "WEBVIEW_NATIVE_TAP_FALLBACK_UNVERIFIED")
        identity = {"modality": MODALITY, "platform": "ios", "appId": active["bundleId"],
                "context": current, "contextBundleId": context["bundleId"], "windowHandle": window,
                "origin": origin(current_url), "url": current_url, "probeVersion": PROBE_VERSION, "probeSha256": PROBE_SHA256,
                "documentScope": "worker_live_reference_identity", "associationMethod": PID_ASSOCIATION if association is not None else BUNDLE_ASSOCIATION}
        if association is not None:
            identity["appMainPid"] = str(pid)
        return identity

    def _android_ambient(self):
        wanted = self.webview
        # Listing may allocate a transient ADB/CDP forwarding port. It is not a
        # context-selection authority; current context/window are read around it.
        current_before = self.request("GET", "/context")
        window_before = self.request("GET", "/window")
        active = self.request("GET", "/appium/device/current_package")
        require(active == self.app_id, "WEBVIEW_FOREGROUND_APP_UNVERIFIED")
        contexts = self._execute("mobile: getContexts", [{"waitForWebviewMs": 0}])
        require(isinstance(contexts, list) and len(contexts) <= 256, "WEBVIEW_CONTEXT_PROVENANCE_UNAVAILABLE")
        related = [row for row in contexts if isinstance(row, dict) and (row.get("webviewName") == wanted["context"] or
                   isinstance(row.get("info"), dict) and row["info"].get("Android-Package") == active)]
        require(len(related) == 1, "WEBVIEW_CONTEXT_PROVENANCE_UNAVAILABLE")
        context = related[0]
        info, pages = context.get("info"), context.get("pages")
        require(isinstance(info, dict) and isinstance(pages, list) and len(pages) == 1 and isinstance(pages[0], dict),
                "WEBVIEW_ANDROID_PAGE_AMBIGUOUS")
        page = pages[0]
        require(page.get("type") == "page" and page.get("url") == wanted["url"], "WEBVIEW_CONTEXT_URL_CHANGED")
        socket = context.get("proc")
        match = re.fullmatch(r"@webview_devtools_remote_([1-9][0-9]{0,9})", socket) if isinstance(socket, str) else None
        require(match is not None, "WEBVIEW_ANDROID_SOCKET_PID_MISMATCH")
        observed = {"devtoolsSocket": socket, "devtoolsWebview": context.get("webview"), "devtoolsProcessId": match[1],
                    "devtoolsAndroidPackage": info.get("Android-Package"), "devtoolsPageId": page.get("id")}
        require(context.get("webviewName") == wanted["context"], "WEBVIEW_CONTEXT_CHANGED")
        provenance = android_provenance(observed, active, context["webviewName"], wanted["windowHandle"])
        current = self.request("GET", "/context")
        handles = self.request("GET", "/window/handles")
        window = self.request("GET", "/window")
        require(current_before == current == wanted["context"], "WEBVIEW_CONTEXT_CHANGED")
        require(window_before == window == wanted["windowHandle"] and handles == [window], "WEBVIEW_WINDOW_CHANGED")
        current_url = self.request("GET", "/url")
        require(current_url == page["url"] and origin(current_url) == wanted["origin"], "WEBVIEW_URL_CHANGED")
        require(self.request("GET", "/appium/device/current_package") == active, "WEBVIEW_FOREGROUND_APP_UNVERIFIED")
        return {"modality": MODALITY, "platform": "android", "appId": active, "context": current, "windowHandle": window,
                "origin": origin(current_url), "url": current_url, "probeVersion": PROBE_VERSION, "probeSha256": PROBE_SHA256,
                "documentScope": "worker_live_reference_identity", "associationMethod": ANDROID_ASSOCIATION,
                "textTransport": self.text_transport, "textTransportSha256": TEXT_TRANSPORT_SHA256, **provenance}

    def foreground(self):
        return self._ambient()

    def verify_artifact(self):
        return self.artifact_verification

    def _probe(self, pins):
        result = self._execute(DOM_PROBE, [self.webview["controls"], pins])
        require(isinstance(result, dict) and result.get("probeVersion") == PROBE_VERSION and
                result.get("top") is True and result.get("readyState") in {"interactive", "complete"} and
                result.get("url") == self.webview["url"] and result.get("origin") == self.webview["origin"] and
                result.get("pinsMatched") is (pins is not None), "WEBVIEW_DOM_PROBE_REJECTED")
        refs, rows, groups = result.get("refs"), result.get("rows"), result.get("groups")
        group_count = len({row["group"] for row in self.webview["controls"] if row["group"] is not None})
        require(isinstance(refs, list) and len(refs) == 2 + group_count + 3 * len(self.webview["controls"]), "WEBVIEW_REFERENCE_INVALID")
        refs = [normalize_reference(ref) for ref in refs]
        result = {**result, "refs": refs}
        require(all(ref is not None for ref in refs[:2]) and isinstance(rows, dict) and
                set(rows) == {row["id"] for row in self.webview["controls"]} and isinstance(groups, dict) and
                set(groups) == {row["group"] for row in self.webview["controls"] if row["group"] is not None}, "WEBVIEW_DOM_PROBE_REJECTED")
        offset, seen = 2, set()
        for spec in self.webview["controls"]:
            if spec["group"] is not None and spec["group"] not in seen:
                require(refs[offset] is not None, "WEBVIEW_REFERENCE_INVALID")
                offset += 1
                seen.add(spec["group"])
            require(refs[offset] is not None and refs[offset + 2] is not None, "WEBVIEW_REFERENCE_INVALID")
            offset += 3
        return result

    @staticmethod
    def _sha(value):
        try:
            return hashlib.sha256(value.encode("utf-8")).hexdigest()
        except UnicodeError:
            raise MobileError("WEBVIEW_DOM_TEXT_INVALID", "blocked") from None

    def observe(self, input_suffix=None):
        self.budget.check()
        before = self._ambient()
        source = self.request("GET", "/source")
        require(isinstance(source, str) and len(source.encode("utf-8")) <= MAX_XML and
                re.search(r"<html(?:\s|>)", source, re.I), "WEBVIEW_HTML_SOURCE_UNVERIFIED")
        first = self._probe(self.refs)
        pins = self.refs if self.refs is not None else first["refs"]
        second = self._probe(pins)
        after = self._ambient()
        require(before == after, "WEBVIEW_SOURCE_IDENTITY_CHANGED")
        require(first["rows"] == second["rows"] and first["groups"] == second["groups"], "WEBVIEW_DOM_CHANGED_DURING_OBSERVATION")
        nodes, contracts = [], {}
        for group_selector, group in second["groups"].items():
            require(isinstance(group, dict) and set(group) == {"id", "tag", "bounds"} and group["id"] == group_selector[1:] and
                    group["tag"] in {"form", "div", "section"}, "WEBVIEW_DOM_CONTRACT_INVALID")
            contract = {"selector": group_selector, "kind": "group", "tag": group["tag"], "id": group["id"]}
            nodes.append(self._node(contract, group["bounds"]))
            contracts[group_selector] = contract
        for spec in self.webview["controls"]:
            row = second["rows"][spec["id"]]
            require(isinstance(row, dict) and isinstance(row.get("contract"), dict), "WEBVIEW_DOM_CONTRACT_INVALID")
            contract = row["contract"]
            required = {"selector", "kind", "tag", "type", "id", "name", "role", "ariaLabel", "groupSelector", "groupId", "groupTag",
                        "formId", "formAction", "formMethod", "parentId", "parentTag", "label"}
            require(set(contract) == required and contract["selector"] == spec["selector"] and contract["id"] == spec["selector"][1:] and
                    contract["kind"] == spec["kind"] and contract["groupSelector"] == spec["group"] and
                    (spec["group"] is None and contract["groupId"] is None and contract["groupTag"] is None or
                     spec["group"] is not None and contract["groupId"] == spec["group"][1:] and contract["groupTag"] == second["groups"][spec["group"]]["tag"]),
                    "WEBVIEW_DOM_CONTRACT_INVALID")
            require(all(value is None or isinstance(value, str) and len(value) <= 2048 for value in contract.values()), "WEBVIEW_DOM_CONTRACT_INVALID")
            require((spec["kind"] == "input" and (contract["tag"] == "textarea" or contract["tag"] == "input" and contract["type"] in {"text", "search", "email", "tel", "url"}) or
                     spec["kind"] == "button" and (contract["tag"] == "button" or contract["tag"] == "input" and contract["type"] in {"button", "submit"}) or
                     spec["kind"] == "output" and contract["tag"] in {"output", "div", "p", "span"}), "WEBVIEW_DOM_CONTRACT_INVALID")
            if contract["formAction"] is not None:
                require(origin(contract["formAction"]) == before["origin"], "WEBVIEW_FORM_ORIGIN_CHANGED")
            node = self._node(contract, row.get("bounds"))
            if spec["kind"] == "input":
                value = row.get("value")
                require(isinstance(value, str) and len(value) <= 2048, "WEBVIEW_INPUT_EVIDENCE_UNAVAILABLE")
                node.update({"_inputSha256": self._sha(value), "_inputLength": len(value), "_inputValuePresent": True,
                             "_inputPlaceholderOnly": False, "_inputUtf16Length": len(value.encode("utf-16-le")) // 2})
                if input_suffix is not None:
                    require(isinstance(input_suffix, str), "WEBVIEW_INPUT_INVALID")
                    matched = value.endswith(input_suffix)
                    prefix = value[:-len(input_suffix)] if input_suffix else value
                    node.update({"_inputSuffixMatched": matched, "_inputPrefixSha256": self._sha(prefix) if matched else None})
            elif spec["kind"] == "output":
                require(isinstance(row.get("text"), str) and len(row["text"]) <= 4096, "WEBVIEW_OUTPUT_EVIDENCE_UNAVAILABLE")
                self._sha(row["text"])
                node["text"] = row["text"]
            else:
                node["text"] = contract["label"]
            contracts[spec["selector"]] = contract
            nodes.append(node)
        revision = digest({"sourceIdentity": before, "contracts": contracts})
        if self.source_identity is not None:
            require(self.source_identity == before and self.source_revision == revision, "WEBVIEW_DOM_CONTRACT_CHANGED")
        self.refs = pins
        self.source_identity, self.source_revision, self.contracts = before, revision, contracts
        self.observation_count += 1
        inventory = second.get("inventory")
        require(isinstance(inventory, list) and len(inventory) <= 256 and isinstance(second.get("inventoryTotal"), int) and
                second["inventoryTotal"] >= len(inventory) and isinstance(second.get("inventoryTruncated"), bool), "WEBVIEW_INVENTORY_INVALID")
        for item in inventory:
            require(isinstance(item, dict) and set(item) == {"selector", "dataTestId", "tag", "type", "role", "configured", "dispatchAuthorized"} and
                    item["dispatchAuthorized"] is False and isinstance(item["configured"], bool) and
                    (item["selector"] is None or isinstance(item["selector"], str) and ID_SELECTOR.fullmatch(item["selector"])) and
                    all(isinstance(item[key], str) and len(item[key]) <= 128 for key in ("dataTestId", "tag", "type", "role")), "WEBVIEW_INVENTORY_INVALID")
        unconfigured = [copy.deepcopy(item) for item in inventory if not item["configured"]]
        gaps = ["owner_limited_control_contract", "dom_check_select_unsupported", "multi_document_navigation_unsupported"]
        if unconfigured:
            gaps.append("unconfigured_visible_controls_observed")
        if second["inventoryTruncated"]:
            gaps.append("dom_inventory_truncated")
        return {"nodes": nodes, "fingerprint": digest([{key: value for key, value in node.items() if key != "bounds"} for node in nodes]),
                "sourceIdentity": copy.deepcopy(before), "sourceRevision": revision, "modality": MODALITY,
                "unconfiguredControls": unconfigured, "inventoryTotal": second["inventoryTotal"], "inventoryTruncated": second["inventoryTruncated"], "gaps": gaps,
                "_documentLease": self.document_lease, "_sourceSha256": self._sha(source)}

    @staticmethod
    def _node(contract, box):
        require(isinstance(box, list) and len(box) == 4 and all(isinstance(n, (int, float)) and not isinstance(n, bool) for n in box) and
                all(0 <= n <= 20000 for n in box) and box[2] > 0 and box[3] > 0, "WEBVIEW_DOM_BOUNDS_INVALID")
        kind = contract["kind"]
        group = [{"resourceId": contract["groupSelector"], "accessibilityId": "", "className": "HTML:" + contract["groupTag"]}] if kind != "group" and contract.get("groupSelector") is not None else []
        return {"resourceId": contract["selector"], "accessibilityId": "", "className": "HTML:" + contract["tag"],
                "text": "", "bounds": box, "enabled": True, "visible": True, "editable": kind == "input", "clickable": kind == "button",
                "secure": False, "scrollable": False, "readOnly": False, "inputType": contract.get("type", ""),
                "containerPath": group, "checkable": False, "checkKind": "", "checked": None,
                "selectionGroupKind": "", "selectionGroup": None, "selectionOptionKind": "", "selectionState": None,
                "domContract": copy.deepcopy(contract)}

    def probe(self):
        self.observe()
        return {"backend": "appium-webview", "platform": self.platform, "modality": MODALITY,
                "features": ["bounded_dom_source", "exact_dom_input_value", "type_replace", "click", "same_document_workflow"],
                "sourceIdentity": copy.deepcopy(self.source_identity), "sourceRevision": self.source_revision,
                "artifactVerification": dict(self.artifact_verification), "appArtifactVerified": False,
                "networkScopeEnforced": False, "captureScopeEnforced": False,
                "inputEvidence": "fixed_readonly_dom_probe_live_value; provider_echo_not_hidden_application_buffer",
                "documentIdentityScope": "fresh_worker_attach_then_live_reference_equality_within_worker",
                "associationEvidenceScope": "fresh_provider_reads_and_installed_driver_context_encoding; not_atomic_or_os_attestation",
                "gaps": (["ios_driver_profile_only"] if self.platform == "ios" else ["android_uiautomator2_devtools_profile_only"]) +
                        ["trusted_existing_selected_context_required", "configured_dom_assertions_only", "network_scope_not_enforced",
                         "owner_limited_control_contract", "dom_check_select_unsupported", "multi_document_navigation_unsupported"]}

    def _read_journal(self, path):
        require(not path.is_symlink() and not path.parent.is_symlink(), "WEBVIEW_JOURNAL_INVALID")
        if path.parent.exists():
            parent_stat = path.parent.stat()
            require(stat.S_ISDIR(parent_stat.st_mode) and parent_stat.st_uid == os.getuid() and not parent_stat.st_mode & 0o077,
                    "WEBVIEW_JOURNAL_INVALID")
        if not path.exists():
            return None
        file_stat = path.stat()
        require(stat.S_ISREG(file_stat.st_mode) and file_stat.st_uid == os.getuid() and not file_stat.st_mode & 0o077 and
                file_stat.st_nlink == 1, "WEBVIEW_JOURNAL_INVALID")
        record = read_json(path, 65536)
        require(isinstance(record, dict) and record.get("schemaVersion") == 2 and record.get("transportIdentity") == self.transport_identity,
                "WEBVIEW_JOURNAL_INVALID")
        return record

    def _pending(self):
        intent = self._read_journal(self.journal_path)
        if intent is None:
            # A completion without its original intent cannot authorize a new
            # transaction after an accidental deletion or partial restoration.
            require(self._read_journal(self.completion_path) is None, "WEBVIEW_JOURNAL_INVALID")
            return None
        require(set(intent) == {"schemaVersion", "transportIdentity", "pending"}, "WEBVIEW_JOURNAL_INVALID")
        pending = intent["pending"]
        require(isinstance(pending, dict) and set(pending) == {"executionId", "status", "automaticRetry", "commands", "sourceRevision", "probeSha256"} and
                isinstance(pending["executionId"], str) and re.fullmatch(r"[a-f0-9]{32}", pending["executionId"]) and
                pending["status"] == "unknown" and pending["automaticRetry"] is False and
                isinstance(pending["commands"], list) and 1 <= len(pending["commands"]) <= 256 and
                all(isinstance(pending[key], str) and re.fullmatch(r"[a-f0-9]{64}", pending[key]) for key in ("sourceRevision", "probeSha256")),
                "WEBVIEW_JOURNAL_INVALID")
        for row in pending["commands"]:
            require(isinstance(row, dict) and set(row) == {"commandId", "command", "selectorDigest", "timestampMs"} and
                    isinstance(row["commandId"], str) and re.fullmatch(r"[a-f0-9]{32}", row["commandId"]) and
                    row["command"] in {"clear", "value", "click", "focus", "insertText"} and isinstance(row["selectorDigest"], str) and
                    re.fullmatch(r"[a-f0-9]{64}", row["selectorDigest"]) and isinstance(row["timestampMs"], int) and
                    not isinstance(row["timestampMs"], bool), "WEBVIEW_JOURNAL_INVALID")
        try:
            receipt = self._read_journal(self.completion_path)
        except (MobileError, OSError):
            return pending
        expected = {"executionId": pending["executionId"], "intentSha256": digest(pending),
                    "commandCount": len(pending["commands"]), "sourceRevision": pending["sourceRevision"],
                    "probeSha256": pending["probeSha256"], "status": "trusted_execution_scope_completed"}
        if receipt is not None and set(receipt) == {"schemaVersion", "transportIdentity", "completion"} and receipt["completion"] == expected:
            return None
        return pending

    @contextmanager
    def execution(self):
        require(self.execution_id is None and not self.poisoned, "WEBVIEW_EXECUTION_UNCERTAIN")
        require(self._pending() is None, "WEBVIEW_PENDING_UNKNOWN")
        self.execution_id, self.intents = uuid.uuid4().hex, []
        self.acknowledged_commands, self.completion_verified = 0, None
        self.execution_outcome, self.ui_attempted = "not_started", False
        try:
            yield
            self.budget.check()
            if self.intents:
                pending = self._pending()
                require(isinstance(pending, dict) and pending.get("executionId") == self.execution_id, "WEBVIEW_JOURNAL_IDENTITY_CHANGED")
                require(self.acknowledged_commands == len(self.intents), "WEBVIEW_EXECUTION_UNCERTAIN")
                completion = {"executionId": self.execution_id, "intentSha256": digest(pending),
                              "commandCount": len(self.intents), "sourceRevision": pending["sourceRevision"],
                              "probeSha256": pending["probeSha256"], "status": "trusted_execution_scope_completed"}
                try:
                    # Never clear or rewrite the intent as a completion step.
                    # Only a matching independent receipt resolves that latch.
                    _save_journal(self.completion_path, {"schemaVersion": 2, "transportIdentity": self.transport_identity, "completion": completion})
                except BaseException:
                    # If publication succeeded before fsync failed, a complete
                    # matching receipt proves the trusted scope had finished.
                    # Classify that separately from an uncertain UI dispatch;
                    # do not attempt restoration writes or replay anything.
                    try:
                        if self._pending() is None:
                            self.completion_verified = completion
                    except (OSError, MobileError):
                        pass
                    raise
                require(self._pending() is None, "WEBVIEW_COMPLETION_RECEIPT_UNVERIFIED")
                self.completion_verified = completion
        except BaseException:
            if self.intents and self.completion_verified is None:
                try:
                    persistent_pending = self._pending() is not None
                except (OSError, MobileError):
                    persistent_pending = True
                # An in-memory prepare is not a UI dispatch. If its first
                # publication failed and no UI was attempted, a fresh worker
                # can safely start; report that same not_started classification.
                self.poisoned = self.ui_attempted or persistent_pending
                self.execution_outcome = "unknown" if self.poisoned else "not_started"
            raise
        finally:
            self.execution_id = None

    def _dispatch(self, element, command, payload, wanted):
        require(self.execution_id is not None and not self.poisoned, "WEBVIEW_EXECUTION_REQUIRED")
        pending = self._pending()
        require(pending is None and not self.intents or isinstance(pending, dict) and pending.get("executionId") == self.execution_id,
                "WEBVIEW_PENDING_UNKNOWN")
        self.budget.check()
        callback = getattr(self, "_before_workflow_ui_command", None)
        if callback:
            callback()
        record = {"commandId": uuid.uuid4().hex, "command": command, "selectorDigest": digest(wanted), "timestampMs": round(time.time() * 1000)}
        self.intents.append(record)
        require(len(self.intents) <= 256, "WEBVIEW_JOURNAL_LIMIT")
        _save_journal(self.journal_path, {"schemaVersion": 2, "transportIdentity": self.transport_identity,
                                       "pending": {"executionId": self.execution_id, "status": "unknown", "automaticRetry": False, "commands": self.intents,
                                                   "sourceRevision": self.source_revision, "probeSha256": PROBE_SHA256}})
        self._dispatching = True
        self.ui_attempted = True
        try:
            if command == "focus":
                require(self.platform == "android" and self.text_transport == TEXT_TRANSPORT_MODE, "WEBVIEW_COMMAND_REJECTED")
                result = self.request("POST", "/execute/sync", payload)
            elif command == "insertText":
                result = self.request("POST", CDP_TEXT_ROUTE, payload)
            else:
                result = self.request("POST", "/element/" + quote(element, safe="") + "/" + command, payload)
            self.acknowledged_commands += 1
            return result
        finally:
            self._dispatching = False

    def _element(self, wanted):
        return self.refs[self._element_offset(wanted)][ELEMENT_KEY]

    def _element_offset(self, wanted):
        require(set(wanted) == {"resourceId"}, "WEBVIEW_SELECTOR_NOT_TRUSTED")
        offset, seen = 2, set()
        for spec in self.webview["controls"]:
            if spec["group"] is not None and spec["group"] not in seen:
                offset += 1
                seen.add(spec["group"])
            if spec["selector"] == wanted["resourceId"]:
                return offset
            offset += 3
        raise MobileError("WEBVIEW_SELECTOR_NOT_TRUSTED", "blocked")

    def _focus_args(self, wanted):
        offset = self._element_offset(wanted)
        return [wanted["resourceId"], self.refs[offset], self.refs[0], self.refs[1], self.refs[offset + 1], self.refs[offset + 2],
                self.webview["url"], self.webview["origin"]]

    def _check_focus(self, result, value):
        require(isinstance(result, dict) and set(result) == {"probeVersion", "focused", "value"} and
                result["probeVersion"] == "webview-focus-1" and result["focused"] is True and
                isinstance(result["value"], str) and self._sha(result["value"]) == self._sha(value), "WEBVIEW_INPUT_FOCUS_UNVERIFIED")

    @staticmethod
    def validate_literal_inputs(inputs):
        require(isinstance(inputs, dict), "WEBVIEW_LITERAL_INPUT_UNSUPPORTED", "unsupported")
        for value in inputs.values():
            require(isinstance(value, str) and len(value) <= 2048 and not any(ord(char) < 32 or 127 <= ord(char) <= 159 or
                    0xe000 <= ord(char) <= 0xe05d or 0xd800 <= ord(char) <= 0xdfff for char in value),
                    "WEBVIEW_LITERAL_INPUT_UNSUPPORTED", "unsupported")
            WebViewBackend._sha(value)

    def perform(self, action, tree, inputs):
        require(self.execution_id is not None and not self.poisoned, "WEBVIEW_EXECUTION_REQUIRED")
        kind = action.get("kind")
        require(kind in {"type", "click"}, "WEBVIEW_ACTION_UNSUPPORTED", "unsupported")
        original = locate(tree, action.get("selector"))
        require(tree.get("_documentLease") == self.document_lease and tree.get("sourceRevision") == self.source_revision,
                "WEBVIEW_OBSERVATION_LEASE_INVALID")
        fresh_tree = self.observe()
        current = locate(fresh_tree, action["selector"])
        require(current["domContract"] == original["domContract"], "WEBVIEW_DOM_CONTRACT_CHANGED")
        check_target(kind, current)
        element = self._element(action["selector"])
        if kind == "click":
            before_click = getattr(self, "_before_workflow_click", None)
            if before_click:
                before_click(fresh_tree, inputs)
            self._dispatch(element, "click", {}, action["selector"])
            self.observe()
            return
        require(action.get("replace") is True, "WEBVIEW_APPEND_UNSUPPORTED", "unsupported")
        value = inputs.get(action.get("input", "text"))
        self.validate_literal_inputs({"value": value})
        expected = self._sha(value)
        self._dispatch(element, "clear", {}, action["selector"])
        cleared = locate(self.observe(), action["selector"])
        require(cleared.get("_inputValuePresent") is True and cleared.get("_inputSha256") == self._sha(""), "WEBVIEW_INPUT_CLEAR_UNVERIFIED")
        if self.platform == "android":
            focused = self._dispatch(element, "focus", {"script": FOCUS_WRITE_SCRIPT, "args": self._focus_args(action["selector"])}, action["selector"])
            self._check_focus(focused, "")
            self.observe()
            self._check_focus(self._execute(FOCUS_READ_SCRIPT, self._focus_args(action["selector"])), "")
            self._dispatch(element, "insertText", {"cmd": CDP_TEXT_COMMAND, "params": {"text": value}}, action["selector"])
        else:
            self._dispatch(element, "value", {"text": value, "value": list(value)}, action["selector"])
        after = locate(self.observe(), action["selector"])
        require(after.get("_inputValuePresent") is True and after.get("_inputSha256") == expected, "WEBVIEW_INPUT_VALUE_UNVERIFIED")
        self.budget.check()


class WebViewSession(MobileSession):
    """The existing inventory/event/workflow protocol with an explicit backend."""
    def __init__(self, config, output, resume=False):
        self.config, self.output = validate_config(config), Path(output)
        require(not self.output.is_symlink(), "OUTPUT_SYMLINK_REJECTED")
        self.source = {"id": self.config["source"]["id"], "kind": self.config["source"]["kind"]}
        self.identity = digest({key: value for key, value in self.config.items() if key not in {"limits", "workflowPermissions"}})
        self.budget = Budget(config.get("limits", {}))
        self.backend = WebViewBackend(self.config["backend"], self.budget)
        self.progress = {"schemaVersion": 1, "identity": self.identity, "states": {}, "queue": [], "capabilities": {}, "recipes": {}, "gaps": [], "actions": 0, "status": "new"}
        if resume:
            self.progress = read_json(self.output / "checkpoint.json")
            require(self.progress.get("identity") == self.identity and self.progress.get("schemaVersion") == 1, "RESUME_IDENTITY_MISMATCH")
            require(not self.progress.get("pending"), "WEBVIEW_PENDING_UNKNOWN")
        self.prior_actions = self.progress.get("totalActions", 0) if resume else 0
        self.features = None
        self.last_execution = None

    def policy(self, action):
        for row in self.config.get("actionAllowlist", []):
            if row["kind"] == action.get("kind") and row["selector"] == action.get("selector"):
                return True, row["effect"]
        return False, "unknown"

    @contextmanager
    def execution(self):
        # WebView orchestration reuses linear._run under this canonical lease;
        # it must not enter the native engine's additional DeviceLease. Even
        # mobile:getContexts can touch the remote debugger's selected page.
        started = False
        try:
            with DeviceLease(self.backend), self.backend.execution():
                started = True
                yield
        except BaseException as error:
            if started and self.backend.completion_verified is not None:
                self.progress["webviewOutcome"] = {"status": "observed", "automaticRetry": False,
                                                   "storageWarning": "matching_completion_receipt_published_before_storage_error",
                                                   "completionReceipt": dict(self.backend.completion_verified)}
            elif started:
                self.progress["webviewOutcome"] = {"status": self.backend.execution_outcome, "automaticRetry": False}
            elif isinstance(error, MobileError) and error.code in {"WEBVIEW_PENDING_UNKNOWN", "WEBVIEW_JOURNAL_INVALID"}:
                self.progress["webviewOutcome"] = {"status": "unknown", "automaticRetry": False}
            raise
        else:
            self.progress["webviewOutcome"] = {"status": "observed" if self.backend.intents else "not_started", "automaticRetry": False}
            if self.backend.completion_verified is not None:
                self.progress["webviewOutcome"]["completionReceipt"] = dict(self.backend.completion_verified)

    def checkpoint(self):
        super().checkpoint()
        manifest = read_json(self.output / "manifest.json")
        manifest["source"].update({"modality": MODALITY, "sourceIdentity": copy.deepcopy(self.backend.source_identity),
                                   "domSourceRevision": self.backend.source_revision,
                                   "inputEvidence": "dom_provider_echo_not_hidden_application_buffer",
                                   "documentIdentityScope": "fresh_worker_attach_then_live_reference_equality_within_worker"})
        atomic_json(self.output / "manifest.json", manifest)

    def explore(self):
        with DeviceLease(self.backend):
            self.features = self.backend.probe()
            tree = self.backend.observe()
            self.progress["states"][tree["fingerprint"]] = self.inventory_state(tree, [], 0)
            self.progress["domInventory"] = {"sourceRevision": tree["sourceRevision"], "unconfiguredControls": tree["unconfiguredControls"],
                                              "total": tree["inventoryTotal"], "truncated": tree["inventoryTruncated"]}
            self.progress["gaps"] = list(dict.fromkeys(self.progress["gaps"] + tree["gaps"]))
            self.progress["entryFp"] = tree["fingerprint"]
            self.progress["status"] = "completed"
            self.checkpoint()
        return {"ok": True, "status": "completed", "states": 1, "actions": 0, "features": self.features,
                "coverage": {"configuredControls": len(self.config["backend"]["webview"]["controls"]),
                             "unconfiguredVisibleControls": len(tree["unconfiguredControls"]), "inventoryTotal": tree["inventoryTotal"], "truncated": tree["inventoryTruncated"]},
                "networkObserved": False, "gaps": tree["gaps"] + ["observation_only_discovery_requires_two_sample_learning"]}

    def execute(self, recipe, revision, inputs):
        from .mobile_webview_planner import execute_workflow
        return execute_workflow(self, recipe, revision, inputs)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--operation", required=True, choices=["observe", "explore", "execute", "workflow-learn", "workflow-execute"])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--recipe", type=Path)
    parser.add_argument("--capability")
    parser.add_argument("--revision")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--workflow", type=Path)
    parser.add_argument("--samples", type=Path)
    args = parser.parse_args(argv)
    session, previous = None, {}
    try:
        session = WebViewSession(read_json(args.config), args.output, args.resume)
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous[signum] = signal.getsignal(signum)
            signal.signal(signum, lambda *_: setattr(session.budget, "cancelled", True))
        if args.operation in {"observe", "explore"}:
            result = session.explore()
        elif args.operation == "workflow-learn":
            require(args.workflow is not None and args.samples is not None, "WORKFLOW_AND_SAMPLES_REQUIRED")
            from .mobile_webview_planner import learn_workflow
            result = learn_workflow(session, read_json(args.workflow), read_json(args.samples, 65536))
        else:
            recipes = read_json(args.recipe or args.output / "recipes.json")
            recipe = recipes if isinstance(recipes, dict) and recipes.get("recipeType") == "webview_workflow" else recipes.get(args.capability) if isinstance(recipes, dict) else None
            raw = sys.stdin.buffer.read(65537)
            require(len(raw) <= 65536, "INPUT_LIMIT")
            payload = json.loads(raw) if raw.strip() else {}
            require(isinstance(payload, dict) and isinstance(payload.get("inputs", {}), dict), "INPUT_INVALID")
            result = session.execute(recipe, args.revision, payload.get("inputs", {}))
    except MobileError as error:
        result = {"ok": False, "status": error.status, "error": {"code": error.code}, "automaticRetry": False}
        if session:
            session.progress["status"] = error.status
            session.progress["gaps"] = list(dict.fromkeys(session.progress["gaps"] + [error.code]))
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        result = {"ok": False, "status": "failed", "error": {"code": "WEBVIEW_OPERATION_FAILED"}, "automaticRetry": False}
        if session:
            session.progress["status"] = "failed"
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)
    try:
        if session:
            if "webviewOutcome" in session.progress:
                result["webviewOutcome"] = dict(session.progress["webviewOutcome"])
            result["artifactVerification"] = dict(session.backend.artifact_verification)
            result["appArtifactVerified"] = False
            session.checkpoint()
        atomic_json(args.output / "result.json", result)
    except (OSError, MobileError):
        result = {"ok": False, "status": "failed", "error": {"code": "OUTPUT_FAILED"}, "automaticRetry": False}
        if session and "webviewOutcome" in session.progress:
            result["webviewOutcome"] = dict(session.progress["webviewOutcome"])
            if result["webviewOutcome"]["status"] == "observed":
                result["webviewOutcome"]["storageWarning"] = "result_persistence_failed_after_observed_scope"
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 0 if session is not None else 2


if __name__ == "__main__":
    raise SystemExit(main())
