import { invoke } from "@tauri-apps/api/core";

export interface MediaServerInfo {
  port: number;
  token: string;
}

export interface AppInfo {
  version: string;
  db_schema_version: number;
  worker_count: number;
  read_only: boolean;
}

export type DoctorLevel = "OK" | "WARN" | "FAIL";

export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorLevel;
  detail: string;
}

export interface DoctorReport {
  status: DoctorLevel;
  checks: DoctorCheck[];
  abnormal_exit: boolean;
  recovered_jobs: number;
  cache_sampled: number;
  cache_missing: number;
  snapshots: string[];
  restart_required: boolean;
}

export type SettingsMap = Record<string, string>;

export interface LlmProviderStatus {
  provider: "claude" | "codex" | "kimi";
  executable: string;
  available: boolean;
}

export interface LlmStatus {
  enabled: boolean;
  provider: "none" | "auto" | "claude" | "codex" | "kimi";
  monthly_budget: number;
  calls_this_month: number;
  remaining_calls: number;
  budget_exhausted: boolean;
  providers: LlmProviderStatus[];
}

export interface LlmLedgerEntry {
  id: number;
  called_at: string;
  provider: "claude" | "codex" | "kimi";
  purpose: string;
  estimated_tokens: number;
  status: "running" | "succeeded" | "failed" | "parse_failed";
  error_summary: string | null;
}

export interface AiDescriptionResult {
  clip_id: number;
  description: string;
  tags: string[];
  provider: "claude" | "codex" | "kimi";
}

export interface DirectorContext {
  current_filter: string;
  total_clips: number;
  visible_clips: number;
  favorites: number;
  rejected: number;
  unrated: number;
  selected_summary: string[];
}

export interface DirectorAnswerResult {
  answer: string;
  provider: "claude" | "codex" | "kimi";
}

export interface ToolStatus {
  configured_path: string;
  resolved_path: string;
  available: boolean;
  version: string | null;
  note: string | null;
}

export interface SettingsStatus {
  ffmpeg: ToolStatus;
  ffprobe: ToolStatus;
  whisper: {
    binary: ToolStatus;
    model_tier: string;
    model_path: string;
    model_available: boolean;
    models_directory: string;
  };
  clip_sidecar: {
    venv_path: string;
    service_path: string;
    setup_script: string;
    available: boolean;
    service_available: boolean;
    note: string;
  };
  cache: {
    database_bytes: number;
    disk_bytes: number;
  };
}

export interface CacheRebuildResult {
  removed_database_rows: number;
  reset_jobs: number;
  removed_disk_bytes: number;
}

export interface ImportStart {
  folder: string;
  total: number;
  enqueued: number;
  skipped: number;
}

export interface ImportProgress {
  total: number;
  done: number;
  failed: number;
  running: number;
}

export interface ClipAnalysis {
  clip_id: number;
  exposure_yavg: number;
  overexposed_ratio: number;
  audio_peak_db: number | null;
  audio_clipped: boolean;
  has_audio: boolean;
  focus_scores: number[];
  scene_count: number;
  analyzed_at: string;
  tool_versions: Record<string, unknown>;
  underexposed_ratio: number;
  dynamic_range: number;
  blur_mean: number;
  entropy_mean: number;
  motion_mean: number;
  out_of_focus_ratio: number;
}

export interface ClipMotion {
  clip_id: number;
  class: "pan" | "tilt" | "zoom" | "handheld" | "static";
  pan_ratio: number;
  tilt_ratio: number;
  zoom_corr: number;
  shake_score: number;
  is_shaky: boolean;
  sample_pairs: number;
  tool_version: string;
}

export interface TranscriptMatch {
  clip_id: number;
  seg: number;
  text: string;
  start_ticks: number;
  end_ticks: number;
  tb_num: number;
  tb_den: number;
}

