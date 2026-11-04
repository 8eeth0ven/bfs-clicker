import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createSoftwareRuntime} from '../src/software-runtime.js';
import {temp,fixture,document} from './helpers.mjs';

const save=(file,value)=>writeFileSync(file,JSON.stringify(value));
const specification=(origin,minimum=2)=>({openapi:'3.1.0',info:{title:'补充规范',version:'1'},servers:[{url:origin}],paths:{'/api/items':{get:{parameters:[{in:'query',name:'page',required:true,schema:{type:'integer',minimum}}]}},'/api/documented':{get:{}}}});

test('formal HTTP evidence enriches an observed Web source without removing browser capabilities or credentials',{timeout:60000},async t=>{
 const dir=temp(t),calls=[];
 const site=await fixture(t,({url,headers})=>{
  if(url.pathname.startsWith('/api/')){calls.push({path:url.pathname,page:url.searchParams.get('page'),signature:headers['x-signature']});return {type:'application/json',body:JSON.stringify({page:Number(url.searchParams.get('page')||0)})};}
  return {body:document('补充证据','<button id="query" onclick="fetch(\'/api/items?page=1\')">查看项目</button>')};
 });
 const runtime=createSoftwareRuntime({outputRoot:path.join(dir,'out'),artifactRoots:[dir],webConfig:{shotFormat:'none',requestDelayMs:0,authInject:{headers:{'X-Signature':'private-web-signature'}},credentialOrigins:[site.origin],exploreHover:false,exploreScroll:false}});
 await runtime.discover({sourceId:'observed',kind:'web',input:site.origin,webOptions:{maxStates:3,maxDepth:1,maxActions:3,maxDurationMs:15000}},path.join(dir,'discovery'));
 const first=runtime.listCapabilities({sourceId:'observed',limit:100}),browserIds=first.items.filter(cap=>cap.kind==='browser').map(cap=>cap.id);assert(browserIds.length>0);
 const spec=path.join(dir,'openapi.json');save(spec,specification(site.origin));
 const merged=await runtime.importSpecification({sourceId:'observed',documentPath:spec,expectedRevision:first.source.revision,merge:true});
 assert.notEqual(merged.source.revision,first.source.revision);const catalog=runtime.listCapabilities({sourceId:'observed',limit:100}),cap=catalog.items.find(cap=>cap.name==='GET /api/items');
 assert(browserIds.every(id=>catalog.items.some(cap=>cap.id===id)));assert(catalog.items.some(cap=>cap.name==='GET /api/documented'));
 assert(cap.evidence.provenance.includes('observed'));assert(cap.evidence.provenance.includes('static_candidate'));assert.equal(cap.inputSchema.properties.query.properties.page.minimum,2);
 const before=calls.length;
 await assert.rejects(runtime.execute({sourceId:'observed',capabilityId:cap.id,expectedRevision:cap.revision,params:{query:{page:1}},outputDir:path.join(dir,'invalid')}),/INPUT_INVALID/);assert.equal(calls.length,before);
 const result=await runtime.execute({sourceId:'observed',capabilityId:cap.id,expectedRevision:cap.revision,params:{query:{page:3}},outputDir:path.join(dir,'execution')});
 assert.equal(result.result.ok,true);assert.equal(calls.at(-1).signature,'private-web-signature');assert(!JSON.stringify(catalog).includes('private-web-signature'));
 const refreshed=await runtime.refresh({sourceId:'observed',expectedRevision:catalog.source.revision});assert.equal(refreshed.source.revision,catalog.source.revision);
 save(spec,specification(site.origin,4));await runtime.importSpecification({sourceId:'observed',documentPath:spec,expectedRevision:refreshed.source.revision,merge:true});
 assert.equal(runtime.listCapabilities({sourceId:'observed'}).items.find(cap=>cap.name==='GET /api/items').inputSchema.properties.query.properties.page.minimum,4);
});

