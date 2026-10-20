// [bfs优化] 工程单(goto 挂死 20261012)：route 处理器级超时兜底
// 判例(NOTES 2026-10-12 a target site staging)：长跑 13 states 后所有 page.goto 挂死
// (domcontentloaded 永不触发,45s/120s 预算全烧),RESUME 新浏览器进程首个导航即挂;
// 三连判决排除站点限流/指纹封锁/会话污染 → 病灶在爬虫自身上下文(route 处理器族疑)。
// Playwright 语义: ctx.route/page.route 的 handler 一旦永不完成(内部 await 挂起/route API
// 停滞),该请求永久 pending;若是 document 请求,page.goto 整体挂死烧满预算。
// 本模块包装任意 route handler: 超时未完成 → route.abort 放行导航栈 + 打日志(禁静默吞)。
// 用法: ctx.route(pattern, withRouteTimeout(handler, { timeoutMs, label, log }))
//   timeoutMs<=0 = 关闭(返回原 handler,零行为变化);缺省 10000(config.routeHandlerTimeoutMs
//   / BFS_ROUTE_TIMEOUT env 可调)。handler 正常完成毫秒级,10s 兜底绝不会误伤快速 handler。

export function withRouteTimeout(handler, opts = {}) {
  const raw = opts.timeoutMs === undefined ? 10000 : Number(opts.timeoutMs);
  const label = opts.label || 'route';
  const log = opts.log;
  if (!Number.isFinite(raw) || raw <= 0) return handler; // 关闭=原 handler 原语义
  return async (route, ...rest) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      let url = '(url 不可读)';
      try { url = route.request().url(); } catch { /* 上下文已关等 */ }
      log && log(`  [route-guard] ${label} 处理器 ${raw}ms 未完成 → abort 放行导航: ${String(url).slice(0, 140)}`);
      route.abort().catch(() => {}); // 已被 handler 处理/上下文已关 → 拒绝即静默
    }, raw);
    try {
      await handler(route, ...rest);
    } catch (e) {
      // handler 自身异常: ①若抛出前已 continue/abort 过(如兜底 abort 后再调 continue 被拒),
      // 本 cleanup abort 同样被拒→静默;②若抛出前未处理 route,本 cleanup abort 把请求从
      // 永久 pending 里捞出来(否则=goto 挂死同症状,单测 A5 实证)。留痕不向上抛。
      log && log(`  [route-guard] ${label} 处理器异常(abort 兜底已发): ${String((e && e.message) || e).slice(0, 100)}`);
      route.abort().catch(() => {});
    } finally {
      settled = true;
      clearTimeout(timer);
    }
  };
}
