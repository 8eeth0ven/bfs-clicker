// Local pixel evidence supplements DOM contracts; OCR never supplies executable code.
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {observeImage} from './visual-observation.js';
import {visualPixelFingerprint,visualPointMasked,visualRegionsOverlap} from './visual-pixels.js';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const digest=data=>createHash('sha256').update(data).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const clean=text=>String(text).replace(/\s+/g,' ').trim();
export function visualRegion(value){
 if(!plain(value)||Object.keys(value).some(key=>!['x','y','width','height'].includes(key))||['x','y','width','height'].some(key=>typeof value[key]!=='number'||!Number.isFinite(value[key]))||value.x<0||value.y<0||value.width<=0||value.height<=0||value.x+value.width>1||value.y+value.height>1)fail('VISUAL_SPEC_INVALID','视觉区域须为图像内归一化矩形');
 return {x:value.x,y:value.y,width:value.width,height:value.height};
}
export function visualAction(value,kind){
 if(!plain(value)||Object.keys(value).some(key=>!['anchor','offset','valueRegion'].includes(key))||typeof value.anchor!=='string'||!clean(value.anchor)||value.anchor.length>128||/[\x00-\x1f]/.test(value.anchor))fail('VISUAL_SPEC_INVALID','视觉动作需要固定有界文字锚点');
 const offset=value.offset??{x:0,y:0};if(!plain(offset)||Object.keys(offset).some(key=>!['x','y'].includes(key))||['x','y'].some(key=>typeof offset[key]!=='number'||!Number.isFinite(offset[key])||Math.abs(offset[key])>1))fail('VISUAL_SPEC_INVALID','视觉目标偏移必须是固定归一化坐标');
 if(kind==='visualFill'&&!value.valueRegion||kind==='visualClick'&&value.valueRegion!==undefined)fail('VISUAL_SPEC_INVALID','视觉输入必须声明独立回读区域');
 return {anchor:clean(value.anchor),offset:{x:offset.x,y:offset.y},...(value.valueRegion?{valueRegion:visualRegion(value.valueRegion)}:{})};
}
export function normalizeVisualConfig(value){
 if(value==null)return null;
 if(!plain(value)||Object.keys(value).some(key=>!['engine','language','minConfidence','actionMinConfidence','actions','outputs','groups'].includes(key)))fail('VISUAL_CONFIG_INVALID','未知视觉配置');
 const engine=value.engine??{type:'tesseract'};
 if(!plain(engine)||!['tesseract','vision'].includes(engine.type)||Object.keys(engine).some(key=>!['type','executable','tessdataDir'].includes(key))||engine.type==='vision'&&(engine.tessdataDir!==undefined||typeof engine.executable!=='string'||!path.isAbsolute(engine.executable))||['executable','tessdataDir'].some(key=>engine[key]!==undefined&&(typeof engine[key]!=='string'||!path.isAbsolute(engine[key]))))fail('VISUAL_CONFIG_INVALID','OCR引擎只从可信配置取得');
 const language=value.language??'eng',minConfidence=value.minConfidence??0.6,actionMinConfidence=value.actionMinConfidence??minConfidence;
 if(typeof language!=='string'||!/^\w+(?:\+\w+)*$/.test(language)||language.length>128||typeof minConfidence!=='number'||!Number.isFinite(minConfidence)||minConfidence<0||minConfidence>1||typeof actionMinConfidence!=='number'||!Number.isFinite(actionMinConfidence)||actionMinConfidence<0||actionMinConfidence>1||!Array.isArray(value.actions??[])||(value.actions??[]).length>100||!Array.isArray(value.outputs??[])||(value.outputs??[]).length>100)fail('VISUAL_CONFIG_INVALID','视觉语言、置信度或动作预算无效');
 const actions=(value.actions??[]).map(item=>{
  if(!plain(item)||Object.keys(item).some(key=>!['selector','framePath','kind','visual','effect'].includes(key))||typeof item.selector!=='string'||!item.selector||item.selector.length>2048||!['visualFill','visualClick'].includes(item.kind)||!['read','write'].includes(item.effect)||item.framePath!==undefined&&(!Array.isArray(item.framePath)||item.framePath.length>12||item.framePath.some(n=>!Number.isSafeInteger(n)||n<0)))fail('VISUAL_CONFIG_INVALID','视觉动作须逐锚点批准意图');
  return {selector:item.selector,framePath:item.framePath||[],kind:item.kind,visual:visualAction(item.visual,item.kind),effect:item.effect};
 });
 const outputs=(value.outputs??[]).map(item=>{
  if(!plain(item)||Object.keys(item).some(key=>!['selector','framePath','region','label'].includes(key))||typeof item.selector!=='string'||!item.selector||item.selector.length>2048||item.framePath!==undefined&&(!Array.isArray(item.framePath)||item.framePath.length>12||item.framePath.some(n=>!Number.isSafeInteger(n)||n<0))||item.label!==undefined&&(typeof item.label!=='string'||item.label.length>120||/[\x00-\x1f]/.test(item.label)))fail('VISUAL_CONFIG_INVALID','视觉输出须为固定宿主与区域');
  return {selector:item.selector,framePath:item.framePath||[],region:visualRegion(item.region),...(item.label?{label:clean(item.label)}:{})};
 });
 if(new Set(outputs.map(item=>JSON.stringify([item.selector,item.framePath,item.region]))).size!==outputs.length)fail('VISUAL_CONFIG_INVALID','视觉输出区域重复');
 if(!Array.isArray(value.groups??[])||(value.groups??[]).length>100)fail('VISUAL_CONFIG_INVALID','视觉流程组必须为有界数组');
 const groupIds=new Set(),groups=(value.groups??[]).map(group=>{
  if(!plain(group)||Object.keys(group).some(key=>!['id','inputs','click','outputs'].includes(key))||typeof group.id!=='string'||!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(group.id)||['constructor','prototype','__proto__'].includes(group.id)||groupIds.has(group.id))fail('VISUAL_CONFIG_INVALID','视觉流程组需要唯一固定ID');
  groupIds.add(group.id);
  const indices=(items,max,count)=>Array.isArray(items)&&items.length>=1&&items.length<=count&&new Set(items).size===items.length&&items.every(index=>Number.isSafeInteger(index)&&index>=0&&index<max);
  if(!indices(group.inputs,actions.length,8)||!Number.isSafeInteger(group.click)||group.click<0||group.click>=actions.length||!indices(group.outputs,outputs.length,5))fail('VISUAL_CONFIG_INVALID','视觉流程组的动作或结果索引无效');
  const click=actions[group.click],inputs=group.inputs.map(index=>actions[index]),selected=group.outputs.map(index=>outputs[index]),sameHost=item=>item.selector===click.selector&&same(item.framePath,click.framePath);
  if(click.kind!=='visualClick'||click.effect!=='read'||inputs.some(input=>input.kind!=='visualFill'||input.effect!=='read'||!sameHost(input))||selected.some(output=>!sameHost(output)))fail('VISUAL_CONFIG_INVALID','视觉流程组仅关联同宿主已批准的只读输入、点击和结果');
  if(inputs.some((input,index)=>inputs.slice(index+1).some(other=>overlap(input.visual.valueRegion,other.visual.valueRegion)))||selected.some(output=>inputs.some(input=>overlap(input.visual.valueRegion,output.region))))fail('VISUAL_CONFIG_INVALID','视觉流程组的输入与结果区域不得重叠');
  return {id:group.id,inputs:[...group.inputs],click:group.click,outputs:[...group.outputs]};
 });
 return {engine:{...engine},language,minConfidence,actionMinConfidence,actions,outputs,groups};
}
export function approveVisualStep(step,config,effect){
 if(!config.visual||!config.visual.actions.some(item=>item.selector===step.selector&&same(item.framePath,step.framePath||[])&&item.kind===step.kind&&same(item.visual,step.visual)&&(item.effect==='read'||effect==='write')))fail('VISUAL_ACTION_NOT_APPROVED','视觉动作须由启动配置逐个固定锚点批准');
}
export const overlap=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
export function visualText(observation,region,minConfidence=0){
 const selected=observation.tokens.filter(token=>{
  const box={x:token.bounds.x/observation.width,y:token.bounds.y/observation.height,width:token.bounds.width/observation.width,height:token.bounds.height/observation.height};
  return token.confidence>=minConfidence&&box.width>0&&box.height>0&&box.x>=region.x&&box.y>=region.y&&box.x+box.width<=region.x+region.width&&box.y+box.height<=region.y+region.height;
 });
 return clean(selected.map(token=>token.text).join(' '));
}
function anchor(observation,text,minConfidence){
 const words=clean(text).split(' '),tokens=observation.tokens.filter(token=>token.confidence>=minConfidence),matches=[];
 for(let i=0;i<tokens.length;i++){
  const group=tokens.slice(i,i+words.length);if(group.length!==words.length||!group.every((token,j)=>token.text===words[j]))continue;
  if(group.some((token,j)=>j>0&&(Math.abs(token.bounds.y+token.bounds.height/2-group[0].bounds.y-group[0].bounds.height/2)>Math.max(token.bounds.height,group[0].bounds.height)/2||token.bounds.x<group[j-1].bounds.x+group[j-1].bounds.width||token.bounds.x-group[j-1].bounds.x-group[j-1].bounds.width>Math.max(token.bounds.height,group[j-1].bounds.height)*2)))continue;
  const left=Math.min(...group.map(t=>t.bounds.x)),top=Math.min(...group.map(t=>t.bounds.y)),right=Math.max(...group.map(t=>t.bounds.x+t.bounds.width)),bottom=Math.max(...group.map(t=>t.bounds.y+t.bounds.height));matches.push({x:left,y:top,width:right-left,height:bottom-top});
 }
 if(matches.length!==1)fail(matches.length?'VISUAL_ANCHOR_AMBIGUOUS':'VISUAL_ANCHOR_MISSING','OCR锚点须在当前画面唯一且达到置信度');
 return matches[0];
}
export async function canvasObservation(found,config,{signal}={}){
 if(!config.visual)fail('VISUAL_NOT_CONFIGURED','需要可信本地OCR配置');
 const {locator,metadata}=found,budget=config._runtime.budget;budget.check();signal?.throwIfAborted();
 if(metadata.tag!=='canvas'||!await locator.isVisible())fail('VISUAL_TARGET_INVALID','视觉步骤当前需要可见唯一canvas宿主');
 const geometry=await locator.evaluate(element=>({width:element.width,height:element.height,transform:getComputedStyle(element).transform,cssWidth:element.getBoundingClientRect().width,cssHeight:element.getBoundingClientRect().height}));
 if(![geometry.cssWidth,geometry.cssHeight].every(value=>Number.isFinite(value)&&value>0&&value<=16384)||Math.ceil(geometry.cssWidth)*Math.ceil(geometry.cssHeight)>16000000)fail('VISUAL_IMAGE_LIMIT','Canvas截图超过像素预算，未创建图像');
 if(geometry.transform!=='none')fail('VISUAL_TRANSFORM_UNSUPPORTED','变换后的canvas需要显式坐标适配');
 const root=config._runtime.visualDir||path.join(config.outputDir,'private','visual');mkdirSync(root,{recursive:true,mode:0o700});
 const actualRoot=realpathSync(root),id=randomUUID(),file=path.join(actualRoot,id+'.png');await locator.screenshot({path:file,type:'png',scale:'css',timeout:Math.max(1,Math.min(config.actionTimeoutMs,budget.remainingMs))});budget.check();
 const stats=config._runtime.visualStats??={captures:0,ocrCalls:0,ocrMs:0};stats.captures++;stats.ocrCalls++;const ocrStarted=performance.now();
 const observation=await observeImage({imagePath:file,outputDir:path.join(actualRoot,id),engine:config.visual.engine,language:config.visual.language,signal,timeoutMs:Math.max(1,Math.floor(Math.min(15000,budget.remainingMs))),maxTokens:1000,maxOutputBytes:512000});stats.ocrMs+=performance.now()-ocrStarted;budget.check();
 return {...observation,geometry};
}
export async function groundVisualStep(found,step,config,{expected,signal,inputMasks=[]}={}){
 const observation=await canvasObservation(found,config,{signal}),box=anchor(observation,step.visual.anchor,config.visual.actionMinConfidence??config.visual.minConfidence),normalized={x:box.x/observation.width,y:box.y/observation.height,width:box.width/observation.width,height:box.height/observation.height};
 // Only fixed input value areas may differ between parameter samples. Output
 // regions are never masked: they could contain a changed button label.
 const masks=inputMasks.map(visualRegion);
 const pixels=visualPixelFingerprint(observation.imagePath,{masks});config._runtime.budget.check();
 const contract={schemaVersion:2,anchor:step.visual.anchor,width:observation.geometry.width,height:observation.geometry.height,normalized,pixels,masks};
 if(expected&&(expected.schemaVersion!==2||!expected.pixels))fail('VISUAL_CONTRACT_OUTDATED','旧视觉合同缺少像素证据，请重新学习');
 if(expected&&(contract.anchor!==expected.anchor||contract.width!==expected.width||contract.height!==expected.height||Object.keys(normalized).some(key=>Math.abs(normalized[key]-expected.normalized[key])>.025)))fail('VISUAL_ANCHOR_CHANGED','当前文字锚点偏离已学习视觉合同');
 if(expected&&(!same(masks,expected.masks)||!same(pixels,expected.pixels)))fail('VISUAL_CONTENT_CHANGED','固定输入区域外的视觉内容已改变，未发送坐标动作');
 const point={x:normalized.x+normalized.width/2+step.visual.offset.x,y:normalized.y+normalized.height/2+step.visual.offset.y};if(point.x<=0||point.x>=1||point.y<=0||point.y>=1)fail('VISUAL_TARGET_OUTSIDE','视觉偏移目标超出canvas');
 if(step.kind==='visualFill'){
  if(!visualPointMasked(point,pixels,[step.visual.valueRegion]))fail('VISUAL_TARGET_UNANCHORED','视觉输入点击点须落在已批准的输入回读区域内');
  if(masks.some(mask=>visualRegionsOverlap(mask,step.visual.valueRegion,pixels)))fail('VISUAL_TARGET_MASKED','当前输入区域不得被其他参数遮罩覆盖');
 }else{
  if(point.x<normalized.x||point.x>=normalized.x+normalized.width||point.y<normalized.y||point.y>=normalized.y+normalized.height)fail('VISUAL_TARGET_UNANCHORED','视觉点击须落在当前文字锚点内，不能偏移到未识别控件');
 }
 if(masks.some(mask=>visualRegionsOverlap(mask,normalized,pixels))||visualPointMasked(point,pixels,masks))fail('VISUAL_TARGET_MASKED','动作锚点不能与动态输入遮罩重叠');
 return {contract,observation,point};
}
export async function visualPoint(page,found,ground,config){
 const budget=config._runtime.budget;budget.check();
 // Refuse motion between the OCR snapshot and dispatch rather than blindly
 // retrying a coordinate against a newly drawn interface.
 const current=await found.locator.screenshot({type:'png',scale:'css',timeout:Math.max(1,Math.min(config.actionTimeoutMs,budget.remainingMs))});
 if(digest(current)!==ground.observation.imageSha256)fail('VISUAL_FRAME_CHANGED','文字识别后画面已改变，未发送坐标动作');
 const box=await found.locator.boundingBox();if(!box)fail('VISUAL_TARGET_INVALID','canvas失去边界');
 const point={x:box.x+box.width*ground.point.x,y:box.y+box.height*ground.point.y};
 const hit=await found.locator.evaluate((element,ratio)=>{const box=element.getBoundingClientRect(),p={x:box.x+box.width*ratio.x,y:box.y+box.height*ratio.y};let node=document.elementFromPoint(p.x,p.y);while(node?.shadowRoot){const child=node.shadowRoot.elementFromPoint(p.x,p.y);if(!child||child===node)break;node=child;}return node===element;},ground.point);
 if(!hit)fail('VISUAL_TARGET_OCCLUDED','视觉点击点被其他控件遮挡');
 const element=await found.locator.elementHandle();if(!element)fail('VISUAL_TARGET_INVALID','canvas已移除');
 try{
  let frame=await element.ownerFrame(),depth=0;
  while(frame?.parentFrame()){
   if(++depth>12)fail('VISUAL_FRAME_LIMIT','视觉frame路径超过预算');budget.check();
   const host=await frame.frameElement();
   try{
    const outer=await host.boundingBox();if(!outer)fail('VISUAL_TARGET_OCCLUDED','iframe宿主不可见');
    const result=await host.evaluate((element,{point,outer})=>{
      let current=element;while(current){const style=getComputedStyle(current);if(style.transform!=='none'||!['1','normal'].includes(style.zoom||'1'))return {unsupported:true};current=current.parentElement||current.getRootNode()?.host||null;}
      const box=element.getBoundingClientRect(),local={x:box.x+point.x-outer.x,y:box.y+point.y-outer.y};let hit=document.elementFromPoint(local.x,local.y);
      while(hit?.shadowRoot){const child=hit.shadowRoot.elementFromPoint(local.x,local.y);if(!child||child===hit)break;hit=child;}
      return {hit:hit===element};
    },{point,outer});
    if(result.unsupported)fail('VISUAL_TRANSFORM_UNSUPPORTED','变换后的iframe祖先需要坐标适配');
    if(!result.hit)fail('VISUAL_TARGET_OCCLUDED','视觉点击点被iframe祖先页面遮挡');
   }finally{await host.dispose();}
   frame=frame.parentFrame();
  }
 }finally{await element.dispose();}
 budget.check();return point;
}
