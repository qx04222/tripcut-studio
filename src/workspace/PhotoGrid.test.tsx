// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClipListItem, SimilarGroup } from "../api";
const api = vi.hoisted(() => ({
  primaryId: 10,
  listSimilarGroups: vi.fn(),
  setSimilarPrimary: vi.fn(),
  rateClip: vi.fn(async () => undefined), clearClipRating: vi.fn(async () => undefined), setShotStackUserState: vi.fn(async () => undefined),
}));
vi.mock("../api", async (original) => ({ ...(await original()), ...api }));
const feedState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("./useClipsFeed", () => ({ useClipsFeed: () => feedState.current, refreshClipsFeed: vi.fn(async () => undefined), patchClipInFeed: vi.fn() }));
import { photoFixture } from "./photoTestFixtures";
import { PhotoGrid } from "./PhotoGrid";
import { buildPhotoGridStressFixtures } from "../devMock/photoFixtures";
import { PhotoMonitor } from "./PhotoMonitor";
import { OPEN_DUEL } from "./duel/duelBus";
import { __resetPoolOrderForTests, getPoolOrder } from "./poolOrder";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

const photos = [
  { ...photoFixture, id: 11, file_name: "similar.jpg" },
  { ...photoFixture, id: 10, file_name: "one.jpg" },
  { ...photoFixture, id: 12, file_name: "two.jpg" },
  { ...photoFixture, id: 13, file_name: "three.jpg" },
  { ...photoFixture, id: 14, file_name: "four.jpg" },
  { ...photoFixture, id: 15, file_name: "five.jpg" },
];
let resizeCallback: ResizeObserverCallback = () => undefined;
const NativeResizeObserver = globalThis.ResizeObserver;
beforeEach(() => {
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const clipsById = new Map(photos.map((clip) => [clip.id!, clip]));
  feedState.current = { clips: photos, clipsById, shotStackByClipId: new Map(), gaps: [], loading: false };
  api.primaryId = 10;
  api.listSimilarGroups.mockImplementation(async () => [{ id: 1, min_similarity: 0.95, members: [{ clip_id: 11, is_primary: api.primaryId === 11 }, { clip_id: 10, is_primary: api.primaryId === 10 }] }]);
  api.setSimilarPrimary.mockImplementation(async (_groupId: number, clipId: number) => { api.primaryId = clipId; });
  __resetPoolOrderForTests(); __resetWorkspaceForTests(); vi.clearAllMocks();
});

it("监视器设为主图后广播组变更并让折叠网格刷新代表与徽标", async () => {
  render(<>
    <PhotoGrid />
    <PhotoMonitor clip={photos[0]!} clips={photos} rootRef={{ current: null }} />
  </>);
  expect(await screen.findByRole("button", { name: "设为主图" })).toBeTruthy();
  expect(document.getElementById("pool-clip-10")).not.toBeNull();
  expect(document.getElementById("pool-clip-11")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "设为主图" }));
  await waitFor(() => expect(api.setSimilarPrimary).toHaveBeenCalledWith(1, 11));
  await waitFor(() => expect(document.getElementById("pool-clip-11")).not.toBeNull());
  expect(document.getElementById("pool-clip-10")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "展开相似组 2 张" }));
  expect(within(screen.getAllByRole("gridcell")[0]!).getByText("主图")).toBeTruthy();
});
afterEach(() => { cleanup(); globalThis.ResizeObserver = NativeResizeObserver; });

function resizeGrid(width: number): void {
  act(() => resizeCallback([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));
}

it("宽网格突破四列上限，缩窄后仍至少保留一列", async () => {
  render(<PhotoGrid />);
  await waitFor(() => expect(getPoolOrder()).toEqual([10, 12, 13, 14, 15]));
  const grid = screen.getByRole("grid", { name: "照片网格" });
  resizeGrid(1600);
  expect(Number(grid.getAttribute("aria-colcount"))).toBeGreaterThan(4);
  resizeGrid(90);
  expect(grid.getAttribute("aria-colcount")).toBe("1");
});

it("照片默认适应，裁切按钮切换状态与网格属性后可切回", async () => {
  render(<PhotoGrid />);
  await waitFor(() => expect(getPoolOrder()).toEqual([10, 12, 13, 14, 15]));
  const button = screen.getByRole("button", { name: "照片适应/裁切" });
  const pane = screen.getByRole("region", { name: "照片网格" });
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(button.textContent).toBe("适应");
  expect(pane.hasAttribute("data-photo-fit")).toBe(false);
  fireEvent.click(button);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.textContent).toBe("裁切");
  expect(pane.getAttribute("data-photo-fit")).toBe("cover");
  fireEvent.click(button);
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(button.textContent).toBe("适应");
  expect(pane.hasAttribute("data-photo-fit")).toBe(false);
});

