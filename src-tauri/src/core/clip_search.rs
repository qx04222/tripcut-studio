use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::error::{CoreError, Result};
use super::jobs::Job;
use super::sidecar::{self, EMBEDDING_DIMENSIONS, MODEL_NAME};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClipSearchHit {
    pub clip_id: i64,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ClipEmbedPayload {
    clip_id: i64,
    source_hash: String,
    strip_path: String,
    strip_frame_count: usize,
    model: String,
}

pub fn enqueue_for_clip(
    connection: &mut Connection,
    clip_id: i64,
    source_hash: &str,
    strip_path: &Path,
    strip_frame_count: usize,
) -> Result<Option<i64>> {
    if !(1..=12).contains(&strip_frame_count) {
        return Err(CoreError::ClipSearch(format!(
            "素材 {clip_id} 的胶片条帧数 {strip_frame_count} 无效"
        )));
    }
    let payload = ClipEmbedPayload {
        clip_id,
        source_hash: source_hash.to_owned(),
        strip_path: strip_path.to_string_lossy().into_owned(),
        strip_frame_count,
        model: MODEL_NAME.to_owned(),
    };
    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| CoreError::ClipSearch(format!("无法创建 CLIP 嵌入任务：{error}")))?;
    let payload_hash = blake3::hash(
        format!("clip_embed\0{clip_id}\0{source_hash}\0{MODEL_NAME}").as_bytes(),
    )
    .to_hex()
    .to_string();

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let already_embedded = transaction.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM clip_embeddings
            WHERE clip_id = ?1 AND source_hash = ?2 AND model = ?3
         )",
        params![clip_id, source_hash, MODEL_NAME],
        |row| row.get::<_, bool>(0),
    )?;
    let existing_job = transaction
        .query_row(
            "SELECT id, status FROM jobs
             WHERE kind = 'clip_embed' AND payload_hash = ?1
             ORDER BY id DESC LIMIT 1",
            [&payload_hash],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if already_embedded {
        transaction.commit()?;
        return Ok(None);
    }
    if let Some((job_id, status)) = existing_job {
        if matches!(status.as_str(), "failed" | "blocked" | "done") {
            transaction.execute(
                "UPDATE jobs
                 SET status = 'pending', attempt = 0, blocked_summary = NULL,
                     result_path = NULL, finished_at = NULL,
                     next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ?1",
                [job_id],
            )?;
            transaction.commit()?;
            return Ok(Some(job_id));
        }
        transaction.commit()?;
        return Ok(None);
    }
    transaction.execute(
        "INSERT INTO jobs(
            kind, payload, payload_hash, status, attempt,
            next_attempt_at, created_at, updated_at
         ) VALUES (
            'clip_embed', ?1, ?2, 'pending', 0,
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

pub fn enqueue_missing(connection: &mut Connection, cache_root: &Path) -> Result<usize> {
    let candidates = {
        let mut statement = connection.prepare(
            "SELECT c.id, c.quick_hash, c.duration_ticks, c.tb_num, c.tb_den, a.rel_path
             FROM clips c
             JOIN cache_artifacts a
               ON a.clip_id = c.id AND a.kind = 'strip' AND a.source_hash = c.quick_hash
             LEFT JOIN clip_embeddings e
               ON e.clip_id = c.id AND e.source_hash = c.quick_hash AND e.model = ?1
             WHERE c.quick_hash IS NOT NULL AND e.clip_id IS NULL
             ORDER BY c.id",
        )?;
        let rows = statement.query_map([MODEL_NAME], |row| {
            let duration_ticks = row.get::<_, i64>(2)?;
            let tb_num = row.get::<_, i64>(3)?;
            let tb_den = row.get::<_, i64>(4)?;
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                strip_frame_count(duration_ticks, tb_num, tb_den),
                row.get::<_, String>(5)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut enqueued = 0;
    for (clip_id, source_hash, frame_count, relative_path) in candidates {
        let strip_path = cache_root.join(relative_path);
        if strip_path.is_file()
            && enqueue_for_clip(
                connection,
                clip_id,
                &source_hash,
                &strip_path,
                frame_count,
            )?
            .is_some()
        {
            enqueued += 1;
        }
    }
    Ok(enqueued)
}

pub fn run_clip_embed(connection: &mut Connection, job: &Job) -> Result<()> {
    let payload: ClipEmbedPayload = serde_json::from_str(&job.payload)
        .map_err(|error| CoreError::ClipSearch(format!("CLIP 嵌入任务数据无效：{error}")))?;
    if payload.model != MODEL_NAME {
        return Err(CoreError::ClipSearch(format!(
            "CLIP 嵌入任务模型 {} 与当前模型 {MODEL_NAME} 不一致",
            payload.model
        )));
    }
    if !(1..=12).contains(&payload.strip_frame_count) {
        return Err(CoreError::ClipSearch(format!(
            "素材 {} 的胶片条帧数无效",
            payload.clip_id
        )));
    }
    let is_current = connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM jobs j JOIN clips c
            WHERE j.id = ?1 AND j.status = 'running' AND j.attempt = ?2
              AND c.id = ?3 AND c.quick_hash = ?4
         )",
        params![job.id, job.attempt, payload.clip_id, payload.source_hash],
        |row| row.get::<_, bool>(0),
    )?;
    if !is_current {
        return Err(CoreError::ClipSearch(format!(
            "素材 {} 已变化或 clip_embed attempt 已过期",
            payload.clip_id
        )));
    }

    let strip_path = PathBuf::from(&payload.strip_path);
    if !strip_path.is_file() {
        return Err(CoreError::ClipSearch(format!(
            "素材 {} 缺少胶片条：{}",
            payload.clip_id,
            strip_path.display()
        )));
    }
    let frame_embeddings = sidecar::embed_images(&strip_path, payload.strip_frame_count)?;
    let embedding = mean_normalized_embedding(&frame_embeddings)?;
    store_embedding(connection, job, &payload, &embedding)
}

pub fn search_clips(connection: &Connection, query: &str) -> Result<Vec<ClipSearchHit>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let query_embedding = sidecar::embed_text(query)?;
    let threshold = super::settings::number_value(
        connection,
        super::settings::SIMILARITY_THRESHOLD_KEY,
        super::settings::DEFAULT_SIMILARITY_THRESHOLD,
    )?
    .clamp(0.0, 1.0) as f32;
    let mut hits = search_by_embedding(connection, &query_embedding)?;
    hits.retain(|hit| hit.score >= threshold);
    Ok(hits)
}

fn store_embedding(
    connection: &mut Connection,
    job: &Job,
    payload: &ClipEmbedPayload,
    embedding: &[f32],
) -> Result<()> {
    let blob = encode_embedding(embedding)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed = transaction.execute(
        "INSERT INTO clip_embeddings(
            clip_id, embedding, dimensions, source_hash, model, embedded_at
         )
         SELECT ?3, ?5, ?6, ?4, ?7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         FROM jobs j JOIN clips c
         WHERE j.id = ?1 AND j.status = 'running' AND j.attempt = ?2
           AND c.id = ?3 AND c.quick_hash = ?4
         ON CONFLICT(clip_id) DO UPDATE SET
            embedding = excluded.embedding,
            dimensions = excluded.dimensions,
            source_hash = excluded.source_hash,
            model = excluded.model,
            embedded_at = excluded.embedded_at",
        params![
            job.id,
            job.attempt,
            payload.clip_id,
            payload.source_hash,
            blob,
            EMBEDDING_DIMENSIONS as i64,
            MODEL_NAME,
        ],
    )?;
    if changed != 1 {
        return Err(CoreError::InvalidTransition(format!(
            "clip_embed job {} attempt {} changed before embedding write",
            job.id, job.attempt
        )));
    }
    transaction.commit()?;
    Ok(())
}

fn search_by_embedding(
    connection: &Connection,
    query_embedding: &[f32],
) -> Result<Vec<ClipSearchHit>> {
    validate_embedding(query_embedding)?;
    let mut statement = connection.prepare(
        "SELECT e.clip_id, e.embedding
         FROM clip_embeddings e
         JOIN clips c ON c.id = e.clip_id AND c.quick_hash = e.source_hash
         WHERE e.dimensions = ?1 AND e.model = ?2",
    )?;
    let rows = statement.query_map(params![EMBEDDING_DIMENSIONS as i64, MODEL_NAME], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;

    let mut hits = Vec::new();
    for row in rows {
        let (clip_id, blob) = row?;
        let embedding = decode_embedding(&blob)?;
        if let Some(score) = cosine_similarity(query_embedding, &embedding) {
            hits.push(ClipSearchHit { clip_id, score });
        }
    }
    hits.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.clip_id.cmp(&right.clip_id))
    });
    Ok(hits)
}

