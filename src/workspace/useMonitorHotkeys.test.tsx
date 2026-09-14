import { createTestApiMock } from "./testApiMock";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClipListItem, PlayerStatus } from "../api";

const clip: ClipListItem = {
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

const readyStatus: PlayerStatus = {
  phase: "ready",
  clip_id: 9,
  pos: 12.5,
  duration: 60,
  paused: true,
  frame: null,
  error: null,
  seek_samples: 0,
  seek_p50_ms: null,
  seek_p95_ms: null,
  last_seek_ms: null,
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
  // R11 车道 C:播放器偏好 / 时刻分 / 建议段(这里的用例不关心,给空)。
  getSettings: vi.fn(async () => ({})),
  getClipMoments: vi.fn(async () => []),
  suggestSegments: vi.fn(async () => []),
}));
// 全量桩打底(见 MonitorR11.test):Monitor 会带起 useClipsFeed,部分桩会抛未定义导出。
vi.mock("../api", async () => ({ ...(await createTestApiMock()), ...apiMocks }));

import { Monitor } from "./Monitor";
import { monitorHotkeyIntent } from "./useMonitorHotkeys";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";

beforeEach(() => {
  __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 }, focusedPane: "monitor" });
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  };
  apiMocks.listClips.mockResolvedValue([clip]);
  apiMocks.listStoryGaps.mockResolvedValue([]);
  apiMocks.listSelectSegments.mockResolvedValue([]);
  apiMocks.createSelectSegment.mockResolvedValue({ id: 1, clip_id: 9, in_ticks: 0, out_ticks: 1, tb_num: 1, tb_den: 1_000 });
  apiMocks.playerOpen.mockResolvedValue(readyStatus);
  apiMocks.playerStatus.mockResolvedValue(readyStatus);
  apiMocks.playerClose.mockResolvedValue(undefined);
  apiMocks.playerCommand.mockResolvedValue(undefined);
  apiMocks.playerSetViewport.mockResolvedValue(undefined);
  apiMocks.playerSetOccluded.mockResolvedValue(undefined);
  apiMocks.setSetting.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 壳里的监视器 landmark(F6 把 DOM 焦点送到这里);测试里自己包一层。 */
async function renderInPane(): Promise<HTMLElement> {
  render(
    <div data-pane="monitor" role="region" aria-label="预览监视器" tabIndex={-1}>
      <Monitor />
      <input aria-label="备注" />
    </div>,
  );
  await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalled());
  await flush();
  return screen.getByRole("region", { name: "预览监视器" });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function press(target: Element, key: string, code: string): void {
  fireEvent.keyDown(target, { key, code });
}

