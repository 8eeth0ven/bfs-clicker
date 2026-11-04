// Explicit local fixture-owner input. This file never grants public MCP access.
import path from 'node:path';
import {lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {readArtifactText} from '../src/artifact-text.js';
const fail=()=>{throw Error('KEYBOARD_OWNER_APPROVAL_INVALID');};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function keyboardOwnerApproval(file,{root,appId,window}){
 if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))fail();
 const absolute=path.resolve(file),relative=path.relative(path.resolve(root),absolute);
 if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))fail();
 let current=path.parse(absolute).root;
 for(const part of absolute.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);if(lstatSync(current).isSymbolicLink())fail();}
 const {document}=readArtifactText(absolute,8192);let value;
 try{value=JSON.parse(document);}catch{fail();}
 if(!exact(value,['schemaVersion','appId','window','visualEnvelope'])||value.schemaVersion!==1||value.appId!==appId||!exact(value.window,['x','y','width','height'])||!exact(value.visualEnvelope,['x','y','width','height']))fail();
 if(!exact(window,['x','y','width','height'])||window.x!==0||window.y!==0||!['width','height'].every(k=>Number.isSafeInteger(window[k])&&window[k]>0&&window[k]<=16384)||Object.keys(window).some(k=>value.window[k]!==window[k]))fail();
 const r=value.visualEnvelope;
 if(Object.values(r).some(v=>typeof v!=='number'||!Number.isFinite(v))||r.x!==0||r.width!==window.width||r.y<window.height*.5||r.y>window.height*.85||r.height<=0||r.y+r.height<window.height*.95||r.y+r.height>window.height)fail();
 return {approval:{appId,visualEnvelope:{...r}},record:{file:relative,sha256:createHash('sha256').update(document).digest('hex'),definition:value,authority:'explicit_local_fixture_owner',mcpGrant:false}};
}
