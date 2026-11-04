import test from 'node:test';
import assert from 'node:assert/strict';
import {capabilityFidelity} from '../src/capability-fidelity.js';

const device={backend:{type:'appium-webview',platform:'ios',appId:'com.example.webview',webview:{context:'WEBVIEW_10.1',windowHandle:'1',origin:'https://example.test',url:'https://example.test/form'}}};
const selector=id=>({resourceId:'#'+id});
const controls=[['query','input'],['run','button'],['result','output']].map(([id,kind])=>({selector:selector(id),domContract:{kind}}));
const identity={modality:'appium_webview_dom',platform:'ios',appId:device.backend.appId,contextBundleId:device.backend.appId,context:device.backend.webview.context,windowHandle:'1',origin:device.backend.webview.origin,url:device.backend.webview.url,probeVersion:'webview-dom-probe-2',probeSha256:'b'.repeat(64),documentScope:'worker_live_reference_identity',associationMethod:'reported_bundle_id_v1'};
const recipe={schemaVersion:1,recipeType:'webview_workflow',webviewPlan:{schemaVersion:1,planningMode:'webview-dom-linear-v1',sourceIdentity:identity,sourceRevision:'a'.repeat(64),controls},definition:{schemaVersion:1,effect:'read',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false},steps:[{kind:'type',selector:selector('query'),input:'query',replace:true},{kind:'click',selector:selector('run')},{kind:'assert',selector:selector('result'),expect:{containsInput:'query',changed:true}},{kind:'extract',selector:selector('result'),output:'result',valueType:'string'}]}};
const profile=(r=recipe,d=device,sourceKind='ios')=>capabilityFidelity({adapter:'mobile-workflow',recipe:r,device:d,sourceKind});

