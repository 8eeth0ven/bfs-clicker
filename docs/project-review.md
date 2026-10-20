# bfs-clicker 项目评估、竞品对比与补全路线

评估日期：2026-10-19。代码基线：`6b1cf55`（main，2026-10-16）。范围：Node Web 爬虫、报告与相关测试；Android 工具仅检查目录定位。本文保存修复前的审计与复现，表中“当前”均指该基线；新实现和实际验收见 [implementation-status.md](implementation-status.md)。竞品部分为官方功能对照，未执行竞品跑分。

项目已经具备可配置的动态发现引擎。距离“输入一个资产就稳定交付结果”，主要缺少统一入口、请求/动作策略、认证管理、可靠持久化和诚实的完成判定。产物数量不能直接当作覆盖率，也不能证明漏洞成立。

这里的第一阶段“资产”定义为一个 HTTP(S) Web URL。“结果”定义为路由、API、来源证据、流量、覆盖缺口和运行结论。裸 IP、域名资产枚举、OpenAPI 扫描与 Android 包应作为独立适配器；需要认证的内容必须提供有效会话，验证码等情况返回明确的待处理状态。

## 1. 威胁与缺口概览

| 维度 | 当前状态 | 对“给资产得结果”的影响 |
| --- | --- | --- |
| 动态发现内核 | 已有 BFS/DFS、点击、重放、响应挖掘和 API 来源 | 可以作为基础继续完善 |
| 单 URL 入口 | 需复制/编辑多个配置字段 | 用户不能可靠地用一个参数启动 |
| 依赖预检 | 无统一 doctor；浏览器与 Node 版本条件分散 | 安装完也可能启动失败 |
| 认证处理 | 手动登录 + cookie 名启发式 | 匿名/登录失败/失效可能混淆 |
| 请求与动作边界 | 存在可复现缺口 | 可能越界请求、泄漏注入令牌或确认写操作 |
| 停止与恢复 | 部分功能已有，状态一致性不足 | 可能超预算、混目标、丢历史账本或无法继续 |
| 覆盖与报告 | 有产物，状态和证据语义不足 | 未探索的控件可能被显示为已点击 |
| 跨平台交付 | 核心在本机能运行，缺少 CI 和统一结果页 | 难以承诺换机或无人值守成功 |

优先级是本项目的修复顺序：P0 为凭证、动作与报告安全；P1 为结果正确性、任务闭环；P2 为覆盖扩展、性能与生态。严重性取决于实际运行配置和目标，不将所有缺口都视为已成立的安全漏洞。

## 2. 技术分析：优点、问题与同类工具

### 已做得比较好的部分

- Playwright 驱动真实浏览器，能记录按钮/菜单触发的请求，而不只提取页面链接。
- BFS/DFS、路径重放、重复边和截图使发现过程可复查。
- `cdpnet.js` 已保留请求来源与查询/请求体键值；当前测试覆盖了重复参数与具体对象 ID。
- 正文发现与实际请求都能形成线索，JS 解析和路由种子可扩展覆盖。
- 有 STOP、熔断、浏览器重建、会话回写等长跑基础能力。
- 原有自动测试在补齐浏览器依赖后全部通过，说明现有受测行为有可复用基础。

### 需要优先补齐的实现细节

