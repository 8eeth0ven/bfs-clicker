// A finite, locally approved vertical list. Scrolls are actions; inventory is not.
import {frameFor,locate,checkLiveAction} from './discover.js';
import {authenticationStatus} from './auth.js';
import {assertVirtualApproval,createVirtualLedger,virtualDigest,virtualDomainDigest,virtualFail,virtualPolicyFor,virtualOptionSelector} from './aria-virtual-policy.js';

const fail=virtualFail;
const same=(a,b)=>virtualDigest(a)===virtualDigest(b);
const key=policy=>JSON.stringify([policy.framePath,policy.selector]);

export function virtualQuota(page,config,policy){
  const deadline=performance.now()+policy.timeoutMs,budget=config._runtime?.budget;
  if(!budget)fail('ARIA_VIRTUAL_RUNTIME_REQUIRED');
  let failed=false;
  return {scrolls:0,snapshots:0,deadline,
    check(){budget.check();if(failed||performance.now()>=deadline)fail('ARIA_VIRTUAL_TIMEOUT');if(config._runtime.signal?.aborted)fail('CANCELLED');if(config._runtime.dialogRejected||config._runtime.blockedRequests?.length)fail('WORKFLOW_POLICY_BLOCKED');},
    async run(start){
      this.check();let timer;
      try{const result=await Promise.race([start(),new Promise((_,reject)=>{timer=setTimeout(()=>{failed=true;void page.close().catch(()=>{});reject(Object.assign(new Error('ARIA_VIRTUAL_TIMEOUT'),{code:'ARIA_VIRTUAL_TIMEOUT'}));},Math.max(1,deadline-performance.now()));})]);this.check();return result;}
      finally{clearTimeout(timer);}
    },
  };
}

async function guard(context){
  const {page,config,policy,quota,frame}=context;quota.check();
  if(frameFor(page,{framePath:policy.framePath})!==frame||!config._policy?.navigation(page.url()).allow||!config._policy.navigation(frame.url()).allow)fail('FRAME_OUT_OF_SCOPE');
  if(performance.now()>=(context.nextAuth||0)){
    const auth=await quota.run(()=>authenticationStatus(page,page.context(),config,{emit:config._runtime.emit}));if(!auth.ok)fail('ARIA_VIRTUAL_AUTH_UNVERIFIED');context.nextAuth=performance.now()+1000;
  }
}

export async function pinVirtualControl(page,config,policy,quota=virtualQuota(page,config,policy)){
  assertVirtualApproval(config,policy);quota.check();
  const target={selector:policy.selector,framePath:policy.framePath},frame=frameFor(page,target);
  if(!config._policy?.navigation(frame.url()).allow)fail('FRAME_OUT_OF_SCOPE');
  const locator=locate(page,target);if(await quota.run(()=>locator.count())!==1)fail('ARIA_VIRTUAL_IDENTITY_CHANGED');
  await quota.run(()=>checkLiveAction(page,{...target,type:'click',kind:'click',role:'combobox'},config));
  const control=await quota.run(()=>locator.elementHandle());if(!control)fail('ARIA_VIRTUAL_IDENTITY_CHANGED');
  const valid=await quota.run(()=>control.evaluate(element=>{
    const r=element.getBoundingClientRect(),style=getComputedStyle(element),x=r.x+r.width/2,y=r.y+r.height/2;
    let hit=document.elementFromPoint(x,y);while(hit?.shadowRoot){const nested=hit.shadowRoot.elementFromPoint(x,y);if(!nested||nested===hit)break;hit=nested;}
    return element.getAttribute('role')==='combobox'&&element.getAttribute('aria-expanded')==='false'&&!element.disabled&&element.getAttribute('aria-disabled')!=='true'&&element.getAttribute('aria-readonly')!=='true'&&r.width>0&&r.height>0&&style.display!=='none'&&style.visibility==='visible'&&Number(style.opacity)>0&&(hit===element||element.contains(hit));
  }));
  if(!valid){await control.dispose();fail('ARIA_VIRTUAL_CONTROL_UNVERIFIED');}
  return {page,config,policy,quota,frame,control,list:null,scroll:null,contract:null};
}

