"""One observed native UI fork with per-arm learning and no dispatch fallback.

The public input and output schemas are shared. Physical selectors, observed
stage proofs and learned contracts remain scoped to the selected arm.
"""
import copy
import json

from .mobile_ui import DeviceLease, MobileError, digest, safe_text


def fail(code):
    raise MobileError(code, "blocked")


def output_schema(definition):
    return {"type": "object", "properties": {
        row["output"]: {"type": row.get("valueType", "string")}
        for row in definition["steps"] if row["kind"] == "extract"
    }, "additionalProperties": False}


def definition_contract(session, definition):
    from . import mobile_branches as branch
    from . import mobile_workflows as workflow
    allowed = {"schemaVersion", "id", "name", "description", "effect", "inputSchema", "branchPlan"}
    if (not isinstance(definition, dict) or set(definition) - allowed or
            definition.get("schemaVersion") != 1 or definition.get("effect") != "read" or
            not isinstance(definition.get("id"), str) or not workflow.NAME.fullmatch(definition["id"])):
        fail("NATIVE_BRANCH_DEFINITION_INVALID")
    workflow.schema_contract(definition.get("inputSchema"))
    try:
        encoded = json.dumps(definition, ensure_ascii=False, allow_nan=False).encode()
    except (TypeError, ValueError, UnicodeError):
        fail("NATIVE_BRANCH_DEFINITION_INVALID")
    if len(encoded) > 524288:
        fail("NATIVE_BRANCH_EVIDENCE_LIMIT")
    plan = branch.validate_definition(session, definition)
    expected_output = None
    # Validate both complete paths before any backend probe or UI command.
    # An unselected arm cannot borrow the permissions of the selected arm.
    for arm in plan["arms"]:
        child = workflow.definition_contract(branch.arm_session(session, plan, arm), arm["definition"])
        linked = {step["expect"][key] for step in child["steps"] if step["kind"] == "assert"
                  for key in ("equalsInput", "containsInput")
                  if key in step["expect"] and step["expect"].get("changed") is True}
        if linked != set(child["inputSchema"]["properties"]):
            fail("NATIVE_BRANCH_INPUT_RESULT_ASSOCIATION_REQUIRED")
        result = output_schema(child)
        if not result["properties"] or expected_output is not None and expected_output != result:
            fail("NATIVE_BRANCH_OUTPUT_SCHEMA_MISMATCH")
        expected_output = result
        # Every extracted value must be independently changed and associated
        # with an input before its own fresh extraction, on this same arm.
        for step in child["steps"]:
            if step["kind"] == "extract" and not any(
                    row["kind"] == "assert" and row["selector"] == step["selector"] and
                    row["expect"].get("changed") is True and
                    any(key in row["expect"] for key in ("equalsInput", "containsInput"))
                    for row in child["steps"]):
                fail("NATIVE_BRANCH_OUTPUT_ASSOCIATION_REQUIRED")
    return copy.deepcopy(definition)


def arm_inputs(arm, inputs):
    return {local: inputs[global_name] for global_name, local in arm["inputMap"].items()}


def arm_for_inputs(plan, inputs):
    value = inputs[plan["branchInput"]]
    matches = [arm for arm in plan["arms"]
               if type(value) is type(arm["value"]) and value == arm["value"]]
    if len(matches) != 1:
        fail("NATIVE_BRANCH_INPUT_DOMAIN_INVALID")
    return matches[0]


def initial_contracts(definition):
    contracts = {}
    for arm in definition["branchPlan"]["arms"]:
        child, rows = arm["definition"], []
        saved = child["stagePlan"]["controlContracts"]
        output_contracts = {digest(row["selector"]): row["contract"]
                            for row in child["stagePlan"]["proof"]["trace"]["stages"][-1]["outputs"]}
        rows.extend(copy.deepcopy(saved))
        for step in child["steps"][len(saved):]:
            contract = output_contracts.get(digest(step["selector"]))
            if not isinstance(contract, dict):
                fail("NATIVE_BRANCH_OUTPUT_CONTRACT_MISSING")
            rows.append(copy.deepcopy(contract))
        if len(rows) != len(child["steps"]):
            fail("NATIVE_BRANCH_CONTROL_CONTRACT_MISSING")
        contracts[arm["id"]] = rows
    return contracts


