// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R10 车道 D 的镜头带回归:U-17(空章算缺口 / 占位入口 / 忽略可撤销)、U-18(不靠拖拽的
 * 「从媒体池选择…」→ set_story_order)、U-29(计数分列)、U-30(缺口说明可展开)。
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
  setSetting: vi.fn().mockResolvedValue(undefined),
  setStoryOrder: vi.fn().mockResolvedValue(undefined),
  undoStoryChange: vi.fn().mockResolvedValue(undefined),
  rateClip: vi.fn().mockResolvedValue(undefined),
  generationAvailability: vi.fn(),
  dismissStoryGap: vi.fn().mockResolvedValue(undefined),
  reopenStoryGap: vi.fn().mockResolvedValue(undefined),
  listStoryTemplates: vi.fn().mockResolvedValue([]),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...apiMocks,
}));

import type { ClipListItem, Storyboard, StoryGap, StoryItem } from "../api";
import { ShotBand } from "./ShotBand";
import { __resetClipsFeedForTests } from "./useClipsFeed";
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

function gap(id: number, chapterId: number, slot: string, labelZh: string): StoryGap {
  return {
    id,
    chapter_id: chapterId,
    chapter_title: "出发",
    beat_id: null,
    slot,
    slot_label_zh: labelZh,
    reason: "第 1 章计划了建立镜头,但素材里没有一条稳定广角能压住开场,所以这里留了一个槽位等你补。",
    status: "open",
    latest_request: null,
  };
}

/** 第 1 章一条素材;第 2 章空;clip 2 已收藏但还没进故事顺序(候选),clip 3 三星,clip 4 未评。 */
const board: Storyboard = {
  chapters: [
    { id: 1, title: "出发", start_at: "", end_at: "", clip_count: 1 },
    { id: 2, title: "抵达", start_at: "", end_at: "", clip_count: 0 },
  ],
  items: [item(1, 1, "A.MP4", 0)],
  candidates: [item(2, 2, "B.MP4", null)],
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
  apiMocks.listClips.mockResolvedValue([
    clip(1, "A.MP4", { binary_rating: 1 }),
    clip(2, "B.MP4", { binary_rating: 1 }),
    clip(3, "C.MP4", { star_rating: 3 }),
    clip(4, "D.MP4"),
  ]);
  apiMocks.getStoryboard.mockResolvedValue(board);
  apiMocks.listShotStacks.mockResolvedValue([]);
  apiMocks.listStoryGaps.mockResolvedValue([]);
  apiMocks.listClipDimensions.mockResolvedValue([]);
  apiMocks.listAssetSafety.mockResolvedValue([]);
  apiMocks.getCurrentEpisode.mockResolvedValue({ id: 1, title: "EP01" });
  apiMocks.generationAvailability.mockResolvedValue({ enabled: false, has_key: false, budget_remaining_usd: 0 });
  apiMocks.setStoryOrder.mockResolvedValue(undefined);
  apiMocks.rateClip.mockResolvedValue(undefined);
  apiMocks.dismissStoryGap.mockResolvedValue(undefined);
  apiMocks.reopenStoryGap.mockResolvedValue(undefined);
});
afterEach(cleanup);

async function renderBand(): Promise<void> {
  render(<ShotBand />);
  await screen.findByRole("gridcell", { name: "镜头 1：A.MP4" });
}

describe("U-29:章节头与栏标题条把镜与缺口分列", () => {
  it("空章带头「0 镜 · 1 缺口」+「空章」角标;栏标题条「2 章 · 1 镜 · 1 缺口」;章名带 tooltip", async () => {
    await renderBand();
    const second = screen.getByRole("rowgroup", { name: "第 2 章 抵达" });
    expect(within(second).getByText("0 镜 · 1 缺口")).toBeTruthy();
    expect(second.querySelector(".ui-badge--warn")!.textContent).toBe("空章");
    expect(second.querySelector(".band-chapter-title")!.getAttribute("title")).toBe("抵达");
    expect(screen.getByRole("region", { name: "镜头带" }).textContent).toContain("2 章 · 1 镜 · 1 缺口");
  });
});

