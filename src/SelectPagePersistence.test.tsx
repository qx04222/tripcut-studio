// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SelectPage } from "./SelectPage";
import type { ClipListItem } from "./api";

const apiMocks = vi.hoisted(() => ({
  applyRescueRange: vi.fn(),
  askDirector: vi.fn(),
  clearClipRating: vi.fn(),
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
  describeClipWithAi: vi.fn(),
  getAiDescription: vi.fn(),
  getClipArtifacts: vi.fn(),
  getClipsRevision: vi.fn(),
  getMemoryLens: vi.fn(async () => []),
  getCurrentEpisode: vi.fn(async () => ({ id: 1, title: "EP01", theme: "", episode_number: 1, status: "active", created_at: "", archived_at: null, clip_count: 0, favorite_count: 0, export_count: 0, target_platform: "general", canvas_orientation: "landscape" })),
  getNarrativeRevision: vi.fn(async () => null),
  getLlmStatus: vi.fn(),
  getSettings: vi.fn(),
  listAssetSafety: vi.fn(),
  listClipDimensions: vi.fn(),
  listClips: vi.fn(),
  listSelectSegments: vi.fn(),
  listShotStacks: vi.fn(),
  listOcrHits: vi.fn(async () => []),
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

const readyClip: ClipListItem = {
  id: 7,
  episode_id: 1,
    folder_label: null,
  cover_url: null,
  path: "/Volumes/CARD/clip-7.mov",
  file_name: "clip-7.mov",
  byte_size: 2_048,
  quick_hash: "quick-7",
  full_hash: null,
  tb_num: 1,
  tb_den: 1_000,
  duration_ticks: 10_000,
  fps_num: 30,
  fps_den: 1,
  is_vfr: false,
  codec: "h264",
  width: 1_920,
  height: 1_080,
  captured_at: null,
  status: "ready",
  error: null,
  analysis: null,
  analysis_status: null,
  analysis_error: null,
  motion: null,
  motion_status: null,
  motion_error: null,
  binary_rating: null,
  star_rating: null,
  select_count: 0,
};

const mounted: Array<{ container: HTMLDivElement; root: ReturnType<typeof createRoot> }> = [];

beforeEach(() => {
  // 默认拿不到修订号就退回全量拉取——保持这份文件里既有用例"每轮都全量拉取"
  // 的既有行为。想测跳过逻辑的用例自己在测试体内覆盖成 mockResolvedValue。
  apiMocks.getClipsRevision.mockRejectedValue(new Error("clips revision not mocked in this test"));
});

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

describe("persisted AI description reload", () => {
  it("loads the saved description when the selected clip changes", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    apiMocks.listAssetSafety.mockResolvedValue([]);
    apiMocks.listClips.mockResolvedValue([readyClip]);
    apiMocks.listClipDimensions.mockResolvedValue([]);
    apiMocks.listShotStacks.mockResolvedValue([]);
    apiMocks.listSelectSegments.mockResolvedValue([]);
    apiMocks.getSettings.mockResolvedValue({ llm_enabled: "true" });
    apiMocks.getLlmStatus.mockResolvedValue({
      enabled: true,
      provider: "codex",
      monthly_budget: 200,
      calls_this_month: 1,
      remaining_calls: 199,
      budget_exhausted: false,
      providers: [],
    });
    apiMocks.getAiDescription.mockResolvedValue({
      clip_id: 7,
      description: "上次生成并已落库的描述",
      tags: ["旅行", "稳定", "横摇"],
      provider: "codex",
    });
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

    expect(apiMocks.getAiDescription).toHaveBeenCalledWith(7);
    expect(container.textContent).toContain("上次生成并已落库的描述");
  });
});

describe("empty selection inspector", () => {
  it("does not mistake an unreadable null-id import for the empty selection", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    apiMocks.listAssetSafety.mockResolvedValue([]);
    apiMocks.listClips.mockResolvedValue([
      {
        ...readyClip,
        id: null,
        status: "unreadable",
        path: "/Volumes/CARD/broken.mts",
        file_name: "broken.mts",
        error: "ffprobe failed",
      },
    ]);
    apiMocks.listClipDimensions.mockResolvedValue([]);
    apiMocks.listShotStacks.mockResolvedValue([]);
    apiMocks.listSelectSegments.mockResolvedValue([]);
    apiMocks.getSettings.mockResolvedValue({ llm_enabled: "false" });
    apiMocks.getLlmStatus.mockResolvedValue({
      enabled: false,
      provider: "",
      monthly_budget: 0,
      calls_this_month: 0,
      remaining_calls: 0,
      budget_exhausted: false,
      providers: [],
    });
    apiMocks.getAiDescription.mockResolvedValue(null);
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

    expect(container.textContent).toContain("选择一条素材");
    expect(container.textContent).not.toContain("broken.mts");
    expect(apiMocks.getAiDescription).not.toHaveBeenCalled();
  });
});

describe("O14 header counts are scoped to the current episode", () => {
  // 回归说明：头部收藏/拒绝/星级计数此前直接吃 clips 全量,往集的评级会混进
  // 当前集的计数里。两集各一条收藏的夹具:头部只应显示 1,不是 2。
  it("only counts the active episode's favorites, not the whole clips array", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const activeFavorite: ClipListItem = {
      ...readyClip,
      id: 11,
      episode_id: 1,
      path: "/Volumes/CARD/clip-11.mov",
      file_name: "clip-11.mov",
      binary_rating: 1,
    };
    const pastEpisodeFavorite: ClipListItem = {
      ...readyClip,
      id: 12,
      episode_id: 2,
      path: "/Volumes/CARD/clip-12.mov",
      file_name: "clip-12.mov",
      binary_rating: 1,
    };
    apiMocks.listAssetSafety.mockResolvedValue([]);
    apiMocks.listClips.mockResolvedValue([activeFavorite, pastEpisodeFavorite]);
    apiMocks.listClipDimensions.mockResolvedValue([]);
    apiMocks.listShotStacks.mockResolvedValue([]);
    apiMocks.listSelectSegments.mockResolvedValue([]);
    apiMocks.getSettings.mockResolvedValue({ llm_enabled: "false" });
    apiMocks.getCurrentEpisode.mockResolvedValue({
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
    });
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

    const filterTabs = container.querySelector('[aria-label="评级过滤"]');
    expect(filterTabs).not.toBeNull();
    const favoriteTab = Array.from(filterTabs?.querySelectorAll("button") ?? []).find((button) =>
      (button.textContent ?? "").includes("收藏"),
    );
    expect(favoriteTab).toBeDefined();
    // "收藏1" 而不是 "收藏2"——往集(episode_id 2)的那条收藏不能计进当前集的头部计数。
    expect(favoriteTab?.textContent).toContain("1");
    expect(favoriteTab?.textContent).not.toContain("2");
  });
});

