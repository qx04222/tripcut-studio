/**
 * 假 Tauri 后端的内存夹具(`vite --mode mock` 专用,生产 build 不含本目录)。
 *
 * 一集(EP01 通用 · 同时)、60 条素材、4 章故事板 + 叙事 beats、2 个可生成缺口、
 * 若干同镜头 Stack(含一条 MiniMax 生成候选)、评级混合、技术检查、相似组、
 * 一首带节拍/段落的音乐、旅程时间线、目的地卡。数据是确定性的(种子随机),
 * 每次启动截图装置看到的画面一致。
 *
 * `src/api.ts` 的 130 条命令每一条都在 `HANDLERS` 里登记;没登记的命令走到
 * `handleMockCommand` 末尾直接抛 `MockCommandMissing`,错误信息带命令名 ——
 * 漏一条就在控制台/截图脚本里当场看见,不许静默返回 undefined。
 */
import type {
  AppInfo,
  AssetSafetyInfo,
  ClipAnalysis,
  ClipArtifacts,
  ClipAudioTrack,
  ClipDimension,
  ClipDimensionKey,
  ClipListItem,
  ClipMemoryAnnotation,
  ClipMotion,
  ClipRating,
  ComponentStatus,
  DestinationCard,
  DeviceClockSetting,
  DoctorReport,
  EpisodeSummary,
  ExportStatus,
  GenerationAvailability,
  GenerationLedgerSummary,
  GenerationRequestSummary,
  ImportBatch,
  ImportProgress,
  JianyingAvailability,
  JourneyEntry,
  LibraryRegistry,
  LlmStatus,
  MissingClip,
  MusicAnalysis,
  MusicTrackSummary,
  NarrativeBeat,
  NarrativeChapter,
  PlatformPreset,
  PlayerStatus,
  RevisionInfo,
  SelectSegment,
  SettingsMap,
  SettingsStatus,
  ShotStack,
  ShotStackMember,
  SimilarGroup,
  StoryGap,
  StoryItem,
  StoryTemplateInfo,
  Storyboard,
  WatchedFolder,
  QuickExportOutcome,
  QuickExportSelection,
} from "../api";

// ---------------------------------------------------------------------------
// 确定性随机
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260911);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
const between = (lo: number, hi: number): number => lo + rand() * (hi - lo);

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 时基:毫秒 tick(与 MediaPool 测试夹具一致)。 */
const TB_NUM = 1;
const TB_DEN = 1000;
export const CLIP_COUNT = 60;
export const COVER_URL_PREFIX = "/mock-covers/";

const EPISODE_ID = 1;
const EPISODE_TITLE = "EP01 通用 · 同时";
const NOW = "2026-09-11T08:30:00+08:00";

/** 四天行程:昆明 → 大理 → 沙溪 → 丽江。 */
const DAYS = [
  { date: "2026-08-12", place: "昆明·大理", chapter: 1 },
  { date: "2026-08-13", place: "大理古城·洱海", chapter: 2 },
  { date: "2026-08-14", place: "沙溪古镇", chapter: 3 },
  { date: "2026-08-15", place: "丽江", chapter: 4 },
] as const;

const SUBJECTS: Record<number, readonly string[]> = {
  1: ["昆明长水机场_出发", "高速_苍山远景", "房车_加水", "下关_落日", "房车_夜宿"],
  2: ["大理古城_清晨街景", "洱海_环湖骑行", "喜洲_扎染院子", "洱海_日出航拍", "双廊_咖啡馆", "才村码头_晚霞"],
  3: ["沙溪_寺登街", "沙溪_玉津桥", "沙溪_周五集市", "沙溪_古戏台", "沙溪_稻田日落", "沙溪_民宿早餐"],
  4: ["丽江_古城夜色", "丽江_玉龙雪山", "束河_石板路", "丽江_四方街_打跳", "丽江_民宿露台", "返程_收拾房车"],
};

const CAMERAS = [
  { model: "DJI Osmo Pocket 3", prefix: "DJI_", w: 3840, h: 2160, fps: 30 },
  { model: "iPhone 15 Pro", prefix: "IMG_", w: 3840, h: 2160, fps: 30 },
  { model: "GoPro HERO12", prefix: "GX01", w: 3840, h: 2160, fps: 60 },
  { model: "Sony ZV-E10", prefix: "C", w: 1920, h: 1080, fps: 25 },
] as const;

// ---------------------------------------------------------------------------
// 可变状态(评级、缺口、Stack 状态……写入命令改它们,并顶 revision)
// ---------------------------------------------------------------------------

interface MockState {
  revision: number;
  settings: SettingsMap;
  clips: ClipListItem[];
  gaps: StoryGap[];
  stacks: ShotStack[];
  segments: SelectSegment[];
  player: PlayerStatus;
  destinationCards: DestinationCard[];
  narrativeRevision: RevisionInfo;
  exportStatus: ExportStatus;
  generationRequests: GenerationRequestSummary[];
  similarGroups: SimilarGroup[];
  watchedFolders: WatchedFolder[];
  libraries: LibraryRegistry;
  episodes: EpisodeSummary[];
  undoStack: number;
  playerTimer: ReturnType<typeof setInterval> | null;
}

export class MockCommandMissing extends Error {
  constructor(command: string) {
    super(`mock backend: no handler for command "${command}" — add it to src/devMock/fixture.ts`);
    this.name = "MockCommandMissing";
  }
}

function bump(state: MockState): void {
  state.revision += 1;
}

// ---------------------------------------------------------------------------
// 素材
// ---------------------------------------------------------------------------

function analysisFor(index: number, flags: { dark?: boolean; over?: boolean; silent?: boolean; soft?: boolean }): ClipAnalysis {
  return {
    clip_id: index,
    exposure_yavg: flags.dark ? 28 : Math.round(between(70, 150)),
    overexposed_ratio: flags.over ? 0.24 : Number(between(0, 0.08).toFixed(3)),
    audio_peak_db: flags.silent ? null : Number(between(-18, -3).toFixed(1)),
    audio_clipped: false,
    has_audio: !flags.silent,
    focus_scores: flags.soft ? [42, 51, 47] : [Math.round(between(70, 140)), Math.round(between(70, 140))],
    scene_count: Math.floor(between(1, 4)),
    analyzed_at: NOW,
    tool_versions: { pipeline: "3", ffmpeg: "7.1" },
    underexposed_ratio: flags.dark ? 0.2 : Number(between(0, 0.05).toFixed(3)),
    dynamic_range: Number(between(40, 90).toFixed(1)),
    blur_mean: Number(between(0.1, 0.5).toFixed(2)),
    entropy_mean: Number(between(5, 7.5).toFixed(2)),
    motion_mean: Number(between(0.5, 6).toFixed(2)),
    out_of_focus_ratio: Number(between(0, 0.05).toFixed(3)),
  };
}

