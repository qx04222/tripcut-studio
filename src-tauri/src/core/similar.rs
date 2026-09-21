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

/// R18 C-3:clip 级均值向量把 ≤12 帧抹成一个点 —— 两条素材只要有**一段**画面是同一个
/// 机位/地点,均值就会被其余帧稀释掉,归不到一组。有帧级向量时改用**帧与帧的最大余弦**。
///
/// 阈值必须比 `SIM_THRESHOLD` 高:帧级最大值是 144 对里取最大,分布天然右移,
/// 照搬 0.90 会把只是「都有天空」的两条并进同一组。
/// **这个 0.95 还没有标定**:本机没有本地 Chinese-CLIP 模型目录,侧车起不来,
/// `qa/ai-eval` 那 20 条检索跑不出数(见 lane-aiscore-report.md「未测量」一节)。
/// 拿到模型后按 PR 曲线选 F1 最高点替掉它 —— 在那之前这条只**新增**合并、
/// 且只在均值已经接近阈值的近邻对上生效(见 `FRAME_PREFILTER_MARGIN`),不会推翻旧分组。
pub const FRAME_SIM_THRESHOLD: f32 = 0.95;

/// 帧级精排的入口闸:均值余弦低于 `SIM_THRESHOLD - 这个余量` 的两条,连近邻都算不上,
/// 不值得为它们跑 144 次 512 维余弦(全库 O(n²) 已经够贵了)。
pub const FRAME_PREFILTER_MARGIN: f32 = 0.15;

/// 擂台最多接收 200 个成员；分组采用同一上限，保证每个落库组都能原样直接进入擂台。
const MAX_GROUP_MEMBERS: usize = 200;
pub(crate) const PRIMARY_LEDGER_KEY: &str = "internal.similar.primary.ledger.v1";

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
    /// R18 C-1 落库的帧级向量;空 = 这条还没重嵌过,退回只用均值。
    frames: Vec<Vec<f32>>,
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

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
struct PrimaryLedger {
    clock: u64,
    events: Vec<PrimaryEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct PrimaryEvent {
    sequence: u64,
    pub(crate) clip_id: i64,
    quick_hash: String,
    episode_id: i64,
    source: String,
    source_id: Option<i64>,
    recorded_at: String,
    active: bool,
}

#[derive(Default)]
struct PrimaryPreferences {
    event_sequence: HashMap<i64, u64>,
}

pub fn enqueue_if_ready(connection: &mut Connection) -> Result<Option<i64>> {
    let active_embeddings: i64 = connection.query_row(
        "SELECT COUNT(*) FROM jobs
         WHERE kind = 'clip_embed' AND status IN ('pending', 'running')",
        [],
        |row| row.get(0),
    )?;
    let photos = load_photos(connection)?;
    if active_embeddings > 0 && photos.is_empty() {
        return Ok(None);
    }

    let embedded = load_current_embeddings(connection)?;
    if embedded.is_empty() && photos.is_empty() {
        let persisted_groups: i64 = connection.query_row(
            "SELECT COUNT(*) FROM similar_groups",
            [],
            |row| row.get(0),
        )?;
        if persisted_groups == 0 {
            return Ok(None);
        }
    }
    let fingerprint = input_fingerprint(&embedded, &photos)?;
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

    super::photo_hash::check_cancelled()?;
    let embedded = load_current_embeddings(connection)?;
    let mut photos = load_photos(connection)?;
    let fingerprint = input_fingerprint(&embedded, &photos)?;
    if fingerprint != payload.embedding_fingerprint || embedded.len() != payload.embedding_count {
        return Ok(());
    }
    for photo in &mut photos {
        super::photo_hash::check_cancelled()?;
        let decoded = super::media_source::verified_clip_path(connection, photo.clip_id)
            .and_then(|path| super::photo_hash::cover(&path));
        match decoded {
            Ok(cover) => photo.hash = Some(super::photo_hash::dhash(&cover)),
            Err(error) => {
                super::photo_hash::check_cancelled()?;
                tracing::warn!(%error, clip_id = photo.clip_id, "照片不可读,跳过相似分组");
            }
        }
    }
    let photo_clusters = cluster_photos(&photos)?;
    let clusters = cluster_embeddings(&embedded)?;
    super::photo_hash::check_cancelled()?;

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
    let current_fingerprint = input_fingerprint(&embedded, &load_photos(&transaction)?)?;
    if current_fingerprint != payload.embedding_fingerprint
        || embedded.len() != payload.embedding_count
    {
        // 新嵌入完成时会按新指纹排队；旧 attempt 不得覆盖更新后的分组。
        transaction.commit()?;
        return Ok(());
    }

    super::photo_hash::check_cancelled()?;
    let primary_preferences = load_primary_preferences(&transaction)?;
    transaction.execute("DELETE FROM similar_groups", [])?;
    for cluster in clusters {
        transaction.execute(
            "INSERT INTO similar_groups(created_at)
             VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            [],
        )?;
        let group_id = transaction.last_insert_rowid();
        let primary_index = preferred_primary_index(
            &cluster,
            |index| embedded[index].clip_id,
            &primary_preferences,
        );
        for member_index in cluster.member_indices {
            transaction.execute(
                "INSERT INTO similar_group_members(group_id, clip_id, is_primary)
                 VALUES (?1, ?2, ?3)",
                params![
                    group_id,
                    embedded[member_index].clip_id,
                    if member_index == primary_index { 1 } else { 0 },
                ],
            )?;
        }
    }
    for cluster in photo_clusters {
        super::photo_hash::check_cancelled()?;
        transaction.execute("INSERT INTO similar_groups(created_at) VALUES(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))", [])?;
        let group_id = transaction.last_insert_rowid();
        let primary_index = preferred_primary_index(
            &cluster,
            |index| photos[index].clip_id,
            &primary_preferences,
        );
        for index in cluster.member_indices {
            super::photo_hash::check_cancelled()?;
            transaction.execute("INSERT INTO similar_group_members(group_id,clip_id,is_primary) VALUES(?1,?2,?3)",
                params![group_id, photos[index].clip_id, index == primary_index])?;
        }
    }
    super::photo_hash::check_cancelled()?;
    transaction.commit()?;
    Ok(())
}

fn load_primary_preferences(connection: &Connection) -> Result<PrimaryPreferences> {
    let mut ledger = read_primary_ledger(connection)?;
    let original_events = ledger.events.clone();
    compact_primary_events(&mut ledger.events);
    let mut event_sequence = HashMap::<i64, u64>::new();
    let mut valid_events = Vec::with_capacity(ledger.events.len());
    for event in ledger.events.drain(..) {
        let identity = connection.query_row(
            "SELECT quick_hash,episode_id,missing_since FROM clips WHERE id=?1",
            [event.clip_id],
            |row| Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<String>>(2)?,
            )),
        ).optional()?;
        if let Some((Some(ref quick_hash), Some(episode_id), ref missing_since)) = identity {
            if quick_hash == &event.quick_hash && episode_id == event.episode_id {
                if missing_since.is_none() {
                    event_sequence.entry(event.clip_id)
                        .and_modify(|sequence| *sequence = (*sequence).max(event.sequence))
                        .or_insert(event.sequence);
                }
                valid_events.push(event);
            }
        }
    }
    ledger.events = valid_events;
    if ledger.events != original_events {
        write_primary_ledger(connection, &ledger)?;
    }
    Ok(PrimaryPreferences { event_sequence })
}

