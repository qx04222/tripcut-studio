// @vitest-environment jsdom
/**
 * R21 W3 验收 P1-1(业主原话「照片的逻辑不应该是视频的那一套」):照片工作台的顶栏流水线 rail
 * 不再显示视频的「导入 / 挑选 N 段 / 排列 N 章 / 导出」,而是照片自己的三步
 * 「导入 → 挑选(N 张已选)→ 导出精选照片」;主按钮「下一步」按照片步骤走;切回视频工作台原样。
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  arrangeSelectedSegments: vi.fn(async () => ({ placed: 3, chapters: 2 })),
  setSetting: vi.fn(async () => undefined),
  getSettings: vi.fn(async () => ({})),
  listEpisodes: vi.fn(async () => []),
  getCurrentEpisode: vi.fn(async () => null),
  getImportProgress: vi.fn(async () => ({ total: 5, done: 5, failed: 0, running: 0, waiting_for_permit: 0, paused_for_memory: false })),
}));
vi.mock("../api", () => apiMocks);
const feedState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("./useClipsFeed", () => ({ useClipsFeed: () => feedState.current, refreshClipsFeed: vi.fn(async () => undefined), patchClipInFeed: vi.fn() }));

import type { ClipListItem } from "../api";
import { photoFixture, videoFixture } from "./photoTestFixtures";
import { TopBar } from "./TopBar";
import { EXPORT_DONE_EVENT, __resetPipelineForTests } from "./usePipeline";
import { __resetWorkspaceForTests, dispatchWorkspace, getWorkspaceSnapshot } from "./WorkspaceStore";

/** 业主点名的视频词:段 / 章 / 分钟 / 交付 —— 照片工作台的壳里一个都不许出现。 */
const VIDEO_WORDS = /段|章|分钟|交付|镜头带|剪映/;

function videos(count: number): ClipListItem[] {
  return Array.from({ length: count }, (_, index) => ({ ...videoFixture, id: 100 + index, file_name: `v${index}.mov`, select_count: 2 }));
}
function photos(count: number, patch: Partial<ClipListItem> = {}): ClipListItem[] {
  return Array.from({ length: count }, (_, index) => ({ ...photoFixture, id: 1 + index, file_name: `p${index}.HEIC`, binary_rating: null, star_rating: null, select_count: 0, ...patch }));
}

function mount(clips: ClipListItem[], exportCount = 0) {
  feedState.current = {
    clips,
    clipsById: new Map(clips.map((clip) => [clip.id!, clip])),
    storyboard: { chapters: [{ id: 1, title: "A" }, { id: 2, title: "B" }], items: [{ clip_id: 100, chapter_id: 1 }], candidates: [] },
    episode: { scopeId: 7, current: { id: 7, title: "EP01", export_count: exportCount, photo_export_count: exportCount } },
    loading: false,
  };
  render(<TopBar />);
}

function strings(root: HTMLElement): string[] {
  const out = [root.textContent ?? ""];
  for (const element of root.querySelectorAll<HTMLElement>("[aria-label], [title]")) {
    for (const attr of ["aria-label", "title"]) {
      const value = element.getAttribute(attr);
      if (value) out.push(value);
    }
  }
  return out;
}

beforeEach(() => {
  __resetWorkspaceForTests();
  __resetPipelineForTests();
  dispatchWorkspace({ type: "set-workspace-mode", mode: "photo" });
});
afterEach(cleanup);

