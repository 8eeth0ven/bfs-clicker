import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, EXPLORATION_LIMITS, normalizeConfig } from '../src/asset.js';
import { PROJECT_ROOT } from '../src/config.js';
import { atomicJson, readAtomic, secureDirectory } from '../src/store.js';
import { redact, redactText } from '../src/redact.js';
import { sendText, serveRunFile } from './files.js';

const VIEW_ROOT=path.dirname(fileURLToPath(import.meta.url));
const PANEL_CSP="default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const terminalStatuses=new Set(['completed','partial','failed','blocked','needs_auth']);

class HttpError extends Error {
  constructor(status,message){super(message);this.status=status;}
}
function json(res,status,value){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',
    'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; frame-ancestors 'none'"});
  res.end(JSON.stringify(value));
}
async function body(req){
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw new HttpError(415,'请求需要 JSON');
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>32768)throw new HttpError(413,'请求过大');chunks.push(chunk);}
  let value;
  try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new HttpError(400,'无效 JSON');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'请求必须是对象');
  return value;
}
function keys(value,allowed){
  for(const key of Object.keys(value))if(!allowed.includes(key))throw new HttpError(400,'未知参数: '+key);
}
function budgets(value){
  if(!['default','custom','unlimited'].includes(value.limitMode))throw new HttpError(400,'请选择预算模式');
  const result={limitMode:value.limitMode};
  if(value.limitMode==='custom'){
    if(!value.limits||typeof value.limits!=='object'||Array.isArray(value.limits))throw new HttpError(400,'请提供全部自定义上限');
    keys(value.limits,EXPLORATION_LIMITS);
    for(const key of EXPLORATION_LIMITS){
      const n=value.limits[key];
      if(!Number.isSafeInteger(n)||n<(key==='maxDepth'?0:1))throw new HttpError(400,key+' 上限无效');
      result[key]=n;
    }
  }else{
    if(value.limits!=null)throw new HttpError(400,'默认或不限模式无需 limits');
    for(const key of EXPLORATION_LIMITS)result[key]=value.limitMode==='unlimited'?null:DEFAULTS[key];
  }
  return result;
}

// Resume budgets travel on the fixed CLI argv instead of a pre-lock config write:
// the worker merges them only after it owns the run lock, so a second panel can
// never overwrite the configuration of an active run.
function budgetArgs(cfg){
  if(cfg.limitMode==='unlimited')return ['--limit-mode','unlimited'];
  if(cfg.limitMode==='default')return ['--limit-mode','default'];
  const args=['--limit-mode','custom'];
  for(const [key,flag] of [['maxStates','--max-states'],['maxDepth','--max-depth'],['maxRequests','--max-requests'],
    ['maxActions','--max-actions'],['maxStatesPerHost','--max-states-per-host']])
    if(cfg[key]!=null)args.push(flag,String(cfg[key]));
  if(cfg.maxDurationMs!=null)args.push('--max-duration',String(Math.max(1,Math.round(cfg.maxDurationMs/1000))));
  return args;
}

