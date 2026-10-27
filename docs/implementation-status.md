# 实现与验收记录

> 本页为 Web 开发阶段的历史验收记录。当前公开树缺少根 package.json 引用的 7 个测试脚本，不能据此认定整仓回归已通过；本次 APK/MCP 的独立验收见 [验收记录](apk-mcp-verification.md)，当前使用入口见 [项目首页](../README.md)。

日期：2026-10-19。仓库基线 `6b1cf55`，本地分支 `codex/readme-review`。修复位于当前未提交工作树；没有推送或 PR。基线审计保留在 [project-review.md](project-review.md)，独立验收复现与结论见 `acceptance-review.md`（历史文档，未随公开基线提供），接手任务见 `next-agent-prompt.md`（历史文档，未随公开基线提供）。

## 第三轮结果（验收修复 F1/F2/F3）

针对 `acceptance-review.md`（历史文档，未随公开基线提供） 复现的三个问题修复；每个回归都先在临时还原的旧逻辑上复现失败、再在修复后通过：

1. **F2/P1 双面板任务所有权**：worker 启动时经 `BFS_OWNER` 环境变量携带每 worker 随机令牌，`store.js` 在取得 `.run.lock` 时把 `{owner,pid}` 写入锁文件；面板 `launch` 后以 50ms 握手轮询确认"锁内 owner+PID 属于本 worker"才视为持锁。`stop` 只在持锁确认后写 STOP；启动期请求停止改为延迟语义——本 worker 拿到锁后立即落 STOP 并干净保存（单面板启动期停止行为保留），永远不写其他实例持有的任务。`stopTimer` 同样加持锁门；shutdown 走同一路径，未持锁 worker 由自身锁失败退出或超时 kill，只影响自己。新 W8 回归：A 不限续跑持锁后，B 面板 resume+立即 stop → B 不写 STOP、A 跑完 56 态 `completed/frontier_exhausted`、`attempts` 保持 2、配置保持 A 的 unlimited；随后单面板启动期立即 stop → `partial/STOP`。说明：启动期 stop 的 API 返回 202（延迟生效），不是验收记录猜测文案中的 409——语义是"取消自己的 worker"，而不是"拒绝请求"； refusal（409）只发生在该面板没有活动 worker 时。
2. **F3/P1 开放 Shadow DOM 排除绕过**：`formfill.js` 新增 `crossHostExcluded`（沿 `getRootNode().host` 走祖先链，评估失败按排除处理），`prepareForm` 的字段/select 循环与 `pickOpenOption` 全部换用，并在填写/选择前执行与 `checkLiveAction` 同标准的 live policy（写词字段、excluded 字段一律不填）。夹具 `/form` 增加开放 shadow host `#protected-host`（内含 `#protected`），T06 用例断言：发现清单记 `skipped/excluded_selector`、即使 `formValues` 指定该值，提交体仍为 `{"protected":""}`、值不出现；普通允许字段与下拉不受影响。
3. **F1/P2 报告失败伪 completed**：`writeReport` 失败（如 report.html 为目录 EISDIR）时：结构化 `export_error(stage=report)` 落盘；原 `completed` 降级为 `partial/report_export_failed` 并重写 private/public run.json、manifest.json、tree.json（再次尝试 writeReport 刷新可写的数据文件）；公开 events.jsonl 追加 `result_adjusted` 校正事件；原本已 failed/partial 的保留原 stopReason 只附导出错误。面板报告链接改用 `statSync().isFile()` 判定，目录态不再展示无效链接。新 F1 回归覆盖三类导出失败：report.html 目录（降级+manifest/tree 统一+锁释放+删除目录后 resume `completed` 且报告真实可读）、traffic.har 双目录（`har_export_failed`，private/redacted 各一条错误）、apis.json 目录（`evidence_export_failed`）。

探针 `output-review/acceptance-probe.mjs` 复跑结果：F1 `partial/report_export_failed`+manifest partial+锁释放；F2 `stopFileWritten:false`、锁 PID 前后一致、A `completed` 56 态、attempts 2；F3 提交体 `{"protected":""}`、发现项 `skipped/excluded_selector`。为覆盖"修复后 A 完整跑完"的场景，把探针 finalA/finalB 的等待从默认 30s 放宽到 240s（探针位于忽略目录，仅验证工具维护）。

## 第三轮本机实际验证

| 检查 | 结果 |
| --- | --- |
| urlshape + paper 单元 | 14 + 40 PASS / 0 FAIL |
| 路由 + API/browser 集成 | 18 + 217 PASS / 0 FAIL |
| Python 回归 | 0 FAIL |
| 资产工作流 E2E | 36 PASS / 0 FAIL（新增 F1 导出失败；T06 扩展 shadow 排除断言） |
| 网页面板 E2E | 9 PASS / 0 FAIL（新增 W8 所有权） |
| 独立验收探针 | F1/F2/F3 全部符合预期 |
| 缺陷复现对照 | 三项回归在临时还原的旧逻辑上分别复现伪 completed / B 误停 A / 排除值被提交 |
| npm audit --omit=dev / git diff --check | 0 vulnerabilities / 通过 |

