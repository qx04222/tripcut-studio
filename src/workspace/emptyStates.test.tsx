// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BandEmpty, EMPTY_COPY, InspectorEmpty, MonitorEmpty, PoolEmpty, PoolFilteredEmpty } from "./emptyStates";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";

beforeEach(() => __resetWorkspaceForTests());
afterEach(cleanup);

/*
 * 规格 §3.4 那张表的组件级断言。任务书里这些用例原本挂在 MediaPool / Monitor /
 * ShotBand / Inspector 的测试文件上;栏本体归别的车道,断言先在这里落地,
 * 栏本体接线后各自的测试文件再按「渲染栏 → 找同一句文案」追加。
 */
describe("四栏空状态(EmptyState)", () => {
  it("空池:还没有素材 + 「导入素材」按钮打开导入抽屉的来源分页", () => {
    render(<PoolEmpty />);
    expect(screen.getByText("还没有素材").tagName).toBe("P");
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
  it("镜头带:还没有章节(grip)", () => {
    render(<BandEmpty />);
    expect(screen.getByText("还没有章节")).toBeTruthy();
    expect(document.querySelector(".ui-empty svg[data-icon=\"grip\"]")).not.toBeNull();
  });
  it("检查器:选一条素材查看详情(info)", () => {
    render(<InspectorEmpty />);
    expect(screen.getByText("选一条素材查看详情")).toBeTruthy();
    expect(document.querySelector(".ui-empty svg[data-icon=\"info\"]")).not.toBeNull();
  });
  it("文案表与规格 §3.4 一字不差,且没有 heading", () => {
    expect(Object.values(EMPTY_COPY).map((copy) => copy.title)).toEqual([
      "还没有素材", "没有匹配的素材", "从左侧媒体池选一条素材", "还没有章节", "选一条素材查看详情",
    ]);
    render(<InspectorEmpty />);
    expect(screen.queryByRole("heading")).toBeNull();
  });
});

describe("R11 简化专项 #5:空态一句话 + 一个按钮", () => {
  it("镜头带无章节:「打开导入」打开导入抽屉的来源分页", () => {
    render(<BandEmpty />);
    expect(screen.getByText("还没有章节")).toBeTruthy();
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
