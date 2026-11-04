import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeAriaVirtualLists,createVirtualLedger,virtualOptionSelector,virtualDigest,virtualDomainDigest,validVirtualEvidence} from '../src/aria-virtual-policy.js';
import {normalizeConfig} from '../src/asset.js';import {identity} from '../src/store.js';

const row={id:'cities',selector:'#category',listboxSelector:'#list',scrollSelector:'#list',optionSelector:'#list [role="option"]',maxOptions:12,maxScrolls:12,maxSnapshots:96,timeoutMs:3000};
const policy=normalizeAriaVirtualLists([row])[0];
const options=indices=>indices.map(index=>({index,value:'wire-'+index,label:'City '+index,visible:true}));

test('virtual authority is explicit, finite, exact, and bound to source identity',()=>{
 const plain=normalizeConfig({startUrl:'http://127.0.0.1:1'});assert.deepEqual(plain.ariaVirtualLists,[]);assert.deepEqual(identity(plain),identity({...plain,ariaVirtualLists:undefined}));
 const input={startUrl:'http://127.0.0.1:1',actionProfile:'forms',actionAllowlist:['#category','#list','#list [role="option"]'],requestAllowlist:[{method:'POST',url:'http://127.0.0.1:1/query'}],ariaVirtualLists:[row]},approved=normalizeConfig(input);
 assert.notEqual(identity(approved).policyFingerprint,identity({...approved,ariaVirtualLists:[]}).policyFingerprint);assert.notEqual(identity(approved).policyFingerprint,identity(normalizeConfig({...input,ariaVirtualLists:[{...row,maxScrolls:11}]})).policyFingerprint);
 for(const mutate of [value=>value.ariaVirtualLists[0].maxOptions=201,value=>value.ariaVirtualLists[0].maxScrolls=65,value=>value.ariaVirtualLists[0].maxSnapshots=257,value=>value.ariaVirtualLists[0].timeoutMs=10001,value=>value.ariaVirtualLists[0].framePath=[-1],value=>value.ariaVirtualLists[0].optionSelector='#list [role="option"],button',value=>value.ariaVirtualLists[0].unknown=true,value=>value.ariaVirtualLists.push({...row}),value=>value.actionAllowlist.pop(),value=>value.actionProfile='safe']){const value=structuredClone(input);mutate(value);assert.throws(()=>normalizeConfig(value));}
});

test('logical index/wire ledger permits consistent overlaps and proves the whole finite domain',()=>{
 const ledger=createVirtualLedger(policy);ledger.add({total:6,options:options([1,2,3,4])});ledger.add({total:6,options:options([3,4,5,6])});assert.equal(ledger.complete,true);assert.deepEqual(ledger.finish().map(option=>option.value),['wire-1','wire-2','wire-3','wire-4','wire-5','wire-6']);
 const invisible=createVirtualLedger(policy);invisible.add({total:2,options:options([1,2]).map(option=>({...option,visible:false}))});assert.equal(invisible.complete,false);assert.throws(()=>invisible.finish(),{code:'ARIA_VIRTUAL_DOMAIN_INCOMPLETE'});
});

test('duplicate indices/wires, missing positions, changed size and prefix label drift never form a domain',()=>{
 for(const snapshot of [{total:2,options:options([1,1])},{total:2,options:[options([1])[0],{...options([2])[0],value:'wire-1'}]},{total:-1,options:options([1])},{total:13,options:options([1])},{total:2,options:[{...options([1])[0],index:0}]}])assert.throws(()=>createVirtualLedger(policy).add(snapshot));
 for(const replacement of [{total:3,options:options([1])},{total:2,options:[{...options([1])[0],label:'City 10'}]},{total:2,options:[{...options([2])[0],value:'wire-1'}]}]){const ledger=createVirtualLedger(policy);ledger.add({total:2,options:options([1])});assert.throws(()=>ledger.add(replacement));}
 const missing=createVirtualLedger(policy);missing.add({total:3,options:options([1,3])});assert.equal(missing.complete,false);assert.throws(()=>missing.finish());
 assert.equal(virtualOptionSelector(policy,'a"b\\c]'),'#list [role="option"][data-value="a\\"b\\\\c]"]');assert.throws(()=>virtualOptionSelector(policy,'bad\nwire'));
});

test('offline evidence needs exact complete domain, local policy, bounded scan event and successful open id',()=>{
 const ledger=createVirtualLedger(policy);ledger.add({total:3,options:options([1,2,3])});const domain=ledger.finish(),contract={control:{id:'category'},listbox:{id:'list'},scroll:{id:'list'}},executionId='open_1';
 const certificate={evidenceId:'scan_1',executionId,domainDigest:virtualDomainDigest(domain),contractDigest:virtualDigest(contract),policyDigest:virtualDigest(policy)},choices={complete:true,domainEvidence:'bounded_virtual_scan',options:domain,listbox:{selector:'#list'},virtual:{policyId:'cities',contract},certificate},event={kind:'aria_virtual_domain_complete',evidenceId:'scan_1',executionId,selector:'#category',framePath:[],policyId:'cities',...certificate,total:3,atPhysicalEnd:true,scrolls:4,snapshots:12};
 const config={ariaVirtualLists:[policy]},target={selector:'#category',framePath:[]};assert.equal(validVirtualEvidence(choices,event,config,target,executionId),true);
 for(const altered of [undefined,{...event,executionId:'another'},{...event,total:4},{...event,atPhysicalEnd:false},{...event,scrolls:100},{...event,snapshots:1000},{...event,framePath:[0]}])assert.equal(validVirtualEvidence(choices,altered,config,target,executionId),false);
 assert.equal(validVirtualEvidence({...choices,options:domain.slice(1)},event,config,target,executionId),false);assert.equal(validVirtualEvidence(choices,event,{ariaVirtualLists:[{...policy,maxScrolls:11}]},target,executionId),false);
});
