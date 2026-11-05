import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {root,temp,until} from './helpers.mjs';

const put=(file,value)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const json=file=>JSON.parse(readFileSync(file,'utf8'));
const wanted=status=>({status,automaticRetry:false});
const knownMutations=rows=>rows.filter(([method,url])=>method==='POST'&&/\/element\/[^/]+\/(?:clear|value|click)$/.test(url));
const evidenceBase=process.env.BFS_WEBVIEW_OUTCOME_EVIDENCE;

function caseDirectory(t,name){
 if(!evidenceBase)return temp(t);
 const base=path.resolve(evidenceBase),allowed=path.join(root,'output-vision-implementation')+path.sep;
 assert(base.startsWith(allowed),'Evidence must stay in the private output root');
 mkdirSync(base,{recursive:true,mode:0o700});const dir=path.join(base,name);assert(!existsSync(dir),'Use fresh evidence per SDK run');mkdirSync(dir,{mode:0o700});return dir;
}
async function call(client,name,args={}){
 const reply=await client.callTool({name,arguments:args},{timeout:30000,maxTotalTimeout:30000,resetTimeoutOnProgress:false});assert(!reply.isError,JSON.stringify(reply));
 return reply.structuredContent||JSON.parse(reply.content[0].text);
}
async function terminal(client,start,status='completed'){
 return until(async()=>{const value=await call(client,'software_operation',{operationId:start.operationId});if(['completed','failed','cancelled','interrupted'].includes(value.status)&&!value.active){assert.equal(value.status,status,JSON.stringify(value));return value;}},60000);
}
async function fixture(){
 const child=spawn(path.join(root,'.venv/bin/python'),['-B',path.join(root,'test/webview-fixture.py')],{cwd:root,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);
 const lines=createInterface({input:child.stdout}),next=()=>once(lines,'line').then(([line])=>JSON.parse(line)),first=await next();assert(first.ok&&first.protocolModelOnly&&first.productionImports===0);
 const request=async value=>{const pending=next();child.stdin.write(JSON.stringify(value)+'\n');const result=await pending;assert.equal(result.ok,true);return result;};
 return {...first,read:async()=>(await request({op:'snapshot'})).snapshot,set:changes=>request({op:'set',changes}),async close(){await request({op:'quit'});child.stdin.end();if(child.exitCode===null&&child.signalCode===null)await once(child,'close');lines.close();assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);assert.equal(stderr,'');return {kind:'independent_model',exitCode:child.exitCode,signalCode:child.signalCode,stderr};}};
}
function assertSafeOutcome(value,status){assert.deepEqual(value,wanted(status));assert.deepEqual(Object.keys(value).sort(),['automaticRetry','status']);}
async function setup(t,name){
 const dir=caseDirectory(t,name),app=await fixture(),inventory=path.join(dir,'inventory'),out=path.join(dir,'out'),intent=path.join(dir,'journal/intent.json');mkdirSync(inventory,{mode:0o700});mkdirSync(path.dirname(intent),{mode:0o700});
 const cleanup=[];let client,transport,child,stderr='';
 t.after(async()=>{try{if(client){await client.close();if(child?.exitCode===null&&child.signalCode===null)await once(child,'close');cleanup.push({kind:'official_sdk',exitCode:child?.exitCode,signalCode:child?.signalCode,stderr});assert.equal(child?.exitCode,0);assert.equal(child?.signalCode,null);assert.equal(stderr,'');}}finally{cleanup.push(await app.close());if(evidenceBase)put(path.join(dir,'cleanup.json'),cleanup);}});
 put(path.join(inventory,'source.json'),{format:'endpoint-inventory',schema_version:'1.1',kind:'ios',source_id:'webview_fixture',inventory:'endpoints.json',app:{package_name:app.ready.appId,bundle_id:app.ready.appId,artifact_type:'app',version_name:'1',artifact_sha256:'a'.repeat(64)}});put(path.join(inventory,'endpoints.json'),[]);
 const controls=[['query','input'],['detail','input'],['run','button'],['result','output']].map(([id,kind])=>({id,kind,selector:'#'+id,group:'#searchForm'}));
 const device=path.join(dir,'device.json');put(device,{source:{id:'webview_fixture',kind:'ios'},backend:{type:'appium-webview',platform:'ios',appId:app.ready.appId,url:app.ready.url,sessionId:app.ready.sessionId,intentJournal:intent,commandTimeoutMs:3000,webview:{context:app.ready.context,windowHandle:app.ready.windowHandle,origin:app.ready.origin,url:app.ready.documentUrl,controls}},limits:{maxActions:100,maxDurationMs:60000},actionAllowlist:[{kind:'type',selector:{resourceId:'#query'},effect:'read'},{kind:'type',selector:{resourceId:'#detail'},effect:'read'},{kind:'click',selector:{resourceId:'#run'},effect:'read'}]});
 const config=path.join(dir,'config.json');put(config,{outputRoot:out,artifactRoots:[dir],python:path.join(root,'.venv/bin/python'),devices:{webview:device}});
 transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'src/software-mcp.js'),'--config',config],cwd:root,stderr:'pipe',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});transport.stderr.on('data',bytes=>stderr+=bytes);client=new Client({name:'real-webview-outcome-client',version:'1'});try{await client.connect(transport);}finally{child=transport._process;}
 await terminal(client,await call(client,'software_discover',{kind:'ios',input:inventory,deviceName:'webview'}));const plan=await call(client,'software_workflows',{sourceId:'webview_fixture'}),candidate=plan.items.find(row=>row.planningMode==='webview-dom-linear-v1');assert(candidate);
 const assertions=['query','detail'].map(param=>({outputTargetId:candidate.outputTargets[0].id,param,changedFromBefore:true}));
 const bind=extra=>call(client,'software_bind_workflow',{sourceId:'webview_fixture',expectedRevision:plan.source.revision,candidateId:candidate.id,samples:[{query:'alpha',detail:'one'},{query:'beta',detail:'two'}],resultAssertions:assertions,...extra});
 return {dir,out,intent,app,client,plan,candidate,assertions,bind,save(value){if(evidenceBase)put(path.join(dir,'evidence.json'),value);}};
}

