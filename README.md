# bfs-clicker

**输入一个 Web 资产 URL，用真实浏览器探索页面、控件和 API，得到可复查、可停止、可续跑的结果。**

[本地操作面板](#本地操作面板) · [命令行](#命令行) · [认证](#认证与范围) · [输出](#结果与完成状态) · [修复与验收](docs/implementation-status.md) · [竞品对比](docs/project-review.md) · [Agent 任务书](docs/agent-implementation-prompt.md) · [English](#english)

## APK 接口清单与 MCP 网关（beta）

新增独立的 APK → 接口提取 → 可选 mitmdump 验证 → MCP 链路。Web 与 APK 的统一六字段清单共用固定四个工具（list/search/call/add_source）、按来源绑定的凭据和 GET-only 护栏。

- [APK CLI、依赖与运行时验证](apk_tools/README.md)
- [TypeScript MCP 网关、三来源模板与 Claude/Cursor 配置](gateway/README.md)
- [架构](docs/apk-mcp-architecture.md) · [测试与能力边界](docs/apk-mcp-verification.md)

主爬虫仍要求 Node.js ≥20；可选 MCP 网关要求 Node.js ≥22，APK 提取要求 Python ≥3.11，动态验证 extra 要求 Python ≥3.12。

```bash
npm --prefix gateway ci
npm run gateway:build
node gateway/examples/client-config.mjs --cursor --config /absolute/path/gateway.yaml
```

网关接收规范化的 method/url/headers/query/body/categories 清单；v2 原始 API 账本的分类与样本结构保持不变。真实凭据、APK、抓包和运行报告留在本地，仓库只发布源码与合成夹具。

## 安装与快速开始

要求 Node.js ≥ 20。默认使用 Playwright 自带 Chromium；核心工具和网页面板无需 Python。

```bash
git clone https://github.com/8eeth0ven/bfs-clicker.git
cd bfs-clicker
npm ci
npx playwright install chromium
npm run doctor
npm run view
```

打开终端显示的 [http://127.0.0.1:4177/](http://127.0.0.1:4177/)，输入已授权的 HTTP(S) URL，即可开始匿名探索。默认结果保存在 `output-runs/<runId>/`。账号、验证码和站点特殊交互需要相应会话或配置，工具会在报告中说明缺口。
<img width="3024" height="1712" alt="c8fb782ccf47a3d7a48e2e9263e584db" src="https://github.com/user-attachments/assets/5ab5ccca-670e-4e36-a125-9ccb31c2afeb" />

本地演示无需账号：

```bash
npm run demo
```

演示自动启动本机 `127.0.0.1:3100`，写入独立的 `output-demo-<时间>/`，结束后关闭演示服务；终端输出报告路径。默认回归只访问本地夹具。

## 本地操作面板

`npm run view` 可直接启动面板，无需先有运行目录。输入 URL，选择预算后点击“开始新任务”。

| 模式 | 行为 |
| --- | --- |
| 默认上限 | 50 个状态、深度 3、5 分钟、1500 次请求、500 次动作、每主机 50 状态 |
| 自定义上限 | 用滑块或数字分别设置以上六项；数字可超过滑块初始范围 |
| 直到跑完 | 同时取消以上六项探索预算，持续处理发现队列；可随时停止并保存 |

任一有限上限命中后任务为 `partial`。选中历史任务，提高预算或切换“直到跑完”，点击“按当前预算续跑”即可继续。状态和单主机状态数累计；时长、请求、动作预算按每轮续跑重新计数，总请求/动作计数保留。

面板显示已发现状态、本轮请求/动作、时长、停止原因、日志与报告链接；支持后台/可见浏览器、BFS/DFS、资源模式和请求间隔。每个面板同时运行一个任务，任务通过同一个 CLI 和请求守卫执行。两个面板或 CLI 同时续跑同一任务时，只有先取得运行锁的一方生效；续跑预算随 CLI 参数传入， worker 拿到锁后才落盘配置，后到的一方被拒绝且不会改动运行中任务的配置。STOP 只由经验证持锁的 worker 所在面板写入（锁内 PID/所有权令牌握手）：对尚未拿到锁的自己的 worker 请求停止，会在它拿到锁后立即生效，不影响其他实例正在运行的任务。

```bash
# 打开已有 CLI 结果，支持续跑
npm run view -- --run output-example

# 使用已有会话、代理或范围配置
npm run view -- --config output-target/config.json

# 指定面板端口和任务目录
npm run view -- --port 4188 --output-root output-runs

# 仅查看报告
npm run view -- --run output-example --read-only
```

服务器仅监听 `127.0.0.1`；写操作校验本地来源与面板令牌，API 仅接受列出的设置，私有配置/断点不可通过网页下载。关闭面板会请求停止正在执行的任务并保存进度。

“直到跑完”指当前范围、动作策略和发现规则下队列耗尽。持续生成新状态的页面可能一直运行。不限模式保留单次操作超时、浏览器标签数、正文大小、控件采样、请求间隔和危险动作拦截。它不承诺穷举站点所有状态。

## 命令行

无需编辑共享配置：

```bash
npm run run -- --asset https://console.example.com/ --output output-example

# 无限探索预算
npm run run -- --asset https://console.example.com/ --unlimited

# 自定义预算；时长单位为秒
npm run run -- --asset https://console.example.com/ --max-states 200 --max-depth 8 --max-duration 1800 --max-requests 6000 --max-actions 2000 --max-states-per-host 200

# 从原任务配置与断点续跑
npm run resume -- --run output-example --unlimited
npm run resume -- --run output-example --limit-mode default

npm run run -- --help
```

`example.com` 是占位地址，需替换为自己的授权目标。`--profile safe|forms` 表示动作策略；`--browser-profile` 表示独立浏览器目录。

配置文件可很小：

```json
{
  "startUrl": "https://console.example.com/",
  "outputDir": "output-target",
  "limitMode": "custom",
  "maxStates": 200,
  "maxDepth": 8,
  "maxDurationMs": 1800000,
  "maxRequests": 6000,
  "maxActions": 2000,
  "maxStatesPerHost": 200
}
```

```bash
npm run run -- --config output-target/config.json
```

`limitMode: "unlimited"` 会将六项探索上限规范化为 JSON `null`，恢复时含义一致；不用 `Infinity` 或 `0` 表示无限。有限模式下 `maxDepth: 0` 仅记录根状态。

## 认证与范围

默认匿名且只允许入口 origin；origin 包含协议、主机和端口。页面导航、请求和凭证范围分别设置，子域不会自动加入。

```bash
# 已有 Playwright storage state，支持 cookies 和 localStorage
npm run run -- --asset https://console.example.com/ --session output-target/session.json --logged-in-selector "#account"

# 可见浏览器手动登录，成功判据通过后保存
npm run login -- --asset https://console.example.com/ --session output-target/session.json --logged-in-selector "#account"

# 使用专用浏览器目录
npm run run -- --asset https://console.example.com/ --browser-profile output-profile --logged-in-selector "#account"
```

SSO/验证码由用户在可见浏览器完成。手动登录超时不会保存伪成功 session。登录检查支持已登录/已退出 selector、URL 正则、localStorage key、认证 probe 状态与 JSON 值；会话失效返回 `needs_auth`。没有成功规则的已有 session 只能靠登录壳识别，报告会标记未验证。

单 run、session、profile 都有锁；会话与配置用原子替换保存。已有断点绑定资产、请求/凭证范围、动作策略与认证身份；不兼容的任务在导航前拒绝恢复。

需要外部资源时：

```json
{
  "startUrl": "https://console.example.com/",
  "navigationOrigins": ["https://console.example.com/"],
  "requestOrigins": ["https://console.example.com/", "https://api.example.com/"],
  "credentialOrigins": ["https://console.example.com/"],
  "resourcePolicy": "flexible"
}
```

`strict` 阻断范围外请求。`flexible` 仅放行外部静态资源 GET，移除 Cookie、Authorization 等敏感头；外部 API 必须明确加入 `requestOrigins`，带凭证请求还需 `credentialOrigins`。`includeUrlPattern` 是范围内附加过滤，不能代替 origin 白名单。

## 动作与动态覆盖

- 默认 `safe`：探索明确的导航/读取动作，未知按钮、表单提交与危险动作进入未探索清单；confirm/prompt 默认拒绝。
- 链接真实点击，保留自定义事件；相对路径按当前 document/baseURI 解析。
- 保留有意义的 hash、tab 状态、正文及业务数字；噪声可用 selector/正则配置去除。
- 支持范围内 iframe、开放 Shadow DOM、hover、滚动/虚拟列表和代表性 select 选项；超过采样上限时报告缺口。
- `excludeSelectors` 在发现、实际执行、重放、重定位和 JS 点击兜底时复核。
- 可选 `seedRoutes`、响应中的路由回灌、robots/sitemap；访问使用同一浏览器范围、代理和预算。

显式表单探索需 `forms`、`actionAllowlist`、`requestAllowlist` 和测试数据。允许写方法不能自动推导为允许所有 UI 动作。GraphQL 分 query/mutation，未批准写请求阻断；纯读取 POST 也需要 endpoint allowlist。

```json
{
  "actionProfile": "forms",
  "formExplore": true,
  "fillText": true,
  "formValues": {"#query": "fixture"},
  "actionAllowlist": ["#search"],
  "requestAllowlist": [{"method": "POST", "url": "https://console.example.com/api/search"}]
}
```

动作安全依赖站点语义和明确白名单，无法单靠词表保证所有 GET/点击均无副作用。报告保留每次策略决定，接口清单用于后续验证。

## 与 Burp 配合

```bash
npm run run -- --asset https://console.example.com/ --proxy http://127.0.0.1:8080
```

Burp 监听需启动，人工 Intercept 暂停会影响探索和超时。代理、会话与日志保存在私有任务目录。HTTP(S) 证书验证默认启用；测试环境需要忽略证书错误时显式设置 `ignoreHTTPSErrors`。robots/sitemap 与业务请求经过相同浏览器传输。

## 结果与完成状态

| 产物 | 内容 |
| --- | --- |
| `run.json` / `manifest.json` | 资产、范围、有效预算、运行状态、停止原因、计数、覆盖缺口 |
| `report.html` / `overview.html` / `report.md` | 状态路径、真实动作结果、未完成原因；HTML 转义并限制脚本/外部资源 |
| `routes.json` / `tree.json` | 语义状态与路由；同 URL 可有多个交互状态 |
| `apis.json` / `api_routes.txt` | 观察请求、静态候选、来源与成组参数样本 |
| `requests.json` / `events.jsonl` | 脱敏的请求实例和事件证据 |
| `unexplored-actions.json` | 待执行、跳过、失败动作和原因 |
| `states/*.png` | 可选原始页面截图 |
| `traffic.har` | 脱敏导出，省略响应正文 |
| `private/` | 原始事件/流量、完整配置、断点、会话、原始 HAR；网页不提供下载 |

原始 JSONL 保留，HAR 流式导出；resume 累计 API/事件/来源，事件 ID 不重复。根目录 `checkpoint.json` 是脱敏派生副本，恢复使用 `private/checkpoint.json`。

API 类别区分 `attempted_request`、`observed_request`、`blocked_request`、`failed_request`、`static_candidate`。静态候选的方法为 `unknown`；模板合并保留具体请求样本，不以同长度判定相同响应。

| 状态 | 解释 |
| --- | --- |
| `completed` | 当前策略的发现队列耗尽且无未解决的执行错误 |
| `partial` | 命中预算、用户停止、存在失败/覆盖错误或报告/导出失败（`*_export_failed`），可查看原因并续跑 |
| `needs_auth` | 需要登录、认证规则未通过或手动登录超时 |
| `blocked` | 目标返回阻断/验证壳 |
| `failed` | 浏览器、请求守卫或其他执行故障 |

CLI 的失败退出码为 1，连续失败熔断为 42，其他任务结论为 0；自动化以 `run.json` 为准。发现接口不能证明漏洞成立，`completed` 也不表示全站安全。

网页“停止并保存”或在输出目录创建 `STOP`：

```powershell
New-Item -ItemType File -Path output-example/STOP -Force
```

```bash
touch output-example/STOP
```

STOP、SIGINT/SIGTERM 和 deadline 进入共享收尾；续跑清理旧 STOP。默认可读报告按敏感字段规则脱敏；页面截图和无法识别的业务数据仍需检查后分享。产物/会话由 Git 忽略规则排除。

## 默认值与限制

完整配置校验与默认值见 [src/asset.js](src/asset.js)，默认演示配置见 [config.json](config.json)。

| 配置 | 默认 |
| --- | --- |
| `actionProfile` / `resourcePolicy` | `safe` / `strict` |
| `limitMode` / `order` | `default` / `bfs` |
| `headless` / `channel` / `useProxy` | `true` / 自带 Chromium / `false` |
| `maxTabs` / `maxRetries` | 1 / 1 |
| `requestDelayMs` / `retryMaxDelayMs` | 50 / 5000 毫秒；429 等待发生在下个请求发出前 |
| `gotoTimeoutMs` / `actionTimeoutMs` | 15000 / 4000 毫秒 |
| `maxFrames` / `maxInteractives` | 12 / 每 frame 300 |
| `maxScrollSteps` / `maxSelectOptions` | 2 / 2，代表性采样 |
| `trafficMaxBodyBytes` / `trafficHarvestMaxBytes` | 存储 64 KiB / 收割 1 MiB |
| `maxBodyConcurrency` / `maxPendingBodies` | 2 / 32 |
| `autoAgreeConsent` / `jsClickFallback` | `false` / `false` |

当前守卫仅支持 Chromium/Chrome/Edge；Firefox/WebKit 在导航前明确拒绝。闭合 Shadow DOM、canvas 控件、WebSocket/WebRTC、shared/service worker 与无限控件组合需要适配器，报告记录缺口。

未知长度/过大响应正文采用 metadata-only；压缩解码正文仍受 Playwright 的整段缓冲影响，不能保证浏览器/Node 全过程内存硬上限。大站状态图/账本目前在内存并写入 JSON 断点，不限模式并不等于无限内存/磁盘。真实大站长跑性能和竞品同条件 benchmark 尚未完成。

没有登录材料、业务策略或明确范围时，工具无法自动补出全部资产测试链路。子域枚举、端口扫描、OpenAPI 审计、Android 与漏洞验证属于独立模块。

## 迁移、测试与贡献

旧 `crawl` / `resume` / `BFS_CONFIG` 入口仍调用同一任务服务。旧批次/预热/相似页/浏览器重建设置退役并打印迁移说明；未知字段报错。`trafficIncludePattern` / `trafficExcludeExt` / `trafficExcludeHost` / `trafficStripQueryParams` / `trafficKeepQueryParams`、`blockAssets`、`consentFallback` 也已退役：证据范围由 origin 请求策略与体量预算决定，同意弹窗只受 `autoAgreeConsent` 控制；写入这些字段会被忽略并打印各自的迁移说明。旧 schema 断点与新 identity 不兼容，需要新输出目录。旧 `maxStates=0` 不再隐式取消预算，使用 `--unlimited`；新 `maxDepth=0` 是根状态。

腾讯云专用 TypeScript 查看器已退役；Node 20 直接运行通用 JS 面板。旧部署步骤由 [运行迁移说明](docs/tencent-deploy.md) 替代。

```bash
npm run test:unit
npm run test:integration
npm run test:python
npm run test:e2e
npm test
```

测试需要 Chromium；Python 部分需要 Python 3，可用 `BFS_PYTHON` 指定解释器。可见登录 E2E 在 Linux 使用 `xvfb-run -a npm test`。CI 覆盖 Windows/Linux 与 Node 20/22；本机验证环境与实际结果见 [修复与验收](docs/implementation-status.md)，配置 CI 不等于已经在所有平台跑过。

仓库未声明 LICENSE，授权条款需维护者决定。

## English

bfs-clicker explores an authorized HTTP(S) asset with Playwright and records UI states, click paths, API sources, request evidence and explicit coverage gaps.

```bash
npm ci
npx playwright install chromium
npm run view
npm run run -- --asset https://console.example.com/ --unlimited
npm run resume -- --run output-example --unlimited
```

The local panel offers default limits, sliders/numeric custom limits, unlimited exploration, stop/save and resume. Unlimited disables state/depth/duration/request/action/per-host exploration budgets together; operation timeouts, sampling, concurrency and scope still apply.

Default mode is anonymous, headless Chromium, safe actions and strict origin scope. Authentication requires a valid session/profile or verified manual login. Reports distinguish observed requests from static candidates. Private evidence stays under `private/`; shared text views are redacted, while screenshots need review before sharing.

Completion means the current discovery frontier is exhausted under the configured policy. It is not a vulnerability finding or proof of full coverage. See the [review and official competitor comparison](docs/project-review.md) and [implementation status](docs/implementation-status.md).
