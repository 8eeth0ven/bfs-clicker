import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {temp,until,root} from './helpers.mjs';

async function call(client,name,args={}){const r=await client.callTool({name,arguments:args});assert(!r.isError,JSON.stringify(r));return r.structuredContent||JSON.parse(r.content[0].text);}
async function done(client,start,name='software_operation'){return until(async()=>{const r=await call(client,name,{operationId:start.operationId});if(['failed','cancelled','interrupted'].includes(r.status))throw Error(JSON.stringify(r));return r.status==='completed'&&r;},30000);}

// Real W3C HTTP pages and official MCP clients. No native device is claimed.
test('native multi-field candidate reaches observed read-prefix page, learns both fields and generates a reusable MCP tool',{timeout:90000},async t=>{
 const dir=temp(t),sourceId='ios_multi_fields',appId='com.example.nativequery';
 const ui={page:'entry',First:'',Second:'',result:'EMPTY',opens:0,backs:0,queries:[],rpc:0};
 const xml=()=>ui.page==='entry'
  ?'<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication"><XCUIElementTypeButton type="XCUIElementTypeButton" name="OpenFilters" label="Open filters" x="0" y="0" width="100" height="40"/></XCUIElementTypeApplication></AppiumAUT>'
  :`<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication"><XCUIElementTypeOther type="XCUIElementTypeOther" name="FilterForm"><XCUIElementTypeTextField type="XCUIElementTypeTextField" name="First" value="${ui.First}" x="0" y="0" width="100" height="40"/><XCUIElementTypeTextField type="XCUIElementTypeTextField" name="Second" value="${ui.Second}" x="0" y="40" width="100" height="40"/><XCUIElementTypeButton type="XCUIElementTypeButton" name="Search" label="Search" x="0" y="80" width="100" height="40"/><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="results" label="${ui.result}" x="0" y="120" width="100" height="40"/></XCUIElementTypeOther></XCUIElementTypeApplication></AppiumAUT>`;
 const server=createServer(async(req,res)=>{
  ui.rpc++;
  let raw='';for await(const part of req)raw+=part;const body=raw?JSON.parse(raw):{};
  const send=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({value}));};
  const route=req.url.replace('/session/multi','');
  if(route==='/source')return send(xml());if(route==='/execute/sync')return send({bundleId:appId});
  if(route==='/elements'){const name=['First','Second','OpenFilters','Search'].find(name=>body.value.includes(name));return send(name?[{'element-6066-11e4-a52e-4f735466cecf':name}]:[]);}
  if(route==='/element/OpenFilters/click'){Object.assign(ui,{page:'form',First:'',Second:'',result:'EMPTY'});ui.opens++;return send(null);}
  if(route==='/element/Search/click'){ui.queries.push([ui.First,ui.Second]);ui.result=ui.First+'|'+ui.Second;return send(null);}
  if(route==='/back'){ui.page='entry';ui.backs++;return send(null);}
  if(route.endsWith('/clear')){ui[route.split('/')[2]]='';return send(null);}
  if(route.endsWith('/value')){ui[route.split('/')[2]]+=body.text;return send(null);}
  res.writeHead(404);res.end('{}');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const inventory=path.join(dir,'inventory');mkdirSync(inventory);writeFileSync(path.join(inventory,'source.json'),JSON.stringify({format:'endpoint-inventory',schema_version:'1.1',kind:'ios',source_id:sourceId,inventory:'endpoints.json',app:{package_name:appId,bundle_id:appId,artifact_type:'app',version_name:'1',artifact_sha256:'a'.repeat(64)}}));writeFileSync(path.join(inventory,'endpoints.json'),'[]');
 const device=path.join(dir,'device.json');writeFileSync(device,JSON.stringify({backend:{type:'webdriver',platform:'ios',url:'http://127.0.0.1:'+server.address().port,sessionId:'multi'},limits:{maxActions:30,maxDepth:1,maxDurationMs:15000},actionAllowlist:['First','Second'].map(name=>({kind:'type',selector:{accessibilityId:name},effect:'read'}))}));
 const config=path.join(dir,'config.json');writeFileSync(config,JSON.stringify({outputRoot:path.join(dir,'out'),artifactRoots:[dir],python:path.join(root,'.venv/bin/python'),devices:{native:device}}));
 async function connect(args){const transport=new StdioClientTransport({command:process.execPath,args,cwd:root,stderr:'pipe'});transport.stderr.on('data',()=>{});const client=new Client({name:'native-multi-official-client',version:'1'});await client.connect(transport);t.after(()=>client.close());return client;}
 const client=await connect([path.join(root,'src/software-mcp.js'),'--config',config]);
 await done(client,await call(client,'software_discover',{kind:'ios',input:inventory,deviceName:'native'}));assert.equal(ui.opens,1);assert.deepEqual(ui.queries,[]);
 ui.page='entry';
 const plan=await call(client,'software_workflows',{sourceId}),candidate=plan.items.find(item=>item.evidence.prefixLength===1);
 assert(candidate,JSON.stringify(plan));assert.deepEqual(Object.keys(candidate.inputSchema.properties),['First','Second']);assert.equal(candidate.readiness,'candidate');assert(!JSON.stringify(plan).includes('accessibilityId'));assert.deepEqual(ui.queries,[]);
 const resultAssertions=['First','Second'].map(param=>({outputTargetId:candidate.outputTargets[0].id,param}));
 const base={sourceId,expectedRevision:plan.source.revision,candidateId:candidate.id,samples:[{First:'alpha',Second:'one'},{First:'beta',Second:'two'}]};
 const beforeMutations=()=>JSON.stringify({queries:ui.queries,opens:ui.opens,backs:ui.backs});
 const unchanged=beforeMutations();
 async function rejected(arguments_,expected){const start=await call(client,'software_bind_workflow',arguments_);const failed=await until(async()=>{const state=await call(client,'software_operation',{operationId:start.operationId});if(state.status==='completed')throw Error(JSON.stringify(state));return state.status==='failed'&&state;},30000);assert.match(failed.error,expected);assert.equal(beforeMutations(),unchanged);assert.equal((await call(client,'software_sources')).sources[0].revision,plan.source.revision);}
 await rejected({...base,resultAssertions:resultAssertions.slice(0,1)},/WORKFLOW_ASSERTION_REQUIRED/);
 await rejected({...base,outputTargetId:candidate.outputTargets[0].id,assertParam:'First'},/WORKFLOW_ASSERTION_REQUIRED/);
 await rejected({...base,resultAssertions:resultAssertions.map((rule,index)=>index?rule:{...rule,outputTargetId:'output_'+'0'.repeat(64)})},/WORKFLOW_ASSERTION_REQUIRED/);
 for(const unsupported of [{representation:'optionLabel'},{valueMap:{alpha:'ALPHA'}},{separator:','}])await rejected({...base,resultAssertions:resultAssertions.map((rule,index)=>index?rule:{...rule,...unsupported})},/WORKFLOW_REPRESENTATION_UNSUPPORTED/);
 const rpc=ui.rpc;await rejected({...base,expectedRevision:'f'.repeat(64),resultAssertions},/SOURCE_CHANGED/);assert.equal(ui.rpc,rpc,'stale source revision rejects before any native probe');
 let injection;try{injection=await client.callTool({name:'software_bind_workflow',arguments:{...base,resultAssertions:resultAssertions.map((rule,index)=>index?rule:{...rule,selector:{accessibilityId:'Delete'}})}});}catch(error){injection={isError:true};}
 assert.equal(injection.isError,true,'caller cannot supply a raw native selector');assert.equal(beforeMutations(),unchanged);
 await done(client,await call(client,'software_bind_workflow',{sourceId,expectedRevision:plan.source.revision,candidateId:candidate.id,samples:[{First:'alpha',Second:'one'},{First:'beta',Second:'two'}],resultAssertions}));
 const catalog=await call(client,'software_capabilities',{sourceId,kind:'mobile'}),cap=catalog.items.find(item=>item.inputSchema.properties.First&&item.inputSchema.properties.Second);assert(cap,JSON.stringify(catalog));assert.equal(cap.readiness,'ready');
 const executed=await done(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{First:'gamma',Second:'three'}}));assert.equal(executed.result.result.outputs.result,'gamma|three');
 const generated=await done(client,await call(client,'software_generate',{sourceId,expectedRevision:catalog.source.revision})),independent=await connect([generated.result.entry]);
 const fourth=await done(independent,await call(independent,'cap_'+cap.id.slice(4,24),{First:'delta',Second:'four'}),'operation_status');assert.equal(fourth.result.result.outputs.result,'delta|four');
 assert.deepEqual(ui.queries,[['alpha','one'],['beta','two'],['gamma','three'],['delta','four']]);assert(ui.backs>=3);assert(ui.opens>=5);
});
