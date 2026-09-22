pub mod core;
mod app_paths;
mod libraries;
/// R18 车道 native / M-01:中文原生菜单栏(结构是纯数据,见 `menu::menu_spec`)。
pub mod menu;
mod logging;
mod notify;
mod packaging;
/// R18 车道 native / F2:关窗口时后台任务还没做完的确认(判定是纯函数)。
pub mod exit_guard;
mod update_flow;
mod updater;
/// R18 车道 native / M-02:窗口几何钳制与全屏态(纯几何,单测判定)。
pub mod window_state;

// R18 车道 native2:Dock 打开 / 文件关联(M-06①)。
pub mod opened;
pub mod dock;
pub mod volumes;
#[cfg(target_os = "macos")]
pub mod player;
pub mod runtime;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::core::analysis::ClipAnalysis;
use crate::core::asset_safety::AssetSafetyInfo;
use crate::core::artifacts::ClipArtifacts;
use crate::core::audio_tracks::ClipAudioTrack;
use crate::core::canonical_time::DeviceClockSetting;
use crate::core::clip_dimensions::ClipDimension;
use crate::core::clip_search::ClipSearchHit;
use crate::core::deliver::ExportStatus;
use crate::core::doctor::DoctorReport;
use crate::core::error::{CoreError, Result};
use crate::core::generation_settings::{GenerationAvailability, GenerationLedgerSummary};
use crate::core::import::{ClipListItem, ImportProgress, ImportStart};
use crate::core::jianying::{HumanCheck, JianyingAvailability, JianyingDraftResult};
use crate::core::llm::{
    AiDescriptionResult, DirectorAnswerResult, DirectorContext, LlmLedgerEntry, LlmStatus,
};
use crate::core::media_server::MediaServerInfo;
use crate::core::music::{MusicAnalysis, MusicTrackSummary};
use crate::core::ratings::{ClipRating, SelectSegment};
use crate::core::similar::SimilarGroup;
use crate::core::settings::{CacheRebuildResult, SettingsStatus, WindowState};
use crate::core::shot_stack::ShotStack;
use crate::core::transcribe::TranscriptMatch;
use crate::core::story::{StoryOrderRef, Storyboard};
#[cfg(target_os = "macos")]
use crate::player::{PlayerCommand, PlayerManager, PlayerStatus, PlayerViewport};
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSNotification, NSOperationQueue};

/// R6 Task 4:`NSWorkspaceDidWakeNotification` 的观察者 token。留着它不是为了
/// 再去调用什么方法,纯粹是「只要有人还强引用着它,回调就还在生效」——一旦
/// 被释放,系统随时可能悄悄停止投递。`app.manage` 把它的生命周期钉在整个
/// 应用进程上。Objective-C 对象本身不是 `Send`/`Sync`,但这里从头到尾只在
/// 主线程创建、只被存起来、永不跨线程调用它的任何方法,借用
/// `player/mod.rs` 里 `RenderSurface`/`MainThreadView` 同款的手法。
#[cfg(target_os = "macos")]
#[allow(dead_code)]
struct WakeObserver(Retained<ProtocolObject<dyn NSObjectProtocol>>);
#[cfg(target_os = "macos")]
unsafe impl Send for WakeObserver {}
#[cfg(target_os = "macos")]
unsafe impl Sync for WakeObserver {}

/// R16 P1-6:用户「全部暂停」的持久化键(`ui.` 前缀走 settings 表的不透明字符串通道)。
const JOBS_PAUSED_KEY: &str = "ui.jobs.paused";

#[derive(Clone)]
struct RuntimeState {
    db_path: PathBuf,
    cache_root: PathBuf,
    media_server: MediaServerInfo,
    worker_count: usize,
    read_only: bool,
    _project_lock: Option<Arc<core::db::ProjectFileLock>>,
    worker_control: Option<core::jobs::WorkerControl>,
}

#[derive(Clone)]
struct DoctorRuntimeState {
    root: PathBuf,
    db_path: PathBuf,
    cache_root: PathBuf,
    writable: bool,
    report: Arc<Mutex<DoctorReport>>,
    worker_control: Arc<Mutex<Option<core::jobs::WorkerControl>>>,
    _project_lock: Option<Arc<core::db::ProjectFileLock>>,
}

#[derive(Serialize)]
struct AppInfo {
    version: String,
    db_schema_version: i64,
    worker_count: usize,
    read_only: bool,
}

/// R19 E-05(bench 车道):进程入口时间戳,供 `mark_first_paint` 命令算前端首次
/// render 的耗时。只加这一条状态,不改 `process_started` 原有用法(它继续给
/// `startup_ms`/`rust_setup_ms` 计时)。
struct ProcessStartedAt(std::time::Instant);

/// R19 E-05:前端 `main.tsx` 首次 render 完成后调用一次,把「进程入口 → 首帧画面」
/// 的耗时落进日志的 `first_paint_ms` 字段。与既有的 `rust_setup_ms`(setup() 结束、
/// 窗口已建好但前端还没画完)拼起来,就是启动时间的两段拆分(E-05)。
#[tauri::command]
fn mark_first_paint(state: tauri::State<'_, ProcessStartedAt>) {
    tracing::info!(first_paint_ms = state.0.elapsed().as_millis() as u64, "first paint");
}

#[tauri::command]
fn get_doctor_report(
    state: tauri::State<'_, DoctorRuntimeState>,
) -> std::result::Result<DoctorReport, String> {
    Ok(state
        .report
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone())
}

#[tauri::command]
async fn restore_latest_snapshot(
    state: tauri::State<'_, DoctorRuntimeState>,
) -> std::result::Result<String, String> {
    if !state.writable {
        return Err("只读实例不能恢复数据库快照".to_owned());
    }
    let root = state.root.clone();
    let db_path = state.db_path.clone();
    let cache_root = state.cache_root.clone();
    let report = state.report.clone();
    let control = state
        .worker_control
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    if control.is_some() {
        return Err("工作台已启动；仅可在 FAIL 恢复模式回填数据库快照".to_owned());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<String> {
        let snapshot = core::db::list_snapshots(&root.join("snapshots"))?
            .into_iter()
            .next()
            .ok_or_else(|| CoreError::BackgroundTask("没有可恢复的数据库快照".to_owned()))?;
        tracing::warn!(snapshot = %snapshot.display(), "command restore_latest_snapshot: replacing project.db with a snapshot (original kept as pre-restore backup)");
        let restore = || core::db::restore_snapshot(&db_path, &snapshot);
        let backup = restore()?;
        let mut refreshed = core::doctor::run_preflight(&root, &db_path, &cache_root, false);
        refreshed.mark_restart_required("快照已回填；请重启应用后再继续工作");
        *report
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = refreshed;
        Ok(format!(
            "已从 {} 恢复；原数据库保存在 {}",
            snapshot.file_name().unwrap_or_default().to_string_lossy(),
            backup.file_name().unwrap_or_default().to_string_lossy()
        ))
    })
    .await
    .map_err(|error| format!("快照恢复任务异常结束：{error}"))?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn export_decision_data(
    state: tauri::State<'_, DoctorRuntimeState>,
) -> std::result::Result<String, String> {
    let db_path = state.db_path.clone();
    let recovery_root = state.root.join("recovery");
    tauri::async_runtime::spawn_blocking(move || {
        let path = core::doctor::export_decision_data(&db_path, &recovery_root)?;
        reveal_in_finder(&path)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("决策数据导出任务异常结束：{error}"))?
    .map_err(|error: CoreError| error.to_string())
}

#[tauri::command]
async fn rebuild_recovery_cache(
    state: tauri::State<'_, DoctorRuntimeState>,
) -> std::result::Result<String, String> {
    if !state.writable {
        return Err("只读实例不能重建缓存".to_owned());
    }
    let db_path = state.db_path.clone();
    let cache_root = state.cache_root.clone();
    let control = state
        .worker_control
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<String> {
        if let Some(control) = control {
            let result = rebuild_cache_blocking(&db_path, &cache_root, &control)?;
            return Ok(format!(
                "已清理 {} 字节缓存并重置 {} 个任务",
                result.removed_disk_bytes, result.reset_jobs
            ));
        }
        match core::db::open_project(&db_path) {
            Ok(mut connection) => {
                let result = core::settings::clear_cache_and_rebuild(&mut connection, &cache_root)?;
                Ok(format!(
                    "已清理 {} 字节缓存并重置 {} 个任务",
                    result.removed_disk_bytes, result.reset_jobs
                ))
            }
            Err(_) => {
                let removed = core::doctor::rebuild_cache_files(&cache_root)?;
                Ok(format!("数据库当前不可用；已单独重建缓存目录并清理 {removed} 字节"))
            }
        }
    })
    .await
    .map_err(|error| format!("缓存恢复任务异常结束：{error}"))?
    .map_err(|error| error.to_string())
}

/// R15:「清理缓存并重新分析」的共用主体 —— 取消正在跑的可再生成文件任务、只暂停认领
/// (不等无关任务)、等这几种任务退出 ≤ 5 s、换目录 + 重排任务后立刻返回;旧目录由
/// cache_gc 后台删。
fn rebuild_cache_blocking(
    db_path: &std::path::Path,
    cache_root: &std::path::Path,
    control: &core::jobs::WorkerControl,
) -> Result<CacheRebuildResult> {
    let result = control.with_claims_paused(
        || {
            let mut connection = core::db::open_project(db_path)?;
            core::jobs::cancel_cache_jobs(&mut connection)?;
            Ok(())
        },
        || {
            let mut connection = core::db::open_project(db_path)?;
            core::jobs::wait_until_no_running(
                &connection,
                // photo_probe 会直接向 cache_root 发布 cover；暂停新认领后等当前探测
                // 结束，避免它跨越目录换代把封面写进已退役目录或刚清空的新目录。
                &format!("kind IN {} OR kind='photo_probe'", core::jobs::CACHE_JOB_KINDS_SQL),
                &[],
                std::time::Duration::from_secs(5),
            )?;
            core::settings::clear_cache_and_rebuild(&mut connection, cache_root)
        },
    )?;
    control.wake_worker();
    Ok(result)
}

/// R15:「重置项目库」的共用主体 —— 取消全部任务、暂停认领、等 running 退出 ≤ 8 s、
/// 打快照(唯一的后悔药)、清库 + 换缓存目录。恢复页没有 worker 池时直接跑。
fn reset_library_blocking(
    db_path: &std::path::Path,
    cache_root: &std::path::Path,
    control: Option<&core::jobs::WorkerControl>,
    source: &'static str,
) -> Result<core::settings::ResetLibraryResult> {
    // A16-02:每条清库路径都留一条带来源的 warn —— 下次「重启后库被清空」能在日志里对上是谁干的。
    if let Ok(connection) = core::db::open_project(db_path) {
        let census = core::db::library_census(&connection, &db_path.parent().unwrap_or(db_path).join("snapshots"));
        tracing::warn!(source, ?census, "library reset requested: wiping every table except settings");
    }
    let prepare = || {
        let mut connection = core::db::open_project(db_path)?;
        core::jobs::cancel_all_jobs(&mut connection)?;
        Ok(())
    };
    let operation = || {
        let mut connection = core::db::open_project(db_path)?;
        core::jobs::wait_until_no_running(&connection, "1 = 1", &[], std::time::Duration::from_secs(8))?;
        core::db::create_snapshot(&connection, &db_path.parent().unwrap_or(db_path).join("snapshots"))?;
        core::settings::reset_project_library(&mut connection, cache_root)
    };
    let result = match control {
        Some(control) => {
            let result = control.with_claims_paused(prepare, operation)?;
            control.wake_worker();
            result
        }
        None => {
            prepare()?;
            operation()?
        }
    };
    Ok(result)
}

/// R15:恢复页的「重置项目库」。
#[tauri::command]
async fn reset_recovery_library(
    state: tauri::State<'_, DoctorRuntimeState>,
) -> std::result::Result<core::settings::ResetLibraryResult, String> {
    if !state.writable {
        return Err("只读实例不能重置项目库".to_owned());
    }
    let db_path = state.db_path.clone();
    let cache_root = state.cache_root.clone();
    let control = state
        .worker_control
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    tauri::async_runtime::spawn_blocking(move || reset_library_blocking(&db_path, &cache_root, control.as_ref(), "command reset_recovery_library (recovery page)"))
        .await
        .map_err(|error| format!("重置项目库任务异常结束：{error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_logs_directory(
    state: tauri::State<'_, DoctorRuntimeState>,
) -> std::result::Result<(), String> {
    let logs = state.root.join("logs");
    std::fs::create_dir_all(&logs).map_err(|error| format!("无法创建日志目录：{error}"))?;
    open_in_finder(&logs).map_err(|error| error.to_string())
}

fn reveal_in_finder(path: &std::path::Path) -> Result<()> {
    run_open_command([std::ffi::OsStr::new("-R"), path.as_os_str()])
}

fn open_in_finder(path: &std::path::Path) -> Result<()> {
    run_open_command([path.as_os_str()])
}

fn run_open_command<'a>(args: impl IntoIterator<Item = &'a std::ffi::OsStr>) -> Result<()> {
    let status = std::process::Command::new("open")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(CoreError::BackgroundTask("访达未能打开目标位置".to_owned()))
    }
}

/// R18 车道 native:在系统里打开一个**白名单内**的链接。
/// 白名单只有两条:手动下载页(自动更新失败的兜底,R17 的 `openExternalUrl` 一直在调它,
/// 但后端从来没实现过——实测 `open_url` 全仓只有前端那一处)与「隐私与安全性 › 文件与文件夹」
/// 深链(H-07:权限被拒之后得能一键去开)。别的 URL 一律拒绝——这个命令要是敞开,
/// 就等于给前端一个任意 `open` 的口子。
const ALLOWED_URL_PREFIXES: &[&str] = &[
    "https://github.com/qx04222/tripcut-studio/releases",
    "x-apple.systempreferences:com.apple.preference.security",
];

#[tauri::command]
fn open_url(url: String) -> std::result::Result<(), String> {
    if !ALLOWED_URL_PREFIXES.iter().any(|prefix| url.starts_with(prefix)) {
        return Err("这个链接不在允许打开的名单里".to_owned());
    }
    run_open_command([std::ffi::OsStr::new(url.as_str())]).map_err(|error| error.to_string())
}

#[cfg(test)]
mod open_url_tests {
    /// 白名单是这条命令唯一的守卫——放开了就是一个任意 `open` 的口子。
    #[test]
    fn only_the_two_allowed_prefixes_pass() {
        let allowed = |url: &str| super::ALLOWED_URL_PREFIXES.iter().any(|prefix| url.starts_with(prefix));
        assert!(allowed("https://github.com/qx04222/tripcut-studio/releases/latest"));
        assert!(allowed("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"));
        assert!(!allowed("https://example.com/"));
        assert!(!allowed("file:///Users/xin/.ssh/id_rsa"));
        assert!(!allowed("x-apple.systempreferences:com.apple.preference.other"));
    }
}

/// F2:用户在确认框里点了「仍要退出」。设标志位后真正退出——
/// 标志位是给第二次 `CloseRequested` 看的,没有它 `prevent_close()` 会把应用锁死在开着的状态。
#[tauri::command]
fn confirm_exit(app: tauri::AppHandle, state: tauri::State<'_, exit_guard::ExitState>) {
    state.confirm();
    app.exit(0);
}

#[tauri::command]
fn get_media_server_info(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<MediaServerInfo, String> {
    Ok(state.media_server.clone())
}

#[tauri::command]
fn get_app_info(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<AppInfo, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let db_schema_version =
        core::db::schema_version(&connection).map_err(|error| error.to_string())?;
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        db_schema_version,
        worker_count: state.worker_count,
        read_only: state.read_only,
    })
}






