use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::error::{CoreError, Result};
use super::channel_memory::ClipMemoryAnnotation;
use super::narrative::{self, NarrativeOverview, StoryTemplate};
use super::settings::{self, LLM_ENABLED_KEY};

pub mod band;

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

/// R10 U-03:整条素材进入镜头带 / 模板 / 叙事候选池的谓词——**收藏 ∪ ≥3 星**
/// (精选段另走 `live_selects`,三者合起来就是走查要求的「收藏 ∪ ≥3 星 ∪ 有精选段」)。
/// 两个评级都取整条(非 select 段)上最近一次的值。`alias` 是 clips 表在外层查询里的
/// 别名。story.rs 两处、narrative.rs 两处共用这一段,别再各抄一份只认收藏的版本。
pub(crate) fn whole_clip_candidate_predicate(alias: &str) -> String {
    format!(
        "(1 = (
             SELECT binary.value
             FROM ratings binary
             JOIN segments rated_segment ON rated_segment.id = binary.segment_id
             WHERE rated_segment.clip_id = {alias}.id
               AND COALESCE(rated_segment.kind, 'whole') != 'select'
               AND rated_segment.tombstone = 0
               AND binary.rating_type = 'binary'
             ORDER BY binary.rated_at DESC, binary.id DESC LIMIT 1
         ) OR 3 <= COALESCE((
             SELECT star.value
             FROM ratings star
             JOIN segments rated_segment ON rated_segment.id = star.segment_id
             WHERE rated_segment.clip_id = {alias}.id
               AND COALESCE(rated_segment.kind, 'whole') != 'select'
               AND rated_segment.tombstone = 0
               AND star.rating_type = 'star'
             ORDER BY star.rated_at DESC, star.id DESC LIMIT 1
         ), 0))"
    )
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
    /// 当前 revision 生成时用的模板 id（如 "cinematic"）；无 revision 或 LLM 路径
    /// 未指定模板时为 None。供故事板顶部模板卡片高亮当前选择。
    pub current_template: Option<String>,
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
pub(crate) struct StorySnapshot {
    #[serde(default)]
    pub(crate) band_layout: band::BandLayout,
    pub(crate) chapters: Vec<ChapterSnapshot>,
    pub(crate) clip_chapters: Vec<ClipChapterSnapshot>,
    pub(crate) order: Vec<StoryOrderSnapshot>,
    /// R12 车道 B:「一键排入」那一批的元数据(批号 + 本批写下的行),旧快照没有这个字段。
    /// `undo_arrange` 按它只撤本批;`undo_latest` 照旧整份恢复。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) arrange: Option<ArrangeMeta>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct ArrangeMeta {
    pub(crate) batch_id: String,
    pub(crate) placed: Vec<StoryOrderSnapshot>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct ChapterSnapshot {
    id: i64,
    title: String,
    start_at: String,
    end_at: String,
    manual: i64,
    tombstone: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct ClipChapterSnapshot {
    clip_id: i64,
    chapter_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StoryOrderSnapshot {
    pub(crate) item_kind: String,
    pub(crate) clip_id: i64,
    pub(crate) segment_id: Option<i64>,
    pub(crate) position: i64,
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
         WHERE missing_since IS NULL
           AND kind = 'video'
           AND (episode_id = ?1 OR episode_id IS NULL)",
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
           AND kind = 'video'
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
            "第 {} 章 · {}-{}",
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

/// Z-15(R13 压测):章名里的「14:40-14:40」此前是 UTC —— 多伦多 23:32 拍的写成 03:32。
/// 时分按素材的 `tz_guess`(GPS / 文件里的时区,形如 `UTC-05:00`)换算;没有时退到本机时区
/// (SQLite `localtime`,按拍摄日期算夏令时)。设备时钟校正(`journey_offset_ms`)照旧先加。
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
                    printf('%+f seconds', c.journey_offset_ms / 1000.0),
                    CASE WHEN c.tz_guess LIKE 'UTC_%:%' THEN printf(
                        '%+d seconds',
                        (CAST(substr(c.tz_guess, 5, 2) AS INTEGER) * 3600
                         + CAST(substr(c.tz_guess, 8, 2) AS INTEGER) * 60)
                        * CASE WHEN substr(c.tz_guess, 4, 1) = '-' THEN -1 ELSE 1 END
                    ) ELSE 'localtime' END
                ),
                c.gps_lat, c.gps_lon,
                CASE WHEN chapter.manual = 1 AND chapter.tombstone = 0
                     THEN chapter.id END
         FROM clips c
         LEFT JOIN chapters chapter ON chapter.id = c.chapter_id
         WHERE c.missing_since IS NULL
           AND c.kind = 'video'
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
    get_storyboard_for(connection, None)
}

/// Z-14:按指定集取镜头带(只读查看已封存集时前端传被查看的 `episode_id`);
/// `None` = 当前活跃集。章、交付项、排序、撤销、叙事概览全部按同一个集取。
pub fn get_storyboard_for(connection: &Connection, episode_id: Option<i64>) -> Result<Storyboard> {
    let episode_id = match episode_id {
        Some(id) => id,
        None => active_episode_id(connection)?,
    };
    let mut chapter_statement = connection.prepare(
        "SELECT chapter.id, chapter.title, chapter.start_at, chapter.end_at,
                (SELECT COUNT(*) FROM clips WHERE chapter_id = chapter.id
                 AND (episode_id = ?1 OR episode_id IS NULL)
                 AND missing_since IS NULL
                 AND kind = 'video')
         FROM chapters chapter
         WHERE chapter.tombstone = 0 AND chapter.episode_id = ?1
           AND (
               EXISTS (
                   SELECT 1 FROM clips c
                   WHERE c.chapter_id = chapter.id
                     AND c.kind = 'video'
                     AND c.missing_since IS NULL
                     AND (c.episode_id = ?1 OR c.episode_id IS NULL)
               ) OR (
                   chapter.manual = 1 AND NOT EXISTS (
                       SELECT 1 FROM clips any_clip WHERE any_clip.chapter_id = chapter.id
                   )
               )
           )
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
    let mut chapters = chapter_rows
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(CoreError::from)?;

    let item_sql = format!(
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
               AND c.kind = 'video'
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
               AND c.kind = 'video'
               AND (c.episode_id = ?1 OR c.episode_id IS NULL)
               AND NOT EXISTS (
                   SELECT 1 FROM live_selects selected WHERE selected.clip_id = c.id
               )
               AND {candidate}
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
        candidate = whole_clip_candidate_predicate("c")
    );
    let mut item_statement = connection.prepare(&item_sql)?;
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
    // 有 revision 就展示它——LLM 关闭时那份 revision 是同步跑的确定性兜底，
    // 不该被藏起来假装故事板一片空白（R4 Task 5 之前的行为）。
    let narrative = narrative::load_overview_for_episode(connection, episode_id)?;
    let current_template = narrative
        .as_ref()
        .and_then(|overview| overview.episode.template.clone());
    let (mode, mode_notice) = if let Some(overview) = narrative.as_ref() {
        if l3_enabled {
            (
                "narrative".to_owned(),
                "L3 叙事 v2 已启用；粗剪与镜头表按 Beat 顺序读取。".to_owned(),
            )
        } else {
            let template_name = overview
                .episode
                .template
                .as_deref()
                .and_then(|id| StoryTemplate::parse(id).ok())
                .map(StoryTemplate::name_zh);
            let notice = match template_name {
                Some(name) => format!("未启用 AI，按模板规则生成（{name}）"),
                None => "未启用 AI，按模板规则生成".to_owned(),
            };
            ("template".to_owned(), notice)
        }
    } else if l3_enabled {
        (
            "legacy".to_owned(),
            "L3 已开启但尚无有效编排：当前仍显示 D2 本地章节，候选边界不会自动定章。".to_owned(),
        )
    } else {
        (
            "legacy".to_owned(),
            "L3 增强已关闭：故事板明确回退到 D2 本地章节；时间/GPS 仅按原行为显示。".to_owned(),
        )
    };
    let narration_job_status = narrative::latest_job_status(connection)?;

    band::apply_layout(connection, episode_id, &mut chapters, &mut items)?;
    Ok(Storyboard {
        chapters,
        items,
        candidates,
        can_undo,
        mode,
        mode_notice,
        narrative,
        narration_job_status,
        current_template,
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
    band::remap_chapter(&transaction, episode_id, source_chapter_id, target_chapter_id)?;
    transaction.commit()?;
    Ok(())
}

/// R16 车道 B(P2-1)「删除这一章…」:把这一章的镜移到相邻章(先上一章,没有就下一章),再把它
/// 标成 tombstone。相邻章的时间范围吸收被删章(与合并同一套规则),只剩一章时拒绝。
/// 本质上是「并入相邻章」,快照沿用 `action = "merge"`(story_history 的 CHECK 只认 reorder / rename / merge,
/// §4 本轮无迁移),`undo_story_change` 可整份恢复。返回镜移去的那一章 id。
pub fn delete_chapter(connection: &mut Connection, chapter_id: i64) -> Result<i64> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let episode_id = active_episode_id(&transaction)?;
    let (start_at, end_at) = active_chapter_bounds(&transaction, chapter_id, episode_id)?;
    let neighbour = transaction
        .query_row(
            "SELECT id FROM chapters
             WHERE episode_id = ?1 AND tombstone = 0 AND id != ?2 AND start_at <= ?3
             ORDER BY start_at DESC, id DESC LIMIT 1",
            params![episode_id, chapter_id, start_at],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let neighbour = match neighbour {
        Some(id) => Some(id),
        None => transaction
            .query_row(
                "SELECT id FROM chapters
                 WHERE episode_id = ?1 AND tombstone = 0 AND id != ?2
                 ORDER BY start_at ASC, id ASC LIMIT 1",
                params![episode_id, chapter_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?,
    };
    let target_id = neighbour
        .ok_or_else(|| CoreError::Story("只剩这一章了,不能删除;可以改名或「这章够了」".to_owned()))?;
    let target = active_chapter_bounds(&transaction, target_id, episode_id)?;
    record_snapshot(&transaction, episode_id, "merge")?;
    transaction.execute(
        "UPDATE clips SET chapter_id = ?2
         WHERE chapter_id = ?1 AND (episode_id = ?3 OR episode_id IS NULL)",
        params![chapter_id, target_id, episode_id],
    )?;
    transaction.execute(
        "UPDATE chapters
         SET start_at = ?2, end_at = ?3, manual = 1
         WHERE id = ?1 AND episode_id = ?4",
        params![target_id, target.0.min(start_at), target.1.max(end_at), episode_id],
    )?;
    transaction.execute(
        "UPDATE chapters SET manual = 1, tombstone = 1
         WHERE id = ?1 AND episode_id = ?2",
        params![chapter_id, episode_id],
    )?;
    band::remap_chapter(&transaction, episode_id, chapter_id, target_id)?;
    transaction.commit()?;
    Ok(target_id)
}

/// `undo_latest` 的结果:`skipped_moved` = 快照里已被移到别的集、这次没有放回镜头带的镜数(R17 epmove)。
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
pub struct UndoOutcome {
    pub skipped_moved: usize,
}

pub fn undo_latest(connection: &mut Connection) -> Result<UndoOutcome> {
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
    let skipped_moved = restore_snapshot(&transaction, episode_id, &snapshot)?;
    transaction.execute(
        "UPDATE story_history
         SET undone_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND undone_at IS NULL",
        [latest.0],
    )?;
    transaction.commit()?;
    Ok(UndoOutcome { skipped_moved })
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
                  AND segments.kind = 'select' AND segments.tombstone = 0
                  AND c.kind = 'video'
                  AND (c.episode_id = ?3 OR c.episode_id IS NULL)
             )",
            params![item.segment_id, item.clip_id, episode_id],
            |row| row.get::<_, i64>(0),
        )? == 1
    } else {
        connection.query_row(
            &format!(
                "SELECT EXISTS(
                    SELECT 1 FROM clips c
                    WHERE c.id = ?1 AND c.missing_since IS NULL
                      AND c.kind = 'video'
                      AND (c.episode_id = ?2 OR c.episode_id IS NULL)
                      AND NOT EXISTS (
                          SELECT 1 FROM segments selected
                          WHERE selected.clip_id = c.id
                            AND selected.kind = 'select' AND selected.tombstone = 0
                      )
                      AND {candidate}
                 )",
                candidate = whole_clip_candidate_predicate("c")
            ),
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

pub(crate) fn upsert_story_order(
    connection: &Connection,
    item: &StoryOrderRef,
    episode_id: i64,
    position: i64,
) -> Result<()> {
    if !is_video_clip_in_episode(connection, item.clip_id, episode_id)? {
        return Err(CoreError::Story(format!("视频镜头带拒绝非视频素材 {}", item.clip_id)));
    }
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

pub(crate) fn is_video_clip_in_episode(
    connection: &Connection,
    clip_id: i64,
    episode_id: i64,
) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM clips
             WHERE id = ?1 AND kind = 'video'
               AND missing_since IS NULL
               AND (episode_id = ?2 OR episode_id IS NULL)
         )",
        params![clip_id, episode_id],
        |row| row.get::<_, i64>(0),
    )? == 1)
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

pub(crate) fn story_key(item_kind: &str, clip_id: i64, segment_id: Option<i64>) -> String {
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

pub(crate) fn capture_snapshot(connection: &Connection, episode_id: i64) -> Result<StorySnapshot> {
    let mut chapter_statement = connection.prepare(
        "SELECT id, title, start_at, end_at, manual, tombstone
         FROM chapters chapter
         WHERE episode_id = ?1
           AND (
               EXISTS (
                   SELECT 1 FROM clips c
                   WHERE c.chapter_id = chapter.id AND c.kind = 'video'
                     AND (c.episode_id = ?1 OR c.episode_id IS NULL)
               ) OR (
                   chapter.manual = 1 AND NOT EXISTS (
                       SELECT 1 FROM clips any_clip WHERE any_clip.chapter_id = chapter.id
                   )
               )
           )
         ORDER BY id",
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
         WHERE kind = 'video'
           AND (episode_id = ?1 OR episode_id IS NULL)
         ORDER BY id",
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
        "SELECT story.item_kind, story.clip_id, story.segment_id, story.position
         FROM story_order story
         JOIN clips c ON c.id = story.clip_id
         WHERE story.episode_id = ?1 AND story.tombstone = 0
           AND c.kind = 'video'
           AND c.missing_since IS NULL
           AND (c.episode_id = ?1 OR c.episode_id IS NULL)
         ORDER BY story.position, story.id",
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
        band_layout: band::layout(connection, episode_id)?,
        chapters,
        clip_chapters,
        order,
        arrange: None,
    })
}

/// 回放一份快照;返回因素材已移到别的集而没有回排的镜数(R17 epmove)。
fn restore_snapshot(
    connection: &Connection,
    episode_id: i64,
    snapshot: &StorySnapshot,
) -> Result<usize> {
    band::save_layout(connection, episode_id, &snapshot.band_layout)?;
    connection.execute(
        "UPDATE chapters SET tombstone = 1
         WHERE episode_id = ?1
           AND EXISTS (
               SELECT 1 FROM clips c
               WHERE c.chapter_id = chapters.id AND c.kind = 'video'
                 AND (c.episode_id = ?1 OR c.episode_id IS NULL)
           )",
        [episode_id],
    )?;
    let mut snapshot_video_chapters = HashSet::new();
    for assignment in &snapshot.clip_chapters {
        if let Some(chapter_id) = assignment.chapter_id {
            if is_video_clip_in_episode(connection, assignment.clip_id, episode_id)? {
                snapshot_video_chapters.insert(chapter_id);
            }
        }
    }
    for chapter in &snapshot.chapters {
        let empty_manual = chapter.manual == 1 && connection.query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM clips WHERE chapter_id = ?1)",
            [chapter.id],
            |row| row.get::<_, i64>(0),
        )? == 1;
        if !snapshot_video_chapters.contains(&chapter.id) && !empty_manual {
            continue;
        }
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
         WHERE kind = 'video'
           AND (episode_id = ?1 OR episode_id IS NULL)",
        [episode_id],
    )?;
    for assignment in &snapshot.clip_chapters {
        if let Some(chapter_id) = assignment.chapter_id {
            connection.execute(
                "UPDATE clips SET chapter_id = ?2
                 WHERE id = ?1 AND kind = 'video'
                   AND (episode_id = ?3 OR episode_id IS NULL)",
                params![assignment.clip_id, chapter_id, episode_id],
            )?;
        }
    }
    connection.execute(
        "UPDATE story_order SET tombstone = 1
         WHERE episode_id = ?1 AND tombstone = 0",
        [episode_id],
    )?;
    let mut skipped_moved = 0usize;
    for item in &snapshot.order {
        // R17 epmove:快照里的素材如今属于别的集(被「移到其他集」挪走了)—— 不回排、也不报错:
        // `story_order_whole_unique_idx` 按 clip 全局唯一,硬插会撞索引把整次撤销打死;镜头带是按集的,
        // 别的集的素材本来也不该出现在这一集的带上。跳过数带回给前端提示。
        let clip_state: Option<(Option<i64>, String, Option<String>)> = connection
            .query_row("SELECT episode_id, kind, missing_since FROM clips WHERE id = ?1", [item.clip_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .optional()?;
        let Some((owner, kind, missing_since)) = clip_state else {
            continue;
        };
        if kind != "video" || missing_since.is_some() {
            continue;
        }
        if matches!(owner, Some(other) if other != episode_id) {
            skipped_moved += 1;
            continue;
        }
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
    Ok(skipped_moved)
}

/// 镜头带上的一个镜(V14-01 的「唯一顺序真相」):键与 [`StoryItem::key`] 同一份。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BandItemRef {
    pub key: String,
    pub item_kind: String,
    pub clip_id: i64,
    pub segment_id: Option<i64>,
    pub chapter_id: Option<i64>,
}

/// V14-01:镜头带「按章节」视图的顺序 —— **导出的唯一顺序真相**。章按拍摄时间
/// (`chapters.start_at, id`,与 [`get_storyboard`] 同一条 ORDER BY),未分章/章已删的排最后,
/// 章内按 `story_order.position`。素材包、原生草稿、导出片段三条路都从这里取顺序
/// (经 `deliver::selected_clips` 重排),不再各自按挑选先后(`position` 的全局序)走 ——
/// 两次自动挑选、后一批拍得更早时,`position` 全局序与镜头带画的顺序会对不上。
/// 只含已排进镜头带的镜(`position` 非空);候选不在带上,不在这里。
pub(crate) fn ordered_band_items(connection: &Connection) -> Result<Vec<BandItemRef>> {
    let episode_id = active_episode_id(connection)?;
    let mut statement = connection.prepare(
        "SELECT story.item_kind, story.clip_id, story.segment_id, chapter.id, story.position
         FROM story_order story
         JOIN clips c ON c.id = story.clip_id
         LEFT JOIN chapters chapter
           ON chapter.id = c.chapter_id
          AND chapter.tombstone = 0
          AND chapter.episode_id = ?1
         WHERE story.tombstone = 0
           AND story.episode_id = ?1
           AND c.missing_since IS NULL
           AND c.kind = 'video'
         ORDER BY chapter.id IS NULL, chapter.start_at, chapter.id,
                  story.position, story.id",
    )?;
    let rows = statement.query_map([episode_id], |row| {
        let item_kind: String = row.get(0)?;
        let clip_id: i64 = row.get(1)?;
        let segment_id: Option<i64> = row.get(2)?;
        Ok((BandItemRef {
            key: story_key(&item_kind, clip_id, segment_id),
            item_kind,
            clip_id,
            segment_id,
            chapter_id: row.get(3)?,
        }, row.get::<_, i64>(4)?))
    })?;
    band::ordered(connection, episode_id, rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

pub(crate) fn active_episode_id(connection: &Connection) -> Result<i64> {
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

    fn insert_legacy_whole_order(connection: &Connection, episode_id: i64, clip_id: i64, position: i64) {
        connection
            .execute(
                "INSERT INTO story_order(item_kind, clip_id, segment_id, position, tombstone, created_at, updated_at, episode_id)
                 VALUES ('whole', ?1, NULL, ?2, 0, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z', ?3)",
                params![clip_id, position, episode_id],
            )
            .unwrap();
    }

    #[test]
    fn photo_probe_does_not_block_video_chapterize_scheduling() {
        let (_directory, mut connection) = setup();
        insert_clip(&connection, "video.mov", "2026-08-31T10:00:00Z", None, false);
        connection.execute(
            "INSERT INTO jobs(kind, payload, payload_hash, status, attempt, created_at, updated_at)
             VALUES ('photo_probe', '{}', 'photo-active', 'pending', 0, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z')",
            [],
        ).unwrap();
        assert!(enqueue_if_import_complete(&mut connection).unwrap().is_some());
    }

    #[test]
    fn photo_import_does_not_change_video_chapterize_payload_hash() {
        let (_directory, mut connection) = setup();
        insert_clip(&connection, "video.mov", "2026-08-31T10:00:00Z", None, false);
        assert!(enqueue_if_import_complete(&mut connection).unwrap().is_some());
        connection.execute("UPDATE jobs SET status = 'done' WHERE kind = 'chapterize'", []).unwrap();
        let photo = insert_clip(&connection, "photo.jpg", "2026-09-01T20:00:00Z", None, false);
        connection.execute("UPDATE clips SET kind = 'photo' WHERE id = ?1", [photo]).unwrap();
        assert_eq!(enqueue_if_import_complete(&mut connection).unwrap(), None);
    }

    #[test]
    fn chapterize_moments_boundaries_and_board_ignore_distant_photo() {
        let (_directory, mut connection) = setup();
        let first = insert_clip(&connection, "a.mov", "2026-08-31T10:00:00Z", None, false);
        let second = insert_clip(&connection, "b.mov", "2026-08-31T10:10:00Z", None, false);
        let photo = insert_clip(&connection, "photo.jpg", "2026-09-01T20:00:00Z", None, false);
        connection.execute("UPDATE clips SET kind = 'photo' WHERE id = ?1", [photo]).unwrap();
        let episode = active_episode_id(&connection).unwrap();

        assert_eq!(load_clip_moments(&connection, episode).unwrap().iter().map(|moment| moment.id).collect::<Vec<_>>(), vec![first, second]);
        chapterize(&mut connection).unwrap();
        let video_chapters: Vec<Option<i64>> = [first, second].into_iter().map(|id| connection.query_row("SELECT chapter_id FROM clips WHERE id = ?1", [id], |row| row.get(0)).unwrap()).collect();
        assert_eq!(video_chapters[0], video_chapters[1]);
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM chapters WHERE tombstone = 0", [], |row| row.get::<_, i64>(0)).unwrap(), 1);

        connection.execute(
            "INSERT INTO chapters(title, start_at, end_at, manual, tombstone, episode_id)
             VALUES ('历史照片章', '2026-09-01T20:00:00Z', '2026-09-01T20:00:00Z', 0, 0, ?1)",
            [episode],
        ).unwrap();
        let photo_chapter = connection.last_insert_rowid();
        connection.execute("UPDATE clips SET chapter_id = ?2 WHERE id = ?1", params![photo, photo_chapter]).unwrap();
        let board = get_storyboard(&connection).unwrap();
        assert_eq!(board.chapters.len(), 1);
        assert_eq!(board.chapters[0].clip_count, 2);
    }

    #[test]
    fn story_snapshot_capture_and_restore_never_revive_photo_state() {
        let (_directory, mut connection) = setup();
        let video = insert_clip(&connection, "video.mov", "2026-08-31T10:00:00Z", None, true);
        let photo = insert_clip(&connection, "photo.jpg", "2026-08-31T10:01:00Z", None, true);
        connection.execute("UPDATE clips SET kind = 'photo' WHERE id = ?1", [photo]).unwrap();
        chapterize(&mut connection).unwrap();
        let episode = active_episode_id(&connection).unwrap();
        let video_chapter: i64 = connection.query_row("SELECT chapter_id FROM clips WHERE id = ?1", [video], |row| row.get(0)).unwrap();
        connection.execute(
            "INSERT INTO chapters(title, start_at, end_at, manual, tombstone, episode_id)
             VALUES ('照片章', '2026-08-31T10:01:00Z', '2026-08-31T10:01:00Z', 1, 0, ?1)",
            [episode],
        ).unwrap();
        let photo_chapter = connection.last_insert_rowid();
        connection.execute("UPDATE clips SET chapter_id = ?2 WHERE id = ?1", params![photo, photo_chapter]).unwrap();
        insert_legacy_whole_order(&connection, episode, video, 0);
        insert_legacy_whole_order(&connection, episode, photo, 1);

        let captured = capture_snapshot(&connection, episode).unwrap();
        assert_eq!(captured.chapters.len(), 1);
        assert_eq!(captured.clip_chapters.iter().map(|item| item.clip_id).collect::<Vec<_>>(), vec![video]);
        assert_eq!(captured.order.iter().map(|item| item.clip_id).collect::<Vec<_>>(), vec![video]);

        let mut historical = captured;
        historical.clip_chapters.push(ClipChapterSnapshot { clip_id: photo, chapter_id: Some(video_chapter) });
        historical.order.push(StoryOrderSnapshot { item_kind: "whole".to_owned(), clip_id: photo, segment_id: None, position: 1 });
        restore_snapshot(&connection, episode, &historical).unwrap();
        assert_eq!(connection.query_row("SELECT chapter_id FROM clips WHERE id = ?1", [photo], |row| row.get::<_, i64>(0)).unwrap(), photo_chapter);
        assert_eq!(connection.query_row("SELECT tombstone FROM chapters WHERE id = ?1", [photo_chapter], |row| row.get::<_, i64>(0)).unwrap(), 0);
        let live: Vec<i64> = connection.prepare("SELECT clip_id FROM story_order WHERE tombstone = 0 ORDER BY position").unwrap().query_map([], |row| row.get(0)).unwrap().collect::<std::result::Result<_, _>>().unwrap();
        assert_eq!(live, vec![video]);
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
        // Z-15:章名时分按素材时区;这里钉成 UTC 让断言不随本机时区变。
        connection.execute("UPDATE clips SET tz_guess = 'UTC+00:00'", []).unwrap();
        chapterize(&mut connection).unwrap();

        let titles = connection
            .prepare("SELECT title FROM chapters WHERE tombstone = 0 ORDER BY start_at")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(titles, vec!["第 1 章 · 10:00-10:00", "第 2 章 · 10:45-10:45"]);
    }

    /// Z-15(R13 压测):章名时分不再是 UTC —— 有 `tz_guess` 按它换算(含负时区与半小时时区),
    /// 没有就按本机时区(与 SQLite `localtime` 同源,夏令时按拍摄日期算);设备时钟校正先加。
    #[test]
    fn chapter_title_uses_clip_timezone_or_local_time_instead_of_utc() {
        let (_directory, mut connection) = setup();
        let toronto = insert_clip(&connection, "a.mov", "2026-08-31T03:32:00Z", None, false);
        let adelaide = insert_clip(&connection, "b.mov", "2026-08-31T10:00:00Z", None, false);
        let unknown = insert_clip(&connection, "c.mov", "2026-08-31T20:00:00Z", None, false);
        connection
            .execute("UPDATE clips SET tz_guess = 'UTC-05:00' WHERE id = ?1", [toronto])
            .unwrap();
        connection
            .execute(
                "UPDATE clips SET tz_guess = 'UTC+09:30', journey_offset_ms = 600000 WHERE id = ?1",
                [adelaide],
            )
            .unwrap();
        chapterize(&mut connection).unwrap();
        let titles = connection
            .prepare("SELECT title FROM chapters WHERE tombstone = 0 ORDER BY start_at")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        let local = connection
            .query_row(
                "SELECT strftime('%H:%M', '2026-08-31T20:00:00Z', 'localtime')",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let _ = unknown;
        assert_eq!(
            titles,
            vec![
                "第 1 章 · 22:32-22:32".to_owned(),
                "第 2 章 · 19:40-19:40".to_owned(),
                format!("第 3 章 · {local}-{local}"),
            ]
        );
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

    /// R21 W1 真机 P0:0050 给 `clips` 加了 `kind` 之后,`ensure_selected` 的段分支 `segments JOIN clips`
    /// 里裸写的 `kind = 'select'` 变成 ambiguous column —— 镜头带上只要有一个精选段,任何 `set_story_order`
    /// (拖排 / 「加入当前章节」/ 撤销)都报错。段路径此前没有测试盖到。
    #[test]
    fn r21_story_order_with_select_segment_survives_clips_kind_column() {
        let (_directory, mut connection) = setup();
        let clip = insert_clip(&connection, "a.mov", "2026-08-31T10:00:00Z", None, false);
        connection
            .execute(
                "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind) VALUES (?1, 1000, 5000, 'select')",
                [clip],
            )
            .unwrap();
        let segment_id = connection.last_insert_rowid();
        set_story_order(
            &mut connection,
            &[StoryOrderRef { item_kind: "segment".to_owned(), clip_id: clip, segment_id: Some(segment_id) }],
        )
        .unwrap();
        let storyboard = get_storyboard(&connection).unwrap();
        assert_eq!((storyboard.items[0].clip_id, storyboard.items[0].segment_id), (clip, Some(segment_id)));
    }

    #[test]
    fn r21_story_order_rejects_photo_whole_and_select_segment() {
        let (_directory, mut connection) = setup();
        let photo = insert_clip(&connection, "photo.jpg", "2026-08-31T10:00:00Z", None, true);
        connection.execute("UPDATE clips SET kind = 'photo' WHERE id = ?1", [photo]).unwrap();

        let whole_error = set_story_order(
            &mut connection,
            &[StoryOrderRef { item_kind: "whole".to_owned(), clip_id: photo, segment_id: None }],
        )
        .unwrap_err();
        assert!(whole_error.to_string().contains("已失效"));
        let episode = active_episode_id(&connection).unwrap();
        assert!(upsert_story_order(
            &connection,
            &StoryOrderRef { item_kind: "whole".to_owned(), clip_id: photo, segment_id: None },
            episode,
            0,
        ).is_err());

        connection
            .execute(
                "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind) VALUES (?1, 1000, 5000, 'select')",
                [photo],
            )
            .unwrap();
        let segment_id = connection.last_insert_rowid();
        let segment_error = set_story_order(
            &mut connection,
            &[StoryOrderRef { item_kind: "segment".to_owned(), clip_id: photo, segment_id: Some(segment_id) }],
        )
        .unwrap_err();
        assert!(segment_error.to_string().contains("已失效"));
        let count: i64 = connection.query_row("SELECT COUNT(*) FROM story_order WHERE tombstone = 0", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn r21_storyboard_hides_historical_photo_rows_and_next_video_write_cleans_them() {
        let (_directory, mut connection) = setup();
        let video = insert_clip(&connection, "video.mov", "2026-08-31T10:00:00Z", None, true);
        let video_candidate = insert_clip(&connection, "candidate.mov", "2026-08-31T10:01:00Z", None, true);
        let photo = insert_clip(&connection, "photo.jpg", "2026-08-31T10:02:00Z", None, true);
        let photo_candidate = insert_clip(&connection, "candidate.jpg", "2026-08-31T10:03:00Z", None, true);
        connection.execute("UPDATE clips SET kind = 'photo' WHERE id IN (?1, ?2)", params![photo, photo_candidate]).unwrap();
        let episode = active_episode_id(&connection).unwrap();
        let whole = |clip_id| StoryOrderRef { item_kind: "whole".to_owned(), clip_id, segment_id: None };
        insert_legacy_whole_order(&connection, episode, photo, 0);
        upsert_story_order(&connection, &whole(video), episode, 1).unwrap();

        let board = get_storyboard(&connection).unwrap();
        assert_eq!(board.items.iter().map(|item| item.clip_id).collect::<Vec<_>>(), vec![video]);
        assert_eq!(board.candidates.iter().map(|item| item.clip_id).collect::<Vec<_>>(), vec![video_candidate]);
        assert_eq!(ordered_band_items(&connection).unwrap().iter().map(|item| item.clip_id).collect::<Vec<_>>(), vec![video]);

        set_story_order(&mut connection, &[whole(video)]).unwrap();
        let live: Vec<i64> = connection
            .prepare("SELECT clip_id FROM story_order WHERE episode_id = ?1 AND tombstone = 0 ORDER BY position")
            .unwrap()
            .query_map([episode], |row| row.get(0))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
        assert_eq!(live, vec![video]);
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

    /// V14-01:两章、挑选顺序与章节顺序相反 —— 带上的顺序是「早章在前、章内按 position」,
    /// 与 `story_order.position` 的全局序不同;三条导出都必须走这一份。
    #[test]
    fn ordered_band_items_follow_chapter_time_then_position_not_pick_order() {
        let (_directory, mut connection) = setup();
        let late_a = insert_clip(&connection, "late_a.mov", "2026-08-31T14:00:00Z", None, true);
        let late_b = insert_clip(&connection, "late_b.mov", "2026-08-31T14:10:00Z", None, true);
        let early = insert_clip(&connection, "early.mov", "2026-08-31T09:00:00Z", None, true);
        let candidate = insert_clip(&connection, "candidate.mov", "2026-08-31T09:30:00Z", None, true);
        chapterize(&mut connection).unwrap();
        let storyboard = get_storyboard(&connection).unwrap();
        assert_eq!(storyboard.chapters.len(), 2, "{:?}", storyboard.chapters);
        // 挑选先后:先挑了晚章的两条,再挑早章的一条(position 0/1/2)。
        let whole = |clip_id| StoryOrderRef { item_kind: "whole".to_owned(), clip_id, segment_id: None };
        set_story_order(&mut connection, &[whole(late_b), whole(late_a), whole(early)]).unwrap();

        let ordered = ordered_band_items(&connection).unwrap();
        assert_eq!(
            ordered.iter().map(|item| item.clip_id).collect::<Vec<_>>(),
            vec![early, late_b, late_a],
            "早章在前;晚章内按 position(late_b 先于 late_a)"
        );
        assert_eq!(ordered[0].key, format!("whole:{early}"));
        assert_eq!(ordered[0].chapter_id, Some(storyboard.chapters[0].id));
        assert!(
            !ordered.iter().any(|item| item.clip_id == candidate),
            "没排进镜头带的候选不在带序里"
        );
    }

    fn star_rate(connection: &Connection, clip_id: i64, stars: i64, at: &str) {
        connection
            .execute(
                "INSERT INTO ratings(segment_id, rating_type, value, rated_at)
                 SELECT id, 'star', ?2, ?3 FROM segments
                  WHERE clip_id = ?1 AND kind = 'whole' AND tombstone = 0",
                params![clip_id, stars, at],
            )
            .unwrap();
    }

    /// R10 U-03:候选池 = 收藏 ∪ ≥3 星 ∪ 有精选段。三星未收藏的片进候选并可排进
    /// 镜头带;两星不进,`set_story_order` 也拒绝;后来降到两星即退出候选。
    #[test]
    fn three_star_clips_are_story_candidates_even_when_not_favorited() {
        let (_directory, mut connection) = setup();
        let three_star = insert_clip(&connection, "a.mov", "2026-08-31T10:00:00Z", None, false);
        let two_star = insert_clip(&connection, "b.mov", "2026-08-31T10:01:00Z", None, false);
        let favorite = insert_clip(&connection, "c.mov", "2026-08-31T10:02:00Z", None, true);
        star_rate(&connection, three_star, 3, "2026-08-31T11:00:00Z");
        star_rate(&connection, two_star, 2, "2026-08-31T11:00:00Z");

        let storyboard = get_storyboard(&connection).unwrap();
        let candidate_ids = storyboard.candidates.iter().map(|item| item.clip_id).collect::<Vec<_>>();
        assert_eq!(candidate_ids, vec![three_star, favorite]);

        set_story_order(
            &mut connection,
            &[StoryOrderRef { item_kind: "whole".to_owned(), clip_id: three_star, segment_id: None }],
        )
        .unwrap();
        assert_eq!(get_storyboard(&connection).unwrap().items[0].clip_id, three_star);
        let refused = set_story_order(
            &mut connection,
            &[StoryOrderRef { item_kind: "whole".to_owned(), clip_id: two_star, segment_id: None }],
        );
        assert!(refused.is_err(), "两星未收藏的片不能进镜头带");

        // 最近一次评级说了算:降到两星即退出候选。
        star_rate(&connection, three_star, 2, "2026-08-31T12:00:00Z");
        let storyboard = get_storyboard(&connection).unwrap();
        assert!(storyboard.candidates.iter().all(|item| item.clip_id != three_star));
        assert!(storyboard.items.iter().all(|item| item.clip_id != three_star));
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
        // Z-14:只读查看已封存集时按被查看的集取镜头带——章与镜都是那一集的,不是当前集的。
        let viewed = get_storyboard_for(&connection, Some(first_episode)).unwrap();
        assert_eq!(viewed.items.iter().map(|item| item.clip_id).collect::<Vec<_>>(), vec![archived_clip]);
        assert_eq!(viewed.chapters.iter().map(|chapter| chapter.id).collect::<Vec<_>>(), vec![archived_chapter]);
        assert_eq!(
            get_storyboard_for(&connection, None).unwrap().items.iter().map(|item| item.clip_id).collect::<Vec<_>>(),
            vec![active_clip],
            "不传集 id 仍是当前集"
        );
        assert!(crate::core::story_gap::list_for(&connection, Some(first_episode)).unwrap().is_empty());
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
        // Z-15:章名时分按素材时区,这里钉成 UTC 让断言只看设备时钟校正那 1 小时。
        connection.execute(
            "UPDATE clips SET journey_offset_ms = 3600000, tz_guess = 'UTC+00:00' WHERE id = ?1",
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
        assert_eq!(title, "第 1 章 · 14:31-14:31");
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

    /// R17 epmove:素材被移到别的集之后,原集撤更早的排片 —— 那条镜不回排(跳过计数 1)、其余镜正常回排、不报错
    /// (以前会撞 `story_order_whole_unique_idx`)。
    #[test]
    fn undo_skips_shots_whose_clip_moved_to_another_episode() {
        let (_directory, mut connection) = setup();
        let first = insert_clip(&connection, "a.mov", "2026-08-31T10:00:00Z", None, true);
        let second = insert_clip(&connection, "b.mov", "2026-08-31T10:01:00Z", None, true);
        let third = insert_clip(&connection, "c.mov", "2026-08-31T10:02:00Z", None, true);
        let refs = |ids: &[i64]| {
            ids.iter()
                .map(|clip_id| StoryOrderRef { item_kind: "whole".to_owned(), clip_id: *clip_id, segment_id: None })
                .collect::<Vec<_>>()
        };
        set_story_order(&mut connection, &refs(&[first, second, third])).unwrap();
        set_story_order(&mut connection, &refs(&[third, second, first])).unwrap();
        let origin = active_episode_id(&connection).unwrap();
        connection.execute("UPDATE clips SET episode_id = ?1", [origin]).unwrap();
        connection
            .execute(
                "INSERT INTO episodes(title, theme, created_at, status, episode_number, memory_id, target_platform, canvas_orientation)
                 SELECT 'EP02', '', created_at, 'archived', 2, lower(hex(randomblob(16))), target_platform, canvas_orientation
                   FROM episodes WHERE id = ?1",
                [origin],
            )
            .unwrap();
        let other = connection.last_insert_rowid();
        // 把 second 挪到另一集,再在原集撤销更早的排片。
        let moved = crate::core::episode::move_clips_to_episode(&mut connection, &[second], other).unwrap();
        assert_eq!(moved.moved, 1);
        let outcome = undo_latest(&mut connection).unwrap();
        assert_eq!(outcome.skipped_moved, 1);
        let storyboard = get_storyboard(&connection).unwrap();
        assert_eq!(storyboard.items.iter().map(|item| item.clip_id).collect::<Vec<_>>(), vec![first, third]);
        let owner: i64 = connection.query_row("SELECT episode_id FROM clips WHERE id = ?1", [second], |r| r.get(0)).unwrap();
        assert_eq!(owner, other, "撤销排片不改素材归属");
        let live_for_moved: i64 = connection
            .query_row("SELECT COUNT(*) FROM story_order WHERE clip_id = ?1 AND tombstone = 0", [second], |r| r.get(0))
            .unwrap();
        assert_eq!(live_for_moved, 0);
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

    /// R16 P2-1:删中间一章 → 镜移到上一章、上一章吸收时间范围;删第一章 → 镜移到下一章;
    /// 只剩一章时拒绝;整份可由 undo_latest 恢复。
    #[test]
    fn delete_chapter_moves_clips_to_the_neighbour_and_is_undoable() {
        let (_directory, mut connection) = setup();
        let a = insert_clip(&connection, "a.mov", "2026-08-31T10:00:00Z", None, false);
        let b = insert_clip(&connection, "b.mov", "2026-08-31T11:00:00Z", None, false);
        let c = insert_clip(&connection, "c.mov", "2026-08-31T12:00:00Z", None, false);
        chapterize(&mut connection).unwrap();
        let chapters = get_storyboard(&connection).unwrap().chapters;
        assert_eq!(chapters.len(), 3);
        let chapter_of = |connection: &Connection, clip: i64| -> i64 {
            connection
                .query_row("SELECT chapter_id FROM clips WHERE id = ?1", [clip], |row| row.get(0))
                .unwrap()
        };

        // 中间章 → 上一章。
        let target = delete_chapter(&mut connection, chapters[1].id).unwrap();
        assert_eq!(target, chapters[0].id);
        assert_eq!(chapter_of(&connection, b), chapters[0].id);
        let after = get_storyboard(&connection).unwrap().chapters;
        assert_eq!(after.len(), 2);
        assert_eq!(after[0].clip_count, 2);
        assert!(after[0].end_at >= chapters[1].end_at);

        // 第一章 → 下一章(没有上一章)。
        let target = delete_chapter(&mut connection, chapters[0].id).unwrap();
        assert_eq!(target, chapters[2].id);
        assert_eq!(chapter_of(&connection, a), chapters[2].id);
        assert_eq!(chapter_of(&connection, c), chapters[2].id);
        assert_eq!(get_storyboard(&connection).unwrap().chapters.len(), 1);

        // 只剩一章:拒绝。
        let error = delete_chapter(&mut connection, chapters[2].id).unwrap_err();
        assert!(error.to_string().contains("只剩这一章"));

        // 撤销两次回到三章。
        undo_latest(&mut connection).unwrap();
        undo_latest(&mut connection).unwrap();
        let restored = get_storyboard(&connection).unwrap().chapters;
        assert_eq!(restored.len(), 3);
        assert_eq!(chapter_of(&connection, b), chapters[1].id);
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
    fn l3_off_with_a_persisted_fallback_revision_shows_template_mode() {
        // R4 Task 5：LLM 关闭但已有一份同步落地的兜底 revision 时,不能再假装
        // 「什么都没生成」——要展示它,并如实标注这是模板产物不是 AI 编排。
        let (_directory, mut connection) = setup();
        insert_clip(&connection, "a.mov", "2026-08-31T10:00:00Z", None, true);
        chapterize(&mut connection).unwrap();
        narrative::enqueue_with_template(&mut connection, Some(StoryTemplate::Cinematic))
            .unwrap();
        let storyboard = get_storyboard(&connection).unwrap();
        assert_eq!(storyboard.mode, "template");
        assert!(storyboard.mode_notice.contains("未启用 AI"));
        assert!(storyboard.mode_notice.contains("电影感"));
        assert_eq!(storyboard.current_template.as_deref(), Some("cinematic"));
        assert!(storyboard.narrative.is_some());
        assert!(!storyboard.narrative.unwrap().chapters.is_empty());
    }

    #[test]
    fn l3_off_without_any_revision_stays_legacy() {
        let (_directory, mut connection) = setup();
        insert_clip(&connection, "a.mov", "2026-08-31T10:00:00Z", None, true);
        chapterize(&mut connection).unwrap();
        let storyboard = get_storyboard(&connection).unwrap();
        assert_eq!(storyboard.mode, "legacy");
        assert!(storyboard.narrative.is_none());
        assert_eq!(storyboard.current_template, None);
    }

    #[test]
    fn l3_on_without_a_draft_keeps_d2_as_a_visible_fallback() {
        let (_directory, connection) = setup();
        set_setting(&connection, LLM_ENABLED_KEY, "true").unwrap();
        let storyboard = get_storyboard(&connection).unwrap();
        assert_eq!(storyboard.mode, "legacy");
        assert!(storyboard.mode_notice.contains("尚无有效编排"));
    }

    /// R6 Task 7c pin: two Episodes, each with its own clip + chapter — the
    /// storyboard for whichever Episode is active must show only its own
    /// chapter/clip, never the other Episode's. Written as a regression test
    /// for `get_storyboard`'s episode scoping; it passed on the first run
    /// against the existing code (recorded in task-7c-report.md as a
    /// legitimate "already correct" outcome, not skipped).
    #[test]
    fn get_storyboard_never_leaks_another_episodes_chapter_or_clips() {
        let (_directory, mut connection) = setup();
        let episode_one = crate::core::episode::current_episode(&connection).unwrap().id;
        let clip_one = insert_clip(&connection, "ep1.mov", "2026-08-31T10:00:00Z", None, true);
        connection
            .execute(
                "UPDATE clips SET episode_id = ?2 WHERE id = ?1",
                params![clip_one, episode_one],
            )
            .unwrap();
        chapterize(&mut connection).unwrap();
        let storyboard_one = get_storyboard(&connection).unwrap();
        assert_eq!(storyboard_one.chapters.len(), 1);
        let chapter_one = storyboard_one.chapters[0].id;

        // 封存,并保持下一集也有素材才能封存
        let clip_placeholder = insert_clip(&connection, "placeholder.mov", "2026-08-31T09:00:00Z", None, false);
        connection
            .execute(
                "UPDATE clips SET episode_id = ?2 WHERE id = ?1",
                params![clip_placeholder, episode_one],
            )
            .unwrap();
        let outcome = crate::core::episode::archive_current(&mut connection, None).unwrap();
        let episode_two = outcome.next.id;

        let clip_two = insert_clip(&connection, "ep2.mov", "2026-09-01T10:00:00Z", None, true);
        connection
            .execute(
                "UPDATE clips SET episode_id = ?2 WHERE id = ?1",
                params![clip_two, episode_two],
            )
            .unwrap();
        chapterize(&mut connection).unwrap();

        let storyboard_two = get_storyboard(&connection).unwrap();
        // 只看到本集的章节
        assert_eq!(storyboard_two.chapters.len(), 1);
        assert_ne!(storyboard_two.chapters[0].id, chapter_one);
        // 只看到本集的素材(精选 items + 候选 candidates 合起来只有 clip_two)
        let all_clip_ids: HashSet<i64> = storyboard_two
            .items
            .iter()
            .chain(storyboard_two.candidates.iter())
            .map(|item| item.clip_id)
            .collect();
        assert_eq!(all_clip_ids, HashSet::from([clip_two]));
        assert!(!all_clip_ids.contains(&clip_one));
    }
}
