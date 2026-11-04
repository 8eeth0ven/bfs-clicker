# 从软件证据生成 MCP

统一入口连接 Web 探索、APK/iOS 接口清单、浏览器路径和原生 UI 适配器。生成结果是一个真正可启动的 stdio MCP 服务：含来源能力目录、参数 schema、独立 server.mjs 和客户端配置。工具调用通过已有 HTTP、浏览器或移动后端执行，并保存结果与验证记录。

这是向“任意网站和 App 都有 MCP 入口”推进的实现。具体来源会公开 ready/candidate、证据与缺口；当前实现不能证明任意软件的所有业务都能自动生成和验证。未知 HTTP 方法保持候选。已观察的固定 UI 路径，以及用不同输入实际验证的参数化流程，均可生成可调用能力。

## 安装

统一入口要求 Node.js 22+。Python 包分析要求 Python 3.11+；代理采集的可选 verify/setup extra 另需 Python 3.12+。已验证范围见[公开验证摘要](software-to-mcp-validation.json)。

```sh
npm ci
npm --prefix gateway ci
npm --prefix gateway run build
npx playwright install chromium
python3.13 -m venv .venv
.venv/bin/python -m pip install -e ./apk_tools
node src/software-mcp.js --output-root ./output-software --artifact-root ./examples/software
```

高级配置见 examples/software/config.example.json，可指定 artifactRoots、Python、Web 启动配置、逐来源网关凭据/方法/范围和设备配置别名。路径应使用绝对路径。原 CLI、面板、十二工具浏览器 MCP 与四工具接口网关仍可分别使用。

## 调用链

1. `software_discover({kind:"web", input:"http://目标站点/", sourceId:"demo", webOptions:{maxStates:50,maxDepth:4}})`。APK/iOS 的 input 可为安装包、App Bundle 或已有清单目录。返回 operationId。
2. `software_operation({operationId})` 等待 completed；执行进程关闭前会短暂处于 finishing。
3. `software_sources()` 读取来源 revision；`software_capabilities({sourceId,limit:30})` 分页读取能力及参数 schema。
4. `software_call({sourceId,capabilityId,expectedRevision,params})` 真正执行所选能力，仍用 operationId 查询结果。`software_validate` 同样执行一次并保存 validation.json，不把网络响应自动解释为业务成功。
5. `software_generate({sourceId,expectedRevision:来源revision})` 生成独立 MCP。启动返回的 entry，或将 mcp-client.json 合并到客户端配置。
6. 证据更新后调用 `software_refresh({sourceId,expectedRevision})`，返回新增/变更/移除计数和有界 ID 样本；来源更新后旧入口会拒绝旧 revision，重新生成即可。

`software_import` 可直接导入规范化接口 JSON 或 APK/iOS 目录。`software_compile_web` 将同服务 bfs 工具已有 run 转成能力。耗时操作由独立 worker 执行，`software_stop` 停止本连接任务，`software_resume` 续跑已保存探索。

失败任务同时返回机器可读 `errorCode` 和脱敏 `error` 文本，客户端可区分 SOURCE_CHANGED、INPUT_INVALID、CAPABILITY_NOT_READY 等状态后再决定重发现或修正参数。

### 浏览器探索中的文本准备

compiler16 保留同一页面上已经成功填入并严格回读的文本准备，修复“输入后页面指纹相同，下一步却恢复成空表单”的问题。后续输入或提交前仍复核实际节点与所属表单/搜索组、相关约束、精确值、当前排除策略和目标语义；外置 `form` 关联及提交按钮的覆盖属性也参与检查。普通 DOM、open shadow 与可信配置批准的 closed root 各有身份和作用域，互不借用准备值。正文、节点替换或同名控件不能继承旧准备。

该准备只供当前页面租约内的顺序操作使用，不是新的可自动重放路径。页面关闭、重载、切换种子、所属对象或值漂移后，依赖动作明确记录缺口并返回 partial；恢复任务不会自动重填已尝试的文本，也不会以空值继续提交。普通同态点击或隐藏 JavaScript 状态不因这项优化获得新的重放权限。输入仍需现有 `fillText`/`formExplore` 和动作策略授权，不增加 MCP 参数或写权限。

新增 `inputPrefixes` 标记只记录作用域、动作 ID 和结果，不存 receipt 的输入值或摘要；这些值和身份句柄留在进程内。原有私有配置、页面观察与网络证据仍可能包含业务值，这不是对整个本地 checkpoint 的无原文保证。正式两样本学习仍独立进行，探索用的准备值不计学习样本。

### 原生语义输入的精确回读

WebDriver iOS/Android 的普通可编辑控件在输入前后读取新鲜语义来源，检查唯一目标、类型、只读/secure 属性、同次 element 身份和前台 App。替换输入最终须与完整请求逐码点相等；追加输入须同时保留原前缀并精确匹配新后缀。中文、首尾空格、连续空格、混排及 Unicode 组合形式均不裁剪、合并或规范化。

替换至多一次 clear 和一次 value。clear 后占位提示仍是不可信中间态，不被当作已证实空值；只有最终非占位的完整回读匹配才能成功。占位值歧义、secure、缺少可读 value、禁用/隐藏、身份变化或错误回显会拒绝，已派发的结果保持 unknown/no-retry，不重输或降级为 OCR。文本上限为2048码点，C0、DEL 与 WebDriver 保留键码不作为普通文本发送。

这是语义 provider 返回的码点验证，不证明任意 App 的底层缓冲区、已安装字节或隐藏处理器。纯视觉 `nativeText` 仍是 OCR 输出；当 OCR 已丢掉有意义空格时，不能靠这项验证补回，也不会自动改走另一能力。来源若显式绑定已批准的 HTTP 契约，可另经该能力调用；UI 与 API 业务等价仍需目标自己的证据。

测试中的替换流程为精确验证增加3次 source 回读，追加路径另有对应的前后复核。这项改动提升可验证性，不宣称减少原生端到端耗时。无 API 来源的任意界面、多状态业务与物理设备仍需逐目标验收。

### iOS WebView 的 DOM 通路

compiler24 增加显式 `appium-webview` 后端，将已选中的 iOS WKWebView 接到探索、候选规划、两样本学习、统一调用和独立生成 MCP。它读取网页的 DOM 与实际 `.value`，使用固定 W3C element clear/value/click 命令。能力目录标注 `appium_webview_dom` 和 `fixed_w3c_element_commands`，输出标注 `webview_dom_text_projection`。原生语义控件、OCR 和 WebView 各自保留自己的合同。

设备管理者先创建 Appium/XCUITest 会话，允许目标 WKWebView 被检查，并选择实际观察到的 context/window。后端不会安装、启动、导航、切换 context/window 或执行调用者提供的 JavaScript。compiler25 另增加显式 Android WebView 通路，配置见[Android 说明](android-webview-mcp.md)。iframe、Shadow DOM、跨页流程、select/check、文件上传及写流程仍不在 WebView 通路的执行范围。

从 [设备示例](../examples/software/ios-webview-device.example.json) 创建私有设备配置，替换真实 App、会话、context、window、origin、URL 和已授权控件，再在启动配置 `devices` 中绑定别名。示例中的选择器和参数不用于识别任意网页。输入、按钮和结果必须有唯一 ID 选择器；输入和按钮须属于实际观察到的同一个 form/div/section 组，真实表单 owner 也须匹配。独立结果区可设置 `group:null`。动作还需在 `actionAllowlist` 单独授权为 `effect:"read"`；观察到其他控件不授予操作权限。

发现和候选规划只读，DOM 清单另记录未配置的可见控件、稳定 ID/data-testid 与缺口，扫描至多1024个节点、返回至多256项。候选限一个文档中的线性文本查询：

1. `software_discover({kind:"ios", input:清单或App路径, deviceName:设备别名})`，等待操作结束。
2. `software_workflows({sourceId})`，选取 `planningMode:"webview-dom-linear-v1"` 的候选。
3. `software_bind_workflow` 使用该 `candidateId`、当前来源 revision、两组不同样本和覆盖全部输入的 `resultAssertions`。每个断言绑定候选公开的 `outputTargetId` 与输入 `param`；此通路默认要求结果相对提交前变化，拒绝显式关闭。不接受 `specPath` 注入定义。
4. 从 `software_capabilities` 读取 ready 能力，分别经 `software_call` 和 `software_generate` 返回的入口调用。生成入口仍依赖原有会话、可信配置、私有运行目录与来源 revision。

每次执行重新核对前台 App、rich context 的归属、唯一 window、完整 URL/origin、DOM 控件合同和固定探针版本。iOS 的 `nativeWebTap` 与 `nativeWebTapStrict` 均须为 false；后端只读检查设置。一个 worker 内用真实 element 引用的 `===` 比较文档、body、控件、组和 form owner；同 URL 重载、控件替换或归属漂移会拒绝后续动作。引用仅在该 worker 内有效，不写入 recipe；另一个 worker 新鲜附着后再建立自己的引用租约。

文本采用替换模式，至多2048个 Unicode 码点，不裁剪或规范化中文、首尾/连续空格、emoji 与组合字符。C0/C1、DEL、孤立 surrogate 和 WebDriver 保留按键不作为普通文本发送。学习前检查全部样本；每次输入后检查精确回显，点击前用最近一次完整 DOM 观察重新核对所有绑定字段，防止较后字段事件改写先前字段。W3C 输入和点击可触发多个 DOM 事件；观察间仍存在时间窗口，DOM 回显和结果断言不证明隐藏缓冲区或任意业务等价。

默认归属方式 `reported_bundle_id_v1` 要求 context 返回的 bundleId 与实际前台 App 一致。部分已验证版本的 XCUITest/RemoteDebugger 返回 `process-…` 别名；此时只有设备管理者明确配置以下 profile 才会采用进程关联：

```json
{"association":{"mode":"xcuitest_app_main_pid_v1","reportedBundleId":"process-ObservedAppName"}}
```

将该片段放入 `backend.webview`，名称必须来自实际 rich context。会话可用精确的 `appium:additionalWebviewBundleIds` 暴露该候选，但它本身不证明归属。执行仍要求实际 `mobile:activeAppInfo` 返回正确 bundleId 和有效主进程 PID，且实际 `WEBVIEW_<PID>.<page>` 使用同一主 PID；不接受 WebKit 子进程别名、通配符、手填 PID 或把别名改写为 App ID。私有来源身份分别保留实际 App ID、原始别名和关联方法。该 profile 是已知驱动来源上的观测关联，不是操作系统身份认证，App/驱动更新后需重新验证。

同一 W3C 会话在首个请求前获取设备租约。clear/value/click，以及 Android 固定 focus/insertText，均在派发前记录持久 intent；只有包含最终断言、提取及能力发布的执行范围完成后，独立且完全匹配的完成 receipt 才解除该 intent 的阻断。超时、取消、未知派发或不匹配 receipt 会使后续执行 worker 在发送 HTTP 前停止，不自动重输或重试业务；只读观察不会重放业务。默认记录按会话保存于当前用户的私有临时目录；可用绝对 `backend.intentJournal` 固定位置，其父目录须属于当前用户且权限为0700。遇到 unknown，需设备管理者核对实际业务和会话状态，不能通过删除记录自动恢复。

协议模型与实际模拟器的验收范围分开记录，见[验证记录](software-to-mcp-verification.md)。已有 Appium 会话不证明已安装 App 字节；DOM 探针不证明页面脚本真实可信，公开输出继续脱敏、有界并保留缺口。

### 原生流程的时间预算

`limits.maxDurationMs` 仍是 Python 原生执行器的 UI 预算，缺省 60 秒，须为 1–3,600,000 的整数。compiler15 将可信设备配置与派生时限绑定到同一份私有运行快照；修改原配置文件不会改变已经派发的那次运行。

桥接在原 UI 预算外留 10 秒启动窗口；到达外层时限或收到取消后先请求终止，最多等待 12 秒便请求强制终止，并等待直接子进程退出。退出后的输出管道另有 1 秒收尾上限。这些窗口不增加 UI 动作或重试权限，派发后未确认仍保持 unknown。脱离进程组的任意外部子进程不在完整回收保证内。

例如 UI 预算 480 秒时，Python 外层时限为 490 秒；设备验收辅助代码对每个后台操作设置单一 512 秒轮询窗口，逐次扣除已用时间，进度通知不重置期限。这不是整个多操作验收脚本的总时长，也不表示其他 MCP 客户端自动采用相同等待设置。耗时能力仍返回 operationId；客户端应设置自己的有界请求/轮询期限，并在停止后等待任务实际结束。

### 原生跨屏阶段规划

compiler20 可在可信设备配置中启用 `nativeStagePlanning`，为 Android/iOS 的有限原生语义流程生成 `native-stages-v1` 候选。配置与来源身份绑定；既有 `actionAllowlist` 必须按 selector、动作种类及 `effect:"read"` 另行批准输入、选项与提交按钮。规划设置不会增加动作范围。未配置时继续使用原探索与工作流路径。

```json
{
  "nativeStagePlanning": {
    "workflowId": "native_lookup",
    "seedInputs": [
      {"kind": "type", "selector": {"resourceId": "demo:id/first"}, "value": "demo-first"},
      {"kind": "type", "selector": {"resourceId": "demo:id/second"}, "value": "demo-second"}
    ]
  }
}
```

这是已有设备配置中的字段片段；Android 示例使用 `resourceId`，iOS 可按实际控件使用 `accessibilityId`。`seedInputs` 描述获准探索使用的种子值，后屏字段也在此声明。支持 `type`、`check`、`select`；选择域和每个选项仍须由实际语义控件证明并单独批准。该模式限只读、单一路线、可唯一分组的语义控件，不推测分支、WebView 或自绘界面的业务含义。

