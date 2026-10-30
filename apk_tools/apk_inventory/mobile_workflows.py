"""Trusted, parameterized native UI workflows with observed sample evidence.

No eval, scripts, arbitrary locators, network commands, or captured-input replay.
Only the deliberately small JSON Schema and assertion subset below is accepted.
"""
from __future__ import annotations

import copy
import math
import re
import time
import uuid

from .mobile_ui import (DeviceLease, MobileError, atomic_json, check_target, check_value,
                        digest, locate, safe_text, selector, selection_selector,
                        selection_state, select_value)

NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}")
SECRET = re.compile(r"password|passwd|token|secret|authorization|cookie|api.?key", re.I)


def workflow_permissions(config):
    permissions = config.get("workflowPermissions", {})
    if not isinstance(permissions, dict) or set(permissions) - {"allowWrite", "allowWriteLearning"}:
        raise MobileError("WORKFLOW_PERMISSIONS_INVALID", "blocked")
    checked = {}
    for key in ("allowWrite", "allowWriteLearning"):
        values = permissions.get(key, [])
        if not isinstance(values, list) or len(values) > 1000 or any(not isinstance(value, str) or not NAME.fullmatch(value) for value in values) or len(set(values)) != len(values):
            raise MobileError("WORKFLOW_PERMISSIONS_INVALID", "blocked")
        checked[key] = set(values)
    if not checked["allowWriteLearning"] <= checked["allowWrite"]:
        raise MobileError("WORKFLOW_PERMISSIONS_INVALID", "blocked")
    return checked


def approve_workflow(session, definition, learning=False):
    permissions = workflow_permissions(session.config)
    if definition["effect"] == "write":
        if definition["id"] not in permissions["allowWrite"]:
            raise MobileError("WORKFLOW_WRITE_NOT_APPROVED", "blocked")
        if learning and definition["id"] not in permissions["allowWriteLearning"]:
            raise MobileError("WORKFLOW_WRITE_LEARNING_NOT_APPROVED", "blocked")


def _with_write_outcome(session, definition, operation):
    if not isinstance(definition, dict) or definition.get("effect") != "write":
        return operation()
    attempted = False
    previous = getattr(session.backend, "_before_workflow_ui_command", None)
    outcome = lambda status: {"status": status, "automaticRetry": False}
    session.progress["writeOutcome"] = outcome("not_started")

    def before_command():
        nonlocal attempted
        session.budget.check()
        try:
            # Persist before dispatch. If persistence fails, the command cannot
            # run; a killed worker's owner can conservatively recover unknown.
            atomic_json(session.output / "write-intent.json", {"effect": "write", **outcome("unknown")})
        except (OSError, MobileError):
            raise MobileError("WORKFLOW_WRITE_INTENT_PERSIST_FAILED", "blocked") from None
        attempted = True
        session.progress["writeOutcome"] = outcome("unknown")
        if previous:
            previous()

    session.backend._before_workflow_ui_command = before_command
    try:
        result = operation()
        session.progress["writeOutcome"] = outcome("observed")
        session.checkpoint()
        return {**result, "writeOutcome": outcome("observed")}
    except Exception as error:
        state = outcome("unknown" if attempted else "not_started")
        session.progress["writeOutcome"] = state
        error.writeOutcome = state
        try:
            session.checkpoint()
        except (OSError, MobileError):
            pass
        raise
    finally:
        if previous is None:
            del session.backend._before_workflow_ui_command
        else:
            session.backend._before_workflow_ui_command = previous


def pattern(value):
    # One bounded repetition, no alternation/lookaround/backreference or nested
    # repeated groups. This supports result formats such as ^TOTAL:([0-9]+)$.
    if not isinstance(value, str) or not 2 <= len(value) <= 256 or not value.startswith("^") or not value.endswith("$") or "|" in value or "(?" in value or re.search(r"\\[1-9]|\)[*+?{]", value) or sum(value.count(c) for c in "+*?{") > 1:
        raise MobileError("WORKFLOW_PATTERN_UNSUPPORTED", "blocked")
    try:
        return re.compile(value)
    except re.error:
        raise MobileError("WORKFLOW_PATTERN_INVALID", "blocked") from None


