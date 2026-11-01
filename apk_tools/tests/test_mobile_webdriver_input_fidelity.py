"""Real loopback W3C source/element/type protocol, not a device or OCR test."""
from contextlib import contextmanager
import hashlib
import http.server
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import unicodedata
from xml.sax.saxutils import quoteattr

from apk_inventory.mobile_ui import Budget, MobileError, MobileSession, WebDriverBackend, locate
from apk_inventory.mobile_workflows import _with_write_outcome

APP = 'com.example.fidelity'


@contextmanager
def fixture(platform='ios'):
    state = {'value': '旧前缀 ', 'other': 'OTHER', 'app': APP, 'mode': 'normal', 'calls': [],
             'element': 'field-1', 'missing': False, 'placeholder': '', 'secure': False,
             'readonly': False, 'visible': True, 'enabled': True, 'duplicate': False,
             'classChanged': False, 'afterValue': None, 'afterClear': None, 'delayValue': 0}
    def source():
        cls = ('XCUIElementTypeSecureTextField' if state['secure'] else 'XCUIElementTypeTextField') if platform == 'ios' else 'android.widget.EditText'
        if state['classChanged']:
            cls = 'XCUIElementTypeTextView' if platform == 'ios' else 'android.widget.AutoCompleteTextView'
        attrs = {'type' if platform == 'ios' else 'class': cls,
                 'name' if platform == 'ios' else 'resource-id': 'query' if platform == 'ios' else APP+':id/query',
                 'enabled': str(state['enabled']).lower(), 'visible': str(state['visible']).lower(),
                 'readOnly': str(state['readonly']).lower(), 'password': str(state['secure']).lower()}
        if platform == 'android':
            attrs.update({'package': APP, 'bounds': '[0,0][200,40]'})
        else:
            attrs.update({'label': 'Query', 'x': '0', 'y': '0', 'width': '200', 'height': '40'})
        if not state['missing']:
            attrs['value' if platform == 'ios' else 'text'] = state['value'] or state['placeholder']
        if state['placeholder']:
            attrs['placeholderValue'] = state['placeholder']
        node = '<node '+' '.join(k+'='+quoteattr(v) for k,v in attrs.items())+'/>'
        return '<root>'+node*(2 if state['duplicate'] else 1)+'</root>'
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def reply(self, value):
            body = json.dumps({'value': value}, ensure_ascii=True).encode()
            self.send_response(200); self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(body))); self.end_headers()
            try: self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError): pass
        def command(self):
            size = int(self.headers.get('Content-Length',0)); body = json.loads(self.rfile.read(size)) if size else None
            route = self.path.removeprefix('/session/fidelity')
            state['calls'].append((self.command,route,body))
            if route == '/execute/sync': return self.reply({'bundleId':state['app']})
            if route == '/appium/device/current_package': return self.reply(state['app'])
            if route == '/source': return self.reply(source())
            if route == '/elements': return self.reply([{'element-6066-11e4-a52e-4f735466cecf':state['element']}])
            if route.endswith('/clear'):
                if state['mode'] != 'ignore-clear': state['value']=''
                if state['afterClear']: state['afterClear']()
                return self.reply(None)
            if route.endswith('/value'):
                if body['value'] != list(body['text']): return self.reply({'error':'bad input representation'})
                value = body['text']
                if state['mode']=='compact': value=value.replace(' ','')
                if state['mode']=='normalize': value=' '.join(value.split())
                if state['mode']=='unicode-normalize': value=unicodedata.normalize('NFC',value)
                if state['mode']=='wrong-target': state['other']+=value
                elif state['mode']!='ignore': state['value']+=value
                if state['mode']=='prefix-changed': state['value']='changed:'+state['value']
                if state['afterValue']: state['afterValue']()
                time.sleep(state['delayValue'])
                return self.reply(None)
            return self.reply({'error':'unsupported'})
        do_GET = do_POST = command
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=lambda:server.serve_forever(poll_interval=.01),daemon=True);thread.start()
    config={'type':'webdriver','platform':platform,'appId':APP,'sessionId':'fidelity',
            'url':'http://127.0.0.1:'+str(server.server_address[1]),'commandTimeoutMs':1000}
    backend=WebDriverBackend(config,Budget({'maxDurationMs':10000}))
    wanted={'accessibilityId':'query'} if platform=='ios' else {'resourceId':APP+':id/query'}
    state.update({'config':config,'backend':backend,'wanted':wanted})
    try: yield state
    finally: server.shutdown();server.server_close();thread.join(1)


def perform(f,value,replace=True,tree=None):
    return f['backend'].perform({'kind':'type','selector':f['wanted'],'input':'query','replace':replace},
                                tree if tree is not None else f['backend'].observe(),{'query':value})


