import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createJobManager } from '../src/mcp-jobs.js';
import { normalizeConfig } from '../src/asset.js';
import { identity } from '../src/store.js';
import { redact } from '../src/redact.js';

const asset='http://127.0.0.1:3100/';
const json=file=>JSON.parse(readFileSync(file,'utf8'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class Worker extends EventEmitter {
  constructor(){super();this.pid=process.pid;this.stdout=new PassThrough();this.stderr=new PassThrough();this.kills=[];this.finished=false;}
  finish(code=0,signal=null){if(this.finished)return;this.finished=true;this.cleanup?.();this.stdout.end();this.stderr.end();this.emit('close',code,signal);}
  kill(signal){this.kills.push(signal);this.finish(null,signal);return true;}
}
function harness(t,impl){
  const root=mkdtempSync(path.join(tmpdir(),'bfs-mcp-jobs-')),calls=[],managers=[];
  const original=childProcess.spawn;
  t.mock.method(childProcess,'spawn',(command,args,options)=>{const child=impl?impl(command,args,options):new Worker();calls.push({command,args,options,child});return child;});
  syncBuiltinESMExports();
  const manager=(baseConfig={})=>{const instance=createJobManager({outputRoot:root,baseConfig});managers.push(instance);return instance;};
  t.after(async()=>{for(const call of calls)call.child?.finish?.();await Promise.all(managers.map(item=>item.shutdown()));childProcess.spawn=original;syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});});
  return {root,calls,manager};
}
function seed(root,extra={}){
  const runId=randomUUID(),dir=path.join(root,runId);mkdirSync(path.join(dir,'private'),{recursive:true});
  const config=normalizeConfig({startUrl:asset,runId,outputDir:dir,limitMode:'custom',maxStates:7,maxDepth:4,maxDurationMs:1234,...extra});
  const meta={runId,identity:identity(config),asset:config.startUrl,status:'partial',stopReason:'max_states',createdAt:new Date().toISOString(),
    limitMode:config.limitMode,budgets:Object.fromEntries(['maxStates','maxDepth','maxDurationMs','maxRequests','maxActions','maxStatesPerHost'].map(key=>[key,config[key]])),
    counts:{states:7,requests:15,actions:8},pending:{actions:9},performance:{journalWrites:10}};
  writeFileSync(path.join(dir,'private/config.json'),JSON.stringify(config));writeFileSync(path.join(dir,'private/run.json'),JSON.stringify(meta));writeFileSync(path.join(dir,'run.json'),JSON.stringify(redact(meta)));
  return {runId,dir,config,meta};
}
function claim(call,overrides={}){
  const mode=call.args[1],dir=mode==='resume'?call.args[call.args.indexOf('--run')+1]:path.dirname(path.dirname(call.args[call.args.indexOf('--config')+1]));
  const cfg=json(path.join(dir,'private/config.json'));
  const lockFile=path.join(dir,'.run.lock'),lock={pid:call.child.pid,owner:call.options.env.BFS_OWNER,nonce:randomUUID()};writeFileSync(lockFile,JSON.stringify(lock));
  const meta={runId:cfg.runId,identity:identity(cfg),asset:cfg.startUrl,status:'running',attempts:1,createdAt:new Date().toISOString(),
    limitMode:cfg.limitMode,counts:{states:1,requests:2,actions:1},progress:{states:2,requests:3,actions:2,performance:{journalWrites:3}},pending:{actions:4},...overrides};
  writeFileSync(path.join(dir,'private/run.json'),JSON.stringify(meta));writeFileSync(path.join(dir,'run.json'),JSON.stringify(redact(meta)));
  call.child.cleanup=()=>{try{const current=json(lockFile);if(current.owner===lock.owner&&current.pid===lock.pid)rmSync(lockFile)}catch{}};
  return {dir,cfg,meta,lockFile,lock};
}
function terminal(call,record,status='completed'){
  const meta={...record.meta,status,stopReason:status==='completed'?'frontier_exhausted':'STOP',finishedAt:new Date().toISOString(),counts:{states:4,requests:8,actions:7},performance:{journalWrites:9},pending:{actions:0}};
  writeFileSync(path.join(record.dir,'private/run.json'),JSON.stringify(meta));writeFileSync(path.join(record.dir,'run.json'),JSON.stringify(redact(meta)));call.child.finish(0);
}
function fastShutdown(t){const original=setTimeout;t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>original(fn,[20000,2000,1000].includes(ms)?1:ms,...args));}

