// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R12 车道 B(规格 §2)的镜头带回归:「一键排入」(可撤销)、精选段镜块的「片段 a–b s」小标、
 * 「上移 / 下移」按钮、「这章够了」(settings 键 `story.chapter_skipped.<id>`)。
 * dnd-kit 与 `ShotBand.test.tsx` 同一套替身 —— 这里不测拖拽物理。
 */

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
  getSettings: vi.fn(),
  setSetting: vi.fn().mockResolvedValue(undefined),
  setStoryOrder: vi.fn().mockResolvedValue(undefined),
  undoStoryChange: vi.fn().mockResolvedValue(undefined),
  rateClip: vi.fn().mockResolvedValue(undefined),
  generationAvailability: vi.fn(),
  dismissStoryGap: vi.fn().mockResolvedValue(undefined),
  reopenStoryGap: vi.fn().mockResolvedValue(undefined),
  listStoryTemplates: vi.fn().mockResolvedValue([]),
  arrangeSelectedSegments: vi.fn(),
  undoArrange: vi.fn().mockResolvedValue(3),
  skipChapter: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...apiMocks,
}));

import type { ClipListItem, Storyboard, StoryItem } from "../api";
import { ShotBand } from "./ShotBand";
import { ToastHost } from "./ui/Toast";
import { __resetToastsForTests } from "./ui/toastStore";
import { __resetClipsFeedForTests } from "./useClipsFeed";
import { __resetWorkspaceForTests } from "./WorkspaceStore";
import { __setShowAllFeaturesForTests } from "./showAllFeatures";

const MEMORY = {
  used_episode_badges: [],
  repeated_signature_uses: 0,
  recent_episode_window: 0,
  routine_visual: false,
  novelty_context: false,
  narrative_adjustment: 0,
  routine_suggestion: null,
};

function item(clipId: number, chapterId: number, fileName: string, position: number | null, segment: { id: number; in: number; out: number } | null = null): StoryItem {
  return {
    key: segment ? `segment:${segment.id}` : `whole:${clipId}`,
    item_kind: segment ? "segment" : "whole",
    clip_id: clipId,
    segment_id: segment?.id ?? null,
    chapter_id: chapterId,
    file_name: fileName,
    in_ticks: segment?.in ?? 0,
    out_ticks: segment?.out ?? 4_000,
    tb_num: 1,
    tb_den: 1_000,
    position,
    long_term_memory: MEMORY,
  } as StoryItem;
}

function clip(id: number, fileName: string, overrides: Partial<ClipListItem> = {}): ClipListItem {
  return {
    id,
    episode_id: 1,
    folder_label: null,
    cover_url: null,
    path: `/x/${fileName}`,
    file_name: fileName,
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
    binary_rating: null,
    star_rating: null,
    select_count: 0,
    ...overrides,
  } as ClipListItem;
}

/** 第 1 章两块:整条 A + 精选段 B(0.5–4.5 s);第 2 章空。 */
const board: Storyboard = {
  chapters: [
    { id: 1, title: "出发", start_at: "", end_at: "", clip_count: 2 },
    { id: 2, title: "抵达", start_at: "", end_at: "", clip_count: 0 },
  ],
  items: [item(1, 1, "A.MP4", 0), item(2, 1, "B.MP4", 1, { id: 77, in: 500, out: 4_500 })],
  candidates: [],
  can_undo: false,
  mode: "legacy",
  mode_notice: "",
  narrative: null,
  narration_job_status: null,
  current_template: null,
};

