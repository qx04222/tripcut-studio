# R1 性能（16 GB 基线）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 500 条 4K 素材的全流程从「峰值 7.42 GB / 54.6 min / 首屏 55.6 s」压到 16 GB 机器不进 swap（预算模式 swapouts=0，整机峰值 < 4 GB），首屏 < 30 s。

**Architecture:** 第一批只改 ffmpeg 参数（滤镜顺序、硬解、关键帧抽帧），不改数据模型；第二批在 `jobs.rs` 的 `WorkerPoolCoordinator` 上加按资源类的许可与内存压力暂停，按机器内存自动选档，CLIP sidecar 空闲卸载，mpv 缓存上限，代理磁盘水位。每一批用 R0 的性能装置出前后两列。

**Tech Stack:** Rust（`src-tauri/src/core/{artifacts,analysis,motion,jobs,settings,sidecar}.rs`、`src-tauri/src/player/mod.rs`）、bundled LGPL ffmpeg（VideoToolbox 硬解可用）、`scripts/qa/perf-harness.mjs`。

## Global Constraints

- 规格 `docs/superpowers/specs/2026-09-06-unattended-upgrade-design.md` §2；总计划 Global Constraints 全部适用。
- cargo：`export PATH=/opt/homebrew/opt/rustup/bin:$PATH`。合并门禁 `node scripts/qa/fast-gates.mjs` 必须 PASS。
- 硬解一律「先 `-hwaccel videotoolbox`，失败则回退软解」，回退路径必须保留并有测试（`artifacts.rs:427-440` 的代理转码是现成范式）。
- 任何采样语义变化（P2/P4）必须升 `ANALYSIS_PIPELINE_VERSION`（`analysis.rs:54`）让 `enqueue_missing` 重算；胶片条没有版本字段，P4 只在「时长 > 60 s 或省内存档」启用以限制影响。
- 不改 schema；新设置走 `settings` 表 key/value（`settings.rs` 顶部常量 + `validate_setting` + `SettingsPage.tsx` 的 `DEFAULT_SETTINGS`）。
- 性能装置：批次前后各跑一次 `node scripts/qa/perf-harness.mjs --label <名>`，结果两列写进 `docs/qa/2026-09-06-unattended-r1.md`。预算模式：`--budget-gb 12`。
- 每个任务在 `main` 上小提交（R1 是接线人热文件车道，不开 worktree），提交后 push。提交信息带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

---

### Task 1: 批次前测量与硬解开关抽公共函数

**Files:**
- Modify: `src-tauri/src/core/artifacts.rs`（新增 `hardware_decode_prefix()`、`run_ffmpeg_file_with_fallback()`）

**Interfaces:**
- Produces:
```rust
/// `-hwaccel videotoolbox` 前缀；所有解码阶段共用，便于测试断言。
pub(crate) fn hardware_decode_prefix() -> [OsString; 2] {
    [OsString::from("-hwaccel"), OsString::from("videotoolbox")]
}
/// 先硬解后软解:`build(true)` 失败则用 `build(false)` 重跑,两次都失败合并报错。
pub(crate) fn run_ffmpeg_file_with_fallback(
    ffmpeg: &OsStr,
    build: impl Fn(bool) -> Vec<OsString>,
    timeout: Duration,
    output_path: &Path,
) -> Result<()>
```

- [ ] **Step 1: 记录「前」列**

Run: `node scripts/qa/perf-harness.mjs --label r1-before`（约 55 min，后台跑，Monitor 等 `gate.json`）。基线已存在，此次数字应与基线相近；把 `rss_bytes.peak / total_ms / first_screen_cover_ms` 抄进报告第 2 节「前」列。

- [ ] **Step 2: 失败测试**

