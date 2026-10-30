"""Real loopback WebDriver HTTP + fake ADB process contracts, never devices."""
import copy
from contextlib import contextmanager
import http.server
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from apk_inventory.mobile_ui import (AdbBackend, Budget, DeviceLease, MobileError, MobileSession,
                                    WebDriverBackend, digest, locate, parse_tree,
                                    selector, swipe_points, xpath_literal)

APP = "com.example.fixture"


def android_tree(state="root", duplicate=False, input_field=False, scroll=False):
    children = []
    if state == "root":
        children.append('<node resource-id="com.example.fixture:id/open" text="Open items" class="android.widget.Button" package="' + APP + '" clickable="true" enabled="true" bounds="[0,0][100,80]"/>')
        if duplicate:
            children.append(children[0])
    else:
        children.append('<node text="Items" class="android.widget.TextView" package="' + APP + '" bounds="[0,0][100,80]"/>')
    if input_field:
        children.append('<node resource-id="com.example.fixture:id/input" text="DO_NOT_RECORD_EDIT_VALUE" class="android.widget.EditText" package="' + APP + '" enabled="true" bounds="[0,80][100,160]"/>')
    if scroll:
        children.append('<node resource-id="com.example.fixture:id/scroll" class="android.widget.ScrollView" package="' + APP + '" scrollable="true" bounds="[0,160][200,560]"/>')
    children.append('<node text="Delete account" resource-id="com.example.fixture:id/delete" class="android.widget.Button" package="' + APP + '" clickable="true" bounds="[100,0][200,80]"/>')
    return '<hierarchy rotation="0">' + ''.join(children) + '</hierarchy>'


def ios_tree(state="root"):
    child = '<XCUIElementTypeButton type="XCUIElementTypeButton" name="Open items" label="Open items" enabled="true" visible="true" x="0" y="0" width="100" height="80"/>' if state == "root" else '<XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="Items" label="Items" x="0" y="0" width="100" height="80"/>'
    return '<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Fixture">' + child + '</XCUIElementTypeApplication></AppiumAUT>'


