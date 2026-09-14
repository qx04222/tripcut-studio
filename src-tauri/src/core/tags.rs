//! R16 P2-10:手动标签。`tags` 表早就在(AI 描述往里写 `source='ai_l3'`,搜索 / 镜头组 / 资产安全
//! 都按它拼关键词),这里只是把「用户自己加 / 删」接上:`source='user'`,挂在素材的 `whole` 段上。
//!
//! AI 标签(`ai_l3`)**不能删**:它们是 `ai_descriptions.tags_json` 的投影,重新生成描述会整组替换;
//! 现有 schema 没有「隐藏」一列,「只隐藏不删」留到加列那一轮(见车道报告)。

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use super::error::{CoreError, Result};

/// 一条标签(AI 的与用户的都在这里,`deletable` 只对 `user` 为真)。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Tag {
    pub id: i64,
    pub label: String,
    pub source: String,
    pub deletable: bool,
}

/// 标签文本上限(字符数):检查器 chip 放得下、也挡住把整段描述当标签贴进来。
pub const TAG_MAX_CHARS: usize = 32;
pub const USER_SOURCE: &str = "user";

fn normalize(text: &str) -> Result<String> {
    let trimmed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() {
        return Err(CoreError::Rating("标签不能是空的".to_owned()));
    }
    if trimmed.chars().count() > TAG_MAX_CHARS {
        return Err(CoreError::Rating(format!("标签太长了(最多 {TAG_MAX_CHARS} 个字)")));
    }
    Ok(trimmed)
}

