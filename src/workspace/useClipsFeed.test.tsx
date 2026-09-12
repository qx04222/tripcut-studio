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
  getCurrentEpisode: vi.fn(),
}));
vi.mock("../api", () => apiMocks);

import type { ClipListItem } from "../api";
import {
  __resetClipsFeedForTests,
  getClipsFeedSnapshot,
  patchClipInFeed,
  refreshClipsFeed,
  useClipsFeed,
} from "./useClipsFeed";

function clip(id: number, overrides: Partial<ClipListItem> = {}): ClipListItem {
  return {
    id,
    episode_id: 1,
    folder_label: null,
    cover_url: null,
    path: `/Volumes/CARD/clip-${id}.mov`,
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
    ...overrides,
  };
}

beforeEach(() => {
  __resetClipsFeedForTests();
  apiMocks.getClipsRevision.mockResolvedValue("rev-1");
  apiMocks.listClips.mockResolvedValue([clip(7), clip(8)]);
  apiMocks.listShotStacks.mockResolvedValue([]);
  apiMocks.getStoryboard.mockResolvedValue(null);
  apiMocks.listStoryGaps.mockResolvedValue([]);
  apiMocks.listClipDimensions.mockResolvedValue([]);
  apiMocks.listAssetSafety.mockResolvedValue([]);
  apiMocks.getCurrentEpisode.mockResolvedValue({ id: 1, title: "EP01" });
});

afterEach(() => {
  cleanup();
  __resetClipsFeedForTests();
  vi.clearAllMocks();
});

describe("useClipsFeed —— 全应用唯一的 clips 修订轮询", () => {
  it("revision 没变就跳过 listClips 整表拉取,但仍刷新其余元数据", async () => {
    apiMocks.getClipsRevision.mockResolvedValue("rev-1");
    await refreshClipsFeed();
    await refreshClipsFeed();
    expect(apiMocks.listClips).toHaveBeenCalledTimes(1);
    expect(apiMocks.listShotStacks).toHaveBeenCalledTimes(2);
  });

  it("revision 变了就整表重拉", async () => {
    apiMocks.getClipsRevision.mockResolvedValueOnce("rev-1").mockResolvedValueOnce("rev-2");
    await refreshClipsFeed();
    await refreshClipsFeed();
    expect(apiMocks.listClips).toHaveBeenCalledTimes(2);
  });

  it("拿修订号本身失败就当作变了,退回全量拉取,不卡死轮询", async () => {
    apiMocks.getClipsRevision.mockRejectedValue(new Error("boom"));
    await refreshClipsFeed();
    await refreshClipsFeed();
    expect(apiMocks.listClips).toHaveBeenCalledTimes(2);
    expect(getClipsFeedSnapshot().error).toBeNull(); // 降级不是错误状态
  });

  it("三栏各订阅一次,底下只有一次真正的网络拉取", async () => {
    const Pane = () => {
      useClipsFeed();
      return null;
    };
    render(
      <>
        <Pane />
        <Pane />
        <Pane />
      </>,
    );
    await waitFor(() => expect(apiMocks.listClips).toHaveBeenCalledTimes(1));
    expect(apiMocks.getClipsRevision).toHaveBeenCalledTimes(1);
  });

  it("页面隐藏时停表,可见后立刻补跑一次", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      const Pane = () => {
        useClipsFeed();
        return null;
      };
      render(<Pane />);
      await waitFor(() => expect(apiMocks.getClipsRevision).toHaveBeenCalledTimes(1));

      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      const whileHidden = apiMocks.getClipsRevision.mock.calls.length;

      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() =>
        expect(apiMocks.getClipsRevision.mock.calls.length).toBe(whileHidden + 1),
      );
    } finally {
      visibility.mockRestore();
    }
  });

  it("patchClipInFeed 就地改一条,不触发网络", async () => {
    await refreshClipsFeed();
    apiMocks.listClips.mockClear();

    patchClipInFeed(7, { binary_rating: 1 });

    expect(getClipsFeedSnapshot().clipsById.get(7)?.binary_rating).toBe(1);
    expect(getClipsFeedSnapshot().clips.find((item) => item.id === 7)?.binary_rating).toBe(1);
    expect(apiMocks.listClips).not.toHaveBeenCalled();
  });

  it("listShotStacks 失败不拖垮 clips(allSettled 语义)", async () => {
    apiMocks.listShotStacks.mockRejectedValue(new Error("x"));
    await refreshClipsFeed();
    expect(getClipsFeedSnapshot().clips.length).toBeGreaterThan(0);
    expect(getClipsFeedSnapshot().shotStacks).toEqual([]);
  });

  it("clipsById 与 shotStackByClipId 都按 clip_id 建好索引", async () => {
    apiMocks.listShotStacks.mockResolvedValue([
      { id: 3, members: [{ clip_id: 7 }, { clip_id: 8 }] },
    ]);
    await refreshClipsFeed();
    const snapshot = getClipsFeedSnapshot();
    expect(snapshot.clipsById.get(8)?.file_name).toBe("clip-8.mov");
    expect(snapshot.shotStackByClipId.get(7)?.id).toBe(3);
    expect(snapshot.loading).toBe(false);
  });
});

describe("useClipsFeed —— 按当前集裁剪(旧壳 SelectPage.tsx「G1/项8」同一条规则)", () => {
  it("clips 只留当前集;episode_id 为空的旧数据归当前集,allClips 仍是全量", async () => {
    apiMocks.listClips.mockResolvedValue([
      clip(7, { episode_id: 1 }),
      clip(8, { episode_id: 2 }),
      clip(9, { episode_id: null }),
    ]);
    await refreshClipsFeed(true);
    const feed = getClipsFeedSnapshot();
    expect(feed.clips.map((item) => item.id)).toEqual([7, 9]);
    expect(feed.allClips.map((item) => item.id)).toEqual([7, 8, 9]);
    expect(feed.episode.activeId).toBe(1);
    expect(feed.episode.scopeId).toBe(1);
  });

  it("tripcut:view-episode 把视角切到历史集,只看那一集", async () => {
    apiMocks.listClips.mockResolvedValue([
      clip(7, { episode_id: 1 }),
      clip(8, { episode_id: 2 }),
    ]);
    const Pane = () => {
      useClipsFeed();
      return null;
    };
    render(<Pane />);
    await waitFor(() => expect(apiMocks.listClips).toHaveBeenCalledTimes(1));
    window.dispatchEvent(
      new CustomEvent("tripcut:view-episode", { detail: { id: 2, title: "EP02" } }),
    );
    await waitFor(() => expect(getClipsFeedSnapshot().episode.viewing?.id).toBe(2));
    await waitFor(() => expect(getClipsFeedSnapshot().clips.map((c) => c.id)).toEqual([8]));
  });

  it("切集事件强制重拉一次 listClips —— 修订号不变也要拉", async () => {
    const Pane = () => {
      useClipsFeed();
      return null;
    };
    render(<Pane />);
    await waitFor(() => expect(apiMocks.listClips).toHaveBeenCalledTimes(1));
    apiMocks.listClips.mockClear();

    window.dispatchEvent(
      new CustomEvent("tripcut:episode-changed", { detail: { id: 2, title: "EP02" } }),
    );
    await waitFor(() => expect(apiMocks.listClips).toHaveBeenCalledTimes(1));
    expect(getClipsFeedSnapshot().episode.viewing).toBeNull();
  });
});
