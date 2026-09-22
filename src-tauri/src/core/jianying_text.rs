//! R24 D-1(J-02):字幕写进剪映时间线(文字轨),挂在导出抽屉「字幕写进时间线(试验)」开关后,默认关。
//!
//! **结构不猜**:11.3.0 金样里 `materials.texts` 是空数组、没有文字轨,元素形状无从比对;这里每个
//! 字段都取自 pyJianYingDraft 0.3.0(PyPI wheel `pyjianyingdraft-0.3.0-py3-none-any.whl`,
//! GuanYixuan/pyJianYingDraft;0.2.7 的 `text_segment.py` 与之逐字相同)在 `ScriptFile.import_srt`
//! **默认参数**下产出的 JSON。逐字段出处写在各常量 / 函数注释里(文件:行号均指该 wheel)。
//! 顶层与 `materials` 的键集仍由 11.3.0 金样门禁(`golden_key_sets`)一票否决;文字素材 / 文字段
//! 元素里的键另有下面两份**带出处的白名单**,不在白名单里的键回读校验直接拒绝。

use std::collections::{BTreeSet, HashSet};

use serde_json::{json, Value};
use uuid::Uuid;

use super::{CoreError, DraftInfo, DraftInput, DraftSegment, DraftTimerange, DraftTrack, Result};

/// 文字轨名。pyJianYingDraft `import_srt(srt_path, track_name)` 要求调用方给轨道名
/// (`_script_file_segments.py:178-181`);`Track.export_json` 按 `len(name) == 0` 写 `is_default_name`(`track.py:185`)。
pub(super) const SUBTITLE_TRACK_NAME: &str = "TripCut字幕";
/// 与文字轨逐条一致的时间线 SRT,放在草稿的 `TripCut字幕/` 目录里(原片时间码的 SRT 照常输出)。
pub(super) const TIMELINE_SRT_FILE: &str = "时间线字幕.srt";
/// `ScriptFile.dumps` 把每个片段的 `render_index` 写成轨道在导出列表里的下标(`script_file.py:128-131`);
/// 文字轨按 `import_srt` 插在视频轨之后(`_script_file_segments.py:209-219`),下标恒为 1。
const TEXT_RENDER_INDEX: i64 = 1;

/// 文字素材元素的键(白名单,不在 11.3.0 金样中):`TextSegment.export_material` 的 `ret`
/// (`text_segment.py:431-446`),在 import_srt 默认样式下无背景(`:454-455` 不触发)。
pub(super) const TEXT_MATERIAL_KEYS: [&str; 12] = [
    "alignment",
    "check_flag",
    "content",
    "force_apply_line_max_width",
    "global_alpha",
    "id",
    "letter_spacing",
    "line_feed",
    "line_max_width",
    "line_spacing",
    "type",
    "typesetting",
];

/// 文字段比 0.11.4 视频段多出来的键(白名单):`BaseSegment.export_json` 的 `enable_smart_color_adjust`
/// (`segment.py:64`)。其余键与视频段(已在 11.3.0 上实开)完全相同。
pub(super) const TEXT_SEGMENT_EXTRA_KEYS: [&str; 1] = ["enable_smart_color_adjust"];

/// 时间线上的一条字幕(微秒)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TimelineCue {
    pub(super) start_us: i64,
    pub(super) duration_us: i64,
    pub(super) text: String,
}

/// 每个精选段的原片时间码 SRT → 时间线时间:只保留与段 `[入点, 出点)` 相交的部分,
/// 平移 `段在时间线上的起点 − 入点`。同一轨上的片段不能重叠(pyJianYingDraft `Track.add_segment`
/// 遇重叠直接抛 `SegmentOverlap`,`track.py:171-175`),所以与上一条重叠的开头被截到上一条结尾;
/// 截完(或按毫秒取整后)为空的条目丢弃。
pub(super) fn timeline_cues(inputs: &[DraftInput], draft: &DraftInfo) -> Result<Vec<TimelineCue>> {
    let video = draft
        .tracks
        .first()
        .filter(|track| track.track_type == "video" && track.segments.len() == inputs.len())
        .ok_or_else(|| CoreError::Jianying("字幕对时需要先有与精选段一一对应的视频轨".to_owned()))?;
    let mut cues = Vec::new();
    let mut previous_end = 0_i64;
    for (input, segment) in inputs.iter().zip(&video.segments) {
        let Some(srt) = input.srt_source.as_ref() else { continue };
        let Some(source) = segment.source_timerange.as_ref() else { continue };
        let raw = std::fs::read_to_string(srt)
            .map_err(|error| CoreError::Jianying(format!("读不了 {} 的字幕:{error}", input.file_name)))?;
        let parsed = super::super::transcribe::parse_srt(&raw)
            .map_err(|error| CoreError::Jianying(format!("{} 的字幕解析失败:{error}", input.file_name)))?;
        let source_end = source.start + source.duration;
        for cue in parsed {
            let start = milliseconds_to_us(cue.start_millis)?.max(source.start);
            let end = milliseconds_to_us(cue.end_millis)?.min(source_end);
            let timeline_start = (segment.target_timerange.start + (start - source.start)).max(previous_end);
            let timeline_end = segment.target_timerange.start + (end - source.start);
            if timeline_end <= timeline_start || round_ms(timeline_end) <= round_ms(timeline_start) {
                continue;
            }
            cues.push(TimelineCue {
                start_us: timeline_start,
                duration_us: timeline_end - timeline_start,
                text: cue.text,
            });
            previous_end = timeline_end;
        }
    }
    Ok(cues)
}

