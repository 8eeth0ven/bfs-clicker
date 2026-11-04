# 第23次验收：校准像素比较优化，普通iOS仍未通过

用户已将此前PR#1合并到[主分支检查点](https://github.com/8eeth0ven/bfs-clicker/commit/44be51b12ef6eb01ac6a172287eec5bb4596821a)。本轮在新分支继续，产品运行时仍为 `software-to-mcp-21`，设备编号为 `attempt23`；本轮提交和新PR尚未预填。下方原文中的Draft、main未合并等表述保留为当时的历史发布状态。

- 一份校准验收helper改为直接比较RGBA四字节，减少逐像素临时Buffer视图；alpha、ROI、完整外壳、PNG/CRC/尺寸、source身份、caret及全部超时守卫保持。该helper不进入npm生产包，生产运行时未改变。
- 当前目标测试实际39/39，0失败、0跳过。第22轮主项目239/239、software516/516、Python606项中605通过和1个既有Hermes fixture跳过，以及安装SDK结果均为历史运行。当前121运行时、81 Python-linked及368份非文档包业务原件未变；449份公开代码有1份harness变化，本轮未重跑全套或安装SDK。
- 离线保留图像的6对样本各做3轮配对，结果与拒绝码一致；第6对同进程中位耗时约397.03→120.88毫秒。它只说明该图像对上的局部比较耗时，受n=3、重复PNG及JIT等限制，不代表设备端到端或任意App提速。
- 普通iOS第23次在键盘校准阶段以 `CALIBRATION_SAMPLING_REQUEST_TIMEOUT` 失败，约12007.65毫秒；候选6、只读采样请求51、采样UI动作0、接受候选为null。第6候选的末次source-after请求发出时仅剩151毫秒全局完成预算，未完成返回；这不是4秒source单请求上限被超过。
- 本次未进入MCP发现、学习和两样本验证，ready、统一及生成入口均未完成。setup focus为1，MCP键动作为0；主投影业务提交仍为未知(null)，代理写动作0不推成第三方真实业务0。
- 独立终态复核确认六项清理标志均为真、原有11台设备保留，自有模拟器已移除，自有进程和监听端口均为0，结束时10GiB存储保留要求满足。516份源副本及32份dist按本次原件核对，依赖共享，非hermetic。

机器摘要的 `currentIOS23` 与 `deviceEvidence.iosOrdinarySoftKeyboard.attempt23` 完整保留独立审计和终态摘要一致的safeProjection。审计通过表示终态与清理证据核对通过，设备验收结果仍为失败。历史全套、当前39、离线配对、安装SDK及设备结果不累加为独立总数；本轮不宣称任意网站/App、物理设备或普通系统键盘MCP已通过，也未发布npm。

---

## 第22次及更早检查点原文（完整保留）

# 源码产品21 / 设备验收第22次：完整回归与安装SDK更新

