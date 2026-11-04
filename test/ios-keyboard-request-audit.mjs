// Pure audit of recorded owned-session requests. Never sends a WebDriver request.
import assert from 'node:assert/strict';

const requireAudit=(value,reason)=>assert.ok(value,'IOS_REQUEST_AUDIT: '+reason);
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const inside=(point,box)=>point.x>=box.x&&point.y>=box.y&&point.x<box.x+box.width&&point.y<box.y+box.height;
const overlaps=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
function normalizedBox(value,geometry,label){
 const box=value?.normalized??value;
 requireAudit(exactKeys(box,['x','y','width','height'])&&Object.values(box).every(Number.isFinite)&&box.x>=0&&box.y>=0&&box.width>0&&box.height>0&&box.x+box.width<=1&&box.y+box.height<=1,label+'_region');
 return {x:box.x*geometry.width,y:box.y*geometry.height,width:box.width*geometry.width,height:box.height*geometry.height};
}
function recordedBody(row,index){
 requireAudit(typeof row.body==='string'&&Buffer.byteLength(row.body)<=65536,'row_'+index+'_body');
 try{return JSON.parse(row.body);}catch{requireAudit(false,'row_'+index+'_json');}
}
function pointer(body,geometry,index){
 requireAudit(exactKeys(body,['actions'])&&Array.isArray(body.actions)&&body.actions.length===1,'row_'+index+'_single_pointer');
 const value=body.actions[0];
 requireAudit(exactKeys(value,['type','id','parameters','actions'])&&value.type==='pointer'&&['finger','keyboard-key'].includes(value.id)&&exactKeys(value.parameters,['pointerType'])&&value.parameters.pointerType==='touch','row_'+index+'_pointer_identity');
 requireAudit(Array.isArray(value.actions)&&value.actions.length===3,'row_'+index+'_pointer_sequence');
 const [move,down,up]=value.actions;
 requireAudit(exactKeys(move,['type','duration','x','y','origin'])&&move.type==='pointerMove'&&move.duration===0&&move.origin==='viewport'&&Number.isSafeInteger(move.x)&&Number.isSafeInteger(move.y)&&move.x>=0&&move.x<geometry.width&&move.y>=0&&move.y<geometry.height,'row_'+index+'_pointer_move');
 for(const [action,type]of [[down,'pointerDown'],[up,'pointerUp']])requireAudit(exactKeys(action,['type','button'])&&action.type===type&&action.button===0,'row_'+index+'_pointer_buttons');
 return {id:value.id,point:{x:move.x,y:move.y}};
}

