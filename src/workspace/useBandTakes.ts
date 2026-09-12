import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";

import {
  clearClipRating,
  rateClip,
  setShotStackUserState,
  type ClipListItem,
  type ShotStack,
  type ShotStackMember,
} from "../api";
import type { RatingAction } from "../SelectPage";
import type { Selection } from "./WorkspaceStore";
import { orderedTakes, type BandSegment } from "./shotBandModel";
import { patchClipInFeed, refreshClipsFeed } from "./useClipsFeed";
import { useRatingHotkeys } from "./useRatingHotkeys";

export function ratingPatch(action: RatingAction): Partial<ClipListItem> {
  if (action.kind === "clear") return { binary_rating: 0, star_rating: 0 };
  if (action.kind === "binary") return { binary_rating: action.value };
  return { star_rating: action.value };
}

export interface BandTakesState {
  takesOpen: boolean;
  takeIndex: number;
  takes: ShotStackMember[];
  promoteTake(member: ShotStackMember): Promise<void>;
  /** 选段时调:关掉 Take 条、位次归零。 */
  resetTakes(): void;
  hotkeys: {
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    onCompositionStart: () => void;
    onCompositionEnd: () => void;
    onFocus: () => void;
  };
}

/**
 * 镜头带的单键评级 / Take 条 / hero 提升(规格 §3.2),从 `ShotBand.tsx` 搬出来的状态层
 * (规格 §13 的 400 行上限),行为一行未改:F/X/1–5/0 走 `patchClipInFeed` 乐观补丁再写后端;
 * Tab 开关 Take 条;↑↓ 移位次;Enter 提为首选;L 锁定;←→ 在带上移选择。
 */
export function useBandTakes(input: {
  selection: Selection;
  selectedClip: ClipListItem | null;
  selectedStack: ShotStack | null;
  clipsById: ReadonlyMap<number, ClipListItem>;
  segments: readonly BandSegment[];
  selectedIndex: number;
  selectSegment: (segment: BandSegment) => void;
}): BandTakesState {
  const { selection, selectedClip, selectedStack, clipsById, segments, selectedIndex, selectSegment } = input;
  const [takesOpen, setTakesOpen] = useState(false);
  const [takeIndex, setTakeIndex] = useState(0);

  const takes = useMemo(
    () => (selectedStack ? orderedTakes(selectedStack, clipsById) : []),
    [selectedStack, clipsById],
  );

  const promoteTake = useCallback(
    async (member: ShotStackMember) => {
      if (!selectedStack) return;
      // 规格 §3.2:Enter = 把当前 Take 提为首选(hero)。
      await setShotStackUserState(selectedStack.id, member.clip_id, member.segment_id, "hero");
      await refreshClipsFeed(true);
    },
    [selectedStack],
  );

  const moveSelection = useCallback(
    (direction: -1 | 1) => {
      if (segments.length === 0) return;
      const next = segments[Math.min(segments.length - 1, Math.max(0, selectedIndex + direction))];
      if (next) selectSegment(next);
    },
    [segments, selectedIndex, selectSegment],
  );

  const hotkeys = useRatingHotkeys("band", {
    onRating: async (action: RatingAction) => {
      const clipId = selection?.kind === "clip" ? selection.clipId : null;
      if (clipId === null) return;
      patchClipInFeed(clipId, ratingPatch(action));
      if (action.kind === "clear") await clearClipRating(clipId);
      else await rateClip(clipId, action.kind === "binary" ? "binary" : "star", action.value);
      await refreshClipsFeed(true);
    },
    onStackState: async (state) => {
      const member = takes[takeIndex];
      if (!selectedStack || !member) return;
      await setShotStackUserState(selectedStack.id, member.clip_id, member.segment_id, state);
      await refreshClipsFeed(true);
    },
    onPromoteHero: async () => {
      const member = takes[takeIndex];
      if (member) await promoteTake(member);
    },
    onToggleTakes: () => setTakesOpen((open) => !open),
    onMoveTake: (direction) =>
      setTakeIndex((index) => Math.min(Math.max(0, takes.length - 1), Math.max(0, index + direction))),
    onMoveSelection: (direction) => {
      if (takesOpen) return;
      moveSelection(direction);
    },
    onTogglePlayback: () => {
      window.dispatchEvent(new CustomEvent("tripcut:toggle-playback"));
    },
  });

  useEffect(() => setTakeIndex(0), [selectedClip?.id]);

  const resetTakes = useCallback(() => {
    setTakesOpen(false);
    setTakeIndex(0);
  }, []);

  return { takesOpen, takeIndex, takes, promoteTake, resetTakes, hotkeys };
}
