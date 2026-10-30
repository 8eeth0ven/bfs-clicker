import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { normalizeConfig } from '../src/asset.js';
import { openStore } from '../src/store.js';
import { openCheckpointJournal } from '../src/checkpoint.js';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function fixture(t) {
  const dir=mkdtempSync(path.join(tmpdir(),'bfs-store-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const config=normalizeConfig({startUrl:'http://127.0.0.1:3100/',outputDir:dir,runId:'store-test-run'});
  return {dir,config,privateCp:path.join(dir,'private','checkpoint.json'),journal:path.join(dir,'private','checkpoint.journal.jsonl')};
}
const state=(id,status='planned')=>({id,url:'http://127.0.0.1:3100/'+id,depth:0,children:[],path:[],interactives:[{id:'action-'+id,status}],processed:[],failed:[],expanded:false});
const base=(states=[])=>({states,frontier:states.map(s=>s.id),visitedHits:0,backEdges:[],hostCounters:[],counters:{requests:0,actions:0,totalRequests:0,totalActions:0},seedsVisited:[],coverageGaps:[],apis:[],endpoints:[],seeds:[],requestCounter:0});
const read=file=>JSON.parse(readFileSync(file,'utf8'));
function lines(file){return readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line))}
function sign(record) {
  const payload={version:record.version,identity:record.identity,runId:record.runId,seq:record.seq,eventSequence:record.eventSequence,delta:record.delta};
  return {...payload,checksum:createHash('sha256').update(JSON.stringify(payload)).digest('hex')};
}

test('legacy save API remains compatible and produces only redacted public snapshots',t=>{
  const f=fixture(t),store=openStore(f.config);
  const cp=base([state(1)]);cp.states[0].token='private-test-token';
  cp.apis=[{url:'http://127.0.0.1:3100/api?token=private-query-token',headers:{Authorization:'Bearer private-header-token'}}];
  store.save(cp);store.release();
  assert.equal(read(f.privateCp).journalSequence,0);
  assert.match(readFileSync(f.privateCp,'utf8'),/private-test-token/);
  assert.doesNotMatch(readFileSync(path.join(f.dir,'checkpoint.json'),'utf8'),/private-test-token|private-query-token|private-header-token/);
  assert.equal(readFileSync(f.journal,'utf8'),'');
  if(process.platform!=='win32')assert.equal(statSync(f.privateCp).mode&0o777,0o600);
  const resumed=openStore(f.config,true);t.after(resumed.release);
  assert.equal(resumed.checkpoint.states[0].id,1);
});

test('journal replays state upserts, top-level replacements, append arrays and event sequence',t=>{
  const f=fixture(t),store=openStore(f.config);store.save(base([state(1)]));
  const publicBefore=readFileSync(path.join(f.dir,'checkpoint.json'),'utf8');
  store.emit('unit_event',{kindHint:'first'});
  store.journal({upsertStates:[state(1,'running'),state(2,'succeeded')],set:{frontier:[2],counters:{requests:9,actions:3,totalRequests:19,totalActions:13},hostCounters:[['127.0.0.1:3100',2]],seedsVisited:['http://127.0.0.1:3100/seed'],visitedHits:4,coverageGaps:[{reason:'fixture_gap'}],requestCounter:30},append:{backEdges:[{from:2,to:1}],seeds:['http://127.0.0.1:3100/seed'],endpoints:['http://127.0.0.1:3100/api/one']}});
  assert.equal(store.journalSequence,1);
  store.journal({upsertStates:[state(1,'succeeded')],append:{frontier:[1],backEdges:[{from:1,to:2}]}});
  assert.equal(readFileSync(path.join(f.dir,'checkpoint.json'),'utf8'),publicBefore,'incremental writes must not rewrite public graph');
  store.release();
  const resumed=openStore(f.config,true);t.after(resumed.release);
  assert.equal(resumed.journalSequence,2);
  assert.deepEqual(resumed.checkpoint.states.map(s=>[s.id,s.interactives[0].status]),[[1,'succeeded'],[2,'succeeded']]);
  assert.deepEqual(resumed.checkpoint.frontier,[2,1]);assert.equal(resumed.checkpoint.visitedHits,4);
  assert.equal(resumed.checkpoint.backEdges.length,2);assert.equal(resumed.checkpoint.counters.totalRequests,19);
  assert.deepEqual(resumed.checkpoint.hostCounters,[['127.0.0.1:3100',2]]);
  assert.equal(resumed.checkpoint.seedsVisited.length,1);assert.equal(resumed.checkpoint.coverageGaps[0].reason,'fixture_gap');
  assert.equal(resumed.checkpoint.endpoints.length,1);assert.equal(resumed.checkpoint.seeds.length,1);
  assert.equal(resumed.checkpoint.requestCounter,30);
  const id=resumed.emit('after_resume');assert.ok(Number(id.split(':').at(-1))>resumed.checkpoint.eventSequence);
  assert.ok(lines(path.join(f.dir,'private','events.jsonl')).some(row=>row.reason==='checkpoint_journal_replayed'));
  assert.equal(existsSync(path.join(f.dir,'checkpoint.journal.jsonl')),false);
});

