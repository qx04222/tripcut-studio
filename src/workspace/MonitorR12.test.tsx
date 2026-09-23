import { createTestApiMock } from "./testApiMock";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClipListItem, ClipMoment, PlayerStatus } from "../api";

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

/** 真机 `player_open` 回来的第一份状态:mpv 载入即播(paused=false)。 */
const openedStatus: PlayerStatus = {
  phase: "ready",
  clip_id: 9,
  pos: 0,
  duration: 60,
  paused: false,
  frame: null,
  error: null,
  seek_samples: 0,
  seek_p50_ms: null,
  seek_p95_ms: null,
  last_seek_ms: null,
};

function moment(index: number, score: number): ClipMoment {
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
    reasons: [],
  };
}
/** 第 40 格(20 s)最高分。 */
const moments: ClipMoment[] = Array.from({ length: 120 }, (_, index) => moment(index, index === 40 ? 0.95 : 0.2));

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
  liveStatus = { ...openedStatus };
  apiMocks.listClips.mockResolvedValue([clip, clip10]);
  apiMocks.listStoryGaps.mockResolvedValue([]);
  apiMocks.listSelectSegments.mockResolvedValue([]);
  apiMocks.playerOpen.mockImplementation(async (clipId: number) => {
    liveStatus = { ...liveStatus, clip_id: clipId, paused: false };
    return liveStatus;
  });
  apiMocks.playerStatus.mockImplementation(async () => liveStatus);
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
  await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalled());
  await flush();
  await flush();
  return screen.getByRole("region", { name: "预览监视器" });
}

const commands = () => apiMocks.playerCommand.mock.calls.map(([cmd]) => cmd as { type: string; seconds?: number });

/** 播放中的 80ms 轮询会自己读到新位置;暂停时靠点一下播放键(命令后补读)把位置带回来。 */
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

describe("R12 §5:点卡片 = 预览", () => {
  it("新素材从零自动播放,时刻分到齐也不暂停或 seek", async () => {
    await renderInPane();
    expect(commands()).not.toContainEqual({ type: "pause" });
    expect(commands()).not.toContainEqual({ type: "seek_abs", seconds: 20 });
    // 暂停在 seek 之前:先停住再挪,画面不会先跑一段。
    const types = commands().map((cmd) => cmd.type);
    expect(liveStatus).toMatchObject({ pos: 0, paused: false });
    expect(types).not.toContain("play");
    expect(screen.getByRole("button", { name: "暂停" })).toBeTruthy();
    // 空格暂停。
    const region = screen.getByRole("region", { name: "预览监视器" });
    region.focus();
    fireEvent.keyDown(region, { key: " ", code: "Space" });
    await flush();
    expect(commands().at(-1)).toEqual({ type: "pause" });
  });

  it("旧偏好关闭同样从零自动播放,不 seek", async () => {
    apiMocks.getSettings.mockResolvedValue({ "ui.player.start_at_best": "false" });
    await renderInPane();
    expect(commands()).not.toContainEqual({ type: "pause" });
    await flush();
    expect(commands().filter((cmd) => cmd.type === "seek_abs")).toEqual([]);
  });
});

describe("R12 §5:「连播」开关", () => {
  it("监视器工具条上有 AX「连播」开关,默认关;关着播完不跳下一条", async () => {
    apiMocks.getClipMoments.mockResolvedValue([]);
    setPoolOrder([9, 10]);
    await renderInPane();
    const toggle = screen.getByRole("switch", { name: "连播" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await movePlayhead(5, false);
    await movePlayhead(59.95, true);
    await flush();
    expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 9 });
  });

  it("打开「连播」写回 ui.player.auto_advance=true,播完接力到下一条;设置页开着也算", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMocks.getClipMoments.mockResolvedValue([]);
    setPoolOrder([9, 10]);
    await renderInPane();
    fireEvent.click(screen.getByRole("switch", { name: "连播" }));
    await flush();
    expect(apiMocks.setSetting).toHaveBeenCalledWith("ui.player.auto_advance", "true");
    expect(screen.getByRole("switch", { name: "连播" }).getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    await movePlayhead(5, false);
    await movePlayhead(59.95, true);
    await waitFor(() => expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 10 }));
  });

  it("设置表里 ui.player.auto_advance=true 时开关显示为开", async () => {
    apiMocks.getSettings.mockResolvedValue({ "ui.player.auto_advance": "true" });
    apiMocks.getClipMoments.mockResolvedValue([]);
    await renderInPane();
    await waitFor(() => expect(screen.getByRole("switch", { name: "连播" }).getAttribute("aria-checked")).toBe("true"));
  });
});

