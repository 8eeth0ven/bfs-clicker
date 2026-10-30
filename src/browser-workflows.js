// Trusted local workflow specifications. No selectors/code come from call params.
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,statSync} from 'node:fs';
import path from 'node:path';
import {normalizeConfig} from './asset.js';
import {acquireLock,atomicJson,openStore} from './store.js';
import {createBudget,StopError} from './budget.js';
import {createPolicy} from './policy.js';
import {launchGuardedBrowser} from './browser.js';
import {makeDialogs} from './dialogs.js';
import {authenticationStatus} from './auth.js';
import {createEvidence} from './evidence.js';
import {locate,checkLiveAction,frameFor} from './discover.js';
import {gotoStep} from './replay.js';
import {assertWorkflowPermission} from './workflow-permissions.js';
import {visualAction,visualRegion,approveVisualStep,overlap,canvasObservation,visualText,groundVisualStep,visualPoint} from './browser-visual.js';
import {readBrowserSource,checkedBrowserRunDir,browserOperationDestination,readBrowserVisibleOutput,boundBrowserVisibleOutput} from './browser-capabilities.js';

const require=createRequire(new URL('../gateway/package.json',import.meta.url)),Ajv=require('ajv/dist/2020.js').default;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>JSON.parse(JSON.stringify(value));
const stable=value=>Array.isArray(value)?value.map(stable):plain(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const size=value=>Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value));
const fail=(code,message)=>{throw Object.assign(new Error(message),{code})};
const idPattern=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/,capPattern=/^workflow_[a-f0-9]{64}$/;
const within=(root,file)=>{const rel=path.relative(root,file);return rel===''||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel)};
const abortCheck=signal=>{if(signal?.aborted)fail('CANCELLED','workflow任务已取消')};
const writeOutcome=status=>({status,automaticRetry:false});
function annotateWriteError(error,spec,attempted=false){if(spec?.effect==='write')error.writeOutcome=writeOutcome(attempted||error.writeOutcome?.status==='unknown'?'unknown':'not_started');return error;}


