// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Storyboard, ClipListItem, StoryGap } from "../../api";
import { createTestApiMock } from "../testApiMock";
vi.mock("../../api", () => createTestApiMock());
const dnd = vi.hoisted(() => ({ current: null as Record<string, (event: unknown) => void> | null }));
vi.mock("@dnd-kit/core", () => ({
  DndContext: (props: { children: ReactNode }) => { dnd.current = props as never; return props.children; },
  DragOverlay: ({ children }: { children: ReactNode }) => children,
  PointerSensor: function () {}, useSensor: () => ({}), useSensors: () => [],
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => children, horizontalListSortingStrategy: undefined,
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => undefined, setActivatorNodeRef: () => undefined, transform: null, transition: undefined, isDragging: false }),
}));
import * as api from "../../api";
import { handleMockCommand, __resetMockForTests } from "../../devMock/fixture";
import { ShotBand } from "../ShotBand";
import { ToastHost } from "../ui/Toast";
import { __resetClipsFeedForTests } from "../useClipsFeed";
import { __resetWorkspaceForTests, dispatchWorkspace, getWorkspaceSnapshot } from "../WorkspaceStore";
import { __resetToastsForTests } from "../ui/toastStore";
import { __resetUndoForTests, runUndo, peekUndo } from "../undoStack";
let board: Storyboard, clips: ClipListItem[], settings: Record<string, string>, gaps: StoryGap[];
beforeEach(() => {
  vi.clearAllMocks(); __resetMockForTests(); __resetClipsFeedForTests(); __resetWorkspaceForTests(); __resetToastsForTests(); __resetUndoForTests();
  const fixture = handleMockCommand("get_storyboard", {}) as Storyboard;
  const first = fixture.items[0]!;
  board = { ...fixture, mode: "legacy", narrative: null, chapters: fixture.chapters.slice(0, 2), candidates: [], items: [
    { ...first, key: "segment:101", item_kind: "segment", segment_id: 101, in_ticks: 1000, out_ticks: 3000, position: 0 },
    { ...first, key: "segment:102", item_kind: "segment", segment_id: 102, in_ticks: 4000, out_ticks: 6000, position: 1 },
    { ...fixture.items[1]!, key: "segment:103", item_kind: "segment", segment_id: 103, chapter_id: fixture.chapters[1]!.id, position: 2 },
  ] };
  clips = handleMockCommand("list_clips", {}) as ClipListItem[]; settings = {}; gaps = [];
  vi.mocked(api.getStoryboard).mockImplementation(async () => structuredClone(board));
  vi.mocked(api.listClips).mockImplementation(async () => clips);
  vi.mocked(api.listStoryGaps).mockImplementation(async () => gaps);
  vi.mocked(api.getCurrentEpisode).mockResolvedValue({ id: clips[0]!.episode_id!, title: "EP01" } as never);
  vi.mocked(api.getSettings).mockImplementation(async () => ({ ...settings }));
  vi.mocked(api.setSetting).mockImplementation(async (key, value) => { settings[key] = value; });
  vi.mocked(api.setBandOrder).mockImplementation(async (_episode, order, chapterOrder) => {
    const pool = [...board.items, ...board.candidates];
    board.items = order.map((ref, position) => ({ ...pool.find(item => item.segment_id === ref.segment_id && item.clip_id === ref.clip_id)!, chapter_id: ref.chapter_id, position }));
    board.candidates = pool.filter(item => !board.items.some(next => next.key === item.key));
    board.chapters.sort((a, b) => chapterOrder.indexOf(a.id) - chapterOrder.indexOf(b.id));
  });
  vi.mocked(api.playerStatus).mockResolvedValue({ phase: "ready", clip_id: first.clip_id, pos: 2, duration: 10, paused: true } as never);
  vi.mocked(api.dismissStoryGap).mockImplementation(async id => { gaps = gaps.map(gap => gap.id === id ? { ...gap, status: "dismissed" } : gap); });
  vi.mocked(api.reopenStoryGap).mockImplementation(async id => { gaps = gaps.map(gap => gap.id === id ? { ...gap, status: "open" } : gap); });
});
afterEach(() => { cleanup(); __resetClipsFeedForTests(); vi.useRealTimers(); });
async function mount() {
  render(<><ShotBand /><ToastHost /></>);
  await screen.findByRole("gridcell", { name: /^镜头 1：/ });
  return screen.getByRole("grid", { name: "镜头序列" });
}
const cells = () => screen.getAllByRole("gridcell").filter(cell => cell.hasAttribute("data-clip-id"));