beforeEach(() => {
  // R19 P-05:这份文件描述的是「显示全部功能」打开后的形态(旅程 / 地点卡 / 模板 / 技术检查 / 快捷键 / 性能 / 云端补镜都在);默认态在 showAllFeaturesR19.test。
  __setShowAllFeaturesForTests(true);
  __resetToastsForTests();
  __resetClipsFeedForTests();
  __resetWorkspaceForTests();
  for (const mock of Object.values(apiMocks)) mock.mockClear();
  apiMocks.getClipsRevision.mockResolvedValue("rev-1");
  apiMocks.listClips.mockResolvedValue([clip(1, "A.MP4", { binary_rating: 1 }), clip(2, "B.MP4", { select_count: 1 }), clip(3, "C.MP4", { star_rating: 3 })]);
  apiMocks.getStoryboard.mockResolvedValue(board);
  apiMocks.listShotStacks.mockResolvedValue([]);
  apiMocks.listStoryGaps.mockResolvedValue([]);
  apiMocks.listClipDimensions.mockResolvedValue([]);
  apiMocks.listAssetSafety.mockResolvedValue([]);
  apiMocks.getCurrentEpisode.mockResolvedValue({ id: 1, title: "EP01" });
  apiMocks.getSettings.mockResolvedValue({});
  apiMocks.generationAvailability.mockResolvedValue({ enabled: false, has_key: false, budget_remaining_usd: 0 });
  apiMocks.setStoryOrder.mockResolvedValue(undefined);
  apiMocks.arrangeSelectedSegments.mockResolvedValue({ placed: 3, chapters: 2, batch_id: "arr-9" });
  apiMocks.undoArrange.mockResolvedValue(3);
  apiMocks.skipChapter.mockResolvedValue(undefined);
});
afterEach(cleanup);

async function renderBand(): Promise<void> {
  render(<><ShotBand /><ToastHost /></>);
  await screen.findByRole("gridcell", { name: "镜头 1：A.MP4" });
}

describe("§2 一键排入", () => {
  it("工具条「一键排入」是 secondary(R19 V-01 起栏内没有 primary);点它 → arrangeSelectedSegments(append) → toast「已排入 3 段 · 覆盖 2 章」带「撤销」→ undoArrange(batch)", async () => {
    await renderBand();
    const button = screen.getByRole("button", { name: "一键排入" });
    expect(button.className).toContain("ui-button--secondary");
    expect(button.className).not.toContain("ui-button--primary");
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(apiMocks.arrangeSelectedSegments).toHaveBeenCalledWith("append"));
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("已排入 3 段 · 覆盖 2 章");
    await act(async () => {
      fireEvent.click(within(toast).getByRole("button", { name: "撤销" }));
    });
    await waitFor(() => expect(apiMocks.undoArrange).toHaveBeenCalledWith("arr-9"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已撤销这次排入"));
  });

  it("没有新段可排时 toast 说「都已经在镜头带上了」且没有「撤销」;失败时说清下一步", async () => {
    apiMocks.arrangeSelectedSegments.mockResolvedValueOnce({ placed: 0, chapters: 0, batch_id: "arr-0" });
    await renderBand();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "一键排入" }));
    });
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("挑好的片段都已经在镜头带上了");
    expect(within(toast).queryByRole("button", { name: "撤销" })).toBeNull();

    apiMocks.arrangeSelectedSegments.mockRejectedValueOnce(new Error("没有进行中的 Episode"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "一键排入" }));
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("排入没成功:没有进行中的 Episode。先挑几条片段"));
  });
});

describe("§2 精选段成为镜块", () => {
  it("段级镜块显示「片段 0.5–4.5 s」小标;整条素材的镜块没有", async () => {
    await renderBand();
    const first = screen.getByRole("gridcell", { name: "镜头 1：A.MP4" });
    const second = screen.getByRole("gridcell", { name: "镜头 2：B.MP4" });
    expect(within(second).getByText("片段 0.5–4.5 s")).toBeTruthy();
    expect(within(first).queryByText(/^片段 /)).toBeNull();
  });
});