function localJson(file,max=131072){
  const absolute=path.resolve(file),info=lstatSync(absolute),actual=realpathSync(absolute);
  if(info.isSymbolicLink()||!info.isFile()||info.size>max)fail('SPEC_REJECTED','规范必须为预算内的本地普通JSON文件');
  let value;try{value=JSON.parse(readFileSync(actual,'utf8'))}catch{fail('SPEC_INVALID','规范不是有效JSON')}
  return {file:actual,value,digest:hash(value)};
}
function locatorSpec(value){
  if(!plain(value)||typeof value.selector!=='string'||!value.selector||value.selector.length>2048||value.framePath!=null&&(!Array.isArray(value.framePath)||value.framePath.length>12||value.framePath.some(n=>!Number.isSafeInteger(n)||n<0)))fail('SPEC_INVALID','需要固定selector与有效framePath');
  return {...clone(value),framePath:value.framePath||[]};
}
function prepare(raw,source){
  if(!plain(raw)||raw.schemaVersion!==1||!idPattern.test(raw.id||'')||!['read','write'].includes(raw.effect))fail('SPEC_INVALID','workflow需要schemaVersion=1、id及明确effect=read/write声明');
  if(!plain(raw.inputSchema)||raw.inputSchema.type!=='object'||!plain(raw.inputSchema.properties)||raw.inputSchema.additionalProperties!==false||size(raw.inputSchema)>32768)fail('INPUT_SCHEMA_INVALID','inputSchema必须为有界且拒绝额外参数的object schema');
  const inputSchema=clone(raw.inputSchema);if(Object.keys(inputSchema.properties).some(name=>!idPattern.test(name)||/password|passwd|secret|token|cookie|authorization|session/i.test(name)))fail('INPUT_SCHEMA_INVALID','凭据不能作为公开可变参数');let schemaNodes=0;
  const clean=(value,depth=0)=>{if(++schemaNodes>2000||depth>16)fail('INPUT_SCHEMA_INVALID','输入schema超过结构预算');if(Array.isArray(value))return value.map(v=>clean(v,depth+1));if(plain(value)){const result=Object.create(null);for(const [key,item]of Object.entries(value)){if(['$ref','$id','$async','__proto__','constructor','prototype'].includes(key))fail('INPUT_SCHEMA_INVALID','输入schema不能带引用、异步或原型键');if(['default','example','examples'].includes(key))continue;result[key]=clean(item,depth+1);}return result;}return value;};
  const schema=clean(inputSchema),ajv=new Ajv({strict:false,allErrors:true,validateFormats:false});if(hash(source.scrub(schema))!==hash(schema))fail('INPUT_SCHEMA_INVALID','公开schema包含需脱敏的秘密值');let validate;
  const entry={url:raw.entry?.url||source.config.startUrl,anchors:(raw.entry?.anchors||[]).map(locatorSpec)};
  if(!entry.anchors.length||entry.anchors.length>20||!createPolicy(source.config).navigation(entry.url).allow)fail('ENTRY_REJECTED','入口需要原范围内固定URL与1–20个锚点');
  if(!Array.isArray(raw.steps)||!raw.steps.length||raw.steps.length>30)fail('SPEC_INVALID','需要1–30个固定步骤');
  const steps=raw.steps.map((value,index)=>{
    const step=locatorSpec(value);if(!['fill','click','select','check','choose','visualClick','visualFill'].includes(step.kind))fail('SPEC_INVALID','不支持该步骤类型');
    if(['click','visualClick'].includes(step.kind)&&(Object.hasOwn(step,'param')||Object.hasOwn(step,'value')))fail('SPEC_INVALID','固定click不能声明未使用的输入绑定');
    if(!source.config.actionAllowlist.includes(step.selector))fail('ACTION_NOT_APPROVED','所有步骤selector必须在原actionAllowlist明确批准');
    if(!['click','visualClick'].includes(step.kind)&&(Object.hasOwn(step,'param')===Object.hasOwn(step,'value')))fail('SPEC_INVALID','输入步骤必须且只能选择param或固定value');
    if(step.param!=null&&(!Object.hasOwn(schema.properties,step.param)||!idPattern.test(step.param)))fail('SPEC_INVALID','参数绑定必须引用声明的顶层字段');
    if(['visualClick','visualFill'].includes(step.kind)){step.visual=visualAction(step.visual,step.kind);approveVisualStep(step,source.config,raw.effect);}
    else if(step.visual!==undefined)fail('VISUAL_SPEC_INVALID','普通DOM步骤不接受视觉执行参数');
    if(step.kind==='choose'){
      const property=schema.properties[step.param],domain=property&&Object.hasOwn(property,'const')?[property.const]:property?.enum;
      if(!step.param||property?.type!=='string'||!Array.isArray(domain)||!domain.length||domain.length>200||domain.some(value=>typeof value!=='string'||value.length>512)||new Set(domain).size!==domain.length||!plain(step.choices)||Object.keys(step.choices).length!==domain.length||domain.some(value=>!Object.hasOwn(step.choices,value)))fail('SPEC_INVALID','choose需要有限string枚举与完整可信choices映射');
      const choices=Object.create(null),seen=new Set();
      for(const wire of domain){const target=locatorSpec({...step.choices[wire],framePath:step.choices[wire]?.framePath??step.framePath});if(hash(target.framePath)!==hash(step.framePath)||seen.has(target.selector))fail('SPEC_INVALID','choose选项必须同frame且locator不能重复');if(!source.config.actionAllowlist.includes(target.selector))fail('ACTION_NOT_APPROVED','choose所有option selector必须在原actionAllowlist明确批准');seen.add(target.selector);choices[wire]={selector:target.selector,framePath:target.framePath};}
      step.choices=choices;
      if(step.timeoutMs!=null&&(!Number.isSafeInteger(step.timeoutMs)||step.timeoutMs<0||step.timeoutMs>10000))fail('SPEC_INVALID','choose timeoutMs必须为0–10000');
      if(step.selection!=null){
        if(!plain(step.selection)||Object.keys(step.selection).some(key=>!['selector','framePath','attribute'].includes(key))||!['data-value','value'].includes(step.selection.attribute))fail('SPEC_INVALID','selection需要固定data-value/value属性');
        const target=locatorSpec({selector:step.selection.selector??step.selector,framePath:step.selection.framePath??step.framePath});if(hash(target.framePath)!==hash(step.framePath))fail('SPEC_INVALID','selection必须与combobox同frame');
        step.selection={selector:target.selector,framePath:target.framePath,attribute:step.selection.attribute};
      }
    }
    return {...step,index};
  });
  if(source.config.actionProfile!=='forms'||steps.some(step=>['fill','visualFill'].includes(step.kind))&&!source.config.fillText||!source.config.requestAllowlist.length)fail('WORKFLOW_NOT_APPROVED','原配置必须forms、填值批准及明确requestAllowlist');
  if(!Array.isArray(raw.assertions)||!raw.assertions.length||raw.assertions.length>20||!Array.isArray(raw.extract)||!raw.extract.length||raw.extract.length>5)fail('SPEC_INVALID','需要结果断言与1–5个有界提取目标');
  const assertions=raw.assertions.map(value=>{
    const item=locatorSpec(value);
    if(item.visual!==undefined){
      if(!plain(item.visual)||Object.keys(item.visual).some(key=>key!=='region'))fail('VISUAL_SPEC_INVALID','视觉结果须有固定区域');item.visual={region:visualRegion(item.visual.region)};
      if(!source.config.visual)fail('VISUAL_NOT_CONFIGURED','视觉结果须启用本地OCR');
      if(item.textIncludesParam!=null&&steps.some(step=>step.kind==='visualFill'&&step.selector===item.selector&&hash(step.framePath)===hash(item.framePath)&&overlap(step.visual.valueRegion,item.visual.region)))fail('RESULT_TARGET_INVALID','视觉结果区域不得重叠本参数输入回读区域');
    }
    if(item.textIncludesParam!=null&&!Object.hasOwn(schema.properties,item.textIncludesParam))fail('SPEC_INVALID','结果断言引用未声明参数');
    if(item.paramRepresentation!=null&&!['value','optionLabel'].includes(item.paramRepresentation))fail('SPEC_INVALID','参数文本表示无效');
    if((item.paramRepresentation!=null||item.paramValueMap!=null||item.paramSeparator!=null)&&item.textIncludesParam==null)fail('SPEC_INVALID','参数文本表示必须关联实际参数');
    const property=item.textIncludesParam==null?null:schema.properties[item.textIncludesParam];
    if(item.paramRepresentation==='optionLabel'&&(!steps.some(step=>step.param===item.textIncludesParam&&['select','choose'].includes(step.kind))||steps.filter(step=>step.param===item.textIncludesParam).length!==1||item.paramValueMap!=null))fail('SPEC_INVALID','optionLabel必须关联唯一select/choose且不能同时声明valueMap');
    if(item.paramSeparator!=null&&(typeof item.paramSeparator!=='string'||item.paramSeparator.length>32||property?.type!=='array'))fail('SPEC_INVALID','数组参数分隔符无效');
    if(item.paramValueMap!=null){
      if(!plain(property))fail('SPEC_INVALID','valueMap需要标量输入schema');
      const domain=Object.hasOwn(property,'const')?[property.const]:Array.isArray(property.enum)?property.enum:property.type==='boolean'?[true,false]:null;
      if(!plain(item.paramValueMap)||!plain(property)||!domain||!domain.length||domain.length>20||domain.some(value=>!['string','number','boolean'].includes(typeof value))||Object.keys(item.paramValueMap).length!==new Set(domain.map(String)).size||Object.keys(item.paramValueMap).some(key=>['__proto__','constructor','prototype'].includes(key)||typeof item.paramValueMap[key]!=='string'||item.paramValueMap[key].length>512)||domain.some(value=>!Object.hasOwn(item.paramValueMap,String(value)))||hash(source.scrub(item.paramValueMap))!==hash(item.paramValueMap))fail('SPEC_INVALID','valueMap必须有界、无秘密并覆盖完整boolean/枚举/常量域');
    }

    if(item.changedFromBefore!=null&&typeof item.changedFromBefore!=='boolean')fail('SPEC_INVALID','changedFromBefore必须为boolean');
    if(item.timeoutMs!=null&&(!Number.isSafeInteger(item.timeoutMs)||item.timeoutMs<0||item.timeoutMs>10000))fail('SPEC_INVALID','断言timeoutMs必须为0–10000毫秒');
    if(item.textIncludes==null&&item.textIncludesParam==null&&item.count==null&&item.changedFromBefore!==true)fail('SPEC_INVALID','结果断言不能为空');
    if(item.count!=null&&(!Number.isSafeInteger(item.count)||item.count<0||item.count>50))fail('SPEC_INVALID','断言count无效');
    if(item.count===0&&(item.textIncludes!=null||item.textIncludesParam!=null))fail('SPEC_INVALID','不存在目标不能证明文本或参数关联');
    return item;
  });
  const extract=raw.extract.map(value=>{
    const item=locatorSpec(value);if(!idPattern.test(item.name||'')||!['text','table','visualText'].includes(item.kind))fail('SPEC_INVALID','提取需要name与text/table/visualText类型');
    if(item.kind==='visualText'){
      if(!plain(item.visual)||Object.keys(item.visual).some(key=>key!=='region'))fail('VISUAL_SPEC_INVALID','视觉提取需要固定区域');item.visual={region:visualRegion(item.visual.region)};
      if(!source.config.visual)fail('VISUAL_NOT_CONFIGURED','视觉提取须启用本地OCR');
      if(steps.some(step=>step.kind==='visualFill'&&step.selector===item.selector&&hash(step.framePath)===hash(item.framePath)&&overlap(step.visual.valueRegion,item.visual.region)))fail('RESULT_TARGET_INVALID','提取不能返回视觉输入区域');
    }else if(item.visual!==undefined)fail('VISUAL_SPEC_INVALID','DOM提取不能声明视觉区域');return item;
  });
  const params=[...new Set(steps.map(step=>step.param).filter(Boolean))];if(!params.length)fail('SPEC_INVALID','参数化workflow至少绑定一个参数');
  if(Object.keys(schema.properties).some(name=>!params.includes(name)))fail('SPEC_INVALID','公开输入字段必须绑定到实际步骤');
  for(const name of params)if(!assertions.some(item=>item.textIncludesParam===name))fail('ASSERTION_REQUIRED','每个可变参数需要对应结果断言');
  if(steps.some(step=>step.kind==='visualClick')){
    if(!['click','visualClick'].includes(steps.at(-1).kind))fail('VISUAL_TRIGGER_REQUIRED','包含视觉点击的流程须以固定触发点击结束');
    for(const name of params)if(!assertions.some(item=>item.textIncludesParam===name&&item.changedFromBefore===true))fail('ASSERTION_REQUIRED','视觉触发的每个参数需要独立结果变化断言');
  }
  if(schema.required!=null&&!Array.isArray(schema.required))fail('INPUT_SCHEMA_INVALID','required必须为字段数组');schema.required=[...new Set([...(schema.required||[]),...params])];
  try{validate=ajv.compile(schema)}catch{fail('INPUT_SCHEMA_INVALID','输入schema不能编译')}
  if(raw.networkEvidence!=null&&!['optional','required'].includes(raw.networkEvidence))fail('SPEC_INVALID','networkEvidence必须为optional或required');
  const spec={schemaVersion:1,id:raw.id,name:String(raw.name||raw.id).slice(0,160),description:String(raw.description||(raw.effect==='write'?'已真实样例验证的受控浏览器写流程':'已真实样例验证的受控浏览器查询')).slice(0,500),effect:raw.effect,networkEvidence:raw.networkEvidence||'optional',inputSchema:schema,entry,steps,assertions,extract};
  const checkParams=params=>{if(!plain(params)||size(params)>4096||!validate(params))fail('PARAMS_INVALID','输入不符合workflow声明schema');for(const step of steps){const value=step.param?params[step.param]:step.value;if(['fill','visualFill'].includes(step.kind)&&!['string','number'].includes(typeof value)||step.kind==='check'&&typeof value!=='boolean'||step.kind==='choose'&&typeof value!=='string'||step.kind==='select'&&!(typeof value==='string'||Array.isArray(value)&&value.length<=20&&value.every(item=>typeof item==='string')))fail('PARAMS_INVALID','参数类型与固定UI步骤不兼容');}return clone(params);};
  return {spec,params,checkParams};
}

