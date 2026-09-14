use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use super::error::{CoreError, Result};

pub const THEME_KEY: &str = "appearance.theme";
pub const UI_SCALE_KEY: &str = "appearance.ui_scale";
pub const WORKER_COUNT_KEY: &str = "performance.worker_count";
pub const PROXY_ENABLED_KEY: &str = "performance.proxy_enabled";
pub const MEMORY_PROFILE_KEY: &str = "performance.memory_profile";
pub const FFMPEG_PATH_KEY: &str = "tools.ffmpeg_path";
pub const FFPROBE_PATH_KEY: &str = "tools.ffprobe_path";
pub const WHISPER_PATH_KEY: &str = "tools.whisper_path";
pub const WHISPER_MODEL_TIER_KEY: &str = "tools.whisper_model_tier";
pub const SCENE_THRESHOLD_KEY: &str = "analysis.scene_threshold";
pub const SIMILARITY_THRESHOLD_KEY: &str = "analysis.similarity_threshold";
pub const JITTER_THRESHOLD_KEY: &str = "analysis.jitter_threshold";
pub const BEST_TAKE_TECHNICAL_WEIGHT_KEY: &str = "best_take.weight.technical";
pub const BEST_TAKE_COMPOSITION_WEIGHT_KEY: &str = "best_take.weight.composition";
pub const BEST_TAKE_MOTION_WEIGHT_KEY: &str = "best_take.weight.motion";
pub const BEST_TAKE_HUMAN_WEIGHT_KEY: &str = "best_take.weight.human";
pub const BEST_TAKE_AUDIO_WEIGHT_KEY: &str = "best_take.weight.audio";
pub const BEST_TAKE_NARRATIVE_WEIGHT_KEY: &str = "best_take.weight.narrative";
pub const LLM_ENABLED_KEY: &str = "llm_enabled";
pub const LLM_PROVIDER_KEY: &str = "llm_provider";
pub const LLM_MONTHLY_BUDGET_KEY: &str = "llm_monthly_budget";
pub const MINIMAX_ENABLED_KEY: &str = "minimax_enabled";
pub const MINIMAX_MODEL_KEY: &str = "minimax_model";
pub const MINIMAX_RESOLUTION_KEY: &str = "minimax_resolution";
pub const MINIMAX_MONTHLY_BUDGET_KEY: &str = "minimax_monthly_budget_usd";
/// R10 U-22:首启引导「已跳过 / 已完成」。真值 = 不再弹「FIRST RUN」全屏引导;
/// 弹不弹只看这一位,不再靠「工具链是否齐」推断(切换新旧界面、恢复页之后都不重放)。
pub const FIRST_RUN_DONE_KEY: &str = "onboarding.first_run_done";
/// R11 首启引导卡「看过了」+ R12 流水线四步的「首次进入提示已看过」(`pipeline.hint_seen.n`)。
/// 前端只写 "true" / "false";没写过 = false。R11 那把键此前没进白名单,`set_setting` 一直被
/// 静默拒绝(前端 `.catch(() => undefined)`),引导卡每次启动都会再出现 —— 这里一并补上。
pub const ONBOARDING_FLAG_KEYS: &[&str] = &[
    "onboarding.steps_seen",
    "pipeline.hint_seen.1",
    "pipeline.hint_seen.2",
    "pipeline.hint_seen.3",
    "pipeline.hint_seen.4",
];
/// R13 §3(车道 B):功能气泡「看过了」键的前缀;完整键形如 `guide.nav.viewed`。
pub const GUIDE_VIEWED_PREFIX: &str = "guide.";
const GUIDE_VIEWED_SUFFIX: &str = ".viewed";

/// `guide.<id>.viewed` → `Some(id)`;id 非空且只含 `[a-z0-9_-]`,否则 `None`。
pub fn guide_viewed_id(key: &str) -> Option<&str> {
    let id = key.strip_prefix(GUIDE_VIEWED_PREFIX)?.strip_suffix(GUIDE_VIEWED_SUFFIX)?;
    let well_formed = !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-');
    well_formed.then_some(id)
}

/// R11 车道 B:时刻分五项权重(JSON 对象,键白名单见 `core::moments::WEIGHT_KEYS`)。
/// 缺省值在 `core::moments::MomentWeights::default` 里,新手不用调。
pub const MOMENT_WEIGHTS_KEY: &str = "moments.weights";
/// R13 §1 键位预设:`jianying`(默认)| `premiere` | `fcp` | `custom`。
pub const KEYMAP_PRESET_KEY: &str = "keymap.preset";
/// R13 §1 自定义键位(JSON `{base, overrides}`,前端解析、这里只限长度)。
pub const KEYMAP_CUSTOM_KEY: &str = "keymap.custom";

const WINDOW_WIDTH_KEY: &str = "window.width";
const WINDOW_HEIGHT_KEY: &str = "window.height";
const WINDOW_X_KEY: &str = "window.x";
const WINDOW_Y_KEY: &str = "window.y";

