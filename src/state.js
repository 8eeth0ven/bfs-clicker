import { createHash } from 'node:crypto';
import { BASE_SELECTOR } from './discover.js';
export const md5=value=>createHash('md5').update(String(value)).digest('hex');
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
  return {fp:md5(JSON.stringify(surfaces)),url:page.url(),title:await page.title(),surface:surfaces};
}
