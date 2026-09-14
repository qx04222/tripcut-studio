// @vitest-environment jsdom
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMock);

import type { ClipListItem, EpisodeSummary, Storyboard } from "../api";
import { ClipMoreButton, PoolClipContextMenu } from "./ClipMenu";
import { clipMenuItems, rateClips } from "./clipMenuModel";
import { __resetClipRemovalForTests } from "./clipRemoval";
import { ClipRemovalHost } from "./ClipRemovalHost";
import { CLIP_MENU, REMOVAL_CONFIRM_BUTTON, REMOVAL_CONFIRM_LABEL } from "./copy";
import { MediaPool } from "./MediaPool";
import { __resetToastsForTests, getToastSnapshot } from "./ui/toastStore";
import { __resetUndoForTests, runUndo } from "./undoStack";
import { __resetClipsFeedForTests, getClipsFeedSnapshot } from "./useClipsFeed";
import { __resetWorkspaceForTests, dispatchWorkspace, getWorkspaceSnapshot } from "./WorkspaceStore";

function clip(id: number, overrides: Partial<ClipListItem> = {}): ClipListItem {
  return {
    id, episode_id: 1, folder_label: null, cover_url: null, path: `/Volumes/CARD/clip-${id}.mov`, file_name: `clip-${id}.mov`,
    byte_size: 1, quick_hash: null, full_hash: null, tb_num: 1, tb_den: 1000, duration_ticks: 12_000, fps_num: 25, fps_den: 1,
    is_vfr: false, codec: "h264", width: 1920, height: 1080, captured_at: null, status: "ready", error: null, analysis: null,
    analysis_status: null, analysis_error: null, motion: null, motion_status: null, motion_error: null,
    binary_rating: null, star_rating: null, select_count: 0, ...overrides,
  } as ClipListItem;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  __resetClipsFeedForTests();
  __resetWorkspaceForTests();
  __resetClipRemovalForTests();
  __resetToastsForTests();
  __resetUndoForTests();
  apiMock.getClipsRevision.mockResolvedValue("rev-1");
  apiMock.listClips.mockResolvedValue([clip(3, { binary_rating: 1 }), clip(4, { star_rating: 4 }), clip(9)]);
  apiMock.listShotStacks.mockResolvedValue([]);
  apiMock.getStoryboard.mockResolvedValue({ chapters: [], candidates: [], items: [] } as unknown as Storyboard);
  apiMock.listStoryGaps.mockResolvedValue([]);
  apiMock.listClipDimensions.mockResolvedValue([]);
  apiMock.listAssetSafety.mockResolvedValue([]);
  apiMock.getCurrentEpisode.mockResolvedValue({ id: 1, title: "EP01" } as unknown as EpisodeSummary);
  apiMock.previewImportRemoval.mockResolvedValue({ clips: 2, favorites: 1, selections: 3, cache_entries: 4 });
  apiMock.removeImportedMaterial.mockResolvedValue(2);
});
afterEach(cleanup);

