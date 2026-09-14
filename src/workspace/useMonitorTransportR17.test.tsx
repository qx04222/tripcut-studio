import { createTestApiMock } from "./testApiMock";
// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClipListItem, PlayerCommand, PlayerStatus } from "../api";

vi.mock("../api", async () => createTestApiMock());

import { __resetPlayerPrefsForTests } from "./playerPrefs";
import { useMonitorTransport, type MonitorTransportDeps } from "./useMonitorTransport";

/**
 * R17 playfix:走带的每一条命令都只能打在「状态里就是这条素材」的播放器上。换素材的那一拍,
 * `clip` 已经是 B、`status` 还是 A 的(位置 12.3 s)——这时任何按位置算的命令(⌥→、seek、
 * J/K/L、逐帧)都不能拿 A 的位置去发,否则命令穿过 Rust 侧的 operation 锁落到 B 的新实例上,
 * B 就从 A 停住的位置开始。
 */

const clipA = { id: 9, fps_num: 25, fps_den: 1 } as ClipListItem;
const clipB = { id: 10, fps_num: 25, fps_den: 1 } as ClipListItem;

const readyA: PlayerStatus = {
  phase: "ready",
  clip_id: 9,
  pos: 12.3,
  duration: 60,
  paused: true,
  frame: null,
  error: null,
  seek_samples: 0,
  seek_p50_ms: null,
  seek_p95_ms: null,
  last_seek_ms: null,
};

beforeEach(() => {
  __resetPlayerPrefsForTests();
});

function mount(initial: Partial<MonitorTransportDeps>) {
  const send = vi.fn(async (_commands: PlayerCommand[]) => undefined);
  const base: MonitorTransportDeps = {
    clip: clipA,
    status: readyA,
    send,
    inPoint: null,
    outPoint: null,
    bestStart: null,
    momentsLoaded: false,
    ...initial,
  };
  const hook = renderHook((deps: MonitorTransportDeps) => useMonitorTransport(deps), { initialProps: base });
  return { ...hook, send, base };
}

describe("R17 playfix:命令只打在「状态里就是这条素材」的播放器上", () => {
  it("clip 已是 B、status 还是 A 的:position() 为 null,seekTo / nudge / shuttle / frame / setRate 一条命令都不发", () => {
    const { result, send } = mount({ clip: clipB, status: readyA });
    expect(result.current.position()).toBeNull();
    act(() => {
      result.current.seekTo(5);
      result.current.nudge(1);
      result.current.shuttle("l");
      result.current.shuttle("j");
      result.current.shuttle("k");
      result.current.frame(1);
      result.current.setRate(2);
      result.current.toggleLoop();
    });
    expect(send).not.toHaveBeenCalled();
    expect(result.current.rewinding).toBe(false);
    expect(result.current.looping).toBe(false);
  });

  it("同一条素材(clip A、status A)照常:seekTo 发 seek_abs,position() 是状态里的位置", () => {
    const { result, send } = mount({ clip: clipA, status: readyA });
    expect(result.current.position()).toBe(12.3);
    act(() => {
      result.current.seekTo(5);
    });
    expect(send).toHaveBeenCalledWith([{ type: "seek_abs", seconds: 5 }]);
  });

  it("从 A 切到 B 的那一拍(props 先换 clip、status 还没归零):nudge 不会拿 A 的 12.3 s 去算 B 的位置", () => {
    const { result, rerender, send, base } = mount({});
    expect(result.current.position()).toBe(12.3);
    send.mockClear(); // 挂载时 A 就绪先暂停(R12 §5)那一条不算
    rerender({ ...base, clip: clipB });
    act(() => {
      result.current.nudge(1);
    });
    expect(send).not.toHaveBeenCalled();
    // 状态追上 B 之后才认。
    rerender({ ...base, clip: clipB, status: { ...readyA, clip_id: 10, pos: 0 } });
    act(() => {
      result.current.nudge(1);
    });
    expect(send).toHaveBeenCalledWith([{ type: "seek_abs", seconds: 1 }]);
  });
});