export interface ClipListItem {
  id: number | null;
  episode_id: number | null;
  folder_label: string | null;
  cover_url: string | null;
  path: string;
  file_name: string;
  byte_size: number | null;
  quick_hash: string | null;
  full_hash: string | null;
  tb_num: number | null;
  tb_den: number | null;
  duration_ticks: number | null;
  fps_num: number | null;
  fps_den: number | null;
  is_vfr: boolean;
  codec: string | null;
  width: number | null;
  height: number | null;
  captured_at: string | null;
  audio_sample_rate?: number | null;
  rotation?: number | null;
  color_transfer?: string | null;
  hdr_flag?: boolean;
  tz_guess?: string | null;
  tz_conflict?: boolean;
  device_model?: string | null;
  journey_offset_ms?: number;
  status: "ready" | "duplicate" | "unreadable";
  error: string | null;
  analysis: ClipAnalysis | null;
  analysis_status: "pending" | "running" | "done" | "failed" | "blocked" | null;
  analysis_error: string | null;
  motion: ClipMotion | null;
  motion_status: "pending" | "running" | "done" | "failed" | "blocked" | null;
  motion_error: string | null;
  binary_rating: -1 | 0 | 1 | null;
  star_rating: 0 | 1 | 2 | 3 | 4 | 5 | null;
  select_count: number;
}

export interface DeviceClockSetting {
  device_model: string;
  clip_count: number;
  journey_offset_ms: number;
  source: "unset" | "reference" | "auto" | "manual";
  confidence: number | null;
  timezone_conflicts: number;
  needs_review: boolean;
}

export type RatingType = "binary" | "star";

export interface ClipRating {
  clip_id: number;
  segment_id: number;
  rating_type: RatingType;
  value: number;
  rated_at: string;
}

export interface SelectSegment {
  id: number;
  clip_id: number;
  in_ticks: number;
  out_ticks: number;
  tb_num: number;
  tb_den: number;
}

export type AssetSafetyFlag = "normal" | "likely_unusable" | "rescue_candidate";

export interface RescueRange {
  in_ticks: number;
  out_ticks: number;
  tb_num: number;
  tb_den: number;
  reason: string;
}

export interface AssetSafetyInfo {
  clip_id: number;
  safety_flag: AssetSafetyFlag;
  image_score: number | null;
  motion_score: number | null;
  audio_score: number | null;
  narrative_score: number;
  narrative_signals: string[];
  rescue_range: RescueRange | null;
  rescue_suggestions: string[];
}

export interface PlayerViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PlayerCommand =
  | { type: "play" }
  | { type: "pause" }
  | { type: "step_fwd" }
  | { type: "step_back" }
  | { type: "seek_abs"; seconds: number };

export interface PlayerStatus {
  phase: "closed" | "loading" | "ready" | "error";
  clip_id: number | null;
  pos: number;
  duration: number;
  paused: boolean;
  frame: number | null;
  error: string | null;
  seek_samples: number;
  seek_p50_ms: number | null;
  seek_p95_ms: number | null;
  last_seek_ms: number | null;
}

export interface ClipSearchHit {
  clip_id: number;
  score: number;
}

export type ClipDimensionKey =
  | "movement"
  | "shot_size"
  | "subject"
  | "viewpoint"
  | "function"
  | "person_state"
  | "time_stage"
  | "sound";

export interface ClipDimension {
  clip_id: number;
  dimension: ClipDimensionKey;
  label: string;
  score: number;
  source: string;
}

export interface SimilarGroupMember {
  clip_id: number;
  is_primary: boolean;
}

export interface SimilarGroup {
  id: number;
  min_similarity: number;
  members: SimilarGroupMember[];
}

export type ShotStackType = "visual" | "information" | "human";
export type ShotStackUserState = "auto" | "locked" | "rejected" | "hero";

export interface BestTakeAxisScore {
  score: number | null;
  confidence: number;
  source: string;
  note: string;
}

export interface BestTakeWeights {
  technical: number;
  composition: number;
  motion: number;
  human: number;
  audio: number;
  narrative: number;
}

