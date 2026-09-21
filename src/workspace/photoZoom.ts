import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

export type PhotoZoomMode = "fit" | "100" | "200" | "400";
export const PHOTO_ZOOM_MODES: readonly PhotoZoomMode[] = ["fit", "100", "200", "400"];

const SCALE: Record<PhotoZoomMode, number> = { fit: 1, "100": 1, "200": 2, "400": 4 };
type Point = { x: number; y: number };
type Drag = Point & { pointerId: number; originX: number; originY: number };

export function photoZoomLabel(mode: PhotoZoomMode): string {
  return mode === "fit" ? "适屏" : `${mode}%`;
}

export function usePhotoZoom(resetKey: string | number | null | undefined) {
  const [mode, setMode] = useState<PhotoZoomMode>("fit");
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const drag = useRef<Drag | null>(null);
  const choose = useCallback((next: PhotoZoomMode) => {
    setMode(next);
    if (next === "fit") setPan({ x: 0, y: 0 });
  }, []);
  const cycle = useCallback(() => {
    setMode((current) => {
      const next = PHOTO_ZOOM_MODES[(PHOTO_ZOOM_MODES.indexOf(current) + 1) % PHOTO_ZOOM_MODES.length]!;
      if (next === "fit") setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);
  const nudge = useCallback((x: number, y: number) => {
    if (mode !== "fit") setPan((current) => ({ x: current.x + x, y: current.y + y }));
  }, [mode]);
  const wheel = useCallback((deltaY: number) => {
    const index = PHOTO_ZOOM_MODES.indexOf(mode);
    const nextIndex = Math.max(0, Math.min(PHOTO_ZOOM_MODES.length - 1, index + (deltaY < 0 ? 1 : -1)));
    choose(PHOTO_ZOOM_MODES[nextIndex]!);
  }, [choose, mode]);
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (mode === "fit" || event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: pan.x, originY: pan.y };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }, [mode, pan]);
  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setPan({ x: start.originX + event.clientX - start.x, y: start.originY + event.clientY - start.y });
  }, []);
  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);
  useEffect(() => {
    setMode("fit");
    setPan({ x: 0, y: 0 });
    drag.current = null;
  }, [resetKey]);
  const imageStyle: CSSProperties = { transform: `translate(${pan.x}px, ${pan.y}px) scale(${SCALE[mode]})` };
  return { mode, pan, imageStyle, choose, cycle, nudge, wheel, onPointerDown, onPointerMove, onPointerUp };
}
