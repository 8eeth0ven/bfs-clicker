// Native confirmations are rejected; consent requires explicit configuration and context.
import { collectInteractives, locate, checkLiveAction } from './discover.js';
export function makeDialogs(page,config={},log=()=>{}) {
  let inflight=0,lastActivity=Date.now(),rejections=0;
  const emit=config._runtime?.emit||(()=>{});
  const onRequest=()=>{inflight++;lastActivity=Date.now()};
  const onFinished=()=>{inflight=Math.max(0,inflight-1);lastActivity=Date.now()};
  const onDialog=dialog=>{
    rejections++;
    emit('native_dialog',{type:dialog.type(),message:dialog.message(),decision:'dismiss',actionId:config._runtime?.currentActionId||null});
    if(config._runtime)config._runtime.dialogRejected=true;
    log('  [原生弹窗] '+dialog.type()+' → dismiss');
    dialog.dismiss().catch(e=>emit('dialog_failure',{message:e.message}));
  };
  page.on('request',onRequest);page.on('requestfinished',onFinished);page.on('requestfailed',onFinished);page.on('dialog',onDialog);
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
      if(item.type==='checkbox')await live.check({timeout:1000});else await live.click({timeout:1000});
      emit('consent_action',{label:item.label,url:page.url(),reason:'explicit_consent'});
      if(!(await modal.isVisible().catch(()=>false)))return;
    }
  }
  async function stabilize(short=false) {
    const settings=config.stabilize||{quietMs:80,timeoutMs:1500,settleMs:80};
    const deadline=Date.now()+Math.min(short?400:settings.timeoutMs,config._runtime?.budget?.remainingMs??Infinity);
    while(Date.now()<deadline){
      config._runtime?.budget?.check();
      if(inflight===0&&Date.now()-lastActivity>=settings.quietMs)break;
      await new Promise(r=>setTimeout(r,40));
    }
    if(config._runtime?.budget)await config._runtime.budget.pause(settings.settleMs);else await new Promise(r=>setTimeout(r,settings.settleMs));
  }
  return {handle,stabilize,findVisibleModal,consentFallback:async()=>false,get rejections(){return rejections},
    dispose(){page.off('request',onRequest);page.off('requestfinished',onFinished);page.off('requestfailed',onFinished);page.off('dialog',onDialog)}
  };
}
