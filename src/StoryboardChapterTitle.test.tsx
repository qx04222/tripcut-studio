// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoryboardView } from "./Storyboard";
import type { RevisionInfo, ShotStack, Storyboard as StoryboardData } from "./api";

const apiMocks = vi.hoisted(() => ({
  enqueueNarrateEpisode: vi.fn(),
  getLlmStatus: vi.fn(),
  getStoryboard: vi.fn(),
  listShotStacks: vi.fn(async () => [] as ShotStack[]),
  mergeChapters: vi.fn(),
  renameChapter: vi.fn(),
  setDestinationCardVerified: vi.fn(),
  setStoryOrder: vi.fn(),
  setShotStackUserState: vi.fn(),
  undoStoryChange: vi.fn(),
  updateDestinationCard: vi.fn(),
  applyNarrativeOp: vi.fn(),
  undoNarrativeOp: vi.fn(),
  getNarrativeRevision: vi.fn(async () => null as RevisionInfo | null),
  setRoutineOverride: vi.fn(),
  acceptAllRoutineSuggestions: vi.fn(),
}));

vi.mock("./api", () => apiMocks);

const board: StoryboardData = {
  chapters: [
    { id: 1, title: "老标题", start_at: "09:00", end_at: "09:30", clip_count: 1 },
  ],
  items: [],
  candidates: [],
  can_undo: false,
  mode: "legacy",
  mode_notice: "",
  narrative: null,
  narration_job_status: null,
};

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];

afterEach(async () => {
  while (mounted.length > 0) {
    const current = mounted.pop();
    if (!current) continue;
    await act(async () => current.root.unmount());
    current.container.remove();
  }
  vi.clearAllMocks();
});

describe("chapter title edit survives the native event's currentTarget being nulled", () => {
  // 回归说明：Storyboard 仍有一处 setState updater 延迟读取
  // SyntheticEvent(src/Storyboard.tsx 的 setTitleDrafts)。本仓已经在其他
  // 7 处修过同一形状的缺陷:updater 回调是延迟执行的,而浏览器在事件同步
  // 派发阶段结束后就会把 event.currentTarget 置空(jsdom 也是如此——见下方
  // 独立断言),所以 value 必须在 handler 内先同步读出,不能留到 updater
  // 里再读,否则读到 null.value 直接抛异常炸整个界面。

  it("does not read event.currentTarget from inside the setTitleDrafts updater callback", () => {
    // 组件级重现依赖 React 何时真正调用 updater(通常和事件同步派发在同一
    // 调用栈内,单元测试里很难稳定造出"updater 延迟到派发结束之后才跑"的
    // 竞态)。所以这里再加一道静态锚点:直接锁定源码里 setTitleDrafts 的
    // updater 回调体,断言它只读闭包捕获的 value,不再引用 event/currentTarget——
    // 这正是本仓另外 7 处同类修复共同遵守的形状,回退到旧写法这里必须变红。
    const here = fileURLToPath(import.meta.url);
    const sourcePath = here.replace(/StoryboardChapterTitle\.test\.tsx$/, "Storyboard.tsx");
    const source = readFileSync(sourcePath, "utf8");
    // maxLength={80} 只出现在章节标题输入框上,用它精确定位到那一段
    // JSX,再从里面找 onChange——文件里另外还有三处不相关的
    // onChange={(event) => ...} 和两处重置用的 setTitleDrafts 调用,
    // 不能靠 indexOf 第一次命中。
    const inputMarker = "maxLength={80}";
    const inputStart = source.indexOf(inputMarker);
    expect(inputStart, "找不到章节标题输入框,文件可能被大改了").toBeGreaterThan(-1);
    const handlerSlice = source.slice(inputStart, inputStart + 400);
    const updaterMarker = "setTitleDrafts((drafts) => ({";
    const start = handlerSlice.indexOf(updaterMarker);
    expect(start, "onChange handler 里找不到 setTitleDrafts 的 updater 调用").toBeGreaterThan(-1);
    const updaterBody = handlerSlice.slice(start, start + 200);
    expect(updaterBody).not.toContain("event.currentTarget");
    expect(updaterBody).not.toContain("event.target");
  });

  it("jsdom nulls a native event's currentTarget as soon as dispatch returns", () => {
    const input = document.createElement("input");
    document.body.append(input);
    let capturedEvent: Event | null = null;
    input.addEventListener("input", (event) => {
      capturedEvent = event;
    });
    input.value = "hi";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // 派发同步阶段一结束,currentTarget 就已经是 null——任何延迟到这之后
    // 才发生的读取(比如 setState 的 updater 回调)都会拿到 null。
    expect((capturedEvent as unknown as Event).currentTarget).toBeNull();
    input.remove();
  });

  it("types a new chapter title without crashing and keeps the typed value", async () => {
    apiMocks.getStoryboard.mockResolvedValue(board);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ container, root });

    await act(async () => {
      root.render(<StoryboardView />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const input = container.querySelector<HTMLInputElement>("input[maxlength='80']");
    expect(input).not.toBeNull();
    expect(input!.value).toBe("老标题");

    await act(async () => {
      input!.value = "新标题";
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    // 值必须在 handler 同步阶段就被捕获并写进 drafts;如果代码退回成在
    // updater 里读 event.currentTarget.value,这里要么读到 null 抛异常
    // (React 会把它当渲染错误处理,输入框从 DOM 里消失),要么值对不上。
    const updatedInput = container.querySelector<HTMLInputElement>("input[maxlength='80']");
    expect(updatedInput).not.toBeNull();
    expect(updatedInput!.value).toBe("新标题");
  });
});
