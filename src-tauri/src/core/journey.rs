//! 只读的「旅程时间线」:按标准时间(captured_at + journey_offset_ms 校正)
//! 把素材与叙事产出的地点卡排成一条竖向时间轴。不写任何数据,纯查询。
//!
//! 标准时间与排序 epoch 的算法与 `story.rs::load_clip_moments` 同源——两处
//! 都是 `captured_at` 按 `journey_offset_ms`(毫秒)校正后取 epoch 排序,
//! 这里保持同样的 SQL 表达式,避免两处校正结果不一致。

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use super::error::Result;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct JourneyEntry {
    pub kind: String,
    /// ISO-8601,标准时间校正后的值;`undated` 为 true 时是空字符串。
    pub canonical_time: String,
    pub undated: bool,
    pub clip_id: Option<i64>,
    pub file_name: Option<String>,
    /// 由调用方(tauri 命令层)按 `list_clips` 的同一套逻辑事后填充,这里恒为 None。
    pub cover_url: Option<String>,
    pub destination_id: Option<i64>,
    pub title: Option<String>,
    pub place_name: Option<String>,
}

struct DatedClip {
    id: i64,
    canonical_time: String,
    epoch: i64,
    file_name: String,
}

struct UndatedClip {
    id: i64,
    file_name: String,
}

struct DatedDestination {
    id: i64,
    canonical_time: String,
    epoch: i64,
    title: String,
    place_name: String,
}

struct UndatedDestination {
    id: i64,
    title: String,
    place_name: String,
    chapter_order: i64,
}

fn file_name_from_rel_path(rel_path: &str) -> String {
    std::path::Path::new(rel_path)
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or(rel_path)
        .to_owned()
}

