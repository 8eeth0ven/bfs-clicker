# bfs-clicker

[简体中文](README.md) · [English](README.en.md)

把 Web 控制台和移动应用的接口线索整理成带出处的清单，供开发者核对界面和应用包里的记录。

![清单的三个阅读维度：出处、观测、证据边界](docs/images/readme-light/evidence.svg)

先看[移动清单的字段定义](apk_tools/schemas/endpoint-record.schema.json)，再看[网关如何表示一条记录](gateway/README.md)。静态线索表明包里出现过这个接口；只有带来源的会话记录才能说明该次运行中曾观测到它。
