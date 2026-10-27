# APK 接口清单工具（beta）

`APK → 静态证据 → 可选运行时观察 → 派生清单 → TypeScript MCP`。

## 安装

以下命令在仓库根目录执行；当前实测环境为macOS，POSIX子进程与设备编排路径已验证，Windows未验证。

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e ./apk_tools
# 在用于动态验证的环境安装mitmproxy；adb来自Android platform-tools
.venv/bin/python -m pip install -e './apk_tools[verify]'
source .venv/bin/activate
```

提取模块Python>=3.11，动态验证extra需Python>=3.12（本轮Python3.13.7实测）。Androguard4.1.4、pyaxmlparser0.3.31固定适配；Hermes/JADX是可选外部CLI，不自动下载。主进程与worker内存监控依赖psutil。独立环境已实际安装Androguard4.1.4与mitmproxy12.3.1，pip check通过。

## 提取

```bash
apk_extract demo.apk --out output-mobile/demo
apk_extract demo.apk --out output-mobile/deep --profile deep --jadx /path/to/jadx
apk_extract demo.apk --out output-mobile/hermes --hermes hermes-dec --hermes-executable /path/to/hbc-disassembler
```

亦可 `PYTHONPATH=apk_tools python -m apk_inventory.extract ...`。

- Manifest AXML、resources.arsc及实际存在的strings.xml。
- 多DEX字符串与结构化Retrofit方法/参数注解；资源位置和类/方法引用保留。
- assets JSON/文本/普通JS；只关联可证明的配置对象，不做host×path任意拼接。
- HBC魔数/版本探测；支持切换hermes-dec、旧版hbctool、匹配版本的官方hbcdump、显式指定的hermes_rs字符串CLI。
- 无兼容工具时64KiB有界ASCII/UTF16扫描，34MB连续可打印bundle不整体累积。
- deep只对网络相关类按需调用JADX，不要求每包全量反编译。

`--base-url` 是为已知相对Retrofit路径提供可信基址的显式校正，不表示从包内证明了服务绑定。未知方法始终null。

`--limits limits.yaml` 可覆盖ExtractOptions的max_*、worker_timeout、worker_memory_bytes、chunk_bytes。ZIP成员/解压量/比例/候选数受预算；解析器和外部工具受时间、输出、进程树RSS预算。单个后端失败保留其他证据并标partial。默认partial退出0，`--strict`时partial退出3；致命输入错误退出2。`--hermes required`要求所需Hermes阶段成功，缺后端或失败时也退出3。

Hermes后端能力与版本表仅表示适配范围，不代表每一版本已在本项目实包验证。对象恢复需明确的索引/字面量关联；混淆、字符串加密、加固包、JNI及Flutter AOT等提取率下降属于预期，报告列出限制。已有root/Frida工具不进入本工具默认链路。

本轮已真实验证Meta hermesc0.11.0编译的HBC84与hermes-dec0.1.7，恢复GET URL及POST配置对象；公开HBC94样例仅验证解析能力。复验网络配置：用匹配版hermesc `-emit-binary -out fixture.hbc apk_tools/tests/fixtures/hermes-config.js`，再设置HBC_FIXTURE/HBC_DISASSEMBLER运行测试。未测版本不因表项存在而获得兼容性声明；结构化解析成功时不会混入binary storage扫描，避免相邻字符串被误拼为URL。

## 产物与字段

```text
source.json                  # kind=apk、应用身份、active inventory相对指针
endpoints.static.json        # 六基础字段的静态原单
evidence.jsonl               # backend/version/mode/资源或代码定位
fragments.jsonl              # 未绑定相对路径、host、deep-link等线索
hosts_summary.json           # 位置出现次数、唯一URL、环境词提示
extraction_report.json       # 阶段完成情况、预算、工具版本、限制
verified/<session>/          # 实抓派生清单、去敏观察、覆盖率与恢复报告
```

统一基础字段：method/url/headers/query/body/categories；记录source是manifest/strings/hermes/dex/asset，验证新增端点可为network。query保持dict，重复键为数组。url移出query和fragment，保留path大小写、尾斜杠与模板。

method:null只可发现。package是类/资源定位；应用包名在source.app.package_name。body_capture区分未知、无体、仅形态、截断；body样例不自动发给目标。参数形态通过body_shape/query_shape保留。schema见 [endpoint-record](schemas/endpoint-record.schema.json) 与 [source descriptor](schemas/source.schema.json)。

嵌套query对象没有统一传输编码，样例值投影为null、原类型保留在query_shape，并报告UNSUPPORTED_QUERY_ENCODING/partial；不会擅自猜成deepObject或JSON字符串。

stdout只输出一行JSON摘要，stderr为脱敏诊断。产出目录不得存真实认证值；Web/APK凭据统一由独立本地YAML绑定。

## 受控动态验证

```bash
apk_verify demo.apk --inventory output-mobile/demo \
  --duration 5m --proxy 8080 --device emulator-5554 \
  --scope scope.yaml --isolated-device
