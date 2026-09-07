# R3 目标平台预设 + Pocket 4 专项 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建集时选目标平台与横竖画布并贯穿到交付；Pocket 4 素材的 D-Log/HDR 显示、多声道分轨、显示 LUT、可读取的曝光参数进入技术检查与交付说明。

**Architecture:** 两条迁移（0031 平台预设、0032 音轨/LUT/元数据），后端命令各自独立模块（`platform.rs`、`audio_tracks.rs`），播放器加 LUT 与选轨命令，交付层只读这些字段写说明；前端在集面板、技术检查面板、交付对话框三处接入，路由不变。

**Tech Stack:** Rust/rusqlite、ffprobe `-show_streams`/`-show_entries format_tags:stream_tags`、mpv `vf-add lut3d` / `aid` / `mute`、React。

## Global Constraints

- 规格 §4 前两行；总计划 Global Constraints。迁移号 **0031 平台预设、0032 音轨/LUT/元数据**（`MIGRATIONS` 数组连续追加，`LATEST_SCHEMA_VERSION` 同步）。
- 原片只读；LUT 只用于显示：代理生成与交付导出路径必须断言不带 `lut3d`。
- 不引入 exiftool；只从 ffprobe 抓 ISO/快门/光圈，抓不到显示「设备未提供」。
- 每车道 worktree + `CARGO_TARGET_DIR` 共用；合并只由接线人做；提交带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- 门禁：`node scripts/qa/fast-gates.mjs` 看 `gate.json.status`。

---

### Task 1: 0031 平台预设数据层与命令

**Files:** `src-tauri/src/core/migrations.rs`（`MIGRATION_0031`）、`src-tauri/src/core/platform.rs`（新）、`src-tauri/src/core/mod.rs`、`src-tauri/src/core/episode.rs`（`EpisodeSummary` 加两字段）、`src-tauri/src/lib.rs`、`src/api.ts`

**Interfaces:**
```sql
-- MIGRATION_0031
ALTER TABLE episodes ADD COLUMN target_platform TEXT NOT NULL DEFAULT 'general'
  CHECK(target_platform IN ('douyin','xiaohongshu','bilibili','moments','family','general'));
ALTER TABLE episodes ADD COLUMN canvas_orientation TEXT NOT NULL DEFAULT 'both'
  CHECK(canvas_orientation IN ('landscape','portrait','both'));
CREATE TABLE platform_presets (
  platform TEXT PRIMARY KEY, display_name TEXT NOT NULL,
  portrait_w INTEGER, portrait_h INTEGER, landscape_w INTEGER, landscape_h INTEGER,
  duration_budget_ticks INTEGER, tb_num INTEGER NOT NULL, tb_den INTEGER NOT NULL,
  subtitle_style_json TEXT NOT NULL);
INSERT OR IGNORE INTO platform_presets VALUES
 ('douyin','抖音',1080,1920,1920,1080,60000000,1,1000000,'{"font_px":64,"safe_bottom_pct":18}'),
 ('xiaohongshu','小红书',1080,1440,1920,1080,90000000,1,1000000,'{"font_px":56,"safe_bottom_pct":14}'),
 ('bilibili','B站',1080,1920,1920,1080,600000000,1,1000000,'{"font_px":48,"safe_bottom_pct":10}'),
 ('moments','朋友圈',1080,1920,1920,1080,15000000,1,1000000,'{"font_px":64,"safe_bottom_pct":20}'),
 ('family','家庭纪录',1080,1920,3840,2160,0,1,1000000,'{"font_px":48,"safe_bottom_pct":10}'),
 ('general','通用',1080,1920,1920,1080,0,1,1000000,'{"font_px":52,"safe_bottom_pct":12}');
```
```rust
#[derive(Serialize)] pub struct PlatformPreset { platform: String, display_name: String, portrait: (i64,i64), landscape: (i64,i64), duration_budget_ticks: i64, tb_num: i64, tb_den: i64, subtitle_style: serde_json::Value }
pub fn list_platform_presets(connection) -> Result<Vec<PlatformPreset>>;
pub fn set_episode_platform(connection: &mut Connection, episode_id: i64, platform: &str, orientation: &str) -> Result<()>;  // 校验枚举;历史集拒绝
```
- [ ] 失败测试：`list_platform_presets` 返回 6 条且尺寸非空；`set_episode_platform` 非法值被 CHECK 拒绝；封存集拒绝。
- [ ] 命令 `list_platform_presets`、`set_episode_platform`；`api.ts` 类型与包装。
- [ ] Commit：`feat(platform): 迁移 0031 目标平台预设与集级默认——六套只读预设`

### Task 2: 新建集向导与交付对话框的平台选择（前端）

**Files:** `src/EpisodePanel.tsx`（新建/重命名集的表单加平台单选 + 横/竖/双）、`src/DeliverPage.tsx`（导出对话框「本次交付平台」下拉，默认取集设置，临时覆盖不落库）、`src/api.ts`（`startExport(destination, overridePlatform?)`）、测试
- [ ] 测试：新建集表单提交调用 `setEpisodePlatform(id,"douyin","portrait")`；交付对话框默认显示集平台并可改。
- [ ] Commit：`feat(episode,deliver): 新建集选目标平台与画布方向;交付时可临时覆盖`

### Task 3: 交付层读平台预设

