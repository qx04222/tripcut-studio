// @vitest-environment jsdom
// R11 §1.2(车道 C):镜头带工具条「自动挑选精选段」按钮 + 小面板 → auto_select_episode → toast「撤销这批」→ undo_auto_select。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => children,
  DragOverlay: ({ children }: { children: React.ReactNode }) => children,
  PointerSensor: function PointerSensor() {},
  useSensor: () => ({}),
  useSensors: () => [],
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => children,
  horizontalListSortingStrategy: undefined,
  verticalListSortingStrategy: undefined,
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => undefined, transform: null, transition: undefined, isDragging: false }),
}));

const apiMocks = vi.hoisted(() => ({
  getClipsRevision: vi.fn(),
  listClips: vi.fn(),
  listShotStacks: vi.fn(),
  getStoryboard: vi.fn(),
  listStoryGaps: vi.fn(),
  listClipDimensions: vi.fn(),
  listAssetSafety: vi.fn(),
  getCurrentEpisode: vi.fn(),
  listPlatformPresets: vi.fn(),
  setSetting: vi.fn().mockResolvedValue(undefined),
  generationAvailability: vi.fn(),
  listStoryTemplates: vi.fn().mockResolvedValue([]),
  autoSelectEpisodeWith: vi.fn(),
  undoAutoSelect: vi.fn(),
  getMomentsProgress: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...apiMocks,
}));

import type { ClipListItem, Storyboard, StoryItem } from "../api";
import { AUTO_SELECT_FALLBACK_BUDGET_SECS, autoSelectToast, defaultScopeFor, platformBudgetSecs } from "./BandAutoSelect";
import { ShotBand } from "./ShotBand";
// R12 §3:提示改走全局 Toast(壳里挂一次的 ToastHost);单独渲染镜头带时得自己带上宿主。
import { ToastHost } from "./ui/Toast";
import { __resetToastsForTests } from "./ui/toastStore";
import { __resetClipsFeedForTests } from "./useClipsFeed";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

function item(clipId: number, chapterId: number, fileName: string, position: number | null): StoryItem {
  return {
    key: `whole:${clipId}`,
    item_kind: "whole",
    clip_id: clipId,
    segment_id: null,
    chapter_id: chapterId,
    file_name: fileName,
    in_ticks: 0,
    out_ticks: 4_000,
    tb_num: 1,
    tb_den: 1_000,
    position,
    long_term_memory: { used_episode_badges: [], repeated_signature_uses: 0, recent_episode_window: 0, routine_visual: false, novelty_context: false, narrative_adjustment: 0, routine_suggestion: null },
  } as StoryItem;
}

const clip: ClipListItem = {
  id: 1,
  episode_id: 1,
  folder_label: null,
  cover_url: null,
  path: "/x/A.MP4",
  file_name: "A.MP4",
  byte_size: 1,
  quick_hash: null,
  full_hash: null,
  tb_num: 1,
  tb_den: 1_000,
  duration_ticks: 4_000,
  fps_num: 25,
  fps_den: 1,
  is_vfr: false,
  codec: "h264",
  width: 1920,
  height: 1080,
  captured_at: null,
  status: "ready",
  error: null,
  analysis: null,
  analysis_status: null,
  analysis_error: null,
  motion: null,
  motion_status: null,
  motion_error: null,
  binary_rating: 1,
  star_rating: null,
  select_count: 0,
};

const board: Storyboard = {
  chapters: [{ id: 1, title: "出发", start_at: "", end_at: "", clip_count: 1 }],
  items: [item(1, 1, "A.MP4", 0)],
  candidates: [],
  can_undo: false,
  mode: "legacy",
  mode_notice: "",
  narrative: null,
  narration_job_status: null,
  current_template: null,
};

beforeEach(() => {
  __resetToastsForTests();
  __resetClipsFeedForTests();
  __resetWorkspaceForTests();
  for (const mock of Object.values(apiMocks)) mock.mockClear();
  apiMocks.getClipsRevision.mockResolvedValue("rev-1");
  apiMocks.listClips.mockResolvedValue([clip]);
  apiMocks.getStoryboard.mockResolvedValue(board);
  apiMocks.listShotStacks.mockResolvedValue([]);
  apiMocks.listStoryGaps.mockResolvedValue([]);
  apiMocks.listClipDimensions.mockResolvedValue([]);
  apiMocks.listAssetSafety.mockResolvedValue([]);
  apiMocks.getCurrentEpisode.mockResolvedValue({ id: 1, title: "EP01", target_platform: "douyin" });
  apiMocks.listPlatformPresets.mockResolvedValue([
    { platform: "douyin", display_name: "抖音", portrait: [1080, 1920], landscape: [1920, 1080], duration_budget_ticks: 45_000, tb_num: 1, tb_den: 1_000, subtitle_style: {} },
  ]);
  apiMocks.generationAvailability.mockResolvedValue({ enabled: false, has_key: false, budget_remaining_usd: 0 });
  apiMocks.autoSelectEpisodeWith.mockResolvedValue({ created: [1, 2, 3, 4, 5], total_secs: 31.4, chapters_covered: 3, batch_id: "auto-42", placed: 5, arrange_batch_id: "arr-42" });
  apiMocks.undoAutoSelect.mockResolvedValue(5);
  apiMocks.getMomentsProgress.mockResolvedValue({ total: 1, done: 1, failed: 0, running: 0, pending: 0 });
});
afterEach(cleanup);

