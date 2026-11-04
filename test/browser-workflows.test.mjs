import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {existsSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {compileBrowserWorkflow,executeBrowserWorkflow} from '../src/browser-workflows.js';
import {normalizeConfig} from '../src/asset.js';
import {openStore} from '../src/store.js';
import {runAsset} from '../src/runner.js';
import {temp,fixture,document,config,json,lines,until} from './helpers.mjs';

function stored(t,origin,extra={}){
  const home=temp(t),runDir=path.join(home,'source'),cfg=normalizeConfig(config(origin,runDir,{actionProfile:'forms',fillText:true,formValues:{'#q':'seed'},actionAllowlist:['#q','#go'],requestAllowlist:[{method:'POST',url:origin+'/api/search'}],...extra})),store=openStore(cfg);
  const state={id:1,parentId:null,path:[],url:cfg.startUrl,fp:'1'.repeat(32),title:'fixture',interactives:[]};state.evidenceId=store.emit('state',{stateId:1,url:state.url,fp:state.fp});store.save({states:[state],backEdges:[]});store.update({status:'completed'});store.release();return {home,runDir,cfg};
}
const spec=()=>({schemaVersion:1,id:'query',name:'参数化查询',effect:'read',inputSchema:{type:'object',properties:{query:{type:'string',minLength:1,maxLength:20,pattern:'^[a-z]+$'}},required:['query'],additionalProperties:false},entry:{anchors:[{selector:'h1',text:'查询工具'},{selector:'#q',tag:'input'}]},steps:[{kind:'fill',selector:'#q',param:'query'},{kind:'click',selector:'#go'}],assertions:[{selector:'#results',count:1,textIncludesParam:'query'}],extract:[{name:'items',selector:'#results',kind:'table'}],samples:[{query:'alpha'},{query:'beta'}]});
function saveSpec(home,value){const file=path.join(home,'workflow.json');writeFileSync(file,JSON.stringify(value));return file;}

test('workflow preflight: missing approval, unsupported public inputs and unproven samples reject before navigation',async t=>{
  const {home,runDir}=stored(t,'http://127.0.0.1:55443');
  for(const change of [s=>s.effect='unknown',s=>s.samples=[{query:'alpha'}],s=>s.samples=[{query:'alpha'},{query:'alpha'}],s=>s.assertions=[{selector:'#results',count:1}],s=>s.steps[0].selector='#not-approved',s=>s.inputSchema.additionalProperties=true,s=>s.inputSchema.properties.unused={type:'string'},s=>s.steps[1].param='query',s=>s.assertions[0].timeoutMs=-1,s=>s.assertions[0].timeoutMs=10001,s=>s.assertions[0].changedFromBefore='yes',s=>s.assertions[0].count=0,s=>s.assertions[0].paramRepresentation='unknown',s=>s.assertions[0].paramRepresentation='optionLabel',s=>s.assertions[0].paramSeparator=';',s=>s.assertions[0].paramValueMap={alpha:'A',beta:'B'},s=>{s.inputSchema.properties.query.enum=['alpha','beta','gamma'];s.assertions[0].paramValueMap={alpha:'A',beta:'B'}}]){
    const value=spec();change(value);const file=saveSpec(home,value);await assert.rejects(compileBrowserWorkflow({runDir,sourceId:'web',specFile:file,outputDir:path.join(home,'build')}));assert(!existsSync(path.join(home,'build')));
  }
});

test('workflow cancellation: an already-aborted caller cannot reach validation, filesystem setup or browser launch',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(compileBrowserWorkflow({runDir:'/missing',signal:controller.signal}),{code:'CANCELLED'});
  await assert.rejects(executeBrowserWorkflow({runDir:'/missing',recipe:{},signal:controller.signal}),{code:'CANCELLED'});
});

