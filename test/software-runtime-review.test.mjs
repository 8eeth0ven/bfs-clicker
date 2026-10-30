import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {Ajv2020} from 'ajv/dist/2020.js';
import {createSoftwareRuntime} from '../src/software-runtime.js';
import {createGatewayServices} from '../gateway/dist/services.js';
import {endpointId} from '../gateway/dist/manifest.js';

const project=path.resolve(import.meta.dirname,'..');
async function fixture(t,{scope=true,kind='web',records,bindings={},config={}}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'software-runtime-review-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const received=[];
 const http=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  received.push({method:req.method,url:req.url,authorization:req.headers.authorization,body});
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({ok:true,authorization:req.headers.authorization,token:new URL(req.url,'http://local').searchParams.get('token')}));
 });
 await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{http.closeAllConnections();http.close(resolve)}));
 const origin=`http://127.0.0.1:${http.address().port}`;
 const inventoryPath=path.join(dir,'inventory.json'),outputRoot=path.join(dir,'software');
 const makeRecord=(extra={})=>({method:'GET',url:origin+'/items',headers:{},query:{token:'private-captured-token',page:'one'},body:null,categories:['observed'],source:'network',...extra});
 const manifest={schema_version:'1.1',source_id:'test',kind,endpoints:records?records(origin):[makeRecord()]};
 await writeFile(inventoryPath,JSON.stringify(manifest));
 const runtime=createSoftwareRuntime({outputRoot,artifactRoots:[dir],bindings:{test:{...(scope?{allowed_origins:[origin]}:{}),...bindings}},...config});
 const compile=extra=>runtime.compile({sourceId:'test',kind,inventoryPath,...extra});
 return {dir,runtime,outputRoot,inventoryPath,origin,manifest,received,makeRecord,compile,async save(){await writeFile(inventoryPath,JSON.stringify(manifest))},
  async capabilities(){return runtime.listCapabilities({sourceId:'test',limit:100})},
  async execute(cap,params={},extra={}){return runtime.execute({sourceId:'test',capabilityId:cap.id,expectedRevision:cap.revision,params,outputDir:path.join(dir,'execution-'+Date.now()),...extra})}};
}
async function until(fn,{timeout=10000}={}){const start=Date.now();while(Date.now()-start<timeout){const value=await fn();if(value)return value;await delay(30)}throw new Error('fixture timeout')}
function content(reply){return reply.structuredContent??JSON.parse(reply.content.find(item=>item.type==='text').text)}

test('review: stage→generation preserves gateway source revision and callable token parameter schema',async t=>{
 const f=await fixture(t);const built=await f.compile(),cap=(await f.capabilities()).items[0];
 assert.equal(cap.readiness,'ready');assert.equal(typeof cap.inputSchema.properties.query.properties.token,'object');
 assert.doesNotMatch(JSON.stringify(cap),/private-captured-token/);
 const generation=path.join(f.outputRoot,'sources/test/generations',built.source.revision);
 const recipes=JSON.parse(await readFile(path.join(generation,'private/recipes.json'),'utf8'));
 const services=await createGatewayServices(path.join(generation,'private/gateway.json'));
 assert.equal(services.registry.get('test').revision,recipes[cap.id].sourceRevision);
 const result=await f.execute(cap,{query:{token:'caller-provided-token',page:'2'}});
 assert.equal(result.result.ok,true);assert.match(f.received[0].url,/token=caller-provided-token/);
 assert.doesNotMatch(JSON.stringify(result),/caller-provided-token/);
 assert.equal(f.received.length,1);
});

test('review: repeat compile keeps stable source/capability revisions and reports no semantic changes',async t=>{
 const f=await fixture(t);const first=await f.compile(),cap=(await f.capabilities()).items[0];
 const second=await f.compile({expectedRevision:first.source.revision}),again=(await f.capabilities()).items[0];
 assert.equal(second.source.revision,first.source.revision);assert.equal(again.id,cap.id);assert.equal(again.revision,cap.revision);
 assert.deepEqual(second.changes,{added:[],changed:[],removed:[]});
});

