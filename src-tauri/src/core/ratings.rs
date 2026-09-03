use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::error::{CoreError, Result};

pub const BINARY_RATING: &str = "binary";
pub const STAR_RATING: &str = "star";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ClipRating {
    pub clip_id: i64,
    pub segment_id: i64,
    pub rating_type: String,
    pub value: i64,
    pub rated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SelectSegment {
    pub id: i64,
    pub clip_id: i64,
    pub in_ticks: i64,
    pub out_ticks: i64,
    pub tb_num: i64,
    pub tb_den: i64,
}

pub fn list_select_segments(connection: &Connection, clip_id: i64) -> Result<Vec<SelectSegment>> {
    let mut statement = connection.prepare(
        "SELECT s.id, s.clip_id, s.in_ticks, s.out_ticks, c.tb_num, c.tb_den
         FROM segments s
         JOIN clips c ON c.id = s.clip_id
         WHERE s.clip_id = ?1 AND s.kind = 'select' AND s.tombstone = 0
         ORDER BY s.in_ticks, s.out_ticks, s.id",
    )?;
    let rows = statement.query_map([clip_id], |row| {
        Ok(SelectSegment {
            id: row.get(0)?,
            clip_id: row.get(1)?,
            in_ticks: row.get(2)?,
            out_ticks: row.get(3)?,
            tb_num: row.get(4)?,
            tb_den: row.get(5)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(CoreError::from)
}

pub fn create_select_segment(
    connection: &mut Connection,
    clip_id: i64,
    in_seconds: f64,
    out_seconds: f64,
) -> Result<SelectSegment> {
    if !in_seconds.is_finite() || !out_seconds.is_finite() || in_seconds < 0.0 {
        return Err(CoreError::Rating("入出点必须是非负有限秒数".to_owned()));
    }
    if out_seconds <= in_seconds {
        return Err(CoreError::Rating("出点必须晚于入点".to_owned()));
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    super::episode::ensure_clip_writable(&transaction, clip_id)?;
    let timing = transaction
        .query_row(
            "SELECT tb_num, tb_den, duration_ticks FROM clips WHERE id = ?1",
            [clip_id],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| CoreError::Rating(format!("素材 {clip_id} 不存在")))?;
    let (tb_num, tb_den, duration_ticks) = match timing {
        (Some(tb_num), Some(tb_den), Some(duration_ticks))
            if tb_num > 0 && tb_den > 0 && duration_ticks > 0 =>
        {
            (tb_num, tb_den, duration_ticks)
        }
        _ => {
            return Err(CoreError::Rating(format!(
                "素材 {clip_id} 的源 time_base 或时长尚未就绪"
            )))
        }
    };

    let in_ticks = seconds_to_ticks(in_seconds, tb_num, tb_den)?.clamp(0, duration_ticks);
    let out_ticks = seconds_to_ticks(out_seconds, tb_num, tb_den)?.clamp(0, duration_ticks);
    if out_ticks <= in_ticks {
        return Err(CoreError::Rating(
            "入出点换算到源 time_base 后不足一个 tick".to_owned(),
        ));
    }

    transaction.execute(
        "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind, tombstone)
         VALUES (?1, ?2, ?3, 'select', 0)",
        params![clip_id, in_ticks, out_ticks],
    )?;
    let segment_id = transaction.last_insert_rowid();
    transaction.execute(
        "INSERT INTO ratings(segment_id, rating_type, value, rated_at)
         VALUES (?1, 'binary', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        [segment_id],
    )?;
    transaction.commit()?;

    Ok(SelectSegment {
        id: segment_id,
        clip_id,
        in_ticks,
        out_ticks,
        tb_num,
        tb_den,
    })
}

pub fn delete_select_segment(connection: &mut Connection, segment_id: i64) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let owner_clip: Option<i64> = transaction
        .query_row(
            "SELECT clip_id FROM segments WHERE id = ?1",
            [segment_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(clip_id) = owner_clip {
        super::episode::ensure_clip_writable(&transaction, clip_id)?;
    }
    let changed = transaction.execute(
        "UPDATE segments SET tombstone = 1
         WHERE id = ?1 AND kind = 'select' AND tombstone = 0",
        [segment_id],
    )?;
    if changed != 1 {
        return Err(CoreError::Rating(format!(
            "精选段 {segment_id} 不存在、已删除或不是用户精选段"
        )));
    }
    transaction.commit()?;
    Ok(())
}

fn seconds_to_ticks(seconds: f64, tb_num: i64, tb_den: i64) -> Result<i64> {
    if !seconds.is_finite() || seconds < 0.0 || tb_num <= 0 || tb_den <= 0 {
        return Err(CoreError::Rating("无法换算无效时间值".to_owned()));
    }
    let ticks = seconds * tb_den as f64 / tb_num as f64;
    if ticks > i64::MAX as f64 {
        return Err(CoreError::Rating("入出点超出可表示范围".to_owned()));
    }
    Ok(ticks.round() as i64)
}

pub fn rate_clip(
    connection: &mut Connection,
    clip_id: i64,
    rating_type: &str,
    value: i64,
) -> Result<ClipRating> {
    validate_rating(rating_type, value)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    super::episode::ensure_clip_writable(&transaction, clip_id)?;
    let duration_ticks = transaction
        .query_row(
            "SELECT duration_ticks FROM clips WHERE id = ?1",
            [clip_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten()
        .ok_or_else(|| CoreError::Rating(format!("素材 {clip_id} 不存在或时长尚未就绪")))?;

    let segment_id = representative_segment(&transaction, clip_id, duration_ticks)?;
    transaction.execute(
        "INSERT INTO ratings(segment_id, rating_type, value, rated_at)
         VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![segment_id, rating_type, value],
    )?;
    let rating_id = transaction.last_insert_rowid();
    let rated_at = transaction.query_row(
        "SELECT rated_at FROM ratings WHERE id = ?1",
        [rating_id],
        |row| row.get::<_, String>(0),
    )?;
    transaction.commit()?;

    Ok(ClipRating {
        clip_id,
        segment_id,
        rating_type: rating_type.to_owned(),
        value,
        rated_at,
    })
}

pub fn clear_clip_rating(connection: &mut Connection, clip_id: i64) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    super::episode::ensure_clip_writable(&transaction, clip_id)?;
    let duration_ticks = transaction
        .query_row(
            "SELECT duration_ticks FROM clips WHERE id = ?1",
            [clip_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten()
        .ok_or_else(|| CoreError::Rating(format!("素材 {clip_id} 不存在或时长尚未就绪")))?;
    let segment_id = representative_segment(&transaction, clip_id, duration_ticks)?;
    transaction.execute(
        "INSERT INTO ratings(segment_id, rating_type, value, rated_at)
         VALUES (?1, 'binary', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                (?1, 'star', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        [segment_id],
    )?;
    transaction.commit()?;
    Ok(())
}

fn validate_rating(rating_type: &str, value: i64) -> Result<()> {
    let valid = match rating_type {
        BINARY_RATING => matches!(value, -1..=1),
        STAR_RATING => matches!(value, 0..=5),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(CoreError::Rating(format!(
            "无效评级：rating_type={rating_type}, value={value}"
        )))
    }
}

fn representative_segment(
    connection: &Connection,
    clip_id: i64,
    duration_ticks: i64,
) -> Result<i64> {
    let scene = connection
        .query_row(
            "SELECT id FROM segments
             WHERE clip_id = ?1 AND kind = 'scene'
             ORDER BY COALESCE(scene_index, 9223372036854775807), in_ticks, id
             LIMIT 1",
            [clip_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if let Some(segment_id) = scene {
        return Ok(segment_id);
    }

    let whole = connection
        .query_row(
            "SELECT id FROM segments
             WHERE clip_id = ?1 AND kind = 'whole'
             ORDER BY id LIMIT 1",
            [clip_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if let Some(segment_id) = whole {
        return Ok(segment_id);
    }

    connection.execute(
        "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind)
         VALUES (?1, 0, ?2, 'whole')",
        params![clip_id, duration_ticks.max(0)],
    )?;
    Ok(connection.last_insert_rowid())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, import, test_support::TestDirectory};

    fn connection_with_clip() -> (TestDirectory, Connection, i64) {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection
            .execute("INSERT INTO volumes(uuid) VALUES ('rating-volume')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(
                    volume_uuid, rel_path, duration_ticks, tb_num, tb_den, imported_at
                 ) VALUES (
                    'rating-volume', 'clip.mov', 9000, 1, 1000,
                    '2026-08-31T00:00:00Z'
                 )",
                [],
            )
            .unwrap();
        let clip_id = connection.last_insert_rowid();
        (directory, connection, clip_id)
    }

    #[test]
    fn binary_rating_is_inserted_on_first_scene_segment() {
        let (_directory, mut connection, clip_id) = connection_with_clip();
        connection
            .execute(
                "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind, scene_index)
                 VALUES (?1, 3000, 9000, 'scene', 1),
                        (?1, 0, 3000, 'scene', 0)",
                [clip_id],
            )
            .unwrap();

        let rating = rate_clip(&mut connection, clip_id, BINARY_RATING, 1).unwrap();
        let scene_index: i64 = connection
            .query_row(
                "SELECT scene_index FROM segments WHERE id = ?1",
                [rating.segment_id],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(scene_index, 0);
    }

    #[test]
    fn missing_segments_create_a_whole_clip_segment() {
        let (_directory, mut connection, clip_id) = connection_with_clip();

        let rating = rate_clip(&mut connection, clip_id, STAR_RATING, 4).unwrap();
        let segment: (String, i64, i64) = connection
            .query_row(
                "SELECT kind, in_ticks, out_ticks FROM segments WHERE id = ?1",
                [rating.segment_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        assert_eq!(segment, ("whole".to_owned(), 0, 9000));
    }

    #[test]
    fn repeated_ratings_reuse_the_whole_segment() {
        let (_directory, mut connection, clip_id) = connection_with_clip();

        let first = rate_clip(&mut connection, clip_id, BINARY_RATING, 1).unwrap();
        let second = rate_clip(&mut connection, clip_id, STAR_RATING, 5).unwrap();

        assert_eq!(first.segment_id, second.segment_id);
    }

    #[test]
    fn repeated_rating_appends_instead_of_overwriting() {
        let (_directory, mut connection, clip_id) = connection_with_clip();
        rate_clip(&mut connection, clip_id, BINARY_RATING, 1).unwrap();
        rate_clip(&mut connection, clip_id, BINARY_RATING, -1).unwrap();

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM ratings", [], |row| row.get(0))
            .unwrap();

        assert_eq!(count, 2);
    }

    #[test]
    fn list_clips_returns_latest_binary_and_star_independently() {
        let (_directory, mut connection, clip_id) = connection_with_clip();
        rate_clip(&mut connection, clip_id, BINARY_RATING, 1).unwrap();
        rate_clip(&mut connection, clip_id, STAR_RATING, 3).unwrap();
        rate_clip(&mut connection, clip_id, BINARY_RATING, -1).unwrap();
        rate_clip(&mut connection, clip_id, STAR_RATING, 5).unwrap();

        let clips = import::list_clips(&connection).unwrap();

        assert_eq!(
            (clips[0].binary_rating, clips[0].star_rating),
            (Some(-1), Some(5))
        );
    }

    #[test]
    fn zero_is_an_append_only_clear_marker() {
        let (_directory, mut connection, clip_id) = connection_with_clip();
        rate_clip(&mut connection, clip_id, STAR_RATING, 4).unwrap();
        rate_clip(&mut connection, clip_id, STAR_RATING, 0).unwrap();

        let clips = import::list_clips(&connection).unwrap();

        assert_eq!(clips[0].star_rating, Some(0));
    }

    #[test]
    fn clearing_a_clip_appends_both_rating_markers_in_one_transaction() {
        let (_directory, mut connection, clip_id) = connection_with_clip();
        rate_clip(&mut connection, clip_id, BINARY_RATING, 1).unwrap();
        rate_clip(&mut connection, clip_id, STAR_RATING, 5).unwrap();

        clear_clip_rating(&mut connection, clip_id).unwrap();
        let clips = import::list_clips(&connection).unwrap();
        let clear_count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM ratings WHERE value = 0",
            [],
            |row| row.get(0),
        ).unwrap();

        assert_eq!((clips[0].binary_rating, clips[0].star_rating), (Some(0), Some(0)));
        assert_eq!(clear_count, 2);
    }

    #[test]
    fn invalid_type_and_value_do_not_write_ratings() {
        let (_directory, mut connection, clip_id) = connection_with_clip();

        assert!(rate_clip(&mut connection, clip_id, "stars", 4).is_err());
        assert!(rate_clip(&mut connection, clip_id, BINARY_RATING, 2).is_err());
        assert!(rate_clip(&mut connection, clip_id, STAR_RATING, 6).is_err());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM ratings", [], |row| row.get(0))
            .unwrap();

        assert_eq!(count, 0);
    }

    #[test]
    fn missing_clip_does_not_create_an_orphan_segment() {
        let (_directory, mut connection, _clip_id) = connection_with_clip();

        assert!(rate_clip(&mut connection, 999, BINARY_RATING, 1).is_err());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM segments", [], |row| row.get(0))
            .unwrap();

        assert_eq!(count, 0);
    }

    #[test]
    fn select_segment_uses_source_time_base_and_rates_the_segment() {
        let (_directory, mut connection, clip_id) = connection_with_clip();

        let segment = create_select_segment(&mut connection, clip_id, 1.2344, 5.6786).unwrap();
        let rating: (String, i64) = connection
            .query_row(
                "SELECT rating_type, value FROM ratings WHERE segment_id = ?1",
                [segment.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!((segment.in_ticks, segment.out_ticks), (1234, 5679));
        assert_eq!(rating, ("binary".to_owned(), 1));
    }

    #[test]
    fn one_clip_can_have_multiple_ordered_select_segments() {
        let (_directory, mut connection, clip_id) = connection_with_clip();
        create_select_segment(&mut connection, clip_id, 4.0, 6.0).unwrap();
        create_select_segment(&mut connection, clip_id, 1.0, 2.0).unwrap();

        let segments = list_select_segments(&connection, clip_id).unwrap();
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].in_ticks, 1000);
        assert_eq!(segments[1].in_ticks, 4000);
    }

    #[test]
    fn deleting_select_segment_is_soft_and_hides_it_from_listing() {
        let (_directory, mut connection, clip_id) = connection_with_clip();
        let segment = create_select_segment(&mut connection, clip_id, 1.0, 2.0).unwrap();

        delete_select_segment(&mut connection, segment.id).unwrap();
        let tombstone: i64 = connection
            .query_row("SELECT tombstone FROM segments WHERE id = ?1", [segment.id], |row| {
                row.get(0)
            })
            .unwrap();

        assert_eq!(tombstone, 1);
        assert!(list_select_segments(&connection, clip_id).unwrap().is_empty());
    }

    #[test]
    fn invalid_or_sub_tick_ranges_do_not_write() {
        let (_directory, mut connection, clip_id) = connection_with_clip();
        assert!(create_select_segment(&mut connection, clip_id, 2.0, 1.0).is_err());
        assert!(create_select_segment(&mut connection, clip_id, 1.0001, 1.0002).is_err());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM segments", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn delete_refuses_whole_segment() {
        let (_directory, mut connection, clip_id) = connection_with_clip();
        let rating = rate_clip(&mut connection, clip_id, BINARY_RATING, 1).unwrap();
        assert!(delete_select_segment(&mut connection, rating.segment_id).is_err());
    }
}
