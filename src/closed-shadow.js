// Explicit local Chromium-only author-closed roots. Never changes attachShadow,
// exposes a root to page globals, visits UA roots, or uses JS click/value setters.
import {createHash,randomUUID} from 'node:crypto';
const fail=code=>{throw Object.assign(new Error(code+'：closed Shadow 契约未验证'),{code})};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const backends=new WeakMap(),bindings=new WeakMap();
const css=v=>typeof v==='string'&&v.length>0&&v.length<=512&&!/[\x00-\x1f\x7f]/.test(v)&&!v.includes('>>');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
async function boundedCleanup(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('cleanup timeout')),250)})])}finally{clearTimeout(timer)}}
export const closedSelector=(id,selector)=>'closed::'+id+'::'+selector;
export function normalizeClosedShadowRoots(input=[]){
 if(!Array.isArray(input)||input.length>4)fail('CLOSED_SHADOW_CONFIG_INVALID');const ids=new Set(),chains=new Set();
 return Array.from(input,row=>{if(!plain(row)||Object.keys(row).some(k=>!['id','hosts','maxNodes'].includes(k))||typeof row.id!=='string'||!/^[-A-Za-z0-9_]{1,64}$/.test(row.id)||ids.has(row.id)||!Array.isArray(row.hosts)||!row.hosts.length||row.hosts.length>4||Array.from(row.hosts).some(s=>!css(s))||!Number.isSafeInteger(row.maxNodes??128)||(row.maxNodes??128)<1||(row.maxNodes??128)>256||chains.has(JSON.stringify(row.hosts)))fail('CLOSED_SHADOW_CONFIG_INVALID');ids.add(row.id);chains.add(JSON.stringify(row.hosts));return{id:row.id,hosts:[...row.hosts],maxNodes:row.maxNodes??128};});
}
export function closedTarget(target,config){
 if(target.closedShadow===undefined){if(target.selector?.startsWith('closed::'))fail('CLOSED_SHADOW_METADATA_REQUIRED');return null}
 const meta=target.closedShadow;
 if(!plain(meta)||Object.keys(meta).sort().join(',')!=='hosts,policyId,schemaVersion,selector'||meta.schemaVersion!==1||!css(meta.selector)||!Array.isArray(meta.hosts)||!Array.isArray(target.framePath)||target.framePath.length!==0)fail('CLOSED_SHADOW_TARGET_INVALID');
 const policy=normalizeClosedShadowRoots(config?.closedShadowRoots).find(p=>p.id===meta.policyId);
 if(!policy||!same(policy.hosts,meta.hosts)||target.selector!==closedSelector(meta.policyId,meta.selector))fail('CLOSED_SHADOW_NOT_APPROVED');
 return {meta:{schemaVersion:1,policyId:policy.id,hosts:[...policy.hosts],selector:meta.selector},policy};
}
export const closedKey=target=>target.closedShadow?JSON.stringify(target.closedShadow):null;
export function closedDescriptor(policy,selector){return{selector:closedSelector(policy.id,selector),framePath:[],closedShadow:{schemaVersion:1,policyId:policy.id,hosts:[...policy.hosts],selector}}}
export function bindClosedShadow(page,config){bindings.set(page,config)}
export async function resetClosedShadow(page){const previous=backends.get(page);if(previous){try{const b=await boundedCleanup(previous);b.dead=true;await boundedCleanup(b.session.detach());backends.delete(page)}catch{fail('CLOSED_SHADOW_CLEANUP_FAILED')}}}

