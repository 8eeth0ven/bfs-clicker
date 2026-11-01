// Real local HTML author-closed components, never a patched attachShadow API.
import {fixture,document} from './helpers.mjs';
import {closedDescriptor} from '../src/closed-shadow.js';
export const roots=[{id:'alpha',hosts:['#widgetA'],maxNodes:32},{id:'beta',hosts:['#widgetB'],maxNodes:32}];
export const target=(id,selector)=>closedDescriptor(roots.find(row=>row.id===id),selector);
export async function closedSite(t){let mode='normal',queryHook=null;const queries=[];
 const site=await fixture(t,async({url},req)=>{
  if(url.pathname==='/api/search'){
   let bytes='';for await(const chunk of req)bytes+=chunk;const value=JSON.parse(bytes);queries.push(value);queryHook?.(value);
   return{type:'application/json',body:JSON.stringify({...value,serial:queries.length})};
  }
  return{body:document('Author closed components',`<section id="plain"><input id="query" value="BODY-DECOY"><button id="search">Search</button><output id="result">BODY-DECOY</output></section><div id="widgetA"></div><div id="widgetB"></div>`,
   `const mode=${JSON.stringify(mode)};window.fixtureEvents=[];
    function mount(host,id){const r=host.attachShadow({mode:'closed'});r.innerHTML='<style>:host{display:block;margin:12px}input,button{display:block;width:240px;height:34px;margin:8px}output{display:block;margin:8px}</style><section id="filters" role="search"><label for="query">Search query</label><input id="query" name="query" aria-label="Search query" type="search" required minlength="1" maxlength="20" pattern="[A-Za-z0-9]+"><button id="search" type="button" aria-controls="result">Search</button></section><output id="result" role="status" aria-label="Search result">RESULT NONE</output><div id="nested"></div>';
     let input=r.querySelector('#query');if(id==='beta')input.value='B-DECOY';
     input.addEventListener('input',()=>{window.fixtureEvents.push({type:'input',id});if(mode==='auto-noop')r.querySelector('#result').textContent='RESULT '+input.value+' AUTO'});
     if(id==='alpha'&&mode==='drift')input.setAttribute('maxlength','19');
     if(id==='alpha'&&mode==='inner-hidden')input.style.visibility='hidden';
     if(id==='alpha'&&['focus-type','focus-name','focus-host'].includes(mode))input.addEventListener('focus',()=>{if(mode==='focus-type')input.type='password';if(mode==='focus-name')input.name='changed';if(mode==='focus-host')host.setAttribute('aria-label','changed')},{once:true});
     if(id==='alpha'&&['focus-input-excluded','focus-ancestor-excluded'].includes(mode))input.addEventListener('focus',()=>{(mode==='focus-input-excluded'?input:input.parentElement).className='blocked'},{once:true});
     if(id==='alpha'&&mode==='key-type')input.addEventListener('keydown',event=>{if(event.key.toLowerCase()==='a'&&(event.ctrlKey||event.metaKey))input.type='password'});
     if(id==='alpha'&&['rebuild-focus','target-focus'].includes(mode))input.addEventListener('focus',()=>{window.fixtureEvents.push({type:'focus',id});if(mode==='rebuild-focus'){const next=document.createElement('div');next.id=host.id;host.replaceWith(next);mount(next,id)}else input.replaceWith(input.cloneNode(true))},{once:true});
     r.querySelector('#search').onclick=async()=>{window.fixtureEvents.push({type:'submit',id});if(mode==='auto-noop')return;const response=await fetch('/api/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({q:input.value,host:id})}),data=await response.json();let output=r.querySelector('#result');if(mode==='result-rebuild'){const next=output.cloneNode(true);output.replaceWith(next);output=next;}output.textContent=mode==='wrong-result'?'RESULT wrong '+data.serial:'RESULT '+data.q+' #'+data.serial;};
     const nested=r.querySelector('#nested').attachShadow({mode:'closed'});nested.innerHTML='<input id="query" value="UNAPPROVED-NESTED"><button id="search">Search</button><span>UNAPPROVED-NESTED-TEXT</span>';
    }
    mount(document.querySelector('#widgetA'),'alpha');mount(document.querySelector('#widgetB'),'beta');
    if(mode==='hostile-prototype'){const query=ShadowRoot.prototype.querySelector,all=ShadowRoot.prototype.querySelectorAll;ShadowRoot.prototype.querySelector=function(s){return s==='#query'?document.querySelector('#query'):query.call(this,s)};ShadowRoot.prototype.querySelectorAll=function(s){return s==='#query'?document.querySelectorAll('#query'):all.call(this,s)};Element.prototype.getRootNode=function(){return document};}
    if(mode==='host-hidden')document.querySelector('#widgetA').style.visibility='hidden';
    if(mode==='overlay'){const cover=document.createElement('div');cover.id='cover';cover.style='position:fixed;inset:0;background:transparent;z-index:9999';document.body.append(cover);}
   `)};
 });return{...site,queries,setMode:value=>{mode=value},afterQuery:fn=>{queryHook=fn}};
}
export function closedWebConfig(site){return{actionProfile:'forms',fillText:true,formValues:{[target('alpha','#query').selector]:'seed'},actionAllowlist:[target('alpha','#query').selector,target('alpha','#search').selector],requestAllowlist:[{method:'POST',url:site.origin+'/api/search'}],closedShadowRoots:roots,shotFormat:'none',exploreHover:false,exploreScroll:false,requestDelayMs:0,maxRetries:0};}
