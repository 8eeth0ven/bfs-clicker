import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {readArtifactText,readArtifactTextSnapshot} from '../src/artifact-text.js';
import {mkdirSync,readFileSync,readdirSync,writeFileSync,unlinkSync,symlinkSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {createSoftwareRuntime} from '../src/software-runtime.js';
import {temp,fixture,until,root} from './helpers.mjs';

const save=(file,value)=>writeFileSync(file,JSON.stringify(value));
const origin='https://api.example.test';
const spec=(base,paths)=>({openapi:'3.1.0',info:{title:'Refresh fixture',version:'1'},servers:[{url:base}],paths});
const query=enumValues=>({get:{parameters:[{in:'query',name:'q',required:true,schema:{type:'string',enum:enumValues}}]}});
const cap=(runtime,sourceId,route)=>runtime.listCapabilities({sourceId,limit:100}).items.find(c=>c.target?.path===route);
const pointer=(out,id)=>path.join(out,'sources',id,'current.json');
const snapshots=out=>readdirSync(path.join(out,'private')).filter(n=>/^spec-.*\.json$/.test(n)).sort();

test('refresh rereads the original main and explicit reference documents, removes routes and reuses unchanged snapshots',async t=>{
 const dir=temp(t),out=path.join(dir,'out'),main=path.join(dir,'api.json'),types=path.join(dir,'types.json'),sourceId='refresh';
 const document=()=>spec(origin,{'/items':{get:{parameters:[{in:'query',name:'q',required:true,schema:{$ref:'types.json#/Tag'}}]}}});
 save(main,document());save(types,{Tag:{type:'string',enum:['old','older']}});
 const runtime=createSoftwareRuntime({outputRoot:out,artifactRoots:[dir],bindings:{[sourceId]:{allowed_origins:[origin]}}});
 await runtime.importSpecification({sourceId,documentPath:main,documentUrl:origin+'/spec/root.json',referenceDocuments:[{documentUrl:origin+'/spec/types.json',documentPath:types}]});
 const before=runtime.getSource(sourceId),oldCap=cap(runtime,sourceId,'/items');assert.deepEqual(oldCap.inputSchema.properties.query.properties.q.enum,['old','older']);
 const count=snapshots(out);await runtime.refresh({sourceId,expectedRevision:before.revision});assert.equal(runtime.getSource(sourceId).revision,before.revision);assert.deepEqual(snapshots(out),count);
 save(types,{Tag:{type:'string',enum:['new','newer']}});const edited=document();edited.paths['/later']=query(['later']);save(main,edited);
 const changed=await runtime.refresh({sourceId,expectedRevision:before.revision});assert.notEqual(changed.source.revision,before.revision);assert.deepEqual(cap(runtime,sourceId,'/items').inputSchema.properties.query.properties.q.enum,['new','newer']);assert(cap(runtime,sourceId,'/later'));assert.notEqual(cap(runtime,sourceId,'/items').revision,oldCap.revision);
 delete edited.paths['/items'];save(main,edited);await runtime.refresh({sourceId,expectedRevision:changed.source.revision});assert(!cap(runtime,sourceId,'/items'));assert(cap(runtime,sourceId,'/later'));
 const stable=runtime.getSource(sourceId).revision,files=snapshots(out);for(let i=0;i<3;i++)await runtime.refresh({sourceId,expectedRevision:stable});assert.equal(runtime.getSource(sourceId).revision,stable);assert.deepEqual(snapshots(out),files);
 assert(!JSON.stringify(runtime.listCapabilities({sourceId})).includes(dir));
});

test('refresh replaces two supplemental bundles for Web/APK/iOS without dropping base evidence or broadening origins',async t=>{
 for(const kind of ['web','apk','ios']){
  const dir=temp(t),out=path.join(dir,'out'),sourceId=kind+'_refresh',base=path.join(dir,'base');
  let input=base,app;
  if(kind==='web'){input=base+'.json';save(input,[]);}else{
   mkdirSync(base);app={package_name:'com.example.refresh',version_name:'1',artifact_sha256:'a'.repeat(64),...(kind==='apk'?{apk_sha256:'a'.repeat(64),artifact_type:'apk'}:{bundle_id:'com.example.refresh',artifact_type:'app'})};
   save(path.join(base,'source.json'),{format:'endpoint-inventory',schema_version:'1.1',kind,source_id:sourceId,app,inventory:'endpoints.json'});save(path.join(base,'endpoints.json'),[]);
  }
  const runtime=createSoftwareRuntime({outputRoot:out,artifactRoots:[dir],bindings:{[sourceId]:{allowed_origins:[origin]}}});await runtime.compile({sourceId,kind,inventoryPath:input});
  const a=path.join(dir,'one.json'),b=path.join(dir,'two.json');save(a,spec(origin,{'/one':query(['a'])}));save(b,spec(origin,{'/two':query(['b'])}));
  for(const documentPath of [a,b])await runtime.importSpecification({sourceId,documentPath,merge:true,expectedRevision:runtime.getSource(sourceId).revision});
  const previous=runtime.getSource(sourceId);save(a,spec(origin,{'/one':query(['new'])}));save(b,spec('https://outside.invalid',{'/outside':query(['blocked'])}));
  await runtime.refresh({sourceId,expectedRevision:previous.revision});const updated=runtime.getSource(sourceId);
  assert.equal(updated.kind,kind);if(app)assert.deepEqual(updated.app,previous.app);assert.deepEqual(cap(runtime,sourceId,'/one').inputSchema.properties.query.properties.q.enum,['new']);assert(!cap(runtime,sourceId,'/two'));assert.equal(cap(runtime,sourceId,'/outside').readiness,'candidate');assert(!updated.allowedOrigins.some(o=>o.includes('outside.invalid')));
  const ref=JSON.parse(readFileSync(pointer(out,sourceId)));assert.equal(ref.httpSupplements.length,2);assert(ref.httpSupplements.every(s=>s.specificationInput.schemaVersion===1));
 }
});

test('a failed original bundle read or parse never advances current and never falls back to an old snapshot',async t=>{
 const dir=temp(t),outside=temp(t),out=path.join(dir,'out'),sourceId='atomic_refresh',base=path.join(dir,'base.json'),a=path.join(dir,'a.json'),b=path.join(dir,'b.json');save(base,[]);save(a,spec(origin,{'/one':query(['a'])}));save(b,spec(origin,{'/two':query(['b'])}));
 const runtime=createSoftwareRuntime({outputRoot:out,artifactRoots:[dir],bindings:{[sourceId]:{allowed_origins:[origin]}}});await runtime.compile({sourceId,inventoryPath:base});
 for(const documentPath of [a,b])await runtime.importSpecification({sourceId,documentPath,merge:true,expectedRevision:runtime.getSource(sourceId).revision});
 const revision=runtime.getSource(sourceId).revision,original=readFileSync(pointer(out,sourceId),'utf8'),files=snapshots(out);save(a,spec(origin,{'/one':query(['changed'])}));writeFileSync(b,'{invalid json');
 await assert.rejects(runtime.refresh({sourceId,expectedRevision:revision}));assert.equal(readFileSync(pointer(out,sourceId),'utf8'),original);assert.deepEqual(snapshots(out),files);assert.deepEqual(cap(runtime,sourceId,'/one').inputSchema.properties.query.properties.q.enum,['a']);
 unlinkSync(b);await assert.rejects(runtime.refresh({sourceId,expectedRevision:revision}),e=>e.code==='DOCUMENT_UNAVAILABLE'&&!e.message.includes(dir));assert.equal(readFileSync(pointer(out,sourceId),'utf8'),original);
 const foreign=path.join(outside,'foreign.json');save(foreign,spec(origin,{'/foreign':query(['x'])}));symlinkSync(foreign,b);await assert.rejects(runtime.refresh({sourceId,expectedRevision:revision}),/artifactRoots/);assert.equal(readFileSync(pointer(out,sourceId),'utf8'),original);
 await assert.rejects(runtime.refresh({sourceId,expectedRevision:'0'.repeat(64)}),/SOURCE_CHANGED/);
});

test('private original-input provenance is revision-bound and legacy snapshots require explicit reimport',async t=>{
 const dir=temp(t),out=path.join(dir,'out'),main=path.join(dir,'api.json'),a=path.join(dir,'types-a.json'),b=path.join(dir,'types-b.json'),sourceId='provenance';
 save(main,spec(origin,{'/items':{get:{parameters:[{in:'query',name:'q',schema:{$ref:'types.json#/Tag'}}]}}}));for(const f of [a,b])save(f,{Tag:{type:'string',enum:['same']}});
 const runtime=createSoftwareRuntime({outputRoot:out,artifactRoots:[dir],bindings:{[sourceId]:{allowed_origins:[origin]}}}),args={sourceId,documentPath:main,documentUrl:origin+'/spec/root.json'};
 await runtime.importSpecification({...args,referenceDocuments:[{documentUrl:origin+'/spec/types.json',documentPath:a}]});const first=runtime.getSource(sourceId).revision;
 await runtime.importSpecification({...args,expectedRevision:first,referenceDocuments:[{documentUrl:origin+'/spec/types.json',documentPath:b}]});const second=runtime.getSource(sourceId).revision;assert.notEqual(first,second);
 const file=pointer(out,sourceId),ref=JSON.parse(readFileSync(file));delete ref.specificationInput;save(file,ref);const raw=readFileSync(file,'utf8');
 await assert.rejects(runtime.refresh({sourceId,expectedRevision:second}),e=>e.code==='OPENAPI_REFRESH_REIMPORT_REQUIRED');assert.equal(readFileSync(file,'utf8'),raw);
 await runtime.importSpecification({...args,expectedRevision:second,referenceDocuments:[{documentUrl:origin+'/spec/types.json',documentPath:b}]});assert.equal(runtime.getSource(sourceId).revision,second);await runtime.refresh({sourceId,expectedRevision:second});
});

async function connect(t,args){
 const transport=new StdioClientTransport({command:process.execPath,args,cwd:root,stderr:'pipe'});let stderr='',ownedChild;transport.stderr.on('data',c=>{stderr+=c});const client=new Client({name:'refresh-official-sdk',version:'1'});
 t.after(async()=>{ownedChild||=transport._process;await client.close();if(ownedChild&&ownedChild.exitCode===null&&ownedChild.signalCode===null)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Owned SDK server did not close')),5000);ownedChild.once('close',()=>{clearTimeout(timer);resolve()})});assert.equal(stderr,'');assert(ownedChild&&ownedChild.exitCode===0&&ownedChild.signalCode===null)});
 try{await client.connect(transport);ownedChild=transport._process;return client;}catch(error){ownedChild||=transport._process;throw error;}
}
async function call(client,name,args={}){const r=await client.callTool({name,arguments:args});assert(!r.isError,JSON.stringify(r));return r.structuredContent||JSON.parse(r.content[0].text)}
async function terminal(client,start,tool='software_operation'){return until(async()=>{const r=await call(client,tool,{operationId:start.operationId});if(['failed','cancelled','interrupted'].includes(r.status))throw Error(JSON.stringify(r));return r.status==='completed'&&r;},20000)}

test('official unified refresh invalidates the old generated entry and a new entry calls the changed original reference contract',{timeout:60000},async t=>{
 const dir=temp(t),out=path.join(dir,'out'),main=path.join(dir,'api.json'),types=path.join(dir,'types.json'),config=path.join(dir,'config.json'),sourceId='sdk_refresh';
 const site=await fixture(t,({url})=>({type:'application/json',body:JSON.stringify({q:url.searchParams.get('q')})}));
 save(main,spec(site.origin,{'/items':{get:{parameters:[{in:'query',name:'q',required:true,schema:{$ref:'types.json#/Tag'}}]}}}));save(types,{Tag:{type:'string',enum:['red']}});
 save(config,{outputRoot:out,artifactRoots:[dir],bindings:{[sourceId]:{allowed_origins:[site.origin]}}});
 const client=await connect(t,[path.join(root,'src/software-mcp.js'),'--config',config]);await terminal(client,await call(client,'software_import_openapi',{sourceId,documentPath:main,documentUrl:site.origin+'/spec/root.json',referenceDocuments:[{documentUrl:site.origin+'/spec/types.json',documentPath:types}]}));
 const first=await call(client,'software_capabilities',{sourceId}),id=first.items[0].id,tool='cap_'+id.slice(4,24),generated=await terminal(client,await call(client,'software_generate',{sourceId,expectedRevision:first.source.revision})),old=await connect(t,[generated.result.entry]);
 await terminal(old,await call(old,tool,{query:{q:'red'}}),'operation_status');assert.equal(site.requests.length,1);
 save(types,{Tag:{type:'string',enum:['blue','cyan']}});await terminal(client,await call(client,'software_refresh',{sourceId,expectedRevision:first.source.revision}));const next=await call(client,'software_capabilities',{sourceId});assert.notEqual(next.source.revision,first.source.revision);assert.deepEqual(next.items[0].inputSchema.properties.query.properties.q.enum,['blue','cyan']);assert.equal(site.requests.length,1);
 const stale=await old.callTool({name:tool,arguments:{query:{q:'red'}}});assert(stale.isError);assert.match(stale.content[0].text,/SOURCE_CHANGED/);assert.equal(site.requests.length,1);
 const unified=await terminal(client,await call(client,'software_call',{sourceId,capabilityId:id,expectedRevision:next.items[0].revision,params:{query:{q:'blue'}}}));assert.equal(unified.result.result.data.response.body.value.q,'blue');
 const newer=await terminal(client,await call(client,'software_generate',{sourceId,expectedRevision:next.source.revision})),entry=await connect(t,[newer.result.entry]);const done=await terminal(entry,await call(entry,tool,{query:{q:'cyan'}}),'operation_status');assert.equal(done.result.result.data.response.body.value.q,'cyan');assert.equal(site.requests.length,3);
});

function hook(t,name,replace){const original=fs[name];fs[name]=replace(original);syncBuiltinESMExports();const restore=()=>{fs[name]=original;syncBuiltinESMExports()};t.after(restore);return restore;}
async function sharedBundles(t,{alias=false}={}){
 const dir=fs.realpathSync(temp(t)),out=path.join(dir,'out'),sourceId='shared_refresh',base=path.join(dir,'base.json'),one=path.join(dir,'one.json'),two=path.join(dir,'two.json'),shared=path.join(dir,'shared.json'),other=path.join(dir,'other.json'),input=path.join(dir,'alias.json');save(base,[]);save(shared,{Tag:{type:'string',enum:['old']}});save(other,{Tag:{type:'string',enum:['different']}});if(alias)symlinkSync(shared,input);
 const document=route=>spec(origin,{[route]:{get:{parameters:[{in:'query',name:'q',required:true,schema:{$ref:'shared.json#/Tag'}}]}}});save(one,document('/one'));save(two,document('/two'));
 const runtime=createSoftwareRuntime({outputRoot:out,artifactRoots:[dir],bindings:{[sourceId]:{allowed_origins:[origin]}}});await runtime.compile({sourceId,inventoryPath:base});
 for(const documentPath of [one,two])await runtime.importSpecification({sourceId,documentPath,documentUrl:origin+'/spec/'+path.basename(documentPath),referenceDocuments:[{documentUrl:origin+'/spec/shared.json',documentPath:alias?input:shared}],merge:true,expectedRevision:runtime.getSource(sourceId).revision});
 return{dir,out,sourceId,one,two,shared,other,input,runtime,revision:runtime.getSource(sourceId).revision,raw:readFileSync(pointer(out,sourceId),'utf8')};
}

test('one refresh rejects a changed shared canonical reference rather than publishing mixed bundle versions',async t=>{
 const x=await sharedBundles(t);let injected=false;hook(t,'openSync',original=>function(file,...args){if(file===x.two&&!injected){injected=true;save(x.shared,{Tag:{type:'string',enum:['new']}});}return original.call(this,file,...args)});
 await assert.rejects(x.runtime.refresh({sourceId:x.sourceId,expectedRevision:x.revision}),{code:'DOCUMENT_CHANGED'});assert(injected);assert.equal(readFileSync(pointer(x.out,x.sourceId),'utf8'),x.raw);for(const route of ['/one','/two'])assert.deepEqual(cap(x.runtime,x.sourceId,route).inputSchema.properties.query.properties.q.enum,['old']);
});

test('original alias cannot retarget between bundles even when both files remain inside artifactRoots',async t=>{
 const x=await sharedBundles(t,{alias:true});let injected=false;hook(t,'openSync',original=>function(file,...args){if(file===x.two&&!injected){injected=true;unlinkSync(x.input);symlinkSync(x.other,x.input);}return original.call(this,file,...args)});
 await assert.rejects(x.runtime.refresh({sourceId:x.sourceId,expectedRevision:x.revision}),{code:'DOCUMENT_CHANGED'});assert(injected);assert.equal(readFileSync(pointer(x.out,x.sourceId),'utf8'),x.raw);
});

test('last original-input validation happens after generation materialization and before publishing current',async t=>{
 const x=await sharedBundles(t);save(x.one,spec(origin,{'/one':query(['changed'])}));let injected=false;
 hook(t,'renameSync',original=>function(from,to,...args){const result=original.call(this,from,to,...args);if(String(from).includes('/staging-')&&path.basename(path.dirname(to))==='generations'&&!injected){injected=true;save(x.shared,{Tag:{type:'string',enum:['after-stage']}});}return result});
 await assert.rejects(x.runtime.refresh({sourceId:x.sourceId,expectedRevision:x.revision}),{code:'DOCUMENT_CHANGED'});assert(injected);assert.equal(readFileSync(pointer(x.out,x.sourceId),'utf8'),x.raw);
});

test('import also validates originals at publish instead of trusting its earlier complete read',async t=>{
 const dir=temp(t),out=path.join(dir,'out'),sourceId='changed_import',main=path.join(dir,'api.json');save(main,spec(origin,{'/items':query(['old'])}));const runtime=createSoftwareRuntime({outputRoot:out,artifactRoots:[dir],bindings:{[sourceId]:{allowed_origins:[origin]}}});let injected=false;
 hook(t,'renameSync',original=>function(from,to,...args){const result=original.call(this,from,to,...args);if(String(from).includes('/staging-')&&!injected){injected=true;save(main,spec(origin,{'/items':query(['new'])}));}return result});
 await assert.rejects(runtime.importSpecification({sourceId,documentPath:main}),{code:'DOCUMENT_CHANGED'});assert(injected);assert(!fs.existsSync(pointer(out,sourceId)));
});

test('supplement shape and count fail before any original-document read',async t=>{
 const x=await sharedBundles(t),original=JSON.parse(x.raw);let originalOpens=0;hook(t,'openSync',first=>function(file,...args){if([x.one,x.two,x.shared].includes(file))originalOpens++;return first.call(this,file,...args)});
 for(const value of [null,{},[null],[[]],Array.from({length:33},()=>({inventoryPath:x.one}))]){
  save(pointer(x.out,x.sourceId),{...original,httpSupplements:value});const raw=readFileSync(pointer(x.out,x.sourceId),'utf8');await assert.rejects(x.runtime.refresh({sourceId:x.sourceId,expectedRevision:x.revision}),{code:'SUPPLEMENT_LIMIT'});assert.equal(readFileSync(pointer(x.out,x.sourceId),'utf8'),raw);
 }
 assert.equal(originalOpens,0);save(pointer(x.out,x.sourceId),original);
});

test('reference count and cached occurrences retain original per-file and per-bundle byte ceilings',async t=>{
 const dir=temp(t),out=path.join(dir,'out'),sourceId='byte_limits',main=path.join(dir,'api.json'),large=path.join(dir,'large.json');save(main,spec(origin,{'/items':query(['old'])}));const runtime=createSoftwareRuntime({outputRoot:out,artifactRoots:[dir],bindings:{[sourceId]:{allowed_origins:[origin]}}});await runtime.importSpecification({sourceId,documentPath:main});const revision=runtime.getSource(sourceId).revision,raw=readFileSync(pointer(out,sourceId),'utf8');
 await assert.rejects(runtime.importSpecification({sourceId,documentPath:main,referenceDocuments:Array.from({length:33},(_,i)=>({documentUrl:origin+'/r'+i+'.json',documentPath:large})),expectedRevision:revision}),/REFERENCE_DOCUMENT_LIMIT/);
 writeFileSync(large,' '.repeat(8*1024*1024+1));await assert.rejects(runtime.importSpecification({sourceId,documentPath:large,expectedRevision:revision}),{code:'DOCUMENT_LIMIT'});
 const json='{"Tag":{"type":"string"},"padding":"';writeFileSync(large,json+'a'.repeat(8*1024*1024-Buffer.byteLength(json)-2)+'"}');assert.equal(fs.statSync(large).size,8*1024*1024);
 await assert.rejects(runtime.importSpecification({sourceId,documentPath:main,referenceDocuments:[{documentUrl:origin+'/a.json',documentPath:large},{documentUrl:origin+'/b.json',documentPath:large}],expectedRevision:revision}),{code:'DOCUMENT_LIMIT'});assert.equal(readFileSync(pointer(out,sourceId),'utf8'),raw);
});

test('legal standalone plus32 supplements refresh above16MiB total without shrinking the bundle domain',{timeout:60000},async t=>{
 const dir=temp(t),out=path.join(dir,'out'),sourceId='full_bundle_domain',runtime=createSoftwareRuntime({outputRoot:out,artifactRoots:[dir],bindings:{[sourceId]:{allowed_origins:[origin]}}}),files=[];let bytes=0;
 for(let i=0;i<33;i++){const file=path.join(dir,'doc-'+i+'.json'),value=spec(origin,{['/route-'+i]:query(['value-'+i])});value['x-padding']='x'.repeat(600*1024);save(file,value);bytes+=fs.statSync(file).size;files.push(file);await runtime.importSpecification({sourceId,documentPath:file,...(i?{merge:true,expectedRevision:runtime.getSource(sourceId).revision}:{})});}
 assert(bytes>16*1024*1024);const revision=runtime.getSource(sourceId).revision;await runtime.refresh({sourceId,expectedRevision:revision});assert.equal(runtime.getSource(sourceId).revision,revision);assert.equal(runtime.listCapabilities({sourceId,limit:100}).items.length,33);
 const before=readFileSync(pointer(out,sourceId),'utf8');let extraOpens=0;const extra=path.join(dir,'extra.json');save(extra,spec(origin,{'/extra':query(['x'])}));hook(t,'openSync',original=>function(file,...args){if(file===extra)extraOpens++;return original.call(this,file,...args)});await assert.rejects(runtime.importSpecification({sourceId,documentPath:extra,merge:true,expectedRevision:revision}),{code:'SUPPLEMENT_LIMIT'});assert.equal(extraOpens,0);assert.equal(readFileSync(pointer(out,sourceId),'utf8'),before);
});

test('evicted decoded shared documents reread only their pinned content and stamp',{timeout:60000},async t=>{
 for(const mutate of [false,true]){
  const dir=fs.realpathSync(temp(t)),out=path.join(dir,'out'),sourceId='lru_'+mutate,base=path.join(dir,'base.json'),shared=path.join(dir,'shared.json'),other=path.join(dir,'other.json'),mains=['a','b','c'].map(n=>path.join(dir,n+'.json'));save(base,[]);
  const padded=(value,length)=>{const before=JSON.stringify(value).slice(0,-1)+',"x-padding":"',after='"}';return before+'x'.repeat(length-Buffer.byteLength(before)-Buffer.byteLength(after))+after};
  writeFileSync(shared,padded({Tag:{type:'string',enum:['old']}},4*1024*1024));writeFileSync(other,padded({Tag:{type:'string',enum:['other']}},4*1024*1024));
  for(let i=0;i<3;i++){const value=spec(origin,{['/lru-'+i]:{get:{parameters:[{in:'query',name:'q',schema:{$ref:(i===1?'other':'shared')+'.json#/Tag'}}]}}});writeFileSync(mains[i],i===1?padded(value,4*1024*1024):JSON.stringify(value));}
  const runtime=createSoftwareRuntime({outputRoot:out,artifactRoots:[dir],bindings:{[sourceId]:{allowed_origins:[origin]}}});await runtime.compile({sourceId,inventoryPath:base});
  for(let i=0;i<3;i++)await runtime.importSpecification({sourceId,documentPath:mains[i],documentUrl:origin+'/spec/'+path.basename(mains[i]),referenceDocuments:[{documentUrl:origin+'/spec/'+(i===1?'other':'shared')+'.json',documentPath:i===1?other:shared}],merge:true,expectedRevision:runtime.getSource(sourceId).revision});
  const revision=runtime.getSource(sourceId).revision,raw=readFileSync(pointer(out,sourceId),'utf8'),fds=new Map();let sharedBytes=0,injected=false;
  const restoreOpen=hook(t,'openSync',original=>function(file,...args){if(file===mains[2]&&mutate&&!injected){injected=true;writeFileSync(shared,padded({Tag:{type:'string',enum:['new']}},4*1024*1024));}const fd=original.call(this,file,...args);fds.set(fd,file);return fd});
  const restoreRead=hook(t,'readSync',original=>function(fd,...args){const bytes=original.call(this,fd,...args);if(fds.get(fd)===shared)sharedBytes+=bytes;return bytes});
  try{if(mutate){await assert.rejects(runtime.refresh({sourceId,expectedRevision:revision}),{code:'DOCUMENT_CHANGED'});assert(injected);assert.equal(readFileSync(pointer(out,sourceId),'utf8'),raw);}else{await runtime.refresh({sourceId,expectedRevision:revision});assert.equal(runtime.getSource(sourceId).revision,revision);assert(sharedBytes>=8*1024*1024,'Shared document must be read again after decoded-cache eviction');}}
  finally{restoreRead();restoreOpen();}
 }
});

test('actual read context cannot bind descriptorA metadata to descriptorB content under a mocked A-B-A path',()=>{
 // This is a pure deterministic FD/path model, not a claimed real OS race.
 const source=readFileSync(path.join(root,'src/software-runtime.js'),'utf8'),start=source.indexOf(' function specificationReadContext('),end=source.indexOf(' async function readSpecificationInput(',start);assert(start>=0&&end>start);
 const stamp=ino=>({dev:1n,ino:BigInt(ino),size:1n,mtimeNs:1n,ctimeNs:1n,isFile:()=>true}),a=stamp(1),b=stamp(2);
 const context=vm.runInNewContext('('+source.slice(start,end)+')',{
  path,constants:fs.constants,config:{artifactRoots:['/mock']},checkedArtifact:()=>'/mock/input.json',
  openSync:()=>1,fstatSync:()=>a,closeSync:()=>{},createHash,
  readArtifactText:()=>({document:'B',bytes:1}),
  readArtifactTextSnapshot:()=>({document:'B',bytes:1,stamp:b})
 })(1);
 assert.throws(()=>context.read('/mock/input.json',1024),{code:'DOCUMENT_CHANGED'});
});

test('snapshot reader returns bytes and stamp from one descriptor while old reader shape stays exact',t=>{
 const file=path.join(temp(t),'snapshot.json'),text='\uFEFF{"city":"上 海"}';writeFileSync(file,text);const snapshot=readArtifactTextSnapshot(file,1024),actual=fs.statSync(file,{bigint:true});
 assert.equal(snapshot.document,text);assert.equal(snapshot.bytes,Buffer.byteLength(text));for(const key of ['dev','ino','size','mtimeNs','ctimeNs'])assert.equal(snapshot.stamp[key],actual[key]);
 assert.deepEqual(readArtifactText(file,1024),{document:text,bytes:Buffer.byteLength(text)});
});
