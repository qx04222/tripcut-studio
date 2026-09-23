import { createTestApiMock } from "./testApiMock";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { photoFixture } from "./photoTestFixtures";
import type { ClipListItem, ClipMoment, PlayerStatus } from "../api";

/**
 * R17 车道 playfix(P0):切到下一条素材时,新素材必须从头(或它自己的最精彩处)开始,
 * 不能带着上一条停住的位置。假 mpv 按真机行为建模:`player_open` 是**新实例**——
 * 位置归零、载入即播;`player_status` 只报当前实例;命令只打在当前实例上。
 * 所有 api 调用按发生顺序记进一条日志,断言看的是「B 的 player_open 之后」那一段。
 */

const clipA: ClipListItem = {
  kind: "video",
  id: 9,
  episode_id: 1,
  folder_label: null,
  cover_url: "/covers/9.jpg",
  path: "/Volumes/CARD/clip-9.mov",
  file_name: "clip-9.mov",
  byte_size: 2_048,
  quick_hash: "quick-9",
  full_hash: null,
  tb_num: 1,
  tb_den: 1_000,
  duration_ticks: 60_000,
  fps_num: 25,
  fps_den: 1,
  is_vfr: false,
  codec: "h264",
  width: 1_920,
  height: 1_080,
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
};
const clipB: ClipListItem = { ...clipA, id: 10, file_name: "clip-10.mov", duration_ticks: 30_000 };
const DURATIONS: Record<number, number> = { 9: 60, 10: 30 };

function moment(clipId: number, index: number, score: number): ClipMoment {
  return {
    clip_id: clipId,
    win_index: index,
    t_start_ticks: index * 500,
    t_end_ticks: (index + 1) * 500,
    sharp: score,
    motion: 0.3,
    exposure_ok: true,
    loud: false,
    speech: false,
    scene_cut: false,
    score,
    reasons: [],
  };
}
/** A 的最高分在第 40 格(20 s);B 的最高分在第 10 格(5 s)。 */
const momentsFor = (clipId: number): ClipMoment[] => {
  const best = clipId === 9 ? 40 : 10;
  const count = clipId === 9 ? 120 : 60;
  return Array.from({ length: count }, (_, index) => moment(clipId, index, index === best ? 0.95 : 0.2));
};

const apiMocks = vi.hoisted(() => ({
  listClips: vi.fn(),
  getClipArtifacts: vi.fn(async () => ({ preview: null })),
  listStoryGaps: vi.fn(),
  listSelectSegments: vi.fn(),
  createSelectSegment: vi.fn(),
  playerOpen: vi.fn(),
  playerClose: vi.fn(),
  playerCommand: vi.fn(),
  playerStatus: vi.fn(),
  playerSetViewport: vi.fn(),
  playerSetOccluded: vi.fn(),
  setSetting: vi.fn(),
  getSettings: vi.fn(),
  getClipMoments: vi.fn(),
  suggestSegments: vi.fn(),
}));
vi.mock("../api", async () => ({ ...(await createTestApiMock()), ...apiMocks }));

import { Monitor } from "./Monitor";
import { __resetPlayerPrefsForTests } from "./playerPrefs";
import { __resetPoolOrderForTests, setPoolOrder } from "./poolOrder";
import { __resetWorkspaceForTests, dispatchWorkspace } from "./WorkspaceStore";

type LogEntry = { kind: "open"; clipId: number } | { kind: "cmd"; type: string; seconds?: number; speed?: number };

/** 假 mpv:一个实例的全部状态。 */
let live: PlayerStatus;
let log: LogEntry[];

function closedStatus(): PlayerStatus {
  return {
    phase: "closed",
    clip_id: null,
    pos: 0,
    duration: 0,
    paused: true,
    frame: null,
    error: null,
    seek_samples: 0,
    seek_p50_ms: null,
    seek_p95_ms: null,
    last_seek_ms: null,
  };
}

