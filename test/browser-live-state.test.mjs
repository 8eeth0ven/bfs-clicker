import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {bindLiveState} from '../src/browser-live-state.js';
import {normalizeConfig} from '../src/asset.js';
import {createPolicy} from '../src/policy.js';
import {collectInteractives} from '../src/discover.js';
import {runAsset} from '../src/runner.js';
import {closedDescriptor,closedLocator,beginClosedExplorationGeneration,resetClosedShadow} from '../src/closed-shadow.js';
import {temp,fixture,document,config,readRun} from './helpers.mjs';

const VALUES=['one','two','three','four','five','six','seven','eight','nine','ten'];
const policy={id:'wizard',hosts:['#host'],maxNodes:128};
function save(name,value){if(!process.env.BFS_LIVE_STATE_EVIDENCE_DIR)return;mkdirSync(process.env.BFS_LIVE_STATE_EVIDENCE_DIR,{recursive:true,mode:0o700});writeFileSync(path.join(process.env.BFS_LIVE_STATE_EVIDENCE_DIR,name+'.json'),JSON.stringify(value,null,2)+'\n',{mode:0o600});}
async function wizard(t,{mode='dom',stages=2,onReady='',onSubmit='',extraHtml='',onRequest,cold=false,hostRebuild=false,onFocus=''}={}){
 const business=[];
 const site=await fixture(t,async({url},request)=>{
  if(url.pathname==='/api/stage'){
   let text='';for await(const chunk of request)text+=chunk;const body=JSON.parse(text);business.push(body);onRequest?.(body);
   return {type:'application/json',body:JSON.stringify({ok:true,stage:body.stage})};
  }
  if(url.pathname==='/side'||url.pathname==='/reports/side')return {body:document('Independent seed','<p>side</p>')};
  const markup=stage=>`<section id="phase${stage}" role="search"><h2>Phase ${stage}</h2><input id="field${stage}" aria-label="Field ${stage}"><button id="next${stage}" type="button">Search stage ${stage}</button></section>`;
  const setup=mode==='dom'?"let scope=document.querySelector('#flow');":`let scope=document.querySelector('#host').attachShadow({mode:${JSON.stringify(mode)}});`;
  const script=`${setup}const typed=[];
   function render(stage){
    ${hostRebuild&&mode!=='dom'?`if(stage>1){const old=document.querySelector('#host'),fresh=old.cloneNode();old.replaceWith(fresh);scope=fresh.attachShadow({mode:${JSON.stringify(mode)}});}`:''}
    scope.innerHTML=${JSON.stringify(Array.from({length:stages},(_,i)=>markup(i+1)))}[stage-1];
    scope.querySelector('#field'+stage).oninput=()=>typed.push(stage);scope.querySelector('#field'+stage).onfocus=()=>{${onFocus}};
    scope.querySelector('#next'+stage).onclick=async()=>{
     const body={stage,value:scope.querySelector('#field'+stage).value,typed:[...typed]};
     await fetch('/api/stage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
     ${onSubmit}
     if(stage<${stages}){render(stage+1);${onReady}}
     else scope.innerHTML='<p id="done" role="status">Completed '+stage+'</p>';
    };
   }
   ${cold?"scope.innerHTML='<button id=begin type=button>Start</button>';scope.querySelector('#begin').onclick=()=>render(1);":"render(1);"}`;
  return {body:document('Live wizard',extraHtml+(mode==='dom'?'<div id="flow"></div>':'<div id="host"></div>'),script)};
 });
 const selector=name=>mode==='closed'?closedDescriptor(policy,'#'+name).selector:(mode==='open'?'#host >> ':'')+'#'+name;
 return {...site,business,selector,mode,stages,cold};
}
function settings(site,dir,extra={}){
 return config(site.origin,dir,{actionProfile:'forms',fillText:true,formValues:Object.fromEntries(Array.from({length:site.stages},(_,index)=>[site.selector('field'+(index+1)),VALUES[index]])),actionAllowlist:[...(site.cold?[site.selector('begin')]:[]),...Array.from({length:site.stages},(_,index)=>[site.selector('field'+(index+1)),site.selector('next'+(index+1))]).flat()],requestAllowlist:[{method:'POST',url:site.origin+'/api/stage'}],closedShadowRoots:site.mode==='closed'?[policy]:[],shotFormat:'none',exploreHover:false,exploreScroll:false,maxStates:16,maxDepth:12,maxActions:50,maxDurationMs:20000,maxRetries:0,requestDelayMs:0,...extra});
}
const run=input=>runAsset(input,{log(){}});

