use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Value};

use super::error::{CoreError, Result};

pub const CHANNEL_SCHEMA_VERSION: i64 = 2;
pub const RECENT_EPISODE_WINDOW: i64 = 4;
pub const ROUTINE_VISUAL_THRESHOLD: i64 = 3;
pub const LOCATION_NOVELTY_KM: f64 = 50.0;
pub const DH_DURATION_WARNING_SECONDS: f64 = 60.0;

const CHANNEL_SCHEMA_V1: &str = r#"
CREATE TABLE schema_version (
    version INTEGER NOT NULL
);
INSERT INTO schema_version(version) VALUES (1);
CREATE UNIQUE INDEX schema_version_single_row ON schema_version((1));

CREATE TABLE used_shots (
    episode_id TEXT NOT NULL,
    clip_fingerprint TEXT NOT NULL,
    location TEXT NOT NULL,
    function_label TEXT NOT NULL,
    shot_signature TEXT NOT NULL,
    is_hero INTEGER NOT NULL CHECK(is_hero IN (0, 1)),
    used_at TEXT NOT NULL
);
CREATE UNIQUE INDEX used_shots_episode_clip_signature_unique
ON used_shots(episode_id, clip_fingerprint, shot_signature);
CREATE INDEX used_shots_signature_recent_idx
ON used_shots(shot_signature, used_at DESC, episode_id);
CREATE INDEX used_shots_clip_recent_idx
ON used_shots(clip_fingerprint, used_at DESC, episode_id);

CREATE TABLE routine_events (
    routine_kind TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    treatment TEXT NOT NULL
        CHECK(treatment IN ('explained', 'montage', 'story_event')),
    occurred_at TEXT NOT NULL
);
CREATE UNIQUE INDEX routine_events_episode_kind_unique
ON routine_events(episode_id, routine_kind);
CREATE INDEX routine_events_kind_recent_idx
ON routine_events(routine_kind, occurred_at DESC, episode_id);

CREATE TABLE dh_appearances (
    episode_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    duration_s REAL NOT NULL CHECK(duration_s >= 0),
    style TEXT NOT NULL,
    topic TEXT NOT NULL,
    appeared_at TEXT NOT NULL
);
CREATE UNIQUE INDEX dh_appearances_episode_plan_unique
ON dh_appearances(episode_id, mode, style, topic);
CREATE INDEX dh_appearances_recent_idx
ON dh_appearances(appeared_at DESC, episode_id);
"#;

const CHANNEL_SCHEMA_V2_TABLES: &str = r#"
CREATE TABLE episode_catalog (
    memory_id TEXT PRIMARY KEY
        CHECK(length(memory_id) = 32 AND memory_id NOT GLOB '*[^0-9a-f]*'),
    episode_number INTEGER CHECK(episode_number IS NULL OR episode_number > 0),
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
    created_at TEXT NOT NULL,
    archived_at TEXT,
    last_seen_at TEXT NOT NULL
);
CREATE INDEX episode_catalog_number_idx ON episode_catalog(episode_number, memory_id);
CREATE TABLE episode_identity_aliases (
    legacy_episode_id TEXT PRIMARY KEY
        CHECK(length(legacy_episode_id) = 64 AND legacy_episode_id NOT GLOB '*[^0-9a-f]*'),
    memory_id TEXT NOT NULL REFERENCES episode_catalog(memory_id) ON DELETE RESTRICT,
    algorithm TEXT NOT NULL CHECK(algorithm = 'blake3(output_path_utf8)'),
    evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
    reconciled_at TEXT NOT NULL,
    CHECK(legacy_episode_id <> memory_id)
);
CREATE INDEX episode_identity_alias_memory_idx ON episode_identity_aliases(memory_id);
"#;

const CHANNEL_SCHEMA_V2_GUARDS: &str = r#"
CREATE TRIGGER used_shots_episode_insert_guard BEFORE INSERT ON used_shots
WHEN NOT EXISTS (SELECT 1 FROM episode_catalog WHERE memory_id = NEW.episode_id)
BEGIN SELECT RAISE(ABORT, 'unknown channel episode identity'); END;
CREATE TRIGGER used_shots_episode_update_guard BEFORE UPDATE OF episode_id ON used_shots
WHEN NOT EXISTS (SELECT 1 FROM episode_catalog WHERE memory_id = NEW.episode_id)
BEGIN SELECT RAISE(ABORT, 'unknown channel episode identity'); END;
CREATE TRIGGER routine_events_episode_insert_guard BEFORE INSERT ON routine_events
WHEN NOT EXISTS (SELECT 1 FROM episode_catalog WHERE memory_id = NEW.episode_id)
BEGIN SELECT RAISE(ABORT, 'unknown channel episode identity'); END;
CREATE TRIGGER routine_events_episode_update_guard BEFORE UPDATE OF episode_id ON routine_events
WHEN NOT EXISTS (SELECT 1 FROM episode_catalog WHERE memory_id = NEW.episode_id)
BEGIN SELECT RAISE(ABORT, 'unknown channel episode identity'); END;
CREATE TRIGGER dh_appearances_episode_insert_guard BEFORE INSERT ON dh_appearances
WHEN NOT EXISTS (SELECT 1 FROM episode_catalog WHERE memory_id = NEW.episode_id)
BEGIN SELECT RAISE(ABORT, 'unknown channel episode identity'); END;
CREATE TRIGGER dh_appearances_episode_update_guard BEFORE UPDATE OF episode_id ON dh_appearances
WHEN NOT EXISTS (SELECT 1 FROM episode_catalog WHERE memory_id = NEW.episode_id)
BEGIN SELECT RAISE(ABORT, 'unknown channel episode identity'); END;
"#;

#[derive(Debug)]
struct IdentityAliasPlan {
    legacy_id: String,
    memory_id: String,
    evidence_json: String,
}

