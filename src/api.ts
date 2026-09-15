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
    /** R16:预览小文件合计与目录上限(字节);旧后端没有这两项。 */
    proxy_bytes?: number;
    proxy_limit_bytes?: number;
    /** R18 W-7:快照目录合计占用与总量上限(字节);旧后端没有这两项。 */
    snapshot_bytes?: number;
    snapshot_limit_bytes?: number;
  };
  /** R10 U-22:首启引导已跳过/完成(settings `onboarding.first_run_done`)。 */
  first_run_done?: boolean;
  /** R18:当前性能档位与力度(只读);旧后端没有这一项。 */
  performance?: {
    /** `low_spec` | `low` | `standard` | `high_perf` */
    profile: string;
    /** `base` | `pro` | `max` | `ultra` | `unknown` */
    chip: string;
    media_engines: number;
    perf_cores: number;
    decode_permits: number;
    /** `eco` | `balanced` | `full`(设置键 `performance.background_effort`) */
    background_effort: string;
    /** 这一档是否提供「全速」第三挡(低配 / 省内存档只有两挡) */
    allows_full_effort: boolean;
    worker_count: number;
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
  waiting_for_permit: number;
  paused_for_memory: boolean;
  /** R16 §3⑤:不认领重活的原因(memory / thermal / idle_wait);R16 P1-6 用户「全部暂停」报 user;旧后端缺省。 */
  /** R18 W-6:多一位 `low_power`(系统低电量模式,后台减速但不停)。 */
  paused_reason?: "user" | "memory" | "thermal" | "idle_wait" | "low_power" | null;
  /** Z-01(R14 stress):当前集已登记的素材数 / 其中画质 + 运镜分析已落终态的数;旧后端缺省。 */
  analysis_total?: number;
  analysis_done?: number;
  /** Z-01(R14 stress):登记完成但判定重复的文件数(没有素材行,状态条算作已处理)。 */
  duplicate?: number;
  /** R15-perf:当前集排过「预览小文件」的素材数 / 其中还在排队或进行中的数;旧后端缺省。 */
  proxy_total?: number;
  proxy_pending?: number;
  /** R15:还没做完的缓存文件清理任务数(删素材 / 删集 / 清缓存后后台删目录);旧后端缺省。 */
  cleanup_pending?: number;
  /** R15:还没生成完的预览文件任务数(封面 / 胶片条 / 波形 / 预览小文件 / 向量);旧后端缺省。 */
  derived_pending?: number;
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
  /** R10 U-13:rotation + 像素宽高综合判定的显示方向(核心 `core::orientation`);检查器「方向」用它,不再只看 rotation。 */
  orientation?: ClipOrientation;
  color_transfer?: string | null;
  hdr_flag?: boolean;
  iso_value?: number | null;
  shutter_speed?: string | null;
  aperture?: string | null;
  display_lut_path?: string | null;
  selected_transcribe_track?: number | null;
  selected_monitor_track?: number | null;
  /** `null` = 真实素材;`"minimax"` = MiniMax 云端补镜生成物。 */
  generated_source?: string | null;
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
  /** R11 §1.2:后端算出过建议段(车道 B 提供;缺省 undefined = 不显示角标)。 */
  has_suggestions?: boolean;
  /** Z-07(R14 stress):原片此刻不在原位的时间戳(`clips.missing_since`);媒体池画「缺失」角标。旧后端缺省。 */
  missing_since?: string | null;
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
  | { type: "seek_abs"; seconds: number }
  | { type: "apply_display_lut"; path: string }
  | { type: "clear_display_lut" }
  | { type: "select_audio_track"; stream_index: number }
  | { type: "set_mute"; muted: boolean }
  // Applied automatically by the backend on `player_open` (see
  // `apply_stored_display_prefs` in src-tauri/src/lib.rs) — the frontend
  // does not issue this itself.
  | { type: "set_rotation"; degrees: number | null }
  // R12 §5 真变速:mpv `speed` 属性,原生层夹紧到 0.25–4。
  | { type: "set_speed"; speed: number };

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

export type AudioTrackRoleGuess = "onboard_mic" | "wireless_mic" | "backup" | "unknown";

export interface ClipAudioTrack {
  clip_id: number;
  stream_index: number;
  channels: number | null;
  channel_layout: string | null;
  sample_rate: number | null;
  role_guess: AudioTrackRoleGuess | null;
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
  mode: "legacy" | "narrative" | "template";
  mode_notice: string;
  narrative: NarrativeOverview | null;
  narration_job_status: "pending" | "running" | "done" | "failed" | "blocked" | null;
  current_template: StoryTemplate | null;
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
  template: StoryTemplate | null;
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
  contact_sheet_glyph_fallbacks: number | null;
  /** 联系表渲染成功时损坏/截断而退化成灰框占位的封面张数；联系表被关闭、尚未渲染或渲染失败时是 `null`。 */
  contact_sheet_cover_failures: number | null;
  /** R6 Task 6 G9：参考粗剪目标时长（30/60/180 秒）；`null` 表示完整长度。 */
  rough_cut_target_seconds: number | null;
  /** 参考粗剪实际拼出来的总时长，配合 tb_num/tb_den 换算成秒；粗剪转码完成前是 `null`。 */
  rough_cut_actual_ticks: number | null;
  rough_cut_actual_tb_num: number | null;
  rough_cut_actual_tb_den: number | null;
  /** R10 U-05:本次交付(idle 时 = 将要)用的画布;idle 且解析失败时 `null`。 */
  canvas?: ExportCanvas | null;
  /** R11 车道 E:任务模式(`quick` = 快速导出,`full` = 完整交付包);idle 或旧后端为 null / 缺省。 */
  mode?: "quick" | "full" | "kit" | null;
}

export interface JianyingAvailability {
  installed_version: string | null;
  supported: boolean;
  reason: string;
  /** R14 §9 A(以下四个字段旧后端 / 假后端可能没有,按缺省处理):版本在白名单里。 */
  whitelisted?: boolean;
  /** settings `jianying.human_check.<version>` 的裁定;没记过 = "none"。 */
  human_check?: JianyingHumanCheck;
  /** 白名单 ∪ human_check ok(且草稿根目录在);与 `supported` 同值。 */
  usable?: boolean;
  /** 版本在「待人眼验证」名单里:允许「仍然试着生成(试验)」。未知版本永远 false。 */
  force_allowed?: boolean;
}

export interface JianyingDraftResult {
  status: "created";
  output_path: string;
  draft_name: string;
  jianying_version: string;
  selected_count: number;
  subtitle_count: number;
  /** R14 C-2:写进草稿的章节标记数(每章首镜素材名前缀「【第 n 章·章名】」);0 = 没有章。 */
  chapter_marks: number;
  /** R14 C-3:草稿是否带了配乐轨(本集最近导入的那首音乐)。 */
  has_music: boolean;
  message: string;
  /** R14 §9 A:对「待验证」版本 force 出来的试验草稿,剪映能不能开还要人眼确认。 */
  experimental?: boolean;
  /** 与 `output_path` 同值。 */
  draft_path?: string;
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

// R7 Task 7:「云端补镜（MiniMax）」设置分区。Key 只经 Keychain 往返——
// `setMinimaxKey`/`clearMinimaxKey` 不返回 key 本身,`hasMinimaxKey` 只回答
// 是否已配置,永不回显存的值。
export function setMinimaxKey(key: string): Promise<void> {
  return invoke<void>("set_minimax_key", { key });
}

export function clearMinimaxKey(): Promise<void> {
  return invoke<void>("clear_minimax_key");
}

export function hasMinimaxKey(): Promise<boolean> {
  return invoke<boolean>("has_minimax_key");
}

export interface GenerationAvailability {
  enabled: boolean;
  has_key: boolean;
  budget_remaining_usd: number;
}

export interface GenerationLedgerEntry {
  at: string;
  request_id: number;
  chapter_title: string;
  slot: string;
  seconds: number;
  images: number;
  cost_usd: number;
  model: string;
  resolution: string;
  status: string;
}

export interface GenerationLedgerSummary {
  month: string;
  spent_usd: number;
  budget_usd: number;
  entries: GenerationLedgerEntry[];
}

export function generationAvailability(): Promise<GenerationAvailability> {
  return invoke<GenerationAvailability>("generation_availability");
}

export function generationLedgerSummary(): Promise<GenerationLedgerSummary> {
  return invoke<GenerationLedgerSummary>("generation_ledger_summary");
}

export function describeClipWithAi(clipId: number): Promise<AiDescriptionResult> {
  return invoke<AiDescriptionResult>("describe_clip_with_ai", { clipId });
}

export function getAiDescription(clipId: number): Promise<AiDescriptionResult | null> {
  return invoke<AiDescriptionResult | null>("get_ai_description", { clipId });
}

/**
 * R18 AI-A1:本地生成的素材描述(画面标签 + 画面文字 + 对白拼出来的一句话)。
 * 不调模型、不联网、不花预算 —— 云端描述没有或没开时,检查器显示这一句。
 */
export function getClipBrief(clipId: number): Promise<string | null> {
  return invoke<string | null>("get_clip_brief", { clipId });
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

export function importPaths(paths: string[]): Promise<ImportStart[]> {
  return invoke<ImportStart[]>("import_paths", { paths });
}

export function getImportProgress(): Promise<ImportProgress> {
  return invoke<ImportProgress>("get_import_progress");
}

export interface MissingClip {
  clip_id: number;
  file_name: string;
  volume_uuid: string;
  volume_label: string | null;
  rel_path: string;
  missing_since: string;
}

export interface RelinkOutcome {
  relinked: number;
  rejected: string[];
  still_missing: number;
}

export function listMissingClips(): Promise<MissingClip[]> {
  return invoke<MissingClip[]>("list_missing_clips");
}

export function pickRelinkFolder(): Promise<string | null> {
  return invoke<string | null>("pick_relink_folder");
}

export function relinkVolume(volumeUuid: string, newMount: string): Promise<RelinkOutcome> {
  return invoke<RelinkOutcome>("relink_volume", { volumeUuid, newMount });
}

export function listClips(): Promise<ClipListItem[]> {
  return invoke<ClipListItem[]>("list_clips");
}

/** `listClips` 的廉价前哨:轮询前先比这个字符串,不变就跳过整表拉取。 */
export function getClipsRevision(): Promise<string> {
  return invoke<string>("get_clips_revision");
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

export function probeAudioTracks(clipId: number): Promise<ClipAudioTrack[]> {
  return invoke<ClipAudioTrack[]>("probe_audio_tracks", { clipId });
}

export function listAudioTracks(clipId: number): Promise<ClipAudioTrack[]> {
  return invoke<ClipAudioTrack[]>("list_audio_tracks", { clipId });
}

export type DisplayLutScope = "clip" | "episode";

/// Preview-only display LUT. `scope: "clip"` takes a clip id as `targetId`;
/// `scope: "episode"` takes an episode id and writes every clip of it.
/// Never affects proxy generation or exported/delivered files.
export function setDisplayLut(
  scope: DisplayLutScope,
  targetId: number,
  path: string,
): Promise<void> {
  return invoke<void>("set_display_lut", { scope, targetId, path });
}

export function clearDisplayLut(scope: DisplayLutScope, targetId: number): Promise<void> {
  return invoke<void>("clear_display_lut", { scope, targetId });
}

export function setPlaybackTrack(clipId: number, streamIndex: number): Promise<void> {
  return invoke<void>("set_playback_track", { clipId, streamIndex });
}

export function setTranscribeTrack(clipId: number, streamIndex: number): Promise<void> {
  return invoke<void>("set_transcribe_track", { clipId, streamIndex });
}

/// Absolute paths of every `.cube` file under the app's `luts/` support
/// directory (created on first call if missing).
export function listDisplayLuts(): Promise<string[]> {
  return invoke<string[]>("list_display_luts");
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

export interface JourneyEntry {
  kind: "clip" | "destination";
  canonical_time: string;
  undated: boolean;
  clip_id: number | null;
  file_name: string | null;
  cover_url: string | null;
  destination_id: number | null;
  title: string | null;
  place_name: string | null;
}

export function getJourneyTimeline(): Promise<JourneyEntry[]> {
  return invoke<JourneyEntry[]>("get_journey_timeline");
}

export type StoryTemplate = "cinematic" | "fastcut" | "ambient" | "diary";

export interface StoryTemplateInfo {
  id: StoryTemplate;
  name_zh: string;
  blurb_zh: string;
}

export function listStoryTemplates(): Promise<StoryTemplateInfo[]> {
  return invoke<StoryTemplateInfo[]>("list_story_templates");
}

/**
 * job id 和 revision id 是两个不同的整数空间，不能互认——kind 就是用来区分它们的。
 * 启用 LLM 时排队一个任务（kind: "job"）；未启用时后端同步跑模板兜底并落地一版
 * suggested revision（kind: "revision"）。
 */
export type EnqueueOutcome = { kind: "job"; id: number } | { kind: "revision"; id: number };

export function enqueueNarrateEpisode(template?: StoryTemplate): Promise<EnqueueOutcome> {
  return invoke<EnqueueOutcome>("enqueue_narrate_episode", { template: template ?? null });
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

export function undoStoryChange(): Promise<UndoStoryOutcome> {
  return invoke<UndoStoryOutcome>("undo_story_change");
}

export function pickExportFolder(): Promise<string | null> {
  return invoke<string | null>("pick_export_folder");
}

/** 参考粗剪目标时长，秒；`undefined`/省略表示完整长度。 */
export type RoughCutTargetSeconds = 30 | 60 | 180;

export function startExport(
  dest: string,
  overridePlatform?: TargetPlatform,
  includeContactSheet = true,
  targetSeconds?: RoughCutTargetSeconds,
): Promise<ExportStatus> {
  return invoke<ExportStatus>("start_export", {
    dest,
    overridePlatform,
    includeContactSheet,
    targetSeconds,
  });
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

export function restoreSelectSegment(segmentId: number): Promise<void> {
  return invoke<void>("restore_select_segment", { segmentId });
}

export function playerSetViewport(viewport: PlayerViewport): Promise<void> {
  return invoke<void>("player_set_viewport", { viewport });
}

/**
 * 覆盖层(popover / 抽屉 / 命令面板 / 帮助)开合时藏起或恢复原生视频视图。
 * 原生 NSView 永远画在 WKWebView 之上,不藏就会盖住覆盖层;播放状态不动。
 */
export function playerSetOccluded(occluded: boolean): Promise<void> {
  return invoke<void>("player_set_occluded", { occluded });
}

export function playerOpen(clipId: number): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_open", { clipId });
}

export function playerClose(): Promise<void> {
  return invoke<void>("player_close");
}

/** R17 playfix:错误文本与 Rust `player::STALE_CLIP_COMMAND` 一致;命中即静默,不算播放器故障。 */
export const STALE_CLIP_COMMAND = "命令属于已换掉的素材";

/** `clipId` 是这条命令所属的素材;换源窗口里排到新实例上的旧素材命令会被后端拒掉。 */
export function playerCommand(cmd: PlayerCommand, clipId?: number | null): Promise<void> {
  return invoke<void>("player_command", { cmd, clipId: clipId ?? null });
}

export function playerStatus(): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_status");
}

/** R12 §5:`player_command` 的 `set_speed` 直呼版本;监视器走通道发命令,这条留给别的调用方。 */
export function playerSetSpeed(speed: number): Promise<void> {
  return invoke<void>("player_set_speed", { speed });
}

export type TargetPlatform = "douyin" | "xiaohongshu" | "bilibili" | "moments" | "family" | "general";
export type CanvasOrientation = "landscape" | "portrait" | "both";

export interface PlatformPreset {
  platform: TargetPlatform;
  display_name: string;
  portrait: [number, number];
  landscape: [number, number];
  duration_budget_ticks: number;
  tb_num: number;
  tb_den: number;
  subtitle_style: Record<string, unknown>;
  /** R10 U-05(迁移 0042):平台习惯的画布方向;`auto` = 跟随本集素材多数方向。 */
  default_orientation?: PresetDefaultOrientation;
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
  target_platform: TargetPlatform;
  canvas_orientation: CanvasOrientation;
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

export async function archiveCurrentEpisode(
  nextTitle: string | null,
  nextPlatform?: TargetPlatform | null,
  nextOrientation?: CanvasOrientation | null,
): Promise<ArchiveOutcome> {
  return invoke<ArchiveOutcome>("archive_current_episode", {
    nextTitle,
    nextPlatform: nextPlatform ?? null,
    nextOrientation: nextOrientation ?? null,
  });
}

export function listPlatformPresets(): Promise<PlatformPreset[]> {
  return invoke<PlatformPreset[]>("list_platform_presets");
}

export function setEpisodePlatform(
  episodeId: number,
  platform: TargetPlatform,
  orientation: CanvasOrientation,
): Promise<void> {
  return invoke<void>("set_episode_platform", { episodeId, platform, orientation });
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

export interface GenerationRequestSummary {
  id: number;
  status: "draft" | "submitted" | "queued" | "succeeded" | "failed" | "cancelled" | "imported";
  error: string | null;
  estimated_cost_usd: number;
  actual_cost_usd: number | null;
  result_clip_id: number | null;
}

export interface StoryGap {
  id: number;
  /** `narrative_chapters.id`(叙事章)——不是镜头带的 D2 `chapters.id`,两者相等只是巧合。 */
  chapter_id: number;
  /** R10:这个缺口应挂在镜头带的哪一章(D2 `chapters.id`,按 beats 素材的 chapter_id 多数决);没 beat / 素材未分章时 null。带上匹配用它。 */
  band_chapter_id?: number | null;
  chapter_title: string;
  beat_id: number | null;
  slot: string;
  slot_label_zh: string;
  reason: string;
  status: "open" | "requested" | "filled" | "dismissed";
  latest_request: GenerationRequestSummary | null;
}

export async function listStoryGaps(): Promise<StoryGap[]> {
  return invoke<StoryGap[]>("list_story_gaps");
}

export async function detectStoryGaps(): Promise<number> {
  return invoke<number>("detect_story_gaps");
}

export async function dismissStoryGap(gapId: number): Promise<void> {
  return invoke<void>("dismiss_story_gap", { gapId });
}

export async function reopenStoryGap(gapId: number): Promise<void> {
  return invoke<void>("reopen_story_gap", { gapId });
}

export interface GenerationDraftPreview {
  mode: "t2v" | "i2v" | "fl2v" | "r2v";
  model: "MiniMax-H3" | "MiniMax-H3-Max";
  resolution: "480P" | "768P" | "2K";
  duration_s: number;
  ratio: string;
  prompt: string;
  refs: { path: string; role: string; preview_url: string | null }[];
  estimated_cost_usd: number;
  notes: string[];
}

export interface GenerationOverrides {
  prompt?: string;
  model?: string;
  resolution?: string;
  duration_s?: number;
}

export async function previewGeneration(
  gapId: number,
  overrides: GenerationOverrides,
): Promise<GenerationDraftPreview> {
  return invoke<GenerationDraftPreview>("preview_generation", { gapId, overrides });
}

export async function submitGeneration(
  gapId: number,
  overrides: GenerationOverrides,
): Promise<GenerationRequestSummary> {
  return invoke<GenerationRequestSummary>("submit_generation", { gapId, overrides });
}

export async function retryGeneration(requestId: number): Promise<GenerationRequestSummary> {
  return invoke<GenerationRequestSummary>("retry_generation", { requestId });
}

export async function cancelGeneration(requestId: number): Promise<void> {
  return invoke<void>("cancel_generation", { requestId });
}

export async function listGenerationRequests(): Promise<GenerationRequestSummary[]> {
  return invoke<GenerationRequestSummary[]>("list_generation_requests");
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
  kind: "file" | "transcript" | "description" | "dimension" | "ocr" | "pinyin";
  clip_id: number;
  file_name: string;
  excerpt: string;
  episode_id: number | null;
}

export async function searchEverything(query: string): Promise<GlobalSearchHit[]> {
  return invoke<GlobalSearchHit[]>("search_everything", { query });
}

export interface OcrTextHit {
  frame_tick: number;
  tb_num: number;
  tb_den: number;
  text: string;
  confidence: number;
  bbox: [number, number, number, number];
}

export function listOcrHits(clipId: number): Promise<OcrTextHit[]> {
  return invoke<OcrTextHit[]>("list_ocr_hits", { clipId });
}

export function enqueueOcrForEpisode(): Promise<number> {
  return invoke<number>("enqueue_ocr_for_episode");
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
  has_previous: boolean;
  previous_version: string | null;
  recovered_from_rolling: boolean;
  /** R10 U-24:只有 `whisper-model` 填——官方下载地址(Hugging Face ggerganov/whisper.cpp)。 */
  download_url?: string | null;
  /** 期望 SHA-256(小写十六进制),供用户核验或界面展示。 */
  expected_sha256?: string | null;
  /** 模型应放到的完整目标路径。 */
  target_path?: string | null;
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

export async function rollbackComponent(component: string): Promise<ComponentStatus> {
  return invoke<ComponentStatus>("rollback_component", { component });
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

export interface LibraryRegistry {
  active: string;
  libraries: { id: string; name: string; hidden: boolean }[];
}
export const listLibraries = () => invoke<LibraryRegistry>("list_libraries");
export const createLibrary = (name: string) => invoke<LibraryRegistry>("create_library", { name });
export const setLibraryHidden = (id: string, hidden: boolean) => invoke<LibraryRegistry>("set_library_hidden", { id, hidden });
export const switchLibrary = (id: string) => invoke<void>("switch_library", { id });

export interface ImportBatch {
  id: number; source: string; status: string; total: number; done: number;
  running: number; failed: number; duplicates: number; imported: number;
}
export interface RemovalRequest { batch_id: number | null; clip_ids: number[]; all: boolean }
export interface RemovalPreview { clips: number; favorites: number; selections: number; cache_entries: number }
export const listImportBatches = () => invoke<ImportBatch[]>("list_import_batches");
export const cancelImportBatch = (id: number) => invoke<void>("cancel_import_batch", { id });
export const dismissImportNotices = () => invoke<number>("dismiss_import_notices");
export const previewImportRemoval = (request: RemovalRequest) => invoke<RemovalPreview>("preview_import_removal", { request });
export const removeImportedMaterial = (request: RemovalRequest) => invoke<number>("remove_imported_material", { request });

export type MusicSectionLabel = "intro" | "verse" | "build" | "climax" | "outro" | "other";

export interface MusicTrackSummary {
  id: number;
  episode_id: number;
  file_name: string;
  rel_path: string;
  quick_hash: string | null;
  duration_ticks: number | null;
  tb_num: number;
  tb_den: number;
  bpm: number | null;
  analysis_status: "pending" | "running" | "done" | "failed";
  blocked_summary?: string | null;
  created_at: string;
}

export interface MusicBeat {
  tick: number;
  is_downbeat: boolean;
  strength: number | null;
}

export interface MusicSection {
  start_tick: number;
  end_tick: number;
  label: MusicSectionLabel;
  energy: number | null;
}

export interface MusicAnalysis {
  track: MusicTrackSummary;
  beats: MusicBeat[];
  sections: MusicSection[];
  suggested_cut_ticks: number[];
}

export const pickMusicFile = () => invoke<string | null>("pick_music_file");
export const importMusicTrack = (path: string) =>
  invoke<MusicTrackSummary>("import_music_track", { path });
export const listMusicTracks = (episodeId: number) =>
  invoke<MusicTrackSummary[]>("list_music_tracks", { episodeId });
export const getMusicAnalysis = (trackId: number) =>
  invoke<MusicAnalysis>("get_music_analysis", { trackId });
export const deleteMusicTrack = (trackId: number) =>
  invoke<void>("delete_music_track", { trackId });

// ---------------------------------------------------------------------------
// R10 车道 B(Rust 核心)追加的类型与命令。上面的接口只插了可选字段,这里放新命令。
// ---------------------------------------------------------------------------

/** R10 U-13:素材显示方向。`square` 显示宽高相等;`unknown` 没有尺寸。 */
export type ClipOrientation = "landscape" | "portrait" | "square" | "unknown";

/** R10 U-05:平台预设的默认画布方向。 */
export type PresetDefaultOrientation = "landscape" | "portrait" | "auto";

/** 交付画布方向来源:抽屉手动切(override)> 集明确选过(episode)> 平台习惯(preset)> 素材多数(clips)> 横版兜底(fallback)。 */
export type CanvasOrientationSource = "override" | "episode" | "preset" | "clips" | "fallback";

export interface ExportCanvas {
  platform: TargetPlatform;
  display_name: string;
  orientation: "portrait" | "landscape";
  orientation_source: CanvasOrientationSource;
  width: number;
  height: number;
}

/** R10 U-05:交付抽屉预览「画布 W×H」——按将要传给 startExport 的平台/方向解析,不建任务。 */
export function previewExportCanvas(
  overridePlatform: TargetPlatform | null,
  overrideOrientation: "portrait" | "landscape" | null = null,
): Promise<ExportCanvas> {
  return invoke<ExportCanvas>("preview_export_canvas", { overridePlatform, overrideOrientation });
}

/**
 * R10 U-05:`startExport` + 本次交付手动指定的画布方向(`null` = 按预设/集/素材自动)。
 * 与 `startExport` 是同一条后端命令(`start_export` 多了可选的 overrideOrientation)。
 */
export function startExportWithCanvas(
  dest: string,
  overridePlatform: TargetPlatform | null,
  overrideOrientation: "portrait" | "landscape" | null,
  includeContactSheet: boolean,
  targetSeconds: RoughCutTargetSeconds | null,
): Promise<ExportStatus> {
  return invoke<ExportStatus>("start_export", {
    dest,
    overridePlatform,
    overrideOrientation,
    includeContactSheet,
    targetSeconds,
  });
}

/** R10 U-16:新建集的结果。 */
export interface CreateEpisodeOutcome {
  /** 新的进行中集(reused_empty 时是被改名的原空集)。 */
  episode: EpisodeSummary;
  /** 当前集本来就是空的,被就地改名复用(没有封存任何东西,id 不变)。 */
  reused_empty: boolean;
  /** 被封存的前一集;reused_empty 时为 null。 */
  archived: EpisodeSummary | null;
}

/**
 * R10 U-16:新建集(名称必填,1–120 字)。集模型「任意时刻恰好一个进行中」,所以当前集有素材时
 * = 封存当前集 + 开新集并切换过去(平台/朝向继承);当前集为空时就地改名复用。
 * 调用方拿到结果后请派发 `tripcut:episode-changed`,与封存后的做法一致。
 */
export async function createEpisode(title: string): Promise<CreateEpisodeOutcome> {
  return invoke<CreateEpisodeOutcome>("create_episode", { title });
}

/** R10 U-19:音乐分析落到终态(done/failed)时后端发出的事件负载;`bpm` 只在 done 时非空。 */
export interface MusicAnalyzedEvent {
  track_id: number;
  episode_id: number;
  analysis_status: "done" | "failed";
  bpm: number | null;
}

/** R10 U-19:后端 Tauri 事件名;前端 DOM 侧同名 CustomEvent 由 `bridgeMusicAnalyzedEvents` 转发。 */
export const MUSIC_ANALYZED_EVENT = "tripcut:music-analyzed";

/** R10 U-19:状态条「音乐分析」计数——当前集音乐轨按 analysis_status 分桶。 */
export interface MusicAnalysisProgress {
  total: number;
  done: number;
  failed: number;
  running: number;
  pending: number;
}

export function getMusicAnalysisProgress(): Promise<MusicAnalysisProgress> {
  return invoke<MusicAnalysisProgress>("get_music_analysis_progress");
}

/**
 * R10 U-19:把后端的 `tripcut:music-analyzed` Tauri 事件转发成同名 `window` CustomEvent
 * (`detail` = MusicAnalyzedEvent),沿用工作区现有的 `tripcut:*` DOM 事件约定——
 * 音乐面板 / 状态条只需 `window.addEventListener(MUSIC_ANALYZED_EVENT, …)`。
 * 在壳层挂一次即可;返回解除函数。非 Tauri 环境(vitest / `vite --mode mock`)里
 * `listen` 会失败,此时静默退化为 no-op(不抛)。
 */
export async function bridgeMusicAnalyzedEvents(): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<MusicAnalyzedEvent>(MUSIC_ANALYZED_EVENT, (event) => {
      window.dispatchEvent(new CustomEvent<MusicAnalyzedEvent>(MUSIC_ANALYZED_EVENT, { detail: event.payload }));
    });
    return unlisten;
  } catch {
    return () => undefined;
  }
}

/** X-04:每条 import_probe 落到终态时后端发的事件名(Rust `core::jobs::IMPORT_PROBE_DONE_EVENT`)。 */
export const IMPORT_PROBE_DONE_EVENT = "tripcut:import-probe-done";

export interface ImportProbeDoneEvent {
  job_id: number;
  status: "done" | "failed" | "blocked";
}

/**
 * X-04:把 `tripcut:import-probe-done` Tauri 事件转发成同名 window CustomEvent,状态条按单条完成
 * 即时刷新计数(剩余时间估算要连续样本,3 秒一次的轮询在短片段上只看到整批跳变)。
 * 与 `bridgeMusicAnalyzedEvents` 同一套约定;非 Tauri 环境静默退化为 no-op。
 */
export async function bridgeImportProbeEvents(): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<ImportProbeDoneEvent>(IMPORT_PROBE_DONE_EVENT, (event) => {
      window.dispatchEvent(new CustomEvent<ImportProbeDoneEvent>(IMPORT_PROBE_DONE_EVENT, { detail: event.payload }));
    });
  } catch {
    return () => undefined;
  }
}

/** R10 U-22:首启引导「已跳过 / 已完成」持久化(settings `onboarding.first_run_done`,默认 false)。 */
export function getFirstRunDone(): Promise<boolean> {
  return invoke<boolean>("get_first_run_done");
}

/** 用户点「暂时进入」或走完引导时调一次;之后首启引导不再弹,恢复页也不重放。 */
export function setFirstRunDone(done = true): Promise<void> {
  return invoke<void>("set_first_run_done", { done });
}

/** R10 U-24:`importWhisperModel` 的结果。 */
export interface WhisperModelImportOutcome {
  /** 按文件 SHA-256 识别出的模型档(档由摘要决定,不由文件名决定)。 */
  tier: "large-v3-turbo" | "small";
  file_name: string;
  target_path: string;
  sha256: string;
  /** 导入的档是否就是设置里当前选的档;false 时可提示用 setSetting("tools.whisper_model_tier", tier) 切换。 */
  matches_active_tier: boolean;
}

/**
 * R10 U-24:「导入模型文件…」——校验 SHA-256(必须命中官方摘要之一)后复制进 models 目录,
 * 源文件不动;摘要不匹配则拒绝并在错误信息里列出期望值。大文件算摘要要几秒,await 期间请给忙态。
 */
export async function importWhisperModel(path: string): Promise<WhisperModelImportOutcome> {
  return invoke<WhisperModelImportOutcome>("import_whisper_model", { path });
}

/**
 * R10 U-28:「添加 LUT…」——把用户选中的 `.cube` 复制进 `<应用支持目录>/luts/`,返回复制后的
 * 完整列表(与 `listDisplayLuts` 同形)。后端校验扩展名 / 非空 ≤ 64 MB / 文件头 LUT_3D_SIZE|LUT_1D_SIZE;
 * 同名不同内容会拒绝(错误信息含「同名」),同名同内容视为已导入。文件选择用 rfd(`pick_*`)
 * 或 `@tauri-apps/plugin-dialog`,本命令只收路径。
 */
export function importLut(path: string): Promise<string[]> {
  return invoke<string[]>("import_lut", { path });
}

/** R10 U-24:「导入模型文件…」的系统文件选择(rfd);取消返回 null。 */
export const pickWhisperModelFile = () => invoke<string | null>("pick_whisper_model_file");

/** R10 U-28:「添加 LUT…」的系统文件选择(rfd,.cube);取消返回 null。 */
export const pickLutFile = () => invoke<string | null>("pick_lut_file");

// ---------------------------------------------------------------------------
// R11 车道 B:时刻分与自动挑选(Rust `core::moments` / `core::smart_select`)
// ---------------------------------------------------------------------------

/** 一个 0.5 s 窗口的时刻分;热力条用 `get_clip_moments`(已降采样到 ≤200 点)。 */
export interface Moment {
  clip_id: number;
  win_index: number;
  t_start_ticks: number;
  t_end_ticks: number;
  /** 0–1,越大越清晰。 */
  sharp: number;
  /** 0–1,画面运动量;「运动适中」由打分判。 */
  motion: number;
  exposure_ok: boolean;
  loud: boolean;
  speech: boolean;
  scene_cut: boolean;
  /** 0–1 综合分。 */
  score: number;
  /** 给人看的中文原因:「清晰」「运动适中」「曝光正常」「有人声」「有声音」。 */
  reasons: string[];
}

/** 建议段(源 time_base 的 tick;换算用素材的 tb_num/tb_den)。 */
export interface SegmentSuggestion {
  in_ticks: number;
  out_ticks: number;
  score: number;
  reasons: string[];
}

/**
 * 自动挑选范围;不传 = `favorites_or_rated3` = 收藏 ∪ ≥3 星(新手缺省)。
 * `rated3` 在 Rust 里是**纯** ≥3 星 —— 标签写「收藏 + 3 星以上」的 chip 必须发并集(V-02)。
 */
export type AutoSelectScope = "favorites_or_rated3" | "favorites" | "rated3" | "all";

export interface AutoSelectOutcome {
  /** 新建的精选段 id(`segments.source = 'auto'`)。 */
  created: number[];
  total_secs: number;
  chapters_covered: number;
  /** 传给 `undoAutoSelect` 一键撤销整批。 */
  batch_id: string;
  /** R12:挑完默认已排进镜头带的段数;旧后端没有这个字段。 */
  placed?: number;
  /** 排入那一批的批号(`undoArrange` 用);没排进任何段时为 null。 */
  arrange_batch_id?: string | null;
  /** X-01:实际用的范围;旧后端没有这个字段。 */
  scope_used?: AutoSelectScope;
  /** X-01:默认范围「收藏 + 3 星以上」一条候选都没有、后端自动改按「全部」挑了 —— toast 要说出来。 */
  fell_back?: boolean;
}

/** 状态条「补齐时刻分 n/m」:当前集已分析素材里有/没有时刻分的数量与任务状态。 */
export interface MomentsProgress {
  total: number;
  done: number;
  failed: number;
  running: number;
  pending: number;
}

export function getClipMoments(clipId: number): Promise<Moment[]> {
  return invoke<Moment[]>("get_clip_moments", { clipId });
}

/** 建议段,≤3 条,按分数降序;`targetSecs` 不传按本集平台预算取 4–8 s。 */
export function suggestSegments(clipId: number, targetSecs?: number): Promise<SegmentSuggestion[]> {
  return invoke<SegmentSuggestion[]>("suggest_segments", { clipId, targetSecs: targetSecs ?? null });
}

/** 自动挑选整集精选段;`budgetSecs` 不传按平台预算(不限时长的平台按 60 s)。 */
export function autoSelectEpisode(options: { budgetSecs?: number; scope?: AutoSelectScope } = {}): Promise<AutoSelectOutcome> {
  return invoke<AutoSelectOutcome>("auto_select_episode", {
    budgetSecs: options.budgetSecs ?? null,
    scope: options.scope ?? null,
  });
}

/** 撤销一批自动挑选(只删该批 `source='auto'` 的段),返回删掉的条数。 */
export function undoAutoSelect(batchId: string): Promise<number> {
  return invoke<number>("undo_auto_select", { batchId });
}

export function getMomentsProgress(): Promise<MomentsProgress> {
  return invoke<MomentsProgress>("get_moments_progress");
}

/** 手动重跑「补齐时刻分」(失败后重试),返回新排队的条数。 */
export function enqueueMomentsBackfill(): Promise<number> {
  return invoke<number>("enqueue_moments_backfill");
}

/** 车道 C 先行用的别名;真身是车道 B 的 `Moment`(多出的字段无害)。 */
export type ClipMoment = Moment;
// ---------- R11 车道 E:快速导出 ----------

/** 只导这些段 / 素材;两项都不给 = 本集全部精选段 + 收藏。`clip_ids` 命中该素材名下的全部精选段(没有精选段时是它的整条收藏)。 */
export interface QuickExportSelection {
  segment_ids?: number[];
  clip_ids?: number[];
  /** Z-11(R14 stress):「只重试失败的」时上一次作业的 id —— 后端写回同一个文件夹、沿用原编号、跳过已导好的。 */
  retry_of_job_id?: number;
}

/** `quickExport` / `planQuickExport` 的结果:`job_id` 只在真的排了任务时有值;`dir` 是将写的文件夹(给了目标目录是全路径,否则只有文件夹名)。 */
export interface QuickExportOutcome {
  job_id: number | null;
  dir: string;
  files: string[];
  skipped: { reason: string }[];
  /** Z-07(R14 stress):原片此刻不在原位的文件名;非空时后端会拒绝导出,抽屉给「去缺失素材页重新定位」。旧后端缺省。 */
  missing?: string[];
}

/** `quickExport` 的错误文本含这个词 = 目标目录不存在 / 不可写,前端回落到保存面板;别的失败不带它。 */
export const QUICK_EXPORT_DEST_UNAVAILABLE = "dest_unavailable";

/** 快速导出:只 remux 精选段与整条收藏到 `destDir/<集名>_导出_<日期>`(同名 `-2`),不出粗剪 / 镜头表 / 联系表。进度走 `getExportStatus`(`mode = "quick"`)。 */
export function quickExport(destDir: string, selection?: QuickExportSelection | null): Promise<QuickExportOutcome> {
  return invoke<QuickExportOutcome>("quick_export", { destDir, selection: selection ?? null });
}

/** 只算不排:快速导出将写的文件夹与文件清单(交付抽屉快速模式的清单读它)。 */
export function planQuickExport(destDir: string | null, selection?: QuickExportSelection | null): Promise<QuickExportOutcome> {
  return invoke<QuickExportOutcome>("plan_quick_export", { destDir, selection: selection ?? null });
}

// ---------- R12 车道 B:挑选 → 排列联动 ----------

/** `arrangeSelectedSegments` 的结果:`placed` 是这次真正新排进镜头带的段数(已在带上的不算)。 */
export interface ArrangeOutcome {
  placed: number;
  /** 本批覆盖的章数(未分章的段算一桶)。 */
  chapters: number;
  /** 传给 `undoArrange` 只撤这一批。 */
  batch_id: string;
}

/**
 * 「一键排入」:本集全部精选段(手打 + 自动挑选)按章节写进镜头带(素材有章按章、没章按拍摄时间)。
 * `append`(默认)只补没在带上的段;`replace` 先清掉带上所有镜头再全量排入。
 */
export function arrangeSelectedSegments(mode: "append" | "replace" = "append"): Promise<ArrangeOutcome> {
  return invoke<ArrangeOutcome>("arrange_selected_segments", { mode });
}

/** 只撤一批排入(本批新写的镜头拿掉,之前就在带上的回原位),返回撤掉的条数。 */
export function undoArrange(batchId: string): Promise<number> {
  return invoke<number>("undo_arrange", { batchId });
}

/** 「这章够了」:把一章标成跳过(不算缺口)/ 取消跳过。持久化在 settings 键 `story.chapter_skipped.<id>`。 */
export function skipChapter(chapterId: number, skipped: boolean): Promise<void> {
  return invoke<void>("skip_chapter", { chapterId, skipped });
}

/** settings 里「这章够了」的键前缀;值 "true" = 跳过。 */
export const CHAPTER_SKIPPED_PREFIX = "story.chapter_skipped.";

/** R13 §5:剪映专业版(macOS)的 bundle id;`open_app` 只认这一个。 */
export const JIANYING_BUNDLE_ID = "com.lemon.lvpro";

/** 打开一个本机应用(按 bundle id;后端白名单只放行剪映)。装没装由 `open` 说了算,没装会 reject。 */
export function openApp(bundleId: string): Promise<void> {
  return invoke<void>("open_app", { bundleId });
}

/** R14 §9 A:业主在剪映里开过试验草稿之后的裁定。 */
export type JianyingHumanCheck = "none" | "ok" | "fail";

/** 「我知道风险,仍然试着生成(试验)」:后端只对待验证名单里的版本放行,未知版本仍 reject。 */
export function generateJianyingDraftForced(): Promise<JianyingDraftResult> {
  return invoke<JianyingDraftResult>("generate_jianying_draft", { force: true });
}

/** 「可以用」/「打不开」落到 settings `jianying.human_check.<version>`;回新的可用性。 */
export function setJianyingHumanCheck(version: string, verdict: "ok" | "fail"): Promise<JianyingAvailability> {
  return invoke<JianyingAvailability>("set_jianying_human_check", { version, verdict });
}

/**
 * R13 真机 Y-08:快速导出(导出片段)自己的文件夹面板 —— 标题「选择导出文件夹」,
 * 交付包的 `pickExportFolder`(「选择交付包保存位置」)不动。同一条 Rust 命令,只是换标题。
 */
export function pickQuickExportFolder(): Promise<string | null> {
  return invoke<string | null>("pick_export_folder", { title: "选择导出文件夹" });
}

// ---------- R14 车道 B:剪映素材包 ----------

/** `exportJianyingKit` / `planJianyingKit` 的结果:`files` 按镜头带顺序编号(`NN_<章名>_<素材名>.mp4`),`order_file` 是顺序清单的文件名(「顺序.txt」)。 */
export interface KitExportOutcome {
  job_id: number | null;
  dir: string;
  files: string[];
  order_file: string;
  /** Z-07(R14 stress):同 `QuickExportOutcome.missing`。 */
  missing?: string[];
}

/** 剪映素材包:按镜头带顺序把每个镜导出到 `destDir/<集名>_剪映素材包_<日期>`(同名 `-2`)+ 顺序.txt。`destDir` 缺省用记住的文件夹;没记过 / 用不了时错误文本含 `dest_unavailable`。进度走 `getExportStatus`(`mode = "kit"`)。 */
export function exportJianyingKit(destDir?: string | null): Promise<KitExportOutcome> {
  return invoke<KitExportOutcome>("export_jianying_kit", { destDir: destDir ?? null });
}

/** 只算不排:素材包将写的文件夹与编号清单。 */
export function planJianyingKit(destDir?: string | null): Promise<KitExportOutcome> {
  return invoke<KitExportOutcome>("plan_jianying_kit", { destDir: destDir ?? null });
}

/** Z-14(R14 stress):只读查看已封存集时按被查看的集取镜头带;`null` = 当前集(与 `getStoryboard()` 同义)。 */
export function getStoryboardOf(episodeId: number | null): Promise<Storyboard> {
  return invoke<Storyboard>("get_storyboard", { episodeId });
}

/** Z-14(R14 stress):只读查看已封存集时按被查看的集列缺口;`null` = 当前集。 */
export function listStoryGapsOf(episodeId: number | null): Promise<StoryGap[]> {
  return invoke<StoryGap[]>("list_story_gaps", { episodeId });
}

/** R15:「删除这一集」的结果。 */
export interface DeleteEpisodeOutcome {
  /** 被删掉的集(删除前的信息)。 */
  deleted: EpisodeSummary;
  /** 删完之后进行中的集:删历史集则原样;删当前集则回退到最近剩下的一集,一集都不剩就是新种的空集。 */
  active: EpisodeSummary;
  /** `active` 是这次新种出来的空集。 */
  created_fresh: boolean;
  /** 随集一起删掉的素材条数(原片不动)。 */
  removed_clips: number;
}

/**
 * R15:删除一集 —— 历史集或当前集都行。这一集的素材记录、收藏、片段、顺序、任务一起删;
 * 原片不动;缓存文件在后台清理。调用方拿到结果后请派发 `tripcut:episode-changed`(带 `active`)。
 */
export function deleteEpisode(episodeId: number): Promise<DeleteEpisodeOutcome> {
  return invoke<DeleteEpisodeOutcome>("delete_episode", { episodeId });
}

/** R15:「重置项目库」的结果。 */
export interface ResetLibraryResult {
  removed_clips: number;
  removed_episodes: number;
  removed_disk_bytes: number;
}

/**
 * R15:重置项目库 —— 清空素材、集、片段、收藏、任务、导入记录和缓存,只留设置 / 键位 / 引导。
 * 后端先打一份数据库快照(恢复页「从快照恢复」可以退回)。调用方随后应回到首页并派发
 * `tripcut:episode-changed`。
 */
export function resetProjectLibrary(): Promise<ResetLibraryResult> {
  return invoke<ResetLibraryResult>("reset_project_library");
}

/** R15:恢复页上的「重置项目库」(同一件事,走恢复页的运行时状态)。 */
export function resetRecoveryLibrary(): Promise<ResetLibraryResult> {
  return invoke<ResetLibraryResult>("reset_recovery_library");
}

/* ---- R16 车道 B:章节与批量(只追加) ---- */

/** 「删除这一章…」:镜移到相邻章(先上一章,没有就下一章),返回镜移去的章 id;`undoStoryChange` 可撤。 */
export function deleteChapter(chapterId: number): Promise<number> {
  return invoke<number>("delete_chapter", { chapterId });
}

/** 批量评级的一条(与 `rateClip` 的三个参数同义;清除 = 同一 clip 的 `binary 0` + `star 0` 两条)。 */
export interface ClipRatingEntry {
  clip_id: number;
  rating_type: RatingType;
  value: number;
}

/** R16 P1-5:一次 IPC 写入多条评级(多选热键 / 菜单「收藏 / 拒绝 / 清除评级(n 条)」/ 撤销回写旧值);任何一条无效整批不写。 */
export function rateClips(entries: ClipRatingEntry[]): Promise<ClipRating[]> {
  return invoke<ClipRating[]>("rate_clips", { entries });
}

/** R16 P2-3:任意一集改名(封存后也能改);校验与 `renameCurrentEpisode` 相同。 */
export async function renameEpisode(episodeId: number, title: string, theme: string): Promise<EpisodeSummary> {
  return invoke<EpisodeSummary>("rename_episode", { episodeId, title, theme });
}

// ---------------------------------------------------------------------------
// R16 车道 C:新 Rust 命令(只追加)。
// ---------------------------------------------------------------------------

/** P1-7:单条重新定位的结果。 */
export interface RelinkClipOutcome {
  clip_id: number;
  file_name: string;
  volume_uuid: string;
}

/** P1-7:「找到它…」的文件面板(标题带原片文件名);取消返回 null。 */
export function pickRelinkFile(fileName: string): Promise<string | null> {
  return invoke<string | null>("pick_relink_file", { fileName });
}

/** P1-7:把一条缺失素材指向用户选中的同名文件(后端校验同名 + 时长 ±0.5 s)。 */
export function relinkClip(clipId: number, path: string): Promise<RelinkClipOutcome> {
  return invoke<RelinkClipOutcome>("relink_clip", { clipId, path });
}

/** P1-6:导入抽屉「后台任务」页的一行(正在跑的任务)。 */
export interface RunningJob {
  id: number;
  kind: string;
  clip_id: number | null;
  file_name: string | null;
  started_at: string;
  cancel_requested: boolean;
}

/** P1-6:当前正在跑的任务;每行「取消」走 `cancelJob`。 */
export function listRunningJobs(): Promise<RunningJob[]> {
  return invoke<RunningJob[]>("list_running_jobs");
}

/** P1-6:状态条「全部暂停 / 继续」——worker 不再领取新任务(导出 / 缓存清理除外),正在跑的跑完;持久化。 */
export function setJobsPaused(paused: boolean): Promise<boolean> {
  return invoke<boolean>("set_jobs_paused", { paused });
}

/** P1-6:当前是否被用户暂停。 */
export function getJobsPaused(): Promise<boolean> {
  return invoke<boolean>("get_jobs_paused");
}

/** P2-4:「重新分析这条」的结果:复位了几条失败任务、补排了几项(两者都 0 = 这条已经分析完)。 */
export interface RetryAnalysisOutcome {
  clip_id: number;
  reset: number;
  enqueued: number;
}

/** P2-4:清这条素材的失败标记并按既有入队逻辑重排画质 / 运镜 / 时刻分 / 封面。 */
export function retryClipAnalysis(clipId: number): Promise<RetryAnalysisOutcome> {
  return invoke<RetryAnalysisOutcome>("retry_clip_analysis", { clipId });
}

/** P2-6:删除一档已导入的转写模型文件(不可逆,界面先确认);返回释放的字节数。 */
export function deleteWhisperModel(tier: string): Promise<number> {
  return invoke<number>("delete_whisper_model", { tier });
}

/** P2-6:删除一个预览调色文件(只认文件名;不可逆,界面先确认);返回删后完整列表。 */
export function deleteDisplayLut(name: string): Promise<string[]> {
  return invoke<string[]>("delete_display_lut", { name });
}

/** P2-7:在 Finder 中显示这条素材的原片(原片不在原位时报缺失页那句人话)。 */
export function revealClip(clipId: number): Promise<void> {
  return invoke<void>("reveal_clip", { clipId });
}

/** P2-10:一条标签;AI 的(`ai_l3`)与用户的(`user`)一起列,只有用户的可删。 */
export interface ClipTag {
  id: number;
  label: string;
  source: string;
  deletable: boolean;
}

export function listTags(clipId: number): Promise<ClipTag[]> {
  return invoke<ClipTag[]>("list_tags", { clipId });
}

/** P2-10:加一条用户标签(去空白、≤32 字、同名不重复——同名时返回已有那条)。 */
export function addTag(clipId: number, text: string): Promise<ClipTag> {
  return invoke<ClipTag>("add_tag", { clipId, text });
}

/** P2-10:删一条用户标签;AI 标签会被后端拒绝。 */
export function removeTag(clipId: number, tagId: number): Promise<void> {
  return invoke<void>("remove_tag", { clipId, tagId });
}

// ---------------------------------------------------------------------------
// R17 车道 B:应用内自动升级。下面这几条签名是按车道 A 任务书里的约定先行追加的,
// 合并时以车道 A 的 Rust 侧为准(同名同形状)。
// ---------------------------------------------------------------------------

/** R17:`check_for_update` 的结果——有没有新版本、版本号、更新说明(markdown)、发布时间。 */
export interface UpdateCheckResult {
  available: boolean;
  /** 有新版本时才有;`null` = 已是最新 / 离线。 */
  version: string | null;
  notes: string | null;
  pub_date: string | null;
  /** 当前运行版本。 */
  current_version: string;
  /** 端点没连上(断网、超时):不是错误,`available` 一定是 false,前端静默。 */
  offline: boolean;
  /** 这个版本被用户「跳过」过;`available` 仍为 true,由前端决定提不提示。 */
  skipped?: boolean;
}

/** R17:问一次更新服务器(后端负责签名校验与版本比较)。离线时返回 `offline: true`,不 reject。 */
export function checkForUpdate(): Promise<UpdateCheckResult> {
  return invoke<UpdateCheckResult>("check_for_update");
}

/**
 * R17:后台下载并暂存刚查到的那个版本(签名校验过才暂存);进度走 `tripcut:update-progress` 事件,失败 reject。
 * **不在运行中替换 bundle**:2026-09-14 真机实测,运行中原地替换 .app 会让 WebKit 失去有效签名、界面整个冻住
 * (点什么都没反应,AX 树消失);替换只在「重启完成更新」(`restart_to_update`)或退出钩子里做。
 */
export function downloadUpdate(): Promise<void> {
  return invoke<void>("download_update");
}

/** R17:装好之后重启到新版本。 */
export function restartToUpdate(): Promise<void> {
  return invoke<void>("restart_to_update");
}

/** R17:下载进度事件名(后端 Tauri 事件 → 同名 window CustomEvent,`detail` = UpdateProgressEvent)。 */
export const UPDATE_PROGRESS_EVENT = "tripcut:update-progress";

export interface UpdateProgressEvent {
  downloaded: number;
  /** 服务器没给长度时为 null。 */
  total: number | null;
}

/** R17:与 `bridgeMusicAnalyzedEvents` 同一套约定;非 Tauri 环境静默退化为 no-op。 */
export async function bridgeUpdateProgressEvents(): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<UpdateProgressEvent>(UPDATE_PROGRESS_EVENT, (event) => {
      window.dispatchEvent(new CustomEvent<UpdateProgressEvent>(UPDATE_PROGRESS_EVENT, { detail: event.payload }));
    });
  } catch {
    return () => undefined;
  }
}

/**
 * R17:设置键——「自动更新」(默认 true:发现新版本就在后台静默下载;业主 09-14 拍板,替代最初的
 * `updater.auto_check`)、「有新版本先问我再下载」(默认 false)、上次检查时间(ISO)、用户点过「跳过」的版本号。
 */
export const UPDATER_AUTO_UPDATE_KEY = "updater.auto_update";
export const UPDATER_ASK_BEFORE_DOWNLOAD_KEY = "updater.ask_before_download";
export const UPDATER_LAST_CHECK_KEY = "updater.last_check";
export const UPDATER_SKIPPED_VERSION_KEY = "updater.skipped_version";

/** R17:自动更新失败时的兜底——手动下载页(GitHub release)。 */
export const UPDATE_RELEASE_PAGE_URL = "https://github.com/qx04222/tripcut-studio/releases/latest";

/**
 * R17:在系统浏览器里打开一个网址(后端白名单只放行下载页)。车道 A 若没提供 `open_url`,
 * 调用方会退回 `window.open`——见 `workspace/update/updateStore.ts`。
 */
export function openExternalUrl(url: string): Promise<void> {
  return invoke<void>("open_url", { url });
}

/**
 * R17 车道 epmove:素材跨集移动。`from` 是每条素材的旧归属 `(clip_id, old_episode_id)`,撤销时按旧集分组反向再调。
 * 已封存的历史集也能作目标;只读窗口调用会被后端拒绝(白话错误)。
 */
export interface MoveOutcome {
  moved: number;
  skipped_missing: number;
  from: Array<[number, number]>;
}

export async function moveClipsToEpisode(clipIds: readonly number[], episodeId: number): Promise<MoveOutcome> {
  return invoke<MoveOutcome>("move_clips_to_episode", { clipIds: [...clipIds], episodeId });
}

/** R17 车道 epmove:`undo_story_change` 的结果 —— `skipped_moved` = 快照里已被移到别的集、这次没放回镜头带的镜数。 */
export interface UndoStoryOutcome {
  skipped_moved: number;
}

/* ------------------------------------------------------------------ *
 * R18 车道 native / F2:关窗口时后台任务还没做完的确认(只追加,不改上面任何一行)。
 * ------------------------------------------------------------------ */

/** 后端 `exit_guard` 在 `CloseRequested` 里拦下这一次关闭后发的事件名。 */
export const CLOSE_REQUESTED_EVENT = "tripcut:close-requested";

export interface CloseRequestedEvent {
  /** 值得拦一次的任务数(空闲缓存清理不算)。 */
  running: number;
}

/**
 * 把 `tripcut:close-requested` 转成同名 window CustomEvent,与
 * `bridgeMusicAnalyzedEvents` 同一套约定;非 Tauri 环境静默退化为 no-op。
 */
export async function bridgeCloseRequestedEvents(): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<CloseRequestedEvent>(CLOSE_REQUESTED_EVENT, (event) => {
      window.dispatchEvent(new CustomEvent<CloseRequestedEvent>(CLOSE_REQUESTED_EVENT, { detail: event.payload }));
    });
  } catch {
    return () => undefined;
  }
}

/**
 * R18 W-4:启动补扫(12 个增量入队 + 启动快照)现在跑在窗口起来之后,
 * 后端在开始 / 结束时各发一次 `tripcut:startup-backfill`(payload 为 boolean)。
 * 状态条订阅它显示「正在整理素材库」,补扫结束时重新拉一次列表。
 * 非 Tauri 环境静默退化为 no-op(与 `bridgeImportProbeEvents` 同一套约定)。
 */
export const STARTUP_BACKFILL_EVENT = "tripcut:startup-backfill";

export async function onStartupBackfill(handler: (running: boolean) => void): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<boolean>(STARTUP_BACKFILL_EVENT, (event) => handler(Boolean(event.payload)));
  } catch {
    return () => undefined;
  }
}

