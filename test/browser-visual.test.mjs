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
const inputRegion={x:.25,y:.125,width:.125,height:.125},resultRegion={x:.375,y:.125,width:.25,height:.125};
const fill={kind:'visualFill',selector:'#screen',param:'query',visual:{anchor:'Query',offset:{x:.32,y:0},valueRegion:inputRegion}};
const click={kind:'visualClick',selector:'#screen',visual:{anchor:'Search'}};
const spec=()=>({schemaVersion:1,id:'canvas_query',name:'Canvas query',effect:'read',inputSchema:{type:'object',properties:{query:{type:'string',minLength:2,maxLength:20,pattern:'^[a-z]+$'}},required:['query'],additionalProperties:false},entry:{anchors:[{selector:'#screen',tag:'canvas'}]},steps:[fill,click],assertions:[{selector:'#screen',visual:{region:resultRegion},textIncludesParam:'query',changedFromBefore:true}],extract:[{name:'result',selector:'#screen',kind:'visualText',visual:{region:resultRegion}}],samples:[{query:'alpha'},{query:'beta'}]});
async function canvasSite(t){let mode='stale';const queries=[];const site=await fixture(t,async({url,method},req)=>{
 if(method==='POST'){let raw='';for await(const part of req)raw+=part;queries.push(JSON.parse(raw));return {type:'application/json',body:'{}'};}
 return {body:`<!doctype html><meta charset="utf-8"><title>Canvas App</title><style>body{margin:20px}canvas{display:block;width:800px;height:400px}</style><canvas id="screen" width="800" height="400" tabindex="0"></canvas><script>
 const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),mode=${JSON.stringify(mode)};let query='',result='READY',selected=false;function paint(){ctx.fillStyle='white';ctx.fillRect(0,0,800,400);ctx.fillStyle='black';ctx.font='32px Arial';ctx.fillText(mode==='renamed'?'Changed':'Query',30,90);ctx.strokeStyle='black';ctx.strokeRect(220,50,530,65);ctx.fillText(query,240,90);ctx.fillText('Search',300,190);if(mode==='duplicate')ctx.fillText('Search',520,190);ctx.fillText(result,30,310);}paint();
 canvas.onclick=async event=>{const r=canvas.getBoundingClientRect(),x=(event.clientX-r.x)*800/r.width,y=(event.clientY-r.y)*400/r.height;if(y>140&&y<220&&x>250&&x<460){if(mode!=='stale'){result='RESULT '+query;paint();}await fetch('/query',{method:'POST',body:JSON.stringify({query})});}};
 canvas.onkeydown=event=>{if((event.ctrlKey||event.metaKey)&&event.key==='a'){event.preventDefault();selected=true;return;}if(event.key==='Backspace'){event.preventDefault();query=selected?'':query.slice(0,-1);selected=false;paint();}else if(event.key.length===1&&!event.ctrlKey&&!event.metaKey){event.preventDefault();query=(selected?'':query)+event.key;selected=false;paint();}};
 if(mode==='overlay'){const overlay=document.createElement('div');Object.assign(overlay.style,{position:'absolute',left:'20px',top:'20px',width:'800px',height:'400px',opacity:'.01',background:'white'});document.body.append(overlay);}
 </script>`};});return {...site,queries,setMode:value=>{mode=value}};}
const extra=site=>({actionProfile:'forms',fillText:true,fillTextValue:'seed',actionAllowlist:['#screen'],requestAllowlist:[{method:'POST',url:site.origin+'/query'}],requestDelayMs:0,shotFormat:'none',visual:{language:'eng',actions:[{...fill,effect:'read',param:undefined},{...click,effect:'read'}].map(({param,...item})=>item)}});
function saved(t,site,overrides={}){const home=temp(t),runDir=path.join(home,'source'),cfg=normalizeConfig(config(site.origin,runDir,{...extra(site),...overrides})),store=openStore(cfg),state={id:1,parentId:null,path:[],url:cfg.startUrl,fp:'1'.repeat(32),interactives:[]};state.evidenceId=store.emit('state',{stateId:1,url:state.url,fp:state.fp});store.save({states:[state],backEdges:[]});store.update({status:'completed'});store.release();return {home,runDir};}
function save(dir,value,name='spec.json'){const file=path.join(dir,name);writeFileSync(file,JSON.stringify(value));return file;}



test('disjoint visual regions cannot validate one cross-boundary OCR token as an input and a business result',{timeout:90000},async t=>{
 const {visualText}=await import('../src/browser-visual.js');const observation={width:800,height:400,tokens:[{text:'alpha',confidence:1,bounds:{x:240,y:65,width:80,height:30}}]};
 assert.equal(visualText(observation,inputRegion),'');assert.equal(visualText(observation,resultRegion),'');assert.equal(visualText(observation,{x:.25,y:.125,width:.25,height:.125}),'alpha');
 const site=await canvasSite(t),{home,runDir}=saved(t,site);
 await assert.rejects(compileBrowserWorkflow({runDir,sourceId:'canvas',specFile:save(home,spec()),outputDir:path.join(home,'build')}),{code:'WORKFLOW_VALIDATION_FAILED'});assert.deepEqual(site.queries,[]);
});

