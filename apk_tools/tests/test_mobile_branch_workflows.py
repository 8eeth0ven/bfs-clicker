"""Native fork learning and replay through real local W3C requests."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from apk_inventory.mobile_ui import MobileError, MobileSession, digest
from apk_inventory.mobile_planner import plan_tree
from apk_inventory.mobile_workflows import learn_workflow
from native_branch_fixture import branch_app


SAMPLES = [
    {"query": "alpha", "route": "left", "detail": "one"},
    {"query": "gamma", "route": "right", "detail": "three"},
    {"query": "beta", "route": "left", "detail": "two"},
    {"query": "delta", "route": "right", "detail": "four"},
]


def ui_calls(rows):
    return [row for row in rows if row[0] == "POST" and
            ("/element/" in row[1] or row[1].endswith(("/back", "/actions")))]


class NativeBranchWorkflowTests(unittest.TestCase):
    def definition(self, app, root):
        MobileSession(app["config"], root / "explore").explore()
        checkpoint = json.loads((root / "explore/checkpoint.json").read_text())
        events = [json.loads(row) for row in (root / "explore/events.jsonl").read_text().splitlines()]
        planner = MobileSession(app["config"], root / "plan")
        result = plan_tree(planner, planner.backend.observe(), checkpoint, events)
        item = next(row for row in result["items"] if row.get("planningMode") == "native-branch-stages-v1")
        definition = copy.deepcopy(result["specs"][item["id"]])
        target = definition.pop("outcomeCandidates")[0]
        for arm in definition["branchPlan"]["arms"]:
            child = arm["definition"]
            child.pop("outcomeCandidates")
            wanted = target["armTargets"][arm["id"]]["selector"]
            for local in arm["inputMap"].values():
                child["steps"].append({"kind": "assert", "selector": wanted,
                    "expect": {"containsInput": local, "changed": True}, "timeoutMs": 100})
            child["steps"].append({"kind": "extract", "selector": wanted, "output": "result"})
        return definition

    def learned(self, app, root, samples=SAMPLES):
        definition = self.definition(app, root)
        session = MobileSession(app["config"], root / "learn")
        result = learn_workflow(session, definition, samples)
        recipe = next(iter(session.progress["recipes"].values()))
        return definition, recipe, result

    def test_both_platforms_learn_four_samples_and_select_both_arms_from_fresh_source(self):
        for platform in ["android", "ios"]:
            with self.subTest(platform=platform), branch_app(platform) as app, tempfile.TemporaryDirectory() as out:
                root = Path(out)
                definition, recipe, learning = self.learned(app, root)
                self.assertEqual(len(app["business"]), 6)
                self.assertEqual(set(recipe["controlContracts"]), {"left", "right"})
                for row in learning["branchCoverage"].values():
                    self.assertEqual(row["sampleCount"], 2)
                    self.assertEqual(row["distinctInputSamples"], 2)
                    self.assertEqual(row["distinctResultSamples"], 2)
                for number, route in enumerate(["left", "right"]):
                    inputs = {"query": "epsilon-" + route, "route": route, "detail": "five-" + route}
                    session = MobileSession(app["config"], root / ("run-" + route))
                    result = session.execute(recipe, recipe["revision"], inputs)
                    self.assertEqual(result["branchSelection"], {"armId": route,
                        "freshPositiveStructuralMatch": True, "automaticRetry": False})
                    self.assertIn("RESULT " + inputs["query"] + " / " + inputs["detail"] + " / " + route, result["outputs"]["result"])
                    self.assertEqual(len(app["business"]), 7 + number)
                    self.assertTrue(result["resultFreshness"]["outputs"]["result"]["changedSinceStart"])
                    self.assertTrue(result["resultFreshness"]["outputs"]["result"]["inputCorrelated"])
                self.assertEqual([row["route"] for row in app["business"][-2:]], ["left", "right"])
                self.assertEqual(len(app["business"]), 8)

    def test_boolean_fork_including_noop_false_uses_observed_arm_on_both_platforms(self):
        samples = [{**row, "route": row["route"] == "right"} for row in SAMPLES]
        for platform in ["android", "ios"]:
            with self.subTest(platform=platform), branch_app(platform, fork_kind="check") as app, tempfile.TemporaryDirectory() as out:
                root = Path(out)
                _, recipe, _ = self.learned(app, root, samples)
                self.assertEqual(len(app["business"]), 6)
                for number, (value, arm_id) in enumerate([(False, "left"), (True, "right")]):
                    result = MobileSession(app["config"], root / ("bool-" + arm_id)).execute(
                        recipe, recipe["revision"], {"query": "bool-query-" + arm_id,
                            "route": value, "detail": "bool-detail-" + arm_id})
                    self.assertEqual(result["branchSelection"]["armId"], arm_id)
                    self.assertIn(" / " + str(value).lower(), result["outputs"]["result"])
                    self.assertEqual(len(app["business"]), 7 + number)

    def test_missing_arm_samples_rejected_before_any_backend_request(self):
        with branch_app() as app, tempfile.TemporaryDirectory() as out:
            root = Path(out)
            definition = self.definition(app, root)
            session = MobileSession(app["config"], root / "bad-samples")
            before = len(app["calls"])
            with self.assertRaises(MobileError) as caught:
                learn_workflow(session, definition, [{"query": "q" + str(i), "detail": "d" + str(i), "route": "left"} for i in range(4)])
            self.assertEqual(caught.exception.code, "NATIVE_BRANCH_REQUIRES_TWO_DIFFERENT_SAMPLES_PER_ARM")
            self.assertEqual(app["calls"][before:], [])
            self.assertFalse(session.progress["recipes"])

    def test_unselected_arm_permission_preflight_stops_before_any_backend_request(self):
        with branch_app() as app, tempfile.TemporaryDirectory() as out:
            root = Path(out)
            definition = self.definition(app, root)
            session = MobileSession(app["config"], root / "bad-permission")
            original = session.policy
            session.policy = lambda action: (False, "unknown") if action.get("selector") == app["identify"]("right_search") else original(action)
            before = len(app["calls"])
            with self.assertRaises(MobileError) as caught:
                learn_workflow(session, definition, SAMPLES)
            self.assertEqual(caught.exception.code, "WORKFLOW_ACTION_NOT_READ_ALLOWLISTED")
            self.assertEqual(app["calls"][before:], [])

    def test_wrong_unknown_ambiguous_context_and_disconnected_forks_do_not_dispatch_any_arm(self):
        for fault in ["wrongRoute", "unknownBranch", "ambiguousBranch", "contextAfterNext", "disconnectNext"]:
            with self.subTest(fault=fault), branch_app() as app, tempfile.TemporaryDirectory() as out:
                root = Path(out)
                _, recipe, _ = self.learned(app, root)
                before_calls, before_next = len(app["calls"]), app["nextCount"]
                session = MobileSession(app["config"], root / "uncertain")
                original = session.backend.perform
                def inject_at_fork(action, tree, inputs):
                    if action.get("kind") == "click" and action.get("selector") == app["identify"]("next"):
                        app[fault] = "WEBVIEW_app" if fault == "contextAfterNext" else True
                    return original(action, tree, inputs)
                session.backend.perform = inject_at_fork
                with self.assertRaises(MobileError):
                    session.execute(recipe, recipe["revision"], {"query": "other", "detail": "new", "route": "left"})
                self.assertEqual(len(app["business"]), 6)
                self.assertEqual(app["nextCount"], before_next + 1)
                self.assertIs(session.progress["pending"]["branchFork"], True)
                self.assertEqual(session.progress["pending"]["branchSelection"], "unknown")
                added = app["calls"][before_calls:]
                self.assertFalse(any("_detail/" in route or "_alternate_detail/" in route or "_left_search/" in route or "_right_search/" in route for method, route, body in ui_calls(added)))
                app["context"] = "NATIVE_APP"
                app.pop("contextAfterNext", None)
                resumed = MobileSession(app["config"], root / "uncertain", resume=True)
                before_retry = len(app["calls"])
                with self.assertRaises(MobileError) as blocked:
                    resumed.execute(recipe, recipe["revision"], {"query": "other", "detail": "new", "route": "left"})
                self.assertEqual(blocked.exception.code, "NATIVE_BRANCH_RESUME_REQUIRES_FRESH_RUN")
                self.assertEqual(ui_calls(app["calls"][before_retry:]), [])
                self.assertEqual(app["nextCount"], before_next + 1)
                self.assertEqual(len(app["business"]), 6)

    def test_webview_at_start_and_missing_arm_coverage_never_dispatch(self):
        with branch_app() as app, tempfile.TemporaryDirectory() as out:
            root = Path(out)
            _, recipe, _ = self.learned(app, root)
            app["context"] = "WEBVIEW_app"
            before = len(app["calls"])
            with self.assertRaises(MobileError) as context:
                MobileSession(app["config"], root / "bad-context").execute(recipe, recipe["revision"], SAMPLES[0])
            self.assertEqual(context.exception.code, "NATIVE_BRANCH_CONTEXT_UNVERIFIED")
            self.assertEqual(ui_calls(app["calls"][before:]), [])
            app["context"] = "NATIVE_APP"
            broken = copy.deepcopy(recipe)
            broken["learningEvidence"]["branchCoverage"]["right"]["sampleCount"] = 1
            broken["revision"] = digest({key: value for key, value in broken.items() if key != "revision"})
            before = len(app["calls"])
            with self.assertRaises(MobileError) as coverage:
                MobileSession(app["config"], root / "bad-coverage").execute(broken, broken["revision"], SAMPLES[0])
            self.assertEqual(coverage.exception.code, "NATIVE_BRANCH_NOT_OBSERVED_WITH_VARIATION_PER_ARM")
            self.assertEqual(app["calls"][before:], [])

    def test_failed_fork_completion_checkpoint_keeps_unknown_intent_in_memory_and_on_disk(self):
        with branch_app() as app, tempfile.TemporaryDirectory() as out:
            root = Path(out)
            _, recipe, _ = self.learned(app, root)
            session = MobileSession(app["config"], root / "checkpoint-failure")
            event, checkpoint = session.event, session.checkpoint
            selected = [False]
            def record(kind, **fields):
                result = event(kind, **fields)
                if kind == "workflow_branch_selected":
                    selected[0] = True
                return result
            def fail_completion():
                if selected[0] and session.progress.get("pending") is None:
                    raise OSError("owned fixture completion checkpoint failure")
                return checkpoint()
            session.event, session.checkpoint = record, fail_completion
            before_next = app["nextCount"]
            with self.assertRaises(OSError):
                session.execute(recipe, recipe["revision"], {"query": "new-query", "detail": "new-detail", "route": "left"})
            self.assertIs(session.progress["pending"]["branchFork"], True)
            saved = json.loads((root / "checkpoint-failure/checkpoint.json").read_text())
            self.assertIs(saved["pending"]["branchFork"], True)
            self.assertEqual(app["nextCount"], before_next + 1)
            self.assertEqual(len(app["business"]), 6)
            for retry in [session, MobileSession(app["config"], root / "checkpoint-failure", resume=True)]:
                before_calls = len(app["calls"])
                with self.assertRaises(MobileError) as blocked:
                    retry.execute(recipe, recipe["revision"], SAMPLES[0])
                self.assertEqual(blocked.exception.code, "NATIVE_BRANCH_RESUME_REQUIRES_FRESH_RUN")
                self.assertEqual(ui_calls(app["calls"][before_calls:]), [])
                self.assertEqual(app["nextCount"], before_next + 1)
                self.assertEqual(len(app["business"]), 6)

    def test_result_control_drift_after_first_sample_never_publishes_ready(self):
        with branch_app() as app, tempfile.TemporaryDirectory() as out:
            root = Path(out)
            definition = self.definition(app, root)
            app["resultControlAfterSearch"] = 3
            learner = MobileSession(app["config"], root / "drift")
            with self.assertRaises(MobileError):
                learn_workflow(learner, definition, SAMPLES)
            self.assertEqual(len(app["business"]), 3)
            self.assertFalse(learner.progress["recipes"])
            self.assertFalse(learner.progress["capabilities"])


if __name__ == "__main__":
    unittest.main()
