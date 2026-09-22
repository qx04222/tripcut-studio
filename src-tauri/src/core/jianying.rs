use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use super::deliver::{self, ExportClip};
use super::error::{CoreError, Result};

const JIANYING_APP_PLIST: &str = "/Applications/VideoFusion-macOS.app/Contents/Info.plist";
const DRAFT_INFO_FILE: &str = "draft_info.json";
const DRAFT_META_FILE: &str = "draft_meta_info.json";
const DELIVERY_README_FILE: &str = "TripCut交付说明.txt";
const SUBTITLE_DIRECTORY: &str = "TripCut字幕";
const SCHEMA_NEW_VERSION: &str = "75.0.0";
const SCHEMA_VERSION: i64 = 360_000;
const TOP_LEVEL_KEY_COUNT: usize = 36;
const MATERIAL_KEY_COUNT: usize = 55;
const PROJECT_NAME: &str = "旅剪项目";
/// R14 C-1:草稿名里集名的最大字符数——剪映草稿列表一行放不下太长的名字,超出即截断。
const DRAFT_NAME_TITLE_MAX_CHARS: usize = 40;

pub const SUPPORTED_JIANYING_VERSIONS: &[&str] = &["11.3.0"];

/// 已在本机装上、但还没人眼验证过的剪映版本。2026-09-10 实测:11.4.13169(09-12 又自动升到 11.4.13189)把草稿文件改名为
/// `template-2.tmp` 且连同 `draft_info.json` 一起加密(1164 字节非 JSON),金丝雀的键集比对
/// 已无从做起;TripCut 写出的明文 11.3.0 草稿在 11.4 里能否打开,只能由业主在剪映里开一次确认。
/// 在此之前:应用侧照旧按"不支持的版本"拒绝生成草稿(不假装可用);真机金丝雀对这些版本打印
/// WARN 并跳过键集比对,而不是让整个门禁一直红。确认可用后把版本挪进 `SUPPORTED_JIANYING_VERSIONS`。
pub const JIANYING_VERSIONS_PENDING_HUMAN_CHECK: &[&str] = &["11.4.13169", "11.4.13189"];

/// R14 §9 A:人眼验证结果落在 settings 的键前缀,完整键 `jianying.human_check.<version>`,
/// 值 "ok" | "fail"。只对 `JIANYING_VERSIONS_PENDING_HUMAN_CHECK` 里的版本有意义 —— 未知版本
/// 记了 ok 也不放行(`availability_from` 只把 ok 当作「待验证 → 已验证」的升格)。
pub const HUMAN_CHECK_PREFIX: &str = "jianying.human_check.";

// E0 的 11.3.0 template.tmp 金丝雀确认 new_version/version；其余字段按任务卡
// 指定的 pyJianYingDraft 经典结构内嵌。这里不读取、include 或复制用户草稿。
const DRAFT_TEMPLATE_11_3_0: &str = r#"
{
  "canvas_config":{"background":null,"height":0,"ratio":"original","width":0},
  "color_space":0,
  "config":{"adjust_max_index":1,"attachment_info":[],"combination_max_index":1,"export_range":null,"extract_audio_last_index":1,"lyrics_recognition_id":"","lyrics_sync":true,"lyrics_taskinfo":[],"maintrack_adsorb":true,"material_save_mode":0,"multi_language_current":"none","multi_language_list":[],"multi_language_main":"none","multi_language_mode":"none","original_sound_last_index":1,"record_audio_last_index":1,"sticker_max_index":1,"subtitle_keywords_config":null,"subtitle_recognition_id":"","subtitle_sync":true,"subtitle_taskinfo":[],"system_font_list":[],"use_float_render":false,"video_mute":false,"voice_change_sync":false,"zoom_info_params":null},
  "cover":null,
  "create_time":0,
  "draft_type":"video",
  "duration":0,
  "extra_info":null,
  "fps":30.0,
  "free_render_index_mode_on":false,
  "function_assistant_info":{"audio_noise_segid_list":[],"auto_adjust":false,"auto_adjust_fixed":false,"auto_adjust_fixed_value":50.0,"auto_adjust_segid_list":[],"auto_caption":false,"auto_caption_segid_list":[],"auto_caption_template_id":"","caption_opt":false,"caption_opt_segid_list":[],"color_correction":false,"color_correction_fixed":false,"color_correction_fixed_value":50.0,"color_correction_segid_list":[],"deflicker_segid_list":[],"enhance_quality":false,"enhance_quality_fixed":false,"enhance_quality_segid_list":[],"enhance_voice_segid_list":[],"enhande_voice":false,"enhande_voice_fixed":false,"eye_correction":false,"eye_correction_segid_list":[],"fixed_rec_applied":false,"fps":{"den":1,"num":0},"normalize_loudness":false,"normalize_loudness_audio_denoise_segid_list":[],"normalize_loudness_fixed":false,"normalize_loudness_segid_list":[],"retouch":false,"retouch_fixed":false,"retouch_segid_list":[],"smart_rec_applied":false,"smart_segid_list":[],"smooth_slow_motion":false,"smooth_slow_motion_fixed":false,"video_noise_segid_list":[]},
  "group_container":null,
  "id":"",
  "is_drop_frame_timecode":false,
  "keyframe_graph_list":[],
  "keyframes":{"adjusts":[],"audios":[],"effects":[],"filters":[],"handwrites":[],"stickers":[],"texts":[],"videos":[]},
  "last_modified_platform":{"app_id":0,"app_source":"","app_version":"","device_id":"","hard_disk_id":"","mac_address":"","os":"","os_version":""},
  "lyrics_effects":[],
  "materials":{"ai_text_effects":[],"ai_translates":[],"audio_balances":[],"audio_effects":[],"audio_fades":[],"audio_pannings":[],"audio_pitch_shifts":[],"audio_track_indexes":[],"audios":[],"beats":[],"canvases":[],"chromas":[],"color_curves":[],"common_mask":[],"digital_human_model_dressing":[],"digital_humans":[],"drafts":[],"effects":[],"flowers":[],"green_screens":[],"handwrites":[],"hsl":[],"hsl_curves":[],"images":[],"log_color_wheels":[],"loudnesses":[],"manual_beautys":[],"manual_deformations":[],"material_animations":[],"material_colors":[],"multi_language_refs":[],"placeholder_infos":[],"placeholders":[],"plugin_effects":[],"primary_color_wheels":[],"realtime_denoises":[],"shapes":[],"smart_crops":[],"smart_relights":[],"sound_channel_mappings":[],"speeds":[],"stickers":[],"tail_leaders":[],"text_templates":[],"texts":[],"time_marks":[],"transitions":[],"video_effects":[],"video_radius":[],"video_shadows":[],"video_strokes":[],"video_trackings":[],"videos":[],"vocal_beautifys":[],"vocal_separations":[]},
  "mixed_track_mode_on":false,
  "mutable_config":null,
  "name":"",
  "new_version":"75.0.0",
  "path":"",
  "platform":{"app_id":0,"app_source":"","app_version":"","device_id":"","hard_disk_id":"","mac_address":"","os":"","os_version":""},
  "relationships":[],
  "render_index_track_mode_on":false,
  "retouch_cover":null,
  "smart_ads_info":{"draft_url":"","page_from":"","routine":""},
  "source":"default",
  "static_cover_image_path":"",
  "time_marks":null,
  "tracks":[],
  "uneven_animation_template_info":{"composition":"","content":"","order":"","sub_template_info_list":[]},
  "update_time":0,
  "version":360000
}
"#;

const META_TEMPLATE: &str = r#"
{
  "cloud_package_completed_time":"",
  "draft_cloud_capcut_purchase_info":"",
  "draft_cloud_last_action_download":false,
  "draft_cloud_materials":[],
  "draft_cloud_purchase_info":"",
  "draft_cloud_template_id":"",
  "draft_cloud_tutorial_info":"",
  "draft_cloud_videocut_purchase_info":"",
  "draft_cover":"",
  "draft_deeplink_url":"",
  "draft_enterprise_info":{"draft_enterprise_extra":"","draft_enterprise_id":"","draft_enterprise_name":"","enterprise_material":[]},
  "draft_fold_path":"",
  "draft_id":"",
  "draft_is_ai_packaging_used":false,
  "draft_is_ai_shorts":false,
  "draft_is_ai_translate":false,
  "draft_is_article_video_draft":false,
  "draft_is_from_deeplink":"false",
  "draft_is_invisible":false,
  "draft_json_file":"",
  "draft_materials":[{"type":0,"value":[]},{"type":1,"value":[]},{"type":2,"value":[]},{"type":3,"value":[]},{"type":6,"value":[]},{"type":7,"value":[]},{"type":8,"value":[]}],
  "draft_materials_copied_info":[],
  "draft_name":"",
  "draft_new_version":"75.0.0",
  "draft_removable_storage_device":"",
  "draft_root_path":"",
  "draft_segment_extra_info":[],
  "draft_type":"",
  "tm_draft_cloud_completed":"",
  "tm_draft_cloud_modified":0,
  "tm_draft_create":0,
  "tm_draft_modified":0,
  "tm_draft_removed":0,
  "tm_duration":0
}
"#;

/// 业主在剪映里开过一次试验草稿之后的裁定(R14 §9 A)。`None` = 还没人试过。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HumanCheck {
    None,
    Ok,
    Fail,
}