pub const DEFAULT_WORKER_COUNT: usize = 4;
/// 单一来源在 `analysis::SCENE_THRESHOLD`(R14 随 10 fps 采样从 0.35 改为 0.25)。
pub const DEFAULT_SCENE_THRESHOLD: f64 = super::analysis::SCENE_THRESHOLD;
/// v4 及更早的库里种下的旧默认值;它从未在界面上暴露过,所以读到这个值就当"没改过"。
pub const LEGACY_SCENE_THRESHOLD: f64 = 0.35;
pub const DEFAULT_SIMILARITY_THRESHOLD: f64 = 0.25;
/// 抖动分现为"运动轨迹高频能量占比"（见 `core::motion::high_freq_energy_ratio`），
/// 范围 [0,1]，与旧的绝对帧间差分 RMS 不是同一量纲。2026-09-02 用真实素材重新标定：
/// 航拍稳定素材 0.0–0.03，静止 loop 样本 0.0，真实手持街拍基线 0.09–0.45，
/// 任意素材叠加随机高频裁切抖动后 0.39–0.74。稳定簇（≤0.03）与"明显抖"簇
/// （街拍重手抖/合成抖动，≥0.22）之间有清晰间隔，取 0.15 作为默认阈值，
/// 落在间隔中段偏稳定一侧，让温和手持（如迪拜街拍基线 0.09–0.11）仍判为不抖，
/// 更明显的手持/合成抖动判为抖。详见 `core::motion` 顶部注释与测试。
pub const DEFAULT_JITTER_THRESHOLD: f64 = 0.15;
pub const DEFAULT_BEST_TAKE_TECHNICAL_WEIGHT: f64 = 0.28;
pub const DEFAULT_BEST_TAKE_COMPOSITION_WEIGHT: f64 = 0.18;
pub const DEFAULT_BEST_TAKE_MOTION_WEIGHT: f64 = 0.20;
pub const DEFAULT_BEST_TAKE_HUMAN_WEIGHT: f64 = 0.14;
pub const DEFAULT_BEST_TAKE_AUDIO_WEIGHT: f64 = 0.12;
pub const DEFAULT_BEST_TAKE_NARRATIVE_WEIGHT: f64 = 0.08;
pub const DEFAULT_LLM_MONTHLY_BUDGET: u32 = 200;
pub const DEFAULT_MINIMAX_MODEL: &str = "MiniMax-H3-Max";
pub const DEFAULT_MINIMAX_RESOLUTION: &str = "768P";
pub const DEFAULT_MINIMAX_MONTHLY_BUDGET: f64 = 10.0;
/// 规格 §3：`minimax_monthly_budget_usd` 的硬上限，超出的写入被夹到此值（而不是
/// 像 `LLM_MONTHLY_BUDGET_KEY` 那样直接拒绝）——云端生成按次计费，误配的大额预算
/// 应该被削平,不应该整条设置写入失败。
pub const MINIMAX_MONTHLY_BUDGET_MAX: f64 = 500.0;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ToolStatus {
    pub configured_path: String,
    pub resolved_path: String,
    pub available: bool,
    pub version: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WhisperStatus {
    pub binary: ToolStatus,
    pub model_tier: String,
    pub model_path: String,
    pub model_available: bool,
    pub models_directory: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ClipSidecarStatus {
    pub venv_path: String,
    pub service_path: String,
    pub setup_script: String,
    pub available: bool,
    pub service_available: bool,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CacheStats {
    pub database_bytes: u64,
    pub disk_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SettingsStatus {
    pub ffmpeg: ToolStatus,
    pub ffprobe: ToolStatus,
    pub whisper: WhisperStatus,
    pub clip_sidecar: ClipSidecarStatus,
    pub cache: CacheStats,
    /// R10 U-22:首启引导已跳过/完成。FirstRunGuide 只看这一位决定弹不弹。
    pub first_run_done: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CacheRebuildResult {
    pub removed_database_rows: usize,
    pub reset_jobs: usize,
    pub removed_disk_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowState {
    pub width: f64,
    pub height: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
}

fn defaults() -> BTreeMap<String, String> {
    BTreeMap::from([
        (THEME_KEY.to_owned(), "system".to_owned()),
        (UI_SCALE_KEY.to_owned(), "1.0".to_owned()),
        (WORKER_COUNT_KEY.to_owned(), DEFAULT_WORKER_COUNT.to_string()),
        (PROXY_ENABLED_KEY.to_owned(), "true".to_owned()),
        (MEMORY_PROFILE_KEY.to_owned(), "auto".to_owned()),
        (FIRST_RUN_DONE_KEY.to_owned(), "false".to_owned()),
        (FFMPEG_PATH_KEY.to_owned(), String::new()),
        (FFPROBE_PATH_KEY.to_owned(), String::new()),
        (WHISPER_PATH_KEY.to_owned(), String::new()),
        (WHISPER_MODEL_TIER_KEY.to_owned(), "large-v3-turbo".to_owned()),
        (
            SCENE_THRESHOLD_KEY.to_owned(),
            DEFAULT_SCENE_THRESHOLD.to_string(),
        ),
        (
            SIMILARITY_THRESHOLD_KEY.to_owned(),
            DEFAULT_SIMILARITY_THRESHOLD.to_string(),
        ),
        (
            JITTER_THRESHOLD_KEY.to_owned(),
            DEFAULT_JITTER_THRESHOLD.to_string(),
        ),
        (
            BEST_TAKE_TECHNICAL_WEIGHT_KEY.to_owned(),
            DEFAULT_BEST_TAKE_TECHNICAL_WEIGHT.to_string(),
        ),
        (
            BEST_TAKE_COMPOSITION_WEIGHT_KEY.to_owned(),
            DEFAULT_BEST_TAKE_COMPOSITION_WEIGHT.to_string(),
        ),
        (
            BEST_TAKE_MOTION_WEIGHT_KEY.to_owned(),
            DEFAULT_BEST_TAKE_MOTION_WEIGHT.to_string(),
        ),
        (
            BEST_TAKE_HUMAN_WEIGHT_KEY.to_owned(),
            DEFAULT_BEST_TAKE_HUMAN_WEIGHT.to_string(),
        ),
        (
            BEST_TAKE_AUDIO_WEIGHT_KEY.to_owned(),
            DEFAULT_BEST_TAKE_AUDIO_WEIGHT.to_string(),
        ),
        (
            BEST_TAKE_NARRATIVE_WEIGHT_KEY.to_owned(),
            DEFAULT_BEST_TAKE_NARRATIVE_WEIGHT.to_string(),
        ),
        (LLM_ENABLED_KEY.to_owned(), "false".to_owned()),
        (LLM_PROVIDER_KEY.to_owned(), "none".to_owned()),
        (
            LLM_MONTHLY_BUDGET_KEY.to_owned(),
            DEFAULT_LLM_MONTHLY_BUDGET.to_string(),
        ),
        (MINIMAX_ENABLED_KEY.to_owned(), "false".to_owned()),
        (MINIMAX_MODEL_KEY.to_owned(), DEFAULT_MINIMAX_MODEL.to_owned()),
        (
            MINIMAX_RESOLUTION_KEY.to_owned(),
            DEFAULT_MINIMAX_RESOLUTION.to_owned(),
        ),
        (
            MINIMAX_MONTHLY_BUDGET_KEY.to_owned(),
            DEFAULT_MINIMAX_MONTHLY_BUDGET.to_string(),
        ),
    ])
}

/// 把预算值夹到 [0, `MINIMAX_MONTHLY_BUDGET_MAX`]。非法（非有限数）值一律当作
/// 上限处理——宁可保守地限流,也不让无效输入绕过预算闸。
pub fn clamp_minimax_monthly_budget(value: f64) -> f64 {
    if !value.is_finite() {
        return MINIMAX_MONTHLY_BUDGET_MAX;
    }
    value.clamp(0.0, MINIMAX_MONTHLY_BUDGET_MAX)
}

fn settings_table_exists(connection: &Connection) -> Result<bool> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
            [],
            |_| Ok(true),
        )
        .optional()
        .map(|value| value.unwrap_or(false))
        .map_err(CoreError::from)
}

pub fn get_settings(connection: &Connection) -> Result<BTreeMap<String, String>> {
    let mut values = defaults();
    if !settings_table_exists(connection)? {
        return Ok(values);
    }
    let mut statement = connection.prepare("SELECT key, value FROM settings ORDER BY key")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (key, value) = row?;
        values.insert(key, value);
    }
    Ok(values)
}

pub fn set_setting(connection: &Connection, key: &str, value: &str) -> Result<()> {
    let stored_value = if key == MINIMAX_MONTHLY_BUDGET_KEY {
        let raw: f64 = value
            .parse()
            .map_err(|_| CoreError::InvalidSchema(format!("设置项 {key} 的值无效")))?;
        clamp_minimax_monthly_budget(raw).to_string()
    } else {
        value.to_owned()
    };
    validate_setting(key, &stored_value)?;
    if !settings_table_exists(connection)? {
        return Err(CoreError::InvalidSchema(
            "settings 表尚未接线；合并 0006/0007 后再启用 0008".to_owned(),
        ));
    }
    connection.execute(
        "INSERT INTO settings(key, value, updated_at)
         VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at",
        params![key, stored_value],
    )?;
    Ok(())
}

fn validate_setting(key: &str, value: &str) -> Result<()> {
    let valid = match key {
        // R13 §5:第四档「剪映风格深色」(前端 html[data-theme="jianying-dark"])。
        THEME_KEY => matches!(value, "system" | "light" | "dark" | "jianying-dark"),
        UI_SCALE_KEY => matches!(value, "0.9" | "1.0" | "1.15" | "1.3"),
        WORKER_COUNT_KEY => value.parse::<usize>().is_ok_and(|count| (1..=8).contains(&count)),
        PROXY_ENABLED_KEY => matches!(value, "true" | "false"),
        MEMORY_PROFILE_KEY => matches!(value, "auto" | "standard" | "low"),
        FIRST_RUN_DONE_KEY => matches!(value, "true" | "false"),
        key if ONBOARDING_FLAG_KEYS.contains(&key) => matches!(value, "true" | "false"),
        // R13 §3(车道 B):剪映式功能气泡「看过了」—— `guide.<id>.viewed` = "true" | "false"。
        // 按前缀放行而不是精确表:首批七个之后每加一个 guide 不必再改 Rust;id 只许 [a-z0-9_-]。
        key if key.starts_with(GUIDE_VIEWED_PREFIX) => {
            guide_viewed_id(key).is_some() && matches!(value, "true" | "false")
        }
        FFMPEG_PATH_KEY | FFPROBE_PATH_KEY | WHISPER_PATH_KEY => value.len() <= 4_096,
        WHISPER_MODEL_TIER_KEY => matches!(value, "large-v3-turbo" | "small"),
        SCENE_THRESHOLD_KEY | SIMILARITY_THRESHOLD_KEY => value
            .parse::<f64>()
            .is_ok_and(|number| number.is_finite() && (0.0..=1.0).contains(&number)),
        JITTER_THRESHOLD_KEY => value
            .parse::<f64>()
            .is_ok_and(|number| number.is_finite() && (0.0..=2.0).contains(&number)),
        BEST_TAKE_TECHNICAL_WEIGHT_KEY
        | BEST_TAKE_COMPOSITION_WEIGHT_KEY
        | BEST_TAKE_MOTION_WEIGHT_KEY
        | BEST_TAKE_HUMAN_WEIGHT_KEY
        | BEST_TAKE_AUDIO_WEIGHT_KEY
        | BEST_TAKE_NARRATIVE_WEIGHT_KEY => value
            .parse::<f64>()
            .is_ok_and(|number| number.is_finite() && (0.0..=1.0).contains(&number)),
        MOMENT_WEIGHTS_KEY => super::moments::MomentWeights::parse(value).is_ok(),
        KEYMAP_PRESET_KEY => matches!(value, "jianying" | "premiere" | "fcp" | "custom"),
        KEYMAP_CUSTOM_KEY => value.len() <= 4_096,
        LLM_ENABLED_KEY => matches!(value, "true" | "false"),
        LLM_PROVIDER_KEY => matches!(value, "none" | "auto" | "claude" | "codex" | "kimi"),
        LLM_MONTHLY_BUDGET_KEY => value
            .parse::<u32>()
            .is_ok_and(|budget| budget <= 10_000),
        MINIMAX_ENABLED_KEY => matches!(value, "true" | "false"),
        MINIMAX_MODEL_KEY => !value.is_empty() && value.len() <= 128,
        MINIMAX_RESOLUTION_KEY => matches!(value, "480P" | "768P" | "2K"),
        MINIMAX_MONTHLY_BUDGET_KEY => value
            .parse::<f64>()
            .is_ok_and(|budget| budget.is_finite() && (0.0..=MINIMAX_MONTHLY_BUDGET_MAX).contains(&budget)),
        _ if matches!(key, WINDOW_WIDTH_KEY | WINDOW_HEIGHT_KEY | WINDOW_X_KEY | WINDOW_Y_KEY) => {
            value.parse::<f64>().is_ok_and(f64::is_finite)
        }
        // R8:工作区的 UI 偏好(栏宽、折叠态、附属带模式、检查器折叠段等)走 settings 表
        // 存,好让偏好跟着素材库走而不是跟着这台机器走。键名一律 `ui.` 前缀,值当作
        // 不透明字符串(有的是 JSON 数组),只限长度,不限内容——限内容就等于把前端的
        // UI 结构复制一份进 Rust,那是 R8 明确不做的事(规格 §0「不重写 Rust 核心」)。
        key if key.starts_with("ui.") => value.len() <= 4_096,
        // R14 §9 A:剪映试验草稿的人眼裁定 `jianying.human_check.<version>` = "ok" | "fail"。
        // 版本号只许 [0-9.];是否在待验证名单由 `jianying::set_human_check` 把关。
        key if key.starts_with(super::jianying::HUMAN_CHECK_PREFIX) => {
            let version = &key[super::jianying::HUMAN_CHECK_PREFIX.len()..];
            !version.is_empty()
                && version.len() <= 32
                && version.bytes().all(|byte| byte.is_ascii_digit() || byte == b'.')
                && matches!(value, "ok" | "fail")
        }
        // R12 车道 B:「这章够了」—— `story.chapter_skipped.<章 id>` = "true" | "false"(不加迁移)。
        key if key.starts_with(super::arrange::CHAPTER_SKIPPED_PREFIX) => {
            key[super::arrange::CHAPTER_SKIPPED_PREFIX.len()..].parse::<i64>().is_ok() && matches!(value, "true" | "false")
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(CoreError::InvalidSchema(format!("设置项 {key} 的值无效")))
    }
}

/// R10 U-22:首启引导是否已跳过/完成。没写过 = false(真正的首次启动)。
pub fn first_run_done(connection: &Connection) -> Result<bool> {
    Ok(setting_value(connection, FIRST_RUN_DONE_KEY)?.as_deref() == Some("true"))
}

pub fn set_first_run_done(connection: &Connection, done: bool) -> Result<()> {
    set_setting(connection, FIRST_RUN_DONE_KEY, if done { "true" } else { "false" })
}

pub fn setting_value(connection: &Connection, key: &str) -> Result<Option<String>> {
    if !settings_table_exists(connection)? {
        return Ok(None);
    }
    connection
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(CoreError::from)
}

pub fn string_value(connection: &Connection, key: &str, default: &str) -> Result<String> {
    Ok(setting_value(connection, key)?.unwrap_or_else(|| default.to_owned()))
}

pub fn number_value(connection: &Connection, key: &str, default: f64) -> Result<f64> {
    let Some(stored) = setting_value(connection, key)? else {
        return Ok(default);
    };
    stored
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
        .ok_or_else(|| CoreError::InvalidSchema(format!("设置项 {key} 的数值已损坏")))
}

pub fn worker_count(connection: &Connection) -> Result<usize> {
    string_value(connection, WORKER_COUNT_KEY, &DEFAULT_WORKER_COUNT.to_string())?
        .parse::<usize>()
        .ok()
        .filter(|count| (1..=8).contains(count))
        .ok_or_else(|| CoreError::InvalidSchema("工作线程数设置已损坏".to_owned()))
}

pub fn proxy_enabled(connection: &Connection) -> Result<bool> {
    match string_value(connection, PROXY_ENABLED_KEY, "true")?.as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(CoreError::InvalidSchema("代理开关设置已损坏".to_owned())),
    }
}

pub fn configured_executable(
    connection: &Connection,
    setting_key: &str,
    environment_key: &str,
    fallback: &str,
) -> Result<OsString> {
    let configured = string_value(connection, setting_key, "")?;
    if !configured.trim().is_empty() {
        return Ok(OsString::from(configured));
    }
    Ok(std::env::var_os(environment_key)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| OsString::from(fallback)))
}

pub fn configured_ffprobe(connection: &Connection, ffmpeg: &OsStr) -> Result<OsString> {
    let sibling = sibling_ffprobe(&ffmpeg.to_string_lossy());
    configured_executable(
        connection,
        FFPROBE_PATH_KEY,
        "FFPROBE_PATH",
        &sibling,
    )
}

pub fn window_state(connection: &Connection) -> Result<WindowState> {
    let width = stored_number(connection, WINDOW_WIDTH_KEY)?
        .filter(|value| (1_200.0..=10_000.0).contains(value))
        .unwrap_or(1_512.0);
    let height = stored_number(connection, WINDOW_HEIGHT_KEY)?
        .filter(|value| (760.0..=10_000.0).contains(value))
        .unwrap_or(945.0);
    Ok(WindowState {
        width,
        height,
        x: stored_number(connection, WINDOW_X_KEY)?,
        y: stored_number(connection, WINDOW_Y_KEY)?,
    })
}

fn stored_number(connection: &Connection, key: &str) -> Result<Option<f64>> {
    let Some(stored) = setting_value(connection, key)? else {
        return Ok(None);
    };
    let value = stored
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
        .ok_or_else(|| CoreError::InvalidSchema(format!("窗口设置项 {key} 已损坏")))?;
    Ok(Some(value))
}

pub fn save_window_state(connection: &mut Connection, state: WindowState) -> Result<()> {
    if !settings_table_exists(connection)? {
        return Ok(());
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for (key, value) in [
        (WINDOW_WIDTH_KEY, state.width),
        (WINDOW_HEIGHT_KEY, state.height),
        (WINDOW_X_KEY, state.x.unwrap_or_default()),
        (WINDOW_Y_KEY, state.y.unwrap_or_default()),
    ] {
        transaction.execute(
            "INSERT INTO settings(key, value, updated_at)
             VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(key) DO UPDATE SET
                 value = excluded.value,
                 updated_at = excluded.updated_at",
            params![key, value.to_string()],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

pub fn status(connection: &Connection, cache_root: &Path) -> Result<SettingsStatus> {
    let configured_ffmpeg = string_value(connection, FFMPEG_PATH_KEY, "")?;
    let ffmpeg = executable_status(
        &configured_ffmpeg,
        std::env::var_os("FFMPEG_PATH").as_deref(),
        "ffmpeg",
    );
    let configured_ffprobe = string_value(connection, FFPROBE_PATH_KEY, "")?;
    let ffprobe_fallback = sibling_ffprobe(&ffmpeg.resolved_path);
    let ffprobe = executable_status(
        &configured_ffprobe,
        std::env::var_os("FFPROBE_PATH").as_deref(),
        &ffprobe_fallback,
    );
    let configured_whisper = string_value(connection, WHISPER_PATH_KEY, "")?;
    let whisper_binary = executable_status(
        &configured_whisper,
        std::env::var_os("WHISPER_BIN").as_deref(),
        "whisper-cli",
    );
    let model_tier = string_value(connection, WHISPER_MODEL_TIER_KEY, "large-v3-turbo")?;
    let models_directory = models_directory();
    let model_path = std::env::var_os("WHISPER_MODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|| models_directory.join(model_file_for_tier(&model_tier)));
    let sidecar = crate::packaging::sidecar_paths();
    let sidecar_python_available = sidecar.python.is_file();
    let sidecar_service_available = sidecar.service.is_file();

    Ok(SettingsStatus {
        ffmpeg,
        ffprobe,
        whisper: WhisperStatus {
            binary: whisper_binary,
            model_tier,
            model_available: model_path.is_file(),
            model_path: model_path.to_string_lossy().into_owned(),
            models_directory: models_directory.to_string_lossy().into_owned(),
        },
        clip_sidecar: ClipSidecarStatus {
            available: sidecar_python_available && sidecar_service_available,
            service_available: sidecar_service_available,
            venv_path: sidecar.python.to_string_lossy().into_owned(),
            service_path: sidecar.service.to_string_lossy().into_owned(),
            setup_script: sidecar.setup_script.to_string_lossy().into_owned(),
            note: if !sidecar_service_available {
                "应用资源缺少画面识别组件；请重新安装完整应用。".to_owned()
            } else if !sidecar_python_available {
                "画面识别组件已就位；正式版不在线安装，等待带签名的本地组件包。".to_owned()
            } else {
                "自检会在本机启动画面识别组件试跑一次，不会上传素材。".to_owned()
            },
        },
        cache: cache_stats(connection, cache_root)?,
        first_run_done: first_run_done(connection)?,
    })
}

pub fn model_file_for_tier(tier: &str) -> &'static str {
    if tier == super::transcribe::LOW_POWER_MODEL_TIER {
        super::transcribe::LOW_POWER_MODEL_FILE
    } else {
        super::transcribe::DEFAULT_MODEL_FILE
    }
}

pub fn models_directory() -> PathBuf {
    crate::app_paths::app_support_root()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("models")
}

fn executable_status(configured: &str, environment: Option<&OsStr>, fallback: &str) -> ToolStatus {
    let candidate = if !configured.trim().is_empty() {
        OsString::from(configured)
    } else if let Some(environment) = environment.filter(|value| !value.is_empty()) {
        environment.to_owned()
    } else {
        OsString::from(fallback)
    };
    let resolved = resolve_executable(&candidate);
    let version = resolved.as_deref().and_then(version_line);
    ToolStatus {
        configured_path: configured.to_owned(),
        resolved_path: resolved
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| candidate.to_string_lossy().into_owned()),
        available: resolved.is_some(),
        note: if resolved.is_some() && version.is_none() {
            Some("文件存在，但版本探测未返回首行。".to_owned())
        } else if resolved.is_none() {
            Some("未找到可执行文件；可填写绝对路径。".to_owned())
        } else {
            None
        },
        version,
    }
}

pub(crate) fn resolve_executable(candidate: &OsStr) -> Option<PathBuf> {
    let path = Path::new(candidate);
    if path.components().count() > 1 {
        return path.is_file().then(|| path.to_path_buf());
    }
    let name = path.to_str()?;
    let mut preferred_dirs = Vec::new();
    // 随包捆绑的工具在应用自身 MacOS 目录。默认解析必须优先使用经过发行审计的版本，
    // 不能被构建机或用户 shell 的 Homebrew PATH 静默替换。
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            preferred_dirs.push(dir.to_path_buf());
        }
    }
    if let Some(app_support_root) = crate::app_paths::app_support_root() {
        // 应用托管工具目录(设置向导一键下载的 ffmpeg/ffprobe 落这里)。
        preferred_dirs.push(app_support_root.join("bin"));
    }
    // Finder 启动的 .app 可能没有 Homebrew PATH；这些目录只作为包内/托管工具之后的兼容回退。
    preferred_dirs.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/local/bin"),
    ]);
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        // 订阅 CLI 常见的用户级安装位置(claude 官方装 ~/.local/bin,kimi 装 ~/.kimi-code/bin)。
        preferred_dirs.push(home.join(".local/bin"));
        preferred_dirs.push(home.join(".kimi-code/bin"));
        preferred_dirs.push(home.join("bin"));
    }
    let environment_path = std::env::var_os("PATH");
    resolve_executable_in(name, preferred_dirs, environment_path.as_deref())
}

