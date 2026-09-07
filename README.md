<p align="center">
  <img src="https://github.com/qx04222/tripcut-studio/releases/download/v0.1/tripcut-v0.1-release-hero.png" alt="旅剪工作台：房车营地里的本地素材工作台" width="100%">
</p>

<h1 align="center">旅剪工作台 · TripCut Studio</h1>

<p align="center"><strong>把一整天的旅途素材，收束成一条可以开始剪的故事。</strong></p>

<p align="center">
  <a href="https://github.com/qx04222/tripcut-studio/releases/tag/v0.2.0">下载 v0.2.0</a>
  · <a href="docs/USER_GUIDE.md">用户指南</a>
  · <a href="docs/releases/v0.2.0.md">版本说明</a>
  · <a href="CONTRIBUTING.md">参与贡献</a>
</p>

<p align="center">
  <img alt="Release v0.2.0" src="https://img.shields.io/badge/preview-v0.2.0-f4a261?style=flat-square">
  <img alt="macOS Apple Silicon" src="https://img.shields.io/badge/macOS-Apple%20Silicon-111827?style=flat-square&amp;logo=apple">
  <img alt="Local first" src="https://img.shields.io/badge/local--first-offline-2a9d8f?style=flat-square">
  <img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-3b82f6?style=flat-square">
</p>

> [!IMPORTANT]
> v0.2.0 是面向测试者的 Apple Silicon 未签名预览版，使用 ad-hoc 签名，尚未经过 Apple Developer ID 签名与公证。请从本仓库 Release 下载、核对 SHA-256，并使用有独立备份的素材测试；首次启动如遇 Gatekeeper 拦截，右键点击应用图标选择「打开」即可。
>
> 本版 DMG：`TripCut-Studio_0.2.0_github-preview-v0.2.0-20260907T0029Z_preview_aarch64.dmg`，SHA-256 `8c634e3ce032f76bd03a4d640cf5db818e04f8421c605466c5a1202d9dae527f`。

## 它解决的不是剪辑，而是剪辑前的混乱

一次旅居或房车旅行，往往会留下相机卡、移动硬盘、手机和 NAS 中的大量零散片段。真正耗时间的，是重新看完素材、判断哪些镜头值得保留、找到故事主线，再把结果可靠地交给剪映。

TripCut Studio 是一个中文优先、Local-first 的 macOS 素材工作台。它不取代剪映，而是在剪映之前完成最费时间的整理工作：

- 引用式导入素材，原片保持只读；
- 播放、评级、收藏、拒绝和标记精选段；
- 用 Episode、Chapter、Beat 与 Storyboard 组织故事；
- 生成可核对、可恢复、可继续剪辑的稳定交付包。

## 一条从原片到剪映的工作流

<p align="center">
  <img src="https://github.com/qx04222/tripcut-studio/releases/download/v0.1/tripcut-v0.1-workflow.png" alt="TripCut 五步工作流：只读导入、播放筛选、故事结构、稳定交付、继续剪辑" width="100%">
</p>

| 阶段 | 工作台帮你完成 | 创作者保留的决定权 |
| --- | --- | --- |
| 导入 | 索引相机卡、移动硬盘、本地目录与 watched folder | 原片位置与备份策略 |
| 筛片 | 4K HEVC/10-bit 播放、收藏、拒绝、五星评级、I/O 选段 | 哪些镜头值得进入故事 |
| 叙事 | Episode、章节、Beat、Storyboard 与跨集素材记忆 | 故事主线、事实与最终顺序 |
| 交付 | 精选片段、1080p 参考粗剪、CSV、字幕与中文说明 | 在剪映中完成节奏、声音与成片 |

## 为旅居和房车 Vlog 设计

| 旅途中的真实问题 | TripCut 的处理方式 |
| --- | --- |
| 素材散落在多个盘和目录 | watched folder 与引用式索引，不强迫搬运原片 |
| 驾驶、驻车、做饭、风景混在一起 | 快速筛片、质量角标、精选段与 Shot Stack |
| 每一集都容易重复相似镜头 | Episode 封存与跨集素材记忆 |
| 在路上网络不稳定 | 核心整理、播放与交付均以本地工作流为主 |
| AI 建议可能不可靠 | 建议与人工确认分开保存，创作者拥有最终裁量 |
| 最终仍要在熟悉的软件里精剪 | 默认生成稳定交付包，继续进入剪映专业版 |

## v0.2.0 包含什么

### 性能（小内存设备）

- 缩略图、分析、胶片条、代理生成全面优先走硬件解码，软解只作回退；封面先缩放再选帧，单素材峰值内存显著下降；
- 新增内存档位（自动 / 标准 / 省内存），24 GB 以下内存的机器自动走省内存档；系统可用内存跌到过低时会暂停解码与模型任务并提示，恢复后自动继续。

### 筛片新工具