test('APK/iOS supplemental HTTP declarations retain static artifact identity and invocation origin limits',async t=>{
 const dir=temp(t),site=await fixture(t,()=>({type:'application/json',body:'{}'}));
 for(const kind of ['apk','ios']){
  const sourceId=kind+'_merge',inventory=path.join(dir,sourceId);mkdirSync(inventory);const app={package_name:'com.example.merge',version_name:'1',artifact_sha256:'a'.repeat(64),artifact_type:kind==='apk'?'apk':'app',...(kind==='apk'?{apk_sha256:'a'.repeat(64)}:{bundle_id:'com.example.merge'})};
  save(path.join(inventory,'source.json'),{format:'endpoint-inventory',schema_version:'1.1',source_id:sourceId,kind,app,inventory:'endpoints.json'});save(path.join(inventory,'endpoints.json'),[{method:'GET',url:site.origin+'/api/items',categories:['static_candidate'],source:'native'}]);
  const runtime=createSoftwareRuntime({outputRoot:path.join(dir,'out-'+kind),artifactRoots:[dir],bindings:{[sourceId]:{allowed_origins:[site.origin]}}});await runtime.compile({sourceId,kind,inventoryPath:inventory});
  const spec=path.join(dir,kind+'.json');save(spec,specification(site.origin));const original=runtime.getSource(sourceId);await runtime.importSpecification({sourceId,documentPath:spec,expectedRevision:original.revision,merge:true});
  const catalog=runtime.listCapabilities({sourceId});assert.equal(catalog.source.kind,kind);assert.equal(catalog.source.app.package_name,app.package_name);assert.equal(catalog.source.app.artifact_sha256,app.artifact_sha256);
  const cap=catalog.items.find(cap=>cap.name==='GET /api/items');const called=await runtime.execute({sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{query:{page:2}},outputDir:path.join(dir,'call-'+kind)});assert.equal(called.result.ok,true);
  save(spec,{...specification('https://outside.invalid'),paths:{'/external':{get:{}}}});await runtime.importSpecification({sourceId,documentPath:spec,expectedRevision:catalog.source.revision,merge:true});
  const external=runtime.listCapabilities({sourceId}).items.find(cap=>cap.name==='GET /external');assert.equal(external.readiness,'candidate');assert(!runtime.getSource(sourceId).allowedOrigins.some(origin=>origin.includes('outside.invalid')));
 }
});

test('conflicting formal contracts stay candidate and a failed merge cannot advance the source pointer',async t=>{
 const dir=temp(t),sourceId='conflict',origin='http://127.0.0.1:1',inventory=path.join(dir,'base.json');save(inventory,[]);
 const runtime=createSoftwareRuntime({outputRoot:path.join(dir,'out'),artifactRoots:[dir],bindings:{[sourceId]:{allowed_origins:[origin]}}});await runtime.compile({sourceId,kind:'web',inventoryPath:inventory});
 for(const [name,minimum]of [['a',2],['b',5]]){const spec=path.join(dir,name+'.json');save(spec,specification(origin,minimum));await runtime.importSpecification({sourceId,documentPath:spec,merge:true,expectedRevision:runtime.getSource(sourceId).revision});}
 const catalog=runtime.listCapabilities({sourceId});assert.equal(catalog.items.find(cap=>cap.name==='GET /api/items').readiness,'candidate');assert(catalog.source.gaps.some(gap=>gap.reason==='conflicting_formal_contracts'));
 const file=path.join(dir,'invalid.json');writeFileSync(file,'not json');await assert.rejects(runtime.importSpecification({sourceId,documentPath:file,merge:true,expectedRevision:catalog.source.revision}));assert.equal(runtime.getSource(sourceId).revision,catalog.source.revision);
 await assert.rejects(runtime.importSpecification({sourceId,documentPath:file,merge:true}),/SOURCE_CHANGED/);
 const pointer=JSON.parse(readFileSync(path.join(dir,'out/sources/conflict/current.json'),'utf8'));assert.equal(pointer.httpSupplements.length,2);
});
