import { useCallback, useMemo, useState } from "react";

import type { ClipListItem, Storyboard } from "../api";
import { chapterOffsets, foldKey } from "./bandGeometry";
import { pxToTime, seekRatioFor, timelineSpans, timelineTotalMs, type TimelineSpan } from "./bandTimeline";
import type { BandChapter, BandSegment } from "./shotBandModel";
import { useBandPlayhead, type BandPlayhead } from "./useBandPlayhead";
import { clipDurationSeconds, useBandTrim, type BandTrimApi } from "./useBandTrim";

/**
 * R13 §4:镜头带时间线化的状态层 —— 章节折叠、节距轴上的 span 表、播放头、拖边裁剪、
 * 「点哪定位到哪」。ShotBand 只拿结果画;换算全在 bandTimeline(纯函数)。
 */
export interface BandTimeline {
  folded: ReadonlySet<string>;
  toggleFold(chapter: BandChapter): void;
  offsets: number[];
  spans: TimelineSpan[];
  totalMs: number;
  playhead: BandPlayhead;
  trim: BandTrimApi;
  /** 节距轴上的一个像素 → 选中那条素材并定位到对应时刻(切素材走既有 selection,seek 走既有广播)。 */
  seekAtPx(px: number): void;
  /** 点在镜块几分之几处 → 定位到本段的那一刻(整条素材 = 素材的那一刻);选中由调用方先做。 */
  seekInSegment(segment: BandSegment, ratio: number): void;
}

export function useBandTimeline({
  chapters,
  board,
  clipsById,
  selectedClipId,
  selectClip,
}: {
  chapters: readonly BandChapter[];
  board: Storyboard | null;
  clipsById: ReadonlyMap<number, ClipListItem>;
  selectedClipId: number | null;
  selectClip(clipId: number): void;
}): BandTimeline {
  // 用户手动折叠的章(轨头 aria-expanded);按 foldKey 记,切集不清也无妨(键带章 id)。
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleFold = useCallback((chapter: BandChapter) => {
    setFolded((current) => {
      const next = new Set(current);
      const key = foldKey(chapter);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const offsets = useMemo(() => chapterOffsets(chapters, folded), [chapters, folded]);
  const spans = useMemo(() => timelineSpans(chapters, offsets, folded), [chapters, offsets, folded]);
  const totalMs = useMemo(() => timelineTotalMs(spans), [spans]);
  const playhead = useBandPlayhead(spans, selectedClipId !== null && clipsById.get(selectedClipId)?.kind === "photo" ? null : selectedClipId);
  const trim = useBandTrim(board, clipsById);
  const { requestSeek } = playhead;

  const clipMs = useCallback(
    (clipId: number) => {
      const seconds = clipDurationSeconds(clipsById.get(clipId));
      return seconds === null ? 0 : seconds * 1_000;
    },
    [clipsById],
  );

  const seekAtPx = useCallback(
    (px: number) => {
      const hit = pxToTime(spans, px);
      if (!hit || hit.span.clipId === null) return;
      const ratio = seekRatioFor(hit.span, hit.ratio, clipMs(hit.span.clipId));
      if (hit.span.clipId !== selectedClipId) selectClip(hit.span.clipId);
      if (clipsById.get(hit.span.clipId)?.kind === "photo") return;
      if (ratio !== null) requestSeek(hit.span.clipId, ratio);
    },
    [spans, clipMs, selectedClipId, selectClip, requestSeek, clipsById],
  );

  const seekInSegment = useCallback(
    (segment: BandSegment, ratio: number) => {
      if (segment.clipId === null || segment.mediaKind === "photo") return;
      const span = spans.find((candidate) => candidate.key === segment.key);
      if (!span) return;
      const seekRatio = seekRatioFor(span, ratio, clipMs(segment.clipId));
      if (seekRatio !== null) requestSeek(segment.clipId, seekRatio);
    },
    [spans, clipMs, requestSeek],
  );

  return { folded, toggleFold, offsets, spans, totalMs, playhead, trim, seekAtPx, seekInSegment };
}
