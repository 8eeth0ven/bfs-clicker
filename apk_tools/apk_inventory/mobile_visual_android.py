"""Explicit opt-in Android 16 visual workflow (fixed choices and one OCR output).

This module intentionally does not assert the semantics of a same-UID window.
The private recipe and helper binary are trusted local configuration.
"""
from __future__ import annotations
import argparse, hashlib, json, math, os, re, select, shlex, signal, subprocess, sys, time, uuid
from pathlib import Path
from .mobile_ui import AdbBackend, DeviceLease, MobileError, MobileSession, atomic_json, digest, read_json
from . import android_unicode
from .mobile_visual_workflow import _region, ground_anchor, observe_locked, region_text, unchanged_locked

NAME=re.compile(r'[A-Za-z][A-Za-z0-9_]{0,63}')
PROJECT=Path(__file__).resolve().parents[2]
PIXEL_JS="""import {visualPixelFingerprint} from './src/visual-pixels.js';let s='';for await(const x of process.stdin)s+=x;const a=JSON.parse(s);process.stdout.write(JSON.stringify(visualPixelFingerprint(a.path,{masks:a.masks})));"""
GAPS=['same_uid_overlay_or_handler_semantics_not_proven','point_and_window_can_change_between_checks','result_region_masked_not_layout_verified','ocr_result_is_not_business_outcome','network_scope_not_enforced']

def fail(code,status='blocked'): raise MobileError(code,status)
def config_contract(session, definition, learning):
 c=session.config.get('nativeVisualWorkflow')
 required={'enabled','node','helperJar','helperSha256','allowedWorkflows','approvedDefinitions'}
 if not isinstance(c,dict) or not required<=set(c) or set(c)-required-{'ocr'} or c['enabled'] is not True or not isinstance(c['allowedWorkflows'],list) or definition['id'] not in c['allowedWorkflows']: fail('VISUAL_WORKFLOW_NOT_APPROVED')
 ocr=c.get('ocr',{'engine':{'type':'tesseract'},'language':'eng'})
 if not isinstance(ocr,dict) or set(ocr)!={'engine','language'} or not isinstance(ocr['engine'],dict) or ocr['engine'].get('type') not in ('tesseract','vision') or not isinstance(ocr['language'],str) or not re.fullmatch(r'\w+(?:\+\w+)*',ocr['language']): fail('VISUAL_OCR_CONFIG_INVALID')
 approved=c['approvedDefinitions']
 if not isinstance(approved,dict) or not isinstance(approved.get(definition['id']),str) or not os.path.isabs(approved[definition['id']]): fail('VISUAL_DEFINITION_NOT_APPROVED')
 try: authorized=definition_contract(read_json(approved[definition['id']],524288))
 except (MobileError,OSError,ValueError,TypeError): fail('VISUAL_DEFINITION_NOT_APPROVED')
 if digest(authorized)!=digest(definition): fail('VISUAL_DEFINITION_NOT_APPROVED')
 if not isinstance(c['node'],str) or not os.path.isabs(c['node']) or not os.path.isfile(c['node']): fail('VISUAL_OCR_CONFIG_INVALID')
 h=Path(c['helperJar']) if isinstance(c.get('helperJar'),str) else Path('')
 if not h.is_absolute() or h.is_symlink() or not h.is_file() or h.stat().st_size>4*1024*1024 or not re.fullmatch(r'[a-f0-9]{64}',str(c['helperSha256'])) or hashlib.sha256(h.read_bytes()).hexdigest()!=c['helperSha256']: fail('VISUAL_HELPER_UNVERIFIED')
 if not isinstance(session.backend,AdbBackend) or not session.backend.device or session.source['kind']!='apk': fail('VISUAL_PLATFORM_UNSUPPORTED')
 if session.config.get('expectedArtifact') is None: fail('VISUAL_ARTIFACT_REQUIRED')
 if definition['effect']=='write':
  from .mobile_workflows import approve_workflow
  approve_workflow(session,definition,learning)
 return c

