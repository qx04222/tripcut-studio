use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use super::error::{CoreError, Result};

pub const THEME_KEY: &str = "appearance.theme";
pub const UI_SCALE_KEY: &str = "appearance.ui_scale";
pub const WORKER_COUNT_KEY: &str = "performance.worker_count";
pub const PROXY_ENABLED_KEY: &str = "performance.proxy_enabled";
pub const MEMORY_PROFILE_KEY: &str = "performance.memory_profile";
/// R16 车道 E:「省电 / 低配模式」三态开关(`auto` | `on` | `off`),见 `memory_profile`。
pub const LOW_SPEC_MODE_KEY: &str = "performance.low_spec_mode";
/// R16 车道 E:预览小文件目录上限(GB,整数 1–500),超限按最久未播淘汰(`artifacts::enforce_proxy_cache_limit`)。
pub const PROXY_CACHE_LIMIT_GB_KEY: &str = "performance.proxy_cache_limit_gb";
pub const DEFAULT_PROXY_CACHE_LIMIT_GB: f64 = 10.0;
/// R18 W-2:「后台干活的力度」——`eco`(省电 50% 预算)| `balanced`(平衡 100%,默认)
/// | `full`(全速 150%,只在标准 / 高性能档有额外效果)。
/// 取代旧的 `performance.worker_count`:那个 1–8 的旋钮在 4 以上完全没效果
/// (R18 头脑风暴 §1.2 实测 workers 4 = 25.08 s、workers 8 = 25.09 s,差 17 ms),
/// 因为绑住吞吐的是解码许可而不是 worker 数。旧键保留读兼容(见 `background_effort`),
/// 不删老用户库里的值。
pub const BACKGROUND_EFFORT_KEY: &str = "performance.background_effort";
pub const DEFAULT_BACKGROUND_EFFORT: &str = "balanced";

/// R16 车道 E §3⑤:「只在我不用电脑时做后台工作」("true" | "false");没存过时低配档默认开、其它档默认关。
pub const BACKGROUND_ONLY_WHEN_IDLE_KEY: &str = "performance.background_only_when_idle";
pub const FFMPEG_PATH_KEY: &str = "tools.ffmpeg_path";
pub const FFPROBE_PATH_KEY: &str = "tools.ffprobe_path";
pub const WHISPER_PATH_KEY: &str = "tools.whisper_path";
pub const WHISPER_MODEL_TIER_KEY: &str = "tools.whisper_model_tier";
/// R19 P-06:画面理解模型目录的设置覆盖(留空 = 用 `models/<id>/` 自动安装目录;环境变量 `TRIPCUT_CLIP_MODEL_DIR` 优先级更高)。
pub const CLIP_MODEL_DIR_KEY: &str = "tools.clip_model_dir";
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

/// R17 车道 A:自动更新总开关("true" | "false",默认开:后台静默下载,退出/重启时替换)。
pub const UPDATER_AUTO_UPDATE_KEY: &str = "updater.auto_update";
/// R17 车道 A:下载前先问("true" | "false",默认不问——业主拍板静默下载)。
pub const UPDATER_ASK_BEFORE_DOWNLOAD_KEY: &str = "updater.ask_before_download";
/// R17 车道 A:上次检查更新的 unix 秒(前端 `check_for_update` 成功后写;`update_flow::should_auto_check` 读)。
pub const UPDATER_LAST_CHECK_KEY: &str = "updater.last_check";
/// R17 车道 A:用户点了「跳过这个版本」的版本号(空串 = 没跳过);只许 [0-9A-Za-z.+-]。
pub const UPDATER_SKIPPED_VERSION_KEY: &str = "updater.skipped_version";

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

/// R18 车道 settings F1:交付完成的系统通知开关("true" | "false",默认开)。
/// 关掉之后 `notify::post_gated` 一条都不发——包括首次那条用来引出 macOS 权限弹框的。
pub const NOTIFY_EXPORT_COMPLETE_KEY: &str = "notification.export_complete";
/// R18 车道 settings F1:批量分析完成的系统通知开关("true" | "false",默认开)。
pub const NOTIFY_BATCH_COMPLETE_KEY: &str = "notification.batch_complete";
/// R18 车道 settings F5:缓存目录搬到了哪里(空 = 用应用支持目录下的内置位置)。
pub const CACHE_CUSTOM_DIR_KEY: &str = "cache.custom_dir";
/// R18 车道 settings F6:多少天没动过的缓存自动清掉;"0" = 从不(默认)。
pub const CACHE_AUTO_CLEAN_DAYS_KEY: &str = "cache.auto_clean_days";
/// F6 的可选天数——界面与白名单同一份,加一档只改这里。
pub const CACHE_AUTO_CLEAN_DAY_CHOICES: &[&str] = &["0", "15", "30", "60", "90"];

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
    /// R19 P-06:画面理解模型(Chinese-CLIP)就位了吗;`model_dir` 是解析出的目录(环境变量 > 设置 > 自动安装)。
    pub model_available: bool,
    pub model_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CacheStats {
    pub database_bytes: u64,
    pub disk_bytes: u64,
    /// R16:预览小文件合计与上限(字节),设置页显示「占用 / 上限」。
    pub proxy_bytes: u64,
    pub proxy_limit_bytes: u64,
    /// R18 W-7:快照目录合计占用与总量上限(字节)。每次启动写一份整库副本 × 保留 5 份,
    /// 此前用户看不见也删不掉(「清理缓存」不含快照)。
    pub snapshot_bytes: u64,
    pub snapshot_limit_bytes: u64,
}

