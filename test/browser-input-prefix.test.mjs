import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFileSync,mkdirSync} from 'node:fs';
import {runAsset} from '../src/runner.js';
import {closedDescriptor} from '../src/closed-shadow.js';
import {normalizeConfig} from '../src/asset.js';
import {openStore} from '../src/store.js';
import {clickElement,replayPath} from '../src/replay.js';
import {temp,fixture,document,config,readRun} from './helpers.mjs';

async function inputSite(t,{closed=false,fields=2,onInput='',onQuery='',extraHtml='',middle='',firstAttributes='',auditInputs=false,onTyped,noSubmit=false}={}){
 const submissions=[],typed=[];
 const site=await fixture(t,async({url},request)=>{
  if(url.pathname==='/api/typed'){
   let body='';for await(const chunk of request)body+=chunk;
   typed.push(JSON.parse(body));onTyped?.(typed.at(-1));return {type:'application/json',body:'{}'};
  }
  if(url.pathname==='/side')return {body:document('Side route','<p>Seed</p>')};
  if(url.pathname==='/api/search'){
   let body='';for await(const chunk of request)body+=chunk;
   submissions.push(JSON.parse(body));
   return {type:'application/json',body:'{"ok":true}'};
  }
  const controls='<section role="search"><input id="first" aria-label="First" '+firstAttributes+'>'+(fields===2?'<input id="second" aria-label="Second">':'')+middle+(noSubmit?'':'<button id="search">Search</button>')+'</section>';
  return {body:document('Input prefix',extraHtml+(closed?'<div id="widget"></div>':controls),
   `${closed?`const scope=document.querySelector('#widget').attachShadow({mode:'closed'});scope.innerHTML=${JSON.stringify(controls)};`:'const scope=document;'}
    const events=[];for(const input of scope.querySelectorAll('input'))input.addEventListener('input',()=>{events.push(input.id);${auditInputs?"fetch('/api/typed',{method:'POST',body:JSON.stringify({id:input.id,value:input.value})});":''}${onInput}});
    if(scope.querySelector('#search'))scope.querySelector('#search').onclick=()=>{${onQuery}fetch('/api/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({first:scope.querySelector('#first').value,second:scope.querySelector('#second')?.value??null,events})});};`)};
 });return {...site,submissions,typed};
}
function settings(site,dir,{closed=false,fields=2,...extra}={}){
 const policy={id:'form',hosts:['#widget'],maxNodes:32};
 const selector=id=>closed?closedDescriptor(policy,'#'+id).selector:'#'+id;
 return config(site.origin,dir,{actionProfile:'forms',fillText:true,formValues:{[selector('first')]:'left',...(fields===2?{[selector('second')]:'right'}:{})},actionAllowlist:['first',...(fields===2?['second']:[]),'search'].map(selector),requestAllowlist:[{method:'POST',url:site.origin+'/api/search'},{method:'POST',url:site.origin+'/api/typed'}],closedShadowRoots:closed?[policy]:[],exploreHover:false,exploreScroll:false,shotFormat:'none',maxStates:4,maxDepth:2,maxActions:20,requestDelayMs:0,maxRetries:0,...extra});
}
const run=input=>runAsset(input,{log(){}});
function expected(fields){return {first:'left',second:fields===2?'right':null,events:fields===2?['first','second']:['first']};}
function evidence(name,value){if(!process.env.BFS_INPUT_PREFIX_EVIDENCE_DIR)return;mkdirSync(process.env.BFS_INPUT_PREFIX_EVIDENCE_DIR,{recursive:true,mode:0o700});writeFileSync(path.join(process.env.BFS_INPUT_PREFIX_EVIDENCE_DIR,name+'.json'),JSON.stringify(value,null,2)+'\n',{mode:0o600});}

