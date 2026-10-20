// 本地零依赖演示站：覆盖 DFS 冒烟场景
//  首页→模块A→编辑页→保存/取消→成功页；模块B→下拉→详情页；协议弹窗(滚动→勾选→同意)；自循环页
//  npm run demo 时由 index.js 自动拉起，跑完自动杀掉

import { createServer } from 'node:http';

const PORT = 3100;

const page = (title, body, script = '') => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${title}</title><style>
body{font-family:sans-serif;max-width:760px;margin:40px auto;padding:0 20px}
button,a,.btn{display:inline-block;margin:6px 8px 6px 0;padding:8px 16px;font-size:15px;cursor:pointer}
a{text-decoration:none;color:#fff;background:#1a7f37;border-radius:4px}
button{background:#eee;border:1px solid #ccc;border-radius:4px}
h1{font-size:22px}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.5);display:none;align-items:center;justify-content:center;z-index:99}
.modal .box{background:#fff;width:480px;max-height:90vh;border-radius:8px;display:flex;flex-direction:column}
.modal .head{padding:14px 18px;font-weight:bold;border-bottom:1px solid #eee}
.modal .body{padding:14px 18px;overflow:auto;height:220px;line-height:1.8;font-size:13px;color:#444}
.modal .foot{padding:14px 18px;border-top:1px solid #eee;display:flex;justify-content:flex-end;gap:10px}
.banner{background:#e6ffed;border:1px solid #a7e3b4;padding:8px 12px;border-radius:4px;margin:10px 0}
.consent-mask{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:999;display:flex;align-items:center;justify-content:center}
.consent-box{background:#fff;width:560px;max-height:80vh;border-radius:8px;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,.3)}
.consent-box .body{overflow:auto;height:260px;padding:14px 18px;line-height:1.8;font-size:13px;color:#444}
.consent-box .foot{padding:14px 18px;border-top:1px solid #eee;display:flex;justify-content:flex-end;gap:10px;align-items:center}
</style></head><body><h1>${title}</h1>${body}
<script>${script}</script></body></html>`;

// "全部功能"菜单：点击后同一 URL 原地展开面板，露出 12 个产品链接（HOME 基础交互面 ~7 → 展开后 ~19）
// 用于验证"同 URL 展开识别"：URL 与根相同但交互面大幅增多 → 判为菜单展开 → 建展开状态并深入探索
const MENU_ITEMS = Array.from({ length: 12 }, (_, i) => `<a href="/menu/${i + 1}">菜单产品 ${i + 1}</a>`).join('');

const HOME = page('首页', `
<p>演示站首页 —— 每个按钮都会被 DFS 点一遍。</p>
<a href="/level2/a">进入模块A</a>
<a href="/level2/b">进入模块B</a>
<button id="openAgree">阅读协议并同意</button>
<a href="/loop">跳转循环页</a>
<a href="/consent">跳转整页同意书</a>
<button onclick="location.reload()">刷新自身</button>
<button id="allFunc">全部功能</button>
<div id="funcMenu" style="display:none;margin:8px 0 0;padding:12px;border:1px solid #ccc;border-radius:6px">${MENU_ITEMS}</div>
<div id="markBanner" class="banner" style="display:none">★ 带标记的首页：表面有变化，但 URL 与根首页相同 → 应被 URL 去重判为「回到已访问」<button onclick="localStorage.removeItem('mark');location.reload()">清除标记</button></div>
<div id="agreeBanner" class="banner" style="display:none">✔ 已同意协议（本状态与首页是不同的状态）</div>
<div id="agreeModal" class="modal"><div class="box">
  <div class="head">用户服务协议</div>
  <div class="body" id="agreeBody">
    <p>这是一段很长的协议正文。</p>
    <p style="height:1200px">（往下滚动阅读到末尾后才能勾选同意）</p>
    <p>协议末尾。</p>
  </div>
  <div class="foot">
    <label><input type="checkbox" id="agreeChk" disabled> 我已阅读并同意</label>
    <button id="agreeBtn" disabled>同意并继续</button>
    <button id="agreeClose">关闭</button>
  </div>
</div></div>`, `
if(localStorage.getItem('mark')){document.getElementById('markBanner').style.display='block';}
const modal=document.getElementById('agreeModal');
const body=document.getElementById('agreeBody');
const chk=document.getElementById('agreeChk');
const btn=document.getElementById('agreeBtn');
body.addEventListener('scroll',()=>{if(body.scrollTop+body.clientHeight>=body.scrollHeight-5){chk.disabled=false;btn.disabled=false;}});
document.getElementById('openAgree').onclick=()=>{modal.style.display='flex';};
btn.onclick=()=>{if(chk.checked){modal.style.display='none';document.getElementById('openAgree').textContent='协议已同意 ✔（重新阅读）';document.getElementById('agreeBanner').style.display='block';}else{alert('请先勾选已阅读');}};
document.getElementById('agreeClose').onclick=()=>{modal.style.display='none';};
document.getElementById('allFunc').onclick=()=>{const m=document.getElementById('funcMenu');m.style.display=m.style.display==='none'?'block':'none';};
`);

const L2A = page('二级页面 A · 模块列表', `
<p>模块A的二级界面。DFS 会先进「进入编辑页」钻到底，再回来点「返回首页」。</p>
<a href="/level3/edit">进入编辑页</a>
<a href="/" onclick="localStorage.setItem('mark','1')">回首页(带标记)</a>
<a href="/">返回首页</a>`);

const L2B = page('二级页面 B · 下拉选择', `
<p>模块B的二级界面，这里有个下拉框：选中「查看详情」会跳到详情页。</p>
<select id="prod" onchange="if(this.value==='detail') location.href='/level3/detail'">
  <option value="">请选择</option>
  <option value="detail">查看详情</option>
</select>
<a href="/">返回首页</a>`);

const EDIT = page('三级页面 · 编辑表单', `
<p>编辑页。保存→成功页；取消→返回模块A。</p>
<form action="/level3/saved" method="get">
  <label>名称 <input name="name" placeholder="名称"></label>
  <button type="submit">保存</button>
</form>
<a href="/level2/a">取消</a>`);

const SAVED = page('保存成功', `
<p>✔ 保存成功。</p>
<a href="/level2/a">返回模块A</a>`);

const DETAIL = page('详情页', `
<p>详情内容。</p>
<a href="/level2/b">返回模块B</a>`);

const LOOP = page('循环页', `
<p>这个页面的按钮会跳回自己 —— 用来验证 visited 去重不死循环。</p>
<button onclick="location.href='/loop'">再点一次自己</button>
<a href="/">返回首页</a>`);

// 整页"同意书"遮罩场景：其他内容全灰，只有同意书可操作；滚动到底→勾选→同意按钮才解锁
const CONSENT = page('整页同意书', `
<p>这一页的正常内容（本该可点，但现在被同意书遮罩盖住）：</p>
<button onclick="alert('若被点到说明遮罩没拦住')">底下有个按钮(应被遮住)</button>
<a href="/">底下返回首页(应被遮住)</a>
<div id="mask" class="consent-mask"><div class="consent-box">
  <div style="padding:14px 18px;font-weight:bold;border-bottom:1px solid #eee">重要：请先阅读并同意《用户服务协议》</div>
  <div class="body" id="consentBody">
    <p>1. 本服务协议（下称"本协议"）是您与演示站之间关于使用本服务的约定。</p>
    <p>2. 您应仔细阅读本协议的全部内容，特别是免除或者限制责任的条款。</p>
    <p style="height:1400px">3.（很长的一段条款，滚动到底部后才能勾选同意）</p>
    <p>4. 若您不同意本协议任何条款，请停止使用本服务。</p>
  </div>
  <div class="foot">
    <label><input type="checkbox" id="consentChk" disabled> 我已阅读并同意《用户服务协议》</label>
    <button id="consentBtn" disabled>同意并继续</button>
  </div>
</div></div>`, `
const body=document.getElementById('consentBody');
const chk=document.getElementById('consentChk');
const btn=document.getElementById('consentBtn');
body.addEventListener('scroll',()=>{if(body.scrollTop+body.clientHeight>=body.scrollHeight-5)chk.disabled=false;});
chk.addEventListener('change',()=>{btn.disabled=!chk.checked;});
btn.onclick=()=>{if(chk.checked){location.href='/consent/ok';}else{alert('请先勾选已阅读');}};
`);

const CONSENT_OK = page('同意书已同意', `
<p>✔ 已同意整页同意书，进入正常内容。</p>
<a href="/">返回首页</a>`);

const routes = {
  '/': HOME,
  '/level2/a': L2A,
  '/level2/b': L2B,
  '/level3/edit': EDIT,
  '/level3/saved': SAVED,
  '/level3/detail': DETAIL,
  '/loop': LOOP,
  '/consent': CONSENT,
  '/consent/ok': CONSENT_OK,
};
// "全部功能"菜单里展开的产品页
for (let i = 1; i <= 12; i++) {
  routes[`/menu/${i}`] = page(`菜单产品 ${i}`, `<p>从「全部功能」菜单展开进入的产品 ${i}。</p><a href="/">返回首页</a>`);
}

createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  const html = routes[url];
  if (html) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}).listen(PORT, () => console.log(`demo listening on ${PORT}`));