test('journal can bootstrap a state graph before its first compact',t=>{
  const f=fixture(t),store=openStore(f.config);
  store.journal({upsertStates:[state(1)],set:{frontier:[1],counters:{totalActions:1}}});store.release();
  assert.equal(existsSync(f.privateCp),false);
  const resumed=openStore(f.config,true);t.after(resumed.release);
  assert.equal(resumed.checkpoint.states[0].id,1);assert.equal(resumed.checkpoint.counters.totalActions,1);
});

test('journal event sequence prevents ID reuse even when the event log tail is lost',t=>{
  const f=fixture(t),store=openStore(f.config);store.save(base());
  store.emit('first');store.emit('second');store.journal({upsertStates:[state(1)]});store.release();
  const eventsFile=path.join(f.dir,'private','events.jsonl'),firstLine=readFileSync(eventsFile,'utf8').split('\n')[0];
  writeFileSync(eventsFile,firstLine+'\n');
  const resumed=openStore(f.config,true);t.after(resumed.release);
  assert.equal(resumed.checkpoint.eventSequence,2);
  const next=resumed.emit('after_truncated_event_log');assert.ok(Number(next.split(':').at(-1))>2);
});

test('mutating replayed states and appending replayed arrays cannot corrupt retained record checksums',t=>{
  const f=fixture(t),store=openStore(f.config);store.save(base());
  store.journal({upsertStates:[state(1)],set:{backEdges:[]}});
  store.journal({append:{backEdges:[{from:1,to:1}]}});store.release();
  const resumed=openStore(f.config,true);
  resumed.checkpoint.states[0].interactives[0].status='succeeded';
  resumed.checkpoint.backEdges.push({from:1,to:2});
  resumed.journal({upsertStates:resumed.checkpoint.states,set:{backEdges:resumed.checkpoint.backEdges}});
  resumed.save(resumed.checkpoint);resumed.release();
  const next=openStore(f.config,true);
  assert.equal(next.checkpoint.states[0].interactives[0].status,'succeeded');assert.equal(next.checkpoint.backEdges.length,2);
  next.release();writeFileSync(f.privateCp,'corrupt latest');
  const previous=openStore(f.config,true);t.after(previous.release);
  assert.equal(previous.checkpoint.states[0].interactives[0].status,'succeeded');assert.equal(previous.checkpoint.backEdges.length,2);
});

test('one multi-state delta restores parent-child references before frontier enqueue',t=>{
  const f=fixture(t),store=openStore(f.config),parent=state(1);store.save(base([parent]));
  const child={...state(2),parentId:1,depth:1};parent.children.push(2);
  store.journal({upsertStates:[child,parent],set:{frontier:[],hostCounters:[['127.0.0.1:3100',2]]}});
  store.save({...base([parent,child]),frontier:[]});store.release();
  writeFileSync(f.privateCp,'latest damaged');
  const resumed=openStore(f.config,true);t.after(resumed.release);
  const states=new Map(resumed.checkpoint.states.map(s=>[s.id,s]));
  assert.deepEqual(states.get(1).children,[2]);assert.equal(states.get(2).parentId,1);
  assert.equal(states.get(2).interactives[0].status,'planned');
  assert.equal(states.get(1).children.every(id=>states.has(id)),true);
  assert.deepEqual(resumed.checkpoint.frontier,[],'runner must rebuild pending states rather than trusting old enqueue');
});

