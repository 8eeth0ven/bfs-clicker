import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFileSync,readFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {importOpenApi} from '../src/openapi-discovery.js';
import {createSoftwareRuntime} from '../src/software-runtime.js';
import {serializeQuery,queryRules} from '../gateway/dist/query-serialization.js';
import {Redactor} from '../gateway/dist/redact.js';
import {temp,fixture,until,root} from './helpers.mjs';

const decode=value=>decodeURIComponent(value.replace(/\+/g,' '));
const rawQuery=url=>Object.fromEntries(url.search.slice(1).split('&').filter(Boolean).map(pair=>{const index=pair.indexOf('=');return [decode(pair.slice(0,index)),pair.slice(index+1)]}));
const param=(name,schema,style='form',explode=true)=>({in:'query',name,required:true,schema,style,explode});
const strings={type:'array',items:{type:'string'},minItems:1,maxItems:5};
const point={type:'object',properties:{x:{type:'integer',minimum:0},label:{type:'string'}},required:['x','label'],additionalProperties:false};
const document=(origin,paths)=>({openapi:'3.1.1',info:{title:'Query formats',version:'1'},servers:[{url:origin}],paths});
async function call(client,name,args={}){const reply=await client.callTool({name,arguments:args});assert(!reply.isError,JSON.stringify(reply));return reply.structuredContent||JSON.parse(reply.content[0].text);}
async function completed(client,started,{failed=false,statusTool='software_operation'}={}){return until(async()=>{const state=await call(client,statusTool,{operationId:started.operationId});if(state.status==='failed'){if(failed)return state;throw Error(JSON.stringify(state));}return state.status==='completed'&&state;},20000);}
async function connect(t,args){const transport=new StdioClientTransport({command:process.execPath,args,cwd:root,stderr:'pipe'});let stderr='';transport.stderr.on('data',data=>stderr+=data);const client=new Client({name:'query-wire-test',version:'1'});await client.connect(transport);t.after(()=>client.close());return {client,stderr:()=>stderr};}

test('query serializer preserves delimiters, encoded data and repeated names without guessing object layouts',()=>{
 const array=(style,explode=false)=>({tags:{style,explode,kind:'array'}}),object=(style,explode)=>({filter:{style,explode,kind:'object'}});
 assert.equal(serializeQuery({tags:['a,b','x+y','中 文']},array('form')),'tags=a%2Cb,x%2By,%E4%B8%AD%20%E6%96%87');
 assert.equal(serializeQuery({tags:['a','b']},array('form',true)),'tags=a&tags=b');
 assert.equal(serializeQuery({tags:['a','b']},array('spaceDelimited')),'tags=a%20b');
 assert.equal(serializeQuery({tags:['a','b']},array('pipeDelimited')),'tags=a%7Cb');
 assert.equal(serializeQuery({tags:['a','b']},array('tabDelimited')),'tags=a%09b');
 assert.equal(serializeQuery({toString:'abc',hasOwnProperty:42}),'toString=abc&hasOwnProperty=42');
 assert.equal(serializeQuery({filter:{x:2,label:'a,b'}},object('form',false)),'filter=x,2,label,a%2Cb');
 assert.equal(serializeQuery({filter:{x:2,label:'a+b'}},object('form',true)),'x=2&label=a%2Bb');
 assert.equal(serializeQuery({filter:{x:2,label:'a b'}},object('deepObject',true)),'filter%5Bx%5D=2&filter%5Blabel%5D=a%20b');
 assert.equal(serializeQuery({tags:[],none:null,filter:{}},{...array('form'),...object('deepObject',true)}),'');
 for(const [query,rules,code]of [
  [{filter:{nested:{x:1}}},object('deepObject',true),'UNSUPPORTED_QUERY_ENCODING'],
  [{filter:{x:1},x:2},object('form',true),'QUERY_NAME_COLLISION'],
  [{tags:['a|b']},array('pipeDelimited'),'AMBIGUOUS_QUERY_VALUE'],
  [{tags:['a b']},array('spaceDelimited'),'AMBIGUOUS_QUERY_VALUE'],
  [{filter:{'x]':'a'}},object('deepObject',true),'UNSUPPORTED_QUERY_ENCODING'],
  [{value:'\ud800'},{},'PARAMS_INVALID'],
  [{tags:Array(1001).fill('a')},array('form'),'REQUEST_TOO_LARGE'],
  [{value:'a'.repeat(65537)},{},'REQUEST_TOO_LARGE']
 ])assert.throws(()=>serializeQuery(query,rules),{code});
 for(const rules of [null,[],{x:{style:'deepObject',explode:false,kind:'object'}},{x:{style:'form',explode:true,kind:'object',url:'https://other.test'}},{x:{style:'pipeDelimited',explode:true,kind:'array'}}])assert.throws(()=>queryRules(rules),{code:'QUERY_CONTRACT_INVALID'});
});