fn preferred_primary_index(
    cluster: &Cluster,
    clip_id: impl Fn(usize) -> i64,
    preferences: &PrimaryPreferences,
) -> usize {
    let artificial_primary = cluster.member_indices.iter().filter_map(|index| {
        let member_clip_id = clip_id(*index);
        preferences.event_sequence.get(&member_clip_id)
            .map(|sequence| (*sequence, member_clip_id, *index))
    }).max_by(|left, right| left.0.cmp(&right.0).then_with(|| right.1.cmp(&left.1)));
    if let Some((_, _, index)) = artificial_primary {
        return index;
    }
    cluster.primary_index
}

fn read_primary_ledger(connection: &Connection) -> Result<PrimaryLedger> {
    let Some(raw) = super::settings::setting_value(connection, PRIMARY_LEDGER_KEY)? else {
        return Ok(PrimaryLedger::default());
    };
    serde_json::from_str(&raw)
        .map_err(|error| CoreError::Similar(format!("人工主图记录损坏：{error}")))
}

fn write_primary_ledger(connection: &Connection, ledger: &PrimaryLedger) -> Result<()> {
    let raw = serde_json::to_string(ledger)
        .map_err(|error| CoreError::Similar(format!("无法保存人工主图记录：{error}")))?;
    connection.execute(
        "INSERT INTO settings(key,value,updated_at)
         VALUES(?1,?2,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        params![PRIMARY_LEDGER_KEY, raw],
    )?;
    Ok(())
}

fn compact_primary_events(events: &mut Vec<PrimaryEvent>) {
    events.retain(|event| event.active);
    events.sort_by_key(|event| event.sequence);
    let mut latest = HashMap::<(i64, String, i64), u64>::new();
    for event in events.iter() {
        latest.insert(
            (event.clip_id, event.quick_hash.clone(), event.episode_id),
            event.sequence,
        );
    }
    events.retain(|event| {
        latest.get(&(
            event.clip_id,
            event.quick_hash.clone(),
            event.episode_id,
        )) == Some(&event.sequence)
    });
}

fn record_primary_event(
    connection: &Connection,
    clip_id: i64,
    source: &str,
    source_id: Option<i64>,
) -> Result<Option<u64>> {
    let identity = connection.query_row(
        "SELECT quick_hash,episode_id FROM clips
         WHERE id=?1 AND quick_hash IS NOT NULL AND episode_id IS NOT NULL",
        [clip_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
    ).optional()?;
    let Some((quick_hash, episode_id)) = identity else {
        // Legacy video rows may not belong to an episode. Preserve the old
        // immediate primary update, but do not create an identity-less event
        // that could attach to a later import.
        return Ok(None);
    };
    let recorded_at = connection.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        [],
        |row| row.get::<_, String>(0),
    )?;
    let mut ledger = read_primary_ledger(connection)?;
    ledger.clock = ledger.clock.saturating_add(1);
    ledger.events.push(PrimaryEvent {
        sequence: ledger.clock,
        clip_id,
        quick_hash,
        episode_id,
        source: source.to_owned(),
        source_id,
        recorded_at,
        active: true,
    });
    compact_primary_events(&mut ledger.events);
    write_primary_ledger(connection, &ledger)?;
    Ok(Some(ledger.clock))
}

pub(crate) fn record_duel_primary(
    connection: &Connection,
    clip_id: i64,
    session_id: i64,
) -> Result<()> {
    record_primary_event(connection, clip_id, "duel", Some(session_id)).map(|_| ())
}

pub(crate) fn record_restored_primary(connection: &Connection, clip_id: i64) -> Result<()> {
    record_primary_event(connection, clip_id, "restore", None).map(|_| ())
}

pub(crate) fn restore_primary_event(
    connection: &Connection,
    prior: &PrimaryEvent,
) -> Result<()> {
    let identity = connection.query_row(
        "SELECT quick_hash,episode_id FROM clips
         WHERE id=?1 AND quick_hash IS NOT NULL AND episode_id IS NOT NULL",
        [prior.clip_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
    ).optional()?;
    if identity != Some((prior.quick_hash.clone(), prior.episode_id)) {
        return Ok(());
    }
    let mut ledger = read_primary_ledger(connection)?;
    ledger.clock = ledger.clock.saturating_add(1);
    let mut restored = prior.clone();
    restored.sequence = ledger.clock;
    restored.active = true;
    restored.recorded_at = connection.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        [],
        |row| row.get(0),
    )?;
    ledger.events.push(restored);
    compact_primary_events(&mut ledger.events);
    write_primary_ledger(connection, &ledger)
}

pub(crate) fn invalidate_duel_primary(
    connection: &Connection,
    session_id: i64,
) -> Result<()> {
    let mut ledger = read_primary_ledger(connection)?;
    let mut changed = false;
    for event in &mut ledger.events {
        if event.active && event.source == "duel" && event.source_id == Some(session_id) {
            event.active = false;
            changed = true;
        }
    }
    if changed {
        compact_primary_events(&mut ledger.events);
        write_primary_ledger(connection, &ledger)?;
    }
    Ok(())
}

pub(crate) fn remove_primary_events_for_clips(
    connection: &Connection,
    clip_ids: &[i64],
) -> Result<()> {
    if clip_ids.is_empty() {
        return Ok(());
    }
    let removed = clip_ids.iter().copied().collect::<std::collections::HashSet<_>>();
    let mut ledger = read_primary_ledger(connection)?;
    let before = ledger.events.len();
    ledger.events.retain(|event| !removed.contains(&event.clip_id));
    if ledger.events.len() != before {
        write_primary_ledger(connection, &ledger)?;
    }
    Ok(())
}

pub(crate) fn latest_primary_in_group(
    connection: &Connection,
    group_id: i64,
) -> Result<Option<i64>> {
    let preferences = load_primary_preferences(connection)?;
    let mut statement = connection.prepare(
        "SELECT clip_id FROM similar_group_members WHERE group_id=?1",
    )?;
    let members = statement.query_map([group_id], |row| row.get::<_, i64>(0))?;
    let mut latest = None::<(u64, i64)>;
    for member in members {
        let clip_id = member?;
        let Some(sequence) = preferences.event_sequence.get(&clip_id) else {
            continue;
        };
        let candidate = (*sequence, clip_id);
        if latest.is_none_or(|current| {
            candidate.0 > current.0 || (candidate.0 == current.0 && candidate.1 < current.1)
        }) {
            latest = Some(candidate);
        }
    }
    Ok(latest.map(|(_, clip_id)| clip_id))
}

pub(crate) fn latest_primary_event_in_group(
    connection: &Connection,
    group_id: i64,
) -> Result<Option<PrimaryEvent>> {
    let Some(clip_id) = latest_primary_in_group(connection, group_id)? else {
        return Ok(None);
    };
    let ledger = read_primary_ledger(connection)?;
    Ok(ledger.events.into_iter()
        .filter(|event| event.active && event.clip_id == clip_id)
        .max_by_key(|event| event.sequence))
}

/// C4 视觉近似结果的诊断读取口。P3-D4 起它只供 Shot Stack 聚合使用，
/// 不再代表 UI 容器，也不能单独决定折叠或淘汰。
/// R18 B-4 的视觉去重用:clip_id → 它所在的相似组号。不在任何组里的素材不出现。
/// 只读组表,不重算聚类 —— 自动挑选不该在这条路上等 O(n²)。
pub fn group_id_by_clip(connection: &Connection) -> Result<BTreeMap<i64, i64>> {
    let mut statement = connection
        .prepare("SELECT clip_id, group_id FROM similar_group_members ORDER BY clip_id")?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))?;
    rows.collect::<rusqlite::Result<BTreeMap<_, _>>>().map_err(super::error::CoreError::from)
}

