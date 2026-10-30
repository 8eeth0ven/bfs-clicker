import { createHash } from 'node:crypto';
import { BASE_SELECTOR } from './discover.js';
export const md5=value=>createHash('md5').update(String(value)).digest('hex');
// These hashes aid comparison without persisting page content. Lengths describe
// UTF-8 JSON bytes, so equal arrays and strings have a reproducible encoding.
const summarizeComponent=value=>{
  const json=JSON.stringify(value);
  return {sha256:createHash('sha256').update(json).digest('hex'),lengthBytes:Buffer.byteLength(json,'utf8'),...(Array.isArray(value)?{count:value.length}:{})};
};
export const MAX_FINGERPRINT_DIAGNOSTIC_FRAMES=12;
export function summarizeFingerprintSurfaces(surfaces) {
  const totalFrameCount=surfaces.length,selected=surfaces.slice(0,MAX_FINGERPRINT_DIAGNOSTIC_FRAMES);
  return {version:1,totalFrameCount,frameCount:selected.length,truncated:totalFrameCount>selected.length,frames:selected.map(surface=>({
    url:summarizeComponent(surface.url),title:summarizeComponent(surface.title),
    lines:summarizeComponent(surface.lines),headings:summarizeComponent(surface.headings),body:summarizeComponent(surface.body),
  }))};
}
// Persisted checkpoint data is untrusted: only emit this fixed, bounded schema.
export function normalizeFingerprintDiagnostics(value) {
  try {
    const exact=(item,keys)=>item!==null&&typeof item==='object'&&!Array.isArray(item)&&
      (Object.getPrototypeOf(item)===Object.prototype||Object.getPrototypeOf(item)===null)&&
      Reflect.ownKeys(item).length===keys.length&&keys.every(key=>Object.hasOwn(item,key));
    const integer=(n,max)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
    const component=(item,array)=>{
      const keys=array?['sha256','lengthBytes','count']:['sha256','lengthBytes'];
      if(!exact(item,keys))return null;
      const {sha256,lengthBytes,count}=item;
      if(typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256)||
        !integer(lengthBytes,0x7fffffff)||(array&&!integer(count,1000000)))return null;
      return {sha256,lengthBytes,...(array?{count}:{})};
    };
    if(!exact(value,['version','totalFrameCount','frameCount','truncated','frames']))return null;
    const {version,totalFrameCount,frameCount,truncated,frames:inputFrames}=value;
    if(version!==1||!Array.isArray(inputFrames)||!integer(totalFrameCount,0xffffffff)||
      !integer(frameCount,MAX_FINGERPRINT_DIAGNOSTIC_FRAMES)||frameCount!==inputFrames.length||
      frameCount!==Math.min(totalFrameCount,MAX_FINGERPRINT_DIAGNOSTIC_FRAMES)||
      typeof truncated!=='boolean'||truncated!==(totalFrameCount>frameCount))return null;
    const frames=[];
    for(const frame of inputFrames){
      if(!exact(frame,['url','title','lines','headings','body']))return null;
      const url=component(frame.url,false),title=component(frame.title,false),lines=component(frame.lines,true),
        headings=component(frame.headings,true),body=component(frame.body,true);
      if(!url||!title||!lines||!headings||!body)return null;
      frames.push({url,title,lines,headings,body});
    }
    return {version:1,totalFrameCount,frameCount:frames.length,truncated,frames};
  } catch { return null; }
}
// Preserve business numbers by default. Only configured selectors/patterns remove noise.
export async function fingerprint(page,config={}) {
  const frames=page.frames?.()||[page];const surfaces=[];
  for(const frame of frames.slice(0,config.maxFrames||12)){
    if(config._policy && frame!==frames[0]&&!config._policy.navigation(frame.url()).allow)continue;
    surfaces.push(await frame.evaluate(({selector,ignore,patterns})=>{
      const regex=patterns.map(p=>new RegExp(p,'g'));
      const clean=s=>{let v=String(s||'').replace(/\s+/g,' ').trim();for(const re of regex)v=v.replace(re,'<noise>');return v.slice(0,10000)};
      const excluded=el=>ignore.some(s=>el.matches(s)||el.closest(s));
      const visible=el=>{const st=getComputedStyle(el),r=el.getBoundingClientRect();return st.display!=='none'&&st.visibility!=='hidden'&&r.width>0&&r.height>0};
      const lines=[],headings=[],body=[];
      const visit=root=>{
        for(const el of root.querySelectorAll(selector))if(!excluded(el)&&visible(el))lines.push([el.tagName,clean(el.innerText||el.textContent),el.getAttribute('href'),el.getAttribute('role'),el.getAttribute('aria-label'),el.getAttribute('aria-selected'),el.getAttribute('aria-expanded'),el.getAttribute('aria-checked'),el.getAttribute('aria-current'),!!el.checked,el.tagName==='SELECT'?el.value:'',!!el.disabled].join('|'));
        for(const el of root.querySelectorAll('h1,h2,h3,p,pre,[role="tabpanel"],[data-bfs-state]'))if(!excluded(el)&&visible(el))headings.push(clean(el.innerText));
        const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;let size=0;
        while((node=walker.nextNode())&&size<20000){const parent=node.parentElement;if(parent&&!parent.closest('script,style,noscript')&&!excluded(parent)&&visible(parent)){const text=clean(node.textContent);if(text){body.push(text);size+=text.length}}}
        for(const el of root.querySelectorAll('*'))if(el.shadowRoot)visit(el.shadowRoot);
      };visit(document);return {url:location.href,title:document.title,lines:lines.sort(),headings,body};
    },{selector:BASE_SELECTOR,ignore:config.fingerprintIgnoreSelectors||['[data-bfs-noise]','[role="timer"]'],patterns:config.fingerprintNoisePatterns||[]}));
  }
  return {fp:md5(JSON.stringify(surfaces)),url:page.url(),title:await page.title(),surface:surfaces,diagnostics:summarizeFingerprintSurfaces(surfaces)};
}
