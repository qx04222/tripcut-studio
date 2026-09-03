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

pub fn enqueue(connection: &mut Connection) -> Result<i64> {
    if settings::string_value(connection, LLM_ENABLED_KEY, "false")? != "true" {
        return Err(CoreError::Story(
            "L3 默认关闭；当前故事板保持 D2 本地章节，未创建叙事编排任务".to_owned(),
        ));
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
    })
    .map_err(|error| CoreError::Story(format!("叙事任务序列化失败：{error}")))?;
    jobs::enqueue(
        connection,
        "narrate_episode",
        &payload,
        &format!("narrate:{episode_id}:{input_hash}"),
    )
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
    persist_draft_guarded(connection, draft, None)
}

pub fn persist_draft_for_job(
    connection: &mut Connection,
    draft: &NarrativeDraft,
    job_payload: &str,
) -> Result<()> {
    let payload: NarratePayload = serde_json::from_str(job_payload)
        .map_err(|error| CoreError::Story(format!("narrate_episode payload 无效：{error}")))?;
    persist_draft_guarded(connection, draft, Some(&payload))
}

fn persist_draft_guarded(
    connection: &mut Connection,
    draft: &NarrativeDraft,
    expected: Option<&NarratePayload>,
) -> Result<()> {
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
        "INSERT INTO narrative_revisions(episode_id, kind, title, theme, created_at)
         VALUES (?1, 'suggested', ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![episode_id, draft.episode_title, draft.episode_theme],
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
    Ok(())
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
            "SELECT r.episode_id, r.title, r.theme, r.created_at
             FROM narrative_revisions r WHERE r.id = ?1",
            [revision_id],
            |row| {
                Ok(NarrativeEpisode {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    theme: row.get(2)?,
                    created_at: row.get(3)?,
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
    let mut statement = connection.prepare(
        "WITH live_selects AS (
             SELECT id, clip_id FROM segments
             WHERE kind = 'select' AND tombstone = 0
         )
         SELECT c.id, live.id
         FROM clips c JOIN live_selects live ON live.clip_id = c.id
         WHERE c.missing_since IS NULL
           AND (c.episode_id = ?1 OR c.episode_id IS NULL)
         UNION ALL
         SELECT c.id, NULL
         FROM clips c
         WHERE c.missing_since IS NULL
           AND (c.episode_id = ?1 OR c.episode_id IS NULL)
           AND NOT EXISTS (SELECT 1 FROM live_selects live WHERE live.clip_id = c.id)
           AND 1 = (
               SELECT rating.value FROM ratings rating
               JOIN segments segment ON segment.id = rating.segment_id
               WHERE segment.clip_id = c.id AND segment.tombstone = 0
                 AND COALESCE(segment.kind, 'whole') != 'select'
                 AND rating.rating_type = 'binary'
               ORDER BY rating.rated_at DESC, rating.id DESC LIMIT 1
           )",
    )?;
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
    let mut statement = connection.prepare(
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
               AND (c.episode_id = ?1 OR c.episode_id IS NULL)
             UNION ALL
             SELECT c.id, NULL, c.rel_path, c.captured_at,
                    CAST(strftime('%s', c.captured_at) AS INTEGER),
                    c.gps_lat, c.gps_lon, 0, COALESCE(c.duration_ticks, 0),
                    COALESCE(c.tb_num, 0), COALESCE(c.tb_den, 0)
             FROM clips c
             WHERE c.missing_since IS NULL
               AND (c.episode_id = ?1 OR c.episode_id IS NULL)
               AND NOT EXISTS (SELECT 1 FROM live_selects live WHERE live.clip_id = c.id)
               AND 1 = (
                   SELECT rating.value FROM ratings rating
                   JOIN segments segment ON segment.id = rating.segment_id
                   WHERE segment.clip_id = c.id AND segment.tombstone = 0
                     AND COALESCE(segment.kind, 'whole') != 'select'
                     AND rating.rating_type = 'binary'
                   ORDER BY rating.rated_at DESC, rating.id DESC LIMIT 1
               )
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
    )?;
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
    fn enqueue_is_refused_while_l3_is_off() {
        let (_directory, mut connection) = setup();
        insert_selected(&connection, 1, "2026-09-01T10:00:00Z", "出发");
        let error = enqueue(&mut connection).unwrap_err().to_string();
        assert!(error.contains("L3 默认关闭"));
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
        let first = enqueue(&mut connection).unwrap();
        let error = enqueue(&mut connection).unwrap_err().to_string();
        assert!(error.contains(&format!("#{first}")));
        assert!(error.contains("未重复占用"));
    }
}
