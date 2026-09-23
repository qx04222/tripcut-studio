import { createTestApiMock } from "../testApiMock";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClipListItem, ClipMoment, PlayerStatus } from "../../api";

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
vi.mock("../../api", async () => ({ ...(await createTestApiMock()), ...apiMocks }));

import { Monitor } from "../Monitor";
import { __resetPlayerPrefsForTests } from "../playerPrefs";
import { __resetPoolOrderForTests, setPoolOrder } from "../poolOrder";
import { __resetWorkspaceForTests, dispatchWorkspace, getWorkspaceSnapshot } from "../WorkspaceStore";

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
  apiMocks.playerOpen.mockImplementation(async (clipId: number, startPaused = false, startSeconds?: number) => {
    log.push({ kind: "open", clipId });
    live = { ...closedStatus(), phase: "loading", clip_id: clipId, duration: DURATIONS[clipId] ?? 0, pos: startSeconds ?? 0, paused: startPaused || startSeconds !== undefined };
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
  setPlaythroughSegments([]);
  vi.clearAllMocks();
  vi.restoreAllMocks();
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


import { requestPlaythrough, setPlaythroughSegments } from './store';
const sequence = [
  { key: 'a', clipId: 9, inPoint: 2, outPoint: 4, fps: 25, chapter: '1' },
  { key: 'b', clipId: 10, inPoint: 6, outPoint: 9, fps: 25, chapter: '2' },
];
describe('R22 完整 Monitor → Transport → PlayerOverlay 通道', () => {
  it('有最精彩处偏好时仍从段入点播,跨 clip 的 pause/open/seek/play 有序,末段停住', async () => {
    apiMocks.getSettings.mockResolvedValue({ 'ui.player.auto_advance': 'true' });
    await renderInPane();
    await act(async () => { setPlaythroughSegments(sequence); });
    await act(async () => requestPlaythrough());
    await waitFor(() => expect(live.pos).toBe(2));
    await waitFor(() => expect(live.paused).toBe(false));
    expect(getWorkspaceSnapshot().inspectorDismissed).toBe(true);
    const start = log.length;
    live = { ...live, pos: 3.96 };
    await waitFor(() => expect(live.clip_id).toBe(10));
    await waitFor(() => expect(live.pos).toBe(6));
    await waitFor(() => expect(live.paused).toBe(false));
    const transition = log.slice(start);
    expect(transition[0]).toMatchObject({ kind: 'cmd', type: 'pause' });
    expect(transition.findIndex(e => e.kind === 'open')).toBeGreaterThan(0);
    const b = commandsAfterOpen(10);
    expect(b.filter(e => e.type === 'seek_abs')).toEqual([{ type: 'seek_abs', seconds: 6 }]);
    expect(b.findIndex(e => e.type === 'play')).toBeGreaterThan(b.findIndex(e => e.type === 'seek_abs'));
    expect(screen.getByText('连播 · 第 2/2 段 · 章 2')).toBeTruthy();
    live = { ...live, pos: 8.96 };
    await waitFor(() => expect(live.paused).toBe(true));
    await waitFor(() => expect(screen.queryByRole('group', { name: '镜头带连播预览' })).toBeNull());
    expect(live.pos).toBe(8.96);
  });
  it('播放键暂停/继续保持段;人工滑杆 seek 打断且不会再接下一段', async () => {
    apiMocks.getSettings.mockResolvedValue({ 'ui.player.auto_advance': 'true' });
    await renderInPane();
    await act(async () => { setPlaythroughSegments(sequence); });
    await act(async () => requestPlaythrough());
    await waitFor(() => expect(live.pos).toBe(2));
    await waitFor(() => expect(live.paused).toBe(false));
    // 假 mpv 的 paused 翻了,界面还要等下一次状态轮询才把按钮翻成「暂停」——用 findByRole 等它,不抢。
    fireEvent.click(await screen.findByRole('button', { name: '暂停' }));
    await waitFor(() => expect(live.paused).toBe(true));
    expect(screen.getByText('连播 · 第 1/2 段 · 章 1')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '播放' }));
    await waitFor(() => expect(live.paused).toBe(false));
    // 等状态轮询把「在播」带回界面(按钮翻成「暂停」):进度条按它手上的 status 决定松手要不要恢复播放。
    await screen.findByRole('button', { name: '暂停' });
    // R22 接线:连播中进度条画出当前段 2→4 s 的区间与「第 1/2 段」。
    expect(screen.getByText('第 1/2 段')).toBeTruthy();
    const band = document.querySelector<HTMLElement>('.scrubber-r22-track [data-playing]');
    // R23 §8C:刻度范围 == 活动选段,连播带从轨道最左开始铺。
    expect(Number.parseFloat(band!.style.left)).toBeCloseTo(2 / 60 * 100);
    // 用户在自绘轨道上按下 = 人工 seek(pointer 事件,R22-A 的 div[role=slider] 没有 change 事件)→ 连播立即停止。
    vi.stubGlobal('PointerEvent', MouseEvent);
    const slider = screen.getByRole('slider', { name: '播放位置' });
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 600, top: 0, height: 56 } as DOMRect);
    fireEvent.pointerDown(slider, { clientX: 70 });
    fireEvent.pointerUp(slider, { clientX: 70 });
    await waitFor(() => expect(screen.queryByRole('group', { name: '镜头带连播预览' })).toBeNull());
    // R23 §8C:轨道此刻代表活动选段 2→4 s,按在 70/600 处 = 2.2333 s,按 25 fps 量到 2.24
    // (旧值 7 是「按整条素材 0–60 s 算」—— 那个刻度就是 ISSUE-B)。
    await waitFor(() => expect(live.pos).toBe(7));
    expect(screen.queryByText(/第 \d+\/\d+ 段/)).toBeNull();
    expect(document.querySelector('.scrubber-r22-track [data-playing]')).toBeNull();
    expect(live.clip_id).toBe(9);
    // 连播停了,但用户只是拖了一下进度条,素材本身继续播(不留在暂停)。
    await waitFor(() => expect(live.paused).toBe(true));
    live = { ...live, pos: 3.96 };
    await flush(); await flush();
    expect(live.clip_id).toBe(9);
    vi.unstubAllGlobals();
  });
});