def scalar_type(kind, value):
    return isinstance(value, str) if kind == "string" else isinstance(value, bool) if kind == "boolean" else isinstance(value, int) and not isinstance(value, bool) if kind == "integer" else isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def schema_contract(schema):
    top = {"type", "properties", "required", "additionalProperties", "title", "description", "$schema"}
    scalar = {"type", "minLength", "maxLength", "pattern", "enum", "const", "minimum", "maximum", "description", "title", "writeOnly"}
    if not isinstance(schema, dict) or set(schema) - top or schema.get("type") != "object" or schema.get("additionalProperties") is not False or not isinstance(schema.get("properties"), dict) or not 1 <= len(schema["properties"]) <= 16:
        raise MobileError("WORKFLOW_SCHEMA_UNSUPPORTED", "blocked")
    required = schema.get("required", [])
    if not isinstance(required, list) or len(set(required)) != len(required) or any(key not in schema["properties"] for key in required):
        raise MobileError("WORKFLOW_SCHEMA_UNSUPPORTED", "blocked")
    for key, spec in schema["properties"].items():
        if not NAME.fullmatch(key) or not isinstance(spec, dict) or set(spec) - scalar or spec.get("type") not in {"string", "integer", "number", "boolean"}:
            raise MobileError("WORKFLOW_SCHEMA_UNSUPPORTED", "blocked")
        if spec.get("type") == "string" and (not isinstance(spec.get("maxLength", 2048), int) or not 1 <= spec.get("maxLength", 2048) <= 2048 or not isinstance(spec.get("minLength", 0), int) or not 0 <= spec.get("minLength", 0) <= spec.get("maxLength", 2048)):
            raise MobileError("WORKFLOW_SCHEMA_UNSUPPORTED", "blocked")
        if "pattern" in spec:
            pattern(spec["pattern"])
        if "enum" in spec and (not isinstance(spec["enum"], list) or not 1 <= len(spec["enum"]) <= 20 or spec.get("writeOnly") is True or any(not scalar_type(spec["type"], value) for value in spec["enum"]) or len({digest(value) for value in spec["enum"]}) != len(spec["enum"])):
            raise MobileError("WORKFLOW_SCHEMA_UNSUPPORTED", "blocked")
        if "const" in spec and (not scalar_type(spec["type"], spec["const"]) or "enum" in spec and spec["const"] not in spec["enum"] or spec.get("writeOnly") is True):
            raise MobileError("WORKFLOW_SCHEMA_UNSUPPORTED", "blocked")
        if any(not isinstance(spec[n], (int, float)) or isinstance(spec[n], bool) or not math.isfinite(spec[n]) for n in ("minimum", "maximum") if n in spec):
            raise MobileError("WORKFLOW_SCHEMA_UNSUPPORTED", "blocked")
    return copy.deepcopy(schema)


def validate_inputs(schema, inputs):
    if not isinstance(inputs, dict) or set(inputs) - set(schema["properties"]) or any(key not in inputs for key in schema.get("required", [])):
        raise MobileError("WORKFLOW_INPUT_INVALID", "blocked")
    for key, value in inputs.items():
        spec = schema["properties"][key]
        kind = spec["type"]
        good = scalar_type(kind, value)
        if not good or "enum" in spec and value not in spec["enum"] or "const" in spec and value != spec["const"]:
            raise MobileError("WORKFLOW_INPUT_INVALID", "blocked")
        if isinstance(value, str) and (not spec.get("minLength", 0) <= len(value) <= spec.get("maxLength", 2048) or "pattern" in spec and not pattern(spec["pattern"]).fullmatch(value)):
            raise MobileError("WORKFLOW_INPUT_INVALID", "blocked")
        if kind in {"integer", "number"} and ("minimum" in spec and value < spec["minimum"] or "maximum" in spec and value > spec["maximum"]):
            raise MobileError("WORKFLOW_INPUT_INVALID", "blocked")
    return inputs


