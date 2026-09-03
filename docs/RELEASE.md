# 旅剪工作台发布说明

本文描述 macOS 发行流程及其验证边界。当前可生成 **Apple Silicon、macOS 14+、ad-hoc 签名的内部 QA DMG 或公开测试用 Preview DMG**；只有 `release` 模式完成 Developer ID、公证与 stapling 后，才是普通用户使用的正式版本。

## 当前发行边界

- 应用标识：`com.tripcut.studio`
- 产品名：`旅剪工作台`
- 支持范围：Apple Silicon（arm64），最低 macOS 14 Sonoma；Intel 与 Universal Binary 尚未支持。
- 签名：`-` ad-hoc identity。它只满足本机代码签名完整性，不代表开发者身份。
- 公证：未配置、未完成。下载或转发到另一台 Mac 后，Gatekeeper 仍可能拦截。
- 自动更新：未接入、未生成更新清单、未创建更新签名密钥。
- 包内工具：LGPL 配置的 FFmpeg/FFprobe、固定来源构建的 `whisper-cli` 和 LGPL `libmpv` 随 App 捆绑；打包门禁会拒绝构建机绝对依赖和 GPL/nonfree 编码库。
- 可选资源：Whisper 模型不随包分发，必须由用户手动选择经核验的本地模型；Chinese-CLIP Python 运行时尚无签名组件包，因此正式版不在线安装，该能力保持关闭，核心导入、筛片、故事板与交付不受影响。
- 编码契约：交付与代理文件使用 macOS VideoToolbox H.264，并允许系统提供的软件编码路径；包内不含 `libx264`，失败时必须明确报错，不能声称存在未打包的回退。

## 本机构建 DMG

前置条件：

1. Apple Silicon Mac，macOS 14 或更高版本。
2. Node.js 满足 `package.json` 的 engines 约束，且已执行 `npm ci`。
3. Rust/Cargo 与完整 Xcode 工具链可用，`xcode-select -p` 必须指向完整 Xcode；仅 Command Line Tools 不满足正式发行门禁。
4. `src-tauri/icons/icon.png` 是 1024x1024 PNG。
5. 已依次运行 `scripts/build-lgpl-ffmpeg.sh`、`scripts/build-libplacebo.sh`、`scripts/build-lgpl-mpv.sh` 与 `scripts/build-whisper.sh` 生成固定发行输入，并保留对应源码、补丁、构建日志与哈希。FFmpeg 基线不得低于 7.1.5；旧的 7.1.0 缺少 7.1 分支后续安全修复，不得进入候选包。libplacebo 必须使用 OpenGL-only 构建，禁用 Vulkan、shaderc、glslang；mpv 同时禁用 Vulkan、shaderc、zimg。

执行：

```sh
TRIPCUT_PACKAGE_MODE=qa TRIPCUT_ALLOW_ADHOC=1 \
TRIPCUT_BUILD_STAMP=20260903T180000Z-r8 \
./scripts/package-dmg.sh
```

未签名 GitHub Preview 必须使用独立模式并生成完整发布附件：

```sh
TRIPCUT_PACKAGE_MODE=preview TRIPCUT_ALLOW_ADHOC=1 \
TRIPCUT_BUILD_STAMP=github-preview-r1 \
./scripts/package-dmg.sh

./scripts/prepare-github-preview.sh \
  /absolute/path/to/旅剪工作台_0.1.0_github-preview-r1_preview_aarch64.dmg
```

`prepare-github-preview.sh` 会执行敏感信息扫描和 ad-hoc 预览审计，并生成 DMG、SHA-256、TripCut 源码归档、第三方对应源码、补丁、构建脚本与 Release notes。它不会 commit、push、修改仓库可见性或创建 GitHub Release。

脚本会依次：

1. 用 `sips` 和 `iconutil` 生成 `src-tauri/icons/icon.icns`。
2. 执行 `npm run build` 和 Tauri release build。
3. 内嵌固定 FFmpeg/FFprobe、`whisper-cli`、`libmpv` 及其本机动态依赖树；只打包 `sidecar/clip_service.py` 与 `self_test.py`，明确排除会联网安装依赖的 `setup.sh`。
4. 生成包内构建溯源清单、逐 Mach-O 原生 SBOM 和许可证材料并执行 1:1 覆盖自检；任何新增或未映射的动态库都会使打包失败。
5. 按模式对嵌套 Mach-O、`.app` 和 DMG 签名；`qa`/`preview` 模式必须显式允许 ad-hoc，`pre-notary` 与 `release` 模式必须提供 Developer ID。
6. 生成并校验 DMG，打印 SHA-256；`release` 模式还会提交公证、staple 并执行 Gatekeeper 评估。

`scripts/build-dmg.sh` 只是兼容入口，直接转发到唯一发行入口 `scripts/package-dmg.sh`。正式签名发布不得使用 `TRIPCUT_ALLOW_ADHOC=1`；公开未签名 Preview 必须带明确风险标签和完整源码附件。

默认产物目录：

```text
src-tauri/target/release/bundle/macos/*.app
src-tauri/target/release/bundle/dmg/*.dmg
```

如设置了 `CARGO_TARGET_DIR`，产物会位于该目录下的 `release/bundle/`。

## 安装与首启验收

