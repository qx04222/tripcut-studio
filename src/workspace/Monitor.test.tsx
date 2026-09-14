import { createTestApiMock } from "./testApiMock";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClipListItem, PlayerStatus, StoryGap } from "../api";

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

const gap: StoryGap = {
  id: 4,
  chapter_id: 3,
  chapter_title: "第一章 出发",
  beat_id: null,
  slot: "REAL/ESTABLISHING",
  slot_label_zh: "确立镜头",
  reason: "这一章还没有交代地点的确立镜头",
  status: "open",
  latest_request: null,
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

import { Monitor, __setEmbeddedPlaybackForTests, slotPlaceholderCopy } from "./Monitor";

/** pool-monitor.css 是 @import 桶,把它引的分文件也读进来,断言打在真实规则上。 */
function readCssWithImports(file: string): string {
  const text = readFileSync(file, "utf8");
  return text.replace(/^@import\s+"(\.\/[^"]+)";$/gm, (_, rel: string) =>
    readCssWithImports(resolve(file, "..", rel)),
  );
}
const POOL_MONITOR_CSS = readCssWithImports(resolve(process.cwd(), "src/styles/workspace/pool-monitor.css"));
import { __resetModalStackForTests, popModal, popOccluder, pushModal, pushOccluder } from "./modalStack";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";

beforeEach(() => {
  __resetWorkspaceForTests();
  __resetModalStackForTests();
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  };
  apiMocks.listClips.mockResolvedValue([clip]);
  apiMocks.listStoryGaps.mockResolvedValue([gap]);
  apiMocks.listSelectSegments.mockResolvedValue([]);
  apiMocks.createSelectSegment.mockResolvedValue({
    id: 1,
    clip_id: 9,
    in_ticks: 0,
    out_ticks: 1,
    tb_num: 1,
    tb_den: 1_000,
  });
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
  vi.restoreAllMocks();
  __setEmbeddedPlaybackForTests(true);
});

