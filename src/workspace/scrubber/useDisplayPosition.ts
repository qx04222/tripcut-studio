import { useLayoutEffect, useRef, useState } from 'react';
import type { PlayerStatus } from '../../api';

export interface DisplayPositionInput {
  pos: number;
  duration: number;
  ready: boolean;
  paused: boolean;
  rate: number;
  end?: number | null;
  seeking?: boolean;
  rewinding?: boolean;
  switching?: boolean;
}
function advancing(input: DisplayPositionInput): boolean {
  return input.ready && !input.paused && !input.seeking && !input.rewinding && !input.switching;
}
/** 只推算显示秒数;真实状态已越界时保留诊断值,外推自身绝不扩大越界。 */
export function extrapolatePosition(input: DisplayPositionInput, elapsedMs: number): number {
  if (!advancing(input)) return input.pos;
  const ceiling = Math.min(input.end ?? input.duration, input.duration);
  const elapsed = Math.max(0, elapsedMs) / 1000;
  return Math.max(input.pos, Math.min(ceiling, input.pos + elapsed * input.rate));
}

/** 一份状态对应一个单调时钟锚点,每次回读(即使 pos 相等)都重新锚定。 */
export function useDisplayPosition(status: PlayerStatus | null, options: {
  rate: number; end?: number | null; seeking?: boolean; rewinding?: boolean; switching?: boolean;
}): number {
  const { rate, end, seeking, rewinding, switching } = options;
  const [frame, setFrame] = useState({ status, pos: status?.pos ?? 0 });
  const anchor = useRef<{ status: PlayerStatus | null | undefined; at: number }>({ status: undefined, at: 0 });
  useLayoutEffect(() => {
    const input: DisplayPositionInput = {
      pos: status?.pos ?? 0, duration: status?.duration ?? 0,
      ready: status?.phase === 'ready', paused: status?.paused !== false,
      rate, end, seeking, rewinding, switching,
    };
    const now = performance.now();
    if (anchor.current.status !== status) anchor.current = { status, at: now };
    const anchorTime = anchor.current.at;
    setFrame({ status, pos: extrapolatePosition(input, now - anchorTime) });
    if (!advancing(input)) return;
    let request: number;
    const tick = (now: number) => {
      setFrame({ status, pos: extrapolatePosition(input, now - anchorTime) });
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [status, rate, end, seeking, rewinding, switching]);
  // 新状态进入 render 的这一拍就换真位置,不让上一锚点的外推闪回。
  return frame.status === status ? frame.pos : status?.pos ?? 0;
}