describe("U-17:空章算缺口,占位上有可点的入口", () => {
  it("「仅缺口」视图包含 0 镜的章,而不是「所有章节都没有缺口」", async () => {
    await renderBand();
    fireEvent.click(screen.getByRole("button", { name: "仅缺口" }));
    expect(screen.getAllByRole("rowgroup").map((group) => group.getAttribute("aria-label"))).toEqual(["第 2 章 抵达"]);
    expect(screen.queryByText("所有章节都没有缺口。")).toBeNull();
  });

  it("空章占位:「生成候选」禁用并给「去设置」链接(打开设置 sheet + 云端补镜分区事件)", async () => {
    await renderBand();
    const second = screen.getByRole("rowgroup", { name: "第 2 章 抵达" });
    expect(within(second).getByRole("button", { name: "生成候选" })).toHaveProperty("disabled", true);
    expect(within(second).getByText(/云端补镜未启用/)).toBeTruthy();
    const heard = vi.fn();
    window.addEventListener("tripcut:open-settings-section", heard);
    fireEvent.click(within(second).getByRole("button", { name: "去设置" }));
    expect(getWorkspaceSnapshot().openDrawer).toBe("settings");
    expect(getWorkspaceSnapshot().settingsSection).toBe("generation");
    expect((heard.mock.calls[0]![0] as CustomEvent).detail).toEqual({ section: "generation" });
    window.removeEventListener("tripcut:open-settings-section", heard);
  });

  it("空槽位:「忽略」后给 5 秒可撤销提示,「撤销」调 reopen_story_gap", async () => {
    apiMocks.listStoryGaps.mockResolvedValue([gap(10, 1, "REAL/ESTABLISHING", "建立镜头")]);
    render(<ShotBand />);
    const cell = await screen.findByRole("gridcell", { name: "镜头 2：缺口 建立镜头" });
    expect(within(cell).getByRole("button", { name: "从媒体池选择…" })).toBeTruthy();
    expect(within(cell).getByRole("button", { name: "去设置" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(cell).getByRole("button", { name: "忽略" }));
    });
    await waitFor(() => expect(apiMocks.dismissStoryGap).toHaveBeenCalledWith(10));
    const toast = await screen.findByText("已忽略缺口「建立镜头」");
    await act(async () => {
      fireEvent.click(within(toast.closest(".band-toast")!).getByRole("button", { name: "撤销" }));
    });
    await waitFor(() => expect(apiMocks.reopenStoryGap).toHaveBeenCalledWith(10));
  });
});

describe("U-30:缺口说明可展开", () => {
  it("说明是 aria-expanded 的 disclosure,点一下展开、再点收回,且不换掉选中", async () => {
    apiMocks.listStoryGaps.mockResolvedValue([gap(10, 1, "REAL/ESTABLISHING", "建立镜头")]);
    render(<ShotBand />);
    const cell = await screen.findByRole("gridcell", { name: "镜头 2：缺口 建立镜头" });
    const reason = within(cell).getByRole("button", { name: /第 1 章计划了建立镜头/ });
    expect(reason.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(reason);
    expect(reason.getAttribute("aria-expanded")).toBe("true");
    expect(reason.className).toContain("is-open");
    expect(getWorkspaceSnapshot().selection).toBeNull();
    fireEvent.click(reason);
    expect(reason.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("U-18:「从媒体池选择…」是不靠拖拽的第二条路", () => {
  it("列表只列收藏 ∪ ≥3 星且不在带上的素材;点一条 → set_story_order 追加到它的章末,提示说出章名", async () => {
    await renderBand();
    const second = screen.getByRole("rowgroup", { name: "第 2 章 抵达" });
    fireEvent.click(within(second).getByRole("button", { name: "从媒体池选择…" }));
    const dialog = screen.getByRole("dialog", { name: "从媒体池选择" });
    expect(within(dialog).getAllByRole("button", { name: /^加入 / }).map((button) => button.textContent)).toEqual([
      "B.MP4收藏",
      "C.MP43 星",
    ]);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "加入 B.MP4" }));
    });
    await waitFor(() =>
      expect(apiMocks.setStoryOrder).toHaveBeenCalledWith([
        { item_kind: "whole", clip_id: 1, segment_id: null },
        { item_kind: "whole", clip_id: 2, segment_id: null },
      ]),
    );
    // 已收藏的不再收藏一次。
    expect(apiMocks.rateClip).not.toHaveBeenCalled();
    expect(await screen.findByText("已加入第 2 章「抵达」")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "从媒体池选择" })).toBeNull();
  });

  it("三星但没收藏的素材:先收藏整条(故事板只认收藏)再入带,提示写明「已自动收藏整条」", async () => {
    await renderBand();
    // 收藏之后后端才会把它列进候选:第二次 getStoryboard 给出带候选的那一份。
    apiMocks.getStoryboard.mockResolvedValue({ ...board, candidates: [...board.candidates, item(3, 1, "C.MP4", null)] });
    fireEvent.click(within(screen.getByRole("rowgroup", { name: "第 2 章 抵达" })).getByRole("button", { name: "从媒体池选择…" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "加入 C.MP4" }));
    });
    await waitFor(() => expect(apiMocks.rateClip).toHaveBeenCalledWith(3, "binary", 1));
    await waitFor(() =>
      expect(apiMocks.setStoryOrder).toHaveBeenCalledWith([
        { item_kind: "whole", clip_id: 1, segment_id: null },
        { item_kind: "whole", clip_id: 3, segment_id: null },
      ]),
    );
    expect(await screen.findByText("已加入第 1 章「出发」，并已自动收藏整条")).toBeTruthy();
  });

  it("池里没有合格素材时给「去媒体池」而不是空列表", async () => {
    apiMocks.listClips.mockResolvedValue([clip(1, "A.MP4", { binary_rating: 1 }), clip(4, "D.MP4")]);
    await renderBand();
    fireEvent.click(within(screen.getByRole("rowgroup", { name: "第 2 章 抵达" })).getByRole("button", { name: "从媒体池选择…" }));
    const dialog = screen.getByRole("dialog", { name: "从媒体池选择" });
    expect(within(dialog).getByText("没有素材满足『收藏或 ≥3 星』")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "去媒体池" }));
    expect(getWorkspaceSnapshot().focusedPane).toBe("pool");
    expect(screen.queryByRole("dialog", { name: "从媒体池选择" })).toBeNull();
  });
});

