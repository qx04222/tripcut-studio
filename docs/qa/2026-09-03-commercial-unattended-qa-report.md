# TripCut Studio 商用级无人值守 QA 与优化报告

日期：2026-09-03

候选版本：`0.3.0-alpha.9` / r9

目标：面向旅居房车生活 Vlog 的本地素材工作台，缩短“素材导入 → 筛片 → 故事组织 → 稳定交付剪映”的人工路径，并为后续数字人 + 实景拍摄工作流保留可审计的数据基础。

## 1. 发布结论

- **内部试用：GO。** r9 已完成固定素材、隔离项目、Computer Use 真实界面、重启恢复、原生崩溃差分、稳定交付及 DMG 内容审计。
- **公开商用发布：NO-GO。** 当前 DMG 是 ad-hoc 签名的 arm64 QA 包，缺少 Developer ID、Apple 公证与装订、Gatekeeper/第二台干净 Mac 验收；许可证/源码提供与最终 EULA 还需要人工法务确认。
- **不得把当前文件直接公开分发。** 它是可安装的内部 QA 候选，不是已公证的正式发行包。

## 2. 当前候选物

- DMG：`src-tauri/target/release/bundle/dmg/旅剪工作台_0.3.0-alpha.9_20260903T182500Z-r9_qa_aarch64.dmg`
- SHA-256：`d0926228b6cc40d5a487cbe6cdaf29d420f84bdc1030fdf926fd753557226aef`
- 架构：Apple Silicon / arm64
- 签名：ad-hoc，仅用于隔离 QA
- DMG 审计：`qa/runs/2026-09-03T18-30-00Z-dmg-r9-audit/`
- 最终快速门禁：`qa/runs/2026-09-03T19-05-00Z-fast-gates-r9-final/`
- 最终崩溃差分：`qa/runs/2026-09-03T19-03-00Z-cua-r9-final-crash-diff/`

## 3. 无人值守执行方法

本轮采用“静态门禁 → DMG 审计 → 隔离候选启动 → Computer Use 全链路 → 修复 → 重建 → 回归”的循环。r4 至 r9 每轮都保留独立证据目录，避免用源码推断替代运行态结论。

测试使用独立 bundle id、独立 App Support、禁用真实 LLM provider，并以固定视频夹具验证：

- 4K HEVC 8-bit，30 秒；
- 4K HEVC 10-bit，30 秒；
- EP01 封存后才生成的 720p H.264/AAC 新素材，用于证明 EP02 增量导入。

## 4. Computer Use 覆盖结果

| 区域 / 控件族 | 主要状态与操作 | 结果 |
| --- | --- | --- |
| 首次运行 | 组件路径、核心组件就绪、可选模型未静默下载 | PASS |
| 全局侧栏 | 收起/展开、四段导航、当前集面板、历史集列表 | PASS |
| Episode | 重命名、两步封存确认、空集禁用、EP01 只读、自动进入 EP02 | PASS |
| 导入 | 选择/更换目录、监看目录、立即扫描、自动同步、进度、成功/失败状态 | PASS |
| 增量导入 | EP01 已有 2 条；封存后 EP02 只发现并导入新文件 1 条 | PASS |
| 筛片 | 胶片墙、选中态、收藏、拒绝、0/1–5 星、过滤、Stack 操作 | PASS |
| 播放器 | 4K 10-bit HEVC 可见画面、播放/暂停、时间推进、I/O、保存精选段、返回 | PASS |
| 故事板 | 视图切换、章节/Beat、拖排、标题与 Routine 操作、只读边界 | PASS（前轮全量） |
| 交付 | 无选中项禁用、稳定包、进度、逐条状态、Finder 入口 | PASS |
| 设置/帮助 | 工具链状态、L3 默认关闭、预算/隐私说明、帮助与首跑引导 | PASS（前轮全量） |
| 命令面板/搜索 | 打开/关闭、导航、结果状态、历史集上下文 | PASS（自动化 + 前轮界面） |
| 重启恢复 | EP02、1 条素材、监看目录、扫描时间和进度在同一候选重启后恢复 | PASS |
| 崩溃差分 | 从候选启动基线到两次干净关闭，无新增 `.ips` | PASS，`added=0` |

说明：r5/r6 承担全按钮与多状态遍历；r9 针对最终二进制重点回归导入、4K/10-bit 播放、精选段、稳定交付、跨 Episode 去重和重启恢复。

## 5. 最终业务链路证据

1. 固定目录导入两条 4K HEVC：`2 / 2`、`2 完成 · 0 失败`。
2. 在筛片页选中 10-bit 素材，执行 `F` 与 `5` 后显示 `1 收藏`、`5 星`。
3. 沉浸播放器显示真实测试画面，播放时间从 1.733 秒继续推进；I/O 保存得到 1.200 秒精选段。
4. 稳定交付显示 `1 完成 · 0 失败`，生成：
   - `01_精选片段/001_test-4k-hevc-10bit.mp4`：H.264、3840×2160、yuv420p、1.200 秒；
   - `02_参考粗剪.mp4`：H.264/AAC、1920×1080、yuv420p、1.200 秒；
   - `03_镜头表.csv`：包内路径为 `01_精选片段/001_test-4k-hevc-10bit.mp4`，没有用户绝对路径；
   - `交付说明.txt` 与 `.tripcut-complete.json`。
