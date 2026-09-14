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
import { clipMenuItems, moveClipsToOtherEpisode } from "./clipMenuModel";
import { CLIP_MENU, EPISODE_MOVE_MENU_LABEL, EPISODE_MOVE_NEEDS_ANOTHER_EPISODE, EPISODES_UPDATED_EVENT } from "./copy";
import { MediaPool } from "./MediaPool";
import { __resetToastsForTests, getToastSnapshot } from "./ui/toastStore";
import { __resetUndoForTests, peekUndo, runUndo } from "./undoStack";
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

function episode(id: number, overrides: Partial<EpisodeSummary> = {}): EpisodeSummary {
  return {
    id, title: `EP0${id}`, theme: "", episode_number: id, status: id === 1 ? "active" : "archived", created_at: "2026-09-01T00:00:00Z",
    archived_at: id === 1 ? null : "2026-09-02T00:00:00Z", clip_count: 3, favorite_count: 0, export_count: 0,
    target_platform: "bilibili", canvas_orientation: "landscape", ...overrides,
  } as EpisodeSummary;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  __resetClipsFeedForTests();
  __resetWorkspaceForTests();
  __resetToastsForTests();
  __resetUndoForTests();
  apiMock.getClipsRevision.mockResolvedValue("rev-1");
  apiMock.listShotStacks.mockResolvedValue([]);
  apiMock.getStoryboard.mockResolvedValue({ chapters: [], candidates: [], items: [] } as unknown as Storyboard);
  apiMock.listStoryGaps.mockResolvedValue([]);
  apiMock.listClipDimensions.mockResolvedValue([]);
  apiMock.listAssetSafety.mockResolvedValue([]);
  apiMock.getCurrentEpisode.mockResolvedValue(episode(1));
  apiMock.listEpisodes.mockResolvedValue([episode(1), episode(2, { title: "京都三日", favorite_count: 2 }), episode(5, { clip_count: 0 })]);
  // 假后端:改归属并让下一次 listClips 说出新归属(feed 按集裁,真后端就是这样)。
  const owners = new Map<number, number>([[3, 1], [4, 1], [9, 1]]);
  apiMock.listClips.mockImplementation(async () => [3, 4, 9].map((id) => clip(id, { episode_id: owners.get(id)! })));
  apiMock.moveClipsToEpisode.mockImplementation(async (clipIds: readonly number[], episodeId: number) => {
    const from = clipIds.map((id) => [id, owners.get(id)!] as [number, number]);
    for (const id of clipIds) owners.set(id, episodeId);
    return { moved: clipIds.length, skipped_missing: 0, from };
  });
});
afterEach(cleanup);