export interface BestTakeBreakdown {
  technical: BestTakeAxisScore;
  composition: BestTakeAxisScore;
  motion: BestTakeAxisScore;
  human: BestTakeAxisScore;
  audio: BestTakeAxisScore;
  narrative: BestTakeAxisScore;
  configured_weights: BestTakeWeights;
  preference_boost: number;
  total: number;
}

export interface ShotStackMember {
  clip_id: number;
  segment_id: number | null;
  best_take_score: number | null;
  score_breakdown: BestTakeBreakdown;
  user_state: ShotStackUserState;
  is_preferred: boolean;
  long_term_memory: ClipMemoryAnnotation;
}

export interface ShotStack {
  id: number;
  scene_id: number;
  scene_name: string;
  stack_type: ShotStackType;
  subject_label: string;
  function_label: string;
  shot_size_label: string;
  movement_label: string;
  quality_exempt: boolean;
  members: ShotStackMember[];
}

export interface Chapter {
  id: number;
  title: string;
  start_at: string;
  end_at: string;
  clip_count: number;
}

export type StoryItemKind = "whole" | "segment";

export interface StoryItem {
  key: string;
  item_kind: StoryItemKind;
  clip_id: number;
  segment_id: number | null;
  chapter_id: number | null;
  file_name: string;
  in_ticks: number;
  out_ticks: number;
  tb_num: number;
  tb_den: number;
  position: number | null;
  long_term_memory: ClipMemoryAnnotation;
}

export interface RoutineSuggestion {
  routine_kind: string;
  treatment: "explained" | "montage" | "story_event";
  previous_occurrences: number;
  changed: boolean;
  reason: string;
}

export interface ClipMemoryAnnotation {
  used_episode_badges: string[];
  repeated_signature_uses: number;
  recent_episode_window: number;
  routine_visual: boolean;
  novelty_context: boolean;
  narrative_adjustment: number;
  routine_suggestion: RoutineSuggestion | null;
}

export interface Storyboard {
  chapters: Chapter[];
  items: StoryItem[];
  candidates: StoryItem[];
  can_undo: boolean;
  mode: "legacy" | "narrative";
  mode_notice: string;
  narrative: NarrativeOverview | null;
  narration_job_status: "pending" | "running" | "done" | "failed" | "blocked" | null;
}

export interface NarrativeOverview {
  episode: NarrativeEpisode;
  chapters: NarrativeChapter[];
  destination_cards: DestinationCard[];
  boundary_signals: BoundarySignal[];
  job_status: string | null;
  dh_guard: DhGuardSummary;
}

export interface DhAppearanceSummary {
  episode_badge: string;
  mode: string;
  duration_s: number;
  style: string;
  topic: string;
}

export interface DhGuardSummary {
  historical_appearances: DhAppearanceSummary[];
  current_estimated_duration_s: number;
  duration_warning_threshold_s: number;
  warnings: string[];
}

export interface NarrativeEpisode {
  id: number;
  title: string;
  theme: string;
  created_at: string;
}

export interface NarrativeChapter {
  id: number;
  kind: NarrativeChapterKind;
  title: string;
  order: number;
  promoted: boolean;
  score: number;
  rationale: string;
  promotion_reason: string;
  story_slots: string[];
  missing_slots: string[];
  digital_human_plan: DigitalHumanPlan | null;
  beats: NarrativeBeat[];
}

export type NarrativeChapterKind =
  | "destination"
  | "attraction"
  | "journey"
  | "experience"
  | "rv_life"
  | "people"
  | "unexpected"
  | "information"
  | "atmosphere"
  | "transition";

export interface NarrativeBeat {
  id: number;
  clip_id: number;
  segment_id: number | null;
  role: "beat" | "montage" | "transition";
  order: number;
  score: number;
  rationale: string;
  routine_suggestion: RoutineSuggestion | null;
  /** 人工已把该 clip 标记为"非 Routine"——routine_suggestion 会被后端抹成
   * null,必须靠这个字段才能跟"AI 本就没建议"区分开,从而显示恢复入口。 */
  routine_cleared: boolean;
}