在 `artifacts.rs` 测试模块加：
```rust
    #[test]
    fn fallback_runner_retries_without_hardware_decode() {
        let directory = TestDirectory::new();
        let output = directory.path().join("out.txt");
        let calls = std::cell::RefCell::new(Vec::new());
        // 第一次(硬解)用不存在的输入让 ffmpeg 失败,第二次(软解)用 lavfi 成功
        let result = run_ffmpeg_file_with_fallback(
            test_ffmpeg().as_os_str(),
            |hardware| {
                calls.borrow_mut().push(hardware);
                if hardware {
                    vec![OsString::from("-i"), OsString::from("/nonexistent.mp4"), OsString::from("-f"), OsString::from("null"), OsString::from("-")]
                } else {
                    vec![OsString::from("-f"), OsString::from("lavfi"), OsString::from("-i"), OsString::from("color=c=black:s=16x16:d=0.1"), OsString::from("-f"), OsString::from("rawvideo"), OsString::from("-y"), output.as_os_str().to_owned()]
                }
            },
            Duration::from_secs(30),
            &output,
        );
        assert!(result.is_ok());
        assert_eq!(*calls.borrow(), vec![true, false]);
    }
```
（`test_ffmpeg()` 与 `TestDirectory` 已在该测试模块使用；若名字不同，按模块内现有 helper 改。）

- [ ] **Step 3: 跑测试确认红**

Run: `cargo test --manifest-path src-tauri/Cargo.toml fallback_runner_retries` → 编译错误：函数未定义。

- [ ] **Step 4: 实现**

在 `run_ffmpeg_file` 旁加：
```rust
pub(crate) fn hardware_decode_prefix() -> [OsString; 2] {
    [OsString::from("-hwaccel"), OsString::from("videotoolbox")]
}

pub(crate) fn run_ffmpeg_file_with_fallback(
    ffmpeg: &OsStr,
    build: impl Fn(bool) -> Vec<OsString>,
    timeout: Duration,
    output_path: &Path,
) -> Result<()> {
    let hardware_args = build(true);
    match run_ffmpeg_file(ffmpeg, &hardware_args, timeout, output_path) {
        Ok(()) => Ok(()),
        Err(hardware_error) => {
            remove_if_exists(output_path)?;
            let software_args = build(false);
            run_ffmpeg_file(ffmpeg, &software_args, timeout, output_path).map_err(|software_error| {
                CoreError::Artifact(format!(
                    "VideoToolbox 硬解：{hardware_error}；CPU 解码：{software_error}"
                ))
            })
        }
    }
}
```

- [ ] **Step 5: 绿 + 提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml fallback_runner_retries` → ok。
```bash
git add src-tauri/src/core/artifacts.rs
git commit -m "perf(ffmpeg): 硬解优先、软解回退的公共执行器——后续四个解码阶段共用

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin main
```

---

### Task 2: P1 封面缩略图先缩放再选帧 + 硬解

**Files:**
- Modify: `src-tauri/src/core/artifacts.rs:204-229`（cover_args 改为闭包）

- [ ] **Step 1: 失败测试**
```rust
    #[test]
    fn cover_filter_scales_before_thumbnail_and_prefers_hardware_decode() {
        let args = cover_args(Path::new("/x.mp4"), 1.0, Path::new("/tmp/c.jpg"), true);
        let joined = args.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
        assert!(joined.contains("-hwaccel videotoolbox -ss"));
        assert!(joined.contains("-vf scale=480:-2,thumbnail=90"));
        let software = cover_args(Path::new("/x.mp4"), 1.0, Path::new("/tmp/c.jpg"), false);
        assert!(!software.iter().any(|a| a == "-hwaccel"));
    }
