use std::collections::{BTreeMap, BTreeSet, HashSet};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::channel_memory::{DhGuardSummary, DhPlannedSlot, RoutineSuggestion};
use super::error::{CoreError, Result};
use super::jobs;
use super::settings::{self, LLM_ENABLED_KEY};

const TIME_GAP_SECONDS: i64 = 45 * 60;
const GPS_GAP_KM: f64 = 2.0;
const MAX_TRANSCRIPT_CHARS: usize = 240;

pub const CHAPTER_KINDS: [&str; 10] = [
    "destination",
    "attraction",
    "journey",
    "experience",
    "rv_life",
    "people",
    "unexpected",
    "information",
    "atmosphere",
    "transition",
];

pub const STORY_SLOTS: [&str; 9] = [
    "DH INTRO",
    "MAP",
    "REAL/ESTABLISHING",
    "REAL/EXPERIENCE",
    "REAL/DETAIL",
    "DH OVERLAY",
    "REAL/HUMAN",
    "ATMOSPHERE",
    "TRANSITION",
];

pub const COVERAGE_ITEMS: [&str; 13] = [
    "Establishing",
    "到达入口",
    "地理位置",
    "Hero Shot",
    "Wide",
    "Medium",
    "Detail",
    "Human Scale",
    "Experience",
    "Natural Sound",
    "Information Source",
    "Personal Reaction",
    "Exit-Transition",
];

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NarrativeOverview {
    pub episode: NarrativeEpisode,
    pub chapters: Vec<NarrativeChapter>,
    pub destination_cards: Vec<DestinationCard>,
    pub boundary_signals: Vec<BoundarySignal>,
    pub job_status: Option<String>,
    pub dh_guard: DhGuardSummary,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NarrativeEpisode {
    pub id: i64,
    pub title: String,
    pub theme: String,
    pub created_at: String,
    /// 生成这版 revision 用的模板 id（如 "cinematic"）；LLM 路径未指定模板、
    /// 或旧数据没有这一列时为 None。
    pub template: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NarrativeChapter {
    pub id: i64,
    pub kind: String,
    pub title: String,
    pub order: i64,
    pub promoted: bool,
    pub score: f64,
    pub rationale: String,
    pub promotion_reason: String,
    pub story_slots: Vec<String>,
    pub missing_slots: Vec<String>,
    pub digital_human_plan: Option<DigitalHumanPlan>,
    pub beats: Vec<NarrativeBeat>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NarrativeBeat {
    pub id: i64,
    pub clip_id: i64,
    pub segment_id: Option<i64>,
    pub role: String,
    pub order: i64,
    pub score: f64,
    pub rationale: String,
    pub routine_suggestion: Option<RoutineSuggestion>,
    /// 人工已把该 clip 标记为「非 Routine」(routine_override.cleared)。
    /// routine_suggestion 在这种情况下会被 apply() 抹成 None,前端仅凭
    /// routine_suggestion 无法区分「AI 本就没建议」与「AI 建议被人工清除」——
    /// 后者必须仍能显示恢复入口,否则清除后不可逆（回归修复）。
    pub routine_cleared: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DigitalHumanPlan {
    pub mode: String,
    pub reason: String,
    pub planned_slots: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CoverageItem {
    pub item: String,
    pub covered: bool,
    pub evidence: String,
    pub suggestion: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DestinationCard {
    pub id: i64,
    pub chapter_id: i64,
    pub name: String,
    pub geo_context: String,
    pub highlights: String,
    pub why_visit: String,
    pub personal_note: String,
    pub sources: Vec<ModelSource>,
    pub verified: bool,
    pub coverage: Vec<CoverageItem>,
    #[serde(default)]
    pub field_states: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModelSource {
    pub label: String,
    pub basis: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BoundarySignal {
    pub before_clip_id: i64,
    pub after_clip_id: i64,
    pub score: f64,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NarrativeDraft {
    pub episode_title: String,
    pub episode_theme: String,
    pub chapters: Vec<NarrativeChapterDraft>,
    pub downgrades: Vec<RoutineDowngradeDraft>,
    pub destination_cards: Vec<DestinationCardDraft>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RoutineDowngradeDraft {
    pub clip_id: i64,
    pub segment_id: Option<i64>,
    pub role: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NarrativeChapterDraft {
    pub kind: String,
    pub title: String,
    pub promoted: bool,
    pub promotion_reason: String,
    pub score: f64,
    pub rationale: String,
    pub beats: Vec<NarrativeBeatDraft>,
    pub story_slots: Vec<String>,
    pub missing_slots: Vec<String>,
    pub digital_human_plan: Option<DigitalHumanPlan>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NarrativeBeatDraft {
    pub clip_id: i64,
    pub segment_id: Option<i64>,
    pub role: String,
    pub score: f64,
    pub rationale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DestinationCardDraft {
    pub chapter_order: usize,
    pub name: String,
    pub geo_context: String,
    pub highlights: String,
    pub why_visit: String,
    pub personal_note: String,
    pub sources: Vec<ModelSource>,
    pub coverage: Vec<CoverageItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NarratePayload {
    episode_id: i64,
    input_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    template: Option<StoryTemplate>,
}

#[derive(Debug, Clone)]
struct PromptClip {
    clip_id: i64,
    segment_id: Option<i64>,
    captured_at: Option<String>,
    epoch: Option<i64>,
    gps_lat: Option<f64>,
    gps_lon: Option<f64>,
    duration_seconds: f64,
    transcript: String,
    dimensions: BTreeMap<String, Value>,
    shot_stack: Option<Value>,
}

/// LLM 排队一个异步任务时返回 job id；LLM 关闭时同步落地兜底草稿并返回
/// suggested revision id。两个空间都是整数主键,不能互认,靠这个 tag 区分。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EnqueueOutcome {
    Job { id: i64 },
    Revision { id: i64 },
}

impl EnqueueOutcome {
    /// 仅供内部/测试按原始整数比对使用；生产代码应匹配 `kind` 而不是拆开这层区分。
    pub fn id(&self) -> i64 {
        match self {
            EnqueueOutcome::Job { id } | EnqueueOutcome::Revision { id } => *id,
        }
    }
}

pub fn enqueue(connection: &mut Connection) -> Result<EnqueueOutcome> {
    enqueue_with_template(connection, None)
}

/// 按模板编排。启用 LLM 时排队 narrate_episode 任务并返回 job id；
/// 未启用 LLM 时不再报错，而是同步跑确定性兜底并落地 suggested revision，返回 revision id。
pub fn enqueue_with_template(
    connection: &mut Connection,
    template: Option<StoryTemplate>,
) -> Result<EnqueueOutcome> {
    if settings::string_value(connection, LLM_ENABLED_KEY, "false")? != "true" {
        let draft = build_fallback_draft(connection, template)?;
        let id = persist_draft_with_template(connection, &draft, template)?;
        return Ok(EnqueueOutcome::Revision { id });
    }
    let episode_id = active_episode_id(connection)?;
    let active = connection
        .query_row(
            "SELECT id FROM jobs
             WHERE kind = 'narrate_episode' AND status IN ('pending', 'running')
               AND json_extract(payload, '$.episode_id') = ?1
             ORDER BY id DESC LIMIT 1",
            [episode_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if let Some(job_id) = active {
        return Err(CoreError::Story(format!(
            "叙事编排任务 #{job_id} 已在进行；未重复占用 L3 账本"
        )));
    }
    let input = prompt_input_for_episode(connection, episode_id)?;
    let input_bytes = serde_json::to_vec(&input)
        .map_err(|error| CoreError::Story(format!("叙事输入序列化失败：{error}")))?;
    let input_hash = blake3::hash(&input_bytes).to_hex().to_string();
    let payload = serde_json::to_string(&NarratePayload {
        episode_id,
        input_hash: input_hash.clone(),
        template,
    })
    .map_err(|error| CoreError::Story(format!("叙事任务序列化失败：{error}")))?;
    let id = jobs::enqueue(
        connection,
        "narrate_episode",
        &payload,
        &format!(
            "narrate:{episode_id}:{input_hash}:{}",
            template.map_or("none", StoryTemplate::as_str)
        ),
    )?;
    Ok(EnqueueOutcome::Job { id })
}

/// 任务里记录的模板；LLM 路径据此前置 prompt 预设。
pub fn job_template(payload: &str) -> Result<Option<StoryTemplate>> {
    let payload: NarratePayload = serde_json::from_str(payload)
        .map_err(|error| CoreError::Story(format!("narrate_episode payload 无效：{error}")))?;
    Ok(payload.template)
}

pub fn validate_job_input(connection: &Connection, payload: &str) -> Result<Value> {
    let payload: NarratePayload = serde_json::from_str(payload)
        .map_err(|error| CoreError::Story(format!("narrate_episode payload 无效：{error}")))?;
    let active_episode = active_episode_id(connection)?;
    if active_episode != payload.episode_id {
        return Err(CoreError::Story(
            "叙事任务所属 Episode 已封存；拒绝用旧任务覆盖当前故事板".to_owned(),
        ));
    }
    let input = prompt_input_for_episode(connection, payload.episode_id)?;
    let bytes = serde_json::to_vec(&input)
        .map_err(|error| CoreError::Story(format!("叙事输入序列化失败：{error}")))?;
    let current_hash = blake3::hash(&bytes).to_hex().to_string();
    if current_hash != payload.input_hash {
        return Err(CoreError::Story(
            "叙事任务输入已变化；拒绝用旧摘要覆盖当前故事板".to_owned(),
        ));
    }
    Ok(input)
}

pub fn prompt_input(connection: &Connection) -> Result<Value> {
    let episode_id = active_episode_id(connection)?;
    prompt_input_for_episode(connection, episode_id)
}

fn prompt_input_for_episode(connection: &Connection, episode_id: i64) -> Result<Value> {
    let clips = load_prompt_clips(connection, episode_id)?;
    if clips.is_empty() {
        return Err(CoreError::Story(
            "故事板没有已收藏或已选片段，无法编排 Episode".to_owned(),
        ));
    }
    let clip_values = clips
        .iter()
        .map(|clip| {
            json!({
                "clip_id": clip.clip_id,
                "segment_id": clip.segment_id,
                "duration_seconds": clip.duration_seconds,
                "dimensions": clip.dimensions,
                "shot_stack": clip.shot_stack,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "clips": clip_values,
        "chapter_kinds": CHAPTER_KINDS,
        "story_slots": STORY_SLOTS,
        "destination_coverage_items": COVERAGE_ITEMS,
        "rules": {
            "signals_are_not_chapters": true,
            "routine_rv_content_defaults_to_montage_or_transition": true,
            "digital_human_is_planning_only": true,
            "reality_first_for_strong_real_events": true,
            "destination_facts_are_unverified_drafts": true,
            "routine_first_occurrence_treatment": "explained",
            "routine_repeat_treatment": "montage_or_transition",
            "routine_change_treatment": "story_event",
            "routine_suggestions_are_non_binding": true,
            "routine_visual_narrative_adjustment": -0.20,
            "novelty_narrative_adjustment": 0.10,
            "novel_location_or_abnormal_weather_restores_novelty": true,
            "minimum_real_slots_between_dh_appearances": 2,
            "merge_adjacent_dh_knowledge_points": true,
            "dh_total_duration_warning_seconds": super::channel_memory::DH_DURATION_WARNING_SECONDS
        }
    }))
}

pub fn validate_draft(connection: &Connection, draft: &mut NarrativeDraft) -> Result<()> {
    let input = prompt_input(connection)?;
    validate_draft_for_input(draft, &input)
}

pub fn validate_draft_for_input(draft: &mut NarrativeDraft, input: &Value) -> Result<()> {
    draft.episode_title = clean_required(&draft.episode_title, 120, "Episode 标题")?;
    draft.episode_theme = clean_required(&draft.episode_theme, 240, "Episode 主题")?;
    if draft.chapters.is_empty() || draft.chapters.len() > 40 {
        return Err(CoreError::Llm("章节数量须为 1–40".to_owned()));
    }

    let allowed_items = input
        .get("clips")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::Llm("叙事输入缺少 clips".to_owned()))?
        .iter()
        .map(|clip| {
            let clip_id = clip
                .get("clip_id")
                .and_then(Value::as_i64)
                .ok_or_else(|| CoreError::Llm("叙事输入 clip_id 无效".to_owned()))?;
            let segment_id = clip.get("segment_id").and_then(Value::as_i64);
            Ok((clip_id, segment_id))
        })
        .collect::<Result<HashSet<_>>>()?;
    let mut used_items = HashSet::new();
    for chapter in &mut draft.chapters {
        if !CHAPTER_KINDS.contains(&chapter.kind.as_str()) {
            return Err(CoreError::Llm(format!("未知叙事单元 kind：{}", chapter.kind)));
        }
        chapter.title = clean_required(&chapter.title, 120, "Chapter 标题")?;
        chapter.rationale = clean_required(&chapter.rationale, 600, "Chapter 分章依据")?;
        chapter.promotion_reason = clean_text(&chapter.promotion_reason, 600, "升级理由")?;
        validate_score(chapter.score, "Chapter score")?;
        if chapter.promoted && chapter.promotion_reason.is_empty() {
            return Err(CoreError::Llm("promoted Chapter 必须给出升级理由".to_owned()));
        }
        if chapter.beats.is_empty() {
            return Err(CoreError::Llm("每个 Chapter 至少包含一个 Beat".to_owned()));
        }
        validate_slots(&chapter.story_slots, "story_slots")?;
        validate_slots(&chapter.missing_slots, "missing_slots")?;
        if let Some(plan) = &mut chapter.digital_human_plan {
            if !matches!(plan.mode.as_str(), "A" | "B" | "C" | "D" | "E") {
                return Err(CoreError::Llm(format!("未知数字人模式：{}", plan.mode)));
            }
            plan.reason = clean_required(&plan.reason, 400, "数字人规划依据")?;
            validate_slots(&plan.planned_slots, "digital_human_plan.planned_slots")?;
            if chapter.kind == "unexpected" && plan.mode != "E" {
                return Err(CoreError::Llm(
                    "强真实/意外事件如规划数字人，必须使用 E Reality First".to_owned(),
                ));
            }
        }
        for beat in &mut chapter.beats {
            if !matches!(beat.role.as_str(), "beat" | "montage" | "transition") {
                return Err(CoreError::Llm(format!("未知 Beat role：{}", beat.role)));
            }
            validate_score(beat.score, "Beat score")?;
            beat.rationale = clean_required(&beat.rationale, 600, "Beat 依据")?;
            let key = (beat.clip_id, beat.segment_id);
            if !allowed_items.contains(&key) {
                return Err(CoreError::Llm(format!(
                    "Beat 引用了非当前精选：clip={} segment={:?}",
                    beat.clip_id, beat.segment_id
                )));
            }
            if !used_items.insert(key) {
                return Err(CoreError::Llm(format!(
                    "同一精选不能重复进入多个 Beat：clip={} segment={:?}",
                    beat.clip_id, beat.segment_id
                )));
            }
        }
    }
    if used_items != allowed_items {
        return Err(CoreError::Llm(
            "章节成员必须完整且不重复地覆盖当前故事板精选".to_owned(),
        ));
    }

    let downgraded_beats = draft
        .chapters
        .iter()
        .flat_map(|chapter| &chapter.beats)
        .filter(|beat| matches!(beat.role.as_str(), "montage" | "transition"))
        .map(|beat| ((beat.clip_id, beat.segment_id), beat.role.as_str()))
        .collect::<BTreeMap<_, _>>();
    let mut listed_downgrades = BTreeMap::new();
    for downgrade in &mut draft.downgrades {
        if !matches!(downgrade.role.as_str(), "montage" | "transition") {
            return Err(CoreError::Llm(format!("降级清单 role 无效：{}", downgrade.role)));
        }
        downgrade.reason = clean_required(&downgrade.reason, 600, "降级理由")?;
        let key = (downgrade.clip_id, downgrade.segment_id);
        if listed_downgrades.insert(key, downgrade.role.as_str()).is_some() {
            return Err(CoreError::Llm("降级清单包含重复精选".to_owned()));
        }
    }
    if downgraded_beats != listed_downgrades {
        return Err(CoreError::Llm(
            "重复性内容降级清单必须与 montage/transition Beat 完全一致".to_owned(),
        ));
    }

    for card in &mut draft.destination_cards {
        if card.chapter_order >= draft.chapters.len() {
            return Err(CoreError::Llm(format!(
                "Destination Card chapter_order {} 越界",
                card.chapter_order
            )));
        }
        card.name = clean_required(&card.name, 120, "地点名称")?;
        card.geo_context = clean_text(&card.geo_context, 1_200, "地理背景")?;
        card.highlights = clean_text(&card.highlights, 1_200, "地点特点")?;
        card.why_visit = clean_text(&card.why_visit, 1_200, "为什么值得来")?;
        card.personal_note = clean_text(&card.personal_note, 1_200, "个人体验")?;
        if card.sources.is_empty() || card.sources.len() > 20 {
            return Err(CoreError::Llm(
                "Destination Card sources 必须包含 1–20 项模型自述依据".to_owned(),
            ));
        }
        for source in &mut card.sources {
            source.label = clean_required(&source.label, 160, "来源标签")?;
            source.basis = clean_required(&source.basis, 600, "来源依据")?;
        }
        validate_coverage(&mut card.coverage)?;
    }
    Ok(())
}

pub fn persist_draft(connection: &mut Connection, draft: &NarrativeDraft) -> Result<()> {
    persist_draft_guarded(connection, draft, None, None).map(|_| ())
}

/// 落地并记录这版是按哪套模板生成的；返回新建的 suggested revision id。
pub fn persist_draft_with_template(
    connection: &mut Connection,
    draft: &NarrativeDraft,
    template: Option<StoryTemplate>,
) -> Result<i64> {
    persist_draft_guarded(connection, draft, None, template)
}

pub fn persist_draft_for_job(
    connection: &mut Connection,
    draft: &NarrativeDraft,
    job_payload: &str,
) -> Result<()> {
    let payload: NarratePayload = serde_json::from_str(job_payload)
        .map_err(|error| CoreError::Story(format!("narrate_episode payload 无效：{error}")))?;
    let template = payload.template;
    persist_draft_guarded(connection, draft, Some(&payload), template).map(|_| ())
}

fn persist_draft_guarded(
    connection: &mut Connection,
    draft: &NarrativeDraft,
    expected: Option<&NarratePayload>,
    template: Option<StoryTemplate>,
) -> Result<i64> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let episode_id = active_episode_id(&transaction)?;
    if expected.is_some_and(|payload| payload.episode_id != episode_id) {
        return Err(CoreError::Story(
            "编排期间当前 Episode 已变化；已拒绝把旧输入写入新集".to_owned(),
        ));
    }
    let current_input = prompt_input_for_episode(&transaction, episode_id)?;
    if let Some(payload) = expected {
        let input_bytes = serde_json::to_vec(&current_input)
            .map_err(|error| CoreError::Story(format!("叙事输入序列化失败：{error}")))?;
        if blake3::hash(&input_bytes).to_hex().to_string() != payload.input_hash {
            return Err(CoreError::Story(
                "叙事调用期间输入已变化；拒绝保存过期的模型结果".to_owned(),
            ));
        }
    }
    let input_clips = load_prompt_clips(&transaction, episode_id)?;
    let boundaries = boundary_signals(&input_clips);
    // episodes 是生产集，AI 编排不再清空重建；
    // 产物落 suggested revision,挂当前 active 集。重跑只替换未被 confirmed
    // 引用的旧 suggested,confirmed(人工确认版)永不触碰。
    transaction.execute(
        "DELETE FROM narrative_boundary_signals WHERE episode_id = ?1",
        [episode_id],
    )?;
    transaction.execute(
        "DELETE FROM narrative_revisions
          WHERE episode_id = ?1 AND kind = 'suggested'
            AND id NOT IN (
                SELECT based_on_revision_id FROM narrative_revisions
                 WHERE based_on_revision_id IS NOT NULL
            )",
        [episode_id],
    )?;
    transaction.execute(
        "INSERT INTO narrative_revisions(episode_id, kind, title, theme, template, created_at)
         VALUES (?1, 'suggested', ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![
            episode_id,
            draft.episode_title,
            draft.episode_theme,
            template.map(StoryTemplate::as_str),
        ],
    )?;
    let revision_id = transaction.last_insert_rowid();

    for boundary in boundaries {
        let reasons = serde_json::to_string(&boundary.reasons)
            .map_err(|error| CoreError::Story(format!("边界依据序列化失败：{error}")))?;
        transaction.execute(
            "INSERT INTO narrative_boundary_signals(
                episode_id, before_clip_id, after_clip_id, score, reasons_json
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![episode_id, boundary.before_clip_id, boundary.after_clip_id, boundary.score, reasons],
        )?;
    }

    let mut chapter_ids = Vec::with_capacity(draft.chapters.len());
    for (chapter_order, chapter) in draft.chapters.iter().enumerate() {
        let slots = to_json(&chapter.story_slots, "story_slots")?;
        let missing = to_json(&chapter.missing_slots, "missing_slots")?;
        let dh_plan = to_json(&chapter.digital_human_plan, "digital_human_plan")?;
        transaction.execute(
            "INSERT INTO narrative_chapters(
                episode_id, revision_id, kind, title, \"order\", promoted, score, rationale,
                promotion_reason, story_slots_json, missing_slots_json, dh_plan_json
             ) VALUES (?1, ?12, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                episode_id,
                chapter.kind,
                chapter.title,
                chapter_order as i64,
                if chapter.promoted { 1_i64 } else { 0_i64 },
                chapter.score,
                chapter.rationale,
                chapter.promotion_reason,
                slots,
                missing,
                dh_plan,
                revision_id,
            ],
        )?;
        let chapter_id = transaction.last_insert_rowid();
        chapter_ids.push(chapter_id);
        for (beat_order, beat) in chapter.beats.iter().enumerate() {
            transaction.execute(
                "INSERT INTO narrative_beats(
                    chapter_id, clip_id, segment_id, role, \"order\", score, rationale
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    chapter_id,
                    beat.clip_id,
                    beat.segment_id,
                    beat.role,
                    beat_order as i64,
                    beat.score,
                    beat.rationale,
                ],
            )?;
        }
    }

    for card in &draft.destination_cards {
        let sources = to_json(&card.sources, "Destination Card sources")?;
        let coverage = to_json(&card.coverage, "Destination Card coverage")?;
        transaction.execute(
            "INSERT INTO destination_cards(
                chapter_id, name, geo_context, highlights, why_visit, personal_note,
                sources_json, verified, coverage_json, created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8,
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             )",
            params![
                chapter_ids[card.chapter_order],
                card.name,
                card.geo_context,
                card.highlights,
                card.why_visit,
                card.personal_note,
                sources,
                coverage,
            ],
        )?;
    }

    transaction.commit()?;
    // 新建/重跑 suggested revision 后顺带检一遍缺口;detect() 是幂等的单事务,
    // 失败也不该拖垮编排本身,但目前没有已知失败路径值得吞掉,直接冒泡。
    super::story_gap::detect(connection)?;
    Ok(revision_id)
}

pub fn load_overview(connection: &Connection) -> Result<Option<NarrativeOverview>> {
    // 读取权威 = 当前 active 集的 confirmed revision，否则最新 suggested。
    let Some(active_episode) = connection
        .query_row(
            "SELECT id FROM episodes WHERE status = 'active'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
    else {
        return Ok(None);
    };
    load_overview_for_episode(connection, active_episode)
}

pub fn load_overview_for_episode(
    connection: &Connection,
    episode_id: i64,
) -> Result<Option<NarrativeOverview>> {
    let Some(revision_id) =
        super::narrative_revision::active_revision_id(connection, episode_id)?
    else {
        return Ok(None);
    };
    let episode = connection
        .query_row(
            "SELECT r.episode_id, r.title, r.theme, r.created_at, r.template
             FROM narrative_revisions r WHERE r.id = ?1",
            [revision_id],
            |row| {
                Ok(NarrativeEpisode {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    theme: row.get(2)?,
                    created_at: row.get(3)?,
                    template: row.get(4)?,
                })
            },
        )
        .optional()?;
    let Some(episode) = episode else {
        return Ok(None);
    };

    let mut statement = connection.prepare(
        "SELECT id, kind, title, \"order\", promoted, score, rationale,
                promotion_reason, story_slots_json, missing_slots_json, dh_plan_json
         FROM narrative_chapters WHERE revision_id = ?1 ORDER BY \"order\", id",
    )?;
    let rows = statement.query_map([revision_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)? == 1,
            row.get::<_, f64>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, String>(8)?,
            row.get::<_, String>(9)?,
            row.get::<_, String>(10)?,
        ))
    })?;
    let mut chapters = Vec::new();
    for row in rows {
        let row = row?;
        chapters.push(NarrativeChapter {
            id: row.0,
            kind: row.1,
            title: row.2,
            order: row.3,
            promoted: row.4,
            score: row.5,
            rationale: row.6,
            promotion_reason: row.7,
            story_slots: from_json(&row.8, "story_slots_json")?,
            missing_slots: from_json(&row.9, "missing_slots_json")?,
            digital_human_plan: from_json(&row.10, "dh_plan_json")?,
            beats: load_beats(connection, row.0)?,
        });
    }
    let current_refs = selected_item_refs(connection, episode_id)?;
    let narrative_refs = chapters
        .iter()
        .flat_map(|chapter| &chapter.beats)
        .map(|beat| (beat.clip_id, beat.segment_id))
        .collect::<HashSet<_>>();
    if current_refs != narrative_refs {
        return Ok(None);
    }
    let memory_reader = super::channel_memory::ChannelMemoryReader::for_project(connection)?;
    annotate_beats(connection, &memory_reader, &mut chapters)?;
    let planned_dh_slots = chapters
        .iter()
        .flat_map(|chapter| {
            chapter
                .digital_human_plan
                .iter()
                .flat_map(|plan| {
                    let mut slots = plan
                        .planned_slots
                        .iter()
                        .filter(|slot| slot.starts_with("DH"))
                        .cloned()
                        .collect::<Vec<_>>();
                    if slots.is_empty() {
                        slots.push(
                            super::channel_memory::default_dh_slot_for_mode(&plan.mode).to_owned(),
                        );
                    }
                    slots.sort_by_key(|slot| {
                        STORY_SLOTS
                            .iter()
                            .position(|candidate| *candidate == slot.as_str())
                            .unwrap_or(STORY_SLOTS.len())
                    });
                    slots.into_iter().map(|slot| DhPlannedSlot {
                            chapter_title: chapter.title.clone(),
                            mode: plan.mode.clone(),
                            slot,
                        })
                })
        })
        .collect::<Vec<_>>();
    let dh_guard = super::channel_memory::dh_guard(connection, &planned_dh_slots)?;
    Ok(Some(NarrativeOverview {
        destination_cards: load_cards(connection, episode.id)?,
        boundary_signals: load_boundaries(connection, episode.id)?,
        job_status: latest_job_status(connection)?,
        dh_guard,
        episode,
        chapters,
    }))
}

fn selected_item_refs(
    connection: &Connection,
    episode_id: i64,
) -> Result<HashSet<(i64, Option<i64>)>> {
    let mut statement = connection.prepare(&format!(
        "WITH live_selects AS (
             SELECT id, clip_id FROM segments
             WHERE kind = 'select' AND tombstone = 0
         )
         SELECT c.id, live.id
         FROM clips c JOIN live_selects live ON live.clip_id = c.id
         WHERE c.missing_since IS NULL
           AND c.kind = 'video'
           AND (c.episode_id = ?1 OR c.episode_id IS NULL)
         UNION ALL
         SELECT c.id, NULL
         FROM clips c
         WHERE c.missing_since IS NULL
           AND c.kind = 'video'
           AND (c.episode_id = ?1 OR c.episode_id IS NULL)
           AND NOT EXISTS (SELECT 1 FROM live_selects live WHERE live.clip_id = c.id)
           AND {candidate}",
        candidate = super::story::whole_clip_candidate_predicate("c")
    ))?;
    let rows = statement.query_map([episode_id], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?))
    })?;
    rows.collect::<rusqlite::Result<HashSet<_>>>()
        .map_err(CoreError::from)
}


const DESTINATION_FIELDS: &[&str] = &["geo_context", "highlights", "why_visit", "personal_note"];

/// 逐字段核实:state ∈ pending/verified/rejected;整卡 verified = 四字段全 verified。
pub fn set_destination_field_state(
    connection: &Connection,
    card_id: i64,
    field: &str,
    state: &str,
) -> Result<()> {
    if !DESTINATION_FIELDS.contains(&field) {
        return Err(CoreError::Story(format!("未知地点卡字段:{field}")));
    }
    if !matches!(state, "pending" | "verified" | "rejected") {
        return Err(CoreError::Story(format!("未知核实状态:{state}")));
    }
    let raw: String = connection
        .query_row(
            "SELECT card.field_states_json
               FROM destination_cards card
               JOIN narrative_chapters chapter ON chapter.id = card.chapter_id
               JOIN episodes episode ON episode.id = chapter.episode_id
              WHERE card.id = ?1 AND episode.status = 'active'",
            [card_id],
            |row| row.get(0),
        )
        .map_err(|_| CoreError::Story(format!("地点卡 {card_id} 不存在")))?;
    let mut states: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&raw).unwrap_or_default();
    states.insert(field.to_owned(), serde_json::Value::String(state.to_owned()));
    let all_verified = DESTINATION_FIELDS.iter().all(|name| {
        states.get(*name).and_then(|value| value.as_str()) == Some("verified")
    });
    let changed = connection.execute(
        "UPDATE destination_cards
            SET field_states_json = ?1, verified = ?2,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?3
            AND chapter_id IN (
                SELECT chapter.id FROM narrative_chapters chapter
                JOIN episodes episode ON episode.id = chapter.episode_id
                WHERE episode.status = 'active'
            )",
        params![
            serde_json::Value::Object(states).to_string(),
            all_verified as i64,
            card_id
        ],
    )?;
    if changed == 1 {
        Ok(())
    } else {
        Err(CoreError::Story(format!(
            "地点卡 {card_id} 不存在或属于历史集"
        )))
    }
}

pub fn update_destination_card(
    connection: &Connection,
    card_id: i64,
    name: &str,
    geo_context: &str,
    highlights: &str,
    why_visit: &str,
    personal_note: &str,
) -> Result<()> {
    let name = clean_required(name, 120, "地点名称")?;
    let geo_context = clean_text(geo_context, 1_200, "地理背景")?;
    let highlights = clean_text(highlights, 1_200, "地点特点")?;
    let why_visit = clean_text(why_visit, 1_200, "为什么值得来")?;
    let personal_note = clean_text(personal_note, 1_200, "个人体验")?;
    let pending_states = serde_json::json!({
        "geo_context": "pending",
        "highlights": "pending",
        "why_visit": "pending",
        "personal_note": "pending"
    })
    .to_string();
    let changed = connection.execute(
        "UPDATE destination_cards
         SET name = ?2, geo_context = ?3, highlights = ?4, why_visit = ?5,
             personal_note = ?6, verified = 0, field_states_json = ?7,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1
           AND chapter_id IN (
               SELECT chapter.id FROM narrative_chapters chapter
               JOIN episodes episode ON episode.id = chapter.episode_id
               WHERE episode.status = 'active'
           )",
        params![card_id, name, geo_context, highlights, why_visit, personal_note, pending_states],
    )?;
    if changed == 1 {
        Ok(())
    } else {
        Err(CoreError::Story(format!(
            "Destination Card {card_id} 不存在或属于历史集"
        )))
    }
}

pub fn set_destination_verified(connection: &Connection, card_id: i64, verified: bool) -> Result<()> {
    let raw: String = connection
        .query_row(
            "SELECT card.field_states_json
               FROM destination_cards card
               JOIN narrative_chapters chapter ON chapter.id = card.chapter_id
               JOIN episodes episode ON episode.id = chapter.episode_id
              WHERE card.id = ?1 AND episode.status = 'active'",
            [card_id],
            |row| row.get(0),
        )
        .map_err(|_| CoreError::Story(format!("Destination Card {card_id} 不存在或属于历史集")))?;
    let mut states: serde_json::Map<String, Value> = serde_json::from_str(&raw).unwrap_or_default();
    if verified && !DESTINATION_FIELDS.iter().all(|field| {
        states.get(*field).and_then(Value::as_str) == Some("verified")
    }) {
        return Err(CoreError::Story(
            "必须逐字段核实地理背景、特点、到访理由和个人体验后，整卡才可标记已核实"
                .to_owned(),
        ));
    }
    if !verified {
        for field in DESTINATION_FIELDS {
            states.insert((*field).to_owned(), Value::String("pending".to_owned()));
        }
    }
    let changed = connection.execute(
        "UPDATE destination_cards
         SET verified = ?2, field_states_json = ?3,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1
           AND chapter_id IN (
               SELECT chapter.id FROM narrative_chapters chapter
               JOIN episodes episode ON episode.id = chapter.episode_id
               WHERE episode.status = 'active'
           )",
        params![card_id, if verified { 1_i64 } else { 0_i64 }, Value::Object(states).to_string()],
    )?;
    if changed == 1 {
        Ok(())
    } else {
        Err(CoreError::Story(format!(
            "Destination Card {card_id} 不存在或属于历史集"
        )))
    }
}

fn load_prompt_clips(connection: &Connection, episode_id: i64) -> Result<Vec<PromptClip>> {
    let mut statement = connection.prepare(&format!(
        "WITH live_selects AS (
             SELECT id, clip_id, in_ticks, out_ticks
             FROM segments WHERE kind = 'select' AND tombstone = 0
         ), selected AS (
             SELECT c.id AS clip_id, live.id AS segment_id, c.rel_path, c.captured_at,
                    CAST(strftime('%s', c.captured_at) AS INTEGER) AS epoch,
                    c.gps_lat, c.gps_lon, live.in_ticks, live.out_ticks,
                    COALESCE(c.tb_num, 0) AS tb_num, COALESCE(c.tb_den, 0) AS tb_den
             FROM clips c JOIN live_selects live ON live.clip_id = c.id
             WHERE c.missing_since IS NULL
               AND c.kind = 'video'
               AND (c.episode_id = ?1 OR c.episode_id IS NULL)
             UNION ALL
             SELECT c.id, NULL, c.rel_path, c.captured_at,
                    CAST(strftime('%s', c.captured_at) AS INTEGER),
                    c.gps_lat, c.gps_lon, 0, COALESCE(c.duration_ticks, 0),
                    COALESCE(c.tb_num, 0), COALESCE(c.tb_den, 0)
             FROM clips c
             WHERE c.missing_since IS NULL
               AND c.kind = 'video'
               AND (c.episode_id = ?1 OR c.episode_id IS NULL)
               AND NOT EXISTS (SELECT 1 FROM live_selects live WHERE live.clip_id = c.id)
               AND {candidate}
         )
         SELECT selected.clip_id, selected.segment_id, selected.rel_path,
                selected.captured_at, selected.epoch, selected.gps_lat, selected.gps_lon,
                selected.in_ticks, selected.out_ticks, selected.tb_num, selected.tb_den,
                COALESCE((
                    SELECT GROUP_CONCAT(text, ' ') FROM transcript_segments transcript
                    WHERE transcript.clip_id = selected.clip_id
                ), '')
         FROM selected
         LEFT JOIN story_order story
           ON story.tombstone = 0 AND story.clip_id = selected.clip_id
          AND ((selected.segment_id IS NULL AND story.item_kind = 'whole')
            OR story.segment_id = selected.segment_id)
         ORDER BY story.position IS NULL, story.position,
                  selected.epoch IS NULL, selected.epoch,
                  selected.clip_id, selected.in_ticks, selected.segment_id",
        candidate = super::story::whole_clip_candidate_predicate("c")
    ))?;
    let rows = statement.query_map([episode_id], |row| {
        let _path: String = row.get(2)?;
        let in_ticks: i64 = row.get(7)?;
        let out_ticks: i64 = row.get(8)?;
        let tb_num: i64 = row.get(9)?;
        let tb_den: i64 = row.get(10)?;
        Ok(PromptClip {
            clip_id: row.get(0)?,
            segment_id: row.get(1)?,
            // Keep reading rel_path in this local query for schema/index stability,
            // but never retain or serialize it into the LLM prompt.
            captured_at: row.get(3)?,
            epoch: row.get(4)?,
            gps_lat: row.get(5)?,
            gps_lon: row.get(6)?,
            duration_seconds: if tb_num > 0 && tb_den > 0 {
                (out_ticks - in_ticks).max(0) as f64 * tb_num as f64 / tb_den as f64
            } else {
                0.0
            },
            transcript: truncate_chars(&row.get::<_, String>(11)?, MAX_TRANSCRIPT_CHARS),
            dimensions: BTreeMap::new(),
            shot_stack: None,
        })
    })?;
    let mut clips = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    for clip in &mut clips {
        clip.dimensions = load_dimensions(connection, clip.clip_id)?;
        clip.shot_stack = load_stack_summary(connection, clip.clip_id, clip.segment_id)?;
    }
    Ok(clips)
}

fn active_episode_id(connection: &Connection) -> Result<i64> {
    connection
        .query_row(
            "SELECT id FROM episodes WHERE status = 'active'",
            [],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| CoreError::Story("没有进行中的集，无法编排 Episode".to_owned()))
}

fn load_dimensions(connection: &Connection, clip_id: i64) -> Result<BTreeMap<String, Value>> {
    let mut statement = connection.prepare(
        "SELECT dimension, label, score, source FROM clip_dimensions
         WHERE clip_id = ?1 ORDER BY dimension",
    )?;
    let rows = statement.query_map([clip_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            json!({
                "label": row.get::<_, String>(1)?,
                "score": row.get::<_, f64>(2)?,
                "source": row.get::<_, String>(3)?,
            }),
        ))
    })?;
    rows.collect::<rusqlite::Result<BTreeMap<_, _>>>()
        .map_err(CoreError::from)
}

fn load_stack_summary(connection: &Connection, clip_id: i64, segment_id: Option<i64>) -> Result<Option<Value>> {
    connection
        .query_row(
            "SELECT stack.id, stack.subject_label, stack.function_label,
                    member.best_take_score, member.score_breakdown_json, member.user_state
             FROM shot_stack_members member
             JOIN shot_stacks stack ON stack.id = member.stack_id
             WHERE member.clip_id = ?1
               AND ((?2 IS NULL AND member.segment_id IS NULL) OR member.segment_id = ?2)
             LIMIT 1",
            params![clip_id, segment_id],
            |row| {
                let breakdown: String = row.get(4)?;
                Ok(json!({
                    "stack_id": row.get::<_, i64>(0)?,
                    "subject": row.get::<_, String>(1)?,
                    "function": row.get::<_, String>(2)?,
                    "best_take_score": row.get::<_, Option<f64>>(3)?,
                    "score_breakdown": serde_json::from_str::<Value>(&breakdown).unwrap_or(Value::Null),
                    "user_state": row.get::<_, String>(5)?,
                }))
            },
        )
        .optional()
        .map_err(CoreError::from)
}

fn boundary_signals(clips: &[PromptClip]) -> Vec<BoundarySignal> {
    clips
        .windows(2)
        .filter_map(|pair| {
            let before = &pair[0];
            let after = &pair[1];
            let mut score = 0.0_f64;
            let mut reasons = Vec::new();
            if let (Some(left), Some(right)) = (before.epoch, after.epoch) {
                let gap = right - left;
                if gap > TIME_GAP_SECONDS {
                    score += 0.40;
                    reasons.push(format!("时间断档 {} 分钟", gap / 60));
                }
            }
            if before.captured_at.as_deref().and_then(|value| value.get(0..10))
                != after.captured_at.as_deref().and_then(|value| value.get(0..10))
                && before.captured_at.is_some()
                && after.captured_at.is_some()
            {
                score += 0.65;
                reasons.push("拍摄日期变化".to_owned());
            }
            if let Some(distance) = distance_km(before, after) {
                if distance > GPS_GAP_KM {
                    score += 0.35;
                    reasons.push(format!("GPS 位移约 {:.1} km", distance));
                }
            }
            let left_stage = dimension_label(before, "time_stage");
            let right_stage = dimension_label(after, "time_stage");
            if left_stage.is_some() && right_stage.is_some() && left_stage != right_stage {
                score += 0.20;
                reasons.push(format!(
                    "时间阶段 {}→{}",
                    left_stage.unwrap_or("不确定"),
                    right_stage.unwrap_or("不确定")
                ));
            }
            let left_keywords = topic_keywords(&before.transcript);
            let right_keywords = topic_keywords(&after.transcript);
            if !left_keywords.is_empty()
                && !right_keywords.is_empty()
                && left_keywords.is_disjoint(&right_keywords)
            {
                score += 0.35;
                reasons.push("相邻转写无重叠关键词".to_owned());
            }
            (!reasons.is_empty()).then(|| BoundarySignal {
                before_clip_id: before.clip_id,
                after_clip_id: after.clip_id,
                score: score.min(1.0),
                reasons,
            })
        })
        .collect()
}

fn dimension_label<'a>(clip: &'a PromptClip, dimension: &str) -> Option<&'a str> {
    clip.dimensions
        .get(dimension)
        .and_then(|value| value.get("label"))
        .and_then(Value::as_str)
        .filter(|label| *label != "不确定")
}

