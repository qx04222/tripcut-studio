//! R11 车道 B:在时刻分上挑「建议段」,以及一键「自动挑选」整集精选段。
//!
//! - `suggest_segments`:滑窗取峰——目标时长内窗口平均分最高的几段,峰间距 ≥ 目标
//!   时长,段内不跨场景切换,最多 3 条。目标时长缺省按本集平台的时长预算落到 4–8 s。
//! - `auto_select_episode`:按章节轮转,从每条素材的最高分建议里挑,凑满预算,
//!   写成 `segments`(kind='select', source='auto', 同一个 batch_id),从不改手打的段。
//! - `undo_auto_select`:只删该批 `source='auto'` 的段。

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::error::{CoreError, Result};
use super::moments::{load_moments, score_moment, ticks_to_seconds, Moment, MomentWeights, MOMENT_WINDOW_SECS};

#[path = "smart_select_reason.rs"]
pub mod reason;

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
    /// R19 P-03:这一批的 run id(= `batch_id`,`auto_select_runs.run_id`),结果面板按它列「这批还剩什么」。
    pub run_id: String,
}

/// R19 P-01 / P-09:挑法 —— `Chapters` 按章节轮转(成片按时间顺序、每章都有份,缺省);
/// `Score` 不管章节、只按分数从高到低装满预算(「按分数挑」/ 快节奏预设)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AutoSelectPick {
    #[default]
    Chapters,
    Score,
}

impl AutoSelectPick {
    pub fn parse(pick: Option<&str>) -> Result<Self> {
        match pick {
            None | Some("") | Some("chapters") => Ok(Self::Chapters),
            Some("score") => Ok(Self::Score),
            Some(other) => Err(CoreError::Rating(format!("挑法「{other}」不认识;可选:chapters(按时间顺序)、score(按分数)"))),
        }
    }
}

/// R19 P-01:一次自动挑选的全部参数;原样存进 `auto_select_runs.params_json`(加上算出来的 `target_secs`),
/// 「换一段」按同一份参数找备选。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct AutoSelectParams {
    pub budget_secs: Option<f64>,
    pub scope: Option<String>,
    /// 权重偏置(一句话里的「风景 / 运动 / 安静」…):有就按它**临时重打**候选素材的时刻分,不改库里的分。
    pub weights: Option<MomentWeights>,
    #[serde(default)]
    pub pick: AutoSelectPick,
    /// 用户原句(P-01),只做记录。
    pub prompt: Option<String>,
    /// 段目标时长(按平台预算分档算出),存下来给「换一段」复用;调用方不填。
    #[serde(default)]
    pub target_secs: Option<f64>,
    /// None = mixed, true = photos, false = videos.
    #[serde(default)]
    pub only_photos: Option<bool>,
    #[serde(default)]
    pub photo_count: Option<usize>,
}

/// 按权重偏置临时重打一条素材的时刻分(`weights` 为空就是库里的原分)。
pub(crate) fn moments_with_weights(connection: &Connection, clip_id: i64, weights: Option<&MomentWeights>) -> Result<Vec<Moment>> {
    let mut moments = load_moments(connection, clip_id)?;
    if let Some(weights) = weights {
        // 偏置时六项全算、无声素材的声音项记 0(不像入库打分那样把声音从分母里剔掉)——
        // 否则「有声 / 人物为主」永远压不住无声素材:它们的分母里根本没有声音这一项。
        for moment in &mut moments {
            let quality = reason::Reason::from_labels(&moment.reasons);
            score_moment(moment, weights, true);
            moment.reasons.extend(quality.fixable);
            moment.reasons.extend(quality.blockers);
        }
    }
    if let Some(analysis) = super::analysis::get_clip_analysis(connection, clip_id)? {
        let threshold = super::analysis::OVEREXPOSED_RATIO_THRESHOLD;
        for moment in &mut moments {
            // 汇总信号不冒充逐窗定位。只给曝光不正常的窗补方向;失焦汇总保守阻止整条。
            if !moment.exposure_ok {
                if analysis.overexposed_ratio > threshold { moment.reasons.push("曝光偏亮".to_owned()); }
                if analysis.underexposed_ratio > threshold { moment.reasons.push("曝光偏暗".to_owned()); }
            }
            if analysis.out_of_focus_ratio > threshold { moment.reasons.push("失焦".to_owned()); }
        }
    }
    Ok(moments)
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
    if super::photo_probe::is_photo(connection, clip_id)? { return Ok(Vec::new()); }
    let target = match target_secs {
        Some(value) if value.is_finite() && value > 0.0 => value,
        Some(_) => return Err(CoreError::Rating("目标时长要是正数秒".to_owned())),
        None => default_target_secs(connection)?,
    };
    let moments = moments_with_weights(connection, clip_id, None)?;
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
        return if !reason::has_blocker(moments) { vec![whole_clip(moments)] } else { Vec::new() };
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
        .filter(|start| !reason::has_blocker(&moments[*start..*start + span]))
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
    let quality = reason::Reason::from_moments(slice);
    reasons.extend(quality.fixable);
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

    pub(crate) fn sql_predicate(self) -> &'static str {
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
    /// R18 B-4:这条素材所在的相似组(同一机位连拍的几条)。`None` = 不在任何组里。
    similar_group: Option<i64>,
}

