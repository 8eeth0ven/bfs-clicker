// Offline candidates only. Selectors remain in private specs, never in index items.
import {createHash} from 'node:crypto';
import {createReadStream,existsSync,lstatSync,readFileSync,realpathSync,statSync} from 'node:fs';
import path from 'node:path';
import {normalizeConfig} from './asset.js';
import {acquireLock,identity,readAtomic} from './store.js';
import {openCheckpointJournal} from './checkpoint.js';
import {createPolicy} from './policy.js';
import {redactText} from './redact.js';
import {visualRegion,overlap} from './browser-visual.js';
const MAX_FILE=128*1024*1024,MAX_LINE=2*1024*1024,MAX_STATES=10000,MAX_CANDIDATES=100,MAX_INPUTS=8;
const SEARCH=/search|query|filter|lookup|查询|搜索|筛选|检索/i;
const SENSITIVE=/password|passwd|secret|token|cookie|authorization|credential|api[-_]?key|验证码|密码|口令|令牌|密钥|支付|付款|登录|登陆|注册/i;
const INPUT_TYPES=new Set(['text','search','number','email','url','tel','date','time','datetime-local','month','week']);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>JSON.parse(JSON.stringify(value));
const stable=value=>Array.isArray(value)?value.map(stable):plain(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const within=(root,file)=>{const part=path.relative(root,file);return part===''||part!=='..'&&!part.startsWith('..'+path.sep)&&!path.isAbsolute(part)};
const fail=(code,message)=>{throw Object.assign(new Error(message),{code})};
const frameKey=action=>JSON.stringify(action.framePath||[]);
const locatorKey=action=>JSON.stringify([action.framePath||[],action.selector]);
function validLocator(action){return typeof action.selector==='string'&&action.selector.length>0&&action.selector.length<=4096&&Array.isArray(action.framePath||[])&&(action.framePath||[]).length<=12&&(action.framePath||[]).every(n=>Number.isSafeInteger(n)&&n>=0)}
function fieldLabel(action){return String(action.associatedLabel||action.aria||action.name||action.placeholder||'输入参数').replace(/\s+/g,' ').trim().slice(0,100)}
function secretValues(config){const values=[...Object.values(config.authInject?.headers||{}),config.proxy?.username,config.proxy?.password].filter(value=>typeof value==='string'&&value.length>=3);if(config.storageState&&existsSync(config.storageState)&&statSync(config.storageState).size<=2*1024*1024){const saved=JSON.parse(readFileSync(config.storageState,'utf8'));for(const cookie of saved.cookies||[])if(typeof cookie.value==='string'&&cookie.value.length>=3)values.push(cookie.value);for(const origin of saved.origins||[])for(const row of origin.localStorage||[])if(SENSITIVE.test(row.name||'')&&typeof row.value==='string'&&row.value.length>=3)values.push(row.value)}return [...new Set(values)]}
function safeLabel(text,config,known=secretValues(config)){let result=redactText(text);for(const value of known){if(typeof value==='string'&&value.length>=3){result=result.split(value).join('[REDACTED]');const bare=value.replace(/^(?:Bearer|Basic)\s+/i,'');if(bare.length>=3)result=result.split(bare).join('[REDACTED]')}}return result.slice(0,120)}
function localFile(root,relative,optional=false){
 const file=path.join(root,relative);if(!existsSync(file)){if(optional)return null;fail('WORKFLOW_SOURCE_MISSING','缺少私有探索证据')}
 const info=lstatSync(file),actual=realpathSync(file);if(info.isSymbolicLink()||!info.isFile()||!within(root,actual))fail('WORKFLOW_PATH_REJECTED','探索证据路径越界');if(info.size>MAX_FILE)fail('WORKFLOW_SOURCE_LIMIT','探索证据超过读取上限');return actual;
}
function privateJson(root,relative){localFile(root,relative,true);localFile(root,relative+'.previous',true);return readAtomic(path.join(root,relative))}
async function readEvents(file,onRow,gap){
 if(!file){gap('events_missing');return}
 let line=Buffer.alloc(0),dropping=false;
 const parse=bytes=>{if(!bytes.toString('utf8').trim())return;try{const row=JSON.parse(bytes.toString('utf8'));if(!plain(row))throw new Error();onRow(row)}catch{gap('malformed_events')}};
 for await(const raw of createReadStream(file)){
  const chunk=Buffer.from(raw);let start=0;
  for(let i=0;i<chunk.length;i++)if(chunk[i]===10){const part=chunk.subarray(start,i);if(!dropping&&line.length+part.length<=MAX_LINE)parse(Buffer.concat([line,part]));else if(!dropping)gap('event_line_limit');line=Buffer.alloc(0);dropping=false;start=i+1}
  const tail=chunk.subarray(start);if(!dropping&&line.length+tail.length<=MAX_LINE)line=Buffer.concat([line,tail]);else if(!dropping){gap('event_line_limit');dropping=true;line=Buffer.alloc(0)}
 }
 if(line.length&&!dropping){gap('event_tail_without_newline');parse(line)}
}
function constraintSchema(action,gaps){
 const c=plain(action.htmlConstraints)?action.htmlConstraints:null;if(!c)gaps.push('constraints_inventory_missing');
 const type=String(action.htmlType||'text').toLowerCase(),label=fieldLabel(action);let schema={type:'string',title:label};
 if(action.role==='combobox'){
  const choices=action.ariaChoices;if(!plain(choices)||choices.complete!==true||!Array.isArray(choices.options)||!choices.options.length||choices.options.length>200||choices.options.some(option=>!plain(option)||typeof option.value!=='string'||option.value.length>512||!validLocator({...option,framePath:action.framePath||[]}))||new Set(choices.options.map(option=>option.value)).size!==choices.options.length||new Set(choices.options.map(option=>option.selector)).size!==choices.options.length){gaps.push(action.ariaChoiceGap||'aria_options_contract_not_observed');return null}
  schema={type:'string',enum:choices.options.map(option=>option.value),title:label};
 }else if(action.type==='select'){
  if(!Array.isArray(action.options)||!action.options.length||action.options.length>200){gaps.push('select_options_missing_or_over_limit');return null}
  const values=[...new Set(action.options.filter(option=>!option.disabled&&typeof option.value==='string').map(option=>option.value))].filter(value=>!c?.required||value!=='');
  if(!values.length||values.some(value=>value.length>512)){gaps.push('select_options_missing_or_over_limit');return null}
  schema=c?.multiple?{type:'array',items:{type:'string',enum:values},uniqueItems:true,...(c.required?{minItems:1}:{}),title:label}:{type:'string',enum:values,title:label};
 }else if(action.type==='checkbox')schema={type:'boolean',title:label,...(c?.required?{const:true}:{})};
 else if(type==='number'){
  schema={type:'number',title:label};for(const [name,key]of [['min','minimum'],['max','maximum']])if(c?.[name]!=null&&c[name]!==''&&Number.isFinite(Number(c[name])))schema[key]=Number(c[name]);
  if(c?.step&&c.step!=='any'){const step=Number(c.step),base=Number(c.min||0);if(step>0&&Number.isFinite(step)&&Number.isInteger(base/step))schema.multipleOf=step;else gaps.push('number_step_requires_live_validation')}
 }else{
  for(const [name,key]of [['minLength','minLength'],['maxLength','maxLength']])if(c?.[name]!=null&&c[name]!==''&&Number.isSafeInteger(Number(c[name]))&&Number(c[name])>=0)schema[key]=Number(c[name]);
  if(c?.required)schema.minLength=Math.max(1,schema.minLength||0);
  if(c?.pattern){if(c.pattern.length>512){gaps.push('html_pattern_limit');return null}try{new RegExp(c.pattern);schema.pattern='^(?:'+c.pattern+')$'}catch{gaps.push('html_pattern_requires_live_validation')}}
  if(['email','url','date','time','datetime-local','month','week'].includes(type)){gaps.push('html_type_'+type+'_requires_live_validation');if(type==='email')schema.format='email';if(type==='url')schema.format='uri';}
 }
 return schema;
}
function parameterName(action,used){let name=String(action.name||action.htmlType==='search'&&'query'||'input').normalize('NFKC').replace(/[^A-Za-z0-9_]/g,'_').replace(/^([0-9])/,'input_$1').slice(0,40)||'input';if(!/^[A-Za-z0-9]/.test(name))name='input'+name;if(['__proto__','prototype','constructor'].includes(name))name='input';const base=name;let n=2;while(used.has(name))name=base+'_'+n++;used.add(name);return name}

/** Private planning result; expose items/source/gaps only through public MCP lists. */
export async function planBrowserWorkflows({runDir,sourceId,offset=0,limit=20}={}){
 if(typeof sourceId!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sourceId))fail('WORKFLOW_SOURCE_INVALID','sourceId格式无效');
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail('WORKFLOW_PAGE_INVALID','候选分页参数无效');
 const root=realpathSync(path.resolve(runDir)),release=acquireLock(path.join(root,'.run.lock'),{task:'workflow_candidate_plan'});
 try{
  const raw=privateJson(root,'private/config.json'),meta=privateJson(root,'private/run.json'),config=normalizeConfig(raw,{baseDir:root}),id=identity(config),globalGaps=new Set();
  if(config.runId!==meta.runId||!meta.identity||Object.entries(id).some(([key,value])=>meta.identity[key]!==value))fail('WORKFLOW_IDENTITY_MISMATCH','私有探索身份不一致');
  const base=privateJson(root,'private/checkpoint.json');if(!base.identity||Object.entries(id).some(([key,value])=>base.identity[key]!==value))fail('WORKFLOW_IDENTITY_MISMATCH','断点身份不一致');
  const journal=localFile(root,'private/checkpoint.journal.jsonl',true);
  const recovered=openCheckpointJournal({file:journal||path.join(root,'private/checkpoint.journal.jsonl'),checkpointFile:path.join(root,'private/checkpoint.json'),checkpoint:base,identity:id,runId:meta.runId,readOnly:true});
  if(recovered.notices.length)globalGaps.add('checkpoint_recovery_notice');
  const states=recovered.checkpoint.states;if(!Array.isArray(states)||states.length>MAX_STATES)fail('WORKFLOW_SOURCE_LIMIT','状态规模超出规划上限');
  const observed=new Map(),starts=new Map(),successful=new Map(),eventHash=createHash('sha256'),stateEvidenceIds=new Set(states.map(state=>state.evidenceId));
  await readEvents(localFile(root,'private/events.jsonl',true),row=>{
   eventHash.update(JSON.stringify(row)+'\n');
   if(row.kind==='state'&&stateEvidenceIds.has(row.evidenceId))observed.set(row.evidenceId,row);
   if(row.kind==='action_started'){if(starts.size<50000)starts.set(row.evidenceId,row);else globalGaps.add('execution_index_limit')}
   if(row.kind==='action_finished'&&row.status==='succeeded'){const start=starts.get(row.executionId);if(start&&start.stateId===row.stateId&&start.actionId===row.actionId)successful.set(JSON.stringify([row.stateId,row.actionId]),{started:start.evidenceId,finished:row.evidenceId})}
  },reason=>globalGaps.add(reason));
  const knownSecrets=secretValues(config),containsSecret=value=>typeof value==='string'&&knownSecrets.some(secret=>secret.length>=6&&value.includes(secret));
  const revision=hash({identity:id,states,events:eventHash.digest('hex')}),policy=createPolicy(config),candidates=[],privateSpecs={};let omitted=0,excluded=0;
  const provenState=state=>{const event=observed.get(state?.evidenceId);return plain(state)&&Number.isSafeInteger(state.id)&&state.id>0&&typeof state.fp==='string'&&/^[a-f0-9]{32}$/.test(state.fp)&&event?.stateId===state.id&&event.url===state.url&&event.fp===state.fp;};
  const childrenByParent=new Map();for(const child of states){if(!childrenByParent.has(child.parentId))childrenByParent.set(child.parentId,[]);childrenByParent.get(child.parentId).push(child);}
  const openedChoices=(state,action)=>{
   if(action.role!=='combobox'||action.ariaChoices?.complete||action.expanded!=='false')return action;
   const matches=[];
   for(const child of childrenByParent.get(state.id)||[]){
    if(!provenState(child)||child.parentId!==state.id||child.url!==state.url||child.path?.length!==(state.path?.length||0)+1)continue;
    const last=child.path.at(-1);if(last.fromStateId!==state.id||last.kind!=='click'||locatorKey(last)!==locatorKey(action)||!successful.has(JSON.stringify([state.id,last.id])))continue;
    const found=child.interactives?.find(item=>locatorKey(item)===locatorKey(action)&&item.role==='combobox'&&item.expanded==='true');
    if(!found||!['tag','role','name','aria','ariaControlsId','formSelector','groupSelector'].every(key=>(found[key]??null)===(action[key]??null))||hash(found.htmlConstraints||{})!==hash(action.htmlConstraints||{}))continue;
    if(!found.ariaChoices?.complete)continue;
    if(found.ariaChoices.domainEvidence!=='aria_setsize'){globalGaps.add('aria_lazy_domain_not_proven');continue;}
    matches.push(found);
   }
   if(!matches.length)return action;
   if(new Set(matches.map(item=>hash(item.ariaChoices))).size!==1){globalGaps.add('aria_lazy_evidence_conflict');return action;}
   return {...action,ariaChoices:clone(matches[0].ariaChoices),ariaChoiceGap:null,ariaChoiceObservedAfterOpen:true};
  };

  for(const state of states){
   if(!plain(state)||!Array.isArray(state.interactives))continue;
   const event=observed.get(state.evidenceId);
   if(!Number.isSafeInteger(state.id)||state.id<=0||typeof state.fp!=='string'||! /^[a-f0-9]{32}$/.test(state.fp)||!event||event.stateId!==state.id||event.url!==state.url||event.fp!==state.fp){globalGaps.add('state_inventory_not_proven');continue}
   if(!policy.navigation(state.url).allow){globalGaps.add('state_outside_navigation_policy');continue}
   const groups=new Map(),seen=new Set();
   for(const rawAction of state.interactives){
    const action=plain(rawAction)?openedChoices(state,rawAction):rawAction;
    if(!plain(action)||!validLocator(action)||seen.has(locatorKey(action)))continue;seen.add(locatorKey(action));
    if(action.frameUrl&&!policy.navigation(action.frameUrl).allow){globalGaps.add('frame_outside_navigation_policy');continue}
    if(action.excluded||action.skipReason==='excluded_selector'||config.excludeSelectors.includes(action.selector)){excluded++;continue}
    const group=action.formSelector||action.groupSelector||null,key=JSON.stringify([action.framePath||[],group]);
    if(!groups.has(key))groups.set(key,{controls:[],selector:group});groups.get(key).controls.push(action);
   }
   for(const {controls,selector:groupSelector}of groups.values()){
    if(controls.some(action=>action.htmlType==='password'||SENSITIVE.test([action.name,action.associatedLabel,action.aria].join(' ')))){globalGaps.add('sensitive_group_omitted');continue}
    const inputs=controls.filter(action=>(action.type==='text'&&INPUT_TYPES.has(action.htmlType||'text')||['select','checkbox'].includes(action.type)||action.role==='combobox')&&!action.htmlConstraints?.readOnly);
    if(inputs.some(action=>action.role==='combobox'&&action.expanded==='true')){globalGaps.add('aria_open_state_requires_closed_entry_proof');continue;}
    const submitters=controls.filter(action=>action.role!=='combobox'&&(action.type==='click'&&['button','input'].includes(action.tag)&&['','button','submit','image'].includes(action.htmlType||'')||action.role==='button'));
    const searchContext=inputs.some(action=>action.htmlType==='search'||action.filterContext||SEARCH.test([action.name,action.associatedLabel,action.aria,action.placeholder].join(' ')))||submitters.some(action=>SEARCH.test([action.associatedLabel,action.aria,action.text,action.label].join(' ')));
    if(!inputs.length||!submitters.length||!searchContext)continue;
    if(inputs.length>MAX_INPUTS){globalGaps.add('workflow_input_limit');continue}
    if(!groupSelector&&(inputs.length!==1||submitters.length!==1)){globalGaps.add('ambiguous_ungrouped_controls');continue}
    for(const button of submitters){
     if(!SEARCH.test([button.label,button.aria,button.associatedLabel].join(' '))&&!inputs.some(action=>action.htmlType==='search'||action.filterContext))continue;
     if(![...inputs,button].every(action=>policy.action({...action,kind:action.kind||'click'}).allow&&(action.role!=='combobox'||config.actionAllowlist.includes(action.selector)))){globalGaps.add('workflow_action_policy_rejected');continue}
     if(button.formAction){const method=String(button.formMethod||'GET').toUpperCase();if(!policy.request({url:button.formAction,method,type:'document',navigation:true}).allow){globalGaps.add('workflow_request_policy_rejected');continue}}
     if(candidates.length>=MAX_CANDIDATES){omitted++;continue}
     const gaps=['two_distinct_samples_required','parameter_related_assertions_required','workflow_not_validated',...globalGaps];if(!groupSelector)gaps.push('group_association_missing');if(state.path?.length)gaps.push('entry_state_requires_live_validation');
     const candidateId='workflow_'+hash([sourceId,state.id,inputs.map(locatorKey),locatorKey(button)]),properties={},required=[],steps=[],used=new Set();let incomplete=false;
     for(const input of inputs){
      const field=parameterName(containsSecret(input.name)?{...input,name:''}:input,used),schema=constraintSchema(input,gaps);if(!schema){for(const gap of gaps.filter(gap=>gap.startsWith('aria_')))globalGaps.add(gap);incomplete=true;break}if(containsSecret(JSON.stringify({...schema,title:''}))){incomplete=true;globalGaps.add('sensitive_parameter_contract_omitted');break}schema.title=safeLabel(schema.title,config,knownSecrets);properties[field]=schema;
      if(input.htmlConstraints?.required)required.push(field);
      let choices;
      if(input.role==='combobox'){
       choices=Object.fromEntries(input.ariaChoices.options.map(option=>[option.value,{selector:option.selector,framePath:clone(input.framePath||[])}]));
       if(input.ariaChoices.options.some(option=>!config.actionAllowlist.includes(option.selector)||!policy.action({...input,selector:option.selector,type:'click',role:'option',text:option.label,label:option.label,kind:'click'}).allow)){globalGaps.add('aria_option_action_not_approved');incomplete=true;break;}
      }
      steps.push({kind:input.role==='combobox'?'choose':input.type==='select'?'select':input.type==='checkbox'?'check':'fill',selector:input.selector,framePath:clone(input.framePath||[]),param:field,...(choices?{choices,...(input.ariaSelectionAttribute?{selection:{attribute:input.ariaSelectionAttribute}}:{})}:{}),actionId:input.id,htmlType:input.htmlType,htmlConstraints:clone(input.htmlConstraints||{})});
      if(!successful.has(JSON.stringify([state.id,input.id])))gaps.push('input_execution_not_proven');else gaps.push('input_parameterization_not_proven');
     }
     if(incomplete){globalGaps.add('workflow_contract_incomplete');continue}
     steps.push({kind:'click',selector:button.selector,framePath:clone(button.framePath||[]),actionId:button.id});
     const inputSchema={type:'object',properties,...(required.length?{required}:{}),additionalProperties:false},outcomeCandidates=[];
     for(const target of (button.workflowOutputs||[]).slice(0,6)){
      if(!plain(target)||!validLocator({...target,framePath:button.framePath||[]}))continue;
      const outputId='output_'+hash([candidateId,button.framePath||[],target.selector]),kind=target.tag==='table'?'table':'text';
      outcomeCandidates.push({id:outputId,kind,selector:target.selector,framePath:clone(button.framePath||[]),tag:target.tag||null,role:target.role||null,...(['aria','title'].includes(target.labelSource)&&target.label?{semanticLabel:safeLabel(target.label,config,knownSecrets)}:{})});
     }
     if(!outcomeCandidates.length)gaps.push('output_locator_missing');
     const evidence=successful.get(JSON.stringify([state.id,button.id]));if(!evidence)gaps.push('submit_execution_not_proven');
     const spec={schemaVersion:1,id:candidateId,name:'查询流程',description:'由已观察页面控件规划的待验证参数化流程',effect:'unknown',inputSchema,entry:{url:state.url,anchors:inputs.map(action=>({selector:action.selector,framePath:clone(action.framePath||[]),tag:action.tag}))},steps,assertions:[],extract:[],samples:[],outcomeCandidates};
     const uniqueGaps=[...new Set(gaps)],item={id:candidateId,name:safeLabel('查询流程：'+fieldLabel(inputs[0]),config,knownSecrets),description:'候选控件组合；需要两组变化样本和参数相关输出断言后实际验证',kind:'browser_workflow',readiness:'candidate',effect:'unknown',revision:hash([revision,spec]),inputSchema:clone(inputSchema),outputTargets:outcomeCandidates.map(target=>({id:target.id,kind:target.kind,label:target.semanticLabel||(target.kind==='table'?'结果表格':'结果区域')})),gaps:uniqueGaps,evidence:{runId:meta.runId,stateId:state.id,stateEvidenceId:state.evidenceId,submitExecution:evidence||null,inputActionKeys:inputs.map(action=>hash(action.id||locatorKey(action))),parameterizationValidated:false}};
     candidates.push(item);privateSpecs[candidateId]=spec;
    }
   }
  }
  // Visual actions and result regions come only from the server owner's fixed
  // configuration. They describe a possible association, not observed business
  // semantics: binding still requires two live samples and separate assertions.
  const visual=config.visual;
  if(visual?.actions?.length&&visual?.outputs?.length){
   const rootState=states.find(state=>provenState(state)&&!state.parentId&&(!state.path||state.path.length===0)&&policy.navigation(state.url).allow);
   if(!rootState)globalGaps.add('visual_entry_state_not_proven');
   else{
    const allowedAction=action=>{
     if(!plain(action)||action.effect!=='read'||!['visualFill','visualClick'].includes(action.kind)||!config.actionAllowlist.includes(action.selector)||SENSITIVE.test(action.visual.anchor)||containsSecret(action.visual.anchor))return false;
     if(!policy.action({...action,kind:'click',type:'click',text:action.visual.anchor,label:action.visual.anchor}).allow){globalGaps.add('workflow_action_policy_rejected');return false;}
     return true;
    };
    const groups=[];
    if(visual.groups?.length){
     // A multi-field relationship is trusted only when declared by the owner;
     // sharing one canvas alone does not prove fields belong to one form.
     for(const mapping of visual.groups){
      const fills=mapping.inputs.map(index=>visual.actions[index]),button=visual.actions[mapping.click],outputs=mapping.outputs.map(index=>visual.outputs[index]);
      if(!fills.length||fills.length>MAX_INPUTS||fills.some(action=>action?.kind!=='visualFill'||!allowedAction(action))||button?.kind!=='visualClick'||!allowedAction(button)||outputs.some(output=>!output)||[...fills,...outputs].some(item=>locatorKey(item)!==locatorKey(button))||fills.some((fill,index)=>fills.slice(index+1).some(other=>overlap(fill.visual.valueRegion,other.visual.valueRegion)))){globalGaps.add('visual_group_association_not_proven');continue;}
      groups.push({fills,clicks:[button],outputs,mappingId:mapping.id});
     }
    }else{
     const byHost=new Map();
     for(const action of visual.actions){
      if(!allowedAction(action))continue;
      const key=locatorKey(action);if(!byHost.has(key))byHost.set(key,{fills:[],clicks:[],outputs:[]});byHost.get(key)[action.kind==='visualFill'?'fills':'clicks'].push(action);
     }
     for(const output of visual.outputs){const group=byHost.get(locatorKey(output));if(group)group.outputs.push(output);}
     for(const group of byHost.values()){
      if(group.fills.length!==1||group.clicks.length!==1||!group.outputs.length){if(group.fills.length>1||group.clicks.length>1)globalGaps.add('visual_group_association_not_proven');continue;}
      groups.push(group);
     }
    }
    for(const group of groups){
     if(group.fills.length>MAX_INPUTS){globalGaps.add('workflow_input_limit');continue;}
     const first=group.fills[0];
     for(const button of group.clicks){
      if(!group.mappingId&&!SEARCH.test(button.visual.anchor))continue;
      if(candidates.length>=MAX_CANDIDATES){omitted++;continue;}
      const outputs=group.outputs.filter(target=>!group.fills.some(fill=>overlap(fill.visual.valueRegion,target.region)));
      if(!outputs.length){globalGaps.add('visual_result_region_missing');continue;}
      const used=new Set(),properties={},steps=group.fills.map(action=>{const param=parameterName({name:action.visual.anchor},used);properties[param]={type:'string',minLength:1,maxLength:128,title:safeLabel(action.visual.anchor,config,knownSecrets)};return {kind:action.kind,selector:action.selector,framePath:clone(action.framePath),param,visual:clone(action.visual)};});
      steps.push({kind:button.kind,selector:button.selector,framePath:clone(button.framePath),visual:clone(button.visual)});
      const inputSchema={type:'object',properties,required:Object.keys(properties),additionalProperties:false};
      const candidateId='workflow_'+hash([sourceId,rootState.id,'visual',steps,outputs.map(output=>output.region),...(group.mappingId?[group.mappingId]:[])]);
      const outcomeCandidates=outputs.slice(0,6).map(target=>({id:'output_'+hash([candidateId,target.framePath,target.selector,target.region]),kind:'visualText',selector:target.selector,framePath:clone(target.framePath),visual:{region:visualRegion(target.region)},semanticLabel:safeLabel(target.label||'视觉结果区域',config,knownSecrets)}));
      const spec={schemaVersion:1,id:candidateId,name:'视觉查询流程',description:'由可信视觉动作和结果区域组合，等待实际样本验证',effect:'unknown',inputSchema,entry:{url:rootState.url,anchors:[{selector:first.selector,framePath:clone(first.framePath),tag:'canvas'}]},steps,assertions:[],extract:[],samples:[],outcomeCandidates};
      const gaps=['two_distinct_samples_required','parameter_related_assertions_required','workflow_not_validated','visual_host_and_anchors_not_observed','visual_parameter_constraints_not_observed',...(!group.mappingId?['visual_group_association_not_proven']:[])];
      candidates.push({id:candidateId,name:safeLabel('视觉查询：'+first.visual.anchor,config,knownSecrets),description:'可信配置的视觉动作组合；需通过样本验证才能调用',kind:'browser_workflow',readiness:'candidate',effect:'unknown',revision:hash([revision,spec]),inputSchema:clone(inputSchema),outputTargets:outcomeCandidates.map(target=>({id:target.id,kind:target.kind,label:target.semanticLabel})),gaps,evidence:{runId:meta.runId,stateId:rootState.id,stateEvidenceId:rootState.evidenceId,provenance:'trusted_visual_config',parameterizationValidated:false}});
      privateSpecs[candidateId]=spec;
     }
    }
   }
  }else if(visual?.actions?.length)globalGaps.add('visual_result_region_missing');
  const source={id:sourceId,kind:'web',runId:meta.runId,revision,status:meta.status},selected=candidates.slice(offset,offset+limit);let privateBytes=0;const items=[],specs={};
  for(const item of selected){const spec=privateSpecs[item.id],nextBytes=Buffer.byteLength(JSON.stringify(spec));if(Buffer.byteLength(JSON.stringify([...items,item]))>98304||privateBytes+nextBytes>524288){if(!items.length)fail('WORKFLOW_RESPONSE_LIMIT','单个候选契约超过响应预算，请使用私有spec模式');globalGaps.add('workflow_response_budget');break}items.push(item);specs[item.id]=spec;privateBytes+=nextBytes}
  const next=offset+items.length<candidates.length?offset+items.length:null;
  return {schemaVersion:1,source,items,specs,total:candidates.length,nextOffset:next,truncated:omitted>0||items.length<selected.length,counts:{candidates:candidates.length,omitted,excludedControls:excluded},gaps:[...globalGaps]};
 }finally{release()}
}
