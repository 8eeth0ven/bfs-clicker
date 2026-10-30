// Hash decoded screenshot pixels while explicitly excluding dynamic regions.
import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,readSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {inflateSync} from 'node:zlib';
import {PNG} from 'pngjs';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const signature=Buffer.from([137,80,78,71,13,10,26,10]);
const crcTable=Uint32Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes){let value=0xffffffff;for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8);return (value^0xffffffff)>>>0;}
function regions(masks,width,height){
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>16384||height>16384||width*height>16000000||!Array.isArray(masks)||masks.length>64)fail('VISUAL_PIXELS_INVALID','Invalid dimensions or mask budget');
 return masks.map(mask=>{if(!mask||typeof mask!=='object'||Array.isArray(mask)||Object.keys(mask).some(k=>!['x','y','width','height'].includes(k))||['x','y','width','height'].some(k=>typeof mask[k]!=='number'||!Number.isFinite(mask[k]))||mask.x<0||mask.y<0||mask.width<=0||mask.height<=0||mask.x+mask.width>1||mask.y+mask.height>1)fail('VISUAL_PIXELS_INVALID','Invalid normalized mask');return {x0:Math.floor(mask.x*width),y0:Math.floor(mask.y*height),x1:Math.ceil((mask.x+mask.width)*width),y1:Math.ceil((mask.y+mask.height)*height)};});
}
export function visualRegionsOverlap(a,b,dimensions={}){
 if(!dimensions||typeof dimensions!=='object'||Array.isArray(dimensions))fail('VISUAL_PIXELS_INVALID','Invalid dimensions');
 const [first,second]=regions([a,b],dimensions.width,dimensions.height);
 return first.x0<second.x1&&first.x1>second.x0&&first.y0<second.y1&&first.y1>second.y0;
}
export function visualPointMasked(point,dimensions={},masks=[]){
 if(!dimensions||typeof dimensions!=='object'||Array.isArray(dimensions))fail('VISUAL_PIXELS_INVALID','Invalid dimensions');const {width,height}=dimensions;const boxes=regions(masks,width,height);
 if(!point||typeof point!=='object'||Array.isArray(point)||Object.keys(point).some(k=>!['x','y'].includes(k))||['x','y'].some(k=>typeof point[k]!=='number'||!Number.isFinite(point[k])||point[k]<0||point[k]>=1))fail('VISUAL_PIXELS_INVALID','Invalid normalized point');
 const x=Math.floor(point.x*width),y=Math.floor(point.y*height);return boxes.some(box=>x>=box.x0&&x<box.x1&&y>=box.y0&&y<box.y1);
}
function inputFile(file){
 if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))fail('VISUAL_PIXELS_INVALID','Absolute PNG path required');
 const absolute=path.resolve(file);let current=path.parse(absolute).root;for(const part of absolute.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);let entry;try{entry=lstatSync(current);}catch{fail('VISUAL_PIXELS_INVALID','PNG unavailable');}if(entry.isSymbolicLink())fail('VISUAL_PIXELS_INVALID','Symlink paths are not permitted');}
 let fd;try{fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);const info=fstatSync(fd);if(!info.isFile()||info.size<45||info.size>16*1024*1024)fail('VISUAL_PIXELS_INVALID','PNG must be a bounded regular file');const bytes=Buffer.alloc(info.size+1);let n=0;while(n<bytes.length){const read=readSync(fd,bytes,n,bytes.length-n,null);if(!read)break;n+=read;}if(n!==info.size)fail('VISUAL_PIXELS_INVALID','PNG changed while reading');return bytes.subarray(0,n);}catch(error){if(error.code==='VISUAL_PIXELS_INVALID')throw error;fail('VISUAL_PIXELS_INVALID','PNG cannot be read');}finally{if(fd!==undefined)closeSync(fd);}
}
export function visualPixelFingerprint(imagePath,options={}){
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='masks'))fail('VISUAL_PIXELS_INVALID','Invalid fingerprint options');const {masks=[]}=options;
 const data=inputFile(imagePath);if(!data.subarray(0,8).equals(signature))fail('VISUAL_PIXELS_INVALID','PNG signature required');
 let offset=8,width,height,depth,colorType,seenHeader=false,seenEnd=false,seenData=false,afterData=false;const imageData=[];
 while(offset<data.length){if(offset+12>data.length)fail('VISUAL_PIXELS_INVALID','Truncated PNG chunk');const length=data.readUInt32BE(offset),end=offset+12+length;if(end>data.length)fail('VISUAL_PIXELS_INVALID','Truncated PNG payload');const typeBytes=data.subarray(offset+4,offset+8),type=typeBytes.toString('ascii');if(!typeBytes.every(byte=>(byte>=65&&byte<=90)||(byte>=97&&byte<=122))||(typeBytes[2]&32)!==0||crc32(data.subarray(offset+4,offset+8+length))!==data.readUInt32BE(offset+8+length))fail('VISUAL_PIXELS_INVALID','PNG chunk or CRC invalid');
  if(!seenHeader){if(type!=='IHDR'||length!==13)fail('VISUAL_PIXELS_INVALID','PNG IHDR missing');width=data.readUInt32BE(offset+8);height=data.readUInt32BE(offset+12);depth=data[offset+16];colorType=data[offset+17];regions(masks,width,height);if(data[offset+20]!==0)fail('VISUAL_PIXELS_INVALID','Interlaced PNG is not supported');seenHeader=true;}
  else if(type==='IHDR')fail('VISUAL_PIXELS_INVALID','Duplicate PNG IHDR');
  if(type==='IDAT'){if(afterData)fail('VISUAL_PIXELS_INVALID','PNG IDAT must be contiguous');seenData=true;imageData.push(data.subarray(offset+8,offset+8+length));}else if(seenData&&type!=='IEND')afterData=true;
  if(type==='IEND'){if(length!==0||!seenData||end!==data.length)fail('VISUAL_PIXELS_INVALID','Invalid PNG IEND');seenEnd=true;break;}offset=end;
 }
 if(!seenHeader||!seenEnd)fail('VISUAL_PIXELS_INVALID','Incomplete PNG');
 const channels=({0:1,2:3,3:1,4:2,6:4})[colorType],validDepths=({0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]})[colorType];if(!channels||!validDepths.includes(depth))fail('VISUAL_PIXELS_INVALID','Invalid PNG color format');
 const expectedBytes=(Math.ceil(width*channels*depth/8)+1)*height;try{const compressed=Buffer.concat(imageData),result=inflateSync(compressed,{maxOutputLength:expectedBytes+1,info:true});if(result.buffer.length!==expectedBytes||result.engine.bytesWritten!==compressed.length)fail('VISUAL_PIXELS_INVALID','Invalid PNG compressed stream');}catch(error){if(error.code==='VISUAL_PIXELS_INVALID')throw error;fail('VISUAL_PIXELS_INVALID','Invalid PNG compressed stream');}
 let decoded;try{decoded=PNG.sync.read(data,{checkCRC:true});}catch{fail('VISUAL_PIXELS_INVALID','PNG decoding failed');}
 if(decoded.width!==width||decoded.height!==height||decoded.data.length!==width*height*4)fail('VISUAL_PIXELS_INVALID','Decoded dimensions differ');
 for(const box of regions(masks,width,height))for(let y=box.y0;y<box.y1;y++)decoded.data.fill(0,(y*width+box.x0)*4,(y*width+box.x1)*4);
 const header=Buffer.alloc(8);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);
 return {width,height,sha256:createHash('sha256').update(header).update(decoded.data).digest('hex')};
}
