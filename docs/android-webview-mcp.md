Android WebView → MCP：显式归属、精确文本与有限表单流程

这条通路把已选中的 Android WebView 文本查询表单接到探索、候选规划、样本学习、统一调用和独立生成 MCP。后端使用 DOM 与真实输入属性 `.value`，执行范围限于同一文档内的线性 `type → click → assert/extract`。目标应用需允许检查其 WebView，设备管理者先建立 Appium/UiAutomator2 会话并选好 context/window。

后端不会安装或启动应用、导航页面、切换 context/window，也不接受调用者提供的 JavaScript。可信设备配置决定会话、应用、文档、控件和动作授权；MCP 参数只提供已发布能力的业务输入，不能覆盖这些配置。

从 [Android WebView 设备示例](../examples/software/android-webview-device.example.json) 创建私有配置。替换示例中的 Appium 地址、session、App ID、context、window、URL/origin 和 DOM 控件；全零 `windowHandle` 是占位符，不是实际页面证据。在启动配置的 `devices` 中绑定这份私有配置的别名。Android 来源使用 `source.kind:"apk"`，后端使用 `type:"appium-webview"`、`platform:"android"`，并在 `backend.webview` 明确设置：

```json
{
  "association": {"mode": "uiautomator2_devtools_v1"},
  "textTransport": {"mode": "chromedriver_cdp_insert_text_v1"}
}
```

两个对象都只接受所示的 `mode` 字段，缺少或替换该 profile 会被拒绝。它们声明所用的归属与输入合同，不能代替设备实际返回的证据。

Android 归属检查读取当前前台 package 和 UiAutomator2 的 `mobile: getContexts` rich listing，并核对以下关系：

| 观测项 | 必须满足的关系 |
| --- | --- |
| 前台 package | 与可信 `backend.appId` 完全一致，列举前后再次读取 |
| rich context | 相关记录唯一，`webviewName` 等于 `WEBVIEW_<App ID>` |
| DevTools 进程 | `proc` 为 `@webview_devtools_remote_<PID>`，`webview` 为同一 PID 对应的 `WEBVIEW_<PID>` |
| DevTools 应用信息 | `info["Android-Package"]` 与实际前台 package 一致 |
| 页面 | `pages` 只有一个 `type:"page"`，页面 URL 与可信完整 URL 一致 |
| page/window | 页面 `id` 为裸的32位十六进制字符串，当前 window 和唯一 handle 都与它逐字一致 |
| 当前文档 | 当前 context、window、完整 URL 和 origin 与上述观测及可信配置一致 |

PID 来自实际 socket/listing，不在设备配置中手填。该 profile 接受上述主进程关联形式，不自动扩大到带进程后缀的应用、多 WebView 页面、浏览器标签页或自定义 socket。window 不加 `CDwindow-` 前缀，也不通过截取、大小写转换或猜测来匹配。列举本身可能建立临时 DevTools 转发；后端会在其前后核对选中的 context/window。

这是对已知驱动返回值的观测关联，不是操作系统身份认证，也不证明已安装 APK 的字节。配置、会话 capabilities 或一个包含包名的 context 字符串不能独自证明归属。驱动或应用变化后，应按对应验证记录重新判断适用范围。

控件配置使用唯一的 ASCII ID 选择器，如 `#query`、`#detail`、`#run`、`#result`。输入和按钮必须处于实际观察到的同一 `form/div/section` 组中；存在真实 form owner 时，owner 也必须匹配。结果可位于独立区域并设置 `group:null`。每个输入和按钮还须在 `actionAllowlist` 中分别授权为 `type` 或 `click`、`effect:"read"`。发现了额外可见控件，不会自动授予操作权限。

