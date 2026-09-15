//! R18 AI 基线:把带人工真值的语料灌进真实流水线(导入 → L1/时刻分 → 运镜 → 胶片条 → OCR
//! →(可选)CLIP 八维与画面搜索),逐项打命中率并写成一份基线报告。
//!
//! **这是对照组,不是门禁**:本文件只 report,不断任何阈值的红 —— 阈值要等时刻分/搜索
//! 真改过一轮、有前后两张表可比之后再定。会判红的只有两类:
//!   ① 流水线跑挂了(那是基建坏了,不是指标差);
//!   ② 校准探针没红(见 `calibration`:指标不会红的指标不算指标)。
//!
//! 跑法:
//!   TRIPCUT_AI_EVAL_FIXTURES=<scripts/qa/make-ai-fixtures.sh 的输出目录> \
//!   TRIPCUT_AI_EVAL_REAL=<真素材目录,见 qa/ai-eval/SOURCES.md> \
//!   [TRIPCUT_AI_EVAL_OUT=qa/ai-eval/baseline-YYYY-MM-DD.md] \
//!   [FFMPEG_PATH=… FFPROBE_PATH=…] cargo test --test ai_labels -- --nocapture
//! 两个语料目录都没设时整测跳过。
//! TRIPCUT_AI_EVAL_PRINT_HASHES=1:只打印每条的 quick_hash/byte_size(用来补/核 manifest 的两列)。
//! CLIP 侧车要另外备齐(TRIPCUT_CLIP_MODEL_DIR 指向本地模型目录);备不齐时八维与画面搜索
//! 两块会记成「未测量」而不是 0 —— 两者含义完全不同,报告里必须分得开。

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use tripcut_studio_lib::core::{
    analysis, artifacts, clip_dimensions, clip_search, db, import, jobs, moments, motion, ocr,
    smart_select,
};

static NEXT_DIR: AtomicU64 = AtomicU64::new(1);

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let unique = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir()
            .join(format!("tripcut-ai-labels-{}-{unique}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// manifest.tsv 的一行。约定同 `analysis_labels.rs`:`*` = 不判,`a|b` = 任一。
#[derive(Debug, Clone)]
struct Expected {
    file: String,
    fields: BTreeMap<String, String>,
}

impl Expected {
    fn get(&self, key: &str) -> Option<&str> {
        match self.fields.get(key).map(String::as_str) {
            Some("*") | None => None,
            Some(value) => Some(value),
        }
    }
}

fn read_tsv(path: &Path) -> (Vec<String>, Vec<Vec<String>>) {
    let text = fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("读不到 {}:{error}", path.display()));
    let mut lines = text
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.starts_with('#'));
    let header: Vec<String> = lines
        .next()
        .expect("缺表头")
        .split('\t')
        .map(str::to_owned)
        .collect();
    let rows = lines
        .map(|line| {
            let cells: Vec<String> = line.split('\t').map(str::to_owned).collect();
            assert_eq!(cells.len(), header.len(), "列数不对:{line}");
            cells
        })
        .collect();
    (header, rows)
}

/// 合成夹具的真值跟着产物走(脚本生成时一起写的);真素材的真值在**仓库里**
/// (`qa/ai-eval/manifest.tsv`)—— 视频不入库,真值必须入库,两者不在同一个目录。
fn manifest_path(dir: &Path) -> PathBuf {
    let local = dir.join("manifest.tsv");
    if local.is_file() { local } else { PathBuf::from("../qa/ai-eval/manifest.tsv") }
}

fn read_manifest(dir: &Path) -> Vec<Expected> {
    let (header, rows) = read_tsv(&manifest_path(dir));
    assert_eq!(header[0], "file");
    rows.into_iter()
        .map(|cells| Expected {
            file: cells[0].clone(),
            fields: header[1..]
                .iter()
                .cloned()
                .zip(cells[1..].iter().cloned())
                .collect(),
        })
        .collect()
}

/// 语料目录里按文件名(不含扩展名)找素材;真素材分在 DAY1/DAY2 子目录里,所以要递归。
fn resolve_media(dir: &Path, name: &str) -> PathBuf {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if !path.file_name().is_some_and(|n| n.to_string_lossy().starts_with('_')) {
                    stack.push(path);
                }
            } else if path.file_stem().is_some_and(|stem| stem == name) {
                return path;
            }
        }
    }
    panic!("找不到素材 {name} 于 {}", dir.display());
}

