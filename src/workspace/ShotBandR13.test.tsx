// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R13 车道 C(规格 §4 / §5)的镜头带回归:时间刻度(`img`「时间刻度」)、播放头随 `player_status` 走、
 * 点刻度 / 镜块 → 既有 selection + `tripcut:seek-ratio`、拖边裁入出点(建新 → 换引用 → 删旧)、
 * 章节轨头折叠(aria-expanded)、右上常驻「导入剪映继续剪」。dnd-kit 与 R12 同一套替身。
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
  undoArrange: vi.fn().mockResolvedValue(0),
  skipChapter: vi.fn().mockResolvedValue(undefined),
  playerStatus: vi.fn(),
  trimBandSegment: vi.fn().mockResolvedValue(undefined),
  createSelectSegment: vi.fn(),
  deleteSelectSegment: vi.fn().mockResolvedValue(undefined),
  getJianyingAvailability: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...apiMocks,
}));

import type { ClipListItem, PlayerStatus, Storyboard, StoryItem } from "../api";
import { BAND_TILE_WIDTH } from "./bandTimeline";
import { SELECT_SEGMENT_EVENT, type SelectionRequest } from "./playthrough/selection";
import { ShotBand } from "./ShotBand";
import { BAND_SEGMENT_PITCH } from "./shotBandModel";
import { ToastHost } from "./ui/Toast";
import { __resetToastsForTests } from "./ui/toastStore";
import { __resetClipsFeedForTests } from "./useClipsFeed";
import { __resetExportModeForTests, takePendingExportMode } from "./deliver/exportModeRequest";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";

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
    duration_ticks: 6_000,
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
    ...overrides,
  } as ClipListItem;
}

/** 第 1 章:整条 A(4 s)+ 精选段 B(0.5–4.5 s);第 2 章:整条 C(4 s)。带总长 12 s。 */
const board: Storyboard = {
  chapters: [
    { id: 1, title: "出发", start_at: "", end_at: "", clip_count: 2 },
    { id: 2, title: "抵达", start_at: "", end_at: "", clip_count: 1 },
  ],
  items: [item(1, 1, "A.MP4", 0), item(2, 1, "B.MP4", 1, { id: 77, in: 500, out: 4_500 }), item(3, 2, "C.MP4", 0)],
  candidates: [],
  can_undo: false,
  mode: "legacy",
  mode_notice: "",
  narrative: null,
  narration_job_status: null,
  current_template: null,
};

const READY: PlayerStatus = {
  phase: "ready",
  clip_id: 2,
  pos: 2.5,
  duration: 6,
  paused: false,
  frame: 0,
  error: null,
  seek_samples: 0,
  seek_p50_ms: null,
  seek_p95_ms: null,
  last_seek_ms: null,
};

beforeEach(() => {
  __resetToastsForTests();
  __resetClipsFeedForTests();
  __resetWorkspaceForTests();
  __resetExportModeForTests();
  for (const mock of Object.values(apiMocks)) mock.mockClear();
  apiMocks.getClipsRevision.mockResolvedValue("rev-1");
  apiMocks.listClips.mockResolvedValue([clip(1, "A.MP4", { binary_rating: 1 }), clip(2, "B.MP4", { select_count: 1 }), clip(3, "C.MP4", { binary_rating: 1 })]);
  apiMocks.getStoryboard.mockResolvedValue(board);
  apiMocks.listShotStacks.mockResolvedValue([]);
  apiMocks.listStoryGaps.mockResolvedValue([]);
  apiMocks.listClipDimensions.mockResolvedValue([]);
  apiMocks.listAssetSafety.mockResolvedValue([]);
  apiMocks.getCurrentEpisode.mockResolvedValue({ id: 1, title: "EP01" });
  apiMocks.getSettings.mockResolvedValue({});
  apiMocks.generationAvailability.mockResolvedValue({ enabled: false, has_key: false, budget_remaining_usd: 0 });
  apiMocks.setStoryOrder.mockResolvedValue(undefined);
  apiMocks.playerStatus.mockResolvedValue(READY);
  apiMocks.createSelectSegment.mockResolvedValue({ id: 78, clip_id: 2, in_ticks: 600, out_ticks: 4_500, tb_num: 1, tb_den: 1_000 });
  apiMocks.deleteSelectSegment.mockResolvedValue(undefined);
  apiMocks.getJianyingAvailability.mockResolvedValue({ installed_version: null, supported: false, reason: "没检测到剪映" });
});
afterEach(cleanup);

