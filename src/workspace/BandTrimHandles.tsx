import { useCallback, useRef, useState, type JSX, type KeyboardEvent, type PointerEvent } from "react";

import { BAND_TILE_WIDTH, clampTrim, trimDurationLabel } from "./bandTimeline";
import type { BandSegment } from "./shotBandModel";
import type { BandTrimApi } from "./useBandTrim";

/**
 * R13 §4:精选段镜块两侧的拖边把手。左把手拖入点、右把手拖出点;拖动时镜块上方显示新时长,
 * 松手才写(useBandTrim);吸附 0.1 s;方向键 ← → 也能一次挪 0.1 s(不靠指针的第二条路)。
 * 整条素材的镜块没有把手(那不是我们自己的精选段,不动原片)。
 *
 * 像素 → 秒:镜块固定 160px 代表本段时长,拖 1/4 块宽 = 段时长的 1/4;段越短拖得越细。
 */

export const TRIM_IN_LABEL = "调整入点";
export const TRIM_OUT_LABEL = "调整出点";
export const TRIM_KEY_STEP_SEC = 0.1;

interface TrimBase {
  inSec: number;
  outSec: number;
  clipSec: number | null;
}

function baseFor(segment: BandSegment, clipSec: number | null): TrimBase | null {
  if (segment.tbNum <= 0 || segment.tbDen <= 0) return null;
  const toSec = (ticks: number) => (ticks * segment.tbNum) / segment.tbDen;
  return { inSec: toSec(segment.inTicks), outSec: toSec(segment.outTicks), clipSec };
}

interface Drag {
  edge: "in" | "out";
  startX: number;
  width: number;
  clamped?: boolean;
  next: { inSec: number; outSec: number };
}

export function TrimHandles({ segment, trim, disabled }: { segment: BandSegment; trim: BandTrimApi; disabled: boolean }): JSX.Element | null {
  const [drag, setDragState] = useState<Drag | null>(null);
  // 按下与第一次移动可能落在同一个事件批次里(React 18+ 合批),move 处理器不能只看 state。
  const dragRef = useRef<Drag | null>(null);
  const setDrag = useCallback((next: Drag | null) => {
    dragRef.current = next;
    setDragState(next);
  }, []);
  const base = segment.segmentId === null ? null : baseFor(segment, trim.clipSeconds(segment.clipId));
  const durationSec = base ? base.outSec - base.inSec : 0;

  const onPointerDown = useCallback(
    (edge: "in" | "out") => (event: PointerEvent<HTMLButtonElement>) => {
      if (!base || disabled || trim.busy) return;
      event.stopPropagation();
      event.preventDefault();
      // jsdom 没有指针捕获;真浏览器里捕获后指针滑出把手仍能收到 move / up。
      event.currentTarget.setPointerCapture?.(event.pointerId);
      trim.preview?.(segment, edge === "in" ? base.inSec : base.outSec);
      setDrag({ edge, startX: event.clientX, width: event.currentTarget.closest("[data-band-key]")?.getBoundingClientRect().width || BAND_TILE_WIDTH, next: { inSec: base.inSec, outSec: base.outSec } });
    },
    [base, disabled, trim, segment, setDrag],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const current = dragRef.current;
      if (!current || !base) return;
      const deltaSec = ((event.clientX - current.startX) / current.width) * durationSec;
      const next = clampTrim(base, current.edge, deltaSec);
      const seconds = current.edge === "in" ? next.inSec : next.outSec;
      const requested = (current.edge === "in" ? base.inSec : base.outSec) + deltaSec;
      const clamped = requested < 0 || (base.clipSec !== null && requested > base.clipSec) || (current.edge === "in" ? requested >= base.outSec : requested <= base.inSec);
      const frame = trim.frameStep?.(segment.clipId) ?? 0.04;
      const lastFrame = base.clipSec === null ? Infinity : Math.max(0, Math.ceil(base.clipSec / frame) - 1) * frame;
      const preview = Math.max(0, Math.min(lastFrame, Math.round(seconds / frame) * frame));
      trim.preview?.(segment, preview);
      setDrag({ ...current, next, clamped });
    },
    [base, durationSec, trim, segment, setDrag],
  );

  const onPointerUp = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const current = dragRef.current;
      if (!current || !base) return;
      event.stopPropagation();
      setDrag(null);
      if (current.next.inSec !== base.inSec || current.next.outSec !== base.outSec) trim.commit(segment, current.next.inSec, current.next.outSec);
    },
    [base, segment, trim, setDrag],
  );

  const onKeyDown = useCallback(
    (edge: "in" | "out") => (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!base || disabled || trim.busy) return;
      if (event.key === "Escape" && drag) {
        event.stopPropagation();
        setDrag(null);
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      const next = clampTrim(base, edge, event.key === "ArrowLeft" ? -TRIM_KEY_STEP_SEC : TRIM_KEY_STEP_SEC);
      if (next.inSec !== base.inSec || next.outSec !== base.outSec) trim.commit(segment, next.inSec, next.outSec);
    },
    [base, disabled, drag, segment, trim, setDrag],
  );

  if (!base) return null;
  const shared = { disabled: disabled || trim.busy, onPointerMove, onPointerUp, onPointerCancel: () => setDrag(null) };
  const previewSec = drag ? drag.next.outSec - drag.next.inSec : null;
  return (
    <span className={`band-trim${drag ? " is-dragging" : ""}${drag?.clamped ? " is-clamped" : ""}`} data-edge={drag?.edge}>
      <button
        type="button"
        className="band-trim-handle band-trim-handle--in"
        aria-label={TRIM_IN_LABEL}
        title="拖动调整入点;← → 每次 0.1 秒"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={onPointerDown("in")}
        onKeyDown={onKeyDown("in")}
        {...shared}
      />
      <button
        type="button"
        className="band-trim-handle band-trim-handle--out"
        aria-label={TRIM_OUT_LABEL}
        title="拖动调整出点;← → 每次 0.1 秒"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={onPointerDown("out")}
        onKeyDown={onKeyDown("out")}
        {...shared}
      />
      {previewSec === null ? null : (
        <span className="band-trim-preview" role="status">
          {drag?.edge === "in" ? "入" : "出"} {timecode(drag?.edge === "in" ? drag.next.inSec : drag!.next.outSec)} · {trimDurationLabel(previewSec)}{drag?.clamped ? " · 已到边界" : ""}
        </span>
      )}
    </span>
  );
}

function timecode(seconds: number): string {
  return new Date(Math.max(0, seconds) * 1000).toISOString().slice(11, 23);
}
