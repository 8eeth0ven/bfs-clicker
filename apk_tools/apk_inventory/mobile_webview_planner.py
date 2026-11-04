"""Observed single-document WebView queries, using the linear workflow engine.

Only stable DOM contracts enter private plans. Provider values and live element
references stay transient. A candidate has no execution authority: all actions
need the configured read allowlist, two varied samples and fresh input-related
results. The selected context is never changed by this module.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import copy
import hashlib
import json
from pathlib import Path
import re

from . import mobile_workflows as linear
from .mobile_ui import (DeviceLease, MobileError, atomic_json, digest, locate,
                        read_json)

MODALITY = "appium_webview_dom"
MODE = "webview-dom-linear-v1"
ID = re.compile(r"#[A-Za-z][A-Za-z0-9_-]{0,63}")
FP = re.compile(r"[a-f0-9]{64}")
IDENTITY_KEYS = {"modality", "platform", "appId", "context", "contextBundleId",
                 "windowHandle", "origin", "url", "probeVersion", "probeSha256", "documentScope", "associationMethod"}
DOM_KEYS = {"selector", "kind", "tag", "type", "id", "name", "role", "ariaLabel",
            "groupSelector", "groupId", "groupTag", "formId", "formAction", "formMethod",
            "parentId", "parentTag", "label"}
FLAGS = ("enabled", "visible", "secure", "editable", "clickable", "readOnly")


def fail(code):
    raise MobileError(code, "blocked")


def _identity(session, value):
    if not isinstance(value, dict):
        fail("WEBVIEW_PLAN_SOURCE_INVALID")
    method = value.get("associationMethod")
    from .mobile_webview import (ANDROID_ASSOCIATION, ANDROID_IDENTITY_KEYS, DOM_PROBE, PROBE_VERSION,
                                 TEXT_TRANSPORT_MODE, TEXT_TRANSPORT_SHA256, android_provenance,
                                 association_profile, context_coordinates, text_transport_profile)
    android = value.get("platform") == "android"
    expected_keys = ((IDENTITY_KEYS - {"contextBundleId"}) | ANDROID_IDENTITY_KEYS | {"textTransport", "textTransportSha256"} if android else
                     IDENTITY_KEYS | ({"appMainPid"} if method == "xcuitest_app_main_pid_v1" else set()))
    if (set(value) != expected_keys or
            value.get("modality") != MODALITY or
            value.get("platform") not in {"ios", "android"} or
            any(not isinstance(item, str) or not item or len(item) > 2048 for item in value.values())):
        fail("WEBVIEW_PLAN_SOURCE_INVALID")
    if (value["probeVersion"] != PROBE_VERSION or
            value["probeSha256"] != hashlib.sha256(DOM_PROBE.encode("utf-8")).hexdigest()):
        fail("WEBVIEW_PLAN_PROBE_IDENTITY_MISMATCH")
    backend = session.config.get("backend", {})
    trusted = backend.get("webview", {})
    if (backend.get("type") != "appium-webview" or
            value["platform"] != backend.get("platform") or
            value["appId"] != backend.get("appId") or
            any(value[key] != trusted.get(key) for key in ("context", "windowHandle", "origin", "url")) or
            value["documentScope"] != "worker_live_reference_identity"):
        fail("WEBVIEW_PLAN_SOURCE_MISMATCH")
    association = association_profile(trusted, value["platform"])
    if android:
        if method != ANDROID_ASSOCIATION or session.source.get("kind") != "apk":
            fail("WEBVIEW_PLAN_ASSOCIATION_UNSUPPORTED")
        android_provenance({key: value[key] for key in ANDROID_IDENTITY_KEYS}, value["appId"], value["context"], value["windowHandle"])
        if (text_transport_profile(trusted, "android") != TEXT_TRANSPORT_MODE or value["textTransport"] != TEXT_TRANSPORT_MODE or
                value["textTransportSha256"] != TEXT_TRANSPORT_SHA256):
            fail("WEBVIEW_PLAN_TEXT_TRANSPORT_MISMATCH")
    elif method == "reported_bundle_id_v1":
        if association is not None or value["contextBundleId"] != value["appId"]:
            fail("WEBVIEW_PLAN_ASSOCIATION_MISMATCH")
    elif method == "xcuitest_app_main_pid_v1":
        context_pid, _ = context_coordinates(value["context"])
        if (not isinstance(association, dict) or
                value["contextBundleId"] != association["reportedBundleId"] or
                not re.fullmatch(r"[1-9][0-9]{0,9}", value["appMainPid"]) or
                not 1 <= int(value["appMainPid"]) <= 2147483647 or context_pid != int(value["appMainPid"])):
            fail("WEBVIEW_PLAN_ASSOCIATION_MISMATCH")
    else:
        fail("WEBVIEW_PLAN_ASSOCIATION_UNSUPPORTED")
    if session.source.get("kind") != ("apk" if android else "ios"):
        fail("WEBVIEW_PLAN_SOURCE_MISMATCH")
    return copy.deepcopy(value)


def _control(node):
    if not isinstance(node, dict) or not isinstance(node.get("domContract"), dict):
        fail("WEBVIEW_PLAN_DOM_CONTRACT_MISSING")
    contract = node["domContract"]
    if (set(contract) - DOM_KEYS or not {"selector", "kind", "tag", "id"} <= set(contract) or
            not isinstance(contract.get("selector"), str) or not ID.fullmatch(contract["selector"]) or
            contract["id"] != contract["selector"][1:] or
            not isinstance(contract["kind"], str) or not re.fullmatch(r"[a-z_]{1,32}", contract["kind"]) or
            not isinstance(contract["tag"], str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", contract["tag"]) or
            any(value is not None and (not isinstance(value, str) or len(value) > 2048)
                for value in contract.values())):
        fail("WEBVIEW_PLAN_DOM_CONTRACT_INVALID")
    if contract["kind"] == "group":
        if set(contract) != {"selector", "kind", "tag", "id"} or contract["tag"] not in {"form", "div", "section"}:
            fail("WEBVIEW_PLAN_GROUP_INVALID")
    else:
        if set(contract) != DOM_KEYS:
            fail("WEBVIEW_PLAN_DOM_CONTRACT_INVALID")
        group = contract["groupSelector"]
        if group is None:
            if contract["kind"] != "output" or contract["groupId"] is not None or contract["groupTag"] is not None:
                fail("WEBVIEW_PLAN_GROUP_INVALID")
        elif (not isinstance(group, str) or not ID.fullmatch(group) or contract["groupId"] != group[1:] or
              not isinstance(contract["groupTag"], str)):
            fail("WEBVIEW_PLAN_GROUP_INVALID")
    if (node.get("resourceId") != contract["selector"] or node.get("className") != "HTML:" + contract["tag"] or
            any(not isinstance(node.get(flag), bool) for flag in FLAGS)):
        fail("WEBVIEW_PLAN_CONTROL_INVALID")
    if contract["kind"] in {"input", "button", "output", "group"}:
        if (node["editable"] != (contract["kind"] == "input") or
                node["clickable"] != (contract["kind"] == "button")):
            fail("WEBVIEW_PLAN_CONTROL_INVALID")
    if contract["kind"] == "input" and not (contract["tag"] == "textarea" or
            contract["tag"] == "input" and contract.get("type") in {"text", "search", "email", "tel", "url"}):
        fail("WEBVIEW_PLAN_INPUT_KIND_UNSUPPORTED")
    if contract["kind"] == "button" and not (contract["tag"] == "button" or
            contract["tag"] == "input" and contract.get("type") in {"button", "submit"}):
        fail("WEBVIEW_PLAN_BUTTON_KIND_UNSUPPORTED")
    if contract["kind"] == "output" and contract["tag"] not in {"output", "div", "p", "span"}:
        fail("WEBVIEW_PLAN_OUTPUT_KIND_UNSUPPORTED")
    result = {"selector": {"resourceId": contract["selector"]}, "domContract": copy.deepcopy(contract),
              "className": node["className"], "accessibilityId": node.get("accessibilityId", ""),
              "inputType": node.get("inputType", ""), **{key: node[key] for key in FLAGS}}
    if not all(isinstance(result[key], str) and len(result[key]) <= 512 for key in ("accessibilityId", "inputType")):
        fail("WEBVIEW_PLAN_CONTROL_INVALID")
    # Output/input text and _input* evidence never become a persisted contract.
    if contract["kind"] == "button":
        if not isinstance(node.get("text"), str) or len(node["text"]) > 512:
            fail("WEBVIEW_PLAN_CONTROL_INVALID")
        result["buttonText"] = node["text"]
    return result


def _tree_contract(session, tree):
    if not isinstance(tree, dict) or not isinstance(tree.get("nodes"), list) or not 1 <= len(tree["nodes"]) <= 512:
        fail("WEBVIEW_PLAN_TREE_INVALID")
    identity = _identity(session, tree.get("sourceIdentity"))
    if tree.get("modality") != MODALITY or not isinstance(tree.get("sourceRevision"), str) or not FP.fullmatch(tree["sourceRevision"]):
        fail("WEBVIEW_PLAN_SOURCE_INVALID")
    controls = [_control(node) for node in tree["nodes"]]
    selectors = [row["selector"]["resourceId"] for row in controls]
    if len(set(selectors)) != len(selectors):
        fail("WEBVIEW_PLAN_LOCATOR_AMBIGUOUS")
    expected_revision = digest({"sourceIdentity": identity,
                                "contracts": {row["selector"]["resourceId"]: row["domContract"] for row in controls}})
    if expected_revision != tree["sourceRevision"]:
        fail("WEBVIEW_PLAN_SOURCE_REVISION_INVALID")
    groups = {row["domContract"]["selector"]: row for row in controls if row["domContract"]["kind"] == "group"}
    for row in controls:
        contract = row["domContract"]
        group = contract.get("groupSelector")
        if group is not None:
            owner = groups.get(group, {}).get("domContract", {})
            if owner.get("id") != contract["groupId"] or owner.get("tag") != contract["groupTag"]:
                fail("WEBVIEW_PLAN_GROUP_NOT_OBSERVED")
            if contract.get("formId") is not None and contract["kind"] in {"input", "button"}:
                if contract["formId"] != owner["id"] or owner["tag"] != "form":
                    fail("WEBVIEW_PLAN_FORM_OWNER_MISMATCH")
    return {"schemaVersion": 1, "planningMode": MODE, "sourceIdentity": identity,
            "sourceRevision": tree["sourceRevision"],
            "controls": sorted(controls, key=lambda row: row["selector"]["resourceId"])}


def _validate_plan(session, plan):
    if (not isinstance(plan, dict) or set(plan) != {"schemaVersion", "planningMode", "sourceIdentity", "sourceRevision", "controls"} or
            plan.get("schemaVersion") != 1 or plan.get("planningMode") != MODE or
            not isinstance(plan.get("controls"), list) or not 1 <= len(plan["controls"]) <= 512):
        fail("WEBVIEW_PLAN_INVALID")
    _identity(session, plan.get("sourceIdentity"))
    if not isinstance(plan.get("sourceRevision"), str) or not FP.fullmatch(plan["sourceRevision"]):
        fail("WEBVIEW_PLAN_INVALID")
    # Reconstruct only stable semantic fields and re-use the same validator.
    nodes = []
    for row in plan["controls"]:
        if not isinstance(row, dict) or set(row) - {"selector", "domContract", "className", "accessibilityId", "inputType", *FLAGS, "buttonText"}:
            fail("WEBVIEW_PLAN_INVALID")
        wanted = row.get("selector")
        if not isinstance(wanted, dict) or set(wanted) != {"resourceId"}:
            fail("WEBVIEW_PLAN_INVALID")
        nodes.append({**row, "resourceId": wanted["resourceId"], "text": row.get("buttonText", "")})
    actual = _tree_contract(session, {"nodes": nodes, "sourceIdentity": plan["sourceIdentity"],
                                    "sourceRevision": plan["sourceRevision"], "modality": MODALITY})
    if actual != plan:
        fail("WEBVIEW_PLAN_INVALID")
    return copy.deepcopy(plan)


def _name(selector, used):
    name = re.sub(r"[^A-Za-z0-9_]", "_", selector[1:]).strip("_")[:40] or "input"
    if not name[0].isalpha() or name in {"constructor", "prototype", "__proto__"}:
        name = "field_" + name
    value, number = name, 2
    while value in used:
        value, number = name + "_" + str(number), number + 1
    used.add(value)
    return value


def plan_tree(session, tree, **unused):
    """Return a secret-free public catalog and separate stable private specs."""
    try:
        plan = _tree_contract(session, tree)
    except MobileError as error:
        return {"schemaVersion": 1, "source": {**session.source, "revision": digest([session.identity, error.code])},
                "items": [], "specs": {}, "total": 0, "nextOffset": None, "truncated": False, "gaps": [error.code]}
    groups, outputs, gaps, blocked = {}, [], set(), set()
    for row in plan["controls"]:
        node = row["domContract"]
        if node["kind"] == "group":
            continue
        group = node["groupSelector"]
        eligible = row["enabled"] and row["visible"] and not row["secure"] and not row["readOnly"]
        if node["kind"] == "input":
            if eligible and session.policy({"kind": "type", "selector": row["selector"]}) == (True, "read"):
                groups.setdefault(group, {"inputs": [], "buttons": []})["inputs"].append(row)
            else:
                blocked.add(group)
                gaps.add("webview_group_has_unapproved_or_unavailable_input")
        elif node["kind"] == "button":
            if eligible and session.policy({"kind": "click", "selector": row["selector"]}) == (True, "read"):
                groups.setdefault(group, {"inputs": [], "buttons": []})["buttons"].append(row)
            else:
                gaps.add("webview_button_requires_read_allowlist")
        elif node["kind"] == "output" and eligible and not row["editable"] and not row["clickable"]:
            outputs.append(row)
        else:
            gaps.add("webview_control_kind_or_state_unsupported")
            if row["editable"]:
                blocked.add(group)
    items, specs = [], {}
    for group, rows in sorted(groups.items()):
        if group in blocked or not 1 <= len(rows["inputs"]) <= 16:
            continue
        for button in rows["buttons"][:20]:
            ident = "mobile_plan_" + digest([session.source, plan, group, button["selector"]])
            targets = [{"id": "output_" + digest([ident, row["selector"]]), "kind": "text", "selector": row["selector"]}
                       for row in outputs[:12]]
            properties, steps, used = {}, [], set()
            for row in rows["inputs"]:
                key = _name(row["selector"]["resourceId"], used)
                properties[key] = {"type": "string", "maxLength": 2048}
                steps.append({"kind": "type", "selector": row["selector"], "input": key, "replace": True})
            steps.append({"kind": "click", "selector": button["selector"]})
            schema = {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}
            local = {"two_distinct_samples_required", "all_parameters_require_fresh_result_association",
                     "webview_output_association_not_yet_observed", "business_constraints_not_observed",
                     "single_document_linear_type_click_only", "worker_local_document_reference_identity_only",
                     "configured_controls_are_not_exhaustive_page_exploration"}
            if not targets:
                local.add("webview_result_target_missing")
            specs[ident] = {"schemaVersion": 1, "id": "webview_query_" + digest([plan, group, button["selector"]])[:40],
                            "name": "WebView查询流程", "effect": "read", "inputSchema": schema,
                            "steps": steps, "outcomeCandidates": targets, "webviewPlan": plan}
            items.append({"id": ident, "name": "WebView查询候选", "kind": "mobile_workflow", "planningMode": MODE,
                          "readiness": "candidate", "effect": "unknown", "inputSchema": schema,
                          "outputTargets": [{"id": row["id"], "kind": "text", "label": "结果区域"} for row in targets],
                          "evidence": {"parameterizationValidated": False, "grouping": "observed_unique_dom_ancestor_and_form_owner",
                                       "controlScope": "observed_trusted_configured_controls",
                                       "documentIdentityScope": "fresh_worker_attach_then_live_reference_equality_within_worker"},
                          "gaps": sorted(local)})
    gaps.update(code for code in tree.get("gaps", []) if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", code))
    truncated = len(items) > 100
    items = items[:100]
    specs = {item["id"]: specs[item["id"]] for item in items}
    while items and (len(json.dumps(items, ensure_ascii=False).encode()) > 98304 or
                     len(json.dumps(specs, ensure_ascii=False).encode()) > 524288):
        specs.pop(items.pop()["id"])
        truncated = True
    return {"schemaVersion": 1, "source": {**session.source, "revision": digest([session.identity, items, specs])},
            "items": items, "specs": specs, "total": len(items), "nextOffset": None,
            "truncated": truncated, "gaps": sorted(gaps)}


def _definition(session, definition):
    if not isinstance(definition, dict) or "webviewPlan" not in definition:
        fail("WEBVIEW_WORKFLOW_PLAN_REQUIRED")
    plan = _validate_plan(session, definition["webviewPlan"])
    clean = {key: copy.deepcopy(value) for key, value in definition.items() if key != "webviewPlan"}
    if clean.get("effect") != "read" or any(key in clean for key in ("entryPrefix", "stagePlan", "branchPlan")):
        fail("WEBVIEW_WORKFLOW_SCOPE_UNSUPPORTED")
    clean = linear.definition_contract(session, clean)
    if any(spec.get("type") != "string" for spec in clean["inputSchema"]["properties"].values()):
        fail("WEBVIEW_WORKFLOW_INPUT_KIND_UNSUPPORTED")
    controls = {row["selector"]["resourceId"]: row for row in plan["controls"]}
    inputs, clicks, extracts, related, action_finished = [], [], [], set(), False
    for number, step in enumerate(clean["steps"]):
        if step["kind"] not in {"type", "click", "assert", "extract"} or set(step["selector"]) != {"resourceId"}:
            fail("WEBVIEW_WORKFLOW_STEP_UNSUPPORTED")
        row = controls.get(step["selector"]["resourceId"])
        if row is None or not row["enabled"] or not row["visible"] or row["secure"] or row["readOnly"]:
            fail("WEBVIEW_WORKFLOW_CONTROL_NOT_OBSERVED")
        kind = row["domContract"]["kind"]
        if step["kind"] == "type":
            if action_finished or kind != "input" or clicks:
                fail("WEBVIEW_WORKFLOW_LINEAR_ORDER_REQUIRED")
            inputs.append((step, row))
        elif step["kind"] == "click":
            if action_finished or kind != "button" or clicks:
                fail("WEBVIEW_WORKFLOW_LINEAR_ORDER_REQUIRED")
            clicks.append((step, row))
            action_finished = True
        else:
            if not action_finished or kind != "output" or row["editable"] or row["clickable"]:
                fail("WEBVIEW_WORKFLOW_OUTPUT_NOT_OBSERVED")
            if step["kind"] == "extract":
                extracts.append((number, step))
    if not inputs or len(clicks) != 1 or not extracts:
        fail("WEBVIEW_WORKFLOW_LINEAR_ORDER_REQUIRED")
    if (len({step["input"] for step, _ in inputs}) != len(inputs) or
            len({row["selector"]["resourceId"] for _, row in inputs}) != len(inputs)):
        fail("WEBVIEW_WORKFLOW_DUPLICATE_INPUT")
    group = clicks[0][1]["domContract"]["groupSelector"]
    if group is None or any(row["domContract"]["groupSelector"] != group for _, row in inputs):
        fail("WEBVIEW_WORKFLOW_GROUP_MISMATCH")
    for number, extract in extracts:
        assertions = [step for step in clean["steps"][:number] if step["kind"] == "assert" and step["selector"] == extract["selector"]]
        if not assertions or any(step["expect"].get("changed") is not True or
                                 not any(key in step["expect"] for key in ("equalsInput", "containsInput"))
                                 for step in assertions):
            fail("WEBVIEW_WORKFLOW_FRESH_INPUT_RESULT_REQUIRED")
        for assertion in assertions:
            related.update(assertion["expect"][key] for key in ("equalsInput", "containsInput") if key in assertion["expect"])
    if related != set(clean["inputSchema"]["properties"]):
        fail("WEBVIEW_WORKFLOW_ALL_INPUT_RESULTS_REQUIRED")
    return clean, plan


class _PinnedBackend:
    def __init__(self, backend, session, plan, definition):
        object.__setattr__(self, "_backend", backend)
        object.__setattr__(self, "_session", session)
        object.__setattr__(self, "_plan", plan)
        object.__setattr__(self, "_bindings", [copy.deepcopy(step) for step in definition["steps"] if step["kind"] == "type"])

    def __getattr__(self, key):
        return getattr(self._backend, key)

    def __setattr__(self, key, value):
        setattr(self._backend, key, value)

    def __delattr__(self, key):
        delattr(self._backend, key)

    def guard(self, tree):
        self._session.budget.check()
        if _tree_contract(self._session, tree) != self._plan:
            fail("WEBVIEW_WORKFLOW_DOM_CONTRACT_CHANGED")
        self._session.budget.check()
        return tree

    def observe(self, *args, **kwargs):
        return self.guard(self._backend.observe(*args, **kwargs))

    def verify_inputs(self, tree, inputs):
        self.guard(tree)
        for step in self._bindings:
            node = locate(tree, step["selector"])
            value = inputs.get(step["input"])
            if (not isinstance(value, str) or node.get("_inputValuePresent") is not True or
                    node.get("_inputPlaceholderOnly") or
                    node.get("_inputSha256") != hashlib.sha256(value.encode("utf-8")).hexdigest()):
                fail("WEBVIEW_WORKFLOW_INPUT_STATE_CHANGED")

    def perform(self, action, tree, inputs):
        self.guard(tree)
        if action["kind"] == "click":
            self.verify_inputs(tree, inputs)
            if getattr(self._backend, "_before_workflow_click", None) is not self._click_guard:
                fail("WEBVIEW_WORKFLOW_CLICK_GUARD_CHANGED")
        return self._backend.perform(action, tree, inputs)


@contextmanager
def _bound_backend(session, plan, definition):
    original = session.backend
    guarded = _PinnedBackend(original, session, plan, definition)
    missing = object()
    previous = getattr(original, "_before_workflow_click", missing)
    if previous is not missing and previous is not None and not callable(previous):
        fail("WEBVIEW_WORKFLOW_CLICK_GUARD_INVALID")

    def before_click(tree, inputs):
        # This callback is invoked on the backend's newest full DOM read, after
        # its final observe and before the durable click intent/dispatch.
        guarded.verify_inputs(tree, inputs)
        if previous is not missing and previous is not None:
            previous(tree, inputs)
        session.event("webview_inputs_reverified", parameters=len(guarded._bindings))

    object.__setattr__(guarded, "_click_guard", before_click)
    original._before_workflow_click = before_click
    session.backend = guarded
    try:
        yield
    finally:
        session.backend = original
        if previous is missing:
            del original._before_workflow_click
        else:
            original._before_workflow_click = previous


def _inputs(session, schema, values):
    linear.validate_inputs(schema, values)
    if set(values) != set(schema["properties"]):
        fail("WORKFLOW_INPUT_INVALID")
    validator = getattr(session.backend, "validate_literal_inputs", None)
    if not callable(validator):
        fail("WEBVIEW_INPUT_VALIDATOR_REQUIRED")
    validator({key: linear.input_text(value) for key, value in values.items()})


def _freshness(result):
    outputs = result.get("outputs", {})
    if not outputs or any(not isinstance(row, dict) or row.get("changedSinceStart") is not True or row.get("inputCorrelated") is not True
                          for row in outputs.values()):
        fail("WEBVIEW_WORKFLOW_OUTPUT_FRESHNESS_UNVERIFIED")


def learn_workflow(session, definition, samples):
    clean, plan = _definition(session, definition)
    if not isinstance(samples, list) or not 2 <= len(samples) <= 5:
        fail("WORKFLOW_REQUIRES_TWO_SAMPLES")
    for sample in samples:
        _inputs(session, clean["inputSchema"], sample)
    if len({digest(sample) for sample in samples}) < 2:
        fail("WORKFLOW_REQUIRES_DIFFERENT_INPUTS")
    old_caps, old_recipes = copy.deepcopy(session.progress["capabilities"]), copy.deepcopy(session.progress["recipes"])
    try:
        with session.execution(), _bound_backend(session, plan, clean):
            # execution owns the canonical transport lease before the first
            # probe. Calling linear.learn_workflow here would acquire another
            # flock FD and would probe before that inner lock. Reuse its actual
            # step engine, while keeping only orchestration local to WebView.
            session.features = session.backend.probe()
            session.progress["status"] = "running"
            contracts, evidence, outputs = [None] * len(clean["steps"]), [], []
            for number, values in enumerate(samples):
                observed = linear._run(session, clean, values, contracts)
                _freshness(observed["resultFreshness"])
                outputs.append(observed["outputs"])
                evidence.append({"sample": number, "assertionsPassed": observed["assertionsPassed"],
                                 "resultFreshness": observed["resultFreshness"], "evidenceIds": observed["evidenceIds"]})
            if len({digest(value) for value in outputs}) < 2:
                fail("WORKFLOW_REQUIRES_RESULT_VARIATION")
            capability_id = "mobile_workflow_" + digest([session.source["id"], clean["id"]])
            learning = {"sampleCount": len(samples), "distinctInputSamples": len({digest(value) for value in samples}),
                        "distinctResultSamples": len({digest(value) for value in outputs}), "samples": evidence}
            recipe = {"schemaVersion": 1, "recipeType": "webview_workflow", "sourceId": session.source["id"],
                      "identity": session.identity, "capabilityId": capability_id, "definition": clean,
                      "controlContracts": contracts, "learningEvidence": learning, "webviewPlan": copy.deepcopy(plan)}
            recipe["revision"] = digest(recipe)
            output_schema = {"type": "object", "properties": {step["output"]: {"type": step.get("valueType", "string")}
                             for step in clean["steps"] if step["kind"] == "extract"}, "additionalProperties": False}
            cap = {"id": capability_id, "name": "WebView查询流程", "description": "在已观察的受信文档合同内输入、查询并核对结果。",
                   "kind": "mobile", "readiness": "ready", "effect": "read", "revision": recipe["revision"],
                   "inputSchema": clean["inputSchema"], "outputSchema": output_schema,
                   "evidence": {"workflowObserved": True, "sampleCount": len(samples), "differentInputsObserved": True,
                                "resultVariationObserved": True, "controlContractsVerified": True, "networkObserved": False,
                                "assertionsPerSample": evidence[0]["assertionsPassed"], "resultFreshness": evidence[0]["resultFreshness"],
                                "webviewDomObserved": True, "nativeSemanticObserved": False,
                                "documentIdentityScope": "fresh_worker_attach_then_live_reference_equality_within_worker"},
                   "gaps": ["configured_ui_assertions_do_not_prove_arbitrary_business_semantics",
                            "webview_provider_echo_not_hidden_application_buffer", "worker_local_document_identity_only"]}
            session.progress["recipes"][capability_id], session.progress["capabilities"][capability_id] = recipe, cap
            session.progress["status"] = "completed"
            session.checkpoint()
            result = {"ok": True, "status": "completed", "capabilityId": capability_id, "revision": recipe["revision"],
                      "sampleCount": len(samples), "resultVariationObserved": True, "inputsPersisted": False,
                      "networkObserved": False, "modality": MODALITY, "automaticRetry": False}
        return result
    except BaseException:
        session.progress["capabilities"], session.progress["recipes"] = old_caps, old_recipes
        try:
            session.checkpoint()
        except (MobileError, OSError):
            pass
        raise


def execute_workflow(session, recipe, revision, inputs):
    if (not isinstance(recipe, dict) or recipe.get("schemaVersion") != 1 or recipe.get("recipeType") != "webview_workflow" or
            recipe.get("identity") != session.identity or recipe.get("sourceId") != session.source["id"]):
        fail("RECIPE_IDENTITY_MISMATCH")
    if revision != recipe.get("revision") or digest({key: value for key, value in recipe.items() if key != "revision"}) != revision:
        fail("RECIPE_REVISION_MISMATCH")
    if not isinstance(recipe.get("definition"), dict):
        fail("WEBVIEW_WORKFLOW_PLAN_REQUIRED")
    clean, plan = _definition(session, {**recipe["definition"], "webviewPlan": recipe.get("webviewPlan")})
    if recipe.get("capabilityId") != "mobile_workflow_" + digest([session.source["id"], clean["id"]]):
        fail("RECIPE_IDENTITY_MISMATCH")
    _inputs(session, clean["inputSchema"], inputs)
    learning = recipe.get("learningEvidence", {})
    if (learning.get("sampleCount", 0) < 2 or learning.get("distinctInputSamples", 0) < 2 or
            learning.get("distinctResultSamples", 0) < 2):
        fail("WORKFLOW_NOT_OBSERVED_WITH_VARIATION")
    contracts = copy.deepcopy(recipe.get("controlContracts"))
    if not isinstance(contracts, list) or len(contracts) != len(clean["steps"]) or any(not isinstance(row, dict) for row in contracts):
        fail("WORKFLOW_CONTROL_CONTRACT_MISSING")
    with session.execution(), _bound_backend(session, plan, clean):
        session.features = session.backend.probe()
        session.progress["status"] = "running"
        result = linear._run(session, clean, inputs, contracts)
        _freshness(result["resultFreshness"])
        session.progress["status"] = "completed"
        session.checkpoint()
        return {"ok": True, "status": "completed", "capabilityId": recipe["capabilityId"], "revision": revision,
                **result, "executionObserved": bool(result["actionsPerformed"]), "networkObserved": False,
                "modality": MODALITY, "automaticRetry": False,
                "gaps": ["configured_ui_assertions_only", "network_scope_not_enforced"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--inventory", type=Path)
    args = parser.parse_args(argv)
    try:
        from .mobile_webview import WebViewSession
        session = WebViewSession(read_json(args.config), args.output)
        with DeviceLease(session.backend):
            session.features = session.backend.probe()
            plan = plan_tree(session, session.backend.observe())
        if args.inventory is not None:
            plan["gaps"] = sorted(set(plan["gaps"]) | {"webview_historical_prefix_not_supported"})
        atomic_json(args.output / "plan.private.json", plan)
        result = {"ok": True, **{key: value for key, value in plan.items() if key != "specs"}}
        atomic_json(args.output / "result.json", result)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (MobileError, OSError, ValueError, TypeError, KeyError) as error:
        result = {"ok": False, "error": {"code": error.code if isinstance(error, MobileError) else "WEBVIEW_PLAN_FAILED"}, "automaticRetry": False}
        atomic_json(args.output / "result.json", result)
        print(json.dumps(result))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
