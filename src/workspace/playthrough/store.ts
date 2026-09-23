import { useEffect, useRef, useSyncExternalStore } from 'react';
import { isAnyModalOpen } from '../modalStack';
import { isHomeOpen } from '../homeStore';
import type { PlaythroughController } from './usePlaythrough';
import type { PlaythroughSegment } from './model';

import { SELECT_SEGMENT_EVENT, type SelectionRequest } from './selection';

const EVENT = 'tripcut:playthrough';
/** 0.11.3 接线:镜头带开始编辑(⇧/⌘ 多选、框选、拖动段)→ 连播停、素材继续播(与拖进度条同语义,不暂停)。 */
export const PLAYTHROUGH_RELEASE_EVENT = 'tripcut:playthrough-release';
/** 0.11.3 接线:镜头带拖边修剪的监视器跟随 seek(走带 `seekTo(s, { source: 'band-trim' })` 广播)→ 连播挂起,修剪落地后按新入出点继续。 */
export const PLAYTHROUGH_TRIM_SEEK_EVENT = 'tripcut:trim-seek';
export function releasePlaythrough() {
  window.dispatchEvent(new Event(PLAYTHROUGH_RELEASE_EVENT));
}
const isTextFieldTarget = (target: EventTarget | null) => target instanceof HTMLElement &&
  Boolean(target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const emit = () => { for (const fn of listeners) fn(); };
let segments: readonly PlaythroughSegment[] = [];
export type PlaythroughView = Pick<PlaythroughController, 'mode' | 'active' | 'phase' | 'index' | 'total' | 'segment' | 'elapsed' | 'duration' | 'switchMs'>;
let view: PlaythroughView | null = null;
export function setPlaythroughSegments(next: readonly PlaythroughSegment[]) {
  if (JSON.stringify(segments) === JSON.stringify(next)) return;
  segments = next; emit();
}
export function publishPlaythrough(next: PlaythroughController | null) {
  const value = next ? { mode: next.mode, active: next.active, phase: next.phase, index: next.index, total: next.total,
    segment: next.segment, elapsed: next.elapsed, duration: next.duration, switchMs: next.switchMs } : null;
  if (JSON.stringify(value) === JSON.stringify(view)) return;
  view = value; emit();
}
export const usePlaythroughView = () => useSyncExternalStore(subscribe, () => view, () => null);
/** 不走 hook 的读法:`playerOpen` 要在换素材那一刻知道该不该停在首帧(R23 ISSUE-A 跨素材)。 */
export const isPlaythroughActive = () => view !== null && view.phase !== 'idle';
// 只订阅「正在播的是哪一段」:整份 view 里的 elapsed 每 80 ms 就变一次,镜头带跟着每秒重渲染十几遍,
// 10 px 宽的修剪把手在连播中就按不动了(R22-C 真机 F-R22C-16)。带上只需要 key。
let playingKey: string | undefined;
export const usePlaythroughKey = () => useSyncExternalStore(subscribe, () => {
  const next = view?.active ? view.segment?.key : undefined;
  if (next !== playingKey) playingKey = next;
  return playingKey;
}, () => undefined);
export const usePlaythroughSegments = () => useSyncExternalStore(subscribe, () => segments, () => segments);
export function requestPlaythrough(key?: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { key } }));
}
export function usePlaythroughCommands(controller: PlaythroughController, enabled: boolean) {
  const latest = useRef({ controller, enabled }); latest.current = { controller, enabled };
  useEffect(() => {
    const request = (event: Event) => {
      const { controller: c, enabled: allowed } = latest.current;
      if (!allowed) return;
      const key = (event as CustomEvent<{ key?: string }>).detail?.key;
      if (key === undefined && c.active) { if (c.mode === 'band') c.stop(); else c.start(0); return; }
      const index = key === undefined ? 0 : segments.findIndex(s => s.key === key);
      if (index >= 0 && segments[index]) c.start(index);
    };
    const select = (event: Event) => {
      if (!latest.current.enabled) return;
      event.preventDefault();
      const { segment, position, resume } = (event as CustomEvent<SelectionRequest>).detail;
      latest.current.controller.select(segment, position, resume);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || isTextFieldTarget(event.target) || isAnyModalOpen() || isHomeOpen()) return;
      if (!event.metaKey || !event.shiftKey || event.ctrlKey || event.altKey || event.key.toLowerCase() !== 'p') return;
      if (!latest.current.enabled || segments.length === 0) return;
      event.preventDefault(); requestPlaythrough();
    };
    window.addEventListener(EVENT, request);
    window.addEventListener(SELECT_SEGMENT_EVENT, select);
    document.addEventListener('keydown', keydown);
    return () => { window.removeEventListener(SELECT_SEGMENT_EVENT, select); window.removeEventListener(EVENT, request); document.removeEventListener('keydown', keydown); };
  }, []);
}

/** 一次性的源时间打开请求;不同素材的 Overlay 不能抢走它。 */
export const PLAYER_OPEN_AT_EVENT = 'tripcut:player-open-at';
export interface OpenAtRequest { clipId: number; seconds: number; resume: boolean; outPoint?: number }
let pendingOpenAt: OpenAtRequest | null = null;
export function requestOpenAt(clipId: number, seconds: number, resume = false, outPoint?: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const request = { clipId, seconds, resume, ...(outPoint === undefined ? {} : { outPoint }) };
  pendingOpenAt = request;
  window.dispatchEvent(new CustomEvent(PLAYER_OPEN_AT_EVENT, { detail: request }));
  return request;
}
export function takeOpenAt(clipId: number): OpenAtRequest | null {
  if (pendingOpenAt?.clipId !== clipId) return null;
  const request = pendingOpenAt;
  pendingOpenAt = null;
  return request;
}
export function cancelOpenAt(request: OpenAtRequest | null) {
  if (pendingOpenAt === request) pendingOpenAt = null;
}