/// 一条素材跑完流水线后、和界面同口径读回来的事实。
#[derive(Debug, Default)]
struct Actual {
    clip_id: i64,
    quick_hash: String,
    byte_size: i64,
    /// 八维:维度 → (标签, 置信度)。CLIP 没跑时为空。
    dimensions: BTreeMap<String, (String, f32)>,
    /// OCR 认出的全部文字(按帧顺序)。
    ocr_texts: Vec<String>,
    /// 时刻分里任一窗判了「有人声」。
    speech: bool,
    /// top-1 建议段(秒)。
    best: Option<(f64, f64)>,
    moment_count: usize,
}

struct Corpus {
    title: String,
    dir: PathBuf,
    expected: Vec<Expected>,
    actual: BTreeMap<String, Actual>,
    /// CLIP 侧车是否真的跑起来了(决定八维/搜索是「0」还是「未测量」)。
    clip_ready: bool,
    /// 落地的胶片条条数与 OCR 行数 —— OCR 整体零输出时,下面的「负控」是假绿,报告要说出来。
    strips: usize,
    ocr_rows: usize,
    connection: rusqlite::Connection,
    _directory: TestDirectory,
}

/// 产物类任务(thumbnail / strip)在 `finalize_artifacts` 里已经自己把 job 标完成了,
/// 外面再标一次只会拿到 InvalidTransition —— 那不是失败,别把它当失败。
fn settle(connection: &mut rusqlite::Connection, job: &jobs::Job) {
    if let Err(error) = jobs::mark_done(connection, job.id, job.attempt) {
        let message = error.to_string();
        assert!(message.contains("is not running"), "{} 任务收尾失败:{error}", job.kind);
    }
}

fn clip_enabled() -> bool {
    std::env::var_os("TRIPCUT_CLIP_MODEL_DIR").is_some()
}