def definition_contract(session, definition):
    allowed = {"schemaVersion", "id", "name", "description", "inputSchema", "effect", "steps", "entryPrefix"}
    if not isinstance(definition, dict) or set(definition) - allowed or definition.get("schemaVersion") != 1 or not isinstance(definition.get("id"), str) or not NAME.fullmatch(definition["id"]) or definition.get("effect") not in {"read", "write"}:
        raise MobileError("WORKFLOW_DEFINITION_INVALID", "blocked")
    approve_workflow(session, definition)
    schema_contract(definition.get("inputSchema"))
    prefix = definition.get("entryPrefix")
    if prefix is not None:
        if not isinstance(prefix, dict) or set(prefix) - {"entryStateId", "targetStateId", "steps"} or not isinstance(prefix.get("steps"), list) or not 1 <= len(prefix["steps"]) <= 80:
            raise MobileError("WORKFLOW_PREFIX_INVALID", "blocked")
        valid_fp = lambda value: isinstance(value, str) and bool(re.fullmatch(r"[a-f0-9]{64}", value))
        if not valid_fp(prefix.get("entryStateId")) or not valid_fp(prefix.get("targetStateId")):
            raise MobileError("WORKFLOW_PREFIX_INVALID", "blocked")
        previous = prefix["entryStateId"]
        for recorded in prefix["steps"]:
            if not isinstance(recorded, dict) or set(recorded) - {"before", "after", "action", "executionId"} or recorded.get("before") != previous or not valid_fp(recorded.get("after")):
                raise MobileError("WORKFLOW_PREFIX_DISCONNECTED", "blocked")
            action = recorded.get("action")
            if not isinstance(action, dict) or set(action) - {"kind", "selector", "direction"} or action.get("kind") not in {"click", "swipe"}:
                raise MobileError("WORKFLOW_PREFIX_ACTION_INVALID", "blocked")
            selector(action.get("selector"))
            if session.policy(action) != (True, "read"):
                raise MobileError("WORKFLOW_PREFIX_NOT_READ_APPROVED", "blocked")
            if action["kind"] == "swipe" and action.get("direction", "up") not in {"up", "down", "left", "right"}:
                raise MobileError("WORKFLOW_PREFIX_ACTION_INVALID", "blocked")
            previous = recorded["after"]
        if previous != prefix["targetStateId"]:
            raise MobileError("WORKFLOW_PREFIX_DISCONNECTED", "blocked")
    steps = definition.get("steps")
    if not isinstance(steps, list) or not 3 <= len(steps) <= 30:
        raise MobileError("WORKFLOW_STEPS_INVALID", "blocked")
    outputs, assertions, used = set(), 0, set()
    for step in steps:
        if not isinstance(step, dict) or step.get("kind") not in {"type", "click", "swipe", "check", "select", "assert", "extract"}:
            raise MobileError("WORKFLOW_STEP_INVALID", "blocked")
        kind = step["kind"]
        keys = {"kind", "selector", "input", "replace"} if kind == "type" else {"kind", "selector", "input", "value", "timeoutMs"} if kind == "check" else {"kind", "selector", "input", "options", "timeoutMs"} if kind == "select" else {"kind", "selector", "direction"} if kind == "swipe" else {"kind", "selector"} if kind == "click" else {"kind", "selector", "expect", "timeoutMs"} if kind == "assert" else {"kind", "selector", "output", "pattern", "group", "valueType"}
        if set(step) - keys:
            raise MobileError("WORKFLOW_STEP_INVALID", "blocked")
        selector(step.get("selector"))
        if kind in {"type", "click", "swipe", "check", "select"}:
            allowed_action, effect = session.policy(step)
            if not allowed_action or effect not in ({"read"} if definition["effect"] == "read" else {"read", "write"}):
                raise MobileError("WORKFLOW_ACTION_NOT_READ_ALLOWLISTED" if definition["effect"] == "read" else "WORKFLOW_ACTION_NOT_ALLOWLISTED", "blocked")
        if kind == "type":
            if step.get("replace") is not True or step.get("input") not in definition["inputSchema"]["properties"]:
                raise MobileError("WORKFLOW_INPUT_BINDING_INVALID", "blocked")
            used.add(step["input"])
        elif kind == "check":
            if ("input" in step) == ("value" in step) or "value" in step and not isinstance(step["value"], bool) or "input" in step and (not isinstance(step["input"], str) or definition["inputSchema"]["properties"].get(step["input"], {}).get("type") != "boolean"):
                raise MobileError("WORKFLOW_CHECK_BINDING_INVALID", "blocked")
            timeout = step.get("timeoutMs", 1500)
            if not isinstance(timeout, int) or isinstance(timeout, bool) or not 0 <= timeout <= 10000:
                raise MobileError("WORKFLOW_CHECK_TIMEOUT_INVALID", "blocked")
            if "input" in step:
                used.add(step["input"])
        elif kind == "select":
            selection_selector(step["selector"])
            options, input_name = step.get("options"), step.get("input")
            input_spec = definition["inputSchema"]["properties"].get(input_name, {}) if isinstance(input_name, str) else {}
            if not isinstance(options, list) or not 2 <= len(options) <= 20 or input_spec.get("type") != "string" or not isinstance(input_spec.get("enum"), list):
                raise MobileError("WORKFLOW_SELECT_BINDING_INVALID", "blocked")
            values, selectors = [], []
            for option in options:
                if not isinstance(option, dict) or set(option) != {"value", "selector"} or not isinstance(option.get("value"), str) or not 1 <= len(option["value"]) <= 128:
                    raise MobileError("WORKFLOW_SELECT_OPTIONS_INVALID", "blocked")
                fixed = selection_selector(option["selector"])
                approved, option_effect = session.policy({"kind": "check", "selector": fixed})
                if not approved or option_effect not in ({"read"} if definition["effect"] == "read" else {"read", "write"}):
                    raise MobileError("WORKFLOW_SELECT_OPTION_NOT_ALLOWLISTED", "blocked")
                values.append(option["value"]);selectors.append(digest(fixed))
            if len(set(values)) != len(values) or len(set(selectors)) != len(selectors) or set(input_spec["enum"]) != set(values) or len(input_spec["enum"]) != len(values):
                raise MobileError("WORKFLOW_SELECT_DOMAIN_INVALID", "blocked")
            timeout = step.get("timeoutMs", 1500)
            if not isinstance(timeout, int) or isinstance(timeout, bool) or not 0 <= timeout <= 10000:
                raise MobileError("WORKFLOW_SELECT_TIMEOUT_INVALID", "blocked")
            used.add(input_name)
        elif kind == "swipe" and step.get("direction", "up") not in {"up", "down", "left", "right"}:
            raise MobileError("SWIPE_INVALID", "blocked")
        elif kind == "assert":
            expect = step.get("expect")
            timeout = step.get("timeoutMs", 3000)
            predicates = {"equals", "matches", "present", "equalsInput", "containsInput"}
            if not isinstance(expect, dict) or not expect or set(expect) - (predicates | {"changed"}) or len(set(expect) & predicates) > 1 or "changed" in expect and expect["changed"] is not True or not isinstance(timeout, int) or isinstance(timeout, bool) or not 0 <= timeout <= 10000:
                raise MobileError("WORKFLOW_ASSERTION_INVALID", "blocked")
            if "matches" in expect:
                pattern(expect["matches"])
            if "equals" in expect and (not isinstance(expect["equals"], str) or len(expect["equals"]) > 512) or "present" in expect and expect["present"] is not True:
                raise MobileError("WORKFLOW_ASSERTION_INVALID", "blocked")
            for key in ("equalsInput", "containsInput"):
                if key in expect and (not isinstance(expect[key], str) or expect[key] not in definition["inputSchema"]["properties"]):
                    raise MobileError("WORKFLOW_ASSERTION_INPUT_INVALID", "blocked")
            assertions += 1
        elif kind == "extract":
            name = step.get("output")
            if not isinstance(name, str) or not NAME.fullmatch(name) or name in outputs or step.get("valueType", "string") not in {"string", "integer", "number", "boolean"}:
                raise MobileError("WORKFLOW_EXTRACTION_INVALID", "blocked")
            regex = pattern(step["pattern"]) if "pattern" in step else None
            group = step.get("group", 0)
            if not isinstance(group, int) or isinstance(group, bool) or group < 0 or group > (regex.groups if regex else 0):
                raise MobileError("WORKFLOW_EXTRACTION_INVALID", "blocked")
            outputs.add(name)
    if not outputs or not assertions or used != set(definition["inputSchema"]["properties"]):
        raise MobileError("WORKFLOW_REQUIRES_BOUND_INPUT_ASSERTION_AND_OUTPUT", "blocked")
    return copy.deepcopy(definition)


