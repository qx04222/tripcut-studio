import { createTestApiMock } from "./testApiMock";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClipListItem, ClipMoment, PlayerStatus } from "../api";

/**
 * R17 车道 playfix(P0):切到下一条素材时,新素材必须从头(或它自己的最精彩处)开始,
 * 不能带着上一条停住的位置。假 mpv 按真机行为建模:`player_open` 是**新实例**——
 * 位置归零、载入即播;`player_status` 只报当前实例;命令只打在当前实例上。
 * 所有 api 调用按发生顺序记进一条日志,断言看的是「B 的 player_open 之后」那一段。
 */

const clipA: ClipListItem = {
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
import { __resetWorkspaceForTests, dispatchWorkspace, getWorkspaceSnapshot } from "./WorkspaceStore";

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
  // rAF 必须异步调度,同步桩会让持续动画递归溢出。
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback =>
    window.setTimeout(() => callback(performance.now()), 16));
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => window.clearTimeout(id));
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

async function renderInPane(): Promise<HTMLElement> {
  render(
    <div data-pane="monitor" role="region" aria-label="预览监视器" tabIndex={-1}>
      <Monitor />
    </div>,
  );
  await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalledWith(9));
  await flush();
  await flush();
  return screen.getByRole("region", { name: "预览监视器" });
}

/** B 的 player_open 之后发出的全部命令(按顺序)。 */
function commandsAfterOpen(clipId: number): Array<{ type: string; seconds?: number; speed?: number }> {
  const at = log.findIndex((entry) => entry.kind === "open" && entry.clipId === clipId);
  expect(at).toBeGreaterThanOrEqual(0);
  return log.slice(at + 1).flatMap((entry) => {
    if (entry.kind !== "cmd") return [];
    const { kind: _kind, ...cmd } = entry;
    return [cmd];
  });
}

/** 让 A 播到 `seconds`:播放中 80 ms 轮询自己会读到;暂停态靠点一下播放/暂停键(命令后补读)。 */
async function letAPlayTo(seconds: number, paused: boolean): Promise<void> {
  // 先把 A 放起来(点卡片 = 预览:就绪先暂停,要用户开播)。
  const region = screen.getByRole("region", { name: "预览监视器" });
  expect(commandsAfterOpen(9)).not.toContainEqual({ type: "pause" });
  await flush();
  await flush();
  region.focus();
  if (live.paused) fireEvent.keyDown(region, { key: " ", code: "Space" });
  await flush();
  await waitFor(() => expect(live.paused).toBe(false));
  live = { ...live, pos: seconds };
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
  if (paused) {
    fireEvent.keyDown(region, { key: " ", code: "Space" });
    await flush();
    await waitFor(() => expect(live.paused).toBe(true));
  }
  await waitFor(() => expect(screen.getByRole("slider", { name: "播放位置" }).getAttribute("aria-valuenow")).toBe(String(seconds)));
}

async function selectB(): Promise<void> {
  await act(async () => {
    dispatchWorkspace({ type: "select-clip", clipId: 10 });
  });
  await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalledWith(10));
  // 等 B 就绪、预览暂停落地、时刻分到齐。
  expect(commandsAfterOpen(10)).not.toContainEqual({ type: "pause" });
  await flush();
  await flush();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

describe("R17 playfix:换素材从头开始", () => {
  it("关掉「从最精彩处」:A 播到 12.3 s 再暂停,切 B → B 的 player_open 之后没有 seek_abs,进度条在 0", async () => {
    apiMocks.getSettings.mockResolvedValue({ "ui.player.start_at_best": "false" });
    await renderInPane();
    await letAPlayTo(12.3, true);
    await selectB();
    const seeks = commandsAfterOpen(10).filter((cmd) => cmd.type === "seek_abs");
    expect(seeks).toEqual([]);
    expect(live.clip_id).toBe(10);
    expect(live.pos).toBe(0);
    expect(screen.getByRole("slider", { name: "播放位置" }).getAttribute("aria-valuenow")).toBe("0");
  });

  it("关掉「从最精彩处」:A 正在播(12.3 s 未暂停)时切 B → 同样没有 seek_abs", async () => {
    apiMocks.getSettings.mockResolvedValue({ "ui.player.start_at_best": "false" });
    await renderInPane();
    await letAPlayTo(12.3, false);
    await selectB();
    expect(commandsAfterOpen(10).filter((cmd) => cmd.type === "seek_abs")).toEqual([]);
    expect(live.pos).toBe(0);
  });

  it("开着「从最精彩处」(默认):切 B 仍从零自动播放,不继承建议或旧位置", async () => {
    await renderInPane();
    expect(commandsAfterOpen(9)).not.toContainEqual({ type: "seek_abs", seconds: 20 });
    await letAPlayTo(12.3, true);
    await selectB();
    const seeks = commandsAfterOpen(10).filter((cmd) => cmd.type === "seek_abs");
    expect(seeks).toEqual([]);
    expect(live.pos).toBe(0);
  });

  it("「连播」开着:A 播完自动接力到 B,B 也从零自动播放且无 seek", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMocks.getSettings.mockResolvedValue({ "ui.player.auto_advance": "true" });
    await renderInPane();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    await letAPlayTo(30, false);
    live = { ...live, pos: 59.95, paused: true };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    // 播到尾后轮询停表,靠一次状态读把片尾带回来:点播放键会「从头放」,所以改用轮询的最后一拍——
    // 这里直接再推进定时器让 80 ms 轮询在 paused=false 时读到片尾。
    live = { ...live, paused: false };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    live = { ...live, paused: true };
    await waitFor(() => expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 10 }));
    await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalledWith(10));
    expect(commandsAfterOpen(10)).not.toContainEqual({ type: "pause" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const seeks = commandsAfterOpen(10).filter((cmd) => cmd.type === "seek_abs");
    expect(seeks).toEqual([]);
    expect(live.pos).toBe(0);
  });
});

