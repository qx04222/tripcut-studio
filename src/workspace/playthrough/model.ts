import type { ClipListItem } from '../../api';
import type { BandChapter } from '../shotBandModel';

export interface PlaythroughSegment {
  key: string;
  clipId: number;
  inPoint: number;
  outPoint: number;
  fps: number;
  chapter: string;
}
/** 镜头带已经按章 + story_order 排好;空槽位/照片/无效区间不参与。整素材镜块沿用带上范围。 */
export function playthroughSegments(chapters: readonly BandChapter[], clips: ReadonlyMap<number, ClipListItem>): PlaythroughSegment[] {
  return chapters.flatMap(chapter => chapter.segments.flatMap(s => {
    if (s.kind !== 'clip' || s.clipId === null || s.mediaKind === 'photo' || s.tbNum <= 0 || s.tbDen <= 0) return [];
    const inPoint = s.inTicks * s.tbNum / s.tbDen;
    const outPoint = s.outTicks * s.tbNum / s.tbDen;
    if (!Number.isFinite(inPoint + outPoint) || inPoint < 0 || outPoint <= inPoint) return [];
    const clip = clips.get(s.clipId);
    const fps = clip?.fps_num && clip?.fps_den ? clip.fps_num / clip.fps_den : 30;
    return [{ key: s.key, clipId: s.clipId, inPoint, outPoint, fps: fps > 0 && Number.isFinite(fps) ? fps : 30, chapter: String(chapter.ordinal) }];
  }));
}
export function playthroughProgress(segments: readonly PlaythroughSegment[], index: number, position: number) {
  const duration = segments.reduce((sum, s) => sum + s.outPoint - s.inPoint, 0);
  const before = segments.slice(0, index).reduce((sum, s) => sum + s.outPoint - s.inPoint, 0);
  const s = segments[index];
  return { elapsed: s ? before + Math.min(s.outPoint - s.inPoint, Math.max(0, position - s.inPoint)) : 0, duration };
}
export const playthroughTime = (seconds: number) => {
  const whole = Math.floor(Math.max(0, seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
};
export interface PlaythroughRange {
  inPoint: number; outPoint: number; index: number; total: number;
  /** 切段中(旧源已停、seek 还没落地):此刻的 `currentTime` 还属于上一段,不能当位置显示。 */
  switching?: boolean;
}
