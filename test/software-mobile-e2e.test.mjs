import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const project=path.resolve(import.meta.dirname,'..');
const appId='com.example.iosworkflow',sourceId='ios_workflow_fixture';
const data=reply=>reply.structuredContent??JSON.parse(reply.content.find(item=>item.type==='text').text);
async function call(client,name,args={}){const reply=await client.callTool({name,arguments:args});assert.ok(!reply.isError,JSON.stringify(reply));return data(reply);}
async function finished(client,operationId,name='software_operation'){
 const deadline=Date.now()+25000;
 while(Date.now()<deadline){const result=await call(client,name,{operationId});if(['completed','failed','cancelled','interrupted'].includes(result.status))return result;await delay(40);}
 throw new Error('MCP mobile fixture operation timeout');
}

// Real HTTP commands and stdio clients; the server is a UI protocol fixture,
// not a running iPhone application or an Appium/WDA device deployment.
test('official MCP: iOS inventory + trusted W3C session → observed mobile capability → call → independent generated entry', {timeout:60000},async t=>{
 const temporary=await mkdtemp(path.join(os.tmpdir(),'software-mobile-sdk-'));
 let client,generatedClient,logs='';
 const received=[],ui={page:'entry',clicks:0,apiCalls:0};
 const source=()=>ui.page==='entry'
  ?'<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Fixture"><XCUIElementTypeButton type="XCUIElementTypeButton" name="Open items" label="Open items" enabled="true" visible="true" x="0" y="0" width="120" height="60"/></XCUIElementTypeApplication></AppiumAUT>'
  :'<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Fixture"><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="Items" label="Items" x="0" y="0" width="120" height="60"/></XCUIElementTypeApplication></AppiumAUT>';
 const http=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=raw?JSON.parse(raw):null;received.push({method:req.method,url:req.url,body});
  const send=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({value}));};
  if(req.url==='/fixture-api'){ui.apiCalls++;return send({ok:true});}
  const prefix='/wd/hub/session/local-ios-session';
  if(!req.url.startsWith(prefix))return send({error:'invalid session id'},404);
  const route=req.url.slice(prefix.length);
  if(req.method==='GET'&&route==='/source')return send(source());
  if(req.method==='POST'&&route==='/execute/sync'){
   assert.deepEqual(body,{script:'mobile: activeAppInfo',args:[]});return send({bundleId:appId});
  }
  if(req.method==='POST'&&route==='/elements'){
   assert.equal(body.using,'xpath');assert.match(body.value,/@name='Open items'/);
   return send(ui.page==='entry'?[{'element-6066-11e4-a52e-4f735466cecf':'open-items'}]:[]);
  }
  if(req.method==='POST'&&route==='/element/open-items/click'){
   assert.equal(ui.page,'entry');ui.page='items';ui.clicks++;return send(null);
  }
  if(req.method==='POST'&&route==='/back'){ui.page='entry';return send(null);}
  return send({error:'unknown command'},404);
 });
 await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+http.address().port;
 t.after(async()=>{await generatedClient?.close();await client?.close();await new Promise(resolve=>{http.closeAllConnections();http.close(resolve)});await rm(temporary,{recursive:true,force:true});});
 const inventory=path.join(temporary,'inventory');await mkdir(inventory);
 await writeFile(path.join(inventory,'endpoints.static.json'),JSON.stringify([
  {method:'GET',url:origin+'/fixture-api',headers:{},query:{},body:null,categories:['static_candidate'],source:'plist'},
  {method:null,url:origin+'/native-unknown',headers:{},query:{},body:null,categories:['static_candidate'],source:'native'},
 ]));
 await writeFile(path.join(inventory,'source.json'),JSON.stringify({format:'endpoint-inventory',schema_version:'1.1',kind:'ios',source_id:sourceId,inventory:'endpoints.static.json',static_inventory:'endpoints.static.json',app:{package_name:appId,bundle_id:appId,artifact_sha256:'a'.repeat(64),artifact_type:'app',version_name:'1'}}));
 const deviceFile=path.join(temporary,'device.json');
 await writeFile(deviceFile,JSON.stringify({source:{id:sourceId,kind:'ios'},backend:{type:'webdriver',url:origin+'/wd/hub',sessionId:'local-ios-session',platform:'ios',appId},limits:{maxActions:8,maxDepth:2,maxDurationMs:15000}}));
 const python=existsSync(path.join(project,'.venv/bin/python'))?path.join(project,'.venv/bin/python'):'/opt/homebrew/bin/python3.13';
 const runtimeConfig=path.join(temporary,'runtime.json'),outputRoot=path.join(temporary,'software');
 await writeFile(runtimeConfig,JSON.stringify({outputRoot,artifactRoots:[temporary],python,devices:{local_fixture:deviceFile},bindings:{[sourceId]:{allowed_origins:[origin]}}}));
 async function connect(entry,args=[]){
  const transport=new StdioClientTransport({command:process.execPath,args:[entry,...args],cwd:project,stderr:'pipe',env:{...process.env}});
  transport.stderr?.on('data',chunk=>logs=(logs+chunk).slice(-8192));
  const sdk=new Client({name:'software-mobile-real-stdio-fixture',version:'1'});await sdk.connect(transport);return sdk;
 }
 client=await connect(path.join(project,'src/software-mcp.js'),['--config',runtimeConfig]);
 assert.ok((await client.listTools()).tools.some(tool=>tool.name==='software_discover'));
 const started=await call(client,'software_discover',{kind:'ios',input:inventory,deviceName:'local_fixture'});
 const discovery=await finished(client,started.operationId);
 assert.equal(discovery.status,'completed',JSON.stringify({discovery,logs}));
 assert.equal(ui.clicks,1);assert.equal(ui.apiCalls,0);
 const catalog=await call(client,'software_capabilities',{sourceId,kind:'mobile'});
 const mobile=catalog.items.find(item=>item.readiness==='ready');assert.ok(mobile,JSON.stringify(catalog));
 assert.equal(mobile.kind,'mobile');assert.equal(mobile.evidence.executionObserved,true);assert.equal(mobile.evidence.networkObserved,false);
 assert.doesNotMatch(JSON.stringify(catalog),/local-ios-session|\/wd\/hub/);
 assert.ok(catalog.source.gaps.some(gap=>gap==='app_artifact_not_verified'||gap.reason==='app_artifact_not_verified'));
 const all=await call(client,'software_capabilities',{sourceId});
 const unknown=all.items.find(item=>item.name.includes('native-unknown'));assert.equal(unknown.readiness,'candidate');

 // Restoring the known entry is explicit fixture preparation. Execution itself
 // checks its entry fingerprint and never resets/force-stops an arbitrary app.
 const restore=async()=>{const reply=await fetch(origin+'/wd/hub/session/local-ios-session/back',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(reply.status,200);};
 await restore();
 const invocation=await call(client,'software_call',{sourceId,capabilityId:mobile.id,expectedRevision:mobile.revision,params:{}});
 const executed=await finished(client,invocation.operationId);
 assert.equal(executed.status,'completed',JSON.stringify({executed,logs}));
 assert.equal(executed.result.result.ok,true);assert.equal(executed.result.result.executionObserved,true);
 assert.equal(executed.result.result.networkObserved,false);assert.equal(ui.clicks,2);assert.equal(ui.page,'items');assert.equal(ui.apiCalls,0);

 const generated=await call(client,'software_generate',{sourceId,expectedRevision:catalog.source.revision});
 const generation=await finished(client,generated.operationId);assert.equal(generation.status,'completed',JSON.stringify(generation));
 const bundle=generation.result;
 assert.equal(JSON.parse(await readFile(bundle.clientConfig,'utf8')).mcpServers[sourceId].args[0],bundle.entry);
 generatedClient=await connect(bundle.entry);
 const entryTools=(await generatedClient.listTools()).tools;
 const callableName='cap_'+mobile.id.slice(4,24);assert.ok(entryTools.some(tool=>tool.name===callableName));
 await restore();
 const generatedStart=await call(generatedClient,callableName,{});
 const generatedEnd=await finished(generatedClient,generatedStart.operationId,'operation_status');
 assert.equal(generatedEnd.status,'completed',JSON.stringify({generatedEnd,logs}));
 assert.equal(generatedEnd.result.result.ok,true);assert.equal(ui.clicks,3);assert.equal(ui.page,'items');
 assert.equal(ui.apiCalls,0,'UI evidence must not fabricate endpoint execution');
 assert.equal(received.filter(row=>row.url.endsWith('/element/open-items/click')).length,3);
 assert.ok(received.some(row=>row.url.endsWith('/execute/sync')));
 assert.ok(received.some(row=>row.url.endsWith('/elements')));

 // New HTTP evidence creates a new immutable generation. Its mobile recipe
 // must retain the configured device alias rather than losing it on refresh.
 const staticFile=path.join(inventory,'endpoints.static.json');
 const updated=JSON.parse(await readFile(staticFile,'utf8'));
 updated.push({method:'GET',url:origin+'/new-evidence',categories:['static_candidate'],source:'plist'});
 await writeFile(staticFile,JSON.stringify(updated));
 const refreshed=await finished(client,(await call(client,'software_refresh',{sourceId,expectedRevision:catalog.source.revision})).operationId);
 assert.equal(refreshed.status,'completed',JSON.stringify(refreshed));
 assert.notEqual(refreshed.result.source.revision,catalog.source.revision);
 const next=(await call(client,'software_capabilities',{sourceId,kind:'mobile'})).items.find(item=>item.id===mobile.id);
 assert.equal(next.readiness,'ready');assert.notEqual(next.revision,mobile.revision);
 await restore();
 const afterRefresh=await finished(client,(await call(client,'software_call',{sourceId,capabilityId:next.id,expectedRevision:next.revision,params:{}})).operationId);
 assert.equal(afterRefresh.status,'completed',JSON.stringify(afterRefresh));
 assert.equal(afterRefresh.result.result.ok,true);assert.equal(ui.clicks,4);assert.equal(ui.apiCalls,0);
 const stale=await generatedClient.callTool({name:callableName,arguments:{}});
 assert.equal(stale.isError,true);assert.match(stale.content[0].text,/SOURCE_CHANGED/);
});
