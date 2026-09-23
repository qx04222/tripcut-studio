pub struct Migration {
    pub version: i64,
    pub sql: &'static str,
}

pub const MIGRATION_0001: &str = r#"
CREATE TABLE volumes (
    uuid TEXT PRIMARY KEY,
    label TEXT,
    fs_type TEXT,
    last_seen_at TEXT
);

CREATE TABLE clips (
    id INTEGER PRIMARY KEY,
    volume_uuid TEXT REFERENCES volumes(uuid),
    rel_path TEXT NOT NULL,
    byte_size INTEGER,
    quick_hash TEXT,
    full_hash TEXT,
    tb_num INTEGER,
    tb_den INTEGER,
    duration_ticks INTEGER,
    fps_num INTEGER,
    fps_den INTEGER,
    is_vfr INTEGER NOT NULL DEFAULT 0 CHECK(is_vfr IN (0, 1)),
    codec TEXT,
    width INTEGER,
    height INTEGER,
    captured_at TEXT,
    gps_lat REAL,
    gps_lon REAL,
    imported_at TEXT,
    missing_since TEXT,
    UNIQUE(volume_uuid, rel_path)
);

CREATE TABLE segments (
    id INTEGER PRIMARY KEY,
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    in_ticks INTEGER NOT NULL,
    out_ticks INTEGER NOT NULL,
    kind TEXT,
    scene_index INTEGER,
    CHECK(out_ticks >= in_ticks)
);

CREATE TABLE ratings (
    id INTEGER PRIMARY KEY,
    segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    rating_type TEXT NOT NULL,
    value INTEGER NOT NULL,
    rated_at TEXT NOT NULL
);

CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    source TEXT,
    confidence REAL
);

CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'done', 'failed', 'blocked')),
    attempt INTEGER NOT NULL DEFAULT 0,
    blocked_summary TEXT,
    result_path TEXT,
    next_attempt_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE TABLE exports (
    id INTEGER PRIMARY KEY,
    tier TEXT NOT NULL,
    manifest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    output_path TEXT
);

CREATE TRIGGER ratings_are_append_only
BEFORE UPDATE ON ratings
BEGIN
    SELECT RAISE(ABORT, 'ratings are append-only');
END;

CREATE INDEX clips_volume_uuid_idx ON clips(volume_uuid);
CREATE INDEX segments_clip_id_idx ON segments(clip_id);
CREATE INDEX ratings_segment_id_idx ON ratings(segment_id);
CREATE INDEX tags_segment_id_idx ON tags(segment_id);
CREATE INDEX jobs_claim_idx ON jobs(status, next_attempt_at, created_at);
"#;

pub const MIGRATION_0002: &str = r#"
CREATE TABLE cache_artifacts (
    id INTEGER PRIMARY KEY,
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('cover', 'strip', 'proxy', 'waveform')),
    rel_path TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    bytes INTEGER NOT NULL CHECK(bytes >= 0),
    created_at TEXT NOT NULL,
    UNIQUE(clip_id, kind),
    UNIQUE(rel_path)
);

CREATE INDEX cache_artifacts_source_idx ON cache_artifacts(clip_id, source_hash);
"#;

pub const MIGRATION_0003: &str = r#"
CREATE TABLE clip_analysis (
    clip_id INTEGER PRIMARY KEY REFERENCES clips(id) ON DELETE CASCADE,
    exposure_yavg REAL NOT NULL,
    overexposed_ratio REAL NOT NULL,
    audio_peak_db REAL,
    audio_clipped INTEGER NOT NULL CHECK(audio_clipped IN (0, 1)),
    has_audio INTEGER NOT NULL CHECK(has_audio IN (0, 1)),
    focus_scores TEXT NOT NULL,
    scene_count INTEGER NOT NULL CHECK(scene_count >= 1),
    analyzed_at TEXT NOT NULL,
    tool_versions TEXT NOT NULL,
    CHECK(exposure_yavg >= 0.0 AND exposure_yavg <= 255.0),
    CHECK(overexposed_ratio >= 0.0 AND overexposed_ratio <= 1.0)
);
"#;

// sqlite-vec remains an optional future acceleration path. The bundled SQLite
// build cannot assume a loadable extension on a clean install, so 0004 stores
// normalized f32 vectors as little-endian BLOBs and Rust provides cosine search.
pub const MIGRATION_0004: &str = r#"
CREATE TABLE clip_embeddings (
    clip_id INTEGER PRIMARY KEY REFERENCES clips(id) ON DELETE CASCADE,
    embedding BLOB NOT NULL CHECK(length(embedding) = 2048),
    dimensions INTEGER NOT NULL DEFAULT 512 CHECK(dimensions = 512),
    source_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    embedded_at TEXT NOT NULL
);

CREATE INDEX clip_embeddings_source_idx
ON clip_embeddings(source_hash, model);
"#;

pub const MIGRATION_0005: &str = r#"
ALTER TABLE cache_artifacts RENAME TO cache_artifacts_before_0005;
DROP INDEX cache_artifacts_source_idx;

CREATE TABLE cache_artifacts (
    id INTEGER PRIMARY KEY,
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN (
        'cover', 'strip', 'proxy', 'waveform', 'transcript', 'srt'
    )),
    rel_path TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    bytes INTEGER NOT NULL CHECK(bytes >= 0),
    created_at TEXT NOT NULL,
    UNIQUE(clip_id, kind),
    UNIQUE(rel_path)
);

INSERT INTO cache_artifacts(
    id, clip_id, kind, rel_path, source_hash, bytes, created_at
)
SELECT id, clip_id, kind, rel_path, source_hash, bytes, created_at
FROM cache_artifacts_before_0005;

DROP TABLE cache_artifacts_before_0005;
CREATE INDEX cache_artifacts_source_idx ON cache_artifacts(clip_id, source_hash);

CREATE TABLE transcript_segments (
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    seg_index INTEGER NOT NULL,
    start_ticks INTEGER NOT NULL CHECK(start_ticks >= 0),
    end_ticks INTEGER NOT NULL CHECK(end_ticks >= start_ticks),
    text TEXT NOT NULL,
    PRIMARY KEY(clip_id, seg_index)
);

CREATE INDEX transcript_segments_clip_time_idx
ON transcript_segments(clip_id, start_ticks, seg_index);
"#;

pub const MIGRATION_0006: &str = r#"
CREATE TABLE similar_groups (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL
);

CREATE TABLE similar_group_members (
    group_id INTEGER NOT NULL REFERENCES similar_groups(id) ON DELETE CASCADE,
    clip_id INTEGER NOT NULL UNIQUE REFERENCES clips(id) ON DELETE CASCADE,
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0, 1)),
    PRIMARY KEY(group_id, clip_id)
);

CREATE UNIQUE INDEX similar_group_one_primary_idx
ON similar_group_members(group_id) WHERE is_primary = 1;

CREATE INDEX similar_group_members_group_idx
ON similar_group_members(group_id, clip_id);
"#;

pub const MIGRATION_0007: &str = r#"
CREATE TABLE clip_motion (
    clip_id INTEGER PRIMARY KEY REFERENCES clips(id) ON DELETE CASCADE,
    class TEXT NOT NULL CHECK(class IN ('pan', 'tilt', 'zoom', 'handheld', 'static')),
    pan_ratio REAL NOT NULL CHECK(pan_ratio >= 0.0 AND pan_ratio <= 1.0),
    tilt_ratio REAL NOT NULL CHECK(tilt_ratio >= 0.0 AND tilt_ratio <= 1.0),
    zoom_corr REAL NOT NULL CHECK(zoom_corr >= -1.0 AND zoom_corr <= 1.0),
    shake_score REAL NOT NULL CHECK(shake_score >= 0.0),
    sample_pairs INTEGER NOT NULL CHECK(sample_pairs > 0),
    tool_version TEXT NOT NULL
);
"#;

pub const MIGRATION_0008: &str = r#"
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"#;

pub const MIGRATION_0009: &str = r#"
ALTER TABLE segments
ADD COLUMN tombstone INTEGER NOT NULL DEFAULT 0 CHECK(tombstone IN (0, 1));

CREATE INDEX segments_live_select_idx
ON segments(clip_id, in_ticks, id)
WHERE kind = 'select' AND tombstone = 0;
"#;

pub const MIGRATION_0010: &str = r#"
CREATE TABLE chapters (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    manual INTEGER NOT NULL DEFAULT 0 CHECK(manual IN (0, 1)),
    tombstone INTEGER NOT NULL DEFAULT 0 CHECK(tombstone IN (0, 1))
);

ALTER TABLE clips
ADD COLUMN chapter_id INTEGER REFERENCES chapters(id);

CREATE INDEX clips_chapter_id_idx ON clips(chapter_id);
CREATE INDEX chapters_timeline_idx ON chapters(tombstone, start_at, id);