test('workflow: real approved POST search validates alpha/beta and calls gamma with data, not a fixed page fingerprint', {timeout:90000},async t=>{
  const home=temp(t),queries=[];let mode='normal';
  const site=await fixture(t,async({url},req)=>{
    if(url.pathname==='/api/search'){let body='';for await(const chunk of req)body+=chunk;const value=JSON.parse(body);queries.push(value.q);return {type:'application/json',body:JSON.stringify({query:value.q})};}
    const input=mode==='locator'?'renamed':'q',field=`<input id="${input}" name="q" aria-label="查询" required pattern="[a-z]+" maxlength="20">`,html=mode==='layout'?'<div>'+field+'</div>':field;
    return {body:document('查询工具',`<form id="form" action="/api/search" method="post">${html}<button id="go" type="button" onclick="query()">查询</button></form><table id="results"><thead><tr><th>结果</th></tr></thead><tbody id="rows"></tbody></table>`,`async function query(){try{const q=document.querySelector('#${input}').value;const response=await fetch('/api/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({q})});const data=await response.json();document.querySelector('#rows').innerHTML='';const row=document.createElement('tr'),cell=document.createElement('td');cell.textContent=${mode==='assertion'?"'unexpected'":"data.query"};row.append(cell);document.querySelector('#rows').append(row)}catch{}}`)};
  });
  const runDir=path.join(home,'source');const source=await runAsset(config(site.origin,runDir,{actionProfile:'forms',fillText:true,formValues:{'#q':'seed'},actionAllowlist:['#q','#go'],requestAllowlist:[{method:'POST',url:site.origin+'/api/search'}],maxActions:10,maxDurationMs:15000}),{log(){}});assert(['completed','partial'].includes(source.status));
  const file=saveSpec(home,spec()),before=queries.length,build=path.join(home,'compiled'),compiled=await compileBrowserWorkflow({runDir,sourceId:'search-web',specFile:file,outputDir:build});
  assert.deepEqual(queries.slice(before),['alpha','beta']);assert.equal(compiled.validation.status,'validated');assert.equal(compiled.manifest.capabilities[0].readiness,'ready');
  const cap=compiled.manifest.capabilities[0],recipe=compiled.recipes[cap.id],publicText=JSON.stringify(compiled.manifest);
  for(const hidden of ['#q','#go','#results','alpha','beta','samples','specFile','contracts'])assert(!publicText.includes(hidden),hidden);
  for(const filename of ['manifest.json','recipes.json','validation.json'])assert(existsSync(path.join(build,filename)));
  if(process.platform!=='win32')assert.equal(statSync(path.join(build,'recipes.json')).mode&0o777,0o600);
  const checkpoint=readFileSync(path.join(runDir,'private/checkpoint.json')),gamma=await executeBrowserWorkflow({runDir,recipe,params:{query:'gamma'},expectedRevision:cap.revision,outputDir:path.join(home,'gamma')});
  assert.equal(gamma.ok,true,JSON.stringify(gamma));assert.equal(queries.at(-1),'gamma');assert.deepEqual(gamma.data.items.rows,[['gamma']]);assert(gamma.output.tables.some(table=>table.rows.some(row=>row.includes('gamma'))));assert.equal(gamma.observation.actions,2);
  assert(readFileSync(path.join(runDir,'private/checkpoint.json')).equals(checkpoint));assert.equal(lines(path.join(home,'gamma/private/events.jsonl')).filter(row=>row.kind==='workflow_action_finished').length,2);
  const secondSpec=spec();secondSpec.name='同ID的新验证';const secondFile=path.join(home,'second-spec.json');writeFileSync(secondFile,JSON.stringify(secondSpec));
  const second=await compileBrowserWorkflow({runDir,sourceId:'search-web',specFile:secondFile,outputDir:path.join(home,'second-compiled')});assert.notEqual(second.manifest.capabilities[0].revision,cap.revision);
  const oldVersion=await executeBrowserWorkflow({runDir,recipe,params:{query:'gamma'},expectedRevision:cap.revision,outputDir:path.join(home,'old-version')});assert.equal(oldVersion.ok,true,'new uncommitted validation must not invalidate published old recipe');
  const requestCount=site.requests.length,queryCount=queries.length;
  for(const params of [{query:'123'},{query:'x'.repeat(21)},{query:'gamma',selector:'#other'},{query:1}])await assert.rejects(executeBrowserWorkflow({runDir,recipe,params,outputDir:path.join(home,'invalid')}),{code:'PARAMS_INVALID'});
  assert.equal(site.requests.length,requestCount);
  mode='locator';const missing=await executeBrowserWorkflow({runDir,recipe,params:{query:'gamma'},outputDir:path.join(home,'locator')});assert.equal(missing.ok,false);assert.equal(missing.error.code,'LOCATOR_CHANGED');assert.equal(queries.length,queryCount);
  mode='layout';const changed=await executeBrowserWorkflow({runDir,recipe,params:{query:'gamma'},outputDir:path.join(home,'layout')});assert.equal(changed.ok,false);assert.equal(changed.error.code,'CONTROL_CHANGED');assert.equal(queries.length,queryCount);
  mode='assertion';const mismatch=await executeBrowserWorkflow({runDir,recipe,params:{query:'gamma'},outputDir:path.join(home,'assertion')});assert.equal(mismatch.ok,false);assert.equal(mismatch.error.code,'RESULT_ASSERTION_FAILED');
  const saved=json(file);saved.name='changed';writeFileSync(file,JSON.stringify(saved));const count=site.requests.length;await assert.rejects(executeBrowserWorkflow({runDir,recipe,params:{query:'gamma'}}),{code:'SOURCE_CHANGED'});assert.equal(site.requests.length,count);
});