const tick = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe("R17 epmove:素材菜单「移到其他集…」", () => {
  it("项目表:「移到其他集…」排在「加入镜头带」之后,AX 名「移到其他集」,多选带「(n 条)」;只有一集时禁用并说明先去首页新建一集;只读时禁用", () => {
    const single = clipMenuItems(1);
    const ids = single.map((item) => item.id);
    expect(ids.indexOf("moveToEpisode")).toBe(ids.indexOf("addToBand") + 1);
    const item = single.find((entry) => entry.id === "moveToEpisode")!;
    expect(item.label).toBe(CLIP_MENU.moveToEpisode);
    expect(item.ariaLabel).toBe("移到其他集");
    expect(item.disabled).toBe(false);
    expect(clipMenuItems(3).find((entry) => entry.id === "moveToEpisode")!.label).toBe("移到其他集(3 条)…");
    const alone = clipMenuItems(1, { episodeCount: 1 }).find((entry) => entry.id === "moveToEpisode")!;
    expect(alone.disabled).toBe(true);
    expect(alone.label).toContain(EPISODE_MOVE_NEEDS_ANOTHER_EPISODE);
    expect(alone.ariaLabel).toBe("移到其他集");
    expect(clipMenuItems(1, { readOnly: true }).find((entry) => entry.id === "moveToEpisode")!.disabled).toBe(true);
  });

  it("模型:移动 = 一次 move_clips_to_episode;媒体池那几条立刻消失;toast「已把 n 条移到「集名」」带「撤销」;撤销反向再调一次并回到池里;集卡计数事件派发", async () => {
    render(<PoolClipContextMenu multiSelection={[]} />);
    await waitFor(() => expect(getClipsFeedSnapshot().clips.length).toBe(3));
    const updated = vi.fn();
    window.addEventListener(EPISODES_UPDATED_EVENT, updated);
    act(() => {
      dispatchWorkspace({ type: "select-clip", clipId: 3 });
      dispatchWorkspace({ type: "select-clip", clipId: 4, meta: true });
    });
    await act(async () => {
      await moveClipsToOtherEpisode([3, 4], episode(2, { title: "京都三日" }));
    });
    expect(apiMock.moveClipsToEpisode).toHaveBeenCalledTimes(1);
    expect(apiMock.moveClipsToEpisode).toHaveBeenCalledWith([3, 4], 2);
    expect(getClipsFeedSnapshot().clips.map((item) => item.id)).toEqual([9]);
    expect(getWorkspaceSnapshot().multiSelection).toEqual([]);
    expect(updated).toHaveBeenCalledTimes(1);
    const toast = getToastSnapshot();
    expect(toast?.text).toBe("已把 2 条移到「京都三日」");
    expect(toast?.action?.label).toBe("撤销");
    expect(toast?.durationMs).toBe(5_000);
    expect(peekUndo()?.label).toBe("移到其他集(2 条)");

    await act(async () => {
      await runUndo();
    });
    expect(apiMock.moveClipsToEpisode).toHaveBeenCalledTimes(2);
    expect(apiMock.moveClipsToEpisode).toHaveBeenLastCalledWith([3, 4], 1);
    expect(getClipsFeedSnapshot().clips.map((item) => item.id)).toEqual([3, 4, 9]);
    expect(getToastSnapshot()?.text).toContain("已撤销");
    // toast 上的「撤销」与 ⌘Z 共用一个闭包:第二次是空操作。
    await act(async () => {
      toast!.action!.onClick();
      await Promise.resolve();
    });
    expect(apiMock.moveClipsToEpisode).toHaveBeenCalledTimes(2);
    window.removeEventListener(EPISODES_UPDATED_EVENT, updated);
  });

  it("模型:两条旧归属不同时,撤销按旧集分别送回;后端失败 toast 失败、不推撤销", async () => {
    render(<PoolClipContextMenu multiSelection={[]} />);
    await waitFor(() => expect(getClipsFeedSnapshot().clips.length).toBe(3));
    apiMock.moveClipsToEpisode.mockResolvedValueOnce({ moved: 2, skipped_missing: 1, from: [[3, 1], [4, 7]] });
    await act(async () => {
      await moveClipsToOtherEpisode([3, 4, 9], episode(2));
    });
    expect(getToastSnapshot()?.text).toBe("已把 2 条移到「EP02」");
    await act(async () => {
      await runUndo();
    });
    expect(apiMock.moveClipsToEpisode.mock.calls.slice(1)).toEqual([
      [[3], 1],
      [[4], 7],
    ]);

    __resetUndoForTests();
    apiMock.moveClipsToEpisode.mockRejectedValueOnce(new Error("目标集已不存在,回首页重新选一集"));
    await act(async () => {
      await moveClipsToOtherEpisode([9], episode(2));
    });
    expect(getToastSnapshot()?.tone).toBe("danger");
    expect(getToastSnapshot()?.text).toContain("目标集已不存在");
    expect(peekUndo()).toBeNull();
  });

  it("媒体池右键 → 「移到其他集」→ 菜单「选择目标集」列出其他集(集名 + 进度,当前集灰)→ 选中即移动", async () => {
    render(<MediaPool />);
    await waitFor(() => expect(screen.getAllByRole("gridcell").length).toBe(3));
    fireEvent.contextMenu(screen.getByRole("gridcell", { name: /clip-9/ }), { clientX: 10, clientY: 10 });
    await screen.findByRole("menu", { name: "素材操作" });
    fireEvent.click(screen.getByRole("menuitem", { name: "移到其他集" }));
    const picker = await screen.findByRole("menu", { name: EPISODE_MOVE_MENU_LABEL });
    const items = Array.from(picker.querySelectorAll<HTMLButtonElement>("[role='menuitem']"));
    expect(items.map((node) => node.textContent)).toEqual(["EP01 · 当前集", "京都三日 · 第 2 步 · 3 条素材", "EP05 · 还没开始 · 0 条素材"]);
    expect(items.map((node) => node.disabled)).toEqual([true, false, false]);
    fireEvent.click(screen.getByRole("menuitem", { name: "京都三日" }));
    await waitFor(() => expect(apiMock.moveClipsToEpisode).toHaveBeenCalledWith([9], 2));
    await tick();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(getToastSnapshot()?.text).toBe("已把 1 条移到「京都三日」");
  });

  it("检查器头部「更多」同一条路;只有一集时菜单项禁用", async () => {
    apiMock.listEpisodes.mockResolvedValue([episode(1)]);
    render(<ClipMoreButton clipId={4} multiSelection={[]} />);
    await tick();
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    const item = await screen.findByRole("menuitem", { name: "移到其他集" });
    await waitFor(() => expect((item as HTMLButtonElement).disabled).toBe(true));
    expect(item.textContent).toContain(EPISODE_MOVE_NEEDS_ANOTHER_EPISODE);
  });
});
