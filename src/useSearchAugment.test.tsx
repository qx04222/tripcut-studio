// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  listClips: vi.fn().mockResolvedValue([]),
  listClipDimensions: vi.fn().mockResolvedValue([]),
  getStoryboard: vi.fn().mockResolvedValue(null),
  getCurrentEpisode: vi.fn().mockResolvedValue({ id: 100 }),
  listEpisodes: vi.fn().mockResolvedValue([{ id: 100, title: "当前集" }]),
  getClipsRevision: vi.fn().mockResolvedValue("rev-1"),
  // R8 Task 2:拼音索引现在跟着 useClipsFeed 走,feed 会把这几条也一起拉。
  listShotStacks: vi.fn().mockResolvedValue([]),
  listStoryGaps: vi.fn().mockResolvedValue([]),
  listAssetSafety: vi.fn().mockResolvedValue([]),
}));
vi.mock("./api", () => apiMocks);

import { __resetSearchAugmentForTests, useSearchAugment } from "./useSearchAugment";
import { __resetClipsFeedForTests } from "./workspace/useClipsFeed";

/** 最小挂载壳:只是为了让 useSearchAugment 这个 hook 跑起来、可控地推进 effect。 */
function Harness({ onReady }: { onReady: (api: ReturnType<typeof useSearchAugment>) => void }) {
  const api = useSearchAugment();
  onReady(api);
  return null;
}

/**
 * feed → 索引是两段异步链(feed 先 revision 再整表,索引再跟着重建),
 * 比原来的单段链多几个 microtask —— 统一多冲几拍,别让"没冲够"冒充回归。
 */
async function flush(times = 12): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

describe("useSearchAugment 跟随 clips feed 刷新 (R6 task 5 P2 / R8 task 2)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    apiMocks.listClips.mockResolvedValue([
      { id: 1, file_name: "旧素材.mov", episode_id: 100 },
    ]);
    apiMocks.listClipDimensions.mockResolvedValue([]);
    apiMocks.getStoryboard.mockResolvedValue(null);
    apiMocks.getCurrentEpisode.mockResolvedValue({ id: 100 });
    apiMocks.listEpisodes.mockResolvedValue([{ id: 100, title: "当前集" }]);
    apiMocks.getClipsRevision.mockResolvedValue("rev-1");
    apiMocks.listShotStacks.mockResolvedValue([]);
    apiMocks.listStoryGaps.mockResolvedValue([]);
    apiMocks.listAssetSafety.mockResolvedValue([]);
    __resetSearchAugmentForTests();
    __resetClipsFeedForTests();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    container.remove();
    __resetSearchAugmentForTests();
    __resetClipsFeedForTests();
    vi.clearAllMocks();
  });

  it("a new clip becomes searchable after the feed's poll tick picks up a revision change", async () => {
    let api: ReturnType<typeof useSearchAugment> | undefined;
    await act(async () => {
      root.render(<Harness onReady={(value) => (api = value)} />);
      await flush();
    });

    // Baseline: only the old clip is indexed, and its pinyin has been built.
    expect(await matchPinyinFor(api!, "jiusucai")).toEqual([1]);
    expect(await matchPinyinFor(api!, "xinsucai")).toEqual([]);

    // A new clip lands; the revision changes but nothing refetches until the poll tick.
    apiMocks.getClipsRevision.mockResolvedValue("rev-2");
    apiMocks.listClips.mockResolvedValue([
      { id: 1, file_name: "旧素材.mov", episode_id: 100 },
      { id: 2, file_name: "新素材.mov", episode_id: 100 },
    ]);
    expect(await matchPinyinFor(api!, "xinsucai")).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await flush();
    });

    expect(await matchPinyinFor(api!, "xinsucai")).toEqual([2]);
  });

  it("does not refetch clips on the poll tick when the revision is unchanged", async () => {
    await act(async () => {
      root.render(<Harness onReady={() => undefined} />);
      await flush();
    });
    apiMocks.listClips.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await flush();
    });

    expect(apiMocks.listClips).not.toHaveBeenCalled();
    // 修订号没变时索引不重建,但 feed 仍照常刷新其余元数据。
    expect(apiMocks.getClipsRevision.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("remembers a forced refresh that lands during an in-flight episode fetch (P2)", async () => {
    let api: ReturnType<typeof useSearchAugment> | undefined;
    await act(async () => {
      root.render(<Harness onReady={(value) => (api = value)} />);
      await flush();
    });

    // 让下一次集信息拉取挂住,模拟"一次强制刷新正在飞"。只挂**这一次**:
    // useClipsFeed 现在也自己听切集事件并重问当前集,用 mockImplementation
    // 会把它那次调用的 resolve 覆盖进 releaseInFlightFetch,反而放不了真正飞着的那条。
    let releaseInFlightFetch: (() => void) | undefined;
    apiMocks.getCurrentEpisode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseInFlightFetch = () => resolve({ id: 100 });
        }),
    );
    await act(async () => {
      window.dispatchEvent(new CustomEvent("tripcut:view-episode", { detail: { id: 100 } }));
      await flush(2);
    });
    expect(releaseInFlightFetch).toBeTruthy();

    // 真实情况下当前集这时已经切换了——切集事件在这条飞着的拉取完成前到达。
    apiMocks.getCurrentEpisode.mockResolvedValue({ id: 200 });
    apiMocks.listEpisodes.mockResolvedValue([
      { id: 100, title: "当前集" },
      { id: 200, title: "新当前集" },
    ]);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("tripcut:episode-changed", { detail: { id: 200, title: "新当前集" } }),
      );
      await flush(2);
    });

    // 放行那条飞着的拉取(它仍然拿到的是切集前的旧数据)。
    await act(async () => {
      releaseInFlightFetch?.();
      await flush();
    });

    // clips 修订号没变,后续任何一次常规刷新都不会补救——必须是刚才那次被
    // in-flight 吞掉的强制刷新自己补跑一次,activeEpisodeId 才能追上 200。
    const hitInNewEpisode = {
      kind: "file" as const,
      clip_id: 1,
      file_name: "x.mov",
      excerpt: "",
      episode_id: 200,
    };
    expect(api!.describeHitEpisode(hitInNewEpisode).isHistorical).toBe(false);
  });
});

async function matchPinyinFor(
  api: ReturnType<typeof useSearchAugment>,
  query: string,
): Promise<number[]> {
  const merged = await api.augmentHits([], query);
  return merged.map((hit) => hit.clip_id);
}
