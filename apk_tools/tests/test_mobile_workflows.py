"""Dynamic local UI protocol -> real HTTP calculation -> asserted UI result."""
from contextlib import contextmanager
import copy
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

from apk_inventory.mobile_ui import MobileError, MobileSession, parse_tree
from apk_inventory.mobile_workflows import learn_workflow

APP = "com.example.workflow"


@contextmanager
def calculator(platform="android"):
    state = {"input": "", "total": 0, "calls": [], "apiInputs": [], "clearCount": 0, "duplicate": False, "freezeResult": False, "buttonLabel":"Calculate", "buttonClass":"android.widget.Button" if platform=='android' else 'XCUIElementTypeButton', "delayMs":0, "neverUpdate":False, "pending":None, "pendingReads":0, "sourceReads":0, "resultText":None}
    def source():
        state['sourceReads']+=1
        if state['pending'] is not None:
            if not state['neverUpdate'] and time.monotonic()>=state['pending']['at']:
                state['total']=state['pending']['total'];state['resultText']=state['pending']['text'];state['pending']=None;state['hasResult']=True
            else:
                state['pendingReads']+=1
                if state.get('onPendingRead'):state['onPendingRead'](state['pendingReads'])
        if state.get('prefixMode') and state.get('page')=='root':
            return '<hierarchy><node package="'+APP+'" resource-id="'+APP+':id/open" class="android.widget.Button" text="'+state.get('openLabel','Open search')+'" clickable="true" bounds="[0,0][100,50]"/></hierarchy>'
        text=state['resultText'] if state['resultText'] is not None else 'TOTAL:'+str(state['total'])
        show=not state.get('hideUntilResult') or state.get('hasResult')
        if platform == "android":
            field = '<node package="'+APP+'" resource-id="'+APP+':id/quantity" class="android.widget.EditText" text="'+state['input']+'" input-type="'+state.get('inputType','')+'" readonly="'+str(state.get('readOnly',False)).lower()+'" bounds="[0,0][100,50]"/>'
            result='<hierarchy>'+field*(2 if state['duplicate'] else 1)+'<node package="'+APP+'" resource-id="'+APP+':id/calculate" class="'+state['buttonClass']+'" text="'+state['buttonLabel']+'" clickable="true" bounds="[100,0][200,50]"/>'+(('<node package="'+APP+'" resource-id="'+APP+':id/result" class="android.widget.TextView" text="'+text+'" bounds="[0,50][200,100]"/>') if show else '')+'</hierarchy>'
        else:
            result='<AppiumAUT><XCUIElementTypeTextField type="XCUIElementTypeTextField" name="quantity" label="Quantity" value="'+state['input']+'" x="0" y="0" width="100" height="50"/><XCUIElementTypeButton type="'+state['buttonClass']+'" name="calculate" label="'+state['buttonLabel']+'" x="100" y="0" width="100" height="50"/>'+('<XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="result" label="'+text+'" x="0" y="50" width="200" height="50"/>' if show else '')+'</AppiumAUT>'
        if state.get('prefixMode') and platform=='android':result=result.replace('<hierarchy>','<hierarchy><node package="'+APP+'" resource-id="'+APP+':id/searchForm" class="android.widget.LinearLayout" bounds="[0,0][200,200]">').replace('</hierarchy>','</node></hierarchy>')
        if state.get('onSource'):state['onSource'](text)
        return result
    state['source'] = source

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):pass
        def reply(self, value, status=200):
            raw=json.dumps({'value':value}).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
        def calculate(self):
            with urlopen(state['url']+'/calculate?quantity='+state['input'],timeout=3) as response:
                value=json.load(response)['value']['total']
            text=state.get('echoPrefix','')+state['input'] if 'echoPrefix' in state else None
            if state['delayMs'] or state['neverUpdate']:
                state['pending']={'total':value,'text':text,'at':time.monotonic()+state['delayMs']/1000}
            else:
                state['total']=value;state['resultText']=text;state['hasResult']=True
        def handle_command(self):
            length=int(self.headers.get('Content-Length',0));body=json.loads(self.rfile.read(length)) if length else None
            state['calls'].append((self.command_name,self.path,body))
            if self.path.startswith('/calculate?'):
                value=int(parse_qs(urlsplit(self.path).query)['quantity'][0]);state['apiInputs'].append(value)
                return self.reply({'total':9 if state['freezeResult'] else value*value})
            route=self.path.removeprefix('/session/workflow-session')
            if route=='/source':return self.reply(source())
            if route=='/appium/device/current_package':return self.reply(APP)
            if route=='/execute/sync':return self.reply({'bundleId':APP})
            if route=='/elements':
                self.assert_xpath(body)
                field='open' if ':id/open' in body['value'] else 'quantity' if 'quantity' in body['value'] else 'calculate'
                return self.reply([{'element-6066-11e4-a52e-4f735466cecf':field}])
            if route=='/element/open/click':state['page']='form';state['input']='';state['total']=0;state['resultText']=None;return self.reply(None)
            if route=='/back':state['page']='root';return self.reply(None)
            if route=='/element/quantity/clear':state['input']='';state['clearCount']+=1;return self.reply(None)
            if route=='/element/quantity/value':
                state['input']+=body['text']
                if state.get('computeOnInput'):self.calculate()
                return self.reply(None)
            if route=='/element/calculate/click':
                self.calculate()
                if state.get('driftAfterFirstCalc') and len(state['apiInputs'])==1:state['buttonLabel']='Delete account'
                return self.reply(None)
            return self.reply({'error':'unknown command'},404)
        def assert_xpath(self,body):
            if body.get('using')!='xpath':raise AssertionError('Expected actual W3C structured XPath lookup')
        def do_GET(self):self.command_name='GET';self.handle_command()
        def do_POST(self):self.command_name='POST';self.handle_command()
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
    state['url']='http://127.0.0.1:'+str(server.server_port)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:yield state
    finally:server.shutdown();server.server_close();thread.join(timeout=3)


def setup(fixture, platform='android'):
    identify=lambda name: {'resourceId':APP+':id/'+name} if platform=='android' else {'accessibilityId':name}
    config={'source':{'id':'workflow_fixture','kind':'apk' if platform=='android' else 'ios'},'backend':{'type':'webdriver','platform':platform,'url':fixture['url'],'sessionId':'workflow-session','appId':APP},'limits':{'maxActions':20,'maxDepth':3,'maxDurationMs':60000},'actionAllowlist':[{'kind':'type','selector':identify('quantity'),'effect':'read'},{'kind':'click','selector':identify('calculate'),'effect':'read'}]}
    definition={'schemaVersion':1,'id':'square_quantity','name':'Square quantity','effect':'read','inputSchema':{'type':'object','properties':{'quantity':{'type':'integer','minimum':1,'maximum':20}},'required':['quantity'],'additionalProperties':False},'steps':[{'kind':'type','selector':identify('quantity'),'input':'quantity','replace':True},{'kind':'click','selector':identify('calculate')},{'kind':'assert','selector':identify('result'),'expect':{'matches':'^TOTAL:[0-9]+$'},'timeoutMs':1000},{'kind':'extract','selector':identify('result'),'output':'total','pattern':'^TOTAL:([0-9]+)$','group':1,'valueType':'integer'}]}
    return config,definition


