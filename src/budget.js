import { existsSync } from 'node:fs';
import path from 'node:path';
import { limitReached } from './asset.js';

export class StopError extends Error {
  constructor(reason,status='partial') { super(reason);this.name='StopError';this.reason=reason;this.status=status; }
}
export function createBudget(config,store) {
  const previous=store.checkpoint?.counters||{};
  const counts={requests:0,actions:0,totalRequests:Number(previous.totalRequests||0),totalActions:Number(previous.totalActions||0)};
  const abort=new AbortController();
  const deadline=config.maxDurationMs==null?Infinity:Date.now()+config.maxDurationMs;
  let reason=null,status='partial',cancelResource=()=>{},timer;
  const stop=(r,s='partial')=>{
    if(reason)return;
    reason=r;status=s;abort.abort(new StopError(r,s));
    store.emit('stop_requested',{reason,status});cancelResource();
  };
  const check=()=>{
    if(!reason&&existsSync(path.join(config.outputDir,'STOP')))stop('STOP');
    if(!reason&&Date.now()>=deadline)stop('max_duration');
    if(reason)throw new StopError(reason,status);
  };
  const armDeadline=()=>{
    if(!Number.isFinite(deadline))return;
    timer=setTimeout(()=>{if(Date.now()>=deadline)stop('max_duration');else armDeadline()},Math.max(1,Math.min(2147483647,deadline-Date.now())));
    timer.unref();
  };
  armDeadline();
  const sentinel=setInterval(()=>{if(existsSync(path.join(config.outputDir,'STOP')))stop('STOP')},100);sentinel.unref();
  const onInt=()=>stop('SIGINT'),onTerm=()=>stop('SIGTERM');
  process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);
  const hostNext=new Map(),retryUntil=new Map();
  const pause=ms=>new Promise((resolve,reject)=>{
    check();
    const t=setTimeout(done,Math.max(0,Math.min(ms,deadline-Date.now(),2147483647)));
    function done(){abort.signal.removeEventListener('abort',cancel);reason?reject(new StopError(reason,status)):resolve();}
    function cancel(){clearTimeout(t);done();}
    abort.signal.addEventListener('abort',cancel,{once:true});
  });
  return {
    counts,signal:abort.signal,get reason(){return reason},get status(){return status},
    get remainingMs(){return Math.max(0,deadline-Date.now())},stop,check,pause,
    setCancel(fn){cancelResource=fn;if(reason)fn();},
    async request(url){
      check();
      if(limitReached(config,'maxRequests',counts.requests)){stop('max_requests');throw new StopError(reason);}
      counts.requests++;counts.totalRequests++;
      const host=new URL(url).host,now=Date.now(),slot=Math.max(now,hostNext.get(host)||now);
      hostNext.set(host,slot+config.requestDelayMs);
      // Retry-After can change while a queued request is waiting for its slot.
      for(;;){
        const waitUntil=Math.max(slot,retryUntil.get(host)||0),delay=waitUntil-Date.now();
        if(delay<=0)break;
        await pause(delay);check();
      }
      check();
    },
    action(){
      check();
      if(limitReached(config,'maxActions',counts.actions)){stop('max_actions');throw new StopError(reason);}
      counts.actions++;counts.totalActions++;
    },
    retryAfter(url,header){
      const ms=/^\d+$/.test(String(header||''))?Number(header)*1000:Math.max(0,Date.parse(header)-Date.now());
      if(Number.isFinite(ms)){
        const delayMs=Math.min(config.retryMaxDelayMs,ms),host=new URL(url).host;
        retryUntil.set(host,Math.max(retryUntil.get(host)||0,Date.now()+delayMs));
        store.emit('rate_limit',{url,delayMs});
      }
    },
    dispose(){clearTimeout(timer);clearInterval(sentinel);process.off('SIGINT',onInt);process.off('SIGTERM',onTerm);},
  };
}
