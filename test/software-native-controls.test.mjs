import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {temp,until,root} from './helpers.mjs';

async function call(client,name,args={}){const r=await client.callTool({name,arguments:args});assert(!r.isError,JSON.stringify(r));return r.structuredContent||JSON.parse(r.content[0].text);}
async function terminal(client,start,name='software_operation'){return until(async()=>{const r=await call(client,name,{operationId:start.operationId});return ['completed','failed','cancelled','interrupted'].includes(r.status)&&r;},30000);}
async function done(client,start,name){const r=await terminal(client,start,name);assert.equal(r.status,'completed',JSON.stringify(r));assert.notEqual(r.result?.result?.ok,false,JSON.stringify(r));return r;}

// Actual local W3C HTTP transport using Android/iOS UI XML. This fixture is not
// an emulator, an Appium server, or evidence of execution on physical iOS.
async function controls(t,platform,{write=false}={}){
 const dir=temp(t),sourceId='controls_'+platform,appId='com.example.controls',kind=platform==='android'?'apk':'ios';
 const ui={Query:'',IncludeArchived:false,OnlyActive:false,taps:[],queries:[],rpc:0,types:0,readonly:false,missing:false,duplicate:false,disconnect:false,freeze:false};
 const identify=name=>platform==='android'?{resourceId:appId+':id/'+name}:{accessibilityId:name};
 const xml=()=>{
  const check=name=>platform==='android'?`<node package="${appId}" resource-id="${appId}:id/${name}" class="android.widget.${name==='IncludeArchived'?'CheckBox':'Switch'}" checkable="true" checked="${ui.missing?'mixed':ui[name]}" readonly="${ui.readonly}" text="${name}" clickable="true" bounds="[0,40][200,80]"/>`:`<XCUIElementTypeSwitch type="XCUIElementTypeSwitch" name="${name}" value="${ui.missing?'mixed':ui[name]?'1':'0'}" readonly="${ui.readonly}" label="${name}" x="0" y="40" width="200" height="40"/>`;
  if(platform==='android')return `<hierarchy><node package="${appId}" resource-id="${appId}:id/Filters" class="android.widget.LinearLayout" bounds="[0,0][300,400]"><node package="${appId}" resource-id="${appId}:id/Query" class="android.widget.EditText" text="${ui.Query}" bounds="[0,0][200,40]"/>${check('IncludeArchived')}${ui.duplicate?check('IncludeArchived'):''}${check('OnlyActive')}<node package="${appId}" resource-id="${appId}:id/Search" class="android.widget.Button" text="Search" clickable="true" bounds="[0,120][200,160]"/><node package="${appId}" resource-id="${appId}:id/queryResult" class="android.widget.TextView" text="q:${ui.Query}" bounds="[0,160][200,200]"/><node package="${appId}" resource-id="${appId}:id/archivedResult" class="android.widget.TextView" text="${ui.IncludeArchived}" bounds="[0,200][200,240]"/><node package="${appId}" resource-id="${appId}:id/activeResult" class="android.widget.TextView" text="${ui.OnlyActive}" bounds="[0,240][200,280]"/></node></hierarchy>`;
  return `<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication"><XCUIElementTypeOther type="XCUIElementTypeOther" name="Filters"><XCUIElementTypeTextField type="XCUIElementTypeTextField" name="Query" value="${ui.Query}" x="0" y="0" width="200" height="40"/>${check('IncludeArchived')}${ui.duplicate?check('IncludeArchived'):''}${check('OnlyActive')}<XCUIElementTypeButton type="XCUIElementTypeButton" name="Search" label="Search" x="0" y="120" width="200" height="40"/><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="queryResult" label="q:${ui.Query}" x="0" y="160" width="200" height="40"/><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="archivedResult" label="${ui.IncludeArchived}" x="0" y="200" width="200" height="40"/><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="activeResult" label="${ui.OnlyActive}" x="0" y="240" width="200" height="40"/></XCUIElementTypeOther></XCUIElementTypeApplication></AppiumAUT>`;
 };
 const server=createServer(async(req,res)=>{
  ui.rpc++;let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{},route=req.url.replace('/session/controls','');
  const send=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({value}));};
  if(route==='/source')return send(xml());if(route==='/appium/device/current_package')return send(appId);if(route==='/execute/sync')return send({bundleId:appId});
  if(route==='/elements'){const name=['Query','IncludeArchived','OnlyActive','Search'].find(name=>body.value.includes(name));return send(name?[{'element-6066-11e4-a52e-4f735466cecf':name}]:[]);}
  if(route==='/element/Query/clear'){ui.types++;ui.Query='';return send(null);}if(route==='/element/Query/value'){ui.types++;ui.Query+=body.text;return send(null);}
  if(route==='/element/Search/click'){ui.queries.push({Query:ui.Query,IncludeArchived:ui.IncludeArchived,OnlyActive:ui.OnlyActive});return send(null);}
  const name=['IncludeArchived','OnlyActive'].find(name=>route==='/element/'+name+'/click');if(name){ui.taps.push(name);if(!ui.freeze)ui[name]=!ui[name];if(ui.disconnect){req.socket.destroy();return;}return send(null);}
  res.writeHead(404);res.end('{}');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const inventory=path.join(dir,'inventory');mkdirSync(inventory);writeFileSync(path.join(inventory,'source.json'),JSON.stringify({format:'endpoint-inventory',schema_version:'1.1',kind,source_id:sourceId,inventory:'endpoints.json',app:{package_name:appId,bundle_id:appId,artifact_type:kind==='apk'?'apk':'app',version_name:'1',artifact_sha256:'a'.repeat(64)}}));writeFileSync(path.join(inventory,'endpoints.json'),'[]');
 const device=path.join(dir,'device.json');writeFileSync(device,JSON.stringify({backend:{type:'webdriver',platform,url:'http://127.0.0.1:'+server.address().port,sessionId:'controls'},limits:{maxDepth:0,maxActions:50,maxDurationMs:15000},actionAllowlist:[{kind:'type',selector:identify('Query'),effect:'read'},{kind:'check',selector:identify('IncludeArchived'),effect:write?'write':'read'},{kind:'check',selector:identify('OnlyActive'),effect:'read'}]}));
 const config=path.join(dir,'config.json');writeFileSync(config,JSON.stringify({outputRoot:path.join(dir,'out'),artifactRoots:[dir],python:path.join(root,'.venv/bin/python'),devices:{native:device},workflowPermissions:write?{[sourceId]:{allowWrite:['set_archived'],allowWriteLearning:['set_archived']}}:{}}));
 async function connect(args=[path.join(root,'src/software-mcp.js'),'--config',config]){const transport=new StdioClientTransport({command:process.execPath,args,cwd:root,stderr:'pipe'});transport.stderr.on('data',()=>{});const client=new Client({name:'native-controls-official-client',version:'1'});await client.connect(transport);t.after(()=>client.close());return client;}
 const client=await connect();await done(client,await call(client,'software_discover',{kind,input:inventory,deviceName:'native'}));assert.deepEqual(ui.taps,[]);return {dir,ui,sourceId,client,connect,identify};
}

