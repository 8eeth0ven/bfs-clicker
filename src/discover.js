// Semantic descriptors with frame/shadow paths. Playwright CSS pierces open shadow roots.
export const BASE_SELECTOR = [
  'button','a[href]','input:not([type="hidden"]):not([type="file"])','textarea','select',
  '[role="button"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="link"], [role="combobox"]',
  '[onclick]','[contenteditable="true"]','summary','label',
].join(',');
const FORM_SELECTOR='[role="option"],[role="listbox"],[role="menuitemcheckbox"],[role="menuitemradio"],.tea-dropdown__header,.tea-list__item,.ant-select-selector,.ant-select-item-option';
export const stepLabel=el=>el.label||el.text||el.href||el.tag||el.selector||el.kind;
function typeOf(meta) {
  if(meta.tag==='select')return 'select';
  if(meta.htmlType==='checkbox'||meta.role==='checkbox'||meta.role==='switch')return 'checkbox';
  if(meta.htmlType==='radio'||meta.role==='radio')return 'radio';
  if(meta.tag==='textarea'||meta.contentEditable||meta.tag==='input'&&!['button','submit','reset','image'].includes(meta.htmlType))return 'text';
  return 'click';
}
function framePath(frame) {
  const result=[];let current=frame;
  while(current.parentFrame?.()){const parent=current.parentFrame();result.unshift(parent.childFrames().indexOf(current));current=parent;}
  return result;
}
export function actionKey(el) {return [JSON.stringify(el.framePath||[]),el.selector,el.kind||'click',el.optionValue??'',el.scrollStep??''].join('|');}
export function frameFor(page,el) {
  let frame=page.mainFrame?.()||page;
  for(const index of el.framePath||[]){frame=frame.childFrames()[index];if(!frame)throw new Error('frame 路径已失效');}
  return frame;
}
export async function collectInteractives(page,config={}) {
  const frames=page.frames?.()||[page];const result=[];const emit=config._runtime?.emit||(()=>{});
  for(const frame of frames.slice(0,config.maxFrames||12)) {
    const url=typeof frame.url==='function'?frame.url():page.url?.();
    if(frame!==frames[0] && config._policy && !config._policy.navigation(url).allow){emit('coverage_gap',{reason:'frame_out_of_scope',url});continue;}
    const fpath=framePath(frame);
    const capture=()=>frame.evaluate(({selector,exclusions,max})=>{
      const clean=s=>String(s||'').replace(/\s+/g,' ').trim().slice(0,180);
      const visible=el=>{const style=getComputedStyle(el),r=el.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&r.width>0&&r.height>0};
      const excluded=el=>{let cur=el;while(cur){if(exclusions.some(s=>cur.matches(s)||cur.closest(s)))return true;cur=cur.getRootNode()?.host||null;}return false;};
      const localPath=el=>{
        const root=el.getRootNode();if(el.id && root.querySelectorAll('#'+CSS.escape(el.id)).length===1)return '#'+CSS.escape(el.id);
        const parts=[];let cur=el;
        while(cur?.nodeType===1){let n=1;for(let sibling=cur.previousElementSibling;sibling;sibling=sibling.previousElementSibling)if(sibling.tagName===cur.tagName)n++;
          parts.unshift(cur.tagName.toLowerCase()+':nth-of-type('+n+')');cur=cur.parentElement;}
        return parts.join(' > ');
      };
      const css=el=>{const host=el.getRootNode()?.host;return host?css(host)+' >> '+localPath(el):localPath(el);};
      const out=[],workflowRegions=new WeakMap();const visit=root=>{
        for(const el of root.querySelectorAll(selector)){
          if(out.length>=max)break;if(!visible(el)||el.disabled||el.getAttribute('aria-disabled')==='true')continue;
          const form=el.form||el.closest('form');let href=el.getAttribute('href')||'';
          if(href)try{href=new URL(href,document.baseURI).href}catch{}
          const tag=el.tagName.toLowerCase();const aria=el.getAttribute('aria-label')||'';const role=el.getAttribute('role')||'';
          const workflowOutputs=[];if(tag==='button'||['submit','button'].includes(el.type)||role==='button'){
            const scope=el.getRootNode(),region=form?.parentElement||el.closest('[role="search"],[data-filter]')||el.parentElement;
            let regionTargets=region&&workflowRegions.get(region);if(!regionTargets){regionTargets=[];if(region)for(const node of region.querySelectorAll('[role="status"],[aria-live],output,table,[data-results]')){regionTargets.push(node);if(regionTargets.length>=24)break;}if(region)workflowRegions.set(region,regionTargets);}
            const targets=[...(el.getAttribute('aria-controls')||'').slice(0,4096).split(/\s+/).filter(Boolean).slice(0,12).map(id=>scope.getElementById?.(id)),...regionTargets];
            for(const node of targets){if(!node||workflowOutputs.some(item=>item.selector===css(node))||excluded(node))continue;workflowOutputs.push({selector:css(node),tag:node.tagName.toLowerCase(),role:node.getAttribute('role')||'',label:clean(node.getAttribute('aria-label')||node.getAttribute('title')||node.id),labelSource:node.getAttribute('aria-label')?'aria':node.getAttribute('title')?'title':'id'});if(workflowOutputs.length>=6)break;}
          }
          let ariaChoices=null,ariaChoiceGap=null;
          if(role==='combobox'){
            const id=(el.getAttribute('aria-controls')||'').trim(),roots=[];const gather=root=>{roots.push(root);for(const node of root.querySelectorAll('*'))if(node.shadowRoot)gather(node.shadowRoot);};gather(document);
            const lists=id&&!/\s/.test(id)?roots.flatMap(root=>Array.from(root.querySelectorAll('[id]')).filter(node=>node.id===id)):[];
            if(lists.length!==1||lists[0].getAttribute('role')!=='listbox'||lists[0].getRootNode()!==el.getRootNode())ariaChoiceGap='aria_listbox_relation_missing_or_ambiguous';
            else{
              const list=lists[0],options=Array.from(list.querySelectorAll('[role="option"]')).filter(node=>node.closest('[role="listbox"]')===list),values=new Set(),sizes=options.map(node=>node.getAttribute('aria-setsize')),positions=options.map(node=>node.getAttribute('aria-posinset')),declared=sizes.some(value=>value!=null)||positions.some(value=>value!=null),complete=!declared||sizes.every(value=>Number(value)===options.length)&&positions.every(value=>Number.isSafeInteger(Number(value))&&Number(value)>0&&Number(value)<=options.length)&&new Set(positions.map(Number)).size===options.length;
              if(!options.length||options.length>200)ariaChoiceGap='aria_options_not_observed_or_over_limit';
              else if(!complete||list.getAttribute('aria-busy')==='true')ariaChoiceGap='aria_options_incomplete_or_virtualized';
              else{const mapped=[];for(const option of options){const value=option.getAttribute('data-value')??option.getAttribute('value');if(value==null||value.length>512||values.has(value)||option.disabled||option.getAttribute('aria-disabled')==='true'||excluded(option)){ariaChoiceGap='aria_options_wire_contract_incomplete';break;}values.add(value);mapped.push({value,label:clean(option.textContent),selector:css(option)});}if(!ariaChoiceGap)ariaChoices={complete:true,domainEvidence:declared?'aria_setsize':'mounted_options',listbox:{selector:css(list)},options:mapped};}
            }
          }
          out.push({selector:css(el),fallbackSelector:css(el),structUnique:true,tag,htmlType:(el.type||'').toLowerCase(),
            text:clean(el.innerText||el.textContent||(tag==='input'&&!['password','checkbox','radio'].includes(el.type)?el.value:'')),aria,title:el.getAttribute('title')||'',href,
            placeholder:el.getAttribute('placeholder')||'',role,contentEditable:el.isContentEditable,
            workflowOutputs,...(role==='combobox'?{ariaChoices,ariaChoiceGap,ariaControlsId:el.getAttribute('aria-controls')||'',ariaSelectionAttribute:el.hasAttribute('data-value')?'data-value':el.hasAttribute('value')?'value':null}:{}),name:el.getAttribute('name')||'',associatedLabel:clean(Array.from(el.labels||[]).map(label=>label.textContent).join(' ')),
            formSelector:form?css(form):null,groupSelector:(form||el.closest('[role="search"],[data-filter]'))?css(form||el.closest('[role="search"],[data-filter]')):null,
            htmlConstraints:{required:el.hasAttribute('required')||role==='combobox'&&el.getAttribute('aria-required')==='true',readOnly:el.hasAttribute('readonly')||role==='combobox'&&el.getAttribute('aria-readonly')==='true',min:el.getAttribute('min'),max:el.getAttribute('max'),step:el.getAttribute('step'),minLength:el.getAttribute('minlength'),maxLength:el.getAttribute('maxlength'),pattern:el.getAttribute('pattern'),multiple:el.hasAttribute('multiple')},
            formAction:form?form.action:null,formMethod:form?form.method:null,contextText:clean(form?.getAttribute('aria-label')),
            excluded:excluded(el),shadowPath:!!el.getRootNode()?.host,
            checked:!!el.checked,selected:el.getAttribute('aria-selected'),expanded:el.getAttribute('aria-expanded'),
            hoverHint:el.hasAttribute('aria-haspopup')||el.hasAttribute('onmouseover')||el.hasAttribute('data-bfs-hover'),
            filterContext:!!el.closest('[role="search"], [data-filter], .filters'),
            options:tag==='select'?Array.from(el.options).filter(o=>!o.disabled).map(o=>({value:o.value,label:clean(o.text)})):[],
          });
        }
        for(const el of root.querySelectorAll('*'))if(el.shadowRoot)visit(el.shadowRoot);
      };visit(document);return out;
    },{selector:config.formExplore?BASE_SELECTOR+','+FORM_SELECTOR:BASE_SELECTOR,exclusions:config.excludeSelectors||[],max:config.maxInteractives||300});
    let rows=await capture();
    // An already-open exploratory state may mount its list asynchronously.
    // This is read-only polling: inventory/planning never opens a widget here.
    const budget=config._runtime?.budget,deadline=Date.now()+Math.min(1500,config.actionTimeoutMs??1500,budget?.remainingMs??1500);
    while(rows.some(meta=>meta.role==='combobox'&&meta.expanded==='true'&&!meta.ariaChoices)&&Date.now()<deadline){
      budget?.check();if(config._policy&&!config._policy.navigation(frame.url()).allow)break;
      if(budget)await budget.pause(Math.min(50,Math.max(1,deadline-Date.now())));else await new Promise(resolve=>setTimeout(resolve,Math.min(50,Math.max(1,deadline-Date.now()))));rows=await capture();
    }
    for(const meta of rows){
      meta.type=typeOf(meta);meta.framePath=fpath;meta.frameUrl=url;
      meta.label=meta.text||meta.placeholder||meta.aria||meta.title||meta.href||meta.tag;
      if(meta.type==='text'&&!config.fillText&&!config.formExplore&&!config.actionProfile)continue;
      if(meta.htmlType==='search'&&!config.actionProfile)continue;
      const textExcluded=(config.excludeTextPatterns||[]).some(p=>[meta.text,meta.aria,meta.title].join(' ').toLowerCase().includes(p.toLowerCase()));
      const skip=(config.skipTextPatterns||[]).some(p=>[meta.text,meta.aria,meta.title,meta.href].join(' ').toLowerCase().includes(p.toLowerCase()));
      meta.excluded ||= textExcluded;
      meta.skipped=meta.excluded||skip;
      if(config._policy){const decision=config._policy.action(meta);meta.skipped ||= !decision.allow;meta.skipReason=meta.excluded?'excluded_selector':decision.reason;meta.safeReplay=decision.allow && config.actionProfile==='safe' && !meta.formAction;}
      else if(meta.excluded)meta.skipReason='excluded_selector';
      result.push(meta);
    }
    if(rows.length>=(config.maxInteractives||300))emit('coverage_gap',{reason:'max_interactives',url});
  }
  if(frames.length>(config.maxFrames||12))emit('coverage_gap',{reason:'max_frames',count:frames.length});
  return result;
}
export function locate(page,el) {
  const frame=frameFor(page,el);
  if(el.selector?.startsWith('role::')){const [,role,...name]=el.selector.split('::');try{return frame.getByRole(role,{name:JSON.parse(name.join('::')),exact:false})}catch{}}
  return frame.locator(el.selector||el.fallbackSelector);
}
// Re-evaluate safety on the live target, including ancestors across shadow boundaries.
export async function checkLiveAction(page,el,config) {
  const locator=locate(page,el);
  const meta=await locator.evaluate((element,exclusions)=>{
    let current=element,excluded=false;
    while(current){if(exclusions.some(sel=>current.matches(sel)||current.closest(sel)))excluded=true;current=current.getRootNode()?.host||null;}
    const form=element.form||element.closest('form');return {excluded,aria:element.getAttribute('aria-label'),title:element.getAttribute('title'),text:(element.innerText||element.textContent||'').trim(),
      href:element.href||'',htmlType:(element.type||'').toLowerCase(),formAction:form?.action||null,formMethod:form?.method||null};
  },config.excludeSelectors||[]);
  const decision=config._policy?.action({...el,...meta,label:meta.text||meta.aria||meta.title||el.label})||{allow:!meta.excluded,reason:'excluded_selector'};
  if(!decision.allow)throw Object.assign(new Error(decision.reason),{name:'PolicyError',reason:decision.reason});
  return locator;
}
