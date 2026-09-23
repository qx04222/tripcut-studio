// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  createSelectSegment: vi.fn(),
  listSelectSegments: vi.fn(),
  playerClose: vi.fn(),
  playerCommand: vi.fn(),
  playerOpen: vi.fn(),
  playerSetViewport: vi.fn(),
  playerStatus: vi.fn(),
}));
vi.mock("./api", () => apiMocks);

import { PlayerOverlay, type EmbeddedPlayerControls } from "./PlayerOverlay";
import type { ClipListItem, PlayerCommand, PlayerStatus } from "./api";

/**
 * R17 playfix:嵌入通道只属于「已经 player_open 成功的那条素材」。
 * Rust 侧 `player_command` 排在 `PlayerManager::open` 的 operation 锁后面 —— 换素材期间发出的
 * 命令会等 B 的新实例起来再落到 B 上。所以:
 *  - 一批命令发到一半换了素材,剩下的不再发(否则 A 的 seek_abs 12.3 落到 B);
 *  - B 的 player_open 还没回来之前,通道拒发(命令一条都不进 Rust 的队列)。
 */

const clipA: ClipListItem = {
  id: 9,
  episode_id: 1,
  folder_label: null,
  cover_url: null,
  path: "/Volumes/CARD/clip-9.mov",
  file_name: "clip-9.mov",
  byte_size: 2_048,
  quick_hash: "quick-9",
  full_hash: null,
  tb_num: 1,
  tb_den: 1_000,
  duration_ticks: 60_000,
  fps_num: 30,
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
const clipB: ClipListItem = { ...clipA, id: 10, file_name: "clip-10.mov" };

const readyA: PlayerStatus = {
  phase: "ready",
  clip_id: 9,
  pos: 12.3,
  duration: 60,
  paused: false,
  frame: null,
  error: null,
  seek_samples: 0,
  seek_p50_ms: null,
  seek_p95_ms: null,
  last_seek_ms: null,
};

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(clip: ClipListItem, controlsRef: { current: EmbeddedPlayerControls | null }): Promise<Root> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => {
    root.render(<PlayerOverlay clip={clip} variant="embedded" onExit={() => undefined} controlsRef={controlsRef} />);
  });
  await flush();
  return root;
}

beforeEach(() => {
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  };
  apiMocks.listSelectSegments.mockResolvedValue([]);
  apiMocks.playerSetViewport.mockResolvedValue(undefined);
  apiMocks.playerClose.mockResolvedValue(undefined);
  apiMocks.playerOpen.mockImplementation(async (clipId: number) => ({ ...readyA, clip_id: clipId, pos: 0 }));
  apiMocks.playerStatus.mockImplementation(async () => readyA);
  apiMocks.playerCommand.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.clearAllMocks();
});

const sent = () => apiMocks.playerCommand.mock.calls.map(([cmd]) => cmd as PlayerCommand);

describe("R17 playfix:嵌入通道只属于已打开的那条素材", () => {
  it("一批 [seek_abs 12.3, play] 发到一半换成 B:剩下的 play 不再发,也不再为这批补读状态", async () => {
    const controlsRef: { current: EmbeddedPlayerControls | null } = { current: null };
    const root = await mount(clipA, controlsRef);
    const firstCommand = deferred<void>();
    apiMocks.playerCommand.mockImplementationOnce(() => firstCommand.promise);
    apiMocks.playerStatus.mockClear();
    const batch = controlsRef.current!.send([{ type: "seek_abs", seconds: 12.3 }, { type: "play" }]);
    await flush();
    expect(sent()).toEqual([{ type: "seek_abs", seconds: 12.3 }]);
    // 第一条还没回来,用户点了 B。
    const openB = deferred<PlayerStatus>();
    apiMocks.playerOpen.mockImplementationOnce(() => openB.promise);
    await act(async () => {
      root.render(<PlayerOverlay clip={clipB} variant="embedded" onExit={() => undefined} controlsRef={controlsRef} />);
    });
    await flush();
    firstCommand.resolve();
    await batch;
    await flush();
    expect(sent()).toEqual([{ type: "seek_abs", seconds: 12.3 }]);
    expect(apiMocks.playerStatus).not.toHaveBeenCalled();
    openB.resolve({ ...readyA, clip_id: 10, pos: 0 });
    await flush();
  });

  it("B 的 player_open 还没回来:通道拒发(一条命令都不进队列);回来之后照常", async () => {
    const controlsRef: { current: EmbeddedPlayerControls | null } = { current: null };
    const root = await mount(clipA, controlsRef);
    const openB = deferred<PlayerStatus>();
    apiMocks.playerOpen.mockImplementationOnce(() => openB.promise);
    await act(async () => {
      root.render(<PlayerOverlay clip={clipB} variant="embedded" onExit={() => undefined} controlsRef={controlsRef} />);
    });
    await flush();
    apiMocks.playerCommand.mockClear();
    await act(async () => {
      await controlsRef.current!.send([{ type: "play" }]);
    });
    expect(sent()).toEqual([]);
    openB.resolve({ ...readyA, clip_id: 10, pos: 0, paused: false });
    await flush();
    await act(async () => {
      await controlsRef.current!.send([{ type: "pause" }]);
    });
    expect(sent()).toEqual([{ type: "pause" }]);
  });
});

it('002: A → B → C fast switching ignores late A/B open results; only C publishes playing at zero', async () => {
  const a = deferred<PlayerStatus>(), b = deferred<PlayerStatus>(), c = deferred<PlayerStatus>();
  apiMocks.playerOpen.mockImplementation((id: number) => id === 9 ? a.promise : id === 10 ? b.promise : c.promise);
  const controlsRef: { current: EmbeddedPlayerControls | null } = { current: null };
  const root = await mount(clipA, controlsRef);
  const observed: PlayerStatus[] = [];
  const observe = (s: PlayerStatus | null) => { if (s?.phase === 'ready') observed.push(s); };
  await act(async () => root.render(<PlayerOverlay clip={clipB} variant="embedded" onExit={() => {}} controlsRef={controlsRef} onStatusChange={observe} />));
  await flush();
  await act(async () => root.render(<PlayerOverlay clip={{ ...clipB, id: 11 }} variant="embedded" onExit={() => {}} controlsRef={controlsRef} onStatusChange={observe} />));
  await flush();
  await act(async () => { c.resolve({ ...readyA, clip_id: 11, pos: 0, paused: false }); });
  await flush();
  await act(async () => { b.resolve({ ...readyA, clip_id: 10, pos: 99 }); a.resolve({ ...readyA, pos: 88 }); });
  await flush();
  expect(apiMocks.playerOpen.mock.calls).toEqual([[9], [10], [11]]);
  expect(observed.length).toBeGreaterThan(0);
  expect(observed.every(s => s.clip_id === 11 && s.pos === 0 && !s.paused)).toBe(true);
  expect(sent()).toEqual([]);
});
