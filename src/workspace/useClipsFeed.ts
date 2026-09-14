import { useSyncExternalStore } from "react";

import {
  getClipsRevision,
  getCurrentEpisode,
  getStoryboard,
  getStoryboardOf,
  listAssetSafety,
  listClipDimensions,
  listClips,
  listShotStacks,
  listStoryGaps,
  listStoryGapsOf,
  type AssetSafetyInfo,
  type ClipDimension,
  type ClipListItem,
  type EpisodeSummary,
  type ShotStack,
  type Storyboard,
  type StoryGap,
} from "../api";

/**
 * 全应用唯一的 clips 修订轮询(规格 §5)。此前 `SelectPage.tsx:1173`、
 * `ImportPage.tsx` 与 `useSearchAugment.ts` 各自跑一个 2s 的 getClipsRevision
 * 轮询;三份数据其实是同一份,三份轮询只是三倍的 IPC。本模块是模块级单例——
 * 三栏各订阅一次,底下只有一次真正的网络拉取。
 *
 * 注:`assetSafety` 是数组而不是 brief 草稿里写的 `AssetSafetyInfo | null`,
 * 因为 `listAssetSafety()` 返回的就是整库一张表(`src/api.ts:924`)。
 */
/**
 * 媒体池按集裁剪的依据(旧壳 `SelectPage.tsx` 的「G1/项8:筛片默认只看当前集」)。
 * `scopeId` = 正在只读查看的历史集 ?? 当前集;`episode_id` 为空的旧数据归当前集。
 */
export interface ClipsFeedEpisode {
  /** 当前集 id —— getCurrentEpisode(),切集事件到达时先用事件里的 id 顶上。 */
  activeId: number | null;
  /** 只读查看中的历史集(tripcut:view-episode),回到当前集时为 null。 */
  viewing: { id: number; title: string } | null;
  /** 实际裁剪用的集 id。 */
  scopeId: number | null;
  /** 当前集的完整信息,拉取失败时为 null。 */
  current: EpisodeSummary | null;
}

export interface ClipsFeed {
  /** 按 `episode.scopeId` 裁过的素材 —— 三栏看到的就是这一份。 */
  clips: readonly ClipListItem[];
  /** 未按集裁的全量素材(跨集搜索/拼音索引用)。 */
  allClips: readonly ClipListItem[];
  clipsById: ReadonlyMap<number, ClipListItem>;
  shotStacks: readonly ShotStack[];
  shotStackByClipId: ReadonlyMap<number, ShotStack>;
  storyboard: Storyboard | null;
  gaps: readonly StoryGap[];
  dimensions: readonly ClipDimension[];
  assetSafety: readonly AssetSafetyInfo[];
  revision: string | undefined;
  episode: ClipsFeedEpisode;
  loading: boolean;
  error: string | null;
}

export const CLIPS_FEED_INTERVAL_MS = 2_000;
/**
 * 封面签名 URL 的续签周期(R10 R-05)。`cover_url` 只随 `listClips` 一起算,签名
 * 5 分钟过期(`media_server.rs` 的 SIGNED_URL_TTL),而常规轮询只在修订号变了才
 * 整表重拉 —— 会话超过 5 分钟后任何重挂载的卡片都拿着过期签名,全部退成占位。
 * 满 4 分钟就强制重拉一次,新签名在旧的过期前到位。必须小于 TTL。
 */
export const COVER_URL_REFRESH_MS = 4 * 60_000;

const EMPTY_EPISODE: ClipsFeedEpisode = {
  activeId: null,
  viewing: null,
  scopeId: null,
  current: null,
};

const EMPTY_FEED: ClipsFeed = {
  clips: [],
  allClips: [],
  clipsById: new Map(),
  shotStacks: [],
  shotStackByClipId: new Map(),
  storyboard: null,
  gaps: [],
  dimensions: [],
  assetSafety: [],
  revision: undefined,
  episode: EMPTY_EPISODE,
  loading: true,
  error: null,
};

