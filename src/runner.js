import { existsSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeConfig, limitReached } from './asset.js';
import { openStore, acquireLock } from './store.js';
import { createPolicy } from './policy.js';
import { createBudget, StopError } from './budget.js';
import { launchGuardedBrowser } from './browser.js';
import { createEvidence } from './evidence.js';
import { collectInteractives, actionKey } from './discover.js';
import { fingerprint } from './state.js';
import { makeDialogs } from './dialogs.js';
import { clickElement, gotoWithRetry, replayPath } from './replay.js';
import { authenticationStatus, saveSession } from './auth.js';
import { buildHarFromTraffic } from './har.js';
import { writeReport } from './report.js';
import { redact } from './redact.js';
import { buildSiteGraph } from './graph.js';
import { writeSiteGraph, updateGraphRun } from './graph-export.js';
import {inputScope,isTextPreparation} from './input-prefix.js';
import {beginLiveTransition,bindLiveState} from './browser-live-state.js';
import {beginClosedExplorationGeneration} from './closed-shadow.js';

const isPending=a=>a.status==='planned'||a.status==='running';
const hasPending=s=>(s.interactives||[]).some(isPending);
export async function runAsset(input,{resume=false,log=console.log,manualLogin=false}={}) {
  const config=normalizeConfig(input,{legacy:input._legacy===true});
  if(manualLogin){config.authMode='manual';config.headless=false;}
  const store=openStore(config,resume);const budget=createBudget(config,store);const previousElapsedMs=Number(store.meta.elapsedMs||0);
  const gaps=new Map((store.checkpoint?.coverageGaps||[]).map(g=>[JSON.stringify(g),g]));
  const rawEmit=store.emit;
  store.emit=(kind,data={})=>{if(kind==='coverage_gap')gaps.set(JSON.stringify({reason:data.reason,url:data.url||''}),{reason:data.reason,url:data.url||'',...data});return rawEmit(kind,data)};
  const policy=createPolicy(config,store.emit);config._policy=policy;
  config._runtime={emit:store.emit,budget,currentActionId:null,currentStateId:null,currentExecutionId:null,currentControl:'',dialogRejected:false,blockedRequests:[]};
  const evidence=createEvidence(config,store,budget,policy);
  const states=new Map((store.checkpoint?.states||[]).map(s=>[s.id,s]));
  const visited=new Map([...states.values()].map(s=>[s.fp,s.id]));
  const hosts=new Map(store.checkpoint?.hostCounters||[]);const backEdges=store.checkpoint?.backEdges||[];
  if(!hosts.size)for(const st of states.values()){const h=new URL(st.url).host;hosts.set(h,(hosts.get(h)||0)+1)}
  let nextId=Math.max(0,...states.keys()),visitedHits=Number(store.checkpoint?.visitedHits||0);
  let sessionLock=()=>{},launched=null,page=null,dialogs=null,lastAuthCheck=0,residentId=null,lastObservation=null;
  let status='running',stopReason=null,failureCount=0,started=Date.now(),lastProgress=Date.now(),guardedFinalized=false;
  let frontier=[],seedsVisited=new Set(store.checkpoint?.seedsVisited||[]);
  let lastPublished=0,lastCheckpoint=0,journaledEdges=backEdges.length,actionsSinceSeed=0;
  const dirtyStates=new Map();
  const perf={stateReuses:0,replayActions:0,checkpoints:0,journalWrites:0,persistenceMs:0,fingerprints:0,fingerprintMs:0,graphMs:0};
  let inputLease=null,liveLease=null,liveNext=null;
  const unsafePath=state=>state.path.some(step=>step.safeReplay===false||isTextPreparation(step));
  const releaseLiveLease=async reason=>{const previous=liveLease;liveLease=null;if(previous){const state=states.get(previous.stateId);if(state?.liveOnly){state.liveOnly.outcome=reason;dirtyStates.set(state.id,state);}await previous.dispose();}};
  const liveGap=(state,cause)=>{store.emit('coverage_gap',{reason:'live_state_unavailable',stateId:state.id,cause});throw Object.assign(new Error('live_state_unavailable'),{name:'PolicyError',reason:'live_state_unavailable'});};
  const observe=async()=>{const at=performance.now();try{return await fingerprint(page,config)}finally{perf.fingerprints++;perf.fingerprintMs+=performance.now()-at}};
  const save=(changed=[],force=false)=>{
    const at=performance.now();
    for(const state of changed)dirtyStates.set(state.id,state);
    const metadata={frontier,visitedHits,hostCounters:[...hosts],seedsVisited:[...seedsVisited],coverageGaps:[...gaps.values()],counters:budget.counts};
    // Journal first even when compacting: the previous snapshot must be able to
    // recover this transition if the newest snapshot is damaged after a kill.
    store.journal({upsertStates:[...dirtyStates.values()],set:metadata,append:{backEdges:backEdges.slice(journaledEdges)}});perf.journalWrites++;dirtyStates.clear();
    if(force||Date.now()-lastCheckpoint>=config.checkpointIntervalMs){
      store.save({states:[...states.values()],...metadata,backEdges,...evidence.snapshot()});
      lastCheckpoint=Date.now();perf.checkpoints++;
    }
    journaledEdges=backEdges.length;perf.persistenceMs+=performance.now()-at;
    if(!guardedFinalized&&Date.now()-lastPublished>=500){
      lastPublished=Date.now();
      store.update({progress:{updatedAt:new Date().toISOString(),elapsedMs:Date.now()-started,
        states:states.size,...budget.counts,performance:{...perf},pendingActions:[...states.values()].reduce((n,s)=>n+s.interactives.filter(isPending).length,0)}});
    }
  };
  const setHint=(action,stateId=null,executionId=null)=>{config._runtime.currentActionId=action?.id||null;config._runtime.currentStateId=stateId;config._runtime.currentExecutionId=executionId;config._runtime.currentControl=action?.label||'';config._runtime.dialogRejected=false;config._runtime.blockedRequests=[]};
  const prefixMarker=(state,scope,create=false)=>{
    const markers=state.inputPrefixes||[];let marker=markers.find(item=>item.scope===scope);
    if(!marker&&create){if(markers.length>=64)throw Object.assign(new Error('input_prefix_limit'),{name:'PolicyError'});marker={scope,actionIds:[],outcome:'unavailable',liveOnly:true};state.inputPrefixes=[...markers,marker];}
    return marker;
  };
  const releaseInputLease=async reason=>{
    const previous=inputLease;inputLease=null;
    if(!previous)return;
    const state=states.get(previous.stateId),marker=state&&prefixMarker(state,previous.scope);
    if(marker){marker.outcome=reason;dirtyStates.set(state.id,state);}
    await Promise.allSettled(previous.receipts.map(receipt=>receipt.dispose()));
  };
  const unavailablePrefix=(state,marker,cause)=>{
    marker.outcome=cause;dirtyStates.set(state.id,state);
    store.emit('coverage_gap',{reason:'input_prefix_unavailable',stateId:state.id,scope:marker.scope,cause});
    throw Object.assign(new Error('input_prefix_unavailable'),{name:'PolicyError',reason:'input_prefix_unavailable'});
  };
  const newPage=async()=>{
    budget.check();if(page&&!page.isClosed())return;
    await releaseInputLease('page_closed');await releaseLiveLease('page_closed');
    dialogs?.dispose();residentId=null;page=await launched.context.newPage();dialogs=makeDialogs(page,config,log);
    page.setDefaultTimeout(config.actionTimeoutMs);
  };
  const navigate=async url=>{await releaseInputLease('navigation');await releaseLiveLease('navigation');await newPage();residentId=null;setHint(null);dialogs.invalidate();const response=await gotoWithRetry(page,url,config,log);await dialogs.handle();await dialogs.stabilize();return response;};
  const checkAuth=async(force=false)=>{
    if(!force&&Date.now()-lastAuthCheck<config.authCheckIntervalMs)return;lastAuthCheck=Date.now();
    const result=await authenticationStatus(page,launched.context,config,store);store.emit('auth_check',{...result,url:page.url()});
    if(!result.ok)throw new StopError(result.reason,result.status);
  };
  const actionsFor=items=>{
    const actions=[];
    for(const observed of items){
      // The DOM collector can see a value left in a post-submit input. Do not
      // turn that private preparation into checkpoint text/action labels. Its
      // original discovery policy decision (including skipped) remains intact.
      const item=observed.type==='text'?{...observed,text:'',label:observed.aria||observed.associatedLabel||observed.placeholder||observed.title||observed.name||observed.tag}:observed;
      const base={...item,kind:'click'};
      if(item.type==='select'&&!item.skipped){
        const options=item.options.filter(v=>v.value!=='').slice(0,config.maxSelectOptions);
        for(const opt of options)actions.push({...base,optionValue:opt.value,label:item.label+' → '+opt.label});
        if(item.options.length-1>options.length)store.emit('coverage_gap',{reason:'representative_select_options',count:item.options.length,explored:options.length});
      }else actions.push(base);
      if(config.exploreHover&&!item.skipped&&(item.hoverHint||item.role==='menuitem')){
        const hover={...item,kind:'hover'};const d=policy.action(hover);if(d.allow)actions.push(hover);
      }
    }
    return actions.map(a=>({...a,...(isTextPreparation(a)?{safeReplay:false}:{}),id:actionKey(a),status:a.skipped?'skipped':'planned',reason:a.skipped?a.skipReason:null,attempts:0}));
  };
  const collectState=async(parent,pathSteps,depth)=>{
    budget.check();const decision=policy.navigation(page.url());if(!decision.allow){store.emit('coverage_gap',{reason:decision.reason,url:page.url()});return null;}
    await dialogs.stabilize();
    // Inventory can perform bounded read-only waiting for a lazy ARIA mount
    // (or validate a completed finite scan). Its returned surface, rather than
    // an earlier pre-mount frame, is the basis for this state's one official
    // fingerprint. A later lease mismatch still rejects; it never rebases.
    const items=await collectInteractives(page,config);
    await dialogs.stabilize();budget.check();
    const afterInventory=policy.navigation(page.url());if(!afterInventory.allow){store.emit('coverage_gap',{reason:afterInventory.reason,url:page.url()});return null;}
    const f=lastObservation=await observe();
    if(visited.has(f.fp)){
      // Equal DOM does not prove equal hidden JavaScript state. A duplicate
      // reached after a click must replay before its next action, as before.
      residentId=null;visitedHits++;return {dup:visited.get(f.fp),url:f.url};
    }
    if(limitReached(config,'maxStates',states.size))throw new StopError('max_states');
    const host=new URL(f.url).host;if(limitReached(config,'maxStatesPerHost',hosts.get(host)||0))throw new StopError('max_states_per_host');
    if(config.maxDepth!=null&&depth>config.maxDepth)throw new StopError('max_depth');
    const id=++nextId;
    const actions=actionsFor(items);
    if(config.exploreScroll){
      const scrollable=await page.evaluate(()=>[document.scrollingElement,...document.querySelectorAll('[data-bfs-scroll],[role="list"],[role="listbox"]')].filter(Boolean).some(v=>v.scrollHeight>v.clientHeight+10));
      if(scrollable){
        const already=pathSteps.filter(p=>p.kind==='scroll').length;
        if(already<config.maxScrollSteps)actions.push({id:`scroll:${already+1}`,selector:'html',kind:'scroll',scrollStep:already+1,label:'Scroll '+(already+1),safeReplay:true,status:'planned',attempts:0});
        else store.emit('coverage_gap',{reason:'max_scroll_steps',url:f.url});
      }
    }
    const evidenceId=store.emit('state',{stateId:id,url:f.url,title:f.title,fp:f.fp,diagnostics:f.diagnostics,depth,parentId:parent?.id||null});
    const state={id,depth,parentId:parent?.id||null,path:pathSteps,url:f.url,title:f.title,fp:f.fp,diagnostics:f.diagnostics,evidenceId,children:[],interactives:actions,processed:[],failed:[],expanded:false};
    states.set(id,state);visited.set(f.fp,id);hosts.set(host,(hosts.get(host)||0)+1);residentId=id;
    dirtyStates.set(id,state);
    if(parent){parent.children.push(id);dirtyStates.set(parent.id,parent);}
    if(config.shotFormat!=='none'){
      const ext=['jpeg','jpg'].includes(config.shotFormat)?'jpg':'png';
      try{await page.screenshot({path:path.join(store.dir,'states',String(id).padStart(3,'0')+'.'+ext),type:ext==='jpg'?'jpeg':'png',...(ext==='jpg'?{quality:config.shotQuality}:{})})}
      catch(e){store.emit('coverage_gap',{reason:'screenshot_failed',stateId:id,message:e.message});}
    }
    evidence.mine(f.url,await page.evaluate(limit=>document.documentElement.outerHTML.slice(0,limit),config.trafficHarvestMaxBytes),'text/html',evidenceId);
    const special=await page.evaluate(()=>({canvas:document.querySelectorAll('canvas').length,frames:document.querySelectorAll('iframe').length}));
    if(special.canvas)store.emit('coverage_gap',{reason:'canvas_controls_unsupported',url:f.url});
    log(`[状态] #${id} d${depth} ${f.title||f.url} · ${actions.length} 动作`);lastProgress=Date.now();failureCount=0;save([state,...(parent?[parent]:[])]);return state;
  };
  const reach=async(state,action)=>{
    let liveElement=null;
    const scope=inputScope(action);
    if(inputLease&&(inputLease.stateId!==state.id||inputLease.scope!==scope))await releaseInputLease('different_scope');
    if(liveLease&&liveLease.stateId!==state.id)await releaseLiveLease('different_state');
    if(unsafePath(state)&&(!liveLease||liveLease.stateId!==state.id))liveGap(state,'lease_lost');
    if(liveLease?.stateId===state.id){
      try{await dialogs.stabilize();liveElement=await liveLease.verify(action);const f=await observe();if(f.fp!==state.fp)liveGap(state,'semantic_state_changed');}
      catch(error){await releaseLiveLease('validation_failed');if(error instanceof StopError||budget.reason)throw error;liveGap(state,'validation_failed');}
    }
    const marker=prefixMarker(state,scope);
    if(marker){
      if(!inputLease||inputLease.page!==page||page.isClosed()||page.url()!==state.url||inputLease.stateId!==state.id)unavailablePrefix(state,marker,'lease_lost');
      try{
        await dialogs.stabilize();const f=await observe();if(f.fp!==state.fp)unavailablePrefix(state,marker,'semantic_state_changed');
        for(const receipt of inputLease.receipts)await receipt.verify(action);
        setHint(null);await checkAuth();
      }catch(error){await releaseInputLease('receipt_failed');if(error instanceof StopError||budget.reason)throw error;unavailablePrefix(state,marker,'receipt_failed');}
      store.emit('input_prefix_reused',{stateId:state.id,scope,actionIds:[...marker.actionIds],liveOnly:true});
      return {element:liveElement};
    }
    if(liveLease?.stateId===state.id){setHint(null);await checkAuth();store.emit('live_state_reused',{stateId:state.id,liveOnly:true});return {element:liveElement};}
    // Reuse only a known resident state, after checking the complete semantic
    // fingerprint again. A matching URL alone never skips replay or live policy.
    if(config.reuseVerifiedState&&residentId===state.id&&!page.isClosed()&&page.url()===state.url&&state.path.every(step=>step.safeReplay!==false)){
      await dialogs.stabilize();const f=await observe();
      if(f.fp===state.fp){setHint(null);await checkAuth();perf.stateReuses++;store.emit('state_reused',{stateId:state.id,url:f.url,reason:'verified_semantic_fingerprint'});return;}
      residentId=null;
    }
    // No URL shortcut for links with custom handlers: replay actual actions.
    const response=await navigate(config.startUrl);
    if(response?.status()===401||response?.status()===403)throw new StopError('root_auth_response',config.authMode==='anonymous'?'blocked':'needs_auth');
    if(state.path.length){for(const step of state.path){
      const sourceStateId=step.fromStateId??null;
      budget.action();perf.replayActions++;
      const executionId=store.emit('action_replay',{stateId:sourceStateId,targetStateId:state.id,actionId:step.id,label:step.label,safeReplay:step.safeReplay});
      setHint(step,sourceStateId,executionId);
      await replayPath(page,dialogs,[step],config,log,{short:true});if(config._runtime.dialogRejected)throw Object.assign(new Error('replay_dialog_rejected'),{name:'PolicyError'});save();
    }}
    setHint(null);await dialogs.stabilize();await checkAuth();
    const f=await observe();
    if(f.fp!==state.fp){store.emit('coverage_gap',{reason:'replay_state_changed',stateId:state.id,url:page.url()});throw Object.assign(new Error('replay_state_changed'),{name:'PolicyError'});}residentId=state.id;
  };
  const seedVisit=async url=>{
    if(seedsVisited.has(url))return;const d=policy.navigation(url);if(!d.allow){seedsVisited.add(url);store.emit('coverage_gap',{reason:d.reason,url});return;}
    try{
      const response=await navigate(url);if(response?.status()>=400){store.emit('coverage_gap',{reason:'seed_http_error',url,status:response.status()});seedsVisited.add(url);save();return;}
      await checkAuth();const root=states.get(1);const step={gotoUrl:url,href:url,label:'seed: '+url,safeReplay:true};
      const s=await collectState(root,[step],root?1:0);seedsVisited.add(url);
      if(s?.id)frontier.push(s.id);save();
    }catch(error){
      if(error instanceof StopError||budget.reason)throw error;
      residentId=null;seedsVisited.add(url);
      store.emit('coverage_gap',{reason:'seed_navigation_failed',url,message:String(error.message||error).slice(0,300)});
      // Chromium can commit its error document just after goto rejects. Observe
      // that transition before dispatching the next root navigation on this tab.
      dialogs.invalidate();
      try{await dialogs.stabilize()}catch(recoveryError){if(recoveryError instanceof StopError||budget.reason)throw recoveryError;}
      save();
    }
  };
  async function finalize() {
    if(guardedFinalized)return;guardedFinalized=true;
    await releaseInputLease('run_ended');await releaseLiveLease('run_ended');
    // Drain responses while context still exists, then save the latest auth state.
    if(launched){await evidence.drain();if(!manualLogin||status==='completed')await saveSession(launched.context,config,store).catch(()=>{if(status==='completed'){status='partial';stopReason='session_save_failed'}});await launched.close();await evidence.drain();}
    const finalChanges=[];
    for(const st of states.values())for(const action of st.interactives){if(action.status==='running'){const text=isTextPreparation(action),live=action.liveOnlyAttempt===true;action.status=action.closedShadow||text||live?'failed':'planned';action.reason=action.closedShadow?'closed_shadow_unknown_no_retry':text?'input_prefix_unknown_no_retry':live?'live_state_unknown_no_retry':'interrupted_before_commit';if(action.closedShadow||text||live)action.noRetry=true;if(!finalChanges.includes(st))finalChanges.push(st);}}
    const pending={states:[...states.values()].filter(hasPending).length,actions:[...states.values()].reduce((n,s)=>n+s.interactives.filter(isPending).length,0),failed:[...states.values()].reduce((n,s)=>n+s.interactives.filter(a=>a.status==='failed').length,0),seeds:[...evidence.seeds].filter(u=>!seedsVisited.has(u)).length};
    pending.bootstrap=states.size?0:1;
    if(status==='running'){status=pending.actions||pending.failed||pending.seeds?'partial':'completed';stopReason=status==='completed'?'frontier_exhausted':pending.failed?'failed_actions':'pending_actions';}
    if(status==='completed'&&[...gaps.values()].some(g=>['replay_state_changed','unsafe_replay_requires_manual_state','input_prefix_unavailable','live_state_unavailable','evidence_drain_timeout','seed_http_error','seed_navigation_failed'].includes(g.reason))){status='partial';stopReason='unresolved_coverage_errors';}
    store.emit('run_finalized',{status,stopReason,pending});
    // Export failures must surface as structured results, never as a stuck "running".
    let harEntries=0,exportFailed=null;
    if(config.harCapture){
      try{harEntries=await buildHarFromTraffic(evidence.trafficFile,path.join(store.privateDir,config.harPath),{onError:(e,line)=>store.emit('export_error',{file:'traffic.jsonl',line,message:e.message})});}
      catch(error){exportFailed='har_export_failed';store.emit('export_error',{file:config.harPath,stage:'private',message:String(error.message||error).slice(0,300)});}
      try{await buildHarFromTraffic(evidence.trafficFile,path.join(store.dir,config.harPath),{redacted:true});}
      catch(error){exportFailed=exportFailed||'har_export_failed';store.emit('export_error',{file:config.harPath,stage:'redacted',message:String(error.message||error).slice(0,300)});}
    }
    try{await evidence.export();}
    catch(error){exportFailed=exportFailed||'evidence_export_failed';store.emit('export_error',{stage:'evidence_export',message:String(error.message||error).slice(0,300)});}
    if(exportFailed&&status==='completed'){status='partial';stopReason=exportFailed;}
    else if(exportFailed&&!stopReason)stopReason=exportFailed;
    save(finalChanges,true);
    let elapsedMs=previousElapsedMs+Date.now()-started;
    store.update({status,stopReason,finishedAt:new Date().toISOString(),elapsedMs,pending,performance:{...perf},counts:{...budget.counts,states:states.size,apis:evidence.ledger.size,harEntries},coverageGaps:[...gaps.values()]});
    let graph=null,graphInfo={available:false};const graphStarted=performance.now();
    try{
      graph=await buildSiteGraph({states,backEdges,run:store.meta,config,eventsFile:path.join(store.privateDir,'events.jsonl'),trafficFile:evidence.trafficFile,apis:evidence.snapshot().apis});
      elapsedMs=previousElapsedMs+Date.now()-started;updateGraphRun(graph,{...store.meta,elapsedMs,finishedAt:new Date().toISOString()});
      graphInfo=writeSiteGraph(graph,store.dir);
    }catch(error){
      graph=null;
      store.emit('export_error',{stage:'graph',message:String(error.message||error).slice(0,300)});
      if(status==='completed'){
        status='partial';stopReason='graph_export_failed';
        const adjustment={kind:'result_adjusted',reason:stopReason,status,stopReason};const evidenceId=store.emit('result_adjusted',adjustment);
        try{appendFileSync(path.join(store.dir,'events.jsonl'),JSON.stringify(redact({...adjustment,evidenceId,ts:new Date().toISOString()}))+'\n');}catch{/* public copy best effort */}
      }
    }
    perf.graphMs=performance.now()-graphStarted;
    if(!graph)elapsedMs=previousElapsedMs+Date.now()-started;
    store.update({status,stopReason,elapsedMs,finishedAt:graph?.run.finishedAt||new Date().toISOString(),performance:{...perf},graph:graphInfo});
    try{writeReport({allStates:states,visitedHits,config,elapsedMs,log,backEdges,run:store.meta,graph});}
    catch(error){
      store.emit('export_error',{stage:'report',message:String(error.message||error).slice(0,300)});
      // A failed report must not leave a faked completed result in run/manifest/tree
      // or in the public event export; keep any pre-existing failure reason intact.
      if(status==='completed'){
        status='partial';stopReason='report_export_failed';
        save([],true);
        store.update({status,stopReason,finishedAt:new Date().toISOString(),elapsedMs,pending,counts:{...budget.counts,states:states.size,apis:evidence.ledger.size,harEntries},coverageGaps:[...gaps.values()]});
        if(graph)try{updateGraphRun(graph,store.meta);writeSiteGraph(graph,store.dir,{assets:false})}catch{/* preserve the report error as the primary result */}
        const adjustment={kind:'result_adjusted',reason:'report_export_failed',status,stopReason};
        store.emit('result_adjusted',adjustment);
        try{appendFileSync(path.join(store.dir,'events.jsonl'),JSON.stringify(redact({...adjustment,ts:new Date().toISOString()}))+'\n');}catch{/* public copy best effort */}
        try{writeReport({allStates:states,visitedHits,config,elapsedMs,log,backEdges,run:store.meta,graph});}
        catch{/* still unwritable; manifest/tree were refreshed above where possible */}
      }
    }
    return store.meta;
  }
  try {
    if(resume&&existsSync(path.join(store.dir,'STOP'))){rmSync(path.join(store.dir,'STOP'));store.emit('resume_stop_cleared');}
    if(resume)for(const state of states.values())for(const action of state.interactives){
      if((action.safeReplay===false||unsafePath(state)||action.liveOnlyAttempt===true)&&(action.attempts||0)>0&&action.status!=='succeeded'){action.status='failed';action.reason='live_state_unknown_no_retry';action.noRetry=true;dirtyStates.set(state.id,state);}
      if(!isTextPreparation(action)||!(action.attempts>0))continue;
      const marker=prefixMarker(state,inputScope(action),true);if(!marker.actionIds.includes(action.id))marker.actionIds.push(action.id);marker.outcome='resume_has_no_live_lease';
      if(action.status!=='succeeded'){action.status='failed';action.reason='input_prefix_unknown_no_retry';action.noRetry=true;}
      dirtyStates.set(state.id,state);
    }
    if(resume){const unknown=[...states.values()].filter(state=>state.interactives.some(action=>action.closedShadow&&(action.attempts||0)>0&&action.status!=='succeeded'));if(unknown.length){for(const state of unknown)for(const action of state.interactives)if(action.closedShadow&&(action.attempts||0)>0&&action.status!=='succeeded'){action.status='failed';action.reason='closed_shadow_unknown_no_retry';action.noRetry=true;}save(unknown);throw new StopError('closed_shadow_unknown_no_retry','partial');}}
    if(config.storageState)sessionLock=acquireLock(`${config.storageState}.bfs.lock`,{runId:config.runId});
    if(resume)await evidence.restore();
    store.update({runtime:{node:process.version,platform:process.platform,playwright:JSON.parse(execFileSync(process.execPath,['-e',"process.stdout.write(JSON.stringify(require('playwright/package.json').version))"],{encoding:'utf8',windowsHide:true})),codeVersion:gitVersion()}});
    for(const note of config._migration||[])log('[迁移] '+note);
    launched=await launchGuardedBrowser(config,policy,budget,store);evidence.attach(launched.context);
    store.update({browser:{engine:'chromium',version:launched.context.browser().version(),channel:config.channel||null}});
    await newPage();await page.evaluate(({selectors,noise,auth})=>{for(const s of [...selectors,...noise,...auth].filter(Boolean))document.querySelector(s)}, {selectors:config.excludeSelectors,noise:config.fingerprintIgnoreSelectors,auth:[config.auth.loggedInSelector,config.auth.loggedOutSelector]});
    store.emit('coverage_gap',{reason:config.closedShadowRoots?.length?'closed_shadow_top_level_native_text_button_subset':'closed_shadow_roots_not_opted_in'});
    store.emit('coverage_gap',{reason:'websocket_webrtc_shared_workers_unsupported'});
    const response=await navigate(manualLogin?config.loginUrl||config.startUrl:config.startUrl);
    if(manualLogin){
      const end=Date.now()+(config.loginTimeoutMs||600000);log('[登录] 在可见浏览器内完成登录；成功条件通过后保存会话');
      while(Date.now()<end){budget.check();const auth=await authenticationStatus(page,launched.context,config,store);if(auth.ok){await saveSession(launched.context,config,store);status='completed';stopReason='manual_login_verified';break}await budget.pause(500);}
      if(status!=='completed'){status='needs_auth';stopReason='manual_login_timeout';}return await finalize();
    }
    if(response?.status()===401||response?.status()===403)throw new StopError('root_auth_response',config.authMode==='anonymous'?'blocked':'needs_auth');
    if(response?.status()>=400)throw new StopError('root_http_error','failed');
    await checkAuth(true);
    seedsVisited.add(config.startUrl);
    if(!states.size){const root=await collectState(null,[],0);if(root?.id)frontier.push(root.id);}
    else{
      // Rebuild the frontier BEFORE deciding completion, including states clipped by prior depth/budget.
      for(const state of states.values()){
        for(const action of state.interactives){if(action.closedShadow&&(action.attempts||0)>0&&action.status!=='succeeded'){action.status='failed';action.reason='closed_shadow_unknown_no_retry';action.noRetry=true;}else if(!action.noRetry&&(action.status==='running'||action.status==='failed'&&(action.attempts||0)<=config.maxRetries)){action.status='planned';action.reason='resume_retry';}}
        if(hasPending(state))frontier.push(state.id);
      }
      store.emit('resume_frontier',{states:frontier.length});
      save([...states.values()]);
    }
    const explicitSeeds=config.seedRoutes.map(seed=>new URL(seed,config.startUrl).href);
    for(const url of explicitSeeds)evidence.seeds.add(url);
    if(config.seedFiles){
      for(const file of ['/robots.txt','/sitemap.xml']){
        const url=new URL(file,config.startUrl).href;const doc=await navigate(url);
        if(doc?.ok()){
          // XML browser views hide markup in innerText; read <loc> from the DOM.
          const urls=await page.evaluate(({maxBytes,cap})=>{
            const locs=Array.from(document.getElementsByTagName('loc')).map(el=>el.textContent.trim());
            const text=(document.body?.innerText||document.documentElement.textContent||'').slice(0,maxBytes);
            const robots=Array.from(text.matchAll(/^(?:Allow|Sitemap):\s*(\S+)/gim),m=>m[1]);
            return [...locs,...robots].filter(Boolean).slice(0,cap);
          },{maxBytes:config.trafficHarvestMaxBytes,cap:config.discoverySeedCap});
          for(const raw of urls)try{evidence.seeds.add(new URL(raw,config.startUrl).href)}catch{}
        }
      }
    }
    // User-selected entry routes must get a chance before a broad UI frontier
    // consumes its budget. All seeds still use the same navigation guard.
    for(const seed of explicitSeeds)await seedVisit(seed);
    let depthClipped=false;
    while(frontier.length||[...evidence.seeds].some(u=>!seedsVisited.has(u))){
      budget.check();
      if(config.maxDurationMs!=null&&Date.now()-lastProgress>Math.min(config.maxDurationMs,60000)){throw new StopError('no_progress');}
      if(!frontier.length){const seed=[...evidence.seeds].find(u=>!seedsVisited.has(u));await seedVisit(seed);continue;}
      const id=liveNext??(config.order==='dfs'?frontier.pop():frontier.shift());if(liveNext!==null){frontier=frontier.filter(value=>value!==liveNext);liveNext=null;}const state=states.get(id);if(!state)continue;
      if(!hasPending(state)){state.expanded=true;dirtyStates.set(state.id,state);continue;}
      if(limitReached(config,'maxDepth',state.depth)){depthClipped=true;continue;}
      if(limitReached(config,'maxStates',states.size))throw new StopError('max_states');
      // Observe newly available work before revisiting the still-visible
      // controls that survived its incoming primitive. Ordinary frontier order is unchanged.
      const orderedActions=liveLease?.stateId===state.id?[...state.interactives.filter(action=>!liveLease.deferred.has(action.id)),...state.interactives.filter(action=>liveLease.deferred.has(action.id))]:state.interactives;
      for(const action of orderedActions){
        if(!isPending(action))continue;budget.check();
        if(actionsSinceSeed>=config.seedInterleaveActions){
          const seed=[...evidence.seeds].find(u=>!seedsVisited.has(u));
          if(seed){await seedVisit(seed);actionsSinceSeed=0;}
        }
        if(limitReached(config,'maxStates',states.size))throw new StopError('max_states');
        if(unsafePath(state)&&liveLease?.stateId!==state.id){action.status='skipped';action.reason='unsafe_replay_requires_manual_state';dirtyStates.set(state.id,state);store.emit('coverage_gap',{reason:action.reason,stateId:state.id});continue;}
        let receipt,transition,post,generation,attemptedHere=false,yieldLive=false;
        try{
          const reached=await reach(state,action);
          if(isTextPreparation(action)&&(inputLease?.receipts.length||0)>=32)throw Object.assign(new Error('input_prefix_limit'),{name:'PolicyError'});
          transition=await beginLiveTransition(page,action,config,{...reached,priorActions:action.safeReplay===false||unsafePath(state)?state.interactives:[]});
          budget.action();setHint(action,state.id);action.status='running';action.attempts++;action.liveOnlyAttempt=unsafePath(state)||action.safeReplay===false;attemptedHere=true;
          const textPreparation=isTextPreparation(action),scope=inputScope(action),prefixSteps=inputLease?[...inputLease.steps]:[];
          if(textPreparation){const marker=prefixMarker(state,scope,true);if(!marker.actionIds.includes(action.id))marker.actionIds.push(action.id);marker.outcome='dispatched';}
          save([state]);
          action.evidenceId=store.emit('action_started',{actionId:action.id,stateId:state.id,label:action.label,kind:action.kind});
          config._runtime.currentExecutionId=action.evidenceId;
          // Any attempted action can mutate hidden state, including one rejected
          // by a dialog or request guard. Only a newly collected state re-arms reuse.
          residentId=null;
          receipt=await clickElement(page,dialogs,action,config,log,{inputReceipt:textPreparation,liveElement:transition.element});
          if(textPreparation&&!receipt)throw Object.assign(new Error('input_prefix_receipt_missing'),{name:'PolicyError',reason:'input_prefix_receipt_missing'});
          post=await transition.finish();await checkAuth(true);
          if(config._runtime.dialogRejected){action.status='skipped';action.reason='native_confirmation_rejected';}
          else if(config._runtime.blockedRequests.some(r=>r.navigation||['unsafe_endpoint','unapproved_write_method','graphql_operation_not_read_query'].includes(r.reason))){action.status='skipped';action.reason='request_policy_blocked';}
          else{
            const d=policy.navigation(page.url());if(!d.allow){action.status='skipped';action.reason=d.reason;}
            else{
              const step={...action,fromStateId:state.id,status:undefined,evidenceId:undefined};
              // A completed primitive may establish a NEW observed generation.
              // Old preparations and control pins cannot cross that boundary.
              if(!textPreparation){await releaseInputLease('primitive_completed');await releaseLiveLease('primitive_completed');generation=await beginClosedExplorationGeneration(page,config);}
              await post.guard.verify();
              const child=await collectState(state,[...state.path,...prefixSteps,step],state.depth+1);
              await post.guard.verify();
              if(child?.id&&unsafePath(child)&&hasPending(child)){
                await releaseInputLease('new_state');await releaseLiveLease('new_state');
                const lease=await bindLiveState(page,child,config,post);
                try{if((await observe()).fp!==child.fp)throw Object.assign(new Error('live_state_unavailable'),{name:'PolicyError'});await lease.verify();await generation?.commit();}
                catch(error){await lease.dispose();throw error;}
                liveLease=lease;post=null;child.liveOnly={schemaVersion:1,parentId:state.id,actionId:action.id,outcome:'resident',requiresLiveLease:true};
                liveNext=child.id;yieldLive=true;
              }
              if(child?.id)frontier.push(child.id);else if(child?.dup){backEdges.push({from:state.id,to:child.dup,actionId:action.id,executionId:action.evidenceId,label:action.label,url:child.url});store.emit('state_merged',{stateId:state.id,actionId:action.id,executionId:action.evidenceId,into:child.dup,reason:'same_semantic_fingerprint'});}
              action.status='succeeded';action.reason=lastObservation?.fp===state.fp?'triggered_without_new_state':'triggered_state_change';state.processed.push(action.id);
              if(receipt&&child?.dup===state.id){
                if(!inputLease)inputLease={stateId:state.id,scope,page,receipts:[],steps:[]};
                inputLease.receipts.push(receipt);inputLease.steps.push(step);
                prefixMarker(state,scope).outcome='live_only';if(liveLease?.stateId===state.id)await liveLease.refreshText(action,receipt);receipt=null;
              }else{await releaseInputLease('consumed_or_state_changed');if(receipt)prefixMarker(state,scope).outcome='changed_state_not_replayable';}
            }
          }
          if(action.status!=='succeeded'){await releaseLiveLease('action_rejected');await releaseInputLease('action_rejected');if(textPreparation)store.emit('coverage_gap',{reason:'input_prefix_unavailable',stateId:state.id,scope,cause:'preparation_rejected'});}
          store.emit('action_finished',{stateId:state.id,actionId:action.id,executionId:action.evidenceId,status:action.status,reason:action.reason,url:page.url()});failureCount=0;lastProgress=Date.now();actionsSinceSeed++;save([state]);
        }catch(error){
          residentId=null;
          await releaseLiveLease('action_failed');await releaseInputLease('action_failed');
          if(attemptedHere&&(action.safeReplay===false||unsafePath(state))){action.noRetry=true;store.emit('coverage_gap',{reason:'live_state_unavailable',stateId:state.id,cause:'unknown_action_outcome'});}
          if(attemptedHere&&isTextPreparation(action)){action.noRetry=true;const marker=prefixMarker(state,inputScope(action),true);marker.outcome='unknown_no_retry';store.emit('coverage_gap',{reason:'input_prefix_unavailable',stateId:state.id,scope:marker.scope,cause:'preparation_failed'});}
          if(error instanceof StopError||budget.reason){const text=isTextPreparation(action)&&attemptedHere,unknown=attemptedHere&&(action.safeReplay===false||unsafePath(state));action.status=action.closedShadow||text||unknown?'failed':'planned';action.reason=action.closedShadow?'closed_shadow_unknown_no_retry':text?'input_prefix_unknown_no_retry':'interrupted';if(action.closedShadow||text||unknown)action.noRetry=true;dirtyStates.set(state.id,state);throw error;}
          if(error.name==='PolicyError'){action.status='skipped';action.reason=error.reason||error.message;}
          else{action.status='failed';action.reason=String(error.message||error).slice(0,800);if(action.closedShadow)action.noRetry=true;state.failed.push({selector:action.selector,message:action.reason});failureCount++;}
          store.emit('action_finished',{stateId:state.id,actionId:action.id,executionId:action.evidenceId,status:action.status,reason:action.reason});actionsSinceSeed++;save([state]);
          if((config.circuitBreakerMax??5)>0&&failureCount>=(config.circuitBreakerMax??5))throw new StopError('consecutive_failures','partial');
        }finally{await receipt?.dispose();await post?.guard.dispose();await generation?.dispose();await transition?.dispose();setHint(null);}
        if(yieldLive){if(hasPending(state)&&!frontier.includes(state.id))frontier.push(state.id);break;}
      }
      state.expanded=!hasPending(state);save([state]);
    }
    const failures=[...states.values()].some(s=>s.interactives.some(a=>a.status==='failed'));
    status=depthClipped||failures?'partial':'completed';stopReason=depthClipped?'max_depth':failures?'failed_actions':'frontier_exhausted';
    if(states.size===1&&!states.get(1).interactives.length)store.emit('coverage_gap',{reason:'no_interactive_surface'});
  }catch(error){
    status=budget.reason?budget.status:error instanceof StopError?error.status:'failed';
    stopReason=budget.reason||error.reason||String(error.message||error);store.emit('run_error',{status,reason:stopReason});
    log('[停止] '+status+' / '+stopReason);
  }finally{
    try{await finalize()}
    catch(error){
      log('[收尾失败] '+(error?.message||error));
      // Even a broken finalize must leave a terminal status; the lock is released below either way.
      try{
        if(store.meta.status==='running')store.update({status:'failed',stopReason:'finalize_failed'});
        else store.update({stopReason:`${store.meta.stopReason||'failed'} + finalize_failed`});
      }catch{/* best effort; disk/lock may be the original failure */}
    }
    finally{budget.dispose();sessionLock();store.release();delete config._runtime;delete config._policy;}
  }
  return store.meta;
}
function gitVersion(){try{return execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim()}catch{return null}}
