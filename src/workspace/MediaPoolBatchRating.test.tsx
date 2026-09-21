// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R16 车道 B P1-5:多选批量评级 —— 热键 F/X/1–5/0 在多选(>1 条)时作用于整组(一次 `rate_clips`),
 * 卡片菜单「收藏 / 拒绝 / 清除评级(n 条)」,toast「已对 n 条…」+「撤销」回写旧值,并推进 ⌘Z 栈(tripcut:undo-push)。
 */

const apiMock = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMock);

import type { ClipListItem, ClipRatingEntry } from "../api";
import { batchRatingEntries, batchRatingToast, restoreEntries } from "./batchRating";
import { MediaPool } from "./MediaPool";
import { ToastHost } from "./ui/Toast";
import { __resetToastsForTests } from "./ui/toastStore";
import { __resetClipsFeedForTests, getClipsFeedSnapshot } from "./useClipsFeed";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";
import { __resetQuickExportForTests } from "./deliver/quickExportModel";

function clip(id: number, overrides: Partial<ClipListItem> = {}): ClipListItem {
  return {
    kind: "video",
    id,
    episode_id: 1,
    folder_label: null,
    cover_url: null,
    path: `/Volumes/CARD/clip-${id}.mov`,
    file_name: `clip-${id}.mov`,
    byte_size: 2048,
    quick_hash: null,
    full_hash: null,
    tb_num: 1,
    tb_den: 1000,
    duration_ticks: 12_000,
    fps_num: 25,
    fps_den: 1,
    is_vfr: false,
    codec: "h264",
    width: 1920,
    height: 1080,
    captured_at: null,
    status: "ready",
    error: null,
    analysis: null,
    analysis_status: null,
    analysis_error: null,
    motion: null,
    motion_status: null,
    motion_error: null,
    binary_rating: null,
    star_rating: null,
    select_count: 0,
    ...overrides,
  } as ClipListItem;
}

const pushed: { label: string; undo: () => Promise<void> }[] = [];
const onPush = (event: Event) => pushed.push((event as CustomEvent).detail);

beforeEach(() => {
  vi.clearAllMocks();
  __resetToastsForTests();
  __resetClipsFeedForTests();
  __resetWorkspaceForTests();
  __resetQuickExportForTests();
  pushed.length = 0;
  window.addEventListener("tripcut:undo-push", onPush);
  apiMock.getClipsRevision.mockResolvedValue("rev-1" as never);
  apiMock.listClips.mockResolvedValue([clip(1, { binary_rating: 1, star_rating: 3 }), clip(2), clip(3, { binary_rating: -1 })]);
  apiMock.getCurrentEpisode.mockResolvedValue({ id: 1, title: "EP01" } as never);
  apiMock.rateClips.mockResolvedValue([]);
});
afterEach(() => {
  window.removeEventListener("tripcut:undo-push", onPush);
  cleanup();
});

async function renderPool(): Promise<void> {
  render(<><MediaPool /><ToastHost /></>);
  await waitFor(() => expect(screen.getAllByRole("gridcell").length).toBe(3));
}

async function selectAll(): Promise<void> {
  fireEvent.click(screen.getByRole("gridcell", { name: /clip-1\.mov/ }));
  await waitFor(() => expect(getWorkspaceSnapshot().multiSelection).toEqual([1]));
  fireEvent.click(screen.getByRole("gridcell", { name: /clip-3\.mov/ }), { shiftKey: true });
  await waitFor(() => expect(getWorkspaceSnapshot().multiSelection).toEqual([1, 2, 3]));
}

describe("纯函数:批量条目与撤销回写", () => {
  it("收藏 / 拒绝 / 星级各一条;清除 = 每条 binary 0 + star 0", () => {
    expect(batchRatingEntries([1, 2], { kind: "binary", value: 1 })).toEqual([
      { clip_id: 1, rating_type: "binary", value: 1 },
      { clip_id: 2, rating_type: "binary", value: 1 },
    ]);
    expect(batchRatingEntries([5], { kind: "star", value: 4 })).toEqual([{ clip_id: 5, rating_type: "star", value: 4 }]);
    expect(batchRatingEntries([7], { kind: "clear" })).toEqual([
      { clip_id: 7, rating_type: "binary", value: 0 },
      { clip_id: 7, rating_type: "star", value: 0 },
    ]);
  });

  it("回写旧值:没评过(null)写 0;两维都回写", () => {
    expect(restoreEntries([{ clip_id: 1, binary_rating: 1, star_rating: null }, { clip_id: 2, binary_rating: null, star_rating: 5 }])).toEqual([
      { clip_id: 1, rating_type: "binary", value: 1 },
      { clip_id: 1, rating_type: "star", value: 0 },
      { clip_id: 2, rating_type: "binary", value: 0 },
      { clip_id: 2, rating_type: "star", value: 5 },
    ]);
  });

  it("toast 文案「已对 n 条…」", () => {
    expect(batchRatingToast(3, { kind: "binary", value: 1 })).toBe("已对 3 条收藏");
    expect(batchRatingToast(3, { kind: "binary", value: -1 })).toBe("已对 3 条拒绝");
    expect(batchRatingToast(2, { kind: "star", value: 4 })).toBe("已对 2 条打 4 星");
    expect(batchRatingToast(5, { kind: "clear" })).toBe("已对 5 条清除评级");
  });
});