@contextmanager
def webdriver_fixture(platform="android", duplicate=False, input_field=False, scroll=False):
    state = {"page": "root", "app": APP, "calls": [], "typed": None, "duplicate": duplicate,
             "delayClick": 0, "foregroundSupported": True, "elementsDuplicate": False}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, value, status=200):
            raw = json.dumps({"value": value}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            try:
                self.wfile.write(raw)
            except BrokenPipeError:
                pass

        def handle_command(self):
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else None
            state["calls"].append((self.command, self.path, body))
            prefix = "/wd/hub/session/existing-session"
            if not self.path.startswith(prefix):
                return self.reply({"error": "invalid session id"}, 404)
            route = self.path[len(prefix):]
            if self.command == "GET" and route == "/source":
                return self.reply(android_tree(state["page"], state["duplicate"], input_field, scroll) if platform == "android" else ios_tree(state["page"]))
            if route == "/appium/device/current_package":
                return self.reply(state["app"]) if state["foregroundSupported"] else self.reply({}, 404)
            if route == "/execute/sync":
                if body != {"script": "mobile: activeAppInfo", "args": []}:
                    return self.reply({}, 400)
                return self.reply({"bundleId": state["app"]}) if state["foregroundSupported"] else self.reply({}, 404)
            if route == "/elements":
                if body.get("using") != "xpath" or not body.get("value", "").startswith("//*["):
                    return self.reply({}, 400)
                ident = "input" if ":id/input" in body["value"] else "open"
                result = [{"element-6066-11e4-a52e-4f735466cecf": ident}]
                return self.reply(result * (2 if state["elementsDuplicate"] else 1))
            if route == "/element/open/click":
                time.sleep(state["delayClick"])
                state["page"] = "items"
                return self.reply(None)
            if route == "/element/input/value":
                if body.get("value") != list(body.get("text", "")):
                    return self.reply({}, 400)
                state["typed"] = body["text"]
                return self.reply(None)
            if route == "/actions":
                state["swipe"] = body
                return self.reply(None)
            if route == "/back":
                state["page"] = "root"
                return self.reply(None)
            if route == "/appium/device/activate_app":
                state["app"] = body["appId"]
                return self.reply(None)
            return self.reply({"error": "unknown command"}, 404)

        do_GET = do_POST = handle_command

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state["url"] = "http://127.0.0.1:" + str(server.server_port) + "/wd/hub"
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def config(fixture, platform="android", **extra):
    result = {"source": {"id": "mobile_fixture", "kind": "apk" if platform == "android" else "ios"},
              "backend": {"type": "webdriver", "url": fixture["url"], "sessionId": "existing-session", "platform": platform, "appId": APP},
              "limits": {"maxActions": 20, "maxDepth": 3, "maxDurationMs": 10000}}
    result.update(extra)
    return result


def recipe(session, action, before, after):
    row = {"schemaVersion": 1, "sourceId": session.source["id"], "identity": session.identity,
           "capabilityId": "mobile_manual_fixture", "steps": [{"action": action, "before": before, "after": after}], "expectedFinalFp": after}
    row["revision"] = digest(row)
    return row


class MobileTreeTests(unittest.TestCase):
    def test_source_revision_changes_for_status_and_new_gaps_without_new_capabilities(self):
        with tempfile.TemporaryDirectory() as out:
            session = MobileSession(config({'url':'http://127.0.0.1:1'}), out)
            session.checkpoint()
            initial = json.loads(Path(out,'manifest.json').read_text())['source']['revision']
            session.progress['status'] = 'partial'
            session.checkpoint()
            partial = json.loads(Path(out,'manifest.json').read_text())['source']['revision']
            self.assertNotEqual(initial, partial)
            session.progress['gaps'].append('interrupted_action_outcome_unknown')
            session.checkpoint()
            uncertain = json.loads(Path(out,'manifest.json').read_text())['source']['revision']
            self.assertNotEqual(partial, uncertain)
            session.checkpoint()
            self.assertEqual(json.loads(Path(out,'manifest.json').read_text())['source']['revision'], uncertain)

    def test_type_candidate_describes_input_without_publishing_a_ready_recipe(self):
        with tempfile.TemporaryDirectory() as out:
            session = MobileSession(config({'url':'http://127.0.0.1:1'}), out)
            tree = parse_tree(android_tree(input_field=True), 'android', APP)
            action = next(a for a in session.candidates(tree) if a['kind']=='type')
            session.add_capability(tree, action, [])
            candidate = next(iter(session.progress['capabilities'].values()))
            self.assertEqual(candidate['readiness'], 'candidate')
            self.assertFalse(candidate['evidence']['executionObserved'])
            self.assertEqual(candidate['inputSchema']['required'], ['text'])
            self.assertEqual(candidate['inputSchema']['properties']['text']['maxLength'], 2048)
            self.assertEqual(session.progress['recipes'], {})

    def test_selectors_are_structured_and_ambiguity_is_rejected(self):
        tree = parse_tree(android_tree(duplicate=True), "android", APP)
        with self.assertRaises(MobileError) as caught:
            locate(tree, {"resourceId": APP + ":id/open"})
        self.assertEqual(caught.exception.code, "SELECTOR_AMBIGUOUS")
        with self.assertRaises(MobileError):
            selector({"xpath": "//*"})
        self.assertEqual(xpath_literal('a\'b"c'), 'concat(\'a\',"\'",\'b"c\')')

    def test_source_rejects_entities_deep_trees_and_foreign_controls(self):
        with self.assertRaises(MobileError):
            parse_tree('<!DOCTYPE x [<!ENTITY y "z">]><x>&y;</x>', "android", APP)
        with self.assertRaises(MobileError):
            parse_tree('<n>' * 66 + '</n>' * 66, "android", APP)
        tree = parse_tree('<hierarchy><node package="other.app" text="Open other" clickable="true"/></hierarchy>', "android", APP)
        self.assertFalse(any(n["text"] for n in tree["nodes"]))

    def test_edit_values_are_not_in_fingerprint_or_recordable_selector(self):
        first = parse_tree(android_tree(input_field=True), "android", APP)
        second = parse_tree(android_tree(input_field=True).replace("DO_NOT_RECORD_EDIT_VALUE", "another secret"), "android", APP)
        self.assertEqual(first["fingerprint"], second["fingerprint"])
        self.assertNotIn("DO_NOT_RECORD_EDIT_VALUE", json.dumps(first))
        self.assertEqual(swipe_points([0, 0, 100, 200], "up"), [50, 160, 50, 40])


class WebDriverTests(unittest.TestCase):
    def test_existing_session_is_exclusively_leased_for_mutation(self):
        with tempfile.TemporaryDirectory() as out, webdriver_fixture() as fixture:
            first = MobileSession(config(fixture), out)
            second = MobileSession(config(fixture), Path(out,'other'))
            first.backend.probe()
            with DeviceLease(first.backend):
                with self.assertRaises(MobileError) as caught:
                    second.explore()
                self.assertEqual(caught.exception.code, 'DEVICE_BUSY')
            self.assertFalse(any(path.endswith('/click') for _,path,_ in fixture['calls']))
            self.assertEqual(second.explore()['states'], 2)

    def test_actual_android_http_exploration_records_observed_paths(self):
        with tempfile.TemporaryDirectory() as out, webdriver_fixture() as fixture:
            session = MobileSession(config(fixture), out)
            result = session.explore()
            session.checkpoint()
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["states"], 2)
            manifest = json.loads(Path(out, "manifest.json").read_text())
            ready = [c for c in manifest["capabilities"] if c["readiness"] == "ready"]
            candidate = [c for c in manifest["capabilities"] if c["readiness"] == "candidate"]
            self.assertEqual(len(ready), 1)
            self.assertTrue(candidate)
            self.assertTrue(ready[0]["evidence"]["executionObserved"])
            self.assertFalse(ready[0]["evidence"]["networkObserved"])
            self.assertFalse(manifest["source"]["networkScopeEnforced"])
            self.assertTrue(any(p.endswith("/element/open/click") for _, p, _ in fixture["calls"]))
            public = json.dumps(manifest)
            self.assertNotIn("existing-session", public)
            self.assertNotIn(fixture["url"], public)
            self.assertNotIn("selector", public)
            self.assertFalse(any("delete/click" in p for _, p, _ in fixture["calls"]))

    def test_ios_actual_protocol_executes_recorded_recipe_and_checks_revision(self):
        with tempfile.TemporaryDirectory() as out, webdriver_fixture("ios") as fixture:
            cfg = config(fixture, "ios")
            session = MobileSession(cfg, out)
            session.explore()
            recorded = next(iter(session.progress["recipes"].values()))
            fixture["page"] = "root"
            executor = MobileSession(cfg, Path(out, "execution"))
            result = executor.execute(recorded, recorded["revision"], {})
            self.assertTrue(result["ok"])
            self.assertEqual(fixture["page"], "items")
            self.assertTrue(any(body == {"script": "mobile: activeAppInfo", "args": []} for _, _, body in fixture["calls"]))
            calls = len(fixture["calls"])
            with self.assertRaises(MobileError) as caught:
                executor.execute(recorded, "outdated", {})
            self.assertEqual(caught.exception.code, "RECIPE_REVISION_MISMATCH")
            self.assertEqual(len(fixture["calls"]), calls)

    def test_whole_recipe_is_validated_before_any_remote_request(self):
        with tempfile.TemporaryDirectory() as out, webdriver_fixture() as fixture:
            session = MobileSession(config(fixture), out)
            before = parse_tree(android_tree(), 'android', APP)['fingerprint']
            after = parse_tree(android_tree('items'), 'android', APP)['fingerprint']
            row = recipe(session, {'kind': 'click', 'selector': {'resourceId': APP + ':id/open'}}, before, after)
            row['steps'].append({'action': {'kind': 'click', 'selector': {'resourceId': APP + ':id/open'}}, 'before': before, 'after': after})
            del row['revision'];row['revision'] = digest(row)
            with self.assertRaises(MobileError) as caught:
                session.execute(row, row['revision'], {})
            self.assertEqual(caught.exception.code, 'RECIPE_PATH_DISCONNECTED')
            self.assertEqual(fixture['calls'], [])

    def test_input_is_not_replayed_as_a_prefix_and_extra_values_are_rejected(self):
        with tempfile.TemporaryDirectory() as out, webdriver_fixture(input_field=True) as fixture:
            cfg = config(fixture, actionAllowlist=[{'kind':'type','selector':{'resourceId': APP + ':id/input'}}])
            session = MobileSession(cfg, out)
            fp = parse_tree(android_tree(input_field=True), 'android', APP)['fingerprint']
            row = recipe(session, {'kind':'type','selector':{'resourceId':APP+':id/input'},'input':'query'}, fp, fp)
            with self.assertRaises(MobileError) as caught:
                session.execute(row, row['revision'], {'query':'secret','unexpected':'value'})
            self.assertEqual(caught.exception.code, 'RECIPE_INPUT_OR_OUTCOME_INVALID')
            row['steps'].append(copy.deepcopy(row['steps'][0]));del row['revision'];row['revision']=digest(row)
            with self.assertRaises(MobileError) as caught:
                session.execute(row, row['revision'], {'query':'secret'})
            self.assertEqual(caught.exception.code, 'UNSAFE_REPLAY_PREFIX')
            self.assertEqual(fixture['calls'], [])

    def test_actual_input_and_w3c_pointer_actions(self):
        with tempfile.TemporaryDirectory() as out, webdriver_fixture(input_field=True, scroll=True) as fixture:
            cfg = config(fixture, actionAllowlist=[{"kind": "type", "selector": {"resourceId": APP + ":id/input"}}])
            session = MobileSession(cfg, out)
            session.backend.probe()
            tree = session.backend.observe()
            session.step({"kind": "type", "selector": {"resourceId": APP + ":id/input"}, "input": "query"}, tree["fingerprint"], inputs={"query": "SENSITIVE_INPUT_123"})
            self.assertEqual(fixture["typed"], "SENSITIVE_INPUT_123")
            session.step({"kind": "swipe", "selector": {"resourceId": APP + ":id/scroll"}, "direction": "up"}, tree["fingerprint"])
            actions = fixture["swipe"]["actions"][0]
            self.assertEqual(actions["parameters"], {"pointerType": "touch"})
            self.assertEqual(actions["actions"][-1]["type"], "pointerUp")
            session.checkpoint()
            self.assertNotIn("SENSITIVE_INPUT_123", ''.join(p.read_text() for p in Path(out).glob('*.json')))
            self.assertNotIn("DO_NOT_RECORD_EDIT_VALUE", ''.join(p.read_text() for p in Path(out).glob('*.json')))

    def test_state_drift_package_drift_and_remote_ambiguity_stop_before_click(self):
        with tempfile.TemporaryDirectory() as out, webdriver_fixture() as fixture:
            session = MobileSession(config(fixture), out)
            tree = session.backend.observe()
            action = {"kind": "click", "selector": {"resourceId": APP + ":id/open"}}
            with self.assertRaises(MobileError) as caught:
                session.step(action, "incorrect fingerprint")
            self.assertEqual(caught.exception.code, "STATE_CHANGED")
            fixture["elementsDuplicate"] = True
            with self.assertRaises(MobileError) as caught:
                session.step(action, tree["fingerprint"])
            self.assertEqual(caught.exception.code, "SELECTOR_AMBIGUOUS")
            fixture["app"] = "different.application"
            with self.assertRaises(MobileError) as caught:
                session.step(action, tree["fingerprint"])
            self.assertEqual(caught.exception.code, "APP_OUT_OF_SCOPE")
            self.assertFalse(any(p.endswith("/click") for _, p, _ in fixture["calls"]))

    def test_budget_counts_attempts_and_depth_leaves_candidate(self):
        with tempfile.TemporaryDirectory() as out, webdriver_fixture() as fixture:
            cfg = config(fixture)
            cfg["limits"]["maxActions"] = 0
            session = MobileSession(cfg, out)
            with self.assertRaises(MobileError) as caught:
                session.explore()
            self.assertEqual(caught.exception.code, "ACTION_BUDGET")
            self.assertFalse(any(p.endswith("/click") for _, p, _ in fixture["calls"]))
        with tempfile.TemporaryDirectory() as out, webdriver_fixture() as fixture:
            cfg = config(fixture)
            cfg["limits"]["maxDepth"] = 0
            session = MobileSession(cfg, out)
            session.explore()
            self.assertTrue(all(c["readiness"] == "candidate" for c in session.progress["capabilities"].values()))

    def test_write_allowlist_does_not_make_write_exploration_automatic(self):
        with tempfile.TemporaryDirectory() as out, webdriver_fixture() as fixture:
            session = MobileSession(config(fixture, actionAllowlist=[{"kind": "click", "selector": {"resourceId": APP + ":id/delete"}, "effect": "write"}]), out)
            session.explore()
            self.assertTrue(any(c["effect"] == "write" and c["readiness"] == "candidate" for c in session.progress["capabilities"].values()))

    def test_trusted_launch_only_activates_configured_app(self):
        with tempfile.TemporaryDirectory() as out, webdriver_fixture() as fixture:
            session = MobileSession(config(fixture, allowLaunch=True), out)
            fixture["app"] = "other.application"
            session.step({"kind": "launch"}, None)
            self.assertEqual(fixture["app"], APP)
            activations = [body for _, path, body in fixture["calls"] if path.endswith("activate_app")]
            self.assertEqual(activations, [{"appId": APP}])

    def test_missing_foreground_extension_is_explicit_unsupported(self):
        with tempfile.TemporaryDirectory() as out, webdriver_fixture() as fixture:
            fixture["foregroundSupported"] = False
            session = MobileSession(config(fixture), out)
            with self.assertRaises(MobileError) as caught:
                session.explore()
            self.assertEqual(caught.exception.status, "unsupported")

    def test_resume_reuses_frontier_and_does_not_repeat_uncertain_action(self):
        with tempfile.TemporaryDirectory() as out, webdriver_fixture() as fixture:
            cfg = config(fixture)
            session = MobileSession(cfg, out)
            session.explore()
            session.progress["pending"] = {"action": "uncertain"}
            session.checkpoint()
            before = sum(path.endswith("/click") for _, path, _ in fixture["calls"])
            resumed = MobileSession(cfg, out, resume=True)
            result = resumed.explore()
            self.assertEqual(result["status"], "partial")
            self.assertIn("interrupted_action_outcome_unknown", result["gaps"])
            self.assertEqual(sum(path.endswith("/click") for _, path, _ in fixture["calls"]), before)
            changed = copy.deepcopy(cfg)
            changed["backend"]["appId"] = "other.application"
            with self.assertRaises(MobileError):
                MobileSession(changed, out, resume=True)

    def test_raised_resume_budget_keeps_unattempted_action_and_cumulative_count(self):
        with tempfile.TemporaryDirectory() as out, webdriver_fixture() as fixture:
            cfg = config(fixture);cfg['limits']['maxActions'] = 0
            session = MobileSession(cfg, out)
            with self.assertRaises(MobileError):session.explore()
            session.checkpoint()
            self.assertIsNone(session.progress.get('pending'))
            self.assertEqual(session.progress['states'][session.progress['entry']]['next'], 0)
            cfg['limits']['maxActions'] = 10
            resumed = MobileSession(cfg, out, resume=True)
            result = resumed.explore()
            self.assertEqual(result['states'], 2)
            self.assertEqual(result['totalActions'], 1)


