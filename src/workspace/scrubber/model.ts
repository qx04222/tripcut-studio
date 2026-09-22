export type Range = readonly [number, number];
export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
export function quantize(seconds: number, fps: number): number {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * rate) / rate;
}
export function tickStep(span: number, width: number): number {
  return [1, 2, 5, 10, 30, 60].find(step => step * width / span >= 72) ?? 60;
}
export function visibleRange(duration: number, start: number | null, end: number | null, zoom: boolean): Range {
  if (!zoom || start === null || end === null || end <= start) return [0, duration];
  const pad = (end - start) * 0.1;
  return [Math.max(0, start - pad), Math.min(duration, end + pad)];
}
export const fromRatio = (ratio: number, range: Range) => range[0] + clamp(ratio, 0, 1) * (range[1] - range[0]);
export const ratioAt = (seconds: number, range: Range) => clamp((seconds - range[0]) / (range[1] - range[0] || 1), 0, 1);
export function clampEdge(edge: "in" | "out", value: number, start: number | null, end: number | null, duration: number, fps: number): number {
  return edge === "in" ? clamp(value, 0, Math.max(0, (end ?? duration) - 1 / fps))
    : clamp(value, Math.min(duration, (start ?? 0) + 1 / fps), duration);
}
/** The suffix is a frame number, not decimal seconds (also at rational fps). */
export function parseTimecode(text: string, fps: number): number | null {
  const match = /^(?:(\d+):)?(\d+)\.(\d{1,2})$/.exec(text.trim());
  if (!match) return null;
  const minutes = Number(match[1] ?? 0), seconds = Number(match[2]), frames = Number(match[3]);
  if ((match[1] !== undefined && seconds >= 60) || frames >= Math.ceil(fps)) return null;
  const result = minutes * 60 + seconds + frames / fps;
  return Number.isFinite(result) ? result : null;
}
export function timecode(seconds: number, fps: number, short = false): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const whole = Math.floor(safe + 1e-7);
  const frame = Math.min(Math.ceil(fps) - 1, Math.floor((safe - whole) * fps + 1e-5));
  const pad = (n: number) => String(n).padStart(2, "0");
  const tail = `${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}.${pad(Math.max(0, frame))}`;
  return short && whole < 3600 ? tail : `${pad(Math.floor(whole / 3600))}:${tail}`;
}
