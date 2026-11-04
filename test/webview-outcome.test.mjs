import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,link,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {publicWebviewOutcome,mergeWebviewOutcomes,markWebviewOperation,hasWebviewOperation,persistedWebviewOutcome,projectWebviewOutcomeFields} from '../src/webview-outcome.js';

const outcome=status=>({status,automaticRetry:false});
async function home(t){const root=await mkdtemp(path.join(os.tmpdir(),'webview-outcome-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function put(file,value){await mkdir(path.dirname(file),{recursive:true,mode:0o700});await writeFile(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});}

test('public projection preserves only actual statuses/noRetry and fixed storage warnings',()=>{
 for(const status of ['not_started','observed','unknown'])assert.deepEqual(publicWebviewOutcome({...outcome(status),completionReceipt:{executionId:'private-receipt',intentSha256:'private-digest',path:'/private/input'}}),outcome(status));
 for(const storageWarning of ['matching_completion_receipt_published_before_storage_error','result_persistence_failed_after_observed_scope'])assert.deepEqual(publicWebviewOutcome({...outcome('observed'),storageWarning}),{...outcome('observed'),storageWarning});
 for(const bad of [null,[],{},outcome('ready'),{status:'unknown',automaticRetry:true},{status:'not_started'},{...outcome('observed'),storageWarning:'private raw error'}])assert.equal(publicWebviewOutcome(bad),undefined);
});

test('injected outcome fields and accessors are rejected rather than echoed',()=>{
 for(const field of ['pid','url','path','params','refs','error','intentSha256','__proto__']){
  const value=JSON.parse(JSON.stringify({...outcome('unknown'),[field]:'DO_NOT_EXPOSE'}));assert.equal(publicWebviewOutcome(value),undefined);
 }
 let called=false;const getter={automaticRetry:false};Object.defineProperty(getter,'status',{get(){called=true;return 'unknown';},enumerable:true});assert.equal(publicWebviewOutcome(getter),undefined);assert.equal(called,false);
});

test('merge is conservative only for observed evidence and never fabricates a start state',()=>{
 assert.equal(mergeWebviewOutcomes(undefined,null,{status:'failed'}),undefined);
 assert.deepEqual(mergeWebviewOutcomes(outcome('not_started'),undefined),outcome('not_started'));
 assert.deepEqual(mergeWebviewOutcomes(outcome('observed'),outcome('unknown')),outcome('unknown'));
 assert.deepEqual(mergeWebviewOutcomes(outcome('not_started'),outcome('observed')),outcome('observed'));
 assert.deepEqual(mergeWebviewOutcomes({...outcome('observed'),storageWarning:'result_persistence_failed_after_observed_scope'},outcome('unknown')),outcome('unknown'));
});

test('fixed scoped result/checkpoint recovery covers CLI learn and execution layouts',async t=>{
 const root=await home(t),workflow=path.join(root,'workflow');markWebviewOperation(workflow,'workflow-learn');
 await put(path.join(workflow,'result.json'),{webviewOutcome:outcome('not_started')});assert.equal(hasWebviewOperation(root),true);assert.deepEqual(persistedWebviewOutcome(root),outcome('not_started'));
 await put(path.join(workflow,'checkpoint.json'),{webviewOutcome:outcome('unknown')});assert.deepEqual(persistedWebviewOutcome(root),outcome('unknown'));
 const second=await home(t),execution=path.join(second,'execution');markWebviewOperation(execution,'execute');
 await put(path.join(execution,'result.json'),{webviewOutcome:{...outcome('observed'),completionReceipt:{intentSha256:'PRIVATE'},storageWarning:'result_persistence_failed_after_observed_scope'}});
 assert.deepEqual(persistedWebviewOutcome(second),{...outcome('observed'),storageWarning:'result_persistence_failed_after_observed_scope'});
 assert.deepEqual(persistedWebviewOutcome(execution),persistedWebviewOutcome(second));
});

test('missing producer evidence and foreign native/browser/write fields do not become WebView outcomes',async t=>{
 const root=await home(t);await put(path.join(root,'execution/result.json'),{webviewOutcome:outcome('unknown'),writeOutcome:outcome('unknown'),error:{code:'WEBVIEW_PENDING_UNKNOWN'}});
 await put(path.join(root,'execution/recipe.json'),{recipeType:'webview_workflow',webviewPlan:{schemaVersion:1}});
 assert.equal(hasWebviewOperation(root),false);assert.equal(persistedWebviewOutcome(root),undefined);
 markWebviewOperation(path.join(root,'workflow'),'workflow-learn');assert.equal(hasWebviewOperation(root),true);assert.equal(persistedWebviewOutcome(root),undefined);
});

test('unsafe files and scoped-directory links cannot import a foreign outcome',async t=>{
 for(const kind of ['file-symlink','directory-symlink','hardlink','oversized','malformed','injected','scope-injected'])await t.test(kind,async t=>{
  const root=await home(t),foreign=await home(t),workflow=path.join(root,'workflow');markWebviewOperation(workflow,'workflow-learn');const target=path.join(workflow,'result.json'),other=path.join(foreign,'result.json');await put(other,{webviewOutcome:outcome('unknown')});
  if(kind==='file-symlink')await symlink(other,target);
  if(kind==='directory-symlink'){await rm(workflow,{recursive:true});markWebviewOperation(foreign,'workflow-learn');await symlink(foreign,workflow);}
  if(kind==='hardlink')await link(other,target);
  if(kind==='oversized')await put(target,JSON.stringify({webviewOutcome:outcome('unknown'),padding:'x'.repeat(262144)}));
  if(kind==='malformed')await put(target,'{"webviewOutcome":');
  if(kind==='injected')await put(target,{webviewOutcome:{...outcome('unknown'),url:'DO_NOT_EXPOSE'}});
  if(kind==='scope-injected'){await put(path.join(workflow,'webview-outcome-scope.json'),{schemaVersion:1,kind:'appium-webview-outcome',operation:'workflow-learn',secret:'DO_NOT_EXPOSE'});await put(target,{webviewOutcome:outcome('unknown')});}
  assert.equal(persistedWebviewOutcome(root),undefined);
 });
});

test('scope marking rejects a linked root and unsupported operation without touching foreign files',async t=>{
 const root=await home(t),foreign=await home(t),alias=path.join(root,'alias');await symlink(foreign,alias);assert.throws(()=>markWebviewOperation(alias,'execute'),/WEBVIEW_OUTCOME_SCOPE_INVALID/);assert.throws(()=>markWebviewOperation(root,'browser'),/WEBVIEW_OUTCOME_SCOPE_INVALID/);
 await assert.rejects(readFile(path.join(foreign,'webview-outcome-scope.json')));
});

test('scope marking also rejects an existing or dangling linked marker instead of replacing it',async t=>{
 for(const dangling of [false,true]){
  const root=await home(t),foreign=await home(t),target=path.join(foreign,'marker.json');
  if(!dangling)await put(target,{schemaVersion:1,kind:'appium-webview-outcome',operation:'execute'});
  await symlink(target,path.join(root,'webview-outcome-scope.json'));
  assert.throws(()=>markWebviewOperation(root,'execute'),/WEBVIEW_OUTCOME_SCOPE_INVALID/);
  assert.equal(persistedWebviewOutcome(root),undefined);
 }
});

test('fixed wrapper projection keeps nested API positions safe and leaves user outputs/writeOutcome alone',()=>{
 const value={webviewOutcome:{...outcome('unknown'),completionReceipt:{url:'DO_NOT_EXPOSE'}},result:{webviewOutcome:{...outcome('observed'),completionReceipt:{intentSha256:'DO_NOT_EXPOSE'}},result:{webviewOutcome:outcome('not_started'),outputs:{webviewOutcome:'user text'}}},writeOutcome:outcome('observed')};
 const projected=projectWebviewOutcomeFields(value,{trusted:true});assert(!JSON.stringify(projected).includes('DO_NOT_EXPOSE'));assert.deepEqual(projected.webviewOutcome,outcome('unknown'));assert.deepEqual(projected.result.webviewOutcome,outcome('observed'));assert.equal(projected.result.result.outputs.webviewOutcome,'user text');assert.deepEqual(projected.writeOutcome,outcome('observed'));
 const foreign=projectWebviewOutcomeFields(value);assert.equal(foreign.webviewOutcome,undefined);assert.equal(foreign.result.webviewOutcome,undefined);assert.equal(foreign.result.result.webviewOutcome,undefined);assert.deepEqual(foreign.writeOutcome,outcome('observed'));
});
