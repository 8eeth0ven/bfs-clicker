"""Coherent result snapshots; HTTP fixtures remain models, not device proof."""
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from apk_inventory import mobile_webview_planner as planner
from apk_inventory import mobile_workflows as linear
from apk_inventory.mobile_ui import DeviceLease, MobileError, read_json
from apk_inventory.mobile_webview import WebViewSession
from test_mobile_webview import config_for
from test_mobile_webview_planner import Backend, Session, node
from webview_fixture import webview_fixture


TARGET = {"resourceId": "#independentResult"}
OTHER = {"resourceId": "#otherResult"}
INPUTS = {"cityField": "FIRST", "detailField": "SECOND"}
MODE = "same_output_snapshot_v1"


def definition(timeout=0):
    return {"schemaVersion": 1, "id": "coherent_query", "effect": "read",
            "inputSchema": {"type": "object", "properties": {
                key: {"type": "string", "maxLength": 80} for key in INPUTS},
                "required": list(INPUTS), "additionalProperties": False},
            "steps": [
                {"kind": "type", "selector": {"resourceId": "#cityField"}, "input": "cityField", "replace": True},
                {"kind": "type", "selector": {"resourceId": "#detailField"}, "input": "detailField", "replace": True},
                {"kind": "click", "selector": {"resourceId": "#lookupAction"}},
                {"kind": "assert", "selector": TARGET, "expect": {"containsInput": "cityField", "changed": True}, "timeoutMs": timeout},
                {"kind": "assert", "selector": TARGET, "expect": {"containsInput": "detailField", "changed": True}, "timeoutMs": timeout},
                {"kind": "extract", "selector": TARGET, "output": "result"}]}


class Clock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class FramesBackend(Backend):
    def __init__(self, frames, clock=None, read_cost=0):
        super().__init__()
        self.nodes.append(node("#otherResult", "output", None))
        self.frames, self.clock, self.read_cost = frames, clock, read_cost
        self.reads, self.result_reads = 0, 0
        self.on_result_read = None

    def observe(self, *args, **kwargs):
        self.reads += 1
        frame = {}
        if self.business:
            frame = self.frames[min(self.result_reads, len(self.frames) - 1)]
            frame = frame if isinstance(frame, dict) else {TARGET["resourceId"]: frame}
            self.result_reads += 1
            self.text = frame.get(TARGET["resourceId"], "")
            if self.clock:
                self.clock.now += self.read_cost
            if self.on_result_read:
                self.on_result_read(self.result_reads)
        tree = super().observe(*args, **kwargs)
        for row in tree["nodes"]:
            if row["resourceId"] == OTHER["resourceId"]:
                row["text"] = frame.get(OTHER["resourceId"], "Other")
        return tree


class CoherentAssertionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.sessions = 0

    def session(self, frames, clock=None, read_cost=0):
        self.sessions += 1
        session = Session(Path(self.temp.name) / str(self.sessions))
        session.backend = FramesBackend(frames, clock, read_cost)
        return session

    def run_query(self, session, spec=None, coherent=True):
        spec = definition() if spec is None else spec
        with session.execution():
            return linear._run(session, spec, INPUTS, [None] * len(spec["steps"]), coherent_result_assertions=coherent)

    def assert_error(self, code, operation):
        with self.assertRaises(MobileError) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)

    def test_one_snapshot_counts_each_predicate_and_keeps_extraction_and_final_reads(self):
        session = self.session(["FIRST SECOND"])
        result = self.run_query(session)
        self.assertEqual(result["assertionsPassed"], 2)
        self.assertEqual(result["resultFreshness"]["changedAssertions"], 2)
        self.assertEqual(result["resultFreshness"]["inputCorrelatedAssertions"], 2)
        self.assertEqual(result["resultFreshness"]["assertionObservationMode"], MODE)
        self.assertEqual(session.backend.result_reads, 3)
        events = [row for row in session.events if row["kind"] == "workflow_assertion_passed"]
        self.assertEqual([row["step"] for row in events], [3, 4])
        self.assertTrue(all(row["assertionGroupSteps"] == [3, 4] for row in events))
        self.assertTrue(all(row["assertionObservationMode"] == MODE for row in events))

    def test_native_default_stays_sequential_while_coherent_rejects_split_frames(self):
        sequential = self.session(["FIRST", "SECOND"])
        result = self.run_query(sequential, coherent=False)
        self.assertEqual(result["outputs"], {"result": "SECOND"})
        self.assertEqual(sequential.backend.result_reads, 4)
        self.assertNotIn("assertionObservationMode", result["resultFreshness"])
        coherent = self.session(["FIRST", "SECOND"])
        self.assert_error("WORKFLOW_FRESHNESS_NOT_OBSERVED", lambda: self.run_query(coherent))
        self.assertEqual(coherent.backend.result_reads, 1)
        self.assertEqual(len(coherent.backend.business), 1)
        self.assertEqual(len(coherent.backend.actions), 3)

    def test_same_target_assertions_separated_by_other_target_still_form_one_group(self):
        spec = definition()
        spec["steps"].insert(4, {"kind": "assert", "selector": OTHER, "expect": {"equals": "Other"}, "timeoutMs": 0})
        for frames, succeeds in [(["FIRST SECOND"], True), (["FIRST", "SECOND"], False)]:
            with self.subTest(succeeds=succeeds):
                session = self.session(frames)
                if succeeds:
                    result = self.run_query(session, spec)
                    self.assertEqual(result["assertionsPassed"], 3)
                    self.assertEqual(session.backend.result_reads, 4)
                    events = [row for row in session.events if row["kind"] == "workflow_assertion_passed"]
                    self.assertEqual([row["step"] for row in events], [3, 5, 4])
                    self.assertEqual(events[0]["assertionGroupSteps"], [3, 5])
                else:
                    self.assert_error("WORKFLOW_FRESHNESS_NOT_OBSERVED", lambda: self.run_query(session, spec))
                    self.assertEqual(session.backend.result_reads, 1)

    def test_extraction_between_assertions_requires_all_same_target_predicates_first(self):
        spec = definition()
        spec["steps"][4], spec["steps"][5] = spec["steps"][5], spec["steps"][4]
        session = self.session(["FIRST SECOND"])
        result = self.run_query(session, spec)
        self.assertEqual(result["assertionsPassed"], 2)
        self.assertEqual(result["outputs"], {"result": "FIRST SECOND"})
        self.assertEqual(session.backend.result_reads, 3)
        events = [row for row in session.events if row["kind"] == "workflow_assertion_passed"]
        self.assertEqual(events[0]["assertionGroupSteps"], [3, 5])
        session = self.session(["FIRST", "SECOND"])
        self.assert_error("WORKFLOW_FRESHNESS_NOT_OBSERVED", lambda: self.run_query(session, spec))
        self.assertEqual(session.backend.result_reads, 1)

    def test_later_joint_frame_satisfies_group_without_repeating_ui(self):
        clock = Clock()
        session = self.session(["FIRST", "FIRST SECOND"], clock, .01)
        with patch.object(linear, "time", clock):
            result = self.run_query(session, definition(200))
        self.assertEqual(result["outputs"], {"result": "FIRST SECOND"})
        self.assertEqual(session.backend.result_reads, 4)
        self.assertEqual(len(session.backend.business), 1)
        self.assertEqual(len(session.backend.actions), 3)

    def test_extraction_and_final_reverification_independently_reject_changed_results(self):
        for frames, reads in [(["FIRST SECOND", "SECOND"], 2), (["FIRST SECOND", "FIRST SECOND", "SECOND"], 3)]:
            with self.subTest(reads=reads):
                session = self.session(frames)
                self.assert_error("WORKFLOW_RESULT_CHANGED_AFTER_ASSERTION", lambda: self.run_query(session))
                self.assertEqual(session.backend.result_reads, reads)
                self.assertEqual(len(session.backend.business), 1)

    def test_group_uses_shortest_deadline_once_without_resetting_per_member(self):
        clock = Clock()
        session = self.session(["FIRST", "SECOND"], clock, .03)
        spec = definition(400)
        spec["steps"][4]["timeoutMs"] = 120
        with patch.object(linear, "time", clock):
            self.assert_error("WORKFLOW_FRESHNESS_NOT_OBSERVED", lambda: self.run_query(session, spec))
        self.assertEqual(session.backend.result_reads, 2)
        self.assertAlmostEqual(clock.now, .12)
        self.assertFalse(any(row["kind"] == "workflow_assertion_passed" for row in session.events))

    def test_positive_deadline_rejects_matching_snapshot_delivered_too_late(self):
        clock = Clock()
        session = self.session(["FIRST SECOND"], clock, .11)
        with patch.object(linear, "time", clock):
            self.assert_error("WORKFLOW_FRESHNESS_NOT_OBSERVED", lambda: self.run_query(session, definition(100)))
        self.assertEqual(session.backend.result_reads, 1)

    def test_zero_timeout_preserves_one_bounded_read_without_polling(self):
        clock = Clock()
        session = self.session(["FIRST SECOND"], clock, .2)
        with patch.object(linear, "time", clock):
            result = self.run_query(session)
        self.assertEqual(result["outputs"], {"result": "FIRST SECOND"})
        self.assertEqual(session.backend.result_reads, 3)
        self.assertAlmostEqual(clock.now, .6)

    def test_global_cancel_and_budget_interrupt_group_without_more_ui(self):
        for code in ["STOPPED", "DURATION_BUDGET"]:
            with self.subTest(code=code):
                session = self.session(["FIRST", "FIRST SECOND"])
                if code == "STOPPED":
                    session.backend.on_result_read = lambda _: setattr(session.budget, "cancelled", True)
                else:
                    session.backend.on_result_read = lambda _: setattr(session.budget, "started", session.budget.started - 6)
                self.assert_error(code, lambda: self.run_query(session, definition(1000)))
                self.assertEqual(session.backend.result_reads, 1)
                self.assertEqual(len(session.backend.business), 1)
                self.assertEqual(len(session.backend.actions), 3)

    def test_unsupported_shapes_fail_before_first_observation_or_action(self):
        bad = []
        for key in ["stagePlan", "branchPlan", "entryPrefix"]:
            spec = definition()
            spec[key] = {}
            bad.append((key, spec, None))
        spec = definition()
        spec["steps"].append(copy.deepcopy(spec["steps"][0]))
        bad.append(("later_ui", spec, None))
        spec = definition()
        spec["steps"].insert(3, {"kind": "swipe", "selector": TARGET, "direction": "up"})
        bad.append(("swipe", spec, None))
        bad.append(("branch_context", definition(), {}))
        for name, spec, branch_context in bad:
            with self.subTest(shape=name):
                session = self.session(["FIRST SECOND"])
                self.assert_error("WORKFLOW_COHERENT_ASSERTION_SHAPE_UNSUPPORTED", lambda: linear._run(
                    session, spec, INPUTS, [None] * len(spec["steps"]), branch_context, coherent_result_assertions=True))
                self.assertEqual(session.backend.reads, 0)
                self.assertEqual(session.backend.actions, [])

    def test_webview_freshness_requires_explicit_coherent_mode_metadata(self):
        freshness = {"outputs": {"result": {"changedSinceStart": True, "inputCorrelated": True}}}
        self.assert_error("WEBVIEW_WORKFLOW_OUTPUT_FRESHNESS_UNVERIFIED", lambda: planner._freshness(freshness))
        planner._freshness({**freshness, "assertionObservationMode": MODE})