CREATE TABLE story_order (
    id INTEGER PRIMARY KEY,
    item_kind TEXT NOT NULL CHECK(item_kind IN ('whole', 'segment')),
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    segment_id INTEGER REFERENCES segments(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 0),
    tombstone INTEGER NOT NULL DEFAULT 0 CHECK(tombstone IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(
        (item_kind = 'whole' AND segment_id IS NULL)
        OR (item_kind = 'segment' AND segment_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX story_order_whole_unique_idx
ON story_order(clip_id) WHERE item_kind = 'whole';

CREATE UNIQUE INDEX story_order_segment_unique_idx
ON story_order(segment_id) WHERE item_kind = 'segment';

CREATE UNIQUE INDEX story_order_live_position_idx
ON story_order(position) WHERE tombstone = 0;

CREATE TABLE story_history (
    id INTEGER PRIMARY KEY,
    action TEXT NOT NULL CHECK(action IN ('reorder', 'rename', 'merge')),
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL,
    undone_at TEXT
);

CREATE INDEX story_history_undo_idx
ON story_history(undone_at, id DESC);
"#;

pub const MIGRATION_0011: &str = r#"
CREATE TABLE llm_ledger (
    id INTEGER PRIMARY KEY,
    called_at TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex', 'kimi')),
    purpose TEXT NOT NULL CHECK(purpose IN ('ai_description', 'director_qa')),
    estimated_tokens INTEGER NOT NULL CHECK(estimated_tokens >= 0),
    status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed', 'parse_failed')),
    error_summary TEXT
);

CREATE INDEX llm_ledger_called_at_idx
ON llm_ledger(called_at DESC, id DESC);
"#;

pub const MIGRATION_0012: &str = r#"
CREATE TABLE clip_dimensions (
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    dimension TEXT NOT NULL,
    label TEXT NOT NULL,
    score REAL NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY(clip_id, dimension)
);

CREATE INDEX clip_dimensions_filter_idx
ON clip_dimensions(dimension, label, clip_id);
"#;

// R1 lane A owns 0013. Keep later integration lanes at 0014+; do not fill this
// slot with an unrelated migration when branches are merged.
pub const MIGRATION_0013: &str = r#"
ALTER TABLE jobs ADD COLUMN owner_id TEXT;
ALTER TABLE jobs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE jobs
ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0
CHECK(cancel_requested IN (0, 1));

CREATE INDEX jobs_expired_lease_idx
ON jobs(status, lease_expires_at)
WHERE status = 'running';

UPDATE jobs AS duplicate
SET status = 'failed',
    blocked_summary = '升级到 0013 时合并了重复的活跃导出任务',
    finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE duplicate.kind = 'export_package'
  AND duplicate.status IN ('pending', 'running')
  AND EXISTS (
      SELECT 1 FROM jobs newer
      WHERE newer.kind = duplicate.kind
        AND newer.payload_hash = duplicate.payload_hash
        AND newer.status IN ('pending', 'running')
        AND newer.id > duplicate.id
  );

CREATE UNIQUE INDEX jobs_active_export_payload_unique_idx
ON jobs(kind, payload_hash)
WHERE kind = 'export_package' AND status IN ('pending', 'running');
"#;

pub const MIGRATION_0014: &str = r#"
CREATE TABLE scenes (
    id INTEGER PRIMARY KEY,
    chapter_signal_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL
);

CREATE UNIQUE INDEX scenes_chapter_signal_unique_idx
ON scenes(chapter_signal_id) WHERE chapter_signal_id IS NOT NULL;

CREATE UNIQUE INDEX scenes_unassigned_unique_idx
ON scenes(kind) WHERE kind = 'unassigned';

CREATE TABLE shot_stacks (
    id INTEGER PRIMARY KEY,
    scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    subject_label TEXT NOT NULL,
    function_label TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX shot_stacks_scene_idx
ON shot_stacks(scene_id, function_label, subject_label, id);

CREATE TABLE shot_stack_members (
    stack_id INTEGER NOT NULL REFERENCES shot_stacks(id) ON DELETE CASCADE,
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    segment_id INTEGER REFERENCES segments(id) ON DELETE CASCADE,
    best_take_score REAL,
    score_breakdown_json TEXT NOT NULL,
    user_state TEXT NOT NULL DEFAULT 'auto'
        CHECK(user_state IN ('auto', 'locked', 'rejected', 'hero')),
    CHECK(json_valid(score_breakdown_json)),
    CHECK(best_take_score IS NULL OR (best_take_score >= 0.0 AND best_take_score <= 1.0))
);

CREATE UNIQUE INDEX shot_stack_whole_clip_unique_idx
ON shot_stack_members(clip_id) WHERE segment_id IS NULL;

CREATE UNIQUE INDEX shot_stack_segment_unique_idx
ON shot_stack_members(segment_id) WHERE segment_id IS NOT NULL;

CREATE INDEX shot_stack_members_rank_idx
ON shot_stack_members(stack_id, user_state, best_take_score DESC, clip_id);

CREATE INDEX shot_stack_members_clip_idx
ON shot_stack_members(clip_id, segment_id, stack_id);

CREATE UNIQUE INDEX shot_stack_one_manual_preferred_idx
ON shot_stack_members(stack_id)
WHERE user_state IN ('locked', 'hero');

CREATE TABLE shot_stack_preferences (
    function_label TEXT NOT NULL,
    shot_size_label TEXT NOT NULL,
    movement_label TEXT NOT NULL,
    selection_count INTEGER NOT NULL DEFAULT 0 CHECK(selection_count >= 0),
    hero_count INTEGER NOT NULL DEFAULT 0 CHECK(hero_count >= 0),
    boost REAL NOT NULL DEFAULT 0.0 CHECK(boost >= 0.0 AND boost <= 0.20),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(function_label, shot_size_label, movement_label)
);
"#;

// P3-D3 originally reserved 0013, but the integrated R1 and P3-D4 lanes now
// occupy 0013 and 0014. Narrative v2 therefore advances to the next free slot.
pub const MIGRATION_0015: &str = r#"
ALTER TABLE llm_ledger RENAME TO llm_ledger_before_0015;

CREATE TABLE llm_ledger (
    id INTEGER PRIMARY KEY,
    called_at TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex', 'kimi')),
    purpose TEXT NOT NULL CHECK(purpose IN (
        'ai_description', 'director_qa', 'narrate_episode'
    )),
    estimated_tokens INTEGER NOT NULL CHECK(estimated_tokens >= 0),
    status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed', 'parse_failed')),
    error_summary TEXT
);

INSERT INTO llm_ledger(
    id, called_at, provider, purpose, estimated_tokens, status, error_summary
)
SELECT id, called_at, provider, purpose, estimated_tokens, status, error_summary
FROM llm_ledger_before_0015;

DROP TABLE llm_ledger_before_0015;
CREATE INDEX llm_ledger_called_at_idx
ON llm_ledger(called_at DESC, id DESC);

CREATE TABLE episodes (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    theme TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE narrative_chapters (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN (
        'destination', 'attraction', 'journey', 'experience', 'rv_life',
        'people', 'unexpected', 'information', 'atmosphere', 'transition'
    )),
    title TEXT NOT NULL,
    "order" INTEGER NOT NULL CHECK("order" >= 0),
    promoted INTEGER NOT NULL DEFAULT 0 CHECK(promoted IN (0, 1)),
    score REAL NOT NULL CHECK(score >= 0.0 AND score <= 1.0),
    rationale TEXT NOT NULL,
    promotion_reason TEXT NOT NULL,
    story_slots_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(story_slots_json)),
    missing_slots_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(missing_slots_json)),
    dh_plan_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(dh_plan_json)),
    UNIQUE(episode_id, "order")
);

CREATE INDEX narrative_chapters_episode_idx
ON narrative_chapters(episode_id, "order", id);

CREATE TABLE narrative_beats (
    id INTEGER PRIMARY KEY,
    chapter_id INTEGER NOT NULL REFERENCES narrative_chapters(id) ON DELETE CASCADE,
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    segment_id INTEGER REFERENCES segments(id) ON DELETE SET NULL,
    role TEXT NOT NULL CHECK(role IN ('beat', 'montage', 'transition')),
    "order" INTEGER NOT NULL CHECK("order" >= 0),
    score REAL NOT NULL CHECK(score >= 0.0 AND score <= 1.0),
    rationale TEXT NOT NULL,
    UNIQUE(chapter_id, "order")
);

CREATE INDEX narrative_beats_clip_idx
ON narrative_beats(clip_id, segment_id, chapter_id);

CREATE TABLE destination_cards (
    id INTEGER PRIMARY KEY,
    chapter_id INTEGER NOT NULL REFERENCES narrative_chapters(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    geo_context TEXT NOT NULL,
    highlights TEXT NOT NULL,
    why_visit TEXT NOT NULL,
    personal_note TEXT NOT NULL,
    sources_json TEXT NOT NULL CHECK(json_valid(sources_json)),
    verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0, 1)),
    coverage_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(coverage_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX destination_cards_chapter_idx
ON destination_cards(chapter_id, id);

CREATE TABLE narrative_boundary_signals (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    before_clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    after_clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    score REAL NOT NULL CHECK(score >= 0.0 AND score <= 1.0),
    reasons_json TEXT NOT NULL CHECK(json_valid(reasons_json)),
    UNIQUE(episode_id, before_clip_id, after_clip_id)
);

CREATE INDEX narrative_boundary_signals_episode_idx
ON narrative_boundary_signals(episode_id, id);

CREATE UNIQUE INDEX jobs_one_active_narration_idx
ON jobs(kind)
WHERE kind = 'narrate_episode' AND status IN ('pending', 'running');
"#;

// P3-D5 was planned as 0015, but P3-D3 already occupies that slot in the
// integrated tree. Asset Safety therefore advances to the next free version.
pub const MIGRATION_0016: &str = r#"
ALTER TABLE clips
ADD COLUMN safety_flag TEXT NOT NULL DEFAULT 'normal'
CHECK(safety_flag IN ('normal', 'likely_unusable', 'rescue_candidate'));

CREATE TABLE rescue_ranges (
    clip_id INTEGER PRIMARY KEY REFERENCES clips(id) ON DELETE CASCADE,
    in_ticks INTEGER NOT NULL CHECK(in_ticks >= 0),
    out_ticks INTEGER NOT NULL CHECK(out_ticks > in_ticks),
    reason TEXT NOT NULL
);
"#;

pub const MIGRATION_0017: &str = r#"
CREATE TABLE ai_descriptions (
    clip_id INTEGER PRIMARY KEY REFERENCES clips(id) ON DELETE CASCADE,
    description TEXT NOT NULL CHECK(length(trim(description)) BETWEEN 1 AND 40),
    tags_json TEXT NOT NULL CHECK(json_valid(tags_json)),
    provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex', 'kimi')),
    updated_at TEXT NOT NULL
);
"#;

// P4-E4 originally named 0016 in its task card. The integrated tree already
// uses 0016 and 0017, so Temporal Integrity advances to the next free slot.
pub const MIGRATION_0018: &str = r#"
ALTER TABLE clips ADD COLUMN audio_sample_rate INTEGER
CHECK(audio_sample_rate IS NULL OR audio_sample_rate > 0);
ALTER TABLE clips ADD COLUMN rotation INTEGER;
ALTER TABLE clips ADD COLUMN color_transfer TEXT;
ALTER TABLE clips ADD COLUMN hdr_flag INTEGER NOT NULL DEFAULT 0
CHECK(hdr_flag IN (0, 1));
ALTER TABLE clips ADD COLUMN tz_guess TEXT;
ALTER TABLE clips ADD COLUMN tz_conflict INTEGER NOT NULL DEFAULT 0
CHECK(tz_conflict IN (0, 1));
ALTER TABLE clips ADD COLUMN device_model TEXT;
ALTER TABLE clips ADD COLUMN journey_offset_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clips ADD COLUMN journey_offset_source TEXT NOT NULL DEFAULT 'unset'
CHECK(journey_offset_source IN ('unset', 'reference', 'auto', 'manual'));
ALTER TABLE clips ADD COLUMN journey_offset_confidence REAL
CHECK(
    journey_offset_confidence IS NULL
    OR (journey_offset_confidence >= 0.0 AND journey_offset_confidence <= 1.0)
);

CREATE TABLE proxy_time_map (
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    proxy_ts_ms INTEGER NOT NULL CHECK(proxy_ts_ms >= 0),
    source_ticks INTEGER NOT NULL CHECK(source_ticks >= 0),
    PRIMARY KEY(clip_id, proxy_ts_ms)
);

CREATE INDEX proxy_time_map_source_idx
ON proxy_time_map(clip_id, source_ticks);

-- Existing proxies predate the mapping contract. They are reconstructible
-- cache, so make them unavailable until the normal proxy job regenerates both
-- the file record and its source-tick mapping atomically.
DELETE FROM cache_artifacts WHERE kind = 'proxy';
UPDATE jobs
SET status = 'pending', attempt = 0, blocked_summary = NULL,
    result_path = NULL, next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), finished_at = NULL,
    owner_id = NULL, lease_expires_at = NULL, cancel_requested = 0
WHERE kind = 'proxy';
"#;

pub const MIGRATION_0019: &str = r#"
ALTER TABLE clips ADD COLUMN vfr_timing_checked INTEGER NOT NULL DEFAULT 0
CHECK(vfr_timing_checked IN (0, 1));

CREATE TABLE vfr_time_map (
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    sample_index INTEGER NOT NULL CHECK(sample_index >= 0),
    frame_index INTEGER NOT NULL CHECK(frame_index >= 0),
    source_ticks INTEGER NOT NULL CHECK(source_ticks >= 0),
    PRIMARY KEY(clip_id, sample_index),
    UNIQUE(clip_id, frame_index),
    UNIQUE(clip_id, source_ticks)
);

CREATE INDEX vfr_time_map_source_idx
ON vfr_time_map(clip_id, source_ticks);
"#;


/// P6-G1 Episode Spine:集生命周期+素材归属+封存档案。
/// 旧库兼容:已有 episodes 行(narrative 草稿)最新一行升为 active 生产集,
/// 其余标 archived;无行则建 EP01。全部既有 clips 归入 active 集。
pub const MIGRATION_0020: &str = r#"
ALTER TABLE episodes ADD COLUMN status TEXT NOT NULL DEFAULT 'archived';
ALTER TABLE episodes ADD COLUMN episode_number INTEGER;
ALTER TABLE episodes ADD COLUMN archived_at TEXT;

UPDATE episodes SET episode_number = id;

UPDATE episodes SET status = 'active'
WHERE id = (SELECT MAX(id) FROM episodes);

INSERT INTO episodes(title, theme, created_at, status, episode_number)
SELECT 'EP01', '默认集', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'active', 1
WHERE NOT EXISTS (SELECT 1 FROM episodes);

ALTER TABLE clips ADD COLUMN episode_id INTEGER REFERENCES episodes(id);

UPDATE clips SET episode_id = (SELECT id FROM episodes WHERE status = 'active');

CREATE TABLE episode_archives (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER NOT NULL REFERENCES episodes(id),
    archived_at TEXT NOT NULL,
    summary_json TEXT NOT NULL
);

CREATE UNIQUE INDEX episodes_single_active_idx ON episodes(status) WHERE status = 'active';
CREATE INDEX clips_episode_idx ON clips(episode_id);
"#;


/// P6-G2 可编辑 Narrative Revision:建议版(AI)/确认版(人工)分离。
/// - AI narrate 产物落 suggested revision;用户首次编辑时深拷贝为 confirmed;
/// - 编辑操作写 narrative_overrides(含逆操作,支持撤销链);
/// - 交付/展示读取 confirmed 优先;重跑 AI 只新增 suggested,confirmed 不被覆盖。
///
/// 旧数据兼容:为每个已挂章节的 episode 建一个 suggested revision 并回填 revision_id。
pub const MIGRATION_0021: &str = r#"
CREATE TABLE narrative_revisions (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('suggested', 'confirmed')),
    based_on_revision_id INTEGER REFERENCES narrative_revisions(id),
    title TEXT NOT NULL DEFAULT '',
    theme TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE INDEX narrative_revisions_episode_idx
ON narrative_revisions(episode_id, kind, id);

INSERT INTO narrative_revisions(episode_id, kind, title, theme, created_at)
SELECT DISTINCT c.episode_id, 'suggested', e.title, e.theme, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM narrative_chapters c JOIN episodes e ON e.id = c.episode_id;

-- 顺序唯一约束从 (episode_id,"order") 迁到 (revision_id,"order"):
-- 同一集可同时挂多个修订(建议版/确认版),SQLite 不能改约束,整表重建。
CREATE TABLE narrative_chapters_v21 (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    revision_id INTEGER REFERENCES narrative_revisions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN (
        'destination', 'attraction', 'journey', 'experience', 'rv_life',
        'people', 'unexpected', 'information', 'atmosphere', 'transition'
    )),
    title TEXT NOT NULL,
    "order" INTEGER NOT NULL CHECK("order" >= 0),
    promoted INTEGER NOT NULL DEFAULT 0 CHECK(promoted IN (0, 1)),
    score REAL NOT NULL CHECK(score >= 0.0 AND score <= 1.0),
    rationale TEXT NOT NULL,
    promotion_reason TEXT NOT NULL,
    story_slots_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(story_slots_json)),
    missing_slots_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(missing_slots_json)),
    dh_plan_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(dh_plan_json)),
    UNIQUE(revision_id, "order")
);

