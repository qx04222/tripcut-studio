pub mod core;
mod app_paths;
mod libraries;
mod notify;
mod packaging;
mod updater;
#[cfg(target_os = "macos")]
pub mod player;
pub mod runtime;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::Manager;

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
                &format!("kind IN {}", core::jobs::CACHE_JOB_KINDS_SQL),
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
) -> Result<core::settings::ResetLibraryResult> {
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
    tauri::async_runtime::spawn_blocking(move || reset_library_blocking(&db_path, &cache_root, control.as_ref()))
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
    let model_tier = core::settings::string_value(
        &connection,
        core::settings::WHISPER_MODEL_TIER_KEY,
        "large-v3-turbo",
    )
    .map_err(|error| error.to_string())?;
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
    let model_tier = core::settings::string_value(
        &connection,
        core::settings::WHISPER_MODEL_TIER_KEY,
        "large-v3-turbo",
    )
    .map_err(|error| error.to_string())?;
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
    let model_tier = core::settings::string_value(
        &connection,
        core::settings::WHISPER_MODEL_TIER_KEY,
        "large-v3-turbo",
    )
    .map_err(|error| error.to_string())?;
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
        reset_library_blocking(&db_path, &cache_root, Some(&worker_control))
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

#[tauri::command]
fn undo_story_change(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<(), String> {
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
    runtime: tauri::State<'_, RuntimeState>,
    player: tauri::State<'_, PlayerManager>,
) -> std::result::Result<PlayerStatus, String> {
    let db_path = runtime.db_path.clone();
    let cache_root = runtime.cache_root.clone();
    let player = player.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (connection, path, time_mapper) =
            crate::player::resolve_playback_source(&db_path, &cache_root, clip_id)?;
        let status = player.open(path, clip_id, time_mapper)?;
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
    player: tauri::State<'_, PlayerManager>,
) -> std::result::Result<(), String> {
    let player = player.inner().clone();
    tauri::async_runtime::spawn_blocking(move || player.command(cmd))
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
    player.status()
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
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ProvisioningState::default())
        .setup(move |app| {
            packaging::configure(app);
            *setup_signal_app_handle
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(app.handle().clone());
            let root = development_root()?;
            let db_path = root.join("project.db");
            let cache_root = root.join("cache");
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
                let clip_embeddings =
                    core::clip_search::enqueue_missing(&mut connection, &cache_root)?;
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
                    core::clip_dimensions::enqueue_missing(&mut connection, &cache_root)?;
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

                let snapshots_root = root.join("snapshots");
                let snapshot = core::db::create_snapshot(&connection, &snapshots_root);
                report
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .record_snapshot(&snapshots_root, &snapshot);
                if let Err(error) = snapshot {
                    tracing::warn!(%error, "could not create startup database snapshot");
                }
            }
            let worker_count = core::settings::worker_count(&connection)?;
            let decode_permits = core::memory_profile::resolve(&connection)?.decode_permits();
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
                // R10 U-19:应用内事件出口——音乐分析等任务落到终态时 `app.emit`
                // 给前端(`tripcut:music-analyzed`),前端不用等下次轮询/重启。
                let event_app = app.handle().clone();
                let permission_app = app.handle().clone();
                let runner = core::jobs::JobRunner::new(db_path.clone(), worker_count)
                    .with_decode_limit(decode_permits)
                    .with_notifier(std::sync::Arc::new(move |title: &str, body: &str| {
                        notify::post(&notifier_app, title, body)
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
                        notify::post(
                            &permission_app,
                            notify::BACKGROUND_STARTED_TITLE,
                            "完成后会用系统通知提醒你;可在系统设置里关闭",
                        );
                    }));
                let control = runner.control();
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
                tauri::async_runtime::spawn(async move {
                    let mut interval = tokio::time::interval(std::time::Duration::from_secs(60 * 60));
                    interval.tick().await;
                    loop {
                        interval.tick().await;
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
            window.set_size(tauri::LogicalSize::new(
                window_state.width,
                window_state.height,
            ))?;
            if let (Some(x), Some(y)) = (window_state.x, window_state.y) {
                window.set_position(tauri::LogicalPosition::new(x, y))?;
            } else {
                window.center()?;
            }
            let state_window = window.clone();
            let state_db_path = db_path.clone();
            let (window_state_sender, window_state_receiver) =
                std::sync::mpsc::channel::<WindowState>();
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
                        if let Err(error) =
                            core::settings::save_window_state(&mut connection, pending)
                        {
                            tracing::warn!(%error, "could not persist window state");
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
                let scale = state_window.scale_factor().unwrap_or(1.0);
                let Ok(size) = state_window.outer_size() else {
                    return;
                };
                let Ok(position) = state_window.outer_position() else {
                    return;
                };
                let saved = WindowState {
                    width: f64::from(size.width) / scale,
                    height: f64::from(size.height) / scale,
                    x: Some(f64::from(position.x) / scale),
                    y: Some(f64::from(position.y) / scale),
                };
                let _ = window_state_sender.send(saved);
            });
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            open_provider_login,
            list_episodes,
            get_current_episode,
            rename_current_episode,
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
            list_select_segments,
            create_select_segment,
            delete_select_segment,
            restore_select_segment,
            get_clip_analysis,
            get_clip_moments,
            suggest_segments,
            auto_select_episode,
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
            rename_chapter,
            merge_chapters,
            undo_story_change,
            get_clip_artifacts,
            start_export,
            quick_export,
            plan_quick_export,
            preview_export_canvas,
            get_export_status,
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
            simulate_wake
        ])
        .build(context);
    let app = result.expect("旅剪工作台启动失败");
    // macOS 上退出走 process::exit,run() 之后的代码永不执行;必须在 Exit 事件里清哨兵。
    app.run(move |_app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
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