let feed: ClipsFeed = EMPTY_FEED;
let episode: ClipsFeedEpisode = EMPTY_EPISODE;
let lastRevision: string | undefined;
/** 上一次整表 `listClips` 的时刻(ms);封面续签按它计时。 */
let lastClipsFetchAt: number | null = null;
let inFlight = false;
// 一次强制刷新(评级写入 / 切集)撞上正在飞的常规轮询时不能直接丢掉——clips 修订号
// 不一定会动,后续常规轮询也就不会补救。记住它,飞着的那次一结束就补跑。
// (这条修正照搬 useSearchAugment.ts 的 P2 教训,不要再丢一次。)
let pendingForce = false;
let subscriberCount = 0;
let pollTimer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function indexClips(clips: readonly ClipListItem[]): ReadonlyMap<number, ClipListItem> {
  const map = new Map<number, ClipListItem>();
  for (const clip of clips) {
    if (clip.id !== null) map.set(clip.id, clip);
  }
  return map;
}

function indexStacks(stacks: readonly ShotStack[]): ReadonlyMap<number, ShotStack> {
  const map = new Map<number, ShotStack>();
  for (const stack of stacks) {
    for (const member of stack.members ?? []) map.set(member.clip_id, stack);
  }
  return map;
}

/**
 * 旧壳 `SelectPage.tsx` 的 `episodeScopedClips` 逐字搬来:`episode_id` 为空的
 * 旧数据算作当前集,scope 为空(还没拿到当前集)时不裁。
 */
function scopeClips(
  all: readonly ClipListItem[],
  scope: ClipsFeedEpisode,
): readonly ClipListItem[] {
  if (scope.scopeId === null) return all;
  return all.filter((clip) => (clip.episode_id ?? scope.activeId) === scope.scopeId);
}

function withScope(next: Partial<ClipsFeedEpisode>): ClipsFeedEpisode {
  const merged = { ...episode, ...next };
  return { ...merged, scopeId: merged.viewing?.id ?? merged.activeId };
}

/**
 * `Promise.allSettled` 只接得住 rejection,接不住**同步**抛出 —— 数组字面量里任何一个
 * 调用同步抛,整条 allSettled 都还没建起来就散了,refreshClipsFeed 的 promise 变成
 * 无人接管的 rejection。把每一路都包进 thunk,同步抛也变成 rejection。
 */