test('compact retains the previous snapshot replay window and recovers twice from corrupt latest',t=>{
  const f=fixture(t),store=openStore(f.config);store.save(base());
  store.journal({upsertStates:[state(1)]});store.save(base([state(1)]));
  store.journal({upsertStates:[state(2)]});store.save(base([state(1),state(2)]));
  assert.deepEqual(lines(f.journal).map(row=>row.seq),[2]);
  assert.equal(read(f.privateCp+'.previous').journalSequence,1);
  store.journal({upsertStates:[state(3,'running')]});store.release();
  writeFileSync(f.privateCp,'{"broken":');
  const resumed=openStore(f.config,true);
  assert.deepEqual(resumed.checkpoint.states.map(s=>s.id),[1,2,3]);assert.equal(resumed.journalSequence,3);
  resumed.save(resumed.checkpoint);resumed.release();
  assert.equal(read(f.privateCp+'.previous').journalSequence,1,'do not back up corrupt latest bytes over valid previous');
  writeFileSync(f.privateCp,'corrupt again');
  const second=openStore(f.config,true);t.after(second.release);
  assert.deepEqual(second.checkpoint.states.map(s=>s.id),[1,2,3]);assert.equal(second.journalSequence,3);
});

test('kill window after latest snapshot and before rotation replays only later records',t=>{
  const f=fixture(t),store=openStore(f.config);store.save(base());
  store.journal({upsertStates:[state(1)]});store.journal({upsertStates:[state(2)]});
  const beforeRotation=readFileSync(f.journal);
  store.save(base([state(1),state(2)]));
  // An interrupted rotation leaves a complete old journal alongside the newer compact.
  writeFileSync(f.journal,beforeRotation);
  store.journal({upsertStates:[state(2,'succeeded')]});store.release();
  const resumed=openStore(f.config,true);t.after(resumed.release);
  assert.equal(resumed.checkpoint.states.length,2);assert.equal(resumed.checkpoint.states[1].interactives[0].status,'succeeded');
  assert.equal(resumed.journalSequence,3);
});

test('public export failure cannot rotate away the private previous recovery window',t=>{
  const f=fixture(t),store=openStore(f.config);store.save(base());
  store.journal({upsertStates:[state(1)]});store.save(base([state(1)]));
  store.journal({upsertStates:[state(2)]});const before=readFileSync(f.journal,'utf8');
  const publicFile=path.join(f.dir,'checkpoint.json');rmSync(publicFile);mkdirSync(publicFile);
  assert.throws(()=>store.save(base([state(1),state(2)])));
  assert.equal(readFileSync(f.journal,'utf8'),before);assert.equal(read(f.privateCp).journalSequence,2);
  store.release();writeFileSync(f.privateCp,'bad latest');
  const resumed=openStore(f.config,true);t.after(resumed.release);
  assert.deepEqual(resumed.checkpoint.states.map(s=>s.id),[1,2]);
});

test('incomplete final journal line is preserved privately and the valid prefix remains appendable',t=>{
  const f=fixture(t),store=openStore(f.config);store.save(base());
  store.journal({upsertStates:[state(1)]});store.release();
  appendFileSync(f.journal,'{"version":1,"seq":2,"delta":');
  const resumed=openStore(f.config,true);
  assert.equal(resumed.checkpoint.states.length,1);assert.equal(resumed.journalSequence,1);
  const rejected=readdirSync(path.dirname(f.journal)).filter(name=>name.startsWith('checkpoint.journal.jsonl.rejected-'));
  assert.equal(rejected.length,1);assert.match(readFileSync(path.join(path.dirname(f.journal),rejected[0]),'utf8'),/"seq":2/);
  assert.ok(lines(path.join(f.dir,'private','events.jsonl')).some(row=>row.reason==='checkpoint_journal_incomplete_tail'));
  resumed.journal({upsertStates:[state(2)]});resumed.release();
  const next=openStore(f.config,true);t.after(next.release);assert.equal(next.checkpoint.states.length,2);
});

test('read-only journal recovery preserves truncated and missing-newline files byte-for-byte',t=>{
  const f=fixture(t),store=openStore(f.config);store.save(base());store.journal({upsertStates:[state(1)]});store.release();
  const complete=readFileSync(f.journal,'utf8'),checkpoint=read(f.privateCp),privateDir=path.dirname(f.journal);
  for(const suffix of ['{"version":1,"seq":2',null]) {
    writeFileSync(f.journal,suffix===null?complete.trimEnd():complete+suffix);
    const before=readFileSync(f.journal),names=readdirSync(privateDir).sort();
    const journal=openCheckpointJournal({file:f.journal,checkpointFile:f.privateCp,checkpoint,identity:checkpoint.identity,runId:f.config.runId,readOnly:true});
    assert.equal(journal.checkpoint.states[0].id,1);assert.equal(journal.sequence,1);
    assert.ok(journal.notices.some(notice=>notice.readOnly===true));
    assert.throws(()=>journal.append({upsertStates:[state(2)]},0),/只读/);assert.throws(()=>journal.compact(base(),()=>{}),/只读/);
    assert.deepEqual(readFileSync(f.journal),before);assert.deepEqual(readdirSync(privateDir).sort(),names);
  }
});

