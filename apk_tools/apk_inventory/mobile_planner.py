"""Read-only native query candidates from live UI and observed exploration paths.

The public index never contains selectors, captured text or parameter values.
Grouped controls and paths are evidence for a candidate, not a callable workflow;
only subsequent real sample execution can publish ready capabilities.
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import re
import unicodedata

from .mobile_ui import (DeviceLease, MobileError, MobileSession, RISK, atomic_json,
                        check_target, digest, locate, node_selector, read_json,
                        safe_text, selection_members, selection_state)

MAX_CANDIDATES, MAX_INPUTS, MAX_STATES, MAX_PREFIX = 100, 16, 1000, 30
FP = re.compile(r"[a-f0-9]{64}")


def _stable(node):
    return bool(node.get("resourceId") or node.get("accessibilityId"))


def _locator_index(tree):
    """Same strict uniqueness as locate, without scanning all nodes per field."""
    index = {}
    for node in tree["nodes"]:
        if node["enabled"] and node["visible"]:
            for key in ("resourceId", "accessibilityId", "className"):
                if node.get(key):
                    index.setdefault((key, node[key]), []).append(node)

    def unique(wanted):
        choices = [index.get((key, value), []) for key, value in wanted.items()]
        candidates = min(choices, key=len) if choices else []
        found = [node for node in candidates if all(node.get(key) == value for key, value in wanted.items())]
        if len(found) != 1:
            raise MobileError("SELECTOR_AMBIGUOUS" if found else "SELECTOR_NOT_FOUND", "blocked")
        return found[0]
    return unique


def _container_keys(node, unique, gaps):
    path, keys = [], []
    for row in node.get("containerPath", [])[:8]:
        if not isinstance(row, dict) or not _stable(row):
            continue
        cls = row.get("className", "")
        if not isinstance(cls, str) or re.search(r"Application|Window", cls, re.I):
            continue
        stable = {key: row.get(key, "") for key in ("resourceId", "accessibilityId", "className")}
        if any(not isinstance(value, str) or len(value) > 512 for value in stable.values()):
            continue
        # A repeated group ID is not structural proof that independent forms
        # belong together. The ancestor itself must identify one live container.
        try:
            unique({key: value for key, value in stable.items() if value})
        except MobileError:
            gaps.add("ambiguous_native_group_omitted")
            continue
        path.append(stable)
        keys.append(digest(path))
    return keys


def _parameter_name(node, used, single=False):
    if single:
        base = "query"  # Preserve the existing single-field public contract.
    else:
        raw = node.get("resourceId", "").rsplit("/", 1)[-1] or node.get("accessibilityId", "")
        base = re.sub(r"[^A-Za-z0-9_]", "_", unicodedata.normalize("NFKC", raw)).strip("_")[:40] or "input"
        if not base[0].isalpha():
            base = "field_" + base
        if base in {"__proto__", "prototype", "constructor"}:
            base = "input"
    name, suffix = base, 2
    while name in used:
        name = base + "_" + str(suffix)
        suffix += 1
    used.add(name)
    return name


def _classify(session, tree, gaps):
    inputs, buttons, outputs = [], [], []
    unique = _locator_index(tree)
    for group in tree["nodes"]:
        if not group.get("selectionGroupKind"):
            continue
        if not _stable(group):
            gaps.add("native_selection_group_stable_id_missing")
            continue
        wanted = node_selector(group)
        try:
            unique(wanted)
            members = selection_members(tree, group)
            used = set()
            options = [{"value": _parameter_name(member, used), "selector": node_selector(member)} for member in members]
            selection_state(tree, {"selector": wanted, "options": options})
        except MobileError as error:
            gaps.add("native_selection_group_incomplete:" + error.code)
            continue
        if session.policy({"kind": "select", "selector": wanted}) != (True, "read") or any(session.policy({"kind": "check", "selector": option["selector"]}) != (True, "read") for option in options):
            gaps.add("native_selection_group_requires_read_allowlist")
            continue
        inputs.append({"node": group, "selector": wanted, "containers": _container_keys(group, unique, gaps), "inputKind": "select", "options": options,
                       "enumOptions": [{"value": option["value"], "label": safe_text(member["text"] or option["value"], 120)} for option, member in zip(options, members)]})
    for node in tree["nodes"]:
        if not node["enabled"] or not node["visible"] or node["secure"] or not _stable(node):
            continue
        wanted = node_selector(node)
        try:
            unique(wanted)
        except MobileError:
            gaps.add("ambiguous_native_locator_omitted")
            continue
        row = {"node": node, "selector": wanted, "containers": _container_keys(node, unique, gaps)}
        if node.get("selectionGroupKind") or node.get("selectionOptionKind") or node.get("checkKind") == "radio":
            if node.get("checkKind") == "radio" and not node.get("selectionOptionKind"):
                gaps.add("native_radio_requires_complete_group")
            continue
        if node.get("checkKind") or node.get("checkable"):
            try:
                check_target("check", node)
            except MobileError:
                gaps.add("native_boolean_state_unavailable_or_readonly")
                continue
            if not row["containers"]:
                gaps.add("native_boolean_group_evidence_missing")
                continue
            if session.policy({"kind": "check", "selector": wanted}) == (True, "read"):
                inputs.append({**row, "inputKind": "check"})
            else:
                gaps.add("native_boolean_requires_read_check_allowlist")
        elif node["editable"]:
            if node.get("readOnly"):
                gaps.add("native_readonly_input_omitted")
                continue
            if session.policy({"kind": "type", "selector": wanted, "input": "query"}) == (True, "read"):
                inputs.append({**row, "inputKind": "type"})
            else:
                gaps.add("native_input_requires_read_allowlist")
        elif node["clickable"]:
            if not RISK.search(" ".join([node["text"], *wanted.values()])) and session.policy({"kind": "click", "selector": wanted}) == (True, "read"):
                buttons.append(row)
        elif node["text"] and not RISK.search(" ".join([node["text"], *wanted.values()])):
            outputs.append(row)
    return inputs, buttons, outputs


def _group_controls(inputs, buttons, outputs, gaps):
    """Each input belongs to its nearest observed stable group with a read button.

    An outer button cannot consume fields already owned by separate inner forms.
    No coordinates, proximity scores or label similarity are used for grouping.
    """
    if len(inputs) == 1 and not inputs[0]["containers"]:
        return [("legacy_single_input", inputs, button, outputs) for button in buttons[:20]]
    owner = {}
    for row in inputs:
        group = next((key for key in reversed(row["containers"]) if any(key in button["containers"] for button in buttons)), None)
        if group:
            owner[id(row)] = group
        else:
            gaps.add("native_group_evidence_missing")
    groups = []
    for button in buttons[:20]:
        key = next((key for key in reversed(button["containers"]) if any(owner.get(id(row)) == key for row in inputs)), None)
        if not key:
            continue
        fields = [row for row in inputs if owner.get(id(row)) == key]
        targets = [row for row in outputs if key in row["containers"]]
        if len(fields) > MAX_INPUTS:
            gaps.add("native_group_input_limit")
            continue
        groups.append((key, fields, button, targets))
    if not groups and len(inputs) != 1:
        gaps.add("native_single_input_group_required")  # Legacy diagnostics remain meaningful.
        gaps.add("native_multi_input_group_not_proven")
    return groups


def _tree_candidates(session, tree, prefix=None, proof=None):
    gaps = set()
    inputs, buttons, outputs = _classify(session, tree, gaps)
    if not outputs:
        gaps.add("native_result_locator_missing")
    if not buttons:
        gaps.add("native_read_button_missing")
    items, specs = [], {}
    for group, fields, button, grouped_outputs in _group_controls(inputs, buttons, outputs, gaps):
        if not fields:
            continue
        prefix_key = prefix or None
        domains = [row["options"] for row in fields if row["inputKind"] == "select"]
        domain_identity = [domains] if domains else []
        ident = "mobile_plan_" + digest([session.source, group, [row["selector"] for row in fields], button["selector"], prefix_key, *domain_identity])
        targets = [{"id": "output_" + digest([ident, row["selector"]]), "kind": "text", "selector": row["selector"]} for row in grouped_outputs[:12]]
        properties, required, steps, native_inputs, used = {}, [], [], [], set()
        for row in fields:
            field = _parameter_name(row["node"], used, single=len(fields) == 1 and row["inputKind"] == "type")
            # Native keyboard/input type is an observation, not a business validator.
            # The type backend accepts bounded text; absence of business constraints
            # is explicit, rather than inventing required/ranges from keyboard hints.
            is_check = row["inputKind"] == "check"
            is_select = row["inputKind"] == "select"
            properties[field] = {"type": "string", "enum": [option["value"] for option in row["options"]]} if is_select else {"type": "boolean"} if is_check else {"type": "string", "maxLength": 2048}
            required.append(field)
            steps.append({"kind": row["inputKind"], "selector": row["selector"], "input": field, **({"options": row["options"]} if is_select else {}), **({"replace": True} if row["inputKind"] == "type" else {})})
            native_inputs.append({"param": field, "inputType": row["node"].get("selectionGroupKind") if is_select else row["node"].get("checkKind") if is_check else str(row["node"].get("inputType", ""))[:160], "businessRequiredObserved": False, **({"enumOptions": row["enumOptions"]} if is_select else {})})
        steps.append({"kind": "click", "selector": button["selector"]})
        schema = {"type": "object", "properties": properties, "required": required, "additionalProperties": False}
        spec = {"schemaVersion": 1, "id": "native_query_" + digest([group, fields and [row["selector"] for row in fields], button["selector"], prefix_key, *domain_identity])[:40], "name": "原生查询流程", "effect": "read", "inputSchema": schema, "steps": steps, "outcomeCandidates": targets}
        if prefix:
            spec["entryPrefix"] = copy.deepcopy(prefix)
        local_gaps = gaps | {"native_input_constraints_not_observed", "native_business_required_not_observed", "two_distinct_samples_required", "parameter_related_assertion_required"}
        if not targets:
            local_gaps.add("native_result_locator_missing")
        evidence = {"stateId": tree["fingerprint"], "parameterizationValidated": False, "grouping": "single_field_without_container" if group == "legacy_single_input" else "shared_stable_ancestor", "prefixLength": len(prefix["steps"]) if prefix else 0}
        if proof:
            evidence.update(proof)
        items.append({"id": ident, "name": "原生多字段查询候选" if len(fields) > 1 else "原生查询候选", "kind": "mobile_workflow", "readiness": "candidate", "effect": "unknown", "inputSchema": schema, "nativeInputs": native_inputs, "outputTargets": [{"id": target["id"], "kind": "text", "label": "结果区域"} for target in targets], "evidence": evidence, "gaps": sorted(local_gaps)})
        specs[ident] = spec
    return items, specs, gaps


def _event_proof(events):
    starts, finished, observations = {}, {}, {}
    for event in events:
        if not isinstance(event, dict):
            continue
        if event.get("kind") == "ui_action_started":
            starts[event.get("executionId")] = event
        elif event.get("kind") == "ui_action_finished" and event.get("status") == "observed":
            started = starts.get(event.get("executionId"))
            if started and event.get("startedEvidenceId") == started.get("evidenceId"):
                finished[event["executionId"]] = (started, event)
        elif event.get("kind") == "ui_state_observed":
            observations[event.get("stateId")] = event
    return finished, observations


def _observed_states(session, checkpoint, events):
    gaps = set()
    if not isinstance(checkpoint, dict) or checkpoint.get("identity") != session.identity or checkpoint.get("schemaVersion") != 1:
        return [], {"native_checkpoint_identity_mismatch"}
    states, entry = checkpoint.get("states"), checkpoint.get("entry")
    if not isinstance(states, dict) or len(states) > MAX_STATES or not isinstance(entry, str) or not FP.fullmatch(entry):
        return [], {"native_checkpoint_format_invalid"}
    complete, observations = _event_proof(events)
    observed = []
    for state_id, state in states.items():
        if not isinstance(state_id, str) or not isinstance(state, dict) or state.get("fingerprint") != state_id or not FP.fullmatch(state_id):
            gaps.add("native_checkpoint_state_invalid")
            continue
        inventory = state.get("workflowInventory")
        if not isinstance(inventory, dict) or inventory.get("fingerprint") != state_id or not isinstance(inventory.get("nodes"), list) or len(inventory["nodes"]) > 10000:
            gaps.add("native_state_inventory_missing")
            continue
        if inventory.get("truncated"):
            gaps.add("native_state_inventory_truncated")
            continue
        observed_event = observations.get(state_id)
        if state.get("workflowInventoryDigest") != digest(inventory) or not observed_event or observed_event.get("inventoryDigest") != state["workflowInventoryDigest"]:
            gaps.add("native_state_inventory_not_proven")
            continue
        path = state.get("path")
        if not isinstance(path, list) or len(path) > MAX_PREFIX:
            gaps.add("native_read_prefix_invalid")
            continue
        current, ids, valid = entry, [], True
        for step in path:
            if not isinstance(step, dict) or step.get("before") != current or not isinstance(step.get("after"), str) or not FP.fullmatch(step["after"]):
                valid = False
                break
            action = step.get("action")
            if not isinstance(action, dict) or action.get("kind") not in {"click", "swipe"} or session.policy(action) != (True, "read"):
                valid = False
                break
            if set(action) - ({"kind", "selector", "direction"} if action["kind"] == "swipe" else {"kind", "selector"}):
                valid = False
                break
            pair = complete.get(step.get("executionId"))
            if not pair or not pair[0].get("evidenceId") or not pair[1].get("evidenceId") or pair[0].get("actionKind") != action["kind"] or pair[0].get("beforeStateId") != current or pair[0].get("actionId") != digest(action) or pair[1].get("afterStateId") != step["after"]:
                valid = False
                break
            source_state = states.get(current, {})
            source = source_state.get("workflowInventory")
            source_event = observations.get(current)
            if not isinstance(source, dict) or source.get("fingerprint") != current or source_state.get("workflowInventoryDigest") != digest(source) or not source_event or source_event.get("inventoryDigest") != source_state["workflowInventoryDigest"]:
                valid = False
                break
            try:
                node = locate(source, action.get("selector"))
                check_target(action["kind"], node)
                if RISK.search(" ".join([node["text"], *action["selector"].values()])):
                    valid = False
                    break
            except MobileError:
                valid = False
                break
            current = step["after"]
            ids.extend([pair[0]["evidenceId"], pair[1]["evidenceId"]])
        if not valid or current != state_id:
            gaps.add("native_read_prefix_not_proven")
            continue
        prefix = {"entryStateId": entry, "targetStateId": state_id, "steps": copy.deepcopy(path)} if path else None
        observed.append((inventory, prefix, {"inventoryObserved": True, "stateEvidenceId": observed_event.get("evidenceId"), "prefixEvidenceIds": ids[-60:]}))
    return observed, gaps


def plan_tree(session, tree, checkpoint=None, events=None):
    items, specs, gaps = _tree_candidates(session, tree)
    if checkpoint is not None:
        stored, inventory_gaps = _observed_states(session, checkpoint, events or [])
        gaps.update(inventory_gaps)
        for inventory, prefix, proof in stored:
            candidates, private, state_gaps = _tree_candidates(session, inventory, prefix, proof)
            gaps.update(state_gaps)
            known = {item["id"] for item in items}
            for item in candidates:
                if item["id"] not in known:
                    items.append(item)
                    specs[item["id"]] = private[item["id"]]
    truncated = len(items) > MAX_CANDIDATES
    items = items[:MAX_CANDIDATES]
    specs = {item["id"]: specs[item["id"]] for item in items}
    # Public and private response budgets are enforced independently.
    while items and (len(json.dumps(items, ensure_ascii=False).encode()) > 98304 or len(json.dumps(specs, ensure_ascii=False).encode()) > 524288):
        specs.pop(items.pop()["id"])
        truncated = True
    return {"schemaVersion": 1, "source": {**session.source, "revision": digest([session.identity, tree["fingerprint"], specs, items])}, "items": items, "specs": specs, "total": len(items), "nextOffset": None, "truncated": truncated, "gaps": sorted(gaps)}


def _read_events(directory):
    path = directory / "events.jsonl"
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 64 * 1024 * 1024:
        raise MobileError("NATIVE_PLAN_EVENTS_REJECTED", "blocked")
    result = []
    with path.open(encoding="utf-8") as stream:
        for number, line in enumerate(stream):
            if number >= 300000 or len(line.encode()) > 262144:
                raise MobileError("NATIVE_PLAN_EVENTS_LIMIT", "blocked")
            if line.strip():
                result.append(json.loads(line))
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--inventory", type=Path, help="existing mobile exploration directory with private checkpoint and events")
    args = parser.parse_args(argv)
    try:
        session = MobileSession(read_json(args.config), args.output)
        session.features = session.backend.probe()
        with DeviceLease(session.backend):
            plan = plan_tree(session, session.backend.observe(), read_json(args.inventory / "checkpoint.json") if args.inventory else None, _read_events(args.inventory) if args.inventory else None)
        atomic_json(args.output / "plan.private.json", plan)
        public = {key: value for key, value in plan.items() if key != "specs"}
        atomic_json(args.output / "result.json", {"ok": True, **public})
        print(json.dumps({"ok": True, **public}, ensure_ascii=False))
        return 0
    except (MobileError, OSError, ValueError, TypeError, KeyError) as error:
        result = {"ok": False, "error": {"code": error.code if isinstance(error, MobileError) else "NATIVE_PLAN_FAILED"}}
        atomic_json(args.output / "result.json", result)
        print(json.dumps(result))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
