//! P6-G4 Routine Review & Override:人工是 Routine 判定的最终裁量者。
//!
//! - override 按(集, 素材)一行,幂等 upsert;
//! - cleared=1 = 「这不是 Routine」,读取端应抹掉 routine_suggestion;
//! - treatment 覆盖 AI 建议的处理方式;
//! - 「全部接受」把当前故事板上全部未覆盖的建议一次落为 override(可逐条再改)。

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;

use super::channel_memory::RoutineSuggestion;
use super::error::{CoreError, Result};

/// Routine 处理方式的唯一权威枚举:AI 推导与人工覆盖共用同一套。
/// 前三项是 AI 会给出的叙事定位,后三项是人工可选的剪辑动作;
/// 二者合并成一套,避免出现「AI 建议无法被人工接受」的协议裂缝。
pub const TREATMENTS: &[&str] = &[
    "explained",    // 首次出现,值得完整解释
    "story_event",  // 出现变化,升级为主故事事件
    "montage",      // 重复内容,压缩为 Montage
    "transition",   // 压成过场
    "beat",         // 保留为普通 Beat
    "full",         // 整条保留
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RoutineOverride {
    pub clip_id: i64,
    pub routine_kind: Option<String>,
    pub treatment: Option<String>,
    pub cleared: bool,
}

fn active_episode(connection: &Connection) -> Result<i64> {
    connection
        .query_row("SELECT id FROM episodes WHERE status = 'active'", [], |row| row.get(0))
        .optional()?
        .ok_or_else(|| CoreError::Story("没有进行中的集".to_owned()))
}

fn ensure_clip_writable(transaction: &Transaction<'_>, episode: i64, clip_id: i64) -> Result<()> {
    let owner = transaction
        .query_row("SELECT episode_id FROM clips WHERE id = ?1", [clip_id], |row| {
            row.get::<_, Option<i64>>(0)
        })
        .optional()?;
    match owner {
        None => Err(CoreError::Story(format!("素材 {clip_id} 不存在"))),
        Some(Some(owner)) if owner != episode => Err(CoreError::Story(format!(
            "素材 {clip_id} 属于其他或已封存 Episode，拒绝修改 Routine 裁量"
        ))),
        Some(_) => Ok(()),
    }
}

pub fn set_override(
    connection: &mut Connection,
    clip_id: i64,
    treatment: Option<&str>,
    cleared: bool,
) -> Result<()> {
    if let Some(value) = treatment {
        if !TREATMENTS.contains(&value) {
            return Err(CoreError::Story(format!("未知 Routine 处理:{value}")));
        }
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let episode = active_episode(&transaction)?;
    ensure_clip_writable(&transaction, episode, clip_id)?;
    transaction.execute(
        "INSERT INTO routine_overrides(episode_id, clip_id, treatment, cleared, updated_at)
         VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(episode_id, clip_id) DO UPDATE SET
            treatment = excluded.treatment,
            cleared = excluded.cleared,
            updated_at = excluded.updated_at",
        params![episode, clip_id, treatment, cleared as i64],
    )?;
    transaction.commit()?;
    Ok(())
}

pub fn remove_override(connection: &mut Connection, clip_id: i64) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let episode = active_episode(&transaction)?;
    ensure_clip_writable(&transaction, episode, clip_id)?;
    transaction.execute(
        "DELETE FROM routine_overrides WHERE episode_id = ?1 AND clip_id = ?2",
        params![episode, clip_id],
    )?;
    transaction.commit()?;
    Ok(())
}

pub fn override_for(connection: &Connection, clip_id: i64) -> Result<Option<RoutineOverride>> {
    let Some(episode) = connection
        .query_row("SELECT id FROM episodes WHERE status = 'active'", [], |row| row.get::<_, i64>(0))
        .optional()?
    else {
        return Ok(None);
    };
    connection
        .query_row(
            "SELECT clip_id, routine_kind, treatment, cleared FROM routine_overrides
              WHERE episode_id = ?1 AND clip_id = ?2",
            params![episode, clip_id],
            |row| {
                Ok(RoutineOverride {
                    clip_id: row.get(0)?,
                    routine_kind: row.get(1)?,
                    treatment: row.get(2)?,
                    cleared: row.get::<_, i64>(3)? == 1,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

/// 把人工裁量应用到 AI 推导的建议上;cleared 直接抹掉建议。
pub fn apply(
    connection: &Connection,
    clip_id: i64,
    suggestion: Option<RoutineSuggestion>,
) -> Result<Option<RoutineSuggestion>> {
    let Some(record) = override_for(connection, clip_id)? else {
        return Ok(suggestion);
    };
    if record.cleared {
        return Ok(None);
    }
    Ok(suggestion.map(|mut value| {
        if let Some(treatment) = record.treatment {
            value.treatment = treatment;
            value.reason = format!("人工确认:{}", value.reason);
        }
        value
    }))
}

/// 「全部接受降级建议」:把 (clip_id, treatment) 建议清单一次落为 override,已覆盖的跳过。
/// 返回落库条数。
pub fn accept_all(connection: &mut Connection, suggestions: &[(i64, String)]) -> Result<u64> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let episode = active_episode(&transaction)?;
    for (clip_id, treatment) in suggestions {
        if !TREATMENTS.contains(&treatment.as_str()) {
            return Err(CoreError::Story(format!("未知 Routine 处理:{treatment}")));
        }
        ensure_clip_writable(&transaction, episode, *clip_id)?;
    }
    let mut accepted = 0;
    for (clip_id, treatment) in suggestions {
        let changed = transaction.execute(
            "INSERT INTO routine_overrides(episode_id, clip_id, treatment, cleared, updated_at)
             VALUES (?1, ?2, ?3, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(episode_id, clip_id) DO NOTHING",
            params![episode, clip_id, treatment],
        )?;
        accepted += changed as u64;
    }
    transaction.commit()?;
    Ok(accepted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};

    fn setup() -> (TestDirectory, Connection) {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('ro')", []).unwrap();
        connection
            .execute(
                "INSERT INTO clips(volume_uuid, rel_path, duration_ticks, tb_num, tb_den)
                 VALUES ('ro', 'a.mov', 1000, 1, 1000)",
                [],
            )
            .unwrap();
        (directory, connection)
    }

    fn suggestion() -> RoutineSuggestion {
        RoutineSuggestion {
            routine_kind: "driving".to_owned(),
            treatment: "montage".to_owned(),
            previous_occurrences: 3,
            changed: false,
            reason: "连续驾驶重复".to_owned(),
        }
    }

    #[test]
    fn cleared_override_erases_the_suggestion() {
        let (_d, mut connection) = setup();
        let clip = 1;
        set_override(&mut connection, clip, None, true).unwrap();
        assert_eq!(apply(&connection, clip, Some(suggestion())).unwrap(), None);
        remove_override(&mut connection, clip).unwrap();
        assert!(apply(&connection, clip, Some(suggestion())).unwrap().is_some());
    }

    #[test]
    fn treatment_override_rewrites_and_marks_manual() {
        let (_d, mut connection) = setup();
        set_override(&mut connection, 1, Some("transition"), false).unwrap();
        let out = apply(&connection, 1, Some(suggestion())).unwrap().unwrap();
        assert_eq!(out.treatment, "transition");
        assert!(out.reason.starts_with("人工确认:"));
    }

    #[test]
    fn ai_derived_treatments_are_acceptable() {
        // 回归:覆盖层曾只认 beat/montage/transition/full,而 AI 只产
        // explained/story_event/montage,导致「全部接受」静默跳过前两者
        // (按钮说全部接受,实际什么都没落库)。
        let (_d, mut connection) = setup();
        for treatment in ["explained", "story_event", "montage", "transition", "beat", "full"] {
            assert!(
                TREATMENTS.contains(&treatment),
                "{treatment} 应属于统一枚举"
            );
            set_override(&mut connection, 1, Some(treatment), false).unwrap();
            let record = override_for(&connection, 1).unwrap().unwrap();
            assert_eq!(record.treatment.as_deref(), Some(treatment));
        }
        remove_override(&mut connection, 1).unwrap();
        // AI 的 explained 建议现在能被批量接受
        let accepted = accept_all(&mut connection, &[(1, "explained".to_owned())]).unwrap();
        assert_eq!(accepted, 1, "AI 建议必须能被「全部接受」落库");
    }

    #[test]
    fn accept_all_skips_existing_overrides_and_is_idempotent() {
        let (_d, mut connection) = setup();
        set_override(&mut connection, 1, Some("beat"), false).unwrap();
        let accepted = accept_all(
            &mut connection,
            &[(1, "montage".to_owned()), (1, "montage".to_owned())],
        )
        .unwrap();
        assert_eq!(accepted, 0);
        // 已有的人工 beat 不被批量覆盖
        let record = override_for(&connection, 1).unwrap().unwrap();
        assert_eq!(record.treatment.as_deref(), Some("beat"));
    }
}
