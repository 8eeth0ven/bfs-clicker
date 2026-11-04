import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {writeFileSync,readFileSync,mkdirSync,existsSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/client';import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {runAsset} from '../src/runner.js';import {planBrowserWorkflows} from '../src/workflow-planner.js';import {compileBrowserWorkflow,executeBrowserWorkflow} from '../src/browser-workflows.js';
import {temp,json,root,until,lines} from './helpers.mjs';
import {virtualSite,virtualWebConfig,cityWire,cityLabel} from './virtual-aria-fixture.mjs';

async function call(client,name,args={}){const result=await client.callTool({name,arguments:args});assert(!result.isError,JSON.stringify(result));return result.structuredContent||JSON.parse(result.content[0].text);}
async function done(client,operation,name='software_operation'){return until(async()=>{const result=await call(client,name,{operationId:operation.operationId});if(['failed','cancelled','interrupted'].includes(result.status))throw Error(JSON.stringify(result));return result.status==='completed'&&result;},60000);}
async function connect(t,args){const transport=new StdioClientTransport({command:process.execPath,args,cwd:root,stderr:'pipe'});transport.stderr.on('data',()=>{});const client=new Client({name:'virtual-aria-test',version:'1'});await client.connect(transport);t.after(()=>client.close());return client;}
function candidate(plan){const item=plan.items.find(item=>item.inputSchema.properties.city);assert(item,JSON.stringify(plan));return item;}
function samples(){return [{city:cityWire(5)},{city:cityWire(9)}];}
function saveEvidence(name,data){if(!process.env.BFS_VIRTUAL_TEST_EVIDENCE_DIR)return;const directory=path.resolve(process.env.BFS_VIRTUAL_TEST_EVIDENCE_DIR);mkdirSync(directory,{recursive:true,mode:0o700});writeFileSync(path.join(directory,name+'.json'),JSON.stringify(data,null,2),{mode:0o600});}

test('actual 12-item recycled ARIA list discovers its complete domain, learns 5/9, unified calls12 and generated calls2',{timeout:120000},async t=>{
 const home=temp(t),site=await virtualSite(t),outputRoot=path.join(home,'out'),configFile=path.join(home,'software.json');writeFileSync(configFile,JSON.stringify({outputRoot,artifactRoots:[home],webConfig:virtualWebConfig(site)}));
 const client=await connect(t,[path.join(root,'src/software-mcp.js'),'--config',configFile]);
 await done(client,await call(client,'software_discover',{sourceId:'virtual',kind:'web',input:site.origin,webOptions:{maxStates:2,maxDepth:1,maxActions:40,maxDurationMs:20000}}));
 assert.equal(site.opens.length,1);assert.equal(site.selected.length,0);assert.equal(site.queries.length,0);
 const before=site.requests.length,planned=await call(client,'software_workflows',{sourceId:'virtual'}),item=candidate(planned);assert.equal(site.requests.length,before,'offline planning must not open or scroll');assert.deepEqual(item.inputSchema.properties.city.enum,Array.from({length:12},(_,i)=>cityWire(i+1)));assert(!JSON.stringify(item).includes('selector'));
 const source=path.join(outputRoot,'runs/virtual'),checkpoint=json(path.join(source,'private/checkpoint.json')),opened=checkpoint.states.find(state=>state.parentId===1),combo=opened.interactives.find(item=>item.selector==='#category');assert.equal(combo.ariaChoices.domainEvidence,'bounded_virtual_scan');assert.equal(combo.ariaChoices.options.length,12);assert.equal(combo.ariaChoices.certificate.executionId,checkpoint.states.find(state=>state.id===1).interactives.find(item=>item.selector==='#category').evidenceId);
 const target=item.outputTargets.find(target=>target.label==='City result');assert(target,JSON.stringify(item));
 await done(client,await call(client,'software_bind_workflow',{sourceId:'virtual',candidateId:item.id,expectedRevision:planned.source.revision,samples:samples(),resultAssertions:[{outputTargetId:target.id,param:'city',representation:'optionLabel',changedFromBefore:true}]}));
 assert.deepEqual(site.queries.map(query=>query.city),[cityWire(5),cityWire(9)]);
 const catalog=await call(client,'software_capabilities',{sourceId:'virtual',kind:'browser',limit:100}),capability=catalog.items.find(item=>item.readiness==='ready'&&item.inputSchema.properties.city);assert(capability,JSON.stringify(catalog));
 const third=await done(client,await call(client,'software_call',{sourceId:'virtual',capabilityId:capability.id,expectedRevision:capability.revision,params:{city:cityWire(12)}}));assert.equal(third.result.result.ok,true);assert.match(third.result.result.data.result.text,/RESULT City12 #/);
 const generation=await done(client,await call(client,'software_generate',{sourceId:'virtual',expectedRevision:catalog.source.revision})),generated=await connect(t,[generation.result.entry]);
 const fourth=await done(generated,await call(generated,'cap_'+capability.id.slice(4,24),{city:cityWire(2)}),'operation_status');assert.equal(fourth.result.result.ok,true);assert.match(fourth.result.result.data.result.text,/RESULT City02 #/);
 assert.deepEqual(site.queries.map(query=>query.city),[5,9,12,2].map(cityWire));assert.equal(site.queries.length,4);assert.equal(site.opens.length,5);assert.deepEqual(site.selected.map(item=>item.value),[5,9,12,2].map(cityWire));
 assert(site.renders.length>12);assert(site.renders.every(item=>item.mounted<=4));assert.equal(new Set(site.renders.flatMap(item=>item.slotIds)).size,4);assert(site.renders.some(item=>item.positions.includes(12)));assert(site.scrolls.length>0);assert(site.scrolls.every(item=>item.unrelated===0));
 saveEvidence('positive',{status:'passed',scope:'real_local_chromium_unified_and_generated_sdk',businessQueries:site.queries,opens:site.opens,selected:site.selected,scrolls:site.scrolls,renders:site.renders,completeObservedChoices:combo.ariaChoices,capability,unifiedData:third.result.result.data,generatedData:fourth.result.result.data});
 const eventsFile=path.join(source,'private/events.jsonl'),events=readFileSync(eventsFile,'utf8');writeFileSync(eventsFile,events.split('\n').filter(line=>!line.includes('"kind":"aria_virtual_domain_complete"')).join('\n'));const missing=await planBrowserWorkflows({runDir:source,sourceId:'virtual'});assert(!missing.items.some(item=>item.inputSchema.properties.city),'missing scan certificate cannot yield a virtual candidate');
});

async function learnedSource(t,site){
 const home=temp(t),runDir=path.join(home,'source');await runAsset({...virtualWebConfig(site),startUrl:site.origin,outputDir:runDir,limitMode:'custom',maxStates:2,maxDepth:1,maxActions:40,maxRequests:250,maxStatesPerHost:3,maxDurationMs:20000},{log:()=>{}});
 const planned=await planBrowserWorkflows({runDir,sourceId:'virtual'}),item=candidate(planned),spec=structuredClone(planned.specs[item.id]),target=spec.outcomeCandidates.find(target=>target.semanticLabel==='City result');assert(target);delete spec.outcomeCandidates;
 spec.effect='read';spec.samples=samples();spec.assertions=[{selector:target.selector,textIncludesParam:'city',paramRepresentation:'optionLabel',changedFromBefore:true,timeoutMs:200}];spec.extract=[{name:'result',selector:target.selector,kind:'text'}];const specFile=path.join(home,'spec.json');writeFileSync(specFile,JSON.stringify(spec));
 const compiled=await compileBrowserWorkflow({runDir,sourceId:'virtual',specFile,outputDir:path.join(home,'build')}),capability=compiled.manifest.capabilities[0];return {home,runDir,specFile,spec,recipe:compiled.recipes[capability.id]};
}

test('virtual identity/index/wire/coverage/overlay drift and incorrect selection or business output never retry submit',{timeout:120000},async t=>{
 const site=await virtualSite(t),stored=await learnedSource(t,site);assert.equal(site.queries.length,2);
 const cases=[];
 for(const mode of ['prefix-drift','identity-drift','duplicate-index','duplicate-wire','missing-index','unknown-size','infinite','stuck','overlay','bad-proof','auto-noop','same-noop','wrong-result','prefix-result']){
  site.setMode(mode);const queryCount=site.queries.length,openCount=site.opens.length,selectedCount=site.selected.length;
  const result=await executeBrowserWorkflow({...stored,params:{city:cityWire(12)},outputDir:path.join(stored.home,mode)});assert.equal(result.ok,false,mode+' '+JSON.stringify(result));
  assert.equal(site.opens.length,openCount+1,mode+' must never reopen');assert.equal(site.queries.length,queryCount+(['auto-noop','same-noop','wrong-result','prefix-result'].includes(mode)?1:0),mode+' must never retry business submit');
  assert.equal(site.selected.length,selectedCount+(['bad-proof','auto-noop','same-noop','wrong-result','prefix-result'].includes(mode)?1:0),mode+' must never choose an unsafe target or repeat selection');
  const scrollActions=lines(path.join(stored.home,mode,'events.jsonl')).filter(row=>row.kind==='aria_virtual_scroll_started');assert(scrollActions.length<=12);
  cases.push({mode,error:result.error,queryDelta:site.queries.length-queryCount,openDelta:site.opens.length-openCount,selectedDelta:site.selected.length-selectedCount,scrollActions:scrollActions.length});
 }
 assert(!site.queries.some(query=>query.city===cityLabel(12)),'wire values must never be replaced with option labels');
 saveEvidence('negative',{status:'passed',scope:'real_local_chromium',cases});
});

test('virtual scans require original approval, complete evidence and an explicit independent change assertion before navigation',{timeout:60000},async t=>{
 const site=await virtualSite(t),stored=await learnedSource(t,site);const before=site.requests.length;
 for(const mutate of [spec=>delete spec.steps.find(step=>step.virtual).virtual.domain.certificate,spec=>spec.steps.find(step=>step.virtual).virtual.domain.options[0].label+='0',spec=>delete spec.steps.find(step=>step.virtual).selection,spec=>delete spec.assertions[0].changedFromBefore,spec=>spec.steps.find(step=>step.virtual).choices[cityWire(5)].selector='#slot-0']){
  const value=structuredClone(stored.spec);mutate(value);const file=path.join(stored.home,'bad-'+Math.random()+'.json');writeFileSync(file,JSON.stringify(value));await assert.rejects(compileBrowserWorkflow({...stored,specFile:file,sourceId:'virtual'}));assert.equal(site.requests.length,before);
 }
});

test('virtual scroll/snapshot/time limits and global action budget independently stop exploration without a domain certificate',{timeout:60000},async t=>{
 const results=[];
 for(const [name,policyChange,maxActions]of [['scroll',{maxScrolls:1},40],['snapshots',{maxSnapshots:2},40],['time',{timeoutMs:1},40],['global-actions',{},1]]){
  const home=temp(t),site=await virtualSite(t),runDir=path.join(home,'source'),web=virtualWebConfig(site);web.actionAllowlist=web.actionAllowlist.filter(selector=>selector!=='#search');web.ariaVirtualLists=web.ariaVirtualLists.map(policy=>({...policy,...policyChange}));
  await runAsset({...web,startUrl:site.origin,outputDir:runDir,limitMode:'custom',maxStates:2,maxDepth:1,maxActions,maxRequests:250,maxStatesPerHost:3,maxDurationMs:20000},{log:()=>{}});
  const events=lines(path.join(runDir,'private/events.jsonl')),started=events.filter(row=>row.kind==='aria_virtual_scroll_started'),complete=events.filter(row=>row.kind==='aria_virtual_domain_complete');
  assert.equal(complete.length,0,name);assert.equal(site.queries.length,0,name);assert.equal(site.selected.length,0,name);assert(site.opens.length<=1,name);assert(started.length<=(policyChange.maxScrolls??12));
  if(name==='scroll')assert.equal(started.length,1);if(name==='global-actions')assert.equal(started.length,0);
  const planned=await planBrowserWorkflows({runDir,sourceId:'virtual'});assert(!planned.items.some(item=>item.inputSchema.properties.city));
  results.push({name,opens:site.opens.length,scrollActions:started.length,completeDomains:complete.length,queries:site.queries.length,sourceStatus:json(path.join(runDir,'private/run.json')).status});
 }
 saveEvidence('limits',{status:'passed',scope:'real_local_chromium',cases:results});
});

test('virtual interrupted write validation remains unknown without selecting or submitting twice',{timeout:60000},async t=>{
 const site=await virtualSite(t),stored=await learnedSource(t,site),spec={...stored.spec,effect:'write'},specFile=path.join(stored.home,'write.json');writeFileSync(specFile,JSON.stringify(spec));
 let before=site.requests.length;await assert.rejects(compileBrowserWorkflow({...stored,specFile,sourceId:'virtual'}),error=>{assert.equal(error.code,'WORKFLOW_WRITE_NOT_APPROVED');assert.deepEqual(error.writeOutcome,{status:'not_started',automaticRetry:false});return true;});assert.equal(site.requests.length,before);
 const permissions={allowWrite:[spec.id],allowWriteLearning:[spec.id]};site.setMode('auto-noop');let opened=site.opens.length,selected=site.selected.length,queries=site.queries.length;const outputDir=path.join(stored.home,'write-noop');
 await assert.rejects(compileBrowserWorkflow({...stored,specFile,sourceId:'virtual',outputDir,permissions}),error=>{assert.equal(error.code,'WORKFLOW_VALIDATION_FAILED');assert.deepEqual(error.writeOutcome,{status:'unknown',automaticRetry:false});return true;});
 assert.equal(site.opens.length,opened+1);assert.equal(site.selected.length,selected+1);assert.equal(site.queries.length,queries+1);assert(!existsSync(path.join(outputDir,'manifest.json')));assert.equal(json(path.join(outputDir,'sample-1/result.json')).error.code,'RESULT_ASSERTION_FAILED');
 site.setMode('normal');opened=site.opens.length;selected=site.selected.length;queries=site.queries.length;const controller=new AbortController(),cancelled=compileBrowserWorkflow({...stored,specFile,sourceId:'virtual',outputDir:path.join(stored.home,'cancelled-write'),permissions,signal:controller.signal});await until(()=>site.opens.length>opened);controller.abort();
 await assert.rejects(cancelled,error=>{assert.equal(error.writeOutcome.status,'unknown');assert.equal(error.writeOutcome.automaticRetry,false);return true;});assert.equal(site.opens.length,opened+1);assert.equal(site.selected.length,selected);assert.equal(site.queries.length,queries);
 saveEvidence('write',{status:'passed',noop:{openDelta:1,selectedDelta:1,queryDelta:1,outcome:'unknown',automaticRetry:false},cancelled:{openDelta:1,selectedDelta:0,queryDelta:0,outcome:'unknown',automaticRetry:false}});
});
