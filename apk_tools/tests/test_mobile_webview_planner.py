"""Planner/linear-engine protocol tests; no browser, Appium or device proof."""
import copy
from contextlib import contextmanager
import json
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from apk_inventory import mobile_webview_planner as planner
from apk_inventory.mobile_ui import Budget, DeviceLease, MobileError, WebDriverBackend, atomic_json, digest, read_json
from apk_inventory.mobile_webview import PROBE_SHA256, PROBE_VERSION


APP = "com.example.observedweb"
IDENTITY = {"modality": planner.MODALITY, "platform": "ios", "appId": APP,
            "context": "WEBVIEW_existing", "contextBundleId": APP, "windowHandle": "existing",
            "origin": "http://127.0.0.1:8080", "url": "http://127.0.0.1:8080/query",
            "probeVersion": PROBE_VERSION, "probeSha256": PROBE_SHA256,
            "documentScope": "worker_live_reference_identity", "associationMethod": "reported_bundle_id_v1"}


def node(identifier, kind, group="#observedForm"):
    tag = {"group": "form", "input": "input", "button": "button", "output": "div"}[kind]
    contract = {"selector": identifier, "kind": kind, "tag": tag, "id": identifier[1:]}
    if kind != "group":
        contract.update({"type": "text" if kind == "input" else "submit" if kind == "button" else "",
                         "name": identifier[1:], "role": "", "ariaLabel": "", "label": "Search" if kind == "button" else "",
                         "groupSelector": group, "groupId": group[1:] if group else None,
                         "groupTag": "form" if group else None,
                         "formId": group[1:] if group and kind in {"input", "button"} else None,
                         "formAction": IDENTITY["url"] if group and kind in {"input", "button"} else None,
                         "formMethod": "get" if group and kind in {"input", "button"} else None,
                         "parentId": group[1:] if group else "surface", "parentTag": "form" if group else "body"})
    return {"resourceId": identifier, "accessibilityId": "", "className": "HTML:" + tag,
            "text": "Search" if kind == "button" else "", "inputType": contract.get("type", ""),
            "enabled": True, "visible": True, "secure": False, "readOnly": False,
            "editable": kind == "input", "clickable": kind == "button", "scrollable": False,
            "bounds": [0, 0, 100, 40], "domContract": contract}


class Backend:
    def __init__(self):
        self.config = {"url": "http://127.0.0.1:9"}
        self.session = "offline-planner-fixture"
        self.nodes = [node("#observedForm", "group"), node("#cityField", "input"),
                      node("#detailField", "input"), node("#lookupAction", "button"),
                      node("#independentResult", "output", None)]
        self.identity = copy.deepcopy(IDENTITY)
        self.values = {"#cityField": "captured-value-never-persist", "#detailField": ""}
        self.text, self.business, self.actions = "", [], []
        self.poisoned, self.active, self.dispatched = False, False, False
        self.fail_after_click, self.freeze_result = False, False
        self.artifact_verification = {"status": "unsupported", "kind": "ios"}

    def observe(self, input_suffix=None):
        nodes = copy.deepcopy(self.nodes)
        for row in nodes:
            if row["editable"]:
                row["_inputSha256"] = hashlib.sha256(self.values[row["resourceId"]].encode("utf-8")).hexdigest()
                row["_inputValuePresent"] = True
            if row["domContract"]["kind"] == "output":
                row["text"] = self.text
        contracts = {row["resourceId"]: row["domContract"] for row in nodes}
        return {"nodes": nodes, "modality": planner.MODALITY, "sourceIdentity": copy.deepcopy(self.identity),
                "sourceRevision": digest({"sourceIdentity": self.identity, "contracts": contracts}),
                "fingerprint": digest(contracts), "_documentLease": "private-live-ref-never-persist",
                "_refs": [{"element-6066-11e4-a52e-4f735466cecf": "opaque-never-persist"}],
                "unconfiguredControls": [{"selector": "#notAuthorized", "dispatchAuthorized": False}],
                "gaps": ["webview_unconfigured_controls_present"]}

    def probe(self):
        return {"modality": planner.MODALITY}

    def validate_literal_inputs(self, values):
        if any(not isinstance(v, str) or "\0" in v for v in values.values()):
            raise MobileError("WEBVIEW_LITERAL_INPUT_UNSUPPORTED", "unsupported")

    def perform(self, action, tree, inputs):
        if not self.active or self.poisoned:
            raise MobileError("WEBVIEW_PENDING_UNKNOWN", "blocked")
        self.dispatched = True
        self.actions.append(copy.deepcopy(action))
        if action["kind"] == "type":
            self.values[action["selector"]["resourceId"]] = inputs[action["input"]]
        else:
            hook = getattr(self, "_before_workflow_click", None)
            if hook:
                hook(self.observe(), inputs)
            self.business.append({"cityField": self.values["#cityField"], "detailField": self.values["#detailField"]})
            if not self.freeze_result:
                self.text = "Observed " + self.values["#cityField"] + " / " + self.values["#detailField"] + " ;" + str(len(self.business))
            if self.fail_after_click:
                raise MobileError("WEBVIEW_TRANSPORT_OUTCOME_UNKNOWN", "partial")


