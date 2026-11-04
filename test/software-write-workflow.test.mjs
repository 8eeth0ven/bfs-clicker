import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {compileBrowserWorkflow,executeBrowserWorkflow} from '../src/browser-workflows.js';
import {normalizeConfig} from '../src/asset.js';
import {openStore} from '../src/store.js';
import {temp,fixture,document,config,json,until,root} from './helpers.mjs';

const grants={allowWrite:['note_save'],allowWriteLearning:['note_save']};
const executeGrant={allowWrite:['note_save']};
function definition(){return {schemaVersion:1,id:'note_save',name:'保存 Notes',effect:'write',networkEvidence:'required',inputSchema:{type:'object',properties:{title:{type:'string',minLength:2,maxLength:24},body:{type:'string',minLength:2,maxLength:80}},required:['title','body'],additionalProperties:false},entry:{anchors:[{selector:'h1',text:'本地 Notes'},{selector:'#title',tag:'input'}]},steps:[{kind:'fill',selector:'#title',param:'title'},{kind:'fill',selector:'#body',param:'body'},{kind:'click',selector:'#save'}],assertions:[{selector:'#result',textIncludesParam:'title',timeoutMs:300},{selector:'#result',textIncludesParam:'body',timeoutMs:300}],extract:[{name:'saved',selector:'#result',kind:'text'}],samples:[{title:'alpha',body:'first note'},{title:'beta',body:'second note'}]};}
async function notesSite(t){
 const writes=[],autosaves=[],notes=new Map();let mode='normal';
 const site=await fixture(t,async({url,method},req)=>{
  if(method==='POST'&&['/api/notes','/api/autosave'].includes(url.pathname)){
   let raw='';for await(const c of req)raw+=c;const input=JSON.parse(raw);const operation=notes.has('owned')?'update':'create';notes.set('owned',input);
   if(url.pathname==='/api/autosave')autosaves.push(input);else writes.push({...input,operation});
   return {type:'application/json',status:200,body:JSON.stringify({...input,revision:writes.length})};
  }
  const saveId=mode==='missing-save'?'renamed':'save',bad=mode==='assertion'||mode==='second-fail';
  return {body:document('本地 Notes',`<input id="title" name="title" required minlength="2" maxlength="24"><textarea id="body" name="body" required minlength="2" maxlength="80"></textarea><button id="${saveId}" type="button">保存</button><output id="result" role="status">未保存</output>`,
   `document.querySelector('#${saveId}').onclick=async()=>{const input={title:document.querySelector('#title').value,body:document.querySelector('#body').value};const response=await fetch('/api/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});const saved=await response.json();document.querySelector('#result').textContent=${bad?"(input.title==='beta'||"+JSON.stringify(mode==='assertion')+")?'not-confirmed':":""}'saved '+saved.title+' '+saved.body+' #'+saved.revision;};${mode==='missing-save'?"document.querySelector('#title').oninput=()=>fetch('/api/autosave',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:document.querySelector('#title').value,body:'autosaved'})});":''}`)};
 });
 t.after(()=>notes.clear());return {...site,writes,autosaves,notes,setMode:value=>mode=value};
}
function stored(t,site,extra={}){
 const home=temp(t),runDir=path.join(home,'source'),cfg=normalizeConfig(config(site.origin,runDir,{actionProfile:'forms',fillText:true,formValues:{'#title':'seed','#body':'seed body'},actionAllowlist:['#title','#body','#save'],writeActionAllowlist:['#save'],requestAllowlist:[{method:'POST',url:site.origin+'/api/notes'},{method:'POST',url:site.origin+'/api/autosave'}],...extra})),store=openStore(cfg);
 const state={id:1,parentId:null,path:[],url:cfg.startUrl,fp:'1'.repeat(32),title:'Notes',interactives:[]};state.evidenceId=store.emit('state',{stateId:1,url:state.url,fp:state.fp});store.save({states:[state],backEdges:[]});store.update({status:'completed'});store.release();return {home,runDir,cfg};
}
function save(home,value,name='workflow.json'){const file=path.join(home,name);writeFileSync(file,JSON.stringify(value));return file;}
function notStarted(error,code){assert.equal(error.code,code);assert.deepEqual(error.writeOutcome,{status:'not_started',automaticRetry:false});return true;}

