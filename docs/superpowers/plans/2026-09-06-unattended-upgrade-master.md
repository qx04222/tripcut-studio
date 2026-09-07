# 无人值守全面升级 — 总执行计划

> **For agentic workers:** 本文是七轮的路线图与接线规则。每轮开始时接线人按 §3 的条目写该轮的代码级计划 `docs/superpowers/plans/2026-09-06-r<N>-<主题>.md`（R0 已写），再用 superpowers:subagent-driven-development 逐任务执行。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 TripCut Studio 从 v0.1.1 推到五阶段全部有闭环、16 GB Apple Silicon 不进 swap、六个功能包全部落地，全程无人值守，只在证书/公开发布/付费三件事上停下。

**Architecture:** main 永远可打包；每条车道在独立 worktree 上做，共用 cargo target；合并前跑 fast-gates，合并后即推送；每日收尾打 QA DMG 并跑 GUI 冒烟；失败 revert 不 reset。接线人（本会话）持有迁移号、路由与合并权。

**Tech Stack:** Tauri 2 / React 19 / TypeScript / Rust / SQLite / bundled LGPL ffmpeg / libmpv / whisper-cli / Python sidecar（Chinese-CLIP）/ Swift Vision（OCR）/ rustfft / printpdf。

## Global Constraints

- 规格：`docs/superpowers/specs/2026-09-06-unattended-upgrade-design.md`，所有取舍以它为准。
- cargo 位于 `/opt/homebrew/opt/rustup/bin`（fast-gates 已引导）；直接在 shell 用时 `export PATH=/opt/homebrew/opt/rustup/bin:$PATH`。
- 入出点与一切时间用整数 tick + `tb_num/tb_den`，禁浮点秒。
- 原片只读；任何路径不得对 `clips` 引用的原片 `remove_file`（`asset_safety.rs` 有源码断言）。
- 分发许可证：LGPL/MIT/Apache/OFL 可打包；GPL 一律不进包（aubio、exiftool 排除）。
- 迁移号（2026-09-06 调整：迁移是连续数组不能跳号，R2 的精选段软删除已占 0030）：0030 精选段 deleted_at、0031 平台预设、0032 音轨/LUT/元数据、0033 故事模板、0034 音乐、0035 OCR、0036 起按需申领；只有接线人分配。
- `App.tsx` 路由与侧栏入口只由接线人改；车道交付页面组件不接路由。
- 绝不碰：`~/Library/Application Support/TripCutStudio/`、`~/Movies/JianyingPro/`、`/Applications/旅剪工作台.app`、`/Applications/VideoFusion-macOS.app`、公开仓库、`src-tauri/target/public-v0.1.1/`、`.gitleaks.toml`、`.github/`。
- 停下等业主：Developer ID 证书与公证、公开仓库任何写操作、付费。其它不问。
- 提交信息末尾带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

---

## 1. 每轮循环清单（每一轮照做）

- [ ] `git status` 干净；`git rev-list --left-right --count main...origin/main` 为 `0 0`；记录 `df -h /` 与 `du -sh src-tauri/target`。
- [ ] 写 `docs/qa/<日期>-unattended-r<N>.md` 第 1 节（目标、工作项、每项验证方式、迁移号分配）。
- [ ] 为本轮每个工作项建 worktree：`git worktree add ../tripcut-wt-<项> -b feat/<项>`；在该目录 `export CARGO_TARGET_DIR=$HOME/Projects/tripcut-studio/src-tauri/target`。
- [ ] 各任务按该轮代码级计划执行（TDD：先红后绿再提交）。
- [ ] 合并窗口（每日两次）：逐个 `git merge --no-ff feat/<项>` → `node scripts/qa/fast-gates.mjs` → PASS 则 `git push origin main`，FAIL 则 `git revert -m 1 <merge>` 并记 F 条。
- [ ] 收尾：`TRIPCUT_PACKAGE_MODE=qa TRIPCUT_ALLOW_ADHOC=1 TRIPCUT_BUILD_STAMP=$(date -u +%Y%m%dT%H%M%SZ)-r<N> ./scripts/package-dmg.sh` → `audit-dmg.mjs --dmg … --expect-signature adhoc` → `preflight.mjs --app … --dmg …` → `prepare-cua-candidate.mjs --app …` → `smoke-gui.mjs --candidate <cua 输出目录>` → `crash-diff.mjs --baseline <preflight manifest>`。任一红：revert 最近合并，重跑到绿。
- [ ] 报告第 2–6 节写完；磁盘规则（target > 45 GB 或剩余 < 120 GB 时清 `target/debug/incremental` 与 7 天前非最近三个的 DMG）；push；"下一轮入口"抄到下一份报告。
- [ ] 同一工作项被 revert 两次即冻结，写进第 5 节。