1. 打开 DMG，把“旅剪工作台”拖到 `/Applications`。
2. 首次启动若被 macOS 拦截，在“系统设置 → 隐私与安全性”确认打开；ad-hoc 包未公证，这是当前已知限制。
3. 首启页应显示包内 FFmpeg/FFprobe 与 `whisper-cli` 已就绪；Whisper 模型未选择、Chinese-CLIP 签名组件未安装必须显示为可理解的降级状态，不能引导非技术用户运行 Homebrew、curl、pip 或 `setup.sh`。
4. 到“设置 → 工具链”核对包内工具路径；自定义绝对路径只作为开发调试或受管部署选项，不是正常安装步骤。
5. 若需本地转写，由用户在设置页手动选择来源与许可证均已核验的 Whisper 模型；应用不得代替用户下载未知模型。
6. Chinese-CLIP 签名组件包交付前，画面语义搜索保持不可用；不得向已签名 `.app` 内安装 Python 包，也不得在后台联网安装。
7. 由主审在安装版完成导入 → 筛片 → 播放打点 → 故事板 → 稳定交付包 → 剪映草稿 → 归档/恢复/重启闭环，并记录 macOS、芯片、包内工具版本、样片与产物哈希。

可单独检查本地产物：

```sh
codesign --verify --deep --strict --verbose=2 "src-tauri/target/release/bundle/macos/旅剪工作台.app"
hdiutil verify src-tauri/target/release/bundle/dmg/*.dmg
```

`spctl --assess` 对未公证的 ad-hoc 包不应被当作正式发行通过证据。

## 正式签名与公证（后续）

公开分发前必须另开发布任务并完成以下事项：

1. 加入 Apple Developer Program，在 Keychain 中安装 `Developer ID Application` 证书。
2. 为 `com.tripcut.studio` 固化发行身份、团队 ID、版本号与构建号策略。
3. 审核 entitlements 与 Hardened Runtime。播放器、本地服务、文件选择及未来模型能力所需权限必须最小化；不得沿用未经审计的临时 entitlement。
4. 用 `APPLE_SIGNING_IDENTITY` 覆盖当前 ad-hoc identity，并通过 Tauri 构建正式签名包；证书名与凭据只放 CI secrets/Keychain，不写入仓库。
5. 使用 App Store Connect API key 或 Apple ID app-specific password 提交公证，等待成功后 staple ticket。
6. 对最终 DMG（不是仅对中间 `.app`）执行：签名验证、公证状态验证、Gatekeeper 评估、DMG 挂载、全新用户安装与重复启动测试。
7. 在另一台未参与构建的 Apple Silicon Mac 上下载并安装，确认没有“已损坏”提示，再进行核心闭环验收。
8. 保存构建日志、最终 SHA-256、`codesign -dv --verbose=4`、`spctl`、`stapler validate` 与测试矩阵作为发行证据。

正式流程不得把 ad-hoc 验证结果继承为 Developer ID、公证或跨机器安装通过。

## 自动更新（后续）

当前应用没有 updater。接入前需要：

1. 选择可信的 HTTPS 更新端点与发布托管，明确可用性、访问控制、保留期和回滚责任人。
2. 接入 Tauri updater plugin，生成独立更新签名密钥；私钥只进入受控 secrets，应用只内置公钥。
3. 定义稳定版/测试版 channel、强制更新边界、最低可升级版本、失败回滚与离线行为。
4. 让应用展示版本、发布日期、包大小、变更摘要，并要求用户确认重启；不要在素材处理或导出中途强制退出。
5. 验证被篡改清单、错误签名、断网、半包、旧版本回退、密钥轮换与更新后数据库兼容。
6. updater 产物必须与 DMG 使用同一正式版本、同一已公证 `.app`，并分别保存校验和与签名证据。

## 每次发布的主审清单

- [ ] 版本号在 `tauri.conf.json`、Cargo 与 npm 元数据中一致。
- [ ] `make-icns.sh` 从批准的 1024x1024 源图生成 ICNS，Finder/Dock/DMG 显示无裁切与透明边异常。
- [ ] 前端、Cargo、lint、测试与真实 Tauri 构建门禁由主审执行且无回退。
- [ ] App Resources 中 `clip_service.py` 与 `self_test.py` 齐全，`setup.sh` 不在包内；没有在线安装可执行代码的入口。
- [ ] 包内 FFmpeg/FFprobe、`whisper-cli` 与 `libmpv` 可执行，动态依赖无构建机绝对路径，编码器清单与代码契约一致。
- [ ] 首启包内工具、可选模型缺失、可选签名组件缺失与自定义路径状态均在安装版实测。
- [ ] DMG 安装、首次打开、第二次打开、崩溃后重开均有真实证据。
- [ ] 导入 → 筛片 → 导出及剪映稳定包在安装版完成。
- [ ] 原生 Mach-O/dylib 的逐项 SBOM、许可证表达式、项目来源、版权/许可证文本及 LGPL relink/source-offer 证据齐全；不能用“主组件四份文本”代替传递依赖证明。
- [ ] 正式发布时 Developer ID、公证、staple、Gatekeeper 与异机下载验证全部通过。
- [ ] 自动更新未接入前，发布文案不声称支持自动更新。
