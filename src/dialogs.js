// Native confirmations are rejected; consent requires explicit configuration and context.
import { collectInteractives, locate, checkLiveAction } from './discover.js';
import { randomUUID } from 'node:crypto';

// The observer stores counters only; no page text or application values leave a frame.
// A new document gets its own instance id, so a navigation cannot reuse an old snapshot.
function observeDom({key,ignore}) {
  if (!window[key]) {
    const state={instance:Math.random().toString(36).slice(2),revision:0,lastActivity:Date.now()};
    const roots=new WeakSet();
    const ignored=node=>{
      let el=node.nodeType===1?node:node.parentElement;
      while(el){
        if(ignore.some(selector=>{try{return el.matches(selector)||el.closest(selector)}catch{return false}}))return true;
        el=el.getRootNode()?.host||null;
      }
      return false;
    };
    const scan=root=>{
      if(root.shadowRoot)watch(root.shadowRoot);
      for(const el of root.querySelectorAll?.('*')||[])if(el.shadowRoot)watch(el.shadowRoot);
    };
    const observer=new MutationObserver(records=>{
      let changed=false;
      for(const record of records){
        if(ignored(record.target))continue;
        if(record.type==='childList'&&[...record.addedNodes,...record.removedNodes].every(ignored))continue;
        changed=true;
        for(const node of record.addedNodes||[])if(node.nodeType===1)scan(node);
      }
      if(changed){state.revision++;state.lastActivity=Date.now();}
    });
    const watch=root=>{if(roots.has(root))return;roots.add(root);observer.observe(root,{childList:true,subtree:true,attributes:true,characterData:true});scan(root);};
    // attachShadow itself emits no DOM mutation. Observe a root attached to an
    // existing host without repeatedly walking the complete document.
    const prototype=Element.prototype,descriptor=Object.getOwnPropertyDescriptor(prototype,'attachShadow');
    let active=true,wrapped;
    if(descriptor?.value)try{
      wrapped=function attachShadow(...args){
        const root=Reflect.apply(descriptor.value,this,args);
        if(active&&root.mode==='open'&&!ignored(this)){watch(root);state.revision++;state.lastActivity=Date.now();}
        return root;
      };
      Object.defineProperty(prototype,'attachShadow',{...descriptor,value:wrapped});
    }catch{/* Existing roots still remain observable when the prototype is sealed. */}
    state.disconnect=()=>{
      active=false;observer.disconnect();
      if(wrapped&&prototype.attachShadow===wrapped)Object.defineProperty(prototype,'attachShadow',descriptor);
    };
    Object.defineProperty(window,key,{value:state,configurable:true});
    watch(document);
  }
  const {instance,revision,lastActivity}=window[key];
  return {instance,revision,lastActivity};
}