export interface DigitalHumanPlan {
  mode: "A" | "B" | "C" | "D" | "E";
  reason: string;
  planned_slots: string[];
}

export interface CoverageItem {
  item: string;
  covered: boolean;
  evidence: string;
  suggestion: string;
}

export interface DestinationCard {
  id: number;
  chapter_id: number;
  name: string;
  geo_context: string;
  highlights: string;
  why_visit: string;
  personal_note: string;
  sources: Array<{ label: string; basis: string }>;
  verified: boolean;
  coverage: CoverageItem[];
  field_states: Record<string, string>;
}

export interface BoundarySignal {
  before_clip_id: number;
  after_clip_id: number;
  score: number;
  reasons: string[];
}

export interface StoryOrderRef {
  item_kind: StoryItemKind;
  clip_id: number;
  segment_id: number | null;
}

export type ArtifactStatus =
  | "missing"
  | "pending"
  | "running"
  | "ready"
  | "direct"
  | "failed";

export interface ClipArtifacts {
  cover: string | null;
  strip: string | null;
  proxy: string | null;
  waveform: string | null;
  statuses: {
    cover: ArtifactStatus;
    strip: ArtifactStatus;
    proxy: ArtifactStatus;
    waveform: ArtifactStatus;
  };
}

export interface WaveformData {
  version: 1;
  bins: 2000;
  peaks: [number, number][];
}

export interface ExportItemStatus {
  clip_id: number;
  file_name: string;
  output_name: string;
  status: "pending" | "running" | "done" | "failed";
  note: string | null;
  warning: boolean;
}

export interface ExportStatus {
  job_id: number | null;
  status: "idle" | "pending" | "running" | "done" | "failed" | "blocked";
  stage:
    | "idle"
    | "queued"
    | "remuxing"
    | "rough_cut"
    | "documents"
    | "finalizing"
    | "cancelling"
    | "cancelled"
    | "complete"
    | "failed";
  selected_count: number;
  selected_segment_count: number;
  selected_whole_count: number;
  total_duration_seconds: number;
  completed_items: number;
  failed_items: number;
  items: ExportItemStatus[];
  output_path: string | null;
  error: string | null;
}

export interface JianyingAvailability {
  installed_version: string | null;
  supported: boolean;
  reason: string;
}

export interface JianyingDraftResult {
  status: "created";
  output_path: string;
  draft_name: string;
  jianying_version: string;
  selected_count: number;
  subtitle_count: number;
  message: string;
}

export function getMediaServerInfo(): Promise<MediaServerInfo> {
  return invoke<MediaServerInfo>("get_media_server_info");
}

export function getDoctorReport(): Promise<DoctorReport> {
  return invoke<DoctorReport>("get_doctor_report");
}

export function restoreLatestSnapshot(): Promise<string> {
  return invoke<string>("restore_latest_snapshot");
}

export function exportDecisionData(): Promise<string> {
  return invoke<string>("export_decision_data");
}

export function rebuildRecoveryCache(): Promise<string> {
  return invoke<string>("rebuild_recovery_cache");
}

export function openLogsDirectory(): Promise<void> {
  return invoke<void>("open_logs_directory");
}

export function getAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("get_app_info");
}

export function getSettings(): Promise<SettingsMap> {
  return invoke<SettingsMap>("get_settings");
}

export function setSetting(key: string, value: string): Promise<void> {
  return invoke<void>("set_setting", { key, value });
}

export function getLlmStatus(): Promise<LlmStatus> {
  return invoke<LlmStatus>("get_llm_status");
}

export function listLlmLedger(): Promise<LlmLedgerEntry[]> {
  return invoke<LlmLedgerEntry[]>("list_llm_ledger");
}

export function describeClipWithAi(clipId: number): Promise<AiDescriptionResult> {
  return invoke<AiDescriptionResult>("describe_clip_with_ai", { clipId });
}

export function getAiDescription(clipId: number): Promise<AiDescriptionResult | null> {
  return invoke<AiDescriptionResult | null>("get_ai_description", { clipId });
}