/// 整个语料灌进**同一个**工程库 —— 画面搜索与相似聚类是跨素材的,一条一个库测不出来。
fn run_corpus(title: &str, dir: &Path) -> Corpus {
    let expected = read_manifest(dir);
    let directory = TestDirectory::new();
    let db_path = directory.0.join("project.db");
    let cache_root = artifacts::cache_root_for_db(&db_path);
    let mut connection = db::open_project(&db_path).unwrap();

    let media: Vec<PathBuf> = expected.iter().map(|item| resolve_media(dir, &item.file)).collect();
    import::start_import_files(&mut connection, &media).unwrap();

    let want_clip = clip_enabled();
    let mut clip_ready = want_clip;
    let mut guard = 0_u32;
    while let Some(job) = jobs::claim_next(&mut connection).unwrap() {
        guard += 1;
        assert!(guard < 4000, "任务队列没有收敛");
        let outcome = match job.kind.as_str() {
            "import_probe" => import::run_import_probe(&mut connection, &job).map(|_| ()),
            // analyze_l1 顺带把时刻分写进 clip_moments(analysis.rs 里 persist_for_clip),
            // 所以 "moments" 这个任务在这里不用再跑一遍。
            "analyze_l1" => analysis::run_analyze_l1(&mut connection, &job),
            "analyze_motion" => motion::run_analyze_motion(&mut connection, &job),
            // 封面必须真跑:`enqueue_missing_strips` 是按「有 cover 无 strip」筛的,
            // 跳过 thumbnail 就永远排不出胶片条,OCR 也就永远零命中 —— 而零命中会让
            // 下面的 OCR 负控假绿(空集让守卫失败朝开)。
            "thumbnail" => artifacts::run_thumbnail(&mut connection, &job, &cache_root),
            "strip" => artifacts::run_strip(&mut connection, &job, &cache_root).and_then(|()| {
                // 正式流程里这一步由 jobs::run_one_with_owner 挂在 strip 之后,
                // 且被 memory_profile::sidecars_enabled 挡着;评测要的是 OCR 本身的命中率,
                // 不是本机内存档的降级策略,所以这里直接挂。
                ocr::enqueue_after_strip(&mut connection, &job, &cache_root)
            }),
            "ocr_scan" => ocr::run_ocr_scan(&mut connection, &job, &cache_root),
            "clip_embed" if want_clip => clip_search::run_clip_embed(&mut connection, &job),
            "classify_dims" if want_clip => {
                clip_dimensions::run_classify_dims(&mut connection, &job)
            }
            // 转写要 whisper 模型(在业主 profile 里,本轮不碰);其余任务与本基线无关。
            _ => Ok(()),
        };
        match outcome {
            Ok(()) => {}
            Err(error) if job.kind == "clip_embed" || job.kind == "classify_dims" => {
                eprintln!("CLIP 任务 {} 失败,八维/搜索记为未测量:{error}", job.kind);
                clip_ready = false;
            }
            Err(error) if job.kind == "ocr_scan" => {
                eprintln!("OCR 任务失败(当成该条零命中):{error}");
            }
            Err(error) => panic!("{} 任务失败:{error}", job.kind),
        }
        settle(&mut connection, &job);
    }
    // 胶片条不是导入时自动入队的,补一轮再把 strip / ocr_scan 排干。
    if artifacts::enqueue_missing_strips(&mut connection).unwrap() > 0 {
        while let Some(job) = jobs::claim_next(&mut connection).unwrap() {
            let outcome = match job.kind.as_str() {
                "strip" => artifacts::run_strip(&mut connection, &job, &cache_root)
                    .and_then(|()| ocr::enqueue_after_strip(&mut connection, &job, &cache_root)),
                "ocr_scan" => ocr::run_ocr_scan(&mut connection, &job, &cache_root),
                _ => Ok(()),
            };
            if let Err(error) = outcome {
                eprintln!("收尾任务 {} 失败:{error}", job.kind);
            }
            settle(&mut connection, &job);
        }
    }

    let dimensions = clip_dimensions::list_clip_dimensions(&connection).unwrap();
    let target = smart_select::default_target_secs(&connection).unwrap_or(4.0);
    let mut actual = BTreeMap::new();
    for item in &expected {
        let path = resolve_media(dir, &item.file);
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let (clip_id, quick_hash, byte_size, tb_num, tb_den): (i64, String, i64, i64, i64) =
            connection
                .query_row(
                    "SELECT id, quick_hash, byte_size, tb_num, tb_den FROM clips
                     WHERE rel_path = ?1 OR rel_path LIKE ?2",
                    rusqlite::params![name, format!("%/{name}")],
                    |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
                    },
                )
                .unwrap_or_else(|error| panic!("{} 没入库:{error}", item.file));
        let clip_moments = moments::load_moments(&connection, clip_id).unwrap();
        let best = smart_select::suggest_from_moments(&clip_moments, target, 1)
            .first()
            .map(|suggestion| {
                (
                    moments::ticks_to_seconds(suggestion.in_ticks, tb_num, tb_den),
                    moments::ticks_to_seconds(suggestion.out_ticks, tb_num, tb_den),
                )
            });
        actual.insert(
            item.file.clone(),
            Actual {
                clip_id,
                quick_hash,
                byte_size,
                dimensions: dimensions
                    .iter()
                    .filter(|row| row.clip_id == clip_id)
                    .map(|row| (row.dimension.clone(), (row.label.clone(), row.score)))
                    .collect(),
                ocr_texts: ocr::list_hits(&connection, clip_id)
                    .unwrap()
                    .into_iter()
                    .map(|hit| hit.text)
                    .collect(),
                speech: clip_moments.iter().any(|moment| moment.speech),
                best,
                moment_count: clip_moments.len(),
            },
        );
    }

    let strips: usize = connection
        .query_row("SELECT COUNT(*) FROM cache_artifacts WHERE kind = 'strip'", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0) as usize;
    let ocr_rows: usize = connection
        .query_row("SELECT COUNT(*) FROM clip_ocr_texts", [], |row| row.get::<_, i64>(0))
        .unwrap_or(0) as usize;

    Corpus {
        title: title.to_owned(),
        strips,
        ocr_rows,
        dir: dir.to_path_buf(),
        expected,
        actual,
        clip_ready,
        connection,
        _directory: directory,
    }
}

// ---- 指标 ----

#[derive(Debug, Default, Clone, Copy)]
struct Rate {
    hit: usize,
    total: usize,
}

impl Rate {
    fn add(&mut self, hit: bool) {
        self.total += 1;
        self.hit += usize::from(hit);
    }
    fn show(&self) -> String {
        if self.total == 0 {
            "未测量".to_owned()
        } else {
            format!("{}/{} = {:.0}%", self.hit, self.total, 100.0 * self.hit as f64 / self.total as f64)
        }
    }
}

fn any_of(wanted: &str, got: &str) -> bool {
    wanted.split('|').any(|option| option.trim() == got.trim())
}

