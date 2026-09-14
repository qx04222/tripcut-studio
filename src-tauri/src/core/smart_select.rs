//! R11 车道 B:在时刻分上挑「建议段」,以及一键「自动挑选」整集精选段。
//!
//! - `suggest_segments`:滑窗取峰——目标时长内窗口平均分最高的几段,峰间距 ≥ 目标
//!   时长,段内不跨场景切换,最多 3 条。目标时长缺省按本集平台的时长预算落到 4–8 s。
//! - `auto_select_episode`:按章节轮转,从每条素材的最高分建议里挑,凑满预算,
//!   写成 `segments`(kind='select', source='auto', 同一个 batch_id),从不改手打的段。
//! - `undo_auto_select`:只删该批 `source='auto'` 的段。

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use super::error::{CoreError, Result};
use super::moments::{load_moments, ticks_to_seconds, Moment, MOMENT_WINDOW_SECS};

pub const MAX_SUGGESTIONS: usize = 3;
/// 平台预算 0(不限)时自动挑选的缺省预算。
pub const DEFAULT_BUDGET_SECS: f64 = 60.0;
/// 建议段最短 2 s(场景切得太密时退到这个下限)。
const MIN_TARGET_SECS: f64 = 2.0;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SegmentSuggestion {
    pub in_ticks: i64,
    pub out_ticks: i64,
    pub score: f64,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AutoSelectOutcome {
    pub created: Vec<i64>,
    pub total_secs: f64,
    pub chapters_covered: usize,
    pub batch_id: String,
    /// R12 车道 B:挑完默认已「一键排入」镜头带,这是本次排进去的段数;排入失败不影响挑选(0)。
    pub placed: usize,
    /// 排入那一批的批号(给「撤销」只撤排入用);没排进任何段时为 None。
    pub arrange_batch_id: Option<String>,
    /// X-01:实际用的范围(`favorites_or_rated3` / `favorites` / `rated3` / `all`)。
    pub scope_used: String,
    /// X-01:默认范围「收藏 + 3 星以上」一条候选都没有时自动改按「全部」挑了——前端 toast 要说出来。
    pub fell_back: bool,
}

/// 目标时长:按平台时长预算分档——≤15 s 的短平台 4 s,≤60 s 5 s,≤90 s 6 s,更长或不限 8 s。
pub fn target_secs_for_budget(budget_secs: i64) -> f64 {
    match budget_secs {
        1..=15 => 4.0,
        16..=60 => 5.0,
        61..=90 => 6.0,
        _ => 8.0,
    }
}

fn active_episode_id(connection: &Connection) -> Result<i64> {
    connection
        .query_row("SELECT id FROM episodes WHERE status = 'active'", [], |row| row.get(0))
        .optional()?
        .ok_or_else(|| CoreError::Story("没有进行中的集;先新建一集再试".to_owned()))
}

fn platform_budget_secs(connection: &Connection) -> Result<i64> {
    let episode_id = active_episode_id(connection)?;
    Ok(super::platform::resolve_platform(connection, episode_id, None)?.duration_budget_seconds())
}

pub fn default_target_secs(connection: &Connection) -> Result<f64> {
    Ok(target_secs_for_budget(platform_budget_secs(connection)?))
}

pub fn suggest_segments(connection: &Connection, clip_id: i64, target_secs: Option<f64>) -> Result<Vec<SegmentSuggestion>> {
    let target = match target_secs {
        Some(value) if value.is_finite() && value > 0.0 => value,
        Some(_) => return Err(CoreError::Rating("目标时长要是正数秒".to_owned())),
        None => default_target_secs(connection)?,
    };
    let moments = load_moments(connection, clip_id)?;
    Ok(suggest_from_moments(&moments, target, MAX_SUGGESTIONS))
}

/// 纯函数版滑窗取峰。窗口序列要按时间排好;返回按分数降序。
pub fn suggest_from_moments(moments: &[Moment], target_secs: f64, limit: usize) -> Vec<SegmentSuggestion> {
    if moments.is_empty() || limit == 0 {
        return Vec::new();
    }
    let mut span = ((target_secs / MOMENT_WINDOW_SECS).round() as usize).max(1);
    let min_span = ((MIN_TARGET_SECS / MOMENT_WINDOW_SECS).round() as usize).max(1);
    // 整条比目标短:唯一建议就是整条。
    if moments.len() <= span {
        return vec![whole_clip(moments)];
    }
    let mut candidates = candidates_for_span(moments, span, true);
    while candidates.is_empty() && span > min_span {
        span = (span / 2).max(min_span);
        candidates = candidates_for_span(moments, span, true);
    }
    if candidates.is_empty() {
        // 切点比 2 s 还密:放弃「不跨切换」,退到 2 s 段(总比整条硬塞好)。
        candidates = candidates_for_span(moments, span, false);
    }
    candidates.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    let mut picked: Vec<usize> = Vec::new();
    let mut suggestions = Vec::new();
    for (start, score) in candidates {
        if picked.iter().any(|chosen| chosen.abs_diff(start) < span) {
            continue;
        }
        picked.push(start);
        let slice = &moments[start..start + span];
        suggestions.push(SegmentSuggestion {
            in_ticks: slice[0].t_start_ticks,
            out_ticks: slice[slice.len() - 1].t_end_ticks,
            score,
            reasons: majority_reasons(slice),
        });
        if suggestions.len() >= limit {
            break;
        }
    }
    suggestions
}

/// 所有起点及其窗口均分;`avoid_cuts` 时段内(首窗之后)不得有场景切换。
fn candidates_for_span(moments: &[Moment], span: usize, avoid_cuts: bool) -> Vec<(usize, f64)> {
    (0..=moments.len() - span)
        .filter(|start| !avoid_cuts || !moments[start + 1..start + span].iter().any(|moment| moment.scene_cut))
        .map(|start| {
            let slice = &moments[start..start + span];
            let mean = slice.iter().map(|moment| moment.score).sum::<f64>() / span as f64;
            (start, mean)
        })
        .collect()
}

fn whole_clip(moments: &[Moment]) -> SegmentSuggestion {
    SegmentSuggestion {
        in_ticks: moments[0].t_start_ticks,
        out_ticks: moments[moments.len() - 1].t_end_ticks,
        score: moments.iter().map(|moment| moment.score).sum::<f64>() / moments.len() as f64,
        reasons: majority_reasons(moments),
    }
}

/// 段内过半窗口都有的原因,按固定顺序(清晰 → 运动适中 → 曝光正常 → 有人声/有声音)。
fn majority_reasons(slice: &[Moment]) -> Vec<String> {
    const ORDER: [&str; 5] = ["清晰", "运动适中", "曝光正常", "有人声", "有声音"];
    let half = slice.len().div_ceil(2);
    let mut reasons: Vec<String> = ORDER
        .iter()
        .filter(|label| slice.iter().filter(|moment| moment.reasons.iter().any(|reason| reason == *label)).count() >= half)
        .map(|label| (*label).to_owned())
        .collect();
    if reasons.iter().any(|reason| reason == "有人声") {
        reasons.retain(|reason| reason != "有声音");
    }
    reasons
}

// ---------------------------------------------------------------------------
// 自动挑选整集
// ---------------------------------------------------------------------------

/// 范围:`favorites`(收藏)、`rated3`(≥3 星)、`all`(全部);不传 = 收藏 ∪ ≥3 星
/// (新手缺省,不用先去设置)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoSelectScope {
    FavoritesOrRated3,
    Favorites,
    Rated3,
    All,
}

