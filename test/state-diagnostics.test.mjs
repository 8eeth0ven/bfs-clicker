import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fingerprint,summarizeFingerprintSurfaces,normalizeFingerprintDiagnostics} from '../src/state.js';

const sample=()=>({url:'https://example.test/path?token=SECRET_URL',title:'SECRET_TITLE',lines:['SECRET_CONTROL'],headings:['SECRET_HEADING'],body:['SECRET_BODY','中文']});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function pageFor(surfaces) {
  const frames=surfaces.map(surface=>({url:()=>surface.url,evaluate:async()=>structuredClone(surface)}));
  return {frames:()=>frames,url:()=>surfaces[0].url,title:async()=>surfaces[0].title};
}

test('fingerprint retains original MD5 algorithm and returns bounded content-free component hashes',async()=>{
  const surfaces=[sample(),{...sample(),url:'https://example.test/second'}, {...sample(),url:'https://example.test/third'}];
  const state=await fingerprint(pageFor(surfaces),{maxFrames:2});
  assert.equal(state.fp,createHash('md5').update(JSON.stringify(surfaces.slice(0,2))).digest('hex'));
  assert.deepEqual(state.surface,surfaces.slice(0,2));
  assert.deepEqual(state.diagnostics,summarizeFingerprintSurfaces(state.surface));
  assert.equal(state.diagnostics.version,1);assert.equal(state.diagnostics.totalFrameCount,2);assert.equal(state.diagnostics.truncated,false);assert.equal(state.diagnostics.frameCount,2);assert.equal(state.diagnostics.frames.length,2);
  const summary=state.diagnostics.frames[0];
  for(const key of ['url','title','lines','headings','body']){
    assert.equal(summary[key].sha256,hash(surfaces[0][key]));
    assert.equal(summary[key].lengthBytes,Buffer.byteLength(JSON.stringify(surfaces[0][key])));
    assert.match(summary[key].sha256,/^[a-f0-9]{64}$/);
    if(Array.isArray(surfaces[0][key]))assert.equal(summary[key].count,surfaces[0][key].length);
  }
  for(const secret of ['SECRET_URL','SECRET_TITLE','SECRET_CONTROL','SECRET_HEADING','SECRET_BODY','中文','example.test'])assert(!JSON.stringify(state.diagnostics).includes(secret));
});

test('each component changes only its own summary',()=>{
  const original=sample(),baseline=summarizeFingerprintSurfaces([original]);
  for(const key of ['url','title','lines','headings','body']){
    const changed=structuredClone(original);if(Array.isArray(changed[key]))changed[key][0]+=' changed';else changed[key]+=' changed';
    const next=summarizeFingerprintSurfaces([changed]);
    for(const name of ['url','title','lines','headings','body']) {
      if(name===key)assert.notEqual(next.frames[0][name].sha256,baseline.frames[0][name].sha256);
      else assert.deepEqual(next.frames[0][name],baseline.frames[0][name]);
    }
  }
});

test('diagnostic frame count follows maxFrames and the existing frame policy',async()=>{
  const surfaces=[sample(),{...sample(),url:'https://blocked.test/secret'},{...sample(),url:'https://example.test/allowed'},{...sample(),url:'https://example.test/over-budget'}];
  const state=await fingerprint(pageFor(surfaces),{maxFrames:3,_policy:{navigation:url=>({allow:!url.includes('blocked.test')})}});
  assert.equal(state.diagnostics.frameCount,2);assert.equal(state.diagnostics.frames.length,2);
  assert.equal(state.fp,createHash('md5').update(JSON.stringify([surfaces[0],surfaces[2]])).digest('hex'));
  assert.deepEqual(state.diagnostics,summarizeFingerprintSurfaces([surfaces[0],surfaces[2]]));
});