class AdbProcessTests(unittest.TestCase):
    def fake_adb(self, directory, devices=("fixture-device",), input_field=False, scroll=False):
        executable, state_file = Path(directory, 'adb-fixture'), Path(directory, 'adb-state.json')
        state_file.write_text(json.dumps({"page": "root", "commands": [], "devices": list(devices), "app": APP, "artifactPaths": ['/data/app/~~fixture/'+APP+'-fixture/base.apk'], "artifactHash": 'a'*64}))
        code = '''#!PYTHON
import json,shlex,sys
from pathlib import Path
p=Path(STATE)
s=json.loads(p.read_text()); args=sys.argv[1:]; s['commands'].append(args)
if args[0]=='devices': result='List of devices attached\\n'+''.join(x+'\\tdevice product:fixture\\n' for x in s['devices'])
else:
 a=shlex.split(args[3]); result=''
 if a[:2]==['dumpsys','activity']:result='mResumedActivity: ActivityRecord{abc u0 '+s['app']+'/.MainActivity t1}'
 elif a[:2]==['pm','path']:result='\\n'.join('package:'+p for p in s['artifactPaths'])
 elif a[0]=='sha256sum':
  result=s.get('hashOutput',s['artifactHash']+'  '+a[1])
  if s.get('hashUnavailable'):p.write_text(json.dumps(s));sys.exit(127)
  if s.get('replaceDuringHash'):s['artifactPaths']=['/data/app/~~changed/'+APP+'-fixture/base.apk']
 elif a[0]=='cat':result=ROOT if s['page']=='root' else ITEMS
 elif a[:2]==['input','tap']:s['page']='items'
 elif a[:2]==['input','text']:s['typed']=a[2]
 elif a[:2]==['input','keyevent']:s['page']='root'
 elif a[:3]==['cmd','package','resolve-activity']:result=APP+'/.MainActivity'
 elif a[:2]==['am','start']:s['app']=APP
p.write_text(json.dumps(s));print(result)
'''.replace('PYTHON', sys.executable).replace('STATE', repr(str(state_file))).replace('ROOT', repr(android_tree(input_field=input_field, scroll=scroll))).replace('ITEMS', repr(android_tree('items', input_field=input_field, scroll=scroll))).replace('APP', repr(APP))
        executable.write_text(code)
        executable.chmod(0o700)
        # Each fake command is a real Python process. Allow shared CI CPU time;
        # action/depth/time budget behavior is covered in dedicated cases.
        return {"source": {"id": "adb_fixture", "kind": "apk"}, "backend": {"type": "adb", "adb": str(executable), "appId": APP}, "limits": {"maxActions": 20, "maxDepth": 3, "maxDurationMs": 30000}}, state_file

    def test_expected_artifact_is_verified_by_probe_and_before_each_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg,state_file=self.fake_adb(directory)
            cfg['expectedArtifact']={'kind':'apk','sha256':'a'*64}
            session=MobileSession(cfg,Path(directory,'out'))
            proof=session.backend.probe()
            self.assertTrue(proof['appArtifactVerified'])
            self.assertEqual(proof['artifactVerification']['actualSha256'],'a'*64)
            tree=session.backend.observe()
            session.step({'kind':'click','selector':{'resourceId':APP+':id/open'}},tree['fingerprint'])
            session.checkpoint()
            manifest=json.loads(Path(directory,'out/manifest.json').read_text())
            self.assertTrue(manifest['source']['appArtifactVerified'])
            self.assertNotIn('app_artifact_not_verified',manifest['source']['gaps'])
            self.assertNotIn('/data/app/',json.dumps(manifest))
            commands=json.loads(state_file.read_text())['commands']
            self.assertGreaterEqual(sum('sha256sum ' in ' '.join(row) for row in commands),2)
            self.assertGreaterEqual(sum('pm path ' in ' '.join(row) for row in commands),4)

    def test_hash_mismatch_blocks_probe_without_reading_ui_or_tapping(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg,state_file=self.fake_adb(directory);cfg['expectedArtifact']={'kind':'apk','sha256':'b'*64}
            session=MobileSession(cfg,Path(directory,'out'))
            with self.assertRaises(MobileError) as caught:session.explore()
            self.assertEqual(caught.exception.code,'APK_ARTIFACT_MISMATCH')
            self.assertEqual(session.backend.artifact_verification['status'],'mismatch')
            commands=json.loads(state_file.read_text())['commands']
            self.assertFalse(any('uiautomator' in ' '.join(row) or 'input ' in ' '.join(row) for row in commands))

    def test_split_missing_hash_and_changed_installation_are_never_verified(self):
        variants=[{'artifactPaths':['/data/app/fixture/base.apk','/data/app/fixture/split_config.apk']},{'hashUnavailable':True},{'hashOutput':'not a hash'},{'replaceDuringHash':True},{'artifactPaths':['/system/app/Fixture/Fixture.apk']}]
        for change in variants:
            with self.subTest(change=change),tempfile.TemporaryDirectory() as directory:
                cfg,state_file=self.fake_adb(directory);cfg['expectedArtifact']={'kind':'apk','sha256':'a'*64}
                state=json.loads(state_file.read_text());state.update(change);state_file.write_text(json.dumps(state))
                session=MobileSession(cfg,Path(directory,'out'))
                with self.assertRaises(MobileError) as caught:session.explore()
                self.assertEqual(caught.exception.code,'APK_ARTIFACT_UNVERIFIED')
                self.assertEqual(session.backend.artifact_verification['status'],'unverified')
                self.assertFalse(any('input ' in ' '.join(row) for row in json.loads(state_file.read_text())['commands']))

    def test_replaced_artifact_after_probe_stops_before_action_and_downgrades_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg,state_file=self.fake_adb(directory);cfg['expectedArtifact']={'kind':'apk','sha256':'a'*64}
            session=MobileSession(cfg,Path(directory,'out'));session.backend.probe();tree=session.backend.observe()
            state=json.loads(state_file.read_text());state['artifactHash']='b'*64;state_file.write_text(json.dumps(state))
            with self.assertRaises(MobileError) as caught:session.step({'kind':'click','selector':{'resourceId':APP+':id/open'}},tree['fingerprint'])
            self.assertEqual(caught.exception.code,'APK_ARTIFACT_MISMATCH')
            session.checkpoint();manifest=json.loads(Path(directory,'out/manifest.json').read_text())
            self.assertFalse(manifest['source']['appArtifactVerified'])
            self.assertIn('app_artifact_not_verified',manifest['source']['gaps'])
            self.assertFalse(any('input tap ' in ' '.join(row) for row in json.loads(state_file.read_text())['commands']))

    def test_webdriver_does_not_turn_configured_apk_hash_into_device_proof(self):
        with tempfile.TemporaryDirectory() as directory,webdriver_fixture() as fixture:
            cfg=config(fixture);cfg['expectedArtifact']={'kind':'apk','sha256':'a'*64}
            session=MobileSession(cfg,directory)
            with self.assertRaises(MobileError) as caught:session.explore()
            self.assertEqual(caught.exception.code,'APK_ARTIFACT_VERIFICATION_UNSUPPORTED')
            self.assertEqual(session.backend.artifact_verification['status'],'unsupported')
            self.assertEqual(fixture['calls'],[])

    def test_real_fake_adb_process_explores_and_replays(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg, state_file = self.fake_adb(directory)
            session = MobileSession(cfg, Path(directory, 'out'))
            result = session.explore()
            self.assertEqual(result['states'], 2)
            state = json.loads(state_file.read_text())
            self.assertTrue(any('input tap' in ' '.join(a) for a in state['commands']))
            self.assertTrue(any('uiautomator dump' in ' '.join(a) for a in state['commands']))
            self.assertFalse(any('settings ' in ' '.join(a) or ' install ' in ' '.join(a) for a in state['commands']))
            state['page'] = 'root';state_file.write_text(json.dumps(state))
            row = next(iter(session.progress['recipes'].values()))
            executor = MobileSession(cfg, Path(directory, 'execution'))
            self.assertTrue(executor.execute(row, row['revision'], {})['ok'])
            self.assertEqual(json.loads(state_file.read_text())['page'], 'items')

    def test_zero_multiple_or_missing_adb_never_pretend_ready(self):
        for devices in ((), ('one', 'two')):
            with tempfile.TemporaryDirectory() as directory:
                cfg, state_file = self.fake_adb(directory, devices)
                with self.assertRaises(MobileError) as caught:
                    MobileSession(cfg, Path(directory, 'out')).explore()
                self.assertEqual(caught.exception.status, 'needs_device')
                self.assertEqual(len(json.loads(state_file.read_text())['commands']), 1)
        backend = AdbBackend({'appId': APP, 'adb': '/missing/adb'}, Budget({}))
        with self.assertRaises(MobileError) as caught:
            backend.probe()
        self.assertEqual(caught.exception.status, 'unsupported')

    def test_explicit_device_and_quoted_ascii_type_swipe_back_contracts(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg, state_file = self.fake_adb(directory, ('one','two'), input_field=True, scroll=True)
            cfg['backend']['deviceId'] = 'two'
            cfg['actionAllowlist'] = [{'kind':'type','selector':{'resourceId':APP+':id/input'}}]
            session = MobileSession(cfg, Path(directory,'out'))
            session.backend.probe();tree = session.backend.observe()
            session.step({'kind':'type','selector':{'resourceId':APP+':id/input'}}, tree['fingerprint'], inputs={'text':'value; literal space'})
            after = session.backend.observe()
            session.step({'kind':'swipe','selector':{'resourceId':APP+':id/scroll'},'direction':'up'}, after['fingerprint'])
            session.step({'kind':'back'}, after['fingerprint'])
            state = json.loads(state_file.read_text())
            self.assertEqual(state['typed'], 'value;%sliteral%sspace')
            self.assertTrue(all(row[:2]==['-s','two'] for row in state['commands'] if row[0]!='devices'))
            self.assertTrue(any('input swipe' in ' '.join(row) for row in state['commands']))
            self.assertEqual(state['page'], 'root')
            with self.assertRaises(MobileError) as caught:
                session.step({'kind':'type','selector':{'resourceId':APP+':id/input'}}, tree['fingerprint'], inputs={'text':'中文'})
            self.assertEqual(caught.exception.code, 'ADB_INPUT_UNSUPPORTED')


class CliTests(unittest.TestCase):
    def run_cli(self, cfg, directory, operation='explore', extra=(), payload=None):
        config_file = Path(directory, 'config.json');config_file.write_text(json.dumps(cfg))
        output = Path(directory, 'out')
        command = [sys.executable, '-m', 'apk_inventory.mobile_ui', '--config', str(config_file), '--operation', operation, '--output', str(output), *extra]
        env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1]), PYTHONDONTWRITEBYTECODE='1')
        result = subprocess.run(command, input=json.dumps(payload or {}), capture_output=True, text=True, timeout=20, env=env)
        return result, output

    def test_cli_writes_public_manifest_and_private_recipes_then_executes(self):
        with tempfile.TemporaryDirectory() as directory, webdriver_fixture() as fixture:
            cfg = config(fixture)
            result, output = self.run_cli(cfg, directory)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)['ok'])
            self.assertEqual(result.stderr, '')
            recipes = json.loads((output/'recipes.json').read_text());row = next(iter(recipes.values()))
            self.assertEqual((output/'recipes.json').stat().st_mode & 0o777, 0o600)
            fixture['page'] = 'root'
            single = Path(directory, 'recipe.json');single.write_text(json.dumps(row))
            result, _ = self.run_cli(cfg, directory, 'execute', ['--recipe', str(single), '--revision', row['revision']])
            self.assertEqual(result.returncode, 0)
            self.assertTrue(json.loads(result.stdout)['ok'])
            self.assertEqual(fixture['page'], 'items')
            events = [json.loads(line) for line in (output/'events.jsonl').read_text().splitlines()]
            self.assertTrue(any(row['kind']=='ui_action_started' for row in events))
            self.assertTrue(any(row['kind']=='ui_action_finished' for row in events))

    def test_observe_is_read_only_and_returns_only_bounded_candidate_controls(self):
        with tempfile.TemporaryDirectory() as directory, webdriver_fixture(input_field=True) as fixture:
            result, output = self.run_cli(config(fixture), directory, 'observe')
            row = json.loads(result.stdout)
            self.assertTrue(row['ok'])
            self.assertGreater(row['controlCount'], 0)
            self.assertTrue(all(c['readiness']=='candidate' for c in row['controls']))
            self.assertFalse(any(p.endswith('/click') or p.endswith('/value') or p.endswith('/actions') for _,p,_ in fixture['calls']))
            self.assertNotIn('DO_NOT_RECORD_EDIT_VALUE', ''.join(p.read_text() for p in output.glob('*.json')))

    @unittest.skipUnless(os.name == 'posix', 'POSIX termination contract')
    def test_sigterm_saves_partial_uncertain_intent_without_claiming_success(self):
        with tempfile.TemporaryDirectory() as directory, webdriver_fixture() as fixture:
            fixture['delayClick'] = 1
            cfg = config(fixture)
            path = Path(directory, 'config.json');path.write_text(json.dumps(cfg))
            output = Path(directory, 'out')
            env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1]), PYTHONDONTWRITEBYTECODE='1')
            command = [sys.executable, '-m', 'apk_inventory.mobile_ui', '--config', str(path), '--operation', 'explore', '--output', str(output)]
            child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
            try:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and not any(p.endswith('/click') for _, p, _ in fixture['calls']):time.sleep(.02)
                self.assertTrue(any(p.endswith('/click') for _, p, _ in fixture['calls']))
                child.send_signal(signal.SIGTERM)
                stdout, stderr = child.communicate(timeout=5)
                result = json.loads(stdout)
                self.assertEqual(result['status'], 'partial', stderr)
                cp = json.loads((output/'checkpoint.json').read_text())
                self.assertIsNotNone(cp['pending'])
                self.assertFalse(any(c['readiness']=='ready' for c in json.loads((output/'manifest.json').read_text())['capabilities']))
            finally:
                if child.poll() is None:child.kill();child.communicate()