// Fixed DOM semantics exclude mutable input values and result text. All reads
// execute on isolated-world wrappers, not page-modifiable DOM prototypes.
function targetSemantics(e){return{tag:e.tagName,type:e.type||'',attributes:['id','name','role','aria-label','aria-disabled','aria-readonly','aria-hidden','title','placeholder','required','readonly','disabled','min','max','step','minlength','maxlength','pattern','formaction','formmethod','contenteditable'].map(k=>[k,e.getAttribute(k)]),buttonText:e.tagName==='BUTTON'?String(e.textContent||'').slice(0,4096):null}}
function hostSemantics(node){return{visible:!!node.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true}),tag:node.tagName,id:node.id,role:node.getAttribute('role'),name:node.getAttribute('name'),aria:node.getAttribute('aria-label'),class:node.getAttribute('class')}}
function checkAction(config){config?._runtime?.budget?.check();const action=config?._closedAction;if(action&&(action.expired||Date.now()>=action.deadline))fail('CLOSED_SHADOW_TIMEOUT')}
function actionTimeout(config,options){return Math.max(1,Math.min(config?.actionTimeoutMs??4000,config?._runtime?.budget?.remainingMs??4000,Number.isFinite(options?.timeout)&&options.timeout>0?options.timeout:Infinity))}

