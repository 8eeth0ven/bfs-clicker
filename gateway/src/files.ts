import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GatewayError } from './types.js';

export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export async function checkedPath(target: string, roots: string[]): Promise<string> {
  let resolved: string;
  try { resolved = await realpath(target); }
  catch { throw new GatewayError('MANIFEST_PATH_BLOCKED', '清单路径不可访问'); }
  const canonicalRoots = await Promise.all(roots.map(async root => {
    try { return await realpath(root); } catch { return path.resolve(root); }
  }));
  if (!canonicalRoots.some(root => within(root, resolved))) throw new GatewayError('MANIFEST_PATH_BLOCKED', '清单路径不在允许目录内');
  return resolved;
}
export async function readJsonLimited(filename: string, maximum = 32 * 1024 * 1024): Promise<any> {
  return (await readJsonWithDigest(filename,maximum)).data;
}
export async function readJsonWithDigest(filename:string,maximum=32*1024*1024):Promise<{data:any;sha256:string}> {
  let handle;
  try {
    handle = await open(filename, 'r');
    const s = await handle.stat();
    if (!s.isFile() || s.size > maximum) throw new GatewayError('MANIFEST_INVALID', '清单必须是预算内的普通文件');
    const chunks: Buffer[] = []; let size = 0;
    const stream = handle.createReadStream({ autoClose: false });
    for await (const data of stream) {
      size += data.length;
      if (size > maximum) { stream.destroy(); throw new GatewayError('MANIFEST_INVALID', '清单超过读取预算'); }
      chunks.push(Buffer.from(data));
    }
    const bytes=Buffer.concat(chunks);
    return {data:JSON.parse(bytes.toString('utf8')),sha256:createHash('sha256').update(bytes).digest('hex')};
  } catch (e) {
    if (e instanceof GatewayError) throw e;
    throw new GatewayError('MANIFEST_INVALID', '无法读取有效 JSON 清单');
  } finally { await handle?.close(); }
}
export async function isDirectory(filename: string): Promise<boolean> {
  try { return (await stat(filename)).isDirectory(); }
  catch { throw new GatewayError('MANIFEST_PATH_BLOCKED', '清单路径不可访问'); }
}