```
- [ ] **Step 2: 红** — `cargo test … cover_filter_scales` → 编译错误。
- [ ] **Step 3: 实现** — 把 `cover_args` 抽成函数并改滤镜顺序：
```rust
fn cover_args(source: &Path, cover_time: f64, output: &Path, hardware_decode: bool) -> Vec<OsString> {
    let mut args = vec![OsString::from("-hide_banner"), OsString::from("-loglevel"), OsString::from("error")];
    if hardware_decode { args.extend(hardware_decode_prefix()); }
    args.extend([
        OsString::from("-ss"), OsString::from(format!("{cover_time:.6}")),
        OsString::from("-i"), source.as_os_str().to_owned(),
        OsString::from("-map"), OsString::from("0:v:0"),
        OsString::from("-frames:v"), OsString::from("1"),
        // 先缩到 480 宽再让 thumbnail 在 90 帧里选代表帧:4K 10-bit 下峰值 1.74 GB → 0.81 GB(2026-09-06 实测)
        OsString::from("-vf"), OsString::from("scale=480:-2,thumbnail=90"),
        OsString::from("-c:v"), OsString::from("mjpeg"), OsString::from("-q:v"), OsString::from("3"),
        OsString::from("-f"), OsString::from("image2"), OsString::from("-y"), output.as_os_str().to_owned(),
    ]);
    args
}
```
调用处改为 `run_ffmpeg_file_with_fallback(ffmpeg, |hw| cover_args(&source.path, cover_time, &cover_temporary, hw), timeout, &cover_temporary)`。
- [ ] **Step 4: 绿** — 目标测试 + `cargo test … artifacts` 全绿。
- [ ] **Step 5: Commit** — `perf(cover): 先缩放再 thumbnail 选帧并开 VideoToolbox 硬解——峰值 1.74 GB→0.81 GB`。

---

### Task 3: P2 L1 分析场景检测移到降采样后 + 硬解 + 流水线 v4

**Files:**
- Modify: `src-tauri/src/core/analysis.rs:54,371-400`

- [ ] **Step 1: 失败测试**
```rust
    #[test]
    fn analysis_filter_runs_scene_detection_after_downscale_and_bumps_pipeline_version() {
        assert_eq!(ANALYSIS_PIPELINE_VERSION, "analyze_l1/v4");
        let args = analysis_args(Path::new("/x.mp4"), 0.35, false, true);
        let joined = args.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
        assert!(joined.starts_with("-hide_banner -nostdin -hwaccel videotoolbox -i"));
        let filter = args.iter().position(|a| a == "-filter_complex").map(|i| args[i + 1].to_string_lossy().into_owned()).unwrap();
        assert!(filter.starts_with("[0:v:0]fps=2,scale=640:-2,format=yuv420p,split=2[scene_src][stats_src]"));
        assert!(filter.contains("[scene_src]select='eq(n,0)+gt(scene,0.35)',showinfo[scene_out]"));
    }
```
- [ ] **Step 2: 红**。
- [ ] **Step 3: 实现** — 抽 `analysis_args(path, scene_threshold, has_audio, hardware_decode) -> Vec<OsString>`：滤镜改为
```rust
    let filter = format!(
        "[0:v:0]fps=2,scale=640:-2,format=yuv420p,split=2[scene_src][stats_src];\
         [scene_src]select='eq(n,0)+gt(scene,{scene_threshold})',showinfo[scene_out];\
         [stats_src]signalstats=stat=brng,blurdetect=radius=20,entropy,vmafmotion,\
         metadata=mode=print[stats_out]"
    );
```
硬解前缀插在 `-nostdin` 之后 `-i` 之前。`analyze_source` 用「先硬解后软解」：硬解失败（非零退出）则用 `analysis_args(.., false)` 重跑一次。`ANALYSIS_PIPELINE_VERSION` 改 `"analyze_l1/v4"`。**场景切点语义**：现在 select 在 2 fps 上跑，`showinfo` 的 pts 仍是源时间戳（fps 滤镜保留时间基），`scene_cuts` 解析不变；但 2 fps 会漏掉 0.5 s 内的连续切点——可接受（筛片粒度）。
- [ ] **Step 4: 判据对照** — 跑 `cargo test … analysis`（含 `real_ffmpeg_flat_4k_analysis_persists_without_retry` 与 `outdated_pipeline_version_is_requeued_for_reanalysis`）全绿；再用 `spikes/s2-libmpv/media/test-4k-hevc-10bit.mp4` 手跑一次 `analyze_source` 前后（用 git stash 对照或先记录旧输出）：`overexposed/underexposed/blur_mean/jitter` 各字段差异 ≤ 5%，`scene_count` 相同或 ±1，写进报告。
- [ ] **Step 5: Commit** — `perf(analysis): 场景检测移到 2fps/640 降采样之后并开硬解——CPU 19.6s→<3s;流水线升 v4 触发重算`。

---

### Task 4: P3+P4 胶片条与运镜硬解，长素材关键帧抽帧

**Files:**
- Modify: `src-tauri/src/core/artifacts.rs:232-258`（strip）、`src-tauri/src/core/motion.rs:255-281`

- [ ] **Step 1: 失败测试**（artifacts）
```rust
    #[test]
    fn strip_args_use_hardware_decode_and_keyframes_only_for_long_clips() {
        let short = strip_args(Path::new("/x.mp4"), 30.0, 6, Path::new("/tmp/s.jpg"), true, false);
        let long = strip_args(Path::new("/x.mp4"), 300.0, 12, Path::new("/tmp/s.jpg"), true, true);
        let j = |v: &Vec<OsString>| v.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
        assert!(j(&short).contains("-hwaccel videotoolbox"));
        assert!(!j(&short).contains("-skip_frame"));
        assert!(j(&long).contains("-skip_frame nokey"));
    }
