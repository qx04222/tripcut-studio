//! R24 D-1 字幕轨测试。草稿一律写进临时目录,不碰剪映草稿根。

use std::collections::BTreeSet;
use std::path::Path;

use serde_json::Value;

use super::super::baseline_tests::{baseline_inputs, baseline_music, dump_tree, scratch_root, BASELINE_SRT};
use super::super::{assemble_draft, build_meta, golden_key_sets, validate_draft, write_draft_atomically, DraftInfo, DRAFT_INFO_FILE, SUBTITLE_DIRECTORY};
use super::*;
use crate::core::transcribe::parse_srt;

fn keys(value: &Value) -> BTreeSet<String> {
    value.as_object().unwrap().keys().cloned().collect()
}

fn on_draft(root: &Path, subtitles_on_timeline: bool) -> (Vec<DraftInput>, DraftInfo, Vec<TimelineCue>) {
    let srt = root.join("source.srt");
    std::fs::write(&srt, BASELINE_SRT).unwrap();
    let inputs = baseline_inputs(&srt);
    let (draft, cues) =
        assemble_draft("基线", "DRAFT-ID", &inputs, 10, (1920, 1080), Some(&baseline_music()), subtitles_on_timeline).unwrap();
    (inputs, draft, cues)
}

/// 段一入点 1.0 s、出点 2.5 s,时间线起点 0:
/// 「出发啦」0.5–1.2 → 截到 1.0–1.2 → 时间线 0–0.2 s;「海边/风很大」1.5–2.8 → 1.5–2.5 → 0.5–1.5 s;
/// 3.0–3.9 在段外,不进时间线。段二没有转写。
#[test]
fn cues_are_rebased_from_source_timecode_to_the_timeline() {
    let root = scratch_root();
    let (_, draft, cues) = on_draft(&root, true);
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(
        cues,
        [
            TimelineCue { start_us: 0, duration_us: 200_000, text: "出发啦".to_owned() },
            TimelineCue { start_us: 500_000, duration_us: 1_000_000, text: "海边\n风很大".to_owned() },
        ]
    );
    let kinds = draft.tracks.iter().map(|track| track.track_type.as_str()).collect::<Vec<_>>();
    assert_eq!(kinds, ["video", "text", "audio"], "文字轨插在视频轨之后(import_srt 的位置)");
    let text_track = &draft.tracks[1];
    assert_eq!(text_track.name, SUBTITLE_TRACK_NAME);
    assert!(!text_track.is_default_name);
    let ranges = text_track.segments.iter().map(|segment| segment.target_timerange.clone()).collect::<Vec<_>>();
    assert_eq!(
        ranges,
        [DraftTimerange { start: 0, duration: 200_000 }, DraftTimerange { start: 500_000, duration: 1_000_000 }]
    );
}