describe("same-route archive keeps the active episode in sync", () => {
  // 回归说明：封存后筛片页不会切换到新 active 集——SelectPage 只在挂载时
  // 调用一次 getCurrentEpisode(),EpisodePanel 封存成功后也不会广播新 active
  // 集,导致停留在 /review 时旧集仍被当作当前集(甚至连历史只读 banner 都不出现)。
  it("adopts the archive outcome's next episode when EpisodePanel broadcasts tripcut:episode-changed", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const ep1Clip: ClipListItem = { ...readyClip, id: 7, episode_id: 1, path: "/Volumes/CARD/clip-7.mov", file_name: "clip-7.mov" };
    const ep2Clip: ClipListItem = { ...readyClip, id: 8, episode_id: 2, path: "/Volumes/CARD/clip-8.mov", file_name: "clip-8.mov" };
    apiMocks.listAssetSafety.mockResolvedValue([]);
    apiMocks.listClips.mockResolvedValue([ep1Clip, ep2Clip]);
    apiMocks.listClipDimensions.mockResolvedValue([]);
    apiMocks.listShotStacks.mockResolvedValue([]);
    apiMocks.listSelectSegments.mockResolvedValue([]);
    apiMocks.getSettings.mockResolvedValue({ llm_enabled: "false" });
    apiMocks.getCurrentEpisode.mockResolvedValue({
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
    });
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

    // 挂载后 activeEpisodeId 停留在 EP01:胶片墙只应看到 EP01 的素材。
    expect(container.textContent).toContain("clip-7.mov");
    expect(container.textContent).not.toContain("clip-8.mov");

    // 不离开该路由,直接封存 EP01→EP02(EpisodePanel 的 archive() 现在会广播这个事件)。
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("tripcut:episode-changed", { detail: { id: 2, title: "EP02" } }),
      );
      await Promise.resolve();
    });

    // scope 必须真正切到 EP02:胶片墙改显示 EP02 的素材,不再显示已封存 EP01 的。
    expect(container.textContent).toContain("clip-8.mov");
    expect(container.textContent).not.toContain("clip-7.mov");
    // 同一次广播也必须清掉任何遗留的历史只读查看状态。
    expect(container.textContent).not.toContain("正在只读查看已封存集");
  });
});

