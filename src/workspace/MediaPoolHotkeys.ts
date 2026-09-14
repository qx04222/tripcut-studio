import type { KeyboardEvent } from "react";

import { clearClipRating, rateClip, setShotStackUserState, type ClipListItem, type ShotStack } from "../api";
import type { RatingAction } from "../SelectPage";
import { applyBatchRating } from "./batchRating";
import { orderedTakes } from "./shotBandModel";
import { ratingPatch } from "./useBandTakes";
import { patchClipInFeed, refreshClipsFeed } from "./useClipsFeed";
import { useRatingHotkeys } from "./useRatingHotkeys";

export interface PoolHotkeyInput {
  /** 键盘作用的素材 = 锚点(最后一次点击的卡片)。 */
  anchorId: number | null;
  /** 锚点所在的 Stack(没有就是 null)。 */
  anchorStack: ShotStack | null;
  clipsById: ReadonlyMap<number, ClipListItem>;
  /** R16 P1-5:多选(⇧ 连选 / ⌘ 点选);多于 1 条时评级热键作用于整组。不传 = 只作用于锚点。 */
  multiSelection?: readonly number[];
  /** 池内展开中的 Stack id(U-02)。 */
  expandedStackId: number | null;
  setExpandedStackId: (next: number | null) => void;
  selectClip: (clipId: number) => void;
}

/**
 * 媒体池的单键键位(U-01,规格 §3.2):F/X/1–5/0 评级(与镜头带同一条 `patchClipInFeed`
 * 乐观补丁 + 后端写入;R16 P1-5 多选多于 1 条时作用于整组),Tab 展开/收起锚点所在的 Stack,展开时 ↑↓ 在候选里移动、
 * Enter 提为首选,L/R 锁定/排除,空格发 `tripcut:toggle-playback`(监视器听它播放/暂停)。
 * ←→↑↓ 的网格漫游仍归 `MediaPool.onGridKeyDown`,这里只在 Stack 展开时接管 ↑↓。
 *
 * 此前媒体池根本没挂这个 hook(只有镜头带挂了),真机上「焦点在卡片按 3 无反应」
 * 一半是目标判定(useRatingHotkeys),一半是这里缺席。
 */
export function useMediaPoolHotkeys(input: PoolHotkeyInput): {
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onFocus: () => void;
} {
  const { anchorId, anchorStack, clipsById, multiSelection = [], expandedStackId, setExpandedStackId, selectClip } = input;
  const expanded = anchorStack !== null && anchorStack.id === expandedStackId ? anchorStack : null;
  const takes = expanded ? orderedTakes(expanded, clipsById) : [];
  const takeIndex = Math.max(0, takes.findIndex((member) => member.clip_id === anchorId));

  const hotkeys = useRatingHotkeys("pool", {
    onRating: async (action: RatingAction) => {
      // R16 P1-5:多选多于 1 条 → 整组一次 rate_clips(toast + 撤销);单条照旧走 rate_clip。
      if (multiSelection.length > 1) {
        await applyBatchRating(multiSelection, action, clipsById);
        return;
      }
      if (anchorId === null) return;
      patchClipInFeed(anchorId, ratingPatch(action));
      if (action.kind === "clear") await clearClipRating(anchorId);
      else await rateClip(anchorId, action.kind === "binary" ? "binary" : "star", action.value);
      await refreshClipsFeed(true);
    },
    onStackState: async (state) => {
      if (!anchorStack || anchorId === null) return;
      const member = anchorStack.members.find((item) => item.clip_id === anchorId);
      if (!member) return;
      await setShotStackUserState(anchorStack.id, member.clip_id, member.segment_id, state);
      await refreshClipsFeed(true);
    },
    onPromoteHero: async () => {
      if (!anchorStack || anchorId === null) return;
      const member = anchorStack.members.find((item) => item.clip_id === anchorId);
      if (!member) return;
      await setShotStackUserState(anchorStack.id, member.clip_id, member.segment_id, "hero");
      await refreshClipsFeed(true);
    },
    onToggleTakes: () => {
      if (!anchorStack) return;
      setExpandedStackId(expandedStackId === anchorStack.id ? null : anchorStack.id);
    },
    onMoveTake: (direction) => {
      if (!expanded || takes.length === 0) return;
      const next = takes[Math.min(takes.length - 1, Math.max(0, takeIndex + direction))];
      if (next) selectClip(next.clip_id);
    },
    // ←→ 由网格漫游先处理(MediaPool 只在它没接管时才把键交到这里)。
    onMoveSelection: () => undefined,
    onTogglePlayback: () => {
      window.dispatchEvent(new CustomEvent("tripcut:toggle-playback"));
    },
  });

  return hotkeys;
}
