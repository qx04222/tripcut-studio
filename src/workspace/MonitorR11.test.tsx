import { createTestApiMock } from "./testApiMock";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClipListItem, ClipMoment, PlayerStatus, SegmentSuggestion } from "../api";

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
const clip10: ClipListItem = { ...clip, id: 10, file_name: "clip-10.mov" };

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

/** 120 格 × 0.5 s;第 40 格(20 s)最高分。 */
function fullMoment(index: number, score: number): ClipMoment {
  return {
    clip_id: 9,
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
    reasons: score >= 0.6 ? ["清晰"] : [],
  };
}
const moments: ClipMoment[] = Array.from({ length: 120 }, (_, index) => fullMoment(index, index === 40 ? 0.95 : 0.2));
const suggestions: SegmentSuggestion[] = [
  { in_ticks: 17_000, out_ticks: 23_000, score: 0.95, reasons: ["清晰", "运动适中"] },
  { in_ticks: 40_000, out_ticks: 45_000, score: 0.7, reasons: ["有人声"] },
  { in_ticks: 50_000, out_ticks: 56_000, score: 0.6, reasons: ["曝光正常"] },
];

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
// 用全量桩打底:Monitor 挂载会带起 useClipsFeed,它会去摸 listShotStacks 等一串导出,
// 手写的部分桩在 vitest 里会把「访问未定义导出」抛成 Unhandled Rejection(门禁假红一次)。
vi.mock("../api", async () => ({ ...(await createTestApiMock()), ...apiMocks }));

import { Monitor } from "./Monitor";
import { __resetPlayerPrefsForTests } from "./playerPrefs";
import { __resetPoolOrderForTests, setPoolOrder } from "./poolOrder";
import { REWIND_TICK_MS } from "./useMonitorTransport";
import { __resetWorkspaceForTests, dispatchWorkspace, getWorkspaceSnapshot } from "./WorkspaceStore";

let liveStatus: PlayerStatus;

beforeEach(() => {
  __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 }, focusedPane: "monitor" });
  __resetPlayerPrefsForTests();
  __resetPoolOrderForTests();
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  };
  liveStatus = { ...readyStatus };
  apiMocks.listClips.mockResolvedValue([clip, clip10]);
  apiMocks.listStoryGaps.mockResolvedValue([]);
  apiMocks.listSelectSegments.mockResolvedValue([]);
  apiMocks.createSelectSegment.mockResolvedValue({ id: 1, clip_id: 9, in_ticks: 0, out_ticks: 1, tb_num: 1, tb_den: 1_000 });
  apiMocks.playerOpen.mockImplementation(async (clipId: number) => {
    liveStatus = { ...liveStatus, clip_id: clipId };
    return liveStatus;
  });
  apiMocks.playerStatus.mockImplementation(async () => liveStatus);
  // 假 mpv:seek / play / pause 真的改状态,这样「补读一次」拿到的是新位置。
  apiMocks.playerCommand.mockImplementation(async (cmd: { type: string; seconds?: number }) => {
    if (cmd.type === "seek_abs") liveStatus = { ...liveStatus, pos: cmd.seconds ?? 0 };
    if (cmd.type === "play") liveStatus = { ...liveStatus, paused: false };
    if (cmd.type === "pause") liveStatus = { ...liveStatus, paused: true };
  });
  apiMocks.playerClose.mockResolvedValue(undefined);
  apiMocks.playerSetViewport.mockResolvedValue(undefined);
  apiMocks.playerSetOccluded.mockResolvedValue(undefined);
  apiMocks.setSetting.mockResolvedValue(undefined);
  apiMocks.getSettings.mockResolvedValue({});
  apiMocks.getClipMoments.mockResolvedValue(moments);
  apiMocks.suggestSegments.mockResolvedValue(suggestions);
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
  await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalled());
  await flush();
  await flush();
  return screen.getByRole("region", { name: "预览监视器" });
}

