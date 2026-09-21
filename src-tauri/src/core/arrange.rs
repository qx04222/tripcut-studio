//! R12 车道 B(规格 §2):挑选 → 排列联动。
//!
//! - `arrange_selected_segments`:把本集全部精选段(手打 + 自动挑选)按章节写进既有的
//!   `story_order`——素材有章就按章(章按 `start_at`),没章的排最后按拍摄时间;不加迁移。
//!   `append`(默认)只补没在带上的段,`replace` 先清掉带上所有行再全量排入。
//! - `undo_arrange(batch_id)`:只撤那一批——本批新写的行打墓碑,本批之前就在带上的行
//!   恢复到排入前的位置;不动后来手打的别的东西。
//! - `skip_chapter`:「这章够了」——0 镜的章标成跳过,不再算缺口;存 settings 键
//!   `story.chapter_skipped.<id>`,同样不加迁移。
//!
//! 批的元数据挂在 `story_history` 的快照 JSON 里(`StorySnapshot.arrange`),`action`
//! 仍是既有 CHECK 允许的 `reorder`,所以 `undo_story_change` 也能整份撤掉它。

use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use super::error::{CoreError, Result};
use super::settings;
use super::story::{
    active_episode_id, capture_snapshot, is_video_clip_in_episode, story_key, upsert_story_order,
    ArrangeMeta, StoryOrderRef, StoryOrderSnapshot, StorySnapshot,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArrangeOutcome {
    /// 本批真正新写进镜头带的段数(`append` 下已在带上的不算)。
    pub placed: usize,
    /// 本批覆盖的章数(未分章的段算一桶)。
    pub chapters: usize,
    /// 传给 `undo_arrange`。
    pub batch_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArrangeMode {
    Append,
    Replace,
}

impl ArrangeMode {
    pub fn parse(mode: Option<&str>) -> Result<Self> {
        match mode {
            None | Some("append") => Ok(Self::Append),
            Some("replace") => Ok(Self::Replace),
            Some(other) => Err(CoreError::Story(format!("排入方式无效:{other}"))),
        }
    }
}

/// 精选段按「章 → 拍摄时间 → 素材 → 入点」的顺序(与镜头带分章 + 按时间视图同一把尺)。
fn ordered_select_segments(connection: &Connection, episode_id: i64) -> Result<Vec<(i64, i64, Option<i64>)>> {
    let mut statement = connection.prepare(
        "SELECT segment.clip_id, segment.id, c.chapter_id
         FROM segments segment
         JOIN clips c ON c.id = segment.clip_id
         LEFT JOIN chapters chapter
           ON chapter.id = c.chapter_id AND chapter.tombstone = 0 AND chapter.episode_id = ?1
         WHERE segment.kind = 'select' AND segment.tombstone = 0
           AND c.missing_since IS NULL
           AND c.kind = 'video'
           AND (c.episode_id = ?1 OR c.episode_id IS NULL)
         ORDER BY chapter.id IS NULL, chapter.start_at, chapter.id,
                  c.captured_at IS NULL,
                  CASE WHEN c.captured_at IS NULL THEN NULL ELSE
                    CAST(strftime('%s', c.captured_at) AS INTEGER) * 1000 + c.journey_offset_ms END,
                  c.id, segment.in_ticks, segment.id",
    )?;
    let rows = statement.query_map([episode_id], |row| {
        let chapter_id: Option<i64> = row.get(2)?;
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, chapter_id))
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(CoreError::from)
}

pub fn arrange_selected_segments(connection: &mut Connection, mode: ArrangeMode) -> Result<ArrangeOutcome> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let episode_id = active_episode_id(&transaction)?;
    let segments = ordered_select_segments(&transaction, episode_id)?;
    let batch_id = format!("arr-{}", uuid::Uuid::new_v4().simple());

    let mut snapshot: StorySnapshot = capture_snapshot(&transaction, episode_id)?;
    transaction.execute(
        "UPDATE story_order SET tombstone = 1,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE episode_id = ?1 AND tombstone = 0
           AND clip_id IN (SELECT id FROM clips WHERE kind <> 'video')",
        [episode_id],
    )?;
    let already: BTreeSet<String> = snapshot
        .order
        .iter()
        .map(|item| story_key(&item.item_kind, item.clip_id, item.segment_id))
        .collect();
    let mut next_position = transaction.query_row(
        "SELECT COALESCE(MAX(position) + 1, 0)
         FROM story_order WHERE episode_id = ?1 AND tombstone = 0",
        [episode_id],
        |row| row.get::<_, i64>(0),
    )?;

    if mode == ArrangeMode::Replace {
        transaction.execute(
            "UPDATE story_order SET tombstone = 1 WHERE episode_id = ?1 AND tombstone = 0",
            [episode_id],
        )?;
        next_position = 0;
    }

    let mut placed = Vec::new();
    let mut chapters = BTreeSet::new();
    for (clip_id, segment_id, chapter_id) in segments {
        let key = story_key("segment", clip_id, Some(segment_id));
        if mode == ArrangeMode::Append && already.contains(&key) {
            continue;
        }
        let item = StoryOrderRef { item_kind: "segment".to_owned(), clip_id, segment_id: Some(segment_id) };
        upsert_story_order(&transaction, &item, episode_id, next_position)?;
        placed.push(StoryOrderSnapshot {
            item_kind: "segment".to_owned(),
            clip_id,
            segment_id: Some(segment_id),
            position: next_position,
        });
        chapters.insert(chapter_id.unwrap_or(-1));
        next_position += 1;
    }

    let outcome = ArrangeOutcome { placed: placed.len(), chapters: chapters.len(), batch_id: batch_id.clone() };
    if placed.is_empty() && mode == ArrangeMode::Append {
        // 没有可补的段就不留一条空撤销记录(replace 清掉了旧行,必须记)。
        transaction.commit()?;
        return Ok(outcome);
    }
    snapshot.arrange = Some(ArrangeMeta { batch_id, placed });
    let json = serde_json::to_string(&snapshot)
        .map_err(|error| CoreError::Story(format!("无法保存撤销快照:{error}")))?;
    transaction.execute(
        "INSERT INTO story_history(action, snapshot, created_at, episode_id)
         VALUES ('reorder', ?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?2)",
        params![json, episode_id],
    )?;
    transaction.commit()?;
    Ok(outcome)
}

/// 只撤这一批:本批新写的行打墓碑;排入前就在带上的行回到原位置。返回撤掉的行数。
pub fn undo_arrange(connection: &mut Connection, batch_id: &str) -> Result<usize> {
    if batch_id.is_empty() || !batch_id.starts_with("arr-") {
        return Err(CoreError::Story("没有可撤销的排入批次".to_owned()));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let episode_id = active_episode_id(&transaction)?;
    let needle = format!("%\"batch_id\":\"{batch_id}\"%");
    let Some((history_id, json)) = transaction
        .query_row(
            "SELECT id, snapshot FROM story_history
             WHERE episode_id = ?1 AND undone_at IS NULL AND snapshot LIKE ?2
             ORDER BY id DESC LIMIT 1",
            params![episode_id, needle],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
    else {
        return Ok(0);
    };
    let snapshot: StorySnapshot = serde_json::from_str(&json)
        .map_err(|error| CoreError::Story(format!("撤销快照无效:{error}")))?;
    let Some(meta) = snapshot.arrange.as_ref().filter(|meta| meta.batch_id == batch_id) else {
        return Ok(0);
    };
    let mut removed = 0;
    for item in &meta.placed {
        removed += transaction.execute(
            "UPDATE story_order SET tombstone = 1,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE episode_id = ?1 AND tombstone = 0
               AND item_kind = 'segment' AND segment_id = ?2",
            params![episode_id, item.segment_id],
        )?;
    }
    for item in &snapshot.order {
        if !is_video_clip_in_episode(&transaction, item.clip_id, episode_id)? {
            continue;
        }
        let item_ref = StoryOrderRef {
            item_kind: item.item_kind.clone(),
            clip_id: item.clip_id,
            segment_id: item.segment_id,
        };
        upsert_story_order(&transaction, &item_ref, episode_id, item.position)?;
    }
    transaction.execute(
        "UPDATE story_history SET undone_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND undone_at IS NULL",
        [history_id],
    )?;
    transaction.commit()?;
    Ok(removed)
}

pub const CHAPTER_SKIPPED_PREFIX: &str = "story.chapter_skipped.";

pub fn chapter_skipped_key(chapter_id: i64) -> String {
    format!("{CHAPTER_SKIPPED_PREFIX}{chapter_id}")
}

/// 「这章够了」:把一章标成跳过(或取消)。跳过的章在镜头带上不算缺口。
pub fn skip_chapter(connection: &Connection, chapter_id: i64, skipped: bool) -> Result<()> {
    let episode_id = active_episode_id(connection)?;
    let exists = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM chapters WHERE id = ?1 AND episode_id = ?2 AND tombstone = 0)",
        params![chapter_id, episode_id],
        |row| row.get::<_, i64>(0),
    )? == 1;
    if !exists {
        return Err(CoreError::Story(format!("章节 {chapter_id} 不存在")));
    }
    settings::set_setting(connection, &chapter_skipped_key(chapter_id), if skipped { "true" } else { "false" })
}

/// 当前库里被标成跳过的章 id(给镜头带算缺口)。
pub fn skipped_chapters(connection: &Connection) -> Result<Vec<i64>> {
    let all = settings::get_settings(connection)?;
    Ok(all
        .iter()
        .filter(|(key, value)| key.starts_with(CHAPTER_SKIPPED_PREFIX) && value.as_str() == "true")
        .filter_map(|(key, _)| key[CHAPTER_SKIPPED_PREFIX.len()..].parse::<i64>().ok())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::story::{chapterize, get_storyboard, set_story_order};
    use crate::core::{db, test_support::TestDirectory};

    fn setup() -> (TestDirectory, Connection) {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('arrange-fixture')", []).unwrap();
        (directory, connection)
    }

    fn insert_clip(connection: &Connection, name: &str, captured_at: &str) -> i64 {
        connection
            .execute(
                "INSERT INTO clips(volume_uuid, rel_path, tb_num, tb_den, duration_ticks, captured_at, imported_at)
                 VALUES ('arrange-fixture', ?1, 1, 1000, 10000, ?2, ?2)",
                params![name, captured_at],
            )
            .unwrap();
        let clip_id = connection.last_insert_rowid();
        connection
            .execute("INSERT INTO segments(clip_id, in_ticks, out_ticks, kind) VALUES (?1, 0, 10000, 'whole')", [clip_id])
            .unwrap();
        clip_id
    }

    fn select(connection: &Connection, clip_id: i64, in_ticks: i64, out_ticks: i64, source: &str) -> i64 {
        connection
            .execute(
                "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind, source) VALUES (?1, ?2, ?3, 'select', ?4)",
                params![clip_id, in_ticks, out_ticks, source],
            )
            .unwrap();
        connection.last_insert_rowid()
    }

    fn live_order(connection: &Connection) -> Vec<(Option<i64>, i64)> {
        let mut statement = connection
            .prepare("SELECT segment_id, position FROM story_order WHERE tombstone = 0 ORDER BY position")
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    /// 两章各两段(一手打一自动,拍摄时间故意倒着插)→ story_order 4 条按章、章内按拍摄时间。
    #[test]
    fn two_chapters_two_segments_each_land_in_chapter_order() {
        let (_directory, mut connection) = setup();
        let late_b = insert_clip(&connection, "b2.mov", "2026-08-31T12:30:00Z");
        let early_a = insert_clip(&connection, "a1.mov", "2026-08-31T10:00:00Z");
        let late_a = insert_clip(&connection, "a2.mov", "2026-08-31T10:05:00Z");
        let early_b = insert_clip(&connection, "b1.mov", "2026-08-31T12:00:00Z");
        chapterize(&mut connection).unwrap();
        let s_late_b = select(&connection, late_b, 1000, 4000, "auto");
        let s_early_a = select(&connection, early_a, 500, 4500, "manual");
        let s_late_a = select(&connection, late_a, 0, 3000, "auto");
        let s_early_b = select(&connection, early_b, 2000, 6000, "manual");

        let outcome = arrange_selected_segments(&mut connection, ArrangeMode::Append).unwrap();
        assert_eq!(outcome.placed, 4);
        assert_eq!(outcome.chapters, 2);
        assert!(outcome.batch_id.starts_with("arr-"));

        let order = live_order(&connection).into_iter().map(|(segment, _)| segment.unwrap()).collect::<Vec<_>>();
        assert_eq!(order, vec![s_early_a, s_late_a, s_early_b, s_late_b]);

        let board = get_storyboard(&connection).unwrap();
        assert_eq!(board.items.len(), 4, "四段全在带上,候选区空");
        assert!(board.candidates.is_empty());
        let chapter_ids = board.items.iter().map(|item| item.chapter_id.unwrap()).collect::<Vec<_>>();
        assert_eq!(chapter_ids[0], chapter_ids[1]);
        assert_eq!(chapter_ids[2], chapter_ids[3]);
        assert_ne!(chapter_ids[0], chapter_ids[2]);

        // 再排一次:没有新段,placed = 0,带上仍是 4 条。
        let again = arrange_selected_segments(&mut connection, ArrangeMode::Append).unwrap();
        assert_eq!(again.placed, 0);
        assert_eq!(live_order(&connection).len(), 4);
    }

    /// undo 只删本批:手工排在前面的整条素材留在原位,本批 3 段全部撤掉。
    #[test]
    fn undo_arrange_only_removes_that_batch() {
        let (_directory, mut connection) = setup();
        let manual = insert_clip(&connection, "m.mov", "2026-08-31T09:00:00Z");
        let one = insert_clip(&connection, "a.mov", "2026-08-31T10:00:00Z");
        let two = insert_clip(&connection, "b.mov", "2026-08-31T10:05:00Z");
        chapterize(&mut connection).unwrap();
        connection
            .execute(
                "INSERT INTO ratings(segment_id, rating_type, value, rated_at)
                 SELECT id, 'binary', 1, '2026-08-31T09:00:00Z' FROM segments WHERE clip_id = ?1",
                [manual],
            )
            .unwrap();
        set_story_order(&mut connection, &[StoryOrderRef { item_kind: "whole".to_owned(), clip_id: manual, segment_id: None }]).unwrap();
        let s_one = select(&connection, one, 0, 3000, "manual");
        let s_two = select(&connection, two, 0, 3000, "auto");

        let outcome = arrange_selected_segments(&mut connection, ArrangeMode::Append).unwrap();
        assert_eq!(outcome.placed, 2);
        assert_eq!(live_order(&connection), vec![(None, 0), (Some(s_one), 1), (Some(s_two), 2)]);

        // 第二批:又多了一段,只有它算新批。
        let three = insert_clip(&connection, "c.mov", "2026-08-31T10:10:00Z");
        chapterize(&mut connection).unwrap();
        let s_three = select(&connection, three, 0, 3000, "manual");
        let second = arrange_selected_segments(&mut connection, ArrangeMode::Append).unwrap();
        assert_eq!(second.placed, 1);

        let removed = undo_arrange(&mut connection, &outcome.batch_id).unwrap();
        assert_eq!(removed, 2);
        let after = live_order(&connection);
        assert_eq!(after.iter().filter(|(segment, _)| segment.is_none()).count(), 1, "手工排的整条素材还在");
        assert!(after.iter().any(|(segment, _)| *segment == Some(s_three)), "第二批不受影响");
        assert!(!after.iter().any(|(segment, _)| *segment == Some(s_one) || *segment == Some(s_two)));
        assert_eq!(undo_arrange(&mut connection, &outcome.batch_id).unwrap(), 0, "撤销幂等");
        assert!(undo_arrange(&mut connection, "auto-xyz").is_err(), "不是排入批号");
    }

    /// replace 先清带再全量排入;撤销后旧行回到原位置。
    #[test]
    fn replace_mode_clears_then_arranges_and_undo_restores() {
        let (_directory, mut connection) = setup();
        let manual = insert_clip(&connection, "m.mov", "2026-08-31T09:00:00Z");
        let one = insert_clip(&connection, "a.mov", "2026-08-31T10:00:00Z");
        chapterize(&mut connection).unwrap();
        connection
            .execute(
                "INSERT INTO ratings(segment_id, rating_type, value, rated_at)
                 SELECT id, 'binary', 1, '2026-08-31T09:00:00Z' FROM segments WHERE clip_id = ?1",
                [manual],
            )
            .unwrap();
        set_story_order(&mut connection, &[StoryOrderRef { item_kind: "whole".to_owned(), clip_id: manual, segment_id: None }]).unwrap();
        let s_one = select(&connection, one, 0, 3000, "auto");

        let outcome = arrange_selected_segments(&mut connection, ArrangeMode::Replace).unwrap();
        assert_eq!(outcome.placed, 1);
        assert_eq!(live_order(&connection), vec![(Some(s_one), 0)]);

        undo_arrange(&mut connection, &outcome.batch_id).unwrap();
        assert_eq!(live_order(&connection), vec![(None, 0)]);
    }

    #[test]
    fn photo_select_segments_never_enter_video_story_order() {
        let (_directory, mut connection) = setup();
        let video = insert_clip(&connection, "video.mov", "2026-08-31T10:00:00Z");
        let photo = insert_clip(&connection, "photo.jpg", "2026-08-31T10:01:00Z");
        connection.execute("UPDATE clips SET kind = 'video' WHERE id = ?1", [video]).unwrap();
        connection.execute("UPDATE clips SET kind = 'photo' WHERE id = ?1", [photo]).unwrap();
        let video_segment = select(&connection, video, 0, 3000, "manual");
        select(&connection, photo, 0, 0, "auto");

        let outcome = arrange_selected_segments(&mut connection, ArrangeMode::Append).unwrap();
        assert_eq!(outcome.placed, 1);
        assert_eq!(live_order(&connection), vec![(Some(video_segment), 0)]);
    }

    #[test]
    fn replace_undo_does_not_restore_historical_photo_order() {
        let (_directory, mut connection) = setup();
        let video = insert_clip(&connection, "video.mov", "2026-08-31T10:00:00Z");
        let next = insert_clip(&connection, "next.mov", "2026-08-31T10:01:00Z");
        let photo = insert_clip(&connection, "photo.jpg", "2026-08-31T10:02:00Z");
        connection.execute("UPDATE clips SET kind = 'photo' WHERE id = ?1", [photo]).unwrap();
        chapterize(&mut connection).unwrap();
        let episode = active_episode_id(&connection).unwrap();
        for (clip_id, position) in [(video, 0_i64), (photo, 1_i64)] {
            connection.execute(
                "INSERT INTO story_order(item_kind, clip_id, segment_id, position, tombstone, created_at, updated_at, episode_id)
                 VALUES ('whole', ?1, NULL, ?2, 0, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z', ?3)",
                params![clip_id, position, episode],
            ).unwrap();
        }
        select(&connection, next, 0, 3000, "manual");

        let outcome = arrange_selected_segments(&mut connection, ArrangeMode::Replace).unwrap();
        undo_arrange(&mut connection, &outcome.batch_id).unwrap();
        let live: Vec<i64> = connection.prepare("SELECT clip_id FROM story_order WHERE tombstone = 0 ORDER BY position").unwrap().query_map([], |row| row.get(0)).unwrap().collect::<std::result::Result<_, _>>().unwrap();
        assert_eq!(live, vec![video]);
    }

    #[test]
    fn append_cleans_historical_photo_position_before_placing_video_segment() {
        let (_directory, mut connection) = setup();
        let video = insert_clip(&connection, "video.mov", "2026-08-31T10:00:00Z");
        let photo = insert_clip(&connection, "photo.jpg", "2026-08-31T10:01:00Z");
        connection.execute("UPDATE clips SET kind = 'photo' WHERE id = ?1", [photo]).unwrap();
        let episode = active_episode_id(&connection).unwrap();
        connection.execute(
            "INSERT INTO story_order(item_kind, clip_id, segment_id, position, tombstone, created_at, updated_at, episode_id)
             VALUES ('whole', ?1, NULL, 0, 0, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z', ?2)",
            params![photo, episode],
        ).unwrap();
        let video_segment = select(&connection, video, 0, 3000, "manual");

        let outcome = arrange_selected_segments(&mut connection, ArrangeMode::Append).unwrap();
        assert_eq!(outcome.placed, 1);
        assert_eq!(live_order(&connection), vec![(Some(video_segment), 0)]);
        assert_eq!(connection.query_row("SELECT tombstone FROM story_order WHERE clip_id = ?1", [photo], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn append_keeps_missing_video_order_and_places_available_segment_after_it() {
        let (_directory, mut connection) = setup();
        let missing = insert_clip(&connection, "offline.mov", "2026-08-31T10:00:00Z");
        let available = insert_clip(&connection, "available.mov", "2026-08-31T10:01:00Z");
        connection.execute("UPDATE clips SET missing_since = '2026-09-19T00:00:00Z' WHERE id = ?1", [missing]).unwrap();
        let episode = active_episode_id(&connection).unwrap();
        connection.execute(
            "INSERT INTO story_order(item_kind, clip_id, segment_id, position, tombstone, created_at, updated_at, episode_id)
             VALUES ('whole', ?1, NULL, 0, 0, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z', ?2)",
            params![missing, episode],
        ).unwrap();
        let available_segment = select(&connection, available, 0, 3000, "manual");

        let outcome = arrange_selected_segments(&mut connection, ArrangeMode::Append).unwrap();
        assert_eq!(outcome.placed, 1);
        assert_eq!(live_order(&connection), vec![(None, 0), (Some(available_segment), 1)]);
        assert_eq!(connection.query_row("SELECT tombstone FROM story_order WHERE clip_id = ?1", [missing], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }

    /// 跳过章:settings 键 `story.chapter_skipped.<id>`,不存在的章拒绝;取消跳过即消失。
    #[test]
    fn skip_chapter_round_trips_through_settings() {
        let (_directory, mut connection) = setup();
        insert_clip(&connection, "a.mov", "2026-08-31T10:00:00Z");
        chapterize(&mut connection).unwrap();
        let chapter_id: i64 = connection.query_row("SELECT id FROM chapters WHERE tombstone = 0", [], |row| row.get(0)).unwrap();

        assert!(skipped_chapters(&connection).unwrap().is_empty());
        skip_chapter(&connection, chapter_id, true).unwrap();
        assert_eq!(skipped_chapters(&connection).unwrap(), vec![chapter_id]);
        assert_eq!(
            settings::setting_value(&connection, &chapter_skipped_key(chapter_id)).unwrap().as_deref(),
            Some("true")
        );
        skip_chapter(&connection, chapter_id, false).unwrap();
        assert!(skipped_chapters(&connection).unwrap().is_empty());
        assert!(skip_chapter(&connection, chapter_id + 99, true).is_err());
    }
}
