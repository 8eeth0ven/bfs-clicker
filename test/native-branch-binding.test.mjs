import test from 'node:test';
import assert from 'node:assert/strict';
import {bindNativeBranchResults} from '../src/native-branch-binding.js';
import {capabilityFidelity} from '../src/capability-fidelity.js';

function candidate(){
 const properties={route:{type:'string',enum:['east','west']},query:{type:'string',maxLength:2048}};
 return {schemaVersion:1,id:'query',effect:'read',inputSchema:{type:'object',properties,required:['route','query'],additionalProperties:false},branchPlan:{schemaVersion:1,branchInput:'route',forkStageIndex:0,arms:['east','west'].map(id=>({id,value:id,inputMap:{route:'route_'+id,query:'query_'+id},definition:{schemaVersion:1,id:'query_'+id,effect:'read',inputSchema:{type:'object',properties:{['route_'+id]:properties.route,['query_'+id]:properties.query},required:['route_'+id,'query_'+id],additionalProperties:false},steps:[{kind:'select',input:'route_'+id,selector:{resourceId:id+'_route'}},{kind:'type',input:'query_'+id,replace:true,selector:{resourceId:id+'_query'}},{kind:'click',selector:{resourceId:id+'_search'}}],outcomeCandidates:[{id:id+'_result',selector:{resourceId:id+'_result'}}]}}))},outcomeCandidates:[{id:'logical_result',armTargets:{east:{selector:{resourceId:'east_result'}},west:{selector:{resourceId:'west_result'}}}}]};
}
const mappings=spec=>['route','query'].map(param=>({rule:{param,changedFromBefore:true},target:spec.outcomeCandidates[0]}));

test('logical result assertions bind each arm to its own inputs and selector',()=>{
 const spec=candidate(),before=structuredClone(spec),bound=bindNativeBranchResults(spec,mappings(spec));
 assert.deepEqual(spec,before);
 assert.equal(Object.hasOwn(bound,'outcomeCandidates'),false);
 for(const arm of bound.branchPlan.arms){
  assert.deepEqual(arm.definition.steps.slice(3).map(step=>[step.kind,step.selector.resourceId,step.expect?.containsInput,step.output]),[['assert',arm.id+'_result','route_'+arm.id,undefined],['assert',arm.id+'_result','query_'+arm.id,undefined],['extract',arm.id+'_result',undefined,'result']]);
  assert.equal(Object.hasOwn(arm.definition,'outcomeCandidates'),false);
 }
});

test('missing arm target and incomplete parameter evidence fail without mutating paths',()=>{
 const spec=candidate(),before=structuredClone(spec);
 assert.throws(()=>bindNativeBranchResults(spec,mappings(spec).slice(1)),/WORKFLOW_ASSERTION_REQUIRED/);
 delete spec.outcomeCandidates[0].armTargets.west;
 const missing=structuredClone(spec);
 assert.throws(()=>bindNativeBranchResults(spec,mappings(spec)),/NATIVE_BRANCH_BINDING_INVALID/);
 assert.deepEqual(spec,missing);
 assert.deepEqual(spec.branchPlan,before.branchPlan);
});

test('invalid or non-bijective maps and third route values cannot be bound',()=>{
 for(const mutate of [spec=>{spec.branchPlan.arms[1].inputMap.query='route_west'},spec=>{spec.branchPlan.arms[1].value='north'},spec=>{spec.branchPlan.arms[1].id='east'}]){
  const spec=candidate();mutate(spec);
  assert.throws(()=>bindNativeBranchResults(spec,mappings(spec)),/NATIVE_BRANCH_BINDING_INVALID/);
 }
});

test('branch result freshness defaults to required and cannot be disabled',()=>{
 const spec=candidate(),rules=mappings(spec).map(({rule,target})=>({rule:{param:rule.param},target}));
 const bound=bindNativeBranchResults(spec,rules);
 assert(bound.branchPlan.arms.every(arm=>arm.definition.steps.filter(step=>step.kind==='assert').every(step=>step.expect.changed===true)));
 rules[0].rule.changedFromBefore=false;
 assert.throws(()=>bindNativeBranchResults(spec,rules),/NATIVE_BRANCH_FRESHNESS_REQUIRED/);
});

test('branch fidelity reports the common logical provider guarantee',()=>{
 const spec=candidate(),bound=bindNativeBranchResults(spec,mappings(spec));
 const metadata=capabilityFidelity({adapter:'mobile-workflow',recipe:{schemaVersion:1,recipeType:'workflow',definition:bound},device:{backend:{type:'webdriver',platform:'android'}},sourceKind:'apk'});
 assert.deepEqual(metadata.modality.channels,['fixed_ui_actions','native_semantic']);
 assert.deepEqual(metadata.fidelity.inputText.map(input=>[input.parameter,input.contract]),[['query','provider_codepoint_echo_required']]);
 assert.deepEqual(metadata.fidelity.outputs,[{name:'result',contract:'semantic_provider_text_projection',sourceCodepointsProven:false}]);
 assert(metadata.fidelity.limits.includes('native_branch_each_arm_requires_two_observed_samples'));
});

test('an unsupported or weaker arm cannot borrow the other arm fidelity',()=>{
 for(const mutate of [definition=>{definition.branchPlan.arms[1].definition.steps[1].replace=false},definition=>{definition.branchPlan.arms[1].definition.steps.push({kind:'launch'})},definition=>{definition.branchPlan.arms[1].definition.steps.at(-1).output='other_result'},definition=>{definition.branchPlan.arms[1].definition.branchPlan={schemaVersion:1}}]){
  const spec=candidate(),bound=bindNativeBranchResults(spec,mappings(spec));mutate(bound);
  const metadata=capabilityFidelity({adapter:'mobile-workflow',recipe:{schemaVersion:1,recipeType:'workflow',definition:bound},device:{backend:{type:'webdriver',platform:'ios'}},sourceKind:'ios'});
  assert.deepEqual(metadata.modality.channels,['unknown']);
 }
});