const tick = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe("R16 §1 / P1-1:素材卡菜单", () => {
  it("项目表按规格顺序(七项,含「在 Finder 中显示」),AX 名是基名;多选带「(n 条)」(只显示一张的「在 Finder 中显示」不带);只读时改数据的项禁用、导出照常;canReveal:false 才不出「在 Finder 中显示」", () => {
    const single = clipMenuItems(1);
    expect(single.map((item) => item.ariaLabel)).toEqual(["收藏", "拒绝", "清除评级", "加入镜头带", "导出所选", "在 Finder 中显示", "移除素材"]);
    expect(single.map((item) => item.label)).toEqual(Object.values(CLIP_MENU));
    const noReveal = clipMenuItems(1, { canReveal: false });
    expect(noReveal.map((item) => item.label)).toEqual(Object.values(CLIP_MENU).filter((label) => label !== CLIP_MENU.reveal));
    const multi = clipMenuItems(3, { canReveal: true });
    expect(multi.map((item) => item.label)).toEqual(["收藏(3 条)", "拒绝(3 条)", "清除评级(3 条)", "加入镜头带(3 条)", "导出所选(3 条)…", "在 Finder 中显示", "移除素材(3 条)…"]);
    const readOnly = clipMenuItems(1, { readOnly: true });
    expect(readOnly.filter((item) => item.disabled).map((item) => item.id)).toEqual(["favorite", "reject", "clear", "addToBand", "remove"]);
  });

  it("媒体池右键:菜单「素材操作」列全七项;「移除素材…」→ 预览 → 确认卡列后果数字 → 确认后调命令、本地拿掉、清选择、toast", async () => {
    render(
      <>
        <MediaPool />
        <ClipRemovalHost />
      </>,
    );
    await waitFor(() => expect(screen.getAllByRole("gridcell").length).toBe(3));
    act(() => {
      dispatchWorkspace({ type: "select-clip", clipId: 3 });
      dispatchWorkspace({ type: "select-clip", clipId: 4, meta: true });
    });
    fireEvent.contextMenu(screen.getByRole("gridcell", { name: /clip-3/ }), { clientX: 10, clientY: 10 });
    const menu = await screen.findByRole("menu", { name: "素材操作" });
    expect(Array.from(menu.querySelectorAll("[role='menuitem']")).map((node) => node.textContent)).toEqual([
      "收藏(2 条)", "拒绝(2 条)", "清除评级(2 条)", "加入镜头带(2 条)", "导出所选(2 条)…", "在 Finder 中显示", "移除素材(2 条)…",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "移除素材" }));
    const dialog = await screen.findByRole("alertdialog", { name: REMOVAL_CONFIRM_LABEL });
    expect(apiMock.previewImportRemoval).toHaveBeenCalledWith({ batch_id: null, clip_ids: [3, 4], all: false });
    expect(dialog.textContent).toContain("将移除 2 条素材、1 条评分记录、3 个精选段和 4 项缓存记录");
    expect(dialog.textContent).toContain("从当前集移除这 2 条素材");
    expect(apiMock.removeImportedMaterial).not.toHaveBeenCalled();

    // 后端删完之后再轮询,列表里只剩 9;本地拿掉不等这一轮。
    apiMock.listClips.mockResolvedValue([clip(9)]);
    fireEvent.click(screen.getByRole("button", { name: REMOVAL_CONFIRM_BUTTON }));
    await waitFor(() => expect(apiMock.removeImportedMaterial).toHaveBeenCalledWith({ batch_id: null, clip_ids: [3, 4], all: false }));
    await tick();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(getClipsFeedSnapshot().clips.map((item) => item.id)).toEqual([9]);
    expect(getWorkspaceSnapshot().multiSelection).toEqual([]);
    expect(getToastSnapshot()?.text).toContain("已移除 2 条素材");
  });

  it("「取消」只关卡不调命令;右键点在多选之外的卡上只作用于它一张", async () => {
    render(
      <>
        <MediaPool />
        <ClipRemovalHost />
      </>,
    );
    await waitFor(() => expect(screen.getAllByRole("gridcell").length).toBe(3));
    fireEvent.contextMenu(screen.getByRole("gridcell", { name: /clip-9/ }), { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "移除素材" }));
    await screen.findByRole("alertdialog");
    expect(apiMock.previewImportRemoval).toHaveBeenCalledWith({ batch_id: null, clip_ids: [9], all: false });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await tick();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(apiMock.removeImportedMaterial).not.toHaveBeenCalled();
  });

  it("检查器头部「更多」弹同一张菜单;导出所选走快速导出", async () => {
    render(<ClipMoreButton clipId={4} multiSelection={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    const menu = await screen.findByRole("menu", { name: "素材操作" });
    expect(Array.from(menu.querySelectorAll("[role='menuitem']")).map((node) => node.getAttribute("aria-label"))).toEqual(
      clipMenuItems(1).map((item) => item.ariaLabel),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "导出所选" }));
    await tick();
    expect(getWorkspaceSnapshot().openDrawer).toBe("deliver");
  });

  it("收藏 / 拒绝 / 清除评级作用于整组(一次 rate_clips),撤销回写旧值(与热键同一条路)", async () => {
    render(<PoolClipContextMenu multiSelection={[]} />);
    await tick();
    apiMock.rateClips.mockResolvedValue([]);
    await act(async () => {
      await rateClips([3, 4, 9], "reject");
    });
    // 整组一次 IPC,不再逐条 rate_clip。
    expect(apiMock.rateClip).not.toHaveBeenCalled();
    expect(apiMock.rateClips).toHaveBeenCalledTimes(1);
    expect(apiMock.rateClips.mock.calls[0]![0]).toEqual([
      { clip_id: 3, rating_type: "binary", value: -1 },
      { clip_id: 4, rating_type: "binary", value: -1 },
      { clip_id: 9, rating_type: "binary", value: -1 },
    ]);
    await act(async () => {
      await runUndo();
    });
    // 3 原本收藏、4 原本 4 星、9 原本未评 —— 各回各的旧值(binary + star 成对回写)。
    expect(apiMock.rateClips).toHaveBeenCalledTimes(2);
    expect(apiMock.rateClips.mock.calls[1]![0]).toEqual([
      { clip_id: 3, rating_type: "binary", value: 1 },
      { clip_id: 3, rating_type: "star", value: 0 },
      { clip_id: 4, rating_type: "binary", value: 0 },
      { clip_id: 4, rating_type: "star", value: 4 },
      { clip_id: 9, rating_type: "binary", value: 0 },
      { clip_id: 9, rating_type: "star", value: 0 },
    ]);
  });
});
