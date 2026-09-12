import { useEffect, useReducer } from "react";

import { getCurrentEpisode, listEpisodes, type GlobalSearchHit } from "./api";
import {
  buildPinyinIndex,
  matchPinyin,
  mergeSearchHits,
  type PinyinIndex,
  type PinyinIndexEntry,
} from "./pinyinIndex";
import { getClipsFeedSnapshot, subscribeClipsFeed } from "./workspace/useClipsFeed";

interface SearchAugmentState {
  pinyinIndex: PinyinIndex;
  activeEpisodeId: number | null;
  episodeTitleById: Map<number, string>;
}

const emptyState: SearchAugmentState = {
  pinyinIndex: [],
  activeEpisodeId: null,
  episodeTitleById: new Map(),
};

/**
 * 拼音索引 + 历史集判断的共享数据层——模块级单例(而不是每个组件一份 ref),
 * 侧栏搜索与命令面板两处挂载共用同一份数据、同一次拉取(R6 Task 5 P3)。
 *
 * R8 Task 2:clips / 八维标签 / 故事板这三份数据不再由本模块自己轮询
 * `getClipsRevision` —— 它们来自 `useClipsFeed` 这个全应用唯一的 feed
 * (规格 §5「轮询合并」)。本模块只剩两件自己的事:
 * - 订阅 feed,**只在 revision 变化时**重建拼音索引(重建是纯 CPU,不走网络);
 * - 集信息(`getCurrentEpisode` / `listEpisodes`)仍由自己拉,因为它不在 clips
 *   修订号的覆盖范围内 —— 切集不顶 clips 修订号,所以保留
 *   `tripcut:view-episode` / `tripcut:episode-changed` 两个强制刷新监听。
 */
let state: SearchAugmentState = emptyState;
let episodeInfo = {
  activeEpisodeId: null as number | null,
  episodeTitleById: new Map<number, string>(),
};
let lastIndexedRevision: string | undefined;
let hasIndexed = false;
let subscriberCount = 0;
let inFlight = false;
// P2:一次强制刷新(切集事件)如果撞上正在飞的常规拉取,此前会被 `if (inFlight) return`
// 直接丢弃——切集不会顶 clips 修订号,后续任何一次常规刷新都不会重试,
// activeEpisodeId 就此留在旧值上。记住这次被吞掉的强制请求,等飞着的那次一结束就补跑。
let pendingForce = false;
let unsubscribeFeed: (() => void) | undefined;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** 从 feed 的当前快照重建拼音索引 —— 纯 CPU,不发一条命令。 */
function rebuildFromFeed(): void {
  const feed = getClipsFeedSnapshot();
  const entries: PinyinIndexEntry[] = [];
  // 用 allClips 而不是 clips:feed 的 clips 已按当前集裁过(媒体池要的),而
  // 搜索本来就要能命中历史集 —— describeHitEpisode 正是靠这个区分「历史集」。
  for (const clip of feed.allClips) {
    if (clip.id === null) continue;
    entries.push({ kind: "file", clip_id: clip.id, episode_id: clip.episode_id, text: clip.file_name });
  }
  for (const dimension of feed.dimensions) {
    entries.push({
      kind: "tag",
      clip_id: dimension.clip_id,
      episode_id: feed.clipsById.get(dimension.clip_id)?.episode_id ?? null,
      text: dimension.label,
    });
  }
  const storyboard = feed.storyboard;
  for (const chapter of storyboard?.chapters ?? []) {
    const representative = storyboard?.items.find((item) => item.chapter_id === chapter.id);
    if (!representative) continue;
    entries.push({
      kind: "chapter",
      clip_id: representative.clip_id,
      episode_id: episodeInfo.activeEpisodeId,
      text: chapter.title,
    });
  }
  state = {
    pinyinIndex: buildPinyinIndex(entries),
    activeEpisodeId: episodeInfo.activeEpisodeId,
    episodeTitleById: episodeInfo.episodeTitleById,
  };
  lastIndexedRevision = feed.revision;
  hasIndexed = true;
  notify();
}

