// 1,000 groups × five node kinds. Edges include returns, parallel requests,
// recorded JS contexts, and self-loops; export order deliberately separates types.
export function connectedGraph(groups = 1000) {
  const nodes = [], edges = [], flows = [];
  const base = 'https://graph.example.test';
  const observed = { observed: true, confidence: 'observed' };
  for (let i = 0; i < groups; i++) nodes.push({ id: 's-' + i, type: 'state', stateId: i, label: '页面 ' + String(i).padStart(5, '0'), url: base + '/page/' + i, status: i > groups - 20 ? 'pending' : 'expanded', ...observed, evidenceIds: ['state:' + i] });
  for (let i = 0; i < groups; i++) nodes.push({ id: 'a-' + i, type: 'action', stateId: i, actionId: 'key-' + i, label: '查看记录 ' + i, status: 'succeeded', ...observed, evidenceIds: ['action:' + i] });
  for (let i = 0; i < groups; i++) nodes.push({ id: 'api-' + i, type: 'api', label: 'GET /api/record/' + i, url: base + '/api/record/' + i, method: 'GET', status: 'observed', responseObserved: true, ...observed, evidenceIds: ['response:' + i] });
  for (let i = 0; i < groups; i++) nodes.push({ id: 'js-' + i, type: 'script', label: 'record-' + i + '.js', url: base + '/assets/record-' + i + '.js', status: 'executed_context', observed: true, executionObserved: true, confidence: 'context', functions: [{ functionName: 'loadRecord', url: base + '/assets/record-' + i + '.js', lineNumber: i, columnNumber: 0 }] });
  for (let i = 0; i < groups; i++) nodes.push({ id: 'source-' + i, type: 'route', label: '页面后台 ' + i, url: base + '/page/' + i, status: 'request_source', observed: true, confidence: 'context', background: true });
  for (let i = 0; i < groups; i++) {
    edges.push({ id: 'action-' + i, source: 's-' + i, target: 'a-' + i, type: 'action', ...observed, label: '执行操作', evidenceIds: ['action:' + i] });
    for (let child = 2 * i + 1; child <= 2 * i + 2 && child < groups; child++) edges.push({ id: 'child-' + child, source: 'a-' + i, target: 's-' + child, type: 'transition', ...observed, label: '进入子页' });
    for (let lane = 0; lane < 3; lane++) edges.push({ id: 'request-' + i + '-' + lane, source: 'a-' + i, target: 'api-' + i, type: 'request', observed: true, confidence: 'context', label: lane ? '重放请求 ' + lane : '请求上下文', evidenceIds: ['request:' + i + ':' + lane] });
    edges.push({ id: 'initiator-' + i, source: 'js-' + i, target: 'api-' + i, type: 'initiates', observed: false, confidence: 'context', label: '脚本发起记录', evidenceIds: ['stack:' + i], callFrames: [{ functionName: 'loadRecord', url: base + '/assets/record-' + i + '.js', lineNumber: i, columnNumber: 0 }] });
    edges.push({ id: 'background-' + i, source: 'source-' + i, target: 'api-' + i, type: 'request', observed: true, confidence: 'context', label: '后台请求' });
    if (i % 10 === 0) {
      edges.push({ id: 'loop-' + i, source: 'api-' + i, target: 'api-' + i, type: 'redirect', ...observed, label: '同地址回环' });
      edges.push({ id: 'loop-second-' + i, source: 'api-' + i, target: 'api-' + i, type: 'redirect', ...observed, label: '另一次回环' });
    }
    if (i > 0) edges.push({ id: 'return-' + i, source: 'a-' + i, target: 's-' + Math.floor((i - 1) / 2), type: 'transition', ...observed, label: '返回上级' });
    const steps = []; let at = i;
    while (at > 0) { const parent = Math.floor((at - 1) / 2); steps.push({ stateId: parent, actionId: 'a-' + parent, label: '进入子页', kind: 'click' }); at = parent; }
    flows.push({ stateId: i, steps: steps.reverse(), url: base + '/page/' + i, complete: true });
  }
  return { schemaVersion: 1, run: { asset: base + '/', status: 'partial' }, nodes, edges, flows, coverage: { status: 'partial', pending: { actions: 19 }, gaps: [], limits: { maxStates: groups } } };
}
