# iOS 与 APK 原生层接口证据（beta）

[项目首页](../README.md) · [移动端 CLI](../apk_tools/README.md) · [MCP 网关](../gateway/README.md) · [架构](apk-mcp-architecture.md) · [验收](apk-mcp-verification.md)

APK 的 DEX/资源与 `.so`，以及 iOS 的 IPA/`.app`/Mach-O，最终进入同一份六字段接口清单。静态证据、运行时实抓和网关健康状态分别记录。

![Android ELF 与 iOS Mach-O 的接口证据链](images/mobile-native-workflow.png)

## 安装与输入

仓库根执行，静态提取要求 Python ≥3.11；mitmproxy extra 要求 Python ≥3.12。

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e './apk_tools[verify]'
source .venv/bin/activate

# 默认已包含 .so 分析
apk_extract demo.apk --out output-mobile/demo
apk_extract demo.apk --out output-mobile/no-native --no-native

# iOS：支持 IPA 或 .app 目录
ios_extract demo.ipa --out output-ios/demo
ios_extract /path/to/Demo.app --out output-ios/app

# IPA 内有多个顶层 App 时明确选择
ios_extract demo.ipa --app Payload/Demo.app --out output-ios/selected
```

CLI 也可用 `PYTHONPATH=apk_tools python -m apk_inventory.ios ...`。Hermes 开关、外部工具、`--limits` 与 `--strict` 沿用 APK 的语义。默认 partial 返回 0；strict 下 partial 返回 3；致命输入错误返回 2。

ZIP 路径、重复成员、符号链接、解压比例、总量、单成员和数量都有检查。`.app` 拒绝 symlink/特殊文件，输出不得置于输入 Bundle 内。当前 beta 不自动安装 IPA、处理签名或修改设备。

## 两类原生二进制

| 输入 | 解析与定位 | 能说明什么 |
| --- | --- | --- |
| APK `.so` / ELF | 32/64 位、大小端、ABI、节、动态依赖、导入/导出、JNI 与网络符号；字符串保留文件 offset/section/architecture | 库中存在 URL 或相关网络符号，不表示已知它们的数据流关系 |
| App/framework/dylib / Mach-O | thin/fat32/fat64、各 slice、段/字符串节、依赖与 nlist 符号；识别 encryption load commands | 可证明的明文字符串与元数据；加密区不被当作可解析字符串证据 |

ELF 复用 [pyelftools](https://github.com/eliben/pyelftools/blob/main/doc/user-guide.md)，Mach-O 复用 [macholib](https://macholib.readthedocs.io/en/latest/) 的结构与 load command 定义。为控制内存，不调用会读取全部节内容的顶层 MachO 解析路径；按边界读取结构与节内容。后端不加载或执行库，不反编译 JNI/Swift/ObjC 的任意数据流。

未知方法保留 `method: null`，仅可浏览和搜索。仅发现 `curl_easy_setopt`、`NSURLSession`、`GET` 字符串或 JNI 名称，不足以给相邻 URL 指定方法。JSON/JS 的可靠字面量对象及真实请求可以补充方法。

加密 slice 通过 load command 标记；与加密范围相交的节和符号范围跳过。缺少 Mach-O 依赖时明确报告，不盲扫可能的密文。ELF 缺少后端时可降级有界字符串扫描，但会报告未结构化验证。符号剥离、动态字符串解密、运行时拼接和动态签名可能使提取率下降。

## iOS 资源与身份

- Info.plist 支持 XML 与 binary plist；读取 Bundle ID/版本。ATS、URL schemes 为配置线索，不能升级为已调用 HTTP 端点。
- `.strings` 支持 plist/常见字面量形式；JSON/JS/assets 保留可靠关联；React Native/Hermes 沿用可切换后端。
- `kind: ios`；`app.package_name` 与 `app.bundle_id` 相同。IPA 使用文件 SHA-256，填 `artifact_sha256` 和同值 `ipa_sha256`；`.app` 使用相对路径、长度和文件内容的稳定树哈希，只填 `artifact_sha256`。两者均不伪造 `apk_sha256`。
- `source.json` 指向 `static/<generation>/endpoints.static.json`，且保存 `inventory_sha256`。整代写完才原子切换指针；根同名文件仅为最新便利副本。验证始终对照描述符中的静态原单。

共同基础字段仍为 `method/url/headers/query/body/categories`，schema 维持向后兼容的 1.1 扩展。新增 `source=plist/native`；原 `asset/hermes/network/...` 保留。

```json
{
  "method": null,
  "url": "https://api.example.test/native/items",
  "headers": {},
  "query": {"page": "1"},
  "body": null,
  "categories": ["static_candidate"],
  "source": "native",
  "package": "Frameworks/Example.framework/Example",
  "evidence_ids": ["ev_example"]
}
```

原生定位在 `evidence.jsonl` 的 `offset` 与 `native` 对象中。APK 另输出 `native_libraries.json`；iOS 在 extraction report 的原生 stages 中记录 metadata。符号线索不与 URL 任意交叉组合。

## 可选动态验证

已有 HAR 或本 addon 的原始事件 JSONL：

```bash
ios_verify demo.ipa --inventory output-ios/demo \
  --har capture.har --scope scope.local.yaml --isolated-device

