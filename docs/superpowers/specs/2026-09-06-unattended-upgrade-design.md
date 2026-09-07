# 无人值守全面升级 — 设计规格（2026-09-06）

业主批准于 2026-09-06。本文是后续所有无人值守轮次的唯一依据；执行计划见 `docs/superpowers/plans/`。

## 0. 起点与目标

- 起点：私有仓库 `main` = `5941d6a`（v0.1.1 源码首次入库），tag `v0.1.1`。六门禁全绿：tsc / eslint / vitest 208 / cargo test 412 / clippy / vite build。
- 独立审计结论（2026-09-06）：五阶段完成度 一 80% / 二 65% / 三 45% / 四 60% / 五 30%。
- 目标：无人值守把五阶段全部推到有闭环；16 GB Apple Silicon 上全流程不进 swap；业主原稿里被判为"待拍板"的六个功能包全部实现。
- 只停下等业主的三件事：Developer ID 证书与公证、公开仓库任何写操作、任何付费或注册。其余不问不停。

## 1. 流水线与纪律

### 1.1 分支与提交
- `main` 永远可打包。每条车道在 `git worktree add ../tripcut-wt-<项> -b feat/<项>` 上工作，所有 worktree 设 `CARGO_TARGET_DIR=$HOME/Projects/tripcut-studio/src-tauri/target`（共用 target，cargo 文件锁天然串行）。
- 一个可验证行为一提交，信息写"改了什么、为什么、怎么验证"。`git add` 只加自己的路径，加之前先 `git status`。
- 合并 `git merge --no-ff`，合并前 `node scripts/qa/fast-gates.mjs` 必须 PASS；合并后立即 `git push origin main`。
- 回滚只用 `git revert -m 1 <merge>`，不 reset，不 force push。同一项被 revert 两次即冻结，写进报告转下一项。
- 迁移号由接线人预分配：0030 平台预设、0031 音轨/LUT/元数据、0032 故事模板、0033 音乐、0034 OCR、0035 起给性能与缺口车道按需申领。车道不得自取。`App.tsx` 路由与侧栏入口只由接线人改。

### 1.2 门禁
- `scripts/qa/fast-gates.mjs` 已含脚本语法检查、typecheck、lint、vitest、cargo test、clippy；本轮补 `vite-build`，并在 O4 分包完成后把大 chunk 警告加入严格失败模式。
- 新增：`cargo audit` + `npm audit --audit-level=high` 进门禁（高危阻断）。
- 新增：`scripts/qa/perf-harness.mjs` 性能装置（见 §2.3），性能车道每个提交必须附前后两列数据。

### 1.3 每日收尾
1. `TRIPCUT_PACKAGE_MODE=qa TRIPCUT_ALLOW_ADHOC=1 TRIPCUT_BUILD_STAMP=<utc>-unattended ./scripts/package-dmg.sh`
2. `audit-dmg.mjs` → `preflight.mjs` → `prepare-cua-candidate.mjs`（改 bundle id、隔离 `TRIPCUT_APP_SUPPORT_DIR` 与 `TRIPCUT_JIANYING_DRAFT_ROOT`、禁 LLM）
3. 新脚本 `scripts/qa/smoke-gui.mjs`：`caffeinate -dims` 下用 osascript + cliclick 走导入（fixtures 目录，等索引 3/3）、筛片（选中、F、I/O 出精选段）、播放器（4K 10-bit 播 ≥5 s、Esc）、故事板（禁 LLM 时显示"未启用"）、交付（稳定包到临时目录）、设置（切主题）。判定用预言机：隔离库里 `ratings`/`segments`/`exports` 行数、交付目录清单、`crash-diff.mjs` 零新增、进程存活。截图只归档。
4. 写 `docs/qa/<日期>-unattended-r<N>.md` 六节：目标与工作项 / 快照（起止 sha、DMG sha256、target 占用、剩余磁盘）/ 门禁记录 / FINDINGS（现象→根因→修复→检测器是否先红过）/ 被 revert 或冻结项 / 下一轮入口。

