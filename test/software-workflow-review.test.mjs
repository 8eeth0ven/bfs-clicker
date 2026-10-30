import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createSoftwareRuntime} from '../src/software-runtime.js';
import {atomicJson} from '../src/store.js';
import {runAsset} from '../src/runner.js';
import {endpointId} from '../gateway/dist/manifest.js';
const project=path.resolve(import.meta.dirname,'..');
const json=async file=>JSON.parse(await readFile(file,'utf8'));
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'workflow-integration-review-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let quantity='',total=0;const requests=[];
 const xml=()=>`<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication"><XCUIElementTypeTextField type="XCUIElementTypeTextField" name="Quantity" label="Quantity" value="${quantity}" enabled="true" visible="true" x="0" y="0" width="100" height="40"/><XCUIElementTypeButton type="XCUIElementTypeButton" name="Calculate" label="Calculate" enabled="true" visible="true" x="0" y="50" width="100" height="40"/><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="total" label="TOTAL:${total}" value="TOTAL:${total}" enabled="true" visible="true" x="0" y="100" width="100" height="40"/></XCUIElementTypeApplication></AppiumAUT>`;
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;let body={};try{body=raw?JSON.parse(raw):{}}catch{}
  requests.push({path:req.url,method:req.method,body,authorization:req.headers.authorization});
  const send=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({value}))};
  if(req.url==='/search'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({query:body.query,authorization:req.headers.authorization}));return}
  const route=req.url.replace('/session/review','');
  if(route==='/source')return send(xml());if(route==='/execute/sync')return send({bundleId:'com.example.review'});
  if(route==='/elements'){const key=body.value.includes('Quantity')?'quantity':body.value.includes('Calculate')?'calculate':body.value.includes('total')?'total':null;return send(key?[{'element-6066-11e4-a52e-4f735466cecf':key}]:[])}
  if(route==='/element/quantity/clear'){quantity='';return send(null)}if(route==='/element/quantity/value'){quantity+=body.text;return send(null)}
  if(route==='/element/calculate/click'){total=Number(quantity)**2;return send(null)}if(route==='/back')return send(null);
  res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({value:{error:'unsupported'}}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));
 const origin='http://127.0.0.1:'+server.address().port,sourceId='review_app',out=path.join(dir,'software'),inventory=path.join(dir,'inventory');await mkdir(inventory);
 const descriptor={format:'endpoint-inventory',schema_version:'1.1',kind:'ios',source_id:sourceId,inventory:'endpoints.json',app:{package_name:'com.example.review',bundle_id:'com.example.review',artifact_type:'app',version_name:'1',artifact_sha256:'a'.repeat(64)}};
 const records=[{method:'POST',url:origin+'/search',headers:{'Content-Type':'application/json'},query:{},body:{query:'private-original-sample'},categories:['observed']}];
 await writeFile(path.join(inventory,'source.json'),JSON.stringify(descriptor));await writeFile(path.join(inventory,'endpoints.json'),JSON.stringify(records));
 const device={source:{id:sourceId,kind:'ios'},backend:{type:'webdriver',platform:'ios',url:origin,sessionId:'review',appId:'com.example.review'},limits:{maxActions:30,maxDepth:1,maxDurationMs:15000},actionAllowlist:[{kind:'type',selector:{accessibilityId:'Quantity'},effect:'read'},{kind:'click',selector:{accessibilityId:'Calculate'},effect:'read'}]};
 await mkdir(path.join(out,'private'),{recursive:true});const snapshot=path.join(out,'private/device-review-snapshot.json');await writeFile(snapshot,JSON.stringify(device));
 const credentials=path.join(dir,'credentials.yaml');await writeFile(credentials,'mode: token\ntoken: review-runtime-secret\n');
 const runtime=createSoftwareRuntime({outputRoot:out,artifactRoots:[dir],python:path.join(project,'.venv/bin/python'),devices:{calc:snapshot},bindings:{[sourceId]:{allowed_origins:[origin],credentials,credential_origins:[origin]}},methods:{allow_non_get:true,allow:[{source:sourceId,endpoint_id:endpointId(sourceId,origin,'/search'),method:'POST'}]}});
 const initial=await runtime.compile({sourceId,kind:'ios',inventoryPath:inventory,deviceName:'calc',deviceConfigPath:snapshot});
 const spec={schemaVersion:1,id:'square',name:'计算查询',effect:'read',inputSchema:{type:'object',properties:{quantity:{type:'integer',minimum:1,maximum:9}},required:['quantity'],additionalProperties:false},steps:[{kind:'type',selector:{accessibilityId:'Quantity'},input:'quantity',replace:true},{kind:'click',selector:{accessibilityId:'Calculate'}},{kind:'assert',selector:{accessibilityId:'total'},expect:{matches:'^TOTAL:[0-9]+$'}},{kind:'extract',selector:{accessibilityId:'total'},output:'total',pattern:'^TOTAL:([0-9]+)$',group:1,valueType:'integer'}]};
 const specPath=path.join(dir,'workflow.json');await writeFile(specPath,JSON.stringify(spec));
 return {dir,out,origin,sourceId,inventory,descriptor,records,snapshot,device,runtime,spec,specPath,requests,initial,
  async learn(extra={}){const outputDir=path.join(out,'learn-'+Math.random().toString(16).slice(2));return {outputDir,result:await runtime.bindWorkflow({sourceId,expectedRevision:runtime.getSource(sourceId).revision,specPath,samples:[{quantity:2},{quantity:3}],...extra},outputDir)}},
  caps(){return runtime.listCapabilities({sourceId,limit:100})},
  ref(){return json(path.join(out,'sources',sourceId,'current.json'))}};
}

