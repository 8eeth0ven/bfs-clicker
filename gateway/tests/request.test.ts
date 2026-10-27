import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CredentialProvider} from '../src/credentials.js';
import {Executor} from '../src/executor.js';
import {Redactor} from '../src/redact.js';
import type {GatewayConfig, SourceSnapshot, Endpoint, Operation, Method} from '../src/types.js';

async function fixture(t:any,options:{limit?:number,timeout?:number}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'gateway-request-'));
 const seen:any[]=[];let retry=0;
 const server=http.createServer(async(req,res)=>{
   let body='';for await(const chunk of req)body+=chunk;
   seen.push({url:req.url,method:req.method,headers:req.headers,body});
   const route=new URL(req.url!,'http://local').pathname;
   if(route==='/retry'&&retry++===0){res.writeHead(503);res.end('try again');return;}
   if(route==='/large'){res.writeHead(200,{'content-type':'text/plain'});res.end('中'.repeat(20000));return;}
   if(route==='/boundary'){res.writeHead(200,{'content-type':'text/plain'});res.end('x'.repeat((options.limit??64)-4)+'super-secret-cookie-value'+'tail');return;}
   if(route==='/redirect'){res.writeHead(302,{location:'http://127.0.0.1:1/escape'});res.end();return;}
   if(route==='/slow'){res.writeHead(200,{'content-type':'text/plain'});res.write('start');const timer=setTimeout(()=>res.end('end'),500);timer.unref();return;}
   res.writeHead(route==='/missing'?404:200,{'content-type':'application/json'});
   res.end(JSON.stringify({authorization:req.headers.authorization,cookie:req.headers.cookie,query:Object.fromEntries(new URL(req.url!,'http://local').searchParams),password:'new-upstream-secret',body,ok:true}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});});
 const credentials=path.join(dir,'credentials.yaml');await writeFile(credentials,'mode: token\ntoken: super-secret-bearer-value\n');
 const config:GatewayConfig={config_dir:dir,manifest_roots:[dir],state_dir:dir,sources:[],timeout_ms:options.timeout??2000,max_body_bytes:options.limit??32768,max_catalog_bytes:131072,success_threshold:3,missing_threshold:3,methods:{allow_non_get:false,allow:[]}};
 const source:SourceSnapshot={id:'test',kind:'web',revision:'rev1',manifest_path:dir,endpoints:[],origins:[origin],warnings:[],binding:{id:'test',manifest:dir,credentials,credential_origins:[origin],allowed_origins:[origin]}};
 const provider=new CredentialProvider(),executor=new Executor(config,provider);
 function operation(method:Method='GET'):Operation{return {method,provenance:['static_candidate'],categories:[],description:'',extraction_sources:['asset'],locations:[],parameter_summary:[],params_schema:{type:'object',properties:{path:{type:'object',additionalProperties:{type:['string','number']}},query:{type:'object',additionalProperties:{anyOf:[{type:['string','number','boolean','null']},{type:'array',items:{type:['string','number','boolean']}}]}},body:{}},additionalProperties:false},body_encoding:'json',allowed:method==='GET',contract_revision:'c1'};}
 function endpoint(route:string,method:Method='GET'):Endpoint{return {id:'ep_'+'a'.repeat(64),source:'test',source_revision:'rev1',origin,path:route,methods:[method],operations:{[method]:operation(method)},unresolved_candidates:[]};}
 async function call(route:string,params:any={},method:Method='GET'){const ep=endpoint(route,method);return executor.execute(source,ep,ep.operations[method]!,params);}
 return {dir,seen,origin,source,config,provider,executor,credentials,operation,endpoint,call};
}