async function inspect(page,target,config,{text=false,timeout}={}){
  const frame=frameFor(page,target),frameUrl=new URL(frame.url());if(!config._policy.navigation(frameUrl.href).allow)fail('FRAME_OUT_OF_SCOPE','固定frame超出原导航范围');
  const locator=locate(page,target);if(await locator.count()!==1)fail('LOCATOR_CHANGED','固定控件或结果目标不再唯一');
  const metadata=await locator.evaluate((element,exclusions)=>{
    let current=element;while(current){if(exclusions.some(sel=>current.matches(sel)||current.closest(sel)))return {excluded:true};current=current.getRootNode()?.host||null;}
    const clean=value=>String(value||'').replace(/\s+/g,' ').trim().slice(0,160),form=element.form||element.closest('form'),ancestors=[];current=element;
    for(let n=0;current&&n<10;n++){let index=1;for(let s=current.previousElementSibling;s;s=s.previousElementSibling)if(s.tagName===current.tagName)index++;ancestors.push([current.tagName,current.id||'',index]);current=current.parentElement||current.getRootNode()?.host||null;}
    return {tag:element.tagName.toLowerCase(),htmlType:(element.type||'').toLowerCase(),role:element.getAttribute('role')||'',name:element.getAttribute('name')||'',aria:element.getAttribute('aria-label')||'',title:element.getAttribute('title')||'',placeholder:element.getAttribute('placeholder')||'',text:clean(element.innerText||element.textContent),href:element.href||'',formAction:form?.action||null,formMethod:form?.method||null,editable:element.isContentEditable,constraints:{required:!!element.required,pattern:element.getAttribute('pattern'),min:element.getAttribute('min'),max:element.getAttribute('max'),minLength:element.getAttribute('minlength'),maxLength:element.getAttribute('maxlength'),step:element.getAttribute('step'),multiple:!!element.multiple},ancestors,options:element.tagName==='SELECT'?Array.from(element.options).slice(0,201).map(option=>[option.value,clean(option.text)]):null};
  },config.excludeSelectors||[],timeout==null?{}:{timeout});
  if(metadata.excluded)fail('ACTION_EXCLUDED','原excludeSelectors排除此目标');
  const contract={...metadata,frame:frameUrl.origin+frameUrl.pathname};if(!text)delete contract.text;
  if(target.tag&&metadata.tag!==target.tag.toLowerCase())fail('ANCHOR_CHANGED','固定锚点tag发生变化');
  return {locator,metadata,contract};
}
// Read-only ARIA checks. A trusted finite choice map may precede lazy DOM mount.
async function inspectChoiceControl(page,step,config){
  const control=await inspect(page,step,config);if(control.metadata.role!=='combobox')fail('CONTROL_CHANGED','choose步骤需要role=combobox');
  const relation=await control.locator.evaluate(element=>{
    const id=(element.getAttribute('aria-controls')||'').trim(),roots=[];const visit=root=>{roots.push(root);for(const node of root.querySelectorAll('*'))if(node.shadowRoot)visit(node.shadowRoot);};visit(document);
    if(!id||/\s/.test(id))return null;
    const matches=roots.flatMap(root=>Array.from(root.querySelectorAll('[id]')).filter(node=>node.id===id));
    if(matches.length>1||matches.length===1&&(matches[0].getAttribute('role')!=='listbox'||matches[0].getRootNode()!==element.getRootNode()))return null;
    return {controlsId:id,readOnly:element.getAttribute('aria-readonly')==='true'||!!element.readOnly,disabled:element.getAttribute('aria-disabled')==='true'||!!element.disabled,required:element.getAttribute('aria-required')==='true'||!!element.required,mounted:matches.length===1};
  });
  if(!relation||relation.readOnly||relation.disabled)fail('ARIA_RELATION_CHANGED','combobox需要固定唯一同tree listbox关联');
  const {mounted,...identity}=relation;return {control,identity,mounted};
}
async function inspectChoices(page,step,config){
  const base=await inspectChoiceControl(page,step,config),{control}=base;
  if(!base.mounted)fail('ARIA_OPTIONS_PENDING','等待listbox挂载');
  const relation=await control.locator.evaluate(element=>{
    const list=element.getRootNode().getElementById(element.getAttribute('aria-controls')),options=Array.from(list.querySelectorAll('[role="option"]')).filter(node=>node.closest('[role="listbox"]')===list);
    const sizes=options.map(node=>node.getAttribute('aria-setsize')),positions=options.map(node=>node.getAttribute('aria-posinset')),declared=sizes.some(value=>value!=null)||positions.some(value=>value!=null);
    return {listboxTag:list.tagName.toLowerCase(),listboxRole:list.getAttribute('role'),count:options.length,busy:list.getAttribute('aria-busy')==='true',complete:!declared||sizes.every(value=>Number(value)===options.length)&&positions.every(value=>Number.isSafeInteger(Number(value))&&Number(value)>0&&Number(value)<=options.length)&&new Set(positions.map(Number)).size===options.length};
  });
  if(!relation.complete&&relation.count<Object.keys(step.choices).length)fail('ARIA_OPTIONS_PENDING','等待完整已声明ARIA域');
  if(!relation.complete)fail('ARIA_OPTIONS_INCOMPLETE','ARIA虚拟化/部分选项不能证明完整有限域');
  if(relation.count>Object.keys(step.choices).length)fail('ARIA_RELATION_CHANGED','listbox出现未绑定选项');
  if(relation.busy||relation.count<Object.keys(step.choices).length)fail('ARIA_OPTIONS_PENDING','等待完整选项挂载');
  const choices=[],labels=new Map(),indices=new Set();
  for(const [wire,target]of Object.entries(step.choices)){
    config._runtime.budget.check();const found=await inspect(page,target,config,{text:true}),link=await found.locator.evaluate(element=>{
      const list=element.closest('[role="listbox"]');return {role:element.getAttribute('role'),owner:list?.id,disabled:element.getAttribute('aria-disabled')==='true'||!!element.disabled,index:list?Array.from(list.querySelectorAll('[role="option"]')).filter(node=>node.closest('[role="listbox"]')===list).indexOf(element):-1,wire:element.getAttribute('data-value')??element.getAttribute('value')};
    });
    if(link.role!=='option'||link.owner!==base.identity.controlsId||link.disabled||link.index<0||indices.has(link.index)||link.wire!=null&&link.wire!==wire)fail('ARIA_RELATION_CHANGED','option必须唯一属于受控listbox且wire契约一致');
    if((config.excludeTextPatterns||[]).some(pattern=>[found.metadata.text,found.metadata.aria,found.metadata.title].join(' ').toLowerCase().includes(pattern.toLowerCase())))fail('ACTION_EXCLUDED','原excludeTextPatterns排除此option');
    indices.add(link.index);labels.set(wire,found.metadata.text);await checkLiveAction(page,{...found.metadata,...target,type:'click',kind:'click',label:found.metadata.text||found.metadata.aria},config);
    choices.push({value:wire,contract:found.contract,index:link.index,wire:link.wire});
  }
  return {control,labels,contract:{control:control.contract,relation:{...base.identity,...relation},choices}};
}
async function waitAria(check,config,{timeoutMs=3000,signal,auth}={}){
  const budget=config._runtime.budget,deadline=performance.now()+timeoutMs;let nextAuth=0;
  for(;;){
    budget.check();abortCheck(signal);if(config._runtime.dialogRejected||config._runtime.blockedRequests.length)fail('WORKFLOW_POLICY_BLOCKED','等待ARIA控件时触发未批准请求');
    if(auth&&performance.now()>=nextAuth){await auth();nextAuth=performance.now()+1000;}
    try{const result=await check();if(result)return result;}catch(error){if(error.code!=='ARIA_OPTIONS_PENDING')throw error;}
    if(performance.now()>=deadline)fail('ARIA_WAIT_TIMEOUT','ARIA选项或选择状态等待超时');await budget.pause(Math.max(1,Math.min(50,deadline-performance.now(),budget.remainingMs)));
  }
}
async function selectionProof(page,step,config){
  const target=await inspect(page,step.selection,config),value=await target.locator.getAttribute(step.selection.attribute);
  if(value==null)fail('CONTROL_CHANGED','选择证明目标缺少可信固定属性');
  return {value,contract:target.contract};
}
// Only snapshots/digests remain in memory; baseline business text is never exported.
async function resultCanvasObservation(found,target,config,cache){
  if(!cache)return canvasObservation(found,config,{signal:config._runtime.signal});
  const key=JSON.stringify([target.selector,target.framePath||[]]);
  let current=await found.locator.elementHandle();if(!current)fail('VISUAL_RESULT_TARGET_CHANGED','视觉结果宿主已移除');
  try{
    const entry=cache.get(key);
    if(entry){if(!await current.evaluate((element,previous)=>element===previous,entry.handle))fail('VISUAL_RESULT_TARGET_CHANGED','同一结果轮次的视觉宿主已替换');return entry.observation;}
    // Capture the pinned node, so a selector cannot silently retarget while OCR
    // is in progress. A replacement must start a new, explicitly verified run.
    const observation=await canvasObservation({...found,locator:current},config,{signal:config._runtime.signal}),latest=await found.locator.elementHandle();
    try{if(!latest||!await latest.evaluate((element,previous)=>element===previous,current))fail('VISUAL_RESULT_TARGET_CHANGED','OCR期间视觉结果宿主已替换');}finally{await latest?.dispose();}
    cache.set(key,{handle:current,observation});current=null;return observation;
  }finally{await current?.dispose();}
}
async function closeVisualCache(cache){
  await Promise.allSettled([...cache.values()].map(entry=>entry.handle.dispose()));cache.clear();
}
async function changedBaselines(page,spec,config){
  const baselines=[],cache=new Map(),budget=config._runtime.budget;
  try{for(let n=0;n<spec.assertions.length;n++)if(spec.assertions[n].changedFromBefore===true)baselines[n]=await assertionSnapshot(page,spec.assertions[n],config,Math.max(1,Math.min(config.actionTimeoutMs,budget.remainingMs)),cache);return baselines;}
  finally{await closeVisualCache(cache);}
}
async function assertionSnapshot(page,assertion,config,timeout,visualCache){
  const budget=config._runtime.budget;budget.check();
  const frame=frameFor(page,assertion);if(!config._policy.navigation(frame.url()).allow)fail('FRAME_OUT_OF_SCOPE','结果目标frame超出原导航范围');
  const loc=locate(page,assertion),count=await loc.count();
  if(count>1)fail('LOCATOR_CHANGED','结果目标不再唯一');
  if(count===0)return {count,visible:false,text:null,digest:hash({count,visible:false,text:null})};
  const target=await inspect(page,assertion,config,{timeout});
  if(['input','textarea','select'].includes(target.metadata.tag)||['combobox','listbox','option'].includes(target.metadata.role)||target.metadata.editable)fail('RESULT_TARGET_INVALID','不能把输入控件本身当结果断言');
  const visible=await loc.isVisible(),text=visible?(assertion.visual?visualText(await resultCanvasObservation(target,assertion,config,visualCache),assertion.visual.region,config.visual.minConfidence):(await loc.innerText({timeout}))).slice(0,32768):null;
  return {count,visible,text,digest:hash({count,visible,text})};
}
function parameterText(assertion,params,optionLabels){
  const value=params[assertion.textIncludesParam],labels=optionLabels.get(assertion.textIncludesParam);
  if(assertion.paramValueMap)return assertion.paramValueMap[String(value)];
  const values=Array.isArray(value)&&labels?[...labels.keys()].filter(wire=>value.includes(wire)):Array.isArray(value)?value:[value];
  if(assertion.paramRepresentation==='optionLabel'){
    if(!labels||(Array.isArray(value)?value:[value]).some(item=>!labels.has(item)))fail('PARAM_REPRESENTATION_UNAVAILABLE','select参数无法唯一解析为真实选项标签');
    return values.map(item=>labels.get(item)).join(assertion.paramSeparator??',');
  }
  return Array.isArray(value)?values.map(String).join(assertion.paramSeparator??','):String(value);
}
function assertionMatches(assertion,snapshot,params,baseline,optionLabels){
  if(assertion.count!=null&&snapshot.count!==assertion.count)return false;
  if(assertion.changedFromBefore===true&&(!baseline||snapshot.digest===baseline.digest))return false;
  if(assertion.count===0)return snapshot.count===0;
  if(snapshot.count!==1||!snapshot.visible)return false;
  return (assertion.textIncludes==null||snapshot.text.includes(String(assertion.textIncludes)))&&(assertion.textIncludesParam==null||snapshot.text.includes(parameterText(assertion,params,optionLabels)));
}
async function assertResults(page,spec,params,config,{baselines=[],triggerBaselines=[],auth,wait=true,signal,optionLabels=new Map()}={}){
  const budget=config._runtime.budget,started=performance.now(),deadlines=spec.assertions.map(assertion=>started+(assertion.timeoutMs??3000));let nextAuth=0;
  for(;;){
    budget.check();abortCheck(signal);
    if(!config._policy.navigation(page.url()).allow)fail('FRAME_OUT_OF_SCOPE','等待结果时页面离开原导航范围');
    if(config._runtime.dialogRejected||config._runtime.blockedRequests.length)fail('WORKFLOW_POLICY_BLOCKED','等待结果时触发未批准请求或原生确认');
    if(auth&&performance.now()>=nextAuth){await auth();nextAuth=performance.now()+1000;budget.check();}
    const snapshots=[],visualCache=new Map();let pending=false;
    try{for(let index=0;index<spec.assertions.length;index++){
      const remaining=Math.max(1,Math.min(config.actionTimeoutMs,budget.remainingMs,Math.max(100,deadlines[index]-performance.now()))),snapshot=await assertionSnapshot(page,spec.assertions[index],config,remaining,visualCache);snapshots.push(snapshot);
      if(assertionMatches(spec.assertions[index],snapshot,params,baselines[index],optionLabels)&&(!triggerBaselines[index]||snapshot.digest!==triggerBaselines[index].digest))continue;
      if(!wait||performance.now()>=deadlines[index])fail('RESULT_ASSERTION_FAILED','结果断言在本轮等待期限内未满足');
      pending=true;
    }}finally{await closeVisualCache(visualCache);}
    if(!pending)return snapshots;
    const remaining=Math.min(...deadlines.map(deadline=>deadline-performance.now()).filter(value=>value>0),50,budget.remainingMs);
    await budget.pause(Math.max(1,remaining));
  }
}
async function extractData(page,spec,config,scrub){
  const data=Object.create(null),visualCache=new Map();
  try{for(const item of spec.extract){const found=await inspect(page,item,config),{locator,metadata}=found;if(['input','textarea','select'].includes(metadata.tag)||['combobox','listbox','option'].includes(metadata.role)||metadata.editable)fail('RESULT_TARGET_INVALID','提取不能返回表单输入值');if(!await locator.isVisible())fail('RESULT_ASSERTION_FAILED','提取目标不可见');
    if(item.kind==='visualText'){data[item.name]={text:visualText(await resultCanvasObservation(found,item,config,visualCache),item.visual.region,config.visual.minConfidence).slice(0,1500),provenance:'local_ocr',untrusted:true};continue;}
    const value=await locator.evaluate((root,{kind,exclusions})=>{
      let visited=0,truncated=false;const hidden='script,style,noscript,template,input,textarea,select,[contenteditable],[hidden]';
      const visible=el=>{if(!el||el.closest(hidden))return false;let current=el;while(current){if(exclusions.some(sel=>current.matches(sel)||current.closest(sel)))return false;current=current.getRootNode()?.host||null;}const style=getComputedStyle(el),box=el.getBoundingClientRect();return style.visibility!=='hidden'&&style.display!=='none'&&box.width>0&&box.height>0&&(!el.checkVisibility||el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));};
      const text=(element,limit)=>{const walk=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node,out='';while((node=walk.nextNode())){if(++visited>3000){truncated=true;break;}if(!visible(node.parentElement))continue;const table=node.parentElement.closest('table');if(table&&table!==element.closest('table'))continue;out+=(out?' ':'')+String(node.textContent||'').replace(/\s+/g,' ').trim();if(out.length>limit){out=out.slice(0,limit);truncated=true;break;}}return out;};
      if(kind==='text'){if(root.closest('table'))throw Error('use table extraction');return {text:text(root,1500),truncated};}
      if(root.tagName!=='TABLE')throw Error('not table');let columns=[],rows=[],sensitive=new Set(),scanned=0;
      for(const row of root.rows){if(++scanned>80||rows.length>=6){truncated=true;break;}if(!visible(row))continue;const header=!columns.length&&!rows.length&&Array.from(row.cells).some(cell=>cell.tagName==='TH'),cells=Array.from(row.cells).slice(0,6).map((cell,index)=>!header&&sensitive.has(index)?'[REDACTED]':visible(cell)?text(cell,64):'');if(row.cells.length>6)truncated=true;if(header){columns=cells;columns.forEach((label,index)=>{if(/password|secret|token|cookie|authorization|api[-_ ]?key|密码|密钥|令牌/i.test(label))sensitive.add(index);});}else rows.push(cells);}
      return {columns,rows,truncated};
    },{kind:item.kind,exclusions:config.excludeSelectors||[]});
    data[item.name]=value;
  }
  const result=scrub.fragments(data);if(size(result)>4096)fail('OUTPUT_LIMIT','声明提取结果超过4KiB');return result;
  }finally{await closeVisualCache(visualCache);}
}