fn mean_normalized_embedding(rows: &[Vec<f32>]) -> Result<Vec<f32>> {
    if rows.is_empty() {
        return Err(CoreError::ClipSearch("sidecar 未返回任何帧嵌入".to_owned()));
    }
    let mut mean = vec![0.0_f64; EMBEDDING_DIMENSIONS];
    for row in rows {
        validate_embedding(row)?;
        for (target, value) in mean.iter_mut().zip(row) {
            *target += f64::from(*value);
        }
    }
    let scale = 1.0 / rows.len() as f64;
    for value in &mut mean {
        *value *= scale;
    }
    let norm = mean.iter().map(|value| value * value).sum::<f64>().sqrt();
    if !norm.is_finite() || norm <= f64::EPSILON {
        return Err(CoreError::ClipSearch("帧均值嵌入无法归一化".to_owned()));
    }
    Ok(mean.into_iter().map(|value| (value / norm) as f32).collect())
}

fn encode_embedding(embedding: &[f32]) -> Result<Vec<u8>> {
    validate_embedding(embedding)?;
    let mut blob = Vec::with_capacity(EMBEDDING_DIMENSIONS * std::mem::size_of::<f32>());
    for value in embedding {
        blob.extend_from_slice(&value.to_le_bytes());
    }
    Ok(blob)
}

