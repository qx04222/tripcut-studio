//! R24 D-1:「字幕写进时间线」开关**关**时,草稿产物必须与 0.11.4(main `4db92f1`)逐字节一致。
//!
//! 证明方式:`testdata/jianying_off_0_11_4.txt` 是在 `4db92f1` 的代码上跑同一个场景
//! (`BASELINE_SCENARIO`:两段、一段带 SRT、带章、多音轨、带配乐)后落盘的整棵草稿目录快照;
//! 快照里只把随机 uuid 换成按出现顺序编号的占位符、把临时根目录换成 `<ROOT>`,其余字节原样。
//! 本测试在当前代码上以「开关关」跑同一场景,归一化后与快照逐字节比对。

use std::path::{Path, PathBuf};

use super::*;

const BASELINE: &str = include_str!("testdata/jianying_off_0_11_4.txt");
const NOW: i64 = 1_758_500_000;
pub(super) const BASELINE_SRT: &str = "1\n00:00:00,500 --> 00:00:01,200\n出发啦\n\n2\n00:00:01,500 --> 00:00:02,800\n海边\n风很大\n\n3\n00:00:03,000 --> 00:00:03,900\n段外这句不进时间线\n";

pub(super) fn baseline_inputs(srt: &Path) -> Vec<DraftInput> {
    let first = DraftInput {
        clip_id: 7,
        file_name: "IMG_0001.mov".to_owned(),
        source_path: PathBuf::from("/Volumes/CARD/IMG_0001.mov"),
        in_ticks: 1_000,
        out_ticks: 2_500,
        tb_num: 1,
        tb_den: 1_000,
        width: 3840,
        height: 2160,
        srt_source: Some(srt.to_path_buf()),
        selected_transcribe_track: Some(1),
        audio_tracks: vec![
            deliver::ExportAudioTrack { stream_index: 0, role_guess: Some("onboard_mic".to_owned()) },
            deliver::ExportAudioTrack { stream_index: 1, role_guess: Some("wireless_mic".to_owned()) },
        ],
        manual_rotation: Some(90),
        chapter_title: "海边".to_owned(),
    };
    let second = DraftInput {
        clip_id: 8,
        file_name: "IMG_0002.mov".to_owned(),
        source_path: PathBuf::from("/Volumes/CARD/IMG_0002.mov"),
        in_ticks: 0,
        out_ticks: 1_001,
        tb_num: 1001,
        tb_den: 30_000,
        width: 1920,
        height: 1080,
        srt_source: None,
        selected_transcribe_track: None,
        audio_tracks: Vec::new(),
        manual_rotation: None,
        chapter_title: String::new(),
    };
    vec![first, second]
}

pub(super) fn baseline_music() -> DraftMusic {
    DraftMusic {
        file_name: "bgm.mp3".to_owned(),
        source_path: PathBuf::from("/Volumes/CARD/bgm.mp3"),
        duration_us: 60_000_000,
    }
}

/// 整棵目录 → 文本:按相对路径排序,目录记一行,文件记路径 + 原始内容。
pub(super) fn dump_tree(root: &Path, directory: &Path) -> String {
    let mut entries = Vec::new();
    collect(directory, directory, &mut entries);
    entries.sort();
    let mut out = String::new();
    for relative in entries {
        let path = directory.join(&relative);
        if path.is_dir() {
            out.push_str(&format!("== dir {relative}\n"));
        } else {
            out.push_str(&format!("== file {relative}\n"));
            out.push_str(&String::from_utf8(std::fs::read(&path).unwrap()).unwrap());
            out.push_str("\n== end\n");
        }
    }
    normalize(&out, root)
}

fn collect(base: &Path, directory: &Path, entries: &mut Vec<String>) {
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        entries.push(path.strip_prefix(base).unwrap().to_string_lossy().into_owned());
        if path.is_dir() {
            collect(base, &path, entries);
        }
    }
}

/// 临时根 → `<ROOT>`;32 位小写十六进制 uuid → `<ID-n>`(按首次出现编号)。
fn normalize(text: &str, root: &Path) -> String {
    let canonical = root.canonicalize().unwrap().to_string_lossy().into_owned();
    let raw = root.to_string_lossy().into_owned();
    let text = text.replace(&canonical, "<ROOT>").replace(&raw, "<ROOT>");
    let chars = text.chars().collect::<Vec<_>>();
    let is_hex = |c: char| c.is_ascii_digit() || ('a'..='f').contains(&c);
    let mut ids: Vec<String> = Vec::new();
    let mut out = String::new();
    let mut index = 0;
    while index < chars.len() {
        let run = chars[index..].iter().take_while(|c| is_hex(**c)).count();
        let bounded = index == 0 || !chars[index - 1].is_ascii_alphanumeric();
        if run == 32 && bounded {
            let id = chars[index..index + 32].iter().collect::<String>();
            let ordinal = match ids.iter().position(|seen| *seen == id) {
                Some(position) => position + 1,
                None => {
                    ids.push(id);
                    ids.len()
                }
            };
            out.push_str(&format!("<ID-{ordinal}>"));
            index += 32;
        } else if run > 0 {
            out.extend(&chars[index..index + run]);
            index += run;
        } else {
            out.push(chars[index]);
            index += 1;
        }
    }
    out
}

pub(super) fn scratch_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!("tripcut-r24-baseline-{}", Uuid::new_v4().simple()));
    std::fs::create_dir(&root).unwrap();
    root
}

/// 同一场景。4db92f1 上生成快照时这里是当时的生产调用
/// `build_draft_with_music(...)` → `build_meta` → `write_draft_atomically(.., &inputs)`;
/// 现在走当前生产路径 `assemble_draft(.., subtitles_on_timeline = false)` → `build_meta` → `write_draft_atomically(.., &cues)`。
fn run_scenario_off(root: &Path) -> String {
    let srt = root.join("source.srt");
    std::fs::write(&srt, BASELINE_SRT).unwrap();
    let drafts = root.join("drafts");
    std::fs::create_dir(&drafts).unwrap();
    let final_path = drafts.join("基线_剪映草稿_00000000");
    let inputs = baseline_inputs(&srt);
    let (draft, cues) =
        assemble_draft("基线", "DRAFT-ID", &inputs, NOW, (1920, 1080), Some(&baseline_music()), false).unwrap();
    assert!(cues.is_empty());
    let meta = build_meta(&draft, &final_path, NOW).unwrap();
    write_draft_atomically(&drafts, &final_path, &draft, &meta, &inputs, &cues).unwrap();
    dump_tree(root, &final_path)
}

/// 生成快照用(只在 4db92f1 上跑过一次):`TRIPCUT_R24_BASELINE_OUT=<file> cargo test ... -- --ignored`。
#[test]
#[ignore]
fn write_off_baseline_fixture() {
    let out = std::env::var("TRIPCUT_R24_BASELINE_OUT").expect("set TRIPCUT_R24_BASELINE_OUT");
    let root = scratch_root();
    let dump = run_scenario_off(&root);
    std::fs::write(out, dump).unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn subtitles_off_output_is_byte_identical_to_0_11_4() {
    let root = scratch_root();
    let dump = run_scenario_off(&root);
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(dump, BASELINE, "开关关时草稿目录必须与 0.11.4 逐字节一致");
}