```
（motion）
```rust
    #[test]
    fn gray_frame_args_prefer_hardware_decode() {
        let args = gray_frame_args(Path::new("/x.mp4"), true);
        assert!(args.windows(2).any(|w| w[0] == "-hwaccel" && w[1] == "videotoolbox"));
        assert!(!gray_frame_args(Path::new("/x.mp4"), false).iter().any(|a| a == "-hwaccel"));
    }
```
- [ ] **Step 2: 红**。
- [ ] **Step 3: 实现** — `strip_args(source, duration_seconds, frame_count, output, hardware_decode, keyframes_only)`：硬解前缀在 `-i` 前；`keyframes_only` 时在 `-i` 前加 `-skip_frame nokey`。调用处 `keyframes_only = source.duration_seconds > 60.0 || settings::memory_profile_is_low(connection)?`（`memory_profile_is_low` 在 Task 6 才有，本任务先只用时长条件，留 TODO 注释禁止——直接写 `source.duration_seconds > 60.0`，Task 6 再接档位）。motion：`gray_frame_args(path, hardware_decode)`，`analyze_video` 先硬解 `execute_with_reader`，`Err` 或非零退出则软解重跑。
- [ ] **Step 4: 绿 + 对照** — `cargo test … artifacts`、`cargo test … motion` 全绿（运镜 fixture 分类测试必须逐条相等）。
- [ ] **Step 5: Commit** — `perf(strip,motion): 胶片条与运镜开 VideoToolbox 硬解;>60s 素材胶片条只解关键帧`。

---

### Task 5: 第一批测量与报告

- [ ] Run `node scripts/qa/fast-gates.mjs` → PASS。
- [ ] Run `node scripts/qa/perf-harness.mjs --label r1-batch1`（后台 + Monitor）。Expected：`PASS rss-peak<=+10%`、`PASS total<=+15%`（应为显著下降），记录三个数进报告「批次 1」列；若 `first-screen<=30s` 仍红，如实记录，不改阈值。
- [ ] 写 `docs/qa/2026-09-06-unattended-r1.md` 第 1–3 节草稿（前/批次 1 两列），提交推送。

---

### Task 6: P6 内存档位与预算探针（先于许可，因为许可默认值依赖档位）

**Files:**
- Create: `src-tauri/src/core/memory_profile.rs`
- Modify: `src-tauri/src/core/mod.rs`（`pub mod memory_profile;`）、`src-tauri/src/core/settings.rs`（新 key）、`src/SettingsPage.tsx`（`DEFAULT_SETTINGS` 镜像 + 一行只读显示当前档位）

**Interfaces:**
```rust
pub const MEMORY_PROFILE_KEY: &str = "performance.memory_profile"; // "auto" | "standard" | "low"
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MemoryProfile { Standard, Low }
impl MemoryProfile {
    pub fn decode_permits(self) -> usize { match self { Self::Standard => 4, Self::Low => 2 } }
    pub fn software_decode_threads(self) -> usize { match self { Self::Standard => 0, Self::Low => 4 } } // 0 = ffmpeg 默认
}
/// 预算字节:`TRIPCUT_MEMORY_BUDGET_BYTES` 优先,否则 sysctl hw.memsize。
pub fn budget_bytes() -> u64;
/// 解析档位:设置为 auto 时 budget < 24 GiB → Low。
pub fn resolve(connection: &Connection) -> Result<MemoryProfile>;
/// 0–100 的可用内存百分比:`TRIPCUT_MEMORY_PRESSURE_FILE`(文件内容为整数)优先;否则 host_statistics64 的 (free+inactive)/total。
pub fn available_percent() -> u32;
pub const PAUSE_BELOW_PERCENT: u32 = 15;
```

- [ ] **Step 1: 失败测试**（`memory_profile.rs` 内）
```rust
    #[test]
    fn budget_env_overrides_hw_memsize_and_low_profile_below_24_gib() {
        std::env::set_var("TRIPCUT_MEMORY_BUDGET_BYTES", "12884901888");
        assert_eq!(budget_bytes(), 12_884_901_888);
        assert_eq!(profile_for_budget(12_884_901_888, "auto"), MemoryProfile::Low);
        assert_eq!(profile_for_budget(34_359_738_368, "auto"), MemoryProfile::Standard);
        assert_eq!(profile_for_budget(34_359_738_368, "low"), MemoryProfile::Low);
        std::env::remove_var("TRIPCUT_MEMORY_BUDGET_BYTES");
    }
    #[test]
    fn pressure_file_overrides_host_statistics() {
        let directory = crate::core::test_support::TestDirectory::new();
        let file = directory.path().join("pressure");
        std::fs::write(&file, "9").unwrap();
        std::env::set_var("TRIPCUT_MEMORY_PRESSURE_FILE", &file);
        assert_eq!(available_percent(), 9);
        std::env::remove_var("TRIPCUT_MEMORY_PRESSURE_FILE");
        assert!(available_percent() <= 100);
    }