const ABNORMAL_WEATHER_KEYWORDS: [&str; 12] = [
    "暴雪", "大雪", "冰雹", "冻雨", "极寒", "沙尘", "雷暴", "暴雨", "洪水", "大风",
    "whiteout", "blizzard",
];
const CHANGE_SIGNAL_KEYWORDS: [&str; 20] = [
    "意外", "突然", "坏了", "故障", "冻结", "冻住", "漏水", "没电", "失败", "危险",
    "惊讶", "紧张", "害怕", "崩溃", "救援", "爆胎", "陷车", "事故", "unexpected", "broken",
];

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RoutineSuggestion {
    pub routine_kind: String,
    pub treatment: String,
    pub previous_occurrences: i64,
    pub changed: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClipMemoryAnnotation {
    pub used_episode_badges: Vec<String>,
    pub repeated_signature_uses: i64,
    pub recent_episode_window: i64,
    pub routine_visual: bool,
    pub novelty_context: bool,
    pub narrative_adjustment: f64,
    pub routine_suggestion: Option<RoutineSuggestion>,
}

impl Default for ClipMemoryAnnotation {
    fn default() -> Self {
        Self {
            used_episode_badges: Vec::new(),
            repeated_signature_uses: 0,
            recent_episode_window: RECENT_EPISODE_WINDOW,
            routine_visual: false,
            novelty_context: false,
            narrative_adjustment: 0.0,
            routine_suggestion: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DhAppearanceSummary {
    pub episode_badge: String,
    pub mode: String,
    pub duration_s: f64,
    pub style: String,
    pub topic: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DhGuardSummary {
    pub historical_appearances: Vec<DhAppearanceSummary>,
    pub current_estimated_duration_s: f64,
    pub duration_warning_threshold_s: f64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct DhPlannedSlot {
    pub chapter_title: String,
    pub mode: String,
    pub slot: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct ExportedSelection {
    pub clip_id: i64,
    pub segment_id: Option<i64>,
    pub in_ticks: i64,
    pub out_ticks: i64,
}

#[derive(Debug)]
struct ShotEvidence {
    fingerprint: String,
    location: String,
    signature: String,
    function_label: String,
    is_hero: bool,
    routine_kind: Option<String>,
    changed: bool,
    novel_context_signal: bool,
}

#[derive(Debug)]
struct DhPlanRecord {
    mode: String,
    duration_s: f64,
    style: String,
    topic: String,
}

pub struct ChannelMemoryReader {
    channel: Option<Connection>,
    degraded_reason: Option<String>,
}

impl ChannelMemoryReader {
    pub fn for_project(project: &Connection) -> Result<Self> {
        let path = channel_path_for_project(project)?;
        match open_existing_channel_for_project(project, &path) {
            Ok(channel) => Ok(Self { channel, degraded_reason: None }),
            Err(error @ CoreError::ChannelMemory(_)) => {
                tracing::warn!(%error, "channel memory disabled until identity reconciliation is resolved");
                Ok(Self { channel: None, degraded_reason: Some(error.to_string()) })
            }
            Err(error) => Err(error),
        }
    }

    pub fn clip_annotation(
        &self,
        project: &Connection,
        clip_id: i64,
        segment_id: Option<i64>,
        in_ticks: i64,
        out_ticks: i64,
    ) -> Result<ClipMemoryAnnotation> {
        let evidence = load_shot_evidence(project, clip_id, segment_id, in_ticks, out_ticks)?;
        clip_annotation_from_channel(self.channel.as_ref(), &evidence)
    }

    pub fn prompt_clip_context(
        &self,
        project: &Connection,
        clip_id: i64,
        segment_id: Option<i64>,
        in_ticks: i64,
        out_ticks: i64,
    ) -> Result<Value> {
        let mut value = serde_json::to_value(self.clip_annotation(
            project,
            clip_id,
            segment_id,
            in_ticks,
            out_ticks,
        )?)
        .map_err(|error| {
            CoreError::ChannelMemory(format!("长期记忆 prompt 序列化失败：{error}"))
        })?;
        if let (Some(reason), Some(object)) = (&self.degraded_reason, value.as_object_mut()) {
            object.insert("memory_unavailable".to_owned(), Value::String(reason.clone()));
        }
        Ok(value)
    }
}

pub fn channel_path_for_project(project: &Connection) -> Result<PathBuf> {
    let mut statement = project.prepare("PRAGMA database_list")?;
    let mut rows = statement.query([])?;
    let mut main_file = None;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == "main" {
            main_file = Some(row.get::<_, String>(2)?);
            break;
        }
    }
    let file = main_file.filter(|value| !value.is_empty()).ok_or_else(|| {
        CoreError::ChannelMemory("无法从内存项目库推导 channel.db 路径".to_owned())
    })?;
    let project_path = PathBuf::from(file);
    let project_parent = project_path.parent().ok_or_else(|| {
        CoreError::ChannelMemory(format!("项目库没有父目录：{}", project_path.display()))
    })?;
    if project_parent
        .file_name()
        .is_some_and(|name| name == std::ffi::OsStr::new("dev"))
    {
        if let Some(app_support) = project_parent.parent() {
            if app_support
                .file_name()
                .is_some_and(|name| name == std::ffi::OsStr::new("TripCutStudio"))
            {
                return Ok(app_support.join("channel.db"));
            }
        }
    }
    Ok(project_parent.join("channel.db"))
}

pub fn initialize(path: &Path) -> Result<()> {
    let connection = open_channel(path)?;
    drop(connection);
    Ok(())
}

pub fn prepare_for_project(project: &Connection) -> Result<()> {
    let path = channel_path_for_project(project)?;
    let connection = open_channel_for_project(project, &path)?;
    drop(connection);
    Ok(())
}

fn open_channel(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut connection = Connection::open(path)?;
    configure(&connection)?;
    let has_version: i64 = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version')",
        [],
        |row| row.get(0),
    )?;
    if has_version == 0 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(CHANNEL_SCHEMA_V1)?;
        transaction.execute_batch(CHANNEL_SCHEMA_V2_TABLES)?;
        transaction.execute_batch(CHANNEL_SCHEMA_V2_GUARDS)?;
        transaction.execute("UPDATE schema_version SET version = 2", [])?;
        transaction.commit()?;
    }
    validate_schema(&connection)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    Ok(connection)
}

fn open_channel_for_project(project: &Connection, path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut connection = Connection::open(path)?;
    configure(&connection)?;
    let has_version: i64 = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version')",
        [],
        |row| row.get(0),
    )?;
    if has_version == 0 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(CHANNEL_SCHEMA_V1)?;
        transaction.commit()?;
    }
    let found: i64 = connection.query_row("SELECT version FROM schema_version", [], |row| row.get(0))?;
    if found == 1 {
        migrate_channel_v2(project, &mut connection)?;
    }
    validate_schema(&connection)?;
    sync_episode_catalog(project, &mut connection)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    Ok(connection)
}

fn open_existing_channel_for_project(
    project: &Connection,
    path: &Path,
) -> Result<Option<Connection>> {
    if !path.is_file() {
        return Ok(None);
    }
    open_channel_for_project(project, path).map(Some)
}

fn migrate_channel_v2(project: &Connection, channel: &mut Connection) -> Result<()> {
    let plans = build_identity_reconciliation_plan(project, channel)?;
    let transaction = channel.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(CHANNEL_SCHEMA_V2_TABLES)?;
    sync_episode_catalog_in(project, &transaction)?;
    for plan in plans {
        transaction.execute(
            "INSERT INTO used_shots(
                episode_id, clip_fingerprint, location, function_label,
                shot_signature, is_hero, used_at
             )
             SELECT ?2, clip_fingerprint, location, function_label,
                    shot_signature, is_hero, used_at
               FROM used_shots WHERE episode_id = ?1
             ON CONFLICT(episode_id, clip_fingerprint, shot_signature) DO UPDATE SET
               location = CASE WHEN excluded.used_at > used_shots.used_at
                               THEN excluded.location ELSE used_shots.location END,
               function_label = CASE WHEN excluded.used_at > used_shots.used_at
                                     THEN excluded.function_label ELSE used_shots.function_label END,
               is_hero = MAX(used_shots.is_hero, excluded.is_hero),
               used_at = MIN(used_shots.used_at, excluded.used_at)",
            params![plan.legacy_id, plan.memory_id],
        )?;
        transaction.execute(
            "INSERT INTO routine_events(routine_kind, episode_id, treatment, occurred_at)
             SELECT routine_kind, ?2, treatment, occurred_at
               FROM routine_events WHERE episode_id = ?1
             ON CONFLICT(episode_id, routine_kind) DO UPDATE SET
               treatment = CASE
                 WHEN routine_events.treatment='story_event'
                   OR excluded.treatment='story_event' THEN 'story_event'
                 WHEN excluded.occurred_at > routine_events.occurred_at
                   THEN excluded.treatment ELSE routine_events.treatment END,
               occurred_at = MIN(routine_events.occurred_at, excluded.occurred_at)",
            params![plan.legacy_id, plan.memory_id],
        )?;
        transaction.execute(
            "INSERT INTO dh_appearances(
                episode_id, mode, duration_s, style, topic, appeared_at
             )
             SELECT ?2, mode, duration_s, style, topic, appeared_at
               FROM dh_appearances WHERE episode_id = ?1
             ON CONFLICT(episode_id, mode, style, topic) DO UPDATE SET
               duration_s = CASE
                 WHEN excluded.appeared_at > dh_appearances.appeared_at
                   THEN excluded.duration_s
                 WHEN excluded.appeared_at = dh_appearances.appeared_at
                   THEN MAX(excluded.duration_s, dh_appearances.duration_s)
                 ELSE dh_appearances.duration_s END,
               appeared_at = MIN(dh_appearances.appeared_at, excluded.appeared_at)",
            params![plan.legacy_id, plan.memory_id],
        )?;
        transaction.execute("DELETE FROM used_shots WHERE episode_id=?1", [&plan.legacy_id])?;
        transaction.execute("DELETE FROM routine_events WHERE episode_id=?1", [&plan.legacy_id])?;
        transaction.execute("DELETE FROM dh_appearances WHERE episode_id=?1", [&plan.legacy_id])?;
        transaction.execute(
            "INSERT INTO episode_identity_aliases(
                legacy_episode_id, memory_id, algorithm, evidence_json, reconciled_at
             ) VALUES (?1, ?2, 'blake3(output_path_utf8)', ?3,
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![plan.legacy_id, plan.memory_id, plan.evidence_json],
        )?;
    }
    let orphan_count: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM (
             SELECT episode_id FROM used_shots
             UNION SELECT episode_id FROM routine_events
             UNION SELECT episode_id FROM dh_appearances
         ) fact
         WHERE NOT EXISTS (
             SELECT 1 FROM episode_catalog catalog WHERE catalog.memory_id = fact.episode_id
         )",
        [],
        |row| row.get(0),
    )?;
    if orphan_count != 0 {
        return Err(CoreError::ChannelMemory(format!(
            "channel.db V2 升级仍有 {orphan_count} 个无法归属的 Episode identity"
        )));
    }
    transaction.execute_batch(CHANNEL_SCHEMA_V2_GUARDS)?;
    transaction.execute("UPDATE schema_version SET version=2 WHERE version=1", [])?;
    transaction.commit()?;
    Ok(())
}

