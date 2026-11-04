import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {EventEmitter,once} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink,realpath} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import {createSoftwareRuntime} from '../src/software-runtime.js';
import {createSoftwareOperations} from '../src/software-operations.js';
const project=path.resolve(import.meta.dirname,'..');
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
const json=async file=>JSON.parse(await readFile(file,'utf8'));
async function until(fn,ms=10000){const start=Date.now();while(Date.now()-start<ms){const result=await fn();if(result)return result;await delay(20)}throw new Error('fixture timeout')}
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'software-ops-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=path.join(dir,'software'),manifest=path.join(dir,'manifest.json');
 await writeFile(manifest,JSON.stringify([{method:'GET',url:'http://127.0.0.1:1/items',headers:{},query:{},body:null,categories:['static_candidate']}]));
 const runtime=createSoftwareRuntime({outputRoot:root,artifactRoots:[dir],bindings:{test:{allowed_origins:['http://127.0.0.1:1']}}});
 return {dir,root,manifest,runtime};
}
async function terminal(manager,id){return until(()=>{const s=manager.status({operationId:id});return !s.active&&['completed','failed','cancelled','interrupted'].includes(s.status)?s:null})}
async function seed(f,args,status={}){
 const id=randomUUID(),out=path.join(f.root,'operations',id);await mkdir(out,{recursive:true});
 const task={id,type:'discover',args,runtimeFile:f.runtime.runtimeFile,outputDir:out,owner:randomUUID(),managerPid:99999999};
 await writeFile(path.join(out,'task.json'),JSON.stringify(task));await writeFile(path.join(out,'status.json'),JSON.stringify({operationId:id,type:'discover',status:'starting',createdAt:new Date().toISOString(),...status}));return {id,out,task};
}
function shortWorker(captured=[]){return(command,args,opts)=>{captured.push(JSON.parse(readFileSync(args[1],'utf8')));return spawn(process.execPath,['-e','setTimeout(()=>{},20)'],{...opts,stdio:['ignore','pipe','pipe','ipc']})}}

test('starting with no surviving PID recovers as interrupted instead of permanent starting',async t=>{
 const f=await fixture(t),old=await seed(f,{kind:'web',sourceId:'web_saved',input:'https://example.test'});
 const manager=createSoftwareOperations(f.runtime),status=manager.status({operationId:old.id});
 assert.equal(status.status,'interrupted');assert.equal(status.active,false);assert.equal(status.canResume,false);
 assert.equal(manager.list().length,1);await assert.rejects(async()=>manager.resume({operationId:old.id}),/NO_CHECKPOINT/);
});

test('real worker compile publishes PID/owner and preserves timestamps through completion',async t=>{
 const f=await fixture(t),manager=createSoftwareOperations(f.runtime);t.after(()=>manager.shutdown());
 const started=manager.start('compile',{sourceId:'test',kind:'web',inventoryPath:f.manifest});
 const initial=await json(path.join(f.root,'operations',started.operationId,'status.json'));
 assert.ok(Number.isInteger((await json(path.join(f.root,'operations',started.operationId,'launch.json'))).pid));assert.ok(initial.owner);assert.ok(initial.createdAt);
 const done=await terminal(manager,started.operationId);assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(done.createdAt,initial.createdAt);assert.ok(done.startedAt);assert.ok(done.finishedAt);assert.equal(manager.hasActive(),false);
 assert.equal((await readdir(f.root)).includes('.operation.lock'),false);
});

test('real import-openapi worker branch is retained',async t=>{
 const f=await fixture(t),document=path.join(f.dir,'openapi.json');
 await writeFile(document,JSON.stringify({openapi:'3.0.3',info:{title:'fixture',version:'1'},servers:[{url:'http://127.0.0.1:1'}],paths:{'/items':{get:{responses:{200:{description:'ok'}}}}}}));
 const manager=createSoftwareOperations(f.runtime);t.after(()=>manager.shutdown());
 const job=manager.start('import-openapi',{sourceId:'test',documentPath:document,documentUrl:'http://127.0.0.1:1/openapi.json'});
 const done=await terminal(manager,job.operationId);assert.equal(done.status,'completed',JSON.stringify(done));
});

