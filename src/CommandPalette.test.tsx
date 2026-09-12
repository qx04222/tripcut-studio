// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  listClips: vi.fn().mockResolvedValue([]),
  searchEverything: vi.fn().mockResolvedValue([]),
  listClipDimensions: vi.fn().mockResolvedValue([]),
  getStoryboard: vi.fn().mockResolvedValue(null),
  getCurrentEpisode: vi.fn().mockResolvedValue({ id: 100 }),
  listEpisodes: vi.fn().mockResolvedValue([
    { id: 100, title: "当前集" },
    { id: 7, title: "泰国之旅" },
  ]),
  getClipsRevision: vi.fn().mockResolvedValue("rev-1"),
  // R8 Task 2:拼音索引改走 useClipsFeed,feed 会一并拉这三条。
  listShotStacks: vi.fn().mockResolvedValue([]),
  listStoryGaps: vi.fn().mockResolvedValue([]),
  listAssetSafety: vi.fn().mockResolvedValue([]),
}));
vi.mock("./api", () => apiMock);

const historyMocks = vi.hoisted(() => ({
  openHistoricalEpisode: vi.fn(),
}));
vi.mock("./historyView", () => historyMocks);

// 同 SidebarSearch.test.tsx:mock 掉真正的 pinyin-pro,避免真实动态 import 在
// fake timers 下引入数量不确定的额外微任务/宏任务跳转。
vi.mock("pinyin-pro", () => ({ pinyin: () => [] }));

import { CommandPalette } from "./CommandPalette";
import { __resetSearchAugmentForTests } from "./useSearchAugment";

describe("CommandPalette", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    apiMock.getClipsRevision.mockResolvedValue("rev-1");
    __resetSearchAugmentForTests();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    __resetSearchAugmentForTests();
    vi.clearAllMocks();
    apiMock.listClips.mockResolvedValue([]);
    apiMock.searchEverything.mockResolvedValue([]);
    apiMock.listClipDimensions.mockResolvedValue([]);
    apiMock.getStoryboard.mockResolvedValue(null);
    apiMock.getCurrentEpisode.mockResolvedValue({ id: 100 });
    apiMock.listEpisodes.mockResolvedValue([
      { id: 100, title: "当前集" },
      { id: 7, title: "泰国之旅" },
    ]);
    apiMock.getClipsRevision.mockResolvedValue("rev-1");
  });

  it("opens from the visible header button event", async () => {
    await act(async () => {
      root.render(<CommandPalette onNavigate={() => undefined} onSelectClip={() => undefined} />);
    });
    expect(container.textContent).toBe("");

    await act(async () => {
      window.dispatchEvent(new CustomEvent("tripcut:open-command-palette"));
      await Promise.resolve();
    });

    expect(container.textContent).toContain("打开导入素材");
    expect(container.textContent).toContain("切到音乐附属带");
    expect(container.textContent).not.toContain("去交付页");
    expect(container.querySelector("input")?.getAttribute("placeholder")).toContain("全量搜索");
  });

  it("labels an ocr-kind hit as 画面文字", async () => {
    apiMock.searchEverything.mockResolvedValue([
      { kind: "ocr", clip_id: 9, file_name: "/a/ninth.mov", excerpt: "TripCut 旅剪", episode_id: 100 },
    ]);
    vi.useFakeTimers();
    try {
      await act(async () => {
        root.render(<CommandPalette onNavigate={() => undefined} onSelectClip={() => undefined} />);
      });
      await act(async () => {
        window.dispatchEvent(new CustomEvent("tripcut:open-command-palette"));
        await Promise.resolve();
      });

      const input = container.querySelector("input") as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "tripcut",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
        await Promise.resolve();
      });

      const hitKind = container.querySelector(".hit-kind");
      expect(hitKind?.textContent).toBe("画面文字");
    } finally {
      vi.useRealTimers();
    }
  });

  it("labels a pinyin-kind hit as 拼音", async () => {
    apiMock.searchEverything.mockResolvedValue([
      { kind: "pinyin", clip_id: 11, file_name: "旅拍花絮", excerpt: "旅拍花絮", episode_id: 100 },
    ]);
    vi.useFakeTimers();
    try {
      await act(async () => {
        root.render(<CommandPalette onNavigate={() => undefined} onSelectClip={() => undefined} />);
      });
      await act(async () => {
        window.dispatchEvent(new CustomEvent("tripcut:open-command-palette"));
        await Promise.resolve();
      });

      const input = container.querySelector("input") as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "lvpai",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
        await Promise.resolve();
      });

      const hitKind = container.querySelector(".hit-kind");
      expect(hitKind?.textContent).toBe("拼音");
    } finally {
      vi.useRealTimers();
    }
  });

  it("selecting a hit from a historical episode opens the read-only history view instead of the current-episode filter", async () => {
    apiMock.searchEverything.mockResolvedValue([
      { kind: "file", clip_id: 22, file_name: "/b/old.mov", excerpt: "", episode_id: 7 },
    ]);
    const onSelectClip = vi.fn();
    vi.useFakeTimers();
    try {
      await act(async () => {
        root.render(<CommandPalette onNavigate={() => undefined} onSelectClip={onSelectClip} />);
      });
      await act(async () => {
        window.dispatchEvent(new CustomEvent("tripcut:open-command-palette"));
        await Promise.resolve();
      });

      const input = container.querySelector("input") as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "old",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.querySelector(".hit-history-badge")?.textContent).toBe("历史集（只读）");

      const item = container.querySelector('[data-value^="deep-file-22-"]') as HTMLElement;
      await act(async () => {
        item.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
        item.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        item.click();
      });

      expect(onSelectClip).not.toHaveBeenCalled();
      expect(historyMocks.openHistoricalEpisode).toHaveBeenCalledWith(7, "泰国之旅");
    } finally {
      vi.useRealTimers();
    }
  });
});