it("压力夹具覆盖真实预览比例，三张相似组折叠为独立单卡片日期行", async () => {
  const clips = buildPhotoGridStressFixtures(photoFixture);
  expect(clips.map((clip) => clip.id)).toEqual([210, 211, 212, 213, 214, 215, 216, 217, 218]);
  expect(new Set(clips.map((clip) => `${clip.width}x${clip.height}`))).toEqual(new Set([
    "3840x2160", "7680x4320", "5712x4284", "4032x3024", "1080x1920", "2160x2160",
  ]));
  for (const clip of clips) {
    const svg = new DOMParser().parseFromString(decodeURIComponent(clip.cover_url!.split(",")[1]!), "image/svg+xml").documentElement;
    expect(Number(svg.getAttribute("width")) / Number(svg.getAttribute("height"))).toBeCloseTo(clip.width! / clip.height!, 2);
    if (clip.orientation === "portrait") {
      expect(clip.photo).toMatchObject({ width: 1920, height: 1080, orientation: 6 });
    }
  }
  feedState.current = { clips, clipsById: new Map(clips.map((clip) => [clip.id!, clip])), shotStackByClipId: new Map(), gaps: [], loading: false };
  api.listSimilarGroups.mockResolvedValueOnce([{ id: 9025, min_similarity: 0.97, members: clips.slice(0, 3).map((clip, index) => ({ clip_id: clip.id!, is_primary: index === 0 })) }]);
  render(<PhotoGrid />);
  const expand = await screen.findByRole("button", { name: "展开相似组 3 张" });
  resizeGrid(650);
  expect(screen.getAllByRole("gridcell")).toHaveLength(7);
  const dateGroup = screen.getAllByRole("rowgroup")[0]!;
  expect(within(dateGroup).getAllByRole("row")).toHaveLength(1);
  expect(within(dateGroup).getAllByRole("gridcell")).toHaveLength(1);
  expect(within(screen.getByRole("rowgroup", { name: "时间未知" })).getAllByRole("gridcell")).toHaveLength(1);
  fireEvent.click(expand);
  expect(screen.getAllByRole("gridcell")).toHaveLength(9);
});

it("折叠相似组后把可见代表顺序交给照片监视器，且 AX 不嵌套 gridcell", async () => {
  render(<PhotoGrid />);
  await waitFor(() => expect(getPoolOrder()).toEqual([10, 12, 13, 14, 15]));
  const cells = screen.getAllByRole("gridcell");
  expect(cells).toHaveLength(5);
  for (const cell of cells) expect(cell.querySelector("[role='gridcell']")).toBeNull();
  const grid = screen.getByRole("grid", { name: "照片网格" });
  for (const rowgroup of Array.from(grid.children)) {
    expect(rowgroup.getAttribute("role")).toBe("rowgroup");
    for (const row of Array.from(rowgroup.children).filter((node) => node.getAttribute("role") !== "presentation")) {
      expect(row.getAttribute("role")).toBe("row");
      expect(Array.from(row.children).every((node) => node.getAttribute("role") === "gridcell")).toBe(true);
    }
  }
  expect(screen.getByRole("button", { name: "擂台" }).closest("[role='gridcell']")).not.toBeNull();
  expect(readFileSync("src/styles/workspace/photo-ws-r21.css", "utf8")).not.toMatch(/\.photo-ws-grid-item-row\s*\{[^}]*display:\s*contents/);
});

it("可访问入口展开六张相似照片，主图第一且疑似废片排在组末", async () => {
  const junk = { ...photos[4]!, analysis: { clip_id: 14, exposure_yavg: 10, overexposed_ratio: 0, audio_peak_db: null, audio_clipped: false, has_audio: false, focus_scores: [], scene_count: 0, analyzed_at: "now", tool_versions: {}, underexposed_ratio: 0, dynamic_range: 0, blur_mean: 0, entropy_mean: 0, motion_mean: 0, out_of_focus_ratio: 0.4 } };
  const six = [photos[0]!, photos[1]!, photos[2]!, photos[3]!, junk, photos[5]!];
  feedState.current = { clips: six, clipsById: new Map(six.map((clip) => [clip.id!, clip])), shotStackByClipId: new Map(), gaps: [], loading: false };
  api.listSimilarGroups.mockResolvedValueOnce([{ id: 9, min_similarity: 0.96, members: six.map((clip) => ({ clip_id: clip.id!, is_primary: clip.id === 10 })) }]);
  render(<PhotoGrid />);
  const expand = await screen.findByRole("button", { name: "展开相似组 6 张" });
  expect(screen.getAllByRole("gridcell")).toHaveLength(1);
  fireEvent.click(expand);
  await waitFor(() => expect(screen.getAllByRole("gridcell")).toHaveLength(6));
  expect(screen.getAllByRole("gridcell").map((cell) => cell.querySelector(".pool-card")?.id)).toEqual([
    "pool-clip-10", "pool-clip-11", "pool-clip-12", "pool-clip-13", "pool-clip-15", "pool-clip-14",
  ]);
  expect(within(screen.getAllByRole("gridcell")[0]!).getByText("主图")).toBeTruthy();
  expect(within(screen.getAllByRole("gridcell").at(-1)!).getByText("疑似废片")).toBeTruthy();
});

