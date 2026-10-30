import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { temp, fixture, document, root, until, json } from './helpers.mjs';

async function connect(t, outputRoot, {modern=false,configFile}={}) {
  const errors=[], transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'src/mcp.js'),'--output-root',outputRoot,...(configFile?['--config',configFile]:[])],cwd:root,stderr:'pipe',env:{...process.env}});
  let stderr='';transport.stderr.on('data',chunk=>{stderr+=chunk;});
  const client=new Client({name:'bfs-mcp-regression',version:'1.0.0'}, modern?{versionNegotiation:{mode:{pin:'2026-07-28'}}}:{});
  client.onerror=error=>errors.push(error.message);
  t.after(async()=>{await client.close();assert.deepEqual(errors,[],stderr);});
  await client.connect(transport,{timeout:10000});
  return {client,transport,errors,get stderr(){return stderr;}};
}
async function call(client,name,args={}) {
  const reply=await client.callTool({name,arguments:args});
  assert(!reply.isError,JSON.stringify(reply));
  return reply.structuredContent??JSON.parse(reply.content.find(item=>item.type==='text').text);
}
async function finished(client,runId,timeoutMs=30000) {
  return until(async()=>{const status=await call(client,'bfs_status',{runId});return !status.active&&status;},timeoutMs);
}

for(const modern of [false,true])test('official MCP client discovers tools/resources and rejects invalid inputs ('+(modern?'2026':'2025')+')',{timeout:20000},async t=>{
  const output=temp(t),{client}=await connect(t,output,{modern});
  const tools=(await client.listTools()).tools;
  for(const name of ['bfs_start','bfs_status','bfs_list','bfs_stop','bfs_resume','bfs_build_graph','bfs_graph_build_status','bfs_graph_summary','bfs_graph_nodes','bfs_graph_edges','bfs_graph_neighborhood','bfs_graph_path'])assert(tools.some(tool=>tool.name===name),name);
  assert.equal(tools.find(tool=>tool.name==='bfs_start').annotations.readOnlyHint,false);
  assert.equal(tools.find(tool=>tool.name==='bfs_graph_nodes').annotations.readOnlyHint,true);
  assert(tools.every(tool=>tool.inputSchema.additionalProperties===false));
  assert((await client.listResources()).resources.some(resource=>resource.uri==='bfs://guide'));
  const guide=await client.readResource({uri:'bfs://guide'});assert.match(guide.contents[0].text,/workflow/);
  assert.equal((await call(client,'bfs_list')).total,0);
  for(const args of [{asset:'file:///etc/passwd'},{asset:'http://localhost/',outputDir:'/tmp/escape'},{asset:'http://localhost/',limits:{maxStates:0}},{asset:'http://localhost/',requestDelayMs:-1}]){
    const result=await client.callTool({name:'bfs_start',arguments:args});assert(result.isError);
  }
  assert((await client.callTool({name:'bfs_status',arguments:{runId:'../elsewhere'}})).isError);
});

test('MCP executes localhost crawl, queries graph pages/path, rebuilds and reloads persisted runs',{timeout:60000},async t=>{
  const output=temp(t),site=await fixture(t,({url})=>url.pathname.startsWith('/api/')?{type:'application/json',body:'{"ok":true}'}:
    {body:document('MCP站点',url.pathname==='/child'?'<p>详情</p>':'<a href="/child">详情</a><button onclick="loadItems()">项目</button>',"function loadItems(){fetch('/api/items')}fetch('/api/bootstrap')")});
  const {client}=await connect(t,output,{modern:true});
  const started=await call(client,'bfs_start',{asset:site.origin,requestDelayMs:0,shotFormat:'none',limitMode:'custom',limits:{maxDepth:3,maxActions:20,maxDurationMs:20000}});
  assert(started.runId&&started.active);const status=await finished(client,started.runId);assert.equal(status.status,'completed');
  assert(existsSync(status.graphPath));assert(existsSync(status.reportPath));
  const summary=await call(client,'bfs_graph_summary',{runId:started.runId});assert(summary.counts);
  const nodes=await call(client,'bfs_graph_nodes',{runId:started.runId,type:'api',limit:1});assert.equal(nodes.items.length,1);assert(nodes.total>=2);assert(nodes.nextOffset!==null);
  const second=await call(client,'bfs_graph_nodes',{runId:started.runId,type:'api',limit:1,offset:nodes.nextOffset});assert.notEqual(second.items[0].id,nodes.items[0].id);
  const states=await call(client,'bfs_graph_nodes',{runId:started.runId,type:'state'});const child=states.items.find(node=>node.url===site.origin+'/child');assert(child);
  const flow=await call(client,'bfs_graph_path',{runId:started.runId,stateId:String(child.stateId)});assert(flow.steps.length>0);assert(flow.complete);
  const edges=await call(client,'bfs_graph_edges',{runId:started.runId,nodeId:nodes.items[0].id});assert(edges.items.length);
  const neighborhood=await call(client,'bfs_graph_neighborhood',{runId:started.runId,nodeId:nodes.items[0].id,depth:2,limit:20});assert(neighborhood.nodes.length>=2);
  const resource=await client.readResource({uri:'bfs://runs/'+started.runId+'/summary'});assert(JSON.parse(resource.contents[0].text).counts);
  const dir=path.join(output,started.runId),before=readFileSync(path.join(dir,'private/checkpoint.json'));
  const requestCount=site.requests.length,build=await call(client,'bfs_build_graph',{runId:started.runId});assert(build.operationId);
  const built=await until(async()=>{const state=await call(client,'bfs_graph_build_status',{operationId:build.operationId});return state.status!=='running'&&state;});
  assert.equal(built.status,'completed');assert.equal(site.requests.length,requestCount);assert.deepEqual(readFileSync(path.join(dir,'private/checkpoint.json')),before);
  await client.close();
  const reconnected=await connect(t,output);assert((await call(reconnected.client,'bfs_list')).runs.some(run=>run.runId===started.runId));
  assert.equal((await call(reconnected.client,'bfs_status',{runId:started.runId})).active,false);
  assert((await call(reconnected.client,'bfs_graph_summary',{runId:started.runId})).counts);
});