const commands = () => apiMocks.playerCommand.mock.calls.map(([cmd]) => cmd as { type: string; seconds?: number; muted?: boolean });

/**
 * 把假 mpv 的位置推到某处再让监视器看见:播放中 80ms 轮询自己会读到;暂停时监视器不轮询,
 * 靠点一下播放键(命令之后补读一次)把新位置带回来。
 */
async function movePlayhead(seconds: number, paused = true): Promise<void> {
  liveStatus = { ...liveStatus, pos: seconds, paused };
  if (!paused) {
    await flush();
    return;
  }
  fireEvent.click(screen.getByRole("button", { name: /^(暂停|播放)$/ }));
  await flush();
  await flush();
}

describe("R11 §1.2:热力条与建议段", () => {
  it("seek bar 下画「时刻热力」(≤200 个点),三条建议画成区块、当前一条高亮,状态行可读", async () => {
    await renderInPane();
    const heat = await screen.findByRole("img", { name: "时刻热力" });
    expect(heat.querySelectorAll(".monitor-heat-bar").length).toBe(120);
    expect(heat.querySelectorAll(".monitor-heat-bar").length).toBeLessThanOrEqual(200);
    expect(heat.querySelectorAll(".monitor-heat-suggestion").length).toBe(3);
    expect(heat.querySelectorAll(".monitor-heat-suggestion.active").length).toBe(1);
    // R19 V-05:可见只留「建议 1/3」,整句在 aria-label / tooltip 里;「按 Enter 采用这段」进 tooltip。
    expect(screen.getByLabelText("建议 1/3 · 6.0 s · 清晰·运动适中").textContent).toBe("建议 1/3");
    expect(screen.getByTestId("monitor-suggestion").getAttribute("title")).toContain("按 Enter 采用这段");
    // 当前建议已经填成入出点,I / O 可以微调。
    expect(screen.getByRole("button", { name: "入点", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "出点", pressed: true })).toBeTruthy();
  });

  it("N / ⇧N 切换建议并跳到它的入点;Enter 采纳 = 用现有创建精选段命令保存当前建议", async () => {
    const region = await renderInPane();
    region.focus();
    fireEvent.keyDown(region, { key: "n", code: "KeyN" });
    await flush();
    expect(screen.getByLabelText("建议 2/3 · 5.0 s · 有人声")).toBeTruthy();
    expect(commands()).toContainEqual({ type: "seek_abs", seconds: 40 });
    fireEvent.keyDown(region, { key: "N", code: "KeyN", shiftKey: true });
    await flush();
    expect(screen.getByLabelText("建议 1/3 · 6.0 s · 清晰·运动适中")).toBeTruthy();
    fireEvent.keyDown(region, { key: "Enter", code: "Enter" });
    await flush();
    expect(apiMocks.createSelectSegment).toHaveBeenCalledWith(9, 17, 23);
    expect(await screen.findByText("已采用建议 1 · 精选段已保存")).toBeTruthy();
  });

  it("选中素材默认停在最高分时刻(ui.player.start_at_best 默认开;R12 起只预览不开播);关掉就不跳", async () => {
    await renderInPane();
    await waitFor(() => expect(commands()).toContainEqual({ type: "seek_abs", seconds: 20 }));
    cleanup();
    vi.clearAllMocks();
    apiMocks.getSettings.mockResolvedValue({ "ui.player.start_at_best": "false" });
    __resetPlayerPrefsForTests();
    apiMocks.listClips.mockResolvedValue([clip]);
    apiMocks.getClipMoments.mockResolvedValue(moments);
    apiMocks.suggestSegments.mockResolvedValue(suggestions);
    await renderInPane();
    await screen.findByRole("img", { name: "时刻热力" });
    expect(commands().filter((cmd) => cmd.type === "seek_abs" && cmd.seconds === 20)).toEqual([]);
  });

  it("时刻分拉不到时:不画热力条、没有建议行,监视器其它部分照常", async () => {
    apiMocks.getClipMoments.mockRejectedValue(new Error("no moments"));
    apiMocks.suggestSegments.mockResolvedValue([]);
    await renderInPane();
    expect(screen.queryByRole("img", { name: "时刻热力" })).toBeNull();
    expect(screen.queryByTestId("monitor-suggestion")).toBeNull();
    expect(screen.getByText("待打点")).toBeTruthy();
  });
});