it("selects cuts independently; shift, cmd, cmdA and Delete perform one reversible edit", async () => {
  const grid = await mount();
  fireEvent.click(cells()[0]!); fireEvent.click(cells()[1]!, { metaKey: true });
  expect(screen.getByText("已选 2")).toBeTruthy();
  expect(cells().filter(cell => cell.getAttribute("aria-selected") === "true")).toHaveLength(2);
  fireEvent.click(cells()[2]!, { shiftKey: true }); expect(screen.getByText("已选 2")).toBeTruthy();
  fireEvent.keyDown(grid, { key: "a", metaKey: true }); expect(screen.getByText("已选 3")).toBeTruthy();
  fireEvent.keyDown(grid, { key: "Delete" });
  await waitFor(() => expect(api.setBandOrder).toHaveBeenCalledTimes(1));
  expect(board.items).toHaveLength(0); expect(peekUndo()?.label).toBe("移出 3 段");
  await act(async () => { await runUndo(); }); expect(board.items).toHaveLength(3);
});
it("deduplicates source IDs when selected sibling cuts receive a batch rating", async () => {
  const grid = await mount(); fireEvent.click(cells()[0]!); fireEvent.click(cells()[1]!, { metaKey: true });
  fireEvent.keyDown(grid, { key: "f", code: "KeyF" });
  await waitFor(() => expect(api.rateClips).toHaveBeenCalledWith([{ clip_id: board.items[0]!.clip_id, rating_type: "binary", value: 1 }]));
  expect(peekUndo()?.label).toBe("收藏 1 条素材");
});
it("moves a multiselection to another chapter and one undo restores both cuts", async () => {
  await mount(); fireEvent.click(cells()[0]!); fireEvent.click(cells()[1]!, { metaKey: true });
  act(() => dnd.current!.onDragEnd!({ active: { id: "segment:101" }, over: { id: "segment:103" } }));
  await waitFor(() => expect(api.setBandOrder).toHaveBeenCalledTimes(1));
  expect(board.items.filter(item => [101, 102].includes(item.segment_id!)).every(item => item.chapter_id === board.chapters[1]!.id)).toBe(true);
  await act(async () => { await runUndo(); });
  expect(board.items[0]!.chapter_id).toBe(board.chapters[0]!.id);
});
it("persists collapse and zoom by episode silently: no toast, and ⌘Z has nothing to undo (R22-C decision)", async () => {
  const grid = await mount();
  fireEvent.click(screen.getByRole("button", { name: "折叠第 1 章" }));
  await waitFor(() => expect(api.setSetting).toHaveBeenCalledTimes(1));
  const key = `ui.band.view.${clips[0]!.episode_id}`;
  expect(JSON.parse(settings[key]!).folded).toEqual([`chapter:${board.chapters[0]!.id}`]);
  fireEvent.focus(grid);
  fireEvent.keyDown(grid, { key: "-", metaKey: true });
  await waitFor(() => expect(JSON.parse(settings[key]!).zoom).toBe(0.75));
  expect(screen.queryByRole("status")).toBeNull();
  expect(peekUndo()).toBeNull();
  await act(async () => { expect(await runUndo()).toBeNull(); });
  expect(JSON.parse(settings[key]!).zoom).toBe(0.75);
});
it("dragging the chapter head reorders the chapter as one operation", async () => {
  await mount(); const before = board.chapters.map(chapter => chapter.id);
  act(() => dnd.current!.onDragEnd!({ active: { id: `band-chapter:${before[0]}` }, over: { id: `band-chapter:${before[1]}` } }));
  await waitFor(() => expect(api.setBandOrder).toHaveBeenCalledTimes(1));
  expect(board.chapters.map(chapter => chapter.id)).toEqual([...before].reverse());
  expect(board.items).toHaveLength(3);
});
it("gap pool action expands the pool and ignore/restore share the undo stack", async () => {
  const gap = (handleMockCommand("list_story_gaps", {}) as StoryGap[])[0]!;
  gaps = [{ ...gap, chapter_id: board.chapters[0]!.id, band_chapter_id: board.chapters[0]!.id }];
  await mount();
  const gapCell = screen.getAllByRole("gridcell").find(cell => cell.getAttribute("data-guide") === "gap")!;
  fireEvent.click(within(gapCell).getByRole("button", { name: "更多" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "从池里填" }));
  expect(getWorkspaceSnapshot().query).toBe(gap.slot_label_zh); expect(getWorkspaceSnapshot().focusedPane).toBe("pool");
  fireEvent.click(within(gapCell).getByRole("button", { name: "更多" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "忽略" }));
  await waitFor(() => expect(peekUndo()?.label).toBe("忽略缺口"));
  fireEvent.click(screen.getByRole("button", { name: "镜头带更多" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: `恢复缺口：${gap.slot_label_zh}` }));
  await waitFor(() => expect(api.reopenStoryGap).toHaveBeenCalledWith(gap.id));
});