function motionFor(index: number, shaky: boolean): ClipMotion {
  const cls = pick(["pan", "tilt", "zoom", "handheld", "static"] as const);
  return {
    clip_id: index,
    class: shaky ? "handheld" : cls,
    pan_ratio: Number(between(0, 1).toFixed(2)),
    tilt_ratio: Number(between(0, 1).toFixed(2)),
    zoom_corr: Number(between(-0.3, 0.6).toFixed(2)),
    shake_score: shaky ? 0.82 : Number(between(0, 0.3).toFixed(2)),
    is_shaky: shaky,
    sample_pairs: 48,
    tool_version: "motion-1.2",
  };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function buildClips(): ClipListItem[] {
  const clips: ClipListItem[] = [];
  let id = 0;
  for (const day of DAYS) {
    const subjects = SUBJECTS[day.chapter]!;
    const perDay = day.chapter === 1 ? 12 : 16;
    for (let n = 0; n < perDay && id < CLIP_COUNT - 2; n += 1) {
      id += 1;
      const camera = CAMERAS[id % CAMERAS.length]!;
      const subject = subjects[n % subjects.length]!;
      const take = Math.floor(n / subjects.length) + 1;
      const useChineseName = id % 10 !== 3 && id % 10 !== 7;
      const fileName = useChineseName
        ? `${day.date.replaceAll("-", "")}_${subject}_${pad(take, 2)}.MP4`
        : camera.prefix === "C"
          ? `C${pad(40 + id, 4)}.MP4`
          : `${camera.prefix}${day.date.replaceAll("-", "")}_${pad(83000 + id * 137, 6)}_${pad(id, 4)}_D.MP4`;
      const hour = 7 + Math.floor((n / perDay) * 13);
      const minute = Math.floor(between(0, 59));
      const durationS = Math.round(between(4, 48));
      const flags = {
        dark: id % 13 === 0,
        over: id % 17 === 0,
        silent: id % 19 === 0,
        soft: id % 23 === 0,
      };
      const shaky = id % 11 === 0;
      const analysisStatus: ClipListItem["analysis_status"] =
        id % 29 === 0 ? "pending" : id % 31 === 0 ? "failed" : "done";
      const binary: ClipListItem["binary_rating"] = id % 5 === 0 ? 1 : id % 12 === 0 ? -1 : null;
      const star: ClipListItem["star_rating"] =
        binary === 1 ? (pick([4, 5]) as 4 | 5) : id % 4 === 0 ? (pick([2, 3]) as 2 | 3) : null;
      clips.push({
        id,
        episode_id: EPISODE_ID,
        folder_label: `${day.date} ${day.place}`,
        cover_url: `${COVER_URL_PREFIX}${pad(id, 2)}.jpg`,
        path: `/Volumes/TRIP_2026/${day.date}/${fileName}`,
        file_name: fileName,
        byte_size: durationS * 12_500_000,
        quick_hash: `qh${pad(id, 4)}`,
        full_hash: null,
        tb_num: TB_NUM,
        tb_den: TB_DEN,
        duration_ticks: durationS * 1000,
        fps_num: camera.fps,
        fps_den: 1,
        is_vfr: camera.prefix === "IMG_",
        codec: camera.prefix === "IMG_" ? "hevc" : "h264",
        width: camera.w,
        height: camera.h,
        captured_at: `${day.date}T${pad(hour, 2)}:${pad(minute, 2)}:00+08:00`,
        audio_sample_rate: 48000,
        rotation: null,
        color_transfer: camera.prefix === "DJI_" ? "arib-std-b67" : "bt709",
        hdr_flag: camera.prefix === "DJI_",
        iso_value: Math.round(between(100, 800)),
        shutter_speed: `1/${pick([50, 60, 120, 250])}`,
        aperture: camera.prefix === "C" ? "f/2.8" : null,
        display_lut_path: null,
        selected_transcribe_track: 0,
        selected_monitor_track: 0,
        generated_source: null,
        tz_guess: "Asia/Shanghai",
        tz_conflict: false,
        device_model: camera.model,
        journey_offset_ms: 0,
        status: "ready",
        error: null,
        analysis: analysisStatus === "done" ? analysisFor(id, flags) : null,
        analysis_status: analysisStatus,
        analysis_error: analysisStatus === "failed" ? "ffprobe: moov atom not found" : null,
        motion: analysisStatus === "done" ? motionFor(id, shaky) : null,
        motion_status: analysisStatus,
        motion_error: null,
        binary_rating: binary,
        star_rating: star,
        select_count: id % 6 === 0 ? 1 : 0,
      });
    }
  }
  // 两条 MiniMax 生成候选(R7):一条进 Stack 当备选,一条独立。
  for (const [offset, title] of [["59", "洱海_日出航拍_建立镜头"], ["60", "沙溪_稻田_转场"]] as const) {
    const gid = Number(offset);
    clips.push({
      ...clips[0]!,
      id: gid,
      folder_label: "MiniMax 生成",
      cover_url: `${COVER_URL_PREFIX}${offset}.jpg`,
      path: `/Users/xin/Library/Application Support/tripcut/generated/${title}.mp4`,
      file_name: `${title}.mp4`,
      byte_size: 18_000_000,
      quick_hash: `gen${offset}`,
      duration_ticks: 6000,
      fps_num: 24,
      fps_den: 1,
      is_vfr: false,
      codec: "h264",
      width: 1920,
      height: 1080,
      captured_at: null,
      hdr_flag: false,
      color_transfer: "bt709",
      iso_value: null,
      shutter_speed: null,
      aperture: null,
      generated_source: "minimax",
      device_model: null,
      analysis: analysisFor(gid, {}),
      analysis_status: "done",
      analysis_error: null,
      motion: motionFor(gid, false),
      motion_status: "done",
      binary_rating: null,
      star_rating: null,
      select_count: 0,
    });
  }
  return clips;
}

// ---------------------------------------------------------------------------
// 故事板 / 叙事
// ---------------------------------------------------------------------------

const CHAPTERS = [
  { id: 101, kind: "journey", title: "出发:昆明到大理" },
  { id: 102, kind: "destination", title: "大理古城与洱海" },
  { id: 103, kind: "experience", title: "沙溪古镇的一天" },
  { id: 104, kind: "atmosphere", title: "丽江夜色" },
] as const;

const EMPTY_MEMORY: ClipMemoryAnnotation = {
  used_episode_badges: [],
  repeated_signature_uses: 0,
  recent_episode_window: 3,
  routine_visual: false,
  novelty_context: false,
  narrative_adjustment: 0,
  routine_suggestion: null,
};

function chapterOfClip(clip: ClipListItem): number | null {
  if (clip.generated_source) return null;
  const day = DAYS.find((d) => clip.captured_at?.startsWith(d.date));
  return day ? CHAPTERS[day.chapter - 1]!.id : null;
}

/** 故事板里放前 ~2/3 素材;其余留在候选区,好让媒体池与镜头带看起来不一样。 */
function placedClips(clips: readonly ClipListItem[]): ClipListItem[] {
  return clips.filter((clip) => clip.id !== null && !clip.generated_source && clip.binary_rating !== -1 && (clip.id as number) % 3 !== 0);
}

function buildStoryboard(clips: readonly ClipListItem[]): Storyboard {
  const placed = placedClips(clips);
  const items: StoryItem[] = placed.map((clip, index) => ({
    key: `whole:${clip.id}`,
    item_kind: "whole",
    clip_id: clip.id as number,
    segment_id: null,
    chapter_id: chapterOfClip(clip),
    file_name: clip.file_name,
    in_ticks: 0,
    out_ticks: clip.duration_ticks ?? 0,
    tb_num: TB_NUM,
    tb_den: TB_DEN,
    position: index,
    long_term_memory:
      index % 9 === 4
        ? {
            ...EMPTY_MEMORY,
            used_episode_badges: ["EP00"],
            repeated_signature_uses: 2,
            routine_visual: true,
            routine_suggestion: {
              routine_kind: "房车加水",
              treatment: "montage",
              previous_occurrences: 2,
              changed: false,
              reason: "前两集都完整讲过加水流程,这次建议压成 montage",
            },
          }
        : EMPTY_MEMORY,
  }));
  const candidates: StoryItem[] = clips
    .filter((clip) => !placed.includes(clip) && clip.id !== null)
    .map((clip) => ({
      key: `whole:${clip.id}`,
      item_kind: "whole" as const,
      clip_id: clip.id as number,
      segment_id: null,
      chapter_id: null,
      file_name: clip.file_name,
      in_ticks: 0,
      out_ticks: clip.duration_ticks ?? 0,
      tb_num: TB_NUM,
      tb_den: TB_DEN,
      position: null,
      long_term_memory: EMPTY_MEMORY,
    }));

  let beatId = 500;
  const narrativeChapters: NarrativeChapter[] = CHAPTERS.map((chapter, order) => {
    const beats: NarrativeBeat[] = items
      .filter((item) => item.chapter_id === chapter.id)
      .map((item, index) => {
        beatId += 1;
        return {
          id: beatId,
          clip_id: item.clip_id,
          segment_id: null,
          role: index === 0 ? "beat" : index % 4 === 3 ? "transition" : index % 3 === 2 ? "montage" : "beat",
          order: index,
          score: Number(between(0.55, 0.95).toFixed(2)),
          rationale: "画面稳定、主体清晰,与本章主题一致",
          routine_suggestion: item.long_term_memory.routine_suggestion,
          routine_cleared: false,
        };
      });
    return {
      id: chapter.id,
      kind: chapter.kind,
      title: chapter.title,
      order,
      promoted: order === 1,
      score: Number(between(0.6, 0.9).toFixed(2)),
      rationale: "素材密度高,情绪线完整",
      promotion_reason: order === 1 ? "本集核心目的地" : "",
      story_slots: ["REAL/ESTABLISHING", "REAL/DETAIL", "ATMOSPHERE", "TRANSITION"],
      missing_slots: order === 1 ? ["REAL/ESTABLISHING"] : order === 2 ? ["TRANSITION"] : [],
      digital_human_plan:
        order === 1
          ? { mode: "B", reason: "目的地章节需要一段口播介绍", planned_slots: ["DH INTRO"] }
          : null,
      beats,
    };
  });

  return {
    chapters: CHAPTERS.map((chapter) => {
      const day = DAYS[CHAPTERS.indexOf(chapter)]!;
      return {
        id: chapter.id,
        title: chapter.title,
        start_at: `${day.date}T07:00:00+08:00`,
        end_at: `${day.date}T21:00:00+08:00`,
        clip_count: items.filter((item) => item.chapter_id === chapter.id).length,
      };
    }),
    items,
    candidates,
    can_undo: false,
    mode: "narrative",
    mode_notice: "叙事编排:模板「电影感」· 上次生成 2026-09-10 22:14",
    narrative: {
      episode: {
        id: EPISODE_ID,
        title: EPISODE_TITLE,
        theme: "云南房车四日:大理 · 沙溪 · 丽江",
        created_at: "2026-08-11T20:00:00+08:00",
        template: "cinematic",
      },
      chapters: narrativeChapters,
      destination_cards: [],
      boundary_signals: [
        { before_clip_id: 12, after_clip_id: 13, score: 0.91, reasons: ["日期切换", "地点切换"] },
        { before_clip_id: 28, after_clip_id: 29, score: 0.88, reasons: ["日期切换"] },
        { before_clip_id: 44, after_clip_id: 45, score: 0.86, reasons: ["日期切换", "设备切换"] },
      ],
      job_status: "done",
      dh_guard: {
        historical_appearances: [
          { episode_badge: "EP00", mode: "A", duration_s: 24, style: "口播", topic: "行程预告" },
        ],
        current_estimated_duration_s: 18,
        duration_warning_threshold_s: 45,
        warnings: [],
      },
    },
    narration_job_status: "done",
    current_template: "cinematic",
  };
}

function buildDestinationCards(): DestinationCard[] {
  const coverage = (covered: boolean) => [
    { item: "建立镜头", covered, evidence: covered ? "洱海_日出航拍_01" : "", suggestion: covered ? "" : "补一条航拍全景" },
    { item: "细节镜头", covered: true, evidence: "喜洲_扎染院子_01", suggestion: "" },
    { item: "人物", covered: true, evidence: "双廊_咖啡馆_01", suggestion: "" },
  ];
  return [
    {
      id: 301,
      chapter_id: 102,
      name: "大理古城",
      geo_context: "云南省大理白族自治州,苍山脚下、洱海西岸",
      highlights: "复兴路老街、人民路夜市、五华楼",
      why_visit: "南诏古都,古城与雪山湖泊同框",
      personal_note: "清晨六点半的古城几乎没人,光最好。",
      sources: [{ label: "大理古城官网", basis: "景区介绍" }],
      verified: true,
      coverage: coverage(false),
      field_states: { name: "verified", geo_context: "verified", highlights: "pending", why_visit: "verified", personal_note: "verified" },
    },
    {
      id: 302,
      chapter_id: 103,
      name: "沙溪古镇",
      geo_context: "剑川县,茶马古道上唯一幸存的古集市",
      highlights: "寺登街、玉津桥、周五集市",
      why_visit: "没有被过度开发的茶马古道驿站",
      personal_note: "周五集市要早去,九点后停车位就没了。",
      sources: [{ label: "剑川县文旅", basis: "官方介绍" }],
      verified: false,
      coverage: coverage(true),
      field_states: { name: "verified", geo_context: "pending", highlights: "pending", why_visit: "rejected", personal_note: "pending" },
    },
    {
      id: 303,
      chapter_id: 104,
      name: "丽江古城",
      geo_context: "丽江市古城区,玉龙雪山南麓",
      highlights: "四方街打跳、狮子山万古楼夜景",
      why_visit: "夜晚的灯火与白天的雪山各是一番景象",
      personal_note: "",
      sources: [],
      verified: false,
      coverage: coverage(true),
      field_states: { name: "pending", geo_context: "pending", highlights: "pending", why_visit: "pending", personal_note: "pending" },
    },
  ];
}

function buildGaps(): StoryGap[] {
  return [
    {
      id: 401,
      chapter_id: 102,
      band_chapter_id: 102,
      chapter_title: "大理古城与洱海",
      beat_id: null,
      slot: "REAL/ESTABLISHING",
      slot_label_zh: "建立镜头",
      reason: "本章缺少一条交代洱海全貌的开场镜头,现有素材都是中近景",
      status: "open",
      latest_request: null,
    },
    {
      id: 402,
      chapter_id: 103,
      band_chapter_id: 103,
      chapter_title: "沙溪古镇的一天",
      beat_id: null,
      slot: "TRANSITION",
      slot_label_zh: "转场",
      reason: "从集市到稻田日落之间没有过渡,建议补一条空镜",
      status: "open",
      latest_request: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// Stack / 相似组 / 维度 / 安全
// ---------------------------------------------------------------------------

function member(clipId: number, score: number, state: ShotStackMember["user_state"] = "auto"): ShotStackMember {
  const axis = (value: number | null, note: string) => ({ score: value, confidence: 0.8, source: "analysis", note });
  return {
    clip_id: clipId,
    segment_id: null,
    best_take_score: score,
    score_breakdown: {
      technical: axis(Number((score + 0.05).toFixed(2)), "曝光/对焦"),
      composition: axis(Number((score - 0.03).toFixed(2)), "三分构图"),
      motion: axis(Number((score - 0.1).toFixed(2)), "运镜平稳度"),
      human: axis(null, "无人物"),
      audio: axis(Number((score - 0.05).toFixed(2)), "环境声"),
      narrative: axis(score, "章节契合"),
      configured_weights: { technical: 0.25, composition: 0.2, motion: 0.15, human: 0.1, audio: 0.1, narrative: 0.2 },
      preference_boost: state === "hero" ? 0.1 : 0,
      total: score,
    },
    user_state: state,
    is_preferred: state === "hero",
    long_term_memory: EMPTY_MEMORY,
  };
}

function buildStacks(): ShotStack[] {
  const base = (id: number, sceneId: number, sceneName: string, type: ShotStack["stack_type"], labels: [string, string, string, string], members: ShotStackMember[]): ShotStack => ({
    id,
    scene_id: sceneId,
    scene_name: sceneName,
    stack_type: type,
    subject_label: labels[0],
    function_label: labels[1],
    shot_size_label: labels[2],
    movement_label: labels[3],
    quality_exempt: false,
    members,
  });
  return [
    base(201, 12, "洱海日出", "visual", ["洱海", "建立镜头", "远景", "航拍"], [member(16, 0.82, "hero"), member(22, 0.74), member(59, 0.61)]),
    base(202, 13, "古城清晨", "visual", ["街景", "氛围", "中景", "手持"], [member(13, 0.77), member(19, 0.79, "hero")]),
    base(203, 14, "集市人物", "human", ["摊主", "人物", "近景", "静止"], [member(31, 0.71), member(37, 0.69), member(43, 0.65, "rejected")]),
    base(204, 15, "玉津桥", "visual", ["古桥", "细节", "特写", "横摇"], [member(30, 0.8, "locked"), member(36, 0.72)]),
    base(205, 16, "四方街打跳", "human", ["人群", "活动", "全景", "手持"], [member(48, 0.75), member(54, 0.78), member(58, 0.7)]),
    base(206, 17, "房车夜宿", "information", ["房车", "信息", "中景", "静止"], [member(5, 0.66), member(10, 0.7, "hero")]),
  ];
}

function buildSimilarGroups(): SimilarGroup[] {
  return [
    { id: 701, min_similarity: 0.92, members: [{ clip_id: 1, is_primary: true }, { clip_id: 7, is_primary: false }] },
    { id: 702, min_similarity: 0.89, members: [{ clip_id: 13, is_primary: true }, { clip_id: 19, is_primary: false }, { clip_id: 25, is_primary: false }] },
    { id: 703, min_similarity: 0.9, members: [{ clip_id: 30, is_primary: false }, { clip_id: 36, is_primary: true }] },
  ];
}

const DIMENSION_VALUES: Record<ClipDimensionKey, readonly string[]> = {
  movement: ["静止", "横摇", "推进", "跟拍", "航拍"],
  shot_size: ["远景", "全景", "中景", "近景", "特写"],
  subject: ["风景", "人物", "建筑", "食物", "房车"],
  viewpoint: ["平视", "俯视", "仰视", "第一人称"],
  function: ["建立镜头", "细节", "氛围", "转场", "叙事"],
  person_state: ["无人物", "行走", "交谈", "进食", "拍照"],
  time_stage: ["出发", "路上", "到达", "探索", "吃饭", "活动", "日落夜景", "返回"],
  sound: ["环境声", "人声", "音乐", "静音"],
};

function buildDimensions(clips: readonly ClipListItem[]): ClipDimension[] {
  const out: ClipDimension[] = [];
  for (const clip of clips) {
    if (clip.id === null || clip.analysis_status !== "done") continue;
    for (const key of Object.keys(DIMENSION_VALUES) as ClipDimensionKey[]) {
      // 留几条只判定了 5–6 维,让检查器的「n/8 维已判定」有变化。
      if ((clip.id + key.length) % 7 === 0) continue;
      out.push({
        clip_id: clip.id,
        dimension: key,
        label: pick(DIMENSION_VALUES[key]),
        score: Number(between(0.6, 0.98).toFixed(2)),
        source: "chinese-clip",
      });
    }
  }
  return out;
}

function buildAssetSafety(clips: readonly ClipListItem[]): AssetSafetyInfo[] {
  return clips
    .filter((clip) => clip.id !== null)
    .map((clip) => {
      const id = clip.id as number;
      const flag: AssetSafetyInfo["safety_flag"] = id % 31 === 0 ? "likely_unusable" : id % 23 === 0 ? "rescue_candidate" : "normal";
      return {
        clip_id: id,
        safety_flag: flag,
        image_score: Number(between(0.4, 0.95).toFixed(2)),
        motion_score: Number(between(0.4, 0.95).toFixed(2)),
        audio_score: clip.analysis?.has_audio === false ? null : Number(between(0.4, 0.95).toFixed(2)),
        narrative_score: Number(between(0.3, 0.9).toFixed(2)),
        narrative_signals: flag === "normal" ? [] : ["前 2 秒虚焦"],
        rescue_range:
          flag === "rescue_candidate"
            ? { in_ticks: 2000, out_ticks: Math.max(4000, (clip.duration_ticks ?? 6000) - 1000), tb_num: TB_NUM, tb_den: TB_DEN, reason: "去掉开头虚焦段后可用" }
            : null,
        rescue_suggestions: flag === "rescue_candidate" ? ["从 00:02 起用"] : [],
      };
    });
}

// ---------------------------------------------------------------------------
// 音乐 / 旅程
// ---------------------------------------------------------------------------

const MUSIC_TRACK: MusicTrackSummary = {
  id: 801,
  episode_id: EPISODE_ID,
  file_name: "旅途_清晨_BGM_120bpm.mp3",
  rel_path: "music/旅途_清晨_BGM_120bpm.mp3",
  quick_hash: "mus801",
  duration_ticks: 180_000,
  tb_num: TB_NUM,
  tb_den: TB_DEN,
  bpm: 120,
  analysis_status: "done",
  blocked_summary: null,
  created_at: "2026-09-10T21:40:00+08:00",
};

function buildMusicAnalysis(): MusicAnalysis {
  const beats = [];
  for (let tick = 0; tick <= 180_000; tick += 500) {
    beats.push({ tick, is_downbeat: (tick / 500) % 4 === 0, strength: (tick / 500) % 4 === 0 ? 0.9 : 0.5 });
  }
  const sections: MusicAnalysis["sections"] = [
    { start_tick: 0, end_tick: 16_000, label: "intro", energy: 0.25 },
    { start_tick: 16_000, end_tick: 64_000, label: "verse", energy: 0.5 },
    { start_tick: 64_000, end_tick: 96_000, label: "build", energy: 0.7 },
    { start_tick: 96_000, end_tick: 144_000, label: "climax", energy: 0.95 },
    { start_tick: 144_000, end_tick: 180_000, label: "outro", energy: 0.3 },
  ];
  return {
    track: MUSIC_TRACK,
    beats,
    sections,
    suggested_cut_ticks: [16_000, 32_000, 64_000, 96_000, 120_000, 144_000],
  };
}

function buildJourney(clips: readonly ClipListItem[], cards: readonly DestinationCard[]): JourneyEntry[] {
  const entries: JourneyEntry[] = clips
    .filter((clip) => clip.captured_at !== null)
    .map((clip) => ({
      kind: "clip" as const,
      canonical_time: clip.captured_at as string,
      undated: false,
      clip_id: clip.id,
      file_name: clip.file_name,
      cover_url: clip.cover_url,
      destination_id: null,
      title: null,
      place_name: null,
    }));
  const cardTimes: Record<number, string> = { 301: "2026-08-13T08:00:00+08:00", 302: "2026-08-14T09:30:00+08:00", 303: "2026-08-15T18:00:00+08:00" };
  for (const card of cards) {
    entries.push({
      kind: "destination",
      canonical_time: cardTimes[card.id] ?? NOW,
      undated: false,
      clip_id: null,
      file_name: null,
      cover_url: null,
      destination_id: card.id,
      title: card.name,
      place_name: card.geo_context,
    });
  }
  for (const clip of clips.filter((c) => c.generated_source)) {
    entries.push({
      kind: "clip",
      canonical_time: NOW,
      undated: true,
      clip_id: clip.id,
      file_name: clip.file_name,
      cover_url: clip.cover_url,
      destination_id: null,
      title: null,
      place_name: null,
    });
  }
  return entries.sort((a, b) => a.canonical_time.localeCompare(b.canonical_time));
}

// ---------------------------------------------------------------------------
// 杂项固定返回
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: SettingsMap = {
  "appearance.theme": "system",
  "appearance.ui_scale": "1.0",
  "performance.worker_count": "4",
  "performance.proxy_enabled": "true",
  "performance.memory_profile": "auto",
  "tools.ffmpeg_path": "",
  "tools.ffprobe_path": "",
  "tools.whisper_path": "",
  "tools.whisper_model_tier": "large-v3-turbo",
  "analysis.scene_threshold": "0.35",
  "analysis.similarity_threshold": "0.88",
  "analysis.jitter_threshold": "0.6",
  "best_take.weight.technical": "0.25",
  "best_take.weight.composition": "0.2",
  "best_take.weight.motion": "0.15",
  "best_take.weight.human": "0.1",
  "best_take.weight.audio": "0.1",
  "best_take.weight.narrative": "0.2",
  llm_enabled: "false",
  llm_provider: "none",
  llm_monthly_budget: "200",
  minimax_enabled: "false",
  minimax_model: "MiniMax-H3",
  minimax_resolution: "768P",
  minimax_monthly_budget_usd: "20",
  "ui.workspace_v2": "true",
};

const EPISODE: EpisodeSummary = {
  id: EPISODE_ID,
  title: EPISODE_TITLE,
  theme: "云南房车四日:大理 · 沙溪 · 丽江",
  episode_number: 1,
  status: "active",
  created_at: "2026-08-11T20:00:00+08:00",
  archived_at: null,
  clip_count: CLIP_COUNT,
  favorite_count: 12,
  export_count: 0,
  target_platform: "general",
  canvas_orientation: "landscape",
};

const ARCHIVED_EPISODE: EpisodeSummary = {
  id: 0,
  title: "EP00 试拍 · 昆明周边",
  theme: "试机",
  episode_number: 0,
  status: "archived",
  created_at: "2026-07-20T10:00:00+08:00",
  archived_at: "2026-08-10T22:00:00+08:00",
  clip_count: 23,
  favorite_count: 4,
  export_count: 1,
  target_platform: "douyin",
  canvas_orientation: "portrait",
};

const DOCTOR: DoctorReport = {
  status: "OK",
  checks: [
    { id: "db", title: "项目数据库", status: "OK", detail: "schema v42,完整性检查通过" },
    { id: "ffmpeg", title: "FFmpeg", status: "OK", detail: "7.1 (内置)" },
    { id: "cache", title: "缓存目录", status: "OK", detail: "1.2 GB 可重建" },
  ],
  abnormal_exit: false,
  recovered_jobs: 0,
  cache_sampled: 60,
  cache_missing: 0,
  snapshots: ["2026-09-10T22-00-00"],
  restart_required: false,
};

const APP_INFO: AppInfo = { version: "0.2.1-mock", db_schema_version: 42, worker_count: 4, read_only: false };

const LLM_STATUS: LlmStatus = {
  enabled: false,
  provider: "none",
  monthly_budget: 200,
  calls_this_month: 0,
  remaining_calls: 200,
  budget_exhausted: false,
  providers: [
    { provider: "claude", executable: "claude", available: true },
    { provider: "codex", executable: "codex", available: true },
    { provider: "kimi", executable: "kimi", available: false },
  ],
};

const GENERATION_AVAILABILITY: GenerationAvailability = { enabled: false, has_key: false, budget_remaining_usd: 20 };

const GENERATION_LEDGER: GenerationLedgerSummary = { month: "2026-09", spent_usd: 0, budget_usd: 20, entries: [] };

const SETTINGS_STATUS: SettingsStatus = {
  ffmpeg: { configured_path: "", resolved_path: "/Applications/旅剪工作台.app/Contents/MacOS/ffmpeg", available: true, version: "7.1", note: null },
  ffprobe: { configured_path: "", resolved_path: "/Applications/旅剪工作台.app/Contents/MacOS/ffprobe", available: true, version: "7.1", note: null },
  whisper: {
    binary: { configured_path: "", resolved_path: "/Applications/旅剪工作台.app/Contents/MacOS/whisper-cli", available: true, version: "1.7.4", note: null },
    model_tier: "large-v3-turbo",
    model_path: "~/Library/Application Support/tripcut/models/ggml-large-v3-turbo.bin",
    model_available: true,
    models_directory: "~/Library/Application Support/tripcut/models",
  },
  clip_sidecar: {
    venv_path: "~/Library/Application Support/tripcut/sidecar/.venv",
    service_path: "~/Library/Application Support/tripcut/sidecar/service.py",
    setup_script: "scripts/setup-sidecar.sh",
    available: true,
    service_available: true,
    note: "Chinese-CLIP 本地服务已就绪",
  },
  cache: { database_bytes: 48_000_000, disk_bytes: 1_250_000_000 },
};

const PLATFORM_PRESETS: PlatformPreset[] = (
  [
    ["general", "通用", [1080, 1920], [1920, 1080], 600],
    ["douyin", "抖音", [1080, 1920], [1920, 1080], 180],
    ["xiaohongshu", "小红书", [1080, 1440], [1920, 1080], 120],
    ["bilibili", "哔哩哔哩", [1080, 1920], [1920, 1080], 900],
    ["moments", "朋友圈", [1080, 1920], [1920, 1080], 60],
    ["family", "家庭分享", [1080, 1920], [1920, 1080], 1800],
  ] as const
).map(([platform, display_name, portrait, landscape, seconds]) => ({
  platform,
  display_name,
  portrait: [...portrait] as [number, number],
  landscape: [...landscape] as [number, number],
  duration_budget_ticks: seconds * 1000,
  tb_num: TB_NUM,
  tb_den: TB_DEN,
  subtitle_style: { font: "PingFang SC", size: 42 },
}));

const STORY_TEMPLATES: StoryTemplateInfo[] = [
  { id: "cinematic", name_zh: "电影感", blurb_zh: "慢节奏、长镜头、留白多" },
  { id: "fastcut", name_zh: "快剪", blurb_zh: "卡点密集,适合抖音" },
  { id: "ambient", name_zh: "氛围", blurb_zh: "以空镜与环境声为主" },
  { id: "diary", name_zh: "日记", blurb_zh: "按时间顺序,口播为主" },
];

const COMPONENTS: ComponentStatus[] = [
  { id: "whisper-model", title: "Whisper 模型 (large-v3-turbo)", installed: true, detail: "1.6 GB", installable: true, approx_size_mb: 1600, has_previous: false, previous_version: null, recovered_from_rolling: false },
  { id: "chinese-clip", title: "Chinese-CLIP 侧车", installed: true, detail: "已就绪", installable: true, approx_size_mb: 900, has_previous: true, previous_version: "1.1", recovered_from_rolling: false },
  { id: "ocr", title: "OCR 侧车", installed: false, detail: "未安装", installable: true, approx_size_mb: 420, has_previous: false, previous_version: null, recovered_from_rolling: false },
];

const IDLE_EXPORT: ExportStatus = {
  job_id: null,
  status: "idle",
  stage: "idle",
  selected_count: 0,
  selected_segment_count: 0,
  selected_whole_count: 0,
  total_duration_seconds: 0,
  completed_items: 0,
  failed_items: 0,
  items: [],
  output_path: null,
  error: null,
  contact_sheet_glyph_fallbacks: null,
  contact_sheet_cover_failures: null,
  rough_cut_target_seconds: null,
  rough_cut_actual_ticks: null,
  rough_cut_actual_tb_num: null,
  rough_cut_actual_tb_den: null,
};

// status 取值对齐 src-tauri/src/core/import_control.rs::list_batches(scanning/queued/completed/cancelled/failed)。
const IMPORT_BATCHES: ImportBatch[] = [
  { id: 1, source: "/Volumes/TRIP_2026/2026-08-12", status: "completed", total: 12, done: 12, running: 0, failed: 0, duplicates: 0, imported: 12 },
  { id: 2, source: "/Volumes/TRIP_2026/2026-08-13", status: "completed", total: 16, done: 16, running: 0, failed: 0, duplicates: 1, imported: 15 },
  { id: 3, source: "/Volumes/TRIP_2026/2026-08-14", status: "failed", total: 16, done: 16, running: 0, failed: 1, duplicates: 0, imported: 15 },
  { id: 4, source: "/Volumes/TRIP_2026/2026-08-15", status: "scanning", total: 16, done: 14, running: 2, failed: 0, duplicates: 0, imported: 14 },
];

const IMPORT_PROGRESS: ImportProgress = { total: 60, done: 58, failed: 1, running: 1, waiting_for_permit: 0, paused_for_memory: false };

const MISSING_CLIPS: MissingClip[] = [
  { clip_id: 3, file_name: "DJI_20260812_083411_0003_D.MP4", volume_uuid: "9C2B-4F1A", volume_label: "TRIP_2026", rel_path: "2026-08-12/DJI_20260812_083411_0003_D.MP4", missing_since: "2026-09-10T09:12:00+08:00" },
  { clip_id: 7, file_name: "C0047.MP4", volume_uuid: "9C2B-4F1A", volume_label: "TRIP_2026", rel_path: "2026-08-12/C0047.MP4", missing_since: "2026-09-10T09:12:00+08:00" },
];

const DEVICE_CLOCKS: DeviceClockSetting[] = CAMERAS.map((camera, index) => ({
  device_model: camera.model,
  clip_count: 15,
  journey_offset_ms: index === 2 ? -3_600_000 : 0,
  source: index === 0 ? "reference" : index === 2 ? "auto" : "unset",
  confidence: index === 2 ? 0.82 : null,
  timezone_conflicts: index === 2 ? 1 : 0,
  needs_review: index === 2,
}));

const JIANYING: JianyingAvailability = { installed_version: "11.4.0", supported: true, reason: "已检测到剪映专业版 11.4" };

// ---------------------------------------------------------------------------
// 状态装配
// ---------------------------------------------------------------------------

function createState(): MockState {
  const clips = buildClips();
  return {
    revision: 1,
    settings: { ...DEFAULT_SETTINGS },
    clips,
    gaps: buildGaps(),
    stacks: buildStacks(),
    segments: [{ id: 901, clip_id: 6, in_ticks: 2000, out_ticks: 9000, tb_num: TB_NUM, tb_den: TB_DEN }],
    player: { phase: "closed", clip_id: null, pos: 0, duration: 0, paused: true, frame: null, error: null, seek_samples: 0, seek_p50_ms: null, seek_p95_ms: null, last_seek_ms: null },
    destinationCards: buildDestinationCards(),
    narrativeRevision: { id: 77, episode_id: EPISODE_ID, kind: "suggested", created_at: "2026-09-10T22:14:00+08:00", pending_undo_count: 0 },
    exportStatus: IDLE_EXPORT,
    generationRequests: [],
    similarGroups: buildSimilarGroups(),
    watchedFolders: [
      { id: 1, path: "/Volumes/TRIP_2026", auto_sync: true, added_at: "2026-08-12T20:00:00+08:00", last_scan_at: "2026-09-11T08:00:00+08:00" },
    ],
    libraries: { active: "default", libraries: [{ id: "default", name: "默认项目库", hidden: false }, { id: "2025-xinjiang", name: "2025 新疆", hidden: false }] },
    episodes: [EPISODE, ARCHIVED_EPISODE],
    undoStack: 0,
    playerTimer: null,
  };
}

let state = createState();
let storyboard = buildStoryboard(state.clips);
const musicAnalysis = buildMusicAnalysis();

export function __resetMockForTests(): void {
  state = createState();
  storyboard = buildStoryboard(state.clips);
}

export function mockRevision(): string {
  return `rev-${state.revision}`;
}

function clipById(id: unknown): ClipListItem {
  const clip = state.clips.find((item) => item.id === id);
  if (!clip) throw new Error(`mock backend: clip ${String(id)} not found`);
  return clip;
}

function num(value: unknown, name: string): number {
  if (typeof value !== "number") throw new Error(`mock backend: argument ${name} must be a number, got ${typeof value}`);
  return value;
}

function str(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`mock backend: argument ${name} must be a string, got ${typeof value}`);
  return value;
}

// ---------------------------------------------------------------------------
// 播放器:假的 mpv,只走时间
// ---------------------------------------------------------------------------

function startPlayerClock(): void {
  if (state.playerTimer !== null) return;
  state.playerTimer = setInterval(() => {
    const player = state.player;
    if (player.phase !== "ready" || player.paused) return;
    player.pos = Math.min(player.duration, player.pos + 0.08);
    player.frame = Math.round(player.pos * 30);
    if (player.pos >= player.duration) player.paused = true;
  }, 80);
}

function playerOpen(clipId: number): PlayerStatus {
  const clip = clipById(clipId);
  const duration = (clip.duration_ticks ?? 0) / 1000;
  state.player = {
    phase: "ready",
    clip_id: clipId,
    pos: 0,
    duration,
    paused: true,
    frame: 0,
    error: null,
    seek_samples: 3,
    seek_p50_ms: 42,
    seek_p95_ms: 88,
    last_seek_ms: 40,
  };
  startPlayerClock();
  return { ...state.player };
}

function playerCommand(cmd: Record<string, unknown>): void {
  const player = state.player;
  if (player.phase !== "ready") return;
  switch (cmd.type) {
    case "play":
      player.paused = false;
      break;
    case "pause":
      player.paused = true;
      break;
    case "step_fwd":
      player.pos = Math.min(player.duration, player.pos + 1 / 30);
      break;
    case "step_back":
      player.pos = Math.max(0, player.pos - 1 / 30);
      break;
    case "seek_abs":
      player.pos = Math.min(player.duration, Math.max(0, num(cmd.seconds, "seconds")));
      player.seek_samples += 1;
      player.last_seek_ms = 38;
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// 命令表
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown;

function noop(): undefined {
  return undefined;
}

function nullPath(): null {
  return null;
}

const HANDLERS: Record<string, Handler> = {
  // --- 应用 / 诊断 ---
  get_media_server_info: () => ({ port: 0, token: "mock" }),
  get_doctor_report: () => DOCTOR,
  restore_latest_snapshot: () => "已从快照 2026-09-10T22-00-00 恢复(mock)",
  export_decision_data: () => "/tmp/tripcut-decisions-mock.json",
  rebuild_recovery_cache: () => "缓存已重建(mock)",
  open_logs_directory: noop,
  get_app_info: () => APP_INFO,
  get_settings: () => ({ ...state.settings }),
  set_setting: ({ key, value }) => {
    state.settings[str(key, "key")] = str(value, "value");
  },
  get_llm_status: () => LLM_STATUS,
  list_llm_ledger: () => [],
  set_minimax_key: noop,
  clear_minimax_key: noop,
  has_minimax_key: () => false,
  generation_availability: () => GENERATION_AVAILABILITY,
  generation_ledger_summary: () => GENERATION_LEDGER,
  describe_clip_with_ai: () => {
    throw new Error("本地 LLM 未启用(mock)");
  },
  get_ai_description: ({ clipId }) =>
    num(clipId, "clipId") % 4 === 0
      ? { clip_id: clipId, description: "清晨的古城街道,青石板路面反着微光,两侧店铺尚未开门,一位早起的居民提着篮子走过。", tags: ["古城", "清晨", "街景", "行人"], provider: "claude" }
      : null,
  ask_director: () => ({ answer: "先把洱海航拍那条当作本章开场,再接喜洲院子的细节。", provider: "claude" }),
  get_settings_status: () => SETTINGS_STATUS,
  clear_cache_and_rebuild: () => ({ removed_database_rows: 0, reset_jobs: 0, removed_disk_bytes: 0 }),
  run_clip_self_check: () => "Chinese-CLIP 自检通过(mock)",

  // --- 导入 ---
  pick_import_folder: nullPath,
  start_import: ({ path }) => ({ folder: str(path, "path"), total: 0, enqueued: 0, skipped: 0 }),
  import_paths: ({ paths }) => (paths as string[]).map((folder) => ({ folder, total: 0, enqueued: 0, skipped: 0 })),
  get_import_progress: () => IMPORT_PROGRESS,
  list_missing_clips: () => MISSING_CLIPS,
  pick_relink_folder: nullPath,
  relink_volume: () => ({ relinked: 0, rejected: [], still_missing: MISSING_CLIPS.length }),
  // 真后端按 id DESC(最新在前)返回,fixture 照此排。
  list_import_batches: () => [...IMPORT_BATCHES].sort((a, b) => b.id - a.id),
  cancel_import_batch: noop,
  dismiss_import_notices: () => 0,
  preview_import_removal: ({ request }) => {
    const r = request as { clip_ids: number[]; all: boolean };
    const count = r.all ? state.clips.length : r.clip_ids.length;
    return { clips: count, favorites: Math.floor(count / 5), selections: Math.floor(count / 6), cache_entries: count * 4 };
  },
  remove_imported_material: () => 0,
  list_watched_folders: () => state.watchedFolders,
  set_watched_folder_sync: ({ id, autoSync }) => {
    const folder = state.watchedFolders.find((item) => item.id === id);
    if (folder) folder.auto_sync = Boolean(autoSync);
  },
  remove_watched_folder: ({ id }) => {
    state.watchedFolders = state.watchedFolders.filter((item) => item.id !== id);
  },
  rescan_watched_folders: () => ({ enqueued: 0, unavailable: 0, scanned: state.clips.length }),

  // --- 素材 ---
  list_clips: () => state.clips.map((clip) => ({ ...clip })),
  get_clips_revision: () => mockRevision(),
  list_device_clocks: () => DEVICE_CLOCKS,
  set_device_clock_offset: noop,
  list_clip_dimensions: () => buildDimensionsCached(),
  set_clip_time_stage: ({ clipId, label }) => {
    const dims = buildDimensionsCached();
    const dim = dims.find((item) => item.clip_id === clipId && item.dimension === "time_stage");
    if (dim) dim.label = str(label, "label");
    bump(state);
  },
  probe_audio_tracks: ({ clipId }) => audioTracksFor(num(clipId, "clipId")),
  list_audio_tracks: ({ clipId }) => audioTracksFor(num(clipId, "clipId")),
  set_display_lut: ({ scope, targetId, path }) => {
    if (scope === "clip") clipById(targetId).display_lut_path = str(path, "path");
    else for (const clip of state.clips) clip.display_lut_path = str(path, "path");
    bump(state);
  },
  clear_display_lut: ({ scope, targetId }) => {
    if (scope === "clip") clipById(targetId).display_lut_path = null;
    else for (const clip of state.clips) clip.display_lut_path = null;
    bump(state);
  },
  set_playback_track: ({ clipId, streamIndex }) => {
    clipById(clipId).selected_monitor_track = num(streamIndex, "streamIndex");
  },
  set_transcribe_track: ({ clipId, streamIndex }) => {
    clipById(clipId).selected_transcribe_track = num(streamIndex, "streamIndex");
  },
  list_display_luts: () => ["~/Library/Application Support/tripcut/luts/DJI_DLog_to_Rec709.cube", "~/Library/Application Support/tripcut/luts/Sony_SLog3_to_Rec709.cube"],
  get_clip_analysis: ({ clipId }) => clipById(clipId).analysis,
  search_transcripts: ({ keyword }) => {
    const key = str(keyword, "keyword");
    if (!key) return [];
    return state.clips
      .filter((clip) => (clip.id as number) % 6 === 1)
      .slice(0, 5)
      .map((clip, index) => ({ clip_id: clip.id as number, seg: index, text: `……我们今天就到${key}这边看看……`, start_ticks: 1200, end_ticks: 4800, tb_num: TB_NUM, tb_den: TB_DEN }));
  },
  get_clip_artifacts: ({ clipId }): ClipArtifacts => ({
    cover: clipById(clipId).cover_url,
    strip: null,
    proxy: null,
    waveform: null,
    statuses: { cover: "ready", strip: "pending", proxy: "pending", waveform: "missing" },
  }),
  search_clips: ({ query }) => {
    const q = str(query, "query");
    if (!q) return [];
    return state.clips
      .filter((clip) => clip.file_name.includes(q) || (clip.id as number) % 7 === 2)
      .slice(0, 12)
      .map((clip, index) => ({ clip_id: clip.id as number, score: Number((0.92 - index * 0.05).toFixed(2)) }));
  },
  search_everything: ({ query }) => {
    const q = str(query, "query");
    if (!q) return [];
    return state.clips
      .filter((clip) => clip.file_name.includes(q))
      .slice(0, 10)
      .map((clip) => ({ kind: "file" as const, clip_id: clip.id as number, file_name: clip.file_name, excerpt: clip.file_name, episode_id: clip.episode_id }));
  },
  list_similar_groups: () => state.similarGroups,
  set_similar_primary: ({ groupId, clipId }) => {
    const group = state.similarGroups.find((item) => item.id === groupId);
    if (group) for (const m of group.members) m.is_primary = m.clip_id === clipId;
  },
  list_shot_stacks: () => state.stacks,
  list_asset_safety: () => buildAssetSafetyCached(),
  apply_rescue_range: ({ clipId }) => {
    const seg: SelectSegment = { id: 900 + state.segments.length + 1, clip_id: num(clipId, "clipId"), in_ticks: 2000, out_ticks: 8000, tb_num: TB_NUM, tb_den: TB_DEN };
    state.segments.push(seg);
    bump(state);
    return seg;
  },
  set_shot_stack_user_state: ({ stackId, clipId, userState }) => {
    const stack = state.stacks.find((item) => item.id === stackId);
    if (!stack) throw new Error(`mock backend: stack ${String(stackId)} not found`);
    for (const m of stack.members) {
      if (m.clip_id === clipId) {
        m.user_state = userState as ShotStackMember["user_state"];
        m.is_preferred = userState === "hero";
      } else if (userState === "hero" && m.user_state === "hero") {
        m.user_state = "auto";
        m.is_preferred = false;
      }
    }
    bump(state);
  },

  // --- 故事板 / 叙事 ---
  get_storyboard: () => ({ ...storyboard, can_undo: state.undoStack > 0, narrative: storyboard.narrative ? { ...storyboard.narrative, destination_cards: state.destinationCards } : null }),
  get_journey_timeline: () => buildJourney(state.clips, state.destinationCards),
  list_story_templates: () => STORY_TEMPLATES,
  enqueue_narrate_episode: () => ({ kind: "revision", id: 78 }),
  update_destination_card: ({ cardId, name, geoContext, highlights, whyVisit, personalNote }) => {
    const card = state.destinationCards.find((item) => item.id === cardId);
    if (!card) throw new Error(`mock backend: destination card ${String(cardId)} not found`);
    Object.assign(card, { name, geo_context: geoContext, highlights, why_visit: whyVisit, personal_note: personalNote });
  },
  set_destination_card_verified: ({ cardId, verified }) => {
    const card = state.destinationCards.find((item) => item.id === cardId);
    if (card) card.verified = Boolean(verified);
  },
  set_destination_field_state: ({ cardId, field, fieldState }) => {
    const card = state.destinationCards.find((item) => item.id === cardId);
    if (card) card.field_states[str(field, "field")] = str(fieldState, "fieldState");
  },
  set_story_order: ({ order }) => {
    const refs = order as { clip_id: number; segment_id: number | null }[];
    refs.forEach((ref, index) => {
      const item = storyboard.items.find((candidate) => candidate.clip_id === ref.clip_id && candidate.segment_id === ref.segment_id);
      if (item) item.position = index;
    });
    state.undoStack += 1;
    bump(state);
  },
  rename_chapter: ({ chapterId, title }) => {
    const chapter = storyboard.chapters.find((item) => item.id === chapterId);
    if (chapter) chapter.title = str(title, "title");
    state.undoStack += 1;
  },
  merge_chapters: () => {
    state.undoStack += 1;
  },
  undo_story_change: () => {
    state.undoStack = Math.max(0, state.undoStack - 1);
  },
  get_narrative_revision: () => state.narrativeRevision,
  apply_narrative_op: ({ op }) => {
    const payload = op as { op: string; chapter_id?: number; title?: string; beat_id?: number; to_chapter_id?: number; to_order?: number };
    const narrative = storyboard.narrative;
    if (narrative && payload.op === "rename_chapter") {
      const chapter = narrative.chapters.find((item) => item.id === payload.chapter_id);
      if (chapter && payload.title) chapter.title = payload.title;
    }
    if (narrative && payload.op === "move_beat") {
      for (const chapter of narrative.chapters) {
        const index = chapter.beats.findIndex((beat) => beat.id === payload.beat_id);
        if (index < 0) continue;
        const [beat] = chapter.beats.splice(index, 1);
        const target = narrative.chapters.find((item) => item.id === payload.to_chapter_id);
        if (beat && target) target.beats.splice(payload.to_order ?? target.beats.length, 0, beat);
        const item = storyboard.items.find((candidate) => candidate.clip_id === beat?.clip_id);
        if (item && target) item.chapter_id = target.id;
        break;
      }
    }
    state.narrativeRevision = { ...state.narrativeRevision, pending_undo_count: state.narrativeRevision.pending_undo_count + 1 };
    bump(state);
    return state.narrativeRevision;
  },
  undo_narrative_op: () => {
    state.narrativeRevision = { ...state.narrativeRevision, pending_undo_count: Math.max(0, state.narrativeRevision.pending_undo_count - 1) };
    return state.narrativeRevision;
  },
  set_routine_override: noop,
  accept_all_routine_suggestions: ({ suggestions }) => (suggestions as unknown[]).length,
  get_memory_lens: () =>
    storyboard.items
      .filter((item) => item.long_term_memory.routine_visual)
      .map((item) => ({ clip_id: item.clip_id, ...item.long_term_memory })),

  // --- 缺口 / 生成 ---
  list_story_gaps: () => state.gaps,
  detect_story_gaps: () => state.gaps.length,
  dismiss_story_gap: ({ gapId }) => {
    const gap = state.gaps.find((item) => item.id === gapId);
    if (gap) gap.status = "dismissed";
    bump(state);
  },
  reopen_story_gap: ({ gapId }) => {
    const gap = state.gaps.find((item) => item.id === gapId);
    if (gap) gap.status = "open";
    bump(state);
  },
  preview_generation: ({ gapId, overrides }) => {
    const gap = state.gaps.find((item) => item.id === gapId);
    const o = overrides as { prompt?: string; model?: string; resolution?: string; duration_s?: number };
    return {
      mode: "t2v",
      model: o.model ?? "MiniMax-H3",
      resolution: o.resolution ?? "768P",
      duration_s: o.duration_s ?? 6,
      ratio: "16:9",
      prompt: o.prompt ?? `${gap?.chapter_title ?? ""}:${gap?.reason ?? ""}`,
      refs: [],
      estimated_cost_usd: 0.42,
      notes: ["云端补镜未启用,仅预览(mock)"],
    };
  },
  submit_generation: () => {
    throw new Error("云端补镜未启用:请先在设置 → 云端补镜里配置 API Key(mock)");
  },
  retry_generation: () => {
    throw new Error("云端补镜未启用(mock)");
  },
  cancel_generation: noop,
  list_generation_requests: () => state.generationRequests,

  // --- 交付 ---
  pick_export_folder: nullPath,
  start_export: ({ dest }) => {
    state.exportStatus = { ...IDLE_EXPORT, job_id: 1, status: "failed", stage: "failed", output_path: str(dest, "dest"), error: "假后端不产出文件(mock)" };
    return state.exportStatus;
  },
  get_export_status: () => {
    if (state.exportStatus.status !== "idle") return state.exportStatus;
    // 空闲态也要报"要交付什么":收藏整条 + 精选段,交付抽屉的计数卡读的就是它。
    const favorites = state.clips.filter((clip) => clip.binary_rating === 1 && !clip.generated_source);
    const segmentSeconds = state.segments.reduce((sum, seg) => sum + (seg.out_ticks - seg.in_ticks) / 1000, 0);
    const wholeSeconds = favorites.reduce((sum, clip) => sum + (clip.duration_ticks ?? 0) / 1000, 0);
    return {
      ...state.exportStatus,
      selected_count: favorites.length + state.segments.length,
      selected_segment_count: state.segments.length,
      selected_whole_count: favorites.length,
      total_duration_seconds: Math.round(segmentSeconds + wholeSeconds),
    };
  },
  cancel_export: noop,
  cancel_job: noop,
  reveal_export: noop,
  get_jianying_availability: () => JIANYING,
  generate_jianying_draft: () => {
    throw new Error("假后端不写剪映草稿(mock)");
  },

  // --- 评级 / 精选段 ---
  rate_clip: ({ clipId, ratingType, value }): ClipRating => {
    const clip = clipById(clipId);
    const v = num(value, "value");
    if (ratingType === "binary") clip.binary_rating = v as ClipListItem["binary_rating"];
    else clip.star_rating = v as ClipListItem["star_rating"];
    bump(state);
    return { clip_id: clip.id as number, segment_id: 0, rating_type: ratingType as ClipRating["rating_type"], value: v, rated_at: new Date().toISOString() };
  },
  clear_clip_rating: ({ clipId }) => {
    const clip = clipById(clipId);
    clip.binary_rating = null;
    clip.star_rating = null;
    bump(state);
  },
  list_select_segments: ({ clipId }) => state.segments.filter((segment) => segment.clip_id === clipId),
  create_select_segment: ({ clipId, inSeconds, outSeconds }) => {
    const seg: SelectSegment = {
      id: 900 + state.segments.length + 1,
      clip_id: num(clipId, "clipId"),
      in_ticks: Math.round(num(inSeconds, "inSeconds") * 1000),
      out_ticks: Math.round(num(outSeconds, "outSeconds") * 1000),
      tb_num: TB_NUM,
      tb_den: TB_DEN,
    };
    state.segments.push(seg);
    clipById(clipId).select_count += 1;
    bump(state);
    return seg;
  },
  delete_select_segment: ({ segmentId }) => {
    state.segments = state.segments.filter((segment) => segment.id !== segmentId);
    bump(state);
  },
  restore_select_segment: noop,

  // --- 播放器 ---
  player_set_viewport: noop,
  player_set_occluded: noop,
  player_open: ({ clipId }) => playerOpen(num(clipId, "clipId")),
  player_close: () => {
    state.player = { ...state.player, phase: "closed", clip_id: null, paused: true };
  },
  player_command: ({ cmd }) => playerCommand(cmd as Record<string, unknown>),
  player_status: () => ({ ...state.player }),

  // --- 集 / 平台 ---
  list_episodes: () => state.episodes,
  get_current_episode: () => state.episodes.find((episode) => episode.status === "active") ?? EPISODE,
  rename_current_episode: ({ title, theme }) => {
    const current = state.episodes.find((episode) => episode.status === "active")!;
    current.title = str(title, "title");
    current.theme = str(theme, "theme");
    return current;
  },
  archive_current_episode: ({ nextTitle, nextPlatform, nextOrientation }) => {
    const current = state.episodes.find((episode) => episode.status === "active")!;
    current.status = "archived";
    current.archived_at = new Date().toISOString();
    const next: EpisodeSummary = {
      ...EPISODE,
      id: current.id + 1,
      title: (nextTitle as string | null) ?? `EP${pad(current.id + 2, 2)} 未命名`,
      episode_number: (current.episode_number ?? 0) + 1,
      clip_count: 0,
      favorite_count: 0,
      export_count: 0,
      target_platform: (nextPlatform as EpisodeSummary["target_platform"] | null) ?? "general",
      canvas_orientation: (nextOrientation as EpisodeSummary["canvas_orientation"] | null) ?? "landscape",
      created_at: new Date().toISOString(),
      archived_at: null,
      status: "active",
    };
    state.episodes.unshift(next);
    bump(state);
    return { archived: current, next };
  },
  list_platform_presets: () => PLATFORM_PRESETS,
  set_episode_platform: ({ episodeId, platform, orientation }) => {
    const episode = state.episodes.find((item) => item.id === episodeId);
    if (episode) {
      episode.target_platform = platform as EpisodeSummary["target_platform"];
      episode.canvas_orientation = orientation as EpisodeSummary["canvas_orientation"];
    }
  },

  // --- OCR ---
  list_ocr_hits: ({ clipId }) =>
    num(clipId, "clipId") % 8 === 0
      ? [{ frame_tick: 3000, tb_num: TB_NUM, tb_den: TB_DEN, text: "沙溪古镇欢迎您", confidence: 0.93, bbox: [120, 80, 640, 140] as [number, number, number, number] }]
      : [],
  enqueue_ocr_for_episode: () => 0,

  // --- 组件安装 ---
  get_component_statuses: () => COMPONENTS,
  start_component_install: noop,
  get_install_progress: ({ component }) => ({ component: str(component, "component"), phase: "idle", downloaded_bytes: 0, total_hint_mb: 0, done: true, error: null }),
  rollback_component: ({ component }) => COMPONENTS.find((item) => item.id === component) ?? COMPONENTS[0],
  cancel_component_install: noop,
  open_provider_login: noop,

  // --- 库 ---
  list_libraries: () => state.libraries,
  create_library: ({ name }) => {
    state.libraries.libraries.push({ id: `lib-${state.libraries.libraries.length + 1}`, name: str(name, "name"), hidden: false });
    return state.libraries;
  },
  set_library_hidden: ({ id, hidden }) => {
    const lib = state.libraries.libraries.find((item) => item.id === id);
    if (lib) lib.hidden = Boolean(hidden);
    return state.libraries;
  },
  switch_library: ({ id }) => {
    state.libraries.active = str(id, "id");
  },

  // --- 音乐 ---
  pick_music_file: nullPath,
  import_music_track: () => MUSIC_TRACK,
  list_music_tracks: () => [MUSIC_TRACK],
  get_music_analysis: () => musicAnalysis,
  delete_music_track: noop,

  // --- R10 车道 B(Rust 核心)追加的命令 ---
  // U-05:画布预览——抖音/小红书/朋友圈竖版,B站/家庭横版,通用跟随素材多数(mock 里按横)。
  preview_export_canvas: ({ overridePlatform, overrideOrientation }) => {
    const platform = (typeof overridePlatform === "string" ? overridePlatform : "general") as PlatformPreset["platform"];
    const preset = PLATFORM_PRESETS.find((item) => item.platform === platform) ?? PLATFORM_PRESETS[0];
    const forced = overrideOrientation === "portrait" || overrideOrientation === "landscape" ? overrideOrientation : null;
    const presetOrientation =
      platform === "douyin" || platform === "xiaohongshu" || platform === "moments" ? "portrait" : "landscape";
    const orientation = forced ?? presetOrientation;
    const [width, height] = orientation === "portrait" ? preset.portrait : preset.landscape;
    return {
      platform,
      display_name: preset.display_name,
      orientation,
      orientation_source: forced ? "override" : platform === "general" ? "fallback" : "preset",
      width,
      height,
    };
  },
  // U-16:新建集——有素材则封存当前集并切换,空集就地改名。
  create_episode: ({ title }) => {
    const name = str(title, "title").trim();
    if (!name) throw new Error("集标题必须为 1-120 字");
    const current = state.episodes.find((item) => item.status === "active");
    if (!current) throw new Error("没有处于进行中的集");
    if (current.clip_count === 0) {
      current.title = name;
      return { episode: current, reused_empty: true, archived: null };
    }
    current.status = "archived";
    current.archived_at = new Date().toISOString();
    const next: EpisodeSummary = {
      ...current,
      id: Math.max(...state.episodes.map((item) => item.id)) + 1,
      title: name,
      theme: "",
      status: "active",
      archived_at: null,
      clip_count: 0,
      favorite_count: 0,
      export_count: 0,
      episode_number: (current.episode_number ?? state.episodes.length) + 1,
    };
    state.episodes.unshift(next);
    return { episode: next, reused_empty: false, archived: current };
  },
  // U-19:状态条音乐分析计数(mock 里唯一一条音乐轨已分析完)。
  get_music_analysis_progress: () => ({ total: 1, done: 1, failed: 0, running: 0, pending: 0 }),
  // U-22:首启引导标记(mock 里当作已完成,截图装置不弹 FIRST RUN)。
  get_first_run_done: () => true,
  set_first_run_done: noop,
  // U-24:导入模型文件(mock 里一律当作校验通过的 large-v3-turbo)。
  import_whisper_model: ({ path }) => ({
    tier: "large-v3-turbo",
    file_name: "ggml-large-v3-turbo.bin",
    target_path: "/Users/mock/Library/Application Support/TripCutStudio/models/ggml-large-v3-turbo.bin",
    sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    matches_active_tier: str(path, "path").length > 0,
  }),
  // U-28:添加 LUT——mock 里把路径的文件名当作新 LUT 追加到列表。
  import_lut: ({ path }) => {
    const source = str(path, "path");
    const fileName = source.split("/").pop() ?? source;
    return [...(handleMockCommand("list_display_luts", {}) as string[]), `/Users/mock/Library/Application Support/TripCutStudio/luts/${fileName}`];
  },
  // R10 接线:两个 rfd 文件选择在 mock 里直接给一条假路径(截图装置不弹系统面板)。
  pick_whisper_model_file: () => "/Users/mock/Downloads/ggml-large-v3-turbo.bin",
  pick_lut_file: () => "/Users/mock/Downloads/Teal-Orange.cube",
  // R11 车道 B:时刻分 / 建议段 / 自动挑选,实现在文件末尾(函数声明提升,故可在此展开)。
  ...momentHandlers(),
  // R11 车道 E:快速导出。plan 按 selection 裁剪出文件清单;quick_export 在 mock 里直接
  // 报"完成"(mode=quick、n 个文件、假路径),抽屉的完成 toast 看的就是它。
  plan_quick_export: ({ destDir, selection }) => quickExportPlan(destDir, selection),
  quick_export: ({ destDir, selection }) => {
    const plan = quickExportPlan(destDir, selection);
    state.exportStatus = {
      ...IDLE_EXPORT,
      job_id: 2,
      status: "done",
      stage: "complete",
      mode: "quick",
      selected_count: plan.files.length,
      selected_segment_count: plan.files.filter((name) => name.includes("_段")).length,
      selected_whole_count: plan.files.filter((name) => !name.includes("_段")).length,
      completed_items: plan.files.length,
      output_path: plan.dir,
      items: plan.files.map((name, index) => ({ clip_id: index, file_name: name, output_name: name, status: "done", note: null, warning: false })),
    };
    return { ...plan, job_id: 2 };
  },
};

function quickExportPlan(destDir: unknown, selection: unknown): QuickExportOutcome {
  const picked = (selection ?? null) as QuickExportSelection | null;
  const segmentIds = picked?.segment_ids ?? null;
  const clipIds = picked?.clip_ids ?? null;
  const unfiltered = segmentIds === null && clipIds === null;
  const favorites = state.clips.filter((clip) => clip.binary_rating === 1 && !clip.generated_source && clip.id !== null);
  const segmentRows = state.segments
    .filter((segment) => unfiltered || (segmentIds ?? []).includes(segment.id) || (clipIds ?? []).includes(segment.clip_id))
    .map((segment) => `${(state.clips.find((clip) => clip.id === segment.clip_id)?.file_name ?? "片段").replace(/\.[^.]+$/, "")}_段${segment.id}.mp4`);
  const wholeRows = favorites
    .filter((clip) => !state.segments.some((segment) => segment.clip_id === clip.id))
    .filter((clip) => unfiltered || (clipIds ?? []).includes(clip.id as number))
    .map((clip) => clip.file_name);
  const files = [...segmentRows, ...wholeRows].map((name, index) => `${String(index + 1).padStart(3, "0")}_${name}`);
  if (files.length === 0) throw new Error("当前没有精选段或收藏素材；请先打点保存片段，或用 F 收藏整条素材");
  const folder = "EP03_导出_2026-09-13";
  return { job_id: null, dir: destDir ? `${str(destDir, "destDir")}/${folder}` : folder, files, skipped: [] };
}

let dimensionsCache: ClipDimension[] | null = null;
function buildDimensionsCached(): ClipDimension[] {
  dimensionsCache ??= buildDimensions(state.clips);
  return dimensionsCache;
}

let safetyCache: AssetSafetyInfo[] | null = null;
function buildAssetSafetyCached(): AssetSafetyInfo[] {
  safetyCache ??= buildAssetSafety(state.clips);
  return safetyCache;
}

function audioTracksFor(clipId: number): ClipAudioTrack[] {
  const clip = clipById(clipId);
  if (clip.analysis?.has_audio === false) return [];
  const tracks: ClipAudioTrack[] = [
    { clip_id: clipId, stream_index: 1, channels: 2, channel_layout: "stereo", sample_rate: 48000, role_guess: "onboard_mic" },
  ];
  if (clipId % 5 === 0) {
    tracks.push({ clip_id: clipId, stream_index: 2, channels: 1, channel_layout: "mono", sample_rate: 48000, role_guess: "wireless_mic" });
  }
  return tracks;
}

// R11 车道 C:半数素材带「有建议段」角标(Rust 尚未给 has_suggestions;车道 B 的时刻分 / 建议段 / 自动挑选在 momentHandlers)。
{
  const baseListClips = HANDLERS.list_clips!;
  HANDLERS.list_clips = (args) =>
    (baseListClips(args) as ClipListItem[]).map((clip) => ({ ...clip, has_suggestions: clip.id !== null && clip.id % 2 === 0 }));
}

/** 已登记的命令名 —— 测试拿它跟 `src/api.ts` 里的 invoke 列表对账。 */
export const MOCK_COMMANDS: readonly string[] = Object.keys(HANDLERS);

export function handleMockCommand(command: string, args: Args): unknown {
  const handler = HANDLERS[command];
  if (!handler) throw new MockCommandMissing(command);
  return handler(args);
}

/**
 * R10 车道 E(U-36)截图开关:`?recovery=1` 让假后端报「异常退出」,应用先走恢复页。
 * 只追加不改上面的表——正常预览路径一个字节都不变。
 */
if (typeof location !== "undefined" && new URLSearchParams(location.search).has("recovery")) {
  HANDLERS.get_doctor_report = () => ({ ...DOCTOR, status: "WARN", abnormal_exit: true, recovered_jobs: 2, cache_missing: 1 });
}

// ---------------------------------------------------------------------------
// R11 车道 B:时刻分与自动挑选(只追加;确定性:按 clipId 种子)
// ---------------------------------------------------------------------------

import type { AutoSelectOutcome, Moment, MomentsProgress, SegmentSuggestion } from "../api";

const MOMENT_WINDOW_TICKS = 500;
const autoBatches = new Map<string, number[]>();

/** 每条素材一条确定性的「山形」曲线:中段高、两头低,第 7 窗一个场景切换。 */
function momentsFor(clipId: number): Moment[] {
  const clip = clipById(clipId);
  const duration = clip.duration_ticks ?? 6000;
  const count = Math.max(1, Math.ceil(duration / MOMENT_WINDOW_TICKS));
  const r = mulberry32(clipId * 7919);
  return Array.from({ length: count }, (_, index) => {
    const phase = index / Math.max(1, count - 1);
    const hill = 1 - Math.abs(phase - 0.55) * 1.6;
    const score = Math.min(1, Math.max(0.05, hill + (r() - 0.5) * 0.15));
    const sharp = Math.min(1, Math.max(0, score + 0.1));
    const motion = 0.1 + r() * 0.3;
    const exposureOk = score > 0.25;
    const loud = clip.analysis?.has_audio !== false && r() > 0.3;
    const speech = loud && r() > 0.5;
    const reasons: string[] = [];
    if (sharp >= 0.6) reasons.push("清晰");
    if (motion >= 0.08 && motion <= 0.6) reasons.push("运动适中");
    if (exposureOk) reasons.push("曝光正常");
    if (speech) reasons.push("有人声");
    else if (loud) reasons.push("有声音");
    return {
      clip_id: clipId,
      win_index: index,
      t_start_ticks: index * MOMENT_WINDOW_TICKS,
      t_end_ticks: Math.min(duration, (index + 1) * MOMENT_WINDOW_TICKS),
      sharp,
      motion,
      exposure_ok: exposureOk,
      loud,
      speech,
      scene_cut: index === 7,
      score,
      reasons,
    };
  });
}

function suggestionsFor(clipId: number, targetSecs: number): SegmentSuggestion[] {
  const moments = momentsFor(clipId);
  const span = Math.max(1, Math.round(targetSecs * 2));
  if (moments.length <= span) {
    const score = moments.reduce((sum, m) => sum + m.score, 0) / moments.length;
    return [{ in_ticks: moments[0]!.t_start_ticks, out_ticks: moments[moments.length - 1]!.t_end_ticks, score, reasons: moments[0]!.reasons }];
  }
  const candidates: Array<{ start: number; score: number }> = [];
  for (let start = 0; start + span <= moments.length; start += 1) {
    if (moments.slice(start + 1, start + span).some((m) => m.scene_cut)) continue;
    const score = moments.slice(start, start + span).reduce((sum, m) => sum + m.score, 0) / span;
    candidates.push({ start, score });
  }
  candidates.sort((a, b) => b.score - a.score || a.start - b.start);
  const picked: number[] = [];
  const out: SegmentSuggestion[] = [];
  for (const candidate of candidates) {
    if (picked.some((p) => Math.abs(p - candidate.start) < span)) continue;
    picked.push(candidate.start);
    const slice = moments.slice(candidate.start, candidate.start + span);
    out.push({
      in_ticks: slice[0]!.t_start_ticks,
      out_ticks: slice[slice.length - 1]!.t_end_ticks,
      score: candidate.score,
      reasons: ["清晰", "运动适中", "曝光正常", "有人声", "有声音"].filter(
        (label) => slice.filter((m) => m.reasons.includes(label)).length * 2 >= slice.length,
      ),
    });
    if (out.length >= 3) break;
  }
  return out;
}

function momentHandlers(): Record<string, Handler> {
  return {
  get_clip_moments: ({ clipId }) => momentsFor(num(clipId, "clipId")),
  suggest_segments: ({ clipId, targetSecs }) =>
    suggestionsFor(num(clipId, "clipId"), typeof targetSecs === "number" && targetSecs > 0 ? targetSecs : 5),
  auto_select_episode: ({ budgetSecs, scope }) => {
    const budget = typeof budgetSecs === "number" && budgetSecs > 0 ? budgetSecs : 60;
    const range = typeof scope === "string" ? scope : "favorites_or_rated3";
    const eligible = state.clips.filter((clip) => {
      if (clip.id === null || clip.generated_source) return false;
      if (state.segments.some((segment) => segment.clip_id === clip.id)) return false;
      if (range === "all") return true;
      if (range === "favorites") return clip.binary_rating === 1;
      if (range === "rated3") return (clip.star_rating ?? 0) >= 3;
      return clip.binary_rating === 1 || (clip.star_rating ?? 0) >= 3;
    });
    if (eligible.length === 0) {
      throw new Error("这个范围里没有可挑的素材:先收藏几条或给素材打星,等分析跑完再试;或把范围改成「全部」");
    }
    const byChapter = new Map<number | null, ClipListItem[]>();
    for (const clip of eligible) {
      const key = chapterOfClip(clip);
      byChapter.set(key, [...(byChapter.get(key) ?? []), clip]);
    }
    const batchId = `auto-mock-${autoBatches.size + 1}`;
    const created: number[] = [];
    const chapters = new Set<number | null>();
    let total = 0;
    let progressed = true;
    const cursors = new Map<number | null, number>();
    while (progressed) {
      progressed = false;
      for (const [key, clips] of byChapter) {
        const cursor = cursors.get(key) ?? 0;
        if (cursor >= clips.length) continue;
        cursors.set(key, cursor + 1);
        const clip = clips[cursor]!;
        const best = suggestionsFor(clip.id as number, 5)[0];
        if (!best) continue;
        const secs = (best.out_ticks - best.in_ticks) / 1000;
        if (total + secs > budget) continue;
        const seg: SelectSegment = {
          id: 900 + state.segments.length + 1,
          clip_id: clip.id as number,
          in_ticks: best.in_ticks,
          out_ticks: best.out_ticks,
          tb_num: TB_NUM,
          tb_den: TB_DEN,
        };
        state.segments.push(seg);
        clip.select_count += 1;
        created.push(seg.id);
        chapters.add(key);
        total += secs;
        progressed = true;
      }
    }
    autoBatches.set(batchId, created);
    bump(state);
    const outcome: AutoSelectOutcome = { created, total_secs: total, chapters_covered: chapters.size, batch_id: batchId };
    return outcome;
  },
  undo_auto_select: ({ batchId }) => {
    const ids = autoBatches.get(str(batchId, "batchId")) ?? [];
    const before = state.segments.length;
    for (const segment of state.segments.filter((segment) => ids.includes(segment.id))) {
      clipById(segment.clip_id).select_count = Math.max(0, clipById(segment.clip_id).select_count - 1);
    }
    state.segments = state.segments.filter((segment) => !ids.includes(segment.id));
    autoBatches.delete(str(batchId, "batchId"));
    bump(state);
    return before - state.segments.length;
  },
  get_moments_progress: (): MomentsProgress => ({ total: CLIP_COUNT, done: CLIP_COUNT - 3, failed: 0, running: 1, pending: 2 }),
  enqueue_moments_backfill: () => 0,
  };
}

// ---------------------------------------------------------------------------
// R11 简化专项(车道 simplify)截图开关:`?empty=1` 让素材库为空 —— 预览区显示首启三步引导卡。
// 只追加不改上面的表;正常预览路径一个字节都不变。
// ---------------------------------------------------------------------------
if (typeof location !== "undefined" && new URLSearchParams(location.search).has("empty")) {
  HANDLERS.list_clips = () => [];
  HANDLERS.list_shot_stacks = () => [];
  HANDLERS.get_storyboard = () => ({
    chapters: [], candidates: [], items: [], can_undo: false, mode: "legacy", mode_notice: "", narrative: null, narration_job_status: null, current_template: null,
  });
  HANDLERS.list_story_gaps = () => [];
  HANDLERS.list_clip_dimensions = () => [];
}
