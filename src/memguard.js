// memguard.js — 系统内存压力守护（crawl4ai memory-threshold dispatcher 同源思路）
// 采样点=主循环状态边界：系统内存占用超 memPausePercent（缺省 0=关）→ 暂停派发新状态，
// 等待回落（10s 步进，响应 STOP 哨兵）。防的是多标签+多会话并行把整机推到 OOM 边缘——
// 爬得慢一点，机器和其他会话不受损（兼顾性能与效率的用户裁定语义）。
import os from 'node:os';

export function sysMemPercent() {
  try {
    const total = os.totalmem();
    const free = os.freemem();
    if (!total) return 0;
    return Math.round(((total - free) / total) * 100);
  } catch { return 0; }
}

/**
 * 内存压力等待：超阈值则每 10s 复查（checkStop 透传保 STOP 响应）。
 * @returns {{paused: boolean, peak: number}} 是否发生过暂停 + 峰值占用
 */
export async function memGuardWait(config, log, checkStop) {
  const threshold = Number(config.memPausePercent ?? process.env.BFS_MEM_PAUSE ?? 0);
  if (!(threshold > 0 && threshold < 100)) return { paused: false, peak: 0 };
  let cur = sysMemPercent();
  if (cur <= threshold) return { paused: false, peak: cur };
  let peak = cur;
  let n = 0;
  while (cur > threshold) {
    n++;
    if (n === 1 || n % 6 === 0) log(`[内存守护] 系统内存 ${cur}% > 阈值 ${threshold}%，暂停派发新状态（第 ${n} 次复查，10s 步进）`);
    await new Promise((r) => setTimeout(r, 10000));
    if (checkStop && checkStop('内存守护等待期')) return { paused: true, peak: Math.max(peak, cur) };
    cur = sysMemPercent();
    peak = Math.max(peak, cur);
  }
  log(`[内存守护] 回落到 ${cur}% ≤ ${threshold}%，恢复派发（共暂停 ${n * 10}s，峰值 ${peak}%）`);
  return { paused: true, peak };
}
