//! 新手友好供给:组件体检。正式包不下载或执行远程代码。
//!
//! 设计约束:
//! - FFmpeg/FFprobe/whisper-cli 必须来自签名 DMG；缺失时要求重新安装；
//! - Chinese-CLIP 的 Python 运行时尚未形成带哈希的签名组件包，因此不在线安装；
//! - Whisper 模型下载在固定版本与 SHA-256 清单落地前保持关闭。

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use rusqlite::Connection;
use serde::Serialize;

use super::error::{CoreError, Result};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ComponentStatus {
    pub id: String,
    pub title: String,
    pub installed: bool,
    pub detail: String,
    pub installable: bool,
    pub approx_size_mb: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct InstallProgress {
    pub component: String,
    pub phase: String,
    pub downloaded_bytes: u64,
    pub total_hint_mb: u64,
    pub done: bool,
    pub error: Option<String>,
}

pub fn managed_bin_dir() -> Result<PathBuf> {
    let root = crate::app_paths::app_support_root().ok_or_else(|| {
        CoreError::Io(std::io::Error::other(
            "neither TRIPCUT_APP_SUPPORT_DIR nor HOME is set",
        ))
    })?;
    Ok(root.join("bin"))
}

pub fn models_dir() -> Result<PathBuf> {
    let root = crate::app_paths::app_support_root().ok_or_else(|| {
        CoreError::Io(std::io::Error::other(
            "neither TRIPCUT_APP_SUPPORT_DIR nor HOME is set",
        ))
    })?;
    Ok(root.join("models"))
}

pub fn component_statuses(connection: &Connection) -> Result<Vec<ComponentStatus>> {
    let cache_root = super::channel_memory::channel_path_for_project(connection)
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("cache")))
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    let settings = super::settings::status(connection, &cache_root)?;
    let model_tier = super::settings::string_value(
        connection,
        super::settings::WHISPER_MODEL_TIER_KEY,
        "large-v3-turbo",
    )?;
    let model_file = super::settings::model_file_for_tier(&model_tier);
    let model_ok = models_dir()?.join(model_file).is_file();
    let mut list = Vec::new();
    list.push(ComponentStatus {
        id: "ffmpeg".into(),
        title: "FFmpeg(视频解码与转码)".into(),
        installed: settings.ffmpeg.available,
        detail: if settings.ffmpeg.available {
            settings.ffmpeg.resolved_path.clone()
        } else {
            "正式组件缺失；请重新安装完整签名 DMG".into()
        },
        installable: false,
        approx_size_mb: 0,
    });
    list.push(ComponentStatus {
        id: "ffprobe".into(),
        title: "FFprobe(素材信息探测)".into(),
        installed: settings.ffprobe.available,
        detail: if settings.ffprobe.available {
            settings.ffprobe.resolved_path.clone()
        } else {
            "正式组件缺失；请重新安装完整签名 DMG".into()
        },
        installable: false,
        approx_size_mb: 0,
    });
    list.push(ComponentStatus {
        id: "whisper-cli".into(),
        title: "Whisper(对白转写引擎)".into(),
        installed: settings.whisper.binary.available,
        detail: if settings.whisper.binary.available {
            settings.whisper.binary.resolved_path.clone()
        } else {
            "正式组件缺失；请重新安装完整签名 DMG".into()
        },
        installable: false,
        approx_size_mb: 0,
    });
    list.push(ComponentStatus {
        id: "whisper-model".into(),
        title: format!("转写模型({model_tier})"),
        installed: model_ok,
        detail: if model_ok {
            "已就绪".into()
        } else {
            "受验证的模型下载尚未启用；可在设置页指定已校验模型".into()
        },
        installable: false,
        approx_size_mb: 0,
    });
    list.push(ComponentStatus {
        id: "clip-sidecar".into(),
        title: "画面语义搜索(Chinese-CLIP)".into(),
        installed: settings.clip_sidecar.available && settings.clip_sidecar.service_available,
        detail: if settings.clip_sidecar.available && settings.clip_sidecar.service_available {
            settings.clip_sidecar.note.clone()
        } else {
            "正式版禁止在线安装 Python 运行环境；等待签名组件包".into()
        },
        installable: false,
        approx_size_mb: 0,
    });
    Ok(list)
}

/// 商用构建的后端硬门：不得下载或执行远程组件。
pub fn install_component(
    component: &str,
    _model_tier: &str,
    _running: Arc<AtomicBool>,
) -> Result<String> {
    Err(CoreError::Io(std::io::Error::other(format!(
        "正式版禁止在线安装组件 {component}；请重新安装完整签名 DMG"
    ))))
}

/// 供进度轮询:返回 (下载中文件字节数, 是否存在)。
pub fn download_progress(_component: &str, _model_tier: &str) -> Result<u64> {
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_online_component_install_is_refused_before_work_starts() {
        for component in ["ffmpeg", "ffprobe", "whisper-model", "clip-sidecar", "nope"] {
            let error = install_component(component, "small", Arc::new(AtomicBool::new(true)))
                .unwrap_err();
            assert!(error.to_string().contains("禁止在线安装"));
        }
    }

    #[test]
    fn managed_dirs_are_under_app_support() {
        assert!(managed_bin_dir().unwrap().ends_with("TripCutStudio/bin"));
        assert!(models_dir().unwrap().ends_with("TripCutStudio/models"));
    }
}