def scrub_outputs(schema, inputs, outputs):
    secrets = [str(value) for key, value in inputs.items() if schema["properties"][key].get("writeOnly") is True or SECRET.search(key)]
    result = {}
    for key, value in outputs.items():
        if SECRET.search(key):
            result[key] = "[REDACTED]"
        elif isinstance(value, str):
            for secret in secrets:
                if secret:
                    value = value.replace(secret, "[REDACTED]")
            result[key] = safe_text(value, 512)
        elif any(str(value) == secret for secret in secrets):
            result[key] = "[REDACTED]"
        else:
            result[key] = value
    return result


def control_contract(node, kind):
    fields = ("className", "resourceId", "accessibilityId", "secure", "editable")
    result = {key: node.get(key) for key in fields}
    if kind == "click":
        result["text"] = node["text"]
    if kind == "type":
        result["inputType"] = node.get("inputType", "")
        result["readOnly"] = node.get("readOnly", False)
    if kind == "check":
        result.update({key: node.get(key) for key in ("checkKind", "checkable", "readOnly")})
    if kind == "swipe":
        result["scrollable"] = node["scrollable"]
    return result


def contract_node(contracts, number, node, kind):
    actual = control_contract(node, kind)
    if contracts[number] is None:
        contracts[number] = actual
    elif contracts[number] != actual:
        raise MobileError("WORKFLOW_CONTROL_CONTRACT_CHANGED", "blocked")
    return node