describe("monitorHotkeyIntent(纯函数)", () => {
  it("I/O 打点、←/→ 逐帧(R13 剪映键位)、⌥←/→ ±1 s、J/K/L 穿梭、空格播放暂停;IME 组合中与 ⌘ 组合一律不接", () => {
    expect(monitorHotkeyIntent({ key: "i", code: "KeyI", metaKey: false, ctrlKey: false }, false)).toEqual({ kind: "mark", edge: "in" });
    expect(monitorHotkeyIntent({ key: "Process", code: "KeyO", metaKey: false, ctrlKey: false }, false)).toEqual({ kind: "mark", edge: "out" });
    expect(monitorHotkeyIntent({ key: "ArrowLeft", code: "ArrowLeft", metaKey: false, ctrlKey: false }, false)).toEqual({ kind: "frame", direction: -1 });
    expect(monitorHotkeyIntent({ key: "ArrowRight", code: "ArrowRight", metaKey: false, ctrlKey: false }, false)).toEqual({ kind: "frame", direction: 1 });
    expect(monitorHotkeyIntent({ key: "ArrowLeft", code: "ArrowLeft", metaKey: false, ctrlKey: false, altKey: true }, false)).toEqual({ kind: "nudge", seconds: -1 });
    expect(monitorHotkeyIntent({ key: "ArrowRight", code: "ArrowRight", metaKey: false, ctrlKey: false, altKey: true }, false)).toEqual({ kind: "nudge", seconds: 1 });
    expect(monitorHotkeyIntent({ key: "j", code: "KeyJ", metaKey: false, ctrlKey: false }, false)).toEqual({ kind: "shuttle", key: "j" });
    expect(monitorHotkeyIntent({ key: "k", code: "KeyK", metaKey: false, ctrlKey: false }, false)).toEqual({ kind: "shuttle", key: "k" });
    expect(monitorHotkeyIntent({ key: "l", code: "KeyL", metaKey: false, ctrlKey: false }, false)).toEqual({ kind: "shuttle", key: "l" });
    expect(monitorHotkeyIntent({ key: " ", code: "Space", metaKey: false, ctrlKey: false }, false)).toEqual({ kind: "toggle-playback" });
    expect(monitorHotkeyIntent({ key: "i", code: "KeyI", metaKey: false, ctrlKey: false }, true)).toBeNull();
    expect(monitorHotkeyIntent({ key: "i", code: "KeyI", metaKey: true, ctrlKey: false }, false)).toBeNull();
    expect(monitorHotkeyIntent({ key: "f", code: "KeyF", metaKey: false, ctrlKey: false }, false)).toBeNull();
  });
});

describe("R-01:监视器栏聚焦后的打点/播放键", () => {
  it("F6 落在栏 landmark 上:I 设入点、O 设出点、⌥→ 前进一秒(R13:裸 → 归逐帧)、空格播放", async () => {
    const region = await renderInPane();
    region.focus();
    press(region, "i", "KeyI");
    expect(await screen.findByText("已设置入点")).toBeTruthy();
    fireEvent.keyDown(region, { key: "ArrowRight", code: "ArrowRight", altKey: true });
    expect(apiMocks.playerCommand).toHaveBeenCalledWith({ type: "seek_abs", seconds: 13.5 }, expect.anything());
    // V-04:这里的假播放器 seek 永远不落地(状态一直报 12.5)。← 要从「刚才要去的 13.5」退一秒,
    // 不是从旧读数 12.5 —— 否则真机上就是 3.1 ↔ 8.1 来回跳。
    fireEvent.keyDown(region, { key: "ArrowLeft", code: "ArrowLeft", altKey: true });
    expect(apiMocks.playerCommand).toHaveBeenCalledWith({ type: "seek_abs", seconds: 12.5 }, expect.anything());
    press(region, "o", "KeyO");
    expect(await screen.findByText("已设置出点")).toBeTruthy();
    apiMocks.playerCommand.mockClear();
    press(region, " ", "Space");
    expect(apiMocks.playerCommand).toHaveBeenCalledWith({ type: "play" }, expect.anything());
  });

  it("J/K/L:J 暂停进入倒退,K 暂停并回 ×1,L 以 ×1 播放(R12 §5 原生真变速)", async () => {
    const region = await renderInPane();
    region.focus();
    // R12 §5:素材一就绪监视器先发一条 pause(点卡片 = 预览),不算这组按键的输出。
    apiMocks.playerCommand.mockClear();
    press(region, "j", "KeyJ");
    await flush();
    expect(apiMocks.playerCommand.mock.calls.map(([cmd]) => cmd)).toEqual([{ type: "pause" }]);
    apiMocks.playerCommand.mockClear();
    press(region, "k", "KeyK");
    expect(apiMocks.playerCommand).toHaveBeenCalledWith({ type: "pause" }, expect.anything());
    await flush();
    expect(apiMocks.playerCommand).toHaveBeenCalledWith({ type: "set_speed", speed: 1 }, expect.anything());
    apiMocks.playerCommand.mockClear();
    press(region, "l", "KeyL");
    await flush();
    expect(apiMocks.playerCommand).toHaveBeenCalledWith({ type: "play" }, expect.anything());
  });

  it("焦点在栏内的按钮上照样接管 I;空格留给按钮自己;输入框里一个键都不接", async () => {
    const region = await renderInPane();
    const play = screen.getByRole("button", { name: "播放" });
    play.focus();
    press(play, "i", "KeyI");
    expect(await screen.findByText("已设置入点")).toBeTruthy();
    apiMocks.playerCommand.mockClear();
    press(play, " ", "Space");
    expect(apiMocks.playerCommand).not.toHaveBeenCalled();
    const input = screen.getByRole("textbox", { name: "备注" });
    input.focus();
    press(input, "o", "KeyO");
    expect(screen.queryByText("已设置出点")).toBeNull();
    press(input, "ArrowRight", "ArrowRight");
    expect(apiMocks.playerCommand).not.toHaveBeenCalled();
    expect(region).toBeTruthy();
  });

  it("点进监视器栏把 focusedPane 切到 monitor;焦点栏不是 monitor 时不接管", async () => {
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 }, focusedPane: "pool" });
    const region = await renderInPane();
    press(region, "i", "KeyI");
    expect(screen.queryByText("已设置入点")).toBeNull();
    act(() => {
      screen.getByRole("button", { name: "播放" }).focus();
    });
    expect(getWorkspaceSnapshot().focusedPane).toBe("monitor");
    press(region, "i", "KeyI");
    expect(await screen.findByText("已设置入点")).toBeTruthy();
  });
});