### 1.4 护栏
- 绝不碰：`~/Library/Application Support/TripCutStudio/`、`~/Movies/JianyingPro/` 真实草稿、`/Applications/旅剪工作台.app`、`/Applications/VideoFusion-macOS.app`、公开仓库与 `src-tauri/target/public-v0.1.1/`、`.gitleaks.toml`、`.github/`。
- 磁盘：每轮收尾 `du -s src-tauri/target`；超 45 GB 或剩余磁盘低于 120 GB 时删 `target/debug/incremental` 与 7 天前且非最近三个的 DMG。`public-v0.1.1`、`library-qa`、`optimization-qa` 与 `docs/qa/*-evidence/` 永不删。
- 并发：同一时刻一个 cargo；打包与冒烟期间不合并；每日两个合并窗口。
- 派工：Codex 只写不跑（任务书写死），走 worktree 目录；Kimi 只做文案与帮助内容；合并、门禁、打包、冒烟由本会话接线。
- cargo 路径：`~/.rustup/toolchains/stable-aarch64-apple-darwin/bin`，不在默认 PATH，所有脚本自带 PATH 引导。

## 2. 小内存性能（16 GB 基线）

### 2.1 实测成本模型（M5/32 GB，bundled ffmpeg，30 s 4K HEVC 10-bit）
每条素材起 5 次全片解码（cover、strip、L1、运镜、代理）。cover 峰值 1.74 GB（thumbnail 滤镜缓存 90 张 4K 帧），L1 4.6 s 墙钟 / 19.6 s CPU，4 worker 软解合计 3.1 GB 且 10 核打满。worker 固定 4，无内存自适应，无内存/磁盘水位守卫，CLIP sidecar 常驻不卸载，mpv 无缓存上限。

### 2.2 改动
第一批（不改数据模型，≈2 人日）：
- P1 cover：`scale=480:-2,thumbnail=90` 顺序对调 + `-hwaccel videotoolbox`。目标峰值 < 900 MB。
- P2 L1：场景检测移到降采样后 + 硬解；软解回退保留。目标 CPU < 3 s，判据输出逐字段对照相等或在容差内。
- P3 strip 与运镜开硬解；运镜五类分类输出对照相等。
- P4 strip `-skip_frame nokey`，仅时长 > 60 s 或省内存档启用。
第二批（结构性，≈6 人日）：
- P5 分资源许可：`video_decode`（16 GB 默认 2，32 GB 4）、`vt_session` ≤ 3、`heavy_model`（CLIP 与 whisper 互斥 1）、IO。worker 数保留为上限。导入页显示"等待解码许可"。
- P6 自适应：启动读 `hw.memsize`（可被 `TRIPCUT_MEMORY_BUDGET_BYTES` 覆盖），< 24 GB 走省内存档（P5 的 2/2/1 + P4 + 软解 `-threads 4`）；运行中每 5 s 读 mach 内存统计（可被 `TRIPCUT_MEMORY_PRESSURE_FILE` 覆盖），低于 15% 暂停认领新任务不杀在跑的。
- P7 同一 clip 的解码类任务串行认领。
- P8 CLIP sidecar 60 s 空闲卸载（队列仍有 clip_embed 时不卸），EMBEDDING_TIMEOUT 改按帧数共同截止，超时杀并重启子进程。
- P9 mpv `demuxer-max-bytes=150MiB`、`demuxer-max-back-bytes=50MiB`、`cache-secs=10`（仅本地卷）。
- P10 缓存根剩余 < 2 GB 或 < 预估产物时暂停 proxy 并提示，不阻塞缩略图。
- P11 省内存档代理 2.5 Mbps + `-realtime 1`。
若 P2/P4 改变采样语义，分析流水线升 v4，用现有 `enqueue_missing` 机制重算，先核 `analysis.rs` 版本常量，尽量不加迁移。