def contract_selection(contracts, number, state):
    if contracts[number] is None:
        contracts[number] = state["contract"]
    elif contracts[number] != state["contract"]:
        raise MobileError("WORKFLOW_SELECTION_CONTRACT_CHANGED", "blocked")
    return state


def input_text(value):
    return str(value).lower() if isinstance(value, bool) else str(value)


def assertion_matches(expect, text, bound, baseline=None):
    """All configured conditions must hold; format alone is not freshness."""
    matches = ("equals" not in expect or text == expect["equals"])
    matches = matches and ("matches" not in expect or bool(pattern(expect["matches"]).fullmatch(text)))
    matches = matches and ("equalsInput" not in expect or text == bound[expect["equalsInput"]])
    matches = matches and ("containsInput" not in expect or bound[expect["containsInput"]] in text)
    if expect.get("changed") is True:
        matches = matches and baseline is not None and (not baseline["present"] or text != baseline["text"])
    return matches


def _run(session, definition, inputs, contracts):
    outputs, assertions, evidence = {}, 0, []
    prefix = definition.get("entryPrefix")
    if prefix is not None:
        session.budget.check()
        session.progress["entry"] = prefix["entryStateId"]
        reached = session.reach(prefix["steps"])
        session.budget.check()
        if reached["fingerprint"] != prefix["targetStateId"]:
            raise MobileError("WORKFLOW_PREFIX_TARGET_CHANGED", "blocked")
        evidence.append(session.event("workflow_prefix_verified", workflowId=definition["id"], stateId=prefix["targetStateId"], steps=len(prefix["steps"])))
    bound = {key: input_text(value) for key, value in inputs.items()}
    for step in definition["steps"]:
        if step["kind"] == "assert" and any(step["expect"].get(key) not in bound for key in ("equalsInput", "containsInput") if key in step["expect"]):
            raise MobileError("WORKFLOW_INPUT_INVALID", "blocked")
    controls = [(number, step) for number, step in enumerate(definition["steps"]) if step["kind"] in {"check", "select"}]
    if controls:
        # Validate all boolean controls before any mutable workflow action.
        # Controls introduced only by later write actions are not guessed.
        check_tree = session.backend.observe()
        session.budget.check()
        for number, step in controls:
            if step["kind"] == "select":
                contract_selection(contracts, number, selection_state(check_tree, step))
                select_value(step, inputs)
            else:
                node = contract_node(contracts, number, locate(check_tree, step["selector"]), "check")
                check_value(step, node, inputs)
    # Capture changed-target baselines before *any* input or click in this run.
    # A type handler may already launch a query; capturing only before assert
    # would mistake a completed new result for the baseline.
    baselines = {}
    changed = [(number, step) for number, step in enumerate(definition["steps"]) if step["kind"] == "assert" and step["expect"].get("changed") is True]
    if changed:
        tree = session.backend.observe()
        session.budget.check()
        for number, step in changed:
            try:
                node = contract_node(contracts, number, locate(tree, step["selector"]), "assert")
                if node["editable"] or node["secure"]:
                    raise MobileError("WORKFLOW_FRESHNESS_TARGET_INVALID", "blocked")
                baselines[number] = {"present": True, "text": node["text"]}
            except MobileError as error:
                if error.code != "SELECTOR_NOT_FOUND":
                    raise
                baselines[number] = {"present": False}
            evidence.append(session.event("workflow_freshness_baseline", workflowId=definition["id"], step=number, baselinePresent=baselines[number]["present"]))
    observed_assertions, output_freshness, guarded_outputs, generation = {}, {}, [], 0
    changed_count, correlated_count, actions_performed = 0, 0, 0
    check_observations = {"changed": 0, "noOp": 0}
    select_observations = {"changed": 0, "noOp": 0}
    for number, step in enumerate(definition["steps"]):
        session.budget.check()
        kind = step["kind"]
        if kind in {"type", "click", "swipe", "check", "select"}:
            tree = session.backend.observe()
            session.budget.check()
            if kind == "select":
                selection = contract_selection(contracts, number, selection_state(tree, step))
                target = locate(tree, step["selector"])
            else:
                target = contract_node(contracts, number, locate(tree, step["selector"]), kind)
            check_target(kind, target)
            unchanged = kind == "check" and target["checked"] == check_value(step, target, inputs) or kind == "select" and selection["selected"] == select_value(step, inputs)
            if unchanged:
                verified = session.backend.perform(step, tree, inputs)
                session.budget.check()
                if verified.get("commandPerformed") is not False:
                    raise MobileError("CONTROL_NOOP_COMMAND_UNEXPECTED", "blocked")
                (check_observations if kind == "check" else select_observations)["noOp"] += 1
                evidence.append(session.event("workflow_" + kind + "_state_verified", workflowId=definition["id"], step=number, commandPerformed=False))
                continue
            session.budget.action()
            execution_id = "execution_" + uuid.uuid4().hex
            started = session.event("workflow_action_started", workflowId=definition["id"], step=number, actionKind=kind, executionId=execution_id)
            session.progress["pending"] = {"executionId": execution_id, "workflowId": definition["id"], "step": number, "startedEvidenceId": started}
            session.checkpoint()
            try:
                session.backend.perform(step, tree, inputs if kind in {"check", "select"} else bound)
                session.budget.check()
                # Each subsequent phase obtains its own fresh UI source. A
                # post-action read immediately discarded before that phase only
                # duplicates uiautomator work. Keep a final-action observation
                # when there is no next phase to verify readability.
                post_observed = kind in {"check", "select"} or number == len(definition["steps"]) - 1
                if post_observed and kind not in {"check", "select"}:
                    session.backend.observe()
                    session.budget.check()
            except MobileError as error:
                session.event("workflow_action_uncertain", executionId=execution_id, code=error.code)
                raise
            finished = session.event("workflow_action_finished", executionId=execution_id, workflowId=definition["id"], step=number, status="observed" if post_observed else "command_completed")
            evidence.extend([started, finished])
            session.progress["pending"] = None
            session.checkpoint()
            generation += 1
            actions_performed += 1
            if kind == "check":
                check_observations["changed"] += 1
            if kind == "select":
                select_observations["changed"] += 1
        elif kind == "assert":
            deadline = time.monotonic() + step.get("timeoutMs", 3000) / 1000
            while True:
                session.budget.check()
                try:
                    node = contract_node(contracts, number, locate(session.backend.observe(), step["selector"]), kind)
                    session.budget.check()
                    expect = step["expect"]
                    guarded = expect.get("changed") is True or "equalsInput" in expect or "containsInput" in expect
                    if guarded and (node["editable"] or node["secure"]):
                        raise MobileError("WORKFLOW_FRESHNESS_TARGET_INVALID", "blocked")
                    matches = assertion_matches(expect, node["text"], bound, baselines.get(number))
                    if matches:
                        assertions += 1
                        changed_observed = expect.get("changed") is True
                        correlated = "equalsInput" in expect or "containsInput" in expect
                        changed_count += int(changed_observed)
                        correlated_count += int(correlated)
                        observed_assertions[digest(step["selector"])] = {"text": node["text"], "generation": generation, "changedSinceStart": changed_observed, "inputCorrelated": correlated, "guarded": guarded}
                        evidence.append(session.event("workflow_assertion_passed", workflowId=definition["id"], step=number, changedSinceStart=changed_observed, inputCorrelated=correlated))
                        break
                except MobileError as error:
                    if error.code != "SELECTOR_NOT_FOUND":
                        raise
                if time.monotonic() >= deadline:
                    raise MobileError("WORKFLOW_FRESHNESS_NOT_OBSERVED" if step["expect"].get("changed") is True else "WORKFLOW_ASSERTION_FAILED", "blocked")
                time.sleep(min(.05, max(0, deadline - time.monotonic())))
        else:
            node = contract_node(contracts, number, locate(session.backend.observe(), step["selector"]), kind)
            session.budget.check()
            if node["editable"] or node["secure"]:
                raise MobileError("WORKFLOW_INPUT_EXTRACTION_REJECTED", "blocked")
            text = node["text"]
            observed = observed_assertions.get(digest(step["selector"]))
            if observed and observed["guarded"] and (observed["generation"] != generation or observed["text"] != text):
                raise MobileError("WORKFLOW_RESULT_CHANGED_AFTER_ASSERTION", "blocked")
            output_freshness[step["output"]] = {"changedSinceStart": bool(observed and observed["generation"] == generation and observed["changedSinceStart"]), "inputCorrelated": bool(observed and observed["generation"] == generation and observed["inputCorrelated"])}
            if observed and observed["guarded"]:
                guarded_outputs.append({"number": number, "selector": step["selector"], "text": text, "generation": generation})
            if "pattern" in step:
                match = pattern(step["pattern"]).fullmatch(text)
                if match is None:
                    raise MobileError("WORKFLOW_EXTRACTION_FAILED", "blocked")
                text = match.group(step.get("group", 0))
            kind = step.get("valueType", "string")
            try:
                value = int(text) if kind == "integer" and re.fullmatch(r"-?[0-9]+", text) else float(text) if kind == "number" else text == "true" if kind == "boolean" and text in {"true", "false"} else text if kind == "string" else None
                if value is None or isinstance(value, float) and not math.isfinite(value):
                    raise ValueError()
            except (ValueError, OverflowError):
                raise MobileError("WORKFLOW_EXTRACTION_TYPE_MISMATCH", "blocked") from None
            outputs[step["output"]] = value
    if guarded_outputs:
        # Keep the assertion and extraction as distinct fresh reads, then verify
        # all freshness-guarded outputs once more before returning. This catches
        # a result reverting while its extraction snapshot is being delivered.
        session.budget.check()
        final_tree = session.backend.observe()
        session.budget.check()
        for guarded in guarded_outputs:
            final_node = contract_node(contracts, guarded["number"], locate(final_tree, guarded["selector"]), "extract")
            if guarded["generation"] != generation or final_node["text"] != guarded["text"]:
                raise MobileError("WORKFLOW_RESULT_CHANGED_AFTER_ASSERTION", "blocked")
        evidence.append(session.event("workflow_outputs_reverified", workflowId=definition["id"], outputs=len(guarded_outputs)))
    return {"outputs": scrub_outputs(definition["inputSchema"], inputs, outputs), "assertionsPassed": assertions, "actionsPerformed": actions_performed, "checkStateVerifications": check_observations, "selectionStateVerifications": select_observations, "resultFreshness": {"changedAssertions": changed_count, "inputCorrelatedAssertions": correlated_count, "outputs": output_freshness, "scope": "configured_ui_text_transition_or_input_association; not_request_completion_or_business_proof"}, "evidenceIds": evidence[-12:]}


