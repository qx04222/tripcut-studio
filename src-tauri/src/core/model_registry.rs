//! R19 P-06 ②:进程内下载任务表 + 设置页 / 首启气泡读的模型卡片。
//! 下载引擎在 `model_download.rs`;这里只管「同一模型同一时刻一条」、取消标志、
//! 以及把清单 × 本机内存档 × 任务表 × 磁盘状态折成前端要的一张卡。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use super::error::{CoreError, Result};
use super::memory_profile::MemoryProfile;
use super::model_catalog::{ModelKind, ModelSpec, CATALOG_FETCHED_ON, MODEL_CATALOG};
use super::model_download::{download_model, DownloadOptions, ModelProgress};

// ---------------------------------------------------------------------------
// 进程内任务表:一个模型同一时刻只有一条下载;lib.rs 用它起线程、报进度、取消。
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "phase", rename_all = "kebab-case")]
pub enum TaskPhase {
    Downloading { downloaded: u64, total: u64 },
    Installed,
    Cancelled,
    Error { message: String },
}

struct TaskHandle {
    cancel: Arc<AtomicBool>,
    phase: Arc<Mutex<TaskPhase>>,
}

#[derive(Default)]
pub struct DownloadRegistry {
    tasks: Mutex<HashMap<String, TaskHandle>>,
}

impl DownloadRegistry {
    pub fn phase_of(&self, model_id: &str) -> Option<TaskPhase> {
        let tasks = self.tasks.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        tasks.get(model_id).map(|task| task.phase.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone())
    }

    pub fn is_downloading(&self, model_id: &str) -> bool {
        matches!(self.phase_of(model_id), Some(TaskPhase::Downloading { .. }))
    }

