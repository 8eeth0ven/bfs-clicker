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

def region_text(observation, region, confidence=.6):
    """Only fully contained words enter a result region, never crossing it."""
    region=_region(region); width,height=observation['width'],observation['height']
    # Match the approved screenshot masks: fractional normalized edges describe
    # whole pixels rounded outward, not a stricter subpixel extraction window.
    left=math.floor(region['x']*width); top=math.floor(region['y']*height)
    right=math.ceil((region['x']+region['width'])*width)
    bottom=math.ceil((region['y']+region['height'])*height)
    words=[]
    for token in observation['tokens']:
        box=token['bounds'];x,y,w,h=(box[k] for k in ('x','y','width','height'))
        if token['confidence']>=confidence and w>0 and h>0 and x>=left and y>=top and x+w<=right and y+h<=bottom:
            words.append(token['text'])
    return ' '.join(words)

def ground_anchor(observation, text, expected=None, confidence=.6):
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
