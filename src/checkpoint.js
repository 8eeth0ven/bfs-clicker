import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const VERSION=1;
const SET_FIELDS=new Set(['frontier','visitedHits','backEdges','hostCounters','counters','seedsVisited',
  'coverageGaps','apis','endpoints','seeds','requestCounter']);
const APPEND_FIELDS=new Set(['frontier','backEdges','seedsVisited','coverageGaps','endpoints','seeds']);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>JSON.parse(JSON.stringify(value));
const checksum=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const seq=value=>Number.isSafeInteger(value)&&value>=0;

function syncDirectory(dir) {
  // Windows does not expose directory fsync through Node; file contents are still flushed.
  if(process.platform==='win32')return;
  const fd=openSync(dir,'r');try{fsyncSync(fd)}finally{closeSync(fd)}
}
export function durableReplace(file,data) {
  const temp=`${file}.tmp-${randomUUID()}`;let fd;
  try {
    fd=openSync(temp,'wx',0o600);writeFileSync(fd,data);fsyncSync(fd);closeSync(fd);fd=undefined;
    renameSync(temp,file);syncDirectory(path.dirname(file));
  } finally {
    if(fd!==undefined)closeSync(fd);
    if(existsSync(temp))unlinkSync(temp);
  }
}
function validateDelta(delta) {
  if(!plain(delta)||Object.keys(delta).some(k=>!['upsertStates','set','append'].includes(k)))throw new Error('checkpoint journal delta 无效');
  if(delta.upsertStates!==undefined&&(!Array.isArray(delta.upsertStates)||delta.upsertStates.some(s=>!plain(s)||!Number.isSafeInteger(s.id)||s.id<=0)))throw new Error('checkpoint journal upsertStates 需要正整数 state id');
  for(const [section,allowed] of [['set',SET_FIELDS],['append',APPEND_FIELDS]]) {
    if(delta[section]!==undefined&&(!plain(delta[section])||Object.keys(delta[section]).some(k=>!allowed.has(k))))throw new Error(`checkpoint journal ${section} 字段无效`);
  }
  for(const [key,value] of Object.entries(delta.append||{}))if(!Array.isArray(value))throw new Error(`checkpoint journal append.${key} 必须是数组`);
  for(const [key,value] of Object.entries(delta.set||{})) {
    if(['visitedHits','requestCounter'].includes(key)){if(!seq(value))throw new Error(`checkpoint journal set.${key} 必须为非负整数`)}
    else if(key==='counters'){if(!plain(value))throw new Error('checkpoint journal counters 必须为对象')}
    else if(!Array.isArray(value))throw new Error(`checkpoint journal set.${key} 必须是数组`);
  }
}
function payloadOf(record) {
  return {version:record.version,identity:record.identity,runId:record.runId,seq:record.seq,eventSequence:record.eventSequence,delta:record.delta};
}
function validateRecord(record,identity,runId) {
  if(!plain(record)||record.version!==VERSION||!seq(record.seq)||record.seq===0||!seq(record.eventSequence))throw new Error('checkpoint journal 记录格式/序号无效');
  if(record.runId!==runId||!plain(record.identity)||Object.entries(identity).some(([k,v])=>record.identity[k]!==v)||Object.keys(record.identity).some(k=>!(k in identity)))throw new Error('checkpoint journal identity/runId 与任务不一致');
  if(record.checksum!==checksum(payloadOf(record)))throw new Error('checkpoint journal checksum 不匹配');
  validateDelta(record.delta);
}

