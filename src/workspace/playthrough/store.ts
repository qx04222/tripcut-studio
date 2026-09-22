import { useEffect, useRef, useSyncExternalStore } from 'react';
import { isAnyModalOpen } from '../modalStack';
import { isHomeOpen } from '../homeStore';
import type { PlaythroughController } from './usePlaythrough';
import type { PlaythroughSegment } from './model';

const EVENT = 'tripcut:playthrough';
const isTextFieldTarget = (target: EventTarget | null) => target instanceof HTMLElement &&
  Boolean(target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const emit = () => { for (const fn of listeners) fn(); };
let segments: readonly PlaythroughSegment[] = [];
export type PlaythroughView = Pick<PlaythroughController, 'active' | 'phase' | 'index' | 'total' | 'segment' | 'elapsed' | 'duration' | 'switchMs'>;
let view: PlaythroughView | null = null;
export function setPlaythroughSegments(next: readonly PlaythroughSegment[]) {
  if (JSON.stringify(segments) === JSON.stringify(next)) return;
  segments = next; emit();
}
export function publishPlaythrough(next: PlaythroughController | null) {
  const value = next ? { active: next.active, phase: next.phase, index: next.index, total: next.total,
    segment: next.segment, elapsed: next.elapsed, duration: next.duration, switchMs: next.switchMs } : null;
  if (JSON.stringify(value) === JSON.stringify(view)) return;
  view = value; emit();
}
export const usePlaythroughView = () => useSyncExternalStore(subscribe, () => view, () => null);
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
      if (key === undefined && c.active) { c.stop(); return; }
      const index = key === undefined ? 0 : segments.findIndex(s => s.key === key);
      if (index >= 0 && segments[index]) c.start(index);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || isTextFieldTarget(event.target) || isAnyModalOpen() || isHomeOpen()) return;
      if (!event.metaKey || !event.shiftKey || event.ctrlKey || event.altKey || event.key.toLowerCase() !== 'p') return;
      if (!latest.current.enabled || segments.length === 0) return;
      event.preventDefault(); requestPlaythrough();
    };
    window.addEventListener(EVENT, request);
    document.addEventListener('keydown', keydown);
    return () => { window.removeEventListener(EVENT, request); document.removeEventListener('keydown', keydown); };
  }, []);
}
