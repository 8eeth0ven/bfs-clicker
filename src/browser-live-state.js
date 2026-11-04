// Exploration leases are process-local. No values, digests or browser handles
// are serializable permissions; a checkpoint can only record that a lease died.
import {createHash} from 'node:crypto';
import {locate,checkLiveAction,frameFor} from './discover.js';
import {closedDescriptor,closedExplorationIdentity} from './closed-shadow.js';
const fail=()=>{throw Object.assign(new Error('live_state_unavailable'),{name:'PolicyError',reason:'live_state_unavailable'})};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const timeout=config=>Math.max(1,Math.min(config.actionTimeoutMs||4000,config._runtime?.budget?.remainingMs??4000));

// The returned value is bounded before crossing the browser boundary. These
// semantics include external form owners and open-root hosts, not just CSS ids.
function controlSnapshot(element){
 if(!element.isConnected)return null;
 const attributes=['id','name','type','role','class','href','action','method','enctype','target','form','formaction','formmethod','formenctype','formtarget','formnovalidate','aria-label','aria-controls','aria-disabled','aria-readonly','aria-hidden','hidden','inert','required','readonly','disabled','min','max','step','minlength','maxlength','pattern','contenteditable'];
 let size=0;const row=node=>{const values=[node.tagName,...attributes.map(name=>node.getAttribute(name))];for(const value of values)if(typeof value==='string'){size+=value.length;if(value.length>4096||size>65536)return null;}return values;};
 const chain=[];let node=element;
 for(let i=0;node&&i<32;i++,node=node.parentElement||node.getRootNode()?.host||null){const item=row(node);if(!item)return null;chain.push(item);}if(node)return null;
 const owner=element.form||element.closest('[role="search"],[data-filter]');
 const ownerRow=owner&&row(owner);if(owner&&!ownerRow)return null;
 const value=element.isContentEditable?element.textContent:element.value??null;
 const text=element.tagName==='BUTTON'||element.tagName==='A'?element.textContent:null;
 if(typeof value==='string'&&value.length>4096||typeof text==='string'&&text.length>4096)return null;
 return {chain,owner:ownerRow,resolved:owner?.tagName==='FORM'?[owner.action,owner.method,owner.enctype,owner.target,!!owner.noValidate]:null,value,text,checked:!!element.checked};
}
const ownerFor=element=>element.form||element.closest('[role="search"],[data-filter]')||element.getRootNode();

// Pin the exact primitive before dispatch. A locator replacement must never
// become an authorized click merely by retaining the old label/selector.
export async function beginLiveTransition(page,action,config,{element:originalElement=null,priorActions=[]}={}){
 config._runtime?.budget?.check();const locator=action.kind==='scroll'?null:await checkLiveAction(page,action,config);
 let element=null,ended=false,invalid=false,requested=false,committed=false;
 if(action.kind!=='scroll'&&!action.closedShadow){element=originalElement||await locator.elementHandle({timeout:timeout(config)});if(!element||!await locator.evaluate((node,pin)=>node===pin,element))fail();}
 // checkLiveAction's closed evaluation already establishes its exact pin.
 let ingress,closedIdentity,identityElement,predecessors=[];
 try{ingress=locator&&digest(await (element||locator).evaluate(controlSnapshot));closedIdentity=action.closedShadow?await closedExplorationIdentity(page,action,config):null;identityElement=originalElement?await originalElement.evaluateHandle(node=>node):element;for(const prior of priorActions){
   if(prior.id===action.id||prior.skipped||prior.status==='skipped'||prior.kind==='scroll'||predecessors.some(item=>item.id===prior.id))continue;
   config._runtime?.budget?.check();const previous=locate(page,prior,config);if(await previous.count()!==1)fail();
   const handle=prior.closedShadow?null:await previous.elementHandle({timeout:timeout(config)});if(!prior.closedShadow&&!handle)fail();
   let previousValue,identity;try{previousValue=await (handle||previous).evaluate(controlSnapshot);if(!previousValue)fail();identity=prior.closedShadow?await closedExplorationIdentity(page,prior,config):null;}catch(error){await handle?.dispose();throw error;}
   const expected=digest(previousValue),id=prior.id;
   predecessors.push({id,async matches(next,node,observed){if(next.id!==id||digest(observed)!==expected)return false;try{return identity?await identity(next):!!node&&await node.evaluate((current,old)=>current===old,handle);}catch{return false;}},async dispose(){await handle?.dispose();}});
  }}
 catch(error){await Promise.allSettled(predecessors.map(pin=>pin.dispose()));if(originalElement)await identityElement?.dispose();else await element?.dispose();throw error;}
 const onPopup=()=>{invalid=true};
 const onRequest=request=>{if(request.isNavigationRequest()&&request.frame()===page.mainFrame())requested=true;};
 const onNavigation=frame=>{if(frame!==page.mainFrame()||ended)invalid=true;else committed=true;};
 page.on('popup',onPopup);page.on('request',onRequest);page.on('framenavigated',onNavigation);
 const dispose=async()=>{page.off('popup',onPopup);page.off('request',onRequest);page.off('framenavigated',onNavigation);await Promise.allSettled(predecessors.map(pin=>pin.dispose()));if(originalElement)await identityElement?.dispose();else await element?.dispose();};
 return {element,async finish(){
  config._runtime?.budget?.check();if(invalid||page.isClosed())fail();
  // Mouse-based closed primitives do not implicitly wait for a scheduled load.
  // A known main-frame request may finish within the original action budget.
  if(requested&&!committed)await page.waitForEvent('framenavigated',{predicate:frame=>frame===page.mainFrame(),timeout:timeout(config)});
  if(requested)await page.waitForLoadState('domcontentloaded',{timeout:timeout(config)});
  ended=true;if(invalid)fail();
  const decision=config._policy?.navigation(page.url());if(decision&&!decision.allow)fail();
  const guard=await pinDocument(page,config,()=>invalid);
  return {guard,invalid:()=>invalid,async sameIngress(next,pin,observed){
   for(const predecessor of predecessors)if(await predecessor.matches(next,pin,observed))return true;
   if(next.kind!==action.kind||next.id!==action.id||digest(observed)!==ingress)return false;
   try{return closedIdentity?await closedIdentity(next):!!identityElement&&!!pin&&await pin.evaluate((node,old)=>node===old,identityElement);}catch{return false;}
  }};
 },dispose};
}