async function pinOpened(context){
  const {frame,policy,quota}=context;
  for(;;){
    quota.check();const list=frame.locator(policy.listboxSelector),scroll=frame.locator(policy.scrollSelector),a=await quota.run(()=>list.count()),b=await quota.run(()=>scroll.count());
    if(a>1||b>1)fail('ARIA_VIRTUAL_IDENTITY_CHANGED');
    if(a===1&&b===1){context.list=await quota.run(()=>list.elementHandle());context.scroll=await quota.run(()=>scroll.elementHandle());if(context.list&&context.scroll)return;}
    await context.config._runtime.budget.pause(Math.min(30,Math.max(1,quota.deadline-performance.now())));
  }
}

export async function readVirtualSnapshot(context){
  const {policy,quota,config}=context;await guard(context);
  if(quota.snapshots>=policy.maxSnapshots)fail('ARIA_VIRTUAL_SNAPSHOT_LIMIT');quota.snapshots++;
  const snapshot=await quota.run(()=>context.control.evaluate((control,{list,scroll,policy,exclusions})=>{
    const error=code=>({error:code}),clean=value=>String(value||'').replace(/\s+/g,' ').trim(),root=control.getRootNode();
    const metadata=element=>({tag:element.tagName.toLowerCase(),role:element.getAttribute('role')||'',id:element.id||'',name:element.getAttribute('name')||'',aria:element.getAttribute('aria-label')||'',title:element.getAttribute('title')||''});
    const excluded=element=>{for(let node=element;node;node=node.parentElement||node.getRootNode()?.host||null)if(exclusions.some(selector=>node.matches(selector)||node.closest(selector)))return true;return false;};
    const active=element=>{for(let node=element;node;node=node.parentElement||node.getRootNode()?.host||null){const s=getComputedStyle(node);if(s.display==='none'||s.visibility!=='visible'||Number(s.opacity)===0)return false;}return true;};
    const hit=(element,x,y)=>{let found=document.elementFromPoint(x,y);while(found?.shadowRoot){const child=found.shadowRoot.elementFromPoint(x,y);if(!child||child===found)break;found=child;}return found===element||element.contains(found);};
    if(!control.isConnected||!list.isConnected||!scroll.isConnected||control.getAttribute('role')!=='combobox'||control.getAttribute('aria-expanded')!=='true'||control.getAttribute('aria-disabled')==='true'||control.disabled||control.getAttribute('aria-readonly')==='true'||list.getRootNode()!==root||scroll.getRootNode()!==root||list.getAttribute('role')!=='listbox'||control.getAttribute('aria-controls')!==list.id||!list.id||root.querySelectorAll('[id]').length>8000)return error('ARIA_VIRTUAL_RELATION_CHANGED');
    const roots=[document];let nodes=0,matches=0;for(let i=0;i<roots.length;i++)for(const node of roots[i].querySelectorAll('*')){if(++nodes>8000)return error('ARIA_VIRTUAL_DOM_LIMIT');if(node.id===list.id)matches++;if(node.shadowRoot){if(roots.length>=16)return error('ARIA_VIRTUAL_DOM_LIMIT');roots.push(node.shadowRoot);}}
    // Verify every current selector against its pinned node in this SAME DOM
    // observation, instead of six separate CDP count/identity round trips.
    try{for(const [selector,pinned]of [[policy.selector,control],[policy.listboxSelector,list],[policy.scrollSelector,scroll]]){const current=roots.flatMap(root=>Array.from(root.querySelectorAll(selector)));if(current.length!==1||current[0]!==pinned)return error('ARIA_VIRTUAL_IDENTITY_CHANGED');}}
    catch{return error('ARIA_VIRTUAL_CONFIG_INVALID');}
    if(matches!==1||['HTML','BODY'].includes(scroll.tagName)||!(scroll===list||scroll.contains(list)||list.contains(scroll))||Array.from(scroll.querySelectorAll('[role="listbox"]')).some(node=>node!==list)||excluded(control)||excluded(list)||excluded(scroll))return error('ARIA_VIRTUAL_RELATION_CHANGED');
    const cr=control.getBoundingClientRect(),lr=list.getBoundingClientRect(),sr=scroll.getBoundingClientRect(),style=getComputedStyle(scroll);
    if(!active(control)||!active(list)||!active(scroll)||!cr.width||!cr.height||!lr.width||!lr.height||!sr.width||!sr.height||!hit(control,cr.x+cr.width/2,cr.y+cr.height/2)||!['auto','scroll'].includes(style.overflowY)||scroll.scrollLeft!==0||scroll.scrollWidth>scroll.clientWidth+1||scroll.clientHeight<=0||scroll.scrollHeight>2000000)return error('ARIA_VIRTUAL_VIEW_UNVERIFIED');
    const clip={left:Math.max(0,sr.left+scroll.clientLeft),right:Math.min(innerWidth,sr.left+scroll.clientLeft+scroll.clientWidth),top:Math.max(0,sr.top+scroll.clientTop),bottom:Math.min(innerHeight,sr.top+scroll.clientTop+scroll.clientHeight)};
    if(clip.left>=clip.right||clip.top>=clip.bottom)return error('ARIA_VIRTUAL_VIEW_UNVERIFIED');
    const options=[],elements=Array.from(list.querySelectorAll('[role="option"]')).filter(node=>node.closest('[role="listbox"]')===list);let total=null;
    if(!elements.length||elements.length>policy.maxOptions||list.getAttribute('aria-busy')==='true')return error('ARIA_VIRTUAL_OPTIONS_PENDING');
    for(const element of elements){
      const size=element.getAttribute('aria-setsize'),position=element.getAttribute('aria-posinset'),value=element.getAttribute(policy.valueAttribute),label=clean(element.textContent),r=element.getBoundingClientRect();
      if(!/^[1-9]\d{0,5}$/.test(size||'')||!/^[1-9]\d{0,5}$/.test(position||'')||total!==null&&total!==Number(size)||element.getAttribute('aria-disabled')==='true'||element.disabled||excluded(element)||!element.matches(policy.optionSelector)||!scroll.contains(element)||!active(element))return error('ARIA_VIRTUAL_DOMAIN_INVALID');total=Number(size);
      const x=r.x+r.width/2,y=r.y+r.height/2,visible=r.width>0&&r.height>0&&x>=clip.left&&x<clip.right&&y>=clip.top&&y<clip.bottom;
      if(visible&&!hit(element,x,y))return error('ARIA_VIRTUAL_TARGET_OCCLUDED');
      const form=element.closest('form');options.push({index:Number(position),value,label,visible,...metadata(element),formAction:form?.action||null,formMethod:form?.method||null,box:{x:r.x,y:r.y,width:r.width,height:r.height},fullyVisible:r.left>=clip.left&&r.right<=clip.right&&r.top>=clip.top&&r.bottom<=clip.bottom});
    }
    return {total,options,scrollTop:scroll.scrollTop,maximumTop:Math.max(0,scroll.scrollHeight-scroll.clientHeight),contract:{control:metadata(control),listbox:metadata(list),scroll:{...metadata(scroll),clientHeight:scroll.clientHeight,clientWidth:scroll.clientWidth,scrollHeight:scroll.scrollHeight,scrollWidth:scroll.scrollWidth}},atPhysicalEnd:scroll.scrollTop>=scroll.scrollHeight-scroll.clientHeight-.5};
  },{list:context.list,scroll:context.scroll,policy,exclusions:config.excludeSelectors||[]}));
  if(snapshot.error)fail(snapshot.error);
  if(context.contract&&!same(snapshot.contract,context.contract))fail('ARIA_VIRTUAL_IDENTITY_CHANGED');context.contract??=snapshot.contract;
  for(const option of snapshot.options){
    if((config.excludeTextPatterns||[]).some(pattern=>[option.label,option.aria,option.title].join(' ').toLowerCase().includes(pattern.toLowerCase()))||!config._policy.action({...option,selector:policy.optionSelector,framePath:policy.framePath,type:'click',kind:'click',role:'option',text:option.label}).allow)fail('ACTION_EXCLUDED');
  }
  return snapshot;
}

