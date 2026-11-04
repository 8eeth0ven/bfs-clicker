import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {importOpenApi} from '../../src/openapi-discovery.js';
import {loadManifest,endpointId} from '../src/manifest.js';
import {Executor} from '../src/executor.js';
import {CredentialProvider} from '../src/credentials.js';
import {Redactor} from '../src/redact.js';
import {multipartRules,serializeMultipart,MULTIPART_LIMITS} from '../src/multipart-serialization.js';
import type {GatewayConfig} from '../src/types.js';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const payload=Buffer.from([0,1,2,255,13,10,128,42]);
const input=()=>({title:'中文 😀',count:2,enabled:false,tags:['one','two'],upload:{filename:'sample.bin',base64:payload.toString('base64')},files:[{filename:'empty.bin',base64:''},{filename:'other.bin',base64:'YQ=='}]});
function spec(origin:string,extra:any={}){return {openapi:'3.1.1',servers:[{url:origin}],paths:{'/upload':{post:{requestBody:{required:true,content:{'multipart/form-data':{schema:{type:'object',properties:{title:{type:'string'},count:{type:'integer',minimum:1},enabled:{type:'boolean'},tags:{type:'array',items:{type:'string'}},upload:{},files:{type:'array',items:{}}},required:['title','upload'],additionalProperties:false},encoding:{upload:{contentType:'application/octet-stream'},files:{contentType:'application/octet-stream'}}}}}}}},...extra};}
async function fixture(t:any){
 const dir=await mkdtemp(path.join(os.tmpdir(),'gateway-multipart-')),seen:any[]=[];let origin='';
 const server=http.createServer(async(req,res)=>{
  try{
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const raw=Buffer.concat(chunks);
   const form=await new Request(origin+req.url,{method:'POST',headers:{'content-type':String(req.headers['content-type'])},body:new Uint8Array(raw)}).formData();const parts:any[]=[];
   for(const [name,item]of form.entries())parts.push(typeof item==='string'?{name,value:item}:{name,filename:item.name,type:item.type,bytes:Buffer.from(await item.arrayBuffer()),sha256:hash(new Uint8Array(await item.arrayBuffer()))});
   seen.push({method:req.method,url:req.url,headers:req.headers,raw,parts});const upload=parts.find((p:any)=>p.name==='upload'),firstFile=parts.find((p:any)=>p.filename),bytes=upload?.bytes||firstFile?.bytes||Buffer.alloc(0);let rawUTF8;try{rawUTF8=new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(bytes)}catch{}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'upload-123',url:origin+'/items/upload-123',acceptedBytes:parts.filter((p:any)=>p.bytes).reduce((n:number,p:any)=>n+p.bytes.length,0),fullBase64:bytes.toString('base64'),dataUri:'data:application/octet-stream;base64,'+bytes.toString('base64'),rawUTF8,params_schema:{type:bytes.toString('base64'),required:[rawUTF8??bytes.toString('base64')]},shortEcho:parts.find((p:any)=>p.filename==='other.bin')?.bytes.toString('utf8'),authorization:req.headers.authorization,ok:true}));
  }catch{res.writeHead(500);res.end('parser failure');}
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${(server.address() as any).port}`;
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});});
 const imported=importOpenApi({sourceId:'upload',document:spec(origin),allowedOrigins:[origin]}),manifest=path.join(dir,'inventory.json');assert.equal(imported.manifest[0].readiness,'ready');await writeFile(manifest,JSON.stringify(imported.manifest));
 const config:GatewayConfig={config_dir:dir,manifest_roots:[dir],state_dir:dir,sources:[],timeout_ms:2000,max_body_bytes:65536,max_catalog_bytes:131072,success_threshold:3,missing_threshold:3,methods:{allow_non_get:true,allow:[{source:'upload',endpoint_id:endpointId('upload',origin,'/upload'),method:'POST'}]}};
 const source=await loadManifest({id:'upload',manifest,public:true,allowed_origins:[origin],schema_overrides:imported.schemaOverrides},config),endpoint=source.endpoints[0],op=endpoint.operations.POST!,provider=new CredentialProvider(),executor=new Executor(config,provider);
 return {dir,seen,origin,manifest,imported,config,source,endpoint,op,executor,provider};
}
test('real HTTP parser verifies mixed fields, repeated files, exact octets and useful locally scrubbed response',async t=>{
 const f=await fixture(t),result=await f.executor.execute(f.source,f.endpoint,f.op,{body:input()});assert.equal(result.ok,true);assert.equal(f.seen.length,1);
 const received=f.seen[0];assert.equal(received.method,'POST');assert.match(received.headers['content-type'],/^multipart\/form-data; boundary=bfs-mcp-/);assert(received.raw.length<=1048576);
 const text=Object.fromEntries(received.parts.filter((x:any)=>x.value!==undefined).map((x:any)=>[x.name,x.value]));assert.equal(text.title,'中文 😀');assert.equal(text.count,'2');assert.equal(text.enabled,'false');assert.deepEqual(received.parts.filter((x:any)=>x.name==='tags').map((x:any)=>x.value),['one','two']);
 const upload=received.parts.find((x:any)=>x.name==='upload');assert.equal(upload.filename,'sample.bin');assert.equal(upload.type,'application/octet-stream');assert.deepEqual(upload.bytes,payload);assert.equal(upload.sha256,hash(payload));
 const files=received.parts.filter((x:any)=>x.name==='files');assert.deepEqual(files.map((x:any)=>x.filename),['empty.bin','other.bin']);assert.deepEqual(files.map((x:any)=>x.bytes.length),[0,1]);assert.equal(files[1].bytes.toString(),'a');
 const business=result.data.response.body.value;assert.equal(result.data.response.body.format,'json');assert.equal(business.id,'upload-123');assert.equal(business.url,f.origin+'/items/upload-123');assert.equal(business.acceptedBytes,payload.length+1);assert.equal(business.fullBase64,'[REDACTED]');assert.equal(business.dataUri,'data:application/octet-stream;base64,[REDACTED]');assert.equal(business.shortEcho,'[REDACTED]');assert.equal(business.params_schema.type,'[REDACTED]');assert.equal(business.params_schema.required[0],'[REDACTED]');assert(!JSON.stringify(result).includes(payload.toString('base64')));assert.equal(result.data.response.attempts,1);
});
test('canonical base64, filename, type and extra-field negatives make zero HTTP requests',async t=>{
 const f=await fixture(t),badFiles:any[]=[{filename:'a.bin',base64:'YQ'},{filename:'a.bin',base64:'YQ==\n'},{filename:'a.bin',base64:'YR=='},{filename:'a.bin',base64:'AA-_'},{filename:'a.bin',base64:'YQ==='},{filename:'../a.bin',base64:''},{filename:'a\\b',base64:''},{filename:'a";x.bin',base64:''},{filename:'a\r\nX:y',base64:''},{filename:'a%2f.bin',base64:''},{filename:'中文.bin',base64:''},{filename:'a.bin',base64:'',contentType:'text/plain'},{filename:'a.bin',base64:'',path:'/etc/passwd'},{filename:'a.bin',url:'https://example.invalid/file'}];
 for(const file of badFiles){await assert.rejects(f.executor.execute(f.source,f.endpoint,f.op,{body:{...input(),upload:file}}));assert.equal(f.seen.length,0);}
 for(const body of [{...input(),other:'value'},{...input(),title:'\ud800'},{...input(),enabled:'false'},{...input(),files:[]},{...input(),upload:null}]){await assert.rejects(f.executor.execute(f.source,f.endpoint,f.op,{body} as any));assert.equal(f.seen.length,0);}
});
test('file, count, text and total-body hard bounds reject before HTTP',async t=>{
 const f=await fixture(t),file=(n:number)=>({filename:'bytes.bin',base64:Buffer.alloc(n,1).toString('base64')});
 for(const body of [{...input(),upload:file(262145)},{...input(),upload:file(262144),files:[file(262144),file(1)]},{...input(),files:Array.from({length:8},()=>file(1))},{...input(),title:'中'.repeat(21846)}]){await assert.rejects(f.executor.execute(f.source,f.endpoint,f.op,{body}));assert.equal(f.seen.length,0);}
 const accepted=await f.executor.execute(f.source,f.endpoint,f.op,{body:{title:'boundary',upload:file(262144)}});assert.equal(accepted.ok,true);assert.equal(f.seen.length,1);assert.equal(f.seen[0].parts.find((p:any)=>p.name==='upload').bytes.length,262144);
 const contract=multipartRules({schemaVersion:1,fields:Object.fromEntries(Array.from({length:16},(_,i)=>['field'+i,{kind:'text',valueType:'string',contentType:'text/plain',array:false}]))});
 assert.throws(()=>serializeMultipart(Object.fromEntries(Array.from({length:16},(_,i)=>['field'+i,'x'.repeat(65536)])),contract),{code:'REQUEST_TOO_LARGE'});
});
test('exact method, source, origin, credentials and logout gates remain effective',async t=>{
 const f=await fixture(t);f.config.methods.allow=[];await assert.rejects(f.executor.execute(f.source,f.endpoint,f.op,{body:input()}),{code:'METHOD_BLOCKED'});f.config.methods.allow=[{source:'upload',endpoint_id:f.endpoint.id,method:'POST'}];
 await assert.rejects(f.executor.execute({...f.source,id:'other'},f.endpoint,f.op,{body:input()}),{code:'METHOD_BLOCKED'});
 await assert.rejects(f.executor.execute(f.source,{...f.endpoint,origin:'http://127.0.0.1:1'},f.op,{body:input()}),{code:'ORIGIN_BLOCKED'});
 await assert.rejects(f.executor.execute(f.source,{...f.endpoint,path:'/logout'},f.op,{body:input()}),{code:'SESSION_ACTION_BLOCKED'});
 const credentials=path.join(f.dir,'credential.yaml');await writeFile(credentials,'mode: token\ntoken: multipart-synthetic-credential\n');f.source.binding={...f.source.binding,public:false,credentials,credential_origins:['https://different.example.invalid']};
 await assert.rejects(f.executor.execute(f.source,f.endpoint,f.op,{body:input()}),{code:'CREDENTIAL_ORIGIN_BLOCKED'});assert.equal(f.seen.length,0);
 f.source.binding.credential_origins=[f.origin];const result=await f.executor.execute(f.source,f.endpoint,f.op,{body:input()});assert.equal(f.seen[0].headers.authorization,'Bearer multipart-synthetic-credential');assert(!JSON.stringify(result).includes('multipart-synthetic-credential'));
});
test('only declared multipart contracts become executable and MIME changes alter revisions',async t=>{
 const f=await fixture(t),record=f.imported.manifest[0];
 for(const changed of [{...record,multipart_serialization:undefined},{...record,headers:{'content-type':'multipart/mixed'},multipart_serialization:undefined}]){await writeFile(f.manifest,JSON.stringify([changed]));const got=await loadManifest({...f.source.binding,schema_overrides:f.imported.schemaOverrides},f.config);assert.equal(got.endpoints[0].operations.POST!.allowed,false);}
 for(const changed of [{...record,headers:{'content-type':'application/json'}},{...record,multipart_serialization:{schemaVersion:1,fields:{file:{kind:'file',array:false,contentType:'image/*'}}}}]){await writeFile(f.manifest,JSON.stringify([changed]));await assert.rejects(loadManifest(f.source.binding,f.config),{code:'MULTIPART_CONTRACT_INVALID'});}
 await writeFile(f.manifest,JSON.stringify([record]));await assert.rejects(loadManifest({...f.source.binding,static_headers:{'Content-Type':'application/json'}},f.config),{code:'MULTIPART_CONTRACT_INVALID'});
 const changed=structuredClone(record);changed.multipart_serialization.fields.upload.contentType='image/png';await writeFile(f.manifest,JSON.stringify([changed]));const newer=await loadManifest({...f.source.binding,schema_overrides:f.imported.schemaOverrides},f.config);assert.notEqual(newer.revision,f.source.revision);assert.notEqual(newer.endpoints[0].operations.POST!.contract_revision,f.op.contract_revision);
 await writeFile(f.manifest,JSON.stringify([record,changed]));const conflict=await loadManifest(f.source.binding,f.config);assert.equal(conflict.endpoints[0].operations.POST!.allowed,false);assert.equal(conflict.endpoints[0].operations.POST!.blocked_reason,'MULTIPART_SERIALIZATION_CONFLICT');assert.equal(f.seen.length,0);
});


test('large overlapping echoes preserve the existing bounded business prefix and local scope',async t=>{
 const f=await fixture(t);f.config.max_body_bytes=1024*1024;
 const first='a'.repeat(262140)+'END1',second='a'.repeat(262140)+'END2';
 const body={title:'largest total files',upload:{filename:'first.txt',base64:Buffer.from(first).toString('base64')},files:[{filename:'second.txt',base64:Buffer.from(second).toString('base64')}]};
 const result=await f.executor.execute(f.source,f.endpoint,f.op,{body});assert.equal(result.ok,true);assert.equal(f.seen.length,1);const business=result.data.response.body.value;assert.equal(result.data.response.body.format,'text');assert.equal(result.data.response.body.truncated,true);assert(Buffer.byteLength(business)<=f.config.max_body_bytes);assert(business.includes('upload-123'));assert(business.includes(f.origin+'/items/upload-123'));assert(business.includes('524288'));assert(business.includes('[REDACTED]'));assert(!business.includes(body.upload.base64.slice(0,64)));assert(!business.includes(first.slice(0,64)));assert.equal(f.provider.redactor.text(first),first);assert.equal(f.provider.redactor.text(body.upload.base64),body.upload.base64);
 const local=new Redactor(['shared-credential']).forkForTransaction([{value:'prefix/shared-credential/suffix',exact:false},{value:'a',exact:true}]);const safe=local.value({id:'upload-123',url:'https://example.invalid/data',echo:'prefix/shared-credential/suffix',credentialEcho:'Bearer shared-credential',small:'a'});assert.equal(safe.id,'upload-123');assert.equal(safe.url,'https://example.invalid/data');assert.equal(safe.echo,'[REDACTED]');assert(!JSON.stringify(safe).includes('shared-credential'));assert.equal(safe.small,'[REDACTED]');
});

test('matching resource budget rejects before dispatch and small-file floods stay bounded',async t=>{
 const f=await fixture(t);f.config.max_body_bytes=8*1024*1024;await assert.rejects(f.executor.execute(f.source,f.endpoint,f.op,{body:input()}),{code:'REDACTION_BUDGET_EXCEEDED'});assert.equal(f.seen.length,0);f.config.max_body_bytes=65536;
 const file=(letter:string)=>({filename:letter+'.txt',base64:Buffer.from(letter).toString('base64')});const result=await f.executor.execute(f.source,f.endpoint,f.op,{body:{title:'short',upload:file('a'),files:['b','c','d','e','f','g','h'].map(file)}});assert.equal(result.ok,true);assert.equal(result.data.response.body.value.url,f.origin+'/items/upload-123');assert.equal(f.seen.length,1);
 f.provider.redactor.addSecrets(Array.from({length:65},(_,i)=>'seed" /'+i));await assert.rejects(f.executor.execute(f.source,f.endpoint,f.op,{body:input()}),{code:'REDACTION_BUDGET_EXCEEDED'});assert.equal(f.seen.length,1);
});

test('worst-size UTF8 control content and credentials scrub even a truncated JSON echo',async t=>{
 const f=await fixture(t),credential='multipart-control-synthetic-credential',fileText='\0'.repeat(262144-credential.length)+credential,other='\0'.repeat(262143)+'x';
 const credentials=path.join(f.dir,'control-credential.yaml');await writeFile(credentials,'mode: token\ntoken: '+credential+'\n');f.source.binding={...f.source.binding,public:false,credentials,credential_origins:[f.origin]};f.config.max_body_bytes=512;
 const encoded=Buffer.from(fileText).toString('base64'),body={title:'control bytes',upload:{filename:'nul.bin',base64:encoded},files:[{filename:'other.bin',base64:Buffer.from(other).toString('base64')}]};
 const result=await f.executor.execute(f.source,f.endpoint,f.op,{body});assert.equal(result.ok,true);assert.equal(f.seen.length,1);assert.equal(f.seen[0].parts.filter((p:any)=>p.bytes).reduce((n:number,p:any)=>n+p.bytes.length,0),524288);
 assert.equal(result.data.response.body.format,'text');assert.equal(result.data.response.body.truncated,true);assert(Buffer.byteLength(result.data.response.body.value)<=512);assert(result.data.response.body.value.includes('upload-123'));assert(result.data.response.body.value.includes(f.origin+'/items/upload-123'));assert(result.data.response.body.value.includes('[REDACTED]'));assert(!result.data.response.body.value.includes('AAAA'));assert(!JSON.stringify(result).includes(credential));assert.equal(f.provider.redactor.text(encoded),encoded);
});

test('transaction text keeps a file BOM for exact matching and overlapping spans never expose tails',()=>{
 const credential='shared-credential',file='\ufeffprefix/'+credential+'/suffix',global=new Redactor([credential]),fork=global.forkForTransaction([{value:file,exact:false},{value:'YQ==',exact:false},{value:'a',exact:true}]);fork.assertResponseBudget(4096);
 assert.equal(fork.prefix(Buffer.from(file),4096),'[REDACTED]');const text='id=upload-123\n'+file+'\nBearer '+credential;assert(!fork.prefix(Buffer.from(text),4096).includes('prefix/'));assert(!fork.prefix(Buffer.from(text),4096).includes(credential));assert.equal(fork.value({id:'upload-123',url:'https://example.invalid/data',small:'a'}).url,'https://example.invalid/data');assert.equal(global.text(file),'\ufeffprefix/[REDACTED]/suffix');
});

test('ordinary HTTP schema-shaped JSON is untrusted while actual catalog contracts keep types',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'gateway-untrusted-schema-')),secret='normal-json-synthetic-credential';let origin='',requests=0;
 const server=http.createServer((_req,res)=>{requests++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'response-123',url:origin+'/next',params_schema:{type:secret,required:[secret],format:secret},body_schema:{type:secret,required:[secret],format:secret},body_shape:{type:secret,properties:{x:{const:secret}}}}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${(server.address() as any).port}`;t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});});const credentials=path.join(dir,'credential.yaml');await writeFile(credentials,'mode: token\ntoken: '+secret+'\n');
 const config:GatewayConfig={config_dir:dir,manifest_roots:[dir],state_dir:dir,sources:[],timeout_ms:2000,max_body_bytes:32768,max_catalog_bytes:131072,success_threshold:3,missing_threshold:3,methods:{allow_non_get:false,allow:[]}};
 const schema={type:'object',properties:{path:{type:'object',properties:{},additionalProperties:false},query:{type:'object',properties:{},additionalProperties:false}},additionalProperties:false};
 const op:any={method:'GET',provenance:['static_candidate'],categories:[],description:'',extraction_sources:['asset'],locations:[],parameter_summary:[],params_schema:schema,body_encoding:'json',allowed:true,contract_revision:'test'};
 const endpoint:any={id:endpointId('json',origin,'/json'),source:'json',source_revision:'test',origin,path:'/json',methods:['GET'],operations:{GET:op},unresolved_candidates:[]};
 const source:any={id:'json',kind:'web',revision:'test',manifest_path:dir,endpoints:[endpoint],origins:[origin],warnings:[],binding:{id:'json',manifest:dir,credentials,credential_origins:[origin],allowed_origins:[origin]}};
 const provider=new CredentialProvider(),result=await new Executor(config,provider).execute(source,endpoint,op,{});assert.equal(result.ok,true);assert.equal(requests,1);assert.equal(result.data.response.body.value.id,'response-123');assert.equal(result.data.response.body.value.url,origin+'/next');assert(!JSON.stringify(result).includes(secret));
 const final=provider.redactor.result(result);assert(!JSON.stringify(final).includes(secret));assert.equal(final.data.response.body.value.params_schema.type,'[REDACTED]');assert.equal(final.data.response.body.value.body_schema.required[0],'[REDACTED]');assert.equal(final.data.response.body.value.body_schema.format,'[REDACTED]');
 const contract={params_schema:{type:'object',properties:{query:{type:'string',enum:['a','b']}},required:['query'],additionalProperties:false}};assert.deepEqual(JSON.parse(JSON.stringify(provider.redactor.catalogValue(contract))),contract);
});