// Each worker uses the CLI and its guarded runner. The panel can select only
// registered runs and whitelisted settings; request data never becomes a command.
export function createControlPanel({outputRoot=path.join(PROJECT_ROOT,'output-runs'),initialRun=null,baseConfig={}}={}) {
  mkdirSync(outputRoot,{recursive:true,mode:0o700});
  const root=realpathSync(path.resolve(outputRoot)),token=randomBytes(32).toString('base64url');
  const jobs=new Map();let active=null,closing=false,initialRunId=null;
  const withinRoot=dir=>{const relative=path.relative(root,realpathSync(dir));return !relative.startsWith('..')&&!path.isAbsolute(relative);};
  const register=dir=>{
    const real=realpathSync(dir),meta=readAtomic(path.join(real,'run.json'));
    if(typeof meta.runId!=='string'||!meta.runId||!meta.identity)throw new Error('无法识别运行目录');
    const id=/^[\w.-]{1,180}$/.test(meta.runId)?meta.runId:createHash('sha256').update(meta.runId).digest('hex');
    const previous=jobs.get(id);
    if(previous&&previous.dir!==real)throw new Error('重复的 runId');
    const job=previous||{id,dir:real,logs:[],stopRequested:false};jobs.set(job.id,job);return job;
  };
  for(const item of readdirSync(root,{withFileTypes:true})){
    if(!item.isDirectory())continue;
    const dir=path.join(root,item.name);
    try{if(withinRoot(dir)&&existsSync(path.join(dir,'run.json')))register(dir);}catch{/* unrelated folders */}
  }
  if(initialRun){const job=register(path.resolve(initialRun));initialRunId=job.id;}
  const addLog=(job,line)=>{
    job.logs.push(redactText(line).slice(0,1500));
    if(job.logs.length>80)job.logs.splice(0,job.logs.length-80);
  };
  const publicJob=job=>{
    let meta={};try{meta=readAtomic(path.join(job.dir,'run.json'));}catch{/* worker has not initialized yet */}
    const worker=active&&active.job===job?active:null;
    const working=!!worker;
    const interrupted=!working&&meta.status==='running';
    const progress=working?meta.progress||{}:{};
    let reportLink=null;
    try{if(statSync(path.join(job.dir,'report.html')).isFile())reportLink='/runs/'+encodeURIComponent(job.id)+'/report.html';}catch{/* no readable report */}
    return redact({id:job.id,asset:meta.asset||job.asset||'',limitMode:meta.limitMode||job.limitMode||'default',
      budgets:meta.budgets||job.budgets||{},status:working?(job.stopRequested?'stopping':worker.ownerConfirmed?(meta.status||'running'):'starting'):
        interrupted?'partial':meta.status||job.failure?.status||'failed',
      stopReason:interrupted?'worker_interrupted':meta.stopReason||job.failure?.reason||null,
      startedAt:meta.startedAt||job.startedAt,finishedAt:meta.finishedAt,counts:{...(meta.counts||{}),...progress},
      pending:meta.pending||{actions:progress.pendingActions||0},logs:job.logs,outputDir:job.dir,
      active:working,canResume:!active&&(terminalStatuses.has(meta.status)||interrupted)&&existsSync(path.join(job.dir,'private','config.json')),
      report:reportLink});
  };
  const getJob=id=>{const job=jobs.get(id);if(!job)throw new HttpError(404,'任务不存在');return job;};
  const writeStop=(job,note)=>{writeFileSync(path.join(job.dir,'STOP'),note,{mode:0o600});};
  const stop=job=>{
    if(active?.job!==job)throw new HttpError(409,'任务已结束');
    job.stopRequested=true;const worker=active;
    // Only a worker that verifiably owns the run lock (owner token + PID in .run.lock)
    // may write STOP. A startup-phase request lands right after its own lock confirm,
    // so it can never stop another panel's run.
    if(worker.ownerConfirmed){writeStop(job,'stop requested by local panel\n');addLog(job,'已请求停止；正在保存进度和结果。');}
    else addLog(job,'已请求停止；等待本 worker 取得运行锁后生效，不写入其他实例持有的任务。');
  };
  const launch=(job,cfg,resume)=>{
    if(active)throw new HttpError(409,'已有任务运行，请先停止或等待完成');
    if(closing)throw new HttpError(503,'面板正在关闭');
    secureDirectory(path.join(job.dir,'private'));
    const owner=randomBytes(16).toString('hex');
    job.stopRequested=false;job.failure=null;job.asset=cfg.startUrl;job.limitMode=cfg.limitMode;job.startedAt=new Date().toISOString();
    job.budgets=Object.fromEntries(EXPLORATION_LIMITS.map(key=>[key,cfg[key]]));
    // New runs need a config file for the CLI; its authoritative snapshot is rewritten
    // by the worker after the run lock. Resume never mutates the run directory here.
    let args;
    if(resume)args=['resume','--run',job.dir,...budgetArgs(cfg)];
    else{const configFile=path.join(job.dir,'private','config.json');atomicJson(configFile,cfg);args=['run','--config',configFile];}
    const env={...process.env};delete env.RESUME;delete env.BFS_PIDFILE;delete env.BFS_OWNER;env.BFS_OWNER=owner;
    const child=spawn(process.execPath,[path.join(PROJECT_ROOT,'src','index.js'),...args],
      {cwd:PROJECT_ROOT,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    const worker={job,child,done:null,owner,ownerConfirmed:false};active=worker;
    addLog(job,(resume?'续跑':'开始')+' · '+cfg.limitMode);
    const capture=stream=>{
      let pending='';
      stream.on('data',chunk=>{
        pending=(pending+chunk.toString('utf8')).slice(-65536);
        const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines)if(line)addLog(job,line);
      });
      stream.on('end',()=>{if(pending)addLog(job,pending);});
    };
    capture(child.stdout);capture(child.stderr);
    // Ownership handshake: this panel may only write STOP once the lock file proves
    // the spawned worker (token + PID) actually holds the run lock.
    const confirmTimer=setInterval(()=>{
      if(worker.ownerConfirmed||!worker.child.pid)return;
      let lock=null;
      try{lock=JSON.parse(readFileSync(path.join(job.dir,'.run.lock'),'utf8'));}catch{return;}
      if(lock&&lock.owner===worker.owner&&lock.pid===worker.child.pid){
        worker.ownerConfirmed=true;clearInterval(confirmTimer);
        if(job.stopRequested){writeStop(job,'stop requested during startup\n');addLog(job,'启动期停止：本 worker 已取得运行锁，写入 STOP 保存进度。');}
      }
    },50);confirmTimer.unref();
    const stopTimer=setInterval(()=>{
      // A stop during resume startup must survive the runner clearing an old STOP,
      // but only once this worker verifiably owns the lock.
      if(job.stopRequested&&active===worker&&worker.ownerConfirmed)writeStop(job,'stop requested\n');
    },100);stopTimer.unref();
    worker.done=new Promise(resolve=>{
      child.once('error',error=>{job.failure={status:'failed',reason:'worker_start_failed'};addLog(job,error.message);});
      child.once('close',(code,signal)=>{
        clearInterval(stopTimer);clearInterval(confirmTimer);
        if(code!==0||signal){job.failure={status:'failed',reason:'worker_exited'};addLog(job,'执行进程退出: '+(signal||code));}
        if(active===worker)active=null;
        resolve();
      });
    });
    return publicJob(job);
  };
  const server=createServer(async(req,res)=>{
    try{
      const port=server.address()?.port,host=req.headers.host||'';
      if(host!==`localhost:${port}`&&host!==`127.0.0.1:${port}`)throw new HttpError(403,'invalid host');
      const origin='http://'+host;
      if(req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site')throw new HttpError(403,'仅允许从本地面板操作');
      const url=new URL(req.url,origin),pathname=url.pathname;
      if(pathname.startsWith('/api/')){
        if(req.method==='POST'){
          if(req.headers.origin!==origin)throw new HttpError(403,'缺少本地来源');
          const supplied=Buffer.from(String(req.headers['x-bfs-token']||'')),expected=Buffer.from(token);
          if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw new HttpError(403,'面板令牌无效，请刷新网页');
        }else if(req.method!=='GET')throw new HttpError(405,'method not allowed');
        if(req.method==='GET'&&pathname==='/api/bootstrap')return json(res,200,{token,initialRunId,
          defaults:{limitMode:'default',...Object.fromEntries(EXPLORATION_LIMITS.map(key=>[key,DEFAULTS[key]]))},
          runs:[...jobs.values()].map(publicJob)});
        if(req.method==='GET'&&pathname==='/api/runs')return json(res,200,{runs:[...jobs.values()].map(publicJob),activeId:active?.job.id||null});
        if(req.method==='POST'&&pathname==='/api/runs'){
          const value=await body(req);keys(value,['asset','limitMode','limits','headless','order','resourcePolicy','requestDelayMs']);
          if(active)throw new HttpError(409,'已有任务运行');
          if(typeof value.asset!=='string'||value.asset.length>4096)throw new HttpError(400,'请提供有效资产 URL');
          const id=randomUUID(),dir=path.join(root,id);
          const input={...baseConfig,startUrl:value.asset,runId:id,outputDir:dir,...budgets(value)};
          for(const key of ['headless','order','resourcePolicy','requestDelayMs'])if(value[key]!=null)input[key]=value[key];
          const cfg=normalizeConfig(input,{baseDir:PROJECT_ROOT});
          mkdirSync(dir,{recursive:false,mode:0o700});const job={id,dir,logs:[],stopRequested:false};jobs.set(id,job);
          return json(res,202,{run:launch(job,cfg,false)});
        }
        const action=pathname.match(/^\/api\/runs\/([\w.-]+)\/(stop|resume)$/);
        if(req.method==='POST'&&action){
          const value=await body(req),job=getJob(action[1]);
          if(action[2]==='stop'){keys(value,[]);stop(job);return json(res,202,{run:publicJob(job)});}
          keys(value,['limitMode','limits']);
          if(active)throw new HttpError(409,'已有任务运行');
          const saved=readAtomic(path.join(job.dir,'private','config.json'));delete saved._policy;delete saved._runtime;
          const cfg=normalizeConfig({...saved,outputDir:job.dir,...budgets(value)});
          return json(res,202,{run:launch(job,cfg,true)});
        }
        throw new HttpError(404,'API 不存在');
      }
      if(!['GET','HEAD'].includes(req.method))throw new HttpError(405,'method not allowed');
      const report=pathname.match(/^\/runs\/([\w.-]+)\/(.*)$/);
      if(report){let name;try{name=decodeURIComponent(report[2]);}catch{throw new HttpError(400,'invalid path');}
        return serveRunFile(req,res,getJob(report[1]).dir,name||'report.html');}
      const file={'/':'index.html','/app.js':'app.js','/styles.css':'styles.css'}[pathname];
      if(!file)return sendText(res,404,'not found');
      const types={'index.html':'text/html; charset=utf-8','app.js':'text/javascript; charset=utf-8','styles.css':'text/css; charset=utf-8'};
      res.writeHead(200,{'content-type':types[file],'content-security-policy':PANEL_CSP,'x-content-type-options':'nosniff',
        'cache-control':'no-store','referrer-policy':'no-referrer'});
      res.end(req.method==='HEAD'?undefined:readFileSync(path.join(VIEW_ROOT,file)));
    }catch(error){if(!res.headersSent)json(res,error.status||400,{error:redactText(error.message||'操作失败')});else res.destroy();}
  });
  return {server,async shutdown(){
    if(closing)return;closing=true;
    if(active){const worker=active;stop(worker.job);let timer;
      try{await Promise.race([worker.done,new Promise(resolve=>{timer=setTimeout(()=>{worker.child.kill();resolve();},20000);})]);}finally{clearTimeout(timer);}}
    if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }};
}