### 2.3 性能验收装置
- `scripts/qa/make-perf-fixtures.sh`：以 `spikes/s2-libmpv/media/test-4k-hevc-10bit.mp4` 与 `test-4k-hevc.mp4` 为母本 `-c copy` 切 10/30/120 s，加 lavfi 合成 1080p H.264，`-metadata title` 区分 quick_hash，扩到 500 条放 `~/Library/Caches/tripcut-perf/`（不入库）。
- `scripts/qa/perf-harness.mjs` + `examples/perf_driver.rs`：无头入库；每 500 ms 聚合应用进程组 RSS（peak/p95）与 `vm_stat` swapouts；从 `jobs` 表按 kind 聚合 p50/p95；记"首屏 24 张 cover 出现时刻"与"500 条全部 cover 完成时刻"。产出 `qa/runs/<ts>-perf/result.json`，基线 `benchmark/perf-baseline.json`。
- 回归阈值：peak RSS +10% 红、总耗时 +15% 红、首屏 > 30 s 红、预算模式下 swapouts > 0 红、任何任务 failed/blocked 红。
- 真机 16 GB 验收单独记为待业主项，不阻塞。

## 3. 已有功能优化与五阶段缺口（无需拍板）

按用户价值÷人日排序，前 15 名进 R2；其余进 R6。编号沿用规划稿（O = 优化，G = 缺口）。
1. G1 外置盘/素材缺失重连 UI（后端 `media_source.rs` 已有 UUID 重绑与 full_hash 校验；同名不同哈希拒绝，缺失素材标红并提供"选择新位置"）。
2. G13 相似镜头对比接前端（`listSimilarGroups` 后端已注册、前端零调用）。
3. G10 旁白稿进交付包。
4. O6+G6 隐私与诊断独立设置分区 + 设置页帮助主题。
5. O12 SidebarSearch listbox 语义。
6. O14 评级计数按当前集。
7. O2 `list_clips` 增量/修订号 + 产物请求合并。
8. G2 导入页拖放（Tauri `onDragDropEvent`）。
9. O11 三模态焦点约束 + 播放器 slider 键盘化。
10. O1 CLIP sidecar 截止时间与取消重启（与 P8 合并实施）。
11. O19 依赖漏洞扫描进门禁。
12. G18 崩溃恢复回归脚本（kill -9 注入导入/评级/交付写路径，重启断言 integrity/foreign_key）。
13. O9 精选段删除确认/撤销。
14. O17 只读探测不得触发主应用自动迁移。
15. O4 Vite manualChunks 分包。
后续：G4 rotation 落地到播放器/缩略图/过滤器、G5 剪映真金丝雀（本机 `/Applications/VideoFusion-macOS.app` 11.3.0 存在，对活 `template.tmp` 键集合比对 + 生成草稿后校验器，缺剪映时报"跳过"不报绿）、G3 搜索结果命中来源与历史集只读跳转、G7 拼音检索、G8 旅程时间线只读视图、G9 参考粗剪多时长（30/60/180 s）、G11 模型包回滚、G12 500 条 fixture 集成测试、G14 任务完成系统通知、G15 睡眠唤醒续跑、G16 文件关联、G17 a11y 扫描进门禁、O3/O5/O7/O8/O10/O13/O15/O16/O18。
应用内自动更新：接 `tauri-plugin-updater`，minisign 密钥生成到 `~/.tauri/`，口令进钥匙串，`.gitignore` 加 `*.key`；端点可由 `TRIPCUT_UPDATER_ENDPOINT` 覆盖，无人值守用 127.0.0.1 http 服务 `latest.json` 验证"0.1.1 → 0.1.2 下载、验签、重启、库不变、crash-diff 零新增"，并做篡改 `.sig` 的负例（先红后绿）。Gatekeeper 放行留待证书。

## 4. 六个新功能包

