import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFileSync,readFileSync} from 'node:fs';
import {normalizeConfig} from '../src/asset.js';
import {openStore} from '../src/store.js';
import {compileBrowserWorkflow,executeBrowserWorkflow} from '../src/browser-workflows.js';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {temp,fixture,config,root,until,json} from './helpers.mjs';
const inputRegion={x:.28,y:.12,width:.65,height:.17},resultRegion={x:.03,y:.65,width:.94,height:.3};
const fill={kind:'visualFill',selector:'#screen',param:'query',visual:{anchor:'Query',offset:{x:.32,y:0},valueRegion:inputRegion}};
const click={kind:'visualClick',selector:'#screen',visual:{anchor:'Search'}};
const spec=()=>({schemaVersion:1,id:'canvas_query',name:'Canvas query',effect:'read',inputSchema:{type:'object',properties:{query:{type:'string',minLength:2,maxLength:20,pattern:'^[a-z]+$'}},required:['query'],additionalProperties:false},entry:{anchors:[{selector:'#screen',tag:'canvas'}]},steps:[fill,click],assertions:[{selector:'#screen',visual:{region:resultRegion},textIncludesParam:'query',changedFromBefore:true}],extract:[{name:'result',selector:'#screen',kind:'visualText',visual:{region:resultRegion}}],samples:[{query:'alpha'},{query:'beta'}]});
async function canvasSite(t){let mode='normal';const queries=[];const site=await fixture(t,async({url,method},req)=>{
 if(method==='POST'){let raw='';for await(const part of req)raw+=part;queries.push(JSON.parse(raw));return {type:'application/json',body:'{}'};}
 return {body:`<!doctype html><meta charset="utf-8"><title>Canvas App</title><style>body{margin:20px}canvas{display:block;width:800px;height:400px}</style><canvas id="screen" width="800" height="400" tabindex="0"></canvas><script>
 const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),mode=${JSON.stringify(mode)};let query='',result='READY',selected=false;function paint(){ctx.fillStyle='white';ctx.fillRect(0,0,800,400);ctx.fillStyle='black';ctx.font='32px Arial';ctx.fillText(mode==='renamed'?'Changed':'Query',30,90);ctx.strokeStyle='black';ctx.strokeRect(220,50,530,65);ctx.fillText(query,240,90);if(mode==='changed') {ctx.fillStyle='red';ctx.fillRect(500,140,100,55);ctx.fillStyle='black';}ctx.fillText('Search',300,190);if(mode==='duplicate')ctx.fillText('Search',520,190);ctx.fillText(result,30,310);}paint();
 canvas.onclick=async event=>{const r=canvas.getBoundingClientRect(),x=(event.clientX-r.x)*800/r.width,y=(event.clientY-r.y)*400/r.height;if(y>140&&y<220&&x>250&&x<460){if(mode==='auto')return;if(mode!=='stale'){result='RESULT '+query;paint();}await fetch('/query',{method:'POST',body:JSON.stringify({query})});}};
 canvas.onkeydown=event=>{if((event.ctrlKey||event.metaKey)&&event.key==='a'){event.preventDefault();selected=true;return;}if(event.key==='Backspace'){event.preventDefault();query=selected?'':query.slice(0,-1);selected=false;paint();}else if(event.key.length===1&&!event.ctrlKey&&!event.metaKey){event.preventDefault();query=(selected?'':query)+event.key;selected=false;if(mode==='auto')result='RESULT '+query;paint();}};
 if(mode==='overlay'){const overlay=document.createElement('div');Object.assign(overlay.style,{position:'absolute',left:'20px',top:'20px',width:'800px',height:'400px',opacity:'.01',background:'white'});document.body.append(overlay);}
 </script>`};});return {...site,queries,setMode:value=>{mode=value}};}
const extra=site=>({actionProfile:'forms',fillText:true,fillTextValue:'seed',actionAllowlist:['#screen'],requestAllowlist:[{method:'POST',url:site.origin+'/query'}],requestDelayMs:0,shotFormat:'none',visual:{language:'eng',actions:[{...fill,effect:'read',param:undefined},{...click,effect:'read'}].map(({param,...item})=>item)}});
function saved(t,site,overrides={}){const home=temp(t),runDir=path.join(home,'source'),cfg=normalizeConfig(config(site.origin,runDir,{...extra(site),...overrides})),store=openStore(cfg),state={id:1,parentId:null,path:[],url:cfg.startUrl,fp:'1'.repeat(32),interactives:[]};state.evidenceId=store.emit('state',{stateId:1,url:state.url,fp:state.fp});store.save({states:[state],backEdges:[]});store.update({status:'completed'});store.release();return {home,runDir};}
function save(dir,value,name='spec.json'){const file=path.join(dir,name);writeFileSync(file,JSON.stringify(value));return file;}


