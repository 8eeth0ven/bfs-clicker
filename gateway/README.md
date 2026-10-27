# 接口清单 → MCP 网关（beta）

[项目总览](../README.md) · [APK 提取与验证](../apk_tools/README.md) · [实现架构](../docs/apk-mcp-architecture.md) · [验收记录](../docs/apk-mcp-verification.md)

TypeScript + `@modelcontextprotocol/sdk` + stdio。Web 清单与 APK 产出使用同一个调用层，客户端始终只看到 **4 个工具**：`list_endpoints`、`search_endpoints`、`call_endpoint`、`add_source`，另有每个来源的只读 resource。

## 安装与启动

需要 Node.js >=22。本文命令均从仓库根目录执行。

```bash
npm --prefix gateway ci
npm --prefix gateway run build
node gateway/dist/server.js --config /absolute/path/to/gateway.yaml
```

仓库提供 [三来源样例配置](examples/gateway.yaml)，包括两个 Web 清单和一个 APK 目录，以及 headers、cookie、storageState 三种凭据模板。`.test` 是示例域；实际使用时替换成本地允许的来源。真实凭据放在被 gitignore 的 `*.local.yaml` 中。

配置中的路径相对于配置文件解析，不依赖 MCP 客户端的工作目录。

## 接入哪种清单

Web 来源接收已经规范化的端点 JSON 数组，或包含 `endpoints` 数组的对象。每条记录使用 `method/url/headers/query/body/categories`；`static_candidate` 表示静态候选，`observed` 表示网络实抓。认证值留在独立凭据文件中。

```json
[
  {"method":"GET","url":"https://api.example.test/items","headers":{},"query":{"page":1},"body":null,"categories":["static_candidate"]}
]
```

Web 爬虫 v2 的原始 API 账本还包含采样和业务分类结构，当前网关不会自动把它转换为该端点格式；需要先生成符合上述契约的清单。不要把原账本、HAR 或验收报告直接传给 `add_source`。

APK 来源可直接使用 `apk_extract` 的产出目录：`source.json` 指向静态原单，`apk_verify` 完成后指向派生清单。两种来源共用发现、调用、凭据与护栏，APK 的 `source=hermes/dex/...` 溯源仍可检索。

## 配置

```yaml
manifest_roots: [/absolute/path/inventories]
state_dir: /absolute/path/private-state
timeout_ms: 10000
max_body_bytes: 32768
max_catalog_bytes: 131072
success_threshold: 3
missing_threshold: 3
methods:
  allow_non_get: false
  allow: []
sources:
  - id: mobile_demo
    kind: apk
    manifest: /absolute/path/inventories/mobile
    credentials: /absolute/path/mobile.local.yaml
    allowed_origins: [https://api.example.test]
    credential_origins: [https://api.example.test]
```

无认证来源设置 `public: true`，同时省略 credentials。绑定凭据的来源必须明确 `credential_origins`，不能匿名降级。`allowed_origins` 约束可调用域；`credential_origins` 再约束秘密可发送的域。新导入的 APK host 不会扩大凭据范围。

凭据模式恰好选择一种：

```yaml
# 认证头
mode: headers
headers:
  Authorization: "Bearer LOCAL_TOKEN"
```

```yaml
# 原始 Cookie 串
mode: cookie
cookie: "sid=LOCAL_COOKIE"
```

```yaml
# Playwright 导出的 cookies；相对于当前凭据 YAML
mode: storageState
storageState: private-state.json
```

```yaml
# Bearer 简写，变量由启动 MCP 的进程提供
mode: token
token_env: MOBILE_TOKEN
```

也支持 `cookie_env` 和 `headers_env`；headers_env 必须包含 JSON 对象。storageState 仅选取匹配 Domain/Path/Secure/Expires 的 Cookie，不把 localStorage 猜成 Bearer；分区 Cookie 跳过并给诊断。不自动刷新、撤销或回写认证。

普通静态头放 `static_headers`。认证头应放 credentials，不放清单、默认请求参数或客户端配置。

## 工具接口

### list_endpoints

```json
{"source":"mobile_demo","filter":{"path":"items","method":"GET"},"limit":20,"include_schema":false}
```

source 省略或 `*` 表示所有已注册来源。filter 支持 `endpoint_id/path/method/provenance/category/kind/extraction_source`。多个逐方法条件必须由同一个 operation 满足；不会拿 GET 的来源与 POST 的方法拼成一次命中。

默认每页20条，上限100，同时受目录字节预算限制。传入返回的 cursor 翻页时保留原查询及页大小。cursor 绑定最长五分钟的不可变快照，热加载不会使旧页漏项或重复；单快照16MiB、总64MiB、最多32份，超预算或淘汰会明确报错/要求重取。过期返回 CURSOR_EXPIRED。

### search_endpoints

```json
{"source":"mobile_demo","keyword":"items page","limit":5,"include_schema":true}
```

路径精确/前缀加权、BM25 和有界字符模糊检索。默认前5条及完整逐方法参数 schema；检索路径、描述、参数名、分类和资源定位，不检索凭据与样例值。

### call_endpoint

```json
{
  "source":"mobile_demo",
  "endpoint_id":"ep_由目录返回的64位哈希",
  "expected_revision":"目录返回的版本",
  "params":{"method":"GET","path":{"id":"42"},"query":{"page":2,"tag":["blue","new"]}}
}
```