INSERT INTO narrative_chapters_v21(
    id, episode_id, revision_id, kind, title, "order", promoted, score, rationale,
    promotion_reason, story_slots_json, missing_slots_json, dh_plan_json)
SELECT c.id, c.episode_id,
       (SELECT r.id FROM narrative_revisions r
         WHERE r.episode_id = c.episode_id AND r.kind = 'suggested'),
       c.kind, c.title, c."order", c.promoted, c.score, c.rationale,
       c.promotion_reason, c.story_slots_json, c.missing_slots_json, c.dh_plan_json
FROM narrative_chapters c;

DROP TABLE narrative_chapters;
ALTER TABLE narrative_chapters_v21 RENAME TO narrative_chapters;

CREATE INDEX narrative_chapters_episode_idx
ON narrative_chapters(episode_id, "order", id);
CREATE INDEX narrative_chapters_revision_idx
ON narrative_chapters(revision_id, "order");

CREATE TABLE narrative_overrides (
    id INTEGER PRIMARY KEY,
    revision_id INTEGER NOT NULL REFERENCES narrative_revisions(id) ON DELETE CASCADE,
    op_json TEXT NOT NULL CHECK(json_valid(op_json)),
    inverse_json TEXT NOT NULL CHECK(json_valid(inverse_json)),
    applied_at TEXT NOT NULL,
    undone_at TEXT
);

CREATE INDEX narrative_overrides_revision_idx
ON narrative_overrides(revision_id, undone_at, id);
"#;


/// P6-G4 Routine Review & Override:人工对 Routine 判定的最终裁量。
/// cleared=1 表示「这不是 Routine」;treatment 覆盖建议处理;按(集,素材)一行,幂等更新。
pub const MIGRATION_0022: &str = r#"
CREATE TABLE routine_overrides (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    routine_kind TEXT,
    treatment TEXT CHECK(treatment IN ('beat', 'montage', 'transition', 'full') OR treatment IS NULL),
    cleared INTEGER NOT NULL DEFAULT 0 CHECK(cleared IN (0, 1)),
    updated_at TEXT NOT NULL,
    UNIQUE(episode_id, clip_id)
);
"#;


/// P6 待办3 Destination Evidence:地点卡逐字段核实状态。
/// 整卡 verified 继续存在(聚合展示),字段级三态记录在 field_states_json。
pub const MIGRATION_0023: &str = r#"
ALTER TABLE destination_cards ADD COLUMN field_states_json TEXT NOT NULL DEFAULT '{}'
    CHECK(json_valid(field_states_json));
"#;


/// 素材文件夹工作流:关注文件夹(NAS/云盘增量同步)+子文件夹分类标签。
pub const MIGRATION_0024: &str = r#"
CREATE TABLE watched_folders (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    auto_sync INTEGER NOT NULL DEFAULT 1 CHECK(auto_sync IN (0, 1)),
    added_at TEXT NOT NULL,
    last_scan_at TEXT
);

ALTER TABLE clips ADD COLUMN folder_label TEXT;
CREATE INDEX clips_folder_label_idx ON clips(folder_label);
"#;

/// 滤镜链升级新增的粗筛信号:欠曝占比、动态范围、模糊度/纹理熵/运动能量均值、虚焦占比。
/// 一律追加到列末尾,不得插入既有列之间,避免 row.get(N) 硬编码序号错位。
pub const MIGRATION_0025: &str = r#"
ALTER TABLE clip_analysis ADD COLUMN underexposed_ratio REAL NOT NULL DEFAULT 0;
ALTER TABLE clip_analysis ADD COLUMN dynamic_range REAL NOT NULL DEFAULT 0;
ALTER TABLE clip_analysis ADD COLUMN blur_mean REAL NOT NULL DEFAULT 0;
ALTER TABLE clip_analysis ADD COLUMN entropy_mean REAL NOT NULL DEFAULT 0;
ALTER TABLE clip_analysis ADD COLUMN motion_mean REAL NOT NULL DEFAULT 0;
ALTER TABLE clip_analysis ADD COLUMN out_of_focus_ratio REAL NOT NULL DEFAULT 0;
"#;


/// Routine 处理枚举统一:CHECK 放宽到包含 AI 会产出的 explained/story_event。
/// 原约束只认人工四档,导致「全部接受 AI 建议」在数据库层被拒（回归修复）。
/// SQLite 不能改 CHECK,整表重建。
pub const MIGRATION_0026: &str = r#"
CREATE TABLE routine_overrides_v26 (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    routine_kind TEXT,
    treatment TEXT CHECK(
        treatment IN ('explained', 'story_event', 'montage', 'transition', 'beat', 'full')
        OR treatment IS NULL
    ),
    cleared INTEGER NOT NULL DEFAULT 0 CHECK(cleared IN (0, 1)),
    updated_at TEXT NOT NULL,
    UNIQUE(episode_id, clip_id)
);

INSERT INTO routine_overrides_v26(id, episode_id, clip_id, routine_kind, treatment, cleared, updated_at)
SELECT id, episode_id, clip_id, routine_kind, treatment, cleared, updated_at FROM routine_overrides;

DROP TABLE routine_overrides;
ALTER TABLE routine_overrides_v26 RENAME TO routine_overrides;
"#;

/// Episode ownership closure: D2 chapters/order/history, exports and channel-memory identity.
/// Earlier schemas added `clips.episode_id` but left these related records global, which allowed
/// archived Episode state to leak into the active Episode.
pub const MIGRATION_0027: &str = r#"
ALTER TABLE episodes ADD COLUMN memory_id TEXT;
UPDATE episodes SET memory_id = lower(hex(randomblob(16))) WHERE memory_id IS NULL;
CREATE UNIQUE INDEX episodes_memory_id_unique_idx ON episodes(memory_id);

ALTER TABLE chapters ADD COLUMN episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE;
UPDATE chapters
SET episode_id = COALESCE(
    (SELECT c.episode_id
       FROM clips c
      WHERE c.chapter_id = chapters.id AND c.episode_id IS NOT NULL
      GROUP BY c.episode_id
      ORDER BY COUNT(*) DESC, c.episode_id
      LIMIT 1),
    (SELECT id FROM episodes WHERE status = 'active')
)
WHERE episode_id IS NULL;
UPDATE clips
SET chapter_id = NULL
WHERE chapter_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM chapters chapter
      WHERE chapter.id = clips.chapter_id
        AND chapter.episode_id = clips.episode_id
  );
CREATE INDEX chapters_episode_timeline_idx
ON chapters(episode_id, tombstone, start_at, id);

ALTER TABLE story_order ADD COLUMN episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE;
UPDATE story_order
SET episode_id = COALESCE(
    (SELECT c.episode_id FROM clips c WHERE c.id = story_order.clip_id),
    (SELECT id FROM episodes WHERE status = 'active')
)
WHERE episode_id IS NULL;
DROP INDEX story_order_live_position_idx;
CREATE UNIQUE INDEX story_order_episode_live_position_idx
ON story_order(episode_id, position) WHERE tombstone = 0;
CREATE INDEX story_order_episode_idx ON story_order(episode_id, tombstone, id);

ALTER TABLE story_history ADD COLUMN episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE;
-- V26 snapshots were global and cannot be attributed safely after multiple Episodes existed.
-- Preserve them as audit evidence but retire them from the active undo stack.
UPDATE story_history
SET undone_at = COALESCE(undone_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE episode_id IS NULL;
DROP INDEX story_history_undo_idx;
CREATE INDEX story_history_episode_undo_idx
ON story_history(episode_id, undone_at, id DESC);

ALTER TABLE exports ADD COLUMN episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL;
UPDATE exports
SET episode_id = (
    SELECT c.episode_id
      FROM json_each(exports.manifest, '$.clips') item
      JOIN clips c ON c.id = json_extract(item.value, '$.clip_id')
     WHERE c.episode_id IS NOT NULL
       AND 1 = (
           SELECT COUNT(DISTINCT c2.episode_id)
             FROM json_each(exports.manifest, '$.clips') item2
             JOIN clips c2 ON c2.id = json_extract(item2.value, '$.clip_id')
            WHERE c2.episode_id IS NOT NULL
       )
     GROUP BY c.episode_id
     ORDER BY COUNT(*) DESC
     LIMIT 1
)
WHERE episode_id IS NULL AND json_valid(manifest);
CREATE INDEX exports_episode_idx ON exports(episode_id, created_at, id);

CREATE TABLE channel_memory_outbox (
    export_id INTEGER PRIMARY KEY REFERENCES exports(id) ON DELETE CASCADE,
    episode_memory_id TEXT NOT NULL,
    selections_json TEXT NOT NULL CHECK(json_valid(selections_json)),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'done')),
    last_error TEXT,
    created_at TEXT NOT NULL,
    synced_at TEXT
);
CREATE INDEX channel_memory_outbox_pending_idx
ON channel_memory_outbox(status, export_id);