def counts(f):
    return {key:sum(route.endswith('/'+key) for _,route,_ in f['calls']) for key in ('clear','value')}


class InputFidelityTests(unittest.TestCase):
    def test_real_http_replace_keeps_exact_codepoints_without_logging_input(self):
        values=['上海','上 海','上  海',' 上 海 ','A 海, B','“上 海,”','海🙂e\u0301']
        for platform in ('ios','android'):
            with fixture(platform) as f:
                for value in values:
                    with self.subTest(platform=platform,value=value):
                        before=counts(f);perform(f,value);self.assertEqual(f['value'],value)
                        self.assertEqual(counts(f),{'clear':before['clear']+1,'value':before['value']+1})
                        self.assertEqual(f['other'],'OTHER')
                        node=locate(f['backend'].observe(),f['wanted'])
                        self.assertEqual(node['_inputSha256'],hashlib.sha256(value.encode()).hexdigest())
                        self.assertEqual(node['text'],'')

    def test_real_http_append_keeps_prefix_and_exact_suffix_including_empty_and_spaces(self):
        for platform in ('ios','android'):
            with fixture(platform) as f:
                for value in ['上 海','  A海 ', '', '🙂']:
                    old=f['value'];before=counts(f);perform(f,value,False)
                    self.assertEqual(f['value'],old+value)
                    self.assertEqual(counts(f),{'clear':0,'value':before['value']+1})
        with fixture() as f:
            f['placeholder']='Query';old=f['value'];perform(f,'Query',False)
            self.assertEqual(f['value'],old+'Query');self.assertEqual(counts(f),{'clear':0,'value':1})

    def test_ignored_compacted_normalized_or_wrong_target_value_is_not_success(self):
        for platform in ('ios','android'):
            for mode in ('ignore','compact','normalize','wrong-target'):
                with self.subTest(platform=platform,mode=mode),fixture(platform) as f:
                    f['mode']=mode
                    with self.assertRaisesRegex(MobileError,'WEBDRIVER_INPUT_NOT_VERIFIED'):perform(f,' 上  海 ')
                    self.assertEqual(counts(f),{'clear':1,'value':1})
        with fixture() as f:
            f['mode']='unicode-normalize'
            with self.assertRaisesRegex(MobileError,'WEBDRIVER_INPUT_NOT_VERIFIED'):perform(f,'e\u0301')
            self.assertEqual(counts(f),{'clear':1,'value':1})

    def test_clear_must_be_observed_empty_before_one_value_send(self):
        with fixture() as f:
            f['mode']='ignore-clear'
            with self.assertRaisesRegex(MobileError,'WEBDRIVER_INPUT_CLEAR_UNVERIFIED'):perform(f,'上 海')
            self.assertEqual(counts(f),{'clear':1,'value':0})

    def test_missing_secure_readonly_hidden_disabled_and_placeholder_are_not_accepted(self):
        for mutation in ('missing','secure','readonly','hidden','disabled'):
            with self.subTest(mutation=mutation),fixture() as f:
                f['visible']=mutation!='hidden';f['enabled']=mutation!='disabled'
                if mutation in ('missing','secure','readonly'):f[mutation]=True
                with self.assertRaises(MobileError):perform(f,'上 海')
                self.assertEqual(counts(f),{'clear':0,'value':0})
        with fixture() as f:
            f['value']='';f['placeholder']='上 海'
            with self.assertRaisesRegex(MobileError,'WEBDRIVER_INPUT_EVIDENCE_UNAVAILABLE'):perform(f,'上 海',False)
            self.assertEqual(counts(f),{'clear':0,'value':0})
            with self.assertRaisesRegex(MobileError,'WEBDRIVER_INPUT_PLACEHOLDER_AMBIGUOUS'):perform(f,'上 海')
            self.assertEqual(counts(f),{'clear':0,'value':0})

    def test_placeholder_is_only_intermediate_and_complete_distinct_replace_echo_is_required(self):
        with fixture() as f:
            f['value']='';f['placeholder']='Query'
            perform(f,' 上  海 ')
            self.assertEqual(f['value'],' 上  海 ')
            self.assertEqual(counts(f),{'clear':1,'value':1})
            source_reads=sum(route=='/source' for _,route,_ in f['calls'])
            self.assertGreaterEqual(source_reads,4)
        with fixture() as f:
            f['placeholder']='Query';f['afterValue']=lambda:f.update({'placeholder':'上 海'})
            with self.assertRaisesRegex(MobileError,'WEBDRIVER_INPUT_EVIDENCE_UNAVAILABLE'):perform(f,'上 海')
            self.assertEqual(counts(f),{'clear':1,'value':1})
        with fixture() as f:
            f['value']='';f['placeholder']='Query'
            with self.assertRaisesRegex(MobileError,'WEBDRIVER_INPUT_EVIDENCE_UNAVAILABLE'):perform(f,'')
            self.assertEqual(counts(f),{'clear':1,'value':1})

    def test_app_element_type_or_uniqueness_drift_after_send_stops_without_second_send(self):
        for change in ('app','element','classChanged','duplicate','missing','secure'):
            with self.subTest(change=change),fixture() as f:
                def mutate():
                    f[change]='com.example.outside' if change=='app' else 'field-2' if change=='element' else True
                f['afterValue']=mutate
                with self.assertRaises(MobileError):perform(f,'上 海')
                self.assertEqual(counts(f),{'clear':1,'value':1})

    def test_after_clear_app_or_readonly_drift_prevents_value_dispatch(self):
        for change in ('app','readonly'):
            with self.subTest(change=change),fixture() as f:
                f['afterClear']=lambda:f.update({change:'com.example.outside' if change=='app' else True})
                with self.assertRaises(MobileError):perform(f,'上 海')
                self.assertEqual(counts(f),{'clear':1,'value':0})

    def test_append_rejects_stale_prefix_and_post_send_prefix_changes(self):
        with fixture() as f:
            old=f['backend'].observe();f['value']='changed'
            with self.assertRaisesRegex(MobileError,'WEBDRIVER_INPUT_PREFIX_CHANGED'):perform(f,'上 海',False,old)
            self.assertEqual(counts(f),{'clear':0,'value':0})
        with fixture() as f:
            f['mode']='prefix-changed'
            with self.assertRaisesRegex(MobileError,'WEBDRIVER_INPUT_NOT_VERIFIED'):perform(f,'上 海',False)
            self.assertEqual(counts(f),{'clear':0,'value':1})

    def test_invalid_literal_controls_reserved_webdriver_keys_and_surrogates_send_no_ui(self):
        for value in ['x\n','\x00','\ue003','\ud800']:
            with self.subTest(value=repr(value)),fixture() as f:
                with self.assertRaisesRegex(MobileError,'WEBDRIVER_LITERAL_INPUT_UNSUPPORTED'):perform(f,value)
                self.assertEqual(counts(f),{'clear':0,'value':0})

    def test_cancel_or_expired_budget_after_single_command_cannot_continue(self):
        for kind in ('cancel','duration'):
            with self.subTest(kind=kind),fixture() as f:
                def stop():
                    if kind=='cancel':f['backend'].budget.cancelled=True
                    else:f['backend'].budget.started-=30
                f['afterValue']=stop
                with self.assertRaises(MobileError):perform(f,'上 海')
                self.assertEqual(counts(f),{'clear':1,'value':1})

    def test_write_failure_or_timeout_persists_unknown_without_raw_input_or_retry(self):
        for mode in ('ignore','timeout'):
            with self.subTest(mode=mode),fixture() as f,tempfile.TemporaryDirectory() as out:
                config={'source':{'id':'fidelity','kind':'ios'},'backend':f['config'],'limits':{'maxDurationMs':5000}}
                session=MobileSession(config,out);f['backend']=session.backend
                if mode=='timeout':session.backend.command_timeout_ms=50;f['delayValue']=.15
                else:f['mode']='ignore'
                value=' 上  海 '
                with self.assertRaises(MobileError) as caught:
                    _with_write_outcome(session,{'effect':'write'},lambda:perform(f,value))
                self.assertEqual(caught.exception.writeOutcome,{'status':'unknown','automaticRetry':False})
                self.assertEqual(json.loads((Path(out)/'write-intent.json').read_text())['status'],'unknown')
                self.assertEqual(counts(f),{'clear':1,'value':1})
                self.assertNotIn(value,''.join(p.read_text() for p in Path(out).glob('*.json')))
                self.assertNotIn(value,str(caught.exception))
        with fixture() as f,tempfile.TemporaryDirectory() as out:
            f['missing']=True
            session=MobileSession({'source':{'id':'fidelity','kind':'ios'},'backend':f['config']},out)
            f['backend']=session.backend
            with self.assertRaises(MobileError) as caught:
                _with_write_outcome(session,{'effect':'write'},lambda:perform(f,'上 海'))
            self.assertEqual(caught.exception.writeOutcome,{'status':'not_started','automaticRetry':False})
            self.assertFalse((Path(out)/'write-intent.json').exists())
            self.assertEqual(counts(f),{'clear':0,'value':0})


if __name__=='__main__':unittest.main()