def learn_workflow(session, definition, samples):
    return _with_write_outcome(session, definition, lambda: _learn_workflow(session, definition, samples))


def _learn_workflow(session, definition, samples):
    definition = definition_contract(session, definition)
    approve_workflow(session, definition, learning=True)
    if not isinstance(samples, list) or not 2 <= len(samples) <= 5:
        raise MobileError("WORKFLOW_REQUIRES_TWO_SAMPLES", "blocked")
    for inputs in samples:
        validate_inputs(definition["inputSchema"], inputs)
    if len({digest(inputs) for inputs in samples}) < 2:
        raise MobileError("WORKFLOW_REQUIRES_DIFFERENT_INPUTS", "blocked")
    session.features = session.backend.probe()
    sample_evidence, outputs = [], []
    contracts = [None] * len(definition["steps"])
    session.progress["status"] = "running"
    with DeviceLease(session.backend):
        for number, inputs in enumerate(samples):
            result = _run(session, definition, inputs, contracts)
            outputs.append(result["outputs"])
            sample_evidence.append({"sample": number, "assertionsPassed": result["assertionsPassed"], "resultFreshness": result["resultFreshness"], "evidenceIds": result["evidenceIds"]})
    if len({digest(value) for value in outputs}) < 2:
        raise MobileError("WORKFLOW_REQUIRES_RESULT_VARIATION", "blocked")
    capability_id = "mobile_workflow_" + digest([session.source["id"], definition["id"]])
    learning = {"sampleCount": len(samples), "distinctInputSamples": len({digest(value) for value in samples}), "distinctResultSamples": len({digest(value) for value in outputs}), "samples": sample_evidence}
    recipe = {"schemaVersion": 1, "recipeType": "workflow", "sourceId": session.source["id"], "identity": session.identity, "capabilityId": capability_id, "definition": definition, "controlContracts": contracts, "learningEvidence": learning}
    recipe["revision"] = digest(recipe)
    output_schema = {"type": "object", "properties": {step["output"]: {"type": step.get("valueType", "string")} for step in definition["steps"] if step["kind"] == "extract"}, "additionalProperties": False}
    capability = {"id": capability_id, "name": safe_text(definition.get("name") or definition["id"]), "description": safe_text(definition.get("description") or "按可信控件契约绑定输入、执行UI步骤并校验/提取结果。", 400), "kind": "mobile", "inputSchema": definition["inputSchema"], "outputSchema": output_schema, "readiness": "ready", "effect": definition["effect"], "revision": recipe["revision"], "evidence": {"workflowObserved": True, "sampleCount": len(samples), "differentInputsObserved": True, "resultVariationObserved": True, "controlContractsVerified": True, "networkObserved": False, "assertionsPerSample": sample_evidence[0]["assertionsPassed"], "resultFreshness": sample_evidence[0]["resultFreshness"]}, "gaps": ["configured_ui_assertions_do_not_prove_arbitrary_business_semantics"]}
    session.progress["capabilities"][capability_id] = capability
    session.progress["recipes"][capability_id] = recipe
    session.progress["status"] = "completed"
    session.checkpoint()
    return {"ok": True, "status": "completed", "capabilityId": capability_id, "revision": recipe["revision"], "sampleCount": len(samples), "resultVariationObserved": True, "inputsPersisted": False, "networkObserved": False}