test('formal query shapes remain typed through official MCP and generated entry, with exact server-side wire verification',{timeout:60000},async t=>{
 const dir=temp(t),out=path.join(dir,'out'),specFile=path.join(dir,'api.json'),config=path.join(dir,'config.json');
 const site=await fixture(t,({url})=>{const raw=rawQuery(url);return {type:'application/json',body:JSON.stringify({raw:url.search,csv:raw.tags?.split(',').map(decode),space:raw.words?.split('%20').map(decode),pipe:raw.flags?.split('%7C').map(decode),deep:{x:Number(url.searchParams.get('filter[x]')),label:url.searchParams.get('filter[label]')},plain:{x:Number(url.searchParams.get('x')),label:url.searchParams.get('label')},packed:raw.point?.split(',').map(decode)})};});
 const spec=document(site.origin,{'/query':{get:{parameters:[param('tags',strings,'form',false),param('words',strings,'spaceDelimited',false),param('flags',strings,'pipeDelimited',false),param('filter',point,'deepObject',true),param('plain',point,'form',true),param('point',point,'form',false)]}}});
 writeFileSync(specFile,JSON.stringify(spec));writeFileSync(config,JSON.stringify({artifactRoots:[dir],outputRoot:out,bindings:{api:{allowed_origins:[site.origin]}}}));
 const {client,stderr}=await connect(t,[path.join(root,'src/software-mcp.js'),'--config',config]);
 await completed(client,await call(client,'software_import_openapi',{sourceId:'api',documentPath:specFile}));
 const catalog=await call(client,'software_capabilities',{sourceId:'api'}),cap=catalog.items[0];assert.equal(cap.readiness,'ready',JSON.stringify(cap));assert.equal(cap.evidence.querySerialization.tags.explode,false);assert.equal(cap.evidence.querySerialization.filter.style,'deepObject');
 const params={query:{tags:['a,b','中 文'],words:['one','two'],flags:['a','b'],filter:{x:2,label:'deep+'},plain:{x:3,label:'plain'},point:{x:4,label:'a,b'}}};
 const done=await completed(client,await call(client,'software_call',{sourceId:'api',capabilityId:cap.id,expectedRevision:cap.revision,params}));
 const body=done.result.result.data.response.body.value;assert.deepEqual(body.csv,['a,b','中 文']);assert.deepEqual(body.space,['one','two']);assert.deepEqual(body.pipe,['a','b']);assert.deepEqual(body.deep,{x:2,label:'deep+'});assert.deepEqual(body.plain,{x:3,label:'plain'});assert.deepEqual(body.packed,['x','4','label','a,b']);assert.equal(site.requests.length,1);
 const invalid=structuredClone(params);invalid.query.words=['ambiguous data'];const failed=await completed(client,await call(client,'software_call',{sourceId:'api',capabilityId:cap.id,expectedRevision:cap.revision,params:invalid}),{failed:true});assert.equal(failed.errorCode,'INPUT_INVALID');assert.equal(site.requests.length,1);
 const generated=await completed(client,await call(client,'software_generate',{sourceId:'api',expectedRevision:catalog.source.revision})),independent=await connect(t,[generated.result.entry]);
 const tools=(await independent.client.listTools()).tools,name='cap_'+cap.id.slice(4,24);assert(tools.find(tool=>tool.name===name));
 params.query.filter.x=7;params.query.tags=['new','result'];const fourth=await completed(independent.client,await call(independent.client,name,params),{statusTool:'operation_status'});assert.equal(fourth.result.result.data.response.body.value.deep.x,7);assert.deepEqual(fourth.result.result.data.response.body.value.csv,['new','result']);assert.equal(site.requests.length,2);assert.equal(stderr(),'');
 // The four-tool gateway uses the same serialization and accepts object values.
 const snapshot=JSON.parse(readFileSync(path.join(out,'sources/api/current.json'),'utf8')),gateway=await connect(t,[path.join(root,'gateway/dist/server.js'),'--config',path.join(snapshot.generation,'private/gateway.json')]);
 const listed=await call(gateway.client,'list_endpoints',{source:'api',include_schema:true});assert.equal(listed.data.items[0].operations.GET.query_serialization.filter.style,'deepObject');
 const result=await call(gateway.client,'call_endpoint',{source:'api',endpoint_id:cap.target.endpointId,expected_revision:JSON.parse(readFileSync(path.join(snapshot.generation,'private/recipes.json'),'utf8'))[cap.id].sourceRevision,params});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.data.response.body.value.deep.x,7);assert.equal(site.requests.length,3);
});

