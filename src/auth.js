import { atomicJson } from './store.js';

export async function authenticationStatus(page,context,config,store) {
  const rules=config.auth||{};const url=page.url();
  const visible=async selector=>selector?await page.locator(selector).first().isVisible().catch(()=>false):false;
  if(await visible(rules.loggedOutSelector) || rules.loggedOutUrlPattern&&new RegExp(rules.loggedOutUrlPattern).test(url)) return {ok:false,status:'needs_auth',reason:'logged_out_marker'};
  const signals=[];
  if(rules.loggedInSelector)signals.push(await visible(rules.loggedInSelector));
  if(rules.loggedInUrlPattern)signals.push(new RegExp(rules.loggedInUrlPattern).test(url));
  if(rules.localStorageKey)signals.push(await page.evaluate(key=>!!localStorage.getItem(key),rules.localStorageKey).catch(()=>false));
  if(rules.probeUrl){
    const probe=await page.evaluate(async({url,limit})=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),limit);
      try{
        const response=await fetch(url,{signal:controller.signal,credentials:'same-origin'});
        const reader=response.body?.getReader();let length=0;const chunks=[];
        if(reader)for(;;){const {value,done}=await reader.read();if(done)break;
          if(length+value.length>65536){await reader.cancel();return {status:response.status,text:'',tooLarge:true};}
          length+=value.length;chunks.push(value);}
        const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
        return {status:response.status,text:new TextDecoder().decode(bytes)};
      }catch{return {status:0,text:''}}finally{clearTimeout(timer)}
    },{url:rules.probeUrl,limit:Math.min(config.bodyTimeoutMs,config._runtime?.budget?.remainingMs||3000)});
    let ok=!probe.tooLarge&&probe.status===(rules.probeStatus||200);
    if(ok&&rules.probeJson){try{const json=JSON.parse(probe.text);ok=Object.entries(rules.probeJson).every(([k,v])=>json[k]===v)}catch{ok=false}}
    signals.push(ok);store?.emit('auth_probe',{url:rules.probeUrl,status:probe.status,ok});
  }
  if(signals.length){const ok=signals.every(Boolean);return {ok,status:ok?'running':'needs_auth',reason:ok?'auth_rule_verified':'auth_rule_failed'};}
  const shell=await page.evaluate(()=>{
    const text=(document.body?.innerText||'').slice(0,3000);
    const password=!!document.querySelector('input[type="password"]');
    const challenge=/verify (?:you are|you're) human|checking your browser|captcha|验证码|人机验证|access denied|just a moment/i.test(text+' '+document.title);
    return {challenge,password,textLength:text.length};
  }).catch(()=>({}));
  if(shell.challenge)return {ok:false,status:'blocked',reason:'challenge_or_access_denied_shell'};
  if(shell.password || /\/(?:login|signin|sign-in|sso)(?:\/|\?|$)/i.test(url))return {ok:false,status:'needs_auth',reason:'login_shell'};
  if(rules.required || config.authMode==='manual')return {ok:false,status:'needs_auth',reason:'missing_success_criterion'};
  return {ok:true,status:'running',reason:config.authMode==='anonymous'?'anonymous':'unverified_session_no_login_marker'};
}
export async function saveSession(context,config,store) {
  if(config.authMode==='anonymous' || process.env.BFS_SESSION_WRITEBACK==='0')return;
  try{
    const state=await context.storageState();
    atomicJson(store.privateDir+'/session.json',state);
    for(const target of new Set([config.storageState,config.sessionWritebackTo].filter(Boolean)))atomicJson(target,state);
    store.emit('session_saved',{cookies:state.cookies.length,origins:state.origins.length});
  }catch(error){store.emit('session_save_failed',{message:error.message});throw error;}
}
