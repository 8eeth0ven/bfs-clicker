import test from 'node:test';
import assert from 'node:assert/strict';
import {isWebViewDevice,mobileBackendKind,webViewModuleFor} from '../src/mobile-webview-route.js';

const device={backend:{type:'appium-webview',platform:'ios'}};
const definition={schemaVersion:1,webviewPlan:{schemaVersion:1},steps:[]};
const recipe={schemaVersion:1,recipeType:'webview_workflow',webviewPlan:{schemaVersion:1},definition:{schemaVersion:1,steps:[]}};
test('explicit WebView devices select their own planning and execution modules',()=>{
 assert(isWebViewDevice(device));assert.equal(mobileBackendKind(device.backend),'ios');
 for(const operation of ['explore','plan','learn','execute'])assert.equal(webViewModuleFor(device,{sourceKind:'ios',operation,recipe:operation==='learn'?definition:operation==='execute'?recipe:undefined}),operation==='plan'?'apk_inventory.mobile_webview_planner':'apk_inventory.mobile_webview');
});
test('explicit Android WebViews retain their own source kind and never select a native module',()=>{
 const d={backend:{type:'appium-webview',platform:'android',webview:{association:{mode:'uiautomator2_devtools_v1'},textTransport:{mode:'chromedriver_cdp_insert_text_v1'}}}};
 assert.equal(mobileBackendKind(d.backend),'apk');
 for(const operation of ['explore','plan','learn','execute'])assert.equal(webViewModuleFor(d,{sourceKind:'apk',operation,recipe:operation==='learn'?definition:operation==='execute'?recipe:undefined}),operation==='plan'?'apk_inventory.mobile_webview_planner':'apk_inventory.mobile_webview');
 assert.throws(()=>webViewModuleFor(d,{sourceKind:'ios',operation:'explore'}),{code:'WEBVIEW_DRIVER_PROFILE_UNSUPPORTED'});
 for(const association of [undefined,null,{}, {mode:'reported_bundle_id_v1'},{mode:'uiautomator2_devtools_v1',pid:7}]){
  assert.throws(()=>webViewModuleFor({backend:{...d.backend,webview:{...d.backend.webview,association}}},{sourceKind:'apk',operation:'explore'}),{code:'WEBVIEW_DRIVER_PROFILE_UNSUPPORTED'});
 }
 for(const textTransport of [undefined,null,{}, {mode:'w3c_value'},{mode:'chromedriver_cdp_insert_text_v1',cmd:'Runtime.evaluate'}])assert.throws(()=>webViewModuleFor({backend:{...d.backend,webview:{...d.backend.webview,textTransport}}},{sourceKind:'apk',operation:'explore'}),{code:'WEBVIEW_DRIVER_PROFILE_UNSUPPORTED'});
});
test('ordinary native devices retain their existing dispatch',()=>{
 for(const backend of [{type:'adb'},{type:'webdriver',platform:'android'},{type:'webdriver',platform:'ios'},{type:'webdriver'}]){
  assert.equal(webViewModuleFor({backend},{sourceKind:mobileBackendKind(backend),operation:'explore'}),null);
 }
 assert.equal(mobileBackendKind({type:'adb'}),'apk');assert.equal(mobileBackendKind({type:'webdriver',platform:'android'}),'apk');
 assert.equal(mobileBackendKind({type:'webdriver'}),'ios');assert.equal(mobileBackendKind({type:'other'}),null);
});
test('a missing or unverified WebView profile cannot fall through to native',()=>{
 for(const sourceKind of ['apk','web',undefined])assert.throws(()=>webViewModuleFor(device,{sourceKind,operation:'explore'}),{code:'WEBVIEW_DRIVER_PROFILE_UNSUPPORTED'});
 for(const platform of ['other',undefined]){
  const value={backend:{type:'appium-webview',platform}};assert.equal(mobileBackendKind(value.backend),null);
  assert.throws(()=>webViewModuleFor(value,{sourceKind:'ios',operation:'explore'}),{code:'WEBVIEW_DRIVER_PROFILE_UNSUPPORTED'});
 }
});
test('native modes and malformed WebView recipes fail before selecting a module',()=>{
 for(const key of ['nativeStagePlanning','nativeBranchPlanning','nativeVisualWorkflow'])assert.throws(()=>webViewModuleFor({...device,[key]:{}},{sourceKind:'ios',operation:'explore'}),{code:'WEBVIEW_NATIVE_MODE_CONFLICT'});
 for(const value of [undefined,{}, {...definition,webviewPlan:{schemaVersion:2}},{...definition,stagePlan:{}},{...definition,branchPlan:{}}])assert.throws(()=>webViewModuleFor(device,{sourceKind:'ios',operation:'learn',recipe:value}),{code:'WEBVIEW_WORKFLOW_PLAN_REQUIRED'});
 for(const value of [undefined,{...recipe,recipeType:'workflow'},{...recipe,webviewPlan:{}},{...recipe,definition:{stagePlan:{}}}])assert.throws(()=>webViewModuleFor(device,{sourceKind:'ios',operation:'execute',recipe:value}),{code:'WEBVIEW_RECIPE_REQUIRED'});
 assert.throws(()=>webViewModuleFor(device,{sourceKind:'ios',operation:'switchContext'}),{code:'WEBVIEW_OPERATION_UNSUPPORTED'});
});
test('WebView workflow markers cannot authorize a native backend',()=>{
 for(const value of [recipe,definition,{definition}])assert.throws(()=>webViewModuleFor({backend:{type:'webdriver',platform:'ios'}},{sourceKind:'ios',operation:'execute',recipe:value}),{code:'WEBVIEW_BACKEND_REQUIRED'});
});
