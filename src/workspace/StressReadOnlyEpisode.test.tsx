// R14 车道 stress · Z-14:只读查看已封存集时,镜头带 / 缺口按被查看的集取;导出入口变成「回到当前集再导出」。
// @vitest-environment jsdom
import { act } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMock);

import type { EpisodeSummary, Storyboard, StoryGap } from "../api";
import { RETURN_TO_EXPORT_LABEL, TopBar } from "./TopBar";
import { __resetClipsFeedForTests, getClipsFeedSnapshot, refreshClipsFeed, useClipsFeed } from "./useClipsFeed";
import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests, dispatchWorkspace, getWorkspaceSnapshot } from "./WorkspaceStore";
import { __setShowAllFeaturesForTests } from "./showAllFeatures";

const activeBoard = { chapters: [{ id: 20, title: "第 1 章", start_at: null, end_at: null, clip_count: 1 }], candidates: [], items: [{ key: "whole:9", item_kind: "whole", clip_id: 9, segment_id: null, chapter_id: 20, file_name: "IMG_0833.mov", in_ticks: 0, out_ticks: 1000, tb_num: 1, tb_den: 1000, position: 0 }] } as unknown as Storyboard;
const archivedBoard = { chapters: [{ id: 10, title: "第 1 章", start_at: null, end_at: null, clip_count: 1 }], candidates: [], items: [{ key: "whole:1", item_kind: "whole", clip_id: 1, segment_id: null, chapter_id: 10, file_name: "IMG_0830_早餐.mov", in_ticks: 0, out_ticks: 1000, tb_num: 1, tb_den: 1000, position: 0 }] } as unknown as Storyboard;

beforeEach(() => {
  // R19 P-05:这份文件描述的是「显示全部功能」打开后的形态(旅程 / 地点卡 / 模板 / 技术检查 / 快捷键 / 性能 / 云端补镜都在);默认态在 showAllFeaturesR19.test。
  __setShowAllFeaturesForTests(true);
  vi.clearAllMocks();
  __resetWorkspaceForTests();
  __resetClipsFeedForTests();
  apiMock.getCurrentEpisode.mockResolvedValue({ id: 2, title: "EP02", status: "active", export_count: 4 } as EpisodeSummary);
  apiMock.getStoryboard.mockResolvedValue(activeBoard);
  apiMock.getStoryboardOf.mockResolvedValue(archivedBoard);
  apiMock.listStoryGaps.mockResolvedValue([{ id: 1 } as StoryGap]);
  apiMock.listStoryGapsOf.mockResolvedValue([]);
  apiMock.listClips.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  __resetClipsFeedForTests();
});

describe("Z-14 feed 按被查看的集取镜头带与缺口", () => {
  it("没有只读查看时走不带集 id 的老命令;view-episode 后改调 getStoryboardOf / listStoryGapsOf(被查看的 id);回到当前集再换回", async () => {
    await refreshClipsFeed(true);
    expect(apiMock.getStoryboard).toHaveBeenCalled();
    expect(apiMock.getStoryboardOf).not.toHaveBeenCalled();
    expect(getClipsFeedSnapshot().storyboard?.items[0]?.clip_id).toBe(9);

    // 切集事件只在有订阅者时才被听;挂一个订阅者。
    const Probe = () => {
      useClipsFeed();
      return null;
    };
    render(<Probe />);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("tripcut:view-episode", { detail: { id: 1, title: "EP01" } }));
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMock.getStoryboardOf).toHaveBeenCalledWith(1));
    expect(apiMock.listStoryGapsOf).toHaveBeenCalledWith(1);
    await waitFor(() => expect(getClipsFeedSnapshot().storyboard?.items[0]?.clip_id).toBe(1));
    expect(getClipsFeedSnapshot().gaps).toEqual([]);

    apiMock.getStoryboardOf.mockClear();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("tripcut:view-episode", { detail: null }));
      await Promise.resolve();
    });
    await waitFor(() => expect(getClipsFeedSnapshot().storyboard?.items[0]?.clip_id).toBe(9));
    expect(apiMock.getStoryboardOf).not.toHaveBeenCalled();
  });
});

describe("Z-14 只读态的导出入口", () => {
  it("顶栏主按钮(AX 名不变)文案变「回到当前集再导出」,点了回到当前集而不是开导出抽屉", async () => {
    __resetWorkspaceForTests({ viewingEpisode: { id: 1, title: "EP01" } });
    render(<TopBar />);
    const next = screen.getByRole("button", { name: "流水线下一步" });
    expect(next.textContent).toBe(RETURN_TO_EXPORT_LABEL);
    expect(next.getAttribute("aria-haspopup")).toBeNull();
    const seen: unknown[] = [];
    window.addEventListener("tripcut:view-episode", (event) => seen.push((event as CustomEvent).detail));
    await act(async () => {
      next.click();
      await Promise.resolve();
    });
    expect(seen).toEqual([null]);
    expect(getWorkspaceSnapshot().openDrawer).toBeNull();
  });

  it("只读态打开导出抽屉:没有导出方式 / 主按钮,只有一句话 + 「回到当前集再导出」;点了关抽屉并回到当前集;集胶囊写「只读 · EP01」", async () => {
    __resetWorkspaceForTests({ viewingEpisode: { id: 1, title: "EP01" } });
    render(<WorkspaceShell />);
    await act(async () => {
      dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
      await Promise.resolve();
    });
    const dialog = await screen.findByRole("dialog", { name: "导出" });
    expect(within(dialog).queryByRole("group", { name: "导出方式" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "导出剪映素材包到上次文件夹" })).toBeNull();
    expect(within(dialog).getByRole("status", { name: "只读集不能导出" }).textContent).toContain("EP01");
    expect(screen.getByRole("button", { name: "切换集" }).textContent).toContain("只读 · EP01");
    await act(async () => {
      within(dialog).getByRole("button", { name: RETURN_TO_EXPORT_LABEL }).click();
      await Promise.resolve();
    });
    expect(getWorkspaceSnapshot().openDrawer).toBeNull();
    await waitFor(() => expect(getWorkspaceSnapshot().viewingEpisode).toBeNull());
    expect(apiMock.exportJianyingKit).not.toHaveBeenCalled();
    expect(apiMock.quickExport).not.toHaveBeenCalled();
  });
});
