import { createTestApiMock } from "./testApiMock";
// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerStatus } from "../api";

const apiMocks = vi.hoisted(() => ({
  playerStatus: vi.fn(),
}));
vi.mock("../api", async () => ({ ...(await createTestApiMock()), ...apiMocks }));

import type { TimelineSpan } from "./bandTimeline";
import { PLAYHEAD_POLL_MS, SEEK_RATIO_EVENT, useBandPlayhead } from "./useBandPlayhead";

/**
 * R17 playfix:镜头带「点哪定位到哪」的待发 seek 只对**这一次**选中有效。点了 B 的镜块又改点 C,
 * 那条「B 就绪后 seek 到 r」不能一直挂着 —— 否则几分钟后再选 B,B 一就绪就被定位到早已过期的 r。
 */

const span = (clipId: number, index: number): TimelineSpan => ({
  key: `item:${clipId}`,
  clipId,
  segmentId: null,
  startMs: index * 10_000,
  durationMs: 10_000,
  inMs: 0,
  left: index * 200,
  width: 160,
});
const spans = [span(9, 0), span(10, 1), span(11, 2)];

const ready = (clipId: number): PlayerStatus => ({
  phase: "ready",
  clip_id: clipId,
  pos: 1,
  duration: 10,
  paused: true,
  frame: null,
  error: null,
  seek_samples: 0,
  seek_p50_ms: null,
  seek_p95_ms: null,
  last_seek_ms: null,
});

let live: PlayerStatus;
let ratios: number[];
const onSeek = (event: Event) => {
  ratios.push((event as CustomEvent<{ ratio: number }>).detail.ratio);
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  live = ready(9);
  ratios = [];
  apiMocks.playerStatus.mockImplementation(async () => live);
  window.addEventListener(SEEK_RATIO_EVENT, onSeek);
});

afterEach(() => {
  window.removeEventListener(SEEK_RATIO_EVENT, onSeek);
  vi.useRealTimers();
});

async function tick(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PLAYHEAD_POLL_MS + 10);
  });
}

describe("R17 playfix:镜头带待发 seek 只对这一次选中有效", () => {
  it("点 B 的镜块(B 未就绪)→ 改选 C → 之后再选 B:过期的 seek 不再发;当次选中照常发一次", async () => {
    const hook = renderHook((selected: number) => useBandPlayhead(spans, selected), { initialProps: 9 });
    await tick();
    act(() => {
      hook.result.current.requestSeek(10, 0.5);
    });
    // 用户没等 B,改点了 C。
    hook.rerender(11);
    live = ready(11);
    await tick();
    expect(ratios).toEqual([]);
    // 几拍之后再选 B:B 就绪,但那条 0.5 早就不该算数。
    hook.rerender(10);
    live = ready(10);
    await tick();
    await tick();
    expect(ratios).toEqual([]);
    // 当次点 B 的镜块:正常发一次。
    act(() => {
      hook.result.current.requestSeek(10, 0.25);
    });
    await waitFor(() => expect(ratios).toEqual([0.25]));
  });
});