test('workflow: unapproved POST never reaches the server and missing selector approval never opens a browser', {timeout:60000},async t=>{
  let posted=0;const site=await fixture(t,async({url},req)=>{if(url.pathname==='/api/search'){posted++;return {type:'application/json',body:'{}'}}return {body:document('查询工具','<input id="q"><button id="go" onclick="fetch(\'/api/search\',{method:\'POST\',body:JSON.stringify({q:document.querySelector(\'#q\').value})}).catch(()=>{})">查询</button><table id="results"><tr><td>none</td></tr></table>')};});
  const a=stored(t,site.origin,{requestAllowlist:[{method:'GET',url:site.origin+'/api/allowed'}]}),file=saveSpec(a.home,spec());
  await assert.rejects(compileBrowserWorkflow({runDir:a.runDir,sourceId:'denied',specFile:file,outputDir:path.join(a.home,'build')}),{code:'WORKFLOW_VALIDATION_FAILED'});assert.equal(posted,0);assert.equal(json(path.join(a.home,'build/validation.json')).status,'failed');
  const b=stored(t,site.origin,{actionAllowlist:['#q']}),second=saveSpec(b.home,spec()),before=site.requests.length;await assert.rejects(compileBrowserWorkflow({runDir:b.runDir,sourceId:'selector-denied',specFile:second}),{code:'ACTION_NOT_APPROVED'});assert.equal(site.requests.length,before);
  const c=stored(t,site.origin,{excludeTextPatterns:['查询']}),third=saveSpec(c.home,spec());await assert.rejects(compileBrowserWorkflow({runDir:c.runDir,sourceId:'text-denied',specFile:third,outputDir:path.join(c.home,'build')}),{code:'WORKFLOW_VALIDATION_FAILED'});assert.equal(posted,0);assert.equal(json(path.join(c.home,'build/validation.json')).runs[0].error.code,'ACTION_EXCLUDED');
});