export function askDirector(
  question: string,
  context: DirectorContext,
): Promise<DirectorAnswerResult> {
  return invoke<DirectorAnswerResult>("ask_director", { question, context });
}

export function getSettingsStatus(): Promise<SettingsStatus> {
  return invoke<SettingsStatus>("get_settings_status");
}

export function clearCacheAndRebuild(): Promise<CacheRebuildResult> {
  return invoke<CacheRebuildResult>("clear_cache_and_rebuild");
}

export function runClipSelfCheck(): Promise<string> {
  return invoke<string>("run_clip_self_check");
}

export function pickImportFolder(): Promise<string | null> {
  return invoke<string | null>("pick_import_folder");
}

export function startImport(path: string): Promise<ImportStart> {
  return invoke<ImportStart>("start_import", { path });
}

export function getImportProgress(): Promise<ImportProgress> {
  return invoke<ImportProgress>("get_import_progress");
}

export function listClips(): Promise<ClipListItem[]> {
  return invoke<ClipListItem[]>("list_clips");
}

export function listDeviceClocks(): Promise<DeviceClockSetting[]> {
  return invoke<DeviceClockSetting[]>("list_device_clocks");
}

export function setDeviceClockOffset(deviceModel: string, offsetMs: number): Promise<void> {
  return invoke<void>("set_device_clock_offset", { deviceModel, offsetMs });
}

export function listClipDimensions(): Promise<ClipDimension[]> {
  return invoke<ClipDimension[]>("list_clip_dimensions");
}

export function setClipTimeStage(clipId: number, label: string): Promise<void> {
  return invoke<void>("set_clip_time_stage", { clipId, label });
}

export function getClipAnalysis(clipId: number): Promise<ClipAnalysis | null> {
  return invoke<ClipAnalysis | null>("get_clip_analysis", { clipId });
}

export function searchTranscripts(keyword: string): Promise<TranscriptMatch[]> {
  return invoke<TranscriptMatch[]>("search_transcripts", { keyword });
}

export function getClipArtifacts(clipId: number): Promise<ClipArtifacts> {
  return invoke<ClipArtifacts>("get_clip_artifacts", { clipId });
}

export function searchClips(query: string): Promise<ClipSearchHit[]> {
  return invoke<ClipSearchHit[]>("search_clips", { query });
}

export function listSimilarGroups(): Promise<SimilarGroup[]> {
  return invoke<SimilarGroup[]>("list_similar_groups");
}

export function setSimilarPrimary(groupId: number, clipId: number): Promise<void> {
  return invoke<void>("set_similar_primary", { groupId, clipId });
}

export function listShotStacks(): Promise<ShotStack[]> {
  return invoke<ShotStack[]>("list_shot_stacks");
}

export function listAssetSafety(): Promise<AssetSafetyInfo[]> {
  return invoke<AssetSafetyInfo[]>("list_asset_safety");
}

export function applyRescueRange(clipId: number): Promise<SelectSegment> {
  return invoke<SelectSegment>("apply_rescue_range", { clipId });
}

export function setShotStackUserState(
  stackId: number,
  clipId: number,
  segmentId: number | null,
  userState: ShotStackUserState,
): Promise<void> {
  return invoke<void>("set_shot_stack_user_state", {
    stackId,
    clipId,
    segmentId,
    userState,
  });
}

export function getStoryboard(): Promise<Storyboard> {
  return invoke<Storyboard>("get_storyboard");
}

export function enqueueNarrateEpisode(): Promise<number> {
  return invoke<number>("enqueue_narrate_episode");
}

export function updateDestinationCard(card: DestinationCard): Promise<void> {
  return invoke<void>("update_destination_card", {
    cardId: card.id,
    name: card.name,
    geoContext: card.geo_context,
    highlights: card.highlights,
    whyVisit: card.why_visit,
    personalNote: card.personal_note,
  });
}

export function setDestinationCardVerified(cardId: number, verified: boolean): Promise<void> {
  return invoke<void>("set_destination_card_verified", { cardId, verified });
}

