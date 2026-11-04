"""Native renderer text remains an exact, bounded OCR evidence projection."""
import copy
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from apk_inventory.mobile_ui import MobileError
from apk_inventory.mobile_visual_workflow import region_text, ground_anchor, observe_locked

REGION={'x':0,'y':0,'width':1,'height':.5}
def token(text,x,width,score=.9,span=None,y=10):
    item={'text':text,'confidence':score,'bounds':{'x':x,'y':y,'width':width,'height':10}}
    if span is not None:item['nativeTextSpan']=dict(zip(('start','end','firstWord','lastWord'),span))
    return item

def word(text,start,end,index,x,width=10,score=.9,y=10,line=1):
    return {**token(text,x,width,score,y=y),'order':[1,1,line,index+1],'start':start,'end':end}

def observed(text,words,tokens,minimum=0):
    return {'width':100,'height':100,'tokens':tokens,'nativeTextEvidence':{'schemaVersion':1,'format':'tesseract_txt_tsv','offsetUnit':'unicode_codepoints','text':text,'minimumConfidence':minimum,'words':words}}

def shanghai():
    return observed('RESULT 上海\n',[word('RESULT',0,6,0,0,10),word('上',7,8,1,20,10,.92),word('海',8,9,2,40,10,.89)],[token('RESULT',0,10,span=(0,6,0,0)),token('上海',20,30,.89,(7,9,1,2))])