impl AutoSelectScope {
    pub fn parse(scope: Option<&str>) -> Result<Self> {
        match scope {
            None | Some("") | Some("default") | Some("favorites_or_rated3") => Ok(Self::FavoritesOrRated3),
            Some("favorites") => Ok(Self::Favorites),
            Some("rated3") => Ok(Self::Rated3),
            Some("all") => Ok(Self::All),
            Some(other) => Err(CoreError::Rating(format!(
                "挑选范围「{other}」不认识;可选:favorites(收藏)、rated3(≥3 星)、all(全部)"
            ))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::FavoritesOrRated3 => "favorites_or_rated3",
            Self::Favorites => "favorites",
            Self::Rated3 => "rated3",
            Self::All => "all",
        }
    }

    fn sql_predicate(self) -> &'static str {
        const FAVORITE: &str = "COALESCE((SELECT r.value FROM ratings r JOIN segments rs ON rs.id = r.segment_id
                                WHERE rs.clip_id = c.id AND rs.tombstone = 0 AND r.rating_type = 'binary'
                                ORDER BY r.id DESC LIMIT 1), 0) = 1";
        const RATED3: &str = "COALESCE((SELECT r.value FROM ratings r JOIN segments rs ON rs.id = r.segment_id
                              WHERE rs.clip_id = c.id AND rs.tombstone = 0 AND r.rating_type = 'star'
                              ORDER BY r.id DESC LIMIT 1), 0) >= 3";
        match self {
            Self::FavoritesOrRated3 => {
                const BOTH: &str = "(COALESCE((SELECT r.value FROM ratings r JOIN segments rs ON rs.id = r.segment_id
                                WHERE rs.clip_id = c.id AND rs.tombstone = 0 AND r.rating_type = 'binary'
                                ORDER BY r.id DESC LIMIT 1), 0) = 1
                  OR COALESCE((SELECT r.value FROM ratings r JOIN segments rs ON rs.id = r.segment_id
                                WHERE rs.clip_id = c.id AND rs.tombstone = 0 AND r.rating_type = 'star'
                                ORDER BY r.id DESC LIMIT 1), 0) >= 3)";
                BOTH
            }
            Self::Favorites => FAVORITE,
            Self::Rated3 => RATED3,
            Self::All => "1 = 1",
        }
    }
}