for(const [label,closed,fields] of [['ordinary DOM single field',false,1],['ordinary DOM two sequential fields',false,2],['author-closed two sequential fields',true,2]]){
 test(label+' preserves exact configured input effects before the business request',{timeout:30000},async t=>{
  const dir=temp(t),site=await inputSite(t,{closed,fields}),result=await run(settings(site,dir,{closed,fields}));
  assert.equal(result.status,'completed',result.stopReason);
  assert.deepEqual(site.submissions,[expected(fields)]);
  const data=readRun(dir),actions=data.cp.states[0].interactives.filter(action=>action.status==='succeeded');
  assert.equal(actions.length,fields+1);assert(actions.every(action=>action.attempts===1));
  const prefixes=data.events.filter(event=>event.kind.startsWith('input_prefix'));
  assert(prefixes.length);assert(!JSON.stringify(prefixes).includes('left'));assert(!JSON.stringify(data.cp.states).includes('left'));
  evidence((closed?'closed':'dom')+'-'+fields,{status:result.status,submissions:site.submissions,markers:data.cp.states[0].inputPrefixes,prefixEvents:prefixes});
 });
}

for(const closed of [false,true])for(const [label,mutation] of [
 ['same-name same-value element replacement',"const first=scope.querySelector('#first');first.replaceWith(first.cloneNode(true));"],
 ['constraint drift',"scope.querySelector('#first').maxLength=19;"],
 ['fresh ancestor exclusion',"scope.querySelector('#first').parentElement.className='blocked';"],
])test((closed?'closed':'DOM')+' rejects '+label+' before submitting',{timeout:30000},async t=>{
 const dir=temp(t),site=await inputSite(t,{closed,onInput:`if(input.id==='second'){${mutation}}`});
 const result=await run(settings(site,dir,{closed,excludeSelectors:['.blocked']})),data=readRun(dir);
 assert.equal(result.status,'partial');assert.deepEqual(site.submissions,[]);
 assert(data.events.some(event=>event.kind==='coverage_gap'&&event.reason==='input_prefix_unavailable'));
 evidence((closed?'closed':'dom')+'-'+label.replaceAll(' ','-'),{status:result.status,submissions:site.submissions,gaps:data.meta.coverageGaps});
});

test('seed interleaving loses the live lease explicitly rather than submitting an empty restored form',{timeout:30000},async t=>{
 const dir=temp(t),site=await inputSite(t,{extraHtml:'<a hidden href="/side">Seed route</a>'});
 const result=await run(settings(site,dir,{seedInterleaveActions:1,discoverySeeds:true})),data=readRun(dir);
 assert.equal(result.status,'partial');assert.equal(site.submissions.length,0);
 assert(site.requests.some(request=>request.url.pathname==='/side'));
 assert(data.meta.coverageGaps.some(gap=>gap.reason==='input_prefix_unavailable'));
});

test('completed text preparation is not retyped or submitted from a restored page on resume',{timeout:30000},async t=>{
 const dir=temp(t),site=await inputSite(t,{auditInputs:true}),cfg=settings(site,dir,{maxActions:1});
 const first=await run(cfg);assert.equal(first.stopReason,'max_actions');assert.deepEqual(site.typed,[{id:'first',value:'left'}]);
 const resumed=await runAsset({...cfg,maxActions:20},{resume:true,log(){}});
 assert.equal(resumed.status,'partial');assert.deepEqual(site.typed,[{id:'first',value:'left'}]);assert.deepEqual(site.submissions,[]);
 assert(resumed.coverageGaps.some(gap=>gap.reason==='input_prefix_unavailable'));
});

test('an attempted nonclosed text operation stopped mid-action never auto-retries on resume, including legacy marker-free checkpoints',{timeout:30000},async t=>{
 const dir=temp(t),runDir=path.join(dir,'first'),site=await inputSite(t,{auditInputs:true,onTyped:()=>writeFileSync(path.join(runDir,'STOP'),'')});
 const cfg=settings(site,runDir),first=await run(cfg),saved=readRun(runDir);
 assert.equal(first.stopReason,'STOP');assert.deepEqual(site.typed,[{id:'first',value:'left'}]);
 const action=saved.cp.states[0].interactives.find(item=>item.selector==='#first');assert.equal(action.noRetry,true);
 const resumed=await runAsset(cfg,{resume:true,log(){}});assert.equal(resumed.status,'partial');assert.deepEqual(site.typed,[{id:'first',value:'left'}]);assert.deepEqual(site.submissions,[]);
 for(const status of ['running','succeeded']){
  const legacyDir=path.join(dir,'legacy-'+status),legacyConfig=settings(site,legacyDir),store=openStore(normalizeConfig(legacyConfig));
  const legacy=structuredClone(saved.cp);delete legacy.states[0].inputPrefixes;const legacyAction=legacy.states[0].interactives.find(item=>item.selector==='#first');legacyAction.status=status;delete legacyAction.noRetry;
  try{store.save(legacy);store.update({status:'partial'});}finally{store.release();}
  const replay=await runAsset(legacyConfig,{resume:true,log(){}});assert.equal(replay.status,'partial');assert.deepEqual(site.typed,[{id:'first',value:'left'}]);assert.deepEqual(site.submissions,[]);
 }
});

