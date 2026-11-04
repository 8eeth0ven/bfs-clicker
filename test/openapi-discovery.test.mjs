import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {importOpenApi} from '../src/openapi-discovery.js';
import {loadManifest,endpointId} from '../gateway/dist/manifest.js';
import {Executor} from '../gateway/dist/executor.js';
import {CredentialProvider} from '../gateway/dist/credentials.js';
import {temp,fixture} from './helpers.mjs';

const gatewayRequire=createRequire(new URL('../gateway/package.json',import.meta.url));
const Ajv=gatewayRequire('ajv/dist/2020.js').default;
const origin='http://127.0.0.1:44221';
const spec=(extra={})=>({openapi:'3.0.3',info:{title:'本机规范',version:'1'},servers:[{url:origin+'/v1'}],paths:{},...extra});
const load=doc=>importOpenApi({document:doc,documentUrl:origin+'/openapi.json',sourceId:'local',allowedOrigins:[origin]});
const contract=(result,route,method='GET')=>result.schemaOverrides[endpointId('local',origin,route)+':'+method];
const validate=schema=>new Ajv({strict:false,validateFormats:false}).compile(schema);

test('OpenAPI3.0 preserves formal required/ranges/enums and expands local schemas without copying defaults or examples',()=>{
  const result=load(spec({components:{parameters:{id:{in:'path',name:'id',required:true,schema:{type:'integer',minimum:1}}},schemas:{Body:{type:'object',required:['name','responseOnly'],properties:{name:{type:'string',minLength:2,enum:['aa','bb'],default:'aa',example:'sample'},note:{type:'string',nullable:true},responseOnly:{type:'string',readOnly:true}},additionalProperties:false}}},paths:{'/items/{id}':{parameters:[{$ref:'#/components/parameters/id'},{name:'page',in:'query',required:true,schema:{type:'integer',minimum:0}}],post:{parameters:[{name:'page',in:'query',required:true,schema:{type:'integer',minimum:2,maximum:9}}],requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/Body'}}}}}}}}));
  assert.equal(result.manifest.length,1);assert.equal(result.manifest[0].method,'POST');assert.equal(result.manifest[0].readiness,'ready');assert.deepEqual(result.manifest[0].categories,['static_candidate','openapi']);assert.equal(result.manifest[0].effect,'unknown');
  const schema=contract(result,'/v1/items/{id}','POST'),valid=validate(schema);
  assert.deepEqual(new Set(schema.required),new Set(['path','query','body']));assert.equal(schema.properties.query.properties.page.minimum,2);
  assert(valid({path:{id:1},query:{page:3},body:{name:'aa',note:null}}));
  for(const params of [{path:{id:1},body:{name:'aa'}},{path:{id:0},query:{page:3},body:{name:'aa'}},{path:{id:1},query:{page:3},body:{name:'bad'}},{path:{id:1},query:{page:3},body:{name:'aa',responseOnly:'x'}}])assert.equal(valid(params),false,JSON.stringify(params));
  assert(!JSON.stringify(result).includes('sample'));assert(!JSON.stringify(result).includes('"default"'));assert(!JSON.stringify(result).includes('"example"'));
});

test('OpenAPI3.1 supports boolean schemas, local $defs, ref siblings and compositions',()=>{
  const result=load(spec({openapi:'3.1.1',$defs:{'a/b':{type:'string',minLength:2}},paths:{'/check':{post:{requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['x'],properties:{x:{$ref:'#/$defs/a~1b',maxLength:4},unused:false},additionalProperties:false}}}}}}}}));
  const schema=contract(result,'/v1/check','POST'),valid=validate(schema);
  assert.equal(result.manifest[0].readiness,'ready');assert(valid({body:{x:'abc'}}));assert(!valid({body:{x:'a'}}));assert(!valid({body:{x:'abcde'}}));assert(!valid({body:{x:'abc',unused:1}}));
});

test('OpenAPI3.1 scalar/array query ref siblings retain both wire encoding and full validation',()=>{
  const result=load(spec({openapi:'3.1.1',components:{schemas:{Page:{type:'integer',minimum:1},Tags:{type:'array',items:{type:'string'}}}},paths:{'/q':{get:{parameters:[{in:'query',name:'page',required:true,schema:{$ref:'#/components/schemas/Page',maximum:3}},{in:'query',name:'tag',schema:{$ref:'#/components/schemas/Tags',maxItems:2}}]}}}}));
  assert.equal(result.manifest[0].readiness,'ready');const valid=validate(contract(result,'/v1/q'));
  assert(valid({query:{page:2,tag:['a','b']}}));assert(!valid({query:{page:4}}));assert(!valid({query:{page:2,tag:['a','b','c']}}));
});

test('Swagger2 YAML preserves host/basePath/method, parameter refs and repeated query serialization',()=>{
  const yaml=`swagger: '2.0'\ninfo: {title: demo, version: '1'}\nhost: 127.0.0.1:44221\nbasePath: /legacy\nschemes: [http]\nparameters:\n  Id: {in: path, name: id, required: true, type: integer, minimum: 1}\npaths:\n  /pets/{id}:\n    get:\n      parameters:\n        - {$ref: '#/parameters/Id'}\n        - {in: query, name: tag, required: true, type: array, collectionFormat: multi, items: {type: string, enum: [a, b]}}\n`;
  const result=load(yaml),schema=contract(result,'/legacy/pets/{id}');
  assert.equal(result.manifest[0].url,origin+'/legacy/pets/{id}');assert.equal(result.manifest[0].readiness,'ready');assert(validate(schema)({path:{id:2},query:{tag:['a','b']}}));assert(!validate(schema)({path:{id:2},query:{tag:['wrong']}}));
});

test('relative/path/operation servers and declared variable defaults do not widen allowed origins',()=>{
  const result=load(spec({servers:[{url:'https://outside.invalid'}],paths:{'/items':{servers:[{url:'/api'}],get:{},post:{servers:[{url:origin+'/{version}',variables:{version:{default:'v2'}}}]}}}}));
  assert.deepEqual(result.origins,[origin]);assert.deepEqual(result.manifest.map(row=>row.url),[origin+'/api/items',origin+'/v2/items']);
  const denied=load(spec({servers:[{url:'https://outside.invalid'}],paths:{'/secret':{get:{}}}}));
  assert.equal(denied.manifest[0].readiness,'candidate');assert.equal(denied.manifest[0].method,'GET');assert.deepEqual(denied.origins,[]);assert(denied.gaps.some(gap=>gap.reason==='origin_not_allowed'));
  const schema=Object.values(denied.schemaOverrides)[0];assert(!validate(schema)({}));
});

test('external refs, cycles and dynamic refs are explicit gaps and cannot turn into permissive callable schemas',()=>{
  const previous=globalThis.fetch;let requested=0;globalThis.fetch=()=>{requested++;throw Error('network forbidden')};
  try{
    for(const body of [{$ref:'https://outside.invalid/schema.json'},{$ref:'#/components/schemas/Cycle'},{$dynamicRef:'#Node'}]){
      const result=load(spec({openapi:'3.1.1',components:{schemas:{Cycle:{$ref:'#/components/schemas/Cycle'}}},paths:{'/blocked':{post:{requestBody:{content:{'application/json':{schema:body}}}}}}}));
      assert.equal(result.manifest[0].readiness,'candidate');assert(result.gaps.length);assert(!validate(contract(result,'/v1/blocked','POST'))({body:{}}));
    }
    assert.equal(requested,0);
  }finally{globalThis.fetch=previous;}
});

test('unsupported wire encodings and undeclared path variables remain candidates',()=>{
  for(const parameters of [[{in:'query',name:'tag',schema:{type:'array',items:{type:'string'}},style:'spaceDelimited',explode:true}],[{in:'query',name:'filter',style:'deepObject',schema:{type:'object'}}],[{in:'header',name:'X-Required',required:true,schema:{type:'string'}}]]){
    const result=load(spec({paths:{'/p':{get:{parameters}}}}));assert.equal(result.manifest[0].readiness,'candidate');assert(!validate(contract(result,'/v1/p'))({}));
  }
  const missing=load(spec({paths:{'/p/{id}':{get:{}}}}));assert(missing.gaps.some(gap=>gap.reason==='missing_path_parameter_declaration'));assert.equal(missing.manifest[0].readiness,'candidate');
});

test('limits, malformed documents, YAML aliases and credential defaults are bounded or omitted',()=>{
  const limited=importOpenApi({document:spec({paths:{'/a':{get:{}},'/b':{get:{}}}}),sourceId:'local',allowedOrigins:[origin],maxOperations:1});assert.equal(limited.manifest.length,1);assert(limited.gaps.some(gap=>gap.reason==='operation_limit'));
  for(const document of ['not: [valid',{}, {openapi:'9.0',paths:{}},'x: &x\n  again: *x'])assert.throws(()=>load(document));
  const cycle={};cycle.loop=cycle;assert.throws(()=>load(cycle),{code:'DOCUMENT_CYCLE'});
  const secret=load(spec({paths:{'/x':{get:{parameters:[{in:'query',name:'token',required:true,schema:{type:'string',default:'credential-value',example:'sample-value',enum:['literal-secret']}}]}}}}));
  const serialized=JSON.stringify(secret);for(const value of ['credential-value','sample-value','literal-secret'])assert(!serialized.includes(value));assert.equal(secret.manifest[0].readiness,'candidate');
});

test('declared bodies on GET, boolean paths, duplicate parameters and unsupported upload types cannot be ready',()=>{
  const documents=[
    spec({paths:{'/p':{get:{requestBody:{content:{'application/json':{schema:{type:'object'}}}}}}}}),
    spec({paths:{'/p/{id}':{get:{parameters:[{in:'path',name:'id',required:true,schema:{anyOf:[{type:'boolean'}]}}]}}}}),
    spec({paths:{'/p':{get:{parameters:[{in:'query',name:'q',schema:{type:'string'}},{in:'query',name:'q',schema:{type:'integer'}}]}}}}),
    {swagger:'2.0',host:'127.0.0.1:44221',schemes:['http'],consumes:['multipart/form-data'],paths:{'/p':{post:{parameters:[{in:'formData',name:'file',type:'file',required:true}]}}}}
  ];
  for(const document of documents){const result=load(document);assert.equal(result.manifest[0].readiness,'candidate',JSON.stringify(result));assert.doesNotThrow(()=>validate(Object.values(result.schemaOverrides)[0]));assert(!validate(Object.values(result.schemaOverrides)[0])({}));}
});

test('JSON pointer escaping, required readOnly refs, credentials under ref siblings and prototype names stay safe',()=>{
  const body={type:'object',required:['ro'],properties:{ro:{$ref:'#/components/schemas/ReadOnly',description:'server-only'},token:{$ref:'#/components/schemas/Secret',maxLength:100}}};
  const result=load(spec({openapi:'3.1.1',components:{schemas:{ReadOnly:{type:'string',readOnly:true},Secret:{type:'string',const:'hidden-secret'}}},paths:{'/p':{post:{requestBody:{content:{'application/json':{schema:body}}}}}}}));
  assert.equal(result.manifest[0].readiness,'candidate');assert(!JSON.stringify(result).includes('hidden-secret'));
  assert.deepEqual(contract(result,'/v1/p','POST').properties.body.required,[]);
  const evil=JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}');
  const input=spec({paths:{'/p':{post:{requestBody:{content:{'application/json':{schema:evil}}}}}}});
  const blocked=load(input);assert.equal(blocked.manifest[0].readiness,'candidate');assert.equal({}.polluted,undefined);
});

test('real localhost JSON specification normalizes through gateway validation and invokes declared GET/POST contracts',async t=>{
  const dir=temp(t);let specification;
  const site=await fixture(t,async({url,method},req)=>{
    if(url.pathname==='/openapi.json')return {type:'application/json',body:JSON.stringify(specification)};
    let body='';for await(const chunk of req)body+=chunk;
    return {type:'application/json',body:JSON.stringify({method,path:url.pathname,tags:url.searchParams.getAll('tag'),body:body?JSON.parse(body):null})};
  });
  specification={openapi:'3.1.1',info:{title:'真实本机规范',version:'1'},servers:[{url:site.origin+'/api'}],components:{schemas:{Input:{type:'object',required:['name'],properties:{name:{type:'string',enum:['allowed']},count:{type:'integer',minimum:1,maximum:3}},additionalProperties:false}}},paths:{'/items/{id}':{parameters:[{in:'path',name:'id',required:true,schema:{type:'integer',minimum:1}}],get:{parameters:[{in:'query',name:'tag',required:true,schema:{type:'array',items:{type:'string',enum:['a','b']}}}]},post:{requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/Input'}}}}}}}};
  const fetched=await(await fetch(site.origin+'/openapi.json')).text(),imported=importOpenApi({document:fetched,documentUrl:site.origin+'/openapi.json',sourceId:'local',allowedOrigins:[site.origin]});
  assert.equal(imported.manifest.length,2);assert(imported.manifest.every(row=>row.readiness==='ready'));
  const inventory=path.join(dir,'inventory.json');writeFileSync(inventory,JSON.stringify(imported.manifest));
  const epId=endpointId('local',site.origin,'/api/items/{id}');
  const cfg={config_dir:dir,manifest_roots:[dir],state_dir:dir,sources:[],timeout_ms:2000,max_body_bytes:32768,max_catalog_bytes:131072,success_threshold:3,missing_threshold:3,methods:{allow_non_get:true,allow:[{source:'local',endpoint_id:epId,method:'POST'}]}};
  const source=await loadManifest({id:'local',manifest:inventory,public:true,allowed_origins:imported.origins,schema_overrides:imported.schemaOverrides},cfg),endpoint=source.endpoints[0],executor=new Executor(cfg,new CredentialProvider());
  const got=await executor.execute(source,endpoint,endpoint.operations.GET,{path:{id:2},query:{tag:['a','b']}});assert.equal(got.ok,true);assert.deepEqual(got.data.response.body.value.tags,['a','b']);assert.equal(got.data.response.body.value.path,'/api/items/2');
  const posted=await executor.execute(source,endpoint,endpoint.operations.POST,{path:{id:3},body:{name:'allowed',count:2}});assert.equal(posted.ok,true);assert.deepEqual(JSON.parse(JSON.stringify(posted.data.response.body.value.body)),{name:'allowed',count:2});
  const before=site.requests.length;
  await assert.rejects(executor.execute(source,endpoint,endpoint.operations.POST,{path:{id:3},body:{name:'wrong'}}),{code:'PARAMS_INVALID'});
  await assert.rejects(executor.execute(source,endpoint,endpoint.operations.GET,{path:{id:2},query:{tag:['c']}}),{code:'PARAMS_INVALID'});
  assert.equal(site.requests.length,before);assert(endpoint.operations.GET.provenance.includes('static_candidate'));assert(!endpoint.operations.GET.provenance.includes('observed'));
});

test('real localhost Swagger2 YAML import produces a callable path/query contract without browser exploration',async t=>{
  const dir=temp(t);let yaml;
  const site=await fixture(t,({url})=>url.pathname==='/swagger.yaml'?{type:'application/yaml',body:yaml}:{type:'application/json',body:JSON.stringify({path:url.pathname,tags:url.searchParams.getAll('tag')})});
  yaml=`swagger: '2.0'\ninfo: {title: local, version: '1'}\nhost: ${new URL(site.origin).host}\nschemes: [http]\nbasePath: /legacy\npaths:\n  /pets/{id}:\n    get:\n      parameters:\n        - {in: path, name: id, required: true, type: integer, minimum: 1}\n        - {in: query, name: tag, required: true, type: array, collectionFormat: multi, items: {type: string, enum: [a, b]}}\n`;
  const text=await(await fetch(site.origin+'/swagger.yaml')).text(),result=importOpenApi({document:text,documentUrl:site.origin+'/swagger.yaml',sourceId:'local',allowedOrigins:[site.origin]}),file=path.join(dir,'swagger-inventory.json');writeFileSync(file,JSON.stringify(result.manifest));
  const cfg={config_dir:dir,manifest_roots:[dir],state_dir:dir,sources:[],timeout_ms:2000,max_body_bytes:32768,max_catalog_bytes:131072,success_threshold:3,missing_threshold:3,methods:{allow_non_get:false,allow:[]}},source=await loadManifest({id:'local',manifest:file,public:true,allowed_origins:result.origins,schema_overrides:result.schemaOverrides},cfg),endpoint=source.endpoints[0],executor=new Executor(cfg,new CredentialProvider());
  const called=await executor.execute(source,endpoint,endpoint.operations.GET,{path:{id:4},query:{tag:['b','a']}});assert.equal(called.ok,true);assert.equal(called.data.response.body.value.path,'/legacy/pets/4');assert.deepEqual(called.data.response.body.value.tags,['b','a']);
  await assert.rejects(executor.execute(source,endpoint,endpoint.operations.GET,{path:{id:4}}),{code:'PARAMS_INVALID'});
});