export function setStoryOrder(order: StoryOrderRef[]): Promise<void> {
  return invoke<void>("set_story_order", { order });
}

export function renameChapter(chapterId: number, title: string): Promise<void> {
  return invoke<void>("rename_chapter", { chapterId, title });
}

export function mergeChapters(sourceChapterId: number, targetChapterId: number): Promise<void> {
  return invoke<void>("merge_chapters", { sourceChapterId, targetChapterId });
}

export function undoStoryChange(): Promise<void> {
  return invoke<void>("undo_story_change");
}

export function pickExportFolder(): Promise<string | null> {
  return invoke<string | null>("pick_export_folder");
}

export function startExport(dest: string): Promise<ExportStatus> {
  return invoke<ExportStatus>("start_export", { dest });
}

export function getExportStatus(jobId: number | null): Promise<ExportStatus> {
  return invoke<ExportStatus>("get_export_status", { jobId });
}

export function cancelExport(jobId: number): Promise<void> {
  return invoke<void>("cancel_export", { jobId });
}

export function cancelJob(jobId: number): Promise<void> {
  return invoke<void>("cancel_job", { jobId });
}

export function revealExport(jobId: number): Promise<void> {
  return invoke<void>("reveal_export", { jobId });
}

export function getJianyingAvailability(): Promise<JianyingAvailability> {
  return invoke<JianyingAvailability>("get_jianying_availability");
}

export function generateJianyingDraft(): Promise<JianyingDraftResult> {
  return invoke<JianyingDraftResult>("generate_jianying_draft");
}

export function rateClip(
  clipId: number,
  ratingType: RatingType,
  value: number,
): Promise<ClipRating> {
  return invoke<ClipRating>("rate_clip", { clipId, ratingType, value });
}

export function clearClipRating(clipId: number): Promise<void> {
  return invoke<void>("clear_clip_rating", { clipId });
}

export function listSelectSegments(clipId: number): Promise<SelectSegment[]> {
  return invoke<SelectSegment[]>("list_select_segments", { clipId });
}

export function createSelectSegment(
  clipId: number,
  inSeconds: number,
  outSeconds: number,
): Promise<SelectSegment> {
  return invoke<SelectSegment>("create_select_segment", { clipId, inSeconds, outSeconds });
}

export function deleteSelectSegment(segmentId: number): Promise<void> {
  return invoke<void>("delete_select_segment", { segmentId });
}

export function playerSetViewport(viewport: PlayerViewport): Promise<void> {
  return invoke<void>("player_set_viewport", { viewport });
}

export function playerOpen(clipId: number): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_open", { clipId });
}

export function playerClose(): Promise<void> {
  return invoke<void>("player_close");
}

export function playerCommand(cmd: PlayerCommand): Promise<void> {
  return invoke<void>("player_command", { cmd });
}

export function playerStatus(): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_status");
}

export interface EpisodeSummary {
  id: number;
  title: string;
  theme: string;
  episode_number: number | null;
  status: "active" | "archived";
  created_at: string;
  archived_at: string | null;
  clip_count: number;
  favorite_count: number;
  export_count: number;
}

export interface ArchiveOutcome {
  archived: EpisodeSummary;
  next: EpisodeSummary;
}

export async function listEpisodes(): Promise<EpisodeSummary[]> {
  return invoke<EpisodeSummary[]>("list_episodes");
}

export async function getCurrentEpisode(): Promise<EpisodeSummary> {
  return invoke<EpisodeSummary>("get_current_episode");
}

export async function renameCurrentEpisode(title: string, theme: string): Promise<EpisodeSummary> {
  return invoke<EpisodeSummary>("rename_current_episode", { title, theme });
}

export async function archiveCurrentEpisode(nextTitle: string | null): Promise<ArchiveOutcome> {
  return invoke<ArchiveOutcome>("archive_current_episode", { nextTitle });
}

export interface RevisionInfo {
  id: number;
  episode_id: number;
  kind: "suggested" | "confirmed";
  created_at: string;
  pending_undo_count: number;
}