// A compact retains the entire journal since the previous compact, not merely
// since the current one. Thus checkpoint.json.previous remains recoverable even
// after a successful rotation or a kill between any two durable renames.
export function openCheckpointJournal({file,checkpointFile,checkpoint,identity,runId,readOnly=false}) {
  if(checkpoint!==undefined&&(!plain(checkpoint)||!Array.isArray(checkpoint.states||[])))throw new Error('checkpoint 格式无效');
  const baseSequence=checkpoint?.journalSequence??0;
  if(!seq(baseSequence))throw new Error('checkpoint journalSequence 无效');
  let sequence=baseSequence,lastCompact=checkpoint?clone(checkpoint):null;
  if(lastCompact)delete lastCompact._recoveredFromPrevious;
  const materialized=checkpoint?clone(checkpoint):{};
  const states=new Map((materialized.states||[]).map(s=>[s.id,s]));
  let records=[],lastRecordSequence=null,applied=0,writeBroken=false;
  const notices=[];
  if(checkpoint?._recoveredFromPrevious)notices.push({reason:'checkpoint_previous_recovered',sequence:baseSequence});
  const apply=record=>{
    // Retained records are immutable checksum inputs. Recovered graph objects
    // belong to the caller and must not alias the records replayed from disk.
    for(const state of record.delta.upsertStates||[])states.set(state.id,clone(state));
    for(const [key,value] of Object.entries(record.delta.set||{}))materialized[key]=clone(value);
    for(const [key,values] of Object.entries(record.delta.append||{})) {
      if(!Array.isArray(materialized[key]))materialized[key]=[];
      for(const value of values)materialized[key].push(clone(value));
    }
    materialized.eventSequence=Math.max(Number(materialized.eventSequence||0),record.eventSequence);
  };
  if(existsSync(file)) {
    const bytes=readFileSync(file);let offset=0,validEnd=0;
    while(offset<bytes.length) {
      const newline=bytes.indexOf(10,offset),terminated=newline>=0,end=terminated?newline:bytes.length;
      const raw=bytes.subarray(offset,end);let record;
      try{record=JSON.parse(raw.toString('utf8'))}
      catch(error) {
        if(terminated)throw new Error(`checkpoint journal 损坏（字节 ${offset}）：${error.message}`);
        const rejected=readOnly?null:`${file}.rejected-${randomUUID()}`;
        if(!readOnly){durableReplace(rejected,bytes.subarray(offset));durableReplace(file,bytes.subarray(0,validEnd));}
        notices.push({reason:'checkpoint_journal_incomplete_tail',discardedBytes:bytes.length-offset,
          ...(readOnly?{readOnly:true}:{rejectedFile:path.basename(rejected)})});
        break;
      }
      validateRecord(record,identity,runId);
      if(lastRecordSequence!==null&&record.seq!==lastRecordSequence+1) {
        if(record.seq<=lastRecordSequence||record.seq>baseSequence+1)throw new Error('checkpoint journal 记录重复、乱序或序号缺口');
        // A torn redundant record may already be covered by the durable latest
        // snapshot. A gap is recoverable only entirely before that snapshot;
        // required post-snapshot records must remain strictly contiguous.
        notices.push({reason:'checkpoint_journal_snapshot_covered_gap',fromSequence:lastRecordSequence+1,toSequence:record.seq-1});
      }
      lastRecordSequence=record.seq;records.push(record);
      if(record.seq>baseSequence) {
        if(record.seq!==sequence+1)throw new Error(`checkpoint journal 缺少序号 ${sequence+1}`);
        apply(record);sequence=record.seq;applied++;
      }
      validEnd=terminated?end+1:end;offset=validEnd;
      if(!terminated) {
        if(!readOnly)durableReplace(file,Buffer.concat([bytes,Buffer.from('\n')]));
        notices.push({reason:readOnly?'checkpoint_journal_missing_newline':'checkpoint_journal_newline_restored',...(readOnly?{readOnly:true}:{})});
      }
    }
    // A nonempty journal wholly before the snapshot is valid after a compact;
    // the next append must still continue at the authoritative snapshot seq.
    if(lastRecordSequence!==null&&lastRecordSequence>sequence)throw new Error('checkpoint journal 超出可恢复序号');
  }
  if(checkpoint||applied) {
    materialized.states=[...states.values()];materialized.journalSequence=sequence;
    if(applied)notices.push({reason:'checkpoint_journal_replayed',records:applied,fromSequence:baseSequence,toSequence:sequence});
  }
  return {
    checkpoint:checkpoint||applied?materialized:undefined,
    notices,
    get sequence(){return sequence},
    append(delta,eventSequence) {
      if(readOnly)throw new Error('checkpoint journal 为只读，不能 append');
      if(writeBroken)throw new Error('checkpoint journal 前次写入失败；请停止并检查私有断点');
      validateDelta(delta);if(!seq(eventSequence)||sequence>=Number.MAX_SAFE_INTEGER)throw new Error('checkpoint journal 序号无效');
      const payload={version:VERSION,identity,runId,seq:sequence+1,eventSequence,delta:clone(delta)};
      const record={...payload,checksum:checksum(payload)},line=JSON.stringify(record)+'\n';
      const existed=existsSync(file);let fd;
      try {
        fd=openSync(file,'a',0o600);writeFileSync(fd,line);fsyncSync(fd);closeSync(fd);fd=undefined;
        if(!existed)syncDirectory(path.dirname(file));
      } catch(error) {writeBroken=true;throw error}
      finally{if(fd!==undefined)closeSync(fd)}
      sequence=record.seq;records.push(record);return sequence;
    },
    compact(payload,publish) {
      if(readOnly)throw new Error('checkpoint journal 为只读，不能 compact');
      const next={...payload,journalSequence:sequence};
      const previous=lastCompact;
      if(previous)durableReplace(`${checkpointFile}.previous`,JSON.stringify(previous,null,2));
      durableReplace(checkpointFile,JSON.stringify(next,null,2));
      lastCompact=clone(next);
      // If public export fails, leave the journal untouched. Private latest and
      // previous snapshots already remain valid, and the failure propagates.
      publish(next);
      const floor=previous?.journalSequence??0;
      const retained=records.filter(record=>record.seq>floor);
      // Preserve a damaged append for inspection before a complete snapshot can
      // replace its journal. A failed compact never silently erases evidence.
      if(writeBroken&&existsSync(file))durableReplace(`${file}.rejected-${randomUUID()}`,readFileSync(file));
      durableReplace(file,retained.map(record=>JSON.stringify(record)+'\n').join(''));
      records=retained;writeBroken=false;return next;
    },
  };
}