for(const mode of ['dom','open','closed'])test(mode+' two-stage form continues its actual observed child without replaying submit',{timeout:30000},async t=>{
 const dir=temp(t),site=await wizard(t,{mode}),result=await run(settings(site,dir)),data=readRun(dir);
 save(mode+'-two-stage',{status:result.status,stopReason:result.stopReason,business:site.business,actions:result.counts.actions,paths:data.cp.states.map(state=>({id:state.id,path:state.path.map(step=>({selector:step.selector,safeReplay:step.safeReplay})),pending:state.interactives.filter(a=>a.status==='planned').length})),gaps:result.coverageGaps});
 assert.equal(result.status,'completed',result.stopReason);
 assert.deepEqual(site.business,[{stage:1,value:'one',typed:[1]},{stage:2,value:'two',typed:[1,2]}]);
 assert.equal(result.counts.actions,4);assert.equal(data.events.filter(event=>event.kind==='action_replay').length,0);
 assert(data.cp.states.slice(1).every(state=>state.path.some(step=>step.safeReplay===false)));
});

for(const mode of ['dom','open','closed'])test(mode+' cold Start and three rebuilt forms continue within the original user budgets',{timeout:30000},async t=>{
 const dir=temp(t),site=await wizard(t,{mode,stages:3,cold:true,hostRebuild:true}),result=await run(settings(site,dir)),data=readRun(dir);
 save(mode+'-cold-rebuilt',{status:result.status,business:site.business,actions:result.counts.actions,generations:data.events.filter(event=>event.kind==='closed_shadow_exploration_generation').map(({previousCalls,candidateCalls,callLimit})=>({previousCalls,candidateCalls,callLimit})),failures:data.cp.states.flatMap(s=>s.interactives.filter(a=>a.status==='failed'||a.status==='skipped').map(a=>({state:s.id,selector:a.selector,reason:a.reason}))),gaps:result.coverageGaps});
 assert.equal(result.status,'completed',result.stopReason);assert.deepEqual(site.business.map(({stage,value,typed})=>[stage,value,typed]),[[1,'one',[1]],[2,'two',[1,2]],[3,'three',[1,2,3]]]);
 assert.equal(result.counts.actions,7);assert.equal(data.events.filter(event=>event.kind==='action_replay').length,0);
 assert(data.cp.states.slice(1).filter(state=>state.interactives.length).every(state=>state.liveOnly?.requiresLiveLease===true));
});

async function pages(t,mode){
 const business=[];const site=await fixture(t,async({url,method},request)=>{
  if(method==='POST'){let raw='';for await(const chunk of request)raw+=chunk;const body=Object.fromEntries(new URLSearchParams(raw));business.push({stage:Number(url.pathname.at(-1)),value:body.query,typed:Number(body.typed)});return {status:303,headers:{location:url.pathname==='/post1'?'/phase2':'/done'}};}
  if(url.pathname==='/done')return {body:document('Done','<p>Completed</p>')};
  const stage=url.pathname==='/phase2'?2:1;
  const markup=`<form id="phase${stage}" method="post" action="/post${stage}"><h2>Phase ${stage}</h2><input id="field${stage}" name="query" aria-label="Field ${stage}"><input name="typed" type="hidden" value="0"><button id="next${stage}" type="submit">Search stage ${stage}</button></form>`;
  const setup=mode==='dom'?"const scope=document.querySelector('#flow');":`const scope=document.querySelector('#host').attachShadow({mode:${JSON.stringify(mode)}});`;
  return {body:document('Page '+stage,mode==='dom'?'<div id="flow"></div>':'<div id="host"></div>',`${setup}scope.innerHTML=${JSON.stringify(markup)};scope.querySelector('#field${stage}').oninput=()=>scope.querySelector('[name=typed]').value++;`)};
 });
 const selector=name=>mode==='open'?'#host >> #'+name:'#'+name;return {...site,mode,stages:2,business,selector};
}
for(const mode of ['dom','open'])test(mode+' permitted native form POST and new document establish a fresh post-state lease',{timeout:30000},async t=>{
 const dir=temp(t),site=await pages(t,mode),result=await run(settings(site,dir,{requestAllowlist:[{method:'POST',url:site.origin+'/post1'},{method:'POST',url:site.origin+'/post2'}]})),data=readRun(dir);
 save(mode+'-cross-document',{status:result.status,business:site.business,actions:result.counts.actions,gaps:result.coverageGaps});
 assert.equal(result.status,'completed',result.stopReason);assert.deepEqual(site.business,[{stage:1,value:'one',typed:1},{stage:2,value:'two',typed:1}]);assert.equal(result.counts.actions,4);assert.equal(data.events.filter(event=>event.kind==='action_replay').length,0);
 assert(data.cp.states.some(state=>state.url.endsWith('/phase2')&&state.liveOnly?.requiresLiveLease));
});