class WorkflowTests(unittest.TestCase):
    def test_android_protocol_learns_distinct_real_calculations_then_executes_third_input(self):
        self.exercise('android')

    def test_ios_protocol_keeps_stable_field_identifier_and_ignores_dynamic_page_fp(self):
        self.exercise('ios')

    def exercise(self,platform):
        with calculator(platform) as fixture,tempfile.TemporaryDirectory() as directory:
            config,definition=setup(fixture,platform);session=MobileSession(config,Path(directory,'learn'))
            before=parse_tree(fixture['source'](),platform,APP)['fingerprint']
            learned=learn_workflow(session,definition,[{'quantity':2},{'quantity':7}])
            self.assertTrue(learned['ok']);self.assertEqual(fixture['apiInputs'],[2,7]);self.assertEqual(fixture['total'],49)
            self.assertNotEqual(parse_tree(fixture['source'](),platform,APP)['fingerprint'],before)
            recipe=next(iter(session.progress['recipes'].values()))
            self.assertEqual(recipe['recipeType'],'workflow');self.assertNotIn('inputs',recipe)
            cap=next(iter(session.progress['capabilities'].values()));self.assertEqual(cap['inputSchema'],definition['inputSchema']);self.assertEqual(cap['readiness'],'ready')
            executor=MobileSession(config,Path(directory,'execute'))
            result=executor.execute(recipe,recipe['revision'],{'quantity':11})
            self.assertEqual(result['outputs'],{'total':121});self.assertEqual(result['assertionsPassed'],1);self.assertEqual(fixture['apiInputs'],[2,7,11]);self.assertEqual(fixture['clearCount'],3)
            self.assertFalse(result['networkObserved'])
            self.assertTrue(any(path=='/element/quantity/clear' or path.endswith('/quantity/clear') for _,path,_ in fixture['calls']))

    def test_equal_inputs_and_invalid_input_fail_before_any_protocol_request(self):
        with calculator() as fixture,tempfile.TemporaryDirectory() as directory:
            config,definition=setup(fixture);session=MobileSession(config,directory)
            for samples in ([{'quantity':2},{'quantity':2}],[{'quantity':2},{'quantity':'invalid'}]):
                with self.assertRaises(MobileError):learn_workflow(session,definition,samples)
            self.assertEqual(fixture['calls'],[])

    def test_same_id_button_label_or_class_drift_causes_zero_new_clicks(self):
        with calculator('ios') as fixture,tempfile.TemporaryDirectory() as directory:
            config,definition=setup(fixture,'ios');session=MobileSession(config,Path(directory,'learn'))
            learn_workflow(session,definition,[{'quantity':2},{'quantity':7}]);recipe=next(iter(session.progress['recipes'].values()))
            for name,value in [('buttonLabel','Delete account'),('buttonClass','XCUIElementTypeCell')]:
                with self.subTest(field=name):
                    fixture['buttonLabel']='Calculate';fixture['buttonClass']='XCUIElementTypeButton';fixture[name]=value
                    before=len(fixture['apiInputs']);executor=MobileSession(config,Path(directory,name))
                    with self.assertRaises(MobileError) as caught:executor.execute(recipe,recipe['revision'],{'quantity':5})
                    self.assertEqual(caught.exception.code,'WORKFLOW_CONTROL_CONTRACT_CHANGED')
                    self.assertEqual(len(fixture['apiInputs']),before)

    def test_second_learning_sample_must_keep_the_first_control_contract(self):
        with calculator() as fixture,tempfile.TemporaryDirectory() as directory:
            fixture['driftAfterFirstCalc']=True;config,definition=setup(fixture);session=MobileSession(config,directory)
            with self.assertRaises(MobileError) as caught:learn_workflow(session,definition,[{'quantity':2},{'quantity':7}])
            self.assertEqual(caught.exception.code,'WORKFLOW_CONTROL_CONTRACT_CHANGED')
            self.assertEqual(fixture['apiInputs'],[2]);self.assertFalse(session.progress['recipes'])

    def test_fake_adb_process_replaces_previous_value_and_returns_computed_http_result(self):
        with calculator() as fixture,tempfile.TemporaryDirectory() as directory:
            root=Path(directory);state_file=root/'device.json';state_file.write_text(json.dumps({'input':'','total':0,'commands':[]}))
            executable=root/'adb-calculator'
            script='''#!PYTHON
import json,shlex,sys
from pathlib import Path
from urllib.request import urlopen
p=Path(STATE);s=json.loads(p.read_text());args=sys.argv[1:];s['commands'].append(args);result=''
if args[0]=='devices':result='List of devices attached\\ncalculator-device\\tdevice product:fixture\\n'
else:
 a=shlex.split(args[3])
 if a[:2]==['dumpsys','activity']:result='mResumedActivity: ActivityRecord{abc u0 '+APP+'/.Main t1}'
 elif a[0]=='cat':result='<hierarchy><node package="'+APP+'" resource-id="'+APP+':id/quantity" class="android.widget.EditText" text="'+s['input']+'" bounds="[0,0][100,50]"/><node package="'+APP+'" resource-id="'+APP+':id/calculate" class="android.widget.Button" text="Calculate" clickable="true" bounds="[100,0][200,50]"/><node package="'+APP+'" resource-id="'+APP+':id/result" class="android.widget.TextView" text="TOTAL:'+str(s['total'])+'" bounds="[0,50][200,100]"/></hierarchy>'
 elif a[:2]==['input','text']:s['input']+=a[2].replace('%s',' ')
 elif a[:2]==['input','keyevent']:
  for key in a[2:]:
   if key=='67':s['input']=s['input'][:-1]
 elif a[:2]==['input','tap'] and int(a[2])>100:
  with urlopen(ORIGIN+'/calculate?quantity='+s['input'],timeout=3) as r:s['total']=json.load(r)['value']['total']
p.write_text(json.dumps(s));print(result)
'''.replace('PYTHON',sys.executable).replace('STATE',repr(str(state_file))).replace('ORIGIN',repr(fixture['url'])).replace('APP',repr(APP))
            executable.write_text(script);executable.chmod(0o700)
            config,definition=setup(fixture);config['backend']={'type':'adb','adb':str(executable),'deviceId':'calculator-device','appId':APP};config['limits']['maxDurationMs']=90000
            session=MobileSession(config,root/'learn');learn_workflow(session,definition,[{'quantity':2},{'quantity':7}]);recipe=next(iter(session.progress['recipes'].values()))
            executor=MobileSession(config,root/'execute');result=executor.execute(recipe,recipe['revision'],{'quantity':11})
            self.assertEqual(result['outputs'],{'total':121});self.assertEqual(fixture['apiInputs'],[2,7,11]);state=json.loads(state_file.read_text());self.assertEqual(state['input'],'11')
            self.assertTrue(any('input keyevent 67' in ' '.join(row) for row in state['commands']))

    def test_constant_response_cannot_be_promoted_by_two_different_inputs(self):
        with calculator() as fixture,tempfile.TemporaryDirectory() as directory:
            fixture['freezeResult']=True;config,definition=setup(fixture);session=MobileSession(config,directory)
            with self.assertRaises(MobileError) as caught:learn_workflow(session,definition,[{'quantity':2},{'quantity':7}])
            self.assertEqual(caught.exception.code,'WORKFLOW_REQUIRES_RESULT_VARIATION');self.assertFalse(session.progress['recipes']);self.assertEqual(fixture['apiInputs'],[2,7])

    def test_unapproved_actions_ambiguity_and_failed_result_assertion_never_publish_ready(self):
        with calculator() as fixture,tempfile.TemporaryDirectory() as directory:
            config,definition=setup(fixture);config['actionAllowlist']=[];session=MobileSession(config,directory)
            with self.assertRaises(MobileError) as caught:learn_workflow(session,definition,[{'quantity':2},{'quantity':7}])
            self.assertEqual(caught.exception.code,'WORKFLOW_ACTION_NOT_READ_ALLOWLISTED');self.assertEqual(fixture['calls'],[])
        with calculator() as fixture,tempfile.TemporaryDirectory() as directory:
            fixture['duplicate']=True;config,definition=setup(fixture);session=MobileSession(config,directory)
            with self.assertRaises(MobileError) as caught:learn_workflow(session,definition,[{'quantity':2},{'quantity':7}])
            self.assertEqual(caught.exception.code,'SELECTOR_AMBIGUOUS');self.assertEqual(fixture['apiInputs'],[])
        with calculator() as fixture,tempfile.TemporaryDirectory() as directory:
            config,definition=setup(fixture);definition['steps'][2]['expect']={'equals':'TOTAL:999'};definition['steps'][2]['timeoutMs']=0;session=MobileSession(config,directory)
            with self.assertRaises(MobileError) as caught:learn_workflow(session,definition,[{'quantity':2},{'quantity':7}])
            self.assertEqual(caught.exception.code,'WORKFLOW_ASSERTION_FAILED');self.assertFalse(session.progress['recipes'])

    def test_cli_alias_learn_and_execute_files_are_real_not_in_memory_only(self):
        with calculator() as fixture,tempfile.TemporaryDirectory() as directory:
            root=Path(directory);config,definition=setup(fixture)
            for name,value in [('config.json',config),('workflow.json',definition),('samples.json',[{'quantity':3},{'quantity':8}])]:
                (root/name).write_text(json.dumps(value))
            env={**os.environ,'PYTHONPATH':str(Path(__file__).resolve().parents[1]),'PYTHONDONTWRITEBYTECODE':'1'}
            command=[sys.executable,'-m','apk_inventory.mobile_ui','--config',str(root/'config.json'),'--operation','workflow-learn','--workflow',str(root/'workflow.json'),'--samples',str(root/'samples.json'),'--output',str(root/'learn')]
            child=subprocess.run(command,capture_output=True,text=True,env=env,timeout=20)
            self.assertEqual(child.returncode,0,child.stderr);summary=json.loads(child.stdout);self.assertTrue(summary['ok'],child.stdout)
            recipes=json.loads((root/'learn/recipes.json').read_text());recipe=recipes[summary['capabilityId']]
            (root/'recipe.json').write_text(json.dumps(recipe))
            command=[sys.executable,'-m','apk_inventory.mobile_ui','--config',str(root/'config.json'),'--operation','execute','--recipe',str(root/'recipe.json'),'--revision',recipe['revision'],'--output',str(root/'execute')]
            child=subprocess.run(command,input=json.dumps({'inputs':{'quantity':12}}),capture_output=True,text=True,env=env,timeout=20)
            self.assertEqual(child.returncode,0,child.stderr);result=json.loads(child.stdout);self.assertTrue(result['ok'],child.stdout);self.assertEqual(result['outputs'],{'total':144},child.stdout)
            self.assertEqual(fixture['apiInputs'],[3,8,12]);self.assertTrue((root/'learn/manifest.json').exists())

    def test_changed_waits_for_delayed_new_result_instead_of_accepting_old_valid_format(self):
        with calculator('ios') as fixture,tempfile.TemporaryDirectory() as directory:
            fixture['delayMs']=140;config,definition=setup(fixture,'ios');definition['steps'][2]['expect']['changed']=True
            session=MobileSession(config,Path(directory,'learn'));learn_workflow(session,definition,[{'quantity':2},{'quantity':7}])
            recipe=next(iter(session.progress['recipes'].values()));executor=MobileSession(config,Path(directory,'execute'))
            result=executor.execute(recipe,recipe['revision'],{'quantity':11})
            self.assertEqual(result['outputs'],{'total':121});self.assertEqual(fixture['apiInputs'],[2,7,11]);self.assertGreaterEqual(fixture['pendingReads'],6)
            self.assertEqual(result['resultFreshness']['outputs']['total'],{'changedSinceStart':True,'inputCorrelated':False})
            capability=next(iter(session.progress['capabilities'].values()))
            self.assertEqual(capability['evidence']['resultFreshness']['changedAssertions'],1)
            self.assertEqual(result['resultFreshness']['inputCorrelatedAssertions'],0)

    def test_unchanged_valid_format_times_out_without_publishing_or_retrying_click(self):
        with calculator() as fixture,tempfile.TemporaryDirectory() as directory:
            fixture['total']=9;fixture['neverUpdate']=True;config,definition=setup(fixture);definition['steps'][2].update(expect={'matches':'^TOTAL:[0-9]+$','changed':True},timeoutMs=120)
            session=MobileSession(config,directory)
            with self.assertRaises(MobileError) as caught:learn_workflow(session,definition,[{'quantity':2},{'quantity':7}])
            self.assertEqual(caught.exception.code,'WORKFLOW_FRESHNESS_NOT_OBSERVED');self.assertFalse(session.progress['recipes']);self.assertEqual(fixture['apiInputs'],[2])

    def test_same_value_repeat_is_not_called_fresh_when_only_changed_is_requested(self):
        with calculator() as fixture,tempfile.TemporaryDirectory() as directory:
            config,definition=setup(fixture);definition['steps'][2].update(expect={'changed':True},timeoutMs=120)
            session=MobileSession(config,Path(directory,'learn'));learn_workflow(session,definition,[{'quantity':2},{'quantity':7}]);recipe=next(iter(session.progress['recipes'].values()))
            executor=MobileSession(config,Path(directory,'execute'))
            with self.assertRaises(MobileError) as caught:executor.execute(recipe,recipe['revision'],{'quantity':7})
            self.assertEqual(caught.exception.code,'WORKFLOW_FRESHNESS_NOT_OBSERVED');self.assertEqual(fixture['apiInputs'],[2,7,7])

    def test_input_correlation_waits_for_current_input_and_reports_association_not_change(self):
        for predicate,prefix in [('containsInput','QUERY:'),('equalsInput','')]:
            with self.subTest(predicate=predicate),calculator() as fixture,tempfile.TemporaryDirectory() as directory:
                fixture['delayMs']=90;fixture['echoPrefix']=prefix;config,definition=setup(fixture);definition['steps'][2]['expect']={predicate:'quantity'}
                definition['steps'][3]={'kind':'extract','selector':definition['steps'][3]['selector'],'output':'echo','valueType':'string'}
                session=MobileSession(config,Path(directory,'learn'));learn_workflow(session,definition,[{'quantity':2},{'quantity':7}]);recipe=next(iter(session.progress['recipes'].values()))
                executor=MobileSession(config,Path(directory,'execute'));result=executor.execute(recipe,recipe['revision'],{'quantity':11})
                self.assertEqual(result['outputs'],{'echo':prefix+'11'});self.assertGreaterEqual(fixture['pendingReads'],3)
                self.assertEqual(result['resultFreshness']['outputs']['echo'],{'changedSinceStart':False,'inputCorrelated':True})
                self.assertEqual(result['resultFreshness']['changedAssertions'],0)

    def test_baseline_precedes_input_handlers_and_supports_result_first_appearance(self):
        for mode in ('input_handler','appearing_result'):
            with self.subTest(mode=mode),calculator() as fixture,tempfile.TemporaryDirectory() as directory:
                config,definition=setup(fixture);definition['steps'][2]['expect']['changed']=True
                if mode=='input_handler':fixture['computeOnInput']=True;del definition['steps'][1]
                else:fixture['hideUntilResult']=True
                session=MobileSession(config,directory);learn_workflow(session,definition,[{'quantity':2},{'quantity':7}])
                recipe=next(iter(session.progress['recipes'].values()));executor=MobileSession(config,Path(directory,'execute'));result=executor.execute(recipe,recipe['revision'],{'quantity':11})
                self.assertEqual(result['outputs'],{'total':121});self.assertEqual(fixture['apiInputs'],[2,7,11])

    def test_cancellation_during_pending_poll_stops_without_extra_protocol_requests_or_clicks(self):
        with calculator() as fixture,tempfile.TemporaryDirectory() as directory:
            config,definition=setup(fixture);definition['steps'][2]['expect']['changed']=True
            session=MobileSession(config,Path(directory,'learn'));learn_workflow(session,definition,[{'quantity':2},{'quantity':7}]);recipe=next(iter(session.progress['recipes'].values()))
            fixture['neverUpdate']=True;fixture['pendingReads']=0;executor=MobileSession(config,Path(directory,'execute'))
            fixture['onPendingRead']=lambda count:setattr(executor.budget,'cancelled',True) if count>=2 else None
            with self.assertRaises(MobileError) as caught:executor.execute(recipe,recipe['revision'],{'quantity':11})
            self.assertEqual(caught.exception.code,'STOPPED');self.assertEqual(fixture['apiInputs'],[2,7,11]);self.assertGreaterEqual(fixture['pendingReads'],2)
            count=len(fixture['calls']);time.sleep(.1);self.assertEqual(len(fixture['calls']),count)

    def test_guarded_result_cannot_revert_between_assertion_and_extraction(self):
        with calculator() as fixture,tempfile.TemporaryDirectory() as directory:
            config,definition=setup(fixture);definition['steps'][2]['expect']['changed']=True
            session=MobileSession(config,Path(directory,'learn'));learn_workflow(session,definition,[{'quantity':2},{'quantity':7}]);recipe=next(iter(session.progress['recipes'].values()))
            observed=[]
            def revert(text):
                if text=='TOTAL:121':
                    observed.append(text)
                    if len(observed)==2:fixture['total']=49
            fixture['onSource']=revert;executor=MobileSession(config,Path(directory,'execute'))
            with self.assertRaises(MobileError) as caught:executor.execute(recipe,recipe['revision'],{'quantity':11})
            self.assertEqual(caught.exception.code,'WORKFLOW_RESULT_CHANGED_AFTER_ASSERTION');self.assertEqual(fixture['apiInputs'],[2,7,11])

    def test_freshness_contract_rejects_invalid_predicates_before_protocol_and_legacy_does_not_claim_freshness(self):
        with calculator() as fixture,tempfile.TemporaryDirectory() as directory:
            config,definition=setup(fixture)
            for expect in ({'changed':False},{'containsInput':'missing'},{'equalsInput':1},{'matches':'^TOTAL:[0-9]+$','equals':'TOTAL:4'}):
                with self.subTest(expect=expect):
                    definition['steps'][2]['expect']=expect
                    with self.assertRaises(MobileError):learn_workflow(MobileSession(config,Path(directory,str(len(fixture['calls'])))),definition,[{'quantity':2},{'quantity':7}])
            self.assertEqual(fixture['calls'],[])
            definition['steps'][2]['expect']={'matches':'^TOTAL:[0-9]+$'};session=MobileSession(config,Path(directory,'legacy'));learn_workflow(session,definition,[{'quantity':2},{'quantity':7}]);recipe=next(iter(session.progress['recipes'].values()))
            result=MobileSession(config,Path(directory,'legacy-call')).execute(recipe,recipe['revision'],{'quantity':11})
            self.assertEqual(result['outputs'],{'total':121});self.assertEqual(result['resultFreshness']['outputs']['total'],{'changedSinceStart':False,'inputCorrelated':False})



