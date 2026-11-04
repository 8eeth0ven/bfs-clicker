import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {temp,until,root} from './helpers.mjs';

async function call(client,name,args={}){const reply=await client.callTool({name,arguments:args});assert(!reply.isError,JSON.stringify(reply));return reply.structuredContent||JSON.parse(reply.content[0].text);}
async function finish(client,started){return until(async()=>{const state=await call(client,'software_operation',{operationId:started.operationId});if(state.status==='failed')throw Error(JSON.stringify(state));return state.status==='completed'&&state;},30000);}

test('native observed query candidates bind through MCP without supplying selector/spec files',{timeout:60000},async t=>{
 const dir=temp(t),sourceId='ios_native_query',appId='com.example.nativequery';let input='',result='RESULT:waiting',clicks=0;
 const timers=[];
 const xml=()=>`<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication"><XCUIElementTypeTextField type="XCUIElementTypeTextField" name="Query" label="Query" value="${input}" x="0" y="0" width="100" height="40"/><XCUIElementTypeButton type="XCUIElementTypeButton" name="Search" label="Search" x="0" y="50" width="100" height="40"/><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="results" label="${result}" x="0" y="100" width="100" height="40"/></XCUIElementTypeApplication></AppiumAUT>`;
 const http=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;const body=raw?JSON.parse(raw):{};
  const send=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({value}));};
  const route=req.url.replace('/session/query','');
  if(route==='/source')return send(xml());
  if(route==='/execute/sync')return send({bundleId:appId});
  if(route==='/elements'){const key=body.value.includes('Query')?'query':body.value.includes('Search')?'search':body.value.includes('results')?'results':null;return send(key?[{'element-6066-11e4-a52e-4f735466cecf':key}]:[]);}
  if(route==='/element/query/clear'){input='';return send(null);}
  if(route==='/element/query/value'){input+=body.text;return send(null);}
  if(route==='/element/search/click'){clicks++;const captured=input;timers.push(setTimeout(()=>result='RESULT:'+captured,200));return send(null);}
  res.writeHead(404);res.end('{}');
 });
 await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));t.after(()=>{timers.forEach(clearTimeout);return new Promise(resolve=>{http.closeAllConnections();http.close(resolve)});});
 const inventory=path.join(dir,'inventory');mkdirSync(inventory);writeFileSync(path.join(inventory,'source.json'),JSON.stringify({format:'endpoint-inventory',schema_version:'1.1',kind:'ios',source_id:sourceId,inventory:'endpoints.json',app:{package_name:appId,bundle_id:appId,artifact_type:'app',version_name:'1',artifact_sha256:'a'.repeat(64)}}));writeFileSync(path.join(inventory,'endpoints.json'),'[]');
 const device=path.join(dir,'device.json');writeFileSync(device,JSON.stringify({backend:{type:'webdriver',platform:'ios',url:'http://127.0.0.1:'+http.address().port,sessionId:'query'},limits:{maxActions:20,maxDepth:0,maxDurationMs:15000},actionAllowlist:[{kind:'type',selector:{accessibilityId:'Query'},effect:'read'}]}));
 const config=path.join(dir,'config.json');writeFileSync(config,JSON.stringify({outputRoot:path.join(dir,'out'),artifactRoots:[dir],python:path.join(root,'.venv/bin/python'),devices:{native:device}}));
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'src/software-mcp.js'),'--config',config],cwd:root,stderr:'pipe'});transport.stderr.on('data',()=>{});const client=new Client({name:'native-candidate-real-client',version:'1'});await client.connect(transport);t.after(()=>client.close());
 await finish(client,await call(client,'software_discover',{kind:'ios',input:inventory,deviceName:'native'}));
 const plan=await call(client,'software_workflows',{sourceId});assert.equal(clicks,0,'planning must be read-only');assert.equal(plan.items.length,1,JSON.stringify(plan));
 const item=plan.items[0];assert.equal(item.readiness,'candidate');assert(!JSON.stringify(plan).includes('accessibilityId'));
 await finish(client,await call(client,'software_bind_workflow',{sourceId,expectedRevision:plan.source.revision,candidateId:item.id,samples:[{query:'alpha'},{query:'beta'}],outputTargetId:item.outputTargets[0].id,assertParam:'query'}));
 assert.equal(clicks,2);const catalog=await call(client,'software_capabilities',{sourceId,kind:'mobile'}),cap=catalog.items.find(cap=>cap.inputSchema.properties.query);
 assert.equal(cap.readiness,'ready');const invoked=await finish(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{query:'gamma'}}));
 assert.equal(invoked.result.result.outputs.result,'RESULT:gamma');assert.equal(clicks,3);
});