def run(session, definition, inputs, contracts):
    from .mobile_workflows import _run, scrub_outputs
    plan = definition["branchPlan"]
    first = plan["arms"][0]
    fork = next(row for row in first["definition"]["stagePlan"]["ranges"]
                if row["stageIndex"] == plan["forkStageIndex"])["end"]
    context = {"definition": definition, "inputs": inputs, "contracts": contracts,
               "forkIndex": fork, "selectedArmId": None}
    result = _run(session, first["definition"], arm_inputs(first, inputs), contracts[first["id"]], context)
    if context["selectedArmId"] is None:
        fail("NATIVE_BRANCH_SELECTION_NOT_OBSERVED")
    return {**result, "outputs": scrub_outputs(definition["inputSchema"], inputs, result["outputs"]),
            "branchSelection": {"armId": context["selectedArmId"],
            "freshPositiveStructuralMatch": True, "automaticRetry": False}}


def learn_workflow(session, definition, samples):
    from . import mobile_workflows as workflow
    definition = definition_contract(session, definition)
    plan = definition["branchPlan"]
    if not isinstance(samples, list) or not 4 <= len(samples) <= 5:
        fail("NATIVE_BRANCH_REQUIRES_TWO_SAMPLES_PER_ARM")
    grouped = {arm["id"]: [] for arm in plan["arms"]}
    for number, inputs in enumerate(samples):
        workflow.validate_inputs(definition["inputSchema"], inputs)
        arm = arm_for_inputs(plan, inputs)
        grouped[arm["id"]].append((number, inputs))
    for rows in grouped.values():
        if len(rows) < 2 or len({digest(inputs) for _, inputs in rows}) < 2:
            fail("NATIVE_BRANCH_REQUIRES_TWO_DIFFERENT_SAMPLES_PER_ARM")
    contracts = initial_contracts(definition)
    session.features = session.backend.probe()
    session.progress["status"] = "running"
    sample_evidence, all_outputs = [], []
    coverage = {arm["id"]: {"sampleCount": 0, "distinctInputSamples":
                len({digest(inputs) for _, inputs in grouped[arm["id"]]}),
                "distinctResultSamples": 0, "samples": []} for arm in plan["arms"]}
    results_by_arm = {arm["id"]: [] for arm in plan["arms"]}
    with DeviceLease(session.backend):
        for number, inputs in enumerate(samples):
            result = run(session, definition, inputs, contracts)
            arm_id = result["branchSelection"]["armId"]
            expected = arm_for_inputs(plan, inputs)
            if arm_id != expected["id"]:
                fail("NATIVE_BRANCH_SELECTED_ARM_MISMATCH")
            record = {"sample": number, "armId": arm_id, "assertionsPassed": result["assertionsPassed"],
                      "resultFreshness": result["resultFreshness"], "evidenceIds": result["evidenceIds"],
                      "branchSelection": result["branchSelection"]}
            sample_evidence.append(record)
            all_outputs.append(result["outputs"])
            coverage[arm_id]["sampleCount"] += 1
            coverage[arm_id]["samples"].append(number)
            results_by_arm[arm_id].append(result["outputs"])
    for arm_id, outputs in results_by_arm.items():
        coverage[arm_id]["distinctResultSamples"] = len({digest(value) for value in outputs})
        if coverage[arm_id]["distinctResultSamples"] < 2:
            fail("NATIVE_BRANCH_REQUIRES_RESULT_VARIATION_PER_ARM")
    capability_id = "mobile_workflow_" + digest([session.source["id"], definition["id"]])
    learning = {"sampleCount": len(samples), "distinctInputSamples": len({digest(value) for value in samples}),
                "distinctResultSamples": len({digest(value) for value in all_outputs}),
                "samples": sample_evidence, "branchCoverage": coverage}
    recipe = {"schemaVersion": 1, "recipeType": "workflow", "sourceId": session.source["id"],
              "identity": session.identity, "capabilityId": capability_id, "definition": definition,
              "controlContracts": contracts, "learningEvidence": learning}
    recipe["revision"] = digest(recipe)
    capability = {"id": capability_id, "name": safe_text(definition.get("name") or definition["id"]),
                  "description": safe_text(definition.get("description") or "按已观察的原生条件分支与控件合同执行并核验结果。", 400),
                  "kind": "mobile", "inputSchema": definition["inputSchema"],
                  "outputSchema": output_schema(plan["arms"][0]["definition"]),
                  "readiness": "ready", "effect": "read", "revision": recipe["revision"],
                  "evidence": {"workflowObserved": True, "sampleCount": len(samples),
                    "differentInputsObserved": True, "resultVariationObserved": True,
                    "controlContractsVerified": True, "networkObserved": False,
                    "branchCount": 2, "branchCoverage": coverage,
                    "freshPositiveBranchSelectionObserved": True,
                    "assertionsPerSample": sample_evidence[0]["assertionsPassed"],
                    "resultFreshness": sample_evidence[0]["resultFreshness"]},
                  "gaps": ["configured_ui_assertions_do_not_prove_arbitrary_business_semantics"]}
    session.progress["capabilities"][capability_id] = capability
    session.progress["recipes"][capability_id] = recipe
    session.progress["status"] = "completed"
    session.checkpoint()
    return {"ok": True, "status": "completed", "capabilityId": capability_id, "revision": recipe["revision"],
            "sampleCount": len(samples), "branchCoverage": coverage, "resultVariationObserved": True,
            "inputsPersisted": False, "networkObserved": False}


