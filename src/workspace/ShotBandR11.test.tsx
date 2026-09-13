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
  autoSelectEpisode: vi.fn(),
  undoAutoSelect: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...apiMocks,
}));

import type { ClipListItem, Storyboard, StoryItem } from "../api";
import { AUTO_SELECT_FALLBACK_BUDGET_SECS, autoSelectToast, platformBudgetSecs } from "./BandAutoSelect";
import { ShotBand } from "./ShotBand";
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
  apiMocks.autoSelectEpisode.mockResolvedValue({ created: [1, 2, 3, 4, 5], total_secs: 31.4, chapters_covered: 3, batch_id: "auto-42" });
  apiMocks.undoAutoSelect.mockResolvedValue(5);
});
afterEach(cleanup);

async function renderBand(): Promise<void> {
  render(<ShotBand />);
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
    expect(within(panel).getAllByRole("button").filter((b) => !scopes.contains(b)).map((b) => b.textContent)).toEqual(["开始挑选"]);
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "开始挑选" }));
      await Promise.resolve();
    });
    expect(apiMocks.autoSelectEpisode).toHaveBeenCalledWith({ scope: "favorites_or_rated3", budgetSecs: 45 });
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("已挑选 5 段 · 共 31 s · 覆盖 3 章");
    expect(screen.queryByRole("group", { name: "自动挑选精选段" })).toBeNull();
    fireEvent.click(within(toast).getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(apiMocks.undoAutoSelect).toHaveBeenCalledWith("auto-42"));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("改范围与预算后按原样传给后端;出错时 toast 说清楚且没有「撤销」", async () => {
    await renderBand();
    fireEvent.click(screen.getByRole("button", { name: "自动挑选精选段" }));
    const panel = screen.getByRole("group", { name: "自动挑选精选段" });
    fireEvent.click(within(panel).getByRole("button", { name: "全部素材" }));
    const budget = within(panel).getByLabelText(/总时长约/) as HTMLInputElement;
    await waitFor(() => expect(budget.value).toBe("45"));
    fireEvent.change(budget, { target: { value: "60" } });
    apiMocks.autoSelectEpisode.mockRejectedValue(new Error("没有时刻分"));
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "开始挑选" }));
      await Promise.resolve();
    });
    expect(apiMocks.autoSelectEpisode).toHaveBeenCalledWith({ scope: "all", budgetSecs: 60 });
    const toast = await screen.findByRole("status");
    // R11 简化专项 #5:「动作没成功:原因。下一步」。
    expect(toast.textContent).toContain("自动挑选没成功:没有时刻分。先让画面分析跑完,再试一次");
    expect(within(toast).queryByRole("button", { name: "撤销" })).toBeNull();
  });
});