test('Web source ID is durable before startup and resume reuses the same run ID',async t=>{
 const f=await fixture(t),captured=[],manager=createSoftwareOperations(f.runtime,{spawnWorker:shortWorker(captured)});t.after(()=>manager.shutdown());
 const job=manager.start('discover',{kind:'web',input:'https://example.test'});const id=captured[0].args.sourceId;assert.match(id,/^web_/);
 await terminal(manager,job.operationId);await mkdir(path.join(f.root,'runs',id,'private'),{recursive:true});await writeFile(path.join(f.root,'runs',id,'private/checkpoint.json'),'{}');
 const resumed=manager.resume({operationId:job.operationId});assert.equal(captured[1].args.runId,id);assert.equal(captured[1].args.sourceId,id);assert.equal(captured[1].resumedFrom,job.operationId);await terminal(manager,resumed.operationId);
});

test('mobile resume and a second resume retain the original operation checkpoint directory',async t=>{
 const f=await fixture(t),old=await seed(f,{kind:'apk',input:f.manifest,deviceName:'test_device'},{status:'cancelled'});
 await mkdir(path.join(old.out,'mobile-ui'));const checkpoint=path.join(old.out,'mobile-ui/checkpoint.json');await writeFile(checkpoint,'{"position":7}');
 const captured=[],manager=createSoftwareOperations(f.runtime,{spawnWorker:shortWorker(captured)});t.after(()=>manager.shutdown());
 const first=manager.resume({operationId:old.id});assert.equal(captured[0].args.resumeOperationDir,await realpath(old.out));await terminal(manager,first.operationId);
 const second=manager.resume({operationId:first.operationId});assert.equal(captured[1].args.resumeOperationDir,await realpath(old.out));assert.notEqual(captured[1].outputDir,old.out);await terminal(manager,second.operationId);
 assert.equal(await readFile(checkpoint,'utf8'),'{"position":7}');
});

test('mobile resume refuses a checkpoint directory symlink outside registered operations',async t=>{
 const f=await fixture(t),old=await seed(f,{kind:'ios',input:f.manifest,deviceName:'test_device'},{status:'cancelled'});
 const outside=path.join(f.dir,'outside');await mkdir(path.join(outside,'mobile-ui'),{recursive:true});await writeFile(path.join(outside,'mobile-ui/checkpoint.json'),'{}');
 const link=path.join(f.root,'operations',randomUUID());await symlink(outside,link);old.task.args.resumeOperationDir=link;await writeFile(path.join(old.out,'task.json'),JSON.stringify(old.task));
 const manager=createSoftwareOperations(f.runtime);assert.throws(()=>manager.resume({operationId:old.id}),/NO_CHECKPOINT|续跑目录/);
});

test('stop during startup cancels only the owned child before any worker execution',async t=>{
 const f=await fixture(t);let child;
 const manager=createSoftwareOperations(f.runtime,{spawnWorker:(cmd,args,opts)=>child=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],opts)});t.after(()=>manager.shutdown());
 const job=manager.start('compile',{sourceId:'test',inventoryPath:f.manifest});manager.stop({operationId:job.operationId});
 const done=await terminal(manager,job.operationId);assert.equal(done.status,'cancelled');assert.equal(alive(child.pid),false);
});

test('foreign manager cannot stop an active HTTP worker or acquire its operation lock',async t=>{
 const f=await fixture(t);let received=0;
 const server=createServer((req,res)=>{received++;req.on('close',()=>res.destroy())});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));
 const origin='http://127.0.0.1:'+server.address().port;
 await writeFile(f.manifest,JSON.stringify([{method:'GET',url:origin+'/slow',headers:{},query:{},body:null,categories:['observed']}]));
 const runtime=createSoftwareRuntime({...f.runtime.config,bindings:{test:{allowed_origins:[origin]}}});await runtime.compile({sourceId:'test',inventoryPath:f.manifest});const cap=runtime.listCapabilities({sourceId:'test'}).items[0];
 const owner=createSoftwareOperations(runtime),foreign=createSoftwareOperations(runtime);t.after(()=>owner.shutdown());
 const job=owner.start('execute',{sourceId:'test',capabilityId:cap.id,expectedRevision:cap.revision});await until(()=>received===1);
 assert.equal(foreign.hasActive(),true);assert.equal(foreign.status({operationId:job.operationId}).canStop,false);
 assert.throws(()=>foreign.stop({operationId:job.operationId}),/本实例/);assert.throws(()=>foreign.start('compile',{sourceId:'test',inventoryPath:f.manifest}),/BUSY/);
 await foreign.shutdown();assert.equal(owner.status({operationId:job.operationId}).active,true);
 owner.stop({operationId:job.operationId});const done=await terminal(owner,job.operationId);assert.equal(done.status,'cancelled');assert.equal(received,1);
 assert.equal((await readdir(f.root)).includes('.operation.lock'),false);
});

