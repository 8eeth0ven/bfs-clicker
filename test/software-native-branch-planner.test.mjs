import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {root,temp,until} from './helpers.mjs';

async function call(client,name,args={}){const reply=await client.callTool({name,arguments:args});assert(!reply.isError,JSON.stringify(reply));return reply.structuredContent||JSON.parse(reply.content[0].text)}
async function finish(client,started,tool='software_operation'){return until(async()=>{const state=await call(client,tool,{operationId:started.operationId});if(['failed','cancelled','interrupted'].includes(state.status))throw Error(JSON.stringify(state));return state.status==='completed'&&state},40000)}
async function fail(client,started,code){const state=await until(async()=>{const row=await call(client,'software_operation',{operationId:started.operationId});assert.notEqual(row.status,'completed','Negative binding or call unexpectedly completed');return row.status==='failed'&&row},20000);assert(JSON.stringify(state).includes(code),JSON.stringify(state));return state}
async function connect(entry,config){
 const transport=new StdioClientTransport({command:process.execPath,args:[entry,...(config?['--config',config]:[])],cwd:root,stderr:'pipe'});let stderr='';transport.stderr.on('data',b=>stderr+=b);
 const client=new Client({name:'native-branch-fixture-client',version:'1'});await client.connect(transport);const child=transport._process;
 return{client,async close(){await client.close();if(child.exitCode===null&&child.signalCode===null)await once(child,'close');assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);assert.equal(stderr,'')}};
}
async function fixture(platform){
 const child=spawn(path.join(root,'.venv/bin/python'),[path.join(root,'test/native-branch-fixture.py'),platform],{cwd:root,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONPATH:[path.join(root,'apk_tools'),path.join(root,'apk_tools/tests')].join(path.delimiter)},stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);
 const lines=createInterface({input:child.stdout}),next=()=>once(lines,'line').then(([line])=>JSON.parse(line));const first=await next();
 const request=async value=>{const response=next();child.stdin.write(JSON.stringify(value)+'\n');return response};
 return{...first,read:()=>request({action:'snapshot'}),set:values=>request({action:'set',values}),async close(){child.stdin.end(JSON.stringify({action:'quit'})+'\n');if(child.exitCode===null&&child.signalCode===null)await once(child,'close');lines.close();assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);assert.equal(stderr,'')}};
}
const inputs=(route,query,detail)=>({route,query,detail});
const result=(value,count)=>'RESULT '+value.query+' / '+value.detail+' / '+value.route+' ;COUNT:'+count;
const uiWrite=([method,url])=>method==='POST'&&(/\/element\/[^/]+\/(click|clear|value)$/.test(url)||url.endsWith('/back')||url.endsWith('/actions'));