describe("§2 往前 / 往后按钮(不靠拖拽;X-03 由「上移 / 下移」改名)", () => {
  it("镜头 1「往前」禁用、「往后」把它挪到镜头 2 之后(set_story_order);镜头 2「往后」禁用;图标是 ← →", async () => {
    await renderBand();
    const first = screen.getByRole("gridcell", { name: "镜头 1：A.MP4" });
    const second = screen.getByRole("gridcell", { name: "镜头 2：B.MP4" });
    expect(within(first).getByRole("button", { name: "往前" })).toHaveProperty("disabled", true);
    expect(within(second).getByRole("button", { name: "往后" })).toHaveProperty("disabled", true);
    expect(within(first).getByRole("button", { name: "往前" }).querySelector("svg[data-icon=\"arrow-left\"]")).not.toBeNull();
    expect(within(first).getByRole("button", { name: "往后" }).querySelector("svg[data-icon=\"arrow-right\"]")).not.toBeNull();
    expect(within(first).queryByRole("button", { name: "上移" })).toBeNull();
    await act(async () => {
      fireEvent.click(within(first).getByRole("button", { name: "往后" }));
    });
    await waitFor(() => expect(apiMocks.setStoryOrder).toHaveBeenCalledTimes(1));
    expect((apiMocks.setStoryOrder.mock.lastCall![0] as { clip_id: number }[]).map((ref) => ref.clip_id)).toEqual([2, 1]);
    expect((await screen.findByRole("status")).textContent).toContain("已调整顺序");
  });

  it("X-03:选中的镜块常显往前 / 往后 —— 选中态是 ui-card--selected(Card 写的),不是 .selected;露出规则必须钉在真存在的类上", async () => {
    await renderBand();
    fireEvent.click(screen.getByRole("gridcell", { name: "镜头 1：A.MP4" }));
    const first = () => screen.getByRole("gridcell", { name: "镜头 1：A.MP4" });
    await waitFor(() => expect(first().classList.contains("ui-card--selected")).toBe(true));
    expect(first().classList.contains("selected")).toBe(false);
    expect(within(first()).getByRole("button", { name: "往前" })).toBeTruthy();
    const css = readFileSync(resolve(process.cwd(), "src/styles/workspace/band-r12.css"), "utf8");
    expect(css).toMatch(/\.band-segment\.ui-card--selected \.band-segment-steps/);
    expect(css).not.toMatch(/\.band-segment\.selected \.band-segment-steps/);
  });
});

describe("§2 「这章够了」", () => {
  it("空章占位有「这章够了」:点它 → skipChapter(2, true),带头换成「这章够了」角标,栏标题不再算它是缺口;toast 可撤销", async () => {
    await renderBand();
    const second = screen.getByRole("rowgroup", { name: "第 2 章 抵达" });
    expect(within(second).getByText("0 镜 · 1 缺口")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(second).getByRole("button", { name: "这章够了" }));
    });
    await waitFor(() => expect(apiMocks.skipChapter).toHaveBeenCalledWith(2, true));
    await waitFor(() => expect(within(second).queryByText("0 镜 · 1 缺口")).toBeNull());
    expect(within(second).getByRole("gridcell", { name: "这章够了" })).toBeTruthy();
    expect(within(second).getByRole("button", { name: "还是要镜头" })).toBeTruthy();
    const toast = screen.getByRole("status");
    expect(toast.textContent).toContain("「抵达」这章够了");
    await act(async () => {
      fireEvent.click(within(toast).getByRole("button", { name: "撤销" }));
    });
    await waitFor(() => expect(apiMocks.skipChapter).toHaveBeenLastCalledWith(2, false));
    await waitFor(() => expect(within(second).getByText("0 镜 · 1 缺口")).toBeTruthy());
  });

  it("settings 里已有 story.chapter_skipped.2 = true 时,挂载即按跳过显示;「仅缺口」视图不留它", async () => {
    apiMocks.getSettings.mockResolvedValue({ "story.chapter_skipped.2": "true" });
    await renderBand();
    const second = screen.getByRole("rowgroup", { name: "第 2 章 抵达" });
    await waitFor(() => expect(within(second).getByRole("gridcell", { name: "这章够了" })).toBeTruthy());
    // V-07:视图三芯片收进「{当前} ⌄」触发钮下的浮层,先展开才摸得到。
    fireEvent.click(screen.getByRole("button", { name: "按章节 ⌄" }));
    fireEvent.click(screen.getByRole("button", { name: "仅缺口" }));
    expect(screen.queryByRole("rowgroup", { name: "第 2 章 抵达" })).toBeNull();
  });
});
