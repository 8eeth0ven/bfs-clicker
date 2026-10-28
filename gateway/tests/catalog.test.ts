import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {loadConfig} from '../src/config.js';
import {Registry} from '../src/registry.js';
import {Discovery} from '../src/discovery.js';
import {LearningStore} from '../src/learning.js';
import {endpointId} from '../src/manifest.js';
import {GatewayError} from '../src/types.js';
import {Redactor} from '../src/redact.js';
import {createHash} from 'node:crypto';
import {Ajv2020} from 'ajv/dist/2020.js';

const record=(method:any,url:string,extra:any={})=>({method,url,headers:{},query:{},body:null,categories:['static_candidate'],...extra});
async function fixture(records:any[],extra:any={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'mcp-catalog-'));
  await mkdir(path.join(root,'manifests'));
  const manifest=path.join(root,'manifests','web.json');
  await writeFile(manifest,JSON.stringify(records));
  const configPath=path.join(root,'gateway.json');
  await writeFile(configPath,JSON.stringify({manifest_roots:['./manifests'],state_dir:'./state',sources:[{id:'web',manifest:'./manifests/web.json',public:true}],...extra}));
  const config=await loadConfig(configPath);
  const registry=new Registry(config);await registry.initialize();
  const learning=new LearningStore(config);await learning.initialize();
  return {root,manifest,configPath,config,registry,learning,discovery:new Discovery(registry,learning,config)};
}

test('同路径按组聚合，来源/过滤/参数按方法隔离，样例不公开',async t=>{
  const f=await fixture([
    record('GET','https://api.test/users/{id}?page=001&tag=a&tag=b',{source:'hermes',package:'assets/index.android.bundle',query:{q:'private-example-value'}}),
    record('POST','https://api.test/users/{id}',{categories:['observed','write'],body:{email:'private@example.test'},source:'network'}),
    record(null,'https://api.test/unknown',{source:'dex',package:'classes.dex#string:12'})
  ]);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const all=f.discovery.list({include_schema:true});assert.equal(all.items.length,2);
  const users=all.items.find((x:any)=>x.path==='/users/{id}');
  assert.deepEqual(users.methods,['GET','POST']);assert.equal(users.operations.GET.allowed,true);assert.equal(users.operations.POST.allowed,false);
  assert.equal(f.discovery.list({filter:{method:'GET',provenance:'observed'}}).items.length,0);
  assert.equal(f.discovery.list({filter:{method:'POST',provenance:'observed'}}).items.length,1);
  assert.deepEqual(users.operations.GET.params_schema.properties.path.required,['id']);
  assert.deepEqual(users.operations.GET.params_schema.properties.query.properties.page.type,['string','null']);
  assert.equal(users.operations.GET.params_schema.properties.query.required,undefined);
  assert.ok(users.operations.GET.params_schema.properties.query.properties.tag.anyOf);
  const encoded=JSON.stringify(f.discovery.resource('web'));
  assert.ok(!encoded.includes('private-example-value'));assert.ok(!encoded.includes('private@example.test'));
  const unknown=all.items.find((x:any)=>x.path==='/unknown');assert.deepEqual(unknown.methods,[]);assert.equal(unknown.allowed,false);
});

test('稳定ID不受方法/样例变化影响，路径语义保留',async t=>{
  const f=await fixture([record('GET','https://api.test/users/123?x=1')]);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const before=f.registry.get('web').endpoints[0].id;
  await writeFile(f.manifest,JSON.stringify([record('GET','https://API.test:443/users/123?x=2'),record('POST','https://api.test/users/123')]));
  await f.registry.addSource(f.manifest);
  assert.equal(f.registry.get('web').endpoints[0].id,before);
  assert.notEqual(before,endpointId('web','https://api.test','/users/123/'));
  assert.notEqual(before,endpointId('web','https://api.test','/users/{id}'));
});

