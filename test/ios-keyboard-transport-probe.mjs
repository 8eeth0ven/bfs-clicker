// Owned-fixture diagnostic only. It grants no production workflow or MCP readiness.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {observeImage} from '../src/visual-observation.js';

export async function probeOnscreenKeyboard({output,project,python,run,httpJson,proxyPort,sessionId,rect,tap,appId,definition,text='alpha'}){
 assert(['alpha','Ab7z'].includes(text));
 const prefix='/session/'+sessionId,record={kind:'onscreen_keyboard_pointer_diagnostic',mcpAcceptance:false,fixtureChanged:false,keyPresses:[],expected:text};
 const foreground=async()=>{const reply=await httpJson('POST',prefix+'/execute/sync',{script:'mobile: activeAppInfo',args:[]},{port:proxyPort});assert.equal(reply.value?.bundleId,appId);};
 const source=async(label,keyLabel,control)=>{
  await foreground();const raw=(await httpJson('GET',prefix+'/source',undefined,{port:proxyPort})).value;
  assert.equal(typeof raw,'string');assert(Buffer.byteLength(raw)<=2*1024*1024);
  const file=path.join(output,label+'.xml');await writeFile(file,raw,{mode:0o600});
  const args=[path.join(project,'test/ios-keyboard-inspect.py'),'--source',file,'--width',String(rect.width),'--height',String(rect.height),'--app-id',appId];
  if(keyLabel!==undefined)args.push('--key-label',keyLabel);
  if(control!==undefined)args.push('--control',control);
  return JSON.parse((await run(python,args)).stdout);
 };
 await foreground();await tap(.22,.15);await delay(500);
 const sequence=text==='alpha'?Array.from(text,keyLabel=>({keyLabel})):[{control:'shift'},{keyLabel:'A'},{keyLabel:'b'},{control:'numbers'},{keyLabel:'7'},{control:'letters'},{keyLabel:'z'}];
 record.plannedSequence=sequence;
 for(const [index,target]of sequence.entries()){
  const before=await source('probe-key-'+index+'-before',target.keyLabel,target.control),box=before.key?.rect;
  assert(before.proposal&&box&&box.width>0&&box.height>0);
  assert(box.x>=0&&box.y>=0&&box.x+box.width<=rect.width&&box.y+box.height<=rect.height);
  await foreground();await tap((box.x+box.width/2)/rect.width,(box.y+box.height/2)/rect.height);
  record.keyPresses.push({index,...target,actual:before.key,rect:box,uiActionRetried:false});await delay(250);
 }
 const after=await source('probe-after-alpha');record.keyboardVisibleAfter=after.proposal!==null;
 const screenshot=(await httpJson('GET',prefix+'/screenshot',undefined,{port:proxyPort})).value;
 assert.equal(typeof screenshot,'string');assert(screenshot.length<=24*1024*1024);
 const imagePath=path.join(output,'probe-after-alpha.png');await writeFile(imagePath,Buffer.from(screenshot,'base64'),{mode:0o600});
 const ocr=await observeImage({imagePath,outputDir:path.join(output,'probe-ocr'),language:'eng',timeoutMs:30000,maxOutputBytes:262144});
 const code="import json,sys;from apk_inventory.mobile_visual_workflow import region_text;d=json.load(open(sys.argv[1]));print(json.dumps({'text':region_text(d,json.loads(sys.argv[2]),.6)}))";
 record.echo=JSON.parse((await run(python,['-c',code,ocr.artifactPath,JSON.stringify(definition.valueRegion)])).stdout).text;
 record.imageSha256=ocr.imageSha256;record.ocrArtifact=ocr.artifactPath;
 record.scope='single owned normal UITextField; pointer events to current AX keyboard keys; not a learned or generated MCP workflow';
 await writeFile(path.join(output,'keyboard-transport-probe.json'),JSON.stringify(record,null,2)+'\n',{mode:0o600});
 return record;
}