export function assertDeviceRequestWindow({rows,sessionId,onscreen=false,geometry,keyboardRegion,anchorContracts,expectedOutsideSequence}){
 requireAudit(Array.isArray(rows)&&rows.length<=100000,'rows');
 requireAudit(typeof sessionId==='string'&&/^[A-Za-z0-9_.-]{1,256}$/.test(sessionId),'session_id');
 requireAudit(typeof onscreen==='boolean','onscreen');
 requireAudit(exactKeys(geometry,['width','height'])&&[geometry.width,geometry.height].every(value=>Number.isFinite(value)&&value>0&&value<=16384),'geometry');
 const keyboard=normalizedBox(keyboardRegion,geometry,'keyboard');
 let anchors=null;
 if(anchorContracts!==undefined){
  requireAudit(exactKeys(anchorContracts,['focus','dismiss','submit']),'anchor_contracts');
  anchors=Object.fromEntries(Object.entries(anchorContracts).map(([name,value])=>[name,normalizedBox(value,geometry,name)]));
  for(const [name,box]of Object.entries(anchors)){
   requireAudit(!overlaps(box,keyboard),name+'_overlaps_keyboard');
   requireAudit(!Object.entries(anchors).some(([other,value])=>other!==name&&overlaps(box,value)),name+'_ambiguous_anchor');
  }
  requireAudit(Array.isArray(expectedOutsideSequence)&&expectedOutsideSequence.every(name=>['focus','dismiss','submit'].includes(name)),'expected_outside_sequence');
 }else requireAudit(expectedOutsideSequence===undefined,'expected_sequence_requires_anchors');
 const prefix='/session/'+sessionId;
 const reads=new Set(['/source','/screenshot','/window/rect','/orientation']);
 const classified=[];
 for(const [index,row]of rows.entries()){
  requireAudit(row&&typeof row==='object'&&typeof row.method==='string'&&typeof row.path==='string','row_'+index+'_shape');
  requireAudit(!row.error&&Number.isInteger(row.responseStatus)&&row.responseStatus>=200&&row.responseStatus<300,'row_'+index+'_response');
  const route=row.path.startsWith(prefix+'/')?row.path.slice(prefix.length):null;
  requireAudit(route&&!route.includes('?')&&!route.includes('#'),'row_'+index+'_session_route');
  const entry={id:row.id??index,route};
  if(row.method==='GET'&&reads.has(route)){
   requireAudit(row.body===undefined||row.body==='','row_'+index+'_get_body');
   classified.push({...entry,kind:'read'});continue;
  }
  if(row.method==='POST'&&route==='/execute/sync'){
   const body=recordedBody(row,index);
   requireAudit(exactKeys(body,['script','args'])&&body.script==='mobile: activeAppInfo'&&Array.isArray(body.args)&&body.args.length===0,'row_'+index+'_foreground_only');
   classified.push({...entry,kind:'foreground'});continue;
  }
  if(row.method==='POST'&&route==='/keys'&&!onscreen){
   const body=recordedBody(row,index);
   requireAudit(exactKeys(body,['value'])&&Array.isArray(body.value)&&body.value.length===1&&typeof body.value[0]==='string'&&(/^[A-Za-z0-9]{1,16}$/.test(body.value[0])||/^[\b]{1,16}$/.test(body.value[0])),'row_'+index+'_bounded_default_keys');
   classified.push({...entry,kind:/^[\b]+$/.test(body.value[0])?'clear-keys':'type-keys'});continue;
  }
  requireAudit(row.method==='POST'&&route==='/actions','row_'+index+'_unknown_route');
  const action=pointer(recordedBody(row,index),geometry,index);
  if(action.id==='keyboard-key'){
   requireAudit(onscreen&&inside(action.point,keyboard),'row_'+index+'_keyboard_point');
   classified.push({...entry,kind:'keyboard',point:action.point});continue;
  }
  requireAudit(!inside(action.point,keyboard),'row_'+index+'_finger_inside_keyboard');
  const matches=anchors?Object.entries(anchors).filter(([,box])=>inside(action.point,box)).map(([name])=>name):[];
  requireAudit(!anchors||matches.length===1,'row_'+index+'_finger_anchor');
  classified.push({...entry,kind:'finger',point:action.point,...(anchors?{anchor:matches[0]}:{})});
 }
 const fingers=classified.filter(row=>row.kind==='finger');
 const outsideSequence=anchors?fingers.map(row=>row.anchor):null;
 if(anchors)assert.deepEqual(outsideSequence,expectedOutsideSequence,'IOS_REQUEST_AUDIT: outside_sequence');
 return {classificationOnly:!anchors,outsideSequenceVerified:!!anchors,outsideSequence,
  keyboardSourceIdentityVerified:false,keySequenceVerified:false,
  counts:{rows:rows.length,reads:classified.filter(row=>row.kind==='read').length,foreground:classified.filter(row=>row.kind==='foreground').length,
   keyboard:classified.filter(row=>row.kind==='keyboard').length,finger:fingers.length,
   clearKeys:classified.filter(row=>row.kind==='clear-keys').length,typeKeys:classified.filter(row=>row.kind==='type-keys').length},classified};
}
