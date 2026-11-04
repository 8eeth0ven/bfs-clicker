import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { DEFAULTS, EXPLORATION_LIMITS, canonicalAsset, normalizeConfig } from './asset.js';
import { PROJECT_ROOT } from './config.js';
import { atomicJson, identity, readAtomic, secureDirectory } from './store.js';
import { redact, redactText } from './redact.js';

const SETTINGS=['order','resourcePolicy','headless','requestDelayMs','shotFormat','navigationOrigins','requestOrigins',
  'credentialOrigins','seedRoutes','excludeSelectors','actionAllowlist','requestAllowlist','captureInitiators','captureBinaryBodies'];
const ID=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,179}$/;
const TERMINAL=new Set(['completed','partial','failed','blocked','needs_auth']);
const clone=value=>JSON.parse(JSON.stringify(value));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const error=(code,message)=>Object.assign(new Error(message),{code});
const byteLimit=(value,limit)=>{
  const bytes=Buffer.from(value);if(bytes.length<=limit)return value;
  let end=limit;while(end>0&&(bytes[end]&0xc0)===0x80)end--;return bytes.subarray(0,end).toString('utf8');
};
const compactData=(value,depth=0)=>{
  if(value==null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
  if(typeof value==='string')return redactText(value).slice(0,300);
  if(!object(value)||depth>=2)return null;
  return Object.fromEntries(Object.entries(value).slice(0,40).map(([key,item])=>[key.slice(0,80),compactData(item,depth+1)]));
};
function keys(value,allowed) {
  if(!object(value))throw error('INVALID_ARGUMENT','参数必须是对象');
  for(const key of Object.keys(value))if(!allowed.includes(key))throw error('INVALID_ARGUMENT','未知参数: '+key);
}
const inside=(root,candidate)=>{const relative=path.relative(root,candidate);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
function limitValues(input,previous=null) {
  const supplied=Object.hasOwn(input,'limits');
  if(supplied)keys(input.limits,EXPLORATION_LIMITS);
  const overrides=input.limits||{},hasValues=Object.keys(overrides).length>0;
  let mode=input.limitMode??(hasValues?'custom':previous?.limitMode||'default');
  if(!['default','custom','unlimited'].includes(mode))throw error('INVALID_ARGUMENT','limitMode 可选 default/custom/unlimited');
  if(mode==='unlimited'){
    if(supplied)throw error('INVALID_ARGUMENT','unlimited 模式不能传 limits');
    return {limitMode:mode,...Object.fromEntries(EXPLORATION_LIMITS.map(key=>[key,null]))};
  }
  if(hasValues)mode='custom';
  const result={limitMode:mode};
  for(const key of EXPLORATION_LIMITS){
    const inherited=mode==='custom'&&previous?.[key]!=null?previous[key]:DEFAULTS[key];
    const value=Object.hasOwn(overrides,key)?overrides[key]:inherited;
    if(!Number.isSafeInteger(value)||value<(key==='maxDepth'?0:1))throw error('INVALID_ARGUMENT',key+' 必须是有效整数上限');
    result[key]=value;
  }
  return result;
}
function budgetArgs(config) {
  if(config.limitMode==='unlimited')return ['--limit-mode','unlimited'];
  if(config.limitMode==='default')return ['--limit-mode','default'];
  const args=['--limit-mode','custom'];
  for(const [key,flag] of [['maxStates','--max-states'],['maxDepth','--max-depth'],['maxRequests','--max-requests'],
    ['maxActions','--max-actions'],['maxStatesPerHost','--max-states-per-host']])args.push(flag,String(config[key]));
  args.push('--max-duration',String(config.maxDurationMs/1000));return args;
}

/** Subprocess manager shared by MCP connections. Worker stdout is never inherited. */
export function createJobManager({outputRoot=path.join(PROJECT_ROOT,'output-runs'),baseConfig={}}={}) {
  if(!object(baseConfig))throw error('INVALID_ARGUMENT','baseConfig 必须是对象');
  const trusted=clone(baseConfig);mkdirSync(outputRoot,{recursive:true,mode:0o700});
  const root=realpathSync(path.resolve(outputRoot)),jobs=new Map();let active=null,closing=false,shutdownPromise=null;
  const knownSecrets=[];
  const collectSecrets=(value,key='')=>{
    if(typeof value==='string'&&/(?:password|passwd|secret|token|cookie|authorization|api[-_]?key)/i.test(key)&&value.length>=3)knownSecrets.push(value);
    else if(value&&typeof value==='object')for(const [name,item] of Object.entries(value))collectSecrets(item,name);
  };collectSecrets(trusted);
  const safeText=value=>{
    let text=String(value??'');for(const secret of knownSecrets)text=text.split(secret).join('[REDACTED]');
    try{return JSON.stringify(redact(JSON.parse(text))).slice(0,1500)}catch{}
    return redactText(text).replace(/\b((?:set-)?cookie|authorization|proxy-authorization)\s*[:=]\s*[^\r\n]+/gi,'$1: [REDACTED]').slice(0,1500);
  };
  const addLog=(job,text)=>{job.logs.push(safeText(text));if(job.logs.length>80)job.logs.splice(0,job.logs.length-80);};
  const assertDir=job=>{
    const actual=realpathSync(job.dir);
    if(actual!==job.dir||!inside(root,actual)||!statSync(actual).isDirectory())throw error('PATH_REJECTED','任务目录已移动或越出 outputRoot');
    return actual;
  };
  const checkFile=(job,file)=>{
    assertDir(job);
    if(existsSync(file)){
      const actual=realpathSync(file);
      if(!inside(job.dir,actual)||!inside(root,actual)||!statSync(actual).isFile())throw error('PATH_REJECTED','任务文件越界或不是普通文件');
    }
    return file;
  };
  const read=(job,file)=>{checkFile(job,file);checkFile(job,file+'.previous');return readAtomic(file);};
  const present=file=>existsSync(file)||existsSync(file+'.previous');
  const readMeta=job=>{
    for(const relative of ['private/run.json','run.json','private/mcp-job.json']){
      const file=path.join(job.dir,relative);if(present(file))return {meta:read(job,file),registryOnly:relative==='private/mcp-job.json'};
    }
    throw error('INVALID_RUN','任务缺少运行记录');
  };
  const validate=(job,meta)=>{
    if(!ID.test(String(meta.runId||''))||job.runId&&job.runId!==meta.runId||!object(meta.identity)||meta.identity.schemaVersion!==2)throw error('INVALID_RUN','无法识别运行身份');
    canonicalAsset(meta.identity.canonicalTarget);
    for(const key of ['scopeFingerprint','authProfileId','policyFingerprint'])if(!/^[a-f0-9]{64}$/.test(meta.identity[key]||''))throw error('INVALID_RUN','运行身份摘要无效');
    const file=path.join(job.dir,'private','config.json');
    if(present(file)){
      const cfg=read(job,file);
      if(cfg.runId&&cfg.runId!==meta.runId||Object.entries(identity(cfg)).some(([key,value])=>meta.identity[key]!==value))throw error('INVALID_RUN','config identity 与任务不一致');
    }
  };
  const scan=()=>{
    for(const item of readdirSync(root,{withFileTypes:true})){
      if(!item.isDirectory()||item.isSymbolicLink())continue;
      try{
        const dir=realpathSync(path.join(root,item.name));if(!inside(root,dir))continue;
        const probe={dir,logs:[]},record=readMeta(probe);validate(probe,record.meta);
        const id=record.meta.runId,previous=jobs.get(id);
        if(previous&&previous.dir!==dir)continue;
        if(!previous)jobs.set(id,{...probe,runId:id,createdAt:record.meta.createdAt||record.meta.startedAt||'',cachedMeta:record.meta});
      }catch{/* Unregistered, malformed and escaped directories are not addressable. */}
    }
  };
  const getJob=runId=>{
    if(typeof runId!=='string'||!ID.test(runId))throw error('INVALID_ARGUMENT','runId 无效');
    if(!jobs.has(runId))scan();const job=jobs.get(runId);
    if(!job)throw error('NOT_FOUND','任务不存在');assertDir(job);return job;
  };
  const lockInfo=job=>{
    const file=path.join(job.dir,'.run.lock');
    if(!existsSync(file))return {alive:false,invalid:false};
    try{
      checkFile(job,file);const lock=JSON.parse(readFileSync(file,'utf8'));
      if(!Number.isSafeInteger(lock.pid)||lock.pid<=0)return {alive:false,invalid:true};
      let alive=true;try{process.kill(lock.pid,0)}catch(e){if(e.code==='ESRCH')alive=false;}
      return {...lock,alive,invalid:false};
    }catch{return {alive:false,invalid:true};}
  };
  const owns=(worker,lock=lockInfo(worker.job))=>!!lock.alive&&lock.owner===worker.owner&&lock.pid===worker.child.pid;
  const artifact=(job,name)=>{
    try{const file=path.join(job.dir,name);checkFile(job,file);return existsSync(file)&&statSync(file).isFile()?file:null;}catch{return null;}
  };
  const publicJob=job=>{
    assertDir(job);let meta={},registryOnly=false,metadataError=null;
    try{const record=readMeta(job);validate(job,record.meta);meta=record.meta;registryOnly=record.registryOnly;}
    catch(e){metadataError=safeText(e.message);}
    const worker=active?.job===job?active:null,lock=lockInfo(job),owned=worker?owns(worker,lock):false;
    const foreign=lock.alive&&!owned,working=!!worker||lock.alive,progress=working?meta.progress||{}:{};
    let status,stopReason=meta.stopReason||job.failure?.reason||null;
    if(foreign)status=meta.status==='running'?'running':meta.status==='starting'?'starting':'running';
    else if(worker)status=job.stopRequested?'stopping':owned?(meta.status==='starting'?'running':meta.status||'running'):'starting';
    else if(metadataError){status='failed';stopReason='metadata_unreadable';}
    else if(meta.status==='running'){status=job.failure?'failed':'partial';stopReason=job.failure?.reason||'worker_interrupted';}
    else if(registryOnly){status='failed';stopReason=job.failure?.reason||meta.stopReason||'worker_start_interrupted';}
    else status=meta.status||job.failure?.status||'failed';
    const counts={...(meta.counts||{})};
    for(const key of ['states','requests','actions','totalRequests','totalActions','elapsedMs'])if(progress[key]!=null)counts[key]=progress[key];
    const graphJsonPath=meta.graph?.available===false?null:artifact(job,'graph.json');
    return redact({runId:job.runId,asset:String(meta.asset||job.asset||job.cachedMeta?.asset||'').slice(0,4096),status:String(status).slice(0,80),stopReason:stopReason==null?null:safeText(stopReason).slice(0,500),active:working,owned,
      external:foreign,canStop:!!worker,canResume:!active&&!lock.alive&&!lock.invalid&&!registryOnly&&!metadataError&&
        (TERMINAL.has(meta.status)||meta.status==='running')&&present(path.join(job.dir,'private/config.json')),
      counts:compactData(counts),pending:compactData(meta.pending||{actions:progress.pendingActions||0}),performance:compactData(progress.performance||meta.performance||{}),
      limitMode:meta.limitMode||job.limitMode||'default',budgets:compactData(meta.budgets||job.budgets||{}),
      startedAt:meta.startedAt||job.startedAt||null,finishedAt:meta.finishedAt||null,
      reportPath:artifact(job,'report.html'),graphPath:graphJsonPath?artifact(job,'graph.html'):null,graphJsonPath,
      logs:job.logs.slice(-20).map(line=>byteLimit(line,1000)),...(job.failure?{workerError:job.failure}:{}),...(metadataError?{metadataError}:{}),...(lock.invalid?{lockError:'invalid_run_lock'}:{})});
  };
  const writeStop=worker=>{
    if(active!==worker||!owns(worker))return false;
    assertDir(worker.job);const file=path.join(worker.job.dir,'STOP');
    if(existsSync(file)&&lstatSync(file).isSymbolicLink())throw error('PATH_REJECTED','STOP 不能是符号链接');
    checkFile(worker.job,file);
    const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|(constants.O_NOFOLLOW||0),0o600);
    try{writeFileSync(fd,'stop requested by owning MCP worker\n')}finally{closeSync(fd)}return true;
  };
  const safeCallback=(worker,fn)=>(...args)=>{
    try{fn(...args)}catch(e){const message=safeText(e.message);if(worker.lastCallbackError!==message){worker.lastCallbackError=message;addLog(worker.job,'后台回调失败: '+message);}}
  };
  const stopWorker=worker=>{
    worker.job.stopRequested=true;
    if(writeStop(worker))addLog(worker.job,'已请求停止，正在保存。');
    else addLog(worker.job,'已请求停止自己的启动中 worker，待其取得运行锁后生效。');
  };
  const persistLaunchFailure=worker=>{
    if(!worker.job.failure)return;
    try{
      const record=readMeta(worker.job);if(!record.registryOnly)return;
      atomicJson(path.join(worker.job.dir,'private','mcp-job.json'),{...record.meta,status:'failed',stopReason:worker.job.failure.reason,finishedAt:new Date().toISOString()});
    }catch(e){addLog(worker.job,'无法保存启动失败: '+safeText(e.message));}
  };
  const launch=(job,cfg,resume,budgetOverride)=>{
    if(closing)throw error('CLOSED','MCP 任务管理器正在关闭');
    if(active)throw error('BUSY','已有任务运行，请先停止或等待完成');
    const owner=randomBytes(16).toString('hex');job.stopRequested=false;job.failure=null;job.asset=cfg.startUrl;job.limitMode=cfg.limitMode;
    job.startedAt=new Date().toISOString();job.budgets=Object.fromEntries(EXPLORATION_LIMITS.map(key=>[key,cfg[key]]));
    const args=resume?['resume','--run',job.dir,...(budgetOverride?budgetArgs(cfg):[])]:['run','--config',path.join(job.dir,'private','config.json')];
    const env={...process.env};for(const key of ['RESUME','BFS_PIDFILE','BFS_OWNER','BFS_CONFIG'])delete env[key];env.BFS_OWNER=owner;env.BFS_MCP_WORKER='1';
    const worker={job,owner,child:null,confirmed:false,finished:false,timer:null,done:null,resolve:null};
    worker.done=new Promise(resolve=>{worker.resolve=resolve});
    const finish=(code,signal,spawnError)=>{
      if(worker.finished)return;worker.finished=true;clearInterval(worker.timer);
      if(spawnError||signal||code!==0&&code!==42)job.failure={status:'failed',reason:spawnError?'worker_start_failed':'worker_exited',message:safeText(spawnError?.message||'执行进程退出 '+(signal||code))};
      if(active===worker)active=null;persistLaunchFailure(worker);worker.resolve();
    };
    try{worker.child=spawn(process.execPath,[path.join(PROJECT_ROOT,'src','index.js'),...args],{cwd:PROJECT_ROOT,env,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true,shell:false});}
    catch(e){finish(null,null,e);return publicJob(job);}
    active=worker;addLog(job,(resume?'续跑':'开始')+' · '+cfg.limitMode);
    const capture=stream=>{
      if(!stream?.on)return;const decoder=new StringDecoder('utf8');let pending='';
      stream.on('data',safeCallback(worker,chunk=>{
        pending=(pending+decoder.write(chunk)).slice(-65536);const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines)if(line)addLog(job,line);
      }));
      stream.on('end',safeCallback(worker,()=>{pending+=decoder.end();if(pending)addLog(job,pending);pending='';}));
      stream.on('error',safeCallback(worker,e=>addLog(job,'日志读取失败: '+safeText(e.message))));
    };capture(worker.child.stdout);capture(worker.child.stderr);
    worker.child.on('error',safeCallback(worker,e=>{
      if(!worker.child.pid){finish(null,null,e);return;}
      // A ChildProcess error can also mean kill/IPC failed after a successful
      // spawn. Do not forget a still-live worker or permit another one to start.
      job.failure={status:'failed',reason:'worker_control_error',message:safeText(e.message)};addLog(job,'worker 控制失败: '+safeText(e.message));
    }));
    worker.child.once('close',safeCallback(worker,(code,signal)=>finish(code,signal)));
    worker.timer=setInterval(safeCallback(worker,()=>{
      if(active!==worker)return;
      if(owns(worker)){
        if(!worker.confirmed){worker.confirmed=true;addLog(job,'worker 已取得运行锁。');}
        if(job.stopRequested)writeStop(worker);
      }
    }),50);worker.timer.unref();return publicJob(job);
  };
  const idle=()=>{if(closing)throw error('CLOSED','MCP 任务管理器正在关闭');if(active)throw error('BUSY','已有任务运行，请先停止或等待完成');};
  scan();
  return {
    start(input){
      keys(input,['asset','limitMode','limits',...SETTINGS]);idle();
      if(typeof input.asset!=='string'||input.asset.length>4096)throw error('INVALID_ARGUMENT','请提供完整 HTTP(S) asset（最多4096字符）');
      const runId=randomUUID(),dir=path.join(root,runId),settings=Object.fromEntries(SETTINGS.filter(key=>Object.hasOwn(input,key)).map(key=>[key,input[key]]));
      const cfg=normalizeConfig({...clone(trusted),...settings,...limitValues(input),startUrl:input.asset,runId,sessionId:runId,outputDir:dir},{baseDir:PROJECT_ROOT});
      mkdirSync(dir,{recursive:false,mode:0o700});secureDirectory(path.join(dir,'private'));
      atomicJson(path.join(dir,'private','config.json'),cfg);
      const meta={runId,identity:identity(cfg),asset:cfg.startUrl,createdAt:new Date().toISOString(),status:'starting',limitMode:cfg.limitMode,
        budgets:Object.fromEntries(EXPLORATION_LIMITS.map(key=>[key,cfg[key]])),counts:{},pending:{}};
      atomicJson(path.join(dir,'private','mcp-job.json'),meta);
      const job={runId,dir,logs:[],createdAt:meta.createdAt,cachedMeta:meta};jobs.set(runId,job);return launch(job,cfg,false,false);
    },
    resume(input){
      keys(input,['runId','limitMode','limits']);idle();const job=getJob(input.runId),record=readMeta(job);validate(job,record.meta);
      if(record.registryOnly)throw error('NOT_RESUMABLE','worker 尚未建立运行断点，请开始新任务');
      const lock=lockInfo(job);if(lock.invalid)throw error('RUN_LOCK_INVALID','运行锁损坏，不能续跑');if(lock.alive)throw error('RUN_LOCKED','任务正在由另一个 worker 使用');
      const saved=read(job,path.join(job.dir,'private/config.json'));delete saved._runtime;delete saved._policy;
      const override=Object.hasOwn(input,'limitMode')||Object.hasOwn(input,'limits');
      const cfg=normalizeConfig({...saved,...(override?limitValues(input,saved):{}),outputDir:job.dir},{baseDir:PROJECT_ROOT});
      return launch(job,cfg,true,override);
    },
    stop(input){keys(input,['runId']);const job=getJob(input.runId);if(active?.job!==job)throw error('NOT_OWNED','只能停止本实例启动且仍在运行的 worker');stopWorker(active);return publicJob(job);},
    status(input){keys(input,['runId']);return publicJob(getJob(input.runId));},
    list(input={}){
      keys(input,['offset','limit']);const offset=input.offset??0,limit=input.limit??20;
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw error('INVALID_ARGUMENT','offset/limit 无效（limit 1–100）');
      scan();const all=[...jobs.values()].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))||a.runId.localeCompare(b.runId));
      const usable=[];for(const job of all){try{assertDir(job);usable.push(job)}catch{/* no escaped paths in results */}}
      const runs=[];let bytes=0,truncated=false;
      for(const job of usable.slice(offset,offset+limit)){
        const {logs,...summary}=publicJob(job),size=Buffer.byteLength(JSON.stringify(summary));
        if(runs.length&&bytes+size>96*1024){truncated=true;break;}runs.push(summary);bytes+=size;
      }
      return {runs,offset,limit,total:usable.length,nextOffset:offset+runs.length<usable.length?offset+runs.length:null,truncated};
    },
    getRunDir(runId){const job=getJob(runId),record=readMeta(job);validate(job,record.meta);return assertDir(job);},
    hasActive(){if(active)return true;scan();for(const job of jobs.values()){try{if(lockInfo(job).alive)return true}catch{}}return false;},
    shutdown(){
      if(shutdownPromise)return shutdownPromise;closing=true;
      return shutdownPromise=(async()=>{
        const worker=active;if(!worker)return;
        try{stopWorker(worker)}catch(e){addLog(worker.job,'停止请求失败: '+safeText(e.message));}
        const wait=async ms=>{let timer;try{return await Promise.race([worker.done.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),ms)})])}finally{clearTimeout(timer)}};
        if(await wait(20000))return;
        for(const [signal,timeout] of [['SIGTERM',2000],['SIGKILL',1000]]){
          if(worker.finished)return;
          try{worker.child.kill(signal)}catch(e){addLog(worker.job,'结束自己的 worker 失败: '+safeText(e.message));}
          if(await wait(timeout))return;
        }
        throw error('SHUTDOWN_INCOMPLETE','自己的 worker 未在关闭期限内退出');
      })();
    },
  };
}