ios_verify /path/to/Demo.app --inventory output-ios/app \
  --observations capture.events.jsonl --scope scope.local.yaml
```

```yaml
# scope.local.yaml
origins: [https://api.example.test]
```

普通 HAR 无 App 进程归属证据；只有专用隔离测试会话才可声明 `--isolated-device`。否则请求记作 unattributed，不升级候选。实际 HTTP 观察为 `observed`，包括 4xx/5xx；TLS/CONNECT 事件不算业务端点。静态 native 来源在升级后仍保留。

真实 mitmdump 监听：

```bash
# 本机测试客户端
ios_verify demo.ipa --inventory output-ios/demo \
  --duration 5m --proxy 8080 --listen-host 127.0.0.1 \
  --scope scope.local.yaml --isolated-device

# 物理测试设备：替换此文档占位 IP，并手动把设备 Wi-Fi 代理设为该 IP:8080。
TEST_PROXY_IP=192.0.2.10
ios_verify demo.ipa --inventory output-ios/demo \
  --duration 5m --proxy 8080 --listen-host "$TEST_PROXY_IP" \
  --scope scope.local.yaml --isolated-device
```

本工具启动和回收自己的 mitmdump 进程；不更改 iOS 设备设置，因此结束后设备代理需人工复原。默认仅监听 loopback；LAN 监听需明确指定本机地址。CA 信任、pinning、App 是否采用系统代理决定 HTTPS 可见性。清单的 SHA 必须与本轮 IPA/`.app` 一致；中断或采集失败不切换 active inventory。

## 接入 MCP

先在本地网关配置绑定来源、允许的 origins 和凭据：

```yaml
manifest_roots: [/absolute/path/output-ios]
state_dir: /absolute/path/private-state
sources:
  - id: ios_com_example_demo
    kind: ios
    manifest: /absolute/path/output-ios/demo
    credentials: /absolute/path/ios.local.yaml
    allowed_origins: [https://api.example.test]
    credential_origins: [https://api.example.test]
```

配置示例的 id 应替换为 `source.json` 中的 `source_id`。凭据格式与 Web/APK 相同。已启动的客户端依次调用：

```json
{"manifest_path":"/absolute/path/output-ios/demo"}
```

```json
{"source":"ios_com_example_demo","filter":{"kind":"ios","extraction_source":"native"},"include_schema":true}
```

先 `add_source`，再 `list_endpoints/search_endpoints` 获取当前 ID/schema/revision，最后 `call_endpoint`。未知方法会被阻断；静态或 observed 的 POST 也仍受 GET-only beta 护栏。换包指纹会改变操作 revision 与学习上下文，避免沿用旧包的健康标记。样例见 [iOS 网关配置](../gateway/examples/ios-gateway.yaml)。

## 可复现示例与限制

```bash
python apk_tools/examples/ios_demo/build_demo.py --out output-ios-demo/demo.ipa
node gateway/examples/ios-e2e.mjs --python /path/to/venv/bin/python
```

示例使用 clang 编译的 arm64 iOS Mach-O 对象和资源，并打包为自建 IPA。它未签名、不可安装启动。E2E 的 HTTP 来自本机测试客户端，经真实 mitmdump 后合并到同一清单，再由真实 MCP SDK 执行 list/search/call；验证 source/native 保留、凭据脱敏、未知方法与 POST 阻断、静态原单不变。它不代表已经在真实 iOS 设备上运行 App。

加固/混淆、字符串加密、动态加载、Flutter AOT、二进制协议、动态签名或设备证明均可能需要其他人工分析；该模块不承诺完整恢复接口或穷举行为。真实设备运行与具体发布包 HTTPS 可见性仍需逐环境验证。
