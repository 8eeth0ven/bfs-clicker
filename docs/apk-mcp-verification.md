# Web / Android / iOS → 清单 → MCP 验收记录

[项目总览](../README.md) · [APK CLI](../apk_tools/README.md) · [MCP 网关](../gateway/README.md) · [实现架构](apk-mcp-architecture.md)

首轮验证日期：2026-10-27；iOS/native 扩展验收：2026-10-28。源码、样例与测试在仓库内；构建包、运行报告、清单和补丁保存在被gitignore的output-apk-demo目录。只对自建fixture App和loopback API执行动态请求。

## 结果

| 验收项 | 结果 / 证据 |
|---|---|
| TypeScript构建 | npm --prefix gateway run build通过 |
| 网关测试 | 33/33通过，含目录/分页/方法隔离/多样例形态/凭据/UTF8截断/超时/重试/热加载/资源/真实SDK stdio |
| Python测试 | 80/80通过，设置真实APK与HBC fixture，无skip |
| 发布基线 | 基于远端 v2 整合；src/view/config.json/demo 与远端一致。远端原 package.json 引用的 7 个测试脚本缺失，整仓 npm test 未验收通过；本次独立模块共 113 项测试通过 |
| 运行依赖审计 | gateway npm audit --omit=dev为0 |
| Python完整安装 | 独立Python3.13.7实际安装[verify]成功，Androguard4.1.4+mitmproxy12.3.1共存，pip check无冲突 |
| 三来源样例 | 实际SDK启动，3 sources / 3 resources / 6 groups / 固定4 tools |
| 真实Android验证 | 独立API36模拟器，普通shell uid2000；真实GET200/POST201，2个observed操作 |
| 设备清单接MCP | 同一APK哈希与同一派生清单，add→list→search→call返回200；POST重放被阻断 |
| 独立CLI全链 | 自动构建签名debugAPK→提取→真实mitmdump→合并→真实stdio，全链通过 |
| 新安装依赖全链 | 新[verify]环境mitmdump12.3.1亦跑通CLI→真实HTTP→MCP，GET200、POST重放阻断 |
| Hermes网络配置 | 官方hermesc0.11.0编译HBC84，经hermes-dec0.1.7恢复GET/POST配置，未执行bundle |
| 大bundle内存 | 34MiB连续printable，Python分配峰值<3MiB；独立扫描进程RSS增量<8MiB回归通过 |
| 差异补丁 | gateway新增文件patch已用git apply --check --reverse核对当前内容 |

## iOS / native 新增验收（2026-10-28）

- Python 全套 80/80、网关 33/33，当前测试环境无 skip；pip check 无依赖冲突。
- ELF：真实 clang 编译 ARM32/AArch64/大端对象；本机 rust-lld 链接 AArch64 ET_DYN `.so`，验证动态依赖、curl 导入与 JNI 导出。APK 容器实测 worker/证据定位/脱敏/`--no-native`。
- Mach-O：真实 clang 编译 arm64 iOS 对象，覆盖 IPA/.app/framework；thin/fat32/fat64、加密范围、损坏边界和剥离限制测试。34 MiB 字符串节的 Python 分配峰值测试通过（<4 MiB）。
- `ios-e2e.mjs`：自建 IPA → native 静态未知方法 → 真实 mitmdump/loopback HTTP → 2 个 observed 操作 → 同一清单热加载 → SDK GET 200、POST 阻断；原单不变、敏感值不出返回、静态 native 溯源保留。
- 该 iOS 示例是未签名的静态 Mach-O 夹具，未安装或启动 iOS App。实际 HTTP 由合成 loopback 客户端发送；真机签名/安装/启动、CA 信任与具体 App 的 HTTPS 可见性未验收。
- 报告位于被忽略的 `output-ios-demo/final-chain/e2e-report.json`，可按 [iOS/原生指南](ios-native-guide.md) 重新生成。此处不发布 IPA、DSO、抓包或设备材料。

## 可复现产物（不纳入版本库）

以下路径是运行示例后生成的本地文件，不随仓库发布。可通过复验入口重新生成；APK、流量、认证材料及机器相关报告均留在本地。

- `output-apk-demo/cli-chain/e2e-report.json`：无需设备的真实代理+SDK完整示例，含构建的demo.apk。
- `output-apk-demo/device-mcp/e2e-report.json`：接续实际设备实抓清单的MCP调用报告。
- `output-apk-demo/current-deps/e2e-report.json`：新安装依赖组合的完整CLI/真实代理/SDK示例。
- `output-apk-demo/delivery/device-e2e-report.json`：实际设备捕获、HTTP状态及代理/临时环境清理证明。
- `output-apk-demo/delivery/device-demo.apk`、`device-inventory/`：同一实测APK及静态/派生清单。
- `output-apk-demo/delivery/hermes-validation.md`：官方来源、版本、许可证、哈希、复验命令及具体能力范围。
- `output-apk-demo/delivery/hermes-network.hbc`、`hermes-inventory/`：自建网络配置的真实HBC及提取结果。
- `output-apk-demo/delivery/gateway-addition.patch`：当前基线原无网关，因此提供完整新增网关文件差异，非虚构已有实现的增量补丁。

设备验证scope内有6个去重静态候选，命中3个，候选命中率0.5；它不表示App整体覆盖率。验收覆盖了专用模拟器、代理恢复及临时测试环境清理。

## 复验入口

```bash
npm --prefix gateway ci
npm --prefix gateway run build
npm --prefix gateway test
APK_INVENTORY_FIXTURE=/absolute/path/demo.apk \
HBC_FIXTURE=/absolute/path/fixture.hbc \
HBC_DISASSEMBLER=/absolute/path/hbc-disassembler \
/path/to/venv/bin/python -m unittest discover -s apk_tools/tests -v
node gateway/examples/apk-e2e.mjs --python /path/to/venv/bin/python
```

专用模拟器的操作与安装说明见apk_tools/README.md；MCP客户端配置与三站点凭据模板见gateway/README.md。测试使用合成凭据，不要求用户会话。

## 能力边界

Hermes只对报告中的具体fixture/工具组合给出实测证据，其他版本仍按兼容表和降级处理。真实网络验证使用HTTP fixture；任意发布包HTTPS的CA信任、pinning、忽略系统代理仍会影响可见性。混淆/加固、动态签名、JNI/Flutter AOT等未自动恢复。PCAPdroid的设备编排/UID关联不是已实现能力；HAR导入可用。

observed是采集事实，http_verified是网关健康状态，二者不混用。静态原单不被验证或学习修改，写方法仍需本地明确配置。