| 优先级 | 问题、根因与触发面 | 影响 | 修复与验证方向 |
| --- | --- | --- | --- |
| P0 | `src/crawler.js:274` 的 `authInject.urlPattern` 缺省为 `.*`；只靠原始 URL 正则决定注入。范围外导航在请求之后才检查（`1193`） | 配置 tokenFile 后，外域请求可能携带 Authorization。已在双本地 origin 夹具复现 | 解析 URL，按协议/主机/端口白名单注入；重定向逐跳检查，禁止缺省全域注入；断言外域服务端收到的鉴权头为零 |
| P0 | `src/dialogs.js:16` 对原生 dialog 一律 `accept`，与 `autoAgreeConsent` 无关 | “Continue” 等普通标签可以确认有副作用的操作；关闭自动同意仍会接受 confirm | 原生 confirm/prompt 默认 dismiss；明确动作策略、请求级兜底；覆盖空文本、图标、aria-label、重定位与重放 |
| P0 | `src/report.js:151` 将 `pathLabels.join(...)` 直接插入 HTML，其他转义函数未覆盖该位置 | 目标页面可控文本进入点击路径后，在打开本地报告时执行脚本。已用本地无害标记复现 | 所有目标派生文本使用转义或 textContent；CSP 作为附加层；对每个报告字段做渲染测试 |
| P0/P1 | Chromium 原生块 `Network.setBlockedURLs` 只覆盖部分请求类型/导航行为。CDP 武装失败仅记录日志继续 | 本机 Chromium 151 中 fetch 被拦，但 `page.goto` 和 `location.href` 导航仍到达登出夹具。默认日志可能制造过强保证 | 独立导航、popup、redirect、worker 请求守卫；按浏览器矩阵验证；关键守卫失败返回明确失败或受限模式 |
| P1 | `maxStates` 在批次边界检查；整批开页和 `createState` 没有剩余容量约束 | `MAX_STATES=12` 实际生成 21 态。状态/请求/时长上限无法保障 | 派发前预留预算；提交新状态前校验；限制所有在飞任务、重试和预热；增加全局 deadline、请求数与按 host 限速 |
| P1 | `checkpoint.json` 不保存/验证规范化目标、scope、profile 与 schema；`resume` 直接加载 | 同一目录换目标会恢复旧状态，甚至把新任务判为已完成。已复现 | 任务 ID + target/scope/profile 指纹；输出目录锁；原子写、版本迁移和不匹配拒绝 |
| P1 | `crawler.js:666` 的“已完整跑完”在深度放宽补队之前返回 | 深度 1 跑完后提高到 3，未展开子页仍不继续。已复现 | 按状态/动作未处理集合重建 frontier，然后判断耗尽；保存被深度或预算裁剪的工作 |
| P1 | 断点只保存状态/队列；API ledger、JS 清单、形状/相似度集合重新创建；非空账本覆盖旧文件 | 多轮结果不累计；空账本不重写还可能留下旧文件，造成数据新旧混用 | 原始事件追加落盘，派生视图累计；分段 HAR；保存去重索引和计数；恢复后对账 |
| P1 | 报告忽略 `processed`，只要非 skipped/failed 就显示“已点”（`report.js:140`）；正常退出也可能是预算裁剪 | 本地演示剩 15 个未展开状态、35 个未处理控件，仍显示完成/已点 | 每动作 planned/running/succeeded/skipped/failed；每任务 completed/partial/needs_auth/blocked/failed；报告展示剩余工作与 stopReason |
| P1 | `excludeSelectors`、`clickEverything` 只在 config 中声明，Node 实现未消费 | 用户以为禁用动作或排除危险控件，实际配置无效 | schema 拒绝未知/未实现选项；实现端到端 excludeSelectors；每项配置有行为测试 |
| P1 | 登录检测只看 URL 与会话类 cookie；登录超时仍保存并正常返回；默认 crawl 指向未必存在的 session 文件 | localStorage-only 认证误判；认证失败可能成为“无结果的成功”；首跑可能不断重试缺文件错误 | 显式匿名/会话/profile 模式、登录前后验证和 auth probe；过期停止，不将 401/403 页面记作业务完成 |
| P1 | `normalizeUrl` 删除 hash；同 URL 通常需交互数量增加达到阈值才作为展开；指纹未稳定前计算且保留控件数字 | hash 路由、小幅菜单/内容切换会漏；数字轮询可能制造多态 | 路由模式检测；保留有意义 hash；稳定后计算可配置语义指纹；正文、选中态与交互迁移联合判断 |
| P1/P2 | 元素发现使用当前文档 `querySelectorAll`；同意层的 iframe/shadow 处理没有推广到探索器；没有有界的滚动/hover 发现 | iframe、Shadow DOM、延迟菜单、虚拟列表、只挂事件的 div 和多选项遗漏 | 持久化 frame/shadow 路径；多事件与有界滚动；不支持的闭合 shadow/canvas 明确记录为缺口 |
| P1/P2 | 链接相对 `startUrl` 解析（`crawler.js:72`），直达路径可能绕过页面点击逻辑；重放动作与并发标签共享 cookies/localStorage/服务器状态 | 嵌套相对链接跳错；同 href 自定义处理遗漏；重放写操作、token 轮换与标签间状态污染 | 相对当前 page URL 解析；直达仅用于经判定的普通导航；动作重放风险与会话锁；将浏览器全局状态与页面状态分开建模 |
| P1/P2 | API 同 method+URL 合并参数集合，正文线索用 GET 记账；缺少请求样本 ID、响应关联、置信度和失败请求分类 | 多组参数组合关系丢失，不能可靠重放；静态猜测可能被当成实际接口 | 原始 request/response 事件保存证据 ID；模板与实例分层；observed/static/discovered 分类；GraphQL operation 单独记录 |
| P1/P2 | 流量按大小/status/请求体去重；同大小不同正文可合并；JSONL 默认删除，HAR 全量读入内存；异步响应处理缺少 drain | 权限/响应差异被折叠；长跑导出耗内存；收尾可能遗漏还在处理的响应 | 原始事件与去重视图分离；响应摘要与 authEpoch；有界并发/正文读取、流式 HAR 与 drain；记录 omitted/truncated/failure |
| P1/P2 | robots/sitemap 使用 Node `fetch`，无统一代理/认证/AbortSignal，并跟随重定向 | 部分请求绕过代理；早期请求可长时间挂起；范围过滤不一致 | 共用 transport、scope、budget、timeout；每个 seed 的来源/跳过原因落盘 |
| P2 | `view/summary.ts` 固定 `output-viewer(legacy)` 且用 URL pathname 构造 Windows 文件路径；页面有专项数字/标题；无 CI/许可证/基准 | 通用项目交付和跨机器使用不足；性能宣传无法复现 | 统一 --run/--output 查看器、fileURLToPath、Node 版本声明、Windows/Linux CI、维护者选择 LICENSE、可复现基准 |