固定 DOM 探针检查顶层文档、真实 `document.URL`/origin、可见性、控件类型、form owner 和父元素。一个 worker 内保留 documentElement、body、组和控件的真实 W3C 引用，再将它们传回固定探针做 `===` 比较。同 URL 重载、body 或控件替换、合同漂移会阻断该 worker 的后续动作；引用不写进 recipe，另一个 worker 会重新附着并建立自己的引用范围。当前不规划 iframe、Shadow DOM、跨文档导航、`check/select`、上传或写业务流程。

Android 输入采用固定的 CDP 文本通道。每个字段按如下顺序替换：

1. 派发 W3C `clear`，重新观察并确认 `.value` 严格为空。
2. 执行固定 focus 脚本。脚本先核对已绑定的文档、控件、owner、父元素、URL/origin，再调用 `focus({preventScroll:true})`；返回的 activeElement 和空值都须匹配。
3. 完整观察后执行另一份固定只读 focus 脚本，再确认焦点仍在该元素且值为空。
4. 通过 ChromeDriver 的 `/goog/cdp/execute` 派发唯一允许的 CDP 命令 `Input.insertText`，参数只包含本次 `text`。
5. 新鲜读取 DOM `.value`，按完整 UTF-8 内容核对回显；提交按钮点击前，再用最近一次完整观察核对全部绑定字段，防止后一个字段的事件改写先前字段。

这里的 focus、只读检查与 CDP 命令都是固定实现；调用者不能选择脚本、CDP 方法或其他参数。它不使用物理键盘，也不通过直接赋值 `.value` 伪造输入回显。Android 不回退到已知存在 BMP 限制的 W3C `value` 通道。

对“两个文本字段替换后点击一次查询”的完整成功路径，变更意图如下：

| 动作 | 持久变更意图数 |
| --- | ---: |
| 第一个字段 clear、focus、insertText | 3 |
| 第二个字段 clear、focus、insertText | 3 |
| 查询按钮 click | 1 |
| 合计 | 7 |

只读 focus 核查、DOM 探针、归属及 URL 检查不计入这7个变更意图，因此7不等于总 HTTP 请求数。失败可能只完成其中一段，必须保留实际派发记录，不能假定7项全部生效。逻辑流程的两个 `type` 与一个 `click`，也不等于只有三个底层变更。focus、clear、输入和点击都可能触发页面事件；`effect:"read"` 是获准的业务合同，不承诺页面不会发出其他网络请求。

输入至多2048个 Unicode 码点，不裁剪首尾或连续空格，不替换 emoji，也不做 NFC/NFD 规范化。例如，`e\u0301` 与预组合的 `é` 按不同内容检查。中文、空格、emoji 和组合字符必须在当前驱动与目标页面上精确回显；若页面或驱动改写内容，回显守卫会失败，不降低预期继续提交。C0/C1 控制字符、DEL、孤立 surrogate 和 WebDriver 保留按键码位不作为普通文本发送。

MCP 调用顺序沿用统一入口：

1. `software_discover` 使用 `kind:"apk"`、获准的 APK 或清单，以及预先配置的设备别名。等待操作终态；WebView 发现读取文档和控件，不提交查询业务。
2. `software_workflows({sourceId})` 读取候选，选择 `planningMode:"webview-dom-linear-v1"`。候选规划不提交查询；候选并不等于 ready 能力。
3. `software_bind_workflow` 提供来源当前 revision、候选 `candidateId`、两组不同的完整样本，以及覆盖每个参数的 `resultAssertions`。使用候选返回的 `outputTargetId`，要求独立结果变化并关联本次输入；不能关闭新鲜度检查或通过 `specPath` 注入流程。
4. 学习通过后重新读取 `software_capabilities`，取得 ready 能力与能力 revision，交给 `software_call`。来源 revision 和能力 revision 分别使用各接口返回的值。
5. `software_generate` 使用当前来源 revision 生成独立入口。生成服务从 `list_capabilities` 暴露能力，调用对应工具后通过 `operation_status` 查询；它仍依赖原会话、可信配置、私有记录及来源合同。