async function fetchAugmentData(force: boolean): Promise<void> {
  if (inFlight) {
    if (force) pendingForce = true;
    return;
  }
  inFlight = true;
  try {
    const [currentEpisode, episodes] = await Promise.all([
      getCurrentEpisode().catch(() => null),
      listEpisodes().catch(() => []),
    ]);
    episodeInfo = {
      activeEpisodeId: currentEpisode?.id ?? null,
      episodeTitleById: new Map(episodes.map((episode) => [episode.id, episode.title])),
    };
    rebuildFromFeed();
  } finally {
    inFlight = false;
  }
  if (pendingForce) {
    pendingForce = false;
    void fetchAugmentData(true);
  }
}

function onFeedChange(): void {
  const feed = getClipsFeedSnapshot();
  // 只在 revision 变化时重建索引 —— 乐观 patch / 元数据刷新不该重跑拼音分词。
  if (hasIndexed && feed.revision === lastIndexedRevision) return;
  rebuildFromFeed();
}

function onEpisodeSignal() {
  // 当前集切换不一定改 clips 修订号(clips 集合本身没变),但 activeEpisodeId /
  // episodeTitleById 必须立刻跟上,所以强制刷新一次,跳过修订号比较。
  // clips 的强制重拉由 useClipsFeed 自己的同名监听负责(它按集裁剪,必须自己听);
  // 这里只补自己的那一份集信息(listEpisodes 的标题表不在 feed 覆盖范围内)。
  void fetchAugmentData(true);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  subscriberCount += 1;
  if (subscriberCount === 1) {
    window.addEventListener("tripcut:view-episode", onEpisodeSignal);
    window.addEventListener("tripcut:episode-changed", onEpisodeSignal);
    unsubscribeFeed = subscribeClipsFeed(onFeedChange);
  }
  void fetchAugmentData(false);
  return () => {
    listeners.delete(listener);
    subscriberCount -= 1;
    if (subscriberCount === 0) {
      window.removeEventListener("tripcut:view-episode", onEpisodeSignal);
      window.removeEventListener("tripcut:episode-changed", onEpisodeSignal);
      unsubscribeFeed?.();
      unsubscribeFeed = undefined;
    }
  };
}

/** 仅供测试用:把模块级单例复位,避免上一个测试文件/用例的数据串到下一个。 */
export function __resetSearchAugmentForTests(): void {
  listeners.clear();
  subscriberCount = 0;
  window.removeEventListener("tripcut:view-episode", onEpisodeSignal);
  window.removeEventListener("tripcut:episode-changed", onEpisodeSignal);
  unsubscribeFeed?.();
  unsubscribeFeed = undefined;
  state = emptyState;
  episodeInfo = { activeEpisodeId: null, episodeTitleById: new Map() };
  lastIndexedRevision = undefined;
  hasIndexed = false;
  inFlight = false;
  pendingForce = false;
}

export function useSearchAugment() {
  const [, forceRender] = useReducer((count: number) => count + 1, 0);

  useEffect(() => subscribe(forceRender), []);

  /** 把拼音命中(去重后)并进后端命中列表——后端命中权威,同一素材已在时不重复。 */
  const augmentHits = async (backendHits: GlobalSearchHit[], query: string): Promise<GlobalSearchHit[]> => {
    const pinyinHits = await matchPinyin(state.pinyinIndex, query);
    return mergeSearchHits(backendHits, pinyinHits);
  };

  /** 命中是否落在当前集之外——episode_id 缺失(旧数据)一律按"当前集"处理,不打断。 */
  const describeHitEpisode = (
    hit: GlobalSearchHit,
  ): { isHistorical: boolean; episodeTitle: string | null } => {
    const { activeEpisodeId, episodeTitleById } = state;
    if (hit.episode_id === null || hit.episode_id === activeEpisodeId) {
      return { isHistorical: false, episodeTitle: null };
    }
    return { isHistorical: true, episodeTitle: episodeTitleById.get(hit.episode_id) ?? "历史集" };
  };

  return { augmentHits, describeHitEpisode };
}
