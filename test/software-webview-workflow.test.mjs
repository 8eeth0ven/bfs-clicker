import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {root,temp,until} from './helpers.mjs';

const put=(file,value)=>writeFileSync(file,JSON.stringify(value),{mode:0o600});
async function call(client,name,args={}){
 const reply=await client.callTool({name,arguments:args});assert(!reply.isError,JSON.stringify(reply));
 return reply.structuredContent||JSON.parse(reply.content[0].text);
}
async function terminal(client,operation,status='completed',tool='software_operation'){
 return until(async()=>{const row=await call(client,tool,{operationId:operation.operationId});if(['completed','failed','cancelled','interrupted'].includes(row.status)){assert.equal(row.status,status,JSON.stringify(row));return row}},45000);
}
async function connect(entry,config){
 const transport=new StdioClientTransport({command:process.execPath,args:[entry,...(config?['--config',config]:[])],cwd:root,stderr:'pipe'});
 let stderr='';transport.stderr.on('data',bytes=>stderr+=bytes);
 const client=new Client({name:'protocol-webview-workflow-client',version:'1'});await client.connect(transport);const child=transport._process;
 return {client,async close(){await client.close();if(child.exitCode===null&&child.signalCode===null)await once(child,'close');assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);assert.equal(stderr,'')}};
}
async function fixture(){
 const child=spawn(path.join(root,'.venv/bin/python'),['-B',path.join(root,'test/webview-fixture.py')],{cwd:root,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);const lines=createInterface({input:child.stdout});
 const next=()=>once(lines,'line').then(([line])=>JSON.parse(line)),first=await next();
 assert.equal(first.ok,true);assert.equal(first.protocolModelOnly,true);assert.equal(first.productionImports,0);
 const request=async value=>{const pending=next();child.stdin.write(JSON.stringify(value)+'\n');const result=await pending;assert.equal(result.ok,true);return result};
 return {...first,read:async()=> (await request({op:'snapshot'})).snapshot,set:changes=>request({op:'set',changes}),async close(){await request({op:'quit'});child.stdin.end();if(child.exitCode===null&&child.signalCode===null)await once(child,'close');lines.close();assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);assert.equal(stderr,'')}};
}
async function setup(t,{pidProfile=false}={}){
 const dir=temp(t),app=await fixture(),clients=[];
 t.after(async()=>{for(const row of clients.reverse())await row.close();await app.close()});
 const association=pidProfile?{mode:'xcuitest_app_main_pid_v1',reportedBundleId:'process-ProtocolFixture'}:undefined;
 if(association)await app.set({bundleId:association.reportedBundleId,pid:7});
 const inventory=path.join(dir,'inventory');mkdirSync(inventory);mkdirSync(path.join(dir,'journal'),{mode:0o700});
 put(path.join(inventory,'source.json'),{format:'endpoint-inventory',schema_version:'1.1',kind:'ios',source_id:'webview_fixture',inventory:'endpoints.json',app:{package_name:app.ready.appId,bundle_id:app.ready.appId,artifact_type:'app',version_name:'1',artifact_sha256:'a'.repeat(64)}});put(path.join(inventory,'endpoints.json'),[]);
 const wanted=id=>({resourceId:'#'+id});
 const controls=[['query','input'],['detail','input'],['run','button'],['result','output']].map(([id,kind])=>({id,kind,selector:'#'+id,group:'#searchForm'}));
 const device=path.join(dir,'device.json');put(device,{source:{id:'webview_fixture',kind:'ios'},backend:{type:'appium-webview',platform:'ios',appId:app.ready.appId,url:app.ready.url,sessionId:app.ready.sessionId,intentJournal:path.join(dir,'journal','intent.json'),commandTimeoutMs:3000,webview:{context:app.ready.context,windowHandle:app.ready.windowHandle,origin:app.ready.origin,url:app.ready.documentUrl,controls,...(association?{association}:{})}},limits:{maxActions:100,maxDurationMs:60000},actionAllowlist:[{kind:'type',selector:wanted('query'),effect:'read'},{kind:'type',selector:wanted('detail'),effect:'read'},{kind:'click',selector:wanted('run'),effect:'read'}]});
 const config=path.join(dir,'config.json');put(config,{outputRoot:path.join(dir,'out'),artifactRoots:[dir],python:path.join(root,'.venv/bin/python'),devices:{webview:device}});
 const main=await connect(path.join(root,'src/software-mcp.js'),config);clients.push(main);
 await terminal(main.client,await call(main.client,'software_discover',{kind:'ios',input:inventory,deviceName:'webview'}));
 const plan=await call(main.client,'software_workflows',{sourceId:'webview_fixture'}),candidate=plan.items.find(row=>row.planningMode==='webview-dom-linear-v1');assert(candidate,JSON.stringify(plan));
 const assertions=['query','detail'].map(param=>({outputTargetId:candidate.outputTargets[0].id,param}));
 const bind=extra=>call(main.client,'software_bind_workflow',{sourceId:'webview_fixture',expectedRevision:plan.source.revision,candidateId:candidate.id,samples:[{query:'alpha',detail:'one'},{query:'beta',detail:'two'}],resultAssertions:assertions,...extra});
 return {dir,app,clients,client:main.client,plan,candidate,assertions,bind};
}
const text=p=>'Query:'+p.query+';Detail:'+p.detail;
test('protocol fixture: observed PID-associated WebView form learns and remains callable through unified and generated MCP',{timeout:120000},async t=>{
 const f=await setup(t,{pidProfile:true}),before=await f.app.read();assert.equal(before.ledger.length,0);assert.equal(before.effects.length,0);
 assert.deepEqual(Object.keys(f.candidate.inputSchema.properties).sort(),['detail','query']);
 assert(!JSON.stringify(f.plan).includes('sourceIdentity'));assert(!JSON.stringify(f.plan).includes('resourceId'));
 const forged=path.join(f.dir,'forged.json');put(forged,{schemaVersion:1,webviewPlan:{schemaVersion:1}});
 for(const [args,code]of [[{specPath:forged,candidateId:undefined},'WEBVIEW_SPEC_PATH_UNSUPPORTED'],[{resultAssertions:f.assertions.slice(1)},'WORKFLOW_ASSERTION_REQUIRED'],[{resultAssertions:f.assertions.map(row=>({...row,changedFromBefore:false}))},'WEBVIEW_FRESHNESS_REQUIRED']]){
  const denied=await terminal(f.client,await f.bind(args),'failed');assert(JSON.stringify(denied).includes(code),JSON.stringify(denied));
 }
 assert.equal((await f.app.read()).effects.length,0);
 await terminal(f.client,await f.bind({}));
 const catalog=await call(f.client,'software_capabilities',{sourceId:'webview_fixture',kind:'mobile'}),cap=catalog.items.find(row=>row.readiness==='ready');assert(cap,JSON.stringify(catalog));
 assert.deepEqual(cap.modality.channels,['appium_webview_dom','fixed_w3c_element_commands']);assert.equal(cap.fidelity.inputText.length,2);assert(cap.fidelity.inputText.every(row=>row.contract==='dom_value_echo_required'));assert(cap.fidelity.outputs.every(row=>row.sourceCodepointsProven===false));
 const third={query:' 上  海 ',detail:'海🙂e\u0301'};
 const result=await terminal(f.client,await call(f.client,'software_call',{sourceId:'webview_fixture',capabilityId:cap.id,expectedRevision:cap.revision,params:third}));assert.equal(result.result.result.ok,true,JSON.stringify(result));assert.equal(result.result.result.outputs.result,text(third));
 const generated=await terminal(f.client,await call(f.client,'software_generate',{sourceId:'webview_fixture',expectedRevision:catalog.source.revision})),other=await connect(generated.result.entry);f.clients.push(other);
 const otherCatalog=await call(other.client,'list_capabilities');assert.deepEqual(otherCatalog.items.map(row=>[row.id,row.revision,row.modality,row.fidelity]),catalog.items.map(row=>[row.id,row.revision,row.modality,row.fidelity]));
 const fourth={query:' 北 京 ',detail:'🙂e\u0301 终 '};const last=await terminal(other.client,await call(other.client,'cap_'+cap.id.slice(4,24),fourth),'completed','operation_status');assert.equal(last.result.result.outputs.result,text(fourth));
 const actual=await f.app.read();assert.equal(actual.ledger.length,4);assert.deepEqual(actual.ledger.map(({query,detail})=>({query,detail})),[{query:'alpha',detail:'one'},{query:'beta',detail:'two'},third,fourth]);
 await f.app.set({context:'NATIVE_APP'});const paused=await f.app.read();const rejected=await terminal(f.client,await call(f.client,'software_call',{sourceId:'webview_fixture',capabilityId:cap.id,expectedRevision:cap.revision,params:{query:'must-stop',detail:'other'}}));assert.equal(rejected.result.result.ok,false);assert.equal((await f.app.read()).effects.length,paused.effects.length);
});
test('protocol fixture: an uncertain WebView submission blocks a fresh worker without HTTP replay',{timeout:120000},async t=>{
 const f=await setup(t);await terminal(f.client,await f.bind({}));const catalog=await call(f.client,'software_capabilities',{sourceId:'webview_fixture',kind:'mobile'}),cap=catalog.items.find(row=>row.readiness==='ready');
 await f.app.set({failCommand:'click'});const params={query:'once',detail:'only'};
 const failed=await terminal(f.client,await call(f.client,'software_call',{sourceId:'webview_fixture',capabilityId:cap.id,expectedRevision:cap.revision,params}));assert.equal(failed.result.result.ok,false);const before=await f.app.read();assert.equal(before.ledger.length,3);
 const refused=await terminal(f.client,await call(f.client,'software_call',{sourceId:'webview_fixture',capabilityId:cap.id,expectedRevision:cap.revision,params}));assert.equal(refused.result.result.ok,false);assert(JSON.stringify(refused).includes('WEBVIEW_PENDING_UNKNOWN'));
 const after=await f.app.read();assert.equal(after.callsTotal,before.callsTotal);assert.deepEqual(after.ledger,before.ledger);assert.deepEqual(after.effects,before.effects);
});
