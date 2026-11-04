import unittest
from pathlib import Path
from apk_inventory.mobile_visual_android import _window, definition_contract
from apk_inventory.mobile_ui import MobileError

ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT/'output-vision-implementation/native-window-probe-real-20261030/base-input.txt'
OVERLAY=ROOT/'output-vision-implementation/native-window-probe-real-20261030/overlay-input.txt'
class Backend:
 app_id='com.bfs.probe'
 def __init__(self,data):self.data=data
 def shell(self,*args):return self.data
class VisualAndroidTests(unittest.TestCase):
 @unittest.skipUnless(BASE.exists() and OVERLAY.exists(),'requires captured Android 16 probe')
 def test_real_dump_detects_same_uid_transparent_window(self):
  definition={'activity':'com.bfs.probe.Main'}
  token=_window(Backend(BASE.read_text()),definition,10214,720,1280,150,270)
  self.assertTrue(token.startswith('0x'))
  with self.assertRaises(MobileError) as caught:_window(Backend(OVERLAY.read_text()),definition,10214,720,1280,150,270)
  self.assertEqual(caught.exception.code,'VISUAL_WINDOW_FOCUS_CHANGED')
 def test_definition_requires_distinct_anchors_and_expected_results(self):
  definition={'kind':'native-visual-workflow','schemaVersion':1,'id':'choose','name':'Choose','effect':'read','activity':'com.example.Main','inputName':'choice','choices':{'a':{'anchor':'Search','expected':'ONE'},'b':{'anchor':'Search','expected':'TWO'}},'resultRegion':{'x':.1,'y':.5,'width':.8,'height':.2},'resultPrefix':'RESULT'}
  with self.assertRaises(MobileError) as caught:definition_contract(definition)
  self.assertEqual(caught.exception.code,'VISUAL_CHOICES_INVALID')
 def test_reserved_pixel_contract_name_is_rejected(self):
  definition={'kind':'native-visual-workflow','schemaVersion':1,'id':'choose','name':'Choose','effect':'read','activity':'com.example.Main','inputName':'choice','choices':{'_pixels':{'anchor':'Alpha','expected':'ONE'},'b':{'anchor':'Beta','expected':'TWO'}},'resultRegion':{'x':.1,'y':.5,'width':.8,'height':.2},'resultPrefix':'RESULT'}
  with self.assertRaises(MobileError) as caught:definition_contract(definition)
  self.assertEqual(caught.exception.code,'VISUAL_CHOICES_INVALID')
if __name__=='__main__':unittest.main()

