import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {existsSync,writeFileSync} from 'node:fs';
import {normalizeConfig} from '../src/asset.js';
import {openStore} from '../src/store.js';
import {compileBrowserWorkflow,executeBrowserWorkflow} from '../src/browser-workflows.js';
import {temp,fixture,document,config,json,lines} from './helpers.mjs';

const WIRES=['usr','team','org'];
const LABELS=['User','Team','Org'];

function definition(kind='aria',{changed=true,effect='read'}={}){
  const property=kind==='check'?{type:'boolean'}:kind==='fill'?{type:'string',minLength:2}:{type:'string',enum:WIRES};
  const input=kind==='aria'?{kind:'choose',selector:'#input',param:'query',selection:{attribute:'data-value'},choices:Object.fromEntries(WIRES.map(wire=>[wire,{selector:'#option-'+wire}]))}:{kind,selector:'#input',param:'query'};
  const representation=kind==='check'?{paramValueMap:{true:'enabled',false:'disabled'}}:['aria','select'].includes(kind)?{paramRepresentation:'optionLabel'}:{};
  return {schemaVersion:1,id:'query_baseline',effect,inputSchema:{type:'object',properties:{query:property},additionalProperties:false},entry:{anchors:[{selector:'h1',text:'Result baseline'}]},steps:[input,{kind:'click',selector:'#search'}],assertions:[{selector:'#result',textIncludesParam:'query',...representation,...(changed?{changedFromBefore:true}:{}),timeoutMs:150}],extract:[{name:'result',selector:'#result',kind:'text'}],samples:kind==='check'?[{query:true},{query:false}]:kind==='fill'?[{query:'alpha'},{query:'beta'}]:[{query:'usr'},{query:'team'}]};
}

async function resultSite(t,kind='aria'){
  let mode='submit';
  const submissions=[],events=[];
  const site=await fixture(t,async({method,url},req)=>{
    if(method==='POST'){
      let body='';for await(const part of req)body+=part;const value=JSON.parse(body);
      if(url.pathname==='/api/event'){events.push(value);return {type:'application/json',body:'{}'};}
      if(url.pathname==='/api/query'){submissions.push(value);return {type:'application/json',body:JSON.stringify({...value,serial:submissions.length})};}
    }
    const control=kind==='aria'?`<button id="input" type="button" role="combobox" aria-label="Query" aria-controls="list" aria-expanded="false" data-value="">Choose</button><div id="list" role="listbox" hidden>${WIRES.map((wire,index)=>`<div id="option-${wire}" role="option" aria-selected="false" data-value="${wire}">${LABELS[index]}</div>`).join('')}</div>`:kind==='select'?`<select id="input">${WIRES.map((wire,index)=>`<option value="${wire}">${LABELS[index]}</option>`).join('')}</select>`:kind==='check'?'<input id="input" type="checkbox" aria-label="Query">':'<input id="input" type="text" aria-label="Query">';
    return {body:document('Result baseline',`${control}<button id="search" type="button">Search</button><output id="result" role="status">${mode==='same-noop'?'query Org':'Not queried'}</output>`,
      `const kind=${JSON.stringify(kind)},mode=${JSON.stringify(mode)},input=document.querySelector('#input'),result=document.querySelector('#result');
      const current=()=>kind==='aria'?{wire:input.getAttribute('data-value'),label:input.textContent}:kind==='select'?{wire:input.value,label:input.selectedOptions[0].label}:kind==='check'?{wire:input.checked,label:input.checked?'enabled':'disabled'}:{wire:input.value,label:input.value};
      const log=value=>fetch('/api/event',{method:'POST',body:JSON.stringify(value)});
      const update=()=>{if(mode.startsWith('auto-'))result.textContent='query '+current().label;};
      if(kind==='aria'){
        const list=document.querySelector('#list');input.onclick=()=>{log({type:'open'});input.setAttribute('aria-expanded','true');list.hidden=false;};
        for(const option of list.children)option.onclick=()=>{log({type:'option',wire:option.dataset.value});for(const other of list.children)other.setAttribute('aria-selected',String(other===option));input.setAttribute('data-value',option.dataset.value);input.textContent=option.textContent;input.setAttribute('aria-expanded','false');list.hidden=true;update();};
      }else input.addEventListener(kind==='fill'?'input':'change',update);
      document.querySelector('#search').onclick=async()=>{const value=current(),response=await fetch('/api/query',{method:'POST',body:JSON.stringify(value)}),saved=await response.json();if(mode==='auto-noop'||mode==='same-noop')return;result.textContent='query '+saved.label+' #'+saved.serial;};`)};
  });
  return {...site,submissions,events,setMode:value=>{mode=value;}};
}