通过 `software_discover` 的 `deviceName` 选择预先配置的设备后，调用 `software_workflows({sourceId})` 获取候选，再将发现的 `candidateId`、两组不同样本和逐参数 `resultAssertions` 交给 `software_bind_workflow`。完整验证后，使用 `software_call` 或 `software_generate`。目录读取只读取已保存证据；调用者不能用自填 `specPath` 注入 `stagePlan` 或扩大启动时的授权。

阶段证据绑定实际动作的开始/完成、有序输入准备、阶段观察和迁移事件。每屏提交前复核该屏全部准备值，末端输出另有静态控件合同和参数相关断言；后屏输入不能借用上一屏控件。新阶段证据不保存输入原文、值摘要或节点句柄；这个约束不扩展到原私有设备配置、后端观察及业务结果账本。对种子反射到按钮、标识或祖先元数据的情况拒绝生成证据。

回到入口只允许从唯一匹配已证明的后续阶段开始，逐步验证相邻前屏；未知、歧义或漂移页面不发送自动返回。待确认动作或已有阶段探索记录在任何 App 启动前就拒绝恢复，需另开获准的新探索。未知派发、超时和取消不自动重试。已有动作、深度、时长和步骤限制保留；跨屏隐藏业务状态仍需结果断言和两样本核验，不能由语义合同推定相同。

源码复现见[原生阶段 SDK 测试](../test/software-native-stage-planner.test.mjs)与[证据及恢复反例](../apk_tools/tests/test_mobile_stages.py)。协议夹具、安装包与物理设备的验证范围分别记录在[验证摘要](software-to-mcp-validation.json)，不把协议通过计为真机通过。

### 原生条件分支

compiler22 新增 `nativeBranchPlanning`，让一个 MCP 工作流处理一次分叉后的两条原生页面路径。探索会分别走完两条路径，保存各自的动作和页面证据；执行时先走共同前缀，完成分叉操作后，再读取当前界面。只有一个已观察路径的正向结构合同匹配，且与本次分支参数相符，才执行该路径后续动作。

在可信设备配置中使用下面的字段片段，并按实际 App 替换 selector。它与 `nativeStagePlanning` 互斥；原 `actionAllowlist` 仍须明确批准所有路径中的输入、选项及按钮，选项使用 `kind:"check"` 批准。

```json
{
  "nativeBranchPlanning": {
    "workflowId": "branch_lookup",
    "forkInput": {"kind": "select", "selector": {"resourceId": "demo:id/route"}},
    "arms": [
      {"id": "left", "value": "left", "seedInputs": [
        {"kind": "type", "selector": {"resourceId": "demo:id/query"}, "value": "example-query"},
        {"kind": "select", "selector": {"resourceId": "demo:id/route"}, "value": "left"},
        {"kind": "type", "selector": {"resourceId": "demo:id/detail"}, "value": "example-detail"}
      ]},
      {"id": "right", "value": "right", "seedInputs": [
        {"kind": "type", "selector": {"resourceId": "demo:id/query"}, "value": "example-query"},
        {"kind": "select", "selector": {"resourceId": "demo:id/route"}, "value": "right"},
        {"kind": "type", "selector": {"resourceId": "demo:id/alternate_detail"}, "value": "example-detail"}
      ]}
    ]
  }
}
```

支持两值完整枚举，或 `kind:"check"` 的 `true/false` 分叉。当前为一次分叉、两条路径、无汇合；对应阶段须有相同字段类型和数量，两条路径共享公开输入及输出 schema，物理 selector 可以不同。合并结构最多16节点，参数最多16，每条完整路径仍受3–30步限制。未探索完整路径、第三个枚举值、歧义分组、种子反射到标识或按钮、共享终点及循环均不能产生完整候选。

调用顺序仍为 `software_discover` → `software_workflows` → `software_bind_workflow`。选择 `planningMode:"native-branch-stages-v1"` 的候选，按返回的共同参数 schema 提供每条路径各两组不同样本，总共至少四组；每个参数都要配置 `resultAssertions`。新分支默认要求结果相对本次开始时变化，并与输入关联，显式 `changedFromBefore:false` 会被拒绝。两条路径都通过独立结果验证，才发布一个 ready 能力；随后 `software_call` 和生成的 MCP 工具使用同一个逻辑 schema。

WebDriver 在本模式下要求当前 context 明确为 `NATIVE_APP`，在读取及派发边界复核，不自动切换 WebView。未确认的分叉、错路、歧义、超时、取消或完成记录写入失败会保留 pending/unknown；不会重发分叉或尝试另一条路径。返回入口仅从已证明且前驱唯一的页面逐步校验。协议夹具的通过范围和设备结果分别见[验证记录](software-to-mcp-verification.md)；普通 iOS 键盘视觉输入仍有独立的未通过项。

复现见[两平台 MCP 分支测试](../test/software-native-branch-planner.test.mjs)、[探索证据反例](../apk_tools/tests/test_mobile_branches.py)和[执行及恢复反例](../apk_tools/tests/test_mobile_branch_workflows.py)。

compiler23 的 iOS 原生语义表单排除 `XCUIElementTypeKeyboard` 类，以及 `traits` 中含精确逗号分隔 `KeyboardKey` 角色的节点及其全部后代。解析和实际 XPath 定位采用同一范围，避免键盘辅助按钮混入表单；普通 App 的重名控件仍严格拒绝，不按按钮名、文字或语言隐藏。App 自行声明的同类角色也在此范围之外，这个边界不证明系统键盘身份，也不授权按键。相应能力在 `fidelity.limits` 返回 `ios_keyboard_role_subtrees_out_of_semantic_scope`；视觉键盘路径继续使用其独立合同。回归见[角色边界测试](../apk_tools/tests/test_mobile_ios_keyboard_roles.py)。

自建原生分支演示与设备验收脚本分别见 [Android App](../apk_tools/examples/native-branch-android/)、[Android 验收](../test/android-native-branch-e2e.mjs)、[iOS App](../apk_tools/examples/native-branch-ios/)和[iOS 验收](../test/ios-native-branch-e2e.mjs)。两端从实际输入控件读取参数，另存 App 私有业务账本，供统一与独立生成 MCP 的结果交叉核对。脚本使用新建自有模拟器并清理；需要已有 Android SDK 镜像，或已初始化的 Xcode、iOS runtime、Appium/XCUITest 与匹配的 WDA 构建。它们是有限自建 App 验收，当前各次运行结果及失败范围以[验证记录](software-to-mcp-verification.md)为准。

### 当前页面上的多步骤探索