class ObservationCoalescingTests(unittest.TestCase):
    def test_protocol_observation_count_drops_without_skipping_live_action_or_result_guards(self):
        with calculator() as fixture,tempfile.TemporaryDirectory() as directory:
            config,definition=setup(fixture);session=MobileSession(config,Path(directory,'learn'))
            learn_workflow(session,definition,[{'quantity':2},{'quantity':7}]);recipe=next(iter(session.progress['recipes'].values()))
            # WebDriver probe reads source once; each sample reads four distinct
            # phases: before type, before click, assertion, extraction. Baseline
            # did two additional post-action reads which were discarded.
            self.assertEqual(fixture['sourceReads'],9)
            before=fixture['sourceReads'];executor=MobileSession(config,Path(directory,'execute'));result=executor.execute(recipe,recipe['revision'],{'quantity':11})
            self.assertEqual(fixture['sourceReads']-before,5);self.assertEqual(result['outputs'],{'total':121});self.assertEqual(fixture['apiInputs'],[2,7,11])
            events=[json.loads(line) for line in Path(directory,'execute/events.jsonl').read_text().splitlines()]
            finished=[row for row in events if row['kind']=='workflow_action_finished'];self.assertEqual(len(finished),2);self.assertTrue(all(row['status']=='command_completed' for row in finished))

    def test_guarded_outputs_keep_separate_extraction_and_post_extraction_recheck(self):
        with calculator() as fixture,tempfile.TemporaryDirectory() as directory:
            config,definition=setup(fixture);definition['steps'][2]['expect']['changed']=True
            session=MobileSession(config,Path(directory,'learn'));learn_workflow(session,definition,[{'quantity':2},{'quantity':7}]);recipe=next(iter(session.progress['recipes'].values()))
            before=fixture['sourceReads'];result=MobileSession(config,Path(directory,'execute')).execute(recipe,recipe['revision'],{'quantity':11})
            self.assertEqual(fixture['sourceReads']-before,7);self.assertEqual(result['outputs'],{'total':121})
            events=[json.loads(line) for line in Path(directory,'execute/events.jsonl').read_text().splitlines()]
            self.assertTrue(any(row['kind']=='workflow_outputs_reverified' for row in events))