    /// 起一条后台下载;已在下载中的模型返回错误。`sink` 收到每一条进度(调用方拿去 emit 事件、
    /// 做装完之后的启用动作);终态事件发出前任务表里的 phase 已更新。
    pub fn start(
        &self,
        spec: &'static ModelSpec,
        models_dir: PathBuf,
        options: DownloadOptions,
        mut sink: impl FnMut(&ModelProgress) + Send + 'static,
    ) -> Result<()> {
        let mut tasks = self.tasks.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(existing) = tasks.get(spec.id) {
            if matches!(*existing.phase.lock().unwrap_or_else(std::sync::PoisonError::into_inner), TaskPhase::Downloading { .. }) {
                return Err(CoreError::InvalidTransition(format!("{} 正在下载中", spec.title)));
            }
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let phase = Arc::new(Mutex::new(TaskPhase::Downloading { downloaded: 0, total: spec.total_bytes() }));
        let task_cancel = cancel.clone();
        let task_phase = phase.clone();
        std::thread::Builder::new()
            .name(format!("model-download-{}", spec.id))
            .spawn(move || {
                let _ = download_model(spec, &models_dir, &options, &task_cancel, |event| {
                    let next = match &event {
                        ModelProgress::Downloading { downloaded, total, .. } => Some(TaskPhase::Downloading { downloaded: *downloaded, total: *total }),
                        ModelProgress::Verifying { .. } => None,
                        ModelProgress::Installed { .. } => Some(TaskPhase::Installed),
                        ModelProgress::Cancelled { .. } => Some(TaskPhase::Cancelled),
                        ModelProgress::Error { message, .. } => Some(TaskPhase::Error { message: message.clone() }),
                    };
                    if let Some(next) = next {
                        *task_phase.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = next;
                    }
                    sink(&event);
                });
            })
            .map_err(|error| CoreError::Io(std::io::Error::other(format!("无法启动下载线程:{error}"))))?;
        tasks.insert(spec.id.to_owned(), TaskHandle { cancel, phase });
        Ok(())
    }

    /// 取消:置标志,线程在下一块数据到达(或卡死超时)时退出并删临时文件。没在下载的模型是空操作。
    pub fn cancel(&self, model_id: &str) {
        let tasks = self.tasks.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(task) = tasks.get(model_id) {
            task.cancel.store(true, Ordering::Release);
        }
    }
}

// ---------------------------------------------------------------------------
// 设置页 / 首启气泡读的卡片:清单 × 本机档位 × 任务表 × 磁盘。
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ModelCard {
    pub id: String,
    pub title: String,
    pub purpose: String,
    pub size_bytes: u64,
    pub installed: bool,
    /// 已安装时的落地目录(CLIP)或文件(whisper);未安装为 None。
    pub location: Option<String>,
    /// 这一档机器允不允许装;不允许时 `blocked_reason` 说原因。
    pub allowed: bool,
    pub blocked_reason: Option<String>,
    /// 首启该不该推荐它(≥ 16 GB 推 CLIP + turbo;≤ 8 GB 只推 small)。
    pub recommended: bool,
    /// `idle` | `downloading` | `installed` | `cancelled` | `error`。
    pub phase: String,
    pub downloaded: u64,
    pub total: u64,
    pub error: Option<String>,
    pub fetched_on: String,
}

pub fn model_cards(
    models_dir: &Path,
    profile: MemoryProfile,
    registry: &DownloadRegistry,
) -> Vec<ModelCard> {
    MODEL_CATALOG
        .iter()
        .map(|spec| {
            let installed = spec.installed(models_dir);
            let allowed = spec.allowed_on(profile);
            let (phase, downloaded, total, error) = match registry.phase_of(spec.id) {
                Some(TaskPhase::Downloading { downloaded, total }) => ("downloading", downloaded, total, None),
                Some(TaskPhase::Installed) => ("installed", spec.total_bytes(), spec.total_bytes(), None),
                Some(TaskPhase::Cancelled) => ("cancelled", 0, spec.total_bytes(), None),
                Some(TaskPhase::Error { message }) => ("error", 0, spec.total_bytes(), Some(message)),
                None => (if installed { "installed" } else { "idle" }, 0, spec.total_bytes(), None),
            };
            let location = installed.then(|| {
                let dir = spec.install_dir(models_dir);
                match spec.kind {
                    ModelKind::Clip => dir,
                    ModelKind::Whisper { .. } => dir.join(spec.files[0].name),
                }
                .to_string_lossy()
                .into_owned()
            });
            ModelCard {
                id: spec.id.to_owned(),
                title: spec.title.to_owned(),
                purpose: spec.purpose.to_owned(),
                size_bytes: spec.total_bytes(),
                installed,
                location,
                allowed,
                blocked_reason: (!allowed).then(|| "这台机器内存不够跑它(需要 16 GB 及以上)".to_owned()),
                recommended: spec.recommended_on(profile) && !installed,
                phase: phase.to_owned(),
                downloaded,
                total,
                error,
                fetched_on: CATALOG_FETCHED_ON.to_owned(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::model_catalog::{spec_for_id, CLIP_MODEL_ID, WHISPER_SMALL_MODEL_ID};
    use std::time::Duration;

    #[test]
    fn cards_follow_memory_tier_and_disk_state() {
        use crate::core::memory_profile::MemoryProfile;
        let registry = DownloadRegistry::default();
        let models = std::env::temp_dir().join(format!("tripcut-cards-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&models).unwrap();
        let low_spec = model_cards(&models, MemoryProfile::LowSpec, &registry);
        let clip = low_spec.iter().find(|card| card.id == CLIP_MODEL_ID).unwrap();
        assert!(!clip.allowed && clip.blocked_reason.is_some() && !clip.recommended && clip.phase == "idle");
        let small = low_spec.iter().find(|card| card.id == WHISPER_SMALL_MODEL_ID).unwrap();
        assert!(small.allowed && small.recommended);
        // 装上 small(按字节数造文件)→ installed、不再推荐、location 指向文件。
        let spec = spec_for_id(WHISPER_SMALL_MODEL_ID).unwrap();
        std::fs::File::create(models.join(spec.files[0].name)).unwrap().set_len(spec.files[0].size_bytes).unwrap();
        let again = model_cards(&models, MemoryProfile::LowSpec, &registry);
        let small = again.iter().find(|card| card.id == WHISPER_SMALL_MODEL_ID).unwrap();
        assert!(small.installed && !small.recommended && small.phase == "installed");
        assert_eq!(small.location.as_deref(), Some(models.join("ggml-small.bin").to_str().unwrap()));
        let _ = std::fs::remove_dir_all(&models);
    }

    #[test]
    fn registry_ends_in_error_when_the_source_is_unreachable() {
        let registry = DownloadRegistry::default();
        let spec = spec_for_id(WHISPER_SMALL_MODEL_ID).unwrap();
        let dir = std::env::temp_dir().join(format!("tripcut-registry-{}", uuid::Uuid::new_v4()));
        // 指到一个没人听的回环端口:线程在 connect 阶段失败 → phase 落到 error,可重试。
        let options = DownloadOptions { base_url_override: Some("http://127.0.0.1:9".into()), stall_timeout: Duration::from_secs(1) };
        registry.start(spec, dir.clone(), options.clone(), |_| {}).unwrap();
        for _ in 0..400 {
            if !registry.is_downloading(spec.id) {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(matches!(registry.phase_of(spec.id), Some(TaskPhase::Error { .. })), "{:?}", registry.phase_of(spec.id));
        // 失败后允许再起一条(重试)。
        registry.start(spec, dir.clone(), options, |_| {}).unwrap();
        for _ in 0..400 {
            if !registry.is_downloading(spec.id) {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
