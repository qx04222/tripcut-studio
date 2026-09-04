pub mod core;
mod app_paths;
mod libraries;
mod packaging;
#[cfg(target_os = "macos")]
pub mod player;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::Manager;

use crate::core::analysis::ClipAnalysis;
use crate::core::asset_safety::AssetSafetyInfo;
use crate::core::artifacts::ClipArtifacts;
use crate::core::canonical_time::DeviceClockSetting;
use crate::core::clip_dimensions::ClipDimension;
use crate::core::clip_search::ClipSearchHit;
use crate::core::deliver::ExportStatus;
use crate::core::doctor::DoctorReport;
use crate::core::error::{CoreError, Result};
use crate::core::import::{ClipListItem, ImportProgress, ImportStart};
use crate::core::jianying::{JianyingAvailability, JianyingDraftResult};
use crate::core::llm::{
    AiDescriptionResult, DirectorAnswerResult, DirectorContext, LlmLedgerEntry, LlmStatus,
};
use crate::core::media_server::MediaServerInfo;
use crate::core::ratings::{ClipRating, SelectSegment};
use crate::core::similar::SimilarGroup;
use crate::core::settings::{CacheRebuildResult, SettingsStatus, WindowState};
use crate::core::shot_stack::ShotStack;
use crate::core::transcribe::TranscriptMatch;
use crate::core::story::{StoryOrderRef, Storyboard};
#[cfg(target_os = "macos")]
use crate::player::{PlayerCommand, PlayerManager, PlayerStatus, PlayerViewport};

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
            let prepare_path = db_path.clone();
            let operation_path = db_path.clone();
            let operation_cache = cache_root.clone();
            let result = control.with_maintenance(
                || {
                    let mut connection = core::db::open_project(&prepare_path)?;
                    core::jobs::cancel_cache_jobs(&mut connection)?;
                    Ok(())
                },
                || {
                    let mut connection = core::db::open_project(&operation_path)?;
                    core::settings::clear_cache_and_rebuild(&mut connection, &operation_cache)
                },
            )?;
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
    core::import::rescan_watched_folders(&mut connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_component_statuses(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Vec<core::provisioning::ComponentStatus>, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::provisioning::component_statuses(&connection).map_err(|error| error.to_string())
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
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<core::episode::ArchiveOutcome, String> {
    let mut connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::episode::archive_current(&mut connection, next_title.as_deref())
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
    tauri::async_runtime::spawn_blocking(move || {
        let prepare_path = db_path.clone();
        worker_control.with_maintenance(
            || {
                let mut connection = core::db::open_project(&prepare_path)?;
                core::jobs::cancel_cache_jobs(&mut connection)?;
                Ok(())
            },
            || {
                let mut connection = core::db::open_project(&db_path)?;
                core::settings::clear_cache_and_rebuild(&mut connection, &cache_root)
            },
        )
    })
    .await
    .map_err(|error| format!("缓存重建任务异常结束：{error}"))?
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
async fn pick_export_folder() -> std::result::Result<Option<String>, String> {
    Ok(rfd::AsyncFileDialog::new()
        .set_title("选择交付包保存位置")
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
    let cache = state.cache_root.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<usize> {
        let mut connection=core::db::open_project(&path)?;
        // Stop scans before waiting for their gate, so a large NAS traversal
        // cannot make the removal button wait for a complete directory walk.
        core::import_control::prepare_removal(&mut connection,&request)?;
        let gate=core::import::import_gate(&connection);
        drop(connection);
        let _import_guard=gate.lock().unwrap_or_else(|e|e.into_inner());
        control.with_maintenance(
            || { let mut c=core::db::open_project(&path)?; core::import_control::prepare_removal(&mut c,&request) },
            || {
                let mut c=core::db::open_project(&path)?;
                core::db::create_snapshot(&c,&path.parent().unwrap().join("snapshots"))?;
                let ids=core::import_control::removal_ids(&c,&request)?;
                let count=core::import_control::remove_records(&mut c,&request)?;
                for id in ids {
                    let directory=cache.join(id.to_string());
                    if directory.exists() {
                        if let Err(error)=std::fs::remove_dir_all(&directory) { tracing::warn!(%error, clip_id=id,"removed clip cache cleanup deferred"); }
                    }
                }
                Ok(count)
            }
        )
    }).await.map_err(|e|e.to_string())?.map_err(|e|e.to_string())
}

#[tauri::command]
fn get_import_progress(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<ImportProgress, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::import::get_import_progress(&connection).map_err(|error| error.to_string())
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
fn get_storyboard(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<Storyboard, String> {
    let connection = core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::story::get_storyboard(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn enqueue_narrate_episode(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<i64, String> {
    let mut connection =
        core::db::open_project(&state.db_path).map_err(|error| error.to_string())?;
    core::narrative::enqueue(&mut connection).map_err(|error| error.to_string())
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

#[tauri::command]
async fn start_export(
    dest: String,
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<ExportStatus, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = core::db::open_project(&db_path)?;
        core::deliver::start_export(&mut connection, &PathBuf::from(dest))
    })
    .await
    .map_err(|error| format!("交付任务异常结束：{error}"))?
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
fn get_jianying_availability() -> JianyingAvailability {
    core::jianying::availability()
}

#[tauri::command]
async fn generate_jianying_draft(
    state: tauri::State<'_, RuntimeState>,
) -> std::result::Result<JianyingDraftResult, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = core::db::open_project(&db_path)?;
        core::jianying::generate_native_draft(&mut connection)
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
        let (path, time_mapper) =
            crate::player::resolve_playback_source(&db_path, &cache_root, clip_id)?;
        player.open(path, clip_id, time_mapper)
    })
    .await
    .map_err(|error| format!("播放器启动任务异常结束：{error}"))?
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let clean_shutdown_root = Arc::new(Mutex::new(None::<PathBuf>));
    let setup_clean_shutdown_root = clean_shutdown_root.clone();
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ProvisioningState::default())
        .setup(move |app| {
            packaging::configure(app);
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

            let mut connection = core::db::open_project(&db_path)?;
            if !read_only {
                // NAS/云盘工作流:每 5 分钟对 auto_sync 关注文件夹增量重扫(导入幂等)。
                let sync_db_path = db_path.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(300));
                    if let Ok(mut sync_connection) = core::db::open_project(&sync_db_path) {
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
                let metadata_jobs = core::import::enqueue_metadata_backfill(&mut connection)?;
                if metadata_jobs > 0 {
                    tracing::info!(metadata_jobs, "enqueued incremental temporal metadata backfill");
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
            let window_state = core::settings::window_state(&connection)?;
            drop(connection);

            let media_server = tauri::async_runtime::block_on(core::media_server::start(
                cache_root.clone(),
            ))?;
            let worker_control = if read_only {
                None
            } else {
                let runner = core::jobs::JobRunner::new(db_path.clone(), worker_count);
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_doctor_report,
            restore_latest_snapshot,
            export_decision_data,
            rebuild_recovery_cache,
            open_logs_directory,
            get_media_server_info,
            get_app_info,
            search_everything,
            get_memory_lens,
            set_routine_override,
            accept_all_routine_suggestions,
            get_narrative_revision,
            apply_narrative_op,
            undo_narrative_op,
            list_watched_folders,
            set_watched_folder_sync,
            remove_watched_folder,
            rescan_watched_folders,
            get_component_statuses,
            start_component_install,
            get_install_progress,
            cancel_component_install,
            open_provider_login,
            list_episodes,
            get_current_episode,
            rename_current_episode,
            archive_current_episode,
            get_settings,
            set_setting,
            get_llm_status,
            list_llm_ledger,
            get_ai_description,
            describe_clip_with_ai,
            ask_director,
            get_settings_status,
            clear_cache_and_rebuild,
            run_clip_self_check,
            pick_import_folder,
            pick_export_folder,
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
            get_import_progress,
            list_clips,
            list_device_clocks,
            set_device_clock_offset,
            list_clip_dimensions,
            set_clip_time_stage,
            rate_clip,
            clear_clip_rating,
            list_select_segments,
            create_select_segment,
            delete_select_segment,
            get_clip_analysis,
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
            update_destination_card,
            set_destination_card_verified,
            set_destination_field_state,
            set_story_order,
            rename_chapter,
            merge_chapters,
            undo_story_change,
            get_clip_artifacts,
            start_export,
            get_export_status,
            cancel_export,
            cancel_job,
            reveal_export,
            get_jianying_availability,
            generate_jianying_draft,
            #[cfg(target_os = "macos")]
            player_set_viewport,
            #[cfg(target_os = "macos")]
            player_open,
            #[cfg(target_os = "macos")]
            player_close,
            #[cfg(target_os = "macos")]
            player_command,
            #[cfg(target_os = "macos")]
            player_status
        ])
        .build(tauri::generate_context!());
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
