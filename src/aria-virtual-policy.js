// Fixed local authority and pure finite-domain evidence. No browser or I/O here.
import {createHash} from 'node:crypto';

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const stable=value=>Array.isArray(value)?value.map(stable):plain(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
export const virtualDigest=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export const virtualFail=code=>{throw Object.assign(new Error(code),{code});};
const frame=value=>Array.isArray(value)&&value.length<=12&&value.every(n=>Number.isSafeInteger(n)&&n>=0);
const selector=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\x00-\x1f\x7f,]|>>/.test(value);
const wire=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\x00-\x1f\x7f]/.test(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const keys=new Set(['id','selector','framePath','listboxSelector','scrollSelector','optionSelector','valueAttribute','maxOptions','maxScrolls','maxSnapshots','timeoutMs']);

export function normalizeAriaVirtualLists(input=[]){
  if(!Array.isArray(input)||input.length>8)virtualFail('ARIA_VIRTUAL_CONFIG_INVALID');
  const ids=new Set(),controls=new Set();
  return input.map(raw=>{
    if(!plain(raw)||Object.keys(raw).some(key=>!keys.has(key))||typeof raw.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(raw.id)||ids.has(raw.id))virtualFail('ARIA_VIRTUAL_CONFIG_INVALID');
    const policy={...raw,framePath:raw.framePath??[],valueAttribute:raw.valueAttribute??'data-value',maxOptions:raw.maxOptions??200,maxScrolls:raw.maxScrolls??32,maxSnapshots:raw.maxSnapshots??128,timeoutMs:raw.timeoutMs??5000};
    if(!frame(policy.framePath)||!['data-value','value'].includes(policy.valueAttribute)||!['selector','listboxSelector','scrollSelector','optionSelector'].every(key=>selector(policy[key]))||policy.optionSelector!==policy.listboxSelector+' [role="option"]'||!integer(policy.maxOptions,1,200)||!integer(policy.maxScrolls,1,64)||!integer(policy.maxSnapshots,2,256)||!integer(policy.timeoutMs,1,10000))virtualFail('ARIA_VIRTUAL_CONFIG_INVALID');
    const key=JSON.stringify([policy.framePath,policy.selector]);if(controls.has(key))virtualFail('ARIA_VIRTUAL_CONFIG_INVALID');
    ids.add(policy.id);controls.add(key);return structuredClone(policy);
  });
}

export function virtualPolicyFor(config,target){
  return (config.ariaVirtualLists||[]).find(policy=>policy.selector===target.selector&&virtualDigest(policy.framePath)===virtualDigest(target.framePath||[]))||null;
}

export function assertVirtualApproval(config,policy){
  if(config.actionProfile!=='forms'||!config.requestAllowlist?.length||![policy.selector,policy.scrollSelector,policy.optionSelector].every(value=>config.actionAllowlist?.includes(value)))virtualFail('ARIA_VIRTUAL_NOT_APPROVED');
}

export function virtualOptionSelector(policy,value){
  if(!wire(value))virtualFail('ARIA_VIRTUAL_WIRE_INVALID');
  return policy.optionSelector+'['+policy.valueAttribute+'="'+value.replace(/[\\"]/g,'\\$&')+'"]';
}

export function virtualDomainDigest(options){
  return virtualDigest(options.map(({index,value,label,selector})=>({index,value,label,selector})));
}

export function createVirtualLedger(policy){
  let size=null;const positions=new Map(),values=new Map(),visible=new Set();
  return {
    add(snapshot){
      if(!plain(snapshot)||!integer(snapshot.total,1,policy.maxOptions)||!Array.isArray(snapshot.options)||!snapshot.options.length||snapshot.options.length>policy.maxOptions)virtualFail('ARIA_VIRTUAL_DOMAIN_INVALID');
      if(size!==null&&size!==snapshot.total)virtualFail('ARIA_VIRTUAL_DOMAIN_CHANGED');size=snapshot.total;
      const localPositions=new Set(),localValues=new Set();
      for(const option of snapshot.options){
        if(!plain(option)||!integer(option.index,1,size)||!wire(option.value)||typeof option.label!=='string'||!option.label||option.label.length>512||typeof option.visible!=='boolean'||localPositions.has(option.index)||localValues.has(option.value))virtualFail('ARIA_VIRTUAL_DOMAIN_INVALID');
        localPositions.add(option.index);localValues.add(option.value);
        const item={index:option.index,value:option.value,label:option.label,selector:virtualOptionSelector(policy,option.value)},previous=positions.get(item.index);
        if(previous&&virtualDigest(previous)!==virtualDigest(item)||values.has(item.value)&&values.get(item.value)!==item.index)virtualFail('ARIA_VIRTUAL_DOMAIN_CHANGED');
        positions.set(item.index,item);values.set(item.value,item.index);if(option.visible)visible.add(item.index);
      }
      if(Buffer.byteLength(JSON.stringify([...positions.values()]))>98304)virtualFail('ARIA_VIRTUAL_DOMAIN_LIMIT');
    },
    get complete(){return size!==null&&positions.size===size&&visible.size===size;},
    finish(){if(!this.complete)virtualFail('ARIA_VIRTUAL_DOMAIN_INCOMPLETE');return [...positions.values()].sort((a,b)=>a.index-b.index);},
  };
}

export function validVirtualEvidence(choices,event,config,target,executionId){
  try{
    const policy=virtualPolicyFor(config,target),certificate=choices?.certificate,options=choices?.options;
    if(!policy||choices.complete!==true||choices.domainEvidence!=='bounded_virtual_scan'||choices.virtual?.policyId!==policy.id||choices.listbox?.selector!==policy.listboxSelector||!plain(certificate)||!Array.isArray(options)||!options.length||options.length>policy.maxOptions||!plain(event))return false;
    const ledger=createVirtualLedger(policy);ledger.add({total:options.length,options:options.map(option=>({...option,visible:true}))});
    if(!ledger.complete||virtualDigest(ledger.finish())!==virtualDigest(options)||certificate.domainDigest!==virtualDomainDigest(options)||certificate.policyDigest!==virtualDigest(policy)||certificate.contractDigest!==virtualDigest(choices.virtual.contract))return false;
    if(event.kind!=='aria_virtual_domain_complete'||event.evidenceId!==certificate.evidenceId||event.executionId!==executionId||certificate.executionId!==executionId||event.selector!==target.selector||virtualDigest(event.framePath)!==virtualDigest(target.framePath||[])||event.policyId!==policy.id||event.domainDigest!==certificate.domainDigest||event.contractDigest!==certificate.contractDigest||event.policyDigest!==certificate.policyDigest||event.total!==options.length||event.atPhysicalEnd!==true||!integer(event.scrolls,1,policy.maxScrolls)||!integer(event.snapshots,1,policy.maxSnapshots))return false;
    return true;
  }catch{return false;}
}
