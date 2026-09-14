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

import {
  PlayerOverlay,
  STATUS_INTERVAL_MS,
  VIEWPORT_DEBOUNCE_MS,
  frameLabel,
  shouldPollStatus,
  type EmbeddedPlayerControls,
} from "./PlayerOverlay";
import type { ClipListItem, PlayerStatus } from "./api";

const clip: ClipListItem = {
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
  duration_ticks: 10_000,
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
  pos: 10,
  duration: 60,
  paused: true,
  frame: null,
  error: null,
  seek_samples: 0,
  seek_p50_ms: null,
  seek_p95_ms: null,
  last_seek_ms: null,
};

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];

type OverlayProps = Parameters<typeof PlayerOverlay>[0];

async function mount(
  extra: Partial<OverlayProps> = {},
): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => {
    root.render(<PlayerOverlay clip={clip} onExit={() => undefined} {...extra} />);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, root };
}

/** 既有沉浸态用例的签名不变:仍然只要 container。 */
async function mountImmersive(): Promise<HTMLDivElement> {
  return (await mount()).container;
}

describe("PlayerOverlay a11y", () => {
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    };
    apiMocks.listSelectSegments.mockResolvedValue([]);
    apiMocks.playerOpen.mockResolvedValue(readyStatus);
    apiMocks.playerStatus.mockResolvedValue(readyStatus);
    apiMocks.playerClose.mockResolvedValue(undefined);
    apiMocks.playerSetViewport.mockResolvedValue(undefined);
    apiMocks.playerCommand.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    while (mounted.length > 0) {
      const current = mounted.pop();
      if (!current) continue;
      await act(async () => current.root.unmount());
      current.container.remove();
    }
    vi.clearAllMocks();
  });

  it("renders the progress bar as a slider with value bounds", async () => {
    const container = await mountImmersive();
    const slider = container.querySelector('[role="slider"]');
    expect(slider).not.toBeNull();
    expect(slider?.getAttribute("aria-label")).toBe("播放进度");
    expect(slider?.getAttribute("aria-valuemin")).toBe("0");
    expect(slider?.getAttribute("aria-valuemax")).toBe("60");
    expect(slider?.getAttribute("aria-valuenow")).toBe("10");
    expect(slider?.getAttribute("tabindex")).toBe("0");
  });

  it("does not let Tab escape the modal", async () => {
    const container = await mountImmersive();
    const overlay = container.querySelector('[role="dialog"]') as HTMLElement;
    const focusable = Array.from(
      overlay.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex='0']"),
    );
    expect(focusable.length).toBeGreaterThan(1);
    const last = focusable[focusable.length - 1];
    act(() => last.focus());
    expect(document.activeElement).toBe(last);

    act(() => {
      overlay.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });

    expect(document.activeElement).toBe(focusable[0]);
  });

  it("wraps backwards with Shift+Tab from the first focusable element", async () => {
    const container = await mountImmersive();
    const overlay = container.querySelector('[role="dialog"]') as HTMLElement;
    const focusable = Array.from(
      overlay.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex='0']"),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    act(() => first.focus());

    act(() => {
      overlay.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
      );
    });

    expect(document.activeElement).toBe(last);
  });

  it("seeks by 1s on ArrowRight when the slider itself has focus", async () => {
    const container = await mountImmersive();
    const slider = container.querySelector('[role="slider"]') as HTMLElement;
    act(() => slider.focus());
    expect(document.activeElement).toBe(slider);

    await act(async () => {
      // 键盘处理挂在 slider 自身的 onKeyDown 上(满足 jsx-a11y/click-events-have-key-events),
      // 与真实浏览器一致地从焦点元素派发,而不是直接扔到 window 上。
      slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight", bubbles: true }));
      await Promise.resolve();
    });

    expect(apiMocks.playerCommand).toHaveBeenCalledWith({ type: "seek_abs", seconds: 11 });
  });

  it("keeps the existing global frame-step binding when focus is elsewhere", async () => {
    await mountImmersive();
    expect(document.activeElement?.getAttribute("role")).not.toBe("slider");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight", bubbles: true }));
      await Promise.resolve();
    });

    expect(apiMocks.playerCommand).toHaveBeenCalledWith({ type: "step_fwd" });
  });
});

