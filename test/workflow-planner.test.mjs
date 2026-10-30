import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright';
import {collectInteractives,actionKey} from '../src/discover.js';
import {fingerprint} from '../src/state.js';
import {normalizeConfig} from '../src/asset.js';
import {createPolicy} from '../src/policy.js';
import {openStore} from '../src/store.js';
import {planBrowserWorkflows} from '../src/workflow-planner.js';
let browser,server,origin,captured,fp;
const HTML=`<!doctype html><meta charset=utf-8><title>Workflow inventory fixture</title>
<section><form id="queryForm" action="/search" method="get"><label for="q">查询词</label><input id="q" name="query" type="search" required minlength="2" maxlength="24" pattern="[A-Za-z]+" value="private-captured-current-value"><label for="kind">类别</label><select id="kind" name="kind" required><option value="">选择</option><option value="users">用户</option><option value="teams">团队</option><option value="disabled" disabled>禁用</option></select><label for="limit">条数</label><input id="limit" name="limit" type="number" required min="1" max="9" step="2"><button id="go" aria-controls="results">查询</button></form><table id="results" aria-label="查询结果"><tr><th>结果</th></tr><tr><td>private-live-result-data</td></tr></table></section>
<section><form id="externalForm" action="/search"><button id="externalGo" aria-controls="externalOut">搜索</button></form><label for="external">外置查询</label><input id="external" form="externalForm" type="search" name="outside" required><output id="externalOut">尚未查询</output></section>
<form id="excluded"><input id="excludedInput" type="search" name="excluded"><button id="excludedGo">查询</button></form>
<form id="login"><input type="password" name="password"><input type="search" name="loginQuery"><button id="loginGo">查询</button></form>
<iframe src="/frame" title="query frame"></iframe><div id="host"></div><script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<form id="shadowForm"><label for="sq">Shadow查询</label><input id="sq" name="shadowQuery" type="search" required><button id="sg" aria-controls="shadowOut">查询</button><output id="shadowOut" aria-live="polite">结果</output></form>';</script>`;
const FRAME='<!doctype html><meta charset=utf-8><form id="frameForm"><label for="fq">Frame查询</label><input id="fq" name="frameQuery" type="search" required><button id="fg" aria-controls="frameOut">查询</button></form><output id="frameOut">结果</output>';
const defaults=()=>({startUrl:origin+'/',actionProfile:'forms',fillText:true,fillTextValue:'Fixture',formExplore:false,requestDelayMs:0,shotFormat:'none',actionAllowlist:['#go','#externalGo','#fg','#host >> #sg','#excludedGo','#loginGo'],excludeSelectors:['#excluded'],requestAllowlist:[{method:'GET',url:origin+'/'},{method:'GET',url:origin+'/search'},{method:'GET',url:origin+'/frame'}],maxStates:10,maxDepth:1,maxDurationMs:10000,maxActions:30,maxRequests:100});
before(async()=>{
 server=createServer((req,res)=>{const html=req.url==='/frame'?FRAME:HTML;res.writeHead(200,{'content-type':'text/html','content-length':Buffer.byteLength(html)});res.end(html)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto(origin+'/');await page.locator('#host >> #sg').waitFor();await page.frameLocator('iframe').locator('#fg').waitFor();
 const config=normalizeConfig({...defaults(),outputDir:path.join(os.tmpdir(),'unused-workflow-inventory')});config._policy=createPolicy(config);
 captured=await collectInteractives(page,config);fp=await fingerprint(page,config);await page.close();
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>{server.closeAllConnections();server.close(r)})});
async function saved(t,{actions=captured,extra={},success=false,journal=false}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'workflow-plan-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const cfg=normalizeConfig({...defaults(),...extra,outputDir:dir}),store=openStore(cfg);
 const inventory=structuredClone(actions).map(action=>({...action,kind:'click',id:actionKey({...action,kind:'click'}),status:success?'succeeded':'planned',attempts:success?1:0}));
 const evidenceId=store.emit('state',{stateId:1,url:fp.url,fp:fp.fp,title:fp.title});
 const state={id:1,url:fp.url,title:fp.title,fp:fp.fp,parentId:null,path:[],evidenceId,interactives:inventory};
 if(success)for(const action of inventory){const executionId=store.emit('action_started',{stateId:1,actionId:action.id});store.emit('action_finished',{stateId:1,actionId:action.id,executionId,status:'succeeded'})}
 if(journal){store.save({states:[{...state,interactives:[]}],backEdges:[],coverageGaps:[]});store.journal({upsertStates:[state]})}
 else store.save({states:[state],backEdges:[],coverageGaps:[]});store.update({status:'partial'});store.release();
 return {dir,cfg,state,plan:options=>planBrowserWorkflows({runDir:dir,sourceId:'fixture',...options})};
}

test('real browser DOM inventory produces parameterized search candidates with HTML constraints and private specs',async t=>{
 const f=await saved(t),plan=await f.plan();assert.ok(plan.items.length>=4);
 const item=plan.items.find(item=>Object.hasOwn(item.inputSchema.properties,'query')),spec=plan.specs[item.id];
 assert.deepEqual(item.inputSchema.required,['query','kind','limit']);
 assert.equal(item.inputSchema.properties.query.minLength,2);assert.equal(item.inputSchema.properties.query.maxLength,24);assert.equal(item.inputSchema.properties.query.pattern,'^(?:[A-Za-z]+)$');
 assert.deepEqual(item.inputSchema.properties.kind.enum,['users','teams']);assert.equal(item.inputSchema.properties.limit.minimum,1);assert.equal(item.inputSchema.properties.limit.maximum,9);
 assert.ok(item.gaps.includes('number_step_requires_live_validation'));assert.equal(spec.steps[0].kind,'fill');assert.equal(spec.steps.at(-1).selector,'#go');
 assert.equal(item.readiness,'candidate');assert.equal(item.effect,'unknown');assert.deepEqual(spec.samples,[]);assert.deepEqual(spec.assertions,[]);assert.deepEqual(spec.extract,[]);
 assert.ok(item.outputTargets.length);assert.equal(spec.outcomeCandidates[0].selector,'#results');assert.equal(item.outputTargets[0].id,spec.outcomeCandidates[0].id);
 const publicList=JSON.stringify({source:plan.source,items:plan.items});assert.doesNotMatch(publicList,/#q|#go|selector|framePath|private-captured-current-value|private-live-result-data/);
});

test('frame and open-shadow locators remain exact, including their result target contexts',async t=>{
 const f=await saved(t),plan=await f.plan();
 const frame=Object.values(plan.specs).find(spec=>spec.steps.some(step=>step.param==='frameQuery'));
 const shadow=Object.values(plan.specs).find(spec=>spec.steps.some(step=>step.param==='shadowQuery'));
 assert.deepEqual(frame.steps[0].framePath,[0]);assert.equal(frame.steps[0].selector,'#fq');assert.deepEqual(frame.outcomeCandidates[0].framePath,[0]);
 assert.deepEqual(shadow.steps[0].framePath,[]);assert.equal(shadow.steps[0].selector,'#host >> #sq');assert.equal(shadow.outcomeCandidates[0].selector,'#host >> #shadowOut');
});

test('external form ownership is taken from actual el.form metadata rather than physical adjacency',async t=>{
 const f=await saved(t),plan=await f.plan(),spec=Object.values(plan.specs).find(spec=>spec.steps.some(step=>step.param==='outside'));
 assert.ok(spec);assert.equal(spec.steps[0].selector,'#external');assert.equal(spec.steps.at(-1).selector,'#externalGo');
});

test('excluded controls and sensitive login groups never become planned steps',async t=>{
 const f=await saved(t),plan=await f.plan();assert.ok(plan.counts.excludedControls>0);assert.ok(plan.gaps.includes('sensitive_group_omitted'));
 assert.doesNotMatch(JSON.stringify(plan.specs),/#excluded|#loginGo|loginQuery|"password"/);
});

test('succeeded text status and even paired action events never upgrade a parameterized candidate to ready',async t=>{
 const f=await saved(t,{success:true}),plan=await f.plan();assert.ok(plan.items.length);
 for(const item of plan.items){assert.equal(item.readiness,'candidate');assert.equal(item.evidence.parameterizationValidated,false);assert.ok(item.gaps.includes('input_parameterization_not_proven'));assert.ok(item.gaps.includes('two_distinct_samples_required'))}
});

test('readonly checkpoint journal adds inventory without mutating snapshots or append logs',async t=>{
 const f=await saved(t,{journal:true}),file=path.join(f.dir,'private/checkpoint.journal.jsonl'),before=await readFile(file);
 const plan=await f.plan();assert.ok(plan.items.length);assert.deepEqual(await readFile(file),before);
});

test('legacy inventory produces explicit missing-constraint gaps and does not guess required fields',async t=>{
 const actions=structuredClone(captured);for(const action of actions)delete action.htmlConstraints;
 const f=await saved(t,{actions}),plan=await f.plan(),item=plan.items.find(item=>Object.hasOwn(item.inputSchema.properties,'query'));
 assert.ok(item.gaps.includes('constraints_inventory_missing'));assert.equal(item.inputSchema.required,undefined);
});

test('missing result locators remain explicit gaps and no selector is invented',async t=>{
 const actions=structuredClone(captured);for(const action of actions)action.workflowOutputs=[];
 const f=await saved(t,{actions}),plan=await f.plan();assert.ok(plan.items.length);
 for(const item of plan.items){assert.deepEqual(item.outputTargets,[]);assert.ok(item.gaps.includes('output_locator_missing'));assert.deepEqual(plan.specs[item.id].assertions,[])}
});

test('original action and request policies are enforced rather than expanded by search labels',async t=>{
 const denied=await saved(t,{extra:{actionAllowlist:['#unrelated']}}),a=await denied.plan();assert.equal(a.items.length,0);assert.ok(a.gaps.includes('workflow_action_policy_rejected'));
 const controls=structuredClone(captured).map(action=>action.selector==='#go'?{...action,formAction:'https://outside.test/search',formMethod:'GET'}:action);
 const f=await saved(t,{actions:controls}),plan=await f.plan();assert.ok(!Object.values(plan.specs).some(spec=>spec.steps.at(-1).selector==='#go'));
 assert.ok(plan.gaps.includes('workflow_request_policy_rejected'));
});

test('same URL frame inventory outside navigation scope cannot create a workflow',async t=>{
 const controls=structuredClone(captured).map(action=>action.framePath?.length?{...action,frameUrl:'https://outside.test/'}:action);
 const f=await saved(t,{actions:controls}),plan=await f.plan();assert.ok(plan.gaps.includes('frame_outside_navigation_policy'));
 assert.ok(!Object.values(plan.specs).some(spec=>spec.steps.some(step=>step.framePath.length)));
});

test('bounded pagination preserves stable candidate IDs and private specs only for the returned page',async t=>{
 const f=await saved(t),first=await f.plan({limit:1}),second=await f.plan({offset:first.nextOffset,limit:1}),again=await f.plan({limit:1});
 assert.equal(first.items.length,1);assert.equal(Object.keys(first.specs).length,1);assert.equal(first.items[0].id,again.items[0].id);assert.equal(first.source.revision,again.source.revision);assert.notEqual(first.items[0].id,second.items[0].id);
 assert.ok(Buffer.byteLength(JSON.stringify(first.items))<98304);
});

test('unpaired state proof, malformed events and symlink evidence paths stay honest',async t=>{
 const f=await saved(t),events=path.join(f.dir,'private/events.jsonl');await writeFile(events,'{"kind":"state"');
 const plan=await f.plan();assert.equal(plan.items.length,0);assert.ok(plan.gaps.includes('malformed_events'));assert.ok(plan.gaps.includes('state_inventory_not_proven'));
 const outside=path.join(f.dir,'outside.json');await writeFile(outside,'{}');await rm(path.join(f.dir,'private/config.json'));await symlink(outside,path.join(f.dir,'private/config.json'));
 await assert.rejects(f.plan(),{code:'WORKFLOW_PATH_REJECTED'});
});

test('public candidate labels scrub trusted session values and sensitive option contracts are omitted',async t=>{
 const secret='opaque-session-value-763',credentialDir=await mkdtemp(path.join(os.tmpdir(),'workflow-session-'));t.after(()=>rm(credentialDir,{recursive:true,force:true}));
 const storageState=path.join(credentialDir,'state.json');await writeFile(storageState,JSON.stringify({cookies:[{name:'sid',value:secret,domain:'127.0.0.1',path:'/',secure:false,httpOnly:true,expires:-1}],origins:[]}));
 const actions=structuredClone(captured);actions.find(action=>action.selector==='#q').associatedLabel='查询 '+secret;
 const f=await saved(t,{actions,extra:{storageState}}),plan=await f.plan();assert.ok(plan.items.some(item=>Object.hasOwn(item.inputSchema.properties,'query')));assert.doesNotMatch(JSON.stringify(plan.items),new RegExp(secret));
 const risky=structuredClone(actions);risky.find(action=>action.selector==='#kind').options=[{value:secret,label:'choice'}];
 const g=await saved(t,{actions:risky,extra:{storageState}}),next=await g.plan();assert.ok(next.gaps.includes('sensitive_parameter_contract_omitted'));assert.doesNotMatch(JSON.stringify(next.items),new RegExp(secret));
});


test('non-ASCII, underscore and digit-start HTML names receive callable safe parameter aliases',async t=>{
 for(const name of ['查询','_query','1query','__proto__']){
  const actions=structuredClone(captured);actions.find(action=>action.selector==='#q').name=name;
  const f=await saved(t,{actions}),plan=await f.plan(),spec=Object.values(plan.specs).find(item=>item.steps.some(step=>step.selector==='#q'));
  assert.ok(spec);const bound=spec.steps.find(step=>step.selector==='#q').param;assert.match(bound,/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);assert.ok(Object.hasOwn(spec.inputSchema.properties,bound));assert.notEqual(bound,'__proto__');
 }
});

test('multiple result targets expose scrubbed static labels but never selector or id fallback labels',async t=>{
 const secret='opaque-result-label-795',actions=structuredClone(captured),button=actions.find(action=>action.selector==='#go');
 button.workflowOutputs=[{selector:'#result-private-a',tag:'output',labelSource:'aria',label:'查询摘要 '+secret},{selector:'#result-private-b',tag:'output',labelSource:'title',label:'筛选结果'},{selector:'#result-private-c',tag:'output',labelSource:'id',label:'result-private-c'}];
 const f=await saved(t,{actions,extra:{authInject:{headers:{'X-Private':secret}},credentialOrigins:[origin]}}),plan=await f.plan(),item=plan.items.find(item=>item.inputSchema.properties.query);
 assert.equal(item.outputTargets[0].label,'查询摘要 [REDACTED]');assert.equal(item.outputTargets[1].label,'筛选结果');assert.equal(item.outputTargets[2].label,'结果区域');
 const publicText=JSON.stringify(item);assert.doesNotMatch(publicText,/opaque-result-label-795|result-private-a|result-private-b|result-private-c|selector/);
});
