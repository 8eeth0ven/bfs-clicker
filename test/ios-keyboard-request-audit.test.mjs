import assert from 'node:assert/strict';
import test from 'node:test';
import {assertDeviceRequestWindow as audit} from './ios-keyboard-request-audit.mjs';

const sessionId='owned-session',prefix='/session/'+sessionId;
const geometry={width:100,height:200},keyboardRegion={x:0,y:.5,width:1,height:.5};
const anchorContracts={focus:{normalized:{x:.1,y:.1,width:.2,height:.1}},dismiss:{normalized:{x:.6,y:.3,width:.2,height:.1}},submit:{normalized:{x:.1,y:.3,width:.2,height:.1}}};
const options={sessionId,onscreen:true,geometry,keyboardRegion,anchorContracts};
const row=(method,route,body)=>({method,path:prefix+route,responseStatus:200,body:body===undefined?'':JSON.stringify(body)});
const tap=(id,x,y)=>row('POST','/actions',{actions:[{type:'pointer',id,parameters:{pointerType:'touch'},actions:[{type:'pointerMove',duration:0,x,y,origin:'viewport'},{type:'pointerDown',button:0},{type:'pointerUp',button:0}]}]});
const focus=()=>tap('finger',20,30),dismiss=()=>tap('finger',70,70),submit=()=>tap('finger',20,70),key=()=>tap('keyboard-key',20,130);
const reject=(rows,extra={})=>assert.throws(()=>audit({...options,rows,expectedOutsideSequence:['focus'],...extra}),/IOS_REQUEST_AUDIT/);

test('recorded session routes and exact touch bodies prove the outside sequence',()=>{
 const reads=['/source','/screenshot','/window/rect','/orientation'].map(route=>row('GET',route));
 const result=audit({...options,rows:[...reads,row('POST','/execute/sync',{script:'mobile: activeAppInfo',args:[]}),focus(),key(),dismiss(),submit()],expectedOutsideSequence:['focus','dismiss','submit']});
 assert.equal(result.outsideSequenceVerified,true);assert.equal(result.classificationOnly,false);
 assert.deepEqual(result.counts,{rows:9,reads:4,foreground:1,keyboard:1,finger:3,clearKeys:0,typeKeys:0});
 assert.equal(result.keyboardSourceIdentityVerified,false);assert.equal(result.keySequenceVerified,false);
});
test('all element writes and other execute scripts are rejected, so old zero counters cannot conceal UI',()=>{
 for(const candidate of [row('POST','/element/E/click',{}),row('POST','/element/E/value',{text:'x'}),row('POST','/execute/sync',{script:'mobile: tap',args:[{x:1,y:1}]}),row('POST','/execute/sync',{script:'mobile: keys',args:[]}),row('DELETE','/session'),row('POST','/url',{url:'x'})])reject([candidate]);
});
test('route, method, session and response matching is exact',()=>{
 for(const candidate of [row('GET','/source?x=1'),row('GET','/element/E/text'),{...row('GET','/source'),path:'/session/unowned/source'},row('post','/actions',{}),{...focus(),responseStatus:500},{...focus(),error:'forwarding failed'},row('GET','/source',{extra:true})])reject([candidate]);
});
test('foreground read allows only the exact script and empty args',()=>{
 for(const body of [{script:'mobile: activeAppInfo',args:[{}]},{script:'mobile: activeAppInfo'},{script:'mobile: activeAppInfo',args:[],extra:true},{script:'mobile: activeAppInfo ',args:[]}])reject([row('POST','/execute/sync',body)]);
});
test('missing or reordered pointer actions, another source, unknown ids and extra fields are rejected',()=>{
 for(const change of [body=>body.actions.push(body.actions[0]),body=>body.actions[0].actions.pop(),body=>body.actions[0].actions.reverse(),body=>body.actions[0].type='key',body=>body.actions[0].id='invented',body=>body.actions[0].parameters.pointerType='mouse',body=>body.actions[0].actions[0].origin='pointer',body=>body.actions[0].actions[0].duration=1,body=>body.actions[0].actions[0].x=20.5,body=>body.actions[0].actions[1].button=1,body=>body.actions[0].extra=true]){
  const candidate=focus(),body=JSON.parse(candidate.body);change(body);candidate.body=JSON.stringify(body);reject([candidate]);
 }
});
test('key id is not enough: all keyboard and finger coordinates must have the approved geometric role',()=>{
 reject([tap('keyboard-key',20,30)]);reject([tap('keyboard-key',20,200)]);reject([tap('finger',20,130)]);reject([tap('finger',95,95)]);
 // Old 7-key +3-nonkey count assertions accepted these all-Keyboard taps.
 reject([...Array.from({length:7},key),tap('finger',20,130),tap('finger',20,130),tap('finger',20,130)],{expectedOutsideSequence:['focus','dismiss','submit']});
});
test('outside actions are each matched in order and cannot hide a repeated submit or swapped role',()=>{
 reject([focus(),key(),submit(),dismiss()],{expectedOutsideSequence:['focus','dismiss','submit']});
 reject([focus(),key(),dismiss(),submit(),submit()],{expectedOutsideSequence:['focus','dismiss','submit']});
 reject([focus(),key(),dismiss()],{expectedOutsideSequence:['focus','dismiss','submit']});
});
test('classification without anchor contracts is explicit and never verifies an outside sequence',()=>{
 const result=audit({sessionId,onscreen:true,geometry,keyboardRegion,rows:[focus(),key()]});
 assert.equal(result.classificationOnly,true);assert.equal(result.outsideSequenceVerified,false);assert.equal(result.outsideSequence,null);
 reject([focus()],{anchorContracts:undefined});
});
test('invalid/overlapping anchor contracts cannot grant an ambiguous action',()=>{
 for(const anchors of [{...anchorContracts,submit:anchorContracts.dismiss},{...anchorContracts,focus:{normalized:keyboardRegion}},{focus:anchorContracts.focus}, {...anchorContracts,focus:{x:0,y:0,width:2,height:1}}])reject([focus()],{anchorContracts:anchors});
});
test('onscreen rejects every /keys request while explicit default accepts only its bounded text-event shapes',()=>{
 const text=row('POST','/keys',{value:['Ab7z']}),clear=row('POST','/keys',{value:['\b'.repeat(16)]});
 reject([text]);reject([clear]);
 const result=audit({...options,onscreen:false,rows:[focus(),clear,text,dismiss(),submit()],expectedOutsideSequence:['focus','dismiss','submit']});
 assert.equal(result.counts.clearKeys,1);assert.equal(result.counts.typeKeys,1);
 for(const body of [{value:['x'.repeat(17)]},{value:['a','b']},{value:['a\b']},{value:['Ab7z'],text:'other'},{value:['中文']}])reject([row('POST','/keys',body)],{onscreen:false});
 reject([key()],{onscreen:false});
});
