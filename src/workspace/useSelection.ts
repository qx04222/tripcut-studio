import { useCallback, useEffect, useMemo } from "react";

import type { ClipListItem, ShotStack, ShotStackMember, StoryGap } from "../api";
import { useClipsFeed } from "./useClipsFeed";
import { dispatchWorkspace, useWorkspace, type Selection } from "./WorkspaceStore";

/**
 * 三栏共享的选择视图(规格 §3.1)。媒体池点卡片、镜头带点分段,都落到同一个
 * `selection`;监视器与检查器只读它。多选只服务批量操作,监视器/检查器永远
 * 只跟**锚点项**(最后一次点击)。
 */
export interface SelectionView {
  selection: Selection;
  selectedClip: ClipListItem | null;
  selectedStack: ShotStack | null;
  selectedStackMember: ShotStackMember | null;
  selectedGap: StoryGap | null;
  multiSelection: readonly number[];
  selectClip(clipId: number, modifiers?: { shift?: boolean; meta?: boolean }): void;
  selectSlot(chapterId: number, slot: string): void;
  clear(): void;
}

/**
 * 纯函数:⇧ 连选 / ⌘ 点选的结果,锚点永远是最后一次点击。
 *
 * 闭区间取在 `visibleIds` 的**顺序**上,不是 id 数值上 —— 网格按拍摄时间排,
 * 又被筛选和搜索裁过,id 相邻不等于视觉相邻。锚点不在可见列表里(筛选刚变、
 * 或它被搜索结果挡掉了)时退回单选:宁可少选,也不要连出一段用户没看见的素材。
 */
export function extendMultiSelection(
  visibleIds: readonly number[],
  current: readonly number[],
  anchor: number | null,
  next: number,
  modifiers: { shift?: boolean; meta?: boolean },
): { ids: number[]; anchor: number } {
  if (modifiers.shift && anchor !== null) {
    const from = visibleIds.indexOf(anchor);
    const to = visibleIds.indexOf(next);
    if (from >= 0 && to >= 0) {
      const [low, high] = from <= to ? [from, to] : [to, from];
      return { ids: visibleIds.slice(low, high + 1), anchor: next };
    }
    return { ids: [next], anchor: next };
  }
  if (modifiers.meta) {
    return {
      ids: current.includes(next) ? current.filter((id) => id !== next) : [...current, next],
      anchor: next,
    };
  }
  return { ids: [next], anchor: next };
}

/**
 * 换当前集之后旧选中还成不成立(R10 R-06):素材要属于新集(`episode_id` 为空的
 * 旧数据归当前集,与 useClipsFeed 的 scopeClips 同规则);feed 里查不到的素材
 * 和空槽位(章属于旧集)一律算不成立。集 id 未知时不动选中。
 */
export function selectionBelongsToEpisode(
  selection: Selection,
  episodeId: number | null,
  clipsById: ReadonlyMap<number, Pick<ClipListItem, "episode_id">>,
): boolean {
  if (selection === null || episodeId === null) return true;
  if (selection.kind !== "clip") return false;
  const clip = clipsById.get(selection.clipId);
  if (!clip) return false;
  return (clip.episode_id ?? episodeId) === episodeId;
}

/** 回显目标的 DOM id;两栏用同一套 id 规则,scrollIntoView 才能互相找到。 */
export function echoElementId(selection: Selection, pane: "pool" | "band"): string | null {
  if (selection === null) return null;
  if (selection.kind === "clip") return `${pane}-clip-${selection.clipId}`;
  // 空槽位只存在于镜头带 —— 媒体池里没有它的对应物,回显就此打住。
  return pane === "band" ? `band-slot-${selection.chapterId}-${selection.slot}` : null;
}

function scrollEchoIntoView(selection: Selection): void {
  if (typeof document === "undefined") return;
  for (const pane of ["pool", "band"] as const) {
    const id = echoElementId(selection, pane);
    if (id === null) continue;
    const element = document.getElementById(id);
    // 查不到就静默跳过 —— 虚拟化下另一栏根本没渲染这条,是正常情形,不是错。
    if (element && typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ block: "nearest" });
    }
  }
}

/**
 * `visibleIds` 是调用方(媒体池)当前**看得见的顺序**;不传时退回 feed 的原始
 * 顺序,好让镜头带这类没有自己筛选的调用点也能用 ⇧ 连选。
 */
export function useSelection(visibleIds?: readonly number[]): SelectionView {
  const feed = useClipsFeed();
  const selection = useWorkspace((state) => state.selection);
  const multiSelection = useWorkspace((state) => state.multiSelection);
  const anchorClipId = useWorkspace((state) => state.anchorClipId);

  const order = useMemo(() => {
    if (visibleIds) return visibleIds;
    return feed.clips
      .map((clip) => clip.id)
      .filter((id): id is number => id !== null);
  }, [visibleIds, feed.clips]);

  const selectClip = useCallback(
    (clipId: number, modifiers: { shift?: boolean; meta?: boolean } = {}) => {
      const { ids } = extendMultiSelection(order, multiSelection, anchorClipId, clipId, modifiers);
      dispatchWorkspace({ type: "select-clip", clipId, ids });
    },
    [order, multiSelection, anchorClipId],
  );

  const selectSlot = useCallback((chapterId: number, slot: string) => {
    dispatchWorkspace({ type: "select-slot", chapterId, slot });
  }, []);

  const clear = useCallback(() => dispatchWorkspace({ type: "clear-selection" }), []);

  useEffect(() => scrollEchoIntoView(selection), [selection]);

  const clipId = selection?.kind === "clip" ? selection.clipId : null;
  const selectedClip = clipId === null ? null : feed.clipsById.get(clipId) ?? null;
  const selectedStack = clipId === null ? null : feed.shotStackByClipId.get(clipId) ?? null;
  const selectedStackMember =
    clipId === null || selectedStack === null
      ? null
      : selectedStack.members.find((member) => member.clip_id === clipId) ?? null;
  const selectedGap =
    selection?.kind === "slot"
      ? feed.gaps.find(
          (gap) => gap.chapter_id === selection.chapterId && gap.slot === selection.slot,
        ) ?? null
      : null;

  return {
    selection,
    selectedClip,
    selectedStack,
    selectedStackMember,
    selectedGap,
    multiSelection,
    selectClip,
    selectSlot,
    clear,
  };
}