/// OCR 命中:期望词里任意一条出现在任一帧的文字里(去空格,大小写不敏感)。
fn ocr_hit(wanted: &str, texts: &[String]) -> bool {
    let haystack: String = texts.join(" ").to_lowercase().replace(' ', "");
    wanted
        .split('|')
        .any(|word| !word.trim().is_empty() && haystack.contains(&word.trim().to_lowercase().replace(' ', "")))
}

fn parse_window(value: &str) -> Option<(f64, f64)> {
    let (start, end) = value.split_once('-')?;
    Some((start.trim().parse().ok()?, end.trim().parse().ok()?))
}

fn iou(a: (f64, f64), b: (f64, f64)) -> f64 {
    let inter = (a.1.min(b.1) - a.0.max(b.0)).max(0.0);
    let union = (a.1 - a.0) + (b.1 - b.0) - inter;
    if union <= 0.0 { 0.0 } else { inter / union }
}

#[derive(Debug, Default)]
struct Metrics {
    dimension: BTreeMap<String, Rate>,
    ocr_positive: Rate,
    ocr_negative: Rate,
    speech: Rate,
    speech_false_positive: Rate,
    best_window: Rate,
    hash_match: Rate,
}

const DIMENSION_KEYS: [&str; 5] =
    ["subject", "shot_size", "viewpoint", "function", "person_state"];

fn measure(corpus: &Corpus, ocr_override: Option<&str>, force_no_speech: bool, window_shift: f64) -> Metrics {
    let mut metrics = Metrics::default();
    for item in &corpus.expected {
        let Some(actual) = corpus.actual.get(&item.file) else { continue };
        if let Some(wanted) = item.get("quick_hash") {
            metrics
                .hash_match
                .add(wanted == actual.quick_hash && item.get("byte_size").is_some_and(|size| size == actual.byte_size.to_string()));
        }
        if corpus.clip_ready {
            for key in DIMENSION_KEYS {
                let Some(wanted) = item.get(key) else { continue };
                let got = actual.dimensions.get(key).map(|(label, _)| label.as_str()).unwrap_or("");
                metrics.dimension.entry(key.to_owned()).or_default().add(any_of(wanted, got));
            }
        }
        match ocr_override.or_else(|| item.get("ocr_expect")) {
            Some("-") => metrics.ocr_negative.add(actual.ocr_texts.is_empty()),
            Some(wanted) => metrics.ocr_positive.add(ocr_hit(wanted, &actual.ocr_texts)),
            None => {}
        }
        if let Some(wanted) = item.get("speech") {
            let got = actual.speech && !force_no_speech;
            if wanted == "1" {
                metrics.speech.add(got);
            } else {
                metrics.speech_false_positive.add(!got);
            }
        }
        if let (Some(wanted), Some(got)) = (item.get("best_window").and_then(parse_window), actual.best) {
            let shifted = (wanted.0 + window_shift, wanted.1 + window_shift);
            metrics.best_window.add(iou(shifted, got) >= 0.5);
        }
    }
    metrics
}

#[derive(Debug, Default)]
struct SearchMetrics {
    recall_at_5: Rate,
    mrr_sum: f64,
    queries: usize,
}

fn measure_search(corpus: &Corpus) -> Option<SearchMetrics> {
    if !corpus.clip_ready {
        return None;
    }
    let queries_path = Path::new("../qa/ai-eval/queries.tsv");
    if !queries_path.is_file() {
        return None;
    }
    let (header, rows) = read_tsv(queries_path);
    let query_at = header.iter().position(|key| key == "query")?;
    let relevant_at = header.iter().position(|key| key == "relevant")?;
    let mut metrics = SearchMetrics::default();
    for row in rows {
        let relevant: BTreeSet<i64> = row[relevant_at]
            .split('|')
            .filter_map(|name| corpus.actual.get(name.trim()).map(|actual| actual.clip_id))
            .collect();
        if relevant.is_empty() {
            continue;
        }
        let hits = clip_search::search_clips(&corpus.connection, &row[query_at]).unwrap_or_default();
        metrics.queries += 1;
        metrics
            .recall_at_5
            .add(hits.iter().take(5).any(|hit| relevant.contains(&hit.clip_id)));
        if let Some(rank) = hits.iter().position(|hit| relevant.contains(&hit.clip_id)) {
            metrics.mrr_sum += 1.0 / (rank as f64 + 1.0);
        }
    }
    Some(metrics)
}

