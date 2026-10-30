/* Local, dependency-free graph viewer. Target content is always rendered as text. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const NODE_LIMIT = 120, EDGE_LIMIT = 260, FILE_LIMIT = 32 * 1024 * 1024;
  const TYPES = new Set(['state', 'action', 'api', 'route', 'script']);
  const TYPE_LABEL = { state: '页面状态', action: '用户操作', api: '接口', route: '候选地址', script: '脚本' };
  const STATUS = { succeeded: '已执行', success: '已执行', completed: '队列已完成', observed: '已观察', discovered: '已发现', failed: '失败', blocked: '被拦截', skipped: '已跳过', planned: '待探索', pending: '待探索', running: '进行中', partial: '部分完成', needs_auth: '需要登录', candidate: '候选', static: '候选', recorded: '已记录', known: '已记录', request_source: '已记录', expanded: '已展开', executed_context: '函数已记录' };
  const MODE_LABEL = { flow: '页面流程', calls: '接口调用', all: '全部关系' };
  const GAP_LABEL = { closed_shadow_roots_unsupported: '部分封闭组件中的操作无法读取', websocket_webrtc_shared_workers_unsupported: '实时连接和部分后台任务未纳入探索', no_interactive_surface: '未发现可操作控件', max_frames: '页面嵌套层数达到采样上限', max_interactives: '控件采样达到上限', replay_state_changed: '重放时页面状态发生变化', unsafe_replay_requires_manual_state: '这条路径需要人工恢复状态', seed_http_error: '候选入口返回错误', seed_navigation_failed: '候选入口未能打开', evidence_drain_timeout: '部分响应未能在收尾前完成记录', unknown_length_not_buffered: '部分响应只保留元信息', missing_edge_endpoint: '一条关系的端点缺失', missing_state: '关联页面状态缺失', incomplete_flow: '部分路径记录不完整', scope_boundary: '部分请求被探索范围限制阻断', graph_flow_parent_missing: '到达路径的上游页面记录缺失', graph_flow_parent_cycle: '到达路径中存在循环记录', graph_flow_steps_truncated: '到达路径超过记录上限' };
  const model = { graph: null, nodes: [], byId: new Map(), edges: [], incoming: new Map(), outgoing: new Map(), mode: 'flow', query: '', selected: null, focus: null, page: 0, visible: [], positions: new Map(), view: { x: 34, y: 46, scale: .85 }, bounds: { width: 500, height: 350 }, dangling: 0 };
  Object.assign(model,{stateById:new Map(),flowByState:new Map(),flowDepth:new Map(),searchText:new Map(),strictPrevious:new Map(),displayOrder:[],entry:null,filterCache:new Map(),frameCache:new Map(),nodeElements:new Map(),edgeElements:new Map(),visibleEdges:[]});
  let searchTimer, drag = null, moved = false;

  function text(value, limit = 4000) {
    return String(value ?? '').slice(0, limit)
      .replace(/\b(https?:\/\/)[^\/\s@]+@/gi, '$1[已隐藏]@')
      .replace(/\b(cookie|authorization)\s*:\s*[^\r\n]+/gi, '$1: [已隐藏]')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.~-]+/gi, '$1 [已隐藏]')
      .replace(/((?:token|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|secret|authorization|api[_-]?key|session[_-]?(?:id|token)|cookie)\s*[=:]\s*)[^\s&,;<>"']+/gi, '$1[已隐藏]');
  }
  function displayUrl(value) {
    const raw = String(value ?? '');
    if (!raw) return '';
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol)) return text(raw);
      url.username = ''; url.password = '';
      for (const name of [...url.searchParams.keys()]) if (/token|secret|passw|auth|api.?key|session|cookie|signature|credential/i.test(name)) url.searchParams.set(name, '[已隐藏]');
      url.hash = text(url.hash);
      return text(url.href);
    } catch { return text(raw); }
  }
  const inactive = node => ['skipped','failed','blocked'].includes(node.status)||(node.type!=='state'&&['planned','pending','running'].includes(node.status));
  const candidate = node => !(node.type === 'script' && node.executionObserved === true) && (node.confidence === 'static' || node.observed === false || ['candidate', 'static'].includes(node.status) || (node.type === 'route' && node.observed !== true));
  const typeLabel = node => node.type === 'route' && !candidate(node) ? (node.background || node.status === 'request_source' ? '请求来源' : '已访问地址') : TYPE_LABEL[node.type];
  const statusLabel=node=>node.type==='state'&&node.status==='pending'?'还有待办':STATUS[node.status]||(candidate(node)?'候选':'已记录');
  const observedEdge = edge => edge.observed === true || (edge.observed !== false && edge.confidence === 'observed');
  const strictEdge = edge => observedEdge(edge) && edge.confidence !== 'context' && edge.confidence !== 'static' && edge.type !== 'candidate';
  const entryState = () => model.entry;
  function el(tag, content, className) { const node = document.createElement(tag); if (content != null) node.textContent = text(content); if (className) node.className = className; return node; }
  function svg(tag, attrs = {}, content) { const node = document.createElementNS(NS, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value)); if (content != null) node.textContent = text(content); return node; }
  function shortLabel(value, limit = 25) { const clean = text(value).replace(/\s+/g, ' ').trim(); return clean.length > limit ? clean.slice(0, limit - 1) + '…' : clean; }
  function nodeLabel(node) { return text(node.label || displayUrl(node.url) || typeLabel(node)); }
  function number(value) { return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0; }
  function pendingCount(pending) {
    if (typeof pending === 'number') return number(pending);
    if (!pending || typeof pending !== 'object') return 0;
    return number(pending.actions) + number(pending.seeds) + number(pending.bootstrap);
  }
  function safeCount(value) { return number(value).toLocaleString('zh-CN'); }
  function stateNode(stateId) { return model.stateById.get(String(stateId)); }
  function adjacent(id){return (model.incoming.get(id)||[]).concat(model.outgoing.get(id)||[]);}
  function cached(cache,key,create,limit=8){
    if(cache.has(key)){const value=cache.get(key);cache.delete(key);cache.set(key,value);return value;}
    const value=create();cache.set(key,value);if(cache.size>limit)cache.delete(cache.keys().next().value);return value;
  }
  function filterKey(){return JSON.stringify([model.mode,model.query,model.focus,$('show-observed').checked,$('show-candidates').checked,$('show-inactive').checked]);}
  function indexGraph(){
    const stateById=new Map(),flowByState=new Map(),flowDepth=new Map(),searchText=new Map();
    for(const node of model.nodes){if(node.type==='state'&&!stateById.has(String(node.stateId)))stateById.set(String(node.stateId),node);searchText.set(node.id,[node.label,node.url,node.method,typeLabel(node)].filter(Boolean).join(' ').toLocaleLowerCase());}
    for(const flow of model.graph.flows||[])if(flow&&Array.isArray(flow.steps)&&!flowByState.has(String(flow.stateId))){flowByState.set(String(flow.stateId),flow);flowDepth.set(String(flow.stateId),Math.min(24,flow.steps.length));}
    const entry=[...flowByState.values()].filter(flow=>flow.steps.length===0&&flow.complete!==false).map(flow=>stateById.get(String(flow.stateId))).find(Boolean)||stateById.values().next().value||null;
    const strictPrevious=new Map();if(entry){const queue=[entry.id];strictPrevious.set(entry.id,null);for(let head=0;head<queue.length;head++)for(const edge of model.outgoing.get(queue[head])||[])if(strictEdge(edge)&&!strictPrevious.has(edge.target)){strictPrevious.set(edge.target,queue[head]);queue.push(edge.target);}}
    // Keep connected branches together even when export order lists all states first.
    // This changes display order only; it never synthesizes edges or known paths.
    const displayOrder=[],seen=new Set();
    const visit=start=>{const stack=[start];while(stack.length){const id=stack.pop();if(seen.has(id))continue;seen.add(id);displayOrder.push(model.byId.get(id));const neighbors=[];for(const edge of model.outgoing.get(id)||[])neighbors.push(edge.target);for(const edge of model.incoming.get(id)||[])neighbors.push(edge.source);for(let i=neighbors.length-1;i>=0;i--)if(!seen.has(neighbors[i]))stack.push(neighbors[i]);}};
    if(entry)visit(entry.id);for(const node of model.nodes)if(!seen.has(node.id))visit(node.id);
    Object.assign(model,{stateById,flowByState,flowDepth,searchText,entry,strictPrevious,displayOrder,filterCache:new Map(),frameCache:new Map(),nodeElements:new Map(),edgeElements:new Map(),visibleEdges:[]});
  }
  function edgeAllowed(edge) {
    const target=model.byId.get(edge.target),source=model.byId.get(edge.source);
    // A recorded JS stack is visible context even when it cannot be paired to
    // an HTTP response. Keep it dashed; strictEdge still rejects this relation.
    if(edge.type==='initiates'&&edge.confidence==='context'&&source?.type==='script'&&source.executionObserved===true&&target?.type==='api'&&Array.isArray(edge.evidenceIds)&&edge.evidenceIds.length>0)return $('show-observed').checked;
    if(target&&inactive(target)&&$('show-inactive').checked&&['action','request'].includes(edge.type))return true;
    if (edge.confidence === 'static' || edge.type === 'candidate' || !observedEdge(edge)) return $('show-candidates').checked;
    return $('show-observed').checked;
  }
  function nodeAllowed(node) {
    if (inactive(node) && !$('show-inactive').checked) return false;
    if (candidate(node)) return $('show-candidates').checked || (inactive(node) && $('show-inactive').checked);
    return $('show-observed').checked;
  }
  function acceptGraph(value, imported = false) {
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw new Error('这不是受支持的探索地图。请选择 schemaVersion 为 1 的 graph.json。');
    if (value.nodes.length > 100000 || value.edges.length > 300000) throw new Error('地图超过本地查看上限，请先导出较小的探索范围。');
    const nodes = [], byId = new Map();
    for (const raw of value.nodes) {
      if (!raw || typeof raw.id !== 'string' || !TYPES.has(raw.type) || byId.has(raw.id)) continue;
      const node = { ...raw, id: raw.id.slice(0, 1000), label: nodeLabel(raw), url: displayUrl(raw.url) };
      nodes.push(node); byId.set(node.id, node);
    }
    const edges = [], incoming = new Map(), outgoing = new Map(); let dangling = 0;
    for (const raw of value.edges) {
      if (!raw || typeof raw.source !== 'string' || typeof raw.target !== 'string') { dangling++; continue; }
      if (!byId.has(raw.source) || !byId.has(raw.target)) { dangling++; continue; }
      const edge = { ...raw, id: String(raw.id || 'edge-' + edges.length), label: text(raw.label) };
      edges.push(edge);
      if (!incoming.has(edge.target)) incoming.set(edge.target, []); incoming.get(edge.target).push(edge);
      if (!outgoing.has(edge.source)) outgoing.set(edge.source, []); outgoing.get(edge.source).push(edge);
    }
    Object.assign(model, { graph: value, nodes, byId, edges, incoming, outgoing, dangling, selected: null, focus: null, page: 0, query: '' });
    indexGraph();
    $('graph-search').value = '';
    $('load-message').className = 'load-message';
    $('load-message').textContent = imported ? '已在本机读取所选地图。未向目标站点发送请求。' : '已载入本次探索结果。选择一种视图，沿关系逐步查看。';
    renderScope(); clearSelection(); render();
  }
  function renderScope() {
    const graph = model.graph, coverage = graph.coverage || {}, run = graph.run || {};
    const status = coverage.status || run.status || 'recorded';
    $('run-status').textContent = STATUS[status] || text(status);
    $('run-status').className = 'status-pill' + (status === 'partial' ? ' partial' : ['failed', 'blocked', 'needs_auth'].includes(status) ? ' failed' : '');
    $('asset-url').textContent = displayUrl(run.asset || run.startUrl || run.url || entryState()?.url) || '本地导入的探索地图';
    $('state-count').textContent = safeCount(model.nodes.filter(node => node.type === 'state').length);
    $('action-count').textContent = safeCount(model.nodes.filter(node => node.type === 'action').length);
    $('api-count').textContent = safeCount(model.nodes.filter(node => node.type === 'api' && node.responseObserved === true).length);
    const pending = pendingCount(coverage.pending || run.pending);
    $('pending-count').textContent = safeCount(pending);
    const gaps = Array.isArray(coverage.gaps) ? coverage.gaps : [];
    $('scope-note').textContent = `本次仍有 ${safeCount(pending)} 项待探索，记录 ${safeCount(gaps.length + model.dangling)} 项缺口。发现队列完成，不等于全站全部流程已覆盖。`;
    $('coverage-panel').hidden = false;
    $('coverage-summary').textContent = `范围与覆盖说明 · ${safeCount(gaps.length)} 项记录${model.dangling ? `，另有 ${safeCount(model.dangling)} 条断开的关系` : ''}`;
    const content = $('coverage-content'); content.replaceChildren();
    content.append(el('p', '地图保留本次已观察的状态、操作和请求；虚线只说明上下文或静态线索，不能据此补成完整调用链。'));
    if (coverage.stopReason || run.stopReason) content.append(el('p', '停止原因：' + text(coverage.stopReason || run.stopReason)));
    const limits = coverage.limits || run.budgets || {};
    const limitNames = { maxStates: '状态', maxDepth: '深度', maxDurationMs: '时长（毫秒）', maxRequests: '请求', maxActions: '操作', maxStatesPerHost: '每主机状态' };
    const limitTexts = Object.entries(limitNames).filter(([key]) => Object.hasOwn(limits, key)).map(([key, label]) => label + ' ' + (limits[key] == null ? '不限' : text(limits[key])));
    if (limitTexts.length) content.append(el('p', '本次预算：' + limitTexts.join(' · ')));
    const list = el('ul');
    for (const gap of gaps.slice(0, 100)) {
      const reason = typeof gap === 'string' ? gap : gap?.reason || '未分类记录';
      list.append(el('li', (GAP_LABEL[reason] || text(reason)) + (gap?.url ? ' · ' + displayUrl(gap.url) : '')));
    }
    if (gaps.length > 100) list.append(el('li', `另有 ${gaps.length - 100} 项，请查看原始覆盖记录。`));
    if (model.dangling) list.append(el('li', `${model.dangling} 条关系缺少起点或终点，已从地图省略，不会补造连接。`));
    if (list.childElementCount) content.append(list);
  }
  function neighborhood(id, depth = 2) {
    const found = new Set([id]); let frontier = [id];
    for (let level = 0; level < depth && found.size <= 5000; level++) {
      const next = [];
      for (const at of frontier) for (const edge of adjacent(at)) {
        if (!edgeAllowed(edge)) continue;
        const other = edge.source === at ? edge.target : edge.source;
        if (!found.has(other)) { found.add(other); next.push(other); }
        if (found.size > 5000) break;
      }
      frontier = next;
    }
    return found;
  }
  function filtered() {
    return cached(model.filterCache,filterKey(),computeFiltered);
  }
  function computeFiltered() {
    const modeTypes = model.mode === 'flow' ? new Set(['state', 'action', 'route']) : model.mode === 'calls' ? new Set(['state', 'action', 'api', 'script', 'route']) : TYPES;
    let nodes = model.displayOrder.filter(node => modeTypes.has(node.type) && nodeAllowed(node) && (model.mode !== 'flow' || node.type !== 'route' || candidate(node)));
    if (model.mode === 'calls') nodes = nodes.filter(node => node.type !== 'route' || adjacent(node.id).some(edge => ['request', 'initiates', 'redirect'].includes(edge.type)));
    if (model.focus) { const nearby = neighborhood(model.focus); nodes = nodes.filter(node => nearby.has(node.id)); }
    let matches = null;
    if (model.query) {
      const query = model.query.toLocaleLowerCase();
      matches = new Set(nodes.filter(node => model.searchText.get(node.id).includes(query)).map(node => node.id));
      const context = new Set(matches);
      for (const id of matches) for (const edge of adjacent(id)) if (edgeAllowed(edge)) { context.add(edge.source); context.add(edge.target); }
      nodes = nodes.filter(node => context.has(node.id));
    }
    return { nodes, matches };
  }
  function layout(nodes, edges) {
    const levels = new Map(), columns = new Map(), neighbors = new Map(), rank = new Map();
    for (const node of nodes) {
      let level;
      if (model.mode === 'calls') level = node.type === 'state' || node.type === 'route' ? 0 : node.type === 'api' ? 2 : 1;
      else if (node.type === 'state') level = model.flowDepth.get(String(node.stateId)) ?? Math.min(24, number(node.depth));
      else if (node.type === 'action') level = (model.flowDepth.get(String(node.stateId)) ?? 0) + .5;
      else level = node.type === 'api' ? 25 : 26;
      if (!levels.has(level)) levels.set(level, []);
      levels.get(level).push(node);
    }
    const ordered = [...levels].sort(([a], [b]) => a - b);
    ordered.forEach(([, group], column) => group.forEach((node, row) => { columns.set(node.id, column); rank.set(node.id, row); neighbors.set(node.id, new Set()); }));
    for (const edge of edges) if (edge.source !== edge.target) { neighbors.get(edge.source)?.add(edge.target); neighbors.get(edge.target)?.add(edge.source); }
    // Barycentric sweeps order related rows together. Only real displayed edges
    // participate; ordering does not create links or change their confidence.
    for (let pass = 0; pass < 3; pass++) for (const [, group] of pass % 2 ? [...ordered].reverse() : ordered) {
      const scores = new Map();
      for (const node of group) {
        let sum = 0, count = 0;
        for (const id of neighbors.get(node.id)) if (columns.get(id) !== columns.get(node.id)) { sum += rank.get(id); count++; }
        const parent = node.type === 'action' ? stateNode(node.stateId) : null;
        if (parent && rank.has(parent.id)) { sum += rank.get(parent.id) * 2; count += 2; }
        scores.set(node.id, count ? sum / count : rank.get(node.id));
      }
      group.sort((a, b) => scores.get(a.id) - scores.get(b.id) || rank.get(a.id) - rank.get(b.id));
      group.forEach((node, row) => rank.set(node.id, row));
    }
    const positions = new Map();
    ordered.forEach(([, group], column) => group.forEach((node, row) => positions.set(node.id, { x: 30 + column * 340, y: 64 + row * 118, width: 236, height: 76 })));
    return positions;
  }
  function edgeGeometry(edge, positions, lane, lanes, returnLane) {
    const a = positions.get(edge.source), b = positions.get(edge.target);
    const offset = (lane - (lanes - 1) / 2) * 18;
    let d, labelX, labelY, kind, points;
    if (edge.source === edge.target) {
      const radius = 62 + lane * 23, top = a.y - 42 - lane * 23;
      const x = a.x + a.width, y = a.y + 27;
      d = `M${x - 22},${a.y} C${x - 22},${top} ${x + radius},${top} ${x + radius},${a.y + 8} C${x + radius},${y} ${x + 25},${y} ${x},${y}`;
      labelX = x + radius / 2; labelY = top - 7; kind = 'loop';
      points = [[a.x, top - 18], [x + radius, y], [labelX, labelY]];
    } else if (a.x === b.x) {
      const right = b.y > a.y, sign = right ? 1 : -1;
      const x1 = a.x + (right ? a.width : 0), x2 = b.x + (right ? b.width : 0);
      const y1 = a.y + a.height / 2, y2 = b.y + b.height / 2, rail = x1 + sign * (52 + lane * 22);
      d = `M${x1},${y1} C${rail},${y1} ${rail},${y2} ${x2},${y2}`;
      labelX = rail; labelY = (y1 + y2) / 2 - 7; kind = 'same-column';
      points = [[rail, y1], [rail, y2], [labelX, labelY]];
    } else if (b.x < a.x) {
      const x1 = a.x, y1 = a.y + a.height / 2, x2 = b.x + b.width, y2 = b.y + b.height / 2;
      const rail1 = x1 - 25 - lane * 10, rail2 = x2 + 25 + lane * 10, top = 18 - returnLane * 20;
      d = `M${x1},${y1} L${rail1},${y1} L${rail1},${top} L${rail2},${top} L${rail2},${y2} L${x2},${y2}`;
      labelX = (rail1 + rail2) / 2; labelY = top - 7; kind = 'return';
      points = [[rail1, top - 18], [rail2, top - 18], [x1, y1], [x2, y2]];
    } else {
      const x1 = a.x + a.width, x2 = b.x, port = Math.max(-25, Math.min(25, offset / 2));
      const y1 = a.y + a.height / 2 + port, y2 = b.y + b.height / 2 + port, bend = Math.max(42, (x2 - x1) * .45);
      d = `M${x1},${y1} C${x1 + bend},${y1 + offset} ${x2 - bend},${y2 + offset} ${x2},${y2}`;
      labelX = (x1 + x2) / 2; labelY = (y1 + y2) / 2 + offset * .75 - 9; kind = lanes > 1 ? 'parallel' : 'forward';
      points = [[x1, y1 + offset], [x2, y2 + offset], [labelX, labelY]];
    }
    return { d, labelX, labelY, kind, points };
  }
  function makeFrame(nodes, edges) {
    const positions = layout(nodes, edges), root = svg('g', { class: 'graph-frame' });
    const edgeLayer = svg('g', { class: 'edge-layer' }), nodeLayer = svg('g', { class: 'node-layer' });
    const nodeElements = new Map(), edgeElements = new Map(), pairs = new Map();
    root.append(edgeLayer, nodeLayer);
    const xs = [0, 500], ys = [0, 250];
    for (const p of positions.values()) { xs.push(p.x, p.x + p.width); ys.push(p.y, p.y + p.height); }
    for (const edge of edges) {
      const key = JSON.stringify([edge.source, edge.target].sort());
      if (!pairs.has(key)) pairs.set(key, []); pairs.get(key).push(edge);
    }
    const routes = new Map(); let returns = 0;
    for (const group of pairs.values()) group.forEach((edge, lane) => routes.set(edge.id, edgeGeometry(edge, positions, lane, group.length, returns += positions.get(edge.target).x < positions.get(edge.source).x ? 1 : 0)));
    for (const edge of edges) {
      const geometry = routes.get(edge.id);
      for (const [x, y] of geometry.points) { xs.push(x - 25, x + 25); ys.push(y - 12, y + 12); }
      const group = svg('g', { class: `edge edge-${edge.confidence === 'static' ? 'static' : edge.confidence === 'context' ? 'context' : 'observed'}`, 'data-edge-id': edge.id, 'data-geometry': geometry.kind });
      group.append(svg('title', {}, edge.label || edge.type));
      group.append(svg('path', { class: 'edge-path', d: geometry.d }));
      const label = svg('text', { class: 'edge-label', x: geometry.labelX, y: geometry.labelY, 'text-anchor': 'middle' }, shortLabel(edge.label || ({ action: '操作', transition: '进入', request: '请求', candidate: '线索', initiates: '来源关联', redirect: '重定向' }[edge.type] || '关联'), 12));
      group.append(label); edgeLayer.append(group); edgeElements.set(edge.id, { group, label, edge });
    }
    for (const node of nodes) {
      const p = positions.get(node.id);
      const group = svg('g', { class: `node node-${node.type}${inactive(node) ? ' node-inactive' : ''}`, transform: `translate(${p.x},${p.y})`, tabindex: 0, role: 'button', 'aria-pressed': 'false', 'aria-label': typeLabel(node) + '：' + nodeLabel(node), 'data-node-id': node.id });
      group.append(svg('title', {}, nodeLabel(node) + (node.url ? '\n' + node.url : '')));
      group.append(svg('rect', { class: 'node-card', x: 0, y: 0, width: p.width, height: p.height, rx: 10 }));
      group.append(svg('rect', { class: 'node-indicator', x: 14, y: 12, width: 6, height: 6, rx: 2 }));
      group.append(svg('text', { class: 'node-kind', x: 26, y: 18 }, typeLabel(node) + ' · ' + statusLabel(node)));
      group.append(svg('text', { class: 'node-label', x: 14, y: 40 }, shortLabel(nodeLabel(node), 22)));
      let sub = node.method ? node.method + ' ' + node.url : node.url || (node.type === 'action' ? '点击后查看路径与请求' : '点击查看关联与证据');
      try { if (node.url) { const url = new URL(node.url); sub = (node.method ? node.method + ' ' : '') + url.pathname + url.search; } } catch {}
      group.append(svg('text', { class: 'node-subtitle', x: 14, y: 60 }, shortLabel(sub, 39)));
      nodeLayer.append(group); nodeElements.set(node.id, group);
    }
    const minX = Math.min(...xs), minY = Math.min(...ys);
    return { root, positions, nodeElements, edgeElements, bounds: { minX, minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY } };
  }
  function updateSelection() {
    if (!model.graph) return;
    const selected = model.selected, nearby = selected ? neighborhood(selected, 1) : null;
    const pathEdges = new Set(), pathNodes = new Set();
    if (selected) {
      const path = pathTo(model.byId.get(selected));
      for (let index = 1; index < path.nodes.length; index++) {
        const a = path.nodes[index - 1].id, b = path.nodes[index].id;
        if (!a || !b) continue;
        for (const edge of model.outgoing.get(a) || []) if (edge.target === b && strictEdge(edge)) { pathEdges.add(edge.id); pathNodes.add(a); pathNodes.add(b); }
      }
    }
    for (const [id, group] of model.nodeElements) {
      group.classList.toggle('selected', selected === id);
      group.classList.toggle('on-path', pathNodes.has(id));
      group.classList.toggle('dimmed', !!selected && !nearby.has(id) && !pathNodes.has(id));
      group.setAttribute('aria-pressed', String(selected === id));
    }
    for (const { group, label, edge } of model.edgeElements.values()) {
      const connected = !!selected && (edge.source === selected || edge.target === selected), onPath = pathEdges.has(edge.id);
      group.classList.toggle('selected', connected); group.classList.toggle('on-path', onPath);
      group.classList.toggle('dimmed', !!selected && !connected && !onPath);
      if (model.visibleEdges.length <= 36 || connected || onPath) label.removeAttribute('hidden'); else label.setAttribute('hidden', '');
    }
    const pathVisible = [...pathEdges].filter(id => model.edgeElements.has(id)).length;
    $('edge-note').textContent = selected&&!model.nodeElements.has(selected)?'所选节点不在当前画布；可点“只看周围关系”查看。':pathVisible ? `蓝色强调 ${pathVisible} 条已观察路径关系；虚线仍只表示上下文。` : '实线为已观察关系，虚线为上下文或静态线索。';
  }
  function render(reset = true) {
    if (!model.graph) return;
    const { nodes: available, matches } = filtered();
    const pages = Math.max(1, Math.ceil(available.length / NODE_LIMIT)); model.page = Math.min(model.page, pages - 1);
    const nodes = available.slice(model.page * NODE_LIMIT, (model.page + 1) * NODE_LIMIT), ids = new Set(nodes.map(node => node.id));
    const key = filterKey() + ':' + model.page;
    const frame = cached(model.frameCache, key, () => {
      const allEdges = [];
      for (const node of nodes) for (const edge of model.outgoing.get(node.id) || []) if (ids.has(edge.target) && edgeAllowed(edge) && (model.mode !== 'calls' || edge.type !== 'transition')) allEdges.push(edge);
      const edges = allEdges.slice(0, EDGE_LIMIT);
      return { ...makeFrame(nodes, edges), nodes, edges, omittedEdges: allEdges.length - edges.length };
    });
    model.visible = frame.nodes; model.visibleEdges = frame.edges; model.positions = frame.positions;
    model.nodeElements = frame.nodeElements; model.edgeElements = frame.edgeElements; model.bounds = frame.bounds;
    const world = $('graph-world'); if (world.firstElementChild !== frame.root) world.replaceChildren(frame.root);
    $('map-title').textContent = MODE_LABEL[model.mode] + (model.focus ? ' · 局部关系' : '');
    $('render-summary').textContent = `${matches ? `匹配 ${safeCount(matches.size)} 个，含相邻节点 · ` : ''}显示 ${safeCount(nodes.length)} / ${safeCount(available.length)} 个节点 · ${safeCount(frame.edges.length)} 条关系`;
    $('page-label').textContent = `${model.page + 1} / ${pages}`;
    $('previous-page').disabled = model.page === 0; $('next-page').disabled = model.page >= pages - 1;
    $('empty-map').hidden = nodes.length !== 0;
    const omitted = available.length - nodes.length;
    $('omission-note').hidden = omitted <= 0 && frame.omittedEdges <= 0;
    $('omission-note').textContent = `${omitted > 0 ? `为保持清晰，本页省略 ${safeCount(omitted)} 个节点；可翻页、搜索或选择节点后只看周围关系。跨页关系未在画布连线，节点详情仍可查看全部前后关联。` : ''}${frame.omittedEdges > 0 ? ` 另有 ${safeCount(frame.omittedEdges)} 条关系未画出。` : ''}`;
    $('filter-caption').textContent = model.focus ? '仅显示所选节点周围两步内的关系。' : '实线为已观察关系，虚线为上下文或候选线索。';
    updateSelection();
    if (reset) model.view = { x: 34 - Math.min(0, model.bounds.minX) * .85, y: 46 - Math.min(0, model.bounds.minY) * .85, scale: .85 };
    applyView();
  }
  function applyView() {
    $('graph-world').setAttribute('transform', `translate(${model.view.x},${model.view.y}) scale(${model.view.scale})`);
    $('zoom-level').textContent = Math.round(model.view.scale * 100) + '%';
  }
  function zoom(factor, at) {
    const old = model.view.scale, next = Math.max(.12, Math.min(2.4, old * factor));
    const rect = $('graph-map').getBoundingClientRect();
    const point = at || { x: rect.width / 2, y: rect.height / 2 };
    model.view.x = point.x - (point.x - model.view.x) * next / old;
    model.view.y = point.y - (point.y - model.view.y) * next / old;
    model.view.scale = next; applyView();
  }
  function pathTo(node) {
    if (node.type === 'state' || node.type === 'action') {
      const flow = model.flowByState.get(String(node.stateId));
      if (flow && Array.isArray(flow.steps)) {
        const result = [];
        for (const step of flow.steps.slice(0, 80)) {
          const state = stateNode(step.stateId); if (state && result.at(-1)?.id !== state.id) result.push(state);
          const action = model.byId.get(step.actionId); result.push(action || { id: '', type: 'action', kind: step.kind, label: text(step.label || '已记录操作') });
        }
        const truncated=flow.steps.length>80;
        if(truncated)result.push({id:'',type:'action',label:`中间另有 ${flow.steps.length-80} 步未展示；不是直接连接`});
        const state = node.type === 'state' ? node : stateNode(node.stateId);
        if (state && result.at(-1)?.id !== state.id) result.push(state);
        if (node.type === 'action') result.push(node);
        const note=(truncated?'路径较长，展示前80步与目标；中间步骤已明确省略，不能视为直接连接。':flow.complete===false?'这是已记录的到达路径，其中仍有缺口；不能补推未观察步骤。':'按本次记录的到达步骤展示，不代表所有可能路径。')
          +(node.type==='action'&&inactive(node)?' 所选操作尚未完成；这里展示其所在页面的到达路径，不代表操作已成功执行。':'')
          +(flow.steps.some(step=>step.kind==='seed')?' 其中包含直接打开的地址，不代表页面上存在相应点击入口。':'');
        return {nodes:result,note};
      }
    }
    const root = entryState();
    if (!root) return { nodes: [], note: '没有入口状态记录，无法拼出可靠的到达路径。' };
    const previous=model.strictPrevious;
    if (!previous.has(node.id)) return { nodes: [], note: candidate(node) ? '这只是候选线索，尚未观察到从入口到达这里的流程。' : '没有足够的已观察关系连接到入口。可查看下方上下文关联，不能据此补造路径。' };
    const result = []; let at = node.id;
    while (at != null && result.length < 80) { result.unshift(model.byId.get(at)); at = previous.get(at); }
    return { nodes: result, note: at != null ? '路径较长，仅显示最后80步；请沿前后关联继续查看。' : '这是已观察关系中的一条最短路径，不代表所有可能路径。' };
  }
  function appendCallFrames(container,frames){
    if(!Array.isArray(frames)||!frames.length)return;
    const list=el('div',null,'callsite-list');list.append(el('p','记录到的脚本函数','callsite-heading'));
    for(const frame of frames.slice(0,8)){
      const line=Number.isSafeInteger(frame.lineNumber)&&frame.lineNumber>=0?frame.lineNumber+1:null;
      const column=Number.isSafeInteger(frame.columnNumber)&&frame.columnNumber>=0?frame.columnNumber+1:null;
      const location=displayUrl(frame.url||frame.scriptUrl||'')+(line!=null?':'+line+(column!=null?':'+column:''):'');
      list.append(el('p',(text(frame.functionName)||'匿名函数')+(location?' · '+location:'')));
    }
    if(frames.length>8)list.append(el('p',`另有 ${frames.length-8} 个调用位置。`));
    container.append(list);
  }
  function showMeta(label, value) { if (value == null || value === '') return; $('selected-meta').append(el('dt', label), el('dd', value)); }
  function selectNode(id) {
    const node = model.byId.get(id); if (!node) return;
    if(model.selected===id&&!$('detail-content').hidden){updateSelection();return;}
    model.selected = id;
    $('detail-placeholder').hidden = true; $('detail-content').hidden = false; $('clear-selection').hidden = false;
    $('selected-label').textContent = nodeLabel(node);
    $('detail-badges').replaceChildren(el('span', typeLabel(node), 'badge-' + node.type), el('span',statusLabel(node)));
    $('selected-meta').replaceChildren();
    showMeta('地址（仅作文本展示）', node.url); showMeta('请求方式', node.method);
    if (node.type === 'api') showMeta('请求记录', node.responseObserved === true ? '已收到 HTTP 响应' : node.status === 'blocked' ? '请求被拦截，未证明到达服务器' : node.status === 'failed' ? '请求失败，未证明收到响应' : '尚无已记录的 HTTP 响应');
    showMeta('页面状态编号', node.stateId); showMeta('操作编号', node.actionId);
    showMeta('证据含义', node.confidence === 'static' ? '静态线索，尚未证明实际访问' : node.confidence === 'context' ? '上下文关联，不能直接证明因果' : '本次记录中已观察');
    $('clear-focus').hidden = !model.focus;
    const image = $('selected-image'); image.replaceChildren();
    if (typeof node.screenshot === 'string' && /^states\/\d+\.(?:png|jpg)$/.test(node.screenshot)) {
      const img = el('img'); img.alt = '本次保存的页面截图'; img.loading = 'lazy'; img.src = './' + node.screenshot;
      img.addEventListener('error', () => { image.replaceChildren(el('p', '本地截图不可用，地图与证据仍可查看。')); });
      image.append(img, el('p', '仅加载本地保存的状态截图。'));
    }
    const path = pathTo(node); $('path-note').textContent = path.note; const list = $('known-path'); list.replaceChildren();
    for (const step of path.nodes) {
      const item = el('li'); if (step.id && model.byId.has(step.id)) { const button = el('button', typeLabel(step) + ' · ' + nodeLabel(step)+(step.type==='action'&&inactive(step)?'（'+statusLabel(step)+'）':'')); button.type = 'button'; button.addEventListener('click', () => selectNode(step.id)); item.append(button); } else item.textContent = (step.kind==='seed'?'直接打开地址':'已记录操作')+' · '+text(step.label);
      list.append(item);
    }
    const relations = $('relations'); relations.replaceChildren();
    appendCallFrames(relations,node.callSites||node.functions);
    for (const [title, edges, side] of [['从哪里来', model.incoming.get(id) || [], 'source'], ['接下来关联到', model.outgoing.get(id) || [], 'target']]) {
      const group = el('div', null, 'relation-group'); group.append(el('h4', `${title} · ${safeCount(edges.length)}`));
      for (const edge of edges.slice(0, 60)) {
        const other = model.byId.get(edge[side]); if (!other) continue;
        const button = el('button', null, 'relation-button'); button.type = 'button';
        button.append(el('span', nodeLabel(other)), el('small', edge.confidence === 'static' ? '候选' : edge.confidence === 'context' ? '上下文' : '已观察'));
        button.addEventListener('click', () => selectNode(other.id)); group.append(button);
        appendCallFrames(group,edge.callFrames);
      }
      if (edges.length > 60) group.append(el('p', `另有 ${edges.length - 60} 项关联，请结合搜索和局部视图查看。`, 'detail-hint'));
      if (!edges.length) group.append(el('p', '暂无已记录关联。', 'detail-hint'));
      relations.append(group);
    }
    const evidence = new Set(Array.isArray(node.evidenceIds) ? node.evidenceIds.map(value => text(value, 500)) : []);
    evidenceRows:for(const edge of adjacent(id))for(const value of Array.isArray(edge.evidenceIds)?edge.evidenceIds:[]){evidence.add(text(value,500));if(evidence.size>200)break evidenceRows;}
    $('evidence-summary').textContent = `证据编号 · ${safeCount(evidence.size)}${node.evidenceOmitted ? '（另有未展示记录）' : ''}`;
    $('evidence-list').replaceChildren();
    for (const value of [...evidence].slice(0, 200)) $('evidence-list').append(el('li', value));
    if (!evidence.size) $('evidence-list').append(el('li', '该节点没有独立证据编号；请检查关系记录及覆盖缺口。'));
    if (evidence.size > 200) $('evidence-list').append(el('li', '仅展示前200条证据编号。'));
    updateSelection();
  }
  function clearSelection() {
    model.selected = null; $('detail-placeholder').hidden = false; $('detail-content').hidden = true; $('clear-selection').hidden = true;
    $('selected-image').replaceChildren();
    updateSelection();
  }
  for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => {
    if(model.mode===button.dataset.mode)return;
    model.mode = button.dataset.mode; model.page = 0;
    for (const other of document.querySelectorAll('[data-mode]')) other.setAttribute('aria-selected', String(other === button));
    render();
  });
  for (const id of ['show-observed', 'show-candidates', 'show-inactive']) $(id).addEventListener('change', () => { model.page = 0; render(); });
  $('graph-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { const query=$('graph-search').value.trim();if(query===model.query)return;model.query=query; model.page=0; render(); }, 140); });
  $('previous-page').addEventListener('click', () => { model.page--; render(); });
  $('next-page').addEventListener('click', () => { model.page++; render(); });
  $('clear-selection').addEventListener('click', clearSelection);
  $('focus-node').addEventListener('click', () => { model.focus = model.selected; model.query='';$('graph-search').value='';model.page = 0; $('clear-focus').hidden = false; render(); });
  $('clear-focus').addEventListener('click', () => { model.focus = null; model.page = 0; $('clear-focus').hidden = true; render(); });
  $('zoom-in').addEventListener('click', () => zoom(1.2)); $('zoom-out').addEventListener('click', () => zoom(1 / 1.2));
  $('reset-view').addEventListener('click', () => { model.view = { x: 34, y: 46, scale: .85 }; applyView(); });
  $('fit-view').addEventListener('click', () => {
    const rect = $('graph-map').getBoundingClientRect(); const scale = Math.max(.12, Math.min(1.1, (rect.width - 55) / model.bounds.width, (rect.height - 70) / model.bounds.height));
    model.view = { scale, x: Math.max(20,(rect.width-model.bounds.width*scale)/2)-(model.bounds.minX||0)*scale, y: Math.max(25,(rect.height-model.bounds.height*scale)/2-15)-(model.bounds.minY||0)*scale }; applyView();
  });
  const map = $('graph-map');
  map.addEventListener('click',event=>{const node=event.target.closest?.('.node');if(node&&!moved)selectNode(node.dataset.nodeId);});
  map.addEventListener('keydown',event=>{const node=event.target.closest?.('.node');if(node&&(event.key==='Enter'||event.key===' ')){event.preventDefault();selectNode(node.dataset.nodeId);}});
  map.addEventListener('wheel', event => { event.preventDefault(); const rect = map.getBoundingClientRect(); zoom(event.deltaY > 0 ? 1 / 1.12 : 1.12, { x: event.clientX - rect.left, y: event.clientY - rect.top }); }, { passive: false });
  map.addEventListener('pointerdown', event => {
    moved = false; if (event.target.closest('.node')) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: model.view.x, originY: model.view.y }; map.setPointerCapture(event.pointerId); map.classList.add('dragging');
  });
  map.addEventListener('pointermove', event => { if (!drag || drag.id !== event.pointerId) return; const dx = event.clientX - drag.x, dy = event.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 4) moved = true; model.view.x = drag.originX + dx; model.view.y = drag.originY + dy; applyView(); });
  const endDrag = () => { drag = null; map.classList.remove('dragging'); setTimeout(() => { moved = false; }, 0); };
  map.addEventListener('pointerup', endDrag); map.addEventListener('pointercancel', endDrag);
  map.addEventListener('keydown', event => { if (event.target !== map) return; const changes = { ArrowLeft: [35, 0], ArrowRight: [-35, 0], ArrowUp: [0, 35], ArrowDown: [0, -35] }; if (changes[event.key]) { event.preventDefault(); model.view.x += changes[event.key][0]; model.view.y += changes[event.key][1]; applyView(); } else if (event.key === '+' || event.key === '=') zoom(1.2); else if (event.key === '-') zoom(1 / 1.2); });
  $('graph-file').addEventListener('change', async () => {
    const file = $('graph-file').files?.[0]; if (!file) return;
    try { if (file.size > FILE_LIMIT) throw new Error('文件超过32MB，请导入更小的探索地图。'); acceptGraph(JSON.parse(await file.text()), true); }
    catch (error) { $('load-message').className = 'load-message error'; $('load-message').textContent = text(error.message); }
    finally { $('graph-file').value = ''; }
  });
  fetch(new URL('./graph.json', location.href), { credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' })
    .then(response => { if (!response.ok) throw new Error('地图文件尚未生成'); const length = Number(response.headers.get('content-length')); if (length > FILE_LIMIT) throw new Error('地图文件超过32MB，请手动选择较小的地图。'); return response.text(); })
    .then(body => { if (body.length > FILE_LIMIT) throw new Error('地图文件过大，请导入较小的地图。'); acceptGraph(JSON.parse(body)); })
    .catch(() => { $('load-message').className = 'load-message error'; $('load-message').textContent = '未能直接读取地图。离线打开时，请点击右上角“导入地图”选择 graph.json；文件只在本机读取。'; $('asset-url').textContent = '等待导入本次探索的 graph.json'; });
})();