```
（环境变量测试要 `#[serial]` 或在同一个测试里做，避免并行污染——两个测试合并成一个也可以。）
- [ ] **Step 2: 红**。
- [ ] **Step 3: 实现** — `budget_bytes()`：env → `sysctlbyname("hw.memsize")` via libc；`available_percent()`：env 文件 → `host_statistics64(HOST_VM_INFO64)` 用 libc 的 `vm_statistics64` 与 `vm_page_size`，`(free+inactive)*page/total`；失败返回 100（不误暂停）。`resolve()` 读设置默认 `"auto"`。`validate_setting` 加 `MEMORY_PROFILE_KEY => matches!(value,"auto"|"standard"|"low")`。前端 `DEFAULT_SETTINGS` 加 `"performance.memory_profile": "auto"`，设置页性能分区加一个下拉（自动/标准/省内存）。
- [ ] **Step 4: 绿 + clippy + vitest**（`SettingsPage.test.tsx` 若断言设置项数量要同步）。
- [ ] **Step 5: Commit** — `perf(memory): 内存档位与预算探针——auto 按 hw.memsize<24GiB 走省内存档,预算与压力可由环境变量注入供装置模拟 16GB`。

---

### Task 7: P5+P7 按资源类的许可与同素材解码串行

**Files:**
- Modify: `src-tauri/src/core/jobs.rs:171-235`（`claim_next_for_owner` 加排除条件）、`:668-760`（协调器状态与许可）、`:1125-1160`（worker 循环压力暂停）

**Interfaces:**
```rust
pub(crate) enum ResourceClass { Decode, HeavyModel, Light }
pub(crate) fn resource_class(kind: &str) -> ResourceClass {
    match kind {
        "thumbnail" | "analyze_l1" | "analyze_motion" | "proxy" => ResourceClass::Decode,
        "clip_embed" | "classify_dims" | "transcribe" => ResourceClass::HeavyModel,
        _ => ResourceClass::Light,
    }
}
pub(crate) const DECODE_KINDS_SQL: &str = "('thumbnail','analyze_l1','analyze_motion','proxy')";
/// 新签名:排除已饱和的资源类,并按 clip_id 排除已有解码任务在跑的素材。
pub fn claim_next_for_owner_excluding(connection: &mut Connection, owner_id: &str, exclude_decode: bool, exclude_heavy: bool) -> Result<Option<Job>>;
```
`WorkerPoolState` 加 `active_decode: usize, active_heavy: usize, decode_limit: usize, paused_for_memory: bool`。`JobRunner::new(db_path, worker_count)` 之外加 `with_limits(decode_limit)`；`lib.rs:1478` 用 `memory_profile::resolve(&connection)?.decode_permits()` 传入。