fn topic_keywords(text: &str) -> BTreeSet<String> {
    let mut keywords = BTreeSet::new();
    let han = text.chars().filter(|character| is_han(*character)).collect::<Vec<_>>();
    for pair in han.windows(2) {
        keywords.insert(pair.iter().collect());
    }
    for word in text
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| word.len() >= 3)
    {
        keywords.insert(word.to_ascii_lowercase());
    }
    keywords
}

fn is_han(character: char) -> bool {
    matches!(character as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF)
}

fn distance_km(left: &PromptClip, right: &PromptClip) -> Option<f64> {
    let (left_lat, left_lon, right_lat, right_lon) = (
        left.gps_lat?, left.gps_lon?, right.gps_lat?, right.gps_lon?,
    );
    if !(-90.0..=90.0).contains(&left_lat)
        || !(-90.0..=90.0).contains(&right_lat)
        || !(-180.0..=180.0).contains(&left_lon)
        || !(-180.0..=180.0).contains(&right_lon)
    {
        return None;
    }
    let latitude_delta = (right_lat - left_lat).to_radians();
    let longitude_delta = (right_lon - left_lon).to_radians();
    let haversine = (latitude_delta / 2.0).sin().powi(2)
        + left_lat.to_radians().cos()
            * right_lat.to_radians().cos()
            * (longitude_delta / 2.0).sin().powi(2);
    Some(6_371.0 * 2.0 * haversine.sqrt().asin())
}