仍受限：Linux/Node 22 CI 未实际运行；启动期延迟停止依赖 worker 最终拿到锁（永远拿不到锁的 worker 由自身退出/超时 kill 收尾）；`crossHostExcluded` 不覆盖 closed shadow（仍为记录的缺口）；报告降级依赖 manifest/tree 所在目录仍可写，输出根整体不可写时以 run.json 为准。

## 第二轮结果（配置合同与并发互斥）

在第一轮工作树上继续，全部改动保持未提交：

1. **配置合同**：`blockAssets`、`consentFallback` 与 `trafficIncludePattern/trafficExcludeExt/trafficExcludeHost/trafficStripQueryParams/trafficKeepQueryParams` 七个字段此前被 `normalizeConfig` 接受但新链路无人消费。现已正式退役：各自打印专属迁移说明（证据范围归 origin 请求策略与体量预算，同意弹窗只受 `autoAgreeConsent` 控制）并从配置中删除；`src/traffic.js` 的独立离线脚本用法不受影响。新增 A2 用例断言"接受但忽略"不再存在。
2. **面板并发互斥（先锁后写）**：面板 resume 不再在 worker 拿到 run 锁前改写 `private/config.json`、也不再预清 STOP。续跑预算改为固定 CLI argv（`--limit-mode/--max-*`）传入，worker 拿到运行锁后由 `openStore` 写权威快照。新任务仍走 `--config`，但权威快照同样由锁内写入。新增 W7 回归：第二面板对运行中任务 resume/stop，其 worker 因 run 锁退出、stop 返回 409、配置与预算保持先锁方（maxStates=3）不变。
3. **finalize 结构化失败**：HAR 双导出、`evidence.export()`、`writeReport` 任一失败不再让 run 卡在 `running`：对应 `export_error` 事件落盘；`completed` 降级为 `partial/stopReason=export_failed`；外层 finally 兜底把未能收尾的 run 写成 `failed/finalize_failed`，锁与浏览器资源照常释放。
4. **账本动作溯源**：`observeApi` 样本新增 `actionId`（来源归一仍为 page/control），接口样本可直接关联回触发动作；事件 JSONL 仍保留完整 request/response 配对。api-surface 新增 3 条断言。
5. **表单 helper 收敛**：`prepareForm` 现在优先使用 `formValues` 显式测试数据（与 fillText 点击路径一致），再落启发式；`pickOpenOption` 先常规可交互点击、失败才 `force` 兜底。新增夹具 `/form`（含 select/自定义下拉/排除字段/白名单端点）与 T06 表单用例：formValues 值、排除字段留空、启发式邮箱、代表性 select、下拉选中、仅白名单端点被请求、无登出/删除副作用；并断言 forms 状态不盲放（`unsafe_replay_requires_manual_state`）→ partial 合同。
6. **夹具与测试修复**：`asset-server.mjs` 的 `text/html` 现在带 `charset=utf-8`（此前 Chromium 回退 windows-1252，中文标签成 mojibake，`isFormAction`/词表全部失配——这是接手前就存在的夹具缺陷）。api-surface 的 gating harness 现在挂与生产一致的 `createPolicy`（forms 白名单链路），「购买」由 WRITE_RE 真实闸门挡下；该失败在接手树上即存在（根因是重构丢失旧 config.json 的支付类词表且 harness 无 policy），非本轮回归。

## 第二轮本机实际验证

环境同第一轮：Windows、Node 20.20.2、Playwright 1.62.1、Chromium 151.0.7922.34、Python 3.12.10。

| 检查 | 结果 |
| --- | --- |
| urlshape 单元 | 14 PASS / 0 FAIL |
| paper scripts 单元 | 40 PASS / 0 FAIL |
| 路由集成 | 18 PASS / 0 FAIL |
| API/browser 回归 | 217 PASS / 0 FAIL（含新增 actionId×3、修复 gating×1） |
| Python 回归 | 0 FAIL |
| 资产工作流 E2E | 35 PASS / 0 FAIL（含新增 A2、T06 forms） |
| 网页面板 E2E | 8 PASS / 0 FAIL（含新增 W7 双面板互斥） |
| npm audit | 0 vulnerabilities |
| git diff --check | 通过 |

仍受限：Linux/Node 22 CI 未实际运行；表单 helper 未覆盖 closed shadow/跨 frame 下拉；finalize 兜底在磁盘整体写不进时最多尽力而为；账本 sources 归一仍不携带 frame 级细节（靠样本 evidenceId/actionId 关联事件补偿）。

## 本轮结果（第一轮）

