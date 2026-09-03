use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use walkdir::{DirEntry, WalkDir};

use super::analysis::{self, ClipAnalysis};
use super::error::{CoreError, Result};
use super::jobs::Job;
use super::motion::ClipMotion;

const QUICK_HASH_CHUNK_SIZE: u64 = 4 * 1024 * 1024;
const FFPROBE_TIMEOUT: Duration = Duration::from_secs(30);
const TOOL_CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const VIDEO_EXTENSIONS: &[&str] = &[
    "3gp", "avi", "insv", "m2ts", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "mts",
    "webm",
];
const PACKAGE_EXTENSIONS: &[&str] = &[
    "app",
    "bundle",
    "fcplibrary",
    "framework",
    "imovielibrary",
    "pages",
    "photolibrary",
    "photoslibrary",
    "plugin",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ImportStart {
    pub folder: String,
    pub total: u64,
    pub enqueued: u64,
    pub skipped: u64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
pub struct ImportProgress {
    pub total: u64,
    pub done: u64,
    pub failed: u64,
    pub running: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClipListItem {
    pub id: Option<i64>,
    pub episode_id: Option<i64>,
    pub folder_label: Option<String>,
    pub path: String,
    pub file_name: String,
    pub byte_size: Option<i64>,
    pub quick_hash: Option<String>,
    pub full_hash: Option<String>,
    pub tb_num: Option<i64>,
    pub tb_den: Option<i64>,
    pub duration_ticks: Option<i64>,
    pub fps_num: Option<i64>,
    pub fps_den: Option<i64>,
    pub is_vfr: bool,
    pub codec: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub captured_at: Option<String>,
    pub audio_sample_rate: Option<i64>,
    pub rotation: Option<i64>,
    pub color_transfer: Option<String>,
    pub hdr_flag: bool,
    pub tz_guess: Option<String>,
    pub tz_conflict: bool,
    pub device_model: Option<String>,
    pub journey_offset_ms: i64,
    pub cover_url: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub analysis: Option<ClipAnalysis>,
    pub analysis_status: Option<String>,
    pub analysis_error: Option<String>,
    pub motion: Option<ClipMotion>,
    pub motion_status: Option<String>,
    pub motion_error: Option<String>,
    pub binary_rating: Option<i64>,
    pub star_rating: Option<i64>,
    pub select_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ImportPayload {
    path: String,
    episode_id: i64,
    #[serde(default)]
    folder_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FullHashPayload {
    clip_id: i64,
    path: String,
    quick_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MetadataBackfillPayload {
    clip_id: i64,
    quick_hash: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProbeMetadata {
    pub container: Option<String>,
    pub codec: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub tb_num: i64,
    pub tb_den: i64,
    pub duration_ticks: i64,
    pub fps_num: i64,
    pub fps_den: i64,
    pub is_vfr: bool,
    pub captured_at: Option<String>,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub audio_sample_rate: Option<i64>,
    pub rotation: Option<i64>,
    pub color_transfer: Option<String>,
    pub hdr_flag: bool,
    pub tz_guess: Option<String>,
    pub tz_conflict: bool,
    pub device_model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VolumeIdentity {
    uuid: String,
    label: Option<String>,
    fs_type: Option<String>,
    mount_point: Option<PathBuf>,
}

#[derive(Debug)]
pub enum ImportProbeOutcome {
    Imported,
    Duplicate(PathBuf),
}

struct CommandOutput {
    success: bool,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

struct FrameTimingProbe {
    is_vfr: bool,
    samples: Vec<super::canonical_time::VfrTimePoint>,
}

pub fn scan_video_files(root: &Path) -> Result<Vec<PathBuf>> {
    if !root.is_dir() {
        return Err(CoreError::Import(format!(
            "导入路径不是文件夹：{}",
            root.display()
        )));
    }

    let mut files = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| should_visit_entry(entry, root))
    {
        let entry = entry.map_err(|error| CoreError::Import(error.to_string()))?;
        if entry.file_type().is_file() && is_supported_video(entry.path()) {
            files.push(entry.into_path());
        }
    }
    files.sort();
    Ok(files)
}

fn should_visit_entry(entry: &DirEntry, root: &Path) -> bool {
    if entry.path() == root {
        return true;
    }
    let hidden = entry
        .file_name()
        .to_str()
        .is_some_and(|name| name.starts_with('.'));
    if hidden {
        return false;
    }
    if entry.file_type().is_dir() {
        return entry
            .path()
            .extension()
            .and_then(OsStr::to_str)
            .map(|extension| !PACKAGE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
            .unwrap_or(true);
    }
    true
}

fn is_supported_video(path: &Path) -> bool {
    // TypeScript declaration modules use the valid-looking `.d.mts` suffix.
    // Treating those text files as MPEG transport streams creates noisy import
    // failures when a user chooses a broad working folder.
    if path
        .file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name.to_ascii_lowercase().ends_with(".d.mts"))
    {
        return false;
    }
    path.extension()
        .and_then(OsStr::to_str)
        .map(|extension| VIDEO_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn quick_fingerprint(path: &Path) -> Result<(String, u64)> {
    let mut file = File::open(path)?;
    let byte_size = file.metadata()?.len();
    let chunk_length = byte_size.min(QUICK_HASH_CHUNK_SIZE) as usize;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0_u8; chunk_length];

    file.read_exact(&mut buffer)?;
    hasher.update(&buffer);

    if super::jobs::current_cancellation_requested() {
        return Err(CoreError::Import("用户已取消".to_owned()));
    }

    file.seek(SeekFrom::Start(byte_size.saturating_sub(QUICK_HASH_CHUNK_SIZE)))?;
    file.read_exact(&mut buffer)?;
    hasher.update(&buffer);
    hasher.update(&byte_size.to_le_bytes());

    Ok((hasher.finalize().to_hex().to_string(), byte_size))
}

pub fn full_fingerprint(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        if super::jobs::current_cancellation_requested() {
            return Err(CoreError::Import("用户已取消".to_owned()));
        }
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}


#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct WatchedFolder {
    pub id: i64,
    pub path: String,
    pub auto_sync: bool,
    pub added_at: String,
    pub last_scan_at: Option<String>,
}

pub fn list_watched_folders(connection: &Connection) -> Result<Vec<WatchedFolder>> {
    let mut statement = connection.prepare(
        "SELECT id, path, auto_sync, added_at, last_scan_at FROM watched_folders ORDER BY id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(WatchedFolder {
            id: row.get(0)?,
            path: row.get(1)?,
            auto_sync: row.get::<_, i64>(2)? == 1,
            added_at: row.get(3)?,
            last_scan_at: row.get(4)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

pub fn set_watched_folder_sync(connection: &Connection, id: i64, auto_sync: bool) -> Result<()> {
    connection.execute(
        "UPDATE watched_folders SET auto_sync = ?1 WHERE id = ?2",
        params![auto_sync as i64, id],
    )?;
    Ok(())
}

pub fn remove_watched_folder(connection: &Connection, id: i64) -> Result<()> {
    connection.execute("DELETE FROM watched_folders WHERE id = ?1", [id])?;
    Ok(())
}

/// 对全部 auto_sync 的关注文件夹做一轮增量扫描(导入幂等:重复文件被去重)。
/// NAS/云盘轮询式同步的执行体;返回新入队任务数。
#[derive(Debug, Clone, Copy, serde::Serialize, PartialEq, Eq)]
pub struct RescanOutcome {
    /// 新入队的导入任务数
    pub enqueued: u64,
    /// 因目录不存在/未挂载而跳过的关注文件夹数(NAS 断线常见)
    pub unavailable: u64,
    /// 实际扫描过的关注文件夹数
    pub scanned: u64,
}

pub fn rescan_watched_folders(connection: &mut Connection) -> Result<RescanOutcome> {
    let folders = list_watched_folders(connection)?
        .into_iter()
        .filter(|folder| folder.auto_sync)
        .collect::<Vec<_>>();
    let mut enqueued = 0;
    let mut unavailable = 0;
    let mut scanned = 0;
    for folder in folders {
        let path = PathBuf::from(&folder.path);
        if !path.is_dir() {
            // NAS 掉线/未挂载:跳过本轮,不报错不移除,但必须让调用方知道
            // ——否则 UI 会把「没扫成」显示成「没有新素材」。
            unavailable += 1;
            continue;
        }
        scanned += 1;
        match start_import(connection, &path) {
            Ok(outcome) => enqueued += outcome.enqueued,
            Err(error) => {
                tracing::warn!(%error, folder = %folder.path, "watched folder rescan failed");
                continue;
            }
        }
        connection.execute(
            "UPDATE watched_folders SET last_scan_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE id = ?1",
            [folder.id],
        )?;
    }
    Ok(RescanOutcome { enqueued, unavailable, scanned })
}

pub fn start_import(connection: &mut Connection, folder: &Path) -> Result<ImportStart> {
    let root = folder.canonicalize().map_err(|error| {
        CoreError::Import(format!("无法打开导入文件夹 {}：{error}", folder.display()))
    })?;
    // 记为关注文件夹(NAS/云盘工作流:后台增量同步的扫描根)。
    connection.execute(
        "INSERT INTO watched_folders(path, auto_sync, added_at)
         VALUES (?1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(path) DO NOTHING",
        [root.to_string_lossy().as_ref()],
    )?;
    let files = scan_video_files(&root)?;
    // 相对根目录的第一级子文件夹名 = 用户的分类,自动落为素材文件夹标签。
    let labeled = files
        .into_iter()
        .map(|file| {
            let label = file
                .strip_prefix(&root)
                .ok()
                .and_then(|relative| relative.components().next())
                .and_then(|component| match component {
                    std::path::Component::Normal(name) => {
                        let name = name.to_string_lossy().into_owned();
                        // 文件直接在根目录下时第一个 component 是文件名,不当作分类
                        if file.parent() == Some(root.as_path()) { None } else { Some(name) }
                    }
                    _ => None,
                });
            (file, label)
        })
        .collect::<Vec<_>>();
    enqueue_labeled_files(connection, root.to_string_lossy().into_owned(), labeled)
}

pub fn start_import_files(connection: &mut Connection, paths: &[PathBuf]) -> Result<ImportStart> {
    let mut files = Vec::with_capacity(paths.len());
    for path in paths {
        let canonical = path.canonicalize().map_err(|error| {
            CoreError::Import(format!("无法打开导入文件 {}：{error}", path.display()))
        })?;
        if !canonical.is_file() || !is_supported_video(&canonical) {
            return Err(CoreError::Import(format!(
                "导入路径不是支持的视频文件：{}",
                canonical.display()
            )));
        }
        files.push(canonical);
    }
    files.sort();
    files.dedup();
    enqueue_import_files(connection, "<explicit-files>".to_owned(), files)
}

fn enqueue_import_files(
    connection: &mut Connection,
    source: String,
    files: Vec<PathBuf>,
) -> Result<ImportStart> {
    let labeled = files.into_iter().map(|file| (file, None)).collect();
    enqueue_labeled_files(connection, source, labeled)
}

fn enqueue_labeled_files(
    connection: &mut Connection,
    source: String,
    files: Vec<(PathBuf, Option<String>)>,
) -> Result<ImportStart> {
    let ffprobe = super::settings::configured_executable(
        connection,
        super::settings::FFPROBE_PATH_KEY,
        "FFPROBE_PATH",
        "ffprobe",
    )?;
    validate_ffprobe(&ffprobe)?;
    let episode_id: i64 = connection
        .query_row(
            "SELECT id FROM episodes WHERE status = 'active'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| CoreError::Import("没有进行中的 Episode，无法导入素材".to_owned()))?;
    let mut enqueued = 0_u64;
    let mut skipped = 0_u64;
    // A watched folder outlives an Episode. Resolve its volume once so a new
    // Episode does not enqueue every already-owned path again and turn normal
    // cross-Episode history into visible import failures on relaunch.
    let source_volume = Path::new(&source)
        .is_absolute()
        .then(|| volume_identity(Path::new(&source)));

    for (path, folder_label) in &files {
        let volume = source_volume
            .clone()
            .unwrap_or_else(|| volume_identity(path));
        let rel_path = relative_path(path, volume.mount_point.as_deref());
        let existing_owner = connection
            .query_row(
                "SELECT episode_id FROM clips WHERE volume_uuid = ?1 AND rel_path = ?2",
                params![volume.uuid, rel_path],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()?
            .flatten();
        if existing_owner.is_some_and(|owner| owner != episode_id) {
            skipped += 1;
            continue;
        }
        let payload = ImportPayload {
            path: path.to_string_lossy().into_owned(),
            episode_id,
            folder_label: folder_label.clone(),
        };
        let payload_json = serde_json::to_string(&payload)
            .map_err(|error| CoreError::Import(format!("无法创建导入任务：{error}")))?;
        // 去重键纳入文件大小与修改时间:只按路径去重会让 NAS/相机的「同名覆盖」
        // 与「失败后修好重扫」永远返回 enqueued=0（回归修复）。
        // 内容真变了 → 键变 → 重新入队;真正的重复导入仍会被 quick_hash 在 probe 阶段拦掉。
        let identity = std::fs::metadata(path)
            .ok()
            .map(|meta| {
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|delta| delta.as_secs())
                    .unwrap_or(0);
                format!("{}:{}", meta.len(), mtime)
            })
            .unwrap_or_else(|| "unknown".to_owned());
        let payload_hash = hash_text(&format!(
            "import_probe\0{}\0{identity}\0episode:{}",
            payload.path, payload.episode_id
        ));
        if enqueue_unique(connection, "import_probe", &payload_json, &payload_hash)?.is_some() {
            enqueued += 1;
        } else {
            skipped += 1;
        }
    }

    Ok(ImportStart {
        folder: source,
        total: files.len() as u64,
        enqueued,
        skipped,
    })
}

fn enqueue_unique(
    connection: &mut Connection,
    kind: &str,
    payload: &str,
    payload_hash: &str,
) -> Result<Option<i64>> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing = transaction
        .query_row(
            "SELECT id FROM jobs WHERE kind = ?1 AND payload_hash = ?2 LIMIT 1",
            params![kind, payload_hash],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if existing.is_some() {
        transaction.commit()?;
        return Ok(None);
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
        params![kind, payload, payload_hash],
    )?;
    let id = transaction.last_insert_rowid();
    transaction.commit()?;
    Ok(Some(id))
}

pub fn run_import_probe(
    connection: &mut Connection,
    job: &Job,
) -> Result<ImportProbeOutcome> {
    let ffprobe = super::settings::configured_executable(
        connection,
        super::settings::FFPROBE_PATH_KEY,
        "FFPROBE_PATH",
        "ffprobe",
    )?;
    run_import_probe_with(connection, job, &ffprobe, FFPROBE_TIMEOUT)
}

fn run_import_probe_with(
    connection: &mut Connection,
    job: &Job,
    ffprobe: &OsStr,
    timeout: Duration,
) -> Result<ImportProbeOutcome> {
    let payload: ImportPayload = serde_json::from_str(&job.payload)
        .map_err(|error| CoreError::Import(format!("导入任务数据无效：{error}")))?;
    ensure_import_episode_active(connection, payload.episode_id)?;
    let path = PathBuf::from(&payload.path);
    let (quick_hash, byte_size) = quick_fingerprint(&path)?;
    let volume = volume_identity(&path);
    let rel_path = relative_path(&path, volume.mount_point.as_deref());

    let duplicate_id = connection
        .query_row(
            "SELECT id FROM clips
             WHERE quick_hash = ?1 AND byte_size = ?2
               AND NOT (volume_uuid = ?3 AND rel_path = ?4)
             LIMIT 1",
            params![quick_hash, byte_size as i64, volume.uuid, rel_path],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if let Some(existing_id) = duplicate_id {
        // 同指纹不一定是重复:用户在子文件夹间整理素材(NAS 常见工作流)时,
        // 旧路径已不存在,这是「移动」而非「复制」——应更新归属而不是丢弃。
        let old_location: Option<(String, String)> = connection
            .query_row(
                "SELECT volume_uuid, rel_path FROM clips WHERE id = ?1",
                [existing_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        // rel_path 对内置卷就是绝对路径;外置卷缺挂载点时保守视为「仍存在」不动它。
        let old_path_gone = old_location
            .as_ref()
            .map(|(_, old_rel)| {
                let old_full = PathBuf::from(old_rel);
                old_full.is_absolute() && !old_full.is_file()
            })
            .unwrap_or(false);
        if old_path_gone {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            ensure_import_episode_active(&transaction, payload.episode_id)?;
            let existing_owner: Option<i64> = transaction.query_row(
                "SELECT episode_id FROM clips WHERE id = ?1",
                [existing_id],
                |row| row.get(0),
            )?;
            if existing_owner != Some(payload.episode_id) {
                return Err(CoreError::Import(
                    "该素材已属于另一个 Episode，不能由延迟导入任务改写".to_owned(),
                ));
            }
            transaction.execute(
                "UPDATE clips
                    SET volume_uuid = ?1, rel_path = ?2, folder_label = ?3,
                        missing_since = NULL
                  WHERE id = ?4",
                params![volume.uuid, rel_path, payload.folder_label, existing_id],
            )?;
            transaction.commit()?;
            return Ok(ImportProbeOutcome::Duplicate(path));
        }
        return Ok(ImportProbeOutcome::Duplicate(path));
    }

    let mut metadata = probe_media_with(&path, ffprobe, timeout)?;
    // Asset Safety:VFR 采样失败只降级(无采样表,按码率差粗判),绝不拒绝导入。
    let frame_timing = probe_frame_timing_with(&path, ffprobe, timeout, &metadata)
        .unwrap_or_else(|error| {
            eprintln!("vfr sampling degraded for {}: {error}", path.display());
            FrameTimingProbe { is_vfr: metadata.is_vfr, samples: Vec::new() }
        });
    metadata.is_vfr |= frame_timing.is_vfr;
    if metadata.is_vfr && frame_timing.samples.len() < 2 {
        return Err(CoreError::Import(format!(
            "VFR 素材 {} 没有足够的 PTS 采样点",
            path.display()
        )));
    }
    let modified_seconds = path
        .metadata()?
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64);

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    ensure_import_episode_active(&transaction, payload.episode_id)?;
    let existing_owner = transaction
        .query_row(
            "SELECT episode_id FROM clips WHERE volume_uuid = ?1 AND rel_path = ?2",
            params![volume.uuid, rel_path],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten();
    if existing_owner.is_some_and(|owner| owner != payload.episode_id) {
        return Err(CoreError::Import(
            "该路径中的素材已属于另一个 Episode，不能由延迟导入任务改写".to_owned(),
        ));
    }
    let previous_quick_hash = transaction
        .query_row(
            "SELECT quick_hash FROM clips WHERE volume_uuid = ?1 AND rel_path = ?2",
            params![volume.uuid, rel_path],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    transaction.execute(
        "INSERT INTO volumes(uuid, label, fs_type, last_seen_at)
         VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(uuid) DO UPDATE SET
            label = COALESCE(excluded.label, volumes.label),
            fs_type = COALESCE(excluded.fs_type, volumes.fs_type),
            last_seen_at = excluded.last_seen_at",
        params![volume.uuid, volume.label, volume.fs_type],
    )?;
    transaction.execute(
        "INSERT INTO clips(
            volume_uuid, rel_path, byte_size, quick_hash,
            tb_num, tb_den, duration_ticks, fps_num, fps_den, is_vfr,
            codec, width, height, captured_at, gps_lat, gps_lon,
            imported_at, missing_since, audio_sample_rate, rotation,
            color_transfer, hdr_flag, tz_guess, tz_conflict, device_model,
            vfr_timing_checked
         ) VALUES (
            ?1, ?2, ?3, ?4,
            ?5, ?6, ?7, ?8, ?9, ?10,
            ?11, ?12, ?13,
            COALESCE(?14, strftime('%Y-%m-%dT%H:%M:%fZ', ?15, 'unixepoch')),
            ?16, ?17, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL,
            ?18, ?19, ?20, ?21, ?22, ?23, ?24, 1
         )
         ON CONFLICT(volume_uuid, rel_path) DO UPDATE SET
            byte_size = excluded.byte_size,
            quick_hash = excluded.quick_hash,
            full_hash = CASE
                WHEN clips.quick_hash = excluded.quick_hash THEN clips.full_hash
                ELSE NULL
            END,
            tb_num = excluded.tb_num,
            tb_den = excluded.tb_den,
            duration_ticks = excluded.duration_ticks,
            fps_num = excluded.fps_num,
            fps_den = excluded.fps_den,
            is_vfr = excluded.is_vfr,
            codec = excluded.codec,
            width = excluded.width,
            height = excluded.height,
            captured_at = excluded.captured_at,
            gps_lat = excluded.gps_lat,
            gps_lon = excluded.gps_lon,
            audio_sample_rate = excluded.audio_sample_rate,
            rotation = excluded.rotation,
            color_transfer = excluded.color_transfer,
            hdr_flag = excluded.hdr_flag,
            tz_guess = excluded.tz_guess,
            tz_conflict = excluded.tz_conflict,
            device_model = excluded.device_model,
            vfr_timing_checked = 1,
            imported_at = excluded.imported_at,
            missing_since = NULL",
        params![
            volume.uuid,
            rel_path,
            byte_size as i64,
            quick_hash,
            metadata.tb_num,
            metadata.tb_den,
            metadata.duration_ticks,
            metadata.fps_num,
            metadata.fps_den,
            if metadata.is_vfr { 1_i64 } else { 0_i64 },
            metadata.codec,
            metadata.width,
            metadata.height,
            metadata.captured_at,
            modified_seconds,
            metadata.gps_lat,
            metadata.gps_lon,
            metadata.audio_sample_rate,
            metadata.rotation,
            metadata.color_transfer,
            if metadata.hdr_flag { 1_i64 } else { 0_i64 },
            metadata.tz_guess,
            if metadata.tz_conflict { 1_i64 } else { 0_i64 },
            metadata.device_model,
        ],
    )?;
    let clip_id = transaction.query_row(
        "SELECT id FROM clips WHERE volume_uuid = ?1 AND rel_path = ?2",
        params![volume.uuid, rel_path],
        |row| row.get::<_, i64>(0),
    )?;
    super::episode::assign_clip_to_episode(&transaction, clip_id, payload.episode_id)?;
    // 素材文件夹的第一级子目录 = 用户分类,落为可过滤标签。
    if let Some(label) = &payload.folder_label {
        transaction.execute(
            "UPDATE clips SET folder_label = ?1 WHERE id = ?2",
            params![label, clip_id],
        )?;
    }
    super::canonical_time::replace_vfr_map(
        &transaction,
        clip_id,
        if metadata.is_vfr {
            &frame_timing.samples
        } else {
            &[]
        },
    )?;
    if previous_quick_hash
        .as_deref()
        .is_some_and(|previous| previous != quick_hash.as_str())
    {
        transaction.execute("DELETE FROM clip_analysis WHERE clip_id = ?1", [clip_id])?;
        transaction.execute("DELETE FROM clip_dimensions WHERE clip_id = ?1", [clip_id])?;
        transaction.execute(
            "DELETE FROM segments WHERE clip_id = ?1 AND kind = 'scene'",
            [clip_id],
        )?;
        transaction.execute(
            "DELETE FROM transcript_segments WHERE clip_id = ?1",
            [clip_id],
        )?;
        transaction.execute(
            "DELETE FROM cache_artifacts
             WHERE clip_id = ?1 AND kind IN ('transcript', 'srt')",
            [clip_id],
        )?;
        transaction.execute("DELETE FROM proxy_time_map WHERE clip_id = ?1", [clip_id])?;
    }
    transaction.commit()?;

    analysis::enqueue_for_clip(connection, clip_id, &path, &quick_hash)?;

    let full_payload = FullHashPayload {
        clip_id,
        path: payload.path.clone(),
        quick_hash: quick_hash.clone(),
    };
    let full_payload_json = serde_json::to_string(&full_payload)
        .map_err(|error| CoreError::Import(format!("无法创建完整哈希任务：{error}")))?;
    let full_payload_hash = hash_text(&format!("full_hash\0{clip_id}\0{quick_hash}"));
    enqueue_unique(
        connection,
        "full_hash",
        &full_payload_json,
        &full_payload_hash,
    )?;
    super::artifacts::enqueue_for_clip(connection, clip_id, &path, &quick_hash)?;

    Ok(ImportProbeOutcome::Imported)
}

fn ensure_import_episode_active(connection: &Connection, episode_id: i64) -> Result<()> {
    let status = connection
        .query_row(
            "SELECT status FROM episodes WHERE id = ?1",
            [episode_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    match status.as_deref() {
        Some("active") => Ok(()),
        Some(_) => Err(CoreError::Import(
            "导入任务所属 Episode 已封存；任务已停止，历史素材未被修改".to_owned(),
        )),
        None => Err(CoreError::Import(
            "导入任务所属 Episode 已不存在；任务已停止".to_owned(),
        )),
    }
}

pub fn run_full_hash(connection: &mut Connection, job: &Job) -> Result<()> {
    let payload: FullHashPayload = serde_json::from_str(&job.payload)
        .map_err(|error| CoreError::Import(format!("完整哈希任务数据无效：{error}")))?;
    let path = super::media_source::clip_path_for_full_hash(connection, payload.clip_id)
        .map_err(|error| CoreError::Import(error.to_string()))?;
    let full_hash = full_fingerprint(&path)?;
    let updated = connection.execute(
        "UPDATE clips SET full_hash = ?1
         WHERE id = ?2 AND quick_hash = ?3",
        params![full_hash, payload.clip_id, payload.quick_hash],
    )?;
    if updated != 1 {
        return Err(CoreError::Import(format!(
            "完整哈希完成时素材 {} 已变化或不存在",
            payload.clip_id
        )));
    }
    Ok(())
}

pub fn enqueue_metadata_backfill(connection: &mut Connection) -> Result<usize> {
    let pending = {
        let mut statement = connection.prepare(
            "SELECT id, quick_hash FROM clips
             WHERE missing_since IS NULL AND quick_hash IS NOT NULL
               AND (
                    vfr_timing_checked = 0
                    OR (
                        audio_sample_rate IS NULL
                        AND rotation IS NULL
                        AND color_transfer IS NULL
                        AND device_model IS NULL
                    )
               )",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(MetadataBackfillPayload {
                clip_id: row.get(0)?,
                quick_hash: row.get(1)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut enqueued = 0;
    for payload in pending {
        let payload_json = serde_json::to_string(&payload)
            .map_err(|error| CoreError::Import(format!("无法创建元数据回填任务：{error}")))?;
        let payload_hash = hash_text(&format!(
            "metadata_backfill_v2\0{}\0{}",
            payload.clip_id, payload.quick_hash
        ));
        if enqueue_unique(connection, "metadata_backfill", &payload_json, &payload_hash)?.is_some() {
            enqueued += 1;
        }
    }
    Ok(enqueued)
}

pub fn run_metadata_backfill(connection: &mut Connection, job: &Job) -> Result<()> {
    let payload: MetadataBackfillPayload = serde_json::from_str(&job.payload)
        .map_err(|error| CoreError::Import(format!("元数据回填任务数据无效：{error}")))?;
    let path = super::media_source::verified_clip_path(connection, payload.clip_id)
        .map_err(|error| CoreError::Import(error.to_string()))?;
    let ffprobe = super::settings::configured_executable(
        connection,
        super::settings::FFPROBE_PATH_KEY,
        "FFPROBE_PATH",
        "ffprobe",
    )?;
    let mut metadata = probe_media_with(&path, &ffprobe, FFPROBE_TIMEOUT)?;
    let frame_timing = probe_frame_timing_with(&path, &ffprobe, FFPROBE_TIMEOUT, &metadata)
        .unwrap_or_else(|error| {
            eprintln!("vfr sampling degraded for {}: {error}", path.display());
            FrameTimingProbe { is_vfr: metadata.is_vfr, samples: Vec::new() }
        });
    metadata.is_vfr |= frame_timing.is_vfr;
    if metadata.is_vfr && frame_timing.samples.len() < 2 {
        return Err(CoreError::Import(format!(
            "VFR 素材 {} 没有足够的 PTS 采样点",
            path.display()
        )));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed = transaction.execute(
        "UPDATE clips SET
            audio_sample_rate = ?3, rotation = ?4, color_transfer = ?5,
            hdr_flag = ?6, tz_guess = ?7, tz_conflict = ?8, device_model = ?9,
            is_vfr = ?10, vfr_timing_checked = 1
         WHERE id = ?1 AND quick_hash = ?2",
        params![
            payload.clip_id,
            payload.quick_hash,
            metadata.audio_sample_rate,
            metadata.rotation,
            metadata.color_transfer,
            if metadata.hdr_flag { 1_i64 } else { 0_i64 },
            metadata.tz_guess,
            if metadata.tz_conflict { 1_i64 } else { 0_i64 },
            metadata.device_model,
            if metadata.is_vfr { 1_i64 } else { 0_i64 },
        ],
    )?;
    if changed != 1 {
        return Err(CoreError::Import(format!(
            "元数据回填完成时素材 {} 已变化或不存在",
            payload.clip_id
        )));
    }
    super::canonical_time::replace_vfr_map(
        &transaction,
        payload.clip_id,
        if metadata.is_vfr {
            &frame_timing.samples
        } else {
            &[]
        },
    )?;
    transaction.commit()?;
    Ok(())
}

pub fn get_import_progress(connection: &Connection) -> Result<ImportProgress> {
    connection
        .query_row(
            "SELECT
                COUNT(*),
                COALESCE(SUM(status = 'done'), 0),
                COALESCE(SUM(status IN ('failed', 'blocked')), 0),
                COALESCE(SUM(status = 'running'), 0)
             FROM jobs
             WHERE kind = 'import_probe'
               AND json_valid(payload)
               AND CAST(json_extract(payload, '$.episode_id') AS INTEGER) = (
                   SELECT id FROM episodes WHERE status = 'active'
               )",
            [],
            |row| {
                Ok(ImportProgress {
                    total: row.get::<_, i64>(0)?.max(0) as u64,
                    done: row.get::<_, i64>(1)?.max(0) as u64,
                    failed: row.get::<_, i64>(2)?.max(0) as u64,
                    running: row.get::<_, i64>(3)?.max(0) as u64,
                })
            },
        )
        .map_err(CoreError::from)
}

pub fn list_clips(connection: &Connection) -> Result<Vec<ClipListItem>> {
    let jitter_threshold = super::settings::number_value(
        connection,
        super::settings::JITTER_THRESHOLD_KEY,
        super::settings::DEFAULT_JITTER_THRESHOLD,
    )?
    .clamp(0.0, 2.0);
    let mut items = Vec::new();
    let mut statement = connection.prepare(
        "SELECT c.id, c.rel_path, c.byte_size, c.quick_hash, c.full_hash,
                c.tb_num, c.tb_den, c.duration_ticks, c.fps_num, c.fps_den, c.is_vfr,
                c.codec, c.width, c.height, c.captured_at,
                c.audio_sample_rate, c.rotation, c.color_transfer, c.hdr_flag,
                c.tz_guess, c.tz_conflict, c.device_model, c.journey_offset_ms,
                a.clip_id, a.exposure_yavg, a.overexposed_ratio, a.audio_peak_db,
                a.audio_clipped, a.has_audio, a.focus_scores, a.scene_count,
                a.analyzed_at, a.tool_versions,
                m.clip_id, m.class, m.pan_ratio, m.tilt_ratio, m.zoom_corr,
                m.shake_score, m.sample_pairs, m.tool_version,
                aj.status, aj.blocked_summary,
                mj.status, mj.blocked_summary,
                CASE
                    WHEN EXISTS (
                        SELECT 1 FROM segments selected_segment
                        WHERE selected_segment.clip_id = c.id
                          AND selected_segment.kind = 'select'
                          AND selected_segment.tombstone = 0
                    ) THEN 1
                    ELSE (
                        SELECT r.value FROM ratings r
                        JOIN segments rs ON rs.id = r.segment_id
                        WHERE rs.clip_id = c.id AND rs.tombstone = 0
                          AND r.rating_type = 'binary'
                        ORDER BY r.id DESC LIMIT 1
                    )
                END,
                (
                    SELECT r.value FROM ratings r
                    JOIN segments rs ON rs.id = r.segment_id
                    WHERE rs.clip_id = c.id AND rs.tombstone = 0
                      AND r.rating_type = 'star'
                    ORDER BY r.id DESC LIMIT 1
                ),
                (SELECT COUNT(*) FROM segments selected_segment
                 WHERE selected_segment.clip_id = c.id
                   AND selected_segment.kind = 'select'
                   AND selected_segment.tombstone = 0),
                c.episode_id, c.folder_label,
                a.underexposed_ratio, a.dynamic_range, a.blur_mean, a.entropy_mean,
                a.motion_mean, a.out_of_focus_ratio
         FROM clips c
         LEFT JOIN clip_analysis a ON a.clip_id = c.id
         LEFT JOIN clip_motion m ON m.clip_id = c.id
         LEFT JOIN jobs aj ON aj.id = (
             SELECT candidate.id FROM jobs candidate
             WHERE candidate.kind = 'analyze_l1'
               AND CAST(CASE WHEN json_valid(candidate.payload)
                    THEN json_extract(candidate.payload, '$.clip_id') END AS INTEGER) = c.id
             ORDER BY candidate.id DESC LIMIT 1
         )
         LEFT JOIN jobs mj ON mj.id = (
             SELECT candidate.id FROM jobs candidate
             WHERE candidate.kind = 'analyze_motion'
               AND CAST(CASE WHEN json_valid(candidate.payload)
                    THEN json_extract(candidate.payload, '$.clip_id') END AS INTEGER) = c.id
             ORDER BY candidate.id DESC LIMIT 1
         )
         ORDER BY c.imported_at DESC, c.id DESC",
    )?;
    let clips = statement.query_map([], |row| {
        let path: String = row.get(1)?;
        let analysis = match row.get::<_, Option<i64>>(23)? {
            Some(clip_id) => {
                let focus_json: String = row.get(29)?;
                let tools_json: String = row.get(32)?;
                let focus_scores = serde_json::from_str(&focus_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        29,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
                let tool_versions = serde_json::from_str(&tools_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        32,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
                Some(ClipAnalysis {
                    clip_id,
                    exposure_yavg: row.get(24)?,
                    overexposed_ratio: row.get(25)?,
                    audio_peak_db: row.get(26)?,
                    audio_clipped: row.get::<_, i64>(27)? == 1,
                    has_audio: row.get::<_, i64>(28)? == 1,
                    focus_scores,
                    scene_count: row.get(30)?,
                    analyzed_at: row.get(31)?,
                    tool_versions,
                    underexposed_ratio: row.get(50)?,
                    dynamic_range: row.get(51)?,
                    blur_mean: row.get(52)?,
                    entropy_mean: row.get(53)?,
                    motion_mean: row.get(54)?,
                    out_of_focus_ratio: row.get(55)?,
                })
            }
            None => None,
        };
        let motion = match row.get::<_, Option<i64>>(33)? {
            Some(clip_id) => {
                let shake_score = row.get(38)?;
                Some(ClipMotion {
                    clip_id,
                    class: row.get(34)?,
                    pan_ratio: row.get(35)?,
                    tilt_ratio: row.get(36)?,
                    zoom_corr: row.get(37)?,
                    shake_score,
                    is_shaky: shake_score > jitter_threshold,
                    sample_pairs: row.get(39)?,
                    tool_version: row.get(40)?,
                })
            }
            None => None,
        };
        Ok(ClipListItem {
            id: row.get(0)?,
            file_name: file_name_from_path(&path),
            path,
            byte_size: row.get(2)?,
            quick_hash: row.get(3)?,
            full_hash: row.get(4)?,
            tb_num: row.get(5)?,
            tb_den: row.get(6)?,
            duration_ticks: row.get(7)?,
            fps_num: row.get(8)?,
            fps_den: row.get(9)?,
            is_vfr: row.get::<_, i64>(10)? == 1,
            codec: row.get(11)?,
            width: row.get(12)?,
            height: row.get(13)?,
            captured_at: row.get(14)?,
            audio_sample_rate: row.get(15)?,
            rotation: row.get(16)?,
            color_transfer: row.get(17)?,
            hdr_flag: row.get::<_, i64>(18)? == 1,
            tz_guess: row.get(19)?,
            tz_conflict: row.get::<_, i64>(20)? == 1,
            device_model: row.get(21)?,
            journey_offset_ms: row.get(22)?,
            cover_url: None,
            status: "ready".to_owned(),
            error: None,
            analysis,
            analysis_status: row.get(41)?,
            analysis_error: row.get(42)?,
            motion,
            motion_status: row.get(43)?,
            motion_error: row.get(44)?,
            binary_rating: row.get(45)?,
            star_rating: row.get(46)?,
            select_count: row.get(47)?,
            episode_id: row.get(48)?,
            folder_label: row.get(49)?,
        })
    })?;
    for clip in clips {
        items.push(clip?);
    }

    let mut problem_statement = connection.prepare(
        "SELECT payload, status, blocked_summary, result_path
         FROM jobs
         WHERE kind = 'import_probe'
           AND (status IN ('failed', 'blocked')
                OR (status = 'done' AND result_path IS NOT NULL))
           AND json_valid(payload)
           AND CAST(json_extract(payload, '$.episode_id') AS INTEGER) = (
               SELECT id FROM episodes WHERE status = 'active'
           )
         ORDER BY updated_at DESC, id DESC",
    )?;
    let problems = problem_statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })?;
    for problem in problems {
        let (payload, status, summary, result_path) = problem?;
        let payload: ImportPayload = match serde_json::from_str(&payload) {
            Ok(payload) => payload,
            Err(_) => continue,
        };
        let duplicate = status == "done" && result_path.is_some();
        items.push(ClipListItem {
            id: None,
            episode_id: Some(payload.episode_id),
            folder_label: None,
            file_name: file_name_from_path(&payload.path),
            path: payload.path,
            byte_size: None,
            quick_hash: None,
            full_hash: None,
            tb_num: None,
            tb_den: None,
            duration_ticks: None,
            fps_num: None,
            fps_den: None,
            is_vfr: false,
            codec: None,
            width: None,
            height: None,
            captured_at: None,
            audio_sample_rate: None,
            rotation: None,
            color_transfer: None,
            hdr_flag: false,
            tz_guess: None,
            tz_conflict: false,
            device_model: None,
            journey_offset_ms: 0,
            cover_url: None,
            status: if duplicate { "duplicate" } else { "unreadable" }.to_owned(),
            error: if duplicate {
                Some("已存在相同素材，未重复导入".to_owned())
            } else {
                summary
            },
            analysis: None,
            analysis_status: None,
            analysis_error: None,
            motion: None,
            motion_status: None,
            motion_error: None,
            binary_rating: None,
            star_rating: None,
            select_count: 0,
        });
    }
    Ok(items)
}

/// 测试与集成测试共用的探测入口(集成测试在 crate 外,不能用 cfg(test))。
pub fn probe_media(path: &Path) -> Result<ProbeMetadata> {
    let connection = Connection::open_in_memory()?;
    let ffprobe = super::settings::configured_executable(
        &connection,
        super::settings::FFPROBE_PATH_KEY,
        "FFPROBE_PATH",
        "ffprobe",
    )?;
    probe_media_with(path, &ffprobe, FFPROBE_TIMEOUT)
}

fn probe_media_with(path: &Path, executable: &OsStr, timeout: Duration) -> Result<ProbeMetadata> {
    let args = [
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-print_format"),
        OsString::from("json"),
        OsString::from("-show_format"),
        OsString::from("-show_streams"),
        path.as_os_str().to_owned(),
    ];
    let output = execute_with_timeout(executable, &args, timeout).map_err(|error| {
        CoreError::Import(format!("ffprobe 无法读取 {}：{error}", path.display()))
    })?;
    if !output.success {
        let stderr = stderr_summary(&output.stderr);
        return Err(CoreError::Import(format!(
            "ffprobe 失败（退出码 {}）：{}",
            output
                .code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal".to_owned()),
            if stderr.is_empty() { "没有错误输出" } else { &stderr }
        )));
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| CoreError::Import(format!("ffprobe JSON 无效：{error}")))?;
    parse_probe_json(&value)
}

fn probe_frame_timing_with(
    path: &Path,
    executable: &OsStr,
    timeout: Duration,
    metadata: &ProbeMetadata,
) -> Result<FrameTimingProbe> {
    let args = [
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-select_streams"),
        OsString::from("v:0"),
        OsString::from("-read_intervals"),
        OsString::from("%+#600"),
        OsString::from("-show_entries"),
        OsString::from("packet=pts"),
        OsString::from("-show_packets"),
        OsString::from("-of"),
        OsString::from("json"),
        path.as_os_str().to_owned(),
    ];
    let output = execute_with_timeout(executable, &args, timeout).map_err(|error| {
        CoreError::Import(format!("ffprobe 无法采样 VFR PTS {}：{error}", path.display()))
    })?;
    if !output.success {
        return Err(CoreError::Import(format!(
            "ffprobe VFR PTS 采样失败（退出码 {}）：{}",
            output
                .code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal".to_owned()),
            stderr_summary(&output.stderr)
        )));
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| CoreError::Import(format!("ffprobe VFR PTS JSON 无效：{error}")))?;
    parse_frame_timing_json(&value, metadata)
}

fn parse_frame_timing_json(value: &Value, metadata: &ProbeMetadata) -> Result<FrameTimingProbe> {
    let timing_items = value
        .get("packets")
        .or_else(|| value.get("frames"))
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::Import("ffprobe VFR PTS 输出缺少 packets".to_owned()))?;
    let mut ticks = timing_items
        .iter()
        .filter_map(|item| {
            value_as_i64(item.get("pts"))
                .or_else(|| value_as_i64(item.get("best_effort_timestamp")))
        })
        .collect::<Vec<_>>();
    ticks.sort_unstable();
    ticks.dedup();
    if let Some(origin) = ticks.first().copied() {
        for tick in &mut ticks {
            *tick = tick.saturating_sub(origin);
        }
    }
    let is_vfr = super::canonical_time::frame_timing_is_vfr(
        &ticks,
        metadata.tb_num,
        metadata.tb_den,
        metadata.fps_num,
        metadata.fps_den,
    );
    let samples = super::canonical_time::sample_vfr_time_map(
        &ticks,
        metadata.tb_num,
        metadata.tb_den,
    );
    Ok(FrameTimingProbe { is_vfr, samples })
}

pub fn parse_probe_json(value: &Value) -> Result<ProbeMetadata> {
    let streams = value
        .get("streams")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::Import("ffprobe 输出缺少 streams".to_owned()))?;
    let stream = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("video"))
        .ok_or_else(|| CoreError::Import("文件中没有视频流".to_owned()))?;
    let format = value.get("format").unwrap_or(&Value::Null);

    let (tb_num, tb_den) = stream
        .get("time_base")
        .and_then(Value::as_str)
        .and_then(parse_fraction)
        .ok_or_else(|| CoreError::Import("视频流 time_base 无效".to_owned()))?;
    let r_rate = stream
        .get("r_frame_rate")
        .and_then(Value::as_str)
        .and_then(parse_fraction);
    let avg_rate = stream
        .get("avg_frame_rate")
        .and_then(Value::as_str)
        .and_then(parse_fraction);
    let (fps_num, fps_den) = avg_rate
        .or(r_rate)
        .ok_or_else(|| CoreError::Import("视频流帧率无效".to_owned()))?;
    let codec_time_base_abnormal = stream
        .get("codec_time_base")
        .and_then(Value::as_str)
        .is_some_and(|value| parse_fraction(value).is_none());
    let is_vfr = matches!((r_rate, avg_rate), (Some(left), Some(right)) if !fractions_equal(left, right))
        || codec_time_base_abnormal;

    let duration_ticks = value_as_i64(stream.get("duration_ts"))
        .or_else(|| {
            stream
                .get("duration")
                .and_then(Value::as_str)
                .and_then(|duration| decimal_seconds_to_ticks(duration, tb_num, tb_den))
        })
        .or_else(|| {
            format
                .get("duration")
                .and_then(Value::as_str)
                .and_then(|duration| decimal_seconds_to_ticks(duration, tb_num, tb_den))
        })
        .ok_or_else(|| CoreError::Import("视频流时长无效".to_owned()))?;

    let captured_at = tag(format, "creation_time")
        .or_else(|| tag(stream, "creation_time"))
        .map(str::to_owned);
    let (gps_lat, gps_lon) = parse_gps(format, stream);
    let audio_stream = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"));
    let audio_sample_rate = audio_stream
        .and_then(|audio| value_as_i64(audio.get("sample_rate")))
        .filter(|sample_rate| *sample_rate > 0);
    let rotation = stream
        .get("side_data_list")
        .and_then(Value::as_array)
        .and_then(|items| items.iter().find_map(|item| value_as_i64(item.get("rotation"))))
        .or_else(|| tag(stream, "rotate").and_then(|value| value.parse::<i64>().ok()))
        .map(|value| value.rem_euclid(360));
    let color_transfer = stream
        .get("color_transfer")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let hdr_flag = color_transfer
        .as_deref()
        .is_some_and(|value| matches!(value, "smpte2084" | "arib-std-b67"))
        || stream.get("color_primaries").and_then(Value::as_str) == Some("bt2020");
    let device_model = tag(format, "com.apple.quicktime.model")
        .or_else(|| tag(stream, "com.apple.quicktime.model"))
        .or_else(|| tag(format, "model"))
        .or_else(|| tag(stream, "model"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let gps_timezone_offset = gps_lon.and_then(timezone_offset_from_longitude);
    let file_timezone_offset = captured_at.as_deref().and_then(parse_timezone_offset_minutes);
    let tz_guess = gps_timezone_offset
        .or(file_timezone_offset)
        .map(format_timezone_offset);
    let tz_conflict = matches!((gps_timezone_offset, file_timezone_offset),
        (Some(gps), Some(file)) if (gps - file).abs() > 60);

    Ok(ProbeMetadata {
        container: format
            .get("format_name")
            .and_then(Value::as_str)
            .map(str::to_owned),
        codec: stream
            .get("codec_name")
            .and_then(Value::as_str)
            .map(str::to_owned),
        width: stream.get("width").and_then(Value::as_i64),
        height: stream.get("height").and_then(Value::as_i64),
        tb_num,
        tb_den,
        duration_ticks,
        fps_num,
        fps_den,
        is_vfr,
        captured_at,
        gps_lat,
        gps_lon,
        audio_sample_rate,
        rotation,
        color_transfer,
        hdr_flag,
        tz_guess,
        tz_conflict,
        device_model,
    })
}

fn timezone_offset_from_longitude(longitude: f64) -> Option<i64> {
    longitude
        .is_finite()
        .then(|| (longitude / 15.0).round() as i64)
        .filter(|hours| (-12..=14).contains(hours))
        .map(|hours| hours * 60)
}

fn parse_timezone_offset_minutes(value: &str) -> Option<i64> {
    if value.ends_with('Z') || value.ends_with('z') {
        return Some(0);
    }
    let bytes = value.as_bytes();
    let sign_index = bytes
        .iter()
        .enumerate()
        .rev()
        .find(|(index, byte)| *index >= 10 && matches!(**byte, b'+' | b'-'))?
        .0;
    let sign = if bytes[sign_index] == b'-' { -1 } else { 1 };
    let tail = &value[sign_index + 1..];
    let (hours, minutes) = if let Some((hours, minutes)) = tail.split_once(':') {
        (hours.parse::<i64>().ok()?, minutes.parse::<i64>().ok()?)
    } else if tail.len() == 4 {
        (tail[..2].parse::<i64>().ok()?, tail[2..].parse::<i64>().ok()?)
    } else {
        return None;
    };
    (hours <= 14 && minutes < 60).then_some(sign * (hours * 60 + minutes))
}

fn format_timezone_offset(minutes: i64) -> String {
    let sign = if minutes < 0 { '-' } else { '+' };
    let absolute = minutes.abs();
    format!("UTC{sign}{:02}:{:02}", absolute / 60, absolute % 60)
}

fn parse_fraction(value: &str) -> Option<(i64, i64)> {
    let (numerator, denominator) = value.split_once('/')?;
    let numerator = numerator.parse::<i64>().ok()?;
    let denominator = denominator.parse::<i64>().ok()?;
    (numerator > 0 && denominator > 0).then_some((numerator, denominator))
}

fn fractions_equal(left: (i64, i64), right: (i64, i64)) -> bool {
    i128::from(left.0) * i128::from(right.1)
        == i128::from(right.0) * i128::from(left.1)
}

fn value_as_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
    })
}

fn decimal_seconds_to_ticks(value: &str, tb_num: i64, tb_den: i64) -> Option<i64> {
    if tb_num <= 0 || tb_den <= 0 {
        return None;
    }
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    let whole = whole.parse::<i128>().ok()?;
    let fraction_value = if fraction.is_empty() {
        0
    } else {
        fraction.parse::<i128>().ok()?
    };
    let scale = 10_i128.checked_pow(fraction.len() as u32)?;
    let seconds_numerator = whole.checked_mul(scale)?.checked_add(fraction_value)?;
    let tick_numerator = seconds_numerator.checked_mul(i128::from(tb_den))?;
    let tick_denominator = scale.checked_mul(i128::from(tb_num))?;
    let rounded = tick_numerator
        .checked_add(tick_denominator / 2)?
        .checked_div(tick_denominator)?;
    i64::try_from(rounded).ok()
}

fn tag<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    let tags = value.get("tags")?.as_object()?;
    tags.iter()
        .find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
        .and_then(|(_, value)| value.as_str())
}

fn parse_gps(format: &Value, stream: &Value) -> (Option<f64>, Option<f64>) {
    let latitude = tag(format, "GPSLatitude")
        .or_else(|| tag(stream, "GPSLatitude"))
        .and_then(|value| value.parse().ok());
    let longitude = tag(format, "GPSLongitude")
        .or_else(|| tag(stream, "GPSLongitude"))
        .and_then(|value| value.parse().ok());
    if latitude.is_some() || longitude.is_some() {
        return (latitude, longitude);
    }
    let location = tag(format, "com.apple.quicktime.location.ISO6709")
        .or_else(|| tag(stream, "com.apple.quicktime.location.ISO6709"))
        .or_else(|| tag(format, "location"))
        .or_else(|| tag(stream, "location"));
    location.and_then(parse_iso6709).unwrap_or((None, None))
}

fn parse_iso6709(value: &str) -> Option<(Option<f64>, Option<f64>)> {
    let bytes = value.as_bytes();
    if !matches!(bytes.first(), Some(b'+') | Some(b'-')) {
        return None;
    }
    let second_sign = bytes
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, byte)| matches!(**byte, b'+' | b'-'))
        .map(|(index, _)| index)?;
    let end = bytes
        .iter()
        .enumerate()
        .skip(second_sign + 1)
        .find(|(_, byte)| matches!(**byte, b'+' | b'-' | b'/'))
        .map(|(index, _)| index)
        .unwrap_or(value.len());
    let latitude = value[..second_sign].parse::<f64>().ok()?;
    let longitude = value[second_sign..end].parse::<f64>().ok()?;
    Some((Some(latitude), Some(longitude)))
}

fn validate_ffprobe(executable: &OsStr) -> Result<()> {
    let output = execute_with_timeout(executable, &[OsString::from("-version")], TOOL_CHECK_TIMEOUT)
        .map_err(|error| {
            CoreError::Import(format!(
                "找不到应用内置的 ffprobe；请重新安装完整 DMG（开发调试可设置 FFPROBE_PATH）：{error}"
            ))
        })?;
    if !output.success {
        return Err(CoreError::Import(format!(
            "应用内置的 ffprobe 无法启动（退出码 {}）；请重新安装完整 DMG",
            output
                .code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal".to_owned())
        )));
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

fn stderr_summary(stderr: &[u8]) -> String {
    const MAX_LENGTH: usize = 1024;
    let text = String::from_utf8_lossy(stderr);
    let text = text.trim().replace(['\r', '\n'], " ");
    text.chars().take(MAX_LENGTH).collect()
}

fn volume_identity(path: &Path) -> VolumeIdentity {
    diskutil_volume_identity(path).unwrap_or_else(|| {
        tracing::warn!(path = %path.display(), "volume UUID unavailable; using local");
        VolumeIdentity {
            uuid: "local".to_owned(),
            label: None,
            fs_type: None,
            mount_point: None,
        }
    })
}

fn diskutil_volume_identity(path: &Path) -> Option<VolumeIdentity> {
    let args = [
        OsString::from("info"),
        OsString::from("-plist"),
        path.as_os_str().to_owned(),
    ];
    let output = execute_with_timeout(OsStr::new("diskutil"), &args, TOOL_CHECK_TIMEOUT).ok()?;
    if !output.success {
        return None;
    }
    let plist = String::from_utf8(output.stdout).ok()?;
    let uuid = plist_string(&plist, "VolumeUUID")?.to_owned();
    Some(VolumeIdentity {
        uuid,
        label: plist_string(&plist, "VolumeName").map(str::to_owned),
        fs_type: plist_string(&plist, "FilesystemType").map(str::to_owned),
        mount_point: plist_string(&plist, "MountPoint").map(PathBuf::from),
    })
}

fn plist_string<'a>(plist: &'a str, key: &str) -> Option<&'a str> {
    let key_marker = format!("<key>{key}</key>");
    let after_key = plist.split_once(&key_marker)?.1;
    let after_open = after_key.split_once("<string>")?.1;
    after_open.split_once("</string>").map(|(value, _)| value)
}

fn relative_path(path: &Path, mount_point: Option<&Path>) -> String {
    match mount_point.and_then(|mount| path.strip_prefix(mount).ok()) {
        Some(relative) => relative.to_string_lossy().trim_start_matches('/').to_owned(),
        None => path.to_string_lossy().into_owned(),
    }
}

fn file_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or(path)
        .to_owned()
}

fn hash_text(value: &str) -> String {
    blake3::hash(value.as_bytes()).to_hex().to_string()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;

    use serde_json::json;

    use super::*;
    use crate::core::db;
    use crate::core::jobs;
    use crate::core::test_support::TestDirectory;

    fn cfr_probe_json() -> Value {
        json!({
            "streams": [{
                "codec_type": "video",
                "codec_name": "h264",
                "width": 1920,
                "height": 1080,
                "time_base": "1/90000",
                "duration_ts": "270000",
                "r_frame_rate": "30000/1001",
                "avg_frame_rate": "30000/1001"
            }],
            "format": {
                "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
                "duration": "3.003000",
                "tags": { "creation_time": "2026-08-31T12:34:56Z" }
            }
        })
    }

    #[test]
    fn video_extension_matching_is_case_insensitive() {
        assert!(is_supported_video(Path::new("clip.MP4")));
        assert!(is_supported_video(Path::new("camera.INSV")));
        assert!(is_supported_video(Path::new("camera.MTS")));
        assert!(!is_supported_video(Path::new("types.d.mts")));
        assert!(!is_supported_video(Path::new("types.D.MTS")));
        assert!(!is_supported_video(Path::new("notes.txt")));
    }

    #[test]
    fn scanner_flattens_supported_files_and_skips_hidden_and_packages() {
        let directory = TestDirectory::new();
        fs::create_dir_all(directory.path().join("day-1/nested")).unwrap();
        fs::create_dir_all(directory.path().join(".hidden")).unwrap();
        fs::create_dir_all(directory.path().join("library.photoslibrary/originals")).unwrap();
        fs::write(directory.path().join("day-1/A.MOV"), b"a").unwrap();
        fs::write(directory.path().join("day-1/nested/b.mp4"), b"b").unwrap();
        fs::write(directory.path().join("day-1/readme.txt"), b"text").unwrap();
        fs::write(directory.path().join(".hidden/secret.mp4"), b"hidden").unwrap();
        fs::write(
            directory.path().join("library.photoslibrary/originals/buried.mov"),
            b"package",
        )
        .unwrap();

        let files = scan_video_files(directory.path()).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|path| path.ends_with("A.MOV")));
        assert!(files.iter().any(|path| path.ends_with("b.mp4")));
    }

    #[test]
    fn quick_fingerprint_is_stable_for_unchanged_content() {
        let directory = TestDirectory::new();
        let path = directory.path().join("stable.mov");
        fs::write(&path, b"tripcut-stable").unwrap();

        assert_eq!(quick_fingerprint(&path).unwrap(), quick_fingerprint(&path).unwrap());
    }

    #[test]
    fn quick_fingerprint_covers_the_tail_and_file_size() {
        let directory = TestDirectory::new();
        let path = directory.path().join("large.mov");
        let file = File::create(&path).unwrap();
        file.set_len(QUICK_HASH_CHUNK_SIZE * 2 + 32).unwrap();
        drop(file);
        let before = quick_fingerprint(&path).unwrap();

        let mut file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.seek(SeekFrom::End(-1)).unwrap();
        file.write_all(&[1]).unwrap();
        drop(file);
        let after = quick_fingerprint(&path).unwrap();

        assert_ne!(before.0, after.0);
        assert_eq!(before.1, after.1);
    }

    #[test]
    fn parses_timebase_fps_duration_container_and_capture_time() {
        let metadata = parse_probe_json(&cfr_probe_json()).unwrap();
        assert_eq!(metadata.tb_num, 1);
        assert_eq!(metadata.tb_den, 90_000);
        assert_eq!(metadata.duration_ticks, 270_000);
        assert_eq!((metadata.fps_num, metadata.fps_den), (30_000, 1_001));
        assert_eq!(metadata.codec.as_deref(), Some("h264"));
        assert!(metadata.container.as_deref().unwrap().contains("mp4"));
        assert_eq!(metadata.captured_at.as_deref(), Some("2026-08-31T12:34:56Z"));
        assert!(!metadata.is_vfr);
    }

    #[test]
    fn differing_r_and_average_rates_are_vfr() {
        let mut value = cfr_probe_json();
        value["streams"][0]["avg_frame_rate"] = json!("24000/1001");

        assert!(parse_probe_json(&value).unwrap().is_vfr);
    }

    #[test]
    fn invalid_codec_time_base_is_vfr_even_when_rates_match() {
        let mut value = cfr_probe_json();
        value["streams"][0]["codec_time_base"] = json!("0/0");

        assert!(parse_probe_json(&value).unwrap().is_vfr);
    }

    #[test]
    fn frame_pts_detect_vfr_when_stream_rates_claim_cfr() {
        let metadata = parse_probe_json(&cfr_probe_json()).unwrap();
        let frames = json!({
            "frames": [
                {"best_effort_timestamp": "9000"},
                {"best_effort_timestamp": "12003"},
                {"best_effort_timestamp": "15006"},
                {"best_effort_timestamp": "21012"}
            ]
        });

        let timing = parse_frame_timing_json(&frames, &metadata).unwrap();

        assert!(timing.is_vfr);
        assert_eq!(timing.samples.first().map(|point| point.source_ticks), Some(0));
        assert_eq!(timing.samples.last().map(|point| point.source_ticks), Some(12_012));
    }

    #[test]
    fn packet_pts_detect_vfr_without_decoding_frames() {
        let metadata = parse_probe_json(&cfr_probe_json()).unwrap();
        let packets = json!({
            "packets": [
                {"pts": "9000"},
                {"pts": "12003"},
                {"pts": "15006"},
                {"pts": "21012"}
            ]
        });

        let timing = parse_frame_timing_json(&packets, &metadata).unwrap();

        assert!(timing.is_vfr);
        assert_eq!(timing.samples.first().map(|point| point.source_ticks), Some(0));
        assert_eq!(timing.samples.last().map(|point| point.source_ticks), Some(12_012));
    }

    #[test]
    fn parses_iso6709_gps_from_quicktime_tags() {
        let mut value = cfr_probe_json();
        value["format"]["tags"]["com.apple.quicktime.location.ISO6709"] =
            json!("+43.6532-079.3832/");

        let metadata = parse_probe_json(&value).unwrap();
        assert_eq!(metadata.gps_lat, Some(43.6532));
        assert_eq!(metadata.gps_lon, Some(-79.3832));
    }

    #[test]
    fn parses_extended_temporal_metadata_and_detects_hdr() {
        let mut value = cfr_probe_json();
        value["streams"][0]["color_transfer"] = json!("smpte2084");
        value["streams"][0]["color_primaries"] = json!("bt2020");
        value["streams"][0]["side_data_list"] = json!([{ "rotation": -90 }]);
        value["streams"][0]["tags"] = json!({ "com.apple.quicktime.model": "iPhone 17 Pro" });
        value["streams"].as_array_mut().unwrap().push(json!({
            "codec_type": "audio",
            "sample_rate": "48000"
        }));

        let metadata = parse_probe_json(&value).unwrap();
        assert_eq!(metadata.audio_sample_rate, Some(48_000));
        assert_eq!(metadata.rotation, Some(270));
        assert_eq!(metadata.color_transfer.as_deref(), Some("smpte2084"));
        assert!(metadata.hdr_flag);
        assert_eq!(metadata.device_model.as_deref(), Some("iPhone 17 Pro"));
    }

    #[test]
    fn gps_timezone_conflict_is_visible_without_changing_capture_tag() {
        let mut value = cfr_probe_json();
        value["format"]["tags"]["creation_time"] = json!("2026-08-31T12:34:56+08:00");
        value["format"]["tags"]["com.apple.quicktime.location.ISO6709"] =
            json!("+43.6532-079.3832/");

        let metadata = parse_probe_json(&value).unwrap();
        assert_eq!(metadata.captured_at.as_deref(), Some("2026-08-31T12:34:56+08:00"));
        assert_eq!(metadata.tz_guess.as_deref(), Some("UTC-05:00"));
        assert!(metadata.tz_conflict);
    }

    #[test]
    fn decimal_duration_is_converted_to_integer_source_ticks() {
        assert_eq!(decimal_seconds_to_ticks("3.500", 1, 1_000), Some(3_500));
        assert_eq!(decimal_seconds_to_ticks("1.001", 1, 90_000), Some(90_090));
    }

    #[test]
    fn progress_counts_done_failed_and_running_without_full_hash_jobs() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let active_payload = r#"{"episode_id":1,"path":"active.mp4"}"#;
        let done = jobs::enqueue(&mut connection, "import_probe", active_payload, "done").unwrap();
        let failed = jobs::enqueue(&mut connection, "import_probe", active_payload, "failed").unwrap();
        let running = jobs::enqueue(&mut connection, "import_probe", active_payload, "running").unwrap();
        let historical = jobs::enqueue(
            &mut connection,
            "import_probe",
            r#"{"episode_id":999,"path":"archived.mp4"}"#,
            "historical",
        )
        .unwrap();
        jobs::enqueue(&mut connection, "full_hash", "{}", "full").unwrap();
        connection
            .execute("UPDATE jobs SET status = 'done' WHERE id = ?1", [done])
            .unwrap();
        connection
            .execute("UPDATE jobs SET status = 'failed' WHERE id = ?1", [failed])
            .unwrap();
        connection
            .execute("UPDATE jobs SET status = 'running' WHERE id = ?1", [running])
            .unwrap();
        connection
            .execute("UPDATE jobs SET status = 'failed' WHERE id = ?1", [historical])
            .unwrap();

        assert_eq!(
            get_import_progress(&connection).unwrap(),
            ImportProgress {
                total: 3,
                done: 1,
                failed: 1,
                running: 1,
            }
        );
    }

    #[test]
    fn migrated_clips_without_vfr_timing_check_enqueue_versioned_backfill() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        connection
            .execute("INSERT INTO volumes(uuid) VALUES ('legacy-volume')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(
                    volume_uuid, rel_path, quick_hash, imported_at,
                    tb_num, tb_den, duration_ticks, fps_num, fps_den
                 ) VALUES (
                    'legacy-volume', 'legacy.mov', 'legacy-quick', 'now',
                    1, 90000, 270000, 30000, 1001
                 )",
                [],
            )
            .unwrap();

        let enqueued = enqueue_metadata_backfill(&mut connection).unwrap();

        let payload_hash: String = connection
            .query_row(
                "SELECT payload_hash FROM jobs WHERE kind = 'metadata_backfill'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(enqueued, 1);
        assert_eq!(
            payload_hash,
            hash_text(&format!("metadata_backfill_v2\0{}\0{}", 1, "legacy-quick"))
        );
    }

    #[test]
    fn damaged_job_payload_does_not_hide_visible_blocked_evidence() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection
            .execute("INSERT INTO volumes(uuid) VALUES ('payload-volume')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, quick_hash, imported_at)
                 VALUES (1, 'payload-volume', 'clip.mov', 'quick', 'now')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO jobs(
                    kind, payload, payload_hash, status, attempt,
                    blocked_summary, created_at, updated_at, finished_at
                 ) VALUES (
                    'analyze_l1', '{\"clip_id\":1,\"path\":42}', 'schema-damaged',
                    'blocked', 3, 'L1 分析任务数据无效：path 类型错误', 'now', 'now', 'now'
                 )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO jobs(
                    kind, payload, payload_hash, status, attempt,
                    blocked_summary, created_at, updated_at, finished_at
                 ) VALUES (
                    'analyze_l1', '{', 'malformed-json',
                    'blocked', 3, 'L1 分析任务数据无效：JSON 损坏', 'now', 'now', 'now'
                 )",
                [],
            )
            .unwrap();

        let clips = list_clips(&connection).unwrap();

        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].analysis_status.as_deref(), Some("blocked"));
        assert!(clips[0]
            .analysis_error
            .as_deref()
            .is_some_and(|summary| summary.contains("任务数据无效")));
    }

    #[test]
    fn offline_watched_folder_is_reported_not_silently_skipped() {
        // 回归:NAS 断线时静默 continue,UI 把「没扫成」显示成「没有新素材」。
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let gone = directory.path().join("nas-offline");
        connection
            .execute(
                "INSERT INTO watched_folders(path, auto_sync, added_at)
                 VALUES (?1, 1, 'now')",
                [gone.to_string_lossy().as_ref()],
            )
            .unwrap();
        let outcome = rescan_watched_folders(&mut connection).unwrap();
        assert_eq!(outcome.unavailable, 1, "不可达目录必须被计数上报");
        assert_eq!(outcome.scanned, 0);
        assert_eq!(outcome.enqueued, 0);
    }

    #[test]
    fn watched_folder_skips_paths_owned_by_an_archived_episode() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let media = directory.path().join("media");
        fs::create_dir_all(&media).unwrap();
        let file = media.join("already-owned.mp4");
        fs::write(&file, b"existing episode media").unwrap();
        let media = media.canonicalize().unwrap();
        let file = file.canonicalize().unwrap();
        let volume = volume_identity(&media);
        let rel_path = relative_path(&file, volume.mount_point.as_deref());
        let (quick_hash, byte_size) = quick_fingerprint(&file).unwrap();
        let archived_id: i64 = connection
            .query_row(
                "SELECT id FROM episodes WHERE status = 'active'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        connection
            .execute(
                "INSERT OR IGNORE INTO volumes(uuid, label, fs_type, last_seen_at)
                 VALUES (?1, ?2, ?3, 'now')",
                params![volume.uuid, volume.label, volume.fs_type],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(
                    volume_uuid, rel_path, byte_size, quick_hash, imported_at, episode_id
                 ) VALUES (?1, ?2, ?3, ?4, 'now', ?5)",
                params![
                    volume.uuid,
                    rel_path,
                    byte_size as i64,
                    quick_hash,
                    archived_id
                ],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE episodes SET status = 'archived', archived_at = 'now' WHERE id = ?1",
                [archived_id],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO episodes(title, theme, created_at, status, episode_number, memory_id)
                 VALUES ('EP02', '', 'now', 'active', 2, lower(hex(randomblob(16))))",
                [],
            )
            .unwrap();

        let outcome = enqueue_labeled_files(
            &mut connection,
            media.to_string_lossy().into_owned(),
            vec![(file, None)],
        );
        // ffprobe 不可用时 enqueue 之前就会失败,该情况跳过(CI 无 ffmpeg)。
        let Ok(outcome) = outcome else { return };
        assert_eq!(outcome.total, 1);
        assert_eq!(outcome.enqueued, 0);
        assert_eq!(outcome.skipped, 1);
        let import_jobs: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM jobs WHERE kind = 'import_probe'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(import_jobs, 0, "跨 Episode 的已有路径不应制造失败任务");
    }

    #[test]
    fn overwritten_file_is_rescanned_instead_of_deduped_away() {
        // 回归:去重键只含路径时,NAS/相机的同名覆盖会永远返回 enqueued=0。
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let media = directory.path().join("media");
        fs::create_dir_all(&media).unwrap();
        let file = media.join("clip.mp4");
        fs::write(&file, b"first content").unwrap();

        let first = enqueue_labeled_files(
            &mut connection,
            media.to_string_lossy().into_owned(),
            vec![(file.clone(), None)],
        );
        // ffprobe 不可用时 enqueue 之前就会失败,该情况跳过(CI 无 ffmpeg)
        let Ok(first) = first else { return };
        assert_eq!(first.enqueued, 1, "首次导入应入队");

        // 同一路径重复扫描:内容没变,不应重复入队
        let again = enqueue_labeled_files(
            &mut connection,
            media.to_string_lossy().into_owned(),
            vec![(file.clone(), None)],
        )
        .unwrap();
        assert_eq!(again.enqueued, 0, "内容未变时不应重复入队");

        // 覆盖成不同内容(不同大小)后重扫:必须重新入队
        fs::write(&file, b"second content is longer than the first one").unwrap();
        let after_overwrite = enqueue_labeled_files(
            &mut connection,
            media.to_string_lossy().into_owned(),
            vec![(file, None)],
        )
        .unwrap();
        assert_eq!(after_overwrite.enqueued, 1, "同名覆盖后必须重新入队");
    }

    #[test]
    fn plist_volume_fields_are_read_without_a_schema_dependency() {
        let plist = "<dict><key>VolumeUUID</key><string>ABC-123</string>\
                     <key>MountPoint</key><string>/Volumes/CARD</string></dict>";
        assert_eq!(plist_string(plist, "VolumeUUID"), Some("ABC-123"));
        assert_eq!(plist_string(plist, "MountPoint"), Some("/Volumes/CARD"));
    }

    #[cfg(unix)]
    #[test]
    fn ffprobe_timeout_marks_the_job_failed_with_a_readable_summary() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let media_path = directory.path().join("slow.mp4");
        fs::write(&media_path, b"not-a-video").unwrap();
        let fake_ffprobe = directory.path().join("slow-ffprobe");
        fs::write(&fake_ffprobe, "#!/bin/sh\nsleep 2\n").unwrap();
        let mut permissions = fs::metadata(&fake_ffprobe).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_ffprobe, permissions).unwrap();

        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let payload = serde_json::to_string(&ImportPayload {
            path: media_path.to_string_lossy().into_owned(),
            episode_id: 1,
            folder_label: None,
        })
        .unwrap();
        let id = jobs::enqueue(&mut connection, "import_probe", &payload, "slow").unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        let error = run_import_probe_with(
            &mut connection,
            &job,
            fake_ffprobe.as_os_str(),
            Duration::from_millis(50),
        )
        .unwrap_err();
        jobs::mark_failed(&mut connection, id, &error.to_string()).unwrap();

        let failed = jobs::get(&connection, id).unwrap();
        assert_eq!(failed.status, jobs::JobStatus::Failed);
        assert!(failed.blocked_summary.unwrap().contains("超过 0 秒"));
    }

    #[cfg(unix)]
    #[test]
    fn delayed_import_for_archived_episode_stops_before_touching_media_rows() {
        let directory = TestDirectory::new();
        let media_path = directory.path().join("delayed.mp4");
        fs::write(&media_path, b"queued before archive").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let archived_id: i64 = connection
            .query_row(
                "SELECT id FROM episodes WHERE status = 'active'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let payload = serde_json::to_string(&ImportPayload {
            path: media_path.to_string_lossy().into_owned(),
            episode_id: archived_id,
            folder_label: None,
        })
        .unwrap();
        jobs::enqueue(&mut connection, "import_probe", &payload, "delayed-archive").unwrap();
        connection
            .execute(
                "UPDATE episodes SET status = 'archived', archived_at = 'now' WHERE id = ?1",
                [archived_id],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO episodes(title, theme, created_at, status, episode_number, memory_id)
                 VALUES ('EP02', '', 'now', 'active', 2, lower(hex(randomblob(16))))",
                [],
            )
            .unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();

        let error = run_import_probe_with(
            &mut connection,
            &job,
            OsStr::new("/definitely/not/invoked"),
            Duration::from_millis(1),
        )
        .unwrap_err();
        assert!(error.to_string().contains("已封存"));
        let clip_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM clips", [], |row| row.get(0))
            .unwrap();
        assert_eq!(clip_count, 0, "过期导入任务不得创建或改写任何素材行");
    }

    #[cfg(unix)]
    #[test]
    fn import_persists_vfr_samples_and_checked_marker_from_real_probe_path() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let media_path = directory.path().join("vfr.mp4");
        fs::write(&media_path, b"fixture bytes").unwrap();
        let fake_ffprobe = directory.path().join("fake-ffprobe");
        fs::write(
            &fake_ffprobe,
            r#"#!/bin/sh
case " $* " in
  *" -show_packets "*)
    printf '%s\n' '{"packets":[{"pts":"9000"},{"pts":"12003"},{"pts":"15006"},{"pts":"21012"}]}'
    ;;
  *)
    printf '%s\n' '{"streams":[{"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"time_base":"1/90000","duration_ts":"270000","r_frame_rate":"30000/1001","avg_frame_rate":"30000/1001"}],"format":{"format_name":"mov,mp4","duration":"3.003000"}}'
    ;;
esac
"#,
        )
        .unwrap();
        let mut permissions = fs::metadata(&fake_ffprobe).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_ffprobe, permissions).unwrap();

        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let payload = serde_json::to_string(&ImportPayload {
            path: media_path.to_string_lossy().into_owned(),
            episode_id: 1,
            folder_label: None,
        })
        .unwrap();
        jobs::enqueue(&mut connection, "import_probe", &payload, "vfr-persist").unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();

        run_import_probe_with(
            &mut connection,
            &job,
            fake_ffprobe.as_os_str(),
            Duration::from_secs(1),
        )
        .unwrap();

        let (is_vfr, checked, samples): (i64, i64, i64) = connection
            .query_row(
                "SELECT c.is_vfr, c.vfr_timing_checked,
                        (SELECT COUNT(*) FROM vfr_time_map v WHERE v.clip_id = c.id)
                 FROM clips c LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((is_vfr, checked), (1, 1));
        assert!(samples >= 2);
    }
    #[cfg(unix)]
    #[test]
    fn moving_a_clip_between_subfolders_updates_path_and_label() {
        // 回归:同指纹被无条件判 Duplicate 早退,导致用户在子文件夹间整理素材后
        // 数据库仍指向已不存在的旧路径,folder_label 也不更新（回归修复）。
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let folder_a = directory.path().join("A");
        let folder_b = directory.path().join("B");
        fs::create_dir_all(&folder_a).unwrap();
        fs::create_dir_all(&folder_b).unwrap();
        let path_a = folder_a.join("shot.mp4");
        fs::write(&path_a, b"same content bytes").unwrap();

        let fake_ffprobe = directory.path().join("fake-ffprobe");
        fs::write(
            &fake_ffprobe,
            r#"#!/bin/sh
printf '%s\n' '{"streams":[{"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"time_base":"1/90000","duration_ts":"270000","r_frame_rate":"30/1","avg_frame_rate":"30/1"}],"format":{"format_name":"mov,mp4","duration":"3.0"}}'
"#,
        )
        .unwrap();
        let mut permissions = fs::metadata(&fake_ffprobe).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_ffprobe, permissions).unwrap();

        let mut connection = db::open_project(&directory.db_path()).unwrap();

        // 第一次:导入 A/shot.mp4,label=A
        let payload_a = serde_json::to_string(&ImportPayload {
            path: path_a.to_string_lossy().into_owned(),
            episode_id: 1,
            folder_label: Some("A".to_owned()),
        })
        .unwrap();
        jobs::enqueue(&mut connection, "import_probe", &payload_a, "move-a").unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        run_import_probe_with(&mut connection, &job, fake_ffprobe.as_os_str(), Duration::from_secs(5))
            .unwrap();

        // 用户在 Finder 里把素材移到 B/
        let path_b = folder_b.join("shot.mp4");
        fs::rename(&path_a, &path_b).unwrap();

        // 重扫命中同指纹,但旧路径已不存在 → 应更新而非丢弃
        let payload_b = serde_json::to_string(&ImportPayload {
            path: path_b.to_string_lossy().into_owned(),
            episode_id: 1,
            folder_label: Some("B".to_owned()),
        })
        .unwrap();
        jobs::enqueue(&mut connection, "import_probe", &payload_b, "move-b").unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        run_import_probe_with(&mut connection, &job, fake_ffprobe.as_os_str(), Duration::from_secs(5))
            .unwrap();

        let (rel_path, label): (String, Option<String>) = connection
            .query_row(
                "SELECT rel_path, folder_label FROM clips LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(rel_path.ends_with("B/shot.mp4"), "路径应更新到新位置,实际 {rel_path}");
        assert_eq!(label.as_deref(), Some("B"), "分类标签应更新为新子文件夹");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM clips", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "移动不应产生重复条目");
    }

}
