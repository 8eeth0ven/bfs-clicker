# 软件转 MCP：能力与验证范围

统一服务提供 28 个工具：12 个 Web 探索/图工具，以及 16 个来源发现、规划、绑定、执行、观察、验证、生成和任务管理工具。生成入口包含具名工具、分页能力目录、通用调用与任务查询。`ready` 表示某个来源通过受支持契约和样本验证，不表示任意网站或 App 的全部业务已经覆盖。

当前编译器为 `software-to-mcp-12`。机器可读状态见[公开验证摘要](software-to-mcp-validation.json)，使用与配置见[统一入口指南](software-to-mcp.md)。下列结果区分历史全量、当前专项、真实本地 OCR 和设备验收；不同运行不相加为一次全量。原始截图、设备标识、会话、命令记录和源码哈希留在运行者的私有证据中，公开复现以仓库测试及夹具为入口。

## 当前新增项与验收状态

| 项目 | 已取得的证据 | 当前边界 |
| --- | --- | --- |
| 同图 Vision ROI | 可信有限非重叠区域；整图后再识别同一原图；实际已知像素坐标映射测试；同一中文混排截图的 Query/北京置信度由 0.5 到 1 | Android 动作阈值 0.6 未降低；识别改善不等于设备业务完成；默认无 ROI 行为保留 |
| ROI 词界与证据融合 | 全图与区域文字按同序逐 token 严格比较；保留外部/跨界证据；冲突拒绝；词界反例及坐标相关 15/15 | 伪引擎融合测试和真实 Vision 坐标测试分别提供证据；不声称识别任意文字正确 |
| 移动文本区域边界 | 文本提取与批准遮罩统一使用外扩整数像素；6 项区域测试包含边界、跨界、低分和缩放；视觉 Python 相关 82/82 | 这是守卫与区域语义证据，不是新增设备覆盖 |
| iOS 普通软键盘 | 本地 opt-in 的精确 AX sourceRegion 与有限视觉 envelope；输入像素仍参与可见阶段 freshness；无硬件快捷键及光标路径 Python 81/81、Node 光标 9/9 | 自然 UITextField 保留 caret 的完整设备验收尚未通过；第四轮实际因 caret 淡入淡出触发 FRAME_CHANGED；不能用无键盘夹具代替 |
| Android 中文视觉文本 | 保留混排版式；同截图 ROI 离线识别已验证；公开设备脚本可复现后续步骤 | 第六轮实际第二样本结果已更新，但区域边缘数值取整触发严格 OCR 拒绝；修复已离线复核，第七轮遇系统 ANR，第八轮缺盘均未开始业务；第九轮北京/上海学习与 ready 已通过，新参数广州的跨脚本分词冲突被拒绝，尚无统一与生成入口闭环 |

iOS 键盘新路径仅在可见阶段做 focus、clear、type、dismiss；恢复 hidden 后才核对原布局、完整输入、同帧结果基线和原完整 SHA，再提交。可见阶段的局部等价模型由本地管理者明确批准，不能证明 AX 之外像素的系统窗口归属，也不具有原子截图与派发保证。额外 caret 颜色/几何权限已通过专项和独立复核；第七轮清除后原始界面树已变为 hidden，仍未键入样本；输入准备的状态适配已通过专项、完整 Python 及独立复核，第八轮源仍出现 visible=true 但键盘框在视口外，几何守卫拒绝；尚无完整设备通过结论。

## 已通过的有限调用链

