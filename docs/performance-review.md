# bfs-clicker 性能检查与提速建议

> 本文保留初始审计基线。后续已实施优化与回归，最新结果见 [性能优化记录](performance-implementation.md)。

检查日期：2026-10-27。版本：[f085111](https://github.com/8eeth0ven/bfs-clicker/commit/f085111e2f1f353e77a8f6ad8f2b7040f36232f1)。生产代码未修改；本次交付代码审计、本机测量及优化顺序。

远端 main 已重写历史。本地旧 main 为 `6b1cf55`，与新远端各有 73/2 个独有提交，不适合直接 pull 合并。已 fetch 最新版本，在独立性能审查工作区的 `codex/performance-review` 分支检查，原桌面目录保持原样。

## 结论

最应优先优化：重复稳定等待、每动作从入口重放、全图断点同步保存。请求间隔能直接提高请求放行速率；截图在本次小页面基准中不是主要瓶颈。`maxTabs` 只是弹窗/目标数量上限，不是并发探索数。当前也不能沿用旧版 pool、simhash、资产屏蔽等提速开关。

**快速等待虽然使同步页面约快 1.97 倍，但延迟渲染夹具出现漏状态，不能作为所有站点的默认配置。** 应优化等待机制与重复工作，并用相同覆盖结果比较速度。

## 本机实测

环境：macOS arm64、Node v26.8.1、Playwright 1.64.1（本次 npm ci 实际安装版本）、Chromium 156.0.8078.4。所有爬取仅访问绑定 `127.0.0.1` 的夹具。请求/动作安全守卫保持开启。

### 页面遍历

夹具：入口 → 3 个分组 → 各 1 个详情，详情返回入口；共 7 个唯一状态、9 个有效动作。每配置运行两次，第二轮反转顺序，浏览器/字体先预热。下表用总状态数除总墙钟耗时，包含浏览器启动、报告导出和关闭。样本较小，适合定位机制，不能外推真实站点倍数。

| 配置 | 两次耗时 | 平均耗时 | 唯一状态/秒 | 与基线比较 |
| --- | --- | --- | --- | --- |
| 默认：quiet/settle=80ms，timeout=1500ms，PNG | 9.46 / 8.47 秒 | 8.97 秒 | 0.781 | 基线 |
| 只关闭截图 | 9.08 / 8.56 秒 | 8.82 秒 | 0.794 | 约 +1.7%，小于本机波动，未证明稳定提速 |
| 只调等待：quiet/settle=20ms，timeout=500ms | 4.52 / 4.58 秒 | 4.55 秒 | 1.539 | 约 1.97 倍，仅此同步夹具 |
| 只调 maxTabs=4 | 8.59 / 9.42 秒 | 9.00 秒 | 0.777 | 未提速，代码也没有新增 worker |

所有配置均完成 7 状态、9 个有效动作、28 个服务端收到的请求。预算计数却是 **18 次动作，其中 9 次为祖先路径重放**；每轮另有 10 次显式 page.goto。ledger 的条目包含文档和静态候选，不能把其 13 条记录称为 13 个业务 API。

基线每轮 7 张截图只占约 127–237ms。图片复杂度更高时截图可能更贵，但不能把截图体积减少直接当作吞吐增加。

### 延迟渲染反例

同一页面点击“展开详情”，120ms 后通过 setTimeout 插入详情链接，期间没有网络请求。两配置各重复两次：

| 配置 | 每次发现状态 | 是否到达 /detail | 任务状态 |
| --- | --- | --- | --- |
| 默认等待 | 3 | 是，两次均到达 | completed |
| 上述快速等待 | 1 | 否，两次均遗漏 | completed |

`completed/frontier_exhausted` 表示当前观察规则下队列耗尽，不能用来证明提速前后覆盖相同。网络空闲也无法识别尚未触发的定时渲染。默认等待同样不能保证覆盖任意更长的延迟。

### 请求放行速率

真实 Chromium、完整生产守卫、同一 localhost 主机同时发出 40 个 GET API 请求。各运行两次，40 个请求均到达。速率以服务端首末请求到达间的 39 个间隔计算，包含 HTTP/CDP 路径，未包含浏览器启动。

| requestDelayMs | 40 请求首末跨度 | 到达间隔速率 | 整轮耗时 |
| --- | --- | --- | --- |
| 50（默认） | 1.954 / 1.952 秒 | 约 20 次/秒 | 3.22 / 2.81 秒 |
| 20 | 0.784 / 0.779 秒 | 约 50 次/秒 | 1.62 / 1.69 秒 |
| 10 | 0.390 / 0.379 秒 | 约 100–103 次/秒 | 1.26 / 1.57 秒 |

50→10ms 在这个批次中提高请求放行速率约 5 倍，整轮平均仅约快 2.13 倍。它不意味着整站发现吞吐提高 5 倍，也不代表真实服务端可以承受相同速率。槽位按 `URL.host` 分组，HTML、脚本、图片、字体和 API 共用；不是全站并发连接数限制。

### 规模化保存成本

调用真实 `store.save()`，合成每状态 50 个动作，不含 API ledger；每规模预热后测三次。私有/公开 checkpoint 均写入并保留 previous 备份。

| 状态数 | 私有+公开新文件大小 | 单次保存耗时 |
| --- | --- | --- |
| 100 | 约 2.64 MB | 41–52ms |
| 500 | 约 13.21 MB | 167–191ms |
| 1000 | 约 26.41 MB | 336–683ms |

一次动作前后至少保存两次，新状态和展开结束还会额外保存。1000 状态规模仅这两次同步保存就可能占约 0.67–1.37 秒。此为合成数据的局部成本，受本机负载影响，不能直接推算真实整站提升倍数。

## 优化清单

P1/P2/P3 表示建议实施顺序，不是漏洞等级。

| 优先级 | 项目与代码证据 | 建议改法 | 可改善的指标及边界 |
| --- | --- | --- | --- |
| P1 | 多层重复等待：runner.js:55,78,112,113；replay.js:48；dialogs.js:45–53 | 导航/动作边界统一等待；同一次稳定快照供后续使用；加入有界 DOM/控件稳定检测 | states/s、有效动作/s；保留延迟渲染覆盖 |
| P1 | 每动作回根并重放：runner.js:108–115,225 | 当前页仍匹配父指纹时复用；验证后缓存可重放状态；显式纯导航 fast path | 减少请求、重放动作与深度放大；URL 相同不能代表状态相同 |
| P1 | 全图保存：runner.js:40–47,106,225,239,248；store.js:16–23,95 | 追加动作日志 + 周期合并快照；公开结果降低发布频率；只写脏数据 | 大任务 states/s、事件循环延迟；保留原子恢复与中断语义 |
| P1 | 测试未交付：package.json:26–30 | 补回本地夹具、7 个测试脚本与 CI，再验收核心重构 | 避免 scope、会话、证据归因、恢复及覆盖回归 |
| P2 | 所有正文共用池：evidence.js:40–44,65–93 | 图片/字体等优先仅元数据；HTML/JS/API 优先；跟踪超时后仍未完成的底层读取 | API 正文捕获率、内存、采集速度；二进制归档需要单独模式 |
| P2 | short 无视更小超时：dialogs.js:47 | `short ? Math.min(400, settings.timeoutMs) : settings.timeoutMs` | 深链等待；配置 timeout=100ms 时当前 short 实测约 411ms |
| P2 | 每动作多次指纹扫描：runner.js:78,114,228；state.js:7–24 | 在最终稳定边界合并快照，批量采集每 frame 的控件/指纹/滚动信息 | 大 DOM、多 frame 的 CPU/IPC 时间；不能提前复用未稳定指纹 |
| P2 | API ledger 按完整 URL 增长：cdpnet.js:28–36,93–104；evidence.js:34–35 | 原始 URL 留证；额外建立模板索引，对参数值和来源设帽 | 唯一接口发现效率、内存/保存耗时；避免误合并权限与 ID 差异 |
| P2 | 种子只在 UI 队列耗尽后访问：runner.js:195,212–215 | 手工种子优先；UI 与静态种子按比例公平调度 | 固定预算内路由/API 覆盖、首次发现时延；未量化倍数 |
| P2 | 强制认证探针：runner.js:56–59,228；auth.js:11–26 | 每动作保留廉价失效检查；昂贵 probe 有时效缓存，异常时强制复验 | probe 慢的站点动作/s；不能以关闭认证检查换取虚高数据 |
| P3 | 同步细日志与多遍导出：store.js:88–91；runner.js:135–143 | 有界写缓冲并显式 flush；一次读取同时生成 HAR/requests | Node 响应性、收尾耗时；不是直接提高页面覆盖 |
| P3 | 面板全历史轮询：view/app.js:93–97,125；control.js:94–109,191 | 分页、终态元数据缓存、活跃任务增量更新 | 大历史列表响应；1000 合成任务单次轮询中位 71ms，非首要爬行瓶颈 |

### 请求守卫与缓存

`browser.js:39` 的 CDP Fetch 请求/响应守卫，与 `:135–140` 的 Playwright `context.route('**/*')` 同时存在。Playwright route 会禁用 HTTP 缓存，官方文档明确记录此行为：[BrowserContext.route](https://playwright.dev/docs/api/class-browsercontext#browser-context-route)。因此每动作重复回根还会放大资源重取成本；没有对“去掉 route 后恢复缓存”的方案做 A/B。

优先减少根导航与重复资源处理。移除任一守卫或恢复缓存前，需要验证首包、popup、redirect、OOPIF、worker、跨 origin 凭证处理。不能直接删除安全守卫作为优化方案；单纯移除 Playwright route 也不保证 CDP Fetch 下的缓存行为符合预期。

### 正文池的两个实际问题

离线模拟响应驱动真实 `createEvidence`：`captureTraffic:false` 时 20 张小图仍调用 20 次 body；配置并发 2、正文超时 10ms、底层读取耗时 100ms 时，实际出现 8 个未完成读取。`Promise.race` 超时释放逻辑槽，但没有取消底层 body promise。先修正文分类与未完成任务追踪，再考虑提高 `maxBodyConcurrency`，否则可能增加内存压力。

未知 Content-Length 的响应当前只记元数据，不读正文。这个选择保护内存，但会影响 JS/JSON 静态端点挖掘覆盖；增大 harvest 配额并不能解决未知长度问题。

## 现有参数怎样使用

1. **请求速率**：先对目标比较 `--request-delay 50` 与 `--request-delay 20`，再按成功请求、429/错误率和有效 API 发现考虑 10ms。保留预算和 Retry-After。默认不建议直接设 0。
2. **截图**：不需要视觉证据时用 `--no-screenshots`；需要截图时可在 JSON 中设 `shotFormat: "jpeg", shotQuality: 55`。此次无截图未证明稳定吞吐收益，JPEG 未做本次 A/B。
3. **等待**：保持当前默认作为覆盖基线；20/20/500 配置只适用于已验证的快速同步页面。不要全局批量替换默认值。
4. **并发**：`maxTabs=4` 无提速功能。单目标真正并发需拆分 page/action runtime，并协调 visited、预算、cookie/localStorage 与 token 轮换；不能对动作循环直接 Promise.all。独立目标、独立会话、独立输出可另做多进程调度。
5. **覆盖范围**：缩小 maxDepth、maxFrames、maxInteractives，关闭 hover/scroll 或排除控件会减少工作，也会缩小覆盖；不能称作同等覆盖的提速。
6. **发现开关**：seedRoutes/discoverySeeds/seedFiles 针对覆盖，受当前种子调度限制。`jsEndpointHarvest:false` 只关闭补充提取，不关闭基础静态扫描；`captureTraffic:false` 只关闭 traffic 写入，不关闭正文处理；`harCapture:false` 主要省收尾导出。

新 CLI 调整请求间隔示例（地址为占位，需替换）：

```sh
npm run run -- --asset https://console.example.com/ --request-delay 20
```

旧 `rootPoolSize`、`overviewBatchSize`、`urlShapeDedup`、`pageSimDedup`、`perfFlags`、`blockAssets` 已在 asset.js:45–52,110–111 退役。旧 `BFS_BLOCK_ASSETS/BFS_PAGE_SIM/BFS_PERF_FLAGS` 无消费；部分仍存在的 env 只在 legacy loadConfig 路径生效。`run --asset` 应使用支持的 CLI 参数或 JSON。

## 验证状态与复查

- `npm ci` 成功，doctor 的 Node、Chromium、输出目录检查通过。
- `npm test` 在第一项 `scripts/test-urlshape.mjs` 报 MODULE_NOT_FOUND；仓库没有交付 package.json 引用的七个测试脚本，也没有 `.github/workflows`。文档中的历史 PASS 数不能代替本次版本回归。
- 同步页面 8 次、延迟渲染 4 次、真实 HTTP 请求批次 6 次，均完成并记录原始结果；另有稳定等待、正文管线、checkpoint、面板微基准。
- 未验证公网业务站点、短 TTL 会话或优化代码后的效果；本次未修改生产实现，也没有提交/推送。

本机产物位于工作区 `output-performance-review/`（Git 忽略目录，未发布）：

| 产物 | 用途 |
| --- | --- |
| benchmark.mjs / benchmark-results.json | 7 状态端到端配置对照与请求槽位微基准 |
| delayed-probe.mjs / delayed-results.json | 120ms 延迟渲染覆盖反例 |
| burst-probe.mjs / burst-results.json | 40 次真实本机 GET 到达速率 |
| traversal-probe.mjs / traversal-probe.json | d+4 次稳定等待、short 超时 |
| traffic-microbench.mjs / traffic-microbench-results.json | 正文池、URL 账本与全量保存 |
| panel-benchmark.mjs / panel-benchmark.json | 合成历史任务的面板轮询 |
| traversal-audit.md / traffic-audit.md / workflow-audit.md | 三个方向的完整代码证据 |

从工作区运行 `node output-performance-review/<上述脚本>.mjs` 可分别复查，不要同时运行浏览器基准。文件系统插桩中的 writeFileSync 可能包含 appendFileSync 的内部调用，相关耗时不能简单相加；本报告没有据此计算总 I/O 占比。

后续实施顺序：补齐回归交付 → 合并重复等待与快照 → 减少回根重放 → 增量持久化 → 正文分级与种子公平调度 → 经隔离设计的真正并发。验收同时观察唯一状态/秒、非重放动作/秒、observed API/秒、覆盖集合、正文缺失率与峰值内存。