test('start returns immediately with UUID, private config, explicit scope and piped worker output',t=>{
  const h=harness(t),manager=h.manager(),result=manager.start({asset,limits:{maxStates:2,maxDepth:0},shotFormat:'none',requestDelayMs:0});
  assert.match(result.runId,/^[a-f0-9-]{36}$/);assert.equal(result.active,true);assert.equal(result.status,'starting');assert.equal(h.calls.length,1);
  const call=h.calls[0],dir=manager.getRunDir(result.runId),cfg=json(path.join(dir,'private/config.json'));
  assert.equal(cfg.maxStates,2);assert.equal(cfg.maxDepth,0);assert.equal(cfg.maxRequests,1500);assert.equal(cfg.limitMode,'custom');assert.equal(cfg.shotFormat,'none');
  assert.deepEqual(call.options.stdio,['ignore','pipe','pipe','ipc']);assert.equal(call.options.shell,false);assert.ok(call.options.env.BFS_OWNER);assert.equal(call.options.env.BFS_MCP_WORKER,'1');
  assert.equal(call.options.env.RESUME,undefined);assert.equal(call.options.env.BFS_PIDFILE,undefined);assert.equal(existsSync(path.join(dir,'run.json')),false);
  assert.equal(result.reportPath,null);assert.equal(result.graphPath,null);assert.equal(manager.hasActive(),true);
});

test('invalid settings, paths and malformed limits are rejected before spawn or directory creation',t=>{
  const h=harness(t),manager=h.manager();
  for(const input of [{asset,outputDir:'/tmp/elsewhere'},{asset,runId:'attacker'},{asset,storageState:'/etc/passwd'},{asset,proxy:{server:'http://proxy'}},
    {asset,session:'/tmp/session'},{asset:'file:///tmp/site'},{asset:'https://u:p@example.com/'},{asset,limits:{maxStates:0}},{asset,limits:{maxDepth:-1}},
    {asset,limits:{maxStates:1.5}},{asset,limits:{unknown:3}},{asset,limits:[]},{asset,limitMode:'unlimited',limits:{}},{asset,requestDelayMs:-1}])assert.throws(()=>manager.start(input));
  assert.equal(h.calls.length,0);assert.equal(readdirSync(h.root).length,0);
});

test('trusted auth and proxy are inherited but never included in public status',t=>{
  const h=harness(t),manager=h.manager({authInject:{headers:{Authorization:'Bearer base-private-token'}},useProxy:true,proxy:{server:'http://127.0.0.1:8080',password:'base-proxy-secret'}});
  const started=manager.start({asset,limitMode:'unlimited'}),cfg=json(path.join(manager.getRunDir(started.runId),'private/config.json'));
  assert.equal(cfg.authInject.headers.Authorization,'Bearer base-private-token');assert.equal(cfg.proxy.password,'base-proxy-secret');assert.equal(cfg.maxStates,null);
  h.calls[0].child.stdout.write('Authorization: Bearer base-private-token\nCookie: raw-cookie-secret\n{"password":"raw-json-secret"}\nbase-proxy-secret\n');
  const status=manager.status({runId:started.runId});assert.doesNotMatch(JSON.stringify(status),/base-private-token|base-proxy-secret|raw-cookie-secret|raw-json-secret/);
});

