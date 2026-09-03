use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::error::{CoreError, Result};
use super::channel_memory::ClipMemoryAnnotation;
use super::narrative::{self, NarrativeOverview};
use super::settings::{self, LLM_ENABLED_KEY};

const CHAPTER_GAP_MS: i64 = 45 * 60 * 1_000;
const CHAPTER_DISTANCE_KM: f64 = 2.0;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Chapter {
    pub id: i64,
    pub title: String,
    pub start_at: String,
    pub end_at: String,
    pub clip_count: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StoryItem {
    pub key: String,
    pub item_kind: String,
    pub clip_id: i64,
    pub segment_id: Option<i64>,
    pub chapter_id: Option<i64>,
    pub file_name: String,
    pub in_ticks: i64,
    pub out_ticks: i64,
    pub tb_num: i64,
    pub tb_den: i64,
    pub position: Option<i64>,
    pub long_term_memory: ClipMemoryAnnotation,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Storyboard {
    pub chapters: Vec<Chapter>,
    pub items: Vec<StoryItem>,
    pub candidates: Vec<StoryItem>,
    pub can_undo: bool,
    pub mode: String,
    pub mode_notice: String,
    pub narrative: Option<NarrativeOverview>,
    pub narration_job_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct StoryOrderRef {
    pub item_kind: String,
    pub clip_id: i64,
    pub segment_id: Option<i64>,
}

#[derive(Debug, Clone)]
struct ClipMoment {
    id: i64,
    canonical_at: String,
    epoch: i64,
    hhmm: String,
    gps_lat: Option<f64>,
    gps_lon: Option<f64>,
    manual_chapter_id: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StorySnapshot {
    chapters: Vec<ChapterSnapshot>,
    clip_chapters: Vec<ClipChapterSnapshot>,
    order: Vec<StoryOrderSnapshot>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChapterSnapshot {
    id: i64,
    title: String,
    start_at: String,
    end_at: String,
    manual: i64,
    tombstone: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct ClipChapterSnapshot {
    clip_id: i64,
    chapter_id: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoryOrderSnapshot {
    item_kind: String,
    clip_id: i64,
    segment_id: Option<i64>,
    position: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChapterizePayload {
    episode_id: i64,
}

pub fn enqueue_if_import_complete(connection: &mut Connection) -> Result<Option<i64>> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let episode_id = active_episode_id(&transaction)?;
    let active_imports: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM jobs
         WHERE kind = 'import_probe' AND status IN ('pending', 'running')",
        [],
        |row| row.get(0),
    )?;
    if active_imports > 0 {
        transaction.commit()?;
        return Ok(None);
    }

    let (clip_count, latest_import): (i64, String) = transaction.query_row(
        "SELECT COUNT(*), COALESCE(MAX(imported_at), '')
         FROM clips
         WHERE missing_since IS NULL AND (episode_id = ?1 OR episode_id IS NULL)",
        [episode_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if clip_count == 0 {
        transaction.commit()?;
        return Ok(None);
    }

    let payload_hash = format!("chapterize:{episode_id}:{clip_count}:{latest_import}");
    let payload = serde_json::to_string(&ChapterizePayload { episode_id })
        .map_err(|error| CoreError::Story(format!("章节任务序列化失败：{error}")))?;
    let existing = transaction
        .query_row(
            "SELECT id FROM jobs
             WHERE kind = 'chapterize' AND payload_hash = ?1 LIMIT 1",
            [&payload_hash],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if existing.is_some() {
        transaction.commit()?;
        return Ok(None);
    }

    transaction.execute(
        "INSERT INTO jobs(
            kind, payload, payload_hash, status, attempt,
            next_attempt_at, created_at, updated_at
         ) VALUES (
            'chapterize', ?2, ?1, 'pending', 0,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         )",
        params![payload_hash, payload],
    )?;
    let job_id = transaction.last_insert_rowid();
    transaction.commit()?;
    Ok(Some(job_id))
}

pub fn chapterize(connection: &mut Connection) -> Result<()> {
    let episode_id = active_episode_id(connection)?;
    chapterize_episode(connection, episode_id, false)
}

pub fn run_chapterize_job(connection: &mut Connection, payload: &str) -> Result<()> {
    let payload: ChapterizePayload = serde_json::from_str(payload)
        .map_err(|error| CoreError::Story(format!("章节任务载荷无效：{error}")))?;
    chapterize_episode(connection, payload.episode_id, true)
}

fn chapterize_episode(
    connection: &mut Connection,
    episode_id: i64,
    stale_job_is_superseded: bool,
) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if active_episode_id(&transaction)? != episode_id {
        if stale_job_is_superseded {
            transaction.commit()?;
            return Ok(());
        }
        return Err(CoreError::Story(
            "章节处理期间当前 Episode 已变化；已拒绝改写".to_owned(),
        ));
    }
    let moments = load_clip_moments(&transaction, episode_id)?;
    let clusters = cluster_moments(&moments);

    transaction.execute(
        "UPDATE clips SET chapter_id = NULL
         WHERE (episode_id = ?1 OR episode_id IS NULL)
           AND chapter_id IN (
               SELECT id FROM chapters WHERE manual = 0 AND episode_id = ?1
           )",
        [episode_id],
    )?;
    transaction.execute(
        "UPDATE chapters SET tombstone = 1 WHERE manual = 0 AND episode_id = ?1",
        [episode_id],
    )?;

    let mut manual_assignments: BTreeMap<i64, Vec<&ClipMoment>> = BTreeMap::new();
    let mut automatic_clusters: Vec<(usize, Vec<&ClipMoment>)> = Vec::new();
    for (cluster_index, cluster) in clusters.iter().enumerate() {
        let anchors = cluster
            .iter()
            .filter_map(|clip| clip.manual_chapter_id.map(|id| (id, clip.epoch)))
            .collect::<Vec<_>>();
        if anchors.is_empty() {
            automatic_clusters.push((cluster_index, cluster.iter().collect()));
            continue;
        }
        for clip in cluster {
            let chapter_id = anchors
                .iter()
                .min_by_key(|(chapter_id, epoch)| {
                    (clip.epoch.abs_diff(*epoch), *chapter_id as u64)
                })
                .map(|(chapter_id, _)| *chapter_id)
                .ok_or_else(|| CoreError::Story("手工章节锚点意外为空".to_owned()))?;
            manual_assignments.entry(chapter_id).or_default().push(clip);
        }
    }

    for (chapter_id, clips) in manual_assignments {
        let first = clips
            .first()
            .ok_or_else(|| CoreError::Story("手工章节没有可分配素材".to_owned()))?;
        let last = clips
            .last()
            .ok_or_else(|| CoreError::Story("手工章节没有可分配素材".to_owned()))?;
        transaction.execute(
            "UPDATE chapters
             SET start_at = ?2, end_at = ?3, manual = 1, tombstone = 0
             WHERE id = ?1 AND episode_id = ?4",
            params![
                chapter_id,
                first.canonical_at.as_str(),
                last.canonical_at.as_str(),
                episode_id,
            ],
        )?;
        for clip in clips {
            transaction.execute(
                "UPDATE clips SET chapter_id = ?2 WHERE id = ?1",
                params![clip.id, chapter_id],
            )?;
        }
    }

    for (cluster_index, clips) in automatic_clusters {
        let first = clips
            .first()
            .ok_or_else(|| CoreError::Story("自动章节没有可分配素材".to_owned()))?;
        let last = clips
            .last()
            .ok_or_else(|| CoreError::Story("自动章节没有可分配素材".to_owned()))?;
        let title = format!(
            "第{}段·{}-{}",
            cluster_index + 1,
            first.hhmm,
            last.hhmm
        );
        let existing_chapter_id = transaction
            .query_row(
                "SELECT id FROM chapters
                 WHERE manual = 0 AND start_at = ?1 AND end_at = ?2
                   AND episode_id = ?3
                 ORDER BY id LIMIT 1",
                params![first.canonical_at.as_str(), last.canonical_at.as_str(), episode_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        let chapter_id = match existing_chapter_id {
            Some(chapter_id) => chapter_id,
            None => {
                transaction.execute(
                    "INSERT INTO chapters(
                         title, start_at, end_at, manual, tombstone, episode_id
                     ) VALUES (?1, ?2, ?3, 0, 0, ?4)",
                    params![
                        title.as_str(),
                        first.canonical_at.as_str(),
                        last.canonical_at.as_str(),
                        episode_id,
                    ],
                )?;
                transaction.last_insert_rowid()
            }
        };
        transaction.execute(
            "UPDATE chapters
             SET title = ?2, start_at = ?3, end_at = ?4, tombstone = 0
             WHERE id = ?1 AND episode_id = ?5",
            params![
                chapter_id,
                title.as_str(),
                first.canonical_at.as_str(),
                last.canonical_at.as_str(),
                episode_id,
            ],
        )?;
        for clip in clips {
            transaction.execute(
                "UPDATE clips SET chapter_id = ?2 WHERE id = ?1",
                params![clip.id, chapter_id],
            )?;
        }
    }

    transaction.commit()?;
    Ok(())
}

fn load_clip_moments(connection: &Connection, episode_id: i64) -> Result<Vec<ClipMoment>> {
    let mut statement = connection.prepare(
        "SELECT c.id,
                strftime(
                    '%Y-%m-%dT%H:%M:%fZ', c.captured_at,
                    printf('%+f seconds', c.journey_offset_ms / 1000.0)
                ),
                CAST(strftime('%s', c.captured_at) AS INTEGER) * 1000
                    + c.journey_offset_ms,
                strftime(
                    '%H:%M', c.captured_at,
                    printf('%+f seconds', c.journey_offset_ms / 1000.0)
                ),
                c.gps_lat, c.gps_lon,
                CASE WHEN chapter.manual = 1 AND chapter.tombstone = 0
                     THEN chapter.id END
         FROM clips c
         LEFT JOIN chapters chapter ON chapter.id = c.chapter_id
         WHERE c.missing_since IS NULL
           AND (c.episode_id = ?1 OR c.episode_id IS NULL)
           AND c.captured_at IS NOT NULL
           AND strftime('%s', c.captured_at) IS NOT NULL
         ORDER BY CAST(strftime('%s', c.captured_at) AS INTEGER) * 1000
                      + c.journey_offset_ms, c.id",
    )?;
    let rows = statement.query_map([episode_id], |row| {
        Ok(ClipMoment {
            id: row.get(0)?,
            canonical_at: row.get(1)?,
            epoch: row.get(2)?,
            hhmm: row.get(3)?,
            gps_lat: row.get(4)?,
            gps_lon: row.get(5)?,
            manual_chapter_id: row.get(6)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(CoreError::from)
}

fn cluster_moments(moments: &[ClipMoment]) -> Vec<Vec<ClipMoment>> {
    let mut clusters: Vec<Vec<ClipMoment>> = Vec::new();
    for moment in moments {
        let split = clusters
            .last()
            .and_then(|cluster| cluster.last())
            .is_some_and(|previous| {
                moment.epoch - previous.epoch > CHAPTER_GAP_MS
                    || distance_km(previous, moment).is_some_and(|distance| {
                        distance > CHAPTER_DISTANCE_KM
                    })
            });
        if split || clusters.is_empty() {
            clusters.push(Vec::new());
        }
        if let Some(cluster) = clusters.last_mut() {
            cluster.push(moment.clone());
        }
    }
    clusters
}

fn distance_km(left: &ClipMoment, right: &ClipMoment) -> Option<f64> {
    let (left_lat, left_lon, right_lat, right_lon) = (
        left.gps_lat?,
        left.gps_lon?,
        right.gps_lat?,
        right.gps_lon?,
    );
    if !left_lat.is_finite()
        || !left_lon.is_finite()
        || !right_lat.is_finite()
        || !right_lon.is_finite()
        || !(-90.0..=90.0).contains(&left_lat)
        || !(-90.0..=90.0).contains(&right_lat)
        || !(-180.0..=180.0).contains(&left_lon)
        || !(-180.0..=180.0).contains(&right_lon)
    {
        return None;
    }
    let earth_radius_km = 6_371.0;
    let latitude_delta = (right_lat - left_lat).to_radians();
    let longitude_delta = (right_lon - left_lon).to_radians();
    let left_latitude = left_lat.to_radians();
    let right_latitude = right_lat.to_radians();
    let haversine = (latitude_delta / 2.0).sin().powi(2)
        + left_latitude.cos()
            * right_latitude.cos()
            * (longitude_delta / 2.0).sin().powi(2);
    Some(earth_radius_km * 2.0 * haversine.sqrt().asin())
}

pub fn get_storyboard(connection: &Connection) -> Result<Storyboard> {
    let episode_id = active_episode_id(connection)?;
    let mut chapter_statement = connection.prepare(
        "SELECT chapter.id, chapter.title, chapter.start_at, chapter.end_at,
                (SELECT COUNT(*) FROM clips WHERE chapter_id = chapter.id
                 AND (episode_id = ?1 OR episode_id IS NULL)
                 AND missing_since IS NULL)
         FROM chapters chapter
         WHERE chapter.tombstone = 0 AND chapter.episode_id = ?1
         ORDER BY chapter.start_at, chapter.id",
    )?;
    let chapter_rows = chapter_statement.query_map([episode_id], |row| {
        Ok(Chapter {
            id: row.get(0)?,
            title: row.get(1)?,
            start_at: row.get(2)?,
            end_at: row.get(3)?,
            clip_count: row.get(4)?,
        })
    })?;
    let chapters = chapter_rows
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(CoreError::from)?;

    let mut item_statement = connection.prepare(
        "WITH live_selects AS (
             SELECT id, clip_id, in_ticks, out_ticks
             FROM segments
             WHERE kind = 'select' AND tombstone = 0
         ), selected_items AS (
             SELECT c.id AS clip_id, selected.id AS segment_id,
                    'segment' AS item_kind, selected.in_ticks, selected.out_ticks,
                    c.tb_num, c.tb_den, c.rel_path,
                    CASE WHEN c.captured_at IS NULL THEN NULL ELSE
                      CAST(strftime('%s', c.captured_at) AS INTEGER) * 1000
                        + c.journey_offset_ms END AS canonical_epoch,
                    c.chapter_id
             FROM clips c
             JOIN live_selects selected ON selected.clip_id = c.id
             WHERE c.missing_since IS NULL
               AND (c.episode_id = ?1 OR c.episode_id IS NULL)
             UNION ALL
             SELECT c.id, NULL, 'whole', 0, COALESCE(c.duration_ticks, 0),
                    c.tb_num, c.tb_den, c.rel_path,
                    CASE WHEN c.captured_at IS NULL THEN NULL ELSE
                      CAST(strftime('%s', c.captured_at) AS INTEGER) * 1000
                        + c.journey_offset_ms END,
                    c.chapter_id
             FROM clips c
             WHERE c.missing_since IS NULL
               AND (c.episode_id = ?1 OR c.episode_id IS NULL)
               AND NOT EXISTS (
                   SELECT 1 FROM live_selects selected WHERE selected.clip_id = c.id
               )
               AND 1 = (
                   SELECT binary.value
                   FROM ratings binary
                   JOIN segments rated_segment ON rated_segment.id = binary.segment_id
                   WHERE rated_segment.clip_id = c.id
                     AND COALESCE(rated_segment.kind, 'whole') != 'select'
                     AND rated_segment.tombstone = 0
                     AND binary.rating_type = 'binary'
                   ORDER BY binary.rated_at DESC, binary.id DESC LIMIT 1
               )
         )
         SELECT selected.item_kind, selected.clip_id, selected.segment_id,
                selected.chapter_id, selected.rel_path,
                selected.in_ticks, selected.out_ticks,
                COALESCE(selected.tb_num, 0), COALESCE(selected.tb_den, 0),
                story.position
         FROM selected_items selected
         LEFT JOIN story_order story
           ON story.tombstone = 0
          AND story.episode_id = ?1
          AND story.item_kind = selected.item_kind
          AND story.clip_id = selected.clip_id
          AND (story.item_kind = 'whole' OR story.segment_id = selected.segment_id)
         ORDER BY story.position IS NULL, story.position,
                  selected.canonical_epoch IS NULL, selected.canonical_epoch,
                  selected.clip_id, selected.in_ticks, selected.segment_id",
    )?;
    let item_rows = item_statement.query_map([episode_id], |row| {
        let item_kind: String = row.get(0)?;
        let clip_id: i64 = row.get(1)?;
        let segment_id: Option<i64> = row.get(2)?;
        let path: String = row.get(4)?;
        let in_ticks = row.get(5)?;
        let out_ticks = row.get(6)?;
        Ok(StoryItem {
            key: story_key(&item_kind, clip_id, segment_id),
            item_kind,
            clip_id,
            segment_id,
            chapter_id: row.get(3)?,
            file_name: Path::new(&path)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or(path),
            in_ticks,
            out_ticks,
            tb_num: row.get(7)?,
            tb_den: row.get(8)?,
            position: row.get(9)?,
            long_term_memory: ClipMemoryAnnotation::default(),
        })
    })?;
    let mut items = Vec::new();
    let mut candidates = Vec::new();
    let memory_reader = super::channel_memory::ChannelMemoryReader::for_project(connection)?;
    for item in item_rows {
        let mut item = item?;
        item.long_term_memory = memory_reader.clip_annotation(
            connection,
            item.clip_id,
            item.segment_id,
            item.in_ticks,
            item.out_ticks,
        )?;
        if item.position.is_some() {
            items.push(item);
        } else {
            candidates.push(item);
        }
    }
    let can_undo = connection.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM story_history
             WHERE episode_id = ?1 AND undone_at IS NULL
         )",
        [episode_id],
        |row| row.get::<_, i64>(0),
    )? == 1;

    let l3_enabled = settings::string_value(connection, LLM_ENABLED_KEY, "false")? == "true";
    let narrative = if l3_enabled {
        narrative::load_overview(connection)?
    } else {
        None
    };
    let (mode, mode_notice) = if !l3_enabled {
        (
            "legacy".to_owned(),
            "L3 增强已关闭：故事板明确回退到 D2 本地章节；时间/GPS 仅按原行为显示。".to_owned(),
        )
    } else if narrative.is_some() {
        (
            "narrative".to_owned(),
            "L3 叙事 v2 已启用；粗剪与镜头表按 Beat 顺序读取。".to_owned(),
        )
    } else {
        (
            "legacy".to_owned(),
            "L3 已开启但尚无有效编排：当前仍显示 D2 本地章节，候选边界不会自动定章。".to_owned(),
        )
    };
    let narration_job_status = narrative::latest_job_status(connection)?;

    Ok(Storyboard {
        chapters,
        items,
        candidates,
        can_undo,
        mode,
        mode_notice,
        narrative,
        narration_job_status,
    })
}

pub fn set_story_order(connection: &mut Connection, order: &[StoryOrderRef]) -> Result<()> {
    let mut seen = HashSet::new();
    for item in order {
        validate_order_ref(item)?;
        if !seen.insert(story_key(&item.item_kind, item.clip_id, item.segment_id)) {
            return Err(CoreError::Story("故事板顺序包含重复精选".to_owned()));
        }
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let episode_id = active_episode_id(&transaction)?;
    for item in order {
        ensure_selected(&transaction, item, episode_id)?;
    }
    record_snapshot(&transaction, episode_id, "reorder")?;
    transaction.execute(
        "UPDATE story_order SET tombstone = 1
         WHERE episode_id = ?1 AND tombstone = 0",
        [episode_id],
    )?;
    for (position, item) in order.iter().enumerate() {
        upsert_story_order(&transaction, item, episode_id, position as i64)?;
    }
    transaction.commit()?;
    Ok(())
}

pub fn rename_chapter(connection: &mut Connection, chapter_id: i64, title: &str) -> Result<()> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 80 {
        return Err(CoreError::Story("章节名须为 1–80 个字符".to_owned()));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let episode_id = active_episode_id(&transaction)?;
    let exists = transaction.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM chapters
             WHERE id = ?1 AND episode_id = ?2 AND tombstone = 0
         )",
        params![chapter_id, episode_id],
        |row| row.get::<_, i64>(0),
    )? == 1;
    if !exists {
        return Err(CoreError::Story(format!("章节 {chapter_id} 不存在")));
    }
    record_snapshot(&transaction, episode_id, "rename")?;
    transaction.execute(
        "UPDATE chapters SET title = ?2, manual = 1
         WHERE id = ?1 AND episode_id = ?3",
        params![chapter_id, title, episode_id],
    )?;
    transaction.commit()?;
    Ok(())
}

pub fn merge_chapters(
    connection: &mut Connection,
    source_chapter_id: i64,
    target_chapter_id: i64,
) -> Result<()> {
    if source_chapter_id == target_chapter_id {
        return Err(CoreError::Story("不能合并同一个章节".to_owned()));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let episode_id = active_episode_id(&transaction)?;
    let source = active_chapter_bounds(&transaction, source_chapter_id, episode_id)?;
    let target = active_chapter_bounds(&transaction, target_chapter_id, episode_id)?;
    record_snapshot(&transaction, episode_id, "merge")?;
    transaction.execute(
        "UPDATE clips SET chapter_id = ?2
         WHERE chapter_id = ?1 AND (episode_id = ?3 OR episode_id IS NULL)",
        params![source_chapter_id, target_chapter_id, episode_id],
    )?;
    let start_at = source.0.min(target.0);
    let end_at = source.1.max(target.1);
    transaction.execute(
        "UPDATE chapters
         SET start_at = ?2, end_at = ?3, manual = 1, tombstone = 0
         WHERE id = ?1 AND episode_id = ?4",
        params![target_chapter_id, start_at, end_at, episode_id],
    )?;
    transaction.execute(
        "UPDATE chapters SET manual = 1, tombstone = 1
         WHERE id = ?1 AND episode_id = ?2",
        params![source_chapter_id, episode_id],
    )?;
    transaction.commit()?;
    Ok(())
}

pub fn undo_latest(connection: &mut Connection) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let episode_id = active_episode_id(&transaction)?;
    let latest = transaction
        .query_row(
            "SELECT id, snapshot FROM story_history
             WHERE episode_id = ?1 AND undone_at IS NULL
             ORDER BY id DESC LIMIT 1",
            [episode_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| CoreError::Story("当前没有可撤销的故事板操作".to_owned()))?;
    let snapshot: StorySnapshot = serde_json::from_str(&latest.1)
        .map_err(|error| CoreError::Story(format!("撤销快照无效：{error}")))?;
    restore_snapshot(&transaction, episode_id, &snapshot)?;
    transaction.execute(
        "UPDATE story_history
         SET undone_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND undone_at IS NULL",
        [latest.0],
    )?;
    transaction.commit()?;
    Ok(())
}

fn validate_order_ref(item: &StoryOrderRef) -> Result<()> {
    let valid = match item.item_kind.as_str() {
        "whole" => item.segment_id.is_none(),
        "segment" => item.segment_id.is_some(),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(CoreError::Story("故事板精选标识无效".to_owned()))
    }
}

fn ensure_selected(
    connection: &Connection,
    item: &StoryOrderRef,
    episode_id: i64,
) -> Result<()> {
    let selected = if item.item_kind == "segment" {
        connection.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM segments
                JOIN clips c ON c.id = segments.clip_id
                WHERE segments.id = ?1 AND segments.clip_id = ?2
                  AND kind = 'select' AND tombstone = 0
                  AND (c.episode_id = ?3 OR c.episode_id IS NULL)
             )",
            params![item.segment_id, item.clip_id, episode_id],
            |row| row.get::<_, i64>(0),
        )? == 1
    } else {
        connection.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM clips c
                WHERE c.id = ?1 AND c.missing_since IS NULL
                  AND (c.episode_id = ?2 OR c.episode_id IS NULL)
                  AND NOT EXISTS (
                      SELECT 1 FROM segments selected
                      WHERE selected.clip_id = c.id
                        AND selected.kind = 'select' AND selected.tombstone = 0
                  )
                  AND 1 = (
                      SELECT binary.value
                      FROM ratings binary
                      JOIN segments rated_segment ON rated_segment.id = binary.segment_id
                      WHERE rated_segment.clip_id = c.id
                        AND COALESCE(rated_segment.kind, 'whole') != 'select'
                        AND rated_segment.tombstone = 0
                        AND binary.rating_type = 'binary'
                      ORDER BY binary.rated_at DESC, binary.id DESC LIMIT 1
                  )
             )",
            params![item.clip_id, episode_id],
            |row| row.get::<_, i64>(0),
        )? == 1
    };
    if selected {
        Ok(())
    } else {
        Err(CoreError::Story(format!(
            "精选 {} 已失效，请刷新候选区",
            story_key(&item.item_kind, item.clip_id, item.segment_id)
        )))
    }
}

fn upsert_story_order(
    connection: &Connection,
    item: &StoryOrderRef,
    episode_id: i64,
    position: i64,
) -> Result<()> {
    let existing = if item.item_kind == "whole" {
        connection
            .query_row(
                "SELECT id FROM story_order
                 WHERE item_kind = 'whole' AND clip_id = ?1 AND episode_id = ?2",
                params![item.clip_id, episode_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
    } else {
        connection
            .query_row(
                "SELECT id FROM story_order
                 WHERE item_kind = 'segment' AND segment_id = ?1 AND episode_id = ?2",
                params![item.segment_id, episode_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
    };
    if let Some(id) = existing {
        connection.execute(
            "UPDATE story_order
             SET clip_id = ?2, segment_id = ?3, position = ?4, tombstone = 0,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1 AND episode_id = ?5",
            params![id, item.clip_id, item.segment_id, position, episode_id],
        )?;
    } else {
        connection.execute(
            "INSERT INTO story_order(
                item_kind, clip_id, segment_id, position, tombstone, created_at, updated_at,
                episode_id
             ) VALUES (
                ?1, ?2, ?3, ?4, 0,
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?5
             )",
            params![item.item_kind, item.clip_id, item.segment_id, position, episode_id],
        )?;
    }
    Ok(())
}

fn active_chapter_bounds(
    connection: &Connection,
    chapter_id: i64,
    episode_id: i64,
) -> Result<(String, String)> {
    connection
        .query_row(
            "SELECT start_at, end_at FROM chapters
             WHERE id = ?1 AND episode_id = ?2 AND tombstone = 0",
            params![chapter_id, episode_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| CoreError::Story(format!("章节 {chapter_id} 不存在")))
}

fn story_key(item_kind: &str, clip_id: i64, segment_id: Option<i64>) -> String {
    if item_kind == "segment" {
        format!("segment:{}", segment_id.unwrap_or_default())
    } else {
        format!("whole:{clip_id}")
    }
}

fn record_snapshot(
    transaction: &Transaction<'_>,
    episode_id: i64,
    action: &str,
) -> Result<()> {
    let snapshot = capture_snapshot(transaction, episode_id)?;
    let json = serde_json::to_string(&snapshot)
        .map_err(|error| CoreError::Story(format!("无法保存撤销快照：{error}")))?;
    transaction.execute(
        "INSERT INTO story_history(action, snapshot, created_at, episode_id)
         VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?3)",
        params![action, json, episode_id],
    )?;
    Ok(())
}

fn capture_snapshot(connection: &Connection, episode_id: i64) -> Result<StorySnapshot> {
    let mut chapter_statement = connection.prepare(
        "SELECT id, title, start_at, end_at, manual, tombstone
         FROM chapters WHERE episode_id = ?1 ORDER BY id",
    )?;
    let chapters = chapter_statement
        .query_map([episode_id], |row| {
            Ok(ChapterSnapshot {
                id: row.get(0)?,
                title: row.get(1)?,
                start_at: row.get(2)?,
                end_at: row.get(3)?,
                manual: row.get(4)?,
                tombstone: row.get(5)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut clip_statement = connection.prepare(
        "SELECT id, chapter_id FROM clips
         WHERE episode_id = ?1 OR episode_id IS NULL ORDER BY id",
    )?;
    let clip_chapters = clip_statement
        .query_map([episode_id], |row| {
            Ok(ClipChapterSnapshot {
                clip_id: row.get(0)?,
                chapter_id: row.get(1)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut order_statement = connection.prepare(
        "SELECT item_kind, clip_id, segment_id, position
         FROM story_order
         WHERE episode_id = ?1 AND tombstone = 0 ORDER BY position, id",
    )?;
    let order = order_statement
        .query_map([episode_id], |row| {
            Ok(StoryOrderSnapshot {
                item_kind: row.get(0)?,
                clip_id: row.get(1)?,
                segment_id: row.get(2)?,
                position: row.get(3)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(StorySnapshot {
        chapters,
        clip_chapters,
        order,
    })
}

fn restore_snapshot(
    connection: &Connection,
    episode_id: i64,
    snapshot: &StorySnapshot,
) -> Result<()> {
    connection.execute(
        "UPDATE chapters SET tombstone = 1 WHERE episode_id = ?1",
        [episode_id],
    )?;
    for chapter in &snapshot.chapters {
        connection.execute(
            "UPDATE chapters
             SET title = ?2, start_at = ?3, end_at = ?4,
                 manual = ?5, tombstone = ?6
             WHERE id = ?1 AND episode_id = ?7",
            params![
                chapter.id,
                chapter.title,
                chapter.start_at,
                chapter.end_at,
                chapter.manual,
                chapter.tombstone,
                episode_id,
            ],
        )?;
    }
    connection.execute(
        "UPDATE clips SET chapter_id = NULL
         WHERE episode_id = ?1 OR episode_id IS NULL",
        [episode_id],
    )?;
    for assignment in &snapshot.clip_chapters {
        if let Some(chapter_id) = assignment.chapter_id {
            connection.execute(
                "UPDATE clips SET chapter_id = ?2
                 WHERE id = ?1 AND (episode_id = ?3 OR episode_id IS NULL)",
                params![assignment.clip_id, chapter_id, episode_id],
            )?;
        }
    }
    connection.execute(
        "UPDATE story_order SET tombstone = 1
         WHERE episode_id = ?1 AND tombstone = 0",
        [episode_id],
    )?;
    for item in &snapshot.order {
        upsert_story_order(
            connection,
            &StoryOrderRef {
                item_kind: item.item_kind.clone(),
                clip_id: item.clip_id,
                segment_id: item.segment_id,
            },
            episode_id,
            item.position,
        )?;
    }
    Ok(())
}

fn active_episode_id(connection: &Connection) -> Result<i64> {
    connection
        .query_row(
            "SELECT id FROM episodes WHERE status = 'active'",
            [],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| CoreError::Story("没有进行中的 Episode".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, settings::set_setting, test_support::TestDirectory};

    fn setup() -> (TestDirectory, Connection) {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection
            .execute("INSERT INTO volumes(uuid) VALUES ('story-fixture')", [])
            .unwrap();
        (directory, connection)
    }

    fn insert_clip(
        connection: &Connection,
        name: &str,
        captured_at: &str,
        gps: Option<(f64, f64)>,
        selected: bool,
    ) -> i64 {
        connection
            .execute(
                "INSERT INTO clips(
                    volume_uuid, rel_path, tb_num, tb_den, duration_ticks,
                    captured_at, gps_lat, gps_lon, imported_at
                 ) VALUES ('story-fixture', ?1, 1, 1000, 10000, ?2, ?3, ?4, ?2)",
                params![name, captured_at, gps.map(|value| value.0), gps.map(|value| value.1)],
            )
            .unwrap();
        let clip_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind)
                 VALUES (?1, 0, 10000, 'whole')",
                [clip_id],
            )
            .unwrap();
        if selected {
            let segment_id = connection.last_insert_rowid();
            connection
                .execute(
                    "INSERT INTO ratings(segment_id, rating_type, value, rated_at)
                     VALUES (?1, 'binary', 1, ?2)",
                    params![segment_id, captured_at],
                )
                .unwrap();
        }
        clip_id
    }

    #[test]
    fn exactly_forty_five_minutes_stays_in_one_chapter() {
        let (_directory, mut connection) = setup();
        insert_clip(&connection, "a.mov", "2026-08-31T10:00:00Z", None, false);
        insert_clip(&connection, "b.mov", "2026-08-31T10:45:00Z", None, false);
        chapterize(&mut connection).unwrap();

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM chapters WHERE tombstone = 0", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn more_than_forty_five_minutes_starts_a_new_chapter() {
        let (_directory, mut connection) = setup();
        insert_clip(&connection, "a.mov", "2026-08-31T10:00:00Z", None, false);
        insert_clip(&connection, "b.mov", "2026-08-31T10:45:01Z", None, false);
        chapterize(&mut connection).unwrap();

        let titles = connection
            .prepare("SELECT title FROM chapters WHERE tombstone = 0 ORDER BY start_at")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(titles, vec!["第1段·10:00-10:00", "第2段·10:45-10:45"]);
    }

    #[test]
    fn gps_distance_over_two_kilometres_starts_a_new_chapter() {
        let (_directory, mut connection) = setup();
        insert_clip(
            &connection,
            "a.mov",
            "2026-08-31T10:00:00Z",
            Some((43.6532, -79.3832)),
            false,
        );
        insert_clip(
            &connection,
            "b.mov",
            "2026-08-31T10:01:00Z",
            Some((43.6800, -79.3832)),
            false,
        );
        chapterize(&mut connection).unwrap();

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM chapters WHERE tombstone = 0", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn chapterize_is_idempotent_for_the_same_timeline() {
        let (_directory, mut connection) = setup();
        insert_clip(&connection, "a.mov", "2026-08-31T10:00:00Z", None, false);
        chapterize(&mut connection).unwrap();
        let first_id: i64 = connection
            .query_row("SELECT id FROM chapters WHERE tombstone = 0", [], |row| row.get(0))
            .unwrap();
        chapterize(&mut connection).unwrap();
        let second_id: i64 = connection
            .query_row("SELECT id FROM chapters WHERE tombstone = 0", [], |row| row.get(0))
            .unwrap();
        assert_eq!(first_id, second_id);
    }

    #[test]
    fn story_order_persists_and_unlisted_selected_items_are_candidates() {
        let (_directory, mut connection) = setup();
        let first = insert_clip(&connection, "a.mov", "2026-08-31T10:00:00Z", None, true);
        let second = insert_clip(&connection, "b.mov", "2026-08-31T10:01:00Z", None, true);
        set_story_order(
            &mut connection,
            &[StoryOrderRef {
                item_kind: "whole".to_owned(),
                clip_id: second,
                segment_id: None,
            }],
        )
        .unwrap();

        let storyboard = get_storyboard(&connection).unwrap();
        assert_eq!(storyboard.items[0].clip_id, second);
        assert_eq!(storyboard.candidates[0].clip_id, first);
    }

    #[test]
    fn archived_episode_story_state_cannot_leak_into_the_active_episode() {
        let (_directory, mut connection) = setup();
        let first_episode = active_episode_id(&connection).unwrap();
        let archived_clip = insert_clip(
            &connection,
            "archived.mov",
            "2026-08-31T10:00:00Z",
            None,
            true,
        );
        connection
            .execute(
                "UPDATE clips SET episode_id = ?2 WHERE id = ?1",
                params![archived_clip, first_episode],
            )
            .unwrap();
        chapterize(&mut connection).unwrap();
        let archived_chapter: i64 = connection
            .query_row(
                "SELECT id FROM chapters WHERE episode_id = ?1 AND tombstone = 0",
                [first_episode],
                |row| row.get(0),
            )
            .unwrap();
        set_story_order(
            &mut connection,
            &[StoryOrderRef {
                item_kind: "whole".to_owned(),
                clip_id: archived_clip,
                segment_id: None,
            }],
        )
        .unwrap();

        crate::core::episode::archive_current(&mut connection, None).unwrap();
        let active_episode = active_episode_id(&connection).unwrap();
        let active_clip = insert_clip(
            &connection,
            "active.mov",
            "2026-09-01T10:00:00Z",
            None,
            true,
        );
        connection
            .execute(
                "UPDATE clips SET episode_id = ?2 WHERE id = ?1",
                params![active_clip, active_episode],
            )
            .unwrap();
        chapterize(&mut connection).unwrap();
        set_story_order(
            &mut connection,
            &[StoryOrderRef {
                item_kind: "whole".to_owned(),
                clip_id: active_clip,
                segment_id: None,
            }],
        )
        .unwrap();

        let storyboard = get_storyboard(&connection).unwrap();
        assert_eq!(storyboard.items.iter().map(|item| item.clip_id).collect::<Vec<_>>(), vec![active_clip]);
        assert!(storyboard.candidates.is_empty());
        assert_eq!(storyboard.chapters.len(), 1);
        assert!(storyboard.chapters.iter().all(|chapter| chapter.id != archived_chapter));
        assert!(rename_chapter(&mut connection, archived_chapter, "越权改名").is_err());
        assert!(set_story_order(
            &mut connection,
            &[StoryOrderRef {
                item_kind: "whole".to_owned(),
                clip_id: archived_clip,
                segment_id: None,
            }],
        )
        .is_err());

        let live_orders_by_episode: i64 = connection
            .query_row(
                "SELECT COUNT(DISTINCT episode_id) FROM story_order WHERE tombstone = 0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(live_orders_by_episode, 2);
    }

    #[test]
    fn candidate_story_order_uses_capture_time_plus_journey_offset() {
        let (_directory, connection) = setup();
        let first_by_file_clock =
            insert_clip(&connection, "phone.mov", "2026-08-31T10:00:00Z", None, true);
        let first_by_journey_time =
            insert_clip(&connection, "drone.mov", "2026-08-31T10:01:00Z", None, true);
        connection.execute(
            "UPDATE clips SET journey_offset_ms = -120000 WHERE id = ?1",
            [first_by_journey_time],
        ).unwrap();

        let storyboard = get_storyboard(&connection).unwrap();
        assert_eq!(
            storyboard.candidates.iter().map(|item| item.clip_id).collect::<Vec<_>>(),
            vec![first_by_journey_time, first_by_file_clock]
        );
    }

    #[test]
    fn chapterize_applies_offset_without_mutating_source_capture_time() {
        let (_directory, mut connection) = setup();
        let clip_id = insert_clip(
            &connection,
            "timezone-stale.mov",
            "2026-08-31T13:31:00Z",
            None,
            false,
        );
        connection.execute(
            "UPDATE clips SET journey_offset_ms = 3600000 WHERE id = ?1",
            [clip_id],
        ).unwrap();
        chapterize(&mut connection).unwrap();

        let captured_at: String = connection.query_row(
            "SELECT captured_at FROM clips WHERE id = ?1",
            [clip_id],
            |row| row.get(0),
        ).unwrap();
        let title: String = connection.query_row(
            "SELECT title FROM chapters WHERE tombstone = 0",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(captured_at, "2026-08-31T13:31:00Z");
        assert_eq!(title, "第1段·14:31-14:31");
    }

    #[test]
    fn latest_reorder_can_be_undone_without_deleting_story_rows() {
        let (_directory, mut connection) = setup();
        let first = insert_clip(&connection, "a.mov", "2026-08-31T10:00:00Z", None, true);
        let second = insert_clip(&connection, "b.mov", "2026-08-31T10:01:00Z", None, true);
        let refs = |ids: &[i64]| {
            ids.iter()
                .map(|clip_id| StoryOrderRef {
                    item_kind: "whole".to_owned(),
                    clip_id: *clip_id,
                    segment_id: None,
                })
                .collect::<Vec<_>>()
        };
        set_story_order(&mut connection, &refs(&[first, second])).unwrap();
        set_story_order(&mut connection, &refs(&[second, first])).unwrap();
        undo_latest(&mut connection).unwrap();

        let storyboard = get_storyboard(&connection).unwrap();
        assert_eq!(
            storyboard.items.iter().map(|item| item.clip_id).collect::<Vec<_>>(),
            vec![first, second]
        );
        let stored_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM story_order", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored_rows, 2);
    }

    #[test]
    fn chapter_merge_and_rename_restore_from_persistent_undo_snapshots() {
        let (_directory, mut connection) = setup();
        insert_clip(&connection, "a.mov", "2026-08-31T10:00:00Z", None, false);
        insert_clip(&connection, "b.mov", "2026-08-31T11:00:00Z", None, false);
        chapterize(&mut connection).unwrap();
        let chapters = get_storyboard(&connection).unwrap().chapters;
        rename_chapter(&mut connection, chapters[0].id, "清晨出发").unwrap();
        merge_chapters(&mut connection, chapters[1].id, chapters[0].id).unwrap();
        assert_eq!(get_storyboard(&connection).unwrap().chapters.len(), 1);
        undo_latest(&mut connection).unwrap();
        let restored = get_storyboard(&connection).unwrap();
        assert_eq!(restored.chapters.len(), 2);
        assert_eq!(restored.chapters[0].title, "清晨出发");
    }

    #[test]
    fn l3_default_off_explicitly_returns_the_legacy_storyboard() {
        let (_directory, mut connection) = setup();
        insert_clip(&connection, "a.mov", "2026-08-31T10:00:00Z", None, true);
        chapterize(&mut connection).unwrap();
        let storyboard = get_storyboard(&connection).unwrap();
        assert_eq!(storyboard.mode, "legacy");
        assert!(storyboard.mode_notice.contains("L3 增强已关闭"));
        assert!(storyboard.narrative.is_none());
        assert_eq!(storyboard.chapters.len(), 1);
    }

    #[test]
    fn l3_on_without_a_draft_keeps_d2_as_a_visible_fallback() {
        let (_directory, connection) = setup();
        set_setting(&connection, LLM_ENABLED_KEY, "true").unwrap();
        let storyboard = get_storyboard(&connection).unwrap();
        assert_eq!(storyboard.mode, "legacy");
        assert!(storyboard.mode_notice.contains("尚无有效编排"));
    }
}
