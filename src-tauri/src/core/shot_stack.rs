use std::collections::{BTreeMap, HashMap};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::analysis::{DARK_YAVG_THRESHOLD, OVEREXPOSED_RATIO_THRESHOLD, SOFT_FOCUS_THRESHOLD};
use super::channel_memory::ClipMemoryAnnotation;
use super::error::{CoreError, Result};
use super::settings;

const INFORMATION_FUNCTIONS: [&str; 2] = ["Orientation", "Information"];
const HUMAN_FUNCTION: &str = "Human-Reaction";
const HUMAN_SUBJECT: &str = "人";
const UNKNOWN_LABEL: &str = "不确定";
const MAX_PREFERENCE_BOOST: f64 = 0.20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AxisScore {
    pub score: Option<f64>,
    pub confidence: f64,
    pub source: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScoreWeights {
    pub technical: f64,
    pub composition: f64,
    pub motion: f64,
    pub human: f64,
    pub audio: f64,
    pub narrative: f64,
}

impl ScoreWeights {
    fn from_settings(connection: &Connection) -> Result<Self> {
        Ok(Self {
            technical: settings::number_value(
                connection,
                settings::BEST_TAKE_TECHNICAL_WEIGHT_KEY,
                settings::DEFAULT_BEST_TAKE_TECHNICAL_WEIGHT,
            )?,
            composition: settings::number_value(
                connection,
                settings::BEST_TAKE_COMPOSITION_WEIGHT_KEY,
                settings::DEFAULT_BEST_TAKE_COMPOSITION_WEIGHT,
            )?,
            motion: settings::number_value(
                connection,
                settings::BEST_TAKE_MOTION_WEIGHT_KEY,
                settings::DEFAULT_BEST_TAKE_MOTION_WEIGHT,
            )?,
            human: settings::number_value(
                connection,
                settings::BEST_TAKE_HUMAN_WEIGHT_KEY,
                settings::DEFAULT_BEST_TAKE_HUMAN_WEIGHT,
            )?,
            audio: settings::number_value(
                connection,
                settings::BEST_TAKE_AUDIO_WEIGHT_KEY,
                settings::DEFAULT_BEST_TAKE_AUDIO_WEIGHT,
            )?,
            narrative: settings::number_value(
                connection,
                settings::BEST_TAKE_NARRATIVE_WEIGHT_KEY,
                settings::DEFAULT_BEST_TAKE_NARRATIVE_WEIGHT,
            )?,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BestTakeBreakdown {
    pub technical: AxisScore,
    pub composition: AxisScore,
    pub motion: AxisScore,
    pub human: AxisScore,
    pub audio: AxisScore,
    pub narrative: AxisScore,
    pub configured_weights: ScoreWeights,
    pub preference_boost: f64,
    pub total: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ShotStackMember {
    pub clip_id: i64,
    pub segment_id: Option<i64>,
    pub best_take_score: Option<f64>,
    pub score_breakdown: BestTakeBreakdown,
    pub user_state: String,
    pub is_preferred: bool,
    pub long_term_memory: ClipMemoryAnnotation,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ShotStack {
    pub id: i64,
    pub scene_id: i64,
    pub scene_name: String,
    pub stack_type: String,
    pub subject_label: String,
    pub function_label: String,
    pub shot_size_label: String,
    pub movement_label: String,
    pub quality_exempt: bool,
    pub members: Vec<ShotStackMember>,
}

#[derive(Debug, Clone)]
struct Candidate {
    clip_id: i64,
    chapter_id: Option<i64>,
    chapter_title: Option<String>,
    subject_label: String,
    subject_score: f64,
    function_label: String,
    function_score: f64,
    shot_size_label: String,
    shot_size_score: f64,
    viewpoint_label: String,
    viewpoint_score: f64,
    person_state_label: String,
    person_state_score: f64,
    movement_label: String,
    time_stage_label: String,
    sound_label: String,
    similar_group_id: Option<i64>,
    exposure_yavg: Option<f64>,
    overexposed_ratio: Option<f64>,
    audio_peak_db: Option<f64>,
    audio_clipped: Option<bool>,
    has_audio: Option<bool>,
    focus_scores_json: Option<String>,
    analysis_metadata_json: Option<String>,
    shake_score: Option<f64>,
    motion_sample_pairs: Option<i64>,
    motion_metadata: Option<String>,
    transcript_text: String,
    transcript_ticks: i64,
    duration_ticks: i64,
    tag_text: String,
    unexpected_chapter: bool,
    safety_flag: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct StackKey {
    subject: String,
    function: String,
    shot_size: String,
    movement: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StackType {
    Visual,
    Information,
    Human,
}

impl StackType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Visual => "visual",
            Self::Information => "information",
            Self::Human => "human",
        }
    }

    fn quality_exempt(self) -> bool {
        !matches!(self, Self::Visual)
    }
}

pub fn rebuild(connection: &mut Connection) -> Result<usize> {
    // IMMEDIATE 在读取候选快照前取得写租约，避免并行 classify_dims 用旧快照
    // 覆盖较新的 Stack 结果。
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let episode_id = active_episode_id(&transaction)?;
    let candidates = load_candidates(&transaction, episode_id)?;
    let weights = ScoreWeights::from_settings(&transaction)?;
    let jitter_threshold = settings::number_value(
        &transaction,
        settings::JITTER_THRESHOLD_KEY,
        settings::DEFAULT_JITTER_THRESHOLD,
    )?
    .clamp(0.01, 2.0);
    let preference_boosts = load_preference_boosts(&transaction)?;
    let existing_states = load_existing_states(&transaction, episode_id)?;

    transaction.execute("DELETE FROM scenes WHERE episode_id = ?1", [episode_id])?;

    let mut by_scene = BTreeMap::<Option<i64>, Vec<&Candidate>>::new();
    for candidate in &candidates {
        by_scene
            .entry(candidate.chapter_id)
            .or_default()
            .push(candidate);
    }

    let mut stack_count = 0;
    for (chapter_id, scene_candidates) in by_scene {
        let scene_name = scene_name(chapter_id, &scene_candidates);
        let scene_kind = if chapter_id.is_some() { "signal" } else { "unassigned" };
        transaction.execute(
            "INSERT INTO scenes(episode_id, chapter_signal_id, name, kind)
             VALUES (?1, ?2, ?3, ?4)",
            params![episode_id, chapter_id, scene_name, scene_kind],
        )?;
        let scene_id = transaction.last_insert_rowid();

        let mut grouped = BTreeMap::<StackKey, Vec<&Candidate>>::new();
        for candidate in scene_candidates {
            grouped
                .entry(StackKey {
                    subject: candidate.subject_label.clone(),
                    function: candidate.function_label.clone(),
                    shot_size: candidate.shot_size_label.clone(),
                    movement: candidate.movement_label.clone(),
                })
                .or_default()
                .push(candidate);
        }

        for (key, members) in grouped {
            transaction.execute(
                "INSERT INTO shot_stacks(
                    scene_id, subject_label, function_label, created_at
                 ) VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                params![scene_id, key.subject, key.function],
            )?;
            let stack_id = transaction.last_insert_rowid();
            let preference_boost = preference_boosts
                .get(&(
                    key.function.clone(),
                    key.shot_size.clone(),
                    key.movement.clone(),
                ))
                .copied()
                .unwrap_or(0.0);
            // 标签或视觉信号重算可能把两个旧 Stack 合并；此时只保留优先级最高
            // 的人工首选，避免违反 one-manual-preferred 约束。Reject 状态照常保留。
            let manual_winner = members
                .iter()
                .filter_map(|member| {
                    let state = existing_states.get(&(member.clip_id, None))?;
                    matches!(state.as_str(), "locked" | "hero")
                        .then_some((member_rank(state), member.clip_id))
                })
                .min();
            for member in members {
                let breakdown = score_candidate(
                    member,
                    &weights,
                    preference_boost,
                    jitter_threshold,
                );
                let breakdown_json = serde_json::to_string(&breakdown).map_err(|error| {
                    CoreError::ShotStack(format!("无法序列化 Best Take 分解：{error}"))
                })?;
                let stored_state = existing_states
                    .get(&(member.clip_id, None))
                    .map(String::as_str)
                    .unwrap_or("auto");
                let user_state = if matches!(stored_state, "locked" | "hero")
                    && manual_winner.is_some_and(|winner| winner.1 != member.clip_id)
                {
                    "auto"
                } else {
                    stored_state
                };
                transaction.execute(
                    "INSERT INTO shot_stack_members(
                        stack_id, clip_id, segment_id, best_take_score,
                        score_breakdown_json, user_state
                     ) VALUES (?1, ?2, NULL, ?3, ?4, ?5)",
                    params![
                        stack_id,
                        member.clip_id,
                        breakdown.total,
                        breakdown_json,
                        user_state
                    ],
                )?;
            }
            stack_count += 1;
        }
    }

    transaction.commit()?;
    Ok(stack_count)
}

pub fn list(connection: &Connection) -> Result<Vec<ShotStack>> {
    let episode_id = active_episode_id(connection)?;
    let mut statement = connection.prepare(
        "SELECT stack.id, stack.scene_id, scene.name,
                stack.subject_label, stack.function_label,
                COALESCE(size.label, '不确定'), COALESCE(movement.label, '不确定'),
                member.clip_id, member.segment_id, member.best_take_score,
                member.score_breakdown_json, member.user_state
         FROM shot_stacks stack
         JOIN scenes scene ON scene.id = stack.scene_id
         JOIN shot_stack_members member ON member.stack_id = stack.id
         LEFT JOIN clip_dimensions size
           ON size.clip_id = member.clip_id AND size.dimension = 'shot_size'
         LEFT JOIN clip_dimensions movement
           ON movement.clip_id = member.clip_id AND movement.dimension = 'movement'
         WHERE scene.episode_id = ?1
         ORDER BY scene.id, stack.id, member.clip_id",
    )?;
    let rows = statement.query_map([episode_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, Option<i64>>(8)?,
            row.get::<_, Option<f64>>(9)?,
            row.get::<_, String>(10)?,
            row.get::<_, String>(11)?,
        ))
    })?;

    let mut stacks = BTreeMap::<i64, ShotStack>::new();
    let memory_reader = super::channel_memory::ChannelMemoryReader::for_project(connection)?;
    for row in rows {
        let (
            id,
            scene_id,
            scene_name,
            subject_label,
            function_label,
            shot_size_label,
            movement_label,
            clip_id,
            segment_id,
            best_take_score,
            breakdown_json,
            user_state,
        ) = row?;
        let score_breakdown: BestTakeBreakdown = serde_json::from_str(&breakdown_json).map_err(|error| {
            CoreError::InvalidSchema(format!(
                "shot_stack_members.score_breakdown_json 无效：{error}"
            ))
        })?;
        let stack_type = stack_type(&subject_label, &function_label);
        let (in_ticks, out_ticks) = match segment_id {
            Some(segment_id) => connection.query_row(
                "SELECT in_ticks, out_ticks FROM segments WHERE id=?1",
                [segment_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )?,
            None => connection.query_row(
                "SELECT 0, COALESCE(duration_ticks, 0) FROM clips WHERE id=?1",
                [clip_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )?,
        };
        let long_term_memory = memory_reader.clip_annotation(
            connection,
            clip_id,
            segment_id,
            in_ticks,
            out_ticks,
        )?;
        let mut score_breakdown = score_breakdown;
        let adjusted_score = apply_long_term_memory(&mut score_breakdown, &long_term_memory);
        stacks
            .entry(id)
            .or_insert_with(|| ShotStack {
                id,
                scene_id,
                scene_name,
                stack_type: stack_type.as_str().to_owned(),
                subject_label,
                function_label,
                shot_size_label,
                movement_label,
                quality_exempt: stack_type.quality_exempt(),
                members: Vec::new(),
            })
            .members
            .push(ShotStackMember {
                clip_id,
                segment_id,
                best_take_score: adjusted_score.or(best_take_score),
                score_breakdown,
                user_state,
                is_preferred: false,
                long_term_memory,
            });
    }

    let mut result = stacks.into_values().collect::<Vec<_>>();
    for stack in &mut result {
        stack.members.sort_by(|left, right| {
            member_rank(&left.user_state)
                .cmp(&member_rank(&right.user_state))
                .then_with(|| {
                    right
                        .best_take_score
                        .unwrap_or(f64::NEG_INFINITY)
                        .total_cmp(&left.best_take_score.unwrap_or(f64::NEG_INFINITY))
                })
                .then(left.clip_id.cmp(&right.clip_id))
        });
        if let Some(preferred) = stack
            .members
            .iter_mut()
            .find(|member| member.user_state != "rejected")
        {
            preferred.is_preferred = true;
        }
    }
    Ok(result)
}

fn apply_long_term_memory(
    breakdown: &mut BestTakeBreakdown,
    memory: &ClipMemoryAnnotation,
) -> Option<f64> {
    if !memory.routine_visual {
        return Some(breakdown.total);
    }
    if memory.novelty_context {
        let base = breakdown.narrative.score.unwrap_or(0.5);
        breakdown.narrative.score = Some(
            (base + memory.narrative_adjustment).clamp(0.0, 1.0),
        );
        breakdown.narrative.confidence = breakdown.narrative.confidence.max(0.8);
        breakdown.narrative.source = format!(
            "{}+P4-E3 channel memory",
            breakdown.narrative.source
        );
        breakdown.narrative.note.push_str(
            " 跨集 Routine Visual 处于新地点或异常天气语境，Novelty 加成恢复 Hero 候选。",
        );
        breakdown.total = weighted_total(
            [
                (&breakdown.technical, breakdown.configured_weights.technical),
                (&breakdown.composition, breakdown.configured_weights.composition),
                (&breakdown.motion, breakdown.configured_weights.motion),
                (&breakdown.human, breakdown.configured_weights.human),
                (&breakdown.audio, breakdown.configured_weights.audio),
                (&breakdown.narrative, breakdown.configured_weights.narrative),
            ],
            breakdown.preference_boost,
        );
        return Some(breakdown.total);
    }
    let original_total = breakdown.total;
    let base = breakdown.narrative.score.unwrap_or(0.5);
    breakdown.narrative.score = Some((base + memory.narrative_adjustment).clamp(0.0, 1.0));
    breakdown.narrative.confidence = breakdown.narrative.confidence.max(0.8);
    breakdown.narrative.source = format!(
        "{}+P4-E3 channel memory",
        breakdown.narrative.source
    );
    breakdown.narrative.note.push_str(&format!(
        " 近 {} 集同签名使用 {} 集，标记 Routine Visual；Narrative 轴调整 {:.2}。",
        memory.recent_episode_window,
        memory.repeated_signature_uses,
        memory.narrative_adjustment
    ));
    breakdown.total = weighted_total(
        [
            (&breakdown.technical, breakdown.configured_weights.technical),
            (&breakdown.composition, breakdown.configured_weights.composition),
            (&breakdown.motion, breakdown.configured_weights.motion),
            (&breakdown.human, breakdown.configured_weights.human),
            (&breakdown.audio, breakdown.configured_weights.audio),
            (&breakdown.narrative, breakdown.configured_weights.narrative),
        ],
        breakdown.preference_boost,
    );
    if original_total >= 0.85
        && breakdown.narrative.note.contains("Narrative Override Technical Quality")
    {
        breakdown.total = breakdown.total.max(0.85);
    }
    Some(breakdown.total)
}

fn rescore_in(connection: &Connection, episode_id: i64) -> Result<usize> {
    let weights = ScoreWeights::from_settings(connection)?;
    let members = {
        let mut statement = connection.prepare(
            "SELECT member.stack_id, member.clip_id, member.segment_id,
                    member.score_breakdown_json
             FROM shot_stack_members member
             JOIN shot_stacks stack ON stack.id = member.stack_id
             JOIN scenes scene ON scene.id = stack.scene_id
             WHERE scene.episode_id = ?1",
        )?;
        let rows = statement.query_map([episode_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (stack_id, clip_id, segment_id, breakdown_json) in &members {
        let mut breakdown: BestTakeBreakdown = serde_json::from_str(breakdown_json).map_err(|error| {
            CoreError::InvalidSchema(format!(
                "shot_stack_members.score_breakdown_json 无效：{error}"
            ))
        })?;
        breakdown.configured_weights = weights.clone();
        breakdown.total = weighted_total(
            [
                (&breakdown.technical, weights.technical),
                (&breakdown.composition, weights.composition),
                (&breakdown.motion, weights.motion),
                (&breakdown.human, weights.human),
                (&breakdown.audio, weights.audio),
                (&breakdown.narrative, weights.narrative),
            ],
            breakdown.preference_boost,
        );
        let updated_json = serde_json::to_string(&breakdown).map_err(|error| {
            CoreError::ShotStack(format!("无法序列化 Best Take 分解：{error}"))
        })?;
        connection.execute(
            "UPDATE shot_stack_members
             SET best_take_score = ?4, score_breakdown_json = ?5
             WHERE stack_id = ?1 AND clip_id = ?2 AND segment_id IS ?3",
            params![stack_id, clip_id, segment_id, breakdown.total, updated_json],
        )?;
    }
    Ok(members.len())
}

pub fn rescore(connection: &mut Connection) -> Result<usize> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let episode_id = active_episode_id(&transaction)?;
    let count = rescore_in(&transaction, episode_id)?;
    transaction.commit()?;
    Ok(count)
}

pub fn update_weight_and_rescore(
    connection: &mut Connection,
    key: &str,
    value: &str,
) -> Result<usize> {
    if !key.starts_with("best_take.weight.") {
        return Err(CoreError::ShotStack(format!(
            "非 Best Take 权重设置不能走重评分事务：{key}"
        )));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let episode_id = active_episode_id(&transaction)?;
    settings::set_setting(&transaction, key, value)?;
    let count = rescore_in(&transaction, episode_id)?;
    transaction.commit()?;
    Ok(count)
}

pub fn set_user_state(
    connection: &mut Connection,
    stack_id: i64,
    clip_id: i64,
    segment_id: Option<i64>,
    user_state: &str,
) -> Result<()> {
    if !matches!(user_state, "auto" | "locked" | "rejected" | "hero") {
        return Err(CoreError::ShotStack(format!(
            "无效的 Shot Stack 用户状态：{user_state}"
        )));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let episode_id = active_episode_id(&transaction)?;
    let resolved = transaction
        .query_row(
            "SELECT member.stack_id, stack.function_label,
                    COALESCE(size.label, '不确定'),
                    COALESCE(movement.label, '不确定')
             FROM shot_stack_members member
             JOIN shot_stacks stack ON stack.id = member.stack_id
             JOIN scenes scene ON scene.id = stack.scene_id
             JOIN clips clip ON clip.id = member.clip_id
             LEFT JOIN clip_dimensions size
               ON size.clip_id = member.clip_id AND size.dimension = 'shot_size'
             LEFT JOIN clip_dimensions movement
               ON movement.clip_id = member.clip_id AND movement.dimension = 'movement'
             WHERE member.stack_id = ?1
               AND member.clip_id = ?2 AND member.segment_id IS ?3
               AND scene.episode_id = ?4 AND clip.episode_id = ?4",
            params![stack_id, clip_id, segment_id, episode_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| {
            CoreError::ShotStack(format!(
                "Stack {stack_id} 请求的素材 {clip_id} 当前不属于任何 Stack"
            ))
        })?;
    let current_stack_id = resolved.0;

    if matches!(user_state, "locked" | "hero") {
        transaction.execute(
            "UPDATE shot_stack_members
             SET user_state = 'auto'
             WHERE stack_id = ?1 AND user_state IN ('locked', 'hero')",
            [current_stack_id],
        )?;
    }
    let changed = transaction.execute(
        "UPDATE shot_stack_members SET user_state = ?4
         WHERE stack_id = ?1 AND clip_id = ?2 AND segment_id IS ?3",
        params![current_stack_id, clip_id, segment_id, user_state],
    )?;
    if changed != 1 {
        return Err(CoreError::ShotStack(
            "Shot Stack 状态更新未命中唯一成员".to_owned(),
        ));
    }

    if matches!(user_state, "locked" | "hero") {
        transaction.execute(
            "INSERT INTO shot_stack_preferences(
                function_label, shot_size_label, movement_label,
                selection_count, hero_count, boost, updated_at
             ) VALUES (?1, ?2, ?3, 1, ?4, ?5,
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(function_label, shot_size_label, movement_label)
             DO UPDATE SET
               selection_count = selection_count + 1,
               hero_count = hero_count + excluded.hero_count,
               boost = MIN(0.20, boost + excluded.boost),
               updated_at = excluded.updated_at",
            params![
                resolved.1,
                resolved.2,
                resolved.3,
                if user_state == "hero" { 1 } else { 0 },
                if user_state == "hero" { 0.03 } else { 0.015 }
            ],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn load_candidates(connection: &Connection, episode_id: i64) -> Result<Vec<Candidate>> {
    let mut statement = connection.prepare(
        "SELECT c.id, c.chapter_id, chapter.title,
                COALESCE(subject.label, '不确定'), COALESCE(subject.score, 0.0),
                COALESCE(function.label, '不确定'), COALESCE(function.score, 0.0),
                COALESCE(size.label, '不确定'), COALESCE(size.score, 0.0),
                COALESCE(viewpoint.label, '不确定'), COALESCE(viewpoint.score, 0.0),
                COALESCE(person.label, '不确定'), COALESCE(person.score, 0.0),
                COALESCE(movement.label, '不确定'),
                COALESCE(time_stage.label, '不确定'),
                COALESCE(sound.label, '不确定'), similar.group_id,
                analysis.exposure_yavg, analysis.overexposed_ratio,
                analysis.audio_peak_db, analysis.audio_clipped, analysis.has_audio,
                analysis.focus_scores, analysis.tool_versions,
                motion.shake_score, motion.sample_pairs, motion.tool_version,
                COALESCE((
                    SELECT GROUP_CONCAT(text, '') FROM transcript_segments transcript
                    WHERE transcript.clip_id = c.id
                ), ''),
                COALESCE((
                    SELECT SUM(end_ticks - start_ticks) FROM transcript_segments transcript
                    WHERE transcript.clip_id = c.id
                ), 0),
                COALESCE(c.duration_ticks, 0),
                COALESCE((
                    SELECT GROUP_CONCAT(tag.label, ' ') FROM tags tag
                    JOIN segments tagged_segment ON tagged_segment.id = tag.segment_id
                    WHERE tagged_segment.clip_id = c.id
                ), ''),
                EXISTS(
                    SELECT 1 FROM narrative_beats beat
                    JOIN narrative_chapters narrative_chapter
                      ON narrative_chapter.id = beat.chapter_id
                    WHERE beat.clip_id = c.id AND narrative_chapter.kind = 'unexpected'
                      AND narrative_chapter.episode_id = ?1
                ),
                c.safety_flag
         FROM clips c
         LEFT JOIN chapters chapter ON chapter.id = c.chapter_id
           AND chapter.tombstone = 0 AND chapter.episode_id = ?1
         LEFT JOIN clip_dimensions subject
           ON subject.clip_id = c.id AND subject.dimension = 'subject'
         LEFT JOIN clip_dimensions function
           ON function.clip_id = c.id AND function.dimension = 'function'
         LEFT JOIN clip_dimensions size
           ON size.clip_id = c.id AND size.dimension = 'shot_size'
         LEFT JOIN clip_dimensions viewpoint
           ON viewpoint.clip_id = c.id AND viewpoint.dimension = 'viewpoint'
         LEFT JOIN clip_dimensions person
           ON person.clip_id = c.id AND person.dimension = 'person_state'
         LEFT JOIN clip_dimensions movement
           ON movement.clip_id = c.id AND movement.dimension = 'movement'
         LEFT JOIN clip_dimensions time_stage
           ON time_stage.clip_id = c.id AND time_stage.dimension = 'time_stage'
         LEFT JOIN clip_dimensions sound
           ON sound.clip_id = c.id AND sound.dimension = 'sound'
         LEFT JOIN similar_group_members similar ON similar.clip_id = c.id
         LEFT JOIN clip_analysis analysis ON analysis.clip_id = c.id
         LEFT JOIN clip_motion motion ON motion.clip_id = c.id
         WHERE c.episode_id = ?1
         ORDER BY c.chapter_id IS NULL, c.chapter_id, c.captured_at IS NULL,
                  c.captured_at, c.id",
    )?;
    let rows = statement.query_map([episode_id], |row| {
        Ok(Candidate {
            clip_id: row.get(0)?,
            chapter_id: row.get(1)?,
            chapter_title: row.get(2)?,
            subject_label: row.get(3)?,
            subject_score: row.get(4)?,
            function_label: row.get(5)?,
            function_score: row.get(6)?,
            shot_size_label: row.get(7)?,
            shot_size_score: row.get(8)?,
            viewpoint_label: row.get(9)?,
            viewpoint_score: row.get(10)?,
            person_state_label: row.get(11)?,
            person_state_score: row.get(12)?,
            movement_label: row.get(13)?,
            time_stage_label: row.get(14)?,
            sound_label: row.get(15)?,
            similar_group_id: row.get(16)?,
            exposure_yavg: row.get(17)?,
            overexposed_ratio: row.get(18)?,
            audio_peak_db: row.get(19)?,
            audio_clipped: row.get::<_, Option<i64>>(20)?.map(|value| value == 1),
            has_audio: row.get::<_, Option<i64>>(21)?.map(|value| value == 1),
            focus_scores_json: row.get(22)?,
            analysis_metadata_json: row.get(23)?,
            shake_score: row.get(24)?,
            motion_sample_pairs: row.get(25)?,
            motion_metadata: row.get(26)?,
            transcript_text: row.get(27)?,
            transcript_ticks: row.get(28)?,
            duration_ticks: row.get(29)?,
            tag_text: row.get(30)?,
            unexpected_chapter: row.get::<_, i64>(31)? == 1,
            safety_flag: row.get(32)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(CoreError::from)
}

fn load_existing_states(
    connection: &Connection,
    episode_id: i64,
) -> Result<HashMap<(i64, Option<i64>), String>> {
    let mut statement = connection.prepare(
        "SELECT member.clip_id, member.segment_id, member.user_state
         FROM shot_stack_members member
         JOIN shot_stacks stack ON stack.id = member.stack_id
         JOIN scenes scene ON scene.id = stack.scene_id
         WHERE member.user_state <> 'auto' AND scene.episode_id = ?1",
    )?;
    let rows = statement.query_map([episode_id], |row| {
        Ok((
            (row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?),
            row.get::<_, String>(2)?,
        ))
    })?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(CoreError::from)
}

fn active_episode_id(connection: &Connection) -> Result<i64> {
    connection
        .query_row(
            "SELECT id FROM episodes WHERE status = 'active'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| CoreError::ShotStack("没有进行中的 Episode".to_owned()))
}

fn load_preference_boosts(
    connection: &Connection,
) -> Result<HashMap<(String, String, String), f64>> {
    let mut statement = connection.prepare(
        "SELECT function_label, shot_size_label, movement_label, boost
         FROM shot_stack_preferences",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            (
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ),
            row.get::<_, f64>(3)?,
        ))
    })?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(CoreError::from)
}

fn scene_name(chapter_id: Option<i64>, candidates: &[&Candidate]) -> String {
    let base = candidates
        .iter()
        .find_map(|candidate| candidate.chapter_title.as_deref())
        .map(str::to_owned)
        .unwrap_or_else(|| match chapter_id {
            Some(id) => format!("信号场景 {id}"),
            None => "未分配场景".to_owned(),
        });
    let dimensions = [
        (
            "主体",
            dominant_label(candidates.iter().map(|item| item.subject_label.as_str())),
        ),
        (
            "功能",
            dominant_label(candidates.iter().map(|item| item.function_label.as_str())),
        ),
        (
            "景别",
            dominant_label(candidates.iter().map(|item| item.shot_size_label.as_str())),
        ),
        (
            "视角",
            dominant_label(candidates.iter().map(|item| item.viewpoint_label.as_str())),
        ),
        (
            "运镜",
            dominant_label(candidates.iter().map(|item| item.movement_label.as_str())),
        ),
        (
            "人物",
            dominant_label(candidates.iter().map(|item| item.person_state_label.as_str())),
        ),
        (
            "阶段",
            dominant_label(candidates.iter().map(|item| item.time_stage_label.as_str())),
        ),
        (
            "声音",
            dominant_label(candidates.iter().map(|item| item.sound_label.as_str())),
        ),
    ]
    .into_iter()
    .filter(|(_, label)| label != UNKNOWN_LABEL)
    .map(|(dimension, label)| format!("{dimension}={label}"))
    .collect::<Vec<_>>();
    if dimensions.is_empty() {
        base
    } else {
        format!("{base} · {}", dimensions.join(" · "))
    }
}

fn dominant_label<'a>(labels: impl Iterator<Item = &'a str>) -> String {
    let mut counts = BTreeMap::<&str, usize>::new();
    for label in labels.filter(|label| *label != UNKNOWN_LABEL) {
        *counts.entry(label).or_default() += 1;
    }
    counts
        .into_iter()
        .max_by(|left, right| left.1.cmp(&right.1).then_with(|| right.0.cmp(left.0)))
        .map(|(label, _)| label.to_owned())
        .unwrap_or_else(|| UNKNOWN_LABEL.to_owned())
}

fn stack_type(subject: &str, function: &str) -> StackType {
    if INFORMATION_FUNCTIONS.contains(&function) {
        StackType::Information
    } else if subject == HUMAN_SUBJECT || function == HUMAN_FUNCTION {
        StackType::Human
    } else {
        StackType::Visual
    }
}

fn score_candidate(
    candidate: &Candidate,
    weights: &ScoreWeights,
    preference_boost: f64,
    jitter_threshold: f64,
) -> BestTakeBreakdown {
    let technical = technical_score(candidate);
    let mut composition = proxy_axis(
        &[candidate.shot_size_score, candidate.viewpoint_score],
        "Chinese-CLIP 八维标签置信度",
        "启发式代理：景别与视角原型分近似构图平衡，待真实构图样本校准。",
    );
    if let Some(group_id) = candidate.similar_group_id {
        composition.source = "Chinese-CLIP 八维标签+C4 视觉近似信号".to_owned();
        composition.note.push_str(&format!(
            " C4 组 {group_id} 仅作为视觉邻近旁证，不充当 Stack 容器或质量结论。"
        ));
    }
    let motion = motion_score(candidate, jitter_threshold);
    let human = human_score(candidate);
    let audio = audio_score(candidate);
    let (narrative_value, narrative_signals) = super::asset_safety::narrative_signal_score(
        &candidate.function_label,
        candidate.function_score,
        &candidate.person_state_label,
        &candidate.transcript_text,
        &candidate.tag_text,
        candidate.unexpected_chapter,
    );
    let narrative = if narrative_signals.is_empty() {
        missing_axis(
            "P3-D5 narrative safety signals",
            "尚无真实反应、转写情绪词、unique_event 或 unexpected 章节证据。",
        )
    } else {
        AxisScore {
            score: Some(narrative_value),
            confidence: if narrative_value >= 1.0 { 1.0 } else { 0.82 },
            source: "P3-D5 reaction+emotion+unique_event".to_owned(),
            note: format!(
                "Narrative Override Technical Quality：{}；unique_event 使用一票否决式加权。",
                narrative_signals.join("、")
            ),
        }
    };
    let mut total = weighted_total(
        [
            (&technical, weights.technical),
            (&composition, weights.composition),
            (&motion, weights.motion),
            (&human, weights.human),
            (&audio, weights.audio),
            (&narrative, weights.narrative),
        ],
        preference_boost,
    );
    if candidate.safety_flag == "rescue_candidate" {
        total = total.max(0.85);
    }
    BestTakeBreakdown {
        technical,
        composition,
        motion,
        human,
        audio,
        narrative,
        configured_weights: weights.clone(),
        preference_boost,
        total,
    }
}

fn technical_score(candidate: &Candidate) -> AxisScore {
    let focus_scores = candidate
        .focus_scores_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<Vec<f64>>(json).ok())
        .unwrap_or_default();
    let mut parts = Vec::new();
    if !focus_scores.is_empty() {
        let mean = focus_scores.iter().copied().sum::<f64>() / focus_scores.len() as f64;
        parts.push((mean / (SOFT_FOCUS_THRESHOLD * 2.0)).clamp(0.0, 1.0));
    }
    if let Some(yavg) = candidate.exposure_yavg {
        let dark_penalty = if yavg < DARK_YAVG_THRESHOLD {
            yavg / DARK_YAVG_THRESHOLD
        } else {
            1.0
        };
        parts.push(dark_penalty.clamp(0.0, 1.0));
    }
    if let Some(overexposed) = candidate.overexposed_ratio {
        parts.push(
            (1.0 - overexposed / OVEREXPOSED_RATIO_THRESHOLD.max(f64::EPSILON))
                .clamp(0.0, 1.0),
        );
    }
    let score = mean(&parts);
    AxisScore {
        score,
        confidence: confidence(parts.len(), 3),
        source: "L1 focus+exposure+overexposure".to_owned(),
        note: "对焦、曝光与过曝比例的本地数值合成；果冻、污染与遮挡尚无独立检测器。"
            .to_owned(),
    }
}

fn motion_score(candidate: &Candidate, jitter_threshold: f64) -> AxisScore {
    let Some(shake) = candidate.shake_score else {
        return missing_axis("C6 motion", "等待运镜分析。 ");
    };
    let start = candidate
        .motion_metadata
        .as_deref()
        .and_then(|metadata| parse_metric(metadata, "start_shake"));
    let end = candidate
        .motion_metadata
        .as_deref()
        .and_then(|metadata| parse_metric(metadata, "end_shake"));
    let threshold = jitter_threshold.clamp(0.01, 2.0);
    let overall = (1.0 - shake / (threshold * 3.0)).clamp(0.0, 1.0);
    let endpoint = match (start, end) {
        (Some(start), Some(end)) => {
            (1.0 - (start - end).abs() / (threshold * 2.0)).clamp(0.0, 1.0)
        }
        _ => overall,
    };
    AxisScore {
        score: Some(overall * 0.65 + endpoint * 0.35),
        confidence: match (start, end, candidate.motion_sample_pairs.unwrap_or(0)) {
            (Some(_), Some(_), pairs) if pairs >= 6 => 1.0,
            (Some(_), Some(_), pairs) if pairs >= 3 => 0.75,
            (Some(_), Some(_), _) => 0.45,
            _ => 0.35,
        },
        source: "C6 shake+endpoint delta".to_owned(),
        note: "综合全段抖动与首尾抖动分差；速度和 Handle 余量待时间窗特征校准。".to_owned(),
    }
}

fn human_score(candidate: &Candidate) -> AxisScore {
    if candidate.subject_label != HUMAN_SUBJECT && candidate.function_label != HUMAN_FUNCTION {
        return AxisScore {
            score: None,
            confidence: 0.0,
            source: "Chinese-CLIP human proxy".to_owned(),
            note: "非人物镜头，此轴不参与归一化。".to_owned(),
        };
    }
    let state_adjustment = match candidate.person_state_label.as_str() {
        "自然反应" | "互动" | "观察" => 0.08,
        "不确定" => -0.08,
        _ => 0.0,
    };
    let function_score = if candidate.function_label == HUMAN_FUNCTION {
        candidate.function_score
    } else {
        candidate.subject_score
    };
    let score = ((candidate.subject_score + candidate.person_state_score + function_score) / 3.0
        + state_adjustment)
        .clamp(0.0, 1.0);
    AxisScore {
        score: Some(score),
        confidence: ((candidate.subject_score + candidate.person_state_score + function_score) / 3.0)
            .clamp(0.0, 1.0),
        source: "Chinese-CLIP subject+person_state".to_owned(),
        note: "启发式代理：主体与人物状态原型分近似表情自然度；不宣称识别真实情绪。"
            .to_owned(),
    }
}

fn audio_score(candidate: &Candidate) -> AxisScore {
    let Some(has_audio) = candidate.has_audio else {
        return missing_axis("L1 astats+ASR proxy", "等待音频分析。 ");
    };
    if !has_audio {
        return AxisScore {
            score: Some(0.35),
            confidence: 1.0,
            source: "L1 stream probe".to_owned(),
            note: "无音轨不是废片；仅表示此镜头不能贡献同期声。".to_owned(),
        };
    }
    let dynamic_range = candidate
        .analysis_metadata_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<Value>(json).ok())
        .and_then(|value| {
            value
                .pointer("/signals/audio_dynamic_range_db")
                .and_then(Value::as_f64)
        });
    let astats = dynamic_range
        .map(|range| (range / 24.0).clamp(0.0, 1.0))
        .unwrap_or(0.5);
    let peak = candidate
        .audio_peak_db
        .map(|db| if db > -0.1 { 0.2 } else { 1.0 })
        .unwrap_or(0.5);
    let clipping = if candidate.audio_clipped == Some(true) { 0.0 } else { 1.0 };
    let clarity = transcript_clarity_proxy(
        &candidate.transcript_text,
        candidate.transcript_ticks,
        candidate.duration_ticks,
    );
    AxisScore {
        score: Some((astats * 0.30 + peak * 0.15 + clipping * 0.20 + clarity * 0.35).clamp(0.0, 1.0)),
        confidence: if dynamic_range.is_some() { 0.85 } else { 0.65 },
        source: "ffmpeg astats+transcript clarity proxy".to_owned(),
        note: "转写覆盖与有效字符率仅作清晰度代理；风噪和独特 Natural Sound 待样本校准。"
            .to_owned(),
    }
}

fn proxy_axis(values: &[f64], source: &str, note: &str) -> AxisScore {
    let usable = values
        .iter()
        .copied()
        .filter(|value| value.is_finite() && *value > 0.0)
        .collect::<Vec<_>>();
    AxisScore {
        score: mean(&usable),
        confidence: mean(&usable).unwrap_or(0.0),
        source: source.to_owned(),
        note: note.to_owned(),
    }
}

fn missing_axis(source: &str, note: &str) -> AxisScore {
    AxisScore {
        score: None,
        confidence: 0.0,
        source: source.to_owned(),
        note: note.trim().to_owned(),
    }
}

fn weighted_total<const N: usize>(axes: [(&AxisScore, f64); N], boost: f64) -> f64 {
    let (weighted, available_weight) = axes.iter().fold(
        (0.0, 0.0),
        |(weighted, available_weight), (axis, weight)| match axis.score {
            Some(score) if weight.is_finite() && *weight > 0.0 => (
                weighted + score.clamp(0.0, 1.0) * *weight,
                available_weight + *weight,
            ),
            _ => (weighted, available_weight),
        },
    );
    let base = if available_weight > 0.0 {
        weighted / available_weight
    } else {
        0.0
    };
    (base + boost.clamp(0.0, MAX_PREFERENCE_BOOST)).clamp(0.0, 1.0)
}

fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

fn confidence(available: usize, expected: usize) -> f64 {
    if expected == 0 {
        0.0
    } else {
        (available as f64 / expected as f64).clamp(0.0, 1.0)
    }
}

fn transcript_clarity_proxy(text: &str, transcript_ticks: i64, duration_ticks: i64) -> f64 {
    let total = text.chars().filter(|character| !character.is_whitespace()).count();
    let valid = text
        .chars()
        .filter(|character| character.is_alphanumeric() || is_cjk(*character))
        .count();
    let valid_ratio = if total == 0 {
        0.0
    } else {
        valid as f64 / total as f64
    };
    let coverage = if duration_ticks <= 0 {
        0.0
    } else {
        transcript_ticks.max(0) as f64 / duration_ticks as f64
    }
    .clamp(0.0, 1.0);
    (valid_ratio * 0.55 + coverage * 0.45).clamp(0.0, 1.0)
}

fn is_cjk(character: char) -> bool {
    matches!(character as u32, 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff)
}

fn parse_metric(metadata: &str, key: &str) -> Option<f64> {
    metadata
        .split(';')
        .find_map(|part| part.strip_prefix(&format!("{key}=")))?
        .split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

fn member_rank(user_state: &str) -> u8 {
    match user_state {
        "hero" => 0,
        "locked" => 1,
        "auto" => 2,
        "rejected" => 3,
        _ => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};
    use std::path::Path;

    fn axis(score: Option<f64>) -> AxisScore {
        AxisScore {
            score,
            confidence: 1.0,
            source: "test".to_owned(),
            note: "test".to_owned(),
        }
    }

    fn insert_clip(connection: &Connection, id: i64, subject: &str, function: &str) {
        connection
            .execute(
                "INSERT OR IGNORE INTO volumes(uuid, label) VALUES ('v', 'test')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(
                    id, volume_uuid, rel_path, tb_num, tb_den, duration_ticks,
                    imported_at, missing_since, episode_id
                 ) VALUES (
                    ?1, 'v', ?2, 1, 1000, 10000, '2026-09-01T12:00:00Z', NULL,
                    (SELECT id FROM episodes WHERE status = 'active')
                 )",
                params![id, format!("clip-{id}.mov")],
            )
            .unwrap();
        for (dimension, label, score) in [
            ("subject", subject, 0.8),
            ("function", function, 0.8),
            ("shot_size", "广角", 0.7),
            ("viewpoint", "平视", 0.7),
            ("person_state", "自然反应", 0.7),
            ("movement", "Static", 0.9),
        ] {
            connection
                .execute(
                    "INSERT INTO clip_dimensions(clip_id, dimension, label, score, source)
                     VALUES (?1, ?2, ?3, ?4, 'test')",
                    params![id, dimension, label, score],
                )
                .unwrap();
        }
    }

    fn database() -> (TestDirectory, Connection) {
        let directory = TestDirectory::new();
        db::initialize(&directory.db_path()).unwrap();
        let connection = db::open_project(&directory.db_path()).unwrap();
        (directory, connection)
    }

    fn record_three_episode_memory(connection: &Connection, channel_path: &Path) {
        for number in 1_i64..=3 {
            let (clip_id, memory_id) = if number == 1 {
                (
                    1,
                    connection
                        .query_row(
                            "SELECT memory_id FROM episodes WHERE status='active'",
                            [],
                            |row| row.get::<_, String>(0),
                        )
                        .unwrap(),
                )
            } else {
                let memory_id = format!("{number:032x}");
                connection
                    .execute(
                        "INSERT INTO episodes(
                            title, theme, created_at, status, archived_at, episode_number, memory_id
                         ) VALUES (?1, '', 'now', 'archived', 'now', ?2, ?3)",
                        params![format!("EP{number:02}"), number, memory_id],
                    )
                    .unwrap();
                let episode_id = connection.last_insert_rowid();
                let clip_id = number;
                insert_clip(connection, clip_id, "风景", "Atmosphere");
                connection
                    .execute(
                        "UPDATE clips SET episode_id=?2 WHERE id=?1",
                        params![clip_id, episode_id],
                    )
                    .unwrap();
                (clip_id, memory_id)
            };
            crate::core::channel_memory::record_successful_export(
                connection,
                channel_path,
                &memory_id,
                &[crate::core::channel_memory::ExportedSelection {
                    clip_id,
                    segment_id: None,
                    in_ticks: 0,
                    out_ticks: 10_000,
                }],
            )
            .unwrap();
        }
    }

    #[test]
    fn orientation_and_information_are_quality_exempt_information_stacks() {
        assert_eq!(stack_type("细节", "Orientation"), StackType::Information);
        assert!(stack_type("细节", "Information").quality_exempt());
    }

    #[test]
    fn human_subject_or_function_never_becomes_visual_stack() {
        assert_eq!(stack_type("人", "Experience"), StackType::Human);
        assert_eq!(stack_type("风景", "Human-Reaction"), StackType::Human);
    }

    #[test]
    fn ordinary_visual_classification_is_explicit() {
        assert_eq!(stack_type("风景", "Atmosphere"), StackType::Visual);
        assert!(!stack_type("风景", "Atmosphere").quality_exempt());
    }

    #[test]
    fn channel_routine_visual_lowers_the_best_take_narrative_axis() {
        let (_directory, mut connection) = database();
        insert_clip(&connection, 1, "风景", "Atmosphere");
        rebuild(&mut connection).unwrap();
        let before = list(&connection).unwrap().remove(0).members.remove(0);
        let channel_path = crate::core::channel_memory::channel_path_for_project(&connection).unwrap();
        record_three_episode_memory(&connection, &channel_path);
        let after = list(&connection).unwrap().remove(0).members.remove(0);
        assert!(after.long_term_memory.routine_visual);
        assert!(
            after.score_breakdown.narrative.score.unwrap()
                < before.score_breakdown.narrative.score.unwrap()
        );
        assert!(after.best_take_score.unwrap() < before.best_take_score.unwrap());
    }

    #[test]
    fn novel_location_adds_back_narrative_value_for_a_routine_visual() {
        let (_directory, mut connection) = database();
        insert_clip(&connection, 1, "风景", "Atmosphere");
        connection.execute(
            "UPDATE clips SET gps_lat=43.65, gps_lon=-79.38 WHERE id=1",
            [],
        ).unwrap();
        rebuild(&mut connection).unwrap();
        let channel_path = crate::core::channel_memory::channel_path_for_project(&connection).unwrap();
        record_three_episode_memory(&connection, &channel_path);
        connection.execute(
            "UPDATE clips SET gps_lat=64.06, gps_lon=-139.43 WHERE id=1",
            [],
        ).unwrap();
        let member = list(&connection).unwrap().remove(0).members.remove(0);
        assert!(member.long_term_memory.novelty_context);
        assert_eq!(member.long_term_memory.narrative_adjustment, 0.10);
        assert!(member.score_breakdown.narrative.note.contains("Novelty"));
    }

    #[test]
    fn missing_narrative_axis_is_removed_from_weight_denominator() {
        let present = axis(Some(0.8));
        let missing = axis(None);
        assert_eq!(weighted_total([(&present, 1.0), (&missing, 9.0)], 0.0), 0.8);
    }

    #[test]
    fn rescore_applies_new_weights_without_rebuilding_membership_or_state() {
        let (_directory, mut connection) = database();
        insert_clip(&connection, 1, "风景", "Atmosphere");
        rebuild(&mut connection).unwrap();
        let before = list(&connection).unwrap().remove(0);
        set_user_state(&mut connection, before.id, 1, None, "locked").unwrap();
        settings::set_setting(
            &connection,
            settings::BEST_TAKE_TECHNICAL_WEIGHT_KEY,
            "1.0",
        ).unwrap();

        assert_eq!(rescore(&mut connection).unwrap(), 1);
        let after = list(&connection).unwrap().remove(0);
        assert_eq!(after.id, before.id);
        assert_eq!(after.members[0].user_state, "locked");
        assert_eq!(after.members[0].score_breakdown.configured_weights.technical, 1.0);
    }

    #[test]
    fn weight_setting_rolls_back_when_rescore_cannot_complete() {
        let (_directory, mut connection) = database();
        insert_clip(&connection, 1, "风景", "Atmosphere");
        rebuild(&mut connection).unwrap();
        connection.execute(
            "UPDATE shot_stack_members SET score_breakdown_json = '{}'",
            [],
        ).unwrap();
        let before = settings::string_value(
            &connection,
            settings::BEST_TAKE_TECHNICAL_WEIGHT_KEY,
            "0.28",
        ).unwrap();

        assert!(update_weight_and_rescore(
            &mut connection,
            settings::BEST_TAKE_TECHNICAL_WEIGHT_KEY,
            "0.91",
        ).is_err());
        assert_eq!(
            settings::string_value(
                &connection,
                settings::BEST_TAKE_TECHNICAL_WEIGHT_KEY,
                "0.28",
            ).unwrap(),
            before,
        );
    }

    #[test]
    fn preference_boost_is_bounded() {
        let present = axis(Some(0.9));
        assert_eq!(weighted_total([(&present, 1.0)], 0.5), 1.0);
    }

    #[test]
    fn endpoint_delta_rewards_balanced_start_and_end_stability() {
        let candidate = Candidate {
            clip_id: 1,
            chapter_id: None,
            chapter_title: None,
            subject_label: "风景".to_owned(),
            subject_score: 0.8,
            function_label: "Atmosphere".to_owned(),
            function_score: 0.8,
            shot_size_label: "广角".to_owned(),
            shot_size_score: 0.8,
            viewpoint_label: "平视".to_owned(),
            viewpoint_score: 0.8,
            person_state_label: UNKNOWN_LABEL.to_owned(),
            person_state_score: 0.0,
            movement_label: "Static".to_owned(),
            time_stage_label: UNKNOWN_LABEL.to_owned(),
            sound_label: UNKNOWN_LABEL.to_owned(),
            similar_group_id: None,
            exposure_yavg: None,
            overexposed_ratio: None,
            audio_peak_db: None,
            audio_clipped: None,
            has_audio: None,
            focus_scores_json: None,
            analysis_metadata_json: None,
            shake_score: Some(0.1),
            motion_sample_pairs: Some(6),
            motion_metadata: Some("v;start_shake=0.1;end_shake=0.1".to_owned()),
            transcript_text: String::new(),
            transcript_ticks: 0,
            duration_ticks: 1,
            tag_text: String::new(),
            unexpected_chapter: false,
            safety_flag: "normal".to_owned(),
        };
        let balanced = motion_score(&candidate, 0.6).score.unwrap();
        let uneven = motion_score(&Candidate {
            motion_metadata: Some("v;start_shake=0.0;end_shake=1.0".to_owned()),
            ..candidate
        }, 0.6)
        .score
        .unwrap();
        assert!(balanced > uneven);
    }

    #[test]
    fn transcript_clarity_proxy_uses_valid_characters_and_coverage() {
        assert!(transcript_clarity_proxy("冰原大道 93", 800, 1000) > 0.8);
        assert!(transcript_clarity_proxy("!!!", 0, 1000) < 0.1);
    }

    #[test]
    fn rescue_candidate_gets_narrative_override_floor() {
        let (_directory, mut connection) = database();
        insert_clip(&connection, 1, "人", "Human-Reaction");
        connection.execute(
            "UPDATE clips SET safety_flag = 'rescue_candidate' WHERE id = 1",
            [],
        ).unwrap();

        rebuild(&mut connection).unwrap();
        let member = &list(&connection).unwrap()[0].members[0];

        assert!(member.score_breakdown.narrative.score.unwrap() >= 0.8);
        assert!(member.score_breakdown.total >= 0.85);
    }

    #[test]
    fn unique_event_tag_populates_narrative_axis() {
        let (_directory, mut connection) = database();
        insert_clip(&connection, 1, "风景", "Atmosphere");
        connection.execute(
            "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind)
             VALUES (1, 0, 10000, 'whole')",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO tags(segment_id, label, source)
             VALUES (1, 'unique_event:熊', 'user')",
            [],
        ).unwrap();

        rebuild(&mut connection).unwrap();
        let member = &list(&connection).unwrap()[0].members[0];

        assert_eq!(member.score_breakdown.narrative.score, Some(1.0));
        assert!(member.score_breakdown.narrative.note.contains("unique_event"));
    }

    #[test]
    fn hero_and_lock_override_auto_score_without_deleting_rejected() {
        assert!(member_rank("hero") < member_rank("locked"));
        assert!(member_rank("locked") < member_rank("auto"));
        assert!(member_rank("auto") < member_rank("rejected"));
    }

    #[test]
    fn matching_scene_and_four_semantic_axes_fold_together() {
        let (_directory, mut connection) = database();
        insert_clip(&connection, 1, "风景", "Atmosphere");
        insert_clip(&connection, 2, "风景", "Atmosphere");

        assert_eq!(rebuild(&mut connection).unwrap(), 1);
        assert_eq!(list(&connection).unwrap()[0].members.len(), 2);
    }

    #[test]
    fn a_different_shot_size_splits_the_stack() {
        let (_directory, mut connection) = database();
        insert_clip(&connection, 1, "风景", "Atmosphere");
        insert_clip(&connection, 2, "风景", "Atmosphere");
        connection.execute(
            "UPDATE clip_dimensions SET label = '特写'
             WHERE clip_id = 2 AND dimension = 'shot_size'",
            [],
        ).unwrap();
        connection.execute("INSERT INTO similar_groups(id, created_at) VALUES (9, 'now')", []).unwrap();
        connection.execute("INSERT INTO similar_group_members(group_id, clip_id, is_primary) VALUES (9, 1, 1), (9, 2, 0)", []).unwrap();

        assert_eq!(rebuild(&mut connection).unwrap(), 2);
    }

    #[test]
    fn a_different_motion_class_splits_the_stack() {
        let (_directory, mut connection) = database();
        insert_clip(&connection, 1, "风景", "Atmosphere");
        insert_clip(&connection, 2, "风景", "Atmosphere");
        connection.execute(
            "UPDATE clip_dimensions SET label = 'Pan'
             WHERE clip_id = 2 AND dimension = 'movement'",
            [],
        ).unwrap();
        connection.execute("INSERT INTO similar_groups(id, created_at) VALUES (10, 'now')", []).unwrap();
        connection.execute("INSERT INTO similar_group_members(group_id, clip_id, is_primary) VALUES (10, 1, 1), (10, 2, 0)", []).unwrap();

        assert_eq!(rebuild(&mut connection).unwrap(), 2);
    }

    #[test]
    fn a_different_scene_signal_splits_the_stack() {
        let (_directory, mut connection) = database();
        insert_clip(&connection, 1, "风景", "Atmosphere");
        insert_clip(&connection, 2, "风景", "Atmosphere");
        connection.execute(
            "INSERT INTO chapters(id, title, start_at, end_at, episode_id)
             SELECT 1, 'A', '2026-09-01T10:00:00Z', '2026-09-01T10:10:00Z', id
               FROM episodes WHERE status = 'active'
             UNION ALL
             SELECT 2, 'B', '2026-09-01T11:00:00Z', '2026-09-01T11:10:00Z', id
               FROM episodes WHERE status = 'active'",
            [],
        ).unwrap();
        connection.execute("UPDATE clips SET chapter_id = id WHERE id IN (1, 2)", []).unwrap();
        connection.execute("INSERT INTO similar_groups(id, created_at) VALUES (11, 'now')", []).unwrap();
        connection.execute("INSERT INTO similar_group_members(group_id, clip_id, is_primary) VALUES (11, 1, 1), (11, 2, 0)", []).unwrap();

        assert_eq!(rebuild(&mut connection).unwrap(), 2);
    }

    #[test]
    fn c4_groups_are_signals_and_do_not_become_stack_boundaries() {
        let (_directory, mut connection) = database();
        insert_clip(&connection, 1, "风景", "Atmosphere");
        insert_clip(&connection, 2, "风景", "Atmosphere");
        connection.execute("INSERT INTO similar_groups(id, created_at) VALUES (20, 'now'), (21, 'now')", []).unwrap();
        connection.execute("INSERT INTO similar_group_members(group_id, clip_id, is_primary) VALUES (20, 1, 1), (21, 2, 1)", []).unwrap();

        assert_eq!(rebuild(&mut connection).unwrap(), 1);
        let stack = list(&connection).unwrap().remove(0);
        assert_eq!(stack.members.len(), 2);
        assert!(stack.members.iter().all(|member| {
            member
                .score_breakdown
                .composition
                .source
                .contains("C4 视觉近似信号")
        }));
    }

    #[test]
    fn information_and_human_clips_cannot_enter_an_ordinary_visual_stack() {
        let (_directory, mut connection) = database();
        insert_clip(&connection, 1, "细节", "Information");
        insert_clip(&connection, 2, "人", "Experience");
        insert_clip(&connection, 3, "风景", "Atmosphere");
        connection.execute("INSERT INTO similar_groups(id, created_at) VALUES (8, 'now')", []).unwrap();
        connection.execute("INSERT INTO similar_group_members(group_id, clip_id, is_primary) VALUES (8, 1, 1), (8, 2, 0), (8, 3, 0)", []).unwrap();

        rebuild(&mut connection).unwrap();
        let stacks = list(&connection).unwrap();
        assert_eq!(stacks.len(), 3);
        assert_eq!(stacks.iter().filter(|stack| stack.stack_type == "visual").count(), 1);
        assert!(stacks.iter().filter(|stack| stack.quality_exempt).all(|stack| stack.members.len() == 1));
    }

    #[test]
    fn locked_state_survives_a_rebuild_and_records_feedback() {
        let (_directory, mut connection) = database();
        insert_clip(&connection, 1, "风景", "Atmosphere");
        rebuild(&mut connection).unwrap();
        let stack = list(&connection).unwrap().remove(0);
        set_user_state(&mut connection, stack.id, 1, None, "locked").unwrap();
        rebuild(&mut connection).unwrap();
        let rebuilt = list(&connection).unwrap().remove(0);
        assert_eq!(rebuilt.members[0].user_state, "locked");
        let selections: i64 = connection.query_row(
            "SELECT selection_count FROM shot_stack_preferences",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(selections, 1);
    }

    #[test]
    fn rejected_member_remains_persisted_and_hero_replaces_a_lock() {
        let (_directory, mut connection) = database();
        insert_clip(&connection, 1, "风景", "Atmosphere");
        insert_clip(&connection, 2, "风景", "Atmosphere");
        connection.execute("INSERT INTO similar_groups(id, created_at) VALUES (12, 'now')", []).unwrap();
        connection.execute("INSERT INTO similar_group_members(group_id, clip_id, is_primary) VALUES (12, 1, 1), (12, 2, 0)", []).unwrap();
        rebuild(&mut connection).unwrap();
        let stack = list(&connection).unwrap().remove(0);

        set_user_state(&mut connection, stack.id, 1, None, "locked").unwrap();
        set_user_state(&mut connection, stack.id, 2, None, "hero").unwrap();
        set_user_state(&mut connection, stack.id, 1, None, "rejected").unwrap();
        let stack = list(&connection).unwrap().remove(0);

        assert_eq!(stack.members.len(), 2);
        assert_eq!(stack.members[0].clip_id, 2);
        assert_eq!(stack.members[0].user_state, "hero");
        assert_eq!(stack.members[1].user_state, "rejected");
    }

    #[test]
    fn an_all_rejected_stack_has_no_preferred_member() {
        let (_directory, mut connection) = database();
        insert_clip(&connection, 1, "风景", "Atmosphere");
        rebuild(&mut connection).unwrap();
        let stack = list(&connection).unwrap().remove(0);

        set_user_state(&mut connection, stack.id, 1, None, "rejected").unwrap();
        let stack = list(&connection).unwrap().remove(0);

        assert_eq!(stack.members[0].user_state, "rejected");
        assert!(!stack.members[0].is_preferred);
    }

    #[test]
    fn rejected_state_survives_offline_volume_rebuilds() {
        let (_directory, mut connection) = database();
        insert_clip(&connection, 1, "风景", "Atmosphere");
        rebuild(&mut connection).unwrap();
        let stack = list(&connection).unwrap().remove(0);
        set_user_state(&mut connection, stack.id, 1, None, "rejected").unwrap();
        connection
            .execute(
                "UPDATE clips SET missing_since = '2026-09-01T13:00:00Z' WHERE id = 1",
                [],
            )
            .unwrap();

        rebuild(&mut connection).unwrap();
        let rebuilt = list(&connection).unwrap().remove(0);

        assert_eq!(rebuilt.members[0].user_state, "rejected");
        assert!(!rebuilt.members[0].is_preferred);
    }

    #[test]
    fn archived_episode_stack_state_survives_active_episode_rebuild() {
        let (_directory, mut connection) = database();
        insert_clip(&connection, 1, "风景", "Atmosphere");
        rebuild(&mut connection).unwrap();
        let first_stack = list(&connection).unwrap()[0].id;
        set_user_state(&mut connection, first_stack, 1, None, "rejected").unwrap();
        let first_episode = active_episode_id(&connection).unwrap();
        crate::core::episode::archive_current(&mut connection, Some("EP02")).unwrap();

        insert_clip(&connection, 2, "风景", "Atmosphere");
        rebuild(&mut connection).unwrap();
        let active_stacks = list(&connection).unwrap();
        assert_eq!(
            active_stacks
                .iter()
                .flat_map(|stack| stack.members.iter().map(|member| member.clip_id))
                .collect::<Vec<_>>(),
            vec![2]
        );
        let historical_state: String = connection
            .query_row(
                "SELECT member.user_state
                   FROM shot_stack_members member
                   JOIN shot_stacks stack ON stack.id = member.stack_id
                   JOIN scenes scene ON scene.id = stack.scene_id
                  WHERE scene.episode_id = ?1 AND member.clip_id = 1",
                [first_episode],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(historical_state, "rejected");
        assert!(set_user_state(&mut connection, first_stack, 1, None, "hero").is_err());
    }

    #[test]
    fn scene_name_uses_signal_title_and_dominant_dimensions() {
        let candidate = Candidate {
            clip_id: 1,
            chapter_id: Some(2),
            chapter_title: Some("冰原大道".to_owned()),
            subject_label: "风景".to_owned(),
            subject_score: 1.0,
            function_label: "Establishing".to_owned(),
            function_score: 1.0,
            shot_size_label: "广角".to_owned(),
            shot_size_score: 1.0,
            viewpoint_label: "平视".to_owned(),
            viewpoint_score: 1.0,
            person_state_label: UNKNOWN_LABEL.to_owned(),
            person_state_score: 0.0,
            movement_label: "Static".to_owned(),
            time_stage_label: "路上".to_owned(),
            sound_label: "Natural Sound".to_owned(),
            similar_group_id: None,
            exposure_yavg: None,
            overexposed_ratio: None,
            audio_peak_db: None,
            audio_clipped: None,
            has_audio: None,
            focus_scores_json: None,
            analysis_metadata_json: None,
            shake_score: None,
            motion_sample_pairs: None,
            motion_metadata: None,
            transcript_text: String::new(),
            transcript_ticks: 0,
            duration_ticks: 1,
            tag_text: String::new(),
            unexpected_chapter: false,
            safety_flag: "normal".to_owned(),
        };
        assert_eq!(
            scene_name(Some(2), &[&candidate]),
            "冰原大道 · 主体=风景 · 功能=Establishing · 景别=广角 · 视角=平视 · 运镜=Static · 阶段=路上 · 声音=Natural Sound"
        );
    }
}