it('末段恰在素材末尾,媒体池连播开着也不能越过镜头带终点', async () => {
  apiMocks.getSettings.mockResolvedValue({ 'ui.player.auto_advance': 'true' });
  await renderInPane();
  await act(async () => { setPlaythroughSegments([{ ...sequence[0]!, outPoint: 60 }]); });
  await act(async () => requestPlaythrough());
  await waitFor(() => expect(live.pos).toBe(2));
  await waitFor(() => expect(live.paused).toBe(false));
  live = { ...live, pos: 59.96 };
  await waitFor(() => expect(screen.queryByRole('group', { name: '镜头带连播预览' })).toBeNull());
  await waitFor(() => expect(live.paused).toBe(true));
  expect(live.clip_id).toBe(9);
  expect(live.pos).toBe(59.96);
  expect(apiMocks.playerOpen).not.toHaveBeenCalledWith(10);
  expect(apiMocks.setSetting.mock.calls.some(([key]) => key === 'ui.player.auto_advance')).toBe(false);
});

it('暂停中选择播放速度继续本段,仍在出点自动接下一段', async () => {
  apiMocks.getSettings.mockResolvedValue({ 'ui.player.auto_advance': 'true' });
  await renderInPane();
  await act(async () => { setPlaythroughSegments(sequence); });
  await act(async () => requestPlaythrough());
  await waitFor(() => expect(live.pos).toBe(2));
  fireEvent.click(await screen.findByRole('button', { name: '暂停' }));
  await screen.findByRole('button', { name: '播放' });
  fireEvent.click(screen.getByRole('button', { name: '播放速度' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '速度 ×2' }));
  await waitFor(() => expect(live.paused).toBe(false));
  live = { ...live, pos: 3.96 };
  await waitFor(() => expect(live.clip_id).toBe(10));
});

