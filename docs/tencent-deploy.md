# 旧运行方式迁移

旧文档对应基线 `6b1cf55` 的腾讯云专用配置、批次调度和 TypeScript 结果页。当前实现使用统一请求守卫、schema v2 断点与通用本地面板。运行示例见 [README](../README.md)，修复记录见 [implementation-status.md](implementation-status.md)。

本轮没有对腾讯云或其他公网业务控制台执行探索；以下都是操作方式说明，需要用户自行指定授权目标、范围和会话。

## 新任务与不限预算

```bash
npm run run -- --asset https://console.example.com/ --output output-target --session output-target/session.json --logged-in-selector "#account" --unlimited
```

旧“删除 maxStates / maxDepth=0 即无限”规则已退役。`--unlimited` 或 `limitMode: "unlimited"` 同时取消状态、深度、时长、请求、动作和单主机状态预算。origin、危险动作、标签数、正文与控件采样约束继续生效。

有限模式采用 `--max-states`、`--max-depth`、`--max-duration` 等；`maxDepth=0` 只记录根状态。`MAX_STATES` / `MAX_DEPTH` 环境变量仍用于旧配置入口，不应用来表达无限。

## 会话与范围

会话使用 Playwright cookies/origins JSON，缺失会报错。登录需明确 selector/URL/probe 成功判据，验证码在可见浏览器完成。默认范围只含入口 origin；SSO、API 或 CDN 按 navigationOrigins/requestOrigins/credentialOrigins 明确配置。兼容资源模式只放行外部静态 GET 且去掉凭证。

`--profile safe|forms` 是动作策略，专用浏览器目录使用 `--browser-profile`。profile 必须为此任务专用；单 run/session/profile 锁阻止并发复用。

## 断点与操作面板

```bash
npm run resume -- --run output-target --unlimited
npm run view -- --run output-target
```

新任务从私有配置与 checkpoint 恢复；目标、范围、认证身份或动作策略不兼容会在导航前拒绝。基线旧断点不自动转换，保留旧产物并新建输出目录。

`npm run view` 默认启动 `127.0.0.1:4177`，提供输入资产、默认/自定义/不限预算、滑块、停止与续跑。Node 20 可运行，无需类型擦除参数。旧 `view/server.ts`、`summary.ts` 已删除。

## 结果与资源

JSONL 事件/原始流量保留，HAR 流式导出；resume 累计账本。`private/` 为原件，根目录文本报告默认脱敏；截图与无法识别的业务字段仍需检查。不要提交真实会话或产物。

在 outputDir 创建 `STOP` 或用网页按钮停止，会保存当前进度。不要执行杀死所有 node.exe/浏览器的命令；面板只管理本任务 worker。

旧 rootPool/overviewBatchSize/pageSim/ctxRebuild 等启发式退役并显示迁移说明；并发现在以受控浏览器标签数为边界。实际长跑性能尚未对公网大站验证。