-- Active jobs written by older binaries do not carry immutable Episode ownership. Continuing
-- them after this migration could attach delayed imports/exports/chapters to the wrong Episode.
UPDATE jobs
SET status = 'blocked',
    blocked_summary = '升级到 V27 后需重新创建任务：旧任务未固定 Episode 归属',
    owner_id = NULL,
    lease_expires_at = NULL,
    finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE kind IN ('import_probe', 'chapterize', 'export_package')
  AND status IN ('pending', 'running');
"#;

/// Episode ownership for the derived Shot Stack cache. V27 intentionally remains immutable:
/// a separately versioned migration avoids two incompatible database shapes both claiming V27.
pub const MIGRATION_0028: &str = r#"
ALTER TABLE shot_stack_members RENAME TO shot_stack_members_before_0028;
ALTER TABLE shot_stacks RENAME TO shot_stacks_before_0028;
ALTER TABLE scenes RENAME TO scenes_before_0028;

DROP INDEX shot_stack_whole_clip_unique_idx;
DROP INDEX shot_stack_segment_unique_idx;
DROP INDEX shot_stack_members_rank_idx;
DROP INDEX shot_stack_members_clip_idx;
DROP INDEX shot_stack_one_manual_preferred_idx;
DROP INDEX shot_stacks_scene_idx;
DROP INDEX scenes_chapter_signal_unique_idx;
DROP INDEX scenes_unassigned_unique_idx;

CREATE TABLE scenes (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    chapter_signal_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL
);
CREATE INDEX scenes_episode_idx ON scenes(episode_id, id);
CREATE UNIQUE INDEX scenes_episode_chapter_unique_idx
ON scenes(episode_id, chapter_signal_id) WHERE chapter_signal_id IS NOT NULL;
CREATE UNIQUE INDEX scenes_episode_unassigned_unique_idx
ON scenes(episode_id, kind) WHERE kind = 'unassigned';

CREATE TABLE shot_stacks (
    id INTEGER PRIMARY KEY,
    scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    subject_label TEXT NOT NULL,
    function_label TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX shot_stacks_scene_idx
ON shot_stacks(scene_id, function_label, subject_label, id);

CREATE TABLE shot_stack_members (
    stack_id INTEGER NOT NULL REFERENCES shot_stacks(id) ON DELETE CASCADE,
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    segment_id INTEGER REFERENCES segments(id) ON DELETE CASCADE,
    best_take_score REAL,
    score_breakdown_json TEXT NOT NULL,
    user_state TEXT NOT NULL DEFAULT 'auto'
        CHECK(user_state IN ('auto', 'locked', 'rejected', 'hero')),
    CHECK(json_valid(score_breakdown_json)),
    CHECK(best_take_score IS NULL OR (best_take_score >= 0.0 AND best_take_score <= 1.0))
);
CREATE UNIQUE INDEX shot_stack_whole_clip_unique_idx
ON shot_stack_members(clip_id) WHERE segment_id IS NULL;
CREATE UNIQUE INDEX shot_stack_segment_unique_idx
ON shot_stack_members(segment_id) WHERE segment_id IS NOT NULL;
CREATE INDEX shot_stack_members_rank_idx
ON shot_stack_members(stack_id, user_state, best_take_score DESC, clip_id);
CREATE INDEX shot_stack_members_clip_idx
ON shot_stack_members(clip_id, segment_id, stack_id);
CREATE UNIQUE INDEX shot_stack_one_manual_preferred_idx
ON shot_stack_members(stack_id) WHERE user_state IN ('locked', 'hero');

CREATE TRIGGER scenes_episode_chapter_insert_guard
BEFORE INSERT ON scenes
WHEN NEW.chapter_signal_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM chapters chapter
     WHERE chapter.id = NEW.chapter_signal_id AND chapter.episode_id = NEW.episode_id
)
BEGIN SELECT RAISE(ABORT, 'scene chapter belongs to another episode'); END;
CREATE TRIGGER scenes_episode_chapter_update_guard
BEFORE UPDATE OF episode_id, chapter_signal_id ON scenes
WHEN NEW.chapter_signal_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM chapters chapter
     WHERE chapter.id = NEW.chapter_signal_id AND chapter.episode_id = NEW.episode_id
)
BEGIN SELECT RAISE(ABORT, 'scene chapter belongs to another episode'); END;
CREATE TRIGGER shot_stack_member_episode_insert_guard
BEFORE INSERT ON shot_stack_members
WHEN NOT EXISTS (
    SELECT 1 FROM shot_stacks stack
    JOIN scenes scene ON scene.id = stack.scene_id
    JOIN clips clip ON clip.id = NEW.clip_id
    WHERE stack.id = NEW.stack_id AND clip.episode_id = scene.episode_id
)
BEGIN SELECT RAISE(ABORT, 'shot stack member belongs to another episode'); END;
CREATE TRIGGER shot_stack_member_segment_insert_guard
BEFORE INSERT ON shot_stack_members
WHEN NEW.segment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM segments segment
     WHERE segment.id = NEW.segment_id AND segment.clip_id = NEW.clip_id
)
BEGIN SELECT RAISE(ABORT, 'shot stack segment belongs to another clip'); END;
CREATE TRIGGER shot_stack_member_episode_update_guard
BEFORE UPDATE OF stack_id, clip_id, segment_id ON shot_stack_members
WHEN NOT EXISTS (
    SELECT 1 FROM shot_stacks stack
    JOIN scenes scene ON scene.id = stack.scene_id
    JOIN clips clip ON clip.id = NEW.clip_id
    WHERE stack.id = NEW.stack_id AND clip.episode_id = scene.episode_id
) OR (NEW.segment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM segments segment
     WHERE segment.id = NEW.segment_id AND segment.clip_id = NEW.clip_id
))
BEGIN SELECT RAISE(ABORT, 'invalid shot stack ownership'); END;
CREATE TRIGGER clip_episode_with_stack_guard
BEFORE UPDATE OF episode_id ON clips
WHEN OLD.episode_id IS NOT NEW.episode_id AND EXISTS (
    SELECT 1 FROM shot_stack_members member WHERE member.clip_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'cannot move clip with shot stack state'); END;

CREATE TEMP TABLE v28_scene_map (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER NOT NULL,
    chapter_id INTEGER,
    name TEXT NOT NULL,
    kind TEXT NOT NULL
);
INSERT INTO v28_scene_map(id, episode_id, chapter_id, name, kind)
SELECT ROW_NUMBER() OVER (
           ORDER BY clip.episode_id, clip.chapter_id IS NULL, clip.chapter_id
       ),
       clip.episode_id,
       clip.chapter_id,
       MIN(old_scene.name),
       CASE WHEN clip.chapter_id IS NULL THEN 'unassigned' ELSE 'signal' END
  FROM shot_stack_members_before_0028 member
  JOIN clips clip ON clip.id = member.clip_id
  JOIN shot_stacks_before_0028 old_stack ON old_stack.id = member.stack_id
  JOIN scenes_before_0028 old_scene ON old_scene.id = old_stack.scene_id
 GROUP BY clip.episode_id, clip.chapter_id;
INSERT INTO scenes(id, episode_id, chapter_signal_id, name, kind)
SELECT id, episode_id, chapter_id, name, kind FROM v28_scene_map;

CREATE TEMP TABLE v28_stack_map (
    id INTEGER PRIMARY KEY,
    old_stack_id INTEGER NOT NULL,
    episode_id INTEGER NOT NULL,
    chapter_id INTEGER
);
INSERT INTO v28_stack_map(id, old_stack_id, episode_id, chapter_id)
SELECT ROW_NUMBER() OVER (
           ORDER BY member.stack_id, clip.episode_id, clip.chapter_id IS NULL, clip.chapter_id
       ),
       member.stack_id,
       clip.episode_id,
       clip.chapter_id
  FROM shot_stack_members_before_0028 member
  JOIN clips clip ON clip.id = member.clip_id
 GROUP BY member.stack_id, clip.episode_id, clip.chapter_id;
INSERT INTO shot_stacks(id, scene_id, subject_label, function_label, created_at)
SELECT map.id, scene.id, old_stack.subject_label, old_stack.function_label, old_stack.created_at
  FROM v28_stack_map map
  JOIN v28_scene_map scene
    ON scene.episode_id = map.episode_id AND scene.chapter_id IS map.chapter_id
  JOIN shot_stacks_before_0028 old_stack ON old_stack.id = map.old_stack_id;
INSERT INTO shot_stack_members(
    stack_id, clip_id, segment_id, best_take_score, score_breakdown_json, user_state
)
SELECT map.id, member.clip_id, member.segment_id, member.best_take_score,
       member.score_breakdown_json, member.user_state
  FROM shot_stack_members_before_0028 member
  JOIN clips clip ON clip.id = member.clip_id
  JOIN v28_stack_map map
    ON map.old_stack_id = member.stack_id
   AND map.episode_id = clip.episode_id
   AND map.chapter_id IS clip.chapter_id;

CREATE TEMP TABLE v28_count_guard(value INTEGER CHECK(value = 1));
INSERT INTO v28_count_guard(value)
SELECT (SELECT COUNT(*) FROM shot_stack_members) =
       (SELECT COUNT(*) FROM shot_stack_members_before_0028);

DROP TABLE shot_stack_members_before_0028;
DROP TABLE shot_stacks_before_0028;
DROP TABLE scenes_before_0028;
DROP TABLE v28_count_guard;
DROP TABLE v28_stack_map;
DROP TABLE v28_scene_map;
"#;

pub const MIGRATION_0029: &str = r#"
CREATE TABLE import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL REFERENCES episodes(id),
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scanning' CHECK(status IN ('scanning','queued','failed','cancelled','removed')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE jobs ADD COLUMN import_batch_id INTEGER REFERENCES import_batches(id);
ALTER TABLE jobs ADD COLUMN import_dismissed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clips ADD COLUMN import_batch_id INTEGER REFERENCES import_batches(id);
CREATE TABLE import_batch_clips (
    batch_id INTEGER NOT NULL REFERENCES import_batches(id),
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    PRIMARY KEY(batch_id,clip_id)
);
CREATE INDEX jobs_import_batch_idx ON jobs(import_batch_id);
CREATE INDEX clips_import_batch_idx ON clips(import_batch_id);
"#;

pub const MIGRATION_0030: &str = r#"
ALTER TABLE segments
ADD COLUMN deleted_at TEXT;
"#;

pub const MIGRATION_0031: &str = r#"
ALTER TABLE episodes ADD COLUMN target_platform TEXT NOT NULL DEFAULT 'general'
  CHECK(target_platform IN ('douyin','xiaohongshu','bilibili','moments','family','general'));
ALTER TABLE episodes ADD COLUMN canvas_orientation TEXT NOT NULL DEFAULT 'both'
  CHECK(canvas_orientation IN ('landscape','portrait','both'));
CREATE TABLE platform_presets (
  platform TEXT PRIMARY KEY, display_name TEXT NOT NULL,
  portrait_w INTEGER, portrait_h INTEGER, landscape_w INTEGER, landscape_h INTEGER,
  duration_budget_ticks INTEGER, tb_num INTEGER NOT NULL, tb_den INTEGER NOT NULL,
  subtitle_style_json TEXT NOT NULL);
INSERT OR IGNORE INTO platform_presets VALUES
 ('douyin','抖音',1080,1920,1920,1080,60000000,1,1000000,'{"font_px":64,"safe_bottom_pct":18}'),
 ('xiaohongshu','小红书',1080,1440,1920,1080,90000000,1,1000000,'{"font_px":56,"safe_bottom_pct":14}'),
 ('bilibili','B站',1080,1920,1920,1080,600000000,1,1000000,'{"font_px":48,"safe_bottom_pct":10}'),
 ('moments','朋友圈',1080,1920,1920,1080,15000000,1,1000000,'{"font_px":64,"safe_bottom_pct":20}'),
 ('family','家庭纪录',1080,1920,3840,2160,0,1,1000000,'{"font_px":48,"safe_bottom_pct":10}'),
 ('general','通用',1080,1920,1920,1080,0,1,1000000,'{"font_px":52,"safe_bottom_pct":12}');