- [ ] **Step 1: 失败测试**
```rust
    #[test]
    fn decode_jobs_for_same_clip_do_not_run_concurrently() {
        // 两个 thumbnail 任务同 clip_id=7,一个 running 时另一个不可认领;不同 clip 可认领
        let directory = TestDirectory::new();
        let mut connection = open_test_db(&directory);
        enqueue(&mut connection, "thumbnail", r#"{"clip_id":7}"#, "a").unwrap();
        enqueue(&mut connection, "thumbnail", r#"{"clip_id":7}"#, "b").unwrap();
        enqueue(&mut connection, "analyze_l1", r#"{"clip_id":8}"#, "c").unwrap();
        let first = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(first.kind, "thumbnail");
        let second = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(second.payload, r#"{"clip_id":8}"#);
        assert!(claim_next(&mut connection).unwrap().is_none());
    }
    #[test]
    fn saturated_decode_class_is_skipped_but_light_jobs_still_claim() {
        let directory = TestDirectory::new();
        let mut connection = open_test_db(&directory);
        enqueue(&mut connection, "proxy", r#"{"clip_id":1}"#, "p").unwrap();
        enqueue(&mut connection, "waveform", r#"{"clip_id":2}"#, "w").unwrap();
        let job = claim_next_for_owner_excluding(&mut connection, "t", true, false).unwrap().unwrap();
        assert_eq!(job.kind, "waveform");
    }
```
（先 `grep -n 'clip_id' src-tauri/src/core/artifacts.rs | head` 确认解码任务 payload 里 clip_id 的字段名，若不是 `clip_id` 按实际改 SQL。）
- [ ] **Step 2: 红**。
- [ ] **Step 3: 实现** — SQL 追加：
```sql
  AND (?exclude_decode = 0 OR kind NOT IN ('thumbnail','analyze_l1','analyze_motion','proxy'))
  AND (?exclude_heavy = 0 OR kind NOT IN ('clip_embed','classify_dims','transcribe'))
  AND NOT (kind IN ('thumbnail','analyze_l1','analyze_motion','proxy') AND EXISTS (
        SELECT 1 FROM jobs r WHERE r.status='running'
          AND r.kind IN ('thumbnail','analyze_l1','analyze_motion','proxy')
          AND json_extract(r.payload,'$.clip_id') = json_extract(jobs.payload,'$.clip_id')))
```
协调器 `claim_for_owner`：锁 state 读 `exclude_decode = active_decode >= decode_limit`、`exclude_heavy = active_heavy >= 1`、若 `paused_for_memory` 则直接返回 `Ok(None)`；认领后按 `resource_class` 递增计数，`ExecutionPermit::drop` 递减。`run()` 里 spawn 一个 tokio 任务每 5 s：`available_percent() < PAUSE_BELOW_PERCENT` → `paused_for_memory = true` 并 `tracing::warn!`，恢复到 ≥ 25% 才清零（滞回）。
- [ ] **Step 4: 前端** — `get_import_progress` 加 `waiting_for_permit: u64`（pending 且资源类饱和的近似：`pending` 中解码类且 `active_decode>=limit` 时 = pending 解码类数），`ImportPage.tsx:681` 显示 `「N 等待解码许可」`。`ImportPage.test.tsx` 加一条渲染断言。
- [ ] **Step 5: 绿 + clippy + vitest + Commit** — `perf(jobs): 解码/大模型按资源类许可,同素材解码串行,内存压力低于 15% 暂停认领`。

---

### Task 8: P8 CLIP sidecar 空闲卸载与按帧数截止

**Files:** `src-tauri/src/core/sidecar.rs:22,136-200,208-225`；`jobs.rs` `run()` 的定时任务