test('shutdown is idempotent, force-kills only its own stuck child, and a later worker recovers stale dead lock',async t=>{
 const f=await fixture(t),store=pathToFileURL(path.join(project,'src/store.js')).href;
 const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});t.after(()=>sentinel.kill('SIGKILL'));
 let owned;
 const spawnWorker=(cmd,args,opts)=>{
  const script=`import fs from 'node:fs';import path from 'node:path';import{acquireLock,atomicJson}from ${JSON.stringify(store)};const task=JSON.parse(fs.readFileSync(process.argv[1]));const config=JSON.parse(fs.readFileSync(task.runtimeFile));acquireLock(path.join(config.outputRoot,'.operation.lock'),{task:task.id,owner:task.owner});atomicJson(path.join(task.outputDir,'status.json'),{operationId:task.id,type:task.type,status:'running',pid:process.pid,owner:task.owner});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
  return owned=spawn(process.execPath,['--input-type=module','-e',script,args[1]],opts);
 };
 const manager=createSoftwareOperations(f.runtime,{spawnWorker,shutdownGraceMs:40,killWaitMs:1000}),job=manager.start('compile',{sourceId:'test',inventoryPath:f.manifest});
 await until(async()=>{try{return (await json(path.join(f.root,'.operation.lock'))).pid===owned.pid}catch{return false}});
 const a=manager.shutdown(),b=manager.shutdown();assert.equal(a,b);await a;assert.equal(alive(owned.pid),false);assert.equal(alive(sentinel.pid),true);
 assert.equal(manager.status({operationId:job.operationId}).status,'cancelled');
 const next=createSoftwareOperations(f.runtime);t.after(()=>next.shutdown());const retry=next.start('compile',{sourceId:'test',inventoryPath:f.manifest});assert.equal((await terminal(next,retry.operationId)).status,'completed');
 assert.equal((await readdir(f.root)).includes('.operation.lock'),false);
});

test('spawn failures are persisted and runtime control errors do not forget a live child',async t=>{
 const f=await fixture(t);let fake;
 const make=()=>{fake=new EventEmitter();fake.stdout=new PassThrough();fake.stderr=new PassThrough();fake.kill=()=>true;return fake};
 const failed=createSoftwareOperations(f.runtime,{spawnWorker:make}),job=failed.start('compile',{});fake.emit('error',new Error('launch failed'));
 assert.equal(failed.status({operationId:job.operationId}).status,'failed');assert.equal(failed.hasActive(),false);
 const live=createSoftwareOperations(f.runtime,{spawnWorker:()=>{const child=make();child.pid=process.pid;return child}}),running=live.start('compile',{});
 fake.emit('error',new Error('control error'));assert.equal(live.hasActive(),true);assert.throws(()=>live.start('compile',{}),/BUSY/);
 fake.emit('exit',1,null);assert.equal(live.hasActive(),false);assert.equal(live.status({operationId:running.operationId}).status,'failed');
 const sync=createSoftwareOperations(f.runtime,{spawnWorker:()=>{throw new Error('sync launch failure')}});assert.throws(()=>sync.start('compile',{}),/sync launch failure/);assert.equal(sync.hasActive(),false);
});

test('parent launch publication cannot overwrite a worker that completed before spawn returned',async t=>{
 const f=await fixture(t);
 const manager=createSoftwareOperations(f.runtime,{spawnWorker:(cmd,args,opts)=>{
  const script="const fs=require('node:fs');const path=require('node:path');const task=JSON.parse(fs.readFileSync(process.argv[1]));const file=path.join(task.outputDir,'status.json');const old=JSON.parse(fs.readFileSync(file));fs.writeFileSync(file,JSON.stringify({...old,pid:process.pid,status:'completed',finishedAt:new Date().toISOString()}));";
  const child=spawn(process.execPath,['-e',script,args[1]],opts);
  const statusFile=path.join(JSON.parse(readFileSync(args[1],'utf8')).outputDir,'status.json');
  const deadline=Date.now()+2000;while(Date.now()<deadline){if(JSON.parse(readFileSync(statusFile,'utf8')).status==='completed')break;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}
  return child;
 }});t.after(()=>manager.shutdown());
 const job=manager.start('compile',{}),done=await terminal(manager,job.operationId);
 assert.equal(done.status,'completed');assert.equal(done.owner,undefined);
});
