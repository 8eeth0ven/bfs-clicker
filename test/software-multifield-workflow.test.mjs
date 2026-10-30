import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {appendFileSync,writeFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {temp,fixture,document,until,root} from './helpers.mjs';

async function call(client,name,args={}){const reply=await client.callTool({name,arguments:args});assert(!reply.isError,JSON.stringify(reply));return reply.structuredContent||JSON.parse(reply.content[0].text);}
async function finish(client,start,name='software_operation',{failed=false}={}){return until(async()=>{const state=await call(client,name,{operationId:start.operationId});if(state.status==='failed'){if(failed)return state;throw Error(JSON.stringify(state));}if(['cancelled','interrupted'].includes(state.status))throw Error(JSON.stringify(state));return state.status==='completed'&&state;},60000);}

// Actual site DOM, actual POST inputs and stdio clients. No handcrafted ready
// manifests or mocked browser workflow compiler are used in this test.
test('multifield candidate IDs bind separate output regions, preserve wire/native schemas, and generate callable tools',{timeout:180000},async t=>{
 const dir=temp(t),queries=[],otherQueries=[];
 const site=await fixture(t,async({url},req)=>{
  if(url.pathname==='/api/search'||url.pathname==='/api/other'){
   let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);(url.pathname==='/api/search'?queries:otherQueries).push(input);
   return {type:'application/json',body:JSON.stringify({...input,serverItem:input.query+'-'+input.category+'-'+input.limit})};
  }
  return {body:document('多字段查询',`<section id="main"><form id="searchForm" action="/api/search" method="post">
   <label for="query">查询词</label><input id="query" name="query" type="search" required minlength="2" maxlength="20" pattern="[a-z]+">
   <label for="category">类别</label><select id="category" name="category" required><option value="">请选择</option><option value="usr">用户</option><option value="team">团队</option><option value="org">组织</option></select>
   <label for="enabled">启用筛选</label><input id="enabled" name="enabled" type="checkbox">
   <label for="accepted">必选筛选</label><input id="accepted" name="accepted" type="checkbox" required>
   <label for="limit">条数</label><input id="limit" name="limit" type="number" required min="2" max="8" step="2">
   <label for="tags">标签</label><select id="tags" name="tags" multiple required size="3"><option value="a">标签甲</option><option value="b">标签乙</option><option value="c">标签丙</option></select>
   <button id="search" type="button" aria-controls="summary categoryOut flagsOut">查询</button></form>
   <output id="summary" role="status" aria-label="查询摘要">未查询</output><output id="categoryOut" aria-label="类别结果">未查询</output><output id="flagsOut" role="status" aria-label="筛选结果">未查询</output></section>
   <section id="secondary"><form id="otherForm" action="/api/other" method="post"><label for="otherQuery">另一个查询</label><input id="otherQuery" type="search" name="unrelated" required><button id="otherSearch" type="button" aria-controls="otherOut">查询其它</button></form><output id="otherOut" aria-label="其它结果">未查询</output></section>`,
   `document.querySelector('#search').onclick=async()=>{const input={query:document.querySelector('#query').value,category:document.querySelector('#category').value,enabled:document.querySelector('#enabled').checked,accepted:document.querySelector('#accepted').checked,limit:Number(document.querySelector('#limit').value),tags:Array.from(document.querySelector('#tags').selectedOptions).map(o=>o.value)};const response=await fetch('/api/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});const data=await response.json();document.querySelector('#summary').textContent='搜索 '+data.query+'；上限 '+data.limit+'；'+data.serverItem;document.querySelector('#categoryOut').textContent='类别：'+document.querySelector('#category').selectedOptions[0].label;document.querySelector('#flagsOut').textContent='状态：'+(data.enabled?'启用':'停用')+'；必选：'+(data.accepted?'已选':'未选')+'；标签：'+Array.from(document.querySelector('#tags').selectedOptions).map(o=>o.label).join('、');};document.querySelector('#otherSearch').onclick=()=>fetch('/api/other',{method:'POST',body:JSON.stringify({query:document.querySelector('#otherQuery').value})});`)};
 });
 const config=path.join(dir,'config.json'),out=path.join(dir,'out');
 writeFileSync(config,JSON.stringify({outputRoot:out,artifactRoots:[dir],webConfig:{actionProfile:'forms',fillText:true,formValues:{'#query':'seed','#otherQuery':'other','#limit':'2'},actionAllowlist:['#query','#category','#enabled','#accepted','#limit','#tags','#search','#otherQuery','#otherSearch'],requestAllowlist:[{method:'POST',url:site.origin+'/api/search'},{method:'POST',url:site.origin+'/api/other'}],shotFormat:'none',exploreHover:false,exploreScroll:false,requestDelayMs:0}}));
 async function connect(args){const transport=new StdioClientTransport({command:process.execPath,args,cwd:root,stderr:'pipe'});let logs='';transport.stderr.on('data',chunk=>logs=(logs+chunk).slice(-8192));const client=new Client({name:'multifield-workflow-sdk',version:'1'});await client.connect(transport);t.after(()=>client.close());return {client,logs:()=>logs};}
 const {client}=await connect([path.join(root,'src/software-mcp.js'),'--config',config]);
 await finish(client,await call(client,'software_discover',{sourceId:'multifield',kind:'web',input:site.origin,webOptions:{maxStates:1,maxDepth:0,maxActions:20,maxDurationMs:20000}}));
 const plan=await call(client,'software_workflows',{sourceId:'multifield',limit:100}),candidate=plan.items.find(item=>item.inputSchema.properties.category);
 assert(candidate,JSON.stringify(plan));assert.deepEqual(new Set(Object.keys(candidate.inputSchema.properties)),new Set(['query','category','enabled','accepted','limit','tags']));assert(!Object.hasOwn(candidate.inputSchema.properties,'unrelated'));
 const secondary=plan.items.find(item=>item.inputSchema.properties.unrelated);assert(secondary);assert.deepEqual(Object.keys(secondary.inputSchema.properties),['unrelated']);
 assert(!JSON.stringify(plan).includes('"selector"'));assert.equal(candidate.inputSchema.properties.query.pattern,'^(?:[a-z]+)$');assert.equal(candidate.inputSchema.properties.query.minLength,2);assert.equal(candidate.inputSchema.properties.query.maxLength,20);
 assert.deepEqual(candidate.inputSchema.properties.category.enum,['usr','team','org']);assert(!candidate.inputSchema.properties.category.enum.includes('用户'));
 assert.equal(candidate.inputSchema.properties.enabled.type,'boolean');assert.equal(candidate.inputSchema.properties.accepted.const,true);assert.equal(candidate.inputSchema.properties.limit.multipleOf,2);assert.equal(candidate.inputSchema.properties.limit.minimum,2);assert.equal(candidate.inputSchema.properties.limit.maximum,8);assert.equal(candidate.inputSchema.properties.tags.uniqueItems,true);assert.equal(candidate.inputSchema.properties.tags.minItems,1);
 const output=label=>{const target=candidate.outputTargets.find(item=>item.label===label);assert(target,JSON.stringify(candidate.outputTargets));return target.id;};
 const assertions=[{outputTargetId:output('查询摘要'),param:'query'},{outputTargetId:output('查询摘要'),param:'limit'},{outputTargetId:output('类别结果'),param:'category',representation:'optionLabel'},{outputTargetId:output('筛选结果'),param:'enabled',valueMap:{true:'启用',false:'停用'}},{outputTargetId:output('筛选结果'),param:'accepted',valueMap:{true:'已选'}},{outputTargetId:output('筛选结果'),param:'tags',representation:'optionLabel',separator:'、'}];
 const samples=[{query:'alpha',category:'usr',enabled:true,accepted:true,limit:2,tags:['a']},{query:'beta',category:'team',enabled:false,accepted:true,limit:4,tags:['b','c']}];
 const base={sourceId:'multifield',expectedRevision:plan.source.revision,candidateId:candidate.id,samples,resultAssertions:assertions};
 const beforeInvalid=queries.length;
 for(const resultAssertions of [assertions.map((item,index)=>index===0?{...item,outputTargetId:secondary.outputTargets[0].id}:item),assertions.slice(0,-1),assertions.map(item=>item.param==='enabled'?{...item,valueMap:{true:'启用'}}:item),assertions.map(item=>item.param==='limit'?{...item,representation:'optionLabel'}:item)]){
  const rejected=await finish(client,await call(client,'software_bind_workflow',{...base,resultAssertions}),'software_operation',{failed:true});assert.equal(rejected.status,'failed');assert.equal(queries.length,beforeInvalid);assert.equal(otherQueries.length,0);
 }
 const learned=await finish(client,await call(client,'software_bind_workflow',base));assert(learned.result.counts.ready>0,JSON.stringify(learned));assert.deepEqual(queries.slice(-2),samples);assert.equal(otherQueries.length,0);
 const catalog=await call(client,'software_capabilities',{sourceId:'multifield',kind:'browser',limit:100}),cap=catalog.items.find(item=>item.readiness==='ready'&&item.inputSchema.properties.category);assert(cap,JSON.stringify(catalog));assert.equal(cap.inputSchema.properties.accepted.const,true);assert.deepEqual(cap.inputSchema.properties.category.enum,['usr','team','org']);
 const count=queries.length;
 for(const patch of [{query:'A1'},{category:'组织'},{enabled:'true'},{accepted:false},{limit:3},{tags:['a','a']},{tags:[]}]){
  const rejected=await finish(client,await call(client,'software_call',{sourceId:'multifield',capabilityId:cap.id,expectedRevision:cap.revision,params:{...samples[0],...patch}}),'software_operation',{failed:true});assert.equal(rejected.status,'failed');assert.match(rejected.error,/INPUT_INVALID/);assert.equal(queries.length,count);
 }
 const third={query:'gamma',category:'org',enabled:true,accepted:true,limit:6,tags:['b','a']};
 const called=await finish(client,await call(client,'software_call',{sourceId:'multifield',capabilityId:cap.id,expectedRevision:cap.revision,params:third}));assert.equal(called.result.result.ok,true,JSON.stringify(called));const data=JSON.stringify(called.result.result.data);for(const text of ['gamma-org-6','组织','启用','已选','标签甲、标签乙'])assert(data.includes(text),data);assert.deepEqual(queries.at(-1),{...third,tags:['a','b']});
 const generation=await finish(client,await call(client,'software_generate',{sourceId:'multifield',expectedRevision:catalog.source.revision})),generated=await connect([generation.result.entry]),fourth={query:'delta',category:'team',enabled:false,accepted:true,limit:8,tags:['c']};
 const result=await finish(generated.client,await call(generated.client,'cap_'+cap.id.slice(4,24),fourth),'operation_status');assert.equal(result.result.result.ok,true,JSON.stringify(result));for(const text of ['delta-team-8','团队','停用','标签丙'])assert(JSON.stringify(result.result.result.data).includes(text));assert.deepEqual(queries.at(-1),fourth);
 appendFileSync(path.join(out,'runs/multifield/private/events.jsonl'),JSON.stringify({kind:'source_changed_marker',evidenceId:'independent-change',timestamp:Date.now()})+'\n');
 const beforeStale=site.requests.length;
 const stale=await finish(client,await call(client,'software_bind_workflow',{...base,expectedRevision:catalog.source.revision}),'software_operation',{failed:true});assert.equal(stale.status,'failed');assert.match(stale.error,/SOURCE_CHANGED/);assert.equal(site.requests.length,beforeStale);
 const oldCall=await finish(client,await call(client,'software_call',{sourceId:'multifield',capabilityId:cap.id,expectedRevision:cap.revision,params:third}),'software_operation',{failed:true});assert.equal(oldCall.status,'failed');assert.match(oldCall.error,/SOURCE_CHANGED|原配置.*变化/);assert.equal(site.requests.length,beforeStale);
});
