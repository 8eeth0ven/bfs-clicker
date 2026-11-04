import json, tempfile, unittest, subprocess, sys, os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from apk_inventory.mobile_ui import MobileError, WebDriverBackend
from apk_inventory import mobile_visual_ios as visual


def definition():
 return {'kind':'native-visual-workflow','schemaVersion':1,'id':'lookup','name':'Fixture','effect':'read','inputName':'choice','choices':{'first':{'anchor':'ALPHA','expected':'FIRST'},'second':{'anchor':'BETA','expected':'SECOND'}},'resultRegion':{'x':.05,'y':.6,'width':.9,'height':.2},'resultPrefix':'RESULT'}

def backend():
 value=object.__new__(WebDriverBackend);value.platform='ios';value.app_id='com.example.fixture';value.foreground=lambda:None
 return value

class VisualIosTests(unittest.TestCase):
 def test_cli_bad_config_is_structured_not_a_traceback(self):
  with tempfile.TemporaryDirectory() as tmp:
   config=Path(tmp)/'config.json';config.write_text('{}');output=Path(tmp)/'out';spec=Path(tmp)/'spec.json';spec.write_text('{}');samples=Path(tmp)/'samples.json';samples.write_text('[]')
   run=subprocess.run([sys.executable,'-m','apk_inventory.mobile_visual_ios','--config',str(config),'--operation','workflow-learn','--workflow',str(spec),'--samples',str(samples),'--output',str(output)],capture_output=True,text=True,timeout=10)
   self.assertNotIn('Traceback',run.stderr);self.assertEqual(json.loads(run.stdout)['error']['code'],'CONFIG_INVALID')
 def test_contract_rejects_unimplemented_text_mode(self):
  d=definition();self.assertEqual(visual.definition_contract(d),d)
  with self.assertRaises(MobileError): visual.definition_contract({**d,'mode':'text-replace'})
 def test_approval_binds_full_definition_and_write_authorization(self):
  with tempfile.TemporaryDirectory() as tmp:
   file=Path(tmp)/'trusted.json';file.write_text(json.dumps(definition()))
   config={'enabled':True,'node':'/usr/bin/env','allowedWorkflows':['lookup'],'approvedDefinitions':{'lookup':str(file)}}
   session=SimpleNamespace(config={'nativeVisualWorkflow':config},source={'id':'fixture','kind':'ios'},backend=backend())
   self.assertIs(visual.config_contract(session,definition(),True),config)
   changed=definition();changed['choices']['first']['anchor']='OTHER'
   with self.assertRaisesRegex(MobileError,'VISUAL_DEFINITION_NOT_APPROVED'):visual.config_contract(session,changed,True)
   file.write_text(json.dumps({**definition(),'effect':'write'}))
   with self.assertRaisesRegex(MobileError,'WORKFLOW_WRITE_NOT_APPROVED'):visual.config_contract(session,{**definition(),'effect':'write'},True)
 def test_geometry_rejects_orientation_and_unmatched_pixel_ratio(self):
  b=backend();b.request=lambda method,path: 'LANDSCAPE' if path=='/orientation' else {'x':0,'y':0,'width':100,'height':200}
  with self.assertRaisesRegex(MobileError,'VISUAL_COORDINATES_UNVERIFIED'):visual._geometry(b,300,600)
  b.request=lambda method,path: 'PORTRAIT' if path=='/orientation' else {'x':0,'y':0,'width':100,'height':150}
  with self.assertRaisesRegex(MobileError,'VISUAL_COORDINATES_UNVERIFIED'):visual._geometry(b,300,600)
 def test_wrong_foreground_stops_before_capture_or_dispatch(self):
  b=backend();b.foreground=lambda: (_ for _ in ()).throw(MobileError('APP_OUT_OF_SCOPE','blocked'))
  session=SimpleNamespace(backend=b,output=Path('/unused'))
  with patch.object(visual,'observe_locked') as capture:
   with self.assertRaisesRegex(MobileError,'APP_OUT_OF_SCOPE'):visual._run(session,None,{'node':'/usr/bin/env'},definition(),'first',{})
   capture.assert_not_called()
 def test_ambiguous_ocr_anchor_does_not_dispatch(self):
  with tempfile.TemporaryDirectory() as tmp:
   b=backend();calls=[];b.request=lambda method,path,body=None:calls.append(path)
   session=SimpleNamespace(backend=b,output=Path(tmp),budget=SimpleNamespace(action=lambda:None))
   obs={'width':300,'height':600,'tokens':[{'text':'ALPHA','confidence':.99,'bounds':{'x':10,'y':100,'width':20,'height':20}}]*2}
   with patch.object(visual,'observe_locked',return_value=obs):
    with self.assertRaisesRegex(MobileError,'VISUAL_ANCHOR_AMBIGUOUS'):visual._run(session,None,{'node':'/usr/bin/env'},definition(),'first',{})
   self.assertEqual(calls,[])
 def test_unchanged_result_after_one_dispatch_is_unknown_without_retry(self):
  with tempfile.TemporaryDirectory() as tmp:
   b=backend();calls=[]
   def request(method,path,body=None):
    calls.append(path)
    if path=='/orientation':return 'PORTRAIT'
    if path=='/window/rect':return {'x':0,'y':0,'width':100,'height':200}
   b.request=request;session=SimpleNamespace(backend=b,output=Path(tmp),budget=SimpleNamespace(action=lambda:None))
   obs={'width':300,'height':600,'tokens':[],'_imagePath':'ignored'};anchor={'anchor':'ALPHA','width':300,'height':600,'normalized':{'x':.1,'y':.2,'width':.2,'height':.05}}
   with patch.object(visual,'observe_locked',return_value=obs),patch.object(visual,'ground_anchor',return_value=anchor),patch.object(visual,'_masked',return_value='a'*64),patch.object(visual,'region_text',return_value='RESULT FIRST'),patch.object(visual,'unchanged_locked'),patch.object(visual.time,'sleep'):
    with self.assertRaisesRegex(MobileError,'VISUAL_RESULT_NOT_VERIFIED') as error:visual._run(session,None,{'node':'/usr/bin/env'},definition(),'first',{})
   self.assertEqual(error.exception.writeOutcome,{'status':'unknown','automaticRetry':False});self.assertEqual(calls.count('/actions'),1)
 def test_stale_frame_never_dispatches_and_failure_after_dispatch_is_unknown(self):
  with tempfile.TemporaryDirectory() as tmp:
   b=backend();calls=[]
   def request(method,path,body=None):
    calls.append(path)
    if path=='/orientation':return 'PORTRAIT'
    if path=='/window/rect':return {'x':0,'y':0,'width':100,'height':200}
    raise MobileError('dispatch_failed')
   b.request=request;session=SimpleNamespace(backend=b,output=Path(tmp),budget=SimpleNamespace(action=lambda:None))
   obs={'width':300,'height':600,'tokens':[],'_imagePath':'ignored'};anchor={'anchor':'ALPHA','width':300,'height':600,'normalized':{'x':.1,'y':.2,'width':.2,'height':.05}}
   patches=[patch.object(visual,'observe_locked',return_value=obs),patch.object(visual,'ground_anchor',return_value=anchor),patch.object(visual,'_masked',return_value='a'*64),patch.object(visual,'region_text',return_value='RESULT NONE')]
   for p in patches:p.start()
   self.addCleanup(lambda:[p.stop() for p in patches])
   with patch.object(visual,'unchanged_locked',side_effect=MobileError('VISUAL_FRAME_CHANGED')):
    with self.assertRaisesRegex(MobileError,'VISUAL_FRAME_CHANGED'):visual._run(session,None,{'node':'/usr/bin/env'},definition(),'first',{})
   self.assertNotIn('/actions',calls)
   with patch.object(visual,'unchanged_locked',return_value={}):
    with self.assertRaises(MobileError) as error:visual._run(session,None,{'node':'/usr/bin/env'},definition(),'first',{})
   self.assertEqual(error.exception.writeOutcome,{'status':'unknown','automaticRetry':False});self.assertEqual(calls.count('/actions'),1)

if __name__=='__main__':unittest.main()