describe("selection background refresh", () => {
  it("serializes slow requests and resumes immediately after becoming visible", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    apiMocks.listAssetSafety.mockResolvedValue([]);
    let resolve!: (clips: ClipListItem[]) => void;
    apiMocks.listClips.mockReturnValueOnce(new Promise<ClipListItem[]>((done) => { resolve = done; })).mockResolvedValue([]);
    apiMocks.listClipDimensions.mockResolvedValue([]);
    apiMocks.listShotStacks.mockResolvedValue([]);
    apiMocks.listSelectSegments.mockResolvedValue([]);
    apiMocks.getSettings.mockResolvedValue({ llm_enabled: "false" });
    apiMocks.getLlmStatus.mockResolvedValue({ enabled: false });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ container, root });
    await act(async () => root.render(<SelectPage />));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(apiMocks.listClips).toHaveBeenCalledTimes(1);
    await act(async () => resolve([]));
    visibility.mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(apiMocks.listClips).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(apiMocks.listClips).toHaveBeenCalledTimes(2);
  });

  it("skips listClips while the clips revision is unchanged across polls", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    apiMocks.listAssetSafety.mockResolvedValue([]);
    apiMocks.listClips.mockResolvedValue([]);
    apiMocks.listClipDimensions.mockResolvedValue([]);
    apiMocks.listShotStacks.mockResolvedValue([]);
    apiMocks.listSelectSegments.mockResolvedValue([]);
    apiMocks.getSettings.mockResolvedValue({ llm_enabled: "false" });
    apiMocks.getLlmStatus.mockResolvedValue({ enabled: false });
    apiMocks.getClipsRevision.mockResolvedValue("rev-A");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ container, root });
    await act(async () => root.render(<SelectPage />));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(apiMocks.listClips).toHaveBeenCalledTimes(1);

    // 修订号不变——再轮询两次也不该再拉全表。
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(apiMocks.listClips).toHaveBeenCalledTimes(1);

    // 修订号变了——下一轮该重新全量拉取。
    apiMocks.getClipsRevision.mockResolvedValue("rev-B");
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(apiMocks.listClips).toHaveBeenCalledTimes(2);
  });

  it("falls back to a full fetch when getClipsRevision rejects", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    apiMocks.listAssetSafety.mockResolvedValue([]);
    apiMocks.listClips.mockResolvedValue([]);
    apiMocks.listClipDimensions.mockResolvedValue([]);
    apiMocks.listShotStacks.mockResolvedValue([]);
    apiMocks.listSelectSegments.mockResolvedValue([]);
    apiMocks.getSettings.mockResolvedValue({ llm_enabled: "false" });
    apiMocks.getLlmStatus.mockResolvedValue({ enabled: false });
    apiMocks.getClipsRevision.mockRejectedValue(new Error("no revision command"));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ container, root });
    await act(async () => root.render(<SelectPage />));
    expect(apiMocks.listClips).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(apiMocks.listClips).toHaveBeenCalledTimes(2);
  });
});