test('Swagger collection formats use declared encodings and conflicting formal wire contracts cannot stay ready',async t=>{
 const dir=temp(t),site=await fixture(t,({url})=>({type:'application/json',body:JSON.stringify({query:url.search})})),out=path.join(dir,'out');
 const swagger={swagger:'2.0',info:{title:'Legacy',version:'1'},host:new URL(site.origin).host,schemes:['http'],paths:{'/legacy':{get:{parameters:['csv','ssv','tsv','pipes','multi'].map(format=>({in:'query',name:format,type:'array',items:{type:'string'},required:true,collectionFormat:format}))}}}};
 const file=path.join(dir,'swagger.json');writeFileSync(file,JSON.stringify(swagger));const runtime=createSoftwareRuntime({outputRoot:out,artifactRoots:[dir],bindings:{api:{allowed_origins:[site.origin]}}});
 await runtime.importSpecification({sourceId:'api',documentPath:file});let catalog=runtime.listCapabilities({sourceId:'api'}),cap=catalog.items[0];assert.equal(cap.readiness,'ready');const query=Object.fromEntries(['csv','ssv','tsv','pipes','multi'].map(name=>[name,['a','b']]));const result=await runtime.execute({sourceId:'api',capabilityId:cap.id,expectedRevision:cap.revision,params:{query},outputDir:path.join(dir,'execute')});assert.equal(result.result.ok,true);assert.equal(result.result.data.response.body.value.query,'?csv=a,b&ssv=a%20b&tsv=a%09b&pipes=a%7Cb&multi=a&multi=b');
 const first=path.join(dir,'first.json'),second=path.join(dir,'second.json');writeFileSync(first,JSON.stringify(document(site.origin,{'/conflict':{get:{parameters:[param('tags',strings,'form',false)]}}})));writeFileSync(second,JSON.stringify(document(site.origin,{'/conflict':{get:{parameters:[param('tags',strings,'form',true)]}}})));
 await runtime.importSpecification({sourceId:'api',documentPath:first,merge:true,expectedRevision:catalog.source.revision});catalog=runtime.listCapabilities({sourceId:'api'});await runtime.importSpecification({sourceId:'api',documentPath:second,merge:true,expectedRevision:catalog.source.revision});catalog=runtime.listCapabilities({sourceId:'api'});cap=catalog.items.find(item=>item.target.path==='/conflict');assert.equal(cap.readiness,'candidate');assert(cap.gaps.some(gap=>gap.reason==='QUERY_SERIALIZATION_CONFLICT'));const before=site.requests.length;await assert.rejects(runtime.execute({sourceId:'api',capabilityId:cap.id,expectedRevision:cap.revision,params:{query:{tags:['a']}},outputDir:path.join(dir,'blocked')}),/CAPABILITY_NOT_READY/);assert.equal(site.requests.length,before);
});