"#;

// R3 Task 4：每素材多声道音轨表 + 选中转录/监听轨 + 显示 LUT 路径 + 拍摄参数列。
pub const MIGRATION_0032: &str = r#"
CREATE TABLE clip_audio_tracks (
  clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  stream_index INTEGER NOT NULL, channels INTEGER, channel_layout TEXT, sample_rate INTEGER,
  role_guess TEXT CHECK(role_guess IN ('onboard_mic','wireless_mic','backup','unknown')),
  PRIMARY KEY(clip_id, stream_index));
ALTER TABLE clips ADD COLUMN selected_transcribe_track INTEGER;
ALTER TABLE clips ADD COLUMN selected_monitor_track INTEGER;
ALTER TABLE clips ADD COLUMN display_lut_path TEXT;
ALTER TABLE clips ADD COLUMN iso_value INTEGER;
ALTER TABLE clips ADD COLUMN shutter_speed TEXT;
ALTER TABLE clips ADD COLUMN aperture TEXT;
"#;

// R4 Task 4：故事模板——revision 记录它是按哪套模板生成的。
pub const MIGRATION_0033: &str = r#"
ALTER TABLE narrative_revisions ADD COLUMN template TEXT
  CHECK(template IN ('cinematic','fastcut','ambient','diary') OR template IS NULL);
"#;

// R5 Task 1：音乐数据层——每集的配乐轨、节拍网格与段落划分。
// tb 固定 1/1000000（微秒），与工程内其它 ticks 同源。
pub const MIGRATION_0034: &str = r#"
CREATE TABLE music_tracks (
  id INTEGER PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  quick_hash TEXT,
  duration_ticks INTEGER,
  tb_num INTEGER NOT NULL DEFAULT 1,
  tb_den INTEGER NOT NULL DEFAULT 1000000,
  bpm REAL,
  analysis_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(analysis_status IN ('pending','running','done','failed')),
  created_at TEXT NOT NULL
);
CREATE TABLE music_beats (
  track_id INTEGER NOT NULL REFERENCES music_tracks(id) ON DELETE CASCADE,
  tick INTEGER NOT NULL,
  is_downbeat INTEGER NOT NULL DEFAULT 0 CHECK(is_downbeat IN (0,1)),
  strength REAL
);
CREATE TABLE music_sections (
  track_id INTEGER NOT NULL REFERENCES music_tracks(id) ON DELETE CASCADE,
  start_tick INTEGER NOT NULL,
  end_tick INTEGER NOT NULL,
  label TEXT NOT NULL
    CHECK(label IN ('intro','verse','build','climax','outro','other')),
  energy REAL,
  CHECK(end_tick >= start_tick)
);
CREATE INDEX music_beats_track_idx ON music_beats(track_id, tick);
CREATE INDEX music_sections_track_idx ON music_sections(track_id, start_tick);
"#;