test('分页绑定查询及不可变快照，热加载不重复或漏项',async t=>{
  const f=await fixture(Array.from({length:7},(_,i)=>record('GET',`https://api.test/items/${i}`)));t.after(()=>rm(f.root,{recursive:true,force:true}));
  const first=f.discovery.list({limit:2});assert.equal(first.items.length,2);assert.ok(first.next_cursor);
  await writeFile(f.manifest,JSON.stringify([record('GET','https://api.test/new')]));await f.registry.addSource(f.manifest);
  const seen=[...first.items];let cursor=first.next_cursor;
  while(cursor){const page=f.discovery.list({limit:2,cursor});seen.push(...page.items);cursor=page.next_cursor;}
  assert.equal(seen.length,7);assert.equal(new Set(seen.map((x:any)=>x.id)).size,7);
  assert.equal(f.discovery.list({}).items.length,1);
  assert.throws(()=>f.discovery.list({limit:3,cursor:first.next_cursor}),(e:any)=>e.code==='CURSOR_MISMATCH');
  assert.throws(()=>f.discovery.list({limit:2,cursor:first.next_cursor+'x'}),(e:any)=>e.code==='CURSOR_INVALID');
  const expired=new Discovery(f.registry,f.learning,f.config,undefined,-1);const p=expired.list({limit:1});
  // There must be a next page to test expiry.
  await writeFile(f.manifest,JSON.stringify([record('GET','https://api.test/a'),record('GET','https://api.test/b')]));await f.registry.addSource(f.manifest);
  const pp=expired.list({limit:1});assert.throws(()=>expired.list({limit:1,cursor:pp.next_cursor}),(e:any)=>e.code==='CURSOR_EXPIRED');
});

test('搜索匹配路径/参数，默认返回完整schema，排序和分页确定',async t=>{
  const f=await fixture([
    record('GET','https://api.test/catalog',{query:{invoice_number:'example'}}),
    record('GET','https://api.test/invoice'),record('GET','https://api.test/other',{description:'query invoice history'})
  ]);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const result=f.discovery.search({keyword:'invoice',limit:1});assert.equal(result.items[0].path,'/invoice');assert.ok(result.items[0].operations.GET.params_schema);
  const second=f.discovery.search({keyword:'invoice',limit:1,cursor:result.next_cursor});assert.equal(second.items.length,1);
  assert.equal(f.discovery.search({keyword:'invoice_number'}).items[0].path,'/catalog');
  assert.equal(f.discovery.search({keyword:'not-present-anywhere'}).items.length,0);
});

test('APK目录按source.json加载，保留提取溯源，阻止路径逃逸和身份冲突',async t=>{
  const f=await fixture([]);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const dir=path.join(f.root,'manifests','apk');await mkdir(dir);
  await writeFile(path.join(dir,'endpoints.static.json'),JSON.stringify([record(null,'https://apk.test/api',{source:'hermes',package:'assets/index.android.bundle'})]));
  await writeFile(path.join(dir,'source.json'),JSON.stringify({format:'endpoint-inventory',schema_version:'1.1',kind:'apk',source_id:'apk_demo',inventory:'endpoints.static.json',app:{package_name:'com.example.demo'}}));
  const refreshed={...f.config,sources:[...f.config.sources,{id:'apk_demo',manifest:dir,public:true}]};
  const result=await f.registry.addSource(dir,refreshed);assert.equal(result.action,'added');assert.equal(result.source.kind,'apk');assert.equal(result.source.endpoints[0].unresolved_candidates[0].extraction_source,'hermes');
  await writeFile(path.join(dir,'source.json'),JSON.stringify({format:'endpoint-inventory',schema_version:'1.1',kind:'apk',source_id:'apk_demo',inventory:'../../gateway.json'}));
  await assert.rejects(f.registry.addSource(dir,refreshed),(e:any)=>e.code==='MANIFEST_PATH_BLOCKED');assert.equal(f.registry.get('apk_demo').kind,'apk');
  const outside=path.join(f.root,'outside.json');await writeFile(outside,'[]');const link=path.join(f.root,'manifests','escape.json');await symlink(outside,link);
  await assert.rejects(f.registry.addSource(link,{...f.config,sources:[{id:'escape',manifest:link,public:true}]}),(e:any)=>e.code==='MANIFEST_PATH_BLOCKED');
});

