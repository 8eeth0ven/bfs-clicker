import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {chromium} from 'playwright';
import {normalizeConfig} from '../src/asset.js';
import {createPolicy} from '../src/policy.js';
import {openStore} from '../src/store.js';
import {compileBrowserWorkflow,executeBrowserWorkflow} from '../src/browser-workflows.js';
import {normalizeWorkflowPermissions,assertClosedStagePermission} from '../src/workflow-permissions.js';
import {closedLocator} from '../src/closed-shadow.js';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {closedDescriptor} from '../src/closed-shadow.js';
import {temp,fixture,document,root,until,json} from './helpers.mjs';

const primary={id:'wizard',hosts:['#host'],maxNodes:128},other={id:'other',hosts:['#other'],maxNodes:128};
const target=id=>closedDescriptor(primary,'#'+id);
function evidence(name,value){const dir=process.env.BFS_CLOSED_MULTISTAGE_EVIDENCE_DIR;if(!dir)return;mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(path.join(dir,name+'.json'),JSON.stringify(value,null,2)+'\n',{mode:0o600});}
async function call(client,name,args={}){const response=await client.callTool({name,arguments:args});assert(!response.isError,JSON.stringify(response));return response.structuredContent||JSON.parse(response.content[0].text);}
async function terminal(client,op,name='software_operation'){return until(async()=>{const result=await call(client,name,{operationId:op.operationId});return ['completed','failed','cancelled','interrupted'].includes(result.status)&&result;},60000);}
const sdkCleanup=[];
async function connect(t,args){
 const transport=new StdioClientTransport({command:process.execPath,args,cwd:root,stderr:'pipe'}),chunks=[];transport.stderr.on('data',chunk=>chunks.push(chunk));const client=new Client({name:'closed-multistage-sdk',version:'1'});let child,closed,result;
 const capture=()=>{if(!child&&transport._process){child=transport._process;closed=new Promise(resolve=>child.once('close',(code,signal)=>{result={code,signal};resolve();}));}};
 const start=transport.start.bind(transport);transport.start=async()=>{const pending=start();capture();await pending;capture();};
 t.after(async()=>{capture();await client.close();if(child){let timer;try{await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned MCP child close timeout')),5000);})]);}finally{clearTimeout(timer);}assert.deepEqual(result,{code:0,signal:null});}assert(child,'Owned MCP child was captured');assert.equal(Buffer.concat(chunks).length,0);sdkCleanup.push({entry:args.includes('--config')?'unified':'generated',closed:true,...result,stderrBytes:Buffer.concat(chunks).length});evidence('sdk-cleanup',{status:'passed',clients:sdkCleanup});});
 await client.connect(transport);capture();return{client,stderr:()=>Buffer.concat(chunks).toString()};
}

async function wizard(t){
 const business=[],decoys=[],observations=[];let mode='normal';
 const site=await fixture(t,async({url},request)=>{
  if(url.pathname==='/api/query'||url.pathname==='/api/decoy'){
   let raw='';for await(const chunk of request)raw+=chunk;const body=JSON.parse(raw);(url.pathname==='/api/query'?business:decoys).push(body);
   return {type:'application/json',body:JSON.stringify({text:'RESULT '+body.first+' / '+body.second})};
  }
  if(url.pathname==='/api/observe'){let raw='';for await(const chunk of request)raw+=chunk;observations.push(JSON.parse(raw));return {type:'application/json',body:'{}'};}
  const first='<section id="form1" role="search"><h2 id="phase">First form</h2><input id="first" aria-label="First"><button id="next" type="button">Next</button></section>',second='<section id="form2" role="search"><h2 id="phase">Second form</h2><input id="second" aria-label="Second"><button id="search" type="button">Search</button></section>';
  return {body:document('Closed wizard','<div id="host" class="wizard"></div><div id="other" class="wizard"></div><output id="result" role="status">RESULT none</output>',`
   const mode=${JSON.stringify(mode)},retired=[],trace=[];let first='',scope;
   const decoy=document.querySelector('#other').attachShadow({mode:'closed'});decoy.innerHTML=${JSON.stringify(first+second)};
   for(const button of decoy.querySelectorAll('button'))button.onclick=()=>fetch('/api/decoy',{method:'POST',body:JSON.stringify({first:'decoy',second:'decoy'})});
   function replace(markup){const host=document.querySelector('#host'),old=scope;retired.push(host);if(old)retired.push(...old.querySelectorAll('input,button'));const fresh=host.cloneNode();host.replaceWith(fresh);scope=fresh.attachShadow({mode:'closed'});scope.innerHTML=markup;if(mode==='large-contract')scope.querySelector('#phase').setAttribute('aria-label','x'.repeat(70000));}
   scope=document.querySelector('#host').attachShadow({mode:'closed'});scope.innerHTML='<h2 id="phase">Entry</h2><button id="start" type="button">Start</button>';
   if(mode==='large-contract')scope.querySelector('#phase').setAttribute('aria-label','x'.repeat(70000));scope.querySelector('#start').onclick=()=>{trace.push('start');if(mode==='noop')return;if(mode==='dialog')confirm('Unexpected confirmation');if(mode==='wrong-url')history.pushState({},'', '/wrong');if(mode==='owner-swap'){const a=document.querySelector('#host'),b=document.querySelector('#other');a.id='temporary';b.id='host';a.id='other';return;}replace(${JSON.stringify(first)});if(mode==='cross-policy-target')scope.querySelector('#first').replaceWith(decoy.querySelector('#first'));scope.querySelector('#first').addEventListener('input',event=>{if(!event.target.value)return;if(mode==='field-replace'){const old=event.target,fresh=old.cloneNode();fresh.value=old.value;old.replaceWith(fresh);}if(mode==='host-drift')document.querySelector('#host').className='changed';if(mode==='preclick-foreign'&&!scope.querySelector('#stash')){const stash=document.createElement('div');stash.id='stash';stash.hidden=true;stash.append(decoy.querySelector('#second'));scope.append(stash);}});scope.querySelector('#next').onclick=()=>{trace.push('next');if(mode==='preclick-foreign')fetch('/api/observe',{method:'POST',body:JSON.stringify({unexpected:'next clicked after known foreign input moved'})});const washed=scope.querySelector('#stash #second');const reuse=scope.querySelector('#first');first=reuse.value;replace(${JSON.stringify(second)});if(mode==='preclick-foreign'&&washed)scope.querySelector('#second').replaceWith(washed);if(mode==='same-policy-reuse'){reuse.id='second';reuse.setAttribute('aria-label','Second');scope.querySelector('#second').replaceWith(reuse);}scope.querySelector('#search').onclick=async()=>{trace.push('search');const body={first,second:scope.querySelector('#second').value,trace:[...trace],retiredAllDetached:retired.every(node=>!node.isConnected)};const result=await fetch('/api/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());document.querySelector('#result').textContent=result.text;scope.querySelector('#second').disabled=true;scope.querySelector('#search').disabled=true;scope.querySelector('#phase').textContent='Complete';};};};
  `)};
 });
 return {...site,business,decoys,observations,setMode:value=>mode=value};
}
function configFor(site){return {actionProfile:'forms',fillText:true,formValues:{[target('first').selector]:'seed-first',[target('second').selector]:'seed-second'},closedShadowRoots:[primary,other],excludeSelectors:['#other'],actionAllowlist:['start','first','next','second','search'].map(id=>target(id).selector),requestAllowlist:[{method:'POST',url:site.origin+'/api/query'},{method:'POST',url:site.origin+'/api/observe'}],shotFormat:'none',exploreHover:false,exploreScroll:false,requestDelayMs:0,maxRetries:0};}
function definition(site){return {schemaVersion:1,id:'closed_two_forms',effect:'read',executionMode:'closed-stages-v1',closedStages:{schemaVersion:1,stages:[['entry',0,'Entry'],['first',1,'First form'],['second',3,'Second form'],['complete',5,'Complete']].map(([id,startStep,text],index)=>({id,startStep,document:index?'same':'initial',url:site.origin+'/',anchors:[{...target('phase'),tag:'h2',text}]}))},samples:[{first:'alpha',second:'one'},{first:'beta',second:'two'}],inputSchema:{type:'object',properties:{first:{type:'string',minLength:1,maxLength:32},second:{type:'string',minLength:1,maxLength:32}},required:['first','second'],additionalProperties:false},entry:{url:site.origin+'/',anchors:[{...target('start'),tag:'button',text:'Start'}]},steps:[{...target('start'),kind:'click'},{...target('first'),kind:'fill',param:'first'},{...target('next'),kind:'click'},{...target('second'),kind:'fill',param:'second'},{...target('search'),kind:'click'}],assertions:[{selector:'#result',textIncludesParam:'first',changedFromBefore:true},{selector:'#result',textIncludesParam:'second',changedFromBefore:true}],extract:[{selector:'#result',kind:'text',name:'result'}]};}

test('closed rebuilt root Start and Next support two samples plus unified and generated MCP without retaining old controls',{timeout:120000},async t=>{
 const home=temp(t),site=await wizard(t),outputRoot=path.join(home,'software'),configFile=path.join(home,'config.json');writeFileSync(configFile,JSON.stringify({outputRoot,artifactRoots:[home],workflowPermissions:{closed_stages:{allowClosedStages:['closed_two_forms']}},webConfig:configFor(site)}));
 const unified=await connect(t,[path.join(root,'src/software-mcp.js'),'--config',configFile]),client=unified.client;
 const discover=await terminal(client,await call(client,'software_discover',{sourceId:'closed_stages',kind:'web',input:site.origin,webOptions:{maxStates:8,maxDepth:8,maxActions:15,maxDurationMs:20000}}));assert.equal(discover.status,'completed',JSON.stringify(discover));
 assert.deepEqual(site.business,[{first:'seed-first',second:'seed-second',trace:['start','next','search'],retiredAllDetached:true}]);
 const specFile=path.join(home,'workflow.json');writeFileSync(specFile,JSON.stringify(definition(site)));const sources=await call(client,'software_sources');
 const learning=await terminal(client,await call(client,'software_bind_workflow',{sourceId:'closed_stages',expectedRevision:sources.sources[0].revision,specPath:specFile}));
 evidence('actual-sdk',{status:learning.status==='completed'?'learning_passed':'learning_failed',discovery:site.business,learning,queries:site.business.length,decoys:site.decoys.length,stderrBytes:Buffer.byteLength(unified.stderr())});
 assert.equal(learning.status,'completed',JSON.stringify(learning));
 const catalog=await call(client,'software_capabilities',{sourceId:'closed_stages',kind:'browser'}),cap=catalog.items.find(item=>item.readiness==='ready'&&item.inputSchema.properties.first);assert(cap);assert(cap.modality.channels.includes('closed_shadow_dom'));assert(cap.fidelity.inputText.every(item=>item.contract==='dom_value_echo_required'));assert(cap.fidelity.outputs.every(item=>item.sourceCodepointsProven===false));
 const third=await terminal(client,await call(client,'software_call',{sourceId:'closed_stages',capabilityId:cap.id,expectedRevision:cap.revision,params:{first:'gamma',second:'three'}}));assert.equal(third.status,'completed',JSON.stringify(third));assert.equal(third.result.result.data.result.text,'RESULT gamma / three');
 const generated=await terminal(client,await call(client,'software_generate',{sourceId:'closed_stages',expectedRevision:catalog.source.revision}));assert.equal(generated.status,'completed');const independent=await connect(t,[generated.result.entry]);
 const fourth=await terminal(independent.client,await call(independent.client,'cap_'+cap.id.slice(4,24),{first:'delta',second:'four'}),'operation_status');assert.equal(fourth.status,'completed',JSON.stringify(fourth));assert.equal(fourth.result.result.data.result.text,'RESULT delta / four');
 assert.deepEqual(site.business.map(({first,second})=>[first,second]),[['seed-first','seed-second'],['alpha','one'],['beta','two'],['gamma','three'],['delta','four']]);assert(site.business.every(item=>item.retiredAllDetached&&JSON.stringify(item.trace)===JSON.stringify(['start','next','search'])));assert.equal(site.decoys.length,0);assert.equal(unified.stderr(),'');assert.equal(independent.stderr(),'');
 evidence('actual-sdk',{status:'passed',discoveryRequests:1,learningRequests:2,unifiedRequests:1,generatedRequests:1,business:site.business,decoys:0,stderrBytes:[0,0],retiredHostsAndFieldsDetached:true});
});

const grants={allowClosedStages:['closed_two_forms']};
async function stored(t,site,patch={}){
 const home=temp(t),runDir=path.join(home,'source'),config=normalizeConfig({...configFor(site),startUrl:site.origin,outputDir:runDir,...patch});
 const store=openStore(config);store.save({states:[{id:1,parentId:null,path:[],url:config.startUrl,fp:'1'.repeat(32),title:'Owned closed wizard',interactives:[]}],backEdges:[]});store.update({status:'completed'});store.release();
 const spec=definition(site),specFile=path.join(home,'workflow.json');writeFileSync(specFile,JSON.stringify(spec));
 return {home,runDir,specFile,spec};
}

test('stage authority is an optional exact startup grant and cannot be inferred from write or definition',()=>{
 assert.deepEqual(normalizeWorkflowPermissions(),{allowWrite:[],allowWriteLearning:[]});assert.deepEqual(normalizeWorkflowPermissions({allowClosedStages:['b','a','b']}),{allowWrite:[],allowWriteLearning:[],allowClosedStages:['a','b']});
 assert.doesNotThrow(()=>assertClosedStagePermission(grants,'closed_two_forms'));
 for(const permission of [{},{allowWrite:['closed_two_forms']},{allowClosedStages:['other']}])assert.throws(()=>assertClosedStagePermission(permission,'closed_two_forms'),{code:'WORKFLOW_CLOSED_STAGES_NOT_APPROVED'});
 for(const ids of [null,['*'],['__proto__'],Array(101).fill('a')])assert.throws(()=>normalizeWorkflowPermissions({allowClosedStages:ids}),{code:'WORKFLOW_PERMISSIONS_INVALID'});
});

test('stage missing or revoked grant and malformed plan fail before UI; legacy mode keeps its lifetime preflight',{timeout:60000},async t=>{
 const site=await wizard(t),source=await stored(t,site);
 await assert.rejects(compileBrowserWorkflow({...source,sourceId:'stages',permissions:{},outputDir:path.join(source.home,'unapproved')}),{code:'WORKFLOW_CLOSED_STAGES_NOT_APPROVED'});assert.equal(site.business.length,0);
 for(const mutate of [s=>s.closedStages.schemaVersion=2,s=>s.closedStages.stages[1].startStep=2,s=>s.closedStages.stages[1].document='auto',s=>s.closedStages.stages[1].url=site.origin+'/wrong',s=>s.closedStages.stages.pop(),s=>s.executionMode='other']){
  const spec=structuredClone(source.spec);mutate(spec);if(spec.closedStages?.stages[1].url.endsWith('/wrong'))spec.closedStages.stages[1].url='https://outside.invalid/';
  const specFile=path.join(source.home,'invalid-'+Math.random()+'.json');writeFileSync(specFile,JSON.stringify(spec));await assert.rejects(compileBrowserWorkflow({...source,specFile,sourceId:'stages',permissions:grants,outputDir:path.join(source.home,'bad-'+Math.random())}),{code:'CLOSED_STAGE_SPEC_INVALID'});assert.equal(site.business.length,0);
 }
 const legacy=structuredClone(source.spec);delete legacy.executionMode;delete legacy.closedStages;const legacyFile=path.join(source.home,'legacy.json');writeFileSync(legacyFile,JSON.stringify(legacy));await assert.rejects(compileBrowserWorkflow({...source,specFile:legacyFile,sourceId:'stages',permissions:grants,outputDir:path.join(source.home,'legacy')}),{code:'WORKFLOW_VALIDATION_FAILED'});assert.equal(site.business.length,0);
 const compiled=await compileBrowserWorkflow({...source,sourceId:'stages',permissions:grants,outputDir:path.join(source.home,'build')}),recipe=Object.values(compiled.recipes)[0];assert.equal(recipe.schemaVersion,2);assert.equal(recipe.contracts.closedStages.stages.length,4);assert.equal(recipe.contracts.closedStages.contractDigest.length,64);assert(!/backendNodeId|objectId/.test(JSON.stringify(recipe)));
 const before=site.business.length;await assert.rejects(executeBrowserWorkflow({...source,recipe,params:{first:'gamma',second:'three'},permissions:{}}),{code:'WORKFLOW_CLOSED_STAGES_NOT_APPROVED'});assert.equal(site.business.length,before);
 await assert.rejects(executeBrowserWorkflow({...source,recipe:{...recipe,schemaVersion:1},params:{first:'gamma',second:'three'},permissions:grants}),{code:'RECIPE_INVALID'});assert.equal(site.business.length,before);
});

test('same-name approved root migration, intra-stage reconstruction, host drift, wrong URL, dialog and unchanged state never authorize the next stage',{timeout:90000},async t=>{
 const site=await wizard(t),source=await stored(t,site),compiled=await compileBrowserWorkflow({...source,sourceId:'stages',permissions:grants,outputDir:path.join(source.home,'build')}),recipe=Object.values(compiled.recipes)[0],records=[];
 for(const mode of ['owner-swap','cross-policy-target','preclick-foreign','field-replace','host-drift','wrong-url','dialog','noop']){
  site.setMode(mode);const before=site.business.length,result=await executeBrowserWorkflow({...source,recipe,permissions:grants,params:{first:'gamma',second:'three'},outputDir:path.join(source.home,mode)});
  assert.equal(result.ok,false,mode+' '+JSON.stringify(result));assert.equal(site.business.length,before,mode);assert.equal(site.decoys.length,0);assert.equal(site.observations.length,0,'No Next dispatch after pre-click foreign movement');records.push({mode,error:result.error.code,businessDelta:0,decoyDelta:0});
 }
 evidence('negative',{status:'passed',scope:'actual_local_chromium',records});
});

test('unknown physical click outcome cannot return a stage permit or replace the original backend',{timeout:30000},async t=>{
 const site=await wizard(t),browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.goto(site.origin);const config=normalizeConfig({...configFor(site),startUrl:site.origin});config._policy=createPolicy(config);
 const original=page.mouse.click.bind(page.mouse);let dispatches=0;page.mouse.click=async(...args)=>{dispatches++;await original(...args);throw new Error('synthetic unknown delivery')};
 await assert.rejects(closedLocator(page,target('start'),config).clickForWorkflowStage(),/synthetic unknown/);assert.equal(dispatches,1);assert.equal(site.business.length,0);await assert.rejects(closedLocator(page,target('first'),config).count(),{code:'CLOSED_SHADOW_ROOT_REBUILT'});
});

async function navigationWizard(t){
 const business=[];const site=await fixture(t,async({url},request)=>{
  if(url.pathname==='/api/query'){let raw='';for await(const chunk of request)raw+=chunk;const body=JSON.parse(raw);business.push(body);return{type:'application/json',body:JSON.stringify({text:'RESULT '+body.first+' / '+body.second})};}
  const markup=url.pathname==='/first'?'<section id="form1" role="search"><h2 id="phase">First form</h2><input id="first" aria-label="First"><button id="next" type="button">Next</button></section>':url.pathname==='/second'?'<section id="form2" role="search"><h2 id="phase">Second form</h2><input id="second" aria-label="Second"><button id="search" type="button">Search</button></section>':'<h2 id="phase">Entry</h2><button id="start" type="button">Start</button>';
  return {body:document('Closed navigation wizard','<div id="host" class="wizard"></div><div id="other" class="wizard"></div><output id="result" role="status">RESULT none</output>',`
   const scope=document.querySelector('#host').attachShadow({mode:'closed'});scope.innerHTML=${JSON.stringify(markup)};document.querySelector('#other').attachShadow({mode:'closed'}).innerHTML='<p>Other approved scope</p>';
   const start=scope.querySelector('#start'),next=scope.querySelector('#next'),search=scope.querySelector('#search');
   if(start)start.onclick=()=>{sessionStorage.setItem('trace',JSON.stringify(['start']));location.assign('/first');};
   if(next)next.onclick=()=>{sessionStorage.setItem('first',scope.querySelector('#first').value);sessionStorage.setItem('trace',JSON.stringify([...JSON.parse(sessionStorage.getItem('trace')),'next']));location.assign('/second');};
   if(search)search.onclick=async()=>{const body={first:sessionStorage.getItem('first'),second:scope.querySelector('#second').value,trace:[...JSON.parse(sessionStorage.getItem('trace')),'search']};const result=await fetch('/api/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());document.querySelector('#result').textContent=result.text;scope.querySelector('#phase').textContent='Complete';scope.querySelector('#second').disabled=true;search.disabled=true;};
  `)};
 });return{...site,business};
}

test('declared new-document stages bind fresh closed generations at fixed approved URLs and never inherit old input receipts',{timeout:60000},async t=>{
 const site=await navigationWizard(t),source=await stored(t,site,{requestAllowlist:[...configFor(site).requestAllowlist,{method:'GET',url:site.origin+'/first'},{method:'GET',url:site.origin+'/second'}]});
 // The source author explicitly approves the document requests and each fixed
 // stage URL. Parameters remain UI inputs, never stage URLs or root selectors.
 source.spec.closedStages.stages[1].document='new';source.spec.closedStages.stages[1].url=site.origin+'/first';source.spec.closedStages.stages[2].document='new';source.spec.closedStages.stages[2].url=site.origin+'/second';source.spec.closedStages.stages[3].url=site.origin+'/second';writeFileSync(source.specFile,JSON.stringify(source.spec));
 const compiled=await compileBrowserWorkflow({...source,sourceId:'stages',permissions:grants,outputDir:path.join(source.home,'build')}),recipe=Object.values(compiled.recipes)[0];
 const result=await executeBrowserWorkflow({...source,recipe,permissions:grants,params:{first:'gamma',second:'three'},outputDir:path.join(source.home,'third')});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.data.result.text,'RESULT gamma / three');
 assert.deepEqual(site.business,[{first:'alpha',second:'one',trace:['start','next','search']},{first:'beta',second:'two',trace:['start','next','search']},{first:'gamma',second:'three',trace:['start','next','search']}]);evidence('new-document',{status:'passed',twoSamplesAndThird:true,business:site.business,declaredDocuments:['initial','new','new','same']});
});

test('workflow candidate commit and rollback detach faults poison the lease instead of refreshing permission',{timeout:30000},async t=>{
 for(const mode of ['commit','rollback']){
  const site=await wizard(t),browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.goto(site.origin);const config=normalizeConfig({...configFor(site),startUrl:site.origin});config._policy=createPolicy(config);
  const attach=page.context().newCDPSession.bind(page.context());let sessions=0;page.context().newCDPSession=async(...args)=>{const session=await attach(...args),id=++sessions;if(id===(mode==='commit'?1:2))session.detach=async()=>{throw new Error('synthetic detach failure')};return session;};
  const receipt=await closedLocator(page,target('start'),config).clickForWorkflowStage();await assert.rejects(receipt.promote({document:'same',url:site.origin+'/'},async()=>{if(mode==='rollback')throw new Error('synthetic admission failure');assert.equal(await closedLocator(page,target('first'),config).count(),1);}),{code:'CLOSED_SHADOW_CLEANUP_FAILED'});
  const before=sessions;await assert.rejects(closedLocator(page,target('first'),config).count(),{code:'CLOSED_SHADOW_CLEANUP_FAILED'});assert.equal(sessions,before);assert.equal(site.business.length,0);await browser.close();
 }
});

test('timed out stage click is unknown, closes its page, and cannot return a late transition receipt',{timeout:15000},async t=>{
 const site=await wizard(t),browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.goto(site.origin);const config=normalizeConfig({...configFor(site),startUrl:site.origin});config._policy=createPolicy(config);let clicks=0;
 const click=page.mouse.click.bind(page.mouse);page.mouse.click=async(...args)=>{clicks++;await click(...args);await new Promise(()=>{});};const at=Date.now();
 await assert.rejects(closedLocator(page,target('start'),config).clickForWorkflowStage({timeout:1000}),{code:'CLOSED_SHADOW_TIMEOUT'});assert(Date.now()-at<2000);await until(()=>page.isClosed(),1000);assert.equal(clicks,1);assert.equal(site.business.length,0);assert.equal(site.decoys.length,0);
});

test('wrong document declaration and exhausted global action budget cannot promote or reach business submit',{timeout:30000},async t=>{
 for(const mode of ['document','budget']){
  const site=await wizard(t),source=await stored(t,site,mode==='budget'?{maxActions:1}:{});
  if(mode==='document'){source.spec.closedStages.stages[1].document='new';writeFileSync(source.specFile,JSON.stringify(source.spec));}
  const outputDir=path.join(source.home,'failed');await assert.rejects(compileBrowserWorkflow({...source,sourceId:'stages',permissions:grants,outputDir}),{code:'WORKFLOW_VALIDATION_FAILED'});const validation=json(path.join(outputDir,'validation.json'));assert.equal(validation.runs.length,1);assert.equal(validation.runs[0].error.code,mode==='document'?'CLOSED_SHADOW_STAGE_DOCUMENT_CHANGED':'max_actions');assert.equal(site.business.length,0);assert.equal(site.decoys.length,0);
 }
});

test('a same-policy control can be reused across an explicit stage while foreign-policy controls cannot inherit that scope',{timeout:30000},async t=>{
 const site=await wizard(t);site.setMode('same-policy-reuse');const source=await stored(t,site),compiled=await compileBrowserWorkflow({...source,sourceId:'stages',permissions:grants,outputDir:path.join(source.home,'build')}),recipe=Object.values(compiled.recipes)[0];
 const result=await executeBrowserWorkflow({...source,recipe,permissions:grants,params:{first:'gamma',second:'three'},outputDir:path.join(source.home,'call')});assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(site.business.map(row=>[row.first,row.second]),[['alpha','one'],['beta','two'],['gamma','three']]);assert(site.business.every(row=>!row.retiredAllDetached));assert.equal(site.decoys.length,0);
});

test('stage contract accumulation stops at the existing certificate ceiling with no new certificate or ready publication',{timeout:30000},async t=>{
 const site=await wizard(t),source=await stored(t,site),compiled=await compileBrowserWorkflow({...source,sourceId:'stages',permissions:grants,outputDir:path.join(source.home,'existing')}),recipe=Object.values(compiled.recipes)[0];
 const directory=path.join(source.runDir,'private/browser-workflows'),files=readdirSync(directory),before=new Map(files.map(file=>[file,readFileSync(path.join(directory,file))]));assert.equal(files.length,1);
 site.setMode('large-contract');const spec=structuredClone(source.spec);for(const stage of spec.closedStages.stages)stage.anchors=Array.from({length:8},()=>({...stage.anchors[0]}));const specFile=path.join(source.home,'large.json');writeFileSync(specFile,JSON.stringify(spec));const outputDir=path.join(source.home,'oversize'),requests=site.business.length;
 await assert.rejects(compileBrowserWorkflow({...source,specFile,sourceId:'stages',permissions:grants,outputDir}),{code:'WORKFLOW_VALIDATION_FAILED'});const failure=json(path.join(outputDir,'validation.json'));assert.equal(failure.runs[0].error.code,'WORKFLOW_CERTIFICATE_LIMIT');assert.equal(site.business.length,requests);assert.equal(existsSync(path.join(outputDir,'manifest.json')),false);assert.equal(existsSync(path.join(outputDir,'recipes.json')),false);assert.deepEqual(readdirSync(directory),files);for(const file of files)assert.deepEqual(readFileSync(path.join(directory,file)),before.get(file));assert.equal(recipe.schemaVersion,2);
});
