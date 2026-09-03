use std::collections::{BTreeMap, HashMap};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::analysis::{
    DARK_YAVG_THRESHOLD, OVEREXPOSED_RATIO_THRESHOLD, SOFT_FOCUS_THRESHOLD,
};
use super::clip_search::{cosine_similarity, decode_embedding};
use super::error::{CoreError, Result};
use super::jobs::Job;
use super::sidecar::{EMBEDDING_DIMENSIONS, MODEL_NAME};

// 待 97 条真机变体素材校准；当前先采用任务卡指定的纯视觉余弦阈值。
pub const SIM_THRESHOLD: f32 = 0.90;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SimilarGroup {
    pub id: i64,
    pub min_similarity: f32,
    pub members: Vec<SimilarGroupMember>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SimilarGroupMember {
    pub clip_id: i64,
    pub is_primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SimilarClusterPayload {
    embedding_fingerprint: String,
    embedding_count: usize,
    model: String,
}

#[derive(Debug, Clone)]
struct EmbeddedClip {
    clip_id: i64,
    source_hash: String,
    embedding: Vec<f32>,
    primary_rank: PrimaryRank,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PrimaryRank {
    star_rating: i64,
    l1_badge_count: usize,
    captured_at: Option<String>,
    clip_id: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Cluster {
    member_indices: Vec<usize>,
    primary_index: usize,
}

pub fn enqueue_if_ready(connection: &mut Connection) -> Result<Option<i64>> {
    let active_embeddings: i64 = connection.query_row(
        "SELECT COUNT(*) FROM jobs
         WHERE kind = 'clip_embed' AND status IN ('pending', 'running')",
        [],
        |row| row.get(0),
    )?;
    if active_embeddings > 0 {
        return Ok(None);
    }

    let embedded = load_current_embeddings(connection)?;
    if embedded.is_empty() {
        let persisted_groups: i64 = connection.query_row(
            "SELECT COUNT(*) FROM similar_groups",
            [],
            |row| row.get(0),
        )?;
        if persisted_groups == 0 {
            return Ok(None);
        }
    }
    let fingerprint = embedding_fingerprint(&embedded);
    let payload = SimilarClusterPayload {
        embedding_fingerprint: fingerprint.clone(),
        embedding_count: embedded.len(),
        model: MODEL_NAME.to_owned(),
    };
    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| CoreError::Similar(format!("无法创建相似镜头任务：{error}")))?;
    let payload_hash = blake3::hash(format!("similar_cluster\0{fingerprint}").as_bytes())
        .to_hex()
        .to_string();

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let same_job = transaction
        .query_row(
            "SELECT id, status FROM jobs
             WHERE kind = 'similar_cluster' AND payload_hash = ?1
             ORDER BY id DESC LIMIT 1",
            [&payload_hash],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if let Some((job_id, status)) = same_job {
        if matches!(status.as_str(), "failed" | "blocked") {
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
        transaction.commit()?;
        return Ok(None);
    }

    let replaceable_pending = transaction
        .query_row(
            "SELECT id FROM jobs
             WHERE kind = 'similar_cluster' AND status = 'pending'
             ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if let Some(job_id) = replaceable_pending {
        transaction.execute(
            "UPDATE jobs
             SET payload = ?2, payload_hash = ?3, attempt = 0,
                 blocked_summary = NULL, result_path = NULL, finished_at = NULL,
                 next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1 AND status = 'pending'",
            params![job_id, payload_json, payload_hash],
        )?;
        transaction.commit()?;
        return Ok(Some(job_id));
    }

    transaction.execute(
        "INSERT INTO jobs(
            kind, payload, payload_hash, status, attempt,
            next_attempt_at, created_at, updated_at
         ) VALUES (
            'similar_cluster', ?1, ?2, 'pending', 0,
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

pub fn run_similar_cluster(connection: &mut Connection, job: &Job) -> Result<()> {
    let payload: SimilarClusterPayload = serde_json::from_str(&job.payload)
        .map_err(|error| CoreError::Similar(format!("相似镜头任务数据无效：{error}")))?;
    if payload.model != MODEL_NAME {
        return Err(CoreError::Similar(format!(
            "相似镜头任务模型 {} 与当前模型 {MODEL_NAME} 不一致",
            payload.model
        )));
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let is_current_attempt = transaction.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM jobs
            WHERE id = ?1 AND status = 'running' AND attempt = ?2
         )",
        params![job.id, job.attempt],
        |row| row.get::<_, bool>(0),
    )?;
    if !is_current_attempt {
        return Err(CoreError::InvalidTransition(format!(
            "similar_cluster job {} attempt {} is no longer running",
            job.id, job.attempt
        )));
    }

    let embedded = load_current_embeddings(&transaction)?;
    let current_fingerprint = embedding_fingerprint(&embedded);
    if current_fingerprint != payload.embedding_fingerprint
        || embedded.len() != payload.embedding_count
    {
        // 新嵌入完成时会按新指纹排队；旧 attempt 不得覆盖更新后的分组。
        transaction.commit()?;
        return Ok(());
    }

    let clusters = cluster_embeddings(&embedded);
    transaction.execute("DELETE FROM similar_groups", [])?;
    for cluster in clusters {
        transaction.execute(
            "INSERT INTO similar_groups(created_at)
             VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            [],
        )?;
        let group_id = transaction.last_insert_rowid();
        for member_index in cluster.member_indices {
            transaction.execute(
                "INSERT INTO similar_group_members(group_id, clip_id, is_primary)
                 VALUES (?1, ?2, ?3)",
                params![
                    group_id,
                    embedded[member_index].clip_id,
                    if member_index == cluster.primary_index { 1 } else { 0 },
                ],
            )?;
        }
    }
    transaction.commit()?;
    Ok(())
}

/// C4 视觉近似结果的诊断读取口。P3-D4 起它只供 Shot Stack 聚合使用，
/// 不再代表 UI 容器，也不能单独决定折叠或淘汰。
pub fn similar_groups(connection: &Connection) -> Result<Vec<SimilarGroup>> {
    let embedded = load_current_embeddings(connection)?;
    let embedding_by_clip = embedded
        .into_iter()
        .map(|clip| (clip.clip_id, clip.embedding))
        .collect::<HashMap<_, _>>();
    let mut statement = connection.prepare(
        "SELECT g.id, m.clip_id, m.is_primary
         FROM similar_groups g
         JOIN similar_group_members m ON m.group_id = g.id
         ORDER BY g.id, m.is_primary DESC, m.clip_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)? == 1,
        ))
    })?;
    let mut grouped = BTreeMap::<i64, Vec<SimilarGroupMember>>::new();
    for row in rows {
        let (group_id, clip_id, is_primary) = row?;
        if embedding_by_clip.contains_key(&clip_id) {
            grouped
                .entry(group_id)
                .or_default()
                .push(SimilarGroupMember { clip_id, is_primary });
        }
    }

    let mut result = Vec::new();
    for (id, members) in grouped {
        if members.len() < 2 {
            continue;
        }
        let mut minimum = 1.0_f32;
        for left in 0..members.len() {
            for right in (left + 1)..members.len() {
                let left_embedding = &embedding_by_clip[&members[left].clip_id];
                let right_embedding = &embedding_by_clip[&members[right].clip_id];
                let score = cosine_similarity(left_embedding, right_embedding).ok_or_else(|| {
                    CoreError::Similar(format!("相似组 {id} 包含不可比较的嵌入"))
                })?;
                minimum = minimum.min(score);
            }
        }
        result.push(SimilarGroup {
            id,
            min_similarity: minimum,
            members,
        });
    }
    Ok(result)
}

/// 保留旧项目的 C4 主代表元数据；新 UI 首选必须写 shot_stack_members.user_state。
pub fn set_primary(connection: &mut Connection, group_id: i64, clip_id: i64) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let is_member = transaction.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM similar_group_members
            WHERE group_id = ?1 AND clip_id = ?2
         )",
        params![group_id, clip_id],
        |row| row.get::<_, bool>(0),
    )?;
    if !is_member {
        return Err(CoreError::Similar(format!(
            "素材 {clip_id} 不属于相似组 {group_id}"
        )));
    }
    transaction.execute(
        "UPDATE similar_group_members SET is_primary = 0 WHERE group_id = ?1",
        [group_id],
    )?;
    let changed = transaction.execute(
        "UPDATE similar_group_members SET is_primary = 1
         WHERE group_id = ?1 AND clip_id = ?2",
        params![group_id, clip_id],
    )?;
    if changed != 1 {
        return Err(CoreError::Similar(format!(
            "无法把素材 {clip_id} 设为相似组 {group_id} 的主代表"
        )));
    }
    transaction.commit()?;
    Ok(())
}