fn milliseconds_to_us(millis: i64) -> Result<i64> {
    millis.checked_mul(1_000).ok_or_else(|| CoreError::Jianying("字幕时间换算溢出".to_owned()))
}

fn round_ms(us: i64) -> i64 {
    (us + 500) / 1_000
}

/// 把字幕写成一条文字轨,插在视频轨之后(`import_srt` 的插入位置,`_script_file_segments.py:209-219`)。
pub(super) fn insert_subtitle_track(draft: &mut DraftInfo, cues: &[TimelineCue]) -> Result<()> {
    let texts = draft
        .materials
        .other
        .get_mut("texts")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| CoreError::Jianying("草稿模板缺少 materials.texts".to_owned()))?;
    let mut segments = Vec::with_capacity(cues.len());
    for cue in cues {
        // `TextSegment.__init__` 用新 uuid 当 material_id(`text_segment.py:296`);片段 id、speed id 同为 uuid hex
        // (`segment.py:24`、`segment.py:88`)。
        let material_id = Uuid::new_v4().simple().to_string();
        texts.push(text_material(&material_id, &cue.text));
        segments.push(text_segment(material_id, cue));
    }
    // `Track.export_json`(`track.py:180-189`):attribute = int(mute=False),flag 0。
    draft.tracks.insert(
        1,
        DraftTrack {
            attribute: 0,
            flag: 0,
            id: Uuid::new_v4().simple().to_string(),
            is_default_name: false,
            name: SUBTITLE_TRACK_NAME.to_owned(),
            segments,
            track_type: "text".to_owned(),
        },
    );
    Ok(())
}

/// `TextSegment.export_material`(`text_segment.py:384-446`),样式取 `import_srt` 默认
/// `TextStyle(size=5, align=1, auto_wrapping=True)`(`_script_file_segments.py:185`),`TextStyle` 其余默认值
/// 见 `text_segment.py:50-54`;无描边 / 背景 / 阴影 / 字体 / 花字。
fn text_material(material_id: &str, text: &str) -> Value {
    // content 的 styles[0]:`text_segment.py:395-417`。range 用 Python `len(self.text)`(码点数)。
    let content = json!({
        "styles": [{
            "fill": {
                "alpha": 1.0,
                "content": {"render_type": "solid", "solid": {"alpha": 1.0, "color": [1.0, 1.0, 1.0]}}
            },
            "range": [0, text.chars().count()],
            "size": 5,
            "bold": false,
            "italic": false,
            "underline": false,
            "strokes": []
        }],
        "text": text
    });
    json!({
        "id": material_id,
        "content": content.to_string(),
        "typesetting": 0,                    // int(vertical=False)
        "alignment": 1,                      // align=1(居中)
        "letter_spacing": 0.0,               // 0 * 0.05
        "line_spacing": 0.02,                // 0.02 + 0 * 0.05
        "line_feed": 1,
        "line_max_width": 0.82,              // max_line_width 默认
        "force_apply_line_max_width": false,
        "check_flag": 7,                     // 无描边/背景/阴影时的基础 flag(`text_segment.py:387`)
        "type": "subtitle",                  // auto_wrapping=True → "subtitle"(`text_segment.py:446`)
        "global_alpha": 1.0                  // alpha 默认 1.0
    })
}

/// 文字段,四处来源拼成:
/// 1. `BaseSegment.export_json`(`segment.py:55-77`);
/// 2. `MediaSegment.export_json`(`segment.py:207-217`):source_timerange=None、speed 1.0、volume 1.0、
///    extra_material_refs=[speed id]、is_tone_modify False;
/// 3. `VisualSegment.export_json`(`segment.py:282-289`):clip = `ClipSettings(transform_y=-0.8)`,即
///    `import_srt` 默认 clip_settings(`_script_file_segments.py:186`);uniform_scale on;
/// 4. `ScriptFile.dumps` 写的 render_index / track_render_index(`script_file.py:128-131`)。
///
/// 注意:0.3.0 / 0.2.7 的 `add_segment` 都**不**把文字段的 speed 放进 `materials.speeds`
/// (`_script_file_segments.py:105-112`),extra_material_refs 里那个 speed id 在源里就是悬空的——照抄,不自作主张补。
fn text_segment(material_id: String, cue: &TimelineCue) -> DraftSegment {
    DraftSegment {
        common_keyframes: Vec::new(),
        enable_adjust: true,
        enable_color_correct_adjust: false,
        enable_color_curves: true,
        enable_color_match_adjust: false,
        enable_color_wheels: true,
        enable_lut: true,
        enable_smart_color_adjust: Some(false),
        extra_material_refs: vec![Uuid::new_v4().simple().to_string()],
        id: Uuid::new_v4().simple().to_string(),
        is_tone_modify: false,
        keyframe_refs: Vec::new(),
        last_nonzero_volume: 1.0,
        material_id,
        render_index: TEXT_RENDER_INDEX,
        reverse: false,
        source_timerange: None,
        speed: 1.0,
        target_timerange: DraftTimerange { duration: cue.duration_us, start: cue.start_us },
        track_attribute: 0,
        track_render_index: 0,
        visible: true,
        volume: 1.0,
        clip: json!({"alpha":1.0,"flip":{"horizontal":false,"vertical":false},"rotation":0.0,"scale":{"x":1.0,"y":1.0},"transform":{"x":0.0,"y":-0.8}}),
        uniform_scale: Some(json!({"on":true,"value":1.0})),
    }
}

