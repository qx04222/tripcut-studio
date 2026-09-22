import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { clamp, clampEdge, fromRatio, quantize, type Range } from "./model";
export type Edge = "play" | "in" | "out";
export interface GestureProps {
  ready: boolean; clipId: number | null; pos: number; duration: number; fps: number; paused: boolean;
  range: Range; inPoint: number | null; outPoint: number | null;
  onSeek(seconds: number): void | Promise<unknown>;
  onPause?(): void | Promise<void>; onResume?(): void | Promise<void>;
  onTrim?(edge: "in" | "out", seconds: number): void;
}
export function useScrubGesture(props: GestureProps) {
  const latest = useRef(props); latest.current = props;
  const track = useRef<HTMLDivElement>(null);
  const [local, setLocal] = useState<number | null>(null);
  const [drag, setDrag] = useState<Edge | null>(null);
  const [frozenRange, setFrozenRange] = useState<Range | null>(null);
  const box = useRef({ edge: null as Edge | null, range: props.range, value: props.pos, frame: 0, offset: 0, pausing: false,
    pending: null as number | null, busy: false, resume: false, ended: false, epoch: 0 });
  const anchor = useRef<number | null>(null);
  const windowRelease = useRef<(() => void) | null>(null);
  const detach = () => { windowRelease.current?.(); windowRelease.current = null; };
  useEffect(() => {
    if (anchor.current !== null && Math.abs(props.pos - anchor.current) < 0.5 / props.fps) anchor.current = null;
    if (!props.paused && box.current.edge === null) anchor.current = null;
  }, [props.pos, props.paused, props.fps]);
  useEffect(() => {
    const b = box.current;
    b.epoch++; b.pausing = false; b.edge = null; b.pending = null; b.busy = false; b.resume = false; b.ended = false;
    cancelAnimationFrame(b.frame); b.frame = 0; anchor.current = null;
    setDrag(null); setLocal(null); setFrozenRange(null);
    return () => { b.epoch++; cancelAnimationFrame(b.frame); b.pending = null; b.resume = false; detach(); };
  }, [props.ready, props.clipId]);
  const pump = () => {
    const b = box.current;
    if (b.busy || b.pausing) return;
    if (b.pending === null) {
      if (b.ended) {
        b.ended = false; setLocal(null);
        if (b.resume) { b.resume = false; void latest.current.onResume?.(); }
      }
      return;
    }
    const target = b.pending, epoch = b.epoch;
    b.pending = null; anchor.current = target;
    const result = latest.current.onSeek(target);
    if (result && typeof result.then === "function") {
      b.busy = true;
      void result.catch(() => undefined).finally(() => {
        if (epoch !== b.epoch) return;
        b.busy = false; pump();
      });
    } else pump();
  };
  const at = (x: number) => {
    const p = latest.current, b = box.current, rect = track.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || !Number.isFinite(x)) return p.pos;
    return clamp(quantize(fromRatio((x - rect.left) / rect.width, b.edge ? b.range : p.range) + (b.edge ? b.offset : 0), p.fps), 0, p.duration);
  };
  const apply = (value: number) => {
    const p = latest.current, b = box.current;
    b.value = b.edge && b.edge !== "play" ? clampEdge(b.edge, value, p.inPoint, p.outPoint, p.duration, p.fps) : value;
    setLocal(b.value);
    if (b.edge && b.edge !== "play") p.onTrim?.(b.edge, b.value);
    b.pending = b.value; pump();
  };
  const start = (e: PointerEvent, edge: Edge) => {
    const p = latest.current, b = box.current;
    if (!p.ready || e.button > 0) return;
    e.preventDefault(); e.stopPropagation(); e.currentTarget.setPointerCapture?.(e.pointerId);
    (e.currentTarget as HTMLElement).focus();
    // 真机(WKWebView)偶发 pointerup 没送到被捕获的元素:拖动态卡住、松手的 exact 不发。
    // 松手 / 取消在 window 上也听一份,在哪松手都收尾;end() 自己按 edge 去重。
    detach();
    const release = (event: globalThis.PointerEvent) => end(event as unknown as PointerEvent);
    window.addEventListener("pointerup", release, true); window.addEventListener("pointercancel", release, true);
    windowRelease.current = () => { window.removeEventListener("pointerup", release, true); window.removeEventListener("pointercancel", release, true); };
    b.edge = edge; b.range = p.range; b.ended = false; b.resume ||= !p.paused; b.offset = 0;
    setDrag(edge); setFrozenRange(p.range);
    const pointerTime = at(e.clientX);
    const target = edge === "in" ? p.inPoint ?? pointerTime : edge === "out" ? p.outPoint ?? pointerTime : pointerTime;
    b.offset = target - pointerTime;
    if (!p.paused && p.onPause) {
      b.pausing = true; const epoch = b.epoch;
      void Promise.resolve(p.onPause()).catch(() => { if (epoch === b.epoch) b.resume = false; }).finally(() => {
        if (epoch !== b.epoch) return; b.pausing = false; pump();
      });
    }
    apply(target);
  };
  const move = (e: PointerEvent) => {
    const b = box.current;
    if (!b.edge) return;
    b.value = at(e.clientX);
    if (b.frame) return;
    b.frame = requestAnimationFrame(() => { b.frame = 0; apply(b.value); });
  };
  const end = (e?: PointerEvent) => {
    const b = box.current;
    if (!b.edge) return;
    detach();
    cancelAnimationFrame(b.frame); b.frame = 0;
    apply(e && e.type === "pointerup" ? at(e.clientX) : b.value);
    b.edge = null; b.ended = true; setDrag(null); setFrozenRange(null); pump();
  };
  const seek = (target: number, edge: Edge = "play") => {
    const p = latest.current;
    if (!p.ready) return;
    const value = edge === "play" ? clamp(quantize(target, p.fps), 0, p.duration)
      : clampEdge(edge, quantize(target, p.fps), p.inPoint, p.outPoint, p.duration, p.fps);
    if (edge !== "play") p.onTrim?.(edge, value);
    anchor.current = value; box.current.pending = value; pump();
  };
  const position = () => anchor.current ?? latest.current.pos;
  return { track, local, drag, frozenRange, start, move, end, at, seek, position };
}
