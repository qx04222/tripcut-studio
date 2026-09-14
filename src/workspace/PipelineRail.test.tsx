// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  arrangeSelectedSegments: vi.fn(async () => ({ placed: 0, chapters: 0 })),
  setSetting: vi.fn(async () => undefined),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock("../api", () => apiMocks);
vi.mock("./useClipsFeed", () => ({ refreshClipsFeed: vi.fn(async () => undefined) }));

import { PipelineRail } from "./PipelineRail";
import { derivePipeline, type PipelineInput } from "./pipelineModel";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";

const base: PipelineInput = { clipCount: 0, analysisPending: 0, segmentCount: 0, chapters: [], exportCount: 0 };

beforeEach(() => __resetWorkspaceForTests());
afterEach(cleanup);

describe("PipelineRail(规格 §1 第一条)", () => {
  it("nav 名「流水线」;四个按钮名固定「第 n 步 导入/挑选/排列/导出」,计数不进 AX 名", () => {
    render(<PipelineRail state={derivePipeline({ ...base, clipCount: 21, segmentCount: 4, chapters: [{ id: 1, shotCount: 1 }, { id: 2, shotCount: 0 }] })} />);
    const nav = screen.getByRole("navigation", { name: "流水线" });
    const names = within(nav).getAllByRole("button").map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual(["第 1 步 导入", "第 2 步 挑选", "第 3 步 排列", "第 4 步 导出"]);
    // 计数是视觉文本:「21 条」「4 段」「1/2 章」。
    expect(nav.textContent).toContain("21 条");
    expect(nav.textContent).toContain("4 段");
    expect(nav.textContent).toContain("1/2 章");
  });

  it("当前步带 aria-current=step,已完成步打勾(check 图标),未开始步灰", () => {
    render(<PipelineRail state={derivePipeline({ ...base, clipCount: 21, segmentCount: 4 })} />);
    const step1 = screen.getByRole("button", { name: "第 1 步 导入" });
    const step3 = screen.getByRole("button", { name: "第 3 步 排列" });
    const step4 = screen.getByRole("button", { name: "第 4 步 导出" });
    expect(step3.getAttribute("aria-current")).toBe("step");
    expect(step1.getAttribute("aria-current")).toBeNull();
    expect(step1.querySelector("svg[data-icon='check']")).not.toBeNull();
    expect(step3.querySelector("svg[data-icon='check']")).toBeNull();
    expect(step4.closest("li")?.className).toContain("pipeline-rail-item--todo");
    expect(step1.closest("li")?.className).toContain("pipeline-rail-item--done");
    expect(screen.getAllByRole("button").filter((button) => button.getAttribute("aria-current") === "step")).toHaveLength(1);
  });

  it("分析中的 ①:走过了但没打勾 → pending 样式(虚线圈),数字保留,计数「18/21 条」", () => {
    render(<PipelineRail state={derivePipeline({ ...base, clipCount: 21, analysisPending: 3 })} />);
    const step1 = screen.getByRole("button", { name: "第 1 步 导入" });
    expect(step1.closest("li")?.className).toContain("pipeline-rail-item--pending");
    expect(step1.querySelector("svg")).toBeNull();
    expect(step1.textContent).toContain("18/21 条");
    expect(screen.getByRole("button", { name: "第 2 步 挑选" }).getAttribute("aria-current")).toBe("step");
  });

  it("点击把焦点带到该步:① 开导入抽屉(来源页)/ ② 聚焦媒体池 / ③ 聚焦镜头带 / ④ 开导出抽屉", () => {
    render(
      <>
        <div data-pane="pool" tabIndex={-1} />
        <div data-pane="band" tabIndex={-1} />
        <PipelineRail state={derivePipeline(base)} />
      </>,
    );
    screen.getByRole("button", { name: "第 1 步 导入" }).click();
    expect(getWorkspaceSnapshot().openDrawer).toBe("import");
    expect(getWorkspaceSnapshot().importTab).toBe("source");
    screen.getByRole("button", { name: "第 2 步 挑选" }).click();
    expect(getWorkspaceSnapshot().focusedPane).toBe("pool");
    expect(document.activeElement?.getAttribute("data-pane")).toBe("pool");
    screen.getByRole("button", { name: "第 3 步 排列" }).click();
    expect(getWorkspaceSnapshot().focusedPane).toBe("band");
    expect(document.activeElement?.getAttribute("data-pane")).toBe("band");
    screen.getByRole("button", { name: "第 4 步 导出" }).click();
    expect(getWorkspaceSnapshot().openDrawer).toBe("deliver");
  });

  it("1280 以下只显示数字与勾:名字与计数由 CSS 媒体查询隐藏(样式文件里有这条规则)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const css = readFileSync(resolve(process.cwd(), "src/styles/workspace/shell-r12.css"), "utf8");
    expect(css).toMatch(/@media \(width <= 1280px\)[\s\S]*\.pipeline-rail-name,[\s\S]*\.pipeline-rail-count \{\s*display: none;/);
  });
});
