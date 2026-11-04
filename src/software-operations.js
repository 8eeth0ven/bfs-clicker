import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,realpathSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {PROJECT_ROOT} from './config.js';
import {atomicJson,readAtomic,secureDirectory} from './store.js';
import {redact,redactText} from './redact.js';
import {persistedWriteOutcome, mergeWriteOutcomes} from './write-outcome.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TERMINAL=new Set(['completed','failed','cancelled','interrupted']);
const TYPES=new Set(['discover','compile','execute','validate','refresh','generate','import-openapi','bind-workflow','observe-mobile']);
const alive=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true}catch(e){return e.code!=='ESRCH'}};
const inside=(root,file)=>{const p=path.relative(root,file);return p===''||p!=='..'&&!p.startsWith('..'+path.sep)&&!path.isAbsolute(p)};

export function createSoftwareOperations(runtime,{spawnWorker=spawn,shutdownGraceMs=20000,killWaitMs=2000}={}){
 const dir=path.join(runtime.root,'operations');secureDirectory(dir);let active=null,closing=false,shutdownPromise;
 const opDir=id=>{if(!UUID.test(id))throw new Error('operationId无效');return path.join(dir,id)};
 const checkedDir=input=>{const target=realpathSync(input),base=realpathSync(dir);if(!inside(base,target)||!UUID.test(path.basename(target))||path.dirname(target)!==base)throw new Error('续跑目录不属于已登记操作');return target};
 const taskFor=id=>{const out=checkedDir(opDir(id)),task=readAtomic(path.join(out,'task.json'));if(task.id!==id||realpathSync(task.outputDir)!==out)throw new Error('操作身份不一致');return task};
 function lockInfo(){
  const file=path.join(runtime.root,'.operation.lock');if(!existsSync(file))return null;
  if(!lstatSync(file).isFile())throw new Error('运行锁不是普通文件');
  const lock=JSON.parse(readFileSync(file,'utf8'));if(!Number.isInteger(lock.pid)||lock.pid<=0||typeof lock.nonce!=='string')throw new Error('运行锁格式无效');return lock;
 }
 function resumable(task){
  if(task.type!=='discover')return false;
  if(task.args.kind==='web'){
   const id=task.args.runId||task.args.sourceId;if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id))return false;
   const run=path.join(runtime.root,'runs',id,'private/checkpoint.json');return existsSync(run)||existsSync(run+'.previous');
  }
  if(!['apk','ios'].includes(task.args.kind))return false;
  if(!task.args.deviceName)return true; // Static extraction restarts; it has no UI checkpoint.
  try{const prior=checkedDir(task.args.resumeOperationDir||task.outputDir);return existsSync(path.join(prior,'mobile-ui/checkpoint.json'))}catch{return false}
 }
 function status(id){
  const out=checkedDir(opDir(id)),value=readAtomic(path.join(out,'status.json')),task=taskFor(id);
  let launch=null;try{launch=readAtomic(path.join(out,'launch.json'))}catch{}
  const pid=value.pid||(launch?.operationId===id&&launch.owner===task.owner?launch.pid:null);
  let lock=null;try{lock=lockInfo()}catch{}
  const lockOwned=lock?.task===id&&(!task.owner||lock.owner===task.owner)&&alive(lock.pid);
  const owned=active?.id===id;
  const running=owned||lockOwned||(!TERMINAL.has(value.status)&&alive(pid));
  const {owner:privateOwner,...publicValue}=value;
  const writeOutcome=mergeWriteOutcomes(['execute','validate','bind-workflow'].includes(task.type)?persistedWriteOutcome(out):undefined,value.writeOutcome,value.result?.result?.writeOutcome,value.result?.writeOutcome);
  const base={...redact(publicValue),...(writeOutcome?{writeOutcome}:{}),...(Number.isInteger(pid)?{pid}:{}),operationId:id,type:task.type,active:running,owned,canStop:owned,canResume:!running&&resumable(task)};
  if(TERMINAL.has(value.status))return running?{...base,status:'finishing',outcome:value.status}:base;
  if(!running)return {...base,status:'interrupted',reason:'worker_not_alive'};
  return base;
 }
 function start(type,args,{resumedFrom=null}={}){
  if(closing)throw new Error('服务正在关闭');if(active)throw new Error('BUSY：已有软件操作运行，请等待或停止');
  if(!TYPES.has(type)||!args||typeof args!=='object'||Array.isArray(args))throw new Error('操作类型或参数无效');
  const lock=lockInfo();if(lock&&alive(lock.pid))throw new Error('BUSY：其他实例持有软件运行锁');
  const id=randomUUID(),owner=randomUUID(),out=opDir(id);secureDirectory(out);
  const parameters=structuredClone(args);if(type==='discover'&&parameters.kind==='web'&&!parameters.sourceId)parameters.sourceId='web_'+randomUUID();
  const taskFile=path.join(out,'task.json'),createdAt=new Date().toISOString();
  const task={id,type,args:parameters,owner,managerPid:process.pid,runtimeFile:runtime.runtimeFile,outputDir:out,...(resumedFrom?{resumedFrom}:{})};
  atomicJson(taskFile,task);
  const initial={operationId:id,type,status:'starting',createdAt,owner,managerPid:process.pid,...(resumedFrom?{resumedFrom}:{})};
  atomicJson(path.join(out,'status.json'),initial);
  let child;
  try{child=spawnWorker(process.execPath,[path.join(PROJECT_ROOT,'src/software-worker.js'),taskFile],{cwd:PROJECT_ROOT,env:{...process.env,BFS_MCP_WORKER:'1'},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});}
  catch(error){atomicJson(path.join(out,'status.json'),{...initial,status:'failed',error:redactText(error.message).slice(0,2000),finishedAt:new Date().toISOString()});throw error}
  const worker={id,owner,child,done:null,stopRequested:false,settled:false,logs:[]};active=worker;
  // Publish the spawned PID before yielding; a killed manager cannot leave eternal starting.
  const safe=fn=>(...values)=>{try{fn(...values)}catch(error){worker.logs.push(redactText(error.message).slice(0,1000));worker.logs.splice(0,Math.max(0,worker.logs.length-20))}};
  const capture=stream=>{if(!stream)return;let pending='';stream.on('data',safe(chunk=>{pending=(pending+chunk.toString()).slice(-32768);const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines)if(line){worker.logs.push(redactText(line).slice(0,1000));if(worker.logs.length>20)worker.logs.shift()}}));stream.on('error',safe(error=>worker.logs.push(redactText(error.message).slice(0,1000))))};
  capture(child.stdout);capture(child.stderr);
  worker.done=new Promise(resolve=>{
   const finish=safe((error,code,signal)=>{
    if(worker.settled)return;worker.settled=true;if(active===worker)active=null;
    try{const saved=readAtomic(path.join(out,'status.json'));if(!TERMINAL.has(saved.status))atomicJson(path.join(out,'status.json'),{...saved,status:worker.stopRequested?'cancelled':error||code!==0?'failed':'interrupted',error:redactText(error?.message||'worker退出 '+(signal||code)).slice(0,2000),finishedAt:new Date().toISOString(),logs:worker.logs.slice(-20)})}catch{}
    try{child.stdout?.destroy();child.stderr?.destroy()}finally{resolve()}
   });
   child.once('error',safe(error=>{if(!Number.isInteger(child.pid))finish(error,null,null);else{worker.logs.push('worker_control_error: '+redactText(error.message).slice(0,1000));if(worker.logs.length>20)worker.logs.shift()}}));
   // exit means the owned process is reaped; close may wait forever on inherited pipes.
   child.once('exit',(code,signal)=>finish(null,code,signal));
   child.once('close',(code,signal)=>finish(null,code,signal));
  });
  try{if(Number.isInteger(child.pid))atomicJson(path.join(out,'launch.json'),{operationId:id,owner,pid:child.pid,spawnedAt:new Date().toISOString()})}catch(error){worker.stopRequested=true;child.kill('SIGTERM');throw error}
  return {operationId:id,type,status:'starting'};
 }
 function stop({operationId}){
  if(active?.id!==operationId)throw new Error('只能停止本实例启动且仍在运行的操作');
  active.stopRequested=true;active.child.kill('SIGTERM');return {operationId,status:'stopping'};
 }
 function resume({operationId}){
  if(active)throw new Error('BUSY');const prior=taskFor(operationId),priorStatus=status(operationId);
  if(prior.type!=='discover')throw new Error('只有探索任务可续跑');if(priorStatus.active)throw new Error('BUSY：原操作仍在运行');
  if(!resumable(prior))throw new Error('NO_CHECKPOINT：原探索没有可恢复的断点，请新建任务');
  const args={...prior.args,resume:true};
  if(args.kind==='web')args.runId=args.runId||args.sourceId;
  else args.resumeOperationDir=checkedDir(args.resumeOperationDir||prior.outputDir);
  return start('discover',args,{resumedFrom:operationId});
 }
 async function waitOwned(worker,ms){let timer;try{return await Promise.race([worker.done.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),ms)})])}finally{clearTimeout(timer)}}
 return {
  start,status:({operationId})=>status(operationId),stop,resume,
  list({limit=20}={}){if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('limit无效');return readdirSync(dir,{withFileTypes:true}).filter(d=>d.isDirectory()&&UUID.test(d.name)).flatMap(d=>{try{return [status(d.name)]}catch{return []}}).sort((a,b)=>String(b.createdAt||b.finishedAt).localeCompare(String(a.createdAt||a.finishedAt))).slice(0,limit)},
  hasActive(){if(active)return true;try{const lock=lockInfo();return !!lock&&alive(lock.pid)}catch{return true}},
  shutdown(){return shutdownPromise||=(async()=>{closing=true;const worker=active;if(!worker)return;stop({operationId:worker.id});if(await waitOwned(worker,shutdownGraceMs))return;worker.child.kill('SIGKILL');if(!await waitOwned(worker,killWaitMs))throw new Error('SHUTDOWN_INCOMPLETE：本实例worker尚未退出')})()}
 };
}
