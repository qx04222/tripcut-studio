// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  arrangeSelectedSegments: vi.fn(async () => ({ placed: 2, chapters: 1 })),
  setSetting: vi.fn(async () => undefined),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock("../api", () => apiMocks);
vi.mock("./useClipsFeed", () => ({ refreshClipsFeed: vi.fn(async () => undefined) }));
// 镜头带空态按流水线当前步说话:直接喂 usePipeline 的输出。
const pipelineMock = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("./usePipeline", () => ({ usePipeline: () => pipelineMock.state }));

import { BandEmpty, EMPTY_COPY, InspectorEmpty, MonitorEmpty, PoolEmpty, PoolFilteredEmpty } from "./emptyStates";
import { OPEN_AUTO_SELECT_EVENT } from "./onboarding";
import { derivePipeline, type PipelineInput } from "./pipelineModel";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";

const base: PipelineInput = { clipCount: 0, analysisPending: 0, segmentCount: 0, chapters: [], exportCount: 0 };

beforeEach(() => {
  __resetWorkspaceForTests();
  pipelineMock.state = derivePipeline(base);
});
afterEach(cleanup);

/*
 * 规格 §3.4 那张表的组件级断言。任务书里这些用例原本挂在 MediaPool / Monitor /
 * ShotBand / Inspector 的测试文件上;栏本体归别的车道,断言先在这里落地,
 * 栏本体接线后各自的测试文件再按「渲染栏 → 找同一句文案」追加。
 */
describe("四栏空状态(EmptyState)", () => {
  it("空池:「第 ① 步:先导入」+ 「导入素材」按钮打开导入抽屉的来源分页", () => {
    render(<PoolEmpty />);
    expect(screen.getByText("第 ① 步:先导入").tagName).toBe("P");
    expect(screen.getByText(/还没有素材/)).toBeTruthy();
    expect(document.querySelector(".ui-empty svg[data-icon=\"import\"]")).not.toBeNull();
    // R10 U-06:AX 名改为「导入第一批素材」(「导入素材」是顶栏冻结名,空池时不能撞名);可见文字仍是「导入素材」。
    const button = screen.getByRole("button", { name: "导入第一批素材" });
    expect(button.textContent).toBe("导入素材");
    expect(button.className).toContain("ui-button--primary");
    button.click();
    expect(getWorkspaceSnapshot().openDrawer).toBe("import");
    expect(getWorkspaceSnapshot().importTab).toBe("source");
  });
  it("筛选无命中:没有匹配的素材 + 「清空筛选」把 filter 拨回 all", () => {
    __resetWorkspaceForTests({ filter: "rejected" });
    render(<PoolFilteredEmpty />);
    expect(screen.getByText("没有匹配的素材")).toBeTruthy();
    const clear = screen.getByRole("button", { name: "清空筛选" });
    expect(clear.className).toContain("ui-button--ghost");
    clear.click();
    expect(getWorkspaceSnapshot().filter).toBe("all");
  });
  it("监视器:原句「从左侧媒体池选一条素材」保留,是 <p>,tone dark,带图标", () => {
    render(<MonitorEmpty />);
    expect(screen.getByText("从左侧媒体池选一条素材").tagName).toBe("P");
    expect(document.querySelector(".ui-empty.ui-empty--dark svg[data-icon=\"play\"]")).not.toBeNull();
  });
  // R18 V-21:图标由 grip 改为 film —— grip 是「可拖动的把手」,不是空态。断言跟着迁移。
  it("镜头带 · 第 ① 步:「先导入」+ 「打开导入」(film)", () => {
    render(<BandEmpty />);
    expect(screen.getByText("第 ① 步:先导入")).toBeTruthy();
    expect(document.querySelector(".ui-empty svg[data-icon=\"film\"]")).not.toBeNull();
    expect(document.querySelector(".ui-empty svg[data-icon=\"grip\"]")).toBeNull();
    screen.getByRole("button", { name: "打开导入" }).click();
    expect(getWorkspaceSnapshot().openDrawer).toBe("import");
  });
  it("镜头带 · 第 ② 步:「按 F 收藏或点自动挑选」+ 「去自动挑选」广播打开自动挑选面板", () => {
    pipelineMock.state = derivePipeline({ ...base, clipCount: 8 });
    const heard = vi.fn();
    window.addEventListener(OPEN_AUTO_SELECT_EVENT, heard);
    render(<BandEmpty />);
    expect(screen.getByText("第 ② 步:按 F 收藏或点自动挑选")).toBeTruthy();
    const button = screen.getByRole("button", { name: "去自动挑选" });
    expect(button.className).toContain("ui-button--primary");
    button.click();
    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_AUTO_SELECT_EVENT, heard);
  });
  it("镜头带 · 第 ③ 步:「把挑好的片段排进来」+ 「一键排入」调 arrangeSelectedSegments", async () => {
    pipelineMock.state = derivePipeline({ ...base, clipCount: 8, segmentCount: 3 });
    render(<BandEmpty />);
    expect(screen.getByText("第 ③ 步:把挑好的片段排进来")).toBeTruthy();
    await act(async () => {
      screen.getByRole("button", { name: "一键排入" }).click();
      await Promise.resolve();
    });
    expect(apiMocks.arrangeSelectedSegments).toHaveBeenCalledTimes(1);
  });
  it("检查器:选一条素材查看详情(info)", () => {
    render(<InspectorEmpty />);
    expect(screen.getByText("选一条素材查看详情")).toBeTruthy();
    expect(document.querySelector(".ui-empty svg[data-icon=\"info\"]")).not.toBeNull();
  });
  it("文案表与规格 R12 §1 第三条一字不差,且没有 heading", () => {
    expect(Object.values(EMPTY_COPY).map((copy) => copy.title)).toEqual([
      "第 ① 步:先导入", "没有匹配的素材", "从左侧媒体池选一条素材",
      "第 ① 步:先导入", "第 ② 步:按 F 收藏或点自动挑选", "第 ③ 步:把挑好的片段排进来",
      "选一条素材查看详情",
    ]);
    render(<InspectorEmpty />);
    expect(screen.queryByRole("heading")).toBeNull();
  });
});

describe("R11 简化专项 #5:空态一句话 + 一个按钮", () => {
  it("镜头带无章节(第 ① 步):「打开导入」打开导入抽屉的来源分页", () => {
    render(<BandEmpty />);
    expect(screen.getByText("第 ① 步:先导入")).toBeTruthy();
    const open = screen.getByRole("button", { name: "打开导入" });
    open.click();
    expect(getWorkspaceSnapshot().openDrawer).toBe("import");
    expect(getWorkspaceSnapshot().importTab).toBe("source");
  });
  it("仅缺口视图没有缺口:「回到按章节」", () => {
    let called = 0;
    render(<BandEmpty variant="no-gaps" onAction={() => { called += 1; }} />);
    expect(screen.getByText("所有章节都没有缺口")).toBeTruthy();
    screen.getByRole("button", { name: "回到按章节" }).click();
    expect(called).toBe(1);
  });
});