5. 封存 EP01 后创建 EP02；再向监看目录加入全新内容并点击“立即扫描”，结果为 `1 / 1`、`1 完成 · 0 失败`，旧两条素材未重新排队。
6. 干净关闭、按相同隔离目录重启后，EP02 与 1 条新增素材完整恢复。

## 6. 本轮已完成的关键优化

### 数据与项目边界

- Episode 生命周期、归档只读、跨集查询与交付作用域收紧。
- watched folder 采用跨 Episode 内容去重，同时允许真正的新素材进入下一集。
- 数据库关键写入、快照与交付状态改为事务化/可恢复路径。
- Narrative、Routine、评级、Story/Stack 的持久化边界和回滚行为补齐。

### 播放与媒体处理

- 修复播放器事件漏读与原生退出生命周期问题。
- 代理、精选段、VFR 整条和粗剪统一使用 VideoToolbox H.264；删除不可兑现的 `libx264` 运行时回退。
- 4K/VFR 输出质量参数上调并通过回读验证；失败文案与实际编码策略一致。
- 打包 FFmpeg 升级到 7.1.5；libmpv 使用定制 OpenGL-only libplacebo，移除 Vulkan、shaderc、glslang 与 zimg 依赖面。

### 隐私、可用性与交付

- L3 默认关闭，provider 通过 stdin 交互；不在命令行泄露素材、GPS 或密钥。
- 应用不再提示普通用户运行 Homebrew/`setup.sh`，关键工具随 App 提供。
- 稳定包采用临时目录、完成标记与唯一命名，失败/取消不伪装成功。
- CSV 防公式注入，且“包内路径”现在与真实输出文件一一对应。
- 首次运行、设置、错误状态、空状态和禁用态文案针对非技术视频工作者重写。

### 供应链与可追溯性

- FFmpeg、libplacebo、whisper 构建版本和来源哈希固定。
- DMG 内附第三方声明、动态库许可证证据、构建 provenance 和精确 native SBOM。
- 审计要求 25 个打包 Mach-O 与许可证证据一一映射，并验证最终 payload 哈希。

## 7. 自动化门禁

最终 `fast-gates` 全绿：

- TypeScript：PASS
- ESLint：PASS
- Vitest：14 个文件、90 项测试，全部 PASS
- Rust library：383 项 PASS
- Rust artifacts：7 项 PASS，1 项 M5 性能基准按设计忽略
- Rust fixtures：5 项 PASS
- Clippy `-D warnings`：PASS
- 打包、预检、CUA 启动、崩溃差分、DMG 审计脚本语法：全部 PASS

DMG 审计共 9 个核心检查，8 个 PASS；唯一失败项是：

- `app.developer-id`：`Signature=adhoc; TeamIdentifier=not set`

已通过的 DMG 检查包括镜像校验、挂载、App 存在、深度签名完整性、无外部运行库、无外部后端发现、打包 FFmpeg 的真实 VideoToolbox H.264 编码、provenance 哈希与许可证覆盖。

## 8. 公开商用发布阻塞项

### 必须完成

1. 提供有效 Apple Developer ID Application/Installer 身份。
2. 在完整 Xcode 工具链上生成 release 模式 DMG，完成 notarization、staple 与 `spctl` Gatekeeper 验证。
3. 在第二台干净 Apple Silicon Mac 上，从 DMG 拖入 Applications 后完成首启、权限、导入、播放、交付和重启验收。
4. 由人工法务确认 LGPL 动态链接、源码提供/书面提供、重新链接说明、第三方 notice 与 EULA 的公开分发文本。
5. 将版本从 `alpha.9` 升为正式候选，并确定升级/回滚策略。

### 建议在首个公开版本前完成

- 补做明确启用的 M5 性能基准并形成机型基线。
- 增加 Intel/universal 构建，或在产品页明确仅支持 Apple Silicon。
- 验证真实剪映安装上的“生成草稿 → 剪映打开 → 时间线/素材完整”闭环；当前只验证了稳定交付包与草稿金丝雀，不等同于正式剪映兼容认证。
- 完成全量 Rust/npm 依赖 SBOM、漏洞扫描和版本升级策略。
- 决定自动更新方案；当前不包含已签名的安全更新通道。
- 处理 Vite 大 chunk 警告，避免功能继续增长后影响首屏与维护成本。

## 9. 下一轮发布门禁

正式发行必须同时满足：

`最终 fast-gates PASS` → `release DMG 审计全 PASS` → `Developer ID + notarization + staple PASS` → `干净 Mac Computer Use 全链路 PASS` → `真实剪映导入 PASS` → `法务清单签字`。

任一环节为 FAIL，都不能把内部 QA 包重命名为正式发行包。

## 10. 变更边界

- 未执行 `git commit`、`git push`、部署、发布或外部上传。
- 当前仓库原有及本轮未提交改动均保留；交付前仍需人工审阅最终 diff。
- 测试夹具与交付输出位于桌面临时目录，未作为产品数据写入仓库。
