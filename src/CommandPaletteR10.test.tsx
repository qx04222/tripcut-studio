// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** R10 U-31:⌘K 命名统一叫「地点卡」;Enter 默认执行首项(全量命中到达后首项也要被高亮)。 */

const apiMock = vi.hoisted(() => ({
  listClips: vi.fn().mockResolvedValue([]),
  searchEverything: vi.fn().mockResolvedValue([]),
  listClipDimensions: vi.fn().mockResolvedValue([]),
  getStoryboard: vi.fn().mockResolvedValue(null),
  getCurrentEpisode: vi.fn().mockResolvedValue({ id: 100 }),
  listEpisodes: vi.fn().mockResolvedValue([{ id: 100, title: "当前集" }]),
  getClipsRevision: vi.fn().mockResolvedValue("rev-1"),
  listShotStacks: vi.fn().mockResolvedValue([]),
  listStoryGaps: vi.fn().mockResolvedValue([]),
  listAssetSafety: vi.fn().mockResolvedValue([]),
}));
vi.mock("./api", () => apiMock);
vi.mock("./historyView", () => ({ openHistoricalEpisode: vi.fn() }));
vi.mock("pinyin-pro", () => ({ pinyin: () => [] }));

import { CommandPalette } from "./CommandPalette";
import { __resetSearchAugmentForTests } from "./useSearchAugment";

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  // jsdom 没有 requestAnimationFrame 的可靠实现节奏;用 setTimeout 顶上,让「补选首项」的 effect 真的跑。
  window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  __resetSearchAugmentForTests();
});

afterEach(() => {
  cleanup();
  __resetSearchAugmentForTests();
  vi.clearAllMocks();
});

async function openPalette(onSelectClip = vi.fn(), onNavigate = vi.fn()) {
  render(<CommandPalette onNavigate={onNavigate} onSelectClip={onSelectClip} />);
  await act(async () => {
    window.dispatchEvent(new CustomEvent("tripcut:open-command-palette"));
  });
  return { input: (await screen.findByRole("combobox")) as HTMLInputElement, onSelectClip, onNavigate };
}

describe("U-31:⌘K", () => {
  it("附属带命令叫「切到地点卡附属带」,不再叫「目的地」", async () => {
    await openPalette();
    expect(screen.getByText("切到地点卡附属带")).toBeTruthy();
    expect(screen.queryByText(/目的地/)).toBeNull();
  });

  it("打开即有首项高亮;Enter 执行它", async () => {
    const { input, onNavigate } = await openPalette();
    await waitFor(() => expect(document.querySelector('[cmdk-item][aria-selected="true"]')).not.toBeNull());
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledWith("open-import");
  });

  it("全量命中到达后首项(命中)被高亮,Enter 直达那条素材", async () => {
    apiMock.searchEverything.mockResolvedValue([
      { kind: "file", clip_id: 37, file_name: "/a/IMG_0837_日落.mov", excerpt: "", episode_id: 100 },
    ]);
    const { input, onSelectClip } = await openPalette();
    fireEvent.change(input, { target: { value: "日落" } });
    await screen.findByText("IMG_0837_日落.mov");
    await waitFor(() => {
      const selected = document.querySelector('[cmdk-item][aria-selected="true"]');
      expect(selected?.getAttribute("data-value")).toMatch(/^deep-file-37-/);
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelectClip).toHaveBeenCalledWith(37);
  });
});
