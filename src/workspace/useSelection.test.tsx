// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getClipsRevision: vi.fn(),
  listClips: vi.fn(),
  listShotStacks: vi.fn(),
  getStoryboard: vi.fn(),
  listStoryGaps: vi.fn(),
  listClipDimensions: vi.fn(),
  listAssetSafety: vi.fn(),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../api", () => apiMocks);

import type { ClipListItem } from "../api";
import { __resetClipsFeedForTests } from "./useClipsFeed";
import { echoElementId, extendMultiSelection, useSelection, type SelectionView } from "./useSelection";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";

function clip(id: number): ClipListItem {
  return {
    id,
    episode_id: 1,
    folder_label: null,
    cover_url: null,
    path: `/card/clip-${id}.mov`,
    file_name: `clip-${id}.mov`,
    byte_size: 1024,
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
  };
}

const gap = {
  id: 9,
  chapter_id: 3,
  chapter_title: "冰原大道",
  beat_id: null,
  slot: "ATMOSPHERE",
  slot_label_zh: "氛围",
  reason: "本章缺一条氛围镜头",
  status: "open" as const,
  latest_request: null,
};

beforeEach(() => {
  __resetClipsFeedForTests();
  __resetWorkspaceForTests();
  apiMocks.getClipsRevision.mockResolvedValue("rev-1");
  apiMocks.listClips.mockResolvedValue([clip(1), clip(2), clip(3)]);
  apiMocks.listShotStacks.mockResolvedValue([
    {
      id: 12,
      members: [
        { clip_id: 1, is_preferred: true },
        { clip_id: 2, is_preferred: false },
      ],
    },
  ]);
  apiMocks.getStoryboard.mockResolvedValue(null);
  apiMocks.listStoryGaps.mockResolvedValue([gap]);
  apiMocks.listClipDimensions.mockResolvedValue([]);
  apiMocks.listAssetSafety.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  __resetClipsFeedForTests();
  __resetWorkspaceForTests();
  vi.clearAllMocks();
});

function Harness({ onReady }: { onReady: (view: SelectionView) => void }) {
  const view = useSelection([1, 2, 3]);
  onReady(view);
  return null;
}

async function mountSelection(): Promise<() => SelectionView> {
  let latest: SelectionView | undefined;
  render(<Harness onReady={(view) => (latest = view)} />);
  await waitFor(() => expect(apiMocks.listClips).toHaveBeenCalled());
  await waitFor(() => expect(latest!.selection).toBeDefined());
  return () => latest!;
}

describe("extendMultiSelection —— ⇧⌘ 多选锚点", () => {
  it("⇧ 连选取可见顺序里锚点到目标的闭区间", () => {
    const r = extendMultiSelection([1, 2, 3, 4, 5], [2], 2, 4, { shift: true });
    expect(r.ids).toEqual([2, 3, 4]);
    expect(r.anchor).toBe(4);
  });
  it("⇧ 反向连选同样闭区间", () => {
    expect(extendMultiSelection([1, 2, 3, 4, 5], [4], 4, 2, { shift: true }).ids).toEqual([2, 3, 4]);
  });
  it("⌘ 点选切换单项,已选则移除", () => {
    expect(extendMultiSelection([1, 2, 3], [1, 2], 2, 2, { meta: true }).ids).toEqual([1]);
  });
  it("裸点清空多选", () => {
    expect(extendMultiSelection([1, 2, 3], [1, 2], 2, 3, {}).ids).toEqual([3]);
  });
  it("闭区间取的是可见顺序而不是 id 数值区间", () => {
    // 网格按拍摄时间排 + 被筛选裁过:可见顺序 9→4→7,id 相邻不等于视觉相邻。
    const r = extendMultiSelection([9, 4, 7], [9], 9, 7, { shift: true });
    expect(r.ids).toEqual([9, 4, 7]);
  });
  it("锚点已不在可见列表里就退回单选,不凭 id 瞎连", () => {
    expect(extendMultiSelection([4, 7], [99], 99, 7, { shift: true }).ids).toEqual([7]);
  });
});

describe("echoElementId —— 跨栏回显", () => {
  it("两栏的回显 id 规则一致,互相找得到", () => {
    expect(echoElementId({ kind: "clip", clipId: 7 }, "pool")).toBe("pool-clip-7");
    expect(echoElementId({ kind: "clip", clipId: 7 }, "band")).toBe("band-clip-7");
    expect(echoElementId({ kind: "slot", chapterId: 3, slot: "ATMOSPHERE" }, "band")).toBe(
      "band-slot-3-ATMOSPHERE",
    );
    expect(echoElementId({ kind: "slot", chapterId: 3, slot: "ATMOSPHERE" }, "pool")).toBeNull();
    expect(echoElementId(null, "pool")).toBeNull();
  });
});

describe("useSelection —— 三栏共享的选择视图", () => {
  it("选中素材时把 clip、所属 Stack 与 Stack 成员一起解出来", async () => {
    const view = await mountSelection();
    view().selectClip(2);
    await waitFor(() => expect(view().selectedClip?.id).toBe(2));
    expect(view().selectedStack?.id).toBe(12);
    expect(view().selectedStackMember?.clip_id).toBe(2);
    expect(view().selectedGap).toBeNull();
  });

  it("选中镜头带里的空槽位时 selectedClip 为 null 而 selectedGap 非空", async () => {
    const view = await mountSelection();
    view().selectSlot(3, "ATMOSPHERE");
    await waitFor(() => expect(view().selection?.kind).toBe("slot"));
    expect(view().selectedClip).toBeNull();
    expect(view().selectedStack).toBeNull();
    expect(view().selectedGap?.slot_label_zh).toBe("氛围");
  });

  it("多选时监视器与检查器只跟锚点项(最后一次点击)", async () => {
    const view = await mountSelection();
    view().selectClip(1);
    await waitFor(() => expect(view().multiSelection).toEqual([1]));
    view().selectClip(3, { shift: true });
    await waitFor(() => expect(view().multiSelection).toEqual([1, 2, 3]));
    // 三条都在多选里,但 selection —— 监视器与检查器读的那一条 —— 是最后点的。
    expect(view().selection).toEqual({ kind: "clip", clipId: 3 });
    expect(view().selectedClip?.id).toBe(3);
    expect(getWorkspaceSnapshot().anchorClipId).toBe(3);
  });

  it("clear 清掉选择与多选", async () => {
    const view = await mountSelection();
    view().selectClip(2);
    await waitFor(() => expect(view().selection).not.toBeNull());
    view().clear();
    await waitFor(() => expect(view().selection).toBeNull());
    expect(view().multiSelection).toEqual([]);
  });

  it("另一栏渲染了同一条素材时按 echo id 把它滚进视野", async () => {
    const echo = document.createElement("div");
    echo.id = "band-clip-2";
    const scrollIntoView = vi.fn();
    echo.scrollIntoView = scrollIntoView;
    document.body.append(echo);
    try {
      const view = await mountSelection();
      view().selectClip(2);
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" }));
    } finally {
      echo.remove();
    }
  });
});