本轮基于已发布的[cc27c268](https://github.com/8eeth0ven/bfs-clicker/commit/cc27c268708e57eeecd7e95c3ec883eefe4e2c42)，源码产品版本为 `software-to-mcp-21`，设备编号为 `attempt22`；当前轮次提交尚未预填。

- 仅三份源码变化：caret比较器、其合成测试，以及runtime版本字面量。白底核心像素可以提供至多32个实际alpha候选，扩展候选的包围盒上限为4096像素；方向独立、复用同一对快照，灰底像素不能推断alpha。超限不启用额外候选，原有peak检查仍保留。
- color tolerance仍为2，白底核心比例0.8、共享opacity下限0.125、underlay上限16及完整校准守卫均保留。该修正不构成速度提升、OS光标身份或任意App保证。
- 新同源完整回归为239/239、516/516；Python606项中605通过、1项既有Hermes缺少fixture的跳过，跳过不计为通过。源码范围121runtime/449公开代码/81Python-linked，其中Python范围80份字节不变、1份linked caret JS改变。
- 新官方基线包370文件/32dist，生产依赖8项在安装包本地解析；六类SDK场景重新执行通过，21个SDK客户端正常退出，86个正常子进程exit0，另1个缺授权worker预期exit1独立计数。原生Android/iOS是有限协议fixture，不替代普通键盘设备验收。
- 普通iOS第22次独立终态：`terminal_failed`，阶段`keyboard_calibration`，错误`CALIBRATION_SAMPLING_DEADLINE`。校准候选6、只读请求54、采样UI动作0；elapsedMs=12039.276916999981仅为本次观察值。
- 两样本：未证实；ready：未证实；统一入口：未证实；生成入口：未证实。主投影业务提交计数为未知(null)；代理动作、setup与fixture业务分别计证，不由未进入MCP推成真实业务0。

机器记录中的`currentIOS22`保留独立终态完整safeProjection；全套、SDK和设备证据不相加为全球独立总数。旧第20轮完整回归/SDK及第21轮校准通过、学习失败事实保留原值。本文不发布npm、不合并main，也不宣称物理设备或通用网站/App已验证。

---

## 已发布attempt21及更早检查点原文

# 普通 iOS 第21次验收：校准通过，学习仍未完成

本次只调整两份验收脚本，产品运行时仍为 `software-to-mcp-20`，基于已提交的 [d42c502](https://github.com/8eeth0ven/bfs-clicker/commit/d42c502736a87de5509609fddddc1fd6797c25ac)。产品运行时、Python源码及安装包业务代码没有变化。第20轮完整回归和SDK结果保留原始范围；当前449份公开代码中两份harness已改变，不将旧505项通过换贴为新510项全套。

- 页面结构读取最多4秒；其他HTTP及解析仍最多1.5秒。至多6个候选、125毫秒间隔及12秒总完成预算不变，完整像素与caret守卫不变。4秒不是速度提升或延迟保证。
- 当前两文件的目标测试实际为32/32，0失败、0跳过。它与旧完整套件及设备证据分列。
- 新建的自有iOS模拟器在第4个候选通过完整键盘校准，耗时6261.63毫秒；36次只读采样请求、0采样UI动作。4份PNG及各自前后source原件已钉定，完整校准独立回放通过。
- 后续学习实际以 `WORKFLOW_NOT_VALIDATED：VISUAL_FRAME_CHANGED` 停止。第二样本清空并输入`b`后，下一键`e`尚未派发；操作保留unknown/noRetry。两样本、ready、统一入口和生成入口均未完成，整体设备验收未通过。
- setup focus为1，MCP键动作38。主投影的业务提交计数继续保留未知；另行独立核对自建fixture计数器、原始图像及唯一Search派发，确认第一样本提交恰1次、第二样本提交0次。该补充不从4次finger动作推算4次业务，也不扩大为第三方App业务或隐藏缓冲区证明。
- 六项清理标志均为真；独立主机检查确认自有模拟器不存在、剩余自有进程和监听端口均为0，原有11台设备保留。516份副本及121运行时/449代码/81Python在本轮结束前后核对一致，缓存WDA组件只复用构建、不复用旧校准图。依赖共享，非hermetic。

机器记录见[验证摘要](software-to-mcp-validation.json)的`postCompiler20HarnessVerification`。当前新增32项及本次实测不扩大为任意App或物理设备验证。下方第20轮和更早的结果保留为其原始检查点历史。

---

## 已发布的 compiler20 检查点原始记录

# 软件转 MCP：能力与验证范围

本页记录`software-to-mcp-20`的有限契约。分发为[草稿PR检查点](https://github.com/8eeth0ven/bfs-clicker/pull/1)，main未合并、npm未发布；[compiler19历史检查点](https://github.com/8eeth0ven/bfs-clicker/commit/d4b8c7e157e532fe107bd01ec0e3e014bd376a07)不是未来20提交声明。机器摘要见[公开验证结果](software-to-mcp-validation.json)。

## compiler20 当前证据

| 项目 | 实际证据 | 范围 |
| --- | --- | --- |
| 完整JS回归 | 主项目239/239；software 505/505，均0失败/跳过 | 121 runtime /449公开代码，终态bytes/modes一致 |
| 完整Python | 606项，605通过、1已知fixture跳过 | 81源码范围；跳过不计通过 |
| 原生自动阶段 | Android/iOS有限协议fixture，4字段、两样本、统一与生成入口 | 实际安装包生产Python；外部fixture只作测试服务，不证明真机/OCR/任意App |
| iOS校准采样 | 完整software回归覆盖有界只读采样/来源守卫 | 不重放tap/业务，不放宽完整校准guard；不是当前设备通过 |
| 官方生产安装SDK | 370文件/32dist，28工具，9个producer文件，6业务场景 | 21实际SDK客户端exit0/stderr0；86正常观察子进程exit0；预期拒绝另1个worker exit1 |
| 当前普通iOS设备证据 | 本轮有限设备终态：terminal_failed；phase=keyboard_calibration；错误码=CALIBRATION_SAMPLING_REQUEST_TIMEOUT | 旧19实际失败、清理和source范围完整保留，不能由新采样或协议fixture追认为成功 |

第20轮在校准阶段因 `CALIBRATION_SAMPLING_REQUEST_TIMEOUT` 停止。只读采样候选1，只读请求6，采样UI动作0；接受候选=未知，完整校准回放通过=否，完整原始source/PNG对已核=否。发现/学习/两样本/ready/统一/生成/MCP均未通过，setup focus=1、MCP键=0、业务提交=0。复制源516份、121runtime/449code/81Python/32dist，前后bytes匹配=是/是；共享host依赖，非hermetic。六清理全部成立=是，fresh审计=是，剩余owned进程/监听端口=0/0。缓存WDA使用/字节复用核验=是/是，最低OS兼容性=未知；未知不追认为兼容。原19失败保留，采样不授予OS光标身份或整条MCP通过。

android：探索1、学习2、统一1、生成1，共5业务；只读规划新增业务/UI均0。ios：探索1、学习2、统一1、生成1，共5业务；只读规划新增业务/UI均0。候选ID稳定，输入类型为string/string/boolean/string；生成目录保留全部候选，cap工具仅注册ready能力，ID/schema/provider/fidelity与统一入口一致。源码、安装包原件bytes/modes、归档及锁文件终态匹配，生产运行时从安装目录解析。既有DOM/open、provider/显式HTTP、手写closed、自动closed、OpenAPI刷新5条SDK场景继续分别核验；它们不增加物理设备、OCR或任意业务等价承诺。

缺少closed-stage owner grant的反例仍单独校验：精确操作与安装包worker绑定，预期exit1/null，父SDK exit0/stderr0；业务/HTTP/UI新增均0。正常trace保持全部exit0，预期拒绝不计入正常通过子进程数。不得将已清理的临时task/status宣称为本次末尾重读。

原生恢复仅允许已证明阶段/入口的路径；未知屏幕拒绝自动返回。iOS采样只重新只读观察fresh图像并核对app/window/source身份；完整校准guard保留，未知像素差异不自动扩大shell或放宽。视觉等价仍不能证明系统光标身份、隐藏buffer或源字符串精确。

完整回归、局部合同、安装SDK和设备证据来源不同且交叠，计数分列不相加。提交前还须独立核验实际index、精确最终tar、两验证文档delta和全文敏感上下文；本投影不自批提交。19及更早失败、Android中文未闭环、OCR空格研究假接受均完整保留。

## compiler19 及更早历史（以下原文保留）

# 软件转 MCP：能力与验证范围

本页记录`software-to-mcp-19`的有限契约与验证范围。统一服务保留28工具；ready不表示任意网站/App全部业务都覆盖。分发为[草稿PR检查点](https://github.com/8eeth0ven/bfs-clicker/pull/1)，main未合并、npm未发布；[compiler18历史检查点](https://github.com/8eeth0ven/bfs-clicker/commit/bed2d4c55f3758d7772c957d40460f9aece60504)不是未来compiler19提交声明。机器状态见[公开验证摘要](software-to-mcp-validation.json)，配置见[指南](software-to-mcp.md)。

## compiler19 历史证据

| 项目 | 实际证据 | 范围 |
| --- | --- | --- |
| 最终冻结完整JS | 主项目239/239；完整software476/476，均0失败/跳过 | 两套结束120runtime/441公开代码逐SHA匹配 |
| 完整Python | 579项，578通过、1 Hermes fixture跳过；144.763秒 | 74份producer/helper源当前匹配，实际签名APK fixture；不是完整JS或508设备同一范围 |
| 自动闭根阶段规划 | 新规划+既有planner19/19；源码SDK两样本/统一/生成共5业务请求 | 同document实际销毁重建、2参数；3参数仅探索候选；不外推自动跨new-document |
| iOS underlay视觉合同 | Node原帧/PNG19项、Python受影响191项分列 | 显式paired_revealed_grayscale，默认strict不变；不是设备或OS光标身份通过 |
| 独立生产安装/SDK | 367文件/32dist、28工具、stderr0；bytes/modes/源/归档/锁一致，8直接依赖本地 | 8个验收producer文件；DOM/open、provider/HTTP、手写closed、自动closed及refresh各有有限实际正链 |
| 普通iOS第19轮 | 终态失败，实际错误 `CALIBRATION_UNRELATED_PIXELS_CHANGED`；phase=`keyboard_calibration` | 508复制源/32dist对120/441；前bytes匹配=是、后匹配=是；共享host依赖、非hermetic |

自动规划从本地`closedStagePlanning.workflowId`启用，随后仍需`allowClosedStages`精确ID授权。只读阶段锚点、独立文本结果、有序完整输入准备与父路径共同产生候选；候选本身不授予执行。成功动作后跨合法语义阶段可重建host/form，阶段内身份仍稳定，未知不重试。新证据不保存输入原文、值摘要和DOM handles；这个范围不扩展到全部私有配置/checkpoint。复现见[自动规划](../test/software-closed-stage-planner.test.mjs)及[配置身份](../test/closed-stage-planning-policy.test.mjs)。

自动链安装包实际为探索1+学习2+统一1+生成1，共5次业务，采用发现的candidateId，没有完整手写specPath；host/field/form实际销毁，decoy不参与。8项离线事件/证据反例不新增HTTP，缺少owner grant不新增HTTP，input echo不能成为独立结果。缺授权反例的1个worker按预期退出1，单独绑定实际操作、安装目录与进程观察记录；17个SDK客户端均退出0且stderr为0，62个正常子进程均退出0，预期拒绝不混入正常退出统计。自动正例只有同document重建；3参数只证明探索候选，旧手写spec跨新document的源码证据保留在compiler18历史，不当新自动学习/双入口证明。DOM/open每mode各5业务，provider探索1+随后4，显式HTTP另2且不新增native UI；OpenAPI原生成、统一、再生成共3业务，refresh/stale请求0。它们不证明物理设备、OCR或任意业务等价。

显式`caretUnderlay`仅用于`fresh_key`：同一对已解码PNG先走原strict，必要时全图重新扫描；一个实际揭示的opaque灰阶端点、白色核心推得共享opacity、局部非白像素cap共同检查。当前owner策略为16像素、核心比例0.8、opacity下限0.125。默认strict及其他派发/结果/取消/预算守卫保留。伪造覆盖或被遮字形可能产生同样像素，因此这是视觉等价权限，不能证明系统caret身份、隐藏buffer或源字符串精确。见[Node合同](../test/visual-caret-underlay.test.mjs)与[Python阶段/IPC](../apk_tools/tests/test_mobile_visual_ios_underlay.py)。

第19轮setup focus=1、MCP键=0、业务提交=0；discoveryStarted=否、learningStarted=否、twoSampleValidated=否、readyPublished=否、unifiedPassed=否、generatedPassed=否。六清理全部成立=是，fresh主机审计=是，剩余owned进程=0、监听owned端口=0，自有simulator退出=是、既有设备保留=是。未知不写成0或通过；缓存WDA使用=是只表示构建复用，不移用旧校准图/成功结论。

执行者保留10GiB可用空间。设备4GiB计划准入、15秒检查，低于11GiB只中止本次harness；storageAbort=否、末核reserve满足=是。这是任务运维约束，不是产品自动删除或并发OS写入quota；历史清理原值保留，不把旧回收量计入本轮。

提交前须另核实际暂存index、精确最终tar、SDK基线外仅批准两验证文档delta，以及完整内容隐私。本投影不自批提交、不自嵌未来commit/tar摘要。原第18轮真实失败、Android中文未闭环与空格研究假接受保留；这些不能由新有限功能追认为成功。

## compiler18 及更早历史（以下原文保留）

# 软件转 MCP：能力与验证范围

本页记录`software-to-mcp-18`的有限契约与验证范围。统一服务保留28工具；ready不表示任意网站/App的全部业务都已覆盖。分发仍为[草稿PR检查点](https://github.com/8eeth0ven/bfs-clicker/pull/1)，main未合并、npm未发布；[compiler17历史检查点](https://github.com/8eeth0ven/bfs-clicker/commit/af4cfa90be06ed951ccee602360e97704e68a2ef)不是未来compiler18提交声明。机器状态见[公开验证摘要](software-to-mcp-validation.json)，配置见[指南](software-to-mcp.md)。

## compiler18 历史证据

| 项目 | 实际证据 | 范围 |
| --- | --- | --- |
| 最终postfix完整JS | 主项目239/239；完整software457/457，均0失败/跳过 | 两套结束119runtime/436公开代码逐SHA匹配；早期457绿但source改变的运行明确superseded，不移用 |
| 完整Python | 571项，570通过、1 Hermes fixture跳过；142.037秒 | 73份producer/helper源当前匹配、实际签名APK fixture；不是119/436完整JS或503设备同一范围 |
| 闭根阶段流程 | producer11/11；独立纯VM11控制分列 | 本地spec+精确startup grant，真实销毁重建、两样本、统一/生成每intent1POST；默认legacy不变，非自动阶段规划 |
| OpenAPI原件refresh | 最终15项refresh+原reader6；related21另列 | 同FD首次字节/stamp、共享原件有界缓存及alias/stamp复核；淘汰重读比首次hash，失败旧current保留，无URL fetch |
| ADB截图身份 | 11局部专项已含Python；本地协议对照13→10条命令，中位1120.818→894.507ms | 只去更早重复proof，最终截图前/后身份保留；非真机或端到端速度 |
| iOS split合同 | Python217及新Node21局部范围分列、不相加 | 本地owner分别批准键面/外壳；实际app/window/image/AX/OCR、默认完整guards保留，SHA非UI授权/OS所有权 |
| 独立生产安装/SDK | 365文件/32dist、28工具、stderr0；bytes/modes/源/归档/锁一致，8直接依赖本地 | 七个验收producer文件不是七次业务；真实DOM/open、provider/HTTP、closed及refresh各有独立正链和正常SDK清理 |
| 普通iOS第18轮 | 终态失败，实际错误 `VISUAL_FRAME_CHANGED`；phase=`learning_second_sample_key_freshness` | 503复制源/32dist对119/436，前bytes匹配=是、后匹配=是；共享host依赖、非hermetic；setup与MCP分开计数 |

闭根阶段当前由owner完整本地spec与`allowClosedStages`精确ID授权，不由模型自动规划。阶段内host/target稳定；成功click及合法新语义边界后只读重验再commit，同doc已观察来源不能经隐藏搬迁洗白，新doc不继承旧receipt，未知不重试。4roots/4层host/256节点/4096每backend及原总预算保持；完整证书上限1MiB。复现见[闭根SDK/反例](../test/software-closed-multistage.test.mjs)。

OpenAPI显式refresh重新读登记主文档、映射refs及最多32补充；每bundle单文件8MiB、总16MiB、32refs，单操作已解码缓存最多16MiB，不是整轮或整个进程上限。没有provenance的旧来源须重导。校验发布时不承诺重新hash全部内容或恶意FS原子快照。见[刷新测试](../test/software-openapi-refresh.test.mjs)与[读取测试](../test/artifact-text.test.mjs)。

安装包实际闭根链共5次业务=探索1+学习2+统一1+生成1，旧host/field/form断开，decoy不参与；new-document的源码direct测试另列。DOM/open每mode同样各5次。provider为探索1+随后4=整fixture5，显式HTTP另2次且不新增native UI。OpenAPI为原生成red、统一blue、再生成cyan共3次，refresh/stale请求0。它们是安装的生产runtime和生成入口证据，不借源码配置，不是设备/OCR或业务等价证明。

第18轮setup focus=1、MCP键=38、业务提交=1；discoveryStarted=是、learningStarted=是、twoSampleValidated=否、readyPublished=否、unifiedPassed=否、generatedPassed=否。六清理全部成立=是，fresh主机审计完成=是，剩余owned进程=0、监听owned端口=0，自有simulator退出=是、既有设备保留=是；未知不会写成0或通过。缓存WDA的实际使用=是，仅代表构建复用，不拿旧17 PNG/XML摘要代替本轮校准。实际阶段与结果按上表，不推测动画、OS归属或任意键盘兼容。

存储执行者保留10GiB，实际设备4GiB计划准入、15秒检查低于11GiB只中止own harness；本轮storageAbort=否，末核reserve满足=是。它不是产品自动删除或并发OS写入quota。历史清理原值全部留在previousCompiler17及更早块，不计本轮回收。

提交前必须核实际暂存index、精确最终tar、SDK基线之外仅批准两验证文档delta及全内容隐私。当前文档投影不会自批maySubmit，不自嵌未来commit或tar摘要；最终分发结果由PR/交付记录核验。其他Android/Web/native历史不是compiler18重跑，中文空格研究已知假接受继续保留，未作为生产能力。

## compiler17 及更早历史（以下原文保留）

# 软件转 MCP：能力与验证范围

统一服务保留28个工具。`ready`指某个有限来源通过受支持契约及真实样本验证，不表示任意网站或App的所有业务已覆盖。本记录面向`software-to-mcp-17`的[草稿PR检查点](https://github.com/8eeth0ven/bfs-clicker/pull/1)，主分支未合并、npm未发布；[compiler16检查点9454aee](https://github.com/8eeth0ven/bfs-clicker/commit/9454aee8c515db26cd6e78f98a6d745c6c699a7d)是历史参考。实际最终提交、精确归档及隐私审核由PR/交付记录核验，不在文档内自嵌未来commit或tar哈希。

机器可读状态见[公开验证摘要](software-to-mcp-validation.json)，配置见[统一入口指南](software-to-mcp.md)。本页只投影核实过的公开计数与范围，不包含本机路径、设备/会话标识、原截图或模型。未终态的数据保持待定；交叠专项和不同源码cohort不相加。

## compiler17 历史证据

| 项目 | 已取得证据或待项 | 范围 |
| --- | --- | --- |
| 主项目回归 | 239/239，0失败/跳过 | 修复后119runtime/429公开代码冻结；结束逐SHA复核 |
| 完整软件回归 | 420/420，0失败/跳过 | 使用postfix新终态；原419=417通过/2失败保留为历史 |
| Python完整回归 | 549项：548通过、1个Hermes编译样本跳过；126.643秒 | 71份Python/相关producer源前后同；实际签名APK夹具；不是设备验收 |
| 多状态live探索 | 正式inventory/fp修正后38/38，兼容54/54；独立5项纯VM检查分列 | 单page live链，普通frontier相对次序保留；unsafe path不重放；早期101与49属于各自旧源码cohort |
| 执行通路与文本契约目录 | 早期producer12与独立helper9交叠；权限收口后15/15（13 metadata+原native-write2） | 成功执行合同，不是原始业务/隐藏App缓冲区真值；学习与执行写权限仍分离 |
| 按键前有限只读采样 | 最终206/206已含原200；独立4项异常优先级mock分列 | 最多6完整候选/12次source/6次capture，原OCR reference固定；没有增加UI重试或mask权限 |
| 普通iOS第16轮 | 截图provider500、20000ms超时，`WEBDRIVER_COMMAND_FAILED` | 19条已完成采样都用首候选，未实际触发额外窗口；旧493源/meta1、无新live；六清理已核，未通过MCP |
| 普通iOS第17轮 | 在MCP前的owned-fixture键盘包络校准以 `CALIBRATION_UNRELATED_PIXELS_CHANGED` 终态失败；setup聚焦1次/HTTP200，探索与学习均未开始，MCP按键/指针及业务提交0 | 27.0/兼容设备类型、fresh WDA；496复制源/32dist与当前119/429代码相符；实际fresh WDA库minOS27.0/SDK27.1、无cache；host依赖共享、不hermetic |
| 独立生产包与SDK | 363文件/32dist，官方SDK28工具、stderr0；独立安装DOM/open两表单与provider/HTTP正链通过 | 实际SDK基线之后，仅两份验证文档可作批准投影；最终index/tar与完整内容隐私仍须提交前实际检查 |

第17轮的1次校准聚焦直接进入Appium，绕过只记录settings的透明proxy；不能用proxy指针0来声称总UI动作0。键面与视觉外壳边界未满足现有校准合同。该轮在MCP发现/学习之前即停止，ready、两样本及双入口均未完成；六清理、fresh进程/端口/owned模拟器退出、旧设备ID保留与496源bytes复核通过。此结论不推断像素变化的身份，也不把本轮当作采样/MCP恢复通过。

多状态探索能在许可primitive完整返回后，沿当前实际观察到的新表单/新document继续；每次仍核scope/auth、正式semantic fp、真实节点/owner/值和新鲜度。lost lease、恢复、未知结果、非预期导航或原地身份漂移不会靠重播unsafe动作恢复。新输入descriptor不直接复制input.value派生的text/label，receipt值/摘要与handles留在闭包；这不扩大成整个私有配置、页面输出或API账本没有业务数据。

本轮另外核验只清理已被替代安装的可重建依赖：逻辑估算45,936,135字节、allocated估算57,745,408字节，754份保护文件不变，原件/模型/源码删除0。旧48目录清理保留为下方历史，不相加成物理释放总数；APFS与系统并发使df增量不能全部归因于本次清理。

普通DOM/open的真实SDK夹具从原根入口Start进入两张销毁重建的表单，探索1次业务请求，学习2次，统一与生成入口各1次，每fixture共5次。另一个lazy ARIA夹具探索只open1次、业务query0，之后学习/统一/生成共4次业务query；不能把两种夹具的探索当学习样本。inventory完成有界延迟挂载/有限scan回读后才形成一次正式fp；不是lease失败后的反复rebase。仍可点击的控件可能在不同semantic state继续探索，0 replay并不承诺全站只submit一次。

closed新generation仅限探索在完整成功动作后的全新已验证state；现有closed MCP workflow仍要求整次执行的host/target稳定，不把重建closed wizard宣传成已学习双入口。已有字体/像素/遮挡、source与scope守卫不放宽。

目录中的modality/fidelity由真实执行adapter及完整recipe/可信配置绑定，DOM/provider/HTTP/OCR分别说明。所有输出的sourceCodepointsProven仍为false；已知通路不会提升candidate readiness。同来源HTTP只提供最多8条ready预览及分页，由调用者明确选择，无自动fallback，不断言与UI业务等价。改变实际backend/limits/allowlist/visual策略仍需刷新，撤学习授权不撤已保留的执行授权，撤执行授权仍在provider调用前拒绝。

按键采样的2秒是首个完整K/global/caret不等价之后的额外候选启动窗，不是整个函数耗时保证；已准入pair仍受原总预算。6候选上限、原reference、颜色/形状/underlay/input/结果守卫都保留。诊断写失败不能替代已有取消/transport等错误，原本要接受但首写失败仍拒绝；诊断trace本身不授权UI。第16轮没有进入额外采样窗口，不能以其19条首候选记录宣称新恢复分支已真机通过。

## 复现与发布范围

直接入口见[多状态探索](../test/browser-live-state.test.mjs)、[多表单官方SDK](../test/software-live-state-workflow.test.mjs)、[lazy ARIA原回归](../test/software-lazy-aria.test.mjs)、[目录与契约SDK](../test/software-capability-fidelity.test.mjs)、[独立写权限](../test/software-native-write.test.mjs)和[有限按键采样](../apk_tools/tests/test_mobile_visual_ios_key_sampling.py)。完整命令为`npm test`、`npm run test:software`、`npm run test:python`。缺少私有历史XML/PNG的环境还可能跳过归档回放；跳过不算通过。

中文空格OCR、字段分区误接受、普通UIKit历史失败、物理设备与任意App兼容性仍按下方历史与research-only边界保留。新的通路标签、更多采样机会或API入口不会自动解决这些问题。10GiB保留是本任务运维门槛，不是产品自动清理或对系统并发写入的硬保证。

## compiler16及更早版本：原记录作为历史保留

以下计数、失败、设备cohort与包记录均保留其当时源码范围，不能移作compiler17通过项。历史“当前”措辞只指当时检查点；机器摘要中的原current块完整移入`previousCompiler16`，其余更早历史不覆盖。

## compiler16 历史证据与待验范围

| 项目 | 已取得证据 | 适用范围与限制 |
| --- | --- | --- |
| Python完整回归 | 525项：524通过、1跳过；125.518秒；70份相关源前后哈希一致 | 缺已编译Hermes样本。与最终Web/JS全量、设备和生产包各有范围，不相加 |
| 普通iOS聚焦后观察 | 相关182/182，已包含新增23与既有159 | 最多3候选/6次helper source/3次新完整OCR；首个严格H或V/H分类时开启一次2秒额外候选启动窗，已准入完整pair仍受原总预算。hidden不授权，不重复focus或输入，offscreen/非法source拒绝。不是设备通过 |
| 原生语义输入精确性 | 12项真实本地HTTP/W3C协议夹具通过；官方SDK loopback两样本与统一/生成通路核对逐码点输入 | 协议提供者回报的语义值，不是实际Android/iOS App或OCR验收。replace最多一次clear/一次value，append核前缀/后缀；空格不trim/fold、Unicode不归一化，漂移或不确定结果不重发 |
| 显式同来源HTTP通路 | 另行导入、批准的HTTP能力保留前后空格、连续空格及CJK/Latin，额外原生UI动作0 | 原生能力仍保留，不是自动UI fallback，也不证明API与界面业务语义自动等价；不能据此称中文视觉空格已解决 |
| 浏览器实时输入前缀 | 最终5份生产源码先37/37；随后新增未尝试输入恢复和正式SDK正链2/2。当前专项文件38个case | 两组分列，不称一次全套38/39。输入和owner/submitter身份、语义及值摘要仅在活页面许可中；失效后依赖动作gap/partial，未知文本不重发；旧缺新submission证据的断点明确拒绝 |
| 浏览器正式SDK夹具 | 探索请求为host=alpha、q=seed；两样本alpha/beta，统一gamma、生成delta。探索1次+后续4次，共5次实际业务请求；两SDK stderr均0 | 初始探索不是学习样本。compiler15历史探索q为空，不能混写为本轮seed。此为源码运行时有限Chromium夹具，不是compiler16独立生产包验收 |
| 当前组合源码完整回归 | `npm test`239/239；`npm run test:software`373/373，均0失败/跳过 | 同一117份runtime、422份代码/测试/配置在两套结束时逐哈希相同；Python70源及设备487快照另列，不混作同范围 |
| 独立生产安装与SDK基线 | 360文件/32dist；锁定仅生产依赖安装，8个直接依赖来自独立安装目录，SDK28工具、stderr0、client/server已关闭 | 基线360份与源逐字节相同。最终仅两份验证文档变化时，另核其余358文件、路径、模式及最终index/tar内容；不把基线包哈希冒充最终包 |

新输入receipt的marker和事件不持久化原值或值摘要；值/摘要及DOM handles仅在闭包中。这个结论不扩展成整个私有checkpoint、配置和API账本全无输入原文。跨frame/root/form或搜索组的许可不通用转移，重载、切换范围、非文本动作、owner/submitter或回显漂移会使许可失效；相同DOM指纹不能证明任意隐藏JavaScript状态相同。

## compiler16 普通iOS第15轮历史失败

实际以`VISUAL_FRAME_CHANGED`终态失败，非transport/global timeout。执行38个键盘按键与4个外部指针动作，共42动作；外部顺序为Focus→Dismiss→submit→Focus。首个alpha样本包含16次固定delete、alpha5键、一次Dismiss与一次业务submit，OCR结果为`RESULT alpha 1`，已进入第二样本，证明首个单样本函数完整返回。第二样本执行16次delete与b1键后，在e派发前被新鲜度守卫拒绝；没有第二次Dismiss/submit、ready或recipe，统一gamma及生成Ab7z均未到达。

两次focus均走首个正常V/V完整观察，未观察到H/mismatch，也没有开启额外候选窗。因此不能把本轮进度归因为新增等待分支的真实恢复成功。输入区不mask、caret/颜色/全图与结果守卫未放宽，也不能凭条状像素认定系统光标身份。

六项清理、四个本次服务端口无监听、owned进程/模拟器退出与既有设备标识保持已复核。该设备验收使用487份冻结原生cohort：已发布compiler15浏览器基线叠加本轮原生变更，不含工作树新browser-prefix，不是最终117/422组合源码、生产包或物理真机/任意App证明。历史14轮和12轮失败均保留，不以本次首样本进度覆盖。

公开复现见[聚焦等待](../apk_tools/tests/test_mobile_visual_ios_focus_wait.py)、[原生精确输入](../apk_tools/tests/test_mobile_webdriver_input_fidelity.py)、[浏览器输入前缀](../test/browser-input-prefix.test.mjs)及[闭根 SDK 流程](../test/software-closed-shadow.test.mjs)。本机525项Python仅跳过Hermes编译样本；在缺少本地历史原件的其他环境，归档XML/时序回放还可跳过，这些跳过不算通过。

下列 compiler15 表格与原件说明保留为历史，不能作为 compiler16 的通过项。

## compiler15 历史专项与待验范围

| 项目 | 已取得的证据 | 当前边界 |
| --- | --- | --- |
| 原生像素任务进程 | iOS 相关 Python 159/159，Node 本地 PNG/IPC 16/16；非阻塞读写/退出等待、错误回复和取消回收均有反例 | 纯文件比较作用域，不跨 UI 动作缓存；原像素、caret、输入、Dismiss 与结果闸保留。不是设备验收 |
| 原生时间预算对齐 | 预算/快照/子进程/假 CLI/操作管理组合 37/37；独立模块重复 15/15、纯探针4项通过 | 三组交叠不相加；没有实际运行480秒或设备验收。业务预算原值不变，外层仅启动、终止及传输余量 |
| 有限 closed Shadow DOM 流程 | producer15/15，独立真实Chromium7/7及既有Web五文件51/51分列；候选→两样本学习→统一gamma/生成delta完成有限本地闭环 | 探索阶段先1次POST（不计学习样本；旧安装探针q为空），学习与双入口新增4次，整个SDK夹具共5次。仅主frame显式author-closed原生文本/按钮/DOM-text子集，不覆盖closed select/check/ARIA/visual/table |
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

## 历史任务存储审计与清理边界

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
