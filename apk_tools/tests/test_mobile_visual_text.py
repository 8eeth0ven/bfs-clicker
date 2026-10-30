import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from apk_inventory.mobile_ui import MobileError, MobileSession
from apk_inventory.mobile_visual_android import definition_contract, _text_value, _text_run, learn

DEF={'kind':'native-visual-workflow','schemaVersion':1,'mode':'text-replace','id':'query','name':'Visual text query','effect':'read','activity':'com.example.Main','inputName':'query','inputSchema':{'type':'string','minLength':1,'maxLength':16,'pattern':'^[A-Za-z0-9]+$'},'focusAnchor':'Query','submitAnchor':'Search','valueRegion':{'x':.4,'y':.1,'width':.5,'height':.1},'resultRegion':{'x':.1,'y':.6,'width':.8,'height':.1},'resultPrefix':'RESULT'}

class TextDefinitionTests(unittest.TestCase):
 def test_input_schema_bound_and_unicode_opt_in(self):
  definition=copy.deepcopy(DEF);self.assertEqual(_text_value(definition,{'query':'alpha'}),'alpha')
  for value in ('', 'has space', 'x'*17, '中文'):
   with self.assertRaises(MobileError):_text_value(definition,{'query':value})
  definition['inputSchema']['pattern']='^[\\u4e00-\\u9fff]+$';definition_contract(definition);self.assertEqual(_text_value(definition,{'query':'中文'}),'中文')
 def test_reject_input_and_result_regions_that_overlap(self):
  definition=copy.deepcopy(DEF);definition['resultRegion']=dict(definition['valueRegion'])
  with self.assertRaises(MobileError) as caught:definition_contract(definition)
  self.assertEqual(caught.exception.code,'VISUAL_REGION_OVERLAP')
 def test_samples_not_persisted_and_schema_is_published(self):
  with tempfile.TemporaryDirectory() as tmp:
   config={'source':{'id':'visual','kind':'apk'},'backend':{'type':'adb','appId':'com.example','deviceId':'owned'},'actionAllowlist':[]};session=MobileSession(config,Path(tmp))
   def fake_run(session,lease,c,definition,inputs,contracts):
    contracts.update(focus={'anchor':'Query'},submit={'anchor':'Search'},_pixels='a'*64);return {'text':'RESULT '+inputs['query']}
   with patch('apk_inventory.mobile_visual_android.config_contract',return_value={}),patch('apk_inventory.mobile_visual_android.DeviceLease'),patch('apk_inventory.mobile_visual_android._text_run',side_effect=fake_run):learn(session,copy.deepcopy(DEF),[{'query':'alpha'},{'query':'beta'}])
   manifest=json.loads((Path(tmp)/'manifest.json').read_text());recipes=(Path(tmp)/'recipes.json').read_text();cap=manifest['capabilities'][0]
   self.assertEqual(cap['inputSchema']['properties']['query'],DEF['inputSchema']);self.assertIn('input_region_masked_not_layout_verified',cap['gaps']);self.assertNotIn('alpha',recipes);self.assertNotIn('beta',recipes)
 def test_ime_receipt_does_not_substitute_for_actual_visual_value(self):
  with tempfile.TemporaryDirectory() as tmp:
   config={'source':{'id':'visual','kind':'apk'},'backend':{'type':'adb','appId':'com.example','deviceId':'owned'},'actionAllowlist':[]};session=MobileSession(config,Path(tmp));session.backend.unicode_input={'configured':True}
   obs={'width':100,'height':100};anchor={'width':100,'height':100,'normalized':{'x':.1,'y':.1,'width':.1,'height':.1}}
   anchors={'focus':anchor,'submit':anchor}
   def tap(*args):session._visual_dispatched=True
   with patch('apk_inventory.mobile_visual_android._identity',return_value=10123),patch('apk_inventory.mobile_visual_android.android_unicode.preflight'),patch('apk_inventory.mobile_visual_android.android_unicode.commit') as commit,patch('apk_inventory.mobile_visual_android._text_observe',return_value=obs),patch('apk_inventory.mobile_visual_android._text_layout',return_value=(anchors,'fp')),patch('apk_inventory.mobile_visual_android._window',return_value='token'),patch('apk_inventory.mobile_visual_android._text_tap',side_effect=tap) as taps,patch('apk_inventory.mobile_visual_android.unchanged_locked'),patch('apk_inventory.mobile_visual_android.region_text',side_effect=['OLDVALUE']),patch('apk_inventory.mobile_visual_android.time.sleep'):
    with self.assertRaises(MobileError) as caught:_text_run(session,None,{'node':'x'},DEF,{'query':'alpha'}, {})
   self.assertEqual(caught.exception.code,'VISUAL_INPUT_NOT_VERIFIED');self.assertEqual(taps.call_count,1);commit.assert_called_once();self.assertTrue(session._visual_dispatched)
 def test_result_changed_by_typing_cannot_prove_noop_submit(self):
  with tempfile.TemporaryDirectory() as tmp:
   config={'source':{'id':'visual','kind':'apk'},'backend':{'type':'adb','appId':'com.example','deviceId':'owned'},'actionAllowlist':[]};session=MobileSession(config,Path(tmp));session.backend.unicode_input={'configured':True}
   obs={'width':100,'height':100};anchor={'width':100,'height':100,'normalized':{'x':.1,'y':.1,'width':.1,'height':.1}};anchors={'focus':anchor,'submit':anchor}
   def tap(*args):session._visual_dispatched=True
   with patch('apk_inventory.mobile_visual_android._identity',return_value=10123),patch('apk_inventory.mobile_visual_android.android_unicode.preflight'),patch('apk_inventory.mobile_visual_android.android_unicode.commit') as commit,patch('apk_inventory.mobile_visual_android._text_observe',return_value=obs),patch('apk_inventory.mobile_visual_android._text_layout',return_value=(anchors,'fp')),patch('apk_inventory.mobile_visual_android._window',return_value='token'),patch('apk_inventory.mobile_visual_android._text_tap',side_effect=tap) as taps,patch('apk_inventory.mobile_visual_android.unchanged_locked'),patch('apk_inventory.mobile_visual_android.region_text',side_effect=['alpha','RESULT alpha','RESULT alpha']),patch('apk_inventory.mobile_visual_android.time.sleep'):
    with self.assertRaises(MobileError) as caught:_text_run(session,None,{'node':'x'},DEF,{'query':'alpha'}, {})
   self.assertEqual(caught.exception.code,'VISUAL_RESULT_NOT_VERIFIED');self.assertEqual(taps.call_count,2);commit.assert_called_once();self.assertTrue(session._visual_dispatched)
if __name__=='__main__':unittest.main()