class RecordedPrefixWorkflowTests(unittest.TestCase):
    def test_real_exploration_prefix_restores_query_form_for_each_sample_and_execution(self):
        with calculator() as fixture,tempfile.TemporaryDirectory() as directory:
            fixture.update(prefixMode=True,page='root');config,definition=setup(fixture);config['limits']['maxDepth']=1
            explorer=MobileSession(config,Path(directory,'explore'));explored=explorer.explore();self.assertTrue(explored['ok'])
            state=next(state for state in explorer.progress['states'].values() if state['path']);self.assertIn('workflowInventory',state)
            definition['entryPrefix']={'entryStateId':explorer.progress['entry'],'targetStateId':state['fingerprint'],'steps':state['path']}
            session=MobileSession(config,Path(directory,'learn'));learn_workflow(session,definition,[{'quantity':2},{'quantity':7}]);recipe=next(iter(session.progress['recipes'].values()))
            result=MobileSession(config,Path(directory,'execute')).execute(recipe,recipe['revision'],{'quantity':11})
            self.assertEqual(result['outputs'],{'total':121});self.assertEqual(fixture['apiInputs'],[2,7,11])
            events=[json.loads(line) for line in Path(directory,'execute/events.jsonl').read_text().splitlines()]
            self.assertTrue(any(row['kind']=='workflow_prefix_verified' for row in events));self.assertEqual(fixture['page'],'form')
            fixture['openLabel']='Delete account';before=list(fixture['apiInputs'])
            with self.assertRaises(MobileError):MobileSession(config,Path(directory,'drift')).execute(recipe,recipe['revision'],{'quantity':12})
            self.assertEqual(fixture['apiInputs'],before)

    def test_prefix_must_be_connected_and_only_preapproved_read_actions(self):
        with calculator() as fixture,tempfile.TemporaryDirectory() as directory:
            config,definition=setup(fixture)
            base={'entryStateId':'a'*64,'targetStateId':'b'*64,'steps':[{'before':'a'*64,'after':'b'*64,'action':{'kind':'type','selector':{'resourceId':APP+':id/quantity'}}}]}
            definition['entryPrefix']=base
            with self.assertRaises(MobileError) as caught:learn_workflow(MobileSession(config,Path(directory,'type')),definition,[{'quantity':2},{'quantity':7}])
            self.assertEqual(caught.exception.code,'WORKFLOW_PREFIX_ACTION_INVALID');self.assertEqual(fixture['calls'],[])
            definition['entryPrefix']['steps'][0]['action']={'kind':'click','selector':{'resourceId':APP+':id/calculate'}};definition['entryPrefix']['steps'][0]['before']='c'*64
            with self.assertRaises(MobileError) as caught:learn_workflow(MobileSession(config,Path(directory,'disconnected')),definition,[{'quantity':2},{'quantity':7}])
            self.assertEqual(caught.exception.code,'WORKFLOW_PREFIX_DISCONNECTED');self.assertEqual(fixture['calls'],[])


class InputMetadataContractTests(unittest.TestCase):
    def test_input_type_or_readonly_drift_fails_before_value_commands(self):
        with calculator() as fixture,tempfile.TemporaryDirectory() as directory:
            config,definition=setup(fixture);session=MobileSession(config,Path(directory,'learn'));learn_workflow(session,definition,[{'quantity':2},{'quantity':7}]);recipe=next(iter(session.progress['recipes'].values()))
            for field,value in [('inputType','number'),('readOnly',True)]:
                with self.subTest(field=field):
                    fixture['inputType']='';fixture['readOnly']=False;fixture[field]=value
                    before=list(fixture['apiInputs']);clears=fixture['clearCount']
                    with self.assertRaises(MobileError) as caught:MobileSession(config,Path(directory,field)).execute(recipe,recipe['revision'],{'quantity':11})
                    self.assertEqual(caught.exception.code,'WORKFLOW_CONTROL_CONTRACT_CHANGED');self.assertEqual(fixture['apiInputs'],before);self.assertEqual(fixture['clearCount'],clears)