#[derive(Debug, Clone)]
struct Candidate {
    clip_id: i64,
    chapter_key: i64,
    suggestion: SegmentSuggestion,
    secs: f64,
}

/// 候选素材:当前集、在线、有时刻分、范围内、**还没有任何存活精选段**(手打或上一批
/// 自动的都算——不重复挑,也不动用户的段)。按章节起始时间排,未分章的排最后。
fn load_candidates(connection: &Connection, scope: AutoSelectScope, target_secs: f64) -> Result<Vec<Candidate>> {
    let episode_id = active_episode_id(connection)?;
    let sql = format!(
        "SELECT c.id, COALESCE(c.chapter_id, -1), c.tb_num, c.tb_den
           FROM clips c
           LEFT JOIN chapters ch ON ch.id = c.chapter_id AND ch.tombstone = 0
          WHERE c.episode_id = ?1 AND c.missing_since IS NULL
            AND EXISTS (SELECT 1 FROM clip_moments m WHERE m.clip_id = c.id)
            AND NOT EXISTS (SELECT 1 FROM segments s WHERE s.clip_id = c.id AND s.kind = 'select' AND s.tombstone = 0)
            AND {}
          ORDER BY ch.start_at IS NULL, ch.start_at, c.chapter_id, c.captured_at, c.id",
        scope.sql_predicate()
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement
        .query_map([episode_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, Option<i64>>(2)?, row.get::<_, Option<i64>>(3)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut candidates = Vec::new();
    for (clip_id, chapter_key, tb_num, tb_den) in rows {
        let (Some(tb_num), Some(tb_den)) = (tb_num, tb_den) else { continue };
        let moments = load_moments(connection, clip_id)?;
        let Some(best) = suggest_from_moments(&moments, target_secs, 1).into_iter().next() else { continue };
        let secs = ticks_to_seconds(best.out_ticks - best.in_ticks, tb_num, tb_den);
        if secs <= 0.0 {
            continue;
        }
        candidates.push(Candidate { clip_id, chapter_key, suggestion: best, secs });
    }
    Ok(candidates)
}

/// 纯函数:章节轮转挑段。每章各自按分数降序,轮流从每章取一条,装得下就收,
/// 直到预算用完或候选耗尽。返回选中的候选(按选中顺序)。
fn rotate_by_chapter(mut candidates: Vec<Candidate>, budget_secs: f64) -> Vec<Candidate> {
    candidates.sort_by(|a, b| b.suggestion.score.total_cmp(&a.suggestion.score));
    let mut chapters: Vec<(i64, Vec<Candidate>)> = Vec::new();
    for candidate in candidates {
        match chapters.iter_mut().find(|(key, _)| *key == candidate.chapter_key) {
            Some((_, list)) => list.push(candidate),
            None => chapters.push((candidate.chapter_key, vec![candidate])),
        }
    }
    let mut chosen = Vec::new();
    let mut total = 0.0;
    let mut cursors = vec![0_usize; chapters.len()];
    loop {
        let mut progressed = false;
        for (index, (_, list)) in chapters.iter().enumerate() {
            while cursors[index] < list.len() {
                let candidate = &list[cursors[index]];
                cursors[index] += 1;
                if total + candidate.secs <= budget_secs + 1e-9 {
                    total += candidate.secs;
                    chosen.push(candidate.clone());
                    progressed = true;
                    break;
                }
            }
        }
        if !progressed {
            break;
        }
    }
    chosen
}

/// X-02:范围里没得挑时,按真实原因说「现在怎么办」——只在分析真没跑完时才提「等分析」。
fn empty_scope_reason(connection: &Connection, scope: AutoSelectScope) -> Result<String> {
    let progress = super::moments::progress(connection)?;
    if progress.pending + progress.running > 0 {
        return Ok("画面分析还没跑完:等状态条显示「分析完成」再试一次".to_owned());
    }
    if scope != AutoSelectScope::All {
        return Ok("这个范围里没有可挑的素材:先收藏几条或给素材打星,或把范围改成「全部」".to_owned());
    }
    let analysed: i64 = connection.query_row(
        "SELECT COUNT(*) FROM clips c
          WHERE c.episode_id = ?1 AND c.missing_since IS NULL
            AND EXISTS (SELECT 1 FROM clip_moments m WHERE m.clip_id = c.id)",
        [active_episode_id(connection)?],
        |row| row.get(0),
    )?;
    Ok(if analysed == 0 {
        "还没有可挑的素材:先在第 1 步导入视频".to_owned()
    } else {
        "素材都已经挑过了:想重挑就先撤销上一批,或在第 2 步手动挑几条".to_owned()
    })
}

pub fn auto_select_episode(
    connection: &mut Connection,
    budget_secs: Option<f64>,
    scope: Option<&str>,
) -> Result<AutoSelectOutcome> {
    let scope = AutoSelectScope::parse(scope)?;
    let platform_budget = platform_budget_secs(connection)?;
    let budget = match budget_secs {
        Some(value) if value.is_finite() && value > 0.0 => value,
        Some(_) => return Err(CoreError::Rating("时长预算要是正数秒".to_owned())),
        None if platform_budget > 0 => platform_budget as f64,
        None => DEFAULT_BUDGET_SECS,
    };
    let target = target_secs_for_budget(platform_budget);
    let mut candidates = load_candidates(connection, scope, target)?;
    // X-01:新手默认范围在全新库(0 收藏、0 打星)里是空的——自动改按「全部」挑,不让流水线停在第 ② 步。
    let mut scope_used = scope;
    let mut fell_back = false;
    if candidates.is_empty() && scope == AutoSelectScope::FavoritesOrRated3 {
        candidates = load_candidates(connection, AutoSelectScope::All, target)?;
        scope_used = AutoSelectScope::All;
        fell_back = !candidates.is_empty();
    }
    if candidates.is_empty() {
        return Err(CoreError::Rating(empty_scope_reason(connection, scope_used)?));
    }
    let chosen = rotate_by_chapter(candidates, budget);
    let batch_id = format!("auto-{}", uuid::Uuid::new_v4().simple());
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut created = Vec::with_capacity(chosen.len());
    let mut total_secs = 0.0;
    let mut chapters = Vec::new();
    for candidate in &chosen {
        super::episode::ensure_clip_writable(&transaction, candidate.clip_id)?;
        transaction.execute(
            "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind, tombstone, source, batch_id)
             VALUES (?1, ?2, ?3, 'select', 0, 'auto', ?4)",
            params![candidate.clip_id, candidate.suggestion.in_ticks, candidate.suggestion.out_ticks, batch_id],
        )?;
        let segment_id = transaction.last_insert_rowid();
        transaction.execute(
            "INSERT INTO ratings(segment_id, rating_type, value, rated_at)
             VALUES (?1, 'binary', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            [segment_id],
        )?;
        created.push(segment_id);
        total_secs += candidate.secs;
        if !chapters.contains(&candidate.chapter_key) {
            chapters.push(candidate.chapter_key);
        }
    }
    transaction.commit()?;
    // R12 §2:挑完就排进镜头带(append,只补新段)。排入失败不能吞掉已经成功的挑选,
    // 只把 placed 记 0,前端会给「排入」按钮让用户再点一次。
    let (placed, arrange_batch_id) = match super::arrange::arrange_selected_segments(connection, super::arrange::ArrangeMode::Append) {
        Ok(outcome) if outcome.placed > 0 => (outcome.placed, Some(outcome.batch_id)),
        Ok(_) => (0, None),
        Err(error) => {
            tracing::warn!(%error, "自动挑选后排入镜头带失败");
            (0, None)
        }
    };
    Ok(AutoSelectOutcome {
        created,
        total_secs,
        chapters_covered: chapters.len(),
        batch_id,
        placed,
        arrange_batch_id,
        scope_used: scope_used.as_str().to_owned(),
        fell_back,
    })
}

/// 只删该批 `source='auto'` 的段(物理删除,评级行级联);手打的段一条不碰。
pub fn undo_auto_select(connection: &mut Connection, batch_id: &str) -> Result<usize> {
    if batch_id.is_empty() {
        return Err(CoreError::Rating("没有可撤销的批次".to_owned()));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let removed = transaction.execute(
        "DELETE FROM segments WHERE batch_id = ?1 AND source = 'auto' AND kind = 'select'",
        [batch_id],
    )?;
    transaction.commit()?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};

    fn moment(index: i64, score: f64, scene_cut: bool, reasons: &[&str]) -> Moment {
        Moment {
            clip_id: 1,
            win_index: index,
            t_start_ticks: index * 500,
            t_end_ticks: index * 500 + 500,
            sharp: 0.0,
            motion: 0.0,
            exposure_ok: true,
            loud: false,
            speech: false,
            scene_cut,
            score,
            reasons: reasons.iter().map(|reason| (*reason).to_owned()).collect(),
        }
    }

    /// 12 s:前 3 s 黑场(0.1)、中间 6 s 好(0.9)、后 3 s 过曝(0.2);切点在 3 s 与 9 s。
    fn synthetic_moments() -> Vec<Moment> {
        (0..24)
            .map(|index| match index {
                0..=5 => moment(index, 0.1, false, &[]),
                6..=17 => moment(index, 0.9, index == 6, &["清晰", "运动适中", "曝光正常"]),
                _ => moment(index, 0.2, index == 18, &["清晰"]),
            })
            .collect()
    }

    #[test]
    fn suggestions_land_in_the_good_middle_and_never_cross_a_cut() {
        let suggestions = suggest_from_moments(&synthetic_moments(), 5.0, MAX_SUGGESTIONS);
        assert_eq!(suggestions.len(), 1, "峰间距 ≥ 目标时长,只有中段能放下一条");
        let best = &suggestions[0];
        assert!(best.in_ticks >= 3000 && best.out_ticks <= 9000, "{best:?}");
        assert_eq!(best.out_ticks - best.in_ticks, 5000);
        assert!((best.score - 0.9).abs() < 1e-9);
        assert_eq!(best.reasons, vec!["清晰", "运动适中", "曝光正常"]);
    }

    #[test]
    fn peaks_keep_their_distance_and_cap_at_three() {
        let moments = (0..60).map(|index| moment(index, if index % 10 == 0 { 0.9 } else { 0.3 }, false, &[])).collect::<Vec<_>>();
        let suggestions = suggest_from_moments(&moments, 4.0, MAX_SUGGESTIONS);
        assert_eq!(suggestions.len(), 3);
        for pair in suggestions.windows(2) {
            assert!((pair[0].in_ticks - pair[1].in_ticks).abs() >= 4000);
        }
        assert!(suggestions[0].score >= suggestions[1].score && suggestions[1].score >= suggestions[2].score);
    }

    #[test]
    fn short_clip_suggests_the_whole_clip_and_dense_cuts_fall_back() {
        let short = (0..4).map(|index| moment(index, 0.5, false, &[])).collect::<Vec<_>>();
        let suggestions = suggest_from_moments(&short, 5.0, MAX_SUGGESTIONS);
        assert_eq!(suggestions.len(), 1);
        assert_eq!((suggestions[0].in_ticks, suggestions[0].out_ticks), (0, 2000));
        // 每 1.5 s 一个切点,8 s 目标放不下,退到 2 s 段。
        let choppy = (0..40).map(|index| moment(index, 0.5, index % 3 == 0 && index > 0, &[])).collect::<Vec<_>>();
        let suggestions = suggest_from_moments(&choppy, 8.0, MAX_SUGGESTIONS);
        assert!(!suggestions.is_empty());
        assert!(suggestions.iter().all(|s| s.out_ticks - s.in_ticks <= 2000));
    }

    #[test]
    fn target_secs_follow_platform_budget_tiers() {
        assert_eq!(target_secs_for_budget(15), 4.0);
        assert_eq!(target_secs_for_budget(60), 5.0);
        assert_eq!(target_secs_for_budget(90), 6.0);
        assert_eq!(target_secs_for_budget(600), 8.0);
        assert_eq!(target_secs_for_budget(0), 8.0);
    }

    fn library() -> (TestDirectory, Connection) {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('v')", []).unwrap();
        (directory, connection)
    }

    fn add_chapter(connection: &Connection, title: &str, start_at: &str) -> i64 {
        connection
            .execute(
                "INSERT INTO chapters(title, start_at, end_at, episode_id)
                 VALUES (?1, ?2, ?2, (SELECT id FROM episodes WHERE status = 'active'))",
                params![title, start_at],
            )
            .unwrap();
        connection.last_insert_rowid()
    }

    /// 20 s 素材,时刻分全 `score`,可选收藏/星级。
    fn add_clip(connection: &mut Connection, chapter_id: i64, score: f64, favorite: bool, stars: i64) -> i64 {
        connection
            .execute(
                "INSERT INTO clips(volume_uuid, rel_path, duration_ticks, tb_num, tb_den, imported_at, quick_hash, episode_id, chapter_id, captured_at)
                 VALUES ('v', '/abs/' || hex(randomblob(4)) || '.mov', 20000, 1, 1000, '2026-09-13T00:00:00Z', 'h',
                         (SELECT id FROM episodes WHERE status = 'active'), ?1, '2026-09-13T00:00:00Z')",
                [chapter_id],
            )
            .unwrap();
        let clip_id = connection.last_insert_rowid();
        for index in 0..40 {
            connection
                .execute(
                    "INSERT INTO clip_moments(clip_id, win_index, t_start_ticks, t_end_ticks, sharp, motion, exposure_ok, loud, speech, scene_cut, score, reasons_json, pipeline, computed_at)
                     VALUES (?1, ?2, ?2 * 500, ?2 * 500 + 500, 0.8, 0.3, 1, 0, 0, 0, ?3, '[\"清晰\"]', 'moments/v1', '2026-09-13T00:00:00Z')",
                    params![clip_id, index, score],
                )
                .unwrap();
        }
        if favorite {
            crate::core::ratings::rate_clip(connection, clip_id, "binary", 1).unwrap();
        }
        if stars > 0 {
            crate::core::ratings::rate_clip(connection, clip_id, "star", stars).unwrap();
        }
        clip_id
    }

    #[test]
    fn auto_select_rotates_across_chapters_within_budget_and_undo_removes_only_auto() {
        let (_directory, mut connection) = library();
        let first = add_chapter(&connection, "机场", "2026-09-13T08:00:00Z");
        let second = add_chapter(&connection, "湖边", "2026-09-13T12:00:00Z");
        let mut clips = Vec::new();
        for (chapter, scores) in [(first, [0.9, 0.8, 0.7]), (second, [0.6, 0.5, 0.4])] {
            for score in scores {
                clips.push(add_clip(&mut connection, chapter, score, true, 0));
            }
        }
        // 一条手打精选段:自动挑选不能动它,也不会给这条素材再加。
        let manual_clip = clips[0];
        let manual = crate::core::ratings::create_select_segment(&mut connection, manual_clip, 1.0, 3.0).unwrap();

        // 通用平台预算 0 → 目标 8 s;30 s 预算装 3 段(8 s × 3 = 24,第四段放不下)。
        let outcome = auto_select_episode(&mut connection, Some(30.0), None).unwrap();
        assert_eq!(outcome.created.len(), 3, "{outcome:?}");
        assert_eq!(outcome.chapters_covered, 2);
        assert!((outcome.total_secs - 24.0).abs() < 1e-9);
        assert!(outcome.batch_id.starts_with("auto-"));
        // R12 §2:挑完默认已排进镜头带 —— 手打那 1 段 + 自动 3 段 = 4 行 story_order,按章成组。
        assert_eq!(outcome.placed, 4, "{outcome:?}");
        assert!(outcome.arrange_batch_id.as_deref().is_some_and(|id| id.starts_with("arr-")));
        let on_band: i64 = connection
            .query_row("SELECT COUNT(*) FROM story_order WHERE tombstone = 0 AND item_kind = 'segment'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(on_band, 4);
        let auto_clips: Vec<i64> = {
            let mut statement = connection.prepare("SELECT clip_id FROM segments WHERE source = 'auto' ORDER BY id").unwrap();
            statement.query_map([], |row| row.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        assert!(!auto_clips.contains(&manual_clip), "已有手打段的素材不再自动加");
        // 轮转:第一章最高(0.8,因 0.9 那条被手打占了)、第二章最高 0.6、再回第一章 0.7。
        assert_eq!(auto_clips, vec![clips[1], clips[3], clips[2]]);

        // 再跑一次:已有段的素材不再重复挑,只剩第二章的两条;第三次范围里没得挑 → 明确报错。
        let again = auto_select_episode(&mut connection, Some(30.0), None).unwrap();
        assert_eq!(again.created.len(), 2);
        assert_eq!(again.chapters_covered, 1);
        assert_eq!(again.placed, 2, "第二批只排新挑的 2 段");
        assert!(auto_select_episode(&mut connection, Some(30.0), None).is_err());

        let removed = undo_auto_select(&mut connection, &outcome.batch_id).unwrap();
        assert_eq!(removed, 3, "只删这一批");
        let remaining: Vec<(i64, String, Option<String>)> = {
            let mut statement = connection.prepare("SELECT id, source, batch_id FROM segments WHERE kind = 'select' AND tombstone = 0 ORDER BY id").unwrap();
            statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        assert_eq!(remaining[0], (manual.id, "manual".to_owned(), None), "手打段原样保留");
        assert_eq!(remaining.len(), 3);
        assert!(remaining[1..].iter().all(|row| row.2.as_deref() == Some(again.batch_id.as_str())));
        // 撤销挑选连带把那批段从镜头带上拿掉(段行物理删除,story_order 级联):带上只剩手打 1 + 第二批 2。
        let on_band_after: i64 = connection
            .query_row("SELECT COUNT(*) FROM story_order WHERE tombstone = 0 AND item_kind = 'segment'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(on_band_after, 3);
        assert_eq!(undo_auto_select(&mut connection, &outcome.batch_id).unwrap(), 0, "撤销幂等");
    }

    #[test]
    fn scope_defaults_to_favorites_or_three_stars() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "一章", "2026-09-13T08:00:00Z");
        let favorite = add_clip(&mut connection, chapter, 0.9, true, 0);
        let starred = add_clip(&mut connection, chapter, 0.8, false, 3);
        let _two_star = add_clip(&mut connection, chapter, 0.7, false, 2);
        let _plain = add_clip(&mut connection, chapter, 0.6, false, 0);
        let outcome = auto_select_episode(&mut connection, Some(600.0), None).unwrap();
        let mut picked: Vec<i64> = {
            let mut statement = connection.prepare("SELECT clip_id FROM segments WHERE batch_id = ?1").unwrap();
            statement.query_map([&outcome.batch_id], |row| row.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        picked.sort_unstable();
        let mut expected = vec![favorite, starred];
        expected.sort_unstable();
        assert_eq!(picked, expected);
        undo_auto_select(&mut connection, &outcome.batch_id).unwrap();
        let all = auto_select_episode(&mut connection, Some(600.0), Some("all")).unwrap();
        assert_eq!(all.created.len(), 4);
        assert!(AutoSelectScope::parse(Some("hero")).is_err());
    }

    /// X-01(R12 验收 P1):全新库(0 收藏、0 打星)按默认范围「收藏 + 3 星以上」必须也能出结果——
    /// 0 候选时自动降级到「全部」,并在结果里说明(`scope_used` / `fell_back`);显式窄范围不降级。
    #[test]
    fn default_scope_falls_back_to_all_on_a_fresh_library_and_says_so() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "一章", "2026-09-13T08:00:00Z");
        let a = add_clip(&mut connection, chapter, 0.9, false, 0);
        let b = add_clip(&mut connection, chapter, 0.8, false, 0);
        let outcome = auto_select_episode(&mut connection, Some(600.0), Some("favorites_or_rated3")).unwrap();
        let mut picked: Vec<i64> = {
            let mut statement = connection.prepare("SELECT clip_id FROM segments WHERE batch_id = ?1").unwrap();
            statement.query_map([&outcome.batch_id], |row| row.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        picked.sort_unstable();
        assert_eq!(picked, vec![a, b]);
        assert!(outcome.fell_back, "{outcome:?}");
        assert_eq!(outcome.scope_used, "all");
        undo_auto_select(&mut connection, &outcome.batch_id).unwrap();

        // 不传 scope 同样是默认 → 同样降级;有收藏时不降级,scope_used 如实。
        let implicit = auto_select_episode(&mut connection, Some(600.0), None).unwrap();
        assert!(implicit.fell_back);
        undo_auto_select(&mut connection, &implicit.batch_id).unwrap();
        crate::core::ratings::rate_clip(&mut connection, a, "binary", 1).unwrap();
        let honest = auto_select_episode(&mut connection, Some(600.0), None).unwrap();
        assert!(!honest.fell_back);
        assert_eq!(honest.scope_used, "favorites_or_rated3");
        assert_eq!(honest.created.len(), 1);
        undo_auto_select(&mut connection, &honest.batch_id).unwrap();

        // 显式「只看收藏」在没收藏的库里不偷偷改范围:报错,且文案是人话、不提「等分析跑完」(分析已完成)。
        crate::core::ratings::clear_clip_rating(&mut connection, a).unwrap();
        let error = auto_select_episode(&mut connection, Some(600.0), Some("favorites")).unwrap_err().to_string();
        assert!(error.contains("把范围改成「全部」"), "{error}");
        assert!(!error.contains("分析"), "{error}");
    }

    /// X-02:「全部」也没得挑时,按真实原因给下一步——没分析好的素材 → 去导入;
    /// 有分析任务在跑 → 等分析;素材都挑过了 → 撤销上一批。
    #[test]
    fn empty_all_scope_explains_the_real_reason() {
        let (_directory, mut connection) = library();
        let empty = auto_select_episode(&mut connection, Some(600.0), None).unwrap_err().to_string();
        assert!(empty.contains("导入"), "{empty}");
        assert!(!empty.contains("分析"), "{empty}");

        connection
            .execute("INSERT INTO jobs(kind, payload, payload_hash, status, attempt, created_at, updated_at) VALUES ('moments', '{}', 'h', 'pending', 0, '2026-09-13T00:00:00Z', '2026-09-13T00:00:00Z')", [])
            .unwrap();
        let analysing = auto_select_episode(&mut connection, Some(600.0), None).unwrap_err().to_string();
        assert!(analysing.contains("分析"), "{analysing}");
        connection.execute("DELETE FROM jobs WHERE kind = 'moments'", []).unwrap();

        let chapter = add_chapter(&connection, "一章", "2026-09-13T08:00:00Z");
        add_clip(&mut connection, chapter, 0.9, false, 0);
        auto_select_episode(&mut connection, Some(600.0), None).unwrap();
        let exhausted = auto_select_episode(&mut connection, Some(600.0), None).unwrap_err().to_string();
        assert!(exhausted.contains("挑过"), "{exhausted}");
    }

    /// V-03 排查结论:自动段与手打段写的是**同一套** tick(秒 → 源 time_base 四舍五入),
    /// 导出失败不是网格不同,而是导出校验对 edit-list / B 帧素材的探法;这里钉住「同界同 tick」。
    #[test]
    fn auto_segment_ticks_equal_manual_segment_ticks_for_the_same_bounds() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "一章", "2026-09-13T08:00:00Z");
        let auto_clip = add_clip(&mut connection, chapter, 0.9, true, 0);
        let manual_clip = add_clip(&mut connection, chapter, 0.1, false, 0);
        let outcome = auto_select_episode(&mut connection, Some(8.0), Some("favorites")).unwrap();
        let (clip_id, in_ticks, out_ticks): (i64, i64, i64) = connection
            .query_row("SELECT clip_id, in_ticks, out_ticks FROM segments WHERE batch_id = ?1", [&outcome.batch_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(clip_id, auto_clip);
        let manual = crate::core::ratings::create_select_segment(
            &mut connection,
            manual_clip,
            ticks_to_seconds(in_ticks, 1, 1000),
            ticks_to_seconds(out_ticks, 1, 1000),
        )
        .unwrap();
        assert_eq!((manual.in_ticks, manual.out_ticks), (in_ticks, out_ticks));
    }

    /// V-02:前端默认 chip 显式发 `favorites_or_rated3`,语义必须是**并集**——
    /// 1 星但收藏的、没收藏但 3 星的,都要在范围里;`rated3` 仍是纯 ≥3 星。
    #[test]
    fn explicit_favorites_or_rated3_is_the_union_and_rated3_stays_pure() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "一章", "2026-09-13T08:00:00Z");
        let favorite_one_star = add_clip(&mut connection, chapter, 0.9, true, 1);
        let three_star_unfavorited = add_clip(&mut connection, chapter, 0.8, false, 3);
        let _two_star = add_clip(&mut connection, chapter, 0.7, false, 2);
        let picked_clips = |connection: &Connection, batch_id: &str| -> Vec<i64> {
            let mut statement = connection.prepare("SELECT clip_id FROM segments WHERE batch_id = ?1 ORDER BY clip_id").unwrap();
            statement.query_map([batch_id], |row| row.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        let mut expected = vec![favorite_one_star, three_star_unfavorited];
        expected.sort_unstable();

        let union = auto_select_episode(&mut connection, Some(600.0), Some("favorites_or_rated3")).unwrap();
        assert_eq!(picked_clips(&connection, &union.batch_id), expected, "收藏 ∪ ≥3 星");
        undo_auto_select(&mut connection, &union.batch_id).unwrap();

        let rated3 = auto_select_episode(&mut connection, Some(600.0), Some("rated3")).unwrap();
        assert_eq!(picked_clips(&connection, &rated3.batch_id), vec![three_star_unfavorited], "rated3 只看星级");
        undo_auto_select(&mut connection, &rated3.batch_id).unwrap();

        let favorites = auto_select_episode(&mut connection, Some(600.0), Some("favorites")).unwrap();
        assert_eq!(picked_clips(&connection, &favorites.batch_id), vec![favorite_one_star], "favorites 只看收藏");
    }
}