for(const [limit,value,expected,requests] of [['maxActions',3,'max_actions',1],['maxDepth',1,'max_depth',1],['maxStates',2,'max_states',1]])test(limit+' remains authoritative across live priority',{timeout:30000},async t=>{
 const dir=temp(t),site=await wizard(t),result=await run(settings(site,dir,{[limit]:value}));assert.equal(result.status,'partial');assert.equal(result.stopReason,expected);assert.equal(site.business.length,requests);assert((result.counts.actions||0)<=3);
});

test('STOP after a real submit is unknown and resume never repeats it or continues its unleased child',{timeout:30000},async t=>{
 const dir=temp(t),site=await wizard(t,{onRequest:()=>writeFileSync(path.join(dir,'STOP'),'')});const input=settings(site,dir,{maxRetries:3});
 const first=await run(input);assert.equal(first.status,'partial');assert.equal(site.business.length,1);
 const second=await runAsset(input,{resume:true,log(){}}),data=readRun(dir);assert.equal(site.business.length,1);assert.equal(second.status,'partial');
 assert(data.cp.states.flatMap(state=>state.interactives).filter(action=>action.attempts>0&&action.status!=='succeeded').every(action=>action.noRetry));
 assert(data.events.some(event=>event.kind==='coverage_gap'&&event.reason==='live_state_unavailable'));
});

test('resume after a successful transition cannot recreate a memory-only child lease',{timeout:30000},async t=>{
 const dir=temp(t),site=await wizard(t),input=settings(site,dir,{maxDepth:1}),first=await run(input);assert.equal(first.stopReason,'max_depth');assert.equal(site.business.length,1);
 const resumed=await runAsset({...input,maxDepth:12},{resume:true,log(){}});assert.equal(resumed.status,'partial');assert.equal(site.business.length,1);assert(resumed.coverageGaps.some(gap=>gap.reason==='unsafe_replay_requires_manual_state'));
});

test('seed navigation consumes a child lease rather than continuing an empty reconstructed form',{timeout:30000},async t=>{
 const dir=temp(t),site=await wizard(t,{cold:true,extraHtml:'<a hidden href="/side">Independent seed</a>'}),result=await run(settings(site,dir,{seedInterleaveActions:1,discoverySeeds:true}));
 save('seed-loss',{status:result.status,business:site.business,gaps:result.coverageGaps});assert.equal(result.status,'partial');assert.equal(site.business.length,0);assert(site.requests.some(request=>request.url.pathname==='/side'));assert(result.coverageGaps.some(gap=>['live_state_unavailable','unsafe_replay_requires_manual_state'].includes(gap.reason)));
});

async function leaseFixture(t){
 const site=await fixture(t,()=>({body:document('Pinned child','<form id="owner" action="/first"><input id="query" aria-label="Query"><button id="search" type="button">Search</button></form>')}));
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.goto(site.origin);
 const cfg=normalizeConfig(config(site.origin,temp(t),{actionProfile:'forms',fillText:true,formValues:{'#query':'one'},actionAllowlist:['#query','#search'],requestAllowlist:[{method:'POST',url:site.origin+'/first'}]}));cfg._policy=createPolicy(cfg,()=>{});
 const state={id:2,interactives:(await collectInteractives(page,cfg)).map((action,index)=>({...action,kind:'click',id:String(index),status:'planned'}))};
 const lease=await bindLiveState(page,state,cfg);t.after(()=>lease.dispose());await lease.verify(state.interactives[0]);return {page,lease,state};
}
for(const [name,mutate] of [
 ['body replacement',page=>page.evaluate(()=>document.body.replaceWith(document.body.cloneNode(true)))],
 ['same-id control replacement',page=>page.evaluate(()=>{const node=document.querySelector('#search');node.replaceWith(node.cloneNode(true));})],
 ['owner submit semantics',page=>page.evaluate(()=>document.querySelector('#owner').action='/second')],
 ['unsignalled input value',page=>page.evaluate(()=>document.querySelector('#query').value='changed')],
 ['same-URL reload',page=>page.reload()],
])test(name+' invalidates a child lease before a following primitive',{timeout:15000},async t=>{const {page,lease,state}=await leaseFixture(t);await mutate(page);await assert.rejects(lease.verify(state.interactives[1]),/live_state_unavailable/);});