describe("热键作用于多选", () => {
  it("⇧ 连选 3 条后按 X → 一次 rateClips(3 条 binary -1);toast 带「撤销」→ 回写旧值;推一条 ⌘Z", async () => {
    await renderPool();
    await selectAll();
    const card = screen.getByRole("gridcell", { name: /clip-3\.mov/ });
    card.focus();
    await act(async () => {
      fireEvent.keyDown(card, { key: "x", code: "KeyX" });
    });
    await waitFor(() => expect(apiMock.rateClips).toHaveBeenCalledTimes(1));
    expect(apiMock.rateClips.mock.calls[0]![0]).toEqual([
      { clip_id: 1, rating_type: "binary", value: -1 },
      { clip_id: 2, rating_type: "binary", value: -1 },
      { clip_id: 3, rating_type: "binary", value: -1 },
    ]);
    expect(apiMock.rateClip).not.toHaveBeenCalled();
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("已对 3 条拒绝");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.label).toContain("3 条");

    await act(async () => {
      fireEvent.click(within(toast).getByRole("button", { name: "撤销" }));
    });
    await waitFor(() => expect(apiMock.rateClips).toHaveBeenCalledTimes(2));
    const restored = apiMock.rateClips.mock.calls[1]![0] as ClipRatingEntry[];
    expect(restored).toEqual([
      { clip_id: 1, rating_type: "binary", value: 1 },
      { clip_id: 1, rating_type: "star", value: 3 },
      { clip_id: 2, rating_type: "binary", value: 0 },
      { clip_id: 2, rating_type: "star", value: 0 },
      { clip_id: 3, rating_type: "binary", value: -1 },
      { clip_id: 3, rating_type: "star", value: 0 },
    ]);
    expect(getClipsFeedSnapshot().clipsById.get(1)?.binary_rating).toBe(1);
    // 同一批只撤一次:⌘Z 栈里那条再跑也不再发命令。
    await pushed[0]!.undo();
    expect(apiMock.rateClips).toHaveBeenCalledTimes(2);
  });

  it("只选中 1 条时按 F 仍走单条 rateClip(行为不变,不出 toast)", async () => {
    await renderPool();
    const card = screen.getByRole("gridcell", { name: /clip-2\.mov/ });
    fireEvent.click(card);
    await waitFor(() => expect(getWorkspaceSnapshot().multiSelection).toEqual([2]));
    card.focus();
    await act(async () => {
      fireEvent.keyDown(card, { key: "f", code: "KeyF" });
    });
    await waitFor(() => expect(apiMock.rateClip).toHaveBeenCalledWith(2, "binary", 1));
    expect(apiMock.rateClips).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("rateClips 抛错 → toast「批量评级没成功」,乐观补丁回滚(整体重取)", async () => {
    apiMock.rateClips.mockRejectedValueOnce(new Error("只读集"));
    await renderPool();
    await selectAll();
    const card = screen.getByRole("gridcell", { name: /clip-3\.mov/ });
    card.focus();
    await act(async () => {
      fireEvent.keyDown(card, { key: "5", code: "Digit5" });
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("批量评级没成功:只读集"));
    expect(pushed).toHaveLength(0);
    await waitFor(() => expect(getClipsFeedSnapshot().clipsById.get(2)?.star_rating).toBeNull());
  });
});

describe("卡片菜单的三项(n 条)", () => {
  it("右键多选中的卡 → 菜单「素材操作」含「收藏(3 条)」「拒绝(3 条)」「清除评级(3 条)」;点「清除评级」→ rateClips(6 条 0)", async () => {
    await renderPool();
    await selectAll();
    fireEvent.contextMenu(screen.getByRole("gridcell", { name: /clip-2\.mov/ }), { clientX: 10, clientY: 10 });
    const menu = screen.getByRole("menu", { name: "素材操作" });
    expect(within(menu).getByRole("menuitem", { name: "收藏" }).textContent).toBe("收藏(3 条)");
    expect(within(menu).getByRole("menuitem", { name: "拒绝" }).textContent).toBe("拒绝(3 条)");
    expect(within(menu).getByRole("menuitem", { name: "清除评级" }).textContent).toBe("清除评级(3 条)");
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "清除评级" }));
    });
    await waitFor(() => expect(apiMock.rateClips).toHaveBeenCalledTimes(1));
    expect((apiMock.rateClips.mock.calls[0]![0] as ClipRatingEntry[]).length).toBe(6);
    expect((await screen.findByRole("status")).textContent).toContain("已对 3 条清除评级");
  });

  it("右键不在多选里的卡 → 只对它一张,项目名不带「(n 条)」", async () => {
    await renderPool();
    fireEvent.contextMenu(screen.getByRole("gridcell", { name: /clip-2\.mov/ }), { clientX: 10, clientY: 10 });
    const menu = screen.getByRole("menu", { name: "素材操作" });
    expect(within(menu).getByRole("menuitem", { name: "收藏" }).textContent).toBe("收藏");
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "收藏" }));
    });
    await waitFor(() => expect(apiMock.rateClips).toHaveBeenCalledWith([{ clip_id: 2, rating_type: "binary", value: 1 }]));
  });
});
