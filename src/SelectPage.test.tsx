// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

type OcrTextHitStub = {
  frame_tick: number;
  tb_num: number;
  tb_den: number;
  text: string;
  confidence: number;
  bbox: [number, number, number, number];
};

const apiMocks = vi.hoisted(() => ({
  applyRescueRange: vi.fn(),
  askDirector: vi.fn(),
  clearClipRating: vi.fn(),
  createSelectSegment: vi.fn(),
  deleteSelectSegment: vi.fn(),
  listSimilarGroups: vi.fn().mockResolvedValue([]),
  setSimilarPrimary: vi.fn().mockResolvedValue(undefined),
  listAudioTracks: vi.fn().mockResolvedValue([]),
  probeAudioTracks: vi.fn().mockResolvedValue([]),
  listDisplayLuts: vi.fn().mockResolvedValue([]),
  setDisplayLut: vi.fn().mockResolvedValue(undefined),
  clearDisplayLut: vi.fn().mockResolvedValue(undefined),
  setPlaybackTrack: vi.fn().mockResolvedValue(undefined),
  setTranscribeTrack: vi.fn().mockResolvedValue(undefined),
  restoreSelectSegment: vi.fn(),
  describeClipWithAi: vi.fn(),
  getAiDescription: vi.fn(async () => null),
  getClipArtifacts: vi.fn(async () => null),
  getMemoryLens: vi.fn(async () => []),
  getCurrentEpisode: vi.fn(async () => ({
    id: 1,
    title: "EP01",
    theme: "",
    episode_number: 1,
    status: "active",
    created_at: "",
    archived_at: null,
    clip_count: 0,
    favorite_count: 0,
    export_count: 0,
    target_platform: "general",
    canvas_orientation: "landscape",
  })),
  getNarrativeRevision: vi.fn(async () => null),
  getLlmStatus: vi.fn(),
  getSettings: vi.fn(),
  listAssetSafety: vi.fn(),
  listClipDimensions: vi.fn(),
  listClips: vi.fn(),
  listSelectSegments: vi.fn(),
  listShotStacks: vi.fn(),
  listOcrHits: vi.fn(async (): Promise<OcrTextHitStub[]> => []),
  rateClip: vi.fn(),
  searchClips: vi.fn(),
  searchTranscripts: vi.fn(),
  setClipTimeStage: vi.fn(),
  setShotStackUserState: vi.fn(),
}));

vi.mock("./api", () => apiMocks);
vi.mock("./PlayerOverlay", () => ({
  formatTimecode: () => "00:00:00.000",
  PlayerOverlay: () => null,
}));
vi.mock("./Storyboard", () => ({ StoryboardView: () => null }));

import {
  SelectPage,
  filmRowTop,
  filmRowAtOffset,
  FILM_GRID_MIN_WIDTH,
  applyRatingAction,
  buildShotStackWallItems,
  filterClipsByDimension,
  filterClipsByOrientation,
  filterSelectionClips,
  filmGridColumnCount,
  filterSearchHitsToVisibleClips,
  isFilmGridShortcutTarget,
  isPortraitClip,
  matchPercentage,
  nextShotStackClipId,
  ratingActionForKey,
  replaceShotStackMemberState,
  stripFrameCount,
  transcriptTimeLabel,
} from "./SelectPage";
import type {
  BestTakeBreakdown,
  ClipDimension,
  ClipListItem,
  OcrTextHit,
  SelectSegment,
  ShotStack,
} from "./api";

