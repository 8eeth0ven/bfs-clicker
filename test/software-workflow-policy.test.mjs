import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createSoftwareRuntime} from '../src/software-runtime.js';
import {temp} from './helpers.mjs';

test('discovery can narrow approved workflow controls and requests but cannot replace startup approval',async t=>{
 const dir=temp(t),origin='http://127.0.0.1:1';
 const runtime=createSoftwareRuntime({outputRoot:path.join(dir,'out'),webConfig:{actionProfile:'forms',fillText:true,formValues:{'#q':'seed'},actionAllowlist:['#q','#search'],requestAllowlist:[{method:'POST',url:origin+'/query'}]}});
 await assert.rejects(runtime.discover({kind:'web',input:origin,sourceId:'site',webOptions:{actionAllowlist:['#remove']}},path.join(dir,'operation')),/POLICY_EXPANSION.*actionAllowlist/);
 await assert.rejects(runtime.discover({kind:'web',input:origin,sourceId:'site',webOptions:{requestAllowlist:[{method:'POST',url:origin+'/create'}]}},path.join(dir,'operation')),/POLICY_EXPANSION.*requestAllowlist/);
 // Equivalent rule object key order is not a new approval. An intentionally
 // invalid URL stops before any browser launch, after policy preflight.
 await assert.rejects(runtime.discover({kind:'web',input:'invalid-url',sourceId:'site',webOptions:{actionAllowlist:['#q'],requestAllowlist:[{url:origin+'/query',method:'POST'}]}},path.join(dir,'operation')),error=>!error.message.includes('POLICY_EXPANSION'));
});
