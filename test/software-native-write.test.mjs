import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {temp,until,root} from './helpers.mjs';

const outcome=status=>({status,automaticRetry:false});
async function call(client,name,args={}){const response=await client.callTool({name,arguments:args});assert(!response.isError,JSON.stringify(response));return response.structuredContent||JSON.parse(response.content[0].text);}
async function terminal(client,start,name='software_operation'){return until(async()=>{const value=await call(client,name,{operationId:start.operationId});return ['completed','failed','cancelled','interrupted'].includes(value.status)&&value;},30000);}
async function complete(client,start,name){const value=await terminal(client,start,name);assert.equal(value.status,'completed',JSON.stringify(value));return value;}

// The HTTP server implements the W3C wire protocol; /notes is an actual,
// independently persisted app operation. This is protocol validation, not iOS hardware.
async function fixture(t,{permissions={allowWrite:['save_note','failed_note'],allowWriteLearning:['save_note','failed_note']}}={}){
 const dir=temp(t),sourceId='native_notes',appId='com.example.native.notes';
 const store=path.join(dir,'notes.json');writeFileSync(store,'[]');
 const notes=()=>JSON.parse(readFileSync(store,'utf8'));
 const ui={body:'',result:'EMPTY',rpc:0,commands:[],suppressResult:false,failResponse:false};
 const xml=()=>`<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication"><XCUIElementTypeOther type="XCUIElementTypeOther" name="NoteForm"><XCUIElementTypeTextField type="XCUIElementTypeTextField" name="body" value="${ui.body}" x="0" y="0" width="150" height="40"/><XCUIElementTypeButton type="XCUIElementTypeButton" name="save" label="Save note" x="0" y="40" width="150" height="40"/><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="result" label="${ui.result}" x="0" y="80" width="150" height="40"/></XCUIElementTypeOther></XCUIElementTypeApplication></AppiumAUT>`;
 const server=createServer(async(req,res)=>{
  ui.rpc++;let raw='';for await(const part of req)raw+=part;const body=raw?JSON.parse(raw):{};
  const send=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({value}));};
  if(req.url==='/notes'&&req.method==='POST'){const values=notes(),record={id:values.length+1,body:body.body};values.push(record);writeFileSync(store,JSON.stringify(values));return send(record);}
  const route=req.url.replace('/session/notes','');
  if(route==='/source')return send(xml());if(route==='/execute/sync')return send({bundleId:appId});
  if(route==='/elements'){const name=['body','save'].find(value=>body.value.includes(value));return send(name?[{'element-6066-11e4-a52e-4f735466cecf':name}]:[]);}
  if(route==='/element/body/clear'){ui.commands.push('clear');ui.body='';return send(null);}
  if(route==='/element/body/value'){ui.commands.push('type');ui.body+=body.text;return send(null);}
  if(route==='/element/save/click'){
   ui.commands.push('save');const response=await fetch(`http://127.0.0.1:${server.address().port}/notes`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body:ui.body})}),saved=(await response.json()).value;
   if(!ui.suppressResult)ui.result=`SAVED:${saved.body}#${saved.id}`;
   return ui.failResponse?send({error:'unknown error'},500):send(null);
  }
  return send({error:'unknown command'},404);
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const inventory=path.join(dir,'inventory');mkdirSync(inventory);writeFileSync(path.join(inventory,'source.json'),JSON.stringify({format:'endpoint-inventory',schema_version:'1.1',kind:'ios',source_id:sourceId,inventory:'endpoints.json',app:{package_name:appId,bundle_id:appId,artifact_type:'app',version_name:'1',artifact_sha256:'a'.repeat(64)}}));writeFileSync(path.join(inventory,'endpoints.json'),'[]');
 const grant={allowWrite:['save_note','failed_note'],allowWriteLearning:['save_note','failed_note']};
 const device=path.join(dir,'device.json');writeFileSync(device,JSON.stringify({backend:{type:'webdriver',platform:'ios',url:`http://127.0.0.1:${server.address().port}`,sessionId:'notes'},limits:{maxActions:50,maxDepth:0,maxDurationMs:15000},actionAllowlist:[{kind:'type',selector:{accessibilityId:'body'},effect:'read'},{kind:'click',selector:{accessibilityId:'save'},effect:'write'}],workflowPermissions:grant}));
 const config=path.join(dir,'config.json');writeFileSync(config,JSON.stringify({outputRoot:path.join(dir,'out'),artifactRoots:[dir],python:path.join(root,'.venv/bin/python'),devices:{native:device},workflowPermissions:{[sourceId]:permissions}}));
 const definition=(changes={})=>({schemaVersion:1,id:'save_note',name:'Save native note',effect:'write',inputSchema:{type:'object',properties:{body:{type:'string',minLength:1,maxLength:40}},required:['body'],additionalProperties:false},steps:[{kind:'type',selector:{accessibilityId:'body'},input:'body',replace:true},{kind:'click',selector:{accessibilityId:'save'}},{kind:'assert',selector:{accessibilityId:'result'},expect:{containsInput:'body',changed:true},timeoutMs:150},{kind:'extract',selector:{accessibilityId:'result'},output:'result',valueType:'string'}],...changes});
 const saveSpec=(spec,name='workflow.json')=>{const file=path.join(dir,name);writeFileSync(file,JSON.stringify(spec));return file;};
 async function connect(args=[path.join(root,'src/software-mcp.js'),'--config',config]){const transport=new StdioClientTransport({command:process.execPath,args,cwd:root,stderr:'pipe'});transport.stderr.on('data',()=>{});const client=new Client({name:'native-write-official-client',version:'1'});await client.connect(transport);t.after(()=>client.close());return client;}
 const client=await connect();await complete(client,await call(client,'software_discover',{kind:'ios',input:inventory,deviceName:'native'}));assert.deepEqual(notes(),[],'discovery must not save a note');
 const revision=(await call(client,'software_sources')).sources[0].revision;
 return {dir,sourceId,config,ui,notes,client,connect,revision,definition,saveSpec};
}