async function runQuery(source,prepared,params,outputDir,expectedContracts=null,signal,onActionAttempt){
  abortCheck(signal);const {spec}=prepared;prepared.checkParams(params);const out=browserOperationDestination(outputDir);
  if(within(source.root,out)||within(out,source.root)||existsSync(out))fail('OUTPUT_REJECTED','操作输出必须为来源之外的新目录');mkdirSync(path.dirname(out),{recursive:true,mode:0o700});
  const operationId=randomUUID(),config=normalizeConfig({...clone(source.config),outputDir:out,runId:operationId,sessionId:operationId,sessionWritebackTo:undefined,maxRetries:0,jsClickFallback:false,limitMode:'custom',maxStates:1,maxDepth:0,maxStatesPerHost:1,maxDurationMs:Math.min(source.config.maxDurationMs??30000,30000),maxRequests:Math.min(source.config.maxRequests??250,250),maxActions:Math.min(source.config.maxActions??100,100)},{baseDir:source.root});
  const store=openStore(config),budget=createBudget(config,store);let launched,dialogs,evidence,sessionRelease=()=>{},result,actionAttempted=false;
  const onAbort=()=>budget.stop('cancelled','partial');signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
  const runtime=config._runtime={emit:store.emit,budget,currentActionId:null,currentExecutionId:null,currentStateId:null,currentControl:'',blockedRequests:[],dialogRejected:false,workflowActive:false,workflowEffect:spec.effect,signal};
  const base=createPolicy(config,store.emit),policy={...base,request(info){const decision=base.request(info);if(decision.allow&&runtime.workflowActive&&['fetch','xhr','document'].includes(info.type)&&!base.allowRule(info.method,info.url,info.postData))return {allow:false,reason:'workflow_request_not_approved'};return decision;}};config._policy=policy;
  const contracts={anchors:[],steps:[],outputs:[]},executions=new Set(),optionLabels=new Map(),triggerBaselines=[];
  const compare=(actual,expected)=>{if(expected&&hash(actual)!==hash(expected))fail('CONTROL_CHANGED','控件结构、目标或静态契约发生变化');};
  const dispatch=async(page,step,found,index,kind,value,auth,suffix='')=>{
    budget.check();abortCheck(signal);budget.action();
    // A result already changed by typing must not certify a no-op trigger.
    // This is temporal evidence, not proof of arbitrary backend causality.
    if(index===spec.steps.length-1&&!suffix&&['click','visualClick'].includes(kind)&&spec.steps.some(item=>item.kind==='visualClick')){
      const fresh=await changedBaselines(page,spec,config);for(let n=0;n<fresh.length;n++)if(fresh[n])triggerBaselines[n]=fresh[n];
    }
    const action={...found.metadata,...step,id:'workflow:'+spec.id+':'+index+suffix,type:kind==='fill'?'text':kind==='select'?'select':kind==='check'?'checkbox':'click',kind:'click',label:step.visual?.anchor||found.metadata.text||found.metadata.aria||kind};
    const locator=await checkLiveAction(page,action,config),coordinate=['visualClick','visualFill'].includes(kind)?await visualPoint(page,found,found.visualGround,config):null;dialogs.invalidate();runtime.dialogRejected=false;runtime.blockedRequests=[];runtime.currentActionId=action.id;runtime.currentControl=action.label;
    runtime.currentExecutionId=store.emit('workflow_action_started',{workflowId:spec.id,actionId:action.id,step:index,kind});executions.add(runtime.currentExecutionId);
    const timeout=Math.max(1,Math.min(config.actionTimeoutMs,budget.remainingMs));
    if(!actionAttempted&&spec.effect==='write')atomicJson(path.join(out,'write-intent.json'),{effect:'write',...writeOutcome('unknown')},false);
    actionAttempted=true;onActionAttempt?.();
    if(kind==='visualClick'||kind==='visualFill'){
      await page.mouse.click(coordinate.x,coordinate.y);
      if(kind==='visualFill'){budget.check();abortCheck(signal);await page.keyboard.press('ControlOrMeta+A');budget.check();abortCheck(signal);await page.keyboard.press('Backspace');budget.check();abortCheck(signal);await page.keyboard.type(String(value));budget.check();abortCheck(signal);const after=await canvasObservation(found,config,{signal}),echo=visualText(after,step.visual.valueRegion,config.visual.minConfidence);if(echo!==String(value).replace(/\s+/g,' ').trim())fail('PARAM_VALUE_REJECTED','视觉输入未由独立区域实际回读确认');}
    }
    else if(kind==='fill')await locator.fill(String(value),{timeout});else if(kind==='select')await locator.selectOption(value,{timeout});else if(kind==='check')await locator.setChecked(value,{timeout});else if(suffix){const element=await locator.elementHandle({timeout});if(!element)fail('LOCATOR_CHANGED','ARIA点击目标已移除');try{await element.click({timeout});}finally{await element.dispose();}}else await locator.click({timeout});
    if(!['click','visualClick','visualFill'].includes(kind)){
      const live=await locator.evaluate(element=>({valid:element.validity?.valid!==false,value:element.isContentEditable?element.textContent:element.value,checked:element.checked,selected:element.tagName==='SELECT'?Array.from(element.selectedOptions).map(option=>option.value):null}));
      if(!live.valid||kind==='fill'&&live.value!==String(value)||kind==='check'&&live.checked!==value||kind==='select'&&hash([...live.selected].sort())!==hash((Array.isArray(value)?[...value]:[value]).sort()))fail('PARAM_VALUE_REJECTED','原生约束或实际控件值拒绝该输入');
    }
    await dialogs.handle();await dialogs.stabilize();await auth();budget.check();abortCheck(signal);if(runtime.dialogRejected||runtime.blockedRequests.length)fail('WORKFLOW_POLICY_BLOCKED','原生确认或请求批准规则阻止步骤');
    store.emit('workflow_action_finished',{workflowId:spec.id,actionId:action.id,executionId:runtime.currentExecutionId,step:index,status:'succeeded'});
  };
  try{
    if(config.storageState)sessionRelease=acquireLock(config.storageState+'.bfs.lock',{runId:operationId});evidence=createEvidence(config,store,budget,policy);
    budget.check();abortCheck(signal);launched=await launchGuardedBrowser(config,policy,budget,store);evidence.attach(launched.context);const page=await launched.context.newPage();page.setDefaultTimeout(config.actionTimeoutMs);dialogs=makeDialogs(page,config,()=>{});
    const auth=async()=>{const status=await authenticationStatus(page,launched.context,config,store);if(!status.ok)throw new StopError(status.reason,status.status);};
    await gotoStep(page,dialogs,spec.entry.url,config);await auth();
    for(let i=0;i<spec.entry.anchors.length;i++){const anchor=spec.entry.anchors[i],found=await inspect(page,anchor,config,{text:anchor.text!=null});if(!await found.locator.isVisible()||anchor.text!=null&&!found.metadata.text.includes(anchor.text))fail('ANCHOR_CHANGED','固定入口锚点不可见或文本已改变');contracts.anchors.push(found.contract);compare(found.contract,expectedContracts?.anchors[i]);}
    for(const target of [...spec.assertions.filter(item=>item.visual),...spec.extract.filter(item=>item.kind==='visualText')])for(const step of spec.steps.filter(item=>item.kind==='visualFill')){
      if(!overlap(target.visual.region,step.visual.valueRegion)||frameFor(page,target)!==frameFor(page,step))continue;
      const input=await inspect(page,step,config),output=await inspect(page,target,config),handle=await input.locator.elementHandle();
      try{if(handle&&await output.locator.evaluate((element,other)=>element===other,handle))fail('RESULT_TARGET_INVALID','视觉结果区域与输入回读区域重叠');}finally{await handle?.dispose();}
    }
    const baselines=await changedBaselines(page,spec,config);
    runtime.workflowActive=true;
    for(let i=0;i<spec.steps.length;i++){
      const step=spec.steps[i],found=await inspect(page,step,config,{text:step.kind==='click'}),value=step.param?params[step.param]:step.value;
      if((config.excludeTextPatterns||[]).some(pattern=>[found.metadata.text,found.metadata.aria,found.metadata.title].join(' ').toLowerCase().includes(pattern.toLowerCase())))fail('ACTION_EXCLUDED','原excludeTextPatterns排除此步骤');
      if(step.kind==='fill'&&(['password','hidden','file'].includes(found.metadata.htmlType)||!['input','textarea'].includes(found.metadata.tag)&&!found.metadata.editable))fail('UNSAFE_INPUT','该字段不能作为可变输入');
      if(step.kind==='select'&&found.metadata.tag!=='select')fail('CONTROL_CHANGED','select步骤需要原生select控件');
      if(step.kind==='select'&&step.param){
        const labels=new Map(),needsLabels=spec.assertions.some(assertion=>assertion.textIncludesParam===step.param&&assertion.paramRepresentation==='optionLabel');if(found.metadata.options.length>200)fail('PARAM_REPRESENTATION_UNAVAILABLE','选项标签超过结构预算');
        for(const [wire,label]of found.metadata.options){if(labels.has(wire)&&labels.get(wire)!==label&&needsLabels)fail('PARAM_REPRESENTATION_UNAVAILABLE','同一wire value对应多个标签');if(!labels.has(wire))labels.set(wire,label);}optionLabels.set(step.param,labels);
        if(needsLabels)parameterText({textIncludesParam:step.param,paramRepresentation:'optionLabel'},params,optionLabels);
      }
      if(['visualClick','visualFill'].includes(step.kind)){
        const expected=expectedContracts?.steps[i];compare(found.contract,expected&&Object.fromEntries(Object.entries(expected).filter(([key])=>key!=='visual')));
        const latestInputs=new Map();for(const item of spec.steps.slice(0,i).filter(item=>item.kind==='visualFill'&&item.selector===step.selector&&hash(item.framePath)===hash(step.framePath)))latestInputs.set(hash(item.visual.valueRegion),item);
        if(step.kind==='visualFill')latestInputs.delete(hash(step.visual.valueRegion));
        const precedingInputs=[...latestInputs.values()],inputMasks=precedingInputs.map(item=>item.visual.valueRegion);
        approveVisualStep(step,config,spec.effect);const ground=await groundVisualStep(found,step,config,{expected:expected?.visual,signal,inputMasks});found.visualGround=ground;contracts.steps.push({...found.contract,visual:ground.contract});
        for(const input of precedingInputs){const actual=visualText(ground.observation,input.visual.valueRegion,config.visual.minConfidence),wanted=String(input.param?params[input.param]:input.value).replace(/\s+/g,' ').trim();if(actual!==wanted)fail('PARAM_VALUE_CHANGED','视觉输入在后续动作前已改变，未发送动作');}
        await dispatch(page,{...step,label:step.visual.anchor},found,i,step.kind,value,auth);
      }else if(step.kind==='choose'){
        const initial=await inspectChoiceControl(page,step,config),expected=expectedContracts?.steps[i];compare(initial.control.contract,expected?.control);
        if(expected)compare(initial.identity,Object.fromEntries(['controlsId','readOnly','disabled','required'].map(key=>[key,expected.relation[key]])));
        const proofBefore=step.selection?await selectionProof(page,step,config):null;if(proofBefore)compare(proofBefore.contract,expected?.selection);
        let before=null;if(initial.mounted){try{before=await inspectChoices(page,step,config);compare(before.contract,expected&&{control:expected.control,relation:expected.relation,choices:expected.choices});}catch(error){if(error.code!=='ARIA_OPTIONS_PENDING')throw error;}}
        if(!await initial.control.locator.isVisible()||await initial.control.locator.getAttribute('aria-expanded')!=='false')fail('CONTROL_CHANGED','choose入口必须为可见明确折叠状态');
        await dispatch(page,step,initial.control,i,'click',undefined,auth,':open');
        const opened=await waitAria(()=>inspectChoices(page,step,config),config,{timeoutMs:step.timeoutMs,signal,auth});
        compare(opened.contract.control,initial.control.contract);compare(Object.fromEntries(['controlsId','readOnly','disabled','required'].map(key=>[key,opened.contract.relation[key]])),initial.identity);if(before)compare(opened.contract,before.contract);if(expected)compare(opened.contract,{control:expected.control,relation:expected.relation,choices:expected.choices});
        const contract={...opened.contract,...(proofBefore?{selection:proofBefore.contract}:{})};contracts.steps.push(contract);optionLabels.set(step.param,opened.labels);
        if(await opened.control.locator.getAttribute('aria-expanded')!=='true')fail('CONTROL_CHANGED','combobox未展开');
        const target=step.choices[value],chosen=await inspect(page,target,config,{text:true});compare(chosen.contract,opened.contract.choices.find(item=>item.value===value).contract);if(!await chosen.locator.isVisible())fail('CONTROL_CHANGED','本轮option不可见');
        await dispatch(page,target,chosen,i,'click',undefined,auth,':option');
        if(step.selection){await waitAria(async()=>{const proof=await selectionProof(page,step,config);compare(proof.contract,proofBefore.contract);const after=await inspectChoiceControl(page,step,config);compare(after.control.contract,initial.control.contract);compare(after.identity,initial.identity);return proof.value===value;},config,{timeoutMs:step.timeoutMs,signal,auth});}
        else{const selected=await chosen.locator.evaluate(element=>element.getAttribute('aria-selected')==='true');if(!selected)fail('PARAM_VALUE_REJECTED','ARIA option未确认选中');}
      }else{
        contracts.steps.push(found.contract);compare(found.contract,expectedContracts?.steps[i]);await dispatch(page,step,found,i,step.kind,value,auth);
      }
    }
    const asserted=await assertResults(page,spec,params,config,{baselines,triggerBaselines,auth,signal,optionLabels});await evidence.drain();budget.check();
    const approved=evidence.snapshot().apis.flatMap(api=>api.samples||[]).filter(sample=>sample.category==='observed_request'&&executions.has(sample.executionId)&&sample.status>=200&&sample.status<300&&base.allowRule(sample.method,sample.url,sample.postData));
    if(!approved.length&&spec.networkEvidence==='required')fail('NO_APPROVED_RESPONSE','未记录声明必需的已批准响应');
    for(let i=0;i<spec.extract.length;i++){const found=await inspect(page,spec.extract[i],config);contracts.outputs.push(found.contract);compare(found.contract,expectedContracts?.outputs[i]);}
    const data=await extractData(page,spec,config,source.scrub),output=await readBrowserVisibleOutput(page,config,policy,source.scrub);
    await dialogs.stabilize();await auth();const afterExtraction=await assertResults(page,spec,params,config,{baselines,triggerBaselines,auth,wait:false,signal,optionLabels});if(hash(asserted.map(snapshot=>snapshot.digest))!==hash(afterExtraction.map(snapshot=>snapshot.digest)))fail('RESULT_CHANGED_DURING_EXTRACTION','结果目标在提取期间变化，拒绝返回旧观察');budget.check();
    result=source.scrub({ok:true,status:'completed',operationId,data,output,...(spec.effect==='write'?{writeOutcome:writeOutcome('observed')}:{}),observation:{...budget.counts,...(runtime.visualStats?{visual:{...runtime.visualStats,ocrMs:Math.round(runtime.visualStats.ocrMs)}}:{}),approvedResponses:approved.length,networkObserved:approved.length>0,changedFromBeforeAssertions:spec.assertions.filter(assertion=>assertion.changedFromBefore===true).length,effect:spec.effect==='write'?'trusted_write_intent_not_business_commit_proof':'trusted_read_intent_not_side_effect_proof'},evidence:{eventsPath:path.join(out,'events.jsonl'),requestsPath:path.join(out,'requests.json'),networkObserved:approved.length>0,approvedResponses:approved.length,changedFromBeforeAssertions:spec.assertions.filter(assertion=>assertion.changedFromBefore===true).length}});result.output=boundBrowserVisibleOutput(result.output,Math.max(1024,Math.min(8192,16000-size({...result,output:{}}))));if(size(result)>16384)fail('OUTPUT_LIMIT','workflow结果超过16KiB');
    store.emit('workflow_assertions_passed',{workflowId:spec.id,assertions:spec.assertions.length,resultDigest:hash(data)});
  }catch(error){result={ok:false,status:error instanceof StopError?error.status:'failed',...(spec.effect==='write'?{writeOutcome:writeOutcome(actionAttempted?'unknown':'not_started')}:{}),error:{code:error.code||error.reason||budget.reason||'WORKFLOW_FAILED',message:'workflow未完成：'+(error.code||error.reason||budget.reason||'目标操作或提取失败')},evidence:{eventsPath:path.join(out,'events.jsonl'),requestsPath:path.join(out,'requests.json')}};store.emit('workflow_failed',{workflowId:spec.id,code:result.error.code});}
  finally{try{dialogs?.dispose();await evidence?.drain();await launched?.close();await evidence?.drain();await evidence?.export();store.update({status:result?.status||'failed',counts:budget.counts,finishedAt:new Date().toISOString()});atomicJson(path.join(out,'result.json'),result);}finally{signal?.removeEventListener('abort',onAbort);budget.dispose();sessionRelease();store.release();}}
  return {result,contracts,outputDir:out};
}