async function renderBand(): Promise<void> {
  render(
    <>
      <ShotBand />
      <ToastHost />
    </>,
  );
  await screen.findByRole("gridcell", { name: "镜头 1：A.MP4" });
}

/** R25 TC-0115-001:点镜块 / 刻度 = 进入选段模式,带的是素材秒(不再广播 seek-ratio)。 */
function selectionEvents(): number[] {
  const seen: number[] = [];
  window.addEventListener(SELECT_SEGMENT_EVENT, (event) => seen.push((event as CustomEvent<SelectionRequest>).detail.position));
  return seen;
}

describe("§4 时间刻度", () => {
  it("视口上方有 img「时间刻度」:12 s 的带按秒刻度、每 5 秒一个标签(0:00 / 0:05 / 0:10)", async () => {
    await renderBand();
    const ruler = screen.getByRole("img", { name: "时间刻度" });
    expect(ruler.querySelectorAll(".band-time-mark").length).toBe(13);
    expect(Array.from(ruler.querySelectorAll(".band-time-mark-label")).map((node) => node.textContent)).toEqual(["0:00", "0:05", "0:10"]);
  });

  it("点刻度:落在 B 块中点 → 选中 B 并按 B 的入出点换算成素材比例广播 seek((0.5 + 2) / 6)", async () => {
    await renderBand();
    // R25 迁移:原断言「广播 seek-ratio 2.5/6」→ 选段请求落点 2.5 s(同一时刻,改由选段状态机定位并立围栏)。
    const seen = selectionEvents();
    const hit = screen.getByRole("button", { name: "在时间刻度上定位" });
    vi.spyOn(hit, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 800, height: 22, right: 800, bottom: 22, x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => {
      fireEvent.click(hit, { clientX: BAND_SEGMENT_PITCH + BAND_TILE_WIDTH / 2, clientY: 10 });
    });
    expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 2 });
    // 素材刚切过去时播放器还没就绪;状态轮询追上「就绪且是 B」才发。
    await waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0]).toBeCloseTo(2.5, 6);
  });

  it("点镜块:选中之外还按点在块内的位置定位(A 块 25% → 1 s / 6 s)", async () => {
    await renderBand();
    // R25 迁移:原断言「seek-ratio 1/6」→ 选段请求落点 1 s。
    const seen = selectionEvents();
    const first = screen.getByRole("gridcell", { name: "镜头 1：A.MP4" });
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue({ left: 100, top: 0, width: BAND_TILE_WIDTH, height: 112, right: 100 + BAND_TILE_WIDTH, bottom: 112, x: 100, y: 0, toJSON: () => ({}) });
    apiMocks.playerStatus.mockResolvedValue({ ...READY, clip_id: 1, pos: 0 });
    await act(async () => {
      fireEvent.click(first, { clientX: 100 + BAND_TILE_WIDTH / 4, clientY: 10 });
    });
    expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 1 });
    await waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0]).toBeCloseTo(1, 6);
  });
});