test('WebView metadata describes DOM value and W3C commands without native or physical identity claims',()=>{
 const value=profile();assert.deepEqual(value.modality.channels,['appium_webview_dom','fixed_w3c_element_commands']);
 assert.equal(value.fidelity.inputText[0].contract,'dom_value_echo_required');assert.equal(value.fidelity.inputText[0].domain,'utf8_no_controls_surrogates_or_webdriver_keys');assert.equal(value.fidelity.outputs[0].contract,'webview_dom_text_projection');assert.equal(value.fidelity.outputs[0].sourceCodepointsProven,false);
 assert(value.fidelity.limits.includes('fresh_source_checks_are_not_atomic'));assert(value.fidelity.limits.includes('dom_values_are_not_app_buffer_or_business_truth'));
 assert(!value.modality.channels.includes('native_semantic'));assert(!JSON.stringify(value).includes('https://example.test'));
});
test('a native, unsupported-platform or mismatched-context backend cannot inherit WebView fidelity',()=>{
 for(const change of [d=>d.backend.type='webdriver',d=>d.backend.platform='android',d=>d.backend.webview.context='NATIVE_APP',d=>d.backend.appId='other.application']){
  const value=structuredClone(device);change(value);assert.deepEqual(profile(recipe,value).modality.channels,['unknown']);
 }
 assert.deepEqual(profile(recipe,device,'apk').modality.channels,['unknown']);
});
test('explicit null association uses the same default bundle contract as the Python backend',()=>{
 const d=structuredClone(device);d.backend.webview.association=null;
 assert.deepEqual(profile(recipe,d),profile());
 const r=structuredClone(recipe);r.webviewPlan.sourceIdentity.contextBundleId='process-OwnedFixture';
 assert.deepEqual(profile(r,d).modality.channels,['unknown']);
});
test('unbound or weaker WebView recipes retain unknown metadata',()=>{
 for(const change of [r=>r.recipeType='workflow',r=>delete r.webviewPlan,r=>r.webviewPlan.sourceIdentity.contextBundleId='other.application',r=>delete r.webviewPlan.sourceIdentity.probeSha256,r=>r.webviewPlan.controls.pop(),r=>r.definition.effect='write',r=>r.definition.steps[0].replace=false,r=>r.definition.steps[2].expect.changed=false,r=>r.definition.steps[2].expect.containsInput='other',r=>r.definition.steps[3].valueType='number',r=>r.definition.steps.push({kind:'swipe'}),r=>r.definition.branchPlan={}]){
  const value=structuredClone(recipe);change(value);assert.deepEqual(profile(value).modality.channels,['unknown']);
 }
});
test('a visual recipe does not acquire a WebView or native execution route from its label',()=>{
 const value=profile({schemaVersion:1,recipeType:'ios_visual_workflow',definition:{mode:'text-replace',inputName:'query'}});
 assert.deepEqual(value.modality.channels,['unknown']);
});
test('explicit main-PID association keeps raw process alias separate from the observed foreground app',()=>{
 const d=structuredClone(device),r=structuredClone(recipe);
 d.backend.webview.association={mode:'xcuitest_app_main_pid_v1',reportedBundleId:'process-OwnedFixture'};
 Object.assign(r.webviewPlan.sourceIdentity,{associationMethod:'xcuitest_app_main_pid_v1',contextBundleId:'process-OwnedFixture',appMainPid:'10'});
 assert.deepEqual(profile(r,d).modality.channels,['appium_webview_dom','fixed_w3c_element_commands']);
 assert(profile(r,d).fidelity.limits.includes('webview_app_association_uses_observed_main_pid'));
 for(const change of [v=>v.webviewPlan.sourceIdentity.appMainPid='11',v=>v.webviewPlan.sourceIdentity.appMainPid='010',v=>delete v.webviewPlan.sourceIdentity.appMainPid,v=>v.webviewPlan.sourceIdentity.context='WEBVIEW_10.01',v=>v.webviewPlan.sourceIdentity.contextBundleId=device.backend.appId]){
  const value=structuredClone(r);change(value);assert.deepEqual(profile(value,d).modality.channels,['unknown']);
 }
 const wildcard=structuredClone(d);wildcard.backend.webview.association.reportedBundleId='process-*';assert.deepEqual(profile(r,wildcard).modality.channels,['unknown']);
 const large=structuredClone(d),largeRecipe=structuredClone(r);large.backend.webview.context=largeRecipe.webviewPlan.sourceIdentity.context='WEBVIEW_10.9007199254740991';
 assert.deepEqual(profile(largeRecipe,large).modality.channels,['appium_webview_dom','fixed_w3c_element_commands']);
 large.backend.webview.context=largeRecipe.webviewPlan.sourceIdentity.context='WEBVIEW_10.9007199254740992';assert.deepEqual(profile(largeRecipe,large).modality.channels,['unknown']);
 const child=structuredClone(d),childRecipe=structuredClone(r);child.backend.webview.association.reportedBundleId=childRecipe.webviewPlan.sourceIdentity.contextBundleId='process-com.apple.WebKit.Networking';assert.deepEqual(profile(childRecipe,child).modality.channels,['unknown']);
});
function android(){
 const d=structuredClone(device),r=structuredClone(recipe),page='0123456789ABCDEF'.repeat(2);
 d.backend.platform='android';Object.assign(d.backend.webview,{context:'WEBVIEW_'+d.backend.appId,windowHandle:page,association:{mode:'uiautomator2_devtools_v1'},textTransport:{mode:'chromedriver_cdp_insert_text_v1'}});
 delete r.webviewPlan.sourceIdentity.contextBundleId;
 Object.assign(r.webviewPlan.sourceIdentity,{platform:'android',context:d.backend.webview.context,windowHandle:d.backend.webview.windowHandle,associationMethod:'uiautomator2_devtools_v1',devtoolsSocket:'@webview_devtools_remote_73',devtoolsWebview:'WEBVIEW_73',devtoolsProcessId:'73',devtoolsAndroidPackage:d.backend.appId,devtoolsPageId:page,textTransport:'chromedriver_cdp_insert_text_v1',textTransportSha256:'c'.repeat(64)});
 return {d,r};
}
test('Android metadata requires its own observed devtools process and page mapping',()=>{
 const {d,r}=android(),value=profile(r,d,'apk');
 assert.deepEqual(value.modality.channels,['appium_webview_dom','chromedriver_cdp_text','fixed_dom_focus','fixed_w3c_element_commands']);
 assert(value.fidelity.limits.includes('webview_app_association_uses_observed_android_devtools_process'));
 assert(!value.fidelity.limits.includes('webview_app_association_uses_reported_bundle_id'));
 assert.equal(value.fidelity.inputText[0].contract,'dom_value_echo_required');assert.equal(value.fidelity.inputText[0].transport,'chromedriver_cdp_insert_text_v1');
 assert.equal(value.fidelity.outputs[0].sourceCodepointsProven,false);
 assert(!JSON.stringify(value).includes('webview_devtools_remote_73'));
});
test('Android metadata cannot inherit an iOS, injected or missing association profile',()=>{
 for(const association of [undefined,null,{}, {mode:'reported_bundle_id_v1'},{mode:'xcuitest_app_main_pid_v1',reportedBundleId:'process-OwnedFixture'},{mode:'uiautomator2_devtools_v1',pid:73}]){
  const {d,r}=android();d.backend.webview.association=association;
  assert.deepEqual(profile(r,d,'apk').modality.channels,['unknown']);
 }
 const {d,r}=android();assert.deepEqual(profile(r,d,'ios').modality.channels,['unknown']);
 for(const transport of [undefined,null,{}, {mode:'w3c_value'},{mode:'chromedriver_cdp_insert_text_v1',cmd:'Runtime.evaluate'}]){
  const {d,r}=android();d.backend.webview.textTransport=transport;assert.deepEqual(profile(r,d,'apk').modality.channels,['unknown']);
 }
});
test('mismatched Android package, process, socket and target provenance never advertises DOM fidelity',()=>{
 for(const change of [i=>delete i.devtoolsSocket,i=>i.devtoolsProcessId=73,i=>i.devtoolsProcessId='073',i=>i.devtoolsProcessId='2147483648',i=>i.devtoolsSocket='@chrome_devtools_remote',i=>i.devtoolsWebview='WEBVIEW_74',i=>i.devtoolsAndroidPackage='other.application',i=>i.devtoolsPageId='not-a-target-id',i=>i.contextBundleId=device.backend.appId,i=>i.appMainPid='73',i=>delete i.textTransportSha256,i=>i.textTransport='w3c_value']){
  const {d,r}=android();change(r.webviewPlan.sourceIdentity);assert.deepEqual(profile(r,d,'apk').modality.channels,['unknown']);
 }
 const {d,r}=android();d.backend.webview.windowHandle=r.webviewPlan.sourceIdentity.windowHandle='CDwindow-'+ '0'.repeat(32);
 assert.deepEqual(profile(r,d,'apk').modality.channels,['unknown']);
});
