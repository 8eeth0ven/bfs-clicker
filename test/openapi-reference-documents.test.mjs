import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs,{writeFileSync,mkdirSync,symlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {importOpenApi} from '../src/openapi-discovery.js';
import {createSoftwareRuntime} from '../src/software-runtime.js';
import {temp} from './helpers.mjs';

const require=createRequire(new URL('../gateway/package.json',import.meta.url));
const Ajv=require('ajv/dist/2020.js').default;
const origin='https://api.example.invalid';
const documentUrl='https://spec.example.invalid/spec/root.json';
const document=(schema,extra={})=>({openapi:'3.1.1',servers:[{url:origin}],paths:{'/check':{post:{requestBody:{required:true,content:{'application/json':{schema}}}}}},...extra});
const load=(doc,references=[],extra={})=>importOpenApi({sourceId:'refs',document:doc,documentUrl,referenceDocuments:references,allowedOrigins:[origin],...extra});
const reference=(url,value)=>({documentUrl:new URL(url,documentUrl).href,document:value});
const schema=result=>Object.values(result.schemaOverrides)[0];
const valid=result=>new Ajv({strict:false,validateFormats:false}).compile(schema(result));
function ready(result){assert.equal(result.manifest.length,1);assert.equal(result.manifest[0].readiness,'ready',JSON.stringify(result.gaps));assert.deepEqual(result.gaps,[]);}
function blocked(result,reason){assert(result.gaps.some(item=>item.reason===reason),JSON.stringify(result.gaps));assert(result.manifest.every(item=>item.readiness==='candidate'));for(const contract of Object.values(result.schemaOverrides))assert.equal(new Ajv({strict:false,validateFormats:false}).compile(contract)({body:'anything'}),false);}

// Every resolution test supplies bytes explicitly. Installing a URL identity
// must never implicitly authorize fetching that URL.
test('reference bundle resolves JSON and YAML relative/local refs with complete validation and zero fetch',()=>{
 const previous=globalThis.fetch;let fetched=0;globalThis.fetch=()=>{fetched++;throw Error('unexpected network')};
 try{
  const refs=[reference('models/body.yaml',"$defs:\n  Input:\n    type: object\n    required: [name, count]\n    additionalProperties: false\n    properties:\n      name: {$ref: '#/$defs/Name'}\n      count: {$ref: '../types.json#/Count'}\n  Name: {type: string, enum: [alpha, beta]}\n"),reference('types.json',JSON.stringify({Count:{type:'integer',minimum:1,maximum:3}}))];
  const result=load(document({$ref:'models/body.yaml#/$defs/Input'}),refs);ready(result);const accepts=valid(result);
  assert(accepts({body:{name:'alpha',count:2}}));
  for(const body of [{name:'gamma',count:2},{name:'alpha',count:0},{name:'alpha'},{name:'alpha',count:2,extra:true}])assert.equal(accepts({body}),false);
  assert.equal(fetched,0);
 }finally{globalThis.fetch=previous;}
});

test('same pointer in different documents is distinct; local refs retain their owning resource',()=>{
 const refs=[reference('a.json',{$defs:{Thing:{$ref:'b.json#/$defs/Thing'}}}),reference('b.json',{$defs:{Thing:{$ref:'#/$defs/Terminal'},Terminal:{type:'string',const:'leaf'}}})];
 const result=load(document({$ref:'a.json#/$defs/Thing'}),refs);ready(result);assert(valid(result)({body:'leaf'}));assert.equal(valid(result)({body:'wrong'}),false);
});

test('cross-document cycle and a return to root are bounded explicit gaps',()=>{
 for(const refs of [
  [reference('a.json',{$defs:{Thing:{$ref:'b.json#/$defs/Thing'}}}),reference('b.json',{$defs:{Thing:{$ref:'a.json#/$defs/Thing'}}})],
  [reference('a.json',{$defs:{Thing:{$ref:'root.json#/$defs/Start'}}})]
 ]){
  const result=load(document({$ref:'a.json#/$defs/Thing'},{$defs:{Start:{$ref:'a.json#/$defs/Thing'}}}),refs);blocked(result,'cyclic_or_deep_ref');
 }
});

test('pathItem, parameter, requestBody and schema chains preserve document-relative resolution',()=>{
 const main={openapi:'3.1.1',servers:[{url:origin}],paths:{'/items/{id}':{$ref:'routes/item.yaml'}}};
 const refs=[
  reference('routes/item.yaml',"parameters:\n  - {$ref: '../parts/parameters.json#/Id'}\npost:\n  requestBody: {$ref: '../parts/body.json#/Body'}\n"),
  reference('parts/parameters.json',{Id:{$ref:'#/Actual'},Actual:{in:'path',name:'id',required:true,schema:{$ref:'types.json#/Identifier'}}}),
  reference('parts/body.json',{Body:{$ref:'#/Actual'},Actual:{required:true,content:{'application/json':{schema:{$ref:'types.json#/Input'}}}}}),
  reference('parts/types.json',{Identifier:{type:'integer',minimum:1},Input:{type:'object',properties:{q:{type:'string',enum:['a','b']}},required:['q'],additionalProperties:false}})
 ];
 const result=load(main,refs);ready(result);const accepts=valid(result);
 assert(accepts({path:{id:1},body:{q:'a'}}));assert.equal(accepts({path:{id:0},body:{q:'a'}}),false);assert.equal(accepts({path:{id:1},body:{q:'c'}}),false);
});

test('relative path-item and operation servers use their containing reference document URL',()=>{
 for(const operationServer of [false,true]){
  const main={openapi:'3.1.1',servers:[{url:origin}],paths:{'/check':{$ref:'routes/item.json'}}};
  const route=operationServer?{get:{servers:[{url:'../v2'}]}}:{servers:[{url:'../v2'}],get:{}};
  const result=load(main,[reference('routes/item.json',route)],{allowedOrigins:['https://spec.example.invalid']});
  ready(result);assert.equal(result.manifest[0].url,'https://spec.example.invalid/spec/v2/check');
 }
});

test('an external schema can refer back to the supplied root and escaped pointers remain exact',()=>{
 const root=document({$ref:'a.json#/$defs/A~1B~0C'},{$defs:{RootType:{type:'integer',minimum:2}}});
 const result=load(root,[reference('a.json',{$defs:{'A/B~C':{type:'object',properties:{'a/b':{$ref:'root.json#/$defs/RootType'}},required:['a/b'],additionalProperties:false}}})]);
 ready(result);assert(valid(result)({body:{'a/b':2}}));assert.equal(valid(result)({body:{'a/b':1}}),false);
});

test('external boolean schemas preserve JSON Schema semantics without null-sentinel ambiguity',()=>{
 for(const bool of [true,false]){
  const result=load(document({$ref:'bool.json'}),[reference('bool.json',bool)]);ready(result);assert.equal(valid(result)({body:{any:'value'}}),bool);
 }
 const old=load(document({$ref:'bool.json'},{openapi:'3.0.3'}),[reference('bool.json',true)]);blocked(old,'boolean_schema_requires_openapi31');
});

test('unmapped refs, malformed pointers and unsupported anchors stay blocked with zero network',()=>{
 const previous=globalThis.fetch;let fetched=0;globalThis.fetch=()=>{fetched++;throw Error('unexpected network')};
 try{
  const refs=[reference('types.json',{$defs:{Value:{type:'string'}}})];
  for(const [ref,reason]of [
   ['missing.json#/$defs/Value','external_ref_not_loaded'],['types.json#/$defs/Missing','local_ref_missing'],
   ['types.json#/$defs/bad~2key','invalid_local_ref'],['types.json#/%GG','invalid_local_ref'],
   ['types.json#Value','unsupported_local_anchor'],['types.json#/__proto__','local_ref_missing'],
   ['file:///etc/passwd','external_ref_not_loaded'],['https://user:pass@spec.example.invalid/spec/types.json','external_ref_not_loaded']
  ])blocked(load(document({$ref:ref}),refs),reason);
  assert.equal(fetched,0);
 }finally{globalThis.fetch=previous;}
});

test('reference document URL identities reject duplicates, credentials, fragments and unsupported schemes',()=>{
 for(const url of [documentUrl,'https://spec.example.invalid:443/spec/root.json'])assert.throws(()=>load(document({type:'string'}),[{documentUrl:url,document:{}}]),{code:'DUPLICATE_DOCUMENT_URL'});
 assert.throws(()=>load(document({type:'string'}),[reference('types.json',{}),reference('./types.json',{})]),{code:'DUPLICATE_DOCUMENT_URL'});
 for(const url of ['https://user:pass@spec.example.invalid/types.json','https://spec.example.invalid/types.json#','https://spec.example.invalid/types.json#/Value','file:///tmp/types.json','types.json','https://spec.example.invalid/a\\b','https://spec.example.invalid/with space'])assert.throws(()=>load(document({type:'string'}),[{documentUrl:url,document:{}}]),{code:'INVALID_REFERENCE_DOCUMENT_URL'});
});

test('reference count and per-document/aggregate byte budgets apply before expansion',()=>{
 assert.throws(()=>load(document({type:'string'}),Array.from({length:33},(_,i)=>reference(`part-${i}.json`,{}))),{code:'REFERENCE_DOCUMENT_LIMIT'});
 assert.throws(()=>load(document({type:'string'}),[reference('large.json',{description:'x'.repeat(8*1024*1024)})]),{code:'DOCUMENT_LIMIT'});
 const large=JSON.stringify({description:'x'.repeat(6*1024*1024)});
 assert.throws(()=>load(document({type:'string'}),Array.from({length:3},(_,i)=>reference(`part-${i}.json`,large))),{code:'DOCUMENT_LIMIT'});
});

test('ref siblings retain the original resource for nested relative refs',()=>{
 const result=load(document({$ref:'body.json#/Input'}),[
  reference('body.json',{Input:{$ref:'types/base.json',properties:{name:{$ref:'types/name.json'}},required:['name']}}),
  reference('types/base.json',{type:'object'}),reference('types/name.json',{type:'string',enum:['nested']})
 ]);ready(result);assert(valid(result)({body:{name:'nested'}}));assert.equal(valid(result)({body:{name:'wrong'}}),false);
});

test('a pointer cannot bypass an unsupported ancestor $id and resolve refs against the wrong base',()=>{
 for(const nested of [false,true]){
  const scoped={$id:'https://different.example.invalid/scope/',$defs:{Input:{$ref:'./type.json'}}};
  const target=nested?'#/$defs/Scope/$defs/Input':'#/$defs/Input';
  const result=load(document({$ref:'a.json'+target}),[
   reference('a.json',nested?{$defs:{Scope:scoped}}:scoped),
   reference('type.json',{type:'string',enum:['retrieval-base']}),
   {documentUrl:'https://different.example.invalid/scope/type.json',document:{type:'string',enum:['id-base']}}
  ]);
  blocked(result,'unsupported_schema_resource_or_dynamic_ref');
 }
});

test('reimported actual reference contract changes source and capability revisions while old revision rejects',async t=>{
 const dir=temp(t),main=path.join(dir,'root.json'),type=path.join(dir,'type.yaml');
 writeFileSync(main,JSON.stringify(document({$ref:'type.yaml'})));
 writeFileSync(type,'type: string\nenum: [first]\n');
 const runtime=createSoftwareRuntime({outputRoot:path.join(dir,'out'),artifactRoots:[dir],bindings:{refs:{allowed_origins:[origin]}}});
 const args={sourceId:'refs',documentPath:main,documentUrl,referenceDocuments:[{documentUrl:new URL('type.yaml',documentUrl).href,documentPath:type}]};
 await runtime.importSpecification(args);const first=runtime.listCapabilities({sourceId:'refs'}),cap=first.items[0];
 assert.deepEqual(cap.inputSchema.properties.body.enum,['first']);
 writeFileSync(type,'type: string\nenum: [second]\n');
 await runtime.importSpecification({...args,expectedRevision:first.source.revision});const second=runtime.listCapabilities({sourceId:'refs'});
 assert.notEqual(second.source.revision,first.source.revision);assert.notEqual(second.items[0].revision,cap.revision);assert.deepEqual(second.items[0].inputSchema.properties.body.enum,['second']);
 await assert.rejects(runtime.importSpecification({...args,expectedRevision:first.source.revision}),/SOURCE_CHANGED/);
});

test('reference URI query strings are exact identities and an unprovided version is never substituted',()=>{
 const resource={Value:{type:'string',enum:['version-two']}};
 blocked(load(document({$ref:'types.json?version=2#/Value'}),[reference('types.json?version=1',resource)]),'external_ref_not_loaded');
 const exact=load(document({$ref:'types.json?version=2#/Value'}),[reference('types.json?version=2',resource)]);
 ready(exact);assert(valid(exact)({body:'version-two'}));
});

test('rejected refs never publish userinfo or relative query secrets in gap diagnostics',()=>{
 for(const ref of ['https://audituser:prefix!suffix@spec.example.invalid/type.json','//audituser:prefix!suffix@spec.example.invalid/type.json']){
  const result=load(document({$ref:ref}));blocked(result,'external_ref_not_loaded');
  const publicText=JSON.stringify(result);assert.equal(publicText.includes('audituser'),false);assert.equal(publicText.includes('prefix'),false);assert.equal(publicText.includes('suffix'),false);
  assert.equal(result.gaps[0].reference,undefined);assert.match(result.gaps[0].referenceDigest,/^[a-f0-9]{64}$/);
 }
 const relative=load(document({$ref:'missing.json?accessCode=ref-diagnostic-private-marker'}));blocked(relative,'external_ref_not_loaded');assert.equal(JSON.stringify(relative).includes('ref-diagnostic-private-marker'),false);
});


async function existingReferenceSource(t){
 const dir=temp(t),main=path.join(dir,'root.json'),type=path.join(dir,'type.json');
 writeFileSync(main,JSON.stringify(document({$ref:'type.json'})));writeFileSync(type,JSON.stringify({type:'string',enum:['existing']}));
 const runtime=createSoftwareRuntime({outputRoot:path.join(dir,'out'),artifactRoots:[dir],bindings:{refs:{allowed_origins:[origin]}}});
 const args={sourceId:'refs',documentPath:main,documentUrl,referenceDocuments:[{documentUrl:new URL('type.json',documentUrl).href,documentPath:type}]};
 await runtime.importSpecification(args);return {dir,type,runtime,args,before:runtime.listCapabilities({sourceId:'refs'})};
}

test('runtime rejects reference directories and roots escapes without advancing current revision',async t=>{
 const {dir,runtime,args,before}=await existingReferenceSource(t),outside=temp(t),outsideFile=path.join(outside,'type.json'),directory=path.join(dir,'directory'),link=path.join(dir,'outside-link.json');
 writeFileSync(outsideFile,JSON.stringify({type:'string',enum:['outside']}));mkdirSync(directory);symlinkSync(outsideFile,link);
 for(const [documentPath,error]of [[directory,/DOCUMENT_LIMIT/],[outsideFile,/artifactRoots/],[link,/artifactRoots/]]){
  await assert.rejects(runtime.importSpecification({...args,expectedRevision:before.source.revision,referenceDocuments:[{documentUrl:args.referenceDocuments[0].documentUrl,documentPath}]}),error);
  const after=runtime.listCapabilities({sourceId:'refs'});assert.equal(after.source.revision,before.source.revision);assert.equal(after.items[0].revision,before.items[0].revision);assert.deepEqual(after.items[0].inputSchema.properties.body.enum,['existing']);
 }
});

test('runtime rejects a FIFO before reading it and preserves the existing revision',{skip:process.platform==='win32'},async t=>{
 const {dir,runtime,args,before}=await existingReferenceSource(t),fifo=path.join(dir,'reference.fifo');
 execFileSync('mkfifo',[fifo],{timeout:3000});assert(fs.statSync(fifo).isFIFO());
 // Guard the FIFO read in this test so a regression fails immediately rather
 // than blocking on a pipe. Sync the built-in ESM binding used by the runtime.
 const original=fs.readFileSync;let fifoReads=0;
 fs.readFileSync=function(file,...options){if(String(file)===fifo){fifoReads++;throw Error('FIFO_READ_FORBIDDEN')}return original.call(this,file,...options)};syncBuiltinESMExports();
 try{
  await assert.rejects(runtime.importSpecification({...args,expectedRevision:before.source.revision,referenceDocuments:[{documentUrl:args.referenceDocuments[0].documentUrl,documentPath:fifo}]}),/DOCUMENT_LIMIT/);
 }finally{fs.readFileSync=original;syncBuiltinESMExports();}
 assert.equal(fifoReads,0);const after=runtime.listCapabilities({sourceId:'refs'});assert.equal(after.source.revision,before.source.revision);assert.equal(after.items[0].revision,before.items[0].revision);
});
