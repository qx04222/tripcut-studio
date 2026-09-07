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

import { PlayerOverlay } from "./PlayerOverlay";
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

async function mount(): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => {
    root.render(<PlayerOverlay clip={clip} onExit={() => undefined} />);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
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
    const container = await mount();
    const slider = container.querySelector('[role="slider"]');
    expect(slider).not.toBeNull();
    expect(slider?.getAttribute("aria-label")).toBe("播放进度");
    expect(slider?.getAttribute("aria-valuemin")).toBe("0");
    expect(slider?.getAttribute("aria-valuemax")).toBe("60");
    expect(slider?.getAttribute("aria-valuenow")).toBe("10");
    expect(slider?.getAttribute("tabindex")).toBe("0");
  });

  it("does not let Tab escape the modal", async () => {
    const container = await mount();
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
    const container = await mount();
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
    const container = await mount();
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
    await mount();
    expect(document.activeElement?.getAttribute("role")).not.toBe("slider");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight", bubbles: true }));
      await Promise.resolve();
    });

    expect(apiMocks.playerCommand).toHaveBeenCalledWith({ type: "step_fwd" });
  });
});