pub fn similar_groups(connection: &Connection) -> Result<Vec<SimilarGroup>> {
    let embedded = load_current_embeddings(connection)?;
    let photo_ids: std::collections::HashSet<i64> = load_photos(connection)?.iter().map(|p| p.clip_id).collect();
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
        if embedding_by_clip.contains_key(&clip_id) || photo_ids.contains(&clip_id) {
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
                let (Some(left_embedding), Some(right_embedding)) = (
                    embedding_by_clip.get(&members[left].clip_id), embedding_by_clip.get(&members[right].clip_id)
                ) else {
                    // Photo groups can be based on burst metadata/dHash alone;
                    // zero denotes no measured CLIP cosine, not a fabricated 1.0.
                    minimum = 0.0;
                    continue;
                };
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
    let member_ids = {
        let mut statement = transaction.prepare(
            "SELECT clip_id FROM similar_group_members WHERE group_id = ?1 ORDER BY clip_id",
        )?;
        let rows = statement
            .query_map([group_id], |row| row.get::<_, i64>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    for member_id in member_ids {
        super::episode::ensure_clip_writable(&transaction, member_id)?;
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
    record_primary_event(&transaction, clip_id, "manual", None)?;
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
                    WHERE j.kind = 'analyze_l1' AND j.clip_id = c.id
                    ORDER BY j.id DESC LIMIT 1
                )
         FROM clip_embeddings e
         JOIN clips c ON c.id = e.clip_id AND c.quick_hash = e.source_hash
         LEFT JOIN clip_analysis a ON a.clip_id = c.id
         WHERE e.dimensions = ?1 AND e.model = ?2 AND c.kind != 'photo'
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
            frames: super::clip_search::load_frame_embeddings(connection, clip_id)?
                .into_iter()
                .map(|(_, vector)| vector)
                .collect(),
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

#[derive(Debug, Serialize)]
struct PhotoClip {
    clip_id: i64,
    source_hash: String,
    path: String,
    camera: Option<String>,
    taken_ms: Option<i64>,
    episode_id: Option<i64>,
    sharpness: f64,
    embedding: Option<Vec<f32>>,
    #[serde(skip)]
    hash: Option<image_hasher::ImageHash>,
}

fn load_photos(connection: &Connection) -> Result<Vec<PhotoClip>> {
    let mut statement = connection.prepare(
        "SELECT c.id,c.quick_hash,c.rel_path,COALESCE(p.camera,c.device_model),
                CAST(round((julianday(COALESCE(p.taken_at,c.captured_at))-2440587.5)*86400000) AS INTEGER),
                c.episode_id,a.focus_scores,e.embedding
         FROM clips c LEFT JOIN photo_meta p ON p.clip_id=c.id
         LEFT JOIN clip_analysis a ON a.clip_id=c.id
         LEFT JOIN clip_embeddings e ON e.clip_id=c.id AND e.source_hash=c.quick_hash
             AND e.model=?1 AND e.dimensions=?2
         WHERE c.kind='photo' AND c.missing_since IS NULL AND c.quick_hash IS NOT NULL AND p.error IS NULL
         ORDER BY c.episode_id,5,c.id")?;
    let rows = statement.query_map(params![MODEL_NAME, EMBEDDING_DIMENSIONS as i64], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?, r.get::<_, Option<i64>>(4)?, r.get::<_, Option<i64>>(5)?,
            r.get::<_, Option<String>>(6)?, r.get::<_, Option<Vec<u8>>>(7)?))
    })?;
    let mut photos = Vec::new();
    for row in rows {
        super::photo_hash::check_cancelled()?;
        let (clip_id,source_hash,path,camera,taken_ms,episode_id,focus,blob) = row?;
        let scores = focus.as_deref().map(serde_json::from_str::<Vec<f64>>).transpose()
            .map_err(|e| CoreError::Similar(format!("照片清晰度无效：{e}")))?.unwrap_or_default();
        let sharpness = if scores.is_empty() { 0.0 } else { scores.iter().sum::<f64>() / scores.len() as f64 };
        photos.push(PhotoClip { clip_id,source_hash,path,camera,taken_ms,episode_id,sharpness,
            embedding: blob.as_deref().map(decode_embedding).transpose()?, hash: None });
    }
    Ok(photos)
}

fn input_fingerprint(embedded: &[EmbeddedClip], photos: &[PhotoClip]) -> Result<String> {
    let mut hash = blake3::Hasher::new();
    hash.update(embedding_fingerprint(embedded).as_bytes());
    hash.update(if photos.is_empty() {
        &b"photo-cluster/v1"[..]
    } else {
        &b"photo-cluster/v2-complete-link-200"[..]
    });
    hash.update(&serde_json::to_vec(photos).map_err(|e| CoreError::Similar(e.to_string()))?);
    Ok(hash.finalize().to_hex().to_string())
}

/// Sorted event windows prevent a transitive chain (or undated photo) from
/// bridging a 30-minute gap. Video and photo components are always independent.
fn cluster_photos(photos: &[PhotoClip]) -> Result<Vec<Cluster>> {
    use super::photo_hash::{file_number, hard_break};
    let mut events = vec![0_usize; photos.len()];
    for i in 1..photos.len() {
        events[i] = events[i-1] + usize::from(
            photos[i].episode_id != photos[i-1].episode_id
            || photos[i].taken_ms.is_some() != photos[i-1].taken_ms.is_some()
            || hard_break(photos[i].taken_ms, photos[i-1].taken_ms));
    }
    let numbers = photos.iter().map(|p| file_number(std::path::Path::new(&p.path))).collect::<Vec<_>>();
    let mut components = Vec::<Vec<usize>>::new();
    for candidate in 0..photos.len() {
        super::photo_hash::check_cancelled()?;
        let mut destination = None;
        'groups: for (group_index, members) in components.iter().enumerate() {
            if members.len() >= MAX_GROUP_MEMBERS {
                continue;
            }
            for member in members {
                super::photo_hash::check_cancelled()?;
                if !photo_pair_is_similar_with(
                    photos,
                    &events,
                    &numbers,
                    *member,
                    candidate,
                    |a, b| cosine_similarity(a, b).is_some_and(meets_similarity_threshold),
                ) {
                    continue 'groups;
                }
            }
            destination = Some(group_index);
            break;
        }
        if let Some(group_index) = destination {
            components[group_index].push(candidate);
        } else {
            components.push(vec![candidate]);
        }
    }
    rebalance_photo_batches(photos, &events, &numbers, &mut components)?;
    Ok(components.into_iter().filter(|m| m.len()>1).map(|member_indices| {
        let primary_index = *member_indices.iter().min_by(|a,b|
            photos[**b].sharpness.total_cmp(&photos[**a].sharpness)
                .then(photos[**a].clip_id.cmp(&photos[**b].clip_id))).expect("nonempty photo group");
        Cluster { member_indices, primary_index }
    }).collect())
}

/// A component may end in a one-photo spill solely because the previous
/// batch reached the duel limit. Keep batches disjoint and move the weakest
/// member from a compatible full batch so every spill remains actionable.
fn rebalance_photo_batches(
    photos: &[PhotoClip],
    events: &[usize],
    numbers: &[Option<i64>],
    components: &mut [Vec<usize>],
) -> Result<()> {
    for spill_index in 0..components.len() {
        super::photo_hash::check_cancelled()?;
        if components[spill_index].len() != 1 {
            continue;
        }
        let spill = components[spill_index][0];
        let mut donor_index = None;
        for (index, members) in components.iter().enumerate().take(spill_index) {
            if members.len() != MAX_GROUP_MEMBERS {
                continue;
            }
            let mut compatible = true;
            for member in members {
                super::photo_hash::check_cancelled()?;
                if !photo_pair_is_similar_with(
                    photos,
                    events,
                    numbers,
                    *member,
                    spill,
                    |a, b| cosine_similarity(a, b).is_some_and(meets_similarity_threshold),
                ) {
                    compatible = false;
                    break;
                }
            }
            if compatible {
                donor_index = Some(index);
                break;
            }
        }
        if let Some(donor_index) = donor_index {
            let weakest_position = components[donor_index]
                .iter()
                .enumerate()
                .min_by(|(_, a), (_, b)| {
                    photos[**a]
                        .sharpness
                        .total_cmp(&photos[**b].sharpness)
                        .then(photos[**b].clip_id.cmp(&photos[**a].clip_id))
                })
                .map(|(position, _)| position)
                .expect("full photo batch");
            let moved = components[donor_index].remove(weakest_position);
            components[spill_index].push(moved);
            components[spill_index].sort_unstable();
        }
    }
    Ok(())
}

fn photo_pair_is_similar_with(
    photos: &[PhotoClip],
    events: &[usize],
    numbers: &[Option<i64>],
    left: usize,
    right: usize,
    semantic_similarity: impl FnOnce(&[f32], &[f32]) -> bool,
) -> bool {
    use super::photo_hash::{hard_break, is_burst, DHASH_MAX_DISTANCE};

    if events[left] != events[right] {
        return false;
    }
    let a = &photos[left];
    let b = &photos[right];
    if hard_break(a.taken_ms, b.taken_ms) {
        return false;
    }
    let (Some(ah), Some(bh)) = (&a.hash, &b.hash) else {
        return false;
    };
    let burst = is_burst(
        a.camera.as_deref(),
        b.camera.as_deref(),
        a.taken_ms,
        b.taken_ms,
        numbers[left],
        numbers[right],
    );
    let visual = ah.dist(bh) <= DHASH_MAX_DISTANCE;
    if burst || visual {
        return true;
    }
    match (&a.embedding, &b.embedding) {
        (Some(a), Some(b)) => semantic_similarity(a, b),
        _ => false,
    }
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

/// 两条素材算不算「同一镜头」。先按均值向量判(老口径,一条都不会少);
/// 均值已经接近阈值、且两边都有帧级向量时,再用帧与帧的最大余弦补一刀
/// —— 这就是「同一地点/主体跨素材」那一类新分组的来源。
fn clips_are_similar(left: &EmbeddedClip, right: &EmbeddedClip) -> bool {
    let Some(mean) = cosine_similarity(&left.embedding, &right.embedding) else {
        return false;
    };
    if meets_similarity_threshold(mean) {
        return true;
    }
    if left.frames.is_empty() || right.frames.is_empty() {
        return false;
    }
    if mean < SIM_THRESHOLD - FRAME_PREFILTER_MARGIN {
        return false;
    }
    left.frames.iter().any(|one| {
        right
            .frames
            .iter()
            .filter_map(|other| cosine_similarity(one, other))
            .any(|score| score >= FRAME_SIM_THRESHOLD)
    })
}

fn cluster_embeddings(embedded: &[EmbeddedClip]) -> Result<Vec<Cluster>> {
    let mut parent = (0..embedded.len()).collect::<Vec<_>>();
    for left in 0..embedded.len() {
        super::photo_hash::check_cancelled()?;
        for right in (left + 1)..embedded.len() {
            super::photo_hash::check_cancelled()?;
            if clips_are_similar(&embedded[left], &embedded[right]) {
                union(&mut parent, left, right);
            }
        }
    }

    let mut components = BTreeMap::<usize, Vec<usize>>::new();
    for index in 0..embedded.len() {
        super::photo_hash::check_cancelled()?;
        let root = find(&mut parent, index);
        components.entry(root).or_default().push(index);
    }
    Ok(components
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
        .collect())
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
        embedded_with_frames(clip_id, vector, Vec::new())
    }

    fn embedded_with_frames(clip_id: i64, vector: Vec<f32>, frames: Vec<Vec<f32>>) -> EmbeddedClip {
        EmbeddedClip {
            clip_id,
            source_hash: format!("source-{clip_id}"),
            embedding: vector,
            frames,
            primary_rank: PrimaryRank {
                star_rating: 0,
                l1_badge_count: 0,
                captured_at: None,
                clip_id,
            },
        }
    }

    /// R18 C-3:clip 级均值把 ≤12 帧抹成一个点 —— 两条素材里各有一帧是同一个机位,
    /// 均值被其余帧稀释到 0.80,老口径归不到一组。有帧级向量时按帧与帧的最大余弦补一刀。
    /// 这条在 `clips_are_similar` 还只看均值的时候必红。
    #[test]
    fn frame_level_similarity_catches_a_shared_shot_the_mean_vector_dilutes() {
        let mean = vector_with_cosine(0.80);
        let shared = axis();
        let left = embedded_with_frames(1, axis(), vec![axis(), vector_with_cosine(0.1)]);
        let right = embedded_with_frames(2, mean.clone(), vec![shared, vector_with_cosine(0.2)]);
        assert!(clips_are_similar(&left, &right), "两条各有一帧完全一样,应判同组");
        // 没有帧级向量的老库照旧只看均值 —— 0.80 < 0.90,不归组。
        let bare_left = embedded(1, axis());
        let bare_right = embedded(2, mean);
        assert!(!clips_are_similar(&bare_left, &bare_right));
    }

    /// 帧级只在**近邻对**上生效:均值都差到 0.5 了,帧级再像也不合并 ——
    /// 不然「都有天空」的两条会被并进同一组,而且全库 O(n²×144) 也跑不动。
    #[test]
    fn frame_level_similarity_never_fires_on_far_pairs() {
        let far = vector_with_cosine(0.50);
        let left = embedded_with_frames(1, axis(), vec![axis()]);
        let right = embedded_with_frames(2, far, vec![axis()]);
        assert!(!clips_are_similar(&left, &right));
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

    fn legacy_input_fingerprint(
        embedded: &[EmbeddedClip],
        photos: &[PhotoClip],
    ) -> String {
        let mut hash = blake3::Hasher::new();
        hash.update(embedding_fingerprint(embedded).as_bytes());
        hash.update(b"photo-cluster/v1");
        hash.update(&serde_json::to_vec(photos).unwrap());
        hash.finalize().to_hex().to_string()
    }

    fn seed_done_cluster_job(
        connection: &Connection,
        fingerprint: &str,
        embedding_count: usize,
    ) {
        let payload = serde_json::to_string(&SimilarClusterPayload {
            embedding_fingerprint: fingerprint.to_owned(),
            embedding_count,
            model: MODEL_NAME.to_owned(),
        }).unwrap();
        let payload_hash = blake3::hash(
            format!("similar_cluster\0{fingerprint}").as_bytes(),
        ).to_hex().to_string();
        connection.execute(
            "INSERT INTO jobs(kind,payload,payload_hash,status,attempt,created_at,updated_at)
             VALUES('similar_cluster',?1,?2,'done',1,'now','now')",
            params![payload, payload_hash],
        ).unwrap();
    }

    #[test]
    fn photo_algorithm_salt_requeues_old_done_job_without_requeueing_video_only() {
        let photo_directory = TestDirectory::new();
        let mut photo_connection = db::open_project(&photo_directory.db_path()).unwrap();
        photo_connection.execute(
            "INSERT INTO clips(id,rel_path,quick_hash,kind,episode_id,tb_num,tb_den,duration_ticks)
             VALUES(1,'photo.jpg','photo-hash','photo',1,1,1000,0)",
            [],
        ).unwrap();
        photo_connection.execute("INSERT INTO photo_meta(clip_id) VALUES(1)", []).unwrap();
        let photos = load_photos(&photo_connection).unwrap();
        let legacy = legacy_input_fingerprint(&[], &photos);
        seed_done_cluster_job(&photo_connection, &legacy, 0);
        assert!(enqueue_if_ready(&mut photo_connection).unwrap().is_some());

        let video_directory = TestDirectory::new();
        let mut video_connection = db::open_project(&video_directory.db_path()).unwrap();
        seed_embedding(&video_connection, 1, &axis());
        let embedded = load_current_embeddings(&video_connection).unwrap();
        let legacy = legacy_input_fingerprint(&embedded, &[]);
        seed_done_cluster_job(&video_connection, &legacy, embedded.len());
        assert_eq!(enqueue_if_ready(&mut video_connection).unwrap(), None);
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
        let groups = cluster_embeddings(&clips).unwrap();
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
        ]).unwrap();
        let below = cluster_embeddings(&[
            embedded(1, axis()),
            embedded(2, vector_with_cosine(SIM_THRESHOLD - 0.001)),
        ]).unwrap();
        assert_eq!(above.len(), 1);
        assert!(below.is_empty());
    }

    #[test]
    fn singleton_components_are_not_persistable_groups() {
        assert!(cluster_embeddings(&[embedded(1, axis())]).unwrap().is_empty());
    }

    #[test]
    fn video_pairwise_clustering_observes_cancellation() {
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

        let flag = Arc::new(AtomicBool::new(true));
        flag.store(true, Ordering::Release);
        super::super::jobs::adopt_cancellation_flag(Some(flag));
        let result = cluster_embeddings(&[embedded(1, axis()), embedded(2, axis())]);
        super::super::jobs::adopt_cancellation_flag(None);
        assert!(result.unwrap_err().to_string().contains("取消"));
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

        assert_eq!(cluster_embeddings(&clips).unwrap()[0].primary_index, 2);
        clips[1].primary_rank.l1_badge_count = 1;
        assert_eq!(cluster_embeddings(&clips).unwrap()[0].primary_index, 1);
    }

    #[test]
    fn transitive_video_edges_create_one_group_and_report_true_pairwise_minimum() {
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

    #[test]
    fn set_primary_refuses_when_any_group_member_belongs_to_an_archived_episode() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        seed_embedding(&connection, 1, &axis());
        seed_embedding(&connection, 2, &axis());
        enqueue_if_ready(&mut connection).unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        run_similar_cluster(&mut connection, &job).unwrap();
        jobs::mark_done(&mut connection, job.id, job.attempt).unwrap();
        let group = similar_groups(&connection).unwrap().remove(0);
        let before = group.members.clone();
        let archived_episode: i64 = connection.query_row(
            "SELECT id FROM episodes WHERE status='active'", [], |row| row.get(0),
        ).unwrap();
        connection.execute(
            "UPDATE clips SET episode_id=?1 WHERE id IN (1,2)",
            [archived_episode],
        ).unwrap();
        connection.execute(
            "UPDATE episodes SET status='archived', archived_at='now' WHERE id=?1",
            [archived_episode],
        ).unwrap();
        connection.execute(
            "INSERT INTO episodes(title,theme,created_at,status,episode_number,memory_id)
             VALUES('next','','now','active',2,'next-memory')",
            [],
        ).unwrap();
        let active_episode = connection.last_insert_rowid();
        connection.execute(
            "UPDATE clips SET episode_id=?1 WHERE id=2",
            [active_episode],
        ).unwrap();

        let error = set_primary(&mut connection, group.id, 2).unwrap_err().to_string();
        assert!(error.contains("已封存"), "unexpected error: {error}");
        assert_eq!(similar_groups(&connection).unwrap()[0].members, before);
    }

    #[test]
    fn automatic_primary_is_recomputed_without_a_manual_decision() {
        let directory = TestDirectory::new();
        let mut paths = Vec::new();
        for index in 0..2 {
            let path = directory.path().join(format!("auto-{index}.png"));
            image::RgbImage::from_pixel(
                16,
                12,
                image::Rgb([70 + index as u8, 120, 180]),
            ).save(&path).unwrap();
            paths.push(path);
        }
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        crate::core::import::start_import_files(&mut connection, &paths).unwrap();
        while jobs::JobRunner::run_one(&directory.db_path()).unwrap() {}
        connection.execute("DELETE FROM jobs WHERE kind='similar_cluster'", []).unwrap();
        enqueue_if_ready(&mut connection).unwrap().unwrap();
        let first_job = jobs::claim_next(&mut connection).unwrap().unwrap();
        run_similar_cluster(&mut connection, &first_job).unwrap();
        jobs::mark_done(&mut connection, first_job.id, first_job.attempt).unwrap();
        let first_group = similar_groups(&connection).unwrap().remove(0);
        let old_primary = first_group.members.iter().find(|member| member.is_primary).unwrap().clip_id;
        let expected_primary = first_group.members.iter()
            .find(|member| member.clip_id != old_primary).unwrap().clip_id;

        connection.execute(
            "UPDATE clip_analysis SET focus_scores=CASE clip_id
             WHEN ?1 THEN '[1.0]' WHEN ?2 THEN '[1000.0]' END
             WHERE clip_id IN (?1,?2)",
            params![old_primary, expected_primary],
        ).unwrap();
        connection.execute("DELETE FROM jobs WHERE kind='similar_cluster'", []).unwrap();
        enqueue_if_ready(&mut connection).unwrap().unwrap();
        let second_job = jobs::claim_next(&mut connection).unwrap().unwrap();
        run_similar_cluster(&mut connection, &second_job).unwrap();
        let regrouped = similar_groups(&connection).unwrap().into_iter()
            .find(|group| group.members.iter().any(|member| member.clip_id == expected_primary))
            .unwrap();
        assert!(regrouped.members.iter()
            .any(|member| member.clip_id == expected_primary && member.is_primary));
    }

    #[test]
    fn manual_primary_records_a_hidden_generation_bound_decision_on_schema_53() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute(
            "INSERT INTO clips(id,rel_path,quick_hash,kind,episode_id,tb_num,tb_den,duration_ticks)
             VALUES(1,'one.jpg','hash-one','photo',1,1,1000,0),
                   (2,'two.jpg','hash-two','photo',1,1,1000,0)",
            [],
        ).unwrap();
        connection.execute("INSERT INTO similar_groups(id,created_at) VALUES(1,'now')", []).unwrap();
        connection.execute(
            "INSERT INTO similar_group_members(group_id,clip_id,is_primary)
             VALUES(1,1,1),(1,2,0)",
            [],
        ).unwrap();
        set_primary(&mut connection, 1, 2).unwrap();

        assert_eq!(crate::core::db::schema_version(&connection).unwrap(), 53);
        let raw = crate::core::settings::setting_value(
            &connection,
            "internal.similar.primary.ledger.v1",
        ).unwrap().expect("manual primary must persist an internal ledger");
        let ledger: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let event = &ledger["events"][0];
        assert_eq!(event["clip_id"], 2);
        assert_eq!(event["quick_hash"], "hash-two");
        assert_eq!(event["episode_id"], 1);
        assert!(event.get("import_generation").is_none());
        assert_eq!(event["source"], "manual");
        assert!(event["sequence"].as_u64().unwrap() > 0);
        assert!(event["recorded_at"].as_str().is_some_and(|value| !value.is_empty()));
        assert!(!crate::core::settings::get_settings(&connection).unwrap()
            .contains_key("internal.similar.primary.ledger.v1"));
    }

    #[test]
    fn library_reset_drops_primary_ledger_before_clip_id_reuse() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute(
            "INSERT INTO settings(key,value,updated_at)
             VALUES('internal.similar.primary.ledger.v1','{\"clock\":1,\"events\":[]}','now')",
            [],
        ).unwrap();
        let cache_root = directory.path().join("cache");
        crate::core::settings::reset_project_library(&mut connection, &cache_root).unwrap();
        connection.execute(
            "INSERT INTO clips(id,rel_path,quick_hash,kind,episode_id,tb_num,tb_den,duration_ticks)
             VALUES(1,'reused.jpg','new-hash','photo',1,1,1000,0)",
            [],
        ).unwrap();
        assert!(crate::core::settings::setting_value(
            &connection,
            "internal.similar.primary.ledger.v1",
        ).unwrap().is_none());
    }

    #[test]
    fn primary_ledger_compaction_keeps_every_identity_without_a_global_cutoff() {
        let mut events = (1..=600).map(|sequence| PrimaryEvent {
            sequence,
            clip_id: sequence as i64,
            quick_hash: format!("hash-{sequence}"),
            episode_id: 1,
            source: "duel".to_owned(),
            source_id: Some(sequence as i64),
            recorded_at: "now".to_owned(),
            active: true,
        }).collect::<Vec<_>>();
        events.push(PrimaryEvent {
            sequence: 601,
            clip_id: 700,
            quick_hash: "same-hash".to_owned(),
            episode_id: 1,
            source: "manual".to_owned(),
            source_id: None,
            recorded_at: "now".to_owned(),
            active: true,
        });
        events.push(PrimaryEvent {
            sequence: 602,
            clip_id: 700,
            quick_hash: "same-hash".to_owned(),
            episode_id: 1,
            source: "manual".to_owned(),
            source_id: None,
            recorded_at: "later".to_owned(),
            active: true,
        });
        compact_primary_events(&mut events);
        assert_eq!(events.len(), 601);
        assert!(events.iter().any(|event| event.sequence == 602));
        assert!(!events.iter().any(|event| event.sequence == 601));
    }

    #[test]
    fn loading_primary_preferences_prunes_events_for_missing_identities() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute(
            "INSERT INTO clips(id,rel_path,quick_hash,kind,episode_id,tb_num,tb_den,duration_ticks)
             VALUES(1,'one.jpg','hash-one','photo',1,1,1000,0)",
            [],
        ).unwrap();
        let ledger = PrimaryLedger {
            clock: 2,
            events: vec![
                PrimaryEvent {
                    sequence: 1,
                    clip_id: 1,
                    quick_hash: "hash-one".to_owned(),
                    episode_id: 1,
                    source: "manual".to_owned(),
                    source_id: None,
                    recorded_at: "now".to_owned(),
                    active: true,
                },
                PrimaryEvent {
                    sequence: 2,
                    clip_id: 999,
                    quick_hash: "gone".to_owned(),
                    episode_id: 1,
                    source: "manual".to_owned(),
                    source_id: None,
                    recorded_at: "now".to_owned(),
                    active: true,
                },
            ],
        };
        write_primary_ledger(&connection, &ledger).unwrap();

        load_primary_preferences(&connection).unwrap();

        let compacted = read_primary_ledger(&connection).unwrap();
        assert_eq!(compacted.events.len(), 1);
        assert_eq!(compacted.events[0].clip_id, 1);
    }

    #[test]
    fn temporarily_missing_primary_rejoins_with_its_decision_intact() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute(
            "INSERT INTO clips(id,rel_path,quick_hash,kind,episode_id,tb_num,tb_den,duration_ticks)
             VALUES(1,'one.jpg','hash-one','photo',1,1,1000,0),
                   (2,'two.jpg','hash-two','photo',1,1,1000,0)",
            [],
        ).unwrap();
        connection.execute("INSERT INTO similar_groups(id,created_at) VALUES(1,'now')", []).unwrap();
        connection.execute(
            "INSERT INTO similar_group_members(group_id,clip_id,is_primary)
             VALUES(1,1,1),(1,2,0)",
            [],
        ).unwrap();
        set_primary(&mut connection, 1, 2).unwrap();
        connection.execute("UPDATE clips SET missing_since='now' WHERE id=2", []).unwrap();

        let offline = load_primary_preferences(&connection).unwrap();
        assert!(!offline.event_sequence.contains_key(&2));
        assert_eq!(read_primary_ledger(&connection).unwrap().events.len(), 1);

        connection.execute("UPDATE clips SET missing_since=NULL WHERE id=2", []).unwrap();
        let relinked = load_primary_preferences(&connection).unwrap();
        assert!(relinked.event_sequence.contains_key(&2));
    }

    #[test]
    fn unrelated_removals_do_not_invalidate_a_manual_photo_primary() {
        let directory = TestDirectory::new();
        let mut paths = Vec::new();
        for index in 0..3 {
            let path = directory.path().join(format!("stable-{index}.png"));
            image::RgbImage::from_pixel(
                16,
                12,
                image::Rgb([80 + index as u8, 110, 170]),
            )
            .save(&path)
            .unwrap();
            paths.push(path);
        }
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        crate::core::import::start_import_files(&mut connection, &paths).unwrap();
        while jobs::JobRunner::run_one(&directory.db_path()).unwrap() {}

        let rerun = |connection: &mut Connection| {
            connection
                .execute("DELETE FROM jobs", [])
                .unwrap();
            enqueue_if_ready(connection).unwrap().unwrap();
            let job = jobs::claim_next(connection).unwrap().unwrap();
            run_similar_cluster(connection, &job).unwrap();
            jobs::mark_done(connection, job.id, job.attempt).unwrap();
        };
        rerun(&mut connection);
        let group = similar_groups(&connection).unwrap().remove(0);
        let winner = group.members.iter().find(|member| !member.is_primary).unwrap().clip_id;
        set_primary(&mut connection, group.id, winner).unwrap();

        let assert_winner = |connection: &Connection| {
            let group = similar_groups(connection).unwrap().into_iter()
                .find(|group| group.members.iter().any(|member| member.clip_id == winner))
                .unwrap();
            assert!(group.members.iter()
                .any(|member| member.clip_id == winner && member.is_primary));
        };

        // An empty removal still advances the importer generation today; it
        // must not invalidate a decision whose clip identity did not change.
        let empty = crate::core::import_control::RemovalRequest {
            batch_id: None,
            clip_ids: Vec::new(),
            all: false,
        };
        assert_eq!(crate::core::import_control::remove_records(&mut connection, &empty).unwrap(), 0);
        rerun(&mut connection);
        assert_winner(&connection);

        connection.execute(
            "INSERT INTO clips(id,rel_path,quick_hash,kind,episode_id,tb_num,tb_den,duration_ticks)
             VALUES(90,'unrelated.mov','unrelated-hash','video',1,1,1000,1000)",
            [],
        ).unwrap();
        record_primary_event(&connection, 90, "manual", None).unwrap();
        let unrelated = crate::core::import_control::RemovalRequest {
            batch_id: None,
            clip_ids: vec![90],
            all: false,
        };
        assert_eq!(crate::core::import_control::remove_records(&mut connection, &unrelated).unwrap(), 1);
        let ledger = read_primary_ledger(&connection).unwrap();
        assert!(ledger.events.iter().any(|event| event.clip_id == winner));
        assert!(!ledger.events.iter().any(|event| event.clip_id == 90));
        rerun(&mut connection);
        assert_winner(&connection);

        let other_episode = crate::core::episode::create_episode(&mut connection, "other")
            .unwrap().episode.id;
        connection.execute(
            "INSERT INTO clips(id,rel_path,quick_hash,kind,episode_id,tb_num,tb_den,duration_ticks)
             VALUES(91,'other.mov','other-hash','video',?1,1,1000,1000)",
            [other_episode],
        ).unwrap();
        record_primary_event(&connection, 91, "manual", None).unwrap();
        crate::core::episode::delete_episode(&mut connection, other_episode).unwrap();
        let ledger = read_primary_ledger(&connection).unwrap();
        assert!(ledger.events.iter().any(|event| event.clip_id == winner));
        assert!(!ledger.events.iter().any(|event| event.clip_id == 91));
        rerun(&mut connection);
        assert_winner(&connection);
    }

    #[test]
    fn photo_duel_winner_survives_recluster_and_undo_restores_by_clip_identity() {
        use crate::core::duel::{self, Member};

        let directory = TestDirectory::new();
        let mut paths = Vec::new();
        for index in 0..3 {
            let path = directory.path().join(format!("photo-{index}.png"));
            image::RgbImage::from_pixel(
                16,
                12,
                image::Rgb([40 + index as u8, 100, 200]),
            )
            .save(&path)
            .unwrap();
            paths.push(path);
        }
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        crate::core::import::start_import_files(&mut connection, &paths).unwrap();
        while jobs::JobRunner::run_one(&directory.db_path()).unwrap() {}
        let mut imported_photos = load_photos(&connection).unwrap();
        assert_eq!(imported_photos.len(), 3);
        for photo in &mut imported_photos {
            let path = crate::core::media_source::verified_clip_path(&connection, photo.clip_id)
                .unwrap();
            photo.hash = Some(crate::core::photo_hash::dhash(
                &crate::core::photo_hash::cover(&path).unwrap(),
            ));
        }
        assert_eq!(cluster_photos(&imported_photos).unwrap().len(), 1);
        connection
            .execute("DELETE FROM jobs WHERE kind='similar_cluster'", [])
            .unwrap();
        enqueue_if_ready(&mut connection).unwrap().unwrap();
        let initial_job = jobs::claim_next(&mut connection).unwrap().unwrap();
        run_similar_cluster(&mut connection, &initial_job).unwrap();
        jobs::mark_done(&mut connection, initial_job.id, initial_job.attempt).unwrap();

        let group = similar_groups(&connection).unwrap().remove(0);
        let original_primary = group.members.iter().find(|member| member.is_primary).unwrap().clip_id;
        let target_winner = group.members.iter().map(|member| member.clip_id)
            .find(|clip_id| *clip_id != original_primary).unwrap();
        let members = group.members.iter().map(|member| Member {
            clip_id: member.clip_id, segment_id: None, result_segment_id: None, preview: None,
        }).collect();
        let mut session = duel::start_duel(&mut connection, members, "similar_group").unwrap();
        while !session.pair.is_empty() {
            let winner = if session.pair.contains(&format!("photo:{target_winner}")) {
                format!("photo:{target_winner}")
            } else {
                session.pair[0].clone()
            };
            session = duel::decide(&mut connection, session.id, Some(winner)).unwrap();
        }
        duel::finish(&mut connection, session.id).unwrap();

        // Video groups are persisted first, forcing the photo group to receive a new row id.
        seed_embedding(&connection, 101, &axis());
        seed_embedding(&connection, 102, &axis());
        connection.execute("DELETE FROM jobs WHERE kind='similar_cluster'", []).unwrap();
        enqueue_if_ready(&mut connection).unwrap().unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        run_similar_cluster(&mut connection, &job).unwrap();
        jobs::mark_done(&mut connection, job.id, job.attempt).unwrap();

        let regrouped = similar_groups(&connection).unwrap().into_iter()
            .find(|candidate| candidate.members.iter().any(|member| member.clip_id == target_winner))
            .unwrap();
        assert_ne!(regrouped.id, group.id, "test must invalidate the snapshotted group id");
        assert!(regrouped.members.iter()
            .any(|member| member.clip_id == target_winner && member.is_primary));

        duel::undo_session(&mut connection, session.id).unwrap();
        let restored = similar_groups(&connection).unwrap().into_iter()
            .find(|candidate| candidate.members.iter().any(|member| member.clip_id == original_primary))
            .unwrap();
        assert!(restored.members.iter()
            .any(|member| member.clip_id == original_primary && member.is_primary));
    }
}

