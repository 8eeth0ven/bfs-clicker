# BFS Clicker MCP

将网页探索、断点续跑和网站流程/接口图直接提供给模型调用。使用官方 TypeScript SDK v2 的 stdio 服务，兼容 2025-11-25 初始化和 2026-07-28 协议，不需要 HTTP 端口或 API key。

## 安装与接入

要求 Node.js ≥20，先安装依赖及 Chromium：

```sh
npm ci
npx playwright install chromium
```

直接启动：`node /绝对路径/bfs-clicker/src/mcp.js --output-root /绝对路径/output-runs`。也可用 `npm run --silent mcp -- --output-root /绝对路径/output-runs`，或安装本地包后使用 `bfs-clicker-mcp`。客户端负责启动进程；终端手动运行时等待 stdin 是正常行为。stdout 专用于 JSON-RPC，运行日志不会混入协议。

生成包含当前 Node 和仓库绝对路径的接入配置：

```sh
node scripts/mcp-config.mjs --format json
node scripts/mcp-config.mjs --format toml
```

JSON 用于支持 `mcpServers` 的客户端。TOML 可合并到 Codex 的 `~/.codex/config.toml` 或受信项目的 `.codex/config.toml`；桌面、CLI、IDE 的接入说明见 [OpenAI 官方 MCP 文档](https://developers.openai.com/codex/mcp/)。生成器只打印配置，不修改客户端设置。路径搬迁后重新生成。

登录态、代理和高级探索配置由本机受信配置提供：

```sh
node scripts/mcp-config.mjs --format toml --config /绝对路径/trusted-config.json
```

`--config` 是普通 BFS 配置 JSON，可设置 `storageState`、`persistentProfile` 或 `authInject`，其中会话路径相对该配置文件解析。不要把凭证放进工具参数或提交到 Git。工具调用只能选择已注册 runId；图和状态不会返回 private 目录或原始请求正文。

## 调用顺序

1. `bfs_start`：例如 `{"asset":"http://127.0.0.1:3100/","limitMode":"custom","limits":{"maxDepth":3,"maxStates":50},"shotFormat":"none"}`。立即返回 `runId`，实际爬取由独立 worker 执行。
2. `bfs_status`：例如 `{"runId":"返回的ID"}`，建议至少间隔 1 秒轮询，直到 `active=false`。`completed` 是本次预算和策略下的完成；`partial` 表示还有中断、预算或覆盖缺口。
3. `bfs_graph_summary`：先读取节点规模、覆盖统计和缺口。
4. `bfs_graph_nodes`：可用 `type:"api"`、`search`、`offset`、`limit` 分页；`bfs_graph_edges` 可按 `nodeId`、`kind` 筛选。按 `nextOffset` 继续，单页最多 100 条。
5. `bfs_graph_neighborhood`：给定 `nodeId`，读取 1–3 跳邻域，节点最多 200，保留截断标记。
6. `bfs_graph_path`：给定 state 节点中的 `stateId`，读取已知规范路径及 `complete/observed/gaps`。

其他操作：`bfs_list` 分页列任务；`bfs_stop` 保存并停止当前连接启动的 worker；`bfs_resume` 续跑（省略预算参数时保留历史预算）；`bfs_build_graph` 用本地日志离线重建图，返回 `operationId`，随后通过 `bfs_graph_build_status` 查询。

预算 `limits` 可只提供需要修改的字段：`maxStates`、`maxDepth`、`maxDurationMs`、`maxRequests`、`maxActions`、`maxStatesPerHost`；未提供者采用默认或续跑原值。显式 `limitMode:"unlimited"` 才关闭探索预算；请求策略、浏览器超时和证据缓冲仍受约束。`maxDepth:0` 合法。每服务一次只运行一个爬取或图重建任务。

资源：`bfs://guide`、`bfs://runs/{runId}/status`、`bfs://runs/{runId}/summary`。客户端可直接读取这几个有界资源；大图通过查询工具分页获取，完整可视化在状态返回的 `graphPath`，文本报告在 `reportPath`。

## 生命周期和性能

断开 stdio、SIGINT 或 SIGTERM 会请求本连接的 worker 停止并保存；服务重启后 `bfs_list` 重新发现 outputRoot 下的任务，`bfs_resume` 继续。无法停止其他连接的 worker。跨实例的运行锁防止同一 run 同时续跑，STOP 写入需逐次验证 owner token 与 PID。

MCP 与 worker 之间另有本地 IPC。即使客户端直接强杀 MCP 父进程，worker 也会以 `parent_disconnected` 取消采集并收尾；IPC 在预算建立前断开也会被检测。CLI 的断连看门狗在 20 秒后结束仍卡住的 worker，这时可能需要从上次持久断点恢复；普通 CLI 和面板进程没有这个 MCP 专属生命周期行为。

图查询按文件身份和修改时间缓存，预建节点、邻接及路径索引，最多缓存两份图。文件默认上限 128 MiB，单次图查询的 JSON 数据最多 128 KiB；MCP 同时提供 text 与 structuredContent，实际协议帧会更大。超限和截断显式报告，不向模型倾倒整份日志。重建操作记录最多保留 32 条，仅在当前进程内有效，图文件和爬取进度持久化。

图只描述浏览器实际观察到的状态、请求和调用栈。`candidate` 是静态发现，`confidence:"context"` 是上下文关系，均不能当作确证执行路径；未观察到的页面和后端调用不在覆盖声明中。网页标签和文本属于不可信数据。

## 验证

```sh
npm run test:mcp
npm test
```

MCP 测试使用官方客户端启动真实 stdio 服务，覆盖工具发现、输入校验、两代协议、本地网站爬取、分页和路径查询、离线重建、停止续跑、跨连接停止隔离、重连发现和 EOF 保存；另有导航中强杀 MCP 父进程、启动前断连和卡住 worker 看门狗回归。所有业务目标均为本机测试夹具。

SDK 实现依据：[官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。
