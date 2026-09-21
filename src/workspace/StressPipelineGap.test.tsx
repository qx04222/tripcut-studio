// R14 车道 stress · Z-03:段都排进镜头带了但还有章没镜 → 「下一步」不再死在「排到镜头带」,进到导出;缺口给次要动作「补缺口」。
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  arrangeSelectedSegments: vi.fn(async () => ({ placed: 0, chapters: 0 })),
  setSetting: vi.fn(async () => undefined),
  getSettings: vi.fn(async () => ({})),
  listEpisodes: vi.fn(async () => []),
  getCurrentEpisode: vi.fn(async () => null),
}));
vi.mock("../api", () => apiMocks);

const pipelineMock = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("./usePipeline", () => ({ usePipeline: () => pipelineMock.state }));
vi.mock("./useClipsFeed", () => ({ refreshClipsFeed: vi.fn(async () => undefined) }));

import type { ClipListItem, Storyboard } from "../api";
import { derivePipeline, pipelineGapLabel, pipelineInputFrom, pipelineNextLabel, type PipelineInput } from "./pipelineModel";
import { TopBar } from "./TopBar";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";

const base: PipelineInput = { clipCount: 21, analysisPending: 0, segmentCount: 25, chapters: [], exportCount: 0 };
// 14 章里 10 章有镜、4 章空。
const chapters = Array.from({ length: 14 }, (_, index) => ({ id: index + 1, shotCount: index < 10 ? 2 : 0 }));

beforeEach(() => __resetWorkspaceForTests());
afterEach(cleanup);

describe("derivePipeline(Z-03)", () => {
  it("段全排进去了(unplacedCount 0)、4 章空:③ 算完成,当前步 ④「下一步:导出」,缺口 4 章", () => {
    const state = derivePipeline({ ...base, chapters, unplacedCount: 0 });
    expect(state.step).toBe(4);
    expect(state.done[2]).toBe(true);
    expect(pipelineNextLabel(state)).toBe("下一步:导出");
    expect(state.counts.openChapters).toBe(4);
    expect(pipelineGapLabel(state)).toBe("补缺口 4 章");
  });
  it("还有段没排(unplacedCount > 0)且有空章:仍是 ③「排到镜头带」;不知道有没有未排的段(缺省)也不走捷径", () => {
    expect(derivePipeline({ ...base, chapters, unplacedCount: 3 }).step).toBe(3);
    expect(derivePipeline({ ...base, chapters }).step).toBe(3);
    expect(pipelineGapLabel(derivePipeline({ ...base, chapters, unplacedCount: 3 }))).toBeNull();
  });
  it("一章都没镜时段虽全排进去了也不算(没东西可导)", () => {
    const empty = chapters.map((chapter) => ({ ...chapter, shotCount: 0 }));
    expect(derivePipeline({ ...base, chapters: empty, unplacedCount: 0 }).step).toBe(3);
  });
  it("每章都满时没有「补缺口」;pipelineInputFrom 把 storyboard.candidates 数进 unplacedCount", () => {
    const full = derivePipeline({ ...base, chapters: chapters.slice(0, 10), unplacedCount: 0 });
    expect(pipelineGapLabel(full)).toBeNull();
    const board = { chapters: [], items: [], candidates: [{ clip_id: 1 }, { clip_id: 2 }] } as unknown as Storyboard;
    const videos = [{ id: 1, kind: "video" }, { id: 2, kind: "video" }] as ClipListItem[];
    expect(pipelineInputFrom(videos, board, null).unplacedCount).toBe(2);
    expect(pipelineInputFrom([], null, null).unplacedCount).toBe(0);
  });
});

describe("顶栏(Z-03)", () => {
  it("主按钮「下一步:导出」开导出抽屉;旁边 ghost「补缺口 4 章」(AX 名「补缺口」)聚焦镜头带,不开抽屉", () => {
    pipelineMock.state = derivePipeline({ ...base, chapters, unplacedCount: 0 });
    render(<TopBar />);
    const next = screen.getByRole("button", { name: "流水线下一步" });
    expect(next.textContent).toBe("下一步:导出");
    const gap = screen.getByRole("button", { name: "补缺口" });
    expect(gap.textContent).toBe("补缺口 4 章");
    gap.click();
    expect(getWorkspaceSnapshot().openDrawer).toBeNull();
    expect(getWorkspaceSnapshot().focusedPane).toBe("band");
    next.click();
    expect(getWorkspaceSnapshot().openDrawer).toBe("deliver");
    expect(document.querySelectorAll(".workspace-topbar .ui-button--primary")).toHaveLength(1);
  });
  it("没有缺口时没有「补缺口」按钮", () => {
    pipelineMock.state = derivePipeline({ ...base, chapters: chapters.slice(0, 10), unplacedCount: 0 });
    render(<TopBar />);
    expect(screen.queryByRole("button", { name: "补缺口" })).toBeNull();
  });
});
