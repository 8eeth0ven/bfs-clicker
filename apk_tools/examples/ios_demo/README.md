# 自建 iOS 静态证据夹具

```bash
python apk_tools/examples/ios_demo/build_demo.py --out output-ios-demo/demo.ipa
ios_extract output-ios-demo/demo.ipa --out output-ios-demo/inventory
```

`--out` 也接受新的 `.app` 目录，`--api-origin http://127.0.0.1:8765` 可将所有合成端点绑定到本地演示服务。构建需要支持 Apple arm64 目标的 clang；不下载 SDK 或第三方应用。

夹具包含二进制 Info.plist、JSON 请求配置、UTF-16 strings 和自行编译的 arm64 iOS Mach-O 对象，framework 中也放入该对象以测试嵌套原生库识别。它未签名，Mach-O 对象不是可安装、可启动的 iOS 可执行文件；只用于离线提取、验证合并与 MCP 契约的可复现测试，不能替代真实设备运行证据。C 代码不执行网络请求。
