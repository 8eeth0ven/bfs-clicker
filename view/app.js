const $=id=>document.getElementById(id);
const limitKeys=['maxStates','maxDepth','maxDurationMs','maxRequests','maxActions','maxStatesPerHost'];
const modes={default:'默认上限',custom:'自定义上限',unlimited:'直到跑完 · 不限预算'};
const statuses={starting:'正在启动',running:'正在探索',stopping:'正在保存',completed:'已跑完',partial:'部分完成',failed:'执行失败',blocked:'目标阻断',needs_auth:'需要登录'};
const reasons={frontier_exhausted:'发现队列已耗尽',max_states:'达到状态数上限',max_depth:'达到深度上限',max_duration:'达到时长上限',max_requests:'达到请求数上限',max_actions:'达到动作数上限',max_states_per_host:'达到单主机状态上限',STOP:'已按要求停止',SIGINT:'进程收到停止信号',SIGTERM:'进程收到停止信号',failed_actions:'存在失败动作，可续跑重试',browser_closed:'浏览器意外关闭',request_guard_failed:'请求守卫异常',worker_interrupted:'运行进程已中断，可续跑',login_shell:'页面需要登录',auth_rule_failed:'会话校验失败',challenge_or_access_denied_shell:'目标要求验证或拒绝访问',unresolved_coverage_errors:'存在未解决的覆盖错误'};
let token='',defaults={},runs=[],selectedId='',activeId='',busy=false,polling=false;
function mode(){return document.querySelector('input[name=limitMode]:checked').value;}
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
function syncMode(){
  const choice=mode();$('limit-fields').disabled=choice!=='custom';
  $('limit-fields').hidden=choice==='unlimited';
  $('budget-note').textContent=choice==='unlimited'?
    '取消状态数、深度、时长、请求数、动作数、单主机状态数上限。持续运行到发现队列耗尽；可随时停止并保存。':
    choice==='custom'?'拖动滑块或输入数字调整全部上限。达到任一上限后保存结果和待探索动作；续跑可提高上限或切换为“直到跑完”。':
    '默认探索 50 个状态、深度 3、5 分钟、1500 次请求、500 次动作，单主机 50 状态。达到任一上限保存进度。';
  if(choice==='default')for(const key of limitKeys)setLimit(key,defaults[key]??Number($(key).value));
}
function setLimit(key,value){
  const n=key==='maxDurationMs'?value/60000:value;
  const range=$(key+'-range');range.max=String(Math.max(Number(range.max),n));range.value=String(n);$(key).value=String(n);
}
function limits(){
  const result={limitMode:mode()};
  if(result.limitMode==='custom'){
    result.limits={};
    for(const key of limitKeys){
      const n=Number($(key).value),min=key==='maxDepth'?0:1;
      if(!Number.isSafeInteger(n)||n<min)throw new Error('请检查 '+$(key).getAttribute('aria-label'));
      result.limits[key]=key==='maxDurationMs'?n*60000:n;
      if(!Number.isSafeInteger(result.limits[key]))throw new Error('运行时长超出可用范围');
    }
  }
  return result;
}
async function api(url,value){
  const response=await fetch(url,{method:value===undefined?'GET':'POST',cache:'no-store',
    headers:value===undefined?{}:{'Content-Type':'application/json','X-BFS-Token':token},
    body:value===undefined?undefined:JSON.stringify(value)});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'操作失败');return data;
}
function duration(ms){const secs=Math.floor(Math.max(0,ms)/1000);return Math.floor(secs/60)+':'+String(secs%60).padStart(2,'0');}
function chosen(){return runs.find(run=>run.id===selectedId);}
function buttons(){
  const run=chosen();$('start').disabled=busy||!!activeId||!token;
  $('resume').disabled=busy||!!activeId||!run?.canResume;
  $('stop').disabled=busy||!run?.active||run.status==='stopping';
}
function render(){
  const run=chosen();buttons();
  $('status').textContent=statuses[run?.status]||'等待开始';$('status').dataset.state=run?.status||'';
  if(!run)return;
  $('current-asset').textContent=run.asset;
  const counts=run.counts||{},budget=run.budgets||{};
  $('states').textContent=Number(counts.states||0).toLocaleString();
  $('requests').textContent=Number(counts.requests||0).toLocaleString();
  $('actions').textContent=Number(counts.actions||0).toLocaleString();
  const elapsed=run.active?(counts.elapsedMs??Date.now()-Date.parse(run.startedAt)):counts.elapsedMs||Date.parse(run.finishedAt)-Date.parse(run.startedAt)||0;
  $('elapsed').textContent=duration(elapsed);
  $('budget-caption').textContent=modes[run.limitMode]||run.limitMode;
  const cap=budget.maxStates,progress=$('state-progress');
  if(cap==null){progress.removeAttribute('value');$('budget-value').textContent=Number(counts.states||0)+' 状态 · 不限';}
  else{progress.max=cap;progress.value=Math.min(counts.states||0,cap);$('budget-value').textContent=(counts.states||0)+' / '+cap+' 状态';}
  $('result-note').textContent=run.active?(run.status==='stopping'?'正在停止并保存进度，请等待任务结束。':'正在按当前预算探索。达到上限会保存进度；“直到跑完”模式持续处理发现队列。'):
    (reasons[run.stopReason]||run.stopReason||'任务结束')+'。待探索动作 '+(run.pending?.actions||0)+'，失败动作 '+(run.pending?.failed||0)+'。';
  $('output-dir').textContent='结果目录：'+run.outputDir;
  $('report-links').hidden=!run.report;
  if(run.report){$('report-link').href=run.report;const prefix='/runs/'+encodeURIComponent(run.id)+'/';$('apis-link').href=prefix+'apis.json';$('pending-link').href=prefix+'unexplored-actions.json';}
  const logs=$('logs'),atBottom=logs.scrollTop+logs.clientHeight>=logs.scrollHeight-15;
  const text=(run.logs||[]).join('\n')||'任务已记录，运行日志将在此显示。';
  if(logs.textContent!==text){logs.textContent=text;if(atBottom)logs.scrollTop=logs.scrollHeight;}
}
function updateRuns(next,id){
  runs=next;
  if(id)selectedId=id;
  if(!runs.some(run=>run.id===selectedId))selectedId=activeId||runs.at(-1)?.id||'';
  const select=$('runs');
  const signature=runs.map(run=>run.id+run.status).join('|');
  if(select.dataset.signature!==signature){
    select.replaceChildren();
    if(!runs.length)select.add(new Option('暂无任务',''));
    for(const run of [...runs].reverse())select.add(new Option((statuses[run.status]||run.status)+' · '+run.asset+' · '+run.id.slice(0,8),run.id));
    select.dataset.signature=signature;
  }
  select.value=selectedId;render();
}
function restoreBudget(run){
  if(!run)return;
  const choice=['default','custom','unlimited'].includes(run.limitMode)?run.limitMode:'default';
  document.querySelector('input[name=limitMode][value='+choice+']').checked=true;
  if(choice==='custom')for(const key of limitKeys)if(run.budgets?.[key]!=null)setLimit(key,run.budgets[key]);
  syncMode();
}
async function poll(){
  if(polling)return;polling=true;
  try{const data=await api('/api/runs');activeId=data.activeId;updateRuns(data.runs);}
  catch(error){message('无法读取本地任务：'+error.message,true);}
  finally{polling=false;}
}
async function execute(fn){
  busy=true;buttons();
  try{await fn();}catch(error){message(error.message,true);}
  finally{busy=false;buttons();}
}
for(const input of document.querySelectorAll('input[name=limitMode]'))input.addEventListener('change',syncMode);
for(const key of limitKeys){
  $(key+'-range').addEventListener('input',event=>{$(key).value=event.target.value;});
  $(key).addEventListener('input',()=>{const n=Number($(key).value);if(Number.isFinite(n)){const range=$(key+'-range');range.max=String(Math.max(Number(range.max),n));range.value=String(n);}});
}
$('runs').addEventListener('change',()=>{selectedId=$('runs').value;restoreBudget(chosen());render();});
$('run-form').addEventListener('submit',event=>{event.preventDefault();execute(async()=>{
  const request={asset:$('asset').value.trim(),...limits(),headless:$('headless').checked,order:$('order').value,
    resourcePolicy:$('resourcePolicy').value,requestDelayMs:Number($('requestDelayMs').value)};
  const data=await api('/api/runs',request);activeId=data.run.id;updateRuns([...runs,data.run],data.run.id);message('任务已启动。');await poll();
});});
$('resume').addEventListener('click',()=>execute(async()=>{
  const data=await api('/api/runs/'+encodeURIComponent(selectedId)+'/resume',limits());activeId=data.run.id;
  updateRuns(runs.map(run=>run.id===data.run.id?data.run:run));message('已按当前预算续跑。');await poll();
}));
$('stop').addEventListener('click',()=>execute(async()=>{
  await api('/api/runs/'+encodeURIComponent(selectedId)+'/stop',{});message('已请求停止，正在保存进度。');await poll();
}));
try{
  const data=await api('/api/bootstrap');token=data.token;defaults=data.defaults;
  activeId=data.runs.find(run=>run.active)?.id||'';updateRuns(data.runs,data.initialRunId);restoreBudget(chosen());syncMode();buttons();
  setInterval(poll,1000);
}catch(error){message('面板初始化失败：'+error.message,true);}