test('review: actual mobile learning survives refresh with its device snapshot; samples stay private and approved POST remains callable',{timeout:60000},async t=>{
 const f=await fixture(t),learned=await f.learn(),ref=await f.ref(),cap=f.caps().items.find(item=>item.kind==='mobile'&&item.inputSchema.properties.quantity);
 assert.ok(cap);assert.equal(cap.readiness,'ready');assert.equal(ref.deviceConfigPath,f.snapshot);assert.equal(ref.workflowEntries.length,1);
 const publicText=JSON.stringify({source:f.runtime.getSource(f.sourceId),caps:f.caps()});assert.doesNotMatch(publicText,/"samples"|"quantity":2|"quantity":3|private-original-sample|review-runtime-secret|accessibilityId/);
 const executed=await f.runtime.execute({sourceId:f.sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{quantity:4},outputDir:path.join(f.out,'execute-4')});assert.equal(executed.result.outputs.total,16);
 f.runtime.config.devices.calc=path.join(f.dir,'missing-device-config');
 f.records.push({method:'GET',url:f.origin+'/new',headers:{},query:{},body:null,categories:['static_candidate']});await writeFile(path.join(f.inventory,'endpoints.json'),JSON.stringify(f.records));
 const refreshed=await f.runtime.refresh({sourceId:f.sourceId,expectedRevision:ref.revision}),after=await f.ref();assert.notEqual(refreshed.source.revision,ref.revision);assert.equal(after.deviceConfigPath,f.snapshot);assert.equal(after.workflowEntries[0].deviceConfigPath,f.snapshot);
 const fresh=f.caps().items.find(item=>item.id===cap.id);assert.equal(fresh.readiness,'ready');
 await assert.rejects(f.runtime.execute({sourceId:f.sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{quantity:5},outputDir:path.join(f.out,'stale')}),/CAPABILITY_CHANGED/);
 const next=await f.runtime.execute({sourceId:f.sourceId,capabilityId:fresh.id,expectedRevision:fresh.revision,params:{quantity:5},outputDir:path.join(f.out,'execute-5')});assert.equal(next.result.outputs.total,25);
 const post=f.caps().items.find(item=>item.target?.method==='POST');assert.equal(post.readiness,'ready');
 const response=await f.runtime.execute({sourceId:f.sourceId,capabilityId:post.id,expectedRevision:post.revision,params:{body:{query:'unseen-query'}},outputDir:path.join(f.out,'post-query')});assert.equal(response.result.ok,true);assert.equal(f.requests.findLast(row=>row.path==='/search').authorization,'Bearer review-runtime-secret');assert.doesNotMatch(JSON.stringify(response),/review-runtime-secret/);
 assert.ok(learned.result.counts.ready>0);
});

test('review: failed learning and invalid spec authority do not advance current or widen device controls',{timeout:60000},async t=>{
 const f=await fixture(t);await f.learn();const before=await f.ref();
 const changed={...f.spec,steps:f.spec.steps.map(step=>step.kind==='assert'?{...step,expect:{equals:'NEVER'}}:step)};await writeFile(f.specPath,JSON.stringify(changed));
 await assert.rejects(f.learn());assert.equal((await f.ref()).revision,before.revision);
 const forbidden={...f.spec,backend:{url:'https://unapproved.test'},requestAllowlist:[{method:'POST',url:'https://unapproved.test/write'}]};await writeFile(f.specPath,JSON.stringify(forbidden));const count=f.requests.length;
 await assert.rejects(f.learn(),/WORKFLOW_DEFINITION_INVALID/);assert.equal(f.requests.length,count);assert.equal((await f.ref()).revision,before.revision);
});

