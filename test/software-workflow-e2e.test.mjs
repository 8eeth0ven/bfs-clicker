import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {temp,fixture,document,until,root} from './helpers.mjs';

async function call(client,name,args={}){const reply=await client.callTool({name,arguments:args});assert(!reply.isError,JSON.stringify(reply));return reply.structuredContent||JSON.parse(reply.content[0].text);}
async function finish(client,started,name='software_operation',{failure=false}={}){return until(async()=>{const state=await call(client,name,{operationId:started.operationId});if(state.status==='failed'){if(failure)return state;throw Error(JSON.stringify(state));}if(['cancelled','interrupted'].includes(state.status))throw Error(JSON.stringify(state));return state.status==='completed'&&state;},60000);}

test('MCP discovers a query candidate, learns two inputs, and generated typed tool executes unseen input',{timeout:180000},async t=>{
 const dir=temp(t),queries=[];let drift=false;
 const site=await fixture(t,async({url},req)=>{
  if(url.pathname==='/api/search'){
   let raw='';for await(const chunk of req)raw+=chunk;const query=JSON.parse(raw).query;queries.push(query);
   return {type:'application/json',body:JSON.stringify({query,items:[query+'-one',query+'-two']})};
  }
  return {body:document('参数化查询',`<section role="search"><label for="query">查询词</label><input id="${drift?'renamed':'query'}" name="query" type="search" required minlength="2" maxlength="20"><button id="search" type="button" aria-controls="results">查询</button><div id="results" role="status">等待查询</div></section>`,
   `document.querySelector('#search').onclick=async()=>{const query=document.querySelector('input').value;const response=await fetch('/api/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query})});const data=await response.json();document.querySelector('#results').textContent='找到 '+data.query+'：'+data.items.join(', ');};`)};
 });
 const config=path.join(dir,'runtime.json'),out=path.join(dir,'out');
 writeFileSync(config,JSON.stringify({outputRoot:out,artifactRoots:[dir],webConfig:{actionProfile:'forms',fillText:true,formValues:{'#query':'seed'},actionAllowlist:['#query','#search'],requestAllowlist:[{method:'POST',url:site.origin+'/api/search'}],exploreHover:false,exploreScroll:false,shotFormat:'none',requestDelayMs:0}}));
 async function connect(args){const transport=new StdioClientTransport({command:process.execPath,args,cwd:root,stderr:'pipe'});let logs='';transport.stderr.on('data',chunk=>logs=(logs+chunk).slice(-8192));const client=new Client({name:'parameterized-workflow-client',version:'1'});await client.connect(transport);t.after(()=>client.close());return {client,logs:()=>logs};}
 const {client}=await connect([path.join(root,'src/software-mcp.js'),'--config',config]);
 await finish(client,await call(client,'software_discover',{sourceId:'query_site',kind:'web',input:site.origin,webOptions:{maxStates:4,maxDepth:1,maxActions:4,maxDurationMs:20000}}));
 const plan=await call(client,'software_workflows',{sourceId:'query_site'});
 assert(plan.items.length>0,JSON.stringify(plan));assert(!JSON.stringify(plan).includes('"selector"'));
 const candidate=plan.items.find(item=>item.inputSchema.properties.query&&item.outputTargets?.length);assert(candidate,JSON.stringify(plan));
 assert.equal(candidate.inputSchema.properties.query.minLength,2);assert.equal(candidate.inputSchema.properties.query.maxLength,20);
 const learned=await finish(client,await call(client,'software_bind_workflow',{sourceId:'query_site',expectedRevision:plan.source.revision,candidateId:candidate.id,samples:[{query:'alpha'},{query:'beta'}],outputTargetId:candidate.outputTargets[0].id,assertParam:'query'}));
 assert(learned.result.counts.ready>0,JSON.stringify(learned));assert(queries.includes('alpha'));assert(queries.includes('beta'));
 const catalog=await call(client,'software_capabilities',{sourceId:'query_site',kind:'browser',limit:100});
 const cap=catalog.items.find(item=>item.readiness==='ready'&&item.inputSchema.properties.query);assert(cap,JSON.stringify(catalog));
 const before=queries.length;
 const rejected=await finish(client,await call(client,'software_call',{sourceId:'query_site',capabilityId:cap.id,expectedRevision:cap.revision,params:{query:'x'}}),'software_operation',{failure:true});
 assert.equal(rejected.status,'failed');assert.match(rejected.error,/INPUT_INVALID/);assert.equal(queries.length,before);
 const invoked=await finish(client,await call(client,'software_call',{sourceId:'query_site',capabilityId:cap.id,expectedRevision:cap.revision,params:{query:'gamma'}}));
 assert.equal(invoked.result.result.ok,true,JSON.stringify(invoked));assert.match(JSON.stringify(invoked.result.result.data),/gamma-one/);assert.equal(queries.at(-1),'gamma');
 const generation=await finish(client,await call(client,'software_generate',{sourceId:'query_site',expectedRevision:catalog.source.revision}));
 const generated=await connect([generation.result.entry]),tool='cap_'+cap.id.slice(4,24);
 const result=await finish(generated.client,await call(generated.client,tool,{query:'delta'}),'operation_status');
 assert.equal(result.result.result.ok,true,JSON.stringify(result));assert.match(JSON.stringify(result.result.result.data),/delta-two/);
 drift=true;const count=queries.length;
 const changed=await finish(client,await call(client,'software_call',{sourceId:'query_site',capabilityId:cap.id,expectedRevision:cap.revision,params:{query:'epsilon'}}),'software_operation',{failure:true});
 assert(changed.status==='failed'||changed.result?.result?.ok===false,JSON.stringify(changed));assert.equal(queries.length,count);
});