beforeEach(() => {
  __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 }, focusedPane: "monitor" });
  __resetPlayerPrefsForTests();
  __resetPoolOrderForTests();
  setPoolOrder([9, 10]);
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  };
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  live = closedStatus();
  log = [];
  apiMocks.listClips.mockResolvedValue([clipA, clipB]);
  apiMocks.listStoryGaps.mockResolvedValue([]);
  apiMocks.listSelectSegments.mockResolvedValue([]);
  // 真机:`PlayerManager::open` 停掉旧实例、起新实例 —— 状态从 loading(clip_id, pos 0) 开始,
  // loadfile 之后 pause=false(载入即播),FileLoaded 才翻 ready。这里把 ready 合到下一次读状态。
  apiMocks.playerOpen.mockImplementation(async (clipId: number) => {
    log.push({ kind: "open", clipId });
    live = { ...closedStatus(), phase: "loading", clip_id: clipId, duration: DURATIONS[clipId] ?? 0, paused: false };
    const initial = { ...live };
    live = { ...live, phase: "ready" };
    return initial;
  });
  apiMocks.playerStatus.mockImplementation(async () => ({ ...live }));
  apiMocks.playerCommand.mockImplementation(async (cmd: { type: string; seconds?: number; speed?: number }) => {
    log.push({ kind: "cmd", type: cmd.type, ...(cmd.seconds !== undefined ? { seconds: cmd.seconds } : {}), ...(cmd.speed !== undefined ? { speed: cmd.speed } : {}) });
    if (live.phase !== "ready") return;
    if (cmd.type === "seek_abs") live = { ...live, pos: Math.min(live.duration, Math.max(0, cmd.seconds ?? 0)) };
    if (cmd.type === "play") live = { ...live, paused: false };
    if (cmd.type === "pause") live = { ...live, paused: true };
  });
  apiMocks.playerClose.mockImplementation(async () => {
    live = closedStatus();
  });
  apiMocks.playerSetViewport.mockResolvedValue(undefined);
  apiMocks.playerSetOccluded.mockResolvedValue(undefined);
  apiMocks.setSetting.mockResolvedValue(undefined);
  apiMocks.getSettings.mockResolvedValue({});
  apiMocks.getClipMoments.mockImplementation(async (clipId: number) => momentsFor(clipId));
  apiMocks.suggestSegments.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

it("R21 monitor:照片工作台拒绝渲染误入选择状态的视频", async () => {
  apiMocks.listClips.mockResolvedValue([clipA]);
  dispatchWorkspace({ type: "set-workspace-mode", mode: "photo" });
  dispatchWorkspace({ type: "select-clip", clipId: clipA.id! });
  render(<div data-pane="monitor" role="region" aria-label="预览监视器" tabIndex={-1}><Monitor /></div>);
  await waitFor(() => expect(apiMocks.listClips).toHaveBeenCalled());
  expect(apiMocks.playerOpen).not.toHaveBeenCalled();
  expect(screen.queryByText(clipA.file_name)).toBeNull();
});


it("R21 monitor: video/photo workspaces stay isolated while photo preview never opens/seeks/plays mpv", async () => {
  const photo = { ...photoFixture, id: 20 };
  apiMocks.listClips.mockResolvedValue([clipA, photo, clipB]);
  setPoolOrder([9, 20, 10]);
  render(<div data-pane="monitor" role="region" aria-label="预览监视器" tabIndex={-1}><Monitor /></div>);
  await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalledWith(9), { timeout: 5000 });
  await flush();
  await flush();
  // R25 TC-0115-002(迁移):原断言「open → pause → seek_abs 20(最精彩处)」→ 从 0 自动播放,无 pause / seek。
  await waitFor(() => expect(live.phase).toBe("ready"), { timeout: 5000 });
  await flush();
  expect(log.filter(entry => entry.kind === "open" || entry.type === "pause" || entry.type === "seek_abs")).toEqual([{ kind: "open", clipId: 9 }]);
  expect(live.paused).toBe(false);
  await act(async () => {
    dispatchWorkspace({ type: "set-workspace-mode", mode: "photo" });
    dispatchWorkspace({ type: "select-clip", clipId: 20 });
  });
  const img = await screen.findByRole("img", { name: "照片预览 portrait.jpg" });
  expect(img.getAttribute("src")).toBe(photo.photo?.preview_url);
  expect(img.getAttribute("crossorigin")).toBe("anonymous");
  const before = [...log];
  for (const name of ["播放", "入点", "出点"]) expect(screen.queryByRole("button", { name })).toBeNull();
  const pane = screen.getByRole("region", { name: "预览监视器" });
  pane.focus();
  for (const key of ["i", "o", "j", "k", "l", " ", "s", "ArrowRight"]) fireEvent.keyDown(pane, { key });
  window.dispatchEvent(new CustomEvent("tripcut:toggle-playback"));
  window.dispatchEvent(new CustomEvent("tripcut:seek-ratio", { detail: { ratio: 0.5 } }));
  await flush();
  expect(log).toEqual(before);
  expect(apiMocks.getClipMoments).not.toHaveBeenCalledWith(20);
  expect(apiMocks.suggestSegments).not.toHaveBeenCalledWith(20);
  expect(screen.queryByRole("slider", { name: "播放位置" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "100%" }));
  expect(screen.getByRole("button", { name: "100%" }).getAttribute("aria-pressed")).toBe("true");
  await act(async () => {
    dispatchWorkspace({ type: "set-workspace-mode", mode: "video" });
    dispatchWorkspace({ type: "select-clip", clipId: 10 });
  });
  await waitFor(() => expect(log.slice(before.length)).toContainEqual({ kind: "open", clipId: 10 }));
  await flush();
  expect(log.slice(before.length).filter(entry => entry.kind === "open" || entry.type === "pause" || entry.type === "seek_abs")).toEqual([{ kind: "open", clipId: 10 }]);
  expect(apiMocks.playerOpen.mock.calls.map(([id]) => id)).toEqual([9, 10]);
});