test('new checkpoint lease markers contain no input values, receipt digests or browser handles',{timeout:30000},async t=>{
 const dir=temp(t),site=await wizard(t),secret='private-preparation-92837';await run(settings(site,dir,{formValues:{[site.selector('field1')]:secret,[site.selector('field2')]:'two'}}));
 const data=readRun(dir),markers=data.cp.states.map(state=>state.liveOnly).filter(Boolean);assert(markers.length);for(const marker of markers)assert.deepEqual(Object.keys(marker).sort(),['actionId','outcome','parentId','requiresLiveLease','schemaVersion']);
 const publicEvents=readFileSync(path.join(dir,'events.jsonl'),'utf8');assert(!publicEvents.split('\n').filter(Boolean).map(JSON.parse).filter(event=>event.kind.startsWith('live_state')||event.kind.startsWith('input_prefix')).some(event=>JSON.stringify(event).includes(secret)));assert(!JSON.stringify(data.cp.states).includes(secret));assert(!/backendNodeId|objectId|ElementHandle/.test(JSON.stringify(markers)));
});

test('a same-state click consumes the child lease, so a second hidden-state-dependent click is not dispatched',{timeout:20000},async t=>{
 const calls=[],site=await fixture(t,async({url},request)=>{if(url.pathname==='/api/click'){let raw='';for await(const chunk of request)raw+=chunk;calls.push(raw);return {type:'application/json',body:'{}'};}return {body:document('Same state','<div id="flow"><button id="start">Start</button></div>',"document.querySelector('#start').onclick=()=>{document.querySelector('#flow').innerHTML='<h2>Child</h2><button id=first>First</button><button id=second>Second</button>';for(const id of ['first','second'])document.querySelector('#'+id).onclick=()=>fetch('/api/click',{method:'POST',body:id});};")};});
 const dir=temp(t),result=await run(config(site.origin,dir,{actionProfile:'forms',actionAllowlist:['#start','#first','#second'],requestAllowlist:[{method:'POST',url:site.origin+'/api/click'}],exploreHover:false,exploreScroll:false}));
 assert.equal(result.status,'partial');assert.deepEqual(calls,['first']);assert.equal(result.counts.actions,2);assert(result.coverageGaps.some(gap=>gap.reason==='unsafe_replay_requires_manual_state'));
});

test('post-result still-clickable controls retain per-state exploration semantics, distinct from unsafe path replay',{timeout:20000},async t=>{
 const calls=[],site=await fixture(t,async({url},request)=>{if(url.pathname==='/api/click'){let raw='';for await(const chunk of request)raw+=chunk;calls.push(raw);return {type:'application/json',body:'{}'};}return {body:document('Result states','<button id="search">Search</button><p id="result">Before</p>',"document.querySelector('#search').onclick=async()=>{await fetch('/api/click',{method:'POST',body:'intent'});document.querySelector('#result').textContent='After';};")};});
 const dir=temp(t),result=await run(config(site.origin,dir,{actionProfile:'forms',actionAllowlist:['#search'],requestAllowlist:[{method:'POST',url:site.origin+'/api/click'}],exploreHover:false,exploreScroll:false}));
 assert.equal(result.status,'completed');assert.deepEqual(calls,['intent','intent']);assert.equal(readRun(dir).events.filter(event=>event.kind==='action_replay').length,0);
});