test('complete final journal record missing newline is retained and separated',t=>{
  const f=fixture(t),store=openStore(f.config);store.journal({upsertStates:[state(1)]});store.release();
  writeFileSync(f.journal,readFileSync(f.journal,'utf8').trimEnd());
  const resumed=openStore(f.config,true);assert.equal(resumed.journalSequence,1);
  resumed.journal({upsertStates:[state(2)]});resumed.release();
  const next=openStore(f.config,true);t.after(next.release);assert.equal(next.checkpoint.states.length,2);
});

test('snapshot-covered torn redundant tail does not create a false gap after the next append',t=>{
  const f=fixture(t),store=openStore(f.config);store.save(base());
  store.journal({upsertStates:[state(1)]});store.journal({upsertStates:[state(2)]});
  store.save(base([state(1),state(2)]));store.release();
  const rows=lines(f.journal);writeFileSync(f.journal,JSON.stringify(rows[0])+'\n{"version":1,"seq":2');
  const resumed=openStore(f.config,true);assert.equal(resumed.journalSequence,2);
  resumed.journal({upsertStates:[state(3)]});resumed.release();
  const next=openStore(f.config,true);t.after(next.release);
  assert.deepEqual(next.checkpoint.states.map(s=>s.id),[1,2,3]);
  assert.ok(lines(path.join(f.dir,'private','events.jsonl')).some(row=>row.reason==='checkpoint_journal_snapshot_covered_gap'));
});

for(const variant of ['checksum','identity','gap','duplicate','terminated-corruption'])test(`journal refuses ${variant} without silently losing state`,t=>{
  const f=fixture(t),store=openStore(f.config);store.save(base());
  store.journal({upsertStates:[state(1)]});store.journal({upsertStates:[state(2)]});store.release();
  const records=lines(f.journal);
  if(variant==='checksum')records[1].delta.upsertStates[0].interactives[0].status='forged';
  if(variant==='identity')records[1].identity.canonicalTarget='http://other.invalid/';
  if(variant==='gap')records[1]=sign({...records[1],seq:3});
  if(variant==='duplicate')records[1]=sign({...records[1],seq:1});
  const altered=records.map(row=>JSON.stringify(row)+'\n').join('')+(variant==='terminated-corruption'?'broken\n':'');
  writeFileSync(f.journal,altered);
  assert.throws(()=>openStore(f.config,true),/checkpoint journal/);
  assert.equal(readFileSync(f.journal,'utf8'),altered);
  assert.equal(existsSync(path.join(f.dir,'.run.lock')),false,'failed recovery releases lock');
});

test('active run lock prevents a second journal writer',t=>{
  const f=fixture(t),first=openStore(f.config);t.after(first.release);
  assert.throws(()=>openStore(f.config,true),/正在被 PID/);
  first.journal({upsertStates:[state(1)]});assert.equal(first.journalSequence,1);
});

test('old private checkpoint without journal fields resumes and upgrades on compact',t=>{
  const f=fixture(t),store=openStore(f.config);store.save(base([state(1)]));store.release();
  const old=read(f.privateCp);delete old.journalSequence;writeFileSync(f.privateCp,JSON.stringify(old));rmSync(f.journal);
  const resumed=openStore(f.config,true);assert.equal(resumed.checkpoint.states.length,1);
  resumed.journal({upsertStates:[state(1,'succeeded')]});resumed.save({...resumed.checkpoint,states:[state(1,'succeeded')]});resumed.release();
  assert.equal(read(f.privateCp).journalSequence,1);
  const next=openStore(f.config,true);t.after(next.release);assert.equal(next.checkpoint.states[0].interactives[0].status,'succeeded');
});

