//! R14 算法审计:把带人工标签的素材(合成夹具 + 可选真素材)灌进真实流水线
//! (导入 → analyze_l1 → analyze_motion → 时刻分 → 废片/可救判定),
//! 和标签逐条比对,打印混淆表;有任何不一致就红。
//!
//! 夹具由 `scripts/qa/make-analysis-fixtures.sh <目录>` 生成(视频不入库),
//! 目录里的 `manifest.tsv` 是期望标签。跑法:
//!   TRIPCUT_ANALYSIS_FIXTURES=<目录> [FFMPEG_PATH=…] cargo test --test analysis_labels -- --nocapture
//! 没设环境变量时整个测试跳过(CI 上没有夹具)。
//! 真素材:再设 TRIPCUT_ANALYSIS_REAL=<目录>,该目录同样放一份 manifest.tsv(手工看帧写的标签)。
//! 只看表不让它红:TRIPCUT_ANALYSIS_REPORT_ONLY=1。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use tripcut_studio_lib::core::{analysis, asset_safety, db, import, jobs, moments, motion};

static NEXT_DIR: AtomicU64 = AtomicU64::new(1);

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let unique = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir()
            .join(format!("tripcut-analysis-labels-{}-{unique}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// 一行期望标签。`*` = 不判(记录但不比)。运镜类可以 `a|b` 任一。
#[derive(Debug, Clone)]
struct Expected {
    file: String,
    fields: BTreeMap<String, String>,
}

fn read_manifest(dir: &Path) -> Vec<Expected> {
    let text = fs::read_to_string(dir.join("manifest.tsv"))
        .unwrap_or_else(|error| panic!("读不到 {}/manifest.tsv:{error}", dir.display()));
    let mut lines = text.lines().filter(|line| !line.trim().is_empty() && !line.starts_with('#'));
    let header: Vec<&str> = lines.next().expect("manifest 缺表头").split('\t').collect();
    assert_eq!(header[0], "file");
    lines
        .map(|line| {
            let cells: Vec<&str> = line.split('\t').collect();
            assert_eq!(cells.len(), header.len(), "manifest 行列数不对:{line}");
            Expected {
                file: cells[0].to_owned(),
                fields: header[1..]
                    .iter()
                    .zip(&cells[1..])
                    .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                    .collect(),
            }
        })
        .collect()
}

/// 流水线跑完后,和界面/导出一致口径算出来的标签。
#[derive(Debug, Default)]
struct Actual {
    under: bool,
    over: bool,
    dark: bool,
    oof: bool,
    soft: bool,
    shaky: bool,
    motion: String,
    cuts: i64,
    clipped: bool,
    has_audio: bool,
    exposure_ok: f64,
    /// 时刻分里「运动适中」的窗口占比(静止 0,正常运镜/手持满)。
    moderate: f64,
    safety: String,
    suggestions: Vec<String>,
    raw: String,
}

fn resolve_media(dir: &Path, name: &str) -> PathBuf {
    for ext in ["mp4", "mov", "MOV", "MP4"] {
        let candidate = dir.join(format!("{name}.{ext}"));
        if candidate.is_file() {
            return candidate;
        }
    }
    panic!("找不到素材 {name} 于 {}", dir.display());
}

fn run_pipeline(media: &Path) -> Actual {
    let directory = TestDirectory::new();
    let db_path = directory.0.join("project.db");
    let mut connection = db::open_project(&db_path).unwrap();
    import::start_import_files(&mut connection, &[media.to_path_buf()]).unwrap();
    // 只跑本审计关心的三类任务;其余(代理/波形/转写/维度)直接标完成,不启动外部模型。
    let mut guard = 0;
    while let Some(job) = jobs::claim_next(&mut connection).unwrap() {
        guard += 1;
        assert!(guard < 200, "任务队列没有收敛");
        let result = match job.kind.as_str() {
            "import_probe" => import::run_import_probe(&mut connection, &job).map(|_| ()),
            "analyze_l1" => analysis::run_analyze_l1(&mut connection, &job),
            "analyze_motion" => motion::run_analyze_motion(&mut connection, &job),
            _ => Ok(()),
        };
        result.unwrap_or_else(|error| panic!("{} 任务失败于 {}:{error}", job.kind, media.display()));
        jobs::mark_done(&mut connection, job.id, job.attempt).unwrap();
    }
    asset_safety::refresh_all(&mut connection).unwrap();

    let clip_id: i64 = connection
        .query_row("SELECT id FROM clips ORDER BY id LIMIT 1", [], |row| row.get(0))
        .unwrap();
    let a = analysis::get_clip_analysis(&connection, clip_id).unwrap().expect("clip_analysis 未写入");
    let m = motion::get_clip_motion(&connection, clip_id).unwrap().expect("clip_motion 未写入");
    let moments = moments::load_moments(&connection, clip_id).unwrap();
    let safety = asset_safety::list(&connection)
        .unwrap()
        .into_iter()
        .find(|info| info.clip_id == clip_id)
        .expect("asset_safety 缺行");
    let focus_mean = if a.focus_scores.is_empty() {
        f64::NAN
    } else {
        a.focus_scores.iter().sum::<f64>() / a.focus_scores.len() as f64
    };
    let ratio = analysis::OVEREXPOSED_RATIO_THRESHOLD;
    Actual {
        under: a.underexposed_ratio > ratio,
        over: a.overexposed_ratio > ratio,
        dark: a.exposure_yavg < analysis::DARK_YAVG_THRESHOLD,
        oof: a.out_of_focus_ratio > ratio,
        soft: focus_mean.is_finite() && focus_mean < analysis::SOFT_FOCUS_THRESHOLD,
        shaky: m.is_shaky,
        motion: m.class.clone(),
        cuts: a.scene_count - 1,
        clipped: a.audio_clipped,
        has_audio: a.has_audio,
        exposure_ok: if moments.is_empty() {
            f64::NAN
        } else {
            moments.iter().filter(|moment| moment.exposure_ok).count() as f64 / moments.len() as f64
        },
        moderate: if moments.is_empty() {
            f64::NAN
        } else {
            moments.iter().filter(|moment| moments::motion_moderation(moment.motion) >= 0.6).count() as f64
                / moments.len() as f64
        },
        safety: safety.safety_flag.clone(),
        suggestions: safety.rescue_suggestions.clone(),
        raw: format!(
            "yavg={:.1} under={:.2} over={:.2} oof={:.2} blur={:.2} ent={:.2} mot={:.1} focus={:.0} shake={:.3} pan={:.2} tilt={:.2} zoom={:.2} peak={:?}",
            a.exposure_yavg,
            a.underexposed_ratio,
            a.overexposed_ratio,
            a.out_of_focus_ratio,
            a.blur_mean,
            a.entropy_mean,
            a.motion_mean,
            focus_mean,
            m.shake_score,
            m.pan_ratio,
            m.tilt_ratio,
            m.zoom_corr,
            a.audio_peak_db.map(|value| (value * 10.0).round() / 10.0)
        ) + &format!(" motion[{}]", m.tool_version.split_once(';').map(|(_, rest)| rest).unwrap_or("")),
    }
}

fn flag(value: bool) -> &'static str {
    if value { "1" } else { "0" }
}

/// 返回不一致的字段列表。
fn compare(expected: &Expected, actual: &Actual) -> Vec<String> {
    let mut mismatches = Vec::new();
    let mut check = |key: &str, actual_value: String| {
        let Some(wanted) = expected.fields.get(key) else { return };
        if wanted == "*" {
            return;
        }
        let ok = match key {
            "exposure_ok_min" | "moderate_min" => actual_value.parse::<f64>().is_ok_and(|value| {
                value >= wanted.parse::<f64>().unwrap()
            }),
            "moderate_max" => actual_value.parse::<f64>().is_ok_and(|value| {
                value <= wanted.parse::<f64>().unwrap()
            }),
            "motion" => wanted.split('|').any(|option| option == actual_value),
            _ => *wanted == actual_value,
        };
        if !ok {
            mismatches.push(format!("{key}: 期望 {wanted} 实得 {actual_value}"));
        }
    };
    check("under", flag(actual.under).to_owned());
    check("over", flag(actual.over).to_owned());
    // 「过暗」角标已退场(R14),只记录不比。
    check("oof", flag(actual.oof).to_owned());
    check("soft", flag(actual.soft).to_owned());
    check("shaky", flag(actual.shaky).to_owned());
    check("motion", actual.motion.clone());
    check("cuts", actual.cuts.to_string());
    check("clipped", flag(actual.clipped).to_owned());
    check("has_audio", flag(actual.has_audio).to_owned());
    check("exposure_ok_min", format!("{:.2}", actual.exposure_ok));
    check("moderate_min", format!("{:.2}", actual.moderate));
    check("moderate_max", format!("{:.2}", actual.moderate));
    check("safety", actual.safety.clone());
    mismatches
}

fn audit(dir: &Path, title: &str) -> usize {
    let expected = read_manifest(dir);
    println!("\n== {title}({})", dir.display());
    println!(
        "{:<18} {:>5} {:>4} {:>4} {:>3} {:>4} {:>5} {:<9} {:>4} {:>7} {:>5} {:>6} {:>6}  {:<16} 结论",
        "素材", "欠曝", "过曝", "过暗", "虚焦", "疑焦", "抖动", "运镜", "切点", "削波", "音轨", "曝光OK", "运动适中", "废片/可救"
    );
    let mut failures = 0;
    for item in &expected {
        let actual = run_pipeline(&resolve_media(dir, &item.file));
        let mismatches = compare(item, &actual);
        let verdict = if mismatches.is_empty() {
            "OK".to_owned()
        } else {
            failures += 1;
            format!("MISMATCH {}", mismatches.join("; "))
        };
        println!(
            "{:<18} {:>5} {:>4} {:>4} {:>3} {:>4} {:>5} {:<9} {:>4} {:>7} {:>5} {:>6.2} {:>6.2}  {:<16} {verdict}",
            item.file,
            flag(actual.under),
            flag(actual.over),
            flag(actual.dark),
            flag(actual.oof),
            flag(actual.soft),
            flag(actual.shaky),
            actual.motion,
            actual.cuts,
            flag(actual.clipped),
            flag(actual.has_audio),
            actual.exposure_ok,
            actual.moderate,
            if actual.suggestions.is_empty() {
                actual.safety.clone()
            } else {
                format!("{}[{}]", actual.safety, actual.suggestions.join("/"))
            },
        );
        println!("{:<18}   {}", "", actual.raw);
    }
    failures
}

#[test]
fn labelled_media_matches_pipeline_verdicts() {
    let Some(fixtures) = std::env::var_os("TRIPCUT_ANALYSIS_FIXTURES") else {
        eprintln!("skipping: TRIPCUT_ANALYSIS_FIXTURES 未设置(先跑 scripts/qa/make-analysis-fixtures.sh)");
        return;
    };
    let mut failures = audit(Path::new(&fixtures), "合成夹具");
    if let Some(real) = std::env::var_os("TRIPCUT_ANALYSIS_REAL") {
        failures += audit(Path::new(&real), "真素材(人工看帧标签)");
    }
    if std::env::var_os("TRIPCUT_ANALYSIS_REPORT_ONLY").is_some() {
        eprintln!("REPORT_ONLY:{failures} 条不一致,不判红");
        return;
    }
    assert_eq!(failures, 0, "{failures} 条素材的判定与标签不一致(见上表)");
}
