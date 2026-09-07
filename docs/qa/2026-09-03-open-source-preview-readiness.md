# TripCut Studio 开源未签名预览发布就绪报告

日期：2026-09-03

候选版本：`0.3.0-alpha.9` / r10

渠道：GitHub unsigned preview / Apple Silicon (`arm64`)

## 1. 结论

- **本地发布包：GO。** r10 预览 DMG、对应源码、原生依赖源码、补丁、构建脚本、许可证、校验和及 DMG 审计结果可以组成一个公开的未签名 Alpha 预览 Release。
- **签名商用发行：仍为 NO-GO。** 该候选是 ad-hoc 签名，没有 Developer ID、Apple notarization、staple、第二台干净 Mac Gatekeeper 验收或自动更新通道。
- **GitHub 尚未发布。** 本轮未执行 commit、push、修改仓库可见性或创建 GitHub Release；发布动作需要单独的明确授权。
- 项目许可证按 `Apache-2.0` 准备，版权行为 `Copyright 2026 TripCut Studio contributors`。正式公开前应由项目所有者确认这一归属文本。

## 2. 候选物

- DMG：`src-tauri/target/release/bundle/dmg/旅剪工作台_0.3.0-alpha.9_20260903T191500Z-r10_preview_aarch64.dmg`
- SHA-256：`b4ae78769c380d37aa56dec01ba50a5a4ffef91308ca24508020bcc54ebb2e1c`
- 大小：约 25 MiB
- 签名：ad-hoc；`TeamIdentifier=not set`
- DMG 审计：`qa/runs/2026-09-03T20-35-00Z-dmg-r10-preview/`
- Computer Use 启动证据：`qa/runs/2026-09-03T19-25-00Z-cua-r10-preview/`
- 原生崩溃差分：`qa/runs/2026-09-03T19-28-00Z-cua-r10-preview-crash-diff/`
- 最终快速门禁：`qa/runs/2026-09-03T20-38-00Z-fast-gates-r10-release-ready/`

## 3. 产品与运行态验收

r9 已在同一产品代码上完成固定视频夹具的全链路 Computer Use 验收，包括导入、4K HEVC 8/10-bit 播放、筛片、Episode、故事板、精选段、稳定交付、跨 Episode 去重、持久化和重启恢复。r10 只改变公开预览打包、许可证、文档和 QA 工具，因此执行了发布特定回归：

- 从 r10 DMG 创建隔离候选，bundle 文件身份和 ad-hoc 签名校验通过；
- Launch Services 启动成功，3 秒稳定，存在可访问窗口；
- Computer Use 检查设置页，确认打包 FFmpeg 7.1.5、FFprobe 7.1.5、whisper.cpp 1.9.2，L3 默认关闭，版本 `0.3.0-alpha.9`、Schema V28，并可见 34 项直接依赖许可证；
- 干净关闭后没有新增 TripCut `.ips`，`added=0`。

完整业务链路与逐控件证据见 `docs/qa/2026-09-03-commercial-unattended-qa-report.md`。

## 4. 自动化与 DMG 门禁

最终 fast-gates 为 **16 / 16 PASS**：

- 6 个构建/打包 zsh 脚本语法；
- 4 个兼容、预检、CUA 与审计脚本语法；
- TypeScript 与 ESLint；
- Vitest 90 项；
- Rust library、artifacts 与 fixtures 共 395 项执行通过，另有 1 项 M5 性能基准按设计忽略；
- Clippy `-D warnings`。

r10 DMG 审计为 **11 / 11 PASS**：镜像校验、挂载、App 存在、签名完整性、预期 ad-hoc 签名、无禁用/外部运行库、无外部 ggml backend 发现、打包 FFmpeg 的真实 VideoToolbox H.264 编码、最终 payload provenance，以及 25 个 Mach-O 文件的许可证映射。

## 5. 安全审计结果

### Critical / High / Medium

没有发现可报告的 Critical、High 或 Medium 漏洞。

### Low — 已修复：QA 工具包含个人绝对路径

- **Severity：** Low
- **Location：** `scripts/qa/preflight.mjs:48-55`
- **Vulnerability：** 崩溃报告目录原先硬编码构建者用户名；公开源码会泄露本机用户名并导致其他用户的预检失效。
- **Fix：** 改为通过 `node:os` 的 `homedir()` 解析当前用户目录，并对拟公开源码文件集扫描个人绝对路径；结果为 0 命中。

### Informational — Rust 未维护的传递依赖

- **Severity：** Informational
- **Location：** `src-tauri/Cargo.lock`，由 Tauri / `tauri-utils -> urlpattern` 及 Linux 条件依赖引入。
- **Vulnerability：** `cargo-audit 0.22.2` 报告 0 个已知漏洞、16 个 unmaintained 警告和 1 个 unsound 警告。GTK/glib、`proc-macro-error` 和该 unsound glib 包不在 `aarch64-apple-darwin` 依赖树中；5 个 `unic-*` 未维护包存在于 macOS 的 Tauri URL pattern 传递链，但当前没有 RustSec 漏洞公告。
- **Fix：** 首个签名稳定版前跟随 Tauri/urlpattern 上游替换这些传递依赖；已加入 Cargo Dependabot 周检。若后续公告升级为实际漏洞，发布门禁应转为红色。

### Informational — Gitleaks 规则误报已约束

- **Severity：** Informational
- **Location：** `src-tauri/src/core/settings.rs`、`.gitleaks.toml`
- **Vulnerability：** 公共 Whisper 模型名 `large-v3-turbo` 被默认 generic-api-key 规则误识别为凭据。
- **Fix：** 只对该精确文件和精确公开模型常量添加窄 allowlist。使用同一配置扫描 140 个 Git 提交为 0 泄漏；发布脚本还会扫描实际源码归档文件集并在命中时失败。

补充依赖结果：`npm audit --omit=dev` 检查 39 个生产依赖，Critical/High/Moderate/Low 均为 0。

## 6. 开源与原生组件合规材料

发布目录必须同时包含：

- TripCut `Apache-2.0` 许可证、README、贡献与安全政策；
- FFmpeg 7.1.5 LGPL 构建对应源码及构建脚本；
- mpv 0.41.0 固定提交的完整修改后源码、二进制补丁和构建脚本；
- libplacebo 7.360.1、whisper.cpp 1.9.2 对应源码；
- 第三方 notices、DMG 内许可证目录、source manifest 和全文件 SHA-256。

打包门禁拒绝 GPL/version3/nonfree/x264/x265 FFmpeg 配置、Homebrew 绝对链接、外部 ggml backend 发现以及来源哈希不匹配。此清单是工程合规证据，不替代项目所有者的法律审阅。

## 7. 用户必须看到的边界

- 这是实验性 Alpha，仅支持 Apple Silicon；
- macOS 会因为没有 Developer ID 和 Apple 公证而显示安全警告；
- 安装说明只引导用户在系统设置中确认打开，不建议关闭 Gatekeeper 或运行 `xattr -dr`；
- 剪映原生草稿仍为实验功能，TripCut 与剪映没有官方隶属或认证关系；
- 没有自动更新，用户应只从项目的官方 GitHub Release 下载并核对 SHA-256。

## 8. 发布边界

本报告证明的是“本地已形成可审阅、可上传的未签名预览 Release 目录”，不是“GitHub 已公开”。实际发布前只剩两项所有者决策：确认 Apache-2.0 版权归属文本，以及明确授权 commit、push、仓库转 public 与创建 Release。
