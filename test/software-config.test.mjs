import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import {createSoftwareRuntime} from '../src/software-runtime.js';
import {createSoftwareOperations} from '../src/software-operations.js';
import {temp,until} from './helpers.mjs';

test('parallel MCP configurations sharing an output root cannot replace each others worker bindings',async t=>{
  const dir=temp(t),outputRoot=path.join(dir,'out'),inventory=path.join(dir,'inventory.json');
  writeFileSync(inventory,JSON.stringify([{method:'GET',url:'http://127.0.0.1:1/items',categories:['static_candidate']}]));
  const options={outputRoot,artifactRoots:[dir]};
  const first=createSoftwareRuntime({...options,bindings:{test:{allowed_origins:['http://127.0.0.1:1/']}}});
  const original=await first.compile({sourceId:'test',kind:'web',inventoryPath:inventory});
  assert.equal(first.listCapabilities({sourceId:'test'}).items[0].readiness,'ready','valid trailing-slash origin must use the same normalized scope as the gateway');
  const originalDocument=readFileSync(first.runtimeFile,'utf8');
  const second=createSoftwareRuntime({...options,bindings:{test:{allowed_origins:['http://127.0.0.1:2']}}});
  assert.notEqual(first.runtimeFile,second.runtimeFile);assert.equal(readFileSync(first.runtimeFile,'utf8'),originalDocument);
  const operations=createSoftwareOperations(first);t.after(()=>operations.shutdown());
  const started=operations.start('refresh',{sourceId:'test',expectedRevision:original.source.revision});
  const done=await until(()=>{const state=operations.status({operationId:started.operationId});if(state.status==='failed')throw Error(JSON.stringify(state));return state.status==='completed'&&state;},10000);
  assert.equal(done.result.source.revision,original.source.revision);
  assert.deepEqual(done.result.source.allowedOrigins.map(value=>new URL(value).origin),['http://127.0.0.1:1']);
});