describe("§4 播放头", () => {
  it("选中 B、播放器报 pos 2.5 s → 红线在 B 块内 (2.5 − 0.5) / 4 = 50% 处;stage 带 is-playing", async () => {
    await renderBand();
    await act(async () => {
      fireEvent.click(screen.getByRole("gridcell", { name: "镜头 2：B.MP4" }));
    });
    const playhead = await waitFor(() => {
      const node = document.querySelector(".band-playhead");
      if (!node) throw new Error("no playhead yet");
      return node as HTMLElement;
    });
    expect(Number(playhead.dataset.px)).toBe(BAND_SEGMENT_PITCH + BAND_TILE_WIDTH / 2);
    expect(document.querySelector(".band-timeline-stage")!.classList.contains("is-playing")).toBe(true);
    expect(apiMocks.playerStatus).toHaveBeenCalled();
  });

  it("没选中带上的素材时不轮询 player_status,也没有红线", async () => {
    await renderBand();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(apiMocks.playerStatus).not.toHaveBeenCalled();
    expect(document.querySelector(".band-playhead")).toBeNull();
  });
});

describe("§4 拖边裁入出点(只改我们自己的精选段)", () => {
  it("精选段镜块有「调整入点 / 调整出点」;整条素材的镜块没有", async () => {
    await renderBand();
    const second = screen.getByRole("gridcell", { name: "镜头 2：B.MP4" });
    expect(within(second).getByRole("button", { name: "调整入点" })).toBeTruthy();
    expect(within(second).getByRole("button", { name: "调整出点" })).toBeTruthy();
    expect(within(screen.getByRole("gridcell", { name: "镜头 1：A.MP4" })).queryByRole("button", { name: "调整入点" })).toBeNull();
  });

  it("入点按 → 原位更新 77，保留段 ID，撤销回原始入出点", async () => {
    await renderBand();
    const second = screen.getByRole("gridcell", { name: "镜头 2：B.MP4" });
    fireEvent.keyDown(within(second).getByRole("button", { name: "调整入点" }), { key: "ArrowRight" });
    await waitFor(() => expect(apiMocks.trimBandSegment).toHaveBeenCalledWith(1, 77, [500, 4500], [600, 4500]));
    expect(apiMocks.createSelectSegment).not.toHaveBeenCalled();
    expect(apiMocks.deleteSelectSegment).not.toHaveBeenCalled();
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("已修剪 1 段");
    fireEvent.click(within(toast).getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(apiMocks.trimBandSegment).toHaveBeenLastCalledWith(1, 77, [600, 4500], [500, 4500]));
  });

  it("拖出点预览时码，提交失败保留原片段，不产生新段或删除", async () => {
    apiMocks.trimBandSegment.mockRejectedValueOnce(new Error("没有进行中的 Episode"));
    await renderBand();
    const second = screen.getByRole("gridcell", { name: "镜头 2：B.MP4" });
    const handle = within(second).getByRole("button", { name: "调整出点" });
    await act(async () => {
      fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 300 - BAND_TILE_WIDTH / 4, pointerId: 1 });
    });
    expect(within(second).getByRole("status").textContent).toBe("出 00:00:03.500 · 3 s");
    fireEvent.pointerUp(handle, { clientX: 300 - BAND_TILE_WIDTH / 4, pointerId: 1 });
    await waitFor(() => expect(apiMocks.trimBandSegment).toHaveBeenCalledWith(1, 77, [500, 4500], [500, 3500]));
    expect(apiMocks.createSelectSegment).not.toHaveBeenCalled();
    expect(apiMocks.deleteSelectSegment).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByRole("status").some(node => node.textContent?.includes("裁剪没成功"))).toBe(true));
  });
});