it("相似组擂台过滤明确 X，并在不足两张时给出可操作提示", async () => {
  const rejected = { ...photos[0]!, binary_rating: -1 as const };
  const candidates = [photos[1]!, rejected, photos[2]!];
  feedState.current = { clips: candidates, clipsById: new Map(candidates.map((clip) => [clip.id!, clip])), shotStackByClipId: new Map(), gaps: [], loading: false };
  api.listSimilarGroups.mockResolvedValueOnce([{ id: 9, min_similarity: 0.96, members: candidates.map((clip) => ({ clip_id: clip.id!, is_primary: clip.id === 10 })) }]);
  const opened = vi.fn();
  window.addEventListener(OPEN_DUEL, opened, { once: true });
  render(<PhotoGrid />);
  const duel = await screen.findByRole("button", { name: "擂台" });
  fireEvent.click(duel);
  expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual({ clipIds: [10, 12], source: "similar_group" });
  cleanup();

  const tooFew = [photos[1]!, rejected];
  feedState.current = { clips: tooFew, clipsById: new Map(tooFew.map((clip) => [clip.id!, clip])), shotStackByClipId: new Map(), gaps: [], loading: false };
  api.listSimilarGroups.mockResolvedValueOnce([{ id: 10, min_similarity: 0.96, members: tooFew.map((clip) => ({ clip_id: clip.id!, is_primary: clip.id === 10 })) }]);
  render(<PhotoGrid />);
  const disabled = await screen.findByRole("button", { name: "擂台" });
  expect((disabled as HTMLButtonElement).disabled).toBe(true);
  expect(disabled.getAttribute("title")).toContain("先按 F 保留、清除评级，或换一张");
});

it("收起相似组时把隐藏成员选择切回主图", async () => {
  api.listSimilarGroups.mockResolvedValueOnce([{ id: 9, min_similarity: 0.96, members: photos.map((clip) => ({ clip_id: clip.id!, is_primary: clip.id === 10 })) }]);
  render(<PhotoGrid />);
  fireEvent.click(await screen.findByRole("button", { name: "展开相似组 6 张" }));
  fireEvent.click(document.getElementById("pool-clip-11")!);
  const { getWorkspaceSnapshot } = await import("./WorkspaceStore");
  expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 11 });
  fireEvent.click(screen.getByRole("button", { name: "收起相似组 6 张" }));
  expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 10 });
  expect(document.getElementById("pool-clip-10")?.closest("[role='gridcell']")?.getAttribute("aria-selected")).toBe("true");
});

it.each([
  [2, 320, 13],
  [3, 490, 14],
  [4, 650, 15],
])("%i 列时 AX 行列索引与向下导航使用同一列数", async (columns, width, expectedId) => {
  render(<PhotoGrid />);
  await waitFor(() => expect(getPoolOrder()).toEqual([10, 12, 13, 14, 15]));
  resizeGrid(width);
  const grid = screen.getByRole("grid", { name: "照片网格" });
  await waitFor(() => expect(grid.getAttribute("aria-colcount")).toBe(String(columns)));
  expect(grid.getAttribute("aria-rowcount")).toBe(String(Math.ceil(5 / columns)));
  const rows = screen.getAllByRole("row");
  expect(rows).toHaveLength(Math.ceil(5 / columns));
  rows.forEach((row, rowIndex) => {
    expect(row.getAttribute("aria-rowindex")).toBe(String(rowIndex + 1));
    within(row).getAllByRole("gridcell").forEach((cell, columnIndex) => {
      expect(cell.getAttribute("aria-colindex")).toBe(String(columnIndex + 1));
    });
  });
  grid.focus();
  fireEvent.keyDown(grid, { key: "Enter", code: "Enter" });
  fireEvent.keyDown(document.getElementById("pool-clip-10")!, { key: "ArrowDown", code: "ArrowDown" });
  const { getWorkspaceSnapshot } = await import("./WorkspaceStore");
  expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: expectedId });
});

