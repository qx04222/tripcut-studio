// @vitest-environment jsdom
// R22-C 接线债(0.11.3):连播中多选 / 框选 / 拖动段 → 连播停(与「拖进度条停连播」同语义:停连播、素材继续播);
// 拖边修剪的监视器跟随 seek 带 `source: "band-trim"`,不广播 manual-seek(连播因此不被它打断,而是挂起等修剪落地)。
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Storyboard, ClipListItem } from "../../api";
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
import { __resetClipsFeedForTests } from "../useClipsFeed";
import { __resetWorkspaceForTests } from "../WorkspaceStore";
import { __resetToastsForTests } from "../ui/toastStore";
import { __resetUndoForTests } from "../undoStack";
import { PLAYTHROUGH_RELEASE_EVENT } from "../playthrough/store";
let board: Storyboard, clips: ClipListItem[];
beforeEach(() => {
  vi.clearAllMocks(); __resetMockForTests(); __resetClipsFeedForTests(); __resetWorkspaceForTests(); __resetToastsForTests(); __resetUndoForTests();
  const fixture = handleMockCommand("get_storyboard", {}) as Storyboard;
  const first = fixture.items[0]!;
  board = { ...fixture, mode: "legacy", narrative: null, chapters: fixture.chapters.slice(0, 2), candidates: [], items: [
    { ...first, key: "segment:101", item_kind: "segment", segment_id: 101, in_ticks: 1000, out_ticks: 3000, position: 0 },
    { ...first, key: "segment:102", item_kind: "segment", segment_id: 102, in_ticks: 4000, out_ticks: 6000, position: 1 },
    { ...fixture.items[1]!, key: "segment:103", item_kind: "segment", segment_id: 103, chapter_id: fixture.chapters[1]!.id, position: 2 },
  ] };
  clips = handleMockCommand("list_clips", {}) as ClipListItem[];
  vi.mocked(api.getStoryboard).mockImplementation(async () => structuredClone(board));
  vi.mocked(api.listClips).mockImplementation(async () => clips);
  vi.mocked(api.listStoryGaps).mockImplementation(async () => []);
  vi.mocked(api.getCurrentEpisode).mockResolvedValue({ id: clips[0]!.episode_id!, title: "EP01" } as never);
  vi.mocked(api.getSettings).mockImplementation(async () => ({}));
  vi.mocked(api.playerStatus).mockResolvedValue({ phase: "ready", clip_id: first.clip_id, pos: 2, duration: 10, paused: false } as never);
});
afterEach(() => { cleanup(); __resetClipsFeedForTests(); });
async function mount() {
  render(<ShotBand />);
  await screen.findByRole("gridcell", { name: /^镜头 1：/ });
  return screen.getByRole("grid", { name: "镜头序列" });
}
const cells = () => screen.getAllByRole("gridcell").filter(cell => cell.hasAttribute("data-clip-id"));
function listen(name: string) { const fn = vi.fn(); window.addEventListener(name, fn); return { fn, off: () => window.removeEventListener(name, fn) }; }

it("框选一拉开就发连播释放事件;只点一下空白不发", async () => {
  const grid = await mount();
  vi.spyOn(grid, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 600, height: 166 } as DOMRect);
  cells().forEach((cell, index) => vi.spyOn(cell, "getBoundingClientRect").mockReturnValue({ left: index * 148 + 12, right: index * 148 + 152, top: 30, bottom: 142, width: 140, height: 112 } as DOMRect));
  const release = listen(PLAYTHROUGH_RELEASE_EVENT);
  fireEvent.pointerDown(grid, { button: 0, clientX: 5, clientY: 150, pointerId: 1 });
  fireEvent.pointerMove(grid, { clientX: 6, clientY: 150, pointerId: 1 });
  expect(release.fn).not.toHaveBeenCalled();
  fireEvent.pointerMove(grid, { clientX: 290, clientY: 50, pointerId: 1 });
  fireEvent.pointerMove(grid, { clientX: 300, clientY: 50, pointerId: 1 });
  expect(release.fn).toHaveBeenCalledTimes(1);
  fireEvent.pointerUp(grid, { pointerId: 1 });
  release.off();
});
it("⇧ / ⌘ 点选与拖动开始都发连播释放事件", async () => {
  await mount();
  const release = listen(PLAYTHROUGH_RELEASE_EVENT);
  fireEvent.click(cells()[0]!);
  expect(release.fn).not.toHaveBeenCalled();
  fireEvent.click(cells()[1]!, { shiftKey: true });
  expect(release.fn).toHaveBeenCalledTimes(1);
  fireEvent.click(cells()[2]!, { metaKey: true });
  expect(release.fn).toHaveBeenCalledTimes(2);
  dnd.current!.onDragStart!({ active: { id: "segment:101" }, activatorEvent: {} });
  expect(release.fn).toHaveBeenCalledTimes(3);
  release.off();
});
it("拖边修剪的跟随 seek 带 band-trim 来源,不广播 manual-seek", async () => {
  clips[0]!.fps_num = 25; clips[0]!.fps_den = 1;
  await mount(); fireEvent.click(cells()[0]!);
  await waitFor(() => expect(api.playerStatus).toHaveBeenCalled());
  const manual = listen("tripcut:manual-seek"); const ratio = listen("tripcut:seek-ratio");
  const handle = within(cells()[0]!).getByRole("button", { name: "调整出点" });
  fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 2 });
  fireEvent.pointerMove(handle, { clientX: 120, pointerId: 2 });
  await waitFor(() => expect(ratio.fn).toHaveBeenCalled());
  expect((ratio.fn.mock.calls[0]![0] as CustomEvent<{ source?: string }>).detail.source).toBe("band-trim");
  expect(manual.fn).not.toHaveBeenCalled();
  fireEvent.pointerCancel(handle, { pointerId: 2 });
  manual.off(); ratio.off();
});