test('actual OCR iframe coordinates reject a parent overlay and click successfully after removing it',{timeout:45000},async t=>{
 const {chromium}=await import('playwright'),{groundVisualStep,visualPoint}=await import('../src/browser-visual.js');const site=await fixture(t,async({url})=>({body:url.pathname==='/child'?'<body style="margin:0"><canvas width="800" height="400"></canvas><script>window.canvasClicks=0;const c=document.querySelector("canvas"),x=c.getContext("2d");x.fillStyle="white";x.fillRect(0,0,800,400);x.fillStyle="black";x.font="36px Arial";x.fillText("Search",300,90);c.onclick=()=>window.canvasClicks++;</script>':'<body><iframe src="/child" style="position:absolute;left:100px;top:100px;width:800px;height:400px"></iframe><div id="cover" style="position:absolute;left:100px;top:100px;width:804px;height:404px;opacity:.01;background:white" onclick="window.wrongClicks++"></div><script>window.wrongClicks=0;</script>'}));
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1200,height:900}});await page.goto(site.origin);const frame=page.frames().find(frame=>frame.url().endsWith('/child'));await frame.locator('canvas').waitFor();const found={locator:frame.locator('canvas'),metadata:{tag:'canvas'}},cfg={visual:{engine:{type:'tesseract'},language:'eng',minConfidence:.6},_runtime:{budget:{check(){},remainingMs:20000},visualDir:path.join(await (await import('node:fs/promises')).realpath(temp(t)),'ocr')},actionTimeoutMs:5000},step={visual:{anchor:'Search',offset:{x:0,y:0}}};
 const blockedGround=await groundVisualStep(found,step,cfg);await assert.rejects(visualPoint(page,found,blockedGround,cfg),{code:'VISUAL_TARGET_OCCLUDED'});assert.equal(await page.evaluate(()=>window.wrongClicks),0);assert.equal(await frame.evaluate(()=>window.canvasClicks),0);
 await page.locator('#cover').evaluate(element=>element.remove());const clearGround=await groundVisualStep(found,step,cfg),point=await visualPoint(page,found,clearGround,cfg);assert(point.x>400&&point.y>100);await page.mouse.click(point.x,point.y);assert.equal(await frame.evaluate(()=>window.canvasClicks),1);assert.equal(await page.evaluate(()=>window.wrongClicks),0);
});

test('actual OCR stays clickable through nested offset and bordered iframes',{timeout:30000},async t=>{
 const {chromium}=await import('playwright'),{groundVisualStep,visualPoint}=await import('../src/browser-visual.js');const site=await fixture(t,async({url})=>({body:url.pathname==='/child'?'<body style="margin:0"><canvas width="800" height="400"></canvas><script>window.clicks=0;const c=document.querySelector("canvas"),x=c.getContext("2d");x.fillStyle="white";x.fillRect(0,0,800,400);x.fillStyle="black";x.font="36px Arial";x.fillText("Search",300,90);c.onclick=()=>window.clicks++;</script>':url.pathname==='/middle'?'<body style="margin:0"><iframe src="/child" style="position:absolute;left:50px;top:60px;width:800px;height:400px;border:3px solid black"></iframe>':'<body><iframe src="/middle" style="position:absolute;left:100px;top:100px;width:950px;height:600px;border:7px solid black"></iframe>'}));
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1200,height:1000}});await page.goto(site.origin);const frame=page.frames().find(frame=>frame.url().endsWith('/child'));await frame.locator('canvas').waitFor();const found={locator:frame.locator('canvas'),metadata:{tag:'canvas'}},cfg={visual:{engine:{type:'tesseract'},language:'eng',minConfidence:.6},_runtime:{budget:{check(){},remainingMs:20000},visualDir:path.join(await (await import('node:fs/promises')).realpath(temp(t)),'ocr')},actionTimeoutMs:5000};
 const ground=await groundVisualStep(found,{visual:{anchor:'Search',offset:{x:0,y:0}}},cfg),point=await visualPoint(page,found,ground,cfg);assert(point.x>450&&point.y>180);await page.mouse.click(point.x,point.y);assert.equal(await frame.evaluate(()=>window.clicks),1);
});

test('canvas pixel budgets reject actual DOM geometry before requesting a screenshot',async t=>{
 const {chromium}=await import('playwright'),{canvasObservation}=await import('../src/browser-visual.js'),browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.setContent('<canvas width="800" height="400"></canvas>');const locator=page.locator('canvas');let screenshots=0;locator.screenshot=async()=>{screenshots++;throw Error('screenshot must not be requested');};
 const cfg={visual:{engine:{type:'tesseract'},language:'eng',minConfidence:.6},_runtime:{budget:{check(){},remainingMs:10000}},actionTimeoutMs:3000};
 for(const [width,height]of [[17000,40],[5000,4000]]){await locator.evaluate((canvas,{width,height})=>{canvas.style.width=width+'px';canvas.style.height=height+'px';},{width,height});await assert.rejects(canvasObservation({locator,metadata:{tag:'canvas'}},cfg),{code:'VISUAL_IMAGE_LIMIT'});}
 assert.equal(screenshots,0);
});
