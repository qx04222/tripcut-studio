// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({}) as Record<string, string>),
  setSetting: vi.fn(async () => undefined),
}));
vi.mock("../api", () => apiMocks);
const feedMock = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("./useClipsFeed", () => ({ useClipsFeed: () => feedMock.state }));
const pipelineMock = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("./usePipeline", () => ({ usePipeline: () => pipelineMock.state }));

import { GuideHost } from "./GuideHost";
import { __resetGuidesForTests, getGuideSnapshot, guideKey } from "./guides";
import { __resetHomeForTests, pinHome } from "./homeStore";
import { derivePipeline, type PipelineInput } from "./pipelineModel";
import { __resetWorkspaceForTests, dispatchWorkspace } from "./WorkspaceStore";

const base: PipelineInput = { clipCount: 0, analysisPending: 0, segmentCount: 0, chapters: [], exportCount: 0 };

function feed(patch: Record<string, unknown> = {}) {
  return {
    clips: [],
    clipsById: new Map(),
    storyboard: null,
    gaps: [],
    loading: false,
    episode: { activeId: 1, viewing: null, scopeId: 1, current: null },
    ...patch,
  };
}

function mount(html: string) {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
}

beforeEach(() => {
  __resetGuidesForTests();
  __resetHomeForTests();
  __resetWorkspaceForTests();
  pipelineMock.state = derivePipeline(base);
  feedMock.state = feed({ clips: [{ id: 1 }], clipsById: new Map([[1, { id: 1, has_suggestions: true }]]) });
  apiMocks.getSettings.mockReset().mockResolvedValue({});
  apiMocks.setSetting.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

/** R13 §3:宿主把 feed / 流水线 / 工作区 store 折成信号;首页盖着时不出;一次只画一个气泡。 */
describe("GuideHost", () => {
  it("首次进入工作区:导航条气泡;「知道了」写 guide.nav.viewed=true 且气泡消失", async () => {
    mount('<nav class="pipeline-rail"></nav>');
    render(<GuideHost />);
    const dialog = await screen.findByRole("dialog", { name: "新手引导" });
    expect(dialog.textContent).toContain("导入 → 挑选 → 排列 → 导出");
    act(() => screen.getByRole("button", { name: "知道了" }).click());
    expect(apiMocks.setSetting).toHaveBeenCalledWith(guideKey("nav"), "true");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("首页钉住时不算在工作区:不出导航条气泡;解开后出", async () => {
    mount('<nav class="pipeline-rail"></nav>');
    pinHome(true);
    render(<GuideHost />);
    await waitFor(() => expect(apiMocks.getSettings).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => pinHome(false));
    expect(await screen.findByRole("dialog", { name: "新手引导" })).toBeTruthy();
  });

  it("选中带建议的素材 → 热力条气泡;导出抽屉打开 → 导出气泡;自动挑选气泡的「试试」派发打开事件", async () => {
    apiMocks.getSettings.mockResolvedValue({ [guideKey("nav")]: "true" });
    mount('<div class="monitor-heat"></div><div class="deliver-drawer"></div><button aria-label="自动挑选精选段"></button>');
    render(<GuideHost />);
    await waitFor(() => expect(apiMocks.getSettings).toHaveBeenCalled());
    await act(async () => dispatchWorkspace({ type: "select-clip", clipId: 1 }));
    expect((await screen.findByRole("dialog", { name: "新手引导" })).textContent).toContain("精彩程度");
    expect(getGuideSnapshot().active).toBe("heat");
    act(() => screen.getByRole("button", { name: "知道了" }).click());

    await act(async () => dispatchWorkspace({ type: "open-drawer", drawer: "deliver" }));
    expect((await screen.findByRole("dialog", { name: "新手引导" })).textContent).toContain("完整交付包");
    act(() => screen.getByRole("button", { name: "知道了" }).click());
    await act(async () => dispatchWorkspace({ type: "close-drawer" }));

    const opened = vi.fn();
    window.addEventListener("tripcut:open-auto-select", opened);
    pipelineMock.state = derivePipeline({ ...base, clipCount: 3 });
    await act(async () => dispatchWorkspace({ type: "clear-selection" }));
    await screen.findByRole("button", { name: "试试自动挑选" });
    act(() => screen.getByRole("button", { name: "试试自动挑选" }).click());
    expect(opened).toHaveBeenCalledTimes(1);
    expect(apiMocks.setSetting).toHaveBeenCalledWith(guideKey("autoselect"), "true");
  });

  it("镜块 / 缺口来自故事板与缺口表:一次只画一个 dialog", async () => {
    apiMocks.getSettings.mockResolvedValue({ [guideKey("nav")]: "true" });
    mount('<div class="band-segment"></div><div class="band-segment slot"></div>');
    feedMock.state = feed({
      clips: [{ id: 1 }],
      clipsById: new Map(),
      storyboard: { items: [{ key: "segment:1", item_kind: "segment" }], chapters: [] },
      gaps: [{ id: 1, status: "open" }],
    });
    render(<GuideHost />);
    const dialog = await screen.findByRole("dialog", { name: "新手引导" });
    expect(dialog.textContent).toContain("拖动镜块");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    act(() => screen.getByRole("button", { name: "知道了" }).click());
    expect((await screen.findByRole("dialog", { name: "新手引导" })).textContent).toContain("缺口");
  });

  it("Y-05/Y-06:编号按触发顺序;导入抽屉开着时镜块气泡不出,关掉后出", async () => {
    apiMocks.getSettings.mockResolvedValue({ [guideKey("nav")]: "true", [guideKey("heat")]: "true", [guideKey("autoselect")]: "true" });
    mount('<div class="band-segment"></div>');
    feedMock.state = feed({ clips: [{ id: 1 }], clipsById: new Map(), storyboard: { items: [{ key: "segment:1", item_kind: "segment" }], chapters: [] } });
    dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "source" });
    render(<GuideHost />);
    await waitFor(() => expect(apiMocks.getSettings).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => dispatchWorkspace({ type: "close-drawer" }));
    const dialog = await screen.findByRole("dialog", { name: "新手引导" });
    expect(dialog.textContent).toContain("往前 / 往后");
    // 固定表里镜块是第 4 只;这位用户看过 3 只 → 显示 4/8;换成只看过 1 只就该是 2/8。
    expect(dialog.textContent).toContain("4/8");
  });

  it("Y-05:只看过 1 只时,第二只无论是表里第几个都显示 2/8", async () => {
    apiMocks.getSettings.mockResolvedValue({ [guideKey("nav")]: "true" });
    mount('<div class="band-segment"></div>');
    feedMock.state = feed({ clips: [{ id: 1 }], clipsById: new Map(), storyboard: { items: [{ key: "segment:1", item_kind: "segment" }], chapters: [] } });
    render(<GuideHost />);
    const dialog = await screen.findByRole("dialog", { name: "新手引导" });
    expect(dialog.textContent).toContain("2/8");
    expect(dialog.textContent).not.toContain("4/8");
  });
});
