import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {createSoftwareRuntime} from '../src/software-runtime.js';
import {temp} from './helpers.mjs';

// This executable is a fixture, not Python or a device: it only records dispatch
// and writes a self-contained learned contract. No ADB process can be started.
async function fixture(t,{permissions={},devicePatch={},kind='apk',includeArtifactHash=true}={}){
 const dir=temp(t),sourceId='fixture_apk',appId='com.example.fixture',sha='a'.repeat(64),inventory=path.join(dir,'inventory'),device=path.join(dir,'device.json'),marker=path.join(dir,'dispatch.jsonl'),fake=path.join(dir,'fake-python');mkdirSync(inventory);
 writeFileSync(path.join(inventory,'source.json'),JSON.stringify({format:'endpoint-inventory',schema_version:'1.1',kind,source_id:sourceId,inventory:'endpoints.json',app:kind==='apk'?{package_name:appId,...(includeArtifactHash?{apk_sha256:sha}:{}),artifact_type:'apk',version_name:'1'}:{package_name:appId,bundle_id:appId,artifact_sha256:sha,artifact_type:'app',version_name:'1'}}));writeFileSync(path.join(inventory,'endpoints.json'),'[]');
 const deviceConfig={source:{id:sourceId,kind:'apk'},backend:{type:'adb',appId,deviceId:'fixture-device',adb:'/does/not/exist'},expectedArtifact:{kind:'apk',sha256:sha},nativeVisualWorkflow:{enabled:true,allowedWorkflows:['lookup'],approvedDefinitions:{lookup:path.join(dir,'approved-spec.json')}},...devicePatch};
 writeFileSync(device,JSON.stringify(deviceConfig));
 const fakeCode=`#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2),marker=${JSON.stringify(marker)},get=k=>args[args.indexOf(k)+1];let stdin='';for await(const chunk of process.stdin)stdin+=chunk;fs.appendFileSync(marker,JSON.stringify({args,stdin:JSON.parse(stdin||'{}')})+'\\n');const dir=get('--output');fs.mkdirSync(dir,{recursive:true});if(get('--operation')==='workflow-learn'){const definition=JSON.parse(fs.readFileSync(get('--workflow'))),id='fixture_visual_cap',revision='b'.repeat(64),recipe={schemaVersion:1,recipeType:${JSON.stringify(kind==='ios'?'ios_visual_workflow':'visual_workflow')},sourceId:${JSON.stringify(sourceId)},capabilityId:id,revision,definition};const cap={id,revision,kind:'mobile',name:'Fixture lookup',description:'fixture only',effect:definition.effect,readiness:'ready',inputSchema:definition.inputSchema,gaps:[]};fs.writeFileSync(dir+'/manifest.json',JSON.stringify({schemaVersion:1,source:{id:${JSON.stringify(sourceId)},kind:${JSON.stringify(kind)},revision:'c'.repeat(64),gaps:[]},capabilities:[cap]}));fs.writeFileSync(dir+'/recipes.json',JSON.stringify({[id]:recipe}));}fs.writeFileSync(dir+'/result.json',JSON.stringify({ok:true,status:'completed',fixture:true,outputs:{text:'fixture text'}}));`;
 writeFileSync(fake,fakeCode,{mode:0o700});const runtime=createSoftwareRuntime({outputRoot:path.join(dir,'out'),artifactRoots:[dir],python:fake,devices:{test:device},workflowPermissions:{[sourceId]:permissions}});
 const built=await runtime.compile({sourceId,kind,inventoryPath:inventory,deviceName:'test'});
 const definition={schemaVersion:1,kind:'native-visual-workflow',id:'lookup',effect:'read',inputSchema:{type:'object',properties:{choice:{type:'string',enum:['first','second']}},required:['choice'],additionalProperties:false},steps:[]};
 const spec=path.join(dir,'spec.json'),approvedSpec=path.join(dir,'approved-spec.json');writeFileSync(spec,JSON.stringify(definition));writeFileSync(approvedSpec,JSON.stringify(definition));
 const bind=()=>{const outputDir=path.join(dir,'bind-'+Math.random().toString(36).slice(2));mkdirSync(outputDir);return runtime.bindWorkflow({sourceId,expectedRevision:built.source.revision,specPath:spec,samples:[{choice:'first'},{choice:'second'}]},outputDir)};
 const calls=()=>existsSync(marker)?readFileSync(marker,'utf8').trim().split('\n').map(JSON.parse):[];
 return {dir,sourceId,appId,sha,device,deviceConfig,spec,approvedSpec,definition,built,runtime,bind,calls};
}