function certificateFile(root,id,revision){if(!capPattern.test(id)||!/^[a-f0-9]{64}$/.test(revision||''))fail('RECIPE_INVALID','workflow能力ID或revision无效');const dir=path.join(root,'private','browser-workflows');mkdirSync(dir,{recursive:true,mode:0o700});if(!within(root,realpathSync(dir)))fail('PATH_REJECTED','workflow私有目录越界');return path.join(dir,id+'.'+revision+'.json');}

export async function compileBrowserWorkflow({runDir,sourceId,specFile,outputDir,signal,permissions={}}={}){
  abortCheck(signal);
  const root=checkedBrowserRunDir(runDir),release=acquireLock(path.join(root,'.run.lock'),{task:'workflow_compile'});let buildRelease=()=>{},rawSpec=null,actionAttempted=false;
  try{
    const source=await readBrowserSource(root,sourceId);abortCheck(signal);const local=localJson(specFile);rawSpec=local.value;
    if(rawSpec?.effect==='write')assertWorkflowPermission(permissions,rawSpec.id,{learning:true});
    const prepared=prepare(rawSpec,source),samples=rawSpec.samples;
    if(!Array.isArray(samples)||samples.length<2||samples.length>5||new Set(samples.map(hash)).size!==samples.length)fail('VALIDATION_SAMPLES_REQUIRED','需要2–5组互不相同的真实验证输入');
    for(const sample of samples)prepared.checkParams(sample);for(const name of prepared.params){const property=prepared.spec.inputSchema.properties[name],fixed=Object.hasOwn(property,'const')||Array.isArray(property.enum)&&new Set(property.enum.map(hash)).size===1;if(!fixed&&new Set(samples.map(sample=>hash(sample[name]))).size<2)fail('VALIDATION_SAMPLES_REQUIRED','每个可变参数都必须在验证样本中变化');}
    const out=browserOperationDestination(outputDir||path.join(path.dirname(root),'.browser-workflow-builds',randomUUID()));if(within(root,out)||within(out,root))fail('OUTPUT_REJECTED','验证目录必须独立于原任务');mkdirSync(out,{recursive:true,mode:0o700});buildRelease=acquireLock(path.join(out,'.build.lock'));if(['manifest.json','recipes.json','validation.json'].some(file=>existsSync(path.join(out,file))))fail('OUTPUT_EXISTS','workflow验证输出已存在');
    const runs=[];let contracts=null;
    for(let index=0;index<samples.length;index++){abortCheck(signal);const run=await runQuery(source,prepared,samples[index],path.join(out,'sample-'+(index+1)),contracts,signal,()=>{actionAttempted=true});runs.push({params:clone(samples[index]),...run.result,outputDir:run.outputDir});if(!run.result.ok){atomicJson(path.join(out,'validation.json'),{status:'failed',runs,...(prepared.spec.effect==='write'?{writeOutcome:writeOutcome(actionAttempted?'unknown':'not_started')}:{} )});fail('WORKFLOW_VALIDATION_FAILED','真实样本验证失败：'+run.result.error.code);}contracts??=run.contracts;}abortCheck(signal);
    const id='workflow_'+hash([sourceId,prepared.spec.id]),recipe={schemaVersion:1,kind:'browser-workflow',sourceId,sourceRunId:source.meta.runId,sourceRevision:source.revision,capabilityId:id,specFile:local.file,specDigest:local.digest,spec:prepared.spec,contracts,validation:{runs:runs.map(run=>({operationId:run.operationId,params:run.params,resultDigest:hash(run.data),outputDir:run.outputDir}))}};recipe.revision=hash(recipe);
    const sourceRevision=hash([source.revision,recipe.revision]),capability=source.scrub({id,name:prepared.spec.name,description:prepared.spec.description,kind:'browser',inputSchema:prepared.spec.inputSchema,readiness:'ready',effect:prepared.spec.effect,revision:recipe.revision,gaps:prepared.spec.steps.some(step=>['visualClick','visualFill'].includes(step.kind))?['visual_parameter_constraints_not_observed','visual_control_semantics_not_inferred','post_trigger_change_is_temporal_evidence']:[],evidence:{kind:'live_workflow_validation',runs:runs.length,operationIds:runs.map(run=>run.operationId),networkObserved:runs.some(run=>run.observation.networkObserved),approvedResponses:runs.reduce((sum,run)=>sum+run.observation.approvedResponses,0),visualSteps:prepared.spec.steps.filter(step=>['visualClick','visualFill'].includes(step.kind)).length,visualAssertions:prepared.spec.assertions.filter(assertion=>assertion.visual).length,changedFromBeforeAssertions:prepared.spec.assertions.filter(assertion=>assertion.changedFromBefore===true).length,note:prepared.spec.effect==='write'?'write为启动配置明确授权的意图；样本真实写入，断言通过不保证任意后台提交语义':'read为可信声明；HTTP成功和断言通过不证明无业务副作用'}}),manifest={schemaVersion:1,source:{id:sourceId,kind:'web',revision:sourceRevision,runId:source.meta.runId,gaps:[]},capabilities:[capability]},recipes={[id]:recipe},validation={status:'validated',runs,...(prepared.spec.effect==='write'?{writeOutcome:writeOutcome('observed')}:{} )};
    const certificate=certificateFile(root,id,recipe.revision);if(existsSync(certificate)){if(hash(localJson(certificate,1048576).value.recipe)!==hash(recipe))fail('CERTIFICATE_CONFLICT','不可变验证记录冲突');}else atomicJson(certificate,{recipe,validated:true},false);
    atomicJson(path.join(out,'recipes.json'),recipes);atomicJson(path.join(out,'validation.json'),validation);atomicJson(path.join(out,'manifest.json'),manifest);
    return {manifest,recipes,validation};
  }catch(error){throw annotateWriteError(error,rawSpec,actionAttempted)}finally{buildRelease();release();}
}

