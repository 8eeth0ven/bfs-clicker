import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {normalizeConfig} from '../src/asset.js';
import {identity,openStore} from '../src/store.js';
import {createSoftwareRuntime} from '../src/software-runtime.js';
import {assertClosedStagePermission} from '../src/workflow-permissions.js';
import {temp} from './helpers.mjs';
const roots=[{id:'lookup',hosts:['#lookup-widget'],maxNodes:128}];
const base={startUrl:'https://example.test/',runId:'fixed',authProfileId:'fixed',closedShadowRoots:roots};
const configured=(workflowId='auto_lookup',extra={})=>normalizeConfig({...base,closedStagePlanning:{workflowId},...extra});
test('closed stage planning is an explicit startup setting, copied without granting execution',()=>{
 const value={workflowId:'auto_lookup'},config=normalizeConfig({...base,closedStagePlanning:value});
 assert.deepEqual(config.closedStagePlanning,value);assert.notEqual(config.closedStagePlanning,value);
 value.workflowId='changed';assert.equal(config.closedStagePlanning.workflowId,'auto_lookup');
 assert.throws(()=>assertClosedStagePermission({},'auto_lookup'),{code:'WORKFLOW_CLOSED_STAGES_NOT_APPROVED'});
 assert.doesNotThrow(()=>assertClosedStagePermission({allowClosedStages:['auto_lookup']},'auto_lookup'));
 assert.deepEqual(normalizeConfig(JSON.parse(JSON.stringify(config))).closedStagePlanning,{workflowId:'auto_lookup'});
});
test('planning rejects an unbounded shape or workflow ID and requires a closed root',()=>{
 const invalid=[null,true,0,'auto_lookup',[],{}, {workflowId:''},{workflowId:2},{workflowId:'*'},
  {workflowId:'__proto__'},{workflowId:'constructor'},{workflowId:'prototype'},
  {workflowId:'a'.repeat(129)},{workflowId:'two words'},{workflowId:'valid',enabled:true}];
 for(const closedStagePlanning of invalid)assert.throws(()=>normalizeConfig({...base,closedStagePlanning}),/CLOSED_STAGE_PLANNING_INVALID/);
 assert.throws(()=>configured('valid',{closedShadowRoots:[]}),/CLOSED_STAGE_PLANNING_INVALID/);
 for(const workflowId of ['0','a'.repeat(128),'lookup.v1-test_2'])assert.equal(configured(workflowId).closedStagePlanning.workflowId,workflowId);
});
test('the absent setting preserves both published legacy policy fingerprints',()=>{
 for(const [closedShadowRoots,expected]of [[[],'c4f7f4ecb99bb7e31a539baf105723fce451a3894da0ac2e0e3b48eddfe5c026'],[roots,'cd316369aae9b8ea68c2df1be6d5690e21a887de0467556798defc8e44d72ece']]){
  const legacy=normalizeConfig({...base,closedShadowRoots}),explicitUndefined=normalizeConfig({...base,closedShadowRoots,closedStagePlanning:undefined});
  assert.equal(Object.hasOwn(legacy,'closedStagePlanning'),false);assert.equal(Object.hasOwn(explicitUndefined,'closedStagePlanning'),false);
  assert.equal(identity(legacy).policyFingerprint,expected);assert.deepEqual(identity(explicitUndefined),identity(legacy));
 }
});
test('the planning workflow ID binds policy identity and cannot be changed by resume',t=>{
 const a=configured(),b=configured('different_lookup'),off=normalizeConfig(base);
 assert.notEqual(identity(a).policyFingerprint,identity(b).policyFingerprint);assert.notEqual(identity(a).policyFingerprint,identity(off).policyFingerprint);
 assert.equal(identity(a).scopeFingerprint,identity(off).scopeFingerprint);
 const dir=temp(t),config={...a,outputDir:dir},store=openStore(config);store.save({states:[],frontier:[]});store.release();
 for(const next of [b,off])assert.throws(()=>openStore({...next,outputDir:dir},true),/resume 不兼容: policyFingerprint/);
 const resumed=openStore(config,true);resumed.release();
});
test('MCP webOptions cannot enable or replace a startup stage-planning grant',async t=>{
 const dir=temp(t),runtime=createSoftwareRuntime({outputRoot:path.join(dir,'out'),artifactRoots:[dir],webConfig:{closedShadowRoots:roots,closedStagePlanning:{workflowId:'auto_lookup'}}});
 for(const workflowId of ['auto_lookup','other'])await assert.rejects(runtime.discover({kind:'web',input:base.startUrl,sourceId:'unstarted',webOptions:{closedStagePlanning:{workflowId}}},path.join(dir,'unstarted')),/不支持的webOptions字段: closedStagePlanning/);
});