## 2. 车道与接线

| 车道 | 内容 | 执行者 | 冲突点 |
|---|---|---|---|
| L0 基建 | 门禁、装置、冒烟、报告模板、目录重编号 | 接线人 | 无 |
| L1 性能 | §3 R1 | 接线人（热文件 `artifacts.rs`/`analysis.rs`/`jobs.rs`） | 与 L3 的重连 UI 共享 `import.rs`，L1 先收口 |
| L2 修补 | 冒烟与报告暴露的小修 | 接线人，直接 main 小提交 | 无 |
| L3 缺口 | §3 R2、R6 | Sonnet worktree；接线类小项派 Codex 只写不跑 | 前端在 `App.tsx` 路由处撞，只由接线人接 |
| L4 功能包 | §3 R3–R5 | Codex/Sonnet worktree，一包一分支一迁移号 | 迁移号预分配 |
| L5 更新与可靠性 | §3 R6 | 接线人 | `tauri.conf.json`、`package-dmg.sh` |

顺序：R0 → R1 单独收口 → R2 ∥ R3 开始并行（R3 只动新模块与迁移）→ R4 → R5 → R6。

## 3. 轮次与任务

### R0 基建（详细计划：`2026-09-06-r0-foundation.md`）
1. fast-gates 加 `vite-build`；2. `cargo audit` 与 `npm audit` 进门禁；3. 性能夹具生成脚本；4. 性能装置（`examples/perf_driver.rs` + `scripts/qa/perf-harness.mjs`）并产出基线；5. `scripts/qa/smoke-gui.mjs`；6. 轮报告模板与 R0 报告；7. 交付包目录改为原稿编号。
出口：装置产出 `benchmark/perf-baseline.json`；冒烟六页绿；DMG 审计 PASS；main 推送。

### R1 性能（规格 §2.2）
| 任务 | 动作 | 验证 | 人日 |
|---|---|---|---|
| P1 | `artifacts.rs:219` cover 滤镜改 `scale=480:-2,thumbnail=90` + hwaccel（复用 `:483` 的硬解开关） | 单测断言 args 顺序与 `-hwaccel`；装置 cover 阶段 peak < 900 MB | 0.3 |
| P2 | `analysis.rs:370` 场景检测移到 `fps=2,scale=640` 之后 + hwaccel，软解回退保留；`ANALYSIS_PIPELINE_VERSION` 升 `analyze_l1/v4` 触发 `enqueue_missing` | s4 标注集判据逐字段对照；CPU < 3 s | 1 |
| P3 | strip（`artifacts.rs`）与运镜（`motion.rs`）加 hwaccel | 运镜五类 fixture 测试相等；strip PSNR > 40 | 0.5 |
| P4 | strip `-skip_frame nokey`，仅时长 > 60 s 或省内存档 | CLIP 嵌入余弦 > 0.95 | 0.3 |
| P5 | `jobs.rs` 分资源许可：`video_decode`/`vt_session`/`heavy_model`/`io`，设置键 `performance.decode_permits` 等；导入页显示"等待解码许可" | 4 并发软解合计 < 1.7 GB；总耗时不高于 +15% | 2 |
| P6 | 省内存档自适应：`hw.memsize`（`TRIPCUT_MEMORY_BUDGET_BYTES` 覆盖）与压力探针（`TRIPCUT_MEMORY_PRESSURE_FILE` 覆盖），< 15% 暂停认领 | 装置预算模式：暂停发生、无失败、恢复后全部完成、swapouts 0 | 1.5 |
| P7 | 同 clip 解码类任务串行认领（`claim_next` 加 `NOT EXISTS`） | 单测：同 clip 两个解码任务不同时 running | 0.5 |
| P8 | CLIP sidecar 60 s 空闲卸载；`EMBEDDING_TIMEOUT` 改共同截止；超时杀并重启（合并 O1） | sidecar RSS 90 s 后 < 300 MB；卡死模拟在截止内返回错误 | 1 |
| P9 | mpv `demuxer-max-bytes=150MiB`/`demuxer-max-back-bytes=50MiB`/`cache-secs=10`（本地卷） | 播放 4K 60 s mpv RSS < 600 MB；seek p95 不劣化 | 0.3 |
| P10 | 缓存根水位：< 2 GB 或 < 预估产物时暂停 proxy | hdiutil 3 GB 小卷：proxy 暂停、thumbnail 完成 | 0.5 |
| P11 | 省内存档代理 2.5 Mbps + `-realtime 1` | SSIM > 0.95 | 0.3 |
出口：装置前后两列写进报告；预算模式 swapouts 0；整机峰值 < 4 GB。