async function renderBand(): Promise<void> {
  render(<><ShotBand /><ToastHost /></>);
  await screen.findByRole("gridcell", { name: "镜头 1：A.MP4" });
}

describe("BandAutoSelect 纯函数", () => {
  it("toast 文案「已挑选 n 段 · 共 m s · 覆盖 k 章」;平台预算按当前集平台换算成秒,拉不到用兜底", async () => {
    expect(autoSelectToast({ created: [1, 2, 3, 4, 5], total_secs: 31.4, chapters_covered: 3, batch_id: "auto-1" })).toBe("已挑选 5 段 · 共 31 s · 覆盖 3 章");
    expect(await platformBudgetSecs()).toBe(45);
    apiMocks.listPlatformPresets.mockRejectedValue(new Error("offline"));
    expect(await platformBudgetSecs()).toBe(AUTO_SELECT_FALLBACK_BUDGET_SECS);
  });
});

describe("R11 §1.2:镜头带工具条「自动挑选精选段」", () => {
  it("按钮在工具条上;面板只有范围 chips + 一个预算数字 + 「开始挑选」,缺省已预填,直接按就行", async () => {
    await renderBand();
    const button = screen.getByRole("button", { name: "自动挑选精选段" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    const panel = screen.getByRole("group", { name: "自动挑选精选段" });
    const scopes = within(panel).getByRole("group", { name: "挑选范围" });
    expect(within(scopes).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["只看收藏", "收藏 + 3 星以上", "全部素材"]);
    expect(within(scopes).getByRole("button", { name: "收藏 + 3 星以上" }).getAttribute("aria-pressed")).toBe("true");
    const budget = within(panel).getByLabelText(/总时长约/) as HTMLInputElement;
    await waitFor(() => expect(budget.value).toBe("45"));
    // R19 P-09(results 车道):面板顶部多了三条预设句 chip(group「现成的三句」),范围 chips 之外仍只有「开始挑选」一颗。
    const presets = within(panel).getByRole("group", { name: "现成的三句" });
    expect(within(presets).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["旅行日记", "电影感", "快节奏"]);
    expect(within(panel).getAllByRole("button").filter((b) => !scopes.contains(b) && !presets.contains(b)).map((b) => b.textContent)).toEqual(["开始挑选"]);
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "开始挑选" }));
      await Promise.resolve();
    });
    expect(apiMocks.autoSelectEpisodeWith).toHaveBeenCalledWith({ scope: "favorites_or_rated3", budgetSecs: 45 });
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("已挑选 5 段 · 共 31 s · 覆盖 3 章");
    // R12 §2:挑完默认已排进镜头带,toast 里说出来;旧后端没有 placed 时提示去点「一键排入」。
    expect(toast.textContent).toContain("已排进镜头带");
    expect(screen.queryByRole("group", { name: "自动挑选精选段" })).toBeNull();
    fireEvent.click(within(toast).getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(apiMocks.undoAutoSelect).toHaveBeenCalledWith("auto-42"));
    // 撤销成功后换成一条「已撤销这批挑选」。
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已撤销这批挑选"));
  });

  it("改范围与预算后按原样传给后端;出错时 toast 说清楚且没有「撤销」", async () => {
    await renderBand();
    fireEvent.click(screen.getByRole("button", { name: "自动挑选精选段" }));
    const panel = screen.getByRole("group", { name: "自动挑选精选段" });
    fireEvent.click(within(panel).getByRole("button", { name: "全部素材" }));
    const budget = within(panel).getByLabelText(/总时长约/) as HTMLInputElement;
    await waitFor(() => expect(budget.value).toBe("45"));
    fireEvent.change(budget, { target: { value: "60" } });
    apiMocks.autoSelectEpisodeWith.mockRejectedValue(new Error("没有时刻分"));
    // X-02:「等分析跑完」只在分析真没跑完时才说(问 get_moments_progress)。
    apiMocks.getMomentsProgress.mockResolvedValue({ total: 3, done: 1, failed: 0, running: 1, pending: 1 });
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "开始挑选" }));
      await Promise.resolve();
    });
    expect(apiMocks.autoSelectEpisodeWith).toHaveBeenCalledWith({ scope: "all", budgetSecs: 60 });
    const toast = await screen.findByRole("status");
    // R11 简化专项 #5:「动作没成功:原因。下一步」。
    expect(toast.textContent).toContain("自动挑选没成功:没有时刻分。先让画面分析跑完,再试一次");
    expect(within(toast).queryByRole("button", { name: "撤销" })).toBeNull();
  });

  it("X-02:分析已完成时不再劝「等分析跑完」;后端已给下一步(rating failed: 前缀剥掉)就不再追加兜底话", async () => {
    await renderBand();
    fireEvent.click(screen.getByRole("button", { name: "自动挑选精选段" }));
    const panel = screen.getByRole("group", { name: "自动挑选精选段" });
    apiMocks.autoSelectEpisodeWith.mockRejectedValue(new Error("rating failed: 这个范围里没有可挑的素材:先收藏几条或给素材打星,或把范围改成「全部」"));
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "开始挑选" }));
      await Promise.resolve();
    });
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("自动挑选没成功:这个范围里没有可挑的素材:先收藏几条或给素材打星,或把范围改成「全部」");
    expect(toast.textContent).not.toContain("failed");
    expect(toast.textContent).not.toContain("分析");
    expect(toast.textContent).not.toContain("再试一次");
  });
});

