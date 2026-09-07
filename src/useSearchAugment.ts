import { useEffect, useReducer } from "react";

import {
  getClipsRevision,
  getCurrentEpisode,
  getStoryboard,
  listClipDimensions,
  listClips,
  listEpisodes,
  type GlobalSearchHit,
} from "./api";
import {
  buildPinyinIndex,
  matchPinyin,
  mergeSearchHits,
  type PinyinIndex,
  type PinyinIndexEntry,
} from "./pinyinIndex";

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

/** 轮询间隔——跟 SelectPage.tsx 里 getClipsRevision 轮询用的间隔保持一致(见该文件~1130-1200行)。 */
const POLL_INTERVAL_MS = 2_000;

/**
 * 拼音索引 + 历史集判断的共享数据层——模块级单例(而不是每个组件一份 ref),
 * 侧栏搜索与命令面板两处挂载共用同一份数据、同一次拉取(R6 Task 5 P3):
 * - P2:不再"挂载时拉一次就不管了",而是像 SelectPage 轮询 getClipsRevision 那样,
 *   变了才整表重拉;此外 clips 修订号覆盖不到的"当前集切换"额外监听
 *   tripcut:view-episode / tripcut:episode-changed 强制刷新一次。
 * - P3:两个组件各自 useEffect 订阅同一份 state,只有一次真正的网络拉取。
 */
let state: SearchAugmentState = emptyState;
let lastRevision: string | undefined;
let subscriberCount = 0;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;
// P2:一次强制刷新(切集事件)如果撞上正在飞的常规轮询,此前会被 `if (inFlight) return`
// 直接丢弃——切集不会顶 clips 修订号,后续任何一次常规轮询都不会重试,
// activeEpisodeId 就此留在旧值上,只有下次 clips 真的变化才会误打误撞刷新回来。
// 记住这次被吞掉的强制请求,等飞着的那次一结束就立刻补跑一次。
let pendingForce = false;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

async function fetchAugmentData(force: boolean): Promise<void> {
  if (inFlight) {
    if (force) pendingForce = true;
    return;
  }
  inFlight = true;
  try {
    let nextRevision: string | undefined;
    let shouldFetch = force;
    try {
      nextRevision = await getClipsRevision();
      shouldFetch = force || nextRevision !== lastRevision;
    } catch {
      shouldFetch = true;
    }
    if (!shouldFetch) return;

    const [clips, dimensions, storyboard, currentEpisode, episodes] = await Promise.all([
      listClips().catch(() => []),
      listClipDimensions().catch(() => []),
      getStoryboard().catch(() => null),
      getCurrentEpisode().catch(() => null),
      listEpisodes().catch(() => []),
    ]);

    const clipsById = new Map(clips.map((clip) => [clip.id, clip]));
    const entries: PinyinIndexEntry[] = [];
    for (const clip of clips) {
      if (clip.id === null) continue;
      entries.push({ kind: "file", clip_id: clip.id, episode_id: clip.episode_id, text: clip.file_name });
    }
    for (const dimension of dimensions) {
      entries.push({
        kind: "tag",
        clip_id: dimension.clip_id,
        episode_id: clipsById.get(dimension.clip_id)?.episode_id ?? null,
        text: dimension.label,
      });
    }
    for (const chapter of storyboard?.chapters ?? []) {
      const representative = storyboard?.items.find((item) => item.chapter_id === chapter.id);
      if (!representative) continue;
      entries.push({
        kind: "chapter",
        clip_id: representative.clip_id,
        episode_id: currentEpisode?.id ?? null,
        text: chapter.title,
      });
    }

    state = {
      pinyinIndex: buildPinyinIndex(entries),
      activeEpisodeId: currentEpisode?.id ?? null,
      episodeTitleById: new Map(episodes.map((episode) => [episode.id, episode.title])),
    };
    lastRevision = nextRevision;
    notify();
  } finally {
    inFlight = false;
  }
  if (pendingForce) {
    pendingForce = false;
    void fetchAugmentData(true);
  }
}

function onEpisodeSignal() {
  // 当前集切换不一定改 clips 修订号(clips 集合本身没变),但 activeEpisodeId /
  // episodeTitleById 必须立刻跟上,所以强制刷新一次,跳过修订号比较。
  void fetchAugmentData(true);
}

function startSharedPolling() {
  if (pollTimer !== undefined) return;
  pollTimer = setInterval(() => {
    void fetchAugmentData(false);
  }, POLL_INTERVAL_MS);
}

function stopSharedPollingIfIdle() {
  if (subscriberCount > 0) return;
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  subscriberCount += 1;
  if (subscriberCount === 1) {
    window.addEventListener("tripcut:view-episode", onEpisodeSignal);
    window.addEventListener("tripcut:episode-changed", onEpisodeSignal);
  }
  startSharedPolling();
  void fetchAugmentData(false);
  return () => {
    listeners.delete(listener);
    subscriberCount -= 1;
    if (subscriberCount === 0) {
      window.removeEventListener("tripcut:view-episode", onEpisodeSignal);
      window.removeEventListener("tripcut:episode-changed", onEpisodeSignal);
    }
    stopSharedPollingIfIdle();
  };
}

/** 仅供测试用:把模块级单例复位,避免上一个测试文件/用例的数据串到下一个。 */
export function __resetSearchAugmentForTests(): void {
  listeners.clear();
  subscriberCount = 0;
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  window.removeEventListener("tripcut:view-episode", onEpisodeSignal);
  window.removeEventListener("tripcut:episode-changed", onEpisodeSignal);
  state = emptyState;
  lastRevision = undefined;
  inFlight = false;
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