class WorkflowInventoryMetadataTests(unittest.TestCase):
    def test_stable_containers_and_declared_input_metadata_do_not_change_legacy_fp_or_persist_values(self):
        xml = '<hierarchy><node class="android.widget.FrameLayout" package="'+APP+'" resource-id="android:id/content"><node class="android.widget.LinearLayout" package="'+APP+'" resource-id="'+APP+':id/searchForm"><node class="android.widget.EditText" package="'+APP+'" resource-id="'+APP+':id/query" text="PRIVATE_TYPED" input-type="numberDecimal" readonly="true" bounds="[0,0][100,50]"/></node></node></hierarchy>'
        tree = parse_tree(xml,'android',APP);field=tree['nodes'][-1]
        self.assertEqual(field['containerPath'],[{'resourceId':APP+':id/searchForm','accessibilityId':'','className':'android.widget.LinearLayout'}]);self.assertEqual(field['inputType'],'numberDecimal');self.assertTrue(field['readOnly']);self.assertEqual(field['text'],'')
        changed = parse_tree(xml.replace('numberDecimal','text').replace('readonly="true"','readonly="false"'),'android',APP)
        self.assertEqual(tree['fingerprint'],changed['fingerprint'],'metadata must not invalidate existing fixed paths')
        with tempfile.TemporaryDirectory() as directory:
            cfg={'source':{'id':'inventory','kind':'apk'},'backend':{'type':'adb','deviceId':'fixture','appId':APP}}
            session=MobileSession(cfg,directory);state=session.inventory_state(tree,[],0)
            serialized=json.dumps(state['workflowInventory']);self.assertNotIn('PRIVATE_TYPED',serialized);self.assertNotIn('_inputLength',serialized);self.assertEqual(state['workflowInventoryDigest'],digest(state['workflowInventory']))
            events=[json.loads(line) for line in Path(directory,'events.jsonl').read_text().splitlines()]
            self.assertEqual(events[-1]['kind'],'ui_state_observed');self.assertEqual(events[-1]['inventoryDigest'],state['workflowInventoryDigest'])
            from apk_inventory.mobile_ui import check_target
            with self.assertRaises(MobileError):check_target('type',field)

    def test_ios_application_name_is_not_a_form_but_named_other_container_is(self):
        xml='<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="App"><XCUIElementTypeOther type="XCUIElementTypeOther" name="Filters"><XCUIElementTypeTextField type="XCUIElementTypeTextField" name="Query" value="DO_NOT_KEEP" keyboardType="numberPad" x="0" y="0" width="100" height="50"/></XCUIElementTypeOther></XCUIElementTypeApplication></AppiumAUT>'
        tree=parse_tree(xml,'ios',APP);field=tree['nodes'][-1]
        self.assertEqual([row['accessibilityId'] for row in field['containerPath']],['Filters']);self.assertEqual(field['inputType'],'numberPad');self.assertNotIn('DO_NOT_KEEP',json.dumps(tree))

