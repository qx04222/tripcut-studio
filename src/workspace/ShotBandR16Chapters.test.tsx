// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R16 车道 B(规格 §1 / §2):章头内联改名(P1-3)、章头「···」菜单的「并入上一章」/「删除这一章…」(P2-1)。
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
  generationAvailability: vi.fn(),
  listStoryTemplates: vi.fn().mockResolvedValue([]),
  renameChapter: vi.fn().mockResolvedValue(undefined),
  mergeChapters: vi.fn().mockResolvedValue(undefined),
  deleteChapter: vi.fn().mockResolvedValue(undefined),
  undoStoryChange: vi.fn().mockResolvedValue(undefined),
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
    binary_rating: null,
    star_rating: null,
    select_count: 0,
  } as ClipListItem;
}

/** 第 1 章一镜(A),第 2 章两镜(B、C)。 */
const board: Storyboard = {
  chapters: [
    { id: 1, title: "出发", start_at: "", end_at: "", clip_count: 1 },
    { id: 2, title: "抵达", start_at: "", end_at: "", clip_count: 2 },
  ],
  items: [item(1, 1, "A.MP4", 0), item(2, 2, "B.MP4", 1), item(3, 2, "C.MP4", 2)],
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
  apiMocks.listClips.mockResolvedValue([clip(1, "A.MP4"), clip(2, "B.MP4"), clip(3, "C.MP4")]);
  apiMocks.getStoryboard.mockResolvedValue(board);
  apiMocks.listShotStacks.mockResolvedValue([]);
  apiMocks.listStoryGaps.mockResolvedValue([]);
  apiMocks.listClipDimensions.mockResolvedValue([]);
  apiMocks.listAssetSafety.mockResolvedValue([]);
  apiMocks.getCurrentEpisode.mockResolvedValue({ id: 1, title: "EP01" });
  apiMocks.getSettings.mockResolvedValue({});
  apiMocks.generationAvailability.mockResolvedValue({ enabled: false, has_key: false, budget_remaining_usd: 0 });
});
afterEach(cleanup);

async function renderBand(): Promise<void> {
  render(<><ShotBand /><ToastHost /></>);
  await screen.findByRole("gridcell", { name: "镜头 1：A.MP4" });
}

const chapterHead = (name: string) => within(screen.getByRole("rowgroup", { name })).getByRole("rowheader");