test('learn rejects click offset outside anchor before action', {timeout:90000}, async t=>{
 const site=await canvasSite(t),settings=structuredClone(extra(site)),definition=structuredClone(spec());definition.steps[1].visual.offset={x:.2,y:0};settings.visual.actions[1].visual.offset={x:.2,y:0};const {home,runDir}=saved(t,site,settings);
 await assert.rejects(compileBrowserWorkflow({runDir,sourceId:'canvas',specFile:save(home,definition),outputDir:path.join(home,'build')}),error=>error.code==='WORKFLOW_VALIDATION_FAILED'&&error.message.includes('VISUAL_TARGET_UNANCHORED'));assert.equal(site.queries.length,0);
});
test('production canvas workflow rejects changed visual content before trigger', {timeout:120000}, async t=>{
 const site=await canvasSite(t),{home,runDir}=saved(t,site),compiled=await compileBrowserWorkflow({runDir,sourceId:'canvas',specFile:save(home,spec()),outputDir:path.join(home,'build')});assert.equal(compiled.manifest.capabilities[0].readiness,'ready');const recipe=Object.values(compiled.recipes)[0];assert.deepEqual(site.queries.map(x=>x.query),['alpha','beta']);
 const before=site.queries.length;site.setMode('changed');const changed=await executeBrowserWorkflow({runDir,recipe,params:{query:'gamma'},outputDir:path.join(home,'changed')});assert.equal(changed.ok,false,JSON.stringify(changed));assert.equal(changed.error.code,'VISUAL_CONTENT_CHANGED');assert.equal(site.queries.length,before);
 site.setMode('normal');const good=await executeBrowserWorkflow({runDir,recipe,params:{query:'gamma'},outputDir:path.join(home,'normal')});assert.equal(good.ok,true,JSON.stringify(good));assert.deepEqual(site.queries.map(x=>x.query),['alpha','beta','gamma']);
});
test('auto-updated result with no-op trigger does not certify ready', {timeout:90000}, async t=>{
 const site=await canvasSite(t);site.setMode('auto');const {home,runDir}=saved(t,site),definition=spec();definition.assertions[0].timeoutMs=500;
 await assert.rejects(compileBrowserWorkflow({runDir,sourceId:'canvas',specFile:save(home,definition),outputDir:path.join(home,'build')}),error=>error.code==='WORKFLOW_VALIDATION_FAILED'&&error.message.includes('RESULT_ASSERTION_FAILED'));assert.equal(site.queries.length,0);
});

test('two visual fields recheck the first value before a later action', {timeout:120000}, async t=>{
 let drift=false;const queries=[];const site=await fixture(t,async({method},req)=>{
  if(method==='POST'){let raw='';for await(const part of req)raw+=part;queries.push(JSON.parse(raw));return {type:'application/json',body:'{}'};}
  return {body:`<!doctype html><meta charset="utf-8"><title>Two inputs</title><canvas id="screen" width="800" height="400" tabindex="0"></canvas><script>
  const c=document.querySelector('canvas'),ctx=c.getContext('2d');let first='',second='',active='',selected=false,result='READY';function paint(){ctx.fillStyle='white';ctx.fillRect(0,0,800,400);ctx.fillStyle='black';ctx.font='32px Arial';ctx.fillText('Query',30,90);ctx.strokeRect(220,50,530,65);ctx.fillText(first,240,90);ctx.fillText('Extra',30,160);ctx.strokeRect(220,120,530,65);ctx.fillText(second,240,160);ctx.fillText('Search',300,245);ctx.fillText(result,30,350);}paint();
  c.onclick=async e=>{const r=c.getBoundingClientRect(),x=e.clientX-r.x,y=e.clientY-r.y;if(x>220&&y>50&&y<115)active='first';else if(x>220&&y>120&&y<185)active='second';else if(x>250&&x<460&&y>200&&y<260){result='RESULT '+first+' '+second;paint();await fetch('/query',{method:'POST',body:JSON.stringify({first,second})});}};
  c.onkeydown=e=>{if((e.ctrlKey||e.metaKey)&&e.key==='a'){e.preventDefault();selected=true;return;}if(e.key==='Backspace'){e.preventDefault();if(active==='first')first=selected?'':first.slice(0,-1);if(active==='second')second=selected?'':second.slice(0,-1);selected=false;paint();return;}if(e.key.length===1&&!e.ctrlKey&&!e.metaKey){e.preventDefault();if(active==='first')first=(selected?'':first)+e.key;if(active==='second'){second=(selected?'':second)+e.key;if(${JSON.stringify(drift)})first='wrong';}selected=false;paint();}};
  </script>`};
 });
 const secondRegion={x:.28,y:.30,width:.65,height:.17},secondFill={kind:'visualFill',selector:'#screen',param:'extra',visual:{anchor:'Extra',offset:{x:.32,y:0},valueRegion:secondRegion}},definition=structuredClone(spec());definition.inputSchema.properties.extra={type:'string',minLength:2,maxLength:20,pattern:'^[a-z]+$'};definition.inputSchema.required.push('extra');definition.steps.splice(1,0,secondFill);definition.assertions[0].visual.region={x:.03,y:.75,width:.94,height:.24};definition.assertions.push({...structuredClone(definition.assertions[0]),textIncludesParam:'extra'});definition.extract[0].visual.region=definition.assertions[0].visual.region;definition.samples=[{query:'alpha',extra:'one'},{query:'beta',extra:'two'}];const settings=extra(site);settings.visual.actions.splice(1,0,{kind:secondFill.kind,selector:secondFill.selector,visual:secondFill.visual,effect:'read'});const {home,runDir}=saved(t,site,settings),built=await compileBrowserWorkflow({runDir,sourceId:'canvas',specFile:save(home,definition),outputDir:path.join(home,'build')});assert.equal(built.manifest.capabilities[0].readiness,'ready');const recipe=Object.values(built.recipes)[0];assert.equal(queries.length,2);
 drift=true;const denied=await executeBrowserWorkflow({runDir,recipe,params:{query:'gamma',extra:'three'},outputDir:path.join(home,'drift')});assert.equal(denied.ok,false,JSON.stringify(denied));assert.equal(denied.error.code,'PARAM_VALUE_CHANGED',JSON.stringify(denied));assert.equal(queries.length,2);
 drift=false;const good=await executeBrowserWorkflow({runDir,recipe,params:{query:'gamma',extra:'three'},outputDir:path.join(home,'good')});assert.equal(good.ok,true,JSON.stringify(good));assert.deepEqual(queries[2],{first:'gamma',second:'three'});
});
