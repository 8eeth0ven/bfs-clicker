# Android Unicode 输入桥

这是显式启用的本地测试输入法，不自动安装或切换输入法。默认 ADB 仍使用原 ASCII 输入行为。构建：

```sh
.venv/bin/python apk_tools/examples/unicode-ime/build.py --out /absolute/output/ime.apk
```

在自己管理的设备安装并选择该输入法后，为可信设备配置增加：

```json
{"backend":{"unicodeInput":{"component":"com.bfs.mcp.ime/.UnicodeIme","apkSha256":"安装的 ime.apk 的 SHA-256"}}}
```

后端每次验证单 base.apk 安装哈希和当前输入法；广播受 Android DUMP 权限保护，普通应用不能提交。IME再次核对编辑器所属App，并使用单次nonce、UTF-8 base64和SHA回执；不执行脚本，不联网，不记录输入。聚焦后先核对实际目标的 focused 状态，替换后检查实际UI字段的瞬时摘要；追加会先按UTF-16长度把光标移到末尾，并验证原前缀SHA及精确新增后缀。所有输入证明仅在内存，不进入公开库存。未知回执或断连不重发，写操作维持原来的unknown语义。IME不证明后台业务已经成功。

辅助APK带有仅用于设备验收的离线UnicodeActivity。`node test/android-unicode-e2e.mjs` 创建隔离模拟器及独立ADB服务，安装辅助APK，学习中文样本并调用生成入口，然后恢复原输入法、卸载和删除本轮自建资源。不要将测试结果外推到任意IME、App或物理手机。

当前参数化 workflow 保持 `replace:true` 的既有合同；追加路径属于原生后端能力，并通过生产 MobileSession.step 单独验收，不宣称已向生成 MCP 发布有状态追加流程。
