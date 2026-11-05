// Bind logical result targets to every observed native branch before learning.
// Physical selectors always come from the planner's private, proved paths.
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const name=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
const clone=value=>JSON.parse(JSON.stringify(value));
const need=(condition,code='NATIVE_BRANCH_BINDING_INVALID')=>{if(!condition)throw new Error(code);};

export function nativeBranchParameters(spec){
 const plan=spec?.branchPlan,properties=spec?.inputSchema?.properties;
 need(plain(plan)&&plan.schemaVersion===1&&plain(properties));
 const parameters=Object.keys(properties);
 need(parameters.length>=1&&parameters.length<=16&&parameters.every(name));
 need(Array.isArray(plan.arms)&&plan.arms.length===2&&plan.arms.every(arm=>plain(arm)&&name(arm.id)));
 const ids=plan.arms.map(arm=>arm.id);
 need(new Set(ids).size===2&&name(plan.branchInput)&&Object.hasOwn(properties,plan.branchInput));
 const route=properties[plan.branchInput],values=plan.arms.map(arm=>arm.value);
 const domain=route?.type==='boolean'?[false,true]:route?.type==='string'?route.enum:null;
 need(Array.isArray(domain)&&domain.length===2&&new Set(domain).size===2&&values.every(value=>domain.includes(value))&&new Set(values).size===2);
 for(const arm of plan.arms){
  const child=arm.definition,map=arm.inputMap,local=child?.inputSchema?.properties;
  need(plain(child)&&child.schemaVersion===1&&child.effect==='read'&&Array.isArray(child.steps)&&child.steps.length>=3&&child.steps.length<=30&&plain(local)&&plain(map));
  need(Object.keys(map).length===parameters.length&&parameters.every(parameter=>Object.hasOwn(map,parameter)&&name(map[parameter])&&Object.hasOwn(local,map[parameter])));
  need(Object.keys(local).length===parameters.length&&new Set(Object.values(map)).size===parameters.length);
 }
 return parameters;
}

export function bindNativeBranchResults(spec,mappings){
 const parameters=nativeBranchParameters(spec);
 need(spec.effect==='read'&&Array.isArray(mappings)&&mappings.length>=1&&mappings.length<=32);
 need(parameters.every(parameter=>mappings.some(({rule})=>rule?.param===parameter)),'WORKFLOW_ASSERTION_REQUIRED');
 const arms=spec.branchPlan.arms,ids=arms.map(arm=>arm.id);
 const targets=[];
 for(const mapping of mappings){
  const {rule,target}=mapping;
  need(plain(rule)&&parameters.includes(rule.param)&&plain(target)&&typeof target.id==='string');
  if(rule.representation&&rule.representation!=='value'||rule.valueMap!==undefined||rule.separator!==undefined)throw new Error('WORKFLOW_REPRESENTATION_UNSUPPORTED');
  need(rule.changedFromBefore===undefined||rule.changedFromBefore===true,'NATIVE_BRANCH_FRESHNESS_REQUIRED');
  need(plain(target.armTargets)&&Object.keys(target.armTargets).length===2&&ids.every(id=>Object.hasOwn(target.armTargets,id)&&plain(target.armTargets[id])&&plain(target.armTargets[id].selector)));
  if(!targets.some(item=>item.id===target.id))targets.push(target);
 }
 // Validate both arms completely before mutating either one.
 const bound=clone(spec);
 for(const arm of bound.branchPlan.arms){
  for(const {rule,target} of mappings){
   arm.definition.steps.push({kind:'assert',selector:clone(target.armTargets[arm.id].selector),expect:{containsInput:arm.inputMap[rule.param],changed:true},timeoutMs:rule.timeoutMs??5000});
  }
  for(const [index,target] of targets.entries())arm.definition.steps.push({kind:'extract',selector:clone(target.armTargets[arm.id].selector),output:targets.length===1?'result':'result_'+(index+1),valueType:'string'});
  need(arm.definition.steps.length<=30,'WORKFLOW_SPEC_LIMIT');
  delete arm.definition.outcomeCandidates;
 }
 delete bound.outcomeCandidates;
 return bound;
}