class BooleanMetadataTests(unittest.TestCase):
    def test_platform_state_is_explicit_and_excluded_from_legacy_fingerprint(self):
        for platform,cls,attrs in [('android','android.widget.CheckBox','checkable="true" checked="false"'),('android','android.widget.Switch','checkable="true" checked="false"'),('android','android.widget.RadioButton','checkable="true" checked="false"'),('ios','XCUIElementTypeSwitch','value="0"')]:
            with self.subTest(platform=platform,cls=cls):
                xml=f'<root><node class="{cls}" type="{cls}" {attrs} text="not checked" name="flag" bounds="[0,0][100,40]"/></root>'
                first=parse_tree(xml,platform,APP);second=parse_tree(xml.replace('checked="false"','checked="true"').replace('value="0"','value="1"'),platform,APP)
                self.assertIs(first['nodes'][-1]['checked'],False);self.assertIs(second['nodes'][-1]['checked'],True);self.assertEqual(first['fingerprint'],second['fingerprint'])
                self.assertEqual(first['fingerprint'],parse_tree(xml.replace(attrs,''),platform,APP)['fingerprint'])
                missing=parse_tree(xml.replace(attrs,''),platform,APP)['nodes'][-1];self.assertIsNone(missing['checked'])
                mixed=parse_tree(xml.replace(attrs,'checked="mixed" checkable="true" value="mixed"'),platform,APP)['nodes'][-1];self.assertIsNone(mixed['checked'])

    def test_adb_check_taps_once_then_verifies_and_noop_never_sends_command(self):
        backend=AdbBackend({'appId':APP,'deviceId':'fixture'},Budget({'maxDurationMs':1000}));calls=[];state={'checked':False}
        backend.verify_artifact=lambda:None;backend.foreground=lambda:None
        xml=lambda:f'<hierarchy><node package="{APP}" resource-id="{APP}:id/flag" class="android.widget.Switch" checkable="true" checked="{str(state["checked"]).lower()}" bounds="[0,0][100,40]"/></hierarchy>'
        backend.observe=lambda:parse_tree(xml(),'android',APP)
        def shell(*args):calls.append(args);state['checked']=not state['checked']
        backend.shell=shell;action={'kind':'check','selector':{'resourceId':APP+':id/flag'},'value':True}
        self.assertTrue(backend.perform(action,backend.observe(),{})['commandPerformed']);self.assertEqual(len(calls),1);self.assertEqual(calls[0][:2],('input','tap'))
        self.assertFalse(backend.perform(action,backend.observe(),{})['commandPerformed']);self.assertEqual(len(calls),1)

