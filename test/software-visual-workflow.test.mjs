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
 const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),mode=${JSON.stringify(mode)};let query='',result='READY',selected=false;function paint(){ctx.fillStyle='white';ctx.fillRect(0,0,800,400);ctx.fillStyle='black';ctx.font='32px Arial';ctx.fillText(mode==='renamed'?'Changed':'Query',30,90);ctx.strokeStyle='black';ctx.strokeRect(220,50,530,65);ctx.fillText(query,240,90);ctx.fillText('Search',300,190);if(mode==='duplicate')ctx.fillText('Search',520,190);ctx.fillText(result,30,310);}paint();
 canvas.onclick=async event=>{const r=canvas.getBoundingClientRect(),x=(event.clientX-r.x)*800/r.width,y=(event.clientY-r.y)*400/r.height;if(y>140&&y<220&&x>250&&x<460){if(mode!=='stale'){result='RESULT '+query;paint();}await fetch('/query',{method:'POST',body:JSON.stringify({query})});}};
 canvas.onkeydown=event=>{if((event.ctrlKey||event.metaKey)&&event.key==='a'){event.preventDefault();selected=true;return;}if(event.key==='Backspace'){event.preventDefault();query=selected?'':query.slice(0,-1);selected=false;paint();}else if(event.key.length===1&&!event.ctrlKey&&!event.metaKey){event.preventDefault();query=(selected?'':query)+event.key;selected=false;paint();}};
 if(mode==='overlay'){const overlay=document.createElement('div');Object.assign(overlay.style,{position:'absolute',left:'20px',top:'20px',width:'800px',height:'400px',opacity:'.01',background:'white'});document.body.append(overlay);}
 </script>`};});return {...site,queries,setMode:value=>{mode=value}};}
const extra=site=>({actionProfile:'forms',fillText:true,fillTextValue:'seed',actionAllowlist:['#screen'],requestAllowlist:[{method:'POST',url:site.origin+'/query'}],requestDelayMs:0,shotFormat:'none',visual:{language:'eng',actions:[{...fill,effect:'read',param:undefined},{...click,effect:'read'}].map(({param,...item})=>item)}});
function saved(t,site,overrides={}){const home=temp(t),runDir=path.join(home,'source'),cfg=normalizeConfig(config(site.origin,runDir,{...extra(site),...overrides})),store=openStore(cfg),state={id:1,parentId:null,path:[],url:cfg.startUrl,fp:'1'.repeat(32),interactives:[]};state.evidenceId=store.emit('state',{stateId:1,url:state.url,fp:state.fp});store.save({states:[state],backEdges:[]});store.update({status:'completed'});store.release();return {home,runDir};}
function save(dir,value,name='spec.json'){const file=path.join(dir,name);writeFileSync(file,JSON.stringify(value));return file;}

test('real OCR grounds a canvas-only input and button, validates distinct samples and a new parameter',{timeout:90000},async t=>{
 const site=await canvasSite(t),{home,runDir}=saved(t,site),compiled=await compileBrowserWorkflow({runDir,sourceId:'canvas',specFile:save(home,spec()),outputDir:path.join(home,'build')});assert.equal(compiled.manifest.capabilities[0].readiness,'ready');assert.equal(compiled.manifest.capabilities[0].evidence.visualSteps,2);const recipe=Object.values(compiled.recipes)[0];
 const result=await executeBrowserWorkflow({runDir,recipe,params:{query:'gamma'},outputDir:path.join(home,'third')});assert.equal(result.ok,true,JSON.stringify(result));assert.match(result.data.result.text,/RESULT gamma/);assert.equal(result.data.result.provenance,'local_ocr');assert.deepEqual(site.queries.map(q=>q.query),['alpha','beta','gamma']);
 for(const mode of ['duplicate','renamed','overlay']){site.setMode(mode);const before=site.queries.length,denied=await executeBrowserWorkflow({runDir,recipe,params:{query:'blocked'},outputDir:path.join(home,mode)});assert.equal(denied.ok,false,mode);assert.equal(site.queries.length,before,mode);}
});

test('visual approval and output separation reject before launching a browser',{timeout:15000},async t=>{
 const site=await canvasSite(t),denied=saved(t,site,{visual:{language:'eng',actions:[]}});await assert.rejects(compileBrowserWorkflow({runDir:denied.runDir,sourceId:'canvas',specFile:save(denied.home,spec())}),{code:'VISUAL_ACTION_NOT_APPROVED'});assert.equal(site.requests.length,0);
 const trusted=saved(t,site),invalid=spec();invalid.assertions[0].visual.region=inputRegion;await assert.rejects(compileBrowserWorkflow({runDir:trusted.runDir,sourceId:'canvas',specFile:save(trusted.home,invalid)}),{code:'RESULT_TARGET_INVALID'});assert.equal(site.requests.length,0);
});

async function tool(client,name,args={}){const reply=await client.callTool({name,arguments:args});assert(!reply.isError,JSON.stringify(reply));return reply.structuredContent||JSON.parse(reply.content[0].text);}
async function done(client,start,status='software_operation'){return until(async()=>{const state=await tool(client,status,{operationId:start.operationId});if(['failed','cancelled'].includes(state.status))throw Error(JSON.stringify(state));return state.status==='completed'&&state;},90000);}
test('canvas-only workflow is callable through official MCP and a generated entry with new values',{timeout:120000},async t=>{
 const dir=temp(t),site=await canvasSite(t),configFile=save(dir,{outputRoot:path.join(dir,'out'),artifactRoots:[dir],webConfig:extra(site)},'config.json'),definition=save(dir,spec());
 async function connect(args){const transport=new StdioClientTransport({command:process.execPath,args,cwd:root,stderr:'pipe'});let stderr='';transport.stderr.on('data',data=>stderr+=data);const client=new Client({name:'visual-workflow-client',version:'1'});await client.connect(transport);t.after(()=>client.close());return client;}
 const client=await connect([path.join(root,'src/software-mcp.js'),'--config',configFile]);await done(client,await tool(client,'software_discover',{sourceId:'canvas',kind:'web',input:site.origin,webOptions:{maxStates:1,maxDepth:0,maxActions:10,maxDurationMs:20000}}));const sources=await tool(client,'software_sources');await done(client,await tool(client,'software_bind_workflow',{sourceId:'canvas',expectedRevision:sources.sources[0].revision,specPath:definition}));
 const catalog=await tool(client,'software_capabilities',{sourceId:'canvas',kind:'browser'}),cap=catalog.items.find(item=>item.readiness==='ready'&&item.inputSchema.properties.query);assert(cap,JSON.stringify(catalog));assert.equal(cap.evidence.visualSteps,2);
 const third=await done(client,await tool(client,'software_call',{sourceId:'canvas',capabilityId:cap.id,expectedRevision:cap.revision,params:{query:'gamma'}}));assert.equal(third.result.result.ok,true,JSON.stringify(third));assert.match(third.result.result.data.result.text,/gamma/);
 const generated=await done(client,await tool(client,'software_generate',{sourceId:'canvas',expectedRevision:catalog.source.revision})),independent=await connect([generated.result.entry]),fourth=await done(independent,await tool(independent,'cap_'+cap.id.slice(4,24),{query:'delta'}),'operation_status');assert.equal(fourth.result.result.ok,true);assert.match(fourth.result.result.data.result.text,/delta/);assert.deepEqual(site.queries.map(row=>row.query),['alpha','beta','gamma','delta']);
});

test('visual writes keep separate learning approval and persist unknown once a result receipt is missing',{timeout:90000},async t=>{
 const site=await canvasSite(t),settings=extra(site);settings.writeActionAllowlist=['#screen'];settings.visual.actions=settings.visual.actions.map(item=>({...item,effect:'write'}));const {home,runDir}=saved(t,site,settings),definition=spec();definition.effect='write';definition.assertions[0].timeoutMs=400;const file=save(home,definition),permissions={allowWrite:['canvas_query'],allowWriteLearning:['canvas_query']};
 await assert.rejects(compileBrowserWorkflow({runDir,sourceId:'canvas',specFile:file,permissions:{allowWrite:['canvas_query'],allowWriteLearning:[]}}),/WORKFLOW_WRITE_LEARNING_NOT_APPROVED/);assert.equal(site.queries.length,0);
 const compiled=await compileBrowserWorkflow({runDir,sourceId:'canvas',specFile:file,outputDir:path.join(home,'build'),permissions}),recipe=Object.values(compiled.recipes)[0];assert.equal(site.queries.length,2);site.setMode('stale');const result=await executeBrowserWorkflow({runDir,recipe,params:{query:'gamma'},outputDir:path.join(home,'missing-receipt'),permissions});assert.equal(result.ok,false);assert.deepEqual(result.writeOutcome,{status:'unknown',automaticRetry:false});assert.deepEqual(site.queries.map(row=>row.query),['alpha','beta','gamma']);assert.deepEqual(json(path.join(home,'missing-receipt/write-intent.json')),{effect:'write',status:'unknown',automaticRetry:false});
});

test('selector aliases cannot turn an input OCR echo into the result channel',{timeout:30000},async t=>{
 const site=await canvasSite(t),{home,runDir}=saved(t,site),definition=spec();definition.assertions[0].selector='canvas#screen';definition.assertions[0].visual.region=inputRegion;
 await assert.rejects(compileBrowserWorkflow({runDir,sourceId:'canvas',specFile:save(home,definition),outputDir:path.join(home,'alias')}),error=>error.code==='WORKFLOW_VALIDATION_FAILED'&&error.message.includes('RESULT_TARGET_INVALID'));assert.equal(site.queries.length,0);
});