test('review: unapproved discovered origins never become ready or expand trusted invocation scope',async t=>{
 const f=await fixture(t,{records:origin=>[
  {method:'GET',url:origin+'/approved',headers:{},query:{},body:null,categories:['static_candidate']},
  {method:'GET',url:'http://127.0.0.1:1/unapproved',headers:{},query:{},body:null,categories:['static_candidate']},
 ]});
 await f.compile();const {items}=await f.capabilities();
 assert.equal(items.find(cap=>cap.name==='GET /approved').readiness,'ready');
 const blocked=items.find(cap=>cap.name==='GET /unapproved');assert.equal(blocked.readiness,'candidate');
 await assert.rejects(f.execute(blocked),/CAPABILITY_NOT_READY/);assert.equal(f.received.length,0);
 const noScope=await fixture(t,{scope:false});await noScope.compile();
 assert.ok((await noScope.capabilities()).items.every(cap=>cap.readiness!=='ready'));
 await assert.rejects(noScope.execute((await noScope.capabilities()).items[0]),/CAPABILITY_NOT_READY/);assert.equal(noScope.received.length,0);
});

test('review: artifact roots and symlink escape are rejected before any generation becomes current',async t=>{
 const f=await fixture(t);await f.compile();const before=f.runtime.getSource('test').revision;
 const other=await mkdtemp(path.join(os.tmpdir(),'software-outside-'));t.after(()=>rm(other,{recursive:true,force:true}));
 const outside=path.join(other,'inventory.json');await writeFile(outside,JSON.stringify(f.manifest));
 await assert.rejects(f.compile({inventoryPath:outside}),/artifactRoots/);
 const link=path.join(f.dir,'escape.json');await symlink(outside,link);await assert.rejects(f.compile({inventoryPath:link}),/artifactRoots/);
 assert.equal(f.runtime.getSource('test').revision,before);
});

test('review: invalid parameters and stale capability revision cause zero requests',async t=>{
 const f=await fixture(t);await f.compile();const cap=(await f.capabilities()).items[0];
 await assert.rejects(f.execute(cap,{query:{page:{bad:true}}}),error=>error.code==='PARAMS_INVALID'||/INPUT_INVALID/.test(error.message));
 await assert.rejects(f.execute(cap,{}, {expectedRevision:'0'.repeat(64)}),/CAPABILITY_CHANGED/);
 assert.equal(f.received.length,0);
});

test('review: update CAS rejects stale source revision, rotates contract, and preserves prior generation on failed compile',async t=>{
 const f=await fixture(t);const first=await f.compile(),old=(await f.capabilities()).items[0];
 f.manifest.endpoints[0].query.page=2;await f.save();const second=await f.compile({expectedRevision:first.source.revision});
 assert.notEqual(second.source.revision,first.source.revision);assert.ok(second.changes.changed.includes(old.id));
 await assert.rejects(f.execute(old),/CAPABILITY_CHANGED/);await assert.rejects(f.compile({expectedRevision:first.source.revision}),/SOURCE_CHANGED/);
 assert.equal(f.runtime.getSource('test').revision,second.source.revision);
 await writeFile(f.inventoryPath,'{"malformed":');await assert.rejects(f.compile({expectedRevision:second.source.revision}));
 assert.equal(f.runtime.getSource('test').revision,second.source.revision);assert.equal(f.received.length,0);
});