function source(t,site,kind,options={}){
  const home=temp(t),runDir=path.join(home,'source'),selectors=['#input','#search',...(kind==='aria'?WIRES.map(wire=>'#option-'+wire):[])];
  const cfg=normalizeConfig(config(site.origin,runDir,{actionProfile:'forms',fillText:true,formValues:{'#input':'seed'},actionAllowlist:selectors,writeActionAllowlist:options.effect==='write'?['#search']:[],requestAllowlist:[{method:'POST',url:site.origin+'/api/event'},{method:'POST',url:site.origin+'/api/query'}],exploreHover:false,exploreScroll:false}));
  const store=openStore(cfg),state={id:1,parentId:null,path:[],url:cfg.startUrl,fp:'1'.repeat(32),interactives:[]};state.evidenceId=store.emit('state',{stateId:1,url:state.url,fp:state.fp});store.save({states:[state],backEdges:[]});store.update({status:'completed'});store.release();
  const specFile=path.join(home,'workflow.json');writeFileSync(specFile,JSON.stringify(definition(kind,options)));
  return {home,runDir,specFile};
}

async function learned(t,site,kind='aria',options={}){
  const stored=source(t,site,kind,options),compiled=await compileBrowserWorkflow({...stored,sourceId:'baseline',outputDir:path.join(stored.home,'build')});
  const capability=compiled.manifest.capabilities[0];return {...stored,recipe:compiled.recipes[capability.id]};
}

test('ARIA changed assertions reject selection auto-update and same-value no-op while submitting only once',{timeout:60000},async t=>{
  const site=await resultSite(t),stored=await learned(t,site);
  assert.equal(site.submissions.length,2);
  for(const [mode,ok]of [['auto-noop',false],['auto-submit',true],['submit',true],['same-noop',false]]){
    site.setMode(mode);const submitted=site.submissions.length,opened=site.events.filter(value=>value.type==='open').length,selected=site.events.filter(value=>value.type==='option').length;
    const outputDir=path.join(stored.home,mode),result=await executeBrowserWorkflow({...stored,params:{query:'org'},outputDir});
    assert.equal(result.ok,ok,JSON.stringify(result));
    if(ok)assert.match(result.data.result.text,/query Org #/);else assert.equal(result.error.code,'RESULT_ASSERTION_FAILED');
    assert.equal(site.submissions.length,submitted+1,mode+' must dispatch the business trigger exactly once');
    assert.equal(site.events.filter(value=>value.type==='open').length,opened+1);
    assert.equal(site.events.filter(value=>value.type==='option').length,selected+1);
    assert.equal(lines(path.join(outputDir,'events.jsonl')).filter(row=>row.kind==='workflow_action_started'&&row.actionId.endsWith(':1')).length,1);
  }
});

test('text-only ARIA assertions retain matching semantics without an implicit change condition',{timeout:30000},async t=>{
  const site=await resultSite(t),stored=await learned(t,site,'aria',{changed:false});
  site.setMode('auto-noop');const before=site.submissions.length,result=await executeBrowserWorkflow({...stored,params:{query:'org'},outputDir:path.join(stored.home,'text-only')});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.observation.changedFromBeforeAssertions,0);assert.equal(site.submissions.length,before+1);assert.equal(result.data.result.text,'query Org');
});

test('native select, checkbox and text input share the explicit final-trigger change guard',{timeout:90000},async t=>{
  for(const kind of ['select','check','fill']){
    const site=await resultSite(t,kind),stored=await learned(t,site,kind),query=kind==='check'?true:kind==='fill'?'gamma':'org';
    for(const [mode,ok]of [['auto-noop',false],['auto-submit',true]]){
      site.setMode(mode);const before=site.submissions.length,result=await executeBrowserWorkflow({...stored,params:{query},outputDir:path.join(stored.home,mode)});
      assert.equal(result.ok,ok,kind+' '+mode+' '+JSON.stringify(result));if(!ok)assert.equal(result.error.code,'RESULT_ASSERTION_FAILED');assert.equal(site.submissions.length,before+1);
    }
  }
});

test('ARIA auto-update with no-op write trigger remains unknown and does not publish readiness or retry',{timeout:30000},async t=>{
  const site=await resultSite(t),stored=source(t,site,'aria',{effect:'write'}),outputDir=path.join(stored.home,'write-failed');site.setMode('auto-noop');
  await assert.rejects(compileBrowserWorkflow({...stored,sourceId:'baseline',outputDir,permissions:{allowWrite:['query_baseline'],allowWriteLearning:['query_baseline']}}),error=>{
    assert.equal(error.code,'WORKFLOW_VALIDATION_FAILED');assert.deepEqual(error.writeOutcome,{status:'unknown',automaticRetry:false});return true;
  });
  assert.equal(site.submissions.length,1);assert.equal(site.events.filter(value=>value.type==='open').length,1);assert.equal(site.events.filter(value=>value.type==='option').length,1);
  assert.equal(json(path.join(outputDir,'sample-1/result.json')).error.code,'RESULT_ASSERTION_FAILED');assert.deepEqual(json(path.join(outputDir,'sample-1/write-intent.json')),{effect:'write',status:'unknown',automaticRetry:false});assert(!existsSync(path.join(outputDir,'manifest.json')));
});
