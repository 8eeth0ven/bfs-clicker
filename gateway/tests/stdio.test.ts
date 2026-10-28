import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('真实SDK stdio：固定4工具，list→search→call，凭据脱敏，APK热加载与resources',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mcp-stdio-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const received:any[]=[];
  const http=createServer((req,res)=>{
    received.push({path:req.url,authorization:req.headers.authorization});
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({name:'demo',authorization:req.headers.authorization,echo:'prefix '+req.headers.authorization+' suffix'}));
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>new Promise<void>(resolve=>http.close(()=>resolve())));
  const origin=`http://127.0.0.1:${(http.address() as any).port}`;
  await mkdir(path.join(root,'manifests'));
  const records=[
    {method:'GET',url:origin+'/users/{id}',headers:{},query:{page:'sample'},body:null,categories:['static_candidate'],description:'user profile lookup'},
    {method:'POST',url:origin+'/users/{id}',headers:{'content-type':'application/json'},query:{},body:{name:'sample'},categories:['observed']},
    {method:null,url:origin+'/unknown',headers:{},query:{},body:null,categories:['static_candidate'],source:'dex',package:'classes.dex'}
  ];
  await writeFile(path.join(root,'manifests','web.json'),JSON.stringify(records));
  const credentials=path.join(root,'credential.yaml');const secret='Bearer stdio-fixture-secret-72839';
  await writeFile(credentials,`mode: headers\nheaders:\n  Authorization: "${secret}"\n`);
  const config:any={manifest_roots:['./manifests'],state_dir:'./state',success_threshold:2,sources:[{id:'web_demo',manifest:'./manifests/web.json',credentials:'./credential.yaml',allowed_origins:[origin],credential_origins:[origin]}]};
  const configPath=path.join(root,'gateway.json');await writeFile(configPath,JSON.stringify(config));
  const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx',path.resolve('src/server.ts'),'--config',configPath],cwd:process.cwd(),stderr:'pipe'});
  let errors='';transport.stderr?.on('data',chunk=>{errors+=String(chunk);});
  const client=new Client({name:'gateway-integration-test',version:'1.0.0'});
  await client.connect(transport);t.after(()=>client.close());
  const tools=await client.listTools();assert.deepEqual(tools.tools.map(x=>x.name).sort(),['add_source','call_endpoint','list_endpoints','search_endpoints']);
  assert.ok(tools.tools.every(x=>x.outputSchema));
  const call=async(name:string,args:any)=>{
    const result=await client.callTool({name,arguments:args});
    assert.ok(result.structuredContent);assert.equal(result.content[0].type,'text');
    assert.deepEqual(JSON.parse((result.content[0] as any).text),result.structuredContent);
    assert.ok(!JSON.stringify(result).includes('stdio-fixture-secret-72839'));
    return {mcp:result,result:result.structuredContent as any};
  };
  const listed=await call('list_endpoints',{source:'web_demo',limit:1});assert.equal(listed.result.data.items.length,1);assert.ok(listed.result.data.next_cursor);
  const searched=await call('search_endpoints',{source:'web_demo',keyword:'profile'});const endpoint=searched.result.data.items[0];assert.ok(endpoint.operations.GET.params_schema);
  const ambiguous=await call('call_endpoint',{source:'web_demo',endpoint_id:endpoint.id});assert.equal(ambiguous.result.error.code,'METHOD_REQUIRED');assert.equal(received.length,0);
  const args={source:'web_demo',endpoint_id:endpoint.id,expected_revision:endpoint.source_revision,params:{method:'GET',path:{id:'42'},query:{page:'2'}}};
  const executed=await call('call_endpoint',args);assert.equal(executed.result.ok,true);assert.equal(executed.result.data.response.status,200);assert.equal(executed.result.data.response.body.value.authorization,'[REDACTED]');
  assert.deepEqual(received[0],{path:'/users/42?page=2',authorization:secret});
  assert.ok(executed.result.warnings.some((warning:string)=>warning.includes('未验证')));
  const again=await call('call_endpoint',args);assert.equal(again.result.data.health.state,'http_verified');assert.deepEqual(again.result.data.provenance,['static_candidate']);
  assert.ok(!again.result.warnings.some((warning:string)=>warning.includes('未验证')));
  const blocked=await call('call_endpoint',{...args,params:{method:'POST',path:{id:'42'},body:{name:'x'}}});assert.equal(blocked.result.error.code,'METHOD_BLOCKED');assert.equal(received.length,2);
  const resources=await client.listResources();assert.equal(resources.resources.length,1);
  const resource=await client.readResource({uri:resources.resources[0].uri});assert.ok(!JSON.stringify(resource).includes('stdio-fixture-secret-72839'));
  // Add an APK source by updating trusted local bindings, not tool-supplied credentials.
  const apk=path.join(root,'manifests','apk');await mkdir(apk);
  await writeFile(path.join(apk,'endpoints.static.json'),JSON.stringify([{method:'GET',url:origin+'/mobile/items',headers:{},query:{},body:null,categories:['static_candidate'],source:'hermes',package:'assets/index.android.bundle'}]));
  await writeFile(path.join(apk,'source.json'),JSON.stringify({format:'endpoint-inventory',schema_version:'1.1',kind:'apk',source_id:'apk_demo',inventory:'endpoints.static.json',app:{package_name:'com.example.demo'}}));
  config.sources.push({id:'apk_demo',manifest:'./manifests/apk',public:true,allowed_origins:[origin]});await writeFile(configPath,JSON.stringify(config));
  const added=await call('add_source',{manifest_path:apk});assert.equal(added.result.data.action,'added');
  assert.equal((await client.listResources()).resources.length,2);
  const mobile=await call('search_endpoints',{source:'apk_demo',keyword:'mobile'});assert.equal(mobile.result.data.items[0].kind,'apk');assert.deepEqual(mobile.result.data.items[0].operations.GET.extraction_sources,['hermes']);
  await writeFile(path.join(root,'manifests','web.json'),JSON.stringify([records[0],{...records[0],url:origin+'/new'}]));await call('add_source',{manifest_path:path.join(root,'manifests','web.json')});
  const stale=await call('call_endpoint',args);assert.equal(stale.result.error.code,'SOURCE_CHANGED');assert.equal(received.length,2);
  assert.ok(!(await readFile(path.join(root,'state','health.json'),'utf8')).includes('stdio-fixture-secret-72839'));
  assert.ok(!errors.includes('stdio-fixture-secret-72839'));
});

