import type { PlayerStatus } from "../api";
export { Scrubber as MonitorSeekBar } from "./scrubber/Scrubber";
export type { ScrubberProps as MonitorSeekBarProps } from "./scrubber/Scrubber";

/**
 * 「播到尾」的判定余量。mpv keep-open 停在最后一帧时 time-pos 会比 duration 少一帧
 * 上下(30p 是 33ms),EndFile 事件又把它抹平成 duration;0.2 秒够盖住这两种,又不至于
 * 把「暂停在结尾前半秒」误判成播完。
 */
export const END_EPSILON_SECONDS = 0.2;

export function isAtEnd(status: PlayerStatus | null): boolean {
  if (!status || status.phase !== "ready" || status.duration <= 0) return false;
  return status.pos >= status.duration - END_EPSILON_SECONDS;
}