test('workflow: pure UI number/multiple-select/check validates two inputs and executes a third without fake HTTP evidence',{timeout:60000},async t=>{
  const site=await fixture(t,()=>({body:document('纯UI工具','<form id="calc" action="/" method="get"></form><input id="q" form="calc" type="number" min="1" max="9" step="1" required><select id="tags" form="calc" multiple size="3"><option value="a">A</option><option value="b">B</option><option value="c">C</option></select><input id="flag" form="calc" type="checkbox"><button id="go" form="calc" type="button" onclick="calculate()">计算</button><section id="results" role="status">未计算</section>',`function calculate(){document.querySelector('#results').textContent='amount='+document.querySelector('#q').value+';tags='+Array.from(document.querySelector('#tags').selectedOptions).map(o=>o.value).join(',')+';enabled='+document.querySelector('#flag').checked}`)}));
  const {home,runDir}=stored(t,site.origin,{formValues:{'#q':'1'},actionAllowlist:['#q','#tags','#flag','#go'],requestAllowlist:[{method:'GET',url:site.origin+'/'}]}),value={schemaVersion:1,id:'ui',name:'本地计算',effect:'read',inputSchema:{type:'object',properties:{amount:{type:'number',minimum:1,maximum:9},tags:{type:'array',items:{type:'string',enum:['a','b','c']},minItems:1,maxItems:2,uniqueItems:true},enabled:{type:'boolean'}},additionalProperties:false},entry:{anchors:[{selector:'h1',text:'纯UI工具'},{selector:'#q',tag:'input'}]},steps:[{kind:'fill',selector:'#q',param:'amount'},{kind:'select',selector:'#tags',param:'tags'},{kind:'check',selector:'#flag',param:'enabled'},{kind:'click',selector:'#go'}],assertions:['amount','tags','enabled'].map(param=>({selector:'#results',textIncludesParam:param})),extract:[{name:'summary',selector:'#results',kind:'text'}],samples:[{amount:2,tags:['a'],enabled:true},{amount:3,tags:['b','c'],enabled:false}]};
  const file=saveSpec(home,value),compiled=await compileBrowserWorkflow({runDir,sourceId:'pure-ui',specFile:file,outputDir:path.join(home,'compiled')}),cap=compiled.manifest.capabilities[0],recipe=compiled.recipes[cap.id];
  assert.deepEqual(new Set(cap.inputSchema.required),new Set(['amount','tags','enabled']));assert.equal(cap.evidence.networkObserved,false);assert.equal(cap.evidence.approvedResponses,0);
  assert.equal(recipe.contracts.steps[0].formAction,site.origin+'/');assert.equal(recipe.contracts.steps[0].constraints.step,'1');assert.equal(recipe.contracts.steps[1].constraints.multiple,true);
  const before=site.requests.length,result=await executeBrowserWorkflow({runDir,recipe,params:{amount:4,tags:['c'],enabled:true},outputDir:path.join(home,'third')});assert.equal(result.ok,true,JSON.stringify(result));assert(result.data.summary.text.includes('amount=4;tags=c;enabled=true'));assert.equal(result.evidence.networkObserved,false);assert.equal(result.evidence.approvedResponses,0);assert.equal(site.requests.length-before,1);
  const missingCount=site.requests.length;await assert.rejects(executeBrowserWorkflow({runDir,recipe,params:{amount:4,tags:['c']}}),{code:'PARAMS_INVALID'});assert.equal(site.requests.length,missingCount);
  const invalid=await executeBrowserWorkflow({runDir,recipe,params:{amount:4.5,tags:['c'],enabled:true},outputDir:path.join(home,'invalid-native')});assert.equal(invalid.ok,false);assert.equal(invalid.error.code,'PARAM_VALUE_REJECTED');
  value.id='network-required';value.networkEvidence='required';const requiredFile=path.join(home,'required.json');writeFileSync(requiredFile,JSON.stringify(value));await assert.rejects(compileBrowserWorkflow({runDir,sourceId:'pure-ui',specFile:requiredFile,outputDir:path.join(home,'required')}),{code:'WORKFLOW_VALIDATION_FAILED'});
});