test('native visual learning requires explicit opt-in and matching allowlist before Python',async t=>{
 for(const approval of [undefined,{enabled:false,allowedWorkflows:['lookup']},{enabled:true,allowedWorkflows:[]},{enabled:true,allowedWorkflows:['other']},{enabled:true}]){
  const f=await fixture(t,{devicePatch:{nativeVisualWorkflow:approval}});
  writeFileSync(f.spec,JSON.stringify({...f.definition,nativeVisualWorkflow:{enabled:true,allowedWorkflows:['lookup']}}));
  await assert.rejects(f.bind(),/VISUAL_WORKFLOW_NOT_APPROVED/);assert.deepEqual(f.calls(),[]);
 }
});

test('native visual learning rejects source, app, artifact, backend and platform mismatch before Python',async t=>{
 const changes=[
  {source:{id:'another',kind:'apk'}},{source:{id:'fixture_apk',kind:'ios'}},
  {backend:{type:'adb',appId:'com.example.other'}},{backend:{type:'webdriver',appId:'com.example.fixture'}},
  {expectedArtifact:{kind:'apk',sha256:'b'.repeat(64)}},{expectedArtifact:{kind:'ios',sha256:'a'.repeat(64)}},{expectedArtifact:undefined}
 ];
 for(const devicePatch of changes){const f=await fixture(t,{devicePatch});await assert.rejects(f.bind(),/VISUAL_APP_IDENTITY_MISMATCH/);assert.deepEqual(f.calls(),[]);}
 const ios=await fixture(t,{kind:'ios'});await assert.rejects(ios.bind(),/VISUAL_APP_IDENTITY_MISMATCH/);assert.deepEqual(ios.calls(),[]);
 const missing=await fixture(t,{includeArtifactHash:false,devicePatch:{expectedArtifact:{kind:'apk'}}});await assert.rejects(missing.bind(),/VISUAL_APP_IDENTITY_MISMATCH/);assert.deepEqual(missing.calls(),[]);
});

test('write learning cannot be authorized by workflow spec or forged device grants',async t=>{
 for(const permissions of [{},{allowWrite:['lookup']},{allowWrite:['other'],allowWriteLearning:['other']}]){
  const f=await fixture(t,{permissions,devicePatch:{workflowPermissions:{allowWrite:['lookup'],allowWriteLearning:['lookup']}}});
  writeFileSync(f.spec,JSON.stringify({...f.definition,effect:'write',workflowPermissions:{allowWrite:['lookup'],allowWriteLearning:['lookup']}}));
  await assert.rejects(f.bind(),permissions.allowWrite?.includes('lookup')?/WORKFLOW_WRITE_LEARNING_NOT_APPROVED/:/WORKFLOW_WRITE_NOT_APPROVED/);assert.deepEqual(f.calls(),[]);
 }
});

test('fake CLI integration dispatches visual adapter and rejects unknown enum before execution',async t=>{
 const f=await fixture(t);const learned=await f.bind();assert.equal(f.calls().length,1);const learning=f.calls()[0];assert.equal(learning.args[1],'apk_inventory.mobile_visual_android');assert.equal(learning.args[learning.args.indexOf('--operation')+1],'workflow-learn');
 const catalog=f.runtime.listCapabilities({sourceId:f.sourceId,kind:'mobile'}),cap=catalog.items.find(x=>x.readiness==='ready');assert(cap,JSON.stringify(catalog));
 const execute=params=>f.runtime.execute({sourceId:f.sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params,outputDir:path.join(f.dir,'call-'+Math.random().toString(36).slice(2))});
 await assert.rejects(execute({choice:'unknown'}),/INPUT_INVALID/);assert.equal(f.calls().length,1);
 await assert.rejects(f.runtime.execute({sourceId:f.sourceId,capabilityId:cap.id,expectedRevision:'0'.repeat(64),params:{choice:'first'},outputDir:path.join(f.dir,'stale')}),/CAPABILITY_CHANGED/);assert.equal(f.calls().length,1);
 const result=await execute({choice:'first'});assert.equal(result.result.fixture,true);const calls=f.calls();assert.equal(calls.length,2);assert.equal(calls[1].args[1],'apk_inventory.mobile_visual_android');assert.equal(calls[1].args[calls[1].args.indexOf('--operation')+1],'execute');assert.deepEqual(calls[1].stdin,{inputs:{choice:'first'}});assert.equal(learned.source.id,f.sourceId);
});