impl HumanCheck {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "ok" => Some(Self::Ok),
            "fail" => Some(Self::Fail),
            "none" => Some(Self::None),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Ok => "ok",
            Self::Fail => "fail",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct JianyingAvailability {
    pub installed_version: Option<String>,
    /// 与 `usable` 同值;老前端只认这个名字,保留。
    pub supported: bool,
    pub reason: String,
    /// 版本在 `SUPPORTED_JIANYING_VERSIONS` 白名单里。
    pub whitelisted: bool,
    /// settings `jianying.human_check.<version>` 的裁定。
    pub human_check: HumanCheck,
    /// `whitelisted || human_check == ok`,且草稿根目录存在。普通(非 force)生成只看它。
    pub usable: bool,
    /// 版本在「待人眼验证」名单里且草稿根目录存在:允许 `force = true` 试着生成。未知版本永远 false。
    pub force_allowed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct JianyingDraftResult {
    pub status: String,
    pub output_path: String,
    pub draft_name: String,
    pub jianying_version: String,
    pub selected_count: u64,
    pub subtitle_count: u64,
    /// R14 C-2:写进草稿的章节标记数(每章首镜 material_name 前缀);0 = 镜头带没有章。
    pub chapter_marks: u64,
    /// R14 C-3:是否带了配乐轨(`tracks[1]` audio)。
    pub has_music: bool,
    pub message: String,
    /// R14 §9 A:这份草稿是对「待验证」版本 force 出来的,剪映能不能开还要人眼确认。
    pub experimental: bool,
    /// 与 `output_path` 同值;试验卡按这个名字读。
    pub draft_path: String,
    /// R24 D-1:这次是否打开了「字幕写进时间线(试验)」。
    pub subtitles_on_timeline: bool,
    /// R24 D-1:写进剪映文字轨的字幕条数(= `TripCut字幕/时间线字幕.srt` 的条数);开关关时恒为 0。
    pub timeline_subtitle_count: u64,
}

#[derive(Debug, Clone)]
struct DraftInput {
    clip_id: i64,
    file_name: String,
    source_path: PathBuf,
    in_ticks: i64,
    out_ticks: i64,
    tb_num: i64,
    tb_den: i64,
    width: i64,
    height: i64,
    srt_source: Option<PathBuf>,
    /// R3 Task 6：转录实际用了哪一路音轨（人话映射见 `audio_track_note`）。
    selected_transcribe_track: Option<i64>,
    /// R3 Task 6：这条素材全部音轨，按 `stream_index` 升序。
    audio_tracks: Vec<deliver::ExportAudioTrack>,
    /// R6 Task 7b：`clips.manual_rotation`——只在 rotate 标签兜底命中(没有
    /// side_data 显示矩阵)时非空。写入 segment 的 `clip.rotation`(11.3.0
    /// 金样已有此键，见 `build_draft` 里的 `clip` json blob，不新增键)。
    manual_rotation: Option<i64>,
    /// R14 C-2:镜头带上这条素材所属章节的标题(叙事章优先,其次手动章);空串 = 不属于任何章。
    chapter_title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CanvasConfig {
    background: Option<Value>,
    height: i64,
    ratio: String,
    width: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DraftInfo {
    canvas_config: CanvasConfig,
    duration: i64,
    fps: f64,
    id: String,
    materials: DraftMaterials,
    name: String,
    new_version: String,
    tracks: Vec<DraftTrack>,
    version: i64,
    #[serde(flatten)]
    template_fields: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DraftMaterials {
    #[serde(default)]
    audios: Vec<DraftAudioMaterial>,
    #[serde(default)]
    speeds: Vec<Value>,
    #[serde(default)]
    videos: Vec<DraftVideoMaterial>,
    #[serde(flatten)]
    other: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DraftVideoMaterial {
    audio_fade: Option<Value>,
    category_id: String,
    category_name: String,
    check_flag: i64,
    crop: Value,
    crop_ratio: String,
    crop_scale: f64,
    duration: i64,
    height: i64,
    id: String,
    local_material_id: String,
    material_id: String,
    material_name: String,
    media_path: String,
    path: String,
    #[serde(rename = "type")]
    material_type: String,
    width: i64,
}

/// R14 C-3:配乐素材。11.3.0 金样里 `materials.audios` 是空数组,元素形状取自
/// pyJianYingDraft `AudioMaterial.export_json()`(GuanYixuan/pyJianYingDraft,
/// `local_materials.py`;同文件的 `VideoMaterial` 键集与本模块 `DraftVideoMaterial`
/// 逐键一致,故信其 audio 形状)。`type` 用 `extract_music`(本地导入音乐在剪映里的类型)。
/// 只引用原文件绝对路径,不复制——与视频素材同策略。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct DraftAudioMaterial {
    app_id: i64,
    category_id: String,
    category_name: String,
    check_flag: i64,
    copyright_limit_type: String,
    duration: i64,
    effect_id: String,
    formula_id: String,
    id: String,
    local_material_id: String,
    music_id: String,
    name: String,
    path: String,
    source_platform: i64,
    #[serde(rename = "type")]
    material_type: String,
    wave_points: Vec<Value>,
}

/// R14 C-3:本集选用的配乐——来自 `music_tracks`,已解析成绝对路径与微秒时长。
#[derive(Debug, Clone, PartialEq, Eq)]
struct DraftMusic {
    file_name: String,
    source_path: PathBuf,
    duration_us: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DraftTrack {
    attribute: i64,
    flag: i64,
    id: String,
    is_default_name: bool,
    name: String,
    segments: Vec<DraftSegment>,
    #[serde(rename = "type")]
    track_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DraftSegment {
    common_keyframes: Vec<Value>,
    enable_adjust: bool,
    enable_color_correct_adjust: bool,
    enable_color_curves: bool,
    enable_color_match_adjust: bool,
    enable_color_wheels: bool,
    enable_lut: bool,
    /// R24 D-1:只有文字段写(pyJianYingDraft 0.3.0 `segment.py:64`);视频/配乐段不写这个键,保持 0.11.4 形状。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enable_smart_color_adjust: Option<bool>,
    extra_material_refs: Vec<String>,
    id: String,
    is_tone_modify: bool,
    keyframe_refs: Vec<Value>,
    last_nonzero_volume: f64,
    material_id: String,
    render_index: i64,
    reverse: bool,
    /// 视频/配乐段必有;R24 D-1 文字段是 `null`(pyJianYingDraft 0.3.0 `segment.py:211`,
    /// `TextSegment` 构造时 source_timerange=None,`text_segment.py:296`)。`Some` 序列化与旧版逐字节相同。
    source_timerange: Option<DraftTimerange>,
    speed: f64,
    target_timerange: DraftTimerange,
    track_attribute: i64,
    track_render_index: i64,
    visible: bool,
    volume: f64,
    clip: Value,
    /// 视频段必有;音频段没有这个键(pyJianYingDraft `AudioSegment` 只写 `clip: null`)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    uniform_scale: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct DraftTimerange {
    duration: i64,
    start: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DraftMetaInfo {
    draft_fold_path: String,
    draft_id: String,
    draft_json_file: String,
    draft_name: String,
    draft_new_version: String,
    tm_draft_create: i64,
    tm_draft_modified: i64,
    tm_duration: i64,
    #[serde(flatten)]
    template_fields: BTreeMap<String, Value>,
}

struct StagingGuard {
    path: PathBuf,
    promoted: bool,
}

impl Drop for StagingGuard {
    fn drop(&mut self) {
        if !self.promoted {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

/// R6 Task 2 真机金丝雀用：把内嵌的 11.3.0 `template.tmp` 金样解析成键集合，
/// 供集成测试与磁盘上真实剪映草稿的 `template.tmp` 逐键比对。不读取、不复制
/// 用户草稿——这里只暴露我们自己内嵌模板的键集。
pub fn golden_key_sets() -> (BTreeSet<String>, BTreeSet<String>) {
    let value: Value = serde_json::from_str(DRAFT_TEMPLATE_11_3_0)
        .expect("embedded 11.3.0 draft template must be valid JSON");
    let top_level = value
        .as_object()
        .expect("golden template top level must be a JSON object")
        .keys()
        .cloned()
        .collect();
    let materials = value
        .get("materials")
        .and_then(Value::as_object)
        .expect("golden template must have a materials object")
        .keys()
        .cloned()
        .collect();
    (top_level, materials)
}

pub fn availability(connection: &Connection) -> JianyingAvailability {
    let version = read_editor_version(Path::new(JIANYING_APP_PLIST));
    let draft_root_exists = default_draft_root().is_ok_and(|root| root.is_dir());
    let human_check = match &version {
        Ok(version) => human_check_from_settings(connection, version).unwrap_or(HumanCheck::None),
        Err(_) => HumanCheck::None,
    };
    availability_from(version, draft_root_exists, human_check)
}

/// 读 settings 里对某版本的人眼裁定;没记过 / 表还没建 = `None`。
pub fn human_check_from_settings(connection: &Connection, version: &str) -> Result<HumanCheck> {
    let key = format!("{HUMAN_CHECK_PREFIX}{version}");
    Ok(super::settings::setting_value(connection, &key)?
        .and_then(|value| HumanCheck::parse(&value))
        .unwrap_or(HumanCheck::None))
}

/// 「可以用」/「打不开」落盘。只接受待验证名单里的版本 —— 未知版本连 fail 也不记,
/// 免得一条设置行就把白名单绕过去。
pub fn set_human_check(connection: &Connection, version: &str, verdict: HumanCheck) -> Result<()> {
    if !JIANYING_VERSIONS_PENDING_HUMAN_CHECK.contains(&version) {
        return Err(CoreError::Jianying(format!(
            "剪映 {version} 不在待验证名单里,不能记录人工验证结果"
        )));
    }
    let key = format!("{HUMAN_CHECK_PREFIX}{version}");
    super::settings::set_setting(connection, &key, verdict.as_str())
}

/// `force = true` 只对「待验证」版本放行(未知版本仍拒绝);草稿一律新名字,永不覆盖。
/// R24 D-1:`subtitles_on_timeline` = 导出抽屉「字幕写进时间线(试验)」开关,默认关;关时产物与 0.11.4 逐字节一致。
pub fn generate_native_draft(
    connection: &mut Connection,
    force: bool,
    subtitles_on_timeline: bool,
) -> Result<JianyingDraftResult> {
    let status = availability(connection);
    let root = default_draft_root()?;
    generate_with_availability(connection, &status, &root, force, subtitles_on_timeline)
}

fn generate_with_availability(
    connection: &mut Connection,
    status: &JianyingAvailability,
    root: &Path,
    force: bool,
    subtitles_on_timeline: bool,
) -> Result<JianyingDraftResult> {
    let experimental = !status.usable;
    if experimental && !(force && status.force_allowed) {
        return Err(CoreError::Jianying(format!(
            "{}；已停止原生草稿路径，请改用稳定交付包",
            status.reason
        )));
    }
    let version = status
        .installed_version
        .clone()
        .ok_or_else(|| CoreError::Jianying("无法确认剪映版本".to_owned()))?;
    let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let episode_id: i64 = transaction
        .query_row(
            "SELECT id FROM episodes WHERE status = 'active'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| CoreError::Jianying("没有进行中的 Episode，无法生成草稿".to_owned()))?;
    // R14 C-1:草稿目录/名字用集名(经 `draft_folder_name` 清洗),不再固定「旅剪项目」。
    let episode_title: String = transaction
        .query_row("SELECT title FROM episodes WHERE id = ?1", [episode_id], |row| row.get(0))
        .unwrap_or_default();
    let mut clips = deliver::selected_clips(&transaction)?;
    clips.retain(|clip| clip.media_kind != "photo");
    // R3 Task 3:草稿画布来自集的目标平台预设,不再取首条素材的原始尺寸——
    // `both` 朝向在这里折成 `landscape`(横竖同时制作,草稿按横版画布)。
    // 原生草稿没有交付层的 override 入口,永远读集自己的 target_platform。
    let (canvas_width, canvas_height) = super::platform::resolve_platform(&transaction, episode_id, None)?.canvas();
    // R14 C-3:本集配乐(最近导入的一首;没有就只写视频轨)。
    let music = selected_music(&transaction, episode_id)?;
    transaction.commit()?;
    if clips.is_empty() {
        return Err(CoreError::Jianying(
            "当前没有精选段或收藏素材，无法生成剪映草稿".to_owned(),
        ));
    }

    resolve_draft_sources(connection, &mut clips)?;
    let inputs = draft_inputs(connection, &clips)?;
    let (_, chapter_marks) = chapter_prefixes(&inputs);
    let now = unix_timestamp()?;
    let draft_id = Uuid::new_v4().to_string().to_uppercase();
    let short_id = draft_id.chars().filter(|ch| *ch != '-').take(8).collect::<String>();
    let draft_name = draft_folder_name(&episode_title, experimental, now, &short_id);
    let final_path = root.join(&draft_name);
    let (draft, cues) = assemble_draft(
        &draft_name,
        &draft_id,
        &inputs,
        now,
        (canvas_width, canvas_height),
        music.as_ref(),
        subtitles_on_timeline,
    )?;
    let meta = build_meta(&draft, &final_path, now)?;
    let subtitle_count = write_draft_atomically(root, &final_path, &draft, &meta, &inputs, &cues)?;

    let mut manifest = json!({
        "schema": {"new_version": draft.new_version.clone(), "version": draft.version},
        "jianying_version": version.clone(),
        "self_check": "passed",
        "experimental": experimental,
        "selected_count": inputs.len(),
        "subtitle_count": subtitle_count,
        "chapter_marks": chapter_marks,
        "has_music": music.is_some(),
        "music_path": music.as_ref().map(|track| track.source_path.to_string_lossy().into_owned()),
        "output_path": final_path.to_string_lossy().into_owned(),
        "source_paths": inputs.iter().map(|input| input.source_path.to_string_lossy().into_owned()).collect::<Vec<_>>()
    });
    if subtitles_on_timeline {
        manifest["subtitles_on_timeline"] = json!(true);
        manifest["timeline_subtitle_count"] = json!(cues.len());
    }
    if let Err(error) = connection.execute(
        "INSERT INTO exports(tier, manifest, created_at, output_path, episode_id)
         VALUES ('native_draft', ?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?2, ?3)",
        params![
            manifest.to_string(),
            final_path.to_string_lossy().into_owned(),
            episode_id
        ],
    ) {
        let _ = std::fs::remove_dir_all(&final_path);
        return Err(CoreError::Jianying(format!(
            "草稿审计写入失败，已清理本次新草稿：{error}"
        )));
    }

    let output_path = final_path.to_string_lossy().into_owned();
    Ok(JianyingDraftResult {
        status: "created".to_owned(),
        draft_path: output_path.clone(),
        output_path,
        draft_name,
        jianying_version: version,
        selected_count: inputs.len() as u64,
        subtitle_count,
        chapter_marks,
        has_music: music.is_some(),
        message: if experimental {
            "试验草稿已写出;打开剪映,在「本地草稿」里找它,能打开就回来点「可以用」".to_owned()
        } else {
            "草稿已生成；请回到剪映首页，在“本地草稿”中打开并核对素材顺序与入出点".to_owned()
        },
        experimental,
        subtitles_on_timeline,
        timeline_subtitle_count: cues.len() as u64,
    })
}

fn availability_from(
    version: std::result::Result<String, String>,
    draft_root_exists: bool,
    human_check: HumanCheck,
) -> JianyingAvailability {
    let unavailable = |installed_version: Option<String>, reason: String, force_allowed: bool| JianyingAvailability {
        installed_version,
        supported: false,
        reason,
        whitelisted: false,
        human_check,
        usable: false,
        force_allowed,
    };
    match version {
        Ok(version) if !draft_root_exists => unavailable(
            Some(version),
            "未找到剪映草稿根目录；请先在剪映中创建一份本地草稿".to_owned(),
            false,
        ),
        Ok(version) => {
            let whitelisted = SUPPORTED_JIANYING_VERSIONS.contains(&version.as_str());
            let pending = JIANYING_VERSIONS_PENDING_HUMAN_CHECK.contains(&version.as_str());
            let usable = whitelisted || (pending && human_check == HumanCheck::Ok);
            let reason = if whitelisted {
                format!("剪映 {version} 已通过明文空草稿金丝雀，可生成实验草稿")
            } else if usable {
                format!("剪映 {version} 已确认可用(你在剪映里打开过试验草稿)")
            } else if pending && human_check == HumanCheck::Fail {
                format!("上次生成的试验草稿在剪映 {version} 里打不开;可以再试一次,或改用「导出片段」")
            } else if pending {
                format!("这个剪映版本({version})还没核对过;可以试着生成一份草稿,再到剪映里看能不能打开")
            } else {
                format!(
                    "这个剪映版本({version})还没核对过(已核对:{});本次改为输出稳定包,不写草稿",
                    SUPPORTED_JIANYING_VERSIONS.join("、")
                )
            };
            JianyingAvailability {
                installed_version: Some(version),
                supported: usable,
                reason,
                whitelisted,
                human_check,
                usable,
                force_allowed: pending,
            }
        }
        Err(reason) => unavailable(None, format!("无法读取剪映版本：{reason}；原生草稿已禁用"), false),
    }
}

fn read_editor_version(plist: &Path) -> std::result::Result<String, String> {
    if !plist.is_file() {
        return Err(format!("未找到 {}", plist.display()));
    }
    let output = Command::new("/usr/libexec/PlistBuddy")
        .arg("-c")
        .arg("Print :CFBundleShortVersionString")
        .arg(plist)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法执行 PlistBuddy：{error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if detail.is_empty() {
            "Info.plist 缺少 CFBundleShortVersionString".to_owned()
        } else {
            detail
        });
    }
    let version = String::from_utf8(output.stdout)
        .map_err(|_| "CFBundleShortVersionString 不是 UTF-8".to_owned())?
        .trim()
        .to_owned();
    if version.is_empty() {
        Err("CFBundleShortVersionString 为空".to_owned())
    } else {
        Ok(version)
    }
}

/// R14 C-1:集名 → 草稿文件夹名。路径分隔符/冒号/控制字符换成 `_`,首尾空白去掉,
/// 超过 [`DRAFT_NAME_TITLE_MAX_CHARS`] 截断;清洗后为空(集名全是非法字符)才退回「旅剪项目」。
/// 末尾仍带 8 位短 id,同名集多次生成也不会撞目录(`write_draft_atomically` 拒绝覆盖)。
/// R14 A+C 合流:集名打底;试验草稿再带「试验 + 秒级时间戳」,业主在剪映草稿列表里一眼能认出哪份是刚写的。
fn draft_folder_name(episode_title: &str, experimental: bool, now: i64, short_id: &str) -> String {
    let cleaned = episode_title
        .trim()
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' => '_',
            other if other.is_control() => '_',
            other => other,
        })
        .take(DRAFT_NAME_TITLE_MAX_CHARS)
        .collect::<String>();
    let cleaned = cleaned.trim_matches(['_', ' ', '.']);
    let title = if cleaned.is_empty() { PROJECT_NAME } else { cleaned };
    if experimental {
        format!("{title}_剪映草稿_试验_{now}_{short_id}")
    } else {
        format!("{title}_剪映草稿_{short_id}")
    }
}

fn default_draft_root() -> Result<PathBuf> {
    draft_root_from(
        std::env::var_os("HOME"),
        std::env::var_os("TRIPCUT_JIANYING_DRAFT_ROOT"),
    )
}

fn draft_root_from(
    home: Option<std::ffi::OsString>,
    qa_override: Option<std::ffi::OsString>,
) -> Result<PathBuf> {
    if let Some(root) = qa_override.filter(|value| !value.is_empty()) {
        let root = PathBuf::from(root);
        if !root.is_absolute() {
            return Err(CoreError::Jianying(
                "TRIPCUT_JIANYING_DRAFT_ROOT 必须是绝对路径".to_owned(),
            ));
        }
        return Ok(root);
    }
    let home = home.ok_or_else(|| {
        CoreError::Jianying("HOME 未设置，无法定位剪映草稿根目录".to_owned())
    })?;
    Ok(PathBuf::from(home)
        .join("Movies")
        .join("JianyingPro")
        .join("User Data")
        .join("Projects")
        .join("com.lveditor.draft"))
}

fn draft_inputs(connection: &Connection, clips: &[ExportClip]) -> Result<Vec<DraftInput>> {
    let cache_root = connection
        .path()
        .map(|path| super::artifacts::cache_root_for_db(Path::new(path)));
    clips
        .iter()
        .map(|clip| {
            let source = PathBuf::from(&clip.source_path);
            if !source.is_absolute() {
                return Err(CoreError::Jianying(format!(
                    "素材路径不是绝对路径，拒绝写入草稿：{}",
                    source.display()
                )));
            }
            let source = source.canonicalize().map_err(|error| {
                CoreError::Jianying(format!("无法读取原片 {}：{error}", source.display()))
            })?;
            if !source.is_file() {
                return Err(CoreError::Jianying(format!(
                    "原片不是普通文件：{}",
                    source.display()
                )));
            }
            let tb_num = clip.tb_num.filter(|value| *value > 0).ok_or_else(|| {
                CoreError::Jianying(format!("{} 缺少有效 time_base 分子", clip.file_name))
            })?;
            let tb_den = clip.tb_den.filter(|value| *value > 0).ok_or_else(|| {
                CoreError::Jianying(format!("{} 缺少有效 time_base 分母", clip.file_name))
            })?;
            let in_ticks = clip.in_ticks.unwrap_or(0);
            let out_ticks = clip.out_ticks.ok_or_else(|| {
                CoreError::Jianying(format!("{} 缺少素材出点", clip.file_name))
            })?;
            if in_ticks < 0 || out_ticks <= in_ticks {
                return Err(CoreError::Jianying(format!(
                    "{} 的入出点无效：{in_ticks}..{out_ticks}",
                    clip.file_name
                )));
            }
            let srt_source = match (&cache_root, clip.srt_rel_path.as_deref()) {
                (Some(cache_root), Some(relative)) => {
                    let expected = PathBuf::from(clip.clip_id.to_string())
                        .join(super::transcribe::SRT_FILE);
                    (Path::new(relative) == expected.as_path())
                        .then(|| cache_root.join(expected))
                        .filter(|path| path.is_file())
                }
                _ => None,
            };
            Ok(DraftInput {
                clip_id: clip.clip_id,
                file_name: clip.file_name.clone(),
                source_path: source,
                in_ticks,
                out_ticks,
                tb_num,
                tb_den,
                width: clip.width.unwrap_or(1920).max(1),
                height: clip.height.unwrap_or(1080).max(1),
                srt_source,
                selected_transcribe_track: clip.selected_transcribe_track,
                audio_tracks: clip.audio_tracks.clone(),
                manual_rotation: clip.manual_rotation,
                chapter_title: clip.chapter_title.clone(),
            })
        })
        .collect()
}

/// R14 C-3:本集的配乐。音乐面板的「选中」只是前端状态、没有落库,所以这里取
/// **最近导入**的一首(`music_tracks` 按 id 最大,即面板列表里最后一条)。没有音乐、
/// 导入时没探到时长、或原文件已不在 → `None`,草稿只写视频轨(不报错、不猜时长)。
fn selected_music(connection: &Connection, episode_id: i64) -> Result<Option<DraftMusic>> {
    let row: Option<(String, String, Option<i64>, i64, i64)> = connection
        .query_row(
            "SELECT file_name, rel_path, duration_ticks, tb_num, tb_den
               FROM music_tracks WHERE episode_id = ?1
              ORDER BY id DESC LIMIT 1",
            [episode_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    let Some((file_name, rel_path, duration_ticks, tb_num, tb_den)) = row else {
        return Ok(None);
    };
    let Some(duration_ticks) = duration_ticks.filter(|value| *value > 0) else {
        return Ok(None);
    };
    let source = PathBuf::from(&rel_path);
    if !source.is_absolute() {
        return Ok(None);
    }
    let Ok(source_path) = source.canonicalize() else {
        return Ok(None);
    };
    if !source_path.is_file() {
        return Ok(None);
    }
    let duration_us = ticks_to_microseconds(duration_ticks, tb_num, tb_den)?;
    Ok(Some(DraftMusic {
        file_name,
        source_path,
        duration_us,
    }))
}

/// J-05:剪映素材包要「本集有没有配乐、原文件在哪」,不需要草稿那份微秒时长——直接包一层
/// [`selected_music`],不重复它的查询/校验逻辑(最近一条、探到时长、原文件还在)。
pub(crate) fn kit_selected_music_file(connection: &Connection, episode_id: i64) -> Result<Option<(String, PathBuf)>> {
    Ok(selected_music(connection, episode_id)?.map(|music| (music.file_name, music.source_path)))
}

fn resolve_draft_sources(connection: &Connection, clips: &mut [ExportClip]) -> Result<()> {
    for clip in clips {
        clip.source_path = deliver::verified_export_source(connection, clip)?
            .to_string_lossy()
            .into_owned();
    }
    Ok(())
}

fn ticks_to_microseconds(ticks: i64, tb_num: i64, tb_den: i64) -> Result<i64> {
    if ticks < 0 || tb_num <= 0 || tb_den <= 0 {
        return Err(CoreError::Jianying(format!(
            "无法换算无效时间值 ticks={ticks}, time_base={tb_num}/{tb_den}"
        )));
    }
    let numerator = i128::from(ticks)
        .checked_mul(i128::from(tb_num))
        .and_then(|value| value.checked_mul(1_000_000))
        .ok_or_else(|| CoreError::Jianying("时间换算溢出".to_owned()))?;
    let rounded = numerator
        .checked_add(i128::from(tb_den) / 2)
        .ok_or_else(|| CoreError::Jianying("时间换算溢出".to_owned()))?
        / i128::from(tb_den);
    i64::try_from(rounded).map_err(|_| CoreError::Jianying("时间换算超出 i64".to_owned()))
}

/// R3 Task 6：草稿模板没有独立的音频素材条目——原片自带的音轨随视频素材一起
/// 进 `materials.videos`，剪映读取时按容器里的默认音轨播放，不知道 TripCut
/// 转录用的是哪一路。11.3.0 模板的 `DraftVideoMaterial` 没有能塞新字段的地方
/// （多余键会被剪映拒绝），所以把映射写进已有的 `material_name` 字符串字段，
/// 追加在文件名后面，剪映和人都能照常读——这是本 Task 选定的落点，不新增 JSON 键。
fn audio_track_material_name(input: &DraftInput) -> String {
    if input.audio_tracks.len() < 2 {
        return input.file_name.clone();
    }
    let transcribe_track = input.selected_transcribe_track.unwrap_or(0);
    let mapping = input
        .audio_tracks
        .iter()
        .map(|track| {
            let label = deliver::audio_role_label(track.role_guess.as_deref());
            if track.stream_index == transcribe_track {
                format!("{}={label}(转录)", track.stream_index)
            } else {
                format!("{}={label}", track.stream_index)
            }
        })
        .collect::<Vec<_>>()
        .join("/");
    format!("{} [音轨映射 {mapping}]", input.file_name)
}

/// R14 C-2:章节标记。11.3.0 金样里 `materials.time_marks` 是空数组、顶层 `time_marks`
/// 是 null,元素结构无从比对(pyJianYingDraft 也不建模它),写一个猜出来的元素会让剪映
/// 拒开整份草稿——所以退化到与 R3 音轨映射同一落点:每章**第一个**镜的 `material_name`
/// 前缀「【第 n 章·章名】」,剪映素材面板和人都能读,不新增 JSON 键。
/// 前缀只落在**镜头带顺序上同一章连续一段的第一个镜**;章的序号按「第几个见到的章」数,
/// 同一章再出现也沿用同一个号(V14-04:以前按连续段落计数,同一章被拆成两段就冒出两个号)。
/// 自动章名本身已带「第 n 章 · …」时只包一层 `【章名】`,不再在前面叠一个「第 m 章·」
/// (真机曾出现「【第 1 章·第 7 章 · 14:40-14:40】」)。空标题不算章。
/// 返回每条输入的前缀(无前缀为空串)与章数(不同的章名个数)。
fn chapter_prefixes(inputs: &[DraftInput]) -> (Vec<String>, u64) {
    let mut prefixes = Vec::with_capacity(inputs.len());
    let mut seen_titles: Vec<&str> = Vec::new();
    let mut previous: Option<&str> = None;
    for input in inputs {
        let title = input.chapter_title.trim();
        if title.is_empty() {
            prefixes.push(String::new());
            previous = None;
            continue;
        }
        let ordinal = match seen_titles.iter().position(|seen| *seen == title) {
            Some(index) => index + 1,
            None => {
                seen_titles.push(title);
                seen_titles.len()
            }
        };
        if previous != Some(title) {
            prefixes.push(chapter_prefix(ordinal, title));
        } else {
            prefixes.push(String::new());
        }
        previous = Some(title);
    }
    (prefixes, seen_titles.len() as u64)
}

/// 「【第 n 章·章名】」;章名自己已经是「第 n 章 …」开头时只包「【章名】」。
fn chapter_prefix(ordinal: usize, title: &str) -> String {
    if title_carries_ordinal(title) {
        format!("【{title}】")
    } else {
        format!("【第 {ordinal} 章·{title}】")
    }
}

/// 自动章名的形态「第 7 章 · 14:40-14:40」:「第」+ 数字 +「章」开头。
fn title_carries_ordinal(title: &str) -> bool {
    let Some(rest) = title.strip_prefix('第') else { return false };
    let Some((number, _)) = rest.split_once('章') else { return false };
    let number = number.trim();
    !number.is_empty() && number.chars().all(|character| character.is_ascii_digit())
}

/// 无配乐的草稿(既有测试的入口);生产路径走 [`build_draft_with_music`]。
#[cfg(test)]
fn build_draft(
    name: &str,
    draft_id: &str,
    inputs: &[DraftInput],
    now: i64,
    canvas_width: i64,
    canvas_height: i64,
) -> Result<DraftInfo> {
    build_draft_with_music(name, draft_id, inputs, now, canvas_width, canvas_height, None)
}

/// R14 C-3:`build_draft` + 可选配乐轨。有音乐 → `materials.audios` 一条 + `tracks[1]`
/// 一条 `audio` 轨,入点 0、时长 = min(音乐时长, 视频轨总时长);无音乐 → 与 `build_draft` 相同。
fn build_draft_with_music(
    name: &str,
    draft_id: &str,
    inputs: &[DraftInput],
    now: i64,
    canvas_width: i64,
    canvas_height: i64,
    music: Option<&DraftMusic>,
) -> Result<DraftInfo> {
    let mut draft: DraftInfo = serde_json::from_str(DRAFT_TEMPLATE_11_3_0)
        .map_err(|error| CoreError::Jianying(format!("内嵌草稿模板无效：{error}")))?;
    if inputs.is_empty() {
        return Err(CoreError::Jianying("没有可写入草稿的精选素材".to_owned()));
    }
    // R3 Task 3:画布尺寸来自集的目标平台预设(已按朝向解析),不再取首条素材
    // 的原始分辨率——平台预设与真实素材宽高比无关,不应受哪条素材排第一影响。
    draft.canvas_config.width = canvas_width;
    draft.canvas_config.height = canvas_height;
    draft.id = draft_id.to_owned();
    draft.name = name.to_owned();
    draft.new_version = SCHEMA_NEW_VERSION.to_owned();
    draft.version = SCHEMA_VERSION;
    draft.template_fields.insert("create_time".to_owned(), json!(now));
    draft.template_fields.insert("update_time".to_owned(), json!(now));

    let (chapter_prefixes, _) = chapter_prefixes(inputs);
    let mut target_start = 0_i64;
    let mut segments = Vec::with_capacity(inputs.len());
    for (input, chapter_prefix) in inputs.iter().zip(chapter_prefixes) {
        let source_start = ticks_to_microseconds(input.in_ticks, input.tb_num, input.tb_den)?;
        let source_end = ticks_to_microseconds(input.out_ticks, input.tb_num, input.tb_den)?;
        let duration = source_end.checked_sub(source_start).filter(|value| *value > 0).ok_or_else(
            || CoreError::Jianying(format!("{} 换算后的精选段时长无效", input.file_name)),
        )?;
        let material_id = Uuid::new_v4().simple().to_string();
        let speed_id = Uuid::new_v4().simple().to_string();
        let segment_id = Uuid::new_v4().simple().to_string();
        draft.materials.videos.push(DraftVideoMaterial {
            audio_fade: None,
            category_id: String::new(),
            category_name: "local".to_owned(),
            check_flag: 63_487,
            crop: json!({"upper_left_x":0.0,"upper_left_y":0.0,"upper_right_x":1.0,"upper_right_y":0.0,"lower_left_x":0.0,"lower_left_y":1.0,"lower_right_x":1.0,"lower_right_y":1.0}),
            crop_ratio: "free".to_owned(),
            crop_scale: 1.0,
            duration: source_end,
            height: input.height,
            id: material_id.clone(),
            local_material_id: String::new(),
            material_id: material_id.clone(),
            material_name: format!("{chapter_prefix}{}", audio_track_material_name(input)),
            media_path: String::new(),
            path: input.source_path.to_string_lossy().into_owned(),
            material_type: "video".to_owned(),
            width: input.width,
        });
        draft.materials.speeds.push(json!({
            "curve_speed": null,
            "id": speed_id,
            "mode": 0,
            "speed": 1.0,
            "type": "speed"
        }));
        segments.push(DraftSegment {
            common_keyframes: Vec::new(),
            enable_adjust: true,
            enable_color_correct_adjust: false,
            enable_color_curves: true,
            enable_color_match_adjust: false,
            enable_color_wheels: true,
            enable_lut: true,
            enable_smart_color_adjust: None,
            extra_material_refs: vec![speed_id],
            id: segment_id,
            is_tone_modify: false,
            keyframe_refs: Vec::new(),
            last_nonzero_volume: 1.0,
            material_id,
            render_index: 0,
            reverse: false,
            source_timerange: Some(DraftTimerange {
                duration,
                start: source_start,
            }),
            speed: 1.0,
            target_timerange: DraftTimerange {
                duration,
                start: target_start,
            },
            track_attribute: 0,
            track_render_index: 0,
            visible: true,
            volume: 1.0,
            clip: json!({"alpha":1.0,"flip":{"horizontal":false,"vertical":false},"rotation":input.manual_rotation.unwrap_or(0) as f64,"scale":{"x":1.0,"y":1.0},"transform":{"x":0.0,"y":0.0}}),
            uniform_scale: Some(json!({"on":true,"value":1.0})),
        });
        target_start = target_start
            .checked_add(duration)
            .ok_or_else(|| CoreError::Jianying("草稿总时长溢出".to_owned()))?;
    }
    draft.duration = target_start;
    draft.tracks = vec![DraftTrack {
        attribute: 0,
        flag: 0,
        id: Uuid::new_v4().simple().to_string(),
        is_default_name: true,
        name: String::new(),
        segments,
        track_type: "video".to_owned(),
    }];
    if let Some(music) = music {
        append_music_track(&mut draft, music)?;
    }
    validate_draft(&draft, inputs.len())?;
    Ok(draft)
}

/// 生产路径的草稿组装:`build_draft_with_music`,开关开时再加文字轨(R24 D-1)。
/// 开关关、或开了但没有一条落在精选段里的字幕 → 草稿与 0.11.4 完全相同,返回空字幕表。
fn assemble_draft(
    name: &str,
    draft_id: &str,
    inputs: &[DraftInput],
    now: i64,
    (canvas_width, canvas_height): (i64, i64),
    music: Option<&DraftMusic>,
    subtitles_on_timeline: bool,
) -> Result<(DraftInfo, Vec<text::TimelineCue>)> {
    let mut draft = build_draft_with_music(name, draft_id, inputs, now, canvas_width, canvas_height, music)?;
    if !subtitles_on_timeline {
        return Ok((draft, Vec::new()));
    }
    let cues = text::timeline_cues(inputs, &draft)?;
    if !cues.is_empty() {
        text::insert_subtitle_track(&mut draft, &cues)?;
        validate_draft(&draft, inputs.len())?;
    }
    Ok((draft, cues))
}

fn append_music_track(draft: &mut DraftInfo, music: &DraftMusic) -> Result<()> {
    if !music.source_path.is_absolute() {
        return Err(CoreError::Jianying("配乐路径不是绝对路径,拒绝写入草稿".to_owned()));
    }
    let duration = music.duration_us.min(draft.duration);
    if duration <= 0 {
        return Err(CoreError::Jianying(format!("配乐 {} 的时长无效", music.file_name)));
    }
    let material_id = Uuid::new_v4().simple().to_string();
    draft.materials.audios.push(DraftAudioMaterial {
        app_id: 0,
        category_id: String::new(),
        category_name: "local".to_owned(),
        check_flag: 3,
        copyright_limit_type: "none".to_owned(),
        duration: music.duration_us,
        effect_id: String::new(),
        formula_id: String::new(),
        id: material_id.clone(),
        local_material_id: material_id.clone(),
        music_id: material_id.clone(),
        name: music.file_name.clone(),
        path: music.source_path.to_string_lossy().into_owned(),
        source_platform: 0,
        material_type: "extract_music".to_owned(),
        wave_points: Vec::new(),
    });
    draft.tracks.push(DraftTrack {
        attribute: 0,
        flag: 0,
        id: Uuid::new_v4().simple().to_string(),
        is_default_name: true,
        name: String::new(),
        segments: vec![DraftSegment {
            common_keyframes: Vec::new(),
            enable_adjust: false,
            enable_color_correct_adjust: false,
            enable_color_curves: true,
            enable_color_match_adjust: false,
            enable_color_wheels: true,
            enable_lut: false,
            enable_smart_color_adjust: None,
            extra_material_refs: Vec::new(),
            id: Uuid::new_v4().simple().to_string(),
            is_tone_modify: false,
            keyframe_refs: Vec::new(),
            last_nonzero_volume: 1.0,
            material_id,
            render_index: 0,
            reverse: false,
            source_timerange: Some(DraftTimerange { duration, start: 0 }),
            speed: 1.0,
            target_timerange: DraftTimerange { duration, start: 0 },
            track_attribute: 0,
            track_render_index: 0,
            visible: true,
            volume: 1.0,
            clip: Value::Null,
            uniform_scale: None,
        }],
        track_type: "audio".to_owned(),
    });
    Ok(())
}

fn build_meta(draft: &DraftInfo, final_path: &Path, now: i64) -> Result<DraftMetaInfo> {
    let mut meta: DraftMetaInfo = serde_json::from_str(META_TEMPLATE)
        .map_err(|error| CoreError::Jianying(format!("内嵌草稿元数据模板无效：{error}")))?;
    meta.draft_fold_path = final_path.to_string_lossy().into_owned();
    meta.draft_id = draft.id.clone();
    meta.draft_json_file = final_path.join(DRAFT_INFO_FILE).to_string_lossy().into_owned();
    meta.draft_name = draft.name.clone();
    meta.draft_new_version = draft.new_version.clone();
    meta.tm_draft_create = now;
    meta.tm_draft_modified = now;
    meta.tm_duration = draft.duration;
    Ok(meta)
}

fn validate_draft(draft: &DraftInfo, expected_segments: usize) -> Result<()> {
    if draft.new_version != SCHEMA_NEW_VERSION || draft.version != SCHEMA_VERSION {
        return Err(CoreError::Jianying("草稿 schema 版本不匹配".to_owned()));
    }
    if draft.id.is_empty() || draft.name.is_empty() {
        return Err(CoreError::Jianying("草稿 id/name 为空".to_owned()));
    }
    // Nine typed top-level fields + flattened template fields; two typed material buckets
    // + flattened empty buckets. This pins the exact 11.3.0 template.tmp key shape from E0.
    // R14 C-3:audios 也成了类型化桶,所以是 +3。
    if draft.template_fields.len() + 9 != TOP_LEVEL_KEY_COUNT
        || draft.materials.other.len() + 3 != MATERIAL_KEY_COUNT
    {
        return Err(CoreError::Jianying(
            "草稿 schema 键集合与 11.3.0 金样不一致".to_owned(),
        ));
    }
    // R24 D-1:视频轨之后可选一条文字轨(pyJianYingDraft `import_srt` 把文字轨插在最后一条视频轨之后,
    // `_script_file_segments.py:209-219`),再可选一条配乐轨。
    let trailing = draft.tracks.iter().skip(1).map(|track| track.track_type.as_str()).collect::<Vec<_>>();
    if draft.tracks.is_empty()
        || draft.tracks[0].track_type != "video"
        || !matches!(trailing.as_slice(), [] | ["audio"] | ["text"] | ["text", "audio"])
    {
        return Err(CoreError::Jianying("草稿必须以一条视频轨开头,至多再带一条字幕轨与一条配乐轨".to_owned()));
    }
    let segments = &draft.tracks[0].segments;
    if segments.len() != expected_segments || draft.materials.videos.len() != expected_segments {
        return Err(CoreError::Jianying("草稿片段与视频素材数量不一致".to_owned()));
    }
    let material_ids = draft
        .materials
        .videos
        .iter()
        .map(|material| material.id.as_str())
        .collect::<HashSet<_>>();
    let mut expected_start = 0_i64;
    for segment in segments {
        let Some(source) = segment.source_timerange.as_ref() else {
            return Err(CoreError::Jianying("视频片段缺少 source_timerange".to_owned()));
        };
        if segment.target_timerange.start != expected_start
            || segment.target_timerange.duration <= 0
            || source.start < 0
            || source.duration != segment.target_timerange.duration
            || !material_ids.contains(segment.material_id.as_str())
        {
            return Err(CoreError::Jianying(
                "草稿时间线不连续或素材引用无效".to_owned(),
            ));
        }
        expected_start = expected_start
            .checked_add(segment.target_timerange.duration)
            .ok_or_else(|| CoreError::Jianying("草稿总时长溢出".to_owned()))?;
    }
    if draft.duration != expected_start {
        return Err(CoreError::Jianying("草稿 duration 与时间线不一致".to_owned()));
    }
    for material in &draft.materials.videos {
        if !Path::new(&material.path).is_absolute() {
            return Err(CoreError::Jianying("草稿含非绝对原片路径".to_owned()));
        }
    }
    validate_music_track(draft)?;
    text::validate_subtitle_track(draft)
}

/// R14 C-3:配乐轨(若有)必须是 `tracks[1]`、`audio` 类型、恰一段,入点 0,时长在
/// (0, 视频轨总时长] 内,且引用 `materials.audios` 里的一条绝对路径素材;audios 与
/// 配乐轨一一对应(没有轨就不能有孤儿音频素材)。
fn validate_music_track(draft: &DraftInfo) -> Result<()> {
    let audio_track = draft.tracks.iter().skip(1).find(|track| track.track_type == "audio");
    if draft.materials.audios.len() != usize::from(audio_track.is_some()) {
        return Err(CoreError::Jianying("草稿音频素材与配乐轨数量不一致".to_owned()));
    }
    let Some(track) = audio_track else {
        return Ok(());
    };
    if track.segments.len() != 1 {
        return Err(CoreError::Jianying("配乐轨必须是 audio 类型且只含一段".to_owned()));
    }
    let segment = &track.segments[0];
    let material = &draft.materials.audios[0];
    let Some(source) = segment.source_timerange.as_ref() else {
        return Err(CoreError::Jianying("配乐片段缺少 source_timerange".to_owned()));
    };
    if segment.material_id != material.id
        || segment.target_timerange.start != 0
        || source.start != 0
        || segment.target_timerange.duration <= 0
        || segment.target_timerange.duration != source.duration
        || segment.target_timerange.duration > draft.duration
        || segment.target_timerange.duration > material.duration
        || !Path::new(&material.path).is_absolute()
    {
        return Err(CoreError::Jianying("配乐轨时间范围或素材引用无效".to_owned()));
    }
    Ok(())
}

fn validate_written_draft(directory: &Path, expected_segments: usize) -> Result<()> {
    let draft: DraftInfo = serde_json::from_slice(&std::fs::read(directory.join(DRAFT_INFO_FILE))?)
        .map_err(|error| CoreError::Jianying(format!("草稿回读解析失败：{error}")))?;
    validate_draft(&draft, expected_segments)?;
    let meta: DraftMetaInfo =
        serde_json::from_slice(&std::fs::read(directory.join(DRAFT_META_FILE))?)
            .map_err(|error| CoreError::Jianying(format!("草稿元数据回读失败：{error}")))?;
    if meta.draft_id != draft.id
        || meta.draft_name != draft.name
        || meta.tm_duration != draft.duration
        || !meta.draft_json_file.ends_with(DRAFT_INFO_FILE)
    {
        return Err(CoreError::Jianying("草稿元数据与时间线不一致".to_owned()));
    }
    Ok(())
}

fn write_draft_atomically(
    root: &Path,
    final_path: &Path,
    draft: &DraftInfo,
    meta: &DraftMetaInfo,
    inputs: &[DraftInput],
    timeline_cues: &[text::TimelineCue],
) -> Result<u64> {
    let root = root.canonicalize().map_err(|error| {
        CoreError::Jianying(format!("无法打开剪映草稿根 {}：{error}", root.display()))
    })?;
    if !root.is_dir() {
        return Err(CoreError::Jianying("剪映草稿根不是文件夹".to_owned()));
    }
    let final_name = final_path.file_name().ok_or_else(|| {
        CoreError::Jianying("无法生成剪映草稿文件夹名称".to_owned())
    })?;
    let final_path = root.join(final_name);
    if final_path.exists() {
        return Err(CoreError::Jianying(format!(
            "拒绝覆盖既有剪映草稿：{}",
            final_path.display()
        )));
    }

    let staging_path = root.join(format!(".tripcut-staging-{}", Uuid::new_v4().simple()));
    std::fs::create_dir(&staging_path)?;
    let mut staging = StagingGuard {
        path: staging_path.clone(),
        promoted: false,
    };
    std::fs::create_dir(staging_path.join("Resources"))?;
    std::fs::create_dir(staging_path.join(".backup"))?;
    write_json_synced(&staging_path.join(DRAFT_INFO_FILE), draft)?;
    write_json_synced(&staging_path.join(DRAFT_META_FILE), meta)?;

    let subtitle_count = copy_subtitles(&staging_path, inputs)?;
    if !timeline_cues.is_empty() {
        // R24 D-1:与文字轨逐条一致的时间线 SRT;字幕目录此时必已由 copy_subtitles 建好(有字幕才有 cue)。
        write_synced(
            &staging_path.join(SUBTITLE_DIRECTORY).join(text::TIMELINE_SRT_FILE),
            text::timeline_srt(timeline_cues).as_bytes(),
        )?;
    }
    let instructions = delivery_instructions(inputs.len(), subtitle_count, timeline_cues.len());
    write_synced(
        &staging_path.join(DELIVERY_README_FILE),
        instructions.as_bytes(),
    )?;
    validate_written_draft(&staging_path, inputs.len())?;
    std::fs::rename(&staging_path, &final_path)?;
    File::open(&root)?.sync_all()?;
    staging.promoted = true;
    Ok(subtitle_count)
}

fn copy_subtitles(staging_path: &Path, inputs: &[DraftInput]) -> Result<u64> {
    let sources = inputs
        .iter()
        .enumerate()
        .filter_map(|(index, input)| input.srt_source.as_ref().map(|source| (index, input, source)))
        .collect::<Vec<_>>();
    if sources.is_empty() {
        return Ok(0);
    }
    let directory = staging_path.join(SUBTITLE_DIRECTORY);
    std::fs::create_dir(&directory)?;
    for (index, input, source) in &sources {
        let stem = Path::new(&input.file_name)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("subtitle")
            .replace(['/', ':'], "_");
        let name = format!("{:03}_{}_{}.srt", index + 1, stem, input.clip_id);
        write_synced(&directory.join(name), &std::fs::read(source)?)?;
    }
    Ok(sources.len() as u64)
}

fn delivery_instructions(selected_count: usize, subtitle_count: u64, timeline_count: usize) -> String {
    let subtitle_note = if subtitle_count == 0 {
        "本次没有可用转写，因此未创建字幕目录。".to_owned()
    } else if timeline_count > 0 {
        format!(
            "字幕已按精选段入点对到时间线，写成剪映文字轨「{}」（试验，共 {timeline_count} 条），与 {SUBTITLE_DIRECTORY}/{} 逐条一致；{SUBTITLE_DIRECTORY}/ 里另有 {subtitle_count} 份保留原片时间码的标准 SRT。请在剪映里核对字幕位置与断句。",
            text::SUBTITLE_TRACK_NAME,
            text::TIMELINE_SRT_FILE
        )
    } else {
        format!(
            "{SUBTITLE_DIRECTORY}/ 内有 {subtitle_count} 份标准 SRT；字幕没有写入时间线，请在剪映内手动导入并核对。精选段的 SRT 保留原片时间码，必要时需按入点手动校准。"
        )
    };
    format!(
        "旅剪工作台 · 剪映原生草稿（实验）\n\n本草稿含 {selected_count} 个精选段/整条素材，按故事板顺序排列，并直接引用原片绝对路径。\n{subtitle_note}\n\n请在剪映首页“本地草稿”中打开，逐条核对素材顺序、入点、出点和音画。不要移动或断开原片所在磁盘。此功能只验证过剪映 11.3.0；剪映升级后应重新运行金丝雀。\n"
    )
}

fn write_json_synced<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| CoreError::Jianying(format!("无法序列化 {}：{error}", path.display())))?;
    write_synced(path, &bytes)
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn unix_timestamp() -> Result<i64> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| CoreError::Jianying(format!("系统时间早于 UNIX_EPOCH：{error}")))?
        .as_secs();
    i64::try_from(seconds).map_err(|_| CoreError::Jianying("系统时间超出 i64".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, import, ratings, test_support::TestDirectory};

    fn input(name: &str, in_ticks: i64, out_ticks: i64) -> DraftInput {
        DraftInput {
            clip_id: 1,
            file_name: name.to_owned(),
            source_path: PathBuf::from(format!("/Volumes/CARD/{name}")),
            in_ticks,
            out_ticks,
            tb_num: 1,
            tb_den: 1_000,
            width: 3840,
            height: 2160,
            srt_source: None,
            selected_transcribe_track: None,
            audio_tracks: Vec::new(),
            manual_rotation: None,
            chapter_title: String::new(),
        }
    }

    fn music(duration_us: i64) -> DraftMusic {
        DraftMusic {
            file_name: "bgm.mp3".to_owned(),
            source_path: PathBuf::from("/Volumes/CARD/bgm.mp3"),
            duration_us,
        }
    }

    fn build_with_music(inputs: &[DraftInput], music: Option<&DraftMusic>) -> DraftInfo {
        build_draft_with_music("旅剪", "DRAFT-ID", inputs, 10, 1920, 1080, music).unwrap()
    }

    /// R14 C-3:有音乐 → 两条轨(video, audio)+ 一条 audios 素材;键集仍是 11.3.0 金样。
    #[test]
    fn music_adds_an_audio_track_clamped_to_video_duration() {
        let inputs = [input("a.mov", 0, 1_000), input("b.mov", 0, 2_000)];
        let draft = build_with_music(&inputs, Some(&music(10_000_000)));
        assert_eq!(draft.tracks.len(), 2);
        assert_eq!(draft.tracks[1].track_type, "audio");
        assert_eq!(draft.materials.audios.len(), 1);
        let segment = &draft.tracks[1].segments[0];
        assert_eq!(segment.target_timerange, DraftTimerange { start: 0, duration: 3_000_000 });
        assert_eq!(segment.source_timerange, Some(DraftTimerange { start: 0, duration: 3_000_000 }));
        assert_eq!(segment.material_id, draft.materials.audios[0].id);
        assert_eq!(draft.materials.audios[0].duration, 10_000_000);
        assert_eq!(draft.materials.audios[0].path, "/Volumes/CARD/bgm.mp3");
        assert_eq!(draft.duration, 3_000_000);

        let value = serde_json::to_value(&draft).unwrap();
        assert_eq!(value.as_object().unwrap().len(), TOP_LEVEL_KEY_COUNT);
        assert_eq!(value["materials"].as_object().unwrap().len(), MATERIAL_KEY_COUNT);
        let (top, materials) = golden_key_sets();
        assert!(value.as_object().unwrap().keys().all(|key| top.contains(key)));
        assert!(value["materials"].as_object().unwrap().keys().all(|key| materials.contains(key)));
        assert_eq!(value["materials"]["audios"][0]["type"], "extract_music");
        assert_eq!(value["tracks"][1]["segments"][0]["clip"], Value::Null);
        assert!(value["tracks"][1]["segments"][0].get("uniform_scale").is_none());
        assert!(value["tracks"][0]["segments"][0].get("uniform_scale").is_some());
    }

    #[test]
    fn short_music_keeps_its_own_duration() {
        let draft = build_with_music(&[input("a.mov", 0, 5_000)], Some(&music(2_000_000)));
        assert_eq!(draft.tracks[1].segments[0].target_timerange.duration, 2_000_000);
    }

    #[test]
    fn no_music_keeps_a_single_video_track() {
        let draft = build_with_music(&[input("a.mov", 0, 1_000)], None);
        assert_eq!(draft.tracks.len(), 1);
        assert!(draft.materials.audios.is_empty());
    }

    #[test]
    fn readback_rejects_music_track_longer_than_video() {
        let mut draft = build_with_music(&[input("a.mov", 0, 1_000)], Some(&music(5_000_000)));
        draft.tracks[1].segments[0].target_timerange.duration = 2_000_000;
        draft.tracks[1].segments[0].source_timerange.as_mut().unwrap().duration = 2_000_000;
        assert!(validate_draft(&draft, 1).is_err());
        let mut orphan = build_with_music(&[input("a.mov", 0, 1_000)], Some(&music(5_000_000)));
        orphan.tracks.pop();
        assert!(validate_draft(&orphan, 1).is_err());
    }

    #[test]
    fn music_draft_round_trips_through_the_atomic_writer() {
        let root = std::env::temp_dir().join(format!("tripcut-jianying-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let final_path = root.join("music-draft");
        let draft = build_with_music(&[input("a.mov", 0, 1_000)], Some(&music(5_000_000)));
        let meta = build_meta(&draft, &final_path, 10).unwrap();
        write_draft_atomically(&root, &final_path, &draft, &meta, &[input("a.mov", 0, 1_000)], &[]).unwrap();
        let written: DraftInfo =
            serde_json::from_slice(&std::fs::read(final_path.join(DRAFT_INFO_FILE)).unwrap()).unwrap();
        assert_eq!(written.tracks.len(), 2);
        assert_eq!(written.materials.audios[0].name, "bgm.mp3");
        std::fs::remove_dir_all(root).unwrap();
    }

    /// R14 C-3:`selected_music` 取本集最近导入的一首;没探到时长或文件不在 → None。
    #[test]
    fn selected_music_picks_latest_track_with_duration_and_existing_file() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let episode_id: i64 = connection
            .query_row("SELECT id FROM episodes WHERE status = 'active'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(selected_music(&connection, episode_id).unwrap(), None);

        let older = directory.path().join("older.mp3");
        let newer = directory.path().join("newer.mp3");
        std::fs::write(&older, b"older").unwrap();
        std::fs::write(&newer, b"newer").unwrap();
        for (path, duration) in [(&older, Some(4_000_000_i64)), (&newer, Some(9_000_000))] {
            connection
                .execute(
                    "INSERT INTO music_tracks(episode_id, file_name, rel_path, duration_ticks, analysis_status, created_at)
                     VALUES (?1, ?2, ?3, ?4, 'done', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                    params![
                        episode_id,
                        path.file_name().unwrap().to_string_lossy(),
                        path.to_string_lossy(),
                        duration
                    ],
                )
                .unwrap();
        }
        let picked = selected_music(&connection, episode_id).unwrap().unwrap();
        assert_eq!(picked.file_name, "newer.mp3");
        assert_eq!(picked.duration_us, 9_000_000);
        assert_eq!(picked.source_path, newer.canonicalize().unwrap());

        connection
            .execute(
                "INSERT INTO music_tracks(episode_id, file_name, rel_path, duration_ticks, analysis_status, created_at)
                 VALUES (?1, 'missing.mp3', ?2, 1000, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                params![episode_id, directory.path().join("missing.mp3").to_string_lossy()],
            )
            .unwrap();
        assert_eq!(selected_music(&connection, episode_id).unwrap(), None);
    }

    fn chaptered(name: &str, chapter: &str) -> DraftInput {
        let mut clip = input(name, 0, 1_000);
        clip.chapter_title = chapter.to_owned();
        clip
    }

    /// R14 C-2:两章 → 两个前缀,只落在每章第一个镜上;无章的镜不带前缀。
    #[test]
    fn chapter_marks_prefix_first_shot_of_each_chapter() {
        let inputs = [
            chaptered("a.mov", "清晨出发"),
            chaptered("b.mov", "清晨出发"),
            chaptered("c.mov", "海边日落"),
            chaptered("d.mov", ""),
        ];
        let (prefixes, count) = chapter_prefixes(&inputs);
        assert_eq!(count, 2);
        assert_eq!(prefixes, ["【第 1 章·清晨出发】", "", "【第 2 章·海边日落】", ""]);
        let draft = build_draft("旅剪", "DRAFT-ID", &inputs, 10, 1920, 1080).unwrap();
        let names = draft.materials.videos.iter().map(|m| m.material_name.as_str()).collect::<Vec<_>>();
        assert_eq!(names, ["【第 1 章·清晨出发】a.mov", "b.mov", "【第 2 章·海边日落】c.mov", "d.mov"]);
    }

    /// R14 C-2:章前缀与 R3 音轨映射共用 material_name,顺序是「章前缀 + 文件名 + 映射」。
    #[test]
    fn chapter_prefix_composes_with_audio_track_mapping() {
        let mut clip = chaptered("one.mov", "在途");
        clip.audio_tracks = vec![
            deliver::ExportAudioTrack { stream_index: 0, role_guess: Some("onboard_mic".to_owned()) },
            deliver::ExportAudioTrack { stream_index: 1, role_guess: Some("wireless_mic".to_owned()) },
        ];
        let draft = build_draft("旅剪", "DRAFT-ID", &[clip], 10, 1920, 1080).unwrap();
        assert_eq!(
            draft.materials.videos[0].material_name,
            "【第 1 章·在途】one.mov [音轨映射 0=机内麦(转录)/1=无线麦]"
        );
    }

    /// V14-04:自动章名「第 7 章 · 14:40-14:40」不叠序号,只包一层;同一章被拆成两段时沿用同一个号、
    /// 章数按不同章名数;手动章名仍是「【第 n 章·章名】」。
    #[test]
    fn chapter_prefix_never_stacks_ordinals_and_reuses_the_same_chapter_number() {
        let inputs = [
            chaptered("IMG_0831.mov", "第 7 章 · 14:40-14:40"),
            chaptered("IMG_0832.mov", "第 7 章 · 14:40-14:40"),
            chaptered("clip_1.mp4", "第 1 章 · 13:00-13:00"),
            chaptered("IMG_0830.mov", "第 7 章 · 14:40-14:40"),
            chaptered("x.mov", "海边"),
        ];
        let (prefixes, count) = chapter_prefixes(&inputs);
        assert_eq!(
            prefixes,
            ["【第 7 章 · 14:40-14:40】", "", "【第 1 章 · 13:00-13:00】", "【第 7 章 · 14:40-14:40】", "【第 3 章·海边】"]
        );
        assert_eq!(count, 3, "章数 = 不同章名数,不是连续段落数");
        assert!(!prefixes.iter().any(|prefix| prefix.contains("章·第")), "{prefixes:?}");
        assert!(title_carries_ordinal("第 12 章"));
        assert!(!title_carries_ordinal("第一章"));
        assert!(!title_carries_ordinal("清晨出发"));
    }

    #[test]
    fn no_chapters_means_zero_marks_and_plain_names() {
        let inputs = [input("a.mov", 0, 1_000), input("b.mov", 0, 1_000)];
        assert_eq!(chapter_prefixes(&inputs).1, 0);
        let draft = build_draft("旅剪", "DRAFT-ID", &inputs, 10, 1920, 1080).unwrap();
        assert_eq!(draft.materials.videos[0].material_name, "a.mov");
    }

    #[test]
    fn whitelist_accepts_only_measured_version() {
        let status = availability_from(Ok("11.3.0".to_owned()), true, HumanCheck::None);
        assert!(status.supported);
        assert_eq!(status.installed_version.as_deref(), Some("11.3.0"));
    }

    #[test]
    fn whitelist_rejects_unmeasured_upgrade() {
        let status = availability_from(Ok("11.4.0".to_owned()), true, HumanCheck::None);
        assert!(!status.supported);
        assert!(status.reason.contains("还没核对过"));
    }

    #[test]
    fn missing_draft_root_disables_native_button() {
        let status = availability_from(Ok("11.3.0".to_owned()), false, HumanCheck::None);
        assert!(!status.supported);
        assert!(status.reason.contains("草稿根目录"));
    }

    #[test]
    fn qa_draft_root_override_never_falls_back_to_the_real_home() {
        let root = draft_root_from(
            Some(std::ffi::OsString::from("/Users/real-user")),
            Some(std::ffi::OsString::from("/tmp/tripcut-qa/jianying")),
        )
        .unwrap();
        assert_eq!(root, PathBuf::from("/tmp/tripcut-qa/jianying"));
        assert!(draft_root_from(
            Some(std::ffi::OsString::from("/Users/real-user")),
            Some(std::ffi::OsString::from("relative/path")),
        )
        .is_err());
    }

    #[test]
    fn native_draft_resolves_and_verifies_selected_source_paths() {
        let directory = TestDirectory::new();
        let source = directory.path().join("selected.mov");
        std::fs::write(&source, b"verified draft source").unwrap();
        let (quick_hash, byte_size) = import::quick_fingerprint(&source).unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        connection
            .execute("INSERT INTO volumes(uuid) VALUES ('draft-volume')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(
                    volume_uuid, rel_path, byte_size, quick_hash, tb_num, tb_den,
                    duration_ticks, fps_num, fps_den, is_vfr, codec, width, height,
                    imported_at, episode_id
                 ) VALUES (
                    'draft-volume', ?1, ?2, ?3, 1, 1000, 1000, 30, 1, 0,
                    'h264', 1920, 1080, strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                    (SELECT id FROM episodes WHERE status='active')
                 )",
                params![source.to_string_lossy(), byte_size as i64, quick_hash],
            )
            .unwrap();
        let clip_id = connection.last_insert_rowid();
        ratings::rate_clip(&mut connection, clip_id, "binary", 1).unwrap();
        let mut clips = deliver::selected_clips(&connection).unwrap();
        assert_eq!(clips.len(), 1);
        assert!(clips[0].source_path.is_empty());

        resolve_draft_sources(&connection, &mut clips).unwrap();

        assert_eq!(
            PathBuf::from(&clips[0].source_path),
            source.canonicalize().unwrap()
        );
        assert_eq!(draft_inputs(&connection, &clips).unwrap().len(), 1);
    }

    #[test]
    fn photo_only_selection_reports_the_ordinary_no_video_error() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('photo-volume')", []).unwrap();
        connection.execute(
            "INSERT INTO clips(
                volume_uuid,rel_path,byte_size,quick_hash,kind,duration_ticks,episode_id
             ) VALUES(
                'photo-volume','still.jpg',10,'photo-hash','photo',0,
                (SELECT id FROM episodes WHERE status='active')
             )",
            [],
        ).unwrap();
        let clip_id = connection.last_insert_rowid();
        connection.execute(
            "INSERT INTO segments(clip_id,in_ticks,out_ticks,kind,tombstone)
             VALUES(?1,0,0,'whole',0)",
            [clip_id],
        ).unwrap();
        let segment_id = connection.last_insert_rowid();
        connection.execute(
            "INSERT INTO ratings(segment_id,rating_type,value,rated_at)
             VALUES(?1,'binary',1,'2026-09-19T23:59:59Z')",
            [segment_id],
        ).unwrap();
        let status = availability_from(Ok("11.3.0".to_owned()), true, HumanCheck::None);
        let error = generate_with_availability(
            &mut connection,
            &status,
            directory.path(),
            false,
            false,
        ).unwrap_err().to_string();
        assert!(error.contains("当前没有精选段或收藏素材"), "{error}");
        assert!(!error.contains("photo_not_supported"), "{error}");
    }

    /// R14 C-1:草稿名用集名,不再固定「旅剪项目」。
    #[test]
    fn draft_folder_name_uses_sanitized_episode_title() {
        assert_eq!(draft_folder_name("夏日海边之旅", false, 0, "ABCD1234"), "夏日海边之旅_剪映草稿_ABCD1234");
        assert_eq!(draft_folder_name("  A/B:C\\D  ", false, 0, "ABCD1234"), "A_B_C_D_剪映草稿_ABCD1234");
        assert_eq!(draft_folder_name("///", false, 0, "ABCD1234"), "旅剪项目_剪映草稿_ABCD1234");
        assert_eq!(draft_folder_name("", false, 0, "ABCD1234"), "旅剪项目_剪映草稿_ABCD1234");
        let long = "长".repeat(60);
        assert_eq!(
            draft_folder_name(&long, false, 0, "ABCD1234").chars().count(),
            DRAFT_NAME_TITLE_MAX_CHARS + "_剪映草稿_ABCD1234".chars().count()
        );
    }

    #[test]
    fn time_base_ticks_are_rounded_to_microseconds() {
        assert_eq!(ticks_to_microseconds(1, 1, 3).unwrap(), 333_333);
        assert_eq!(ticks_to_microseconds(1_500, 1, 1_000).unwrap(), 1_500_000);
    }

    #[test]
    fn invalid_time_base_is_rejected() {
        assert!(ticks_to_microseconds(1, 0, 1_000).is_err());
        assert!(ticks_to_microseconds(-1, 1, 1_000).is_err());
    }

    #[test]
    fn schema_serializes_measured_version_and_absolute_material_paths() {
        let draft = build_draft("旅剪", "DRAFT-ID", &[input("one.mov", 0, 2_000)], 10, 1920, 1080).unwrap();
        let value = serde_json::to_value(draft).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 36);
        assert_eq!(value["materials"].as_object().unwrap().len(), 55);
        assert_eq!(value["new_version"], "75.0.0");
        assert_eq!(value["version"], 360_000);
        assert_eq!(value["tracks"][0]["type"], "video");
        assert_eq!(value["materials"]["videos"][0]["path"], "/Volumes/CARD/one.mov");
    }

    /// R6 Task 7b：`clips.manual_rotation` 要落到 segment 的 `clip.rotation`——
    /// 这个键在 11.3.0 金样里本来就有(見 `golden_key_sets` 的顶层/materials
    /// 键集比对不覆盖 segment 内部字段，加值不加键，不影响该门禁)。
    #[test]
    fn manual_rotation_is_written_to_segment_clip_rotation() {
        let mut rotated = input("rotated.mov", 0, 2_000);
        rotated.manual_rotation = Some(90);
        let draft = build_draft("旅剪", "DRAFT-ID", &[rotated], 10, 1920, 1080).unwrap();
        let value = serde_json::to_value(draft).unwrap();
        assert_eq!(value["tracks"][0]["segments"][0]["clip"]["rotation"], 90.0);
    }

    #[test]
    fn no_manual_rotation_keeps_segment_clip_rotation_zero() {
        let draft = build_draft("旅剪", "DRAFT-ID", &[input("one.mov", 0, 2_000)], 10, 1920, 1080).unwrap();
        let value = serde_json::to_value(draft).unwrap();
        assert_eq!(value["tracks"][0]["segments"][0]["clip"]["rotation"], 0.0);
    }

    #[test]
    fn material_name_is_unchanged_for_single_track_clips() {
        let mut clip = input("one.mov", 0, 2_000);
        clip.audio_tracks = vec![deliver::ExportAudioTrack {
            stream_index: 0,
            role_guess: Some("onboard_mic".to_owned()),
        }];
        assert_eq!(audio_track_material_name(&clip), "one.mov");
    }

    #[test]
    fn material_name_carries_audio_track_mapping_for_multi_track_clips() {
        let mut clip = input("one.mov", 0, 2_000);
        clip.selected_transcribe_track = Some(1);
        clip.audio_tracks = vec![
            deliver::ExportAudioTrack { stream_index: 0, role_guess: Some("onboard_mic".to_owned()) },
            deliver::ExportAudioTrack { stream_index: 1, role_guess: Some("wireless_mic".to_owned()) },
        ];
        assert_eq!(
            audio_track_material_name(&clip),
            "one.mov [音轨映射 0=机内麦/1=无线麦(转录)]"
        );
    }

    #[test]
    fn draft_video_material_name_preserves_audio_track_mapping() {
        let mut clip = input("one.mov", 0, 2_000);
        clip.audio_tracks = vec![
            deliver::ExportAudioTrack { stream_index: 0, role_guess: Some("onboard_mic".to_owned()) },
            deliver::ExportAudioTrack { stream_index: 1, role_guess: Some("wireless_mic".to_owned()) },
        ];
        let draft = build_draft("旅剪", "DRAFT-ID", &[clip], 10, 1920, 1080).unwrap();
        assert_eq!(
            draft.materials.videos[0].material_name,
            "one.mov [音轨映射 0=机内麦(转录)/1=无线麦]"
        );
    }

    #[test]
    fn canvas_config_comes_from_the_platform_preset_not_the_first_clip() {
        // Regression for R3 Task 3: the draft canvas must reflect the platform
        // preset (e.g. douyin/portrait -> 1080x1920), not the first selected
        // clip's own resolution — the fixture input() below is 3840x2160.
        let draft =
            build_draft("旅剪", "DRAFT-ID", &[input("one.mov", 0, 1_000)], 10, 1080, 1920)
                .unwrap();
        let value = serde_json::to_value(&draft).unwrap();
        assert_eq!(value["canvas_config"]["width"], 1080);
        assert_eq!(value["canvas_config"]["height"], 1920);
    }

    #[test]
    fn resolve_platform_for_draft_folds_both_to_landscape_and_reads_portrait_preset() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let current = crate::core::episode::current_episode(&connection).unwrap();
        crate::core::platform::set_episode_platform(
            &mut connection,
            current.id,
            "douyin",
            "portrait",
        )
        .unwrap();
        let resolved = crate::core::platform::resolve_platform(&connection, current.id, None)
            .unwrap();
        assert_eq!(resolved.canvas(), (1080, 1920));
    }

    #[test]
    fn story_order_inputs_become_contiguous_target_ranges() {
        let draft = build_draft(
            "旅剪",
            "DRAFT-ID",
            &[input("second.mov", 500, 1_500), input("first.mov", 2_000, 4_500)],
            10,
            1920,
            1080,
        )
        .unwrap();
        let segments = &draft.tracks[0].segments;
        assert_eq!(segments[0].source_timerange, Some(DraftTimerange { start: 500_000, duration: 1_000_000 }));
        assert_eq!(segments[0].target_timerange.start, 0);
        assert_eq!(segments[1].target_timerange.start, 1_000_000);
        assert_eq!(draft.duration, 3_500_000);
    }

    #[test]
    fn readback_validation_rejects_a_target_gap() {
        let mut draft = build_draft(
            "旅剪",
            "DRAFT-ID",
            &[input("one.mov", 0, 1_000), input("two.mov", 0, 1_000)],
            10,
            1920,
            1080,
        )
        .unwrap();
        draft.tracks[0].segments[1].target_timerange.start += 1;
        assert!(validate_draft(&draft, 2).is_err());
    }

    #[test]
    fn readback_failure_does_not_promote_or_leave_staging() {
        let root = std::env::temp_dir().join(format!("tripcut-jianying-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let final_path = root.join("invalid-draft");
        let mut draft =
            build_draft("旅剪", "DRAFT-ID", &[input("one.mov", 0, 1_000)], 10, 1920, 1080).unwrap();
        draft.new_version = "unexpected".to_owned();
        let meta = build_meta(&draft, &final_path, 10).unwrap();

        assert!(write_draft_atomically(
            &root,
            &final_path,
            &draft,
            &meta,
            &[input("one.mov", 0, 1_000)],
            &[],
        )
        .is_err());
        assert!(!final_path.exists());
        assert!(!std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(".tripcut-staging-")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn meta_points_at_draft_info_json() {
        let draft = build_draft("旅剪", "DRAFT-ID", &[input("one.mov", 0, 1_000)], 10, 1920, 1080).unwrap();
        let meta = build_meta(&draft, Path::new("/draft-root/旅剪"), 10).unwrap();
        assert_eq!(meta.draft_id, "DRAFT-ID");
        assert_eq!(meta.draft_json_file, "/draft-root/旅剪/draft_info.json");
        assert_eq!(meta.tm_duration, 1_000_000);
    }

    #[test]
    fn atomic_writer_promotes_only_after_readback() {
        let root = std::env::temp_dir().join(format!("tripcut-jianying-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let final_path = root.join("new-draft");
        let draft = build_draft("旅剪", "DRAFT-ID", &[input("one.mov", 0, 1_000)], 10, 1920, 1080).unwrap();
        let meta = build_meta(&draft, &final_path, 10).unwrap();
        write_draft_atomically(&root, &final_path, &draft, &meta, &[input("one.mov", 0, 1_000)], &[]).unwrap();
        assert!(final_path.join(DRAFT_INFO_FILE).is_file());
        assert!(final_path.join(DRAFT_META_FILE).is_file());
        assert!(!std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.file_name().to_string_lossy().starts_with(".tripcut-staging-")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn atomic_writer_never_overwrites_existing_draft() {
        let root = std::env::temp_dir().join(format!("tripcut-jianying-{}", Uuid::new_v4()));
        let final_path = root.join("existing");
        std::fs::create_dir_all(&final_path).unwrap();
        let marker = final_path.join("keep.txt");
        std::fs::write(&marker, b"keep").unwrap();
        let draft = build_draft("旅剪", "DRAFT-ID", &[input("one.mov", 0, 1_000)], 10, 1920, 1080).unwrap();
        let meta = build_meta(&draft, &final_path, 10).unwrap();
        assert!(write_draft_atomically(&root, &final_path, &draft, &meta, &[input("one.mov", 0, 1_000)], &[]).is_err());
        assert_eq!(std::fs::read(&marker).unwrap(), b"keep");
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod r14_force_tests {
    use super::*;
    use crate::core::{db, import, ratings, settings, test_support::TestDirectory};

    fn seed_selected_clip(directory: &TestDirectory) -> Connection {
        let source = directory.path().join("selected.mov");
        std::fs::write(&source, b"verified draft source").unwrap();
        let (quick_hash, byte_size) = import::quick_fingerprint(&source).unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('draft-volume')", []).unwrap();
        connection
            .execute(
                "INSERT INTO clips(
                    volume_uuid, rel_path, byte_size, quick_hash, tb_num, tb_den,
                    duration_ticks, fps_num, fps_den, is_vfr, codec, width, height,
                    imported_at, episode_id
                 ) VALUES (
                    'draft-volume', ?1, ?2, ?3, 1, 1000, 1000, 30, 1, 0,
                    'h264', 1920, 1080, strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                    (SELECT id FROM episodes WHERE status='active')
                 )",
                params![source.to_string_lossy(), byte_size as i64, quick_hash],
            )
            .unwrap();
        let clip_id = connection.last_insert_rowid();
        ratings::rate_clip(&mut connection, clip_id, "binary", 1).unwrap();
        connection
    }

    #[test]
    fn pending_version_is_not_usable_but_force_allowed() {
        let status = availability_from(Ok("11.4.13189".to_owned()), true, HumanCheck::None);
        assert!(!status.usable);
        assert!(!status.supported);
        assert!(!status.whitelisted);
        assert!(status.force_allowed);
        assert_eq!(status.human_check, HumanCheck::None);
    }

    #[test]
    fn unknown_version_is_never_force_allowed() {
        let status = availability_from(Ok("12.0.0".to_owned()), true, HumanCheck::None);
        assert!(!status.usable);
        assert!(!status.force_allowed);
    }

    #[test]
    fn human_check_ok_makes_pending_version_usable() {
        let status = availability_from(Ok("11.4.13189".to_owned()), true, HumanCheck::Ok);
        assert!(status.usable);
        assert!(status.supported);
        assert!(!status.whitelisted);
        assert!(status.reason.contains("已确认"));
    }

    #[test]
    fn human_check_fail_keeps_pending_version_unusable_but_retryable() {
        let status = availability_from(Ok("11.4.13189".to_owned()), true, HumanCheck::Fail);
        assert!(!status.usable);
        assert!(status.force_allowed);
        assert_eq!(status.human_check, HumanCheck::Fail);
    }

    #[test]
    fn human_check_ok_never_rescues_an_unknown_version() {
        let status = availability_from(Ok("12.0.0".to_owned()), true, HumanCheck::Ok);
        assert!(!status.usable);
    }

    #[test]
    fn missing_draft_root_blocks_force_too() {
        let status = availability_from(Ok("11.4.13189".to_owned()), false, HumanCheck::None);
        assert!(!status.force_allowed);
    }

    #[test]
    fn human_check_setting_round_trips_through_settings_whitelist() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        assert_eq!(human_check_from_settings(&connection, "11.4.13189").unwrap(), HumanCheck::None);
        set_human_check(&connection, "11.4.13189", HumanCheck::Ok).unwrap();
        assert_eq!(human_check_from_settings(&connection, "11.4.13189").unwrap(), HumanCheck::Ok);
        assert_eq!(
            settings::setting_value(&connection, "jianying.human_check.11.4.13189").unwrap().as_deref(),
            Some("ok")
        );
        set_human_check(&connection, "11.4.13189", HumanCheck::Fail).unwrap();
        assert_eq!(human_check_from_settings(&connection, "11.4.13189").unwrap(), HumanCheck::Fail);
        // 未知版本不许记「可以用」:那会绕过白名单。
        assert!(set_human_check(&connection, "12.0.0", HumanCheck::Ok).is_err());
        // 值只认 ok / fail。
        assert!(settings::set_setting(&connection, "jianying.human_check.11.4.13189", "maybe").is_err());
    }

    #[test]
    fn force_generates_timestamped_experimental_draft_for_pending_version() {
        let directory = TestDirectory::new();
        let mut connection = seed_selected_clip(&directory);
        let root = directory.path().join("draft-root");
        std::fs::create_dir(&root).unwrap();
        let status = availability_from(Ok("11.4.13189".to_owned()), true, HumanCheck::None);

        assert!(generate_with_availability(&mut connection, &status, &root, false, false).is_err());
        let result = generate_with_availability(&mut connection, &status, &root, true, false).unwrap();

        assert!(result.experimental);
        assert_eq!(result.draft_path, result.output_path);
        assert!(Path::new(&result.draft_path).join(DRAFT_INFO_FILE).is_file());
        assert!(result.draft_name.contains("试验"));
        assert!(result.draft_name.len() > PROJECT_NAME.len() + 8, "name should carry a timestamp: {}", result.draft_name);
        let (golden_top, golden_materials) = golden_key_sets();
        let written: Value = serde_json::from_slice(&std::fs::read(Path::new(&result.draft_path).join(DRAFT_INFO_FILE)).unwrap()).unwrap();
        let top: BTreeSet<String> = written.as_object().unwrap().keys().cloned().collect();
        let materials: BTreeSet<String> = written["materials"].as_object().unwrap().keys().cloned().collect();
        assert_eq!(top, golden_top);
        assert_eq!(materials, golden_materials);
        // 第二次 force 也是新目录,不覆盖第一次。
        let second = generate_with_availability(&mut connection, &status, &root, true, false).unwrap();
        assert_ne!(second.draft_path, result.draft_path);
        assert!(Path::new(&result.draft_path).is_dir());
        assert!(!result.subtitles_on_timeline);
        assert_eq!(result.timeline_subtitle_count, 0);
        // R24 D-1:试验草稿也能开「字幕写进时间线」;这条素材没有转写 → 不建文字轨、条数 0,结果如实回报开关。
        let with_subtitles = generate_with_availability(&mut connection, &status, &root, true, true).unwrap();
        assert!(with_subtitles.subtitles_on_timeline);
        assert_eq!(with_subtitles.timeline_subtitle_count, 0);
        let written: Value =
            serde_json::from_slice(&std::fs::read(Path::new(&with_subtitles.draft_path).join(DRAFT_INFO_FILE)).unwrap()).unwrap();
        assert_eq!(written["tracks"].as_array().unwrap().len(), 1);
    }

    /// V14-01:原生草稿的 videos 顺序 = 镜头带「按章节」顺序(早章在前、章内按 position),
    /// 不是挑选先后。与素材包 / 导出片段共用 `story::ordered_band_items` 这一份真相。
    #[test]
    fn native_draft_videos_follow_band_order_not_pick_order() {
        let directory = TestDirectory::new();
        let mut connection = seed_selected_clip(&directory);
        let seed_clip = |connection: &Connection, name: &str| -> i64 {
            let source = directory.path().join(name);
            std::fs::write(&source, name.as_bytes()).unwrap();
            let (quick_hash, byte_size) = import::quick_fingerprint(&source).unwrap();
            connection
                .execute(
                    "INSERT INTO clips(
                        volume_uuid, rel_path, byte_size, quick_hash, tb_num, tb_den,
                        duration_ticks, fps_num, fps_den, is_vfr, codec, width, height,
                        imported_at, episode_id
                     ) VALUES (
                        'draft-volume', ?1, ?2, ?3, 1, 1000, 1000, 30, 1, 0,
                        'h264', 1920, 1080, strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                        (SELECT id FROM episodes WHERE status='active')
                     )",
                    params![source.to_string_lossy(), byte_size as i64, quick_hash],
                )
                .unwrap();
            connection.last_insert_rowid()
        };
        let insert_chapter = |connection: &Connection, title: &str, start_at: &str| -> i64 {
            connection
                .execute(
                    "INSERT INTO chapters(title, start_at, end_at, manual, episode_id)
                     VALUES (?1, ?2, '2026-08-31T23:59:59Z', 1,
                             (SELECT id FROM episodes WHERE status = 'active'))",
                    params![title, start_at],
                )
                .unwrap();
            connection.last_insert_rowid()
        };
        let selected: i64 = connection
            .query_row("SELECT id FROM clips WHERE rel_path LIKE '%selected.mov'", [], |row| row.get(0))
            .unwrap();
        let early_clip = seed_clip(&connection, "early.mov");
        ratings::rate_clip(&mut connection, early_clip, "binary", 1).unwrap();
        let late = insert_chapter(&connection, "傍晚", "2026-08-31T18:00:00Z");
        let early = insert_chapter(&connection, "清晨", "2026-08-31T06:00:00Z");
        connection.execute("UPDATE clips SET chapter_id = ?1 WHERE id = ?2", params![late, selected]).unwrap();
        connection.execute("UPDATE clips SET chapter_id = ?1 WHERE id = ?2", params![early, early_clip]).unwrap();
        // 挑选先后:傍晚的 selected.mov 先,清晨的 early.mov 后。
        for (position, clip_id) in [selected, early_clip].into_iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO story_order(item_kind, clip_id, position, tombstone, created_at, updated_at, episode_id)
                     VALUES ('whole', ?1, ?2, 0, 'now', 'now', (SELECT id FROM episodes WHERE status = 'active'))",
                    params![clip_id, position as i64],
                )
                .unwrap();
        }
        let root = directory.path().join("draft-root");
        std::fs::create_dir(&root).unwrap();
        let status = availability_from(Ok("11.3.0".to_owned()), true, HumanCheck::None);

        let result = generate_with_availability(&mut connection, &status, &root, false, false).unwrap();

        let written: Value = serde_json::from_slice(&std::fs::read(Path::new(&result.draft_path).join(DRAFT_INFO_FILE)).unwrap()).unwrap();
        let names = written["materials"]["videos"]
            .as_array()
            .unwrap()
            .iter()
            .map(|video| video["material_name"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        // 去掉章前缀只看顺序(前缀形态归 V14-04 的测试管)。
        let files = names.iter().map(|name| name.rsplit('】').next().unwrap()).collect::<Vec<_>>();
        assert_eq!(files, vec!["early.mov", "selected.mov"], "{names:?}");
        assert_eq!(result.chapter_marks, 2);
    }

    #[test]
    fn force_still_rejects_unknown_version() {
        let directory = TestDirectory::new();
        let mut connection = seed_selected_clip(&directory);
        let root = directory.path().join("draft-root");
        std::fs::create_dir(&root).unwrap();
        let status = availability_from(Ok("12.0.0".to_owned()), true, HumanCheck::None);
        let error = generate_with_availability(&mut connection, &status, &root, true, false).unwrap_err();
        assert!(error.to_string().contains("12.0.0"));
        assert!(std::fs::read_dir(&root).unwrap().next().is_none());
    }

    #[test]
    fn whitelisted_version_without_force_is_not_experimental() {
        let directory = TestDirectory::new();
        let mut connection = seed_selected_clip(&directory);
        let root = directory.path().join("draft-root");
        std::fs::create_dir(&root).unwrap();
        let status = availability_from(Ok("11.3.0".to_owned()), true, HumanCheck::None);
        let result = generate_with_availability(&mut connection, &status, &root, false, false).unwrap();
        assert!(!result.experimental);
        assert!(!result.draft_name.contains("试验"));
    }
}

#[path = "jianying_text.rs"]
mod text;

#[cfg(test)]
#[path = "jianying_baseline_tests.rs"]
mod baseline_tests;