// R5 Task 4：Vision OCR 识别的画面文字，按帧落库以支持后续按文字检索片段。
// version 34 是音乐数据层(R5 Task 1),OCR 顺延为 35/36。
pub const MIGRATION_0035: &str = r#"
CREATE TABLE clip_ocr_texts (
    id INTEGER PRIMARY KEY,
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    frame_tick INTEGER NOT NULL CHECK(frame_tick >= 0),
    tb_num INTEGER NOT NULL,
    tb_den INTEGER NOT NULL,
    text TEXT NOT NULL,
    confidence REAL NOT NULL,
    bbox_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX clip_ocr_texts_clip_frame_idx
ON clip_ocr_texts(clip_id, frame_tick);
"#;

// R5 Task 5：ocr_scan 任务的幂等入队——与 export_package 同一模式,同一
// (kind, payload_hash) 在 pending/running 期间只允许一条,避免胶片条完成后
// `enqueue_after_thumbnail` 被并发/重跑重复排队。
pub const MIGRATION_0036: &str = r#"
CREATE UNIQUE INDEX jobs_active_ocr_scan_payload_unique_idx
ON jobs(kind, payload_hash)
WHERE kind = 'ocr_scan' AND status IN ('pending', 'running');
"#;

// R6 Task 6/G4：`rotation` 落地。ffmpeg 的隐式 autorotate 和 mpv 默认行为都只认
// side_data 里的 display matrix，不认旧式 metadata `rotate` tag——见
// `import::parse_probe_json` 里 side_data 优先、tag 兜底的合并逻辑。`rotation`
// 列继续存合并后的值（给「竖屏」过滤用，只关心最终朝向，不关心来源）；
// `manual_rotation` 只在 tag 兜底命中、且没有 side_data 时才非空——只有这个值
// 才需要播放器 video-rotate / 封面 transpose 主动纠正，否则会跟已经生效的
// autorotate 叠加，把画面转成两倍角度。
pub const MIGRATION_0037: &str = r#"
ALTER TABLE clips ADD COLUMN manual_rotation INTEGER;
"#;

// R6 Task 7a/1：区分“没做过旋转矫正”和“探测过、确实不需要矫正”。`manual_
// rotation = NULL` 本身有歧义——既可能是从没探测过，也可能是探测到 side_data
// 但没有 tag-only 矫正需求。`rotation_source` 记录 `rotation` 这个合并值到底
// 来自 side_data 还是 legacy `rotate` tag；`rotation` 非空但 `rotation_source`
// 仍为空，就是 R6 之前导入、从未跑过这条新逻辑的历史素材，回填必须能选中它们。
// R6 Task 7a fix：`clip_audio_tracks` 用 NOT EXISTS 判断"是否已探测过音轨"，
// 但一个正确探测过、媒体本身没有任何音轨的素材同样零行——每次启动都会被
// 误判为待回填，重新排队重探。`audio_probed` 把"探测过"这件事直接落成一
// 个标志位，跟音轨行数是否为零无关；写入音轨的三个路径（导入、回填重探、
// 手动重新探测音轨）在同一事务里把它置 1。
pub const MIGRATION_0038: &str = r#"
ALTER TABLE clips ADD COLUMN rotation_source TEXT
    CHECK(rotation_source IN ('side_data', 'tag') OR rotation_source IS NULL);

ALTER TABLE clips ADD COLUMN audio_probed INTEGER NOT NULL DEFAULT 0
    CHECK(audio_probed IN (0, 1));
"#;

// R6 wake follow-up: import_batch_clips only had PK (batch_id, clip_id), so
// `SELECT batch_id FROM import_batch_clips WHERE clip_id=?` (import.rs) had no
// usable index and forced a full table scan.
pub const MIGRATION_0039: &str = r#"
CREATE INDEX import_batch_clips_clip_idx ON import_batch_clips(clip_id);
"#;

// R6 Task 7d/F-R1-8：`thumbnail` 拆成封面(cover)与胶片条(strip)两个任务,
// 封面先行以够到 30 秒首屏目标。`strip` 由 `thumbnail` 完成后入队,与
// `ocr_scan`(mig0036)同一个幂等模式——同一 (kind, payload_hash) 在
// pending/running 期间只允许一条,避免封面完成后 `enqueue_strip` 被并发/
// 重跑重复排队。
pub const MIGRATION_0040: &str = r#"
CREATE UNIQUE INDEX jobs_active_strip_payload_unique_idx
ON jobs(kind, payload_hash)
WHERE kind = 'strip' AND status IN ('pending', 'running');
"#;

// R7 Task 1: story-gap detection + MiniMax cloud in-fill + generation
// reflow. `story_gaps` records detected narrative gaps one-per-(chapter,slot);
// `generation_requests` is the draft/submit/poll/import lifecycle of a single
// cloud generation call; `generation_ledger` is the append-only cost log the
// monthly-budget circuit breaker reads. `clips.generated_source` is the
// clip-level authority for "this clip came from MiniMax, not real footage"
// (see docs/superpowers/specs/2026-09-10-r7-story-gaps-minimax-design.md
// §3.1 for why this isn't a segment-level tag). The `generation_poll` job
// kind reuses the same active-payload dedupe pattern as `ocr_scan` (0036)
// and `strip` (0040): only one pending/running poll per (kind, payload_hash).
pub const MIGRATION_0041: &str = r#"
CREATE TABLE story_gaps (
    id INTEGER PRIMARY KEY,
    episode_id  INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    revision_id INTEGER NOT NULL REFERENCES narrative_revisions(id) ON DELETE CASCADE,
    chapter_id  INTEGER NOT NULL REFERENCES narrative_chapters(id) ON DELETE CASCADE,
    beat_id     INTEGER REFERENCES narrative_beats(id) ON DELETE SET NULL,
    slot        TEXT NOT NULL,
    reason      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open'
                CHECK(status IN ('open','requested','filled','dismissed')),
    detected_at TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX story_gaps_unique_idx ON story_gaps(chapter_id, slot);

CREATE TABLE generation_requests (
    id INTEGER PRIMARY KEY,
    gap_id   INTEGER NOT NULL REFERENCES story_gaps(id) ON DELETE CASCADE,
    retry_of INTEGER REFERENCES generation_requests(id),
    provider TEXT NOT NULL DEFAULT 'minimax' CHECK(provider IN ('minimax')),
    model    TEXT NOT NULL,
    mode     TEXT NOT NULL CHECK(mode IN ('t2v','i2v','fl2v','r2v')),
    prompt   TEXT NOT NULL,
    refs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(refs_json)),
    duration_s INTEGER NOT NULL CHECK(duration_s BETWEEN 4 AND 15),
    resolution TEXT NOT NULL CHECK(resolution IN ('480P','768P','2K')),
    ratio TEXT,
    estimated_cost_usd REAL NOT NULL CHECK(estimated_cost_usd >= 0),
    task_id TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
           CHECK(status IN ('draft','submitted','queued','succeeded','failed','cancelled','imported')),
    error TEXT,
    result_url TEXT,
    result_clip_id INTEGER REFERENCES clips(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX generation_requests_gap_idx ON generation_requests(gap_id, id);
CREATE UNIQUE INDEX generation_requests_task_idx ON generation_requests(task_id) WHERE task_id IS NOT NULL;

CREATE TABLE generation_ledger (
    id INTEGER PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES generation_requests(id) ON DELETE CASCADE,
    cost_usd REAL NOT NULL CHECK(cost_usd >= 0),
    seconds  INTEGER NOT NULL,
    images   INTEGER NOT NULL DEFAULT 0,
    at TEXT NOT NULL
);
CREATE INDEX generation_ledger_month_idx ON generation_ledger(at);

ALTER TABLE clips ADD COLUMN generated_source TEXT;

CREATE UNIQUE INDEX jobs_active_generation_poll_payload_unique_idx
ON jobs(kind, payload_hash)
WHERE kind = 'generation_poll' AND status IN ('pending','running');
"#;

// R10 U-05:平台预设加默认画布方向。走查里选小红书交付出了 1920×1080 横版——
// 集的 canvas_orientation 默认 'both' 被交付侧折成 landscape,跟平台习惯无关。
// 只加列 + 回填(§4.2 数据零破坏),不改既有列;'auto' = 跟随本集素材多数方向。
// 顺手把小红书竖版从 1080×1440 改成平台当前推荐的 1080×1920(同一条 UPDATE 只碰这一行)。
pub const MIGRATION_0042: &str = r#"
ALTER TABLE platform_presets ADD COLUMN default_orientation TEXT NOT NULL DEFAULT 'auto'
  CHECK(default_orientation IN ('landscape','portrait','auto'));
UPDATE platform_presets SET default_orientation = 'portrait'
 WHERE platform IN ('douyin','xiaohongshu','moments');
UPDATE platform_presets SET default_orientation = 'landscape'
 WHERE platform IN ('bilibili','family');
UPDATE platform_presets SET default_orientation = 'auto'
 WHERE platform = 'general';
UPDATE platform_presets SET portrait_w = 1080, portrait_h = 1920
 WHERE platform = 'xiaohongshu';
"#;

// R11 车道 B:时刻分(每 0.5 s 一个窗口的画面/声音打分)与自动挑选的精选段来源标记。
// 只加表、加索引、给 segments 加列;不改任何既有列。
pub const MIGRATION_0043: &str = r#"
CREATE TABLE clip_moments (
  clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  win_index INTEGER NOT NULL,
  t_start_ticks INTEGER NOT NULL CHECK(t_start_ticks >= 0),
  t_end_ticks INTEGER NOT NULL CHECK(t_end_ticks >= t_start_ticks),
  sharp REAL NOT NULL,
  motion REAL NOT NULL,
  exposure_ok INTEGER NOT NULL CHECK(exposure_ok IN (0, 1)),
  loud INTEGER NOT NULL CHECK(loud IN (0, 1)),
  speech INTEGER NOT NULL CHECK(speech IN (0, 1)),
  scene_cut INTEGER NOT NULL DEFAULT 0 CHECK(scene_cut IN (0, 1)),
  score REAL NOT NULL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  pipeline TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY(clip_id, win_index)
);
CREATE INDEX clip_moments_score_idx ON clip_moments(clip_id, score DESC);
ALTER TABLE segments ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE segments ADD COLUMN batch_id TEXT;
CREATE INDEX segments_auto_batch_idx ON segments(batch_id) WHERE source = 'auto';
"#;

// R15:删除 / 重置路径的性能地基。只加索引和一个**虚拟生成列**,不改任何既有列:
// - `jobs.clip_id`:此前仓库里 15 处按 `json_extract(payload,'$.clip_id')` 找任务,
//   写法各异、没有一种能命中索引,每条素材都全表扫一遍 JSON(1 065 条素材 /
//   10 865 任务时 `list_clips` 一次 2.7 s、`remove_records` 13.6 s,见
//   `.superpowers/sdd/r15/analysis.md` §3)。生成列 + 索引之后所有按素材找任务的
//   查询都走 `clip_id = ?`。`json_valid` 守着旧库里可能存在的坏 payload(测试夹具就有)。
// - 外键索引:级联删除时每删一条父行都要在子表里找引用行,这几张表此前没有索引。
pub const MIGRATION_0044: &str = r#"
ALTER TABLE jobs ADD COLUMN clip_id INTEGER
  GENERATED ALWAYS AS (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.clip_id') END) VIRTUAL;
CREATE INDEX jobs_clip_idx ON jobs(clip_id);
CREATE INDEX jobs_kind_clip_idx ON jobs(kind, clip_id, id);
CREATE INDEX routine_overrides_clip_idx ON routine_overrides(clip_id);
CREATE INDEX narrative_boundary_signals_before_clip_idx ON narrative_boundary_signals(before_clip_id);
CREATE INDEX narrative_boundary_signals_after_clip_idx ON narrative_boundary_signals(after_clip_id);
CREATE INDEX generation_requests_result_clip_idx ON generation_requests(result_clip_id);
CREATE INDEX narrative_beats_segment_idx ON narrative_beats(segment_id);
CREATE INDEX music_tracks_episode_idx ON music_tracks(episode_id);
CREATE INDEX story_gaps_episode_idx ON story_gaps(episode_id);
CREATE INDEX import_batches_episode_idx ON import_batches(episode_id);
CREATE INDEX episode_archives_episode_idx ON episode_archives(episode_id);
"#;

// R18 AI-A1:本地描述(`core::clip_brief`)。
//
// 为什么新开一列而不是复用 `ai_descriptions` 加 source='local':
// ① 那张表 `clip_id` 是主键 —— 一条素材只能有一行,本地描述与云端描述**要同时存在**
//    (云端失败/禁用时回落到本地,云端成功后本地那句仍是回落兜底);
// ② 那张表有 `provider IN ('claude','codex','kimi')` 的 CHECK 和 `tags_json NOT NULL`,
//    本地描述没有 provider、也不产标签,塞进去要么撒谎要么放宽约束;
// ③ 本地描述是**派生数据**,随时可由三张表重算,和"花过预算的云端产物"不是一类东西。
pub const MIGRATION_0045: &str = r#"
ALTER TABLE clips ADD COLUMN local_brief TEXT;
"#;

// R18 车道 aiscore(B-1 / B-4):时刻分的第六项与自动挑选的留痕。
//
// `clip_moments.interest` 可空:NULL = 这条素材没有帧级 CLIP 向量,这一项**不参与打分、
// 也不计入分母**(8 GB 档、侧车没起来、老库都是这种)。NULL 与 0.0 含义完全不同 ——
// 0.0 是「看过了,很平庸」,NULL 是「没看」。
//
// `segments.reason_json` NOT NULL DEFAULT '[]':自动挑选写进来的「为什么选它」。
// 给缺省值是为了老行 —— 手打的段本来就没有理由,读出来是空数组,界面不画那一行。
pub const MIGRATION_0046: &str = r#"
ALTER TABLE clip_moments ADD COLUMN interest REAL;
ALTER TABLE segments ADD COLUMN reason_json TEXT NOT NULL DEFAULT '[]';
"#;

// R18 车道 aiscore(C-1):帧级 CLIP 向量。侧车本来就在算这 ≤12 个向量
// (切胶片条 → 逐帧 embed → 再求均值),求完均值就扔了;C-1 的边际算力成本是 0,只是别扔。
// `clip_embeddings`(均值)留着做粗筛,这张表做精排与「搜到第几秒」。
// `t_ticks` 用素材自己的时基,和 `segments` / `clip_moments` 同一套坐标。
pub const MIGRATION_0047: &str = r#"
CREATE TABLE clip_frame_embeddings (
  clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  frame_index INTEGER NOT NULL,
  t_ticks INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  embedded_at TEXT NOT NULL,
  PRIMARY KEY (clip_id, frame_index)
);
"#;

// R18 车道 aiscore(C-1 续):检索按 (model, dimensions) 全表扫,过滤在这条索引上。
// clip_id 的级联删除走 PRIMARY KEY(clip_id, frame_index) 那条隐式索引,不用再建一条。
pub const MIGRATION_0048: &str = r#"
CREATE INDEX clip_frame_embeddings_model_idx
  ON clip_frame_embeddings(model, dimensions);
"#;

/// R19 Wave 2 results 车道(P-03):自动挑选「这一批」可寻址 —— 一次 `auto_select_episode` = 一行
/// `auto_select_runs`(run_id 就是那批段的 `batch_id`,参数原样存 JSON:预算 / 范围 / 权重偏置 /
/// 挑法 / 原句),段上多一列 `auto_select_run_id` 指回去。「不要这一段」把 `batch_id` 摘掉但
/// 保留 run_id,结果面板才能按 run 列出「这批还剩什么」;整批撤销仍按 `batch_id` 走。
pub const MIGRATION_0049: &str = r#"
CREATE TABLE auto_select_runs (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE,
    episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    params_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

ALTER TABLE segments ADD COLUMN auto_select_run_id TEXT REFERENCES auto_select_runs(run_id) ON DELETE SET NULL;

CREATE INDEX segments_auto_select_run_idx ON segments(auto_select_run_id) WHERE auto_select_run_id IS NOT NULL;
"#;

/// R21 PH-01: photographs share clip identity, never video duration.
pub const MIGRATION_0050: &str = r#"
ALTER TABLE clips ADD COLUMN kind TEXT NOT NULL DEFAULT 'video' CHECK(kind IN ('video','photo'));
CREATE INDEX clips_episode_kind_idx ON clips(episode_id,kind,id);
CREATE TABLE photo_meta (
    clip_id INTEGER PRIMARY KEY REFERENCES clips(id) ON DELETE CASCADE,
    width INTEGER, height INTEGER,
    orientation INTEGER NOT NULL DEFAULT 1 CHECK(orientation BETWEEN 1 AND 8),
    taken_at TEXT, gps_lat REAL, gps_lon REAL, camera TEXT, lens TEXT,
    hold_ms INTEGER NOT NULL DEFAULT 3000 CHECK(hold_ms > 0),
    color_space TEXT, has_alpha INTEGER NOT NULL DEFAULT 0 CHECK(has_alpha IN (0,1)),
    error TEXT
);
"#;

/// R21 PH-04: pairing is descriptive; source files are always read-only.
pub const MIGRATION_0051: &str = r#"
ALTER TABLE photo_meta ADD COLUMN companions_ambiguous INTEGER NOT NULL DEFAULT 0 CHECK(companions_ambiguous IN (0,1));
CREATE TABLE clip_companions (
    id INTEGER PRIMARY KEY,
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('raw','xmp','live_mov','jpg')),
    size INTEGER NOT NULL CHECK(size >= 0),
    mtime INTEGER,
    UNIQUE(clip_id,path)
);
CREATE INDEX clip_companions_clip_idx ON clip_companions(clip_id);
"#;

/// R21 W1 验收 P1:`photo_meta.taken_at` 改存 UTC(与视频 `captured_at` 同口径),本地钟原文另存。
/// 照片线尚未发布(0050 起都在 R21 内),没有需要回填的旧行;不在迁移里猜时区。
pub const MIGRATION_0052: &str = r#"
ALTER TABLE photo_meta ADD COLUMN taken_at_local TEXT;
"#;

/// R21 W2 PH-05(合并时由 0052 重编号为 0053,0052 已被 W1 验收的 taken_at_local 占用): decisions and the exact pre-finish state survive restarts.
pub const MIGRATION_0053: &str = r#"
CREATE TABLE duel_sessions (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('photo','video','mixed')),
    source TEXT NOT NULL CHECK(source IN ('similar_group','shot_stack','manual','results')),
    member_ids_json TEXT NOT NULL CHECK(json_valid(member_ids_json)),
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    created_at TEXT NOT NULL,
    finished_at TEXT,
    winner_clip_or_segment_id TEXT,
    snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(snapshot_json)),
    undone INTEGER NOT NULL DEFAULT 0 CHECK(undone IN (0,1))
);
CREATE TABLE duel_verdicts (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES duel_sessions(id) ON DELETE CASCADE,
    left_id TEXT NOT NULL,
    right_id TEXT NOT NULL,
    winner_id TEXT,
    decided_at TEXT NOT NULL,
    undone INTEGER NOT NULL DEFAULT 0 CHECK(undone IN (0,1))
);
CREATE INDEX duel_verdicts_session_idx ON duel_verdicts(session_id,id);
CREATE INDEX duel_sessions_episode_idx ON duel_sessions(episode_id,finished_at,id);
"#;

/// PH-11: append-only copy journal; undoing is durable so interrupted undo resumes.
pub const MIGRATION_0054: &str = r#"
CREATE TABLE archive_ops (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('kit','bundle','photo')),
    status TEXT NOT NULL CHECK(status IN ('planned','running','partial','done','undoing','undone','failed')),
    plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
    started_at TEXT,
    finished_at TEXT
);
CREATE TABLE archive_op_files (
    op_id TEXT NOT NULL REFERENCES archive_ops(id),
    file_index INTEGER NOT NULL DEFAULT 0,
    src_path TEXT NOT NULL,
    src_size INTEGER NOT NULL CHECK(src_size >= 0),
    src_hash TEXT NOT NULL,
    dst_path TEXT NOT NULL,
    dst_temp TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('planned','copied','verified','published','undone','conflict','failed')),
    error TEXT,
    PRIMARY KEY(op_id,file_index),
    UNIQUE(op_id,dst_path)
);
CREATE INDEX archive_ops_pending_idx ON archive_ops(status);
"#;