async function pinDocument(page,config,invalid=()=>false){
 const context=page.context(),url=page.url(),document=await page.evaluateHandle(()=>document),body=await page.evaluateHandle(()=>document.body);
 let dead=false;
 return {async verify(){config._runtime?.budget?.check();if(dead||invalid()||page.isClosed()||page.context()!==context||page.url()!==url||!await page.evaluate(({doc,body})=>document===doc&&document.body===body,{doc:document,body}))fail();},async dispose(){dead=true;await Promise.allSettled([document.dispose(),body.dispose()]);}};
}

export async function bindLiveState(page,state,config,post){
 const pins=new Map(),frames=new Map(),deferred=new Set();let dead=false,drift=false;
 const changed=()=>{drift=true};page.on('framenavigated',changed);page.on('popup',changed);
 const guard=post?.guard||await pinDocument(page,config);
 const dispose=async()=>{dead=true;page.off('framenavigated',changed);page.off('popup',changed);await Promise.allSettled([...pins.values()].flatMap(pin=>[pin.element?.dispose(),pin.owner?.dispose()]));await Promise.allSettled([...frames.values()].map(value=>value.dispose()));await guard.dispose();};
 try{
  for(const action of state.interactives){
   if(action.skipped||action.status==='skipped'||action.kind==='scroll'||pins.has(action.id))continue;
   config._runtime?.budget?.check();const locator=await checkLiveAction(page,action,config);let element,owner,group;
   if(action.closedShadow){const selector=action.formSelector||action.groupSelector;if(selector){const prefix='closed::'+action.closedShadow.policyId+'::';if(!selector.startsWith(prefix))fail();group=locate(page,closedDescriptor({id:action.closedShadow.policyId,hosts:action.closedShadow.hosts},selector.slice(prefix.length)),config);await group.identity();}}
   else{
    const frame=frameFor(page,action);if(!frames.has(frame))frames.set(frame,await frame.evaluateHandle(()=>document));
    element=await locator.elementHandle({timeout:timeout(config)});if(!element)fail();owner=await element.evaluateHandle(ownerFor);
   }
   const value=await (element||locator).evaluate(controlSnapshot);if(!value)fail();
   if(post&&await post.sameIngress(action,element,value))deferred.add(action.id);
   pins.set(action.id,{action,locator,element,owner,group,expected:digest(value),semantic:digest({...value,value:null})});
  }
  const verify=async action=>{
   config._runtime?.budget?.check();if(dead||drift||post?.invalid())fail();await guard.verify();
   for(const [frame,document] of frames)if(frame.isDetached()||!await frame.evaluate(doc=>document===doc,document))fail();
   for(const [id,pin] of pins){
    // One closed evaluation already verifies EVERY backend pin, including its
    // group and host chain. Repeating identity for each pin wastes the existing
    // finite CDP budget without adding a new check. The selected action still
    // receives the complete fresh policy check immediately before dispatch.
    const current=pin.action.closedShadow?locate(page,pin.action,config):await checkLiveAction(page,pin.action,config);
    if(pin.element){if(!await current.evaluate((node,expected)=>node===expected,pin.element)||!await pin.element.evaluate((node,owner)=>(node.form||node.closest('[role="search"],[data-filter]')||node.getRootNode())===owner,pin.owner))fail();}
    // Closed scope() validates its original target/group identities here.
    const observed=await (pin.element||current).evaluate(controlSnapshot);if(!observed)fail();
    if(digest(observed)!==pin.expected)fail();
   }
   if(action&&action.kind!=='scroll'&&!pins.has(action.id))fail();
   if(action?.closedShadow)await checkLiveAction(page,action,config);
   config._runtime?.budget?.check();return action&&pins.get(action.id)?.element;
  };
  await guard.verify();return {stateId:state.id,page,deferred,verify,async refreshText(action,receipt){
   if(!receipt?.verify)fail();await receipt.verify();
   const pin=pins.get(action.id);if(!pin)fail();
   const observed=await (pin.element||pin.locator).evaluate(controlSnapshot);
   if(!observed||digest({...observed,value:null})!==pin.semantic)fail();
   pin.expected=digest(observed);await guard.verify();
  },dispose};
 }catch(error){await dispose();throw error;}
}