for(const mode of ['click','hover'])test('same-state '+mode+' does not authorize later hidden-state reuse',{timeout:30000},async t=>{
 const dir=temp(t),site=await inputSite(t,mode==='click'?{middle:'<button id="middle" onclick="window.hiddenMode=1">View mode</button>'}:{firstAttributes:'data-bfs-hover onmouseover="window.hiddenMode=1"'});
 const result=await run(settings(site,dir,{exploreHover:mode==='hover'}));assert.equal(result.status,'partial');assert.deepEqual(site.submissions,[]);
 assert(result.coverageGaps.some(gap=>gap.reason==='input_prefix_unavailable'));
});

test('a changed child path records both actual input steps and keeps them unsafe for replay',{timeout:30000},async t=>{
 const dir=temp(t),site=await inputSite(t,{onQuery:"const result=document.createElement('p');result.textContent='new result';document.body.append(result);"});
 const result=await run(settings(site,dir)),data=readRun(dir);assert.equal(result.status,'partial');assert.deepEqual(site.submissions,[expected(2)]);
 const child=data.cp.states.find(state=>state.path.at(-1)?.selector==='#search');assert(child);
 assert.deepEqual(child.path.map(step=>step.selector),['#first','#second','#search']);assert(child.path.every(step=>step.safeReplay===false));
 assert(data.events.some(event=>event.kind==='coverage_gap'&&event.reason==='unsafe_replay_requires_manual_state'));
});

test('live preparation continuity remains correct when optional general resident-state reuse is disabled',{timeout:30000},async t=>{
 const dir=temp(t),site=await inputSite(t),result=await run(settings(site,dir,{reuseVerifiedState:false}));
 assert.equal(result.status,'completed');assert.deepEqual(site.submissions,[expected(2)]);assert.equal(result.performance.stateReuses,0);
});

for(const closed of [false,true])test((closed?'closed':'DOM')+' full reload never receives permission from old input receipts',{timeout:30000},async t=>{
 const dir=temp(t),site=await inputSite(t,{closed,onInput:"if(input.id==='second')location.reload();"});
 const result=await run(settings(site,dir,{closed}));assert.equal(result.status,'partial');assert.deepEqual(site.submissions,[]);
 assert(result.coverageGaps.some(gap=>gap.reason==='input_prefix_unavailable'));
});

test('a final lone text with a conflicting echo is partial even without a following action',{timeout:30000},async t=>{
 const dir=temp(t),site=await inputSite(t,{fields:1,noSubmit:true,onInput:"input.value='unexpected';"});
 const result=await run(settings(site,dir,{fields:1}));assert.equal(result.status,'partial');assert.deepEqual(site.submissions,[]);
 assert(result.coverageGaps.some(gap=>gap.reason==='input_prefix_unavailable'));
});

test('an oversized semantic attribute is refused before text dispatch instead of copying an unbounded receipt',{timeout:30000},async t=>{
 const dir=temp(t),site=await inputSite(t,{fields:1,noSubmit:true,auditInputs:true,firstAttributes:'pattern="'+'a'.repeat(1025)+'"'});
 const result=await run(settings(site,dir,{fields:1}));assert.equal(result.status,'partial');assert.deepEqual(site.typed,[]);assert.deepEqual(site.submissions,[]);
 assert(result.coverageGaps.some(gap=>gap.reason==='input_prefix_unavailable'));
});