test('untrusted diagnostics must match the bounded schema and return an independent clone',()=>{
  const good=summarizeFingerprintSurfaces([sample()]);const clean=normalizeFingerprintDiagnostics(good);
  assert.deepEqual(clean,good);assert.notEqual(clean,good);assert.notEqual(clean.frames[0].body,good.frames[0].body);
  const cases=[null,{}, {...good,secret:'SECRET_INJECTED'}, {...good,version:2}, {...good,frameCount:2},
    {...good,totalFrameCount:13,frameCount:13,frames:Array(13).fill(good.frames[0])},
    {...good,totalFrameCount:13,truncated:false}, {...good,totalFrameCount:1,truncated:true},
    {...good,frames:[{...good.frames[0],secret:'SECRET_INJECTED'}]},
    {...good,frames:[{...good.frames[0],url:{...good.frames[0].url,raw:'SECRET_INJECTED'}}]},
    {...good,frames:[{...good.frames[0],title:{...good.frames[0].title,sha256:'SECRET_INJECTED'}}]},
    {...good,frames:[{...good.frames[0],body:{...good.frames[0].body,count:1000001}}]},
    {...good,frames:[{...good.frames[0],lines:{...good.frames[0].lines,lengthBytes:2147483648}}]},
    {...good,frames:[{...good.frames[0],url:{...good.frames[0].url,count:0}}]},
    {...good,frames:[{...good.frames[0],body:{...good.frames[0].body,count:-1}}]},
    new Proxy({}, {ownKeys(){throw Error('malicious getter')}})];
  for(const value of cases)assert.equal(normalizeFingerprintDiagnostics(value),null);
  const bounded=summarizeFingerprintSurfaces(Array(13).fill(sample()));
  assert.equal(bounded.totalFrameCount,13);assert.equal(bounded.frameCount,12);assert.equal(bounded.frames.length,12);assert.equal(bounded.truncated,true);
  assert.deepEqual(normalizeFingerprintDiagnostics(bounded),bounded);
});

test('real browser stable state matches, then body or control changes are distinguishable',async()=>{
  const {chromium}=await import('playwright');const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();await page.setContent('<h1>Page</h1><button id="button">Run</button><span id="body">one</span>');
    const first=await fingerprint(page),stable=await fingerprint(page);
    assert.equal(first.fp,stable.fp);assert.deepEqual(first.diagnostics,stable.diagnostics);
    await page.locator('#body').evaluate(el=>{el.textContent='two'});
    const bodyChanged=await fingerprint(page);assert.notEqual(first.fp,bodyChanged.fp);
    assert.notEqual(first.diagnostics.frames[0].body.sha256,bodyChanged.diagnostics.frames[0].body.sha256);
    assert.deepEqual(first.diagnostics.frames[0].lines,bodyChanged.diagnostics.frames[0].lines);
    await page.locator('#button').evaluate(el=>{el.textContent='Stop'});
    const controlChanged=await fingerprint(page);
    assert.notEqual(bodyChanged.fp,controlChanged.fp);
    assert.notEqual(bodyChanged.diagnostics.frames[0].lines.sha256,controlChanged.diagnostics.frames[0].lines.sha256);
    assert.deepEqual(bodyChanged.diagnostics.frames[0].headings,controlChanged.diagnostics.frames[0].headings);
  } finally {await browser.close()}
});


test('more than 12 frames still affect fingerprint while diagnostics declare truncation',async()=>{
  const surfaces=Array.from({length:14},(_,i)=>({...sample(),url:`https://example.test/frame${i}`}));
  const first=await fingerprint(pageFor(surfaces),{maxFrames:14});
  assert.equal(first.fp,createHash('md5').update(JSON.stringify(surfaces)).digest('hex'));
  assert.equal(first.diagnostics.totalFrameCount,14);assert.equal(first.diagnostics.frameCount,12);assert.equal(first.diagnostics.truncated,true);
  const changed=structuredClone(surfaces);changed[13].body=['last frame changed'];
  const next=await fingerprint(pageFor(changed),{maxFrames:14});
  assert.notEqual(first.fp,next.fp);assert.deepEqual(first.diagnostics,next.diagnostics);
});