test('real SDK failed learning exposes unknown/noRetry while first accepted click and pending stay unreplayed',{timeout:120000},async t=>{
 const f=await setup(t,'learning-unknown');await f.app.set({failCommand:'click'});const start=await f.bind(),failed=await terminal(f.client,start,'failed');assert.equal(failed.errorCode,'WORKFLOW_NOT_VALIDATED');assertSafeOutcome(failed.webviewOutcome,'unknown');
 const privateResult=json(path.join(f.out,'operations',start.operationId,'workflow/result.json')),pending=json(f.intent);assertSafeOutcome(privateResult.webviewOutcome,'unknown');assert.equal(pending.pending.status,'unknown');const before=await f.app.read();assert.equal(before.ledger.length,1);assert.equal(before.effects.filter(row=>row[1]==='click').length,1);
 const rebound=await terminal(f.client,await f.bind(),'failed'),after=await f.app.read();assertSafeOutcome(rebound.webviewOutcome,'unknown');assert(JSON.stringify(rebound).includes('WEBVIEW_PENDING_UNKNOWN'));assert.equal(after.ledger.length,1);assert.deepEqual(after.effects,before.effects);const delta=after.calls.slice(before.callsTotal);assert(delta.length>0);assert.equal(knownMutations(delta).length,0);
 f.save({scope:'actual official SDK + production Node/Python worker + independent loopback model',failed,privateResult,pending,rebound,before,after,rebindReadonlyHttp:after.callsTotal-before.callsTotal,rebindUiDelta:after.effects.length-before.effects.length,rebindBusinessDelta:after.ledger.length-before.ledger.length});
});

test('real SDK preparation refusal has no invented start-state and no UI dispatch',{timeout:120000},async t=>{
 const f=await setup(t,'preparation-refusal'),before=await f.app.read(),start=await f.bind({resultAssertions:f.assertions.slice(0,1)}),failed=await terminal(f.client,start,'failed'),after=await f.app.read();assert.equal(failed.errorCode,'WORKFLOW_ASSERTION_REQUIRED');assert.equal(failed.webviewOutcome,undefined);assert.deepEqual(after.effects,before.effects);assert.deepEqual(after.ledger,before.ledger);assert.equal(knownMutations(after.calls.slice(before.callsTotal)).length,0);
 assert(!existsSync(path.join(f.out,'operations',start.operationId,'workflow/webview-outcome-scope.json')));f.save({scope:'actual pre-dispatch preparation refusal; no producer outcome means missing evidence, not inferred not_started',failed,before,after});
});

