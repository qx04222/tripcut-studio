//! P6-U1 全量搜索:Cmd+K 面板的统一检索——文件名/转写/AI 描述/八维标签。
//!
//! LIKE 实现对本地素材库(数百条量级)足够;FTS5 升级列入 backlog。
//! 每路各限 20 条,转写/描述附命中摘录。

use rusqlite::Connection;
use serde::Serialize;

use super::error::Result;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GlobalSearchHit {
    pub kind: String,
    pub clip_id: i64,
    pub file_name: String,
    pub excerpt: String,
}

const PER_KIND_LIMIT: usize = 20;

fn excerpt_around(text: &str, needle: &str, radius: usize) -> String {
    // 不能跨两个字符串复用 byte offset:Unicode 小写化会改变字节长度
    // (例如 "İ" 小写成两个 code point),拿 lowercase 的 index 去切原文会落在
    // UTF-8 字符中间直接 panic。这里改为在原文的 char 序列上逐字符比对。
    let text_lower: Vec<char> = text.chars().flat_map(char::to_lowercase).collect();
    let needle_lower: Vec<char> = needle.chars().flat_map(char::to_lowercase).collect();
    let char_index = if needle_lower.is_empty() {
        None
    } else {
        text_lower
            .windows(needle_lower.len())
            .position(|window| window == needle_lower.as_slice())
    };
    let Some(char_index) = char_index else {
        return text.chars().take(radius * 2).collect();
    };
    let start = char_index.saturating_sub(radius);
    let taken: String = text
        .chars()
        .skip(start)
        .take(radius * 2 + needle.chars().count())
        .collect();
    if start > 0 { format!("…{taken}") } else { taken }
}

pub fn search_everything(connection: &Connection, query: &str) -> Result<Vec<GlobalSearchHit>> {
    let query = query.trim();
    if query.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let pattern = format!(
        "%{}%",
        query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
    );
    let mut hits = Vec::new();

    let push_rows = |sql: &str, kind: &str, hits: &mut Vec<GlobalSearchHit>| -> Result<()> {
        let mut statement = connection.prepare(sql)?;
        let rows = statement.query_map([&pattern], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (clip_id, file_name, source_text) = row?;
            hits.push(GlobalSearchHit {
                kind: kind.to_owned(),
                clip_id,
                file_name,
                excerpt: excerpt_around(&source_text, query, 18),
            });
        }
        Ok(())
    };

    push_rows(
        &format!(
            "SELECT c.id, c.rel_path, c.rel_path FROM clips c
              WHERE c.missing_since IS NULL AND c.rel_path LIKE ?1 ESCAPE '\\'
              ORDER BY c.id LIMIT {PER_KIND_LIMIT}"
        ),
        "file",
        &mut hits,
    )?;
    push_rows(
        &format!(
            "SELECT c.id, c.rel_path, t.text FROM transcript_segments t
              JOIN clips c ON c.id = t.clip_id
             WHERE c.missing_since IS NULL AND t.text LIKE ?1 ESCAPE '\\'
             GROUP BY c.id ORDER BY c.id LIMIT {PER_KIND_LIMIT}"
        ),
        "transcript",
        &mut hits,
    )?;
    push_rows(
        &format!(
            "SELECT c.id, c.rel_path, d.description FROM ai_descriptions d
              JOIN clips c ON c.id = d.clip_id
             WHERE c.missing_since IS NULL AND d.description LIKE ?1 ESCAPE '\\'
             ORDER BY c.id LIMIT {PER_KIND_LIMIT}"
        ),
        "description",
        &mut hits,
    )?;
    push_rows(
        &format!(
            "SELECT c.id, c.rel_path, cd.dimension || ':' || cd.label FROM clip_dimensions cd
              JOIN clips c ON c.id = cd.clip_id
             WHERE c.missing_since IS NULL AND cd.label LIKE ?1 ESCAPE '\\'
             GROUP BY c.id ORDER BY c.id LIMIT {PER_KIND_LIMIT}"
        ),
        "dimension",
        &mut hits,
    )?;
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};

    fn setup() -> (TestDirectory, Connection) {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('gs')", []).unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, duration_ticks, tb_num, tb_den)
                 VALUES (1, 'gs', 'bangkok_walk.mp4', 1000, 1, 1000)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO transcript_segments(clip_id, seg_index, start_ticks, end_ticks, text)
                 VALUES (1, 0, 0, 100, '我们到了曼谷的唐人街，特别热闹')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO ai_descriptions(clip_id, description, tags_json, provider, updated_at)
                 VALUES (1, '街头夜市霓虹灯,人流密集', '[]', 'claude', 'now')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clip_dimensions(clip_id, dimension, label, score, source)
                 VALUES (1, 'subject', '人群', 0.8, 'l2')",
                [],
            )
            .unwrap();
        (directory, connection)
    }

    #[test]
    fn finds_hits_across_all_four_sources() {
        let (_d, connection) = setup();
        assert_eq!(search_everything(&connection, "bangkok").unwrap()[0].kind, "file");
        let transcript = search_everything(&connection, "唐人街").unwrap();
        assert_eq!(transcript[0].kind, "transcript");
        assert!(transcript[0].excerpt.contains("唐人街"));
        assert_eq!(search_everything(&connection, "霓虹").unwrap()[0].kind, "description");
        assert_eq!(search_everything(&connection, "人群").unwrap()[0].kind, "dimension");
    }

    #[test]
    fn unicode_case_expansion_does_not_panic() {
        // 回归:"İ" 小写成 "i\u{307}"(字节变长),旧实现用 lowercase 的 byte index
        // 切原文会落在 UTF-8 字符中间 panic。
        assert!(excerpt_around("İé", "é", 18).contains('é'));
        assert!(!excerpt_around("İé", "x", 18).is_empty());
        // 组合音标与 emoji 邻接
        assert!(excerpt_around("café🎬街拍", "🎬", 4).contains('🎬'));
        assert!(excerpt_around("ÅNGSTRÖM 街景", "ångström", 3).contains('Å'));
    }

    #[test]
    fn short_or_wildcard_queries_are_safe() {
        let (_d, connection) = setup();
        assert!(search_everything(&connection, "a").unwrap().is_empty());
        assert!(search_everything(&connection, "%%").unwrap().is_empty());
    }
}
