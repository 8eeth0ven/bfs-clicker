import { chromium } from 'playwright';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { acquireLock } from './store.js';
import { readSession } from './asset.js';

// Chromium Fetch is installed with auto-attach before a target runs. This also
// guards the first popup document and redirect hops, which context.route alone
// does not reliably intercept on Chromium 151.
async function installProtocolGuard(endpoint,config,policy,budget,store,onFatal,{keepStartupPage=false}={}) {
  const socket=new WebSocket(endpoint,{maxPayload:16*1024*1024});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{socket.terminate();reject(new Error('请求守卫 CDP 连接超时'))},5000);
    socket.once('open',()=>{clearTimeout(timer);resolve()});socket.once('error',e=>{clearTimeout(timer);reject(e)});
  });
  let nextId=0,closed=false;const pending=new Map(),tasks=new Set(),seenNetwork=new Set(),sessions=new Map(),startupTargets=new Set();
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    if(closed || socket.readyState!==WebSocket.OPEN) {reject(new Error('请求守卫连接关闭'));return;}
    const id=++nextId;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`请求守卫 ${method} 超时`))},Math.min(5000,Math.max(500,budget.remainingMs)));
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
  });
  const track=promise=>{tasks.add(promise);promise.finally(()=>tasks.delete(promise)).catch(()=>{});};
  const handler=async m=>{
    if(m.id){const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}return;}
    if(m.method==='Target.attachedToTarget') {
      const {sessionId,targetInfo}=m.params;sessions.set(sessionId,targetInfo);
      const type=targetInfo.type;
      if(type==='page'&&!startupTargets.has(targetInfo.targetId)&&[...sessions.values()].filter(t=>t.type==='page'&&!startupTargets.has(t.targetId)).length>config.maxTabs){
        store.emit('coverage_gap',{reason:'max_tabs_target_closed',url:targetInfo.url});
        await send('Target.closeTarget',{targetId:targetInfo.targetId}).catch(()=>{});return;
      }
      if(type==='service_worker' || type==='shared_worker') {
        store.emit('coverage_gap',{reason:`${type}_blocked`,url:targetInfo.url});
        await send('Target.closeTarget',{targetId:targetInfo.targetId}).catch(()=>{});return;
      }
      try {
        if(['page','iframe','webview'].includes(type)) await send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'},{urlPattern:'*',requestStage:'Response'}]},sessionId);
        // Dedicated worker requests are paused by their parent page's Fetch domain.
        // The worker target has no Fetch domain; continue only after its parent is armed.
        await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true},sessionId);
        await send('Runtime.runIfWaitingForDebugger',{},sessionId);
        store.emit('guard_ready',{targetType:type});
      } catch(e) {onFatal(new Error(`关键请求守卫安装失败 (${type}): ${e.message}`));}
    } else if(m.method==='Fetch.requestPaused') {
      const e=m.params;const request=e.request;
      if (e.responseStatusCode != null || e.responseErrorReason) {
        // Apply Retry-After before JavaScript receives the response and can issue
        // the next fetch. Playwright's asynchronous response event is too late.
        if (e.responseStatusCode === 429) {
          const retry = e.responseHeaders?.find(h => h.name.toLowerCase() === 'retry-after');
          budget.retryAfter(request.url, retry?.value);
        }
        if (budget.reason) await send('Fetch.failRequest',{requestId:e.requestId,errorReason:'BlockedByClient'},m.sessionId).catch(()=>{});
        else await send(e.responseErrorReason?'Fetch.continueRequest':'Fetch.continueResponse',{requestId:e.requestId},m.sessionId).catch(error=>{
          if(!budget.reason&&!/Invalid InterceptionId|Invalid interceptionId|Invalid RequestId|Target closed|Session with given id not found/.test(error.message))onFatal(error);
        });
        return;
      }
      const info={url:request.url,method:request.method,type:String(e.resourceType||'').toLowerCase(),navigation:e.resourceType==='Document',postData:request.postData||null};
      const decision=budget.reason?{allow:false,reason:budget.reason}:policy.request(info);policy.record(info,decision);
      try {
        if(!decision.allow || budget.reason) {await send('Fetch.failRequest',{requestId:e.requestId,errorReason:'BlockedByClient'},m.sessionId);return;}
        // OOPIF/worker requests can be reported by two attached targets. Count network instances once.
        const key=e.networkId ? `${e.networkId}:${request.url}:${request.method}` : `${m.sessionId}:${e.requestId}`;
        if(!seenNetwork.has(key)){seenNetwork.add(key);await budget.request(request.url);}
        budget.check();
        const headers=policy.headers(request.url,request.headers,!!e.redirectedRequestId);
        await send('Fetch.continueRequest',{requestId:e.requestId,headers:Object.entries(headers).map(([name,value])=>({name,value:String(value)}))},m.sessionId);
      } catch(error) {
        if(!budget.reason && !/Invalid InterceptionId|Invalid interceptionId|Invalid RequestId|Session with given id not found|Target closed/.test(error.message)) onFatal(error);
        await send('Fetch.failRequest',{requestId:e.requestId,errorReason:'BlockedByClient'},m.sessionId).catch(()=>{});
      }
    } else if(m.method==='Target.detachedFromTarget') sessions.delete(m.params.sessionId);
  };
  socket.on('message',data=>{let message;try{message=JSON.parse(data.toString())}catch(e){onFatal(e);return}track(handler(message).catch(onFatal));});
  socket.on('error',e=>{if(!closed)onFatal(e)});
  socket.on('close',()=>{if(!closed)onFatal(new Error('关键请求守卫意外断开'))});
  if(keepStartupPage){const {targetInfos}=await send('Target.getTargets');for(const target of targetInfos)if(target.type==='page'&&target.url==='about:blank')startupTargets.add(target.targetId);}
  await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true});
  return {
    async close(){closed=true;socket.close();for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('guard closed'))}pending.clear();},
    async drain(){await Promise.allSettled([...tasks])},
    async quiesce(){
      // Do not detach a target with unhandled Fetch pauses: Chromium resumes them.
      for(const [sessionId,target] of sessions)if(['page','iframe'].includes(target.type))await send('Network.setBlockedURLs',{urls:['*']},sessionId).catch(()=>{});
      let rounds=0;while(rounds++<4){await new Promise(r=>setTimeout(r,50));await Promise.allSettled([...tasks]);}
    },
  };
}

