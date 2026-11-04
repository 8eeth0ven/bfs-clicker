import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function temp(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bfs-regression-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
export const json = file => JSON.parse(readFileSync(file, 'utf8'));
export const lines = file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
export const document = (title, body, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="data:,"></head><body><h1>${title}</h1>${body}<script>${script}</script></body></html>`;
export async function fixture(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const entry = { url: new URL(req.url, 'http://localhost'), method: req.method, headers: req.headers };
    requests.push(entry);
    try {
      const result = await handler(entry, req);
      const { status = 200, body = '', headers = {}, type = 'text/html; charset=utf-8' } = result || { status: 404 };
      res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), ...headers });
      res.end(body);
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { server, requests, origin: `http://127.0.0.1:${server.address().port}` };
}
export const config = (origin, outputDir, extra = {}) => ({
  startUrl: origin + '/', outputDir, limitMode: 'custom', maxStates: 40, maxDepth: 8,
  maxStatesPerHost: 40, maxDurationMs: 30000, maxActions: 100, maxRequests: 500,
  requestDelayMs: 0, shotFormat: 'none', ...extra,
});
export function readRun(dir) {
  return { meta: json(path.join(dir, 'private/run.json')), cp: json(path.join(dir, 'private/checkpoint.json')),
    apis: json(path.join(dir, 'private/apis.json')), events: lines(path.join(dir, 'private/events.jsonl')),
    traffic: lines(path.join(dir, 'private/traffic.jsonl')) };
}
export async function until(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Timed out waiting for the fixture condition');
}