#[tauri::command]
fn search_everything(
    query: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<core::global_search::GlobalSearchHit>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::global_search::search_everything(&connection, &query).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_ocr_hits(
    clip_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<core::ocr::OcrTextHit>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::ocr::list_hits(&connection, clip_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn enqueue_ocr_for_episode(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<usize, String> {
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::ocr::enqueue_for_episode(&mut connection, &state.cache_root).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_memory_lens(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<core::channel_memory::MemoryLensEntry>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::channel_memory::memory_lens(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_routine_override(
    clip_id: i64,
    treatment: Option<String>,
    cleared: bool,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    if treatment.is_none() && !cleared {
        core::routine_override::remove_override(&mut connection, clip_id).map_err(|error| error.to_string())
    } else {
        core::routine_override::set_override(&mut connection, clip_id, treatment.as_deref(), cleared)
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn accept_all_routine_suggestions(
    suggestions: Vec<(i64, String)>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<u64, String> {
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::routine_override::accept_all(&mut connection, &suggestions).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_narrative_revision(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Option<core::narrative_revision::RevisionInfo>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let episode = core::episode::current_episode(&connection).map_err(|error| error.to_string())?;
    core::narrative_revision::revision_info(&connection, episode.id).map_err(|error| error.to_string())
}

#[tauri::command]
fn apply_narrative_op(
    op: core::narrative_revision::NarrativeOp,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::narrative_revision::RevisionInfo, String> {
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let episode = core::episode::current_episode(&connection).map_err(|error| error.to_string())?;
    core::narrative_revision::apply_op(&mut connection, episode.id, op).map_err(|error| error.to_string())
}

#[tauri::command]
fn undo_narrative_op(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Option<core::narrative_revision::RevisionInfo>, String> {
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let episode = core::episode::current_episode(&connection).map_err(|error| error.to_string())?;
    core::narrative_revision::undo_last(&mut connection, episode.id).map_err(|error| error.to_string())
}

#[tauri::command]
/// Z-14:`episode_id` 是新增的可选参数(只读查看已封存集时传被查看的集);不传 = 当前集。
fn list_story_gaps(
    episode_id: Option<i64>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<core::story_gap::StoryGap>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::story_gap::list_for(&connection, episode_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn detect_story_gaps(state: tauri::State<'_, RuntimeState>) -> std::result::Result<usize, String> {
    if state.read_only {
        return Err("只读窗口不能检测缺口".into());
    }
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::story_gap::detect(&mut connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn dismiss_story_gap(
    gap_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    if state.read_only {
        return Err("只读窗口不能忽略缺口".into());
    }
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::story_gap::dismiss(&mut connection, gap_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn reopen_story_gap(
    gap_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    if state.read_only {
        return Err("只读窗口不能恢复缺口".into());
    }
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::story_gap::reopen(&mut connection, gap_id).map_err(|error| error.to_string())
}


struct InstallTask {
    running: std::sync::Arc<std::sync::atomic::AtomicBool>,
    result: std::sync::Arc<Mutex<Option<std::result::Result<String, String>>>>,
}

#[derive(Default)]
struct ProvisioningState {
    tasks: Mutex<std::collections::HashMap<String, InstallTask>>,
}


#[tauri::command]
fn list_watched_folders(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<core::import::WatchedFolder>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::import::list_watched_folders(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_watched_folder_sync(
    id: i64,
    auto_sync: bool,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::import::set_watched_folder_sync(&connection, id, auto_sync).map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_watched_folder(
    id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::import::remove_watched_folder(&connection, id).map_err(|error| error.to_string())
}

#[tauri::command]
fn rescan_watched_folders(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::import::RescanOutcome, String> {
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    // Z-07:手动「立即扫描」顺带做一轮原片存活检查(移走 / 拔卡的素材从这里进缺失页)。
    if let Err(error) = core::media_source::refresh_missing_flags(&connection, None) {
        tracing::warn!(%error, "missing-source refresh during manual rescan failed");
    }
    core::import::rescan_watched_folders(&mut connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_component_statuses(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<core::provisioning::ComponentStatus>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::provisioning::component_statuses(&connection).map_err(|error| error.to_string())
}

/// R10 U-24:把用户自己下载的 Whisper 模型文件校验 SHA-256 后复制进 models 目录。
/// 算摘要要读 0.5–1.6 GB,放到阻塞线程池,不卡 IPC。
#[tauri::command]
async fn import_whisper_model(
    path: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::provisioning::WhisperModelImportOutcome, String> {
    if state.read_only {
        return Err("只读窗口不能导入模型".into());
    }
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let connection = core::db::open_project(&db_path)?;
        core::provisioning::import_whisper_model(&connection, &PathBuf::from(path))
    })
    .await
    .map_err(|error| format!("模型导入异常结束：{error}"))?
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn rollback_component(
    component: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::provisioning::ComponentStatus, String> {
    if state.read_only {
        return Err("只读窗口不能回滚组件".into());
    }
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let model_tier =
        core::settings::whisper_model_tier(&connection).map_err(|error| error.to_string())?;
    core::provisioning::rollback_component_guarded(&connection, &component, &model_tier)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn start_component_install(
    component: String,
    state: tauri::State<'_, RuntimeState>,
    provisioning: tauri::State<'_, ProvisioningState>,
) -> std::result::Result<(), String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let model_tier =
        core::settings::whisper_model_tier(&connection).map_err(|error| error.to_string())?;
    let mut tasks = provisioning
        .tasks
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(existing) = tasks.get(&component) {
        if existing.result.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_none() {
            return Err("该组件正在安装中".to_owned());
        }
    }
    let running = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let result = std::sync::Arc::new(Mutex::new(None));
    let task_running = running.clone();
    let task_result = result.clone();
    let task_component = component.clone();
    std::thread::spawn(move || {
        let outcome = core::provisioning::install_component(&task_component, &model_tier, task_running)
            .map_err(|error| error.to_string());
        *task_result
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(outcome);
    });
    tasks.insert(component, InstallTask { running, result });
    Ok(())
}

#[tauri::command]
fn get_install_progress(
    component: String,
    state: tauri::State<'_, RuntimeState>,
    provisioning: tauri::State<'_, ProvisioningState>,
) -> std::result::Result<core::provisioning::InstallProgress, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let model_tier =
        core::settings::whisper_model_tier(&connection).map_err(|error| error.to_string())?;
    let tasks = provisioning
        .tasks
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (done, error) = match tasks.get(&component) {
        Some(task) => match task
            .result
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
        {
            Some(Ok(_)) => (true, None),
            Some(Err(message)) => (true, Some(message.clone())),
            None => (false, None),
        },
        None => (false, None),
    };
    let downloaded = core::provisioning::download_progress(&component, &model_tier)
        .unwrap_or(0);
    Ok(core::provisioning::InstallProgress {
        component,
        phase: if done { "done".into() } else { "downloading".into() },
        downloaded_bytes: downloaded,
        total_hint_mb: 0,
        done,
        error,
    })
}

#[tauri::command]
fn cancel_component_install(
    component: String,
    provisioning: tauri::State<'_, ProvisioningState>,
) -> std::result::Result<(), String> {
    let tasks = provisioning
        .tasks
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(task) = tasks.get(&component) {
        task.running.store(false, std::sync::atomic::Ordering::Release);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// R19 P-06:模型一键到位(清单见 core/model_catalog.rs,下载见 core/model_download.rs)。
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_models(
    state: tauri::State<'_, RuntimeState>,
    registry: tauri::State<'_, core::model_registry::DownloadRegistry>,
) -> std::result::Result<Vec<core::model_registry::ModelCard>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let profile = core::memory_profile::resolve(&connection).map_err(|error| error.to_string())?;
    let models_dir = core::provisioning::models_dir().map_err(|error| error.to_string())?;
    Ok(core::model_registry::model_cards(&models_dir, profile, &registry))
}

/// 装完之后的「启用」:whisper 模型登记为当前档;CLIP 模型就位后把此前因缺模型 blocked 的
/// `clip_embed` 任务重新排队(R18 0046–0048 的 interest / 帧级向量 / 去重随之生效)。
fn after_model_installed(db_path: &std::path::Path, cache_root: &std::path::Path, spec: &core::model_catalog::ModelSpec) {
    let result: core::error::Result<()> = (|| {
        let mut connection = core::db::open_project(db_path)?;
        match spec.kind {
            core::model_catalog::ModelKind::Whisper { tier } => {
                core::settings::set_setting(&connection, core::settings::WHISPER_MODEL_TIER_KEY, tier)?;
                tracing::info!(tier, "whisper 模型已下载并登记为当前档");
            }
            core::model_catalog::ModelKind::Clip => {
                if core::memory_profile::sidecars_enabled(&connection) {
                    let requeued = core::clip_search::enqueue_missing(&mut connection, cache_root)?;
                    tracing::info!(requeued, "画面理解模型已就位,补排 CLIP 向量任务");
                }
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        tracing::warn!(%error, model = spec.id, "模型装完后的启用步骤失败");
    }
}

#[tauri::command]
fn start_model_download(
    model_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeState>,
    registry: tauri::State<'_, core::model_registry::DownloadRegistry>,
) -> std::result::Result<(), String> {
    if state.read_only {
        return Err("只读窗口不能安装模型".into());
    }
    let spec = core::model_catalog::spec_for_id(&model_id).ok_or_else(|| format!("清单里没有模型 {model_id}"))?;
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let profile = core::memory_profile::resolve(&connection).map_err(|error| error.to_string())?;
    if !spec.allowed_on(profile) {
        return Err(format!("{} 需要 16 GB 及以上内存,这台机器不装", spec.title));
    }
    let models_dir = core::provisioning::models_dir().map_err(|error| error.to_string())?;
    let db_path = state.db_path.clone();
    let cache_root = state.cache_root.clone();
    registry
        .start(spec, models_dir, core::model_download::DownloadOptions::default(), move |event| {
            if let core::model_download::ModelProgress::Installed { .. } = event {
                after_model_installed(&db_path, &cache_root, spec);
            }
            if let Err(error) = app.emit(core::model_download::PROGRESS_EVENT, event) {
                tracing::warn!(%error, "模型下载进度事件发送失败");
            }
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn cancel_model_download(
    model_id: String,
    registry: tauri::State<'_, core::model_registry::DownloadRegistry>,
) {
    registry.cancel(&model_id);
}

#[tauri::command]
fn open_provider_login(provider: String) -> std::result::Result<(), String> {
    if std::env::var_os("TRIPCUT_DISABLE_LLM_PROVIDERS").is_some() {
        return Err("当前 QA 会话已隔离真实 AI 账号，不会打开登录终端".to_owned());
    }
    let command = match provider.as_str() {
        "claude" => "claude",
        "codex" => "codex login",
        "kimi" => "kimi",
        _ => return Err(format!("未知 provider:{provider}")),
    };
    // 打开 Terminal 执行登录命令;OAuth 流会拉起浏览器,完成后用户回 app 重新检测。
    let script = format!(
        "tell application \"Terminal\"\n activate\n do script \"{command}\"\nend tell"
    );
    std::process::Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .status()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_episodes(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<core::episode::EpisodeSummary>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::episode::list_episodes(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_current_episode(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::episode::EpisodeSummary, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::episode::current_episode(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn rename_current_episode(
    title: String,
    theme: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::episode::EpisodeSummary, String> {
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::episode::rename_current(&mut connection, &title, &theme).map_err(|error| error.to_string())
}

/// R16 P2-3:任意一集改名(切集弹层与首页卡的「重命名」)。
#[tauri::command]
fn rename_episode(
    episode_id: i64,
    title: String,
    theme: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::episode::EpisodeSummary, String> {
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::episode::rename_episode(&mut connection, episode_id, &title, &theme).map_err(|error| error.to_string())
}

/// R17 epmove:把素材挪到另一集(媒体池 / 检查器菜单「移到其他集…」)。返回旧归属供撤销反向再调。
#[tauri::command]
fn move_clips_to_episode(
    clip_ids: Vec<i64>,
    episode_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::episode::MoveOutcome, String> {
    if state.read_only {
        return Err("只读窗口不能移动素材,请回到主窗口操作".to_owned());
    }
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let outcome = core::episode::move_clips_to_episode(&mut connection, &clip_ids, episode_id)
        .map_err(|error| error.to_string())?;
    tracing::warn!(
        episode_id,
        requested = clip_ids.len(),
        moved = outcome.moved,
        skipped_missing = outcome.skipped_missing,
        from = ?outcome.from,
        "command move_clips_to_episode: rehoming clips to another episode"
    );
    Ok(outcome)
}

#[tauri::command]
fn archive_current_episode(
    next_title: Option<String>,
    next_platform: Option<String>,
    next_orientation: Option<String>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::episode::ArchiveOutcome, String> {
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::episode::archive_current_with_platform(
        &mut connection,
        next_title.as_deref(),
        next_platform.as_deref(),
        next_orientation.as_deref(),
    )
    .map_err(|error| error.to_string())
}

/// R10 U-16:新建集(名称必填)。当前集有素材 → 封存并切到新集;当前集为空 → 就地改名复用。
#[tauri::command]
fn create_episode(
    title: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::episode::CreateEpisodeOutcome, String> {
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::episode::create_episode(&mut connection, &title).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_platform_presets(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<core::platform::PlatformPreset>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::platform::list_platform_presets(&connection).map_err(|error| error.to_string())
}

/// R15:删除一集(历史集或当前集)。先取消这一集的任务、暂停认领、等相关任务退出
/// (≤ 5 s)、打快照,再单事务删除;缓存目录交给 cache_gc 后台删。
#[tauri::command]
async fn delete_episode(
    episode_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::episode::DeleteEpisodeOutcome, String> {
    if state.read_only {
        return Err("只读窗口不能删除集".to_owned());
    }
    let control = state.worker_control.clone().ok_or("后台任务控制器不可用")?;
    let path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<core::episode::DeleteEpisodeOutcome> {
        let mut connection = core::db::open_project(&path)?;
        core::episode::prepare_delete(&mut connection, episode_id)?;
        let gate = core::import::import_gate(&connection);
        drop(connection);
        let _import_guard = gate.lock().unwrap_or_else(|error| error.into_inner());
        let outcome = control.with_claims_paused(
            || {
                let mut c = core::db::open_project(&path)?;
                core::episode::prepare_delete(&mut c, episode_id).map(|_| ())
            },
            || {
                let mut c = core::db::open_project(&path)?;
                let ids = core::episode::prepare_delete(&mut c, episode_id)?;
                core::import_control::wait_for_related_jobs(&c, &ids, std::time::Duration::from_secs(5))?;
                core::db::create_snapshot(&c, &path.parent().unwrap().join("snapshots"))?;
                tracing::warn!(episode_id, clips = ids.len(), "command delete_episode: deleting episode with its clips and import batches");
                core::episode::delete_episode(&mut c, episode_id)
            },
        )?;
        control.wake_worker();
        Ok(outcome)
    })
    .await
    .map_err(|error| format!("删除集任务异常结束:{error}"))?
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_episode_platform(
    episode_id: i64,
    platform: String,
    orientation: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::platform::set_episode_platform(&mut connection, episode_id, &platform, &orientation)
        .map_err(|error| error.to_string())
}


/// R18 W-4:窗口起来之后才跑的启动补扫(12 个增量入队 + 启动快照)。
/// 见 `setup()` 末尾那段注释:开窗前只留存活检查与 census。
const STARTUP_BACKFILL_EVENT: &str = "tripcut:startup-backfill";

fn startup_backfill(
    db_path: &std::path::Path,
    cache_root: &std::path::Path,
    snapshots_root: &std::path::Path,
    report: &std::sync::Arc<std::sync::Mutex<core::doctor::DoctorReport>>,
) -> core::error::Result<()> {
    let mut connection = core::db::open_project(db_path)?;
    let metadata_jobs = core::import::enqueue_metadata_backfill(&mut connection)?;
    if metadata_jobs > 0 {
        tracing::info!(metadata_jobs, "enqueued incremental temporal metadata backfill");
    }
    // R6 Task 7d 修复 High:补上封面已落盘、胶片条任务却从未存在过的窗口
    // (进程在 `finalize_artifacts` 和 `enqueue_strip` 之间死掉)。
    let strip_jobs = core::artifacts::enqueue_missing_strips(&mut connection)?;
    if strip_jobs > 0 {
        tracing::info!(strip_jobs, "enqueued missing film-strip jobs");
    }
    let photo_cover_jobs=core::photo_decode::enqueue_missing_covers(&mut connection,cache_root)?;
    if photo_cover_jobs>0 {
        tracing::info!(photo_cover_jobs,"enqueued missing photo cover jobs");
    }
    let photo_preview_jobs=core::photo_decode::enqueue_missing_previews(&mut connection,cache_root)?;
    if photo_preview_jobs>0 {
        tracing::info!(photo_preview_jobs,"enqueued missing photo preview jobs");
    }
    let clip_embeddings = if core::memory_profile::sidecars_enabled(&connection) {
        core::clip_search::enqueue_missing(&mut connection, cache_root)?
    } else {
        0
    };
    if clip_embeddings > 0 {
        tracing::info!(clip_embeddings, "enqueued missing Chinese-CLIP embeddings");
    }
    let analysis_jobs = core::analysis::enqueue_missing(&mut connection)?;
    if analysis_jobs > 0 {
        tracing::info!(analysis_jobs, "enqueued L1 re-analysis for outdated pipeline version");
    }
    let motion_jobs = core::motion::enqueue_missing(&mut connection)?;
    if motion_jobs > 0 {
        tracing::info!(motion_jobs, "enqueued motion v3 endpoint analysis");
    }
    // R11:老库已分析、没时刻分的素材增量补齐。
    let moment_jobs = core::moments::enqueue_missing(&mut connection)?;
    if moment_jobs > 0 {
        tracing::info!(moment_jobs, "enqueued moment-score backfill");
    }
    let dimension_jobs =
        core::clip_dimensions::enqueue_missing(&mut connection, cache_root)?;
    if dimension_jobs > 0 {
        tracing::info!(dimension_jobs, "enqueued missing eight-dimension labels");
    }
    if let Some(job_id) = core::similar::enqueue_if_ready(&mut connection)? {
        tracing::info!(job_id, "enqueued similar clip clustering");
    }
    if let Some(job_id) = core::story::enqueue_if_import_complete(&mut connection)? {
        tracing::info!(job_id, "enqueued automatic chapterization");
    }
    if let Some(job_id) = core::canonical_time::enqueue_align_if_ready(&mut connection)? {
        tracing::info!(job_id, "enqueued multi-device clock alignment");
    }
    let safety_changes = core::asset_safety::refresh_all(&mut connection)?;
    if safety_changes > 0 {
        tracing::info!(safety_changes, "updated non-destructive asset safety flags");
    }
    let shot_stack_count = core::shot_stack::rebuild(&mut connection)?;
    tracing::info!(shot_stack_count, "rebuilt semantic shot stacks");

    let snapshot = core::db::create_snapshot(&connection, snapshots_root);
    report
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .record_snapshot(snapshots_root, &snapshot);
    if let Err(error) = snapshot {
        tracing::warn!(%error, "could not create startup database snapshot");
    }

    Ok(())
}

#[tauri::command]
fn get_settings(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<BTreeMap<String, String>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::settings::get_settings(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_setting(
    key: String,
    value: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    if key.starts_with("best_take.weight.") {
        core::shot_stack::update_weight_and_rescore(&mut connection, &key, &value)
            .map_err(|error| error.to_string())?;
    } else {
        core::settings::set_setting(&connection, &key, &value)
            .map_err(|error| error.to_string())?;
    }
    if key == core::settings::CLIP_MODEL_DIR_KEY {
        // R19 P-06:侧车 spawn 时没有数据库连接,覆盖值放一份在进程内。
        let trimmed = value.trim();
        core::model_catalog::set_clip_model_dir_override((!trimmed.is_empty()).then(|| PathBuf::from(trimmed)));
    }
    Ok(())
}

/// R10 U-22:首启引导是否已跳过/完成(`onboarding.first_run_done`)。
#[tauri::command]
fn get_first_run_done(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<bool, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::settings::first_run_done(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_first_run_done(
    done: bool,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::settings::set_first_run_done(&connection, done).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_llm_status(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<LlmStatus, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::llm::status(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_llm_ledger(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<LlmLedgerEntry>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::llm::recent_ledger(&connection).map_err(|error| error.to_string())
}

// R7 Task 7:「云端补镜（MiniMax）」设置分区——Key 只经 Keychain 往返,永不
// 落库、永不出现在日志或这几个命令的返回值里。`generation_availability` /
// `generation_ledger_summary` 与 Task 5 缺口检测车道同名共享,这里先落地
// 读取端与设置页需要的形状,后续任务接线时按同名函数去重。
#[tauri::command]
fn set_minimax_key(
    key: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    core::generation_settings::guard_writable(state.read_only).map_err(|error| error.to_string())?;
    let trimmed = core::generation_settings::validate_key_input(&key).map_err(|error| error.to_string())?;
    core::secret::store_minimax_key(&trimmed).map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_minimax_key(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    core::generation_settings::guard_writable(state.read_only).map_err(|error| error.to_string())?;
    core::secret::clear_minimax_key().map_err(|error| error.to_string())
}

#[tauri::command]
fn has_minimax_key() -> std::result::Result<bool, String> {
    core::secret::has_minimax_key().map_err(|error| error.to_string())
}

#[tauri::command]
fn generation_availability(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<GenerationAvailability, String> {
    let has_key = core::secret::has_minimax_key().map_err(|error| error.to_string())?;
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::generation_settings::availability(&connection, has_key).map_err(|error| error.to_string())
}

#[tauri::command]
fn generation_ledger_summary(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<GenerationLedgerSummary, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::generation_settings::ledger_summary(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_ai_description(
    clip_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Option<AiDescriptionResult>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::llm::latest_ai_description(&connection, clip_id).map_err(|error| error.to_string())
}

/// R18 AI-A1:本地描述。不调模型、不联网、不花预算 —— 8 GB 机器上也有。
#[tauri::command]
fn get_clip_brief(
    clip_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Option<String>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::clip_brief::get_clip_brief(&connection, clip_id).map_err(|error| error.to_string())
}

#[tauri::command]
async fn describe_clip_with_ai(
    clip_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<AiDescriptionResult, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || -> core::error::Result<_> {
        let mut connection = core::db::open_project(&db_path)?;
        let result = core::llm::describe_clip(&mut connection, clip_id)?;
        core::asset_safety::refresh_all(&mut connection)?;
        core::shot_stack::rebuild(&mut connection)?;
        Ok(result)
    })
    .await
    .map_err(|error| format!("AI 描述任务异常结束：{error}"))?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn ask_director(
    question: String,
    context: DirectorContext,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<DirectorAnswerResult, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = core::db::open_project(&db_path)?;
        core::llm::ask_director(&mut connection, &question, &context)
    })
    .await
    .map_err(|error| format!("导演问答任务异常结束：{error}"))?
    .map_err(|error| error.to_string())
}

// ---- R17 车道 A:应用内自动升级(实现见 update_flow.rs;前端接线由车道 B 做) ----

/// 问一次端点。断网/超时静默(`offline: true`),不算错误。成功时顺手写 `updater.last_check`。
#[tauri::command]
async fn check_for_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<update_flow::UpdateCheck, String> {
    let skipped = {
        let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
        core::settings::string_value(&connection, core::settings::UPDATER_SKIPPED_VERSION_KEY, "")
            .map_err(|error| error.to_string())?
    };
    let check = update_flow::check(&app, &skipped).await?;
    if !check.offline && !state.read_only {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or(0);
        let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
        if let Err(error) = core::settings::set_setting(
            &connection,
            core::settings::UPDATER_LAST_CHECK_KEY,
            &now.to_string(),
        ) {
            tracing::warn!(%error, "could not record updater.last_check");
        }
    }
    Ok(check)
}

/// 后台下载并暂存(签名校验过才暂存);不替换 bundle,不挡界面。进度走 `tripcut:update-progress`。
#[tauri::command]
async fn download_update(app: tauri::AppHandle) -> std::result::Result<String, String> {
    update_flow::download(&app).await
}

/// 下载 + 立即替换 bundle(设置页「下载并安装」那条手动路径)。重启后生效。
#[tauri::command]
async fn download_and_install(app: tauri::AppHandle) -> std::result::Result<String, String> {
    let version = update_flow::download(&app).await?;
    update_flow::install_staged(&app)?;
    Ok(version)
}

/// 把暂存包装进去;返回装了哪个版本(没有暂存则 null)。
#[tauri::command]
fn install_staged_update(app: tauri::AppHandle) -> std::result::Result<Option<String>, String> {
    update_flow::install_staged(&app)
}

/// 「立即重启」:有暂存包先装,再重启进程。
#[tauri::command]
fn restart_to_update(app: tauri::AppHandle) -> std::result::Result<(), String> {
    update_flow::install_staged(&app)?;
    app.restart()
}

/// 启动时问一句:开关开着且离上次检查超过 6 小时才 `should_check_now`——端点检查便宜但不白问。
#[tauri::command]
fn get_auto_update_plan(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<update_flow::AutoUpdatePlan, String> {
    use core::settings::{
        string_value, UPDATER_ASK_BEFORE_DOWNLOAD_KEY, UPDATER_AUTO_UPDATE_KEY, UPDATER_LAST_CHECK_KEY,
    };
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let auto_update = string_value(&connection, UPDATER_AUTO_UPDATE_KEY, "true").map_err(|error| error.to_string())?;
    let ask = string_value(&connection, UPDATER_ASK_BEFORE_DOWNLOAD_KEY, "false").map_err(|error| error.to_string())?;
    let last_check = string_value(&connection, UPDATER_LAST_CHECK_KEY, "").map_err(|error| error.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    Ok(update_flow::AutoUpdatePlan {
        auto_update: auto_update == "true",
        ask_before_download: ask == "true",
        should_check_now: update_flow::should_auto_check(&auto_update, Some(last_check.as_str()), now),
    })
}

#[tauri::command]
fn get_update_status(app: tauri::AppHandle) -> update_flow::UpdateStatus {
    update_flow::status(&app)
}

#[tauri::command]
async fn get_settings_status(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<SettingsStatus, String> {
    let db_path = state.db_path.clone();
    let cache_root = state.cache_root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let connection = core::db::open_project(&db_path)?;
        core::settings::status(&connection, &cache_root)
    })
    .await
    .map_err(|error| format!("设置状态检测异常结束：{error}"))?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn clear_cache_and_rebuild(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<CacheRebuildResult, String> {
    let db_path = state.db_path.clone();
    let cache_root = state.cache_root.clone();
    let worker_control = state
        .worker_control
        .clone()
        .ok_or_else(|| "只读实例不能清理缓存".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || rebuild_cache_blocking(&db_path, &cache_root, &worker_control))
        .await
        .map_err(|error| format!("缓存重建任务异常结束：{error}"))?
        .map_err(|error| error.to_string())
}

/// R15:设置页的「重置项目库」。清空整个项目库(素材 / 集 / 片段 / 收藏 / 任务 / 导入记录),
/// 保留设置 / 键位 / 引导;先打快照。
#[tauri::command]
async fn reset_project_library(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::settings::ResetLibraryResult, String> {
    if state.read_only {
        return Err("只读窗口不能重置项目库".to_owned());
    }
    let db_path = state.db_path.clone();
    let cache_root = state.cache_root.clone();
    let worker_control = state
        .worker_control
        .clone()
        .ok_or_else(|| "只读实例不能重置项目库".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let connection = core::db::open_project(&db_path)?;
        let gate = core::import::import_gate(&connection);
        drop(connection);
        let _import_guard = gate.lock().unwrap_or_else(|error| error.into_inner());
        reset_library_blocking(&db_path, &cache_root, Some(&worker_control), "command reset_project_library (settings sheet)")
    })
    .await
    .map_err(|error| format!("重置项目库任务异常结束：{error}"))?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn run_clip_self_check() -> std::result::Result<String, String> {
    tauri::async_runtime::spawn_blocking(core::sidecar::ping)
        .await
        .map_err(|error| format!("CLIP 自检任务异常结束：{error}"))?
        .map(|()| "Chinese-CLIP ping 通过".to_owned())
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn pick_import_folder() -> std::result::Result<Option<String>, String> {
    Ok(rfd::AsyncFileDialog::new()
        .set_title("选择素材文件夹")
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().into_owned()))
}

#[tauri::command]
async fn pick_music_file() -> std::result::Result<Option<String>, String> {
    Ok(rfd::AsyncFileDialog::new()
        .set_title("选择配乐文件")
        .add_filter("音频", &["mp3", "wav", "m4a", "aac", "flac", "aiff", "ogg"])
        .pick_file()
        .await
        .map(|file| file.path().to_string_lossy().into_owned()))
}

#[tauri::command]
async fn pick_relink_folder() -> std::result::Result<Option<String>, String> {
    Ok(rfd::AsyncFileDialog::new()
        .set_title("选择新挂载位置")
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().into_owned()))
}

/// R10 U-24:「导入模型文件…」的文件选择;命令只选路径,校验与落位在 `import_whisper_model`。
#[tauri::command]
async fn pick_whisper_model_file() -> std::result::Result<Option<String>, String> {
    Ok(rfd::AsyncFileDialog::new()
        .set_title("选择转写模型文件")
        .add_filter("转写模型", &["bin"])
        .pick_file()
        .await
        .map(|file| file.path().to_string_lossy().into_owned()))
}

/// R10 U-28:「添加 LUT…」的文件选择;校验与复制在 `import_lut`。
#[tauri::command]
async fn pick_lut_file() -> std::result::Result<Option<String>, String> {
    Ok(rfd::AsyncFileDialog::new()
        .set_title("选择 .cube LUT 文件")
        .add_filter("LUT", &["cube", "CUBE"])
        .pick_file()
        .await
        .map(|file| file.path().to_string_lossy().into_owned()))
}

/// 交付包 / 快速导出共用的文件夹面板。`title` 由调用方按模式给(R13 真机 Y-08:快速导出
/// 传「选择导出文件夹」);不传仍是交付包那句,旧调用方一字不动。
#[tauri::command]
async fn pick_export_folder(title: Option<String>) -> std::result::Result<Option<String>, String> {
    if let Some(directory) = isolated_export_directory(
        std::env::var_os("TRIPCUT_EXPORT_DIR").map(PathBuf::from),
        std::env::var_os("TRIPCUT_APP_SUPPORT_DIR").map(PathBuf::from),
    )? {
        return Ok(Some(directory));
    }
    Ok(rfd::AsyncFileDialog::new()
        .set_title(title.as_deref().unwrap_or("选择交付包保存位置"))
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().into_owned()))
}

#[tauri::command]
async fn start_import(
    path: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<ImportStart, String> {
    if state.read_only { return Err("只读窗口不能导入素材".into()); }
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = core::db::open_project(&db_path)?;
        core::import::start_import(&mut connection, &PathBuf::from(path))
    })
    .await
    .map_err(|error| format!("导入扫描任务异常结束：{error}"))?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn import_paths(
    paths: Vec<String>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<ImportStart>, String> {
    if state.read_only { return Err("只读窗口不能导入素材".into()); }
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = core::db::open_project(&db_path)?;
        let mut results = Vec::new();
        let mut files = Vec::new();
        for raw in paths {
            let path = PathBuf::from(raw);
            if path.is_dir() {
                results.push(core::import::start_import(&mut connection, &path)?);
            } else {
                files.push(path);
            }
        }
        if !files.is_empty() {
            results.push(core::import::start_import_files(&mut connection, &files)?);
        }
        Ok(results)
    })
    .await
    .map_err(|error| format!("导入扫描任务异常结束：{error}"))?
    .map_err(|error: CoreError| error.to_string())
}

#[tauri::command]
fn list_import_batches(state: tauri::State<'_, RuntimeState>) -> std::result::Result<Vec<core::import_control::ImportBatch>, String> {
    core::db::open_project(&state.db_path).and_then(|c| core::import_control::list_batches(&c)).map_err(|e| e.to_string())
}
#[tauri::command]
async fn cancel_import_batch(id: i64, state: tauri::State<'_, RuntimeState>) -> std::result::Result<(), String> {
    if state.read_only { return Err("只读窗口不能取消导入".into()); }
    let path = state.db_path.clone();
    let control=state.worker_control.clone().ok_or("后台任务控制器不可用")?;
    tauri::async_runtime::spawn_blocking(move || control.with_maintenance(
        || core::db::open_project(&path).and_then(|mut c| core::import_control::cancel_batch(&mut c,id)),
        || core::db::open_project(&path).and_then(|mut c| core::import_control::cancel_batch(&mut c,id))))
        .await.map_err(|e|e.to_string())?.map_err(|e|e.to_string())
}
#[tauri::command]
fn dismiss_import_notices(state: tauri::State<'_, RuntimeState>) -> std::result::Result<usize, String> {
    if state.read_only { return Err("只读窗口不能清理记录".into()); }
    core::db::open_project(&state.db_path).and_then(|c| core::import_control::dismiss_notices(&c)).map_err(|e|e.to_string())
}
#[tauri::command]
fn preview_import_removal(request: core::import_control::RemovalRequest, state: tauri::State<'_, RuntimeState>) -> std::result::Result<core::import_control::RemovalPreview, String> {
    core::db::open_project(&state.db_path).and_then(|c| core::import_control::preview(&c,&request)).map_err(|e|e.to_string())
}
#[tauri::command]
async fn remove_imported_material(request: core::import_control::RemovalRequest, state: tauri::State<'_, RuntimeState>) -> std::result::Result<usize, String> {
    if state.read_only { return Err("只读窗口不能移除素材".into()); }
    let control = state.worker_control.clone().ok_or("后台任务控制器不可用")?;
    let path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<usize> {
        let mut connection=core::db::open_project(&path)?;
        // Stop scans before waiting for their gate, so a large NAS traversal
        // cannot make the removal button wait for a complete directory walk.
        core::import_control::prepare_removal(&mut connection,&request)?;
        let gate=core::import::import_gate(&connection);
        drop(connection);
        let _import_guard=gate.lock().unwrap_or_else(|e|e.into_inner());
        // R15:只暂停认领,不等无关任务;本次范围内的任务已被取消,最多等它们几秒退出。
        // 缓存目录交给 cache_gc 后台删,命令在数据库提交后立刻返回。
        let count = control.with_claims_paused(
            || { let mut c=core::db::open_project(&path)?; core::import_control::prepare_removal(&mut c,&request).map(|_| ()) },
            || {
                let mut c=core::db::open_project(&path)?;
                let ids=core::import_control::removal_ids(&c,&request)?;
                core::import_control::wait_for_related_jobs(&c,&ids,std::time::Duration::from_secs(5))?;
                core::db::create_snapshot(&c,&path.parent().unwrap().join("snapshots"))?;
                tracing::warn!(all = request.all, batch_id = ?request.batch_id, requested = request.clip_ids.len(), clips = ids.len(), "command remove_imported_material: deleting clips");
                core::import_control::remove_records(&mut c,&request)
            }
        )?;
        control.wake_worker();
        Ok(count)
    }).await.map_err(|e|e.to_string())?.map_err(|e|e.to_string())
}

#[tauri::command]
fn get_import_progress(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<ImportProgress, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let mut progress =
        core::import::get_import_progress(&connection).map_err(|error| error.to_string())?;
    // 内存压力暂停时界面要说明原因,否则用户只看到进度条不动。
    progress.paused_for_memory = state
        .worker_control
        .as_ref()
        .is_some_and(core::jobs::WorkerControl::pause_state);
    // R16 §3⑤:不认领重活的原因(memory / thermal / idle_wait),状态条据此说人话。
    progress.paused_reason = state
        .worker_control
        .as_ref()
        .and_then(core::jobs::WorkerControl::pause_reason);
    // 解码类吃满许可时,把还在排队的解码任务数报给界面,否则界面上只会"停住"。
    if state
        .worker_control
        .as_ref()
        .is_some_and(core::jobs::WorkerControl::decode_saturated)
    {
        progress.waiting_for_permit =
            core::import::pending_decode_count(&connection).map_err(|error| error.to_string())?;
    }
    Ok(progress)
}

#[tauri::command]
fn list_clips(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<ClipListItem>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let mut clips = core::import::list_clips(&connection).map_err(|error| error.to_string())?;
    let cover_urls = core::artifacts::cover_urls(
        &connection,
        &state.cache_root,
        state.media_server.port,
        &state.media_server.token,
    )
    .map_err(|error| error.to_string())?;
    for clip in &mut clips {
        clip.cover_url = clip.id.and_then(|id| cover_urls.get(&id).cloned());
        if let (Some(id),Some(photo)) = (clip.id,clip.photo.as_mut()) {
            if let Some((cover,preview))=core::photo_decode::urls(&connection,&state.cache_root,id,state.media_server.port,&state.media_server.token).map_err(|e|e.to_string())? {
                clip.cover_url=Some(cover); photo.preview_url=preview;
            }
        }
    }
    Ok(clips)
}

/// 只读的「旅程时间线」:当前集的地点卡与素材按标准时间合并排序。
/// `cover_url` 的填法与 `list_clips` 完全同源——`core::journey::timeline`
/// 只管排序与取数,不知道缓存端口/token,由这里事后按 clip_id 补上。
#[tauri::command]
fn get_journey_timeline(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<core::journey::JourneyEntry>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let mut entries = core::journey::timeline(&connection).map_err(|error| error.to_string())?;
    let cover_urls = core::artifacts::cover_urls(
        &connection,
        &state.cache_root,
        state.media_server.port,
        &state.media_server.token,
    )
    .map_err(|error| error.to_string())?;
    for entry in &mut entries {
        entry.cover_url = entry.clip_id.and_then(|id| cover_urls.get(&id).cloned());
    }
    Ok(entries)
}

/// `list_clips` 的廉价前哨:轮询前先比这个字符串,不变就跳过整表拉取。
#[tauri::command]
fn get_clips_revision(state: tauri::State<'_, RuntimeState>) -> std::result::Result<String, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::import::clips_revision(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_missing_clips(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<core::media_source::MissingClip>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    // Z-07:状态条每 3 秒问一次;每分钟最多真 stat 一轮,拔卡 / 移文件夹一分钟内会被发现。
    if !state.read_only {
        if let Err(error) = core::media_source::refresh_missing_flags_throttled(
            &connection,
            std::time::Duration::from_secs(60),
        ) {
            tracing::warn!(%error, "throttled missing-source refresh failed");
        }
    }
    core::media_source::list_missing_clips(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
async fn import_music_track(
    path: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<MusicTrackSummary, String> {
    if state.read_only {
        return Err("只读窗口不能导入音乐".into());
    }
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = core::db::open_project(&db_path)?;
        // 不再信任前端传来的 episode_id——就像 `start_import` 一样，导入永远
        // 落到当前活动集，由服务端解析。
        let episode = core::episode::current_episode(&connection)?;
        core::music::import_track(&mut connection, episode.id, &PathBuf::from(path))
    })
    .await
    .map_err(|error| format!("音乐导入任务异常结束：{error}"))?
    .map_err(|error| error.to_string())
}

/// R10 U-19:状态条「音乐分析 n/m」——当前集音乐轨按 analysis_status 计数。
#[tauri::command]
fn get_music_analysis_progress(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::music::MusicAnalysisProgress, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::music::analysis_progress(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_music_tracks(
    episode_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<MusicTrackSummary>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::music::list_tracks(&connection, episode_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_music_analysis(
    track_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<MusicAnalysis, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::music::get_analysis(&connection, track_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_music_track(
    track_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    if state.read_only {
        return Err("只读窗口不能删除音乐".into());
    }
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::music::delete_track(&connection, track_id).map_err(|error| error.to_string())
}

#[tauri::command]
async fn relink_volume(
    volume_uuid: String,
    new_mount: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::media_source::RelinkOutcome, String> {
    if state.read_only {
        return Err("只读窗口不能重连素材".into());
    }
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = core::db::open_project(&db_path)?;
        core::media_source::relink_volume(&mut connection, &volume_uuid, &PathBuf::from(new_mount))
    })
    .await
    .map_err(|error| format!("重连素材任务异常结束：{error}"))?
    .map_err(|error| error.to_string())
}

/// R16 P1-7:缺失页每条「找到它…」/ 检查器头 → 文件面板选中同名文件 → 单条重绑。
/// 同名 + 时长 ±0.5 s 校验在 `core::media_source::relink_clip`;ffprobe 要跑,放阻塞线程池。
#[tauri::command]
async fn relink_clip(
    clip_id: i64,
    path: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::media_source::RelinkClipOutcome, String> {
    if state.read_only {
        return Err("只读窗口不能重连素材".into());
    }
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = core::db::open_project(&db_path)?;
        core::media_source::relink_clip(&mut connection, clip_id, &PathBuf::from(path))
    })
    .await
    .map_err(|error| format!("重连素材任务异常结束:{error}"))?
    .map_err(|error| error.to_string())
}

/// R16 P1-7:「找到它…」的文件面板;标题带原片文件名,用户一眼知道该选哪个。
#[tauri::command]
async fn pick_relink_file(file_name: String) -> std::result::Result<Option<String>, String> {
    Ok(rfd::AsyncFileDialog::new()
        .set_title(format!("找到 {file_name}"))
        .pick_file()
        .await
        .map(|file| file.path().to_string_lossy().into_owned()))
}

/// R16 P1-6:状态条「全部暂停 / 继续」。worker 不再认领新任务(导出 / 缓存清理除外),
/// 正在跑的跑完;写设置键 `ui.jobs.paused`,下次启动照旧。
#[tauri::command]
fn set_jobs_paused(paused: bool, state: tauri::State<'_, RuntimeState>) -> std::result::Result<bool, String> {
    let control = state.worker_control.clone().ok_or("只读窗口没有后台任务")?;
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::settings::set_setting(&connection, JOBS_PAUSED_KEY, if paused { "true" } else { "false" })
        .map_err(|error| error.to_string())?;
    control.set_paused_by_user(paused);
    Ok(control.paused_by_user())
}

/// R16 P1-6:当前是否被用户暂停(状态条按它画「全部暂停」还是「继续」)。
#[tauri::command]
fn get_jobs_paused(state: tauri::State<'_, RuntimeState>) -> bool {
    state.worker_control.as_ref().is_some_and(core::jobs::WorkerControl::paused_by_user)
}

/// R16 P1-6:导入抽屉「后台任务」页的正在处理列表;每行「取消」走既有 `cancel_job`。
#[tauri::command]
fn list_running_jobs(state: tauri::State<'_, RuntimeState>) -> std::result::Result<Vec<core::jobs::RunningJob>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::jobs::list_running_jobs(&connection).map_err(|error| error.to_string())
}

/// R18 车道 settings M-04:「导出诊断包…」。保存面板选位置 → 摊开 → ditto 打 zip。
/// 包里没有原片、封面、转写、GPS,绝对路径一律脱敏(判据钉在
/// `core::diagnostics::bundle_contains_no_absolute_paths_and_the_grep_would_have_caught_them`)。
#[tauri::command]
async fn export_diagnostics_bundle(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Option<core::diagnostics::DiagnosticsBundle>, String> {
    let db_path = state.db_path.clone();
    let cache_root = state.cache_root.clone();
    let logs_dir = db_path.parent().unwrap_or_else(|| std::path::Path::new(".")).join("logs");
    let suggested = format!(
        "旅剪诊断-{}.zip",
        chrono_like_stamp(),
    );
    let Some(target) = rfd::AsyncFileDialog::new()
        .set_title("把诊断包存到哪里")
        .set_file_name(&suggested)
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let target = target.path().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || -> Result<core::diagnostics::DiagnosticsBundle> {
        let connection = core::db::open_project(&db_path)?;
        core::diagnostics::export_diagnostics_bundle(
            &connection,
            &cache_root,
            &logs_dir,
            env!("CARGO_PKG_VERSION"),
            &target,
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map(Some)
    .map_err(|error| error.to_string())
}

/// 诊断包文件名里的时间戳(本地时区)。仓里没有 chrono,用 SQLite 的 strftime 拿一个
/// —— 反正这一步本来就要开库。
fn chrono_like_stamp() -> String {
    rusqlite::Connection::open_in_memory()
        .and_then(|connection| {
            connection.query_row("SELECT strftime('%Y%m%d-%H%M', 'now', 'localtime')", [], |row| row.get::<_, String>(0))
        })
        .unwrap_or_else(|_| "最新".to_owned())
}

/// R18 车道 settings F5:「更改缓存位置…」的文件夹选择(只选路径,搬迁在 relocate_cache_dir)。
#[tauri::command]
async fn pick_cache_folder() -> std::result::Result<Option<String>, String> {
    Ok(rfd::AsyncFileDialog::new()
        .set_title("选择缓存要放在哪个文件夹里")
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().into_owned()))
}

/// R18 车道 settings F5:把缓存整体搬到用户选的文件夹里。
///
/// 跟 `switch_library` 同一套做法:先用 `with_maintenance` 把后台静下来(搬迁期间不能
/// 有人往旧目录写),搬完 + 写好设置之后**重启**——`cache_root` 是启动时定下来交给
/// `RuntimeState` 的,不重启这一次会话还会往旧位置找。
#[tauri::command]
async fn relocate_cache_dir(
    folder: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::settings::CacheRelocation, String> {
    if state.read_only {
        return Err("只读窗口不能更改缓存位置".into());
    }
    let control = state.worker_control.clone().ok_or("后台任务控制器不可用")?;
    let db_path = state.db_path.clone();
    let cache_root = state.cache_root.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<core::settings::CacheRelocation> {
        let moved = control.with_maintenance(
            || Ok(()),
            || {
                let connection = core::db::open_project(&db_path)?;
                core::settings::relocate_cache_dir(&connection, &cache_root, std::path::Path::new(&folder))
            },
        )?;
        tracing::warn!(new_root = %moved.new_root, files = moved.moved_files, "缓存已搬到新位置,重启使其生效");
        app.restart()
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

/// R18 车道 settings F8:后台任务页的「失败」清单(不含用户自己取消的)。
#[tauri::command]
fn list_failed_jobs(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<core::diagnostics::FailedJob>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::diagnostics::list_failed_jobs(&connection, 200).map_err(|error| error.to_string())
}

/// R18 车道 settings F8:「清空全部失败」——标成已知晓,不删行(失败原因诊断包还要读)。
#[tauri::command]
fn clear_failed_jobs(state: tauri::State<'_, RuntimeState>) -> std::result::Result<usize, String> {
    if state.read_only {
        return Err("只读窗口不能清空失败任务".into());
    }
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::diagnostics::clear_failed_jobs(&connection).map_err(|error| error.to_string())
}

/// R16 P2-4:检查器技术检查段「重新分析这条」——清这条的失败标记、按既有入队逻辑重排。
#[tauri::command]
fn retry_clip_analysis(
    clip_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::import_control::RetryAnalysisOutcome, String> {
    if state.read_only {
        return Err("只读窗口不能重新分析".into());
    }
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let outcome = core::import_control::retry_clip_analysis(&mut connection, clip_id).map_err(|error| error.to_string())?;
    if let Some(control) = state.worker_control.as_ref() {
        control.wake_worker();
    }
    Ok(outcome)
}

/// R16 P2-6:设置 › 工具与模型 › 删除一档已导入的转写模型文件(连 `.prev`);返回释放字节数。
#[tauri::command]
fn delete_whisper_model(tier: String, state: tauri::State<'_, RuntimeState>) -> std::result::Result<u64, String> {
    if state.read_only {
        return Err("只读窗口不能删除模型".into());
    }
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::provisioning::delete_whisper_model(&connection, &tier).map_err(|error| error.to_string())
}

/// R16 P2-6:设置 › 工具与模型 › 删除 `luts/` 里的一个 `.cube`(只认文件名);返回删后列表。
#[tauri::command]
fn delete_display_lut(name: String, state: tauri::State<'_, RuntimeState>) -> std::result::Result<Vec<String>, String> {
    if state.read_only {
        return Err("只读窗口不能删除调色文件".into());
    }
    let root = crate::app_paths::app_support_root().ok_or_else(|| "无法确定应用支持目录".to_owned())?;
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::provisioning::delete_display_lut(&connection, &root.join("luts"), &name)
        .map(|paths| paths.into_iter().map(|path| path.to_string_lossy().into_owned()).collect())
        .map_err(|error| error.to_string())
}

/// R16 P2-7:卡片菜单「在 Finder 中显示」——复用 `reveal_in_finder`;原片不在原位时给缺失页那句人话。
/// 只做快速哈希核对(不算完整哈希):这是"给我看文件",不是"确认同一份内容"。
#[tauri::command]
fn reveal_clip(clip_id: i64, state: tauri::State<'_, RuntimeState>) -> std::result::Result<(), String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let path = core::media_source::clip_path_for_full_hash(&connection, clip_id).map_err(|error| error.to_string())?;
    reveal_in_finder(&path).map_err(|error| error.to_string())
}

/// R18 M-10:导入前先分清「盘拔了」「在 iCloud 没下载」「真没了」。
/// 前端(`useGlobalDrop`)拿它决定说哪句话、给不给「现在下载」,
/// 而不是把三件事一律排成必然失败的导入任务、再刷一屏红字。
#[tauri::command]
fn inspect_paths(paths: Vec<String>) -> Vec<volumes::PathCondition> {
    paths
        .iter()
        .map(|path| volumes::classify(std::path::Path::new(path)))
        .collect()
}

/// R18 M-10:「现在下载」。只是请求 iCloud 拉本体,回来时可能还在下,
/// 所以前端要重新 `inspect_paths` 一次才算数。
#[tauri::command]
fn download_cloud_file(path: String) -> std::result::Result<(), String> {
    volumes::request_download(std::path::Path::new(&path)).map_err(|error| error.to_string())
}

/// R16 P2-10:检查器标签段。AI 标签(`ai_l3`)与用户标签(`user`)一起列;只有用户标签可删。
#[tauri::command]
fn list_tags(clip_id: i64, state: tauri::State<'_, RuntimeState>) -> std::result::Result<Vec<core::tags::Tag>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::tags::list_tags(&connection, clip_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn add_tag(clip_id: i64, text: String, state: tauri::State<'_, RuntimeState>) -> std::result::Result<core::tags::Tag, String> {
    if state.read_only {
        return Err("只读窗口不能改标签".into());
    }
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::tags::add_tag(&mut connection, clip_id, &text).map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_tag(clip_id: i64, tag_id: i64, state: tauri::State<'_, RuntimeState>) -> std::result::Result<(), String> {
    if state.read_only {
        return Err("只读窗口不能改标签".into());
    }
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::tags::remove_tag(&mut connection, clip_id, tag_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_device_clocks(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<DeviceClockSetting>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::canonical_time::list_device_clocks(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_device_clock_offset(
    device_model: String,
    offset_ms: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::canonical_time::set_device_offset(&mut connection, &device_model, offset_ms)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_clip_dimensions(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<ClipDimension>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::clip_dimensions::list_clip_dimensions(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_clip_time_stage(
    clip_id: i64,
    label: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::clip_dimensions::set_user_time_stage(&connection, clip_id, &label)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn probe_audio_tracks(
    clip_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<ClipAudioTrack>, String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::audio_tracks::probe_and_store(&mut connection, clip_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_audio_tracks(
    clip_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<ClipAudioTrack>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::audio_tracks::list_for_clip(&connection, clip_id).map_err(|error| error.to_string())
}

/// Preview-only display LUT. `scope` is `"clip"` (`target_id` is a clip id)
/// or `"episode"` (`target_id` is an episode id, written to every clip of
/// it). Never touches proxy generation or export/deliver — see the
/// negative assertions in `core::artifacts` and `core::deliver`.
#[tauri::command]
fn set_display_lut(
    scope: String,
    target_id: i64,
    path: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::player_prefs::set_display_lut(&connection, &scope, target_id, Path::new(&path))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_display_lut(
    scope: String,
    target_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::player_prefs::clear_display_lut(&connection, &scope, target_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_playback_track(
    clip_id: i64,
    stream_index: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::player_prefs::set_playback_track(&connection, clip_id, stream_index)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_transcribe_track(
    clip_id: i64,
    stream_index: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::player_prefs::set_transcribe_track(&connection, clip_id, stream_index)
        .map_err(|error| error.to_string())
}

/// Absolute paths of every `.cube` file under `<app support dir>/luts/`,
/// creating that directory if it doesn't exist yet. An empty list is fine.
/// R10 U-28:「添加 LUT…」——把选中的 `.cube` 复制进 `<app support dir>/luts/`,
/// 返回复制后的完整列表(与 `list_display_luts` 同形)。
#[tauri::command]
fn import_lut(path: String) -> std::result::Result<Vec<String>, String> {
    let root = crate::app_paths::app_support_root()
        .ok_or_else(|| "无法确定应用支持目录".to_owned())?;
    let luts_dir = root.join("luts");
    core::player_prefs::import_display_lut(&PathBuf::from(path), &luts_dir)
        .map(|paths| {
            paths
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect()
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_display_luts() -> std::result::Result<Vec<String>, String> {
    let root = crate::app_paths::app_support_root()
        .ok_or_else(|| "无法确定应用支持目录".to_owned())?;
    let luts_dir = root.join("luts");
    core::player_prefs::list_display_luts(&luts_dir)
        .map(|paths| {
            paths
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect()
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_clip_artifacts(
    clip_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<ClipArtifacts, String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::artifacts::get_clip_artifacts(
        &mut connection,
        &state.cache_root,
        state.media_server.port,
        &state.media_server.token,
        clip_id,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_clip_analysis(
    clip_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Option<ClipAnalysis>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::analysis::get_clip_analysis(&connection, clip_id).map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// R11 车道 B:时刻分与自动挑选
// ---------------------------------------------------------------------------

/// 热力条:整条素材的时刻分,按窗口降采样到 ≤ 200 点。
#[tauri::command]
fn get_clip_moments(
    clip_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<core::moments::Moment>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::moments::get_clip_moments(&connection, clip_id).map_err(|error| error.to_string())
}

/// 建议段:滑窗取峰,≤ 3 条;`target_secs` 不传按本集平台预算取 4–8 s。
#[tauri::command]
fn suggest_segments(
    clip_id: i64,
    target_secs: Option<f64>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<core::smart_select::SegmentSuggestion>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::smart_select::suggest_segments(&connection, clip_id, target_secs).map_err(|error| error.to_string())
}

/// 自动挑选整集精选段。`budget_secs` 不传按平台预算(0 = 60 s);`scope` 不传 = 收藏 ∪ ≥3 星。
#[tauri::command]
fn auto_select_episode(
    budget_secs: Option<f64>,
    scope: Option<String>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::smart_select::AutoSelectOutcome, String> {
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::smart_select::auto_select_episode(&mut connection, budget_secs, scope.as_deref())
        .map_err(|error| error.to_string())
}

/// R19 P-01 / P-03:带全部参数的自动挑选(一句话挑片 / 预设句)。`weights_json` 是权重偏置
/// (键限 `WEIGHT_KEYS`),`pick` = chapters(按时间顺序,缺省)/ score(按分数),`prompt` 只做记录。
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Flat command arguments preserve existing Tauri callers.
fn auto_select_episode_with(
    budget_secs: Option<f64>,
    scope: Option<String>,
    weights_json: Option<String>,
    pick: Option<String>,
    prompt: Option<String>,
    only_photos: Option<bool>,
    photo_count: Option<usize>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::smart_select::AutoSelectOutcome, String> {
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let params = core::smart_select::AutoSelectParams {
        budget_secs,
        scope,
        weights: core::smart_select_runs::parse_weights(weights_json.as_deref()).map_err(|error| error.to_string())?,
        pick: core::smart_select::AutoSelectPick::parse(pick.as_deref()).map_err(|error| error.to_string())?,
        prompt,
        target_secs: None,
        only_photos,
        photo_count,
    };
    core::smart_select::auto_select_episode_with(&mut connection, params).map_err(|error| error.to_string())
}

/// R19 P-03:结果面板 —— 这一批还活着的段(时长 / 分数 / 理由 / 被去重掉的兄弟)。
#[tauri::command]
fn list_auto_select_run(
    run_id: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::smart_select_runs::RunView, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::smart_select_runs::list_run(&connection, &run_id).map_err(|error| error.to_string())
}

/// R19 P-03「换一段」:用同组次优兄弟(或同素材下一条建议段)替掉这一段,返回新段那一行。
#[tauri::command]
fn replace_auto_segment(
    segment_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::smart_select_runs::Replacement, String> {
    if state.read_only { return Err("只读窗口不能换一段".to_owned()); }
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::smart_select_runs::replace_auto_segment(&mut connection, segment_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn undo_replace_auto_segment(run_id: String, replaced_segment_id: i64, state: tauri::State<'_, RuntimeState>) -> std::result::Result<bool, String> {
    if state.read_only { return Err("只读窗口不能撤销换一段".to_owned()); }
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::smart_select_runs::undo_replace_auto_segment(&mut connection, &run_id, replaced_segment_id).map_err(|error| error.to_string())
}

/// 撤销一批自动挑选:只删该批 `source='auto'` 的段,返回删掉的条数。
#[tauri::command]
fn undo_auto_select(
    batch_id: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<usize, String> {
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::smart_select::undo_auto_select(&mut connection, &batch_id).map_err(|error| error.to_string())
}

/// R12 车道 B:「一键排入」—— 本集全部精选段按章写进镜头带;`mode` 不传 = append。
#[tauri::command]
fn arrange_selected_segments(
    mode: Option<String>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::arrange::ArrangeOutcome, String> {
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let mode = core::arrange::ArrangeMode::parse(mode.as_deref()).map_err(|error| error.to_string())?;
    core::arrange::arrange_selected_segments(&mut connection, mode).map_err(|error| error.to_string())
}

/// 只撤一批排入,返回撤掉的行数。
#[tauri::command]
fn undo_arrange(
    batch_id: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<usize, String> {
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::arrange::undo_arrange(&mut connection, &batch_id).map_err(|error| error.to_string())
}

/// 「这章够了」:把一章标成跳过(不算缺口)/ 取消。
#[tauri::command]
fn skip_chapter(
    chapter_id: i64,
    skipped: bool,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::arrange::skip_chapter(&connection, chapter_id, skipped).map_err(|error| error.to_string())
}

/// 状态条「补齐时刻分 n/m」。
#[tauri::command]
fn get_moments_progress(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::moments::MomentsProgress, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::moments::progress(&connection).map_err(|error| error.to_string())
}

/// 手动重跑「补齐时刻分」(失败后重试也走这里),返回新排队的条数。
#[tauri::command]
fn enqueue_moments_backfill(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<usize, String> {
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::moments::enqueue_missing(&mut connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn search_transcripts(
    keyword: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<TranscriptMatch>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::transcribe::search_transcripts(&connection, &keyword)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn search_clips(
    query: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<ClipSearchHit>, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let connection = core::db::open_project(&db_path)?;
        core::clip_search::search_clips(&connection, &query)
    })
    .await
    .map_err(|error| format!("语义搜索任务异常结束：{error}"))?
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_similar_groups(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<SimilarGroup>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::similar::similar_groups(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_similar_primary(
    group_id: i64,
    clip_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::similar::set_primary(&mut connection, group_id, clip_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_shot_stacks(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<ShotStack>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::shot_stack::list(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_asset_safety(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<AssetSafetyInfo>, String> {
    let connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::asset_safety::list(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn apply_rescue_range(
    clip_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<SelectSegment, String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::asset_safety::apply_rescue_range(&mut connection, clip_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_shot_stack_user_state(
    stack_id: i64,
    clip_id: i64,
    segment_id: Option<i64>,
    user_state: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::shot_stack::set_user_state(
        &mut connection,
        stack_id,
        clip_id,
        segment_id,
        &user_state,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
/// Z-14:`episode_id` 是新增的可选参数(只读查看已封存集时传被查看的集);不传 = 当前集。
fn get_storyboard(
    episode_id: Option<i64>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Storyboard, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::story::get_storyboard_for(&connection, episode_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_story_templates() -> Vec<core::narrative::StoryTemplateInfo> {
    core::narrative::STORY_TEMPLATES.to_vec()
}

#[tauri::command]
fn enqueue_narrate_episode(
    template: Option<String>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::narrative::EnqueueOutcome, String> {
    let template = template
        .as_deref()
        .map(core::narrative::StoryTemplate::parse)
        .transpose()
        .map_err(|error| error.to_string())?;
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::narrative::enqueue_with_template(&mut connection, template)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn update_destination_card(
    card_id: i64,
    name: String,
    geo_context: String,
    highlights: String,
    why_visit: String,
    personal_note: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::narrative::update_destination_card(
        &connection,
        card_id,
        &name,
        &geo_context,
        &highlights,
        &why_visit,
        &personal_note,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_destination_card_verified(
    card_id: i64,
    verified: bool,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::narrative::set_destination_verified(&connection, card_id, verified)
        .map_err(|error| error.to_string())
}


#[tauri::command]
fn set_destination_field_state(
    card_id: i64,
    field: String,
    field_state: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::narrative::set_destination_field_state(&connection, card_id, &field, &field_state)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_story_order(
    order: Vec<StoryOrderRef>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::story::set_story_order(&mut connection, &order).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_band_order(episode_id: i64, order: Vec<core::story::band::BandOrderItem>, chapter_order: Vec<i64>, state: tauri::State<'_, RuntimeState>) -> std::result::Result<(), String> {
    if state.read_only { return Err("只读窗口不能修改镜头带".into()); }
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::story::band::set_order(&mut connection, episode_id, &order, &chapter_order).map_err(|error| error.to_string())
}

#[tauri::command]
fn trim_band_segment(episode_id: i64, segment_id: i64, expected: [i64; 2], bounds: [i64; 2], state: tauri::State<'_, RuntimeState>) -> std::result::Result<(), String> {
    if state.read_only { return Err("只读窗口不能修剪镜头".into()); }
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::story::band::trim(&mut connection, episode_id, segment_id, expected, bounds).map_err(|error| error.to_string())
}

#[tauri::command]
fn rename_chapter(
    chapter_id: i64,
    title: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::story::rename_chapter(&mut connection, chapter_id, &title)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn merge_chapters(
    source_chapter_id: i64,
    target_chapter_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::story::merge_chapters(&mut connection, source_chapter_id, target_chapter_id)
        .map_err(|error| error.to_string())
}

/// R16 P2-1:删除一章(镜移到相邻章),返回镜移去的章 id;`undo_story_change` 可撤。
#[tauri::command]
fn delete_chapter(
    chapter_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<i64, String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::story::delete_chapter(&mut connection, chapter_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn undo_story_change(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::story::UndoOutcome, String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::story::undo_latest(&mut connection).map_err(|error| error.to_string())
}

/// `override_orientation`(R10 U-05)是新增的可选参数:前端不传即 `None`,
/// 旧调用方不受影响。
#[tauri::command]
async fn start_export(
    dest: String,
    override_platform: Option<String>,
    override_orientation: Option<String>,
    include_contact_sheet: bool,
    target_seconds: Option<u32>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<ExportStatus, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = core::db::open_project(&db_path)?;
        core::deliver::start_export_with_canvas(
            &mut connection,
            &PathBuf::from(dest),
            override_platform.as_deref(),
            override_orientation.as_deref(),
            include_contact_sheet,
            target_seconds,
        )
    })
    .await
    .map_err(|error| format!("交付任务异常结束：{error}"))?
    .map_err(|error| error.to_string())
}

/// R11 车道 E:快速导出——只 remux 精选段与整条收藏到 `dest_dir/<集名>_导出_<日期>`,
/// 不出粗剪 / 镜头表 / 联系表 / 说明。`selection` 缺省 = 本集全部精选段 + 收藏。目标目录
/// 不存在 / 不可写时错误文本含 `dest_unavailable`,前端据此回落到保存面板。进度走
/// `get_export_status`(`mode = "quick"`)。
#[tauri::command]
async fn quick_export(
    dest_dir: String,
    selection: Option<core::deliver::QuickExportSelection>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::deliver::QuickExportOutcome, String> {
    if state.read_only {
        return Err("只读窗口不能导出".into());
    }
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = core::db::open_project(&db_path)?;
        core::deliver::start_quick_export(&mut connection, &PathBuf::from(dest_dir), selection.as_ref())
    })
    .await
    .map_err(|error| format!("导出任务异常结束：{error}"))?
    .map_err(|error| error.to_string())
}

/// R11 车道 E:只算不排——快速导出将写的文件夹与文件清单(抽屉清单读它)。
#[tauri::command]
fn plan_quick_export(
    dest_dir: Option<String>,
    selection: Option<core::deliver::QuickExportSelection>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::deliver::QuickExportOutcome, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::deliver::plan_quick_export(
        &connection,
        dest_dir.as_deref().map(std::path::Path::new),
        selection.as_ref(),
    )
    .map_err(|error| error.to_string())
}

/// R10 U-05:交付抽屉预览「画布 W×H」——按将要传给 `start_export` 的平台/方向解析,不建任务。
#[tauri::command]
fn preview_export_canvas(
    override_platform: Option<String>,
    override_orientation: Option<String>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::deliver::ExportCanvas, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::deliver::preview_export_canvas(
        &connection,
        override_platform.as_deref(),
        override_orientation.as_deref(),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_archive_ops(state: tauri::State<'_, RuntimeState>) -> std::result::Result<Vec<core::archive::ArchiveOperation>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|e| e.to_string())?;
    core::archive::recent(&connection).map_err(|e| e.to_string())
}

#[tauri::command]
async fn resume_archive(id: String, state: tauri::State<'_, RuntimeState>) -> std::result::Result<core::archive::ArchiveOperation, String> {
    if state.read_only { return Err("只读窗口不能继续交付".into()); }
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let connection = core::db::open_project(&db_path).map_err(|e| e.to_string())?;
        core::archive::resume(&connection, &id).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn undo_archive(id: String, state: tauri::State<'_, RuntimeState>) -> std::result::Result<core::archive::ArchiveOperation, String> {
    if state.read_only { return Err("只读窗口不能撤销交付".into()); }
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let connection = core::db::open_project(&db_path).map_err(|e| e.to_string())?;
        core::archive::undo_idle(&connection, &id).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_export_status(
    job_id: Option<i64>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<ExportStatus, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::deliver::get_export_status(&connection, job_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn cancel_export(
    job_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::deliver::cancel_export(&mut connection, job_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn cancel_job(
    job_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::jobs::request_cancel(&mut connection, job_id).map_err(|error| error.to_string())
}

/// R7 Task 5 命令层:`preview_generation`/`submit_generation`/
/// `retry_generation`/`cancel_generation`/`list_generation_requests` 的名字
/// 与参数形状对齐 `src/api.ts`(Task 6 的 `GenerationDialog.tsx`/
/// `Storyboard.tsx` 已经按这套契约写好界面与测试)。首尾帧参考的抽取与
/// "该拿哪个相邻镜头的哪一帧"这条业务规则不在本任务范围内(需要走
/// `narrative_beats`/`segments`/tick-timebase 换算,留给后续任务接线)——
/// `core::generation::draft_for_gap` 目前总是以 `t2v`/降级路径产出草稿,
/// 见该函数上的注释。
#[derive(Debug, Clone, serde::Serialize)]
struct GenerationRefPreview {
    path: String,
    role: String,
    preview_url: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct GenerationDraftPreview {
    mode: String,
    model: String,
    resolution: String,
    duration_s: u32,
    ratio: String,
    prompt: String,
    refs: Vec<GenerationRefPreview>,
    estimated_cost_usd: f64,
    notes: Vec<String>,
}

impl From<core::generation::GenerationRequestDraft> for GenerationDraftPreview {
    fn from(draft: core::generation::GenerationRequestDraft) -> Self {
        Self {
            mode: draft.mode,
            model: draft.model,
            resolution: draft.resolution,
            duration_s: draft.duration_s,
            ratio: draft.ratio.unwrap_or_default(),
            prompt: draft.prompt,
            refs: draft
                .refs
                .into_iter()
                .map(|reference| GenerationRefPreview {
                    path: reference.path,
                    role: reference.role,
                    // 预览缩略图(把参考帧路径转成媒体服务器可访问的 URL)不在本任务
                    // 范围内——留给界面接线的后续任务。
                    preview_url: None,
                })
                .collect(),
            estimated_cost_usd: draft.estimated_cost_usd,
            notes: draft.notes,
        }
    }
}

#[tauri::command]
fn preview_generation(
    gap_id: i64,
    overrides: core::generation::GenerationOverrides,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<GenerationDraftPreview, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let draft = core::generation::draft_for_gap(&connection, gap_id, &overrides)
        .map_err(|error| error.to_string())?;
    Ok(GenerationDraftPreview::from(draft))
}

#[tauri::command]
fn submit_generation(
    gap_id: i64,
    overrides: core::generation::GenerationOverrides,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::generation::GenerationRequestSummary, String> {
    core::generation::guard_writable(state.read_only).map_err(|error| error.to_string())?;
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let draft = core::generation::draft_for_gap(&connection, gap_id, &overrides)
        .map_err(|error| error.to_string())?;
    let request_id =
        core::generation::submit_request(&mut connection, draft).map_err(|error| error.to_string())?;
    core::generation::generation_request_summary(&connection, request_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn retry_generation(
    request_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::generation::GenerationRequestSummary, String> {
    core::generation::guard_writable(state.read_only).map_err(|error| error.to_string())?;
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let new_id = core::generation::retry_generation(&mut connection, request_id)
        .map_err(|error| error.to_string())?;
    core::generation::generation_request_summary(&connection, new_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn cancel_generation(
    request_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    core::generation::guard_writable(state.read_only).map_err(|error| error.to_string())?;
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::generation::cancel_generation(&mut connection, request_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_generation_requests(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<core::generation::GenerationRequestSummary>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let episode_id: i64 = connection
        .query_row("SELECT id FROM episodes WHERE status='active'", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    core::generation::list_generation_requests(&connection, episode_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn reveal_export(
    job_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    let status =
        core::deliver::get_export_status(&connection, Some(job_id)).map_err(|error| error.to_string())?;
    if status.status != "done" {
        return Err("交付任务尚未完成".to_owned());
    }
    let path = status
        .output_path
        .ok_or_else(|| "交付任务缺少输出路径".to_owned())?;
    let result = std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|error| format!("无法打开访达：{error}"))?;
    if result.success() {
        Ok(())
    } else {
        Err("访达未能显示交付包".to_owned())
    }
}

#[tauri::command]
fn get_jianying_availability(state: tauri::State<'_, RuntimeState>) -> std::result::Result<JianyingAvailability, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    Ok(core::jianying::availability(&connection))
}

/// R14 §9 A:「可以用」/「打不开」—— 只认待验证名单里的版本,值只认 ok / fail。
#[tauri::command]
fn set_jianying_human_check(
    version: String,
    verdict: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<JianyingAvailability, String> {
    let verdict = match HumanCheck::parse(&verdict) {
        Some(verdict @ (HumanCheck::Ok | HumanCheck::Fail)) => verdict,
        _ => return Err(format!("验证结果只能是 ok 或 fail,收到 {verdict}")),
    };
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::jianying::set_human_check(&connection, &version, verdict).map_err(|error| error.to_string())?;
    Ok(core::jianying::availability(&connection))
}

/// R13 §5「已生成剪映草稿 · 打开剪映」:前端能让本机打开的应用**只有**剪映专业版。
/// 这不是一个通用的 `open -b` 出口 —— 白名单之外的 bundle id 一律拒绝,连 `open` 都不会跑。
const OPEN_APP_ALLOWED_BUNDLES: &[&str] = &["com.lemon.lvpro"];

fn open_app_allowed(bundle_id: &str) -> bool {
    OPEN_APP_ALLOWED_BUNDLES.contains(&bundle_id)
}

#[tauri::command]
fn open_app(bundle_id: String) -> std::result::Result<(), String> {
    if !open_app_allowed(&bundle_id) {
        return Err(format!("不允许打开应用 {bundle_id}"));
    }
    let status = std::process::Command::new("open")
        .arg("-b")
        .arg(&bundle_id)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|error| format!("无法启动剪映：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("没找到剪映专业版；可以到剪映首页「本地草稿」里打开".to_owned())
    }
}

#[tauri::command]
async fn generate_jianying_draft(
    force: Option<bool>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<JianyingDraftResult, String> {
    let db_path = state.db_path.clone();
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = core::db::open_project(&db_path)?;
        core::jianying::generate_native_draft(&mut connection, force)
    })
    .await
    .map_err(|error| format!("剪映草稿任务异常结束：{error}"))?
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn rate_clip(
    clip_id: i64,
    rating_type: String,
    value: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<ClipRating, String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::ratings::rate_clip(&mut connection, clip_id, &rating_type, value)
        .map_err(|error| error.to_string())
}

/// R16 P1-5:一次事务写入多条评级(多选热键 / 菜单批量 / 撤销回写)。任何一条无效整批不写。
#[tauri::command]
fn rate_clips(
    entries: Vec<core::ratings::ClipRatingEntry>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<ClipRating>, String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::ratings::rate_clips(&mut connection, &entries).map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_clip_rating(
    clip_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::ratings::clear_clip_rating(&mut connection, clip_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_select_segments(
    clip_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<SelectSegment>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::ratings::list_select_segments(&connection, clip_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn create_select_segment(
    clip_id: i64,
    in_seconds: f64,
    out_seconds: f64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<SelectSegment, String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::ratings::create_select_segment(&mut connection, clip_id, in_seconds, out_seconds)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_select_segment(
    segment_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::ratings::delete_select_segment(&mut connection, segment_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn restore_select_segment(
    segment_id: i64,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::ratings::restore_select_segment(&mut connection, segment_id)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn player_set_viewport(
    viewport: PlayerViewport,
    player: tauri::State<'_, PlayerManager>,
) -> std::result::Result<(), String> {
    // 必须 async + spawn_blocking:同步命令占住 AppKit 主线程等 worker 回复,
    // 而 worker 的 resize_surface 又 run_on_main_thread 等主线程——环形死锁。
    let player = player.inner().clone();
    tauri::async_runtime::spawn_blocking(move || player.set_viewport(viewport))
        .await
        .map_err(|error| error.to_string())?
}

/// 覆盖层(popover / 抽屉 / 命令面板)开合时隐藏或恢复原生视频视图(R9 D1)。
#[cfg(target_os = "macos")]
#[tauri::command]
async fn player_set_occluded(
    occluded: bool,
    player: tauri::State<'_, PlayerManager>,
) -> std::result::Result<(), String> {
    // 同 player_set_viewport:worker 要回主线程 setHidden,同步命令会环形死锁。
    let player = player.inner().clone();
    tauri::async_runtime::spawn_blocking(move || player.set_occluded(occluded))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn player_open(
    clip_id: i64,
    // R23:镜头带连播换素材时传 true —— 新实例停在首帧,由连播 seek 到入点、等首帧再开播。
    // 不传(老调用方)保持原样:载入即播。
    start_paused: Option<bool>,
    runtime: tauri::State<'_, RuntimeState>,
    player: tauri::State<'_, PlayerManager>,
) -> std::result::Result<PlayerStatus, String> {
    let db_path = runtime.db_path.clone();
    let cache_root = runtime.cache_root.clone();
    let player = player.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (connection, path, time_mapper) =
            crate::player::resolve_playback_source(&db_path, &cache_root, clip_id)?;
        // R16:预览小文件的 LRU 按「最近播放」排,打开即 touch(没有代理时是空操作)。
        if time_mapper.is_some() {
            core::artifacts::touch_proxy_played(&connection, &cache_root, clip_id);
        }
        let status = player.open(path, clip_id, time_mapper, start_paused.unwrap_or(false))?;
        apply_stored_display_prefs(&connection, clip_id, &player);
        Ok::<PlayerStatus, String>(status)
    })
    .await
    .map_err(|error| format!("播放器启动任务异常结束：{error}"))?
}

/// After a clip loads, replays any stored preview-only display LUT and
/// selected monitor track onto the fresh mpv instance. This is best-effort:
/// a missing/removed LUT file or a stream index the proxy doesn't carry
/// must not fail the whole playback session, so failures are only logged.
#[cfg(target_os = "macos")]
fn apply_stored_display_prefs(connection: &rusqlite::Connection, clip_id: i64, player: &PlayerManager) {
    type DisplayPrefsRow = (Option<String>, Option<i64>, Option<i64>);
    let prefs: std::result::Result<DisplayPrefsRow, rusqlite::Error> = connection
        .query_row(
            "SELECT display_lut_path, selected_monitor_track, manual_rotation FROM clips WHERE id = ?1",
            [clip_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        );
    let (lut_path, monitor_track, manual_rotation) = match prefs {
        Ok(prefs) => prefs,
        Err(error) => {
            tracing::warn!(%error, "读取素材显示偏好失败");
            return;
        }
    };
    if let Some(lut_path) = lut_path {
        if let Err(error) = player.command(PlayerCommand::ApplyDisplayLut { path: PathBuf::from(lut_path) }) {
            tracing::warn!(%error, "打开素材后应用显示 LUT 失败");
        }
    }
    if let Some(stream_index) = monitor_track {
        if let Err(error) = player.command(PlayerCommand::SelectAudioTrack { stream_index }) {
            tracing::warn!(%error, "打开素材后设置监听音轨失败");
        }
    }
    // `manual_rotation` (NOT `rotation`) — mpv already auto-rotates the
    // side_data case on its own by default; this column only carries a
    // value when that autorotate would NOT already have handled it (see
    // `core::import::parse_probe_json` and the doc comment on
    // `PlayerCommand::SetRotation`).
    if manual_rotation.is_some() {
        if let Err(error) = player.command(PlayerCommand::SetRotation { degrees: manual_rotation }) {
            tracing::warn!(%error, "打开素材后设置手动旋转失败");
        }
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn player_close(
    player: tauri::State<'_, PlayerManager>,
) -> std::result::Result<(), String> {
    let player = player.inner().clone();
    tauri::async_runtime::spawn_blocking(move || player.close())
        .await
        .map_err(|error| format!("播放器关闭任务异常结束：{error}"))?
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn player_command(
    cmd: PlayerCommand,
    clip_id: Option<i64>,
    player: tauri::State<'_, PlayerManager>,
) -> std::result::Result<(), String> {
    let player = player.inner().clone();
    // R22 真机诊断:TRIPCUT_LOG=debug 下逐条记播放器命令(拖动手感排障要看命令序列);INFO 级别一行不出。
    tracing::debug!(command = ?cmd, clip_id, "player command");
    // R17 playfix:前端把命令归属的素材一起带来,换源窗口里排队的旧素材命令在这里被拒。
    tauri::async_runtime::spawn_blocking(move || player.command_for(cmd, clip_id))
        .await
        .map_err(|error| format!("播放器命令任务异常结束：{error}"))?
}

/// R12 §5 真变速:`player_command` 的 `set_speed` 的直呼版本(前端 `playerSetSpeed`)。
/// 夹紧在 `player::clamp_playback_speed` 里做,两条入口同一个范围。
#[cfg(target_os = "macos")]
#[tauri::command]
async fn player_set_speed(
    speed: f64,
    player: tauri::State<'_, PlayerManager>,
) -> std::result::Result<(), String> {
    let player = player.inner().clone();
    tauri::async_runtime::spawn_blocking(move || player.command(PlayerCommand::SetSpeed { speed }))
        .await
        .map_err(|error| format!("播放器变速任务异常结束：{error}"))?
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn player_status(player: tauri::State<'_, PlayerManager>) -> PlayerStatus {
    let status = player.status();
    // R22 真机诊断:每一次落地的 seek(player 线程自己量的 命令→PlaybackRestart)在
    // `TRIPCUT_LOG=debug` 下记一行,拖动手感可以从日志里逐次读延迟,不用改 player/。
    // 只在 80ms 轮询看到样本数变化时写,INFO 级别下一行都不出。
    static SEEN_SEEK_SAMPLES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let previous = SEEN_SEEK_SAMPLES.swap(status.seek_samples, std::sync::atomic::Ordering::Relaxed);
    if previous != status.seek_samples {
        if let Some(seek_ms) = status.last_seek_ms {
            tracing::debug!(
                seek_ms,
                pos = status.pos,
                samples = status.seek_samples,
                p50_ms = ?status.seek_p50_ms,
                p95_ms = ?status.seek_p95_ms,
                "seek landed"
            );
        }
    }
    status
}

fn development_root() -> Result<PathBuf> {
    libraries::active_path(&libraries::base()?)
}

static LIBRARY_REGISTRY_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
fn list_libraries() -> std::result::Result<libraries::Registry, String> {
    let _guard = LIBRARY_REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    libraries::base().and_then(|base| libraries::load(&base)).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_library(name: String, state: tauri::State<'_, RuntimeState>) -> std::result::Result<libraries::Registry, String> {
    if state.read_only { return Err("只读窗口不能管理素材库".into()); }
    let _guard = LIBRARY_REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    libraries::base().and_then(|base| libraries::create(&base, &name)).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_library_hidden(id: String, hidden: bool, state: tauri::State<'_, RuntimeState>) -> std::result::Result<libraries::Registry, String> {
    if state.read_only { return Err("只读窗口不能管理素材库".into()); }
    let _guard = LIBRARY_REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    libraries::base().and_then(|base| libraries::set_hidden(&base, &id, hidden)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn switch_library(id: String, app: tauri::AppHandle, state: tauri::State<'_, RuntimeState>) -> std::result::Result<(), String> {
    if state.read_only { return Err("只读窗口不能切换素材库".into()); }
    let control = state.worker_control.clone().ok_or("后台任务控制器不可用")?;
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        let connection=core::db::open_project(&db_path)?;
        let gate=core::import::import_gate(&connection); drop(connection);
        let _import_guard=gate.lock().unwrap_or_else(|e|e.into_inner());
        control.with_maintenance(|| Ok(()), || {
            let connection = core::db::open_project(&db_path)?;
            core::db::create_snapshot(&connection, &db_path.parent().unwrap().join("snapshots"))?;
            tracing::warn!(library = %id, "command switch_library: switching active library and restarting (current library kept on disk)");
            let _guard = LIBRARY_REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            libraries::select(&libraries::base()?, &id)?;
            // This closure runs on spawn_blocking, never the main thread.
            // restart() delivers Exit there and does not return: keep both
            // maintenance and import gates closed until the process exits.
            app.restart()
        })
    }).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

/// R6 Task 4:开发/QA 用的手动唤醒入口——真机上没法在测试脚本里让 Mac 真的
/// 睡一觉再醒,所以给一条命令直接调 `runtime::on_wake` 里那同一个函数。
/// `TRIPCUT_SIMULATE_WAKE=1` 必须在**调用时**的进程环境里为真;这不是一次性
/// 开关,是每次调用都重新读——防止某次调试忘了改回去,却在生产环境里留了
/// 条能被前端随手触发的后门。
/// 拆成纯函数好单测:`simulate_wake` 本身要一个真实的 `tauri::AppHandle`,
/// 单元测试里造不出来;这条门槛判定跟 `AppHandle` 完全无关,单独测。
fn wake_simulation_permitted() -> bool {
    std::env::var("TRIPCUT_SIMULATE_WAKE").as_deref() == Ok("1")
}

#[tauri::command]
async fn simulate_wake(app: tauri::AppHandle) -> std::result::Result<(), String> {
    if !wake_simulation_permitted() {
        return Err("TRIPCUT_SIMULATE_WAKE 未设置为 1；此命令仅用于测试/QA".to_owned());
    }
    runtime::on_wake(&app);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// R14 车道 B:「剪映素材包」—— 按镜头带顺序把每个镜 remux 成 `NN_<章名>_<素材名>.mp4`,平铺在
/// `dest_dir/<集名>_剪映素材包_<日期>`(同名 `-2`),附「顺序.txt」。`dest_dir` 缺省时用记住的
/// `ui.export.last_dir`;没记过 / 用不了时错误文本含 `dest_unavailable`,前端据此弹一次文件夹面板。
/// 进度走 `get_export_status`(`mode = "kit"`)。
#[tauri::command]
async fn export_jianying_kit(
    dest_dir: Option<String>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::deliver::KitExportOutcome, String> {
    if state.read_only {
        return Err("只读窗口不能导出".into());
    }
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = core::db::open_project(&db_path)?;
        let dest = match dest_dir.filter(|dir| !dir.trim().is_empty()) {
            Some(dir) => dir,
            None => {
                let remembered = core::settings::string_value(&connection, "ui.export.last_dir", "")?;
                if remembered.trim().is_empty() {
                    return Err(core::error::CoreError::Export(format!(
                        "{}: 还没选过导出文件夹",
                        core::deliver::QUICK_EXPORT_DEST_UNAVAILABLE
                    )));
                }
                remembered
            }
        };
        core::deliver::start_jianying_kit(&mut connection, &PathBuf::from(dest))
    })
    .await
    .map_err(|error| format!("导出任务异常结束：{error}"))?
    .map_err(|error| error.to_string())
}

/// R21 照片线:「导出精选照片」—— 唯一的照片导出。winners(收藏 + ≥3 星 + 擂台主图)平铺复制到
/// `dest_dir/<集名>_精选照片_<日期>`(同名 `-2`):HEIC / RAW 转 JPG + 原件 + 伴随 + 「顺序.txt」,
/// 走 archive_ops。`dest_dir` 缺省用记住的 `ui.export.last_dir`;没记过时错误文本含 `dest_unavailable`。
/// 进度走 `get_export_status`(`mode = "photos"`)。
#[tauri::command]
async fn export_selected_photos(
    dest_dir: Option<String>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::deliver::KitExportOutcome, String> {
    if state.read_only {
        return Err("只读窗口不能导出".into());
    }
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = core::db::open_project(&db_path)?;
        let dest = match dest_dir.filter(|dir| !dir.trim().is_empty()) {
            Some(dir) => dir,
            None => {
                let remembered = core::settings::string_value(&connection, "ui.export.last_dir", "")?;
                if remembered.trim().is_empty() {
                    return Err(core::error::CoreError::Export(format!(
                        "{}: 还没选过导出文件夹",
                        core::deliver::QUICK_EXPORT_DEST_UNAVAILABLE
                    )));
                }
                remembered
            }
        };
        core::deliver::start_photo_export(&mut connection, &PathBuf::from(dest))
    })
    .await
    .map_err(|error| format!("导出任务异常结束：{error}"))?
    .map_err(|error| error.to_string())
}

/// R21 照片线:只算不排——精选照片将写的文件夹与编号清单。
#[tauri::command]
fn plan_selected_photos(
    dest_dir: Option<String>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::deliver::KitExportOutcome, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::deliver::plan_photo_export(&connection, dest_dir.as_deref().map(std::path::Path::new))
        .map_err(|error| error.to_string())
}

/// R14 车道 B:只算不排——素材包将写的文件夹与按镜头带顺序编号的文件清单(抽屉面板读它)。
#[tauri::command]
fn plan_jianying_kit(
    dest_dir: Option<String>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::deliver::KitExportOutcome, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::deliver::plan_jianying_kit(&connection, dest_dir.as_deref().map(std::path::Path::new))
        .map_err(|error| error.to_string())
}

pub fn run() {
    let clean_shutdown_root = Arc::new(Mutex::new(None::<PathBuf>));
    let setup_clean_shutdown_root = clean_shutdown_root.clone();
    // X-07:SIGTERM / SIGINT 走与 ⌘Q 相同的收尾(清哨兵,再请求应用退出)。必须在起任何线程之前装。
    let signal_app_handle: Arc<Mutex<Option<tauri::AppHandle>>> = Arc::new(Mutex::new(None));
    {
        let root = clean_shutdown_root.clone();
        let handle = signal_app_handle.clone();
        if let Err(error) = core::shutdown::watch(move |signal| {
            if let Err(error) = core::shutdown::finish_session_for_signal(&root, signal) {
                tracing::warn!(%error, signal, "signal shutdown could not clear clean-shutdown sentinel");
            }
            match handle.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone() {
                Some(app) => app.exit(0),
                None => std::process::exit(0),
            }
        }) {
            tracing::warn!(%error, "could not install graceful signal handling");
        }
    }
    let setup_signal_app_handle = signal_app_handle.clone();
    let mut context = tauri::generate_context!();
    // QA 用本地 http 端点跑正/负例;生产端点写死在 tauri.conf.json 里。改的是配置本身,
    // 原因见 updater.rs 顶部注释(前端 check() 读的是插件 clone 的那份配置)。
    if let Some(endpoint) = updater::endpoint_override_from_env() {
        let plugins = &mut context.config_mut().plugins.0;
        let applied = plugins
            .get_mut("updater")
            .is_some_and(|value| updater::apply_endpoint_override(value, &endpoint));
        if applied {
            tracing::warn!(%endpoint, "updater endpoint overridden by TRIPCUT_UPDATER_ENDPOINT");
        } else {
            // 覆盖没生效却继续启动,等于拿生产端点冒充本地端点跑 QA。宁可炸在这里。
            panic!(
                "TRIPCUT_UPDATER_ENDPOINT={endpoint} 未能生效:要么 tauri.conf.json 里没有 \
                 plugins.updater,要么这个端点不被允许(http 只接受 127.0.0.1/localhost/[::1])"
            );
        }
    }
    // R18 W-4:开窗前耗时的尺子。进程入口到 `setup()` 结束(窗口已建好、
    // 前端开始加载)之间的毫秒数,落到日志的 `startup_ms` 字段。
    let process_started = std::time::Instant::now();
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ProvisioningState::default())
        .manage(exit_guard::ExitState::default())
        // R19 E-05:见 `ProcessStartedAt`/`mark_first_paint`。
        .manage(ProcessStartedAt(process_started))
        .manage(update_flow::UpdateFlowState::default())
        .manage(core::model_registry::DownloadRegistry::default())
        .setup(move |app| {
            packaging::configure(app);
            // M-01:菜单建不起来不该拦住启动——没有菜单的应用仍然能用,少一条 warn 反而更糟。
            if let Err(error) = menu::attach(app.handle()) {
                tracing::warn!(%error, "中文菜单栏没能挂上");
            }
            update_flow::spawn_selftest_if_requested(app.handle());
            *setup_signal_app_handle
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(app.handle().clone());
            let root = development_root()?;
            let db_path = root.join("project.db");
            // R18 F5:缓存目录可以被搬到别的盘;设置里存了并且那个目录还在就用它,
            // 否则(比如外接盘没插)退回内置位置——缓存是可重建产物,退回去只是重新生成。
            let cache_root = core::settings::resolve_cache_root(&db_path, &root.join("cache"));
            // R18 M-03:日志真落盘(按天滚动、保留 7 天、写之前脱敏)。装在 panic hook 旁边,
            // 两者写同一个 logs 目录。
            logging::init(&root.join("logs"));
            core::doctor::install_panic_hook(root.join("logs"));

            let project_lock = core::db::try_acquire_project_lock(&db_path)?.map(Arc::new);
            let read_only = project_lock.is_none();
            if read_only {
                use tauri_plugin_dialog::DialogExt;
                app.dialog()
                    .message("已有另一个「旅剪工作台」实例正在运行。本窗口进入只读模式：可以浏览，但导入、评级与导出均不可用。建议关闭本窗口，回到已打开的实例继续工作。")
                    .title("检测到另一个实例")
                    .blocking_show();
            }
            let abnormal_exit = if read_only {
                false
            } else {
                let abnormal = core::doctor::begin_session(&root)?;
                *setup_clean_shutdown_root
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(root.clone());
                abnormal
            };
            let report = Arc::new(Mutex::new(core::doctor::run_preflight(
                &root,
                &db_path,
                &cache_root,
                abnormal_exit,
            )));
            let doctor_worker_control = Arc::new(Mutex::new(None));
            app.manage(DoctorRuntimeState {
                root: root.clone(),
                db_path: db_path.clone(),
                cache_root: cache_root.clone(),
                writable: !read_only,
                report: report.clone(),
                worker_control: doctor_worker_control.clone(),
                _project_lock: project_lock.clone(),
            });
            if report
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .status
                == core::doctor::DoctorLevel::Fail
            {
                return Ok(());
            }

            if read_only {
                core::db::register_project_read_only(&db_path);
            } else {
                core::db::initialize(&db_path)?;
                core::import_control::fail_scans(&mut core::db::open_project(&db_path)?,None)?;
            }

            // 三步交换崩溃可能留下孤儿 `.rolling`;启动时扫一遍托管目录,能恢复
            // 就恢复,能确认已完成就清理,与项目是否只读无关(这是应用级托管
            // 目录,不是项目数据库)。
            for managed_dir in [core::provisioning::managed_bin_dir(), core::provisioning::models_dir()] {
                match managed_dir {
                    Ok(directory) => {
                        if let Err(error) = core::provisioning::sweep_rolling_orphans(&directory) {
                            tracing::warn!(%error, ?directory, "sweeping orphaned .rolling files failed");
                        }
                    }
                    Err(error) => tracing::warn!(%error, "resolving managed directory for .rolling sweep failed"),
                }
            }

            let mut connection = core::db::open_project(&db_path)?;
            if !read_only {
                // NAS/云盘工作流:每 5 分钟对 auto_sync 关注文件夹增量重扫(导入幂等)。
                let sync_db_path = db_path.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(300));
                    if let Ok(mut sync_connection) = core::db::open_project(&sync_db_path) {
                        // Z-07:每轮同步顺带 stat 一遍原片,移走 / 拔卡的素材进缺失页,回来的自动恢复。
                        match core::media_source::refresh_missing_flags(&sync_connection, None) {
                            Ok(outcome) if outcome.newly_missing > 0 || outcome.restored > 0 => {
                                tracing::info!(?outcome, "missing-source refresh changed flags");
                            }
                            Ok(_) => {}
                            Err(error) => tracing::warn!(%error, "missing-source refresh failed"),
                        }
                        match core::import::rescan_watched_folders(&mut sync_connection) {
                            Ok(outcome) if outcome.enqueued > 0 => {
                                tracing::info!(
                                    enqueued = outcome.enqueued,
                                    "watched folders auto-sync enqueued new clips"
                                );
                            }
                            Ok(_) => {}
                            Err(error) => tracing::warn!(%error, "watched folders auto-sync failed"),
                        }
                    }
                });
                let recovered = if abnormal_exit {
                    core::jobs::recover_after_unclean_shutdown(&mut connection)?
                } else {
                    core::jobs::recover_expired(&mut connection)?
                };
                if recovered > 0 {
                    tracing::info!(recovered, "recovered interrupted job leases");
                }
                if let Err(error) = core::archive::reconcile(&connection) {
                    tracing::warn!(%error, "archive startup reconciliation remains pending");
                }
                if let Err(error) = core::channel_memory::prepare_for_project(&connection) {
                    tracing::warn!(%error, "channel-memory identity reconciliation remains unresolved");
                }
                match core::deliver::flush_channel_memory_outbox(&connection) {
                    Ok(synced) if synced > 0 => {
                        tracing::info!(synced, "synced pending channel-memory outbox records");
                    }
                    Ok(_) => {}
                    Err(error) => {
                        tracing::warn!(%error, "channel-memory outbox sync remains pending");
                    }
                }
                if abnormal_exit {
                    let mut report = report
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    report.record_recovery(recovered);
                    if let Err(error) =
                        core::doctor::sample_cache_consistency(&mut report, &connection, &cache_root)
                    {
                        report.record_cache_check_error(&error);
                    }
                }
                // Z-07:启动时做一轮原片存活检查(节流键与前端轮询共用,一分钟内不重复)。
                match core::media_source::refresh_missing_flags_throttled(
                    &connection,
                    std::time::Duration::from_secs(60),
                ) {
                    Ok(Some(outcome)) if outcome.newly_missing > 0 || outcome.restored > 0 => {
                        tracing::info!(?outcome, "missing-source refresh at startup changed flags");
                    }
                    Ok(_) => {}
                    Err(error) => tracing::warn!(%error, "missing-source refresh at startup failed"),
                }
                let snapshots_root = root.join("snapshots");
                // A16-02:启动时数一遍主表与快照。库空而最新快照非空 = 上一程有东西把库清了,
                // 这里用 warn 把两边的数字钉进日志(正常清库的路径各自也有带来源的 warn)。
                match core::db::library_census(&connection, &snapshots_root) {
                    Ok(census) => {
                        if census.clips == 0 && census.latest_snapshot_clips.unwrap_or(0) > 0 {
                            tracing::warn!(abnormal_exit, ?census, "startup: library is empty but the latest snapshot still holds clips");
                        } else {
                            tracing::info!(abnormal_exit, ?census, "startup library census");
                        }
                    }
                    Err(error) => tracing::warn!(%error, "startup library census failed"),
                }
            }
            // R16 车道 E:档位一次解析。R18 W-2:worker 数由档位自己定,不再从
            // `performance.worker_count` 读——那个 1–8 的旋钮在 4 以上完全没效果
            // (实测 workers 4 = 25.08 s、workers 8 = 25.09 s),绑住吞吐的是解码许可。
            // 用户能调的是「后台干活的力度」(省电 / 平衡 / 全速),它缩放的是解码预算。
            let memory_profile = core::memory_profile::resolve(&connection)?;
            // R19 P-06:启动时把设置里的画面理解模型目录覆盖灌进进程内(侧车 spawn 读不到库)。
            let clip_override = core::settings::string_value(&connection, core::settings::CLIP_MODEL_DIR_KEY, "")?;
            core::model_catalog::set_clip_model_dir_override(
                (!clip_override.trim().is_empty()).then(|| PathBuf::from(clip_override.trim())),
            );
            let worker_count = memory_profile.max_worker_count();
            let background_effort = core::settings::background_effort(&connection)?;
            let decode_permits = memory_profile.decode_permits_for_effort(&background_effort);
            let idle_only = core::settings::background_only_when_idle(&connection)?;
            // R16 §3⑥:播放器低配参数表随档位。
            crate::player::mpv_options::set_low_spec(memory_profile.low_spec_player());
            let machine = core::machine::current();
            tracing::info!(
                profile = memory_profile.as_str(),
                chip = machine.chip.as_str(),
                media_engines = machine.media_engines(),
                perf_cores = machine.perf_cores,
                worker_count,
                effort = background_effort.as_str(),
                decode_permits,
                idle_only,
                "memory profile resolved"
            );
            let window_state = core::settings::window_state(&connection)?;
            drop(connection);

            let media_server = tauri::async_runtime::block_on(core::media_server::start(
                cache_root.clone(),
            ))?;
            let worker_control = if read_only {
                None
            } else {
                // R6 Task 4:通知出口在这里接线——闭包捕获的 AppHandle 是唯一
                // 一处 core::jobs 之外知道「AppHandle 长什么样」的地方;
                // core::jobs 只认 `Fn(&str, &str) -> bool`,不知道 Tauri 的存
                // 在。fire-and-forget 的 `std::thread::spawn` 包装在
                // `core::jobs::notify_on_completion` 那一侧,这里只需要把
                // `notify::post` 的成功/失败原样透传回去。
                let notifier_app = app.handle().clone();
                // R18 F1:通知开关的查询点。`post_gated` 自己开库查一次
                // `notification.*`——通知本来就稀疏(一批分析/一次交付一条),
                // 这一次读比把设置缓存进 JobRunner 再管失效要简单得多。
                let notifier_db_path = db_path.clone();
                let primer_db_path = db_path.clone();
                // R10 U-19:应用内事件出口——音乐分析等任务落到终态时 `app.emit`
                // 给前端(`tripcut:music-analyzed`),前端不用等下次轮询/重启。
                let event_app = app.handle().clone();
                let permission_app = app.handle().clone();
                let runner = core::jobs::JobRunner::new(db_path.clone(), worker_count)
                    .with_memory_profile(memory_profile)
                    // R18 W-2:力度挡位缩放解码预算(省电 50% / 平衡 100% / 全速 150%),
                    // 必须排在 `with_memory_profile` 之后——它会先按档位设一次基准值。
                    .with_decode_limit(decode_permits)
                    .with_idle_only(idle_only)
                    .with_notifier(std::sync::Arc::new(move |title: &str, body: &str| {
                        match core::db::open_project(&notifier_db_path) {
                            Ok(connection) => notify::post_gated(&notifier_app, &connection, title, body),
                            // 读不到设置不等于用户关掉了通知:照旧发(见 `notify::post_gated`)。
                            Err(_) => notify::post(&notifier_app, title, body),
                        }
                    }))
                    .with_event_sink(std::sync::Arc::new(move |name: &str, payload: serde_json::Value| {
                        if let Err(error) = tauri::Emitter::emit(&event_app, name, payload) {
                            tracing::warn!(%error, event = name, "应用内事件投递失败");
                        }
                    }))
                    // R10 U-25:通知权限弹框固定在「第一个后台任务开始」——桌面端
                    // `request_permission` 是空实现,macOS 只在第一次 `show()` 时弹框,
                    // 所以这里发一条「已开始后台处理」把它引出来;之后完成通知不再突兀。
                    .with_first_job_hook(std::sync::Arc::new(move || {
                        // R18 F1:两条完成通知都被关掉时不要权限——用户已经说了不想被通知。
                        let wanted = core::db::open_project(&primer_db_path)
                            .map(|connection| notify::any_completion_enabled(&connection))
                            .unwrap_or(true);
                        if !wanted {
                            return;
                        }
                        notify::post(
                            &permission_app,
                            notify::BACKGROUND_STARTED_TITLE,
                            "完成后会用系统通知提醒你;可在系统设置里关闭",
                        );
                    }));
                let control = runner.control();
                // R16 P1-6:上次退出前按了「全部暂停」就照旧暂停着,不偷偷恢复。
                let restore_paused = core::db::open_project(&db_path)
                    .and_then(|connection| core::settings::setting_value(&connection, JOBS_PAUSED_KEY))
                    .map(|value| value.as_deref() == Some("true"))
                    .unwrap_or(false);
                if restore_paused {
                    control.set_paused_by_user(true);
                }
                tauri::async_runtime::spawn(runner.run());
                Some(control)
            };
            *doctor_worker_control
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = worker_control.clone();

            app.manage(RuntimeState {
                db_path: db_path.clone(),
                cache_root: cache_root.clone(),
                media_server,
                worker_count,
                read_only,
                _project_lock: project_lock,
                worker_control: worker_control.clone(),
            });

            if let Some(hourly_control) = worker_control {
                let hourly_db_path = db_path.clone();
                let hourly_snapshots_root = root.join("snapshots");
                let hourly_cache_root = cache_root.clone();
                tauri::async_runtime::spawn(async move {
                    let mut interval = tokio::time::interval(std::time::Duration::from_secs(60 * 60));
                    interval.tick().await;
                    // R18 F6:缓存自动清理搭在这条 interval 上,每 24 拍走一次(默认「从不」,
                    // 设置里没开就是一次空查询)。不另起一条定时器。
                    let mut ticks_since_sweep = 0_u32;
                    loop {
                        interval.tick().await;
                        ticks_since_sweep += 1;
                        if ticks_since_sweep >= 24 {
                            ticks_since_sweep = 0;
                            let sweep_db_path = hourly_db_path.clone();
                            let sweep_cache_root = hourly_cache_root.clone();
                            let swept = tauri::async_runtime::spawn_blocking(move || {
                                let connection = core::db::open_project(&sweep_db_path)?;
                                let Some(days) = core::settings::cache_auto_clean_days(&connection) else {
                                    return Ok(core::cache_gc::StaleSweep::default());
                                };
                                core::cache_gc::sweep_stale_proxies(
                                    &connection,
                                    &sweep_cache_root,
                                    days,
                                    std::time::SystemTime::now(),
                                )
                            })
                            .await;
                            match swept {
                                Ok(Ok(report)) if report.removed > 0 => tracing::info!(
                                    removed = report.removed,
                                    bytes = report.bytes,
                                    "daily cache sweep removed stale proxies"
                                ),
                                Ok(Ok(_)) => {}
                                Ok(Err(error)) => tracing::warn!(%error, "daily cache sweep failed"),
                                Err(error) => tracing::warn!(%error, "daily cache sweep task ended unexpectedly"),
                            }
                        }
                        let control = hourly_control.clone();
                        let db_path = hourly_db_path.clone();
                        let snapshots_root = hourly_snapshots_root.clone();
                        let result = tauri::async_runtime::spawn_blocking(move || {
                            control.with_maintenance(
                                || Ok(()),
                                || {
                                    let connection = core::db::open_project(&db_path)?;
                                    core::db::create_snapshot(&connection, &snapshots_root)
                                },
                            )
                        })
                        .await;
                        match result {
                            Ok(Ok(path)) => tracing::info!(snapshot = %path.display(), "created hourly database snapshot"),
                            Ok(Err(error)) => tracing::warn!(%error, "could not create hourly database snapshot"),
                            Err(error) => tracing::warn!(%error, "hourly database snapshot task ended unexpectedly"),
                        }
                    }
                });
            }
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| CoreError::BackgroundTask("主窗口不存在".to_owned()))?;
            // R18 H-15:后台任务跑着的时候 Dock 图标上有进度条,干完自己清掉。
            // 判定在 `dock::DockProgress`(峰值法,不回退);这里只负责每秒喂一次数。
            dock::spawn_watcher(window.as_ref().window(), db_path.clone());
            // M-02:存下来的位置可能落在一块已经拔掉的屏上(实测 window.x=5000 → 窗口
            // 停在屏外,进程活着但用户什么都看不见)。恢复前先跟真实屏幕求交。
            // `available_monitors()` 给的是物理像素,按各自的 scale_factor 换成逻辑坐标再比。
            let monitors: Vec<window_state::Rect> = window
                .available_monitors()
                .unwrap_or_default()
                .iter()
                .map(|monitor| {
                    let scale = monitor.scale_factor();
                    let position = monitor.position();
                    let size = monitor.size();
                    window_state::Rect {
                        x: f64::from(position.x) / scale,
                        y: f64::from(position.y) / scale,
                        width: f64::from(size.width) / scale,
                        height: f64::from(size.height) / scale,
                    }
                })
                .collect();
            let requested = window_state::Rect {
                x: window_state.x.unwrap_or(0.0),
                y: window_state.y.unwrap_or(0.0),
                width: window_state.width,
                height: window_state.height,
            };
            let placement = if window_state.x.is_some() && window_state.y.is_some() {
                window_state::clamp_to_monitors(requested, &monitors)
            } else {
                window_state::Placement::Center { width: requested.width, height: requested.height }
            };
            match placement {
                window_state::Placement::Keep(rect) => {
                    window.set_size(tauri::LogicalSize::new(rect.width, rect.height))?;
                    window.set_position(tauri::LogicalPosition::new(rect.x, rect.y))?;
                }
                window_state::Placement::Center { width, height } => {
                    window.set_size(tauri::LogicalSize::new(width, height))?;
                    window.center()?;
                }
            }
            // 全屏是单独一个键:全屏尺寸永远不写回 window.width/height(见 window_state.rs)。
            if let Ok(connection) = core::db::open_project(&db_path) {
                match window_state::stored_fullscreen(&connection) {
                    Ok(true) => {
                        if let Err(error) = window.set_fullscreen(true) {
                            tracing::warn!(%error, "全屏态没能恢复");
                        }
                    }
                    Ok(false) => {}
                    Err(error) => tracing::warn!(%error, "读不到全屏态"),
                }
            }
            let state_window = window.clone();
            let state_db_path = db_path.clone();
            let (window_state_sender, window_state_receiver) =
                std::sync::mpsc::channel::<window_state::WindowPersist>();
            std::thread::spawn(move || {
                while let Ok(mut pending) = window_state_receiver.recv() {
                    loop {
                        match window_state_receiver
                            .recv_timeout(std::time::Duration::from_millis(350))
                        {
                            Ok(next) => pending = next,
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    if let Ok(mut connection) = core::db::open_project(&state_db_path) {
                        // M-02:全屏时 geometry 是 None —— 全屏的 1800×1130 不是用户的窗口大小,
                        // 写回去下次就打开一个几乎铺满屏幕的普通窗口(§1.3 实测)。
                        if let Some(geometry) = pending.geometry {
                            if let Err(error) =
                                core::settings::save_window_state(&mut connection, geometry)
                            {
                                tracing::warn!(%error, "could not persist window state");
                            }
                        }
                        if let Err(error) =
                            window_state::save_fullscreen(&connection, pending.fullscreen)
                        {
                            tracing::warn!(%error, "could not persist fullscreen state");
                        }
                    }
                }
            });
            window.on_window_event(move |event| {
                if !matches!(
                    event,
                    tauri::WindowEvent::Moved(_)
                        | tauri::WindowEvent::Resized(_)
                        | tauri::WindowEvent::ScaleFactorChanged { .. }
                ) {
                    return;
                }
                let fullscreen = state_window.is_fullscreen().unwrap_or(false);
                let scale = state_window.scale_factor().unwrap_or(1.0);
                let geometry = if fullscreen {
                    None
                } else {
                    match (state_window.outer_size(), state_window.outer_position()) {
                        (Ok(size), Ok(position)) => Some(WindowState {
                            width: f64::from(size.width) / scale,
                            height: f64::from(size.height) / scale,
                            x: Some(f64::from(position.x) / scale),
                            y: Some(f64::from(position.y) / scale),
                        }),
                        _ => return,
                    }
                };
                let _ = window_state_sender.send(window_state::WindowPersist { geometry, fullscreen });
            });
            // F2:关窗口时如果还有用户的活儿在跑,先问一句再退(空闲家务不算)。
            {
                let close_app = app.handle().clone();
                let close_db_path = db_path.clone();
                window.on_window_event(move |event| {
                    let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                        return;
                    };
                    if close_app.state::<exit_guard::ExitState>().is_confirmed() {
                        return; // 已经问过了,这一次放行
                    }
                    let Ok(connection) = core::db::open_project(&close_db_path) else {
                        return; // 读不到库就别拦人——拦住退不掉比少问一句更糟
                    };
                    let Ok(running) = core::jobs::list_running_jobs(&connection) else {
                        return;
                    };
                    let count = exit_guard::blocking_job_count(
                        running.iter().map(|job| job.kind.as_str()),
                    );
                    if count == 0 {
                        return;
                    }
                    api.prevent_close();
                    if let Err(error) = close_app
                        .emit("tripcut:close-requested", exit_guard::close_requested_payload(count))
                    {
                        // 前端没接住就没人能确认了 —— 宁可放它退出,也不要锁死窗口。
                        tracing::warn!(%error, "退出确认没能送到前端,直接放行");
                        close_app.state::<exit_guard::ExitState>().confirm();
                        close_app.exit(0);
                    }
                });
            }
            #[cfg(target_os = "macos")]
            {
                let player = PlayerManager::new(window.clone());
                let resize_player = player.clone();
                window.on_window_event(move |event| {
                    if matches!(
                        event,
                        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
                    ) {
                        resize_player.request_redraw();
                    }
                });
                app.manage(player);
            }
            #[cfg(target_os = "macos")]
            {
                // R6 Task 4:睡眠唤醒。objc2/objc2-app-kit/block2 已经是直接依赖
                // (播放器那半边就在用),不必为这一个通知再引入一整套额外绑定或
                // 退化成 30 秒轮询猜内存钟跳变——`NSWorkspaceDidWakeNotification`
                // 就是操作系统本来就会发的那条真实事件。
                //
                // `addObserverForName:object:queue:usingBlock:` 返回的 token 不
                // 用来注销——进程活着就一直听。NSNotificationCenter 内部会保留
                // (retain)这个 block 式 observer 本身,所以就算这里把 `token`
                // drop 掉,投递也不会停;塞进 `app.manage` 不是为了防止投递停
                // 止,而是让 `WakeObserver` 的生命周期显式绑定到应用进程,避免
                // 有人误读成"可以随手 drop"再手滑真去调用注销。
                let app_handle = app.handle().clone();
                let workspace = NSWorkspace::sharedWorkspace();
                let center = workspace.notificationCenter();
                let main_queue = NSOperationQueue::mainQueue();
                let wake_block = block2::RcBlock::new(move |_note: std::ptr::NonNull<NSNotification>| {
                    runtime::on_wake(&app_handle);
                });
                // SAFETY: `addObserverForName:object:queue:usingBlock:` requires a
                // valid Objective-C block and a valid NSOperationQueue for the
                // duration of the call. `wake_block` is a real retained ObjC block
                // (`block2::RcBlock`) constructed just above, and `main_queue` is
                // the process-lifetime main operation queue, so both are valid.
                // `app_handle` is captured by value into the block; NSNotification-
                // Center retains the block (and therefore `app_handle`) on our
                // behalf, so nothing this call touches is freed before it returns.
                let observer = unsafe {
                    center.addObserverForName_object_queue_usingBlock(
                        Some(NSWorkspaceDidWakeNotification),
                        None,
                        Some(&main_queue),
                        &wake_block,
                    )
                };
                app.manage(WakeObserver(observer));
            }
            // R18 W-4:启动补扫挪到窗口之后。
            //
            // 原来这 12 步 + 一次整库 `VACUUM INTO` 全部同步跑在 `setup()` 里、开窗之前:
            // 13 次全表扫加一次整库复制,全部按库大小线性增长,全部挡在第一帧前面。
            // 现在开窗前只留两件事:`refresh_missing_flags_throttled`(首屏的「文件不见了」
            // 标记要靠它)与 `library_census`(A16-02 那条 warn 的判据,必须在任何东西
            // 动库之前数)。其余的进这个 `spawn_blocking`。
            //
            // 代价说清楚:启动快照从「开窗前一定写完」变成「开窗后几百毫秒写完」,
            // 这中间崩溃就没有本次快照。`library_census` 仍在前面,所以「库被清空」
            // 那条取证判据不受影响。
            if !read_only {
                let backfill_db_path = db_path.clone();
                let backfill_cache_root = cache_root.clone();
                let backfill_snapshots_root = root.join("snapshots");
                let backfill_report = report.clone();
                let backfill_app = app.handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = tauri::Emitter::emit(&backfill_app, STARTUP_BACKFILL_EVENT, true);
                    let started = std::time::Instant::now();
                    let outcome = startup_backfill(
                        &backfill_db_path,
                        &backfill_cache_root,
                        &backfill_snapshots_root,
                        &backfill_report,
                    );
                    if let Err(error) = outcome {
                        tracing::warn!(%error, "startup backfill failed");
                    }
                    tracing::info!(elapsed_ms = started.elapsed().as_millis() as u64, "startup backfill finished");
                    let _ = tauri::Emitter::emit(&backfill_app, STARTUP_BACKFILL_EVENT, false);
                });
            }
            tracing::info!(
                startup_ms = process_started.elapsed().as_millis() as u64,
                "setup finished; window is up"
            );
            // R19 E-05:同一个时间点再打一条 `rust_setup_ms`(与 `startup_ms` 数值相同,
            // 命名对齐 E-05 的两段拆分:rust_setup_ms + 前端 mark_first_paint 报的
            // first_paint_ms)。不改 startup_ms 原有读者。
            tracing::info!(
                rust_setup_ms = process_started.elapsed().as_millis() as u64,
                "rust setup done"
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_duel, duel_action,
            confirm_exit,
            open_url,
            mark_first_paint,
            get_doctor_report,
            restore_latest_snapshot,
            export_decision_data,
            rebuild_recovery_cache,
            reset_recovery_library,
            open_logs_directory,
            get_media_server_info,
            get_app_info,
            search_everything,
            list_ocr_hits,
            enqueue_ocr_for_episode,
            get_memory_lens,
            set_routine_override,
            accept_all_routine_suggestions,
            get_narrative_revision,
            apply_narrative_op,
            undo_narrative_op,
            list_story_gaps,
            detect_story_gaps,
            dismiss_story_gap,
            reopen_story_gap,
            list_watched_folders,
            set_watched_folder_sync,
            remove_watched_folder,
            rescan_watched_folders,
            get_component_statuses,
            import_whisper_model,
            rollback_component,
            start_component_install,
            get_install_progress,
            cancel_component_install,
            list_models,
            start_model_download,
            cancel_model_download,
            open_provider_login,
            list_episodes,
            get_current_episode,
            rename_current_episode,
            rename_episode,
            move_clips_to_episode,
            archive_current_episode,
            create_episode,
            delete_episode,
            list_platform_presets,
            set_episode_platform,
            get_settings,
            set_setting,
            get_first_run_done,
            set_first_run_done,
            get_llm_status,
            list_llm_ledger,
            set_minimax_key,
            clear_minimax_key,
            has_minimax_key,
            generation_availability,
            generation_ledger_summary,
            get_ai_description,
            get_clip_brief,
            describe_clip_with_ai,
            ask_director,
            get_settings_status,
            clear_cache_and_rebuild,
            reset_project_library,
            run_clip_self_check,
            pick_import_folder,
            pick_relink_folder,
            pick_export_folder,
            pick_music_file,
            pick_whisper_model_file,
            pick_lut_file,
            import_music_track,
            list_music_tracks,
            get_music_analysis_progress,
            get_music_analysis,
            delete_music_track,
            list_libraries,
            create_library,
            set_library_hidden,
            switch_library,
            list_import_batches,
            cancel_import_batch,
            dismiss_import_notices,
            preview_import_removal,
            remove_imported_material,
            start_import,
            import_paths,
            get_import_progress,
            list_clips,
            get_clips_revision,
            get_journey_timeline,
            list_missing_clips,
            relink_volume,
            list_device_clocks,
            set_device_clock_offset,
            list_clip_dimensions,
            set_clip_time_stage,
            probe_audio_tracks,
            list_audio_tracks,
            set_display_lut,
            clear_display_lut,
            set_playback_track,
            set_transcribe_track,
            list_display_luts,
            import_lut,
            rate_clip,
            clear_clip_rating,
            rate_clips,
            list_select_segments,
            create_select_segment,
            delete_select_segment,
            restore_select_segment,
            get_clip_analysis,
            get_clip_moments,
            suggest_segments,
            auto_select_episode,
            auto_select_episode_with,
            list_auto_select_run,
            replace_auto_segment,
            undo_replace_auto_segment,
            undo_auto_select,
            arrange_selected_segments,
            undo_arrange,
            skip_chapter,
            get_moments_progress,
            enqueue_moments_backfill,
            search_transcripts,
            search_clips,
            list_similar_groups,
            set_similar_primary,
            list_shot_stacks,
            list_asset_safety,
            apply_rescue_range,
            set_shot_stack_user_state,
            get_storyboard,
            enqueue_narrate_episode,
            list_story_templates,
            update_destination_card,
            set_destination_card_verified,
            set_destination_field_state,
            set_story_order,
            set_band_order,
            trim_band_segment,
            rename_chapter,
            merge_chapters,
            delete_chapter,
            undo_story_change,
            get_clip_artifacts,
            frame_at,
            start_export,
            quick_export,
            plan_quick_export,
            preview_export_canvas,
            get_export_status,
            list_archive_ops,
            resume_archive,
            undo_archive,
            cancel_export,
            cancel_job,
            preview_generation,
            submit_generation,
            retry_generation,
            cancel_generation,
            list_generation_requests,
            reveal_export,
            get_jianying_availability,
            generate_jianying_draft,
            set_jianying_human_check,
            open_app,
            export_jianying_kit,
            export_selected_photos,
            plan_selected_photos,
            plan_jianying_kit,
            #[cfg(target_os = "macos")]
            player_set_viewport,
            #[cfg(target_os = "macos")]
            player_set_occluded,
            #[cfg(target_os = "macos")]
            player_open,
            #[cfg(target_os = "macos")]
            player_close,
            #[cfg(target_os = "macos")]
            player_command,
            #[cfg(target_os = "macos")]
            player_set_speed,
            #[cfg(target_os = "macos")]
            player_status,
            simulate_wake,
            // R16 车道 C:新命令统一追加在这里(不重排)。
            relink_clip,
            pick_relink_file,
            set_jobs_paused,
            get_jobs_paused,
            // R17 车道 A:应用内自动升级。
            check_for_update,
            download_update,
            download_and_install,
            install_staged_update,
            restart_to_update,
            get_auto_update_plan,
            get_update_status,
            list_running_jobs,
            retry_clip_analysis,
            delete_whisper_model,
            delete_display_lut,
            reveal_clip,
            list_tags,
            add_tag,
            remove_tag,
            // R18 车道 settings:失败任务清单 / 清空全部失败 / 导出诊断包。
            list_failed_jobs,
            clear_failed_jobs,
            inspect_paths,
            download_cloud_file,
            pick_cache_folder,
            relocate_cache_dir,
            export_diagnostics_bundle
        ])
        .build(context);
    let app = result.expect("旅剪工作台启动失败");
    // macOS 上退出走 process::exit,run() 之后的代码永不执行;必须在 Exit 事件里清哨兵。
    app.run(move |app_handle, event| {
        // R18 M-06①:Dock 图标拖入 /「打开方式」/ 双击关联文件都走这一条。
        // macOS 会在应用已经在跑的时候再发一次,所以这里只把路径转给前端——
        // 由 `useGlobalDrop` 调同一个 `import_paths`,不另起第二条导入路径。
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &event {
            let paths = opened::opened_paths_to_import_request(urls, |path| path.is_dir());
            if paths.is_empty() {
                tracing::info!(count = urls.len(), "打开请求里没有可导入的视频或文件夹");
            } else if let Err(error) = tauri::Emitter::emit(app_handle, opened::OPENED_PATHS_EVENT, &paths) {
                tracing::warn!(%error, "打开请求没能转给前端");
            }
        }
        if matches!(event, tauri::RunEvent::Exit) {
            // R17 车道 A:后台下载好的更新包在退出时才替换 bundle(运行中替换会混用两版资源)。
            update_flow::install_staged_on_exit(app_handle);
            if let Some(root) = clean_shutdown_root
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take()
            {
                if let Err(error) = core::doctor::clear_sentinel(&root) {
                    tracing::warn!(%error, "could not clear clean-shutdown sentinel");
                }
            }
        }
    });
}

/// R7 Task 5 复审 P1-2:三个花钱/改状态的生成命令必须都过只读闸。
/// Tauri 命令的 `State<RuntimeState>` 在单元测试里造不出来,所以这里用
/// 源文本当检测器——闸被谁删掉、或新加的生成命令忘了带闸,这条会红。
/// (`guard_writable` 自身的行为由
/// `core::generation::tests::guard_writable_refuses_read_only_window` 钉住。)
#[cfg(test)]
mod generation_command_guard_tests {
    const SOURCE: &str = include_str!("lib.rs");

    fn command_body(name: &str) -> &'static str {
        let marker = format!("\nfn {name}(");
        let start = SOURCE.find(&marker).unwrap_or_else(|| panic!("找不到命令 {name}"));
        let rest = &SOURCE[start..];
        let end = rest[1..].find("\n#[tauri::command]").map(|at| at + 1).unwrap_or(rest.len());
        &rest[..end]
    }

    #[test]
    fn generation_mutating_commands_all_guard_read_only_windows() {
        for name in ["submit_generation", "retry_generation", "cancel_generation"] {
            assert!(
                command_body(name).contains("core::generation::guard_writable(state.read_only)"),
                "命令 {name} 缺少只读窗口闸"
            );
        }
    }
}

#[cfg(test)]
mod open_app_tests {
    use super::{open_app, open_app_allowed};

    #[test]
    fn only_jianying_bundle_id_is_allowed() {
        assert!(open_app_allowed("com.lemon.lvpro"));
        for other in ["com.apple.Terminal", "com.lemon.lvpro.evil", "", "COM.LEMON.LVPRO", "/Applications/Calculator.app"] {
            assert!(!open_app_allowed(other), "{other} 不该被放行");
        }
    }

    #[test]
    fn open_app_refuses_before_spawning_anything() {
        let error = open_app("com.apple.Terminal".to_owned()).unwrap_err();
        assert!(error.contains("不允许打开应用"), "{error}");
    }
}

#[cfg(test)]
mod wake_simulation_tests {
    use super::wake_simulation_permitted;

    // 同一个环境变量,两条分支都要覆盖到;写成一个测试避免并行测试线程
    // 互相踩这个进程级全局变量的读写。
    #[test]
    fn only_the_exact_value_one_permits_simulate_wake() {
        unsafe {
            std::env::remove_var("TRIPCUT_SIMULATE_WAKE");
        }
        assert!(!wake_simulation_permitted(), "没设置时必须拒绝");

        unsafe {
            std::env::set_var("TRIPCUT_SIMULATE_WAKE", "true");
        }
        assert!(!wake_simulation_permitted(), "非「1」的真值字面量也必须拒绝");

        unsafe {
            std::env::set_var("TRIPCUT_SIMULATE_WAKE", "1");
        }
        assert!(wake_simulation_permitted(), "恰好是「1」时才允许");

        unsafe {
            std::env::remove_var("TRIPCUT_SIMULATE_WAKE");
        }
    }
}


// 自动化只能把导出目录放在显式隔离 profile 之内;无环境变量时保留原生面板。
fn isolated_export_directory(directory: Option<PathBuf>, profile: Option<PathBuf>) -> std::result::Result<Option<String>, String> {
    let Some(directory) = directory else { return Ok(None) };
    let profile = profile.ok_or("自动化导出需要隔离素材库目录")?;
    let profile = profile.canonicalize().map_err(|error| error.to_string())?;
    let directory = directory.canonicalize().map_err(|error| error.to_string())?;
    if !directory.is_dir() || directory == profile || !directory.starts_with(&profile) {
        return Err("自动化导出目录必须位于隔离素材库内".to_owned());
    }
    Ok(Some(directory.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod r20_export_tests {
    use super::*;
    #[test]
    fn export_override_is_scoped_to_an_explicit_isolated_profile() {
        let temp = core::test_support::TestDirectory::new();
        let inside = temp.path().join("export-out");
        std::fs::create_dir(&inside).unwrap();
        assert_eq!(isolated_export_directory(None, None).unwrap(), None);
        assert!(isolated_export_directory(Some(inside.clone()), None).is_err());
        assert!(isolated_export_directory(Some(std::env::temp_dir()), Some(temp.path().to_path_buf())).is_err());
        assert!(isolated_export_directory(Some(inside), Some(temp.path().to_path_buf())).unwrap().is_some());
    }
}

use crate::core::duel;

/// R21 PH-05:擂台会话在 `core::duel`;只读窗口一律拒绝写命令。
#[tauri::command]
fn start_duel(members: Vec<duel::Member>, source: String, state: tauri::State<'_, RuntimeState>) -> std::result::Result<duel::Session, String> {
    if state.read_only {
        return Err("只读窗口不能裁决".into());
    }
    let mut c = core::db::open_project(&state.db_path).map_err(|e| e.to_string())?;
    duel::start_duel(&mut c, members, &source).map_err(|e| e.to_string())
}

#[tauri::command]
fn duel_action(
    session_id: i64,
    action: String,
    winner: Option<String>,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<duel::Session, String> {
    if state.read_only && action != "get" {
        return Err("只读窗口不能裁决".into());
    }
    let mut c = core::db::open_project(&state.db_path).map_err(|e| e.to_string())?;
    match action.as_str() {
        "get" => duel::get_session(&c, session_id),
        "decide" => duel::decide(&mut c, session_id, winner),
        "undo_last" => duel::undo_last(&mut c, session_id),
        "finish" => duel::finish(&mut c, session_id),
        "undo_session" => duel::undo_session(&mut c, session_id),
        _ => Err(core::error::CoreError::Rating("未知擂台操作".into())),
    }
    .map_err(|e| e.to_string())
}

// R22: expensive extraction stays off the UI thread and outside player/.
#[tauri::command]
async fn frame_at(clip_id: i64, seconds: f64, state: tauri::State<'_, RuntimeState>) -> std::result::Result<String, String> {
    if state.read_only { return Err("只读项目无法生成预览缓存".into()); }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let connection = core::db::open_project(&state.db_path).map_err(|e| e.to_string())?;
        let path = core::scrubber_frames::frame_at(&connection, &state.cache_root, clip_id, seconds).map_err(|e| e.to_string())?;
        let name = path.file_name().and_then(|s| s.to_str()).ok_or("预览文件名无效")?;
        core::media_server::signed_cache_url(state.media_server.port, &state.media_server.token, clip_id, name).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}