/// 文字轨与同时导出的「时间线字幕.srt」逐条一致:条数、文字、起止(毫秒)全对上;原片时间码 SRT 照常在。
#[test]
fn text_track_matches_the_exported_timeline_srt_cue_by_cue() {
    let root = scratch_root();
    let (inputs, draft, cues) = on_draft(&root, true);
    let drafts = root.join("drafts");
    std::fs::create_dir(&drafts).unwrap();
    let final_path = drafts.join("字幕草稿");
    let meta = build_meta(&draft, &final_path, 10).unwrap();
    write_draft_atomically(&drafts, &final_path, &draft, &meta, &inputs, &cues).unwrap();

    let written: Value = serde_json::from_slice(&std::fs::read(final_path.join(DRAFT_INFO_FILE)).unwrap()).unwrap();
    let srt = std::fs::read_to_string(final_path.join(SUBTITLE_DIRECTORY).join(TIMELINE_SRT_FILE)).unwrap();
    assert!(final_path.join(SUBTITLE_DIRECTORY).join("001_IMG_0001_7.srt").is_file(), "原片时间码 SRT 照常输出");
    let readme = std::fs::read_to_string(final_path.join("TripCut交付说明.txt")).unwrap();
    assert!(readme.contains("写成剪映文字轨") && readme.contains(TIMELINE_SRT_FILE), "{readme}");
    std::fs::remove_dir_all(&root).unwrap();

    let parsed = parse_srt(&srt).unwrap();
    let segments = written["tracks"][1]["segments"].as_array().unwrap();
    let texts = written["materials"]["texts"].as_array().unwrap();
    assert_eq!(parsed.len(), segments.len());
    assert_eq!(parsed.len(), texts.len());
    for ((cue, segment), material) in parsed.iter().zip(segments).zip(texts) {
        let start = segment["target_timerange"]["start"].as_i64().unwrap();
        let duration = segment["target_timerange"]["duration"].as_i64().unwrap();
        assert_eq!(cue.start_millis, (start + 500) / 1_000);
        assert_eq!(cue.end_millis, (start + duration + 500) / 1_000);
        assert_eq!(segment["material_id"], material["id"]);
        let content: Value = serde_json::from_str(material["content"].as_str().unwrap()).unwrap();
        assert_eq!(content["text"].as_str().unwrap(), cue.text);
        assert_eq!(content["styles"][0]["range"][1].as_u64().unwrap() as usize, cue.text.chars().count());
    }
}

/// 金样门禁不放宽:开了字幕,顶层 / materials 键集仍与 11.3.0 金样**完全相等**;元素级新键只有两份带出处的白名单。
#[test]
fn subtitle_track_keeps_golden_key_sets_and_only_whitelisted_element_keys() {
    let root = scratch_root();
    let (_, draft, _) = on_draft(&root, true);
    std::fs::remove_dir_all(&root).unwrap();
    let value = serde_json::to_value(&draft).unwrap();
    let (golden_top, golden_materials) = golden_key_sets();
    assert_eq!(keys(&value), golden_top);
    assert_eq!(keys(&value["materials"]), golden_materials);

    let whitelist = TEXT_MATERIAL_KEYS.iter().map(|key| (*key).to_owned()).collect::<BTreeSet<_>>();
    for material in value["materials"]["texts"].as_array().unwrap() {
        assert_eq!(keys(material), whitelist);
        assert_eq!(material["type"], "subtitle");
        let content: Value = serde_json::from_str(material["content"].as_str().unwrap()).unwrap();
        assert_eq!(keys(&content), ["styles", "text"].map(str::to_owned).into_iter().collect());
        assert_eq!(
            keys(&content["styles"][0]),
            ["bold", "fill", "italic", "range", "size", "strokes", "underline"].map(str::to_owned).into_iter().collect()
        );
    }
    let video_keys = keys(&value["tracks"][0]["segments"][0]);
    let mut expected = video_keys.clone();
    expected.extend(TEXT_SEGMENT_EXTRA_KEYS.map(str::to_owned));
    for segment in value["tracks"][1]["segments"].as_array().unwrap() {
        assert_eq!(keys(segment), expected);
        assert_eq!(segment["source_timerange"], Value::Null);
        assert_eq!(segment["clip"]["transform"]["y"], -0.8);
        assert_eq!(segment["render_index"], 1);
    }
    assert_eq!(keys(&value["tracks"][1]), keys(&value["tracks"][0]), "轨道对象键集与视频轨相同");
    // 视频 / 配乐段形状不变:不带 enable_smart_color_adjust,source_timerange 是对象。
    assert!(value["tracks"][0]["segments"][0].get("enable_smart_color_adjust").is_none());
    assert!(value["tracks"][2]["segments"][0]["source_timerange"].is_object());
}

