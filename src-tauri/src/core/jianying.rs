use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
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

pub const SUPPORTED_JIANYING_VERSIONS: &[&str] = &["11.3.0"];

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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct JianyingAvailability {
    pub installed_version: Option<String>,
    pub supported: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct JianyingDraftResult {
    pub status: String,
    pub output_path: String,
    pub draft_name: String,
    pub jianying_version: String,
    pub selected_count: u64,
    pub subtitle_count: u64,
    pub message: String,
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
    extra_material_refs: Vec<String>,
    id: String,
    is_tone_modify: bool,
    keyframe_refs: Vec<Value>,
    last_nonzero_volume: f64,
    material_id: String,
    render_index: i64,
    reverse: bool,
    source_timerange: DraftTimerange,
    speed: f64,
    target_timerange: DraftTimerange,
    track_attribute: i64,
    track_render_index: i64,
    visible: bool,
    volume: f64,
    clip: Value,
    uniform_scale: Value,
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

pub fn availability() -> JianyingAvailability {
    let version = read_editor_version(Path::new(JIANYING_APP_PLIST));
    let draft_root_exists = default_draft_root().is_ok_and(|root| root.is_dir());
    availability_from(version, draft_root_exists)
}

pub fn generate_native_draft(connection: &mut Connection) -> Result<JianyingDraftResult> {
    let status = availability();
    if !status.supported {
        return Err(CoreError::Jianying(format!(
            "{}；已停止原生草稿路径，请改用稳定交付包",
            status.reason
        )));
    }
    let version = status
        .installed_version
        .ok_or_else(|| CoreError::Jianying("无法确认剪映版本".to_owned()))?;
    let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let episode_id: i64 = transaction
        .query_row(
            "SELECT id FROM episodes WHERE status = 'active'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| CoreError::Jianying("没有进行中的 Episode，无法生成草稿".to_owned()))?;
    let mut clips = deliver::selected_clips(&transaction)?;
    transaction.commit()?;
    if clips.is_empty() {
        return Err(CoreError::Jianying(
            "当前没有精选段或收藏素材，无法生成剪映草稿".to_owned(),
        ));
    }

    resolve_draft_sources(connection, &mut clips)?;
    let inputs = draft_inputs(connection, &clips)?;
    let now = unix_timestamp()?;
    let draft_id = Uuid::new_v4().to_string().to_uppercase();
    let short_id = draft_id.chars().filter(|ch| *ch != '-').take(8).collect::<String>();
    let draft_name = format!("{PROJECT_NAME}_剪映草稿_{short_id}");
    let root = default_draft_root()?;
    let final_path = root.join(&draft_name);
    let draft = build_draft(&draft_name, &draft_id, &inputs, now)?;
    let meta = build_meta(&draft, &final_path, now)?;
    let subtitle_count = write_draft_atomically(&root, &final_path, &draft, &meta, &inputs)?;

    let manifest = json!({
        "schema": {"new_version": draft.new_version.clone(), "version": draft.version},
        "jianying_version": version.clone(),
        "self_check": "passed",
        "selected_count": inputs.len(),
        "subtitle_count": subtitle_count,
        "output_path": final_path.to_string_lossy().into_owned(),
        "source_paths": inputs.iter().map(|input| input.source_path.to_string_lossy().into_owned()).collect::<Vec<_>>()
    });
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

    Ok(JianyingDraftResult {
        status: "created".to_owned(),
        output_path: final_path.to_string_lossy().into_owned(),
        draft_name,
        jianying_version: version,
        selected_count: inputs.len() as u64,
        subtitle_count,
        message: "草稿已生成；请回到剪映首页，在“本地草稿”中打开并核对素材顺序与入出点".to_owned(),
    })
}

fn availability_from(
    version: std::result::Result<String, String>,
    draft_root_exists: bool,
) -> JianyingAvailability {
    match version {
        Ok(version) if !SUPPORTED_JIANYING_VERSIONS.contains(&version.as_str()) => {
            JianyingAvailability {
                installed_version: Some(version.clone()),
                supported: false,
                reason: format!(
                    "当前剪映 {version} 不在已验证白名单（仅 {}）；原生草稿已禁用",
                    SUPPORTED_JIANYING_VERSIONS.join("、")
                ),
            }
        }
        Ok(version) if !draft_root_exists => JianyingAvailability {
            installed_version: Some(version),
            supported: false,
            reason: "未找到剪映草稿根目录；请先在剪映中创建一份本地草稿".to_owned(),
        },
        Ok(version) => JianyingAvailability {
            installed_version: Some(version.clone()),
            supported: true,
            reason: format!("剪映 {version} 已通过明文空草稿金丝雀，可生成实验草稿"),
        },
        Err(reason) => JianyingAvailability {
            installed_version: None,
            supported: false,
            reason: format!("无法读取剪映版本：{reason}；原生草稿已禁用"),
        },
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
            })
        })
        .collect()
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

fn build_draft(
    name: &str,
    draft_id: &str,
    inputs: &[DraftInput],
    now: i64,
) -> Result<DraftInfo> {
    let mut draft: DraftInfo = serde_json::from_str(DRAFT_TEMPLATE_11_3_0)
        .map_err(|error| CoreError::Jianying(format!("内嵌草稿模板无效：{error}")))?;
    let first = inputs
        .first()
        .ok_or_else(|| CoreError::Jianying("没有可写入草稿的精选素材".to_owned()))?;
    draft.canvas_config.width = first.width;
    draft.canvas_config.height = first.height;
    draft.id = draft_id.to_owned();
    draft.name = name.to_owned();
    draft.new_version = SCHEMA_NEW_VERSION.to_owned();
    draft.version = SCHEMA_VERSION;
    draft.template_fields.insert("create_time".to_owned(), json!(now));
    draft.template_fields.insert("update_time".to_owned(), json!(now));

    let mut target_start = 0_i64;
    let mut segments = Vec::with_capacity(inputs.len());
    for input in inputs {
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
            material_name: input.file_name.clone(),
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
            extra_material_refs: vec![speed_id],
            id: segment_id,
            is_tone_modify: false,
            keyframe_refs: Vec::new(),
            last_nonzero_volume: 1.0,
            material_id,
            render_index: 0,
            reverse: false,
            source_timerange: DraftTimerange {
                duration,
                start: source_start,
            },
            speed: 1.0,
            target_timerange: DraftTimerange {
                duration,
                start: target_start,
            },
            track_attribute: 0,
            track_render_index: 0,
            visible: true,
            volume: 1.0,
            clip: json!({"alpha":1.0,"flip":{"horizontal":false,"vertical":false},"rotation":0.0,"scale":{"x":1.0,"y":1.0},"transform":{"x":0.0,"y":0.0}}),
            uniform_scale: json!({"on":true,"value":1.0}),
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
    validate_draft(&draft, inputs.len())?;
    Ok(draft)
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
    if draft.template_fields.len() + 9 != TOP_LEVEL_KEY_COUNT
        || draft.materials.other.len() + 2 != MATERIAL_KEY_COUNT
    {
        return Err(CoreError::Jianying(
            "草稿 schema 键集合与 11.3.0 金样不一致".to_owned(),
        ));
    }
    if draft.tracks.len() != 1 || draft.tracks[0].track_type != "video" {
        return Err(CoreError::Jianying("草稿必须且只能含一条视频轨".to_owned()));
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
        if segment.target_timerange.start != expected_start
            || segment.target_timerange.duration <= 0
            || segment.source_timerange.start < 0
            || segment.source_timerange.duration != segment.target_timerange.duration
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
    let instructions = delivery_instructions(inputs.len(), subtitle_count);
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

fn delivery_instructions(selected_count: usize, subtitle_count: u64) -> String {
    let subtitle_note = if subtitle_count == 0 {
        "本次没有可用转写，因此未创建字幕目录。".to_owned()
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
        }
    }

    #[test]
    fn whitelist_accepts_only_measured_version() {
        let status = availability_from(Ok("11.3.0".to_owned()), true);
        assert!(status.supported);
        assert_eq!(status.installed_version.as_deref(), Some("11.3.0"));
    }

    #[test]
    fn whitelist_rejects_unmeasured_upgrade() {
        let status = availability_from(Ok("11.4.0".to_owned()), true);
        assert!(!status.supported);
        assert!(status.reason.contains("不在已验证白名单"));
    }

    #[test]
    fn missing_draft_root_disables_native_button() {
        let status = availability_from(Ok("11.3.0".to_owned()), false);
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
        let draft = build_draft("旅剪", "DRAFT-ID", &[input("one.mov", 0, 2_000)], 10).unwrap();
        let value = serde_json::to_value(draft).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 36);
        assert_eq!(value["materials"].as_object().unwrap().len(), 55);
        assert_eq!(value["new_version"], "75.0.0");
        assert_eq!(value["version"], 360_000);
        assert_eq!(value["tracks"][0]["type"], "video");
        assert_eq!(value["materials"]["videos"][0]["path"], "/Volumes/CARD/one.mov");
    }

    #[test]
    fn story_order_inputs_become_contiguous_target_ranges() {
        let draft = build_draft(
            "旅剪",
            "DRAFT-ID",
            &[input("second.mov", 500, 1_500), input("first.mov", 2_000, 4_500)],
            10,
        )
        .unwrap();
        let segments = &draft.tracks[0].segments;
        assert_eq!(segments[0].source_timerange, DraftTimerange { start: 500_000, duration: 1_000_000 });
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
            build_draft("旅剪", "DRAFT-ID", &[input("one.mov", 0, 1_000)], 10).unwrap();
        draft.new_version = "unexpected".to_owned();
        let meta = build_meta(&draft, &final_path, 10).unwrap();

        assert!(write_draft_atomically(
            &root,
            &final_path,
            &draft,
            &meta,
            &[input("one.mov", 0, 1_000)],
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
        let draft = build_draft("旅剪", "DRAFT-ID", &[input("one.mov", 0, 1_000)], 10).unwrap();
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
        let draft = build_draft("旅剪", "DRAFT-ID", &[input("one.mov", 0, 1_000)], 10).unwrap();
        let meta = build_meta(&draft, &final_path, 10).unwrap();
        write_draft_atomically(&root, &final_path, &draft, &meta, &[input("one.mov", 0, 1_000)]).unwrap();
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
        let draft = build_draft("旅剪", "DRAFT-ID", &[input("one.mov", 0, 1_000)], 10).unwrap();
        let meta = build_meta(&draft, &final_path, 10).unwrap();
        assert!(write_draft_atomically(&root, &final_path, &draft, &meta, &[input("one.mov", 0, 1_000)]).is_err());
        assert_eq!(std::fs::read(&marker).unwrap(), b"keep");
        std::fs::remove_dir_all(root).unwrap();
    }
}