def execute_workflow(session, recipe, revision, inputs):
    from . import mobile_workflows as workflow
    definition = definition_contract(session, recipe.get("definition"))
    workflow.validate_inputs(definition["inputSchema"], inputs)
    learning = recipe.get("learningEvidence", {})
    plan = definition["branchPlan"]
    coverage = learning.get("branchCoverage", {})
    arm_ids = {arm["id"] for arm in plan["arms"]}
    if (learning.get("sampleCount", 0) < 4 or not isinstance(coverage, dict) or set(coverage) != arm_ids or
            any(not isinstance(row, dict) or any(row.get(key, 0) < 2 for key in
                ("sampleCount", "distinctInputSamples", "distinctResultSamples")) for row in coverage.values())):
        fail("NATIVE_BRANCH_NOT_OBSERVED_WITH_VARIATION_PER_ARM")
    contracts = copy.deepcopy(recipe.get("controlContracts"))
    if not isinstance(contracts, dict) or set(contracts) != arm_ids:
        fail("NATIVE_BRANCH_CONTROL_CONTRACT_MISSING")
    for arm in plan["arms"]:
        values = contracts[arm["id"]]
        if not isinstance(values, list) or len(values) != len(arm["definition"]["steps"]) or any(not isinstance(value, dict) for value in values):
            fail("NATIVE_BRANCH_CONTROL_CONTRACT_MISSING")
    session.features = session.backend.probe()
    session.progress["status"] = "running"
    with DeviceLease(session.backend):
        result = run(session, definition, inputs, contracts)
    session.progress["status"] = "completed"
    session.checkpoint()
    return {"ok": True, "status": "completed", "capabilityId": recipe["capabilityId"],
            "revision": revision, **result, "executionObserved": bool(result["actionsPerformed"]),
            "networkObserved": False, "gaps": ["configured_ui_assertions_only", "network_scope_not_enforced"]}