export async function launchGuardedBrowser(config,policy,budget,store) {
  if(config.browserType!=='chromium') throw new Error('安全请求守卫目前支持 Chromium/Chrome/Edge；Firefox/WebKit 暂未通过重定向验收');
  const profile=config.persistentProfile || mkdtempSync(path.join(tmpdir(),'bfs-browser-'));
  const releaseProfile=acquireLock(`${profile}.bfs.lock`,{profile});
  let context,guard;let intentional=false;
  const close=async()=>{
    if(intentional)return;intentional=true;
    // Keep Fetch active until targets are closed: detaching it first resumes paused requests.
    if(guard)await guard.quiesce().catch(()=>{});
    await context?.close().catch(()=>{});await guard?.close().catch(()=>{});releaseProfile();
    if(!config.persistentProfile) rmSync(profile,{recursive:true,force:true});
  };
  try {
    const extra=config.extraLaunchArgs||[];
    if(extra.some(arg=>/^--(?:remote-debugging|user-data-dir|load-extension|disable-web-security)/.test(arg))) throw new Error('extraLaunchArgs 不能覆盖调试端口、profile 或浏览器安全边界');
    context=await chromium.launchPersistentContext(profile,{
      headless:config.headless,channel:config.channel||undefined,args:['--remote-debugging-port=0',...extra],
      viewport:{width:1440,height:900},locale:'zh-CN',ignoreHTTPSErrors:config.ignoreHTTPSErrors,
      serviceWorkers:'block',userAgent:config.userAgent||undefined,
      ...(config.useProxy?{proxy:config.proxy}:{}),timeout:Math.min(20000,budget.remainingMs),
    });
    budget.check();
    // Closing the last visible window terminates a headed persistent browser.
    // Keep its blank startup tab until the first guarded page has opened.
    const startupPages=new Set(context.pages());
    if([...startupPages].some(p=>!['about:blank',''].includes(p.url())))throw new Error('独立 profile 启动时必须是空白页；请关闭恢复的旧标签后重试');
    const debugFile=path.join(profile,'DevToolsActivePort');
    if(!existsSync(debugFile)) throw new Error('浏览器没有生成 DevToolsActivePort，无法安装关键请求守卫');
    const [port,pathname]=readFileSync(debugFile,'utf8').trim().split(/\r?\n/);
    if(!/^\d+$/.test(port) || !pathname.startsWith('/devtools/browser/')) throw new Error('浏览器调试端点无效');
    const fatal=error=>{
      if(intentional||budget.reason)return;
      const fail=()=>{
        if(intentional||budget.reason)return;
        if(!context.browser()?.isConnected()){budget.stop('browser_closed','failed');return;}
        store.emit('guard_failure',{message:String(error.message||error)});budget.stop('request_guard_failed','failed');
      };
      // Context close and the CDP socket close race on an external shutdown.
      if(String(error.message).includes('守卫意外断开'))setTimeout(fail,25);else fail();
    };
    guard=await installProtocolGuard(`ws://127.0.0.1:${port}${pathname}`,config,policy,budget,store,fatal,{keepStartupPage:true});
    // Defense in depth for non-CDP hooks; all redirect checks live in Fetch above.
    await context.route('**/*',async route=>{
      const r=route.request();const info={url:r.url(),method:r.method(),type:r.resourceType(),navigation:r.isNavigationRequest(),postData:r.postData()};
      const d=policy.request(info);
      if(!d.allow || budget.reason) {await route.abort().catch(()=>{});return;}
      await route.continue({headers:policy.headers(r.url(),r.headers(),!!r.redirectedFrom())}).catch(e=>{if(!budget.reason)fatal(e)});
    });
    await context.routeWebSocket('**/*',socket=>{
      store.emit('coverage_gap',{reason:'websocket_blocked',url:socket.url()});socket.close({code:1008,reason:'WebSocket exploration requires an explicit adapter'});
    });
    await context.addInitScript(()=>{
      // WebRTC and external schemes do not pass through HTTP interception.
      for(const name of ['RTCPeerConnection','webkitRTCPeerConnection','SharedWorker']) try{Object.defineProperty(window,name,{value:undefined,configurable:false})}catch{}
      const nativeOpen=window.open;window.open=function(url,...args){if(url && !/^https?:$/.test(new URL(url,location.href).protocol))return null;return nativeOpen.call(this,url,...args)};
      document.addEventListener('click',event=>{const anchor=event.composedPath().find(v=>v?.tagName==='A');if(anchor?.href && !/^https?:$/.test(new URL(anchor.href).protocol)){event.preventDefault();event.stopImmediatePropagation()}},true);
    });
    if(config.storageState&&existsSync(config.storageState)){
      const state=readSession(config.storageState);const allowed=new Set(config.credentialOrigins);
      const cookies=state.cookies.filter(c=>config.credentialOrigins.some(v=>{const u=new URL(v);const d=c.domain.replace(/^\./,'');return (u.hostname===d||u.hostname.endsWith(`.${d}`))&&(!c.secure||u.protocol==='https:')}));
      const origins=state.origins.filter(v=>allowed.has(v.origin));
      await context.setStorageState({cookies,origins});
      store.emit('session_loaded',{cookies:cookies.length,origins:origins.length});
    }
    context.on('page',page=>{
      if(!startupPages.has(page)){for(const blank of startupPages)blank.close().catch(()=>{});}
      // First navigation is already blocked by auto-attach. Bound open targets as well.
      const existing=context.pages().filter(p=>!p.isClosed()&&!startupPages.has(p));
      if(existing.length>config.maxTabs){store.emit('coverage_gap',{reason:'max_tabs_popup_closed',url:page.url()});page.close().catch(()=>{});}
    });
    context.on('close',()=>{if(!intentional)budget.stop('browser_closed','failed')});
    // Goto/click have the global deadline as their timeout. Keep targets attached
    // so queued requests can be denied before close rather than released by detach.
    budget.setCancel(()=>{guard.quiesce().then(()=>Promise.all(context.pages().map(p=>p.close().catch(()=>{})))).catch(()=>{});});
    return {context,close,guard};
  } catch(e) {await close();throw e;}
}
