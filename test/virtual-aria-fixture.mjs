import {fixture,document} from './helpers.mjs';

export const virtualPolicy={id:'cities',selector:'#category',listboxSelector:'#list',scrollSelector:'#list',optionSelector:'#list [role="option"]',maxOptions:12,maxScrolls:12,maxSnapshots:96,timeoutMs:4000};
export const cityWire=index=>'city_'+String(index).padStart(2,'0');
export const cityLabel=index=>'City'+String(index).padStart(2,'0');

export async function virtualSite(t){
 let mode='normal';const opens=[],selected=[],scrolls=[],queries=[],renders=[];
 const site=await fixture(t,async({url,method},req)=>{
  if(method==='POST'){
   let raw='';for await(const part of req)raw+=part;const input=JSON.parse(raw);
   if(url.pathname==='/event'){({open:opens,select:selected,scroll:scrolls,render:renders})[input.type]?.push(input);return {type:'application/json',body:'{}'};}
   if(url.pathname==='/query'){queries.push(input);return {type:'application/json',body:JSON.stringify({...input,serial:queries.length})};}
  }
  return {body:document('Virtual cities',`<style>#list{display:none;position:relative;width:240px;height:90px;overflow-y:auto;overflow-x:hidden;border:1px solid #777}#list[aria-busy]{display:block}#spacer{height:360px;position:relative}.slot{height:30px;line-height:30px;position:absolute;left:0;width:100%;box-sizing:border-box}#unrelated{overflow:auto;width:150px;height:30px}#veil{position:fixed;inset:0;background:rgba(0,0,0,.1);z-index:99}</style><section><form id="form" action="/query" method="post"><button id="category" type="button" name="city" role="combobox" aria-label="City" aria-controls="list" aria-expanded="false" data-value="">Choose a city</button><div id="mount"></div><button id="search" type="button" aria-controls="result">Search</button></form><output id="result" aria-label="City result" role="status">${mode==='same-noop'?'RESULT City12':'Not queried'}</output></section><div id="unrelated"><div style="height:300px">Unrelated</div></div>`,
   `const mode=${JSON.stringify(mode)},combo=document.querySelector('#category'),mount=document.querySelector('#mount'),result=document.querySelector('#result');let list,slots,drifted=false;
   const wire=i=>'city_'+String(i).padStart(2,'0'),label=i=>'City'+String(i).padStart(2,'0'),log=input=>fetch('/event',{method:'POST',body:JSON.stringify(input)});
   function render(){const start=mode==='infinite'?0:Math.min(9,Math.floor(list.scrollTop/30));
    for(let j=0;j<slots.length;j++){const i=start+j+1,slot=slots[j];if(i>12||mode==='missing-index'&&i===6){slot.hidden=true;slot.removeAttribute('role');continue;}slot.hidden=false;slot.setAttribute('role','option');slot.setAttribute('aria-setsize',mode==='unknown-size'?'-1':'12');slot.setAttribute('aria-posinset',String(mode==='duplicate-index'&&i===6?5:i));slot.dataset.value=mode==='duplicate-wire'&&i===6?wire(5):wire(i);slot.textContent=mode==='prefix-drift'&&i===5?label(i)+'0':label(i);slot.style.top=(i-1)*30+'px';}
    log({type:'render',mounted:slots.filter(slot=>!slot.hidden).length,positions:slots.filter(slot=>!slot.hidden).map(slot=>Number(slot.getAttribute('aria-posinset'))),slotIds:slots.map(slot=>slot.id)});
    if(mode==='identity-drift'&&list.scrollTop>30&&!drifted){drifted=true;const clone=list.cloneNode(true);list.replaceWith(clone);}
   }
   combo.onclick=()=>{log({type:'open'});combo.setAttribute('aria-expanded','true');list=document.createElement('div');list.id='list';list.setAttribute('role','listbox');list.setAttribute('aria-label','Cities');list.setAttribute('aria-busy',mode==='busy'?'true':'false');list.innerHTML='<div id="spacer"></div>';mount.append(list);const spacer=list.firstElementChild;if(mode==='infinite')spacer.style.height='1000000px';slots=Array.from({length:4},(_,j)=>{const node=document.createElement('div');node.id='slot-'+j;node.className='slot';spacer.append(node);node.onclick=()=>{const value=node.dataset.value;log({type:'select',value});if(mode!=='bad-proof')combo.dataset.value=value;combo.textContent=node.textContent;combo.setAttribute('aria-expanded','false');list.remove();if(mode==='auto-noop')result.textContent='RESULT '+node.textContent;};return node;});
    list.onscroll=()=>{log({type:'scroll',top:list.scrollTop,unrelated:document.querySelector('#unrelated').scrollTop});if(mode!=='stuck')render();};render();if(mode==='overlay'){const veil=document.createElement('div');veil.id='veil';document.body.append(veil);}
   };
   document.querySelector('#search').onclick=async()=>{const input={city:combo.dataset.value},response=await fetch('/query',{method:'POST',body:JSON.stringify(input)}),data=await response.json();if(mode==='auto-noop'||mode==='same-noop')return;result.textContent=mode==='wrong-result'?'RESULT City01 #'+data.serial:mode==='prefix-result'?'RESULT '+combo.textContent+'0 #'+data.serial:'RESULT '+combo.textContent+' #'+data.serial;};`)};
 });return {...site,opens,selected,scrolls,queries,renders,setMode:value=>{mode=value;}};
}

export const virtualWebConfig=site=>({actionProfile:'forms',fillText:true,formValues:{'#category':'seed'},actionAllowlist:['#category','#list','#list [role="option"]','#search'],requestAllowlist:[{method:'POST',url:site.origin+'/event'},{method:'POST',url:site.origin+'/query'}],ariaVirtualLists:[virtualPolicy],shotFormat:'none',requestDelayMs:0,exploreHover:false,exploreScroll:false,maxRetries:0});