/// 候选素材:当前集、在线、有时刻分、范围内、**还没有任何存活精选段**(手打或上一批
/// 自动的都算——不重复挑,也不动用户的段)。按章节起始时间排,未分章的排最后。
fn load_candidates(connection: &Connection, scope: AutoSelectScope, target_secs: f64, weights: Option<&MomentWeights>, only_photos: Option<bool>, unselected: &mut Vec<reason::Unselected>) -> Result<Vec<Candidate>> {
    let episode_id = active_episode_id(connection)?;
    let sql = format!(
        "SELECT c.id, COALESCE(c.chapter_id, -1), c.tb_num, c.tb_den
           FROM clips c
           LEFT JOIN chapters ch ON ch.id = c.chapter_id AND ch.tombstone = 0
          WHERE c.episode_id = ?1 AND c.missing_since IS NULL
            AND (c.kind = 'photo' OR EXISTS (SELECT 1 FROM clip_moments m WHERE m.clip_id = c.id))
            AND NOT EXISTS (SELECT 1 FROM segments s WHERE s.clip_id = c.id AND s.kind = 'select' AND s.tombstone = 0)
            -- 照片显式按 X 后不能被 scope=all 再挑回来。只读 non-select 段上
            -- 最新 binary，和 list_clips / selected_clips 的照片判定一致；0/F 可候选。
            -- 视频继续沿用既有 scope 规则，不受这道照片 gate 影响。
            AND (c.kind != 'photo' OR COALESCE((
                SELECT r.value FROM ratings r
                JOIN segments rs ON rs.id = r.segment_id
                WHERE rs.clip_id = c.id AND rs.tombstone = 0
                  AND COALESCE(rs.kind, 'whole') != 'select'
                  AND r.rating_type = 'binary'
                ORDER BY r.rated_at DESC, r.id DESC LIMIT 1
            ), 0) != -1)
            AND {}
          ORDER BY ch.start_at IS NULL, ch.start_at, c.chapter_id, c.captured_at, c.id",
        scope.sql_predicate()
    );
    let groups = super::similar::group_id_by_clip(connection)?;
    let mut statement = connection.prepare(&sql)?;
    let rows = statement
        .query_map([episode_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, Option<i64>>(2)?, row.get::<_, Option<i64>>(3)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut candidates = Vec::new();
    for (clip_id, chapter_key, tb_num, tb_den) in rows {
        let photo = super::photo_probe::is_photo(connection, clip_id)?;
        if only_photos.is_some_and(|only| only != photo) { continue; }
        if photo {
            if let Some(candidate) = photo_candidate(connection, clip_id, chapter_key, groups.get(&clip_id).copied())? {
                candidates.push(candidate);
            }
            continue;
        }
        let (Some(tb_num), Some(tb_den)) = (tb_num, tb_den) else { continue };
        let moments = moments_with_weights(connection, clip_id, weights)?;
        let Some(best) = suggest_from_moments(&moments, target_secs, 1).into_iter().next() else {
            let blockers = reason::Reason::from_moments(&moments).blockers;
            if !blockers.is_empty() { unselected.push(reason::Unselected { clip_id, blockers }); }
            continue;
        };
        let secs = ticks_to_seconds(best.out_ticks - best.in_ticks, tb_num, tb_den);
        if secs <= 0.0 {
            continue;
        }
        candidates.push(Candidate {
            clip_id,
            chapter_key,
            suggestion: best,
            secs,
            similar_group: groups.get(&clip_id).copied(),
        });
    }
    Ok(candidates)
}

fn photo_candidate(connection: &Connection, clip_id: i64, chapter_key: i64, group: Option<i64>) -> Result<Option<Candidate>> {
    let Some(analysis) = super::analysis::get_clip_analysis(connection, clip_id)? else { return Ok(None); };
    let threshold = super::analysis::OVEREXPOSED_RATIO_THRESHOLD;
    if analysis.underexposed_ratio > threshold || analysis.overexposed_ratio > threshold
        || analysis.out_of_focus_ratio > threshold { return Ok(None); }
    let count = if let Some(group_id) = group {
        let primary: bool = connection.query_row(
            "SELECT is_primary FROM similar_group_members WHERE group_id=?1 AND clip_id=?2",
            params![group_id,clip_id], |r| r.get(0))?;
        if !primary {
            // 人工/擂台选出的 persisted primary 仍优先；只有它后来被用户显式 X，
            // 才让健康 siblings 重新参与，交给既有 dedupe_by_score 选同组最佳。
            let primary_rejected: bool = connection.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM similar_group_members primary_member
                    WHERE primary_member.group_id=?1 AND primary_member.is_primary=1
                      AND -1=(
                        SELECT r.value FROM ratings r
                        JOIN segments rs ON rs.id=r.segment_id
                        WHERE rs.clip_id=primary_member.clip_id AND rs.tombstone=0
                          AND COALESCE(rs.kind,'whole')!='select'
                          AND r.rating_type='binary'
                        ORDER BY r.rated_at DESC,r.id DESC LIMIT 1
                      )
                )",[group_id],|r|r.get(0))?;
            if !primary_rejected { return Ok(None); }
        }
        let selected: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM similar_group_members m JOIN segments s ON s.clip_id=m.clip_id
                WHERE m.group_id=?1 AND s.kind='select' AND s.tombstone=0
                  AND COALESCE((
                    SELECT r.value FROM ratings r
                    JOIN segments rs ON rs.id=r.segment_id
                    WHERE rs.clip_id=m.clip_id AND rs.tombstone=0
                      AND COALESCE(rs.kind,'whole')!='select'
                      AND r.rating_type='binary'
                    ORDER BY r.rated_at DESC,r.id DESC LIMIT 1
                  ),0)!=-1)", [group_id], |r| r.get(0))?;
        if selected { return Ok(None); }
        connection.query_row("SELECT count(*) FROM similar_group_members WHERE group_id=?1", [group_id], |r| r.get::<_, i64>(0))?
    } else { 1 };
    let hold_ms: Option<i64> = connection.query_row("SELECT hold_ms FROM photo_meta WHERE clip_id=?1 AND error IS NULL", [clip_id], |r| r.get(0)).optional()?;
    let Some(hold_ms) = hold_ms.filter(|v| *v > 0) else { return Ok(None); };
    let focus = if analysis.focus_scores.is_empty() { 0.0 } else { analysis.focus_scores.iter().sum::<f64>() / analysis.focus_scores.len() as f64 };
    Ok(Some(Candidate {
        clip_id, chapter_key, similar_group: group, secs: hold_ms as f64 / 1000.0,
        suggestion: SegmentSuggestion { in_ticks: 0, out_ticks: 0,
            score: 100.0 * focus / (focus + super::analysis::SOFT_FOCUS_THRESHOLD),
            reasons: vec![if count > 1 { format!("同组 {count} 张最清晰") } else { "唯一一张".to_owned() }],
        },
    }))
}