test('browser write workflow preflight requires separate execution and learning grants before any site request',async t=>{
 const site=await notesSite(t),{home,runDir}=stored(t,site),spec=definition(),specFile=save(home,spec);
 for(const [permissions,code]of [[undefined,'WORKFLOW_WRITE_NOT_APPROVED'],[executeGrant,'WORKFLOW_WRITE_LEARNING_NOT_APPROVED'],[{allowWrite:['another'],allowWriteLearning:['another']},'WORKFLOW_WRITE_NOT_APPROVED'],[null,'WORKFLOW_PERMISSIONS_INVALID'],[{allowWrite:['*'],allowWriteLearning:['*']},'WORKFLOW_PERMISSIONS_INVALID']]){
  await assert.rejects(compileBrowserWorkflow({runDir,sourceId:'notes',specFile,outputDir:path.join(home,'denied'),permissions}),error=>notStarted(error,code));
 }
 const selfGrant={...spec,permissions:grants};save(home,selfGrant);await assert.rejects(compileBrowserWorkflow({runDir,sourceId:'notes',specFile,permissions:undefined}),error=>notStarted(error,'WORKFLOW_WRITE_NOT_APPROVED'));
 save(home,{...spec,samples:[{title:'x',body:'too short'},{title:'beta',body:'second'}]});await assert.rejects(compileBrowserWorkflow({runDir,sourceId:'notes',specFile,permissions:grants}),error=>notStarted(error,'PARAMS_INVALID'));
 const denied=stored(t,site,{actionAllowlist:['#title','#body'],writeActionAllowlist:[]}),deniedFile=save(denied.home,spec);await assert.rejects(compileBrowserWorkflow({runDir:denied.runDir,sourceId:'notes',specFile:deniedFile,permissions:grants}),error=>notStarted(error,'ACTION_NOT_APPROVED'));
 assert.equal(site.requests.length,0);assert.equal(site.writes.length,0);assert.equal(site.autosaves.length,0);assert(!existsSync(path.join(home,'denied')));
});