function clip(
  id: number,
  rating: { binary?: -1 | 0 | 1; star?: 0 | 1 | 2 | 3 | 4 | 5 } = {},
): ClipListItem {
  return {
    id,
    episode_id: 1,
    folder_label: null,
    cover_url: `http://127.0.0.1/cache/${id}/cover.jpg?expires=9999999999&signature=test`,
    path: `/Volumes/CARD/clip-${id}.mov`,
    file_name: `clip-${id}.mov`,
    byte_size: 2048,
    quick_hash: `quick-${id}`,
    full_hash: null,
    tb_num: 1,
    tb_den: 1000,
    duration_ticks: 30_000,
    fps_num: 25,
    fps_den: 1,
    is_vfr: false,
    codec: "h264",
    width: 1920,
    height: 1080,
    captured_at: "2026-08-31T12:00:00Z",
    status: "ready",
    error: null,
    analysis: null,
    analysis_status: null,
    analysis_error: null,
    motion: null,
    motion_status: null,
    motion_error: null,
    binary_rating: rating.binary ?? null,
    star_rating: rating.star ?? null,
    select_count: 0,
  };
}

const breakdown: BestTakeBreakdown = {
  technical: { score: 0.8, confidence: 1, source: "test", note: "test" },
  composition: { score: 0.7, confidence: 0.7, source: "test", note: "启发式代理" },
  motion: { score: 0.9, confidence: 1, source: "test", note: "test" },
  human: { score: null, confidence: 0, source: "test", note: "test" },
  audio: { score: 0.6, confidence: 0.8, source: "test", note: "test" },
  narrative: { score: null, confidence: 0, source: "test", note: "待回填" },
  configured_weights: {
    technical: 0.28,
    composition: 0.18,
    motion: 0.2,
    human: 0.14,
    audio: 0.12,
    narrative: 0.08,
  },
  preference_boost: 0,
  total: 0.76,
};

const emptyLongTermMemory = {
  used_episode_badges: [],
  repeated_signature_uses: 0,
  recent_episode_window: 4,
  routine_visual: false,
  novelty_context: false,
  narrative_adjustment: 0,
  routine_suggestion: null,
};

function shotStack(
  stackType: ShotStack["stack_type"] = "visual",
  qualityExempt = false,
): ShotStack {
  return {
    id: 12,
    scene_id: 3,
    scene_name: "冰原大道 · 风景/Atmosphere",
    stack_type: stackType,
    subject_label: stackType === "human" ? "人" : "风景",
    function_label: stackType === "information" ? "Information" : "Atmosphere",
    shot_size_label: "广角",
    movement_label: "Static",
    quality_exempt: qualityExempt,
    members: [
      {
        clip_id: 1,
        segment_id: null,
        best_take_score: 0.76,
        score_breakdown: breakdown,
        user_state: "auto",
        is_preferred: true,
        long_term_memory: emptyLongTermMemory,
      },
      {
        clip_id: 2,
        segment_id: null,
        best_take_score: 0.71,
        score_breakdown: { ...breakdown, total: 0.71 },
        user_state: "auto",
        is_preferred: false,
        long_term_memory: emptyLongTermMemory,
      },
    ],
  };
}

