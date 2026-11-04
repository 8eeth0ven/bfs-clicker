"""Synthetic retained-protocol/AX tests only: no device, network or OCR."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import string
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("ios_key_sequence_audit", ROOT / "test/ios-keyboard-key-sequence-audit.py")
audit_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit_module)
CONTROLS = {
    "shift": {"type": "XCUIElementTypeButton", "name": "shift", "label": "shift"},
    "numbers": {"type": "XCUIElementTypeKey", "name": "more", "label": "numbers"},
    "letters": {"type": "XCUIElementTypeKey", "name": "more", "label": "letters"},
    "delete": {"type": "XCUIElementTypeKey", "name": "delete", "label": "delete"}}


def xml(layer):
    letters = string.ascii_lowercase if layer == "lower" else string.ascii_uppercase if layer == "upper" else string.digits
    rows, points = [], {}
    def add(kind, name, label, x, y, width, height, target):
        rows.append(f'<{kind} type="{kind}" name="{name}" label="{label}" visible="true" enabled="true" x="{x}" y="{y}" width="{width}" height="{height}"/>')
        points[target] = (int(x + width / 2), int(y + height / 2))
    for i, char in enumerate(letters):
        add("XCUIElementTypeKey", char, char, 10 + (i % 10) * 35, 500 + (i // 10) * 50, 30, 40, char)
    add("XCUIElementTypeButton", "shift", "symbols" if layer == "digits" else "shift", 10, 660, 50, 40, "shift")
    control = "letters" if layer == "digits" else "numbers"
    add("XCUIElementTypeKey", "more", control, 80, 660, 60, 40, control)
    add("XCUIElementTypeKey", "delete", "delete", 300, 660, 60, 40, "delete")
    return ('<AppiumAUT><XCUIElementTypeApplication bundleId="com.example.audit" width="400" height="800">'
            '<XCUIElementTypeKeyboard visible="true" x="0" y="480" width="400" height="300">'
            + "".join(rows) + '</XCUIElementTypeKeyboard></XCUIElementTypeApplication></AppiumAUT>'), points


def body(identity, point):
    return {"actions": [{"type": "pointer", "id": identity, "parameters": {"pointerType": "touch"}, "actions": [
        {"type": "pointerMove", "duration": 0, "x": point[0], "y": point[1], "origin": "viewport"},
        {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}]}]}


class Fixture:
    def __init__(self, directory, plan):
        self.directory = Path(directory).resolve()
        self.plan = copy.deepcopy(plan)
        self.rows, self.events, self.clock = [], [], 1000
        self.config = {"backend": {"type": "webdriver", "platform": "ios", "sessionId": "mock-session", "appId": "com.example.audit"},
                       "nativeVisualWorkflow": {"keyboard": {"region": {"x": 0, "y": .6, "width": 1, "height": .375},
                           "keyInput": {"mode": "onscreen", "controls": CONTROLS}}}}
        layer = "lower"
        for entry in plan:
            self.finger()
            ordinal = 0
            for _ in range(entry["clear"]):
                ordinal += 1
                self.key(layer, "delete", "clear", ordinal)
            for char in entry["input"]:
                wanted = "digits" if char.isdigit() else "upper" if char.isupper() else "lower"
                if layer == "digits" and wanted != "digits":
                    ordinal += 1
                    self.key(layer, "letters", "switch", ordinal)
                    layer = "lower"
                if wanted == "digits" and layer != "digits":
                    ordinal += 1
                    self.key(layer, "numbers", "switch", ordinal)
                    layer = "digits"
                elif wanted != layer:
                    ordinal += 1
                    self.key(layer, "shift", "switch", ordinal)
                    layer = wanted
                ordinal += 1
                self.key(layer, char, "type", ordinal)
                if layer == "upper":
                    layer = "lower"
            self.finger()
            self.finger()

    def row(self, route, payload="", method="POST"):
        row = {"id": len(self.rows), "started": self.clock + 1, "finished": self.clock + 2,
               "method": method, "path": "/session/mock-session" + route,
               "body": json.dumps(payload) if payload != "" else "", "responseStatus": 200}
        self.rows.append(row)
        self.clock += 10
        return row

    def finger(self):
        self.row("/actions", body("finger", (40, 100)))

    def key(self, layer, target, phase, ordinal):
        raw, points = xml(layer)
        source = self.row("/source", method="GET")
        self.replace_source(source, raw)
        event = {"schemaVersion": 1, "kind": "visual_keyboard_key_started", "timestampMs": self.clock,
                 "ordinal": ordinal, "phase": phase, "control": "literal" if phase == "type" else target,
                 "sourceSha256": source["sourceArtifact"]["sha256"], "automaticRetry": False, "status": "unknown"}
        self.events.append(event)
        action = self.row("/actions", body("keyboard-key", points[target]))
        self.events.append({**event, "kind": "visual_keyboard_key_finished", "timestampMs": action["finished"] + 1, "status": "dispatched"})

    def replace_source(self, row, raw):
        data = raw.encode()
        name = "source-response-" + str(row["id"]) + ".xml"
        (self.directory / name).write_bytes(data)
        row["sourceArtifact"] = {"file": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}

    def key_rows(self):
        return [r for r in self.rows if r["method"] == "POST" and json.loads(r["body"])["actions"][0]["id"] == "keyboard-key"]

    def mutate_key(self, index, point=None, event=None):
        row = self.key_rows()[index]
        value = json.loads(row["body"])
        if point is not None:
            value["actions"][0]["actions"][0].update(x=point[0], y=point[1])
            row["body"] = json.dumps(value)
        if event:
            self.events[index * 2].update(event)
            self.events[index * 2 + 1].update(event)

    def run(self, **patch):
        return audit_module.audit(**{"rows": self.rows, "events": self.events, "source_dir": self.directory,
                                    "device_config": self.config, "width": 400, "height": 800, "plan": self.plan, **patch})


class OfflineSequenceTests(unittest.TestCase):
    def fixture(self, plan=None):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        return Fixture(directory.name, plan or [{"input": "alpha", "clear": 0}])

    def fails(self, f, code, **patch):
        with self.assertRaisesRegex(audit_module.AuditError, "^" + code + "$"):
            f.run(**patch)

    def test_two_complete_flows_verify_actual_all_characters_and_forty_seven_actions(self):
        f = self.fixture([{"input": "alpha", "clear": 16}, {"input": "beta", "clear": 16}])
        r = f.run()
        self.assertTrue(r["complete"] and r["usableForSuccessAcceptance"])
        self.assertEqual((r["keyActions"], r["outsideFingerActions"]), (41, 6))
        self.assertEqual([x["actualCharacters"] for x in r["flows"]], [5, 4])
        self.assertEqual(["".join(k["target"] for k in x["keys"] if k["phase"] == "type") for x in r["flows"]], ["alpha", "beta"])

    def test_mixed_case_digit_switches_are_bound_to_actual_layers(self):
        f = self.fixture([{"input": "Ab7z", "clear": 2}])
        r = f.run()
        self.assertEqual([k["target"] for k in r["flows"][0]["keys"]], ["delete", "delete", "shift", "A", "b", "numbers", "7", "letters", "z"])

    def test_negative_complete_key_plan_can_require_no_final_outside_actions(self):
        f = self.fixture([{"input": "epsilon", "clear": 16}])
        f.rows = f.rows[:-2]
        self.fails(f, "OUTSIDE_ACTIONS_AFTER_FLOW")
        r = f.run(plan=[{"input": "epsilon", "clear": 16, "finalOutside": 0}])
        self.assertTrue(r["complete"] and r["keyPlansComplete"])
        self.assertFalse(r["mcpAcceptance"])
        self.assertEqual(r["outsideFingerActions"], 1)
        self.fails(f, "PLAN_INVALID", plan=[{"input": "epsilon", "clear": 16, "finalOutside": 0}, {"input": "a", "clear": 0}])

    def test_final_prefix_is_explicit_diagnostic_only_and_default_rejects(self):
        f = self.fixture()
        f.rows, f.events = f.rows[:3], f.events[:2]
        self.fails(f, "PLAN_NOT_COMPLETE")
        r = f.run(allow_final_prefix=True)
        self.assertTrue(r["auditPassed"])
        self.assertFalse(r["complete"] or r["usableForSuccessAcceptance"])
        self.assertEqual(r["flows"][0]["actualCharacters"], 1)
        full = self.fixture().run(allow_final_prefix=True)
        self.assertTrue(full["keyPlansComplete"])
        self.assertFalse(full["complete"])

    def test_duplicate_start_unfinished_and_missing_event_are_rejected(self):
        for variant, expected in [("duplicate", "KEY_EVENT_DUPLICATE_START"), ("unfinished", "KEY_EVENT_UNFINISHED"), ("missing", "KEY_EVENT_REQUEST_COUNT_MISMATCH")]:
            with self.subTest(variant=variant):
                f = self.fixture()
                if variant == "duplicate": f.events.insert(1, copy.deepcopy(f.events[0]))
                elif variant == "unfinished": f.events.pop()
                else: f.events = f.events[2:]
                self.fails(f, expected)

    def test_repeat_wrong_character_and_clear_count_cannot_pass_by_count(self):
        for index, target in [(0, "b"), (1, "a")]:
            f = self.fixture()
            f.mutate_key(index, point=xml("lower")[1][target])
            self.fails(f, "TYPE_LITERAL_MISMATCH")
        f = self.fixture([{"input": "alpha", "clear": 1}])
        self.fails(f, "TYPE_BEFORE_CLEAR_OR_EXTRA_KEY", plan=[{"input": "alpha", "clear": 2}])

    def test_outside_key_noncenter_unknown_control_and_overlap(self):
        for point, expected in [((0, 490), "KEY_TARGET_NOT_UNIQUE"), ((10, 100), "KEY_POINT_OUTSIDE_KEYBOARD"), ((26, 520), "KEY_POINT_NOT_CENTER")]:
            f = self.fixture()
            f.mutate_key(0, point=point)
            self.fails(f, expected)
        f = self.fixture()
        f.mutate_key(0, event={"control": "unknown"})
        self.fails(f, "KEY_EVENT_INVALID")
        f = self.fixture()
        row = f.rows[1]
        raw = (f.directory / row["sourceArtifact"]["file"]).read_text().replace('x="45" y="500"', 'x="10" y="500"')
        f.replace_source(row, raw)
        f.mutate_key(0, event={"sourceSha256": row["sourceArtifact"]["sha256"]})
        self.fails(f, "KEY_TARGET_NOT_UNIQUE")

    def test_source_hash_path_utf8_symlink_and_latest_source_are_verified(self):
        f = self.fixture(); f.mutate_key(0, event={"sourceSha256": "0" * 64}); self.fails(f, "LATEST_SOURCE_EVENT_HASH_MISMATCH")
        f = self.fixture(); f.rows[1]["sourceArtifact"]["sha256"] = "0" * 64; self.fails(f, "SOURCE_HASH_MISMATCH")
        f = self.fixture(); f.rows[1]["sourceArtifact"]["file"] = "../outside.xml"; self.fails(f, "SOURCE_ARTIFACT_INVALID")
        f = self.fixture(); p = f.directory / f.rows[1]["sourceArtifact"]["file"]; p.unlink(); p.symlink_to(f.directory / "missing.xml"); self.fails(f, "SOURCE_PATH_INVALID")
        f = self.fixture(); data = b"\xff"; p = f.directory / f.rows[1]["sourceArtifact"]["file"]; p.write_bytes(data); f.rows[1]["sourceArtifact"].update(sha256=hashlib.sha256(data).hexdigest(), bytes=1); self.fails(f, "SOURCE_UTF8_INVALID")
        f = self.fixture(); f.rows[1]["finished"] = f.rows[2]["started"] + 1; self.fails(f, "LATEST_SOURCE_MISSING")

    def test_unknown_disabled_visible_button_covering_literal_center_is_ambiguous(self):
        f = self.fixture()
        row = f.rows[1]
        raw = (f.directory / row["sourceArtifact"]["file"]).read_text().replace(
            '</XCUIElementTypeKeyboard>',
            '<XCUIElementTypeButton type="XCUIElementTypeButton" name="unapproved" label="unapproved" visible="true" enabled="false" x="10" y="500" width="30" height="40"/></XCUIElementTypeKeyboard>')
        f.replace_source(row, raw)
        f.mutate_key(0, event={"sourceSha256": row["sourceArtifact"]["sha256"]})
        self.fails(f, "KEY_TARGET_NOT_UNIQUE")

    def test_extra_action_extra_flow_and_unfinished_http_fail(self):
        f = self.fixture(); f.rows[2].pop("finished"); self.fails(f, "REQUEST_UNFINISHED_OR_FAILED")
        f = self.fixture(); f.events = f.events[:-2]; self.fails(f, "KEY_EVENT_REQUEST_COUNT_MISMATCH")
        f = self.fixture([{"input": "a", "clear": 0}, {"input": "b", "clear": 0}]); self.fails(f, "EXTRA_FLOW", plan=[{"input": "a", "clear": 0}])
        f = self.fixture(); f.finger(); self.fails(f, "OUTSIDE_ACTIONS_AFTER_FLOW")

    def test_identical_old_source_cannot_be_reused_after_another_ui_action(self):
        f = self.fixture()
        f.rows[3]["path"] = "/session/mock-session/orientation"
        self.fails(f, "SOURCE_NOT_FRESH_SINCE_ACTION")

    def test_wrong_unnecessary_switch_and_unchanged_layer_fail(self):
        f = self.fixture([{"input": "A", "clear": 0}]); f.mutate_key(0, point=xml("lower")[1]["numbers"], event={"control": "numbers"}); self.fails(f, "WRONG_SWITCH_CONTROL")
        f = self.fixture(); f.mutate_key(0, point=xml("lower")[1]["shift"], event={"phase": "switch", "control": "shift"}); self.fails(f, "UNNECESSARY_OR_EXTRA_SWITCH")
        f = self.fixture([{"input": "A", "clear": 0}]); row = f.rows[3]; f.replace_source(row, xml("lower")[0]); f.mutate_key(1, event={"sourceSha256": row["sourceArtifact"]["sha256"]}); self.fails(f, "SWITCH_LAYER_NOT_CHANGED")

    def test_premature_reset_or_only_first_flow_cannot_be_success(self):
        f = self.fixture(); f.mutate_key(1, event={"ordinal": 1}); self.fails(f, "FLOW_RESET_BEFORE_PLAN_COMPLETE")
        f = self.fixture(); self.fails(f, "PLAN_NOT_COMPLETE", plan=[{"input": "alpha", "clear": 0}, {"input": "beta", "clear": 0}])

    def test_cli_is_offline_reports_hashes_and_never_overwrites_input(self):
        f = self.fixture([{"input": "a", "clear": 0}])
        names = {"requests": f.rows, "device-config": f.config, "plan": f.plan}
        argv = []
        for name, value in names.items():
            p = f.directory / (name + ".json"); p.write_text(json.dumps(value)); argv += ["--" + name, str(p)]
        p = f.directory / "events.jsonl"; p.write_text("".join(json.dumps(e) + "\n" for e in f.events))
        output = f.directory / "audit.json"
        command = [sys.executable, str(ROOT / "test/ios-keyboard-key-sequence-audit.py"), *argv, "--events", str(p), "--source-dir", str(f.directory), "--width", "400", "--height", "800", "--output", str(output)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(output.read_text())
        self.assertTrue(report["complete"])
        self.assertEqual(len(report["nativeSourceSnapshot"]), 6)
        before = output.read_bytes()
        duplicate = subprocess.run(command, capture_output=True, text=True, timeout=15)
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertEqual(output.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