pub(super) fn decode_embedding(blob: &[u8]) -> Result<Vec<f32>> {
    let expected = EMBEDDING_DIMENSIONS * std::mem::size_of::<f32>();
    if blob.len() != expected {
        return Err(CoreError::ClipSearch(format!(
            "数据库嵌入 BLOB 为 {} 字节，预期 {expected}",
            blob.len()
        )));
    }
    let embedding = blob
        .as_chunks::<4>()
        .0
        .iter()
        .map(|bytes| f32::from_le_bytes(*bytes))
        .collect::<Vec<_>>();
    validate_embedding(&embedding)?;
    Ok(embedding)
}

fn validate_embedding(embedding: &[f32]) -> Result<()> {
    if embedding.len() != EMBEDDING_DIMENSIONS {
        return Err(CoreError::ClipSearch(format!(
            "嵌入维数为 {}，预期 {EMBEDDING_DIMENSIONS}",
            embedding.len()
        )));
    }
    if embedding.iter().any(|value| !value.is_finite()) {
        return Err(CoreError::ClipSearch("嵌入包含非有限数值".to_owned()));
    }
    Ok(())
}

pub(super) fn cosine_similarity(left: &[f32], right: &[f32]) -> Option<f32> {
    if left.len() != right.len() || left.is_empty() {
        return None;
    }
    let mut dot = 0.0_f64;
    let mut left_norm = 0.0_f64;
    let mut right_norm = 0.0_f64;
    for (left, right) in left.iter().zip(right) {
        let left = f64::from(*left);
        let right = f64::from(*right);
        dot += left * right;
        left_norm += left * left;
        right_norm += right * right;
    }
    let denominator = left_norm.sqrt() * right_norm.sqrt();
    (denominator.is_finite() && denominator > f64::EPSILON)
        .then_some((dot / denominator) as f32)
        .filter(|score| score.is_finite())
}

