//! P6-G2 可编辑 Narrative Revision。
//!
//! Narrative revision 语义冻结：
//! - AI narrate 产物 = `suggested` revision;人工编辑永远落在 `confirmed` revision;
//! - 首次编辑时把最新 suggested 深拷贝为 confirmed(章节+Beat 全量),之后编辑只改 confirmed;
//! - 每次编辑写 narrative_overrides(op + 逆操作),撤销=按链回放逆操作;
//! - 读取端(故事板/交付)取 confirmed 优先,否则最新 suggested;
//! - 重跑 AI 只新增 suggested,confirmed 永不被覆盖。

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::error::{CoreError, Result};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RevisionInfo {
    pub id: i64,
    pub episode_id: i64,
    pub kind: String,
    pub created_at: String,
    pub pending_undo_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum NarrativeOp {
    RenameChapter { chapter_id: i64, title: String },
    SetChapterKind { chapter_id: i64, kind: String },
    MoveBeat { beat_id: i64, to_chapter_id: i64, to_order: i64 },
    SetBeatRole { beat_id: i64, role: String },
}

const CHAPTER_KINDS: &[&str] = &[
    "destination", "attraction", "journey", "experience", "rv_life",
    "people", "unexpected", "information", "atmosphere", "transition",
];
const BEAT_ROLES: &[&str] = &["beat", "montage", "transition"];

/// 读取端权威:confirmed 优先,否则最新 suggested。
pub fn active_revision_id(connection: &Connection, episode_id: i64) -> Result<Option<i64>> {
    connection
        .query_row(
            "SELECT id FROM narrative_revisions
              WHERE episode_id = ?1
              ORDER BY kind = 'confirmed' DESC, id DESC
              LIMIT 1",
            [episode_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
}

pub fn revision_info(connection: &Connection, episode_id: i64) -> Result<Option<RevisionInfo>> {
    let Some(id) = active_revision_id(connection, episode_id)? else {
        return Ok(None);
    };
    connection
        .query_row(
            "SELECT r.id, r.episode_id, r.kind, r.created_at,
                    (SELECT COUNT(*) FROM narrative_overrides o
                      WHERE o.revision_id = r.id AND o.undone_at IS NULL)
             FROM narrative_revisions r WHERE r.id = ?1",
            [id],
            |row| {
                Ok(RevisionInfo {
                    id: row.get(0)?,
                    episode_id: row.get(1)?,
                    kind: row.get(2)?,
                    created_at: row.get(3)?,
                    pending_undo_count: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

/// 无 confirmed 时把最新 suggested 深拷贝为 confirmed;返回 confirmed revision id。
fn ensure_confirmed(transaction: &Connection, episode_id: i64) -> Result<i64> {
    if let Some(id) = transaction
        .query_row(
            "SELECT id FROM narrative_revisions
              WHERE episode_id = ?1 AND kind = 'confirmed'
              ORDER BY id DESC LIMIT 1",
            [episode_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
    {
        return Ok(id);
    }
    let suggested: i64 = transaction
        .query_row(
            "SELECT id FROM narrative_revisions
              WHERE episode_id = ?1 AND kind = 'suggested'
              ORDER BY id DESC LIMIT 1",
            [episode_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| CoreError::Story("该集还没有 AI 编排建议,无法进入人工编辑".to_owned()))?;

    transaction.execute(
        "INSERT INTO narrative_revisions(episode_id, kind, based_on_revision_id, created_at)
         VALUES (?1, 'confirmed', ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![episode_id, suggested],
    )?;
    let confirmed = transaction.last_insert_rowid();

    // 深拷贝章节
    let mut statement = transaction.prepare(
        "SELECT id FROM narrative_chapters WHERE revision_id = ?1 ORDER BY \"order\"",
    )?;
    let chapter_ids = statement
        .query_map([suggested], |row| row.get::<_, i64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for old_chapter in chapter_ids {
        transaction.execute(
            "INSERT INTO narrative_chapters(
                episode_id, kind, title, \"order\", promoted, score, rationale,
                promotion_reason, story_slots_json, missing_slots_json, dh_plan_json, revision_id)
             SELECT episode_id, kind, title, \"order\", promoted, score, rationale,
                    promotion_reason, story_slots_json, missing_slots_json, dh_plan_json, ?2
             FROM narrative_chapters WHERE id = ?1",
            params![old_chapter, confirmed],
        )?;
        let new_chapter = transaction.last_insert_rowid();
        transaction.execute(
            "INSERT INTO narrative_beats(chapter_id, clip_id, segment_id, role, \"order\", score, rationale)
             SELECT ?2, clip_id, segment_id, role, \"order\", score, rationale
             FROM narrative_beats WHERE chapter_id = ?1",
            params![old_chapter, new_chapter],
        )?;
    }
    Ok(confirmed)
}

fn chapter_revision(transaction: &Connection, chapter_id: i64) -> Result<i64> {
    transaction
        .query_row(
            "SELECT revision_id FROM narrative_chapters WHERE id = ?1",
            [chapter_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten()
        .ok_or_else(|| CoreError::Story(format!("章节 {chapter_id} 不存在或未挂修订")))
}

fn build_inverse(transaction: &Connection, op: &NarrativeOp) -> Result<NarrativeOp> {
    match op {
        NarrativeOp::RenameChapter { chapter_id, .. } => {
            let title: String = transaction.query_row(
                "SELECT title FROM narrative_chapters WHERE id = ?1",
                [chapter_id],
                |row| row.get(0),
            )?;
            Ok(NarrativeOp::RenameChapter { chapter_id: *chapter_id, title })
        }
        NarrativeOp::SetChapterKind { chapter_id, .. } => {
            let kind: String = transaction.query_row(
                "SELECT kind FROM narrative_chapters WHERE id = ?1",
                [chapter_id],
                |row| row.get(0),
            )?;
            Ok(NarrativeOp::SetChapterKind { chapter_id: *chapter_id, kind })
        }
        NarrativeOp::MoveBeat { beat_id, .. } => {
            let (chapter_id, order): (i64, i64) = transaction.query_row(
                "SELECT chapter_id, \"order\" FROM narrative_beats WHERE id = ?1",
                [beat_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            Ok(NarrativeOp::MoveBeat { beat_id: *beat_id, to_chapter_id: chapter_id, to_order: order })
        }
        NarrativeOp::SetBeatRole { beat_id, .. } => {
            let role: String = transaction.query_row(
                "SELECT role FROM narrative_beats WHERE id = ?1",
                [beat_id],
                |row| row.get(0),
            )?;
            Ok(NarrativeOp::SetBeatRole { beat_id: *beat_id, role })
        }
    }
}

fn execute_op(transaction: &Connection, op: &NarrativeOp) -> Result<()> {
    match op {
        NarrativeOp::RenameChapter { chapter_id, title } => {
            let title = title.trim();
            if title.is_empty() || title.chars().count() > 120 {
                return Err(CoreError::Story("章节标题必须为 1-120 字".to_owned()));
            }
            transaction.execute(
                "UPDATE narrative_chapters SET title = ?1 WHERE id = ?2",
                params![title, chapter_id],
            )?;
        }
        NarrativeOp::SetChapterKind { chapter_id, kind } => {
            if !CHAPTER_KINDS.contains(&kind.as_str()) {
                return Err(CoreError::Story(format!("未知章节类型:{kind}")));
            }
            transaction.execute(
                "UPDATE narrative_chapters SET kind = ?1 WHERE id = ?2",
                params![kind, chapter_id],
            )?;
        }
        NarrativeOp::MoveBeat { beat_id, to_chapter_id, to_order } => {
            let (from_chapter, from_order): (i64, i64) = transaction.query_row(
                "SELECT chapter_id, \"order\" FROM narrative_beats WHERE id = ?1",
                [beat_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if *to_order < 0 {
                return Err(CoreError::Story("Beat 顺序不能为负".to_owned()));
            }
            // UNIQUE(chapter_id, order):先挪出到临时高位,腾位后落位。
            transaction.execute(
                "UPDATE narrative_beats SET \"order\" = (
                    SELECT COALESCE(MAX(\"order\"), 0) + 1000 FROM narrative_beats
                     WHERE chapter_id = ?2
                 ) WHERE id = ?1",
                params![beat_id, from_chapter],
            )?;
            transaction.execute(
                "UPDATE narrative_beats SET \"order\" = \"order\" - 1
                  WHERE chapter_id = ?1 AND \"order\" > ?2 AND \"order\" < 900",
                params![from_chapter, from_order],
            )?;
            // 目标章为落点腾位(倒序移避免 UNIQUE 冲突)
            let mut statement = transaction.prepare(
                "SELECT id FROM narrative_beats
                  WHERE chapter_id = ?1 AND \"order\" >= ?2 AND \"order\" < 900
                  ORDER BY \"order\" DESC",
            )?;
            let shift_ids = statement
                .query_map(params![to_chapter_id, to_order], |row| row.get::<_, i64>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            for id in shift_ids {
                transaction.execute(
                    "UPDATE narrative_beats SET \"order\" = \"order\" + 1 WHERE id = ?1",
                    [id],
                )?;
            }
            transaction.execute(
                "UPDATE narrative_beats SET chapter_id = ?2, \"order\" = ?3 WHERE id = ?1",
                params![beat_id, to_chapter_id, to_order],
            )?;
        }
        NarrativeOp::SetBeatRole { beat_id, role } => {
            if !BEAT_ROLES.contains(&role.as_str()) {
                return Err(CoreError::Story(format!("未知 Beat 角色:{role}")));
            }
            transaction.execute(
                "UPDATE narrative_beats SET role = ?1 WHERE id = ?2",
                params![role, beat_id],
            )?;
        }
    }
    Ok(())
}

/// 把 op 里的章节/Beat id 从 suggested 空间映射到 confirmed 空间。
/// 首次编辑时前端持有的是 suggested 的 id;深拷贝后需按(revision 内序号)对齐。
fn remap_op(transaction: &Connection, op: NarrativeOp, confirmed: i64) -> Result<NarrativeOp> {
    let map_chapter = |chapter_id: i64| -> Result<i64> {
        let owner = chapter_revision(transaction, chapter_id)?;
        if owner == confirmed {
            return Ok(chapter_id);
        }
        transaction
            .query_row(
                "SELECT c2.id FROM narrative_chapters c1
                  JOIN narrative_chapters c2
                    ON c2.revision_id = ?2 AND c2.\"order\" = c1.\"order\"
                 WHERE c1.id = ?1",
                params![chapter_id, confirmed],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| CoreError::Story("章节在确认版中不存在,请刷新故事板".to_owned()))
    };
    let map_beat = |beat_id: i64| -> Result<i64> {
        let owner: i64 = transaction.query_row(
            "SELECT c.revision_id FROM narrative_beats b
              JOIN narrative_chapters c ON c.id = b.chapter_id
             WHERE b.id = ?1",
            [beat_id],
            |row| row.get(0),
        )?;
        if owner == confirmed {
            return Ok(beat_id);
        }
        transaction
            .query_row(
                "SELECT b2.id FROM narrative_beats b1
                  JOIN narrative_chapters c1 ON c1.id = b1.chapter_id
                  JOIN narrative_chapters c2
                    ON c2.revision_id = ?2 AND c2.\"order\" = c1.\"order\"
                  JOIN narrative_beats b2
                    ON b2.chapter_id = c2.id AND b2.\"order\" = b1.\"order\"
                 WHERE b1.id = ?1",
                params![beat_id, confirmed],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| CoreError::Story("Beat 在确认版中不存在,请刷新故事板".to_owned()))
    };
    Ok(match op {
        NarrativeOp::RenameChapter { chapter_id, title } => {
            NarrativeOp::RenameChapter { chapter_id: map_chapter(chapter_id)?, title }
        }
        NarrativeOp::SetChapterKind { chapter_id, kind } => {
            NarrativeOp::SetChapterKind { chapter_id: map_chapter(chapter_id)?, kind }
        }
        NarrativeOp::MoveBeat { beat_id, to_chapter_id, to_order } => NarrativeOp::MoveBeat {
            beat_id: map_beat(beat_id)?,
            to_chapter_id: map_chapter(to_chapter_id)?,
            to_order,
        },
        NarrativeOp::SetBeatRole { beat_id, role } => {
            NarrativeOp::SetBeatRole { beat_id: map_beat(beat_id)?, role }
        }
    })
}

pub fn apply_op(connection: &mut Connection, episode_id: i64, op: NarrativeOp) -> Result<RevisionInfo> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let confirmed = ensure_confirmed(&transaction, episode_id)?;
    let op = remap_op(&transaction, op, confirmed)?;
    let inverse = build_inverse(&transaction, &op)?;
    execute_op(&transaction, &op)?;
    transaction.execute(
        "INSERT INTO narrative_overrides(revision_id, op_json, inverse_json, applied_at)
         VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![
            confirmed,
            serde_json::to_string(&op).map_err(|e| CoreError::Story(e.to_string()))?,
            serde_json::to_string(&inverse).map_err(|e| CoreError::Story(e.to_string()))?,
        ],
    )?;
    transaction.commit()?;
    revision_info(connection, episode_id)?
        .ok_or_else(|| CoreError::Story("修订状态读取失败".to_owned()))
}

pub fn undo_last(connection: &mut Connection, episode_id: i64) -> Result<Option<RevisionInfo>> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some(revision) = transaction
        .query_row(
            "SELECT id FROM narrative_revisions
              WHERE episode_id = ?1 AND kind = 'confirmed'
              ORDER BY id DESC LIMIT 1",
            [episode_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
    else {
        return Ok(None);
    };
    let Some((override_id, inverse_json)) = transaction
        .query_row(
            "SELECT id, inverse_json FROM narrative_overrides
              WHERE revision_id = ?1 AND undone_at IS NULL
              ORDER BY id DESC LIMIT 1",
            [revision],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
    else {
        return Ok(None);
    };
    let inverse: NarrativeOp = serde_json::from_str(&inverse_json)
        .map_err(|e| CoreError::Story(format!("撤销记录损坏:{e}")))?;
    execute_op(&transaction, &inverse)?;
    transaction.execute(
        "UPDATE narrative_overrides
            SET undone_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?1",
        [override_id],
    )?;
    transaction.commit()?;
    revision_info(connection, episode_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};

    fn setup() -> (TestDirectory, Connection) {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection
            .execute("INSERT INTO volumes(uuid) VALUES ('nrv')", [])
            .unwrap();
        (directory, connection)
    }

    /// 建一个 suggested revision:两章,第一章两个 beat。返回 (episode, chapter1, chapter2, beat1, beat2)。
    fn seed_suggested(connection: &Connection) -> (i64, i64, i64, i64, i64) {
        let episode: i64 = connection
            .query_row("SELECT id FROM episodes WHERE status='active'", [], |r| r.get(0))
            .unwrap();
        connection
            .execute(
                "INSERT INTO narrative_revisions(episode_id, kind, created_at)
                 VALUES (?1, 'suggested', 'now')",
                [episode],
            )
            .unwrap();
        let revision = connection.last_insert_rowid();
        let mut chapters = Vec::new();
        for (order, title) in [(0, "出发"), (1, "在途")] {
            connection
                .execute(
                    "INSERT INTO narrative_chapters(
                        episode_id, kind, title, \"order\", promoted, score, rationale,
                        promotion_reason, story_slots_json, missing_slots_json, dh_plan_json, revision_id)
                     VALUES (?1, 'journey', ?2, ?3, 0, 0.8, 'r', '', '[]', '[]', 'null', ?4)",
                    params![episode, title, order, revision],
                )
                .unwrap();
            chapters.push(connection.last_insert_rowid());
        }
        for (order, name) in [(0, "b0.mov"), (1, "b1.mov")] {
            connection
                .execute(
                    "INSERT INTO clips(volume_uuid, rel_path, duration_ticks, tb_num, tb_den)
                     VALUES ('nrv', ?1, 1000, 1, 1000)",
                    [name],
                )
                .unwrap();
            let clip = connection.last_insert_rowid();
            connection
                .execute(
                    "INSERT INTO narrative_beats(chapter_id, clip_id, role, \"order\", score, rationale)
                     VALUES (?1, ?2, 'beat', ?3, 0.8, 'r')",
                    params![chapters[0], clip, order],
                )
                .unwrap();
        }
        let beats: Vec<i64> = connection
            .prepare("SELECT id FROM narrative_beats ORDER BY \"order\"")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
        (episode, chapters[0], chapters[1], beats[0], beats[1])
    }

    #[test]
    fn first_edit_deep_copies_suggested_into_confirmed() {
        let (_d, mut connection) = setup();
        let (episode, chapter1, ..) = seed_suggested(&connection);
        let info = apply_op(
            &mut connection,
            episode,
            NarrativeOp::RenameChapter { chapter_id: chapter1, title: "启程日".to_owned() },
        )
        .unwrap();
        assert_eq!(info.kind, "confirmed");
        // suggested 原文未被改动
        let original: String = connection
            .query_row("SELECT title FROM narrative_chapters WHERE id=?1", [chapter1], |r| r.get(0))
            .unwrap();
        assert_eq!(original, "出发");
        // confirmed 拷贝里已改名,且 beat 一并拷贝
        let renamed: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM narrative_chapters c
                  JOIN narrative_revisions r ON r.id = c.revision_id
                 WHERE r.kind='confirmed' AND c.title='启程日'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(renamed, 1);
        let copied_beats: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM narrative_beats b
                  JOIN narrative_chapters c ON c.id = b.chapter_id
                  JOIN narrative_revisions r ON r.id = c.revision_id
                 WHERE r.kind='confirmed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(copied_beats, 2);
    }

    #[test]
    fn move_beat_across_chapters_and_undo_restores_order() {
        let (_d, mut connection) = setup();
        let (episode, _c1, chapter2, beat1, _b2) = seed_suggested(&connection);
        apply_op(
            &mut connection,
            episode,
            NarrativeOp::MoveBeat { beat_id: beat1, to_chapter_id: chapter2, to_order: 0 },
        )
        .unwrap();
        // confirmed 空间:第二章(order=1)有 1 个 beat,第一章剩 1 个
        let (in_second, in_first): (i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM narrative_beats b JOIN narrative_chapters c ON c.id=b.chapter_id
                     JOIN narrative_revisions r ON r.id=c.revision_id
                    WHERE r.kind='confirmed' AND c.\"order\"=1),
                   (SELECT COUNT(*) FROM narrative_beats b JOIN narrative_chapters c ON c.id=b.chapter_id
                     JOIN narrative_revisions r ON r.id=c.revision_id
                    WHERE r.kind='confirmed' AND c.\"order\"=0)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((in_second, in_first), (1, 1));
        // 撤销后回到 2/0
        undo_last(&mut connection, episode).unwrap().unwrap();
        let (second_after, first_after): (i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM narrative_beats b JOIN narrative_chapters c ON c.id=b.chapter_id
                     JOIN narrative_revisions r ON r.id=c.revision_id
                    WHERE r.kind='confirmed' AND c.\"order\"=1),
                   (SELECT COUNT(*) FROM narrative_beats b JOIN narrative_chapters c ON c.id=b.chapter_id
                     JOIN narrative_revisions r ON r.id=c.revision_id
                    WHERE r.kind='confirmed' AND c.\"order\"=0)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((second_after, first_after), (0, 2));
    }

    #[test]
    fn active_revision_prefers_confirmed_and_rerun_keeps_it() {
        let (_d, mut connection) = setup();
        let (episode, chapter1, ..) = seed_suggested(&connection);
        let suggested = active_revision_id(&connection, episode).unwrap().unwrap();
        apply_op(
            &mut connection,
            episode,
            NarrativeOp::SetBeatRole { beat_id: 1, role: "montage".to_owned() },
        )
        .unwrap();
        let confirmed = active_revision_id(&connection, episode).unwrap().unwrap();
        assert_ne!(confirmed, suggested);
        // 重跑 AI = 再插一个 suggested;confirmed 仍是读取权威
        connection
            .execute(
                "INSERT INTO narrative_revisions(episode_id, kind, created_at)
                 VALUES (?1, 'suggested', 'now2')",
                [episode],
            )
            .unwrap();
        assert_eq!(active_revision_id(&connection, episode).unwrap().unwrap(), confirmed);
        let _ = chapter1;
    }

    #[test]
    fn editing_without_any_suggestion_is_refused() {
        let (_d, mut connection) = setup();
        let episode: i64 = connection
            .query_row("SELECT id FROM episodes WHERE status='active'", [], |r| r.get(0))
            .unwrap();
        let error = apply_op(
            &mut connection,
            episode,
            NarrativeOp::RenameChapter { chapter_id: 1, title: "x".to_owned() },
        )
        .unwrap_err();
        assert!(error.to_string().contains("没有 AI 编排建议"));
    }
}
