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
}));
vi.mock("./api", () => apiMocks);

import { __resetSearchAugmentForTests, useSearchAugment } from "./useSearchAugment";

/** 最小挂载壳:只是为了让 useSearchAugment 这个 hook 跑起来、可控地推进 effect。 */
function Harness({ onReady }: { onReady: (api: ReturnType<typeof useSearchAugment>) => void }) {
  const api = useSearchAugment();
  onReady(api);
  return null;
}

describe("useSearchAugment revision polling (R6 task 5 P2)", () => {
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
    __resetSearchAugmentForTests();
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
    vi.clearAllMocks();
  });

  it("a new clip becomes searchable after the poll tick picks up a revision change", async () => {
    let api: ReturnType<typeof useSearchAugment> | undefined;
    await act(async () => {
      root.render(<Harness onReady={(value) => (api = value)} />);
      await Promise.resolve();
      await Promise.resolve();
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
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await matchPinyinFor(api!, "xinsucai")).toEqual([2]);
  });

  it("does not refetch clips on the poll tick when the revision is unchanged", async () => {
    await act(async () => {
      root.render(<Harness onReady={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    apiMocks.listClips.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.listClips).not.toHaveBeenCalled();
  });

  it("remembers a forced refresh that lands during an in-flight poll (P2)", async () => {
    let api: ReturnType<typeof useSearchAugment> | undefined;
    await act(async () => {
      root.render(<Harness onReady={(value) => (api = value)} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    // 让下一次轮询的 getCurrentEpisode() 挂住,模拟"常规轮询正在飞"。
    let releaseInFlightPoll: (() => void) | undefined;
    apiMocks.getClipsRevision.mockResolvedValue("rev-2");
    apiMocks.getCurrentEpisode.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseInFlightPoll = () => resolve({ id: 100 });
        }),
    );

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(releaseInFlightPoll).toBeTruthy();

    // 真实情况下当前集这时已经切换了——切集事件在这条飞着的轮询完成前到达。
    apiMocks.getCurrentEpisode.mockResolvedValue({ id: 200 });
    apiMocks.listEpisodes.mockResolvedValue([
      { id: 100, title: "当前集" },
      { id: 200, title: "新当前集" },
    ]);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("tripcut:episode-changed", { detail: { id: 200, title: "新当前集" } }),
      );
      await Promise.resolve();
    });

    // 放行那条飞着的轮询(它仍然拿到的是切集前的旧数据)。
    await act(async () => {
      releaseInFlightPoll?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // 没有后续轮询会再补救(clips 修订号没变)——必须是刚才那次被 in-flight
    // 吞掉的强制刷新自己补跑一次,activeEpisodeId 才能追上 200。
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