/// 时间线 SRT:与文字轨同一份 cue 表,时间按毫秒四舍五入。
pub(super) fn timeline_srt(cues: &[TimelineCue]) -> String {
    cues.iter()
        .enumerate()
        .map(|(index, cue)| {
            format!(
                "{}\n{} --> {}\n{}\n",
                index + 1,
                srt_timestamp(cue.start_us),
                srt_timestamp(cue.start_us + cue.duration_us),
                cue.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn srt_timestamp(us: i64) -> String {
    let millis = round_ms(us);
    format!(
        "{:02}:{:02}:{:02},{:03}",
        millis / 3_600_000,
        millis / 60_000 % 60,
        millis / 1_000 % 60,
        millis % 1_000
    )
}

/// 回读校验(`validate_draft` 调用):没有文字轨时 `materials.texts` 必须为空(开关关 = 0.11.4 形状);
/// 有文字轨时:素材与片段一一对应、素材键集恰为白名单、片段 source_timerange 为 null、
/// 片段不重叠且不越出视频轨总时长。
pub(super) fn validate_subtitle_track(draft: &DraftInfo) -> Result<()> {
    let invalid = |reason: &str| Err(CoreError::Jianying(format!("字幕轨校验失败:{reason}")));
    let Some(texts) = draft.materials.other.get("texts").and_then(Value::as_array) else {
        return invalid("缺少 materials.texts");
    };
    let Some(track) = draft.tracks.iter().find(|track| track.track_type == "text") else {
        return if texts.is_empty() { Ok(()) } else { invalid("有文字素材却没有文字轨") };
    };
    if track.segments.is_empty() || track.segments.len() != texts.len() {
        return invalid("文字素材与字幕片段数量不一致");
    }
    let whitelist = TEXT_MATERIAL_KEYS.iter().map(|key| (*key).to_owned()).collect::<BTreeSet<_>>();
    let mut ids = HashSet::new();
    for material in texts {
        let Some(object) = material.as_object() else { return invalid("文字素材不是对象") };
        if object.keys().cloned().collect::<BTreeSet<_>>() != whitelist {
            return invalid("文字素材含白名单外的键");
        }
        let Some(id) = object.get("id").and_then(Value::as_str) else { return invalid("文字素材缺 id") };
        ids.insert(id);
    }
    let segment_whitelist = text_segment_key_whitelist(draft)?;
    let mut previous_end = 0_i64;
    for segment in &track.segments {
        if segment_keys(segment)? != segment_whitelist {
            return invalid("字幕片段含白名单外的键");
        }
        let range = &segment.target_timerange;
        if segment.source_timerange.is_some()
            || segment.enable_smart_color_adjust != Some(false)
            || segment.render_index != TEXT_RENDER_INDEX
            || range.duration <= 0
            || range.start < previous_end
            || range.start + range.duration > draft.duration
            || !ids.contains(segment.material_id.as_str())
        {
            return invalid("字幕片段时间或引用无效");
        }
        previous_end = range.start + range.duration;
    }
    Ok(())
}

/// 文字段允许的键 = 视频段(0.11.4 形状,11.3.0 上实开过)的键 ∪ [`TEXT_SEGMENT_EXTRA_KEYS`]。
fn text_segment_key_whitelist(draft: &DraftInfo) -> Result<BTreeSet<String>> {
    let video = draft
        .tracks
        .first()
        .and_then(|track| track.segments.first())
        .ok_or_else(|| CoreError::Jianying("字幕轨校验需要视频片段做键集基准".to_owned()))?;
    let mut keys = segment_keys(video)?;
    keys.extend(TEXT_SEGMENT_EXTRA_KEYS.map(str::to_owned));
    Ok(keys)
}

fn segment_keys(segment: &DraftSegment) -> Result<BTreeSet<String>> {
    let value = serde_json::to_value(segment)
        .map_err(|error| CoreError::Jianying(format!("字幕片段序列化失败:{error}")))?;
    Ok(value.as_object().map(|object| object.keys().cloned().collect()).unwrap_or_default())
}

#[cfg(test)]
#[path = "jianying_text_tests.rs"]
mod tests;