test('review: ready workflow without any device binding must become candidate or be rejected',{timeout:60000},async t=>{
 const f=await fixture(t);await f.learn();const ref=await f.ref();
 const entries=ref.workflowEntries.map(({deviceName,deviceConfigPath,...entry})=>entry);
 let result,error;try{result=await f.runtime.compile({sourceId:f.sourceId,kind:'ios',inventoryPath:f.inventory,workflowEntries:entries,expectedRevision:ref.revision})}catch(e){error=e}
 if(!error){const mobile=f.caps().items.filter(cap=>cap.kind==='mobile');assert.ok(mobile.every(cap=>cap.readiness!=='ready'),'a ready capability must have an executable trusted device binding');assert.ok(result)}
});

test('review: refreshed app identity cannot keep a workflow ready for the old device app',{timeout:60000},async t=>{
 const f=await fixture(t);await f.learn();const before=await f.ref();f.descriptor.app.bundle_id='com.example.other';f.descriptor.app.package_name='com.example.other';f.descriptor.app.artifact_sha256='b'.repeat(64);await writeFile(path.join(f.inventory,'source.json'),JSON.stringify(f.descriptor));
 let error;try{await f.runtime.refresh({sourceId:f.sourceId,expectedRevision:before.revision})}catch(e){error=e}
 if(!error)assert.ok(f.caps().items.filter(cap=>cap.kind==='mobile').every(cap=>cap.readiness!=='ready'),'old-app device/workflow cannot be published as ready under changed inventory identity');
 else assert.equal((await f.ref()).revision,before.revision);
 f.descriptor.app.bundle_id='com.example.review';f.descriptor.app.package_name='com.example.review';f.descriptor.app.artifact_sha256='c'.repeat(64);await writeFile(path.join(f.inventory,'source.json'),JSON.stringify(f.descriptor));
 await assert.rejects(f.runtime.refresh({sourceId:f.sourceId,expectedRevision:before.revision}),/IDENTITY|ARTIFACT|MISMATCH/);assert.equal((await f.ref()).revision,before.revision);
});

test('review: workflow entry files may not escape artifact roots through per-file symlinks',{timeout:60000},async t=>{
 const f=await fixture(t);await f.learn();const ref=await f.ref(),directory=ref.workflowEntries[0].directory;
 const external=await mkdtemp(path.join(os.tmpdir(),'workflow-outside-'));t.after(()=>rm(external,{recursive:true,force:true}));
 const manifest=await readFile(path.join(directory,'manifest.json'));await writeFile(path.join(external,'manifest.json'),manifest);await rm(path.join(directory,'manifest.json'));await symlink(path.join(external,'manifest.json'),path.join(directory,'manifest.json'));
 await assert.rejects(f.runtime.refresh({sourceId:f.sourceId,expectedRevision:ref.revision}),/PATH|路径|artifactRoots|越界/i);
 assert.equal((await f.ref()).revision,ref.revision);
 await rm(path.join(directory,'manifest.json'));await writeFile(path.join(directory,'manifest.json'),'{bad');await symlink(path.join(external,'manifest.json'),path.join(directory,'manifest.json.previous'));
 await assert.rejects(f.runtime.refresh({sourceId:f.sourceId,expectedRevision:ref.revision}),/PATH|路径|越界/i);
 await rm(path.join(directory,'manifest.json.previous'));await writeFile(path.join(directory,'manifest.json'),manifest);
 const recipeBytes=await readFile(path.join(directory,'recipes.json'));await writeFile(path.join(external,'recipes.json'),recipeBytes);await rm(path.join(directory,'recipes.json'));await symlink(path.join(external,'recipes.json'),path.join(directory,'recipes.json'));
 await assert.rejects(f.runtime.refresh({sourceId:f.sourceId,expectedRevision:ref.revision}),/PATH|路径|越界/i);assert.equal((await f.ref()).revision,ref.revision);
 const cap=f.caps().items.find(item=>item.kind==='mobile');const executed=await f.runtime.execute({sourceId:f.sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{quantity:6},outputDir:path.join(f.out,'prior-generation-still-executes')});assert.equal(executed.result.outputs.total,36);
});