### R2 缺口前 15（规格 §3 编号）
G1 重连 UI（3）、G13 相似镜头前端（3，Codex）、G10 旁白稿（1，Codex）、O6+G6 隐私诊断分区与帮助（3）、O12（1，Codex）、O14（1，Codex）、O2 `list_clips` 增量（5）、G2 拖放（2，Codex）、O11 焦点与 slider（2）、O19 已在 R0、G18 崩溃恢复脚本（2）、O9 删除撤销（2）、O17 只读探测不迁移（2）、O4 分包（1，Codex）后把大 chunk 警告加入 strict。
出口：每项自动验证绿；冒烟绿；`docs/USER_GUIDE.md` 与 `docs/用户手册.md` 同步。

### R3 平台预设 + Pocket 4（规格 §4）
- 0031 `episodes.target_platform`/`canvas_orientation` + `platform_presets` 种子 6 条；命令 `list_platform_presets`/`set_episode_platform`；`deliver.rs` `override_platform`；新建集向导与交付对话框。
- 0032 `clip_audio_tracks` + `clips.selected_transcribe_track/selected_monitor_track/display_lut_path/iso_value/shutter_speed/aperture`；`import.rs` 解析 `-show_streams` 全部音频流与 `format_tags:stream_tags`；`player/mod.rs` `apply_display_lut`（`vf-add lut3d`）/`switch_audio_track`/`set_track_mute`；`transcribe.rs` `-map 0:a:N`；交付说明与剪映草稿写映射；技术检查面板。
出口：合成两路静音+一路 tone 的 mp4 导入得 2 行音轨；LUT 开启后导出像素与未开启相同（断言）；`交付说明.txt` 含"抖音"与音轨映射。

### R4 联系表 PDF + 故事模板
- printpdf 锁版本；`assets/fonts/SourceHanSansSC-Regular.otf` 子集随包并登记 `docs/THIRD_PARTY_NOTICES.txt`；`core/contact_sheet.rs::render_contact_sheet`；接入 `deliver.rs` 写 `05_镜头表/联系表.pdf`；字体覆盖检查。
- 0033 `narrative_revisions.template`；`narrative.rs::STORY_TEMPLATES` 四种 prompt 前缀 + 参数 + `build_fallback_draft`；命令 `list_story_templates`、`enqueue_narrative(episode_id, template)`；故事板模板卡片。
出口：PDF 文本流含中文文件名子串；`LLM_ENABLED=false` 下四模板 `story_slots` 顺序两两不同。

### R5 音乐 + OCR
- 0034 `music_tracks`/`music_beats`/`music_sections`；`core/music.rs`（rustfft 短时 FFT → 频谱通量 → 自相关 BPM → 分段 → 高潮）；job kind `music_analyze`；命令 `import_music_track`/`get_music_analysis`/`list_music_tracks`/`delete_music_track`；音乐与节奏面板，切点只建议。
- 0035 `clip_ocr_texts`；`sidecar-ocr/`（Swift，`VNRecognizeTextRequest`，`swiftc -O -framework Vision`）随包并进 `package-dmg.sh` 签名与 SBOM；job kind `ocr_scan`；`search_everything` 第五路 `kind="ocr"`；筛片角标与搜索来源。
出口：合成 120 BPM 点击音轨检出 ±2；纯静音无 onset；OCR 对内置测试图识别出中英文并可搜索命中。

### R6 自动更新、剩余缺口、可靠性、a11y
- `tauri-plugin-updater` + `bundle.createUpdaterArtifacts`；`tauri signer generate -w ~/.tauri/tripcut-updater.key`，口令进钥匙串，`.gitignore` 加 `*.key`；端点 `TRIPCUT_UPDATER_ENDPOINT` 可覆盖；本地 http 验证 0.1.1 → 0.1.2 与篡改 `.sig` 负例。
- G4 rotation 落地、G5 剪映真金丝雀（对 `/Applications/VideoFusion-macOS.app` 的 `template.tmp` 键集比对，缺剪映报"跳过"）、G3、G7 拼音、G8 旅程时间线、G9 多时长粗剪、G11 模型回滚、G12、G14 通知、G15 睡眠唤醒、G16 文件关联、G17 a11y 扫描进门禁、O3/O5/O7/O8/O10/O13/O15/O16/O18。
出口：更新链路正负例；audit 与 a11y 在门禁；全部报告齐。

## 4. 待业主（只登记不做）
- Developer ID 证书、`notarytool` keychain profile、`TRIPCUT_PACKAGE_MODE=release`。
- 公开仓库 release、可见性、任何 push。
- 16 GB 真机验收（M2/16 GB）。
- 剪映内人眼核对草稿时间线。