test('学习按方法和契约分开，重置连续计数并持久化，原清单不修改',async t=>{
  const f=await fixture([record('GET','https://api.test/items'),record('POST','https://api.test/items')],{success_threshold:2,missing_threshold:2});t.after(()=>rm(f.root,{recursive:true,force:true}));
  const original=await readFile(f.manifest,'utf8');const ep=f.registry.get('web').endpoints[0];const get=ep.operations.GET!,post=ep.operations.POST!;
  await f.learning.observe('web',ep.id,get,200);await f.learning.observe('web',ep.id,get,204);
  assert.equal(f.learning.get('web',ep.id,get).state,'http_verified');assert.equal(f.learning.get('web',ep.id,post).state,'unverified');assert.deepEqual(get.provenance,['static_candidate']);
  await f.learning.observe('web',ep.id,get,404);await f.learning.observe('web',ep.id,get,401);await f.learning.observe('web',ep.id,get,410);
  assert.equal(f.learning.get('web',ep.id,get).missing_streak,1);await f.learning.observe('web',ep.id,get,404);assert.equal(f.learning.get('web',ep.id,get).state,'not_found_suspected');
  const store=new LearningStore(f.config);await store.initialize();assert.equal(store.get('web',ep.id,get).state,'not_found_suspected');
  assert.equal(store.get('web',ep.id,{...get,contract_revision:'changed'}).state,'unverified');assert.equal(await readFile(f.manifest,'utf8'),original);
});

test('损坏热加载不替换旧清单，非端点验收报告被拒绝',async t=>{
  const f=await fixture([record('GET','https://api.test/a')]);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const revision=f.registry.get('web').revision;await writeFile(f.manifest,'{"target":"crawl-report"}');
  await assert.rejects(f.registry.addSource(f.manifest),GatewayError);assert.equal(f.registry.get('web').revision,revision);
});

test('消费Retrofit仅名称参数和实抓body_shape，保持数值类型、不凭样例推必填',async t=>{
  const f=await fixture([record('POST','https://api.test/items/{id}',{source:'dex',parameters:{path:['id'],query:['page','filter'],headers:['X-Tenant']},body_capture:'shape_only',body_shape:{type:'object',properties:{page:{type:'integer'},active:{type:'boolean'}},required:['page']}})]);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const op=f.discovery.list({include_schema:true}).items[0].operations.POST;
  assert.ok(op.params_schema.properties.query.properties.filter);
  assert.equal(op.params_schema.properties.query.required,undefined);
  assert.equal(op.params_schema.properties.body.properties.page.type,'integer');
  assert.equal(op.params_schema.properties.body.required,undefined);
  assert.ok(op.parameter_summary.some((p:any)=>p.in==='header'&&p.name==='X-Tenant'&&p.managed));
});

test('显式query模板为必填且不接受表示省略的null',async t=>{
  const f=await fixture([record('GET','https://api.test/search?q={term}')]);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const schema=f.discovery.list({include_schema:true}).items[0].operations.GET.params_schema;
  assert.deepEqual(schema.required,['query']);assert.deepEqual(schema.properties.query.required,['q']);
  assert.deepEqual(schema.properties.query.properties.q.type,['string']);
});