/// R18 W-1 / W-2:设置页「性能」那一段需要知道的运行时事实——当前落到哪一档、
/// 机器是什么芯片、解码预算多少、这一档能不能选「全速」。界面据此显示档位名与
/// 三挡力度(低配 / 省内存档只显示两挡)。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PerformanceStatus {
    /// `low_spec` | `low` | `standard` | `high_perf`。
    pub profile: String,
    /// `base` | `pro` | `max` | `ultra` | `unknown`。
    pub chip: String,
    pub media_engines: usize,
    pub perf_cores: usize,
    /// 当前力度下真正生效的解码许可数。
    pub decode_permits: usize,
    /// `eco` | `balanced` | `full`。
    pub background_effort: String,
    /// 这一档是否提供「全速」第三挡。
    pub allows_full_effort: bool,
    pub worker_count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SettingsStatus {
    pub ffmpeg: ToolStatus,
    pub ffprobe: ToolStatus,
    pub whisper: WhisperStatus,
    pub clip_sidecar: ClipSidecarStatus,
    pub cache: CacheStats,
    /// R18:当前性能档位与力度(只读,给设置页显示)。
    pub performance: PerformanceStatus,
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
        (LOW_SPEC_MODE_KEY.to_owned(), "auto".to_owned()),
        (BACKGROUND_EFFORT_KEY.to_owned(), DEFAULT_BACKGROUND_EFFORT.to_owned()),
        (PROXY_CACHE_LIMIT_GB_KEY.to_owned(), "10".to_owned()),
        (FIRST_RUN_DONE_KEY.to_owned(), "false".to_owned()),
        (NOTIFY_EXPORT_COMPLETE_KEY.to_owned(), "true".to_owned()),
        (NOTIFY_BATCH_COMPLETE_KEY.to_owned(), "true".to_owned()),
        (CACHE_CUSTOM_DIR_KEY.to_owned(), String::new()),
        (CACHE_AUTO_CLEAN_DAYS_KEY.to_owned(), "0".to_owned()),
        (UPDATER_AUTO_UPDATE_KEY.to_owned(), "true".to_owned()),
        (UPDATER_ASK_BEFORE_DOWNLOAD_KEY.to_owned(), "false".to_owned()),
        (UPDATER_LAST_CHECK_KEY.to_owned(), String::new()),
        (UPDATER_SKIPPED_VERSION_KEY.to_owned(), String::new()),
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
        if key.starts_with("internal.") {
            continue;
        }
        values.insert(key, value);
    }
    // R16:Whisper 模型档与「只在空闲时做后台工作」的默认值随内存档位走,设置页要显示真正生效的那个。
    if setting_value(connection, WHISPER_MODEL_TIER_KEY)?.is_none() {
        values.insert(WHISPER_MODEL_TIER_KEY.to_owned(), whisper_model_tier(connection)?);
    }
    if setting_value(connection, BACKGROUND_ONLY_WHEN_IDLE_KEY)?.is_none() {
        values.insert(
            BACKGROUND_ONLY_WHEN_IDLE_KEY.to_owned(),
            background_only_when_idle(connection)?.to_string(),
        );
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
        LOW_SPEC_MODE_KEY => matches!(value, "auto" | "on" | "off"),
        BACKGROUND_EFFORT_KEY => matches!(value, "eco" | "balanced" | "full"),
        PROXY_CACHE_LIMIT_GB_KEY => value.parse::<u32>().is_ok_and(|gb| (1..=500).contains(&gb)),
        BACKGROUND_ONLY_WHEN_IDLE_KEY => matches!(value, "true" | "false"),
        FIRST_RUN_DONE_KEY => matches!(value, "true" | "false"),
        NOTIFY_EXPORT_COMPLETE_KEY | NOTIFY_BATCH_COMPLETE_KEY => matches!(value, "true" | "false"),
        CACHE_CUSTOM_DIR_KEY => value.len() <= 4_096,
        CACHE_AUTO_CLEAN_DAYS_KEY => CACHE_AUTO_CLEAN_DAY_CHOICES.contains(&value),
        UPDATER_AUTO_UPDATE_KEY | UPDATER_ASK_BEFORE_DOWNLOAD_KEY => matches!(value, "true" | "false"),
        UPDATER_LAST_CHECK_KEY => value.is_empty() || value.parse::<u64>().is_ok(),
        UPDATER_SKIPPED_VERSION_KEY => {
            value.len() <= 32
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-'))
        }
        key if ONBOARDING_FLAG_KEYS.contains(&key) => matches!(value, "true" | "false"),
        // R13 §3(车道 B):剪映式功能气泡「看过了」—— `guide.<id>.viewed` = "true" | "false"。
        // 按前缀放行而不是精确表:首批七个之后每加一个 guide 不必再改 Rust;id 只许 [a-z0-9_-]。
        key if key.starts_with(GUIDE_VIEWED_PREFIX) => {
            guide_viewed_id(key).is_some() && matches!(value, "true" | "false")
        }
        FFMPEG_PATH_KEY | FFPROBE_PATH_KEY | WHISPER_PATH_KEY | CLIP_MODEL_DIR_KEY => value.len() <= 4_096,
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

/// R18 F1:通知开关的读侧。**没存过 / 读不出来一律当「开」**——默认行为与 F1 之前一字不差,
/// 只有用户显式关掉才静音。调用方是 `notify::post_gated`。
pub fn notification_enabled(connection: &Connection, key: &str) -> bool {
    !matches!(setting_value(connection, key).ok().flatten().as_deref(), Some("false"))
}

/// F6:自动清理天数;"0"/非法 = 从不(`None`)。
pub fn cache_auto_clean_days(connection: &Connection) -> Option<u32> {
    let raw = setting_value(connection, CACHE_AUTO_CLEAN_DAYS_KEY).ok().flatten()?;
    match raw.parse::<u32>() {
        Ok(days) if days > 0 && CACHE_AUTO_CLEAN_DAY_CHOICES.contains(&raw.as_str()) => Some(days),
        _ => None,
    }
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

/// R18 W-2:当前生效的「后台干活力度」。用户存过新键就用新键;没存过但老库里
/// 存着 `performance.worker_count`,按最近的一挡映射(≤2 省电、3–5 平衡、≥6 全速)。
/// 旧键不删——回退到旧版本时它还得管用。
pub fn background_effort(connection: &Connection) -> Result<String> {
    if let Some(stored) = setting_value(connection, BACKGROUND_EFFORT_KEY)? {
        if matches!(stored.as_str(), "eco" | "balanced" | "full") {
            return Ok(stored);
        }
    }
    let legacy = setting_value(connection, WORKER_COUNT_KEY)?
        .and_then(|value| value.parse::<usize>().ok());
    Ok(effort_for_legacy_worker_count(legacy).to_owned())
}

/// 旧键 `performance.worker_count` → 新的三挡。没存过(`None`)就是默认「平衡」。
pub fn effort_for_legacy_worker_count(worker_count: Option<usize>) -> &'static str {
    match worker_count {
        Some(count) if count <= 2 => "eco",
        Some(count) if count >= 6 => "full",
        _ => DEFAULT_BACKGROUND_EFFORT,
    }
}

/// R16:当前生效的 Whisper 模型档——用户选过就用用户的,没选过按内存档位取默认
/// (低配档 `small`,其它 `large-v3-turbo`)。所有读这把键的地方都走这里,前端
/// `get_settings` 看到的也是这个值。
pub fn whisper_model_tier(connection: &Connection) -> Result<String> {
    let default_tier = super::memory_profile::resolve(connection)?.default_whisper_tier();
    string_value(connection, WHISPER_MODEL_TIER_KEY, default_tier)
}

/// R16 §3⑤:「只在空闲时做后台工作」是否生效——用户存过就用用户的;没存过按内存档位
/// (低配档默认开,其它档默认关)。
pub fn background_only_when_idle(connection: &Connection) -> Result<bool> {
    match setting_value(connection, BACKGROUND_ONLY_WHEN_IDLE_KEY)?.as_deref() {
        Some("true") => Ok(true),
        Some("false") => Ok(false),
        Some(_) => Err(CoreError::InvalidSchema("「只在空闲时做后台工作」设置已损坏".to_owned())),
        None => Ok(super::memory_profile::resolve(connection)?.low_spec_player()),
    }
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
    Ok(configured_executable_with(
        &configured,
        std::env::var_os(environment_key).as_deref(),
        fallback,
        resolve_executable,
    ))
}

/// 设置 > 环境变量 > 默认名;裸名(如 `"ffmpeg"`)经 `resolve` 落到包内 / 托管 / Homebrew
/// 的绝对路径 —— 以前直接把裸名交给 `Command::new`,那是按进程 PATH 找的,Finder 启动的
/// 应用 PATH 里没有包内目录,shell 启动的又会被 PATH 上任何一份 ffmpeg 抢先(R17 exportfix)。
/// 解析不到就原样返回,错误文案(找不到媒体工具)保持不变。
fn configured_executable_with(
    configured: &str,
    environment: Option<&OsStr>,
    fallback: &str,
    resolve: impl Fn(&OsStr) -> Option<PathBuf>,
) -> OsString {
    let candidate = if !configured.trim().is_empty() {
        OsString::from(configured)
    } else if let Some(environment) = environment.filter(|value| !value.is_empty()) {
        environment.to_owned()
    } else {
        OsString::from(fallback)
    };
    match resolve(&candidate) {
        Some(resolved) => resolved.into_os_string(),
        None => candidate,
    }
}

/// 导出 / 代理用的 ffmpeg:配置的那份没有 VideoToolbox 而包内 sibling 有,就改用包内的
/// (`warn!` 留痕)。设置页仍显示用户配置的路径,`ToolStatus.note` 里说明会改用哪份。
pub fn export_ffmpeg(connection: &Connection) -> Result<OsString> {
    let configured = configured_executable(connection, FFMPEG_PATH_KEY, "FFMPEG_PATH", "ffmpeg")?;
    Ok(prefer_videotoolbox_ffmpeg_in(configured, bundled_sibling("ffmpeg"), |path| {
        super::media_tools::encoder_caps(path).h264_videotoolbox
    }))
}

/// 随包捆绑的同名工具(`current_exe().parent()/<name>`),存在才算。
pub(crate) fn bundled_sibling(name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let candidate = exe.parent()?.join(name);
    candidate.is_file().then_some(candidate)
}

fn prefer_videotoolbox_ffmpeg_in(
    resolved: OsString,
    bundled: Option<PathBuf>,
    has_videotoolbox: impl Fn(&OsStr) -> bool,
) -> OsString {
    let Some(bundled) = bundled else {
        return resolved;
    };
    if bundled.as_os_str() == resolved.as_os_str() || has_videotoolbox(&resolved) {
        return resolved;
    }
    if !has_videotoolbox(bundled.as_os_str()) {
        return resolved;
    }
    tracing::warn!(
        configured = %resolved.to_string_lossy(),
        bundled = %bundled.display(),
        "用户配置的 ffmpeg 缺 VideoToolbox,改用包内"
    );
    bundled.into_os_string()
}

/// 设置页给用户的白话:这份 ffmpeg 没有硬件 H.264 时会怎样。`bundled_has_videotoolbox`
/// 为 `None` 表示没有包内 sibling(开发构建)。
fn videotoolbox_note(has_videotoolbox: bool, bundled_has_videotoolbox: Option<bool>) -> Option<String> {
    if has_videotoolbox {
        return None;
    }
    Some(if bundled_has_videotoolbox == Some(true) {
        "这份 ffmpeg 不支持硬件 H.264 编码,导出和预览会自动改用软件自带的那份;清空自定义路径就会一直用自带的。".to_owned()
    } else {
        "这份 ffmpeg 不支持硬件 H.264 编码,导出会改用兼容编码,速度和画质会差一些;清空自定义路径可换回软件自带的。".to_owned()
    })
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
    let mut ffmpeg = executable_status(
        &configured_ffmpeg,
        std::env::var_os("FFMPEG_PATH").as_deref(),
        "ffmpeg",
    );
    if ffmpeg.available && ffmpeg.note.is_none() {
        let has_vt = |path: &OsStr| super::media_tools::encoder_caps(path).h264_videotoolbox;
        let bundled = bundled_sibling("ffmpeg").filter(|path| path.as_os_str() != OsStr::new(&ffmpeg.resolved_path));
        ffmpeg.note = videotoolbox_note(
            has_vt(OsStr::new(&ffmpeg.resolved_path)),
            bundled.map(|path| has_vt(path.as_os_str())),
        );
    }
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
    // R19 P-06:设置里的覆盖先灌进进程内那份(侧车 spawn 没有连接),再解析。
    let clip_override = string_value(connection, CLIP_MODEL_DIR_KEY, "")?;
    super::model_catalog::set_clip_model_dir_override(
        (!clip_override.trim().is_empty()).then(|| PathBuf::from(clip_override.trim())),
    );
    let clip_model_dir = super::model_catalog::resolve_clip_model_dir().map(|dir| dir.to_string_lossy().into_owned());

    Ok(SettingsStatus {
        performance: performance_status(connection)?,
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
            } else if clip_model_dir.is_none() {
                "画面识别组件已就位，还缺画面理解模型；在下方模型卡点「安装」，装完自动启用。".to_owned()
            } else {
                "自检会在本机启动画面识别组件试跑一次，不会上传素材。".to_owned()
            },
            model_available: clip_model_dir.is_some(),
            model_dir: clip_model_dir,
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

/// R18:当前档位 / 力度 / 机器的只读快照(设置页「性能」段用)。
pub fn performance_status(connection: &Connection) -> Result<PerformanceStatus> {
    let profile = super::memory_profile::resolve(connection)?;
    let effort = background_effort(connection)?;
    let machine = super::machine::current();
    Ok(PerformanceStatus {
        profile: profile.as_str().to_owned(),
        chip: machine.chip.as_str().to_owned(),
        media_engines: machine.media_engines(),
        perf_cores: machine.perf_cores,
        decode_permits: profile.decode_permits_for_effort(&effort),
        background_effort: effort,
        allows_full_effort: profile.allows_full_effort(),
        worker_count: profile.max_worker_count(),
    })
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
        proxy_bytes: super::artifacts::proxy_cache_bytes(connection)?,
        proxy_limit_bytes: super::artifacts::proxy_cache_limit_bytes(connection)?,
        // 快照不在 cache_root 里,它是 cache_root 的兄弟目录(<profile>/<project>/snapshots)。
        snapshot_bytes: cache_root
            .parent()
            .map(|root| super::db::snapshot_bytes(&root.join("snapshots")))
            .unwrap_or(0),
        snapshot_limit_bytes: super::db::SNAPSHOT_TOTAL_LIMIT_BYTES,
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

// ---------------------------------------------------------------------------
// R18 车道 settings F5:「更改缓存位置…」
// ---------------------------------------------------------------------------

/// 搬过去之后在用户选的文件夹里建的那一层。**不直接把用户选的目录当缓存根** ——
/// 否则「清理缓存」那条路径(整目录改名再删)会作用在用户自己的文件夹上。
pub const RELOCATED_CACHE_DIR_NAME: &str = "TripCut缓存";

/// 搬迁要留的余量:目标盘至少要有「缓存大小 + 10%」,且不少于 64 MB。
/// 搬完就贴着满盘跑,下一次预览生成立刻又失败——那不叫搬成功。
const RELOCATE_MARGIN_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CacheRelocation {
    pub new_root: String,
    pub moved_bytes: u64,
    pub moved_files: usize,
}

/// 目标盘够不够。**拆成纯函数是为了能测那句文案** —— 「磁盘不足」这种分支在真机上
/// 极难复现,靠真去装满一块盘来验证是不可能的。
pub fn check_relocation_space(needed_bytes: u64, available_bytes: u64) -> Result<()> {
    let required = needed_bytes.saturating_add(needed_bytes / 10).max(RELOCATE_MARGIN_BYTES);
    if available_bytes >= required {
        return Ok(());
    }
    Err(CoreError::InvalidTransition(format!(
        "这块盘装不下缓存:要 {},只剩 {}。现在怎么办:先在这一页点「清理缓存并重新分析」把缓存清空再搬,或者换一块空间更大的盘。缓存都是可以再生成的,清掉不会丢素材。",
        human_bytes(required),
        human_bytes(available_bytes),
    )))
}

fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

/// 递归复制,返回(字节数, 文件数)。软链接不跟(缓存里不该有,有也不搬)。
fn copy_tree(from: &Path, to: &Path) -> Result<(u64, usize)> {
    std::fs::create_dir_all(to)?;
    let mut bytes = 0_u64;
    let mut files = 0_usize;
    for entry in walkdir::WalkDir::new(from).follow_links(false) {
        let entry = entry.map_err(|error| CoreError::Io(std::io::Error::other(format!("读取缓存目录失败:{error}"))))?;
        let relative = entry.path().strip_prefix(from).unwrap_or(entry.path());
        if relative.as_os_str().is_empty() {
            continue;
        }
        let target = to.join(relative);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            bytes = bytes.saturating_add(std::fs::copy(entry.path(), &target)?);
            files += 1;
        }
    }
    Ok((bytes, files))
}

fn count_files(root: &Path) -> Result<usize> {
    if !root.exists() {
        return Ok(0);
    }
    let mut files = 0;
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|error| CoreError::Io(std::io::Error::other(format!("读取缓存目录失败:{error}"))))?;
        if entry.file_type().is_file() {
            files += 1;
        }
    }
    Ok(files)
}

/// F5 搬迁事务:**先算够不够 → 复制到暂存 → 校验字节数与文件数 → 改名就位 →
/// 写设置 → 删旧目录**。任何一步失败都把暂存目录删掉、设置一个字不改,错误里带
/// 「现在怎么办」。缓存是可重建产物,最坏情况(旧目录已删、新目录坏了)重新生成即可,
/// 不会丢素材。
pub fn relocate_cache_dir(connection: &Connection, current_root: &Path, chosen_parent: &Path) -> Result<CacheRelocation> {
    if !chosen_parent.is_dir() {
        return Err(CoreError::InvalidTransition(
            "选中的位置不是一个文件夹,或者它所在的磁盘没有接上。现在怎么办:接上外接盘、或换一个文件夹再试。".to_owned(),
        ));
    }
    let target = chosen_parent.join(RELOCATED_CACHE_DIR_NAME);
    if target == current_root {
        return Err(CoreError::InvalidTransition("缓存已经放在这里了,不用再搬一次。".to_owned()));
    }
    if chosen_parent.starts_with(current_root) {
        return Err(CoreError::InvalidTransition(
            "不能把缓存搬进它自己里面。现在怎么办:换一个在缓存目录之外的文件夹。".to_owned(),
        ));
    }
    if target.exists() && count_files(&target)? > 0 {
        return Err(CoreError::InvalidTransition(format!(
            "这个位置已经有一个「{RELOCATED_CACHE_DIR_NAME}」文件夹而且不是空的。现在怎么办:换一个文件夹,或先把那个文件夹清空。",
        )));
    }

    let needed = directory_bytes(current_root)?;
    let expected_files = count_files(current_root)?;
    check_relocation_space(needed, super::doctor::available_bytes(chosen_parent)?)?;

    let staging = chosen_parent.join(format!(".tripcut-cache-moving-{}", uuid::Uuid::new_v4().simple()));
    let outcome = (|| -> Result<(u64, usize)> {
        let (bytes, files) = copy_tree(current_root, &staging)?;
        // 校验:字节数与文件数都要跟源对上。对不上就是搬了一半,绝不切设置。
        if files != expected_files || bytes != needed {
            return Err(CoreError::InvalidTransition(format!(
                "搬迁中途出错:源有 {expected_files} 个文件 / {}, 搬过去只有 {files} 个 / {}。已经回滚,缓存还在原处,什么都没丢。现在怎么办:确认目标磁盘没有被拔掉、空间够,再试一次。",
                human_bytes(needed),
                human_bytes(bytes),
            )));
        }
        Ok((bytes, files))
    })();
    let (moved_bytes, moved_files) = match outcome {
        Ok(value) => value,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
    };

    if target.exists() {
        let _ = std::fs::remove_dir_all(&target);
    }
    if let Err(error) = std::fs::rename(&staging, &target) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(CoreError::Io(error));
    }

    let new_root = target.to_string_lossy().into_owned();
    if let Err(error) = set_setting(connection, CACHE_CUSTOM_DIR_KEY, &new_root) {
        // 设置没写成 = 这次搬迁不算数:把刚放好的目录撤掉,旧目录原封不动。
        let _ = std::fs::remove_dir_all(&target);
        return Err(error);
    }

    // 到这里设置已经指向新目录,旧目录只是垃圾了。删不掉也不算失败(下次清理缓存会带走)。
    if let Err(error) = std::fs::remove_dir_all(current_root) {
        tracing::warn!(%error, old = %current_root.display(), "缓存已搬到新位置,但旧目录没删掉");
    }
    Ok(CacheRelocation { new_root, moved_bytes, moved_files })
}