class CoherentWebViewHttpTests(unittest.TestCase):
    """Real production sessions/HTTP; independent protocol models only."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def binding(self, state, timeout=1000, directory=None):
        directory = self.temp.name if directory is None else directory
        config = config_for(state, directory, second_input=True, outside_output=True)
        session = WebViewSession(config, Path(directory) / "plan")
        with DeviceLease(session.backend):
            plan = planner.plan_tree(session, session.backend.observe())
        self.assertEqual(len(plan["items"]), 1)
        spec = copy.deepcopy(plan["specs"][plan["items"][0]["id"]])
        target = spec.pop("outcomeCandidates")[0]["selector"]
        for key in spec["inputSchema"]["properties"]:
            spec["steps"].append({"kind": "assert", "selector": target,
                                  "expect": {"containsInput": key, "changed": True}, "timeoutMs": timeout})
        spec["steps"].append({"kind": "extract", "selector": target, "output": "result"})
        return config, spec

    def test_split_frames_fail_learning_and_durable_unknown_blocks_fresh_worker_before_http(self):
        for platform, effects, layout in [("ios", 5, "adjacent"), ("android", 7, "adjacent"), ("android", 7, "extract_between")]:
            with self.subTest(platform=platform, layout=layout), webview_fixture(platform) as state, tempfile.TemporaryDirectory() as work:
                config, spec = self.binding(state, 400, work)
                if layout == "extract_between":
                    spec["steps"][-1], spec["steps"][-2] = spec["steps"][-2], spec["steps"][-1]
                seen = []

                def on_probe(_):
                    if state["ledger"]:
                        # Each production observe compares two fixed probes.
                        # Change only between complete observations, otherwise
                        # the backend itself rejects an internally torn read.
                        value = state["input"] if (len(seen) // 2) % 2 == 0 else state["detail"]
                        state["result"] = value
                        seen.append(value)

                state["onProbe"] = on_probe
                session = WebViewSession(config, Path(work) / "learn")
                samples = [{"query": "FIRST", "detail": "SECOND"}, {"query": "THIRD", "detail": "FOURTH"}]
                with self.assertRaises(MobileError) as caught:
                    planner.learn_workflow(session, spec, samples)
                self.assertEqual(caught.exception.code, "WORKFLOW_FRESHNESS_NOT_OBSERVED")
                self.assertGreaterEqual(len(seen), 2)
                self.assertEqual(set(seen), {"FIRST", "SECOND"})
                self.assertFalse(session.progress["capabilities"])
                self.assertFalse(session.progress["recipes"])
                self.assertEqual(session.progress["webviewOutcome"]["status"], "unknown")
                self.assertEqual(len(state["effects"]), effects)
                self.assertEqual(len(state["ledger"]), 1)
                journal = Path(work) / "shared-intent.json"
                self.assertEqual(read_json(journal)["pending"]["status"], "unknown")
                self.assertFalse(Path(str(journal) + ".completed.json").exists())
                before = (len(state["calls"]), len(state["effects"]), len(state["ledger"]))
                fresh = WebViewSession(config, Path(work) / "fresh")
                with self.assertRaises(MobileError) as caught:
                    planner.learn_workflow(fresh, spec, samples)
                self.assertEqual(caught.exception.code, "WEBVIEW_PENDING_UNKNOWN")
                self.assertEqual((len(state["calls"]), len(state["effects"]), len(state["ledger"])), before)

    def test_interleaved_extract_joint_frame_learns_then_fresh_worker_executes(self):
        with webview_fixture("android") as state:
            config, spec = self.binding(state, 1500)
            spec["steps"][-1], spec["steps"][-2] = spec["steps"][-2], spec["steps"][-1]
            per_query = {}

            def on_probe(_):
                if state["ledger"]:
                    query = len(state["ledger"])
                    per_query[query] = per_query.get(query, 0) + 1
                    state["result"] = state["input"] if per_query[query] <= 4 else (
                        state["input"] + " / " + state["detail"] + " ;" + str(query))

            state["onProbe"] = on_probe
            samples = [{"query": " 第一🙂e\u0301 ", "detail": "甲"}, {"query": "第二🙂e\u0301", "detail": " 乙 "}]
            session = WebViewSession(config, Path(self.temp.name) / "learn")
            learned = planner.learn_workflow(session, spec, samples)
            recipe = session.progress["recipes"][learned["capabilityId"]]
            self.assertTrue(all(row["resultFreshness"]["assertionObservationMode"] == MODE
                                for row in recipe["learningEvidence"]["samples"]))
            values = {"query": " 第三🙂e\u0301 ", "detail": "终"}
            fresh = WebViewSession(config, Path(self.temp.name) / "execute")
            result = planner.execute_workflow(fresh, recipe, recipe["revision"], values)
            self.assertEqual(result["resultFreshness"]["assertionObservationMode"], MODE)
            self.assertEqual(result["assertionsPassed"], 2)
            self.assertEqual(result["outputs"], {"result": values["query"] + " / " + values["detail"] + " ;3"})
            self.assertEqual([{key: row[key] for key in ["query", "detail"]} for row in state["ledger"]], samples + [values])
            self.assertEqual(len(state["effects"]), 21)
            self.assertIsNone(fresh.backend._pending())

    def test_interleaved_extract_still_requires_each_input_correlation_and_changed_contract(self):
        with webview_fixture("android") as state:
            config, spec = self.binding(state)
            spec["steps"][-1], spec["steps"][-2] = spec["steps"][-2], spec["steps"][-1]
            spec["steps"][-1]["expect"].pop("changed")
            before = len(state["calls"])
            session = WebViewSession(config, Path(self.temp.name) / "rejected")
            with self.assertRaises(MobileError) as caught:
                planner.learn_workflow(session, spec, [{"query": "one", "detail": "a"}, {"query": "two", "detail": "b"}])
            self.assertEqual(caught.exception.code, "WEBVIEW_WORKFLOW_FRESH_INPUT_RESULT_REQUIRED")
            self.assertEqual(len(state["calls"]), before)
            self.assertEqual(state["effects"], [])


if __name__ == "__main__":
    unittest.main()