async function externalFormSite(t,{mutation='',openShadow=false,standalone=false}={}){
 const submissions=[];
 const site=await fixture(t,async({url},request)=>{
  if(url.pathname.startsWith('/api/')){let body='';for await(const chunk of request)body+=chunk;submissions.push({path:url.pathname,method:request.method,...JSON.parse(body)});return {type:'application/json',body:'{}'};}
  const association=standalone?'':' form="external"',html=(standalone?'':'<form id="external" action="/api/search" method="post"></form>')+`<input id="first" aria-label="First"${association}><input id="second" aria-label="Second"${association}><button id="search"${association}>Search</button>`;
  return {body:document('External owner',openShadow?'<div id="widget"></div>':html,`${openShadow?`const scope=document.querySelector('#widget').attachShadow({mode:'open'});scope.innerHTML=${JSON.stringify(html)};`:'const scope=document;'}
   scope.querySelector('#second').oninput=()=>{${mutation}};
   const form=scope.querySelector('#external');if(form)form.onsubmit=event=>event.preventDefault();
   scope.querySelector('#search').onclick=event=>{event.preventDefault();fetch('/api/search',{method:'POST',body:JSON.stringify({first:scope.querySelector('#first').value,second:scope.querySelector('#second').value})});};`)};
 });return {...site,submissions};
}

for(const openShadow of [false,true])test((openShadow?'open shadow':'DOM')+' keeps a normal external associated FORM callable',{timeout:30000},async t=>{
 const dir=temp(t),site=await externalFormSite(t,{openShadow});
 const extra=openShadow?{formValues:{'#widget >> #first':'left','#widget >> #second':'right'},actionAllowlist:['#widget >> #first','#widget >> #second','#widget >> #search']}:{};
 const result=await run(settings(site,dir,extra));assert.equal(result.status,'completed');assert.deepEqual(site.submissions,[{path:'/api/search',method:'POST',first:'left',second:'right'}]);
});

test('standalone open-shadow fields keep their exact ShadowRoot owner lease',{timeout:30000},async t=>{
 const dir=temp(t),site=await externalFormSite(t,{openShadow:true,standalone:true});
 const result=await run(settings(site,dir,{formValues:{'#widget >> #first':'left','#widget >> #second':'right'},actionAllowlist:['#widget >> #first','#widget >> #second','#widget >> #search']}));assert.equal(result.status,'completed');assert.deepEqual(site.submissions,[{path:'/api/search',method:'POST',first:'left',second:'right'}]);
});

for(const attribute of ['action','method','enctype','target','id','name'])test('external FORM '+attribute+' drift refuses submit despite the same physical owner and input values',{timeout:30000},async t=>{
 const value={action:'/api/other',method:'get',enctype:'text/plain',target:'_blank',id:'renamed',name:'renamed'}[attribute];
 const dir=temp(t),site=await externalFormSite(t,{mutation:`scope.querySelector('#external').setAttribute(${JSON.stringify(attribute)},${JSON.stringify(value)});`});
 const result=await run(settings(site,dir,{requestAllowlist:[{method:'POST',url:site.origin+'/api/search'},{method:'GET',url:site.origin+'/api/search'},{method:'POST',url:site.origin+'/api/other'}]}));
 assert.equal(result.status,'partial');assert.deepEqual(site.submissions,[]);assert(result.coverageGaps.some(gap=>gap.reason==='input_prefix_unavailable'));
});

for(const attribute of ['formaction','formmethod','formenctype','formtarget','formnovalidate'])test('submitter '+attribute+' drift refuses dispatch before it can consume a prefix',{timeout:30000},async t=>{
 const dir=temp(t),site=await externalFormSite(t,{mutation:`scope.querySelector('#search').setAttribute(${JSON.stringify(attribute)},${JSON.stringify(attribute==='formaction'?'/api/other':attribute==='formmethod'?'get':attribute==='formenctype'?'text/plain':attribute==='formtarget'?'_blank':'')});`});
 const result=await run(settings(site,dir,{requestAllowlist:[{method:'POST',url:site.origin+'/api/search'},{method:'GET',url:site.origin+'/api/search'},{method:'POST',url:site.origin+'/api/other'}]}));
 assert.equal(result.status,'partial');assert.deepEqual(site.submissions,[]);assert(result.coverageGaps.some(gap=>gap.reason==='input_prefix_unavailable'));
});

