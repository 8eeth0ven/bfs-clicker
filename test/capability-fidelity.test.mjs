import test from 'node:test';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {root} from './helpers.mjs';
import assert from 'node:assert/strict';
import {capabilityFidelity,sourceRouteDiscovery} from '../src/capability-fidelity.js';
const semantic={schemaVersion:1,recipeType:'workflow',definition:{schemaVersion:1,steps:[{kind:'type',input:'query',replace:true},{kind:'click'},{kind:'assert'},{kind:'extract',output:'result'}]}};
const device={backend:{type:'webdriver',platform:'ios'}};
test('fidelity describes provider echo checks, not underlying app string truth',()=>{
 const result=capabilityFidelity({adapter:'mobile-workflow',recipe:semantic,device,sourceKind:'ios'});
 assert(result.modality.channels.includes('native_semantic'));
 assert.deepEqual(result.fidelity.inputText,[{parameter:'query',contract:'provider_codepoint_echo_required',mode:'replace',domain:'utf8_no_c0_del_or_webdriver_keys',maxCodePoints:2048}]);
 assert.equal(result.fidelity.outputs[0].sourceCodepointsProven,false);assert(result.fidelity.limits.includes('provider_text_is_not_app_buffer_truth'));
});
test('a visual mobile recipe never inherits semantic fidelity from its webdriver backend',()=>{
 const recipe={schemaVersion:1,recipeType:'ios_visual_workflow',definition:{kind:'native-visual-workflow',mode:'text-replace',inputName:'query'}};
 const result=capabilityFidelity({adapter:'mobile-workflow',recipe,device,sourceKind:'ios'});
 assert.deepEqual(result.modality.channels,['fixed_ui_actions','rendered_ocr']);assert.equal(result.fidelity.inputText[0].contract,'rendered_ocr_echo_required');assert.equal(result.fidelity.outputs[0].sourceCodepointsProven,false);assert(!JSON.stringify(result).includes('provider_codepoint_echo_required'));
});
test('unknown recipe fields and mobile kind alone cannot assert semantic quality',()=>{
 for(const recipe of [null,{schemaVersion:1,recipeType:'custom-exact',fidelity:{exact:true}},{schemaVersion:1,recipeType:'workflow',definition:{steps:[{kind:'type',input:'query'}]}}]){
  const result=capabilityFidelity({adapter:'mobile-workflow',recipe,device,sourceKind:'ios'});assert.deepEqual(result.modality.channels,['unknown']);assert.equal(result.fidelity.inputText.length,0);
 }
});
test('ADB ASCII command and owner Unicode IME contracts are distinguished from webdriver',()=>{
 const args={adapter:'mobile-workflow',recipe:semantic,sourceKind:'apk'};
 const ascii=capabilityFidelity({...args,device:{backend:{type:'adb'}}});assert.equal(ascii.fidelity.inputText[0].contract,'command_only_no_exact_echo');
 const unicode=capabilityFidelity({...args,device:{backend:{type:'adb',unicodeInput:{component:'com.bfs.mcp.ime/.UnicodeIme',apkSha256:'a'.repeat(64)}}}});assert.equal(unicode.fidelity.inputText[0].domain,'owner_unicode_ime_utf8_no_nul');
 for(const config of [{enabled:true},{component:'com.bfs.mcp.ime/.UnicodeIme',apkSha256:'a'.repeat(64),enabled:true},{component:'wrong/.Ime',apkSha256:'a'.repeat(64)},{component:'com.bfs.mcp.ime/.UnicodeIme',apkSha256:'A'.repeat(64)}])assert.deepEqual(capabilityFidelity({...args,device:{backend:{type:'adb',unicodeInput:config}}}).modality.channels,['unknown']);
 const mismatch=capabilityFidelity({...args,device});assert.deepEqual(mismatch.modality.channels,['unknown']);
});
test('mixed DOM and visual browser fields retain per-field contracts',()=>{
 const recipe={schemaVersion:1,kind:'browser-workflow',spec:{schemaVersion:1,steps:[{kind:'fill',param:'dom'},{kind:'visualFill',param:'painted'},{kind:'visualClick'}],extract:[{name:'domResult',kind:'text'},{name:'paintedResult',kind:'visualText'}],assertions:[]}};
 const result=capabilityFidelity({adapter:'browser-workflow',recipe});assert(result.modality.channels.includes('rendered_ocr'));assert.equal(result.fidelity.inputText[0].contract,'dom_value_echo_required');assert.equal(result.fidelity.inputText[1].contract,'rendered_ocr_normalized_echo_required');assert.deepEqual(result.fidelity.outputs.map(x=>x.contract),['visible_dom_projection','rendered_ocr_projection']);
});
test('fixed actions, literal values and oversized unknown contracts never become exact text interfaces',()=>{
 const fixed=capabilityFidelity({adapter:'browser',recipe:{schemaVersion:1,steps:[{action:{kind:'click',value:'PRIVATE-FIXTURE-LITERAL'}}]}});assert.equal(fixed.fidelity.inputText.length,0);assert(!JSON.stringify(fixed).includes('PRIVATE-FIXTURE-LITERAL'));
 const large=capabilityFidelity({adapter:'mobile-workflow',device,sourceKind:'ios',recipe:{...semantic,definition:{schemaVersion:1,steps:Array(31).fill({kind:'type',input:'query'})}}});assert.deepEqual(large.modality.channels,['unknown']);assert(Buffer.byteLength(JSON.stringify(large))<8192);
});
test('source HTTP discovery is finite, explicit and does not claim business equivalence',()=>{
 const rows=Array.from({length:12},(_,i)=>({id:'cap_'+String(i).padStart(64,'0'),revision:'a'.repeat(64),kind:'http',effect:i%2?'read':'write',readiness:i===11?'candidate':'ready',...capabilityFidelity({adapter:'http'})}));
 const before=JSON.stringify(rows),result=sourceRouteDiscovery(rows);assert.equal(result.http.ready,11);assert.equal(result.http.readyPreview.length,8);assert.equal(result.http.moreReady,true);assert.equal(result.automaticFallback,false);assert.equal(result.businessEquivalence,'not_asserted');assert.equal(JSON.stringify(rows),before);
});
test('append is a primitive webdriver contract, not an unsupported native workflow mode',()=>{
 const malformed={...semantic,definition:{...semantic.definition,steps:semantic.definition.steps.map(s=>s.kind==='type'?{...s,replace:false}:s)}};
 assert.deepEqual(capabilityFidelity({adapter:'mobile-workflow',recipe:malformed,device,sourceKind:'ios'}).modality.channels,['unknown']);
 const primitive=capabilityFidelity({adapter:'mobile',recipe:{schemaVersion:1,steps:[{action:{kind:'type',input:'text'}}]},device,sourceKind:'ios'});assert.equal(primitive.fidelity.inputText[0].mode,'append');assert.equal(primitive.fidelity.inputText[0].contract,'provider_codepoint_echo_required');
});
test('IME opt-in metadata uses the actual Python validator shape',()=>{
 const configurations=[null,{component:'com.bfs.mcp.ime/.UnicodeIme',apkSha256:'a'.repeat(64)},{enabled:true},{component:'com.bfs.mcp.ime/.UnicodeIme',apkSha256:'a'.repeat(64),enabled:true},{component:'other/.Ime',apkSha256:'a'.repeat(64)}];
 const code="import json,sys;from apk_inventory.android_unicode import validate\nout=[]\nfor c in json.load(sys.stdin):\n try:validate(c,ValueError);out.append(True)\n except ValueError:out.append(False)\nprint(json.dumps(out))";
 const result=spawnSync(path.join(root,'.venv/bin/python'),['-c',code],{input:JSON.stringify(configurations),encoding:'utf8',env:{...process.env,PYTHONPATH:path.join(root,'apk_tools'),PYTHONDONTWRITEBYTECODE:'1'},timeout:5000});assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');const accepted=JSON.parse(result.stdout);assert.deepEqual(accepted,[true,true,false,false,false]);
 for(let i=0;i<configurations.length;i++){const value=capabilityFidelity({adapter:'mobile-workflow',recipe:semantic,sourceKind:'apk',device:{backend:{type:'adb',unicodeInput:configurations[i]}}});if(!accepted[i])assert.deepEqual(value.modality.channels,['unknown']);else assert.equal(value.fidelity.inputText[0].contract,i===0?'command_only_no_exact_echo':'provider_codepoint_echo_required');}
});