fn resolve_executable_in(
    name: &str,
    preferred_dirs: Vec<PathBuf>,
    environment_path: Option<&OsStr>,
) -> Option<PathBuf> {
    preferred_dirs
        .into_iter()
        .chain(
            environment_path
        .into_iter()
                .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>()),
        )
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

fn version_line(executable: &Path) -> Option<String> {
    let is_whisper = executable
        .file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name.starts_with("whisper"));
    let output = Command::new(executable)
        .arg(if is_whisper { "--version" } else { "-version" })
        .output()
        .ok()?;
    let text = if output.stdout.is_empty() {
        &output.stderr
    } else {
        &output.stdout
    };
    String::from_utf8_lossy(text)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

fn sibling_ffprobe(ffmpeg: &str) -> String {
    let path = Path::new(ffmpeg);
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.join("ffprobe").to_string_lossy().into_owned())
        .unwrap_or_else(|| "ffprobe".to_owned())
}

pub fn cache_stats(connection: &Connection, cache_root: &Path) -> Result<CacheStats> {
    let database_bytes = connection
        .query_row(
            "SELECT COALESCE(SUM(bytes), 0) FROM cache_artifacts",
            [],
            |row| row.get::<_, i64>(0),
        )?
        .max(0) as u64;
    Ok(CacheStats {
        database_bytes,
        disk_bytes: directory_bytes(cache_root)?,
    })
}