/** 等一轮微任务:Monitor 的 listClips / playerOpen 都是 effect 里的 promise。 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("slotPlaceholderCopy", () => {
  it("空槽位显示章节标题 + 槽位名,以及缺口原因", () => {
    expect(slotPlaceholderCopy(gap)).toEqual({
      title: "第一章 出发 · 确立镜头",
      reason: "这一章还没有交代地点的确立镜头",
    });
  });
});

describe("Monitor", () => {
  it("空选中时显示中性占位与中文引导,不开播放器", async () => {
    render(<Monitor />);
    await flush();
    expect(screen.getByText("从左侧媒体池选一条素材")).toBeTruthy();
    expect(apiMocks.playerOpen).not.toHaveBeenCalled();
  });

  it("选中空槽位时显示章节标题与缺口原因,不打开播放器", async () => {
    __resetWorkspaceForTests({
      selection: { kind: "slot", chapterId: 3, slot: "REAL/ESTABLISHING" },
    });
    render(<Monitor />);
    expect(await screen.findByText(/第一章/)).toBeTruthy();
    expect(screen.getByText(/这一章还没有交代地点的确立镜头/)).toBeTruthy();
    expect(apiMocks.playerOpen).not.toHaveBeenCalled();
  });

  it("选中素材时开同一个 mpv 实例,控件条齐全且全中文", async () => {
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 } });
    render(<Monitor />);
    await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalledWith(9));
    for (const name of ["播放", "后退一秒", "前进一秒", "入点", "出点", "保存片段", "全屏沉浸"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("时间码:传输条显示短格式(U-10),精确的 formatTimecode 值留在 title,格式不变", async () => {
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 } });
    render(<Monitor />);
    await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalled());
    await flush();
    expect(screen.getByLabelText("当前时间码").textContent).toBe("00:12.5");
    expect(screen.getByLabelText("当前时间码").getAttribute("title")).toBe("00:00:12.500");
  });

  it("播到尾后再按播放:先 seek 到 0 再 play(U-09)", async () => {
    const ended = { ...readyStatus, pos: 60, duration: 60, paused: true };
    apiMocks.playerOpen.mockResolvedValue(ended);
    apiMocks.playerStatus.mockResolvedValue(ended);
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 } });
    render(<Monitor />);
    await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalled());
    await flush();
    // R12 §5:素材一就绪监视器先发一条 pause(点卡片 = 预览),不算这次点击的输出。
    apiMocks.playerCommand.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "播放" }));
    });
    expect(apiMocks.playerCommand.mock.calls.map(([cmd]) => cmd)).toEqual([
      { type: "seek_abs", seconds: 0 },
      { type: "play" },
    ]);
  });

  it("拖滑杆经宿主通道发 seek_abs,不另开播放器(U-09)", async () => {
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 } });
    render(<Monitor />);
    await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalled());
    await flush();
    await act(async () => {
      fireEvent.change(screen.getByRole("slider", { name: "播放位置" }), { target: { value: "30" } });
    });
    expect(apiMocks.playerCommand).toHaveBeenCalledWith({ type: "seek_abs", seconds: 30 }, expect.anything());
    expect(apiMocks.playerOpen).toHaveBeenCalledTimes(1);
  });

  it("window 事件 tripcut:toggle-playback 走同一个播放/暂停处理器(播完则从头)", async () => {
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 } });
    render(<Monitor />);
    await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalled());
    await flush();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("tripcut:toggle-playback"));
    });
    expect(apiMocks.playerCommand).toHaveBeenCalledWith({ type: "play" }, expect.anything());
    // 状态翻成播放中后再来一次 → pause。
    apiMocks.playerStatus.mockResolvedValue({ ...readyStatus, paused: false });
    await act(async () => {
      window.dispatchEvent(new CustomEvent("tripcut:toggle-playback"));
    });
    await flush();
    apiMocks.playerCommand.mockClear();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("tripcut:toggle-playback"));
    });
    expect(apiMocks.playerCommand).toHaveBeenCalledWith({ type: "pause" }, expect.anything());
    // 播到尾:先 seek 0 再 play。
    apiMocks.playerStatus.mockResolvedValue({ ...readyStatus, pos: 60, duration: 60, paused: true });
    await act(async () => {
      window.dispatchEvent(new CustomEvent("tripcut:toggle-playback"));
    });
    await flush();
    apiMocks.playerCommand.mockClear();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("tripcut:toggle-playback"));
    });
    expect(apiMocks.playerCommand.mock.calls.map(([cmd]) => cmd)).toEqual([
      { type: "seek_abs", seconds: 0 },
      { type: "play" },
    ]);
  });

  it("window 事件 tripcut:seek-ratio({ratio}) 按总时长换算成 seek_abs;坏 detail 忽略", async () => {
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 } });
    render(<Monitor />);
    await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalled());
    await flush();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("tripcut:seek-ratio", { detail: { ratio: 0.5 } }));
    });
    expect(apiMocks.playerCommand).toHaveBeenCalledWith({ type: "seek_abs", seconds: 30 }, expect.anything());
    apiMocks.playerCommand.mockClear();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("tripcut:seek-ratio", { detail: { ratio: "x" } }));
      window.dispatchEvent(new CustomEvent("tripcut:seek-ratio"));
    });
    expect(apiMocks.playerCommand).not.toHaveBeenCalled();
  });

  it("井底铺一层封面:原生视图被遮挡或还没画时不是整块黑(U-09)", async () => {
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 } });
    render(<Monitor />);
    await screen.findByRole("button", { name: "播放" });
    const backdrop = document.querySelector(".monitor-well--video > img.monitor-well-backdrop") as HTMLImageElement;
    expect(backdrop).not.toBeNull();
    expect(backdrop.getAttribute("src")).toBe("/covers/9.jpg");
    // 封面在画面节点之下:DOM 顺序在前,画面节点仍是 viewport 代码盯的那一个。
    expect(backdrop.nextElementSibling?.querySelector(".player-native-slot")).not.toBeNull();
  });

  it("播放按钮发 play,并走宿主交出的命令通道(不另起一个播放器)", async () => {
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 } });
    render(<Monitor />);
    await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalled());
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "播放" }));
    });
    expect(apiMocks.playerCommand).toHaveBeenCalledWith({ type: "play" }, expect.anything());
    expect(apiMocks.playerOpen).toHaveBeenCalledTimes(1);
  });

  it("I→O→S 保存片段调 createSelectSegment 一次", async () => {
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 } });
    render(<Monitor />);
    await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalled());
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "入点" }));
    });
    // 「前进一秒」= seek 到 13.5;假播放器跟着落地(V-04 之后出点按 seek 目标打,不按旧读数)。
    apiMocks.playerStatus.mockResolvedValue({ ...readyStatus, pos: 13.5 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "前进一秒" }));
    });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "出点" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存片段" }));
    });
    await flush();
    expect(apiMocks.createSelectSegment).toHaveBeenCalledTimes(1);
    expect(apiMocks.createSelectSegment).toHaveBeenCalledWith(9, 12.5, 13.5);
  });

  it("出点不晚于入点时拒绝保存,并给中文说明", async () => {
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 } });
    render(<Monitor />);
    await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalled());
    await flush();
    // 一次 act 里连点三下会把三个 setState 批到一起,保存的闭包还看着 null ——
    // 分三次提交,和真人依次点是同一回事。
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "入点" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "出点" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存片段" }));
    });
    expect(apiMocks.createSelectSegment).not.toHaveBeenCalled();
    expect(screen.getByText("出点必须晚于入点")).toBeTruthy();
  });

  it("⌘⏎ 进全屏沉浸,Esc 退出后仍是同一条素材", async () => {
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 } });
    render(<Monitor />);
    await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalled());
    await flush();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", metaKey: true, bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(getWorkspaceSnapshot().immersive).toBe(true);
    await flush();
    expect(screen.getByRole("dialog")).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(getWorkspaceSnapshot().immersive).toBe(false);
    expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 9 });
    await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenLastCalledWith(9));
  });

  it("素材还没载进来时给中文过渡文案,不喂 playerOpen 一个空 id", async () => {
    apiMocks.listClips.mockResolvedValue([]);
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 } });
    render(<Monitor />);
    await flush();
    expect(screen.getByText("素材载入中")).toBeTruthy();
    expect(apiMocks.playerOpen).not.toHaveBeenCalled();
  });

  it("井是 16:9、深底(--well-bg)、内阴影;文件名 chip 与规格 chip 在井内", async () => {
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 } });
    render(<Monitor />);
    await screen.findByRole("button", { name: "播放" });
    const well = document.querySelector(".monitor-well")!;
    expect(well.className).toContain("monitor-well--video");
    expect(POOL_MONITOR_CSS).toMatch(/\.monitor-well\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/);
    expect(POOL_MONITOR_CSS).toMatch(/\.monitor-well\s*\{[^}]*var\(--well-bg\)/);
    expect(POOL_MONITOR_CSS).toMatch(/\.monitor-well\s*\{[^}]*var\(--shadow-inset-well\)/);
    expect(well.querySelector(".monitor-well-name")!.className).toContain("ui-chip");
    expect(well.querySelector(".monitor-well-name")!.textContent).toBe("clip-9.mov");
    expect(well.querySelector(".monitor-well-spec")!.textContent).toBe("1080p · 30p · 2.0 KB");
    // mpv 的画面节点还是 PlayerOverlay 的 .player-native-slot,viewport 代码盯的就是它。
    expect(well.querySelector(".player-native-slot")).not.toBeNull();
  });

  it("控件条是套件 Toolbar,走带按钮全是图标按钮且 AX 名不变", async () => {
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 } });
    render(<Monitor />);
    await screen.findByRole("button", { name: "播放" });
    for (const name of ["播放", "后退一秒", "前进一秒", "静音", "入点", "出点", "全屏沉浸"]) {
      const button = screen.getByRole("button", { name });
      expect(button.querySelector("svg"), name).not.toBeNull();
      expect(button.textContent?.replace(/\s/g, "")).not.toMatch(/[▶❚🔇🔊]/u);
    }
    expect(screen.getByRole("button", { name: "保存片段" }).className).toContain("ui-button--primary");
    expect(document.querySelector(".ui-toolbar.ui-toolbar--framed")).not.toBeNull();
    expect(screen.getByRole("toolbar", { name: "走带与打点" })).toBeTruthy();
  });

  it("空选中的占位是深底 EmptyState,井仍是 16:9", async () => {
    render(<Monitor />);
    await flush();
    const empty = document.querySelector(".monitor-well .ui-empty");
    expect(empty).not.toBeNull();
    expect(empty!.className).toContain("ui-empty--dark");
  });

  it("退化开关关闭时只显示封面 + 点击进沉浸,不开嵌入播放器,点击后进沉浸", async () => {
    __setEmbeddedPlaybackForTests(false);
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 } });
    render(<Monitor />);
    await flush();

    expect(screen.getByText("点击进入全屏沉浸 ⌘⏎")).toBeTruthy();
    const cover = screen.getByRole("button", { name: /点击进入全屏沉浸/ });
    expect(cover.querySelector("img")).not.toBeNull();
    expect(apiMocks.playerOpen).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(cover);
    });
    expect(getWorkspaceSnapshot().immersive).toBe(true);
    await flush();
    await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalledWith(9));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("覆盖层入栈时藏起原生视频视图,栈清空后恢复并重提交区域矩形(R9 D1)", async () => {
    // jsdom 的 getBoundingClientRect 恒为 0,矩形会被 rectToPlayerViewport 判无效。
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ left: 10, top: 20, width: 640, height: 360, right: 650, bottom: 380, x: 10, y: 20, toJSON: () => undefined }) as DOMRect,
    );
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 } });
    render(<Monitor />);
    await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalledWith(9));
    // 挂载时先把旗标同步成 false(栈是空的),之后没有变化就不再打后端。
    expect(apiMocks.playerSetOccluded).toHaveBeenLastCalledWith(false);
    apiMocks.playerSetOccluded.mockClear();
    apiMocks.playerSetViewport.mockClear();

    const popover = {};
    const drawer = {};
    await act(async () => {
      pushModal(popover);
      await Promise.resolve();
    });
    expect(apiMocks.playerSetOccluded).toHaveBeenCalledTimes(1);
    expect(apiMocks.playerSetOccluded).toHaveBeenCalledWith(true);

    // 第二层压上来:仍然是遮挡,不重复发。
    await act(async () => {
      pushModal(drawer);
      popModal(drawer);
      await Promise.resolve();
    });
    expect(apiMocks.playerSetOccluded).toHaveBeenCalledTimes(1);

    await act(async () => {
      popModal(popover);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMocks.playerSetOccluded).toHaveBeenCalledTimes(2);
    expect(apiMocks.playerSetOccluded).toHaveBeenLastCalledWith(false);
    // 解除遮挡后区域矩形重提交一次,原生视图与 DOM 井重新对齐。
    await waitFor(() => expect(apiMocks.playerSetViewport).toHaveBeenCalled());
  });

  it("Y-01/Y-02:首页 / 引导气泡这类非模态遮挡者也让原生视频视图让位,撤掉后恢复", async () => {
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 } });
    render(<Monitor />);
    await waitFor(() => expect(apiMocks.playerSetOccluded).toHaveBeenLastCalledWith(false));
    apiMocks.playerSetOccluded.mockClear();
    const home = {};
    await act(async () => {
      pushOccluder(home);
      await Promise.resolve();
    });
    expect(apiMocks.playerSetOccluded).toHaveBeenCalledTimes(1);
    expect(apiMocks.playerSetOccluded).toHaveBeenCalledWith(true);
    await act(async () => {
      popOccluder(home);
      await Promise.resolve();
    });
    expect(apiMocks.playerSetOccluded).toHaveBeenLastCalledWith(false);
  });

  it("沉浸态不进模态栈,帮助层压上来时同样遮挡(不破坏沉浸)", async () => {
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 }, immersive: true });
    render(<Monitor />);
    await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalledWith(9));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(apiMocks.playerSetOccluded).toHaveBeenLastCalledWith(false);
    const help = {};
    await act(async () => {
      pushModal(help);
      await Promise.resolve();
    });
    expect(apiMocks.playerSetOccluded).toHaveBeenLastCalledWith(true);
    await act(async () => {
      popModal(help);
      await Promise.resolve();
    });
    expect(apiMocks.playerSetOccluded).toHaveBeenLastCalledWith(false);
  });

  it("井同时装进舞台的宽和高:按「栏 − 标题条 − 控件条」算,舞台变矮时井按高定宽并重提交(R9 D5)", async () => {
    // jsdom 没有 ResizeObserver,也量不出尺寸:用假观察者拿到回调,用属性桩给尺寸。
    // 栏根 447 = 标题条 32 + 舞台 369 + 控件条 46(真机旅程页签的 AX 数);舞台 padding 12/16。
    const observers: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    });
    const pane = { width: 1060, height: 447 };
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("monitor-stage") ? pane.width : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      // 舞台自己报一个被井撑大的高:量它就会自己量自己(真机复核二的坑),必须量栏根。
      if (this.classList.contains("monitor")) return pane.height;
      return this.classList.contains("monitor-stage") ? 900 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("workspace-pane-chrome")) return 32;
      if (this.classList.contains("monitor-controls")) return 46;
      return 0;
    });
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      () => ({ paddingTop: "12px", paddingBottom: "12px", paddingLeft: "16px", paddingRight: "16px" }) as CSSStyleDeclaration,
    );
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ left: 10, top: 20, width: 640, height: 360, right: 650, bottom: 380, x: 10, y: 20, toJSON: () => undefined }) as DOMRect,
    );
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 } });
    const { rerender } = render(<Monitor />);
    await waitFor(() => expect(apiMocks.playerOpen).toHaveBeenCalledWith(9));
    const well = document.querySelector<HTMLElement>(".monitor-stage > .monitor-well")!;
    // 舞台内容盒 = 447 − 32 − 46 − 24 = 345 高、1028 宽 → 按高定宽 613×345,井不高于舞台。
    expect(well.style.width).toBe("613px");
    expect(well.style.height).toBe("345px");

    // 真机 P0-A 回归:重渲染(状态轮询每 80ms 一次)不许重建观察者、不许重发提交。
    const observersBefore = observers.length;
    await waitFor(() => expect(apiMocks.playerSetViewport).toHaveBeenCalled());
    apiMocks.playerSetViewport.mockClear();
    await act(async () => {
      rerender(<Monitor />);
      rerender(<Monitor />);
      for (const callback of observers) callback(); // 尺寸没变的 resize 通知
      await Promise.resolve();
    });
    expect(observers.length).toBe(observersBefore);
    expect(apiMocks.playerSetViewport).not.toHaveBeenCalled();

    pane.height = 300;
    await act(async () => {
      for (const callback of observers) callback();
      await Promise.resolve();
    });
    // 300 − 32 − 46 − 24 = 198 → 352×198。
    expect(well.style.width).toBe("352px");
    expect(well.style.height).toBe("198px");
    // 栏一变,原生视图的区域矩形跟着重提交(不只在画面元素自身 resize 时)。
    await waitFor(() => expect(apiMocks.playerSetViewport).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });
});
