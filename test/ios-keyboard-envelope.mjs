// Test-owner calibration proposal from two real frames; never an MCP grant.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {visualPixelFingerprint} from '../src/visual-pixels.js';
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