fn directory_bytes(root: &Path) -> Result<u64> {
    if !root.exists() {
        return Ok(0);
    }
    let mut total = 0_u64;
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|error| {
            CoreError::Io(std::io::Error::other(format!("读取缓存目录失败：{error}")))
        })?;
        if entry.file_type().is_file() {
            let metadata = entry.metadata().map_err(|error| {
                CoreError::Io(std::io::Error::other(format!(
                    "读取缓存文件信息失败：{error}"
                )))
            })?;
            total = total.saturating_add(metadata.len());
        }
    }
    Ok(total)
}

pub fn clear_cache_and_rebuild(
    connection: &mut Connection,
    cache_root: &Path,
) -> Result<CacheRebuildResult> {
    let removed_disk_bytes = directory_bytes(cache_root)?;
    let parent = cache_root.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let cache_name = cache_root
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or("cache");
    let retired = parent.join(format!(
        ".{cache_name}.retired-{}",
        uuid::Uuid::new_v4()
    ));
    if cache_root.exists() {
        std::fs::rename(cache_root, &retired)?;
    }
    if let Err(error) = std::fs::create_dir(cache_root) {
        if retired.exists() {
            let _ = std::fs::rename(&retired, cache_root);
        }
        return Err(error.into());
    }
    struct CacheSwap<'a> {
        current: &'a Path,
        retired: &'a Path,
        committed: bool,
    }
    impl Drop for CacheSwap<'_> {
        fn drop(&mut self) {
            if self.committed {
                return;
            }
            let _ = std::fs::remove_dir_all(self.current);
            if self.retired.exists() {
                let _ = std::fs::rename(self.retired, self.current);
            }
        }
    }
    let mut swap = CacheSwap {
        current: cache_root,
        retired: &retired,
        committed: false,
    };
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let removed_database_rows = transaction.execute("DELETE FROM cache_artifacts", [])?;
    transaction.execute("DELETE FROM proxy_time_map", [])?;
    transaction.execute("DELETE FROM clip_embeddings", [])?;
    transaction.execute("DELETE FROM clip_dimensions", [])?;
    // R6 Task 7d 修复 Medium:`strip`(胶片条)此前不在这份名单里——它的
    // `cache_artifacts` 行和磁盘文件跟 `thumbnail`/`waveform`/`proxy` 一样被
    // 上面的 `DELETE FROM cache_artifacts` 清空,job 却仍是 'done',于是重建
    // 后只能等下次真正被读取时才「惰性」发现产物不在了(如果有这样的路径的
    // 话)——不像其余几种那样立刻重新入队。
    //
    // `ocr_scan` 决定不加进来:OCR 的结果是识别出的文字,落在独立的表里,
    // 不受这次重建的任一条 DELETE 影响(不像 `clip_embed` 的向量存在
    // `clip_embeddings`——那张表被上面显式清空了,所以 `clip_embed` 必须重
    // 置)。`ocr_scan` 扫描时读的胶片条文件只是一次性输入,扫完文字就已经落
    // 库,文件后续被清掉不影响已经产出的结果,不必重跑。
    let reset_jobs = transaction.execute(
        "UPDATE jobs
         SET status = 'pending', attempt = 0, blocked_summary = NULL,
             result_path = NULL, finished_at = NULL,
             owner_id = NULL, lease_expires_at = NULL, cancel_requested = 0,
             next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE kind IN ('thumbnail', 'strip', 'waveform', 'proxy', 'clip_embed')
           AND status != 'running'",
        [],
    )?;
    transaction.commit()?;
    swap.committed = true;
    if retired.exists() {
        std::fs::remove_dir_all(&retired)?;
    }
    Ok(CacheRebuildResult {
        removed_database_rows,
        reset_jobs,
        removed_disk_bytes,
    })
}