test('one manager permits only one active worker and partial stop is deferred until ownership handshake',async t=>{
  const h=harness(t),manager=h.manager(),first=manager.start({asset});assert.throws(()=>manager.start({asset}),e=>e.code==='BUSY');
  const dir=manager.getRunDir(first.runId);manager.stop({runId:first.runId});assert.equal(existsSync(path.join(dir,'STOP')),false);
  const record=claim(h.calls[0]);await sleep(70);assert.equal(existsSync(path.join(dir,'STOP')),true);
  rmSync(path.join(dir,'STOP'));await sleep(70);assert.equal(existsSync(path.join(dir,'STOP')),true,'stop request survives a worker clearing old STOP during startup');
  assert.equal(manager.status({runId:first.runId}).status,'stopping');terminal(h.calls[0],record,'partial');assert.equal(manager.status({runId:first.runId}).active,false);
});

test('foreign live worker is visible but cannot be stopped or resumed and its config is untouched',t=>{
  const h=harness(t),a=h.manager(),b=h.manager(),started=a.start({asset}),record=claim(h.calls[0]);
  const before=readFileSync(path.join(record.dir,'private/config.json'));
  const status=b.status({runId:started.runId});assert.equal(status.active,true);assert.equal(status.external,true);assert.equal(status.canStop,false);assert.equal(b.hasActive(),true);
  assert.throws(()=>b.stop({runId:started.runId}),e=>e.code==='NOT_OWNED');assert.throws(()=>b.resume({runId:started.runId,limitMode:'unlimited'}),e=>e.code==='RUN_LOCKED');
  assert.deepEqual(readFileSync(path.join(record.dir,'private/config.json')),before);assert.equal(existsSync(path.join(record.dir,'STOP')),false);
});

test('STOP rechecks owner token and PID after an earlier successful handshake',async t=>{
  const h=harness(t),manager=h.manager(),started=manager.start({asset}),record=claim(h.calls[0]);await sleep(70);
  writeFileSync(record.lockFile,JSON.stringify({...record.lock,owner:'a-different-worker'}));manager.stop({runId:started.runId});await sleep(70);
  assert.equal(existsSync(path.join(record.dir,'STOP')),false);assert.equal(json(record.lockFile).owner,'a-different-worker');assert.equal(manager.status({runId:started.runId}).external,true);
});

test('resume retains all historical budgets when none are supplied and never prewrites config',t=>{
  const h=harness(t),run=seed(h.root),manager=h.manager(),file=path.join(run.dir,'private/config.json'),before=readFileSync(file);
  const started=manager.resume({runId:run.runId});assert.equal(started.runId,run.runId);assert.deepEqual(h.calls[0].args.slice(1),['resume','--run',manager.getRunDir(run.runId)]);
  assert.deepEqual(readFileSync(file),before);assert.equal(started.budgets.maxStates,7);
});

test('resume partial limits travel through argv while keeping other historical values and millisecond precision',t=>{
  const h=harness(t),run=seed(h.root),manager=h.manager(),file=path.join(run.dir,'private/config.json'),before=readFileSync(file);
  manager.resume({runId:run.runId,limits:{maxStates:11,maxDurationMs:1}});const args=h.calls[0].args;
  assert.equal(args[args.indexOf('--max-states')+1],'11');assert.equal(args[args.indexOf('--max-depth')+1],'4');assert.equal(args[args.indexOf('--max-duration')+1],'0.001');
  assert.deepEqual(readFileSync(file),before);
});

test('resume unlimited and explicit default mode are represented by fixed CLI flags',t=>{
  const h=harness(t),run=seed(h.root),manager=h.manager();manager.resume({runId:run.runId,limitMode:'unlimited'});
  assert.deepEqual(h.calls[0].args.slice(-2),['--limit-mode','unlimited']);h.calls[0].child.finish();
  manager.resume({runId:run.runId,limitMode:'default'});assert.deepEqual(h.calls[1].args.slice(-2),['--limit-mode','default']);
});

