import {closeSync,constants,fstatSync,lstatSync,mkdirSync,openSync,unlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';

export const NATIVE_MAX_DURATION_MS=3600000;
export const NATIVE_STARTUP_GRACE_MS=10000;
export const NATIVE_CLEANUP_GRACE_MS=12000;
export const NATIVE_CLIENT_GRACE_MS=10000;
export const MAX_PYTHON_TIMEOUT_MS=NATIVE_MAX_DURATION_MS+NATIVE_STARTUP_GRACE_MS;
export const MAX_NATIVE_CLIENT_TIMEOUT_MS=MAX_PYTHON_TIMEOUT_MS+NATIVE_CLEANUP_GRACE_MS+NATIVE_CLIENT_GRACE_MS;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;

// This object must come from the checked local device configuration, never MCP
// arguments. D is Python's unchanged UI budget; the extra windows are startup,
// termination/reaping and client transport only, not more UI time.
export function nativeWorkflowBudget(device){
 if(!device||typeof device!=='object'||Array.isArray(device))fail('NATIVE_BUDGET_INVALID');
 const limits=device.limits===undefined?{}:device.limits;
 if(!limits||typeof limits!=='object'||Array.isArray(limits))fail('NATIVE_BUDGET_INVALID');
 const duration=limits.maxDurationMs===undefined?60000:limits.maxDurationMs;
 if(!integer(duration,1,NATIVE_MAX_DURATION_MS))fail('NATIVE_BUDGET_INVALID');
 return Object.freeze({durationMs:duration,startupGraceMs:NATIVE_STARTUP_GRACE_MS,
  timeoutMs:duration+NATIVE_STARTUP_GRACE_MS,cleanupGraceMs:NATIVE_CLEANUP_GRACE_MS,
  clientGraceMs:NATIVE_CLIENT_GRACE_MS,clientTimeoutMs:duration+NATIVE_STARTUP_GRACE_MS+NATIVE_CLEANUP_GRACE_MS+NATIVE_CLIENT_GRACE_MS});
}

export function nativeMcpRequestOptions(budget,remainingMs=budget?.clientTimeoutMs){
 if(!integer(budget?.clientTimeoutMs,1,MAX_NATIVE_CLIENT_TIMEOUT_MS)||!Number.isFinite(remainingMs)||remainingMs<=0)fail('NATIVE_CLIENT_DEADLINE');
 const timeout=Math.max(1,Math.floor(Math.min(remainingMs,budget.clientTimeoutMs)));
 return {timeout,maxTotalTimeout:timeout,resetTimeoutOnProgress:false};
}

export async function waitNativeOperation(read,budget,{signal,now=()=>performance.now(),sleep=ms=>delay(ms,undefined,{signal}),onPending=()=>{}}={}){
 nativeMcpRequestOptions(budget);
 const deadline=now()+budget.clientTimeoutMs;
 for(;;){
  signal?.throwIfAborted();
  const remaining=deadline-now();
  if(remaining<=0)fail('NATIVE_CLIENT_DEADLINE');
  const value=await read({...nativeMcpRequestOptions(budget,remaining),...(signal?{signal}:{})});
  signal?.throwIfAborted();
  if(now()>=deadline)fail('NATIVE_CLIENT_DEADLINE');
  if(['completed','failed','cancelled','interrupted'].includes(value?.status))return value;
  onPending(value);
  const next=deadline-now();if(next<=0)fail('NATIVE_CLIENT_DEADLINE');
  await sleep(Math.min(500,next));
 }
}

// Preserve config values and the runner's original cwd. Current native modules
// read JSON directly; none resolve relative values against args.config.parent.
// The private per-run path never becomes a learned identity or source binding.
export function createNativeDeviceSnapshot(device,directory){
 let serialized,effective;
 try{serialized=JSON.stringify(device);if(Buffer.byteLength(serialized)>1048576)fail('NATIVE_CONFIG_LIMIT');effective=JSON.parse(serialized);}catch(error){if(error.code==='NATIVE_CONFIG_LIMIT')throw error;fail('NATIVE_CONFIG_INVALID');}
 const budget=nativeWorkflowBudget(effective);
 mkdirSync(directory,{recursive:true,mode:0o700});
 const base=lstatSync(directory);if(!base.isDirectory()||base.isSymbolicLink())fail('NATIVE_CONFIG_DIRECTORY_INVALID');
 const file=path.join(directory,'native-run-'+randomUUID()+'.json');
 let fd,owned,disposed=false;
 try{fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);owned=fstatSync(fd);writeFileSync(fd,serialized+'\n');}
 catch(error){if(fd!==undefined){closeSync(fd);fd=undefined;try{const current=lstatSync(file);if(owned&&current.isFile()&&!current.isSymbolicLink()&&current.dev===owned.dev&&current.ino===owned.ino)unlinkSync(file);}catch{}}throw error;}
 finally{if(fd!==undefined)closeSync(fd);}
 return {path:file,device:effective,budget,dispose(){
  if(disposed)return;disposed=true;
  let current;try{current=lstatSync(file)}catch(error){if(error.code==='ENOENT')return;throw error}
  if(!current.isFile()||current.isSymbolicLink()||current.dev!==owned.dev||current.ino!==owned.ino)fail('NATIVE_CONFIG_SNAPSHOT_CHANGED');
  unlinkSync(file);
 }};
}
