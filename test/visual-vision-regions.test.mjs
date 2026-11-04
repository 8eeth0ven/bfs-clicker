import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {observeImage} from '../src/visual-observation.js';
import {temp,root} from './helpers.mjs';

test('regional pixel stabilization corrects measured numerical drift without absorbing real extensions',{skip:process.platform!=='darwin',timeout:60000},async t=>{
 const dir=await realpath(temp(t)),source=await readFile(path.join(root,'scripts/visual-vision.swift'),'utf8');
 const productionFunction=source.match(/func stableRegionalPixel\(_ value:Double\) -> Double \{[^}]+\}/)?.[0];assert(productionFunction);
 const cases=[
  [269.99999960000002,270,270,270],[270.0000004,270,270,270],
  [-269.9999996,-270,-270,-270],[-270.0000004,-270,-270,-270],
  [.0000004,0,0,0],[-.0000004,-0,-0,-0],
  [270-.000000999,270,270,270],[270+.000000999,270,270,270],
  [270-.000001001,270-.000001001,269,270],[270+.000001001,270+.000001001,270,271],
  [269,269,269,269],[271,271,271,271],[-271,-271,-271,-271]
 ];
 const fixture=path.join(dir,'pixel.swift'),exe=path.join(dir,'pixel');
 await writeFile(fixture,`import Foundation\n${productionFunction}\nlet values:[Double]=${JSON.stringify(cases.map(row=>row[0]))}\nlet output=values.map { value -> [Double] in let stable=stableRegionalPixel(value);return [stable,floor(stable),ceil(stable)] }\nprint(String(data:try! JSONSerialization.data(withJSONObject:output),encoding:.utf8)!)\n`);
 execFileSync('/usr/bin/xcrun',['swiftc',fixture,'-o',exe],{timeout:30000});
 const actual=JSON.parse(execFileSync(exe,[],{encoding:'utf8',timeout:10000}));assert.deepEqual(actual,cases.map(row=>row.slice(1)));
});

test('real Vision ROI maps a known source image back into original image pixels',{skip:process.platform!=='darwin',timeout:60000},async t=>{
 const dir=await realpath(temp(t)),fixture=path.join(dir,'draw.swift'),draw=path.join(dir,'draw'),engine=path.join(dir,'vision'),imagePath=path.join(dir,'known.png');
 await writeFile(fixture,`import Foundation\nimport CoreGraphics\nimport CoreText\nimport ImageIO\nlet c=CGContext(data:nil,width:900,height:500,bitsPerComponent:8,bytesPerRow:3600,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!\nc.setFillColor(CGColor(gray:1,alpha:1));c.fill(CGRect(x:0,y:0,width:900,height:500))\nlet font=CTFontCreateWithName("Helvetica-Bold" as CFString,64,nil)\nfor (text,x,y) in [("OUTSIDE",50.0,430.0),("REGIONXYZ",420.0,290.0)] { let a=NSAttributedString(string:text,attributes:[NSAttributedString.Key(kCTFontAttributeName as String):font,NSAttributedString.Key(kCTForegroundColorAttributeName as String):CGColor(gray:0,alpha:1)]);c.textPosition=CGPoint(x:x,y:y);CTLineDraw(CTLineCreateWithAttributedString(a),c) }\nlet d=CGImageDestinationCreateWithURL(URL(fileURLWithPath:CommandLine.arguments[1]) as CFURL,"public.png" as CFString,1,nil)!;CGImageDestinationAddImage(d,c.makeImage()!,nil);if !CGImageDestinationFinalize(d){exit(1)}\n`);
 execFileSync('/usr/bin/xcrun',['swiftc',fixture,'-o',draw],{timeout:30000});execFileSync(draw,[imagePath]);execFileSync('/usr/bin/xcrun',['swiftc',path.join(root,'scripts/visual-vision.swift'),'-o',engine],{timeout:30000});
 const before=createHash('sha256').update(await readFile(imagePath)).digest('hex'),region={x:350/900,y:100/500,width:500/900,height:200/500};
 const result=await observeImage({imagePath,outputDir:path.join(dir,'ocr'),engine:{type:'vision',executable:engine,regions:[region]},language:'eng',timeoutMs:20000});
 assert.equal(result.width,900);assert.equal(result.height,500);assert.equal(result.imageSha256,before);assert.equal(createHash('sha256').update(await readFile(imagePath)).digest('hex'),before);
 const target=result.tokens.find(token=>token.text==='REGIONXYZ'&&token.ocrSource==='region');assert(target,JSON.stringify(result));
 assert(target.bounds.x>=400&&target.bounds.x+target.bounds.width<=850);assert(target.bounds.y>=140&&target.bounds.y+target.bounds.height<=250);
 assert(result.tokens.some(token=>token.text==='OUTSIDE'&&token.ocrSource==='full_image'));
 const artifact=JSON.parse(await readFile(result.artifactPath));assert.equal(artifact.regionalEvidence.regions.length,1);assert.deepEqual(artifact.regionalEvidence.regions[0].normalized,region);
});
