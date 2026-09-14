// @vitest-environment jsdom


import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R16 车道 A(规格 §1 / P1-4)的镜头带回归:镜块「···」/ 右键菜单 —— 往前 · 往后 · 从镜头带移出 ·
 * 删除精选段 · 导出这一段…;「从镜头带移出」= set_story_order 少传它那条 ref,toast「撤销」走
 * undo_story_change,⌘Z 同一条栈。夹具与 ShotBandR12.test.tsx 同一套。
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
  deleteSelectSegment: vi.fn().mockResolvedValue(undefined),
  restoreSelectSegment: vi.fn().mockResolvedValue(undefined),
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
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";
import { SHOT_MENU } from "./copy";
import { shotMenuItems } from "./BandSegmentMenu";
import { planBandRemove } from "./useBandDrag";
import { __resetUndoForTests, canUndo, runUndo } from "./undoStack";

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
  __resetUndoForTests();
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

const refs = () => (apiMocks.setStoryOrder.mock.lastCall![0] as { clip_id: number }[]).map((ref) => ref.clip_id);

describe("R16 §1:镜块菜单", () => {
  it("项目表顺序与 AX 名逐字;整条素材的「删除精选段」禁用;只读时改数据的项禁用、导出照常", () => {
    const items = shotMenuItems({ segmentId: 77 }, { canStepBack: true, canStepForward: false, readOnly: false });
    expect(items.map((item) => item.label)).toEqual(Object.values(SHOT_MENU));
    expect(items.map((item) => item.ariaLabel)).toEqual(["往前", "往后", "从镜头带移出", "删除精选段", "导出这一段"]);
    expect(items.map((item) => item.disabled)).toEqual([false, true, false, false, false]);
    expect(shotMenuItems({ segmentId: null }, { canStepBack: true, canStepForward: true, readOnly: false }).find((item) => item.id === "deleteSegment")?.disabled).toBe(true);
    const readOnly = shotMenuItems({ segmentId: 77 }, { canStepBack: true, canStepForward: true, readOnly: true });
    expect(readOnly.filter((item) => !item.disabled).map((item) => item.id)).toEqual(["exportSegment"]);
  });

  it("planBandRemove:少传那一条 ref,其余位次重排;不在带上的 key 回 null", () => {
    const plan = planBandRemove(board, "whole:1");
    expect(plan).not.toBeNull();
    if (plan?.kind !== "reorder") throw new Error("expected reorder");
    expect(plan.items.map((item) => [item.key, item.position])).toEqual([["segment:77", 0]]);
    expect(plan.label).toBe("已从镜头带移出");
    expect(planBandRemove(board, "whole:999")).toBeNull();
  });

  it("镜块「更多」弹菜单「镜块操作」;「从镜头带移出」→ set_story_order 只剩另一条 → toast「已从镜头带移出 · 撤销」→ undo_story_change;⌘Z 栈里那条随之消失", async () => {
    await renderBand();
    const first = screen.getByRole("gridcell", { name: "镜头 1：A.MP4" });
    await act(async () => {
      fireEvent.click(within(first).getByRole("button", { name: "更多" }));
    });
    const menu = await screen.findByRole("menu", { name: "镜块操作" });
    expect(Array.from(menu.querySelectorAll("[role='menuitem']")).map((node) => node.textContent)).toEqual(Object.values(SHOT_MENU));
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "从镜头带移出" }));
    });
    await waitFor(() => expect(apiMocks.setStoryOrder).toHaveBeenCalledTimes(1));
    expect(refs()).toEqual([2]);
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("已从镜头带移出");
    expect(canUndo()).toBe(true);
    await act(async () => {
      fireEvent.click(within(toast).getByRole("button", { name: "撤销" }));
    });
    await waitFor(() => expect(apiMocks.undoStoryChange).toHaveBeenCalledTimes(1));
    expect(canUndo()).toBe(false);
  });

  it("右键镜块也弹同一张菜单;「往后」走同一条 set_story_order;「删除精选段」→ delete_select_segment + toast 撤销;「导出这一段」进快速导出", async () => {
    await renderBand();
    const first = screen.getByRole("gridcell", { name: "镜头 1：A.MP4" });
    fireEvent.contextMenu(first, { clientX: 5, clientY: 5 });
    let menu = await screen.findByRole("menu", { name: "镜块操作" });
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "往后" }));
    });
    await waitFor(() => expect(apiMocks.setStoryOrder).toHaveBeenCalledTimes(1));
    expect(refs()).toEqual([2, 1]);

    const second = screen.getByRole("gridcell", { name: "镜头 2：B.MP4" });
    fireEvent.contextMenu(second, { clientX: 5, clientY: 5 });
    menu = await screen.findByRole("menu", { name: "镜块操作" });
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "删除精选段" }));
    });
    await waitFor(() => expect(apiMocks.deleteSelectSegment).toHaveBeenCalledWith(77));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已删除精选段"));
    await act(async () => {
      expect((await runUndo())?.label).toBe("删除精选段");
    });
    expect(apiMocks.restoreSelectSegment).toHaveBeenCalledWith(77);

    fireEvent.contextMenu(screen.getByRole("gridcell", { name: "镜头 2：B.MP4" }), { clientX: 5, clientY: 5 });
    menu = await screen.findByRole("menu", { name: "镜块操作" });
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "导出这一段" }));
    });
    expect(getWorkspaceSnapshot().openDrawer).toBe("deliver");
  });
});