describe("R-02:瓦片时长角标与章节头按素材 time base 换算", () => {
  it("1/19200 的 23.5 s 素材:瓦片「0:23」,章节头「0:23」而不是「7:31」", async () => {
    apiMocks.getStoryboard.mockResolvedValue({
      ...board,
      items: [{ ...item(1, 1, "A.MP4", 0), out_ticks: 19_200 * 23 + 9_600, tb_num: 1, tb_den: 19_200 }],
    });
    await renderBand();
    const first = screen.getByRole("rowgroup", { name: "第 1 章 出发" });
    expect(first.querySelector(".band-tile-time")!.textContent).toBe("0:23");
    expect(first.querySelector(".band-chapter-meta")!.textContent).toBe("0:23");
  });
});

describe("R-08:缺口卡片底行不被裁", () => {
  const BAND_R10_CSS = readFileSync(resolve(process.cwd(), "src/styles/workspace/band-inspector-r10.css"), "utf8");

  it("说明文字的 line-clamp 打在 <button> 里的 span 上(WebKit 的按钮不认 -webkit-box 截行,会撑成四行把底行挤出卡片)", async () => {
    apiMocks.listStoryGaps.mockResolvedValue([gap(10, 1, "REAL/ESTABLISHING", "建立镜头")]);
    apiMocks.generationAvailability.mockResolvedValue({ enabled: false, has_key: false, budget_remaining_usd: 0 });
    render(<ShotBand />);
    const cell = await screen.findByRole("gridcell", { name: "镜头 2：缺口 建立镜头" });
    const reason = within(cell).getByRole("button", { name: /第 1 章计划了建立镜头/ });
    expect(reason.querySelector(".band-slot-reason-text")?.textContent).toContain("第 1 章计划了建立镜头");
    // 底行「云端补镜未启用 去设置」仍在
    expect(within(cell).getByRole("button", { name: "去设置" })).toBeTruthy();
  });

  it("CSS:说明按钮可收缩不撑高(min-height 0 / overflow hidden),按钮行与提示行不可收缩,内层 .band-slot 裁掉溢出", () => {
    const reason = /\.band-slot-reason\s*\{[^}]*\}/.exec(BAND_R10_CSS)?.[0] ?? "";
    expect(reason).toMatch(/min-height:\s*0/);
    expect(reason).toMatch(/flex:\s*0 1 auto/);
    const text = /\.band-slot-reason-text\s*\{[^}]*\}/.exec(BAND_R10_CSS)?.[0] ?? "";
    expect(text).toMatch(/-webkit-line-clamp:\s*1/);
    expect(text).toMatch(/display:\s*-webkit-box/);
    expect(BAND_R10_CSS).toMatch(/\.band-slot-buttons,\s*\n?\.workspace-shell \.shot-band \.band-slot small\.band-slot-hint\s*\{[^}]*flex:\s*0 0 auto/);
    expect(BAND_R10_CSS).toMatch(/\.band-slot\s*\{[^}]*overflow:\s*hidden/);
  });
});