describe("X-01(R12 验收 P1):全新库也要一键出结果", () => {
  it("默认 chip 按库状态推导:0 收藏且 0 打星 → 「全部素材」预选,发给后端的就是 all", async () => {
    expect(defaultScopeFor([clip])).toBe("favorites_or_rated3");
    expect(defaultScopeFor([{ ...clip, binary_rating: null, star_rating: 2 }])).toBe("all");
    expect(defaultScopeFor([{ ...clip, binary_rating: null, star_rating: 3 }])).toBe("favorites_or_rated3");
    expect(defaultScopeFor([])).toBe("all");

    apiMocks.listClips.mockResolvedValue([{ ...clip, binary_rating: null, star_rating: null }]);
    await renderBand();
    fireEvent.click(screen.getByRole("button", { name: "自动挑选精选段" }));
    const panel = screen.getByRole("group", { name: "自动挑选精选段" });
    const scopes = within(panel).getByRole("group", { name: "挑选范围" });
    expect(within(scopes).getByRole("button", { name: "全部素材" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(scopes).getByRole("button", { name: "收藏 + 3 星以上" }).getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "开始挑选" }));
      await Promise.resolve();
    });
    expect(apiMocks.autoSelectEpisodeWith).toHaveBeenCalledWith(expect.objectContaining({ scope: "all" }));
  });

  it("Y-03:前端预选「全部素材」而后端没降级时,toast 同样说清「你还没收藏或打星,已按全部素材挑了 n 段」并带「撤销」", async () => {
    apiMocks.listClips.mockResolvedValue([{ ...clip, binary_rating: null, star_rating: null }]);
    apiMocks.autoSelectEpisodeWith.mockResolvedValue({ created: [1, 2, 3, 4], total_secs: 28, chapters_covered: 1, batch_id: "auto-44", placed: 4, arrange_batch_id: "arr-44", scope_used: "all", fell_back: false });
    await renderBand();
    fireEvent.click(screen.getByRole("button", { name: "自动挑选精选段" }));
    const panel = screen.getByRole("group", { name: "自动挑选精选段" });
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "开始挑选" }));
      await Promise.resolve();
    });
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("你还没收藏或打星,已按全部素材挑了 4 段 · 共 28 s · 覆盖 1 章 · 已排进镜头带");
    expect(within(toast).getByRole("button", { name: "撤销" })).toBeTruthy();
  });

  it("Y-03:库里有收藏时用户自己点「全部素材」,不说「你还没收藏或打星」", async () => {
    apiMocks.autoSelectEpisodeWith.mockResolvedValue({ created: [1, 2], total_secs: 10, chapters_covered: 1, batch_id: "auto-45", placed: 2, arrange_batch_id: "arr-45", scope_used: "all", fell_back: false });
    await renderBand();
    fireEvent.click(screen.getByRole("button", { name: "自动挑选精选段" }));
    const panel = screen.getByRole("group", { name: "自动挑选精选段" });
    fireEvent.click(within(panel).getByRole("button", { name: "全部素材" }));
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "开始挑选" }));
      await Promise.resolve();
    });
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("已挑选 2 段");
    expect(toast.textContent).not.toContain("你还没收藏或打星");
  });

  it("后端自动降级到「全部」时 toast 说清:「你还没收藏或打星,已按全部素材挑了 n 段 · 撤销」", async () => {
    apiMocks.autoSelectEpisodeWith.mockResolvedValue({ created: [1, 2, 3, 4], total_secs: 28, chapters_covered: 1, batch_id: "auto-43", placed: 4, arrange_batch_id: "arr-43", scope_used: "all", fell_back: true });
    await renderBand();
    fireEvent.click(screen.getByRole("button", { name: "自动挑选精选段" }));
    const panel = screen.getByRole("group", { name: "自动挑选精选段" });
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "开始挑选" }));
      await Promise.resolve();
    });
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("你还没收藏或打星,已按全部素材挑了 4 段");
    expect(toast.textContent).toContain("已排进镜头带");
    expect(within(toast).getByRole("button", { name: "撤销" })).toBeTruthy();
  });
});