/// 这条素材的全部标签:AI 的在前(按 id),用户的在后;同一段内按 id。
pub fn list_tags(connection: &Connection, clip_id: i64) -> Result<Vec<Tag>> {
    let mut statement = connection.prepare(
        "SELECT t.id, t.label, COALESCE(t.source, '') FROM tags t
         JOIN segments s ON s.id = t.segment_id
         WHERE s.clip_id = ?1
         ORDER BY CASE WHEN t.source = 'user' THEN 1 ELSE 0 END, t.id",
    )?;
    let rows = statement.query_map([clip_id], |row| {
        let source: String = row.get(2)?;
        Ok(Tag {
            id: row.get(0)?,
            label: row.get(1)?,
            deletable: source == USER_SOURCE,
            source,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn whole_segment_id(transaction: &Connection, clip_id: i64) -> Result<i64> {
    let duration_ticks = transaction
        .query_row("SELECT duration_ticks FROM clips WHERE id = ?1", [clip_id], |row| row.get::<_, Option<i64>>(0))
        .optional()?
        .ok_or_else(|| CoreError::Rating(format!("素材 {clip_id} 不存在")))?;
    let existing = transaction
        .query_row(
            "SELECT id FROM segments WHERE clip_id = ?1 AND kind = 'whole' ORDER BY id LIMIT 1",
            [clip_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    transaction.execute(
        "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind) VALUES (?1, 0, ?2, 'whole')",
        params![clip_id, duration_ticks.unwrap_or(0).max(0)],
    )?;
    Ok(transaction.last_insert_rowid())
}

/// 加一条用户标签。同一条素材上已有同名标签(不论谁加的)→ 直接返回那条,不重复。
pub fn add_tag(connection: &mut Connection, clip_id: i64, text: &str) -> Result<Tag> {
    let label = normalize(text)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing = transaction
        .query_row(
            "SELECT t.id, COALESCE(t.source, '') FROM tags t JOIN segments s ON s.id = t.segment_id
             WHERE s.clip_id = ?1 AND t.label = ?2 ORDER BY t.id LIMIT 1",
            params![clip_id, label],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if let Some((id, source)) = existing {
        transaction.commit()?;
        return Ok(Tag { id, label, deletable: source == USER_SOURCE, source });
    }
    let segment_id = whole_segment_id(&transaction, clip_id)?;
    transaction.execute(
        "INSERT INTO tags(segment_id, label, source, confidence) VALUES (?1, ?2, ?3, NULL)",
        params![segment_id, label, USER_SOURCE],
    )?;
    let id = transaction.last_insert_rowid();
    transaction.commit()?;
    Ok(Tag { id, label, source: USER_SOURCE.to_owned(), deletable: true })
}

/// 删一条**用户**标签。AI 标签拒绝(见模块注释);不属于这条素材的 id 也拒绝。
pub fn remove_tag(connection: &mut Connection, clip_id: i64, tag_id: i64) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let source = transaction
        .query_row(
            "SELECT COALESCE(t.source, '') FROM tags t JOIN segments s ON s.id = t.segment_id
             WHERE t.id = ?1 AND s.clip_id = ?2",
            params![tag_id, clip_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| CoreError::Rating("这条标签已经不在了".to_owned()))?;
    if source != USER_SOURCE {
        return Err(CoreError::Rating(
            "AI 生成的标签不能删除;重新生成 AI 描述会整组替换它们".to_owned(),
        ));
    }
    transaction.execute("DELETE FROM tags WHERE id = ?1", [tag_id])?;
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};

    fn seed(connection: &Connection) {
        connection.execute("INSERT INTO volumes(uuid) VALUES ('v')", []).unwrap();
        connection
            .execute("INSERT INTO clips(id, volume_uuid, rel_path, duration_ticks) VALUES (1, 'v', 'a.mov', 5000), (2, 'v', 'b.mov', NULL)", [])
            .unwrap();
    }

    /// 加 / 列 / 删走一遍:用户标签挂在 whole 段上,去空白、去重;删掉后列表里没有。
    #[test]
    fn add_list_remove_user_tags_round_trip() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        seed(&connection);
        let first = add_tag(&mut connection, 1, "  海边  日落 ").unwrap();
        assert_eq!(first.label, "海边 日落");
        assert!(first.deletable);
        let again = add_tag(&mut connection, 1, "海边 日落").unwrap();
        assert_eq!(again.id, first.id, "同名不重复");
        let second = add_tag(&mut connection, 1, "无人机").unwrap();
        assert_eq!(list_tags(&connection, 1).unwrap().len(), 2);
        let segments: i64 = connection
            .query_row("SELECT count(*) FROM segments WHERE clip_id = 1 AND kind = 'whole'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(segments, 1, "只建一个 whole 段");
        remove_tag(&mut connection, 1, first.id).unwrap();
        assert_eq!(list_tags(&connection, 1).unwrap(), vec![second.clone()]);
        assert!(remove_tag(&mut connection, 1, first.id).is_err(), "已经不在的标签");
        assert!(remove_tag(&mut connection, 2, second.id).is_err(), "不属于这条素材");
        // 时长未知的素材也能加(段长 0)。
        add_tag(&mut connection, 2, "待看").unwrap();
        assert_eq!(list_tags(&connection, 2).unwrap().len(), 1);
    }

    /// 空 / 超长拒绝;AI 标签列出来但不可删(`deletable=false`),删它被拒绝、行还在。
    #[test]
    fn rejects_bad_text_and_protects_ai_tags() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        seed(&connection);
        assert!(add_tag(&mut connection, 1, "   ").is_err());
        assert!(add_tag(&mut connection, 1, &"长".repeat(TAG_MAX_CHARS + 1)).is_err());
        connection
            .execute("INSERT INTO segments(id, clip_id, in_ticks, out_ticks, kind) VALUES (9, 1, 0, 5000, 'whole')", [])
            .unwrap();
        connection
            .execute("INSERT INTO tags(id, segment_id, label, source) VALUES (77, 9, '古城', 'ai_l3')", [])
            .unwrap();
        let listed = list_tags(&connection, 1).unwrap();
        assert_eq!(listed, vec![Tag { id: 77, label: "古城".to_owned(), source: "ai_l3".to_owned(), deletable: false }]);
        let error = remove_tag(&mut connection, 1, 77).unwrap_err().to_string();
        assert!(error.contains("AI 生成的标签不能删除"), "{error}");
        assert_eq!(list_tags(&connection, 1).unwrap().len(), 1);
        // 用户加一个与 AI 同名的:返回 AI 那条,不重复。
        let same = add_tag(&mut connection, 1, "古城").unwrap();
        assert_eq!(same.id, 77);
        assert!(!same.deletable);
    }
}