describe("照片工作台的顶栏流水线(R21 W3 P1-1)", () => {
  it("三步「导入 → 挑选 → 导出精选照片」,计数按张;没有视频的 段 / 章 / 分钟 / 交付", () => {
    mount([...photos(60), ...videos(10)]);
    const rail = screen.getByRole("navigation", { name: "照片流水线" });
    const steps = within(rail).getAllByRole("button");
    expect(steps.map((step) => step.getAttribute("aria-label"))).toEqual(["第 1 步 导入", "第 2 步 挑选", "第 3 步 导出精选照片"]);
    expect(steps[0]!.getAttribute("title")).toBe("导入 · 60 张");
    expect(steps[1]!.getAttribute("title")).toBe("挑选");
    expect(screen.queryByRole("navigation", { name: "流水线" })).toBeNull();
    expect(strings(document.querySelector<HTMLElement>(".workspace-topbar")!).filter((text) => VIDEO_WORDS.test(text))).toEqual([]);
  });

  it("主按钮按照片步骤走:没照片 → 导入照片;有照片没选 → 挑选照片;选了 → 导出精选照片;导出过 → 再导出一次", () => {
    const button = () => screen.getByRole("button", { name: "流水线下一步" }) as HTMLButtonElement;
    mount(videos(10));
    expect(button().textContent).toBe("下一步:导入照片");
    cleanup();
    mount(photos(60));
    expect(button().textContent).toBe("下一步:挑选照片");
    expect(button().disabled).toBe(false);
    cleanup();
    mount([...photos(50), ...photos(10, { binary_rating: 1 })]);
    expect(button().textContent).toBe("下一步:导出精选照片");
    expect(screen.getByRole("button", { name: "第 2 步 挑选" }).getAttribute("title")).toBe("挑选 · 10 张已选");
    cleanup();
    mount([...photos(50), ...photos(10, { star_rating: 4 })], 1);
    expect(button().textContent).toBe("再导出一次");
    expect(document.querySelectorAll(".workspace-topbar .ui-button--primary")).toHaveLength(1);
  });

  it("照片还在分析:第 ① 步计数「x/N 张」;主按钮不吃闭门羹,仍是「下一步:挑选照片」", () => {
    mount([...photos(40), ...photos(20, { analysis_status: "running" })]);
    expect(screen.getByRole("button", { name: "第 1 步 导入" }).getAttribute("title")).toBe("导入 · 40/60 张");
    expect((screen.getByRole("button", { name: "流水线下一步" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("③ 导出精选照片 / 再导出一次 都打开导出抽屉;① 打开导入抽屉;② 聚焦照片网格", () => {
    mount([...photos(50), ...photos(10, { binary_rating: 1 })]);
    act(() => screen.getByRole("button", { name: "流水线下一步" }).click());
    expect(getWorkspaceSnapshot().openDrawer).toBe("deliver");
    cleanup();
    __resetWorkspaceForTests();
    dispatchWorkspace({ type: "set-workspace-mode", mode: "photo" });
    mount([]);
    act(() => screen.getByRole("button", { name: "流水线下一步" }).click());
    expect(getWorkspaceSnapshot().openDrawer).toBe("import");
    cleanup();
    __resetWorkspaceForTests();
    dispatchWorkspace({ type: "set-workspace-mode", mode: "photo" });
    mount(photos(3));
    act(() => screen.getByRole("button", { name: "第 2 步 挑选" }).click());
    expect(getWorkspaceSnapshot().focusedPane).toBe("pool");
  });

  it("切回视频工作台:原来的四步 rail 原样(挑选 N 段 / 排列 N 章)", () => {
    mount([...photos(60), ...videos(10)]);
    act(() => dispatchWorkspace({ type: "set-workspace-mode", mode: "video" }));
    const rail = screen.getByRole("navigation", { name: "流水线" });
    expect(within(rail).getAllByRole("button").map((step) => step.getAttribute("aria-label"))).toEqual(["第 1 步 导入", "第 2 步 挑选", "第 3 步 排列", "第 4 步 导出"]);
    expect(screen.getByRole("button", { name: "第 2 步 挑选" }).getAttribute("title")).toBe("挑选 · 20 段");
    expect(screen.getByRole("button", { name: "第 3 步 排列" }).getAttribute("title")).toBe("排列 · 1/2 章");
    expect(screen.queryByRole("navigation", { name: "照片流水线" })).toBeNull();
  });
});

// R21 W3 真机 F-W3-03:照片导出过一次,视频工作台的 rail 却显示「导出 1 次」(export_count 是全集总数,
// 会话计数也共用一个)。两条线的「导出过了没」要分开:后端 photo_export_count + 事件 detail "photo"。
describe("导出计数不串线(F-W3-03)", () => {
  it("集里只有照片导出记录:照片 rail「导出 1 次」,视频 rail 第 ④ 步不打勾", () => {
    feedState.current = {
      clips: [...photos(3, { binary_rating: 1 }), ...videos(2)],
      clipsById: new Map(),
      storyboard: { chapters: [], items: [], candidates: [] },
      episode: { scopeId: 7, current: { id: 7, title: "EP01", export_count: 1, photo_export_count: 1 } },
      loading: false,
    };
    render(<TopBar />);
    expect(screen.getByRole("button", { name: "第 3 步 导出精选照片" }).getAttribute("title")).toBe("导出精选照片 · 1 次");
    expect(screen.getByRole("button", { name: "流水线下一步" }).textContent).toBe("再导出一次");
    act(() => dispatchWorkspace({ type: "set-workspace-mode", mode: "video" }));
    expect(screen.getByRole("button", { name: "第 4 步 导出" }).getAttribute("title")).toBe("导出");
  });

  it("会话内:照片导出完成(detail photo)只给照片线打勾;视频导出完成(无 detail)只给视频线打勾", () => {
    mount([...photos(3, { binary_rating: 1 }), ...videos(2)]);
    act(() => window.dispatchEvent(new CustomEvent(EXPORT_DONE_EVENT, { detail: "photo" })));
    expect(screen.getByRole("button", { name: "第 3 步 导出精选照片" }).getAttribute("title")).toBe("导出精选照片 · 1 次");
    act(() => dispatchWorkspace({ type: "set-workspace-mode", mode: "video" }));
    expect(screen.getByRole("button", { name: "第 4 步 导出" }).getAttribute("title")).toBe("导出");
    act(() => window.dispatchEvent(new CustomEvent(EXPORT_DONE_EVENT)));
    expect(screen.getByRole("button", { name: "第 4 步 导出" }).getAttribute("title")).toBe("导出 · 1 次");
    act(() => dispatchWorkspace({ type: "set-workspace-mode", mode: "photo" }));
    expect(screen.getByRole("button", { name: "第 3 步 导出精选照片" }).getAttribute("title")).toBe("导出精选照片 · 1 次");
  });
});