test('dynamic shallow query objects keep public key constraints, reject collisions and preserve session guards before HTTP',async t=>{
 const dir=temp(t),site=await fixture(t,({url})=>({type:'application/json',body:JSON.stringify({raw:url.search})})),file=path.join(dir,'api.json');
 const map={type:'object',additionalProperties:{type:'string'},minProperties:1};
 writeFileSync(file,JSON.stringify(document(site.origin,{
  '/deep':{get:{parameters:[param('filter',map,'deepObject',true)]}},
  '/flat':{get:{parameters:[param('filter',map,'form',true),{in:'query',name:'name',schema:{type:'string'}}]}},
  '/session':{get:{parameters:[param('command[0]',{type:'string'})]}},
  '/nested':{get:{parameters:[param('filter',{type:'object',properties:{nested:{type:'object'}},additionalProperties:false},'deepObject',true)]}}
 })));
 const runtime=createSoftwareRuntime({outputRoot:path.join(dir,'out'),artifactRoots:[dir],bindings:{api:{allowed_origins:[site.origin]}}});await runtime.importSpecification({sourceId:'api',documentPath:file});const caps=runtime.listCapabilities({sourceId:'api'}).items,deep=caps.find(cap=>cap.target.path==='/deep'),flat=caps.find(cap=>cap.target.path==='/flat'),session=caps.find(cap=>cap.target.path==='/session');
 assert.equal(deep.readiness,'ready');assert(JSON.stringify(deep.inputSchema).includes('propertyNames'));assert.equal(caps.find(cap=>cap.target.path==='/nested').readiness,'candidate');
 const invoke=(cap,query,id)=>runtime.execute({sourceId:'api',capabilityId:cap.id,expectedRevision:cap.revision,params:{query},outputDir:path.join(dir,id)});
 assert.equal((await invoke(deep,{filter:{dynamic:'new + value'}},'valid')).result.ok,true);assert.equal(site.requests.length,1);
 await assert.rejects(invoke(deep,{filter:{'bad]':'x'}},'bad-key'),/INPUT_INVALID/);
 await assert.rejects(invoke(deep,{filter:{nested:{x:'a'}}},'nested-value'),/INPUT_INVALID/);
 await assert.rejects(invoke(flat,{filter:{name:'a'},name:'b'},'collision'),{code:'QUERY_NAME_COLLISION'});
 await assert.rejects(invoke(flat,{filter:{action:'logout'}},'nested-session'),{code:'SESSION_ACTION_BLOCKED'});
 await assert.rejects(invoke(session,{'command[0]':'logout'},'flat-session'),{code:'SESSION_ACTION_BLOCKED'});
 assert.equal(site.requests.length,1);
});