fn validate_slots(slots: &[String], field: &str) -> Result<()> {
    let mut unique = HashSet::new();
    for slot in slots {
        if !STORY_SLOTS.contains(&slot.as_str()) || !unique.insert(slot) {
            return Err(CoreError::Llm(format!("{field} 含未知或重复槽位：{slot}")));
        }
    }
    Ok(())
}

fn validate_coverage(coverage: &mut [CoverageItem]) -> Result<()> {
    if coverage.len() != COVERAGE_ITEMS.len() {
        return Err(CoreError::Llm("Destination Coverage 必须完整包含 13 项".to_owned()));
    }
    let mut actual = BTreeSet::new();
    for item in coverage {
        if !COVERAGE_ITEMS.contains(&item.item.as_str()) || !actual.insert(item.item.clone()) {
            return Err(CoreError::Llm(format!("Coverage 项未知或重复：{}", item.item)));
        }
        item.evidence = clean_text(&item.evidence, 400, "Coverage 依据")?;
        item.suggestion = clean_text(&item.suggestion, 400, "Coverage 补救建议")?;
        if item.covered && item.evidence.is_empty() {
            return Err(CoreError::Llm(format!("已覆盖项 {} 必须给出素材依据", item.item)));
        }
        if !item.covered && item.suggestion.is_empty() {
            return Err(CoreError::Llm(format!("缺口项 {} 必须给出补救建议", item.item)));
        }
    }
    let expected = COVERAGE_ITEMS.iter().map(|item| item.to_string()).collect();
    if actual != expected {
        return Err(CoreError::Llm("Destination Coverage 13 项不完整".to_owned()));
    }
    Ok(())
}