@contextmanager
def notes_app(platform='ios'):
    with tempfile.TemporaryDirectory() as store_dir:
        state={'body':'','result':'EMPTY','calls':[],'uiCommands':[],'suppressResult':False,'commandErrorAfterWrite':False,'duplicate':False}
        path=Path(store_dir,'notes.json');path.write_text('[]');state['store']=path
        def xml():
            if platform=='android':
                field=f'<node package="{APP}" resource-id="{APP}:id/body" class="android.widget.EditText" text="{state["body"]}" bounds="[0,0][100,40]"/>'
                return '<hierarchy>'+field*(2 if state['duplicate'] else 1)+f'<node package="{APP}" resource-id="{APP}:id/save" class="android.widget.Button" text="Save note" clickable="true" bounds="[0,50][100,90]"/><node package="{APP}" resource-id="{APP}:id/result" class="android.widget.TextView" text="{state["result"]}" bounds="[0,100][100,140]"/></hierarchy>'
            field=f'<XCUIElementTypeTextField type="XCUIElementTypeTextField" name="body" label="Body" value="{state["body"]}" x="0" y="0" width="100" height="40"/>'
            return '<AppiumAUT>'+field*(2 if state['duplicate'] else 1)+f'<XCUIElementTypeButton type="XCUIElementTypeButton" name="save" label="Save note" x="0" y="50" width="100" height="40"/><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="result" label="{state["result"]}" x="0" y="100" width="100" height="40"/></AppiumAUT>'
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*_):pass
            def reply(self,value,status=200):
                raw=json.dumps({'value':value}).encode();self.send_response(status);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
            def do_GET(self):self.handle_command()
            def do_POST(self):self.handle_command()
            def handle_command(self):
                size=int(self.headers.get('Content-Length',0));body=json.loads(self.rfile.read(size)) if size else {}
                state['calls'].append((self.path,body))
                if self.path=='/notes':
                    notes=json.loads(path.read_text());notes.append({'id':len(notes)+1,'body':body['body']});path.write_text(json.dumps(notes));return self.reply(notes[-1])
                route=self.path.removeprefix('/session/workflow-session')
                if route=='/source':return self.reply(xml())
                if route=='/execute/sync':return self.reply({'bundleId':APP})
                if route=='/appium/device/current_package':return self.reply(APP)
                if route=='/elements':
                    name='body' if 'body' in body['value'] else 'save'
                    return self.reply([{'element-6066-11e4-a52e-4f735466cecf':name}])
                if route=='/element/body/clear':state['uiCommands'].append('clear');state['body']='';return self.reply(None)
                if route=='/element/body/value':state['uiCommands'].append('value');state['body']+=body['text'];return self.reply(None)
                if route=='/element/save/click':
                    state['uiCommands'].append('save')
                    with urlopen(Request(state['url']+'/notes',data=json.dumps({'body':state['body']}).encode(),headers={'Content-Type':'application/json'},method='POST'),timeout=3) as response:record=json.load(response)['value']
                    if not state['suppressResult']:state['result']='SAVED:'+record['body']+'#'+str(record['id'])
                    return self.reply({'error':'response_lost_after_write'},500) if state['commandErrorAfterWrite'] else self.reply(None)
                return self.reply({'error':'unsupported'},404)
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);state['url']='http://127.0.0.1:'+str(server.server_port)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:yield state
        finally:server.shutdown();server.server_close();thread.join(2)


def notes_definition(fixture,platform='ios'):
    identify=lambda name:{'accessibilityId':name} if platform=='ios' else {'resourceId':APP+':id/'+name}
    cfg={'source':{'id':'write_fixture','kind':'ios' if platform=='ios' else 'apk'},'backend':{'type':'webdriver','platform':platform,'url':fixture['url'],'sessionId':'workflow-session','appId':APP},'limits':{'maxActions':30,'maxDurationMs':10000},'actionAllowlist':[{'kind':'type','selector':identify('body'),'effect':'read'},{'kind':'click','selector':identify('save'),'effect':'write'}],'workflowPermissions':{'allowWrite':['save_note'],'allowWriteLearning':['save_note']}}
    definition={'schemaVersion':1,'id':'save_note','name':'Save note','effect':'write','inputSchema':{'type':'object','properties':{'body':{'type':'string','minLength':1,'maxLength':40}},'required':['body'],'additionalProperties':False},'steps':[{'kind':'type','selector':identify('body'),'input':'body','replace':True},{'kind':'click','selector':identify('save')},{'kind':'assert','selector':identify('result'),'expect':{'containsInput':'body','changed':True},'timeoutMs':120},{'kind':'extract','selector':identify('result'),'output':'result','valueType':'string'}]}
    return cfg,definition


class NativeWriteWorkflowTests(unittest.TestCase):
    def test_authorized_android_and_ios_write_learning_then_execution_only_requires_write_permission(self):
        for platform in ['android','ios']:
            with self.subTest(platform=platform),notes_app(platform) as fixture,tempfile.TemporaryDirectory() as out:
                cfg,definition=notes_definition(fixture,platform);learner=MobileSession(cfg,Path(out,'learn'));learned=learn_workflow(learner,definition,[{'body':'alpha'},{'body':'beta'}]);recipe=next(iter(learner.progress['recipes'].values()))
                self.assertEqual(learned['writeOutcome'],{'status':'observed','automaticRetry':False});self.assertEqual(next(iter(learner.progress['capabilities'].values()))['effect'],'write')
                execution_config=copy.deepcopy(cfg);execution_config['workflowPermissions']={'allowWrite':['save_note']};executor=MobileSession(execution_config,Path(out,'execute'));self.assertEqual(executor.identity,learner.identity)
                result=executor.execute(recipe,recipe['revision'],{'body':'gamma'});self.assertEqual(result['outputs']['result'],'SAVED:gamma#3');self.assertEqual(result['writeOutcome']['status'],'observed')
                self.assertEqual([record['body'] for record in json.loads(fixture['store'].read_text())],['alpha','beta','gamma'])
                self.assertEqual(json.loads(Path(out,'execute/write-intent.json').read_text()),{'effect':'write','status':'unknown','automaticRetry':False})
                self.assertFalse(result['networkObserved'])

    def test_missing_invalid_and_forged_permissions_fail_before_any_backend_request(self):
        with notes_app() as fixture,tempfile.TemporaryDirectory() as out:
            cfg,definition=notes_definition(fixture)
            cases=[({},'WORKFLOW_WRITE_NOT_APPROVED'),({'allowWrite':['save_note']},'WORKFLOW_WRITE_LEARNING_NOT_APPROVED'),({'allowWrite':['other'],'allowWriteLearning':['other']},'WORKFLOW_WRITE_NOT_APPROVED'),({'allowWrite':['save_*']},'WORKFLOW_PERMISSIONS_INVALID'),({'allowWrite':['save_note'],'allowWriteLearning':['other']},'WORKFLOW_PERMISSIONS_INVALID'),({'allowWrite':['save_note'],'allowWriteLearning':['save_note'],'allowAll':True},'WORKFLOW_PERMISSIONS_INVALID')]
            for index,(permissions,code) in enumerate(cases):
                current=copy.deepcopy(cfg);current['workflowPermissions']=permissions;session=MobileSession(current,Path(out,str(index)))
                with self.assertRaises(MobileError) as caught:learn_workflow(session,definition,[{'body':'alpha'},{'body':'beta'}])
                self.assertEqual(caught.exception.code,code);self.assertEqual(caught.exception.writeOutcome['status'],'not_started');self.assertEqual(fixture['calls'],[])
            forged=copy.deepcopy(definition);forged['workflowPermissions']=cfg['workflowPermissions'];cfg['workflowPermissions']={}
            with self.assertRaises(MobileError) as caught:learn_workflow(MobileSession(cfg,Path(out,'forged')),forged,[{'body':'alpha'},{'body':'beta'}])
            self.assertEqual(caught.exception.code,'WORKFLOW_DEFINITION_INVALID');self.assertEqual(fixture['calls'],[])

    def test_unknown_actions_read_disguise_bad_input_and_write_prefix_never_mutate(self):
        with notes_app() as fixture,tempfile.TemporaryDirectory() as out:
            cfg,definition=notes_definition(fixture)
            for label,modified,inputs in [('unknown',definition,[{'body':'alpha'},{'body':'beta'}]),('read_disguise',{**definition,'effect':'read'},[{'body':'alpha'},{'body':'beta'}]),('bad_input',definition,[{'body':''},{'body':'beta'}])]:
                current=copy.deepcopy(cfg)
                if label=='unknown':current['actionAllowlist'][1]['effect']='unknown'
                session=MobileSession(current,Path(out,label))
                with self.assertRaises(MobileError):learn_workflow(session,modified,inputs)
                self.assertEqual(fixture['calls'],[]);self.assertEqual(fixture['uiCommands'],[])
            prefixed=copy.deepcopy(definition);prefixed['entryPrefix']={'entryStateId':'a'*64,'targetStateId':'b'*64,'steps':[{'before':'a'*64,'after':'b'*64,'action':{'kind':'click','selector':definition['steps'][1]['selector']}}]}
            with self.assertRaises(MobileError) as caught:learn_workflow(MobileSession(cfg,Path(out,'prefix')),prefixed,[{'body':'alpha'},{'body':'beta'}])
            self.assertEqual(caught.exception.code,'WORKFLOW_PREFIX_NOT_READ_APPROVED');self.assertEqual(fixture['calls'],[])

    def test_written_but_unconfirmed_or_transport_failure_reports_unknown_without_retry(self):
        for failure in ['assertion','command']:
            with self.subTest(failure=failure),notes_app() as fixture,tempfile.TemporaryDirectory() as out:
                cfg,definition=notes_definition(fixture);learner=MobileSession(cfg,Path(out,'learn'));learn_workflow(learner,definition,[{'body':'alpha'},{'body':'beta'}]);recipe=next(iter(learner.progress['recipes'].values()))
                fixture['suppressResult']=failure=='assertion';fixture['commandErrorAfterWrite']=failure=='command';session=MobileSession(cfg,Path(out,'execute'))
                with self.assertRaises(MobileError) as caught:session.execute(recipe,recipe['revision'],{'body':'delta'})
                self.assertEqual(caught.exception.writeOutcome,{'status':'unknown','automaticRetry':False});self.assertEqual(json.loads(fixture['store'].read_text())[-1]['body'],'delta');self.assertEqual(len(json.loads(fixture['store'].read_text())),3);self.assertEqual(fixture['uiCommands'].count('save'),3)
                self.assertEqual(json.loads(Path(out,'execute/checkpoint.json').read_text())['writeOutcome']['status'],'unknown')

    def test_learning_failure_reports_unknown_and_permission_revocation_blocks_execution_before_probe(self):
        with notes_app() as fixture,tempfile.TemporaryDirectory() as out:
            cfg,definition=notes_definition(fixture);failed=copy.deepcopy(definition);failed['steps'][2]['expect']={'equals':'NEVER'};failed['steps'][2]['timeoutMs']=0;session=MobileSession(cfg,Path(out,'bad-learn'))
            with self.assertRaises(MobileError) as caught:learn_workflow(session,failed,[{'body':'alpha'},{'body':'beta'}])
            self.assertEqual(caught.exception.writeOutcome['status'],'unknown');self.assertEqual(len(json.loads(fixture['store'].read_text())),1);self.assertFalse(session.progress['recipes'])
            learner=MobileSession(cfg,Path(out,'learn'));learn_workflow(learner,definition,[{'body':'one'},{'body':'two'}]);recipe=next(iter(learner.progress['recipes'].values()));revoked=copy.deepcopy(cfg);revoked['workflowPermissions']={};before=len(fixture['calls'])
            with self.assertRaises(MobileError) as caught:MobileSession(revoked,Path(out,'revoked')).execute(recipe,recipe['revision'],{'body':'forbidden'})
            self.assertEqual(caught.exception.code,'WORKFLOW_WRITE_NOT_APPROVED');self.assertEqual(caught.exception.writeOutcome['status'],'not_started');self.assertEqual(len(fixture['calls']),before)

    def test_precommand_control_or_intent_persistence_failure_is_not_started(self):
        for failure in ['ambiguous','intent']:
            with self.subTest(failure=failure),notes_app() as fixture,tempfile.TemporaryDirectory() as out:
                cfg,definition=notes_definition(fixture);output=Path(out,'learn');output.mkdir()
                if failure=='ambiguous':fixture['duplicate']=True
                else:(output/'write-intent.json').symlink_to(Path(out,'outside.json'))
                session=MobileSession(cfg,output)
                with self.assertRaises(MobileError) as caught:learn_workflow(session,definition,[{'body':'alpha'},{'body':'beta'}])
                self.assertEqual(caught.exception.writeOutcome['status'],'not_started');self.assertEqual(fixture['uiCommands'],[]);self.assertEqual(json.loads(fixture['store'].read_text()),[])