test('normalized aliases, composed nested shapes and credential object constants cannot advertise a usable public contract',()=>{
 const origin='http://127.0.0.1:44871',imported=paths=>importOpenApi({sourceId:'api',allowedOrigins:[origin],document:document(origin,paths)}),schema={type:'object',properties:{x:{type:'string'}},additionalProperties:false};
 const aliases=imported({'/r':{get:{servers:[{url:origin+'/base'}],parameters:[param('filter',schema,'form',true)]}},'/base/r':{get:{parameters:[param('filter',schema,'form',false)]}}});assert.equal(aliases.manifest.length,1);assert.equal(aliases.manifest[0].readiness,'candidate');assert(aliases.gaps.some(gap=>gap.reason==='conflicting_operation_contract'));
 const media=imported({'/r':{post:{servers:[{url:origin+'/base'}],requestBody:{content:{'application/json':{schema:{type:'string'}}}}}},'/base/r':{post:{requestBody:{content:{'text/plain':{schema:{type:'string'}}}}}}});assert.equal(media.manifest[0].readiness,'candidate');
 const nested={allOf:[{type:'object',properties:{x:{type:'string'}}},{type:'object',properties:{nested:{type:'object',properties:{y:{type:'string'}}}},required:['nested']}]};const value=imported({'/nested':{get:{parameters:[param('filter',nested,'deepObject',true)]}}});assert.equal(value.manifest[0].readiness,'candidate');assert(value.gaps.some(gap=>gap.reason==='unsupported_query_shape'));
 const refs=document(origin,{'/nested':{get:{parameters:[param('filter',{$ref:'#/$defs/Base',properties:{nested:{type:'object'}},required:['nested']},'deepObject',true)]}}});refs.$defs={Base:{type:'object',properties:{x:{type:'string'}}}};assert.equal(importOpenApi({sourceId:'api',allowedOrigins:[origin],document:refs}).manifest[0].readiness,'candidate');
 const safe=imported({'/ordered':{get:{parameters:[param('filter',{allOf:[{maxProperties:3},schema]},'deepObject',true)]}}});assert.equal(safe.manifest[0].readiness,'ready','allOf constraint ordering does not discard a supported shape');
 const tuple=imported({'/tuple':{get:{parameters:[param('tags',{type:'array',prefixItems:[{type:'object',properties:{x:{type:'string'}},required:['x'],additionalProperties:false}],items:{type:'string'},minItems:1})]}}});assert.equal(tuple.manifest[0].readiness,'candidate');
 const dependent=imported({'/dependent':{get:{parameters:[param('filter',{type:'object',properties:{x:{type:'string'}},dependentSchemas:{x:{properties:{nested:{type:'object'}},required:['nested']}}},'deepObject',true)]}}});assert.equal(dependent.manifest[0].readiness,'candidate');
 const canary='canary-public-query-credential-927';for(const constant of [{enum:[{accessToken:canary}]},{const:{nested:{clientSecret:canary}}}]){const result=imported({'/credentials':{get:{parameters:[param('filter',{type:'object',...constant},'form',true)]}}});assert.equal(result.manifest[0].readiness,'candidate');assert(result.gaps.some(gap=>gap.reason==='credential_input_requires_binding'));assert(!JSON.stringify(result).includes(canary));}
});

test('credential-named encoding declarations remain typed metadata while actual values stay redacted',{timeout:30000},async t=>{
 const dir=temp(t),site=await fixture(t,()=>({type:'application/json',body:'{}'})),spec=path.join(dir,'api.json'),out=path.join(dir,'out');writeFileSync(spec,JSON.stringify(document(site.origin,{'/candidate':{get:{parameters:[param('token',{type:'string'})]}}})));
 const runtime=createSoftwareRuntime({outputRoot:out,artifactRoots:[dir],bindings:{api:{allowed_origins:[site.origin]}}});await runtime.importSpecification({sourceId:'api',documentPath:spec});const catalog=runtime.listCapabilities({sourceId:'api'}),cap=catalog.items[0];assert.equal(cap.readiness,'candidate');assert.equal(typeof cap.evidence.querySerialization.token,'object');assert.equal(cap.evidence.querySerialization.token.style,'form');
 const current=JSON.parse(readFileSync(path.join(out,'sources/api/current.json'),'utf8')),gateway=await connect(t,[path.join(root,'gateway/dist/server.js'),'--config',path.join(current.generation,'private/gateway.json')]);const listed=await call(gateway.client,'list_endpoints',{source:'api',include_schema:true});assert.equal(listed.ok,true,JSON.stringify(listed));assert.equal(listed.data.items[0].operations.GET.query_serialization.token.style,'form');assert.equal(site.requests.length,0);
 const redactor=new Redactor(),canary='camel-credential-canary-772';const publicValue=redactor.catalogValue({accessToken:canary,clientSecret:canary,query_serialization:{token:{style:'form',explode:true,kind:'scalar'}}});assert(!JSON.stringify(publicValue).includes(canary));assert.equal(publicValue.query_serialization.token.style,'form');
 const malicious=redactor.catalogValue({query_serialization:{token:canary},querySerialization:{accessToken:canary}});assert(!JSON.stringify(malicious).includes(canary),'invalid metadata cannot bypass value redaction');
});