test('closed focus-time host replacement is unknown and never becomes a new authorized exploration generation',{timeout:20000},async t=>{
 const dir=temp(t),site=await wizard(t,{mode:'closed',onFocus:"if(stage===1){const old=document.querySelector('#host'),fresh=old.cloneNode();old.replaceWith(fresh);fresh.attachShadow({mode:'closed'}).innerHTML='<button id=next1>Search stage 1</button>'; }"}),result=await run(settings(site,dir,{maxRetries:3})),data=readRun(dir);
 assert.equal(result.status,'partial');assert.equal(site.business.length,0);assert.equal(data.events.filter(event=>event.kind==='closed_shadow_exploration_generation').length,0);assert(data.cp.states[0].interactives.find(action=>action.selector.endsWith('::#field1')).noRetry);
});

test('read-only closed generation cannot issue UI and rollback retains original target leases',{timeout:20000},async t=>{
 const site=await wizard(t,{mode:'closed'}),browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.goto(site.origin);
 const cfg=normalizeConfig(settings(site,temp(t)));cfg._policy=createPolicy(cfg,()=>{});const target={...closedDescriptor(policy,'#next1'),type:'click',tag:'button',kind:'click'};
 const old=closedLocator(page,target,cfg);await old.identity();const candidate=await beginClosedExplorationGeneration(page,cfg);
 await assert.rejects(closedLocator(page,target,cfg).click(),error=>error.code==='CLOSED_SHADOW_READ_ONLY_GENERATION');await candidate.dispose();assert.equal(await old.count(),1);assert.equal(site.business.length,0);
});

for(const mode of ['dom','open','closed'])test(mode+' visible old Start is deferred while same-id rebuilt Next belongs to the new form',{timeout:30000},async t=>{
 const payloads=[],site=await fixture(t,async({url},request)=>{if(url.pathname==='/api/query'){let raw='';for await(const block of request)raw+=block;payloads.push(JSON.parse(raw));return {type:'application/json',body:'{}'};}const setup=mode==='dom'?"const scope=document.querySelector('#flow');":`const scope=document.querySelector('#host').attachShadow({mode:${JSON.stringify(mode)}});`;return {body:document('Retained Start',mode==='dom'?'<div id="flow"></div>':'<div id="host"></div>',`${setup}scope.innerHTML='<button id=start>Start</button><div id=forms></div>';const values=[];function form(stage){scope.querySelector('#forms').innerHTML='<section role=search id=group'+stage+'><h2>Phase '+stage+'</h2><input id=field'+stage+' aria-label="Field '+stage+'"><button id=next>Next</button></section>';scope.querySelector('#next').onclick=async()=>{values.push(scope.querySelector('#field'+stage).value);if(stage<2)form(stage+1);else{await fetch('/api/query',{method:'POST',body:JSON.stringify(values)});scope.querySelector('#forms').innerHTML='<p>Done</p>';}};}scope.querySelector('#start').onclick=()=>form(1);`)};});
 const selector=id=>mode==='closed'?closedDescriptor(policy,'#'+id).selector:(mode==='open'?'#host >> ':'')+'#'+id,dir=temp(t),result=await run(config(site.origin,dir,{actionProfile:'forms',fillText:true,formValues:{[selector('field1')]:'one',[selector('field2')]:'two'},actionAllowlist:['start','field1','field2','next'].map(selector),requestAllowlist:[{method:'POST',url:site.origin+'/api/query'}],closedShadowRoots:mode==='closed'?[policy]:[],exploreHover:false,exploreScroll:false,maxActions:5,maxStates:8})),data=readRun(dir);
 // Five real primitives finish the wizard. A subsequent repeatable Start is
 // pending at the global action bound; it cannot steal either new Next.
 assert.deepEqual(payloads,[['one','two']]);assert.equal(result.stopReason,'max_actions');assert.equal(result.counts.actions,5);assert.equal(data.events.filter(event=>event.kind==='action_replay').length,0);
 save(mode+'-same-name-next',{status:result.status,stopReason:result.stopReason,payloads,actions:result.counts.actions});
});