it('001/002: selected shot with autoAdvance off fences, replays at in, then pool selection opens zero playing without fence', async () => {
  const { requestSegmentSelection, getActiveSelection } = await import('./selection');
  await renderInPane();
  await act(async () => { setPlaythroughSegments(sequence); requestSegmentSelection(sequence[0]!, 3, true); });
  await waitFor(() => expect(live).toMatchObject({ pos: 3, paused: false }));
  expect(getActiveSelection()?.key).toBe('a');
  expect(screen.getByText('选段 · 第 1/2 段 · 章 1')).toBeTruthy();
  expect(screen.getByTitle('选段:当前段')).toBeTruthy();
  expect(screen.getByRole('progressbar', { name: '镜头带总进度' }).getAttribute('aria-valuetext')).toBe('选段 第 1/2 段');
  expect(commandsAfterOpen(9)).toContainEqual({ type: 'set_end', seconds: 4 });
  expect(screen.getByRole('switch', { name: '连播' }).getAttribute('aria-checked')).toBe('false');
  live = { ...live, pos: 3.96 };
  await waitFor(() => expect(live.paused).toBe(true));
  expect(live.clip_id).toBe(9);
  expect(apiMocks.playerOpen).not.toHaveBeenCalledWith(10, true, 6);
  expect(document.querySelector('[data-playing]')).toBeTruthy();
  fireEvent.click(await screen.findByRole('button', { name: '播放' }));
  await waitFor(() => expect(live).toMatchObject({ pos: 2, paused: false }));
  await act(async () => dispatchWorkspace({ type: 'select-clip', clipId: 10 }));
  await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalledWith(10));
  // This fixture's open returns loading and becomes ready on the next status read.
  await screen.findByRole('button', { name: '暂停' });
  expect(live).toMatchObject({ pos: 0, paused: false });
  expect(getActiveSelection()).toBeNull();
  expect(commandsAfterOpen(10).filter(c => ['pause', 'seek_abs', 'set_end'].includes(c.type))).toEqual([]);
});

it('001: Inspector replay uses the same active selection and fence as the monitor', async () => {
  const { SelectSegmentsSection } = await import('../InspectorSegments');
  const { getActiveSelection } = await import('./selection');
  apiMocks.listSelectSegments.mockResolvedValue([{ id: 77, clip_id: 9, in_ticks: 38500, out_ticks: 46500, tb_num: 1, tb_den: 1000 }]);
  await renderInPane();
  live = { ...live, duration: 200 };
  render(<SelectSegmentsSection clipId={9} selectCount={1} readOnly={false} fps={50} />);
  fireEvent.click(await screen.findByRole('button', { name: '复播精选段 1' }));
  await waitFor(() => expect(live).toMatchObject({ pos: 38.5, paused: false }));
  expect(getActiveSelection()).toMatchObject({ inPoint: 38.5, outPoint: 46.5, fps: 50 });
  expect(screen.getByText('选段 · 章')).toBeTruthy();
  expect(screen.getByTitle('选段:当前段')).toBeTruthy();
  expect(screen.getByRole('progressbar', { name: '镜头带总进度' }).getAttribute('aria-valuetext')).toBe('选段');
  const commands = commandsAfterOpen(9);
  const play = commands.map(c => c.type).lastIndexOf('play');
  expect(commands.slice(0, play)).toContainEqual({ type: 'set_end', seconds: 46.5 });
  live = { ...live, pos: 46.48 };
  await waitFor(() => expect(live.paused).toBe(true));
  expect(live.pos).toBeCloseTo(46.48);
});

it('002: fullscreen recreation after segment preview returns to material zero autoplay', async () => {
  const { requestSegmentSelection, getActiveSelection } = await import('./selection');
  await renderInPane();
  await act(async () => requestSegmentSelection(sequence[0]!, 3, true));
  await waitFor(() => expect(live).toMatchObject({ pos: 3, paused: false }));
  const opensBeforeFullscreen = apiMocks.playerOpen.mock.calls.length;
  await act(async () => dispatchWorkspace({ type: 'set-immersive', immersive: true }));
  await waitFor(() => expect(apiMocks.playerOpen.mock.calls.length).toBe(opensBeforeFullscreen + 1));
  await flush();
  expect(live).toMatchObject({ pos: 0, paused: false });
  expect(getActiveSelection()).toBeNull();
  await act(async () => dispatchWorkspace({ type: 'set-immersive', immersive: false }));
  await screen.findByRole('button', { name: '暂停' });
  expect(live).toMatchObject({ pos: 0, paused: false });
});