fn strip_frame_count(duration_ticks: i64, tb_num: i64, tb_den: i64) -> usize {
    if duration_ticks <= 0 || tb_num <= 0 || tb_den <= 0 {
        return 1;
    }
    let seconds = duration_ticks as f64 * tb_num as f64 / tb_den as f64;
    ((seconds.max(0.0) / 5.0).ceil() as usize).clamp(1, 12)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::db;
    use crate::core::jobs::JobStatus;
    use crate::core::test_support::TestDirectory;

    fn axis(index: usize) -> Vec<f32> {
        let mut vector = vec![0.0; EMBEDDING_DIMENSIONS];
        vector[index] = 1.0;
        vector
    }

    fn seed_job(connection: &Connection, clip_id: i64, source_hash: &str) -> Job {
        connection
            .execute("INSERT OR IGNORE INTO volumes(uuid) VALUES ('volume')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, quick_hash)
                 VALUES (?1, 'volume', ?2, ?3)",
                params![clip_id, format!("{clip_id}.mov"), source_hash],
            )
            .unwrap();
        let payload = ClipEmbedPayload {
            clip_id,
            source_hash: source_hash.to_owned(),
            strip_path: format!("/tmp/{clip_id}/strip.jpg"),
            strip_frame_count: 1,
            model: MODEL_NAME.to_owned(),
        };
        connection
            .execute(
                "INSERT INTO jobs(kind, payload, payload_hash, status, attempt, created_at, updated_at)
                 VALUES ('clip_embed', ?1, ?2, 'running', 1, 'now', 'now')",
                params![serde_json::to_string(&payload).unwrap(), format!("job-{clip_id}")],
            )
            .unwrap();
        Job {
            id: connection.last_insert_rowid(),
            kind: "clip_embed".to_owned(),
            payload: serde_json::to_string(&payload).unwrap(),
            status: JobStatus::Running,
            attempt: 1,
            blocked_summary: None,
            result_path: None,
        }
    }

    #[test]
    fn embedding_blob_round_trips_exactly() {
        let vector = (0..EMBEDDING_DIMENSIONS)
            .map(|index| index as f32 / EMBEDDING_DIMENSIONS as f32)
            .collect::<Vec<_>>();
        assert_eq!(decode_embedding(&encode_embedding(&vector).unwrap()).unwrap(), vector);
    }

    #[test]
    fn malformed_embedding_blob_is_rejected() {
        assert!(decode_embedding(&[0; 17]).is_err());
    }

    #[test]
    fn cosine_uses_direction_not_magnitude() {
        let first = axis(0);
        let mut scaled = axis(0);
        scaled[0] = 42.0;
        assert!((cosine_similarity(&first, &scaled).unwrap() - 1.0).abs() < 1e-6);
        assert_eq!(cosine_similarity(&first, &axis(1)).unwrap(), 0.0);
    }

    #[test]
    fn zero_vector_has_no_cosine_score() {
        assert_eq!(cosine_similarity(&vec![0.0; EMBEDDING_DIMENSIONS], &axis(0)), None);
    }

    #[test]
    fn embedding_upsert_is_idempotent() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let job = seed_job(&connection, 1, "source-a");
        let payload: ClipEmbedPayload = serde_json::from_str(&job.payload).unwrap();
        store_embedding(&mut connection, &job, &payload, &axis(0)).unwrap();
        store_embedding(&mut connection, &job, &payload, &axis(1)).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM clip_embeddings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let blob: Vec<u8> = connection
            .query_row("SELECT embedding FROM clip_embeddings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(decode_embedding(&blob).unwrap(), axis(1));
    }

    #[test]
    fn stale_source_cannot_overwrite_embedding() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let job = seed_job(&connection, 1, "source-a");
        let payload: ClipEmbedPayload = serde_json::from_str(&job.payload).unwrap();
        connection
            .execute("UPDATE clips SET quick_hash = 'source-b' WHERE id = 1", [])
            .unwrap();
        assert!(store_embedding(&mut connection, &job, &payload, &axis(0)).is_err());
    }

    #[test]
    fn blob_fallback_sorts_by_cosine_and_excludes_stale_rows() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        for (clip_id, source_hash, vector) in [
            (1, "a", axis(0)),
            (2, "b", axis(1)),
            (3, "c", axis(0)),
        ] {
            let job = seed_job(&connection, clip_id, source_hash);
            let payload: ClipEmbedPayload = serde_json::from_str(&job.payload).unwrap();
            store_embedding(&mut connection, &job, &payload, &vector).unwrap();
        }
        connection
            .execute("UPDATE clips SET quick_hash = 'changed' WHERE id = 3", [])
            .unwrap();
        let hits = search_by_embedding(&connection, &axis(0)).unwrap();
        assert_eq!(hits.iter().map(|hit| hit.clip_id).collect::<Vec<_>>(), vec![1, 2]);
        assert!(hits[0].score > hits[1].score);
    }

    #[test]
    fn enqueue_is_idempotent_for_model_and_source() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let _job = seed_job(&connection, 1, "source-a");
        connection.execute("DELETE FROM jobs", []).unwrap();
        let strip = directory.path().join("strip.jpg");
        assert!(enqueue_for_clip(&mut connection, 1, "source-a", &strip, 6)
            .unwrap()
            .is_some());
        assert!(enqueue_for_clip(&mut connection, 1, "source-a", &strip, 6)
            .unwrap()
            .is_none());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM jobs WHERE kind = 'clip_embed'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn startup_backfill_requeues_a_blocked_embedding_after_setup() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let _job = seed_job(&connection, 1, "source-a");
        connection.execute("DELETE FROM jobs", []).unwrap();
        let strip = directory.path().join("strip.jpg");
        let job_id = enqueue_for_clip(&mut connection, 1, "source-a", &strip, 1)
            .unwrap()
            .unwrap();
        connection
            .execute(
                "UPDATE jobs SET status = 'blocked', attempt = 3,
                 blocked_summary = 'sidecar missing' WHERE id = ?1",
                [job_id],
            )
            .unwrap();
        assert_eq!(
            enqueue_for_clip(&mut connection, 1, "source-a", &strip, 1).unwrap(),
            Some(job_id)
        );
        let state: (String, i64, Option<String>) = connection
            .query_row(
                "SELECT status, attempt, blocked_summary FROM jobs WHERE id = ?1",
                [job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(state, ("pending".to_owned(), 0, None));
    }
}