test('workflow async results: wait for delayed visible changes, reject stale same-value results and cancel without another click',{timeout:90000},async t=>{
  const queries=[];let mode='delayed';
  const site=await fixture(t,async({url},req)=>{
    if(url.pathname==='/api/search'){let raw='';for await(const chunk of req)raw+=chunk;const q=JSON.parse(raw).q;queries.push(q);return {type:'application/json',body:JSON.stringify({q})};}
    const initial=mode==='same'?'gamma':'old',table=mode==='appears'?'':`<table id="results"><tr><td>${initial}</td></tr></table>`;
    return {body:document('查询工具',`<input id="q"><button id="go" type="button" onclick="query()">查询</button>${table}`,`async function query(){const q=document.querySelector('#q').value;const response=await fetch('/api/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({q})});const data=await response.json();${mode==='never'?'':"setTimeout(()=>{let table=document.querySelector('#results');if(!table){table=document.createElement('table');table.id='results';table.innerHTML='<tr><td></td></tr>';document.body.append(table)}table.rows[0].cells[0].textContent=data.q;},700);"}}`)};
  });
  const {home,runDir}=stored(t,site.origin),definition=spec();definition.assertions[0].timeoutMs=1800;definition.assertions[0].changedFromBefore=true;
  const file=saveSpec(home,definition),compiled=await compileBrowserWorkflow({runDir,sourceId:'async',specFile:file,outputDir:path.join(home,'compiled')}),cap=compiled.manifest.capabilities[0],recipe=compiled.recipes[cap.id];
  assert.deepEqual(queries,['alpha','beta']);assert.equal(cap.evidence.changedFromBeforeAssertions,1);
  const before=queries.length,gamma=await executeBrowserWorkflow({runDir,recipe,params:{query:'gamma'},outputDir:path.join(home,'gamma')});
  assert.equal(gamma.ok,true,JSON.stringify(gamma));assert.deepEqual(gamma.data.items.rows,[['gamma']]);assert.equal(gamma.observation.changedFromBeforeAssertions,1);assert.equal(queries.length,before+1);
  mode='appears';const appears=await executeBrowserWorkflow({runDir,recipe,params:{query:'appears'},outputDir:path.join(home,'appears')});assert.equal(appears.ok,true,JSON.stringify(appears));assert.deepEqual(appears.data.items.rows,[['appears']]);
  mode='same';const sameBefore=queries.length,same=await executeBrowserWorkflow({runDir,recipe,params:{query:'gamma'},outputDir:path.join(home,'same')});assert.equal(same.ok,false);assert.equal(same.error.code,'RESULT_ASSERTION_FAILED');assert.equal(queries.length,sameBefore+1,'unchanged visible result cannot provoke repeated clicks');
  mode='never';const neverBefore=queries.length,never=await executeBrowserWorkflow({runDir,recipe,params:{query:'never'},outputDir:path.join(home,'never')});assert.equal(never.ok,false);assert.equal(never.error.code,'RESULT_ASSERTION_FAILED');assert.equal(queries.length,neverBefore+1);
  const neverSpec=path.join(home,'never-spec.json');writeFileSync(neverSpec,JSON.stringify({...definition,id:'never',assertions:[{...definition.assertions[0],timeoutMs:350}]}));
  const beforeLearn=queries.length;await assert.rejects(compileBrowserWorkflow({runDir,sourceId:'async',specFile:neverSpec,outputDir:path.join(home,'never-build')}),{code:'WORKFLOW_VALIDATION_FAILED'});assert.equal(queries.length,beforeLearn+1);assert(!existsSync(path.join(home,'never-build/manifest.json')));
  const controller=new AbortController(),beforeCancel=queries.length,pending=executeBrowserWorkflow({runDir,recipe,params:{query:'cancel'},outputDir:path.join(home,'cancel'),signal:controller.signal});
  await until(()=>queries.length>beforeCancel,10000);const cancelledAt=Date.now();controller.abort();const cancelled=await pending;assert.equal(cancelled.ok,false);assert.equal(cancelled.error.code,'cancelled');assert(Date.now()-cancelledAt<2000);assert.equal(queries.length,beforeCancel+1);
});

test('workflow async results: existing parameter assertions wait by default without claiming visible-change proof',{timeout:60000},async t=>{
  const queries=[];const site=await fixture(t,async({url},req)=>{
    if(url.pathname==='/api/search'){let raw='';for await(const c of req)raw+=c;queries.push(JSON.parse(raw).q);return {type:'application/json',body:raw};}
    return {body:document('查询工具','<input id="q"><button id="go" onclick="query()">查询</button><table id="results"><tr><td>old</td></tr></table>',`async function query(){const q=document.querySelector('#q').value;await fetch('/api/search',{method:'POST',body:JSON.stringify({q})});setTimeout(()=>document.querySelector('#results td').textContent=q,700)}`)};
  });
  const {home,runDir}=stored(t,site.origin),file=saveSpec(home,spec()),compiled=await compileBrowserWorkflow({runDir,sourceId:'async-default',specFile:file,outputDir:path.join(home,'compiled')}),cap=compiled.manifest.capabilities[0];
  assert.deepEqual(queries,['alpha','beta']);assert.equal(cap.evidence.changedFromBeforeAssertions,0);
  const result=await executeBrowserWorkflow({runDir,recipe:compiled.recipes[cap.id],params:{query:'gamma'},outputDir:path.join(home,'gamma')});assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(result.data.items.rows,[['gamma']]);assert.equal(result.evidence.changedFromBeforeAssertions,0);
});

