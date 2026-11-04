import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {temp,until,root} from './helpers.mjs';

async function call(client,name,args={}){const reply=await client.callTool({name,arguments:args});assert(!reply.isError,JSON.stringify(reply));return reply.structuredContent||JSON.parse(reply.content[0].text);}
async function finish(client,started,name='software_operation',{failure=false}={}){return until(async()=>{const state=await call(client,name,{operationId:started.operationId});if(state.status==='failed'){if(failure)return state;throw Error(JSON.stringify(state));}return state.status==='completed'&&state;},30000);}

// Actual W3C HTTP and MCP stdio, with a stateful calculator protocol fixture.
// The arithmetic is implemented by the fixture, not by the generated tool.
test('mobile workflow MCP learns numeric parameters and generated entry returns an unseen computed result',{timeout:90000},async t=>{
 const dir=temp(t),appId='com.example.workflow',sourceId='ios_calculator';let input='',total=0,clicks=0;
 const received=[];
 const xml=()=>`<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication"><XCUIElementTypeTextField type="XCUIElementTypeTextField" name="Quantity" label="Quantity" value="${input}" enabled="true" visible="true" x="0" y="0" width="100" height="40"/><XCUIElementTypeButton type="XCUIElementTypeButton" name="Calculate" label="Calculate" enabled="true" visible="true" x="0" y="50" width="100" height="40"/><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="total" label="TOTAL:${total}" value="TOTAL:${total}" enabled="true" visible="true" x="0" y="100" width="100" height="40"/></XCUIElementTypeApplication></AppiumAUT>`;
 const http=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};received.push({path:req.url,body});
  const send=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({value}));};
  const route=req.url.replace('/session/calc','');
  if(route==='/source')return send(xml());
  if(route==='/execute/sync')return send({bundleId:appId});
  if(route==='/elements'){const target=body.value.includes('Quantity')?'quantity':body.value.includes('Calculate')?'calculate':body.value.includes('total')?'total':null;return send(target?[{'element-6066-11e4-a52e-4f735466cecf':target}]:[]);}
  if(route==='/element/quantity/clear'){input='';return send(null);}
  if(route==='/element/quantity/value'){input+=body.text;return send(null);}
  if(route==='/element/calculate/click'){total=Number(input)**2;clicks++;return send(null);}
  if(route==='/back')return send(null);
  return send({error:'unsupported'},404);
 });
 await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{http.closeAllConnections();http.close(resolve)}));
 const origin='http://127.0.0.1:'+http.address().port,inventory=path.join(dir,'inventory');mkdirSync(inventory);
 writeFileSync(path.join(inventory,'source.json'),JSON.stringify({format:'endpoint-inventory',schema_version:'1.1',kind:'ios',source_id:sourceId,inventory:'endpoints.json',app:{package_name:appId,bundle_id:appId,artifact_type:'app',version_name:'1',artifact_sha256:'a'.repeat(64)}}));writeFileSync(path.join(inventory,'endpoints.json'),'[]');
 const device=path.join(dir,'device.json');
 writeFileSync(device,JSON.stringify({backend:{type:'webdriver',platform:'ios',url:origin,sessionId:'calc'},limits:{maxActions:20,maxDepth:1,maxDurationMs:15000},actionAllowlist:[{kind:'type',selector:{accessibilityId:'Quantity'},effect:'read'},{kind:'click',selector:{accessibilityId:'Calculate'},effect:'read'}]}));
 const definition=path.join(dir,'workflow.json');writeFileSync(definition,JSON.stringify({schemaVersion:1,id:'square',name:'查询平方',effect:'read',inputSchema:{type:'object',properties:{quantity:{type:'integer',minimum:1,maximum:10}},required:['quantity'],additionalProperties:false},steps:[{kind:'type',selector:{accessibilityId:'Quantity'},input:'quantity',replace:true},{kind:'click',selector:{accessibilityId:'Calculate'}},{kind:'assert',selector:{accessibilityId:'total'},expect:{matches:'^TOTAL:[0-9]+$'}},{kind:'extract',selector:{accessibilityId:'total'},output:'total',pattern:'^TOTAL:([0-9]+)$',group:1,valueType:'integer'}]}));
 const config=path.join(dir,'config.json');writeFileSync(config,JSON.stringify({outputRoot:path.join(dir,'out'),artifactRoots:[dir],python:path.join(root,'.venv/bin/python'),devices:{calc:device}}));
 async function connect(args){const transport=new StdioClientTransport({command:process.execPath,args,cwd:root,stderr:'pipe'});transport.stderr.on('data',()=>{});const client=new Client({name:'mobile-workflow-sdk-client',version:'1'});await client.connect(transport);t.after(()=>client.close());return client;}
 const client=await connect([path.join(root,'src/software-mcp.js'),'--config',config]);
 await finish(client,await call(client,'software_discover',{kind:'ios',input:inventory,deviceName:'calc'}));
 const sources=await call(client,'software_sources');
 await finish(client,await call(client,'software_bind_workflow',{sourceId,expectedRevision:sources.sources[0].revision,specPath:definition,samples:[{quantity:2},{quantity:3}]}));
 const caps=await call(client,'software_capabilities',{sourceId,kind:'mobile'}),cap=caps.items.find(item=>item.inputSchema.properties.quantity);assert(cap,JSON.stringify(caps));assert.equal(cap.readiness,'ready');
 const before=clicks;
 const invalid=await finish(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{quantity:11}}),'software_operation',{failure:true});assert.equal(invalid.status,'failed');assert.equal(clicks,before);
 const invoked=await finish(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{quantity:4}}));assert.equal(invoked.result.result.outputs.total,16);assert.equal(invoked.result.result.networkObserved,false);
 const generated=await finish(client,await call(client,'software_generate',{sourceId,expectedRevision:caps.source.revision})),independent=await connect([generated.result.entry]);
 const result=await finish(independent,await call(independent,'cap_'+cap.id.slice(4,24),{quantity:5}),'operation_status');assert.equal(result.result.result.outputs.total,25);assert.equal(input,'5');
 assert(received.filter(row=>row.path.endsWith('/clear')).length>=4);
});
