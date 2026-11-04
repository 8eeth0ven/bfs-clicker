// Reports contain escaped, redacted text; no active script or remote resources.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stepLabel, actionKey } from './discover.js';
import { redact, escapeHtml as esc, REPORT_CSP } from './redact.js';
export function writeReport({allStates,visitedHits=0,config,elapsedMs=0,log=()=>{},backEdges=[],skipHits=new Map(),outOfScope={count:0,samples:[]},run=null,apis=[],graph=null}) {
  mkdirSync(config.outputDir,{recursive:true});
  const states=[...allStates.values()];
  const stateView=state=>{
    const processed=state.processed instanceof Set?state.processed:new Set(state.processed||[]);
    return {...state,pathLabels:(state.path||[]).map(stepLabel),clickables:(state.interactives||[]).map(el=>{
      const status=el.status||(el.skipped?'skipped':(state.failed||[]).some(f=>f.selector===el.selector)?'failed':processed.has(el.selector)||processed.has(actionKey(el))?'succeeded':'planned');
      return {...el,status};
    }),tab:undefined,dialogs:undefined,processed:[...processed]};
  };
  const views=states.map(stateView),map=new Map(views.map(v=>[v.id,v]));
  const node=(id,seen=new Set())=>{if(seen.has(id))return null;const st=map.get(id);if(!st)return null;const next=new Set([...seen,id]);return {...st,children:(st.children||[]).map(c=>node(c,next)).filter(Boolean)};};
  const pending=views.reduce((n,s)=>n+s.clickables.filter(a=>['planned','running'].includes(a.status)).length,0);
  const failed=views.reduce((n,s)=>n+s.clickables.filter(a=>a.status==='failed').length,0);
  const resolvedRun=run||{status:pending||failed?'partial':'completed',stopReason:pending?'pending_actions':failed?'failed_actions':'frontier_exhausted',pending:{actions:pending,failed},coverageGaps:[]};
  const report=redact({generatedAt:new Date().toISOString(),startUrl:config.startUrl,elapsedMs,totalStates:states.length,visitedHits,maxDepth:config.maxDepth,backEdges,run:resolvedRun,graph:graph?{schemaVersion:graph.schemaVersion,nodes:graph.nodes.length,edges:graph.edges.length,path:'graph.html'}:null,tree:node(1)});
  writeFileSync(path.join(config.outputDir,'tree.json'),JSON.stringify(report,null,2));
  writeFileSync(path.join(config.outputDir,'routes.json'),JSON.stringify(redact(views.map(s=>({id:s.id,depth:s.depth,url:s.url,title:s.title,path:s.pathLabels,evidenceId:s.evidenceId}))),null,2));
  const unexplored=views.flatMap(s=>s.clickables.filter(a=>a.status!=='succeeded').map(a=>({stateId:s.id,url:s.url,label:a.label,status:a.status,reason:a.reason||a.skipReason||'pending',evidenceId:a.evidenceId||null})));
  writeFileSync(path.join(config.outputDir,'unexplored-actions.json'),JSON.stringify(redact(unexplored),null,2));
  const counts={};for(const s of states){try{const host=new URL(s.url).host;counts[host]=(counts[host]||0)+1}catch{}}
  const manifest=redact({runId:config.runId||config.sessionId,generatedAt:report.generatedAt,startUrl:config.startUrl,totalStates:states.length,crawledHosts:counts,status:resolvedRun.status,stopReason:resolvedRun.stopReason,pending:resolvedRun.pending,elapsedMs,skip:{byPattern:Object.fromEntries(skipHits)},outOfScope});
  writeFileSync(path.join(config.outputDir,'manifest.json'),JSON.stringify(manifest,null,2));
  const statusLabel={planned:'待探索',running:'执行中',succeeded:'已成功触发',skipped:'跳过',failed:'失败'};
  const shotFormat=String(process.env.BFS_SHOT_FORMAT||config.shotFormat||'png');
  const shotExt=['jpeg','jpg'].includes(shotFormat)?'jpg':shotFormat==='none'?null:'png';
  const render=st=>{
    if(!st)return '';
    const rows=st.clickables.map(a=>'<tr><td>'+esc(a.label||a.selector)+'</td><td>'+esc(a.kind||a.type)+'</td><td>'+esc(statusLabel[a.status]||a.status)+'</td><td>'+esc(a.reason||a.skipReason||'')+'</td></tr>').join('');
    const shot=shotExt?'states/'+String(Number(st.id)).padStart(3,'0')+'.'+shotExt:null;
    return '<li><details open><summary>#'+Number(st.id)+' · d'+Number(st.depth)+' '+esc(st.title||st.url)+'</summary><p class="url">'+esc(st.url)+'</p><p>路径: '+(st.pathLabels.map(esc).join(' › ')||'（根）')+'</p>'+(shot?'<img loading="lazy" alt="状态截图" src="'+shot+'">':'')+'<table><tr><th>控件</th><th>动作</th><th>状态</th><th>原因</th></tr>'+rows+'</table><ul>'+(st.children||[]).map(render).join('')+'</ul></details></li>';
  };
  const gapHtml=(resolvedRun.coverageGaps||[]).map(g=>'<li>'+esc(typeof g==='string'?g:g.reason)+'</li>').join('');
  const html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="'+esc(REPORT_CSP)+'"><title>bfs-clicker · '+esc(report.startUrl)+'</title><style>body{font:14px/1.6 system-ui;max-width:1200px;margin:24px auto;padding:0 20px;background:#f8fafc;color:#172033}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #cbd5e1;padding:5px;text-align:left;overflow-wrap:anywhere}summary{cursor:pointer;font-weight:600}.url{overflow-wrap:anywhere;color:#475569}img{max-width:480px;max-height:280px}li{margin:8px 0}</style></head><body><h1>Web 资产探索结果</h1><p class="url">'+esc(report.startUrl)+'</p><p>状态: <b>'+esc(resolvedRun.status)+'</b> · 原因: '+esc(resolvedRun.stopReason)+' · '+states.length+' 个状态 · 剩余动作 '+pending+' · 失败 '+failed+' · '+(elapsedMs/1000).toFixed(1)+' 秒</p><p>完成仅指当前策略和预算下的任务结论。接口发现不能作为漏洞或全站安全结论。</p><p>'+(graph?'<a href="graph.html">流程与调用图</a> · ':'')+'<a href="apis.json">API 清单</a> · <a href="requests.json">请求证据</a> · <a href="unexplored-actions.json">未探索动作</a></p><h2>覆盖缺口</h2><ul>'+gapHtml+'</ul><h2>状态与动作</h2><ul>'+render(report.tree)+'</ul></body></html>';
  for(const name of ['overview.html','report.html'])writeFileSync(path.join(config.outputDir,name),html);
  const md=['# Web 资产探索结果','','资产: '+redact(config.startUrl),'','状态: '+resolvedRun.status,'停止原因: '+resolvedRun.stopReason,'状态数: '+states.length,...(graph?['','[流程与调用图](graph.html) · [图数据](graph.json) · [DOT](graph.dot)']:[]),'待探索: '+pending,'失败: '+failed,'','## 覆盖缺口','',...(resolvedRun.coverageGaps||[]).map(g=>'- '+redact(typeof g==='string'?g:g.reason)),'','## 路由','',...views.map(s=>'- '+redact(s.url)+' ('+redact(s.title)+')')].join('\n');
  writeFileSync(path.join(config.outputDir,'report.md'),md);
  log('[报告] '+path.join(config.outputDir,'report.html')+' · '+resolvedRun.status+' / '+resolvedRun.stopReason);
  return report;
}