// Read-only geometry across every host boundary. Full containment is required;
// offscreen, transforms, clipping, transparent/hidden ancestors stay unsupported.
function geometry(element){
 if(!element.isConnected)return null;const b=element.getBoundingClientRect();if(!b.width||!b.height||b.x<0||b.y<0||b.right>innerWidth||b.bottom>innerHeight)return null;
 for(let cur=element;cur;cur=cur.parentElement||cur.getRootNode()?.host||null){const s=getComputedStyle(cur),r=cur.getBoundingClientRect();if(s.display==='none'||s.visibility!=='visible'||Number(s.opacity)===0||s.transform!=='none'||s.clipPath!=='none'||s.maskImage!=='none'||cur.hidden)return null;
  if(cur!==element){const x=['hidden','clip','scroll','auto'].includes(s.overflowX),y=['hidden','clip','scroll','auto'].includes(s.overflowY);if(x&&(b.left<r.left+cur.clientLeft||b.right>r.left+cur.clientLeft+cur.clientWidth)||y&&(b.top<r.top+cur.clientTop||b.bottom>r.top+cur.clientTop+cur.clientHeight))return null;}}
 return{x:b.x,y:b.y,width:b.width,height:b.height};
}
class Backend{
 constructor(page,session){this.page=page;this.session=session;this.doc=null;this.world=null;this.leases=new Map();this.calls=0;this.dead=false;}
 async send(method,params,config){
  checkAction(config);if(this.dead||++this.calls>4096)fail('CLOSED_SHADOW_LIMIT');
  const timeout=Math.max(1,Math.min(config?.actionTimeoutMs??4000,config?._runtime?.budget?.remainingMs??4000,config?._closedAction?config._closedAction.deadline-Date.now():Infinity));let timer;
  try{const value=await Promise.race([this.session.send(method,params),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('timeout'),{code:'CLOSED_SHADOW_TIMEOUT'})),timeout)})]);if(Buffer.byteLength(JSON.stringify(value))>262144)fail('CLOSED_SHADOW_LIMIT');checkAction(config);return value;}
  catch(e){if(e.code==='CLOSED_SHADOW_TIMEOUT')this.dead=true;if(e.code?.startsWith('CLOSED_SHADOW_'))throw e;fail('CLOSED_SHADOW_BACKEND_REJECTED');}finally{clearTimeout(timer)}
 }
 async call(objectId,fn,arg,group,config,byValue=true){const r=await this.send('Runtime.callFunctionOn',{objectId,functionDeclaration:'function(arg){return ('+fn.toString()+')(this,arg)}',...(arg===undefined?{}:{arguments:[{value:arg}]}),returnByValue:byValue,objectGroup:group},config);if(r.exceptionDetails)fail('CLOSED_SHADOW_EVALUATION_REJECTED');return byValue?r.result.value:r.result;}
 async resolveObject(backendNodeId,group,config){return(await this.send('DOM.resolveNode',{backendNodeId,objectGroup:group,executionContextId:this.world},config)).object.objectId;}
 async root(target,config,group){
  let url;try{url=new URL(this.page.url())}catch{fail('CLOSED_SHADOW_SCOPE_NOT_APPROVED')}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!config.navigationOrigins?.includes(url.origin)||config._policy&&!config._policy.navigation(url.href).allow)fail('CLOSED_SHADOW_SCOPE_NOT_APPROVED');
  const {policy,meta}=closedTarget(target,config),document=(await this.send('DOM.getDocument',{depth:0,pierce:false},config)).root;
  if(this.doc!==null&&this.doc!==document.backendNodeId)fail('CLOSED_SHADOW_DOCUMENT_REBUILT');this.doc=document.backendNodeId;
  if(this.world===null){const tree=await this.send('Page.getFrameTree',{},config);this.world=(await this.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'bfs-closed-readonly-'+randomUUID()},config)).executionContextId;}
  let objectId=await this.resolveObject(document.backendNodeId,group,config);const documentId=objectId,chain=[],semantics=[],hostIds=[],rootIds=[];
  for(const selector of policy.hosts){
   const n=await this.call(objectId,(root,selector)=>root.querySelectorAll(selector).length,selector,group,config);
   if(n===0){if(this.leases.has(policy.id))fail('CLOSED_SHADOW_ROOT_REBUILT');return null}if(n!==1)fail('CLOSED_SHADOW_HOST_AMBIGUOUS');
   const host=await this.call(objectId,(root,selector)=>root.querySelector(selector),selector,group,config,false);
   const info=await this.call(host.objectId,hostSemantics,undefined,group,config);
   if(!info.visible)fail('CLOSED_SHADOW_HIDDEN');
   const node=(await this.send('DOM.describeNode',{objectId:host.objectId,depth:0,pierce:false},config)).node;
   const roots=(node.shadowRoots||[]).filter(r=>r.shadowRootType==='closed');if(roots.length!==1)fail('CLOSED_SHADOW_MODE_CHANGED');
   chain.push([node.backendNodeId,roots[0].backendNodeId]);semantics.push(info);hostIds.push(host.objectId);objectId=await this.resolveObject(roots[0].backendNodeId,group,config);rootIds.push(objectId);
  }
  const previous=this.leases.get(policy.id);if(previous&&!same(previous.chain,chain))fail('CLOSED_SHADOW_ROOT_REBUILT');
  if(previous&&!same(previous.semantics,semantics))fail('CLOSED_SHADOW_HOST_CHANGED');
  if(previous)for(const pin of previous.targets.values()){const nodeId=await this.resolveObject(pin.id,group,config),snapshot=await this.send('Runtime.callFunctionOn',{objectId:nodeId,functionDeclaration:'function(root){return{connected:this.isConnected&&this.getRootNode()===root,semantic:('+targetSemantics.toString()+')(this)}}',arguments:[{objectId}],returnByValue:true},config);if(snapshot.exceptionDetails||!snapshot.result.value?.connected)fail('CLOSED_SHADOW_TARGET_REBUILT');if(!same(snapshot.result.value.semantic,pin.semantic))fail('CLOSED_SHADOW_TARGET_CHANGED');}
  const lease=previous||{chain,semantics,targets:new Map()};this.leases.set(policy.id,lease);return{objectId,documentId,hostIds,rootIds,lease,semantics,policy,meta};
 }
 async scope(target,config,fn,{rootOnly=false}={}){
  const group='bfs-closed-'+randomUUID();let primary;try{const root=await this.root(target,config,group);if(!root)return await fn(null,group);
   if(rootOnly)return await fn(root,group);
   const count=await this.call(root.objectId,(root,selector)=>root.querySelectorAll(selector).length,root.meta.selector,group,config);if(count>root.policy.maxNodes)fail('CLOSED_SHADOW_LIMIT');if(count!==1)return await fn({...root,count},group);
   const node=await this.call(root.objectId,(root,selector)=>root.querySelector(selector),root.meta.selector,group,config,false),description=(await this.send('DOM.describeNode',{objectId:node.objectId,depth:0,pierce:false},config)).node;
   const contained=await this.send('Runtime.callFunctionOn',{objectId:node.objectId,functionDeclaration:'function(root){return this.getRootNode()===root}',arguments:[{objectId:root.objectId}],returnByValue:true},config);if(contained.exceptionDetails||contained.result.value!==true)fail('CLOSED_SHADOW_SCOPE_CHANGED');
   const id=description.backendNodeId,semantic=await this.call(node.objectId,targetSemantics,undefined,group,config),previous=root.lease.targets.get(root.meta.selector);if(previous&&previous.id!==id)fail('CLOSED_SHADOW_TARGET_REBUILT');if(previous&&!same(previous.semantic,semantic))fail('CLOSED_SHADOW_TARGET_CHANGED');if(!previous&&root.lease.targets.size>=root.policy.maxNodes)fail('CLOSED_SHADOW_LIMIT');root.lease.targets.set(root.meta.selector,{id,semantic});
   return await fn({...root,count:1,nodeId:node.objectId,backendNodeId:id,semantic},group);
  }catch(e){primary=e;throw e}finally{try{await boundedCleanup(this.session.send('Runtime.releaseObjectGroup',{objectGroup:group}))}catch{this.dead=true;await boundedCleanup(this.session.detach()).catch(()=>{});if(!primary)fail('CLOSED_SHADOW_CLEANUP_FAILED')}}
 }
}
async function backend(page,config){checkAction(config);if(!backends.has(page)){let expired=false,timer;const pending=page.context().newCDPSession(page),timeout=Math.max(1,Math.min(actionTimeout(config),config?._closedAction?config._closedAction.deadline-Date.now():Infinity));
 const result=Promise.race([pending.then(session=>new Backend(page,session)),new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Object.assign(new Error('closed backend timeout'),{code:'CLOSED_SHADOW_TIMEOUT'}))},timeout)})]).finally(()=>clearTimeout(timer));
 pending.then(session=>{if(expired)boundedCleanup(session.detach()).catch(()=>{})}).catch(()=>{});backends.set(page,result);
 }let timer;try{const pending=backends.get(page),timeout=config?._closedAction?Math.max(1,config._closedAction.deadline-Date.now()):actionTimeout(config);const value=await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>{pending.then(b=>{b.dead=true;boundedCleanup(b.session.detach()).catch(()=>{})}).catch(()=>{});reject(Object.assign(new Error('closed backend deadline'),{code:'CLOSED_SHADOW_TIMEOUT'}))},timeout)})]);checkAction(config);return value}finally{clearTimeout(timer)}}