test('official MCP Android/iOS mixed controls bind booleans and generated calls preserve same-state no-op',{timeout:90000},async t=>{
 for(const platform of ['android','ios']){
  const f=await controls(t,platform),{ui,client,sourceId}=f,plan=await call(client,'software_workflows',{sourceId}),candidate=plan.items.find(item=>item.inputSchema.properties.Query&&item.inputSchema.properties.IncludeArchived&&item.inputSchema.properties.OnlyActive);assert(candidate,JSON.stringify(plan));assert.equal(candidate.inputSchema.properties.IncludeArchived.type,'boolean');assert.equal(candidate.outputTargets.length,3);assert(!JSON.stringify(plan).includes('selector'));assert.deepEqual(ui.taps,[]);
  const samples=[{Query:'alpha',IncludeArchived:true,OnlyActive:false},{Query:'beta',IncludeArchived:false,OnlyActive:true}],resultAssertions=['Query','IncludeArchived','OnlyActive'].map((param,index)=>({param,outputTargetId:candidate.outputTargets[index].id}));
  const bad=await terminal(client,await call(client,'software_bind_workflow',{sourceId,expectedRevision:plan.source.revision,candidateId:candidate.id,samples:[{...samples[0],IncludeArchived:'true'},samples[1]],resultAssertions}));assert.equal(bad.status,'failed');assert.deepEqual(ui.taps,[]);assert.equal(ui.types,0);assert.deepEqual(ui.queries,[]);
  await done(client,await call(client,'software_bind_workflow',{sourceId,expectedRevision:plan.source.revision,candidateId:candidate.id,samples,resultAssertions}));assert.equal(ui.taps.length,3);
  const catalog=await call(client,'software_capabilities',{sourceId,kind:'mobile'}),cap=catalog.items.find(item=>item.evidence?.workflowObserved&&item.inputSchema.properties.IncludeArchived);assert(cap,JSON.stringify(catalog));assert.equal(cap.effect,'read');const params={Query:'gamma',IncludeArchived:true,OnlyActive:false};
  const third=await done(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params}));assert.deepEqual(third.result.result.outputs,{result_1:'q:gamma',result_2:'true',result_3:'false'});assert.deepEqual(third.result.result.checkStateVerifications,{changed:2,noOp:0});assert.equal(ui.taps.length,5);
  const generated=await done(client,await call(client,'software_generate',{sourceId,expectedRevision:catalog.source.revision})),independent=await f.connect([generated.result.entry]);const fourth=await done(independent,await call(independent,'cap_'+cap.id.slice(4,24),{...params,Query:'delta'}),'operation_status');assert.deepEqual(fourth.result.result.outputs,{result_1:'q:delta',result_2:'true',result_3:'false'});assert.equal(ui.taps.length,5);assert.deepEqual(fourth.result.result.checkStateVerifications,{changed:0,noOp:2});assert.equal(ui.queries.length,4);
  const beforeInvalid=ui.rpc;const invalid=await terminal(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{...params,OnlyActive:1}}));assert.equal(invalid.status,'failed');assert.equal(ui.rpc,beforeInvalid);assert.equal(ui.taps.length,5);
  for(const defect of ['readonly','missing','duplicate']){
   ui[defect]=true;const taps=ui.taps.length,types=ui.types,queryCount=ui.queries.length,result=await terminal(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{...params,IncludeArchived:false}}));assert(result.status==='failed'||result.result?.result?.ok===false,JSON.stringify(result));assert.equal(ui.taps.length,taps);assert.equal(ui.types,types,'check preflight rejects before text mutation');assert.equal(ui.queries.length,queryCount);ui[defect]=false;
  }
 }
});