@contextmanager
def boolean_app(platform='android',control_kind='checkbox'):
    state={'checked':False,'taps':0,'requests':[],'readonly':False,'missing':False,'duplicate':False,'indeterminate':False,'freeze':False,'disconnect':False,'result':'false'}
    def source():
        raw='mixed' if state['indeterminate'] else '' if state['missing'] else str(state['checked']).lower() if platform=='android' else '1' if state['checked'] else '0'
        if platform=='android':
            cls={'checkbox':'android.widget.CheckBox','switch':'android.widget.Switch','radio':'android.widget.RadioButton'}[control_kind]
            control=f'<node package="{APP}" resource-id="{APP}:id/flag" class="{cls}" checkable="true" checked="{raw}" readonly="{str(state["readonly"]).lower()}" clickable="true" text="Switch label" bounds="[0,0][100,40]"/>'
            return '<hierarchy>'+control*(2 if state['duplicate'] else 1)+f'<node package="{APP}" resource-id="{APP}:id/result" class="android.widget.TextView" text="{state["result"]}" bounds="[0,40][100,80]"/></hierarchy>'
        control=f'<XCUIElementTypeSwitch type="XCUIElementTypeSwitch" name="flag" value="{raw}" readonly="{str(state["readonly"]).lower()}" label="Switch label" x="0" y="0" width="100" height="40"/>'
        return '<AppiumAUT>'+control*(2 if state['duplicate'] else 1)+f'<XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="result" label="{state["result"]}" x="0" y="40" width="100" height="40"/></AppiumAUT>'
    state['source']=source
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*_):pass
        def do_GET(self):self.command_body()
        def do_POST(self):self.command_body()
        def command_body(self):
            raw=self.rfile.read(int(self.headers.get('Content-Length',0)));body=json.loads(raw) if raw else {};route=self.path.removeprefix('/session/boolean')
            state['requests'].append((self.command,route))
            if route=='/source':value=source()
            elif route=='/appium/device/current_package':value=APP
            elif route=='/execute/sync':value={'bundleId':APP}
            elif route=='/elements':value=[{'element-6066-11e4-a52e-4f735466cecf':'flag'}]
            elif route=='/element/flag/click':
                state['taps']+=1
                if not state['freeze']:state['checked']=True if control_kind=='radio' else not state['checked'];state['result']=str(state['checked']).lower()
                if state['disconnect']:
                    self.connection.shutdown(2);self.connection.close();return
                value=None
            else:self.send_error(404);return
            if state.get('onRequest'):state['onRequest'](route)
            raw=json.dumps({'value':value}).encode();self.send_response(200);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);state['url']='http://127.0.0.1:'+str(server.server_port);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:yield state
    finally:server.shutdown();server.server_close();thread.join(2)


def boolean_definition(fixture,platform='android',effect='read'):
    identify=lambda name:{'resourceId':APP+':id/'+name} if platform=='android' else {'accessibilityId':name}
    cfg={'source':{'id':'boolean_fixture','kind':'apk' if platform=='android' else 'ios'},'backend':{'type':'webdriver','platform':platform,'url':fixture['url'],'sessionId':'boolean','appId':APP},'limits':{'maxActions':10,'maxDurationMs':10000},'actionAllowlist':[{'kind':'check','selector':identify('flag'),'effect':effect}],'workflowPermissions':{'allowWrite':['set_flag'],'allowWriteLearning':['set_flag']}}
    spec={'schemaVersion':1,'id':'set_flag','effect':effect,'inputSchema':{'type':'object','properties':{'flag':{'type':'boolean'}},'required':['flag'],'additionalProperties':False},'steps':[{'kind':'check','selector':identify('flag'),'input':'flag','timeoutMs':60},{'kind':'assert','selector':identify('result'),'expect':{'equalsInput':'flag'}},{'kind':'extract','selector':identify('result'),'output':'flag','valueType':'boolean'}]}
    return cfg,spec