| 包 | 选型 | 迁移 | 人日 |
|---|---|---|---|
| 目标平台预设 | `episodes` 加 `target_platform`/`canvas_orientation`；只读 `platform_presets` 种子表 6 条；交付时可临时覆盖不落库 | 0030 | 5 |
| Pocket 4 专项 | D-Log/HDR 已入库只补技术检查面板；显示 LUT 走 mpv `lut3d`，常驻"仅用于预览"提示，导出与代理路径断言不继承；`clip_audio_tracks` 分轨入库、mpv `aid` 选轨与静音、转录 `-map 0:a:N`、交付说明与剪映草稿保留映射；ISO/快门/光圈从 ffprobe `format_tags:stream_tags` 尽力抓取，缺失显示"设备未提供"，不引入 exiftool | 0031 | 11 |
| 故事模板 | 电影感/快节奏/安静氛围/旅行日记四种，作 prompt 前缀 + 数值参数，契约不变；`LLM_ENABLED=false` 时确定性兜底排序，四模板产出必须不同 | 0032 | 7.5 |
| 音乐节奏 | 纯 Rust：rustfft（MIT）短时 FFT → 频谱通量 onset → 自相关/梳状滤波 BPM → 能量+质心分段 → 高潮启发式；ffmpeg `silencedetect` 辅助；`music_tracks`/`music_beats`/`music_sections` 全部 tick 时基；只建议不改写。aubio 是 GPL 排除，librosa 排除 | 0033 | 8 |
| OCR | 独立 Swift 工具 `sidecar-ocr`（Vision `VNRecognizeTextRequest`，简体中文，零模型分发；CLT 的 swiftc 可编译），随包走 whisper-cli 同一套签名/SBOM 路径；抽帧复用缩略图管线；`clip_ocr_texts` 进 `search_everything` 第五路（LIKE，与现有四路一致） | 0034 | 8.5 |
| 联系表 PDF | printpdf（MIT）+ 思源黑体 OFL 子集随包（包内现无 CJK 字体，字体登记进许可证材料）；网格卡片：缩略图、文件名、入出点时码、章节；字体覆盖检查，缺字降级不静默 | 无 | 6 |

交付包目录改为业主原稿编号（已批准，预览版无存量用户）：
```
01_精选原片/  02_环境声与旁白/(旁白稿.txt)  03_字幕/(完整字幕.srt)
04_参考粗剪/  05_镜头表/(剪辑清单.csv, 联系表.pdf)  06_LUT与色彩说明/  07_地点卡/  项目清单.json  交付说明.txt
```
实施顺序：平台预设 → Pocket 4 → 联系表 → 故事模板 → 音乐 → OCR。

## 5. 轮次

| 轮 | 内容 | 出口判据 |
|---|---|---|
| R0 | 门禁补 build 与 audit；perf 夹具与装置；smoke-gui；每轮报告模板；交付目录重编号 | 装置产出基线 JSON；冒烟六页绿；main 推送 |
| R1 | 性能第一批 + 第二批 | 装置前后两列；预算模式 swapouts 0；峰值 < 4 GB |
| R2 | 缺口前 15 项 | 每项自动验证绿；DMG 冒烟绿 |
| R3 | 平台预设 + Pocket 4 | 0030/0031 落地；多音轨合成夹具导入 2 行；LUT 不进导出的像素断言 |
| R4 | 联系表 PDF + 故事模板 | PDF 含中文子串断言；四模板兜底产出不同 |
| R5 | 音乐 + OCR | 120 BPM 合成音轨 ±2；OCR 命中可搜索 |
| R6 | 自动更新、剩余缺口、可靠性与 a11y | 更新链路正负例；audit/a11y 进门禁 |

每轮结束：DMG + 冒烟 + 报告 + push。总量约 110 agent 人日。

## 6. 局限
- 所有性能数字来自 M5/32 GB，16 GB 真机验收待业主。
- VideoToolbox 多路并发上限按经验 3–4 路，未实测失败模式。
- 剪映金丝雀能对活模板比对，但"剪映打开草稿时间线完整"仍需人眼。
- 签名、公证、Gatekeeper 放行全部等证书。
