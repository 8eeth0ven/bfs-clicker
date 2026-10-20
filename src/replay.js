// Every replay/fallback repeats the live policy check on the exact DOM target.
import { collectInteractives, locate, checkLiveAction, frameFor } from './discover.js';
import { fillValueFor, isDropdownTrigger, isFormAction, pickOpenOption, prepareForm } from './formfill.js';
export async function clickElement(page,dialogs,el,config={},log=()=>{},opts={}) {
  config._runtime?.budget?.check();
  if(el.skipped || el.excluded)throw Object.assign(new Error(el.skipReason||'excluded_action'),{name:'PolicyError'});
  if(el.kind==='scroll'){
    await frameFor(page,el).evaluate(step=>{
      const candidates=[document.scrollingElement,...document.querySelectorAll('[data-bfs-scroll],[role="list"],[role="listbox"]')].filter(Boolean);
      for(const node of candidates)if(node.scrollHeight>node.clientHeight+10)node.scrollTop=Math.min(node.scrollHeight,node.clientHeight*Math.max(1,step));
    },el.scrollStep||1);
    await dialogs.stabilize(opts.short);return;
  }
  await dialogs.handle();
  let target=el;
  let loc=locate(page,target);
  if(await loc.count()!==1){
    const items=await collectInteractives(page,config);
    target=items.find(v=>!v.skipped&&v.label===el.label&&JSON.stringify(v.framePath)===JSON.stringify(el.framePath))||null;
    if(!target)throw new Error('找不到唯一元素: '+el.label);
    loc=locate(page,target);
    if(await loc.count()!==1)throw new Error('重定位结果不唯一: '+el.label);
  }
  loc=await checkLiveAction(page,target,config);
  const timeout=Math.max(1,Math.min(config.actionTimeoutMs||4000,config._runtime?.budget?.remainingMs??Infinity));
  if(config.formExplore && isFormAction(target))await prepareForm(page,config,log);
  if(el.kind==='hover')await loc.hover({timeout});
  else if(target.type==='checkbox')await loc.setChecked(el.checkedValue??true,{timeout});
  else if(target.type==='radio')await loc.check({timeout});
  else if(target.type==='select'){
    const options=target.options?.filter(v=>v.value!=='')||[];
    if(el.optionValue!=null)await loc.selectOption(el.optionValue,{timeout});
    else if(options.length)await loc.selectOption(options[0].value,{timeout});
    else if(await loc.locator('option').count()>1)await loc.selectOption({index:1},{timeout});
  }else if(target.type==='text'){
    if(!config.fillText&&!config.formExplore)return;
    const value=config.formValues?.[target.selector]??fillValueFor(target,config);
    if(value!=null)await loc.fill(value,{timeout});
  }else{
    try{await loc.click({timeout});}
    catch(error){
      if(config.jsClickFallback!==true)throw error;
      // JS fallback only uses the same uniquely located, newly checked element.
      loc=await checkLiveAction(page,target,config);await loc.evaluate(element=>element.click());
    }
  }
  if(config.formExplore && isDropdownTrigger(target))await pickOpenOption(page,log,config);
  await dialogs.handle();await dialogs.stabilize(opts.short);
}
export async function replayPath(page,dialogs,steps,config,log=()=>{},opts={}) {
  for(const step of steps){
    if(step.safeReplay===false)throw Object.assign(new Error('unsafe_replay_requires_manual_state'),{name:'PolicyError'});
    if(step.gotoUrl)await gotoStep(page,dialogs,step.gotoUrl,config,log,opts);
    else await clickElement(page,dialogs,step,config,log,opts);
  }
}
export async function gotoWithRetry(page,url,config,log=()=>{},label='') {
  const decision=config._policy?.navigation(url);
  if(decision&&!decision.allow)throw Object.assign(new Error(decision.reason),{name:'PolicyError',reason:decision.reason});
  const retries=config.maxRetries??config.gotoRetries??1;
  for(let i=0;;i++){
    config._runtime?.budget?.check();
    try{return await page.goto(url,{waitUntil:'domcontentloaded',timeout:Math.max(1,Math.min(config.gotoTimeoutMs||15000,config._runtime?.budget?.remainingMs??Infinity))});}
    catch(error){
      config._runtime?.budget?.check();
      if(i>=retries||!/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_SOCKET|ERR_HTTP2|Timeout/i.test(error.message))throw error;
      log('[重试] '+(label||url)+' '+(i+1)+'/'+retries);
      config._runtime?.emit('navigation_retry',{url,attempt:i+1,message:error.message});
      if(config._runtime?.budget)await config._runtime.budget.pause(Math.min(config.retryMaxDelayMs||5000,250*(i+1)));
      else await new Promise(r=>setTimeout(r,250*(i+1)));
    }
  }
}
export async function gotoStep(page,dialogs,url,config,log=()=>{},opts={}) {
  await gotoWithRetry(page,url,config,log);await dialogs.handle();await dialogs.stabilize(opts.short);
}