#[test]
fn validator_rejects_unknown_text_keys_overlaps_and_orphans() {
    let root = scratch_root();
    let (inputs, draft, _) = on_draft(&root, true);
    std::fs::remove_dir_all(&root).unwrap();
    validate_draft(&draft, inputs.len()).unwrap();

    let mut extra_key = draft.clone();
    extra_key.materials.other.get_mut("texts").unwrap()[0]["time_marks"] = Value::Bool(true);
    assert!(validate_draft(&extra_key, inputs.len()).is_err());

    let mut overlap = draft.clone();
    overlap.tracks[1].segments[1].target_timerange.start = 100_000;
    assert!(validate_draft(&overlap, inputs.len()).is_err());

    let mut orphan = draft.clone();
    orphan.tracks.remove(1);
    assert!(validate_draft(&orphan, inputs.len()).is_err(), "有文字素材却没有文字轨");

    let mut past_end = draft.clone();
    past_end.tracks[1].segments[1].target_timerange.duration = draft.duration;
    assert!(validate_draft(&past_end, inputs.len()).is_err());

    let mut wrong_order = draft;
    wrong_order.tracks.swap(1, 2);
    assert!(validate_draft(&wrong_order, inputs.len()).is_err(), "文字轨必须紧跟视频轨");
}

/// 开关开但没有一条字幕落进精选段(或没有转写)→ 不建空文字轨、不写时间线 SRT,草稿形状同 0.11.4。
#[test]
fn toggle_on_without_usable_subtitles_adds_nothing() {
    let root = scratch_root();
    let srt = root.join("source.srt");
    std::fs::write(&srt, "1\n00:00:05,000 --> 00:00:06,000\n段外\n").unwrap();
    let inputs = baseline_inputs(&srt);
    let (draft, cues) = assemble_draft("基线", "DRAFT-ID", &inputs, 10, (1920, 1080), None, true).unwrap();
    assert!(cues.is_empty());
    assert_eq!(draft.tracks.len(), 1);
    assert!(draft.materials.other["texts"].as_array().unwrap().is_empty());

    let drafts = root.join("drafts");
    std::fs::create_dir(&drafts).unwrap();
    let final_path = drafts.join("空字幕");
    let meta = build_meta(&draft, &final_path, 10).unwrap();
    write_draft_atomically(&drafts, &final_path, &draft, &meta, &inputs, &cues).unwrap();
    let dump = dump_tree(&root, &final_path);
    std::fs::remove_dir_all(&root).unwrap();
    assert!(!dump.contains(TIMELINE_SRT_FILE));
    assert!(dump.contains("字幕没有写入时间线"));
}

/// 原片 SRT 里互相重叠的两条:后一条的开头被截到前一条结尾(同一轨不能重叠)。
#[test]
fn overlapping_source_cues_are_trimmed_not_overlapped() {
    let root = scratch_root();
    let srt = root.join("source.srt");
    std::fs::write(&srt, "1\n00:00:01,000 --> 00:00:02,000\n一\n\n2\n00:00:01,800 --> 00:00:02,400\n二\n").unwrap();
    let inputs = baseline_inputs(&srt);
    let (draft, cues) = assemble_draft("基线", "DRAFT-ID", &inputs, 10, (1920, 1080), None, true).unwrap();
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(cues[0], TimelineCue { start_us: 0, duration_us: 1_000_000, text: "一".to_owned() });
    assert_eq!(cues[1], TimelineCue { start_us: 1_000_000, duration_us: 400_000, text: "二".to_owned() });
    validate_draft(&draft, inputs.len()).unwrap();
}

#[test]
fn timeline_srt_formats_hours_and_rounds_to_milliseconds() {
    let srt = timeline_srt(&[
        TimelineCue { start_us: 3_723_004_499, duration_us: 1_001, text: "甲".to_owned() },
        TimelineCue { start_us: 3_723_010_000, duration_us: 2_000_000, text: "乙\n丙".to_owned() },
    ]);
    assert_eq!(srt, "1\n01:02:03,004 --> 01:02:03,006\n甲\n\n2\n01:02:03,010 --> 01:02:05,010\n乙\n丙\n");
}