| 链路 | 通过范围 | 公开复现入口 |
| --- | --- | --- |
| Web 探索与参数化 MCP | 真实 Chromium、本地动态测试站、两样本与统一/生成入口；非法输入或控件漂移拒绝 | [Web 工作流测试](../test/software-workflow-e2e.test.mjs)、[Web 参数化测试](../test/software-workflow-policy.test.mjs) |
| OpenAPI/Swagger 与接口调用 | 本地 JSON/YAML、受支持 schema、path/query/body；真实本地 HTTP 检查编码；静态声明与网络观测分开 | [查询序列化测试](../test/software-query-serialization.test.mjs)、[表单序列化测试](../test/software-form-serialization.test.mjs)、[规范模板](../examples/software/openapi-query-formats.example.yaml) |
| 自定义 Web 下拉 | 真实展开与选择、完整 ARIA 域、懒挂载/选择后卸载；同源关系及策略核对 | [ARIA 测试](../test/software-aria-workflow.test.mjs)、[懒挂载测试](../test/software-lazy-aria.test.mjs) |
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
| compiler10 统一软件入口 | 215/215 | 历史完整基线，早于 compiler11/12 新改动 |
| compiler10 原 Web/图/网关 | 229/229 | 历史完整基线，与软件套件独立计数 |
| compiler11 Python | 329 项：328 通过、1 跳过 | 提供实际签名 APK fixture；Hermes 编译样本缺失而跳过；早于诊断字符串细化 |
| compiler11 诊断更新后 iOS 相关 | 34/34 | 含文本 26 项；模拟/传输验证，不代替设备证据 |
| compiler12 当前专项 | 键盘相关 Python 81/81、Node 光标 9/9；视觉 Python 102/102；ROI/坐标相关 15/15 | 不同且可能重叠的专项，不相加、不冒充当前全量 |
| compiler12 原 Web/图/网关完整回归 | 229/229 | 本轮重新执行，含脱敏后表单测试 |
| compiler12 Python 完整回归（阶段修复后） | 382 项：381 通过、1 跳过 | 提供实际签名 APK fixture；缺 Hermes 编译样本 |
| compiler12 软件套件完整回归 | 232/232 | 输入准备状态跟进前的完整运行，含光标与区域数值边界，0 跳过；跟进后的受影响检查另列 |
| compiler12 独立生产包 | 333 文件；官方 SDK 28 工具，stderr 0 | 仅生产依赖的独立安装；源码与打包必需文件一致 |
| CI 模板、最终发布 | 模板已静态检查，Actions 未启用 | 当前发布凭据缺 workflow 权限；本次为含明确实验缺口的草稿审阅 |

CI 配置见[Linux/macOS 模板](ci.workflow.example.yml)。当前 GitHub 凭据缺少 `workflow` 权限，模板尚未启用为 Actions；具备权限后可将其放入 `.github/workflows/ci.yml`。本地静态核对不表示远端执行通过。

官方 MCP 历史握手为 28 工具、stderr 0。当前版本的完整回归、最终打包与发布状态应以[公开摘要](software-to-mcp-validation.json)的相应字段为准。

## 保留的失败与保护结论

原始失败保留在私有记录；本节公开失败类型及其结论，不公开设备标识、会话或运行目录。

- 早期 Python 全量有两项本地 WebDriver fixture 连接错误。后续完整运行通过，不据此追认早期失败原因已经查明；缺 Hermes 编译样本仍明确跳过。
- Android 设备轮曾出现 ADB 断连、预算耗尽和清理缺口；中文视觉第五轮发生预算/连接失败，第六轮实际更新结果后因数值边界未通过严格 OCR。派发后不确定结果保持 unknown/no-retry，不能从离线 OCR 或单个样本推导 ready。
- iOS 无键盘文本早期曾在创建会话、清除旧值和系统打开提示阶段失败；后续独立完整复验才记录双入口通过。提示处理只在测试脚本针对本轮白名单，生产不全局自动接受提示。
- 普通软键盘轮实际在硬件快捷键后不再观察到 Keyboard；新 opt-in 分支改为单次有界退格，默认分支保留原行为。随后自然 caret 的淡入淡出仍触发 FRAME_CHANGED，因此普通键盘目标尚未完成。
- 拉伸 Switch 曾出现点击回执成功但值未变，产品单次点击后拒绝。后续固有尺寸夹具通过，不构成通用点击问题已经修复的证明。
- 输入被忽略、旧输入清除失败、提交无操作、重复结果、透明窗口、锚点歧义及旧 revision 均有拒绝路径。反例明确标注为模拟或实际设备，不把模拟响应当作键盘/窗口真实性证明。
- ROI 曾允许裁掉前缀或拆分整词来产生新锚点。现有 NotQuery→Query 与 NotQuery→[Not,Query] 等反例要求冲突拒绝，低置信整图异议也不能被过滤后丢掉。
- 公开页面曾因标题/正文断言不当或 STATE_CHANGED 失败；修正断言或重新采样后的成功分别记录，未运行的步骤不追认为通过。

## 复现

