import { useEffect, useRef, type RefObject } from "react";
/** React's delegated wheel handler is passive; the track needs a non-passive listener. */
export function useWheelFrames(track: RefObject<HTMLDivElement | null>, ready: boolean, fps: number,
  position: () => number, seek: (seconds: number) => void) {
  const latest = useRef({ ready, fps, position, seek });
  latest.current = { ready, fps, position, seek };
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      const p = latest.current;
      // macOS 把 ⇧ + 滚轮转成横向滚动(deltaX,deltaY=0):两个轴都认,十帧一格在真机上才动。
      const delta = event.deltaY || event.deltaX;
      if (!p.ready || !delta || event.ctrlKey || event.metaKey) return;
      event.preventDefault(); event.stopPropagation();
      p.seek(p.position() + Math.sign(delta) * (event.shiftKey ? 10 : 1) / p.fps);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [track]);
}