test('write-authorized W3C check persists intent and disconnect after one tap returns unknown without retry',{timeout:60000},async t=>{
 const f=await controls(t,'ios',{write:true}),{client,sourceId,ui}=f,sources=await call(client,'software_sources');
 const spec={schemaVersion:1,id:'set_archived',effect:'write',inputSchema:{type:'object',properties:{archived:{type:'boolean'}},required:['archived'],additionalProperties:false},steps:[{kind:'check',selector:f.identify('IncludeArchived'),input:'archived'},{kind:'assert',selector:f.identify('archivedResult'),expect:{equalsInput:'archived'}},{kind:'extract',selector:f.identify('archivedResult'),output:'archived',valueType:'boolean'}]};const file=path.join(f.dir,'write.json');writeFileSync(file,JSON.stringify(spec));
 await done(client,await call(client,'software_bind_workflow',{sourceId,expectedRevision:sources.sources[0].revision,specPath:file,samples:[{archived:true},{archived:false}]}));const catalog=await call(client,'software_capabilities',{sourceId,kind:'mobile'}),cap=catalog.items.find(item=>item.effect==='write'&&item.evidence?.workflowObserved);assert(cap);assert.equal(ui.taps.length,2);
 ui.disconnect=true;const lost=await terminal(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{archived:true}}));assert.deepEqual(lost.writeOutcome,{status:'unknown',automaticRetry:false});assert.equal(ui.taps.length,3);assert.equal(ui.IncludeArchived,true);assert.equal(lost.canResume,false);
 ui.disconnect=false;const noop=await done(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{archived:true}}));assert.equal(ui.taps.length,3);assert.equal(noop.result.result.executionObserved,false);assert.deepEqual(noop.result.result.checkStateVerifications,{changed:0,noOp:1});
});