额外注意：当前 `maxStatesPerHost` 使用单个总计数变量而不是 host→count Map，恢复也不重建该计数。`sessionId` 仅时间戳+host，不能承担唯一任务 ID。运行结果应明确记录配置、浏览器版本和会话身份，敏感原件与可分享报告分别控制。

### 竞品对比

以下来自官方资料，比较能力与适用场景；本轮没有运行竞品，不能据此给覆盖率或性能排名。

| 工具 | 动态探索与证据 | 产品/工程优势 | 局限与适用取舍 |
| --- | --- | --- | --- |
| bfs-clicker | Playwright 点击、路径/截图、状态树、参数来源、HAR | JavaScript 实现便于针对具体控制台定制 | 安全、恢复、入口与完成语义仍有缺口；适合二次开发 |
| Katana | 标准/headless、JS 解析、XHR、表单提取 | CLI、输入输出、scope、resume、限速和流水线友好 | 需要配置浏览器模式；其动态能力不能被简单归为“被动/静态” |
| crawlergo | Chrome、DOM 事件、表单填充/提交、req_list/all_req_list | 请求集合与代理/被动扫描器联动；多种 URL 过滤模式 | 自动提交会产生副作用；状态证据与本项目模型不同，维护状态应再核验 |
| Crawljax | 动态 DOM 状态、事件迁移、state-flow graph | 状态建模与插件扩展、测试研究基础 | Java/Selenium 集成；ZAP 指出其更新较不频繁，选型应看目标兼容性 |
| ZAP Client Spider | 浏览器扩展访问 DOM、Client Map、动作任务与 HTTP 消息 | ZAP 认证、Selenium 脚本、Automation Framework；Flexible/Strict scope 与 logout avoidance | 需要 ZAP/add-on/context 配置；严格阻断第三方资源可能影响页面功能 |
| Burp Scanner | 浏览器事件、爬取路径、记录登录序列、漏洞审计 | 认证、范围、深度/时长设置与审计流程集成 | 自动 Scanner 需要 Professional/DAST；成本与扫描策略需要考虑 |