test('post-state inventories do not copy a still-visible prepared input value into checkpoints or action events',{timeout:20000},async t=>{
 const privateValue='owned-value-17482093',site=await fixture(t,()=>({body:document('Value stays private','<section role="search"><input id="query" aria-label="Query"><button id="search">Search</button></section><p id="result">Before</p>',"document.querySelector('#search').onclick=()=>document.querySelector('#result').textContent='After';")})),dir=temp(t);
 await run(config(site.origin,dir,{actionProfile:'forms',fillText:true,formValues:{'#query':privateValue},actionAllowlist:['#query','#search'],requestAllowlist:[{method:'POST',url:site.origin+'/api/unused'}],maxDepth:1,exploreHover:false,exploreScroll:false}));
 const data=readRun(dir);assert(data.cp.states.length>1);assert(!JSON.stringify(data.cp.states).includes(privateValue));
 for(const event of data.events.filter(event=>/^action_|^live_state|^input_prefix/.test(event.kind)))assert(!JSON.stringify(event).includes(privateValue));
});

test('ordinary replayable BFS siblings retain order around one live-only child chain',{timeout:20000},async t=>{
 const site=await fixture(t,({url})=>{if(url.pathname==='/a')return {body:document('A','<a href="/a/deep">Read A deep</a>')};if(url.pathname==='/b')return {body:document('B','<a href="/b/deep">Read B deep</a>')};if(url.pathname.endsWith('/deep'))return {body:document('Leaf','<p>Done</p>')};return {body:document('Root','<a href="/a">Read A</a><a href="/b">Read B</a><form action="/allowed-unused"><button id="start" type="button">Start</button></form><div id="slot"></div>',"document.querySelector('#start').onclick=()=>{document.querySelector('#start').remove();document.querySelector('#slot').innerHTML='<h2>New child</h2><button id=next>Next</button>';document.querySelector('#next').onclick=()=>{document.querySelector('#slot').innerHTML='<p>Done child</p>';};};")};});
 const dir=temp(t),result=await run(config(site.origin,dir,{actionProfile:'safe',actionAllowlist:['#start','#next'],requestAllowlist:[{method:'POST',url:site.origin+'/api/unused'}],exploreHover:false,exploreScroll:false})),data=readRun(dir);
 const expansions=data.events.filter(event=>event.kind==='action_started').map(event=>{const state=data.cp.states.find(state=>state.id===event.stateId);return new URL(state.url).pathname;});
 assert(data.cp.states.find(state=>state.url.endsWith('/a')).path.every(step=>step.safeReplay===true));assert(data.cp.states.some(state=>state.path.some(step=>step.selector==='#start'&&step.safeReplay===false)));assert(expansions.indexOf('/a')>=0);assert(expansions.indexOf('/b')>expansions.indexOf('/a'));assert(data.cp.states.some(state=>state.path.some(step=>step.selector==='#next')));assert(!['failed','running'].includes(result.status));
});

for(const mode of ['commit-old-detach','rollback-candidate-detach','first-candidate-rollback-detach'])test(mode+' failure poisons the page backend and cannot create another authorized generation',{timeout:15000},async t=>{
 const site=await wizard(t,{mode:'closed'}),browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.goto(site.origin);
 const cfg=normalizeConfig(settings(site,temp(t)));cfg._policy=createPolicy(cfg,()=>{});const target={...closedDescriptor(policy,'#next1'),type:'click',tag:'button',kind:'click'},context=page.context(),create=context.newCDPSession.bind(context);let attachments=0;
 context.newCDPSession=async owner=>{const session=await create(owner),index=++attachments;if(index===(mode==='rollback-candidate-detach'?2:1))session.detach=async()=>{throw new Error('synthetic detach failure');};return session;};
 if(mode!=='first-candidate-rollback-detach')assert.equal(await closedLocator(page,target,cfg).count(),1);
 const candidate=await beginClosedExplorationGeneration(page,cfg);
 await assert.rejects(mode==='commit-old-detach'?candidate.commit():candidate.dispose(),{code:'CLOSED_SHADOW_CLEANUP_FAILED'});
 const before=attachments;await assert.rejects(closedLocator(page,target,cfg).click(),{code:'CLOSED_SHADOW_CLEANUP_FAILED'});await assert.rejects(resetClosedShadow(page),{code:'CLOSED_SHADOW_CLEANUP_FAILED'});
 await assert.rejects(beginClosedExplorationGeneration(page,cfg));assert.equal(attachments,before);assert.equal(site.business.length,0);
 save(mode,{status:'passed',scope:'real_local_chromium_with_controlled_CDP_detach_failure',attachments,additionalAttachmentsAfterFailure:attachments-before,businessRequests:0,resetAndUiRefused:true});
});