const signature=snapshot=>virtualDigest(snapshot.options.map(({index,value,label,visible})=>({index,value,label,visible})));
async function waitSnapshot(context,previous=null){
  let last=null;
  for(;;){
    context.quota.check();
    try{
      const snapshot=await readVirtualSnapshot(context),current=signature(snapshot);
      if((previous===null||current!==previous)&&current===last)return snapshot;
      last=current;
    }catch(error){if(error.code!=='ARIA_VIRTUAL_OPTIONS_PENDING')throw error;}
    await context.config._runtime.budget.pause(Math.min(30,Math.max(1,context.quota.deadline-performance.now())));
  }
}

async function scrollTo(context,top,{waitForChange=true,before}={}){
  const {quota,policy,config}=context;await guard(context);
  if(quota.scrolls>=policy.maxScrolls)fail('ARIA_VIRTUAL_SCROLL_LIMIT');
  if(!config._policy.action({selector:policy.scrollSelector,framePath:policy.framePath,type:'click',kind:'click',role:'listbox',label:''}).allow)fail('ACTION_NOT_APPROVED');
  config._runtime.budget.action();quota.scrolls++;
  const executionId=config._runtime.emit?.('aria_virtual_scroll_started',{policyId:policy.id,executionId:config._runtime.currentExecutionId,scroll:quota.scrolls,top});
  const changed=await quota.run(()=>context.scroll.evaluate((element,{top,control,list,policy})=>{
    const root=element.getRootNode();
    if(!element.isConnected||!control.isConnected||!list.isConnected||control.getRootNode()!==root||list.getRootNode()!==root||control.getAttribute('aria-expanded')!=='true'||control.getAttribute('aria-controls')!==list.id||list.getAttribute('role')!=='listbox'||control.disabled||control.getAttribute('aria-disabled')==='true'||control.getAttribute('aria-readonly')==='true')return false;
    const roots=[document];let count=0;for(let i=0;i<roots.length;i++)for(const node of roots[i].querySelectorAll('*')){if(++count>8000)return false;if(node.shadowRoot){if(roots.length>=16)return false;roots.push(node.shadowRoot);}}
    try{for(const [selector,pinned]of [[policy.selector,control],[policy.listboxSelector,list],[policy.scrollSelector,element]]){const current=roots.flatMap(root=>Array.from(root.querySelectorAll(selector)));if(current.length!==1||current[0]!==pinned)return false;}}
    catch{return false;}
    element.scrollTop=top;return true;
  },{top,control:context.control,list:context.list,policy}));
  if(!changed)fail('ARIA_VIRTUAL_IDENTITY_CHANGED');
  const snapshot=await waitSnapshot(context,waitForChange&&before?signature(before):null);
  if(Math.abs(snapshot.scrollTop-top)>1)fail('ARIA_VIRTUAL_NO_PROGRESS');
  config._runtime.emit?.('aria_virtual_scroll_finished',{policyId:policy.id,executionId,scroll:quota.scrolls,top:snapshot.scrollTop});return snapshot;
}

