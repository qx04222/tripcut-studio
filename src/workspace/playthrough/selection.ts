import { useSyncExternalStore } from 'react';
import type { PlaythroughSegment } from './model';

export const SELECT_SEGMENT_EVENT = 'tripcut:select-segment';
export const MATERIAL_MODE_EVENT = 'tripcut:material-mode';
export interface SelectionRequest { segment: PlaythroughSegment; position: number; resume: boolean }
let selection: PlaythroughSegment | null = null;
const listeners = new Set<() => void>();
/** 活动选段唯一快照:由切段状态机提交,走带围栏和绿框共同读取。 */
export function setActiveSelection(next: PlaythroughSegment | null) {
  if (selection === next) return;
  selection = next;
  for (const listener of listeners) listener();
}
export const getActiveSelection = () => selection;
export const useActiveSelection = () => useSyncExternalStore(fn => {
  listeners.add(fn); return () => { listeners.delete(fn); };
}, getActiveSelection, getActiveSelection);
export function requestSegmentSelection(segment: PlaythroughSegment, position = segment.inPoint, resume = false) {
  if (!Number.isFinite(segment.inPoint + segment.outPoint + position + segment.fps) || segment.inPoint < 0 || segment.outPoint <= segment.inPoint || segment.fps <= 0) return false;
  const event = new CustomEvent<SelectionRequest>(SELECT_SEGMENT_EVENT, {
    cancelable: true, detail: { segment, position: Math.min(segment.outPoint, Math.max(segment.inPoint, position)), resume },
  });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