test('真实SDK stdio：iOS代际source、plist/native过滤、未知方法阻断、APK native与产物身份隔离',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mcp-mobile-stdio-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const received:any[]=[];
  const http=createServer((req,res)=>{received.push({url:req.url,cookie:req.headers.cookie});res.setHeader('content-type','application/json');res.end(JSON.stringify({value:'fixture',echo:req.headers.cookie}));});
  http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>new Promise<void>(resolve=>http.close(()=>resolve())));
  const origin=`http://127.0.0.1:${(http.address() as any).port}`;
  const ios=path.join(root,'manifests','ios'),generation=path.join(ios,'static','generation-1');await mkdir(generation,{recursive:true});
  const records=[
    {method:null,url:origin+'/ios/native',headers:{},query:{},body:null,categories:['static_candidate'],source:'native',package:'Payload/Demo.app/Frameworks/Network.framework/Network#__cstring@256'},
    {method:'GET',url:origin+'/ios/config',headers:{},query:{page:1},body:null,categories:['static_candidate'],source:'plist',package:'Payload/Demo.app/Info.plist#APIURL'},
    {method:'POST',url:origin+'/ios/config',headers:{},query:{},body:{name:'fixture'},categories:['static_candidate'],source:'native',package:'Payload/Demo.app/Demo#__cstring@512'}
  ];
  await writeFile(path.join(generation,'endpoints.static.json'),JSON.stringify(records));
  const descriptor={format:'endpoint-inventory',schema_version:'1.1',kind:'ios',source_id:'ios_demo',inventory:'static/generation-1/endpoints.static.json',app:{package_name:'com.example.mobile',bundle_id:'com.example.mobile',version_name:'1',artifact_sha256:'aa'.repeat(32),ipa_sha256:'aa'.repeat(32),artifact_type:'ipa'}};
  const sourceFile=path.join(ios,'source.json');await writeFile(sourceFile,JSON.stringify(descriptor));
  await writeFile(path.join(root,'credential.yaml'),'mode: cookie\ncookie: "sid=aa"\n');
  const config:any={manifest_roots:['./manifests'],state_dir:'./state',sources:[{id:'ios_demo',kind:'ios',manifest:'./manifests/ios',credentials:'./credential.yaml',allowed_origins:[origin],credential_origins:[origin]}]};
  const configPath=path.join(root,'gateway.json');await writeFile(configPath,JSON.stringify(config));
  const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx',path.resolve('src/server.ts'),'--config',configPath],cwd:process.cwd(),stderr:'pipe'});
  let errors='';transport.stderr?.on('data',chunk=>{errors+=String(chunk);});
  const client=new Client({name:'mobile-gateway-integration-test',version:'1.0.0'});await client.connect(transport);t.after(()=>client.close());
  assert.deepEqual((await client.listTools()).tools.map(x=>x.name).sort(),['add_source','call_endpoint','list_endpoints','search_endpoints']);
  const call=async(name:string,args:any)=>{
    const mcp=await client.callTool({name,arguments:args});assert.ok(mcp.structuredContent);
    assert.deepEqual(JSON.parse((mcp.content[0] as any).text),mcp.structuredContent);
    assert.ok(!JSON.stringify(mcp).includes('sid=aa'));
    return mcp.structuredContent as any;
  };
  const listed=await call('list_endpoints',{source:'ios_demo',filter:{kind:'ios',extraction_source:'native'},include_schema:true});
  assert.equal(listed.ok,true);assert.equal(listed.data.items.length,2);
  assert.equal(listed.data.sources[0].app.artifact_sha256,'aa'.repeat(32));assert.equal(listed.data.sources[0].app.ipa_sha256,'aa'.repeat(32));assert.equal(Object.hasOwn(listed.data.sources[0].app,'apk_sha256'),false);
  const native=listed.data.items.find((x:any)=>x.path==='/ios/native');assert.equal(native.kind,'ios');assert.equal(native.allowed,false);assert.equal(native.unresolved_candidates[0].extraction_source,'native');
  const unknown=await call('call_endpoint',{source:'ios_demo',endpoint_id:native.id});assert.equal(unknown.error.code,'METHOD_UNRESOLVED');assert.equal(received.length,0);
  const plist=await call('list_endpoints',{source:'ios_demo',filter:{kind:'ios',method:'GET',extraction_source:'plist'}});assert.equal(plist.data.items.length,1);
  const searched=await call('search_endpoints',{source:'ios_demo',keyword:'Info.plist'});const ep=searched.data.items[0];assert.equal(ep.path,'/ios/config');assert.ok(ep.operations.GET.params_schema);
  const args={source:'ios_demo',endpoint_id:ep.id,expected_revision:ep.source_revision,params:{method:'GET',query:{page:2}}};
  const executed=await call('call_endpoint',args);assert.equal(executed.ok,true);assert.equal(executed.data.response.status,200);assert.equal(executed.data.response.body.value.echo,'[REDACTED]');assert.deepEqual(received,[{url:'/ios/config?page=2',cookie:'sid=aa'}]);
  const post=await call('call_endpoint',{...args,params:{method:'POST',body:{name:'fixture'}}});assert.equal(post.error.code,'METHOD_BLOCKED');assert.equal(received.length,1);
  const resource=await client.readResource({uri:'inventory://sources/ios_demo/manifest.json'});const document=JSON.parse((resource.contents[0] as any).text);assert.equal(document.kind,'ios');assert.equal(document.app.artifact_sha256,'aa'.repeat(32));assert.ok(document.endpoints.some((x:any)=>x.unresolved_candidates.some((u:any)=>u.extraction_source==='native')));
  const apk=path.join(root,'manifests','apk');await mkdir(apk);
  await writeFile(path.join(apk,'endpoints.static.json'),JSON.stringify([{...records[0],url:origin+'/apk/native',package:'lib/arm64-v8a/libnetwork.so#.rodata@64'}]));
  await writeFile(path.join(apk,'source.json'),JSON.stringify({format:'endpoint-inventory',schema_version:'1.1',kind:'apk',source_id:'apk_demo',inventory:'endpoints.static.json',app:{package_name:'com.example.apk'}}));
  config.sources.push({id:'apk_demo',kind:'apk',manifest:'./manifests/apk',public:true,allowed_origins:[origin]});await writeFile(configPath,JSON.stringify(config));
  assert.equal((await call('add_source',{manifest_path:apk})).data.action,'added');
  const apkNative=await call('list_endpoints',{filter:{kind:'apk',extraction_source:'native'}});assert.equal(apkNative.data.items.length,1);assert.deepEqual(apkNative.data.items[0].methods,[]);
  assert.equal((await client.listResources()).resources.length,2);
  descriptor.app.artifact_sha256='bb'.repeat(32);descriptor.app.ipa_sha256='bb'.repeat(32);await writeFile(sourceFile,JSON.stringify(descriptor));
  const reloaded=await call('add_source',{manifest_path:ios});assert.equal(reloaded.data.action,'reloaded');assert.notEqual(reloaded.data.source_revision,ep.source_revision);
  assert.equal((await call('call_endpoint',args)).error.code,'SOURCE_CHANGED');assert.equal(received.length,1);
  descriptor.app.package_name='com.example.other';descriptor.app.bundle_id='com.example.other';await writeFile(sourceFile,JSON.stringify(descriptor));
  const conflict=await call('add_source',{manifest_path:ios});assert.equal(conflict.error.code,'SOURCE_CONFLICT');
  const preserved=await call('search_endpoints',{source:'ios_demo',keyword:'config'});assert.equal(preserved.data.items[0].source_revision,reloaded.data.source_revision);
  assert.ok(!errors.includes('sid=aa'));
});
