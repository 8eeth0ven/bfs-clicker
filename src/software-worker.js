import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {watchWorkerParent} from './worker-parent.js';
import {atomicJson,readAtomic,acquireLock} from './store.js';
import {redact,redactText} from './redact.js';
import {persistedWriteOutcome, mergeWriteOutcomes} from './write-outcome.js';

const cleanup=watchWorkerParent(),abort=new AbortController();
const stop=()=>abort.abort(new Error('cancelled')),disconnected=()=>abort.abort(new Error('parent_disconnected'));
process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('disconnect',disconnected);
if(process.env.BFS_MCP_WORKER==='1'&&typeof process.send==='function'&&!process.connected)disconnected();
let task,statusFile,release=()=>{},initial={};
function publish(patch){initial={...initial,operationId:task.id,type:task.type,pid:process.pid,...(task.owner?{owner:task.owner}:{}),...patch};atomicJson(statusFile,initial)}
try{
 task=readAtomic(path.resolve(process.argv[2]));
 if(!task||typeof task.id!=='string'||typeof task.outputDir!=='string'||typeof task.runtimeFile!=='string')throw new Error('操作任务格式无效');
 statusFile=path.join(task.outputDir,'status.json');
 try{initial=readAtomic(statusFile)}catch{}
 if(!initial.createdAt)initial.createdAt=new Date().toISOString();
 if(abort.signal.aborted)throw abort.signal.reason;
 // The shared config constructor writes runtime.json; acquire before that mutation.
 const options=readAtomic(task.runtimeFile);
 if(typeof options.outputRoot!=='string')throw new Error('软件运行配置缺少outputRoot');
 release=acquireLock(path.join(path.resolve(options.outputRoot),'.operation.lock'),{task:task.id,...(task.owner?{owner:task.owner}:{})});
 if(abort.signal.aborted)throw abort.signal.reason;
 const {createSoftwareRuntime}=await import('./software-runtime.js');
 if(abort.signal.aborted)throw abort.signal.reason;
 const runtime=createSoftwareRuntime(options);
 publish({status:'running',startedAt:new Date().toISOString()});
 let result;
 if(task.type==='discover'){
  if(task.args.kind==='web'&&!task.args.sourceId){task.args.sourceId='web_'+randomUUID();atomicJson(path.join(task.outputDir,'task.json'),task)}
  result=await runtime.discover(task.args,task.outputDir,abort.signal);
 }else if(task.type==='compile')result=await runtime.compile(task.args);
 else if(task.type==='execute'||task.type==='validate')result=await runtime.execute({...task.args,outputDir:path.join(task.outputDir,'execution')},abort.signal);
 else if(task.type==='import-openapi')result=await runtime.importSpecification(task.args);
 else if(task.type==='bind-workflow')result=await runtime.bindWorkflow(task.args,task.outputDir,abort.signal);
 else if(task.type==='observe-mobile')result=await runtime.observeMobile(task.args,task.outputDir,abort.signal);
 else if(task.type==='refresh')result=await runtime.refresh(task.args);
 else if(task.type==='generate')result=runtime.generate(task.args);
 else throw new Error('未知操作');
 publish({status:abort.signal.aborted?'cancelled':'completed',result:redact(result),finishedAt:new Date().toISOString()});
}catch(error){
 const explicit=typeof error.code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)?error.code:null;
 const errorCode=abort.signal.aborted?'CANCELLED':explicit||String(error.message).match(/^([A-Z][A-Z0-9_]{1,63})(?=[:：\s]|$)/)?.[1]||'OPERATION_FAILED';
 const writeOutcome=mergeWriteOutcomes(task?.outputDir?persistedWriteOutcome(task.outputDir):undefined,error.writeOutcome);
 if(statusFile)try{publish({status:abort.signal.aborted?'cancelled':'failed',errorCode,error:redactText(error.message).slice(0,2000),...(writeOutcome?{writeOutcome}:{}),finishedAt:new Date().toISOString()})}catch{}
 process.exitCode=abort.signal.aborted?0:1;
}finally{release();cleanup();process.off('SIGTERM',stop);process.off('SIGINT',stop);process.off('disconnect',disconnected)}