export const validateBrowserWorkflow=compileBrowserWorkflow;
export async function executeBrowserWorkflow({runDir,recipe,params={},expectedRevision,outputDir,signal,permissions={}}={}){
  abortCheck(signal);
  if(!plain(recipe)||recipe.schemaVersion!==1||!capPattern.test(recipe.capabilityId||''))fail('RECIPE_INVALID','需要验证过的私有workflow recipe');
  const root=checkedBrowserRunDir(runDir),release=acquireLock(path.join(root,'.run.lock'),{task:'workflow_execute'});let executingSpec=recipe.spec,actionAttempted=false;
  try{
    const source=await readBrowserSource(root,recipe.sourceId);abortCheck(signal);const certificate=localJson(certificateFile(root,recipe.capabilityId,recipe.revision),1048576).value,canonical=certificate.recipe;
    if(!certificate.validated||hash(recipe)!==hash(canonical)||source.revision!==canonical.sourceRevision||expectedRevision!=null&&expectedRevision!==canonical.revision||localJson(canonical.specFile).digest!==canonical.specDigest)fail('SOURCE_CHANGED','原配置、workflow或验证契约已变化，请重新验证');
    executingSpec=canonical.spec;if(executingSpec.effect==='write')assertWorkflowPermission(permissions,executingSpec.id);
    const prepared=prepare(executingSpec,source);prepared.checkParams(params);
    const run=await runQuery(source,prepared,params,outputDir||path.join(path.dirname(root),'.browser-workflow-calls',randomUUID()),canonical.contracts,signal,()=>{actionAttempted=true});
    const result={...run.result,capabilityId:canonical.capabilityId,revision:canonical.revision};if(result.output)result.output=boundBrowserVisibleOutput(result.output,Math.max(1024,Math.min(8192,16000-size({...result,output:{}}))));if(size(result)>16384)fail('OUTPUT_LIMIT','workflow结果超过16KiB');return result;
  }catch(error){throw annotateWriteError(error,executingSpec,actionAttempted)}finally{release();}
}