// ---- 报告 ----

fn render(corpus: &Corpus, metrics: &Metrics, search: Option<&SearchMetrics>) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "## {}({})\n", corpus.title, corpus.dir.display());
    let _ = writeln!(out, "| 指标 | 值 | 备注 |");
    let _ = writeln!(out, "|---|---|---|");
    for key in DIMENSION_KEYS {
        let rate = metrics.dimension.get(key).copied().unwrap_or_default();
        let note = if corpus.clip_ready { "" } else { "CLIP 未跑" };
        let _ = writeln!(out, "| 八维 top-1 · {key} | {} | {note} |", rate.show());
    }
    let _ = writeln!(out, "| OCR 关键词召回 | {} | 期望词任一命中即算 |", metrics.ocr_positive.show());
    let ocr_note = if corpus.ocr_rows == 0 {
        "**假绿**:全语料 OCR 零输出,这一格只说明 OCR 没跑,不说明它不误报"
    } else {
        "认出任何字即算失败"
    };
    let _ = writeln!(out, "| OCR 负控(不该认出字) | {} | {ocr_note} |", metrics.ocr_negative.show());
    let _ = writeln!(out, "| 胶片条 / OCR 行 | {} / {} | 胶片条为 0 则 OCR 两格都不作数 |", corpus.strips, corpus.ocr_rows);
    let _ = writeln!(out, "| 口播判定 · 召回 | {} | 真值 speech=1 的条 |", metrics.speech.show());
    let _ = writeln!(out, "| 口播判定 · 负控 | {} | 真值 speech=0 的条不该判有人声 |", metrics.speech_false_positive.show());
    let _ = writeln!(out, "| 时刻分最佳窗 IoU≥0.5 | {} | top-1 建议段 vs 人工 best_window |", metrics.best_window.show());
    let _ = writeln!(out, "| quick_hash 对得上 | {} | 对不上说明素材被重切/转码过 |", metrics.hash_match.show());
    match search {
        Some(search) => {
            let _ = writeln!(out, "| 画面搜索 Recall@5 | {} | {} 条 query |", search.recall_at_5.show(), search.queries);
            let _ = writeln!(
                out,
                "| 画面搜索 MRR | {:.3} | |",
                if search.queries == 0 { 0.0 } else { search.mrr_sum / search.queries as f64 }
            );
        }
        None => {
            let _ = writeln!(out, "| 画面搜索 Recall@5 / MRR | 未测量 | CLIP 侧车没跑起来 |");
        }
    }
    let _ = writeln!(out, "\n### 逐条\n");
    let _ = writeln!(out, "| 素材 | 八维(真值→实得) | OCR 实得 | 口播 真/实 | 最佳窗 真/实 | 窗数 |");
    let _ = writeln!(out, "|---|---|---|---|---|---|");
    for item in &corpus.expected {
        let Some(actual) = corpus.actual.get(&item.file) else { continue };
        let dims = DIMENSION_KEYS
            .iter()
            .filter_map(|key| {
                let wanted = item.get(key)?;
                let got = actual.dimensions.get(*key).map(|(label, score)| format!("{label}({score:.2})"));
                // 真值里的 `a|b` 直接写进 Markdown 表格会被当成列分隔符,换成全角竖线。
                Some(format!(
                    "{key} {}→{}",
                    wanted.replace('|', "丨"),
                    got.unwrap_or_else(|| "—".to_owned())
                ))
            })
            .collect::<Vec<_>>()
            .join("<br>");
        let texts = if actual.ocr_texts.is_empty() {
            "(无)".to_owned()
        } else {
            let joined = actual.ocr_texts.join(" / ").replace('|', "丨");
            joined.chars().take(60).collect()
        };
        let _ = writeln!(
            out,
            "| {} | {} | {} | {}/{} | {}/{} | {} |",
            item.file,
            if dims.is_empty() { "—".to_owned() } else { dims },
            texts,
            item.get("speech").unwrap_or("*"),
            u8::from(actual.speech),
            item.get("best_window").unwrap_or("*"),
            actual.best.map(|(a, b)| format!("{a:.1}-{b:.1}")).unwrap_or_else(|| "—".to_owned()),
            actual.moment_count,
        );
    }
    out
}

