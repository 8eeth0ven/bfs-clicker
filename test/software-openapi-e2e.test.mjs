import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {temp,fixture,until,root} from './helpers.mjs';

async function connect(t,args) {
  const transport=new StdioClientTransport({command:process.execPath,args,cwd:root,stderr:'pipe'});
  let stderr='';transport.stderr.on('data',chunk=>{stderr+=chunk});
  const client=new Client({name:'spec-generated-client',version:'1'});
  await client.connect(transport);t.after(()=>client.close());return {client,stderr:()=>stderr};
}
async function call(client,name,args={}) {
  const result=await client.callTool({name,arguments:args});
  assert(!result.isError,JSON.stringify(result));
  return result.structuredContent||JSON.parse(result.content[0].text);
}
async function finish(client,started,{failed=false}={}) {
  return until(async()=>{
    const state=await call(client,'software_operation',{operationId:started.operationId});
    if(state.status==='failed'){if(failed)return state;throw Error(JSON.stringify(state));}
    if(['cancelled','interrupted'].includes(state.status))throw Error(JSON.stringify(state));
    return state.status==='completed'&&state;
  },20000);
}

test('official MCP imports a formal spec, rejects invalid input before HTTP, and generates a callable typed tool',{timeout:60000},async t=>{
  const dir=temp(t),out=path.join(dir,'out'),config=path.join(dir,'config.json'),document=path.join(dir,'api.yaml');
  const site=await fixture(t,({url})=>({type:'application/json',body:JSON.stringify({path:url.pathname,tags:url.searchParams.getAll('tag')})}));
  writeFileSync(config,JSON.stringify({artifactRoots:[dir],bindings:{documented:{allowed_origins:[site.origin]}}}));
  writeFileSync(document,`openapi: 3.1.0\ninfo: {title: Query, version: '1'}\nservers: [{url: '${site.origin}/api'}]\npaths:\n  /items/{id}:\n    get:\n      parameters:\n        - {in: path, name: id, required: true, schema: {type: integer, minimum: 1}}\n        - {in: query, name: tag, required: true, schema: {type: array, minItems: 1, items: {type: string, enum: [a, b]}}}\n`);
  const {client}=await connect(t,[path.join(root,'src/software-mcp.js'),'--config',config,'--output-root',out]);
  await finish(client,await call(client,'software_import_openapi',{sourceId:'documented',documentPath:document}));
  const catalog=await call(client,'software_capabilities',{sourceId:'documented'}),cap=catalog.items[0];
  assert.equal(cap.readiness,'ready',JSON.stringify(catalog));
  assert(cap.evidence.provenance.includes('static_candidate'));assert(!cap.evidence.provenance.includes('observed'));
  const before=site.requests.length;
  const invalid=await finish(client,await call(client,'software_call',{sourceId:'documented',capabilityId:cap.id,expectedRevision:cap.revision,params:{path:{id:0},query:{tag:['c']}}}),{failed:true});
  assert.equal(invalid.status,'failed');assert.match(invalid.error,/INPUT_INVALID/);assert.equal(site.requests.length,before);
  const generated=await finish(client,await call(client,'software_generate',{sourceId:'documented',expectedRevision:catalog.source.revision}));
  const independent=await connect(t,[generated.result.entry]);
  const name='cap_'+cap.id.slice(4,24),tools=(await independent.client.listTools()).tools;
  assert(tools.some(item=>item.name===name&&item.inputSchema.properties.path.properties.id.minimum===1));
  const invocation=await call(independent.client,name,{path:{id:7},query:{tag:['b','a']}});
  const done=await until(async()=>{const state=await call(independent.client,'operation_status',{operationId:invocation.operationId});if(state.status==='failed')throw Error(JSON.stringify(state));return state.status==='completed'&&state;},20000);
  assert.equal(done.result.result.ok,true);assert.equal(done.result.result.data.response.body.value.path,'/api/items/7');
  assert.deepEqual(done.result.result.data.response.body.value.tags,['b','a']);
  assert.equal(site.requests.length,before+1);
  const refreshed=await finish(client,await call(client,'software_refresh',{sourceId:'documented',expectedRevision:catalog.source.revision}));
  assert.equal(refreshed.result.source.revision,catalog.source.revision);assert.equal(refreshed.result.counts.ready,1);
  const extra=path.join(dir,'extra.json');writeFileSync(extra,JSON.stringify({openapi:'3.1.0',info:{title:'Additional',version:'1'},servers:[{url:site.origin+'/api'}],paths:{'/extras':{get:{}}}}));
  await finish(client,await call(client,'software_import_openapi',{sourceId:'documented',documentPath:extra,merge:true,expectedRevision:catalog.source.revision}));
  const enriched=await call(client,'software_capabilities',{sourceId:'documented'});assert.equal(enriched.items.length,2);assert(enriched.items.some(item=>item.id===cap.id));
  const stale=await independent.client.callTool({name,arguments:{path:{id:7},query:{tag:['a']}}});assert.equal(stale.isError,true);assert.match(stale.content[0].text,/SOURCE_CHANGED/);
});

test('unsupported OpenAPI wire contracts never publish impossible ready tools',{timeout:30000},async t=>{
 const dir=temp(t),out=path.join(dir,'out'),config=path.join(dir,'config.json'),document=path.join(dir,'api.json');
 const site=await fixture(t,()=>({type:'application/json',body:'{}'}));
 writeFileSync(config,JSON.stringify({artifactRoots:[dir],bindings:{documented:{allowed_origins:[site.origin]}}}));
 writeFileSync(document,JSON.stringify({openapi:'3.0.3',info:{title:'Unsupported',version:'1'},servers:[{url:site.origin}],paths:{'/items':{get:{parameters:[{in:'query',name:'tags',style:'spaceDelimited',explode:true,schema:{type:'array',items:{type:'string'}}}]}}}}));
 const {client}=await connect(t,[path.join(root,'src/software-mcp.js'),'--config',config,'--output-root',out]);
 await finish(client,await call(client,'software_import_openapi',{sourceId:'documented',documentPath:document}));
 const catalog=await call(client,'software_capabilities',{sourceId:'documented'}),cap=catalog.items[0];
 assert.equal(cap.readiness,'candidate');assert(cap.gaps.some(gap=>gap.reason==='contract_has_no_supported_inputs'));
 const rejected=await finish(client,await call(client,'software_call',{sourceId:'documented',capabilityId:cap.id,expectedRevision:cap.revision,params:{query:{tags:['a']}}}),{failed:true});
 assert.equal(rejected.status,'failed');assert.equal(rejected.errorCode,'CAPABILITY_NOT_READY');assert.match(rejected.error,/CAPABILITY_NOT_READY/);assert.equal(site.requests.length,0);
 const generated=await finish(client,await call(client,'software_generate',{sourceId:'documented',expectedRevision:catalog.source.revision}));
 const independent=await connect(t,[generated.result.entry]);assert(!(await independent.client.listTools()).tools.some(tool=>tool.name.startsWith('cap_')));
});
