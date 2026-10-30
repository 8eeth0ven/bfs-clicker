import json
import copy
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from apk_inventory.mobile_planner import plan_tree
from apk_inventory.mobile_ui import MobileSession, parse_tree
from apk_inventory.mobile_workflows import learn_workflow


APP = "com.example.nativequery"


def source(extra="", button="Search"):
    return f'''<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication">
    <XCUIElementTypeTextField type="XCUIElementTypeTextField" name="Query" label="Query" value="PRIVATE_INPUT_VALUE" enabled="true" visible="true" x="0" y="0" width="120" height="40"/>
    <XCUIElementTypeButton type="XCUIElementTypeButton" name="Search" label="{button}" enabled="true" visible="true" x="0" y="50" width="120" height="40"/>
    <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="results" label="PRIVATE_RESULT_VALUE" enabled="true" visible="true" x="0" y="100" width="120" height="40"/>{extra}</XCUIElementTypeApplication></AppiumAUT>'''


def config(url="http://127.0.0.1:1"):
    return {"source": {"id": "ios_query", "kind": "ios"}, "backend": {"type": "webdriver", "platform": "ios", "url": url, "sessionId": "query", "appId": APP},
            "actionAllowlist": [{"kind": "type", "selector": {"accessibilityId": "Query"}, "effect": "read"}]}