class NativeTextTests(unittest.TestCase):
    def blocked(self,data,region=REGION):
        with self.assertRaises(MobileError) as caught:region_text(data,region)
        self.assertEqual(caught.exception.code,'VISUAL_NATIVE_TEXT_UNVERIFIED')

    def test_zero_native_separator_preserves_actual_shanghai_rendering(self):
        self.assertEqual(region_text(shanghai(),REGION),'RESULT 上海')

    def test_real_spaces_multiple_spaces_and_newlines_are_never_folded(self):
        for separator in [' ','  ','\n','\u3000']:
            raw='上'+separator+'海\n';second=1+len(separator)
            data=observed(raw,[word('上',0,1,0,0),word('海',second,second+1,1,20)],[token('上',0,10,span=(0,1,0,0)),token('海',20,10,span=(second,second+1,1,1))])
            with self.subTest(separator=separator):self.assertEqual(region_text(data,REGION),'上'+separator+'海')

    def test_notquery_and_not_chinese_are_whole_run_anchors(self):
        for suffix in ['Query','搜索']:
            end=3+len(suffix);data=observed('Not'+suffix,[word('Not',0,3,0,0),word(suffix,3,end,1,20)],[token('Not'+suffix,0,30,span=(0,end,0,1))])
            self.assertEqual(region_text(data,REGION),'Not'+suffix)
            with self.assertRaises(MobileError):ground_anchor(data,suffix)

    def test_invalid_original_word_or_span_or_token_projection_is_rejected(self):
        mutations=[lambda d:d['nativeTextEvidence']['words'][1].update(start=6),lambda d:d['nativeTextEvidence']['words'][1].update(end=9),lambda d:d['nativeTextEvidence']['words'][1].update(text='下'),lambda d:d['nativeTextEvidence']['words'][1].update(order=[1,1,1,1]),lambda d:d['tokens'][1].update(confidence=1),lambda d:d['tokens'][1]['nativeTextSpan'].update(firstWord=2),lambda d:d['tokens'].pop(),lambda d:d['nativeTextEvidence'].update(text='NotRESULT 上海\n'),lambda d:d['nativeTextEvidence'].update(text='RESULT 上海!\n'),lambda d:d['nativeTextEvidence'].update(offsetUnit='utf16'),lambda d:d['nativeTextEvidence']['words'][1]['bounds'].update(width=True),lambda d:d['nativeTextEvidence'].update(schemaVersion=True)]
        for mutate in mutations:
            data=shanghai();mutate(data)
            with self.subTest(mutate=mutate):self.blocked(data)

    def test_low_confidence_child_is_not_skipped_or_raised(self):
        data=shanghai();data['nativeTextEvidence']['words'][2]['confidence']=.3;data['tokens'][1]['confidence']=.3
        self.blocked(data)
        data['nativeTextEvidence']['minimumConfidence']=.6;data['tokens'].pop();self.blocked(data)

    def test_partial_run_crossing_region_cannot_be_clipped_to_suffix(self):
        self.blocked(shanghai(),{'x':.3,'y':0,'width':.7,'height':.5})

    def test_selected_words_never_bridge_an_outside_word(self):
        data=observed('A Not B',[word('A',0,1,0,0),word('Not',2,5,1,20,y=80),word('B',6,7,2,40)],[token('A',0,10,span=(0,1,0,0)),token('Not',20,10,span=(2,5,1,1),y=80),token('B',40,10,span=(6,7,2,2))])
        self.blocked(data)

    def test_low_confidence_prefix_inside_region_cannot_disappear(self):
        data=observed('Not Query',[word('Not',0,3,0,0,score=.3),word('Query',4,9,1,20)],[token('Not',0,10,.3,(0,3,0,0)),token('Query',20,10,span=(4,9,1,1))])
        self.blocked(data)

    def test_unicode_offsets_are_codepoints_and_not_utf16(self):
        data=observed('😀上海',[word('😀',0,1,0,0),word('上海',1,3,1,20)],[token('😀上海',0,30,span=(0,3,0,1))])
        self.assertEqual(region_text(data,REGION),'😀上海')

    def test_empty_native_rendering_is_empty_evidence(self):
        self.assertEqual(region_text(observed('',[],[]),REGION),'')

    def test_native_marker_or_gap_cannot_fallback_when_metadata_removed(self):
        data=shanghai();del data['nativeTextEvidence'];self.blocked(data)
        data={'width':100,'height':100,'tokens':[],'gaps':['native_text_is_ocr_rendering_not_source_string']};self.blocked(data)

    def test_anchor_grounding_validates_original_metadata_before_dispatch_contract(self):
        data=shanghai();data['tokens'][0]['text']='Forged'
        with self.assertRaises(MobileError) as caught:ground_anchor(data,'Forged')
        self.assertEqual(caught.exception.code,'VISUAL_NATIVE_TEXT_UNVERIFIED')
        data=shanghai();del data['nativeTextEvidence']
        with self.assertRaises(MobileError):ground_anchor(data,'RESULT')

    def test_trusted_native_capture_rejects_metadata_and_marker_removed_together(self):
        data=shanghai();del data['nativeTextEvidence']
        for item in data['tokens']:item.pop('nativeTextSpan')
        self.capture(data,blocked=True)

    def test_trusted_native_capture_rejects_forged_tokens_before_any_grounding(self):
        data=shanghai();data['tokens'][0]['text']='Forged';self.capture(data,blocked=True)

    def test_native_capture_validation_does_not_treat_whole_screen_as_business_roi(self):
        data=shanghai();data['nativeTextEvidence']['words'][2]['confidence']=.3;data['tokens'][1]['confidence']=.3
        self.capture(data,blocked=False)

    def capture(self,data,blocked):
        capture={'imageSha256':'a'*64,'width':100,'height':100,'capturedAt':'2026-01-01T00:00:00Z','artifactVerification':{'status':'verified'},'imagePath':'/unused/private-capture.png'}
        data={**data,'imageSha256':capture['imageSha256']}
        class Lease:pass
        class Child:
            returncode=0
            pid=123456789
            def communicate(self,**kwargs):return json.dumps(data).encode(),b''
            def poll(self):return 0
            def wait(self):return 0
        backend=object();session=SimpleNamespace(backend=backend,budget=SimpleNamespace(timeout=lambda:10,check=lambda:None));lease=Lease();lease.backend=backend;lease.stream=io.BytesIO()
        with tempfile.TemporaryDirectory() as directory,patch('apk_inventory.mobile_visual_workflow.DeviceLease',Lease),patch('apk_inventory.mobile_visual_workflow.capture_locked',return_value=capture),patch('apk_inventory.mobile_visual_workflow.subprocess.Popen',return_value=Child()),patch('apk_inventory.mobile_visual_workflow.os.killpg'):
            if blocked:
                with self.assertRaises(MobileError) as caught:observe_locked(session,lease,Path(directory).resolve(),node=sys.executable,engine={'type':'tesseract','nativeText':True})
                self.assertEqual(caught.exception.code,'VISUAL_NATIVE_TEXT_UNVERIFIED')
            else:self.assertEqual(observe_locked(session,lease,Path(directory).resolve(),node=sys.executable,engine={'type':'tesseract','nativeText':True})['nativeTextEvidence'],data['nativeTextEvidence'])

    def test_default_legacy_word_spacing_is_unchanged(self):
        self.assertEqual(region_text({'width':100,'height':100,'tokens':[token('上',0,10),token('海',20,10)]},REGION),'上 海')

if __name__=='__main__':unittest.main()