test('native visual definition must match independently approved definition before Python',async t=>{
 for(const mode of ['missing_mapping','missing_file','changed_choice','changed_anchor','changed_effect']){
  const f=await fixture(t,{permissions:{allowWrite:['lookup'],allowWriteLearning:['lookup']}});
  if(mode==='missing_mapping'||mode==='missing_file'){
   const device=JSON.parse(readFileSync(f.device,'utf8'));
   device.nativeVisualWorkflow.approvedDefinitions=mode==='missing_mapping'?{}:{lookup:path.join(f.dir,'nonexistent.json')};
   writeFileSync(f.device,JSON.stringify(device));
  }else{
   const changed=structuredClone(f.definition);
   if(mode==='changed_choice')changed.inputSchema.properties.choice.enum=['first','other'];
   if(mode==='changed_anchor')changed.steps=[{kind:'tap',anchor:{text:'other'}}];
   if(mode==='changed_effect')changed.effect='write';
   writeFileSync(f.spec,JSON.stringify(changed));
  }
  await assert.rejects(f.bind(),/VISUAL_DEFINITION_NOT_APPROVED/,mode);assert.deepEqual(f.calls(),[],mode);
 }
});


// The adapter fixture below records module dispatch. Actual iOS screenshot and
// WDA evidence is kept in the separately invoked device acceptance script.
const iosDevice=()=>({source:{id:'fixture_apk',kind:'ios'},backend:{type:'webdriver',platform:'ios',appId:'com.example.fixture',url:'http://127.0.0.1:1',sessionId:'fixture'},expectedArtifact:undefined});
test('iOS visual learning binds the bundle and configured platform before starting Python',async t=>{
 for(const patch of [{backend:{type:'webdriver',platform:'android',appId:'com.example.fixture'}},{backend:{type:'webdriver',appId:'com.example.fixture'}},{backend:{type:'webdriver',platform:'ios',appId:'com.example.other'}},{source:{id:'another',kind:'ios'}},{expectedArtifact:{kind:'apk',sha256:'a'.repeat(64)}}]){
  const f=await fixture(t,{kind:'ios',devicePatch:{...iosDevice(),...patch}});await assert.rejects(f.bind(),/VISUAL_APP_IDENTITY_MISMATCH/);assert.deepEqual(f.calls(),[]);
 }
});
test('iOS visual ready capability uses its own module and preserves input and revision rejection',async t=>{
 const f=await fixture(t,{kind:'ios',devicePatch:iosDevice()});const learned=await f.bind();assert.equal(f.calls()[0].args[1],'apk_inventory.mobile_visual_ios');assert.equal(learned.source.appArtifactVerified,false);
 const catalog=f.runtime.listCapabilities({sourceId:f.sourceId,kind:'mobile'}),cap=catalog.items.find(x=>x.readiness==='ready');assert(cap);
 const invoke=(params,expectedRevision=cap.revision)=>f.runtime.execute({sourceId:f.sourceId,capabilityId:cap.id,expectedRevision,params,outputDir:path.join(f.dir,'ios-call-'+Math.random().toString(36).slice(2))});
 await assert.rejects(invoke({choice:'unknown'}),/INPUT_INVALID/);await assert.rejects(invoke({choice:'first'},'0'.repeat(64)),/CAPABILITY_CHANGED/);assert.equal(f.calls().length,1);
 const called=await invoke({choice:'first'});assert.equal(called.result.ok,true);assert.equal(called.result.untrusted,true);assert.equal(called.result.provenance,'device_screenshot_and_local_ocr');assert.equal(f.calls()[1].args[1],'apk_inventory.mobile_visual_ios');assert.deepEqual(f.calls()[1].stdin,{inputs:{choice:'first'}});
});