- [ ] 失败测试：`SidecarClient` 加 `last_used: Option<Instant>`；`unload_if_idle(idle: Duration, keep: bool) -> bool` 在 `last_used` 超过 `idle` 且 `!keep` 时 `stop()` 返回 true。测试用 `Instant::now() - 61s` 直接构造状态断言返回 true 并 `process.is_none()`；`keep=true` 返回 false。
- [ ] `embed_images` 超时改 `Duration::from_secs(30 + 5 * strip_frame_count as u64)`；`classify` 与 `embed_text` 用 60 s；超时 `CallFailure::Timeout` 时调用 `restart()`（看 `describe_call_failure`/`restart_note` 现有分支，把 Timeout 并入需要重启的分支）。
- [ ] `JobRunner::run` 定时任务每 30 s：`keep = pending clip_embed/classify_dims 数 > 0`（一条 COUNT 查询），调 `sidecar::unload_if_idle(60 s, keep)`。
- [ ] Commit — `perf(sidecar): CLIP 空闲 60s 卸载(队列有嵌入任务不卸);嵌入超时按帧数计算并在超时后重启子进程`。

---

### Task 9: P9+P10+P11 mpv 缓存上限、代理磁盘水位、省内存档代理参数

**Files:** `src-tauri/src/player/mod.rs:682-690`；`src-tauri/src/core/artifacts.rs:385-520`；`src-tauri/src/core/doctor.rs:297`（把 `available_bytes` 改 `pub(crate)`）

- [ ] mpv 初始化加：`demuxer-max-bytes = "150MiB"`, `demuxer-max-back-bytes = "50MiB"`, `cache-secs = 10`（字符串属性；分发版 libmpv 是 `-Dcplayer=false`，这三项属于 demuxer 核心，存在；用 `let _ =` 兜底并 `tracing::warn!` 记录失败）。
- [ ] `run_proxy_with` 开头：`let needed = (2u64 << 30).max((source.duration_seconds * 500_000.0) as u64); if doctor::available_bytes(cache_root)? < needed { return Err(CoreError::Artifact(format!("缓存磁盘剩余不足（需要约 {} MB），代理生成暂缓；缩略图与分析不受影响", needed >> 20))); }`——错误进入现有 retry/block 路径，界面可见。测试：用 hdiutil 建 1 GB 小卷当 cache_root（`hdiutil create -size 1g -fs APFS -volname perftest /tmp/perftest.dmg && hdiutil attach`），断言 `run_proxy` 返回含「缓存磁盘剩余不足」的错误；结束 `hdiutil detach`。
- [ ] `proxy_args` 加 `low_memory: bool`：`-b:v` 2.5M、`-realtime 1`，且软解分支加 `-threads 4`；调用处用 `memory_profile::resolve`。单测断言参数。
- [ ] Commit — `perf(player,proxy): mpv 解复用缓存上限;代理生成前查缓存盘水位;省内存档代理 2.5Mbps+realtime`。

---

### Task 10: 第二批测量、预算模式验证、收尾

- [ ] `node scripts/qa/fast-gates.mjs` PASS。
- [ ] `node scripts/qa/perf-harness.mjs --label r1-batch2`（默认 32 GB 档）与 `node scripts/qa/perf-harness.mjs --label r1-budget16 --budget-gb 12`（预算模式；装置在 `--budget-gb` 时应额外设 `TRIPCUT_MEMORY_PRESSURE_FILE`——本任务给 harness 加：预算模式下按 `聚合 RSS / 预算` 每 500 ms 写 `available_percent = 100 - ratio*100` 到临时文件；断言 `swapouts=0` 且 `jobs.failed=0`，并在 gate 里记录 `paused_events`（driver 读日志中 `paused_for_memory` 出现次数，或 harness 从 stderr 统计））。
- [ ] 报告 `docs/qa/2026-09-06-unattended-r1.md` 六节补全：三列（前 / 批次 1 / 批次 2）+ 预算模式列；F 条；下一轮入口 R2。
- [ ] 每日收尾链：package-dmg → audit → preflight → cua `--seed-db` → smoke → crash-diff；提交推送。