#[cfg(test)]
mod photo_selection_tests {
    use super::*;
    use crate::core::{analysis, jobs, similar, smart_select_runs};

    fn add_photo(connection: &mut Connection, file: &str, time: &str, hold: i64) -> i64 {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../qa/ai-eval/photos").join(file);
        let (hash, _) = crate::core::import::quick_fingerprint(&path).unwrap();
        connection.execute("INSERT INTO clips(volume_uuid,rel_path,quick_hash,kind,episode_id,tb_num,tb_den,duration_ticks,captured_at)
            VALUES('v',?1,?2,'photo',(SELECT id FROM episodes WHERE status='active'),1,1000,0,?3)",params![path.to_str().unwrap(),hash,time]).unwrap();
        let id = connection.last_insert_rowid();
        connection.execute("INSERT INTO photo_meta(clip_id,width,height,camera,taken_at,hold_ms) VALUES(?1,512,384,'fixture-camera',?2,?3)",params![id,time,hold]).unwrap();
        let job_id = analysis::enqueue_for_clip(connection,id,&path,&hash).unwrap().unwrap();
        connection.execute("UPDATE jobs SET status='running',attempt=1 WHERE id=?1",[job_id]).unwrap();
        let job = jobs::get(connection,job_id).unwrap();
        analysis::run_analyze_l1(connection,&job).unwrap();
        jobs::mark_done(connection,job_id,job.attempt).unwrap();
        id
    }

    fn regroup(connection: &mut Connection) {
        let id = similar::enqueue_if_ready(connection).unwrap().unwrap();
        connection.execute("UPDATE jobs SET status='running',attempt=1 WHERE id=?1",[id]).unwrap();
        let job = jobs::get(connection,id).unwrap();
        similar::run_similar_cluster(connection,&job).unwrap();
        jobs::mark_done(connection,id,job.attempt).unwrap();
    }

    #[test]
    fn photo_primary_recomputes_from_quality_and_count_is_persisted() {
        let (_directory,mut connection) = tests::library();
        let a = add_photo(&mut connection,"IMG_0000.png","2026-09-19T12:00:00Z",7_000);
        let b = add_photo(&mut connection,"IMG_0010.png","2026-09-19T12:00:05Z",4_000);
        add_photo(&mut connection,"IMG_0100.png","2026-09-19T14:00:00Z",3_000);
        connection.execute("UPDATE clip_analysis SET focus_scores='[1000]' WHERE clip_id=?1",[a]).unwrap();
        regroup(&mut connection);
        assert!(similar::similar_groups(&connection).unwrap()[0].members.iter().any(|m| m.clip_id==a && m.is_primary));
        connection.execute("UPDATE clip_analysis SET focus_scores='[2000]' WHERE clip_id=?1",[b]).unwrap();
        regroup(&mut connection);
        let groups = similar::similar_groups(&connection).unwrap();
        assert_eq!(groups[0].members.iter().filter(|m|m.is_primary).count(),1);
        assert!(groups[0].members.iter().any(|m|m.clip_id==b && m.is_primary));
        let out = auto_select_episode_with(&mut connection,AutoSelectParams {
            scope:Some("all".into()),only_photos:Some(true),photo_count:Some(1),..Default::default()
        }).unwrap();
        let view = smart_select_runs::list_run(&connection,&out.run_id).unwrap();
        assert_eq!(view.params.photo_count,Some(1));
        assert_eq!(view.rows.len(),1);
        assert_eq!(view.rows[0].clip_id,b);
        assert_eq!(view.rows[0].reasons,vec!["同组 2 张最清晰"]);
        assert_eq!(out.total_secs,4.0);
        assert_eq!(out.placed, 0);
        assert!(out.arrange_batch_id.is_none());
        let on_video_band: i64 = connection.query_row("SELECT COUNT(*) FROM story_order WHERE tombstone=0", [], |row| row.get(0)).unwrap();
        assert_eq!(on_video_band, 0);
    }

    #[test]
    fn photo_mixed_hold_budget_and_media_filters() {
        let (_directory,mut connection) = tests::library();
        let photo = add_photo(&mut connection,"quality-10.png","2026-09-19T12:00:00Z",7_000);
        let chapter = tests::add_chapter(&connection,"Video","2026-09-19T12:00:00Z");
        let video = tests::add_clip(&mut connection,chapter,200.0,false,0);
        for (filter, expected) in [(Some(false),video),(Some(true),photo)] {
            let out = auto_select_episode_with(&mut connection,AutoSelectParams {
                scope:Some("all".into()),only_photos:filter,budget_secs:Some(30.0),..Default::default()
            }).unwrap();
            let view = smart_select_runs::list_run(&connection,&out.run_id).unwrap();
            assert_eq!(view.rows.len(),1); assert_eq!(view.rows[0].clip_id,expected);
            if expected==photo { assert_eq!(view.rows[0].secs,7.0); assert_eq!(view.rows[0].reasons,vec!["唯一一张"]); }
            undo_auto_select(&mut connection,&out.batch_id).unwrap();
        }
        let budget = default_target_secs(&connection).unwrap() + 7.0;
        let out = auto_select_episode(&mut connection,Some(budget),Some("all")).unwrap();
        assert_eq!(out.created.len(),1);
        let view = smart_select_runs::list_run(&connection,&out.run_id).unwrap();
        assert_eq!(view.params.only_photos,Some(false));
        assert_eq!(view.rows.len(),1);
        assert_eq!(view.rows[0].clip_id,video);
        assert!(out.total_secs<budget,"照片 hold_ms 不得进入视频自动挑选预算");
        eprintln!("R21 legacy video auto-select excludes photo hold from {budget}s budget");
    }

    #[test]
    fn photo_candidates_honor_explicit_reject_clear_and_favorite_without_changing_video() {
        let (_directory, mut connection) = tests::library();
        let rejected = add_photo(&mut connection,"quality-10.png","2026-09-19T12:00:00Z",3_000);
        let cleared = add_photo(&mut connection,"quality-11.png","2026-09-19T12:00:01Z",3_000);
        let favorite = add_photo(&mut connection,"quality-12.png","2026-09-19T12:00:02Z",3_000);
        crate::core::ratings::rate_clip(&mut connection,rejected,"binary",-1).unwrap();
        crate::core::ratings::rate_clip(&mut connection,cleared,"binary",-1).unwrap();
        crate::core::ratings::rate_clip(&mut connection,cleared,"binary",0).unwrap();
        crate::core::ratings::rate_clip(&mut connection,favorite,"binary",1).unwrap();

        let mut unselected = Vec::new();
        let photos = load_candidates(
            &connection,AutoSelectScope::All,5.0,None,Some(true),&mut unselected,
        ).unwrap();
        let photo_ids = photos.iter().map(|candidate|candidate.clip_id).collect::<Vec<_>>();
        assert!(!photo_ids.contains(&rejected),"显式 X 的照片不能再进一句话挑选");
        assert!(photo_ids.contains(&cleared),"binary=0 是清除，照片应恢复候选资格");
        assert!(photo_ids.contains(&favorite),"F 收藏的照片仍是候选");

        let chapter = tests::add_chapter(&connection,"视频对照","2026-09-19T12:00:00Z");
        let video = tests::add_clip(&mut connection,chapter,1.0,false,0);
        crate::core::ratings::rate_clip(&mut connection,video,"binary",-1).unwrap();
        let mut video_unselected = Vec::new();
        let videos = load_candidates(
            &connection,AutoSelectScope::All,5.0,None,Some(false),&mut video_unselected,
        ).unwrap();
        assert!(videos.iter().any(|candidate|candidate.clip_id==video),"视频 scope=all 的既有候选语义不变");
    }

    #[test]
    fn rejected_group_primary_falls_back_to_a_healthy_sibling_and_fills_the_count() {
        let (_directory, mut connection) = tests::library();
        let primary = add_photo(&mut connection,"quality-13.png","2026-09-19T12:00:00Z",3_000);
        let sibling = add_photo(&mut connection,"quality-14.png","2026-09-19T12:00:01Z",3_000);
        let outside = add_photo(&mut connection,"quality-15.png","2026-09-19T12:00:02Z",3_000);
        connection.execute("INSERT INTO similar_groups(created_at) VALUES('2026-09-19T12:01:00Z')",[]).unwrap();
        let group_id = connection.last_insert_rowid();
        connection.execute(
            "INSERT INTO similar_group_members(group_id,clip_id,is_primary) VALUES(?1,?2,1),(?1,?3,0)",
            params![group_id,primary,sibling],
        ).unwrap();

        let mut before_unselected = Vec::new();
        let before = load_candidates(
            &connection,AutoSelectScope::All,5.0,None,Some(true),&mut before_unselected,
        ).unwrap();
        assert!(before.iter().any(|candidate|candidate.clip_id==primary));
        assert!(!before.iter().any(|candidate|candidate.clip_id==sibling),"未 X 时保留人工 primary");

        crate::core::ratings::rate_clip(&mut connection,primary,"binary",-1).unwrap();
        let outcome = auto_select_episode_with(&mut connection,AutoSelectParams {
            scope:Some("all".into()),only_photos:Some(true),photo_count:Some(2),..Default::default()
        }).unwrap();
        let selected = smart_select_runs::list_run(&connection,&outcome.run_id).unwrap()
            .rows.into_iter().map(|row|row.clip_id).collect::<Vec<_>>();
        assert_eq!(outcome.created.len(),2,"拒绝主图后应由健康 sibling 补足 N");
        assert!(!selected.contains(&primary));
        assert!(selected.contains(&sibling));
        assert!(selected.contains(&outside));
    }

    #[test]
    fn rejecting_an_already_selected_primary_reopens_its_healthy_sibling() {
        let (_directory, mut connection) = tests::library();
        let primary = add_photo(&mut connection,"quality-16.png","2026-09-19T12:00:00Z",3_000);
        let sibling = add_photo(&mut connection,"quality-17.png","2026-09-19T12:00:01Z",3_000);
        connection.execute("INSERT INTO similar_groups(created_at) VALUES('2026-09-19T12:01:00Z')",[]).unwrap();
        let group_id = connection.last_insert_rowid();
        connection.execute(
            "INSERT INTO similar_group_members(group_id,clip_id,is_primary) VALUES(?1,?2,1),(?1,?3,0)",
            params![group_id,primary,sibling],
        ).unwrap();

        let first = auto_select_episode_with(&mut connection,AutoSelectParams {
            scope:Some("all".into()),only_photos:Some(true),photo_count:Some(1),..Default::default()
        }).unwrap();
        let first_ids = smart_select_runs::list_run(&connection,&first.run_id).unwrap()
            .rows.into_iter().map(|row|row.clip_id).collect::<Vec<_>>();
        assert_eq!(first_ids,vec![primary]);

        crate::core::ratings::rate_clip(&mut connection,primary,"binary",-1).unwrap();
        let candidates = |connection: &Connection| {
            let mut unselected = Vec::new();
            load_candidates(connection,AutoSelectScope::All,5.0,None,Some(true),&mut unselected)
                .unwrap().into_iter().map(|candidate|candidate.clip_id).collect::<Vec<_>>()
        };
        assert!(candidates(&connection).contains(&sibling),"select→X 应重新放行健康 sibling");
        crate::core::ratings::rate_clip(&mut connection,primary,"binary",0).unwrap();
        assert!(!candidates(&connection).contains(&sibling),"0 清除拒绝后 live select 继续防重");
        crate::core::ratings::rate_clip(&mut connection,primary,"binary",1).unwrap();
        assert!(!candidates(&connection).contains(&sibling),"F 后 live select 继续防重");
        crate::core::ratings::rate_clip(&mut connection,primary,"binary",-1).unwrap();

        let second = auto_select_episode_with(&mut connection,AutoSelectParams {
            scope:Some("all".into()),only_photos:Some(true),photo_count:Some(1),..Default::default()
        }).unwrap();
        let second_ids = smart_select_runs::list_run(&connection,&second.run_id).unwrap()
            .rows.into_iter().map(|row|row.clip_id).collect::<Vec<_>>();
        assert_eq!(second_ids,vec![sibling]);
    }

    #[test]
    fn photo_prompt_selects_exactly_twenty_with_one_per_similar_group() {
        let (_directory, mut connection) = tests::library();
        let mut files = Vec::new();
        for group in 0..10 {
            for shot in 0..3 {
                files.push(format!("IMG_{group:02}{shot}0.png"));
            }
        }
        files.extend((10..20).map(|index| format!("quality-{index}.png")));

        let mut photos: Vec<i64> = files
            .iter()
            .enumerate()
            .map(|(index, file)| {
                add_photo(
                    &mut connection,
                    file,
                    &format!("2026-09-19T12:00:{index:02}Z"),
                    3_000,
                )
            })
            .collect();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('v2')", []).unwrap();
        connection.execute("UPDATE clips SET volume_uuid = 'v2' WHERE id = ?1", [photos[0]]).unwrap();
        photos.push(add_photo(
            &mut connection,
            "IMG_0000.png",
            "2026-09-19T13:00:00Z",
            3_000,
        ));
        assert_eq!(photos.len(), 41, "20 个双成员相似组之外还要有一个健康候选，证明 20 张上限生效");
        let rejected = photos[40];
        connection.execute("UPDATE clip_analysis SET focus_scores='[999999]' WHERE clip_id=?1",[rejected]).unwrap();
        crate::core::ratings::rate_clip(&mut connection,rejected,"binary",-1).unwrap();

        for pair in photos[..40].as_chunks::<2>().0 {
            connection
                .execute(
                    "INSERT INTO similar_groups(created_at) VALUES ('2026-09-19T12:01:00Z')",
                    [],
                )
                .unwrap();
            let group_id = connection.last_insert_rowid();
            for (index, clip_id) in pair.iter().enumerate() {
                connection
                    .execute(
                        "INSERT INTO similar_group_members(group_id, clip_id, is_primary) VALUES (?1, ?2, ?3)",
                        params![group_id, clip_id, i64::from(index == 0)],
                    )
                    .unwrap();
            }
        }
        let group_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM similar_groups", [], |row| row.get(0))
            .unwrap();
        assert_eq!(group_count, 20);

        let chapter = tests::add_chapter(&connection, "视频对照", "2026-09-19T12:00:00Z");
        let video = tests::add_clip(&mut connection, chapter, 1.0, false, 0);
        let outcome = auto_select_episode_with(
            &mut connection,
            AutoSelectParams {
                scope: Some("all".to_owned()),
                prompt: Some("挑 20 张照片".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        let view = smart_select_runs::list_run(&connection, &outcome.run_id).unwrap();

        assert_eq!(outcome.created.len(), 20);
        assert_eq!(view.rows.len(), 20);
        assert_eq!(view.params.photo_count, Some(20));
        assert_eq!(view.params.only_photos, Some(true));
        assert!(view.rows.iter().all(|row|row.clip_id!=rejected),"X 后不得被重新挑入");
        assert!(view.rows.iter().all(|row| {
            !row.reasons.is_empty() && row.reasons.iter().all(|reason| !reason.trim().is_empty())
        }));

        let mut selected_groups = std::collections::BTreeSet::new();
        for row in &view.rows {
            let (kind, duration_ticks): (String, i64) = connection
                .query_row(
                    "SELECT kind, duration_ticks FROM clips WHERE id = ?1",
                    [row.clip_id],
                    |result| Ok((result.get(0)?, result.get(1)?)),
                )
                .unwrap();
            assert_eq!((kind.as_str(), duration_ticks), ("photo", 0));
            let group_id: Option<i64> = connection
                .query_row(
                    "SELECT group_id FROM similar_group_members WHERE clip_id = ?1",
                    [row.clip_id],
                    |result| result.get(0),
                )
                .optional()
                .unwrap();
            if let Some(group_id) = group_id {
                assert!(selected_groups.insert(group_id), "同一相似组被挑中了两张");
            }
        }
        assert!((outcome.total_secs - 60.0).abs() < f64::EPSILON, "照片预算只累计 hold_ms");
        let video_selected: i64 = connection
            .query_row("SELECT COUNT(*) FROM segments WHERE clip_id = ?1", [video], |row| row.get(0))
            .unwrap();
        assert_eq!(video_selected, 0);
        let nonzero_photo_ticks: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM segments WHERE batch_id = ?1 AND (in_ticks != 0 OR out_ticks != 0)",
                [&outcome.batch_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(nonzero_photo_ticks, 0);
        let on_video_band: i64 = connection
            .query_row("SELECT COUNT(*) FROM story_order WHERE tombstone = 0", [], |row| row.get(0))
            .unwrap();
        assert_eq!(on_video_band, 0);
    }

    #[test]
    fn photo_legacy_skipped_analysis_job_does_not_block_reanalysis() {
        let (_directory,mut connection) = tests::library();
        let id = add_photo(&mut connection,"quality-10.png","2026-09-19T12:00:00Z",3_000);
        connection.execute("DELETE FROM clip_analysis WHERE clip_id=?1",[id]).unwrap();
        connection.execute("DELETE FROM jobs WHERE kind='analyze_l1'",[]).unwrap();
        let (hash,path): (String,String) = connection.query_row("SELECT quick_hash,rel_path FROM clips WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        let old_hash = blake3::hash(format!("analyze_l1\0{id}\0{hash}\0analyze_l1/v5").as_bytes()).to_hex().to_string();
        let payload = serde_json::json!({"clip_id":id,"path":path,"quick_hash":hash}).to_string();
        let old = jobs::enqueue(&mut connection,"analyze_l1",&payload,&old_hash).unwrap();
        connection.execute("UPDATE jobs SET status='done' WHERE id=?1",[old]).unwrap();
        assert_eq!(analysis::enqueue_missing(&mut connection).unwrap(),1);
        let pending:i64 = connection.query_row("SELECT count(*) FROM jobs WHERE kind='analyze_l1' AND status='pending'",[],|r|r.get(0)).unwrap();
        assert_eq!(pending,1);
    }
}

/// Older/direct callers may only send the sentence. Structured parameters win.
fn resolve_photo_params(params: &mut AutoSelectParams) -> Result<()> {
    if let Some(prompt) = params.prompt.as_deref() {
        if params.only_photos.is_none() {
            if prompt.contains("只要视频") { params.only_photos = Some(false); }
            else if prompt.contains("只要照片") || (prompt.contains("照片") && prompt.contains('张')) { params.only_photos = Some(true); }
        }
        if params.photo_count.is_none() && prompt.contains("照片") {
            // Count immediately before 张; durations elsewhere in the sentence are not counts.
            if let Some((before, _)) = prompt.split_once('张') {
                let digits: String = before.trim_end().chars().rev().take_while(char::is_ascii_digit).collect::<String>().chars().rev().collect();
                params.photo_count = digits.parse().ok();
            }
        }
    }
    if params.photo_count.is_some() && params.only_photos.is_none() { params.only_photos = Some(true); }
    if params.photo_count == Some(0) {
        return Err(CoreError::Rating("照片张数要是正整数".to_owned()));
    }
    Ok(())
}

/// R19 P-01「按分数挑」:同一份去重后的候选,不分章节、分数从高到低装满预算。
fn greedy_by_score(candidates: Vec<Candidate>, budget_secs: f64) -> Vec<Candidate> {
    let mut chosen = Vec::new();
    let mut total = 0.0;
    for candidate in candidates {
        if total + candidate.secs <= budget_secs + 1e-9 {
            total += candidate.secs;
            chosen.push(candidate);
        }
    }
    chosen
}

/// 分数降序 + 同组去重(R18 B-4):两种挑法共用的前半段。
fn dedupe_by_score(mut candidates: Vec<Candidate>) -> Vec<Candidate> {
    candidates.sort_by(|a, b| {
        b.suggestion
            .score
            .total_cmp(&a.suggestion.score)
            .then(a.clip_id.cmp(&b.clip_id))
    });
    // R18 B-4 视觉去重:同一机位连拍的几条(`similar_groups` 已经把它们判成一组)
    // 以前会各出一段,成片里连着三个几乎一样的画面。按分数降序扫,**每组只留最高分那一条**。
    // 只在这里剔,不动 `similar_groups` 本身 —— 分组是别处算的,这里只是消费者。
    let mut seen_groups = std::collections::BTreeSet::new();
    candidates.retain(|candidate| match candidate.similar_group {
        Some(group) => seen_groups.insert(group),
        None => true,
    });
    candidates
}

/// 纯函数:章节轮转挑段。每章各自按分数降序,轮流从每章取一条,装得下就收,
/// 直到预算用完或候选耗尽。返回选中的候选(按选中顺序)。
fn rotate_by_chapter(candidates: Vec<Candidate>, budget_secs: f64) -> Vec<Candidate> {
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
    // R19 U-08:失败文案不说「第 n 步」(那是我们的编号,不是剪映的),直接给动作词。
    Ok(if analysed == 0 {
        "还没有可挑的素材:先导入视频".to_owned()
    } else {
        "素材都已经挑过了:想重挑就先撤销上一批,或去媒体池手动挑几条".to_owned()
    })
}

pub fn auto_select_episode(
    connection: &mut Connection,
    budget_secs: Option<f64>,
    scope: Option<&str>,
) -> Result<AutoSelectOutcome> {
    auto_select_episode_with(
        connection,
        AutoSelectParams {
            budget_secs,
            scope: scope.map(str::to_owned),
            only_photos: Some(false),
            ..AutoSelectParams::default()
        },
    )
}

/// R19 P-01 / P-03:带全部参数的自动挑选。挑完写一行 `auto_select_runs`(run_id = batch_id),
/// 每段挂 `auto_select_run_id`,结果面板按它列出来;权重偏置只影响这一次的候选排序,不改库。
pub fn auto_select_episode_with(connection: &mut Connection, mut params: AutoSelectParams) -> Result<AutoSelectOutcome> {
    resolve_photo_params(&mut params)?;
    let arrange_on_video_band = params.only_photos != Some(true);
    let scope = AutoSelectScope::parse(params.scope.as_deref())?;
    let platform_budget = platform_budget_secs(connection)?;
    let budget = match params.budget_secs {
        Some(value) if value.is_finite() && value > 0.0 => value,
        Some(_) => return Err(CoreError::Rating("时长预算要是正数秒".to_owned())),
        None if params.only_photos == Some(true) && params.photo_count.is_some() => f64::INFINITY,
        None if platform_budget > 0 => platform_budget as f64,
        None => DEFAULT_BUDGET_SECS,
    };
    let target = target_secs_for_budget(platform_budget);
    params.target_secs = Some(target);
    let weights = params.weights;
    let mut unselected = Vec::new();
    let mut candidates = load_candidates(connection, scope, target, weights.as_ref(), params.only_photos, &mut unselected)?;
    // X-01:新手默认范围在全新库(0 收藏、0 打星)里是空的——自动改按「全部」挑,不让流水线停在第 ② 步。
    let mut scope_used = scope;
    let mut fell_back = false;
    if candidates.is_empty() && scope == AutoSelectScope::FavoritesOrRated3 {
        unselected.clear();
        candidates = load_candidates(connection, AutoSelectScope::All, target, weights.as_ref(), params.only_photos, &mut unselected)?;
        scope_used = AutoSelectScope::All;
        fell_back = !candidates.is_empty();
    }
    if candidates.is_empty() {
        if !unselected.is_empty() {
            let labels: std::collections::BTreeSet<_> = unselected.iter().flat_map(|r| r.blockers.clone()).collect();
            return Err(CoreError::Rating(format!("这些素材未选:{};可换一批素材或手动挑选", labels.into_iter().collect::<Vec<_>>().join("、"))));
        }
        return Err(CoreError::Rating(empty_scope_reason(connection, scope_used)?));
    }
    let deduped = dedupe_by_score(candidates);
    let mut chosen = match params.pick {
        AutoSelectPick::Chapters => rotate_by_chapter(deduped, budget),
        AutoSelectPick::Score => greedy_by_score(deduped, budget),
    };
    if let Some(limit) = params.photo_count {
        let mut photos = 0;
        chosen.retain(|candidate| {
            if candidate.suggestion.in_ticks == 0 && candidate.suggestion.out_ticks == 0 {
                photos += 1;
                photos <= limit
            } else { true }
        });
    }
    let batch_id = format!("auto-{}", uuid::Uuid::new_v4().simple());
    let mut stored_params = serde_json::to_value(AutoSelectParams { scope: Some(scope_used.as_str().to_owned()), ..params })
        .map_err(|error| CoreError::Rating(format!("无法保存挑选参数:{error}")))?;
    stored_params["unselected"] = serde_json::json!(unselected);
    let params_json = stored_params.to_string();
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "INSERT INTO auto_select_runs(run_id, episode_id, params_json, created_at)
         VALUES (?1, (SELECT id FROM episodes WHERE status = 'active'), ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![batch_id, params_json],
    )?;
    let mut created = Vec::with_capacity(chosen.len());
    let mut total_secs = 0.0;
    let mut chapters = Vec::new();
    for candidate in &chosen {
        super::episode::ensure_clip_writable(&transaction, candidate.clip_id)?;
        // R18 B-4:「为什么选它」跟着段一起落盘。以前 `reasons` 算出来就扔了,
        // 用户看到 11 段凭空出现、点开任何一段都问不出理由。
        let reasons = serde_json::to_string(&suggestion_reason(&candidate.suggestion))
            .map_err(|error| CoreError::Rating(format!("无法保存挑选理由:{error}")))?;
        transaction.execute(
            "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind, tombstone, source, batch_id, reason_json, auto_select_run_id)
             VALUES (?1, ?2, ?3, 'select', 0, 'auto', ?4, ?5, ?4)",
            params![
                candidate.clip_id,
                candidate.suggestion.in_ticks,
                candidate.suggestion.out_ticks,
                batch_id,
                reasons
            ],
        )?;
        let segment_id = transaction.last_insert_rowid();
        transaction.execute(
            "INSERT INTO ratings(segment_id, rating_type, value, rated_at)
             VALUES (?1, 'binary', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            [segment_id],
        )?;
        super::clip_brief::refresh_for_clip(&transaction, candidate.clip_id)?;
        created.push(segment_id);
        total_secs += candidate.secs;
        if !chapters.contains(&candidate.chapter_key) {
            chapters.push(candidate.chapter_key);
        }
    }
    transaction.commit()?;
    // R12 §2:视频挑完就排进视频镜头带(append,只补新段);照片留在照片工作台。
    // 排入失败不能吞掉已经成功的挑选,只把 placed 记 0,前端会给「排入」按钮让用户再点一次。
    let (placed, arrange_batch_id) = if arrange_on_video_band {
        match super::arrange::arrange_selected_segments(connection, super::arrange::ArrangeMode::Append) {
            Ok(outcome) if outcome.placed > 0 => (outcome.placed, Some(outcome.batch_id)),
            Ok(_) => (0, None),
            Err(error) => {
                tracing::warn!(%error, "自动挑选后排入镜头带失败");
                (0, None)
            }
        }
    } else {
        (0, None)
    };
    Ok(AutoSelectOutcome {
        created,
        total_secs,
        chapters_covered: chapters.len(),
        run_id: batch_id.clone(),
        batch_id,
        placed,
        arrange_batch_id,
        scope_used: scope_used.as_str().to_owned(),
        fell_back,
    })
}

pub(crate) fn suggestion_reason(suggestion: &SegmentSuggestion) -> reason::Reason {
    let mut quality = reason::Reason::from_labels(&suggestion.reasons);
    quality.reasons = suggestion.reasons.iter().filter(|v| !quality.fixable.contains(v) && !quality.blockers.contains(v)).cloned().collect();
    quality
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
pub(crate) mod tests {
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
            interest: None,
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

    pub(crate) fn library() -> (TestDirectory, Connection) {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('v')", []).unwrap();
        (directory, connection)
    }

    pub(crate) fn add_chapter(connection: &Connection, title: &str, start_at: &str) -> i64 {
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
    pub(crate) fn add_clip(connection: &mut Connection, chapter_id: i64, score: f64, favorite: bool, stars: i64) -> i64 {
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
    fn r20_existing_analysis_supplies_focus_and_exposure_reasons() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "分析", "2026-09-19T08:00:00Z");
        let blurred = add_clip(&mut connection, chapter, 0.9, true, 0);
        let dark = add_clip(&mut connection, chapter, 0.8, true, 0);
        for (id, focus, under) in [(blurred, 0.9, 0.0), (dark, 0.0, 0.8)] {
            connection.execute("INSERT INTO clip_analysis(clip_id, exposure_yavg, overexposed_ratio, underexposed_ratio,
                out_of_focus_ratio, audio_clipped, has_audio, focus_scores, scene_count, analyzed_at, tool_versions)
                VALUES (?1, 40, 0, ?3, ?2, 0, 1, '[]', 1, 'now', '{}')", params![id, focus, under]).unwrap();
        }
        connection.execute("UPDATE clip_moments SET exposure_ok=0 WHERE clip_id=?1", [dark]).unwrap();
        let run = auto_select_episode(&mut connection, Some(300.0), Some("all")).unwrap();
        let view = crate::core::smart_select_runs::list_run(&connection, &run.run_id).unwrap();
        assert_eq!(view.rows.len(), 1);
        assert_eq!(view.rows[0].clip_id, dark);
        assert_eq!(view.rows[0].fixable, vec!["曝光偏暗"]);
        assert_eq!(view.unselected[0].clip_id, blurred);
    }

    #[test]
    fn r20_blockers_win_over_fixable_even_after_weight_bias_and_in_short_clips() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "测试", "2026-09-19T08:00:00Z");
        let blocked = add_clip(&mut connection, chapter, 1.0, true, 0);
        let good = add_clip(&mut connection, chapter, 0.1, true, 0);
        connection.execute("UPDATE clip_moments SET reasons_json='[\"high_contrast\",\"exposure_dark\"]' WHERE clip_id=?1", [blocked]).unwrap();
        let weighted = moments_with_weights(&connection, blocked, Some(&MomentWeights::default())).unwrap();
        assert!(suggest_from_moments(&weighted[..2], 8.0, 1).is_empty());
        assert!(suggest_from_moments(&weighted, 8.0, 1).is_empty());
        let outcome = auto_select_episode_with(&mut connection, AutoSelectParams { scope: Some("all".to_owned()), weights: Some(MomentWeights::default()), ..Default::default() }).unwrap();
        let view = crate::core::smart_select_runs::list_run(&connection, &outcome.run_id).unwrap();
        assert_eq!(view.rows.len(), 1);
        assert_eq!(view.rows[0].clip_id, good);
        assert_eq!(view.unselected[0].blockers, vec!["大光比"]);
    }

    #[test]
    fn r20_quality_blockers_precede_fixable_in_ten_clip_fixture() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "质量", "2026-09-19T08:00:00Z");
        let labels = ["失焦", "抖动过大", "时机差", "曝光偏亮", "轻微手抖", "色偏", "", "", "", ""];
        let mut ids = Vec::new();
        for label in labels {
            let id = add_clip(&mut connection, chapter, 0.9, true, 0);
            connection.execute("UPDATE clip_moments SET reasons_json = ?2 WHERE clip_id = ?1",
                params![id, serde_json::to_string(&vec!["清晰", label]).unwrap()]).unwrap();
            connection.execute("UPDATE clips SET local_brief='旧描述。' WHERE id=?1", [id]).unwrap();
            ids.push(id);
        }
        let outcome = auto_select_episode(&mut connection, Some(300.0), Some("all")).unwrap();
        let view = crate::core::smart_select_runs::list_run(&connection, &outcome.run_id).unwrap();
        assert_eq!(view.rows.len(), 7);
        assert_eq!(view.unselected.len(), 3);
        assert_eq!(view.unselected[0].blockers, vec!["失焦"]);
        assert!(view.rows.iter().all(|r| !ids[..3].contains(&r.clip_id)));
        for id in &ids[3..6] {
            let row = view.rows.iter().find(|r| r.clip_id == *id).unwrap();
            assert!(row.reasons.iter().any(|r| r.contains("可修")), "{row:?}");
            let json: String = connection.query_row("SELECT reason_json FROM segments WHERE id=?1", [row.segment_id], |r| r.get(0)).unwrap();
            let value: serde_json::Value = serde_json::from_str(&json).unwrap();
            assert_eq!(value["fixable"].as_array().unwrap().len(), 1);
            assert_eq!(value["blockers"], serde_json::json!([]));
            assert!(crate::core::clip_brief::get_clip_brief(&connection, *id).unwrap().unwrap().contains("可修"));
        }
    }

    /// R18 B-4:自动挑选写下「为什么选它」。以前 `reasons` 算出来就扔了 ——
    /// 这条在写 `reason_json` 之前必红。
    #[test]
    fn auto_select_writes_down_why_it_picked_each_segment() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "机场", "2026-09-13T08:00:00Z");
        add_clip(&mut connection, chapter, 0.9, true, 0);
        auto_select_episode(&mut connection, Some(30.0), Some("all")).unwrap();
        let reasons: String = connection
            .query_row(
                "SELECT reason_json FROM segments WHERE source = 'auto' AND tombstone = 0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let parsed = reason::Reason::read(&reasons).display();
        assert!(parsed.iter().any(|reason| reason == "清晰"), "{reasons}");
    }

    /// R18 B-4 视觉去重:同一机位连拍的三条(`similar_groups` 已经判成一组)以前各出一段,
    /// 成片里连着三个几乎一样的画面。现在**每组只留最高分那一条**;不在组里的照常各出一段。
    #[test]
    fn auto_select_keeps_only_the_best_take_of_a_similar_group() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "机场", "2026-09-13T08:00:00Z");
        let dull = add_clip(&mut connection, chapter, 0.5, true, 0);
        let best = add_clip(&mut connection, chapter, 0.9, true, 0);
        let other = add_clip(&mut connection, chapter, 0.7, true, 0);
        connection
            .execute("INSERT INTO similar_groups(id, created_at) VALUES (1, '2026-09-13T00:00:00Z')", [])
            .unwrap();
        for (clip_id, primary) in [(dull, 0), (best, 1)] {
            connection
                .execute(
                    "INSERT INTO similar_group_members(group_id, clip_id, is_primary) VALUES (1, ?1, ?2)",
                    params![clip_id, primary],
                )
                .unwrap();
        }
        let outcome = auto_select_episode(&mut connection, Some(300.0), Some("all")).unwrap();
        let picked: Vec<i64> = {
            let mut statement = connection
                .prepare("SELECT clip_id FROM segments WHERE source = 'auto' AND tombstone = 0 ORDER BY clip_id")
                .unwrap();
            let rows = statement.query_map([], |row| row.get(0)).unwrap();
            rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        assert_eq!(outcome.created.len(), 2, "同一组三取一 + 组外那条 = 2 段");
        assert!(picked.contains(&best) && picked.contains(&other), "{picked:?}");
        assert!(!picked.contains(&dull), "同组里分低的那条不该也出一段:{picked:?}");
    }

    /// R18 B-4「不要这一段」:单独丢掉一条自动段时,它要从那一批里**摘掉** ——
    /// 否则「撤销这一批」还会去删一条用户已经明确拒绝的段,两个动作对同一行各说各话。
    #[test]
    fn dropping_one_auto_segment_detaches_it_from_the_batch() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "机场", "2026-09-13T08:00:00Z");
        add_clip(&mut connection, chapter, 0.9, true, 0);
        add_clip(&mut connection, chapter, 0.8, true, 0);
        let outcome = auto_select_episode(&mut connection, Some(300.0), Some("all")).unwrap();
        assert_eq!(outcome.created.len(), 2);
        crate::core::ratings::delete_select_segment(&mut connection, outcome.created[0]).unwrap();
        let still_in_batch: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM segments WHERE id = ?1 AND batch_id IS NOT NULL",
                [outcome.created[0]],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(still_in_batch, 0, "被丢掉的那一段不该还挂在批次上");
        assert_eq!(undo_auto_select(&mut connection, &outcome.batch_id).unwrap(), 1, "整批撤销只收回剩下那一段");
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