export async function scanVirtualDomain(context){
  await pinOpened(context);const ledger=createVirtualLedger(context.policy),positions=new Map();
  let snapshot=await scrollTo(context,0,{waitForChange:false});
  for(;;){
    ledger.add(snapshot);for(const option of snapshot.options)if(option.fullyVisible)positions.set(option.value,snapshot.scrollTop);
    if(snapshot.atPhysicalEnd){if(!ledger.complete)fail('ARIA_VIRTUAL_DOMAIN_INCOMPLETE');break;}
    const top=Math.min(snapshot.maximumTop,snapshot.scrollTop+Math.max(1,context.contract.scroll.clientHeight*.75));
    if(top<=snapshot.scrollTop)fail('ARIA_VIRTUAL_NO_PROGRESS');snapshot=await scrollTo(context,top,{before:snapshot});
  }
  context.quota.check();context.options=ledger.finish();context.positions=positions;context.snapshot=snapshot;
  return context;
}

export async function virtualTarget(context,value){
  const wanted=context.options.find(option=>option.value===value),top=context.positions.get(value);if(!wanted||top==null)fail('ARIA_VIRTUAL_TARGET_UNVERIFIED');
  if(Math.abs(context.snapshot.scrollTop-top)>.5)context.snapshot=await scrollTo(context,top,{before:context.snapshot});
  const snapshot=await readVirtualSnapshot(context),option=snapshot.options.find(option=>option.value===value);
  if(!option||option.index!==wanted.index||option.label!==wanted.label||!option.fullyVisible)fail('ARIA_VIRTUAL_TARGET_UNVERIFIED');
  const target={selector:virtualOptionSelector(context.policy,value),framePath:context.policy.framePath},locator=locate(context.page,target);
  if(await context.quota.run(()=>locator.count())!==1)fail('ARIA_VIRTUAL_TARGET_UNVERIFIED');
  const handle=await context.quota.run(()=>locator.elementHandle());if(!handle)fail('ARIA_VIRTUAL_TARGET_UNVERIFIED');
  return {target,locator,handle,option:wanted,context};
}