export class ClosedLocator{
 constructor(page,target,config){this.page=page;this.target=target;this.config=config||bindings.get(page);closedTarget(target,this.config);}
 async use(fn,options){const config=options?{...this.config,_closedAction:{deadline:Math.min(Date.now()+actionTimeout(this.config,options),this.config._closedAction?.deadline??Infinity),expired:false}}:this.config;const b=await backend(this.page,config);return b.scope(this.target,config,(ref,group)=>fn(b,ref,group,config));}
 async count(options){return this.use((b,r)=>r?.count??0,options)}
 async evaluate(fn,arg,options){return this.use((b,r,g,config)=>{if(r?.count!==1)fail('CLOSED_SHADOW_LOCATOR_CHANGED');return b.call(r.nodeId,fn,arg,g,config)},options)}
 async identity(){return this.use((b,r)=>{if(r?.count!==1)fail('CLOSED_SHADOW_LOCATOR_CHANGED');return{...r.meta,mode:'closed',hostsContract:r.semantics}})}
 async isVisible(options){return this.evaluate(geometry,undefined,options).then(Boolean)}
 async innerText(options){return this.evaluate(e=>String(e.innerText||'').slice(0,32768),undefined,options)}
 async inputValue(options){return this.evaluate(e=>String(e.value||'').slice(0,4096),undefined,options)}
 async getAttribute(name,options){return this.evaluate((e,name)=>e.getAttribute(name)?.slice(0,4096)??null,name,options)}
 async ui(fn,options){
  const action={deadline:Date.now()+actionTimeout(this.config,options),expired:false},local=new ClosedLocator(this.page,this.target,{...this.config,_closedAction:action});let timer;
  try{return await Promise.race([Promise.resolve().then(()=>fn(local)),new Promise((_,reject)=>{timer=setTimeout(()=>{action.expired=true;const pending=backends.get(this.page);pending?.then(b=>{b.dead=true}).catch(()=>{});boundedCleanup(this.page.close({runBeforeUnload:false})).catch(()=>{});reject(Object.assign(new Error('closed action timeout'),{code:'CLOSED_SHADOW_TIMEOUT'}))},Math.max(1,action.deadline-Date.now()))})]);}
  catch(error){if(error.code==='CLOSED_SHADOW_TIMEOUT'){action.expired=true;backends.get(this.page)?.then(b=>{b.dead=true}).catch(()=>{});boundedCleanup(this.page.close({runBeforeUnload:false})).catch(()=>{});}throw error}
  finally{clearTimeout(timer);action.expired=true;}
 }
 async point(dispatch){return this.use(async(b,r,g)=>{
  if(r?.count!==1)fail('CLOSED_SHADOW_LOCATOR_CHANGED');const before=await b.call(r.nodeId,geometry,undefined,g,this.config);if(!before)fail('CLOSED_SHADOW_NOT_ACTIONABLE');
  const disabled=await b.call(r.nodeId,e=>!!e.disabled||e.getAttribute('aria-disabled')==='true',undefined,g,this.config);if(disabled)fail('CLOSED_SHADOW_NOT_ACTIONABLE');
  for(const rx of [.25,.5,.75])for(const ry of [.25,.5,.75]){const x=Math.floor(before.x+before.width*rx),y=Math.floor(before.y+before.height*ry),hit=await b.send('DOM.getNodeForLocation',{x,y,includeUserAgentShadowDOM:false,ignorePointerEventsNone:false},this.config);
   const objectId=await b.resolveObject(hit.backendNodeId,g,this.config),reply=await b.send('Runtime.callFunctionOn',{objectId:r.nodeId,functionDeclaration:'function(hit){return this===hit||this.contains(hit)}',arguments:[{objectId}],returnByValue:true},this.config);if(reply.exceptionDetails||reply.result.value!==true)fail('CLOSED_SHADOW_OCCLUDED');}
  // One final read checks the very wrappers used by this primitive. It cannot
  // make browser input atomic, but no locator re-resolution occurs after it.
  const pins=[...r.lease.targets.values()],pinIds=await Promise.all(pins.map(pin=>pin.id===r.backendNodeId?r.nodeId:b.resolveObject(pin.id,g,this.config)));
  const declaration='function(root,document,exclusions,...nodes){const n='+r.hostIds.length+',hosts=nodes.slice(0,n),roots=nodes.slice(n,2*n),pins=nodes.slice(2*n);let excluded=false;for(let e=this;e;e=e.parentElement||e.getRootNode()?.host||null)if(exclusions.some(s=>e.matches(s)||e.closest(s)))excluded=true;return{connected:this.isConnected&&this.getRootNode()===root&&hosts.every((h,i)=>h.isConnected&&h.getRootNode()===(i?roots[i-1]:document)&&roots[i].host===h),excluded,pins:pins.map(e=>({connected:e.isConnected&&e.getRootNode()===root,semantic:('+targetSemantics.toString()+')(e)})),focused:this.getRootNode().activeElement===this&&!this.disabled&&!this.readOnly,geometry:('+geometry.toString()+')(this),semantic:('+targetSemantics.toString()+')(this),hosts:hosts.map('+hostSemantics.toString()+')}}';
  const final=await b.send('Runtime.callFunctionOn',{objectId:r.nodeId,functionDeclaration:declaration,arguments:[{objectId:r.objectId},{objectId:r.documentId},{value:this.config.excludeSelectors||[]},...[...r.hostIds,...r.rootIds,...pinIds].map(objectId=>({objectId}))],returnByValue:true},this.config);if(final.exceptionDetails||!final.result.value?.connected)fail('CLOSED_SHADOW_TARGET_REBUILT');const after=final.result.value;if(after.excluded)fail('CLOSED_SHADOW_EXCLUDED');if(after.pins.some((pin,i)=>!pin.connected||!same(pin.semantic,pins[i].semantic)))fail('CLOSED_SHADOW_TARGET_CHANGED');if(!same(before,after.geometry))fail('CLOSED_SHADOW_GEOMETRY_CHANGED');if(!same(after.semantic,r.semantic))fail('CLOSED_SHADOW_TARGET_CHANGED');if(!same(after.hosts,r.semantics))fail('CLOSED_SHADOW_HOST_CHANGED');
  const point={x:Math.floor(before.x+before.width/2),y:Math.floor(before.y+before.height/2)};checkAction(this.config);return dispatch?dispatch(point,{b,r,g,snapshot:after}):point;
 })}
 async click(options){return this.ui(local=>local.point(point=>{checkAction(local.config);return this.page.mouse.click(point.x,point.y)}),options)}
 async hover(options){return this.ui(local=>local.point(point=>{checkAction(local.config);return this.page.mouse.move(point.x,point.y)}),options)}
 async fill(value,options){
  if(typeof value!=='string'||Buffer.byteLength(value)>4096||/[\x00-\x1f\x7f]/.test(value))fail('CLOSED_SHADOW_INPUT_UNSUPPORTED');
  return this.ui(async local=>{const type=await local.evaluate(e=>({tag:e.tagName,type:e.type,readonly:e.readOnly,disabled:e.disabled}));if(!['INPUT','TEXTAREA'].includes(type.tag)||type.tag==='INPUT'&&!['text','search'].includes(type.type)||type.readonly||type.disabled)fail('CLOSED_SHADOW_INPUT_UNSUPPORTED');
   await local.point(point=>{checkAction(local.config);return this.page.mouse.click(point.x,point.y)});
   const edit=async action=>local.point(async(_,{snapshot})=>{if(!snapshot.focused)fail('CLOSED_SHADOW_FOCUS_CHANGED');checkAction(local.config);await action()});
   for(const key of ['ControlOrMeta+A','Backspace'])await edit(()=>this.page.keyboard.press(key));
   await edit(()=>this.page.keyboard.insertText(value));if(await local.inputValue()!==value)fail('CLOSED_SHADOW_INPUT_NOT_VERIFIED');
  },options);
 }
}
export const closedLocator=(page,target,config)=>new ClosedLocator(page,target,config);