export function makeDialogs(page,config={},log=()=>{}) {
  let lastActivity=Date.now(),rejections=0,version=0,settledVersion=-1,settledResult=null,disposed=false;
  const requests=new Set(),domVersions=new Map();
  const key='__bfs_stability_'+randomUUID().replaceAll('-','');
  const observerArgs={key,ignore:config.fingerprintIgnoreSelectors||['[data-bfs-noise]','[role="timer"]']};
  // addInitScript covers future documents; observeDom below also arms existing frames.
  const observerReady=typeof page.addInitScript==='function'
    ? page.addInitScript(observeDom,observerArgs).catch(()=>{}) : Promise.resolve();
  const invalidate=()=>{version++;lastActivity=Date.now();};
  const emit=config._runtime?.emit||(()=>{});
  const onRequest=request=>{requests.add(request);invalidate();};
  const onFinished=request=>{requests.delete(request);invalidate();};
  const onFrame=()=>invalidate();
  const readDom=async()=>{
    if(disposed)return;
    await observerReady;
    if(disposed)return;
    const frames=page.frames?.()||[page],current=new Set();
    await Promise.all(frames.slice(0,config.maxFrames||12).map(async frame=>{
      if(typeof frame.evaluate!=='function')return;
      if(frame!==frames[0]){
        const url=frame.url?.()||'';
        let allowed=false;
        try{
          const inherited=/^about:(?:blank|srcdoc)$/.test(url)?frame.parentFrame?.()?.url?.():url;
          allowed=new URL(inherited).origin===new URL(page.url()).origin || !!config._policy?.navigation(inherited).allow;
        }catch{}
        if(!allowed)return;
      }
      current.add(frame);
      try{
        const state=await frame.evaluate(observeDom,observerArgs);
        const signature=state.instance+':'+state.revision;
        if(domVersions.get(frame)!==signature){
          domVersions.set(frame,signature);version++;
          lastActivity=Math.max(lastActivity,Math.min(Date.now(),state.lastActivity));
        }
      }catch(error){
        config._runtime?.budget?.check();
        if(page.isClosed?.())throw error;
        // Navigation can destroy an evaluation context. Keep observing until the
        // bounded deadline instead of accepting an unavailable DOM as stable.
        invalidate();
      }
    }));
    for(const frame of domVersions.keys())if(!current.has(frame)){domVersions.delete(frame);invalidate();}
  };
  const onDialog=dialog=>{
    invalidate();rejections++;
    emit('native_dialog',{type:dialog.type(),message:dialog.message(),decision:'dismiss',actionId:config._runtime?.currentActionId||null});
    if(config._runtime)config._runtime.dialogRejected=true;
    log('  [原生弹窗] '+dialog.type()+' → dismiss');
    dialog.dismiss().catch(e=>emit('dialog_failure',{message:e.message}));
  };
  page.on('request',onRequest);page.on('requestfinished',onFinished);page.on('requestfailed',onFinished);page.on('dialog',onDialog);
  page.on('framenavigated',onFrame);page.on('frameattached',onFrame);page.on('framedetached',onFrame);
  async function findVisibleModal() {
    for(const selector of config.modalSelectors||[]){
      const loc=page.locator(selector);
      for(let i=0;i<Math.min(await loc.count(),20);i++)if(await loc.nth(i).isVisible())return loc.nth(i);
    }
    return null;
  }
  async function handle() {
    if(config.autoAgreeConsent!==true)return;
    const modal=await findVisibleModal();if(!modal)return;
    const text=await modal.innerText().catch(()=>'');
    const context=(config.consentKeywords||[]).some(word=>text.toLowerCase().includes(word.toLowerCase()));
    if(!context || /授权|付款|支付|购买|delete|purchase|payment|authorize/i.test(text)){emit('coverage_gap',{reason:'unapproved_html_dialog',url:page.url()});return;}
    const items=await collectInteractives(page,config);
    for(const item of items){
      if(item.excluded)continue;
      const locator=locate(page,item);
      const inside=await locator.evaluate((el,selectors)=>selectors.some(s=>!!el.closest(s)),config.modalSelectors||[]);
      if(!inside)continue;
      const isAgreement=(config.agreeKeywords||[]).some(w=>String(item.label).toLowerCase().includes(w.toLowerCase()));
      if(item.type!=='checkbox' && !isAgreement)continue;
      // Explicit consent action still obeys exclusions and scope. It cannot invoke a write endpoint.
      const consentConfig={...config,_policy:config._policy?{...config._policy,action:el=>el.excluded?{allow:false,reason:'excluded_selector'}:el.formAction?{allow:false,reason:'consent_form_not_approved'}:{allow:true,reason:'explicit_consent'}}:undefined};
      const live=await checkLiveAction(page,item,consentConfig);
      invalidate();
      if(item.type==='checkbox')await live.check({timeout:1000});else await live.click({timeout:1000});
      emit('consent_action',{label:item.label,url:page.url(),reason:'explicit_consent'});
      if(!(await modal.isVisible().catch(()=>false)))return;
    }
  }
  async function stabilize(short=false) {
    const settings={quietMs:80,timeoutMs:1500,settleMs:80,...config.stabilize};
    const budget=config._runtime?.budget;
    budget?.check();
    await readDom();
    budget?.check();
    if(disposed)return {stable:false,disposed:true};
    if(settledVersion===version)return {...settledResult,cached:true,observedMs:0};
    const started=Date.now();
    // quiet + settle form a continuous observation window. With the defaults it
    // lasts at least 160ms, including when a click issued no network request.
    // DOM/network activity restarts that window; timeoutMs is its hard ceiling.
    const observationMs=settings.quietMs+settings.settleMs;
    const timeoutMs=Math.min(short?Math.min(400,settings.timeoutMs):settings.timeoutMs,budget?.remainingMs??Infinity);
    const deadline=started+timeoutMs;
    let stable=false;
    for(;;){
      budget?.check();
      if(disposed)return {stable:false,disposed:true};
      const now=Date.now();
      stable=requests.size===0&&now-started>=observationMs&&now-lastActivity>=observationMs;
      if(stable||now>=deadline)break;
      const delay=Math.min(40,deadline-now);
      if(budget)await budget.pause(delay);else await new Promise(resolve=>setTimeout(resolve,delay));
      await readDom();
    }
    budget?.check();
    // Cache an observed generation even if its bounded window timed out. Calling
    // helper layers again cannot add information without a new event/mutation.
    settledVersion=version;
    settledResult={stable,timedOut:!stable,cached:false,observedMs:Date.now()-started};
    return settledResult;
  }
  return {handle,stabilize,invalidate,findVisibleModal,consentFallback:async()=>false,get rejections(){return rejections},
    dispose(){
      disposed=true;requests.clear();
      page.off('request',onRequest);page.off('requestfinished',onFinished);page.off('requestfailed',onFinished);page.off('dialog',onDialog);
      page.off('framenavigated',onFrame);page.off('frameattached',onFrame);page.off('framedetached',onFrame);
      for(const frame of domVersions.keys())frame.evaluate?.(key=>{window[key]?.disconnect();delete window[key];},key).catch(()=>{});
      domVersions.clear();
    }
  };
}