export async function verifyVirtualTarget(found){
  const {context,option,handle}=found;const snapshot=await readVirtualSnapshot(context),live=snapshot.options.find(item=>item.value===option.value);
  if(!live||!live.fullyVisible||live.index!==option.index||live.label!==option.label||!await context.quota.run(()=>found.locator.evaluate((element,previous)=>element===previous,handle)))fail('ARIA_VIRTUAL_TARGET_UNVERIFIED');
  const sameValue=await context.quota.run(()=>handle.evaluate((element,{index,value,attribute,list})=>element.getAttribute(attribute)===value&&Number(element.getAttribute('aria-posinset'))===index&&element.closest('[role="listbox"]')===list,{index:option.index,value:option.value,attribute:context.policy.valueAttribute,list:context.list}));
  if(!sameValue)fail('ARIA_VIRTUAL_TARGET_UNVERIFIED');return handle;
}

export async function closeVirtualContext(context){
  await Promise.allSettled([context?.control,context?.list,context?.scroll].filter(Boolean).map(handle=>handle.dispose()));
}

export async function exploreVirtualChoice(page,dialogs,action,config){
  const policy=virtualPolicyFor(config,action);if(!policy)return false;
  const context=await pinVirtualControl(page,config,policy);
  try{
    await context.quota.run(()=>context.control.click({timeout:Math.max(1,Math.min(config.actionTimeoutMs,policy.timeoutMs))}));
    await dialogs.handle();await dialogs.stabilize();await scanVirtualDomain(context);
    // Discovery restores the initial viewport once, but never selects an item.
    if(context.snapshot.scrollTop>.5)context.snapshot=await scrollTo(context,0,{before:context.snapshot});
    const domainDigest=virtualDomainDigest(context.options),contractDigest=virtualDigest(context.contract),policyDigest=virtualDigest(policy),executionId=config._runtime.currentExecutionId;
    context.quota.check();
    if(typeof executionId!=='string')fail('ARIA_VIRTUAL_EXECUTION_UNPROVEN');
    const evidenceId=config._runtime.emit('aria_virtual_domain_complete',{executionId,stateId:config._runtime.currentStateId,actionId:config._runtime.currentActionId,policyId:policy.id,policyDigest,selector:policy.selector,framePath:policy.framePath,domainDigest,contractDigest,total:context.options.length,scrolls:context.quota.scrolls,snapshots:context.quota.snapshots,atPhysicalEnd:true});
    context.choices={complete:true,domainEvidence:'bounded_virtual_scan',listbox:{selector:policy.listboxSelector},options:context.options,virtual:{policyId:policy.id,contract:context.contract},certificate:{evidenceId,executionId,domainDigest,contractDigest,policyDigest}};
    config._runtime.ariaVirtualDomains??=new Map();const previous=config._runtime.ariaVirtualDomains.get(key(policy));if(previous)await closeVirtualContext(previous);config._runtime.ariaVirtualDomains.set(key(policy),context);return true;
  }catch(error){await closeVirtualContext(context);throw error;}
}

export async function observedVirtualChoices(page,config,action){
  const policy=virtualPolicyFor(config,action),context=policy&&config._runtime?.ariaVirtualDomains?.get(key(policy));
  if(!context)return null;
  try{
    const snapshot=await readVirtualSnapshot(context);const expected=new Map(context.options.map(option=>[option.index,option]));
    if(snapshot.options.some(option=>{const known=expected.get(option.index);return !known||known.value!==option.value||known.label!==option.label;}))fail('ARIA_VIRTUAL_DOMAIN_CHANGED');
    return structuredClone(context.choices);
  }catch(error){config._runtime.emit?.('coverage_gap',{reason:error.code||'aria_virtual_cached_domain_invalid'});return null;}
}
