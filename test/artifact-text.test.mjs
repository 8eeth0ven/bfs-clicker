import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {readArtifactText} from '../src/artifact-text.js';
import {temp} from './helpers.mjs';

function interceptRead(t,callback){
 const original=fs.readSync;let count=0;
 fs.readSync=function(...args){const result=original.apply(this,args);callback(++count,...args);return result;};syncBuiltinESMExports();
 t.after(()=>{fs.readSync=original;syncBuiltinESMExports();});
}

test('descriptor reader preserves exact UTF-8/BOM and enforces actual byte limits',t=>{
 const dir=temp(t),file=path.join(dir,'规范.json'),text='\uFEFF{"name":"上海"}';fs.writeFileSync(file,text);
 const bytes=Buffer.byteLength(text);assert.deepEqual(readArtifactText(file,bytes),{document:text,bytes});
 assert.throws(()=>readArtifactText(file,bytes-1),{code:'DOCUMENT_LIMIT'});
 fs.writeFileSync(file,'');assert.deepEqual(readArtifactText(file,0),{document:'',bytes:0});
 fs.writeFileSync(file,Buffer.from([0xc3,0x28]));assert.throws(()=>readArtifactText(file,2),{code:'DOCUMENT_ENCODING_INVALID'});
 for(const limit of [-1,NaN,Infinity,8*1024*1024+1])assert.throws(()=>readArtifactText(file,limit),{code:'DOCUMENT_LIMIT'});
});

test('growth during read never bypasses the byte ceiling',t=>{
 const file=path.join(temp(t),'growing.json');fs.writeFileSync(file,'a'.repeat(65536));
 interceptRead(t,n=>{if(n===1)fs.appendFileSync(file,'extra bytes');});
 assert.throws(()=>readArtifactText(file,65536),{code:'DOCUMENT_LIMIT'});
});

test('truncation or same-size overwrite during read rejects the snapshot',t=>{
 const file=path.join(temp(t),'changing.json');fs.writeFileSync(file,'a'.repeat(65537));
 interceptRead(t,n=>{if(n===1)fs.truncateSync(file,10);});
 assert.throws(()=>readArtifactText(file,65537),{code:'DOCUMENT_CHANGED'});
});

test('same-size content replacement with restored mtime still fails the metadata guard',t=>{
 const file=path.join(temp(t),'rewritten.json');fs.writeFileSync(file,'a'.repeat(65537));const before=fs.statSync(file);
 interceptRead(t,n=>{if(n===1){fs.writeFileSync(file,'b'.repeat(65537));fs.utimesSync(file,before.atime,before.mtime);}});
 assert.throws(()=>readArtifactText(file,65537),{code:'DOCUMENT_CHANGED'});
});

test('nonregular files and leaf symlinks reject without leaking filesystem paths',t=>{
 const dir=temp(t),file=path.join(dir,'file.json'),link=path.join(dir,'link.json');fs.writeFileSync(file,'{}');fs.symlinkSync(file,link);
 assert.throws(()=>readArtifactText(dir,1024),{code:'DOCUMENT_LIMIT'});
 assert.throws(()=>readArtifactText(link,1024),{code:'DOCUMENT_UNAVAILABLE'});
 try{readArtifactText(path.join(dir,'missing.json'),1024);assert.fail('must reject');}catch(error){assert.equal(error.code,'DOCUMENT_UNAVAILABLE');assert(!error.message.includes(dir));}
});

test('FIFO descriptors are nonblocking and rejected before any read',{skip:process.platform==='win32'},t=>{
 const fifo=path.join(temp(t),'pipe');execFileSync('mkfifo',[fifo]);let reads=0;interceptRead(t,()=>reads++);
 assert.throws(()=>readArtifactText(fifo,1024),{code:'DOCUMENT_LIMIT'});assert.equal(reads,0);
});