fn validate_score(score: f64, field: &str) -> Result<()> {
    if score.is_finite() && (0.0..=1.0).contains(&score) {
        Ok(())
    } else {
        Err(CoreError::Llm(format!("{field} 必须在 0–1")))
    }
}

fn clean_required(value: &str, max: usize, field: &str) -> Result<String> {
    let value = clean_text(value, max, field)?;
    if value.is_empty() {
        Err(CoreError::Llm(format!("{field} 不能为空")))
    } else {
        Ok(value)
    }
}

fn clean_text(value: &str, max: usize, field: &str) -> Result<String> {
    let value = value.trim();
    if value.chars().count() > max || value.chars().any(char::is_control) {
        Err(CoreError::Llm(format!("{field} 超过长度或含控制字符")))
    } else {
        Ok(value.to_owned())
    }
}

fn to_json<T: Serialize>(value: &T, label: &str) -> Result<String> {
    serde_json::to_string(value)
        .map_err(|error| CoreError::Story(format!("{label} 序列化失败：{error}")))
}

fn from_json<T: for<'de> Deserialize<'de>>(value: &str, label: &str) -> Result<T> {
    serde_json::from_str(value)
        .map_err(|error| CoreError::InvalidSchema(format!("{label} 无效：{error}")))
}

fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn load_beats(connection: &Connection, chapter_id: i64) -> Result<Vec<NarrativeBeat>> {
    let mut statement = connection.prepare(
        "SELECT id, clip_id, segment_id, role, \"order\", score, rationale
         FROM narrative_beats WHERE chapter_id = ?1 ORDER BY \"order\", id",
    )?;
    let rows = statement.query_map([chapter_id], |row| {
        Ok(NarrativeBeat {
            id: row.get(0)?,
            clip_id: row.get(1)?,
            segment_id: row.get(2)?,
            role: row.get(3)?,
            order: row.get(4)?,
            score: row.get(5)?,
            rationale: row.get(6)?,
            routine_suggestion: None,
            routine_cleared: false,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(CoreError::from)
}

fn annotate_beats(
    connection: &Connection,
    memory_reader: &super::channel_memory::ChannelMemoryReader,
    chapters: &mut [NarrativeChapter],
) -> Result<()> {
    for beat in chapters.iter_mut().flat_map(|chapter| &mut chapter.beats) {
        let (in_ticks, out_ticks) = match beat.segment_id {
            Some(segment_id) => connection.query_row(
                "SELECT in_ticks, out_ticks FROM segments WHERE id=?1",
                [segment_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )?,
            None => connection.query_row(
                "SELECT 0, COALESCE(duration_ticks, 0) FROM clips WHERE id=?1",
                [beat.clip_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )?,
        };
        let derived = memory_reader.clip_annotation(
            connection,
            beat.clip_id,
            beat.segment_id,
            in_ticks,
            out_ticks,
        )?
        .routine_suggestion;
        // G4:人工裁量覆盖 AI 建议(cleared 抹除,treatment 重写)。routine_cleared
        // 单独记录「是否被人工清除」,不能只靠 routine_suggestion==None 判断——
        // 那样会跟「AI 本就没建议」混淆,前端就再也拿不到恢复入口（回归修复）。
        let override_record = super::routine_override::override_for(connection, beat.clip_id)?;
        beat.routine_cleared = override_record.as_ref().is_some_and(|record| record.cleared);
        beat.routine_suggestion =
            super::routine_override::apply(connection, beat.clip_id, derived)?;
    }
    Ok(())
}

fn load_cards(connection: &Connection, episode_id: i64) -> Result<Vec<DestinationCard>> {
    let mut statement = connection.prepare(
        "SELECT card.id, card.chapter_id, card.name, card.geo_context, card.highlights,
                card.why_visit, card.personal_note, card.sources_json,
                card.verified, card.coverage_json, card.field_states_json
         FROM destination_cards card
         JOIN narrative_chapters chapter ON chapter.id = card.chapter_id
         WHERE chapter.episode_id = ?1
         ORDER BY chapter.\"order\", card.id",
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
            row.get::<_, String>(7)?,
            row.get::<_, i64>(8)? == 1,
            row.get::<_, String>(9)?,
            row.get::<_, String>(10)?,
        ))
    })?;
    let mut cards = Vec::new();
    for row in rows {
        let row = row?;
        cards.push(DestinationCard {
            id: row.0,
            chapter_id: row.1,
            name: row.2,
            geo_context: row.3,
            highlights: row.4,
            why_visit: row.5,
            personal_note: row.6,
            sources: from_json(&row.7, "sources_json")?,
            verified: row.8,
            coverage: from_json(&row.9, "coverage_json")?,
            field_states: serde_json::from_str(&row.10).unwrap_or_default(),
        });
    }
    Ok(cards)
}

fn load_boundaries(connection: &Connection, episode_id: i64) -> Result<Vec<BoundarySignal>> {
    let mut statement = connection.prepare(
        "SELECT before_clip_id, after_clip_id, score, reasons_json
         FROM narrative_boundary_signals WHERE episode_id = ?1 ORDER BY id",
    )?;
    let rows = statement.query_map([episode_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, f64>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut boundaries = Vec::new();
    for row in rows {
        let row = row?;
        boundaries.push(BoundarySignal {
            before_clip_id: row.0,
            after_clip_id: row.1,
            score: row.2,
            reasons: from_json(&row.3, "reasons_json")?,
        });
    }
    Ok(boundaries)
}

pub fn latest_job_status(connection: &Connection) -> Result<Option<String>> {
    let episode_id = active_episode_id(connection)?;
    connection
        .query_row(
            "SELECT status FROM jobs
              WHERE kind = 'narrate_episode'
                AND json_extract(payload, '$.episode_id') = ?1
              ORDER BY id DESC LIMIT 1",
            [episode_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(CoreError::from)
}

// ---------------------------------------------------------------------------
// R4 Task 4：故事模板。四套模板既是 LLM prompt 预设，也是无 LLM 时的确定性兜底规则。
// ---------------------------------------------------------------------------

/// 兜底分章阈值：边界信号得分达到该值才切一章。
/// 0.65 = 一次拍摄日期变化，或「时间断档 + 位移/话题跳变」的组合；
/// 单靠时间阶段或转写关键词不重叠（0.20/0.35）不足以切章，否则每条素材各成一章，
/// 模板的章内排序会全部落空。
const FALLBACK_BOUNDARY_THRESHOLD: f64 = 0.65;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StoryTemplate {
    Cinematic,
    Fastcut,
    Ambient,
    Diary,
}

impl StoryTemplate {
    pub fn as_str(self) -> &'static str {
        match self {
            StoryTemplate::Cinematic => "cinematic",
            StoryTemplate::Fastcut => "fastcut",
            StoryTemplate::Ambient => "ambient",
            StoryTemplate::Diary => "diary",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "cinematic" => Ok(StoryTemplate::Cinematic),
            "fastcut" => Ok(StoryTemplate::Fastcut),
            "ambient" => Ok(StoryTemplate::Ambient),
            "diary" => Ok(StoryTemplate::Diary),
            other => Err(CoreError::Story(format!("未知故事模板：{other}"))),
        }
    }

    pub fn name_zh(self) -> &'static str {
        match self {
            StoryTemplate::Cinematic => "电影感",
            StoryTemplate::Fastcut => "快节奏",
            StoryTemplate::Ambient => "安静氛围",
            StoryTemplate::Diary => "旅行日记",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct StoryTemplateInfo {
    pub id: &'static str,
    pub name_zh: &'static str,
    pub blurb_zh: &'static str,
}

pub const STORY_TEMPLATES: [StoryTemplateInfo; 4] = [
    StoryTemplateInfo {
        id: "cinematic",
        name_zh: "电影感",
        blurb_zh: "稳定广角开场、目的地揭示、体验推进，收在日落或最长稳定镜头",
    },
    StoryTemplateInfo {
        id: "fastcut",
        name_zh: "快节奏",
        blurb_zh: "最短高能镜头开场，密集蒙太奇，单镜头 1–3 秒",
    },
    StoryTemplateInfo {
        id: "ambient",
        name_zh: "安静氛围",
        blurb_zh: "无人物空镜开场，偏静止或缓慢运镜，少而长的镜头",
    },
    StoryTemplateInfo {
        id: "diary",
        name_zh: "旅行日记",
        blurb_zh: "严格按拍摄时间排列，一条素材一个 Beat",
    },
];

/// 模板的数值参数：进 prompt 供模型遵守，也用于兜底时挑选 Beat。
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct TemplateParams {
    pub beat_min_s: f64,
    pub beat_max_s: f64,
    /// 降级为 montage 的比例（0 = 全部保留为真实 Beat）。
    pub montage_density: f64,
    /// 口播/解说密度建议。
    pub narration_density: f64,
}

pub fn template_params(template: StoryTemplate) -> TemplateParams {
    match template {
        StoryTemplate::Cinematic => TemplateParams {
            beat_min_s: 3.0,
            beat_max_s: 8.0,
            montage_density: 0.35,
            narration_density: 0.50,
        },
        StoryTemplate::Fastcut => TemplateParams {
            beat_min_s: 1.0,
            beat_max_s: 3.0,
            montage_density: 0.75,
            narration_density: 0.25,
        },
        StoryTemplate::Ambient => TemplateParams {
            beat_min_s: 5.0,
            beat_max_s: 12.0,
            montage_density: 0.60,
            narration_density: 0.15,
        },
        StoryTemplate::Diary => TemplateParams {
            beat_min_s: 2.0,
            beat_max_s: 6.0,
            montage_density: 0.0,
            narration_density: 0.70,
        },
    }
}

/// 模板的 prompt 前缀（只描述风格；数值由 `template_params` 单独拼接，避免两处真相）。
pub fn prompt_prefix(template: StoryTemplate) -> &'static str {
    match template {
        StoryTemplate::Cinematic => "本集按「电影感」模板编排：开场必须是稳定的广角或空镜建立镜头，随后揭示目的地，再推进体验，收尾放在日落夜景或最长的稳定镜头。运镜以缓慢推移为主，避免碎剪。",
        StoryTemplate::Fastcut => "本集按「快节奏」模板编排：开场取最短的高能量镜头，整体做密集蒙太奇，单章 Beat 数取到上限，优先短镜头与强运动，长静止镜头一律降级为 montage。",
        StoryTemplate::Ambient => "本集按「安静氛围」模板编排：开场必须是无人物的广角空镜，优先静止或缓慢运镜，镜头少而长，人物与对白让位于环境与自然声。",
        StoryTemplate::Diary => "本集按「旅行日记」模板编排：严格按拍摄时间先后叙述，一条素材一个 Beat，不重排、不做倒叙，语气贴近第一人称记录。",
    }
}

/// 把模板前缀与数值参数拼成一段可直接前置到叙事 prompt 的中文说明。
pub fn prompt_preamble(template: Option<StoryTemplate>) -> String {
    let Some(template) = template else {
        return String::new();
    };
    let params = template_params(template);
    format!(
        "{}\n单个 Beat 时长控制在 {:.0}–{:.0} 秒；蒙太奇降级比例约 {:.0}%；解说密度约 {:.0}%。\n",
        prompt_prefix(template),
        params.beat_min_s,
        params.beat_max_s,
        params.montage_density * 100.0,
        params.narration_density * 100.0,
    )
}

/// 兜底排序用的素材信号。全部来自本地表，不经过任何模型。
#[derive(Debug, Clone)]
struct FallbackClip {
    clip_id: i64,
    segment_id: Option<i64>,
    order_index: usize,
    captured_at: Option<String>,
    duration_seconds: f64,
    technical: f64,
    stability: f64,
    motion_energy: f64,
    shot_size: Option<String>,
    subject: Option<String>,
    function_label: Option<String>,
    person_state: Option<String>,
    time_stage: Option<String>,
}

impl FallbackClip {
    fn is_wide(&self) -> bool {
        matches!(self.shot_size.as_deref(), Some("超广角") | Some("广角"))
    }

    fn has_people(&self) -> bool {
        self.subject.as_deref() == Some("人") || self.person_state.is_some()
    }

    /// 空镜：画面里没有人物主体。
    fn is_empty_scene(&self) -> bool {
        !self.has_people()
    }

    fn is_establishing(&self) -> bool {
        matches!(self.function_label.as_deref(), Some("Establishing") | Some("Orientation"))
    }

    fn is_reveal(&self) -> bool {
        self.is_establishing()
            || matches!(self.subject.as_deref(), Some("建筑") | Some("风景"))
    }

    fn is_experience(&self) -> bool {
        matches!(self.function_label.as_deref(), Some("Experience") | Some("Human-Reaction"))
            || self.person_state.is_some()
    }

    fn is_sunset(&self) -> bool {
        self.time_stage.as_deref() == Some("日落夜景")
    }

    fn label_summary(&self) -> String {
        let mut parts = Vec::new();
        if let Some(size) = &self.shot_size {
            parts.push(size.clone());
        }
        if let Some(subject) = &self.subject {
            parts.push(subject.clone());
        }
        if let Some(function) = &self.function_label {
            parts.push(function.clone());
        }
        if parts.is_empty() {
            "无八维标签".to_owned()
        } else {
            parts.join("/")
        }
    }
}

fn load_fallback_clips(connection: &Connection, clips: &[PromptClip]) -> Result<Vec<FallbackClip>> {
    let mut out = Vec::with_capacity(clips.len());
    for (order_index, clip) in clips.iter().enumerate() {
        let analysis = connection
            .query_row(
                "SELECT exposure_yavg, blur_mean, out_of_focus_ratio, motion_mean
                 FROM clip_analysis WHERE clip_id = ?1",
                [clip.clip_id],
                |row| {
                    Ok((
                        row.get::<_, f64>(0)?,
                        row.get::<_, f64>(1)?,
                        row.get::<_, f64>(2)?,
                        row.get::<_, f64>(3)?,
                    ))
                },
            )
            .optional()?;
        let motion = connection
            .query_row(
                "SELECT class, shake_score FROM clip_motion WHERE clip_id = ?1",
                [clip.clip_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?)),
            )
            .optional()?;

        let mut technical = 0.50_f64;
        let mut motion_energy = 0.0_f64;
        if let Some((exposure, blur, out_of_focus, motion_mean)) = analysis {
            if (60.0..=180.0).contains(&exposure) {
                technical += 0.15;
            } else {
                technical -= 0.10;
            }
            technical += (blur / 100.0).clamp(0.0, 1.0) * 0.20;
            technical -= out_of_focus.clamp(0.0, 1.0) * 0.30;
            motion_energy = motion_mean.max(0.0);
        }
        let mut stability = 0.50_f64;
        if let Some((class, shake)) = &motion {
            stability = (1.0 - (shake / 3.0).clamp(0.0, 1.0)).clamp(0.0, 1.0);
            if class == "static" {
                stability = (stability + 0.30).min(1.0);
                technical += 0.15;
            } else if class == "handheld" {
                technical -= 0.10;
                motion_energy += shake.max(0.0);
            } else {
                motion_energy += 0.5;
            }
        }
        if let Some(label) = dimension_label(clip, "movement") {
            match label {
                "static" => stability = (stability + 0.20).min(1.0),
                "handheld_shaky" => stability = (stability - 0.25).max(0.0),
                _ => {}
            }
        }

        out.push(FallbackClip {
            clip_id: clip.clip_id,
            segment_id: clip.segment_id,
            order_index,
            captured_at: clip.captured_at.clone(),
            duration_seconds: clip.duration_seconds,
            technical: technical.clamp(0.0, 1.0),
            stability,
            motion_energy,
            shot_size: dimension_label(clip, "shot_size").map(str::to_owned),
            subject: dimension_label(clip, "subject").map(str::to_owned),
            function_label: dimension_label(clip, "function").map(str::to_owned),
            person_state: dimension_label(clip, "person_state").map(str::to_owned),
            time_stage: dimension_label(clip, "time_stage").map(str::to_owned),
        });
    }
    Ok(out)
}

/// 用现有边界信号把素材切成章（信号只是候选，达到阈值才切）。
fn fallback_chapters(clips: &[PromptClip]) -> Vec<Vec<usize>> {
    let boundaries = boundary_signals(clips);
    let cut_after = boundaries
        .iter()
        .filter(|signal| signal.score >= FALLBACK_BOUNDARY_THRESHOLD)
        .map(|signal| signal.before_clip_id)
        .collect::<HashSet<_>>();
    let mut chapters: Vec<Vec<usize>> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    for (index, clip) in clips.iter().enumerate() {
        current.push(index);
        if cut_after.contains(&clip.clip_id) {
            chapters.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        chapters.push(current);
    }
    if chapters.is_empty() {
        chapters.push((0..clips.len()).collect());
    }
    chapters
}

fn compare_f64(left: f64, right: f64) -> std::cmp::Ordering {
    left.partial_cmp(&right).unwrap_or(std::cmp::Ordering::Equal)
}

/// 模板的开场镜头：返回 `clips` 下标。
fn fallback_opening(template: StoryTemplate, clips: &[FallbackClip]) -> usize {
    let pick = |filter: &dyn Fn(&FallbackClip) -> bool,
                key: &dyn Fn(&FallbackClip) -> f64|
     -> Option<usize> {
        clips
            .iter()
            .enumerate()
            .filter(|(_, clip)| filter(clip))
            .max_by(|left, right| compare_f64(key(left.1), key(right.1)))
            .map(|(index, _)| index)
    };
    match template {
        StoryTemplate::Cinematic => pick(
            &|clip| (clip.is_wide() || clip.is_empty_scene() || clip.is_establishing())
                && clip.stability >= 0.50,
            &|clip| clip.technical,
        )
        .or_else(|| pick(&|_| true, &|clip| clip.technical))
        .unwrap_or(0),
        StoryTemplate::Fastcut => pick(
            &|clip| clip.motion_energy > 0.0,
            &|clip| -clip.duration_seconds,
        )
        .or_else(|| pick(&|_| true, &|clip| -clip.duration_seconds))
        .unwrap_or(0),
        StoryTemplate::Ambient => pick(
            &|clip| clip.is_empty_scene() && clip.is_wide(),
            &|clip| clip.stability,
        )
        .or_else(|| pick(&|clip| clip.is_empty_scene(), &|clip| clip.stability))
        .or_else(|| pick(&|_| true, &|clip| clip.stability))
        .unwrap_or(0),
        // 日记严格按时间：开场就是最早的一条。
        StoryTemplate::Diary => clips
            .iter()
            .enumerate()
            .min_by(|left, right| {
                (left.1.captured_at.as_deref(), left.1.order_index)
                    .cmp(&(right.1.captured_at.as_deref(), right.1.order_index))
            })
            .map(|(index, _)| index)
            .unwrap_or(0),
    }
}

/// 电影感的收尾镜头：日落夜景优先，否则最长的稳定镜头。
fn cinematic_closing(clips: &[FallbackClip], opening: usize) -> Option<usize> {
    clips
        .iter()
        .enumerate()
        .filter(|(index, clip)| *index != opening && clip.is_sunset())
        .max_by(|left, right| compare_f64(left.1.duration_seconds, right.1.duration_seconds))
        .or_else(|| {
            clips
                .iter()
                .enumerate()
                .filter(|(index, clip)| *index != opening && clip.stability >= 0.50)
                .max_by(|left, right| compare_f64(left.1.duration_seconds, right.1.duration_seconds))
        })
        .map(|(index, _)| index)
}

fn cinematic_phase(clip: &FallbackClip) -> u8 {
    if clip.is_reveal() {
        1
    } else if clip.is_experience() {
        2
    } else {
        3
    }
}

fn fallback_rationale(template: StoryTemplate, clip: &FallbackClip, role: FallbackRole) -> String {
    let params = template_params(template);
    let text = match (template, role) {
        (StoryTemplate::Cinematic, FallbackRole::Opening) => format!(
            "电影感·开场：稳定{}，技术分 {:.2}",
            if clip.is_empty_scene() && clip.is_wide() {
                "广角空镜".to_owned()
            } else {
                clip.label_summary()
            },
            clip.technical
        ),
        (StoryTemplate::Cinematic, FallbackRole::Closing) => format!(
            "电影感·收尾：{}，时长 {:.1} 秒",
            if clip.is_sunset() { "日落夜景" } else { "最长稳定镜头" },
            clip.duration_seconds
        ),
        (StoryTemplate::Cinematic, FallbackRole::Body) => format!(
            "电影感·{}：{}，技术分 {:.2}，目标单镜 {:.0}–{:.0} 秒",
            match cinematic_phase(clip) {
                1 => "目的地揭示",
                2 => "体验推进",
                _ => "补充",
            },
            clip.label_summary(),
            clip.technical,
            params.beat_min_s,
            params.beat_max_s
        ),
        (StoryTemplate::Fastcut, FallbackRole::Opening) => format!(
            "快节奏·开场：最短高能镜头，时长 {:.1} 秒，运动能量 {:.2}",
            clip.duration_seconds, clip.motion_energy
        ),
        (StoryTemplate::Fastcut, _) => format!(
            "快节奏·密集蒙太奇：时长 {:.1} 秒，按 {:.0}–{:.0} 秒短镜排序",
            clip.duration_seconds, params.beat_min_s, params.beat_max_s
        ),
        (StoryTemplate::Ambient, FallbackRole::Opening) => format!(
            "安静氛围·开场：无人物广角空镜，稳定度 {:.2}",
            clip.stability
        ),
        (StoryTemplate::Ambient, _) => format!(
            "安静氛围：{}，稳定度 {:.2}，保留 {:.0}–{:.0} 秒长镜头",
            if clip.is_empty_scene() { "空镜环境".to_owned() } else { clip.label_summary() },
            clip.stability,
            params.beat_min_s,
            params.beat_max_s
        ),
        (StoryTemplate::Diary, _) => format!(
            "旅行日记：按拍摄时间 {} 顺序排列，单镜 {:.0}–{:.0} 秒",
            clip.captured_at.as_deref().unwrap_or("未知时间"),
            params.beat_min_s,
            params.beat_max_s
        ),
    };
    // AI 可解释性硬约束：rationale 永不为空。
    if text.trim().is_empty() {
        format!("{}模板兜底选入", template.name_zh())
    } else {
        text
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FallbackRole {
    Opening,
    Body,
    Closing,
}

fn fallback_story_slots(template: StoryTemplate, chapter_index: usize) -> Vec<String> {
    let slots: [&str; 2] = match (template, chapter_index) {
        (StoryTemplate::Cinematic, 0) => ["REAL/ESTABLISHING", "ATMOSPHERE"],
        (StoryTemplate::Cinematic, _) => ["REAL/EXPERIENCE", "REAL/DETAIL"],
        (StoryTemplate::Fastcut, 0) => ["REAL/EXPERIENCE", "TRANSITION"],
        (StoryTemplate::Fastcut, _) => ["REAL/DETAIL", "TRANSITION"],
        (StoryTemplate::Ambient, 0) => ["ATMOSPHERE", "REAL/DETAIL"],
        (StoryTemplate::Ambient, _) => ["ATMOSPHERE", "REAL/ESTABLISHING"],
        (StoryTemplate::Diary, 0) => ["REAL/HUMAN", "REAL/EXPERIENCE"],
        (StoryTemplate::Diary, _) => ["REAL/HUMAN", "REAL/DETAIL"],
    };
    slots.iter().map(|slot| (*slot).to_owned()).collect()
}

fn fallback_chapter_kind(template: StoryTemplate, chapter_index: usize, clips: &[&FallbackClip]) -> String {
    if chapter_index == 0 {
        return match template {
            StoryTemplate::Ambient => "atmosphere".to_owned(),
            StoryTemplate::Fastcut => "journey".to_owned(),
            _ => "destination".to_owned(),
        };
    }
    if clips.iter().any(|clip| clip.is_experience()) {
        "experience".to_owned()
    } else if clips.iter().all(|clip| clip.is_empty_scene()) {
        "atmosphere".to_owned()
    } else {
        "journey".to_owned()
    }
}

/// 无 LLM 时的确定性草稿：复用边界检测分章，再按模板规则排序与降级。
pub fn build_fallback_draft(
    connection: &Connection,
    template: Option<StoryTemplate>,
) -> Result<NarrativeDraft> {
    let episode_id = active_episode_id(connection)?;
    let prompt_clips = load_prompt_clips(connection, episode_id)?;
    if prompt_clips.is_empty() {
        return Err(CoreError::Story(
            "故事板没有已收藏或已选片段，无法编排 Episode".to_owned(),
        ));
    }
    let template = template.unwrap_or(StoryTemplate::Diary);
    let params = template_params(template);
    let signals = load_fallback_clips(connection, &prompt_clips)?;
    let mut chapters = fallback_chapters(&prompt_clips);

    let opening = fallback_opening(template, &signals);
    let closing = match template {
        StoryTemplate::Cinematic => cinematic_closing(&signals, opening),
        _ => None,
    };

    // 章内按模板排序。
    for chapter in &mut chapters {
        chapter.sort_by(|left, right| {
            let (a, b) = (&signals[*left], &signals[*right]);
            match template {
                StoryTemplate::Diary => (a.captured_at.as_deref(), a.order_index)
                    .cmp(&(b.captured_at.as_deref(), b.order_index)),
                StoryTemplate::Cinematic => (cinematic_phase(a), *left)
                    .cmp(&(cinematic_phase(b), *right))
                    .then_with(|| compare_f64(b.technical, a.technical)),
                StoryTemplate::Fastcut => compare_f64(a.duration_seconds, b.duration_seconds)
                    .then_with(|| compare_f64(b.motion_energy, a.motion_energy))
                    .then(left.cmp(right)),
                StoryTemplate::Ambient => a
                    .has_people()
                    .cmp(&b.has_people())
                    .then_with(|| compare_f64(b.stability, a.stability))
                    .then_with(|| compare_f64(b.duration_seconds, a.duration_seconds))
                    .then(left.cmp(right)),
            }
        });
    }

    if template != StoryTemplate::Diary {
        // 开场所在的章提到最前，并在章内提到首位。
        if let Some(position) = chapters.iter().position(|chapter| chapter.contains(&opening)) {
            let mut lead = chapters.remove(position);
            lead.retain(|index| *index != opening);
            lead.insert(0, opening);
            chapters.insert(0, lead);
        }
        // 电影感的收尾放到整条时间线最后。
        if let Some(closing) = closing.filter(|closing| *closing != opening) {
            for chapter in chapters.iter_mut() {
                chapter.retain(|index| *index != closing);
            }
            chapters.retain(|chapter| !chapter.is_empty());
            if let Some(last) = chapters.last_mut() {
                last.push(closing);
            }
        }
        chapters.retain(|chapter| !chapter.is_empty());
    }

    let mut draft_chapters = Vec::with_capacity(chapters.len());
    let mut downgrades = Vec::new();
    for (chapter_index, chapter) in chapters.iter().enumerate() {
        let members = chapter.iter().map(|index| &signals[*index]).collect::<Vec<_>>();
        // 降级：按模板密度把靠后的素材压成 montage，每章至少留一个真实 Beat。
        let keep = ((chapter.len() as f64) * (1.0 - params.montage_density)).round() as usize;
        let keep = keep.clamp(1, chapter.len());
        let mut beats = Vec::with_capacity(chapter.len());
        for (position, index) in chapter.iter().enumerate() {
            let clip = &signals[*index];
            let role = if *index == opening {
                FallbackRole::Opening
            } else if Some(*index) == closing {
                FallbackRole::Closing
            } else {
                FallbackRole::Body
            };
            let rationale = fallback_rationale(template, clip, role);
            let beat_role = if position < keep || role != FallbackRole::Body {
                "beat"
            } else {
                "montage"
            };
            if beat_role == "montage" {
                downgrades.push(RoutineDowngradeDraft {
                    clip_id: clip.clip_id,
                    segment_id: clip.segment_id,
                    role: "montage".to_owned(),
                    reason: format!(
                        "{}模板密度 {:.0}%：本条排在章内第 {} 位，降级为蒙太奇",
                        template.name_zh(),
                        params.montage_density * 100.0,
                        position + 1
                    ),
                });
            }
            beats.push(NarrativeBeatDraft {
                clip_id: clip.clip_id,
                segment_id: clip.segment_id,
                role: beat_role.to_owned(),
                score: ((clip.technical + clip.stability) / 2.0).clamp(0.0, 1.0),
                rationale,
            });
        }
        draft_chapters.push(NarrativeChapterDraft {
            kind: fallback_chapter_kind(template, chapter_index, &members),
            title: format!("{}·第 {} 段", template.name_zh(), chapter_index + 1),
            promoted: false,
            promotion_reason: String::new(),
            score: 0.60,
            rationale: format!(
                "未启用 AI，按「{}」模板规则生成：边界信号 ≥{:.2} 切章，章内按模板排序",
                template.name_zh(),
                FALLBACK_BOUNDARY_THRESHOLD
            ),
            beats,
            story_slots: fallback_story_slots(template, chapter_index),
            missing_slots: vec!["DH INTRO".to_owned(), "MAP".to_owned()],
            digital_human_plan: None,
        });
    }

    let episode_title: String = connection
        .query_row("SELECT title FROM episodes WHERE id = ?1", [episode_id], |row| row.get(0))
        .optional()?
        .unwrap_or_else(|| "未命名旅程".to_owned());
    let mut draft = NarrativeDraft {
        episode_title: format!("{episode_title}（{}）", template.name_zh()),
        episode_theme: format!(
            "未启用 AI，按「{}」模板规则生成：{}",
            template.name_zh(),
            prompt_prefix(template)
        ),
        chapters: draft_chapters,
        downgrades,
        destination_cards: Vec::new(),
    };
    let input = prompt_input_for_episode(connection, episode_id)?;
    validate_draft_for_input(&mut draft, &input)?;
    Ok(draft)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};

    fn setup() -> (TestDirectory, Connection) {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('narrative')", []).unwrap();
        (directory, connection)
    }

    fn insert_selected(connection: &Connection, id: i64, captured_at: &str, transcript: &str) {
        connection.execute(
            "INSERT INTO clips(
                id, volume_uuid, rel_path, duration_ticks, tb_num, tb_den, captured_at
             ) VALUES (?1, 'narrative', ?2, 10000, 1, 1000, ?3)",
            params![id, format!("{id}.mov"), captured_at],
        ).unwrap();
        connection.execute(
            "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind)
             VALUES (?1, 0, 10000, 'whole')",
            [id],
        ).unwrap();
        let segment_id = connection.last_insert_rowid();
        connection.execute(
            "INSERT INTO ratings(segment_id, rating_type, value, rated_at)
             VALUES (?1, 'binary', 1, ?2)",
            params![segment_id, captured_at],
        ).unwrap();
        connection.execute(
            "INSERT INTO transcript_segments(clip_id, seg_index, start_ticks, end_ticks, text)
             VALUES (?1, 0, 0, 10000, ?2)",
            params![id, transcript],
        ).unwrap();
    }

    fn complete_coverage() -> Vec<CoverageItem> {
        COVERAGE_ITEMS.iter().map(|item| CoverageItem {
            item: (*item).to_owned(),
            covered: false,
            evidence: String::new(),
            suggestion: "待补拍".to_owned(),
        }).collect()
    }

    fn valid_draft() -> NarrativeDraft {
        NarrativeDraft {
            episode_title: "北境公路".to_owned(),
            episode_theme: "围绕抵达与真实体验组织".to_owned(),
            chapters: vec![NarrativeChapterDraft {
                kind: "journey".to_owned(),
                title: "驶向北方".to_owned(),
                promoted: false,
                promotion_reason: String::new(),
                score: 0.8,
                rationale: "路途推进主线".to_owned(),
                beats: vec![NarrativeBeatDraft {
                    clip_id: 1,
                    segment_id: None,
                    role: "beat".to_owned(),
                    score: 0.8,
                    rationale: "建立旅程".to_owned(),
                }],
                story_slots: vec!["REAL/ESTABLISHING".to_owned()],
                missing_slots: vec!["MAP".to_owned()],
                digital_human_plan: Some(DigitalHumanPlan {
                    mode: "D".to_owned(),
                    reason: "路线需要压缩说明".to_owned(),
                    planned_slots: vec!["MAP".to_owned()],
                }),
            }],
            downgrades: Vec::new(),
            destination_cards: vec![DestinationCardDraft {
                chapter_order: 0,
                name: "公路节点".to_owned(),
                geo_context: "模型草稿".to_owned(),
                highlights: "山地道路".to_owned(),
                why_visit: "服务旅程主线".to_owned(),
                personal_note: "现场感受待补".to_owned(),
                sources: vec![ModelSource {
                    label: "现场口播".to_owned(),
                    basis: "转写摘录".to_owned(),
                }],
                coverage: complete_coverage(),
            }],
        }
    }

    struct FixtureClip {
        id: i64,
        captured_at: &'static str,
        duration_seconds: f64,
        transcript: &'static str,
        shot_size: &'static str,
        subject: &'static str,
        function_label: &'static str,
        person_state: Option<&'static str>,
        time_stage: &'static str,
        movement: &'static str,
        motion_class: &'static str,
        shake: f64,
        exposure: f64,
        blur: f64,
    }

    fn insert_fixture_clip(connection: &Connection, clip: &FixtureClip) {
        let out_ticks = (clip.duration_seconds * 1000.0).round() as i64;
        connection
            .execute(
                "INSERT INTO clips(
                    id, volume_uuid, rel_path, duration_ticks, tb_num, tb_den, captured_at
                 ) VALUES (?1, 'narrative', ?2, ?3, 1, 1000, ?4)",
                params![clip.id, format!("{}.mov", clip.id), out_ticks, clip.captured_at],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind)
                 VALUES (?1, 0, ?2, 'whole')",
                params![clip.id, out_ticks],
            )
            .unwrap();
        let segment_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO ratings(segment_id, rating_type, value, rated_at)
                 VALUES (?1, 'binary', 1, ?2)",
                params![segment_id, clip.captured_at],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO transcript_segments(clip_id, seg_index, start_ticks, end_ticks, text)
                 VALUES (?1, 0, 0, ?2, ?3)",
                params![clip.id, out_ticks, clip.transcript],
            )
            .unwrap();
        let mut dimensions = vec![
            ("shot_size", clip.shot_size),
            ("subject", clip.subject),
            ("function", clip.function_label),
            ("time_stage", clip.time_stage),
            ("movement", clip.movement),
        ];
        if let Some(state) = clip.person_state {
            dimensions.push(("person_state", state));
        }
        for (dimension, label) in dimensions {
            connection
                .execute(
                    "INSERT INTO clip_dimensions(clip_id, dimension, label, score, source)
                     VALUES (?1, ?2, ?3, 0.8, 'fixture')",
                    params![clip.id, dimension, label],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO clip_motion(
                    clip_id, class, pan_ratio, tilt_ratio, zoom_corr, shake_score,
                    sample_pairs, tool_version
                 ) VALUES (?1, ?2, 0.1, 0.1, 0.0, ?3, 10, 'fixture')",
                params![clip.id, clip.motion_class, clip.shake],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clip_analysis(
                    clip_id, exposure_yavg, overexposed_ratio, audio_peak_db, audio_clipped,
                    has_audio, focus_scores, scene_count, analyzed_at, tool_versions,
                    blur_mean, out_of_focus_ratio, motion_mean
                 ) VALUES (?1, ?2, 0.0, -12.0, 0, 1, '[]', 1, ?3, 'fixture', ?4, 0.02, ?5)",
                params![
                    clip.id,
                    clip.exposure,
                    clip.captured_at,
                    clip.blur,
                    clip.shake
                ],
            )
            .unwrap();
    }

    /// 8 条素材：跨两天、时长 1.5–30 秒、运动与八维标签各不相同。
    fn template_fixture(connection: &Connection) {
        let clips = [
            FixtureClip { id: 1, captured_at: "2026-09-01T09:00:00Z", duration_seconds: 12.0,
                transcript: "山谷清晨开阔视野", shot_size: "超广角", subject: "风景",
                function_label: "Establishing", person_state: None, time_stage: "到达",
                movement: "handheld_follow", motion_class: "handheld", shake: 0.3,
                exposure: 120.0, blur: 80.0 },
            FixtureClip { id: 2, captured_at: "2026-09-01T09:10:00Z", duration_seconds: 2.0,
                transcript: "车轮碾过碎石路面", shot_size: "中景", subject: "交通",
                function_label: "Transition", person_state: None, time_stage: "路上",
                movement: "handheld_shaky", motion_class: "handheld", shake: 2.5,
                exposure: 100.0, blur: 30.0 },
            FixtureClip { id: 3, captured_at: "2026-09-01T09:20:00Z", duration_seconds: 30.0,
                transcript: "湖面倒影安静无声", shot_size: "广角", subject: "风景",
                function_label: "Atmosphere", person_state: None, time_stage: "探索",
                movement: "static", motion_class: "static", shake: 0.1,
                exposure: 200.0, blur: 20.0 },
            FixtureClip { id: 4, captured_at: "2026-09-01T09:30:00Z", duration_seconds: 6.0,
                transcript: "围着炉子分食晚餐", shot_size: "近景", subject: "人",
                function_label: "Experience", person_state: Some("吃喝"), time_stage: "吃饭",
                movement: "handheld_follow", motion_class: "handheld", shake: 1.2,
                exposure: 110.0, blur: 45.0 },
            FixtureClip { id: 5, captured_at: "2026-09-02T08:00:00Z", duration_seconds: 4.0,
                transcript: "老教堂立面石雕", shot_size: "中景", subject: "建筑",
                function_label: "Orientation", person_state: None, time_stage: "到达",
                movement: "static", motion_class: "static", shake: 0.2,
                exposure: 40.0, blur: 10.0 },
            FixtureClip { id: 6, captured_at: "2026-09-02T08:30:00Z", duration_seconds: 1.5,
                transcript: "指尖翻动票根特写", shot_size: "特写", subject: "细节",
                function_label: "Detail", person_state: None, time_stage: "探索",
                movement: "handheld_shaky", motion_class: "handheld", shake: 2.0,
                exposure: 115.0, blur: 35.0 },
            FixtureClip { id: 7, captured_at: "2026-09-02T19:00:00Z", duration_seconds: 20.0,
                transcript: "夕阳沉入远处海平线", shot_size: "广角", subject: "风景",
                function_label: "Atmosphere", person_state: None, time_stage: "日落夜景",
                movement: "pan", motion_class: "pan", shake: 0.5,
                exposure: 40.0, blur: 30.0 },
            FixtureClip { id: 8, captured_at: "2026-09-02T19:10:00Z", duration_seconds: 8.0,
                transcript: "她转头笑着说真值", shot_size: "中景", subject: "人",
                function_label: "Human-Reaction", person_state: Some("观察"),
                time_stage: "日落夜景", movement: "handheld_follow", motion_class: "handheld",
                shake: 1.0, exposure: 105.0, blur: 50.0 },
        ];
        for clip in &clips {
            insert_fixture_clip(connection, clip);
        }
    }

    fn beat_order(draft: &NarrativeDraft) -> Vec<i64> {
        draft
            .chapters
            .iter()
            .flat_map(|chapter| chapter.beats.iter().map(|beat| beat.clip_id))
            .collect()
    }

    #[test]
    fn four_story_templates_reorder_the_same_fixture_differently_with_no_llm() {
        let (_directory, connection) = setup();
        template_fixture(&connection);
        let templates = [
            StoryTemplate::Cinematic,
            StoryTemplate::Fastcut,
            StoryTemplate::Ambient,
            StoryTemplate::Diary,
        ];
        let mut orders = Vec::new();
        let mut first_slots = Vec::new();
        for template in templates {
            let draft = build_fallback_draft(&connection, Some(template)).unwrap();
            let order = beat_order(&draft);
            assert_eq!(order.len(), 8, "{} 必须覆盖全部 8 条素材", template.as_str());
            for chapter in &draft.chapters {
                for beat in &chapter.beats {
                    assert!(
                        !beat.rationale.trim().is_empty(),
                        "{} 的 Beat {} 缺少中文依据",
                        template.as_str(),
                        beat.clip_id
                    );
                }
            }
            assert!(
                draft.chapters.len() >= 3,
                "{} 应按边界信号分出多章，实际 {} 章",
                template.as_str(),
                draft.chapters.len()
            );
            if template == StoryTemplate::Cinematic {
                // 章内排序：建立/揭示 → 体验 → 其它。
                assert_eq!(
                    draft.chapters[0]
                        .beats
                        .iter()
                        .map(|beat| beat.clip_id)
                        .collect::<Vec<_>>(),
                    vec![1, 3, 4, 2]
                );
            }
            if template == StoryTemplate::Diary {
                assert!(draft.downgrades.is_empty(), "旅行日记不降级，一条素材一个 Beat");
            } else {
                assert!(!draft.downgrades.is_empty(), "{} 应有蒙太奇降级", template.as_str());
            }
            first_slots.push(draft.chapters[0].story_slots.clone());
            orders.push((template, order));
        }

        // 首槽素材符合各自模板的规则。
        assert_eq!(orders[0].1[0], 1, "电影感首槽应为技术分最高的稳定建立镜头");
        assert_eq!(orders[1].1[0], 6, "快节奏首槽应为最短的高能镜头");
        assert_eq!(orders[2].1[0], 3, "安静氛围首槽应为最稳定的无人物空镜");
        assert_eq!(orders[3].1, vec![1, 2, 3, 4, 5, 6, 7, 8], "旅行日记必须严格按时间");
        assert_eq!(*orders[0].1.last().unwrap(), 7, "电影感应收在日落镜头");

        for left in 0..orders.len() {
            for right in (left + 1)..orders.len() {
                assert_ne!(
                    orders[left].1, orders[right].1,
                    "{} 与 {} 的 Beat 顺序不该相同",
                    orders[left].0.as_str(),
                    orders[right].0.as_str()
                );
                assert_ne!(
                    first_slots[left], first_slots[right],
                    "{} 与 {} 的首章 story_slots 不该相同",
                    orders[left].0.as_str(),
                    orders[right].0.as_str()
                );
            }
        }
    }

    #[test]
    fn enqueue_with_template_persists_a_suggested_revision_when_llm_is_disabled() {
        let (_directory, mut connection) = setup();
        template_fixture(&connection);
        let revision_id =
            enqueue_with_template(&mut connection, Some(StoryTemplate::Ambient)).unwrap().id();
        let (kind, template): (String, Option<String>) = connection
            .query_row(
                "SELECT kind, template FROM narrative_revisions WHERE id = ?1",
                [revision_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(kind, "suggested");
        assert_eq!(template.as_deref(), Some("ambient"));
        // 未启用 LLM 时不再排队任务，也不再报「LLM 未启用」。
        let jobs: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM jobs WHERE kind = 'narrate_episode'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(jobs, 0);
        assert!(load_overview(&connection).unwrap().is_some());
    }

    #[test]
    fn enqueue_without_template_still_falls_back_but_refuses_an_empty_storyboard() {
        let (_directory, mut connection) = setup();
        let error = enqueue(&mut connection).unwrap_err().to_string();
        assert!(error.contains("没有已收藏"), "空故事板必须仍然报错：{error}");
        template_fixture(&connection);
        let revision_id = enqueue(&mut connection).unwrap().id();
        let template: Option<String> = connection
            .query_row(
                "SELECT template FROM narrative_revisions WHERE id = ?1",
                [revision_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(template, None, "未指定模板时不该冒充某套模板");
    }

    #[test]
    fn story_template_catalog_is_complete_and_parsable() {
        assert_eq!(STORY_TEMPLATES.len(), 4);
        for info in STORY_TEMPLATES {
            assert!(!info.name_zh.is_empty() && !info.blurb_zh.is_empty());
            let template = StoryTemplate::parse(info.id).unwrap();
            assert_eq!(template.as_str(), info.id);
            let params = template_params(template);
            assert!(params.beat_min_s > 0.0 && params.beat_max_s > params.beat_min_s);
        }
        assert!(StoryTemplate::parse("montage").is_err());
    }

    #[test]
    fn enqueue_outcome_serialises_with_a_kind_tag_distinguishing_job_from_revision() {
        // 两个整数主键空间不能互认；序列化必须带 kind 让前端区分该刷新故事板
        // 还是显示排队提示。
        let revision = EnqueueOutcome::Revision { id: 7 };
        assert_eq!(
            serde_json::to_value(revision).unwrap(),
            serde_json::json!({"kind": "revision", "id": 7}),
        );
        let job = EnqueueOutcome::Job { id: 9 };
        assert_eq!(
            serde_json::to_value(job).unwrap(),
            serde_json::json!({"kind": "job", "id": 9}),
        );
    }

    #[test]
    fn enqueue_with_template_returns_a_revision_outcome_when_llm_is_disabled() {
        let (_directory, mut connection) = setup();
        template_fixture(&connection);
        let outcome =
            enqueue_with_template(&mut connection, Some(StoryTemplate::Fastcut)).unwrap();
        match outcome {
            EnqueueOutcome::Revision { id } => assert!(id > 0),
            EnqueueOutcome::Job { .. } => panic!("LLM 关闭时不该排队任务"),
        }
    }

    #[test]
    fn enqueue_with_template_returns_a_job_outcome_when_llm_is_enabled() {
        let (_directory, mut connection) = setup();
        insert_selected(&connection, 1, "2026-09-01T10:00:00Z", "出发");
        crate::core::settings::set_setting(&connection, LLM_ENABLED_KEY, "true").unwrap();
        let outcome =
            enqueue_with_template(&mut connection, Some(StoryTemplate::Diary)).unwrap();
        match outcome {
            EnqueueOutcome::Job { id } => assert!(id > 0),
            EnqueueOutcome::Revision { .. } => panic!("LLM 启用时应排队任务而不是同步落地"),
        }
    }

    /// R10 U-03:叙事/模板候选池 = 收藏 ∪ ≥3 星 ∪ 有精选段——三星未收藏的片也进
    /// prompt 候选与 selected_item_refs;两星不进。
    #[test]
    fn three_star_clips_enter_the_narrative_candidate_pool() {
        let (_directory, connection) = setup();
        insert_selected(&connection, 1, "2026-09-01T10:00:00Z", "收藏");
        for (id, stars) in [(2_i64, 3_i64), (3, 2)] {
            connection
                .execute(
                    "INSERT INTO clips(id, volume_uuid, rel_path, duration_ticks, tb_num, tb_den, captured_at)
                     VALUES (?1, 'narrative', ?2, 10000, 1, 1000, '2026-09-01T11:00:00Z')",
                    params![id, format!("{id}.mov")],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind) VALUES (?1, 0, 10000, 'whole')",
                    [id],
                )
                .unwrap();
            let segment_id = connection.last_insert_rowid();
            connection
                .execute(
                    "INSERT INTO ratings(segment_id, rating_type, value, rated_at)
                     VALUES (?1, 'star', ?2, '2026-09-01T12:00:00Z')",
                    params![segment_id, stars],
                )
                .unwrap();
        }
        let episode = active_episode_id(&connection).unwrap();
        let ids = load_prompt_clips(&connection, episode)
            .unwrap()
            .into_iter()
            .map(|clip| clip.clip_id)
            .collect::<Vec<_>>();
        assert_eq!(ids, vec![1, 2]);
        let refs = selected_item_refs(&connection, episode).unwrap();
        assert!(refs.contains(&(2, None)));
        assert!(!refs.contains(&(3, None)));
    }

    #[test]
    fn photo_candidates_never_enter_narrative_refs_prompt_beats_or_duration_budget() {
        let (_directory, connection) = setup();
        insert_selected(&connection, 1, "2026-09-01T10:00:00Z", "视频");
        insert_selected(&connection, 2, "2026-09-01T10:01:00Z", "整张照片");
        insert_selected(&connection, 3, "2026-09-01T10:02:00Z", "照片精选段");
        connection.execute("UPDATE clips SET kind = 'photo' WHERE id IN (2, 3)", []).unwrap();
        connection
            .execute(
                "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind) VALUES (3, 1000, 5000, 'select')",
                [],
            )
            .unwrap();

        let episode = active_episode_id(&connection).unwrap();
        let clips = load_prompt_clips(&connection, episode).unwrap();
        assert_eq!(clips.iter().map(|clip| clip.clip_id).collect::<Vec<_>>(), vec![1]);
        assert_eq!(clips.iter().map(|clip| clip.duration_seconds).sum::<f64>(), 10.0);
        assert_eq!(selected_item_refs(&connection, episode).unwrap(), HashSet::from([(1, None)]));

        let prompt = prompt_input_for_episode(&connection, episode).unwrap();
        assert_eq!(prompt["clips"].as_array().unwrap().iter().map(|clip| clip["clip_id"].as_i64().unwrap()).collect::<Vec<_>>(), vec![1]);
        let draft = build_fallback_draft(&connection, Some(StoryTemplate::Diary)).unwrap();
        assert_eq!(draft.chapters.iter().flat_map(|chapter| chapter.beats.iter()).map(|beat| beat.clip_id).collect::<Vec<_>>(), vec![1]);
    }

    #[test]
    fn boundary_signals_combine_time_stage_and_transcript_without_declaring_a_chapter() {
        let (_directory, connection) = setup();
        insert_selected(&connection, 1, "2026-09-01T10:00:00Z", "准备出发公路");
        insert_selected(&connection, 2, "2026-09-01T11:00:00Z", "抵达营地晚餐");
        let clips = load_prompt_clips(&connection, active_episode_id(&connection).unwrap()).unwrap();
        let boundaries = boundary_signals(&clips);
        assert_eq!(boundaries.len(), 1);
        assert!(boundaries[0].reasons.len() >= 2);
        let input = prompt_input(&connection).unwrap();
        assert!(input.get("candidate_boundaries").is_none());
    }

    #[test]
    fn llm_prompt_excludes_sensitive_media_metadata_and_memory() {
        let (_directory, connection) = setup();
        insert_selected(&connection, 1, "2026-09-01T10:00:00Z", "隐私转写口令");
        let input = prompt_input(&connection).unwrap();
        let serialized = serde_json::to_string(&input).unwrap();
        assert!(!serialized.contains("隐私转写口令"));
        for forbidden_key in [
            "\"file_name\"",
            "\"captured_at\"",
            "\"location\"",
            "\"transcript_excerpt\"",
            "\"long_term_memory\"",
            "\"channel_memory\"",
            "\"candidate_boundaries\"",
        ] {
            assert!(!serialized.contains(forbidden_key), "leaked {forbidden_key}");
        }
    }

    #[test]
    fn prompt_and_overview_exclude_selected_clips_from_archived_episodes() {
        let (_directory, mut connection) = setup();
        let archived_episode = active_episode_id(&connection).unwrap();
        insert_selected(&connection, 1, "2026-09-01T10:00:00Z", "旧集口播");
        connection
            .execute(
                "UPDATE clips SET episode_id = ?2 WHERE id = ?1",
                params![1, archived_episode],
            )
            .unwrap();
        crate::core::episode::archive_current(&mut connection, None).unwrap();

        let active_episode = active_episode_id(&connection).unwrap();
        insert_selected(&connection, 2, "2026-09-02T10:00:00Z", "新集口播");
        connection
            .execute(
                "UPDATE clips SET episode_id = ?2 WHERE id = ?1",
                params![2, active_episode],
            )
            .unwrap();

        let input = prompt_input(&connection).unwrap();
        let ids = input["clips"]
            .as_array()
            .unwrap()
            .iter()
            .map(|clip| clip["clip_id"].as_i64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec![2]);
        assert_eq!(
            selected_item_refs(&connection, active_episode).unwrap(),
            HashSet::from([(2, None)])
        );

        let mut draft = valid_draft();
        draft.chapters[0].beats[0].clip_id = 2;
        validate_draft(&connection, &mut draft).unwrap();
        persist_draft(&mut connection, &draft).unwrap();
        assert!(load_overview(&connection).unwrap().is_some());
    }

    #[test]
    fn strict_validation_rejects_unknown_kind_and_duplicate_beats() {
        let (_directory, connection) = setup();
        insert_selected(&connection, 1, "2026-09-01T10:00:00Z", "出发");
        let mut draft = valid_draft();
        draft.chapters[0].kind = "mechanical_gps_chapter".to_owned();
        assert!(validate_draft(&connection, &mut draft).is_err());
    }

    #[test]
    fn strict_json_rejects_a_model_supplied_verified_field() {
        let mut value = serde_json::to_value(valid_draft()).unwrap();
        value["destination_cards"][0]["verified"] = Value::Bool(true);
        let error = serde_json::from_value::<NarrativeDraft>(value).unwrap_err();
        assert!(error.to_string().contains("unknown field `verified`"));
    }

    #[test]
    fn coverage_requires_the_exact_thirteen_items() {
        let (_directory, connection) = setup();
        insert_selected(&connection, 1, "2026-09-01T10:00:00Z", "出发");
        let mut draft = valid_draft();
        draft.destination_cards[0].coverage.pop();
        assert!(validate_draft(&connection, &mut draft).is_err());
    }

    #[test]
    fn persistence_forces_destination_cards_to_unverified() {
        let (_directory, mut connection) = setup();
        insert_selected(&connection, 1, "2026-09-01T10:00:00Z", "出发");
        let mut draft = valid_draft();
        validate_draft(&connection, &mut draft).unwrap();
        persist_draft(&mut connection, &draft).unwrap();
        let verified: i64 = connection.query_row(
            "SELECT verified FROM destination_cards", [], |row| row.get(0)
        ).unwrap();
        assert_eq!(verified, 0);
    }

    #[test]
    fn editing_a_verified_destination_card_resets_it_to_pending() {
        let (_directory, mut connection) = setup();
        insert_selected(&connection, 1, "2026-09-01T10:00:00Z", "出发");
        let mut draft = valid_draft();
        validate_draft(&connection, &mut draft).unwrap();
        persist_draft(&mut connection, &draft).unwrap();
        let card_id: i64 = connection.query_row(
            "SELECT id FROM destination_cards", [], |row| row.get(0)
        ).unwrap();
        for field in DESTINATION_FIELDS {
            set_destination_field_state(&connection, card_id, field, "verified").unwrap();
        }
        set_destination_verified(&connection, card_id, true).unwrap();
        update_destination_card(
            &connection,
            card_id,
            "新名称",
            "修改后的地理背景",
            "特点",
            "原因",
            "体验",
        ).unwrap();
        let verified: i64 = connection.query_row(
            "SELECT verified FROM destination_cards WHERE id = ?1", [card_id], |row| row.get(0)
        ).unwrap();
        assert_eq!(verified, 0);
    }

    #[test]
    fn destination_card_writes_refuse_archived_episode_cards() {
        let (_directory, mut connection) = setup();
        insert_selected(&connection, 1, "2026-09-01T10:00:00Z", "出发");
        let mut draft = valid_draft();
        validate_draft(&connection, &mut draft).unwrap();
        persist_draft(&mut connection, &draft).unwrap();
        let card_id: i64 = connection
            .query_row("SELECT id FROM destination_cards", [], |row| row.get(0))
            .unwrap();
        connection
            .execute(
                "UPDATE clips SET episode_id = (SELECT id FROM episodes WHERE status = 'active')
                 WHERE id = 1",
                [],
            )
            .unwrap();
        crate::core::episode::archive_current(&mut connection, None).unwrap();

        assert!(set_destination_verified(&connection, card_id, true).is_err());
        assert!(set_destination_field_state(&connection, card_id, "geo_context", "verified")
            .is_err());
        assert!(update_destination_card(
            &connection,
            card_id,
            "历史地点",
            "背景",
            "特点",
            "原因",
            "体验",
        )
        .is_err());
    }

    #[test]
    fn narrative_persistence_does_not_overwrite_the_d2_story_order() {
        let (_directory, mut connection) = setup();
        insert_selected(&connection, 1, "2026-09-01T10:00:00Z", "出发");
        insert_selected(&connection, 2, "2026-09-01T10:05:00Z", "公路");
        for (position, clip_id) in [2_i64, 1_i64].into_iter().enumerate() {
            connection.execute(
                "INSERT INTO story_order(
                    item_kind, clip_id, position, tombstone, created_at, updated_at
                 ) VALUES ('whole', ?1, ?2, 0, 'now', 'now')",
                params![clip_id, position as i64],
            ).unwrap();
        }
        let mut draft = valid_draft();
        draft.chapters[0].beats.push(NarrativeBeatDraft {
            clip_id: 2,
            segment_id: None,
            role: "beat".to_owned(),
            score: 0.7,
            rationale: "承接公路旅程".to_owned(),
        });
        validate_draft(&connection, &mut draft).unwrap();
        persist_draft(&mut connection, &draft).unwrap();
        let order = connection.prepare(
            "SELECT clip_id FROM story_order WHERE tombstone = 0 ORDER BY position"
        ).unwrap().query_map([], |row| row.get::<_, i64>(0)).unwrap()
            .collect::<rusqlite::Result<Vec<_>>>().unwrap();
        assert_eq!(order, vec![2, 1]);
    }

    #[test]
    fn annotate_beats_reports_routine_cleared_independently_of_the_suggestion() {
        // 回归说明：「非 Routine」一旦设置,恢复控件立即消失,形成不可逆
        // UI 死路。根因是 routine_override::apply() 把 cleared 的建议抹成
        // None,而前端只靠 routine_suggestion==null 判断"要不要显示按钮"——
        // 于是"AI 本就没建议"和"AI 建议被人工清除"变得无法区分,后者永远
        // 拿不到恢复入口。annotate_beats 必须单独把 cleared 状态写进
        // routine_cleared,不能只靠 routine_suggestion 的有无。
        let (_directory, mut connection) = setup();
        insert_selected(&connection, 1, "2026-09-01T10:00:00Z", "早餐做饭");
        let memory_reader = super::super::channel_memory::ChannelMemoryReader::for_project(&connection).unwrap();
        let mut chapters = vec![NarrativeChapter {
            id: 1,
            kind: "core".to_owned(),
            title: "抵达".to_owned(),
            order: 0,
            promoted: true,
            score: 0.8,
            rationale: "".to_owned(),
            promotion_reason: "".to_owned(),
            story_slots: vec![],
            missing_slots: vec![],
            digital_human_plan: None,
            beats: vec![NarrativeBeat {
                id: 1,
                clip_id: 1,
                segment_id: None,
                role: "beat".to_owned(),
                order: 0,
                score: 0.5,
                rationale: "".to_owned(),
                routine_suggestion: None,
                routine_cleared: false,
            }],
        }];

        annotate_beats(&connection, &memory_reader, &mut chapters).unwrap();
        assert!(!chapters[0].beats[0].routine_cleared, "尚无 override 时不应标记为已清除");

        super::super::routine_override::set_override(&mut connection, 1, None, true).unwrap();
        annotate_beats(&connection, &memory_reader, &mut chapters).unwrap();
        assert!(chapters[0].beats[0].routine_cleared, "cleared override 后必须能读出「已清除」状态");
        assert!(chapters[0].beats[0].routine_suggestion.is_none());

        super::super::routine_override::remove_override(&mut connection, 1).unwrap();
        annotate_beats(&connection, &memory_reader, &mut chapters).unwrap();
        assert!(
            !chapters[0].beats[0].routine_cleared,
            "撤销 override(用户点「恢复 AI 建议」)后必须回到未清除状态"
        );
    }

    #[test]
    fn routine_downgrade_role_and_rationale_are_stored() {
        let (_directory, mut connection) = setup();
        insert_selected(&connection, 1, "2026-09-01T10:00:00Z", "早餐做饭");
        let mut draft = valid_draft();
        draft.chapters[0].beats[0].role = "montage".to_owned();
        draft.chapters[0].beats[0].rationale = "重复性房车早餐降级".to_owned();
        draft.downgrades.push(RoutineDowngradeDraft {
            clip_id: 1,
            segment_id: None,
            role: "montage".to_owned(),
            reason: "重复性房车早餐降级".to_owned(),
        });
        validate_draft(&connection, &mut draft).unwrap();
        persist_draft(&mut connection, &draft).unwrap();
        let stored: (String, String) = connection.query_row(
            "SELECT role, rationale FROM narrative_beats", [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(stored.0, "montage");
        assert!(stored.1.contains("降级"));
    }

    #[test]
    fn enqueue_while_l3_is_off_lands_a_deterministic_draft_instead_of_charging_l3() {
        // R4 Task 4 起：关闭 LLM 不再报错，而是按模板规则出确定性草稿；L3 账本一次不动。
        let (_directory, mut connection) = setup();
        insert_selected(&connection, 1, "2026-09-01T10:00:00Z", "出发");
        let revision_id = enqueue(&mut connection).unwrap().id();
        let kind: String = connection
            .query_row(
                "SELECT kind FROM narrative_revisions WHERE id = ?1",
                [revision_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(kind, "suggested");
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM jobs WHERE kind = 'narrate_episode'", [], |row| row.get(0)
        ).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn enqueue_refuses_a_second_active_narration_budget_charge() {
        let (_directory, mut connection) = setup();
        insert_selected(&connection, 1, "2026-09-01T10:00:00Z", "出发");
        crate::core::settings::set_setting(&connection, LLM_ENABLED_KEY, "true").unwrap();
        let first = enqueue(&mut connection).unwrap().id();
        let error = enqueue(&mut connection).unwrap_err().to_string();
        assert!(error.contains(&format!("#{first}")));
        assert!(error.contains("未重复占用"));
    }
}
