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
