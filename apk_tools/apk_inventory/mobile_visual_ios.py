"""Opt-in iOS screenshot/OCR fixed-choice workflow using an existing WDA session.

A foreground bundle and fresh screenshot do not prove window ownership, event
handler semantics, or atomicity. Those limitations are exposed in every result.
"""
from __future__ import annotations
import hashlib, json, math, os, re, select, signal, subprocess, time
from pathlib import Path
from .mobile_ui import DeviceLease, MobileError, MobileSession, WebDriverBackend, atomic_json, digest, read_json
from .mobile_visual_workflow import _region, ground_anchor, observe_locked, region_text, unchanged_locked

NAME=re.compile(r'[A-Za-z][A-Za-z0-9_]{0,63}')
PROJECT=Path(__file__).resolve().parents[2]
PIXEL_JS="""import {visualPixelFingerprint} from './src/visual-pixels.js';let s='';for await(const x of process.stdin)s+=x;const a=JSON.parse(s);process.stdout.write(JSON.stringify(visualPixelFingerprint(a.path,{masks:a.masks})));"""

GAPS=['app_artifact_not_verified','screenshot_may_include_system_ui_or_other_windows',
      'foreground_bundle_does_not_prove_tap_target_window_or_handler',
      'point_and_window_can_change_between_checks','result_region_masked_not_layout_verified',
      'ocr_result_is_not_business_outcome','network_scope_not_enforced']

def fail(code,status='blocked'): raise MobileError(code,status)

def common_definition_contract(value):
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

def definition_contract(value):
    if isinstance(value,dict) and value.get('mode')=='text-replace':
        from .mobile_visual_ios_text import definition_contract as text_definition
        return text_definition(value)
    if not isinstance(value,dict) or 'activity' in value: fail('VISUAL_DEFINITION_INVALID')
    # Validate the common bounded contract;
    # activity is not part of the iOS contract and is never persisted.
    common_definition_contract({**value,'activity':'Placeholder'})
    return value

def config_contract(session,definition,learning):
    config=session.config.get('nativeVisualWorkflow')
    if not isinstance(config,dict) or set(config)!={'enabled','node','allowedWorkflows','approvedDefinitions'} or config.get('enabled') is not True or not isinstance(config.get('allowedWorkflows'),list) or definition['id'] not in config['allowedWorkflows']:
        fail('VISUAL_WORKFLOW_NOT_APPROVED')
    approved=config.get('approvedDefinitions'); spec=approved.get(definition['id']) if isinstance(approved,dict) else None
    if not isinstance(spec,str) or not os.path.isabs(spec): fail('VISUAL_DEFINITION_NOT_APPROVED')
    try: authorized=definition_contract(read_json(spec,524288))
    except (MobileError,OSError,ValueError,TypeError): fail('VISUAL_DEFINITION_NOT_APPROVED')
    if digest(authorized)!=digest(definition): fail('VISUAL_DEFINITION_NOT_APPROVED')
    node=config.get('node')
    if not isinstance(node,str) or not os.path.isabs(node) or not os.path.isfile(node): fail('VISUAL_OCR_CONFIG_INVALID')
    if session.source['kind']!='ios' or not isinstance(session.backend,WebDriverBackend) or session.backend.platform!='ios': fail('VISUAL_PLATFORM_UNSUPPORTED')
    if definition['effect']=='write':
        from .mobile_workflows import approve_workflow
        approve_workflow(session,definition,learning)
    return config

def _geometry(backend,width,height):
    backend.foreground()
    orientation=backend.request('GET','/orientation')
    rect=backend.request('GET','/window/rect')
    if orientation!='PORTRAIT' or not isinstance(rect,dict): fail('VISUAL_COORDINATES_UNVERIFIED')
    x,y,w,h=(rect.get(k) for k in ('x','y','width','height'))
    if any(not isinstance(v,(int,float)) or isinstance(v,bool) or not math.isfinite(v) for v in (x,y,w,h)) or x!=0 or y!=0 or w<=0 or h<=0 or w>16384 or h>16384 or abs(width/w-height/h)>.03: fail('VISUAL_COORDINATES_UNVERIFIED')
    return (int(w),int(h))

def _run(session,lease,config,definition,choice,contracts):
    backend=session.backend;backend.foreground()
    obs=observe_locked(session,lease,session.output/'visual-private',node=config['node'],engine={'type':'tesseract'})
    spec=definition['choices'][choice]; anchor=ground_anchor(obs,spec['anchor'],contracts.get(choice));box=anchor['normalized'];region=definition['resultRegion']
    ax0=round(box['x']*obs['width']);ay0=round(box['y']*obs['height']);ax1=round((box['x']+box['width'])*obs['width']);ay1=round((box['y']+box['height'])*obs['height'])
    mx0=math.floor(region['x']*obs['width']);my0=math.floor(region['y']*obs['height']);mx1=math.ceil((region['x']+region['width'])*obs['width']);my1=math.ceil((region['y']+region['height'])*obs['height'])
    if ax0<mx1 and ax1>mx0 and ay0<my1 and ay1>my0: fail('VISUAL_MASK_OVERLAPS_ANCHOR')
    pixels=_masked(config['node'],session,obs,region)
    if contracts.get('_pixels') not in (None,pixels): fail('VISUAL_LAYOUT_CHANGED')
    old=region_text(obs,region);geometry=_geometry(backend,obs['width'],obs['height'])
    x=int((box['x']+box['width']/2)*geometry[0]);y=int((box['y']+box['height']/2)*geometry[1])
    if not 0<=x<geometry[0] or not 0<=y<geometry[1]: fail('VISUAL_COORDINATES_UNVERIFIED')
    unchanged_locked(session,lease,session.output/'visual-private',obs)
    if _geometry(backend,obs['width'],obs['height'])!=geometry: fail('VISUAL_COORDINATES_UNVERIFIED')
    session.budget.action();atomic_json(session.output/'write-intent.json',{'effect':definition['effect'],'status':'unknown','automaticRetry':False});session._visual_dispatched=True
    try:
        backend.request('POST','/actions',{'actions':[{'type':'pointer','id':'finger','parameters':{'pointerType':'touch'},'actions':[{'type':'pointerMove','duration':0,'x':x,'y':y,'origin':'viewport'},{'type':'pointerDown','button':0},{'type':'pointerUp','button':0}]}]})
        time.sleep(.5);backend.foreground()
        if _geometry(backend,obs['width'],obs['height'])!=geometry: fail('VISUAL_COORDINATES_UNVERIFIED')
        after=observe_locked(session,lease,session.output/'visual-private',node=config['node'],engine={'type':'tesseract'})
        if _masked(config['node'],session,after,region)!=pixels: fail('VISUAL_LAYOUT_CHANGED')
        result=region_text(after,region)
        if result==old or not result.startswith(definition['resultPrefix']) or spec['expected'] not in result.split(): fail('VISUAL_RESULT_NOT_VERIFIED')
        contracts[choice]=anchor;contracts['_pixels']=pixels
        return {'text':result}
    except Exception as exc:
        exc.writeOutcome={'status':'unknown','automaticRetry':False};raise