describe("selection workbench", () => {
  it("maps every rating key to its append-only action", () => {
    expect(["f", "X", "1", "5", "0"].map((key) => ratingActionForKey(key, false))).toEqual([
      { kind: "binary", value: 1 },
      { kind: "binary", value: -1 },
      { kind: "star", value: 1 },
      { kind: "star", value: 5 },
      { kind: "clear" },
    ]);
  });

  it("uses a real 280px minimum grid and adds columns as the wall grows", () => {
    expect(FILM_GRID_MIN_WIDTH).toBe(280);
    expect(filmGridColumnCount(580)).toBe(1);
    expect(filmGridColumnCount(612)).toBe(2);
    expect(filmGridColumnCount(906)).toBe(3);
  });

  it("ignores rating keys while an IME composition is active", () => {
    expect(ratingActionForKey("f", true)).toBeNull();
    expect(ratingActionForKey("5", true)).toBeNull();
  });

  it("does not treat keyboard events from interactive descendants as film-grid shortcuts", () => {
    const buttonLabel = document.createElement("span");
    const button = document.createElement("button");
    button.append(buttonLabel);
    const grid = document.createElement("div");

    expect(isFilmGridShortcutTarget(buttonLabel, grid)).toBe(false);
    expect(isFilmGridShortcutTarget(grid, grid)).toBe(true);
  });

  it("filters favorites, unrated and rejected with stable counts", () => {
    const clips = [clip(1, { binary: 1 }), clip(2), clip(3, { star: 4 }), clip(4, { binary: -1 })];

    expect(filterSelectionClips(clips, "favorite", false)).toHaveLength(1);
    expect(filterSelectionClips(clips, "unrated", false)).toHaveLength(1);
    expect(filterSelectionClips(clips, "rejected", false)).toHaveLength(1);
    expect(filterSelectionClips(clips, "all", false)).toHaveLength(4);
  });

  it("stacks an eight-dimension label filter on an existing clip list", () => {
    const dimensions: ClipDimension[] = [
      { clip_id: 1, dimension: "function", label: "Orientation", score: 0.42, source: "test" },
      { clip_id: 2, dimension: "function", label: "Experience", score: 0.51, source: "test" },
    ];

    expect(filterClipsByDimension([clip(1), clip(2)], dimensions, "function", "Orientation"))
      .toHaveLength(1);
    expect(filterClipsByDimension([clip(1), clip(2)], dimensions, "", ""))
      .toHaveLength(2);
  });

  it("determines portrait orientation from rotation XOR decoded aspect ratio", () => {
    // 解码尺寸是 landscape(1920x1080,来自 clip() 默认值);旋转 90/270 → 竖屏。
    expect(isPortraitClip({ ...clip(1), rotation: 90, width: 1920, height: 1080 })).toBe(true);
    expect(isPortraitClip({ ...clip(1), rotation: 270, width: 1920, height: 1080 })).toBe(true);
    expect(isPortraitClip({ ...clip(1), rotation: 0, width: 1920, height: 1080 })).toBe(false);
    expect(isPortraitClip({ ...clip(1), rotation: null, width: 1920, height: 1080 })).toBe(false);
    // 解码尺寸本身已是竖屏(如手机竖握无 side_data 的罕见情况);无旋转仍是竖屏。
    expect(isPortraitClip({ ...clip(1), rotation: null, width: 1080, height: 1920 })).toBe(true);
    // 已是竖屏尺寸,又转 90/270 → 变回横屏。
    expect(isPortraitClip({ ...clip(1), rotation: 90, width: 1080, height: 1920 })).toBe(false);
  });

  it("filters the clip list by orientation toggle", () => {
    const landscape = clip(1);
    const portrait = { ...clip(2), rotation: 90 };
    const clips = [landscape, portrait];

    expect(filterClipsByOrientation(clips, "all")).toHaveLength(2);
    expect(filterClipsByOrientation(clips, "portrait")).toEqual([portrait]);
    expect(filterClipsByOrientation(clips, "landscape")).toEqual([landscape]);
  });

  it("removes raw search hits that are hidden by the active combined filters", () => {
    const visibleIds = new Set([2]);
    const hits = [
      { clip_id: 1, score: 0.91 },
      { clip_id: 2, score: 0.72 },
    ];

    expect(filterSearchHitsToVisibleClips(hits, visibleIds).map((hit) => hit.clip_id)).toEqual([2]);
  });

  it("excludes only the calibrated suspected-waste badge set", () => {
    // R14:疑似废片看后端联合判定的欠曝占比,不看平均亮度(夜景平均亮度也低)。
    const dark = clip(1);
    dark.analysis_status = "done";
    dark.analysis = {
      clip_id: 1,
      exposure_yavg: 20,
      overexposed_ratio: 0,
      underexposed_ratio: 0.3,
      dynamic_range: 100,
      blur_mean: 4,
      entropy_mean: 6,
      motion_mean: 5,
      out_of_focus_ratio: 0,
      audio_peak_db: null,
      audio_clipped: false,
      has_audio: true,
      focus_scores: [100],
      scene_count: 1,
      analyzed_at: "2026-08-31T12:00:00Z",
      tool_versions: {},
    };
    const silent = clip(2);
    silent.analysis_status = "done";
    silent.analysis = { ...dark.analysis, clip_id: 2, exposure_yavg: 80, underexposed_ratio: 0, has_audio: false };

    expect(filterSelectionClips([dark, silent], "all", true).map((item) => item.id)).toEqual([2]);
    expect(filterSelectionClips([dark, silent], "all", true, new Set([1])).map((item) => item.id))
      .toEqual([1, 2]);
  });

  it("clears binary and star markers together in optimistic state", () => {
    const cleared = applyRatingAction(clip(9, { binary: 1, star: 5 }), { kind: "clear" });

    expect([cleared.binary_rating, cleared.star_rating]).toEqual([0, 0]);
  });

  it("uses the thumbnail generator five-second rule and twelve-frame cap", () => {
    expect(stripFrameCount(clip(1))).toBe(6);
    expect(stripFrameCount({ ...clip(2), duration_ticks: 600_000 })).toBe(12);
  });

  it("formats transcript source ticks as a searchable timecode", () => {
    expect(
      transcriptTimeLabel({
        clip_id: 1,
        seg: 2,
        text: "城墙",
        start_ticks: 65_500,
        end_ticks: 66_000,
        tb_num: 1,
        tb_den: 1_000,
      }),
    ).toBe("1:05");
  });

  it("shows raw cosine as a clamped percentage without changing sort semantics", () => {
    expect(matchPercentage(0.327)).toBe(33);
    expect(matchPercentage(-0.2)).toBe(0);
    expect(matchPercentage(1.2)).toBe(100);
  });

  it("folds the wall from semantic Shot Stacks instead of C4 primary flags", () => {
    const items = buildShotStackWallItems(
      [clip(1), clip(2), clip(3)],
      [clip(1), clip(2), clip(3)],
      [shotStack()],
      false,
    );

    expect(items.map((item) => item.clip.id)).toEqual([1, 3]);
    expect(items[0].stack?.function_label).toBe("Atmosphere");
  });

  it("shows the semantic score of the visible Stack representative, not a hidden member", () => {
    const items = buildShotStackWallItems(
      [clip(1), clip(2)],
      [clip(1), clip(2)],
      [shotStack()],
      true,
      new Map([[1, 0.31], [2, 0.94]]),
    );

    expect(items[0].clip.id).toBe(1);
    expect(items[0].semanticScore).toBe(0.31);
  });

  it("keeps information and human Stack exemption metadata visible", () => {
    const information = shotStack("information", true);
    const item = buildShotStackWallItems(
      [clip(1), clip(2)],
      [clip(1), clip(2)],
      [information],
      false,
    )[0];

    expect(item.stack?.quality_exempt).toBe(true);
    expect(item.stack?.stack_type).toBe("information");
    expect(buildShotStackWallItems(
      [clip(1), clip(2)],
      [clip(1), clip(2)],
      [information],
      true,
    )[0].stack?.quality_exempt).toBe(true);
  });

  it("optimistically locks one Stack member without deleting rejected members", () => {
    const stack = shotStack();
    stack.members[0].user_state = "rejected";
    const updated = replaceShotStackMemberState([stack], 12, 2, "locked")[0];

    expect(updated.members.find((member) => member.clip_id === 2)?.user_state).toBe("locked");
    expect(updated.members.find((member) => member.clip_id === 1)?.user_state).toBe("rejected");
    expect(updated.members).toHaveLength(2);
  });

  it("keeps an all-rejected Stack inspectable without inventing a preferred member", () => {
    const stack = shotStack();
    stack.members = stack.members.map((member) => ({
      ...member,
      user_state: "rejected",
      is_preferred: false,
    }));

    const items = buildShotStackWallItems(
      [clip(1), clip(2)],
      [clip(1), clip(2)],
      [stack],
      true,
    );

    expect(items[0].stack?.members.every((member) => !member.is_preferred)).toBe(true);
    expect(items[0].stack?.members).toHaveLength(2);
  });

  it("cycles Stack candidates with Arrow semantics without changing preference", () => {
    const stack = shotStack();

    expect(nextShotStackClipId(stack, 1, 1)).toBe(2);
    expect(nextShotStackClipId(stack, 1, -1)).toBe(2);
    expect(stack.members[0].is_preferred).toBe(true);
  });

  it("renders the filter bar and loading state before the first database response", () => {
    const markup = renderToStaticMarkup(<SelectPage />);

    expect(markup).toContain("排除普通疑似废片");
    expect(markup).toContain("只看 Stack 首选");
    expect(markup).toContain("竖屏");
    expect(markup).toContain("展开 Stack");
    expect(markup).toContain("替换首选");
    expect(markup).toContain("八维筛选");
    expect(markup).toContain("选择维度");
    expect(markup).toContain("正在整理你的胶片墙");
    expect(markup).toContain("LIBRARY");
    expect(markup).toContain("CHINESE-CLIP · LOCAL");
    expect(markup).toContain("故事板");
    expect(markup).toContain("ROUGH CUT");
    expect(markup).toContain("1–5");
    expect(markup).toContain("搜索画面或对白关键词");
    expect(markup).toContain("批量 AI 描述");
    expect(markup).not.toContain("DIRECTOR Q&amp;A");
    expect(markup.match(/type="search"/g)).toHaveLength(1);
  });
});