/// 启动时决定缓存根在哪:设置里存了并且那个目录还在 → 用它;否则用内置位置。
/// 外接盘没插的时候故意**退回内置位置**而不是报错 —— 缓存是可重建产物,退回去
/// 只是重新生成一遍预览,总好过整个软件起不来。
pub fn resolve_cache_root(db_path: &Path, builtin: &Path) -> PathBuf {
    let Ok(connection) = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return builtin.to_path_buf();
    };
    match setting_value(&connection, CACHE_CUSTOM_DIR_KEY) {
        Ok(Some(stored)) if !stored.trim().is_empty() => {
            let custom = PathBuf::from(stored.trim());
            if custom.is_dir() {
                custom
            } else {
                tracing::warn!(custom = %custom.display(), "设置里的缓存位置不在了(盘没插?),这次退回内置位置");
                builtin.to_path_buf()
            }
        }
        _ => builtin.to_path_buf(),
    }
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
         WHERE kind IN ('thumbnail', 'photo_preview', 'strip', 'waveform', 'proxy', 'clip_embed')
           AND status != 'running'
           AND NOT (
             kind IN ('thumbnail', 'photo_preview')
             AND EXISTS (
               SELECT 1 FROM photo_meta pm
               WHERE pm.clip_id = jobs.clip_id
                 AND NULLIF(TRIM(pm.error), '') IS NOT NULL
             )
           )",
        [],
    )?;
    let missing_photo_covers=super::photo_decode::enqueue_missing_covers_within(&transaction,cache_root)?;
    // R15:旧目录不在这里同步删(几 GB 的代理文件要转圈好久),登记给 cache_gc 后台删;
    // 与上面的 DELETE / 任务重置同一次提交,应用中途死掉也会在恢复后续删。
    if retired.exists() {
        super::cache_gc::enqueue_retired_dir(&transaction, &retired)?;
    }
    transaction.commit()?;
    swap.committed = true;
    Ok(CacheRebuildResult {
        removed_database_rows,
        reset_jobs:reset_jobs+missing_photo_covers,
        removed_disk_bytes,
    })
}