能力目录将 Android 通路标注为 `appium_webview_dom`、`fixed_w3c_element_commands`、`fixed_dom_focus` 和 `chromedriver_cdp_text`。输入合同为 `dom_value_echo_required`，文本 transport 为 `chromedriver_cdp_insert_text_v1`；结果为有界、脱敏的 `webview_dom_text_projection`。DOM `.value` 是 provider 回显，结果是配置的 DOM 文本投影，都不自动证明应用隐藏缓冲区、任意后台业务等价或原始源码字节。

每个 clear、focus、insertText、click 在派发前先写入持久 intent。只有受信执行范围完成且独立完成 receipt 与本次 intent 完全匹配后，才解除对应阻断。未知派发、超时、合作取消或不匹配的记录不能靠重复调用恢复；已有 pending unknown 会阻断后续执行，不自动重输或重放业务。发现和候选规划仍可能读取当前页面。需要恢复时由设备管理者核对真实业务及会话状态，删除或改写记录不构成完成证据。

学习、统一调用及生成入口的操作状态使用同一公开 `webviewOutcome` 白名单，例如：

```json
{
  "webviewOutcome": {
    "status": "unknown",
    "automaticRetry": false
  }
}
```

| 字段 | 公开含义 |
| --- | --- |
| `status:"not_started"` | 生产执行器有本次未产生变更派发的证据；不能仅由错误码或结果缺失推导 |
| `status:"observed"` | 对应受信执行范围已完成观察与所需校验；不扩大为任意业务成功 |
| `status:"unknown"` | 派发或持久状态存在不确定性，须核对实际状态，不自动重试 |
| `automaticRetry:false` | 不授予自动重放权限 |
| 可选 `storageWarning` | 仅接受固定枚举，区分已观察范围完成后发生的存储问题 |

`storageWarning` 只允许 `matching_completion_receipt_published_before_storage_error` 或 `result_persistence_failed_after_observed_scope`。私有完成 receipt、intent 摘要、路径、PID、URL、参数、live refs 和原始错误不会从这个诊断对象透出；既有业务输出与操作元数据继续遵循各自的脱敏合同。非法字段或无法安全读取的 producer 结果不被采用。标记存在但没有有效结果、进程被强制结束而缺少证据时，可没有 `webviewOutcome`；缺字段不等于 `not_started`。合并实际证据时 `unknown` 优先，单独真实 `not_started` 保留。

操作 wrapper 的终态与业务结果要一并读取：现有 API 中，`completed` 仍可能包含 `result.ok:false` 和 `webviewOutcome.status:"unknown"`。合作取消也不能仅凭 `cancelled` 推导未派发。公开投影不会解释私有 schema2 journal、清除 latch 或新增网络请求。

iOS 旧通路继续使用 `source.kind:"ios"`、`platform:"ios"`，以及 W3C clear/value/click。默认按实际 rich context bundleId 关联前台应用；显式 `xcuitest_app_main_pid_v1` 仍要求原始别名与实际主进程 PID 的观测关系，见 [iOS WebView 说明](software-to-mcp.md#ios-webview-的-dom-通路)。iOS 不接受 Android 的 `textTransport` 配置；Android 的7意图计数也不套用于 iOS。两者共享固定 DOM 引用、输入回显、结果断言与公开 outcome 合同，保留各自归属与输入实现的范围。

首轮 Android driver-only 探针在 ChromeDriver 133 的 W3C `value` 输入 emoji 时实际返回 BMP 限制错误，原始失败保留。其业务账本为0，不能据此推断没有输入事件或控件未被改变；这也不是生产 MCP intent 的验收。新增 CDP 文本通道的驱动探针、协议模型和实际 MCP 结果分别记录于 [验证说明](software-to-mcp-verification.md) 与 [结构化验证记录](software-to-mcp-validation.json)，只能按对应源码、阶段和设备范围判断，不能互相替代或推为任意第三方 App 支持。