describe("§4 章节 = 轨道分组,轨头可折叠", () => {
  it("轨头「折叠第 1 章」aria-expanded=true;点它 → false,镜块收起成「2 镜 · 已收起」,章只占一个节距;再点展开", async () => {
    await renderBand();
    const first = screen.getByRole("rowgroup", { name: "第 1 章 出发" });
    const fold = within(first).getByRole("button", { name: "折叠第 1 章" });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(first.style.width).toBe(`${2 * BAND_SEGMENT_PITCH - 8}px`);
    fireEvent.click(fold);
    const unfold = within(first).getByRole("button", { name: "展开第 1 章" });
    expect(unfold.getAttribute("aria-expanded")).toBe("false");
    expect(within(first).queryByRole("gridcell", { name: "镜头 1：A.MP4" })).toBeNull();
    expect(within(first).getByText("2 镜 · 已收起")).toBeTruthy();
    expect(first.style.width).toBe(`${BAND_SEGMENT_PITCH - 8}px`);
    // 折叠后刻度重排:第 1 章 8 s 压进一格,总时长仍 12 s(标签 0:00 / 0:05 / 0:10 还在)。
    expect(Array.from(screen.getByRole("img", { name: "时间刻度" }).querySelectorAll(".band-time-mark-label")).map((node) => node.textContent)).toEqual(["0:00", "0:05", "0:10"]);
    fireEvent.click(unfold);
    expect(within(first).getByRole("gridcell", { name: "镜头 1：A.MP4" })).toBeTruthy();
  });

  it("Y-12:章头折叠按钮与「已收起」格都在 grid 的内容模型里(rowgroup > row > rowheader / gridcell > button),WebKit 才不会把它们从 AX 树剔掉", async () => {
    await renderBand();
    const first = screen.getByRole("rowgroup", { name: "第 1 章 出发" });
    const fold = within(first).getByRole("button", { name: "折叠第 1 章" });
    const headCell = fold.closest('[role="rowheader"]');
    expect(headCell).not.toBeNull();
    const headRow = headCell?.closest('[role="row"]');
    expect(headRow).not.toBeNull();
    expect(headRow?.parentElement).toBe(first);
    // 章头里所有可见文字(序号 / 标题 / 时长 / 镜数)都在同一个 rowheader 里,不再是 rowgroup 的裸子节点;
    // 章头不是 gridcell —— 「所有 gridcell」仍只数镜块。
    expect(within(first).queryAllByRole("gridcell").every((cell) => !cell.contains(fold))).toBe(true);
    expect(headCell?.textContent).toContain("出发");
    fireEvent.click(fold);
    const collapsed = within(first).getByRole("button", { name: /已收起/ });
    expect(collapsed.closest('[role="gridcell"]')?.closest('[role="row"]')?.parentElement).toBe(first);
    // 折叠后的两颗按钮都是真 <button>(不是挂 onClick 的 div)。
    expect(collapsed.tagName).toBe("BUTTON");
    expect(within(first).getByRole("button", { name: "展开第 1 章" }).tagName).toBe("BUTTON");
  });
});

describe("§4 / §5 「导入剪映继续剪」常驻右上", () => {
  it("剪映不可用(R14 §9 B):按钮文案与 AX 名改「导出剪映素材包」,tooltip 一句白话;点它打开交付抽屉并落在「剪映素材包」模式", async () => {
    await renderBand();
    const button = await screen.findByRole("button", { name: "导出剪映素材包" });
    await waitFor(() => expect(button.title).toContain("没检测到剪映"));
    expect(button.textContent).toBe("导出剪映素材包");
    expect(screen.queryByRole("button", { name: "导入剪映继续剪" })).toBeNull();
    fireEvent.click(button);
    expect(getWorkspaceSnapshot().openDrawer).toBe("deliver");
    expect(takePendingExportMode()).toBe("kit");
  });

  it("剪映可用(白名单版本):仍是「导入剪映继续剪」,secondary(R19 V-01)、不带「(待验证)」;点它要求「剪映草稿」模式", async () => {
    apiMocks.getJianyingAvailability.mockResolvedValue({ installed_version: "11.3.0", supported: true, reason: "" });
    await renderBand();
    const button = await screen.findByRole("button", { name: "导入剪映继续剪" });
    await waitFor(() => expect(button.className).toContain("ui-button--secondary"));
    expect(button.className).not.toContain("ui-button--primary");
    expect(button.textContent).not.toContain("待验证");
    fireEvent.click(button);
    expect(getWorkspaceSnapshot().openDrawer).toBe("deliver");
    expect(takePendingExportMode()).toBe("jianying");
  });
});
