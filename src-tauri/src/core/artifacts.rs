use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::error::{CoreError, Result};
use super::jobs::{self, Job};

pub const COVER_FILE: &str = "cover.jpg";
pub const STRIP_FILE: &str = "strip.jpg";
pub const PROXY_FILE: &str = "proxy.mp4";
pub const WAVEFORM_FILE: &str = "waveform.json";
pub const WAVEFORM_BINS: usize = 2_000;

const THUMBNAIL_TIMEOUT: Duration = Duration::from_secs(120);
const WAVEFORM_TIMEOUT: Duration = Duration::from_secs(300);
const PROXY_TIMEOUT: Duration = Duration::from_secs(3_600);
const KEYFRAME_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactJobPayload {
    pub clip_id: i64,
    pub path: String,
    pub source_hash: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactStatus {
    Missing,
    Pending,
    Running,
    Ready,
    Direct,
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ArtifactStatuses {
    pub cover: ArtifactStatus,
    pub strip: ArtifactStatus,
    pub proxy: ArtifactStatus,
    pub waveform: ArtifactStatus,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ClipArtifacts {
    pub cover: Option<String>,
    pub strip: Option<String>,
    pub proxy: Option<String>,
    pub waveform: Option<String>,
    pub statuses: ArtifactStatuses,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WaveformData {
    pub version: u8,
    pub bins: usize,
    pub peaks: Vec<[f32; 2]>,
}

#[derive(Debug)]
struct CommandOutput {
    success: bool,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[derive(Debug)]
struct ClipSource {
    path: PathBuf,
    duration_seconds: f64,
    /// Z-18:原片字节数,用来把代理码率压到不超过源码率。
    byte_size: u64,
    duration_ticks: i64,
    tb_num: i64,
    tb_den: i64,
    height: i64,
    /// R16 预览策略要看的四项:宽(竖拍 4K 只有 width 超 1920)、编码、HDR、VFR。
    width: i64,
    codec: Option<String>,
    hdr: bool,
    is_vfr: bool,
    /// See `core::import::ProbeMetadata::manual_rotation` — only set for the
    /// tag-only rotation ffmpeg's own autorotate does not already apply.
    /// `cover_args`/`strip_args` must be called with THIS, never with
    /// `clips.rotation`, or a side_data-sourced clip gets double-rotated.
    manual_rotation: Option<i64>,
}

struct FinalArtifact<'a> {
    kind: &'static str,
    file_name: &'static str,
    temporary_path: &'a Path,
}

#[derive(Debug)]
struct JobSnapshot {
    id: i64,
    status: String,
    result_path: Option<String>,
}

pub fn cache_root_for_db(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("cache")
}

pub fn run_artifact_job(connection: &mut Connection, job: &Job, cache_root: &Path) -> Result<()> {
    match job.kind.as_str() {
        "thumbnail" => run_thumbnail(connection, job, cache_root),
        "photo_preview" => super::photo_decode::run_preview(connection, job, cache_root),
        "strip" => run_strip(connection, job, cache_root),
        "waveform" => run_waveform(connection, job, cache_root),
        "proxy" => run_proxy(connection, job, cache_root),
        other => Err(CoreError::Artifact(format!(
            "不支持的缓存任务种类：{other}"
        ))),
    }
}

pub fn enqueue_for_clip(
    connection: &mut Connection,
    clip_id: i64,
    path: &Path,
    source_hash: &str,
) -> Result<()> {
    if super::photo_probe::is_photo(connection, clip_id)? { return super::photo_decode::enqueue(connection, clip_id, path, source_hash); }
    let payload = ArtifactJobPayload {
        clip_id,
        path: path.to_string_lossy().into_owned(),
        source_hash: source_hash.to_owned(),
    };
    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| CoreError::Artifact(format!("无法创建缓存任务：{error}")))?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

    // Even with proxy encoding disabled, the lightweight proxy job persists the
    // source-to-source identity map used by the canonical-time API.
    let kinds = &["thumbnail", "waveform", "proxy"][..];
    for kind in kinds {
        let payload_hash = blake3::hash(
            format!("{kind}\0{clip_id}\0{source_hash}").as_bytes(),
        )
        .to_hex()
        .to_string();
        let exists = transaction
            .query_row(
                "SELECT 1 FROM jobs WHERE kind = ?1 AND payload_hash = ?2 LIMIT 1",
                params![kind, payload_hash],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if exists {
            continue;
        }
        transaction.execute(
            "INSERT INTO jobs(
                kind, payload, payload_hash, status, attempt,
                next_attempt_at, created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, 'pending', 0,
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             )",
            params![kind, payload_json, payload_hash],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

pub fn run_thumbnail(connection: &mut Connection, job: &Job, cache_root: &Path) -> Result<()> {
    if super::photo_probe::job_is_photo(connection, job)? { return super::photo_decode::run_thumbnail(connection, job, cache_root); }
    let ffmpeg = super::settings::configured_executable(
        connection,
        super::settings::FFMPEG_PATH_KEY,
        "FFMPEG_PATH",
        "ffmpeg",
    )?;
    run_thumbnail_with(connection, job, cache_root, &ffmpeg, THUMBNAIL_TIMEOUT)
}

/// R6 Task 7d/F-R1-8:`thumbnail` 只产封面(cover),不再顺带做胶片条
/// (strip)——封面是首屏要等的东西,30 秒目标只看它;胶片条留给独立的
/// `strip` 任务,按更低优先级随后跑,不占封面的解码许可窗口。
fn run_thumbnail_with(
    connection: &mut Connection,
    job: &Job,
    cache_root: &Path,
    ffmpeg: &OsStr,
    timeout: Duration,
) -> Result<()> {
    let payload = parse_payload(job)?;
    let source = validate_source(connection, &payload)?;
    let clip_root = cache_root.join(payload.clip_id.to_string());
    std::fs::create_dir_all(&clip_root)?;
    let cover_final = clip_root.join(COVER_FILE);
    let cover_temporary = jobs::temporary_output_path(&cover_final, job.attempt);
    remove_if_exists(&cover_temporary)?;

    let cover_time = source.duration_seconds * 0.25;
    if let Err(error) = run_ffmpeg_file_with_fallback(
        ffmpeg,
        |hardware_decode| cover_args(&source.path, cover_time, &cover_temporary, hardware_decode, source.manual_rotation),
        timeout,
        &cover_temporary,
    ) {
        cleanup_temporary_files([&cover_temporary]);
        return Err(error);
    }

    let artifacts = [FinalArtifact {
        kind: "cover",
        file_name: COVER_FILE,
        temporary_path: &cover_temporary,
    }];
    if let Err(error) = finalize_artifacts(connection, job, cache_root, &payload, &artifacts, None) {
        cleanup_temporary_files([&cover_temporary]);
        return Err(error);
    }
    if let Err(error) = enqueue_strip(connection, &payload) {
        // The thumbnail job is already durably finalized at this point. If the
        // process dies before this enqueue lands, `enqueue_missing_strips`
        // (called from the startup sweep in `lib.rs`) picks it back up on next
        // launch: a clip with a `cover` artifact, no `strip` artifact, and no
        // pending/running `strip` job gets one enqueued. That retry can run
        // here too without corrupting the thumbnail job's done state.
        tracing::warn!(clip_id = payload.clip_id, %error, "could not enqueue film-strip job");
    }
    Ok(())
}

pub fn run_strip(connection: &mut Connection, job: &Job, cache_root: &Path) -> Result<()> {
    if super::photo_probe::skip_video_job(connection, job)? { return Ok(()); }
    let ffmpeg = super::settings::configured_executable(
        connection,
        super::settings::FFMPEG_PATH_KEY,
        "FFMPEG_PATH",
        "ffmpeg",
    )?;
    let ffprobe = super::settings::configured_ffprobe(connection, &ffmpeg)?;
    run_strip_with(connection, job, cache_root, &ffmpeg, &ffprobe, THUMBNAIL_TIMEOUT)
}

/// R6 Task 7d/F-R1-8:胶片条(strip)独立成一个任务,由 `thumbnail` 完成后
/// 排队;跑完之后才有格子图可裁切,`clip_embed`(片段检索的嵌入)因此从
/// `run_thumbnail` 挪到这里入队。
fn run_strip_with(
    connection: &mut Connection,
    job: &Job,
    cache_root: &Path,
    ffmpeg: &OsStr,
    ffprobe: &OsStr,
    timeout: Duration,
) -> Result<()> {
    let payload = parse_payload(job)?;
    let source = validate_source(connection, &payload)?;
    let frame_count = strip_frame_count(source.duration_seconds);
    let clip_root = cache_root.join(payload.clip_id.to_string());
    std::fs::create_dir_all(&clip_root)?;
    let strip_final = clip_root.join(STRIP_FILE);
    let strip_temporary = jobs::temporary_output_path(&strip_final, job.attempt);
    remove_if_exists(&strip_temporary)?;

    // 长素材(>60s)胶片条只解关键帧,避免整段解码撑爆内存;Task 6 会接入内存档位条件。
    // `-skip_frame nokey` + `fps=N/duration` 会在最后一个关键帧处截止时间轴——
    // 长 GOP 素材的尾部几格会静默黑掉。用一次纯解封装(不解码)的 ffprobe 探测
    // 关键帧间隔,间隔够密且尾部关键帧够接近片尾时才启用跳帧。
    let keyframes_only = source.duration_seconds > 60.0
        && keyframe_gaps_allow_skip(ffprobe, &source.path, source.duration_seconds, frame_count);
    if let Err(error) = run_ffmpeg_file_with_fallback(
        ffmpeg,
        |hardware_decode| {
            strip_args(
                &source.path,
                source.duration_seconds,
                frame_count,
                &strip_temporary,
                hardware_decode,
                keyframes_only,
                source.manual_rotation,
            )
        },
        timeout,
        &strip_temporary,
    ) {
        cleanup_temporary_files([&strip_temporary]);
        return Err(error);
    }

    let artifacts = [FinalArtifact {
        kind: "strip",
        file_name: STRIP_FILE,
        temporary_path: &strip_temporary,
    }];
    if let Err(error) = finalize_artifacts(connection, job, cache_root, &payload, &artifacts, None) {
        cleanup_temporary_files([&strip_temporary]);
        return Err(error);
    }
    // R16 低配档不起 CLIP 侧车:胶片条照生成(封面 / 跳看要用),嵌入任务不排。
    if !super::memory_profile::sidecars_enabled(connection) {
        return Ok(());
    }
    if let Err(error) = super::clip_search::enqueue_for_clip(
        connection,
        payload.clip_id,
        &payload.source_hash,
        &strip_final,
        frame_count,
    ) {
        // The strip job is already durably finalized at this point. Startup
        // backfill will retry this enqueue without corrupting its done state.
        tracing::warn!(clip_id = payload.clip_id, %error, "could not enqueue clip embedding");
    }
    Ok(())
}

/// `thumbnail`(封面)完成后把胶片条任务排上队。同一 clip/source_hash 若
/// 已有 pending/running/done 的 `strip` 任务就跳过——`ON CONFLICT DO
/// NOTHING`(`jobs::enqueue_idempotent`)加 mig0040 的部分唯一索引兜底并发,
/// 这里的先查一遍只是省一次没必要的插入尝试。
fn enqueue_strip(connection: &mut Connection, payload: &ArtifactJobPayload) -> Result<()> {
    let payload_json = serde_json::to_string(payload)
        .map_err(|error| CoreError::Artifact(format!("无法创建胶片条任务：{error}")))?;
    let payload_hash = blake3::hash(
        format!("strip\0{}\0{}", payload.clip_id, payload.source_hash).as_bytes(),
    )
    .to_hex()
    .to_string();
    let existing_status: Option<String> = connection
        .query_row(
            "SELECT status FROM jobs WHERE kind = 'strip' AND payload_hash = ?1
             ORDER BY id DESC LIMIT 1",
            [&payload_hash],
            |row| row.get(0),
        )
        .optional()?;
    if matches!(existing_status.as_deref(), Some("pending" | "running" | "done")) {
        return Ok(());
    }
    jobs::enqueue_idempotent(connection, "strip", &payload_json, &payload_hash)?;
    Ok(())
}

/// 启动补扫:找出「有 `cover` 产物、没有 `strip` 产物、也没有 pending/running
/// `strip` 任务」的 clip,把丢失的胶片条任务补回去。
///
/// 覆盖的是 `finalize_artifacts`(封面已落盘)和 `enqueue_strip`(胶片条任务
/// 入队)之间的进程死亡窗口——那个区间里封面产物已经是既成事实,但胶片条
/// 任务从未被创建过,此前没有任何重试路径能补上它,clip 就永久卡在「有封面
/// 无胶片条」。这里不复用 `enqueue_strip` 的幂等判定(它连 `done` 状态的
/// 旧任务也当作"已经处理过"跳过),因为补扫要处理的正是"任务从未存在过"或
/// "产物已经不在了但任务记录还在"这类异常态——只要没有 pending/running 的
/// `strip` 任务在占着 mig0040 那条部分唯一索引,就应该把它补上;真正的并发
/// 安全网仍然是那条索引,这里的查询只是省一次没必要的插入尝试。
pub fn enqueue_missing_strips(connection: &mut Connection) -> Result<usize> {
    let candidates = {
        // blake3 无法在 SQL 里算,payload_hash 判定挪到 Rust 侧逐条做,这里
        // 只按「有封面无胶片条」先筛出候选集合,避免把整张 jobs 表拉进内存。
        let mut statement = connection.prepare(
            "SELECT c.id, c.rel_path, cover.source_hash
             FROM clips c
             JOIN cache_artifacts cover
               ON cover.clip_id = c.id AND cover.kind = 'cover'
             LEFT JOIN cache_artifacts strip
               ON strip.clip_id = c.id AND strip.kind = 'strip'
              AND strip.source_hash = cover.source_hash
             WHERE c.kind = 'video' AND c.missing_since IS NULL
               AND strip.clip_id IS NULL
             ORDER BY c.id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut enqueued = 0;
    for (clip_id, rel_path, source_hash) in candidates {
        let payload_hash = blake3::hash(format!("strip\0{clip_id}\0{source_hash}").as_bytes())
            .to_hex()
            .to_string();
        let has_active_job: bool = connection.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM jobs
                 WHERE kind = 'strip' AND payload_hash = ?1
                   AND status IN ('pending', 'running')
             )",
            [&payload_hash],
            |row| row.get(0),
        )?;
        if has_active_job {
            continue;
        }
        let payload = ArtifactJobPayload {
            clip_id,
            path: rel_path,
            source_hash,
        };
        let payload_json = serde_json::to_string(&payload)
            .map_err(|error| CoreError::Artifact(format!("无法创建胶片条任务：{error}")))?;
        // 上面的 `has_active_job` 检查只是省一次没必要的插入尝试;真正的并发
        // 安全网是 `enqueue_idempotent` + mig0040 的部分唯一索引——即使两个
        // 补扫同时跑,也只会有一条 pending `strip` 任务留下来。
        jobs::enqueue_idempotent(connection, "strip", &payload_json, &payload_hash)?;
        enqueued += 1;
    }
    Ok(enqueued)
}

pub fn run_waveform(connection: &mut Connection, job: &Job, cache_root: &Path) -> Result<()> {
    if super::photo_probe::skip_video_job(connection, job)? { return Ok(()); }
    let ffmpeg = super::settings::configured_executable(
        connection,
        super::settings::FFMPEG_PATH_KEY,
        "FFMPEG_PATH",
        "ffmpeg",
    )?;
    run_waveform_with(
        connection,
        job,
        cache_root,
        &ffmpeg,
        WAVEFORM_TIMEOUT,
    )
}

fn run_waveform_with(
    connection: &mut Connection,
    job: &Job,
    cache_root: &Path,
    ffmpeg: &OsStr,
    timeout: Duration,
) -> Result<()> {
    let payload = parse_payload(job)?;
    let source = validate_source(connection, &payload)?;
    let args = vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-i"),
        source.path.as_os_str().to_owned(),
        OsString::from("-vn"),
        OsString::from("-map"),
        OsString::from("0:a:0?"),
        OsString::from("-ac"),
        OsString::from("1"),
        OsString::from("-ar"),
        OsString::from("8000"),
        OsString::from("-f"),
        OsString::from("s16le"),
        OsString::from("pipe:1"),
    ];
    let output = execute_with_timeout(ffmpeg, &args, timeout).map_err(|error| {
        CoreError::Artifact(format!(
            "ffmpeg 无法解码波形 {}：{error}",
            source.path.display()
        ))
    })?;
    let no_audio = output.stdout.is_empty()
        && (output.success || stderr_means_no_audio(&output.stderr));
    if !output.success && !no_audio {
        return Err(ffmpeg_failure("波形", &output));
    }
    if output.stdout.len() % 2 != 0 {
        return Err(CoreError::Artifact(
            "ffmpeg 返回了长度非偶数的 16-bit PCM".to_owned(),
        ));
    }
    let samples = output
        .stdout
        .as_chunks::<2>()
        .0
        .iter()
        .map(|bytes| i16::from_le_bytes(*bytes))
        .collect::<Vec<_>>();
    let waveform = WaveformData {
        version: 1,
        bins: WAVEFORM_BINS,
        peaks: compute_peaks(&samples, WAVEFORM_BINS),
    };
    let bytes = serde_json::to_vec(&waveform)
        .map_err(|error| CoreError::Artifact(format!("无法序列化波形：{error}")))?;

    let clip_root = cache_root.join(payload.clip_id.to_string());
    std::fs::create_dir_all(&clip_root)?;
    let final_path = clip_root.join(WAVEFORM_FILE);
    let temporary_path = jobs::temporary_output_path(&final_path, job.attempt);
    remove_if_exists(&temporary_path)?;
    write_synced(&temporary_path, &bytes)?;
    let artifacts = [FinalArtifact {
        kind: "waveform",
        file_name: WAVEFORM_FILE,
        temporary_path: &temporary_path,
    }];
    if let Err(error) = finalize_artifacts(connection, job, cache_root, &payload, &artifacts, None) {
        cleanup_temporary_files([&temporary_path]);
        return Err(error);
    }
    Ok(())
}

pub fn run_proxy(connection: &mut Connection, job: &Job, cache_root: &Path) -> Result<()> {
    if super::photo_probe::skip_video_job(connection, job)? { return Ok(()); }
    if !super::settings::proxy_enabled(connection)? {
        return complete_direct(connection, job, &parse_payload(job)?);
    }
    // R17 exportfix:配置的 ffmpeg 缺 VideoToolbox 时改用包内那份(见 settings::export_ffmpeg)。
    let ffmpeg = super::settings::export_ffmpeg(connection)?;
    let ffprobe = super::settings::configured_ffprobe(connection, &ffmpeg)?;
    let low_memory = super::memory_profile::resolve(connection)?.low_memory_proxy();
    run_proxy_with(
        connection,
        job,
        cache_root,
        &ffmpeg,
        &ffprobe,
        PROXY_TIMEOUT,
        low_memory,
    )
}

/// R16 预览策略:≤1080p 的 H.264 8-bit、恒定帧率、码率 ≤ 50 Mbps 的源片**不做**预览小文件——
/// libmpv 的 VideoToolbox 硬解直接播这类文件毫无压力,而 R13 压测里 720p / 1.5 Mbps 的源
/// 转成 540p 代理反而比原片还大(缓存 1.2 GB ≈ 素材 1.3 GB)。只给 4K、HEVC / 10-bit / HDR、
/// 高码率或 VFR 的素材做代理。`clips` 表没有像素格式列,「8-bit」按 `codec = h264 且非 HDR`
/// 判(手机与相机的 H.264 实际上都是 8-bit;High 10 极罕见)。
pub(crate) const DIRECT_PLAY_MAX_EDGE: i64 = 1920;
pub(crate) const DIRECT_PLAY_MAX_BITRATE_BPS: f64 = 50_000_000.0;

fn plays_source_directly(source: &ClipSource) -> bool {
    direct_play_policy(
        source.codec.as_deref(),
        source.width,
        source.height,
        source.hdr,
        source.is_vfr,
        source_bitrate_bps(source.byte_size, source.duration_seconds),
    )
}

/// 纯函数版本,供单测:`codec` 为空(老库没探到)时不敢直接播,照旧做代理。
pub(crate) fn direct_play_policy(
    codec: Option<&str>,
    width: i64,
    height: i64,
    hdr: bool,
    is_vfr: bool,
    bitrate_bps: Option<f64>,
) -> bool {
    codec.is_some_and(|codec| codec.eq_ignore_ascii_case("h264"))
        && !hdr
        && !is_vfr
        && width.max(height) <= DIRECT_PLAY_MAX_EDGE
        && bitrate_bps.is_none_or(|bps| bps <= DIRECT_PLAY_MAX_BITRATE_BPS)
}

/// R16 预览小文件目录上限(字节):设置 `performance.proxy_cache_limit_gb`,默认 10 GiB。
pub fn proxy_cache_limit_bytes(connection: &Connection) -> Result<u64> {
    let gb = super::settings::number_value(
        connection,
        super::settings::PROXY_CACHE_LIMIT_GB_KEY,
        super::settings::DEFAULT_PROXY_CACHE_LIMIT_GB,
    )?;
    Ok((gb.max(1.0) * (1u64 << 30) as f64) as u64)
}

/// 当前预览小文件(`cache_artifacts.kind = 'proxy'`)合计字节数。
pub fn proxy_cache_bytes(connection: &Connection) -> Result<u64> {
    let bytes: i64 = connection.query_row(
        "SELECT COALESCE(SUM(bytes), 0) FROM cache_artifacts WHERE kind = 'proxy'",
        [],
        |row| row.get(0),
    )?;
    Ok(bytes.max(0) as u64)
}

/// 播放器打开一条素材的预览小文件时调:把文件 mtime 顶到现在。LRU 淘汰按这个时间排,
/// 不加表列、不动迁移;文件不在 / 不是代理路径都静默(不影响播放)。
pub fn touch_proxy_played(connection: &Connection, cache_root: &Path, clip_id: i64) {
    let rel_path: Option<String> = connection
        .query_row(
            "SELECT rel_path FROM cache_artifacts WHERE clip_id = ?1 AND kind = 'proxy'",
            [clip_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    let Some(rel_path) = rel_path else {
        return;
    };
    let path = cache_root.join(rel_path);
    if let Ok(file) = std::fs::OpenOptions::new().write(true).open(&path) {
        if let Err(error) = file.set_modified(std::time::SystemTime::now()) {
            tracing::debug!(%error, path = %path.display(), "touch proxy mtime failed");
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ProxyEviction {
    pub removed: usize,
    pub bytes: u64,
}

/// R16 LRU 淘汰:预览小文件合计超过上限时,按「最近播放」(文件 mtime,见
/// `touch_proxy_played`;老库没被 touch 过的就是生成时间)从最久的删起,删到不超限为止。
/// `keep_clip_id` 是刚生成的那条,不参与本轮淘汰。只删代理(封面 / 胶片条 / 波形每条
/// < 200 KB,永不删);删文件 + 删 `cache_artifacts` 行,播放器随即退回直接播原片;
/// **不**回删老库、不重排代理任务——只在超限时动手。
pub fn enforce_proxy_cache_limit(
    connection: &Connection,
    cache_root: &Path,
    keep_clip_id: Option<i64>,
) -> Result<ProxyEviction> {
    let limit = proxy_cache_limit_bytes(connection)?;
    let mut total = proxy_cache_bytes(connection)?;
    let mut report = ProxyEviction::default();
    if total <= limit {
        return Ok(report);
    }
    let mut candidates: Vec<(i64, String, u64, std::time::SystemTime)> = {
        let mut statement = connection.prepare(
            "SELECT clip_id, rel_path, bytes FROM cache_artifacts WHERE kind = 'proxy'",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?.max(0) as u64))
        })?;
        rows.filter_map(|row| row.ok())
            .filter(|(clip_id, _, _)| Some(*clip_id) != keep_clip_id)
            .map(|(clip_id, rel_path, bytes)| {
                let played_at = std::fs::metadata(cache_root.join(&rel_path))
                    .and_then(|metadata| metadata.modified())
                    .unwrap_or(std::time::UNIX_EPOCH);
                (clip_id, rel_path, bytes, played_at)
            })
            .collect()
    };
    candidates.sort_by_key(|(clip_id, _, _, played_at)| (*played_at, *clip_id));
    for (clip_id, rel_path, bytes, _) in candidates {
        if total <= limit {
            break;
        }
        let path = cache_root.join(&rel_path);
        remove_if_exists(&path)?;
        connection.execute(
            "DELETE FROM cache_artifacts WHERE clip_id = ?1 AND kind = 'proxy'",
            [clip_id],
        )?;
        total = total.saturating_sub(bytes);
        report.removed += 1;
        report.bytes += bytes;
    }
    if report.removed > 0 {
        tracing::info!(
            removed = report.removed,
            bytes = report.bytes,
            limit_bytes = limit,
            "预览小文件超过上限,已按最久未播淘汰"
        );
    }
    Ok(report)
}

/// 代理生成前的磁盘水位线:至少 2 GiB,或按源时长 500 KB/s 估算,取更大者。
fn required_proxy_disk_bytes(duration_seconds: f64) -> u64 {
    (2u64 << 30).max((duration_seconds.max(0.0) * 500_000.0) as u64)
}

fn run_proxy_with(
    connection: &mut Connection,
    job: &Job,
    cache_root: &Path,
    ffmpeg: &OsStr,
    ffprobe: &OsStr,
    timeout: Duration,
    low_memory: bool,
) -> Result<()> {
    let payload = parse_payload(job)?;
    let source = validate_source(connection, &payload)?;
    if source.height <= 540 || plays_source_directly(&source) {
        return complete_direct(connection, job, &payload);
    }

    let clip_root = cache_root.join(payload.clip_id.to_string());
    std::fs::create_dir_all(&clip_root)?;

    let needed = required_proxy_disk_bytes(source.duration_seconds);
    if super::doctor::available_bytes(cache_root)? < needed {
        return Err(CoreError::Artifact(format!(
            "缓存磁盘剩余不足（需要约 {} MB），代理生成暂缓；缩略图与分析不受影响",
            needed >> 20
        )));
    }

    let final_path = clip_root.join(PROXY_FILE);
    let temporary_path = jobs::temporary_output_path(&final_path, job.attempt);
    remove_if_exists(&temporary_path)?;

    let source_path = source.path.to_string_lossy();
    // R17 exportfix:按这份 ffmpeg 的编码器能力选 H.264 编码器(没 VT 的 ffmpeg 不认 `-allow_sw`)。
    let encoder = super::media_tools::encoder_caps(ffmpeg).h264_encoder();
    if let Err(error) = run_ffmpeg_file_with_fallback(
        ffmpeg,
        |hardware_decode| {
            proxy_args(
                &source_path,
                &temporary_path,
                hardware_decode,
                low_memory,
                source_bitrate_bps(source.byte_size, source.duration_seconds),
                encoder,
            )
        },
        timeout,
        &temporary_path,
    ) {
        cleanup_temporary_files([&temporary_path]);
        return Err(CoreError::Artifact(format!("代理转码失败；{error}")));
    }

    let proxy_duration_ms = match probe_duration_ms(ffprobe, &temporary_path, timeout) {
        Ok(duration) => duration,
        Err(error) => {
            cleanup_temporary_files([&temporary_path]);
            return Err(error);
        }
    };
    let time_map = super::canonical_time::build_linear_proxy_map(
        source.duration_ticks,
        source.tb_num,
        source.tb_den,
        proxy_duration_ms,
    );

    let artifacts = [FinalArtifact {
        kind: "proxy",
        file_name: PROXY_FILE,
        temporary_path: &temporary_path,
    }];
    if let Err(error) = finalize_artifacts(
        connection,
        job,
        cache_root,
        &payload,
        &artifacts,
        Some(&time_map),
    ) {
        cleanup_temporary_files([&temporary_path]);
        return Err(error);
    }
    // R16:新代理落地后看一眼目录上限,超了就按最久未播淘汰(刚生成的这条不动)。
    if let Err(error) = enforce_proxy_cache_limit(connection, cache_root, Some(payload.clip_id)) {
        tracing::warn!(%error, "预览小文件淘汰失败,本次跳过");
    }
    Ok(())
}

/// ffmpeg's `vf` snippet for a `manual_rotation` value, to be inserted
/// BEFORE any scale so the downscale keeps the post-rotation aspect ratio.
/// `None`/`Some(0)`/anything outside the three real orientations → no
/// filter at all. Must only ever be called with `ClipSource::manual_rotation`
/// — see its doc comment for why the merged `clips.rotation` would double
/// what ffmpeg's own default autorotate already does.
fn rotation_prefix_filter(rotation: Option<i64>) -> Option<&'static str> {
    match rotation {
        Some(90) => Some("transpose=1,"),
        Some(180) => Some("transpose=1,transpose=1,"),
        Some(270) => Some("transpose=2,"),
        _ => None,
    }
}

fn cover_args(
    source: &Path,
    cover_time: f64,
    output: &Path,
    hardware_decode: bool,
    manual_rotation: Option<i64>,
) -> Vec<OsString> {
    let mut args = vec![OsString::from("-hide_banner"), OsString::from("-loglevel"), OsString::from("error")];
    if hardware_decode {
        args.extend(hardware_decode_prefix());
    }
    let rotate_prefix = rotation_prefix_filter(manual_rotation).unwrap_or("");
    args.extend([
        OsString::from("-ss"), OsString::from(format!("{cover_time:.6}")),
        OsString::from("-i"), source.as_os_str().to_owned(),
        OsString::from("-map"), OsString::from("0:v:0"),
        OsString::from("-frames:v"), OsString::from("1"),
        // 先缩到 480 宽再让 thumbnail 在 90 帧里选代表帧:4K 10-bit 下峰值 1.74 GB → 0.81 GB(2026-09-06 实测)
        OsString::from("-vf"), OsString::from(format!("{rotate_prefix}scale=480:-2,thumbnail=90")),
        OsString::from("-c:v"), OsString::from("mjpeg"), OsString::from("-q:v"), OsString::from("3"),
        OsString::from("-f"), OsString::from("image2"), OsString::from("-y"), output.as_os_str().to_owned(),
    ]);
    args
}

/// R7 Task 3:精确到 tick 的单帧抽取——不同于 `cover_args` 的
/// `thumbnail=90`(在 90 帧候选里挑"代表帧"，实际落点飘移)，这里 `-ss`
/// 直接由 `tick / tb_den * tb_num` 换算成秒，取的就是那一帧。用于
/// MiniMax 首尾帧参考图：相邻镜头的确切边界帧，不能有代表帧那种漂移。
pub fn frame_at_tick_args(
    source: &Path,
    tick: i64,
    timebase: (i64, i64),
    output: &Path,
    hardware_decode: bool,
    manual_rotation: Option<i64>,
) -> Vec<OsString> {
    let mut args = vec![OsString::from("-hide_banner"), OsString::from("-loglevel"), OsString::from("error")];
    if hardware_decode {
        args.extend(hardware_decode_prefix());
    }
    let (tb_num, tb_den) = timebase;
    let seconds = tick_to_seconds(tick, tb_num, tb_den);
    args.extend([
        OsString::from("-ss"), OsString::from(format!("{seconds:.6}")),
        OsString::from("-i"), source.as_os_str().to_owned(),
        OsString::from("-map"), OsString::from("0:v:0"),
        OsString::from("-frames:v"), OsString::from("1"),
    ]);
    if let Some(rotate_prefix) = rotation_prefix_filter(manual_rotation) {
        args.extend([
            OsString::from("-vf"),
            OsString::from(rotate_prefix.trim_end_matches(',').to_owned()),
        ]);
    }
    args.extend([
        OsString::from("-c:v"), OsString::from("mjpeg"), OsString::from("-q:v"), OsString::from("3"),
        OsString::from("-f"), OsString::from("image2"), OsString::from("-y"), output.as_os_str().to_owned(),
    ]);
    args
}

/// `tick / tb_den * tb_num`——见 `canonical_time::ticks_to_micros` 的同一换算，
/// 这里只需要秒级精度给 ffmpeg `-ss`，用不到那边的整数微秒防溢出路径。
fn tick_to_seconds(tick: i64, tb_num: i64, tb_den: i64) -> f64 {
    if tb_den <= 0 {
        return 0.0;
    }
    (tick.max(0) as f64) * (tb_num as f64) / (tb_den as f64)
}

/// 精确抽帧的执行入口：硬解带软解回退,镜像 `run_thumbnail_with` 的调用形状。
/// 失败(找不到 ffmpeg、两次解码都失败、输出为空)一律返回 `Err`——调用方
/// (`generation.rs` 的降级链 fl2v → i2v → t2v)据此决定要不要退化模式。
pub fn extract_frame_at_tick(
    ffmpeg: &OsStr,
    source: &Path,
    tick: i64,
    timebase: (i64, i64),
    output: &Path,
    manual_rotation: Option<i64>,
    timeout: Duration,
) -> Result<()> {
    run_ffmpeg_file_with_fallback(
        ffmpeg,
        |hardware_decode| {
            frame_at_tick_args(source, tick, timebase, output, hardware_decode, manual_rotation)
        },
        timeout,
        output,
    )
}

fn strip_args(
    source: &Path,
    duration_seconds: f64,
    frame_count: usize,
    output: &Path,
    hardware_decode: bool,
    keyframes_only: bool,
    manual_rotation: Option<i64>,
) -> Vec<OsString> {
    let mut args = vec![OsString::from("-hide_banner"), OsString::from("-loglevel"), OsString::from("error")];
    let rotate_prefix = rotation_prefix_filter(manual_rotation).unwrap_or("");
    if keyframes_only {
        // R15-perf:长素材不再 `-skip_frame nokey` 从头扫到尾(5 分钟 4K 要解封装 2 GB、解
        // 750 个关键帧,6.8 s),改成每格一个输入各自 `-ss` 直接跳到该格时刻、只解它前面
        // 最近的那个关键帧(`-noaccurate_seek` 保留 seek 落点的关键帧,与 fps 滤镜「取
        // 格点前最后一帧」语义一致),再 hstack 拼条:0.8 s。故意用软解——单个 I 帧软解
        // 几十毫秒,而 N 个输入各开一个 VideoToolbox 会话是 N 份 4K 解码器内存。
        // R16 车道 E:每个输入 `-threads 1`——软解默认按核数开帧线程,12 个输入 × 10 线程
        // 各持一套 4K 10-bit 参考帧,本机实测 3 分钟 4K HEVC10 峰值 RSS 2.17 GB;单线程解
        // 一个 I 帧不需要帧线程,峰值 0.87 GB 且更快(0.52 s → 0.44 s)。所有档位都这么做。
        let _ = hardware_decode;
        let mut filter = String::new();
        let mut labels = String::new();
        for index in 0..frame_count.max(1) {
            let seek = index as f64 * duration_seconds / frame_count.max(1) as f64;
            args.extend([
                OsString::from("-threads"),
                OsString::from("1"),
                OsString::from("-noaccurate_seek"),
                OsString::from("-ss"),
                OsString::from(format!("{seek:.6}")),
                OsString::from("-skip_frame"),
                OsString::from("nokey"),
                OsString::from("-i"),
                source.as_os_str().to_owned(),
            ]);
            filter.push_str(&format!("[{index}:v:0]{rotate_prefix}scale=160:-2[s{index}];"));
            labels.push_str(&format!("[s{index}]"));
        }
        if frame_count > 1 {
            filter.push_str(&format!("{labels}hstack=inputs={frame_count}[strip]"));
        } else {
            filter.push_str("[s0]copy[strip]");
        }
        args.extend([
            OsString::from("-filter_complex"), OsString::from(filter),
            OsString::from("-map"), OsString::from("[strip]"),
            OsString::from("-frames:v"), OsString::from("1"),
            OsString::from("-c:v"), OsString::from("mjpeg"),
            OsString::from("-q:v"), OsString::from("4"),
            OsString::from("-f"), OsString::from("image2"),
            OsString::from("-y"), output.as_os_str().to_owned(),
        ]);
        return args;
    }
    if hardware_decode {
        args.extend(hardware_decode_prefix());
    }
    let strip_filter = format!(
        "fps={frame_count}/{duration_seconds:.6},{rotate_prefix}scale=160:-2,tile={frame_count}x1:padding=0:margin=0"
    );
    args.extend([
        OsString::from("-i"), source.as_os_str().to_owned(),
        OsString::from("-map"), OsString::from("0:v:0"),
        OsString::from("-vf"), OsString::from(strip_filter),
        OsString::from("-frames:v"), OsString::from("1"),
        OsString::from("-c:v"), OsString::from("mjpeg"),
        OsString::from("-q:v"), OsString::from("4"),
        OsString::from("-f"), OsString::from("image2"),
        OsString::from("-y"), output.as_os_str().to_owned(),
    ]);
    args
}

/// 纯封包级探测(不解码):判断关键帧间隔是否够密、够贴近片尾,使
/// `-skip_frame nokey` 配合 `fps=frame_count/duration` 不会在尾部产生黑格。
/// 探测失败(找不到 ffprobe、超时、解析不出任何关键帧)一律返回 false——
/// 拿不到证据就不假设可以跳帧,退回完整解码。
fn keyframe_gaps_allow_skip(
    ffprobe: &OsStr,
    path: &Path,
    duration_seconds: f64,
    frame_count: usize,
) -> bool {
    let args = [
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-select_streams"),
        OsString::from("v:0"),
        OsString::from("-show_entries"),
        OsString::from("packet=pts_time,flags"),
        OsString::from("-of"),
        OsString::from("csv=p=0"),
        path.as_os_str().to_owned(),
    ];
    let Ok(output) = execute_with_timeout(ffprobe, &args, KEYFRAME_PROBE_TIMEOUT) else {
        return false;
    };
    if !output.success {
        return false;
    }
    let Ok(text) = String::from_utf8(output.stdout) else {
        return false;
    };
    let keyframe_pts: Vec<f64> = text
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(2, ',');
            let pts = fields.next()?;
            let flags = fields.next().unwrap_or("");
            if !flags.contains('K') {
                return None;
            }
            pts.trim().parse::<f64>().ok()
        })
        .collect();
    keyframe_gaps_allow_skip_from(&keyframe_pts, duration_seconds, frame_count)
}

/// `keyframe_gaps_allow_skip` 的纯判断部分,独立出来便于用合成关键帧序列单测。
fn keyframe_gaps_allow_skip_from(pts: &[f64], duration_seconds: f64, frame_count: usize) -> bool {
    if frame_count == 0 || duration_seconds <= 0.0 || pts.is_empty() {
        return false;
    }
    let slot = duration_seconds / frame_count as f64;
    let mut sorted = pts.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let max_gap = sorted
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .fold(0.0_f64, f64::max);
    if max_gap > slot {
        return false;
    }
    let tail_gap = duration_seconds - sorted[sorted.len() - 1];
    tail_gap <= slot
}

/// Z-18(R13 压测):213 条 1.3 GB 的 720p / 1.5 Mbps 源生成了 2.7 GB 缓存 —— 代理固定 4M,
/// 比源还高两倍多。代理码率改成「不超过源码率」,下限 1 Mbps(再低画面糊到看不出运镜),
/// 上限仍是原档位(4M / 省内存档 2.5M);源码率未知时保持原值。
const PROXY_BITRATE_FLOOR_BPS: f64 = 1_000_000.0;

fn source_bitrate_bps(byte_size: u64, duration_seconds: f64) -> Option<f64> {
    (byte_size > 0 && duration_seconds > 0.0).then(|| byte_size as f64 * 8.0 / duration_seconds)
}

fn proxy_bitrate(low_memory: bool, source_bitrate: Option<f64>) -> String {
    let ceiling = if low_memory { 2_500_000.0 } else { 4_000_000.0 };
    let target = match source_bitrate {
        Some(bps) => bps.max(PROXY_BITRATE_FLOOR_BPS).min(ceiling),
        None => ceiling,
    };
    format!("{}k", (target / 1_000.0).round() as i64)
}

fn proxy_args(
    source: &str,
    output: &Path,
    hardware_decode: bool,
    low_memory: bool,
    source_bitrate: Option<f64>,
    encoder: super::media_tools::H264Encoder,
) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
    ];
    if hardware_decode {
        args.extend([OsString::from("-hwaccel"), OsString::from("videotoolbox")]);
    } else if low_memory {
        // 省内存档、软解分支:限制 ffmpeg 自身线程数,避免与其它并发工作抢内存/CPU。
        args.extend([OsString::from("-threads"), OsString::from("4")]);
    }
    args.extend([
        OsString::from("-i"),
        source.into(),
        OsString::from("-map"),
        OsString::from("0:v:0"),
        OsString::from("-map"),
        OsString::from("0:a:0?"),
        OsString::from("-vf"),
        OsString::from("scale=-2:540"),
    ]);
    let bitrate = proxy_bitrate(low_memory, source_bitrate);
    if encoder == super::media_tools::H264Encoder::VideoToolbox {
        args.extend([
            OsString::from("-c:v"),
            OsString::from("h264_videotoolbox"),
            OsString::from("-allow_sw"),
            OsString::from("1"),
        ]);
        if low_memory {
            // `-realtime` 是 VT 私有选项,别的编码器不认。
            args.extend([OsString::from("-realtime"), OsString::from("1")]);
        }
        args.extend([OsString::from("-b:v"), OsString::from(bitrate)]);
    } else {
        args.extend(super::media_tools::h264_encoder_args(encoder, &bitrate));
    }
    args.extend([
        OsString::from("-pix_fmt"),
        OsString::from("yuv420p"),
        OsString::from("-fps_mode"),
        OsString::from("cfr"),
        OsString::from("-c:a"),
        OsString::from("aac"),
        OsString::from("-b:a"),
        OsString::from("96k"),
        OsString::from("-movflags"),
        OsString::from("+faststart"),
        OsString::from("-f"),
        OsString::from("mp4"),
        OsString::from("-y"),
        output.as_os_str().to_owned(),
    ]);
    args
}

pub fn compute_peaks(samples: &[i16], bins: usize) -> Vec<[f32; 2]> {
    if bins == 0 {
        return Vec::new();
    }
    if samples.is_empty() {
        return vec![[0.0, 0.0]; bins];
    }

    (0..bins)
        .map(|index| {
            let start = index.saturating_mul(samples.len()) / bins;
            let mut end = (index + 1).saturating_mul(samples.len()) / bins;
            if end <= start {
                end = (start + 1).min(samples.len());
            }
            let window = &samples[start.min(samples.len() - 1)..end.max(1)];
            let minimum = *window.iter().min().unwrap_or(&0);
            let maximum = *window.iter().max().unwrap_or(&0);
            [normalize_sample(minimum), normalize_sample(maximum)]
        })
        .collect()
}

fn normalize_sample(sample: i16) -> f32 {
    if sample < 0 {
        f32::from(sample) / 32_768.0
    } else {
        f32::from(sample) / 32_767.0
    }
}

pub(crate) fn strip_frame_count(duration_seconds: f64) -> usize {
    ((duration_seconds.max(0.0) / 5.0).ceil() as usize).clamp(1, 12)
}

fn parse_payload(job: &Job) -> Result<ArtifactJobPayload> {
    serde_json::from_str(&job.payload)
        .map_err(|error| CoreError::Artifact(format!("缓存任务数据无效：{error}")))
}

fn validate_source(connection: &Connection, payload: &ArtifactJobPayload) -> Result<ClipSource> {
    let path = super::media_source::verified_clip_path(connection, payload.clip_id)
        .map_err(|error| CoreError::Artifact(error.to_string()))?;

    let source = connection
        .query_row(
            "SELECT duration_ticks, tb_num, tb_den, height, manual_rotation, byte_size,
                    COALESCE(width, 0), codec, COALESCE(hdr_flag, 0), COALESCE(is_vfr, 0)
             FROM clips WHERE id = ?1 AND quick_hash = ?2",
            params![payload.clip_id, payload.source_hash],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| {
            CoreError::Artifact(format!(
                "素材 {} 已变化或不存在，缓存任务作废",
                payload.clip_id
            ))
        })?;
    if source.1 <= 0 || source.2 <= 0 || source.0 <= 0 || source.3 <= 0 {
        return Err(CoreError::Artifact(format!(
            "素材 {} 的时长或尺寸无效",
            payload.clip_id
        )));
    }
    Ok(ClipSource {
        path,
        duration_seconds: source.0 as f64 * source.1 as f64 / source.2 as f64,
        byte_size: source.5.unwrap_or(0).max(0) as u64,
        duration_ticks: source.0,
        tb_num: source.1,
        tb_den: source.2,
        height: source.3,
        width: source.6,
        codec: source.7,
        hdr: source.8 != 0,
        is_vfr: source.9 != 0,
        manual_rotation: source.4,
    })
}

fn finalize_artifacts(
    connection: &mut Connection,
    job: &Job,
    cache_root: &Path,
    payload: &ArtifactJobPayload,
    artifacts: &[FinalArtifact<'_>],
    proxy_time_map: Option<&[super::canonical_time::ProxyTimePoint]>,
) -> Result<()> {
    for artifact in artifacts {
        let metadata = std::fs::metadata(artifact.temporary_path)?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(CoreError::Artifact(format!(
                "{} 产物为空",
                artifact.file_name
            )));
        }
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let source_is_current = transaction
        .query_row(
            "SELECT 1 FROM clips WHERE id = ?1 AND quick_hash = ?2",
            params![payload.clip_id, payload.source_hash],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !source_is_current {
        return Err(CoreError::Artifact(format!(
            "素材 {} 在产物完成前已变化",
            payload.clip_id
        )));
    }
    let is_current_attempt = transaction
        .query_row(
            "SELECT 1 FROM jobs
             WHERE id = ?1 AND status = 'running' AND attempt = ?2",
            params![job.id, job.attempt],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !is_current_attempt {
        return Err(CoreError::InvalidTransition(format!(
            "job {} attempt {} is not running",
            job.id, job.attempt
        )));
    }

    let mut first_result = None;
    for artifact in artifacts {
        let relative_path = artifact_relative_path(payload.clip_id, artifact.file_name);
        let final_path = cache_root.join(&relative_path);
        std::fs::rename(artifact.temporary_path, &final_path)?;
        let bytes = std::fs::metadata(&final_path)?.len() as i64;
        transaction.execute(
            "INSERT INTO cache_artifacts(
                clip_id, kind, rel_path, source_hash, bytes, created_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             )
             ON CONFLICT(clip_id, kind) DO UPDATE SET
                rel_path = excluded.rel_path,
                source_hash = excluded.source_hash,
                bytes = excluded.bytes,
                created_at = excluded.created_at",
            params![
                payload.clip_id,
                artifact.kind,
                path_to_rel_string(&relative_path),
                payload.source_hash,
                bytes,
            ],
        )?;
        first_result.get_or_insert(final_path);
    }

    if let Some(points) = proxy_time_map {
        if points.len() < 2 {
            return Err(CoreError::Artifact(format!(
                "素材 {} 的代理时间映射点不足",
                payload.clip_id
            )));
        }
        transaction.execute(
            "DELETE FROM proxy_time_map WHERE clip_id = ?1",
            [payload.clip_id],
        )?;
        for point in points {
            transaction.execute(
                "INSERT INTO proxy_time_map(clip_id, proxy_ts_ms, source_ticks)
                 VALUES (?1, ?2, ?3)",
                params![payload.clip_id, point.proxy_ts_ms, point.source_ticks],
            )?;
        }
    }

    let result_path = first_result
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned());
    let changed = transaction.execute(
        "UPDATE jobs
         SET status = 'done', result_path = ?3, blocked_summary = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND status = 'running' AND attempt = ?2",
        params![job.id, job.attempt, result_path],
    )?;
    if changed != 1 {
        return Err(CoreError::InvalidTransition(format!(
            "job {} attempt {} changed during artifact finalization",
            job.id, job.attempt
        )));
    }
    transaction.commit()?;
    Ok(())
}

fn complete_direct(
    connection: &mut Connection,
    job: &Job,
    payload: &ArtifactJobPayload,
) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let timing = transaction
        .query_row(
            "SELECT duration_ticks, tb_num, tb_den FROM clips
             WHERE id = ?1 AND quick_hash = ?2",
            params![payload.clip_id, payload.source_hash],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| {
            CoreError::InvalidTransition(format!(
                "proxy job {} attempt {} is stale",
                job.id, job.attempt
            ))
        })?;
    let time_map = super::canonical_time::build_identity_proxy_map(timing.0, timing.1, timing.2);
    if time_map.len() < 2 {
        return Err(CoreError::Artifact(format!(
            "素材 {} 的 direct 代理时间映射点不足",
            payload.clip_id
        )));
    }
    transaction.execute("DELETE FROM proxy_time_map WHERE clip_id = ?1", [payload.clip_id])?;
    for point in time_map {
        transaction.execute(
            "INSERT INTO proxy_time_map(clip_id, proxy_ts_ms, source_ticks)
             VALUES (?1, ?2, ?3)",
            params![payload.clip_id, point.proxy_ts_ms, point.source_ticks],
        )?;
    }
    let changed = transaction.execute(
        "UPDATE jobs
         SET status = 'done', result_path = 'direct', blocked_summary = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND status = 'running' AND attempt = ?2
           AND EXISTS (
             SELECT 1 FROM clips WHERE id = ?3 AND quick_hash = ?4
           )",
        params![job.id, job.attempt, payload.clip_id, payload.source_hash],
    )?;
    if changed != 1 {
        return Err(CoreError::InvalidTransition(format!(
            "proxy job {} attempt {} is stale",
            job.id, job.attempt
        )));
    }
    transaction.commit()?;
    Ok(())
}

fn probe_duration_ms(ffprobe: &OsStr, path: &Path, timeout: Duration) -> Result<i64> {
    let args = [
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-select_streams"),
        OsString::from("v:0"),
        OsString::from("-show_entries"),
        OsString::from("stream=duration:format=duration"),
        OsString::from("-of"),
        OsString::from("json"),
        path.as_os_str().to_owned(),
    ];
    let output = execute_with_timeout(ffprobe, &args, timeout).map_err(|error| {
        CoreError::Artifact(format!("ffprobe 无法读取代理时长 {}：{error}", path.display()))
    })?;
    if !output.success {
        return Err(CoreError::Artifact(format!(
            "ffprobe 代理时间映射探测失败（退出码 {}）：{}",
            output
                .code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal".to_owned()),
            stderr_summary(&output.stderr)
        )));
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| CoreError::Artifact(format!("代理 ffprobe JSON 无效：{error}")))?;
    let duration = value
        .get("streams")
        .and_then(serde_json::Value::as_array)
        .and_then(|streams| streams.first())
        .and_then(|stream| stream.get("duration"))
        .or_else(|| value.get("format").and_then(|format| format.get("duration")))
        .and_then(serde_json::Value::as_str)
        .and_then(decimal_seconds_to_ms)
        .filter(|duration| *duration > 0)
        .ok_or_else(|| CoreError::Artifact("代理 ffprobe 输出缺少有效时长".to_owned()))?;
    Ok(duration)
}

fn decimal_seconds_to_ms(value: &str) -> Option<i64> {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    let whole = whole.parse::<i128>().ok()?;
    let fraction = fraction.as_bytes();
    let mut milliseconds = 0_i128;
    for index in 0..3 {
        milliseconds *= 10;
        if let Some(byte) = fraction.get(index) {
            if !(*byte).is_ascii_digit() {
                return None;
            }
            milliseconds += i128::from(*byte - b'0');
        }
    }
    let rounded = if fraction.get(3).is_some_and(|byte| *byte >= b'5' && *byte <= b'9') {
        1
    } else {
        0
    };
    i64::try_from(whole.checked_mul(1_000)?.checked_add(milliseconds + rounded)?).ok()
}

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

fn run_ffmpeg_file(
    ffmpeg: &OsStr,
    args: &[OsString],
    timeout: Duration,
    output_path: &Path,
) -> Result<()> {
    let output = execute_with_timeout(ffmpeg, args, timeout).map_err(|error| {
        CoreError::Artifact(format!(
            "找不到或无法运行 ffmpeg（可设置 FFMPEG_PATH）：{error}"
        ))
    })?;
    if !output.success {
        return Err(ffmpeg_failure("产物", &output));
    }
    let file = File::open(output_path)?;
    file.sync_all()?;
    let length = file.metadata()?.len();
    if length == 0 {
        return Err(CoreError::Artifact("ffmpeg 生成了空文件".to_owned()));
    }
    Ok(())
}

fn execute_with_timeout(
    executable: &OsStr,
    args: &[OsString],
    timeout: Duration,
) -> std::io::Result<CommandOutput> {
    let mut child = Command::new(executable)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = thread::spawn(move || read_pipe(stdout));
    let stderr_reader = thread::spawn(move || read_pipe(stderr));
    let started = Instant::now();

    let status = loop {
        if super::jobs::current_cancellation_requested() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "用户已取消",
            ));
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("命令超过 {} 秒未完成", timeout.as_secs()),
            ));
        }
        thread::sleep(Duration::from_millis(20));
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| std::io::Error::other("stdout reader thread panicked"))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| std::io::Error::other("stderr reader thread panicked"))??;
    Ok(CommandOutput {
        success: status.success(),
        code: status.code(),
        stdout,
        stderr,
    })
}

