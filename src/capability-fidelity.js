// Compiler-owned routing contracts, never quality assertions copied from evidence.
import {nativeBranchParameters} from './native-branch-binding.js';
export const CAPABILITY_FIDELITY_VERSION=2;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const name=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(v)?v:null;
const unique=values=>[...new Set(values)].sort();
const base=(adapter,channels,inputText=[],outputs=[],limits=[])=>({modality:{schemaVersion:CAPABILITY_FIDELITY_VERSION,adapter,channels:unique(channels)},fidelity:{basis:'runtime_contract_on_success_not_evidence_authenticity',inputText,outputs,limits:unique(limits)}});
const projected=(name,contract)=>({name,contract,sourceCodepointsProven:false});
export const unknownCapabilityFidelity=(reason='recipe_contract_unrecognized')=>base('unknown',['unknown'],[],[],[reason,'refresh_or_inspect_recipe_required']);
function unicodeImeMode(value){
 if(value===undefined||value===null)return 'ascii';
 return plain(value)&&Object.keys(value).sort().join(',')==='apkSha256,component'&&value.component==='com.bfs.mcp.ime/.UnicodeIme'&&typeof value.apkSha256==='string'&&/^[a-f0-9]{64}$/.test(value.apkSha256)?'unicode':'invalid';
}
function nativeInput(step,device){
 const parameter=name(step.input);if(!parameter)return null;
 const backend=device.backend;
 if(backend.type==='webdriver')return {parameter,contract:'provider_codepoint_echo_required',mode:step.replace===true?'replace':'append',domain:'utf8_no_c0_del_or_webdriver_keys',maxCodePoints:2048};
 if(backend.type==='adb'&&unicodeImeMode(backend.unicodeInput)==='unicode')return {parameter,contract:'provider_codepoint_echo_required',mode:step.replace===true?'replace':'append',domain:'owner_unicode_ime_utf8_no_nul',maxCodePoints:2048};
 if(backend.type==='adb')return {parameter,contract:'command_only_no_exact_echo',mode:step.replace===true?'replace':'append',domain:'adb_ascii_no_c0_or_literal_percent_s',maxCodePoints:2048};
 return null;
}
function nativeBranchFidelity(recipe,device,sourceKind){
 const definition=recipe.definition;
 try{nativeBranchParameters(definition);}catch{return unknownCapabilityFidelity('native_branch_contract_unrecognized');}
 if(definition.effect!=='read')return unknownCapabilityFidelity('native_branch_contract_unrecognized');
 const profiles=[];
 for(const arm of definition.branchPlan.arms){
  if(arm.definition.branchPlan)return unknownCapabilityFidelity('native_branch_contract_unrecognized');
  const result=deriveCapabilityFidelity({adapter:'mobile-workflow',recipe:{schemaVersion:1,recipeType:'workflow',definition:arm.definition},device,sourceKind});
  if(result.modality.channels.includes('unknown'))return unknownCapabilityFidelity('native_branch_arm_contract_unrecognized');
  const inverse=Object.fromEntries(Object.entries(arm.inputMap).map(([global,local])=>[local,global]));
  const inputs=result.fidelity.inputText.map(input=>({...input,parameter:inverse[input.parameter]}));
  if(inputs.some(input=>!input.parameter))return unknownCapabilityFidelity('native_branch_arm_contract_unrecognized');
  // Physical order and selectors may differ; guarantees for logical inputs and
  // outputs must agree across every possible path.
  const logical=values=>[...new Map(values.map(value=>[JSON.stringify(value),value])).entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,value])=>value);
  profiles.push({...result,fidelity:{...result.fidelity,inputText:logical(inputs),outputs:logical(result.fidelity.outputs)}});
 }
 if(JSON.stringify(profiles[0])!==JSON.stringify(profiles[1]))return unknownCapabilityFidelity('native_branch_arm_guarantees_differ');
 const result=profiles[0];
 return base('mobile-workflow',result.modality.channels,result.fidelity.inputText,result.fidelity.outputs,[...result.fidelity.limits,'native_branch_each_arm_requires_two_observed_samples','native_branch_selection_requires_unique_fresh_structure','native_branch_context_must_remain_native']);
}
function webViewFidelity(recipe,device,sourceKind){
 const backend=device?.backend,config=backend?.webview,definition=recipe.definition,plan=recipe.webviewPlan;
 const unknown=()=>unknownCapabilityFidelity('webview_workflow_contract_unrecognized');
 if(sourceKind!=='ios'||backend?.type!=='appium-webview'||backend.platform!=='ios'||!plain(config)||recipe.recipeType!=='webview_workflow'||!plain(plan)||plan.schemaVersion!==1||plan.planningMode!=='webview-dom-linear-v1')return unknown();
 const identity=plan.sourceIdentity;
 if(!plain(identity)||identity.modality!=='appium_webview_dom'||identity.platform!=='ios'||identity.appId!==backend.appId||identity.documentScope!=='worker_live_reference_identity'||!/^[a-f0-9]{64}$/.test(identity.probeSha256||'')||!/^webview-dom-probe-[0-9]+$/.test(identity.probeVersion||'')||['context','windowHandle','origin','url'].some(key=>typeof config[key]!=='string'||identity[key]!==config[key])||!/^[a-f0-9]{64}$/.test(plan.sourceRevision||'')||!Array.isArray(plan.controls)||!plan.controls.length||plan.controls.length>512)return unknown();
 const association=config.association,method=association?.mode||'reported_bundle_id_v1';
 if(identity.associationMethod!==method)return unknown();
 if(association===undefined){if(identity.contextBundleId!==backend.appId)return unknown();}
 else{
  if(!plain(association)||Object.keys(association).sort().join(',')!=='mode,reportedBundleId'||method!=='xcuitest_app_main_pid_v1'||typeof association.reportedBundleId!=='string'||!/^process-[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(association.reportedBundleId)||association.reportedBundleId.startsWith('process-com.apple.WebKit')||identity.contextBundleId!==association.reportedBundleId)return unknown();
  const context=/^WEBVIEW_([1-9][0-9]{0,9})\.([1-9][0-9]{0,15})$/.exec(identity.context);
  if(!context||!/^[1-9][0-9]{0,9}$/.test(identity.appMainPid||'')||context[1]!==identity.appMainPid||Number(context[1])>2147483647||!Number.isSafeInteger(Number(context[2])))return unknown();
 }
 if(!plain(definition)||definition.schemaVersion!==1||definition.effect!=='read'||definition.stagePlan||definition.branchPlan||!Array.isArray(definition.steps)||!definition.steps.length||definition.steps.length>30||definition.steps.some(step=>!plain(step)||!['type','click','assert','extract'].includes(step.kind)))return unknown();
 const inputs=[],outputs=[],typed=new Set(),asserted=new Set();
 const control=selector=>plan.controls.find(row=>plain(row)&&plain(row.selector)&&JSON.stringify(canonicalSelector(row.selector))===JSON.stringify(canonicalSelector(selector)));
 for(const step of definition.steps){
  const row=control(step.selector),kind=row?.domContract?.kind;
  if(!row||kind!==(['type'].includes(step.kind)?'input':step.kind==='click'?'button':'output'))return unknown();
  if(step.kind==='type'){
   const parameter=name(step.input);
   if(!parameter||step.replace!==true||definition.inputSchema?.properties?.[parameter]?.type!=='string')return unknown();
   inputs.push({parameter,contract:'dom_value_echo_required',mode:'replace',domain:'utf8_no_controls_surrogates_or_webdriver_keys',maxCodePoints:2048});typed.add(parameter);
  }else if(step.kind==='extract'){
   const output=name(step.output);if(!output||step.valueType!==undefined&&step.valueType!=='string')return unknown();
   outputs.push(projected(output,'webview_dom_text_projection'));
  }else if(step.kind==='assert'){
   const parameter=step.expect?.containsInput??step.expect?.equalsInput;
   if(step.expect?.changed===true&&name(parameter))asserted.add(parameter);
  }
 }
 if(!typed.size||!outputs.length||![...typed].every(parameter=>asserted.has(parameter))||!definition.steps.some(step=>step.kind==='click'))return unknown();
 return base('mobile-workflow',['appium_webview_dom','fixed_w3c_element_commands'],inputs,outputs,['dom_values_are_not_app_buffer_or_business_truth','fixed_probe_does_not_prove_page_code_authenticity','fresh_source_checks_are_not_atomic','webview_context_window_origin_and_dom_contract_required','live_document_refs_scoped_to_one_worker','clear_value_click_can_dispatch_multiple_dom_events','unknown_command_outcomes_require_owner_review','single_document_linear_type_click_only','outputs_are_projected_redacted_and_bounded',association?'webview_app_association_uses_observed_main_pid':'webview_app_association_uses_reported_bundle_id']);
}
const canonicalSelector=value=>plain(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)):null;
export function deriveCapabilityFidelity({adapter,recipe,device,sourceKind}={}){
 if(adapter==='unresolved-http')return unknownCapabilityFidelity('http_method_unresolved');
 if(adapter==='http')return base('http',['http_wire'],[{scope:'request_parameters',contract:'schema_defined_wire_serialization',domain:'exposed_input_schema'}],[projected('response','decoded_redacted_bounded_response')],['http_response_is_not_business_equivalence','response_may_be_truncated_or_binary_summary']);
 const stagedBrowser=adapter==='browser-workflow'&&plain(recipe)&&recipe.schemaVersion===2&&recipe.kind==='browser-workflow'&&recipe.spec?.executionMode==='closed-stages-v1'&&recipe.spec?.closedStages?.schemaVersion===1&&Array.isArray(recipe.spec.closedStages.stages)&&recipe.spec.closedStages.stages.length>=2&&recipe.spec.closedStages.stages.length<=31&&Array.isArray(recipe.spec.steps)&&recipe.spec.steps.length>=1&&recipe.spec.steps.length<=30&&recipe.spec.steps.every(step=>plain(step)&&step.closedShadow&&['fill','click'].includes(step.kind));
 if(!plain(recipe)||(recipe.schemaVersion!==1&&!stagedBrowser))return unknownCapabilityFidelity();
 if(['mobile','mobile-workflow'].includes(adapter)&&(device?.backend?.type==='appium-webview'||recipe.recipeType==='webview_workflow'||recipe.webviewPlan||recipe.definition?.webviewPlan))return adapter==='mobile-workflow'?webViewFidelity(recipe,device,sourceKind):unknownCapabilityFidelity('webview_workflow_contract_unrecognized');
 if(adapter==='mobile-workflow'&&['ios_visual_workflow','visual_workflow'].includes(recipe.recipeType)){
  const definition=recipe.definition,inputs=[],limits=['rendered_ocr_cannot_prove_source_codepoints','ocr_may_drop_or_normalize_spaces','visual_echo_is_not_semantic_provider_echo','result_is_bounded_and_redacted'];
  if(plain(definition)&&definition.mode==='text-replace'&&name(definition.inputName))inputs.push({parameter:definition.inputName,contract:'rendered_ocr_echo_required',mode:'replace',domain:device?.nativeVisualWorkflow?.keyboard?.keyInput?.mode==='onscreen'?'ascii_alphanumeric_1_16':'declared_visual_input_schema'});
  else limits.push('no_general_text_input_contract');
  return base('mobile-workflow',['rendered_ocr','fixed_ui_actions'],inputs,[projected('text','rendered_ocr_projection')],limits);
 }
 if(['mobile','mobile-workflow'].includes(adapter)){
  const backend=device?.backend;if(!plain(backend)||!['webdriver','adb'].includes(backend.type)||backend.type==='adb'&&sourceKind!=='apk'||backend.type==='webdriver'&&(backend.platform||'ios')!==(sourceKind==='apk'?'android':'ios'))return unknownCapabilityFidelity('native_backend_contract_unavailable');
  if(backend.type==='adb'&&unicodeImeMode(backend.unicodeInput)==='invalid')return unknownCapabilityFidelity('unicode_ime_config_invalid');
  let steps,outputs=[];
  if(adapter==='mobile-workflow'){
   if(recipe.recipeType==='workflow'&&plain(recipe.definition)&&recipe.definition.schemaVersion===1&&recipe.definition.branchPlan)return nativeBranchFidelity(recipe,device,sourceKind);
   if(recipe.recipeType!=='workflow'||!plain(recipe.definition)||recipe.definition.schemaVersion!==1||!Array.isArray(recipe.definition.steps)||recipe.definition.steps.length>30||recipe.definition.steps.some(s=>!plain(s)||!['type','click','swipe','check','select','assert','extract'].includes(s.kind)))return unknownCapabilityFidelity();
   steps=recipe.definition.steps;if(steps.some(step=>step.kind==='type'&&step.replace!==true))return unknownCapabilityFidelity();
   outputs=steps.filter(s=>s.kind==='extract').map(s=>projected(name(s.output)||'*','semantic_provider_text_projection'));
  }else{
   if(recipe.recipeType!==undefined||!Array.isArray(recipe.steps)||recipe.steps.length>80||recipe.steps.some(s=>!plain(s?.action)||!['click','type','swipe','back','launch'].includes(s.action.kind)))return unknownCapabilityFidelity();
   steps=recipe.steps.map(s=>s.action);
  }
  const inputs=steps.filter(s=>s.kind==='type').map(s=>nativeInput(s,device));if(inputs.some(s=>!s))return unknownCapabilityFidelity();
  return base(adapter,['native_semantic','fixed_ui_actions'],inputs,outputs,['provider_text_is_not_app_buffer_truth','fresh_source_checks_are_not_atomic','secure_missing_or_ambiguous_values_cannot_prove_echo','semantic_outputs_may_be_extracted_redacted_or_bounded','non_string_parameters_use_scalar_text_representation',...(sourceKind==='ios'?['ios_keyboard_role_subtrees_out_of_semantic_scope']:[])]);
 }
 if(adapter==='browser-workflow'){
  const spec=recipe.spec;if(recipe.kind!=='browser-workflow'||!plain(spec)||spec.schemaVersion!==1||!Array.isArray(spec.steps)||spec.steps.length>80||!Array.isArray(spec.extract)||spec.extract.length>32||spec.steps.some(s=>!plain(s)||!['fill','click','select','check','choose','visualClick','visualFill'].includes(s.kind)))return unknownCapabilityFidelity();
  const channels=['browser_dom','fixed_ui_actions'],inputs=[],outputs=[];
  for(const step of spec.steps){
   if(step.closedShadow)channels.push('closed_shadow_dom');
   if(['visualClick','visualFill'].includes(step.kind))channels.push('rendered_ocr');
   if(['fill','visualFill'].includes(step.kind)&&step.param!==undefined){if(!name(step.param))return unknownCapabilityFidelity();inputs.push({parameter:step.param,contract:step.kind==='visualFill'?'rendered_ocr_normalized_echo_required':'dom_value_echo_required',mode:'replace',domain:step.kind==='visualFill'?'schema_with_whitespace_collapsed_echo':'exposed_input_schema'});}
  }
  for(const output of spec.extract){if(!name(output?.name)||!['text','table','visualText'].includes(output.kind))return unknownCapabilityFidelity();if(output.kind==='visualText')channels.push('rendered_ocr');outputs.push(projected(output.name,output.kind==='visualText'?'rendered_ocr_projection':'visible_dom_projection'));}
  if(spec.assertions?.some(a=>a.visual))channels.push('rendered_ocr');
  return base(adapter,channels,inputs,outputs,['dom_values_are_not_app_buffer_or_business_truth','rendered_ocr_cannot_prove_source_codepoints','visual_echo_may_collapse_whitespace','outputs_are_projected_redacted_and_bounded',...(stagedBrowser?['closed_stage_startup_grant_required','closed_host_and_targets_stable_within_explicit_stage']:[])]);
 }
 if(adapter==='browser'&&recipe.recipeType===undefined&&Array.isArray(recipe.steps)&&recipe.steps.length<=80){
  const channels=['browser_dom','fixed_ui_actions'];if(recipe.steps.some(s=>['visualClick','visualFill'].includes(s?.action?.kind)))channels.push('rendered_ocr');
  return base('browser',channels,[],[projected('*','visible_dom_projection')],['fixed_recorded_actions_do_not_offer_general_text_input','visible_dom_is_projected_redacted_and_bounded','ui_completion_is_not_business_equivalence']);
 }
 return unknownCapabilityFidelity();
}
export function capabilityFidelity({adapter,recipe,device,sourceKind}={}){
 const result=deriveCapabilityFidelity({adapter,recipe,device,sourceKind});
 if(result.fidelity.inputText.length>30||result.fidelity.outputs.length>32||Buffer.byteLength(JSON.stringify(result))>8192)return unknownCapabilityFidelity('metadata_contract_limit');
 return result;
}
export function sourceRouteDiscovery(capabilities){
 const http=capabilities.filter(cap=>cap.kind==='http'),ready=http.filter(cap=>cap.modality?.adapter==='http'&&cap.readiness==='ready');
 return {schemaVersion:CAPABILITY_FIDELITY_VERSION,contractStatus:'current',revisionScoped:true,explicitChoiceRequired:true,automaticFallback:false,businessEquivalence:'not_asserted',availableChannels:unique(capabilities.flatMap(cap=>cap.modality?.channels||['unknown'])),http:{total:http.length,ready:ready.length,candidate:http.length-ready.length,readyPreview:ready.slice(0,8).map(cap=>({capabilityId:cap.id,revision:cap.revision,effect:cap.effect})),moreReady:ready.length>8,discovery:'page_same_source_catalog_for_http_capabilities'}};
}
