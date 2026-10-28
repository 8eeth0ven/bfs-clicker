#!/usr/bin/env node
// Self-built unsigned Mach-O fixture -> real host proxy -> inventory -> MCP SDK.
// This does not install or run an iOS application on a device.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer, request} from 'node:http';
import {mkdir, readFile, writeFile, access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Ajv2020} from 'ajv/dist/2020.js';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg=(name, fallback)=>{const at=process.argv.indexOf(name);return at<0?fallback:process.argv[at+1];};
const python=arg('--python', process.env.MOBILE_PYTHON||'python3');
const mitmdump=arg('--mitmdump', python.includes('/')?path.join(path.dirname(path.resolve(python)), 'mitmdump'):'mitmdump');
const out=path.resolve(arg('--out', path.join(repo, 'output-ios-demo', randomUUID())));
const env={...process.env, PYTHONPATH:path.join(repo, 'apk_tools')};
const secret='SYNTHETIC_MOBILE_RUNTIME_ONLY';
const steps=[];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function command(binary,args){
 const child=spawn(binary,args,{cwd:repo,env,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';
 const done=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('CLI deadline exceeded'));},120000);
  child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>1024*1024)child.kill('SIGTERM');});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4096);});
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('close',code=>{clearTimeout(timer);code===0?resolve(stdout.trim()):reject(new Error(`fixture CLI exited ${code}: ${stderr}`));});
 });
 // Register a handler immediately while the caller waits for capture-ready.
 done.catch(()=>{});
 return {child,done};
}
async function stop(child){
 if(!child||child.exitCode!==null)return;
 child.kill('SIGINT');
 await Promise.race([once(child,'exit'),delay(6000)]);
 if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(2000)]);}
 if(child.exitCode===null)child.kill('SIGKILL');
}
let api,verifier,client;
try{
 await mkdir(out,{recursive:true});
 const received=[];
 api=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  received.push({url:req.url,method:req.method,authorization:req.headers.authorization,body});
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({items:[{id:'synthetic-1'}],authorization:req.headers.authorization,echo:req.headers.authorization}));
 });
 api.listen(0,'127.0.0.1');await once(api,'listening');
 const origin='http://127.0.0.1:'+api.address().port;
 const ipa=path.join(out,'demo.ipa'),inventory=path.join(out,'inventory');
 const build=JSON.parse(await command(python,[path.join(repo,'apk_tools/examples/ios_demo/build_demo.py'),'--out',ipa,'--api-origin',origin]).done);
 assert.equal(build.signed,false);assert.equal(build.launchable,false);
 const extracted=JSON.parse(await command(python,['-m','apk_inventory.ios',ipa,'--out',inventory]).done);
 let descriptor=JSON.parse(await readFile(path.join(inventory,'source.json'),'utf8'));
 const staticPath=path.resolve(inventory,descriptor.static_inventory);
 const original=await readFile(staticPath);
 assert.equal(descriptor.app.ipa_sha256,digest(await readFile(ipa)));
 const ajv=new Ajv2020({strict:false,allowUnionTypes:true});
 const sourceSchema=ajv.compile(JSON.parse(await readFile(path.join(repo,'apk_tools/schemas/source.schema.json'),'utf8')));
 const recordSchema=ajv.compile(JSON.parse(await readFile(path.join(repo,'apk_tools/schemas/endpoint-record.schema.json'),'utf8')));
 assert.ok(sourceSchema(descriptor),JSON.stringify(sourceSchema.errors));
 for(const record of JSON.parse(original))assert.ok(recordSchema(record),JSON.stringify(recordSchema.errors));
 steps.push({step:'extract',status:extracted.status,artifact:'self-built unsigned Mach-O fixture',kind:descriptor.kind});
 const credential=path.join(out,'demo.local.yaml');
 await writeFile(credential,'mode: token\ntoken: '+secret+'\n',{mode:0o600});
 const configPath=path.join(out,'gateway.json');
 await writeFile(configPath,JSON.stringify({manifest_roots:[out],state_dir:path.join(out,'state'),sources:[{
  id:descriptor.source_id,kind:'ios',manifest:inventory,credentials:credential,allowed_origins:[origin],credential_origins:[origin]
 }]}));
 client=new Client({name:'ios-native-pipeline-demo',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(repo,'gateway/dist/server.js'),'--config',configPath],stderr:'pipe'}));
 const invoke=async(name,args)=>{
  const result=await client.callTool({name,arguments:args});
  assert.ok(!JSON.stringify(result).includes(secret));
  return result.structuredContent;
 };
 assert.equal((await client.listTools()).tools.length,4);
 const initial=await invoke('list_endpoints',{source:descriptor.source_id,filter:{kind:'ios',extraction_source:'native'}});
 const unknown=initial.data.items.find(ep=>ep.path==='/native/items');
 assert.ok(unknown);assert.equal(unknown.methods.length,0);
 const refused=await invoke('call_endpoint',{source:descriptor.source_id,endpoint_id:unknown.id});
 assert.equal(refused.error.code,'METHOD_UNRESOLVED');assert.equal(received.length,0);
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
 const proxyPort=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const scope=path.join(out,'scope.local.json');await writeFile(scope,JSON.stringify({origins:[origin]}));
 const verification=command(python,['-m','apk_inventory.ios_verify',ipa,'--inventory',inventory,'--duration','2s',
  '--proxy',String(proxyPort),'--scope',scope,'--isolated-device','--mitmdump',mitmdump,'--session-id','demo-live']);
 verifier=verification.child;
 const ready=path.join(inventory,'verified/demo-live/capture.ready.json');
 for(let i=0;i<300;i++){
  try{await access(ready);break;}catch{}
  if(verifier.exitCode!==null)await verification.done;
  if(i===299)throw new Error('Proxy readiness deadline exceeded');
  await delay(50);
 }
 const throughProxy=(method,route,body)=>new Promise((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port:proxyPort,method,path:origin+route,headers:{
   host:new URL(origin).host,authorization:'Bearer '+secret,...(body?{'content-type':'application/json'}:{})
  }},res=>{res.resume();res.on('end',resolve);});
  req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('Proxy request timeout')));req.end(body);
 });
 await throughProxy('GET','/native/items?api_key=SYNTHETIC_DEMO_ONLY&page=1');
 await throughProxy('POST','/items',JSON.stringify({title:'fixture',password:secret}));
 const verified=JSON.parse(await verification.done);verifier=undefined;
 assert.ok(verified.observed_unique_operations>=2);assert.equal(verified.promoted,true);
 assert.equal(digest(original),digest(await readFile(staticPath)));
 const capture=await readFile(path.join(inventory,'verified/demo-live/capture.events.jsonl'),'utf8');
 assert.ok(!capture.includes(secret));assert.ok(!capture.includes('SYNTHETIC_DEMO_ONLY'));
 descriptor=JSON.parse(await readFile(path.join(inventory,'source.json'),'utf8'));
 const records=JSON.parse(await readFile(path.resolve(inventory,descriptor.inventory),'utf8'));
 for(const record of records)assert.ok(recordSchema(record),JSON.stringify(recordSchema.errors));
 steps.push({step:'capture_and_verify',backend:'real mitmdump; synthetic loopback client',observed:verified.observed_unique_operations,device_operated:false});
 assert.equal((await invoke('add_source',{manifest_path:inventory})).ok,true);
 const found=await invoke('search_endpoints',{source:descriptor.source_id,keyword:'native'});
 const endpoint=found.data.items.find(ep=>ep.path==='/native/items'&&ep.methods.includes('GET'));
 assert.ok(endpoint);assert.equal(endpoint.id,unknown.id);
 assert.ok(endpoint.operations.GET.extraction_sources.includes('native'));
 const called=await invoke('call_endpoint',{source:descriptor.source_id,endpoint_id:endpoint.id,
  expected_revision:endpoint.source_revision,params:{method:'GET',query:{page:'2'}}});
 assert.equal(called.ok,true);assert.equal(called.data.response.status,200);
 assert.ok(called.data.provenance.includes('observed'));
 assert.equal(received.at(-1).authorization,'Bearer '+secret);
 const post=(await invoke('list_endpoints',{source:descriptor.source_id,filter:{path:'/items',method:'POST'}})).data.items.find(ep=>ep.path==='/items');
 assert.ok(post);
 const before=received.length;
 const blocked=await invoke('call_endpoint',{source:descriptor.source_id,endpoint_id:post.id,params:{method:'POST',body:{title:'blocked'}}});
 assert.equal(blocked.error.code,'METHOD_BLOCKED');assert.equal(received.length,before);
 assert.equal((await client.listResources()).resources.length,1);
 steps.push({step:'mcp',tools:4,source_kind:'ios',native_provenance_preserved:true,status:200,write_blocked:true});
 const summary={ok:true,out,steps,static_unchanged:true,device_operated:false};
 await writeFile(path.join(out,'e2e-report.json'),JSON.stringify(summary,null,2));
 console.log(JSON.stringify(summary,null,2));
}catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
finally{await client?.close();await stop(verifier);if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}}