import argparse, json, signal, sys
def learn(session,definition,samples):
 if isinstance(definition,dict) and definition.get('mode')=='text-replace':
  from .mobile_visual_ios_text import learn as text_learn
  return text_learn(session,definition,samples)
 definition=definition_contract(definition);c=config_contract(session,definition,True)
 if not isinstance(samples,list) or len(samples)!=2 or any(not isinstance(s,dict) or set(s)!={definition['inputName']} or s[definition['inputName']] not in definition['choices'] for s in samples) or samples[0]==samples[1]: fail('VISUAL_TWO_DISTINCT_SAMPLES_REQUIRED')
 contracts={};outputs=[]
 with DeviceLease(session.backend) as lease:
  for sample in samples: outputs.append(_run(session,lease,c,definition,sample[definition['inputName']],contracts))
 if len({digest(o) for o in outputs})!=2: fail('VISUAL_TWO_DISTINCT_RESULTS_REQUIRED')
 capability='mobile_visual_'+digest([session.source['id'],definition['id']]);recipe={'schemaVersion':1,'recipeType':'ios_visual_workflow','sourceId':session.source['id'],'identity':session.identity,'capabilityId':capability,'definition':definition,'controlContracts':contracts,'learningEvidence':{'sampleCount':2,'distinctInputSamples':2,'distinctResultSamples':2}};recipe['revision']=digest(recipe)
 schema={'type':'object','properties':{definition['inputName']:{'type':'string','enum':sorted(contracts.keys()-{'_pixels'})}},'required':[definition['inputName']],'additionalProperties':False}
 cap={'id':capability,'name':definition['name'],'description':'可信锚点和限定选择执行视觉操作，并从独立结果区域读取文字。','kind':'mobile','inputSchema':schema,'outputSchema':{'type':'object','properties':{'text':{'type':'string'}},'additionalProperties':False},'readiness':'ready','effect':definition['effect'],'revision':recipe['revision'],'evidence':{'workflowObserved':True,'sampleCount':2,'resultVariationObserved':True},'gaps':GAPS}
 session.progress['capabilities'][capability]=cap;session.progress['recipes'][capability]=recipe;session.progress['status']='completed';session.checkpoint()
 return {'ok':True,'status':'completed','capabilityId':capability,'revision':recipe['revision'],'sampleCount':2,'writeOutcome':{'status':'observed','automaticRetry':False},'gaps':GAPS}

def execute(session,recipe,revision,inputs):
 if isinstance(recipe,dict) and isinstance(recipe.get('definition'),dict) and recipe['definition'].get('mode')=='text-replace':
  from .mobile_visual_ios_text import execute as text_execute
  return text_execute(session,recipe,revision,inputs)
 if not isinstance(recipe,dict) or recipe.get('recipeType')!='ios_visual_workflow' or recipe.get('identity')!=session.identity or recipe.get('sourceId')!=session.source['id'] or recipe.get('revision')!=revision or digest({k:v for k,v in recipe.items() if k!='revision'})!=revision: fail('VISUAL_RECIPE_REVISION_MISMATCH')
 definition=definition_contract(recipe.get('definition'));c=config_contract(session,definition,False);contracts=recipe.get('controlContracts');evidence=recipe.get('learningEvidence',{})
 if not isinstance(contracts,dict) or evidence!={'sampleCount':2,'distinctInputSamples':2,'distinctResultSamples':2} or not isinstance(inputs,dict) or set(inputs)!={definition['inputName']} or inputs[definition['inputName']] not in contracts or inputs[definition['inputName']] not in definition['choices']: fail('VISUAL_RECIPE_INVALID')
 with DeviceLease(session.backend) as lease: output=_run(session,lease,c,definition,inputs[definition['inputName']],contracts)
 session.progress['status']='completed';session.checkpoint()
 return {'ok':True,'status':'completed','capabilityId':recipe['capabilityId'],'revision':revision,'outputs':output,'executionObserved':True,'writeOutcome':{'status':'observed','automaticRetry':False},'gaps':GAPS}

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
   recipe=recipes if isinstance(recipes,dict) and recipes.get('recipeType')=='ios_visual_workflow' else recipes.get(args.capability) if isinstance(recipes,dict) else None
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
