import { useCallback, useEffect, useMemo, useState } from "react";

import { getClipMoments, suggestSegments, type ClipListItem, type ClipMoment, type SegmentSuggestion } from "../api";
import {
  bestMomentStart,
  heatPoints,
  stepSuggestionIndex,
  suggestionRanges,
  suggestionStatusLine,
  type HeatPoint,
  type SuggestionRange,
} from "./monitorSuggestions";

export interface ClipSuggestionsState {
  moments: readonly ClipMoment[];
  ranges: readonly SuggestionRange[];
  points: readonly HeatPoint[];
  /** 当前建议下标;没有建议时 -1。 */
  index: number;
  current: SuggestionRange | null;
  statusLine: string | null;
  /** 最高分时刻的起点秒;没有时刻分时 null。 */
  bestStart: number | null;
  /** 时刻分已拉完(成功或失败)。 */
  momentsLoaded: boolean;
  step(direction: 1 | -1): SuggestionRange | null;
}

/**
 * R11 §1.2:一条素材的时刻分 + 建议段。两条命令并行拉,任一失败都当「没有」——
 * 热力条不画、状态行不出现,监视器其它功能不受影响(§4:时刻分失败不影响既有链路)。
 * 换素材立即清空,当前建议回到第 1 条。
 */
const NO_MOMENTS: readonly ClipMoment[] = [];
const NO_SUGGESTIONS: readonly SegmentSuggestion[] = [];

export function useClipSuggestions(clip: ClipListItem | null, durationSeconds: number): ClipSuggestionsState {
  const clipId = clip?.id ?? null;
  // R17 playfix:每份 state 都带着「是哪条素材的」。换素材的第一拍 effect 还没清零,
  // 若把 A 的时刻分 / 「已到齐」报给 B,监视器可能把 B seek 到 A 的最高分处。
  const [momentsFor, setMomentsFor] = useState<{ clipId: number | null; items: readonly ClipMoment[]; loaded: boolean }>({ clipId: null, items: [], loaded: false });
  const [suggestionsFor, setSuggestionsFor] = useState<{ clipId: number | null; items: readonly SegmentSuggestion[]; index: number }>({ clipId: null, items: [], index: -1 });
  const moments = momentsFor.clipId === clipId ? momentsFor.items : NO_MOMENTS;
  const momentsLoaded = momentsFor.clipId === clipId && momentsFor.loaded;
  const suggestions = suggestionsFor.clipId === clipId ? suggestionsFor.items : NO_SUGGESTIONS;
  const index = suggestionsFor.clipId === clipId ? suggestionsFor.index : -1;

  useEffect(() => {
    if (clipId === null) return;
    let active = true;
    void getClipMoments(clipId)
      .then((items) => {
        if (active) setMomentsFor({ clipId, items, loaded: true });
      })
      .catch(() => {
        if (active) setMomentsFor({ clipId, items: [], loaded: true });
      });
    void suggestSegments(clipId)
      .then((items) => {
        if (active) setSuggestionsFor({ clipId, items, index: items.length > 0 ? 0 : -1 });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [clipId]);

  const tb = useMemo(() => ({ tb_num: clip?.tb_num ?? null, tb_den: clip?.tb_den ?? null }), [clip?.tb_num, clip?.tb_den]);
  const ranges = useMemo(() => suggestionRanges(suggestions, tb), [suggestions, tb]);
  const points = useMemo(() => heatPoints(moments, tb, durationSeconds), [moments, tb, durationSeconds]);
  const bestStart = useMemo(() => bestMomentStart(moments, tb), [moments, tb]);
  const safeIndex = index >= 0 && index < ranges.length ? index : -1;

  const step = useCallback(
    (direction: 1 | -1): SuggestionRange | null => {
      const next = stepSuggestionIndex(safeIndex, ranges.length, direction);
      setSuggestionsFor({ clipId, items: suggestions, index: next });
      return next >= 0 ? (ranges[next] ?? null) : null;
    },
    [ranges, safeIndex, clipId, suggestions],
  );

  return {
    moments,
    ranges,
    points,
    index: safeIndex,
    current: safeIndex >= 0 ? (ranges[safeIndex] ?? null) : null,
    statusLine: suggestionStatusLine(safeIndex, ranges),
    bestStart,
    momentsLoaded,
    step,
  };
}