test('real SDK success strips private receipt, invalid execute stays unclassified, and uncertain execute remains blocked',{timeout:120000},async t=>{
 const f=await setup(t,'execution-unknown'),start=await f.bind(),learned=await terminal(f.client,start);assertSafeOutcome(learned.webviewOutcome,'observed');const privateResult=json(path.join(f.out,'operations',start.operationId,'workflow/result.json'));assert(privateResult.webviewOutcome.completionReceipt);const privateReceipt=privateResult.webviewOutcome.completionReceipt;assert(!JSON.stringify(learned).includes(privateReceipt.intentSha256));assert(!JSON.stringify(learned).includes(privateReceipt.executionId));assert(!JSON.stringify(learned).includes('completionReceipt'));
 const catalog=await call(f.client,'software_capabilities',{sourceId:'webview_fixture',kind:'mobile'}),cap=catalog.items.find(row=>row.readiness==='ready');assert(cap);const args=params=>({sourceId:'webview_fixture',capabilityId:cap.id,expectedRevision:cap.revision,params});
 const invalidBefore=await f.app.read(),invalid=await terminal(f.client,await call(f.client,'software_call',args({query:'missing detail'})),'failed'),invalidAfter=await f.app.read();assert.equal(invalid.errorCode,'INPUT_INVALID');assert.equal(invalid.webviewOutcome,undefined);assert.equal(invalidAfter.callsTotal,invalidBefore.callsTotal);assert.deepEqual(invalidAfter.effects,invalidBefore.effects);
 await f.app.set({failCommand:'click'});const first=await terminal(f.client,await call(f.client,'software_call',args({query:'once',detail:'only'})));assert.equal(first.result.result.ok,false);assertSafeOutcome(first.webviewOutcome,'unknown');assertSafeOutcome(first.result.result.webviewOutcome,'unknown');const before=await f.app.read();assert.equal(before.ledger.length,3);
 const second=await terminal(f.client,await call(f.client,'software_call',args({query:'again',detail:'blocked'}))),after=await f.app.read();assertSafeOutcome(second.webviewOutcome,'unknown');assert.equal(second.result.result.error.code,'WEBVIEW_PENDING_UNKNOWN');assert.equal(after.callsTotal,before.callsTotal);assert.deepEqual(after.effects,before.effects);assert.deepEqual(after.ledger,before.ledger);
 f.save({scope:'actual SDK success/invalid input/uncertain execute; public nested locations retain only whitelist',learned,privateResult,invalid,first,second,before,after,secondHttpDelta:after.callsTotal-before.callsTotal,secondUiDelta:after.effects.length-before.effects.length,secondBusinessDelta:after.ledger.length-before.ledger.length});
});

test('real cooperative SDK cancellation propagates actual saved CLI unknown without replay',{timeout:120000},async t=>{
 const f=await setup(t,'cooperative-cancel');await f.app.set({timeoutCommand:'value'});const start=await f.bind();await until(async()=>{const state=await f.app.read();return state.effects.some(row=>row[1]==='value');},30000);await call(f.client,'software_stop',{operationId:start.operationId});const cancelled=await terminal(f.client,start,'cancelled');assertSafeOutcome(cancelled.webviewOutcome,'unknown');
 const privateResult=json(path.join(f.out,'operations',start.operationId,'workflow/result.json'));assertSafeOutcome(privateResult.webviewOutcome,'unknown');const pending=json(f.intent);assert.equal(pending.pending.status,'unknown');const before=await f.app.read();assert.equal(before.ledger.length,0);await f.app.set({timeoutCommand:null});const rebound=await terminal(f.client,await f.bind(),'failed'),after=await f.app.read();assertSafeOutcome(rebound.webviewOutcome,'unknown');assert.equal(after.ledger.length,0);assert.deepEqual(after.effects,before.effects);assert.equal(knownMutations(after.calls.slice(before.callsTotal)).length,0);
 f.save({scope:'cooperative cancellation after actual value dispatch; outcome read from actual CLI files, not inferred from CANCELLED',cancelled,privateResult,pending,rebound,before,after,rebindReadonlyHttp:after.callsTotal-before.callsTotal,rebindUiDelta:after.effects.length-before.effects.length,rebindBusinessDelta:after.ledger.length-before.ledger.length});
});

test('real successful SDK execution retains the private receipt and publishes only observed at both API wrappers',{timeout:120000},async t=>{
 const f=await setup(t,'successful-execution'),learned=await terminal(f.client,await f.bind());assertSafeOutcome(learned.webviewOutcome,'observed');
 const catalog=await call(f.client,'software_capabilities',{sourceId:'webview_fixture',kind:'mobile'}),cap=catalog.items.find(row=>row.readiness==='ready');assert(cap);
 const params={query:' 好  消息🙂e\u0301 ',detail:' 实际🙂e\u0301 '},start=await call(f.client,'software_call',{sourceId:'webview_fixture',capabilityId:cap.id,expectedRevision:cap.revision,params}),completed=await terminal(f.client,start);
 assert.equal(completed.result.result.ok,true);assertSafeOutcome(completed.webviewOutcome,'observed');assertSafeOutcome(completed.result.result.webviewOutcome,'observed');
 const privateResult=json(path.join(f.out,'operations',start.operationId,'execution/result.json')),receipt=privateResult.webviewOutcome.completionReceipt;assert(receipt);assert.equal(typeof receipt.executionId,'string');assert(receipt.executionId.length>0);assert.match(receipt.intentSha256,/^[a-f0-9]{64}$/);
 const publicText=JSON.stringify(completed);assert(!publicText.includes('completionReceipt'));assert(!publicText.includes(receipt.executionId));assert(!publicText.includes(receipt.intentSha256));
 const after=await f.app.read();assert.equal(after.ledger.length,3);assert.deepEqual(after.ledger[2],{sequence:3,...params,button:'run'});
 f.save({scope:'actual successful software_call with production worker/Python receipt; public top and nested result independently checked',learned,completed,privateResult,after});
});