fn load_current_embeddings(connection: &Connection) -> Result<Vec<EmbeddedClip>> {
    let mut statement = connection.prepare(
        "SELECT e.clip_id, e.source_hash, e.embedding, c.captured_at,
                COALESCE((
                    SELECT r.value FROM ratings r
                    JOIN segments s ON s.id = r.segment_id
                    WHERE s.clip_id = c.id AND r.rating_type = 'star'
                    ORDER BY r.id DESC LIMIT 1
                ), 0),
                a.exposure_yavg, a.overexposed_ratio, a.audio_clipped,
                a.has_audio, a.focus_scores,
                (
                    SELECT j.status FROM jobs j
                    WHERE j.kind = 'analyze_l1'
                      AND CAST(CASE WHEN json_valid(j.payload)
                           THEN json_extract(j.payload, '$.clip_id') END AS INTEGER) = c.id
                    ORDER BY j.id DESC LIMIT 1
                )
         FROM clip_embeddings e
         JOIN clips c ON c.id = e.clip_id AND c.quick_hash = e.source_hash
         LEFT JOIN clip_analysis a ON a.clip_id = c.id
         WHERE e.dimensions = ?1 AND e.model = ?2
         ORDER BY e.clip_id",
    )?;
    let rows = statement.query_map(params![EMBEDDING_DIMENSIONS as i64, MODEL_NAME], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Vec<u8>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, Option<f64>>(5)?,
            row.get::<_, Option<f64>>(6)?,
            row.get::<_, Option<i64>>(7)?,
            row.get::<_, Option<i64>>(8)?,
            row.get::<_, Option<String>>(9)?,
            row.get::<_, Option<String>>(10)?,
        ))
    })?;

    let mut result = Vec::new();
    for row in rows {
        let (
            clip_id,
            source_hash,
            blob,
            captured_at,
            star_rating,
            exposure_yavg,
            overexposed_ratio,
            audio_clipped,
            has_audio,
            focus_scores,
            analysis_status,
        ) = row?;
        let l1_badge_count = l1_badge_count(
            exposure_yavg,
            overexposed_ratio,
            audio_clipped,
            has_audio,
            focus_scores.as_deref(),
            analysis_status.as_deref(),
        )?;
        result.push(EmbeddedClip {
            clip_id,
            source_hash,
            embedding: decode_embedding(&blob)?,
            primary_rank: PrimaryRank {
                star_rating,
                l1_badge_count,
                captured_at,
                clip_id,
            },
        });
    }
    Ok(result)
}