export async function collectClosedInteractives(page,config,selector){
 if(!config.closedShadowRoots?.length)return[];bindClosedShadow(page,config);const result=[];
 for(const policy of normalizeClosedShadowRoots(config.closedShadowRoots)){
  const remaining=Math.max(0,(config.maxInteractives??300)-result.length);if(!remaining)break;
  const target=closedDescriptor(policy,':scope'),b=await backend(page,config);
  const rows=await b.scope(target,config,async(r,g)=>{if(!r)return[];return b.call(r.objectId,(root,{selector,max,maxNodes,exclusions})=>{
   const all=root.querySelectorAll('*');if(all.length>maxNodes)return{limit:true};
   const clean=s=>String(s||'').replace(/\s+/g,' ').trim().slice(0,180);
   const css=e=>e.id&&root.querySelectorAll('#'+CSS.escape(e.id)).length===1?'#'+CSS.escape(e.id):(()=>{const a=[];for(let n=e;n&&n.nodeType===1;n=n.parentElement){let i=1;for(let p=n.previousElementSibling;p;p=p.previousElementSibling)if(p.tagName===n.tagName)i++;a.unshift(n.tagName.toLowerCase()+':nth-of-type('+i+')')}return a.join(' > ')})();
   const excluded=e=>{for(let n=e;n;n=n.parentElement||n.getRootNode()?.host||null)if(exclusions.some(s=>n.matches(s)||n.closest(s)))return true;return false};
   return Array.from(root.querySelectorAll(selector)).filter(e=>['BUTTON','TEXTAREA'].includes(e.tagName)||e.tagName==='INPUT'&&['text','search','button','submit'].includes(e.type)).filter(e=>e.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})&&!e.disabled&&!excluded(e)).slice(0,max).map(e=>{
    const tag=e.tagName.toLowerCase(),form=e.form||e.closest('form'),group=form||e.closest('[role="search"],[data-filter]'),region=form?.parentElement||group||e.parentElement;
    const outputs=['button','input'].includes(tag)?[...new Set([...(e.getAttribute('aria-controls')||'').split(/\s+/).filter(Boolean).map(id=>root.getElementById(id)),...Array.from(region?.querySelectorAll('[role="status"],[aria-live],output,[data-results]')||[])])].filter(n=>n&&!excluded(n)).slice(0,6).map(n=>({selector:css(n),tag:n.tagName.toLowerCase(),role:n.getAttribute('role')||'',label:clean(n.getAttribute('aria-label')||n.id),labelSource:n.hasAttribute('aria-label')?'aria':'id'})):[];
    let submission={action:e.getAttribute('formaction'),method:e.getAttribute('formmethod'),enctype:e.getAttribute('formenctype'),target:e.getAttribute('formtarget'),noValidate:e.hasAttribute('formnovalidate')};
    if(Object.values(submission).some(value=>typeof value==='string'&&value.length>1024))submission=null;
    return{selector:css(e),tag,htmlType:(e.type||'').toLowerCase(),submission,role:e.getAttribute('role')||'',text:tag==='input'||tag==='textarea'?'':clean(e.innerText||e.textContent),aria:clean(e.getAttribute('aria-label')),placeholder:clean(e.getAttribute('placeholder')),title:clean(e.title),name:e.name||'',associatedLabel:clean(Array.from(e.labels||[]).map(n=>n.textContent).join(' ')),formSelector:form?css(form):null,groupSelector:group?css(group):null,formAction:form?.action||null,formMethod:form?.method||null,filterContext:!!group,htmlConstraints:{required:e.required,readOnly:e.readOnly,minLength:e.getAttribute('minlength'),maxLength:e.getAttribute('maxlength'),pattern:e.getAttribute('pattern')},workflowOutputs:outputs};
   });
  },{selector,max:remaining,maxNodes:policy.maxNodes,exclusions:config.excludeSelectors||[]},g,config)},{rootOnly:true});
  if(rows?.limit)fail('CLOSED_SHADOW_LIMIT');
  for(const meta of rows){const descriptor={...meta,...closedDescriptor(policy,meta.selector),framePath:[],frameUrl:page.url(),structUnique:true,shadowPath:true};
   descriptor.workflowOutputs=meta.workflowOutputs.map(output=>({...output,...closedDescriptor(policy,output.selector)}));for(const name of ['formSelector','groupSelector'])if(descriptor[name])descriptor[name]=closedSelector(policy.id,descriptor[name]);
   const loc=closedLocator(page,descriptor,config);if(!await loc.isVisible())continue;await loc.point();result.push(descriptor);}
 }
 return result;
}
export async function closedFingerprint(page,config){
 if(!config.closedShadowRoots?.length)return[];const result=[];
 for(const policy of normalizeClosedShadowRoots(config.closedShadowRoots)){
  const b=await backend(page,config),sample=await b.scope(closedDescriptor(policy,':scope'),config,async(r,g)=>r?b.call(r.objectId,(root,max)=>{
   const nodes=root.querySelectorAll('*');if(nodes.length>max)return{limit:true};const structure=[],text=[];let size=0;
   for(const e of nodes){structure.push([e.tagName,e.id,e.getAttribute('role'),e.getAttribute('type'),e.getAttribute('name')]);if(e.closest('input,textarea,select,[contenteditable],script,style,noscript,[hidden]')||!e.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true}))continue;for(const n of e.childNodes)if(n.nodeType===3&&size<4096){const value=String(n.textContent||'').slice(0,4096-size);size+=value.length;text.push(value)}}return{structure,text};
  },policy.maxNodes,g,config):null,{rootOnly:true});if(sample?.limit)fail('CLOSED_SHADOW_LIMIT');result.push({policyId:policy.id,sha256:hash(sample)});
 }return result;
}