test('workflow async results: a changed assertion target during extraction cannot certify an older observation',{timeout:60000},async t=>{
  let moving=false;const queries=[];
  const site=await fixture(t,async({url},req)=>{
    if(url.pathname==='/api/search'){let raw='';for await(const c of req)raw+=c;queries.push(JSON.parse(raw).q);return {type:'application/json',body:raw};}
    return {body:document('查询工具','<input id="q"><button id="go" onclick="query()">查询</button><table id="results"><tr><td>old</td></tr></table>',`const table=document.querySelector('#results'),native=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'innerText');let reads=0;Object.defineProperty(table,'innerText',{get(){const value=native.get.call(this);if(${moving}&&++reads===3)queueMicrotask(()=>table.rows[0].cells[0].textContent=document.querySelector('#q').value+'-v2');return value;}});async function query(){const q=document.querySelector('#q').value;await fetch('/api/search',{method:'POST',body:JSON.stringify({q})});table.rows[0].cells[0].textContent=q+'-v1';reads=0;}`)};
  });
  const {home,runDir}=stored(t,site.origin),file=saveSpec(home,spec()),compiled=await compileBrowserWorkflow({runDir,sourceId:'moving-result',specFile:file,outputDir:path.join(home,'compiled')}),cap=compiled.manifest.capabilities[0];
  moving=true;const before=queries.length,result=await executeBrowserWorkflow({runDir,recipe:compiled.recipes[cap.id],params:{query:'gamma'},outputDir:path.join(home,'changed')});
  assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.error.code,'RESULT_CHANGED_DURING_EXTRACTION');assert.equal(queries.length,before+1);assert.equal(result.data,undefined);
});

test('workflow representations preserve option wire values and required constant checkboxes while matching visible labels',{timeout:60000},async t=>{
  const received=[];const site=await fixture(t,async({url},req)=>{
    if(url.pathname==='/api/search'){let raw='';for await(const c of req)raw+=c;const input=JSON.parse(raw);received.push(input);return {type:'application/json',body:raw};}
    return {body:document('查询工具','<form action="/api/search" method="post"><input id="q"><select id="category" required><option value="usr">用户</option><option value="team">团队</option><option value="org">组织</option></select><input id="accepted" type="checkbox" required><button id="go" type="button" onclick="query()">查询</button></form><table id="results"><tr><td>未查询</td></tr></table>',`async function query(){const input={query:document.querySelector('#q').value,category:document.querySelector('#category').value,accepted:document.querySelector('#accepted').checked};const response=await fetch('/api/search',{method:'POST',body:JSON.stringify(input)});const data=await response.json();document.querySelector('#results td').textContent=data.query+' '+document.querySelector('#category').selectedOptions[0].label+' '+(data.accepted?'已选':'未选')+' '+data.category}`)};
  });
  const {home,runDir}=stored(t,site.origin,{actionAllowlist:['#q','#category','#accepted','#go']}),value=spec();
  value.inputSchema.properties.category={type:'string',enum:['usr','team','org']};value.inputSchema.properties.accepted={type:'boolean',const:true};
  value.steps=[value.steps[0],{kind:'select',selector:'#category',param:'category'},{kind:'check',selector:'#accepted',param:'accepted'},value.steps[1]];
  value.assertions.push({selector:'#results',textIncludesParam:'category',paramRepresentation:'optionLabel'},{selector:'#results',textIncludesParam:'accepted',paramValueMap:{true:'已选'}});
  value.samples=[{query:'alpha',category:'usr',accepted:true},{query:'beta',category:'team',accepted:true}];
  const file=saveSpec(home,value),compiled=await compileBrowserWorkflow({runDir,sourceId:'represented',specFile:file,outputDir:path.join(home,'compiled')}),cap=compiled.manifest.capabilities[0],recipe=compiled.recipes[cap.id];
  assert.deepEqual(cap.inputSchema.properties.category.enum,['usr','team','org']);assert.equal(cap.inputSchema.properties.accepted.const,true);
  const input={query:'gamma',category:'org',accepted:true},result=await executeBrowserWorkflow({runDir,recipe,params:input,outputDir:path.join(home,'third')});assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(result.data.items.rows,[['gamma 组织 已选 org']]);assert.deepEqual(received,[...value.samples,input]);
  const before=received.length;
  for(const params of [{...input,category:'组织'},{...input,accepted:false}])await assert.rejects(executeBrowserWorkflow({runDir,recipe,params,outputDir:path.join(home,'invalid')}),{code:'PARAMS_INVALID'});
  assert.equal(received.length,before);
});