test('browser write workflow observes exactly one save per call and reports unknown after attempted writes without retry',{timeout:90000},async t=>{
 const site=await notesSite(t),{home,runDir}=stored(t,site),spec=definition(),specFile=save(home,spec),build=path.join(home,'build');
 const learned=await compileBrowserWorkflow({runDir,sourceId:'notes',specFile,outputDir:build,permissions:grants}),cap=learned.manifest.capabilities[0],recipe=learned.recipes[cap.id];
 assert.equal(cap.effect,'write');assert.equal(recipe.spec.effect,'write');assert.deepEqual(learned.validation.writeOutcome,{status:'observed',automaticRetry:false});assert.deepEqual(site.writes.map(item=>item.operation),['create','update']);assert.deepEqual(site.writes.map(({operation,...input})=>input),spec.samples);
 for(const number of [1,2])assert.deepEqual(json(path.join(build,'sample-'+number,'write-intent.json')),{effect:'write',status:'unknown',automaticRetry:false});
 const third={title:'gamma',body:'third note'},out=path.join(home,'third'),result=await executeBrowserWorkflow({runDir,recipe,params:third,outputDir:out,permissions:executeGrant});assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(result.writeOutcome,{status:'observed',automaticRetry:false});assert.match(result.data.saved.text,/gamma third note #3/);assert.equal(site.writes.length,3);
 const before=site.requests.length;
 await assert.rejects(executeBrowserWorkflow({runDir,recipe,params:third,permissions:{}}),error=>notStarted(error,'WORKFLOW_WRITE_NOT_APPROVED'));
 await assert.rejects(executeBrowserWorkflow({runDir,recipe,params:{title:'x',body:'body'},permissions:executeGrant}),error=>notStarted(error,'PARAMS_INVALID'));
 await assert.rejects(executeBrowserWorkflow({runDir,recipe,params:third,expectedRevision:'0'.repeat(64),permissions:executeGrant}),error=>notStarted(error,'SOURCE_CHANGED'));
 assert.equal(site.requests.length,before);
 site.setMode('assertion');const failed=await executeBrowserWorkflow({runDir,recipe,params:{title:'delta',body:'fourth note'},outputDir:path.join(home,'failed'),permissions:executeGrant});assert.equal(failed.ok,false);assert.equal(failed.error.code,'RESULT_ASSERTION_FAILED');assert.deepEqual(failed.writeOutcome,{status:'unknown',automaticRetry:false});assert.equal(site.writes.length,4);assert.deepEqual(site.notes.get('owned'),{title:'delta',body:'fourth note'});assert(existsSync(path.join(home,'failed/write-intent.json')));
 site.setMode('missing-save');const autoBefore=site.autosaves.length,saveBefore=site.writes.length,autosaved=await executeBrowserWorkflow({runDir,recipe,params:{title:'epsilon',body:'fifth note'},outputDir:path.join(home,'autosave'),permissions:executeGrant});assert.equal(autosaved.ok,false);assert.deepEqual(autosaved.writeOutcome,{status:'unknown',automaticRetry:false});assert.equal(site.autosaves.length,autoBefore+1);assert.equal(site.writes.length,saveBefore,'missing save locator must not click another button or repeat');
 site.setMode('second-fail');const failedFile=save(home,{...spec,name:'failed learning'},'failed-learning.json'),learnBefore=site.writes.length;await assert.rejects(compileBrowserWorkflow({runDir,sourceId:'notes',specFile:failedFile,outputDir:path.join(home,'failed-learning'),permissions:grants}),error=>{assert.equal(error.code,'WORKFLOW_VALIDATION_FAILED');assert.deepEqual(error.writeOutcome,{status:'unknown',automaticRetry:false});return true;});assert.equal(site.writes.length,learnBefore+2);assert(!existsSync(path.join(home,'failed-learning/manifest.json')));assert.equal(json(path.join(home,'failed-learning/validation.json')).writeOutcome.status,'unknown');
 const sourceChange=JSON.parse(readFileSync(specFile,'utf8'));sourceChange.name='changed definition';writeFileSync(specFile,JSON.stringify(sourceChange));const staleBefore=site.requests.length;await assert.rejects(executeBrowserWorkflow({runDir,recipe,params:third,permissions:executeGrant}),error=>notStarted(error,'SOURCE_CHANGED'));assert.equal(site.requests.length,staleBefore);
});

async function call(client,name,args={}){const response=await client.callTool({name,arguments:args});assert(!response.isError,JSON.stringify(response));return response.structuredContent||JSON.parse(response.content[0].text);}
async function finish(client,start,name='software_operation'){return until(async()=>{const status=await call(client,name,{operationId:start.operationId});if(['failed','cancelled','interrupted'].includes(status.status))throw Error(JSON.stringify(status));return status.status==='completed'&&status;},60000);}

test('official MCP learns explicitly authorized SPA note writes and generated entry performs the fourth save',{timeout:90000},async t=>{
 const dir=temp(t),site=await notesSite(t),outputRoot=path.join(dir,'out'),configFile=path.join(dir,'config.json'),specFile=save(dir,definition());
 writeFileSync(configFile,JSON.stringify({outputRoot,artifactRoots:[dir],workflowPermissions:{notes:grants},webConfig:{actionProfile:'forms',fillText:true,formValues:{'#title':'seed','#body':'seed body'},actionAllowlist:['#title','#body','#save'],writeActionAllowlist:['#save'],requestAllowlist:[{method:'POST',url:site.origin+'/api/notes'},{method:'POST',url:site.origin+'/api/autosave'}],shotFormat:'none',requestDelayMs:0,exploreHover:false,exploreScroll:false}}));
 async function connect(args){const transport=new StdioClientTransport({command:process.execPath,args,cwd:root,stderr:'pipe'});transport.stderr.on('data',()=>{});const client=new Client({name:'authorized-note-write-client',version:'1'});await client.connect(transport);t.after(()=>client.close());return client;}
 const client=await connect([path.join(root,'src/software-mcp.js'),'--config',configFile]);
 await finish(client,await call(client,'software_discover',{sourceId:'notes',kind:'web',input:site.origin,webOptions:{maxStates:1,maxDepth:0,maxActions:20,maxDurationMs:20000}}));assert.equal(site.writes.length,0,'ordinary inventory exploration must not invoke the SPA save');
 const sources=await call(client,'software_sources'),learned=await finish(client,await call(client,'software_bind_workflow',{sourceId:'notes',expectedRevision:sources.sources[0].revision,specPath:specFile}));assert.equal(site.writes.length,2);assert.equal(learned.writeOutcome.status,'observed');
 const catalog=await call(client,'software_capabilities',{sourceId:'notes',kind:'browser',limit:100}),cap=catalog.items.find(item=>item.effect==='write');assert(cap,JSON.stringify(catalog));assert.equal(cap.readiness,'ready');
 const third=await finish(client,await call(client,'software_call',{sourceId:'notes',capabilityId:cap.id,expectedRevision:cap.revision,params:{title:'gamma',body:'third note'}}));assert.equal(third.result.result.ok,true);assert.equal(third.writeOutcome.status,'observed');assert.equal(site.writes.length,3);
 const generation=await finish(client,await call(client,'software_generate',{sourceId:'notes',expectedRevision:catalog.source.revision})),generated=await connect([generation.result.entry]),tool='cap_'+cap.id.slice(4,24),tools=(await generated.listTools()).tools;assert.equal(tools.find(item=>item.name===tool).annotations.destructiveHint,true);
 const fourth=await finish(generated,await call(generated,tool,{title:'delta',body:'fourth note'}),'operation_status');assert.equal(fourth.result.result.ok,true);assert.equal(fourth.writeOutcome.status,'observed');assert.match(fourth.result.result.data.saved.text,/delta fourth note #4/);assert.equal(site.writes.length,4);assert.deepEqual(site.writes.map(item=>item.title),['alpha','beta','gamma','delta']);assert.equal(site.autosaves.length,0);
 const revokedFile=path.join(dir,'revoked.json'),revokedConfig=JSON.parse(readFileSync(configFile,'utf8'));revokedConfig.workflowPermissions={};writeFileSync(revokedFile,JSON.stringify(revokedConfig));const revoked=await connect([path.join(root,'src/software-mcp.js'),'--config',revokedFile]);
 const deniedStart=await call(revoked,'software_call',{sourceId:'notes',capabilityId:cap.id,expectedRevision:cap.revision,params:{title:'blocked',body:'must not write'}}),denied=await until(async()=>{const state=await call(revoked,'software_operation',{operationId:deniedStart.operationId});return state.status==='failed'&&state;},10000);
 assert.match(denied.error,/WORKFLOW_WRITE_NOT_APPROVED/);assert.equal(denied.writeOutcome.status,'not_started');assert.equal(site.writes.length,4);
 const refreshed=await finish(revoked,await call(revoked,'software_refresh',{sourceId:'notes',expectedRevision:catalog.source.revision}));assert.notEqual(refreshed.result.source.revision,catalog.source.revision);
 const downgraded=(await call(revoked,'software_capabilities',{sourceId:'notes',kind:'browser',limit:100})).items.find(item=>item.id===cap.id);assert.equal(downgraded.readiness,'candidate');assert(downgraded.gaps.some(gap=>(typeof gap==='string'?gap:gap.reason)==='workflow_write_not_approved'));assert.equal(site.writes.length,4);
 const obsolete=await generated.callTool({name:tool,arguments:{title:'old',body:'old generation'}});assert.equal(obsolete.isError,true);assert.match(obsolete.content[0].text,/SOURCE_CHANGED/);assert.equal(site.writes.length,4);
});

test('write workflow cannot use an unapproved SPA save control or an unapproved POST path',{timeout:60000},async t=>{
 const site=await notesSite(t);
 for(const extra of [{writeActionAllowlist:[]},{requestAllowlist:[{method:'POST',url:site.origin+'/api/not-approved'}]}]){
  const {home,runDir}=stored(t,site,extra),specFile=save(home,definition()),out=path.join(home,'blocked-build'),before=site.writes.length;
  await assert.rejects(compileBrowserWorkflow({runDir,sourceId:'notes',specFile,outputDir:out,permissions:grants}),error=>{assert.equal(error.code,'WORKFLOW_VALIDATION_FAILED');assert.deepEqual(error.writeOutcome,{status:'unknown',automaticRetry:false});return true;});
  assert.equal(site.writes.length,before);assert.equal(site.autosaves.length,0);assert(!existsSync(path.join(out,'manifest.json')));
 }
});
