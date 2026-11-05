import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {root,temp,until} from './helpers.mjs';

const SOURCE='webview_coherence_model';
const MODE='same_output_snapshot_v1';
const evidenceBase=process.env.BFS_WEBVIEW_COHERENCE_EVIDENCE;
const json=file=>JSON.parse(readFileSync(file,'utf8'));
const put=(file,value)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const outcome=status=>({status,automaticRetry:false});
const sampleA={query:' Q1 上  海🙂e\u0301 ',detail:' D1 深  圳🌊o\u0308 '};
const sampleB={query:' Q2 北  京🛰️a\u0308 ',detail:' D2 杭  州🚀u\u0301 '};
const third={query:' Q3 东  京🙂e\u0301 ',detail:' D3 成  都🚲a\u0308 '};
const fourth={query:' Q4 西  安🌌o\u0308 ',detail:' D4 南  京🧭u\u0301 '};

async function bounded(promise,ms,label){
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}finally{clearTimeout(timer);}
}
async function exitRecord(child,closed){
 let forced=false;
 try{await bounded(closed,25000,'OWNED_CHILD_CLOSE_TIMEOUT');}
 catch{forced=true;child.kill('SIGTERM');try{await bounded(closed,5000,'OWNED_CHILD_TERM_TIMEOUT');}catch{child.kill('SIGKILL');await bounded(closed,5000,'OWNED_CHILD_KILL_TIMEOUT');}}
 return {exitCode:child.exitCode,signalCode:child.signalCode,forced};
}
async function portClosed(url){
 const target=new URL(url);return bounded(new Promise(resolve=>{const socket=net.createConnection({host:target.hostname,port:Number(target.port)});socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('error',()=>{socket.destroy();resolve(true);});}),2000,'OWNED_MODEL_PORT_AUDIT_TIMEOUT');
}
function directory(t,name){
 if(!evidenceBase)return temp(t);
 const base=path.resolve(evidenceBase);assert(base.startsWith(path.join(root,'output-vision-implementation')+path.sep));
 mkdirSync(base,{recursive:true,mode:0o700});const dir=path.join(base,name);assert(!existsSync(dir),'Keep first SDK evidence; use a fresh cohort');mkdirSync(dir,{mode:0o700});return dir;
}
async function model(){
 const child=spawn(path.join(root,'.venv/bin/python'),['-B',path.join(root,'test/webview-coherence-fixture.py')],{cwd:root,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','pipe']});
 const closed=once(child,'close');let stderr='',stderrBytes=0;child.stderr.on('data',data=>{stderrBytes+=data.length;if(stderrBytes<=262144)stderr+=data;});
 const lines=createInterface({input:child.stdout});
 const next=async()=>{const [line]=await bounded(once(lines,'line'),15000,'MODEL_JSONL_TIMEOUT');assert(Buffer.byteLength(line)<=8*1024*1024);return JSON.parse(line);};
 const first=await next();assert(first.ok&&first.protocolModelOnly&&first.productionImports===0&&first.javascriptEvaluated===false);
 const request=async value=>{const pending=next();child.stdin.write(JSON.stringify(value)+'\n');const reply=await pending;assert.equal(reply.ok,true,JSON.stringify(reply));return reply;};
 return {ready:first.ready,read:async()=>(await request({op:'snapshot'})).snapshot,setMode:async(mode,firstParam)=>(await request({op:'setMode',mode,firstParam})).snapshot,
  async close(){let closeError=null;try{await request({op:'quit'});}catch(error){closeError=error.message;}child.stdin.end();const exit=await exitRecord(child,closed);lines.close();return {kind:'independent_android_protocol_model',...exit,stderr,stderrBytes,closeError,portClosed:await portClosed(first.ready.url)};}};
}
async function sdk(entry,register){
 const transport=new StdioClientTransport({command:process.execPath,args:[entry],cwd:root,stderr:'pipe',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 let stderr='',stderrBytes=0;transport.stderr.on('data',data=>{stderrBytes+=data.length;if(stderrBytes<=262144)stderr+=data;});
 const client=new Client({name:'actual-webview-coherence-client',version:'1'}),records=[];let child,closed;
 const connection={client,records,async call(name,args={}){const reply=await client.callTool({name,arguments:args},{timeout:30000,maxTotalTimeout:30000,resetTimeoutOnProgress:false});assert(!reply.isError,JSON.stringify(reply));const value=reply.structuredContent||JSON.parse(reply.content[0].text);records.push({name,arguments:args,value});return value;},
  async close(){let closeError=null;try{await bounded(client.close(),25000,'SDK_CLOSE_TIMEOUT');}catch(error){closeError=error.message;}return {kind:'official_sdk',...(child?await exitRecord(child,closed):{exitCode:null,signalCode:null,forced:false,spawned:false}),stderr,stderrBytes,closeError};}};
 register(connection);try{await client.connect(transport);}finally{child=transport._process;if(child)closed=child.exitCode===null&&child.signalCode===null?once(child,'close'):Promise.resolve();}
 return connection;
}
async function terminal(connection,start,status='completed',tool='software_operation'){
 return until(async()=>{const value=await connection.call(tool,{operationId:start.operationId});if(['completed','failed','cancelled','interrupted'].includes(value.status)&&!value.active){assert.equal(value.status,status,JSON.stringify(value));return value;}},60000);
}
function assertPairs(state){
 assert.equal(state.captureComplete,true);assert.equal(state.javascriptEvaluated,false);assert.equal(state.productionImports,0);
 const groups=new Map();for(const frame of state.coherence.frames){const group=groups.get(frame.observation)||[];group.push(frame);groups.set(frame.observation,group);}
 for(const frames of groups.values()){assert.equal(frames.length,2);assert.equal(frames[0].text,frames[1].text);assert.equal(frames[0].submission,frames[1].submission);assert.equal(frames[0].mode,frames[1].mode);}
}
function assertTorn(state,minimumSubmission){
 assertPairs(state);const frames=state.coherence.frames.filter(frame=>frame.mode==='torn'&&frame.submission>=minimumSubmission);assert(frames.length>0);
 assert(frames.some(frame=>frame.firstPresent));assert(frames.some(frame=>frame.secondPresent));
 assert(frames.every(frame=>frame.firstPresent!==frame.secondPresent),'Torn frames must never contain both complete parameters');
}
const metrics=state=>({http:state.callsTotal,ui:state.effects.length,business:state.ledger.length});
function assertNoReplay(before,after){assert.deepEqual(after.effects,before.effects);assert.deepEqual(after.ledger,before.ledger);}
function actualPrivatePlan(out,candidateId){
 const base=path.join(out,'private/native-plans'),plans=readdirSync(base).map(name=>path.join(base,name,'plan.private.json')).filter(existsSync).map(json).filter(plan=>plan.specs?.[candidateId]);assert(plans.length>0);
 const definition=plans[0].specs[candidateId];assert(plans.every(plan=>JSON.stringify(plan.specs[candidateId])===JSON.stringify(definition)));return definition;
}

async function setup(t,name){
 const dir=directory(t,name),app=await model(),out=path.join(dir,'out'),intent=path.join(dir,'journal/intent.json'),connections=[];
 const save=(name,value)=>{if(evidenceBase)put(path.join(dir,name),value);};
 t.after(async()=>{
  const cleanup=[];try{save('terminal-model.json',await app.read());}catch(error){cleanup.push({snapshotError:error.message});}
  for(const connection of [...connections].reverse()){try{cleanup.push(await connection.close());}catch(error){cleanup.push({sdkCleanupError:error.message});}}
  try{cleanup.push(await app.close());}catch(error){cleanup.push({modelCleanupError:error.message});}
  save('transcripts.json',connections.map(connection=>connection.records));save('cleanup.json',cleanup);
  assert.equal(cleanup.length,connections.length+1,JSON.stringify(cleanup));
  for(const row of cleanup){assert.equal(row.exitCode,0);assert.equal(row.signalCode,null);assert.equal(row.forced,false);assert.equal(row.stderrBytes,0);assert.equal(row.closeError??null,null);if(row.kind==='independent_android_protocol_model')assert.equal(row.portClosed,true);}
 });
 const inventory=path.join(dir,'inventory');mkdirSync(inventory,{mode:0o700});mkdirSync(path.dirname(intent),{mode:0o700});
 put(path.join(inventory,'source.json'),{format:'endpoint-inventory',schema_version:'1.1',kind:'apk',source_id:SOURCE,inventory:'endpoints.json',app:{package_name:app.ready.appId,artifact_type:'apk',version_name:'model',artifact_sha256:'a'.repeat(64)}});put(path.join(inventory,'endpoints.json'),[]);
 const controls=[['query','input'],['detail','input'],['run','button'],['result','output']].map(([id,kind])=>({id,kind,selector:'#'+id,group:'#searchForm'}));
 const device=path.join(dir,'device.json');put(device,{source:{id:SOURCE,kind:'apk'},backend:{type:'appium-webview',platform:'android',appId:app.ready.appId,url:app.ready.url,sessionId:app.ready.sessionId,intentJournal:intent,commandTimeoutMs:3000,webview:{context:app.ready.context,windowHandle:app.ready.windowHandle,origin:app.ready.origin,url:app.ready.documentUrl,controls,association:{mode:'uiautomator2_devtools_v1'},textTransport:{mode:'chromedriver_cdp_insert_text_v1'}}},limits:{maxActions:100,maxDurationMs:60000},actionAllowlist:[{kind:'type',selector:{resourceId:'#query'},effect:'read'},{kind:'type',selector:{resourceId:'#detail'},effect:'read'},{kind:'click',selector:{resourceId:'#run'},effect:'read'}]});
 const config=path.join(dir,'config.json');put(config,{outputRoot:out,artifactRoots:[dir],python:path.join(root,'.venv/bin/python'),devices:{webview:device}});
 const entry=path.join(dir,'server.mjs');writeFileSync(entry,"import {startSoftwareMcp} from "+JSON.stringify(new URL('../src/software-mcp.js',import.meta.url).href)+";import{readFileSync}from'node:fs';await startSoftwareMcp(JSON.parse(readFileSync("+JSON.stringify(config)+",'utf8')));\n",{mode:0o600});
 const main=await sdk(entry,connection=>connections.push(connection));const discovery=await terminal(main,await main.call('software_discover',{kind:'apk',input:inventory,deviceName:'webview'}));
 const plan=await main.call('software_workflows',{sourceId:SOURCE}),candidate=plan.items.find(item=>item.planningMode==='webview-dom-linear-v1');assert(candidate);
 const planned=actualPrivatePlan(out,candidate.id),inputOrder=planned.steps.filter(step=>step.kind==='type').map(step=>step.input);assert.deepEqual([...inputOrder].sort(),['detail','query']);
 const assertions=inputOrder.map(param=>({outputTargetId:candidate.outputTargets[0].id,param,changedFromBefore:true,timeoutMs:1000}));
 const bind=()=>main.call('software_bind_workflow',{sourceId:SOURCE,expectedRevision:plan.source.revision,candidateId:candidate.id,samples:[sampleA,sampleB],resultAssertions:assertions});
 const definition=operationId=>{const actual=json(path.join(out,'operations',operationId,'workflow-spec.json'));assert.deepEqual(actual.steps.filter(step=>step.kind==='type').map(step=>step.input),inputOrder);assert.deepEqual(actual.steps.filter(step=>step.kind==='assert').map(step=>step.expect.containsInput),inputOrder);return actual;};
 const mode=value=>app.setMode(value,inputOrder[0]);
 const catalog=()=>main.call('software_capabilities',{sourceId:SOURCE,kind:'mobile'});
 return {dir,out,intent,app,main,planned,inputOrder,discovery,plan,candidate,bind,definition,mode,catalog,save:value=>save('evidence.json',value),connect:entry=>sdk(entry,connection=>connections.push(connection))};
}

test('official SDK torn same-output frames reject first learning without a false ready or UI replay',{timeout:120000},async t=>{
 const f=await setup(t,'torn-learning');await f.mode('torn');const start=await f.bind(),failed=await terminal(f.main,start,'failed'),definition=f.definition(start.operationId),before=await f.app.read();
 assert.equal(failed.errorCode,'WORKFLOW_NOT_VALIDATED');assert.deepEqual(failed.webviewOutcome,outcome('unknown'));assert.equal(before.ledger.length,1);assertTorn(before,1);
 const capabilities=await f.catalog();assert.equal(capabilities.items.filter(cap=>cap.readiness==='ready').length,0);
 const privateResult=json(path.join(f.out,'operations',start.operationId,'workflow/result.json')),pending=json(f.intent);assert.equal(privateResult.ok,false);assert.deepEqual(privateResult.webviewOutcome,outcome('unknown'));assert.equal(pending.pending.status,'unknown');const pendingSha=sha(f.intent);
 const rebound=await terminal(f.main,await f.bind(),'failed'),after=await f.app.read();assert.deepEqual(rebound.webviewOutcome,outcome('unknown'));assert(JSON.stringify(rebound).includes('WEBVIEW_PENDING_UNKNOWN'));assertNoReplay(before,after);assert.equal(sha(f.intent),pendingSha);assert(after.callsTotal>before.callsTotal);assertPairs(after);
 f.save({scope:'Official SDK/production worker + external Android protocol model, not a browser/device',discovery:f.discovery,planned:f.planned,definition,failed,privateResult,pending,before,after,rebound,rebindDelta:{http:after.callsTotal-before.callsTotal,ui:0,business:0}});
});

test('official SDK stable learning followed by torn output rejects execution and blocks a fresh worker before HTTP',{timeout:120000},async t=>{
 const f=await setup(t,'torn-execution');await f.mode('stable');const learnStart=await f.bind(),learned=await terminal(f.main,learnStart),definition=f.definition(learnStart.operationId),catalog=await f.catalog(),cap=catalog.items.find(row=>row.readiness==='ready');assert(cap);assert.equal(cap.evidence.resultFreshness.assertionObservationMode,MODE);const receiptSha=sha(f.intent+'.completed.json');
 await f.mode('torn');const args={sourceId:SOURCE,capabilityId:cap.id,expectedRevision:cap.revision,params:third},failed=await terminal(f.main,await f.main.call('software_call',args)),before=await f.app.read();
 assert.equal(failed.result.result.ok,false);assert.deepEqual(failed.webviewOutcome,outcome('unknown'));assert.deepEqual(failed.result.result.webviewOutcome,outcome('unknown'));assert.equal(before.ledger.length,3);assertTorn(before,3);assert.equal(sha(f.intent+'.completed.json'),receiptSha);const pending=json(f.intent),pendingSha=sha(f.intent);assert.equal(pending.pending.status,'unknown');
 const refused=await terminal(f.main,await f.main.call('software_call',args)),after=await f.app.read();assert.equal(refused.result.result.error.code,'WEBVIEW_PENDING_UNKNOWN');assert.deepEqual(refused.webviewOutcome,outcome('unknown'));assert.equal(after.callsTotal,before.callsTotal);assertNoReplay(before,after);assert.equal(sha(f.intent),pendingSha);assertPairs(after);
 f.save({scope:'Accepted model click followed by incoherent result, not an actual-device fault',learned,definition,catalog,failed,pending,before,after,refused,newWorkerDelta:{http:0,ui:0,business:0}});
});

test('official SDK stable Unicode output remains coherent through learning unified and generated catalogs',{timeout:120000},async t=>{
 const f=await setup(t,'stable-unified-generated');await f.mode('stable');const learnStart=await f.bind(),learned=await terminal(f.main,learnStart),definition=f.definition(learnStart.operationId),catalog=await f.catalog(),cap=catalog.items.find(row=>row.readiness==='ready');assert(cap);assert.equal(cap.evidence.resultFreshness.assertionObservationMode,MODE);
 const unified=await terminal(f.main,await f.main.call('software_call',{sourceId:SOURCE,capabilityId:cap.id,expectedRevision:cap.revision,params:third}));assert.equal(unified.result.result.ok,true);assert.equal(unified.result.result.resultFreshness.assertionObservationMode,MODE);
 const generation=await terminal(f.main,await f.main.call('software_generate',{sourceId:SOURCE,expectedRevision:catalog.source.revision})),other=await f.connect(generation.result.entry),generatedCatalog=await other.call('list_capabilities');assert.deepEqual(generatedCatalog.items,catalog.items);
 const tools=await other.client.listTools(),tool=tools.tools.find(row=>row.name==='cap_'+cap.id.slice(4,24));assert(tool);const generated=await terminal(other,await other.call(tool.name,fourth),'completed','operation_status');assert.equal(generated.result.result.ok,true);assert.equal(generated.result.result.resultFreshness.assertionObservationMode,MODE);
 for(const value of [unified,generated]){assert.deepEqual(value.webviewOutcome,outcome('observed'));assert.deepEqual(value.result.result.webviewOutcome,outcome('observed'));assert(!JSON.stringify(value).includes('completionReceipt'));}
 const actual=await f.app.read();assertPairs(actual);assert.deepEqual(actual.ledger.map(({query,detail})=>({query,detail})),[sampleA,sampleB,third,fourth]);assert.equal(actual.effects.length,28);const counts=actual.effects.reduce((sum,[,kind])=>({...sum,[kind]:(sum[kind]||0)+1}),{});assert.deepEqual(counts,{clear:8,focus:8,insertText:8,click:4});assert(actual.coherence.frames.filter(frame=>frame.submission>0).every(frame=>frame.firstPresent&&frame.secondPresent));
 f.save({scope:'Fresh official SDK clients with independent protocol model, not JavaScript/browser/device execution',learned,definition,catalog,unified,generation,generatedCatalog,generated,actual,counts,finalMetrics:metrics(actual)});
});