/// R15:「重置项目库」的结果。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ResetLibraryResult {
    pub removed_clips: usize,
    pub removed_episodes: usize,
    pub removed_disk_bytes: u64,
}

/// 重置时**保留**的表:设置(主题 / 键位 / 引导已看 / 工具路径…都在 `settings`)、
/// 版本号、平台预设、大模型账单。其余全部清空。
const RESET_KEEP_TABLES: &[&str] = &["settings", "schema_version", "platform_presets", "llm_ledger"];

/// R15:「重置项目库」—— 清空整个项目库(素材、集、片段、收藏、任务、导入记录、
/// 关注的文件夹…)并把缓存目录换成空的,只留设置 / 键位 / 引导。单事务;先把缓存目录
/// 改名,事务失败就改回来;旧目录交给 `cache_gc` 后台删。调用方负责先取消全部任务、
/// 暂停认领、打快照(快照就是唯一的后悔药:恢复页「从快照恢复」)。
pub fn reset_project_library(connection: &mut Connection, cache_root: &Path) -> Result<ResetLibraryResult> {
    let removed_disk_bytes = directory_bytes(cache_root)?;
    let parent = cache_root.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let cache_name = cache_root.file_name().and_then(std::ffi::OsStr::to_str).unwrap_or("cache");
    let retired = parent.join(format!(".{cache_name}.retired-{}", uuid::Uuid::new_v4()));
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
    let mut swap = CacheSwap { current: cache_root, retired: &retired, committed: false };

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // 外键检查推迟到提交:表按 sqlite_master 顺序清,不必排父子关系。
    transaction.execute_batch("PRAGMA defer_foreign_keys = ON")?;
    let removed_clips: i64 = transaction.query_row("SELECT COUNT(*) FROM clips", [], |row| row.get(0))?;
    let removed_episodes: i64 = transaction.query_row("SELECT COUNT(*) FROM episodes", [], |row| row.get(0))?;
    tracing::warn!(removed_clips, removed_episodes, cache_root = %cache_root.display(), "reset_project_library: deleting every table except settings / schema_version / platform_presets / llm_ledger");
    let tables = {
        let mut statement = transaction.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for table in tables.iter().filter(|table| !RESET_KEEP_TABLES.contains(&table.as_str())) {
        transaction.execute(&format!("DELETE FROM \"{table}\""), [])?;
    }
    // 设置里指着旧素材 / 旧计数的键一并清掉;主题、键位、引导、工具路径都留着。
    transaction.execute(
        "DELETE FROM settings
         WHERE key LIKE 'ui.selection.%'
            OR key LIKE 'internal.similar.primary.%'
            OR key IN ('removed_clip_high_water', 'import_generation')",
        [],
    )?;
    transaction.execute(
        "INSERT INTO episodes(title, theme, created_at, status, episode_number, memory_id)
         VALUES ('EP01', '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'active', 1, lower(hex(randomblob(16))))",
        [],
    )?;
    if retired.exists() {
        super::cache_gc::enqueue_retired_dir(&transaction, &retired)?;
    }
    transaction.commit()?;
    swap.committed = true;
    Ok(ResetLibraryResult {
        removed_clips: removed_clips.max(0) as usize,
        removed_episodes: removed_episodes.max(0) as usize,
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

    /// R18 F5:搬迁事务走完之后 —— 旧目录没了、新目录有全部内容、设置指向新目录、
    /// `cache_stats().disk_bytes` 从新目录读、`resolve_cache_root` 也认新目录。
    #[test]
    fn relocate_cache_dir_moves_everything_and_repoints_the_settings() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let cache_root = directory.path().join("cache");
        std::fs::create_dir_all(cache_root.join("12")).unwrap();
        std::fs::write(cache_root.join("12/cover.jpg"), vec![7_u8; 2048]).unwrap();
        std::fs::write(cache_root.join("note.txt"), b"hello").unwrap();
        let elsewhere = directory.path().join("外接盘");
        std::fs::create_dir_all(&elsewhere).unwrap();

        let moved = relocate_cache_dir(&connection, &cache_root, &elsewhere).unwrap();
        let new_root = PathBuf::from(&moved.new_root);
        assert_eq!(moved.moved_files, 2);
        assert_eq!(moved.moved_bytes, 2048 + 5);
        assert!(!cache_root.exists(), "旧目录必须已经不在了");
        assert!(new_root.join("12/cover.jpg").is_file() && new_root.join("note.txt").is_file());
        assert_eq!(setting_value(&connection, CACHE_CUSTOM_DIR_KEY).unwrap().as_deref(), Some(moved.new_root.as_str()));
        assert_eq!(cache_stats(&connection, &new_root).unwrap().disk_bytes, 2048 + 5);
        assert_eq!(resolve_cache_root(&directory.db_path(), &cache_root), new_root);
    }

    /// F5:目标盘装不下时什么都不做,错误里要有「现在怎么办」。
    /// (真去装满一块盘是不可能的,所以空间判定拆成了纯函数,这里直接钉它。)
    #[test]
    fn relocation_refuses_when_the_disk_is_too_small_and_says_what_to_do() {
        assert!(check_relocation_space(0, 0).is_err(), "余量门槛是绝对值,0 字节的盘也不许搬");
        assert!(check_relocation_space(1024, 10 * 1024 * 1024 * 1024).is_ok());
        let error = check_relocation_space(8 * 1024 * 1024 * 1024, 1024 * 1024 * 1024).unwrap_err().to_string();
        assert!(error.contains("现在怎么办"), "磁盘不足的文案必须给出路:{error}");
        assert!(error.contains("8.8 GB") && error.contains("1.0 GB"), "要把两个数字都摆出来:{error}");
    }

    /// F5:搬到一半失败 / 选了个非目录 —— 设置一个字不改,旧目录原封不动。
    #[test]
    fn relocation_failures_leave_the_old_cache_and_the_setting_untouched() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let cache_root = directory.path().join("cache");
        std::fs::create_dir_all(&cache_root).unwrap();
        std::fs::write(cache_root.join("a.bin"), b"x").unwrap();

        // ① 选的不是文件夹(盘没插就是这个样子)。
        let missing = directory.path().join("没插的盘");
        assert!(relocate_cache_dir(&connection, &cache_root, &missing).is_err());

        // ② 目标位置已经有一个非空的同名文件夹。
        let occupied = directory.path().join("占用");
        std::fs::create_dir_all(occupied.join(RELOCATED_CACHE_DIR_NAME)).unwrap();
        std::fs::write(occupied.join(RELOCATED_CACHE_DIR_NAME).join("别人的.txt"), b"keep").unwrap();
        let error = relocate_cache_dir(&connection, &cache_root, &occupied).unwrap_err().to_string();
        assert!(error.contains("现在怎么办"), "{error}");
        assert!(occupied.join(RELOCATED_CACHE_DIR_NAME).join("别人的.txt").is_file(), "别人的文件不许动");

        // ③ 想把缓存搬进它自己里面。
        assert!(relocate_cache_dir(&connection, &cache_root, &cache_root).is_err());

        assert!(cache_root.join("a.bin").is_file(), "失败路径上旧缓存必须还在");
        assert_eq!(setting_value(&connection, CACHE_CUSTOM_DIR_KEY).unwrap().as_deref(), None);
        // 暂存目录不许留下来。
        for parent in [&occupied, directory.path()] {
            for entry in std::fs::read_dir(parent).unwrap() {
                let name = entry.unwrap().file_name().to_string_lossy().into_owned();
                assert!(!name.starts_with(".tripcut-cache-moving-"), "暂存目录没清干净:{name}");
            }
        }
    }

    /// R18 F1:两把通知键默认 "true",只认 true/false;`notification_enabled` 把「没存过」当开。
    #[test]
    fn notification_keys_default_on_and_only_accept_booleans() {
        let (_directory, connection) = connection_with_settings();
        let values = get_settings(&connection).unwrap();
        assert_eq!(values[NOTIFY_EXPORT_COMPLETE_KEY], "true");
        assert_eq!(values[NOTIFY_BATCH_COMPLETE_KEY], "true");
        assert!(notification_enabled(&connection, NOTIFY_EXPORT_COMPLETE_KEY));

        assert!(set_setting(&connection, NOTIFY_EXPORT_COMPLETE_KEY, "maybe").is_err());
        set_setting(&connection, NOTIFY_EXPORT_COMPLETE_KEY, "false").unwrap();
        assert!(!notification_enabled(&connection, NOTIFY_EXPORT_COMPLETE_KEY));
        assert!(notification_enabled(&connection, NOTIFY_BATCH_COMPLETE_KEY));
    }

    // R17 车道 A:四把 updater 键进白名单,默认「自动更新开、下载前不问」(业主拍板)。
    #[test]
    fn updater_keys_round_trip_with_silent_defaults() {
        let (_directory, connection) = connection_with_settings();
        let values = get_settings(&connection).unwrap();
        assert_eq!(values[UPDATER_AUTO_UPDATE_KEY], "true");
        assert_eq!(values[UPDATER_ASK_BEFORE_DOWNLOAD_KEY], "false");
        assert_eq!(values[UPDATER_LAST_CHECK_KEY], "");
        assert_eq!(values[UPDATER_SKIPPED_VERSION_KEY], "");

        set_setting(&connection, UPDATER_AUTO_UPDATE_KEY, "false").unwrap();
        set_setting(&connection, UPDATER_ASK_BEFORE_DOWNLOAD_KEY, "true").unwrap();
        set_setting(&connection, UPDATER_LAST_CHECK_KEY, "1800000000").unwrap();
        set_setting(&connection, UPDATER_SKIPPED_VERSION_KEY, "0.8.0").unwrap();
        set_setting(&connection, UPDATER_SKIPPED_VERSION_KEY, "").unwrap();
        let values = get_settings(&connection).unwrap();
        assert_eq!(values[UPDATER_AUTO_UPDATE_KEY], "false");
        assert_eq!(values[UPDATER_LAST_CHECK_KEY], "1800000000");
        assert_eq!(values[UPDATER_SKIPPED_VERSION_KEY], "");

        assert!(set_setting(&connection, UPDATER_AUTO_UPDATE_KEY, "yes").is_err());
        assert!(set_setting(&connection, UPDATER_LAST_CHECK_KEY, "2026-09-14").is_err());
        assert!(set_setting(&connection, UPDATER_SKIPPED_VERSION_KEY, "0.8.0; rm -rf").is_err());
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

    /// R18 W-2:新键默认「平衡」;老库里只有 `performance.worker_count` 时按最近一挡映射。
    #[test]
    fn background_effort_defaults_to_balanced_and_maps_the_legacy_worker_count() {
        assert_eq!(effort_for_legacy_worker_count(None), "balanced");
        assert_eq!(effort_for_legacy_worker_count(Some(1)), "eco");
        assert_eq!(effort_for_legacy_worker_count(Some(2)), "eco");
        assert_eq!(effort_for_legacy_worker_count(Some(3)), "balanced");
        assert_eq!(effort_for_legacy_worker_count(Some(4)), "balanced");
        assert_eq!(effort_for_legacy_worker_count(Some(5)), "balanced");
        assert_eq!(effort_for_legacy_worker_count(Some(6)), "full");
        assert_eq!(effort_for_legacy_worker_count(Some(8)), "full");

        let (_directory, connection) = connection_with_settings();
        assert_eq!(background_effort(&connection).unwrap(), "balanced");
        // 老库:只写过 worker_count = 8 → 全速。新键不写就不算存过。
        set_setting(&connection, WORKER_COUNT_KEY, "8").unwrap();
        assert_eq!(background_effort(&connection).unwrap(), "full");
        // 用户在新界面上选了「省电」,新键优先,旧键不删(回退旧版本还得用)。
        set_setting(&connection, BACKGROUND_EFFORT_KEY, "eco").unwrap();
        assert_eq!(background_effort(&connection).unwrap(), "eco");
        assert_eq!(setting_value(&connection, WORKER_COUNT_KEY).unwrap().as_deref(), Some("8"));
        assert!(set_setting(&connection, BACKGROUND_EFFORT_KEY, "turbo").is_err());
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
                proxy_bytes: 0,
                proxy_limit_bytes: 10 << 30,
                // R18 W-7:快照目录是 cache_root 的兄弟目录,本例里不存在 → 0。
                snapshot_bytes: 0,
                snapshot_limit_bytes: super::super::db::SNAPSHOT_TOTAL_LIMIT_BYTES,
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
        for kind in ["thumbnail", "photo_preview", "waveform", "proxy", "clip_embed", "transcribe"] {
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
        assert_eq!(result.reset_jobs, 5);
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
                 WHERE kind IN ('thumbnail', 'photo_preview', 'waveform', 'proxy', 'clip_embed')
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
        assert_eq!(pending, 5);
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

    /// 清缓存与启动补扫必须遵守同一条坏图边界：曾经健康、已有 preview 历史的照片
    /// 后来确认损坏时，thumbnail / photo_preview 均保持终态；NULL / 空错误仍可重建。
    #[test]
    fn cache_rebuild_does_not_retry_confirmed_bad_photo_thumbnail() {
        let (directory,mut connection)=connection_with_settings();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('photos')",[]).unwrap();
        connection.execute_batch(
            "INSERT INTO clips(id,volume_uuid,rel_path,quick_hash,kind) VALUES
               (41,'photos','bad.heic','bad-hash','photo'),
               (42,'photos','retry-null.heic','retry-null-hash','photo'),
               (43,'photos','retry-empty.heic','retry-empty-hash','photo');
             INSERT INTO photo_meta(clip_id,error) VALUES(41,NULL);
             INSERT INTO photo_meta(clip_id,error) VALUES(42,NULL);
             INSERT INTO photo_meta(clip_id,error) VALUES(43,'');",
        ).unwrap();
        crate::core::photo_decode::enqueue(&mut connection,41,Path::new("bad.heic"),"bad-hash").unwrap();
        crate::core::photo_decode::enqueue(&mut connection,42,Path::new("retry-null.heic"),"retry-null-hash").unwrap();
        crate::core::photo_decode::enqueue(&mut connection,43,Path::new("retry-empty.heic"),"retry-empty-hash").unwrap();
        let bad_preview_blocked=crate::core::jobs::enqueue(&mut connection,"photo_preview",r#"{"clip_id":41}"#,"bad-preview-blocked").unwrap();
        let bad_preview_done=crate::core::jobs::enqueue(&mut connection,"photo_preview",r#"{"clip_id":41}"#,"bad-preview-done").unwrap();
        crate::core::jobs::enqueue(&mut connection,"photo_preview",r#"{"clip_id":42}"#,"null-preview").unwrap();
        crate::core::jobs::enqueue(&mut connection,"photo_preview",r#"{"clip_id":43}"#,"empty-preview").unwrap();
        connection.execute(
            "UPDATE jobs SET status='blocked',attempt=3,blocked_summary='decode failed',finished_at='now'
             WHERE kind='thumbnail'",
            [],
        ).unwrap();
        connection.execute(
            "UPDATE jobs SET status='blocked',attempt=3,blocked_summary='decode failed',finished_at='now'
             WHERE id=?1",
            [bad_preview_blocked],
        ).unwrap();
        connection.execute(
            "UPDATE jobs SET status='done',attempt=1,result_path='old-preview.jpg',finished_at='now'
             WHERE id=?1",
            [bad_preview_done],
        ).unwrap();
        connection.execute(
            "UPDATE jobs SET status='blocked',attempt=2,blocked_summary='transient',finished_at='now'
             WHERE kind='photo_preview' AND clip_id IN (42,43)",
            [],
        ).unwrap();
        connection.execute("UPDATE photo_meta SET error='图片不完整或已损坏' WHERE clip_id=41",[]).unwrap();
        let cache_root=directory.path().join("cache");
        std::fs::create_dir_all(&cache_root).unwrap();

        clear_cache_and_rebuild(&mut connection,&cache_root).unwrap();
        let bad:(i64,String,i64)=connection.query_row(
            "SELECT COUNT(*),MIN(status),MIN(attempt) FROM jobs WHERE kind='thumbnail' AND clip_id=41",
            [],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).unwrap();
        assert_eq!(bad,(1,"blocked".into(),3),"清缓存不得复位确定性坏图");
        let bad_previews:Vec<(String,i64)>=connection.prepare(
            "SELECT status,attempt FROM jobs WHERE kind='photo_preview' AND clip_id=41 ORDER BY id",
        ).unwrap().query_map([],|row|Ok((row.get(0)?,row.get(1)?))).unwrap()
            .collect::<std::result::Result<_,_>>().unwrap();
        assert_eq!(bad_previews,vec![("blocked".into(),3),("done".into(),1)],"坏图遗留 preview 终态不得复位");
        for clip_id in [42,43] {
            for kind in ["thumbnail","photo_preview"] {
                let state:(String,i64)=connection.query_row(
                    "SELECT status,attempt FROM jobs WHERE kind=?1 AND clip_id=?2",
                    rusqlite::params![kind,clip_id],|row|Ok((row.get(0)?,row.get(1)?)),
                ).unwrap();
                assert_eq!(state,("pending".into(),0),"NULL/空错误的健康照片任务仍应重建:{clip_id}/{kind}");
            }
        }
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
        // R15:旧目录不再在命令里同步删 —— 登记给 cache_gc,跑完才没了。
        let retired = retired_cache_directories(directory.path()).unwrap();
        assert_eq!(retired.len(), 1, "旧目录应改名退役、等后台删");
        let (payload, status): (String, String) = connection
            .query_row("SELECT payload, status FROM jobs WHERE kind = 'cache_gc'", [], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap();
        assert_eq!(status, "pending");
        assert!(payload.contains(&retired[0].file_name().unwrap().to_string_lossy().to_string()));
        let job = crate::core::jobs::Job {
            id: 0,
            kind: "cache_gc".to_owned(),
            payload,
            status: crate::core::jobs::JobStatus::Running,
            attempt: 1,
            blocked_summary: None,
            result_path: None,
        };
        crate::core::cache_gc::run(&job, &cache_root).unwrap();
        assert!(retired_cache_directories(directory.path()).unwrap().is_empty());
    }

    /// R15:重置项目库 —— 素材 / 集 / 片段 / 收藏 / 任务 / 关注文件夹全没了,设置留着,
    /// 种一个空的 EP01,缓存目录换成空的、旧目录交 cache_gc。
    #[test]
    fn reset_project_library_wipes_data_but_keeps_settings() {
        let (directory, mut connection) = connection_with_settings();
        set_setting(&connection, "keymap.preset", "premiere").unwrap();
        set_setting(&connection, "ui.selection.last_clip", "1").unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('volume-a')", []).unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, quick_hash, episode_id)
                 VALUES (1, 'volume-a', 'clip.mov', 'source-a', (SELECT id FROM episodes WHERE status='active'))",
                [],
            )
            .unwrap();
        connection
            .execute("INSERT INTO segments(id, clip_id, in_ticks, out_ticks, kind, tombstone) VALUES (1, 1, 0, 10, 'select', 0)", [])
            .unwrap();
        connection
            .execute("INSERT INTO watched_folders(path, auto_sync, added_at) VALUES ('/card', 1, 'now')", [])
            .unwrap();
        crate::core::jobs::enqueue(&mut connection, "proxy", r#"{"clip_id":1}"#, "p1").unwrap();
        crate::core::episode::archive_current(&mut connection, Some("EP02")).unwrap();
        let cache_root = directory.path().join("cache");
        std::fs::create_dir_all(cache_root.join("1")).unwrap();
        std::fs::write(cache_root.join("1/proxy.mp4"), [0_u8; 16]).unwrap();

        let result = reset_project_library(&mut connection, &cache_root).unwrap();
        assert_eq!(result.removed_clips, 1);
        assert_eq!(result.removed_episodes, 2);
        assert_eq!(result.removed_disk_bytes, 16);

        let count = |sql: &str| connection.query_row(sql, [], |row| row.get::<_, i64>(0)).unwrap();
        assert_eq!(count("SELECT COUNT(*) FROM clips"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM segments"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM watched_folders"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM volumes"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM episode_archives"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM jobs WHERE kind != 'cache_gc'"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM jobs WHERE kind = 'cache_gc' AND status = 'pending'"), 1);
        assert!(count("SELECT COUNT(*) FROM platform_presets") > 0, "平台预设是种子数据,要留");
        assert_eq!(count("SELECT COUNT(*) FROM pragma_foreign_key_check"), 0);
        let current = crate::core::episode::current_episode(&connection).unwrap();
        assert_eq!(current.title, "EP01");
        assert_eq!(current.clip_count, 0);
        assert_eq!(setting_value(&connection, "keymap.preset").unwrap().as_deref(), Some("premiere"), "键位设置要留");
        assert!(setting_value(&connection, "ui.selection.last_clip").unwrap().is_none(), "指着旧素材的选择要清");
        assert!(cache_root.is_dir());
        assert!(!cache_root.join("1").exists());
        assert_eq!(retired_cache_directories(directory.path()).unwrap().len(), 1);
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

    /// R17 exportfix:裸名不再直接交给 Command(按进程 PATH 找),而是经解析器落到绝对路径;
    /// 解析不到保持裸名;设置里写了绝对路径的照旧。
    #[test]
    fn bare_tool_names_are_resolved_before_reaching_command() {
        let resolver = |candidate: &OsStr| {
            (candidate == OsStr::new("ffmpeg")).then(|| PathBuf::from("/App.app/Contents/MacOS/ffmpeg"))
        };
        assert_eq!(
            configured_executable_with("", None, "ffmpeg", resolver),
            OsString::from("/App.app/Contents/MacOS/ffmpeg")
        );
        assert_eq!(
            configured_executable_with("", Some(OsStr::new("ffmpeg")), "ffprobe", resolver),
            OsString::from("/App.app/Contents/MacOS/ffmpeg")
        );
        // 解析不到:原样返回,错误文案沿用「找不到媒体工具」。
        assert_eq!(configured_executable_with("", None, "whisper-cli", resolver), OsString::from("whisper-cli"));
        // 绝对路径不存在时同样原样返回(不静默换成别的)。
        assert_eq!(
            configured_executable_with("/nope/ffmpeg", None, "ffmpeg", resolver),
            OsString::from("/nope/ffmpeg")
        );
    }

    /// R17 exportfix:配置的 ffmpeg 没有 VideoToolbox、包内那份有 → 导出改用包内;
    /// 配置的有 VT、或包内也没有、或根本没有包内 sibling → 尊重配置。
    #[test]
    fn export_ffmpeg_falls_back_to_the_bundled_copy_only_when_it_has_videotoolbox() {
        let bundled = PathBuf::from("/App.app/Contents/MacOS/ffmpeg");
        let vt_only_in_bundle = |path: &OsStr| path == bundled.as_os_str();
        assert_eq!(
            prefer_videotoolbox_ffmpeg_in(OsString::from("/opt/conda/bin/ffmpeg"), Some(bundled.clone()), vt_only_in_bundle),
            bundled.clone().into_os_string()
        );
        assert_eq!(
            prefer_videotoolbox_ffmpeg_in(OsString::from("/opt/homebrew/bin/ffmpeg"), Some(bundled.clone()), |_| true),
            OsString::from("/opt/homebrew/bin/ffmpeg")
        );
        assert_eq!(
            prefer_videotoolbox_ffmpeg_in(OsString::from("/opt/conda/bin/ffmpeg"), Some(bundled.clone()), |_| false),
            OsString::from("/opt/conda/bin/ffmpeg")
        );
        assert_eq!(
            prefer_videotoolbox_ffmpeg_in(OsString::from("/opt/conda/bin/ffmpeg"), None, |_| false),
            OsString::from("/opt/conda/bin/ffmpeg")
        );
        // 已经是包内那份:不重复探测、原样返回。
        assert_eq!(
            prefer_videotoolbox_ffmpeg_in(bundled.clone().into_os_string(), Some(bundled.clone()), |_| panic!("不该探测")),
            bundled.into_os_string()
        );
    }

    #[test]
    fn tool_status_note_explains_missing_videotoolbox_in_plain_words() {
        assert_eq!(videotoolbox_note(true, Some(true)), None);
        let will_switch = videotoolbox_note(false, Some(true)).unwrap();
        assert!(will_switch.contains("自动改用软件自带的那份"), "{will_switch}");
        assert!(will_switch.contains("清空自定义路径"), "{will_switch}");
        let no_bundle = videotoolbox_note(false, None).unwrap();
        assert!(no_bundle.contains("兼容编码"), "{no_bundle}");
        assert_eq!(videotoolbox_note(false, Some(false)), videotoolbox_note(false, None));
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
