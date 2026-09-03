// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlayerOverlay, formatTimecode, waitForLayout } from "./PlayerOverlay";
import { FirstRunGuide } from "./FirstRunGuide";
import { SettingsPage, llmLedgerPurposeLabel } from "./SettingsPage";
import { StoryboardView } from "./Storyboard";
import type { ClipListItem, LlmLedgerEntry, PlayerStatus, Storyboard } from "./api";

const apiMocks = vi.hoisted(() => ({
  clearCacheAndRebuild: vi.fn(),
  createSelectSegment: vi.fn(),
  enqueueNarrateEpisode: vi.fn(),
  getAppInfo: vi.fn(),
  getLlmStatus: vi.fn(),
  getNarrativeRevision: vi.fn(async () => null),
  getSettings: vi.fn(),
  getSettingsStatus: vi.fn(),
  getStoryboard: vi.fn(),
  listLlmLedger: vi.fn(),
  listSelectSegments: vi.fn(),
  listShotStacks: vi.fn(),
  listDeviceClocks: vi.fn(),
  setDeviceClockOffset: vi.fn(),
  mergeChapters: vi.fn(),
  playerClose: vi.fn(),
  playerCommand: vi.fn(),
  playerOpen: vi.fn(),
  playerSetViewport: vi.fn(),
  playerStatus: vi.fn(),
  renameChapter: vi.fn(),
  runClipSelfCheck: vi.fn(),
  setSetting: vi.fn(),
  setDestinationCardVerified: vi.fn(),
  setStoryOrder: vi.fn(),
  setShotStackUserState: vi.fn(),
  undoStoryChange: vi.fn(),
  updateDestinationCard: vi.fn(),
}));

vi.mock("./api", () => apiMocks);

const readyStatus: PlayerStatus = {
  phase: "ready",
  clip_id: 1,
  pos: 12.5,
  duration: 60,
  paused: true,
  frame: 128,
  error: null,
  seek_samples: 9,
  seek_p50_ms: 3.2,
  seek_p95_ms: 8.4,
  last_seek_ms: 4.1,
};

const clip: ClipListItem = {
  id: 1,
  episode_id: 1,
    folder_label: null,
  cover_url: null,
  path: "/Volumes/CARD/DCIM/clip.mov",
  file_name: "clip.mov",
  byte_size: 1_024,
  quick_hash: "quick-1",
  full_hash: null,
  tb_num: 1,
  tb_den: 90_000,
  duration_ticks: 5_400_000,
  fps_num: 30_000,
  fps_den: 1_001,
  is_vfr: false,
  codec: "h264",
  width: 1_920,
  height: 1_080,
  captured_at: "2026-09-01T12:00:00Z",
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

const board: Storyboard = {
  chapters: [
    { id: 1, title: "上午", start_at: "09:00", end_at: "09:30", clip_count: 0 },
  ],
  items: [],
  candidates: [],
  can_undo: false,
  mode: "legacy",
  mode_notice: "L3 增强已关闭：故事板明确回退到 D2 本地章节。",
  narrative: null,
  narration_job_status: null,
};

const ledgerStatuses: LlmLedgerEntry["status"][] = [
  "running",
  "succeeded",
  "failed",
  "parse_failed",
];

interface MountedComponent {
  container: HTMLDivElement;
  root: Root;
}

const mounted: MountedComponent[] = [];

async function mount(element: ReactElement): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => {
    root.render(element);
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  };
  apiMocks.getSettings.mockResolvedValue({});
  apiMocks.getSettingsStatus.mockResolvedValue(null);
  apiMocks.getAppInfo.mockResolvedValue(null);
  apiMocks.getLlmStatus.mockResolvedValue({
    enabled: true,
    provider: "auto",
    monthly_budget: 200,
    calls_this_month: 4,
    remaining_calls: 196,
    budget_exhausted: false,
    providers: [],
  });
  apiMocks.listLlmLedger.mockResolvedValue([]);
  apiMocks.getStoryboard.mockResolvedValue(board);
  apiMocks.listShotStacks.mockResolvedValue([]);
  apiMocks.listDeviceClocks.mockResolvedValue([]);
  apiMocks.setDeviceClockOffset.mockResolvedValue(undefined);
  apiMocks.listSelectSegments.mockResolvedValue([]);
  apiMocks.playerOpen.mockResolvedValue(readyStatus);
  apiMocks.playerStatus.mockResolvedValue(readyStatus);
  apiMocks.playerClose.mockResolvedValue(undefined);
  apiMocks.playerSetViewport.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  while (mounted.length > 0) {
    const current = mounted.pop();
    if (!current) continue;
    await act(async () => current.root.unmount());
    current.container.remove();
  }
});