fn load_dated_clips(connection: &Connection, episode_id: i64) -> Result<Vec<DatedClip>> {
    let mut statement = connection.prepare(
        "SELECT c.id, c.rel_path,
                strftime(
                    '%Y-%m-%dT%H:%M:%fZ', c.captured_at,
                    printf('%+f seconds', c.journey_offset_ms / 1000.0)
                ),
                CAST(strftime('%s', c.captured_at) AS INTEGER) * 1000
                    + c.journey_offset_ms
         FROM clips c
         WHERE c.missing_since IS NULL
           AND (c.episode_id = ?1 OR c.episode_id IS NULL)
           AND c.captured_at IS NOT NULL
           AND strftime('%s', c.captured_at) IS NOT NULL",
    )?;
    let rows = statement.query_map([episode_id], |row| {
        Ok(DatedClip {
            id: row.get(0)?,
            file_name: file_name_from_rel_path(&row.get::<_, String>(1)?),
            canonical_time: row.get(2)?,
            epoch: row.get(3)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn load_undated_clips(connection: &Connection, episode_id: i64) -> Result<Vec<UndatedClip>> {
    let mut statement = connection.prepare(
        "SELECT c.id, c.rel_path
         FROM clips c
         WHERE c.missing_since IS NULL
           AND (c.episode_id = ?1 OR c.episode_id IS NULL)
           AND (c.captured_at IS NULL OR strftime('%s', c.captured_at) IS NULL)
         ORDER BY c.id",
    )?;
    let rows = statement.query_map([episode_id], |row| {
        Ok(UndatedClip {
            id: row.get(0)?,
            file_name: file_name_from_rel_path(&row.get::<_, String>(1)?),
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

/// 地点卡本身不落时间列,标准时间取自它所属章节里最早的有效标准时间素材
/// (经 `narrative_beats` 关联)。章节内一个有标准时间的素材都没有时,
/// 地点卡整体算未标时间,按章节 `order` 排在未标时间区。
fn load_dated_destinations(
    connection: &Connection,
    episode_id: i64,
) -> Result<Vec<DatedDestination>> {
    let mut statement = connection.prepare(
        "SELECT card.id, card.name, chapter.title,
                MIN(
                    CAST(strftime('%s', c.captured_at) AS INTEGER) * 1000
                        + c.journey_offset_ms
                ),
                MIN(
                    strftime(
                        '%Y-%m-%dT%H:%M:%fZ', c.captured_at,
                        printf('%+f seconds', c.journey_offset_ms / 1000.0)
                    )
                )
         FROM destination_cards card
         JOIN narrative_chapters chapter ON chapter.id = card.chapter_id
         JOIN narrative_beats beat ON beat.chapter_id = card.chapter_id
         JOIN clips c ON c.id = beat.clip_id
         WHERE chapter.episode_id = ?1
           AND c.missing_since IS NULL
           AND c.captured_at IS NOT NULL
           AND strftime('%s', c.captured_at) IS NOT NULL
         GROUP BY card.id, card.name, chapter.title",
    )?;
    let rows = statement.query_map([episode_id], |row| {
        Ok(DatedDestination {
            id: row.get(0)?,
            place_name: row.get(1)?,
            title: row.get(2)?,
            epoch: row.get(3)?,
            canonical_time: row.get(4)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn load_undated_destinations(
    connection: &Connection,
    episode_id: i64,
) -> Result<Vec<UndatedDestination>> {
    let mut statement = connection.prepare(
        "SELECT card.id, card.name, chapter.title, chapter.\"order\"
         FROM destination_cards card
         JOIN narrative_chapters chapter ON chapter.id = card.chapter_id
         WHERE chapter.episode_id = ?1
           AND NOT EXISTS (
               SELECT 1
               FROM narrative_beats beat
               JOIN clips c ON c.id = beat.clip_id
               WHERE beat.chapter_id = card.chapter_id
                 AND c.missing_since IS NULL
                 AND c.captured_at IS NOT NULL
                 AND strftime('%s', c.captured_at) IS NOT NULL
           )
         ORDER BY chapter.\"order\", card.id",
    )?;
    let rows = statement.query_map([episode_id], |row| {
        Ok(UndatedDestination {
            id: row.get(0)?,
            place_name: row.get(1)?,
            title: row.get(2)?,
            chapter_order: row.get(3)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

/// 当前集(`episode::current_episode`)的只读时间线:地点卡(叙事产出,若有)
/// 与素材按标准时间升序合并;没有标准时间的素材/地点卡整体归入未标时间区,
/// 保持导入顺序(素材按 id,地点卡按所属章节 order)。
pub fn timeline(connection: &Connection) -> Result<Vec<JourneyEntry>> {
    let episode = super::episode::current_episode(connection)?;
    let episode_id = episode.id;

    let has_narrative_chapters: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM narrative_chapters WHERE episode_id = ?1 LIMIT 1",
            [episode_id],
            |row| row.get(0),
        )
        .optional()?;

    let mut dated: Vec<JourneyEntry> = Vec::new();
    let mut epochs: Vec<i64> = Vec::new();

    for clip in load_dated_clips(connection, episode_id)? {
        epochs.push(clip.epoch);
        dated.push(JourneyEntry {
            kind: "clip".to_owned(),
            canonical_time: clip.canonical_time,
            undated: false,
            clip_id: Some(clip.id),
            file_name: Some(clip.file_name),
            cover_url: None,
            destination_id: None,
            title: None,
            place_name: None,
        });
    }

    if has_narrative_chapters.is_some() {
        for destination in load_dated_destinations(connection, episode_id)? {
            epochs.push(destination.epoch);
            dated.push(JourneyEntry {
                kind: "destination".to_owned(),
                canonical_time: destination.canonical_time,
                undated: false,
                clip_id: None,
                file_name: None,
                cover_url: None,
                destination_id: Some(destination.id),
                title: Some(destination.title),
                place_name: Some(destination.place_name),
            });
        }
    }

    let mut order: Vec<usize> = (0..dated.len()).collect();
    order.sort_by_key(|&index| epochs[index]);
    let mut entries: Vec<JourneyEntry> = order.into_iter().map(|index| dated[index].clone()).collect();

    for clip in load_undated_clips(connection, episode_id)? {
        entries.push(JourneyEntry {
            kind: "clip".to_owned(),
            canonical_time: String::new(),
            undated: true,
            clip_id: Some(clip.id),
            file_name: Some(clip.file_name),
            cover_url: None,
            destination_id: None,
            title: None,
            place_name: None,
        });
    }

    if has_narrative_chapters.is_some() {
        for destination in load_undated_destinations(connection, episode_id)? {
            let _ = destination.chapter_order;
            entries.push(JourneyEntry {
                kind: "destination".to_owned(),
                canonical_time: String::new(),
                undated: true,
                clip_id: None,
                file_name: None,
                cover_url: None,
                destination_id: Some(destination.id),
                title: Some(destination.title),
                place_name: Some(destination.place_name),
            });
        }
    }

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use rusqlite::params;

    use super::*;
    use crate::core::{db, test_support::TestDirectory};

    fn setup() -> (TestDirectory, Connection) {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection
            .execute("INSERT INTO volumes(uuid) VALUES ('journey')", [])
            .unwrap();
        (directory, connection)
    }

    fn insert_clip(connection: &Connection, id: i64, rel_path: &str, captured_at: Option<&str>) {
        connection
            .execute(
                "INSERT INTO clips(
                    id, volume_uuid, rel_path, duration_ticks, tb_num, tb_den, captured_at
                 ) VALUES (?1, 'journey', ?2, 10000, 1, 1000, ?3)",
                params![id, rel_path, captured_at],
            )
            .unwrap();
    }

    #[test]
    fn orders_clips_by_canonical_time_and_puts_undated_last_in_import_order() {
        let (_directory, connection) = setup();
        // 故意乱序插入:后拍的先插入,早拍的和未标时间的随后插入。
        insert_clip(&connection, 2, "b.mov", Some("2026-09-01T10:05:00Z"));
        insert_clip(&connection, 1, "a.mov", Some("2026-09-01T09:00:00Z"));
        insert_clip(&connection, 3, "c.mov", None);

        let entries = timeline(&connection).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].clip_id, Some(1));
        assert_eq!(entries[0].kind, "clip");
        assert!(!entries[0].undated);
        assert_eq!(entries[0].file_name.as_deref(), Some("a.mov"));
        assert_eq!(entries[1].clip_id, Some(2));
        assert!(!entries[1].undated);
        assert_eq!(entries[2].clip_id, Some(3));
        assert!(entries[2].undated);
        assert_eq!(entries[2].canonical_time, "");
    }

    #[test]
    fn journey_offset_shifts_canonical_time_and_can_reorder_clips() {
        let (_directory, connection) = setup();
        insert_clip(&connection, 1, "a.mov", Some("2026-09-01T10:00:00Z"));
        insert_clip(&connection, 2, "b.mov", Some("2026-09-01T10:01:00Z"));
        // clip 2 的设备时钟快了 2 分钟:校正后它其实排在 clip 1 之前。
        connection
            .execute(
                "UPDATE clips SET journey_offset_ms = -120000 WHERE id = 2",
                [],
            )
            .unwrap();

        let entries = timeline(&connection).unwrap();
        assert_eq!(entries[0].clip_id, Some(2));
        assert_eq!(entries[1].clip_id, Some(1));
    }

    #[test]
    fn destination_card_is_placed_by_its_earliest_dated_clip_ahead_of_a_later_clip() {
        let (_directory, mut connection) = setup();
        insert_clip(&connection, 1, "a.mov", Some("2026-09-01T09:00:00Z"));
        insert_clip(&connection, 2, "b.mov", Some("2026-09-01T11:00:00Z"));

        let episode_id: i64 = connection
            .query_row(
                "SELECT id FROM episodes WHERE status = 'active'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();
        transaction
            .execute(
                "INSERT INTO narrative_chapters(
                    id, episode_id, kind, title, \"order\", promoted, score,
                    rationale, promotion_reason
                 ) VALUES (1, ?1, 'destination', '抵达山谷', 0, 1, 0.9, 'r', 'p')",
                [episode_id],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO narrative_beats(
                    chapter_id, clip_id, role, \"order\", score, rationale
                 ) VALUES (1, 1, 'beat', 0, 0.9, 'r')",
                [],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO destination_cards(
                    chapter_id, name, geo_context, highlights, why_visit,
                    personal_note, sources_json, created_at, updated_at
                 ) VALUES (1, '富良野', 'g', 'h', 'w', 'p', '[]', 'now', 'now')",
                [],
            )
            .unwrap();
        transaction.commit().unwrap();

        let entries = timeline(&connection).unwrap();
        assert_eq!(entries.len(), 3);
        // 地点卡的标准时间取自它自己最早的那条素材(clip 1),两者同一 epoch;
        // 排序稳定,素材先入队,因此并列时素材排在地点卡之前——但两者都必须
        // 排在没有关联到这张地点卡的更晚素材(clip 2)之前。
        assert_eq!(entries[0].clip_id, Some(1));
        assert!(!entries[0].undated);
        assert_eq!(entries[1].kind, "destination");
        assert_eq!(entries[1].place_name.as_deref(), Some("富良野"));
        assert_eq!(entries[1].title.as_deref(), Some("抵达山谷"));
        assert!(!entries[1].undated);
        assert_eq!(entries[2].clip_id, Some(2));
    }
}