export type NarrativeOpPayload =
  | { op: "rename_chapter"; chapter_id: number; title: string }
  | { op: "set_chapter_kind"; chapter_id: number; kind: string }
  | { op: "move_beat"; beat_id: number; to_chapter_id: number; to_order: number }
  | { op: "set_beat_role"; beat_id: number; role: string };

export async function getNarrativeRevision(): Promise<RevisionInfo | null> {
  return invoke<RevisionInfo | null>("get_narrative_revision");
}

export async function applyNarrativeOp(op: NarrativeOpPayload): Promise<RevisionInfo> {
  return invoke<RevisionInfo>("apply_narrative_op", { op });
}

export async function undoNarrativeOp(): Promise<RevisionInfo | null> {
  return invoke<RevisionInfo | null>("undo_narrative_op");
}

export async function setRoutineOverride(
  clipId: number,
  treatment: string | null,
  cleared: boolean,
): Promise<void> {
  return invoke<void>("set_routine_override", { clipId, treatment, cleared });
}

export async function acceptAllRoutineSuggestions(
  suggestions: Array<[number, string]>,
): Promise<number> {
  return invoke<number>("accept_all_routine_suggestions", { suggestions });
}

export interface MemoryLensEntry {
  clip_id: number;
  used_episode_badges: string[];
  repeated_signature_uses: number;
  recent_episode_window: number;
  routine_visual: boolean;
  novelty_context: boolean;
}

export async function getMemoryLens(): Promise<MemoryLensEntry[]> {
  return invoke<MemoryLensEntry[]>("get_memory_lens");
}

export interface GlobalSearchHit {
  kind: "file" | "transcript" | "description" | "dimension";
  clip_id: number;
  file_name: string;
  excerpt: string;
}

export async function searchEverything(query: string): Promise<GlobalSearchHit[]> {
  return invoke<GlobalSearchHit[]>("search_everything", { query });
}


export async function setDestinationFieldState(
  cardId: number,
  field: string,
  fieldState: "pending" | "verified" | "rejected",
): Promise<void> {
  return invoke<void>("set_destination_field_state", { cardId, field, fieldState });
}

export interface ComponentStatus {
  id: string;
  title: string;
  installed: boolean;
  detail: string;
  installable: boolean;
  approx_size_mb: number;
}

export interface InstallProgress {
  component: string;
  phase: string;
  downloaded_bytes: number;
  total_hint_mb: number;
  done: boolean;
  error: string | null;
}

export async function getComponentStatuses(): Promise<ComponentStatus[]> {
  return invoke<ComponentStatus[]>("get_component_statuses");
}

export async function startComponentInstall(component: string): Promise<void> {
  return invoke<void>("start_component_install", { component });
}

export async function getInstallProgress(component: string): Promise<InstallProgress> {
  return invoke<InstallProgress>("get_install_progress", { component });
}

export async function cancelComponentInstall(component: string): Promise<void> {
  return invoke<void>("cancel_component_install", { component });
}

export async function openProviderLogin(provider: string): Promise<void> {
  return invoke<void>("open_provider_login", { provider });
}

export interface WatchedFolder {
  id: number;
  path: string;
  auto_sync: boolean;
  added_at: string;
  last_scan_at: string | null;
}

export async function listWatchedFolders(): Promise<WatchedFolder[]> {
  return invoke<WatchedFolder[]>("list_watched_folders");
}

export async function setWatchedFolderSync(id: number, autoSync: boolean): Promise<void> {
  return invoke<void>("set_watched_folder_sync", { id, autoSync });
}

export async function removeWatchedFolder(id: number): Promise<void> {
  return invoke<void>("remove_watched_folder", { id });
}

export interface RescanOutcome {
  enqueued: number;
  unavailable: number;
  scanned: number;
}

export async function rescanWatchedFolders(): Promise<RescanOutcome> {
  return invoke<RescanOutcome>("rescan_watched_folders");
}