test('默认参数/静态头/凭据origin改变使旧revision失效，多渠道定位均保留',async t=>{
  const f=await fixture([record('GET','https://api.test/items',{source:'dex',package:'classes.dex',query:{page:'1'},extraction_sources:['dex','asset'],locations:['classes.dex','assets/config.json']})]);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const original=f.registry.get('web');const ep=original.endpoints[0];const contract=ep.operations.GET!.contract_revision;
  const next={...f.config,sources:[{...f.config.sources[0],defaults:{[ep.id]:{query:{page:'2'}}},static_headers:{'X-Tenant':'demo'},credential_origins:['https://api.test']}]};
  const result=await f.registry.addSource(f.manifest,next);assert.equal(result.action,'reloaded');assert.notEqual(result.source.revision,original.revision);
  assert.notEqual(result.source.endpoints[0].operations.GET!.contract_revision,contract);
  assert.deepEqual(result.source.endpoints[0].operations.GET!.extraction_sources,['dex','asset']);assert.deepEqual(result.source.endpoints[0].operations.GET!.locations,['classes.dex','assets/config.json']);
  assert.ok(!JSON.stringify(f.discovery.resource('web')).includes('"page":"2"'));
});

test('明显认证静态头被拒绝，必须进入独立凭据配置',async t=>{
  const f=await fixture([]);t.after(()=>rm(f.root,{recursive:true,force:true}));
  for(const name of ['X-Api-Key','X-CSRF-Token','X-Auth-Token','X-Token','X-Session-Id','Authorization','Cookie']){
    await writeFile(f.configPath,JSON.stringify({manifest_roots:['./manifests'],sources:[{id:'web',manifest:'./manifests/web.json',public:true,static_headers:{[name]:'fixture-secret'}}]}));
    await assert.rejects(loadConfig(f.configPath),(e:any)=>e.code==='CONFIG_INVALID');
  }
});

test('GET忽略捕获的multipart请求体编码，POST保持能力阻断',async t=>{
  const f=await fixture([record('GET','https://api.test/items',{headers:{'Content-Type':'multipart/form-data'},body_shape:{type:'object',properties:{file:{type:'string'}}},body_capture:'shape_only'}),record('POST','https://api.test/items',{headers:{'Content-Type':'multipart/form-data'}})]);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const ep=f.registry.get('web').endpoints[0];assert.equal(ep.operations.GET!.allowed,true);assert.equal(ep.operations.GET!.body_encoding,'json');assert.equal(ep.operations.GET!.params_schema.properties.body,undefined);
  assert.equal(ep.operations.POST!.allowed,false);assert.equal(ep.operations.POST!.blocked_reason,'UNSUPPORTED_BODY_ENCODING');
});

test('动态query_shape保留标量和数组变体，显式必填合并null样例仍可编译',async t=>{
  const f=await fixture([record('GET','https://api.test/search?q={term}',{query_shape:{type:'object',properties:{tag:{anyOf:[{type:'string'},{type:'array',items:{type:'string'}}]}}}}),record('GET','https://api.test/search',{query:{q:null}})]);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const schema=f.registry.get('web').endpoints[0].operations.GET!.params_schema;
  const validate=new Ajv2020({strict:false,allowUnionTypes:true}).compile(schema);
  assert.equal(validate({query:{q:'x',tag:'blue'}}),true);assert.equal(validate({query:{q:'x',tag:['blue','new']}}),true);assert.equal(validate({query:{q:null}}),false);
});

test('source.json库存字节指纹失配不提交半更新快照',async t=>{
  const f=await fixture([]);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const dir=path.join(f.root,'manifests','apk');await mkdir(dir);const file=path.join(dir,'endpoints.json');const bytes=JSON.stringify([record('GET','https://api.test/a')]);await writeFile(file,bytes);
  const descriptor={format:'endpoint-inventory',schema_version:'1.1',kind:'apk',source_id:'apk_demo',inventory:'endpoints.json',inventory_sha256:createHash('sha256').update(bytes).digest('hex')};
  await writeFile(path.join(dir,'source.json'),JSON.stringify(descriptor));const refreshed={...f.config,sources:[...f.config.sources,{id:'apk_demo',manifest:dir,public:true}]};
  await f.registry.addSource(dir,refreshed);const old=f.registry.get('apk_demo').revision;
  await writeFile(file,JSON.stringify([record('GET','https://api.test/b')]));
  await assert.rejects(f.registry.addSource(dir,refreshed),(e:any)=>e.code==='INVENTORY_CHANGED');assert.equal(f.registry.get('apk_demo').revision,old);
});

