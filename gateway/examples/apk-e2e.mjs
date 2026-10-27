#!/usr/bin/env node
// Reproducible real mitmdump + Python inventory + SDK stdio example, no device required.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer,request} from 'node:http';
import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Ajv2020} from 'ajv/dist/2020.js';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const arg=(name,fallback)=>{const at=process.argv.indexOf(name);return at<0?fallback:process.argv[at+1];};
const python=arg('--python',process.env.APK_PYTHON||'python3');
const out=path.resolve(arg('--out',path.join(repo,'output-apk-demo',randomUUID())));
const apk=path.resolve(arg('--apk',path.join(out,'demo.apk')));
const existingInventory=arg('--verified-inventory',null);
const env={...process.env,PYTHONPATH:path.join(repo,'apk_tools')};
const steps=[];
async function command(binary,args,options={}){
 return await new Promise((resolve,reject)=>{
   const child=spawn(binary,args,{cwd:repo,env,...options,stdio:['ignore','pipe','pipe']});
   let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('CLI timed out'));},180000);
   child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>1024*1024)child.kill('SIGTERM');});
   child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-16384);});
   child.on('error',reject);child.on('close',code=>{clearTimeout(timer);code===0?resolve(stdout.trim()):reject(new Error(`${path.basename(binary)} exited ${code}: ${stderr.slice(-2000)}`));});
 });
}
async function stop(child){
 if(!child||child.exitCode!==null)return;
 child.kill('SIGINT');
 await Promise.race([once(child,'exit'),delay(5000)]);
 if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(2000)]);}
 if(child.exitCode===null)child.kill('SIGKILL');
}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
let api,proxy,client;
try{
 await mkdir(out,{recursive:true});
 try{await access(apk);}catch{await command(python,[path.join(repo,'apk_tools/examples/build_demo.py'),'--out',apk]);}
 const inventory=existingInventory?path.resolve(existingInventory):path.join(out,'inventory');
 const extracted=existingInventory?{status:'reused_verified_artifact'}:JSON.parse(await command(python,['-m','apk_inventory.extract',apk,'--out',inventory]));
 steps.push({step:'extract',status:extracted.status});
 const original=await readFile(path.join(inventory,'endpoints.static.json'));
 const descriptor=JSON.parse(await readFile(path.join(inventory,'source.json'),'utf8'));
 const validator=new Ajv2020({strict:false,allowUnionTypes:true});
 const recordSchema=validator.compile(JSON.parse(await readFile(path.join(repo,'apk_tools/schemas/endpoint-record.schema.json'),'utf8')));
 const sourceSchema=validator.compile(JSON.parse(await readFile(path.join(repo,'apk_tools/schemas/source.schema.json'),'utf8')));
 assert.ok(sourceSchema(descriptor),JSON.stringify(sourceSchema.errors));
 for(const record of JSON.parse(original))assert.ok(recordSchema(record),JSON.stringify(recordSchema.errors));
 const received=[];
 api=createServer(async(req,res)=>{
   let body='';for await(const chunk of req)body+=chunk;
   received.push({url:req.url,method:req.method,authorization:req.headers.authorization,body});
   res.writeHead(200,{'content-type':'application/json'});
   res.end(JSON.stringify({items:[{id:'demo-1',title:'fixture item'}],authorization:req.headers.authorization,echo:req.headers.authorization??'public'}));
 });
 api.listen(8765,'127.0.0.1');await once(api,'listening');
 let verified;
 if(!existingInventory){
 const portProbe=createServer();portProbe.listen(0,'127.0.0.1');await once(portProbe,'listening');const port=portProbe.address().port;await new Promise(r=>portProbe.close(r));
 const captureFile=path.join(out,'capture.events.jsonl'),ready=path.join(out,'capture.ready.json');
 const captureConfig=path.join(out,'capture.json');
 await writeFile(captureConfig,JSON.stringify({output:captureFile,ready,session_id:'demo-capture',origins:['http://127.0.0.1:8765'],attribution:'isolated_session',body_limit:32768}));
 proxy=spawn(arg('--mitmdump','mitmdump'),['-q','--listen-host','127.0.0.1','--listen-port',String(port),'-s',path.join(repo,'apk_tools/apk_inventory/mitm_addon.py'),'--set','confdir='+path.join(out,'.mitmproxy'),'--set','flow_detail=0'],{env:{...env,APK_VERIFY_CONFIG:captureConfig},stdio:['ignore','ignore','pipe']});
 let proxyErrors='';proxy.stderr.on('data',chunk=>{proxyErrors=(proxyErrors+chunk).slice(-4096);});
 proxy.on('error',error=>{proxyErrors=error.code??'MITMDUMP_START_FAILED';});
 for(let i=0;i<300;i++){try{await access(ready);break;}catch{}if(proxy.exitCode!==null)throw new Error('mitmdump startup failed: '+proxyErrors);if(i===299)throw new Error('capture-ready timeout');await delay(50);}
 const throughProxy=(method,route,body)=>new Promise((resolve,reject)=>{
   const req=request({host:'127.0.0.1',port,method,path:'http://127.0.0.1:8765'+route,headers:{host:'127.0.0.1:8765',authorization:'Bearer demo-capture-secret-729384',...(body?{'content-type':'application/json'}:{})}},res=>{res.resume();res.on('end',resolve);});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('proxy timeout')));req.end(body);
 });
 await throughProxy('GET','/items?page=1&tag=blue&token=demo-query-secret-729384');
 await throughProxy('POST','/items',JSON.stringify({title:'fixture',password:'demo-body-secret-729384'}));
 await stop(proxy);proxy=undefined;
 const events=await readFile(captureFile,'utf8');
 assert.doesNotMatch(events,/demo-(?:capture|query|body)-secret-729384/);
 steps.push({step:'capture',backend:'real mitmdump',requests:2});
 const scope=path.join(out,'scope.json');await writeFile(scope,JSON.stringify({origins:['http://127.0.0.1:8765']}));
 verified=JSON.parse(await command(python,['-m','apk_inventory.verify',apk,'--inventory',inventory,'--observations',captureFile,'--scope',scope,'--session-id','demo-verified']));
 assert.ok(verified.observed_unique_operations>=2);assert.equal(digest(original),digest(await readFile(path.join(inventory,'endpoints.static.json'))));
 }else{
   assert.equal(descriptor.app.apk_sha256,digest(await readFile(apk)));
   const report=JSON.parse(await readFile(path.resolve(inventory,descriptor.verification_report),'utf8'));
   assert.equal(report.apk_sha256,descriptor.app.apk_sha256);assert.equal(report.promoted,true);
   assert.ok(report.observed_unique_operations>=2);
   verified={inventory:path.resolve(inventory,descriptor.inventory),observed_unique_operations:report.observed_unique_operations,coverage:report.coverage};
   steps.push({step:'capture',backend:report.capture_backend,session_id:report.session_id,reused_device_evidence:true});
 }
 for(const record of JSON.parse(await readFile(verified.inventory,'utf8')))assert.ok(recordSchema(record),JSON.stringify(recordSchema.errors));
 steps.push({step:'verify',observed:verified.observed_unique_operations,coverage:verified.coverage});
 await writeFile(path.join(out,'web.json'),JSON.stringify([{method:'GET',url:'http://127.0.0.1:8765/health',headers:{},query:{},body:null,categories:['observed']}]));
 const credential=path.join(out,'credential.yaml');await writeFile(credential,'mode: token\ntoken: demo-gateway-secret-729384\n',{mode:0o600});
 const configPath=path.join(out,'gateway.json');
 const config={manifest_roots:[out,inventory],state_dir:path.join(out,'state'),sources:[{id:'web_demo',manifest:path.join(out,'web.json'),public:true,allowed_origins:['http://127.0.0.1:8765']}]};
 await writeFile(configPath,JSON.stringify(config));
 client=new Client({name:'apk-pipeline-demo',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(repo,'gateway/dist/server.js'),'--config',configPath],stderr:'pipe'}));
 const invoke=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert.doesNotMatch(JSON.stringify(result),/demo-gateway-secret-729384/);return result.structuredContent;};
 assert.equal((await client.listTools()).tools.length,4);
 config.sources.push({id:descriptor.source_id,kind:'apk',manifest:inventory,credentials:credential,allowed_origins:['http://127.0.0.1:8765'],credential_origins:['http://127.0.0.1:8765']});
 await writeFile(configPath,JSON.stringify(config));
 assert.equal((await invoke('add_source',{manifest_path:inventory})).ok,true);
 const listed=await invoke('list_endpoints',{source:descriptor.source_id,filter:{path:'/items'}});
 const searched=await invoke('search_endpoints',{source:descriptor.source_id,keyword:'items'});
 const endpoint=searched.data.items.find(ep=>ep.path==='/items'&&ep.methods.includes('GET'));
 assert.ok(endpoint);assert.ok(endpoint.operations.GET.params_schema);
 const called=await invoke('call_endpoint',{source:descriptor.source_id,endpoint_id:endpoint.id,expected_revision:endpoint.source_revision,params:{method:'GET',query:{page:'2'}}});
 assert.equal(called.ok,true);assert.equal(called.data.response.status,200);assert.ok(called.data.provenance.includes('observed'));
 assert.equal(received.at(-1).authorization,'Bearer demo-gateway-secret-729384');assert.equal(received.at(-1).url,'/items?page=2');
 const count=received.length;
 const blocked=await invoke('call_endpoint',{source:descriptor.source_id,endpoint_id:endpoint.id,params:{method:'POST',body:{title:'blocked'}}});
 assert.equal(blocked.error.code,'METHOD_BLOCKED');assert.equal(received.length,count);
 steps.push({step:'mcp',tools:4,listed:listed.data.items.length,searched:searched.data.items.length,call_status:called.data.response.status,write_blocked:true});
 const summary={ok:true,out,apk,steps,static_unchanged:true};
 await writeFile(path.join(out,'e2e-report.json'),JSON.stringify(summary,null,2));
 console.log(JSON.stringify(summary,null,2));
}catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
finally{await client?.close();await stop(proxy);if(api){api.closeAllConnections();await new Promise(r=>api.close(r));}}
