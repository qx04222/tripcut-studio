import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import type { TimelineSpan } from "../bandTimeline";
import { BAND_ZOOMS } from "./useBandPreferences";
import { isActivatableControl, isPaneShortcutTarget } from "../useRatingHotkeys";

interface NavigationOptions {
  viewport: RefObject<HTMLDivElement | null>; spans: readonly TimelineSpan[]; zoom: number;
  setZoom(zoom: number): void; previewZoom(zoom: number): void; commitZoom(): void;
}
export function useBandNavigation(options: NavigationOptions) {
  const latest = useRef(options); latest.current = options;
  const anchor = useRef<{ key: string; ratio: number; x: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false), didPan = useRef(false), pan = useRef<{ x: number; left: number } | null>(null);
  const [panning, setPanning] = useState(false);
  // ⌥滚轮连击中(直到 250 ms 无新事件提交):ShotBand 据此套段级窗口(band/dragWindow.ts)。
  const [zooming, setZooming] = useState(false);
  const zoomAt = (direction: number, x?: number, preview = false) => {
    const current = latest.current, node = current.viewport.current;
    const next = direction === 0 ? 1 : BAND_ZOOMS[Math.max(0, Math.min(BAND_ZOOMS.length - 1, BAND_ZOOMS.indexOf(current.zoom as typeof BAND_ZOOMS[number]) + direction))]!;
    if (next === current.zoom) return;
    const offset = x ?? (node?.clientWidth ?? 0) / 2;
    const contentX = (node?.scrollLeft ?? 0) + offset - 12;
    const hit = current.spans.find(span => span.left + span.width >= contentX);
    if (hit) anchor.current = { key: hit.key, ratio: Math.max(0, Math.min(1, (contentX - hit.left) / hit.width)), x: offset };
    if (preview) current.previewZoom(next); else current.setZoom(next);
  };
  useLayoutEffect(() => {
    const saved = anchor.current, node = options.viewport.current;
    if (!saved || !node) return;
    const hit = options.spans.find(span => span.key === saved.key);
    if (hit) node.scrollLeft = Math.max(0, hit.left + hit.width * saved.ratio + 12 - saved.x);
    anchor.current = null;
  }, [options.spans, options.viewport]);
  useEffect(() => {
    const node = options.viewport.current; if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      if (event.altKey) {
        setZooming(true);
        zoomAt(event.deltaY < 0 ? 1 : -1, event.clientX - node.getBoundingClientRect().left, true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => { timer.current = null; setZooming(false); latest.current.commitZoom(); }, 250);
      } else node.scrollLeft += (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * (event.deltaMode === 1 ? 16 : 1);
    };
    const reset = () => { held.current = false; pan.current = null; setPanning(false); };
    const release = (event: globalThis.KeyboardEvent) => { if (event.code === "Space" || event.key === " ") reset(); };
    node.addEventListener("wheel", wheel, { passive: false }); window.addEventListener("blur", reset); window.addEventListener("keyup", release);
    return () => { node.removeEventListener("wheel", wheel); window.removeEventListener("blur", reset); window.removeEventListener("keyup", release); if (timer.current) clearTimeout(timer.current); };
    // Handlers read latest options; attaching once avoids interrupting wheel bursts.
  }, [options.viewport]);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): boolean => {
    if (!isPaneShortcutTarget(event.target, event.currentTarget) || event.nativeEvent.isComposing) return false;
    if ((event.metaKey || event.ctrlKey) && ["+", "=", "-", "0"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); zoomAt(event.key === "0" ? 0 : event.key === "-" ? -1 : 1); return true;
    }
    if ((event.code === "Space" || event.key === " ") && !isActivatableControl(event.target as HTMLElement)) {
      event.preventDefault(); event.stopPropagation(); if (!held.current) didPan.current = false; held.current = true; return true;
    }
    return false;
  };
  return {
    keyDown, panning, zooming, zoomAt,
    onKeyUp: (event: KeyboardEvent<HTMLDivElement>) => {
      if ((event.code === "Space" || event.key === " ") && held.current) {
        event.preventDefault(); event.stopPropagation();
        if (!didPan.current) window.dispatchEvent(new CustomEvent("tripcut:toggle-playback"));
        held.current = false; pan.current = null; setPanning(false);
      }
    },
    onPointerDownCapture: (event: PointerEvent<HTMLDivElement>) => {
      if (!held.current || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      pan.current = { x: event.clientX, left: event.currentTarget.scrollLeft }; didPan.current = true; setPanning(true); event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    move: (event: PointerEvent<HTMLDivElement>) => {
      if (!pan.current) return false;
      event.currentTarget.scrollLeft = pan.current.left + pan.current.x - event.clientX; event.preventDefault(); return true;
    },
    finish: () => { pan.current = null; setPanning(false); },
  };
}
