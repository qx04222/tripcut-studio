import { requestSegmentSelection } from "./playthrough/selection";
import { useCallback, useMemo, useState } from "react";

import type { ClipListItem, Storyboard } from "../api";
import { chapterOffsets, foldKey } from "./bandGeometry";
import { pxToTime, timelineSpans, timelineTotalMs, type TimelineSpan } from "./bandTimeline";
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
  preferences,
}: {
  chapters: readonly BandChapter[];
  board: Storyboard | null;
  clipsById: ReadonlyMap<number, ClipListItem>;
  selectedClipId: number | null;
  selectClip(clipId: number): void;
  preferences?: { folded: ReadonlySet<string>; zoom: number; toggleFold(key: string): void };
}): BandTimeline {
  // 用户手动折叠的章(轨头 aria-expanded);按 foldKey 记,切集不清也无妨(键带章 id)。
  const [localFolded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const folded = preferences?.folded ?? localFolded;
  const zoom = preferences?.zoom ?? 1;
  const toggleFold = useCallback((chapter: BandChapter) => {
    if (preferences) { preferences.toggleFold(foldKey(chapter)); return; }
    setFolded((current) => {
      const next = new Set(current);
      const key = foldKey(chapter);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [preferences]);

  const offsets = useMemo(() => chapterOffsets(chapters, folded, zoom), [chapters, folded, zoom]);
  const spans = useMemo(() => timelineSpans(chapters, offsets, folded, zoom), [chapters, offsets, folded, zoom]);
  const totalMs = useMemo(() => timelineTotalMs(spans), [spans]);
  const playhead = useBandPlayhead(spans, selectedClipId !== null && clipsById.get(selectedClipId)?.kind === "photo" ? null : selectedClipId);
  const trim = useBandTrim(board, clipsById);
  const { requestSeek } = playhead;

  const seekInSegment = useCallback(
    (segment: BandSegment, ratio: number) => {
      if (segment.clipId === null || segment.mediaKind === "photo") return;
      const span = spans.find((candidate) => candidate.key === segment.key);
      if (!span) return;
      const inPoint = segment.inTicks * segment.tbNum / segment.tbDen;
      const outPoint = segment.outTicks * segment.tbNum / segment.tbDen;
      const clip = clipsById.get(segment.clipId);
      const fps = clip?.fps_num && clip?.fps_den ? clip.fps_num / clip.fps_den : 30;
      const position = inPoint + Math.min(1, Math.max(0, ratio)) * (outPoint - inPoint);
      const handled = requestSegmentSelection({ key: segment.key, clipId: segment.clipId, inPoint, outPoint, fps, chapter: String(segment.chapterId ?? '') }, position);
      if (!handled) selectClip(segment.clipId);

    },
    [spans, clipsById, selectClip],
  );

  const seekAtPx = useCallback((px: number) => {
    const hit = pxToTime(spans, px);
    if (!hit) return;
    const segment = chapters.flatMap(chapter => chapter.segments).find(s => s.key === hit.span.key);
    if (segment?.mediaKind === "photo" && segment.clipId !== null) selectClip(segment.clipId);
    else if (segment) seekInSegment(segment, hit.ratio);
  }, [spans, chapters, selectClip, seekInSegment]);

  const preview = (segment: BandSegment, seconds: number) => {
    if (segment.clipId === null) return;
    const duration = clipDurationSeconds(clipsById.get(segment.clipId));
    if (!duration) return;
    if (segment.clipId !== selectedClipId) selectClip(segment.clipId);
    // 0.11.3 接线:修剪的跟随 seek 带来源,连播不被它当成人工 seek 打断(挂起,落地后按新入出点继续)。
    requestSeek(segment.clipId, Math.min(1, Math.max(0, seconds / duration)), { source: "band-trim" });
  };
  return { folded, toggleFold, offsets, spans, totalMs, playhead, trim: { ...trim, preview }, seekAtPx, seekInSegment };
}