class Session:
    def __init__(self, output):
        self.source = {"id": "observed_webview", "kind": "ios"}
        self.config = {"backend": {"type": "appium-webview", "platform": "ios", "appId": APP,
                                  "webview": {key: IDENTITY[key] for key in ("context", "windowHandle", "origin", "url")}}}
        self.identity = digest(self.config)
        self.backend = Backend()
        self.budget = Budget({"maxActions": 100, "maxDurationMs": 5000})
        self.progress = {"status": "new", "capabilities": {}, "recipes": {}}
        self.output = Path(output)
        self.fail_final_checkpoint = False
        self.events = []
        self.approved = {("type", "#cityField"), ("type", "#detailField"), ("click", "#lookupAction")}

    def policy(self, action):
        return (True, "read") if (action["kind"], action["selector"]["resourceId"]) in self.approved else (False, "unknown")

    def event(self, kind, **kwargs):
        self.events.append({"kind": kind, **kwargs})
        return "event_" + str(len(self.events))

    def checkpoint(self):
        if self.fail_final_checkpoint and self.progress.get("status") == "completed" and self.progress["capabilities"]:
            raise OSError("synthetic final checkpoint failure")
        atomic_json(self.output / "checkpoint.json", self.progress)

    @contextmanager
    def execution(self):
        backend = self.backend
        if backend.poisoned:
            raise MobileError("WEBVIEW_PENDING_UNKNOWN", "blocked")
        backend.active, backend.dispatched = True, False
        try:
            yield
        except BaseException:
            if backend.dispatched:
                backend.poisoned = True
            raise
        finally:
            backend.active = False


class PlannerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.session = Session(self.temp.name)

    def plan(self):
        return planner.plan_tree(self.session, self.session.backend.observe())

    def definition(self):
        plan = self.plan()
        self.assertEqual(len(plan["items"]), 1, plan)
        spec = copy.deepcopy(plan["specs"][plan["items"][0]["id"]])
        target = spec.pop("outcomeCandidates")[0]["selector"]
        for key in spec["inputSchema"]["properties"]:
            spec["steps"].append({"kind": "assert", "selector": target, "expect": {"containsInput": key, "changed": True}, "timeoutMs": 0})
        spec["steps"].append({"kind": "extract", "selector": target, "output": "result", "valueType": "string"})
        return spec

    def samples(self):
        return [{"cityField": "上海", "detailField": "第一"}, {"cityField": "深圳", "detailField": "第二"}]

    def learn(self):
        result = planner.learn_workflow(self.session, self.definition(), self.samples())
        return copy.deepcopy(self.session.progress["recipes"][result["capabilityId"]])

    def assertBlocked(self, action, code):
        with self.assertRaises(MobileError) as caught:
            action()
        self.assertEqual(caught.exception.code, code)

    def test_generic_observed_group_and_form_external_output_no_value_or_ref_persistence(self):
        plan = self.plan()
        self.assertEqual(set(plan["items"][0]["inputSchema"]["properties"]), {"cityField", "detailField"})
        self.assertEqual(len(plan["items"][0]["outputTargets"]), 1)
        text = __import__('json').dumps(plan)
        for forbidden in ["captured-value-never-persist", "private-live-ref-never-persist", "opaque-never-persist", "element-6066"]:
            self.assertNotIn(forbidden, text)
        public = __import__('json').dumps({k: v for k, v in plan.items() if k != "specs"})
        for forbidden in ["#cityField", "#lookupAction", "#observedForm", "selector", "WEBVIEW_existing", IDENTITY["url"]]:
            self.assertNotIn(forbidden, public)
        self.assertEqual(self.session.backend.business, [])

    def test_candidate_stable_across_transient_values_and_result_text(self):
        first = self.plan()
        self.session.backend.values["#cityField"] = "another entered value"
        self.session.backend.text = "untrusted dynamic result"
        self.assertEqual(first, self.plan())

    def test_duplicate_selector_and_unobserved_group_fail_closed(self):
        self.session.backend.nodes.append(copy.deepcopy(self.session.backend.nodes[1]))
        self.assertEqual(self.plan()["items"], [])
        self.session.backend.nodes.pop()
        self.session.backend.nodes.pop(0)
        self.assertEqual(self.plan()["items"], [])

    def test_wrong_owner_and_source_revision_rejected(self):
        tree = self.session.backend.observe()
        tree["sourceIdentity"]["contextBundleId"] = "com.other.app"
        self.assertEqual(planner.plan_tree(self.session, tree)["items"], [])
        tree = self.session.backend.observe()
        tree["sourceRevision"] = "0" * 64
        self.assertEqual(planner.plan_tree(self.session, tree)["items"], [])
        self.session.config["backend"]["platform"] = "android"
        self.session.source["kind"] = "apk"
        tree = self.session.backend.observe()
        tree["sourceIdentity"]["platform"] = "android"
        self.assertEqual(planner.plan_tree(self.session, tree)["items"], [])

    def test_wrong_probe_hash_or_version_cannot_reuse_a_private_plan(self):
        tree = self.session.backend.observe()
        tree["sourceIdentity"]["probeSha256"] = "0" * 64
        plan = planner.plan_tree(self.session, tree)
        self.assertEqual(plan["gaps"], ["WEBVIEW_PLAN_PROBE_IDENTITY_MISMATCH"])
        tree = self.session.backend.observe()
        tree["sourceIdentity"]["probeVersion"] = "webview-dom-probe-unknown"
        self.assertEqual(planner.plan_tree(self.session, tree)["items"], [])

    def pid_profile(self):
        self.session.backend.identity.update({"associationMethod": "xcuitest_app_main_pid_v1", "appMainPid": "8123",
                                              "context": "WEBVIEW_8123.2", "contextBundleId": "process-ObservedExecutable",
                                              "windowHandle": "8123.2"})
        self.session.config["backend"]["webview"].update({"context": "WEBVIEW_8123.2", "windowHandle": "8123.2",
            "association": {"mode": "xcuitest_app_main_pid_v1", "reportedBundleId": "process-ObservedExecutable"}})
        self.session.identity = digest(self.session.config)

    def test_explicit_pid_profile_retains_raw_alias_and_actual_app_identity_separately(self):
        self.pid_profile()
        recipe = self.learn()
        identity = recipe["webviewPlan"]["sourceIdentity"]
        self.assertEqual(identity["appId"], APP)
        self.assertEqual(identity["contextBundleId"], "process-ObservedExecutable")
        self.assertEqual(identity["appMainPid"], "8123")
        self.assertEqual(identity["associationMethod"], "xcuitest_app_main_pid_v1")
        self.assertEqual(len(self.session.backend.business), 2)

    def test_pid_profile_never_accepts_missing_child_noncanonical_or_unapproved_association(self):
        self.pid_profile()
        original = copy.deepcopy(self.session.backend.identity)
        trusted = copy.deepcopy(self.session.config["backend"]["webview"])
        for key, value in [("appMainPid", "8124"), ("appMainPid", "08123"), ("appMainPid", "0"),
                           ("appMainPid", "2147483648"), ("appMainPid", True),
                           ("context", "WEBVIEW_8123.02"), ("context", "WEBVIEW_8123.9007199254740992"),
                           ("contextBundleId", "com.other.app"), ("appId", "com.other.app")]:
            with self.subTest(key=key, value=value):
                self.session.config["backend"]["webview"] = copy.deepcopy(trusted)
                self.session.backend.identity = {**original, key: value}
                if key == "context":
                    self.session.config["backend"]["webview"]["context"] = value
                if key == "contextBundleId":
                    self.session.config["backend"]["webview"]["association"]["reportedBundleId"] = value
                self.assertEqual(self.plan()["items"], [])
        self.session.config["backend"]["webview"] = copy.deepcopy(trusted)
        for alias in ["process-_unsafe", "process-com.apple.WebKit.WebContent"]:
            self.session.config["backend"]["webview"]["association"]["reportedBundleId"] = alias
            self.session.backend.identity = {**original, "contextBundleId": alias}
            self.assertEqual(self.plan()["items"], [])
        self.session.config["backend"]["webview"] = copy.deepcopy(trusted)
        self.session.backend.identity = copy.deepcopy(original)
        self.session.backend.identity.pop("appMainPid")
        self.assertEqual(self.plan()["items"], [])
        self.session.backend.identity = copy.deepcopy(original)
        self.session.config["backend"]["webview"]["association"]["appMainPid"] = "8123"
        self.assertEqual(self.plan()["items"], [])
        self.session.config["backend"]["webview"] = copy.deepcopy(trusted)
        self.session.config["backend"]["webview"].pop("association")
        self.assertEqual(self.plan()["items"], [])

    def test_all_visible_group_inputs_need_read_permission(self):
        self.session.approved.remove(("type", "#detailField"))
        self.assertEqual(self.plan()["items"], [])

    def test_password_or_unobserved_dom_contract_cannot_be_planned(self):
        self.session.backend.nodes[1]["domContract"]["type"] = "password"
        self.assertEqual(self.plan()["items"], [])
        self.session.backend.nodes[1]["domContract"]["type"] = "text"
        self.session.backend.nodes[1]["domContract"]["liveRef"] = "untrusted-ref"
        self.assertEqual(self.plan()["items"], [])

    def test_two_samples_learning_and_reused_linear_execution_unicode(self):
        recipe = self.learn()
        self.assertEqual(recipe["recipeType"], "webview_workflow")
        self.assertEqual(len(self.session.backend.business), 2)
        params = {"cityField": " 上  海 ", "detailField": "e\u0301🙂 终 "}
        result = planner.execute_workflow(self.session, recipe, recipe["revision"], params)
        self.assertTrue(result["ok"])
        self.assertEqual(self.session.backend.business[-1], params)
        self.assertIn(params["detailField"], result["outputs"]["result"])
        self.assertTrue(result["resultFreshness"]["outputs"]["result"]["changedSinceStart"])
        self.assertFalse(self.session.backend.poisoned)

    def test_all_samples_prevalidated_before_any_type_or_clear(self):
        samples = self.samples()
        samples[1]["detailField"] = "bad\0value"
        self.assertBlocked(lambda: planner.learn_workflow(self.session, self.definition(), samples), "WEBVIEW_LITERAL_INPUT_UNSUPPORTED")
        optional = self.definition()
        optional["inputSchema"]["required"] = ["cityField"]
        missing = [self.samples()[0], {"cityField": "missing bound detail"}]
        self.assertBlocked(lambda: planner.learn_workflow(self.session, optional, missing), "WORKFLOW_INPUT_INVALID")
        self.assertEqual(self.session.backend.actions, [])

    def test_missing_freshness_or_parameter_association_rejected_before_ui(self):
        spec = self.definition()
        spec["steps"] = [s for s in spec["steps"] if s.get("expect", {}).get("containsInput") != "detailField"]
        self.assertBlocked(lambda: planner.learn_workflow(self.session, spec, self.samples()), "WEBVIEW_WORKFLOW_ALL_INPUT_RESULTS_REQUIRED")
        spec = self.definition()
        next(s for s in spec["steps"] if s["kind"] == "assert")["expect"].pop("changed")
        self.assertBlocked(lambda: planner.learn_workflow(self.session, spec, self.samples()), "WEBVIEW_WORKFLOW_FRESH_INPUT_RESULT_REQUIRED")
        self.assertEqual(self.session.backend.actions, [])

    def test_group_and_parent_contract_drift_block_before_execution(self):
        recipe = self.learn()
        count = len(self.session.backend.actions)
        self.session.backend.nodes[1]["domContract"]["parentId"] = "different-observed-parent"
        self.assertBlocked(lambda: planner.execute_workflow(self.session, recipe, recipe["revision"], self.samples()[0]), "WEBVIEW_WORKFLOW_DOM_CONTRACT_CHANGED")
        self.assertEqual(len(self.session.backend.actions), count)

    def test_revision_and_identity_are_checked_before_ui(self):
        recipe = self.learn()
        count = len(self.session.backend.actions)
        self.assertBlocked(lambda: planner.execute_workflow(self.session, recipe, "0" * 64, self.samples()[0]), "RECIPE_REVISION_MISMATCH")
        recipe["identity"] = "0" * 64
        self.assertBlocked(lambda: planner.execute_workflow(self.session, recipe, recipe["revision"], self.samples()[0]), "RECIPE_IDENTITY_MISMATCH")
        self.assertEqual(len(self.session.backend.actions), count)

    def test_partial_click_failure_keeps_unknown_and_never_replays(self):
        self.session.backend.fail_after_click = True
        self.assertBlocked(lambda: planner.learn_workflow(self.session, self.definition(), self.samples()), "WEBVIEW_TRANSPORT_OUTCOME_UNKNOWN")
        self.assertTrue(self.session.backend.poisoned)
        self.assertEqual(len(self.session.backend.business), 1)
        self.assertEqual(self.session.progress["capabilities"], {})
        count = len(self.session.backend.actions)
        self.assertBlocked(lambda: planner.learn_workflow(self.session, self.definition(), self.samples()), "WEBVIEW_PENDING_UNKNOWN")
        self.assertEqual(len(self.session.backend.actions), count)

    def test_final_checkpoint_failure_never_publishes_ready_and_latches_unknown(self):
        self.session.fail_final_checkpoint = True
        with self.assertRaises(OSError):
            self.learn()
        self.assertTrue(self.session.backend.poisoned)
        self.assertEqual(self.session.progress["capabilities"], {})
        self.assertEqual(self.session.progress["recipes"], {})
        count = len(self.session.backend.actions)
        self.assertBlocked(lambda: planner.learn_workflow(self.session, self.definition(), self.samples()), "WEBVIEW_PENDING_UNKNOWN")
        self.assertEqual(len(self.session.backend.actions), count)