function attempt<T>(run: () => Promise<T>): Promise<T> {
  try {
    return run();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

function settled<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === "fulfilled" ? result.value : fallback;
}

/**
 * 后端命令理论上总返回数组,但「理论上」不该是三栏同时白屏的唯一防线:
 * 任何一路返回 null/undefined 时退回上一轮的值,而不是让 for…of 在 feed 里抛。
 */
function settledArray<T>(result: PromiseSettledResult<T[]>, fallback: readonly T[]): readonly T[] {
  return result.status === "fulfilled" && Array.isArray(result.value) ? result.value : fallback;
}

/**
 * 结构相等就沿用旧引用(`JSON.stringify` 比对:五路元数据每轮合计几十 KB,毫秒级;
 * 比每 2 s 全量重渲染便宜得多)。任一侧不可序列化时按「变了」处理。
 */
function stable<T>(previous: T, next: T): T {
  if (previous === next) return previous;
  try {
    return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
  } catch {
    return next;
  }
}

/** 每个字段都是同一引用 / 同一原始值 → 这轮什么都没变。 */
function feedUnchanged(previous: ClipsFeed, next: ClipsFeed): boolean {
  return (Object.keys(next) as (keyof ClipsFeed)[]).every((key) => Object.is(previous[key], next[key]));
}

export function getClipsFeedSnapshot(): ClipsFeed {
  return feed;
}

/** 立刻重取一次(评级/拖排等本地写入之后调),force 时跳过 revision 比较。 */
export async function refreshClipsFeed(force = false): Promise<void> {
  if (inFlight) {
    if (force) pendingForce = true;
    return;
  }
  inFlight = true;
  try {
    // 先问一句「变了吗」——没变就跳过 listClips 整表拉取,别的元数据照旧刷新。
    // 拿修订号本身失败(命令报错)就当作「变了」,退回全量拉取,不能卡死轮询,
    // 也不算错误状态——降级成功了。
    let nextRevision: string | undefined;
    const coverStale = lastClipsFetchAt === null || Date.now() - lastClipsFetchAt >= COVER_URL_REFRESH_MS;
    let shouldFetchClips = force || coverStale;
    try {
      nextRevision = await getClipsRevision();
      shouldFetchClips = force || coverStale || nextRevision !== lastRevision;
    } catch {
      shouldFetchClips = true;
    }

    // Z-14:只读查看已封存集时,镜头带与缺口按被查看的集取(此前永远是当前集的,
    // 看着旧集会把新集的镜导出去);回到当前集后仍走不带参数的老命令(旧后端 / 桩兼容)。
    const viewingId = episode.viewing?.id ?? null;
    const fetchStoryboard = viewingId === null ? getStoryboard : () => getStoryboardOf(viewingId);
    const fetchGaps = viewingId === null ? listStoryGaps : () => listStoryGapsOf(viewingId);
    // 元数据五路并行走 allSettled:任何一路挂掉都只丢自己那一份(留住上一轮的值),
    // 不能连坐 clips —— 镜头带一时拉不到,媒体池不该跟着变空。
    const [
      stacksResult,
      storyboardResult,
      gapsResult,
      dimensionsResult,
      safetyResult,
      episodeResult,
    ] = await Promise.allSettled([
      attempt(listShotStacks),
      attempt(fetchStoryboard),
      attempt(fetchGaps),
      attempt(listClipDimensions),
      attempt(listAssetSafety),
      // 当前集不在 clips 修订号的覆盖范围内,所以每轮都问一次 —— 切集不顶
      // clips 修订号,不重问就永远停在旧集上(拉不到时退回上一轮的值)。
      attempt(() => getCurrentEpisode()),
    ]);

    const currentEpisode = settled<EpisodeSummary | null>(episodeResult, episode.current);
    episode = withScope({
      current: currentEpisode,
      activeId: currentEpisode?.id ?? episode.activeId,
    });

    let clips = feed.allClips;
    let clipsById = feed.clipsById;
    let error: string | null = null;
    if (shouldFetchClips) {
      try {
        const nextClips = await listClips();
        clips = Array.isArray(nextClips) ? nextClips : [];
        clipsById = indexClips(clips);
        lastRevision = nextRevision;
        lastClipsFetchAt = Date.now();
      } catch (clipsError) {
        error = String(clipsError);
      }
    }

    // R16 车道 E(§3 ④):IPC 每轮都返回**新数组**,哪怕内容一字不差。`useSyncExternalStore`
    // 按引用比,以前每 2 s 造一个新 feed 就把媒体池 / 镜头带 / 首页全量重渲染一次(M1 8 GB 上
    // 这就是电池和风扇)。五路元数据逐一与上一轮做结构比对,没变的沿用旧引用;整份都没变
    // 就连 feed 对象也不换、不 notify。
    const shotStacks = stable(feed.shotStacks, settledArray<ShotStack>(stacksResult, feed.shotStacks));
    const nextEpisode = stable(feed.episode, episode);
    episode = nextEpisode;
    const next: ClipsFeed = {
      clips: clips === feed.allClips && nextEpisode === feed.episode ? feed.clips : scopeClips(clips, nextEpisode),
      allClips: clips,
      clipsById,
      shotStacks,
      shotStackByClipId:
        shotStacks === feed.shotStacks ? feed.shotStackByClipId : indexStacks(shotStacks),
      storyboard: stable(feed.storyboard, settled(storyboardResult, feed.storyboard)),
      gaps: stable(feed.gaps, settledArray<StoryGap>(gapsResult, feed.gaps)),
      dimensions: stable(feed.dimensions, settledArray<ClipDimension>(dimensionsResult, feed.dimensions)),
      assetSafety: stable(feed.assetSafety, settledArray<AssetSafetyInfo>(safetyResult, feed.assetSafety)),
      revision: lastRevision,
      episode: nextEpisode,
      loading: false,
      error,
    };
    if (feedUnchanged(feed, next)) return;
    feed = next;
    notify();
  } finally {
    inFlight = false;
  }
  if (pendingForce) {
    pendingForce = false;
    await refreshClipsFeed(true);
  }
}

/**
 * R15:本地先把素材从池里拿掉,不等下一轮轮询(删素材 / 删集之后调)。
 * `keep` 返回 false 的素材被移除;随后照常 `refreshClipsFeed(true)` 对齐后端。
 */
export function removeClipsFromFeed(keep: (clip: ClipListItem) => boolean): void {
  const allClips = feed.allClips.filter(keep);
  if (allClips.length === feed.allClips.length) return;
  feed = {
    ...feed,
    clips: scopeClips(allClips, episode),
    allClips,
    clipsById: indexClips(allClips),
  };
  notify();
}

/** 本地乐观更新一条素材,不等下一轮轮询(沿用 SelectPage.tsx applyRatingAction 的语义)。 */
export function patchClipInFeed(clipId: number, patch: Partial<ClipListItem>): void {
  const current = feed.clipsById.get(clipId);
  if (!current) return;
  const next = { ...current, ...patch };
  const clipsById = new Map(feed.clipsById);
  clipsById.set(clipId, next);
  const allClips = feed.allClips.map((clip) => (clip.id === clipId ? next : clip));
  feed = {
    ...feed,
    clips: feed.clips.map((clip) => (clip.id === clipId ? next : clip)),
    allClips,
    clipsById,
  };
  notify();
}

function pageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function startPolling(): void {
  if (pollTimer !== undefined) return;
  pollTimer = setInterval(() => {
    void refreshClipsFeed(false);
  }, CLIPS_FEED_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollTimer === undefined) return;
  clearInterval(pollTimer);
  pollTimer = undefined;
}

function onVisibility(): void {
  if (!pageVisible()) {
    stopPolling();
    return;
  }
  startPolling();
  void refreshClipsFeed(false);
}

/**
 * 切集必须在这里听,不能只在 `useSearchAugment` 里听:切集**不顶 clips 修订号**,
 * 常规轮询会一路跳过 listClips,媒体池就停在上一集的素材上(R8 Task 2 复审 P1)。
 * 事件里的 id 先顶上,随后那次强制刷新里的 getCurrentEpisode() 再给出完整信息。
 */
function onEpisodeEvent(event: Event): void {
  const detail = (event as CustomEvent<{ id: number; title: string } | null>).detail ?? null;
  if (event.type === "tripcut:view-episode") {
    episode = withScope({ viewing: detail });
  } else {
    // 切当前集 = 回到当前集视角,清掉只读查看的历史集(与旧壳同语义)。
    episode = withScope({ viewing: null, activeId: detail?.id ?? episode.activeId });
  }
  feed = { ...feed, clips: scopeClips(feed.allClips, episode), episode };
  notify();
  void refreshClipsFeed(true);
}

function addEpisodeListeners(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("tripcut:view-episode", onEpisodeEvent);
  window.addEventListener("tripcut:episode-changed", onEpisodeEvent);
}

function removeEpisodeListeners(): void {
  if (typeof window === "undefined") return;
  window.removeEventListener("tripcut:view-episode", onEpisodeEvent);
  window.removeEventListener("tripcut:episode-changed", onEpisodeEvent);
}

export function subscribeClipsFeed(listener: () => void): () => void {
  listeners.add(listener);
  subscriberCount += 1;
  if (subscriberCount === 1) {
    addEpisodeListeners();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
  }
  if (pageVisible()) {
    startPolling();
    void refreshClipsFeed(false);
  }
  return () => {
    listeners.delete(listener);
    subscriberCount -= 1;
    if (subscriberCount > 0) return;
    removeEpisodeListeners();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
    stopPolling();
  };
}

export function useClipsFeed(): ClipsFeed {
  return useSyncExternalStore(subscribeClipsFeed, getClipsFeedSnapshot, () => EMPTY_FEED);
}

export function __resetClipsFeedForTests(): void {
  listeners.clear();
  subscriberCount = 0;
  stopPolling();
  removeEpisodeListeners();
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibility);
  }
  feed = EMPTY_FEED;
  episode = EMPTY_EPISODE;
  lastRevision = undefined;
  lastClipsFetchAt = null;
  inFlight = false;
  pendingForce = false;
}
