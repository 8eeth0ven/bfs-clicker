import {spawn} from 'node:child_process';
import path from 'node:path';
import {PROJECT_ROOT} from './config.js';
import {redactText} from './redact.js';
import {MAX_PYTHON_TIMEOUT_MS,NATIVE_CLEANUP_GRACE_MS} from './native-workflow-budget.js';

export const PYTHON_STDIO_DRAIN_MS=1000;
const failure=(code,message)=>Object.assign(new Error(message||code),{code});

// Dependency injection permits deterministic lifecycle tests; runtime callers
// only use runPython below, with no scheduler/process options from MCP inputs.
export function createPythonRunner({spawnProcess=spawn,schedule=setTimeout,unschedule=clearTimeout,killGroup=(pid,signal)=>process.kill(-pid,signal),platform=process.platform}={}){
 return function runPython(config,args,{signal,stdin={},timeoutMs=300000,cleanupGraceMs=NATIVE_CLEANUP_GRACE_MS}={}){
  return new Promise((resolve,reject)=>{
   if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>MAX_PYTHON_TIMEOUT_MS||!Number.isSafeInteger(cleanupGraceMs)||cleanupGraceMs<1||cleanupGraceMs>NATIVE_CLEANUP_GRACE_MS)return reject(failure('PYTHON_TIMEOUT_INVALID'));
   if(signal?.aborted)return reject(signal.reason||failure('PYTHON_CANCELLED'));
   let input;try{input=JSON.stringify(stdin)}catch{return reject(failure('PYTHON_INPUT_INVALID'))}
   const python=config.python||path.join(PROJECT_ROOT,'.venv/bin/python');
   let child;try{child=spawnProcess(python,args,{cwd:PROJECT_ROOT,env:{...process.env,PYTHONPATH:path.join(PROJECT_ROOT,'apk_tools'),PYTHONUNBUFFERED:'1'},stdio:['pipe','pipe','pipe'],windowsHide:true,detached:platform!=='win32'});}catch(error){return reject(error)}
   let stdout='',stderr='',reason=null,launchError=null,exited=false,exitCode=null,settled=false,timer,killTimer,drainTimer;
   const clear=()=>{for(const t of [timer,killTimer,drainTimer])if(t!==undefined)unschedule(t);signal?.removeEventListener('abort',abort);};
   const groupOnly=kind=>{if(platform!=='win32'&&Number.isInteger(child.pid))try{killGroup(child.pid,kind);return true}catch{}return false;};
   const terminate=kind=>{if(!groupOnly(kind)&&!exited)try{child.kill(kind)}catch{}};
   const finish=()=>{
    if(settled)return;settled=true;clear();
    child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();
    if(reason)return reject(reason);
    if(launchError||exitCode!==0)return reject(failure('PYTHON_FAILED',redactText(launchError?.message||stderr||stdout||'Python操作失败').slice(-2000)));
    resolve({stdout,stderr:redactText(stderr)});
   };
   const stop=error=>{if(settled||reason)return;reason=error;terminate('SIGTERM');killTimer=schedule(()=>{terminate('SIGKILL');},cleanupGraceMs);killTimer?.unref?.();};
   const abort=()=>stop(failure('PYTHON_CANCELLED','Python操作已取消'));
   const capture=(target,chunk)=>{if(target==='stdout')stdout=(stdout+chunk).slice(-262144);else stderr=(stderr+chunk).slice(-32768);};
   child.stdout?.on('data',chunk=>capture('stdout',chunk));child.stderr?.on('data',chunk=>capture('stderr',chunk));
   child.stdout?.on('error',()=>stop(failure('PYTHON_OUTPUT_FAILED')));child.stderr?.on('error',()=>stop(failure('PYTHON_OUTPUT_FAILED')));
   child.stdin?.on('error',()=>{});
   child.once('error',error=>{launchError=error;if(!Number.isInteger(child.pid)){exited=true;finish();}else stop(failure('PYTHON_FAILED',redactText(error.message)));});
   child.once('exit',(code)=>{
    exited=true;exitCode=code;if(timer!==undefined)unschedule(timer);
    // The owned direct process is reaped. Reap is distinct from pipe EOF:
    // another session can inherit a pipe, so bound the final drain as well.
    if(groupOnly('SIGKILL')&&!reason)reason=failure('PYTHON_DESCENDANTS_REMAINED');
    drainTimer=schedule(()=>{if(!reason)reason=failure('PYTHON_STDIO_CLOSE_TIMEOUT');finish();},PYTHON_STDIO_DRAIN_MS);drainTimer?.unref?.();
   });
   child.once('close',code=>{if(!exited){exited=true;exitCode=code;}finish();});
   signal?.addEventListener('abort',abort,{once:true});
   timer=schedule(()=>stop(failure('PYTHON_TIMEOUT','Python操作超时')),timeoutMs);timer?.unref?.();
   if(signal?.aborted)abort();
   try{child.stdin?.end(input)}catch(error){stop(failure('PYTHON_INPUT_FAILED',redactText(error.message)));}
  });
 };
}

export const runPython=createPythonRunner();
