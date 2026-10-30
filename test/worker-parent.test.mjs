import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { root } from './helpers.mjs';

async function child(t,source){
  const process=spawn(globalThis.process.execPath,['--input-type=module','--eval',source],{cwd:root,env:{...globalThis.process.env,BFS_MCP_WORKER:'1'},stdio:['ignore','pipe','pipe','ipc']});
  t.after(()=>{if(process.exitCode===null)process.kill('SIGKILL')});
  let out='',err='';process.stdout.on('data',v=>{out+=v});process.stderr.on('data',v=>{err+=v});
  await new Promise((resolve,reject)=>{process.once('message',resolve);process.once('error',reject);process.once('exit',()=>reject(new Error('worker exited before ready: '+err)));});
  return {process,get out(){return out},get err(){return err}};
}
const parentModule=pathToFileURL(path.join(root,'src/worker-parent.js')).href;
const budgetModule=pathToFileURL(path.join(root,'src/budget.js')).href;
test('IPC loss aborts budget, and a stuck worker exits within watchdog grace',{timeout:5000},async t=>{
  const worker=await child(t,`
    import {watchWorkerParent} from ${JSON.stringify(parentModule)};
    import {createBudget} from ${JSON.stringify(budgetModule)};
    watchWorkerParent({graceMs:60});
    createBudget({outputDir:'.',maxDurationMs:null},{checkpoint:{},emit:(kind,value)=>console.log(JSON.stringify({kind,...value}))});
    setInterval(()=>{},1000);process.send('ready');
  `);
  const closed=once(worker.process,'exit');worker.process.disconnect();const [code]=await closed;
  assert.equal(code,1,worker.err);assert.match(worker.out,/parent_disconnected/);
});
test('budget notices parent loss before it is constructed',{timeout:5000},async t=>{
  const worker=await child(t,`
    import {watchWorkerParent} from ${JSON.stringify(parentModule)};
    import {createBudget} from ${JSON.stringify(budgetModule)};
    const release=watchWorkerParent({graceMs:1000});
    process.once('disconnect',()=>setTimeout(()=>{
      const budget=createBudget({outputDir:'.',maxDurationMs:null},{checkpoint:{},emit:()=>{}});
      console.log(budget.reason);try{budget.check()}catch(error){console.log(error.reason)}budget.dispose();release();
    },10));process.send('ready');
  `);
  const closed=once(worker.process,'exit');worker.process.disconnect();const [code]=await closed;
  assert.equal(code,0,worker.err);assert.equal(worker.out.trim(),'parent_disconnected\nparent_disconnected');
});