def execute_workflow(session, recipe, revision, inputs):
    return _with_write_outcome(session, recipe.get("definition"), lambda: _execute_workflow(session, recipe, revision, inputs))


def _execute_workflow(session, recipe, revision, inputs):
    definition = definition_contract(session, recipe.get("definition"))
    validate_inputs(definition["inputSchema"], inputs)
    learning = recipe.get("learningEvidence", {})
    if learning.get("sampleCount", 0) < 2 or learning.get("distinctInputSamples", 0) < 2 or learning.get("distinctResultSamples", 0) < 2:
        raise MobileError("WORKFLOW_NOT_OBSERVED_WITH_VARIATION", "blocked")
    contracts = copy.deepcopy(recipe.get("controlContracts"))
    if not isinstance(contracts, list) or len(contracts) != len(definition["steps"]) or any(not isinstance(value, dict) for value in contracts):
        raise MobileError("WORKFLOW_CONTROL_CONTRACT_MISSING", "blocked")
    session.features = session.backend.probe()
    session.progress["status"] = "running"
    with DeviceLease(session.backend):
        result = _run(session, definition, inputs, contracts)
    session.progress["status"] = "completed"
    session.checkpoint()
    return {"ok": True, "status": "completed", "capabilityId": recipe["capabilityId"], "revision": revision, **result, "executionObserved": bool(result["actionsPerformed"]), "networkObserved": False, "gaps": ["configured_ui_assertions_only", "network_scope_not_enforced"]}