describe("R12 §5:原生真变速与逐帧", () => {
  beforeEach(() => apiMocks.getClipMoments.mockResolvedValue([]));

  /** 让假 mpv 认识 set_speed / 逐帧:逐帧按 25p 一帧 0.04 s 挪。 */
  function nativeMpv(): void {
    apiMocks.playerCommand.mockImplementation(async (cmd: { type: string; seconds?: number; speed?: number }) => {
      if (cmd.type === "seek_abs") liveStatus = { ...liveStatus, pos: cmd.seconds ?? 0 };
      if (cmd.type === "play") liveStatus = { ...liveStatus, paused: false };
      if (cmd.type === "pause") liveStatus = { ...liveStatus, paused: true };
      if (cmd.type === "step_fwd") liveStatus = { ...liveStatus, paused: true, pos: Math.round((liveStatus.pos + 0.04) * 1000) / 1000 };
      if (cmd.type === "step_back") liveStatus = { ...liveStatus, paused: true, pos: Math.max(0, Math.round((liveStatus.pos - 0.04) * 1000) / 1000) };
    });
  }

  it("L:暂停时 set_speed 1 + play;播放中 ×2 → ×4 → 回 ×1,只发 set_speed 不再定时 seek;K 停并回 ×1", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    nativeMpv();
    const region = await renderInPane();
    region.focus();
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await flush();
    const speed = screen.getByRole("button", { name: "播放速度" });
    expect(speed.textContent).toBe("×1");
    apiMocks.playerCommand.mockClear();
    fireEvent.keyDown(region, { key: "l", code: "KeyL" });
    await flush();
    expect(commands()).toEqual([{ type: "set_speed", speed: 1 }, { type: "play" }]);
    apiMocks.playerCommand.mockClear();
    fireEvent.keyDown(region, { key: "l", code: "KeyL" });
    await flush();
    expect(commands()).toEqual([{ type: "set_speed", speed: 2 }]);
    expect(speed.textContent).toBe("×2");
    expect(screen.getByText(/×2$/, { selector: ".monitor-marked" })).toBeTruthy();
    fireEvent.keyDown(region, { key: "l", code: "KeyL" });
    await flush();
    expect(commands().at(-1)).toEqual({ type: "set_speed", speed: 4 });
    expect(speed.textContent).toBe("×4");
    fireEvent.keyDown(region, { key: "l", code: "KeyL" });
    await flush();
    expect(commands().at(-1)).toEqual({ type: "set_speed", speed: 1 });
    expect(speed.textContent).toBe("×1");
    // 没有假走带:等一秒也没有任何 seek。
    apiMocks.playerCommand.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(commands().filter((cmd) => cmd.type === "seek_abs")).toEqual([]);
    fireEvent.keyDown(region, { key: "l", code: "KeyL" });
    await flush();
    apiMocks.playerCommand.mockClear();
    fireEvent.keyDown(region, { key: "k", code: "KeyK" });
    await flush();
    expect(commands()).toEqual([{ type: "pause" }, { type: "set_speed", speed: 1 }]);
    expect(speed.textContent).toBe("×1");
  });

  it("J 倒退:先暂停,然后按 8 fps 定时发原生 step_back,标签「倒退」;退到 0 自动停;L 结束倒退", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    nativeMpv();
    liveStatus = { ...liveStatus, pos: 0.1 };
    const region = await renderInPane();
    region.focus();
    const speed = screen.getByRole("button", { name: "播放速度" });
    apiMocks.playerCommand.mockClear();
    fireEvent.keyDown(region, { key: "j", code: "KeyJ" });
    await flush();
    expect(commands()).toEqual([{ type: "pause" }]);
    expect(speed.textContent).toBe("倒退");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REWIND_TICK_MS + 5);
    });
    expect(commands().filter((cmd) => cmd.type === "step_back").length).toBe(1);
    // 0.1 → 0.06 → 0.02 → 0:三步后到头,倒退自动停,不再发。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REWIND_TICK_MS * 4);
    });
    await waitFor(() => expect(speed.textContent).toBe("×1"));
    const steps = commands().filter((cmd) => cmd.type === "step_back").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REWIND_TICK_MS * 2);
    });
    expect(commands().filter((cmd) => cmd.type === "step_back").length).toBe(steps);
    // 片中按 J 再按 L:倒退结束、正常开播。
    liveStatus = { ...liveStatus, pos: 30 };
    fireEvent.keyDown(region, { key: "j", code: "KeyJ" });
    await flush();
    expect(speed.textContent).toBe("倒退");
    apiMocks.playerCommand.mockClear();
    fireEvent.keyDown(region, { key: "l", code: "KeyL" });
    await flush();
    expect(commands()).toEqual([{ type: "set_speed", speed: 1 }, { type: "play" }]);
    expect(speed.textContent).toBe("×1");
  });

  it("Y-10:J 倒退中走带按钮是「暂停」(不是「播放」),状态行写着「倒退」;此时按空格 / 点它 = 停下倒退(K),回到「播放」", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    nativeMpv();
    liveStatus = { ...liveStatus, pos: 30 };
    const region = await renderInPane();
    region.focus();
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await flush();
    expect(screen.getByRole("button", { name: "播放" })).toBeTruthy();
    fireEvent.keyDown(region, { key: "j", code: "KeyJ" });
    await flush();
    expect(screen.queryByRole("button", { name: "播放" })).toBeNull();
    const pause = screen.getByRole("button", { name: "暂停" });
    expect(pause.title).toContain("倒退");
    expect(screen.getByText(/· 倒退/)).toBeTruthy();
    apiMocks.playerCommand.mockClear();
    fireEvent.keyDown(region, { key: " ", code: "Space" });
    await flush();
    expect(commands()).toEqual([{ type: "pause" }, { type: "set_speed", speed: 1 }]);
    expect(screen.getByRole("button", { name: "播放" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "播放速度" }).textContent).toBe("×1");
  });

  it(", / . 发原生 step_back / step_fwd(不再按 pos ± 1/fps 算 seek);读数等逐帧落地", async () => {
    nativeMpv();
    liveStatus = { ...liveStatus, pos: 12.5 };
    const region = await renderInPane();
    region.focus();
    apiMocks.playerCommand.mockClear();
    fireEvent.keyDown(region, { key: ".", code: "Period" });
    await flush();
    expect(commands()).toEqual([{ type: "step_fwd" }]);
    await waitFor(() => expect(screen.getByLabelText("当前时间码").getAttribute("title")).toBe("00:00:12.540"));
    apiMocks.playerCommand.mockClear();
    fireEvent.keyDown(region, { key: ",", code: "Comma" });
    await flush();
    expect(commands()).toEqual([{ type: "step_back" }]);
    await waitFor(() => expect(screen.getByLabelText("当前时间码").getAttribute("title")).toBe("00:00:12.500"));
  });

  it("「×1」按钮弹速度菜单:选 ×0.5 → set_speed 0.5,暂停时顺带开播;选项 AX 名「速度 ×N」", async () => {
    nativeMpv();
    const region = await renderInPane();
    region.focus();
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await flush();
    apiMocks.playerCommand.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "播放速度" }));
    const menu = screen.getByRole("menu", { name: "播放速度" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.getAttribute("aria-label"))).toEqual(["速度 ×0.5", "速度 ×1", "速度 ×2", "速度 ×4"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "速度 ×0.5" }));
    await flush();
    expect(commands()).toEqual([{ type: "set_speed", speed: 0.5 }, { type: "play" }]);
    expect(screen.getByRole("button", { name: "播放速度" }).textContent).toBe("×0.5");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("换素材后速度回 ×1:向 mpv 补发 set_speed 1(speed 属性跨 loadfile 保留)", async () => {
    nativeMpv();
    const region = await renderInPane();
    region.focus();
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await flush();
    fireEvent.keyDown(region, { key: "l", code: "KeyL" });
    await flush();
    fireEvent.keyDown(region, { key: "l", code: "KeyL" });
    await flush();
    expect(screen.getByRole("button", { name: "播放速度" }).textContent).toBe("×2");
    apiMocks.playerCommand.mockClear();
    await act(async () => {
      dispatchWorkspace({ type: "select-clip", clipId: 10 });
    });
    await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalledWith(10));
    await waitFor(() => expect(commands()).toContainEqual({ type: "set_speed", speed: 1 }));
    expect(screen.getByRole("button", { name: "播放速度" }).textContent).toBe("×1");
  });
});