describe("expanded candidate row virtualization", () => {
  it("reserves space without displacing earlier rows", () => {
    expect(filmRowTop(1, 1)).toBe(260);
    expect(filmRowTop(2, 1)).toBe(820);
    expect(filmRowTop(2, null)).toBe(520);
  });
  it("keeps the expanded card mounted across the entire detail range", () => {
    expect(filmRowAtOffset(519, 1)).toBe(1);
    expect(filmRowAtOffset(520, 1)).toBe(1);
    expect(filmRowAtOffset(819, 1)).toBe(1);
    expect(filmRowAtOffset(820, 1)).toBe(2);
    expect(filmRowAtOffset(900, null)).toBe(3);
  });
});

describe("select segment delete undo toast", () => {
  const readyClip: ClipListItem = clip(7);
  const segment: SelectSegment = {
    id: 42,
    clip_id: 7,
    in_ticks: 0,
    out_ticks: 5_000,
    tb_num: 1,
    tb_den: 1_000,
  };

  const mounted: Array<{ container: HTMLDivElement; root: ReturnType<typeof createRoot> }> = [];

  afterEach(async () => {
    while (mounted.length > 0) {
      const current = mounted.pop();
      if (!current) continue;
      await act(async () => current.root.unmount());
      current.container.remove();
    }
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function mountSelectPageWithOneSegment() {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    apiMocks.listAssetSafety.mockResolvedValue([]);
    apiMocks.listClips.mockResolvedValue([readyClip]);
    apiMocks.listClipDimensions.mockResolvedValue([]);
    apiMocks.listShotStacks.mockResolvedValue([]);
    apiMocks.listSelectSegments.mockResolvedValue([segment]);
    apiMocks.getSettings.mockResolvedValue({ llm_enabled: "false" });
    apiMocks.getLlmStatus.mockResolvedValue({ enabled: false });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ container, root });

    await act(async () => {
      root.render(<SelectPage />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const deleteButton = container.querySelector(
      'button[aria-label="删除精选段 1"]',
    ) as HTMLButtonElement | null;
    expect(deleteButton).toBeTruthy();
    return { container, deleteButton: deleteButton! };
  }

  function findUndoButton(container: HTMLDivElement) {
    return Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "撤销",
    );
  }

  it("shows a 撤销 button after delete and restores the segment on click", async () => {
    vi.useFakeTimers();
    apiMocks.deleteSelectSegment.mockResolvedValue(undefined);
    apiMocks.restoreSelectSegment.mockResolvedValue(undefined);
    const { container, deleteButton } = await mountSelectPageWithOneSegment();

    apiMocks.listSelectSegments.mockResolvedValue([]);
    await act(async () => {
      deleteButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.deleteSelectSegment).toHaveBeenCalledWith(segment.id);
    expect(container.textContent).toContain("已删除精选段，撤销");
    const undoButton = findUndoButton(container);
    expect(undoButton).toBeTruthy();

    apiMocks.listSelectSegments.mockResolvedValue([segment]);
    await act(async () => {
      undoButton!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.restoreSelectSegment).toHaveBeenCalledWith(segment.id);
    expect(findUndoButton(container)).toBeFalsy();
  });

  it("hides the 撤销 button 10 seconds after delete without restoring", async () => {
    vi.useFakeTimers();
    apiMocks.deleteSelectSegment.mockResolvedValue(undefined);
    const { container, deleteButton } = await mountSelectPageWithOneSegment();

    apiMocks.listSelectSegments.mockResolvedValue([]);
    await act(async () => {
      deleteButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findUndoButton(container)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(findUndoButton(container)).toBeFalsy();
    expect(apiMocks.restoreSelectSegment).not.toHaveBeenCalled();
  });
});

describe("R5 Task 5: OCR badge on the selection inspector", () => {
  const readyClip: ClipListItem = clip(9);

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows 画面文字 with the first two recognized texts when listOcrHits returns hits", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    apiMocks.listAssetSafety.mockResolvedValue([]);
    apiMocks.listClips.mockResolvedValue([readyClip]);
    apiMocks.listClipDimensions.mockResolvedValue([]);
    apiMocks.listShotStacks.mockResolvedValue([]);
    apiMocks.listSelectSegments.mockResolvedValue([]);
    apiMocks.getSettings.mockResolvedValue({ llm_enabled: "false" });
    apiMocks.getLlmStatus.mockResolvedValue({ enabled: false });
    const hits: OcrTextHit[] = [
      { frame_tick: 0, tb_num: 1, tb_den: 1000, text: "旅剪", confidence: 0.9, bbox: [0, 0, 0.2, 0.2] },
      { frame_tick: 1000, tb_num: 1, tb_den: 1000, text: "TripCut", confidence: 0.8, bbox: [0, 0, 0.2, 0.2] },
      { frame_tick: 2000, tb_num: 1, tb_den: 1000, text: "第三条", confidence: 0.7, bbox: [0, 0, 0.2, 0.2] },
    ];
    apiMocks.listOcrHits.mockResolvedValue(hits);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<SelectPage />);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(apiMocks.listOcrHits).toHaveBeenCalledWith(readyClip.id);
      const badge = container.querySelector(".ocr-badge");
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toContain("画面文字：旅剪、TripCut");
      expect(badge?.textContent).not.toContain("第三条");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("renders no badge when the clip has no OCR hits", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    apiMocks.listAssetSafety.mockResolvedValue([]);
    apiMocks.listClips.mockResolvedValue([readyClip]);
    apiMocks.listClipDimensions.mockResolvedValue([]);
    apiMocks.listShotStacks.mockResolvedValue([]);
    apiMocks.listSelectSegments.mockResolvedValue([]);
    apiMocks.getSettings.mockResolvedValue({ llm_enabled: "false" });
    apiMocks.getLlmStatus.mockResolvedValue({ enabled: false });
    apiMocks.listOcrHits.mockResolvedValue([]);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<SelectPage />);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.querySelector(".ocr-badge")).toBeFalsy();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("R6 终审 P1-8: tripcut:select-clip must clear a stale viewingEpisode", () => {
  // `getCurrentEpisode` mock（文件顶部）返回 id: 1 —— 这就是"当前集"。
  const currentEpisodeClip = clip(1);
  const historicalEpisodeClip: ClipListItem = { ...clip(2), episode_id: 2 };

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function mountWithTwoEpisodes() {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    apiMocks.listAssetSafety.mockResolvedValue([]);
    apiMocks.listClips.mockResolvedValue([currentEpisodeClip, historicalEpisodeClip]);
    apiMocks.listClipDimensions.mockResolvedValue([]);
    apiMocks.listShotStacks.mockResolvedValue([]);
    apiMocks.listSelectSegments.mockResolvedValue([]);
    apiMocks.getSettings.mockResolvedValue({ llm_enabled: "false" });
    apiMocks.getLlmStatus.mockResolvedValue({ enabled: false });
    apiMocks.listOcrHits.mockResolvedValue([]);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<SelectPage />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // 切到历史集只读视图(EpisodePanel 点历史集时发的事件)。
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("tripcut:view-episode", { detail: { id: 2, title: "EP02" } }),
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain("正在只读查看已封存集「EP02」");

    return { container, root };
  }

  it("clears viewingEpisode and selects the target when it belongs to the current episode", async () => {
    const { container, root } = await mountWithTwoEpisodes();
    try {
      // 跳转目标(clip 1)属于当前集,不属于正在只读查看的 EP02。
      await act(async () => {
        window.dispatchEvent(new CustomEvent("tripcut:select-clip", { detail: 1 }));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.textContent).not.toContain("正在只读查看已封存集");
      const grid = container.querySelector('[role="grid"]');
      expect(grid?.getAttribute("aria-activedescendant")).toBe("select-clip-1");
      expect(document.getElementById("select-clip-1")).toBeTruthy();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("keeps the historical read-only view when the jump target belongs to that historical episode", async () => {
    const { container, root } = await mountWithTwoEpisodes();
    try {
      // 跳转目标(clip 2)本来就属于正在查看的 EP02——这条路径此前就应该正常工作。
      await act(async () => {
        window.dispatchEvent(new CustomEvent("tripcut:select-clip", { detail: 2 }));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.textContent).toContain("正在只读查看已封存集「EP02」");
      const grid = container.querySelector('[role="grid"]');
      expect(grid?.getAttribute("aria-activedescendant")).toBe("select-clip-2");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("R7 Task 7: AI 生成素材徽章", () => {
  const mounted: Array<{ container: HTMLDivElement; root: ReturnType<typeof createRoot> }> = [];

  afterEach(async () => {
    while (mounted.length > 0) {
      const current = mounted.pop();
      if (!current) continue;
      await act(async () => current.root.unmount());
      current.container.remove();
    }
    vi.clearAllMocks();
  });

  it('shows "AI 生成" only for clips with generated_source set, not real footage', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const realClip = clip(1);
    const generatedClip: ClipListItem = { ...clip(2), generated_source: "minimax" };
    apiMocks.listAssetSafety.mockResolvedValue([]);
    apiMocks.listClips.mockResolvedValue([realClip, generatedClip]);
    apiMocks.listClipDimensions.mockResolvedValue([]);
    apiMocks.listShotStacks.mockResolvedValue([]);
    apiMocks.listSelectSegments.mockResolvedValue([]);
    apiMocks.getSettings.mockResolvedValue({ llm_enabled: "false" });
    apiMocks.getLlmStatus.mockResolvedValue({ enabled: false });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ container, root });

    await act(async () => {
      root.render(<SelectPage />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const realCard = container.querySelector("#select-clip-1");
    const generatedCard = container.querySelector("#select-clip-2");
    expect(realCard?.querySelector(".generated-source-badge")).toBeNull();
    expect(generatedCard?.querySelector(".generated-source-badge")).not.toBeNull();
    expect(generatedCard?.textContent).toContain("AI 生成");
  });
});
