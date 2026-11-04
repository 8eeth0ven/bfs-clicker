// Observation records are private, bounded evidence, never execution grants.
import {createHash} from 'node:crypto';
import {readArtifactText} from './artifact-text.js';
export const closedStageDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function closedStageSensitiveValues(config,previous=[]){
 const values=[...previous,...Object.values(config.formValues||{}),config.fillTextValue,...Object.values(config.authInject?.headers||{}),config.proxy?.username,config.proxy?.password].filter(v=>typeof v==='string'&&v.length);
 if(config.storageState){const state=JSON.parse(readArtifactText(config.storageState,2*1024*1024).document);for(const cookie of state.cookies||[])if(typeof cookie.value==='string'&&cookie.value.length)values.push(cookie.value);for(const origin of state.origins||[])for(const row of origin.localStorage||[])if(/password|secret|token|credential|key/i.test(row.name||'')&&typeof row.value==='string'&&row.value.length)values.push(row.value);}
 const unique=[...new Set(values)];
 if(unique.length>1024||unique.some(v=>v.length>8192))throw new Error('CLOSED_STAGE_EVIDENCE_LIMIT');
 const variants=[...new Set(unique.flatMap(value=>{const bare=value.replace(/^(?:Bearer|Basic)\s+/i,'');return [value,bare,value.replace(/\s+/g,' ').trim(),bare.replace(/\s+/g,' ').trim()];}).filter(Boolean))];
 if(variants.length>1024||variants.some(v=>v.length>8192))throw new Error('CLOSED_STAGE_EVIDENCE_LIMIT');
 return variants;
}
export function bindClosedStageObservation(snapshot,observation){
 const surface=observation.surface?.find(row=>row.title==='closed_root_digests');
 if(!surface||closedStageDigest(surface.lines)!==snapshot.closedFingerprintDigest||Buffer.byteLength(JSON.stringify(snapshot))>32768)throw new Error('CLOSED_STAGE_OBSERVATION_CHANGED');
 return {...snapshot,digest:closedStageDigest(snapshot)};
}
export function validClosedStageObservation(row,workflowId){
 try{
  const {digest,...snapshot}=row;
  const anchor=a=>typeof a?.text==='string'&&a.text.length>0&&a.text.length<=160&&typeof a.tag==='string'&&a.tag.length<=32&&!['input','textarea','select','button','iframe','canvas','table'].includes(a.tag)&&a.closedShadow&&Array.isArray(a.framePath)&&a.framePath.length===0;
  return Object.keys(snapshot).sort().join(',')==='anchors,closedFingerprintDigest,documentRelation,gaps,outputs,schemaVersion,workflowId'&&snapshot.schemaVersion===1&&snapshot.workflowId===workflowId&&['initial','same','new'].includes(snapshot.documentRelation)&&Array.isArray(snapshot.anchors)&&snapshot.anchors.length>0&&snapshot.anchors.length<=32&&snapshot.anchors.every(anchor)&&Array.isArray(snapshot.outputs)&&snapshot.outputs.length<=24&&Array.isArray(snapshot.gaps)&&snapshot.gaps.length===0&&/^[a-f0-9]{64}$/.test(snapshot.closedFingerprintDigest)&&Buffer.byteLength(JSON.stringify(snapshot))<=32768&&digest===closedStageDigest(snapshot);
 }catch{return false;}
}
