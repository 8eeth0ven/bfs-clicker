import { mkdirSync, existsSync, readFileSync, writeFileSync, openSync, closeSync, renameSync, unlinkSync, copyFileSync, appendFileSync, chmodSync, statSync, readSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { redact } from './redact.js';

export const SCHEMA_VERSION = 2;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function identity(config) {
  return {schemaVersion:SCHEMA_VERSION,canonicalTarget:config.startUrl,
    scopeFingerprint:hash([config.navigationOrigins,config.requestOrigins,config.credentialOrigins,config.includeUrlPattern||'',config.resourcePolicy]),
    authProfileId:hash(config.authProfileId),
    policyFingerprint:hash([config.actionProfile,config.actionAllowlist,config.requestAllowlist,config.excludeSelectors,config.excludeTextPatterns,config.skipTextPatterns,config.clickEverything,config.fillText,config.formExplore,config.autoAgreeConsent,config.exploreHover,config.exploreScroll,config.maxScrollSteps,config.maxSelectOptions,config.fingerprintNoisePatterns,config.fingerprintIgnoreSelectors]),
  };
}
export function atomicJson(file, value, backup=true) {
  mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp=`${file}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});
    if (backup && existsSync(file)) copyFileSync(file,`${file}.previous`);
    renameSync(temp,file);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function readAtomic(file) {
  try { return JSON.parse(readFileSync(file,'utf8')); }
  catch (error) {
    if (existsSync(`${file}.previous`)) {
      try { return {...JSON.parse(readFileSync(`${file}.previous`,'utf8')),_recoveredFromPrevious:true}; } catch { /* preserve original error */ }
    }
    throw new Error(`损坏或缺少 ${path.basename(file)}: ${error.message}`);
  }
}
export function acquireLock(file, info={}) {
  mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const owner={pid:process.pid,nonce:randomUUID(),createdAt:new Date().toISOString(),...info};
  try {
    const fd=openSync(file,'wx',0o600); writeFileSync(fd,JSON.stringify(owner));closeSync(fd);
  } catch (e) {
    if (e.code!=='EEXIST') throw e;
    let old;
    try { old=JSON.parse(readFileSync(file,'utf8')); } catch { throw new Error(`锁损坏，请确认无运行进程后删除 ${file}`); }
    let alive=true;
    try { process.kill(old.pid,0); } catch (error) { if (error.code==='ESRCH') alive=false; }
    if (alive) throw new Error(`目录/会话正在被 PID ${old.pid} 使用: ${file}`);
    unlinkSync(file); return acquireLock(file,info);
  }
  return () => { try { if (JSON.parse(readFileSync(file,'utf8')).nonce===owner.nonce) unlinkSync(file); } catch { /* already released */ } };
}
export function secureDirectory(dir) {
  mkdirSync(dir,{recursive:true,mode:0o700});
  if (process.platform!=='win32') { chmodSync(dir,0o700); return; }
  // Use the current security principal, with no shell interpolation.
  const principal=execFileSync('whoami',[],{encoding:'utf8',windowsHide:true}).trim();
  execFileSync('icacls',[dir,'/inheritance:r','/grant:r',`${principal}:(OI)(CI)F`],{stdio:'pipe',windowsHide:true});
}
export function openStore(config,resume=false) {
  const dir=config.outputDir;mkdirSync(dir,{recursive:true,mode:0o700});
  // Control panels pass a per-worker token via BFS_OWNER; the lock file then proves
  // which spawned worker really owns the run before anyone writes STOP.
  const release=acquireLock(path.join(dir,'.run.lock'),process.env.BFS_OWNER?{owner:String(process.env.BFS_OWNER).slice(0,64)}:{});
  try {
    const privateDir=path.join(dir,'private');secureDirectory(privateDir);
    const id=identity(config); const metaFile=path.join(privateDir,'run.json'); const cpFile=path.join(privateDir,'checkpoint.json');
    let meta,checkpoint;
    if (resume) {
      meta=readAtomic(existsSync(metaFile)?metaFile:path.join(dir,'run.json'));
      for (const [key,value] of Object.entries(id)) if (meta.identity?.[key]!==value) throw new Error(`resume 不兼容: ${key}；请使用新的输出目录`);
      config.runId=meta.runId;config.sessionId=meta.runId;
      const checkpointFile=existsSync(cpFile)||existsSync(`${cpFile}.previous`)?cpFile:path.join(dir,'checkpoint.json');
      if (existsSync(checkpointFile) || existsSync(`${checkpointFile}.previous`)) checkpoint=readAtomic(checkpointFile);
      if (checkpoint?.identity && Object.entries(id).some(([k,v])=>checkpoint.identity[k]!==v)) throw new Error('checkpoint identity 与 run 不一致');
    } else {
      if (existsSync(metaFile) || existsSync(cpFile) || existsSync(path.join(dir,'run.json')) || existsSync(path.join(dir,'checkpoint.json')) || existsSync(path.join(dir,'traffic.jsonl'))) throw new Error('输出目录已有任务；请使用 resume 或新的输出目录');
      meta={runId:config.runId,identity:id,createdAt:new Date().toISOString(),attempts:0,status:'running',authEpoch:0};
    }
    mkdirSync(path.join(dir,'states'),{recursive:true,mode:0o700});
    const snapshot={...config};delete snapshot._runtime;delete snapshot._policy;
    atomicJson(path.join(privateDir,'config.json'),snapshot);
    meta.attempts++;meta.authEpoch=(meta.authEpoch||0)+(config.authMode==='anonymous'&&!config.authInject?0:1);meta.status='running';meta.startedAt=new Date().toISOString();meta.stopReason=null;
    meta.asset=config.startUrl;meta.policy={actionProfile:config.actionProfile,resourcePolicy:config.resourcePolicy,navigationOrigins:config.navigationOrigins,requestOrigins:config.requestOrigins,credentialOrigins:config.credentialOrigins};
    meta.limitMode=config.limitMode;
    meta.budgets=Object.fromEntries(['maxStates','maxDepth','maxDurationMs','maxRequests','maxTabs','maxRetries','maxActions','maxStatesPerHost'].map(k=>[k,config[k]]));
    atomicJson(metaFile,meta);
    atomicJson(path.join(dir,'run.json'),redact(meta));
    const eventsFile=path.join(privateDir,'events.jsonl');let sequence=Math.max(Number(checkpoint?.eventSequence||0),lastEventSequence(eventsFile,meta.runId));
    const separatedTail=ensureAppendBoundary(eventsFile);
    const emit=(kind,data={})=>{
      const evidenceId=`${meta.runId}:${++sequence}`;
      appendFileSync(eventsFile,JSON.stringify({...data,...(data.evidenceId?{relatedEvidenceId:data.evidenceId}:{}),evidenceId,ts:new Date().toISOString(),kind,attempt:meta.attempts,authEpoch:meta.authEpoch})+'\n',{mode:0o600});
      return evidenceId;
    };
    if(separatedTail)emit('log_tail_separated',{file:'events.jsonl',reason:'missing_final_newline'});
    return {dir,privateDir,meta,checkpoint,emit,release,
      save(cp){const payload={...cp,schemaVersion:SCHEMA_VERSION,identity:id,eventSequence:sequence,savedAt:new Date().toISOString()};atomicJson(cpFile,payload);atomicJson(path.join(dir,'checkpoint.json'),redact(payload));},
      update(fields){Object.assign(meta,fields);atomicJson(metaFile,meta);atomicJson(path.join(dir,'run.json'),redact(meta));},
    };
  } catch(e) {release();throw e;}
}
// Preserve a truncated record, but never glue the next valid JSON record to it.
export function ensureAppendBoundary(file){
  if(!existsSync(file)||statSync(file).size===0)return false;
  const fd=openSync(file,'r');let last;
  try{const byte=Buffer.alloc(1);readSync(fd,byte,0,1,statSync(file).size-1);last=byte[0];}finally{closeSync(fd);}
  if(last===10)return false;
  appendFileSync(file,'\n');return true;
}
function lastEventSequence(file,runId){
  if(!existsSync(file))return 0;
  const fd=openSync(file,'r');
  try{const size=statSync(file).size;const length=Math.min(size,2*1024*1024);const tail=Buffer.alloc(length);readSync(fd,tail,0,length,size-length);
    for(const line of tail.toString('utf8').trimEnd().split('\n').reverse()){
      try{const row=JSON.parse(line);if(row.evidenceId?.startsWith(runId+':'))return Number(row.evidenceId.slice(runId.length+1))||0}catch{}
    }
    if(size>0)throw new Error('events.jsonl 尾部无有效记录；请检查损坏日志后再恢复');return 0;
  }finally{closeSync(fd)}
}
