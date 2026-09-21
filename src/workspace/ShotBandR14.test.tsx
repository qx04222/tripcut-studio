// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R14 真机复核修复(`.superpowers/sdd/r14/verify-v1.md`)的镜头带回归。
 * V14-02:章数多时拖排无效 —— 拖动期虚拟化只留当前章 ±1,源章被折叠成「n 个镜头」,没有可放目标。
 * dnd-kit 替身与 ShotBand.test.tsx 同一套:只把 onDragStart / onDragEnd 递出来,被测的是本仓的渲染与落点。
 */
const dnd = vi.hoisted(() => ({
  onDragEnd: null as ((event: unknown) => void) | null,
  onDragStart: null as ((event: unknown) => void) | null,
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragEnd,
    onDragStart,
  }: {
    children: React.ReactNode;
    onDragEnd: (event: unknown) => void;
    onDragStart: (event: unknown) => void;
  }) => {
    dnd.onDragEnd = onDragEnd;
    dnd.onDragStart = onDragStart;
    return children;
  },
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
  setSetting: vi.fn().mockResolvedValue(undefined),
  setStoryOrder: vi.fn().mockResolvedValue(undefined),
  undoStoryChange: vi.fn().mockResolvedValue(undefined),
  generationAvailability: vi.fn(),
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

const MEMORY = {
  used_episode_badges: [],
  repeated_signature_uses: 0,
  recent_episode_window: 0,
  routine_visual: false,
  novelty_context: false,
  narrative_adjustment: 0,
  routine_suggestion: null,
};

function item(clipId: number, chapterId: number, fileName: string, position: number): StoryItem {
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
    long_term_memory: MEMORY,
  } as StoryItem;
}

function clip(id: number, fileName: string): ClipListItem {
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
    kind: "video",
    binary_rating: null,
    star_rating: null,
    select_count: 0,
  } as ClipListItem;
}

/** 7 章 × 2 镜 = 14 镜(真机 7 章 · 11 镜的形态);视口 1 200 px(jsdom 量不到宽时的默认值)只装得下前几章。 */
const CHAPTERS = 7;
const clips: ClipListItem[] = [];
const items: StoryItem[] = [];
for (let chapter = 1; chapter <= CHAPTERS; chapter += 1) {
  for (let slot = 0; slot < 2; slot += 1) {
    const id = (chapter - 1) * 2 + slot + 1;
    const name = `C${chapter}_${slot + 1}.MP4`;
    clips.push(clip(id, name));
    items.push(item(id, chapter, name, id - 1));
  }
}
const board: Storyboard = {
  chapters: Array.from({ length: CHAPTERS }, (_, index) => ({
    id: index + 1,
    title: `第 ${index + 1} 章`,
    start_at: "",
    end_at: "",
    clip_count: 2,
  })),
  items,
  candidates: [],
  can_undo: true,
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
  dnd.onDragEnd = null;
  dnd.onDragStart = null;
  for (const mock of Object.values(apiMocks)) mock.mockClear();
  apiMocks.getClipsRevision.mockResolvedValue("rev-1");
  apiMocks.listClips.mockResolvedValue(clips);
  apiMocks.getStoryboard.mockResolvedValue(board);
  apiMocks.listShotStacks.mockResolvedValue([]);
  apiMocks.listStoryGaps.mockResolvedValue([]);
  apiMocks.listClipDimensions.mockResolvedValue([]);
  apiMocks.listAssetSafety.mockResolvedValue([]);
  apiMocks.getCurrentEpisode.mockResolvedValue({ id: 1, title: "EP01" });
  apiMocks.generationAvailability.mockResolvedValue({ enabled: false, has_key: false, budget_remaining_usd: 0 });
  apiMocks.setStoryOrder.mockResolvedValue(undefined);
});
afterEach(cleanup);

async function renderBand(): Promise<void> {
  render(<><ShotBand /><ToastHost /></>);
  await screen.findByRole("gridcell", { name: "镜头 1：C1_1.MP4" });
}

describe("V14-02 章数多时拖排(镜头带 7 章)", () => {
  it("未拖动时第 7 章在视口外只画折叠卡(虚拟化仍在)", async () => {
    await renderBand();
    expect(screen.queryByRole("gridcell", { name: "镜头 13：C7_1.MP4" })).toBeNull();
    expect(screen.getAllByText("2 个镜头").length).toBeGreaterThan(0);
  });

  it("拖动一开始所有章全渲染:第 7 章的镜块与第 1 章的镜块都是可放目标", async () => {
    await renderBand();
    await act(async () => {
      dnd.onDragStart?.({ active: { id: "whole:13" } });
    });
    expect(screen.getByRole("gridcell", { name: "镜头 13：C7_1.MP4" })).toBeTruthy();
    expect(screen.getByRole("gridcell", { name: "镜头 14：C7_2.MP4" })).toBeTruthy();
    expect(screen.getByRole("gridcell", { name: "镜头 1：C1_1.MP4" })).toBeTruthy();
    expect(screen.queryByText(/个镜头/)).toBeNull();
  });

  it("从第 7 章的镜块拖到本章另一块:松手后顺序写入(setStoryOrder 一次)并 toast", async () => {
    await renderBand();
    const active = { id: "whole:14" };
    await act(async () => {
      dnd.onDragStart?.({ active });
    });
    const over = { id: screen.getByRole("gridcell", { name: "镜头 13：C7_1.MP4" }).getAttribute("data-band-key") };
    await act(async () => {
      dnd.onDragEnd?.({ active, over });
    });
    await waitFor(() => expect(apiMocks.setStoryOrder).toHaveBeenCalledTimes(1));
    const order = (apiMocks.setStoryOrder.mock.lastCall![0] as { clip_id: number }[]).map((ref) => ref.clip_id);
    expect(order.slice(-2)).toEqual([14, 13]);
    expect(await screen.findByText("已调整顺序")).toBeTruthy();
  });

  it("从第 7 章拖到第 1 章的镜块上:跨章被拒且说出来(不是静默无效)", async () => {
    await renderBand();
    const active = { id: "whole:13" };
    await act(async () => {
      dnd.onDragStart?.({ active });
      dnd.onDragEnd?.({ active, over: { id: "whole:1" } });
    });
    expect(await screen.findByText("镜头仍归属原章节；请先合并章节再跨章排序")).toBeTruthy();
    expect(apiMocks.setStoryOrder).not.toHaveBeenCalled();
  });
});
