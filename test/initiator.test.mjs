import test from 'node:test';
import assert from 'node:assert/strict';
import { initiatorRecord } from '../src/initiator.js';

test('network initiation keeps call sites and action occurrence without headers, arguments or locals', () => {
  const event = { requestId: 'r1', request: { url: 'https://example.com/api/read', method: 'GET', headers: { Cookie: 'secret' }, postData: 'private-body' },
    documentURL: 'https://example.com/app', type: 'XHR', frameId: 'f1', timestamp: 5,
    initiator: { type: 'script', stack: { callFrames: [{ functionName: 'loadItems', url: 'https://example.com/app.js', lineNumber: 41, columnNumber: 2, args: 'private-arg', local: 'private-local' }] } } };
  const row = initiatorRecord(event, 'session1', { currentStateId: 3, currentActionId: 'button', currentExecutionId: 'run:9', currentControl: '查看项目' });
  assert.equal(row.networkId, 'session1:r1'); assert.equal(row.source.stateId, 3); assert.equal(row.source.executionId, 'run:9');
  assert.equal(row.initiator.stack.callFrames[0].lineNumber, 41); assert.equal(row.confidence, 'context');
  for (const secret of ['secret', 'private-body', 'private-arg', 'private-local']) assert(!JSON.stringify(row).includes(secret));
});

test('call stacks stay bounded, invalid coordinates are omitted, and non-HTTP schemes are ignored', () => {
  const stack = depth => ({ callFrames: Array.from({ length: 50 }, () => ({ url: 'https://example.com/app.js', lineNumber: -1, columnNumber: 1.5 })), ...(depth ? { parent: stack(depth - 1) } : {}) });
  const row = initiatorRecord({ requestId: '1', request: { url: 'https://example.com/' }, initiator: { stack: stack(9) } }, 's');
  let frames = 0, levels = 0;
  for (let part = row.initiator.stack; part; part = part.parent) { levels++; frames += part.callFrames.length; assert(part.callFrames.every(f => f.lineNumber === null && f.columnNumber === null)); }
  assert.equal(levels, 3); assert.equal(frames, 36);
  assert.equal(initiatorRecord({ request: { url: 'data:text/plain,x' } }, 's'), null);
  const long = 'https://example.com/api?q=' + 'x'.repeat(3000);
  assert.equal(initiatorRecord({ requestId: 'r', request: { url: long } }, 's').url, long);
});