class SelectionMetadataTests(unittest.TestCase):
    def test_only_real_group_ancestry_and_explicit_state_define_radio_or_segment_options(self):
        for platform in ['android','ios']:
            with self.subTest(platform=platform):
                if platform=='android':xml=f'<hierarchy><node package="{APP}" class="android.widget.RadioGroup" resource-id="{APP}:id/status"><node package="{APP}" class="android.widget.RadioButton" resource-id="{APP}:id/all" checkable="true" checked="true"/><node package="{APP}" class="android.widget.RadioButton" resource-id="{APP}:id/open" checkable="true" checked="false"/></node></hierarchy>'
                else:xml='<AppiumAUT><XCUIElementTypeSegmentedControl type="XCUIElementTypeSegmentedControl" name="status"><XCUIElementTypeButton type="XCUIElementTypeButton" name="all" selected="true" value="1"/><XCUIElementTypeButton type="XCUIElementTypeButton" name="open" selected="false" value="0"/></XCUIElementTypeSegmentedControl><XCUIElementTypeButton type="XCUIElementTypeButton" name="ordinary" selected="true" value="1"/></AppiumAUT>'
                tree=parse_tree(xml,platform,APP);members=[node for node in tree['nodes'] if node['selectionOptionKind']];self.assertEqual(len(members),2);self.assertEqual([node['selectionState'] for node in members],[True,False]);self.assertTrue(all(node['selectionGroup'] for node in members))
                swapped=xml.replace('checked="true"','checked="TEMP"').replace('checked="false"','checked="true"').replace('checked="TEMP"','checked="false"').replace('selected="true"','selected="TEMP"').replace('selected="false"','selected="true"').replace('selected="TEMP"','selected="false"')
                self.assertEqual(tree['fingerprint'],parse_tree(swapped,platform,APP)['fingerprint'])
                if platform=='ios':
                    ordinary=next(node for node in tree['nodes'] if node['accessibilityId']=='ordinary');self.assertEqual(ordinary['selectionOptionKind'],'');self.assertIsNone(ordinary['selectionState'])
                    missing=parse_tree(xml.replace('selected="true"','').replace('selected="false"',''),platform,APP);self.assertTrue(all(node['selectionState'] is None for node in missing['nodes'] if node['selectionOptionKind']))

    def test_adb_selection_uses_fixed_option_once_and_rechecks_whole_group(self):
        backend=AdbBackend({'appId':APP,'deviceId':'fixture'},Budget({'maxDurationMs':2000}));backend.verify_artifact=lambda:None;backend.foreground=lambda:None;state={'selected':'all'};calls=[]
        xml=lambda:f'<hierarchy><node package="{APP}" resource-id="{APP}:id/group" class="android.widget.RadioGroup">'+''.join(f'<node package="{APP}" resource-id="{APP}:id/{name}" class="android.widget.RadioButton" checkable="true" checked="{str(name==state["selected"]).lower()}" bounds="[{i*100},0][{(i+1)*100},40]"/>' for i,name in enumerate(['all','open','closed']))+'</node></hierarchy>'
        backend.observe=lambda:parse_tree(xml(),'android',APP)
        def shell(*args):calls.append(args);state['selected']='open'
        backend.shell=shell;action={'kind':'select','selector':{'resourceId':APP+':id/group'},'input':'status','options':[{'value':name,'selector':{'resourceId':APP+':id/'+name}} for name in ['all','open','closed']]}
        self.assertTrue(backend.perform(action,backend.observe(),{'status':'open'})['commandPerformed']);self.assertEqual(calls,[('input','tap','150','20')]);self.assertFalse(backend.perform(action,backend.observe(),{'status':'open'})['commandPerformed']);self.assertEqual(len(calls),1)