/// R25：逐行保留已有缓存，高清代理独立映射。
pub const MIGRATION_0055: &str = r#"
ALTER TABLE cache_artifacts RENAME TO cache_artifacts_before_0055;
DROP INDEX cache_artifacts_source_idx;

CREATE TABLE cache_artifacts (
    id INTEGER PRIMARY KEY,
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN (
        'cover', 'strip', 'proxy', 'proxy_hq', 'waveform', 'transcript', 'srt'
    )),
    rel_path TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    bytes INTEGER NOT NULL CHECK(bytes >= 0),
    created_at TEXT NOT NULL,
    UNIQUE(clip_id, kind),
    UNIQUE(rel_path)
);

INSERT INTO cache_artifacts(
    id, clip_id, kind, rel_path, source_hash, bytes, created_at
)
SELECT id, clip_id, kind, rel_path, source_hash, bytes, created_at
FROM cache_artifacts_before_0055;

DROP TABLE cache_artifacts_before_0055;
CREATE INDEX cache_artifacts_source_idx ON cache_artifacts(clip_id, source_hash);

CREATE TABLE proxy_hq_time_map (
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    proxy_ts_ms INTEGER NOT NULL CHECK(proxy_ts_ms >= 0),
    source_ticks INTEGER NOT NULL CHECK(source_ticks >= 0),
    PRIMARY KEY(clip_id, proxy_ts_ms)
);
CREATE INDEX proxy_hq_time_map_source_idx ON proxy_hq_time_map(clip_id, source_ticks);
"#;

pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        sql: MIGRATION_0001,
    },
    Migration {
        version: 2,
        sql: MIGRATION_0002,
    },
    Migration {
        version: 3,
        sql: MIGRATION_0003,
    },
    Migration {
        version: 4,
        sql: MIGRATION_0004,
    },
    Migration {
        version: 5,
        sql: MIGRATION_0005,
    },
    Migration {
        version: 6,
        sql: MIGRATION_0006,
    },
    Migration {
        version: 7,
        sql: MIGRATION_0007,
    },
    Migration {
        version: 8,
        sql: MIGRATION_0008,
    },
    Migration {
        version: 9,
        sql: MIGRATION_0009,
    },
    Migration {
        version: 10,
        sql: MIGRATION_0010,
    },
    Migration {
        version: 11,
        sql: MIGRATION_0011,
    },
    Migration {
        version: 12,
        sql: MIGRATION_0012,
    },
    Migration {
        version: 13,
        sql: MIGRATION_0013,
    },
    // P3-D4 owns 0014: Scene signal layer, semantic Shot Stacks, explainable
    // Best Take state, and the user preference feedback aggregate.
    Migration {
        version: 14,
        sql: MIGRATION_0014,
    },
    // P3-D3 owns 0015 after the earlier lanes consumed its planned 0013 slot.
    Migration {
        version: 15,
        sql: MIGRATION_0015,
    },
    // P3-D5 owns 0016: non-destructive safety labels and exact source-tick
    // rescue windows. The source clip remains outside every deletion path.
    Migration {
        version: 16,
        sql: MIGRATION_0016,
    },
    Migration {
        version: 17,
        sql: MIGRATION_0017,
    },
    // P4-E4 owns 0018 after the integrated Asset Safety and AI-description
    // lanes consumed the task card's planned 0016 slot and 0017.
    Migration {
        version: 18,
        sql: MIGRATION_0018,
    },
    Migration {
        version: 19,
        sql: MIGRATION_0019,
    },
    // Episode Spine。
    Migration {
        version: 20,
        sql: MIGRATION_0020,
    },
    // Narrative Revision。
    Migration {
        version: 21,
        sql: MIGRATION_0021,
    },
    // Routine Override。
    Migration {
        version: 22,
        sql: MIGRATION_0022,
    },
    // Destination Evidence。
    Migration {
        version: 23,
        sql: MIGRATION_0023,
    },
    // 关注文件夹与子文件夹分类。
    Migration {
        version: 24,
        sql: MIGRATION_0024,
    },
    // 滤镜链升级新增的粗筛信号:欠曝/动态范围/模糊度/纹理熵/运动能量/虚焦占比。
    Migration {
        version: 25,
        sql: MIGRATION_0025,
    },
    // Routine 枚举统一。
    Migration {
        version: 26,
        sql: MIGRATION_0026,
    },
    // Close the remaining cross-Episode ownership gaps.
    Migration {
        version: 27,
        sql: MIGRATION_0027,
    },
    // Scope derived Shot Stack editing state to its owning Episode.
    Migration {
        version: 28,
        sql: MIGRATION_0028,
    },
    Migration { version: 29, sql: MIGRATION_0029 },
    Migration { version: 30, sql: MIGRATION_0030 },
    Migration { version: 31, sql: MIGRATION_0031 },
    Migration { version: 32, sql: MIGRATION_0032 },
    Migration { version: 33, sql: MIGRATION_0033 },
    Migration { version: 34, sql: MIGRATION_0034 },
    Migration { version: 35, sql: MIGRATION_0035 },
    Migration { version: 36, sql: MIGRATION_0036 },
    Migration { version: 37, sql: MIGRATION_0037 },
    Migration { version: 38, sql: MIGRATION_0038 },
    Migration { version: 39, sql: MIGRATION_0039 },
    Migration { version: 40, sql: MIGRATION_0040 },
    Migration { version: 41, sql: MIGRATION_0041 },
    Migration { version: 42, sql: MIGRATION_0042 },
    Migration { version: 43, sql: MIGRATION_0043 },
    Migration { version: 44, sql: MIGRATION_0044 },
    Migration { version: 45, sql: MIGRATION_0045 },
    Migration { version: 46, sql: MIGRATION_0046 },
    Migration { version: 47, sql: MIGRATION_0047 },
    Migration { version: 48, sql: MIGRATION_0048 },
    Migration { version: 49, sql: MIGRATION_0049 },
    Migration { version: 50, sql: MIGRATION_0050 },
    Migration { version: 51, sql: MIGRATION_0051 },
    Migration { version: 52, sql: MIGRATION_0052 },
    Migration { version: 53, sql: MIGRATION_0053 },
    Migration { version: 54, sql: MIGRATION_0054 },
    Migration { version: 55, sql: MIGRATION_0055 },
];