test('review: concurrent compile attempts with same CAS base cannot both commit',async t=>{
 const f=await fixture(t);const first=await f.compile();f.manifest.endpoints.push(f.makeRecord({url:f.origin+'/added'}));await f.save();
 const results=await Promise.allSettled([f.compile({expectedRevision:first.source.revision}),f.compile({expectedRevision:first.source.revision})]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected').length,1);
 assert.notEqual(f.runtime.getSource('test').revision,first.source.revision);
});

for(const kind of ['apk','ios'])test(`review: ${kind} source directory normalizes and calls known method while unknown native method remains a gap`,async t=>{
 const f=await fixture(t,{kind});const mobile=path.join(f.dir,'mobile');await mkdir(mobile);
 const records=[f.makeRecord({url:f.origin+'/mobile',categories:['static_candidate'],source:kind==='ios'?'plist':'dex'}),f.makeRecord({method:null,url:f.origin+'/native-unknown',categories:['static_candidate'],source:'native'})];
 await writeFile(path.join(mobile,'endpoints.static.json'),JSON.stringify(records));
 const app=kind==='ios'?{package_name:'com.example.ios',bundle_id:'com.example.ios',version_name:'1',artifact_sha256:'a'.repeat(64),artifact_type:'app'}:{package_name:'com.example.apk',version_name:'1',apk_sha256:'b'.repeat(64)};
 await writeFile(path.join(mobile,'source.json'),JSON.stringify({format:'endpoint-inventory',schema_version:'1.1',source_id:'test',kind,inventory:'endpoints.static.json',app}));
 const built=await f.compile({inventoryPath:mobile});assert.ok(built.source.gaps.some(gap=>gap.reason==='method_unresolved'));
 const caps=await f.capabilities();const known=caps.items.find(cap=>cap.readiness==='ready'),unknown=caps.items.find(cap=>cap.name.includes('/native-unknown'));
 assert.ok(known);assert.ok(unknown);assert.equal(unknown.readiness,'candidate');await assert.rejects(f.execute(unknown),/CAPABILITY_NOT_READY/);
 const result=await f.execute(known,{query:{page:'2'}});
 assert.equal(result.result.ok,true);assert.deepEqual(result.result.data.provenance,['static_candidate']);assert.equal(f.received.length,1);
});

test('review: runtime credential injection survives generation and stays out of public manifest/results',async t=>{
 const f=await fixture(t);const cred=path.join(f.dir,'credentials.yaml');await writeFile(cred,'mode: token\ntoken: runtime-review-private-credential\n');
 // A fresh trusted runtime may bind credentials; a manifest cannot supply them.
 const runtime=createSoftwareRuntime({outputRoot:f.outputRoot,artifactRoots:[f.dir],bindings:{test:{allowed_origins:[f.origin],credential_origins:[f.origin],credentials:cred}}});
 await runtime.compile({sourceId:'test',inventoryPath:f.inventoryPath,kind:'web'});
 const cap=runtime.listCapabilities({sourceId:'test'}).items[0];
 const result=await runtime.execute({sourceId:'test',capabilityId:cap.id,expectedRevision:cap.revision,params:{query:{token:'provided'}},outputDir:path.join(f.dir,'auth-execution')});
 assert.equal(result.result.ok,true);assert.equal(f.received[0].authorization,'Bearer runtime-review-private-credential');
 assert.doesNotMatch(JSON.stringify({result,cap,source:runtime.getSource('test')}),/runtime-review-private-credential/);
});

test('review: generated entry discovers typed tools, executes real HTTP via worker, and rejects source revision updates',async t=>{
 const f=await fixture(t);const first=await f.compile(),cap=(await f.capabilities()).items[0];
 const generated=f.runtime.generate({sourceId:'test',expectedRevision:first.source.revision});
 assert.equal(JSON.parse(await readFile(generated.clientConfig,'utf8')).mcpServers.test.args[0],generated.entry);
 const transport=new StdioClientTransport({command:process.execPath,args:[generated.entry],cwd:project,stderr:'pipe',env:{...process.env}});
 let logs='';transport.stderr?.on('data',chunk=>logs=(logs+chunk).slice(-8192));
 const client=new Client({name:'runtime-independent-review',version:'1'});await client.connect(transport);t.after(()=>client.close());
 const tools=(await client.listTools()).tools,dynamic=tools.find(tool=>tool.name.startsWith('cap_'));
 assert.ok(dynamic,logs);assert.equal(typeof dynamic.inputSchema.properties.query.properties.token,'object');
 const call=await client.callTool({name:dynamic.name,arguments:{query:{token:'generated-caller-token',page:'2'}}});
 assert.ok(!call.isError,JSON.stringify(call));const op=content(call);
 const done=await until(async()=>{const reply=await client.callTool({name:'operation_status',arguments:{operationId:op.operationId}});const status=content(reply);return ['completed','failed','cancelled','interrupted'].includes(status.status)?status:null});
 assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(f.received.length,1);assert.match(f.received[0].url,/token=generated-caller-token/);
 assert.doesNotMatch(JSON.stringify(done),/generated-caller-token/);
 f.manifest.endpoints.push(f.makeRecord({url:f.origin+'/updated'}));await f.save();await f.compile({expectedRevision:first.source.revision});
 const stale=await client.callTool({name:'list_capabilities',arguments:{}});assert.equal(stale.isError,true);assert.match(stale.content[0].text,/SOURCE_CHANGED/);
 assert.equal(cap.id,(await f.capabilities()).items.find(item=>item.name==='GET /items').id);
});

test('review: repeated compile does not accumulate abandoned staging directories',async t=>{
 const f=await fixture(t);await f.compile();await f.compile();await f.compile();
 const dirs=await readdir(path.join(f.outputRoot,'sources/test'));
 assert.deepEqual(dirs.filter(name=>name.startsWith('staging-')),[]);
});

test('review: a single oversized capability must not bypass the catalog byte budget',async t=>{
 const f=await fixture(t);const id=endpointId('test',f.origin,'/items');
 const hugeSchema={type:'object',properties:{query:{type:'object',properties:{page:{type:'string',description:'x'.repeat(200000)}},additionalProperties:false}},additionalProperties:false};
 const runtime=createSoftwareRuntime({outputRoot:f.outputRoot,artifactRoots:[f.dir],bindings:{test:{allowed_origins:[f.origin],schema_overrides:{[id+':GET']:hugeSchema}}}});
 await runtime.compile({sourceId:'test',kind:'web',inventoryPath:f.inventoryPath});
 let result,error;try{result=runtime.listCapabilities({sourceId:'test',limit:1})}catch(e){error=e}
 assert.ok(error||Buffer.byteLength(JSON.stringify(result))<=131072,'single oversized capability must be rejected or returned within response budget');
});

test('review: repeated runtime/worker initialization keeps normalized artifact roots idempotent',async t=>{
 const f=await fixture(t);let runtime=f.runtime;
 for(let i=0;i<5;i++)runtime=createSoftwareRuntime(runtime.config);
 assert.equal(runtime.config.artifactRoots.length,new Set(runtime.config.artifactRoots).size);
});

test('review: schemas with an explicit $id remain callable more than once',async t=>{
 const f=await fixture(t),id=endpointId('test',f.origin,'/items');
 const schema={$id:'https://fixture.test/schemas/generated-review.json',type:'object',properties:{query:{type:'object',properties:{page:{type:'string'}},additionalProperties:false}},additionalProperties:false};
 const runtime=createSoftwareRuntime({outputRoot:f.outputRoot,artifactRoots:[f.dir],bindings:{test:{allowed_origins:[f.origin],schema_overrides:{[id+':GET']:schema}}}});
 await runtime.compile({sourceId:'test',kind:'web',inventoryPath:f.inventoryPath});const cap=runtime.listCapabilities({sourceId:'test'}).items[0];
 for(let n=0;n<2;n++){
  const result=await runtime.execute({sourceId:'test',capabilityId:cap.id,expectedRevision:cap.revision,params:{query:{page:String(n)}},outputDir:path.join(f.dir,'id-schema-'+n)});
  assert.equal(result.result.ok,true);
 }
 assert.equal(f.received.length,2);
});

test('review: trusted defaults satisfy required parameters before root preflight validation',async t=>{
 const f=await fixture(t),id=endpointId('test',f.origin,'/items');
 const schema={type:'object',required:['query'],properties:{query:{type:'object',required:['page'],properties:{page:{type:'string'}},additionalProperties:false}},additionalProperties:false};
 const runtime=createSoftwareRuntime({outputRoot:f.outputRoot,artifactRoots:[f.dir],bindings:{test:{allowed_origins:[f.origin],defaults:{[id]:{query:{page:'trusted-default'}}},schema_overrides:{[id+':GET']:schema}}}});
 await runtime.compile({sourceId:'test',kind:'web',inventoryPath:f.inventoryPath});const cap=runtime.listCapabilities({sourceId:'test'}).items[0];
 const result=await runtime.execute({sourceId:'test',capabilityId:cap.id,expectedRevision:cap.revision,params:{},outputDir:path.join(f.dir,'default-execution')});
 assert.equal(result.result.ok,true);assert.match(f.received[0].url,/page=trusted-default/);
});

test('review: generated public schema preserves effective constraints declared through local JSON Schema refs',async t=>{
 const f=await fixture(t),id=endpointId('test',f.origin,'/items');
 const schema={type:'object',$defs:{Page:{type:'string',pattern:'^[0-9]+$'}},required:['query'],properties:{query:{type:'object',required:['page'],properties:{page:{$ref:'#/$defs/Page'}},additionalProperties:false}},additionalProperties:false};
 const runtime=createSoftwareRuntime({outputRoot:f.outputRoot,artifactRoots:[f.dir],bindings:{test:{allowed_origins:[f.origin],schema_overrides:{[id+':GET']:schema}}}});
 await runtime.compile({sourceId:'test',kind:'web',inventoryPath:f.inventoryPath});const cap=runtime.listCapabilities({sourceId:'test'}).items[0];
 const validate=new Ajv2020({strict:false}).compile(cap.inputSchema);
 assert.equal(validate({query:{page:'2'}}),true);
 assert.equal(validate({query:{page:2}}),false,'published parameter type must match private invocation contract');
 assert.equal(validate({query:{page:'letters'}}),false,'published parameter pattern must match private invocation contract');
});

test('review: HTTP credential origin requires an explicit trusted binding, independent from invocation scope',async t=>{
 const f=await fixture(t),credentials=path.join(f.dir,'credential.yaml');await writeFile(credentials,'mode: token\ntoken: test-private-auth-value\n');
 const runtime=createSoftwareRuntime({outputRoot:f.outputRoot,artifactRoots:[f.dir],bindings:{test:{allowed_origins:[f.origin],credentials}}});
 await assert.rejects(runtime.compile({sourceId:'test',kind:'web',inventoryPath:f.inventoryPath}),/credential|凭据|CREDENTIAL/i);
 assert.equal(f.received.length,0);
});

test('review: model web settings cannot replace credentials or widen explicit startup scope (preflight only)',async t=>{
 const f=await fixture(t,{config:{webConfig:{navigationOrigins:['https://trusted.test'],requestOrigins:['https://trusted.test'],credentialOrigins:['https://trusted.test']}}});
 for(const key of ['storageState','authInject','proxy','extraLaunchArgs'])
  await assert.rejects(f.runtime.discover({kind:'web',input:'https://trusted.test',sourceId:'test',webOptions:{[key]:'untrusted-model-input'}},path.join(f.dir,'preflight')),/不支持的webOptions/);
 for(const key of ['navigationOrigins','requestOrigins','credentialOrigins'])
  await assert.rejects(f.runtime.discover({kind:'web',input:'https://trusted.test',sourceId:'test',webOptions:{[key]:['https://unapproved.test']}},path.join(f.dir,'preflight')),/SCOPE_EXPANSION/);
 assert.equal(f.received.length,0);
});

test('review: a failure reading prior generation cannot publish a new current pointer while reporting failure',async t=>{
 const f=await fixture(t);const first=await f.compile(),currentFile=path.join(f.outputRoot,'sources/test/current.json');
 const originalCurrent=JSON.parse(await readFile(currentFile,'utf8'));
 await writeFile(path.join(f.outputRoot,'sources/test/generations',first.source.revision,'manifest.json'),'{"corrupt":');
 f.manifest.endpoints.push(f.makeRecord({url:f.origin+'/new-generation'}));await f.save();
 let result,error;try{result=await f.compile({expectedRevision:first.source.revision})}catch(e){error=e}
 const after=JSON.parse(await readFile(currentFile,'utf8'));
 if(error)assert.equal(after.revision,originalCurrent.revision,'failed update must not switch the current pointer');
 else assert.equal(after.revision,result.source.revision,'successful recovery must report the committed revision');
});

test('review: trusted exact POST policy is retained and caller schema respects body replacement semantics',async t=>{
 const f=await fixture(t,{records:origin=>[{method:'POST',url:origin+'/items',headers:{'Content-Type':'application/json'},query:{},body:{name:'captured'},categories:['observed']}]});
 const id=endpointId('test',f.origin,'/items');
 const schema={type:'object',required:['body'],properties:{body:{type:'object',required:['name'],properties:{name:{type:'string'}},additionalProperties:false}},additionalProperties:false};
 const runtime=createSoftwareRuntime({outputRoot:f.outputRoot,artifactRoots:[f.dir],methods:{allow_non_get:true,allow:[{source:'test',endpoint_id:id,method:'POST'}]},bindings:{test:{allowed_origins:[f.origin],defaults:{[id]:{body:{name:'trusted-body'}}},schema_overrides:{[id+':POST']:schema}}}});
 await runtime.compile({sourceId:'test',kind:'web',inventoryPath:f.inventoryPath});const cap=runtime.listCapabilities({sourceId:'test'}).items[0];
 assert.equal(cap.readiness,'ready');
 const validate=new Ajv2020({strict:false}).compile(cap.inputSchema);
 assert.equal(validate({}),true,'absent body can use a trusted complete default');
 assert.equal(validate({body:{}}),false,'explicit body replaces the default and must retain its required fields');
 const result=await runtime.execute({sourceId:'test',capabilityId:cap.id,expectedRevision:cap.revision,params:{},outputDir:path.join(f.dir,'post-default')});
 assert.equal(result.result.ok,true);assert.equal(f.received[0].method,'POST');assert.equal(f.received[0].body,'{"name":"trusted-body"}');
});

test('review: a worker disconnected before module startup cancels before an HTTP request',async t=>{
 const f=await fixture(t);await f.compile();const cap=(await f.capabilities()).items[0];
 const out=path.join(f.dir,'startup-disconnect');await mkdir(out);
 const taskFile=path.join(out,'task.json');
 await writeFile(taskFile,JSON.stringify({id:'startup-disconnect',type:'execute',args:{sourceId:'test',capabilityId:cap.id,expectedRevision:cap.revision,params:{}},runtimeFile:f.runtime.runtimeFile,outputDir:out}));
 const script=`await new Promise(resolve=>setTimeout(resolve,100)); await import(${JSON.stringify(pathToFileURL(path.join(project,'src/software-worker.js')).href)});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,'worker-fixture',taskFile],{cwd:project,env:{...process.env,BFS_MCP_WORKER:'1'},stdio:['ignore','pipe','pipe','ipc']});
 let logs='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>logs=(logs+chunk).slice(-8192));
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL')});
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code))});
 child.disconnect();
 let timer;await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('disconnected worker did not exit: '+logs)),5000)})]).finally(()=>clearTimeout(timer));
 assert.equal(f.received.length,0,logs);
 const status=JSON.parse(await readFile(path.join(out,'status.json'),'utf8'));assert.equal(status.status,'cancelled');
});