class VisualCliAndProcessTests(unittest.TestCase):
 def test_same_id_changed_definition_is_rejected_before_device_access(self):
  import copy, hashlib, json, sys, tempfile
  from pathlib import Path
  from apk_inventory.mobile_ui import MobileSession
  from apk_inventory.mobile_visual_android import config_contract
  definition={'kind':'native-visual-workflow','schemaVersion':1,'id':'choose','name':'Choose','effect':'read','activity':'com.example.Main','inputName':'choice','choices':{'a':{'anchor':'Alpha','expected':'ONE'},'b':{'anchor':'Beta','expected':'TWO'}},'resultRegion':{'x':.1,'y':.5,'width':.8,'height':.2},'resultPrefix':'RESULT'}
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);approved=root/'approved.json';approved.write_text(json.dumps(definition));helper=root/'helper.jar';helper.write_bytes(b'owned')
   config={'source':{'id':'visual','kind':'apk'},'backend':{'type':'adb','appId':'com.example.visual','deviceId':'owned'},'expectedArtifact':{'kind':'apk','sha256':'a'*64},'actionAllowlist':[],'nativeVisualWorkflow':{'enabled':True,'node':sys.executable,'helperJar':str(helper),'helperSha256':hashlib.sha256(b'owned').hexdigest(),'allowedWorkflows':['choose'],'approvedDefinitions':{'choose':str(approved)}}}
   session=MobileSession(config,root/'output');self.assertEqual(config_contract(session,definition,True),config['nativeVisualWorkflow'])
   for field in ('anchor','effect'):
    altered=copy.deepcopy(definition)
    if field=='anchor':altered['choices']['a']['anchor']='Delete'
    else:altered['effect']='write'
    with self.assertRaises(MobileError) as caught:config_contract(session,altered,True)
    self.assertEqual(caught.exception.code,'VISUAL_DEFINITION_NOT_APPROVED')
 def test_result_mask_limitation_is_in_published_manifest(self):
  import json, tempfile
  from pathlib import Path
  from unittest.mock import patch
  from apk_inventory.mobile_ui import MobileSession
  from apk_inventory.mobile_visual_android import learn
  definition={'kind':'native-visual-workflow','schemaVersion':1,'id':'choose','name':'Choose','effect':'read','activity':'com.example.Main','inputName':'choice','choices':{'a':{'anchor':'Alpha','expected':'ONE'},'b':{'anchor':'Beta','expected':'TWO'}},'resultRegion':{'x':.1,'y':.5,'width':.8,'height':.2},'resultPrefix':'RESULT'}
  with tempfile.TemporaryDirectory() as tmp:
   session=MobileSession({'source':{'id':'visual','kind':'apk'},'backend':{'type':'adb','appId':'com.example.visual','deviceId':'owned'},'actionAllowlist':[]},Path(tmp))
   def fake_run(session,lease,config,definition,choice,contracts):
    contracts[choice]={'anchor':choice};contracts['_pixels']='x';return {'text':choice}
   with patch('apk_inventory.mobile_visual_android.config_contract',return_value={}),patch('apk_inventory.mobile_visual_android.DeviceLease'),patch('apk_inventory.mobile_visual_android._run',side_effect=fake_run): learn(session,definition,[{'choice':'a'},{'choice':'b'}])
   manifest=json.loads((Path(tmp)/'manifest.json').read_text());self.assertIn('result_region_masked_not_layout_verified',manifest['capabilities'][0]['gaps'])
 def test_helper_cleanup_works_after_budget_and_requires_exact_owned_path(self):
  import json, sys, tempfile
  from pathlib import Path
  from apk_inventory.mobile_visual_android import _remove_helper
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);exe=root/'adb';trace=root/'trace'
   exe.write_text('#!'+sys.executable+'\nimport json,sys\nopen('+repr(str(trace))+',"w").write(json.dumps(sys.argv[1:]))\n');exe.chmod(0o700)
   class ExhaustedBudget:
    def timeout(self,*args): raise AssertionError('must not use exhausted budget')
   class Backend: executable=str(exe);device='owned';budget=ExhaustedBudget()
   remote='/data/local/tmp/bfs-visual-'+'a'*32+'.jar'
   self.assertTrue(_remove_helper(Backend(),remote));self.assertEqual(json.loads(trace.read_text()),['-s','owned','shell','rm -f '+remote])
   trace.unlink();self.assertFalse(_remove_helper(Backend(),'/data/local/tmp/*'));self.assertFalse(trace.exists())
 def test_actual_cli_stdin_and_result_file(self):
  import json, os, subprocess, sys, tempfile
  from pathlib import Path
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);config=root/'config.json';recipe=root/'recipe.json';out=root/'output'
   config.write_text(json.dumps({'source':{'id':'visual','kind':'apk'},'backend':{'type':'adb','appId':'com.example.visual','deviceId':'owned'},'actionAllowlist':[]}));recipe.write_text(json.dumps({'recipeType':'visual_workflow'}))
   script="import apk_inventory.mobile_visual_android as m; m.execute=lambda session,recipe,revision,inputs:{'ok':True,'status':'completed','outputs':inputs};raise SystemExit(m.main())"
   process=subprocess.run([sys.executable,'-c',script,'--operation','execute','--config',str(config),'--output',str(out),'--recipe',str(recipe),'--revision','rev'],input=json.dumps({'inputs':{'choice':'beta'}}),text=True,capture_output=True,env={**os.environ,'PYTHONPATH':str(ROOT/'apk_tools')},timeout=10)
   self.assertEqual(process.returncode,0,process.stderr);self.assertEqual(json.loads(process.stdout)['outputs'],{'choice':'beta'});self.assertEqual(json.loads((out/'result.json').read_text())['outputs'],{'choice':'beta'})
   badout=root/'bad';process=subprocess.run([sys.executable,'-m','apk_inventory.mobile_visual_android','--operation','execute','--config',str(config),'--output',str(badout),'--recipe',str(recipe),'--revision','bad'],input=json.dumps({'inputs':{'choice':'beta'}}),text=True,capture_output=True,env={**os.environ,'PYTHONPATH':str(ROOT/'apk_tools')},timeout=10)
   self.assertEqual(process.returncode,0,process.stderr);self.assertEqual(json.loads(process.stdout)['error']['code'],'VISUAL_RECIPE_REVISION_MISMATCH');self.assertEqual(json.loads((badout/'result.json').read_text())['writeOutcome']['status'],'not_started')
 def test_pixel_fingerprint_budget_kills_process_group(self):
  import os, sys, tempfile, time, subprocess
  from pathlib import Path
  from apk_inventory.mobile_ui import Budget
  from apk_inventory.mobile_visual_android import _masked
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);exe=root/'node-wrapper';pidfile=root/'child.pid'
   exe.write_text('#!'+sys.executable+'\nimport subprocess,sys,time\nc=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"])\nopen('+repr(str(pidfile))+',"w").write(str(c.pid))\ntime.sleep(30)\n');exe.chmod(0o700)
   class Session: budget=Budget({'maxDurationMs':2000})
   with self.assertRaises(MobileError):_masked(str(exe),Session(),{'_imagePath':'unused','width':1,'height':1},{'x':0,'y':0,'width':1,'height':1})
   self.assertTrue(pidfile.exists());pid=int(pidfile.read_text())
   for _ in range(100):
    try: os.kill(pid,0)
    except ProcessLookupError: break
    state=subprocess.run(['ps','-o','stat=','-p',str(pid)],capture_output=True,text=True).stdout.strip()
    if not state or state.startswith('Z'): break
    time.sleep(.02)
   else:self.fail('pixel helper descendant survived cancellation')