describe("PlayerOverlay 嵌入模式", () => {
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    };
    apiMocks.listSelectSegments.mockResolvedValue([]);
    apiMocks.playerOpen.mockResolvedValue(readyStatus);
    apiMocks.playerStatus.mockResolvedValue(readyStatus);
    apiMocks.playerClose.mockResolvedValue(undefined);
    apiMocks.playerSetViewport.mockResolvedValue(undefined);
    apiMocks.playerCommand.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    while (mounted.length > 0) {
      const current = mounted.pop();
      if (!current) continue;
      await act(async () => current.root.unmount());
      current.container.remove();
    }
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  /** jsdom 的 getBoundingClientRect 恒为 0,viewport 会被 rectToPlayerViewport 判无效。 */
  function stubPaneRect(rect: { left: number; top: number; width: number; height: number }): void {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          right: rect.left + rect.width,
          bottom: rect.top + rect.height,
          x: rect.left,
          y: rect.top,
          toJSON: () => undefined,
        }) as DOMRect,
    );
  }

  async function settle(ms: number): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  it("嵌入模式不抢焦点(不装 focus trap)", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    await mount({ variant: "embedded" });
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("嵌入模式不是模态,沉浸模式仍是 role=dialog", async () => {
    const { container } = await mount({ variant: "embedded" });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector(".player-native-slot")).not.toBeNull();
  });

  it("嵌入模式把区域矩形传给 playerSetViewport,而不是整窗", async () => {
    stubPaneRect({ left: 320, top: 96, width: 700, height: 400 });
    await mount({ variant: "embedded" });
    expect(apiMocks.playerSetViewport).toHaveBeenCalled();
    const viewport = apiMocks.playerSetViewport.mock.lastCall?.[0] as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    expect(viewport.width).toBeLessThan(window.innerWidth);
    expect(viewport.x).toBeGreaterThan(0);
    expect(viewport).toEqual({ x: 320, y: 96, width: 700, height: 400 });
  });

  it("连续尺寸变化在 120ms 内只发一次 set_viewport", async () => {
    stubPaneRect({ left: 320, top: 96, width: 700, height: 400 });
    await mount({ variant: "embedded" });
    apiMocks.playerSetViewport.mockClear();
    await act(async () => {
      for (let index = 0; index < 10; index += 1) {
        window.dispatchEvent(new Event("resize"));
      }
    });
    expect(apiMocks.playerSetViewport).not.toHaveBeenCalled();
    await settle(VIEWPORT_DEBOUNCE_MS + 80);
    expect(apiMocks.playerSetViewport).toHaveBeenCalledTimes(1);
  });

  it("换素材走 playerOpen,不 playerClose 重建实例", async () => {
    const { root } = await mount({ variant: "embedded" });
    apiMocks.playerClose.mockClear();
    const clipB: ClipListItem = { ...clip, id: 11, file_name: "clip-11.mov" };
    await act(async () => {
      root.render(<PlayerOverlay clip={clipB} variant="embedded" onExit={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMocks.playerOpen).toHaveBeenCalledWith(11);
    expect(apiMocks.playerClose).not.toHaveBeenCalled();
  });

  it("暂停时 80ms 状态轮询停表,播放中继续走表", async () => {
    expect(shouldPollStatus(readyStatus, true)).toBe(false);
    expect(shouldPollStatus(readyStatus, false)).toBe(false);
    expect(shouldPollStatus({ ...readyStatus, paused: false }, false)).toBe(true);
    // 还没 ready 时必须继续轮询,否则「正在建立链路」永远不会翻页。
    expect(shouldPollStatus({ ...readyStatus, phase: "loading" }, false)).toBe(true);
    expect(shouldPollStatus(null, false)).toBe(true);

    stubPaneRect({ left: 320, top: 96, width: 700, height: 400 });
    await mount({ variant: "embedded" });
    apiMocks.playerStatus.mockClear();
    await settle(STATUS_INTERVAL_MS * 5);
    expect(apiMocks.playerStatus).not.toHaveBeenCalled();
  });

  it("嵌入模式 ⌘⏎ 请求全屏沉浸,Esc 不退出(退出由监视器接管)", async () => {
    const onRequestImmersive = vi.fn();
    const onExit = vi.fn();
    await mount({ variant: "embedded", onRequestImmersive, onExit });
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", metaKey: true, bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(onRequestImmersive).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    expect(onExit).not.toHaveBeenCalled();
  });

  it("嵌入模式把状态与命令通道交给宿主(监视器用它画控件条)", async () => {
    const onStatusChange = vi.fn();
    const controlsRef: { current: EmbeddedPlayerControls | null } = { current: null };
    await mount({ variant: "embedded", onStatusChange, controlsRef });
    expect(onStatusChange).toHaveBeenCalledWith(readyStatus);
    expect(controlsRef.current).not.toBeNull();
    await act(async () => {
      await controlsRef.current?.send([{ type: "play" }]);
    });
    expect(apiMocks.playerCommand).toHaveBeenCalledWith({ type: "play" });
  });
});

describe("frameLabel(Z-17 帧号跟时间码同源)", () => {
  it("由位置 × 帧率算,不依赖 mpv 的估算帧号", () => {
    expect(frameLabel({ pos: 2.2, phase: "ready" }, 30)).toBe("第 66 帧");
    expect(frameLabel({ pos: 2.2, phase: "ready" }, 0)).toBe("第 66 帧");
    expect(frameLabel({ pos: 0, phase: "ready" }, 24)).toBe("第 0 帧");
  });
  it("没就绪就不显示", () => {
    expect(frameLabel(null, 30)).toBe("");
    expect(frameLabel({ pos: 3, phase: "loading" }, 30)).toBe("");
  });
});