/** 用户点了「仍要退出」:后端设标志位后真正退出(第二次 CloseRequested 不再拦)。 */
export function confirmExit(): Promise<void> {
  return invoke<void>("confirm_exit");
}

/**
 * R18 车道 settings F1:两条系统通知各自一个开关(默认开)。关掉后 Rust 的
 * `notify::post_gated` 一次 `sink.notify` 都不调;两条都关时连首次那条
 * 「引 macOS 权限弹框」的通知也不发。
 */
export const NOTIFY_EXPORT_COMPLETE_KEY = "notification.export_complete";
export const NOTIFY_BATCH_COMPLETE_KEY = "notification.batch_complete";

/** R18 F5/F6:缓存目录(空 = 内置位置)与缓存自动清理天数("0" = 从不)。 */
export const CACHE_CUSTOM_DIR_KEY = "cache.custom_dir";
export const CACHE_AUTO_CLEAN_DAYS_KEY = "cache.auto_clean_days";

/**
 * R18 车道 settings F8:后台任务页的「失败」清单。只收 `failed` / `blocked` 里
 * **不是用户自己取消**的那些;`clearFailedJobs` 把它们标成已知晓(不删行,失败
 * 原因留给诊断包),返回清掉几条。
 */
export interface FailedJob {
  id: number;
  kind: string;
  status: "failed" | "blocked";
  clip_id: number | null;
  file_name: string | null;
  summary: string | null;
  finished_at: string | null;
}