fn l1_badge_count(
    exposure_yavg: Option<f64>,
    overexposed_ratio: Option<f64>,
    audio_clipped: Option<i64>,
    has_audio: Option<i64>,
    focus_scores: Option<&str>,
    analysis_status: Option<&str>,
) -> Result<usize> {
    if matches!(analysis_status, Some("failed" | "blocked")) {
        return Ok(1);
    }
    let Some(exposure_yavg) = exposure_yavg else {
        return Ok(0);
    };
    let focus_scores = focus_scores
        .map(|json| {
            serde_json::from_str::<Vec<f64>>(json).map_err(|error| {
                CoreError::Similar(format!("无法读取 L1 失焦分数组：{error}"))
            })
        })
        .transpose()?
        .unwrap_or_default();
    let focus_mean = (!focus_scores.is_empty()).then(|| {
        focus_scores.iter().sum::<f64>() / focus_scores.len() as f64
    });
    Ok(usize::from(exposure_yavg < DARK_YAVG_THRESHOLD)
        + usize::from(overexposed_ratio.is_some_and(|value| {
            value > OVEREXPOSED_RATIO_THRESHOLD
        }))
        + usize::from(audio_clipped == Some(1))
        + usize::from(has_audio == Some(0))
        + usize::from(focus_mean.is_some_and(|value| value < SOFT_FOCUS_THRESHOLD)))
}

fn embedding_fingerprint(embedded: &[EmbeddedClip]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"similar_cluster\0");
    hasher.update(MODEL_NAME.as_bytes());
    hasher.update(&(EMBEDDING_DIMENSIONS as u64).to_le_bytes());
    for clip in embedded {
        hasher.update(&clip.clip_id.to_le_bytes());
        hasher.update(&(clip.source_hash.len() as u64).to_le_bytes());
        hasher.update(clip.source_hash.as_bytes());
        for value in &clip.embedding {
            hasher.update(&value.to_le_bytes());
        }
    }
    hasher.finalize().to_hex().to_string()
}

