from __future__ import annotations

import io
import json
import os
import subprocess
import stat
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from apk_inventory.mitm_addon import BodyCapture, CaptureAddon
from apk_inventory.reconcile import (CaptureRedactor, VerificationError, atomic_json, collect_observations, finalize_inventory,
                                     har_events, iter_jsonl, normalize_url, reconcile_records, sha256_file)
from apk_inventory.verify import main, parse_duration


def record(url="https://api.example.test/items", method=None, **extra):
    return {"method": method, "url": url, "headers": {}, "query": {}, "body": None,
            "categories": ["static_candidate"], "source": "hermes", "package": "bundle#string:1",
            "body_capture": "unknown", "evidence_ids": ["ev_static"], **extra}


def events(url="https://api.example.test/items", method="GET", flow="one", status=200, attribution="isolated_session"):
    return [{"event": "http_request_seen", "session_id": "fixture", "flow_id": flow,
             "method": method, "url": url, "attribution": attribution},
            {"event": "http_response_seen", "flow_id": flow, "status": status}]


class ReconciliationTests(unittest.TestCase):
    def test_method_unknown_is_completed_by_capture_not_guessed(self):
        obs, _ = collect_observations(events())
        output, report = reconcile_records([record()], obs)
        self.assertEqual(output[0]["method"], "GET")
        self.assertEqual(output[0]["source"], "hermes")
        self.assertEqual(output[0]["categories"], ["observed"])
        self.assertEqual(output[0]["method_origin"], "network")
        self.assertEqual(report["matched_unknown_method_candidates"], 1)
        self.assertIsNone(report["known_method_coverage"])

    def test_get_cannot_upgrade_static_post(self):
        obs, _ = collect_observations(events(status=404))
        output, report = reconcile_records([record(method="POST")], obs)
        post = next(item for item in output if item["method"] == "POST")
        get = next(item for item in output if item["method"] == "GET")
        self.assertEqual(post["categories"], ["static_candidate"])
        self.assertEqual(get["source"], "network")
        self.assertEqual(get["observations"][0]["status"], 404)
        self.assertEqual(report["matched_static_candidates"], 0)

    def test_query_rpc_selectors_do_not_upgrade_a_different_action(self):
        obs, _ = collect_observations(events(url="https://api.example.test/items?action=read"))
        output, report = reconcile_records([record(method="GET", query={"action": "read"}),
                                            record(method="GET", query={"action": "write"})], obs)
        self.assertEqual(report["static_eligible"], 2)
        self.assertEqual(report["matched_static_candidates"], 1)
        self.assertEqual(report["coverage"], .5)
        write = next(row for row in output if row["query"]["action"] == "write")
        self.assertEqual(write["categories"], ["static_candidate"])

    def test_404_500_are_observed_and_connect_is_not_endpoint(self):
        inputs = events(status=404) + events(flow="two", status=500) + events(method="CONNECT", flow="connect")
        obs, stats = collect_observations(inputs)
        output, report = reconcile_records([record()], obs)
        self.assertEqual(report["observed_unique_operations"], 1)
        self.assertEqual(len(output[0]["observations"]), 2)
        self.assertEqual(stats["ignored_events"], 1)

    def test_templates_require_unique_route(self):
        obs, _ = collect_observations(events(url="https://api.example.test/users/42"))
        output, report = reconcile_records([record("https://api.example.test/users/{id}", "GET")], obs)
        self.assertEqual(output[0]["url"], "https://api.example.test/users/{id}")
        self.assertEqual(report["coverage"], 1)
        output, report = reconcile_records([record("https://api.example.test/users/{id}", "GET"),
                                            record("https://api.example.test/users/{name}", "GET")], obs)
        self.assertEqual(report["ambiguous_match_count"], 1)
        self.assertEqual(report["matched_static_candidates"], 0)
        self.assertEqual(sum("static_candidate" in row["categories"] for row in output), 2)

    def test_unattributed_and_scope_are_not_coverage(self):
        inputs = events(attribution="unattributed") + events(url="https://other.test/items", flow="outside")
        obs, stats = collect_observations(inputs, {"https://api.example.test"})
        output, report = reconcile_records([record()], obs, {"https://api.example.test"})
        self.assertEqual(report["coverage"], 0)
        self.assertEqual(report["unattributed_flows"], 1)
        self.assertEqual(stats["out_of_scope_flows"], 1)
        self.assertEqual(output[0]["method"], None)
        _, empty = reconcile_records([], obs)
        self.assertIsNone(empty["coverage"])

    def test_multivalue_query_blanks_and_secret_redaction(self):
        first = events(url="https://API.example.test:443/items?tag=a&tag=b&empty=&token=notpublic&q=credential-xyz")
        first[0]["headers"] = {"Authorization": "Bearer credential-xyz", "Cookie": "sid=cookie-xyz", "Content-Type": "application/json"}
        obs, _ = collect_observations(first)
        self.assertEqual(obs[0]["query"]["tag"], ["a", "b"])
        self.assertEqual(obs[0]["query"]["empty"], "")
        text = json.dumps(obs)
        self.assertNotIn("credential-xyz", text)
        self.assertNotIn("cookie-xyz", text)
        self.assertNotIn("notpublic", text)
        self.assertEqual(obs[0]["url"], "https://api.example.test/items")

    def test_shape_preserves_parameter_names_without_secret_values(self):
        inputs = events()
        inputs.append({"event": "http_request_shape", "flow_id": "one", "body_capture": "shape_only", "body_present": True,
                       "body_shape": {"type": "object", "properties": {"token": {"type": "string", "example": "notpublic"}}}})
        obs, _ = collect_observations(inputs)
        self.assertEqual(obs[0]["body_shape"]["properties"]["token"], {"type": "string"})
        self.assertNotIn("notpublic", json.dumps(obs))

    def test_multiple_body_and_query_samples_keep_union_shapes(self):
        data = events(url="https://api.example.test/items?tag=single", method="POST", flow="one")
        data += [{"event": "http_request_shape", "flow_id": "one", "body_capture": "shape_only", "body_present": True,
                  "body_shape": {"type": "object", "properties": {"value": {"type": "integer"}}}}]
        data += events(url="https://api.example.test/items?tag=one&tag=two", method="POST", flow="two")
        data += [{"event": "http_request_shape", "flow_id": "two", "body_capture": "shape_only", "body_present": True,
                  "body_shape": {"type": "object", "properties": {"value": {"type": "string"}, "optional": {"type": "boolean"}}}}]
        observations, _ = collect_observations(data)
        output, _ = reconcile_records([record(method="POST")], observations)
        self.assertEqual(len(output), 1)
        body = output[0]["body_shape"]
        self.assertEqual({item["type"] for item in body["properties"]["value"]["anyOf"]}, {"integer", "string"})
        self.assertNotIn("required", body)
        self.assertEqual({item["type"] for item in output[0]["query_shape"]["properties"]["tag"]["anyOf"]}, {"string", "array"})

    def test_redaction_markers_remain_idempotent_with_new_secrets(self):
        redactor = CaptureRedactor()
        redactor.remember_headers([("Authorization", "Bearer private-secret")])
        once = redactor.value({"token": "new-token", "note": "private-secret"})
        redactor.remember_headers([("Cookie", "sid=RED")])
        twice = redactor.value(once)
        self.assertEqual(once, twice)
        self.assertEqual(redactor.text("private-secret RED"), "[REDACTED] [REDACTED]")

    def test_out_of_order_response_is_merged(self):
        data = events()
        obs, _ = collect_observations(list(reversed(data)))
        self.assertEqual(obs[0]["status"], 200)
        self.assertEqual(obs[0]["transport"], "response_seen")

    def test_derived_inventory_is_atomic_and_keeps_original(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            apk = root / "demo.apk"
            apk.write_bytes(b"fixture apk")
            static = root / "endpoints.static.json"
            atomic_json(static, [record()])
            before = static.read_bytes()
            atomic_json(root / "source.json", {"format": "endpoint-inventory", "kind": "apk", "source_id": "apk_demo",
                        "schema_version": "1.1", "inventory": static.name,
                        "app": {"package_name": "com.example.demo", "apk_sha256": sha256_file(apk)}})
            summary = finalize_inventory(root, apk, events(), session_id="test")
            self.assertTrue(summary["promoted"])
            self.assertEqual(static.read_bytes(), before)
            descriptor = json.loads((root / "source.json").read_text())
            self.assertEqual(descriptor["inventory"], "verified/test/endpoints.json")
            self.assertEqual(descriptor["static_inventory"], "endpoints.static.json")
            self.assertEqual(json.loads(Path(summary["inventory"]).read_text())[0]["categories"], ["observed"])
            apk.write_bytes(b"different apk")
            with self.assertRaises(VerificationError) as mismatch:
                finalize_inventory(root, apk, events(), session_id="different")
            self.assertEqual(mismatch.exception.code, "APK_MISMATCH")

    def test_capture_cancel_preserves_active_pointer(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            apk = root / "demo.apk"
            apk.write_bytes(b"fixture")
            atomic_json(root / "endpoints.static.json", [record()])
            original = {"format": "endpoint-inventory", "kind": "apk", "inventory": "endpoints.static.json", "app": {"apk_sha256": sha256_file(apk)}}
            atomic_json(root / "source.json", original)
            finalize_inventory(root, apk, events(), session_id="cancel", promote=False)
            self.assertEqual(json.loads((root / "source.json").read_text()), original)

    def test_har_import_keeps_shapes_and_hides_credentials(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "capture.har"
            atomic_json(path, {"log": {"entries": [{"request": {"method": "POST", "url": "https://api.example.test/items?token=private",
                "headers": [{"name": "Authorization", "value": "Bearer secret-value"}],
                "postData": {"mimeType": "application/json", "text": '{"token":"private-body","count":2}'}},
                "response": {"status": 401}, "time": 12}]}})
            obs, _ = collect_observations(har_events(path, "har", "isolated_session"))
            self.assertEqual(obs[0]["status"], 401)
            self.assertEqual(obs[0]["body_shape"]["properties"]["count"], {"type": "integer"})
            text = json.dumps(obs)
            for secret in ("secret-value", "private-body", '"private"'):
                self.assertNotIn(secret, text)


class Headers(dict):
    def items(self, multi=False):
        return super().items()


class AddonTests(unittest.TestCase):
    def test_body_tee_is_identity_and_bounded(self):
        capture = BodyCapture(32)
        blocks = [b'{"token":"', b"secret" * 10000, b'"}']
        self.assertEqual(b"".join(capture.tee(block) for block in blocks), b"".join(blocks))
        self.assertEqual(len(capture.prefix), 32)
        self.assertEqual(capture.describe("application/json")["body_capture"], "truncated")
        self.assertNotIn("body_shape", capture.describe("application/json"))

    def test_body_json_null_is_not_no_body(self):
        capture = BodyCapture(100)
        capture.tee(b"null")
        result = capture.describe("application/json")
        self.assertTrue(result["body_present"])
        self.assertEqual(result["body_shape"], {"type": "null"})

    def test_addon_emits_safe_http_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            output, ready = Path(temp) / "events.jsonl", Path(temp) / "ready.json"
            addon = CaptureAddon({"output": str(output), "ready": str(ready), "session_id": "fixture",
                                  "origins": ["https://api.example.test"], "attribution": "isolated_session", "body_limit": 100})
            addon.running()
            request = SimpleNamespace(method="POST", url="https://api.example.test/items?token=private", stream=None,
                        headers=Headers({"Authorization": "Bearer very-secret", "Cookie": "sid=also-secret", "content-type": "application/json"}))
            flow = SimpleNamespace(id="one", request=request, response=SimpleNamespace(status_code=404, headers=Headers(), stream=None))
            addon.requestheaders(flow)
            raw = b'{"password":"body-secret","page":1}'
            self.assertEqual(request.stream(raw), raw)
            addon.request(flow)
            addon.responseheaders(flow)
            self.assertTrue(flow.response.stream)
            addon.response(flow)
            addon.done()
            text = output.read_text()
            for secret in ("very-secret", "also-secret", "body-secret", '"private"'):
                self.assertNotIn(secret, text)
            obs, _ = collect_observations(iter_jsonl(output))
            self.assertEqual(obs[0]["status"], 404)
            self.assertEqual(obs[0]["session_id"], "fixture")
            self.assertEqual(obs[0]["body_shape"]["properties"]["password"], {"type": "string"})
            self.assertEqual(json.loads(ready.read_text())["session_id"], "fixture")

    def test_addon_event_and_metadata_limits_are_reported_without_changing_body(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "events.jsonl"
            addon = CaptureAddon({"output": str(path), "session_id": "budget", "max_events": 4,
                                  "max_tracked": 1, "body_limit": 16})
            addon.running()
            flows = []
            for number in range(10):
                req = SimpleNamespace(method="POST", url="https://api.example.test/items", headers=Headers(), stream=None)
                flow = SimpleNamespace(id=str(number), request=req)
                addon.requestheaders(flow)
                if callable(req.stream):
                    self.assertEqual(req.stream(b"original body"), b"original body")
                else:
                    self.assertIs(req.stream, True)
                flows.append(flow)
            self.assertEqual(len(addon.eligible), 1)
            self.assertLessEqual(len(addon.active), 1)
            addon.done()
            _, counters = collect_observations(iter_jsonl(path))
            self.assertGreater(counters["capture_limit_count"], 0)
            self.assertLessEqual(len(path.read_text().splitlines()), 6)

    def test_tls_diagnostics_respect_scope(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "events.jsonl"
            addon = CaptureAddon({"output": str(path), "session_id": "tls", "origins": ["https://api.example.test"]})
            addon.running()
            outside = SimpleNamespace(conn=SimpleNamespace(sni="background.example.test"), context=None)
            inside = SimpleNamespace(conn=SimpleNamespace(sni="api.example.test"), context=None)
            addon.tls_failed_client(outside)
            addon.tls_failed_client(inside)
            addon.done()
            _, counters = collect_observations(iter_jsonl(path))
            self.assertEqual(counters["tls_failed_count"], 1)


FAKE_ADB = '''#!/usr/bin/env python3
import json,os,shlex,sys
p=os.environ['FAKE_ADB_STATE']; s=json.load(open(p)); a=sys.argv[1:]
if a and a[0]=='-s':a=a[2:]
if a==['devices']:print('List of devices attached\\nfixture-serial\\tdevice')
elif a==['get-state']:print('device')
elif a and a[0]=='install':
 if os.environ.get('FAKE_INSTALL_FAIL'):sys.exit(1)
 print('Success')
elif a[:2]==['reverse','--list']:
 for k,v in s['reverse'].items():print('fixture '+k+' '+v)
elif a[:2]==['reverse','--no-rebind']:
 if a[2] in s['reverse']:sys.exit(1)
 s['reverse'][a[2]]=a[3]
elif a[:2]==['reverse','--remove']:s['reverse'].pop(a[2],None)
elif a and a[0]=='shell':
 c=shlex.split(a[1])
 if c==['settings','list','global']:
  for k,v in s['settings'].items():print(k+'='+v)
 elif c[:3]==['settings','put','global']:s['settings'][c[3]]=c[4]
 elif c[:3]==['settings','delete','global']:s['settings'].pop(c[3],None)
 elif c[:2]==['pm','path']:print('package:/data/app/demo/base.apk')
 elif c[:3]==['cmd','package','resolve-activity']:print('com.example.demo/.MainActivity')
 elif c[:2]==['am','start']:print('Starting: Intent')
 else:sys.exit(1)
else:sys.exit(1)
json.dump(s,open(p,'w'))
'''

FAKE_MITMDUMP = '''#!/usr/bin/env python3
import json,os,signal,time
c=json.load(open(os.environ['APK_VERIFY_CONFIG']))
events=open(c['output'],'w',buffering=1)
json.dump({'event':'capture_ready','session_id':c['session_id']},open(c['ready'],'w'))
events.write(json.dumps({'event':'http_request_seen','flow_id':'f1','session_id':c['session_id'],'method':'GET','url':'https://api.example.test/items','attribution':c['attribution']})+'\\n')
events.write(json.dumps({'event':'http_response_seen','flow_id':'f1','status':200})+'\\n')
if os.environ.get('FAKE_PROXY_EXIT'):raise SystemExit(1)
signal.signal(signal.SIGINT,lambda *_:exit(0))
while True:time.sleep(.1)
'''


class RunnerTests(unittest.TestCase):
    def prepare(self, root):
        apk = root / "fixture.apk"
        apk.write_bytes(b"fixture")
        atomic_json(root / "endpoints.static.json", [record()])
        atomic_json(root / "source.json", {"format": "endpoint-inventory", "kind": "apk", "source_id": "apk_demo",
                    "inventory": "endpoints.static.json", "app": {"package_name": "com.example.demo", "apk_sha256": sha256_file(apk)}})
        adb, proxy, state = root / "fake adb", root / "fake mitmdump", root / "state.json"
        adb.write_text(FAKE_ADB)
        proxy.write_text(FAKE_MITMDUMP)
        adb.chmod(adb.stat().st_mode | stat.S_IXUSR)
        proxy.chmod(proxy.stat().st_mode | stat.S_IXUSR)
        atomic_json(state, {"settings": {"http_proxy": "old.proxy:3128"}, "reverse": {"tcp:3333": "tcp:4444"}})
        return apk, adb, proxy, state

    def test_live_runner_ready_capture_and_owned_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            apk, adb, proxy, state = self.prepare(root)
            output = io.StringIO()
            with mock.patch.dict(os.environ, {"FAKE_ADB_STATE": str(state)}), redirect_stdout(output):
                code = main([str(apk), "--inventory", str(root), "--adb", str(adb), "--mitmdump", str(proxy),
                             "--duration", "100ms", "--proxy", "39989", "--isolated-device", "--session-id", "runner"])
            self.assertEqual(code, 0, output.getvalue())
            result = json.loads(output.getvalue())
            self.assertEqual(result["coverage"], 1)
            current = json.loads(state.read_text())
            self.assertEqual(current["settings"]["http_proxy"], "old.proxy:3128")
            self.assertEqual(current["reverse"], {"tcp:3333": "tcp:4444"})
            report = json.loads(Path(result["report"]).read_text())
            self.assertEqual(report["cleanup"]["proxy"], "restored")
            self.assertEqual(report["cleanup"]["reverse"], "removed")

    def test_failed_install_restores_proxy_and_keeps_static_pointer(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            apk, adb, proxy, state = self.prepare(root)
            output = io.StringIO()
            with mock.patch.dict(os.environ, {"FAKE_ADB_STATE": str(state), "FAKE_INSTALL_FAIL": "1"}), redirect_stdout(output):
                code = main([str(apk), "--inventory", str(root), "--adb", str(adb), "--mitmdump", str(proxy),
                             "--duration", "100ms", "--proxy", "39988", "--isolated-device", "--session-id", "failed"])
            self.assertEqual(code, 6)
            self.assertFalse(json.loads(output.getvalue())["promoted"])
            self.assertEqual(json.loads((root / "source.json").read_text())["inventory"], "endpoints.static.json")
            self.assertEqual(json.loads(state.read_text())["settings"]["http_proxy"], "old.proxy:3128")

    def test_sigterm_runs_finally_and_restores_owned_device_state(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            apk, adb, proxy, state = self.prepare(root)
            env = os.environ.copy()
            env["FAKE_ADB_STATE"] = str(state)
            env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])
            child = subprocess.Popen([sys.executable, "-m", "apk_inventory.verify", str(apk), "--inventory", str(root),
                                      "--adb", str(adb), "--mitmdump", str(proxy), "--duration", "10s", "--proxy", "39987",
                                      "--isolated-device", "--session-id", "terminated"],
                                     env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    try:
                        value = json.loads(state.read_text())
                    except ValueError:
                        value = {}
                    if value.get("settings", {}).get("http_proxy") == "127.0.0.1:39987":
                        break
                    if child.poll() is not None:
                        self.fail(child.communicate()[0])
                    time.sleep(.02)
                else:
                    self.fail("fake device proxy was not configured")
                child.terminate()
                stdout, stderr = child.communicate(timeout=10)
                self.assertEqual(child.returncode, 130, stdout + stderr)
                self.assertEqual(json.loads(stdout)["error"]["code"], "CAPTURE_INTERRUPTED")
                current = json.loads(state.read_text())
                self.assertEqual(current["settings"]["http_proxy"], "old.proxy:3128")
                self.assertEqual(current["reverse"], {"tcp:3333": "tcp:4444"})
                self.assertEqual(json.loads((root / "source.json").read_text())["inventory"], "endpoints.static.json")
            finally:
                if child.poll() is None:
                    child.kill()
                    child.communicate(timeout=5)

    def test_duration_parser(self):
        self.assertEqual(parse_duration("5m"), 300)
        self.assertEqual(parse_duration("100ms"), .1)


if __name__ == "__main__":
    unittest.main()