基础依赖安装见[使用指南](software-to-mcp.md#安装)。无设备套件与设备验收分别运行；后者会创建测试资源并产生私有截图、会话和日志，不应提交这些产物。

```sh
npm test
npm run test:software
npm run test:python
```

macOS Vision ROI 与词界专项（需要已初始化的 Xcode/Swift）：

```sh
node --test test/visual-observation.test.mjs test/visual-observation-regions.test.mjs test/visual-vision.test.mjs test/visual-vision-regions.test.mjs
```

iOS 相关无设备专项及共享整数区域边界：

```sh
PYTHONPATH=apk_tools .venv/bin/python -m unittest discover -s apk_tools/tests -p 'test_mobile_visual_ios*.py' -v
PYTHONPATH=apk_tools .venv/bin/python -m unittest discover -s apk_tools/tests -p test_mobile_visual_regions.py -v
```

设备脚本需要各自工具链、系统镜像和隔离配置。模板中的 session、设备、路径与全零哈希都是占位符，必须由运行者填写；它们不是即填即过的业务保证。

```sh
# Android：SDK/JDK/可用系统镜像；脚本创建自己的模拟器与测试 App
npm run test:android-unicode -- --output /absolute/new-unicode-output
npm run test:android-visual-workflow -- --output /absolute/new-visual-output
npm run test:android-visual-chinese-workflow -- --output /absolute/new-chinese-output

# iOS：已初始化 Xcode、可用运行时、隔离 Appium/XCUITest 安装
npm run test:ios-visual-text-workflow -- --appium-prefix /absolute/owned-appium-prefix --output /absolute/new-text-output
npm run test:ios-visual-keyboard-workflow -- --appium-prefix /absolute/owned-appium-prefix --output /absolute/new-keyboard-output
```

`--prepare-only` 仅准备环境，不等于两样本和双入口通过。当前未完成的 Android 中文与 iOS 普通键盘脚本应作为复验入口，不作为通过保证。Linux 缺少 macOS Vision 时，相关平台测试会明确跳过；Python 缺外部编译 fixture 时也应保留 skip。

## 视觉识别开销

同一结果验证阶段对同一实际 Canvas 节点的多个区域复用一次截图与 OCR；不跨动作或断言轮次缓存。节点被替换时，即使 selector 和像素相同也拒绝；基线、断言与提取后复核保留独立观察。

真实 Chromium/Tesseract 双字段、双结果夹具对照中，两组学习样本及一次执行的 OCR 调用均从 15 次降至 10 次，减少约 33%，HTTP 参数与结果一致。对照使用当前源码副本仅绕过两处缓存调用，不能解释为相对某个历史版本的整体加速。一次固定顺序的学习约 8661→6580 ms、执行约 4079→3331 ms；模型、负载与顺序会影响耗时，不承诺通用加速比。

复现入口：[性能脚本](../scripts/benchmark-visual-ocr.mjs)与[缓存反例测试](../test/visual-ocr-cache.test.mjs)。`observation.visual.captures` 只统计用于 OCR 的截图，不能当作全部 freshness 截图数。ROI 增加识别轮次，其目标是有限区域的可核验识别质量，不能合并为上述缓存加速数据。

## 持续保留的边界

- 来源、revision、可信定义和范围由启动配置绑定；生成入口依赖已安装运行时和私有绑定，迁移后需重新生成。
- 写执行和真实样本学习分别批准。输入也可能自动保存；派发后失败为 unknown，执行、验证、学习不自动重试或恢复。每次新调用都可能产生新副作用。
- OCR 文本不证明控件角色、事件处理器身份、隐藏缓冲区或后台业务因果；截图、窗口检查与派发存在非原子间隔。结果变化属于时序证据。
- 可信输入/结果及键盘区域内的像素变化有明确豁免范围，不能由相应布局指纹证明其语义。iOS 现有 WebDriver 会话不证明安装字节，AX 框和本地 envelope 不证明系统窗口 owner。
- 通过范围以自建模拟器和有限测试站为主；物理 Android/iPhone、任意第三方 App、任意键盘、复杂协议/媒体、闭合 Shadow DOM 和不完整虚拟列表仍需逐目标验证。
- iframe 遮挡采用有限采样；部分裁剪、无法证明来源的 srcdoc 和超预算内容保留 gap。静态证据、HTTP 成功、UI 回执、界面结果与业务完成分别记录。

发布摘要使用白名单字段。原始截图、令牌、cookie、设备 ID、会话及个人绝对路径不属于公开验证材料；提交或打包前应再次检查实际文件集合。远端 CI 和 GitHub 提交状态不由本文预先宣称。
