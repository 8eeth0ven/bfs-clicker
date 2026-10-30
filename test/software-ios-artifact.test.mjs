import test from 'node:test';
import assert from 'node:assert/strict';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {temp,fixture,until,root} from './helpers.mjs';

const exec=promisify(execFile);
async function call(client,name,args={}){const reply=await client.callTool({name,arguments:args});assert(!reply.isError,JSON.stringify(reply));return reply.structuredContent||JSON.parse(reply.content[0].text);}
async function finish(client,started,name='software_operation'){return until(async()=>{const state=await call(client,name,{operationId:started.operationId});if(['failed','cancelled','interrupted'].includes(state.status))throw Error(JSON.stringify(state));return state.status==='completed'&&state;},20000);}

// This IPA is a real archive with plist, assets and arm64 Mach-O extraction
// evidence. Its executable is an object fixture, not an installable iOS app.
test('raw unsigned IPA evidence → extraction → generated MCP → real HTTP call',{timeout:60000},async t=>{
  const dir=temp(t),python=path.join(root,'.venv/bin/python'),ipa=path.join(dir,'Fixture.ipa'),seed=path.join(dir,'seed');
  const site=await fixture(t,({url})=>({type:'application/json',body:JSON.stringify({path:url.pathname,page:url.searchParams.get('page')})}));
  await exec(python,[path.join(root,'apk_tools/examples/ios_demo/build_demo.py'),'--out',ipa,'--api-origin',site.origin],{cwd:root});
  await exec(python,['-m','apk_inventory.ios',ipa,'--out',seed],{cwd:root});
  const descriptor=JSON.parse(readFileSync(path.join(seed,'source.json'),'utf8')),sourceId=descriptor.source_id;
  const config=path.join(dir,'config.json');
  writeFileSync(config,JSON.stringify({outputRoot:path.join(dir,'out'),artifactRoots:[dir],python,bindings:{[sourceId]:{allowed_origins:[site.origin]}}}));
  async function connect(args){const transport=new StdioClientTransport({command:process.execPath,args,cwd:root,stderr:'pipe'});transport.stderr.on('data',()=>{});const client=new Client({name:'raw-ipa-client',version:'1'});await client.connect(transport);t.after(()=>client.close());return client;}
  const client=await connect([path.join(root,'src/software-mcp.js'),'--config',config]);
  await finish(client,await call(client,'software_discover',{kind:'ios',input:ipa}));
  const catalog=await call(client,'software_capabilities',{sourceId,limit:100});
  const cap=catalog.items.find(item=>item.name==='GET /items');assert(cap,JSON.stringify(catalog));assert.equal(cap.readiness,'ready');
  assert(cap.evidence.provenance.includes('static_candidate'));assert(!cap.evidence.provenance.includes('observed'));
  assert(catalog.items.some(item=>item.name.startsWith('METHOD? ')&&item.readiness==='candidate'));
  assert.equal(site.requests.length,0,'extracting an archive must not invoke its discovered URLs');
  const generation=await finish(client,await call(client,'software_generate',{sourceId,expectedRevision:catalog.source.revision}));
  const independent=await connect([generation.result.entry]);
  const result=await finish(independent,await call(independent,'cap_'+cap.id.slice(4,24),{query:{page:2}}),'operation_status');
  assert.equal(result.result.result.ok,true);assert.equal(result.result.result.data.response.body.value.path,'/items');
  assert.equal(result.result.result.data.response.body.value.page,'2');assert.equal(site.requests.length,1);
});
