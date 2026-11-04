import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { makeDialogs } from '../src/dialogs.js';
import { clickElement } from '../src/replay.js';
let server,browser,base;
before(async()=>{
  const html=readFileSync(new URL('./fixtures/dialogs.html',import.meta.url));
  server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(req.url==='/child'?'<div id="child-content"></div>':html);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server?.close(resolve));});
async function fixture(fn){
  const page=await browser.newPage(),dialogs=makeDialogs(page,{});
  try{await page.goto(base);await dialogs.stabilize();await fn(page,dialogs);}finally{dialogs.dispose();await page.close();}
}

test('real DOM: 120ms delayed click preserves link and unchanged generation returns promptly',async()=>fixture(async(page,dialogs)=>{
  const start=performance.now();
  await clickElement(page,dialogs,{selector:'#delayed',label:'View delayed link',type:'click'},{actionTimeoutMs:1000});
  assert.equal(await page.locator('#late-link').count(),1);assert.ok(performance.now()-start>=240);
  const cachedStart=performance.now(),result=await dialogs.stabilize();assert.equal(result.cached,true);assert.ok(performance.now()-cachedStart<120);
}));

test('real DOM: existing open shadow root invalidates a cached generation',async()=>fixture(async(page,dialogs)=>{
  await page.evaluate(()=>{document.querySelector('#shadow-host').shadowRoot.querySelector('#shadow-content').textContent='Shadow changed';});
  const result=await dialogs.stabilize();assert.equal(result.cached,false);assert.equal(result.stable,true);
  assert.equal(await page.locator('#shadow-content').innerText(),'Shadow changed');
}));

test('real DOM: newly added nested shadow roots remain observed',async()=>fixture(async(page,dialogs)=>{
  await page.evaluate(()=>{
    const host=document.createElement('div');host.id='dynamic-host';document.querySelector('#new-hosts').append(host);
    host.attachShadow({mode:'open'}).innerHTML='<div id="dynamic-content"></div>';
  });
  await dialogs.stabilize();
  await page.evaluate(()=>{document.querySelector('#dynamic-host').shadowRoot.querySelector('#dynamic-content').textContent='Dynamic changed';});
  const result=await dialogs.stabilize();assert.equal(result.cached,false);assert.equal(result.stable,true);
}));

test('real DOM: same-origin iframe mutation invalidates the parent stability cache',async()=>fixture(async(page,dialogs)=>{
  const child=page.frames().find(frame=>frame.url().endsWith('/child'));
  await child.evaluate(()=>{document.querySelector('#child-content').textContent='Frame changed';});
  const result=await dialogs.stabilize();assert.equal(result.cached,false);assert.equal(result.stable,true);
}));

test('real DOM: noise mutations do not keep a page waiting until the deadline',async()=>fixture(async(page,dialogs)=>{
  await page.evaluate(()=>{let n=0;window.noiseTimer=setInterval(()=>document.querySelector('#noise').textContent=String(++n),10);});
  dialogs.invalidate();const start=performance.now(),result=await dialogs.stabilize();
  assert.equal(result.stable,true);assert.ok(performance.now()-start<800);
  await page.evaluate(()=>clearInterval(window.noiseTimer));
}));

test('real DOM: cached timeout is invalidated by a later mutation',async()=>{
  const page=await browser.newPage(),dialogs=makeDialogs(page,{stabilize:{quietMs:80,settleMs:80,timeoutMs:50}});
  try{
    await page.goto(base);assert.equal((await dialogs.stabilize()).timedOut,true);assert.equal((await dialogs.stabilize()).cached,true);
    await page.evaluate(()=>document.querySelector('#result').textContent='Late after timeout');
    assert.equal((await dialogs.stabilize()).cached,false);
  }finally{dialogs.dispose();await page.close();}
});
