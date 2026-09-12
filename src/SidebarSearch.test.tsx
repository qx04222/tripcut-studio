// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  searchEverything: vi.fn(),
  listClips: vi.fn().mockResolvedValue([]),
  listClipDimensions: vi.fn().mockResolvedValue([]),
  getStoryboard: vi.fn().mockResolvedValue(null),
  getCurrentEpisode: vi.fn().mockResolvedValue({ id: 100 }),
  listEpisodes: vi.fn().mockResolvedValue([{ id: 100, title: "当前集" }, { id: 7, title: "泰国之旅" }]),
  getClipsRevision: vi.fn().mockResolvedValue("rev-1"),
  // R8 Task 2:拼音索引改走 useClipsFeed,feed 会一并拉这三条。
  listShotStacks: vi.fn().mockResolvedValue([]),
  listStoryGaps: vi.fn().mockResolvedValue([]),
  listAssetSafety: vi.fn().mockResolvedValue([]),
}));
vi.mock("./api", () => apiMocks);

const historyMocks = vi.hoisted(() => ({
  openHistoricalEpisode: vi.fn(),
}));
vi.mock("./historyView", () => historyMocks);

// pinyinIndex 只在真的出现拼音查询("clip" 也满足纯 ASCII>=2 的判定)时才动态
// import 真正的 pinyin-pro——这里不关心拼音准确度,mock 成同步返回空数组,避免
// 真实动态 import 在 fake timers 下引入额外的、数量不确定的微任务/宏任务跳转。
vi.mock("pinyin-pro", () => ({ pinyin: () => [] }));

import { SidebarSearch } from "./SidebarSearch";
import { __resetSearchAugmentForTests } from "./useSearchAugment";
import type { GlobalSearchHit } from "./api";

const hits: GlobalSearchHit[] = [
  { kind: "file", clip_id: 1, file_name: "/a/first.mov", excerpt: "", episode_id: 100 },
  { kind: "transcript", clip_id: 2, file_name: "/a/second.mov", excerpt: "对白片段", episode_id: 100 },
  { kind: "dimension", clip_id: 3, file_name: "/a/third.mov", excerpt: "标签命中", episode_id: 100 },
  { kind: "ocr", clip_id: 4, file_name: "/a/fourth.mov", excerpt: "TripCut 旅剪", episode_id: 100 },
];

describe("SidebarSearch O12 listbox semantics", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    apiMocks.searchEverything.mockResolvedValue(hits);
    apiMocks.listClips.mockResolvedValue([]);
    apiMocks.listClipDimensions.mockResolvedValue([]);
    apiMocks.getStoryboard.mockResolvedValue(null);
    apiMocks.getCurrentEpisode.mockResolvedValue({ id: 100 });
    apiMocks.listEpisodes.mockResolvedValue([
      { id: 100, title: "当前集" },
      { id: 7, title: "泰国之旅" },
    ]);
    apiMocks.getClipsRevision.mockResolvedValue("rev-1");
    __resetSearchAugmentForTests();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    container.remove();
    __resetSearchAugmentForTests();
    vi.clearAllMocks();
  });

  async function typeQuery(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("renders results as role=option inside role=listbox", async () => {
    await act(async () => {
      root.render(<SidebarSearch onSelectClip={() => undefined} />);
    });
    const input = container.querySelector("input") as HTMLInputElement;
    await typeQuery(input, "clip");

    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    const options = Array.from(container.querySelectorAll('[role="option"]'));
    expect(options).toHaveLength(4);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
  });

  it("labels an ocr-kind hit as 画面文字", async () => {
    await act(async () => {
      root.render(<SidebarSearch onSelectClip={() => undefined} />);
    });
    const input = container.querySelector("input") as HTMLInputElement;
    await typeQuery(input, "clip");

    const options = Array.from(container.querySelectorAll('[role="option"]'));
    const ocrOption = options[3];
    expect(ocrOption.querySelector(".hit-kind")?.textContent).toBe("画面文字");
  });

  it("labels a pinyin-kind hit as 拼音", async () => {
    apiMocks.searchEverything.mockResolvedValue([
      ...hits,
      { kind: "pinyin", clip_id: 5, file_name: "旅拍花絮", excerpt: "旅拍花絮", episode_id: 100 },
    ]);
    await act(async () => {
      root.render(<SidebarSearch onSelectClip={() => undefined} />);
    });
    const input = container.querySelector("input") as HTMLInputElement;
    await typeQuery(input, "lvpai");

    const options = Array.from(container.querySelectorAll('[role="option"]'));
    const pinyinOption = options[4];
    expect(pinyinOption.querySelector(".hit-kind")?.textContent).toBe("拼音");
  });

  it("moves the active option with ArrowDown/ArrowUp and activates it with Enter", async () => {
    const onSelectClip = vi.fn();
    await act(async () => {
      root.render(<SidebarSearch onSelectClip={onSelectClip} />);
    });
    const input = container.querySelector("input") as HTMLInputElement;
    await typeQuery(input, "clip");

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    let options = Array.from(container.querySelectorAll('[role="option"]'));
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    expect(options[0].getAttribute("aria-selected")).toBe("false");

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    });
    options = Array.from(container.querySelectorAll('[role="option"]'));
    expect(options[0].getAttribute("aria-selected")).toBe("true");

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onSelectClip).toHaveBeenCalledWith(1);
  });

  it("still supports mouse click on a result", async () => {
    const onSelectClip = vi.fn();
    await act(async () => {
      root.render(<SidebarSearch onSelectClip={onSelectClip} />);
    });
    const input = container.querySelector("input") as HTMLInputElement;
    await typeQuery(input, "clip");

    const options = Array.from(container.querySelectorAll('[role="option"]'));
    await act(async () => {
      options[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelectClip).toHaveBeenCalledWith(3);
  });

  it("clicking a hit from a historical episode opens the read-only history view instead of the current-episode filter", async () => {
    apiMocks.searchEverything.mockResolvedValue([
      { kind: "file", clip_id: 9, file_name: "/b/old.mov", excerpt: "", episode_id: 7 },
    ]);
    const onSelectClip = vi.fn();
    await act(async () => {
      root.render(<SidebarSearch onSelectClip={onSelectClip} />);
    });
    const input = container.querySelector("input") as HTMLInputElement;
    await typeQuery(input, "old");

    const options = Array.from(container.querySelectorAll('[role="option"]'));
    expect(options).toHaveLength(1);
    expect(options[0].querySelector(".hit-history-badge")?.textContent).toBe("历史集（只读）");

    await act(async () => {
      options[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSelectClip).not.toHaveBeenCalled();
    expect(historyMocks.openHistoricalEpisode).toHaveBeenCalledWith(7, "泰国之旅");
  });
});