class BooleanWorkflowTests(unittest.TestCase):
    def test_w3c_android_checkbox_switch_and_ios_switch_bind_real_boolean_and_noop_does_not_tap(self):
        for platform,kind in [('android','checkbox'),('android','switch'),('ios','switch')]:
            with self.subTest(platform=platform,kind=kind),boolean_app(platform,kind) as app,tempfile.TemporaryDirectory() as out:
                cfg,spec=boolean_definition(app,platform);learner=MobileSession(cfg,Path(out,'learn'));learn_workflow(learner,spec,[{'flag':True},{'flag':False}]);recipe=next(iter(learner.progress['recipes'].values()))
                self.assertEqual(app['taps'],2)
                executor=MobileSession(cfg,Path(out,'third'));result=executor.execute(recipe,recipe['revision'],{'flag':True});self.assertEqual(result['outputs'],{'flag':True});self.assertEqual(result['checkStateVerifications'],{'changed':1,'noOp':0});self.assertTrue(result['executionObserved']);self.assertEqual(app['taps'],3)
                repeated=MobileSession(cfg,Path(out,'same'));result=repeated.execute(recipe,recipe['revision'],{'flag':True});self.assertEqual(app['taps'],3);self.assertEqual(repeated.budget.count,0);self.assertFalse(result['executionObserved']);self.assertEqual(result['actionsPerformed'],0);self.assertEqual(result['checkStateVerifications'],{'changed':0,'noOp':1})
                events=[json.loads(line) for line in Path(out,'same/events.jsonl').read_text().splitlines()];self.assertTrue(any(event['kind']=='workflow_check_state_verified' and event['commandPerformed'] is False for event in events));self.assertFalse(any(event['kind']=='workflow_action_started' for event in events))
                self.assertNotIn('checked',recipe['controlContracts'][0]);self.assertEqual(next(iter(learner.progress['capabilities'].values()))['effect'],'read')

    def test_bad_boolean_binding_or_policy_is_rejected_before_backend_io(self):
        for defect in ['string','value_string','both','missing','nonboolschema','click_only','unknown_policy','implicit_policy','write_disguised','learning_revoked','timeout']:
            with self.subTest(defect=defect),boolean_app() as app,tempfile.TemporaryDirectory() as out:
                cfg,spec=boolean_definition(app);samples=[{'flag':True},{'flag':False}]
                if defect=='string':samples[0]['flag']='true'
                elif defect=='value_string':spec['steps'][0].pop('input');spec['steps'][0]['value']='true'
                elif defect=='both':spec['steps'][0]['value']=True
                elif defect=='missing':spec['steps'][0].pop('input')
                elif defect=='nonboolschema':spec['inputSchema']['properties']['flag']={'type':'string'}
                elif defect=='click_only':cfg['actionAllowlist'][0]['kind']='click'
                elif defect=='unknown_policy':cfg['actionAllowlist'][0]['effect']='unknown'
                elif defect=='implicit_policy':cfg['actionAllowlist'][0].pop('effect')
                elif defect=='write_disguised':cfg['actionAllowlist'][0]['effect']='write'
                elif defect=='learning_revoked':cfg['actionAllowlist'][0]['effect']='write';spec['effect']='write';cfg['workflowPermissions']={'allowWrite':['set_flag']}
                else:spec['steps'][0]['timeoutMs']=True
                with self.assertRaises(MobileError):learn_workflow(MobileSession(cfg,out),spec,samples)
                self.assertEqual(app['taps'],0);self.assertEqual(app['requests'],[])

    def test_readonly_missing_indeterminate_ambiguous_and_radio_false_reject_before_tap(self):
        for defect in ['readonly','missing','indeterminate','duplicate','radio_false']:
            with self.subTest(defect=defect),boolean_app(control_kind='radio' if defect=='radio_false' else 'checkbox') as app,tempfile.TemporaryDirectory() as out:
                cfg,spec=boolean_definition(app)
                if defect=='radio_false':samples=[{'flag':False},{'flag':True}]
                else:app[defect]=True;samples=[{'flag':True},{'flag':False}]
                with self.assertRaises(MobileError):learn_workflow(MobileSession(cfg,out),spec,samples)
                self.assertEqual(app['taps'],0)

    def test_write_check_disconnect_after_tap_reports_unknown_once_and_noop_has_no_intent(self):
        with boolean_app() as app,tempfile.TemporaryDirectory() as out:
            cfg,spec=boolean_definition(app,effect='write');learner=MobileSession(cfg,Path(out,'learn'));learn_workflow(learner,spec,[{'flag':True},{'flag':False}]);recipe=next(iter(learner.progress['recipes'].values()))
            app['disconnect']=True
            with self.assertRaises(MobileError) as caught:MobileSession(cfg,Path(out,'lost')).execute(recipe,recipe['revision'],{'flag':True})
            self.assertEqual(caught.exception.writeOutcome,{'status':'unknown','automaticRetry':False});self.assertEqual(app['taps'],3);self.assertTrue(Path(out,'lost/write-intent.json').is_file())
            app['disconnect']=False;no_op=MobileSession(cfg,Path(out,'noop'));result=no_op.execute(recipe,recipe['revision'],{'flag':True});self.assertFalse(result['executionObserved']);self.assertEqual(app['taps'],3);self.assertFalse(Path(out,'noop/write-intent.json').exists())
            revoked=copy.deepcopy(cfg);revoked['workflowPermissions']={};before=len(app['requests'])
            with self.assertRaises(MobileError) as caught:MobileSession(revoked,Path(out,'revoked')).execute(recipe,recipe['revision'],{'flag':False})
            self.assertEqual(caught.exception.code,'WORKFLOW_WRITE_NOT_APPROVED');self.assertEqual(len(app['requests']),before);self.assertEqual(app['taps'],3)

    def test_failed_state_confirmation_never_taps_twice_and_cancel_stops_reads(self):
        for failure in ['freeze','cancel']:
            with self.subTest(failure=failure),boolean_app() as app,tempfile.TemporaryDirectory() as out:
                cfg,spec=boolean_definition(app,effect='write');session=MobileSession(cfg,out);app['freeze']=True
                if failure=='cancel':app['onRequest']=lambda route:setattr(session.budget,'cancelled',True) if app['taps'] else None
                with self.assertRaises(MobileError) as caught:learn_workflow(session,spec,[{'flag':True},{'flag':False}])
                self.assertEqual(app['taps'],1);self.assertEqual(caught.exception.writeOutcome['status'],'unknown');self.assertFalse(session.progress['recipes'])
                if failure=='cancel':self.assertEqual(caught.exception.code,'STOPPED');self.assertEqual(app['requests'][-1][1],'/element/flag/click')

    def test_literal_boolean_check_and_radio_true_use_state_contract(self):
        from apk_inventory.mobile_ui import check_value
        for kind in ['checkbox','radio']:
            with self.subTest(kind=kind),boolean_app(control_kind=kind) as app,tempfile.TemporaryDirectory() as out:
                cfg,spec=boolean_definition(app);session=MobileSession(cfg,out);tree=session.backend.observe();node=next(node for node in tree['nodes'] if node['checkKind']);action={'kind':'check','selector':spec['steps'][0]['selector'],'value':True}
                self.assertIs(check_value(action,node,{}),True);self.assertTrue(session.backend.perform(action,tree,{})['commandPerformed']);self.assertEqual(app['taps'],1)
                self.assertFalse(session.backend.perform(action,session.backend.observe(),{})['commandPerformed']);self.assertEqual(app['taps'],1)
                if kind=='checkbox':
                    spec['steps'].insert(0,action);learn_workflow(session,spec,[{'flag':True},{'flag':False}]);self.assertTrue(session.progress['recipes']);self.assertEqual(app['taps'],2)

@contextmanager
def radio_app(platform='android'):
    app={'selected':{'all'},'taps':[],'requests':[],'readonly':False,'unknown':False,'duplicate':False,'cross':False,'replace':False,'disconnect':False,'freeze':False}
    identify=lambda name:{'resourceId':APP+':id/'+name} if platform=='android' else {'accessibilityId':name}
    def source():
        def option(name):
            selected=name in app['selected'];old=name
            if app['replace'] and name=='closed':name='replacement'
            if platform=='android':return f'<node package="{APP}" resource-id="{APP}:id/{name}" class="android.widget.RadioButton" checkable="true" checked="{("mixed" if app["unknown"] else str(selected).lower())}" readonly="{str(app["readonly"]).lower()}" text="{old.title()}" clickable="true" bounds="[0,0][100,40]"/>'
            return f'<XCUIElementTypeButton type="XCUIElementTypeButton" name="{name}" selected="{("mixed" if app["unknown"] else str(selected).lower())}" value="{int(selected)}" readonly="{str(app["readonly"]).lower()}" label="{old.title()}" x="0" y="0" width="100" height="40"/>'
        members=''.join(option(name) for name in ['all','open','closed'] if not app['cross'] or name!='closed')+(option('all') if app['duplicate'] else '')
        text=next(iter(app['selected'])) if len(app['selected'])==1 else 'invalid'
        if platform=='android':return f'<hierarchy><node package="{APP}" resource-id="{APP}:id/group" class="android.widget.RadioGroup" bounds="[0,0][300,100]">{members}</node>'+((f'<node package="{APP}" resource-id="{APP}:id/other" class="android.widget.RadioGroup" bounds="[0,0][300,100]">'+option('closed')+'</node>') if app['cross'] else '')+f'<node package="{APP}" resource-id="{APP}:id/result" class="android.widget.TextView" text="{text}" bounds="[0,100][100,140]"/></hierarchy>'
        return f'<AppiumAUT><XCUIElementTypeSegmentedControl type="XCUIElementTypeSegmentedControl" name="group" x="0" y="0" width="300" height="40">{members}</XCUIElementTypeSegmentedControl>'+((f'<XCUIElementTypeSegmentedControl type="XCUIElementTypeSegmentedControl" name="other" x="0" y="0" width="300" height="40">'+option('closed')+'</XCUIElementTypeSegmentedControl>') if app['cross'] else '')+f'<XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="result" label="{text}" x="0" y="100" width="100" height="40"/></AppiumAUT>'
    app['source']=source
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*_):pass
        def do_GET(self):self.handle_command()
        def do_POST(self):self.handle_command()
        def handle_command(self):
            raw=self.rfile.read(int(self.headers.get('Content-Length',0)));body=json.loads(raw) if raw else {};route=self.path.removeprefix('/session/radio');app['requests'].append((self.command,route))
            if route=='/source':value=source()
            elif route=='/appium/device/current_package':value=APP
            elif route=='/execute/sync':value={'bundleId':APP}
            elif route=='/elements':
                name=next(name for name in ['all','open','closed'] if name in body['value']);value=[{'element-6066-11e4-a52e-4f735466cecf':name}]
            elif route.startswith('/element/') and route.endswith('/click'):
                name=route.split('/')[2];app['taps'].append(name)
                if not app['freeze']:app['selected']={name}
                if app.get('onTap'):app['onTap']()
                if app['disconnect']:self.connection.shutdown(2);self.connection.close();return
                value=None
            else:self.send_error(404);return
            raw=json.dumps({'value':value}).encode();self.send_response(200);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);app['url']='http://127.0.0.1:'+str(server.server_port);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:yield app
    finally:server.shutdown();server.server_close();thread.join(2)