test('safe-profile text filling stays forbidden and legacy true flags cannot permit text replay',async()=>{
 assert.throws(()=>normalizeConfig({startUrl:'https://fixture.invalid',actionProfile:'safe',fillText:true,formValues:{'#first':'left'}}),/填表需要/);
 await assert.rejects(replayPath({}, {}, [{selector:'#first',type:'text',kind:'click',safeReplay:true}],{}),/unsafe_replay_requires_manual_state/);
});

test('receipt text actions cannot fall back from a missing text selector to a same-label button',async()=>{
 let nonTextDispatches=0;
 const target={selector:'#missing',type:'text',kind:'click',framePath:[],label:'First'};
 const locator={count:async()=>0,click:async()=>{nonTextDispatches++;}};
 const page={mainFrame(){return this},locator:()=>locator};
 await assert.rejects(clickElement(page,{invalidate(){},async handle(){}},target,{_runtime:{budget:{check(){}}}},()=>{},{inputReceipt:true}),/input_prefix_target_changed/);
 assert.equal(nonTextDispatches,0);
});

test('virtual-choice primitives cannot run under a text receipt request',async()=>{
 let dialogCalls=0,pageCalls=0;
 const page=new Proxy({}, {get(){pageCalls++;throw new Error('no browser primitive allowed');}});
 const target={selector:'#field',type:'text',kind:'click',role:'combobox',framePath:[]};
 const cfg={ariaVirtualLists:[{selector:'#field',framePath:[]}],_runtime:{budget:{check(){}}}};
 await assert.rejects(clickElement(page,{invalidate(){},async handle(){dialogCalls++;}},target,cfg,()=>{},{inputReceipt:true}),/input_prefix_primitive_unsupported/);
 assert.equal(dialogCalls,0);assert.equal(pageCalls,0);
});

test('a checkpoint with unattempted text preserves submission evidence and resumes once, while old missing evidence refuses before input',{timeout:30000},async t=>{
 const dir=temp(t),runDir=path.join(dir,'current'),site=await inputSite(t,{auditInputs:true,extraHtml:'<button id="before" onclick="fetch(\'/api/bootstrap\')">View bootstrap</button>'});
 const cfg=settings(site,runDir,{maxActions:1}),first=await run(cfg),saved=readRun(runDir);
 assert.equal(first.stopReason,'max_actions');assert.deepEqual(site.typed,[]);assert.deepEqual(site.submissions,[]);
 const pending=saved.cp.states[0].interactives.filter(action=>action.type==='text');assert(pending.every(action=>action.attempts===0&&action.submission&&action.submission.noValidate===false));
 const resumed=await runAsset({...cfg,maxActions:20},{resume:true,log(){}});
 assert.equal(resumed.status,'completed');assert.deepEqual(site.submissions,[expected(2)]);assert.deepEqual(site.typed,[{id:'first',value:'left'},{id:'second',value:'right'}]);
 assert.equal(site.requests.filter(request=>request.url.pathname==='/api/bootstrap').length,1);
 const legacyDir=path.join(dir,'missing-submission'),legacyCfg=settings(site,legacyDir),store=openStore(normalizeConfig(legacyCfg)),legacy=structuredClone(saved.cp);
 for(const action of legacy.states[0].interactives)delete action.submission;
 try{store.save(legacy);store.update({status:'partial'});}finally{store.release();}
 const rejected=await runAsset(legacyCfg,{resume:true,log(){}});assert.equal(rejected.status,'partial');
 assert.deepEqual(site.submissions,[expected(2)]);assert.deepEqual(site.typed,[{id:'first',value:'left'},{id:'second',value:'right'}]);
 assert(rejected.coverageGaps.some(gap=>gap.reason==='input_prefix_unavailable'));
});