fn build_identity_reconciliation_plan(
    project: &Connection,
    channel: &Connection,
) -> Result<Vec<IdentityAliasPlan>> {
    let canonical = {
        let mut statement = project.prepare("SELECT memory_id FROM episodes")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<BTreeSet<_>>>()?
    };
    let identities = {
        let mut statement = channel.prepare(
            "SELECT episode_id FROM used_shots
             UNION SELECT episode_id FROM routine_events
             UNION SELECT episode_id FROM dh_appearances",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let exports = {
        let mut statement = project.prepare(
            "SELECT id, output_path, manifest, episode_id FROM exports
             WHERE output_path IS NOT NULL ORDER BY id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut plans = Vec::new();
    for identity in identities {
        if canonical.contains(&identity) {
            continue;
        }
        if !is_lower_hex(&identity, 64) {
            return Err(CoreError::ChannelMemory(format!(
                "无法识别旧 Episode identity：{identity}"
            )));
        }
        let legacy_fingerprints = {
            let mut statement = channel.prepare(
                "SELECT DISTINCT clip_fingerprint FROM used_shots WHERE episode_id=?1",
            )?;
            let rows = statement.query_map([&identity], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<BTreeSet<_>>>()?
        };
        if legacy_fingerprints.is_empty() {
            return Err(CoreError::ChannelMemory(format!(
                "旧 Episode identity {identity} 只有 Routine/DH 记录，没有镜头证据，拒绝猜测归属"
            )));
        }
        let mut candidate_memories = BTreeSet::new();
        let mut candidate_fingerprints = BTreeSet::new();
        let mut export_ids = Vec::new();
        for (export_id, output_path, manifest, export_episode_id) in &exports {
            if legacy_episode_id(output_path) != identity {
                continue;
            }
            let episode_db_id = export_episode_id.ok_or_else(|| {
                CoreError::ChannelMemory(format!("旧导出 {export_id} 没有 Episode 归属"))
            })?;
            let memory_id: String = project.query_row(
                "SELECT memory_id FROM episodes WHERE id=?1",
                [episode_db_id],
                |row| row.get(0),
            )?;
            let value: Value = serde_json::from_str(manifest).map_err(|error| {
                CoreError::ChannelMemory(format!("旧导出 {export_id} manifest 损坏：{error}"))
            })?;
            if value.get("episode_id").and_then(Value::as_i64) != Some(episode_db_id) {
                return Err(CoreError::ChannelMemory(format!(
                    "旧导出 {export_id} 的 manifest Episode 与数据库不一致"
                )));
            }
            let clips = value.get("clips").and_then(Value::as_array).ok_or_else(|| {
                CoreError::ChannelMemory(format!("旧导出 {export_id} manifest 缺少 clips"))
            })?;
            let items = value
                .pointer("/progress/items")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    CoreError::ChannelMemory(format!("旧导出 {export_id} manifest 缺少 progress.items"))
                })?;
            if clips.len() != items.len() {
                return Err(CoreError::ChannelMemory(format!(
                    "旧导出 {export_id} 的 clips 与 progress.items 数量不一致"
                )));
            }
            let mut done = 0_usize;
            for (clip, item) in clips.iter().zip(items) {
                if item.get("status").and_then(Value::as_str) != Some("done") {
                    continue;
                }
                done += 1;
                let clip_id = clip.get("clip_id").and_then(Value::as_i64).ok_or_else(|| {
                    CoreError::ChannelMemory(format!("旧导出 {export_id} 含无效 clip_id"))
                })?;
                let owner: i64 = project.query_row(
                    "SELECT episode_id FROM clips WHERE id=?1",
                    [clip_id],
                    |row| row.get(0),
                )?;
                if owner != episode_db_id {
                    return Err(CoreError::ChannelMemory(format!(
                        "旧导出 {export_id} 含另一个 Episode 的素材 {clip_id}"
                    )));
                }
                let source_identity = clip
                    .get("full_hash")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .or_else(|| clip.get("quick_hash").and_then(Value::as_str))
                    .ok_or_else(|| {
                        CoreError::ChannelMemory(format!("旧导出 {export_id} 素材缺少内容指纹"))
                    })?;
                let segment_id = clip.get("segment_id").and_then(Value::as_i64).unwrap_or(0);
                let in_ticks = clip.get("in_ticks").and_then(Value::as_i64).ok_or_else(|| {
                    CoreError::ChannelMemory(format!("旧导出 {export_id} 素材缺少 in_ticks"))
                })?;
                let out_ticks = clip.get("out_ticks").and_then(Value::as_i64).ok_or_else(|| {
                    CoreError::ChannelMemory(format!("旧导出 {export_id} 素材缺少 out_ticks"))
                })?;
                candidate_fingerprints.insert(
                    blake3::hash(
                        format!("{source_identity}\0{segment_id}\0{in_ticks}\0{out_ticks}").as_bytes(),
                    )
                    .to_hex()
                    .to_string(),
                );
            }
            if done == 0 {
                return Err(CoreError::ChannelMemory(format!(
                    "旧导出 {export_id} 没有成功完成的素材，不能作为映射证据"
                )));
            }
            candidate_memories.insert(memory_id);
            export_ids.push(*export_id);
        }
        if candidate_memories.len() != 1
            || !legacy_fingerprints.is_subset(&candidate_fingerprints)
        {
            return Err(CoreError::ChannelMemory(format!(
                "旧 Episode identity {identity} 无法由导出路径与镜头指纹唯一映射；channel.db 保持 V1"
            )));
        }
        let memory_id = candidate_memories.into_iter().next().unwrap();
        plans.push(IdentityAliasPlan {
            legacy_id: identity,
            memory_id,
            evidence_json: json!({
                "export_ids": export_ids,
                "legacy_fingerprints": legacy_fingerprints,
                "algorithm": "blake3(output_path_utf8)"
            })
            .to_string(),
        });
    }
    Ok(plans)
}

fn legacy_episode_id(output_path: &str) -> String {
    blake3::hash(output_path.as_bytes()).to_hex().to_string()
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sync_episode_catalog(project: &Connection, channel: &mut Connection) -> Result<()> {
    let transaction = channel.transaction_with_behavior(TransactionBehavior::Immediate)?;
    sync_episode_catalog_in(project, &transaction)?;
    transaction.commit()?;
    Ok(())
}

fn sync_episode_catalog_in(project: &Connection, channel: &Connection) -> Result<()> {
    let mut statement = project.prepare(
        "SELECT memory_id, episode_number, title, status, created_at, archived_at FROM episodes",
    )?;
    let episodes = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (memory_id, number, title, status, created_at, archived_at) in episodes {
        if !is_lower_hex(&memory_id, 32) {
            return Err(CoreError::ChannelMemory(format!(
                "Episode {number} 的 memory_id 无效"
            )));
        }
        channel.execute(
            "INSERT INTO episode_catalog(
                memory_id, episode_number, title, status, created_at, archived_at, last_seen_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             ON CONFLICT(memory_id) DO UPDATE SET
               episode_number=excluded.episode_number, title=excluded.title,
               status=excluded.status, archived_at=excluded.archived_at,
               last_seen_at=excluded.last_seen_at",
            params![memory_id, number, title, status, created_at, archived_at],
        )?;
    }
    Ok(())
}

fn configure(connection: &Connection) -> Result<()> {
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

fn validate_schema(connection: &Connection) -> Result<()> {
    let versions = {
        let mut statement = connection.prepare("SELECT version FROM schema_version")?;
        let rows = statement.query_map([], |row| row.get::<_, i64>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    if versions.len() != 1 {
        return Err(CoreError::InvalidSchema(format!(
            "channel.db schema_version 必须恰有一行，实际 {} 行",
            versions.len()
        )));
    }
    let found = versions[0];
    if found > CHANNEL_SCHEMA_VERSION {
        return Err(CoreError::UnsupportedSchema {
            found,
            supported: CHANNEL_SCHEMA_VERSION,
        });
    }
    if found < CHANNEL_SCHEMA_VERSION {
        return Err(CoreError::InvalidSchema(format!(
            "channel.db schema version {found} 缺少迁移定义"
        )));
    }
    Ok(())
}

pub fn clip_annotation(
    project: &Connection,
    clip_id: i64,
    segment_id: Option<i64>,
    in_ticks: i64,
    out_ticks: i64,
) -> Result<ClipMemoryAnnotation> {
    ChannelMemoryReader::for_project(project)?
        .clip_annotation(project, clip_id, segment_id, in_ticks, out_ticks)
}


/// P6-G3 Memory Lens:筛片主战场的跨集记忆批量视图。
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct MemoryLensEntry {
    pub clip_id: i64,
    pub used_episode_badges: Vec<String>,
    pub repeated_signature_uses: i64,
    pub recent_episode_window: i64,
    pub routine_visual: bool,
    pub novelty_context: bool,
}

pub fn memory_lens(project: &Connection) -> Result<Vec<MemoryLensEntry>> {
    let reader = ChannelMemoryReader::for_project(project)?;
    let mut statement = project.prepare(
        "SELECT id, duration_ticks FROM clips WHERE missing_since IS NULL",
    )?;
    let clips = statement
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut lens = Vec::with_capacity(clips.len());
    for (clip_id, duration_ticks) in clips {
        let annotation = reader.clip_annotation(project, clip_id, None, 0, duration_ticks)?;
        if annotation.used_episode_badges.is_empty()
            && annotation.repeated_signature_uses == 0
            && !annotation.routine_visual
            && !annotation.novelty_context
        {
            continue;
        }
        lens.push(MemoryLensEntry {
            clip_id,
            used_episode_badges: annotation.used_episode_badges,
            repeated_signature_uses: annotation.repeated_signature_uses,
            recent_episode_window: annotation.recent_episode_window,
            routine_visual: annotation.routine_visual,
            novelty_context: annotation.novelty_context,
        });
    }
    Ok(lens)
}

#[cfg(test)]
fn clip_annotation_with_path(
    project: &Connection,
    path: &Path,
    evidence: &ShotEvidence,
) -> Result<ClipMemoryAnnotation> {
    let channel = open_channel_for_project(project, path)?;
    clip_annotation_from_channel(Some(&channel), evidence)
}

fn clip_annotation_from_channel(
    channel: Option<&Connection>,
    evidence: &ShotEvidence,
) -> Result<ClipMemoryAnnotation> {
    let Some(channel) = channel else {
        return Ok(ClipMemoryAnnotation {
            routine_suggestion: evidence.routine_kind.as_ref().map(|kind| {
                routine_suggestion(kind, 0, evidence.changed)
            }),
            novelty_context: evidence.novel_context_signal,
            ..ClipMemoryAnnotation::default()
        });
    };
    let episode_labels = episode_labels(channel)?;
    let used_episode_ids = {
        let mut statement = channel.prepare(
            "SELECT DISTINCT episode_id FROM used_shots
             WHERE clip_fingerprint=?1 ORDER BY used_at, episode_id",
        )?;
        let rows = statement.query_map([&evidence.fingerprint], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let recent_episodes = recent_episode_ids(channel, RECENT_EPISODE_WINDOW)?;
    let repeated_signature_uses = if recent_episodes.is_empty() {
        0
    } else {
        let placeholders = std::iter::repeat_n("?", recent_episodes.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT COUNT(DISTINCT episode_id) FROM used_shots
             WHERE shot_signature=?1 AND episode_id IN ({placeholders})"
        );
        let mut values = Vec::<&dyn rusqlite::ToSql>::with_capacity(recent_episodes.len() + 1);
        values.push(&evidence.signature);
        for episode in &recent_episodes {
            values.push(episode);
        }
        channel.query_row(&sql, values.as_slice(), |row| row.get(0))?
    };
    let routine_visual = repeated_signature_uses >= ROUTINE_VISUAL_THRESHOLD;
    let novelty_context = evidence.novel_context_signal
        || location_is_novel(channel, &evidence.signature, &evidence.location)?;
    let previous_occurrences = match evidence.routine_kind.as_deref() {
        Some(kind) => channel.query_row(
            "SELECT COUNT(DISTINCT episode_id) FROM routine_events WHERE routine_kind=?1",
            [kind],
            |row| row.get(0),
        )?,
        None => 0,
    };
    Ok(ClipMemoryAnnotation {
        used_episode_badges: used_episode_ids
            .iter()
            .filter_map(|episode| episode_labels.get(episode).cloned())
            .collect(),
        repeated_signature_uses,
        recent_episode_window: RECENT_EPISODE_WINDOW,
        routine_visual,
        novelty_context,
        narrative_adjustment: if routine_visual {
            if novelty_context { 0.10 } else { -0.20 }
        } else {
            0.0
        },
        routine_suggestion: evidence
            .routine_kind
            .as_ref()
            .map(|kind| routine_suggestion(kind, previous_occurrences, evidence.changed)),
    })
}

pub fn prompt_clip_context(
    project: &Connection,
    clip_id: i64,
    segment_id: Option<i64>,
    in_ticks: i64,
    out_ticks: i64,
) -> Result<Value> {
    ChannelMemoryReader::for_project(project)?
        .prompt_clip_context(project, clip_id, segment_id, in_ticks, out_ticks)
}

pub fn dh_guard(project: &Connection, planned: &[DhPlannedSlot]) -> Result<DhGuardSummary> {
    let path = channel_path_for_project(project)?;
    let historical_appearances = if let Some(channel) = open_existing_channel_for_project(project, &path)? {
        let labels = episode_labels(&channel)?;
        let mut statement = channel.prepare(
            "SELECT episode_id, mode, duration_s, style, topic
             FROM dh_appearances ORDER BY appeared_at DESC, rowid DESC LIMIT 12",
        )?;
        let rows = statement.query_map([], |row| {
            let episode_id: String = row.get(0)?;
            Ok(DhAppearanceSummary {
                episode_badge: labels.get(&episode_id).cloned().unwrap_or_else(|| "EP?".to_owned()),
                mode: row.get(1)?,
                duration_s: row.get(2)?,
                style: row.get(3)?,
                topic: row.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        Vec::new()
    };
    let current_estimated_duration_s = planned
        .iter()
        .map(|slot| estimated_dh_slot_seconds(&slot.slot))
        .sum::<f64>();
    let mut warnings = dh_spacing_warnings(planned);
    if current_estimated_duration_s > DH_DURATION_WARNING_SECONDS {
        warnings.push(format!(
            "本集数字人规划约 {current_estimated_duration_s:.0} 秒，超过 {DH_DURATION_WARNING_SECONDS:.0} 秒阈值；建议合并连续知识点。"
        ));
    }
    Ok(DhGuardSummary {
        historical_appearances,
        current_estimated_duration_s,
        duration_warning_threshold_s: DH_DURATION_WARNING_SECONDS,
        warnings,
    })
}

pub fn dh_spacing_warnings(planned: &[DhPlannedSlot]) -> Vec<String> {
    let mut warnings = Vec::new();
    for pair in planned.windows(2) {
        let left = &pair[0];
        let right = &pair[1];
        let real_slots_between = real_slots_between(&left.slot, &right.slot);
        if real_slots_between < 2 {
            warnings.push(format!(
                "{} 模式{} {} 与 {} 模式{} {} 之间仅 {real_slots_between} 个实拍槽；建议合并为一条 DH→Map/Archive/B-roll→Reality→真人体验链。",
                left.chapter_title, left.mode, left.slot, right.chapter_title, right.mode, right.slot
            ));
        }
    }
    warnings
}

fn real_slots_between(left: &str, right: &str) -> usize {
    const FLOW: [&str; 9] = [
        "DH INTRO", "MAP", "REAL/ESTABLISHING", "REAL/EXPERIENCE", "REAL/DETAIL",
        "DH OVERLAY", "REAL/HUMAN", "ATMOSPHERE", "TRANSITION",
    ];
    let left_index = FLOW.iter().position(|slot| *slot == left);
    let right_index = FLOW.iter().position(|slot| *slot == right);
    match (left_index, right_index) {
        (Some(left), Some(right)) if right > left => FLOW[left + 1..right]
            .iter()
            .filter(|slot| slot.starts_with("REAL/") || matches!(**slot, "ATMOSPHERE" | "TRANSITION"))
            .count(),
        _ => 0,
    }
}

fn estimated_dh_slot_seconds(slot: &str) -> f64 {
    match slot {
        "DH INTRO" => 12.0,
        "DH OVERLAY" => 8.0,
        _ => 10.0,
    }
}

pub fn default_dh_slot_for_mode(mode: &str) -> &'static str {
    match mode {
        "A" | "D" => "DH INTRO",
        "B" | "C" | "E" => "DH OVERLAY",
        _ => "DH INTRO",
    }
}

pub fn record_successful_export(
    project: &Connection,
    channel_path: &Path,
    episode_id: &str,
    selections: &[ExportedSelection],
) -> Result<()> {
    if episode_id.trim().is_empty() {
        return Err(CoreError::ChannelMemory("导出 episode_id 不能为空".to_owned()));
    }
    let episode_db_id: i64 = project
        .query_row(
            "SELECT id FROM episodes WHERE memory_id = ?1",
            [episode_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| {
            CoreError::ChannelMemory(format!("未知的 Episode memory_id：{episode_id}"))
        })?;
    for selection in selections {
        let owner: Option<i64> = project
            .query_row(
                "SELECT episode_id FROM clips WHERE id=?1",
                [selection.clip_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        if owner != Some(episode_db_id) {
            return Err(CoreError::ChannelMemory(format!(
                "素材 {} 不属于本次导出的 Episode",
                selection.clip_id
            )));
        }
    }
    let evidence = selections
        .iter()
        .map(|selection| {
            load_shot_evidence(
                project,
                selection.clip_id,
                selection.segment_id,
                selection.in_ticks,
                selection.out_ticks,
            )
        })
        .collect::<Result<Vec<_>>>()?;
    let dh_plans = load_dh_plans(project, episode_db_id)?;
    let mut channel = open_channel_for_project(project, channel_path)?;
    let transaction = channel.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for shot in evidence {
        transaction.execute(
            "INSERT INTO used_shots(
                episode_id, clip_fingerprint, location, function_label,
                shot_signature, is_hero, used_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6,
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(episode_id, clip_fingerprint, shot_signature) DO UPDATE SET
               location=excluded.location,
               function_label=excluded.function_label,
               is_hero=MAX(used_shots.is_hero, excluded.is_hero)",
            params![
                episode_id,
                shot.fingerprint,
                shot.location,
                shot.function_label,
                shot.signature,
                shot.is_hero as i64,
            ],
        )?;
        if let Some(kind) = shot.routine_kind {
            let previous: i64 = transaction.query_row(
                "SELECT COUNT(DISTINCT episode_id) FROM routine_events
                 WHERE routine_kind=?1 AND episode_id<>?2",
                params![kind, episode_id],
                |row| row.get(0),
            )?;
            let suggestion = routine_suggestion(&kind, previous, shot.changed);
            transaction.execute(
                "INSERT INTO routine_events(routine_kind, episode_id, treatment, occurred_at)
                 VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                 ON CONFLICT(episode_id, routine_kind) DO UPDATE SET
                   treatment=CASE
                     WHEN routine_events.treatment='story_event' THEN routine_events.treatment
                     ELSE excluded.treatment END",
                params![kind, episode_id, suggestion.treatment],
            )?;
        }
    }
    for plan in dh_plans {
        transaction.execute(
            "INSERT INTO dh_appearances(
                episode_id, mode, duration_s, style, topic, appeared_at
             ) VALUES (?1, ?2, ?3, ?4, ?5,
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(episode_id, mode, style, topic) DO UPDATE SET
               duration_s=excluded.duration_s",
            params![episode_id, plan.mode, plan.duration_s, plan.style, plan.topic],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn load_shot_evidence(
    project: &Connection,
    clip_id: i64,
    segment_id: Option<i64>,
    in_ticks: i64,
    out_ticks: i64,
) -> Result<ShotEvidence> {
    let row = project
        .query_row(
            "SELECT COALESCE(c.full_hash, c.quick_hash, c.volume_uuid || ':' || c.rel_path),
                    c.gps_lat, c.gps_lon,
                    COALESCE(function.label, '不确定'),
                    COALESCE(size.label, '不确定'),
                    COALESCE(movement.label, '不确定'),
                    COALESCE(subject.label, '不确定'),
                    COALESCE(person.label, '不确定'),
                    COALESCE(stage.label, '不确定'),
                    COALESCE((
                        SELECT GROUP_CONCAT(text, ' ') FROM transcript_segments transcript
                        WHERE transcript.clip_id=c.id
                    ), ''),
                    COALESCE((
                        SELECT GROUP_CONCAT(tag.label, ' ') FROM tags tag
                        JOIN segments tagged ON tagged.id=tag.segment_id
                        WHERE tagged.clip_id=c.id
                    ), ''),
                    EXISTS(
                        SELECT 1 FROM shot_stack_members member
                        WHERE member.clip_id=c.id
                          AND (member.segment_id IS NULL OR member.segment_id=?2)
                          AND member.user_state='hero'
                    )
             FROM clips c
             LEFT JOIN clip_dimensions function
               ON function.clip_id=c.id AND function.dimension='function'
             LEFT JOIN clip_dimensions size
               ON size.clip_id=c.id AND size.dimension='shot_size'
             LEFT JOIN clip_dimensions movement
               ON movement.clip_id=c.id AND movement.dimension='movement'
             LEFT JOIN clip_dimensions subject
               ON subject.clip_id=c.id AND subject.dimension='subject'
             LEFT JOIN clip_dimensions person
               ON person.clip_id=c.id AND person.dimension='person_state'
             LEFT JOIN clip_dimensions stage
               ON stage.clip_id=c.id AND stage.dimension='time_stage'
             WHERE c.id=?1",
            params![clip_id, segment_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<f64>>(1)?,
                    row.get::<_, Option<f64>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, i64>(11)? == 1,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| CoreError::ChannelMemory(format!("素材 {clip_id} 不存在")))?;
    let fingerprint = blake3::hash(
        format!("{}\0{}\0{}\0{}", row.0, segment_id.unwrap_or(0), in_ticks, out_ticks).as_bytes(),
    )
    .to_hex()
    .to_string();
    let location = match (row.1, row.2) {
        (Some(lat), Some(lon)) if lat.is_finite() && lon.is_finite() => {
            format!("{lat:.5},{lon:.5}")
        }
        _ => String::new(),
    };
    let signature = format!("{}|{}|{}|{}", row.3, row.4, row.5, row.6);
    let combined_text = format!("{} {}", row.9, row.10);
    let routine_kind = recognize_routine(&combined_text, &row.7, &row.6, &row.8, &row.3);
    let changed = contains_any(&combined_text, &CHANGE_SIGNAL_KEYWORDS)
        || contains_any(&combined_text, &ABNORMAL_WEATHER_KEYWORDS);
    let novel_context_signal = contains_any(&combined_text, &ABNORMAL_WEATHER_KEYWORDS);
    Ok(ShotEvidence {
        fingerprint,
        location,
        signature,
        function_label: row.3,
        is_hero: row.11,
        routine_kind,
        changed,
        novel_context_signal,
    })
}

fn recognize_routine(
    text: &str,
    person_state: &str,
    subject: &str,
    time_stage: &str,
    function: &str,
) -> Option<String> {
    const ROUTINES: [(&str, &[&str]); 15] = [
        ("起床", &["起床", "醒了", "早安", "wake up", "waking up"]),
        ("咖啡", &["咖啡", "coffee", "espresso", "手冲"]),
        ("收营", &["收营", "撤营", "拔营", "pack up camp", "break camp"]),
        ("发动", &["发动", "点火", "启动房车", "start the rv", "start engine"]),
        ("驾驶", &["驾驶", "开车", "上路", "drive", "driving"]),
        ("加油", &["加油", "油站", "gas station", "fuel", "refuel"]),
        ("采购", &["采购", "买菜", "超市", "grocery", "groceries", "shopping"]),
        ("倒车", &["倒车", "倒库", "reverse", "backing up"]),
        ("调平", &["调平", "支腿", "leveling", "levelling", "level the rv"]),
        ("接水", &["接水", "加水", "水管", "fill water", "water hookup"]),
        ("接电", &["接电", "岸电", "电桩", "shore power", "electric hookup"]),
        ("遮阳棚", &["遮阳棚", "雨棚", "awning"]),
        ("做饭", &["做饭", "烹饪", "下厨", "cook", "cooking"]),
        ("篝火", &["篝火", "营火", "campfire", "fire pit"]),
        ("睡觉", &["睡觉", "晚安", "上床", "go to bed", "sleep"]),
    ];
    let normalized = text.to_lowercase();
    for (kind, keywords) in ROUTINES {
        if keywords.iter().any(|keyword| normalized.contains(&keyword.to_lowercase())) {
            return Some(kind.to_owned());
        }
    }
    if subject == "交通" && time_stage == "路上" {
        return Some("驾驶".to_owned());
    }
    if person_state == "操作" && subject == "食物" {
        return Some("做饭".to_owned());
    }
    if person_state == "吃喝" && subject == "食物" && time_stage == "出发" {
        return Some("咖啡".to_owned());
    }
    if person_state == "操作" && subject == "交通" && function == "Transition" {
        return Some("收营".to_owned());
    }
    None
}

fn routine_suggestion(kind: &str, previous: i64, changed: bool) -> RoutineSuggestion {
    if changed {
        RoutineSuggestion {
            routine_kind: kind.to_owned(),
            treatment: "story_event".to_owned(),
            previous_occurrences: previous,
            changed,
            reason: format!("{kind} 出现情绪、意外或异常天气信号，建议升级 Main Story Event。"),
        }
    } else if previous == 0 {
        RoutineSuggestion {
            routine_kind: kind.to_owned(),
            treatment: "explained".to_owned(),
            previous_occurrences: previous,
            changed,
            reason: format!("频道记忆中首次出现 {kind}，可完整解释；仅建议，不强制。"),
        }
    } else {
        RoutineSuggestion {
            routine_kind: kind.to_owned(),
            treatment: "montage".to_owned(),
            previous_occurrences: previous,
            changed,
            reason: format!("{kind} 已在 {previous} 集出现，建议压缩为约 2 秒 Montage/Transition；仅建议，不强制。"),
        }
    }
}

fn load_dh_plans(project: &Connection, episode_id: i64) -> Result<Vec<DhPlanRecord>> {
    let mut statement = project.prepare(
        "SELECT chapter.title, chapter.dh_plan_json
         FROM narrative_chapters chapter
         WHERE chapter.episode_id = ?1
         ORDER BY chapter.\"order\", chapter.id",
    )?;
    let rows = statement.query_map([episode_id], |row| {
        let topic: String = row.get(0)?;
        let json_text: String = row.get(1)?;
        Ok((topic, json_text))
    })?;
    let mut plans = Vec::new();
    for row in rows {
        let (topic, json_text) = row?;
        if json_text == "null" || json_text.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(&json_text).map_err(|error| {
            CoreError::ChannelMemory(format!("数字人规划 JSON 无效：{error}"))
        })?;
        let Some(mode) = value.get("mode").and_then(Value::as_str) else {
            continue;
        };
        let slots = value
            .get("planned_slots")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut dh_slots = slots
            .iter()
            .filter_map(Value::as_str)
            .filter(|slot| slot.starts_with("DH"))
            .collect::<Vec<_>>();
        if dh_slots.is_empty() {
            dh_slots.push(default_dh_slot_for_mode(mode));
        }
        let duration_s = dh_slots.into_iter().map(estimated_dh_slot_seconds).sum();
        plans.push(DhPlanRecord {
            mode: mode.to_owned(),
            duration_s,
            style: format!("planned-mode-{mode}"),
            topic,
        });
    }
    Ok(plans)
}

fn episode_labels(channel: &Connection) -> Result<BTreeMap<String, String>> {
    let mut statement = channel.prepare(
        "SELECT memory_id, episode_number, title
           FROM episode_catalog
          ORDER BY episode_number IS NULL, episode_number, memory_id",
    )?;
    let rows = statement.query_map([], |row| {
        let memory_id: String = row.get(0)?;
        let number: Option<i64> = row.get(1)?;
        let title: String = row.get(2)?;
        let label = number
            .map(|value| format!("EP{value:02}"))
            .unwrap_or_else(|| title.clone());
        Ok((memory_id, label))
    })?;
    rows.collect::<rusqlite::Result<BTreeMap<_, _>>>()
        .map_err(CoreError::from)
}

fn recent_episode_ids(channel: &Connection, limit: i64) -> Result<Vec<String>> {
    let mut statement = channel.prepare(
        "SELECT episode_id FROM used_shots
         GROUP BY episode_id ORDER BY MAX(used_at) DESC, episode_id DESC LIMIT ?1",
    )?;
    let rows = statement.query_map([limit], |row| row.get::<_, String>(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(CoreError::from)
}

fn location_is_novel(channel: &Connection, signature: &str, current: &str) -> Result<bool> {
    let Some(current_coordinates) = parse_coordinates(current) else {
        return Ok(false);
    };
    let mut statement = channel.prepare(
        "SELECT location FROM used_shots
         WHERE shot_signature=?1 AND location<>'' ORDER BY used_at DESC LIMIT 12",
    )?;
    let rows = statement.query_map([signature], |row| row.get::<_, String>(0))?;
    let previous = rows
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter_map(|location| parse_coordinates(&location))
        .collect::<Vec<_>>();
    Ok(!previous.is_empty()
        && previous
            .iter()
            .all(|coordinates| distance_km(current_coordinates, *coordinates) >= LOCATION_NOVELTY_KM))
}

fn parse_coordinates(value: &str) -> Option<(f64, f64)> {
    let coordinates = value.split('|').next()?;
    let (lat, lon) = coordinates.split_once(',')?;
    let lat = lat.parse::<f64>().ok()?;
    let lon = lon.parse::<f64>().ok()?;
    (lat.is_finite() && lon.is_finite()).then_some((lat, lon))
}

fn distance_km(left: (f64, f64), right: (f64, f64)) -> f64 {
    let lat_delta = (right.0 - left.0).to_radians();
    let lon_delta = (right.1 - left.1).to_radians();
    let haversine = (lat_delta / 2.0).sin().powi(2)
        + left.0.to_radians().cos()
            * right.0.to_radians().cos()
            * (lon_delta / 2.0).sin().powi(2);
    6_371.0 * 2.0 * haversine.sqrt().asin()
}

fn contains_any(value: &str, keywords: &[&str]) -> bool {
    let normalized = value.to_lowercase();
    keywords
        .iter()
        .any(|keyword| normalized.contains(&keyword.to_lowercase()))
}

pub fn memory_prompt_summary(project: &Connection) -> Result<Value> {
    let path = channel_path_for_project(project)?;
    let Some(channel) = open_existing_channel_for_project(project, &path)? else {
        return Ok(json!({
            "channel_schema_version": CHANNEL_SCHEMA_VERSION,
            "recent_routines": [],
            "recent_dh_appearances": []
        }));
    };
    let labels = episode_labels(&channel)?;
    let routines = {
        let mut statement = channel.prepare(
            "SELECT routine_kind, episode_id, treatment, occurred_at
             FROM routine_events ORDER BY occurred_at DESC, rowid DESC LIMIT 30",
        )?;
        let rows = statement.query_map([], |row| {
            let episode_id: String = row.get(1)?;
            Ok(json!({
                "routine_kind": row.get::<_, String>(0)?,
                "episode": labels.get(&episode_id).cloned().unwrap_or_else(|| "EP?".to_owned()),
                "treatment": row.get::<_, String>(2)?,
                "occurred_at": row.get::<_, String>(3)?,
            }))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let appearances = {
        let mut statement = channel.prepare(
            "SELECT episode_id, mode, duration_s, style, topic
             FROM dh_appearances ORDER BY appeared_at DESC, rowid DESC LIMIT 12",
        )?;
        let rows = statement.query_map([], |row| {
            let episode_id: String = row.get(0)?;
            Ok(json!({
                "episode": labels.get(&episode_id).cloned().unwrap_or_else(|| "EP?".to_owned()),
                "mode": row.get::<_, String>(1)?,
                "duration_s": row.get::<_, f64>(2)?,
                "style": row.get::<_, String>(3)?,
                "topic": row.get::<_, String>(4)?,
            }))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(json!({
        "channel_schema_version": CHANNEL_SCHEMA_VERSION,
        "recent_episode_window": RECENT_EPISODE_WINDOW,
        "routine_visual_threshold": ROUTINE_VISUAL_THRESHOLD,
        "recent_routines": routines,
        "recent_dh_appearances": appearances,
        "dh_duration_warning_threshold_s": DH_DURATION_WARNING_SECONDS
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};

    fn setup_project() -> (TestDirectory, Connection, PathBuf) {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let channel_path = directory.path().join("channel.db");
        connection.execute("INSERT INTO volumes(uuid) VALUES ('memory')", []).unwrap();
        connection.execute(
            "INSERT INTO clips(
                volume_uuid, rel_path, quick_hash, full_hash, tb_num, tb_den, duration_ticks,
                gps_lat, gps_lon, captured_at, episode_id
             ) VALUES ('memory', 'rv.mov', 'quick', 'full', 1, 1000, 10000,
                       43.65, -79.38, '2026-09-02T10:00:00Z',
                       (SELECT id FROM episodes WHERE status='active'))",
            [],
        ).unwrap();
        for (dimension, label) in [
            ("function", "Transition"),
            ("shot_size", "广角"),
            ("movement", "handheld_follow"),
            ("subject", "交通"),
            ("person_state", "操作"),
            ("time_stage", "出发"),
        ] {
            connection.execute(
                "INSERT INTO clip_dimensions(clip_id, dimension, label, score, source)
                 VALUES (1, ?1, ?2, 0.9, 'test')",
                params![dimension, label],
            ).unwrap();
        }
        (directory, connection, channel_path)
    }

    fn selection() -> ExportedSelection {
        ExportedSelection { clip_id: 1, segment_id: None, in_ticks: 0, out_ticks: 10_000 }
    }

    fn episode_identity(project: &Connection, number: i64) -> String {
        if number == 1 {
            return project
                .query_row(
                    "SELECT memory_id FROM episodes WHERE status='active'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
        }
        let memory_id = format!("{number:032x}");
        project
            .execute(
                "INSERT OR IGNORE INTO episodes(
                    title, theme, created_at, status, archived_at, episode_number, memory_id
                 ) VALUES (?1, '', 'now', 'archived', 'now', ?2, ?3)",
                params![format!("EP{number:02}"), number, memory_id],
            )
            .unwrap();
        memory_id
    }

    fn record_for_episode(
        project: &Connection,
        channel_path: &Path,
        number: i64,
    ) -> String {
        let memory_id = episode_identity(project, number);
        project
            .execute(
                "UPDATE clips SET episode_id=(SELECT id FROM episodes WHERE memory_id=?1)
                 WHERE id=1",
                [&memory_id],
            )
            .unwrap();
        record_successful_export(project, channel_path, &memory_id, &[selection()]).unwrap();
        memory_id
    }

    #[test]
    fn channel_db_has_an_independent_v2_schema() {
        let directory = TestDirectory::new();
        let path = directory.path().join("channel.db");
        initialize(&path).unwrap();
        let connection = Connection::open(path).unwrap();
        assert_eq!(connection.query_row("SELECT version FROM schema_version", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
        let tables: i64 = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table'
             AND name IN ('used_shots', 'routine_events', 'dh_appearances')",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(tables, 3);
    }

    #[test]
    fn production_project_path_resolves_channel_db_outside_dev_project() {
        let directory = TestDirectory::new();
        let app_root = directory.path().join("TripCutStudio");
        let project_path = app_root.join("dev/project.db");
        std::fs::create_dir_all(project_path.parent().unwrap()).unwrap();
        let project = db::open_project(&project_path).unwrap();
        // macOS 的 /var 是 /private/var 的软链,SQLite path() 返回已解析路径——比较前双侧 canonicalize。
        let got = channel_path_for_project(&project).unwrap();
        let expected = app_root.join("channel.db");
        assert_eq!(
            got.parent().unwrap().canonicalize().unwrap().join("channel.db"),
            expected.parent().unwrap().canonicalize().unwrap().join("channel.db"),
        );
    }

    #[test]
    fn newer_channel_schema_is_rejected_without_touching_project_migrations() {
        let directory = TestDirectory::new();
        let path = directory.path().join("channel.db");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(
            "CREATE TABLE schema_version(version INTEGER NOT NULL);
             INSERT INTO schema_version(version) VALUES (3);",
        ).unwrap();
        drop(connection);
        let connection = Connection::open(&path).unwrap();
        configure(&connection).unwrap();
        let error = validate_schema(&connection).unwrap_err();
        assert!(matches!(
            error,
            CoreError::UnsupportedSchema { found: 3, supported: 2 }
        ));
    }

    #[test]
    fn v1_identity_reconciles_only_with_matching_path_owner_and_fingerprint_evidence() {
        let (_directory, project, channel_path) = setup_project();
        let episode_db_id: i64 = project
            .query_row("SELECT id FROM episodes WHERE status='active'", [], |row| row.get(0))
            .unwrap();
        let memory_id = episode_identity(&project, 1);
        let output_path = "/tmp/TripCut/EP01";
        let legacy_id = legacy_episode_id(output_path);
        let fingerprint = load_shot_evidence(&project, 1, None, 0, 10_000)
            .unwrap()
            .fingerprint;
        let manifest = json!({
            "episode_id": episode_db_id,
            "clips": [{
                "clip_id": 1, "segment_id": null, "in_ticks": 0,
                "out_ticks": 10_000, "full_hash": "full", "quick_hash": "quick"
            }],
            "progress": {"items": [{"status": "done"}]}
        })
        .to_string();
        project
            .execute(
                "INSERT INTO exports(tier, manifest, created_at, output_path, episode_id)
                 VALUES ('stable_package', ?1, 'now', ?2, ?3)",
                params![manifest, output_path, episode_db_id],
            )
            .unwrap();
        let channel = Connection::open(&channel_path).unwrap();
        channel.execute_batch(CHANNEL_SCHEMA_V1).unwrap();
        channel
            .execute(
                "INSERT INTO used_shots(
                    episode_id, clip_fingerprint, location, function_label,
                    shot_signature, is_hero, used_at
                 ) VALUES (?1, ?2, '', 'Transition', 'sig', 0, 'now')",
                params![legacy_id, fingerprint],
            )
            .unwrap();
        drop(channel);

        let migrated = open_channel_for_project(&project, &channel_path).unwrap();
        assert_eq!(
            migrated.query_row("SELECT version FROM schema_version", [], |row| row.get::<_, i64>(0)).unwrap(),
            2
        );
        assert_eq!(
            migrated.query_row("SELECT episode_id FROM used_shots", [], |row| row.get::<_, String>(0)).unwrap(),
            memory_id
        );
        assert_eq!(
            migrated.query_row(
                "SELECT memory_id FROM episode_identity_aliases WHERE legacy_episode_id=?1",
                [legacy_id],
                |row| row.get::<_, String>(0),
            ).unwrap(),
            memory_id
        );
    }

    #[test]
    fn v1_identity_with_mismatched_fingerprint_fails_without_upgrading() {
        let (_directory, project, channel_path) = setup_project();
        let episode_db_id: i64 = project
            .query_row("SELECT id FROM episodes WHERE status='active'", [], |row| row.get(0))
            .unwrap();
        let output_path = "/tmp/TripCut/EP01";
        let legacy_id = legacy_episode_id(output_path);
        let manifest = json!({
            "episode_id": episode_db_id,
            "clips": [{
                "clip_id": 1, "segment_id": null, "in_ticks": 0,
                "out_ticks": 10_000, "full_hash": "full", "quick_hash": "quick"
            }],
            "progress": {"items": [{"status": "done"}]}
        })
        .to_string();
        project
            .execute(
                "INSERT INTO exports(tier, manifest, created_at, output_path, episode_id)
                 VALUES ('stable_package', ?1, 'now', ?2, ?3)",
                params![manifest, output_path, episode_db_id],
            )
            .unwrap();
        let channel = Connection::open(&channel_path).unwrap();
        channel.execute_batch(CHANNEL_SCHEMA_V1).unwrap();
        channel
            .execute(
                "INSERT INTO used_shots(
                    episode_id, clip_fingerprint, location, function_label,
                    shot_signature, is_hero, used_at
                 ) VALUES (?1, 'not-the-export-fingerprint', '', 'Transition', 'sig', 0, 'now')",
                [legacy_id],
            )
            .unwrap();
        drop(channel);

        let error = open_channel_for_project(&project, &channel_path).unwrap_err();
        assert!(error.to_string().contains("channel.db 保持 V1"));
        let unchanged = Connection::open(&channel_path).unwrap();
        assert_eq!(
            unchanged.query_row("SELECT version FROM schema_version", [], |row| row.get::<_, i64>(0)).unwrap(),
            1
        );
        let catalog_exists: i64 = unchanged
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='episode_catalog')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(catalog_exists, 0);
    }

    #[test]
    fn export_recording_is_idempotent_per_episode_and_signature() {
        let (_directory, project, channel_path) = setup_project();
        let memory_id = record_for_episode(&project, &channel_path, 1);
        record_successful_export(&project, &channel_path, &memory_id, &[selection()]).unwrap();
        let channel = Connection::open(channel_path).unwrap();
        assert_eq!(channel.query_row("SELECT COUNT(*) FROM used_shots", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn repeated_signature_in_three_recent_episodes_becomes_routine_visual() {
        let (_directory, project, channel_path) = setup_project();
        for episode in 1..=3 {
            record_for_episode(&project, &channel_path, episode);
        }
        let evidence = load_shot_evidence(&project, 1, None, 0, 10_000).unwrap();
        let annotation = clip_annotation_with_path(&project, &channel_path, &evidence).unwrap();
        assert!(annotation.routine_visual);
        assert_eq!(annotation.narrative_adjustment, -0.20);
    }

    #[test]
    fn large_location_change_restores_novelty() {
        let (_directory, project, channel_path) = setup_project();
        for episode in 1..=3 {
            record_for_episode(&project, &channel_path, episode);
        }
        project.execute("UPDATE clips SET gps_lat=64.06, gps_lon=-139.43 WHERE id=1", []).unwrap();
        let evidence = load_shot_evidence(&project, 1, None, 0, 10_000).unwrap();
        let annotation = clip_annotation_with_path(&project, &channel_path, &evidence).unwrap();
        assert!(annotation.routine_visual);
        assert!(annotation.novelty_context);
        assert_eq!(annotation.narrative_adjustment, 0.10);
    }

    #[test]
    fn routine_treatment_flows_from_explained_to_montage() {
        let (_directory, project, channel_path) = setup_project();
        project.execute(
            "INSERT INTO transcript_segments(clip_id, seg_index, start_ticks, end_ticks, text)
             VALUES (1, 0, 0, 1000, '今天开始收营')",
            [],
        ).unwrap();
        let first = load_shot_evidence(&project, 1, None, 0, 10_000).unwrap();
        let annotation = clip_annotation_with_path(&project, &channel_path, &first).unwrap();
        assert_eq!(annotation.routine_suggestion.unwrap().treatment, "explained");
        record_for_episode(&project, &channel_path, 1);
        let annotation = clip_annotation_with_path(&project, &channel_path, &first).unwrap();
        assert_eq!(annotation.routine_suggestion.unwrap().treatment, "montage");
    }

    #[test]
    fn anomaly_signal_upgrades_routine_to_story_event() {
        let (_directory, project, channel_path) = setup_project();
        project.execute(
            "INSERT INTO transcript_segments(clip_id, seg_index, start_ticks, end_ticks, text)
             VALUES (1, 0, 0, 1000, '收营时水管突然冻结了')",
            [],
        ).unwrap();
        let evidence = load_shot_evidence(&project, 1, None, 0, 10_000).unwrap();
        let annotation = clip_annotation_with_path(&project, &channel_path, &evidence).unwrap();
        assert_eq!(annotation.routine_suggestion.unwrap().treatment, "story_event");
    }

    #[test]
    fn exact_clip_usage_returns_episode_badges() {
        let (_directory, project, channel_path) = setup_project();
        record_for_episode(&project, &channel_path, 1);
        record_for_episode(&project, &channel_path, 2);
        let evidence = load_shot_evidence(&project, 1, None, 0, 10_000).unwrap();
        let annotation = clip_annotation_with_path(&project, &channel_path, &evidence).unwrap();
        assert_eq!(annotation.used_episode_badges, vec!["EP01", "EP02"]);
    }

    #[test]
    fn dh_spacing_guard_requires_two_real_slots() {
        let warnings = dh_spacing_warnings(&[
            DhPlannedSlot { chapter_title: "开场".to_owned(), mode: "A".to_owned(), slot: "DH INTRO".to_owned() },
            DhPlannedSlot { chapter_title: "下一章".to_owned(), mode: "A".to_owned(), slot: "DH INTRO".to_owned() },
        ]);
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn dh_duration_guard_warns_above_threshold() {
        let (_directory, project, _channel_path) = setup_project();
        let planned = (0..7).map(|index| DhPlannedSlot {
            chapter_title: format!("章{index}"),
            mode: "A".to_owned(),
            slot: "DH INTRO".to_owned(),
        }).collect::<Vec<_>>();
        let guard = dh_guard(&project, &planned).unwrap();
        assert!(guard.current_estimated_duration_s > DH_DURATION_WARNING_SECONDS);
        assert!(guard.warnings.iter().any(|warning| warning.contains("超过")));
    }

    #[test]
    fn project_deletion_does_not_delete_channel_memory() {
        let (directory, project, channel_path) = setup_project();
        record_for_episode(&project, &channel_path, 1);
        drop(project);
        std::fs::remove_file(directory.db_path()).unwrap();
        let channel = Connection::open(channel_path).unwrap();
        assert_eq!(channel.query_row("SELECT COUNT(*) FROM used_shots", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }
}
