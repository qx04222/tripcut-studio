# 旅剪工作台 TripCut Studio

面向旅居、房车生活与旅行 Vlog 的 macOS 本地素材工作台：导入素材、建立只读索引、筛片评级、组织故事，并生成可带入剪映专业版的稳定交付包。

TripCut 不是完整剪辑器。它负责把拍摄后的大量素材收束成可审阅、可恢复、可交付的工作集，让创作者把时间留给叙事和最终剪辑。

## 当前状态

项目处于首个公开预览版本 `v0.1`（应用版本 `0.1.0`）：

- Apple Silicon / arm64；
- 中文优先、Local-first；
- FFmpeg、FFprobe、libmpv 与 whisper-cli 随应用打包；
- Whisper 模型由用户自行选择，不随安装包分发；
- L3 大模型增强默认关闭；
- 剪映原生草稿属于实验功能，稳定交付包是默认出口。

预览版不构成剪映官方产品或兼容认证。剪映及相关商标归其权利人所有。

## 功能

- 引用式导入：不复制、不修改相机原片；
- watched folder：适合移动硬盘、NAS 与云盘同步目录；
- 4K HEVC/10-bit 原片筛片和沉浸播放；
- 收藏、拒绝、五星评级、精选段、Shot Stack；
- Episode 封存与跨集素材记忆；
- 故事板、章节、Beat 与可选 AI 描述；
- 稳定交付：精选片段、1080p 参考粗剪、CSV 镜头表与中文说明。

## 安装未签名预览版

GitHub Preview DMG 使用 ad-hoc 签名，没有 Apple Developer ID 或公证票据。请先核对 Release 页面公布的 SHA-256。

1. 下载与 Mac 架构匹配的 DMG；
2. 打开 DMG，把“旅剪工作台”拖入 Applications；
3. 首次启动如果被 Gatekeeper 阻止，在“系统设置 → 隐私与安全性”中确认“仍要打开”；
4. 不要从非本仓库 Release 页面取得安装包。

完整风险说明见 [`docs/UNSIGNED_PREVIEW.md`](docs/UNSIGNED_PREVIEW.md)。普通用户正式发行仍应使用 Developer ID 签名与 Apple 公证版本。

第一次使用可阅读 [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md)，从导入素材到生成剪映稳定交付包按一条路径完成。

## 从源码开发

开发环境需要 macOS Apple Silicon、Node.js 22+、Rust stable 与 Tauri 2 所需系统工具。开发时可通过 Homebrew 安装构建依赖；打包后的应用不依赖用户安装 Homebrew。

```sh
npm ci
npm run typecheck
npm run lint
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

原生媒体组件和 DMG 构建顺序：

```sh
./scripts/build-lgpl-ffmpeg.sh
./scripts/build-libplacebo.sh
./scripts/build-lgpl-mpv.sh
./scripts/build-whisper.sh

TRIPCUT_PACKAGE_MODE=preview \
TRIPCUT_ALLOW_ADHOC=1 \
TRIPCUT_BUILD_STAMP=local-preview \
./scripts/package-dmg.sh
```

构建和发布要求见 [`docs/RELEASE.md`](docs/RELEASE.md)。

## 隐私与安全

- 素材索引和项目数据默认保存在本机；
- 应用不会静默上传视频；
- L3 provider 通过标准输入接收请求，避免把内容写入命令行参数；
- 预览版请勿处理唯一副本，原片仍应有独立备份。

安全问题请按 [`SECURITY.md`](SECURITY.md) 私下报告，不要先开公开 Issue。

## 参与贡献

贡献方式、测试门禁与素材要求见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。用户指南、发行边界和第三方声明位于 `docs/`。

## 许可证

TripCut Studio 源代码采用 [Apache License 2.0](LICENSE)。打包的 FFmpeg、mpv、libplacebo、whisper.cpp 及其他依赖继续适用各自许可证；详情见 [`docs/THIRD_PARTY_NOTICES.txt`](docs/THIRD_PARTY_NOTICES.txt)。
