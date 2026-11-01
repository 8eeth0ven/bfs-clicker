// Live-only preparation receipts. Values/digests and browser identity handles
// stay in closures and are never checkpoint fields or event payloads.
import {createHash} from 'node:crypto';
import {locate,checkLiveAction} from './discover.js';
import {closedDescriptor} from './closed-shadow.js';

const fail=reason=>{throw Object.assign(new Error(reason),{name:'PolicyError',reason})};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const isTextPreparation=action=>action.type==='text'&&(action.kind==null||action.kind==='click');
export function inputScope(action){
 return hash([action.framePath||[],action.closedShadow?['closed',action.closedShadow.policyId,action.closedShadow.hosts]:['open'],action.formSelector||action.groupSelector||null]);
}
// Bounded raw value crosses the browser boundary only into a private receipt.
function snapshot(element){
 if(!element.isConnected||element.disabled||element.readOnly)return null;
 const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
 if(!rect.width||!rect.height||style.display==='none'||style.visibility!=='visible')return null;
 const value=element.isContentEditable?element.textContent:element.value;
 if(typeof value!=='string'||value.length>4096)return null;
 let characters=0;
 const bounded=row=>{for(const item of row)if(typeof item==='string'){characters+=item.length;if(item.length>1024||characters>16384)return null;}return row;};
 const attributes=['id','name','type','role','aria-label','aria-disabled','aria-readonly','required','readonly','disabled','min','max','step','minlength','maxlength','pattern','contenteditable','form'];
 const semanticAttributes=[];for(const name of attributes){const row=bounded([name,element.getAttribute(name)]);if(!row)return null;semanticAttributes.push(row);}
 const ancestors=[];let node=element.parentElement;
 for(let i=0;node&&i<32;i++,node=node.parentElement){const row=bounded([node.tagName,node.id,node.getAttribute('role'),node.getAttribute('name'),node.getAttribute('action'),node.getAttribute('method')]);if(!row)return null;ancestors.push(row);}
 if(node)return null;
 return {semantic:[element.tagName,semanticAttributes,ancestors],tag:element.tagName.toLowerCase(),type:(element.type||'').toLowerCase(),value};
}
const sameOwner=(element,owner)=>(element.form||element.closest('[role="search"],[data-filter]')||element.getRootNode())===owner;
function ownerSnapshot(owner){
 if(owner.nodeType===9)return {document:true};
 if(owner.nodeType===11){const host=owner.host;if(!host?.isConnected)return null;const semantic=ownerSnapshot(host);return semantic&&{shadowRoot:true,mode:owner.mode,host:semantic};}
 if(!owner.isConnected)return null;
 const attributes=['id','name','role','action','method','enctype','target','accept-charset','novalidate','autocomplete','rel','class','aria-label','hidden','inert'];
 const values=attributes.map(name=>[name,owner.getAttribute(name)]);
 const resolved=owner.tagName==='FORM'?[owner.action,owner.method,owner.enctype,owner.target,!!owner.noValidate]:[];
 let size=0;for(const value of [...values.flat(),...resolved])if(typeof value==='string'){size+=value.length;if(value.length>1024||size>16384)return null;}
 return {tag:owner.tagName,attributes:values,resolved};
}
function actionSnapshot(element){
 if(!element.isConnected)return null;
 const submission={action:element.getAttribute('formaction'),method:element.getAttribute('formmethod'),enctype:element.getAttribute('formenctype'),target:element.getAttribute('formtarget'),noValidate:element.hasAttribute('formnovalidate')};
 if(Object.values(submission).some(value=>typeof value==='string'&&value.length>1024))return null;
 return {tag:element.tagName.toLowerCase(),type:(element.type||'').toLowerCase(),submission};
}
const ownerCss=element=>{
 const owner=element.form||element.closest('[role="search"],[data-filter]');if(!owner)return null;
 const root=owner.getRootNode();if(owner.id&&root.querySelectorAll('#'+CSS.escape(owner.id)).length===1)return '#'+CSS.escape(owner.id);
 const nodes=[];for(let node=owner;node&&node.nodeType===1;node=node.parentElement){let index=1;for(let sibling=node.previousElementSibling;sibling;sibling=sibling.previousElementSibling)if(sibling.tagName===node.tagName)index++;nodes.unshift(node.tagName.toLowerCase()+':nth-of-type('+index+')');}return nodes.join(' > ');
};
export async function beginTextReceipt(page,target,locator,config,value){
 if(typeof value!=='string'||Buffer.byteLength(value)>4096)fail('input_prefix_value_limit');
 if(!target.submission)fail('input_prefix_submission_evidence_missing');
 let handle,owner,group,initial,initialOwner,closed=!!target.closedShadow;
 const expected=hash(value),scope=inputScope(target);
 try{
  if(closed){
   // Existing backend leases pin document, every approved host/root and target.
   // Also pin an explicit form/search-group so a same-name owner replacement
   // cannot inherit this preparation's lease.
   const selector=target.formSelector||target.groupSelector;
   if(selector){
    const prefix='closed::'+target.closedShadow.policyId+'::';
    if(!selector.startsWith(prefix))fail('input_prefix_owner_changed');
    group=locate(page,closedDescriptor({id:target.closedShadow.policyId,hosts:target.closedShadow.hosts},selector.slice(prefix.length)),config);
    if(await group.count()!==1)fail('input_prefix_owner_changed');
    await group.identity();
    initialOwner=await group.evaluate(ownerSnapshot);
    if(!initialOwner)fail('input_prefix_owner_changed');
   }
   initial=await locator.evaluate(snapshot);
  }else{
   handle=await locator.elementHandle({timeout:Math.max(1,Math.min(config.actionTimeoutMs||4000,config._runtime?.budget?.remainingMs??4000))});
   if(!handle)fail('input_prefix_target_changed');
   owner=await handle.evaluateHandle(element=>element.form||element.closest('[role="search"],[data-filter]')||element.getRootNode());
   initial=await handle.evaluate(snapshot);
   initialOwner=await owner.evaluate(ownerSnapshot);
   if(!initialOwner)fail('input_prefix_owner_changed');
  }
  if(!initial)fail('input_prefix_target_changed');
  if(initial.tag!==target.tag||initial.type!==target.htmlType)fail('input_prefix_target_changed');
  const semantic=hash(initial.semantic);
  const ownerSemantic=initialOwner&&hash(initialOwner);
  const verify=async(nextAction)=>{
   config._runtime?.budget?.check();
   const current=await checkLiveAction(page,target,config);
   if(await current.count()!==1)fail('input_prefix_target_changed');
   let observed;
   if(closed){
    if(group){await group.identity();if(hash(await group.evaluate(ownerSnapshot))!==ownerSemantic)fail('input_prefix_owner_changed');const selector=target.formSelector||target.groupSelector,prefix='closed::'+target.closedShadow.policyId+'::';if(await current.evaluate(ownerCss)!==selector.slice(prefix.length))fail('input_prefix_owner_changed');}
    await current.point();observed=await current.evaluate(snapshot);
   }else{
    if(!await current.evaluate((element,pin)=>element===pin,handle)||!await handle.evaluate(sameOwner,owner))fail('input_prefix_target_changed');
    if(hash(await owner.evaluate(ownerSnapshot))!==ownerSemantic)fail('input_prefix_owner_changed');
    observed=await handle.evaluate(snapshot);
   }
   if(!observed||hash(observed.semantic)!==semantic||Buffer.byteLength(observed.value)>4096||hash(observed.value)!==expected)fail('input_prefix_receipt_mismatch');
   if(nextAction){
    if(inputScope(nextAction)!==scope)fail('input_prefix_owner_changed');
    const next=await checkLiveAction(page,nextAction,config);
    if(await next.count()!==1)fail('input_prefix_target_changed');
    const action=await next.evaluate(actionSnapshot);
    if(!action||!nextAction.submission||action.tag!==nextAction.tag||action.type!==nextAction.htmlType||hash(action.submission)!==hash(nextAction.submission))fail('input_prefix_submitter_changed');
    if(closed){const selector=target.formSelector||target.groupSelector;if(selector&&await next.evaluate(ownerCss)!==selector.slice(('closed::'+target.closedShadow.policyId+'::').length))fail('input_prefix_owner_changed');}
    else if(!await next.evaluate(sameOwner,owner))fail('input_prefix_owner_changed');
   }
   config._runtime?.budget?.check();
  };
  return {verify,async dispose(){await Promise.allSettled([handle?.dispose(),owner?.dispose()]);}};
 }catch(error){await Promise.allSettled([handle?.dispose(),owner?.dispose()]);throw error;}
}