选择建议：CLI 批量入口参考 Katana；动态事件覆盖参考 crawlergo；状态图参考 Crawljax；认证、scope 与任务可观测性参考 ZAP Client Spider；需要完整扫描和人工验证衔接时参考 Burp Scanner。bfs-clicker 的竞争力可以建立在可解释路径、请求证据与受控探索上，这些差异仍需同条件验证。

官方资料：

1. [Katana README 与 CLI 参数](https://github.com/projectdiscovery/katana)：headless、JS/XHR、scope、限速、resume。
2. [crawlergo README](https://github.com/Qianlitp/crawlergo)：DOM 事件、表单、代理与请求结果。
3. [Crawljax](https://github.com/crawljax/crawljax)：动态状态图与插件。
4. [ZAP Client Spider](https://www.zaproxy.org/docs/desktop/addons/client-side-integration/spider/) 与 [Spider Options](https://www.zaproxy.org/docs/desktop/addons/client-side-integration/spider-options/)。
5. [ZAP：Use the Client Spider for Modern Web Apps](https://www.zaproxy.org/blog/2026-07-06-client-spider-now-recommended/)：官方推荐与 AJAX Spider 关系。
6. [Burp Browser-powered scanning](https://portswigger.net/burp/documentation/scanner/browser-powered-scanning) 与 [Crawl settings](https://portswigger.net/burp/documentation/scanner/scan-configurations/crawl-settings)。

旧 README 的“2.9×”“省 49%”“完整覆盖”“62 个强化提交全有离线测试”等没有在本轮取得同条件复现实验记录，已移除作为当前版本的保证。原历史数据不能用于对竞品宣称更优。

## 3. 验证步骤与已获得的证据

本机：Windows、Node `20.20.2`、Python `3.12.10`、Playwright `1.62.1`。原测试浏览器为 Chromium `151.0.7922.34`；演示使用本机 Edge。所有行为夹具使用本地 HTTP 服务与虚假令牌，不向真实业务目标发请求。

### 原有回归

```bash
npm ci
npx playwright install chromium
npm test
```

结果：URL 形状 14 PASS，发现回灌 18 PASS，脚本回归 40 PASS，API/控件 214 PASS；Python 回归 0 FAIL。首次失败原因是浏览器未安装，安装后全部通过。它们覆盖原测试范围，仍未覆盖上述关键缺口。

`npm run view` 在 Node 20 返回 `bad option: --experimental-strip-types`。这是版本条件，不能等同于爬虫核心不支持 Node 20。

### 有预算的演示

```powershell
$env:MAX_STATES = "12"
$env:MAX_DEPTH = "3"
npm run demo
```

观察：耗时约 59 秒、21 状态、20 HAR 条目；断点仍有 3 个队列项、15 个未展开状态、35 个非跳过且未处理控件、1 个失败控件。日志打印“达到 maxStates=12”及“遍历完成”。这是预算与报告语义缺口，不是性能优势。

### 本地专项夹具

本轮辅助脚本位于被忽略的 `output-review/`，不作为既有受测实现的永久测试。可将其逻辑转为后续回归：

```bash
node output-review/review-probe.mjs
node output-review/cdp-check.mjs
node output-review/report-check.mjs
```

| 场景 | 步骤 | 观察 |
| --- | --- | --- |
| 确认框 | `autoAgreeConsent=false`，点击打开 confirm 的普通按钮 | confirm 返回 true |
| 越界 + 令牌 | 两个不同本地 origin；只允许入口 origin；authInject 未给 urlPattern；按钮跳外域 | 外域收到请求与虚假 Bearer 头；manifest 事后记录越界 |
| 登出请求类型 | 同页 fetch 与直接/JS 导航访问 `/api/logout`；测试裸词、通配符和绝对 pattern | fetch 阻断；直接/JS 导航仍到达服务端 |
| 数字指纹 | 同 URL、相同结构，把控件 `Users (1)` 改为 `Users (2)` | 指纹改变；旧“动态数字不影响”保证不成立 |
| 跨目标续跑 | 一个目标完成后保留输出目录，换 startUrl 再 resume | 恢复旧状态并判“上次已完整跑完” |
| 深度放宽 | 根→子→孙；深度 1 后子节点未展开，改深度 3 resume | 在补队之前直接早退 |
| 流量生命周期 | 正常完成并生成 HAR | JSONL 被删除 |
| 报告文本 | 点击路径标签含无害 img/onerror 标记；拦截全部外网访问后渲染 | 本地标记脚本执行 |
| 报告状态 | 控件 processed 为空且非 failed/skipped | 被显示为“已点” |

这些结论只覆盖所测版本和场景。浏览器差异、worker/popup/redirect、服务端副作用和真实认证应通过明确矩阵继续验证。

## 4. 影响与成熟度判断

对人工操作者，当前可以承担“配置后探索并收集线索”。对无人值守 agent，主要影响是：越界/写操作风险、认证失败不显式、结果不能累计，以及将部分探索误报为完成。最应优先提升的是结果可信度与失败可解释性。

工程量估计以 1 名熟悉 Playwright 的工程师、已有测试环境为前提，包含回归和文档，属于规划估算：

| 目标 | 剩余工作 | 大致量级 |
| --- | --- | --- |
| 单 URL、匿名站、可复查结果的 MVP | P0 + CLI/doctor + 预算/状态 + 持久化/报告闭环 | 约 2–4 周 |
| 登录后 SPA 的稳定交付 | auth 生命周期、更多 DOM 状态、重放与并发一致性、跨平台矩阵 | 在 MVP 上再约 3–6 周 |
| 域名/IP/API/Android 都用一个入口 | 多资产适配器、范围/身份模型、设备/API契约、调度与验证 | 需单独设计，现有检查不足以可靠估时 |
| 任意目标自动找到漏洞 | 漏洞类别验证、双角色证据、误报控制、独立授权策略 | 当前发现引擎不能保证这一结果 |

不建议用“完成了 80%”表达成熟度：缺失的安全/持久化环节会阻断整个任务，模块数量与可交付程度不是线性关系。

## 5. 如何补全、检测与验收

按依赖顺序实现，每阶段产生代码、测试、示例产物和 README 更新：

1. **建立统一任务与预检**：`run --asset`、doctor、schema、target/scope/runId、匿名默认、输出目录与预算；保留旧命令兼容。
2. **封住请求/动作/报告边界**：凭证 origin 绑定、导航守卫、原生确认默认拒绝、实际 excludeSelectors、页面派生文本转义。所有入口使用同一策略。
3. **修持久化与完成语义**：原始事件追加、checkpoint 原子保存、任务目录锁、resume 不变量、账本累计、严格预算；明确 completed/partial/needs_auth 等状态。
4. **补认证与覆盖**：会话验证、过期提示、hash 与小幅 SPA 状态、iframe/shadow、滚动/菜单、重放副作用和安全表单策略。
5. **统一交付与基准**：通用报告/查看器、接口来源/样本/响应证据、覆盖缺口、Windows/Linux CI、可复现夹具与同条件竞品实验。

最小验收必须包含：匿名 URL 一条命令出结果；无凭证登录页返回 needs_auth；外域注入令牌为零；危险确认不执行；12 态预算不超；换目标拒绝旧断点；放宽深度继续；中断续跑与整轮发现集合一致；未处理控件不显示已点；报告恶意标签不能执行。

完整可直接交给 agent 的实施 prompt 见 [agent-implementation-prompt.md](agent-implementation-prompt.md)。需要 LLM 时只用于候选动作分类与解释；范围、预算、凭证和完成判定由可测试的确定性代码执行。闭环质量可先通过这些实现提升。