fn cluster_embeddings(embedded: &[EmbeddedClip]) -> Vec<Cluster> {
    let mut parent = (0..embedded.len()).collect::<Vec<_>>();
    for left in 0..embedded.len() {
        for right in (left + 1)..embedded.len() {
            if cosine_similarity(&embedded[left].embedding, &embedded[right].embedding)
                .is_some_and(meets_similarity_threshold)
            {
                union(&mut parent, left, right);
            }
        }
    }

    let mut components = BTreeMap::<usize, Vec<usize>>::new();
    for index in 0..embedded.len() {
        let root = find(&mut parent, index);
        components.entry(root).or_default().push(index);
    }
    components
        .into_values()
        .filter(|members| members.len() >= 2)
        .map(|mut member_indices| {
            member_indices.sort_by_key(|index| embedded[*index].clip_id);
            let primary_index = *member_indices
                .iter()
                .min_by(|left, right| {
                    compare_primary(
                        &embedded[**left].primary_rank,
                        &embedded[**right].primary_rank,
                    )
                })
                .expect("a similarity cluster always has members");
            Cluster {
                member_indices,
                primary_index,
            }
        })
        .collect()
}

fn meets_similarity_threshold(score: f32) -> bool {
    score >= SIM_THRESHOLD
}

fn compare_primary(left: &PrimaryRank, right: &PrimaryRank) -> std::cmp::Ordering {
    right
        .star_rating
        .cmp(&left.star_rating)
        .then_with(|| left.l1_badge_count.cmp(&right.l1_badge_count))
        .then_with(|| compare_capture_time(&left.captured_at, &right.captured_at))
        .then_with(|| left.clip_id.cmp(&right.clip_id))
}

fn compare_capture_time(
    left: &Option<String>,
    right: &Option<String>,
) -> std::cmp::Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.cmp(right),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

fn find(parent: &mut [usize], index: usize) -> usize {
    if parent[index] != index {
        let parent_index = parent[index];
        parent[index] = find(parent, parent_index);
    }
    parent[index]
}