test('短Cookie值不损坏可信目录ID和schema，敏感参数名字保持声明',async t=>{
  const f=await fixture([record('GET','https://api.test/v1/items',{query:{token:'sample',page:'1'}})]);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const discovery=new Discovery(f.registry,f.learning,f.config,new Redactor(['1','zh','GET','json']));const item=discovery.list({include_schema:true}).items[0];
  assert.match(item.id,/^ep_[a-f0-9]{64}$/);assert.equal(item.source,'web');assert.deepEqual(item.methods,['GET']);
  assert.deepEqual(item.operations.GET.params_schema.properties.query.properties.token.type,['string','null']);
  assert.ok(!JSON.stringify(item).includes('sample'));
});

test('目录快照限制单份及总字节，淘汰后cursor明确过期',async t=>{
  const f=await fixture([record('GET','https://api.test/a'),record('GET','https://api.test/b')]);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const page=f.discovery.list({limit:100});const bytes=Buffer.byteLength(JSON.stringify({items:page.items,sources:page.sources}));
  const tooSmall=new Discovery(f.registry,f.learning,f.config,undefined,300000,{single:bytes-1,total:bytes*2});
  assert.throws(()=>tooSmall.list({}),(e:any)=>e.code==='CATALOG_SNAPSHOT_TOO_LARGE');
  const bounded=new Discovery(f.registry,f.learning,f.config,undefined,300000,{single:bytes+256,total:bytes+256});
  const first=bounded.list({limit:1});assert.ok(first.next_cursor);bounded.list({limit:1});
  assert.throws(()=>bounded.list({limit:1,cursor:first.next_cursor}),(e:any)=>e.code==='CURSOR_EXPIRED');
});

test('业务分类不是可信协议常量，目录和资源中的已知秘密仍脱敏',async t=>{
  const secret='fixture-auth-secret-in-label';const f=await fixture([record('GET','https://api.test/items',{categories:['static_candidate',secret]})]);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const discovery=new Discovery(f.registry,f.learning,f.config,new Redactor([secret]));
  assert.ok(!JSON.stringify(discovery.list({})).includes(secret));assert.ok(!JSON.stringify(discovery.resource('web')).includes(secret));
});

test('未知method候选保留参数与描述检索，分类/渠道过滤匹配同一候选且不猜GET',async t=>{
  const f=await fixture([
    record(null,'https://api.test/mystery/{item_id}?lang=zh',{source:'hermes',package:'assets/index.android.bundle',query:{trace_key:'private-sample'},parameters:{query:['page_cursor']},categories:['static_candidate','mobile'],description:'pending catalog request'}),
    record(null,'https://api.test/mystery/{item_id}',{source:'dex',query:{account_name:'private-user'},categories:['static_candidate','account']})
  ]);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const searched=f.discovery.search({keyword:'page_cursor'});assert.equal(searched.items.length,1);const item=searched.items[0];
  assert.deepEqual(item.methods,[]);assert.equal(item.allowed,false);assert.deepEqual(item.operations,{});
  const unresolved=item.unresolved_candidates.find((x:any)=>x.extraction_source==='hermes');
  assert.match(unresolved.description,/catalog/);assert.ok(unresolved.parameter_summary.some((p:any)=>p.name==='trace_key'&&p.in==='query'));
  assert.deepEqual(unresolved.params_schema.properties.path.required,['item_id']);assert.ok(unresolved.params_schema.properties.query.properties.page_cursor);
  assert.equal(f.discovery.search({keyword:'pending catalog'}).items.length,1);
  assert.equal(f.discovery.list({filter:{category:'mobile',extraction_source:'hermes'}}).items.length,1);
  assert.equal(f.discovery.list({filter:{category:'mobile',extraction_source:'dex'}}).items.length,0);
  const brief=f.discovery.list({}).items[0];assert.ok(brief.unresolved_candidates[0].parameter_summary.length);assert.equal(brief.unresolved_candidates[0].params_schema,undefined);
  assert.ok(!JSON.stringify(searched).includes('private-sample'));assert.ok(!JSON.stringify(searched).includes('private-user'));
});

