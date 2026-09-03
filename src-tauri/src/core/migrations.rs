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
];

pub const LATEST_SCHEMA_VERSION: i64 = 28;
