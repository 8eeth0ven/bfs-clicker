# 软件转 MCP：能力与验证范围

统一服务提供 28 个工具：12 个 Web 探索/图工具，以及 16 个来源发现、规划、绑定、执行、观察、验证、生成和任务管理工具。生成入口包含具名工具、分页能力目录、通用调用与任务查询。`ready` 表示某个来源通过受支持契约和样本验证，不表示任意网站或 App 的全部业务已经覆盖。

本记录采用 `software-to-mcp-15` 的[草稿 PR 检查点](https://github.com/8eeth0ven/bfs-clicker/pull/1)分发范围，主分支未合并、npm 未发布；[compiler14 检查点 00f4e84](https://github.com/8eeth0ven/bfs-clicker/commit/00f4e8496f7f5863b813b484df3ed6fb940c9502)仅作历史参考。本轮完整回归和独立生产包 SDK 基线已通过，原生设备验收与最终 index/tar 内容审核分别记录；实际远端 commit 及最终审核结论由 PR 和交付记录核验。

机器可读状态见[公开验证摘要](software-to-mcp-validation.json)，使用与配置见[统一入口指南](software-to-mcp.md)。不同来源、版本、重复回归和交叠专项不相加。原始截图、设备标识、会话、模型与个人路径留在私有证据中，公开复现以仓库测试、配置和明确适用范围为入口。

## compiler15 当前专项与待验范围

| 项目 | 已取得的证据 | 当前边界 |
| --- | --- | --- |
| 原生像素任务进程 | iOS 相关 Python 159/159，Node 本地 PNG/IPC 16/16；非阻塞读写/退出等待、错误回复和取消回收均有反例 | 纯文件比较作用域，不跨 UI 动作缓存；原像素、caret、输入、Dismiss 与结果闸保留。不是设备验收 |
| 原生时间预算对齐 | 预算/快照/子进程/假 CLI/操作管理组合 37/37；独立模块重复 15/15、纯探针4项通过 | 三组交叠不相加；没有实际运行480秒或设备验收。业务预算原值不变，外层仅启动、终止及传输余量 |
| 有限 closed Shadow DOM 流程 | producer15/15，独立真实Chromium7/7及既有Web五文件51/51分列；候选→两样本学习→统一gamma/生成delta完成有限本地闭环 | 探索seed先1次POST，学习与双入口新增4次，整个SDK夹具共5次。仅主frame显式author-closed原生文本/按钮/DOM-text子集，不覆盖closed select/check/ARIA/visual/table |
| Python 完整回归 | 490项：489通过、1跳过；130.533秒，实际签名 APK fixture | 缺 HBC_FIXTURE 编译 Hermes 样本；相关 Python producer 与链接的 Node/Swift helper 前后源一致，不代表独立 Web/JS 预算源码全程冻结 |
| 原生快照 Node 专项 | 4文件13/13；约12500.705ms；483份复制源/32份 dist 原生队列末核一致，生产 import通过 | 实际 MCP/HTTP 或假 CLI/观察专项；483是本轮原生验收范围，不是最终 Web/全项目源码或生产包安装证明 |
| 普通 UIKit 第13轮 | 配置预检终态，选定设备类型与运行时不兼容 | create前停止；0设备、0UI动作、0服务端口；不是运行了工作流后的失败或设备通过 |
| 普通 UIKit 第14轮 | 学习阶段仅一次Focus后，以 `VISUAL_KEYBOARD_NOT_VISIBLE` 终态失败；34次RPC、0键/提交/ready | after-Focus界面树仍无Keyboard；之后没有新截图，不能推断实际像素键盘是否显示。六清理、fresh主机/端口、既有设备与483份源码均复核；未通过两样本/双入口 |
| compiler15 主项目与完整软件回归 | 本轮 `npm test` 239/239；`npm run test:software` 335/335，738060.698458ms；均0失败、0跳过 | 同一冻结范围的116份runtime与418份公开代码在两套结束时逐SHA匹配；Python producer与原生设备快照各有独立范围，不合并计数 |
| compiler15 独立生产包与 SDK 基线 | 357文件/32dist；仅生产依赖锁定安装、生产模块导入、官方SDK28工具、stderr0、客户端已关闭 | SDK基线打包时357份文件均与源一致。最终两份验证文档投影与实际index/tar完整隐私须提交前复核，不移用基线包哈希充当最终包 |

新预算链从同一份可信设备配置校验 `limits.maxDurationMs`，范围仍为整数1..3600000ms，缺省60000ms，不增加 MCP 调用参数。配置为480秒时，Python的UI预算仍为480秒；bridge外层执行等待为490秒（其中启动余量10秒），终止请求后12秒请求强制KILL并继续等直接子进程退出；exit后stdio等待最多1秒。单operation的客户端轮询窗口为512秒，每次状态查询扣减同一deadline，并把取消信号传给SDK请求。512秒不代表整个多operation设备harness的总预算。

原配置读取后制作独有0600/O_EXCL私有快照；预算与Python实际读取的JSON一致，临时路径不进入长期绑定。超时或取消不能因子进程exit0冒称成功；已持久化的不确定写保持unknown/no-retry。POSIX仅管理本次自身进程组，Node直接等待自己的child；不能保证任意逃逸setsid孙进程回收，也不承诺OS硬实时清理。复现见[预算测试](../test/native-workflow-budget.test.mjs)和[子进程测试](../test/software-python-budget.test.mjs)。

同一已保存第12轮失败原帧的有限生产像素块对照中，新 `_pixel_task` 与旧冻结helper的SHA/布尔结果相同，两张fresh仍被拒绝。各3次固定对照的实际子进程为8→3，中位耗时1333.24→1058.48ms；PNG解码仍为10次。该数据只涵盖两个fresh的像素比较块，未包含source、截图、HTTP、OCR或整轮设备运行，不宣传全流程或固定通用加速倍率。测试入口见[像素任务](../test/visual-pixel-task.test.mjs)和[Python任务生命周期](../apk_tools/tests/test_mobile_visual_ios_pixel_task.py)。

第13轮的预检问题是隔离的设备类型选择不兼容；读取真实运行时支持列表后，第14轮实际学习仍在首样本按键前被拒绝。34次学习RPC为19次activeAppInfo、5次source、3次截图、3次方向、3次窗口框与1次Focus；没有键盘按键或业务提交，workflow events尚未生成。该错误不是Timeout。after-Focus仅有界面树证据，不能把之后没有截图解释为像素中一定没有键盘。第14轮终态不会覆盖第11/12轮失败，也不把compiler15原生快照范围外的后续Web改动追认为已参加同一设备验收。本轮完整软件与主项目回归已在116份runtime/418份公开代码冻结范围通过，不改变这次设备失败。独立生产包/SDK基线已通过；最终源码与两份验证文档的归档投影、完整内容隐私须在提交前按实际index与精确tar验证。实际分发commit和最终审计由PR/交付报告记录，不在包内自嵌最终哈希。

### closed-root 的权限与守卫

`webConfig.closedShadowRoots` 默认关闭，只能由本地启动配置批准；最多4个可信策略、每条host链最多4层、每策略DOM最多256节点（默认128）。只在Chromium顶层main frame中解析明确批准的author-closed链；嵌套closed链需逐条明确批准，不跨iframe，不进入未批准nested或UA根，也不把closed模式改成open。配置见[有限闭根模板](../examples/software/config.closed-shadow.example.json)与[流程模板](../examples/software/browser-closed-shadow-workflow.example.json)。

当前支持原生INPUT text/search、TEXTAREA、BUTTON/INPUT button/submit，以及独立DOM文本结果。真实编辑使用鼠标与固定有限键入序列，每个物理编辑前重验同一执行租约下的root/target身份、固定语义、焦点、几何及跨host祖先exclusion；root或target在同一执行中重建会拒绝。主frame isolated world与BODY/双根同ID/页面prototype篡改反例共同核对归属，不依赖页面原型去猜目标。

每次高层fill/click共用一个绝对deadline；迟到只读响应不会恢复后续编辑。每backend最多4096次CDP、每回复256KiB、fill最多4096 UTF-8字节，释放/断连使用250ms有界等待；清理失败会阻止继续导航或重新后端。已尝试但未确认成功的closed探索动作会阻止整个run resume，避免从另一frontier重发未知业务；写执行和写学习权限继续分别批准，已派发后失败保留unknown/no-retry。

closed select/check/ARIA/visual/table、跨frame、未知nested/UA root、不支持的裁剪/变换几何、非唯一目标与遮挡仍拒绝。结果重建也保守拒绝，不能把同值或输入期自动更新当作提交证明。producer15项与独立7项有交叠，不能相加为22项；独立7项是浏览器语义/隔离复核，不另算一次MCP闭环。既有planner、browser capabilities/workflows、Web E2E及ARIA五文件51/51已通过；源码运行时两SDK stderr均为0，此为统一/生成调用，不是独立生产包握手。这些与已通过的335项完整软件套件有交叠，不汇总为独立总数；独立生产包SDK握手与最终分发审核另记。

独立生产安装使用根锁文件执行 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline`，未借用源码工作区配置。SDK基线包包含closed-shadow、像素任务、预算/Python桥和两项新配置示例，排除experiments与旧生产字段分区模块；五个公开凭据模板保持原批准哈希。打包时357份源文件逐字节一致，不代表文档更新后的最终tar已复核。每次提交前须验证实际暂存index与精确tar：仅两份验证文档可相对SDK基线发生批准投影，其他打包文件及runtime应逐字节保持一致，并完成全内容隐私审核。

## 本轮存储边界

本任务保守保留10GiB可用空间。重build、依赖安装、模型/SDK下载或大复制前，应校验“可用空间−计划写出量≥10GiB”；本轮已有任务级预检并留本地记录。这是运行者的运维约束，不是产品runtime自动删除或全系统存储保证。

此前只读审计本身未删除数据；之后已清理并再次核验48个本任务可重建缓存目录，逻辑文件445,079,035字节，allocated估算493,047,808字节（约470.21MiB）。761个保护文件哈希保持一致，原始证据或模型删除0。canonical WDA、全部frozen/prebuilt、当前依赖和最新compiler14安装均保留，可用空间仍满足10GiB底线。df观测增量501,743,616字节受APFS与系统并发活动影响，不能全部归因为本次清理。独立只读审查再次确认48目录不存在、761份保护文件及第14轮额外9份原始截图/XML的哈希一致；末次只读空间检查为32.546GiB，满足10GiB底线。该检查不等于对所有模型/依赖/保留目录逐字节重核，也不保证后续系统并发写入仍有相同余量。历史独立包探针若重跑，须按保留的archive/lock重新安装已清理的旧依赖，必要时仍需registry访问，未证明可离线重装。

## compiler14 历史检查点范围

compiler14 完整软件298/298发生于按键中心排他收紧前；之后唯一生产差异是该守卫，另完成全Python474项（473通过、1跳过）与受影响NativeNode12/12，不称为同一源码的一次全量。独立生产依赖安装与SDK握手350文件/32dist/28工具已通过。以下保留该检查点历史结论，不移作compiler15通过。

### compiler14 新增项与当时验收状态

| 项目 | 已取得的证据 | 当前边界 |
| --- | --- | --- |
| 正式 API multipart | 网关完整 55/55；API/引用/query/form 相关 49/49；统一和生成入口各一次真实本地上传，核对实际字节、文件名、MIME 与业务返回 | 55 已包含在本轮 `npm test` 的 239 项中；49 与其他组有交叠。仅支持声明完整的有限 multipart 子集；文件为内联 base64，不读取调用者路径或 URL，不含浏览器/App 文件选择器 |
| 有限虚拟化 ARIA 列表 | 真实 Chromium 及策略/原 ARIA/工作流组合 73/73；两样本和统一/生成入口共 4 次实际业务请求 | 本地 `ariaVirtualLists` 显式批准，完整正索引域、有界扫描与独立变化结果；无限列表、无法证明全域或域漂移拒绝。不是任意虚拟列表支持 |
| 规范文件有界读取 | descriptor、引用文档与官方 SDK 组合 27/27；单文档 8 MiB、整包 16 MiB | 实际 descriptor 读取受限，增长/截断/替换、非正规文件、坏 UTF-8 与缺失文件拒绝；保留原 artifactRoots 检查。快照元数据校验不构成对任意恶意文件系统的原子保证 |
| iOS 严格屏幕按键 | 相关 mock/解析器/本地夹具 123/123；保存的真实 XML 7 份覆盖 62 个 literal 身份；实际传输诊断得到 alpha、Ab7z | XML 重放没有设备动作，62 个身份不等于 62 个字符全部真实派发。传输诊断不是 MCP 学习/双入口验收；第11轮完整 MCP 实际失败，见下文 |
| iOS 完整文本确认与固定清除 | 显式 `complete_text`、`fixed_max_length` 的相关 mock 137/137，包含原 123 项和新增 14 项；纯请求审计 helper 10/10 | 两个字段须本地明确批准，默认 strict 不变。137 属于中心排他收紧前；后续 143 已包含它，不相加，纯审计不计设备。第12轮首样本完成，第二样本在下一键前因新鲜度守卫拒绝；未完成整体验收 |
| iOS 按键中心排他 | 收紧后相关 mock 143/143（含原 137 与新增 6）；原合成重叠 XML 现在键盘派发 0 次；同7份真实 XML/62身份独立只读回放通过 | 检查全部 visible Key/Button，包括 unknown/disabled；证明与派发共用实际整数中心。仅该 AX 子树内的点排他，不证明系统窗口归属，也不是设备验收 |
| 视觉字段分区研究 | 合同、空字段、预算及结构诊断实现保留于研究目录；真实反例与独立复核保留 | 未接观察器、Python 工作流、能力目录或 MCP，不随生产 npm 包提供策略。已知真实空格误识别，不能列为中文支持 |

第11轮普通 iOS 软键盘 MCP 实际只到达 Focus 与首个 literal `a`。原始 PNG 能看到输入 `a`，但输入区域 OCR 没有候选；键盘上的 `a` 不能移作输入回显。流程以 `VISUAL_INPUT_NOT_VERIFIED` 失败，派发后保持 unknown/no-retry；没有 Dismiss、业务 submit、ready，也没有到达 beta 或统一/生成入口。该轮自建资源清理已独立核实。不能把这次失败归因于低置信候选被 0.6 门槛过滤。

后续 `complete_text` 允许跳过中间 prefix 相等判定，仍须保留每次观察的来源、OCR、布局与新鲜度守卫，并最终核对完整回显；`fixed_max_length` 采用固定次数删除，不证明原隐藏缓冲区为空。这两个显式权限改变确认策略，不是第11轮 strict 条件已通过。动作门槛仍为 0.6；单个最终 `a` 缺失仍拒绝。第12轮实际以 `VISUAL_FRAME_CHANGED` 失败：首个学习样本 alpha 已完成，业务提交恰1次，原 OCR 结果为 `RESULT alpha 1`；第二样本固定删除16次后只输入 b，准备 e 时被拒绝，没有 e、第二次 Dismiss 或提交。两样本学习、ready、统一 gamma 与生成 Ab7z 均未完成。实际耗时297.359秒，错误不是 Timeout。六项自建资源清理标志均为真，四个本轮端口均无监听，既有设备标识保留；独立主机只读复核确认本轮自建会话/进程/模拟器与 MCP 进程均已清理，472份复制源码字节未变。

post-b 原帧与随后两张 fresh 帧分别有683个像素变化，全部在输入区；键盘、结果与其余上部区域均为0。其中各16个变化像素不满足既有 caret 颜色合同，背景并非全为近白。窄条形状不能证明这些像素就是系统 caret；本轮保持原守卫、预算和源码，不放宽颜色权限。该轮472份源码复制快照在诊断末逐字节重核一致；共享依赖仍有各自边界，不能表述为任意文件系统不可变保证。

| 保留的早期实现 | 已有有限证据 | 当前边界 |
| --- | --- | --- |
| 多文档 OpenAPI | compiler13 纯导入/runtime 与官方 MCP 32/32；显式 URI/本地映射及跨文档引用 | 不下载引用 URL；资源作用域、循环、重复身份或越目录文件拒绝。compiler14 有界读取组合另列，不与 32 相加 |
| DOM/ARIA 提交前基线 | 历史真实 Chromium 新增 4/4 与原 ARIA/懒挂载/共用流程 18/18 | 显式 changedFromBefore 同时检查入口和最后提交前基线；text-only 不证明提交因果 |
| Tesseract 原生分隔信息 | 历史独立 TXT/TSV 协议 Node 9/9、投影 1/1、Python 16/16；同一原图实际提取广州及 RESULT 上海 | 本地 POSIX opt-in；完整原词对齐并保留原分隔。原文仍是 OCR 推断，离线重放不是设备通过 |
| 同图 Vision ROI 与证据融合 | 有限非重叠区域、实际坐标映射、词界/融合反例相关 15/15；同一混排图 Query/北京置信度由 0.5 到 1 | 保留低置信整图异议及跨界文字，冲突拒绝；动作阈值 0.6 不降低，不证明任意文字识别正确 |
| 移动区域边界与 caret | 区域语义及边界 6 项；Node 光标 9/9 | 外扩整数像素与局部 caret 权限有独立合同；不证明系统窗口 owner，也没有原子截图与派发保证 |

Android 中文第9轮 Vision 已完成北京/上海两样本并发布 ready；新参数广州因跨脚本分词冲突在提交前被拒绝，统一和生成入口尚未闭环。第10轮换为 Tesseract nativeText 后，北京样本完成，之后北京被读成 `itm`；上海输入又被识别为带引号文字且置信度 0.37，0.6 守卫拒绝上海提交，该配置没有发布 ready。固定 fast/best 模型离线比较未找到一项同时通过三张原图的配置；不能用第9轮的 ready 追认第10轮通过。

研究目录的真实已知源 `上 海` 被 full 和 regional OCR 同时读为 `上海`。另一个明确声明的两字段策略接受该错误，不能证明 source-string 精确性；遗漏发生于引擎输出，代码没有清洗这个空格。早期四字段反例还受到无关 `RESULT` 局部置信度 0.5 的混淆，整帧拒绝不能算作空格或后缀保护的针对性通过。像素连通分量全覆盖无法恢复原应用空格。研究范围与复现条件见[研究说明](../experiments/README.md)。

## 已通过的有限调用链

| 链路 | 通过范围 | 公开复现入口 |
| --- | --- | --- |
| Web 探索与参数化 MCP | 真实 Chromium、本地动态测试站、两样本与统一/生成入口；非法输入或控件漂移拒绝 | [Web 工作流测试](../test/software-workflow-e2e.test.mjs)、[Web 参数化测试](../test/software-workflow-policy.test.mjs) |
| OpenAPI/Swagger 与接口调用 | 本地 JSON/YAML、受支持 schema、path/query/body 与有限 multipart；真实本地 HTTP 检查编码和上传字节；静态声明与网络观测分开 | [查询测试](../test/software-query-serialization.test.mjs)、[表单测试](../test/software-form-serialization.test.mjs)、[multipart MCP 测试](../test/software-multipart-e2e.test.mjs)、[multipart 规范示例](../examples/software/openapi-multipart.example.yaml) |
| 自定义 Web 下拉 | 真实展开与选择、完整 ARIA 域、懒挂载/选择后卸载；新增有限虚拟化域与双入口，各自显式配置 | [ARIA 测试](../test/software-aria-workflow.test.mjs)、[懒挂载测试](../test/software-lazy-aria.test.mjs)、[虚拟列表测试](../test/software-virtual-aria.test.mjs)、[策略示例](../examples/software/config.virtual-aria.example.json) |
| Web 写流程及中断 | 自建 Notes 本地落盘；学习和执行分别批准；写后错误/中断为 unknown，不自动重试 | [写流程测试](../test/software-write-workflow.test.mjs)、[中断恢复测试](../test/software-write-recovery.test.mjs) |
| Canvas 视觉及多字段候选 | Chromium/Tesseract 的固定可信合同、两样本与双入口；每参数独立结果断言，未映射多输入不猜关联 | [视觉测试](../test/software-visual-workflow.test.mjs)、[多字段规划测试](../test/software-visual-planner.test.mjs)、[Canvas 夹具](../examples/software/visual-canvas-demo.html) |
| 中文 Web/Vision | 实际中文锚点、两样本及统一/生成入口，四次真实本地 HTTP 查询 | [中文视觉测试](../test/software-visual-chinese.test.mjs)；该夹具显式结果阈值 0.3、动作阈值 0.8，不推广为其他目标的阈值 |
| APK/IPA 静态证据到 HTTP MCP | 自建 APK/IPA、Manifest/plist/DEX/ELF/Mach-O 等证据与生成调用 | [Python 测试](../apk_tools/tests/)、[移动软件测试](../test/software-mobile-e2e.test.mjs)；静态 IPA 样本不证明可安装 iPhone |
| Android 语义 UI、混合控件与单选 | 自建 API 36 模拟器，自动候选、两样本、双入口及同值 no-op | [控件验收](../test/android-controls-e2e.mjs)、[单选验收](../test/android-radio-e2e.mjs) |
| Android Unicode 语义输入 | 中文、emoji、组合字符、字面 `%s`；四次 MCP 替换查询；另有四次生产后端追加 | [Unicode 输入验收](../test/android-unicode-e2e.mjs)、[输入桥源码](../apk_tools/examples/unicode-ime/)；追加尚未发布为 MCP workflow，不能称为八次 MCP 调用 |
| Android 视觉枚举/拉丁文本 | 自绘且无字段语义树，真实两样本与统一/生成入口；输入法假成功、无操作提交、透明覆盖反例 | [枚举验收](../test/native-visual-android-device-e2e.mjs)、[文本验收](../test/native-visual-text-device-e2e.mjs)；完整通过范围为英文 OCR/拉丁文字 |
| iOS 语义 UI 与混合控件 | 自建 iOS 27.1 模拟器、UIKit/Appium/XCUITest/WDA，文本/Switch/SegmentedControl 与两入口 | [基础验收](../test/ios-device-e2e.mjs)、[混合控件验收](../test/ios-controls-e2e.mjs)；运行时已有 session 不证明安装字节 |
| iOS 视觉枚举 | 自建模拟器固定可信锚点、两样本、双入口；非法枚举零动作，同值结果拒绝 | [枚举验收](../test/ios-native-visual-device-e2e.mjs) |
| iOS 无系统键盘视觉文本 | compiler11：自绘 UIKeyInput，alpha/beta 学习、统一 RESULT gamma 3、生成 RESULT delta 4；输入忽略、无操作提交及非法参数反例 | [文本验收](../test/ios-native-visual-text-device-e2e.mjs)、[UIKeyInput 夹具](../apk_tools/examples/ios-visual-text/main.m)；限 Latin/eng，不覆盖普通软键盘、中文或物理 iPhone |
| 移动只读截图 OCR | 自建 Android/iOS 模拟器截图、本地 OCR 与统一/生成观察入口；零 UI 动作 | [观察测试](../test/native-visual-observation.test.mjs)、[设备观察验收](../test/native-visual-device-e2e.mjs)；观察本身不批准坐标动作 |

有限公开网站只读验证中，IANA Reserved Domains 页通过统一和生成入口读取。Python、RFC 与 MDN 页面也有实际读取与状态守卫记录；重新采样成功不证明任意页面长期稳定。这些只读结果不扩展为业务写入覆盖。

## 回归计数

| 版本/范围 | 结果 | 解释 |
| --- | --- | --- |
| compiler14 原 Web/图/MCP/网关（历史） | 239/239 | 当时 `npm test` 完整运行，0 失败/跳过；不包含软件与 Python 套件；含网关 55 项 |
| compiler14 软件完整回归（中心修复前） | 298/298；约 718658 ms | 当次冻结 112 个生产文件结束时逐哈希匹配；此后按键中心排他改动不在该次运行内 |
| compiler14 Python 完整回归（中心修复后） | 474 项：473 通过、1 跳过；123.958 s | 使用实际签名 APK fixture；缺 HBC_FIXTURE 编译 Hermes 样本；结束时最终 112 个运行时文件逐哈希匹配 |
| compiler14 NativeNode 受影响回归（中心修复后） | 4 文件 12/12；约 16950 ms | 原生集成专项，最终源码匹配；不能代替新源码完整软件回归 |
| compiler14 独立生产包与 SDK | 350 文件；32 个网关 dist 文件；官方 SDK 28 工具、stderr 0 | 已实际解包、仅生产依赖独立安装、生产模块导入及握手，源码比较无差异；最终源码/文档投影及完整内容隐私为提交前必检项 |
| compiler14 分发检查点 | 草稿 PR 检查点；主分支未合并、npm 未发布 | 最终源码/归档投影与完整内容隐私须提交前复核；结果与 commit 由 PR/交付报告记录，不在归档内自嵌最终哈希 |
| compiler14 历史专项 | multipart 55/49、virtual 73、规范读取 27、iOS strict 123 / complete_text 137 / center 143、审计 helper 10 | 各组有交叠；143 含137，137含123。mock、XML 和实际传输与设备 MCP 分列 |
| compiler13 软件完整回归（历史） | 265/265 | 当时冻结运行时，0 失败/跳过 |
| compiler13 Python 完整回归（历史） | 426 项：425 通过、1 跳过 | 提供实际签名 APK fixture；缺 Hermes 编译样本 |
| compiler13 独立生产包（历史） | 334 文件；官方 SDK 28 工具，stderr 0 | 当时独立生产依赖安装与源码一致性验证；不是 compiler14 打包结果 |
| compiler12 软件/Python 完整回归（历史） | 软件 232/232；Python 382 项：381 通过、1 跳过 | 软件完整运行早于键盘相位跟进，受影响检查另列；Python 缺 Hermes 编译样本 |
| compiler12 原 Web/图/网关与包（历史） | 229/229；包 333 文件、SDK 28 工具 | 历史重新执行及生产依赖安装 |
| compiler10/11 基线（历史） | compiler10 软件 215/215、原 Web/图/网关 229/229；compiler11 Python 329 项：328 通过、1 跳过 | 不含后续 compiler12–14 改动 |
| CI 与 compiler14 分发 | Actions 未启用；草稿 PR 检查点 | 本地模板静态核对不表示远端执行通过；不提前声称 push 或 PR 已发生 |

compiler14 的298项结束后唯一生产差异是 `mobile_visual_ios_keys.py` 的中心排他收紧；精确前后差异和9个其余函数 AST 不变已独立核实。该版源码另通过上述全 Python 与4文件 NativeNode，两阶段记录分别保留，不合并成“同一冻结源码全量通过”。生产包 350 文件与 SDK 握手来自实际独立安装，未使用 dry-run 推算；公开文档更新后的最终源码/归档字节与完整内容隐私仍须在提交前复核，实际结论记录于 PR 和交付报告。

CI 配置见[Linux/macOS 模板](ci.workflow.example.yml)。现有发布凭据缺少 `workflow` 权限，模板尚未启用为 Actions；具备权限后可放入 `.github/workflows/ci.yml`。历史官方 MCP 握手为 28 工具、stderr 0。compiler15 当前回归与打包状态见[公开摘要](software-to-mcp-validation.json)的当前字段；compiler14检查点保存在对应历史字段，历史通过不自动继承。

## 保留的失败与保护结论

原始失败保留在私有记录；本节公开失败类型及其结论，不公开设备标识、会话或运行目录。

- 早期 Python 全量有两项本地 WebDriver fixture 连接错误。后续完整运行通过，不据此追认早期失败原因已经查明；缺 Hermes 编译样本仍明确跳过。
- Android 设备轮曾出现 ADB 断连、预算耗尽和清理缺口；中文视觉第五轮发生预算/连接失败，第六轮实际更新结果后因数值边界未通过严格 OCR。派发后不确定结果保持 unknown/no-retry，不能从离线 OCR 或单个样本推导 ready。
- iOS 无键盘文本早期曾在创建会话、清除旧值和系统打开提示阶段失败；后续独立完整复验才记录双入口通过。提示处理只在测试脚本针对本轮白名单，生产不全局自动接受提示。
- 普通软键盘历史轮次遇到 Keyboard 消失、caret 淡入淡出、hidden/visible 相位变化及视口外键盘；第11轮严格屏幕按键又在首个实际 `a` 的输入 OCR 缺失时拒绝。后续显式确认/删除策略的 mock 不能追认这些设备失败已经通过。
- 屏幕键盘曾只检查键名唯一，原合成 XML 中两个不同键覆盖同一中心仍可派发。当前排他收紧对同件、unknown/disabled 行及 source 漂移反例拒绝；原失败保留，不据此宣称真实设备曾误触或本次设备通过。
- 拉伸 Switch 曾出现点击回执成功但值未变，产品单次点击后拒绝。后续固有尺寸夹具通过，不构成通用点击问题已经修复的证明。
- 输入被忽略、旧输入清除失败、提交无操作、重复结果、透明窗口、锚点歧义及旧 revision 均有拒绝路径。反例明确标注为模拟或实际设备，不把模拟响应当作键盘/窗口真实性证明。
- ROI 曾允许裁掉前缀或拆分整词来产生新锚点。现有 NotQuery→Query 与 NotQuery→[Not,Query] 等反例要求冲突拒绝，低置信整图异议也不能被过滤后丢掉。研究字段策略的真实空格误识别另行保留，不能因 full/regional 一致就推断源文本准确。
- 公开页面曾因标题/正文断言不当或 STATE_CHANGED 失败；修正断言或重新采样后的成功分别记录，未运行的步骤不追认为通过。

## 复现

基础依赖安装见[使用指南](software-to-mcp.md#安装)。无设备套件与设备验收分别运行；后者会创建测试资源并产生私有截图、会话和日志，不应提交这些产物。

```sh
npm test
npm run test:software
npm run test:python
```

compiler15预算与生命周期专项可运行：

```sh
node --test --test-concurrency=1 test/native-workflow-budget.test.mjs test/software-python-budget.test.mjs test/software-python.test.mjs test/software-native-visual-workflow.test.mjs test/software-operations.test.mjs
```

像素任务的本地 PNG/IPC 专项与真实浏览器项分别运行；本轮16项记录使用以下过滤命令，没有启动浏览器：

```sh
node --test --test-concurrency=1 --test-name-pattern='^(?!actual browser screenshots)' test/visual-pixel-task.test.mjs test/visual-caret.test.mjs test/visual-pixels.test.mjs
```

closed-root最终专项复现入口为[原语测试](../test/closed-shadow.test.mjs)与[工作流测试](../test/software-closed-shadow.test.mjs)，可串行运行两文件；其15项producer记录与7项独立浏览器复核分别保留。既有五文件Web组合51项与完整软件335项记录已通过，两者交叠不相加；独立生产安装/SDK基线已通过，最终index/tar与分发按提交前流程另验。

新增 multipart、有限虚拟列表及有界规范读取可通过对应仓库专项复现；精确命令见[机器可读摘要](software-to-mcp-validation.json)的 `reproduce`。配置使用[虚拟列表示例](../examples/software/config.virtual-aria.example.json)、[严格屏幕按键示例](../examples/software/ios-visual-onscreen-device.example.json)及[完整文本确认示例](../examples/software/ios-visual-onscreen-complete-device.example.json)，必须按本地目标重新批准。研究策略另用 `npm run test:field-research` 运行，属于源码仓库研究测试，不接入生产能力；当前文件集增加后，复跑测试数可能与已记录历史专项不同。

macOS Vision ROI 与词界专项（需要已初始化的 Xcode/Swift）：

```sh
node --test test/visual-observation.test.mjs test/visual-observation-regions.test.mjs test/visual-vision.test.mjs test/visual-vision-regions.test.mjs
```

iOS 相关无设备专项及共享整数区域边界：

```sh
PYTHONPATH=apk_tools .venv/bin/python -m unittest discover -s apk_tools/tests -p 'test_mobile_visual_ios*.py' -v
PYTHONPATH=apk_tools .venv/bin/python -m unittest discover -s apk_tools/tests -p test_mobile_visual_regions.py -v
```

设备脚本需要各自工具链、系统镜像和隔离配置。下列环境变量应由运行者设置为本地隔离目录；设备模板中的 session、设备、路径与全零哈希都是占位符，必须填写并重新核对，不是即填即过的业务保证。

```sh
# Android：SDK/JDK/可用系统镜像；脚本创建自己的模拟器与测试 App
npm run test:android-unicode -- --output "$BFS_UNICODE_EVIDENCE_DIR"
npm run test:android-visual-workflow -- --output "$BFS_VISUAL_EVIDENCE_DIR"
npm run test:android-visual-chinese-workflow -- --output "$BFS_CHINESE_EVIDENCE_DIR"

# iOS：已初始化 Xcode、可用运行时、隔离 Appium/XCUITest 安装
npm run test:ios-visual-text-workflow -- --appium-prefix "$BFS_APPIUM_PREFIX" --output "$BFS_IOS_TEXT_EVIDENCE_DIR"
npm run test:ios-visual-keyboard-workflow -- --appium-prefix "$BFS_APPIUM_PREFIX" --output "$BFS_IOS_KEYBOARD_EVIDENCE_DIR"
```

`--prepare-only` 仅准备环境，不等于两样本和双入口通过。当前未完成的 Android 中文与 iOS 普通键盘脚本应作为复验入口，不作为通过保证。Linux 缺少 macOS Vision 时，相关平台测试会明确跳过；Python 缺外部编译 fixture 时也应保留 skip。

## 历史 Canvas OCR 复用开销

同一结果验证阶段对同一实际 Canvas 节点的多个区域复用一次截图与 OCR；不跨动作或断言轮次缓存。节点被替换时，即使 selector 和像素相同也拒绝；基线、断言与提取后复核保留独立观察。

真实 Chromium/Tesseract 双字段、双结果夹具对照中，两组学习样本及一次执行的 OCR 调用均从 15 次降至 10 次，减少约 33%，HTTP 参数与结果一致。对照使用当前源码副本仅绕过两处缓存调用，不能解释为相对某个历史版本的整体加速。一次固定顺序的学习约 8661→6580 ms、执行约 4079→3331 ms；模型、负载与顺序会影响耗时，不承诺通用加速比。

复现入口：[性能脚本](../scripts/benchmark-visual-ocr.mjs)与[缓存反例测试](../test/visual-ocr-cache.test.mjs)。`observation.visual.captures` 只统计用于 OCR 的截图，不能当作全部 freshness 截图数。ROI 增加识别轮次，其目标是有限区域的可核验识别质量，不能合并为上述缓存加速数据。

## 持续保留的边界

- 来源、revision、可信定义和范围由启动配置绑定；生成入口依赖已安装运行时和私有绑定，迁移后需重新生成。
- 写执行和真实样本学习分别批准。输入也可能自动保存；派发后失败为 unknown，执行、验证、学习不自动重试或恢复。每次新调用都可能产生新副作用。
- OCR 文本不证明控件角色、事件处理器身份、隐藏缓冲区或后台业务因果；截图、窗口检查与派发存在非原子间隔。结果变化属于时序证据。
- 可信输入/结果及键盘区域内的像素变化有明确豁免范围，不能由相应布局指纹证明其语义。iOS 现有 WebDriver 会话不证明安装字节，AX 框和本地 envelope 不证明系统窗口 owner。
- 通过范围以自建模拟器和有限测试站为主；物理 Android/iPhone、任意第三方 App、任意键盘、复杂协议/媒体、未批准的closed root及未验收组合、无限或不完整虚拟列表仍需逐目标验证。
- iframe 遮挡采用有限采样；部分裁剪、无法证明来源的 srcdoc 和超预算内容保留 gap。静态证据、HTTP 成功、UI 回执、界面结果与业务完成分别记录。

发布摘要使用白名单字段。原始截图、令牌、cookie、设备 ID、会话及个人绝对路径不属于公开验证材料；提交或打包前应再次检查实际文件集合。远端 CI 和 GitHub 提交状态不由本文预先宣称。
