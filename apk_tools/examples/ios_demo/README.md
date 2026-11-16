# iOS 静态样本

这个自建样本把 Info.plist、字符串资源和 arm64 Mach-O 对象放在同一个包里，用于核对离线解析出的文件来源。

![未签名包包含属性表、原生对象与嵌套资源](../../../docs/images/readme-light/ios-static.svg)

样本未签名，原生对象不是可启动的应用。要查看带查询界面的 UIKit 示例，请打开旁边的[模拟器样例](../ios-demo/README.md)。
