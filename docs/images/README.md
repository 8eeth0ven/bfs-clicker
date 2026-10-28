# README 功能图

[项目首页](../../README.md) · [架构说明](../apk-mcp-architecture.md)

架构图为功能示意；一键准备引导页截图使用真实界面与合成数据。均不包含真实目标、凭据或设备数据。

| 图片 | 用途 | 维护源 |
| --- | --- | --- |
| [capture-setup-ui.png](capture-setup-ui.png) | 一键准备引导页，合成数据界面 | `apk_tools/apk_inventory/setup_ui.html`，浏览器渲染 |
| [overview-mobile.png](overview-mobile.png) | 当前 Web / Android / iOS / MCP 总览 | 内置 imagegen 编辑，提示词见下文 |
| [mobile-native-workflow.png](mobile-native-workflow.png) | ELF / Mach-O 的静态证据与验证边界 | [mobile-native-workflow.svg](mobile-native-workflow.svg) |
| [overview.png](overview.png) | 初版 Web / APK / MCP 封面，作为历史参考保留 | 内置 imagegen 生成并精修，提示词见下文 |
| [web-workflow.png](web-workflow.png) | Web 范围、遍历、证据、报告与续跑 | [web-workflow.svg](web-workflow.svg) |
| [apk-mcp-workflow.png](apk-mcp-workflow.png) | APK 提取、可选动态验证、统一清单与 MCP 护栏 | [apk-mcp-workflow.svg](apk-mcp-workflow.svg) |

流程图以 SVG 为可维护源，中文标签为文本；PNG 为 1600 × 900 浏览器渲染版本。修改 SVG 后，以相同画布大小重新导出 PNG，并检查文字、连线与本项目实际能力。配色以浅蓝、海军蓝、青色及紫色区分模块。

## 总览封面的提示词

生成方式：内置 `imagegen`，非 CLI/API 脚本；未使用真实截图或外部人物素材。

初始提示词：

```text
Use case: infographic-diagram. Asset type: GitHub README project cover for the open-source repository bfs-clicker. Create a polished, clear technical editorial illustration, wide 16:9 landscape, intended to remain readable at 960px width. A spacious white / pale blue canvas, crisp dark navy typography, restrained teal and indigo accents, fine grid details, no neon hacker imagery. Header text exactly: "bfs-clicker". Subtitle text exactly: "Web Exploration · APK Evidence · MCP Gateway". Below it, three equally important visual modules connected left to right: a real-browser inspired generic window with a small route graph (label exactly "01  WEB" and small exact line "Playwright · UI traversal · API capture"); an Android application package with layered resource/DEX/string evidence cards (label exactly "02  APK" and small exact line "Static extraction · ADB · mitmdump"); a structured endpoint catalog connecting to a small AI client symbol (label exactly "03  MCP" and small exact line "4 tools · stdio · GET-only beta"). Make the distinctions between browser exploration, package inspection and catalog-to-tool execution visually legible. Footer badge text exactly: "Architecture overview · Synthetic illustration". This is a conceptual illustration, not an actual product screenshot. All objects should be flat or very subtly dimensional, clean contours, generous whitespace, precise hierarchy. No extra UI claims, no Frida logo or text, no robots, locks, skulls, people, screenshots, real hostnames, code dumps, watermarks or other text. Do not imply a direct automatic Web-ledger conversion; the three modules express the project capabilities.
```

最终精修提示词：

```text
Edit this GitHub project cover with one precise change: REMOVE the short turquoise right-pointing arrow in the gap between the left browser window and the Android APK package, around the left-middle of the image. Fill its former location seamlessly with the existing white/pale blue background. The WEB and APK sections must read as parallel project capabilities, not a Web-to-APK transformation. Preserve everything else exactly: all text, typography, module positions, dimensions, colors, browser drawing, APK resources/DEX/strings, the arrow from APK evidence toward the endpoint catalog, AI Client, and footer. Do not add any new text or objects.
```

Web 原始账本接入 MCP 需显式规范化；封面表达能力总览，不表示存在 Web → APK 转换。当前主线的 Android 验证链路是 ADB + mitmdump，Frida/Activity 跳转尚未整合。

## iOS / native 扩展封面

`overview-mobile.png` 使用内置 imagegen 编辑原始封面，采用独立文件名保留原图。`mobile-native-workflow.svg` 是可维护的文本矢量图，PNG 为相同画布的浏览器渲染。所有图均未使用真实 App、凭据或设备截图。

最终编辑提示词：

```text
Edit the supplied bfs-clicker overview, preserving its dimensions, palette, title, WEB drawing, MCP drawing and footer. Update subtitle to "Web Exploration · Mobile Evidence · MCP Gateway". Change middle heading from "02 APK" to "02 MOBILE" and its feature line to "APK / IPA · ELF / Mach-O · mitmdump". Replace middle single APK document with compact adjacent documents labelled "APK" and "IPA", representing Android and iOS. Change middle evidence cards to "Resources", "DEX / ELF", "Mach-O / Strings". Mobile evidence feeds the existing endpoint catalog arrow. WEB and MOBILE are parallel capabilities: do not add an arrow between the browser and the mobile files. This is an architecture illustration, not a real screenshot. Keep all other text and objects unchanged.
```

一键准备截图使用演示设备、演示 SSID 与合成指纹；二维码指向使用指南，不是运行中的会话。截图由真实 HTML 界面渲染，不涉及 imagegen。