test('MCP handles startup stop, resumes pending work and never exposes configured secrets',{timeout:65000},async t=>{
  const output=temp(t),configFile=path.join(output,'trusted.json');
  const site=await fixture(t,({url})=>({body:document('待续跑',url.pathname==='/'?'<a href="/one">条目一</a><a href="/two">条目二</a>':'<p>条目详情</p>')}));
  writeFileSync(configFile,JSON.stringify({authInject:{headers:{Authorization:'Bearer mcp-fixture-secret'}},shotFormat:'none'}));
  const {client}=await connect(t,output,{configFile});
  const started=await call(client,'bfs_start',{asset:site.origin,requestDelayMs:20,limitMode:'custom',limits:{maxDepth:1,maxDurationMs:20000}});
  const foreign=await connect(t,output);
  assert((await foreign.client.callTool({name:'bfs_stop',arguments:{runId:started.runId}})).isError);
  await call(client,'bfs_stop',{runId:started.runId});
  const stopped=await finished(client,started.runId);assert.equal(stopped.active,false);assert.equal(stopped.status,'partial');assert(stopped.canResume);
  const resumed=await call(client,'bfs_resume',{runId:started.runId});assert(resumed.active);
  const done=await finished(client,started.runId);assert.equal(done.status,'completed');
  const list=await call(client,'bfs_list'),summary=await call(client,'bfs_graph_summary',{runId:started.runId});
  assert(!JSON.stringify({done,list,summary}).includes('mcp-fixture-secret'));
});

test('closing actual stdio pipe gracefully saves owned worker, stdout contains only JSON-RPC',{timeout:35000},async t=>{
  const output=temp(t),site=await fixture(t,()=>({body:document('EOF','<a href="/next">继续</a>')}));
  const child=spawn(process.execPath,[path.join(root,'src/mcp.js'),'--output-root',output],{cwd:root,stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(child.exitCode==null)child.kill('SIGTERM');});
  const messages=[];let pending='',stderr='';
  child.stdout.on('data',chunk=>{pending+=chunk;const lines=pending.split('\n');pending=lines.pop();for(const line of lines)if(line)messages.push(JSON.parse(line));});
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const send=value=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
  const reply=id=>until(()=>messages.find(message=>message.id===id),10000);
  send({id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'raw-fixture',version:'1'}}});
  assert((await reply(1)).result);
  send({method:'notifications/initialized'});
  send({id:2,method:'tools/call',params:{name:'bfs_start',arguments:{asset:site.origin,requestDelayMs:1000,shotFormat:'none'}}});
  const started=(await reply(2)).result;assert(!started.isError,JSON.stringify(started));const runId=started.structuredContent.runId;
  await until(()=>existsSync(path.join(output,runId,'.run.lock')),10000);
  child.stdin.end();
  await until(()=>child.exitCode!==null||child.signalCode!==null,25000);
  assert.equal(child.exitCode,0,stderr);assert.equal(pending,'');assert(messages.every(message=>message.jsonrpc==='2.0'));
  assert(!existsSync(path.join(output,runId,'.run.lock')));
  const saved=json(path.join(output,runId,'run.json'));assert.notEqual(saved.status,'running');assert(existsSync(path.join(output,runId,'graph.json')));
});

test('worker saves and exits when its MCP parent is SIGKILLed during navigation',{timeout:35000},async t=>{
  const output=temp(t),site=await fixture(t,()=>new Promise(()=>{}));
  const child=spawn(process.execPath,[path.join(root,'src/mcp.js'),'--output-root',output],{cwd:root,stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')});
  const messages=[];let pending='';child.stdout.on('data',chunk=>{pending+=chunk;const lines=pending.split('\n');pending=lines.pop();for(const line of lines)if(line)messages.push(JSON.parse(line));});
  child.stderr.resume();
  const send=value=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
  send({id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'parent-kill-fixture',version:'1'}}});
  await until(()=>messages.some(message=>message.id===1));send({method:'notifications/initialized'});
  send({id:2,method:'tools/call',params:{name:'bfs_start',arguments:{asset:site.origin,shotFormat:'none'}}});
  const reply=await until(()=>messages.find(message=>message.id===2));assert(!reply.result.isError);const runId=reply.result.structuredContent.runId;
  const dir=path.join(output,runId),lockFile=path.join(dir,'.run.lock');
  await until(()=>existsSync(lockFile)&&site.requests.length>0,15000);const workerPid=json(lockFile).pid;
  child.kill('SIGKILL');
  await until(()=>!existsSync(lockFile),25000);
  assert.equal(json(path.join(dir,'run.json')).stopReason,'parent_disconnected');
  assert.equal(json(path.join(dir,'run.json')).status,'partial');assert(existsSync(path.join(dir,'graph.json')));
  await until(()=>{try{process.kill(workerPid,0);return false}catch(error){return error.code==='ESRCH'}},5000);
});