**Files:** `src-tauri/src/core/deliver.rs`（`start_export(connection, destination, override_platform: Option<&str>)`；`交付说明.txt` 增「目标平台：抖音（竖版 1080×1920，建议 ≤60 s）」；`剪辑清单.csv` 加列 `平台`/`画布`）、`src-tauri/src/core/jianying.rs`（`canvas_config` 用预设尺寸而不是首条素材尺寸；`both` 时按集默认横版）
- [ ] 测试：集设 douyin/portrait → 说明含「抖音」与 1080×1920；草稿 JSON `canvas_config.width/height` = 1080/1920；override 为 bilibili 时说明含「B站」但集记录不变。
- [ ] Commit：`feat(deliver,jianying): 交付说明、剪辑清单与草稿画布按平台预设`

### Task 4: 0032 音轨/LUT/元数据数据层 + 导入探测

**Files:** `migrations.rs`（`MIGRATION_0032`）、`src-tauri/src/core/audio_tracks.rs`（新）、`src-tauri/src/core/import.rs`（probe 解析全部音频流与 tags）
```sql
CREATE TABLE clip_audio_tracks (
  clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  stream_index INTEGER NOT NULL, channels INTEGER, channel_layout TEXT, sample_rate INTEGER,
  role_guess TEXT CHECK(role_guess IN ('onboard_mic','wireless_mic','backup','unknown')),
  PRIMARY KEY(clip_id, stream_index));
ALTER TABLE clips ADD COLUMN selected_transcribe_track INTEGER;
ALTER TABLE clips ADD COLUMN selected_monitor_track INTEGER;
ALTER TABLE clips ADD COLUMN display_lut_path TEXT;
ALTER TABLE clips ADD COLUMN iso_value INTEGER;
ALTER TABLE clips ADD COLUMN shutter_speed TEXT;
ALTER TABLE clips ADD COLUMN aperture TEXT;
```
- [ ] 失败测试：ffprobe JSON fixture（2 路音频 + `format.tags` 含 `com.dji.iso=800`）→ `parse_audio_streams` 两行、`parse_capture_tags` ISO 800；无 tags → 全 None。`role_guess` 启发式：单声道 48k 且第二路存在 → `wireless_mic`；第一路立体声 → `onboard_mic`；其余 `unknown`（单测）。
- [ ] 导入时写入 `clip_audio_tracks`；`enqueue_missing` 风格的补探测 `probe_audio_tracks(clip_id)` 命令。
- [ ] 合成夹具验收：`ffmpeg -f lavfi -i anullsrc -f lavfi -i "sine=440" -f lavfi -i testsrc2 -map 2:v -map 0:a -map 1:a -t 3 …` 导入后 2 行。
- [ ] Commit：`feat(audio): 迁移 0032 多声道与拍摄参数入库——导入时解析全部音频流与厂商标签`

### Task 5: 播放器 LUT 与选轨

**Files:** `src-tauri/src/player/mod.rs`（`PlayerCommand::{ApplyDisplayLut(PathBuf), ClearDisplayLut, SelectAudioTrack(i64), SetTrackMute(bool)}` → `vf-add lut3d=<path>` / `vf-remove` / `aid` / `mute`）、`src-tauri/src/lib.rs`（命令 `set_display_lut(scope, id, path)`、`clear_display_lut`、`set_playback_track`、`set_transcribe_track`）、`src-tauri/src/core/artifacts.rs` 与 `deliver.rs`（断言测试：代理与导出 args 不含 `lut3d`）
- [ ] 测试：LUT 路径必须 `.cube` 且存在；`proxy_args`/导出 args 字符串不含 `lut3d`（钉住）；`SelectAudioTrack` 对不存在的 aid 报错不 panic。
- [ ] Commit：`feat(player): 显示 LUT(lut3d,仅预览)与音轨选择/静音——导出路径断言不带 LUT`

### Task 6: 转录按选定音轨 + 交付保留映射

**Files:** `src-tauri/src/core/transcribe.rs`（抽音 `-map 0:a:<selected_transcribe_track or 0>`）、`deliver.rs`（说明加「音轨映射：0 机内麦（转录）/1 无线麦」）、`jianying.rs`（`materials.audios` 每条 `sound_channel_mappings` 或备注字段写 track index）
- [ ] 测试：选第 2 轨 → ffmpeg args 含 `-map 0:a:1`；说明含映射行。
- [ ] Commit：`feat(transcribe,deliver): 转录用选定音轨;交付说明与草稿保留音轨映射`

### Task 7: 技术检查面板（前端）

**Files:** `src/AnalysisPanel.tsx`（或新 `src/TechCheckPanel.tsx` 挂进筛片右栏「技术检查」tab）：分辨率/实际帧率/编码位深/横竖（`rotation`）/色彩（`color_transfer`，D-Log/HDR 徽章）/音轨列表（每轨静音监听、设为转录轨）/ISO 快门 光圈（缺失显示「设备未提供」）/显示 LUT 下拉（列出 `~/Library/Application Support/TripCutStudio/luts/*.cube` + 「仅用于预览，不影响导出」常驻提示）
- [ ] 测试：两轨渲染两行；点击「设为转录轨」调用 `setTranscribeTrack`；无 ISO 显示「设备未提供」；LUT 提示文本存在。
- [ ] Commit：`feat(select): 技术检查面板——色彩/横竖/多声道/拍摄参数/显示 LUT`

### Task 8: 收尾
- [ ] 接线人合并（每合并跑门禁看 gate.json）；`smoke-gui.mjs` 加断言：筛片页 AX 含「技术检查」，设置/集面板含「目标平台」。
- [ ] 文档同步 `docs/USER_GUIDE.md`、`docs/用户手册.md`（平台预设、技术检查、LUT 仅预览、多声道）。
- [ ] 收尾链 + `docs/qa/2026-09-06-unattended-r3.md`。