#[cfg(test)]
#[path = "../../../qa/ai-eval/photos/tests.rs"]
mod photo_eval;

#[cfg(test)]
mod photo_regressions {
    use super::*;

    fn photo(id: i64, time: i64, bits: u8) -> PhotoClip {
        PhotoClip {
            clip_id: id, source_hash: id.to_string(), path: format!("IMG_{}.png", id * 10),
            camera: Some("camera".into()), taken_ms: Some(time), episode_id: Some(1),
            sharpness: id as f64, embedding: None,
            hash: Some(image_hasher::ImageHash::from_bytes(&[bits; 8]).unwrap()),
        }
    }

    #[test]
    fn photo_layers_primary_and_event_boundaries() {
        // Layer 1: unlike hashes, matching camera, exactly 1.2s apart.
        let mut photos = vec![photo(1, 0, 0), photo(2, 1_200, 255)];
        let groups = cluster_photos(&photos).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].primary_index, 1);
        // Layer 2: same hash, outside burst time and frame-number limits.
        photos[1].taken_ms = Some(10_000);
        assert!(cluster_photos(&photos).unwrap().is_empty());
        photos[1].hash = photos[0].hash.clone();
        assert_eq!(cluster_photos(&photos).unwrap().len(), 1);
        // Layer 3: current CLIP vectors can connect different dHashes.
        photos[1].hash = Some(image_hasher::ImageHash::from_bytes(&[255; 8]).unwrap());
        let mut embedding = vec![0.0; EMBEDDING_DIMENSIONS]; embedding[0] = 1.0;
        for p in &mut photos { p.embedding = Some(embedding.clone()); }
        assert_eq!(cluster_photos(&photos).unwrap().len(), 1);
        photos[1].taken_ms = Some(1_800_001);
        assert!(cluster_photos(&photos).unwrap().is_empty(), "CLIP must not bypass the hard cut");
        photos[1].taken_ms = Some(1_800_000);
        assert_eq!(cluster_photos(&photos).unwrap().len(), 1);
        photos[1].episode_id = Some(2);
        assert!(cluster_photos(&photos).unwrap().is_empty(), "episodes never merge");
        photos[1].episode_id = Some(1);
        photos[0].taken_ms = None;
        assert!(cluster_photos(&photos).unwrap().is_empty(), "undated photos cannot bridge dated events");
    }

    #[test]
    fn photo_transitive_edges_do_not_swallow_a_dissimilar_endpoint() {
        let mut photos = vec![photo(1, 0, 0), photo(2, 0, 0), photo(3, 0, 0)];
        for photo in &mut photos {
            photo.camera = None;
        }
        photos[0].hash = Some(image_hasher::ImageHash::from_bytes(&[0; 8]).unwrap());
        photos[1].hash = Some(image_hasher::ImageHash::from_bytes(
            &[255, 255, 0, 0, 0, 0, 0, 0],
        ).unwrap());
        photos[2].hash = Some(image_hasher::ImageHash::from_bytes(
            &[255, 255, 255, 255, 0, 0, 0, 0],
        ).unwrap());

        let groups = cluster_photos(&photos).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].member_indices, vec![0, 1]);
    }

    #[test]
    fn every_photo_group_fits_the_duel_member_limit() {
        let photos = (1..=201).map(|id| photo(id, 0, 0)).collect::<Vec<_>>();
        let groups = cluster_photos(&photos).unwrap();
        assert_eq!(groups.len(), 2);
        assert!(groups.iter().all(|group| (2..=200).contains(&group.member_indices.len())));
        let tracked = groups.iter().flat_map(|group| group.member_indices.iter().copied())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(tracked.len(), 201);
        assert_eq!(tracked, (0..201).collect());

        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        for migration in crate::core::migrations::MIGRATIONS {
            connection.execute_batch(migration.sql).unwrap();
        }
        for photo in &photos {
            let clip_id = photo.clip_id;
            connection.execute(
                "INSERT INTO clips(id,rel_path,kind,episode_id,tb_num,tb_den,duration_ticks)
                 VALUES(?1,?2,'photo',1,1,1000,0)",
                params![clip_id, format!("{clip_id}.jpg")],
            ).unwrap();
        }
        for group in groups {
            let members = group.member_indices.iter().map(|index| {
                crate::core::duel::Member {
                    clip_id: photos[*index].clip_id,
                    segment_id: None,
                    result_segment_id: None,
                    preview: None,
                }
            }).collect();
            let session = crate::core::duel::start_duel(
                &mut connection,
                members,
                "similar_group",
            ).unwrap();
            assert!((2..=200).contains(&session.members.len()));
        }
    }

    #[test]
    fn burst_and_visual_matches_skip_semantic_similarity() {
        use std::cell::Cell;

        let embedding = vec![1.0; EMBEDDING_DIMENSIONS];
        let mut photos = vec![photo(1, 0, 0), photo(2, 1_000, 255)];
        for photo in &mut photos {
            photo.embedding = Some(embedding.clone());
        }
        let events = [0, 0];
        let numbers = [Some(10), Some(20)];
        let calls = Cell::new(0);
        assert!(photo_pair_is_similar_with(
            &photos,
            &events,
            &numbers,
            0,
            1,
            |_, _| {
                calls.set(calls.get() + 1);
                false
            },
        ));
        assert_eq!(calls.get(), 0, "burst match must skip the 512-d semantic path");

        photos[0].camera = None;
        photos[1].camera = None;
        photos[1].taken_ms = Some(10_000);
        photos[1].hash = photos[0].hash.clone();
        assert!(photo_pair_is_similar_with(
            &photos,
            &events,
            &numbers,
            0,
            1,
            |_, _| {
                calls.set(calls.get() + 1);
                false
            },
        ));
        assert_eq!(calls.get(), 0, "dHash match must skip the 512-d semantic path");

        photos[1].hash = Some(image_hasher::ImageHash::from_bytes(&[255; 8]).unwrap());
        assert!(photo_pair_is_similar_with(
            &photos,
            &events,
            &numbers,
            0,
            1,
            |_, _| {
                calls.set(calls.get() + 1);
                true
            },
        ));
        assert_eq!(calls.get(), 1, "semantic path must run when hard rules miss");
    }

    #[test]
    fn photo_spill_rebalance_observes_cancellation() {
        use std::sync::{Arc, atomic::AtomicBool};

        let embedding = vec![1.0; EMBEDDING_DIMENSIONS];
        let mut photos = (1..=201).map(|id| photo(id, 0, 0)).collect::<Vec<_>>();
        for photo in &mut photos {
            photo.camera = None;
            photo.embedding = Some(embedding.clone());
        }
        photos[200].hash = Some(image_hasher::ImageHash::from_bytes(&[255; 8]).unwrap());
        let events = vec![0; photos.len()];
        let numbers = vec![None; photos.len()];
        let mut components = vec![(0..200).collect::<Vec<_>>(), vec![200]];
        let flag = Arc::new(AtomicBool::new(true));
        super::super::jobs::adopt_cancellation_flag(Some(flag));
        let result = rebalance_photo_batches(
            &photos,
            &events,
            &numbers,
            &mut components,
        );
        super::super::jobs::adopt_cancellation_flag(None);
        assert!(result.unwrap_err().to_string().contains("取消"));
    }

    #[test]
    fn photo_ten_thousand_clustering_cancels_within_one_second() {
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}, mpsc};
        let flag = Arc::new(AtomicBool::new(false));
        let worker_flag = flag.clone();
        let (started, ready) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let photos: Vec<_> = (1..=10_000).map(|id| photo(id, 0, 0)).collect();
            super::super::jobs::adopt_cancellation_flag(Some(worker_flag));
            started.send(()).unwrap();
            let result = cluster_photos(&photos);
            super::super::jobs::adopt_cancellation_flag(None);
            result
        });
        ready.recv().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        let start = std::time::Instant::now();
        flag.store(true, Ordering::Release);
        assert!(worker.join().unwrap().unwrap_err().to_string().contains("取消"));
        let elapsed = start.elapsed();
        eprintln!("PH06 10000-photo clustering cancellation={elapsed:?}");
        assert!(elapsed < std::time::Duration::from_secs(1));
    }
}