已实现单 URL 入口、统一请求/动作守卫、匿名及可验证会话、严格有限预算、显式不限预算、可恢复状态/证据、通用报告，以及本地可操作网页。

网页支持默认上限、自定义六项滑块/数字、直到跑完、开始、停止保存、续跑、历史任务、进度/日志/报告。不限模式同时取消状态、深度、时长、请求、动作、单主机状态上限，JSON 使用 null；保留操作超时、采样与资源、安全范围策略。

新增修复包含：同 hostname 不同端口外部资源 Cookie 泄漏、429 Retry-After 在下一请求前生效、可见 Chromium 最后空白页关闭导致退出、sitemap XML loc 读取、查询参数样本脱敏、截断日志续写分隔。

## 本机实际验证

环境：Windows、Node 20.20.2、Playwright 1.62.1、Chromium 151.0.7922.34、Python 3.12.10。测试全部使用本地夹具，没有对公网业务目标探索。

| 检查 | 结果 |
| --- | --- |
| URL shape 单元 | 14 PASS / 0 FAIL |
| paper scripts 单元 | 40 PASS / 0 FAIL |
| 路由集成 | 18 PASS / 0 FAIL |
| API/browser 回归 | 214 PASS / 0 FAIL |
| Python 回归 | 14 场景通过 / 0 FAIL |
| 资产工作流 E2E | 33 PASS / 0 FAIL |
| 网页面板 E2E | 7 PASS / 0 FAIL |
| doctor | Node、Chromium、输出目录通过 |
| npm audit | 0 vulnerabilities |
| git diff --check | 通过 |

最后 E2E 目录：`C:\Users\<redacted-user>\AppData\Local\Temp\bfs-acceptance-B3En7z`、`C:\Users\<redacted-user>\AppData\Local\Temp\bfs-panel-ik14h9`。网页截图在后者；不提交实际运行产物。

已配置 Windows/Linux × Node 20/22 CI；Linux 和 Node 22 尚未在本机实际运行，不能视为已验收。Linux 可见登录测试使用 Xvfb。

## T01–T18 验收映射

| 项目 | 本轮证明 | 仍受限内容 |
| --- | --- | --- |
| T01 | 单匿名 URL 得到报告和结构化结果 | 非 Web URL 类型需适配器 |
| T02 | 缺失会话、登录壳、localStorage、probe、手动成功/超时/失效 | 通用 SSO 自动化与真实账号未测 |
| T03–T04 | 外域 href/JS/popup/redirect/XHR/worker、Cookie/Authorization 隔离、logout 零服务端请求 | 仅 Chromium 守卫；跨引擎未支持 |
| T05 | confirm/prompt 拒绝、危险/未知动作跳过 | 业务副作用不能仅凭词表判定 |
| T06 | selector 发现、live action、重放、JS fallback 复核 | 特殊表单 bulk helper 需进一步验证 |
| T07 | 20 控件夹具严格最多 12 态 | 同条件大站性能未测 |
| T08 | 请求/时长预算、STOP 续跑、429 等待、浏览器异常关闭 | 被强制杀进程/系统断电仍按恢复策略处理 |
| T09 | target/scope/auth/policy 不兼容在导航前拒绝 | 多面板并发控制入口需加专项回归 |
| T10–T11 | 放宽深度/状态重建队列、历史账本/事件保留、唯一 ID、原子恢复 | 大规模断点优化与 schema 升级策略 |
| T12 | hash、tab、关键数字与噪声指纹 | 站点需自定义噪声规则 |
| T13 | 真实 runner iframe/open shadow/hover/virtual scroll | closed shadow/canvas/全部控件组合未覆盖 |
| T14 | 观察/静态分类、重复/空参数、成组样本、GraphQL | API 模板展示与细粒度来源继续改善 |
| T15 | 同长度响应 digest、晚到事件、metadata-only、大正文、流式 HAR、损坏行保留有效记录 | Playwright 解码缓冲/全局图内存非硬上限 |
| T16 | 恶意 HTML 无执行/外联、目录保护、header/body/query 默认脱敏 | 截图和未知业务字段分享前仍需检查 |
| T17 | partial/pending/failed 原因与动作状态真实展示 | 更多站点失败与恢复样例 |
| T18 | Windows Node 20 全部本地回归、doctor、Node 20 JS 面板 | Linux/Node 22 CI 待实际运行 |

## 网页验收

已通过默认值、滑块/数字同步、移动布局无横向溢出、自定义 2 态上限 → 不限续跑到 4 态、56 态超过默认上限、深度 6 超过默认深度、不限 STOP/刷新/续跑，以及 origin/token/参数白名单/私有文件保护。

## 交接重点

本轮新增功能已可运行。下一轮优先收敛真实大站稳定性、配置合同与证据来源，不应再以增加接口数量代替结果可信度。具体可执行工作与禁止破坏的回归见 `next-agent-prompt.md`（历史文档，未随公开基线提供）。