#[cfg(test)]
fn retired_cache_directories(parent: &Path) -> Result<Vec<std::path::PathBuf>> {
    if !parent.exists() {
        return Ok(Vec::new());
    }
    let mut paths = std::fs::read_dir(parent)?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(std::ffi::OsStr::to_str)
                .is_some_and(|name| name.starts_with(".cache.retired-"))
        })
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};
    use rusqlite::params;

    fn connection_with_settings() -> (TestDirectory, Connection) {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        (directory, connection)
    }

    #[test]
    fn defaults_are_available_before_0008_is_wired() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();

        let values = get_settings(&connection).unwrap();

        assert_eq!(values[THEME_KEY], "system");
        assert_eq!(values[UI_SCALE_KEY], "1.0");
        assert_eq!(values[LLM_ENABLED_KEY], "false");
        assert_eq!(
            values[BEST_TAKE_TECHNICAL_WEIGHT_KEY],
            DEFAULT_BEST_TAKE_TECHNICAL_WEIGHT.to_string()
        );
        assert_eq!(values[LLM_PROVIDER_KEY], "none");
        assert_eq!(
            values[LLM_MONTHLY_BUDGET_KEY],
            DEFAULT_LLM_MONTHLY_BUDGET.to_string()
        );
        assert_eq!(worker_count(&connection).unwrap(), DEFAULT_WORKER_COUNT);
        assert!(proxy_enabled(&connection).unwrap());
    }

    #[test]
    fn minimax_defaults() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();

        let values = get_settings(&connection).unwrap();
        assert_eq!(values[MINIMAX_ENABLED_KEY], "false");
        assert_eq!(values[MINIMAX_MODEL_KEY], "MiniMax-H3-Max");
        assert_eq!(values[MINIMAX_RESOLUTION_KEY], "768P");
        assert_eq!(values[MINIMAX_MONTHLY_BUDGET_KEY], "10");

        // 上限 500 被夹住：写入超限值不报错,而是落成夹住后的上限。
        set_setting(&connection, MINIMAX_MONTHLY_BUDGET_KEY, "999").unwrap();
        let clamped = get_settings(&connection).unwrap();
        assert_eq!(clamped[MINIMAX_MONTHLY_BUDGET_KEY], "500");
        assert_eq!(clamp_minimax_monthly_budget(999.0), 500.0);
        assert_eq!(clamp_minimax_monthly_budget(-5.0), 0.0);

        assert!(set_setting(&connection, MINIMAX_RESOLUTION_KEY, "4K").is_err());
        set_setting(&connection, MINIMAX_RESOLUTION_KEY, "2K").unwrap();
        assert_eq!(get_settings(&connection).unwrap()[MINIMAX_RESOLUTION_KEY], "2K");
    }

    #[test]
    fn migration_0008_creates_the_expected_settings_contract() {
        let (_directory, connection) = connection_with_settings();
        let columns: String = connection
            .query_row(
                "SELECT group_concat(name, ',') FROM pragma_table_info('settings')",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(columns, "key,value,updated_at");
    }

    #[test]
    fn settings_round_trip_and_invalid_values_do_not_write() {
        let (_directory, connection) = connection_with_settings();

        set_setting(&connection, THEME_KEY, "dark").unwrap();
        set_setting(&connection, WORKER_COUNT_KEY, "8").unwrap();

        let values = get_settings(&connection).unwrap();
        assert_eq!(values[THEME_KEY], "dark");
        // R13 §5:第四档主题进白名单;别的字符串仍拒绝。
        set_setting(&connection, THEME_KEY, "jianying-dark").unwrap();
        assert_eq!(get_settings(&connection).unwrap()[THEME_KEY], "jianying-dark");
        assert!(set_setting(&connection, THEME_KEY, "neon").is_err());
        set_setting(&connection, THEME_KEY, "dark").unwrap();
        assert_eq!(worker_count(&connection).unwrap(), 8);
        assert!(set_setting(&connection, WORKER_COUNT_KEY, "9").is_err());
        assert!(set_setting(&connection, BEST_TAKE_MOTION_WEIGHT_KEY, "0.35").is_ok());
        assert!(set_setting(&connection, BEST_TAKE_MOTION_WEIGHT_KEY, "1.1").is_err());
        assert!(set_setting(&connection, "unknown.setting", "value").is_err());
        assert_eq!(worker_count(&connection).unwrap(), 8);
    }

    #[test]
    fn window_state_defaults_then_restores_saved_logical_bounds() {
        let (_directory, mut connection) = connection_with_settings();
        assert_eq!(
            window_state(&connection).unwrap(),
            WindowState {
                width: 1_512.0,
                height: 945.0,
                x: None,
                y: None,
            }
        );

        save_window_state(
            &mut connection,
            WindowState {
                width: 1_800.0,
                height: 1_000.0,
                x: Some(120.0),
                y: Some(80.0),
            },
        )
        .unwrap();

        assert_eq!(
            window_state(&connection).unwrap(),
            WindowState {
                width: 1_800.0,
                height: 1_000.0,
                x: Some(120.0),
                y: Some(80.0),
            }
        );
    }

    #[test]
    fn cache_stats_compare_database_sum_with_directory_measurement() {
        let (directory, connection) = connection_with_settings();
        connection
            .execute("INSERT INTO volumes(uuid) VALUES ('volume-a')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, quick_hash)
                 VALUES (1, 'volume-a', 'clip.mov', 'source-a')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO cache_artifacts(
                    clip_id, kind, rel_path, source_hash, bytes, created_at
                 ) VALUES (1, 'cover', '1/cover.jpg', 'source-a', 12, 'now')",
                [],
            )
            .unwrap();
        let cache_root = directory.path().join("cache");
        std::fs::create_dir_all(cache_root.join("1")).unwrap();
        std::fs::write(cache_root.join("1/cover.jpg"), [1_u8, 2, 3, 4]).unwrap();

        assert_eq!(
            cache_stats(&connection, &cache_root).unwrap(),
            CacheStats {
                database_bytes: 12,
                disk_bytes: 4,
            }
        );
    }

    #[test]
    fn cache_rebuild_resets_only_rebuildable_jobs_and_preserves_decisions() {
        let (directory, mut connection) = connection_with_settings();
        connection
            .execute("INSERT INTO volumes(uuid) VALUES ('volume-a')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, quick_hash)
                 VALUES (1, 'volume-a', 'clip.mov', 'source-a')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO segments(id, clip_id, in_ticks, out_ticks)
                 VALUES (1, 1, 0, 100)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO ratings(segment_id, rating_type, value, rated_at)
                 VALUES (1, 'stars', 5, 'now')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO cache_artifacts(
                    clip_id, kind, rel_path, source_hash, bytes, created_at
                 ) VALUES (1, 'cover', '1/cover.jpg', 'source-a', 4, 'now')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clip_embeddings(
                    clip_id, embedding, dimensions, source_hash, model, embedded_at
                 ) VALUES (1, ?1, 512, 'source-a', 'test-model', 'now')",
                [vec![0_u8; 2_048]],
            )
            .unwrap();
        for kind in ["thumbnail", "waveform", "proxy", "clip_embed", "transcribe"] {
            connection
                .execute(
                    "INSERT INTO jobs(
                        kind, payload, payload_hash, status, attempt,
                        created_at, updated_at, finished_at
                     ) VALUES (?1, '{}', ?2, 'done', 2, 'now', 'now', 'now')",
                    params![kind, format!("hash-{kind}")],
                )
                .unwrap();
        }
        let cache_root = directory.path().join("cache");
        std::fs::create_dir_all(cache_root.join("1")).unwrap();
        std::fs::write(cache_root.join("1/cover.jpg"), [1_u8, 2, 3, 4]).unwrap();

        let result = clear_cache_and_rebuild(&mut connection, &cache_root).unwrap();

        assert_eq!(result.removed_database_rows, 1);
        assert_eq!(result.reset_jobs, 4);
        assert_eq!(result.removed_disk_bytes, 4);
        for table in ["clips", "segments", "ratings"] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 1, "{table} must remain untouched");
        }
        let pending: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM jobs
                 WHERE kind IN ('thumbnail', 'waveform', 'proxy', 'clip_embed')
                   AND status = 'pending' AND attempt = 0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let transcribe_status: String = connection
            .query_row("SELECT status FROM jobs WHERE kind = 'transcribe'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(pending, 4);
        assert_eq!(transcribe_status, "done");
        assert!(cache_root.is_dir());
        assert_eq!(directory_bytes(&cache_root).unwrap(), 0);
    }

    /// R6 Task 7d 修复 Medium:`strip` 的 `cache_artifacts` 行和磁盘文件跟
    /// `thumbnail`/`waveform`/`proxy` 一样被重建清空,job 也必须一起重置成
    /// pending,否则界面永远拿不回胶片条(此前只惰性依赖别的路径重新入队,
    /// 而那条路径此前根本不存在——见 `enqueue_missing_strips`)。
    #[test]
    fn cache_rebuild_resets_strip_jobs_too() {
        let (directory, mut connection) = connection_with_settings();
        connection
            .execute("INSERT INTO volumes(uuid) VALUES ('volume-a')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, quick_hash)
                 VALUES (1, 'volume-a', 'clip.mov', 'source-a')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO jobs(
                    kind, payload, payload_hash, status, attempt,
                    created_at, updated_at, finished_at
                 ) VALUES ('strip', '{}', 'hash-strip', 'done', 1, 'now', 'now', 'now')",
                [],
            )
            .unwrap();

        let cache_root = directory.path().join("cache");
        std::fs::create_dir_all(&cache_root).unwrap();

        clear_cache_and_rebuild(&mut connection, &cache_root).unwrap();

        let (status, attempt): (String, i64) = connection
            .query_row(
                "SELECT status, attempt FROM jobs WHERE kind = 'strip'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "pending", "重建后 strip 任务应重新变为 pending");
        assert_eq!(attempt, 0);
    }

    #[test]
    fn cache_rebuild_never_rewinds_a_running_attempt_and_swaps_the_directory() {
        let (directory, mut connection) = connection_with_settings();
        let running = crate::core::jobs::enqueue(
            &mut connection,
            "thumbnail",
            "{}",
            "running-cache-job",
        )
        .unwrap();
        connection
            .execute(
                "UPDATE jobs SET status='running', attempt=2 WHERE id=?1",
                [running],
            )
            .unwrap();
        let cache_root = directory.path().join("cache");
        std::fs::create_dir_all(&cache_root).unwrap();
        std::fs::write(cache_root.join("old.bin"), b"old").unwrap();

        clear_cache_and_rebuild(&mut connection, &cache_root).unwrap();

        let (status, attempt): (String, i64) = connection
            .query_row(
                "SELECT status, attempt FROM jobs WHERE id=?1",
                [running],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((status.as_str(), attempt), ("running", 2));
        assert!(cache_root.is_dir());
        assert!(!cache_root.join("old.bin").exists());
        assert!(retired_cache_directories(directory.path()).unwrap().is_empty());
    }

    #[test]
    fn model_tiers_resolve_to_the_documented_files() {
        assert_eq!(model_file_for_tier("large-v3-turbo"), "ggml-large-v3-turbo.bin");
        assert_eq!(model_file_for_tier("small"), "ggml-small.bin");
    }

    #[test]
    fn configured_executable_uses_the_persisted_tool_path() {
        let (_directory, connection) = connection_with_settings();
        set_setting(&connection, FFMPEG_PATH_KEY, "/opt/tripcut/bin/ffmpeg").unwrap();

        let resolved = configured_executable(
            &connection,
            FFMPEG_PATH_KEY,
            "TRIPCUT_TEST_FFMPEG_PATH",
            "ffmpeg",
        )
        .unwrap();

        assert_eq!(resolved, OsString::from("/opt/tripcut/bin/ffmpeg"));
    }

    #[test]
    fn bundled_tool_directory_wins_over_environment_path() {
        let directory = TestDirectory::new();
        let bundled = directory.path().join("bundled");
        let shell = directory.path().join("shell");
        std::fs::create_dir_all(&bundled).unwrap();
        std::fs::create_dir_all(&shell).unwrap();
        std::fs::write(bundled.join("ffmpeg"), b"bundled").unwrap();
        std::fs::write(shell.join("ffmpeg"), b"shell").unwrap();
        let shell_path = std::env::join_paths([&shell]).unwrap();

        assert_eq!(
            resolve_executable_in("ffmpeg", vec![bundled.clone()], Some(&shell_path)),
            Some(bundled.join("ffmpeg")),
        );
    }

    #[test]
    fn missing_setting_and_damaged_setting_storage_are_not_conflated() {
        let (_directory, connection) = connection_with_settings();
        assert_eq!(setting_value(&connection, FFMPEG_PATH_KEY).unwrap(), None);

        connection
            .execute(
                "INSERT INTO settings(key, value, updated_at)
                 VALUES (?1, x'80', 'now')",
                [FFMPEG_PATH_KEY],
            )
            .unwrap();

        assert!(setting_value(&connection, FFMPEG_PATH_KEY).is_err());
        assert!(configured_executable(
            &connection,
            FFMPEG_PATH_KEY,
            "TRIPCUT_TEST_FFMPEG_PATH",
            "ffmpeg",
        )
        .is_err());
    }

    /// R10 U-22:首启标记默认 false、只接受 true/false、写过之后 get_settings 也能看到。
    #[test]
    fn onboarding_flag_keys_accept_only_booleans() {
        let (_directory, connection) = connection_with_settings();
        for key in ONBOARDING_FLAG_KEYS {
            assert_eq!(setting_value(&connection, key).unwrap(), None);
            set_setting(&connection, key, "true").unwrap();
            assert_eq!(setting_value(&connection, key).unwrap().as_deref(), Some("true"));
            assert!(set_setting(&connection, key, "yes").is_err());
        }
        assert!(set_setting(&connection, "pipeline.hint_seen.5", "true").is_err());
    }

    /// R13 §3:`guide.<id>.viewed` 按前缀放行(只接受 true/false、id 只含小写字母数字 _ -);
    /// 前缀对但形状不对的键照旧拒绝。
    #[test]
    fn guide_viewed_keys_are_accepted_by_prefix() {
        let (_directory, connection) = connection_with_settings();
        for id in ["nav", "heat", "autoselect", "shot", "gap", "export", "autoplay", "future-guide_2"] {
            let key = format!("guide.{id}.viewed");
            assert_eq!(setting_value(&connection, &key).unwrap(), None);
            set_setting(&connection, &key, "true").unwrap();
            assert_eq!(setting_value(&connection, &key).unwrap().as_deref(), Some("true"));
            set_setting(&connection, &key, "false").unwrap();
            assert!(set_setting(&connection, &key, "yes").is_err(), "{key} 只接受 true/false");
        }
        for bad in ["guide..viewed", "guide.nav", "guide.nav.seen", "guide.Nav.viewed", "guide.a b.viewed", "guides.nav.viewed"] {
            assert!(set_setting(&connection, bad, "true").is_err(), "{bad} 应被拒绝");
        }
        assert_eq!(guide_viewed_id("guide.nav.viewed"), Some("nav"));
        assert_eq!(guide_viewed_id("guide.nav.viewed.viewed"), None);
    }

    #[test]
    fn first_run_done_defaults_false_and_round_trips() {
        let (_dir, connection) = connection_with_settings();
        assert!(!first_run_done(&connection).unwrap());
        assert_eq!(
            get_settings(&connection).unwrap().get(FIRST_RUN_DONE_KEY).map(String::as_str),
            Some("false")
        );
        set_first_run_done(&connection, true).unwrap();
        assert!(first_run_done(&connection).unwrap());
        assert_eq!(
            get_settings(&connection).unwrap().get(FIRST_RUN_DONE_KEY).map(String::as_str),
            Some("true")
        );
        assert!(set_setting(&connection, FIRST_RUN_DONE_KEY, "yes").is_err());
        set_first_run_done(&connection, false).unwrap();
        assert!(!first_run_done(&connection).unwrap());
    }

    #[test]
    fn ui_prefixed_keys_are_accepted_and_round_trip() {
        let (_dir, connection) = connection_with_settings();
        set_setting(&connection, "ui.workspace_v2", "true").expect("ui.workspace_v2 应被接受");
        set_setting(&connection, "ui.pane.pool_width", "320").expect("ui.pane.pool_width 应被接受");
        set_setting(&connection, "ui.inspector.sections_open", "[\"techcheck\",\"similar\"]")
            .expect("JSON 值应被接受");
        let values = get_settings(&connection).expect("读设置");
        assert_eq!(values.get("ui.workspace_v2").map(String::as_str), Some("true"));
        assert_eq!(values.get("ui.pane.pool_width").map(String::as_str), Some("320"));
        assert_eq!(
            values.get("ui.inspector.sections_open").map(String::as_str),
            Some("[\"techcheck\",\"similar\"]")
        );
    }

    #[test]
    fn keymap_keys_accept_presets_and_capped_json() {
        let (_dir, connection) = connection_with_settings();
        for preset in ["jianying", "premiere", "fcp", "custom"] {
            set_setting(&connection, KEYMAP_PRESET_KEY, preset).expect("预设应被接受");
        }
        assert!(set_setting(&connection, KEYMAP_PRESET_KEY, "davinci").is_err());
        set_setting(&connection, KEYMAP_CUSTOM_KEY, "{\"base\":\"jianying\",\"overrides\":{\"favorite\":[\"Shift+f\"]}}")
            .expect("自定义 JSON 应被接受");
        assert!(set_setting(&connection, KEYMAP_CUSTOM_KEY, &"x".repeat(4_097)).is_err());
        let values = get_settings(&connection).expect("读设置");
        assert_eq!(values.get(KEYMAP_PRESET_KEY).map(String::as_str), Some("custom"));
    }

    #[test]
    fn ui_keys_are_length_capped_and_unknown_prefixes_still_rejected() {
        let (_dir, connection) = connection_with_settings();
        let oversized = "x".repeat(4_097);
        assert!(set_setting(&connection, "ui.pool.filter", &oversized).is_err());
        assert!(set_setting(&connection, "uix.pool.filter", "all").is_err());
        assert!(set_setting(&connection, "workspace_v2", "true").is_err());
        // 被拒的写入一律不落库
        let values = get_settings(&connection).expect("读设置");
        assert!(values.keys().all(|key| !key.starts_with("uix.")));
        assert!(!values.contains_key("ui.pool.filter"));
    }
}
