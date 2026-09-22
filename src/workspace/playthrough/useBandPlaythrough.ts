import { useEffect, useMemo, type RefObject } from 'react';
import type { ClipListItem } from '../../api';
import type { BandChapter, BandView } from '../shotBandModel';
import type { BandTimeline } from '../useBandTimeline';
import { foldKey } from '../bandGeometry';
import { playthroughSegments } from './model';
import { setPlaythroughSegments, usePlaythroughView } from './store';

export function useBandPlaythrough(chapters: readonly BandChapter[], clips: ReadonlyMap<number, ClipListItem>,
  viewport: RefObject<HTMLDivElement | null>, timeline: BandTimeline, setView: (view: BandView) => void) {
  const list = useMemo(() => playthroughSegments(chapters, clips), [chapters, clips]);
  const view = usePlaythroughView();
  const key = view?.active ? view.segment?.key : undefined;
  useEffect(() => { setPlaythroughSegments(list); }, [list]);
  useEffect(() => () => setPlaythroughSegments([]), []);
  useEffect(() => {
    if (!key) return;
    setView('chapter');
    const chapter = chapters.find(c => c.segments.some(s => s.key === key));
    if (chapter && timeline.folded.has(foldKey(chapter))) timeline.toggleFold(chapter);
    const span = timeline.spans.find(s => s.key === key);
    const node = viewport.current;
    if (!span || !node) return;
    // 先移到真实 span 的位置,让虚拟化章节挂载;下一帧才查卡片 DOM。
    if (span.left < node.scrollLeft || span.left + span.width > node.scrollLeft + node.clientWidth) {
      node.scrollLeft = Math.max(0, span.left - 16);
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
    const frame = requestAnimationFrame(() => {
      const tile = [...node.querySelectorAll<HTMLElement>('[data-band-key]')].find(n => n.dataset.bandKey === key);
      tile?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [key, chapters, timeline.spans, timeline.folded, timeline.toggleFold, viewport, setView]);
  return key;
}
