import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {normalizeConfig} from '../src/asset.js';
import {createPolicy} from '../src/policy.js';
import {normalizeWorkflowPermissions, assertWorkflowPermission} from '../src/workflow-permissions.js';
import {createSoftwareRuntime} from '../src/software-runtime.js';
import {temp} from './helpers.mjs';

test('workflow write execution and live learning require separate exact startup grants', () => {
  assert.deepEqual(normalizeWorkflowPermissions(), {allowWrite:[], allowWriteLearning:[]});
  assert.throws(() => assertWorkflowPermission({}, 'create_note'), {code:'WORKFLOW_WRITE_NOT_APPROVED', writeOutcome:{status:'not_started', automaticRetry:false}});
  const executionOnly = {allowWrite:['create_note']};
  assert.doesNotThrow(() => assertWorkflowPermission(executionOnly, 'create_note'));
  assert.throws(() => assertWorkflowPermission(executionOnly, 'create_note', {learning:true}), {code:'WORKFLOW_WRITE_LEARNING_NOT_APPROVED'});
  assert.throws(() => assertWorkflowPermission(executionOnly, 'update_note'), {code:'WORKFLOW_WRITE_NOT_APPROVED'});
  assert.doesNotThrow(() => assertWorkflowPermission({...executionOnly, allowWriteLearning:['create_note']}, 'create_note', {learning:true}));
  for (const value of [null, [], true, {write:true}, {allowWrite:null}, {allowWrite:['*']}, {allowWrite:['__proto__']}, {allowWrite:['create_note'],allowWriteLearning:['update_note']}, {allowWrite:Array(101).fill('create_note')}]) assert.throws(() => normalizeWorkflowPermissions(value), {code:'WORKFLOW_PERMISSIONS_INVALID'});
});

test('startup permissions are bounded and captured per source in the private runtime configuration', t => {
  const dir = temp(t), options = {outputRoot:path.join(dir, 'out'), artifactRoots:[dir]};
  const runtime = createSoftwareRuntime({...options, workflowPermissions:{notes:{allowWrite:['create_note'],allowWriteLearning:['create_note']}}});
  assert.deepEqual(runtime.config.workflowPermissions.notes.allowWrite, ['create_note']);
  const unapproved = createSoftwareRuntime(options);
  assert.notEqual(runtime.runtimeFile, unapproved.runtimeFile);
  assert.deepEqual(unapproved.config.workflowPermissions, {});
  for (const value of [null, [], {notes:{allowWrite:['*']}}, {notes:{allowWriteLearning:['create_note']}}, {constructor:{allowWrite:['create_note']}}]) assert.throws(() => createSoftwareRuntime({...options, workflowPermissions:value}));
});

test('an approved SPA write selector is unavailable to discovery and read workflows', () => {
  const origin = 'http://127.0.0.1:3100';
  const config = normalizeConfig({startUrl:origin, actionProfile:'forms', actionAllowlist:['#title','#save'], writeActionAllowlist:['#save'], requestAllowlist:[{method:'POST',url:origin+'/notes'}]});
  const policy = createPolicy(config), button = {selector:'#save',text:'保存',tag:'button',kind:'click',type:'click'};
  assert.equal(policy.action(button).reason, 'write_workflow_required');
  config._runtime = {workflowActive:true,workflowEffect:'read'};
  assert.equal(policy.action(button).allow, false);
  config._runtime.workflowEffect = 'write';
  assert.equal(policy.action(button).allow, true);
  assert.equal(policy.action({...button, selector:'#other'}).allow, false);
  assert.equal(policy.action({...button, excluded:true}).allow, false);
  assert.equal(policy.action({...button,text:'退出登录'}).allow, false);
  assert.equal(policy.action({...button,text:'删除账号'}).allow, false);
  assert.equal(policy.request({url:origin+'/notes',method:'POST',type:'fetch'}).allow, true);
  assert.equal(policy.request({url:origin+'/other',method:'POST',type:'fetch'}).allow, false);
  config.writeActionAllowlist.push('#title');
  config._runtime.workflowEffect = 'read';
  assert.equal(policy.action({selector:'#title',tag:'input',type:'text'}).reason, 'write_workflow_required', 'autosaving inputs can also be limited to write workflows');
  config._runtime.workflowEffect = 'write';
  assert.equal(policy.action({selector:'#title',tag:'input',type:'text'}).allow, true);
});

test('write selectors need the original forms and endpoint policy and cannot be introduced by MCP discovery options', async t => {
  const origin = 'http://127.0.0.1:3100';
  for (const options of [{writeActionAllowlist:['#save']}, {actionProfile:'forms',requestAllowlist:[{method:'POST',url:origin+'/notes'}],writeActionAllowlist:['#save']}, {actionProfile:'forms',requestAllowlist:[{method:'POST',url:origin+'/notes'}],actionAllowlist:['#save'],writeActionAllowlist:[null]}]) assert.throws(() => normalizeConfig({startUrl:origin,...options}));
  const dir = temp(t), runtime = createSoftwareRuntime({outputRoot:path.join(dir,'out'),artifactRoots:[dir]});
  await assert.rejects(runtime.discover({kind:'web',input:origin,sourceId:'notes',webOptions:{writeActionAllowlist:['#save']}},path.join(dir,'discovery')), /不支持的webOptions字段/);
});
