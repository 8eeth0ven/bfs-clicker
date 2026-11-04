import {lstatSync, readFileSync, realpathSync} from 'node:fs';
import path from 'node:path';

export function publicWriteOutcome(value) {
  if (!value || !['not_started', 'unknown', 'observed'].includes(value.status) || value.automaticRetry !== false) return undefined;
  return {status:value.status, automaticRetry:false};
}

export function mergeWriteOutcomes(...values) {
  const outcomes = values.map(publicWriteOutcome).filter(Boolean);
  for (const status of ['unknown', 'observed', 'not_started']) if (outcomes.some(value => value.status === status)) return {status, automaticRetry:false};
  return undefined;
}

// Inspect only our fixed operation layout. Never scan arbitrary artifact paths.
// The intent is written before issuing a command; a crash leaves its outcome unknown.
export function persistedWriteOutcome(directory) {
  let root;try { root = realpathSync(directory); } catch { return undefined; }
  const read = (relative, max) => {
    try {
      const file = path.join(root, relative), info = lstatSync(file), actual = realpathSync(file), rel = path.relative(root, actual);
      if (info.isSymbolicLink() || !info.isFile() || info.size > max || rel === '..' || rel.startsWith('..'+path.sep) || path.isAbsolute(rel)) return null;
      return JSON.parse(readFileSync(actual, 'utf8'));
    } catch { return null; }
  };
  let observed = false, notStarted = false;
  const locations = ['', 'execution', 'workflow', ...Array.from({length:5}, (_, index) => 'workflow/sample-'+(index+1))];
  for (const location of locations) {
    const result = publicWriteOutcome(read(path.join(location, 'result.json'), 262144)?.writeOutcome);
    const intent = read(path.join(location, 'write-intent.json'), 4096);
    if (result?.status === 'unknown' || intent?.effect === 'write' && intent.status === 'unknown' && intent.automaticRetry === false && result?.status !== 'observed') return {status:'unknown', automaticRetry:false};
    observed ||= result?.status === 'observed';
    notStarted ||= result?.status === 'not_started';
  }
  return observed ? {status:'observed', automaticRetry:false} : notStarted ? {status:'not_started', automaticRetry:false} : undefined;
}