describe("R1 lane C frontend release fixes", () => {
  it("does not leave player startup pending when requestAnimationFrame is suspended", async () => {
    vi.useFakeTimers();
    window.requestAnimationFrame = () => 1;

    let resolved = false;
    const waiting = waitForLayout().then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(99);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(resolved).toBe(true);
  });

  it("does not let Escape leave the player while an IME composition is active", async () => {
    const onExit = vi.fn();
    const container = await mount(<PlayerOverlay clip={clip} onExit={onExit} />);
    const overlay = container.querySelector<HTMLElement>(".player-overlay");
    expect(overlay).not.toBeNull();

    act(() => {
      overlay?.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(apiMocks.playerClose).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();

    await act(async () => {
      overlay?.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });

    expect(onExit).toHaveBeenCalledOnce();
  });

  it("keeps the chapter title focused on Enter until the composition lifecycle ends", async () => {
    const container = await mount(<StoryboardView />);
    const title = container.querySelector<HTMLInputElement>(".story-chapter input");
    expect(title).not.toBeNull();
    title?.focus();

    act(() => {
      title?.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      title?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(document.activeElement).toBe(title);

    act(() => {
      title?.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      title?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(document.activeElement).not.toBe(title);
  });

  it("renders every LLM ledger status in Chinese", async () => {
    apiMocks.listLlmLedger.mockResolvedValue(
      ledgerStatuses.map((status, index) => ({
        id: index + 1,
        called_at: "2026-09-01T12:00:00Z",
        provider: "codex",
        purpose: "ai_description",
        estimated_tokens: 10,
        status,
        error_summary: null,
      })),
    );

    const container = await mount(<SettingsPage />);

    for (const label of ["调用中", "已成功", "调用失败", "解析失败"]) {
      expect(container.textContent).toContain(label);
    }
    for (const rawStatus of ledgerStatuses) {
      expect(container.textContent).not.toContain(rawStatus);
    }
  });

  it("labels narration ledger entries explicitly and preserves unknown purposes", () => {
    expect(llmLedgerPurposeLabel("ai_description")).toBe("AI 描述");
    expect(llmLedgerPurposeLabel("director_qa")).toBe("导演问答");
    expect(llmLedgerPurposeLabel("narrate_episode")).toBe("叙事编排");
    expect(llmLedgerPurposeLabel("future_purpose")).toBe("future_purpose");
  });

  it("formats the player readout as elapsed time instead of approximate SMPTE frames", () => {
    expect(formatTimecode(59.999, 29.97)).toBe("00:00:59.999");
    expect(formatTimecode(60, 29.97)).toBe("00:01:00.000");
  });

  it("rolls an optimistic theme change back when persistence fails", async () => {
    apiMocks.getSettings.mockResolvedValueOnce({ "appearance.theme": "system" });
    apiMocks.setSetting.mockRejectedValueOnce(new Error("database is read-only"));
    const container = await mount(<SettingsPage />);
    const dark = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "深色");

    await act(async () => {
      dark?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dark?.getAttribute("aria-pressed")).toBe("false");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(container.textContent).toContain("保存失败");
  });

  it("rolls consecutive failed optimistic saves back to the last persisted value", async () => {
    apiMocks.getSettings.mockResolvedValueOnce({ "appearance.theme": "system" });
    apiMocks.setSetting
      .mockRejectedValueOnce(new Error("first write failed"))
      .mockRejectedValueOnce(new Error("second write failed"));
    const container = await mount(<SettingsPage />);
    const button = (label: string) => Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent === label);

    await act(async () => {
      button("深色")?.click();
      button("浅色")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(button("跟随系统")?.getAttribute("aria-pressed")).toBe("true");
    expect(button("深色")?.getAttribute("aria-pressed")).toBe("false");
    expect(button("浅色")?.getAttribute("aria-pressed")).toBe("false");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("rolls a failed save back to the preceding successful value", async () => {
    apiMocks.getSettings.mockResolvedValueOnce({ "appearance.theme": "system" });
    apiMocks.setSetting
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second write failed"));
    const container = await mount(<SettingsPage />);
    const button = (label: string) => Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent === label);

    await act(async () => {
      button("深色")?.click();
      await Promise.resolve();
      await Promise.resolve();
      button("浅色")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(button("深色")?.getAttribute("aria-pressed")).toBe("true");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("keeps real settings editable when an optional status request fails", async () => {
    apiMocks.getSettings.mockResolvedValueOnce({ "appearance.theme": "dark" });
    apiMocks.getLlmStatus.mockRejectedValueOnce(new Error("provider status unavailable"));
    const container = await mount(<SettingsPage />);
    const dark = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "深色");

    expect(dark?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".settings-content")?.hasAttribute("inert")).toBe(false);
    expect(container.textContent).toContain("核心设置已载入；1 项状态暂时不可用");
  });

  it("previews Best Take range changes locally and persists only on commit", async () => {
    apiMocks.setSetting.mockResolvedValue(undefined);
    const container = await mount(<SettingsPage />);
    const range = container.querySelector<HTMLInputElement>('input[aria-label="Technical"]');
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

    act(() => {
      valueSetter?.call(range, "0.41");
      range?.dispatchEvent(new Event("input", { bubbles: true }));
      valueSetter?.call(range, "0.42");
      range?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(apiMocks.setSetting).not.toHaveBeenCalled();

    await act(async () => {
      range?.dispatchEvent(new Event("pointerup", { bubbles: true }));
      await Promise.resolve();
    });
    expect(apiMocks.setSetting).toHaveBeenCalledTimes(1);
    expect(apiMocks.setSetting).toHaveBeenCalledWith("best_take.weight.technical", "0.42");
  });

  it("does not send transport commands or set marks until the player is ready", async () => {
    apiMocks.playerOpen.mockResolvedValueOnce({ ...readyStatus, phase: "loading" });
    apiMocks.playerStatus.mockResolvedValue({ ...readyStatus, phase: "loading" });
    const container = await mount(<PlayerOverlay clip={clip} onExit={() => undefined} />);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });

    expect(apiMocks.playerCommand).not.toHaveBeenCalled();
    expect(container.textContent).toContain("待打点");
  });

  it("sends a fresh native viewport after the player slot is resized", async () => {
    let resizeCallback: ResizeObserverCallback = () => undefined;
    class ResizeObserverStub {
      constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });
    const container = await mount(<PlayerOverlay clip={clip} onExit={() => undefined} />);
    const slot = container.querySelector<HTMLElement>(".player-native-slot");
    let rect = { left: 0, top: 0, width: 800, height: 500 };
    if (slot) slot.getBoundingClientRect = () => ({ ...rect, right: rect.width, bottom: rect.height, x: 0, y: 0, toJSON: () => ({}) });

    apiMocks.playerSetViewport.mockClear();
    rect = { left: 12, top: 18, width: 640, height: 360 };
    await act(async () => {
      resizeCallback([], {} as ResizeObserver);
      await Promise.resolve();
    });

    expect(apiMocks.playerSetViewport).toHaveBeenCalledWith({ x: 12, y: 18, width: 640, height: 360 });
  });

  it("opens with the safe native default when layout is zero and adopts a later valid viewport", async () => {
    let resizeCallback: ResizeObserverCallback = () => undefined;
    class ResizeObserverStub {
      constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0,
      toJSON: () => ({}),
    });
    try {
      const container = await mount(<PlayerOverlay clip={clip} onExit={() => undefined} />);
      expect(apiMocks.playerOpen).toHaveBeenCalledOnce();
      expect(apiMocks.playerSetViewport).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("播放器离线");

      const slot = container.querySelector<HTMLElement>(".player-native-slot");
      if (slot) slot.getBoundingClientRect = () => ({
        left: 12, top: 18, width: 640, height: 360, right: 652, bottom: 378, x: 12, y: 18,
        toJSON: () => ({}),
      });
      await act(async () => {
        resizeCallback([], {} as ResizeObserver);
        await Promise.resolve();
      });
      expect(apiMocks.playerSetViewport).toHaveBeenCalledWith({ x: 12, y: 18, width: 640, height: 360 });
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  });

  it("traps first-run focus and restores it after temporary dismissal", async () => {
    apiMocks.getSettingsStatus.mockResolvedValueOnce({
      ffmpeg: { available: false, configured_path: "", resolved_path: "", version: null, note: null },
      ffprobe: { available: false, configured_path: "", resolved_path: "", version: null, note: null },
      whisper: {
        binary: { available: false, configured_path: "", resolved_path: "", version: null, note: null },
        model_tier: "small",
        model_path: "/tmp/model.bin",
        model_available: false,
        models_directory: "/tmp",
      },
      clip_sidecar: { available: false, service_available: true, venv_path: "", service_path: "", setup_script: "/tmp/setup.sh", note: "" },
      cache: { database_bytes: 0, disk_bytes: 0 },
    });
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const container = await mount(<FirstRunGuide />);
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    const dismiss = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "暂时进入工作台");

    expect(dialog?.contains(document.activeElement)).toBe(true);
    await act(async () => {
      dismiss?.click();
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("renders keyboard reorder controls and disables chapter editing while busy", async () => {
    let finishSave: () => void = () => undefined;
    apiMocks.setStoryOrder.mockReturnValueOnce(new Promise<void>((resolve) => {
      finishSave = resolve;
    }));
    apiMocks.getStoryboard.mockResolvedValueOnce({
      ...board,
      chapters: [{ ...board.chapters[0], clip_count: 2 }],
      items: [
        { key: "whole:1", item_kind: "whole", clip_id: 1, segment_id: null, chapter_id: 1, file_name: "a.mov", in_ticks: 0, out_ticks: 10, tb_num: 1, tb_den: 1, position: 0 },
        { key: "whole:2", item_kind: "whole", clip_id: 2, segment_id: null, chapter_id: 1, file_name: "b.mov", in_ticks: 0, out_ticks: 10, tb_num: 1, tb_den: 1, position: 1 },
      ],
    });
    const container = await mount(<StoryboardView />);

    expect(container.querySelector('button[aria-label="a.mov 下移"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="b.mov 上移"]')).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="a.mov 下移"]')?.click();
      await Promise.resolve();
    });
    expect(container.querySelector<HTMLInputElement>(".story-chapter input")?.disabled).toBe(true);
    await act(async () => {
      finishSave();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it("renders player failure and diagnostics without English UI states", async () => {
    apiMocks.playerOpen.mockResolvedValueOnce({
      ...readyStatus,
      frame: null,
      seek_p95_ms: null,
    });
    const waiting = await mount(<PlayerOverlay clip={{ ...clip, id: 3 }} onExit={() => undefined} />);
    expect(waiting.textContent).not.toContain("精确定位待采样");
    expect(waiting.textContent).not.toContain("EXACT SEEK");

    const ready = await mount(<PlayerOverlay clip={clip} onExit={() => undefined} />);
    expect(ready.textContent).toContain("第 128 帧");
    expect(ready.textContent).toContain("精确定位 8 毫秒");
    expect(ready.textContent).not.toContain("FRAME");
    expect(ready.textContent).not.toContain("SEEK P95");

    apiMocks.playerOpen.mockRejectedValueOnce(new Error("mpv unavailable"));
    const failed = await mount(<PlayerOverlay clip={{ ...clip, id: 2 }} onExit={() => undefined} />);
    expect(failed.textContent).toContain("播放器离线");
    expect(failed.textContent).not.toContain("PLAYER OFFLINE");
  });
});
