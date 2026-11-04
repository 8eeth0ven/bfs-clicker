// Keep browser-provided call sites, never JavaScript arguments, locals, headers
// or response bodies. These are client-side initiation hints, not backend spans.
const text = (value, max = 2000) => typeof value === 'string' ? value.slice(0, max) : '';
const coordinate = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function stackTrace(stack, depth = 0) {
  if (!stack || depth >= 3) return undefined;
  const callFrames = (Array.isArray(stack.callFrames) ? stack.callFrames : []).slice(0, 12).map(frame => ({
    functionName: text(frame.functionName, 160), url: text(frame.url),
    lineNumber: coordinate(frame.lineNumber), columnNumber: coordinate(frame.columnNumber),
  }));
  const parent = stackTrace(stack.parent, depth + 1);
  return { callFrames, ...(parent ? { parent } : {}) };
}
export function initiatorRecord(event, sessionId, runtime = {}) {
  const request = event?.request;
  if (!request || !/^https?:\/\//i.test(request.url || '')) return null;
  const raw = event.initiator || {}, stack = stackTrace(raw.stack);
  return {
    networkId: `${sessionId}:${event.requestId}`, url: request.url, method: text(request.method, 16),
    documentURL: typeof event.documentURL==='string'?event.documentURL:'', type: text(event.type, 40), frameId: text(event.frameId, 200),
    browserTimestamp: Number.isFinite(event.timestamp) ? event.timestamp : null,
    initiator: { type: text(raw.type, 40), url: text(raw.url), lineNumber: coordinate(raw.lineNumber),
      columnNumber: coordinate(raw.columnNumber), ...(stack ? { stack } : {}) },
    source: { kind: 'page', page: text(event.documentURL), control: text(runtime.currentControl, 180),
      stateId: runtime.currentStateId ?? null, actionId: runtime.currentActionId || null,
      executionId: runtime.currentExecutionId || null },
    confidence: 'context',
  };
}