it("rubber selection uses screen rectangles, and minimum zoom overrides the fixed flex basis", async () => {
  const grid = await mount();
  vi.spyOn(grid, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 600, height: 166 } as DOMRect);
  cells().forEach((cell, index) => vi.spyOn(cell, "getBoundingClientRect").mockReturnValue({ left: index * 148 + 12, right: index * 148 + 152, top: 30, bottom: 142, width: 140, height: 112 } as DOMRect));
  fireEvent.pointerDown(grid, { button: 0, clientX: 5, clientY: 150, pointerId: 1 });
  fireEvent.pointerMove(grid, { clientX: 290, clientY: 50, pointerId: 1 });
  expect(screen.getByText("已选 2")).toBeTruthy();
  expect(grid.querySelector(".band-selection-box")).not.toBeNull();
  fireEvent.pointerUp(grid, { pointerId: 1 });
  for (let i = 0; i < 3; i += 1) fireEvent.click(screen.getByRole("button", { name: "缩小镜头带" }));
  expect(cells()[0]!.style.flexBasis).toBe("49px");
  expect(screen.getByRole("region", { name: "镜头带" }).dataset.zoom).toBe("0.35");
});
it("trim previews travel through the monitor seek bridge and [ uses the current frame", async () => {
  clips[0]!.fps_num = 25; clips[0]!.fps_den = 1;
  vi.mocked(api.playerStatus).mockResolvedValue({ phase: "ready", clip_id: clips[0]!.id, pos: 2.56, duration: 27, paused: true } as never);
  const grid = await mount(); fireEvent.click(cells()[0]!);
  await waitFor(() => expect(api.playerStatus).toHaveBeenCalled());
  const heard = vi.fn(); window.addEventListener("tripcut:seek-ratio", heard);
  const handle = within(cells()[0]!).getByRole("button", { name: "调整出点" });
  fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 2 });
  fireEvent.pointerMove(handle, { clientX: 120, pointerId: 2 });
  await waitFor(() => expect(heard).toHaveBeenCalled());
  fireEvent.pointerCancel(handle, { pointerId: 2 });
  window.removeEventListener("tripcut:seek-ratio", heard);
  fireEvent.keyDown(grid, { key: "[" });
  await waitFor(() => expect(api.trimBandSegment).toHaveBeenCalledWith(1, 101, [1000, 3000], [2560, 3000]));
  expect(api.createSelectSegment).not.toHaveBeenCalled();
});

it("echoes a pool selection without leaving previous band cuts selected", async () => {
  await mount(); fireEvent.click(cells()[0]!); fireEvent.click(cells()[1]!, { metaKey: true });
  act(() => { dispatchWorkspace({ type: "focus-pane", pane: "pool" }); dispatchWorkspace({ type: "select-clip", clipId: board.items[2]!.clip_id, ids: [board.items[2]!.clip_id] }); });
  await waitFor(() => expect(document.querySelector('[data-band-key="segment:103"]')?.getAttribute("aria-selected")).toBe("true"));
  expect(screen.getByText("已选 1")).toBeTruthy();
});