def radio_definition(app,platform='android',effect='read'):
    identify=lambda name:{'resourceId':APP+':id/'+name} if platform=='android' else {'accessibilityId':name}
    cfg={'source':{'id':'radio_fixture','kind':'apk' if platform=='android' else 'ios'},'backend':{'type':'webdriver','platform':platform,'url':app['url'],'sessionId':'radio','appId':APP},'limits':{'maxActions':10,'maxDurationMs':10000},'workflowPermissions':{'allowWrite':['select_status'],'allowWriteLearning':['select_status']},'actionAllowlist':[{'kind':'select','selector':identify('group'),'effect':effect}]+[{'kind':'check','selector':identify(name),'effect':effect} for name in ['all','open','closed']]}
    definition={'schemaVersion':1,'id':'select_status','effect':effect,'inputSchema':{'type':'object','properties':{'status':{'type':'string','enum':['all','open','closed']}},'required':['status'],'additionalProperties':False},'steps':[{'kind':'select','selector':identify('group'),'input':'status','options':[{'value':name,'selector':identify(name)} for name in ['all','open','closed']],'timeoutMs':50},{'kind':'assert','selector':identify('result'),'expect':{'equalsInput':'status'}},{'kind':'extract','selector':identify('result'),'output':'status','valueType':'string'}]}
    return cfg,definition


class SelectionWorkflowTests(unittest.TestCase):
    def test_android_radio_and_ios_segmented_group_use_full_enum_domain_and_same_value_noop(self):
        for platform in ['android','ios']:
            with self.subTest(platform=platform),radio_app(platform) as app,tempfile.TemporaryDirectory() as out:
                cfg,spec=radio_definition(app,platform);learner=MobileSession(cfg,Path(out,'learn'));learn_workflow(learner,spec,[{'status':'open'},{'status':'closed'}]);recipe=next(iter(learner.progress['recipes'].values()));self.assertEqual(app['taps'],['open','closed'])
                third=MobileSession(cfg,Path(out,'third')).execute(recipe,recipe['revision'],{'status':'all'});self.assertEqual(third['outputs'],{'status':'all'});self.assertEqual(third['selectionStateVerifications'],{'changed':1,'noOp':0});self.assertEqual(app['taps'],['open','closed','all'])
                same=MobileSession(cfg,Path(out,'same'));result=same.execute(recipe,recipe['revision'],{'status':'all'});self.assertFalse(result['executionObserved']);self.assertEqual(result['selectionStateVerifications'],{'changed':0,'noOp':1});self.assertEqual(same.budget.count,0);self.assertEqual(len(app['taps']),3)
                raw=json.dumps(recipe['controlContracts'][0]);self.assertNotIn('selectionState',raw);self.assertNotIn('selected',raw)
                events=[json.loads(line) for line in Path(out,'same/events.jsonl').read_text().splitlines()];self.assertFalse(any(event['kind']=='workflow_action_started' for event in events));self.assertTrue(any(event['kind']=='workflow_select_state_verified' for event in events))

    def test_invalid_enum_domain_binding_permissions_and_value_fail_before_backend_request(self):
        for defect in ['unknown','number','domain','duplicate_value','duplicate_selector','text_selector','option_policy','group_policy','wrong_effect','wrong_type','const']:
            with self.subTest(defect=defect),radio_app() as app,tempfile.TemporaryDirectory() as out:
                cfg,spec=radio_definition(app);samples=[{'status':'open'},{'status':'closed'}]
                if defect=='unknown':samples[0]['status']='deleted'
                elif defect=='number':samples[0]['status']=1
                elif defect=='domain':spec['inputSchema']['properties']['status']['enum']=['all','open']
                elif defect=='duplicate_value':spec['steps'][0]['options'][-1]['value']='all'
                elif defect=='duplicate_selector':spec['steps'][0]['options'][-1]['selector']=spec['steps'][0]['options'][0]['selector']
                elif defect=='text_selector':spec['steps'][0]['selector']={'text':'Group'}
                elif defect=='option_policy':cfg['actionAllowlist'].pop()
                elif defect=='group_policy':cfg['actionAllowlist'][0]['kind']='click'
                elif defect=='wrong_effect':cfg['actionAllowlist'][-1]['effect']='write'
                elif defect=='wrong_type':spec['inputSchema']['properties']['status']['enum']=['all',True,'closed']
                else:spec['inputSchema']['properties']['status']['const']='all'
                with self.assertRaises(MobileError):learn_workflow(MobileSession(cfg,out),spec,samples)
                self.assertEqual(app['requests'],[]);self.assertEqual(app['taps'],[])

    def test_all_group_state_and_membership_failures_are_preflighted_before_any_tap(self):
        for platform in ['android','ios']:
            for defect in ['readonly','unknown','duplicate','cross','replace','multiple','none']:
                with self.subTest(platform=platform,defect=defect),radio_app(platform) as app,tempfile.TemporaryDirectory() as out:
                    cfg,spec=radio_definition(app,platform)
                    if defect=='multiple':app['selected']={'all','open'}
                    elif defect=='none':app['selected']=set()
                    else:app[defect]=True
                    with self.assertRaises(MobileError):learn_workflow(MobileSession(cfg,out),spec,[{'status':'open'},{'status':'closed'}])
                    self.assertEqual(app['taps'],[])

    def test_write_disconnect_and_never_updated_state_have_one_tap_unknown_and_no_retry(self):
        for defect in ['disconnect','freeze','cancel']:
            with self.subTest(defect=defect),radio_app() as app,tempfile.TemporaryDirectory() as out:
                cfg,spec=radio_definition(app,effect='write');session=MobileSession(cfg,out)
                if defect=='cancel':app['onTap']=lambda:setattr(session.budget,'cancelled',True)
                else:app[defect]=True
                with self.assertRaises(MobileError) as caught:learn_workflow(session,spec,[{'status':'open'},{'status':'closed'}])
                self.assertEqual(app['taps'],['open']);self.assertEqual(caught.exception.writeOutcome,{'status':'unknown','automaticRetry':False});self.assertTrue(Path(out,'write-intent.json').exists());self.assertFalse(session.progress['recipes'])
                if defect=='cancel':self.assertEqual(app['requests'][-1][1],'/element/open/click')

    def test_group_contract_rejects_added_or_replaced_members_after_learning_without_tap(self):
        with radio_app() as app,tempfile.TemporaryDirectory() as out:
            cfg,spec=radio_definition(app);learner=MobileSession(cfg,Path(out,'learn'));learn_workflow(learner,spec,[{'status':'open'},{'status':'closed'}]);recipe=next(iter(learner.progress['recipes'].values()));before=list(app['taps'])
            for defect in ['replace','duplicate','cross']:
                app[defect]=True
                with self.assertRaises(MobileError):MobileSession(cfg,Path(out,defect)).execute(recipe,recipe['revision'],{'status':'all'})
                self.assertEqual(app['taps'],before);app[defect]=False

if __name__=='__main__':unittest.main()