/// F-4:指标要先证明它会红。用真值做三次定向破坏,对应指标必须掉下去。
/// 不做额外的流水线开销 —— 全部在已经算好的 `Actual` 上重算。
fn calibration(corpus: &Corpus, base: &Metrics) -> Vec<String> {
    let mut lines = Vec::new();
    if base.ocr_positive.hit > 0 {
        let broken = measure(corpus, Some("绝不可能出现的词ZZZ"), false, 0.0);
        assert_eq!(broken.ocr_positive.hit, 0, "校准失败:OCR 召回换成不存在的词后仍然命中");
        lines.push(format!(
            "- OCR 召回:期望词换成不存在的词 → {} → {}(会红)",
            base.ocr_positive.show(),
            broken.ocr_positive.show()
        ));
    }
    if base.speech.hit > 0 {
        let broken = measure(corpus, None, true, 0.0);
        assert_eq!(broken.speech.hit, 0, "校准失败:强制没有人声后口播召回仍然不为 0");
        lines.push(format!(
            "- 口播召回:强制所有窗 speech=false → {} → {}(会红)",
            base.speech.show(),
            broken.speech.show()
        ));
    }
    if base.best_window.hit > 0 {
        let broken = measure(corpus, None, false, 600.0);
        assert_eq!(broken.best_window.hit, 0, "校准失败:真值窗平移 600 s 后 IoU 仍然命中");
        lines.push(format!(
            "- 最佳窗 IoU:真值窗整体平移 600 s → {} → {}(会红)",
            base.best_window.show(),
            broken.best_window.show()
        ));
    }
    lines
}

fn print_hashes(dir: &Path) {
    for item in read_manifest(dir) {
        let path = resolve_media(dir, &item.file);
        let (hash, size) = import::quick_fingerprint(&path).unwrap();
        println!("{}\t{hash}\t{size}", item.file);
    }
}

#[test]
fn ai_corpus_baseline() {
    let fixtures = std::env::var_os("TRIPCUT_AI_EVAL_FIXTURES").map(PathBuf::from);
    let real = std::env::var_os("TRIPCUT_AI_EVAL_REAL").map(PathBuf::from);
    if fixtures.is_none() && real.is_none() {
        eprintln!(
            "skipping: TRIPCUT_AI_EVAL_FIXTURES / TRIPCUT_AI_EVAL_REAL 都没设\
             (先跑 scripts/qa/make-ai-fixtures.sh,真素材见 qa/ai-eval/SOURCES.md)"
        );
        return;
    }
    if std::env::var_os("TRIPCUT_AI_EVAL_PRINT_HASHES").is_some() {
        for dir in [fixtures.as_deref(), real.as_deref()].into_iter().flatten() {
            print_hashes(dir);
        }
        return;
    }

    let mut report = format!(
        "# AI 基线报告\n\n跑于 `cargo test --test ai_labels`。**report-only:本文件不设阈值门禁**,\
         只作为后面改时刻分/搜索/描述时的对照组。指标定义与真值来源见 `qa/ai-eval/NOTES.md`。\n\n\
         - CLIP 侧车:{}\n- OCR 侧车:随包 `sidecar-ocr`(Swift/Vision)\n\
         - 转写:**未跑**(whisper 模型在业主 profile 里,本轮规则不碰),所以没有 CER 一项\n\n",
        if clip_enabled() { "已配置 TRIPCUT_CLIP_MODEL_DIR" } else { "**未配置**,八维与画面搜索记为未测量" }
    );

    for (title, dir) in [("合成夹具", fixtures), ("真素材(人工看帧真值)", real)] {
        let Some(dir) = dir else { continue };
        let corpus = run_corpus(title, &dir);
        let metrics = measure(&corpus, None, false, 0.0);
        let search = measure_search(&corpus);
        report.push_str(&render(&corpus, &metrics, search.as_ref()));
        let calibrated = calibration(&corpus, &metrics);
        if !calibrated.is_empty() {
            report.push_str("\n#### 校准(先让它红过)\n\n");
            for line in calibrated {
                report.push_str(&line);
                report.push('\n');
            }
        }
        report.push('\n');
    }

    print!("{report}");
    if let Some(out) = std::env::var_os("TRIPCUT_AI_EVAL_OUT") {
        let out = PathBuf::from(out);
        if let Some(parent) = out.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(&out, &report).unwrap_or_else(|error| panic!("写不了 {}:{error}", out.display()));
        eprintln!("基线报告已写入 {}", out.display());
    }
}