describe("R17 playfix:同一条素材再次 player_open(全屏来回)也从零自动播放", () => {
  it("A 播放中进全屏再退出:嵌入态重新 player_open(新实例从 0 开始、载入即播),就绪后保持从零自动播放", async () => {
    await renderInPane();
    await letAPlayTo(12.3, false);
    const opensBefore = apiMocks.playerOpen.mock.calls.length;
    await act(async () => {
      dispatchWorkspace({ type: "set-immersive", immersive: true });
    });
    await waitFor(() => expect(apiMocks.playerOpen.mock.calls.length).toBe(opensBefore + 1));
    await flush();
    await act(async () => {
      dispatchWorkspace({ type: "set-immersive", immersive: false });
    });
    await waitFor(() => expect(apiMocks.playerOpen.mock.calls.length).toBe(opensBefore + 2));
    const at = log.map((entry, index) => (entry.kind === "open" ? index : -1)).filter((index) => index >= 0).at(-1)!;
    await waitFor(() => {
      const after = log.slice(at + 1).flatMap((entry) => (entry.kind === "cmd" ? [entry.type] : []));
      expect(after).not.toContain("pause");
    });
    await waitFor(() => {
      const after = log.slice(at + 1).flatMap((entry) => (entry.kind === "cmd" ? [entry] : []));
      expect(after).not.toContainEqual(expect.objectContaining({ type: "seek_abs", seconds: 20 }));
    });
    expect(live.paused).toBe(false);
    expect(live.pos).toBe(0);
  });
});

it('002: ten actual Monitor opens alternate long/short clips and suggestions; every first ready is playing at zero', async () => {
  // 本用例检查首份回读,固定显示时钟;帧间推进由 R27 专用测试覆盖。
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  const clips = Array.from({ length: 10 }, (_, i) => ({ ...clipA, id: 9+i, duration_ticks: i % 2 ? 8000 : 200000 }));
  const original = JSON.stringify(clips);
  apiMocks.listClips.mockResolvedValue(clips);
  apiMocks.getClipMoments.mockImplementation(async id => id % 2 ? momentsFor(id) : []);
  apiMocks.playerOpen.mockImplementation(async (id: number) => {
    log.push({ kind: 'open', clipId: id });
    live = { ...closedStatus(), phase: 'ready', clip_id: id, duration: id % 2 ? 200 : 8, pos: 0, paused: false };
    return { ...live };
  });
  await renderInPane();
  for (const clip of clips) {
    await act(async () => dispatchWorkspace({ type: 'select-clip', clipId: clip.id }));
    await waitFor(() => expect(live.clip_id).toBe(clip.id));
    await flush();
    expect(live).toMatchObject({ pos: 0, paused: false });
    expect(commandsAfterOpen(clip.id).filter(c => ['pause', 'seek_abs', 'set_end'].includes(c.type))).toEqual([]);
    expect(screen.getByRole('button', { name: '暂停' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: '播放位置' }).getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByLabelText('当前时间码').getAttribute('title')).toBe('00:00:00.000');
  }
  expect(apiMocks.playerOpen).toHaveBeenCalledTimes(10);
  expect(apiMocks.createSelectSegment).not.toHaveBeenCalled();
  expect(JSON.stringify(clips)).toBe(original);
});