```

```yaml
# scope.yaml，只记录本轮选择的exact origins
origins: [https://api.example.test]
```

省略inventory时在`.apk-inventory/<apk hash前缀>`查找，没有就先提取。核对APK SHA256后，启动mitmdump、设置Android系统代理、安装/启动应用，等待人工操作。--isolated-device声明本轮专用隔离设备；普通代理并无进程UID证据，不声明时流量记unattributed，不升级APK候选。

模拟器通常用10.0.2.2，USB设备可用本轮adb reverse。HTTPS需App信任本轮测试CA；默认CA目录inventory/.mitmproxy（含私钥，应保持本地）。不root、不重打包、不自动安装系统CA、不操作支付模块、不自动点击真实App。证书不受信、pinning、忽略系统代理只会形成限制和诊断，不能推断“没有接口”。

采集时长从App和代理ready后开始。正常结束、超时、SIGINT/SIGTERM和异常均恢复原http_proxy；仅移除本轮reverse映射，不清数据、不卸载、不登出。PAC等不支持的已有代理要求使用`--manage-proxy manual`。恢复遇到并发人工修改时保留人工值并报告。

实际HTTP请求即observed，4xx/5xx也算；CONNECT/SNI/TLS握手不生成业务端点。请求正文流式tee只取有界前缀并原样转发，响应默认流式通过。大体/压缩体无法安全推形态时明确标unknown/truncated。

验证不主动重放静态候选。已知方法须一致；未知方法由实抓补充；模板歧义不批量升级。未命中保持static_candidate；新流量source=network。派生结果写新文件，再原子更新source.json指针，静态原单不改。多次验证均以静态原单为基线，旧会话文件保留。

覆盖率分别统计scope内候选命中率、已知方法操作覆盖率；零分母为null。未归因/歧义流不进分子，低覆盖不代表全App覆盖率。

## 离线导入

```bash
apk_verify demo.apk --inventory output-mobile/demo --observations capture.events.jsonl --scope scope.yaml
apk_verify demo.apk --inventory output-mobile/demo --har capture.har --scope scope.yaml --isolated-device
```

observations输入是本addon的事件JSONL；验证输出的normalized observations不是同一种事件格式。普通HAR没有App归属证据，只有明确的隔离采集才能声明isolated-device。PCAPdroid等工具可导出HAR，但设备侧采集自动编排与UID关联不属于当前beta已实现能力。

## 自建样例与测试

```bash
python apk_tools/examples/build_demo.py --out output-apk-demo/demo.apk
apk_extract output-apk-demo/demo.apk --out output-apk-demo/inventory
python -m unittest discover -s apk_tools/tests -v
```

构建需要本地JDK与Android SDK build-tools/platform，无Gradle网络下载。输出旁保留被gitignore的inventory-demo-debug.keystore用于重复构建的稳定签名，密码android仅用于自建测试App。示例含编译AXML/ARSC、真实DEX/Retrofit注解、plain JS bundle和assets配置；不是伪装成Hermes的文件。App只有本地GET/POST按钮，目标127.0.0.1:8765，显式测试代理默认10.0.2.2:8080，可用Intent extras base_url/proxy_host/proxy_port调整。所有认证示例均为合成值。

完整无设备链路：`node gateway/examples/apk-e2e.mjs --python /path/to/venv/bin/python --apk /path/to/demo.apk`。
真实设备链路可在专用已启动模拟器运行：

```bash
PYTHONPATH=apk_tools python apk_tools/examples/device_e2e.py \
  --apk /absolute/path/demo.apk --inventory /absolute/path/inventory \
  --device emulator-5554 --out output-apk-demo/device-report.json
node gateway/examples/apk-e2e.mjs --python /path/to/venv/bin/python \
  --apk /absolute/path/demo.apk --verified-inventory /absolute/path/inventory
```

第一条只自动点击本仓库com.example.inventorydemo的两个本地HTTP按钮，拒绝其他包名；第二条将同一份设备实抓产物接续到MCP。独立ADB server可加--adb-port。测试运行记录见[架构说明](../docs/apk-mcp-architecture.md)。fake设备测试只能证明编排逻辑，不能替代实际模拟器抓包证据。