class RealWdaSnapshotRegressionTests(unittest.TestCase):
    def test_button_title_decoration_is_not_an_identifier_but_real_duplicate_is(self):
        xml = '<AppiumAUT><XCUIElementTypeButton type="XCUIElementTypeButton" name="Search" accessible="true"><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="Search" label="Search" accessible="false"/></XCUIElementTypeButton></AppiumAUT>'
        tree = parse_tree(xml, 'ios', APP)
        self.assertEqual(locate(tree, {'accessibilityId': 'Search'})['className'], 'XCUIElementTypeButton')
        with self.assertRaises(MobileError) as raised:
            locate(parse_tree(xml.replace('accessible="false"', 'accessible="true"'), 'ios', APP), {'accessibilityId': 'Search'})
        self.assertEqual(raised.exception.code, 'SELECTOR_AMBIGUOUS')
        backend = WebDriverBackend({'appId': APP, 'platform': 'ios', 'url': 'http://localhost', 'sessionId': 'owned'}, Budget({}))
        calls = []
        backend.request = lambda method, suffix, body: calls.append(body) or [{'element-6066-11e4-a52e-4f735466cecf': 'real'}]
        self.assertEqual(backend.element({'accessibilityId': 'Search'}), 'real')
        self.assertIn("ancestor::*[@type='XCUIElementTypeButton' and @accessible='true']", calls[0]['value'])

    def test_webdriver_real_delayed_reply_respects_local_timeout_and_total_budget(self):
        for timeout_ms, duration_ms, succeeds in [(None, 2000, True), (500, 2000, True), (20, 2000, False), (1, 2000, False), (500, 30, False)]:
            with self.subTest(commandTimeoutMs=timeout_ms, duration=duration_ms), webdriver_fixture('ios') as fixture:
                fixture['delayClick'] = .15
                cfg = {'appId': APP, 'platform': 'ios', 'url': fixture['url'], 'sessionId': 'existing-session'}
                if timeout_ms is not None:
                    cfg['commandTimeoutMs'] = timeout_ms
                backend = WebDriverBackend(cfg, Budget({'maxDurationMs': duration_ms}))
                if succeeds:
                    self.assertIsNone(backend.request('POST', '/element/open/click', {}))
                else:
                    with self.assertRaises(MobileError) as raised:
                        backend.request('POST', '/element/open/click', {})
                    self.assertEqual(raised.exception.code, 'WEBDRIVER_UNAVAILABLE')
                time.sleep(.2)
                self.assertEqual(len(fixture['calls']), 1, 'A timed-out command must never be retried')

    def test_webdriver_command_timeout_is_bounded_local_configuration(self):
        cfg = {'appId': APP, 'platform': 'ios', 'url': 'http://localhost', 'sessionId': 'owned'}
        self.assertEqual(WebDriverBackend(cfg, Budget({})).command_timeout_ms, 15000)
        backend = WebDriverBackend({**cfg, 'commandTimeoutMs': 60000}, Budget({'maxDurationMs': 90000}))
        self.assertGreater(backend.budget.timeout(backend.command_timeout_ms / 1000), 59)
        limited = Budget({'maxDurationMs': 2000})
        self.assertLessEqual(limited.timeout(60), 2)
        self.assertLessEqual(limited.timeout(.001), .001)
        self.assertLessEqual(Budget({"maxDurationMs": 10}).timeout(60), .01)
        for bad in [True, 0, -1, 120001, '60000', 1.5]:
            with self.assertRaises(MobileError) as raised:
                WebDriverBackend({**cfg, 'commandTimeoutMs': bad}, Budget({}))
            self.assertEqual(raised.exception.code, 'WEBDRIVER_COMMAND_TIMEOUT_INVALID')

    def test_keyboard_search_key_is_outside_app_control_lookup(self):
        xml = '<AppiumAUT><XCUIElementTypeButton type="XCUIElementTypeButton" name="Search" accessible="true"/><XCUIElementTypeKeyboard type="XCUIElementTypeKeyboard"><XCUIElementTypeButton type="XCUIElementTypeButton" name="Search" accessible="true"/></XCUIElementTypeKeyboard></AppiumAUT>'
        tree = parse_tree(xml, 'ios', APP)
        self.assertEqual(locate(tree, {'accessibilityId': 'Search'})['className'], 'XCUIElementTypeButton')
        self.assertFalse(any(node['className'] == 'XCUIElementTypeKeyboard' for node in tree['nodes']))
        backend = WebDriverBackend({'appId': APP, 'platform': 'ios', 'url': 'http://localhost', 'sessionId': 'owned'}, Budget({}))
        calls = []
        backend.request = lambda method, suffix, body: calls.append(body) or [{'element-6066-11e4-a52e-4f735466cecf': 'real'}]
        backend.element({'accessibilityId': 'Search'})
        self.assertIn("not(ancestor-or-self::*[@type='XCUIElementTypeKeyboard'])", calls[0]['value'])

    def test_distinct_placeholder_and_empty_label_prove_name_is_not_input_value(self):
        xml = '<XCUIElementTypeTextField type="XCUIElementTypeTextField" name="Query" value="Query" placeholderValue="Query" label=""/>'
        tree = parse_tree(xml, 'ios', APP)
        self.assertEqual(locate(tree, {'accessibilityId': 'Query'})['text'], '')
        for changed in [xml.replace('placeholderValue="Query"', ''), xml.replace('label=""', 'label="Query"')]:
            self.assertEqual(parse_tree(changed, 'ios', APP)['nodes'][0]['accessibilityId'], '')

