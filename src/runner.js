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

const isPending=a=>a.status==='planned'||a.status==='running';
const hasPending=s=>(s.interactives||[]).some(isPending);
export async function runAsset(input,{resume=false,log=console.log,manualLogin=false}={}) {
  const config=normalizeConfig(input,{legacy:input._legacy===true});
  if(manualLogin){config.authMode='manual';config.headless=false;}
  const store=openStore(config,resume);const budget=createBudget(config,store);
  const gaps=new Map((store.checkpoint?.coverageGaps||[]).map(g=>[JSON.stringify(g),g]));
  const rawEmit=store.emit;
  store.emit=(kind,data={})=>{if(kind==='coverage_gap')gaps.set(JSON.stringify({reason:data.reason,url:data.url||''}),{reason:data.reason,url:data.url||'',...data});return rawEmit(kind,data)};
  const policy=createPolicy(config,store.emit);config._policy=policy;
  config._runtime={emit:store.emit,budget,currentActionId:null,currentControl:'',dialogRejected:false,blockedRequests:[]};
  const evidence=createEvidence(config,store,budget,policy);
  const states=new Map((store.checkpoint?.states||[]).map(s=>[s.id,s]));
  const visited=new Map([...states.values()].map(s=>[s.fp,s.id]));
  const hosts=new Map(store.checkpoint?.hostCounters||[]);const backEdges=store.checkpoint?.backEdges||[];
  if(!hosts.size)for(const st of states.values()){const h=new URL(st.url).host;hosts.set(h,(hosts.get(h)||0)+1)}
  let nextId=Math.max(0,...states.keys()),visitedHits=Number(store.checkpoint?.visitedHits||0);
  let sessionLock=()=>{},launched=null,page=null,dialogs=null,lastAuthCheck=0;
  let status='running',stopReason=null,failureCount=0,started=Date.now(),lastProgress=Date.now(),guardedFinalized=false;
  let frontier=[],seedsVisited=new Set(store.checkpoint?.seedsVisited||[]);
  let lastPublished=0;
  const save=()=>{
    store.save({states:[...states.values()],frontier,visitedHits,backEdges,hostCounters:[...hosts],
      seedsVisited:[...seedsVisited],coverageGaps:[...gaps.values()],counters:budget.counts,...evidence.snapshot()});
    if(!guardedFinalized&&Date.now()-lastPublished>=500){
      lastPublished=Date.now();
      store.update({progress:{updatedAt:new Date().toISOString(),elapsedMs:Date.now()-started,
        states:states.size,...budget.counts,pendingActions:[...states.values()].reduce((n,s)=>n+s.interactives.filter(isPending).length,0)}});
    }
  };
  const setHint=action=>{config._runtime.currentActionId=action?.id||null;config._runtime.currentControl=action?.label||'';config._runtime.dialogRejected=false;config._runtime.blockedRequests=[]};
  const newPage=async()=>{
    budget.check();if(page&&!page.isClosed())return;
    page=await launched.context.newPage();dialogs=makeDialogs(page,config,log);
    page.setDefaultTimeout(config.actionTimeoutMs);
  };
  const navigate=async url=>{await newPage();setHint(null);const response=await gotoWithRetry(page,url,config,log);await dialogs.handle();await dialogs.stabilize();return response;};
  const checkAuth=async(force=false)=>{
    if(!force&&Date.now()-lastAuthCheck<config.authCheckIntervalMs)return;lastAuthCheck=Date.now();
    const result=await authenticationStatus(page,launched.context,config,store);store.emit('auth_check',{...result,url:page.url()});
    if(!result.ok)throw new StopError(result.reason,result.status);
  };
  const actionsFor=items=>{
    const actions=[];
    for(const item of items){
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
    return actions.map(a=>({...a,id:actionKey(a),status:a.skipped?'skipped':'planned',reason:a.skipped?a.skipReason:null,attempts:0}));
  };
  const collectState=async(parent,pathSteps,depth)=>{
    budget.check();const decision=policy.navigation(page.url());if(!decision.allow){store.emit('coverage_gap',{reason:decision.reason,url:page.url()});return null;}
    await dialogs.stabilize();const f=await fingerprint(page,config);
    if(visited.has(f.fp)){visitedHits++;return {dup:visited.get(f.fp),url:f.url};}
    if(limitReached(config,'maxStates',states.size))throw new StopError('max_states');
    const host=new URL(f.url).host;if(limitReached(config,'maxStatesPerHost',hosts.get(host)||0))throw new StopError('max_states_per_host');
    if(config.maxDepth!=null&&depth>config.maxDepth)throw new StopError('max_depth');
    const id=++nextId;
    const items=await collectInteractives(page,config);
    const actions=actionsFor(items);
    if(config.exploreScroll){
      const scrollable=await page.evaluate(()=>[document.scrollingElement,...document.querySelectorAll('[data-bfs-scroll],[role="list"],[role="listbox"]')].filter(Boolean).some(v=>v.scrollHeight>v.clientHeight+10));
      if(scrollable){
        const already=pathSteps.filter(p=>p.kind==='scroll').length;
        if(already<config.maxScrollSteps)actions.push({id:`scroll:${already+1}`,selector:'html',kind:'scroll',scrollStep:already+1,label:'Scroll '+(already+1),safeReplay:true,status:'planned',attempts:0});
        else store.emit('coverage_gap',{reason:'max_scroll_steps',url:f.url});
      }
    }
    const evidenceId=store.emit('state',{stateId:id,url:f.url,title:f.title,fp:f.fp,depth,parentId:parent?.id||null});
    const state={id,depth,parentId:parent?.id||null,path:pathSteps,url:f.url,title:f.title,fp:f.fp,evidenceId,children:[],interactives:actions,processed:[],failed:[],expanded:false};
    states.set(id,state);visited.set(f.fp,id);hosts.set(host,(hosts.get(host)||0)+1);
    if(parent)parent.children.push(id);
    if(config.shotFormat!=='none'){
      const ext=['jpeg','jpg'].includes(config.shotFormat)?'jpg':'png';
      try{await page.screenshot({path:path.join(store.dir,'states',String(id).padStart(3,'0')+'.'+ext),type:ext==='jpg'?'jpeg':'png',...(ext==='jpg'?{quality:config.shotQuality}:{})})}
      catch(e){store.emit('coverage_gap',{reason:'screenshot_failed',stateId:id,message:e.message});}
    }
    evidence.mine(f.url,await page.evaluate(limit=>document.documentElement.outerHTML.slice(0,limit),config.trafficHarvestMaxBytes),'text/html',evidenceId);
    const special=await page.evaluate(()=>({canvas:document.querySelectorAll('canvas').length,frames:document.querySelectorAll('iframe').length}));
    if(special.canvas)store.emit('coverage_gap',{reason:'canvas_controls_unsupported',url:f.url});
    log(`[状态] #${id} d${depth} ${f.title||f.url} · ${actions.length} 动作`);lastProgress=Date.now();failureCount=0;save();return state;
  };
  const reach=async state=>{
    // No URL shortcut for links with custom handlers: replay actual actions.
    const response=await navigate(config.startUrl);
    if(response?.status()===401||response?.status()===403)throw new StopError('root_auth_response',config.authMode==='anonymous'?'blocked':'needs_auth');
    if(state.path.length){for(const step of state.path){setHint(step);budget.action();store.emit('action_replay',{stateId:state.id,actionId:step.id,label:step.label,safeReplay:step.safeReplay});await replayPath(page,dialogs,[step],config,log,{short:true});if(config._runtime.dialogRejected)throw Object.assign(new Error('replay_dialog_rejected'),{name:'PolicyError'});}}
    setHint(null);await dialogs.stabilize();await checkAuth();
    const f=await fingerprint(page,config);
    if(f.fp!==state.fp){store.emit('coverage_gap',{reason:'replay_state_changed',stateId:state.id,url:page.url()});throw Object.assign(new Error('replay_state_changed'),{name:'PolicyError'});}
  };
  const seedVisit=async url=>{
    if(seedsVisited.has(url))return;const d=policy.navigation(url);if(!d.allow){seedsVisited.add(url);store.emit('coverage_gap',{reason:d.reason,url});return;}
    const response=await navigate(url);if(response?.status()>=400){store.emit('coverage_gap',{reason:'seed_http_error',url,status:response.status()});seedsVisited.add(url);return;}
    await checkAuth();const root=states.get(1);const step={gotoUrl:url,href:url,label:'seed: '+url,safeReplay:true};
    const s=await collectState(root,[step],root?1:0);seedsVisited.add(url);
    if(s?.id)frontier.push(s.id);save();
  };
  async function finalize() {
    if(guardedFinalized)return;guardedFinalized=true;
    // Drain responses while context still exists, then save the latest auth state.
    if(launched){await evidence.drain();if(!manualLogin||status==='completed')await saveSession(launched.context,config,store).catch(()=>{if(status==='completed'){status='partial';stopReason='session_save_failed'}});await launched.close();await evidence.drain();}
    for(const st of states.values())for(const action of st.interactives){if(action.status==='running'){action.status='planned';action.reason='interrupted_before_commit';}}
    const pending={states:[...states.values()].filter(hasPending).length,actions:[...states.values()].reduce((n,s)=>n+s.interactives.filter(isPending).length,0),failed:[...states.values()].reduce((n,s)=>n+s.interactives.filter(a=>a.status==='failed').length,0),seeds:[...evidence.seeds].filter(u=>!seedsVisited.has(u)).length};
    pending.bootstrap=states.size?0:1;
    if(status==='running'){status=pending.actions||pending.failed||pending.seeds?'partial':'completed';stopReason=status==='completed'?'frontier_exhausted':pending.failed?'failed_actions':'pending_actions';}
    if(status==='completed'&&[...gaps.values()].some(g=>['replay_state_changed','unsafe_replay_requires_manual_state','evidence_drain_timeout','seed_http_error'].includes(g.reason))){status='partial';stopReason='unresolved_coverage_errors';}
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
    save();
    const elapsedMs=(store.meta.elapsedMs||0)+Date.now()-started;
    store.update({status,stopReason,finishedAt:new Date().toISOString(),elapsedMs,pending,counts:{...budget.counts,states:states.size,apis:evidence.ledger.size,harEntries},coverageGaps:[...gaps.values()]});
    try{writeReport({allStates:states,visitedHits,config,elapsedMs,log,backEdges,run:store.meta});}
    catch(error){
      store.emit('export_error',{stage:'report',message:String(error.message||error).slice(0,300)});
      // A failed report must not leave a faked completed result in run/manifest/tree
      // or in the public event export; keep any pre-existing failure reason intact.
      if(status==='completed'){
        status='partial';stopReason='report_export_failed';
        save();
        store.update({status,stopReason,finishedAt:new Date().toISOString(),elapsedMs,pending,counts:{...budget.counts,states:states.size,apis:evidence.ledger.size,harEntries},coverageGaps:[...gaps.values()]});
        const adjustment={kind:'result_adjusted',reason:'report_export_failed',status,stopReason};
        store.emit('result_adjusted',adjustment);
        try{appendFileSync(path.join(store.dir,'events.jsonl'),JSON.stringify(redact({...adjustment,ts:new Date().toISOString()}))+'\n');}catch{/* public copy best effort */}
        try{writeReport({allStates:states,visitedHits,config,elapsedMs,log,backEdges,run:store.meta});}
        catch{/* still unwritable; manifest/tree were refreshed above where possible */}
      }
    }
    return store.meta;
  }
  try {
    if(resume&&existsSync(path.join(store.dir,'STOP'))){rmSync(path.join(store.dir,'STOP'));store.emit('resume_stop_cleared');}
    if(config.storageState)sessionLock=acquireLock(`${config.storageState}.bfs.lock`,{runId:config.runId});
    store.update({runtime:{node:process.version,platform:process.platform,playwright:JSON.parse(execFileSync(process.execPath,['-e',"process.stdout.write(JSON.stringify(require('playwright/package.json').version))"],{encoding:'utf8',windowsHide:true})),codeVersion:gitVersion()}});
    for(const note of config._migration||[])log('[迁移] '+note);
    launched=await launchGuardedBrowser(config,policy,budget,store);evidence.attach(launched.context);
    store.update({browser:{engine:'chromium',version:launched.context.browser().version(),channel:config.channel||null}});
    await newPage();await page.evaluate(({selectors,noise,auth})=>{for(const s of [...selectors,...noise,...auth].filter(Boolean))document.querySelector(s)}, {selectors:config.excludeSelectors,noise:config.fingerprintIgnoreSelectors,auth:[config.auth.loggedInSelector,config.auth.loggedOutSelector]});
    store.emit('coverage_gap',{reason:'closed_shadow_roots_unsupported'});
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
    if(!states.size){const root=await collectState(null,[],0);if(root?.id)frontier.push(root.id);}
    else{
      // Rebuild the frontier BEFORE deciding completion, including states clipped by prior depth/budget.
      for(const state of states.values()){
        for(const action of state.interactives){if(action.status==='running'||action.status==='failed'&&(action.attempts||0)<=config.maxRetries){action.status='planned';action.reason='resume_retry';}}
        if(hasPending(state))frontier.push(state.id);
      }
      store.emit('resume_frontier',{states:frontier.length});
    }
    for(const seed of config.seedRoutes){const url=new URL(seed,config.startUrl).href;evidence.seeds.add(url)}
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
    let depthClipped=false;
    while(frontier.length||[...evidence.seeds].some(u=>!seedsVisited.has(u))){
      budget.check();
      if(config.maxDurationMs!=null&&Date.now()-lastProgress>Math.min(config.maxDurationMs,60000)){throw new StopError('no_progress');}
      if(!frontier.length){const seed=[...evidence.seeds].find(u=>!seedsVisited.has(u));await seedVisit(seed);continue;}
      const id=config.order==='dfs'?frontier.pop():frontier.shift();const state=states.get(id);if(!state)continue;
      if(!hasPending(state)){state.expanded=true;continue;}
      if(limitReached(config,'maxDepth',state.depth)){depthClipped=true;continue;}
      if(limitReached(config,'maxStates',states.size))throw new StopError('max_states');
      for(const action of state.interactives){
        if(!isPending(action))continue;budget.check();
        if(limitReached(config,'maxStates',states.size))throw new StopError('max_states');
        if(state.path.some(p=>p.safeReplay===false)){action.status='skipped';action.reason='unsafe_replay_requires_manual_state';store.emit('coverage_gap',{reason:action.reason,stateId:state.id});continue;}
        try{
          await reach(state);budget.action();setHint(action);action.status='running';action.attempts++;save();
          action.evidenceId=store.emit('action_started',{actionId:action.id,stateId:state.id,label:action.label,kind:action.kind});
          await clickElement(page,dialogs,action,config,log);
          await checkAuth(true);const after=await fingerprint(page,config);
          if(config._runtime.dialogRejected){action.status='skipped';action.reason='native_confirmation_rejected';}
          else if(config._runtime.blockedRequests.some(r=>r.navigation||['unsafe_endpoint','unapproved_write_method','graphql_operation_not_read_query'].includes(r.reason))){action.status='skipped';action.reason='request_policy_blocked';}
          else{
            const d=policy.navigation(page.url());if(!d.allow){action.status='skipped';action.reason=d.reason;}
            else{
              const child=await collectState(state,[...state.path,{...action,status:undefined,evidenceId:undefined}],state.depth+1);
              if(child?.id)frontier.push(child.id);else if(child?.dup){backEdges.push({from:state.id,to:child.dup,label:action.label,url:child.url});store.emit('state_merged',{stateId:state.id,actionId:action.id,into:child.dup,reason:'same_semantic_fingerprint'});}
              action.status='succeeded';action.reason=after.fp===state.fp?'triggered_without_new_state':'triggered_state_change';state.processed.push(action.id);
            }
          }
          store.emit('action_finished',{stateId:state.id,actionId:action.id,status:action.status,reason:action.reason,url:page.url()});failureCount=0;lastProgress=Date.now();save();
        }catch(error){
          if(error instanceof StopError||budget.reason){action.status='planned';action.reason='interrupted';throw error;}
          if(error.name==='PolicyError'){action.status='skipped';action.reason=error.reason||error.message;}
          else{action.status='failed';action.reason=String(error.message||error).slice(0,800);state.failed.push({selector:action.selector,message:action.reason});failureCount++;}
          store.emit('action_finished',{stateId:state.id,actionId:action.id,status:action.status,reason:action.reason});save();
          if((config.circuitBreakerMax??5)>0&&failureCount>=(config.circuitBreakerMax??5))throw new StopError('consecutive_failures','partial');
        }finally{setHint(null);}
      }
      state.expanded=!hasPending(state);save();
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