def definition_contract(value):
 if isinstance(value,dict) and value.get('mode')=='text-replace': return text_definition_contract(value)
 keys={'kind','schemaVersion','id','name','effect','activity','inputName','choices','resultRegion','resultPrefix'}
 if not isinstance(value,dict) or set(value)!=keys or value['kind']!='native-visual-workflow' or value['schemaVersion']!=1 or not isinstance(value['id'],str) or not NAME.fullmatch(value['id']) or value['effect'] not in ('read','write') or not isinstance(value['name'],str) or not 1<=len(value['name'])<=120 or not isinstance(value['inputName'],str) or not NAME.fullmatch(value['inputName']): fail('VISUAL_DEFINITION_INVALID')
 if not isinstance(value['activity'],str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.$]{0,255}',value['activity']): fail('VISUAL_DEFINITION_INVALID')
 choices=value['choices']
 if not isinstance(choices,dict) or not 2<=len(choices)<=12: fail('VISUAL_CHOICES_INVALID')
 for k,v in choices.items():
  if not isinstance(k,str) or k=='_pixels' or not re.fullmatch(r'[A-Za-z0-9_]{1,32}',k) or not isinstance(v,dict) or set(v)!={'anchor','expected'} or any(not isinstance(v[x],str) or not re.fullmatch(r'[A-Za-z0-9_]{1,32}',v[x]) for x in v): fail('VISUAL_CHOICES_INVALID')
 if len({v['anchor'] for v in choices.values()})!=len(choices) or len({v['expected'] for v in choices.values()})!=len(choices): fail('VISUAL_CHOICES_INVALID')
 _region(value['resultRegion'])
 if not isinstance(value['resultPrefix'],str) or not re.fullmatch(r'[A-Za-z0-9_]{1,32}',value['resultPrefix']): fail('VISUAL_DEFINITION_INVALID')
 return value

def text_definition_contract(value):
 keys={'kind','schemaVersion','mode','id','name','effect','activity','inputName','inputSchema','focusAnchor','submitAnchor','valueRegion','resultRegion','resultPrefix'}
 if not isinstance(value,dict) or set(value)!=keys or value.get('kind')!='native-visual-workflow' or value.get('schemaVersion')!=1 or value.get('mode')!='text-replace' or value.get('effect') not in ('read','write') or not isinstance(value.get('id'),str) or not NAME.fullmatch(value['id']) or not isinstance(value.get('inputName'),str) or not NAME.fullmatch(value['inputName']) or not isinstance(value.get('name'),str) or not 1<=len(value['name'])<=120 or not isinstance(value.get('activity'),str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.$]{0,255}',value['activity']): fail('VISUAL_DEFINITION_INVALID')
 for key in ('focusAnchor','submitAnchor','resultPrefix'):
  if not isinstance(value.get(key),str) or not re.fullmatch(r'[A-Za-z0-9_]{1,32}',value[key]): fail('VISUAL_DEFINITION_INVALID')
 if value['focusAnchor']==value['submitAnchor']: fail('VISUAL_ANCHOR_AMBIGUOUS')
 spec=value['inputSchema']
 if not isinstance(spec,dict) or set(spec)!={'type','minLength','maxLength','pattern'} or spec['type']!='string' or not isinstance(spec['minLength'],int) or isinstance(spec['minLength'],bool) or not isinstance(spec['maxLength'],int) or isinstance(spec['maxLength'],bool) or not 1<=spec['minLength']<=spec['maxLength']<=128: fail('VISUAL_TEXT_SCHEMA_INVALID')
 from .mobile_workflows import pattern
 pattern(spec['pattern'])
 a=_region(value['valueRegion']);b=_region(value['resultRegion'])
 if a['x']<b['x']+b['width'] and a['x']+a['width']>b['x'] and a['y']<b['y']+b['height'] and a['y']+a['height']>b['y']: fail('VISUAL_REGION_OVERLAP')
 return value

def _text_value(definition,inputs):
 from .mobile_workflows import pattern
 name=definition['inputName'];value=inputs.get(name) if isinstance(inputs,dict) and set(inputs)=={name} else None;spec=definition['inputSchema']
 if not isinstance(value,str) or not spec['minLength']<=len(value)<=spec['maxLength'] or '\0' in value or not pattern(spec['pattern']).fullmatch(value): fail('VISUAL_TEXT_INPUT_INVALID')
 try: value.encode('utf8')
 except UnicodeError: fail('VISUAL_TEXT_INPUT_INVALID')
 return value