- 「相似镜头」面板可比对同组素材并设代表镜头；
- 「技术检查」面板一处查看色彩空间、横竖屏、多声道音轨与拍摄参数；显示 LUT 仅影响预览，不改原始文件；
- 素材筛选新增「竖屏」过滤，含物理旋转但文件仍按横向存储的素材；
- 缩略图生成后本机离线跑画面文字识别（中英文都认），结果显示在右栏「画面文字」角标；
- 支持把文件夹或视频直接拖进导入页；
- 保存精选段后按「删除」，10 秒内可「撤销」恢复。

### 故事板

- 「一键 AI 编排」前可选四种故事模板（电影感 / 快节奏 / 安静氛围 / 旅行日记），没有配置大模型时也有确定性兜底；
- 「音乐与节奏」页签可导入参考音乐查看节拍与段落分布，仅供参考、不会替你重排镜头；
- 「旅程时间线」页签按跨设备校正过的拍摄时间把素材重排成只读时间线，按天分组，用于核对故事顺序。

### 搜索

- 支持拼音 / 首字母搜索中文文件名、标签、章节标题；
- 每条结果标来源徽章（文件 / 转写 / AI / 标签 / 画面文字 / 拼音）。

### 交付

- 交付包目录改为编号 01–07，结构更清楚；
- 新增可选的「联系表.pdf」：A4 网格缩略图 + 序号/文件名 + 入出点 + 章节，内嵌中文字体；
- 新建集与交付页可选目标平台预设（抖音 / 小红书 / B站 / 朋友圈 / 家庭纪录 / 通用），交付说明、字幕、剪映草稿画布尺寸都跟着走；
- 「参考粗剪时长」新增 30 秒 / 60 秒 / 3 分钟档位，按 Beat 顺序在预算内截取；
- 旁白稿按叙事分章生成，已确认的修订标注「已确认」，未经确认的会标注「AI 建议稿，未经人工确认」。

### 系统

- 电脑睡眠期间的任务在唤醒后自动接着跑完；
- 交付包生成、批量 AI 分析完成时有 macOS 系统通知；
- 「设置 → 工具链」组件可一键「回滚到上一版」；
- 「设置 → 帮助与关于」新增「检查更新」——首次接入，仅在点击时联网查一次（详见下方「自动更新」）。

完整变更详见 [v0.2.0 更新说明](docs/releases/v0.2.0.md)。

## 自动更新

设置页「帮助与关于 → 检查更新」可发现新版本并下载安装，安装包会做 minisign 签名校验；未签名的预览版仍可能被 Gatekeeper 拦截，请按提示核对来源后放行。

## 下载与第一次使用

1. 前往 [v0.2.0 Release](https://github.com/qx04222/tripcut-studio/releases/tag/v0.2.0)，下载对应的 DMG 安装包；
2. 同时下载 `SHA256SUMS.txt`，核对 DMG 的 SHA-256；
3. 打开 DMG，把“旅剪工作台”拖入 Applications；
4. 如果 Gatekeeper 阻止首次启动，右键点击应用图标选择「打开」（或在“系统设置 → 隐私与安全性”中确认“仍要打开”）；
5. 按[用户指南](docs/USER_GUIDE.md)用一份有备份的短素材完成第一次“导入 → 筛片 → 选段 → 交付”。

完整安全边界见[未签名预览版说明](docs/UNSIGNED_PREVIEW.md)。不要关闭 Gatekeeper，也不要运行来源不明的解除隔离命令。

## 产品边界

| TripCut 会做 | TripCut 不会做 |
| --- | --- |
| 整理、筛选、组织和交付拍摄素材 | 取代完整非线性剪辑器 |
| 在本机保存索引、项目与确认结果 | 静默上传用户视频 |
| 为重复镜头、故事结构和交付提供辅助 | 替创作者决定事实与最终叙事 |
| 把稳定文件带入剪映继续工作 | 声称获得剪映官方兼容认证 |

剪映及相关商标归其权利人所有。本项目与剪映不存在官方隶属或认证关系。

## 从源码开发

开发环境需要 macOS Apple Silicon、Node.js 22+、Rust stable 与 Tauri 2 所需系统工具。

```sh
npm ci
npm run typecheck
npm run lint
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

原生媒体组件与 DMG 构建顺序：

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

完整构建、签名、许可证与发布门禁见[发布说明](docs/RELEASE.md)。打包后的应用不依赖用户安装 Homebrew。

## 隐私、安全与贡献

- 素材索引和项目数据默认保存在本机；
- 应用不会静默上传视频；
- L3 provider 通过标准输入接收请求，避免把内容写入命令行参数；
- 安全问题请按 [SECURITY.md](SECURITY.md) 使用 GitHub Private Vulnerability Reporting 私下提交；
- 功能反馈和可复现问题欢迎提交到 [Issues](https://github.com/qx04222/tripcut-studio/issues)；
- 代码、文档与测试贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

TripCut Studio 源代码采用 [Apache License 2.0](LICENSE)。打包的 FFmpeg、mpv、libplacebo、whisper.cpp 及其他依赖继续适用各自许可证；详情见[第三方声明](docs/THIRD_PARTY_NOTICES.txt)。

---

<p align="center"><strong>旅途负责发生，TripCut 负责把它整理成故事。</strong></p>