test('消费保留的三份parameter_variants，联合query标量数组数值及body字段而不带样例值',async t=>{
  const shapes=[
    {type:'object',properties:{count:{type:'integer'}}},
    {type:'object',properties:{count:{type:'string'},enabled:{type:'boolean'}}},
    {type:'object',properties:{note:{type:'string'},nested:{type:'object',properties:{version:{type:'integer'}}}}}
  ];
  const f=await fixture([record('POST','https://api.test/variant',{query:{value:'PRIVATE_PRIMARY_SAMPLE'},body:null,body_capture:'shape_only',body_shape:shapes[0],parameter_variants:[{query:{value:'PRIVATE_FIRST_SAMPLE'},body_shape:shapes[0]},{query:{value:['PRIVATE_SECOND_SAMPLE']},body_shape:shapes[1]},{query:{value:3,variant_only:'PRIVATE_THIRD_SAMPLE'},body_shape:shapes[2]}]})]);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const schema=f.registry.get('web').endpoints[0].operations.POST!.params_schema;const validate=new Ajv2020({strict:false,allowUnionTypes:true}).compile(schema);
  assert.equal(validate({query:{value:'x'},body:{count:1}}),true);
  assert.equal(validate({query:{value:['x']},body:{count:'one',enabled:true}}),true);
  assert.equal(validate({query:{value:4,variant_only:'x'},body:{note:'x',nested:{version:1}}}),true);
  assert.equal(validate({body:{nested:{version:'wrong-type'}}}),false);
  assert.equal(schema.properties.query.required,undefined);assert.equal(schema.properties.body.required,undefined);
  const publicData=f.discovery.list({include_schema:true});assert.ok(!JSON.stringify(publicData).includes('PRIVATE_'));
  assert.equal(f.discovery.search({keyword:'variant_only'}).items.length,1);
});


test('iOS嵌套代际清单支持plist/native溯源，短凭据不损坏hash，原始值不进入目录',async t=>{
  const f=await fixture([]);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const dir=path.join(f.root,'manifests','ios'),generation=path.join(dir,'static','generation-a');await mkdir(generation,{recursive:true});
  const records=[record(null,'https://mobile.test/native/items',{source:'native',package:'Payload/Demo.app/Demo#__cstring@64',query:{token:'synthetic-native-private-value'},categories:['static_candidate','native']}),record('GET','https://mobile.test/plist/config',{source:'plist',package:'Payload/Demo.app/Info.plist#APIURL'})];
  const bytes=JSON.stringify(records),inventory=path.join(generation,'endpoints.static.json');await writeFile(inventory,bytes);
  const hash='ab'.repeat(32);
  const descriptor={format:'endpoint-inventory',schema_version:'1.1',kind:'ios',source_id:'ios_demo',inventory:'static/generation-a/endpoints.static.json',inventory_sha256:createHash('sha256').update(bytes).digest('hex'),app:{package_name:'com.example.ios',bundle_id:'com.example.ios',version_name:'1.0',artifact_sha256:hash,ipa_sha256:hash,artifact_type:'ipa'}};
  const sourceFile=path.join(dir,'source.json');await writeFile(sourceFile,JSON.stringify(descriptor));
  const refreshed={...f.config,sources:[...f.config.sources,{id:'ios_demo',kind:'ios' as const,manifest:dir,public:true}]};
  const added=await f.registry.addSource(dir,refreshed);assert.equal(added.action,'added');assert.equal(added.source.kind,'ios');
  const redactor=new Redactor(['ab','native']);
  const d=new Discovery(f.registry,f.learning,f.config,redactor);
  const native=d.list({filter:{kind:'ios',extraction_source:'native'},include_schema:true});
  assert.equal(native.items.length,1);assert.equal(native.items[0].allowed,false);assert.deepEqual(native.items[0].methods,[]);
  assert.equal(native.items[0].unresolved_candidates[0].extraction_source,'native');assert.deepEqual(native.items[0].unresolved_candidates[0].extraction_sources,['native']);
  assert.deepEqual(native.items[0].unresolved_candidates[0].categories,['static_candidate','[REDACTED]']);
  const app=native.sources.find((source:any)=>source.source==='ios_demo').app;assert.equal(app.artifact_sha256,hash);assert.equal(app.ipa_sha256,hash);assert.equal(Object.hasOwn(app,'apk_sha256'),false);
  assert.equal(d.list({filter:{kind:'ios',extraction_source:'plist'}}).items[0].path,'/plist/config');
  assert.equal(d.search({source:'ios_demo',keyword:'native'}).items[0].path,'/[REDACTED]/items');
  assert.equal(d.search({source:'ios_demo',keyword:'Info.plist'}).items[0].path,'/plist/config');
  assert.ok(!JSON.stringify(d.resource('ios_demo')).includes('synthetic-native-private-value'));
  // A partial or racing generation must never replace the active registry snapshot.
  await writeFile(inventory,JSON.stringify([]));await assert.rejects(f.registry.addSource(dir,refreshed),(e:any)=>e.code==='INVENTORY_CHANGED');
  assert.equal(f.registry.get('ios_demo').revision,added.source.revision);
});