test('terminal status returns bounded progress, performance and only existing safe artifact paths',t=>{
  const h=harness(t),manager=h.manager(),started=manager.start({asset}),record=claim(h.calls[0]);
  assert.equal(manager.status({runId:started.runId}).counts.states,2);assert.equal(manager.status({runId:started.runId}).performance.journalWrites,3);
  writeFileSync(path.join(record.dir,'report.html'),'report');writeFileSync(path.join(record.dir,'graph.html'),'graph');writeFileSync(path.join(record.dir,'graph.json'),'{}');
  terminal(h.calls[0],record);const done=manager.status({runId:started.runId});assert.equal(done.status,'completed');assert.equal(done.active,false);assert.equal(done.performance.journalWrites,9);
  assert.equal(done.reportPath,path.join(record.dir,'report.html'));assert.equal(done.graphPath,path.join(record.dir,'graph.html'));assert.equal(done.canResume,true);
});

test('stdout/stderr and status logs are bounded and list omits log history',t=>{
  const h=harness(t),manager=h.manager(),started=manager.start({asset}),child=h.calls[0].child;
  for(let i=0;i<200;i++)child.stderr.write('line-'+i+' '+('x'.repeat(2000))+' token=private-'+i+'\n');
  const status=manager.status({runId:started.runId});assert.equal(status.logs.length,20);assert.ok(status.logs.every(line=>line.length<=1000));assert.doesNotMatch(JSON.stringify(status),/private-/);
  child.stderr.write('中文日志'.repeat(1000)+'\n');assert.ok(manager.status({runId:started.runId}).logs.every(line=>Buffer.byteLength(line)<=1000));
  const listed=manager.list();assert.equal(listed.runs.length,1);assert.equal('logs' in listed.runs[0],false);
});

test('list is paginated and hasActive checks foreign workers beyond the first hundred runs',t=>{
  const h=harness(t),runs=Array.from({length:105},()=>seed(h.root)),manager=h.manager();
  const last=runs[104];writeFileSync(path.join(last.dir,'.run.lock'),JSON.stringify({pid:process.pid,owner:'external-owner'}));
  const first=manager.list({offset:0,limit:20}),second=manager.list({offset:20,limit:20});
  assert.equal(first.runs.length,20);assert.equal(first.nextOffset,20);assert.equal(first.total,105);assert.equal(manager.hasActive(),true);
  assert.equal(first.runs.some(a=>second.runs.some(b=>a.runId===b.runId)),false);
  assert.throws(()=>manager.list({limit:101}));assert.throws(()=>manager.list({offset:-1}));
});

test('list enforces a byte budget and nextOffset reflects actual results',t=>{
  const h=harness(t);for(let i=0;i<20;i++){const run=seed(h.root),meta={...run.meta,performance:Object.fromEntries(Array.from({length:40},(_,j)=>['metric-'+j,'x'.repeat(300)]))};writeFileSync(path.join(run.dir,'private/run.json'),JSON.stringify(meta));}
  const manager=h.manager(),page=manager.list({limit:100});assert.ok(page.runs.length<20);assert.equal(page.truncated,true);assert.equal(page.nextOffset,page.runs.length);assert.ok(Buffer.byteLength(JSON.stringify(page))<100*1024);
});