test('invalid delta is rejected before append',t=>{
  const f=fixture(t),store=openStore(f.config);t.after(store.release);
  for(const delta of [{set:{identity:{}}},{set:{states:[]}},{upsertStates:[{id:-1}]},{append:{backEdges:{}}},{set:{counters:[]}}])assert.throws(()=>store.journal(delta),/checkpoint journal/);
  assert.equal(store.journalSequence,0);assert.equal(existsSync(f.journal),false);
});

test('SIGKILL after durable journal survives with planned/running/succeeded states and counters',async t=>{
  const f=fixture(t),childFile=path.join(f.dir,'writer.mjs');
  const storeUrl=pathToFileURL(path.join(root,'src','store.js')).href;
  writeFileSync(childFile,`import {openStore} from ${JSON.stringify(storeUrl)};
const config=JSON.parse(process.argv[2]),store=openStore(config);
store.save(${JSON.stringify(base())});
store.emit('before_kill');
store.journal({upsertStates:${JSON.stringify([state(1,'planned')])},set:{frontier:[1],counters:{totalRequests:1,totalActions:1}}});
store.journal({upsertStates:${JSON.stringify([state(2,'running')])},set:{frontier:[1,2],counters:{totalRequests:2,totalActions:2}}});
store.journal({upsertStates:${JSON.stringify([state(3,'succeeded')])},set:{frontier:[1,2,3],counters:{totalRequests:3,totalActions:3}}});
process.send({durable:true});setInterval(()=>{},1000);
`);
  const child=spawn(process.execPath,[childFile,JSON.stringify(f.config)],{stdio:['ignore','pipe','pipe','ipc']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);t.after(()=>child.kill('SIGKILL'));
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('child journal timeout '+stderr)),10000);
    child.once('message',message=>{clearTimeout(timer);message.durable?resolve():reject(new Error('missing durable acknowledgement'))});
    child.once('error',error=>{clearTimeout(timer);reject(error)});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('writer exited before acknowledgement '+stderr))});
  });
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  const resumed=openStore(f.config,true);t.after(resumed.release);
  assert.deepEqual(resumed.checkpoint.states.map(s=>s.interactives[0].status),['planned','running','succeeded']);
  assert.equal(resumed.checkpoint.counters.totalActions,3);assert.equal(resumed.checkpoint.counters.totalRequests,3);
  assert.equal(resumed.journalSequence,3);
  assert.ok(lines(path.join(f.dir,'private','events.jsonl')).some(row=>row.reason==='checkpoint_journal_replayed'));
});

test('SIGKILL in compact after durable private rename and before public export keeps recovery safe',async t=>{
  const f=fixture(t),childFile=path.join(f.dir,'compact-writer.mjs');
  const storeUrl=pathToFileURL(path.join(root,'src','store.js')).href;
  const journalUrl=pathToFileURL(path.join(root,'src','checkpoint.js')).href;
  writeFileSync(childFile,`import {openStore,identity} from ${JSON.stringify(storeUrl)};
import {openCheckpointJournal} from ${JSON.stringify(journalUrl)};
import {readFileSync} from 'node:fs';
const config=JSON.parse(process.argv[2]),store=openStore(config);
store.save(${JSON.stringify(base())});store.journal({upsertStates:${JSON.stringify([state(1,'succeeded')])}});
const id=identity(config),checkpointFile=${JSON.stringify(f.privateCp)};
const journal=openCheckpointJournal({file:${JSON.stringify(f.journal)},checkpointFile,checkpoint:JSON.parse(readFileSync(checkpointFile,'utf8')),identity:id,runId:config.runId});
journal.compact({...${JSON.stringify(base([state(1,'succeeded')]))},identity:id,schemaVersion:2,eventSequence:0},()=>process.kill(process.pid,'SIGKILL'));
`);
  const child=spawn(process.execPath,[childFile,JSON.stringify(f.config)],{stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);t.after(()=>child.kill('SIGKILL'));
  const [code,signal]=await once(child,'exit');assert.equal(signal,'SIGKILL',stderr);assert.equal(code,null);
  assert.equal(read(f.privateCp).journalSequence,1);assert.equal(read(path.join(f.dir,'checkpoint.json')).journalSequence,0);
  assert.deepEqual(lines(f.journal).map(row=>row.seq),[1]);
  const resumed=openStore(f.config,true);t.after(resumed.release);
  assert.equal(resumed.checkpoint.states[0].interactives[0].status,'succeeded');assert.equal(resumed.journalSequence,1);
});