test('official MCP learns native writes, generated tool saves fourth note, and failed confirmations never repeat',{timeout:90000},async t=>{
 const f=await fixture(t),{sourceId,client,ui,notes}=f,spec=f.saveSpec(f.definition());
 const bound=await complete(client,await call(client,'software_bind_workflow',{sourceId,expectedRevision:f.revision,specPath:spec,samples:[{body:'alpha'},{body:'beta'}]}));assert.deepEqual(bound.writeOutcome,outcome('observed'));assert.deepEqual(notes().map(n=>n.body),['alpha','beta']);
 const catalog=await call(client,'software_capabilities',{sourceId,kind:'mobile'}),cap=catalog.items.find(item=>item.effect==='write'&&item.evidence?.workflowObserved);assert(cap,JSON.stringify(catalog));assert.equal(cap.readiness,'ready');
 const third=await complete(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{body:'gamma'}}));assert.equal(third.result.result.outputs.result,'SAVED:gamma#3');assert.deepEqual(third.writeOutcome,outcome('observed'));
 const generated=await complete(client,await call(client,'software_generate',{sourceId,expectedRevision:catalog.source.revision})),independent=await f.connect([generated.result.entry]),tool='cap_'+cap.id.slice(4,24);
 const exposed=(await independent.listTools()).tools.find(item=>item.name===tool);assert.equal(exposed.annotations.destructiveHint,true);assert.equal(exposed.annotations.readOnlyHint,false);
 const fourth=await complete(independent,await call(independent,tool,{body:'delta'}),'operation_status');assert.equal(fourth.result.result.outputs.result,'SAVED:delta#4');assert.deepEqual(fourth.writeOutcome,outcome('observed'));assert.deepEqual(notes().map(n=>n.body),['alpha','beta','gamma','delta']);
 // Reopen the same source with learning revoked. Permissions are not part of
 // device identity, and execution must use the current startup grant.
 const executeOnlyConfig=JSON.parse(readFileSync(f.config,'utf8'));executeOnlyConfig.workflowPermissions[sourceId]={allowWrite:['save_note']};const executeOnlyFile=path.join(f.dir,'execute-only.json');writeFileSync(executeOnlyFile,JSON.stringify(executeOnlyConfig));const executeOnly=await f.connect([path.join(root,'src/software-mcp.js'),'--config',executeOnlyFile]);
 const fifth=await complete(executeOnly,await call(executeOnly,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{body:'executionOnly'}}));assert.equal(fifth.result.result.outputs.result,'SAVED:executionOnly#5');assert.deepEqual(fifth.writeOutcome,outcome('observed'));
 const revokedConfig={...executeOnlyConfig,workflowPermissions:{}};const revokedFile=path.join(f.dir,'revoked.json');writeFileSync(revokedFile,JSON.stringify(revokedConfig));const revoked=await f.connect([path.join(root,'src/software-mcp.js'),'--config',revokedFile]),beforeRevokeRpc=ui.rpc;
 const noGrant=await terminal(revoked,await call(revoked,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{body:'noGrant'}}));assert.equal(noGrant.status,'failed');assert.deepEqual(noGrant.writeOutcome,outcome('not_started'));assert.equal(ui.rpc,beforeRevokeRpc);assert.equal(notes().length,5,'cached learning snapshot cannot reauthorize revoked execution');
 for(const mode of ['assertion','transport']){
  ui.suppressResult=mode==='assertion';ui.failResponse=mode==='transport';const count=notes().length,saves=ui.commands.filter(v=>v==='save').length;
  const failed=await terminal(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{body:mode}}));assert.equal(failed.result.result.ok,false,JSON.stringify(failed));assert.deepEqual(failed.writeOutcome,outcome('unknown'));assert.equal(notes().length,count+1);assert.equal(ui.commands.filter(v=>v==='save').length,saves+1,'only the one explicit click is sent');assert.equal(failed.canResume,false);
 }
 ui.failResponse=false;ui.suppressResult=true;const count=notes().length,failedSpec=f.saveSpec(f.definition({id:'failed_note'}),'failed.json');
 const failedLearning=await terminal(client,await call(client,'software_bind_workflow',{sourceId,expectedRevision:catalog.source.revision,specPath:failedSpec,samples:[{body:'firstfail'},{body:'secondfail'}]}));assert.equal(failedLearning.status,'failed',JSON.stringify(failedLearning));assert.deepEqual(failedLearning.writeOutcome,outcome('unknown'));assert.equal(notes().length,count+1);assert.equal((await call(client,'software_sources')).sources[0].revision,catalog.source.revision);
 const commands=ui.commands.length,rpc=ui.rpc;
 const bad=await terminal(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{body:''}}));assert.equal(bad.status,'failed');assert.equal(ui.commands.length,commands);assert.equal(ui.rpc,rpc,'invalid input is rejected before native backend IO');
 const stale=await terminal(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:'0'.repeat(64),params:{body:'stale'}}));assert.equal(stale.status,'failed');assert.equal(ui.rpc,rpc);
 // A trusted definition still cannot smuggle an unapproved or unknown action.
 const unknown=f.definition();unknown.steps[1].selector={accessibilityId:'DeleteAll'};const unknownFile=f.saveSpec(unknown,'unknown.json');
 const denied=await terminal(client,await call(client,'software_bind_workflow',{sourceId,expectedRevision:catalog.source.revision,specPath:unknownFile,samples:[{body:'x'},{body:'y'}]}));assert.equal(denied.status,'failed');assert.match(denied.error,/WORKFLOW_ACTION_NOT_ALLOWLISTED/);assert.deepEqual(denied.writeOutcome,outcome('not_started'));assert.equal(ui.rpc,rpc);assert.equal(ui.commands.length,commands);
 assert(existsSync(path.join(f.dir,'notes.json')));
});

test('MCP startup permission is authoritative; forged device permissions and learning-only omissions cannot save',{timeout:90000},async t=>{
 for(const permissions of [{},{allowWrite:['save_note']},{allowWrite:['different'],allowWriteLearning:['different']}]){
  const f=await fixture(t,{permissions}),spec=f.saveSpec(f.definition()),rpc=f.ui.rpc;
  const rejected=await terminal(f.client,await call(f.client,'software_bind_workflow',{sourceId:f.sourceId,expectedRevision:f.revision,specPath:spec,samples:[{body:'alpha'},{body:'beta'}]}));assert.equal(rejected.status,'failed');assert.match(rejected.error,permissions.allowWrite?.includes('save_note')?/WORKFLOW_WRITE_LEARNING_NOT_APPROVED/:/WORKFLOW_WRITE_NOT_APPROVED/);assert.deepEqual(rejected.writeOutcome,outcome('not_started'));assert.deepEqual(f.notes(),[]);assert.deepEqual(f.ui.commands,[]);assert.equal(f.ui.rpc,rpc,'denial occurs before probe despite forged device allowWrite');
 }
});