fn read_pipe<R: Read>(pipe: Option<R>) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    if let Some(mut pipe) = pipe {
        pipe.read_to_end(&mut bytes)?;
    }
    Ok(bytes)
}

fn ffmpeg_failure(label: &str, output: &CommandOutput) -> CoreError {
    CoreError::Artifact(format!(
        "ffmpeg {label}失败（退出码 {}）：{}",
        output
            .code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "signal".to_owned()),
        stderr_summary(&output.stderr)
    ))
}

fn stderr_summary(stderr: &[u8]) -> String {
    const MAX_LENGTH: usize = 1_024;
    let text = String::from_utf8_lossy(stderr);
    let summary: String = text
        .trim()
        .replace(['\r', '\n'], " ")
        .chars()
        .take(MAX_LENGTH)
        .collect();
    if summary.is_empty() {
        "没有错误输出".to_owned()
    } else {
        summary
    }
}

fn stderr_means_no_audio(stderr: &[u8]) -> bool {
    let text = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    text.contains("does not contain any stream")
        || text.contains("matches no streams")
        || text.contains("stream map '0:a:0?' matches no streams")
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn remove_if_exists(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn cleanup_temporary_files<'a>(paths: impl IntoIterator<Item = &'a PathBuf>) {
    for path in paths {
        let _ = std::fs::remove_file(path);
    }
}

pub(crate) fn artifact_relative_path(clip_id: i64, file_name: &str) -> PathBuf {
    PathBuf::from(clip_id.to_string()).join(file_name)
}

fn path_to_rel_string(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn cache_url(port: u16, token: &str, clip_id: i64, file_name: &str) -> Result<String> {
    super::media_server::signed_cache_url(port, token, clip_id, file_name)
}

pub fn cover_urls(
    connection: &Connection,
    cache_root: &Path,
    port: u16,
    token: &str,
) -> Result<HashMap<i64, String>> {
    let mut statement = connection.prepare(
        "SELECT cache_artifacts.clip_id, cache_artifacts.rel_path
         FROM cache_artifacts
         JOIN clips ON clips.id = cache_artifacts.clip_id
         WHERE cache_artifacts.kind = 'cover'
           AND cache_artifacts.source_hash = clips.quick_hash",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut urls = HashMap::new();
    for row in rows {
        let (clip_id, rel_path) = row?;
        let expected = artifact_relative_path(clip_id, COVER_FILE);
        if rel_path == path_to_rel_string(&expected) && cache_root.join(expected).is_file() {
            urls.insert(clip_id, cache_url(port, token, clip_id, COVER_FILE)?);
        }
    }
    Ok(urls)
}

pub fn get_clip_artifacts(
    connection: &mut Connection,
    cache_root: &Path,
    port: u16,
    token: &str,
    clip_id: i64,
) -> Result<ClipArtifacts> {
    let source_hash = connection
        .query_row(
            "SELECT quick_hash FROM clips WHERE id = ?1",
            [clip_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .ok_or_else(|| CoreError::Artifact(format!("素材 {clip_id} 不存在或尚未完成导入")))?;

    let cover = valid_artifact_url(
        connection,
        cache_root,
        port,
        token,
        clip_id,
        &source_hash,
        "cover",
        COVER_FILE,
    )?;
    let strip = valid_artifact_url(
        connection,
        cache_root,
        port,
        token,
        clip_id,
        &source_hash,
        "strip",
        STRIP_FILE,
    )?;
    let proxy = valid_artifact_url(
        connection,
        cache_root,
        port,
        token,
        clip_id,
        &source_hash,
        "proxy",
        PROXY_FILE,
    )?;
    let waveform = valid_artifact_url(
        connection,
        cache_root,
        port,
        token,
        clip_id,
        &source_hash,
        "waveform",
        WAVEFORM_FILE,
    )?;

    let thumbnail_job = latest_job(connection, "thumbnail", clip_id, &source_hash)?;
    // R6 Task 7d/F-R1-8:封面(thumbnail)与胶片条(strip)是两个独立任务了——
    // 各自的产物状态必须看各自的任务行,不能再借 thumbnail_job 兜底 strip。
    // 封面还没做完(strip 任务还没被排上队)时 `strip_job` 是 `None`,
    // `snapshot_status` 会如实报 `Missing`,不再谎报"胶片条也在排队/在跑"。
    let strip_job = latest_job(connection, "strip", clip_id, &source_hash)?;
    let waveform_job = latest_job(connection, "waveform", clip_id, &source_hash)?;
    let proxy_job = latest_job(connection, "proxy", clip_id, &source_hash)?;

    let thumbnail_job = requeue_if_cache_missing(connection, thumbnail_job, cover.is_none())?;
    let strip_job = requeue_if_cache_missing(connection, strip_job, strip.is_none())?;
    let waveform_job =
        requeue_if_cache_missing(connection, waveform_job, waveform.is_none())?;
    let proxy_enabled = super::settings::proxy_enabled(connection)?;
    let proxy_direct = !proxy_enabled || proxy_job
        .as_ref()
        .is_some_and(|job| job.status == "done" && job.result_path.as_deref() == Some("direct"));
    let proxy_job = requeue_if_cache_missing(
        connection,
        proxy_job,
        proxy_enabled && proxy.is_none() && !proxy_direct,
    )?;

    Ok(ClipArtifacts {
        statuses: ArtifactStatuses {
            cover: if cover.is_some() {
                ArtifactStatus::Ready
            } else {
                snapshot_status(thumbnail_job.as_ref(), false)
            },
            strip: if strip.is_some() {
                ArtifactStatus::Ready
            } else {
                snapshot_status(strip_job.as_ref(), false)
            },
            proxy: if proxy.is_some() {
                ArtifactStatus::Ready
            } else {
                snapshot_status(proxy_job.as_ref(), proxy_direct)
            },
            waveform: if waveform.is_some() {
                ArtifactStatus::Ready
            } else {
                snapshot_status(waveform_job.as_ref(), false)
            },
        },
        cover,
        strip,
        proxy,
        waveform,
    })
}

#[allow(clippy::too_many_arguments)]
fn valid_artifact_url(
    connection: &mut Connection,
    cache_root: &Path,
    port: u16,
    token: &str,
    clip_id: i64,
    source_hash: &str,
    kind: &str,
    file_name: &str,
) -> Result<Option<String>> {
    let rel_path = connection
        .query_row(
            "SELECT rel_path FROM cache_artifacts
             WHERE clip_id = ?1 AND kind = ?2 AND source_hash = ?3",
            params![clip_id, kind, source_hash],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(rel_path) = rel_path else {
        return Ok(None);
    };
    let expected = artifact_relative_path(clip_id, file_name);
    if rel_path == path_to_rel_string(&expected) && cache_root.join(&expected).is_file() {
        return Ok(Some(cache_url(port, token, clip_id, file_name)?));
    }
    connection.execute(
        "DELETE FROM cache_artifacts WHERE clip_id = ?1 AND kind = ?2",
        params![clip_id, kind],
    )?;
    Ok(None)
}

fn latest_job(
    connection: &Connection,
    kind: &str,
    clip_id: i64,
    source_hash: &str,
) -> Result<Option<JobSnapshot>> {
    let mut statement = connection.prepare(
        "SELECT id, status, result_path, payload
         FROM jobs WHERE kind = ?1 ORDER BY id DESC",
    )?;
    let rows = statement.query_map([kind], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    for row in rows {
        let (id, status, result_path, payload_json) = row?;
        let Ok(payload) = serde_json::from_str::<ArtifactJobPayload>(&payload_json) else {
            continue;
        };
        if payload.clip_id == clip_id && payload.source_hash == source_hash {
            return Ok(Some(JobSnapshot {
                id,
                status,
                result_path,
            }));
        }
    }
    Ok(None)
}

fn requeue_if_cache_missing(
    connection: &mut Connection,
    snapshot: Option<JobSnapshot>,
    cache_missing: bool,
) -> Result<Option<JobSnapshot>> {
    let Some(mut snapshot) = snapshot else {
        return Ok(None);
    };
    if cache_missing && snapshot.status == "done" {
        connection.execute(
            "UPDATE jobs
             SET status = 'pending', attempt = 0, result_path = NULL,
                 blocked_summary = NULL, finished_at = NULL,
                 next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1 AND status = 'done'",
            [snapshot.id],
        )?;
        snapshot.status = "pending".to_owned();
        snapshot.result_path = None;
    }
    Ok(Some(snapshot))
}

fn snapshot_status(snapshot: Option<&JobSnapshot>, direct: bool) -> ArtifactStatus {
    if direct {
        return ArtifactStatus::Direct;
    }
    match snapshot.map(|snapshot| snapshot.status.as_str()) {
        Some("pending") => ArtifactStatus::Pending,
        Some("running") => ArtifactStatus::Running,
        Some("failed" | "blocked") => ArtifactStatus::Failed,
        Some("done") => ArtifactStatus::Missing,
        _ => ArtifactStatus::Missing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::media_tools::H264Encoder;
    use crate::core::{db, test_support::TestDirectory};

    fn test_ffmpeg() -> OsString {
        let connection = Connection::open_in_memory().unwrap();
        super::super::settings::configured_executable(
            &connection,
            super::super::settings::FFMPEG_PATH_KEY,
            "FFMPEG_PATH",
            "ffmpeg",
        )
        .unwrap()
    }

    fn insert_source(
        connection: &Connection,
        path: &Path,
        height: i64,
    ) -> (i64, String) {
        let (source_hash, bytes) = crate::core::import::quick_fingerprint(path).unwrap();
        connection
            .execute("INSERT INTO volumes(uuid) VALUES ('artifact-test-volume')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(
                    volume_uuid, rel_path, byte_size, quick_hash,
                    tb_num, tb_den, duration_ticks, width, height
                 ) VALUES (
                    'artifact-test-volume', ?1, ?2, ?3,
                    1, 1000, 2000, 1280, ?4
                 )",
                params![path.to_string_lossy(), bytes as i64, source_hash, height],
            )
            .unwrap();
        (connection.last_insert_rowid(), source_hash)
    }

    #[test]
    fn peak_calculation_is_fixed_length_and_normalized() {
        let peaks = compute_peaks(&[i16::MIN, -1, 1, i16::MAX], 2_000);
        assert_eq!(peaks.len(), 2_000);
        assert!(peaks.iter().all(|peak| peak[0] >= -1.0 && peak[1] <= 1.0));
        assert!(peaks.iter().any(|peak| peak[0] == -1.0));
        assert!(peaks.iter().any(|peak| peak[1] == 1.0));
    }

    #[test]
    fn strip_frame_count_follows_five_second_rule_and_twelve_frame_cap() {
        assert_eq!(strip_frame_count(0.1), 1);
        assert_eq!(strip_frame_count(30.0), 6);
        assert_eq!(strip_frame_count(600.0), 12);
    }

    /// R6 Task 7d/F-R1-8:同一 clip/source_hash 重复调用 `enqueue_strip`(用户
    /// 重跑、或补队清扫器都可能重入)在 pending 期间只留一行——`mig0040` 的
    /// 部分唯一索引 + `ON CONFLICT DO NOTHING` 是并发下的真正兜底,这里先证
    /// 明单线程调两次也不重复。
    #[test]
    fn enqueue_strip_twice_while_pending_leaves_a_single_row() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"source bytes").unwrap();
        let (clip_id, source_hash) = insert_source(&connection, &source, 720);
        let payload = ArtifactJobPayload {
            clip_id,
            path: source.to_string_lossy().into_owned(),
            source_hash,
        };

        enqueue_strip(&mut connection, &payload).unwrap();
        enqueue_strip(&mut connection, &payload).unwrap();

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM jobs WHERE kind = 'strip'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "重复入队不该在 pending 期间产生第二行 strip");
    }

    fn insert_cover_artifact(connection: &Connection, clip_id: i64, source_hash: &str) {
        connection
            .execute(
                "INSERT INTO cache_artifacts(clip_id, kind, rel_path, source_hash, bytes, created_at)
                 VALUES (?1, 'cover', ?2, ?3, 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                params![clip_id, format!("{clip_id}/cover.jpg"), source_hash],
            )
            .unwrap();
    }

    fn insert_strip_artifact(connection: &Connection, clip_id: i64, source_hash: &str) {
        connection
            .execute(
                "INSERT INTO cache_artifacts(clip_id, kind, rel_path, source_hash, bytes, created_at)
                 VALUES (?1, 'strip', ?2, ?3, 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                params![clip_id, format!("{clip_id}/strip.jpg"), source_hash],
            )
            .unwrap();
    }

    /// R6 Task 7d 修复 Blocker/High:进程在 `finalize_artifacts`(封面已落盘)
    /// 和 `enqueue_strip`(胶片条任务入队)之间死掉——封面产物在,胶片条产物
    /// 和任务都不在——此前没有任何重试路径能补上,clip 永久卡住。
    #[test]
    fn enqueue_missing_strips_enqueues_for_cover_without_strip_or_job() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"source bytes").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let (clip_id, source_hash) = insert_source(&connection, &source, 720);
        insert_cover_artifact(&connection, clip_id, &source_hash);

        let enqueued = enqueue_missing_strips(&mut connection).unwrap();
        assert_eq!(enqueued, 1, "有封面无胶片条也无任务的 clip 应补入队一条 strip");

        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM jobs WHERE kind = 'strip' AND status = 'pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn enqueue_missing_strips_is_idempotent_across_repeated_sweeps() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"source bytes").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let (clip_id, source_hash) = insert_source(&connection, &source, 720);
        insert_cover_artifact(&connection, clip_id, &source_hash);

        let first = enqueue_missing_strips(&mut connection).unwrap();
        let second = enqueue_missing_strips(&mut connection).unwrap();
        assert_eq!(first, 1);
        assert_eq!(second, 0, "已经有 pending strip 任务后,再扫一遍不该重复入队");

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM jobs WHERE kind = 'strip'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "两次补扫合计只应该留下一条 strip 任务");
    }

    #[test]
    fn enqueue_missing_strips_skips_clips_that_already_have_a_strip_artifact() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"source bytes").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let (clip_id, source_hash) = insert_source(&connection, &source, 720);
        insert_cover_artifact(&connection, clip_id, &source_hash);
        insert_strip_artifact(&connection, clip_id, &source_hash);

        let enqueued = enqueue_missing_strips(&mut connection).unwrap();
        assert_eq!(enqueued, 0, "已有胶片条产物的 clip 不该被补扫入队");

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM jobs WHERE kind = 'strip'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn repeated_enqueue_does_not_duplicate_same_source_jobs() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"source bytes").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let (clip_id, source_hash) = insert_source(&connection, &source, 720);

        enqueue_for_clip(&mut connection, clip_id, &source, &source_hash).unwrap();
        enqueue_for_clip(&mut connection, clip_id, &source, &source_hash).unwrap();

        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM jobs
                 WHERE kind IN ('thumbnail', 'waveform', 'proxy')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 3);
    }

    /// R16 预览策略:≤1080p H.264 8-bit CFR、码率 ≤ 50 Mbps 直接播原片;4K / HEVC / HDR / VFR /
    /// 高码率 / 编码未知都照旧做代理。竖拍 1080×1920 算 1080p,竖拍 4K(2160×3840)算 4K。
    #[test]
    fn direct_play_policy_skips_proxy_only_for_plain_h264_up_to_1080p() {
        let mbps = |value: f64| Some(value * 1_000_000.0);
        assert!(direct_play_policy(Some("h264"), 1920, 1080, false, false, mbps(12.0)));
        assert!(direct_play_policy(Some("H264"), 1080, 1920, false, false, mbps(12.0)));
        assert!(direct_play_policy(Some("h264"), 1280, 720, false, false, None));
        assert!(!direct_play_policy(Some("h264"), 3840, 2160, false, false, mbps(12.0)));
        assert!(!direct_play_policy(Some("h264"), 2160, 3840, false, false, mbps(12.0)));
        assert!(!direct_play_policy(Some("hevc"), 1920, 1080, false, false, mbps(12.0)));
        assert!(!direct_play_policy(Some("h264"), 1920, 1080, true, false, mbps(12.0)));
        assert!(!direct_play_policy(Some("h264"), 1920, 1080, false, true, mbps(12.0)));
        assert!(!direct_play_policy(Some("h264"), 1920, 1080, false, false, mbps(80.0)));
        assert!(!direct_play_policy(None, 1920, 1080, false, false, mbps(12.0)));
    }

    /// R16:1080p H.264 源片的 proxy 任务不起 ffmpeg,直接以 `direct` 完成(时间映射为恒等)。
    #[test]
    fn plain_1080p_h264_source_completes_proxy_job_directly_without_ffmpeg() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"source bytes").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let (clip_id, source_hash) = insert_source(&connection, &source, 1080);
        connection
            .execute("UPDATE clips SET width = 1920, codec = 'h264' WHERE id = ?1", [clip_id])
            .unwrap();
        let payload = serde_json::to_string(&ArtifactJobPayload {
            clip_id,
            path: source.to_string_lossy().into_owned(),
            source_hash,
        })
        .unwrap();
        jobs::enqueue(&mut connection, "proxy", &payload, "direct-1080p").unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        // 指向一个不存在的 ffmpeg:真去转码就会报错。
        let missing = directory.path().join("no-such-ffmpeg");
        run_proxy_with(
            &mut connection,
            &job,
            &directory.path().join("cache"),
            missing.as_os_str(),
            missing.as_os_str(),
            Duration::from_secs(2),
            false,
        )
        .unwrap();
        assert_eq!(jobs::get(&connection, job.id).unwrap().result_path.as_deref(), Some("direct"));
        let proxies: i64 = connection
            .query_row("SELECT COUNT(*) FROM cache_artifacts WHERE kind = 'proxy'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(proxies, 0);
    }

    fn insert_proxy_row(connection: &Connection, cache_root: &Path, clip_id: i64, bytes: usize, age_secs: u64) {
        connection
            .execute(
                "INSERT INTO clips(id, rel_path, quick_hash) VALUES (?1, ?2, ?3)",
                params![clip_id, format!("clip-{clip_id}.mov"), format!("hash-{clip_id}")],
            )
            .unwrap();
        let rel_path = format!("{clip_id}/{PROXY_FILE}");
        let path = cache_root.join(&rel_path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, vec![0_u8; bytes]).unwrap();
        let played_at = std::time::SystemTime::now() - Duration::from_secs(age_secs);
        std::fs::OpenOptions::new().write(true).open(&path).unwrap().set_modified(played_at).unwrap();
        connection
            .execute(
                "INSERT INTO cache_artifacts(clip_id, kind, rel_path, source_hash, bytes, created_at)
                 VALUES (?1, 'proxy', ?2, ?3, ?4, 'now')",
                params![clip_id, rel_path, format!("hash-{clip_id}"), bytes as i64],
            )
            .unwrap();
    }

    /// R16 LRU:上限 1 GB 时三条各 500 MB(登记字节数)的代理超限,删最久未播的那条(clip 2,
    /// 3 小时前),刚生成的 keep 那条(clip 1,最老但被保护)不动,最近播过的(clip 3)也不动;
    /// 不超限时什么都不删。
    #[test]
    fn proxy_cache_limit_evicts_least_recently_played_first_and_keeps_the_new_one() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let cache_root = directory.path().join("cache");
        let half_gb = 512 * 1024 * 1024_usize;
        // 文件本身只写 16 字节,登记字节数按 512 MB 算(淘汰只看登记数)。
        insert_proxy_row(&connection, &cache_root, 1, 16, 4 * 3600);
        insert_proxy_row(&connection, &cache_root, 2, 16, 3 * 3600);
        insert_proxy_row(&connection, &cache_root, 3, 16, 60);
        connection
            .execute("UPDATE cache_artifacts SET bytes = ?1", [half_gb as i64])
            .unwrap();
        super::super::settings::set_setting(&connection, super::super::settings::PROXY_CACHE_LIMIT_GB_KEY, "1").unwrap();

        let report = enforce_proxy_cache_limit(&connection, &cache_root, Some(1)).unwrap();
        assert_eq!(report, ProxyEviction { removed: 1, bytes: half_gb as u64 });
        let remaining: Vec<i64> = connection
            .prepare("SELECT clip_id FROM cache_artifacts WHERE kind = 'proxy' ORDER BY clip_id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(remaining, vec![1, 3]);
        assert!(!cache_root.join(format!("2/{PROXY_FILE}")).exists());
        assert!(cache_root.join(format!("1/{PROXY_FILE}")).exists());
        assert_eq!(proxy_cache_bytes(&connection).unwrap(), 2 * half_gb as u64);

        // 现在 1 GB = 上限,不超限:不再删。
        let report = enforce_proxy_cache_limit(&connection, &cache_root, None).unwrap();
        assert_eq!(report, ProxyEviction::default());

        // 播放 clip 1 之后它成了最近播过的;上限降到 0.5 GB 再淘汰,删的是 clip 3。
        touch_proxy_played(&connection, &cache_root, 1);
        super::super::settings::set_setting(&connection, super::super::settings::PROXY_CACHE_LIMIT_GB_KEY, "1").unwrap();
        connection
            .execute("UPDATE cache_artifacts SET bytes = ?1", [(half_gb + 1) as i64])
            .unwrap();
        let report = enforce_proxy_cache_limit(&connection, &cache_root, None).unwrap();
        assert_eq!(report.removed, 1);
        let remaining: Vec<i64> = connection
            .prepare("SELECT clip_id FROM cache_artifacts WHERE kind = 'proxy'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(remaining, vec![1]);
    }

    #[test]
    fn disabled_proxy_encoding_still_enqueues_identity_mapping_job() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"source bytes").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let (clip_id, source_hash) = insert_source(&connection, &source, 480);
        super::super::settings::set_setting(
            &connection,
            super::super::settings::PROXY_ENABLED_KEY,
            "false",
        )
        .unwrap();

        enqueue_for_clip(&mut connection, clip_id, &source, &source_hash).unwrap();

        let proxy_job_id: i64 = connection
            .query_row(
                "SELECT id FROM jobs WHERE kind = 'proxy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        connection
            .execute(
                "UPDATE jobs SET status = 'running', attempt = 1 WHERE id = ?1",
                [proxy_job_id],
            )
            .unwrap();
        let job = jobs::get(&connection, proxy_job_id).unwrap();

        run_proxy(&mut connection, &job, directory.path()).unwrap();

        let mapped: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM proxy_time_map WHERE clip_id = ?1",
                [clip_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(mapped >= 2);
        assert_eq!(
            jobs::get(&connection, proxy_job_id)
                .unwrap()
                .result_path
                .as_deref(),
            Some("direct")
        );
    }

    #[cfg(unix)]
    #[test]
    fn failed_proxy_process_never_promotes_half_written_temporary_file() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"source bytes").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let (clip_id, source_hash) = insert_source(&connection, &source, 720);
        let payload = serde_json::to_string(&ArtifactJobPayload {
            clip_id,
            path: source.to_string_lossy().into_owned(),
            source_hash,
        })
        .unwrap();
        jobs::enqueue(&mut connection, "proxy", &payload, "partial-proxy").unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();

        let fake_ffmpeg = directory.path().join("fake-ffmpeg");
        std::fs::write(
            &fake_ffmpeg,
            "#!/bin/sh\nfor output_path do :; done\nprintf partial > \"$output_path\"\nexit 9\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&fake_ffmpeg).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fake_ffmpeg, permissions).unwrap();

        let cache_root = directory.path().join("cache");
        let error = run_proxy_with(
            &mut connection,
            &job,
            &cache_root,
            fake_ffmpeg.as_os_str(),
            fake_ffmpeg.as_os_str(),
            Duration::from_secs(2),
            false,
        )
        .unwrap_err();
        let final_path = cache_root.join(format!("{clip_id}/{PROXY_FILE}"));
        let temporary_path = jobs::temporary_output_path(&final_path, job.attempt);

        assert!(error.to_string().contains("代理转码失败"));
        assert!(error.to_string().contains("VideoToolbox 硬解"));
        assert!(error.to_string().contains("CPU 解码"));
        assert!(!error.to_string().contains("libx264"));
        assert!(!final_path.exists());
        assert!(!temporary_path.exists());
    }

    /// 用 hdiutil 建的小型 APFS 卷,供磁盘水位测试当 cache_root。
    /// Drop 里做 detach + 删除 dmg,即便测试 panic 也会跑,避免卷残留。
    #[cfg(unix)]
    struct DmgVolume {
        dmg_path: PathBuf,
        mount_point: PathBuf,
    }

    #[cfg(unix)]
    impl DmgVolume {
        fn create_1gb() -> Option<Self> {
            let name = format!("tripcut-perftest-{}", uuid::Uuid::new_v4().simple());
            let dmg_path = std::env::temp_dir().join(format!("{name}.dmg"));
            let created = Command::new("hdiutil")
                .args([
                    "create",
                    "-size",
                    "1g",
                    "-fs",
                    "APFS",
                    "-volname",
                    &name,
                    "-ov",
                    dmg_path.to_str()?,
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .ok()?;
            if !created.success() {
                return None;
            }
            let mount_point = PathBuf::from(format!("/Volumes/{name}"));
            let attached = Command::new("hdiutil")
                .args(["attach", dmg_path.to_str()?, "-nobrowse", "-quiet"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .ok()?;
            if !attached.success() {
                let _ = std::fs::remove_file(&dmg_path);
                return None;
            }
            Some(Self { dmg_path, mount_point })
        }
    }

    #[cfg(unix)]
    impl Drop for DmgVolume {
        fn drop(&mut self) {
            let _ = Command::new("hdiutil")
                .args(["detach", &self.mount_point.to_string_lossy(), "-quiet", "-force"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let _ = std::fs::remove_file(&self.dmg_path);
        }
    }

    #[cfg(unix)]
    #[test]
    fn run_proxy_with_refuses_when_cache_disk_is_low_on_space() {
        // 建 1 GB 小卷当 cache_root:水位线是 max(2 GiB, 时长估算),1 GB 必然不够,
        // 这样测的是真实 statvfs 读数,不是打桩。若环境不允许建磁盘映像就跳过。
        let Some(volume) = DmgVolume::create_1gb() else {
            eprintln!("跳过:此环境不允许创建 hdiutil 磁盘映像");
            return;
        };

        let directory = TestDirectory::new();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"source bytes").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let (clip_id, source_hash) = insert_source(&connection, &source, 720);
        let payload = serde_json::to_string(&ArtifactJobPayload {
            clip_id,
            path: source.to_string_lossy().into_owned(),
            source_hash,
        })
        .unwrap();
        jobs::enqueue(&mut connection, "proxy", &payload, "low-disk-proxy").unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();

        let error = run_proxy_with(
            &mut connection,
            &job,
            &volume.mount_point,
            OsStr::new("/usr/bin/true"),
            OsStr::new("/usr/bin/true"),
            Duration::from_secs(5),
            false,
        )
        .unwrap_err();

        assert!(error.to_string().contains("缓存磁盘剩余不足"));
    }

    #[test]
    fn proxy_uses_cpu_decode_fallback_but_only_the_bundled_videotoolbox_encoder() {
        let hardware = proxy_args("source.mov", Path::new("proxy.mp4"), true, false, None, H264Encoder::VideoToolbox);
        let software = proxy_args("source.mov", Path::new("proxy.mp4"), false, false, None, H264Encoder::VideoToolbox);
        let hardware = hardware
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        let software = software
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(hardware.contains("-hwaccel videotoolbox"));
        assert!(!software.contains("-hwaccel"));
        for args in [&hardware, &software] {
            assert!(args.contains("h264_videotoolbox"));
            assert!(args.contains("-allow_sw 1"));
            assert!(args.contains("-b:v 4000k"), "{args}");
            assert!(!args.contains("libx264"));
            assert!(!args.contains("-realtime"));
        }
    }

    /// R17 exportfix:代理转码同样按编码器能力选 —— 没 VT 的 ffmpeg 不发 `-allow_sw` / `-realtime`。
    #[test]
    fn proxy_args_follow_encoder_caps_without_videotoolbox_private_options() {
        let x264 = proxy_args("source.mov", Path::new("proxy.mp4"), false, true, None, H264Encoder::X264);
        let x264 = x264.iter().map(|value| value.to_string_lossy()).collect::<Vec<_>>().join(" ");
        assert!(x264.contains("-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p"), "{x264}");
        assert!(!x264.contains("allow_sw") && !x264.contains("-realtime") && !x264.contains("-b:v"), "{x264}");
        let mpeg4 = proxy_args("source.mov", Path::new("proxy.mp4"), true, false, None, H264Encoder::Mpeg4Fallback);
        let mpeg4 = mpeg4.iter().map(|value| value.to_string_lossy()).collect::<Vec<_>>().join(" ");
        assert!(mpeg4.contains("-c:v mpeg4 -q:v 2 -pix_fmt yuv420p"), "{mpeg4}");
        assert!(!mpeg4.contains("videotoolbox -allow_sw"), "{mpeg4}");
    }

    #[test]
    fn proxy_args_low_memory_caps_bitrate_and_forces_realtime() {
        let hardware = proxy_args("source.mov", Path::new("proxy.mp4"), true, true, None, H264Encoder::VideoToolbox);
        let software = proxy_args("source.mov", Path::new("proxy.mp4"), false, true, None, H264Encoder::VideoToolbox);
        let hardware = hardware
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        let software = software
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        for args in [&hardware, &software] {
            assert!(args.contains("-b:v 2500k"), "{args}");
            assert!(args.contains("h264_videotoolbox -allow_sw 1 -realtime 1"));
        }
        // 软解 + 省内存档才限制 ffmpeg 自身线程数;硬解分支不需要。
        assert!(!hardware.contains("-threads 4"));
        assert!(software.contains("-threads 4 -i"));
    }

    /// Z-18(R13 压测):代理码率不超过源码率 —— 1.5 Mbps 的 720p 源不再生成 4M 的代理。
    #[test]
    fn proxy_bitrate_never_exceeds_the_source_bitrate() {
        // 30 s × 1.5 Mbps = 5.625 MB
        let low = source_bitrate_bps(5_625_000, 30.0);
        assert_eq!(proxy_bitrate(false, low), "1500k");
        assert_eq!(proxy_bitrate(true, low), "1500k");
        // 很低的源:下限 1 Mbps
        assert_eq!(proxy_bitrate(false, source_bitrate_bps(1_000_000, 30.0)), "1000k");
        // 高码率源:顶到原档位
        assert_eq!(proxy_bitrate(false, source_bitrate_bps(150_000_000, 30.0)), "4000k");
        assert_eq!(proxy_bitrate(true, source_bitrate_bps(150_000_000, 30.0)), "2500k");
        // 未知:原值
        assert_eq!(source_bitrate_bps(0, 30.0), None);
        assert_eq!(proxy_bitrate(false, None), "4000k");
        let args = proxy_args("source.mov", Path::new("proxy.mp4"), true, false, low, H264Encoder::VideoToolbox)
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(args.contains("-b:v 1500k"), "{args}");
    }

    /// 显示 LUT（`lut3d`）是播放器预览专用的 `vf` 滤镜(见
    /// `player::mpv_calls_for`),绝不应该出现在代理生成里——代理是给
    /// 剪辑/导出用的中间产物,烧录预览 LUT 会让色彩不可逆地污染下游。
    /// 钉住这条负向断言,防止未来有人为了"预览一致"顺手把 LUT 接进代理管线。
    #[test]
    fn proxy_args_never_carries_the_preview_display_lut() {
        for hardware_decode in [true, false] {
            for low_memory in [true, false] {
                let args = proxy_args("source.mov", Path::new("proxy.mp4"), hardware_decode, low_memory, None, H264Encoder::VideoToolbox);
                let joined = args
                    .iter()
                    .map(|value| value.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join(" ");
                assert!(!joined.contains("lut3d"), "proxy_args 不应包含 lut3d：{joined}");
                assert!(!joined.contains("tripcut-lut"), "proxy_args 不应包含 LUT 滤镜标签：{joined}");
            }
        }
    }

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

    #[test]
    fn fallback_runner_reports_both_errors_when_hardware_and_software_both_fail() {
        // 硬解、软解都指向不存在的输入:两条路径都会失败,合并报错必须两半都在,
        // 否则用户只看到"CPU 解码"那一半,分不清是不是硬解也试过了。
        let directory = TestDirectory::new();
        let output = directory.path().join("out.txt");
        let build = |_hardware: bool| {
            vec![
                OsString::from("-i"),
                OsString::from("/nonexistent-both-fail.mp4"),
                OsString::from("-f"),
                OsString::from("null"),
                OsString::from("-"),
            ]
        };
        let error = run_ffmpeg_file_with_fallback(
            test_ffmpeg().as_os_str(),
            build,
            Duration::from_secs(10),
            &output,
        )
        .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("VideoToolbox 硬解"));
        assert!(message.contains("CPU 解码"));
    }

    #[test]
    fn cover_filter_scales_before_thumbnail_and_prefers_hardware_decode() {
        let args = cover_args(Path::new("/x.mp4"), 1.0, Path::new("/tmp/c.jpg"), true, None);
        let joined = args.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
        assert!(joined.contains("-hwaccel videotoolbox -ss"));
        assert!(joined.contains("-vf scale=480:-2,thumbnail=90"));
        let software = cover_args(Path::new("/x.mp4"), 1.0, Path::new("/tmp/c.jpg"), false, None);
        assert!(!software.iter().any(|a| a == "-hwaccel"));
    }

    #[test]
    fn strip_args_use_hardware_decode_and_keyframes_only_for_long_clips() {
        let short = strip_args(Path::new("/x.mp4"), 30.0, 6, Path::new("/tmp/s.jpg"), true, false, None);
        let long = strip_args(Path::new("/x.mp4"), 300.0, 12, Path::new("/tmp/s.jpg"), true, true, None);
        let j = |v: &Vec<OsString>| v.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
        assert!(j(&short).contains("-hwaccel videotoolbox"));
        assert!(!j(&short).contains("-skip_frame"));
        assert!(j(&short).contains("fps=6/30.000000,scale=160:-2,tile=6x1"));
        // R15-perf:长素材每格一个输入各自 seek 到格点、只解最近的关键帧,软解(见 strip_args 注释)。
        assert!(j(&long).contains("-skip_frame nokey"));
        assert!(!j(&long).contains("-hwaccel"), "{}", j(&long));
        assert_eq!(long.iter().filter(|a| *a == "-i").count(), 12);
        // R16:每个输入单线程软解(12 输入 × 默认帧线程曾把 4K HEVC10 的峰值 RSS 推到 2.17 GB)。
        assert!(j(&long).contains("-threads 1 -noaccurate_seek -ss 0.000000 -skip_frame nokey -i /x.mp4"));
        assert!(j(&long).contains("-threads 1 -noaccurate_seek -ss 25.000000 -skip_frame nokey -i /x.mp4"));
        assert!(j(&long).contains("-threads 1 -noaccurate_seek -ss 275.000000 -skip_frame nokey -i /x.mp4"));
        assert_eq!(long.iter().filter(|a| *a == "-threads").count(), 12);
        assert!(!j(&long).contains("-ss 300.000000"), "格点是 k×duration/N,不含片尾");
        assert!(j(&long).contains("[11:v:0]scale=160:-2[s11];[s0][s1][s2][s3][s4][s5][s6][s7][s8][s9][s10][s11]hstack=inputs=12[strip]"), "{}", j(&long));
        assert!(j(&long).contains("-map [strip] -frames:v 1 -c:v mjpeg -q:v 4 -f image2 -y /tmp/s.jpg"));
        assert!(!j(&long).contains("tile="));
    }

    #[test]
    fn keyframe_seek_strip_rotates_every_cell_before_scaling() {
        let args = strip_args(Path::new("/x.mp4"), 300.0, 12, Path::new("/tmp/s.jpg"), true, true, Some(90));
        let joined = args.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
        assert_eq!(joined.matches("transpose=1,scale=160:-2").count(), 12, "{joined}");
        let plain = strip_args(Path::new("/x.mp4"), 300.0, 12, Path::new("/tmp/s.jpg"), true, true, None);
        assert!(!plain.iter().any(|a| a.to_string_lossy().contains("transpose")));
    }

    /// 真 ffmpeg:关键帧 seek 拼出来的胶片条与 fps 滤镜整段扫出来的尺寸一致(12 格 × 160 宽)。
    #[test]
    fn keyframe_seek_strip_produces_the_same_geometry_as_the_full_scan() {
        let ffmpeg = test_ffmpeg();
        if Command::new(&ffmpeg).arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| !s.success()).unwrap_or(true) {
            return;
        }
        let directory = TestDirectory::new();
        let source = directory.path().join("long.mp4");
        let generated = Command::new(&ffmpeg)
            .args(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=10:d=65", "-g", "10", "-c:v", "mpeg4", "-q:v", "4"])
            .arg(&source)
            .status()
            .is_ok_and(|status| status.success());
        if !generated {
            return;
        }
        let seek_out = directory.path().join("seek.jpg");
        let scan_out = directory.path().join("scan.jpg");
        for (keyframes_only, out) in [(true, &seek_out), (false, &scan_out)] {
            let args = strip_args(&source, 65.0, 12, out, false, keyframes_only, None);
            let status = Command::new(&ffmpeg).args(&args).stdin(Stdio::null()).status().unwrap();
            assert!(status.success(), "keyframes_only={keyframes_only}");
        }
        let connection = Connection::open_in_memory().unwrap();
        let ffprobe = super::super::settings::configured_ffprobe(&connection, &ffmpeg).unwrap();
        let size = |path: &Path| {
            let output = Command::new(&ffprobe)
                .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0"])
                .arg(path)
                .output()
                .unwrap();
            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        };
        assert_eq!(size(&seek_out), "1920,90");
        assert_eq!(size(&seek_out), size(&scan_out));
    }

    #[test]
    fn cover_args_inserts_transpose_before_scale_only_for_manual_rotation() {
        let j = |rotation| {
            let args = cover_args(Path::new("/x.mp4"), 1.0, Path::new("/tmp/c.jpg"), false, rotation);
            args.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ")
        };
        assert!(j(Some(90)).contains("-vf transpose=1,scale=480:-2,thumbnail=90"));
        assert!(j(Some(270)).contains("-vf transpose=2,scale=480:-2,thumbnail=90"));
        assert!(j(Some(180)).contains("-vf transpose=1,transpose=1,scale=480:-2,thumbnail=90"));
        // None (the common side_data-sourced case, already handled by
        // ffmpeg's own default autorotate) and 0 must NOT get a transpose —
        // that would double-rotate an already-correctly-oriented decode.
        assert!(j(None).contains("-vf scale=480:-2,thumbnail=90"));
        assert!(j(Some(0)).contains("-vf scale=480:-2,thumbnail=90"));
    }

    #[test]
    fn strip_args_inserts_transpose_before_scale_only_for_manual_rotation() {
        let j = |rotation| {
            let args = strip_args(Path::new("/x.mp4"), 30.0, 6, Path::new("/tmp/s.jpg"), false, false, rotation);
            args.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ")
        };
        assert!(j(Some(90)).contains(",transpose=1,scale=160:-2,"));
        assert!(j(None).contains(",scale=160:-2,"));
        assert!(!j(None).contains("transpose"));
    }

    #[test]
    fn proxy_args_signature_cannot_take_a_rotation_and_is_unaffected_by_it() {
        // Decision: the proxy is played back through mpv, which already
        // rotates side_data-sourced clips on its own by default, and for the
        // tag-only case the player applies `video-rotate` directly to
        // whatever file it opens (proxy or original) — so proxy generation
        // itself must never bake in a rotation. `proxy_args` simply has no
        // rotation parameter, which makes this structurally true; this test
        // pins that its output is identical across calls (nothing snuck in).
        let first = proxy_args("/x.mp4", Path::new("/tmp/p.mp4"), false, false, None, H264Encoder::VideoToolbox);
        let second = proxy_args("/x.mp4", Path::new("/tmp/p.mp4"), false, false, None, H264Encoder::VideoToolbox);
        assert_eq!(first, second);
        assert!(!first.iter().any(|a| a.to_string_lossy().contains("transpose")));
    }

    #[test]
    fn frame_at_tick_args_seeks_by_ticks_not_by_thumbnail_filter() {
        // 24000/1001 timebase(常见 23.976 fps 情形的 tb_num/tb_den 记法),
        // tick=48048 → 48048*1001/24000 = 2004.002 秒。
        let args = frame_at_tick_args(
            Path::new("/x.mp4"),
            48_048,
            (1001, 24_000),
            Path::new("/tmp/f.jpg"),
            true,
            None,
        );
        let joined = args.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
        assert!(joined.contains("-hwaccel videotoolbox"));
        assert!(joined.contains("-ss 2004.002000"));
        assert!(joined.contains("-frames:v 1"));
        assert!(!joined.contains("thumbnail="));

        let software = frame_at_tick_args(
            Path::new("/x.mp4"),
            48_048,
            (1001, 24_000),
            Path::new("/tmp/f.jpg"),
            false,
            None,
        );
        assert!(!software.iter().any(|a| a == "-hwaccel"));

        let rotated = frame_at_tick_args(
            Path::new("/x.mp4"),
            0,
            (1, 30),
            Path::new("/tmp/f.jpg"),
            false,
            Some(90),
        );
        let rotated_joined = rotated.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
        assert!(rotated_joined.contains("-vf transpose=1"));
    }

    #[test]
    fn extract_frame_at_tick_falls_back_to_software_on_hardware_failure() {
        // ffmpeg 可执行文件本身不存在:硬解与软解两次都失败,必须合并报错而不是 panic。
        let temp_dir = std::env::temp_dir().join(format!(
            "tripcut-frame-at-tick-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let output = temp_dir.join("out.jpg");
        let result = extract_frame_at_tick(
            OsStr::new("/nonexistent/ffmpeg-does-not-exist"),
            Path::new("/x.mp4"),
            0,
            (1, 30),
            &output,
            None,
            Duration::from_secs(1),
        );
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn keyframe_gaps_allow_skip_when_dense_and_close_to_tail() {
        // 90s、frame_count=12 → slot=7.5s;关键帧每 5s 一个,最后一个离片尾 5s。
        let duration = 90.0;
        let frame_count = 12;
        let pts: Vec<f64> = (0..18).map(|index| index as f64 * 5.0).collect(); // 0..=85
        assert!(keyframe_gaps_allow_skip_from(&pts, duration, frame_count));
    }

    #[test]
    fn keyframe_gaps_allow_skip_false_on_one_wide_gap() {
        // 同样的 slot=7.5s,但 10s 和 30s 之间有一段 20s 的关键帧空档。
        let duration = 90.0;
        let frame_count = 12;
        let mut pts = vec![0.0, 5.0, 10.0, 30.0];
        pts.extend((35..90).step_by(5).map(|value| value as f64));
        assert!(!keyframe_gaps_allow_skip_from(&pts, duration, frame_count));
    }

    #[test]
    fn keyframe_gaps_allow_skip_false_when_last_keyframe_far_from_tail() {
        // 关键帧本身很密,但最后一个离片尾还有 10s(> 7.5s slot)——
        // fps=N/duration 的时间轴会跑到关键帧覆盖不到的地方。
        let duration = 90.0;
        let frame_count = 12;
        let pts: Vec<f64> = (0..17).map(|index| index as f64 * 5.0).collect(); // 0..=80
        assert!(!keyframe_gaps_allow_skip_from(&pts, duration, frame_count));
    }

    #[test]
    fn keyframe_gaps_allow_skip_probe_returns_false_when_ffprobe_unavailable() {
        // 探测失败(可执行文件不存在)必须保守地拒绝跳帧,不能假设可以跳。
        assert!(!keyframe_gaps_allow_skip(
            OsStr::new("/nonexistent-ffprobe-binary"),
            Path::new("/nonexistent-input.mp4"),
            90.0,
            12,
        ));
    }
}