同 source、origin、显式 path 模板聚合为一个 endpoint；GET/POST 各自保留参数、来源、权限和学习状态。只有一个已知方法时可省略 params.method；多方法必须显式选择。`method:null` 只可发现，返回 METHOD_UNRESOLVED，不猜 GET。

未知方法候选也保留参数名/类型、描述、分类和提取位置，可搜索与过滤；include_schema控制是否返回其候选path/query契约，不因此授予调用权限。

外层工具 schema 固定，端点参数由 Ajv 二次验证。客户端不能传 URL、headers 或凭据路径。路径参数只替换单段，query 数组编码为重复键，query null 省略。body 不给/JSON null/空对象保持三态。清单 headers/query/body 样例不自动重放。

必需默认值可以通过可信配置的 `defaults[endpoint_id]` 声明；完整 schema 校正使用 `schema_overrides["endpoint_id:METHOD"]`。不要在其中放认证秘密。调用配置变化进入 revision，expected_revision 可阻止旧契约执行。

### add_source

```json
{"manifest_path":"/absolute/path/inventories/mobile"}
```

先在本地配置的 sources 中增加该路径与来源绑定，再调用工具，无需重启。目录固定读 source.json，支持其 inventory 相对引用；不猜目录内文件、不运行 APK。文件或目录必须位于启动时允许的 manifest_roots，检查真实路径与符号链接边界。失败保留旧快照，新增来源发送资源列表更新。

add_source 重读来源绑定；全局方法护栏、根目录、响应限额和阈值仍是启动配置，修改这些需重启。source.json提供inventory_sha256时校验实际读取字节，防止指针与清单不一致。APK的query_shape/body_shape用于参数类型合并，不把类型标记当样例字符串重放。

## 返回、Resources 与学习

所有结果同时返回 `structuredContent` 和同内容 JSON 文本，并声明 outputSchema：

```json
{"ok":true,"data":{},"error":null,"warnings":[]}
```

HTTP 非2xx返回工具错误，同时保留状态码、耗时、attempts及脱敏正文。状态前失败为 null；超时包含读体与重试。GET 暂态连接错误或502/503/504最多重试一次；写请求不自动重试。所有3xx均手动阻止。

响应默认32KiB，按字节有界读取。完整 JSON 才解析为对象；截断 JSON 和普通文本返回脱敏前缀；二进制只给摘要。大小上限针对返回 body，MCP 元数据和兼容文本副本另有协议开销。敏感字段、已登记认证值及常见转义会脱敏，包含跨块、截断边界；任意未知编码和拆字段变换不在通用识别范围。

公开的来源 ID、端点 hash、方法和 schema 类型属于协议元数据；响应正文用独立严格脱敏，避免短 Cookie 标志破坏可调用 ID。stdout 仅 MCP 协议，日志写 stderr。

每来源 resource：`inventory://sources/<source>/manifest.json`，仅暴露归一化目录、参数契约与溯源，不包含凭据文件、捕获样例或原始流量。

学习旁车 `state_dir/health.json` 不修改原单：

- 每(source, endpoint, method, contract)独立统计，一次逻辑调用只记一次。
- 连续N个2xx → http_verified；连续N个404/410 → not_found_suspected。
- 其他网络结果重置连续计数；未发网的本地校验失败不计。
- 动态对象404仅代表本次请求未找到，不自动删除或禁用路由。
- 静态来源仍保留 static_candidate；网关成功不会伪造 App 采集的 observed。

## 方法与业务边界

默认只允许已知 GET。开放非GET须同时设置 allow_non_get 并列出确切 source/endpoint_id/method：

```yaml
methods:
  allow_non_get: true
  allow:
    - source: mobile_demo
      endpoint_id: ep_完整目录哈希
      method: POST
```

logout/signout/revoke族在所有方法及常见query/body动作选择字段中禁止。HTTP GET并不能证明所有业务语义只读；RPC/GraphQL式复用接口需通过可信schema约束选择器。动态签名、mTLS、设备证明、二进制上传等未实现为自动回放能力；已实抓也不等同凭据配置后必能重放。

## Claude Desktop / Cursor

先生成使用当前机器绝对路径的配置：

```bash
node gateway/examples/client-config.mjs --config /absolute/path/gateway.yaml
node gateway/examples/client-config.mjs --cursor --config /absolute/path/gateway.yaml
```

Claude Desktop macOS：合并到 `~/Library/Application Support/Claude/claude_desktop_config.json`。
Cursor：合并到项目 `.cursor/mcp.json` 或全局 `~/.cursor/mcp.json`。仓库还提供两份JSON模板。配置只包含进程与本地配置路径。

## 测试与端到端示例

```bash
npm --prefix gateway run build
npm --prefix gateway test
node gateway/examples/apk-e2e.mjs --python /absolute/path/to/python
```

最后一条会构建自有debug APK（需要Android SDK/JDK），真实提取、启动mitmdump、向本地8765示例API发送请求、验证合并、通过真实SDK stdio执行add→list→search→call，并断言写方法阻断、秘密不回传、静态原单不变。可用 `--apk` 指定已构建示例包、`--out` 保存报告。`--verified-inventory /path/to/device-inventory`可直接接续已由真实设备生成的派生清单并校验APK哈希。此命令不操作设备；真实设备链路见 [APK工具说明](../apk_tools/README.md)。

Python/FastMCP适合作为备选实现，Tool Search已有相似搜索/调用模式。本项目保持TypeScript SDK和固定工具接口；不引入逐端点工具列表。