export function listFailedJobs(): Promise<FailedJob[]> {
  return invoke<FailedJob[]>("list_failed_jobs");
}

export function clearFailedJobs(): Promise<number> {
  return invoke<number>("clear_failed_jobs");
}

/** R18 车道 settings F5:「更改缓存位置…」——先选文件夹,再整体搬迁(搬完应用会重启)。 */
export interface CacheRelocation {
  new_root: string;
  moved_bytes: number;
  moved_files: number;
}

export function pickCacheFolder(): Promise<string | null> {
  return invoke<string | null>("pick_cache_folder");
}

/**
 * 搬迁成功后后端直接重启应用,这个 Promise **不会 resolve**;调用方要把界面留在
 * 「正在搬…」上,不要等它回来再收尾。失败时照常 reject,错误里带「现在怎么办」。
 */
export function relocateCacheDir(folder: string): Promise<CacheRelocation> {
  return invoke<CacheRelocation>("relocate_cache_dir", { folder });
}

/**
 * R18 车道 settings M-04:「导出诊断包…」。后端弹保存面板;用户取消返回 null。
 * 包里没有原片、封面、转写、GPS,绝对路径一律脱敏。
 */
export interface DiagnosticsBundle {
  path: string;
  log_files: number;
  failed_jobs: number;
}

export function exportDiagnosticsBundle(): Promise<DiagnosticsBundle | null> {
  return invoke<DiagnosticsBundle | null>("export_diagnostics_bundle");
}
