// Test-owner calibration proposal from two real frames; never an MCP grant.
import {readFileSync,constants,openSync,closeSync,fstatSync,readSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {visualPixelFingerprint,visualRegionsOverlap} from '../src/visual-pixels.js';
import {decodeBoundedPngSnapshot} from '../src/visual-caret.js';
export function keyboardEnvelope(beforePath,visiblePath,{valueRegion,resultRegion,sourceRegion,geometry}){
 const masks=[valueRegion,resultRegion];const bp=visualPixelFingerprint(beforePath,{masks}),vp=visualPixelFingerprint(visiblePath,{masks});
 if(bp.width!==vp.width||bp.height!==vp.height)throw Error('CALIBRATION_DIMENSIONS_CHANGED');
 const a=PNG.sync.read(readFileSync(beforePath)),b=PNG.sync.read(readFileSync(visiblePath));
 const boxes=masks.map(r=>[Math.floor(r.x*a.width),Math.floor(r.y*a.height),Math.ceil((r.x+r.width)*a.width),Math.ceil((r.y+r.height)*a.height)]);
 let minY=a.height,maxY=-1,changes=0;
 for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){
  if(boxes.some(r=>x>=r[0]&&x<r[2]&&y>=r[1]&&y<r[3]))continue;
  const i=(y*a.width+x)*4;if(a.data[i]===b.data[i]&&a.data[i+1]===b.data[i+1]&&a.data[i+2]===b.data[i+2]&&a.data[i+3]===b.data[i+3])continue;
  minY=Math.min(minY,y);maxY=Math.max(maxY,y);changes++;
 }
 if(!changes||sourceRegion.x!==0||sourceRegion.width!==1)throw Error('CALIBRATION_KEYBOARD_UNVERIFIED');
 const y0=Math.min(minY,Math.floor(sourceRegion.y*a.height)),y1=Math.max(maxY+1,Math.ceil((sourceRegion.y+sourceRegion.height)*a.height));
 const region={x:0,y:y0/a.height,width:1,height:(y1-y0)/a.height};const top=sourceRegion.y-region.y,bottom=region.y+region.height-sourceRegion.y-sourceRegion.height;
 if(region.y<.4||region.y>.85||region.y+region.height<.95||region.y+region.height>1||top< -1e-9||bottom< -1e-9||top>.025||bottom>.05||top*geometry.height>12||bottom*geometry.height>24)throw Error('CALIBRATION_UNRELATED_PIXELS_CHANGED');
 return {region,sourceRegion,changedPixels:changes,topPaddingPoints:top*geometry.height,bottomPaddingPoints:bottom*geometry.height,authorization:false,provenance:'same_fixture_before_and_visible_pixel_difference',imageSha256:{before:createHash('sha256').update(readFileSync(beforePath)).digest('hex'),visible:createHash('sha256').update(readFileSync(visiblePath)).digest('hex')}};
}