describe("P1-3 章头内联改名", () => {
  it("双击章名 → 输入框「章节名」预填旧名;Enter → renameChapter(1, 新名) → toast「已改名」;不用 window.prompt", async () => {
    const prompt = vi.spyOn(window, "prompt");
    await renderBand();
    fireEvent.doubleClick(within(chapterHead("第 1 章 出发")).getByText("出发"));
    const input = screen.getByRole("textbox", { name: "章节名" }) as HTMLInputElement;
    expect(input.value).toBe("出发");
    fireEvent.change(input, { target: { value: "机场出发" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() => expect(apiMocks.renameChapter).toHaveBeenCalledWith(1, "机场出发"));
    expect(prompt).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "章节名" })).toBeNull();
    expect((await screen.findByRole("status")).textContent).toContain("已改名为「机场出发」");
  });

  it("Esc 取消:不发命令,章名不变;空名不提交", async () => {
    await renderBand();
    fireEvent.doubleClick(within(chapterHead("第 1 章 出发")).getByText("出发"));
    const input = screen.getByRole("textbox", { name: "章节名" });
    fireEvent.change(input, { target: { value: "改了" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "章节名" })).toBeNull();
    expect(apiMocks.renameChapter).not.toHaveBeenCalled();
    expect(within(chapterHead("第 1 章 出发")).getByText("出发")).toBeTruthy();

    fireEvent.doubleClick(within(chapterHead("第 1 章 出发")).getByText("出发"));
    const again = screen.getByRole("textbox", { name: "章节名" });
    fireEvent.change(again, { target: { value: "   " } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(apiMocks.renameChapter).not.toHaveBeenCalled();
  });

  it("章头「···」→ 菜单「章操作 · 出发」有「重命名」,点它进入同一个内联输入框", async () => {
    await renderBand();
    fireEvent.click(within(chapterHead("第 1 章 出发")).getByRole("button", { name: "章操作 · 出发" }));
    const menu = screen.getByRole("menu", { name: "章操作 · 出发" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "重命名" }));
    expect(screen.getByRole("textbox", { name: "章节名" })).toBeTruthy();
  });

  it("失败时 toast 说清:renameChapter 抛错 → 「改名没成功:…」,输入框留着", async () => {
    apiMocks.renameChapter.mockRejectedValueOnce(new Error("章节名须为 1–80 个字符"));
    await renderBand();
    fireEvent.doubleClick(within(chapterHead("第 1 章 出发")).getByText("出发"));
    const input = screen.getByRole("textbox", { name: "章节名" });
    fireEvent.change(input, { target: { value: "x" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("改名没成功:章节名须为 1–80 个字符"));
    expect(screen.getByRole("textbox", { name: "章节名" })).toBeTruthy();
  });
});

describe("P2-1 章头菜单:并入上一章 / 删除这一章…", () => {
  const openMenu = (title: string, ordinal: number) => {
    fireEvent.click(within(chapterHead(`第 ${ordinal} 章 ${title}`)).getByRole("button", { name: `章操作 · ${title}` }));
    return screen.getByRole("menu", { name: `章操作 · ${title}` });
  };

  it("菜单项顺序冻结:重命名 · 并入上一章 · 这章够了 · 删除这一章…;第 1 章的「并入上一章」禁用", async () => {
    await renderBand();
    const menu = openMenu("抵达", 2);
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["重命名", "并入上一章", "这章够了", "删除这一章…"]);
    fireEvent.keyDown(document, { key: "Escape" });
    const first = openMenu("出发", 1);
    expect(within(first).getByRole("menuitem", { name: "并入上一章" })).toHaveProperty("disabled", true);
  });

  it("「并入上一章」→ mergeChapters(2, 1) → toast 带「撤销」→ undoStoryChange;并推一条 tripcut:undo-push", async () => {
    const pushed: { label: string; undo: () => Promise<void> }[] = [];
    const onPush = (event: Event) => pushed.push((event as CustomEvent).detail);
    window.addEventListener("tripcut:undo-push", onPush);
    await renderBand();
    const mergeItem = within(openMenu("抵达", 2)).getByRole("menuitem", { name: "并入上一章" });
    await act(async () => {
      fireEvent.click(mergeItem);
    });
    await waitFor(() => expect(apiMocks.mergeChapters).toHaveBeenCalledWith(2, 1));
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("已把「抵达」并入「出发」");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.label).toContain("并入上一章");
    await act(async () => {
      fireEvent.click(within(toast).getByRole("button", { name: "撤销" }));
    });
    await waitFor(() => expect(apiMocks.undoStoryChange).toHaveBeenCalledTimes(1));
    // 同一次并入只撤一次:toast 撤过之后 ⌘Z 栈里那条再跑也不再发命令。
    await pushed[0]!.undo();
    expect(apiMocks.undoStoryChange).toHaveBeenCalledTimes(1);
    window.removeEventListener("tripcut:undo-push", onPush);
  });

  it("「删除这一章…」→ 确认卡「确认删除章」列出镜数与去向;取消不发命令;确认 → deleteChapter(2) → toast", async () => {
    await renderBand();
    fireEvent.click(within(openMenu("抵达", 2)).getByRole("menuitem", { name: "删除这一章…" }));
    const card = screen.getByRole("alertdialog", { name: "确认删除章" });
    expect(card.textContent).toContain("这一章的 2 个镜头会移到「出发」");
    fireEvent.click(within(card).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog", { name: "确认删除章" })).toBeNull();
    expect(apiMocks.deleteChapter).not.toHaveBeenCalled();

    fireEvent.click(within(openMenu("抵达", 2)).getByRole("menuitem", { name: "删除这一章…" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alertdialog", { name: "确认删除章" })).getByRole("button", { name: "删除这一章" }));
    });
    await waitFor(() => expect(apiMocks.deleteChapter).toHaveBeenCalledWith(2));
    expect(screen.queryByRole("alertdialog", { name: "确认删除章" })).toBeNull();
    expect((await screen.findByRole("status")).textContent).toContain("已删除「抵达」");
  });

  it("第 1 章的删除确认说镜头会移到下一章;deleteChapter 抛错时 toast「删除没成功」", async () => {
    apiMocks.deleteChapter.mockRejectedValueOnce(new Error("只剩这一章了,不能删除"));
    await renderBand();
    fireEvent.click(within(openMenu("出发", 1)).getByRole("menuitem", { name: "删除这一章…" }));
    const card = screen.getByRole("alertdialog", { name: "确认删除章" });
    expect(card.textContent).toContain("这一章的 1 个镜头会移到「抵达」");
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "删除这一章" }));
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("删除没成功:只剩这一章了,不能删除"));
  });
});