if __name__ == '__main__':
    unittest.main()

class UnicodeImeTests(unittest.TestCase):
    def test_opt_in_config_is_exact_and_ascii_default_stays_unconfigured(self):
        from apk_inventory.android_unicode import validate, COMPONENT
        self.assertIsNone(validate(None, MobileError))
        for invalid in [{}, {'component':'other/.Ime','apkSha256':'a'*64}, {'component':COMPONENT,'apkSha256':'A'*64}, {'component':COMPONENT,'apkSha256':'a'*64,'secret':'unused'}]:
            with self.assertRaisesRegex(MobileError, 'UNICODE_IME_CONFIG_INVALID'):
                validate(invalid, MobileError)
        self.assertEqual(validate({'component':COMPONENT,'apkSha256':'a'*64}, MobileError)['component'], COMPONENT)

    def test_single_commit_uses_utf8_nonce_receipt_and_no_retry_on_lost_response(self):
        from apk_inventory import android_unicode
        import base64, hashlib
        class Backend:
            app_id=APP
            unicode_error=MobileError
            def __init__(self): self.commands=[]; self.started=0; self.lost=False
            def _before_workflow_ui_command(self): self.started+=1
            def shell(self,*args):
                self.commands.append(args)
                nonce=args[args.index('nonce')+1]; data=args[args.index('data')+1]
                self.value=base64.b64decode(data).decode('utf-8')
                if self.lost: return 'Broadcast completed: result=0'
                return 'Broadcast completed: result=-1, data="BFS_IME:'+nonce+':'+hashlib.sha256(self.value.encode()).hexdigest()+'"'
        backend=Backend();value='中文 😀 e\u0301 %s & $(id)'
        android_unicode.commit(backend,value,True)
        self.assertEqual(backend.value,value);self.assertEqual(len(backend.commands),1);self.assertEqual(backend.started,1)
        self.assertNotIn(value,str(backend.commands));backend.lost=True
        with self.assertRaisesRegex(MobileError,'UNICODE_IME_RESULT_UNKNOWN'): android_unicode.commit(backend,value+'提交后丢回执',True)
        self.assertEqual(backend.value,value+'提交后丢回执')
        self.assertEqual(len(backend.commands),2);self.assertEqual(backend.started,2)

    def test_helper_identity_and_selection_fail_before_commit(self):
        from apk_inventory import android_unicode
        class Backend:
            unicode_input={'component':android_unicode.COMPONENT,'apkSha256':'a'*64};unicode_error=MobileError
            def __init__(self,wrong):self.wrong=wrong;self.commands=[]
            def shell(self,*args):
                self.commands.append(args)
                if args[:2]==('pm','path'):return 'package:/data/app/test/base.apk'
                if args[0]=='sha256sum':return ('b' if self.wrong=='hash' else 'a')*64+'  /data/app/test/base.apk'
                if args[0]=='settings':return 'other/.Ime' if self.wrong=='ime' else android_unicode.COMPONENT
        for issue,code in [('hash','UNICODE_IME_ARTIFACT_MISMATCH'),('ime','UNICODE_IME_NOT_SELECTED')]:
            backend=Backend(issue)
            with self.assertRaisesRegex(MobileError,code):android_unicode.preflight(backend)
            self.assertFalse(any(command[:2]==('am','broadcast') for command in backend.commands))

    def test_entered_digest_remains_transient_and_out_of_fingerprint(self):
        a=parse_tree(android_tree(input_field=True),'android',APP)
        b=parse_tree(android_tree(input_field=True).replace('DO_NOT_RECORD_EDIT_VALUE','中文 😀'),'android',APP)
        self.assertEqual(a['fingerprint'],b['fingerprint'])
        field=next(node for node in b['nodes'] if node['editable'])
        self.assertEqual(len(field['_inputSha256']),64)

    def test_adb_unicode_replace_append_focus_and_hash_proofs(self):
        import base64, hashlib, html
        from apk_inventory import android_unicode
        class Backend(AdbBackend):
            def __init__(self):
                super().__init__({'appId':APP,'unicodeInput':{'component':android_unicode.COMPONENT,'apkSha256':'a'*64}},Budget({}))
                self.calls=[];self.value='old';self.bad=False;self.focused=True
            def foreground(self):pass
            def observe(self,input_suffix=None):
                return parse_tree(android_tree(input_field=True).replace('DO_NOT_RECORD_EDIT_VALUE',html.escape(self.value,quote=True)).replace('class="android.widget.EditText"','class="android.widget.EditText" focused="'+str(self.focused).lower()+'"'),'android',APP,input_suffix=input_suffix)
            def shell(self,*args):
                self.calls.append(args)
                if args[:2]==('pm','path'):return 'package:/data/app/test/base.apk'
                if args[0]=='sha256sum':return ('b' if self.bad else 'a')*64+'  /data/app/test/base.apk'
                if args[0]=='settings':return android_unicode.COMPONENT
                if args[:2]==('am','broadcast'):
                    nonce=args[args.index('nonce')+1];value=base64.b64decode(args[args.index('data')+1]).decode('utf-8')
                    self.value=value if args[args.index('replace')+1]=='true' else self.value+value
                    return 'Broadcast completed: result=-1, data="BFS_IME:'+nonce+':'+hashlib.sha256(value.encode()).hexdigest()+'"'
                return ''
        backend=Backend();action={'kind':'type','selector':{'resourceId':APP+':id/input'},'input':'query','replace':True};value='中文 😀 e\u0301 %s &'
        backend.perform(action,backend.observe(),{'query':value});self.assertEqual(backend.value,value)
        self.assertEqual(sum(call[:2]==('am','broadcast') for call in backend.calls),1)
        self.assertFalse(any(call[:2]==('input','text') for call in backend.calls))
        append={**action,'replace':False};backend.perform(append,backend.observe(),{'query':' 🚀后缀'});self.assertEqual(backend.value,value+' 🚀后缀')
        backend.calls=[];backend.focused=False
        with self.assertRaisesRegex(MobileError,'UNICODE_IME_TARGET_NOT_FOCUSED'):backend.perform(append,backend.observe(),{'query':'not-entered'})
        self.assertFalse(any(call[:2]==('am','broadcast') for call in backend.calls))
        backend.focused=True
        backend.calls=[];backend.bad=True
        with self.assertRaisesRegex(MobileError,'UNICODE_IME_ARTIFACT_MISMATCH'):backend.perform(action,backend.observe(),{'query':value})
        self.assertFalse(any(call[:2]==('input','tap') for call in backend.calls))
