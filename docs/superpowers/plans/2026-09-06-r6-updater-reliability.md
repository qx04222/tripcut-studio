# R6 自动更新、剩余缺口、可靠性与可访问性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 应用内自动更新机制建起来并用本地端点正负例验证；剪映真金丝雀；模型包回滚；睡眠唤醒续跑；任务完成通知；拼音检索；旅程时间线；多时长粗剪；a11y 扫描进门禁；把 R2–R5 留下的跟进项收干净。

**Architecture:** 更新走 `tauri-plugin-updater`（minisign 签名，端点可由环境变量覆盖，无人值守用 127.0.0.1 http 服务验证）；其余为独立小模块，各自 worktree；门禁新增 `axe`/`eslint-plugin-jsx-a11y`。

**Tech Stack:** tauri-plugin-updater 2.x（配套 `@tauri-apps/plugin-updater`），minisign，`pinyin-pro`（MIT），libc/objc2 `NSWorkspace` 通知，`tauri-plugin-notification` 2.x。

## Global Constraints

- 规格 §3 末段与 §5 R6；总计划 Global Constraints。迁移号 **0036 起**按需申领（接线人分配）。
- 更新私钥 `~/.tauri/tripcut-updater.key`，口令进钥匙串 `security add-generic-password -s tripcut-updater`；`.gitignore` 加 `*.key`；公钥进 `tauri.conf.json`。**私钥与口令永不入库、永不写进报告。**
- 正式端点写死为公开仓库 `releases/latest/download/latest.json`（只写配置，不做任何公开仓库写操作）；`TRIPCUT_UPDATER_ENDPOINT` 环境变量可覆盖。
- Gatekeeper 放行需要证书：本轮只验证「下载—验签—替换—重启—库不变」。
- 提交带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`；门禁看 `gate.json.status`。

---

### Task 1: 自动更新机制
**Files:** `src-tauri/Cargo.toml`（`tauri-plugin-updater = "=2.x"`，`tauri-plugin-process`）、`package.json`（`@tauri-apps/plugin-updater`, `plugin-process`）、`src-tauri/tauri.conf.json`（`plugins.updater { pubkey, endpoints:[...], windows 无 }`、`bundle.createUpdaterArtifacts: true`）、`src-tauri/capabilities/default.json`（`updater:default`, `process:allow-restart`）、`src-tauri/src/lib.rs`（注册插件；端点覆盖：启动时读 `TRIPCUT_UPDATER_ENDPOINT`，用 `UpdaterBuilder::endpoints`）、`src/SettingsPage.tsx`「帮助与关于」加「检查更新」按钮 + 版本/进度/重启、`scripts/qa/updater-e2e.mjs`
- [x] 密钥：`npm run tauri signer generate -- -w ~/.tauri/tripcut-updater.key`（口令进钥匙串）；`scripts/package-dmg.sh` 在 `TRIPCUT_UPDATER_SIGN=1` 时读钥匙串口令签 `.app.tar.gz` 产 `.sig` 与 `latest.json`。
- [x] e2e：打 0.1.1 候选与只改版本号的 0.1.2；`python3 -m http.server` 服务 `latest.json`；CUA 候选带 `TRIPCUT_UPDATER_ENDPOINT` 启动 → 触发检查更新 → 期望重启后「关于」显示 0.1.2、隔离库未变、crash-diff 零新增；负例：篡改 `.sig` 一字节 → 拒绝且原包仍能启动（先红后绿）。
  > 实际：端点覆盖不是走 `UpdaterBuilder::endpoints`，而是启动时用 `TRIPCUT_UPDATER_ENDPOINT` 直接改写传给插件的 endpoints 配置（`lib.rs` 里有 `updater endpoint overridden by TRIPCUT_UPDATER_ENDPOINT` 的告警日志），效果等价但接线点不同。
- [x] Commit：`feat(updater): 应用内更新机制——minisign 签名、端点可覆盖、本地端点正负例`

### Task 2: G5 剪映真金丝雀
**Files:** `src-tauri/tests/jianying_canary.rs`（读 `/Applications/VideoFusion-macOS.app` 的版本与 `~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/*/template.tmp` 键集，与 `jianying.rs` 金样比对；找不到剪映或草稿 → `println!("skip")` + return，不假绿）、`scripts/qa/fast-gates.mjs`（加 `cargo test --test jianying_canary`）
- [x] 校准：临时把金样删一个键 → 测试红。
- [x] Commit：`test(jianying): 真机金丝雀——对活 template.tmp 键集比对,缺剪映显式跳过`

### Task 3: G11 模型包回滚
**Files:** `src-tauri/src/core/provisioning.rs`（安装前把现有组件目录 `rename` 为 `<name>.prev`；`rollback_component(name)`；自检失败自动回滚）、`lib.rs` 命令、设置页「工具链」每个组件加「回滚到上一版」
- [x] 测试：安装假组件 v2 后回滚 → v1 文件恢复且自检通过；自检失败 → 自动回滚。
  > 实际：`install_component`（会产生 `.prev` 备份的安装路径）在商用构建里已被下掉，目前没有生产调用点——`rollback_component` 本身接了设置页按钮且可用，但触发它的正常前置状态（装了新版本）只能靠测试或未来重新接线的安装路径造出来，回滚是一个尚无生产调用者的原语。
- [x] Commit：`feat(provisioning): 组件安装保留上一版并可回滚,自检失败自动回滚`

### Task 4: G15 睡眠唤醒续跑 + G14 任务完成通知
**Files:** `src-tauri/src/lib.rs`（`NSWorkspace.notificationCenter` 订阅 `NSWorkspaceDidWakeNotification`，唤醒后 `jobs::recover_expired` + 通知 worker）、`tauri-plugin-notification`（交付完成、批量分析完成各一条）
- [x] 测试：`recover_expired` 单测已有；唤醒路径用 `TRIPCUT_SIMULATE_WAKE=1` 命令触发同一函数并断言；通知调用 mock 断言一次。
- [x] Commit：`feat(runtime): 睡眠唤醒后续跑任务;交付与批量分析完成系统通知`

### Task 5: G7 拼音检索 + G3 搜索命中来源
**Files:** `src/pinyinIndex.ts`（`pinyin-pro` 建文件名/标签/章节的全拼与首字母索引，前端内存）、`src/SidebarSearch.tsx`/`CommandPalette.tsx`（命中来源徽章：文件/转写/AI/标签/画面文字/拼音；点击历史集命中 → 只读历史视图）
- [x] 测试：`"lvpai"`/`"lp"` 命中「旅拍」；来源徽章渲染；历史命中不改当前集过滤。
- [x] Commit：`feat(search): 拼音与首字母检索;命中来源徽章;历史命中进只读视图`

### Task 6: G8 旅程时间线视图 + G4 rotation 落地 + G9 多时长粗剪
- G8：`src/JourneyTimeline.tsx`（按 `canonical_time` 排序：地点卡 + 素材缩略图；只读）；接线人挂进故事板 tab。
- G4：播放器/缩略图按 `rotation` 旋转（mpv `video-rotate`；封面生成 `transpose`）；筛片过滤「竖屏」。
  > 实际：只对 `manual_rotation`（有旋转 tag 但没有 side_data display-matrix 的素材）在 cover/strip 的 ffmpeg 滤镜里插 `transpose`；ffmpeg 自带的 autorotate 已经处理了 side_data 来源的旋转，两者都转会变成转两次，所以 rotation 落地范围收窄到「仅 tag-only 文件」，不是所有带 `rotation` 的素材都走这条新滤镜路径。
- G9：`deliver.rs` 参考粗剪加 `target_seconds: Option<u32>`（30/60/180），按 beat 顺序与预算截取；交付对话框下拉。
- [x] 各自测试；Commit 分三次。

### Task 7: G17 a11y 扫描进门禁 + 跟进项清扫
- `eslint-plugin-jsx-a11y` 推荐规则进 `eslint.config.js`（先修到零违规再开 error）；`fast-gates` 已跑 lint 即覆盖。
- 跟进项：R2 旁白稿与地点卡信任门槛统一（都用 confirmed 或都允许 suggested，选后者并在说明标注「AI 建议」）；R3 旧素材音轨补探测（backfill 谓词加 `NOT EXISTS clip_audio_tracks`，每次启动最多 200 条）；ISO 前缀值解析（`ISO800`）；`attach_audio_tracks` 已过滤；集创建/封存下一集时带平台默认（封存对话框加选择）；O3/O5/O7/O8/O10/O13/O15/O16/O18 按 R2 计划 D 表逐条。
  > 实际：跟进项拆成 7a（`feat/r6-cleanup-import`，含 audio_probed 修复，已合并 7df8d7d）、7b（`feat/r6-cleanup-deliver`，已合并 52011a3）、7c（`feat/r6-cleanup-episode`，已合并 f42e79c）三条车道，均已完成；`eslint-plugin-jsx-a11y` 这条（7e，`feat/r6-a11y`）与 7d 性能复测尚未合并到 main，Task 7 整体不算收口。
- [ ] Commit 分项。（7a/7b/7c 已完成并合并；7d 性能复测与 7e a11y 门禁未完成，故本行整体不勾）

### Task 8: 收尾
- [ ] 门禁、DMG、冒烟（加断言：设置页「检查更新」、故事板「旅程时间线」）、`docs/qa/2026-09-06-unattended-r6.md`、`docs/USER_GUIDE.md`/`docs/用户手册.md` 同步、总计划勾选、待业主清单更新（证书、公开 release、16 GB 真机、剪映人眼核对）。