// Explicit owner approval, separate from the legacy auto-proposal above. The
// caller must first strictly inspect its actual source for the same app/window.
// Digests record that local approval; they are never OS ownership or UI grants.
const invalid=()=>{throw Error('CALIBRATION_GEOMETRY_CONTRACT_INVALID');};
function exact(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));}
function boundedOriginal(file,maxBytes){
 if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))invalid();
 const absolute=path.resolve(file);let current=path.parse(absolute).root;
 for(const part of absolute.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);if(lstatSync(current).isSymbolicLink())invalid();}
 let fd;try{
  fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW|(constants.O_NONBLOCK||0));const before=fstatSync(fd,{bigint:true});
  if(!before.isFile()||before.size<1n||before.size>BigInt(maxBytes))invalid();
  const bytes=Buffer.alloc(Number(before.size)+1);let n=0;
  while(n<bytes.length){const count=readSync(fd,bytes,n,bytes.length-n,null);if(!count)break;n+=count;}
  const after=fstatSync(fd,{bigint:true});
  if(n!==Number(before.size)||['dev','ino','size','mtimeNs','ctimeNs'].some(k=>before[k]!==after[k]))invalid();
  return bytes.subarray(0,n);
 }finally{if(fd!==undefined)closeSync(fd);}
}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function frame(file){
 // Validate CRC/dimensions/inflate and decode the same owned encoded bytes.
 // No pathname reopen can substitute a different representation for validation.
 const decoded=decodeBoundedPngSnapshot(file);
 return {decoded,imageSha256:decoded.imageSha256};
}
function rect(value,width,height){
 if(!exact(value,['x','y','width','height'])||Object.values(value).some(v=>typeof v!=='number'||!Number.isFinite(v))||value.x!==0||value.width!==width||value.y<0||value.height<=0||value.y+value.height>height)invalid();
 return value;
}
export function approvedKeyboardEnvelope(beforePath,visiblePath,{valueRegion,resultRegion,sourceRegion,geometry,approval,visibleSourcePath}){
 if(!exact(geometry,['x','y','width','height'])||geometry.x!==0||geometry.y!==0||!Number.isSafeInteger(geometry.width)||!Number.isSafeInteger(geometry.height)||geometry.width<1||geometry.height<1||geometry.width>16384||geometry.height>16384||!exact(approval,['appId','visualEnvelope'])||typeof approval.appId!=='string'||!(/^[A-Za-z0-9_.-]{1,256}$/).test(approval.appId))invalid();
 if(!exact(sourceRegion,['x','y','width','height']))invalid();
 const width=geometry.width,height=geometry.height;
 const norm=r=>({x:r.x/width,y:r.y/height,width:r.width/width,height:r.height/height});
 const snap=v=>Math.abs(v-Math.round(v))<1e-9?Math.round(v):v;
 const plane=rect({x:sourceRegion.x*width,y:snap(sourceRegion.y*height),width:sourceRegion.width*width,height:snap(sourceRegion.height*height)},width,height);
 if(Object.keys(sourceRegion).some(k=>typeof sourceRegion[k]!=='number'||sourceRegion[k]!==norm(plane)[k]))invalid();
 const shell=rect(approval.visualEnvelope,width,height),region=norm(shell);
 if(region.y<.5||region.y>.85||region.y+region.height<.95||shell.y>plane.y||plane.y>.85*height||plane.y+plane.height>shell.y+shell.height)invalid();
 const a=frame(beforePath),b=frame(visiblePath);
 const image={width:a.decoded.width,height:a.decoded.height};
 if(image.width!==b.decoded.width||image.height!==b.decoded.height)throw Error('CALIBRATION_DIMENSIONS_CHANGED');
 if(image.width*height!==image.height*width)invalid();
 for(const roi of [valueRegion,resultRegion])if(visualRegionsOverlap(region,roi,image))invalid();
 const box=r=>[Math.floor(r.x*image.width),Math.floor(r.y*image.height),Math.ceil((r.x+r.width)*image.width),Math.ceil((r.y+r.height)*image.height)];
 const rois=[valueRegion,resultRegion].map(box),shellBox=box(region),inBox=(x,y,r)=>x>=r[0]&&x<r[2]&&y>=r[1]&&y<r[3];
 let changes=0;
 for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++){
  const i=(y*image.width+x)*4;if(a.decoded.data[i]===b.decoded.data[i]&&a.decoded.data[i+1]===b.decoded.data[i+1]&&a.decoded.data[i+2]===b.decoded.data[i+2]&&a.decoded.data[i+3]===b.decoded.data[i+3])continue;
  if(rois.some(r=>inBox(x,y,r))||!inBox(x,y,shellBox))throw Error('CALIBRATION_UNRELATED_PIXELS_CHANGED');
  changes++;
 }
 if(!changes)throw Error('CALIBRATION_KEYBOARD_UNVERIFIED');
 const source=boundedOriginal(visibleSourcePath,2*1024*1024);
 // Strict XML/identity/Keyboard parsing is the caller's inspect_source step,
 // not a regex reconstruction here. Runtime independently repeats that check.
 new TextDecoder('utf-8',{fatal:true}).decode(source);
 const geometryEvidence={schemaVersion:1,mode:'owner_approved_split',authority:'local_config',appId:approval.appId,window:{width,height},image,keyPlane:plane,visualEnvelope:{...shell},calibration:{kind:'owner_inspected_source_and_frame_pair',beforeImageSha256:a.imageSha256,visibleImageSha256:b.imageSha256,visibleSourceSha256:sha(source)}};
 return {region,sourceRegion:{...sourceRegion},geometryEvidence,changedPixels:changes,authorization:false,provenance:'explicit_local_owner_bounds_with_frame_difference_validation_not_os_ownership'};
}