test('iOS身份不可替换，产物变化进入source与operation revision，类型和指纹受校验',async t=>{
  const f=await fixture([]);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const dir=path.join(f.root,'manifests','ios');await mkdir(dir);
  await writeFile(path.join(dir,'endpoints.json'),JSON.stringify([record('GET','https://ios.test/config',{source:'plist'})]));
  const app={package_name:'com.example.ios',bundle_id:'com.example.ios',version_name:'1',artifact_sha256:'1'.repeat(64),ipa_sha256:'1'.repeat(64),artifact_type:'ipa'};
  const descriptor={format:'endpoint-inventory',schema_version:'1.1',kind:'ios',source_id:'ios_demo',inventory:'endpoints.json',app};
  const file=path.join(dir,'source.json');const save=()=>writeFile(file,JSON.stringify(descriptor));await save();
  const refreshed={...f.config,sources:[...f.config.sources,{id:'ios_demo',kind:'ios' as const,manifest:dir,public:true}]};
  const first=(await f.registry.addSource(dir,refreshed)).source;const firstOp=first.endpoints[0].operations.GET!;
  await f.learning.observe('ios_demo',first.endpoints[0].id,firstOp,200);
  app.artifact_sha256='2'.repeat(64);app.ipa_sha256='2'.repeat(64);await save();
  const next=(await f.registry.addSource(dir,refreshed)).source;assert.equal(first.endpoints[0].id,next.endpoints[0].id);assert.notEqual(first.revision,next.revision);assert.notEqual(firstOp.contract_revision,next.endpoints[0].operations.GET!.contract_revision);
  assert.equal(f.learning.get('ios_demo',next.endpoints[0].id,next.endpoints[0].operations.GET!).success_streak,0);
  app.bundle_id='com.example.other';await save();await assert.rejects(f.registry.addSource(dir,refreshed),(e:any)=>e.code==='SOURCE_CONFLICT');
  app.package_name='com.example.other';await save();await assert.rejects(f.registry.addSource(dir,refreshed),(e:any)=>e.code==='SOURCE_CONFLICT');
  app.package_name='com.example.ios';app.bundle_id='com.example.ios';app.artifact_sha256='invalid-hash';await save();await assert.rejects(f.registry.addSource(dir,refreshed),(e:any)=>e.code==='MANIFEST_INVALID');
  app.artifact_sha256='2'.repeat(64);app.artifact_type='app';await save();await assert.rejects(f.registry.addSource(dir,refreshed),(e:any)=>e.code==='MANIFEST_INVALID');
  assert.equal(f.registry.get('ios_demo').revision,next.revision);
});
