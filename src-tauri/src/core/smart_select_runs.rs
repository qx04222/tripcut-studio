//! R19 Wave 2 results 车道(P-03「为什么是这些」结果面板)。
//!
//! - `list_run`:按 run id 列出这一批**还活着**的自动段:时长 / 分数 / 中文理由 / 被同组去重掉的兄弟素材。
//! - `replace_auto_segment`:「换一段」—— 用同一相似组里分数次高的兄弟素材替掉这一段;没有兄弟就换成
//!   同一条素材的下一条建议段。旧段软删(与「不要这一段」同一条路),新段挂同一个 batch / run,
//!   「全部撤销」仍然一次收回。

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::error::{CoreError, Result};
use super::moments::{ticks_to_seconds, MomentWeights};
use super::smart_select::{moments_with_weights, suggest_from_moments, AutoSelectParams, AutoSelectScope, MAX_SUGGESTIONS};

/// 被去重掉的兄弟素材(同一相似组、这一批没选它)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunSibling {
    pub clip_id: i64,
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunRow {
    pub segment_id: i64,
    pub clip_id: i64,
    pub in_ticks: i64,
    pub out_ticks: i64,
    pub tb_num: i64,
    pub tb_den: i64,
    pub secs: f64,
    /// 段内时刻分均值(库里的分;有权重偏置时是偏置后的分)。
    pub score: f64,
    /// 白话理由(`segments.reason_json`)。
    pub reasons: Vec<String>,
    pub siblings: Vec<RunSibling>,
    pub fixable: Vec<String>,
    pub blockers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunView {
    pub run_id: String,
    pub params: AutoSelectParams,
    pub rows: Vec<RunRow>,
    pub unselected: Vec<super::smart_select::reason::Unselected>,
}

fn load_params(connection: &Connection, run_id: &str) -> Result<AutoSelectParams> {
    let json: Option<String> = connection
        .query_row("SELECT params_json FROM auto_select_runs WHERE run_id = ?1", [run_id], |row| row.get(0))
        .optional()?;
    let json = json.ok_or_else(|| CoreError::Rating("这一批挑选已经不存在了".to_owned()))?;
    serde_json::from_str(&json).map_err(|error| CoreError::Rating(format!("挑选参数读不出来:{error}")))
}

fn photo_quality(connection: &Connection, clip_id: i64) -> Result<Option<(f64, i64)>> {
    let Some(analysis) = super::analysis::get_clip_analysis(connection, clip_id)? else { return Ok(None) };
    let threshold = super::analysis::OVEREXPOSED_RATIO_THRESHOLD;
    if analysis.underexposed_ratio > threshold || analysis.overexposed_ratio > threshold
        || analysis.out_of_focus_ratio > threshold { return Ok(None); }
    let hold_ms: Option<i64> = connection.query_row(
        "SELECT hold_ms FROM photo_meta WHERE clip_id=?1 AND error IS NULL", [clip_id], |row| row.get(0),
    ).optional()?;
    let Some(hold_ms) = hold_ms.filter(|value| *value > 0) else { return Ok(None) };
    let focus = if analysis.focus_scores.is_empty() { 0.0 }
        else { analysis.focus_scores.iter().sum::<f64>() / analysis.focus_scores.len() as f64 };
    Ok(Some((100.0 * focus / (focus + super::analysis::SOFT_FOCUS_THRESHOLD), hold_ms)))
}

/// 同一相似组里、还没有任何存活精选段、在范围内的其它素材,按各自媒体的画质分降序。
fn group_alternatives(
    connection: &Connection,
    clip_id: i64,
    params: &AutoSelectParams,
) -> Result<Vec<(i64, super::smart_select::SegmentSuggestion, i64, i64)>> {
    let groups = super::similar::group_id_by_clip(connection)?;
    let Some(group) = groups.get(&clip_id) else { return Ok(Vec::new()) };
    let photo = super::photo_probe::is_photo(connection, clip_id)?;
    let scope = AutoSelectScope::parse(params.scope.as_deref())?;
    let target = params.target_secs.unwrap_or(super::smart_select::DEFAULT_BUDGET_SECS / 10.0);
    let media_predicate = if photo { "c.kind = 'photo'" }
        else { "c.kind = 'video' AND EXISTS (SELECT 1 FROM clip_moments mm WHERE mm.clip_id = c.id)" };
    let sql = format!(
        "SELECT c.id, c.tb_num, c.tb_den
           FROM clips c
           JOIN similar_group_members m ON m.clip_id = c.id AND m.group_id = ?1
          WHERE c.id != ?2 AND c.missing_since IS NULL
            AND c.episode_id = (SELECT episode_id FROM clips WHERE id = ?2)
            AND {media_predicate}
            AND NOT EXISTS (SELECT 1 FROM segments s WHERE s.clip_id = c.id AND s.kind = 'select' AND s.tombstone = 0)
            AND COALESCE((
                SELECT rating.value
                  FROM ratings rating
                  JOIN segments rated_segment ON rated_segment.id = rating.segment_id
                 WHERE rated_segment.clip_id = c.id
                   AND rated_segment.tombstone = 0
                   AND (c.kind != 'photo' OR COALESCE(rated_segment.kind, 'whole') != 'select')
                   AND rating.rating_type = 'binary'
                 ORDER BY rating.rated_at DESC, rating.id DESC
                 LIMIT 1
            ), 0) != -1
            AND {}
          ORDER BY c.id",
        scope.sql_predicate()
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement
        .query_map(params![group, clip_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?, row.get::<_, Option<i64>>(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::new();
    let group_size = rows.len() + 1;
    for (sibling, tb_num, tb_den) in rows {
        if photo {
            if let Some((score, _)) = photo_quality(connection, sibling)? {
                out.push((sibling, super::smart_select::SegmentSuggestion {
                    in_ticks: 0, out_ticks: 0, score, reasons: vec![format!("同组 {group_size} 张备选")],
                }, 1, 1000));
            }
            continue;
        }
        let (Some(tb_num), Some(tb_den)) = (tb_num, tb_den) else { continue };
        let moments = moments_with_weights(connection, sibling, params.weights.as_ref())?;
        if let Some(best) = suggest_from_moments(&moments, target, 1).into_iter().next() {
            out.push((sibling, best, tb_num, tb_den));
        }
    }
    out.sort_by(|a, b| b.1.score.total_cmp(&a.1.score).then(a.0.cmp(&b.0)));
    Ok(out)
}

fn row_for(connection: &Connection, segment_id: i64, params: &AutoSelectParams) -> Result<RunRow> {
    let (clip_id, in_ticks, out_ticks, tb_num, tb_den, reason_json): (i64, i64, i64, i64, i64, Option<String>) = connection
        .query_row(
            "SELECT s.clip_id, s.in_ticks, s.out_ticks, COALESCE(c.tb_num, 1), COALESCE(c.tb_den, 1000), s.reason_json
               FROM segments s JOIN clips c ON c.id = s.clip_id
              WHERE s.id = ?1",
            [segment_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .optional()?
        .ok_or_else(|| CoreError::Rating(format!("精选段 {segment_id} 不存在")))?;
    let photo = super::photo_probe::is_photo(connection, clip_id)?;
    let score = if photo { photo_quality(connection, clip_id)?.map_or(0.0, |quality| quality.0) } else {
        let moments = moments_with_weights(connection, clip_id, params.weights.as_ref())?;
        let inside: Vec<f64> = moments.iter()
            .filter(|moment| moment.t_start_ticks >= in_ticks && moment.t_end_ticks <= out_ticks)
            .map(|moment| moment.score).collect();
        if inside.is_empty() { 0.0 } else { inside.iter().sum::<f64>() / inside.len() as f64 }
    };
    let reason = reason_json.map(|json| super::smart_select::reason::Reason::read(&json)).unwrap_or_default();
    let reasons = reason.display();
    let siblings = group_alternatives(connection, clip_id, params)?
        .into_iter()
        .map(|(sibling, best, _, _)| RunSibling { clip_id: sibling, score: best.score })
        .collect();
    Ok(RunRow {
        segment_id,
        clip_id,
        in_ticks,
        out_ticks,
        tb_num,
        tb_den,
        secs: if photo {
            connection.query_row("SELECT hold_ms / 1000.0 FROM photo_meta WHERE clip_id=?1", [clip_id], |r| r.get(0))?
        } else { ticks_to_seconds(out_ticks - in_ticks, tb_num, tb_den) },
        score,
        reasons,
        siblings,
        fixable: reason.fixable,
        blockers: reason.blockers,
    })
}

/// 这一批还活着的段(「不要这一段」软删掉的不列;「换一段」换进来的列)。
pub fn list_run(connection: &Connection, run_id: &str) -> Result<RunView> {
    let params = load_params(connection, run_id)?;
    let mut statement = connection.prepare(
        "SELECT s.id
           FROM segments s
           JOIN clips c ON c.id = s.clip_id
           LEFT JOIN story_order o ON o.segment_id = s.id AND o.item_kind = 'segment' AND o.tombstone = 0
          WHERE s.auto_select_run_id = ?1
            AND s.kind = 'select'
            AND s.tombstone = 0
            AND (
              c.kind != 'photo'
              OR COALESCE((
                SELECT rating.value
                  FROM ratings rating
                  JOIN segments rated_segment ON rated_segment.id = rating.segment_id
                 WHERE rated_segment.clip_id = c.id
                   AND rated_segment.tombstone = 0
                   AND COALESCE(rated_segment.kind, 'whole') != 'select'
                   AND rating.rating_type = 'binary'
                 ORDER BY rating.rated_at DESC, rating.id DESC
                 LIMIT 1
              ), 0) != -1
            )
          ORDER BY o.position IS NULL, o.position, s.id",
    )?;
    let ids = statement.query_map([run_id], |row| row.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let rows = ids.into_iter().map(|id| row_for(connection, id, &params)).collect::<Result<Vec<_>>>()?;
    let json: String = connection.query_row("SELECT params_json FROM auto_select_runs WHERE run_id=?1", [run_id], |r| r.get(0))?;
    let unselected = serde_json::from_str::<serde_json::Value>(&json).ok()
        .and_then(|v| serde_json::from_value(v["unselected"].clone()).ok()).unwrap_or_default();
    Ok(RunView { run_id: run_id.to_owned(), params, rows, unselected })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplacedSnapshot {
    pub segment_id: i64,
    pub batch_id: String,
    pub position: Option<i64>,
    pub order_id: Option<i64>,
    pub row: RunRow,
}

#[derive(Debug, Clone, Serialize)]
pub struct Replacement {
    #[serde(flatten)]
    pub row: RunRow,
    pub replaced: ReplacedSnapshot,
}

impl std::ops::Deref for Replacement {
    type Target = RunRow;
    fn deref(&self) -> &RunRow { &self.row }
}

/// 「换一段」:优先同组分数最高的兄弟素材;没有就换成同一条素材的下一条建议段;都没有 → 报错。
pub fn replace_auto_segment(connection: &mut Connection, segment_id: i64) -> Result<Replacement> {
    let (clip_id, in_ticks, run_id, batch_id): (i64, i64, Option<String>, Option<String>) = connection
        .query_row(
            "SELECT clip_id, in_ticks, auto_select_run_id, batch_id FROM segments
              WHERE id = ?1 AND kind = 'select' AND tombstone = 0 AND source = 'auto'",
            [segment_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?
        .ok_or_else(|| CoreError::Rating("这一段不是自动挑的,或已经不在了".to_owned()))?;
    let run_id = run_id.ok_or_else(|| CoreError::Rating("这一段不属于任何一批自动挑选".to_owned()))?;
    let params = load_params(connection, &run_id)?;
    super::episode::ensure_clip_writable(connection, clip_id)?;
    let photo = super::photo_probe::is_photo(connection, clip_id)?;
    let replacement = match group_alternatives(connection, clip_id, &params)?.into_iter().next() {
        Some((sibling, best, _, _)) => (sibling, best),
        None if photo => return Err(CoreError::Rating(
            "这一张没有可换的同组照片;可以从照片网格另选,或把本组送进擂台".to_owned(),
        )),
        None => {
            let target = params.target_secs.unwrap_or(super::smart_select::DEFAULT_BUDGET_SECS / 10.0);
            let moments = moments_with_weights(connection, clip_id, params.weights.as_ref())?;
            let next = suggest_from_moments(&moments, target, MAX_SUGGESTIONS)
                .into_iter()
                .find(|suggestion| suggestion.in_ticks != in_ticks)
                .ok_or_else(|| CoreError::Rating("这一段没有可换的备选:同组没有其它素材,这条素材也只有这一段拿得出手".to_owned()))?;
            (clip_id, next)
        }
    };
    let old_row = row_for(connection, segment_id, &params)?;
    let reasons = serde_json::to_string(&super::smart_select::suggestion_reason(&replacement.1))
        .map_err(|error| CoreError::Rating(format!("无法保存挑选理由:{error}")))?;
    let batch = batch_id.unwrap_or_else(|| run_id.clone());
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "UPDATE segments SET tombstone = 1, deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), batch_id = NULL
          WHERE id = ?1 AND tombstone = 0",
        [segment_id],
    )?;
    transaction.execute(
        "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind, tombstone, source, batch_id, reason_json, auto_select_run_id)
         VALUES (?1, ?2, ?3, 'select', 0, 'auto', ?4, ?5, ?6)",
        params![replacement.0, replacement.1.in_ticks, replacement.1.out_ticks, batch, reasons, run_id],
    )?;
    let new_id = transaction.last_insert_rowid();
    transaction.execute(
        "INSERT INTO ratings(segment_id, rating_type, value, rated_at) VALUES (?1, 'binary', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        [new_id],
    )?;
    // F-R19-08:新段接住旧段在镜头带上原来的位置,不叫通用的 `arrange_selected_segments(Append)`——
    // 那条路只会把「这一批里唯一没上过带的段」拍到当前最大位置之后,把按时间/章节排好的次序打乱
    // (旧段在 `ordered_select_segments` 里已经因为 tombstone 被摘掉,新段的 key 从没在 `story_order`
    // 里出现过,Append 眼里它就是「新来的」,永远排最后)。旧段在带上的那一行也要一并墓碑掉——
    // 不然会留一条指着已软删段的活行占着 `position` 唯一索引的位置。
    let old_order: Option<(i64, i64, i64)> = transaction
        .query_row(
            "SELECT id, episode_id, position FROM story_order
              WHERE item_kind = 'segment' AND segment_id = ?1 AND tombstone = 0",
            [segment_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if let Some((order_id, episode_id, position)) = old_order {
        transaction.execute(
            "UPDATE story_order SET tombstone = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
            [order_id],
        )?;
        super::story::upsert_story_order(
            &transaction,
            &super::story::StoryOrderRef { item_kind: "segment".to_owned(), clip_id: replacement.0, segment_id: Some(new_id) },
            episode_id,
            position,
        )?;
    }
    let replaced = ReplacedSnapshot {
        segment_id, batch_id: batch, position: old_order.map(|o| o.2), order_id: old_order.map(|o| o.0), row: old_row,
    };
    // 复用已有 JSON 列保存撤销关联,重启后仍可恢复,无需迁移。
    let mut reason: serde_json::Value = serde_json::from_str(&reasons).map_err(|e| CoreError::Rating(e.to_string()))?;
    reason["replaced"] = serde_json::to_value(&replaced).map_err(|e| CoreError::Rating(e.to_string()))?;
    transaction.execute("UPDATE segments SET reason_json=?2 WHERE id=?1", params![new_id, reason.to_string()])?;
    super::clip_brief::refresh_for_clip(&transaction, replacement.0)?;
    transaction.commit()?;
    if old_order.is_none() && !photo {
        // 旧段本来就没上过带(这一批还没排入过)—— 照旧走一遍全量排入,把新段和其它段一起补上。
        if let Err(error) = super::arrange::arrange_selected_segments(connection, super::arrange::ArrangeMode::Append) {
            tracing::warn!(%error, "换一段后排入镜头带失败");
        }
    }
    Ok(Replacement { row: row_for(connection, new_id, &params)?, replaced })
}

/// 原子还回旧段、批次与原位置。整批已撤销时返回 false,绝不复活旧段。
pub fn undo_replace_auto_segment(connection: &mut Connection, run_id: &str, replaced_segment_id: i64) -> Result<bool> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current: Option<(i64, String)> = transaction.query_row(
        "SELECT id, reason_json FROM segments WHERE auto_select_run_id=?1 AND batch_id=?1
         AND source='auto' AND kind='select' AND tombstone=0
         AND json_extract(reason_json, '$.replaced.segment_id')=?2",
        params![run_id, replaced_segment_id], |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional()?;
    let Some((new_id, json)) = current else { return Ok(false) };
    let value: serde_json::Value = serde_json::from_str(&json).map_err(|e| CoreError::Rating(e.to_string()))?;
    let old: ReplacedSnapshot = serde_json::from_value(value["replaced"].clone()).map_err(|e| CoreError::Rating(e.to_string()))?;
    super::episode::ensure_clip_writable(&transaction, old.row.clip_id)?;
    if old.batch_id != run_id { return Err(CoreError::Rating("恢复批次不匹配".to_owned())); }
    transaction.execute("DELETE FROM segments WHERE id=?1", [new_id])?;
    let restored = transaction.execute(
        "UPDATE segments SET tombstone=0, deleted_at=NULL, batch_id=?2
         WHERE id=?1 AND auto_select_run_id=?2 AND source='auto' AND tombstone=1",
        params![old.segment_id, old.batch_id],
    )?;
    if restored != 1 { return Err(CoreError::Rating("原段已不在,无法恢复".to_owned())); }
    if let (Some(order_id), Some(position)) = (old.order_id, old.position) {
        transaction.execute(
            "UPDATE story_order SET tombstone=0, position=?2, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?1",
            params![order_id, position],
        )?;
    }
    transaction.commit()?;
    Ok(true)
}

/// 权重偏置的入口校验:键只能是 `WEIGHT_KEYS`、值 0–1(复用 `MomentWeights::parse`)。
pub fn parse_weights(json: Option<&str>) -> Result<Option<MomentWeights>> {
    match json {
        None | Some("") => Ok(None),
        Some(json) => MomentWeights::parse(json).map(Some),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::smart_select::tests::{add_chapter, add_clip, library};
    use crate::core::smart_select::{auto_select_episode, auto_select_episode_with, undo_auto_select, AutoSelectPick};

    #[test]
    fn r20_chained_replacements_undo_in_reverse_after_reopening_database() {
        let (directory, mut connection) = library();
        let chapter = add_chapter(&connection, "机场", "2026-09-18T08:00:00Z");
        let first = add_clip(&mut connection, chapter, 0.9, true, 0);
        let second = add_clip(&mut connection, chapter, 0.8, true, 0);
        make_group(&connection, &[first, second]);
        let run = auto_select_episode(&mut connection, Some(300.0), Some("all")).unwrap();
        let old = run.created[0];
        let middle = replace_auto_segment(&mut connection, old).unwrap().segment_id;
        let new = replace_auto_segment(&mut connection, middle).unwrap().segment_id;
        drop(connection);
        let mut connection = crate::core::db::open_project(&directory.db_path()).unwrap();
        assert!(!undo_replace_auto_segment(&mut connection, "wrong-run", middle).unwrap());
        assert!(undo_replace_auto_segment(&mut connection, &run.run_id, middle).unwrap());
        assert!(undo_replace_auto_segment(&mut connection, &run.run_id, old).unwrap());
        let view = list_run(&connection, &run.run_id).unwrap();
        assert_eq!(view.rows.len(), 1);
        assert_eq!(view.rows[0].segment_id, old);
        assert_ne!(old, new);
        assert_eq!(undo_auto_select(&mut connection, &run.batch_id).unwrap(), 1);
    }

    #[test]
    fn r20_replace_undo_restores_batch_position_and_bulk_undo() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "机场", "2026-09-18T08:00:00Z");
        add_clip(&mut connection, chapter, 0.9, true, 0);
        add_clip(&mut connection, chapter, 0.8, true, 0);
        let run = auto_select_episode(&mut connection, Some(300.0), Some("all")).unwrap();
        let old = run.created[0];
        let position = |conn: &Connection, id: i64| -> i64 {
            conn.query_row("SELECT position FROM story_order WHERE segment_id=?1 AND tombstone=0", [id], |r| r.get(0)).unwrap()
        };
        let before = position(&connection, old);
        let next = replace_auto_segment(&mut connection, old).unwrap();
        assert_eq!(next.replaced.segment_id, old);
        assert_eq!(next.replaced.batch_id, run.batch_id);
        assert_eq!(next.replaced.position, Some(before));
        assert!(undo_replace_auto_segment(&mut connection, &run.run_id, old).unwrap());
        assert_eq!(position(&connection, old), before);
        assert_eq!(live_run_segments(&connection, &run.run_id), 2);
        assert_eq!(list_run(&connection, &run.run_id).unwrap().rows[0].segment_id, old);
        // 重复撤销与整批撤销后的过期动作都不能复活旧段。
        assert!(!undo_replace_auto_segment(&mut connection, &run.run_id, old).unwrap());
        replace_auto_segment(&mut connection, old).unwrap();
        assert_eq!(undo_auto_select(&mut connection, &run.batch_id).unwrap(), 2);
        assert!(!undo_replace_auto_segment(&mut connection, &run.run_id, old).unwrap());
        assert_eq!(live_run_segments(&connection, &run.run_id), 0);
    }

    fn live_run_segments(connection: &Connection, run_id: &str) -> i64 {
        connection
            .query_row("SELECT COUNT(*) FROM segments WHERE auto_select_run_id = ?1 AND tombstone = 0", [run_id], |row| row.get(0))
            .unwrap()
    }

    fn make_group(connection: &Connection, members: &[i64]) {
        connection.execute("INSERT INTO similar_groups(id, created_at) VALUES (1, '2026-09-18T00:00:00Z')", []).unwrap();
        for (index, clip_id) in members.iter().enumerate() {
            connection
                .execute("INSERT INTO similar_group_members(group_id, clip_id, is_primary) VALUES (1, ?1, ?2)", params![clip_id, i64::from(index == 0)])
                .unwrap();
        }
    }

    fn make_photo(connection: &mut Connection, chapter: i64, focus: f64) -> i64 {
        let clip_id = add_clip(connection, chapter, 0.9, false, 0);
        connection.execute(
            "UPDATE clips SET kind='photo', duration_ticks=0, fps_num=NULL, fps_den=NULL WHERE id=?1", [clip_id],
        ).unwrap();
        connection.execute("DELETE FROM clip_moments WHERE clip_id=?1", [clip_id]).unwrap();
        connection.execute("INSERT INTO photo_meta(clip_id,hold_ms) VALUES(?1,3000)", [clip_id]).unwrap();
        connection.execute(
            "INSERT INTO clip_analysis(clip_id,exposure_yavg,overexposed_ratio,underexposed_ratio,
                out_of_focus_ratio,audio_clipped,has_audio,focus_scores,scene_count,analyzed_at,tool_versions)
             VALUES(?1,128,0,0,0,0,0,?2,1,'2026-09-19T00:00:00Z','{}')",
            params![clip_id, format!("[{focus}]")],
        ).unwrap();
        clip_id
    }

    #[test]
    fn photo_run_lists_group_siblings_and_replace_uses_the_best_photo_without_moments() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "连拍", "2026-09-19T08:00:00Z");
        let primary = make_photo(&mut connection, chapter, 120.0);
        let low = make_photo(&mut connection, chapter, 70.0);
        let next = make_photo(&mut connection, chapter, 100.0);
        make_group(&connection, &[primary, low, next]);

        let outcome = auto_select_episode_with(&mut connection, AutoSelectParams {
            scope: Some("all".to_owned()), only_photos: Some(true), photo_count: Some(1),
            ..AutoSelectParams::default()
        }).unwrap();
        let view = list_run(&connection, &outcome.run_id).unwrap();
        assert_eq!(view.rows[0].clip_id, primary);
        assert!(view.rows[0].score > 0.0, "照片结果行使用照片画质分，不依赖时刻分");
        assert_eq!(view.rows[0].siblings.iter().map(|item| item.clip_id).collect::<Vec<_>>(),
            vec![next, low], "相似组照片按画质分列为结果面板 siblings");

        crate::core::ratings::rate_clip(&mut connection, next, "binary", -1).unwrap();
        let after_reject = list_run(&connection, &outcome.run_id).unwrap();
        assert_eq!(after_reject.rows[0].siblings.iter().map(|item| item.clip_id).collect::<Vec<_>>(),
            vec![low], "手动拒绝的照片不能再作为换片或擂台候选");

        let replacement = replace_auto_segment(&mut connection, outcome.created[0]).unwrap();
        assert_eq!(replacement.clip_id, low, "换一张使用未拒绝的最高分照片");
        assert_eq!((replacement.in_ticks, replacement.out_ticks), (0, 0));
        let moment_rows: i64 = connection.query_row("SELECT COUNT(*) FROM clip_moments", [], |row| row.get(0)).unwrap();
        assert_eq!(moment_rows, 0, "照片候选不伪造视频时刻分");
        let video_band_rows: i64 = connection.query_row("SELECT COUNT(*) FROM story_order WHERE tombstone=0", [], |row| row.get(0)).unwrap();
        assert_eq!(video_band_rows, 0, "换照片不进入视频镜头带");
        assert!(undo_replace_auto_segment(&mut connection, &outcome.run_id, outcome.created[0]).unwrap());
        assert_eq!(list_run(&connection, &outcome.run_id).unwrap().rows[0].clip_id, primary, "撤销还回原照片");
    }

    #[test]
    fn photo_run_hides_rejected_rows_but_clear_and_favorite_restore_them() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "照片", "2026-09-19T08:00:00Z");
        let photo = make_photo(&mut connection, chapter, 120.0);
        let outcome = auto_select_episode_with(&mut connection, AutoSelectParams {
            scope: Some("all".to_owned()), only_photos: Some(true), photo_count: Some(1),
            ..AutoSelectParams::default()
        }).unwrap();
        assert_eq!(list_run(&connection, &outcome.run_id).unwrap().rows.len(), 1);

        crate::core::ratings::rate_clip(&mut connection, photo, "binary", -1).unwrap();
        connection.execute(
            "INSERT INTO segments(clip_id,in_ticks,out_ticks,kind,tombstone) VALUES (?1,1,2,'select',0)",
            [photo],
        ).unwrap();
        let later_select = connection.last_insert_rowid();
        connection.execute(
            "INSERT INTO ratings(segment_id,rating_type,value,rated_at) VALUES (?1,'binary',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            [later_select],
        ).unwrap();
        assert!(list_run(&connection, &outcome.run_id).unwrap().rows.is_empty(), "select→X 后结果计数必须立即归零");
        crate::core::ratings::rate_clip(&mut connection, photo, "binary", 0).unwrap();
        assert_eq!(list_run(&connection, &outcome.run_id).unwrap().rows.len(), 1, "0 清除后恢复");
        crate::core::ratings::rate_clip(&mut connection, photo, "binary", -1).unwrap();
        crate::core::ratings::rate_clip(&mut connection, photo, "binary", 1).unwrap();
        assert_eq!(list_run(&connection, &outcome.run_id).unwrap().rows.len(), 1, "F 后恢复");

        let video = add_clip(&mut connection, chapter, 0.9, false, 0);
        let video_outcome = auto_select_episode_with(&mut connection, AutoSelectParams {
            scope: Some("all".to_owned()), only_photos: Some(false),
            ..AutoSelectParams::default()
        }).unwrap();
        crate::core::ratings::rate_clip(&mut connection, video, "binary", -1).unwrap();
        assert_eq!(list_run(&connection, &video_outcome.run_id).unwrap().rows.len(), 1, "视频结果行语义不变");
    }

    #[test]
    fn rejected_photo_sibling_is_neither_listed_nor_replaceable_until_restored() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "连拍", "2026-09-19T08:00:00Z");
        let primary = make_photo(&mut connection, chapter, 120.0);
        let sibling = make_photo(&mut connection, chapter, 100.0);
        make_group(&connection, &[primary, sibling]);
        let outcome = auto_select_episode_with(&mut connection, AutoSelectParams {
            scope: Some("all".to_owned()), only_photos: Some(true), photo_count: Some(1),
            ..AutoSelectParams::default()
        }).unwrap();
        assert_eq!(list_run(&connection, &outcome.run_id).unwrap().rows[0].siblings.len(), 1);

        crate::core::ratings::rate_clip(&mut connection, sibling, "binary", -1).unwrap();
        assert!(list_run(&connection, &outcome.run_id).unwrap().rows[0].siblings.is_empty());
        assert!(replace_auto_segment(&mut connection, outcome.created[0]).unwrap_err().to_string().contains("没有可换"));
        crate::core::ratings::rate_clip(&mut connection, sibling, "binary", 0).unwrap();
        assert_eq!(list_run(&connection, &outcome.run_id).unwrap().rows[0].siblings.len(), 1, "0 恢复 sibling");
        crate::core::ratings::rate_clip(&mut connection, sibling, "binary", -1).unwrap();
        crate::core::ratings::rate_clip(&mut connection, sibling, "binary", 1).unwrap();
        assert_eq!(list_run(&connection, &outcome.run_id).unwrap().rows[0].siblings.len(), 1, "F 恢复 sibling");
    }

    /// P-03:每次自动挑选写一行 `auto_select_runs`,每段挂 run id;`list_run` 行数 = 本批段数,理由是中文短语。
    /// 对 0.10.0 红:没有 run 表、outcome 没有 run_id。
    #[test]
    fn auto_select_writes_a_run_row_and_lists_every_segment_with_reasons() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "机场", "2026-09-18T08:00:00Z");
        add_clip(&mut connection, chapter, 0.9, true, 0);
        add_clip(&mut connection, chapter, 0.8, true, 0);
        let outcome = auto_select_episode(&mut connection, Some(300.0), Some("all")).unwrap();
        assert_eq!(outcome.run_id, outcome.batch_id, "run id 就是 batch id,「全部撤销」不用换钥匙");
        let params: String = connection
            .query_row("SELECT params_json FROM auto_select_runs WHERE run_id = ?1", [&outcome.run_id], |row| row.get(0))
            .unwrap();
        assert!(params.contains("\"scope\":\"all\"") && params.contains("\"target_secs\""), "{params}");
        let view = list_run(&connection, &outcome.run_id).unwrap();
        assert_eq!(view.rows.len(), outcome.created.len());
        assert_eq!(view.rows.len(), 2);
        for row in &view.rows {
            assert!(row.secs > 0.0 && row.score > 0.0, "{row:?}");
            assert!(row.reasons.iter().any(|reason| reason == "清晰"), "{row:?}");
            assert!(row.siblings.is_empty());
        }
    }

    /// P-03「不要这一段」:软删后从结果面板消失、segments −1;「全部撤销」后本批回 0。
    #[test]
    fn dropping_one_row_and_undoing_the_batch_shrink_the_listing() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "机场", "2026-09-18T08:00:00Z");
        add_clip(&mut connection, chapter, 0.9, true, 0);
        add_clip(&mut connection, chapter, 0.8, true, 0);
        add_clip(&mut connection, chapter, 0.7, true, 0);
        let outcome = auto_select_episode(&mut connection, Some(300.0), Some("all")).unwrap();
        assert_eq!(list_run(&connection, &outcome.run_id).unwrap().rows.len(), 3);
        crate::core::ratings::delete_select_segment(&mut connection, outcome.created[1]).unwrap();
        let after = list_run(&connection, &outcome.run_id).unwrap();
        assert_eq!(after.rows.len(), 2);
        assert!(after.rows.iter().all(|row| row.segment_id != outcome.created[1]));
        assert_eq!(live_run_segments(&connection, &outcome.run_id), 2);
        assert_eq!(undo_auto_select(&mut connection, &outcome.batch_id).unwrap(), 2);
        assert_eq!(live_run_segments(&connection, &outcome.run_id), 0);
        assert_eq!(list_run(&connection, &outcome.run_id).unwrap().rows.len(), 0);
    }

    /// P-03「换一段」+ 兄弟段:同组三条只留最高分那条,面板上它的兄弟列出另外两条;
    /// 换一段 → 旧段软删、次高分兄弟顶上、仍挂同一 batch,整批撤销一次收回。
    #[test]
    fn replace_swaps_in_the_best_dedup_sibling_and_stays_in_the_batch() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "机场", "2026-09-18T08:00:00Z");
        let dull = add_clip(&mut connection, chapter, 0.5, true, 0);
        let best = add_clip(&mut connection, chapter, 0.9, true, 0);
        let mid = add_clip(&mut connection, chapter, 0.7, true, 0);
        make_group(&connection, &[best, dull, mid]);
        let outcome = auto_select_episode(&mut connection, Some(300.0), Some("all")).unwrap();
        assert_eq!(outcome.created.len(), 1);
        let view = list_run(&connection, &outcome.run_id).unwrap();
        assert_eq!(view.rows[0].clip_id, best);
        let siblings: Vec<i64> = view.rows[0].siblings.iter().map(|sibling| sibling.clip_id).collect();
        assert_eq!(siblings, vec![mid, dull], "兄弟按分数降序");
        let replaced = replace_auto_segment(&mut connection, outcome.created[0]).unwrap();
        assert_eq!(replaced.clip_id, mid, "换成次高分的兄弟");
        let view = list_run(&connection, &outcome.run_id).unwrap();
        assert_eq!(view.rows.len(), 1);
        assert_eq!(view.rows[0].segment_id, replaced.segment_id);
        let old_tombstoned: i64 = connection
            .query_row("SELECT tombstone FROM segments WHERE id = ?1", [outcome.created[0]], |row| row.get(0))
            .unwrap();
        assert_eq!(old_tombstoned, 1);
        let on_band: i64 = connection
            .query_row("SELECT COUNT(*) FROM story_order WHERE tombstone = 0 AND segment_id = ?1", [replaced.segment_id], |row| row.get(0))
            .unwrap();
        assert_eq!(on_band, 1, "换进来的段已排进镜头带");
        assert_eq!(undo_auto_select(&mut connection, &outcome.batch_id).unwrap(), 1, "整批撤销把换进来的也收回");
        assert_eq!(live_run_segments(&connection, &outcome.run_id), 0);
    }

    /// F-R19-08:「换一段」不能把新段拍到带尾——新段接住旧段在镜头带上原来的位置,
    /// 后面已经排好的其它段不动。对之前调用通用 `arrange_selected_segments(Append)`
    /// 的写法必红:那条路只会把新段追加到当前最大位置之后。
    #[test]
    fn replace_keeps_the_new_segment_at_the_old_segments_band_position() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "机场", "2026-09-18T08:00:00Z");
        let dull = add_clip(&mut connection, chapter, 0.5, true, 0);
        let best = add_clip(&mut connection, chapter, 0.9, true, 0);
        let mid = add_clip(&mut connection, chapter, 0.7, true, 0);
        make_group(&connection, &[best, dull, mid]);
        let other = add_clip(&mut connection, chapter, 0.85, true, 0);
        let outcome = auto_select_episode(&mut connection, Some(300.0), Some("all")).unwrap();
        assert_eq!(outcome.created.len(), 2, "组内只留最高分一条 + other 一条");


        let position_of = |connection: &Connection, segment_id: i64| -> i64 {
            connection
                .query_row(
                    "SELECT position FROM story_order WHERE item_kind = 'segment' AND segment_id = ?1 AND tombstone = 0",
                    [segment_id],
                    |row| row.get(0),
                )
                .unwrap()
        };
        let segment_of = |connection: &Connection, clip_id: i64| -> i64 {
            connection
                .query_row("SELECT id FROM segments WHERE clip_id = ?1 AND kind = 'select' AND tombstone = 0", [clip_id], |row| row.get(0))
                .unwrap()
        };
        let best_segment = segment_of(&connection, best);
        let other_segment = segment_of(&connection, other);
        let best_pos = position_of(&connection, best_segment);
        let other_pos = position_of(&connection, other_segment);
        assert!(best_pos < other_pos, "先决条件:best 排在 other 前面(best_pos={best_pos}, other_pos={other_pos})");

        let replaced = replace_auto_segment(&mut connection, best_segment).unwrap();
        assert_eq!(replaced.clip_id, mid, "换成次高分的兄弟");
        assert_eq!(position_of(&connection, replaced.segment_id), best_pos, "新段接住旧段的位置,不是拍到带尾");
        assert_eq!(position_of(&connection, other_segment), other_pos, "没被换的段位置不动");
        let stale_old_row: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM story_order WHERE segment_id = ?1 AND tombstone = 0",
                [best_segment],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stale_old_row, 0, "旧段在带上的行要被墓碑掉,不能留一条指着已软删段的活行");
    }

    /// 没有兄弟时「换一段」换成同一条素材的下一条建议段;连那也没有就明确报错。
    #[test]
    fn replace_without_siblings_uses_the_next_suggestion_of_the_same_clip() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "机场", "2026-09-18T08:00:00Z");
        let clip = add_clip(&mut connection, chapter, 0.9, true, 0);
        let outcome = auto_select_episode(&mut connection, Some(8.0), Some("all")).unwrap();
        let before = list_run(&connection, &outcome.run_id).unwrap().rows[0].clone();
        let replaced = replace_auto_segment(&mut connection, outcome.created[0]).unwrap();
        assert_eq!(replaced.clip_id, clip);
        assert_ne!(replaced.in_ticks, before.in_ticks, "换到了另一段时间");
        let error = replace_auto_segment(&mut connection, replaced.segment_id + 999).unwrap_err().to_string();
        assert!(error.contains("不是自动挑的"), "{error}");
    }

    /// P-01「按分数」:不做章节轮转,只按分数从高到低装满预算;缺省仍按章节轮转。
    #[test]
    fn score_pick_ignores_chapter_rotation() {
        let (_directory, mut connection) = library();
        let first = add_chapter(&connection, "机场", "2026-09-18T08:00:00Z");
        let second = add_chapter(&connection, "湖边", "2026-09-18T12:00:00Z");
        let a = [add_clip(&mut connection, first, 0.9, true, 0), add_clip(&mut connection, first, 0.8, true, 0), add_clip(&mut connection, first, 0.7, true, 0)];
        let b = [add_clip(&mut connection, second, 0.6, true, 0), add_clip(&mut connection, second, 0.5, true, 0)];
        let picked = |connection: &Connection, run_id: &str| -> Vec<i64> {
            let mut statement = connection.prepare("SELECT clip_id FROM segments WHERE auto_select_run_id = ?1 AND tombstone = 0 ORDER BY id").unwrap();
            statement.query_map([run_id], |row| row.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        let by_chapter = auto_select_episode_with(
            &mut connection,
            AutoSelectParams { budget_secs: Some(24.0), scope: Some("all".to_owned()), ..AutoSelectParams::default() },
        )
        .unwrap();
        assert_eq!(picked(&connection, &by_chapter.run_id), vec![a[0], b[0], a[1]], "轮转:A B A");
        undo_auto_select(&mut connection, &by_chapter.batch_id).unwrap();
        let by_score = auto_select_episode_with(
            &mut connection,
            AutoSelectParams { budget_secs: Some(24.0), scope: Some("all".to_owned()), pick: AutoSelectPick::Score, ..AutoSelectParams::default() },
        )
        .unwrap();
        assert_eq!(picked(&connection, &by_score.run_id), vec![a[0], a[1], a[2]], "按分数:A A A");
        assert_eq!(by_score.chapters_covered, 1);
        assert!(AutoSelectPick::parse(Some("random")).is_err());
    }

    /// P-01 权重偏置:同一份库,「有声为主」让有人声但不那么清晰的那条赢过更清晰的无声那条;不偏置时反过来。
    /// 库里的分不动。
    #[test]
    fn weight_bias_changes_the_winner_without_touching_stored_scores() {
        let (_directory, mut connection) = library();
        let chapter = add_chapter(&connection, "机场", "2026-09-18T08:00:00Z");
        let talky = add_clip(&mut connection, chapter, 0.5, true, 0);
        let crisp = add_clip(&mut connection, chapter, 0.9, true, 0);
        connection
            .execute("UPDATE clip_moments SET sharp = 0.4, loud = 1, speech = 1 WHERE clip_id = ?1", [talky])
            .unwrap();
        connection.execute("UPDATE clip_moments SET sharp = 0.95, loud = 0, speech = 0 WHERE clip_id = ?1", [crisp]).unwrap();
        let winner = |connection: &Connection, run_id: &str| -> i64 {
            connection
                .query_row("SELECT clip_id FROM segments WHERE auto_select_run_id = ?1 AND tombstone = 0", [run_id], |row| row.get(0))
                .unwrap()
        };
        let plain = auto_select_episode_with(
            &mut connection,
            AutoSelectParams { budget_secs: Some(8.0), scope: Some("all".to_owned()), ..AutoSelectParams::default() },
        )
        .unwrap();
        assert_eq!(winner(&connection, &plain.run_id), crisp);
        undo_auto_select(&mut connection, &plain.batch_id).unwrap();
        let weights = parse_weights(Some(r#"{"sharp":0.05,"motion":0.1,"exposure":0.1,"sound":1.0,"no_cut":0.05,"interest":0}"#)).unwrap();
        let biased = auto_select_episode_with(
            &mut connection,
            AutoSelectParams { budget_secs: Some(8.0), scope: Some("all".to_owned()), weights, prompt: Some("有声为主".to_owned()), ..AutoSelectParams::default() },
        )
        .unwrap();
        assert_eq!(winner(&connection, &biased.run_id), talky);
        let stored: f64 = connection
            .query_row("SELECT AVG(score) FROM clip_moments WHERE clip_id = ?1", [talky], |row| row.get(0))
            .unwrap();
        assert!((stored - 0.5).abs() < 1e-9, "库里的分不动:{stored}");
        let view = list_run(&connection, &biased.run_id).unwrap();
        assert_eq!(view.params.prompt.as_deref(), Some("有声为主"));
        assert!(parse_weights(Some(r#"{"faces":1}"#)).is_err(), "不认识的键要拒绝");
    }
}
