# 已观察流程与调用图：开源方案调研

核查日期：2026-10-27（Asia/Shanghai）。调研对象是本次工作区的 bfs-clicker：Playwright真实动作、语义状态去重、事件日志、HTTP证据、断点与本地面板。本文通过在线浏览官方仓库、许可证和文档核查；没有安装或运行这些候选项目，没有把文档能力写成本项目实测结果。分支中的版本号用于识别所读源码，不能当作最新稳定发行版。

推荐保留现有探索器，借鉴 **Crawljax的有向多重状态图 + Crawlee的持久任务/资源调度 + Playwright的动作证据时间线 + Cytoscape.js/ELK的分层展示**。Browsertrix适合作为可选录制流程、可中断行为与归档回放参考。首先把现有日志变成诚实、可追溯的图，随后增加独立任务并发和诊断追踪；无需先替换整个执行引擎。

## 五个最值得借鉴的方案

| 方案 | 本次核查的仓库状态与许可证 | 具体可借鉴部分 | 与本项目的差异及推荐方式 |
| --- | --- | --- | --- |
| **1. Crawljax：动态状态图** | [公开仓库](https://github.com/crawljax/crawljax)，`master`；Java core、plugins、examples可读；[CHANGELOG](https://github.com/crawljax/crawljax/blob/master/CHANGELOG.md)顶部为5.1.2，发行入口是Maven，不据此推断最新发布日期。[Apache-2.0](https://github.com/crawljax/crawljax/blob/master/LICENSE)。 | `StateFlowGraph`、`InMemoryStateFlowGraph`、`StateVertex`、`Eventable`；状态节点、动作转移、多重边与最短路径。 | 最贴近自动点击SPA探索。借鉴图模型，继续使用本项目Playwright与已有请求守卫；不为画图引入Java/Selenium执行链。DOM相似度可以辅助分组，不能证明隐藏JS状态等价。 |
| **2. Crawlee / Apify：持久队列与资源调度** | [公开仓库](https://github.com/apify/crawlee)和官方JS API可访问；本次官方API页标注3.18。[Apache-2.0](https://github.com/apify/crawlee/blob/master/LICENSE.md)。 | `RequestQueue`的uniqueKey、handled/reclaim生命周期；`AutoscaledPool`根据CPU、内存、事件循环决定派发；`BrowserPool`管理页面与浏览器生命周期。 | 它主要调度URL抓取，本项目调度“会话中的状态+动作”。不能照搬URL去重或把共享page的动作并行化。先做独立目标/隔离会话的任务调度，再考虑同目标分支worker。 |
| **3. Playwright Trace Viewer：动作/网络证据追踪** | [公开仓库](https://github.com/microsoft/playwright)；GitHub API本次返回`archived:false`；main中的playwright-core为[1.65.0-next](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/package.json)，不是本项目应直接升级的稳定版。[Apache-2.0](https://github.com/microsoft/playwright/blob/main/LICENSE)。 | action时间线、动作前/中/后DOM、locator、network、console；Tracing API支持分组和分块。 | 最适合“点哪一步→当时页面→出现哪些请求”的复查。trace不自动给出后端服务调用图，也不能仅凭时间重叠证明请求由某按钮因果触发。现有JSON证据图作为主产物，trace作为可选细节附件。 |
| **4. Browsertrix Crawler：行为脚本与归档回放** | [公开仓库](https://github.com/webrecorder/browsertrix-crawler) `main`；所读[package.json](https://github.com/webrecorder/browsertrix-crawler/blob/main/package.json)标注1.15.1。[AGPL-3.0-or-later](https://github.com/webrecorder/browsertrix-crawler/blob/main/LICENSE)。 | 可中断的行为步骤、JSON User Flow、站点专属`isMatch`/`awaitPageLoad`、WARC/WACZ输出与回放质量检查。 | 它的目标是高保真Web归档，自动播放/自动取资源等默认行为不适合直接迁入本项目动作策略。优先借鉴步骤合同和回放验收思路；归档器作为可选独立工具，避免直接混拷AGPL实现。 |
| **5. Cytoscape.js + elkjs：图展示与布局** | [Cytoscape.js](https://github.com/cytoscape/cytoscape.js)默认`unstable`，所读包版本为3.35.0-unstable；核心[MIT](https://github.com/cytoscape/cytoscape.js/blob/unstable/LICENSE)。[elkjs](https://github.com/kieler/elkjs) master包为0.13.0，package声明 **EPL-2.0 OR GPL-3.0-or-later**；[LICENSE](https://github.com/kieler/elkjs/blob/master/LICENSE.md)含EPL2正文。[cytoscape-elk适配器](https://github.com/cytoscape/cytoscape.js-elk)为MIT，包2.3.0。 | Cytoscape处理节点/边、选择、过滤、分组及局部展开；ELK layered负责有方向和端口的图布局，可用worker异步计算。 | 两者不会自动生成业务流程或HTTP证据。先定义稳定graph.json，再接渲染层。适配器包依赖elkjs `^0.9.3`，不能假定自动兼容所读0.13；实际引入时选择已验证稳定组合并锁版本。 |

上表“公开可访问/分支和版本”只描述此次读取所得；除明确列出的Playwright API字段外，没有用GitHub动态页缺少归档提示去断言维护活跃度，也没有用star数替代可用性验证。许可证以链接的各项目/模块文件为准，不能把Cytoscape的MIT套用于ELK或Browsertrix。

## 1. 从Crawljax借鉴：状态图应是有向多重图

官方[StateFlowGraph接口](https://github.com/crawljax/crawljax/blob/master/core/src/main/java/com/crawljax/core/state/StateFlowGraph.java)把StateVertex作为节点、Eventable作为边，并提供入边、出边及最短路径；[InMemoryStateFlowGraph](https://github.com/crawljax/crawljax/blob/master/core/src/main/java/com/crawljax/core/state/InMemoryStateFlowGraph.java)使用DirectedPseudograph。这允许两个按钮连接同一对状态，回到已见状态也仍有真实转移，而不局限于首次发现树。

[Eventable](https://github.com/crawljax/crawljax/blob/master/core/src/main/java/com/crawljax/core/state/Eventable.java)保存事件类型、定位信息、相关表单输入和frame；[StateVertex](https://github.com/crawljax/crawljax/blob/master/core/src/main/java/com/crawljax/core/state/StateVertex.java)将候选可点击元素与已经触发的事件区分。

**本项目对接建议：**

- `checkpoint.states`产生状态节点；`action_started/action_finished`产生执行实例；`state`及`state_merged`确定到达的新/旧状态，`backEdges`补足回边。保留同一URL的不同指纹状态，以及相同状态之间不同控件的平行边。
- 动作未改变状态但触发了HTTP请求时，仍记录自环或无状态变化动作；不要因为没有新URL就删除其API调用。
- 界面可以聚合相同控件/同目标的重复执行，但边仍能展开到实际执行次数和evidenceId。最短路径只用于在图中查找**已观察**路径；真实重放仍需live policy、认证和状态指纹复核。
- 本项目的DOM指纹、只读策略和安全重放边界继续有效；不能将Crawljax的“图上可达”直接变成本项目“可安全自动重放”。

## 2. 从Crawlee借鉴：队列项目要表示状态任务，不能只表示URL

官方[RequestQueue](https://crawlee.dev/js/api/core/class/RequestQueue)支持BFS/DFS，默认按URL生成uniqueKey，也允许覆盖。[AutoscaledPool](https://crawlee.dev/js/api/core/class/AutoscaledPool)以CPU、内存和事件循环负载决定新任务派发；[PlaywrightCrawler](https://crawlee.dev/js/api/playwright-crawler/class/PlaywrightCrawler)以每Request新页面作为执行单位。

**本项目对接建议：**使用 `{runId, authProfileId, stateFingerprint, actionKey, replayPolicy}` 构造任务身份，分别记录queued/running/completed/retryable/skipped及原因，保持动作journal与证据日志可恢复。已观察图、待探索frontier和静态候选清单使用不同集合，不用“入队”冒充“执行过”。

并发先放在独立目标或明确隔离的会话：每worker独立page、runtime/action上下文、证据ID命名空间和输出锁，共享的总预算和visited索引需明确同步。资源调度可参考[BrowserPool生命周期hook](https://crawlee.dev/js/api/browser-pool/class/BrowserPool)，但现有CDP守卫必须在首个请求前安装，不能被普通postPageCreate hook的时序替代。

[SessionPool](https://crawlee.dev/js/api/core/class/SessionPool)会轮换用户式会话，这不适合直接套在同一个认证资产流程上：业务身份、权限和token epoch改变后，前后状态不能假装属于同一会话流程。先采用资源反馈机制，保留本项目显式会话身份与请求范围合同。本文没有测量引入AutoscaledPool后的收益。

## 3. 从Playwright借鉴：图边应能跳到动作时间线和原始证据

官方[Trace Viewer](https://playwright.dev/docs/trace-viewer)提供action/locator、DOM快照、network和console，并可按动作时间段过滤请求。[Tracing API](https://playwright.dev/docs/api/class-tracing)支持`group/groupEnd`及`startChunk/stopChunk`；库级context.tracing记录浏览器操作和网络，不包含Playwright Test的断言结果。

**本项目对接建议：**新增显式诊断模式，在一个动作执行实例外包一层trace group，组名包含run/state/occurrence；按时间或文件大小分块落在private目录，graph中的动作保存trace附件引用。常态仍使用轻量事件图；trace的DOM/截图/正文成本单独测量，并保留当前分享结果脱敏边界。不要把完整trace作为公开图JSON直接内联。

“调用图”需要说明层级：

| 图上含义 | 能支持它的证据 | 当前边界 |
| --- | --- | --- |
| 页面/状态 → 动作 → 请求 | 动作执行实例、requestEvidenceId、当前page/control、HTTP响应 | 显式关联强于时间窗；后台轮询和晚到定时器可能只有页面归因 |
| JS脚本 → HTTP请求 | 可选CDP Network initiator及stack | 这是请求发起栈，不是完整JS函数调用图 |
| 后端服务 → 其他服务/数据库 | 服务端instrumentation或分布式trace | 仅浏览器观测不能补造这类边 |

官方[CDP Network协议源](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Network.pdl)在`requestWillBeSent`暴露requestId、loaderId、documentURL、initiator、可选frameId与重定向信息；Script类型的initiator stack为可选字段，当前协议注明需要启用Debugger域。若加此诊断模式，应记录target/session、frame、request、重定向hop和栈，并单独验证开销与跨frame一致性；不为追踪而修改现有请求放行策略。

## 4. 从Browsertrix借鉴：把人工知道的流程变成受策略约束的行为步骤

官方[Browser Behaviors](https://crawler.docs.browsertrix.com/user-guide/behaviors/)支持JSON User Flow以及JS行为，行为可通过async iterator逐步yield状态，使大步骤可被中断。官方的导航/重复步骤语义有自己的扩展，不能不经适配就当作Playwright命令执行。

**本项目对接建议：**将已观察路径或用户提供的录制流程转换为统一step `{kind, selector, framePath, inputRef, precondition, expectedState, safeReplay}`，仍调用本项目click/replay/request守卫。自定义控件或业务前置条件可用显式adapter补足，adapter每步产出同样action occurrence、请求关联和覆盖缺口；未知步骤列为未执行，不静默跳过。

[Outputs](https://crawler.docs.browsertrix.com/user-guide/outputs/)定义归档文件及页面元数据；[Quality Assurance](https://crawler.docs.browsertrix.com/user-guide/qa/)对比归档回放的截图、文本等信息。可借鉴“记录完成”与“回放可验证”分别统计：已观察路径有HTTP证据不等于当前会话仍能再次完成。WACZ回放是归档内容重现，不等于在真实业务服务端重放操作。本轮不引入归档依赖，也不把AGPL源码复制进当前项目。

## 5. 从Cytoscape/ELK借鉴：渲染按证据类型过滤，布局不要拖慢采集

[Cytoscape官方API](https://js.cytoscape.org/)支持JSON元素和多种图操作；其[性能建议](https://js.cytoscape.org/#performance)指出边、多重曲线和标签数量会影响渲染，批量修改能减少重复计算。ELK的[官方说明与worker接口](https://github.com/kieler/elkjs#api)明确它只计算位置，`layout()`异步返回结果；它不负责UI渲染或生成业务语义。

**本项目对接建议：**

- 图数据独立导出`graph.json`，视图提供“流程”“页面→接口”“证据时间线”三个入口。默认只展示已执行状态转移及收到响应的请求；静态候选、被阻断请求、未探索控件通过独立开关显示。
- 状态、动作、请求实例和接口模板采用不同节点类型；可按页面/模块分组。接口模板只用于聚合显示，原始URL/query/GraphQL operation/请求body证据保留在实例层。
- 用ELK layered做初次布局，必要时worker计算。局部展开、边类型过滤、分页加载证据；不要在每次响应到达时全图重新布局。Cytoscape数据批量更新后再启动依赖尺寸的layout，不把layout放在尚未结束的style batch里。
- 保持现有127.0.0.1面板/CSP边界，依赖使用本地固定版本文件；未经测试不把remote CDN脚本加进已脱敏报告。先用现有小图实现也可，图语义与导出合同不依赖某个渲染库。

## 本项目建议的数据合同

以下是结合当前代码提出的设计，并非以上项目已替本项目实现的功能。

| 实体/边 | 唯一身份与关键字段 | 不应推导出的结论 |
| --- | --- | --- |
| 状态 | runId+stateId；url、fp、authEpoch、firstEvidenceId | URL相同不代表状态相同；fp相同也不证明隐藏JS状态完全相同 |
| 控件动作定义 | stateId+actionKey；selector、framePath、kind、status | planned/skipped不表示动作实际触发 |
| 动作执行实例 | `action_started.evidenceId`；actionKey、fromStateId、start/end、outcome、replay标记 | actionKey跨状态或重放会重复，不能独自当执行ID |
| 请求实例 | request事件evidenceId；URL、method、resourceType、source、actionOccurrenceId或unknown | 被guard阻断/失败且status0不表示服务器收到请求 |
| HTTP响应 | response与response_body的关联ID；status、digest、bodyOmitted/bodyReason | 正文省略不能补造内容；401/403是已观察响应，不是成功完成业务 |
| 执行转移 | fromState → occurrence → toState；证据ID，允许自环/多边 | 回边是真实观察，不是首次发现树的children关系 |
| 静态引用 | document → static_candidate；源文档与提取证据 | bundle中出现URL不表示访问过或可达 |
| 动作与请求关联 | `association: explicit_context / temporal / document_only / unknown` | 同时发生不能无条件解释成因果调用 |

当前`actionId`由frame+selector+kind等组成，是动作定义键。应保留它用于恢复/重放，同时增加执行实例ID，后者还应传入请求source；如果历史日志只有actionKey，就在页面图里展示“动作相关请求（历史归因）”，不要伪造精确执行关联。原始实例图保持全部证据，界面的聚合边保留count和实例列表。

## 完整性的产品口径与验收

“完整”应指**当前运行、当前身份/范围/动作策略/预算下，已经观察并记录的流程可在图上完整追溯**。未执行控件、登录要求、闭合shadow、canvas、跨域frame、未等待到的定时渲染、未知长度正文、WS/worker限制、失败步骤和预算截断要作为coverage gaps呈现。队列耗尽不是所有隐藏业务流程都被穷举的证明。

验收至少包含：静态未调用端点只出现候选虚线；guard阻断端点显示attempted/blocked；同一URL不同状态分开；两个控件到同一状态形成两条可区分执行边；无新状态但触发API仍有调用边；相同控件跨状态/重放有独立执行实例；HTTP响应与晚到正文不因checkpoint丢失；强杀恢复不双计数；图/JSON/报告口径一致。性能对照同时核对状态集合、真实转移、已响应接口集合和归因完整率，不能通过隐藏候选/删边或减少动作换取更好速度。

本轮建议采用顺序：先将现有事件与HTTP证据无损导出图 → 补执行实例归因与回边/自环 → 本地可过滤图视图 → 独立会话资源调度 → 可选trace/行为adapter。第三方依赖接入和性能收益均应另行经过本地夹具验证。


## 后端内部调用链的可选开源方案

如果还需“接口 → 内部服务 → 数据库”，应从服务端取得分布式 tracing。[OpenTelemetry traces](https://opentelemetry.io/docs/concepts/signals/traces/)提供 span 和跨进程上下文传播的数据模型；[Jaeger](https://www.jaegertracing.io/docs/2.22/)用于接收、分析和展示 tracing 与服务依赖。这需要后端应用或基础设施提供遥测，浏览器流程图不能替代这部分。当前仓库没有后端源码或 trace 数据，本轮没有部署或接入它们，也不根据 URL 相似度编造服务依赖。

## 本轮落地与调研的关系

本轮已借鉴有向多重状态图和证据分层思路，保留原 Playwright 守卫与执行引擎，自有 SVG 查看器提供分页、搜索、局部展开与路径证据；没有直接安装 Crawljax/Crawlee/Cytoscape/ELK 或复制第三方实现。Chrome 156 本机测试在 Network 域启用时取得了真实函数发起栈；代码不强制开启 Debugger，其他版本没有栈时标记缺失，协议文档所述可用性限制仍成立。实际产物与本机验收见 [网站图说明](site-graph.md)。
