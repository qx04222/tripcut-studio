# macOS 设置页与整体布局调研摘要

> 2026-09-03 安全整理版。原文件误收录了代理运行 JSONL、工具清单、请求标识、工作目录和推理元数据；这些内容与产品调研无关，已移除。本文仅保留可复核的设计结论与来源。

## 结论

TripCut 属于功能较多、长期使用的专业工作台，设置页适合采用「左侧分区导航 + 右侧单列内容」；同一分区内使用紧凑的设置行，不把每个开关都做成独立大卡片。高频、可逆项在前，诊断和缓存靠后，危险操作独立置底并二次确认。

## 可执行规格

| 项目 | 建议 | 依据 |
|---|---:|---|
| 内容区外边距 | 20px | 旧版 macOS HIG 布局量级；WebView 以 1 CSS px 近似 1 pt |
| 分组内边距 | 16px | 原生 group box 的常用下限 |
| 同组设置行间距 | 6px | 常规尺寸控件的垂直节奏 |
| 分组间距 | 20–24px | 形成明确但不过度松散的层级 |
| 标题字号 | 13px / 600 | 系统常规标签量级，中文略加强字重 |
| 正文字号 | 13px / 1.45 | 中文桌面应用的可读基线 |
| 说明文字 | 11–12px / 1.45 | 11px 只用于短说明，不承载关键操作信息 |
| 控件最小点击高度 | 32px | 鼠标操作紧凑度与可点击性的折中 |
| 开关与下拉 | 行尾对齐 | 扫描路径稳定，标题和说明留在左侧 |

## 信息架构

1. 常规：主题、界面缩放、代理开关。
2. 性能：并发、缓存状态和清理。
3. 分析：阈值、最佳镜头权重。
4. 工具：FFmpeg、FFprobe、Whisper 状态与固定路径。
5. 可选 AI：默认关闭、默认无 provider、单服务锁定、预算与调用账本、逐用途发送字段说明。
6. 诊断：日志、健康检查、恢复信息。
7. 危险操作：清缓存或重置，单独分组并明确影响范围。

每个设置行统一采用「图标（可选）+ 标题/说明 + 控件」三段结构。说明文字回答“它会影响什么”，错误提示紧邻对应控件。路径字段允许复制和在访达中定位；自动检测值和用户覆盖值必须视觉区分。

## 参考样本

- Apple Human Interface Guidelines：以平台语义、系统颜色、可访问性和一致的控件行为为准；现行网页不再稳定提供旧版精确点数表。
- [macOS Layout Guidelines 汇编](https://marioaguzman.github.io/design/layoutguidelines/)：整理旧版 Apple 布局尺寸，包括 20pt 外边距、6pt 控件间距和 16pt group box 内边距。
- [macOS Settings UI 设计讨论](https://zenn.dev/usagimaru/articles/b2a328775124ef?locale=en)：13pt 标签、11pt 说明和 6–8pt 控件间距等社区整理值。
- [Linear 设置页重构](https://linear.app/changelog/2024-12-18-personalized-sidebar)：按 Features、Administration 和 Teams 等归属组织复杂设置。
- [Raycast Manual](https://manual.raycast.com/)：侧栏分区、右侧详情、扩展级设置和全局设置分层。
- [MonitorControl](https://github.com/MonitorControl/MonitorControl)、[Stats](https://github.com/exelban/stats)、[Maccy](https://github.com/p0deje/Maccy)：分别代表分页设置、模块化设置和轻量单页设置。

## 适用边界

旧 HIG 点数可作为节奏基线，不应伪装成当前 macOS 的强制规范。闭源产品截图只能用于模式参考，不能证明内部实现。所有关键字号仍需在 TripCut 的浅色、深色、90%/100%/115% 缩放以及中文长文案下做真实窗口验收。