class PlannerTests(unittest.TestCase):
    def plan(self, xml=None, cfg=None):
        with tempfile.TemporaryDirectory() as out:
            session = MobileSession(cfg or config(), out)
            return plan_tree(session, parse_tree(xml or source(), "ios", APP))

    def test_native_candidate_retains_private_locators_but_never_claims_ready(self):
        plan = self.plan()
        self.assertEqual(len(plan["items"]), 1)
        item = plan["items"][0]
        self.assertEqual(item["readiness"], "candidate")
        self.assertFalse(item["evidence"]["parameterizationValidated"])
        self.assertEqual(item["inputSchema"]["properties"]["query"]["type"], "string")
        self.assertIn("native_input_constraints_not_observed", item["gaps"])
        self.assertTrue(item["outputTargets"])
        self.assertEqual(plan["specs"][item["id"]]["steps"][0]["selector"], {"accessibilityId": "Query"})
        public = json.dumps({k: v for k, v in plan.items() if k != "specs"})
        for private in ("accessibilityId", "PRIVATE_INPUT_VALUE", "PRIVATE_RESULT_VALUE", '"selector"'):
            self.assertNotIn(private, public)

    def test_ambiguous_input_and_multiple_fields_are_not_guessed_as_one_form(self):
        second = '<XCUIElementTypeTextField type="XCUIElementTypeTextField" name="Second" x="0" y="150" width="120" height="40"/>'
        cfg = config()
        cfg["actionAllowlist"].append({"kind": "type", "selector": {"accessibilityId": "Second"}, "effect": "read"})
        plan = self.plan(source(second), cfg)
        self.assertEqual(plan["items"], [])
        self.assertIn("native_single_input_group_required", plan["gaps"])
        duplicate = second.replace('name="Second"', 'name="Query"')
        plan = self.plan(source(duplicate))
        self.assertEqual(plan["items"], [])
        self.assertIn("ambiguous_native_locator_omitted", plan["gaps"])

    def test_password_write_label_and_unapproved_typing_never_plan_mutations(self):
        self.assertEqual(self.plan(source(button="Delete"))["items"], [])
        cfg = config()
        cfg["actionAllowlist"] = []
        self.assertEqual(self.plan(cfg=cfg)["items"], [])
        self.assertEqual(self.plan(source().replace('XCUIElementTypeTextField', 'XCUIElementTypeSecureTextField'))["items"], [])

    def test_real_cli_reads_w3c_source_without_clicking_or_exposing_session(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                requests.append(("GET", self.path))
                self.reply(source())

            def do_POST(self):
                requests.append(("POST", self.path))
                self.reply({"bundleId": APP})

            def reply(self, value):
                data = json.dumps({"value": value}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as out:
                root = Path(out)
                cfg = root / "config.json"
                cfg.write_text(json.dumps(config(f"http://127.0.0.1:{server.server_port}")))
                result = subprocess.run([sys.executable, "-m", "apk_inventory.mobile_planner", "--config", str(cfg), "--output", str(root / "plan")], capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
                public = json.loads(result.stdout)
                self.assertTrue(public["ok"])
                self.assertEqual(len(public["items"]), 1)
                self.assertTrue((root / "plan/plan.private.json").exists())
                self.assertNotIn("sessionId", json.dumps(public))
                self.assertTrue(all(route.endswith(("/source", "/execute/sync")) for _, route in requests))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)

    def test_two_structural_forms_keep_fields_buttons_and_results_separate(self):
        xml='''<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication">
        <XCUIElementTypeOther type="XCUIElementTypeOther" name="FormA">
          <XCUIElementTypeTextField type="XCUIElementTypeTextField" name="First" keyboardType="numberPad" value="PRIVATE_ONE" x="0" y="0" width="100" height="40"/>
          <XCUIElementTypeTextField type="XCUIElementTypeTextField" name="Second" value="PRIVATE_TWO" x="0" y="40" width="100" height="40"/>
          <XCUIElementTypeButton type="XCUIElementTypeButton" name="SearchA" label="Search A" x="0" y="80" width="100" height="40"/>
          <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="resultsA" label="PRIVATE_RESULT_A" x="0" y="120" width="100" height="40"/>
        </XCUIElementTypeOther>
        <XCUIElementTypeOther type="XCUIElementTypeOther" name="FormB">
          <XCUIElementTypeTextField type="XCUIElementTypeTextField" name="Other" x="200" y="0" width="100" height="40"/>
          <XCUIElementTypeButton type="XCUIElementTypeButton" name="SearchB" label="Search B" x="200" y="80" width="100" height="40"/>
          <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="resultsB" label="PRIVATE_RESULT_B" x="200" y="120" width="100" height="40"/>
        </XCUIElementTypeOther></XCUIElementTypeApplication></AppiumAUT>'''
        cfg=config()
        cfg['actionAllowlist']=[{'kind':'type','selector':{'accessibilityId':name},'effect':'read'} for name in ['First','Second','Other']]
        plan=self.plan(xml,cfg);self.assertEqual(len(plan['items']),2)
        specs=list(plan['specs'].values());multi=next(spec for spec in specs if len(spec['inputSchema']['properties'])==2)
        self.assertEqual(set(multi['inputSchema']['properties']),{'First','Second'})
        self.assertEqual(multi['steps'][-1]['selector'],{'accessibilityId':'SearchA'})
        self.assertEqual([target['selector'] for target in multi['outcomeCandidates']],[{'accessibilityId':'resultsA'}])
        item=next(item for item in plan['items'] if len(item['inputSchema']['properties'])==2)
        self.assertEqual(item['nativeInputs'][0]['inputType'],'numberPad')
        self.assertFalse(item['nativeInputs'][0]['businessRequiredObserved'])
        self.assertEqual(item['inputSchema']['properties']['First']['type'],'string')
        public=json.dumps({key:value for key,value in plan.items() if key!='specs'})
        for secret in ['PRIVATE_ONE','PRIVATE_TWO','PRIVATE_RESULT_A','PRIVATE_RESULT_B','accessibilityId','selector']:
            self.assertNotIn(secret,public)

    def test_mixed_boolean_fields_require_explicit_check_policy_and_never_become_buttons_or_outputs(self):
        xml='<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication"><XCUIElementTypeOther type="XCUIElementTypeOther" name="Filters"><XCUIElementTypeTextField type="XCUIElementTypeTextField" name="Query" x="0" y="0" width="100" height="40"/><XCUIElementTypeSwitch type="XCUIElementTypeSwitch" name="IncludeArchived" value="0" label="Search archived" x="0" y="40" width="100" height="40"/><XCUIElementTypeButton type="XCUIElementTypeButton" name="Search" label="Search" x="0" y="80" width="100" height="40"/><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="results" label="Output" x="0" y="120" width="100" height="40"/></XCUIElementTypeOther></XCUIElementTypeApplication></AppiumAUT>'
        cfg=config();cfg['actionAllowlist'].append({'kind':'check','selector':{'accessibilityId':'IncludeArchived'},'effect':'read'});plan=self.plan(xml,cfg);self.assertEqual(len(plan['items']),1);spec=next(iter(plan['specs'].values()))
        self.assertEqual(spec['inputSchema']['properties']['IncludeArchived'],{'type':'boolean'});self.assertEqual([step['kind'] for step in spec['steps']],['type','check','click']);self.assertEqual([target['selector'] for target in spec['outcomeCandidates']],[{'accessibilityId':'results'}]);self.assertNotIn('selector',json.dumps({key:value for key,value in plan.items() if key!='specs'}))
        for change in ['readonly','missing','click_only']:
            bad_xml=xml.replace('value="0"','readonly="true" value="0"') if change=='readonly' else xml.replace('value="0"','') if change=='missing' else xml
            bad_cfg=copy.deepcopy(cfg)
            if change=='click_only':bad_cfg['actionAllowlist'][-1]['kind']='click'
            bad=self.plan(bad_xml,bad_cfg)
            for candidate in bad['specs'].values():self.assertNotIn('IncludeArchived',candidate['inputSchema']['properties'])

    def test_android_radio_without_actual_radio_group_is_not_guessed_as_boolean(self):
        xml=f'<hierarchy><node package="{APP}" resource-id="{APP}:id/Filters" class="android.widget.LinearLayout" bounds="[0,0][200,200]"><node package="{APP}" resource-id="{APP}:id/Choice" class="android.widget.RadioButton" checked="false" checkable="true" clickable="true" bounds="[0,0][100,40]"/><node package="{APP}" resource-id="{APP}:id/Search" class="android.widget.Button" text="Search" clickable="true" bounds="[0,40][100,80]"/><node package="{APP}" resource-id="{APP}:id/Results" class="android.widget.TextView" text="Output" bounds="[0,80][100,120]"/></node></hierarchy>'
        cfg={'source':{'id':'radio','kind':'apk'},'backend':{'type':'webdriver','platform':'android','url':'http://127.0.0.1:1','sessionId':'radio','appId':APP},'actionAllowlist':[{'kind':'check','selector':{'resourceId':APP+':id/Choice'},'effect':'read'}]}
        with tempfile.TemporaryDirectory() as out:
            plan=plan_tree(MobileSession(cfg,out),parse_tree(xml,'android',APP));self.assertEqual(plan['items'],[]);self.assertIn('native_radio_requires_complete_group',plan['gaps'])

    def test_android_radio_and_ios_segmented_group_are_one_string_enum_with_private_options(self):
        for platform in ['android','ios']:
            with self.subTest(platform=platform),tempfile.TemporaryDirectory() as out:
                identify=lambda name:{'resourceId':APP+':id/'+name} if platform=='android' else {'accessibilityId':name}
                if platform=='android':
                    options=''.join(f'<node package="{APP}" resource-id="{APP}:id/{name}" class="android.widget.RadioButton" checkable="true" checked="{str(name=="all").lower()}" text="{name.title()}" clickable="true" bounds="[0,0][100,40]"/>' for name in ['all','open','closed'])
                    xml=f'<hierarchy><node package="{APP}" resource-id="{APP}:id/Filters" class="android.widget.LinearLayout" bounds="[0,0][300,400]"><node package="{APP}" resource-id="{APP}:id/Query" class="android.widget.EditText" bounds="[0,0][100,40]"/><node package="{APP}" resource-id="{APP}:id/StatusGroup" class="android.widget.RadioGroup" bounds="[0,0][300,80]">{options}</node><node package="{APP}" resource-id="{APP}:id/Search" class="android.widget.Button" text="Search" clickable="true" bounds="[0,80][100,120]"/><node package="{APP}" resource-id="{APP}:id/results" class="android.widget.TextView" text="Output" bounds="[0,120][100,160]"/></node></hierarchy>'
                else:
                    options=''.join(f'<XCUIElementTypeButton type="XCUIElementTypeButton" name="{name}" selected="{str(name=="all").lower()}" label="{name.title()}" x="0" y="0" width="100" height="40"/>' for name in ['all','open','closed'])
                    xml=f'<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication"><XCUIElementTypeOther type="XCUIElementTypeOther" name="Filters"><XCUIElementTypeTextField type="XCUIElementTypeTextField" name="Query" x="0" y="0" width="100" height="40"/><XCUIElementTypeSegmentedControl type="XCUIElementTypeSegmentedControl" name="StatusGroup" x="0" y="0" width="300" height="40">{options}</XCUIElementTypeSegmentedControl><XCUIElementTypeButton type="XCUIElementTypeButton" name="Search" label="Search" x="0" y="80" width="100" height="40"/><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="results" label="Output" x="0" y="120" width="100" height="40"/></XCUIElementTypeOther></XCUIElementTypeApplication></AppiumAUT>'
                cfg={'source':{'id':'groups','kind':'apk' if platform=='android' else 'ios'},'backend':{'type':'webdriver','platform':platform,'url':'http://127.0.0.1:1','sessionId':'groups','appId':APP},'actionAllowlist':[{'kind':'type','selector':identify('Query'),'effect':'read'},{'kind':'select','selector':identify('StatusGroup'),'effect':'read'}]+[{'kind':'check','selector':identify(name),'effect':'read'} for name in ['all','open','closed']]}
                session=MobileSession(cfg,out);plan=plan_tree(session,parse_tree(xml,platform,APP));self.assertEqual(len(plan['items']),1);spec=next(iter(plan['specs'].values()));self.assertEqual(spec['inputSchema']['properties']['StatusGroup'],{'type':'string','enum':['all','open','closed']});self.assertEqual(set(spec['inputSchema']['properties']),{'StatusGroup','Query'});step=next(step for step in spec['steps'] if step['kind']=='select');self.assertEqual([option['selector'] for option in step['options']],[identify(name) for name in ['all','open','closed']]);self.assertEqual([target['selector'] for target in spec['outcomeCandidates']],[identify('results')])
                public=json.dumps({key:value for key,value in plan.items() if key!='specs'});self.assertNotIn('selector',public);item=plan['items'][0];enum_field=next(field for field in item['nativeInputs'] if field['param']=='StatusGroup');self.assertEqual(enum_field['enumOptions'],[{'value':name,'label':name.title()} for name in ['all','open','closed']])
                for defect in ['unknown','multiple','group_disabled','group_readonly','no_group_policy','no_option_policy']:
                    bad_xml=xml;bad_cfg=copy.deepcopy(cfg)
                    if defect=='unknown':bad_xml=xml.replace('checked="false"','checked="mixed"').replace('selected="false"','selected="mixed"')
                    elif defect=='multiple':bad_xml=xml.replace('checked="false"','checked="true"').replace('selected="false"','selected="true"')
                    elif defect in {'group_disabled','group_readonly'}:
                        marker=f'resource-id="{APP}:id/StatusGroup"' if platform=='android' else 'name="StatusGroup"'
                        bad_xml=xml.replace(marker,marker+(' enabled="false"' if defect=='group_disabled' else ' readonly="true"'))
                    elif defect=='no_group_policy':bad_cfg['actionAllowlist']=[row for row in bad_cfg['actionAllowlist'] if row['kind']!='select']
                    else:bad_cfg['actionAllowlist'].pop()
                    bad=plan_tree(MobileSession(bad_cfg,out),parse_tree(bad_xml,platform,APP));self.assertTrue(any('native_selection_group_' in gap for gap in bad['gaps']));self.assertFalse(any(step['kind']=='select' for candidate in bad['specs'].values() for step in candidate['steps']))

    def test_outer_page_button_does_not_join_two_inner_forms_and_names_are_safe(self):
        xml='''<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication"><XCUIElementTypeOther type="XCUIElementTypeOther" name="Page">
        <XCUIElementTypeOther type="XCUIElementTypeOther" name="FormA"><XCUIElementTypeTextField type="XCUIElementTypeTextField" name="客户" x="0" y="0" width="100" height="40"/><XCUIElementTypeTextField type="XCUIElementTypeTextField" name="123name" x="0" y="40" width="100" height="40"/><XCUIElementTypeButton type="XCUIElementTypeButton" name="SearchA" label="Search A" x="0" y="80" width="100" height="40"/><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="rA" label="A" x="0" y="120" width="100" height="40"/></XCUIElementTypeOther>
        <XCUIElementTypeOther type="XCUIElementTypeOther" name="FormB"><XCUIElementTypeTextField type="XCUIElementTypeTextField" name="__proto__" x="200" y="0" width="100" height="40"/><XCUIElementTypeButton type="XCUIElementTypeButton" name="SearchB" label="Search B" x="200" y="80" width="100" height="40"/></XCUIElementTypeOther>
        <XCUIElementTypeButton type="XCUIElementTypeButton" name="SearchAll" label="Search all" x="0" y="200" width="100" height="40"/></XCUIElementTypeOther></XCUIElementTypeApplication></AppiumAUT>'''
        cfg=config();cfg['actionAllowlist']=[{'kind':'type','selector':{'accessibilityId':name},'effect':'read'} for name in ['客户','123name','__proto__']]
        plan=self.plan(xml,cfg)
        self.assertEqual(len(plan['items']),2)
        for spec in plan['specs'].values():
            self.assertNotEqual(spec['steps'][-1]['selector'],{'accessibilityId':'SearchAll'})
            self.assertLessEqual(len(spec['inputSchema']['properties']),2)
            for name in spec['inputSchema']['properties']:
                self.assertRegex(name,r'^[A-Za-z][A-Za-z0-9_]{0,63}$');self.assertNotIn(name,['__proto__','constructor','prototype'])

    def test_readonly_and_secure_fields_are_not_added_to_multifield_steps(self):
        xml='''<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication"><XCUIElementTypeOther type="XCUIElementTypeOther" name="QueryGroup"><XCUIElementTypeTextField type="XCUIElementTypeTextField" name="Query" x="0" y="0" width="100" height="40"/><XCUIElementTypeTextField type="XCUIElementTypeTextField" name="Locked" readonly="true" x="0" y="40" width="100" height="40"/><XCUIElementTypeSecureTextField type="XCUIElementTypeSecureTextField" name="Secret" x="0" y="80" width="100" height="40"/><XCUIElementTypeButton type="XCUIElementTypeButton" name="Search" label="Search" x="0" y="120" width="100" height="40"/><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="results" label="Output" x="0" y="160" width="100" height="40"/></XCUIElementTypeOther></XCUIElementTypeApplication></AppiumAUT>'''
        cfg=config();cfg['actionAllowlist'] += [{'kind':'type','selector':{'accessibilityId':name},'effect':'read'} for name in ['Locked','Secret']]
        plan=self.plan(xml,cfg);self.assertEqual(len(plan['items']),1)
        self.assertIn('native_readonly_input_omitted',plan['gaps'])
        self.assertNotIn('Locked',json.dumps(plan['specs']));self.assertNotIn('Secret',json.dumps(plan['specs']))

    def test_duplicate_container_identifiers_cannot_merge_independent_forms(self):
        xml='<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication">'
        for suffix in ['A','B']:
            xml+='<XCUIElementTypeOther type="XCUIElementTypeOther" name="RepeatedForm"><XCUIElementTypeTextField type="XCUIElementTypeTextField" name="Field'+suffix+'" x="0" y="0" width="100" height="40"/><XCUIElementTypeButton type="XCUIElementTypeButton" name="Search'+suffix+'" label="Search" x="0" y="50" width="100" height="40"/></XCUIElementTypeOther>'
        xml+='</XCUIElementTypeApplication></AppiumAUT>'
        cfg=config();cfg['actionAllowlist']=[{'kind':'type','selector':{'accessibilityId':'Field'+suffix},'effect':'read'} for suffix in ['A','B']]
        plan=self.plan(xml,cfg);self.assertEqual(plan['items'],[]);self.assertIn('ambiguous_native_group_omitted',plan['gaps'])

    def test_cross_state_candidate_requires_observed_inventory_and_read_prefix_then_replays_for_samples(self):
        with native_pages() as fixture,tempfile.TemporaryDirectory() as out:
            root=Path(out);cfg=fixture['config'];explorer=MobileSession(cfg,root/'explore');explorer.explore()
            original_checkpoint=(root/'explore/checkpoint.json').read_bytes();original_events=(root/'explore/events.jsonl').read_bytes()
            checkpoint=json.loads((root/'explore/checkpoint.json').read_text());events=[json.loads(line) for line in (root/'explore/events.jsonl').read_text().splitlines()]
            fixture['page']='entry'
            planner=MobileSession(cfg,root/'plan');live=planner.backend.observe();plan=plan_tree(planner,live,checkpoint,events)
            candidates=[item for item in plan['items'] if item['evidence']['prefixLength']==1]
            self.assertEqual(len(candidates),1)
            item=candidates[0];self.assertEqual(set(item['inputSchema']['properties']),{'First','Second'});self.assertEqual(item['readiness'],'candidate')
            definition=copy.deepcopy(plan['specs'][item['id']]);target=definition.pop('outcomeCandidates')[0]
            definition['steps'] += [{'kind':'assert','selector':target['selector'],'expect':{'containsInput':field}} for field in ['First','Second']]
            definition['steps'].append({'kind':'extract','selector':target['selector'],'output':'result','valueType':'string'})
            learner=MobileSession(cfg,root/'learn');learn_workflow(learner,definition,[{'First':'alpha','Second':'one'},{'First':'beta','Second':'two'}]);recipe=next(iter(learner.progress['recipes'].values()))
            result=MobileSession(cfg,root/'execute').execute(recipe,recipe['revision'],{'First':'gamma','Second':'three'})
            self.assertEqual(result['outputs']['result'],'gamma|three');self.assertEqual(fixture['queries'],[('alpha','one'),('beta','two'),('gamma','three')])
            self.assertGreaterEqual(fixture['backs'],2);self.assertGreaterEqual(fixture['opens'],4)
            public=json.dumps({key:value for key,value in plan.items() if key!='specs'});self.assertNotIn('entryPrefix',public);self.assertNotIn('selector',public)

            expected_gaps={'missing_finished':'native_read_prefix_not_proven','wrong_digest':'native_state_inventory_not_proven','write_prefix':'native_read_prefix_not_proven','identity':'native_checkpoint_identity_mismatch','broken_path':'native_read_prefix_not_proven','truncated':'native_state_inventory_truncated','before_inventory_digest':'native_read_prefix_not_proven'}
            for defect,expected_gap in expected_gaps.items():
                with self.subTest(defect=defect):
                    cp=copy.deepcopy(checkpoint);rows=copy.deepcopy(events)
                    if defect=='missing_finished':rows=[row for row in rows if row['kind']!='ui_action_finished']
                    elif defect=='wrong_digest':next(state for state in cp['states'].values() if state['path'])['workflowInventoryDigest']='0'*64
                    elif defect=='write_prefix':next(state for state in cp['states'].values() if state['path'])['path'][0]['action']={'kind':'type','selector':{'accessibilityId':'First'},'input':'text'}
                    elif defect=='identity':cp['identity']='not-the-device-profile'
                    elif defect=='truncated':next(state for state in cp['states'].values() if state['path'])['workflowInventory']['truncated']=True
                    elif defect=='before_inventory_digest':cp['states'][cp['entry']]['workflowInventoryDigest']='0'*64
                    else:next(state for state in cp['states'].values() if state['path'])['path'][0]['before']='f'*64
                    bad=plan_tree(planner,live,cp,rows)
                    self.assertFalse(any(candidate['evidence']['prefixLength'] for candidate in bad['items']))
                    self.assertIn(expected_gap,bad['gaps'])
            cfg_file=root/'config.json';cfg_file.write_text(json.dumps(cfg));before=(list(fixture['queries']),fixture['backs'],fixture['opens'])
            child=subprocess.run([sys.executable,'-m','apk_inventory.mobile_planner','--config',str(cfg_file),'--output',str(root/'cli-plan'),'--inventory',str(root/'explore')],capture_output=True,text=True,timeout=10)
            self.assertEqual(child.returncode,0,child.stderr+child.stdout)
            public=json.loads(child.stdout);self.assertTrue(any(item['evidence']['prefixLength']==1 for item in public['items']))
            self.assertEqual((fixture['queries'],fixture['backs'],fixture['opens']),before)
            self.assertEqual((root/'explore/checkpoint.json').read_bytes(),original_checkpoint);self.assertEqual((root/'explore/events.jsonl').read_bytes(),original_events)


def native_pages():
    """Stateful W3C HTTP pages; exploration opens read-only form, samples query."""
    from contextlib import contextmanager
    @contextmanager
    def fixture():
        state={'page':'entry','values':{'First':'','Second':''},'result':'EMPTY','queries':[],'backs':0,'opens':0}
        def xml():
            if state['page']=='entry':
                return '<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication"><XCUIElementTypeButton type="XCUIElementTypeButton" name="OpenFilters" label="Open filters" x="0" y="0" width="100" height="40"/></XCUIElementTypeApplication></AppiumAUT>'
            return '<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication"><XCUIElementTypeOther type="XCUIElementTypeOther" name="FilterForm">'+''.join('<XCUIElementTypeTextField type="XCUIElementTypeTextField" name="'+name+'" value="'+state['values'][name]+'" x="0" y="0" width="100" height="40"/>' for name in ['First','Second'])+'<XCUIElementTypeButton type="XCUIElementTypeButton" name="Search" label="Search" x="0" y="80" width="100" height="40"/><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="results" label="'+state['result']+'" x="0" y="120" width="100" height="40"/></XCUIElementTypeOther></XCUIElementTypeApplication></AppiumAUT>'
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*_):pass
            def do_GET(self):self.handle_command()
            def do_POST(self):self.handle_command()
            def handle_command(self):
                length=int(self.headers.get('Content-Length',0));body=json.loads(self.rfile.read(length)) if length else {}
                route=self.path.removeprefix('/session/query')
                if route=='/source':value=xml()
                elif route=='/execute/sync':value={'bundleId':APP}
                elif route=='/elements':
                    name=next((name for name in ['First','Second','OpenFilters','Search'] if name in body['value']),None)
                    value=[{'element-6066-11e4-a52e-4f735466cecf':name}] if name else []
                elif route=='/element/OpenFilters/click':state.update(page='form',values={'First':'','Second':''},result='EMPTY');state['opens']+=1;value=None
                elif route=='/element/Search/click':state['queries'].append((state['values']['First'],state['values']['Second']));state['result']='|'.join(state['queries'][-1]);value=None
                elif route=='/back':state['page']='entry';state['backs']+=1;value=None
                elif route.endswith('/clear'):state['values'][route.split('/')[2]]='';value=None
                elif route.endswith('/value'):state['values'][route.split('/')[2]]+=body['text'];value=None
                else:self.send_error(404);return
                raw=json.dumps({'value':value}).encode();self.send_response(200);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        state['config']=config('http://127.0.0.1:'+str(server.server_port));state['config']['limits']={'maxActions':30,'maxDepth':1,'maxDurationMs':15000};state['config']['actionAllowlist']=[{'kind':'type','selector':{'accessibilityId':name},'effect':'read'} for name in ['First','Second']]
        try:yield state
        finally:server.shutdown();server.server_close();thread.join(2)
    return fixture()


if __name__ == "__main__":
    unittest.main()
