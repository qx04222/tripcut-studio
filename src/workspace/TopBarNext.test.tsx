// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  arrangeSelectedSegments: vi.fn(async () => ({ placed: 3, chapters: 2 })),
  setSetting: vi.fn(async () => undefined),
  getSettings: vi.fn(async () => ({})),
  listEpisodes: vi.fn(async () => []),
  getCurrentEpisode: vi.fn(async () => null),
}));
vi.mock("../api", () => apiMocks);

// 流水线状态直接喂:TopBar 只关心 usePipeline 的输出,feed 的拼装在 pipelineModel.test 里钉住。
const pipelineMock = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("./usePipeline", () => ({ usePipeline: () => pipelineMock.state }));
vi.mock("./useClipsFeed", () => ({ refreshClipsFeed: vi.fn(async () => undefined) }));

import { OPEN_AUTO_SELECT_EVENT } from "./onboarding";
import { derivePipeline, type PipelineInput } from "./pipelineModel";
import { TopBar } from "./TopBar";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";

const base: PipelineInput = { clipCount: 0, analysisPending: 0, segmentCount: 0, chapters: [], exportCount: 0 };
const filled = [{ id: 1, shotCount: 2 }];

function mount(patch: Partial<PipelineInput>) {
  pipelineMock.state = derivePipeline({ ...base, ...patch });
  render(<TopBar />);
  return screen.getByRole("button", { name: "流水线下一步" });
}

beforeEach(() => __resetWorkspaceForTests());
afterEach(cleanup);

describe("顶栏「下一步:…」主按钮(规格 §1 第二条)", () => {
  it("AX 名固定「流水线下一步」;文案随步:导入素材 / 自动挑选 / 排到镜头带 / 导出 / 再导出一次;顶栏不再有「生成交付包」", () => {
    expect(mount({}).textContent).toBe("下一步:导入素材");
    cleanup();
    expect(mount({ clipCount: 5 }).textContent).toBe("下一步:自动挑选");
    cleanup();
    expect(mount({ clipCount: 5, segmentCount: 2 }).textContent).toBe("下一步:排到镜头带");
    cleanup();
    expect(mount({ clipCount: 5, segmentCount: 2, chapters: filled }).textContent).toBe("下一步:导出");
    cleanup();
    expect(mount({ clipCount: 5, segmentCount: 2, chapters: filled, exportCount: 1 }).textContent).toBe("再导出一次");
    expect(screen.queryByRole("button", { name: "生成交付包" })).toBeNull();
    expect(document.querySelectorAll(".workspace-topbar .ui-button--primary")).toHaveLength(1);
  });

  it("素材还在分析:不挡路,主按钮已是「下一步:自动挑选」且可点", () => {
    const button = mount({ clipCount: 5, analysisPending: 2 }) as HTMLButtonElement;
    expect(button.textContent).toBe("下一步:自动挑选");
    expect(button.disabled).toBe(false);
  });

  it("① 打开导入抽屉的来源页", () => {
    mount({}).click();
    expect(getWorkspaceSnapshot().openDrawer).toBe("import");
    expect(getWorkspaceSnapshot().importTab).toBe("source");
  });

  it("② 聚焦媒体池并打开自动挑选面板(广播 tripcut:open-auto-select)", () => {
    const heard = vi.fn();
    window.addEventListener(OPEN_AUTO_SELECT_EVENT, heard);
    mount({ clipCount: 5 }).click();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(getWorkspaceSnapshot().focusedPane).toBe("pool");
    window.removeEventListener(OPEN_AUTO_SELECT_EVENT, heard);
  });

  it("③ 一键排入:调 arrangeSelectedSegments,广播结果,焦点到镜头带", async () => {
    const heard = vi.fn();
    window.addEventListener("tripcut:pipeline-arranged", heard);
    render(<div data-pane="band" tabIndex={-1} />);
    const button = mount({ clipCount: 5, segmentCount: 2 });
    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMocks.arrangeSelectedSegments).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledTimes(1);
    expect((heard.mock.calls[0][0] as CustomEvent).detail).toEqual({ placed: 3, chapters: 2 });
    expect(getWorkspaceSnapshot().focusedPane).toBe("band");
    window.removeEventListener("tripcut:pipeline-arranged", heard);
  });

  it("④ 与「再导出一次」都打开导出抽屉,按钮带 aria-haspopup/expanded", () => {
    const button = mount({ clipCount: 5, segmentCount: 2, chapters: filled });
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    button.click();
    expect(getWorkspaceSnapshot().openDrawer).toBe("deliver");
    cleanup();
    __resetWorkspaceForTests();
    mount({ clipCount: 5, segmentCount: 2, chapters: filled, exportCount: 3 }).click();
    expect(getWorkspaceSnapshot().openDrawer).toBe("deliver");
  });
});