test('scan rejects symlink escapes and identity mismatch, and getRunDir revalidates',t=>{
  const h=harness(t),valid=seed(h.root),outside=mkdtempSync(path.join(tmpdir(),'bfs-mcp-outside-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
  const external=seed(outside);symlinkSync(external.dir,path.join(h.root,'escaped-directory'),'dir');
  const invalid=seed(h.root),bad=json(path.join(invalid.dir,'private/config.json'));bad.startUrl='https://different.example/';writeFileSync(path.join(invalid.dir,'private/config.json'),JSON.stringify(bad));
  const manager=h.manager(),ids=manager.list().runs.map(row=>row.runId);assert.deepEqual(ids,[valid.runId]);
  assert.throws(()=>manager.getRunDir(external.runId));assert.throws(()=>manager.getRunDir('../escape'));
  writeFileSync(path.join(valid.dir,'private/config.json'),JSON.stringify({...valid.config,startUrl:'https://different.example/'}));assert.throws(()=>manager.getRunDir(valid.runId),/identity/);
});

test('an escaped artifact and STOP symlink are not followed; polling errors remain contained',async t=>{
  const h=harness(t),manager=h.manager(),started=manager.start({asset}),record=claim(h.calls[0]),outside=path.join(h.root,'outside-file');writeFileSync(outside,'untouched');
  symlinkSync(outside,path.join(record.dir,'report.html'));assert.equal(manager.status({runId:started.runId}).reportPath,null);
  symlinkSync(outside,path.join(record.dir,'STOP'));assert.throws(()=>manager.stop({runId:started.runId}),/STOP/);await sleep(70);
  assert.equal(readFileSync(outside,'utf8'),'untouched');assert.ok(manager.status({runId:started.runId}).logs.some(line=>line.includes('后台回调失败')));
});

test('spawn errors are retained as failed jobs across manager restart without phantom resume',t=>{
  const h=harness(t),manager=h.manager(),started=manager.start({asset}),child=h.calls[0].child;
  child.pid=undefined;
  child.emit('error',new Error('spawn failed token=private-spawn-token'));const failed=manager.status({runId:started.runId});
  assert.equal(failed.active,false);assert.equal(failed.status,'failed');assert.equal(failed.stopReason,'worker_start_failed');assert.doesNotMatch(JSON.stringify(failed),/private-spawn-token/);
  const restarted=h.manager();assert.equal(restarted.status({runId:started.runId}).status,'failed');assert.throws(()=>restarted.resume({runId:started.runId}),e=>e.code==='NOT_RESUMABLE');
});

test('runtime child control error does not forget a still-live worker',t=>{
  const h=harness(t),manager=h.manager(),started=manager.start({asset});claim(h.calls[0]);
  h.calls[0].child.emit('error',new Error('kill EPERM'));const status=manager.status({runId:started.runId});
  assert.equal(status.active,true);assert.equal(status.owned,true);assert.equal(status.workerError.reason,'worker_control_error');
  assert.throws(()=>manager.start({asset}),e=>e.code==='BUSY');
});

test('synchronous spawn rejection does not leave manager active or throw from callbacks',t=>{
  const h=harness(t,()=>{throw new Error('spawn rejected')}),manager=h.manager(),result=manager.start({asset});assert.equal(result.status,'failed');assert.equal(result.active,false);assert.equal(manager.hasActive(),false);
});

test('shutdown is idempotent and allows graceful own worker completion',async t=>{
  const h=harness(t),manager=h.manager(),started=manager.start({asset}),record=claim(h.calls[0]),p1=manager.shutdown(),p2=manager.shutdown();assert.equal(p1,p2);
  assert.equal(existsSync(path.join(record.dir,'STOP')),true);setTimeout(()=>terminal(h.calls[0],record,'partial'),10);await p1;
  assert.deepEqual(h.calls[0].child.kills,[]);assert.throws(()=>manager.start({asset}),e=>e.code==='CLOSED');assert.equal(manager.status({runId:started.runId}).active,false);
});

test('shutdown timeout kills only its own child and never writes STOP for a foreign owner',async t=>{
  const h=harness(t),manager=h.manager(),started=manager.start({asset}),record=claim(h.calls[0]);
  writeFileSync(record.lockFile,JSON.stringify({...record.lock,owner:'foreign-owner'}));fastShutdown(t);await manager.shutdown();
  assert.deepEqual(h.calls[0].child.kills,['SIGTERM']);assert.equal(json(record.lockFile).owner,'foreign-owner');assert.equal(existsSync(path.join(record.dir,'STOP')),false);
});