pub const LATEST_SCHEMA_VERSION: i64 = 55;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};

    #[test]
    fn r21_migration_preserves_video_ratings_and_order() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        for m in MIGRATIONS.iter().filter(|m| m.version <= 49) { c.execute_batch(m.sql).unwrap(); }
        c.execute_batch("INSERT INTO clips(id,rel_path) VALUES(901,'old.mov');
            INSERT INTO segments(id,clip_id,in_ticks,out_ticks,kind) VALUES(901,901,0,1000,'select');
            INSERT INTO ratings(segment_id,rating_type,value,rated_at) VALUES(901,'star',4,'2026-01-01');
            INSERT INTO story_order(item_kind,clip_id,position,created_at,updated_at) VALUES('whole',901,7,'2026-01-01','2026-01-01');").unwrap();
        let before: String = c.query_row("SELECT sql FROM sqlite_master WHERE name='story_order'", [], |r|r.get(0)).unwrap();
        for m in MIGRATIONS.iter().filter(|m| m.version > 49) { c.execute_batch(m.sql).unwrap(); }
        let kind: String = c.query_row("SELECT kind FROM clips WHERE id=901", [], |r|r.get(0)).unwrap();
        assert_eq!(kind, "video");
        assert_eq!(c.query_row("SELECT position FROM story_order WHERE clip_id=901", [], |r|r.get::<_,i64>(0)).unwrap(),7);
        assert_eq!(c.query_row("SELECT value FROM ratings WHERE segment_id=901", [], |r|r.get::<_,i64>(0)).unwrap(), 4);
        assert_eq!(before,c.query_row("SELECT sql FROM sqlite_master WHERE name='story_order'", [], |r|r.get::<_,String>(0)).unwrap());
        assert_eq!(c.query_row("SELECT count(*) FROM photo_meta", [], |r|r.get::<_,i64>(0)).unwrap(),0);
    }

    #[test]
    fn migrations_are_sequential_and_reach_the_latest_version() {
        for (index, migration) in MIGRATIONS.iter().enumerate() {
            assert_eq!(migration.version, index as i64 + 1);
        }
        assert_eq!(
            MIGRATIONS.last().expect("至少一条迁移").version,
            LATEST_SCHEMA_VERSION
        );
    }

    #[test]
    fn migration_0033_adds_template_column_to_narrative_revisions() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let has_column: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('narrative_revisions') WHERE name = 'template'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(has_column, 1, "0033 必须给 narrative_revisions 加 template 列");

        connection
            .execute(
                "INSERT INTO narrative_revisions(episode_id, kind, template, created_at)
                 SELECT id, 'suggested', 'ambient', '2026-09-06T00:00:00Z' FROM episodes LIMIT 1",
                [],
            )
            .unwrap();
        let rejected = connection.execute(
            "INSERT INTO narrative_revisions(episode_id, kind, template, created_at)
             SELECT id, 'suggested', 'nope', '2026-09-06T00:00:00Z' FROM episodes LIMIT 1",
            [],
        );
        assert!(rejected.is_err(), "CHECK 必须拒绝未知模板");
    }

    #[test]
    fn migration_0038_adds_rotation_source_column() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let has_column: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('clips') WHERE name = 'rotation_source'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(has_column, 1, "0038 必须给 clips 加 rotation_source 列");

        connection
            .execute("INSERT INTO volumes(uuid) VALUES ('v38')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(volume_uuid, rel_path, rotation, rotation_source)
                 VALUES ('v38', 'clip.mov', 90, 'tag')",
                [],
            )
            .unwrap();
        let rejected = connection.execute(
            "INSERT INTO clips(volume_uuid, rel_path, rotation, rotation_source)
             VALUES ('v38', 'clip2.mov', 90, 'bogus')",
            [],
        );
        assert!(rejected.is_err(), "CHECK 必须拒绝未知 rotation_source");
    }

    #[test]
    fn migration_0038_adds_audio_probed_column() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let has_column: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('clips') WHERE name = 'audio_probed'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(has_column, 1, "0038 必须给 clips 加 audio_probed 列");

        connection
            .execute("INSERT INTO volumes(uuid) VALUES ('v38b')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(volume_uuid, rel_path) VALUES ('v38b', 'clip.mov')",
                [],
            )
            .unwrap();
        let default_value: i64 = connection
            .query_row(
                "SELECT audio_probed FROM clips WHERE rel_path = 'clip.mov'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(default_value, 0, "audio_probed 默认必须是 0");

        let rejected = connection.execute(
            "INSERT INTO clips(volume_uuid, rel_path, audio_probed)
             VALUES ('v38b', 'clip2.mov', 2)",
            [],
        );
        assert!(rejected.is_err(), "CHECK 必须拒绝 0/1 以外的值");
    }

    #[test]
    fn migration_0035_adds_clip_ocr_texts_table() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();

        connection
            .execute(
                "INSERT INTO volumes(uuid, label) VALUES ('v', 'vol')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, tb_num, tb_den, duration_ticks)
                 VALUES (1, 'v', 'clip.mov', 1, 1000, 10000)",
                [],
            )
            .unwrap();

        connection
            .execute(
                "INSERT INTO clip_ocr_texts(
                    clip_id, frame_tick, tb_num, tb_den, text, confidence, bbox_json, created_at
                 ) VALUES (1, 500, 1, 1000, 'TripCut', 0.92, '[0.1,0.2,0.3,0.4]', '2026-09-06T00:00:00Z')",
                [],
            )
            .unwrap();

        let stored_text: String = connection
            .query_row(
                "SELECT text FROM clip_ocr_texts WHERE clip_id = 1 AND frame_tick = 500",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_text, "TripCut");

        let rejected = connection.execute(
            "INSERT INTO clip_ocr_texts(
                clip_id, frame_tick, tb_num, tb_den, text, confidence, bbox_json, created_at
             ) VALUES (1, -1, 1, 1000, 'bad', 0.5, '[]', '2026-09-06T00:00:00Z')",
            [],
        );
        assert!(rejected.is_err(), "CHECK 必须拒绝负的 frame_tick");

        // 级联删除：clip 被删后其 OCR 文字行必须一并清除，不留孤儿行。
        connection.execute("DELETE FROM clips WHERE id = 1", []).unwrap();
        let remaining: i64 = connection
            .query_row("SELECT COUNT(*) FROM clip_ocr_texts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 0, "clip 删除必须级联清空 clip_ocr_texts");
    }

    #[test]
    fn migration_0034_creates_music_tables_with_checked_enums() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        for table in ["music_tracks", "music_beats", "music_sections"] {
            let found: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "0034 必须建表 {table}");
        }
        for index in ["music_beats_track_idx", "music_sections_track_idx"] {
            let found: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    [index],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "0034 必须建索引 {index}");
        }

        connection
            .execute(
                "INSERT INTO music_tracks(id, episode_id, file_name, rel_path, duration_ticks, created_at)
                 SELECT 1, id, 'bgm.m4a', 'music/bgm.m4a', 60000000, '2026-09-06T00:00:00Z'
                 FROM episodes LIMIT 1",
                [],
            )
            .unwrap();
        let default_status: String = connection
            .query_row("SELECT analysis_status FROM music_tracks WHERE id = 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(default_status, "pending", "新轨默认待分析");

        assert!(
            connection
                .execute("UPDATE music_tracks SET analysis_status = 'halfway' WHERE id = 1", [])
                .is_err(),
            "CHECK 必须拒绝未知分析状态"
        );
        assert!(
            connection
                .execute(
                    "INSERT INTO music_sections(track_id, start_tick, end_tick, label, energy)
                     VALUES(1, 0, 1000, 'chorus', 0.5)",
                    [],
                )
                .is_err(),
            "CHECK 必须拒绝未知段落标签"
        );
        assert!(
            connection
                .execute(
                    "INSERT INTO music_sections(track_id, start_tick, end_tick, label, energy)
                     VALUES(1, 1000, 0, 'verse', 0.5)",
                    [],
                )
                .is_err(),
            "CHECK 必须拒绝倒挂的段落区间"
        );
        assert!(
            connection
                .execute(
                    "INSERT INTO music_beats(track_id, tick, is_downbeat, strength) VALUES(1, 0, 2, 0.5)",
                    [],
                )
                .is_err(),
            "CHECK 必须拒绝非 0/1 的下拍标志"
        );
    }

    #[test]
    fn migration_0039_adds_import_batch_clips_clip_index() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let found: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'import_batch_clips_clip_idx'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(found, 1, "0039 必须给 import_batch_clips(clip_id) 建索引");
    }

    #[test]
    fn migration_0040_adds_strip_payload_unique_index() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let found: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'jobs_active_strip_payload_unique_idx'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(found, 1, "0040 必须给 strip 任务建部分唯一索引");
    }

    #[test]
    fn schema_version_is_55() {
        assert_eq!(LATEST_SCHEMA_VERSION, 55);
        assert_eq!(MIGRATIONS.last().expect("至少一条迁移").version, 55);
    }

    /// R19 results 车道 P-03:0049 建 `auto_select_runs` 并给 `segments` 加 `auto_select_run_id`。
    /// 对 0.10.0(48)红:表不存在、列不存在。
    #[test]
    fn migration_0049_adds_auto_select_runs_and_the_segment_run_column() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let table: i64 = connection
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'auto_select_runs'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(table, 1, "0049 必须建 auto_select_runs");
        for column in ["run_id", "episode_id", "params_json", "created_at"] {
            let found: i64 = connection
                .query_row("SELECT COUNT(*) FROM pragma_table_info('auto_select_runs') WHERE name = ?1", [column], |row| row.get(0))
                .unwrap();
            assert_eq!(found, 1, "auto_select_runs 缺列 {column}");
        }
        let segment_column: i64 = connection
            .query_row("SELECT COUNT(*) FROM pragma_table_info('segments') WHERE name = 'auto_select_run_id'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(segment_column, 1, "0049 必须给 segments 加 auto_select_run_id");
    }

    /// R18 车道 aiscore:0046 的两列与 0047/0048 的帧表。
    #[test]
    fn migrations_0046_to_0048_add_the_aiscore_columns_and_frame_table() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let has_column = |table: &str, column: &str| -> i64 {
            connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1"),
                    [column],
                    |row| row.get(0),
                )
                .unwrap()
        };
        assert_eq!(has_column("clip_moments", "interest"), 1, "0046 必须给 clip_moments 加 interest 列");
        assert_eq!(has_column("segments", "reason_json"), 1, "0046 必须给 segments 加 reason_json 列");
        for column in ["clip_id", "frame_index", "t_ticks", "embedding", "dimensions", "source_hash", "model"] {
            assert_eq!(has_column("clip_frame_embeddings", column), 1, "0047 的帧表缺列 {column}");
        }
        let index: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'clip_frame_embeddings_model_idx'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index, 1, "0048 必须建 clip_frame_embeddings_model_idx");
        // 老行拿得到缺省值:手打的段没有理由,读出来是空数组而不是 NULL。
        let default_reason: String = connection
            .query_row(
                "SELECT COALESCE(dflt_value, '') FROM pragma_table_info('segments') WHERE name = 'reason_json'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(default_reason.contains("[]"), "reason_json 缺省该是空数组:{default_reason}");
    }

    #[test]
    fn migration_0045_adds_clips_local_brief_column() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let found: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('clips') WHERE name = 'local_brief'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(found, 1, "0045 必须给 clips 加 local_brief 列");
    }

    #[test]
    fn migration_0044_adds_jobs_clip_column_and_fk_indexes() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        // 生成列不在 table_info 里,只在 table_xinfo 里(hidden = 2)。
        let hidden: i64 = connection
            .query_row(
                "SELECT hidden FROM pragma_table_xinfo('jobs') WHERE name = 'clip_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(hidden, 2, "jobs.clip_id 必须是虚拟生成列");
        for index in [
            "jobs_clip_idx",
            "jobs_kind_clip_idx",
            "routine_overrides_clip_idx",
            "narrative_boundary_signals_before_clip_idx",
            "narrative_boundary_signals_after_clip_idx",
            "generation_requests_result_clip_idx",
            "narrative_beats_segment_idx",
            "music_tracks_episode_idx",
            "story_gaps_episode_idx",
            "import_batches_episode_idx",
            "episode_archives_episode_idx",
        ] {
            let found: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    [index],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "0044 必须建索引 {index}");
        }
        // 坏 payload 不能让生成列炸掉(旧库里就有这样的行),按素材找任务要走索引。
        crate::core::jobs::enqueue(&mut connection, "noop", "{", "malformed").unwrap();
        crate::core::jobs::enqueue(&mut connection, "analyze_l1", r#"{"clip_id":7}"#, "seven").unwrap();
        let found: i64 = connection
            .query_row("SELECT COUNT(*) FROM jobs WHERE clip_id = 7", [], |row| row.get(0))
            .unwrap();
        assert_eq!(found, 1);
        let plan: String = connection
            .query_row(
                "EXPLAIN QUERY PLAN SELECT id FROM jobs WHERE kind = 'analyze_l1' AND clip_id = 7 ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(3),
            )
            .unwrap();
        assert!(plan.contains("jobs_kind_clip_idx"), "按素材找任务必须走索引,实际计划:{plan}");
    }

    #[test]
    fn migration_0043_adds_clip_moments_and_segment_source_columns() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let table: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'clip_moments'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table, 1, "0043 必须建 clip_moments 表");
        let columns: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('segments') WHERE name IN ('source', 'batch_id')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(columns, 2, "0043 必须给 segments 加 source 与 batch_id 列");
        let default_source: String = connection
            .query_row("SELECT dflt_value FROM pragma_table_info('segments') WHERE name = 'source'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(default_source, "'manual'");
    }

    #[test]
    fn migration_0042_adds_default_orientation_and_backfills_presets() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let has_column: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('platform_presets') WHERE name = 'default_orientation'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(has_column, 1, "0042 必须给 platform_presets 加 default_orientation 列");
        let mut statement = connection
            .prepare("SELECT platform, default_orientation, portrait_w, portrait_h FROM platform_presets ORDER BY platform")
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .unwrap()
            .map(|row| row.unwrap())
            .collect::<Vec<_>>();
        let orientation_of = |platform: &str| {
            rows.iter().find(|row| row.0 == platform).map(|row| row.1.as_str()).unwrap()
        };
        assert_eq!(orientation_of("douyin"), "portrait");
        assert_eq!(orientation_of("xiaohongshu"), "portrait");
        assert_eq!(orientation_of("moments"), "portrait");
        assert_eq!(orientation_of("bilibili"), "landscape");
        assert_eq!(orientation_of("family"), "landscape");
        assert_eq!(orientation_of("general"), "auto");
        let xiaohongshu = rows.iter().find(|row| row.0 == "xiaohongshu").unwrap();
        assert_eq!((xiaohongshu.2, xiaohongshu.3), (1080, 1920), "小红书竖版改为 1080×1920");
        // 其它行的尺寸不动。
        let douyin = rows.iter().find(|row| row.0 == "douyin").unwrap();
        assert_eq!((douyin.2, douyin.3), (1080, 1920));
        let error = connection
            .execute("UPDATE platform_presets SET default_orientation = 'both' WHERE platform = 'douyin'", [])
            .unwrap_err();
        assert!(error.to_string().contains("CHECK"), "default_orientation 只允许三枚举");
    }

    #[test]
    fn migration_0041_creates_gap_and_generation_tables() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();

        let column_names = |table: &str| -> Vec<String> {
            let mut statement = connection
                .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .map(|value| value.unwrap())
                .collect()
        };

        let story_gaps_columns = column_names("story_gaps");
        for expected in [
            "id",
            "episode_id",
            "revision_id",
            "chapter_id",
            "beat_id",
            "slot",
            "reason",
            "status",
            "detected_at",
            "updated_at",
        ] {
            assert!(
                story_gaps_columns.iter().any(|name| name == expected),
                "story_gaps 缺列 {expected}"
            );
        }

        let generation_requests_columns = column_names("generation_requests");
        for expected in [
            "id",
            "gap_id",
            "retry_of",
            "provider",
            "model",
            "mode",
            "prompt",
            "refs_json",
            "duration_s",
            "resolution",
            "ratio",
            "estimated_cost_usd",
            "task_id",
            "status",
            "error",
            "result_url",
            "result_clip_id",
            "created_at",
            "updated_at",
        ] {
            assert!(
                generation_requests_columns.iter().any(|name| name == expected),
                "generation_requests 缺列 {expected}"
            );
        }

        let generation_ledger_columns = column_names("generation_ledger");
        for expected in ["id", "request_id", "cost_usd", "seconds", "images", "at"] {
            assert!(
                generation_ledger_columns.iter().any(|name| name == expected),
                "generation_ledger 缺列 {expected}"
            );
        }

        let clips_columns = column_names("clips");
        assert!(
            clips_columns.iter().any(|name| name == "generated_source"),
            "clips 必须新增 generated_source 列"
        );

        let unique_index_exists = |name: &str| -> i64 {
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    [name],
                    |row| row.get(0),
                )
                .unwrap()
        };
        assert_eq!(
            unique_index_exists("story_gaps_unique_idx"),
            1,
            "0041 必须给 story_gaps(chapter_id, slot) 建唯一索引"
        );
        assert_eq!(
            unique_index_exists("jobs_active_generation_poll_payload_unique_idx"),
            1,
            "0041 必须给 generation_poll 任务建部分唯一索引"
        );
    }
}