compiler17 在获准动作完整返回后，为新观察到的语义状态建立新的页面许可。冷启动按钮后出现的表单、普通 DOM/open shadow 中销毁重建的表单，以及通过导航策略检查的跨 URL 页面均可继续探索。closed root 的探索可在成功动作后只读检查新一代节点，再销毁旧许可；缺省参数化工作流仍要求同一次执行内节点稳定。compiler18 的[显式闭根多阶段流程](#显式闭根多阶段流程)另需本地阶段合同与启动授权；不能仅由探索覆盖推导学习/调用通过。

依赖不可重放动作的当前页面链会优先推进；其余可重放状态维持原 BFS/DFS 队列的相对顺序。因此这不是严格全局 BFS。仍显示的旧控件延后处理，只依据真实节点和完整语义比较；同名的新 Next 不继承旧身份。已有动作数、深度、状态数、时长、内存及每后端 CDP 调用预算不变。页面关闭、未知或失败动作、策略拒绝、节点或文档漂移、恢复任务失去许可时，会记录缺口并拒绝自动重放。成功状态的控件也不能证明任意隐藏 JavaScript 状态相同。

### 能力通路与文本回读合同

目录中的 `modality` 与 `fidelity` 由编译器根据实际绑定生成。`modality.channels` 可包含 `browser_dom`、`closed_shadow_dom`、`native_semantic`、`rendered_ocr`、`fixed_ui_actions` 或 `http_wire`。`fidelity.inputText` 描述每个受支持输入参数的回读方式和域；`fidelity.outputs` 描述输出投影。标注以成功执行时的合同为依据，不证明提供者证据的真实性，`sourceCodepointsProven` 保持 false。

DOM 的 value 回显、原生提供者逐码点回报、OCR 呈现文字和 HTTP 编码各有边界。默认 ADB 文本命令没有精确回显保证；有效本地 Unicode IME 才采用对应提供者回读合同。OCR 可能折叠空格，无法由识别结果恢复原始码点。旧合同、私有配方或设备执行配置（后端、控件白名单、时限、视觉策略等）发生变化时须先 `software_refresh` 并使用新的 revision；旧生成入口不能继续执行。启动配置中的写入和学习授权仍按当前值逐次检查：撤销学习权限可保留已批准的执行权限，撤销执行权限则不能由旧配方或设备缓存重新授权。

`software_sources` 的 `routeDiscovery.http.readyPreview` 有界列出同来源已就绪 HTTP 能力的 ID、revision 与 effect，完整内容仍通过 `software_capabilities({sourceId,kind:"http",offset,limit})` 分页获取。它是通路目录，既不会自动从 UI 切换到 HTTP，也不判定两者业务等价。每个调用继续受原来源、方法、凭据和写权限约束。合同变更时来源显示 `refresh_required`，不把旧通路标成当前可用。

## OpenAPI / Swagger

`software_import_openapi({sourceId:"api",documentPath:"/绝对路径/openapi.yaml",documentUrl:"https://example.test/openapi.yaml"})` 支持 OpenAPI 3.0/3.1 和 Swagger 2 的 JSON/YAML 文档。先在启动配置中为该 sourceId 声明 `bindings.api.allowed_origins`；documentUrl 只用于解析相对 URL，不触发下载。

规范提供的 path/query/JSON body 参数、required、枚举、范围和本地引用进入实际调用校验，查询编码同时进入固定调用契约。默认数组使用重复键；正式声明也可选择 CSV、空格、竖线分隔，以及浅对象编码。未显式提供的外部引用、循环引用和未支持的 wire 编码保留候选及具体缺口，不能通过宽松 schema 调用。规范声明记为 static_candidate；真实调用另存验证记录，二者不会混作观测证据。写方法仍由启动配置的精确端点白名单控制。

多文件规范可通过 `referenceDocuments:[{documentUrl:"https://example.test/models/input.yaml",documentPath:"/配置允许目录/input.yaml"}]` 提供明确的 URI 与本地文件映射。每个文件都必须位于 `artifactRoots`；URL 是文档身份，不会触发下载。支持跨文档 path item、parameter、requestBody、schema，以及被引用文档内继续出现的相对和局部 JSON Pointer。相对引用和 server URL 按所在文档解析，规则见 [OpenAPI 相对引用](https://spec.openapis.org/oas/v3.1.1.html#relative-references-in-api-description-uris)。

最多 32 份引用文档，单份 8 MiB、主文档加引用合计 16 MiB；重复身份、凭据 URL、fragment 身份、循环或无法解析的引用不能成为可调用契约。`$id` 资源作用域、命名 anchor 和动态引用暂不展开；指针跳入这些未支持的作用域也会保留缺口。重新导入后的实际参数契约变化会更新 revision，使旧生成入口失效。只提供规范不能扩大可信 `allowed_origins`。引用诊断仅保留摘要，不回传原始引用字符串。

读取上限按实际打开的普通文件及实际字节检查；读取中增长、截断或可检测的替换，以及非法 UTF-8 都会拒绝导入。FIFO 不会作为文档阻塞读取。不存在的主文档或引用只返回固定错误码，不回传文件名与本地路径，失败不推进来源 revision。这些检查不构成对恶意文件系统并发修改的完整原子保证。

这里导入的是本地文档；需先把取得的规范保存进 artifactRoots。默认生成独立来源；传 `merge:true` 和已有来源的 `expectedRevision`，可补充到 Web/APK/iOS 来源，保留原始观测、App 身份、浏览器/移动能力和凭据绑定。补充规范不扩大原调用 origin 范围；同一路径/方法的多份正式契约冲突会保留候选及缺口，不按最后写入者放宽。再次导入同一文档位置会替换该份补充证据；compiler18 的 refresh 会按登记的原件重新编译这些补充规范，见下一节。

规范不支持的 wire 编码和明确不可能满足的 schema 不会发布为 ready 工具，即使 HTTP 方法本身已获准。合并失败或 revision 冲突不会推进当前版本。

查询参数支持 OpenAPI 3 的 `form` 数组/浅对象、`spaceDelimited`、`pipeDelimited` 及 `deepObject` 浅对象；Swagger 2 支持 csv、ssv、tsv、pipes、multi。编码来自文档声明，调用者只传 JSON 值，不能通过调用参数改变编码。示例见 [查询编码规范模板](../examples/software/openapi-query-formats.example.yaml)，格式依据 [OpenAPI 3.1.1 参数序列化规则](https://spec.openapis.org/oas/v3.1.1.html#style-values)。

CSV 分隔符与数据中的逗号分别处理，Unicode、加号、斜线及保留字符编码后发送。空格/竖线/制表分隔的数据若包含同一分隔符，会被公开 schema 和执行器明确拒绝，避免生成歧义请求。deepObject 的嵌套对象/数组不猜测表示；组合 schema、引用及 tuple 中出现未支持的复杂输入时保留候选。展开对象发生参数名碰撞时在请求前拒绝；总查询最多 1000 项、64 KiB。空集合按该格式的未定义值处理，不发送对应字段。

同一文档不同服务器别名归一成相同端点时，会同时比较 schema、查询编码和请求体媒体类型；多份文档的查询编码冲突也不会按最后一份放宽。`query_serialization` / `evidence.querySerialization` 只公开固定编码规则，凭据字段的实际值仍脱敏。enum/const 对象中的凭据常量保持候选，不写进公开 schema。

### 刷新规范原件

compiler18 的 `software_refresh({sourceId,expectedRevision})` 重新读取首次导入登记的主文档及 `referenceDocuments` 本地映射，不沿用旧的规范化副本。独立 API 来源会替换对应契约；合并到 Web/APK/iOS 的正式规范也逐份重读，保留原浏览器/移动能力、来源身份及调用 origin 范围。最多32份补充规范；每组主文档与引用仍分别受单文件8 MiB、合计16 MiB、最多32引用的限制。文档 URL 只作身份与相对解析依据，不触发 URL fetch。

同一次导入或刷新使用跨组共享的读取记录：同一原件的首次字节与文件元数据绑定在同一个有界 descriptor；解析后和发布 current 前复核别名及文件元数据，缓存淘汰后重读时再核对首次内容摘要。已解码文本缓存最多16 MiB，只在本次操作内复用；命中缓存仍计入各组预算，淘汰后重新读取也必须符合首次记录。此缓存上限不是整轮输入总额或整个进程内存保证：一个独立主规范加32份补充可以有33组，各组分别限额。

原件缺失、非法 UTF-8、读取中变化、组间共享引用不一致、超限、解析失败或 revision 冲突均不会切换旧 current，也不会用旧缓存兜底。较晚失败可能留下未被 current 引用的私有衍生产物；是否发布以 current 为准。这是有界读及可检测变化的一致性检查，不承诺任意恶意文件系统的原子快照。旧来源若没有原件 provenance，需明确重新导入，不能猜原路径或退回旧规范化副本。普通 bind/内部重编译不自动重读原件；要更新原件须显式导入或 refresh。

复现见[规范刷新与真实 SDK 测试](../test/software-openapi-refresh.test.mjs)、[文档读取边界测试](../test/artifact-text.test.mjs)和[多文档引用测试](../test/openapi-reference-documents.test.mjs)。刷新本身不发送业务 HTTP 请求；契约变化后旧生成入口拒绝旧 revision，重新生成后再调用。

### URL 编码表单请求体

OpenAPI 的 `application/x-www-form-urlencoded` 请求体会编译成固定字段编码；调用仍传 `{body:{...}}` JSON 对象，由执行器产生实际表单字节。样例见 [表单编码规范](../examples/software/openapi-form-encodings.example.yaml)。例如 `/search-form` 接收：

```json
{"body":{"query":"你好 + &","tags":["a,b","c"],"filter":{"state":"open","minScore":1},"payload":{"rows":[{"id":1}]}}}
```

`tags` 按固定 CSV 规则产生 `tags=a%2Cb,c`，浅对象 `filter` 按 deepObject 展开，`payload` 先 JSON 序列化，再 URL 编码。Unicode、加号和数据中的保留字符也编码后发送。未显式指定 style、explode、allowReserved 时，根据 schema 推导：标量用纯文本，标量数组使用重复键，对象及对象/数组元素构成的数组使用 JSON 字段。显式 `contentType:application/json` 也会把字符串编码为带 JSON 引号的字段。

Encoding Object 只要包含 `style`、`explode` 或 `allowReserved` 中任意字段，就采用 style 规则，包含 `explode:false` / `allowReserved:false` 的情况也一样；此时 contentType 不参与字段编码，记录忽略提示。style 复用查询参数的受支持数组/浅对象规则；Swagger 2 formData 使用 collectionFormat。二进制、文件和 multipart 仍不在这套表单编码范围内。

条件字段按本轮完整 body 验证其固定 when 条件，再选择编码；支持 `dependentSchemas` 的字段存在性、if/then/else 和 anyOf/oneOf 的字段约束，并保留基础及确定祖先约束。示例 `/conditional-form` 中无 flag 的 `{payload:"plain"}` 仍发送纯文本；`{flag:false,payload:{x:"value"}}` 中 flag 虽为 false，字段存在已触发依赖，payload 因此发送 JSON。inactive 分支不会提前把普通字符串加上 JSON 引号。

静态 patternProperties、additionalProperties 与可明确推导的 unevaluatedProperties 可指定动态字段的编码。allOf 中已经评价额外字段的规则不会被根层 unevaluatedProperties 错误覆盖。条件分支内的 additionalProperties、unevaluatedProperties 或 patternProperties 暂保留 candidate 和 `unsupported_conditional_form_evaluation`，不猜测完整评价传播。

表单公开 schema 保留原约束及编码支持域；编码冲突、展开后字段名碰撞、非法输入或超过 1 MiB 均在 HTTP 请求前拒绝。编码规则来自可信来源，不接受调用参数覆盖。POST 仍需全局 `allow_non_get` 与逐端点批准，导入文档不自动授予调用权限。固定规则公开为 `form_serialization` / `evidence.formSerialization`，实际凭据值继续脱敏。表单专项 **7/7** 通过；此前统一软件入口全套 **173/173** 通过；最新改动的整合回归另行记录。

### Multipart 文件上传

正式规范中受支持的 `multipart/form-data` 会编译成固定字段契约。调用传业务文本和内联文件，例如：

```json
{"body":{"title":"示例附件","tags":["demo","文档"],"attachment":{"filename":"sample.bin","base64":"AAEC/w=="}}}
```

规范模板见 [上传示例](../examples/software/openapi-multipart.example.yaml)。OpenAPI 3.0 的 `string/format:binary` 可表示文件；3.1 支持无 `type` 的原始二进制 schema。3.1 的有类型 `string/format:binary` 保留候选，不把仅用于注解的 format 擅自解释为文件传输。文本支持字符串、数字、整数、布尔及其数组，文件数组按相同字段名生成多个 part。字段 MIME 固定于规范；复杂对象、动态字段、自定义 part 头和未支持的 encoding 保留缺口。

单文件最多 256 KiB，总文件 512 KiB，最多 8 个文件、16 个字段和 32 个 part；文本单项最多 64 KiB，完整 body 最多 1 MiB。文件名为有限 ASCII 子集，base64 必须规范编码。调用者不能提供本地路径、远程 URL、任意 MIME 或请求头。POST 仍需精确端点及来源批准，不自动重试上传。

响应保留业务编号、链接等内容，并用本次事务的独立脱敏集合抑制已上传的完整 base64、严格 UTF-8 原文及其精确 JSON/URI 表示；短原文只匹配完整叶子值。它不保证识别任意变换或部分回显。脱敏集合、响应捕获或匹配工作超过固定预算时，在发请求前拒绝。实际二进制响应仍返回摘要。新增编码及字段类型会进入 revision，旧生成入口不会继续使用过期的上传契约。

## 生成物

```
output-software/
  sources/<id>/current.json
  sources/<id>/generations/<revision>/manifest.json
  sources/<id>/generations/<revision>/private/
  operations/<operationId>/status.json
  generated/<id>/<revision>/server.mjs
  generated/<id>/<revision>/manifest.json
  generated/<id>/<revision>/mcp-client.json
```

每份入口绑定该来源 revision，公开分页目录和通用调用工具，并为首批 ready 能力生成带参数 schema 的具名工具；其余能力仍可通过完整目录与通用调用工具访问。入口引用已安装项目的运行时与私有绑定，移动或部署到另一台机器时需重新生成配置。

manifest 只提供公开契约。浏览器 selector、设备会话、凭据、固定样例和执行 recipe 保留在私有路径；模型不能通过改公开 capability target 来改变实际执行目标。JSON schema 的本地引用保留，无法完整投影的契约仍为候选。

## Web

Web 适配器从真实 API 账本与流量恢复方法、query/body 形状、来源与证据。未响应尝试与已观察响应分开；聚合样例数组不冒充真实重复 query 编码。调用范围继承可信 Web 范围或来源绑定，静态 URL 不扩大权限。

浏览器固定路径编译器读取私有断点、journal 和成功动作证据，生成状态导航/固定安全操作。执行前后核对 fingerprint；只用严格唯一 locator，不按相似标签换目标。旧 recipe、输入漂移、缺失控件或不同业务状态明确失败。

状态指纹的诊断摘要只包含各组成部分的 SHA-256、字节长度和适用的数量，不保存诊断原文；最多记录 12 个 frame，并标记是否截断。指纹不匹配时事件记录 expected/actual 指纹及有界摘要供定位，不放宽原有指纹判定。

成功执行后返回 `result.output`：包含有界可见正文、范围内链接，以及 `tables[{caption,columns,rows}]`。读取主文档、开放 Shadow DOM 与范围内可见 iframe；隐藏、排除、越界、裁剪或读取失败的 iframe 保留明确 gap，不读取输入框值。iframe 遮挡使用视口内九点采样，并非对每个像素的证明；部分裁剪的 frame 与暂无法证明来源的 srcdoc 保守省略。主页面与 frame 正文共享 4 KiB 预算。提取后再次核对状态，页面漂移时不会把旧状态附到新内容上。正文与独立链接跳过表格后代，表格统一经受限结构化通道脱敏。输出最多 8 KiB，执行结果最多 16 KiB，并带截断与不可信内容标记。

### Closed Shadow DOM

compiler15 可通过可信启动配置 `webConfig.closedShadowRoots` 显式批准固定 host 链，见 [启动模板](../examples/software/config.closed-shadow.example.json) 和 [流程模板](../examples/software/browser-closed-shadow-workflow.example.json)。默认关闭，仅支持 Chromium 的主 frame；不能从 MCP 调用参数开启或扩大批准范围，动作与网络请求仍需原白名单授权。

每条策略指定唯一 `id`、固定 CSS `hosts` 链和 `maxNodes`；最多 4 条策略、每链最多 4 层，单根默认 128、上限 256 个 DOM 节点。显式 nested host 链可用；不自动遍历未批准 nested 根或浏览器 UA 根。内部定位包含策略与 host 链，不会把闭根中的 `#query` 交给正文定位器。页面保留原 closed 模式，不改 `attachShadow` 或使用 JS click/value setter；隔离读取环境避免页面重写 DOM 原型后把查询引到正文。

当前支持 text/search/textarea 输入、按钮及独立 DOM 文本结果。可由探索证据生成候选，仍须两组变化样本、结果断言和每次实际调用验证；结果 baseline 也保留闭根作用域。每次实际编辑前复核焦点、固定语义、来源、跨 host 祖先排除规则、可见性和命中范围。闭根输入采用真实聚焦、选择、删除与插入事件，页面事件处理器可能产生副作用；几何与派发仍不原子。

缺省工作流中，同一次执行的 host 或目标节点被重建会拒绝，业务更新重建结果 DOM 也一样。跨 frame、select/check、ARIA 选择器、视觉步骤及表格提取等组合暂不支持，并在动作前拒绝。某次闭根探索动作已尝试但未成功确认时，整个 run 的恢复会拒绝，避免从其他 frontier 重复未知业务；单独的已验证调用也不自动重试。不能据有限示例推导任意封装组件或站点兼容。

#### 显式闭根多阶段流程

compiler18 可为 Start → 表单 → 下一表单 → 独立结果这类真实重建流程建立参数化 MCP。显式路径由 owner 提供完整本地 spec，再通过 `software_bind_workflow` 的 `specPath` 学习；compiler19 的自动候选路径见下节。来源启动配置另按精确 workflow ID 授权，和写入执行/真实学习授权分别管理，例如：

```json
{
  "workflowPermissions": {"console": {"allowClosedStages": ["closed_search"]}},
  "webConfig": {
    "actionProfile": "forms",
    "fillText": true,
    "closedShadowRoots": [{"id": "lookup", "hosts": ["#lookup-widget"], "maxNodes": 128}],
    "actionAllowlist": ["closed::lookup::#start", "closed::lookup::#query", "closed::lookup::#search"],
    "requestAllowlist": [{"method": "POST", "url": "https://console.example.test/api/search"}]
  }
}
```

`console` 是 sourceId，`closed_search` 是本地 spec 的 id。`allowClosedStages` 不能由 spec、MCP 参数或 webOptions 授给自己，也不代替原动作/网络/导航范围或写权限。每次编译学习和调用都检查该授权；改启动权限后仍按新的服务配置与 revision 使用，旧生成入口的私有配置快照不会因编辑别处文件而即时改变。

在完整 spec 中设置 `executionMode:"closed-stages-v1"`，并增加 `closedStages`。以下只展示阶段字段：假定原 `steps` 为第0步 click Start、第1步 fill query、第2步 click Search，`entry.url` 为同一固定入口。完整 inputSchema、两组变化样本、绑定步骤及独立结果断言/提取仍必需。

```json
{
  "id": "closed_search",
  "executionMode": "closed-stages-v1",
  "closedStages": {
    "schemaVersion": 1,
    "stages": [
      {"id":"entry","startStep":0,"document":"initial","url":"https://console.example.test/","anchors":[
        {"selector":"closed::lookup::#phase","framePath":[],"closedShadow":{"schemaVersion":1,"policyId":"lookup","hosts":["#lookup-widget"],"selector":"#phase"},"tag":"h2","text":"Entry"}
      ]},
      {"id":"form","startStep":1,"document":"same","url":"https://console.example.test/","anchors":[
        {"selector":"closed::lookup::#phase","framePath":[],"closedShadow":{"schemaVersion":1,"policyId":"lookup","hosts":["#lookup-widget"],"selector":"#phase"},"tag":"h2","text":"Search form"}
      ]},
      {"id":"complete","startStep":3,"document":"same","url":"https://console.example.test/","anchors":[
        {"selector":"closed::lookup::#phase","framePath":[],"closedShadow":{"schemaVersion":1,"policyId":"lookup","hosts":["#lookup-widget"],"selector":"#phase"},"tag":"h2","text":"Complete"}
      ]}
    ]
  }
}
```

阶段计划版本为1，共2–31个有序阶段，每阶段1–8个固定文字/tag/闭根锚点。首阶段从0开始、`document:"initial"` 且 URL 等于 entry；末阶段从 `steps.length` 开始，表示最终点击后仍要验证终态。其余阶段只能紧接一个已批准 closed click，明确声明 `document:"same"` 或 `"new"` 和固定完整 URL；相邻阶段要有不同语义锚点或 URL，不能把同态点击当成新阶段。跨 URL 新 document 仍须原导航、请求和认证批准，不能跳过入口直接调用后续页面。

只有本次物理 click 完整成功，并通过认证、对话框、请求和原总预算检查后，执行器才读取一次只读新 generation。新语义、document/URL、当前阶段全部控件与已学习合同都匹配，复读也未漂移，才提交新阶段。阶段内 host/target、owner、语义和实际输入回读仍须稳定；新 document 不继承旧输入 receipt。未知、超时、遮挡、错误导航、身份或权限变化不会晋升或自动重试。每个可变参数须在两组不同样本中变化并由独立结果验证，所有阶段完整通过才发布 ready；新阶段 recipe 与旧整次执行合同分版本。

同 document 的有界内存记录保留已观察元素的最近所属 root：不能先把另一个批准根的控件移入隐藏容器，再借后续重建洗白来源。原本指向同一实际 root 的策略别名同源，嵌套祖先不冒充最近 root；旧独立根也不能合并成一个域来继承 foreign 控件。自己批准根内的合法控件复用可继续，失败候选/rollback 不清历史；只有已验证的新 document 才清旧 document 来源。记录不写入 recipe 或 checkpoint，不存输入值/摘要；它不证明尚未观察到的节点历史或浏览器原子性。

当前所有配置的 roots 在每阶段都须存在可见，同 document 的 host shell 语义固定；form/search owner 若存在须有固定唯一 id。仅支持既有 closed 原生 text/search/textarea、button 与普通文字结果，不扩 frame、select/check、ARIA、visual 或 table 权限。原4 roots、4层 host、256节点/根、4096 CDP调用/backend、30步及总动作/请求/时长限制不变；来源记录溢出会拒绝，不删旧记录续行。完整验证证书最多1 MiB，超限不写新证书或 ready。

[真实闭根销毁重建 SDK 与负例测试](../test/software-closed-multistage.test.mjs)包含两样本、统一新值、生成第四值，以及跨批准根搬迁、阶段前隐藏洗源、同根合法复用、未知派发、超时、错误 document 和预算/证书上限反例。跨 URL/new-document 另有真实浏览器 direct compile/execute 测试，其证据范围与独立生成入口分列。默认旧工作流不会因新增此模式而自动重绑。

#### 自动规划闭根多阶段候选

compiler19 可从一次完整成功探索中生成阶段计划，无需手写完整 `closedStages`。启动时显式设置 `webConfig.closedStagePlanning:{"workflowId":"closed_search"}`，并保留已批准的 roots、动作和请求范围。`workflowPermissions.console.allowClosedStages:["closed_search"]` 仍是学习和执行所需的独立授权；规划开关本身不授予执行权限，MCP 的 `webOptions` 不能启用或更换该设置。

例如 Start → 填写 first → Next → 填写 second → Search 的探索完成后，调用 `software_workflows({sourceId:"console"})`，选择 `planningMode:"closed-stages-v1"` 的候选。候选 ID 与本地 workflow ID 分开，前者绑定来源和实际路径，后者用于精确本地授权。使用返回的 `candidateId`、来源 revision、两组所有参数均变化的 `samples`，以及分别关联每个参数的 `resultAssertions` 调用 `software_bind_workflow`；随后仍须通过实际学习才会出现 ready 能力。

规划器只接受完整连续路径：每次填写须有真实成功执行，完整填写序列与随后点击的执行事件严格绑定，并保持原顺序；删除、重复、重排或借用其他执行证据都会留下缺口。阶段使用当前批准根内可见、唯一且固定的标题锚点和实际 document 关系；包含排除后代或已知敏感/输入回显的标题整体省略，不裁字伪造锚点。新增阶段观察不保存输入值、其摘要或浏览器节点句柄。最终必须观察到独立文本结果目标，输入框的 status 标签不能替代结果。一个授权 ID 对应多条不同合格路径时拒绝自动选择。

当前自动路径的真实 SDK 正例是同 document 销毁重建、两个参数的两样本学习及统一/生成调用；同阶段双字段加下一阶段字段的三个参数仅验证探索候选，自动跨 document 导航尚未完成该闭环实测。当前自动路径限主 frame 中已批准 closed text/search 输入与点击构成的有界直线流程，最多8个输入、30步。它不推导未知条件分支、跨 frame、select/check 或任意组件的业务含义；既有阶段执行守卫、双样本及逐次独立结果验证继续适用。复现与边界见[自动阶段规划测试](../test/software-closed-stage-planner.test.mjs)和[启动策略测试](../test/closed-stage-planning-policy.test.mjs)，实际回归与设备状态分别记录在验证摘要中。

## 参数化流程

新探索会保留字段名、关联标签、HTML 必填/范围/长度/选项、外置 form 关联，以及结果区域候选；同一区域的结果定位扫描复用缓存。`software_workflows({sourceId})` 从这些私有证据识别搜索/筛选候选，公开输入 schema、outputTargets 标识与缺口。私有选择器不进入目录；旧库存没有约束时不会猜测字段必填。

浏览器候选可直接通过 MCP 验证：

```json
{
  "name": "software_bind_workflow",
  "arguments": {
    "sourceId": "demo",
    "expectedRevision": "从候选列表取得的来源revision",
    "candidateId": "从候选列表取得的id",
    "samples": [{"query": "alpha"}, {"query": "beta"}],
    "outputTargetId": "所选结果区域id",
    "assertParam": "query"
  }
}
```

多字段候选使用 `resultAssertions` 数组，替代旧单字段的 outputTargetId/assertParam；每个绑定参数都要对应已发现的结果区域。每项为 `{outputTargetId,param,representation?,valueMap?,separator?,timeoutMs?,changedFromBefore?}`。Web 的 `representation:"optionLabel"` 从实际 select 读取显示标签，输入 schema 的 enum 仍保留真实提交值；布尔/枚举可用覆盖完整值域的 valueMap 说明显示文本。数组可声明分隔符，多选按原生选项顺序比较。不能把其它表单的结果 ID 用到本候选。

复杂流程也可传 `specPath`，模板见 [浏览器定义](../examples/software/browser-query-workflow.example.json) 与 [启动配置](../examples/software/config.workflows.example.json)。浏览器 spec 自带两组样本；每个可变参数都须变化，并有参数相关的结果断言。const/单值 enum 保留原约束、无需伪造第二个值，整体样本仍须不同。步骤支持填值、原生选项与复选框、点击；输出可提取文本和表格。HTTP 查询可以使用明确批准的 POST；纯前端计算不要求伪造网络证据，`networkEvidence:"required"` 才要求成功响应。

原启动配置必须批准输入/按钮和实际请求，spec 不能新增范围、凭据或批准项。调用者也不能用 webOptions 替换启动时的批准规则。验证和执行按控件契约、原生约束及结果断言核对，允许合法的参数/结果变化；不再用包含结果文字的整页指纹阻断参数化调用。旧固定流程仍使用完整指纹。

移动流程可使用 [移动定义模板](../examples/software/mobile-query-workflow.example.json)，同一工具传 `specPath` 与 `samples` 数组；也可用 `software_workflows` 读取已绑定设备及既有探索库存，发现多字段、跨状态查询候选，再用 candidateId 和 resultAssertions 学习。规划只观察界面，不点击；必须已有明确允许的输入与 read 按钮。字段仅按真实且唯一的稳定父容器分组，不按坐标拼接独立表单。原生库存缺少业务约束时只声明有界字符串，并保留约束缺口；原始 inputType 单独记录，不猜业务必填或数值约束。

跨页面候选的私有 entryPrefix 来自已记录 read 路径；库存摘要、身份、状态连接和成功事件必须一致。每组样本和调用先恢复入口，再逐步校验真实路径。缺失或截断证据不补造前缀。原生 resultAssertions 当前支持参数值关联及显式变化检查，不支持 Web optionLabel/valueMap/数组分隔转换；不支持的表示会明确拒绝。

Android/iOS 后端执行替换输入、点击/滑动、断言和类型化提取；每步校验前台 App、唯一选择器及学习时的控件合同。两组不同输入与不同结果实际观察后才发布 ready。自动候选仍限 read；可信本地定义也可在单独批准后声明 write。可生成的输入、控件和断言有文档化子集，尚未自动规划所有移动业务。

验证完成会更新来源 revision；重新读取能力后，用 `software_call` 或生成入口传入新参数。定义、样本和执行 recipe 留在私有目录。浏览器验证证书按能力与 revision 不可变保存，后续学习的 CAS 冲突不会覆盖已发布版本的证书。配置断言与类型正确不自动证明后台结果新鲜度或任意业务语义。

异步结果应提供可观察的关联条件。浏览器断言支持 `timeoutMs`（默认 3000、最多 10000）与 `changedFromBefore:true`，会在入口和最后一个提交点击前分别捕获基线，在等待中核对预算、认证、范围与唯一目标；提取前后结果发生变化时拒绝旧数据。移动断言支持 `equalsInput` / `containsInput` 引用本轮参数，或 `changed:true` 要求目标相较本轮动作前的基线发生变化。两端都不会为等待结果重复点击。

仅匹配结果格式不会被标记为新鲜；移动执行结果的 `resultFreshness` 会分别记录输入关联及变化证据。同值重复查询没有可见变化时，显式 changed 会超时，需选择实际请求标记或结果版本作为断言目标。UI 变化和参数关联仍不自动证明服务器完成了本次业务。

### Canvas 视觉流程

像素绘制的表单可使用可信本地 spec 配置 `visualFill` / `visualClick`，由本地 Tesseract 或 macOS Vision 从截图识别固定文字锚点。`visualFill` 的 `param` 或固定 `value` 仍受输入 schema 限制；`visual.valueRegion` 是实际输入后的独立回读区，OCR 回读须等于本轮值。业务断言用 `visual:{region:{x,y,width,height}}` 读取另一块结果区，可结合 `textIncludesParam` 和 `changedFromBefore`；提取类型为 `kind:"visualText"`，返回 `provenance:"local_ocr"` 与 `untrusted:true`。OCR 内容是观察数据，不能自行批准动作或证明业务成功。

坐标均相对于 Canvas 截图归一化到 0–1；动作的 `visual.anchor` 是精确且唯一的文字锚点，`offset:{x,y}` 是固定的归一化偏移。输入回读区与结果区应独立；不能用同一 Canvas 的别名选择器把输入回显冒充结果。执行会核对学习时的宿主尺寸与锚点位置、点击前的画面是否改变，以及目标与父 frame 的遮挡情况。当前需要唯一可见的 Canvas 宿主；CSS 变换、低置信度/歧义锚点、未覆盖的视觉或动画变化会拒绝，尚非任意图片、自绘原生 App 或关闭 Shadow DOM 的通用操作器。

视觉合同 `schemaVersion:2` 对解码后的整张 Canvas 像素建立指纹；只遮罩同 selector、同 frame 中此前已填写并回读的输入区，结果区不作为动态遮罩。同一区域多次输入以最后一次为准；当前输入区及动作锚点不得与其他遮罩按像素重叠，点击点也不得落入遮罩。`visualClick` 必须落在当前 OCR 锚点文字框内。每个后续视觉动作前使用同一张 OCR 截图重读此前关联的输入值；检查后仍会核对画面，发生变化则拒绝动作。不同 selector 的别名不自动视为同一宿主，动态时间、动画或光标等未遮罩变化可能导致保守拒绝；画面一致也不能证明隐藏处理器语义未变。

PNG 使用 `pngjs` 7.0.0 解码，按上限校验完整压缩流、chunk 与 CRC；图片最多 1600 万像素、16 MiB，不接受交错 PNG。旧视觉合同缺少像素证据，需重新学习；当前编译器版本见[公开验证摘要](software-to-mcp-validation.json)。

声明 `changedFromBefore:true` 的 DOM、ARIA 与视觉流程在最后触发动作前另取结果基线，防止输入时已更新的结果令无操作触发通过；提取后还会复核结果。该变化仍是时间上的证据：异步结果更新可能独立于触发动作，不能据此证明因果或后台业务完成。同一结果验证阶段中，同一 Canvas 的多个结果区域共享一次截图与 OCR；缓存仅限当前阶段，不跨动作或断言轮次复用。复用时固定 ElementHandle 并检查当前节点仍是同一宿主，替换则拒绝；触发前基线、触发后断言和提取后复核各自保留。

执行结果的 `observation.visual` 返回 `captures`、`ocrCalls` 与 `ocrMs`；前两项统计用于 OCR 的截图和识别调用，`captures` 不包含所有新帧/像素复核截图。双字段、双结果区域夹具中，每个样本和执行的识别次数由 15 次降至 10 次，HTTP 参数与提取结果一致。可在已安装 Chromium 和英文 Tesseract 的环境运行 `node scripts/benchmark-visual-ocr.mjs`；对照副本仅绕过两处结果缓存调用，不代表历史版本。一次固定顺序测试的耗时随本机负载和模型变化，详见 [视觉识别开销](software-to-mcp-verification.md#视觉识别开销)。

启动配置 `webConfig.visual` 包括：

```json
{
  "engine": {"type":"tesseract","executable":"/absolute/path/to/tesseract","tessdataDir":"/absolute/path/to/tessdata"},
  "language":"eng",
  "minConfidence":0.6,
  "actions":[{"kind":"visualClick","selector":"#screen","visual":{"anchor":"Search"},"effect":"read"}]
}
```

`engine` 的路径与语言模型由本机可信配置提供，`tessdataDir` 可省略；`language` 支持已安装语言组合，`minConfidence` 范围为 0–1。可用模型通过 `tesseract --list-langs` 核对，缺模型会报 `OCR_LANGUAGE_UNAVAILABLE`。仓库的 Tesseract 验收覆盖英文；macOS Vision 已实际验证简体中文和英文 OCR。繁体中文仅确认在系统支持列表中，识别质量尚未验证。

每个视觉动作都须在 `visual.actions` 中按 kind、宿主 selector/framePath、完整锚点配置和 effect 精确批准；原有 `actionAllowlist`、forms/填值许可、导航与请求范围仍有效。写流程继续要求独立执行及学习许可。MCP 调用者只能传业务参数，不能通过参数选择 OCR 引擎、锚点、坐标或扩大权限。

示例：[流程定义](../examples/software/browser-visual-workflow.example.json)、[启动配置](../examples/software/config.visual-workflows.example.json)、[纯像素 Canvas 演示](../examples/software/visual-canvas-demo.html)。`npm run demo:visual` 启动本地演示服务后，使用该可信配置探索来源，再以 `software_bind_workflow` 的 `specPath` 绑定示例；也可通过下述可信配置产生自动候选；仍可使用固定 spec。真实纯像素演示已完成两样本、统一与生成入口调用，结果为 RESULT delta 4；输入回显跨区域与父 iframe 遮挡两项 P1 反例已修复复验。视觉流程 5/5、本地 OCR 4/4、frame/区域专项 4/4（含截图预算）共 13/13 通过；这些证据覆盖固定可信视觉合同，仍不证明任意视觉页面完整可操作。

#### 中文 OCR 与自动候选

macOS 可编译仓库自带的 Vision helper 到本机私有目录，编译后在可信启动配置中提供二进制的**绝对路径**：

```sh
mkdir -p ./output-tools
/usr/bin/xcrun swiftc scripts/visual-vision.swift -o ./output-tools/vision-ocr
```

例如 `webConfig.visual` 使用 `{"engine":{"type":"vision","executable":"/absolute/path/vision-ocr"},"language":"chi_sim+eng","minConfidence":0.3,"actionMinConfidence":0.8}`。其中 `chi_sim`、`chi_tra`、`eng` 映射到系统语言，程序先核对 Vision 实际支持的语言。此处 0.3 的结果阈值及 0.8 的动作锚点阈值只对应实测夹具：系统对“结果 香蕉”给出的置信度约为 0.3；其他页面应依据自身识别质量配置，不能把较低置信度当作业务成功证明。未单独指定 `actionMinConfidence` 时，它继承 `minConfidence`。

在已有 `visual.actions` 和原 `actionAllowlist` 基础上，还可在可信配置中增加固定结果区域：

```json
"outputs": [{"selector":"#screen","region":{"x":0.03,"y":0.65,"width":0.94,"height":0.3},"label":"查询结果"}]
```

当同一已证明入口的 Canvas 仅有一个获批只读 `visualFill`、一个查询 `visualClick` 和不重叠的结果区域，`software_workflows` 可组合出候选。多字段可在可信 `visual.groups` 中显式绑定，见[多字段配置模板](../examples/software/config.visual-groups.example.json)：

```json
"groups": [{"id":"lookup","inputs":[0,1],"click":2,"outputs":[0]}]
```

索引从 0 开始，`inputs`、`click` 分别指 `visual.actions` 中的输入与点击，`outputs` 指 `visual.outputs` 中的结果区。每组 1–8 个输入、一个点击、1–5 个结果，必须同一 selector/frame、均为 read 且输入/结果区域不重叠；原动作白名单仍须批准。没有明确分组时，不会猜测多个输入或点击的关联。

候选仍为 `candidate`，需两组不同样本和每个参数的结果关联及变化断言。例如候选返回参数 `Query`、`Extra` 和结果 ID `RESULT_ID` 时，绑定请求需包含 `resultAssertions:[{"outputTargetId":"RESULT_ID","param":"Query","changedFromBefore":true},{"outputTargetId":"RESULT_ID","param":"Extra","changedFromBefore":true}]`；`RESULT_ID` 应取自该候选实际返回的 `outputTargets`。真实双字段 Canvas 已通过学习、统一入口与生成入口调用；这不证明任意视觉页面可自动规划。

### 移动视觉观察

在统一入口可信启动配置中，先为来源绑定 `devices` 中的设备配置，再按同一 `sourceId` 启用 OCR：

```json
"nativeVisual": {
  "my_app": {"engine":{"type":"vision","executable":"/absolute/path/vision-ocr"},"language":"chi_sim+eng","minConfidence":0.3}
}
```

也可配置 Tesseract，或省略 `engine` 使用本机默认 Tesseract。来源完成发现并读取当前 revision 后，调用 `software_observe_mobile({sourceId:"my_app",expectedRevision:"当前revision"})`，再使用 `software_operation` 查询后台结果。为该来源生成入口后，入口提供无参数的 `observe_mobile()`，通过 `operation_status` 查询。观察不执行界面动作，截图前后核对前台 App 与适用的安装身份；已有 iOS WebDriver session 本身不能证明安装包字节。

返回 `capturedAt`、图片尺寸和哈希、有界 OCR 文本与置信度、像素坐标、身份状态和缺口，标记 `untrusted:true`。已知凭据会检查跨 OCR 分词的泄露并脱敏；原始截图和识别产物保存在私有目录，不通过工具公开。截图可能包含系统界面或其他窗口，且只是采集时的历史观察；任何后续动作都要重新验证当前界面，不能直接把坐标当成已批准控件。Android/iOS 自建模拟器已分别完成直接真实截图与 OCR 验证。

#### 同图 Vision ROI

可信原生 OCR 配置 `nativeVisualWorkflow.ocr.engine`（或底层观察 API）可选 `regions`，不由 MCP 调用参数提供：

```json
{"type":"vision","executable":"/absolute/path/vision-ocr","regions":[{"x":0.1,"y":0.1,"width":0.3,"height":0.2}]}
```

区域使用原图左上角归一化坐标，必须为 1–8 个有限、有效且按外扩整数像素不重叠的矩形。每次先识别整图，再对同一份原始图片执行 ROI；原图 SHA、尺寸和返回坐标仍属于原图，Vision 的 ROI 相对框会映射回原图。整图及所有 ROI 共享总时限、token 与产物预算，增加区域也会增加识别成本。未配置 `regions` 时保留原参数和行为；当前浏览器 `webConfig.visual` 配置入口不接受该选项。

融合保留 ROI 外及跨边界的整图文字，原始整图与区域结果保存在私有证据中。区域内已有文字时，仅同序、逐 token 文本完全一致才可细化框和置信度；冲突返回 `OCR_REGION_CONFLICT`，不能用较高分删掉异议、把 `NotQuery` 裁成 `Query` 或拆词制造新锚点。真实同截图对照中混排的 `Query` / `北京` 从 0.5 到 1，但这只是该截图的识别证据，Android 动作阈值 0.6 没有下调，也不等于设备业务闭环。

公开复现见 [融合反例测试](../test/visual-observation-regions.test.mjs)、[实际已知像素坐标测试](../test/visual-vision-regions.test.mjs) 和[中文设备模板](../examples/software/android-visual-chinese-device.example.json)。前者含伪引擎边界测试，后者在 macOS 实际编译、调用 Vision；两者的证明范围不同。

#### 保留原生分隔信息的 Tesseract

Android/iOS 的可信 `nativeVisualWorkflow.ocr` 可显式配置 `{"engine":{"type":"tesseract","executable":"/absolute/path/tesseract","tessdataDir":"/absolute/path/tessdata","nativeText":true},"language":"chi_sim+eng"}`。此选项不从 MCP 调用参数接收；默认 TSV、Vision、Web 配置及移动只读观察配置保留各自支持范围。本地须已安装对应语言数据。

同一次识别分别输出 TXT 与 TSV，保留引擎自己的文字、分隔信息、原词置信度和坐标。只有原文中零分隔的相邻词会合成连续片段；真实空格和换行在结果区域内保留。完整原文与原词、位置或顺序对不上时拒绝，低置信或跨界片段不会被删掉后补成期望结果。原生文本仍是 OCR 推断，不证明应用源字符串或业务正确。

此模式依赖 POSIX 文件资源限制，并使用私有目录中的独立输出文件；不支持相应限制的平台会明确拒绝。默认识别路径不依赖此选项。协议、范围及保护反例见 [Node 测试](../test/visual-native-text.test.mjs) 与 [Python 测试](../apk_tools/tests/test_mobile_visual_native_text.py)。离线图片重放不能替代完整设备调用验收。普通 iOS 软键盘的词过滤视图暂未接入此原生文本合同。

### Android 原生视觉动作

Android 16 / API 36 的 ADB 后端可用固定文字锚点执行枚举选择或受限文本替换，并从独立结果区域读取本地 OCR。自绘界面没有可访问标签时也可通过同一 `software_bind_workflow`、`software_call` 和生成入口调用；它不是任意业务自动规划。

先构建可信本地触摸辅助程序：

```bash
python apk_tools/visual_helper/build.py --sdk /absolute/android-sdk --out /absolute/targettap.jar
```

辅助程序使用 Android 的目标 UID 注入，系统可拒绝投递给其他 UID；只支持实测 API 36。设备配置参照 [设备模板](../examples/software/android-visual-device.example.json)，替换设备、App、APK 与辅助程序 SHA-256；模板的全零摘要为占位值。`nativeVisualWorkflow.approvedDefinitions` 将工作流 ID 绑定到可信定义文件，定义内容必须与请求及执行 recipe 完全一致，不能仅凭同名 ID 换锚点或改意图。该文件必须在启动配置的 `artifactRoots` 内，设备配置仍由可信 `devices` 绑定。

按 [定义模板](../examples/software/android-visual-workflow.example.json) 调整实际 Activity、文字和归一化结果区。完成 APK 发现后，用来源当前 revision 调用 `software_bind_workflow`，指定 `specPath` 和两组不同样本，例如 `[{"choice":"alpha"},{"choice":"beta"}]`。只有已实际学习的两项进入公开枚举，其余声明选项不能调用。写意图仍需独立的执行及学习许可；MCP 参数不能选择锚点、修改定义或更换辅助程序。

设备租约覆盖截图、OCR、窗口检查、触摸与结果验证；会核对 APK 字节、前台 App、UID、窗口和画面。点击点必须在唯一 OCR 锚点内。与浏览器输入遮罩不同，这条受限流程仅对可信独立结果区作动态遮罩，且它不能覆盖已学锚点；该区域内的其他像素变化不能由指纹检测。窗口检查与派发非原子，同 UID 透明窗口和隐藏事件处理器的业务含义仍无法证明。

原始图片和 OCR 文件保持私有，公开文字按同源凭据（包括分词或标点遮盖）脱敏后限制为 4 KiB，并标为 `untrusted:true`。触摸开始前保存 unknown 意图；派发后缺结果或连接中断保持 unknown、不重试。结果没有变化也不能冒充新执行成功。

真实自建 Android 16 模拟器已完成 APK 发现、两样本绑定、统一调用返回 `RESULT ALPHA` 和独立生成入口返回 `RESULT BETA`；未学选项、旧 revision、重复结果、已存在透明遮挡分别验证。一次后续复验发生 ADB 断连，保留 unknown 与辅助程序清理缺口，不能将一次成功推广为任意设备可靠性。复验入口为 `npm run test:android-visual-workflow`，使用隔离 ADB 和新建模拟器，不修改现有设备。当前证据不含物理设备或任意第三方 App。

#### Android 文本替换

[文本定义模板](../examples/software/android-visual-text-workflow.example.json) 使用 `mode:"text-replace"`，以 `inputName` 命名参数；`inputSchema` 必须明确 `type:"string"`、`minLength`、`maxLength` 和 `pattern`，长度上限 128，输入按可信约束完整匹配。`focusAnchor`、`submitAnchor` 是不同的固定文字锚点，`valueRegion` 和 `resultRegion` 是不重叠的归一化区域。样本如 `[{"query":"alpha"},{"query":"beta"}]`，须是两个不同值。该模式只支持替换，不支持追加。

[文本设备模板](../examples/software/android-visual-text-device.example.json) 中的设备序列、APK SHA-256、目标 App、Node、辅助 JAR 及其 SHA-256、可信定义绝对路径和 IME APK SHA-256 均是占位项，使用前须替换。IME `unicodeInput.component` 必须对应实际安装的受信 IME；不能把全零摘要当作真实验证。`nativeVisualWorkflow.ocr` 可省略，默认 Tesseract `eng`；也可从可信配置指定 `{"engine":{"type":"tesseract"},"language":"eng"}`，或提供经本机验证的 Vision 可执行文件及语言。OCR 不从 MCP 参数接收。原有固定枚举模板不变。

输入焦点后执行全选替换，并从新截图回读输入；输入法回执不等于成功。提交前重读结果基线，结果须变化并关联输入。第四轮自建 Android 模拟器验收中学习 alpha/beta，统一调用 gamma、生成入口 delta；输入法假成功、输入时更新而提交无操作、同 UID 透明覆盖三个反例均实际验证。前三轮失败或未触及反例的记录保留。已通过的完整设备视觉闭环覆盖英文 OCR 和拉丁文字。compiler12 的中文混排夹具已完成同图 ROI 离线识别验证，第五轮设备运行因 ADB/总预算失败；第六轮第二样本已实际更新结果，但区域坐标约 0.0000004 像素的数值误差经取整触发严格 OCR 拒绝。仅区域映射的近整数数值修正已复核，真实 1 像素外伸仍拒绝；第九轮在四核自建模拟器上已完成北京/上海两样本并发布 ready，但统一调用广州时，整图单词“Query广州”与区域分词冲突，尚未提交；独立生成入口和本轮负例仍未通过。ready 不保证所有新输入均成功，不能由学习通过推导双入口闭环。不能与已通过的 Android 语义控件 Unicode 输入混称。中文复验使用[公开设备脚本](../test/native-visual-chinese-device-e2e.mjs)及[定义模板](../examples/software/android-visual-chinese-workflow.example.json)。输入区和结果区的遮罩、窗口检查与派发间竞态、同 UID 隐形处理器以及业务因果均不能由此消除。

### iOS 原生视觉动作

自建 iOS 27.1 模拟器中，固定枚举视觉动作已经真实通过 Appium/XCUITest/WDA、统一及生成 MCP。`software-to-mcp-11` 已将无语义树视觉文本替换接入相同 iOS 入口；文本流程已通过独立的自建模拟器完整验收，范围和边界见下文。使用 [iOS 定义模板](../examples/software/ios-visual-workflow.example.json) 和 [设备模板](../examples/software/ios-visual-device.example.json)：定义无 Android `activity`，设备需绑定已有 iOS WebDriver session 和实际 bundle ID，`nativeVisualWorkflow.approvedDefinitions` 指向可信定义的绝对路径；不要填 Android 的 `expectedArtifact`。节点路径、session、bundle 与来源 ID 均须替换为实际配置，批准文件须在 `artifactRoots` 内。

绑定两组不同样本 `[{"choice":"first"},{"choice":"second"}]` 后仅公开已学选项。执行检查设备租约、前台 bundle、方向与截图/窗口坐标比例、唯一锚点、布局指纹及派发前新帧；结果来自独立区域。模拟器统一调用返回 `RESULT FIRST`、生成入口返回 `RESULT SECOND`；非法选项未新增动作。追加真实模拟器复验中，同值结果在一次点击后返回 `VISUAL_RESULT_NOT_VERIFIED` 和 unknown/no-retry；前台切至其他 App 时在点击前拒绝。已有 WebDriver 会话无法证明安装字节；前台 bundle 也不能证明点击点所属窗口或事件处理器，检查与派发仍有竞态，截图可能包含系统或其他窗口，不能外推物理 iPhone 和任意 App。

#### iOS 文本替换

[文本定义模板](../examples/software/ios-visual-text-workflow.example.json) 使用 `mode:"text-replace"`，沿用 iOS `native-visual-workflow` 定义，不含 Android `activity`。`inputSchema` 明确 string、最小/最大长度与完整匹配的 `pattern`，上限 128；`focusAnchor` 与 `submitAnchor` 不同，`valueRegion` 与 `resultRegion` 不重叠。仅支持替换，不支持追加。按 [文本设备模板](../examples/software/ios-visual-text-device.example.json) 将来源、bundle ID、已有 session、Node 和可信定义绝对路径替换为实际配置，批准定义须在 `artifactRoots` 内。完整批准定义、来源/App/session 身份、recipe revision 和原写执行/学习双层权限均会继续核验。

通过来源当前 revision 调用 `software_bind_workflow`，指定 `specPath` 和两个不同样本，例如 `[{"query":"alpha"},{"query":"beta"}]`。学习先根据 OCR 锚点聚焦，再经 Appium 的 `mobile: keys` 发送 Command+A/Delete，再按可信 maxLength 执行一次有界退格清除，确认空值后向公开 session `/keys` 路由发送文本；`/wda/keys` 仅是驱动内部 WDA 路由，不能直接发给 Appium。清除后必须观察输入区为空，输入后必须从新截图完整回读本轮值。提交锚点与提交前结果基线来自同一张已验证输入的截图；提交后结果必须发生变化并包含本轮输入，不能用键入自动更新结果证明提交生效。两样本和独立结果变化通过后才发布 ready，后续沿用 `software_call` 及生成入口调用。

无系统软键盘的自绘 `UIKeyInput` 验收夹具位于 [iOS 文本演示源](../apk_tools/examples/ios-visual-text/main.m)。会话管理者应在已有 session 的 `POST /session/SESSION_ID/appium/settings` 中设置 `{"settings":{"keyboardWaitTimeout":0}}`，再通过相同路径的 GET 回读确认；设备 JSON 没有自动代设该 setting 的字段。此设置只避免 WDA 等待可见键盘，不能证明实际焦点或输入成功，仍必须通过截图回读。不要将当前安装版本的默认值当作所有会话的保证。`nativeVisualWorkflow.ocr` 可从可信设备配置指定引擎与语言，默认 Tesseract `eng`，不能由 MCP 参数选择。

文本流程当前有 34 项相关模拟测试（其中文本 26 项）及实际安装 Appium 路由探针；这些模拟证据本身不证明实际键入或业务成功。自建 iOS 27.1 模拟器已完成 alpha/beta 学习，统一入口返回 RESULT gamma 3，生成入口返回 RESULT delta 4；输入被忽略、输入时自动更新结果但提交无操作、非法输入反例和清理均通过。本次实际范围为无系统软键盘的 UIKeyInput 夹具与拉丁文字/英文 OCR；中文、物理 iPhone 与第三方 App 仍未证明。默认严格像素合同只遮罩输入与结果区，普通系统键盘、光标或选区造成的区域外变化会拒绝执行。compiler12 可选键盘合同见下一节；默认路径没有替换。派发后失败标为 unknown、不自动重试且不可恢复，派发前拒绝为 not_started。已有 WebDriver session 仍不证明安装字节，截图回显也不证明隐藏文本缓冲区或事件处理器的语义。

#### iOS 普通系统软键盘

compiler18 新增显式本地 `keyboard.geometryEvidence.mode:"owner_approved_split"`，分别固定实际 AX `keyPlane` 与 owner 批准的 `visualEnvelope`。参见[禁用的几何配置模板](../examples/software/ios-visual-keyboard-device.example.json)、[几何合同测试](../apk_tools/tests/test_mobile_visual_ios_keyboard_geometry.py)与[本地审批读取测试](../test/ios-keyboard-owner-approval.test.mjs)。模板中的窗口、像素尺寸、矩形和校准摘要必须由目标自己的实际证据替换，不能从 MCP 参数启用，也不能从变化像素或 AX parent/Other 自动扩大外壳。

新合同逐阶段及按键前核对当前 app、实际 window/image 尺寸、唯一合法 AX 键面及完整 OCR 观察；只读 source 初检中的声明尺寸不代替之后真实帧。外壳须固定全宽、屏内、下半区，包含精确键面并避开输入/结果 ROI；按键仍只取 Keyboard 子树且检查实际整数中心排他。校准 SHA 仅记录本地批准所用原件，不证明系统所有权，也不单独授权 UI。初始/恢复完整帧、输入/结果回读、Dismiss、caret 颜色、OCR阈值、预算与 unknown/no-retry 均保留；未启用该字段时仍用旧12/24点 padding 和至少.95底边合同。

该模式的 source/PNG 与模拟反例已验证，不能代替实际设备闭环。普通系统键盘第18轮已通过新几何校准与来源发现，第一样本完成，第二样本键入时因 `VISUAL_FRAME_CHANGED` 停止学习；未发布 ready，也未进入统一/生成入口验收，仍无完整两样本及双入口通过结论；最新设备终态以[验证记录](software-to-mcp-verification.md)为准。

compiler15 将逐键校验中相邻的只读 PNG 操作合并到作用域子进程，每一步仍重读并验证原图，不跨 UI 动作缓存。旧第12轮两张拒绝帧的三轮离线对照中，这段像素计算的实际子进程从 8 个减为 3 个，中位耗时约 1.33 秒降为 1.06 秒，PNG 解码仍为 10 次，判定结果完全一致。该测量不包含整条设备流程，也不能证明新的键盘验收通过。compiler15 的第14轮真实验收在一次 Focus 后因 `VISUAL_KEYBOARD_NOT_VISIBLE` 拒绝，尚未清除、键入或提交。compiler16 新增仅在聚焦后使用的有界只读采样：最多3个候选、6次helper source和3次全新OCR；首次严格hidden或V/H不一致只开启一次2秒追加候选启动窗，已准入候选仍须在原总预算内完成全部前后核验，hidden不授权输入。该入口要求唯一Keyboard（包括拒绝额外hidden节点），未放宽像素、颜色、输入、Dismiss或结果门禁。第15轮进入第二样本后仍因 `VISUAL_FRAME_CHANGED` 拒绝，完整学习及双入口尚未通过；当前边界见验证摘要。

compiler13 在 clear/type 的第一次准备观察中增加只读稳定采样：最多 3 个完整的界面树→新截图/OCR→界面树观察对，累计最多 12 次 source、3 张新图。只在严格验证后的合法键盘相位前后不一致时整组重采，不把旧图改标为新相位；特定 visible-but-offscreen 矛盾仍须等待新的合法证据。首个明确不稳定证据启动共享且不重置的 2 秒追加窗口；它限制新采样的启动，单次在途传输与 OCR 仍受原超时及总预算约束。它不重复 focus、clear、type、Dismiss 或提交，后续新鲜度与完整截图核对仍保留。

compiler12 新增本地显式启用的 `nativeVisualWorkflow.keyboard`，参照[设备模板](../examples/software/ios-visual-keyboard-device.example.json)、[可信定义](../examples/software/ios-visual-keyboard-workflow.example.json)与[自然 UITextField 夹具](../apk_tools/examples/ios-visual-keyboard/main.m)。该夹具保留系统键盘和普通 caret。该分支早期 Python 模拟/本地 PNG 测试 109/109、Node 光标专项 9/9 通过；新版本专项以验证摘要为准。**完整真实模拟器验收尚未通过，尚无普通键盘两样本和统一/生成双入口通过结论**；不能以无键盘 UIKeyInput 的历史成功替代。

`sourceRegion` 必须匹配本次来源树中唯一可见 Keyboard 的实际像素框；`region` 是本地管理者另行批准的视觉 envelope，包含它的有限背景和阴影。省略 `sourceRegion` 时与 `region` 相同，不自动补齐边缘。二者均须全宽且近底部；顶部额外范围同时不超过视口 2.5% 和 12pt，底部同时不超过 5% 和 24pt。输入区、focus/submit/dismiss 锚点不得与 envelope 相交。学习合同和设备身份绑定完整配置，像素失败后不会自动扩大范围。AX 框只能证明所观察的树与几何，不能证明这些额外像素属于系统窗口。

流程为 focus → 单次有界 `/keys` 退格 → 空值 OCR → `/keys` 输入 → 完整输入 OCR → 单次 Dismiss → 恢复 hidden → 原布局、echo、同帧结果 baseline 与完整 SHA freshness → 提交。新分支不使用硬件 Command+A/Delete；默认无键盘分支保留原清除计划。可见键盘期间只做输入准备和收起，不读取提交 baseline 或提交业务。

可见阶段的布局合同允许已批准输入/结果/键盘区域变化，但动作前会重新核对来源及新截图：freshness 排除键盘 envelope 和结果区，仍检查输入像素。未配置 `caret` 时要求像素一致，相位不同最多进行 6 次只读帧采样（名义约 2 秒，仍受传输和总预算约束），不重试输入动作。

自然光标连续渐隐可能无法等到完全相同的颜色。本地管理者可额外批准 `keyboard.caret`，模板展示全部 8 个必需字段：`enabled:true`、RGB 整数三元组 `color` 与 `background`、`colorTolerance`、`maxWidthPoints`、`minHeightPoints`、`maxHeightPoints`、`maxAreaPoints`。容差最多 2，宽度最多 3pt，高度为 8–48pt，面积最多 144pt²；字段值由实际界面确定，不能从 MCP 参数覆盖。只有输入区内一条连续、密集、细长竖线的变化，且前后不透明颜色均在指定背景到前景的混色线上，才可能等价。不符合批准颜色与几何的文字变化、宽选区、多条竖线、越界及区域外变化仍拒绝。这是额外的本地像素权限：同色窄字形可能满足相同规则，不能据此证明 OS 光标身份或隐藏输入缓冲区。

第七轮原始界面树确认，清除指令后键盘已变为 hidden，尚未键入样本。适配器已扩展输入准备阶段的状态识别：可见时仍须精确匹配批准区域；隐藏时不增加键盘遮罩；原键盘区域中未被既有结果遮罩覆盖的像素仍须一致。初次 focus 后仍要求真实可见键盘，清除和输入不重试，也不额外聚焦；输入后始终执行一次批准的 Dismiss。此调整已通过专项和独立复核；第八轮原始界面树仍出现“visible=true 但框已在视口外”的矛盾，几何守卫拒绝后续输入，实际设备闭环仍未通过。

光标例外只用于输入准备阶段，可见或隐藏状态分别采用对应的严格布局与遮罩。键盘消失后恢复原合同，重新验证完整输入、同帧结果基线与原完整 PNG SHA，再提交。只有输入与独立结果验证通过才可发布 ready；派发后失败继续 unknown/no-retry。匹配后派发仍存在非原子竞态，不声称局部等价模型与完整 SHA 具有相同保证。新策略的专项测试和设备终态分别记录在[验证摘要](software-to-mcp-validation.json)，不能由策略存在推导设备通过。

compiler17 的单键新鲜度检查固定同一个完整 OCR 参考。首个完整、普通像素不匹配完成后，开启一次不重置的 2 秒追加候选启动窗，最多 6 个候选；已准入的 source→新截图→几何→source→像素核对仍受原传输与整体预算约束，不承诺 2 秒内全部完成。像素 worker 正常退出及取消检查都通过后才可接受。输入区不额外遮罩，键盘布局、目标身份、全图、caret 颜色与底色守卫保留；不重复按键、聚焦、清除或提交。私有小型时序记录仅用于诊断，不能授权后续动作。第16轮在另一次 WDA 截图 20 秒超时后终止，未通过学习或双入口；已完成的19次单键新鲜度检查均在第一候选通过，追加窗口未被该设备轮次实际触发。

复现脚本为 [iOS 普通键盘设备验收](../test/ios-native-visual-keyboard-device-e2e.mjs)，无设备反例见[键盘测试](../apk_tools/tests/test_mobile_visual_ios_keyboard.py)。需准备隔离的 Appium/XCUITest、已初始化 Xcode 与可用模拟器；脚本存在不等于设备验收通过。物理设备、任意键盘/第三方 App、iOS 安装字节、隐藏输入缓冲区和业务因果仍未证明。

##### 按当前系统键位输入

compiler14 可在可信本地 `keyboard.keyInput` 中显式设置 `mode:"onscreen"`，参见[逐字确认模板](../examples/software/ios-visual-onscreen-device.example.json)。执行器从新的界面树读取唯一、可见且启用的字符键，以及配置中固定的 shift、numbers、letters、delete 身份。每次点击当前键中心，逐次计动作预算，并重新取得整图 OCR、键盘层及布局证据。该中心同时落在另一可见 Key/Button 时会拒绝，包含未知或禁用的行；此检查不证明系统窗口所有权。支持域限三层 ASCII 字母与数字，最长 16 字符。未知层、重复键、键盘消失、源漂移和预算耗尽均拒绝继续。

缺省 `confirmation:"each_prefix"` 要求逐个前缀的 OCR 精确回读；缺省 `clearPlan:"observed_shortening"` 要求每次删除后观察到缩短。实际实验中，单个 `a` 虽已出现在截图，整图 OCR 仍可能完全漏掉它。这条严格路径因此拒绝继续，不能据此记录完整设备通过。

[整串确认模板](../examples/software/ios-visual-onscreen-complete-device.example.json) 另显式选择 `confirmation:"complete_text"` 与 `clearPlan:"fixed_max_length"`。它先执行可信定义 maxLength 限定的固定删除计划，再执行一份有限键入计划；中间 OCR 只用于观察，不据其分词或漏字增删动作、重试或重新聚焦。每键的新鲜度检查仍包含输入像素，切换键盘层还须比较切换前后的原始观察帧，确认输入未变化，仅沿用已批准的窄光标例外。识别过程、来源、布局或方位错误仍立即终止。

固定删除完成后必须回读空值；全部键入后必须以原置信度门槛回读完整输入，随后执行原 Dismiss、隐藏阶段完整输入、布局、完整 PNG SHA、提交前结果基线和单次提交检查。`maxLength` 约束新输入，不证明旧值长度或光标位置；固定删除和 OCR 空值也不证明隐藏缓冲区真实为空。按键可能触发的未观察到的中间副作用不由整串确认保证。两项本地策略进入身份与 revision，改变后须重新学习。

compiler19 另支持默认关闭的本地 `keyboard.keyInput.caretUnderlay`：

```json
{"mode":"paired_revealed_grayscale","maxUnderlayPixels":16,"minWhiteCoreFraction":0.8,"minSharedOpacity":0.125}
```

它只为屏幕按键的新鲜度比较增加有限像素等价权限，不能由 MCP 参数设置。基础 `keyboard.caret` 仍为原8字段，背景必须精确白色、前景为固定彩色。比较同一次解码的两张新图，保留完整 ROI、形状、单组件、透明度、颜色容差和区域外像素检查；必须由同一个实际端点显露所有变化点的灰度背景。透明度只从白色核心推导，再以固定透明度解释有限灰底点，灰底点不能反过来拟合透明度。所有非白点均计数，包括近白点；本地上限1–64，白核心比例至少0.8、共同透明度至少0.125。

这是一项明确的视觉等价选择：应用自己绘制的同形彩条也可能满足规则，不能据此证明 OS 光标身份、被覆盖字符或隐藏缓冲区未变。切换键盘层、可见性准备、Dismiss 和提交不继承该权限；最终完整文字、布局及独立结果仍须通过。策略进入设备身份和学习 recipe，变更后须重新学习。原严格默认及第18轮失败原件保留。第19轮自建模拟器在校准阶段因 `CALIBRATION_UNRELATED_PIXELS_CHANGED` 停止，尚未执行流程发现、双样本或双入口；自有会话、模拟器、进程和端口均已清理。离线像素通过不代表设备闭环通过，实际结论以验证记录为准。相关测试见[PNG 比较](../test/visual-caret-underlay.test.mjs)与[配置及阶段隔离](../apk_tools/tests/test_mobile_visual_ios_underlay.py)。

整串确认与固定删除相关的 137 项模拟回归通过；补充键位中心排他检查后，相关回归为 143/143。原严格路径的 123 项包含在这些回归内，不相加。真实传输诊断已回读 `alpha` 与 `Ab7z`，严格路径完整验收在首字母处拒绝；整串策略的完整设备结论以[验证记录](software-to-mcp-verification.md)为准。上述证据不能相加为一次设备验收。最多 64 次物理键仍受全局预算约束，示例的 50 动作不保证所有 16 字符组合都能执行完。

### 自定义 Web 下拉框

`role="combobox"` 加 `aria-controls` 指向唯一 `role="listbox"` 的控件可使用 `choose` 步骤。输入为有限字符串枚举，私有 choices 把每个值绑定到固定 option 选择器；所有选项必须在原 actionAllowlist 中。打开控件、选择选项分别是真实点击，各计动作预算；不会用脚本改 DOM 来伪造选中。`optionLabel` 断言读取实际选项文字。

规划器会为已经观察到完整选项、稳定标识及明确关系的控件生成候选。学习和执行核对同 frame、同 DOM tree、listbox 归属、控件合同与选中状态。已挂载且折叠隐藏的选项可直接使用；懒挂载列表则须有真实展开成功的探索记录，以及完整的 `aria-setsize` 和 `aria-posinset` 域证据，才能关联回关闭入口。`software_workflows` 只读既有证据，不为规划额外点击。未完整观察的虚拟列表保留缺口。

`choose.timeoutMs` 控制展开后及选择后的有界等待，默认 3000，范围 0–10000 毫秒。每次仅展开一次，超时不重开。选择后卸载选项的控件可声明 `selection:{attribute:"data-value"}`，从 combobox 自身读取真实提交值；也可用固定 `selector` 指向同 frame 的证明目标，属性仅支持 `data-value` 或 `value`。目标须在选择前存在，选择后属性严格等于参数值；控件状态只证明选项切换，业务输出仍需独立结果断言。未声明 selection 时要求实际 option 保持挂载并选中。

模板见 [ARIA 流程](../examples/software/browser-aria-workflow.example.json)、[懒挂载流程](../examples/software/browser-lazy-aria-workflow.example.json) 与 [启动配置](../examples/software/config.aria-workflows.example.json)。当前有限 string enum 支持不覆盖多选和跨 tree portal。

#### 复用 DOM 节点的有限虚拟列表

可信启动配置可显式声明 `webConfig.ariaVirtualLists`，绑定固定 combobox、listbox、竖向滚动宿主、option 选择器和 wire 值属性，参见 [配置模板](../examples/software/config.virtual-aria.example.json)。combobox、滚动宿主及通用 option 选择器须在原 actionAllowlist，业务请求仍须逐项批准；该策略不能由 MCP 调用参数增加。

探索在一次已批准的展开后，逐段滚动并核对唯一 DOM 身份、遮挡、全局 `aria-setsize` / `aria-posinset`、wire 值和完整标签。只有每个选项都实际进入视口、位置和 wire 不冲突并到达物理末端，才记录完整域证书。滚动逐次计入全局动作预算；单策略最多 200 项、64 次滚动、256 次快照和 10 秒，配置可进一步收紧。

只读规划器需要完整扫描事件及成功展开记录，不自行打开页面。学习和每次调用都会重新扫描完整域，再滚回目标并点击一次，独立核对 selection 属性和最终业务输出；结果须相对入口及最终提交前的基线发生变化。域改变、缺项、未知或无限列表、层级替换、遮挡和预算耗尽都会拒绝继续。远程搜索 feed、任意 tree/grid 和缺少可靠全局索引的控件仍需单独适配。

### 原生布尔控件

原生 `check` 步骤绑定 boolean 参数或固定 boolean 值，设备 actionAllowlist 必须明确批准 kind check，不继承 click 权限。Android checkbox/switch/radio 和 iOS Switch 从系统属性读取可靠选中状态；未知状态、只读控件或歧义定位会在动作前拒绝。单控件 radio 的 `check` 只支持选中 true，schema 为 `enum:[true]`；完整单选组使用下面的 `select`。

同值请求只复核状态，不再点击，也不冒充真实动作执行；状态不同才点击一次，随后重新观察确认。执行结果的 `checkStateVerifications` 区分 changed 和 noOp；写控件仍使用原来的写权限、持久意图与 unknown 规则。自动规划可在同一稳定容器里组合文本、复选框和开关，产生混合参数 schema。定义和设备配置见 [原生布尔流程](../examples/software/mobile-controls-workflow.example.json) 与 [Android 控件配置](../examples/software/android-controls-device.example.json)。

### 原生单选组与分段选择

Android `RadioGroup` 内的 `RadioButton`、iOS `SegmentedControl` 内具有可靠 selected 属性的 `Button` 可映射为一个 string enum。私有 `select` 步骤固定组 selector、input 与完整 options，每项为 `{value,selector}`；2–20 个互异选项的值域须与输入 schema enum 完全一致。组和选项均需稳定 resourceId/accessibilityId，不接受纯文字定位。别名来自稳定 UI 标识，不能据此推断后台接口的 wire 值。

设备策略同时批准组的 `kind:"select"` 和每个选项的 `kind:"check"`，并声明 effect。点击前统一核对所有单选组的完整成员域、归属、可见启用可写状态，以及恰好一个选中；缺状态、跨组、重复或零个选中均拒绝。同值只读复核，不点击；变化仅点击一次，再轮询确认完整组排他状态。`timeoutMs` 默认 1500，范围 0–10000 毫秒，等待不会补点。`selectionStateVerifications` 分别记录 changed/noOp；write 仍适用双层授权和 unknown 规则。

模板见 [单选组流程](../examples/software/mobile-radio-workflow.example.json)、[Android 单选组策略](../examples/software/android-radio-device.example.json) 和 [iOS 分段选择策略](../examples/software/ios-segmented-device.example.json)。这些模板的 `StatusGroup`、`all/open/closed`、`QueryText`、`Search` 和 `Results` 都须替换为目标 App 的真实稳定标识，示例结果断言要求结果区域实际包含本轮 query 和 status 别名。普通按钮、隐藏成员或没有可靠系统状态的控件保留缺口。

## 明确配置的 UI 写入

Web 与原生流程定义可声明 `effect:"write"`，执行创建、修改等已批准操作。启动配置按来源和 workflow 定义中的 id 授权：

```json
{
  "workflowPermissions": {
    "notes_web": {
      "allowWrite": ["create_note"],
      "allowWriteLearning": ["create_note"]
    }
  }
}
```

`allowWrite` 只批准执行；`allowWriteLearning` 同时批准学习时实际执行 2–5 组样本。学习会产生真实数据，应在自己的测试数据上配置和清理。仅有执行许可时不能重新采样，撤销学习许可后仍可执行已有流程。默认不批准写入，不支持通配符，学习许可必须属于执行许可。两项均取服务器启动配置，不能通过 MCP 参数、spec 文件或设备文件自行增加。

浏览器仍需原来的 forms、输入/按钮 actionAllowlist 和精确 requestAllowlist。SPA 中没有 `<form>` 的保存按钮可在可信 webConfig 中增加 `writeActionAllowlist:["#save"]`；它必须属于 actionAllowlist，且只在已批准的 write workflow 内生效。普通探索、断点续跑和 read workflow 不会因此获得这个写按钮。请求范围、登出和排除规则继续生效。原生设备 actionAllowlist 应把提交按钮标为 `effect:"write"`；write 流程只接受已批准的 read/write 动作，unknown 动作拒绝，入口恢复前缀仍只走 read 路径。

会自动保存的输入框也应把自身 selector 加入 writeActionAllowlist，避免普通填表探索触发保存。写流程配置示例把整组写表单的输入和按钮都设为仅写流程可用；不能只根据按钮或 HTTP 方法推断页面是否存在副作用。

模板见 [启动配置](../examples/software/config.write-workflows.example.json)、[Web 写定义](../examples/software/browser-write-workflow.example.json)、[移动写定义](../examples/software/mobile-write-workflow.example.json) 和 [Android 动作策略](../examples/software/android-write-device.example.json)。先替换域名、控件、设备序号及 APK 清单生成的 sourceId；路径推荐改为绝对路径。按原调用链探索来源、用 specPath 学习，再生成独立 MCP。独立使用 Python CLI 时，设备 JSON 为可信本地配置，可在其顶层设置同样的 workflowPermissions 对象；统一 MCP 总是用自己的启动配置覆盖该字段。

写操作结果带 `writeOutcome:{status,automaticRetry:false}`，后台 operation 同样公开该字段：

| status | 含义 |
| --- | --- |
| not_started | 此次流程尚未尝试 UI 写步骤，例如权限预检失败 |
| observed | 配置的 UI 结果断言与提取通过，不自动证明数据库提交或任意业务语义 |
| unknown | 已尝试输入或点击，但断言、连接、取消或进程退出使结果无法确认；写入可能已发生 |

实际命令前会先持久保存写入意图，worker 意外退出后仍可返回 unknown。输入框可能自动保存，因此填值也按可能写入处理。执行、验证和学习不会自动重试；`software_resume` 只用于探索。每次新的工具调用都视为一次新操作，没有跨调用的幂等保证；unknown 时先核对目标实际状态。`software_validate` 也会实际写入一次，不能用于无副作用的试运行。

调整权限后，用新启动配置重启并刷新来源。当前运行时会在每次调用前检查写权限；刷新将被撤销的能力保留为 candidate，记录 `workflow_write_not_approved`，并让绑定旧来源 revision 的生成入口失效。生成入口使用自己的私有配置快照，因此不要把编辑配置文件视作对所有已启动服务的即时撤权。生成工具标记非幂等，并保留 write 副作用提示。

## Android / iOS UI

设备通过启动配置 devices 映射到可信 JSON 文件，见 examples/software/ 的两份模板。配置可只提供设备 transport；source.id/kind 和 backend.appId 会从安装包身份派生。显式填写的身份限制必须与清单及后端平台匹配。Android 可使用 ADB/uiautomator；Android/iOS 也可连接已有 Appium/W3C session。此层不自动安装 App、修改代理或 CA。

底层支持观察、选择器查找、点击、输入、滑动、返回与明确配置的启动操作；自动探索有状态去重、动作/深度/时长预算、设备 session 锁与增量进度。未验证参数/未知副作用保持候选。固定路径执行需要记录的入口状态；参数化路径使用稳定控件契约。UI 命令完成不证明 HTTP 或业务完成。移动 sourceId 来自安装包生成的 source.json；调用者传入不同 sourceId 会明确报错。

WebDriver 设备配置可在可信 backend 中设置 `commandTimeoutMs`，默认 15000 毫秒，接受 1–120000 的整数（不接受 boolean）。单条 HTTP 命令实际超时取该值与总 `limits.maxDurationMs` 剩余时长中较小者；预算耗尽即停止，超时不自动重试。该设置只来自服务器绑定的设备文件，MCP 调用参数不能覆盖。慢设备可提高该上限，但不会延长流程总预算，例如：

```json
{"backend":{"type":"webdriver","url":"http://127.0.0.1:4723","sessionId":"REPLACE_WITH_EXISTING_SESSION","platform":"ios","commandTimeoutMs":30000},"limits":{"maxActions":30,"maxDepth":4,"maxDurationMs":120000},"actionAllowlist":[]}
```

原始单 APK 接入 ADB 时，运行时会生成私有设备配置快照并绑定静态 SHA-256。后端观察与动作前检查设备 package 路径及文件哈希；只有同一单 base.apk 才标记 `appArtifactVerified:true`。分包、哈希不可读或失配不会冒充已验证；明确要求哈希时失败会阻止动作。W3C/iOS 会话无法证明安装字节，仍保留缺口。流程刷新会核对设备绑定与 App 身份，同包名更换静态 SHA 也不能沿用旧 ready 流程。

Android 已通过真实 API 36 / Android 16 arm64 模拟器验收：仓库自建 APK、实际 ADB 探索、统一 MCP 调用、生成独立入口后再调用，合计收到 6 次 App 发出的 GET 请求；脚本核对安装包与设备 base.apk 的 SHA-256 一致。测试结束后已卸载自建 App、停止隔离模拟器与 ADB 服务并移除本轮 AVD 数据。此结果覆盖自建测试 App，不能代表任意 App 或物理手机均已通过。

参数化原生表单也已在同类型真实模拟器通过：两组样本 2→4、3→9，统一入口 4→16，独立生成入口 5→25；原生界面的历史记录核对了四次输入替换，非法输入零新增点击，App HTTP 请求零次。复验使用 `npm run test:android-workflow`，默认建立并清理独立设备数据。

写流程另通过同类型真实模拟器验收：原生 Notes 学习 alpha/beta、统一入口创建 gamma、生成入口创建 epsilon；故意不给成功回执的第 5 次创建只写入一次，返回 unknown 并拒绝续跑。再学习两组修改并调用 finaledit，合计 8 次创建/修改、5 条记录；重启 Activity 后读取 SharedPreferences，内容和计数均一致。APK 文件与设备安装文件 SHA-256 相同，App HTTP 为 0。清理第 9 次操作清空本轮记录，随后卸载自建 App、停止自有模拟器/ADB 并删除隔离数据；用户原 AVD 配置未改。复验使用 `npm run test:android-write-workflow`。

文本加布尔筛选也已通过真实模拟器验收：直接识别 mixed candidate，学习两组值后统一调用、独立入口调用，再重复 false/false。共执行 5 次查询；最后一次两个布尔控件零新增点击、查询仍一次。APK 安装字节一致，坏 bool、控件漂移及缺 check 批准均零目标点击，隔离资源已清理。复验使用 `npm run test:android-controls`。

Android 单选组另已通过真实模拟器：自动识别文本+string enum，两样本 alpha/open、beta/closed，统一调用 gamma/all，生成入口 delta/open，再次 epsilon/open。共 5 次查询、4 次选项切换；最后同值请求选项零新增点击，查询一次。非法 enum、缺选项批准、跨组、同时多选四个负例均零输入/点击。APK 安装字节一致，隔离 App、设备与 ADB 已清理，用户 AVD 配置未变。复验使用 `npm run test:android-radio`。

ADB 参数化流程已去除下一阶段立即丢弃的重复采集。每个动作前的 live tree、唯一目标、前台 App、安装哈希和清空确认均保留；断言、提取和新鲜度复核也不省略。自建 App 同覆盖三轮 A/B 的每组 dump 从 21 降至 15，耗时中位数 56.990s→40.967s（约 1.391×）；首轮有冷启动抖动，不能外推为任意 App 的统一提速。

iOS 首次真实模拟器验收已通过：iOS 27.1 / iPhone Duo 模拟设备、自建 UIKit App、Appium 3.9.0 / XCUITest 12.22.3 / WDA 实际执行，自动候选学习 alpha/beta，统一入口 gamma，生成入口 delta，App 最终查询计数 COUNT:4。88 次真实 WDA 请求、12 条修改界面的命令均成功；非法参数零新增 UI 命令。脚本独立比较安装后的 Mach-O SHA-256，一致；生产 WebDriver 后端仍如实保留 `appArtifactVerified:false` 和安装字节未验证缺口，两份证据范围分别记录。

验收结束删除真实 session、停止透明记录代理/Appium、卸载 fixture 并删除自建模拟器，五项清理均通过；四个自有端口无监听，无自有进程遗留，既有设备 ID 保留。首次截图无法证明可见界面，未作为通过证据；另建独占模拟器后由实际 WDA 截图确认结果，命令、UI 树和清理审计再次通过。该结果只覆盖自建 App 的真实模拟器，物理 iPhone 仍未验收。

复验使用 `npm run test:ios-device -- --appium-prefix /absolute/owned-appium-prefix --output /absolute/new-output`，需要已初始化 Xcode、可用模拟器运行时和隔离 Appium/XCUITest 安装。`--prepare-only` 只验证准备，不等于设备通过。

compiler18 另只移除截图流程中更早且重复的一组身份 proof，最终截图前和截图后的前台/安装字节核验保留，默认 probe、IME 通路与失败处理不变，也不跨次缓存安装证明。[ADB截图身份专项](../apk_tools/tests/test_adb_capture_identity.py)覆盖11个局部协议反例。三轮本地子进程对照中，单次流程命令13→10，中位1120.818→894.507毫秒；使用受控协议子进程和合成图，没有真机采图/UI，不能解释为真机或整条 MCP 业务的速度。

### Android Unicode 输入

默认 ADB 输入保持 ASCII 合同。需要中文、emoji、组合字符或字面 `%s` 时，可在设备可信配置中显式启用仓库自带的输入桥：

```json
{"backend":{"unicodeInput":{"component":"com.bfs.mcp.ime/.UnicodeIme","apkSha256":"REPLACE_WITH_INSTALLED_HELPER_APK_SHA256"}}}
```

完整模板见 [Unicode 设备配置](../examples/software/android-unicode-device.example.json)；模板的全零 SHA 是占位值，必须换为实际安装 helper APK 的 SHA-256，并替换目标 App、设备及控件 ID。[输入桥构建与准备](../apk_tools/examples/unicode-ime/README.md) 使用本机 Android SDK/JDK；产品后端不安装或切换输入法，需设备管理者事先安装并选择它。

后端在聚焦前后核对 helper 单 base.apk 安装哈希与当前输入法，广播接收器受 Android DUMP 权限保护。输入桥核对编辑器所属 App，使用 UTF-8 base64、单次 nonce 和 SHA 回执；回执只是传输证据，后端另读取真实 focused 目标并验证替换值摘要。追加路径按 UTF-16 长度移动到末尾，再验证原前缀 SHA 与精确新后缀。输入证明只保留在内存，不进入公开库存。哈希失配、未聚焦、未知回执或断连不会盲目重发；写流程继续按已有 unknown 语义记录。

真实 API 36 / Android 16 arm64 隔离模拟器验收中，`中文搜索`、`你好 😀 é` 两样本、统一入口 `字面%s 空格 % &`、生成入口 `生成入口 🚀 测试` 共四次 MCP 替换查询已通过。后续四次追加是生产 `MobileSession.step` / `DeviceLease` 后端实测；最终计数为 8，不能称为八次 MCP 调用。当前参数化 workflow 保持 `replace:true`，尚未发布有状态追加流程。

该轮共 8 成功回执与 2 次错 App/nonce 拒绝；非法 MCP 输入零 UI 操作，实际字段和计数核对通过。结束恢复原输入法、卸载 fixture、停止独立 ADB/模拟器并移除自建数据，原 AVD 配置哈希不变。复验：

```sh
node test/android-unicode-e2e.mjs --output /absolute/new-output
```

范围限仓库输入桥和自建测试 App 的真实模拟器；任意 IME、任意第三方 App、分包身份与物理手机仍需逐目标验证。Unicode 输入能力不等于中文 OCR 模型已安装。

### iOS 混合控件实测

可使用 [混合控件设备配置](../examples/software/ios-controls-device.example.json) 作为标准 UIKit 文本、Switch、SegmentedControl 的策略模板。`check` 批准 Switch，组用 `select`，每个选项另用 `check` 精确批准。已有只读控件会在动作前拒绝；read 流程中同值 boolean / enum 只读取并复核，不发送控件切换，后续查询仍执行。

iOS 的 SegmentedControl 状态优先使用明确 `selected` 属性；标准 WDA 快照缺该属性时，可从系统 accessibility traits 的精确 `Button` / `Selected` 标志确认。没有可靠属性保持未知；不根据一般按钮文字或 value 猜选中状态。系统状态可靠性与业务结果是两份证据。

真实 iOS 27.1 / iPhone Duo 模拟器已完成三字段自动候选、alpha/true/Open 与 beta/false/Closed 两样本，统一 gamma/true/All，再生成入口 delta/true/All，计数为 4。167 条产品 WDA 请求全部成功，18 条 UI 命令；最后一次只有 Search 点击，Switch 与分段同值零切换。非法 enum 和实际改变选项域后的旧 recipe 均零 UI 增量；WDA 截图已目视确认，隔离资源已清理。复验：

```sh
node test/ios-controls-e2e.mjs --appium-prefix /absolute/owned-appium-prefix --output /absolute/new-output
```

`build_demo.py --controls --out /absolute/Controls.app` 构建另一 bundle 的自建控件页；默认文本页保持原模式。先前把 Switch 拉伸到 420px 的测试布局曾出现一次 WDA click 返回 200 但值未变，产品只点一次后拒绝。最终测试页保持 UIKit 固有尺寸；这份成功不证明通用点击问题已解决，失败报告仍保留。物理 iPhone、任意第三方 App 及生产 WebDriver 安装字节证明仍需另外验证。

## 验证范围与后续

项目新增官方 MCP client 端到端测试：动态 Web 探索、HTTP 参数调用、浏览器路径回放、独立生成入口再调用；APK/iOS 规范化清单也走同一生成/调用链。另有 schema、revision/CAS、凭据、范围、异常恢复和移动协议专项。

实现与验证链路见 [验证记录](software-to-mcp-verification.md)。独立执行 `npm run test:software` 运行统一入口、浏览器能力、OpenAPI、生命周期与移动协议回归；`npm run test:android-device` 运行隔离 Android 模拟器验收。

下一步继续扩大参数化控件与业务动作支持，验证更多真实第三方 App 与物理 Android/iPhone 设备。已有可调用入口与完整业务覆盖分别记录，不用测试夹具代替真实站点或设备的覆盖声明。


设备视觉观察已通过真实 Android 模拟器统一与生成入口验收：各一次截图，返回 UTC `capturedAt`，安装 APK SHA 一致，零 UI 操作，隔离资源均已清理。真实 iOS 模拟器已完成截图和本地 OCR 设备验收，已有 WebDriver 会话仍不能证明安装包字节。复验 Android 使用 `npm run test:native-visual-device`。

默认无系统键盘分支的文本清除采用一次确定的计划：Cmd+A/Delete 后先刷新截图核对布局和前台，再通过公开 `/keys` 发送由可信 `inputSchema.maxLength` 限定数量的 U+0008 退格，随后实际验证输入区为空。可选普通键盘分支直接使用单次有界退格，不发送硬件快捷键。若未清空，不继续键入或提交，标记未知且不自动重试；不会在观察清除失败后循环重试。退格次数不能来自 MCP 调用参数。

可在源码仓库运行 `npm run test:ios-visual-text-workflow -- --appium-prefix /absolute/owned-appium-prefix --output /absolute/new-output` 复验。脚本创建并清理独占模拟器与测试 App；系统询问是否打开本轮 BFS Text Demo 时，仅核对该白名单提示并接受一次，随后仍以截图核实模式。此处理仅存在于设备测试，不属于生产 MCP 的全局提示处理。
