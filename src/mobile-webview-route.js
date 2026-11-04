// Backend selection is bound to the trusted device config, never call params.
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>{throw Object.assign(new Error(code),{code});};
export const isWebViewDevice=device=>device?.backend?.type==='appium-webview';
export function mobileBackendKind(backend){
 if(backend?.type==='appium-webview')return backend.platform==='ios'?'ios':backend.platform==='android'?'apk':null;
 if(backend?.type==='adb'||backend?.type==='webdriver'&&backend.platform==='android')return 'apk';
 if(backend?.type==='webdriver'&&(!backend.platform||backend.platform==='ios'))return 'ios';
 return null;
}
export function webViewModuleFor(device,{sourceKind,operation,recipe}={}){
 const marked=recipe?.recipeType==='webview_workflow'||plain(recipe)&&Object.hasOwn(recipe,'webviewPlan')||plain(recipe?.definition)&&Object.hasOwn(recipe.definition,'webviewPlan');
 if(!isWebViewDevice(device)){
  if(marked)fail('WEBVIEW_BACKEND_REQUIRED');
  return null;
 }
 const expected=mobileBackendKind(device.backend);
 if(!expected||sourceKind!==expected)fail('WEBVIEW_DRIVER_PROFILE_UNSUPPORTED');
 if(device.backend.platform==='android'){
  const association=device.backend.webview?.association,textTransport=device.backend.webview?.textTransport;
  if(!plain(association)||Object.keys(association).length!==1||association.mode!=='uiautomator2_devtools_v1'||!plain(textTransport)||Object.keys(textTransport).length!==1||textTransport.mode!=='chromedriver_cdp_insert_text_v1')fail('WEBVIEW_DRIVER_PROFILE_UNSUPPORTED');
 }
 if(['nativeStagePlanning','nativeBranchPlanning','nativeVisualWorkflow'].some(key=>device[key]!==undefined&&device[key]!==null))fail('WEBVIEW_NATIVE_MODE_CONFLICT');
 if(!['explore','plan','learn','execute'].includes(operation))fail('WEBVIEW_OPERATION_UNSUPPORTED');
 if(operation==='learn'&&(!plain(recipe?.webviewPlan)||recipe.webviewPlan.schemaVersion!==1||recipe.stagePlan||recipe.branchPlan||recipe.kind==='native-visual-workflow'))fail('WEBVIEW_WORKFLOW_PLAN_REQUIRED');
 if(operation==='execute'&&(recipe?.recipeType!=='webview_workflow'||!plain(recipe.webviewPlan)||recipe.webviewPlan.schemaVersion!==1||recipe.definition?.stagePlan||recipe.definition?.branchPlan))fail('WEBVIEW_RECIPE_REQUIRED');
 return operation==='plan'?'apk_inventory.mobile_webview_planner':'apk_inventory.mobile_webview';
}