it("四列跨日期组向下时按下一真实行的同列导航", async () => {
  const grouped = [
    ...[20, 21, 22].map((id) => ({ ...photoFixture, id, file_name: `${id}.jpg`, photo: { ...photoFixture.photo!, taken_at: "2026-09-18T13:00:00Z", taken_at_local: "2026-09-18T13:00:00+00:00", tz_guess: "UTC+00:00" } })),
    ...[23, 24, 25, 26].map((id) => ({ ...photoFixture, id, file_name: `${id}.jpg`, photo: { ...photoFixture.photo!, taken_at: "2026-09-19T13:00:00Z", taken_at_local: "2026-09-19T13:00:00+00:00", tz_guess: "UTC+00:00" } })),
  ];
  feedState.current = { clips: grouped, clipsById: new Map(grouped.map((clip) => [clip.id, clip])), shotStackByClipId: new Map(), gaps: [], loading: false };
  render(<PhotoGrid />);
  await waitFor(() => expect(getPoolOrder()).toEqual([20, 21, 22, 23, 24, 25, 26]));
  resizeGrid(650);
  await waitFor(() => expect(screen.getByRole("grid", { name: "照片网格" }).getAttribute("aria-colcount")).toBe("4"));
  fireEvent.click(document.getElementById("pool-clip-21")!);
  fireEvent.keyDown(document.getElementById("pool-clip-21")!, { key: "ArrowDown", code: "ArrowDown" });
  const { getWorkspaceSnapshot } = await import("./WorkspaceStore");
  expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 24 });
});

it.each(["ArrowRight", "Enter", " "])("无锚点时 %s 从网格进入首张；随后方向导航和评级键有效", async (key) => {
  render(<PhotoGrid />);
  await screen.findByRole("button", { name: "擂台" });
  const grid = screen.getByRole("grid", { name: "照片网格" });
  expect(grid.getAttribute("data-pane")).toBe("pool");
  grid.focus();
  fireEvent.keyDown(grid, { key, code: key === " " ? "Space" : key });
  const { getWorkspaceSnapshot } = await import("./WorkspaceStore");
  expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 10 });
  fireEvent.keyDown(document.getElementById("pool-clip-10")!, { key: "ArrowRight", code: "ArrowRight" });
  expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 12 });
  fireEvent.keyDown(document.getElementById("pool-clip-12")!, { key: "x", code: "KeyX" });
  await waitFor(() => expect(api.rateClip).toHaveBeenCalledWith(12, "binary", -1));
  fireEvent.keyDown(document.getElementById("pool-clip-12")!, { key: "4", code: "Digit4" });
  await waitFor(() => expect(api.rateClip).toHaveBeenCalledWith(12, "star", 4));
});

it("历史集只读时仍可方向与确认键浏览，但禁用擂台与评级写入", async () => {
  __resetWorkspaceForTests({ viewingEpisode: { id: 7, title: "历史集" } });
  render(<PhotoGrid />);
  const duel = await screen.findByRole("button", { name: "擂台" });
  expect((duel as HTMLButtonElement).disabled).toBe(true);
  const grid = screen.getByRole("grid", { name: "照片网格" });
  grid.focus();
  fireEvent.keyDown(grid, { key: " ", code: "Space" });
  const { getWorkspaceSnapshot } = await import("./WorkspaceStore");
  expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 10 });
  fireEvent.keyDown(document.getElementById("pool-clip-10")!, { key: "ArrowRight", code: "ArrowRight" });
  expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 12 });
  act(() => fireEvent.keyDown(document.getElementById("pool-clip-12")!, { key: "x", code: "KeyX" }));
  act(() => fireEvent.keyDown(document.getElementById("pool-clip-12")!, { key: "4", code: "Digit4" }));
  expect(api.rateClip).not.toHaveBeenCalled();
  expect(api.clearClipRating).not.toHaveBeenCalled();
});

it.each([
  ["", 0, false],
  ["?photostress=1", 9, true],
  ["?photos=1", 7, false],
  ["?photos=1&photostress=1", 16, true],
] as const)("mock 路由 %s 只在显式启用时追加压力照片与相似组", async (search, count, stress) => {
  vi.resetModules();
  vi.stubGlobal("location", { search });
  try {
    const { handleMockCommand, PHOTO_CLIPS_R21, PHOTO_RAW_CLIP_R21 } = await import("../devMock/fixture");
    const clips = handleMockCommand("list_clips", {}) as ClipListItem[];
    const groups = handleMockCommand("list_similar_groups", {}) as SimilarGroup[];
    expect(clips.filter((clip) => clip.kind === "photo")).toHaveLength(count);
    expect(clips.filter((clip) => clip.id! >= 210 && clip.id! <= 218)).toHaveLength(stress ? 9 : 0);
    expect(groups.find((group) => group.id === 9025)?.members.map((member) => member.clip_id)).toEqual(stress ? [210, 211, 212] : undefined);
    expect(PHOTO_CLIPS_R21.map((clip) => clip.id)).toEqual([201, 202, 203, 204, 205, 206]);
    expect(PHOTO_RAW_CLIP_R21.id).toBe(207);
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});