def _text_observe(session,lease,c):
 ocr=c.get('ocr',{'engine':{'type':'tesseract'},'language':'eng'})
 return observe_locked(session,lease,session.output/'visual-private',node=c['node'],engine=ocr['engine'],language=ocr['language'])

def _masked(node, session, observation, region):
 payload=json.dumps({'path':observation['_imagePath'],'masks':region if isinstance(region,list) else [region]}).encode()
 child=None;completed=False
 try:
  child=subprocess.Popen([node,'--input-type=module','-e',PIXEL_JS],cwd=PROJECT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
  child.stdin.write(payload);child.stdin.close();blocks=[];size=0
  while True:
   session.budget.check()
   ready,_,_=select.select([child.stdout],[],[],min(.1,session.budget.timeout()))
   if not ready: continue
   block=os.read(child.stdout.fileno(),4097-size)
   if not block: break
   size+=len(block)
   if size>4096: fail('VISUAL_PIXELS_UNAVAILABLE')
   blocks.append(block)
  if child.wait(timeout=session.budget.timeout())!=0: fail('VISUAL_PIXELS_UNAVAILABLE')
  value=json.loads(b''.join(blocks))
  if value['width']!=observation['width'] or value['height']!=observation['height'] or not re.fullmatch(r'[a-f0-9]{64}',value['sha256']): raise ValueError()
  session.budget.check();completed=True
  return value['sha256']
 except (OSError,subprocess.SubprocessError,ValueError,KeyError,TypeError): fail('VISUAL_PIXELS_UNAVAILABLE')
 finally:
  if child is not None:
   if not completed:
    try: os.killpg(child.pid,signal.SIGKILL)
    except (ProcessLookupError,PermissionError): pass
   if child.poll() is None: child.kill()
   child.wait()
   for stream in (child.stdin,child.stdout):
    if stream is not None and not stream.closed:
     try: stream.close()
     except OSError: pass

def _identity(backend):
 if backend.shell('getprop','ro.build.version.sdk')!='36': fail('VISUAL_ANDROID_API_UNSUPPORTED')
 lines=backend.shell('cmd','package','list','packages','-U',backend.app_id).splitlines()
 match=[re.fullmatch(r'package:'+re.escape(backend.app_id)+r' uid:(\d+)',line) for line in lines]
 match=[m for m in match if m]
 if len(match)!=1 or int(match[0].group(1))<10000: fail('VISUAL_UID_UNVERIFIED')
 backend.verify_artifact();backend.foreground()
 if backend.artifact_verification.get('status')!='verified': fail('VISUAL_ARTIFACT_REQUIRED')
 return int(match[0].group(1))

def _window(backend, definition, uid, width, height, x, y):
 data=backend.shell('dumpsys','input')
 activity=backend.app_id+'/'+definition['activity']
 focus=re.findall(r"displayId=0, name='([^']+)'",data[data.find('FocusedWindows:'):data.find('FocusRequests:')])
 if len(focus)!=1 or not focus[0].endswith(' '+activity): fail('VISUAL_WINDOW_FOCUS_CHANGED')
 start=data.find('  Display: 0\n');end=data.find('\n  Display:',start+1)
 if start<0: fail('VISUAL_WINDOW_UNVERIFIED')
 section=data[start:end if end>=0 else len(data)]
 if f'logicalSize={width}x{height}' not in section or 'transform (ROT_0) (IDENTITY)' not in section.split('    Windows:')[0]: fail('VISUAL_COORDINATES_UNVERIFIED')
 rows=re.findall(r'^\s+\d+: name=(.*)$',section,re.M)
 if not rows: fail('VISUAL_WINDOW_UNVERIFIED')
 for row in rows:
  m=re.fullmatch(r'(.+?), id=(\d+), displayId=(\d+), inputConfig=(.*?), alpha=([^,]+), frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\], globalScale=([^,]+), applicationInfo.name=(.*?), applicationInfo.token=(.*?), touchableRegion=(.*?), ownerPid=(\d+), ownerUid=(\d+), dispatchingTimeout=(\d+)ms, token=(0x[0-9a-f]+), touchOcclusionMode=([A-Z_]+)(?:,.*)?',row)
  if not m: fail('VISUAL_WINDOW_FORMAT_UNSUPPORTED')
  name,_,display,flags,_,left,top,right,bottom,scale,_,_,touch,_,owner,_,token,_=m.groups(); flags=set(flags.split(' | '))
  if display!='0': fail('VISUAL_WINDOW_UNVERIFIED')
  if 'NOT_VISIBLE' in flags or 'SPY' in flags and 'TRUSTED_OVERLAY' in flags: continue
  rectangles=re.findall(r'\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]',touch)
  if touch!='<empty>' and not rectangles: fail('VISUAL_WINDOW_FORMAT_UNSUPPORTED')
  contains=any(int(a)<=x<int(c) and int(b)<=y<int(d) for a,b,c,d in rectangles)
  # Non-touchable visible overlays can affect dispatch. Reject if their frame covers the point.
  intersects=int(left)<=x<int(right) and int(top)<=y<int(bottom)
  if not contains and not intersects: continue
  if name.endswith(' '+activity) and int(owner)==uid and flags=={'0x0'} and scale=='1' and [int(left),int(top),int(right),int(bottom)]==[0,0,width,height] and contains:
   return token
  fail('VISUAL_POINT_OCCLUDED')
 fail('VISUAL_WINDOW_UNVERIFIED')

def _contains(region,x,y): return region['x']<=x<region['x']+region['width'] and region['y']<=y<region['y']+region['height']

def _remove_helper(backend, remote):
 """Cleanup an owned random helper even after the workflow budget expires."""
 if not re.fullmatch(r'/data/local/tmp/bfs-visual-[a-f0-9]{32}\.jar',remote): return False
 child=None;finished=False
 try:
  child=subprocess.Popen([backend.executable,'-s',backend.device,'shell',shlex.join(['rm','-f',remote])],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
  finished=child.wait(timeout=3)==0
  return finished
 except (OSError,subprocess.SubprocessError): return False
 finally:
  if child is not None:
   if not finished:
    try: os.killpg(child.pid,signal.SIGKILL)
    except (ProcessLookupError,PermissionError): pass
   if child.poll() is None: child.kill()
   child.wait()

def _pixel_box(region,width,height):
 return (math.floor(region['x']*width),math.floor(region['y']*height),math.ceil((region['x']+region['width'])*width),math.ceil((region['y']+region['height'])*height))

def _intersects(a,b): return a[0]<b[2] and a[2]>b[0] and a[1]<b[3] and a[3]>b[1]

def _text_layout(session,c,definition,observation,contracts):
 width,height=observation['width'],observation['height']; masks=[definition['valueRegion'],definition['resultRegion']]
 if _intersects(_pixel_box(masks[0],width,height),_pixel_box(masks[1],width,height)): fail('VISUAL_REGION_OVERLAP')
 anchors={}
 for key,name in (('focus',definition['focusAnchor']),('submit',definition['submitAnchor'])):
  anchor=ground_anchor(observation,name,contracts.get(key));box=anchor['normalized']
  ab=(round(box['x']*width),round(box['y']*height),round((box['x']+box['width'])*width),round((box['y']+box['height'])*height))
  if any(_intersects(ab,_pixel_box(mask,width,height)) for mask in masks): fail('VISUAL_MASK_OVERLAPS_ANCHOR')
  anchors[key]=anchor
 fingerprint=_masked(c['node'],session,observation,masks)
 if contracts.get('_pixels') not in (None,fingerprint): fail('VISUAL_LAYOUT_CHANGED')
 return anchors,fingerprint

def _text_point(anchor):
 box=anchor['normalized'];return min(anchor['width']-1,int((box['x']+box['width']/2)*anchor['width'])),min(anchor['height']-1,int((box['y']+box['height']/2)*anchor['height']))

def _text_tap(session,lease,c,definition,uid,observation,anchor,token):
 backend=session.backend;px,py=_text_point(anchor);remote='/data/local/tmp/bfs-visual-'+uuid.uuid4().hex+'.jar'
 try:
  backend.command(['-s',backend.device,'push',c['helperJar'],remote])
  if backend.shell('sha256sum',remote).split()!=[c['helperSha256'],remote]: fail('VISUAL_HELPER_UNVERIFIED')
  if _identity(backend)!=uid or _window(backend,definition,uid,observation['width'],observation['height'],px,py)!=token: fail('VISUAL_WINDOW_CHANGED')
  unchanged_locked(session,lease,session.output/'visual-private',observation)
  session.budget.action();atomic_json(session.output/'write-intent.json',{'effect':definition['effect'],'status':'unknown','automaticRetry':False});session._visual_dispatched=True
  if backend.shell('env','CLASSPATH='+remote,'app_process','/system/bin','TargetTap',str(uid),str(px),str(py))!='targeted_tap_complete': fail('VISUAL_DISPATCH_UNKNOWN','partial')
 finally:
  if not _remove_helper(backend,remote): session._visual_cleanup_gap=True

def _text_run(session,lease,c,definition,inputs,contracts):
 text=_text_value(definition,inputs)
 backend=session.backend
 if backend.unicode_input is None: fail('VISUAL_UNICODE_IME_REQUIRED')
 uid=_identity(backend);android_unicode.preflight(backend)
 before=_text_observe(session,lease,c)
 anchors,fingerprint=_text_layout(session,c,definition,before,contracts);focus=anchors['focus'];submit=anchors['submit'];px,py=_text_point(focus)
 token=_window(backend,definition,uid,before['width'],before['height'],px,py)
 _text_tap(session,lease,c,definition,uid,before,focus,token)
 session.budget.check();time.sleep(.5)
 if _identity(backend)!=uid or _window(backend,definition,uid,before['width'],before['height'],px,py)!=token: fail('VISUAL_WINDOW_CHANGED')
 focused=_text_observe(session,lease,c);focused_anchors,focused_fingerprint=_text_layout(session,c,definition,focused,anchors|{'_pixels':fingerprint})
 if focused_fingerprint!=fingerprint: fail('VISUAL_LAYOUT_CHANGED')
 android_unicode.preflight(backend)
 if _identity(backend)!=uid or _window(backend,definition,uid,focused['width'],focused['height'],px,py)!=token: fail('VISUAL_WINDOW_CHANGED')
 unchanged_locked(session,lease,session.output/'visual-private',focused)
 session.budget.action();atomic_json(session.output/'write-intent.json',{'effect':definition['effect'],'status':'unknown','automaticRetry':False});session._visual_dispatched=True
 android_unicode.commit(backend,text,True)
 session.budget.check();time.sleep(.5)
 if _identity(backend)!=uid: fail('VISUAL_WINDOW_CHANGED')
 filled=_text_observe(session,lease,c);filled_anchors,filled_fingerprint=_text_layout(session,c,definition,filled,anchors|{'_pixels':fingerprint})
 if filled_fingerprint!=fingerprint or region_text(filled,definition['valueRegion'])!=text: fail('VISUAL_INPUT_NOT_VERIFIED')
 # Result baseline must be from the same verified-input screenshot, so a
 # change caused merely by typing cannot masquerade as submit evidence.
 old=region_text(filled,definition['resultRegion'])
 sx,sy=_text_point(filled_anchors['submit']);submit_token=_window(backend,definition,uid,filled['width'],filled['height'],sx,sy)
 if submit_token!=token: fail('VISUAL_WINDOW_CHANGED')
 # This is the screenshot in which the input value and submit anchor were both
 # checked. _text_tap repeats the whole-frame check immediately before dispatch.
 _text_tap(session,lease,c,definition,uid,filled,filled_anchors['submit'],submit_token)
 session.budget.check();time.sleep(.5)
 if _identity(backend)!=uid or _window(backend,definition,uid,filled['width'],filled['height'],sx,sy)!=token: fail('VISUAL_WINDOW_CHANGED')
 after=_text_observe(session,lease,c);_,after_fingerprint=_text_layout(session,c,definition,after,anchors|{'_pixels':fingerprint})
 result=region_text(after,definition['resultRegion'])
 if after_fingerprint!=fingerprint or result==old or not result.startswith(definition['resultPrefix']) or text not in result: fail('VISUAL_RESULT_NOT_VERIFIED')
 unchanged_locked(session,lease,session.output/'visual-private',after)
 contracts.update(anchors);contracts['_pixels']=fingerprint
 return {'text':result}

def _run(session,lease,c,definition,choice,contracts):
 backend=session.backend;uid=_identity(backend);obs=observe_locked(session,lease,session.output/'visual-private',node=c['node'],engine={'type':'tesseract'})
 spec=definition['choices'][choice]; anchor=ground_anchor(obs,spec['anchor'],contracts.get(choice));box=anchor['normalized'];region=definition['resultRegion'];x=box['x']+box['width']/2;y=box['y']+box['height']/2
 # The fingerprint rounds masks outward to whole pixels. Enforce the same
 # geometry here; subpixel-separated rectangles can still cover an anchor.
 ax0=round(box['x']*obs['width']);ay0=round(box['y']*obs['height']);ax1=round((box['x']+box['width'])*obs['width']);ay1=round((box['y']+box['height'])*obs['height'])
 mx0=math.floor(region['x']*obs['width']);my0=math.floor(region['y']*obs['height']);mx1=math.ceil((region['x']+region['width'])*obs['width']);my1=math.ceil((region['y']+region['height'])*obs['height'])
 if ax0<mx1 and ax1>mx0 and ay0<my1 and ay1>my0: fail('VISUAL_MASK_OVERLAPS_ANCHOR')
 fingerprint=_masked(c['node'],session,obs,region)
 if contracts.get('_pixels') not in (None,fingerprint): fail('VISUAL_LAYOUT_CHANGED')
 old=region_text(obs,region);px=min(obs['width']-1,int(x*obs['width']));py=min(obs['height']-1,int(y*obs['height']))
 token=_window(backend,definition,uid,obs['width'],obs['height'],px,py)
 unchanged_locked(session,lease,session.output/'visual-private',obs)
 if _identity(backend)!=uid or _window(backend,definition,uid,obs['width'],obs['height'],px,py)!=token: fail('VISUAL_WINDOW_CHANGED')
 remote='/data/local/tmp/bfs-visual-'+uuid.uuid4().hex+'.jar';attempted=False
 try:
  backend.command(['-s',backend.device,'push',c['helperJar'],remote])
  if backend.shell('sha256sum',remote).split()!=[c['helperSha256'],remote]: fail('VISUAL_HELPER_UNVERIFIED')
  if _identity(backend)!=uid or _window(backend,definition,uid,obs['width'],obs['height'],px,py)!=token: fail('VISUAL_WINDOW_CHANGED')
  # Recheck pixels after helper deployment and immediately before dispatch.
  unchanged_locked(session,lease,session.output/'visual-private',obs)
  session.budget.action();atomic_json(session.output/'write-intent.json',{'effect':definition['effect'],'status':'unknown','automaticRetry':False});attempted=True;session._visual_dispatched=True
  response=backend.shell('env','CLASSPATH='+remote,'app_process','/system/bin','TargetTap',str(uid),str(px),str(py))
  if response!='targeted_tap_complete': fail('VISUAL_DISPATCH_UNKNOWN','partial')
  time.sleep(.5);_identity(backend)
  if _window(backend,definition,uid,obs['width'],obs['height'],px,py)!=token: fail('VISUAL_WINDOW_CHANGED')
  after=observe_locked(session,lease,session.output/'visual-private',node=c['node'],engine={'type':'tesseract'})
  if _masked(c['node'],session,after,region)!=fingerprint: fail('VISUAL_LAYOUT_CHANGED')
  result=region_text(after,region)
  if result==old or not result.startswith(definition['resultPrefix']) or spec['expected'] not in result.split(): fail('VISUAL_RESULT_NOT_VERIFIED')
  contracts[choice]=anchor;contracts['_pixels']=fingerprint
  return {'text':result}
 except Exception as exc:
  if attempted: exc.writeOutcome={'status':'unknown','automaticRetry':False}
  raise
 finally:
  if not _remove_helper(backend,remote): session._visual_cleanup_gap=True

def learn(session,definition,samples):
 definition=definition_contract(definition);c=config_contract(session,definition,True)
 text_mode=definition.get('mode')=='text-replace'
 if not isinstance(samples,list) or len(samples)!=2 or any(not isinstance(s,dict) or set(s)!={definition['inputName']} or (not isinstance(s[definition['inputName']],str) if text_mode else s[definition['inputName']] not in definition['choices']) for s in samples) or samples[0]==samples[1]: fail('VISUAL_TWO_DISTINCT_SAMPLES_REQUIRED')
 if text_mode:
  for sample in samples: _text_value(definition,sample)
 contracts={};outputs=[]
 with DeviceLease(session.backend) as lease:
  for sample in samples: outputs.append(_text_run(session,lease,c,definition,sample,contracts) if text_mode else _run(session,lease,c,definition,sample[definition['inputName']],contracts))
 if len({digest(o) for o in outputs})!=2: fail('VISUAL_TWO_DISTINCT_RESULTS_REQUIRED')
 capability='mobile_visual_'+digest([session.source['id'],definition['id']]);recipe={'schemaVersion':1,'recipeType':'visual_workflow','sourceId':session.source['id'],'identity':session.identity,'capabilityId':capability,'definition':definition,'controlContracts':contracts,'learningEvidence':{'sampleCount':2,'distinctInputSamples':2,'distinctResultSamples':2}};recipe['revision']=digest(recipe)
 schema={'type':'object','properties':{definition['inputName']:(dict(definition['inputSchema']) if text_mode else {'type':'string','enum':sorted(contracts.keys()-{'_pixels'})})},'required':[definition['inputName']],'additionalProperties':False}
 gaps=GAPS+(['input_region_masked_not_layout_verified','ime_receipt_not_input_proof','ocr_language_and_recognition_limit_input_domain'] if text_mode else [])
 cap={'id':capability,'name':definition['name'],'description':('可信文字锚点执行输入替换并从独立结果区域读取文字。' if text_mode else '可信锚点和限定选择执行视觉操作，并从独立结果区域读取文字。'),'kind':'mobile','inputSchema':schema,'outputSchema':{'type':'object','properties':{'text':{'type':'string'}},'additionalProperties':False},'readiness':'ready','effect':definition['effect'],'revision':recipe['revision'],'evidence':{'workflowObserved':True,'sampleCount':2,'resultVariationObserved':True},'gaps':gaps}
 session.progress['capabilities'][capability]=cap;session.progress['recipes'][capability]=recipe;session.progress['status']='completed';session.checkpoint()
 return {'ok':True,'status':'completed','capabilityId':capability,'revision':recipe['revision'],'sampleCount':2,'writeOutcome':{'status':'observed','automaticRetry':False},'gaps':gaps}

def execute(session,recipe,revision,inputs):
 if not isinstance(recipe,dict) or recipe.get('recipeType')!='visual_workflow' or recipe.get('identity')!=session.identity or recipe.get('sourceId')!=session.source['id'] or recipe.get('revision')!=revision or digest({k:v for k,v in recipe.items() if k!='revision'})!=revision: fail('VISUAL_RECIPE_REVISION_MISMATCH')
 definition=definition_contract(recipe.get('definition'));c=config_contract(session,definition,False);contracts=recipe.get('controlContracts');evidence=recipe.get('learningEvidence',{})
 text_mode=definition.get('mode')=='text-replace'
 if not isinstance(contracts,dict) or evidence!={'sampleCount':2,'distinctInputSamples':2,'distinctResultSamples':2} or not isinstance(inputs,dict) or set(inputs)!={definition['inputName']}: fail('VISUAL_RECIPE_INVALID')
 if text_mode:
  if set(contracts)!={'focus','submit','_pixels'}: fail('VISUAL_RECIPE_INVALID')
  _text_value(definition,inputs)
 elif inputs[definition['inputName']] not in contracts or inputs[definition['inputName']] not in definition['choices']: fail('VISUAL_RECIPE_INVALID')
 with DeviceLease(session.backend) as lease: output=_text_run(session,lease,c,definition,inputs,contracts) if text_mode else _run(session,lease,c,definition,inputs[definition['inputName']],contracts)
 session.progress['status']='completed';session.checkpoint()
 return {'ok':True,'status':'completed','capabilityId':recipe['capabilityId'],'revision':revision,'outputs':output,'executionObserved':True,'writeOutcome':{'status':'observed','automaticRetry':False},'gaps':GAPS+(['input_region_masked_not_layout_verified','ime_receipt_not_input_proof','ocr_language_and_recognition_limit_input_domain'] if text_mode else [])}

def main():
 p=argparse.ArgumentParser();p.add_argument('--operation',choices=['learn','execute','workflow-learn','workflow-execute'],required=True);p.add_argument('--config',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--definition',type=Path);p.add_argument('--workflow',type=Path);p.add_argument('--samples',type=Path);p.add_argument('--recipe',type=Path);p.add_argument('--capability');p.add_argument('--revision');p.add_argument('--inputs',type=Path);args=p.parse_args();session=None;previous={}
 try:
  if args.output.is_symlink(): fail('OUTPUT_SYMLINK_REJECTED')
  session=MobileSession(read_json(args.config),args.output)
  for sig in (signal.SIGTERM,signal.SIGINT):
   previous[sig]=signal.getsignal(sig);signal.signal(sig,lambda *_:setattr(session.budget,'cancelled',True))
  if args.operation in ('learn','workflow-learn'):
   result=learn(session,read_json(args.workflow or args.definition),read_json(args.samples,65536))
  else:
   recipes=read_json(args.recipe)
   recipe=recipes if isinstance(recipes,dict) and recipes.get('recipeType')=='visual_workflow' else recipes.get(args.capability) if isinstance(recipes,dict) else None
   if args.inputs is not None: inputs=read_json(args.inputs,65536)
   else:
    raw=sys.stdin.buffer.read(65537)
    if len(raw)>65536: fail('INPUT_LIMIT')
    payload=json.loads(raw) if raw.strip() else {};inputs=payload.get('inputs',{}) if isinstance(payload,dict) else None
   result=execute(session,recipe,args.revision,inputs)
 except (MobileError,OSError,ValueError,TypeError,KeyError,AttributeError) as exc:
  result={'ok':False,'status':getattr(exc,'status','failed'),'error':{'code':getattr(exc,'code','VISUAL_WORKFLOW_FAILED')},'writeOutcome':getattr(exc,'writeOutcome',{'status':'unknown' if session is not None and getattr(session,'_visual_dispatched',False) else 'not_started','automaticRetry':False})}
  if session is not None:
   session.progress['status']=result['status'];session.progress['gaps']=list(dict.fromkeys(session.progress['gaps']+[result['error']['code']]))
 finally:
  for sig,handler in previous.items(): signal.signal(sig,handler)
 try:
  if session is not None:
   if getattr(session,'_visual_cleanup_gap',False):
    result['gaps']=list(dict.fromkeys(result.get('gaps',[])+['visual_helper_cleanup_failed']))
    session.progress['gaps']=list(dict.fromkeys(session.progress['gaps']+['visual_helper_cleanup_failed']))
   result['artifactVerification']=dict(session.backend.artifact_verification)
   result['appArtifactVerified']=session.backend.artifact_verification['status']=='verified'
   session.checkpoint()
  atomic_json(args.output/'result.json',result)
 except (OSError,MobileError,ValueError,TypeError):
  result={'ok':False,'status':'failed','error':{'code':'OUTPUT_FAILED'},'writeOutcome':{'status':'unknown' if session is not None and getattr(session,'_visual_dispatched',False) else 'not_started','automaticRetry':False}}
  try: atomic_json(args.output/'result.json',result)
  except (OSError,MobileError,ValueError,TypeError): pass
 print(json.dumps(result,ensure_ascii=False,allow_nan=False));return 0 if session is not None else 2
if __name__=='__main__': sys.exit(main())