class HttpProtocolIntegrationTests(unittest.TestCase):
    """Real HTTP + production sessions; the server remains an offline model."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def binding(self, state):
        from test_mobile_webview import config_for
        from apk_inventory.mobile_webview import WebViewSession
        config = config_for(state, self.temp.name, second_input=True, outside_output=True)
        session = WebViewSession(config, Path(self.temp.name) / "plan")
        with DeviceLease(session.backend):
            plan = planner.plan_tree(session, session.backend.observe())
        self.assertEqual(len(plan["items"]), 1, plan)
        spec = copy.deepcopy(plan["specs"][plan["items"][0]["id"]])
        target = spec.pop("outcomeCandidates")[0]["selector"]
        for key in spec["inputSchema"]["properties"]:
            spec["steps"].append({"kind": "assert", "selector": target, "expect": {"containsInput": key, "changed": True}, "timeoutMs": 0})
        spec["steps"].append({"kind": "extract", "selector": target, "output": "result", "valueType": "string"})
        return config, spec

    def test_two_field_http_learning_and_two_fresh_worker_calls_match_independent_ledger(self):
        from apk_inventory.mobile_webview import WebViewSession
        from webview_fixture import webview_fixture
        with webview_fixture() as state:
            config, spec = self.binding(state)
            samples = [{"query": "上海", "detail": "第一"}, {"query": "深圳", "detail": "第二"}]
            session = WebViewSession(config, Path(self.temp.name) / "learn")
            learned = planner.learn_workflow(session, spec, samples)
            recipe = copy.deepcopy(session.progress["recipes"][learned["capabilityId"]])
            calls = [{"query": " 上  海 ", "detail": "e\u0301🙂 终 "}, {"query": " 成都 ", "detail": "末🙂e\u0301"}]
            for number, values in enumerate(calls):
                fresh = WebViewSession(config, Path(self.temp.name) / ("fresh_" + str(number)))
                result = planner.execute_workflow(fresh, recipe, recipe["revision"], values)
                self.assertTrue(result["ok"])
                self.assertIn(values["query"], result["outputs"]["result"])
                self.assertIn(values["detail"], result["outputs"]["result"])
            self.assertEqual([{k: row[k] for k in ["query", "detail"]} for row in state["ledger"]], samples + calls)
            self.assertEqual(len(state["effects"]), 20)  # two clear/value pairs + one click, four queries.
            # The original intent is never cleared. Only the independently
            # bound receipt resolves it for a new trusted execution scope.
            self.assertIsNone(session.backend._pending())
            intent = read_json(Path(self.temp.name) / "shared-intent.json")
            receipt = read_json(Path(self.temp.name) / "shared-intent.json.completed.json")
            self.assertEqual(intent["schemaVersion"], 2)
            self.assertIsInstance(intent["pending"], dict)
            self.assertEqual(receipt["transportIdentity"], intent["transportIdentity"])
            self.assertEqual(receipt["completion"], {
                "executionId": intent["pending"]["executionId"], "intentSha256": digest(intent["pending"]),
                "commandCount": 5, "sourceRevision": recipe["webviewPlan"]["sourceRevision"],
                "probeSha256": PROBE_SHA256, "status": "trusted_execution_scope_completed"})
            self.assertNotIn("element-6066", json.dumps(recipe))

    def test_native_peer_lease_blocks_learning_and_planner_cli_before_first_http(self):
        from apk_inventory.mobile_webview import WebViewSession
        from webview_fixture import webview_fixture
        with webview_fixture() as state:
            config, spec = self.binding(state)
            peer = WebDriverBackend({**config["backend"], "type": "webdriver"}, Budget({}))
            calls = len(state["calls"])
            with DeviceLease(peer):
                session = WebViewSession(config, Path(self.temp.name) / "blocked")
                with self.assertRaises(MobileError) as caught:
                    planner.learn_workflow(session, spec, [{"query": "one", "detail": "a"}, {"query": "two", "detail": "b"}])
                self.assertEqual(caught.exception.code, "DEVICE_BUSY")
                config_file = Path(self.temp.name) / "config.json"
                atomic_json(config_file, config)
                run = subprocess.run([sys.executable, "-B", "-m", "apk_inventory.mobile_webview_planner", "--config", str(config_file),
                                      "--output", str(Path(self.temp.name) / "cli")], capture_output=True,
                                     env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}, timeout=10)
                self.assertEqual(run.returncode, 1, run.stderr.decode())
                self.assertEqual(json.loads(run.stdout)["error"]["code"], "DEVICE_BUSY")
            self.assertEqual(len(state["calls"]), calls)
            self.assertEqual(state["effects"], [])

    def test_real_journal_retains_unknown_after_final_checkpoint_failure(self):
        from apk_inventory.mobile_webview import WebViewSession
        from webview_fixture import webview_fixture
        with webview_fixture() as state:
            config, spec = self.binding(state)
            session = WebViewSession(config, Path(self.temp.name) / "failed")
            original = session.checkpoint

            def checkpoint():
                if session.progress.get("status") == "completed" and session.progress["capabilities"]:
                    raise OSError("synthetic completed checkpoint failure")
                return original()

            session.checkpoint = checkpoint
            samples = [{"query": "one", "detail": "a"}, {"query": "two", "detail": "b"}]
            with self.assertRaises(OSError):
                planner.learn_workflow(session, spec, samples)
            self.assertEqual(len(state["ledger"]), 2)
            self.assertEqual(session.progress["capabilities"], {})
            self.assertEqual(session.progress["recipes"], {})
            self.assertEqual(session.progress["webviewOutcome"]["status"], "unknown")
            self.assertEqual(read_json(Path(self.temp.name) / "shared-intent.json")["pending"]["status"], "unknown")
            calls, effects = len(state["calls"]), len(state["effects"])
            fresh = WebViewSession(config, Path(self.temp.name) / "different_output")
            with self.assertRaises(MobileError) as caught:
                planner.learn_workflow(fresh, spec, samples)
            self.assertEqual(caught.exception.code, "WEBVIEW_PENDING_UNKNOWN")
            self.assertEqual(len(state["calls"]), calls)
            self.assertEqual(len(state["effects"]), effects)

    def test_later_input_handler_cannot_submit_changed_earlier_value_even_with_substring(self):
        from apk_inventory.mobile_webview import WebViewSession
        from webview_fixture import webview_fixture
        with webview_fixture() as state:
            config, spec = self.binding(state)

            def after(name, command):
                if name == "query" and command == "value":
                    state["detail"] += " suffix"

            state["afterEffect"] = after
            session = WebViewSession(config, Path(self.temp.name) / "coupled")
            samples = [{"query": "alpha", "detail": "one"}, {"query": "beta", "detail": "two"}]
            with self.assertRaises(MobileError) as caught:
                planner.learn_workflow(session, spec, samples)
            self.assertEqual(caught.exception.code, "WEBVIEW_WORKFLOW_INPUT_STATE_CHANGED")
            self.assertEqual(state["detail"], "one suffix")
            self.assertEqual(state["ledger"], [])
            self.assertFalse(any(command == "click" for _, command in state["effects"]))
            self.assertFalse(hasattr(session.backend, "_before_workflow_click"))
            self.assertEqual(session.progress["capabilities"], {})
            self.assertEqual(session.progress["webviewOutcome"]["status"], "unknown")
            calls, effects = len(state["calls"]), len(state["effects"])
            fresh = WebViewSession(config, Path(self.temp.name) / "no_repeat")
            with self.assertRaises(MobileError) as caught:
                planner.learn_workflow(fresh, spec, samples)
            self.assertEqual(caught.exception.code, "WEBVIEW_PENDING_UNKNOWN")
            self.assertEqual(len(state["calls"]), calls)
            self.assertEqual(len(state["effects"]), effects)

    def test_last_backend_observation_rechecks_all_values_before_click(self):
        from apk_inventory.mobile_webview import WebViewSession
        from webview_fixture import webview_fixture
        with webview_fixture() as state:
            config, spec = self.binding(state)
            session = WebViewSession(config, Path(self.temp.name) / "late_change")
            original = session.backend.perform

            def perform(action, tree, values):
                if action["kind"] == "click":
                    # Occurs after the engine's read and proxy guard. The
                    # backend's newer observation must still catch it.
                    state["detail"] += " suffix"
                return original(action, tree, values)

            session.backend.perform = perform
            with self.assertRaises(MobileError) as caught:
                planner.learn_workflow(session, spec, [{"query": "alpha", "detail": "one"}, {"query": "beta", "detail": "two"}])
            self.assertEqual(caught.exception.code, "WEBVIEW_WORKFLOW_INPUT_STATE_CHANGED")
            self.assertEqual(state["ledger"], [])
            self.assertFalse(any(command == "click" for _, command in state["effects"]))
            self.assertFalse(hasattr(session.backend, "_before_workflow_click"))


if __name__ == "__main__":
    unittest.main()