fn union(parent: &mut [usize], left: usize, right: usize) {
    let left_root = find(parent, left);
    let right_root = find(parent, right);
    if left_root != right_root {
        parent[right_root] = left_root;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::db;
    use crate::core::jobs::{self, JobStatus};
    use crate::core::test_support::TestDirectory;

    fn vector_with_cosine(score: f32) -> Vec<f32> {
        let mut vector = vec![0.0; EMBEDDING_DIMENSIONS];
        vector[0] = score;
        vector[1] = (1.0 - score * score).sqrt();
        vector
    }

    fn embedded(clip_id: i64, vector: Vec<f32>) -> EmbeddedClip {
        EmbeddedClip {
            clip_id,
            source_hash: format!("source-{clip_id}"),
            embedding: vector,
            primary_rank: PrimaryRank {
                star_rating: 0,
                l1_badge_count: 0,
                captured_at: None,
                clip_id,
            },
        }
    }

    fn axis() -> Vec<f32> {
        vector_with_cosine(1.0)
    }

    fn seed_embedding(connection: &Connection, clip_id: i64, vector: &[f32]) {
        connection
            .execute("INSERT OR IGNORE INTO volumes(uuid) VALUES ('similar-volume')", [])
            .unwrap();
        let source_hash = format!("source-{clip_id}");
        connection
            .execute(
                "INSERT INTO clips(
                    id, volume_uuid, rel_path, quick_hash, captured_at, imported_at
                 ) VALUES (?1, 'similar-volume', ?2, ?3, ?4, ?4)",
                params![
                    clip_id,
                    format!("{clip_id}.mov"),
                    source_hash,
                    format!("2026-08-31T12:{clip_id:02}:00Z"),
                ],
            )
            .unwrap();
        let blob = vector
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<_>>();
        connection
            .execute(
                "INSERT INTO clip_embeddings(
                    clip_id, embedding, dimensions, source_hash, model, embedded_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 'now')",
                params![clip_id, blob, EMBEDDING_DIMENSIONS as i64, source_hash, MODEL_NAME],
            )
            .unwrap();
    }

    #[test]
    fn synthetic_vectors_form_connected_components() {
        let clips = vec![
            embedded(1, axis()),
            embedded(2, vector_with_cosine(0.95)),
            embedded(3, {
                let mut vector = vec![0.0; EMBEDDING_DIMENSIONS];
                vector[2] = 1.0;
                vector
            }),
        ];
        let groups = cluster_embeddings(&clips);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].member_indices, vec![0, 1]);
    }

    #[test]
    fn threshold_includes_the_exact_boundary_and_rejects_below() {
        assert!(meets_similarity_threshold(SIM_THRESHOLD));
        assert!(!meets_similarity_threshold(f32::from_bits(
            SIM_THRESHOLD.to_bits() - 1
        )));
        let above = cluster_embeddings(&[
            embedded(1, axis()),
            embedded(2, vector_with_cosine(SIM_THRESHOLD + 0.001)),
        ]);
        let below = cluster_embeddings(&[
            embedded(1, axis()),
            embedded(2, vector_with_cosine(SIM_THRESHOLD - 0.001)),
        ]);
        assert_eq!(above.len(), 1);
        assert!(below.is_empty());
    }

    #[test]
    fn singleton_components_are_not_persistable_groups() {
        assert!(cluster_embeddings(&[embedded(1, axis())]).is_empty());
    }

    #[test]
    fn primary_prefers_stars_then_badges_then_capture_time() {
        let mut clips = vec![embedded(1, axis()), embedded(2, axis()), embedded(3, axis())];
        clips[0].primary_rank.star_rating = 4;
        clips[0].primary_rank.l1_badge_count = 2;
        clips[1].primary_rank.star_rating = 5;
        clips[1].primary_rank.l1_badge_count = 3;
        clips[2].primary_rank.star_rating = 5;
        clips[2].primary_rank.l1_badge_count = 1;
        clips[1].primary_rank.captured_at = Some("2026-08-31T10:00:00Z".to_owned());
        clips[2].primary_rank.captured_at = Some("2026-08-31T11:00:00Z".to_owned());

        assert_eq!(cluster_embeddings(&clips)[0].primary_index, 2);
        clips[1].primary_rank.l1_badge_count = 1;
        assert_eq!(cluster_embeddings(&clips)[0].primary_index, 1);
    }

    #[test]
    fn transitive_edges_create_one_group_and_report_true_pairwise_minimum() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        seed_embedding(&connection, 1, &vector_with_cosine(1.0));
        seed_embedding(&connection, 2, &vector_with_cosine(0.95));
        let mut third = vec![0.0; EMBEDDING_DIMENSIONS];
        third[0] = 0.81;
        third[1] = (1.0_f32 - 0.81_f32 * 0.81_f32).sqrt();
        seed_embedding(&connection, 3, &third);

        let job_id = enqueue_if_ready(&mut connection).unwrap().unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(job.id, job_id);
        run_similar_cluster(&mut connection, &job).unwrap();
        jobs::mark_done(&mut connection, job.id, job.attempt).unwrap();

        let groups = similar_groups(&connection).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].members.len(), 3);
        assert!(groups[0].min_similarity < SIM_THRESHOLD);
    }

    #[test]
    fn identical_recompute_is_idempotent_and_does_not_enqueue_a_duplicate() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        seed_embedding(&connection, 1, &axis());
        seed_embedding(&connection, 2, &axis());
        let job_id = enqueue_if_ready(&mut connection).unwrap().unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        run_similar_cluster(&mut connection, &job).unwrap();
        let first = similar_groups(&connection).unwrap();
        run_similar_cluster(&mut connection, &job).unwrap();
        assert_eq!(similar_groups(&connection).unwrap(), first);
        jobs::mark_done(&mut connection, job.id, job.attempt).unwrap();

        assert_eq!(job.id, job_id);
        assert_eq!(jobs::get(&connection, job_id).unwrap().status, JobStatus::Done);
        assert_eq!(enqueue_if_ready(&mut connection).unwrap(), None);
        assert_eq!(similar_groups(&connection).unwrap().len(), 1);
    }

    #[test]
    fn set_primary_keeps_exactly_one_member_primary() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        seed_embedding(&connection, 1, &axis());
        seed_embedding(&connection, 2, &axis());
        enqueue_if_ready(&mut connection).unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        run_similar_cluster(&mut connection, &job).unwrap();
        jobs::mark_done(&mut connection, job.id, job.attempt).unwrap();
        let group_id = similar_groups(&connection).unwrap()[0].id;

        set_primary(&mut connection, group_id, 2).unwrap();
        let members = &similar_groups(&connection).unwrap()[0].members;
        assert_eq!(members.iter().filter(|member| member.is_primary).count(), 1);
        assert!(members.iter().any(|member| member.clip_id == 2 && member.is_primary));
    }
}