for(const platform of ['android','ios'])test('observed native UI branches -> four samples -> unified/generated both arms '+platform,{timeout:120000},async t=>{
 const dir=temp(t),app=await fixture(platform),sourceId='branch_fixture',kind=platform==='android'?'apk':'ios',clients=[];
 t.after(async()=>{for(const row of clients.reverse())await row.close();await app.close()});
 const inventory=path.join(dir,'inventory');mkdirSync(inventory);writeFileSync(path.join(inventory,'source.json'),JSON.stringify({format:'endpoint-inventory',schema_version:'1.1',kind,source_id:sourceId,inventory:'endpoints.json',app:{package_name:'com.example.branches',...(kind==='ios'?{bundle_id:'com.example.branches'}:{}),artifact_type:kind==='ios'?'app':'apk',version_name:'1',...(kind==='ios'?{artifact_sha256:'a'.repeat(64)}:{apk_sha256:'a'.repeat(64)})}}));writeFileSync(path.join(inventory,'endpoints.json'),'[]');
 const device=path.join(dir,'device.json');writeFileSync(device,JSON.stringify(app.config));const config=path.join(dir,'config.json');writeFileSync(config,JSON.stringify({outputRoot:path.join(dir,'out'),artifactRoots:[dir],python:path.join(root,'.venv/bin/python'),devices:{native:device}}));
 const unified=await connect(path.join(root,'src/software-mcp.js'),config);clients.push(unified);
 await finish(unified.client,await call(unified.client,'software_discover',{kind,input:inventory,deviceName:'native'}));
 const before=await app.read();assert.equal(before.business.length,2);assert.deepEqual(before.business.map(row=>row.route),['left','right']);
 const plan=await call(unified.client,'software_workflows',{sourceId}),again=await call(unified.client,'software_workflows',{sourceId});const candidate=plan.items.find(item=>item.planningMode==='native-branch-stages-v1');assert(candidate,JSON.stringify(plan));assert.equal(again.items.find(item=>item.planningMode==='native-branch-stages-v1').id,candidate.id);assert.equal(candidate.readiness,'candidate');assert.deepEqual(Object.keys(candidate.inputSchema.properties).sort(),['detail','query','route']);assert(!JSON.stringify(plan).includes('seed-query'));assert(!JSON.stringify(plan).includes('selector'));
 const afterPlan=await app.read();assert.equal(afterPlan.business.length,2);assert.equal(afterPlan.nextCount,before.nextCount);assert(!afterPlan.calls.slice(before.calls.length).some(uiWrite));
 const assertions=['query','route','detail'].map(param=>({outputTargetId:candidate.outputTargets[0].id,param,changedFromBefore:true}));
 const samples=[inputs('left','alpha','one'),inputs('left','beta','two'),inputs('right','gamma','three'),inputs('right','delta','four')];
 const forged=path.join(dir,'forged-branch-plan.json');writeFileSync(forged,JSON.stringify({schemaVersion:1,effect:'read',branchPlan:{schemaVersion:1}}));
 await fail(unified.client,await call(unified.client,'software_bind_workflow',{sourceId,expectedRevision:plan.source.revision,specPath:forged,samples}),'NATIVE_BRANCH_SPEC_PATH_UNSUPPORTED');
 await fail(unified.client,await call(unified.client,'software_bind_workflow',{sourceId,expectedRevision:plan.source.revision,candidateId:candidate.id,samples,resultAssertions:assertions.slice(1)}),'WORKFLOW_ASSERTION_REQUIRED');
 await fail(unified.client,await call(unified.client,'software_bind_workflow',{sourceId,expectedRevision:plan.source.revision,candidateId:candidate.id,samples:samples.slice(0,3),resultAssertions:assertions}),'NATIVE_BRANCH');
 const denied=await app.read();assert.equal(denied.business.length,2);assert(!denied.calls.slice(afterPlan.calls.length).some(uiWrite));
 await finish(unified.client,await call(unified.client,'software_bind_workflow',{sourceId,expectedRevision:plan.source.revision,candidateId:candidate.id,samples,resultAssertions:assertions}));
 const catalog=await call(unified.client,'software_capabilities',{sourceId,kind:'mobile'}),cap=catalog.items.find(row=>row.inputSchema.properties.detail);assert(cap,JSON.stringify(catalog));assert.equal(cap.readiness,'ready');assert.deepEqual(cap.modality.channels,['fixed_ui_actions','native_semantic']);assert.deepEqual(cap.fidelity.inputText.map(row=>row.parameter).sort(),['detail','query']);assert(cap.fidelity.limits.includes('native_branch_each_arm_requires_two_observed_samples'));
 const unifiedSamples=[inputs('left',' 上 海 ','海🙂e\u0301'),inputs('right','six','六')];
 for(const [index,value]of unifiedSamples.entries()){const outcome=await finish(unified.client,await call(unified.client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:value}));assert.equal(outcome.result.result.outputs.result,result(value,7+index));}
 const generated=await finish(unified.client,await call(unified.client,'software_generate',{sourceId,expectedRevision:catalog.source.revision}));const independent=await connect(generated.result.entry);clients.push(independent);const generatedCatalog=await call(independent.client,'list_capabilities');assert.deepEqual(generatedCatalog.items.map(row=>[row.id,row.revision,row.readiness,row.modality,row.fidelity]),catalog.items.map(row=>[row.id,row.revision,row.readiness,row.modality,row.fidelity]));
 const generatedSamples=[inputs('left','seven','seven detail'),inputs('right','eight','eight detail')];
 for(const [index,value]of generatedSamples.entries()){const outcome=await finish(independent.client,await call(independent.client,'cap_'+cap.id.slice(4,24),value),'operation_status');assert.equal(outcome.result.result.outputs.result,result(value,9+index));}
 const actual=await app.read();assert.equal(actual.business.length,10);assert.equal(actual.searchCount,10);assert.deepEqual(actual.business.slice(2),[...samples,...unifiedSamples,...generatedSamples]);
 await app.set({wrongRoute:true});const start=await app.read();const rejected=await finish(unified.client,await call(unified.client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:inputs('left','must-stop','no submit')}));assert.equal(rejected.result.result.ok,false,JSON.stringify(rejected));assert(JSON.stringify(rejected).includes('NATIVE_BRANCH_ROUTE_INPUT_MISMATCH'),JSON.stringify(rejected));
 const stopped=await app.read();assert.equal(stopped.business.length,10);assert.equal(stopped.searchCount,10);assert.equal(stopped.nextCount,start.nextCount+1);const calls=stopped.calls.slice(start.calls.length),fork=calls.findIndex(([method,url])=>method==='POST'&&/\/element\/\d+_next\/click$/.test(url));assert(fork>=0);assert(!calls.slice(fork+1).some(uiWrite));
});
