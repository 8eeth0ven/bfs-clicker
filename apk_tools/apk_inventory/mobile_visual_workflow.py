"""Primitives for future native visual workflows; no capability is published here.

Callers must own a DeviceLease throughout observation, grounding, fresh-frame
verification, dispatch and result checking. OCR text is untrusted pixel evidence.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import uuid
from .mobile_ui import DeviceLease, MobileError
from .mobile_visual import capture_locked, _safe_dir

_PROJECT = Path(__file__).resolve().parents[2]

def _fail(code):
    raise MobileError(code, 'blocked')

def _region(value):
    if not isinstance(value, dict) or set(value) != {'x','y','width','height'}:
        _fail('VISUAL_REGION_INVALID')
    if any(not isinstance(value[key], (int,float)) or isinstance(value[key],bool) or not math.isfinite(value[key]) for key in value):
        _fail('VISUAL_REGION_INVALID')
    if value['x'] < 0 or value['y'] < 0 or value['width'] <= 0 or value['height'] <= 0 or value['x'] + value['width'] > 1 or value['y'] + value['height'] > 1:
        _fail('VISUAL_REGION_INVALID')
    return value

# Unicode White_Space, matching the observer's explicit native text contract.
_NATIVE_SPACE = frozenset(' \t\n\r\f\v\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000')

def _native_mode(observation):
    marked=any(isinstance(token,dict) and 'nativeTextSpan' in token for token in observation.get('tokens',[])) or 'native_text_is_ocr_rendering_not_source_string' in observation.get('gaps',[])
    if marked and 'nativeTextEvidence' not in observation:_fail('VISUAL_NATIVE_TEXT_UNVERIFIED')
    return 'nativeTextEvidence' in observation

def _native_contract(observation):
    """Validate provenance independently of any selected business region."""
    def invalid(): _fail('VISUAL_NATIVE_TEXT_UNVERIFIED')
    def number(value): return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)
    def integer(value): return isinstance(value,int) and not isinstance(value,bool)
    evidence=observation.get('nativeTextEvidence')
    if not isinstance(evidence,dict) or set(evidence)!={'schemaVersion','format','offsetUnit','text','minimumConfidence','words'} or type(evidence['schemaVersion']) is not int or evidence['schemaVersion']!=1 or evidence['format']!='tesseract_txt_tsv' or evidence['offsetUnit']!='unicode_codepoints': invalid()
    text=evidence['text'];minimum=evidence['minimumConfidence'];words=evidence['words']
    if not isinstance(text,str) or not number(minimum) or not 0<=minimum<=1 or not isinstance(words,list) or len(words)>5000: invalid()
    try:
        if len(text.encode('utf8'))>4*1024*1024: invalid()
    except UnicodeError: invalid()
    if any(ord(char)<32 and char not in _NATIVE_SPACE or ord(char)==127 for char in text): invalid()
    width,height=observation['width'],observation['height']
    if not integer(width) or not integer(height) or not 0<width<=16384 or not 0<height<=16384 or width*height>32000000: invalid()
    runs=[];cursor=0;previous_order=None
    for index,word in enumerate(words):
        if not isinstance(word,dict) or set(word)!={'text','confidence','bounds','order','start','end'}: invalid()
        value=word['text'];score=word['confidence'];box=word['bounds'];order=word['order'];start=word['start'];end=word['end']
        if not isinstance(value,str) or not value or len(value)>4096 or any(char in _NATIVE_SPACE for char in value) or not number(score) or not 0<=score<=1 or not isinstance(box,dict) or set(box)!={'x','y','width','height'} or any(not integer(v) for v in box.values()) or box['x']<0 or box['y']<0 or box['width']<=0 or box['height']<=0 or box['x']+box['width']>width or box['y']+box['height']>height: invalid()
        if not isinstance(order,list) or len(order)!=4 or any(not integer(v) or v<1 for v in order) or previous_order is not None and tuple(order)<=tuple(previous_order): invalid()
        if not integer(start) or not integer(end) or not cursor<=start<end<=len(text) or text[start:end]!=value or any(char not in _NATIVE_SPACE for char in text[cursor:start]): invalid()
        if runs and cursor==start:
            if order[:3]!=previous_order[:3]: invalid()
            run=runs[-1];run['nativeTextSpan'].update(end=end,lastWord=index);run['confidence']=min(run['confidence'],score)
            bounds=run['bounds'];right=max(bounds['x']+bounds['width'],box['x']+box['width']);bottom=max(bounds['y']+bounds['height'],box['y']+box['height']);bounds['x']=min(bounds['x'],box['x']);bounds['y']=min(bounds['y'],box['y']);bounds['width']=right-bounds['x'];bounds['height']=bottom-bounds['y']
        else:
            runs.append({'text':value,'confidence':score,'bounds':dict(box),'nativeTextSpan':{'start':start,'end':end,'firstWord':index,'lastWord':index}})
        cursor=end;previous_order=order
    if any(char not in _NATIVE_SPACE for char in text[cursor:]): invalid()
    for run in runs:run['text']=text[run['nativeTextSpan']['start']:run['nativeTextSpan']['end']]
    def no_booleans(value):
        if isinstance(value,bool):return False
        if isinstance(value,dict):return all(no_booleans(item) for item in value.values())
        if isinstance(value,list):return all(no_booleans(item) for item in value)
        return True
    if not no_booleans(observation.get('tokens')) or observation.get('tokens')!=[run for run in runs if run['confidence']>=minimum]: invalid()
    return text,runs,minimum

def _native_region_text(observation, rect, confidence):
    text,runs,minimum=_native_contract(observation)
    if not isinstance(confidence,(int,float)) or isinstance(confidence,bool) or not math.isfinite(confidence) or not 0<=confidence<=1:_fail('VISUAL_NATIVE_TEXT_UNVERIFIED')
    def invalid():_fail('VISUAL_NATIVE_TEXT_UNVERIFIED')
    left,top,right,bottom=rect;selected=[]
    for index,run in enumerate(runs):
        box=run['bounds'];x,y,w,h=(box[k] for k in ('x','y','width','height'))
        if x<right and x+w>left and y<bottom and y+h>top:
            if x<left or y<top or x+w>right or y+h>bottom or run['confidence']<max(confidence,minimum): invalid()
            selected.append(index)
    if not selected:return ''
    if selected!=list(range(selected[0],selected[-1]+1)): invalid()
    return text[runs[selected[0]]['nativeTextSpan']['start']:runs[selected[-1]]['nativeTextSpan']['end']]

def region_text(observation, region, confidence=.6):
    """Only fully contained words enter a result region, never crossing it."""
    region=_region(region); width,height=observation['width'],observation['height']
    # Match the approved screenshot masks: fractional normalized edges describe
    # whole pixels rounded outward, not a stricter subpixel extraction window.
    left=math.floor(region['x']*width); top=math.floor(region['y']*height)
    right=math.ceil((region['x']+region['width'])*width)
    bottom=math.ceil((region['y']+region['height'])*height)
    if _native_mode(observation):
        return _native_region_text(observation,(left,top,right,bottom),confidence)
    words=[]
    for token in observation['tokens']:
        box=token['bounds'];x,y,w,h=(box[k] for k in ('x','y','width','height'))
        if token['confidence']>=confidence and w>0 and h>0 and x>=left and y>=top and x+w<=right and y+h<=bottom:
            words.append(token['text'])
    return ' '.join(words)

def ground_anchor(observation, text, expected=None, confidence=.6):
    if _native_mode(observation):_native_contract(observation)
    if not isinstance(text,str) or not text or len(text)>128:
        _fail('VISUAL_ANCHOR_INVALID')
    words=[item for item in observation['tokens'] if item['text']==text and item['confidence']>=confidence]
    if len(words)!=1:
        _fail('VISUAL_ANCHOR_AMBIGUOUS' if words else 'VISUAL_ANCHOR_MISSING')
    box=words[0]['bounds'];width,height=observation['width'],observation['height']
    normalized={key:box[key]/(width if key in {'x','width'} else height) for key in ('x','y','width','height')}
    contract={'anchor':text,'width':width,'height':height,'normalized':normalized}
    if expected and (not isinstance(expected,dict) or not isinstance(expected.get('normalized'),dict) or any(not isinstance(expected['normalized'].get(key),(int,float)) or isinstance(expected['normalized'].get(key),bool) or not math.isfinite(expected['normalized'][key]) for key in normalized) or expected.get('anchor')!=text or expected.get('width')!=width or expected.get('height')!=height or any(abs(normalized[key]-expected['normalized'][key])>.025 for key in normalized)):
        _fail('VISUAL_ANCHOR_CHANGED')
    return contract

def observe_locked(session, lease, output, *, node, engine, language='eng'):
    """Capture and OCR a new private snapshot under an existing lease."""
    if not isinstance(lease,DeviceLease) or lease.backend is not session.backend or lease.stream is None or lease.stream.closed:
        _fail('DEVICE_LEASE_REQUIRED')
    if not isinstance(node,str) or not os.path.isabs(node) or not os.path.isfile(node):
        _fail('VISUAL_OCR_CONFIG_INVALID')
    base=_safe_dir(output);nonce=uuid.uuid4().hex
    capture=capture_locked(session,base/nonce/'capture',lease)
    remaining=max(1,min(120000,int(session.budget.timeout()*1000)))
    payload={'imagePath':capture['imagePath'],'outputDir':str(base/nonce/'ocr'),'engine':engine,'language':language,'timeoutMs':remaining}
    try:
        child=subprocess.Popen([node,str(_PROJECT/'src/native-visual-ocr-cli.js')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    except OSError:
        _fail('VISUAL_OCR_UNAVAILABLE')
    data=json.dumps(payload,ensure_ascii=False).encode('utf8');first=True
    completed=False
    try:
        while True:
            session.budget.check()
            try:
                stdout,stderr=child.communicate(input=data if first else None,timeout=min(.1,session.budget.timeout()))
                break
            except subprocess.TimeoutExpired:
                first=False
        if child.returncode or len(stdout)>262144:
            _fail('VISUAL_OCR_FAILED')
        try: observation=json.loads(stdout)
        except (ValueError,UnicodeError): _fail('VISUAL_OCR_INVALID')
        if observation.get('imageSha256')!=capture['imageSha256'] or observation.get('width')!=capture['width'] or observation.get('height')!=capture['height']:
            _fail('VISUAL_IMAGE_CHANGED')
        if isinstance(engine,dict) and engine.get('type')=='tesseract' and engine.get('nativeText') is True:
            if 'nativeTextEvidence' not in observation:_fail('VISUAL_NATIVE_TEXT_UNVERIFIED')
            _native_contract(observation)
        session.budget.check()
        completed=True
        return {**observation,'capturedAt':capture['capturedAt'],'artifactVerification':capture['artifactVerification'], '_imagePath':capture['imagePath']}
    finally:
        if not completed:
            try: os.killpg(child.pid,signal.SIGKILL)
            except (ProcessLookupError, PermissionError): pass
        if child.poll() is None: child.kill()
        child.wait()

def unchanged_locked(session, lease, output, observation):
    """Reject if any pixel or device identity changed after OCR, before action."""
    after=capture_locked(session,Path(output)/uuid.uuid4().hex,lease)
    if after['imageSha256']!=observation['imageSha256'] or after['width']!=observation['width'] or after['height']!=observation['height']:
        _fail('VISUAL_FRAME_CHANGED')
    session.budget.check()
    return after