describe("R11 §1.2 / §3:建议段、逐帧、⌥±5 s、⇧L 循环、S 保存(纯函数)", () => {
  const base = { metaKey: false, ctrlKey: false };
  it("Enter 采纳、N/⇧N 切换建议、, . 逐帧、⇧←/→ ±5 s、⇧L 循环、S 保存;⌘ 组合与 IME 一律不接", () => {
    expect(monitorHotkeyIntent({ ...base, key: "Enter", code: "Enter" }, false)).toEqual({ kind: "adopt-suggestion" });
    expect(monitorHotkeyIntent({ ...base, key: "n", code: "KeyN" }, false)).toEqual({ kind: "step-suggestion", direction: 1 });
    expect(monitorHotkeyIntent({ ...base, key: "N", code: "KeyN", shiftKey: true }, false)).toEqual({ kind: "step-suggestion", direction: -1 });
    expect(monitorHotkeyIntent({ ...base, key: ",", code: "Comma" }, false)).toEqual({ kind: "frame", direction: -1 });
    expect(monitorHotkeyIntent({ ...base, key: ".", code: "Period" }, false)).toEqual({ kind: "frame", direction: 1 });
    // R13 剪映键位:±5 s 是 ⇧←/→(⌥←/→ 变成 ±1 s)。
    expect(monitorHotkeyIntent({ ...base, key: "ArrowLeft", code: "ArrowLeft", shiftKey: true }, false)).toEqual({ kind: "nudge", seconds: -5 });
    expect(monitorHotkeyIntent({ ...base, key: "ArrowRight", code: "ArrowRight", shiftKey: true }, false)).toEqual({ kind: "nudge", seconds: 5 });
    expect(monitorHotkeyIntent({ ...base, key: "L", code: "KeyL", shiftKey: true }, false)).toEqual({ kind: "toggle-loop" });
    expect(monitorHotkeyIntent({ ...base, key: "l", code: "KeyL" }, false)).toEqual({ kind: "shuttle", key: "l" });
    expect(monitorHotkeyIntent({ ...base, key: "s", code: "KeyS" }, false)).toEqual({ kind: "save" });
    expect(monitorHotkeyIntent({ ...base, key: "Enter", code: "Enter", metaKey: true }, false)).toBeNull();
    expect(monitorHotkeyIntent({ ...base, key: "n", code: "KeyN" }, true)).toBeNull();
  });
});
