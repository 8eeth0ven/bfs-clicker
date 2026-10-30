import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {runPython} from '../src/software-runtime.js';
import {temp,until} from './helpers.mjs';

test('Python subprocess abort waits for owned process cleanup before releasing the operation',async t=>{
  const dir=temp(t),ready=path.join(dir,'ready'),clean=path.join(dir,'clean'),entry=path.join(dir,'cleanup.cjs');
  writeFileSync(entry,`const fs=require('node:fs');process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(clean)},'done');process.exit(0)},150));fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`);
  const controller=new AbortController(),execution=runPython({python:process.execPath},[entry],{signal:controller.signal});
  // Register the rejection immediately; it must not resolve before cleanup.
  const settled=execution.then(()=>({ok:true}),error=>({error}));
  await until(()=>existsSync(ready),5000);controller.abort();
  const result=await settled;assert(result.error);assert(existsSync(clean),'child finally must finish before runPython rejects');
});

test('Python subprocess timeout waits for termination and spawn failure rejects cleanly',async t=>{
  const dir=temp(t),clean=path.join(dir,'timeout-clean'),entry=path.join(dir,'timeout.cjs');
  writeFileSync(entry,`const fs=require('node:fs');process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(clean)},'done');process.exit(0)},100));setInterval(()=>{},1000);`);
  await assert.rejects(runPython({python:process.execPath},[entry],{timeoutMs:500}),/Python操作超时/);
  assert(existsSync(clean));
  await assert.rejects(runPython({python:path.join(dir,'missing-python')},[],{timeoutMs:1000}),/ENOENT/);
});
