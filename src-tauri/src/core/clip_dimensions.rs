use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::error::{CoreError, Result};
use super::jobs::Job;
use super::sidecar::{self, ClassificationScores, DimensionPrototypes, MODEL_NAME};

pub const UNCERTAIN_THRESHOLD: f32 = 0.22;
// 待 97 条真机素材校准：160px C6 块匹配域中的 follow 三阈值。
pub const FOLLOW_SHAKE_THRESHOLD: f64 = 1.5;
pub const FOLLOW_GLOBAL_DISPLACEMENT: f64 = 1.5;
pub const FOLLOW_RESIDUAL_RMS: f64 = 2.0;
pub const FOLLOW_DIRECTION_COHERENCE: f64 = 0.70;
pub const ACTION_DYNAMIC_RANGE_DB: f64 = 12.0;
pub const TALKING_COVERAGE_THRESHOLD: f64 = 0.40;
pub const SUNSET_YAVG_AUXILIARY: f64 = 80.0;

const PROTOTYPES_JSON: &str = include_str!("../../../sidecar/prototypes.json");
const EXPECTED_DIMENSIONS: [&str; 8] = [
    "movement",
    "shot_size",
    "subject",
    "viewpoint",
    "function",
    "person_state",
    "time_stage",
    "sound",
];
const CLIP_DIMENSIONS: [&str; 5] = [
    "shot_size",
    "subject",
    "viewpoint",
    "function",
    "person_state",
];
const TIME_STAGE_LABELS: [&str; 8] = [
    "出发", "路上", "到达", "探索", "吃饭", "活动", "日落夜景", "返回",
];

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClipDimension {
    pub clip_id: i64,
    pub dimension: String,
    pub label: String,
    pub score: f32,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ClassifyDimensionsPayload {
    clip_id: i64,
    source_hash: String,
    image_path: String,
    prototypes_version: String,
}

#[derive(Debug, Deserialize)]
struct PrototypeConfig {
    version: String,
    dimensions: BTreeMap<String, BTreeMap<String, Vec<String>>>,
}

#[derive(Debug)]
struct DimensionSource {
    clip_id: i64,
    captured_at: Option<String>,
    chapter_id: Option<i64>,
    duration_ticks: i64,
    tb_num: i64,
    tb_den: i64,
    exposure_yavg: Option<f64>,
    has_audio: Option<bool>,
    audio_dynamic_range_db: Option<f64>,
    motion: Option<MotionEvidence>,
}

#[derive(Debug)]
struct MotionEvidence {
    class: String,
    pan_ratio: f64,
    tilt_ratio: f64,
    zoom_corr: f64,
    shake_score: f64,
    mean_magnitude: Option<f64>,
    residual_rms: Option<f64>,
    direction_coherence: Option<f64>,
}

#[derive(Debug, Clone, Copy, Default)]
struct StoryPosition {
    chapter_index: usize,
    chapter_count: usize,
    clip_index: usize,
}

pub fn enqueue_missing(connection: &mut Connection, cache_root: &Path) -> Result<usize> {
    let clip_ids = {
        let mut statement = connection.prepare(
            "SELECT c.id
             FROM clips c
             JOIN clip_embeddings e
               ON e.clip_id = c.id AND e.source_hash = c.quick_hash AND e.model = ?1
             JOIN cache_artifacts cover
               ON cover.clip_id = c.id AND cover.kind = 'cover'
              AND cover.source_hash = c.quick_hash
             LEFT JOIN clip_dimensions d ON d.clip_id = c.id
             GROUP BY c.id
             HAVING COUNT(DISTINCT d.dimension) < 8
             ORDER BY c.id",
        )?;
        let rows = statement.query_map([MODEL_NAME], |row| row.get::<_, i64>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut enqueued = 0;
    for clip_id in clip_ids {
        if enqueue_for_clip(connection, clip_id, cache_root)?.is_some() {
            enqueued += 1;
        }
    }
    Ok(enqueued)
}

pub fn enqueue_for_dependency_job(
    connection: &mut Connection,
    dependency: &Job,
    cache_root: &Path,
) -> Result<Option<i64>> {
    let value: serde_json::Value = serde_json::from_str(&dependency.payload).map_err(|error| {
        CoreError::ClipDimensions(format!(
            "无法读取 {} 任务的素材编号：{error}",
            dependency.kind
        ))
    })?;
    let clip_id = value
        .get("clip_id")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| {
            CoreError::ClipDimensions(format!("{} 任务缺少 clip_id", dependency.kind))
        })?;
    enqueue_for_clip(connection, clip_id, cache_root)
}

pub fn enqueue_for_clip(
    connection: &mut Connection,
    clip_id: i64,
    cache_root: &Path,
) -> Result<Option<i64>> {
    let config = prototype_config()?;
    let candidate = connection
        .query_row(
            "SELECT c.quick_hash, cover.rel_path
             FROM clips c
             JOIN clip_embeddings e
               ON e.clip_id = c.id AND e.source_hash = c.quick_hash AND e.model = ?2
             JOIN cache_artifacts cover
               ON cover.clip_id = c.id AND cover.kind = 'cover'
              AND cover.source_hash = c.quick_hash
             WHERE c.id = ?1 AND c.quick_hash IS NOT NULL",
            params![clip_id, MODEL_NAME],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((source_hash, relative_path)) = candidate else {
        return Ok(None);
    };
    let image_path = cache_root.join(relative_path);
    if !image_path.is_file() {
        return Ok(None);
    }
    let payload = ClassifyDimensionsPayload {
        clip_id,
        source_hash: source_hash.clone(),
        image_path: image_path.to_string_lossy().into_owned(),
        prototypes_version: config.version.clone(),
    };
    let payload_json = serde_json::to_string(&payload).map_err(|error| {
        CoreError::ClipDimensions(format!("无法创建八维分类任务：{error}"))
    })?;
    let payload_hash = blake3::hash(
        format!(
            "classify_dims\0{clip_id}\0{source_hash}\0{}",
            config.version
        )
        .as_bytes(),
    )
    .to_hex()
    .to_string();

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing = transaction
        .query_row(
            "SELECT id, status FROM jobs
             WHERE kind = 'classify_dims' AND payload_hash = ?1
             ORDER BY id DESC LIMIT 1",
            [&payload_hash],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if let Some((job_id, status)) = existing {
        if matches!(status.as_str(), "pending" | "running") {
            transaction.commit()?;
            return Ok(None);
        }
        transaction.execute(
            "UPDATE jobs
             SET payload = ?2, status = 'pending', attempt = 0,
                 blocked_summary = NULL, result_path = NULL, finished_at = NULL,
                 next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1",
            params![job_id, payload_json],
        )?;
        transaction.commit()?;
        return Ok(Some(job_id));
    }
    transaction.execute(
        "INSERT INTO jobs(
            kind, payload, payload_hash, status, attempt,
            next_attempt_at, created_at, updated_at
         ) VALUES (
            'classify_dims', ?1, ?2, 'pending', 0,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         )",
        params![payload_json, payload_hash],
    )?;
    let job_id = transaction.last_insert_rowid();
    transaction.commit()?;
    Ok(Some(job_id))
}

pub fn run_classify_dims(connection: &mut Connection, job: &Job) -> Result<()> {
    let payload: ClassifyDimensionsPayload = serde_json::from_str(&job.payload).map_err(|error| {
        CoreError::ClipDimensions(format!("八维分类任务数据无效：{error}"))
    })?;
    let config = prototype_config()?;
    if payload.prototypes_version != config.version {
        return Err(CoreError::ClipDimensions(format!(
            "原型版本 {} 已过期，当前为 {}",
            payload.prototypes_version, config.version
        )));
    }
    let image_path = PathBuf::from(&payload.image_path);
    if !image_path.is_file() {
        return Err(CoreError::ClipDimensions(format!(
            "素材 {} 缺少代表帧：{}",
            payload.clip_id,
            image_path.display()
        )));
    }
    let source = load_current_source(connection, job, &payload)?;
    let prototypes = flattened_prototypes(&config)?;
    let scores = sidecar::classify(&image_path, &prototypes)?;
    let mut dimensions = classify_clip_dimensions(connection, &source, &config, &scores)?;
    dimensions.push(movement_dimension(source.clip_id, source.motion.as_ref()));
    dimensions.sort_by_key(|item| dimension_order(&item.dimension));
    persist_dimensions(connection, job, &payload, &dimensions)
}

pub fn list_clip_dimensions(connection: &Connection) -> Result<Vec<ClipDimension>> {
    let mut statement = connection.prepare(
        "SELECT clip_id, dimension, label, score, source
         FROM clip_dimensions
         ORDER BY clip_id,
           CASE dimension
             WHEN 'movement' THEN 1 WHEN 'shot_size' THEN 2
             WHEN 'subject' THEN 3 WHEN 'viewpoint' THEN 4
             WHEN 'function' THEN 5 WHEN 'person_state' THEN 6
             WHEN 'time_stage' THEN 7 WHEN 'sound' THEN 8 ELSE 99
           END",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(ClipDimension {
            clip_id: row.get(0)?,
            dimension: row.get(1)?,
            label: row.get(2)?,
            score: row.get(3)?,
            source: row.get(4)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(CoreError::from)
}

pub fn set_user_time_stage(connection: &Connection, clip_id: i64, label: &str) -> Result<()> {
    if !TIME_STAGE_LABELS.contains(&label) {
        return Err(CoreError::ClipDimensions(format!("无效的时间阶段：{label}")));
    }
    let changed = connection.execute(
        "INSERT INTO clip_dimensions(clip_id, dimension, label, score, source)
         SELECT id, 'time_stage', ?2, 1.0, 'user' FROM clips WHERE id = ?1
         ON CONFLICT(clip_id, dimension) DO UPDATE SET
           label = excluded.label, score = 1.0, source = 'user'",
        params![clip_id, label],
    )?;
    if changed != 1 {
        return Err(CoreError::ClipDimensions(format!("素材 {clip_id} 不存在")));
    }
    Ok(())
}

fn prototype_config() -> Result<PrototypeConfig> {
    let config: PrototypeConfig = serde_json::from_str(PROTOTYPES_JSON).map_err(|error| {
        CoreError::ClipDimensions(format!("八维原型 JSON 无效：{error}"))
    })?;
    for dimension in CLIP_DIMENSIONS {
        let labels = config.dimensions.get(dimension).ok_or_else(|| {
            CoreError::ClipDimensions(format!("原型缺少 {dimension} 维"))
        })?;
        if labels.len() < 3 || labels.len() > 8 {
            return Err(CoreError::ClipDimensions(format!(
                "{dimension} 维必须包含 3-8 个标签"
            )));
        }
    }
    Ok(config)
}

fn flattened_prototypes(config: &PrototypeConfig) -> Result<DimensionPrototypes> {
    let mut flattened = DimensionPrototypes::new();
    for dimension in CLIP_DIMENSIONS {
        for (label, prompts) in &config.dimensions[dimension] {
            if prompts.is_empty() || prompts.len() > 8 {
                return Err(CoreError::ClipDimensions(format!(
                    "{dimension}/{label} 必须包含 1-8 条原型"
                )));
            }
            flattened.insert(format!("{dimension}::{label}"), prompts.clone());
        }
    }
    Ok(flattened)
}

fn load_current_source(
    connection: &Connection,
    job: &Job,
    payload: &ClassifyDimensionsPayload,
) -> Result<DimensionSource> {
    connection
        .query_row(
            "SELECT c.id, c.captured_at, c.chapter_id,
                    COALESCE(c.duration_ticks, 0), COALESCE(c.tb_num, 1),
                    COALESCE(c.tb_den, 1), a.exposure_yavg, a.has_audio,
                    json_extract(a.tool_versions, '$.signals.audio_dynamic_range_db'),
                    m.class, m.pan_ratio, m.tilt_ratio, m.zoom_corr, m.shake_score,
                    m.tool_version
             FROM jobs j
             JOIN clips c ON c.id = ?3 AND c.quick_hash = ?4
             JOIN clip_embeddings e
               ON e.clip_id = c.id AND e.source_hash = c.quick_hash AND e.model = ?5
             JOIN cache_artifacts cover
               ON cover.clip_id = c.id AND cover.kind = 'cover'
              AND cover.source_hash = c.quick_hash
             LEFT JOIN clip_analysis a ON a.clip_id = c.id
             LEFT JOIN clip_motion m ON m.clip_id = c.id
             WHERE j.id = ?1 AND j.status = 'running' AND j.attempt = ?2",
            params![
                job.id,
                job.attempt,
                payload.clip_id,
                payload.source_hash,
                MODEL_NAME
            ],
            |row| {
                let motion = match row.get::<_, Option<String>>(9)? {
                    Some(class) => Some(MotionEvidence {
                        class,
                        pan_ratio: row.get(10)?,
                        tilt_ratio: row.get(11)?,
                        zoom_corr: row.get(12)?,
                        shake_score: row.get(13)?,
                        mean_magnitude: row
                            .get::<_, String>(14)?
                            .split(';')
                            .find_map(|part| parse_motion_metric(part, "mean_magnitude")),
                        residual_rms: row
                            .get::<_, String>(14)?
                            .split(';')
                            .find_map(|part| parse_motion_metric(part, "residual_rms")),
                        direction_coherence: row
                            .get::<_, String>(14)?
                            .split(';')
                            .find_map(|part| parse_motion_metric(part, "direction_coherence")),
                    }),
                    None => None,
                };
                Ok(DimensionSource {
                    clip_id: row.get(0)?,
                    captured_at: row.get(1)?,
                    chapter_id: row.get(2)?,
                    duration_ticks: row.get(3)?,
                    tb_num: row.get(4)?,
                    tb_den: row.get(5)?,
                    exposure_yavg: row.get(6)?,
                    has_audio: row.get::<_, Option<i64>>(7)?.map(|value| value == 1),
                    audio_dynamic_range_db: row.get(8)?,
                    motion,
                })
            },
        )
        .optional()?
        .ok_or_else(|| {
            CoreError::ClipDimensions(format!(
                "素材 {} 已变化或 classify_dims attempt 已过期",
                payload.clip_id
            ))
        })
}

fn classify_clip_dimensions(
    connection: &Connection,
    source: &DimensionSource,
    config: &PrototypeConfig,
    scores: &ClassificationScores,
) -> Result<Vec<ClipDimension>> {
    let mut dimensions = Vec::with_capacity(7);
    for dimension in CLIP_DIMENSIONS {
        dimensions.push(classified_dimension(
            source.clip_id,
            dimension,
            &config.dimensions[dimension],
            scores,
        )?);
    }
    let subject = dimensions
        .iter()
        .find(|item| item.dimension == "subject")
        .map(|item| item.label.clone());
    let person_state = dimensions
        .iter()
        .find(|item| item.dimension == "person_state")
        .map(|item| item.label.clone());
    let story = story_position(connection, source.chapter_id, source.clip_id)?;
    let time = time_dimension(source, story, subject.as_deref(), person_state.as_deref());
    dimensions.push(time);
    let coverage = transcript_coverage(connection, source)?;
    dimensions.push(sound_dimension(source, coverage));
    Ok(dimensions)
}

fn classified_dimension(
    clip_id: i64,
    dimension: &str,
    labels: &BTreeMap<String, Vec<String>>,
    scores: &ClassificationScores,
) -> Result<ClipDimension> {
    let (label, score) = labels
        .keys()
        .filter_map(|label| {
            scores
                .get(&format!("{dimension}::{label}"))
                .map(|score| (label, *score))
        })
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .ok_or_else(|| {
            CoreError::ClipDimensions(format!("sidecar 未返回 {dimension} 维分数"))
        })?;
    Ok(ClipDimension {
        clip_id,
        dimension: dimension.to_owned(),
        label: if score < UNCERTAIN_THRESHOLD {
            "不确定".to_owned()
        } else {
            label.clone()
        },
        score,
        source: format!("chinese_clip:{MODEL_NAME}:{}", prototype_config()?.version),
    })
}

fn movement_dimension(clip_id: i64, motion: Option<&MotionEvidence>) -> ClipDimension {
    let (label, score, source) = match motion {
        None => ("不确定", 0.0, "motion_c6:missing"),
        Some(motion) => match motion.class.as_str() {
            "static" => (
                "Static",
                1.0 - (motion.shake_score / FOLLOW_SHAKE_THRESHOLD).min(1.0),
                "motion_c6",
            ),
            "pan" => ("Pan", motion.pan_ratio.clamp(0.0, 1.0), "motion_c6"),
            "tilt" => ("Tilt", motion.tilt_ratio.clamp(0.0, 1.0), "motion_c6"),
            "zoom" => (
                "Push-Pull-Zoom",
                motion.zoom_corr.abs().clamp(0.0, 1.0),
                "motion_c6",
            ),
            "handheld"
                if matches!(
                    (motion.mean_magnitude, motion.residual_rms, motion.direction_coherence),
                    (Some(displacement), Some(residual), Some(coherence))
                        if displacement >= FOLLOW_GLOBAL_DISPLACEMENT
                            && residual <= FOLLOW_RESIDUAL_RMS
                            && coherence >= FOLLOW_DIRECTION_COHERENCE
                ) => (
                    "handheld_follow",
                    motion.direction_coherence.unwrap_or(0.0).clamp(0.0, 1.0),
                    "motion_c6:global+residual+direction",
                ),
            "handheld" if motion.mean_magnitude.is_some() => (
                "handheld_shaky",
                (motion.shake_score / (FOLLOW_SHAKE_THRESHOLD * 2.0)).clamp(0.0, 1.0),
                "motion_c6:global+residual+direction",
            ),
            "handheld" if motion.shake_score < FOLLOW_SHAKE_THRESHOLD => (
                "handheld_follow",
                (1.0 - motion.shake_score / (FOLLOW_SHAKE_THRESHOLD * 2.0)).clamp(0.0, 1.0),
                "motion_c6:legacy_shake_fallback",
            ),
            "handheld" => (
                "handheld_shaky",
                (motion.shake_score / (FOLLOW_SHAKE_THRESHOLD * 2.0)).clamp(0.0, 1.0),
                "motion_c6:legacy_shake_fallback",
            ),
            _ => ("不确定", 0.0, "motion_c6:unknown"),
        },
    };
    ClipDimension {
        clip_id,
        dimension: "movement".to_owned(),
        label: label.to_owned(),
        score: score as f32,
        source: source.to_owned(),
    }
}

fn parse_motion_metric(part: &str, key: &str) -> Option<f64> {
    part.trim()
        .strip_prefix(key)?
        .strip_prefix('=')?
        .split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

fn story_position(
    connection: &Connection,
    chapter_id: Option<i64>,
    clip_id: i64,
) -> Result<StoryPosition> {
    let Some(chapter_id) = chapter_id else {
        return Ok(StoryPosition::default());
    };
    let Some((chapter_index, chapter_count)) = connection.query_row(
        "SELECT
           (SELECT COUNT(*) FROM chapters prior
            WHERE prior.tombstone = 0
              AND (prior.start_at < current_chapter.start_at
                   OR (prior.start_at = current_chapter.start_at
                       AND prior.id < current_chapter.id))),
           (SELECT COUNT(*) FROM chapters WHERE tombstone = 0)
         FROM chapters current_chapter
         WHERE current_chapter.id = ?1 AND current_chapter.tombstone = 0",
        [chapter_id],
        |row| Ok((row.get::<_, i64>(0)? as usize, row.get::<_, i64>(1)? as usize)),
    ).optional()? else {
        return Ok(StoryPosition::default());
    };
    let clip_index = connection.query_row(
         "SELECT COUNT(*) FROM clips sibling
         JOIN clips current_clip ON current_clip.id = ?2
         WHERE sibling.chapter_id = ?1
           AND (COALESCE(sibling.captured_at, '') < COALESCE(current_clip.captured_at, '')
                OR (COALESCE(sibling.captured_at, '') = COALESCE(current_clip.captured_at, '')
                    AND sibling.id < current_clip.id))",
        params![chapter_id, clip_id],
        |row| row.get::<_, i64>(0),
    )? as usize;
    Ok(StoryPosition {
        chapter_index,
        chapter_count,
        clip_index,
    })
}

fn time_dimension(
    source: &DimensionSource,
    story: StoryPosition,
    subject: Option<&str>,
    person_state: Option<&str>,
) -> ClipDimension {
    let hour = source.captured_at.as_deref().and_then(captured_hour);
    let last_chapter = story.chapter_count > 1 && story.chapter_index + 1 == story.chapter_count;
    let (label, score) = if last_chapter {
        ("返回", 0.82)
    } else if subject == Some("食物") && hour.is_some_and(|hour| (11..=14).contains(&hour)) {
        ("吃饭", 0.92)
    } else if hour.is_some_and(|hour| (17..=19).contains(&hour)) {
        (
            "日落夜景",
            if source.exposure_yavg.is_some_and(|value| value >= SUNSET_YAVG_AUXILIARY) {
                0.86
            } else {
                0.76
            },
        )
    } else if (story.chapter_count > 0 && story.chapter_index == 0)
        || hour.is_some_and(|hour| (6..=9).contains(&hour))
    {
        ("出发", 0.83)
    } else if subject == Some("交通")
        || (story.chapter_count > 0 && story.chapter_index * 4 <= story.chapter_count)
    {
        ("路上", 0.76)
    } else if story.chapter_count > 0 && story.clip_index == 0 {
        ("到达", 0.72)
    } else if matches!(person_state, Some("互动" | "操作" | "吃喝")) {
        ("活动", 0.73)
    } else {
        ("探索", 0.64)
    };
    ClipDimension {
        clip_id: source.clip_id,
        dimension: "time_stage".to_owned(),
        label: label.to_owned(),
        score,
        source: "time_rules/v1:chapter+recorded_hour+subject+yavg".to_owned(),
    }
}

fn captured_hour(value: &str) -> Option<u8> {
    let time = value.split_once('T')?.1;
    time.get(0..2)?.parse::<u8>().ok().filter(|hour| *hour < 24)
}

fn transcript_coverage(connection: &Connection, source: &DimensionSource) -> Result<f64> {
    if source.duration_ticks <= 0 || source.tb_num <= 0 || source.tb_den <= 0 {
        return Ok(0.0);
    }
    let mut statement = connection.prepare(
        "SELECT start_ticks, end_ticks FROM transcript_segments
         WHERE clip_id = ?1 ORDER BY start_ticks, end_ticks",
    )?;
    let rows = statement.query_map([source.clip_id], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut covered = 0_i64;
    let mut current: Option<(i64, i64)> = None;
    for row in rows {
        let (start, end) = row?;
        let start = start.clamp(0, source.duration_ticks);
        let end = end.clamp(start, source.duration_ticks);
        current = match current {
            None => Some((start, end)),
            Some((current_start, current_end)) if start <= current_end => {
                Some((current_start, current_end.max(end)))
            }
            Some((current_start, current_end)) => {
                covered += current_end - current_start;
                Some((start, end))
            }
        };
    }
    if let Some((start, end)) = current {
        covered += end - start;
    }
    Ok((covered as f64 / source.duration_ticks as f64).clamp(0.0, 1.0))
}

fn sound_dimension(source: &DimensionSource, transcript_coverage: f64) -> ClipDimension {
    let (label, score) = match source.has_audio {
        Some(false) => ("silent", 1.0),
        Some(true) if transcript_coverage > TALKING_COVERAGE_THRESHOLD => {
            ("Talking", transcript_coverage.clamp(0.0, 1.0))
        }
        Some(true) => match source.audio_dynamic_range_db {
            Some(value) if value >= ACTION_DYNAMIC_RANGE_DB => (
                "动作声",
                (0.55 + (value - ACTION_DYNAMIC_RANGE_DB).min(20.0) / 50.0).clamp(0.0, 1.0),
            ),
            Some(value) => (
                "环境声",
                (0.72 - value / 100.0).clamp(0.0, 1.0),
            ),
            None => ("不确定", 0.0),
        },
        None => ("不确定", 0.0),
    };
    ClipDimension {
        clip_id: source.clip_id,
        dimension: "sound".to_owned(),
        label: label.to_owned(),
        score: score as f32,
        source: "audio_rules/v1:transcript_coverage+astats_dynamic_range".to_owned(),
    }
}

fn persist_dimensions(
    connection: &mut Connection,
    job: &Job,
    payload: &ClassifyDimensionsPayload,
    dimensions: &[ClipDimension],
) -> Result<()> {
    let keys = dimensions
        .iter()
        .map(|item| item.dimension.as_str())
        .collect::<BTreeSet<_>>();
    if keys.len() != EXPECTED_DIMENSIONS.len()
        || EXPECTED_DIMENSIONS.iter().any(|dimension| !keys.contains(dimension))
    {
        return Err(CoreError::ClipDimensions(
            "分类结果未完整覆盖八个维度".to_owned(),
        ));
    }
    if dimensions.iter().any(|item| !item.score.is_finite()) {
        return Err(CoreError::ClipDimensions("分类结果包含非有限分数".to_owned()));
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = transaction.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM jobs j JOIN clips c
           WHERE j.id = ?1 AND j.status = 'running' AND j.attempt = ?2
             AND c.id = ?3 AND c.quick_hash = ?4
         )",
        params![job.id, job.attempt, payload.clip_id, payload.source_hash],
        |row| row.get::<_, bool>(0),
    )?;
    if !current {
        return Err(CoreError::InvalidTransition(format!(
            "classify_dims job {} attempt {} changed before dimension write",
            job.id, job.attempt
        )));
    }
    for item in dimensions {
        transaction.execute(
            "INSERT INTO clip_dimensions(clip_id, dimension, label, score, source)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(clip_id, dimension) DO UPDATE SET
               label = excluded.label,
               score = excluded.score,
               source = excluded.source
             WHERE clip_dimensions.source <> 'user'",
            params![item.clip_id, item.dimension, item.label, item.score, item.source],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn dimension_order(dimension: &str) -> usize {
    EXPECTED_DIMENSIONS
        .iter()
        .position(|candidate| *candidate == dimension)
        .unwrap_or(usize::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, jobs::JobStatus, test_support::TestDirectory};

    fn source() -> DimensionSource {
        DimensionSource {
            clip_id: 1,
            captured_at: Some("2026-09-01T12:30:00-04:00".to_owned()),
            chapter_id: None,
            duration_ticks: 1_000,
            tb_num: 1,
            tb_den: 1_000,
            exposure_yavg: Some(100.0),
            has_audio: Some(true),
            audio_dynamic_range_db: Some(8.0),
            motion: None,
        }
    }

    #[test]
    fn prototypes_use_d3_eight_function_classes() {
        let config = prototype_config().unwrap();
        let functions = config.dimensions["function"].keys().cloned().collect::<BTreeSet<_>>();
        assert_eq!(
            functions,
            [
                "Atmosphere", "Detail", "Establishing", "Experience", "Human-Reaction",
                "Information", "Orientation", "Transition"
            ]
            .into_iter()
            .map(str::to_owned)
            .collect()
        );
    }

    #[test]
    fn low_clip_confidence_is_stored_as_uncertain_with_raw_score() {
        let labels = BTreeMap::from([
            ("人".to_owned(), vec!["人物".to_owned()]),
            ("风景".to_owned(), vec!["风景".to_owned()]),
            ("建筑".to_owned(), vec!["建筑".to_owned()]),
        ]);
        let scores = BTreeMap::from([
            ("subject::人".to_owned(), 0.21),
            ("subject::风景".to_owned(), 0.20),
            ("subject::建筑".to_owned(), 0.10),
        ]);
        let result = classified_dimension(1, "subject", &labels, &scores).unwrap();
        assert_eq!(result.label, "不确定");
        assert_eq!(result.score, 0.21);
    }

    #[test]
    fn motion_rules_keep_c6_classes_explainable() {
        let motion = MotionEvidence {
            class: "pan".to_owned(),
            pan_ratio: 0.91,
            tilt_ratio: 0.1,
            zoom_corr: 0.0,
            shake_score: 0.4,
            mean_magnitude: None,
            residual_rms: None,
            direction_coherence: None,
        };
        let result = movement_dimension(1, Some(&motion));
        assert_eq!((result.label.as_str(), result.score), ("Pan", 0.91));
    }

    #[test]
    fn handheld_is_split_at_follow_shake_threshold() {
        let mut motion = MotionEvidence {
            class: "handheld".to_owned(),
            pan_ratio: 0.4,
            tilt_ratio: 0.4,
            zoom_corr: 0.0,
            shake_score: FOLLOW_SHAKE_THRESHOLD - 0.01,
            mean_magnitude: None,
            residual_rms: None,
            direction_coherence: None,
        };
        assert_eq!(movement_dimension(1, Some(&motion)).label, "handheld_follow");
        motion.shake_score = FOLLOW_SHAKE_THRESHOLD;
        assert_eq!(movement_dimension(1, Some(&motion)).label, "handheld_shaky");
    }

    #[test]
    fn fresh_handheld_follow_requires_displacement_residual_and_direction() {
        let mut motion = MotionEvidence {
            class: "handheld".to_owned(),
            pan_ratio: 0.4,
            tilt_ratio: 0.4,
            zoom_corr: 0.0,
            shake_score: 0.8,
            mean_magnitude: Some(FOLLOW_GLOBAL_DISPLACEMENT),
            residual_rms: Some(FOLLOW_RESIDUAL_RMS),
            direction_coherence: Some(FOLLOW_DIRECTION_COHERENCE),
        };
        assert_eq!(movement_dimension(1, Some(&motion)).label, "handheld_follow");
        motion.residual_rms = Some(FOLLOW_RESIDUAL_RMS + 0.01);
        assert_eq!(movement_dimension(1, Some(&motion)).label, "handheld_shaky");
    }

    #[test]
    fn recorded_hour_keeps_rule_boundaries_explicit() {
        assert_eq!(captured_hour("2026-09-01T06:00:00-04:00"), Some(6));
        assert_eq!(captured_hour("2026-09-01T19:59:59Z"), Some(19));
        assert_eq!(captured_hour("not-a-time"), None);
    }

    #[test]
    fn food_during_meal_window_strengthens_meal_stage() {
        let result = time_dimension(
            &source(),
            StoryPosition { chapter_index: 2, chapter_count: 5, clip_index: 3 },
            Some("食物"),
            None,
        );
        assert_eq!((result.label.as_str(), result.score), ("吃饭", 0.92));
    }

    #[test]
    fn meal_window_includes_11_and_14_but_not_10_or_15() {
        for (hour, expected) in [(10, "探索"), (11, "吃饭"), (14, "吃饭"), (15, "探索")] {
            let mut input = source();
            input.captured_at = Some(format!("2026-09-01T{hour:02}:00:00-04:00"));
            let result = time_dimension(&input, StoryPosition::default(), Some("食物"), None);
            assert_eq!(result.label, expected, "hour={hour}");
        }
    }

    #[test]
    fn final_chapter_wins_as_return_stage() {
        let result = time_dimension(
            &source(),
            StoryPosition { chapter_index: 4, chapter_count: 5, clip_index: 0 },
            Some("食物"),
            Some("吃喝"),
        );
        assert_eq!(result.label, "返回");
    }

    #[test]
    fn sound_rules_cover_silent_talking_ambient_and_action() {
        let mut input = source();
        input.has_audio = Some(false);
        assert_eq!(sound_dimension(&input, 0.0).label, "silent");
        input.has_audio = Some(true);
        assert_eq!(sound_dimension(&input, 0.41).label, "Talking");
        input.audio_dynamic_range_db = Some(ACTION_DYNAMIC_RANGE_DB - 0.01);
        assert_eq!(sound_dimension(&input, 0.4).label, "环境声");
        input.audio_dynamic_range_db = Some(ACTION_DYNAMIC_RANGE_DB);
        assert_eq!(sound_dimension(&input, 0.0).label, "动作声");
    }

    #[test]
    fn transcript_coverage_merges_overlapping_segments() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('v')", []).unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path) VALUES (1, 'v', 'a.mov')",
                [],
            )
            .unwrap();
        for (index, start, end) in [(0, 0, 300), (1, 200, 500), (2, 800, 900)] {
            connection
                .execute(
                    "INSERT INTO transcript_segments(clip_id, seg_index, start_ticks, end_ticks, text)
                     VALUES (1, ?1, ?2, ?3, 'x')",
                    params![index, start, end],
                )
                .unwrap();
        }
        assert!((transcript_coverage(&connection, &source()).unwrap() - 0.6).abs() < 1e-9);
    }

    #[test]
    fn persistence_is_idempotent_and_preserves_user_override() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('v')", []).unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, quick_hash)
                 VALUES (1, 'v', 'a.mov', 'hash')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO jobs(kind, payload, payload_hash, status, attempt, created_at, updated_at)
                 VALUES ('classify_dims', '{}', 'job', 'running', 1, 'now', 'now')",
                [],
            )
            .unwrap();
        let job = Job {
            id: connection.last_insert_rowid(),
            kind: "classify_dims".to_owned(),
            payload: "{}".to_owned(),
            status: JobStatus::Running,
            attempt: 1,
            blocked_summary: None,
            result_path: None,
        };
        let payload = ClassifyDimensionsPayload {
            clip_id: 1,
            source_hash: "hash".to_owned(),
            image_path: "/tmp/cover.jpg".to_owned(),
            prototypes_version: "test".to_owned(),
        };
        let dimensions = EXPECTED_DIMENSIONS
            .iter()
            .map(|dimension| ClipDimension {
                clip_id: 1,
                dimension: (*dimension).to_owned(),
                label: "自动".to_owned(),
                score: 0.8,
                source: "test".to_owned(),
            })
            .collect::<Vec<_>>();
        persist_dimensions(&mut connection, &job, &payload, &dimensions).unwrap();
        connection
            .execute(
                "UPDATE clip_dimensions SET label = '人工', source = 'user'
                 WHERE clip_id = 1 AND dimension = 'time_stage'",
                [],
            )
            .unwrap();
        persist_dimensions(&mut connection, &job, &payload, &dimensions).unwrap();
        let result: (i64, String) = connection
            .query_row(
                "SELECT COUNT(*), MAX(CASE WHEN dimension = 'time_stage' THEN label END)
                 FROM clip_dimensions WHERE clip_id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(result, (8, "人工".to_owned()));
    }
}