describe("R11 §3:播放器更聪明一点", () => {
  // 这一组不看热力:时刻分给空,免得「从最高分开播」把播放头先挪到 20 s。
  beforeEach(() => apiMocks.getClipMoments.mockResolvedValue([]));

  it(", / . 逐帧走原生 step_fwd / step_back(R12 §5;mpv 按素材帧率走),⌥←/→ ±5 s,S 保存当前入出点", async () => {
    apiMocks.suggestSegments.mockResolvedValue([]);
    const region = await renderInPane();
    region.focus();
    apiMocks.playerCommand.mockClear();
    fireEvent.keyDown(region, { key: ".", code: "Period" });
    await flush();
    expect(commands()).toEqual([{ type: "step_fwd" }]);
    apiMocks.playerCommand.mockClear();
    fireEvent.keyDown(region, { key: ",", code: "Comma" });
    await flush();
    expect(commands().at(-1)).toEqual({ type: "step_back" });
    apiMocks.playerCommand.mockClear();
    fireEvent.keyDown(region, { key: "ArrowRight", code: "ArrowRight", shiftKey: true }); // R13 剪映键位:±5 s 是 ⇧←/→
    await flush();
    expect(commands()).toEqual([{ type: "seek_abs", seconds: 17.5 }]);
    fireEvent.keyDown(region, { key: "ArrowLeft", code: "ArrowLeft", shiftKey: true });
    await flush();
    expect(commands().at(-1)).toEqual({ type: "seek_abs", seconds: 12.5 });
    fireEvent.keyDown(region, { key: "i", code: "KeyI" });
    fireEvent.keyDown(region, { key: "ArrowRight", code: "ArrowRight", altKey: true }); // ⌥→ +1 s(裸 → 已是逐帧)
    await flush();
    fireEvent.keyDown(region, { key: "o", code: "KeyO" });
    fireEvent.keyDown(region, { key: "s", code: "KeyS" });
    await flush();
    expect(apiMocks.createSelectSegment).toHaveBeenCalledWith(9, 12.5, 13.5);
  });

  /**
   * V-04:mpv 的 seek 是异步的,命令回来那一刻状态里的 pos 还是旧的;暂停时又不轮询,
   * 读数就停在旧值直到下一条命令(真机 ⌥→ 后 3 s 不动、按 K 才刷)。逐帧再拿这个旧 pos 算
   * ±1 帧,就在 3.1 ↔ 8.1 之间来回跳。这里的假 mpv 让 seek 迟两次读才落地。
   */
  it("暂停态 seek:读数等 seek 落地再更新;紧接着的逐帧(原生 step)也等位置变了再读", async () => {
    apiMocks.suggestSegments.mockResolvedValue([]);
    let landing: { pos: number; reads: number } | null = null;
    apiMocks.playerCommand.mockImplementation(async (cmd: { type: string; seconds?: number }) => {
      if (cmd.type === "seek_abs") landing = { pos: cmd.seconds ?? 0, reads: 2 };
      // R12 §5:原生逐帧同样异步落地 —— 从「最后要去的位置」起算一帧,迟两次读才见。
      if (cmd.type === "step_fwd") landing = { pos: Math.round(((landing?.pos ?? liveStatus.pos) + 0.04) * 1000) / 1000, reads: 2 };
      if (cmd.type === "play") liveStatus = { ...liveStatus, paused: false };
      if (cmd.type === "pause") liveStatus = { ...liveStatus, paused: true };
    });
    apiMocks.playerStatus.mockImplementation(async () => {
      if (landing) {
        if (landing.reads > 0) landing.reads -= 1;
        else {
          liveStatus = { ...liveStatus, pos: landing.pos };
          landing = null;
        }
      }
      return liveStatus;
    });
    const region = await renderInPane();
    region.focus();
    const readout = () => screen.getByLabelText("当前时间码").getAttribute("title");
    expect(readout()).toBe("00:00:12.500");
    fireEvent.keyDown(region, { key: "ArrowRight", code: "ArrowRight", shiftKey: true }); // R13 剪映键位:±5 s 是 ⇧←/→
    await waitFor(() => expect(readout()).toBe("00:00:17.500"));
    // seek 还在路上(旧 pos 12.5)时就按 . :逐帧交给 mpv 从它真实的位置(22.5)走一帧,前端不算。
    apiMocks.playerCommand.mockClear();
    fireEvent.keyDown(region, { key: "ArrowRight", code: "ArrowRight", shiftKey: true }); // R13 剪映键位:±5 s 是 ⇧←/→
    fireEvent.keyDown(region, { key: ".", code: "Period" });
    await waitFor(() => expect(commands().map((cmd) => cmd.type)).toEqual(["seek_abs", "step_fwd"]));
    expect(commands()[0]?.seconds).toBe(22.5);
    await waitFor(() => expect(readout()).toBe("00:00:22.540"));
    // 入点也按落地位置打,不按旧读数。
    fireEvent.keyDown(region, { key: "i", code: "KeyI" });
    expect(screen.getByRole("button", { name: "入点" }).getAttribute("title")).toBe("入点 00:00:22.540");
  });

  it("L 再按 ×2 → ×4(R12 §5:原生 set_speed,不再定时 seek),K 停;J 倒退(定时原生 step_back)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMocks.suggestSegments.mockResolvedValue([]);
    const region = await renderInPane();
    region.focus();
    const speed = screen.getByRole("button", { name: "播放速度" });
    expect(speed.textContent).toBe("×1");
    fireEvent.keyDown(region, { key: "l", code: "KeyL" });
    await flush();
    expect(commands()).toContainEqual({ type: "play" });
    fireEvent.keyDown(region, { key: "l", code: "KeyL" });
    await flush();
    expect(speed.textContent).toBe("×2");
    fireEvent.keyDown(region, { key: "l", code: "KeyL" });
    await flush();
    expect(speed.textContent).toBe("×4");
    expect(commands().at(-1)).toEqual({ type: "set_speed", speed: 4 });
    apiMocks.playerCommand.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REWIND_TICK_MS * 3);
    });
    expect(commands().filter((cmd) => cmd.type === "seek_abs")).toEqual([]);
    fireEvent.keyDown(region, { key: "k", code: "KeyK" });
    await flush();
    expect(speed.textContent).toBe("×1");
    expect(commands().at(-1)).toEqual({ type: "set_speed", speed: 1 });
    expect(commands().at(-2)).toEqual({ type: "pause" });
    apiMocks.playerCommand.mockClear();
    fireEvent.keyDown(region, { key: "j", code: "KeyJ" });
    await flush();
    expect(speed.textContent).toBe("倒退");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REWIND_TICK_MS + 5);
    });
    expect(commands()).toEqual([{ type: "pause" }, { type: "step_back" }]);
  });

  it("⇧L 循环入出区间:播过出点回入点;保存后循环自动关", async () => {
    apiMocks.suggestSegments.mockResolvedValue([]);
    const region = await renderInPane();
    region.focus();
    fireEvent.keyDown(region, { key: "i", code: "KeyI" });
    await movePlayhead(20);
    fireEvent.keyDown(region, { key: "o", code: "KeyO" });
    await flush();
    apiMocks.playerCommand.mockClear();
    fireEvent.keyDown(region, { key: "L", code: "KeyL", shiftKey: true });
    await flush();
    expect(commands()).toEqual([{ type: "seek_abs", seconds: 12.5 }, { type: "play" }]);
    expect(screen.getByText(/循环中/)).toBeTruthy();
    apiMocks.playerCommand.mockClear();
    await movePlayhead(20.3, false);
    await waitFor(() => expect(commands()).toContainEqual({ type: "seek_abs", seconds: 12.5 }));
    fireEvent.keyDown(region, { key: "s", code: "KeyS" });
    await flush();
    expect(await screen.findByText("精选段已保存")).toBeTruthy();
    expect(screen.queryByText(/循环中/)).toBeNull();
  });

  it("播完自动下一条(R12 起「连播」默认关,这里显式打开):顺媒体池可见顺序选下一条;末尾停下;设置关掉不跳", async () => {
    apiMocks.getSettings.mockResolvedValue({ "ui.player.auto_advance": "true" });
    apiMocks.suggestSegments.mockResolvedValue([]);
    setPoolOrder([9, 10]);
    await renderInPane();
    await movePlayhead(59.95, true);
    await waitFor(() => expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 10 }));
    // 第二条播完:它是末尾,不再跳。
    await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalledWith(10));
    await flush();
    await movePlayhead(59.95, true);
    await flush();
    expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 10 });
    cleanup();
    vi.clearAllMocks();
    __resetPlayerPrefsForTests();
    apiMocks.getSettings.mockResolvedValue({ "ui.player.auto_advance": "false" });
    apiMocks.listClips.mockResolvedValue([clip, clip10]);
    apiMocks.suggestSegments.mockResolvedValue([]);
    apiMocks.getClipMoments.mockResolvedValue(moments);
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 }, focusedPane: "monitor" });
    liveStatus = { ...readyStatus };
    await renderInPane();
    await movePlayhead(59.95, true);
    await flush();
    expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 9 });
  });

  /**
   * V-05:点一张卡(手动换素材)之后,新素材第一份状态里的 pos 可能还是上一条的片尾
   * (播放器换源、状态回写有先后),自动下一条不能拿它当「这条播完了」——否则选中一路跑走。
   * 只有先看见这条素材在片中播过、且离手动换素材 ≥ 1 s,片尾才算数。
   */
  it("手动点卡后 1 s 内、或还没见它播过,片尾都不触发自动下一条;之后正常接力(「连播」显式打开)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMocks.getSettings.mockResolvedValue({ "ui.player.auto_advance": "true" });
    apiMocks.suggestSegments.mockResolvedValue([]);
    const clip11: ClipListItem = { ...clip, id: 11, file_name: "clip-11.mov" };
    apiMocks.listClips.mockResolvedValue([clip, clip10, clip11]);
    setPoolOrder([9, 10, 11]);
    await renderInPane();
    // 用户点了第 10 张卡;播放器换源后第一份状态还带着上一条的片尾位置。
    liveStatus = { ...liveStatus, pos: 59.95, paused: true };
    await act(async () => {
      dispatchWorkspace({ type: "select-clip", clipId: 10 });
    });
    await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalledWith(10));
    await flush();
    await flush();
    expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 10 });
    // 见它播到片中,但离手动换素材还不到 1 s:片尾仍不接力。
    await movePlayhead(5, false);
    await movePlayhead(59.95, true);
    await flush();
    expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 10 });
    // 过了 1 s 再播完:接力到 11。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    await movePlayhead(5, false);
    await movePlayhead(59.95, true);
    await waitFor(() => expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 11 }));
  });

  it("静音记忆:ui.player.muted=true 时素材一就绪就补发 set_mute;点静音键写回设置", async () => {
    apiMocks.getSettings.mockResolvedValue({ "ui.player.muted": "true" });
    apiMocks.suggestSegments.mockResolvedValue([]);
    await renderInPane();
    await waitFor(() => expect(commands()).toContainEqual({ type: "set_mute", muted: true }));
    fireEvent.click(screen.getByRole("button", { name: "取消静音" }));
    await flush();
    expect(apiMocks.setSetting).toHaveBeenCalledWith("ui.player.muted", "false");
    expect(commands().at(-1)).toEqual({ type: "set_mute", muted: false });
  });
});