test('review: real browser learning that loses CAS preserves the winning pointer and prior immutable certificate',{timeout:90000},async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'workflow-cas-browser-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const sourceId='browser_review',outputRoot=path.join(dir,'software'),runDir=path.join(outputRoot,'runs',sourceId);let inject=null;const queries=[];
 const server=createServer(async(req,res)=>{
  if(req.url==='/api/search'){
   let raw='';for await(const chunk of req)raw+=chunk;const {query}=JSON.parse(raw);queries.push(query);if(query==='delta'&&inject)inject();
   const body=JSON.stringify({query});res.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(body)});res.end(body);return;
  }
  const body='<!doctype html><title>CAS query fixture</title><section role="search"><label for="q">查询词</label><input id="q" name="query" type="search" required minlength="2"><button id="go" type="button" aria-controls="results">查询</button><div id="results" role="status">等待查询</div></section><script>document.querySelector("#go").onclick=async()=>{const query=document.querySelector("#q").value;const response=await fetch("/api/search",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query})});const data=await response.json();document.querySelector("#results").textContent="结果："+data.query};</script>';
  res.writeHead(200,{'content-type':'text/html','content-length':Buffer.byteLength(body)});res.end(body);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));
 const origin='http://127.0.0.1:'+server.address().port;
 await runAsset({startUrl:origin+'/',outputDir:runDir,actionProfile:'forms',fillText:true,formValues:{'#q':'seed'},actionAllowlist:['#q','#go'],requestAllowlist:[{method:'POST',url:origin+'/api/search'}],maxStates:1,maxDepth:0,maxActions:5,maxDurationMs:15000,maxRequests:100,shotFormat:'none',requestDelayMs:0,exploreHover:false,exploreScroll:false},{log:()=>{}});
 const runtime=createSoftwareRuntime({outputRoot,artifactRoots:[dir],bindings:{[sourceId]:{allowed_origins:[origin]}}});const initial=await runtime.compile({sourceId,kind:'web',runDir});
 const spec={schemaVersion:1,id:'query',name:'CAS查询',effect:'read',networkEvidence:'required',inputSchema:{type:'object',properties:{query:{type:'string',minLength:2,maxLength:20}},required:['query'],additionalProperties:false},entry:{url:origin+'/',anchors:[{selector:'#q',tag:'input'}]},steps:[{kind:'fill',selector:'#q',param:'query'},{kind:'click',selector:'#go'}],assertions:[{selector:'#results',textIncludesParam:'query'}],extract:[{name:'result',selector:'#results',kind:'text'}],samples:[{query:'alpha'},{query:'beta'}]};
 const firstSpec=path.join(dir,'first.json');await writeFile(firstSpec,JSON.stringify(spec));
 await runtime.bindWorkflow({sourceId,expectedRevision:initial.source.revision,specPath:firstSpec},path.join(outputRoot,'first-learn'));
 const currentFile=path.join(outputRoot,'sources',sourceId,'current.json'),originalRef=await json(currentFile),oldCap=runtime.listCapabilities({sourceId,limit:100}).items.find(cap=>cap.inputSchema.properties.query&&cap.readiness==='ready');assert.ok(oldCap);
 // Materialize a legitimate competing generation in advance, then restore the old pointer.
 await runtime.compile({sourceId,kind:'web',runDir,expectedRevision:originalRef.revision,workflowEntries:originalRef.workflowEntries,sourceWarnings:['concurrent-review-generation']});
 const winner=await json(currentFile);atomicJson(currentFile,originalRef);assert.notEqual(winner.revision,originalRef.revision);
 const cfgBefore=await readFile(path.join(runDir,'private/config.json')),eventsBefore=await readFile(path.join(runDir,'private/events.jsonl'));
 const secondSpec=path.join(dir,'second.json');await writeFile(secondSpec,JSON.stringify({...spec,samples:[{query:'gamma'},{query:'delta'}]}));
 inject=()=>{atomicJson(currentFile,winner);inject=null};
 await assert.rejects(runtime.bindWorkflow({sourceId,expectedRevision:originalRef.revision,specPath:secondSpec},path.join(outputRoot,'losing-learn')),/SOURCE_CHANGED/);
 assert.ok(queries.includes('gamma')&&queries.includes('delta'),'losing workflow must have completed actual sample requests');assert.equal((await json(currentFile)).revision,winner.revision);
 assert.deepEqual(await readFile(path.join(runDir,'private/config.json')),cfgBefore);assert.deepEqual(await readFile(path.join(runDir,'private/events.jsonl')),eventsBefore);
 const currentCap=runtime.listCapabilities({sourceId,limit:100}).items.find(cap=>cap.id===oldCap.id);
 const result=await runtime.execute({sourceId,capabilityId:currentCap.id,expectedRevision:currentCap.revision,params:{query:'epsilon'},outputDir:path.join(outputRoot,'prior-certificate-call')});
 assert.equal(result.result.ok,true,JSON.stringify(result));assert.match(JSON.stringify(result.result.data),/epsilon/);
});
