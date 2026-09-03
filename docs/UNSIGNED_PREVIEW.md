# 未签名预览版说明

TripCut Studio 的 GitHub Preview DMG 使用 ad-hoc 签名，面向愿意验证校验和并接受 Alpha 风险的测试者。它不是已公证的正式 macOS 发行版。

## 下载前

1. 只使用 `github.com/qx04222/tripcut-studio` 的 Release 页面；
2. 对照 Release 页面和 `SHA256SUMS.txt` 验证 DMG；
3. 确认文件名包含 `preview` 与目标架构 `aarch64`；
4. 原始拍摄素材必须另有备份。

## 安装

打开 DMG，把应用拖入 Applications。首次启动若被 Gatekeeper 阻止：

1. 打开“系统设置”；
2. 进入“隐私与安全性”；
3. 找到刚被阻止的“旅剪工作台”；
4. 核对来源和校验和后选择“仍要打开”。

不要使用关闭 Gatekeeper、修改全局系统安全策略或批量移除隔离属性的命令。

## 已知限制

- 仅支持 Apple Silicon；
- 没有 Developer ID、Apple 公证或自动更新；
- 剪映原生草稿是实验功能；
- Whisper 模型不随包分发；
- Alpha 版本不能承诺未来数据库向后兼容。

## 完整性

Release 必须同时提供：

- DMG；
- `SHA256SUMS.txt`；
- TripCut 对应源码归档；
- FFmpeg、mpv、libplacebo、whisper.cpp 对应源码与构建材料；
- Release notes 与第三方许可证声明。

缺少任一项时，不应把该 Release 视为项目维护者发布的完整预览版本。