test('Bearer automatically injected, response JSON and unknown sensitive fields redacted',async t=>{
 const f=await fixture(t);const result=await f.call('/json',{query:{tag:['blue','new'],empty:'',omit:null}});
 assert.equal(f.seen[0].headers.authorization,'Bearer super-secret-bearer-value');
 assert.match(f.seen[0].url,/tag=blue&tag=new/);assert.doesNotMatch(f.seen[0].url,/omit=/);
 assert.equal(result.ok,true);assert.equal(result.data.response.body.format,'json');
 assert.doesNotMatch(JSON.stringify(result),/super-secret-bearer-value|new-upstream-secret/);
 assert.equal(result.data.response.attempts,1);
});
test('GET-only and exact write allowlist are independently enforced',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.call('/write',{body:{}},'POST'),{code:'METHOD_BLOCKED'});
 f.config.methods.allow_non_get=true;
 await assert.rejects(f.call('/write',{body:{}},'POST'),{code:'METHOD_BLOCKED'});
 f.config.methods.allow.push({source:'test',endpoint_id:f.endpoint('/write').id,method:'POST'});
 const result=await f.call('/write',{body:null},'POST');
 assert.equal(result.ok,true);assert.equal(f.seen[0].body,'null');assert.equal(f.seen[0].method,'POST');
 assert.equal(f.seen.length,1);
});
test('path, origin, credentials origin and session actions stop before network',async t=>{
 const f=await fixture(t);
 for(const id of ['..','%2e%2e','a/b','%252fadmin','a\\b'])await assert.rejects(f.call('/users/{id}',{path:{id}}),{code:'PATH_BLOCKED'});
 await assert.rejects(f.call('/logout'),{code:'SESSION_ACTION_BLOCKED'});
 await assert.rejects(f.call('/auth/logoutAll'),{code:'SESSION_ACTION_BLOCKED'});
 await assert.rejects(f.call('/oauth/revokeToken'),{code:'SESSION_ACTION_BLOCKED'});
 await assert.rejects(f.call('/api',{query:{action:'signout'}}),{code:'SESSION_ACTION_BLOCKED'});
 await assert.rejects(f.call('/api',{query:{operationName:'logoutAll'}}),{code:'SESSION_ACTION_BLOCKED'});
 const ep=f.endpoint('/json');ep.origin='http://127.0.0.1:1';
 await assert.rejects(f.executor.execute(f.source,ep,f.operation(),{}),{code:'ORIGIN_BLOCKED'});
 f.source.binding.credential_origins=['https://different.test'];
 await assert.rejects(f.call('/json'),{code:'CREDENTIAL_ORIGIN_BLOCKED'});
 assert.equal(f.seen.length,0);
});
test('response cap is UTF-8 bytes, truncated JSON/text never exceeds budget',async t=>{
 const f=await fixture(t,{limit:32768});const result=await f.call('/large');
 assert.equal(result.ok,true);assert.equal(result.data.response.body.truncated,true);
 assert.ok(Buffer.byteLength(result.data.response.body.value)<=32768);
 assert.doesNotMatch(result.data.response.body.value,/\uFFFD/);
 assert.equal(result.data.response.body.format,'text');
});
test('known secret spanning truncation boundary never leaks its prefix',async t=>{
 const f=await fixture(t,{limit:64});await writeFile(f.credentials,'mode: cookie\ncookie: sid=super-secret-cookie-value\n');
 const result=await f.call('/boundary');const output=result.data.response.body.value;
 assert.doesNotMatch(output,/supe|secret-cookie/);assert.match(output,/REDACTED/);assert.ok(Buffer.byteLength(output)<=64);
});
test('one retry, no retry for 404, all redirects blocked',async t=>{
 const f=await fixture(t);const retried=await f.call('/retry');assert.equal(retried.data.response.attempts,2);
 const missing=await f.call('/missing');assert.equal(missing.error?.code,'UPSTREAM_HTTP_ERROR');assert.equal(missing.data.response.attempts,1);
 const redirect=await f.call('/redirect');assert.equal(redirect.error?.code,'REDIRECT_BLOCKED');assert.equal(redirect.data.response.status,302);
 assert.equal(f.seen.length,4);
});
test('total deadline includes response body, incomplete 200 is not a successful observation',async t=>{
 const f=await fixture(t,{timeout:60});const result=await f.call('/slow');
 assert.equal(result.error?.code,'TIMEOUT');assert.equal(result.data.observation_status,null);assert.equal(result.data.response.status,200);
 assert.ok(result.data.response.duration_ms<400);
});
test('storageState filters cookie Domain/Path/Secure/Expires and does not guess localStorage',async t=>{
 const f=await fixture(t);const storage=path.join(f.dir,'state.json');
 const cookie=(name:string,more:any={})=>({name,value:name+'-secret-value',domain:'api.example.test',path:'/',secure:false,expires:-1,...more});
 await writeFile(storage,JSON.stringify({cookies:[cookie('root'),cookie('private',{path:'/foo'}),cookie('expired',{expires:1}),cookie('secure',{secure:true}),cookie('partition',{partitionKey:'https://example.test'}),cookie('domain',{domain:'.example.test'})],origins:[{origin:'https://api.example.test',localStorage:[{name:'token',value:'not-a-bearer'}]}]}));
 await writeFile(f.credentials,'mode: storageState\nstorageState: state.json\n');
 f.source.binding.credential_origins=['http://api.example.test'];
 const context=await f.provider.load(f.source.binding);
 const headers=context.headersFor(new URL('http://api.example.test/foobar'));
 assert.match(headers.Cookie,/root=/);assert.match(headers.Cookie,/domain=/);
 assert.doesNotMatch(headers.Cookie,/private=|expired=|secure=|partition=/);assert.equal(headers.Authorization,undefined);
 assert.match(context.headersFor(new URL('http://api.example.test/foo/bar')).Cookie,/private=/);
});
test('credential configuration rejects ambiguity and CRLF without anonymous downgrade',async t=>{
 const f=await fixture(t);await writeFile(f.credentials,'mode: token\ntoken: abcdefghijklmnop\ncookie: sid=othersecret\n');
 await assert.rejects(f.call('/json'),{code:'CREDENTIALS_INVALID'});
 await writeFile(f.credentials,JSON.stringify({mode:'headers',headers:{Authorization:'Bearer abc\r\nHost: evil'}}));
 await assert.rejects(f.call('/json'),{code:'CREDENTIALS_INVALID'});assert.equal(f.seen.length,0);
 await writeFile(f.credentials,JSON.stringify({mode:'cookie',cookie:''}));
 await assert.rejects(f.call('/json'),{code:'CREDENTIALS_INVALID'});
 await writeFile(f.credentials,JSON.stringify({mode:'headers',headers:{Cookie:'sid=header-mode-cookie-secret'}}));
 const loaded=await f.provider.load(f.source.binding);
 assert.doesNotMatch(loaded.redactor.text('echo header-mode-cookie-secret'),/header-mode-cookie-secret/);
});
test('redactor handles encoded/escaped secrets, new keys, HTML and original-prefix boundaries',()=>{
 const r=new Redactor(['abc/secret+value','secret-cross-boundary']);
 assert.doesNotMatch(r.text(encodeURIComponent('abc/secret+value')),/abc|secret/);
 assert.doesNotMatch(r.text('token=brand-new-unknown-value'),/brand-new/);
 assert.doesNotMatch(r.text('<input name="password" value="brand-new">'),/brand-new/);
 const text='x'.repeat(28)+'secret-cross-boundary'+'y'.repeat(50);
 assert.doesNotMatch(r.prefix(Buffer.from(text),32),/secr/);
 assert.equal(r.value({access_token:'new-value',nested:{password:'another'}}).access_token,'[REDACTED]');
 assert.equal(r.text(r.text('token=brand-new-unknown-value')),r.text('token=brand-new-unknown-value'));
 const markerSecret=new Redactor(['A']);assert.equal(markerSecret.text(markerSecret.text('ABC')),markerSecret.text('ABC'));
 const schema=r.value({params_schema:{type:'object',properties:{token:{type:'string',examples:['secret-example']},password:{type:'string',const:'unknown-password'}},required:['token']}}).params_schema;
 assert.equal(schema.properties.token.type,'string');assert.equal(schema.properties.token.examples,undefined);assert.equal(schema.properties.password.const,undefined);
 const short=new Redactor(['1','en']);
 const publicOutput=short.result({data:{source:'site-en-1',endpoint_id:'ep_'+'1'.repeat(64),origin:'http://127.0.0.1:8765',path:'/v1/endpoints',provenance:['observed'],response:{body:{format:'text',value:'prefix1suffix'}}}});
 assert.equal(publicOutput.data.source,'site-en-1');assert.equal(publicOutput.data.endpoint_id,'ep_'+'1'.repeat(64));
 assert.equal(publicOutput.data.origin,'http://127.0.0.1:8765');assert.equal(publicOutput.data.path,'/v1/endpoints');
 assert.equal(publicOutput.data.response.body.value,'prefix[REDACTED]suffix');
 const concurrent=new Redactor(['a']);
 const limited=concurrent.result({data:{response:{body:{format:'text',value:'a'.repeat(64),limit_bytes:64,truncated:false,returned_bytes:64}}}});
 assert.ok(Buffer.byteLength(limited.data.response.body.value)<=64);assert.equal(limited.data.response.body.returned_bytes,Buffer.byteLength(limited.data.response.body.value));
});
