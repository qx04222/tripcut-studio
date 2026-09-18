import { foldKey } from "./bandGeometry";
import { BAND_SEGMENT_PITCH, secondsLabel, segmentDurationMs, type BandChapter } from "./shotBandModel";

/**
 * R13 §4:镜头带时间线化的纯数据层。镜头带的横轴是**节距轴**(每个镜块固定 BAND_SEGMENT_PITCH px,与时长无关),
 * 时间只在块内线性 —— 所以时间 ↔ 像素是一条分段线性映射,刻度、播放头、点击 seek 三处都从
 * 同一张 span 表算,才不会各画各的。
 */

/** 镜块瓦片的实宽(140,节距 148 里余下 8 是间距;R19 V-06 由 160 收小)。 */
export const BAND_TILE_WIDTH = BAND_SEGMENT_PITCH - 8;
/** 时间刻度轨的高度(视口上方,故事模式常驻)。 */
export const BAND_TIME_RULER_HEIGHT = 22;

export interface TimelineSpan {
  /** 镜块 = StoryItem.key;折叠章 / 空章 = `chapter:<id>`。 */
  key: string;
  clipId: number | null;
  segmentId: number | null;
  /** 在带上的起始时刻(前面所有块的时长之和,毫秒)。 */
  startMs: number;
  durationMs: number;
  /** 本块在素材里的入点(毫秒);整条素材是 0。 */
  inMs: number;
  /** 像素:左沿与实宽。 */
  left: number;
  width: number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** 每章每块一个 span;折叠章 / 空章各是一个 160 宽的 span(折叠章带整章时长,空章 0 秒)。 */
export function timelineSpans(
  chapters: readonly BandChapter[],
  offsets: readonly number[],
  folded: ReadonlySet<string>,
): TimelineSpan[] {
  const spans: TimelineSpan[] = [];
  let startMs = 0;
  chapters.forEach((chapter, index) => {
    const left = offsets[index] ?? 0;
    if (folded.has(foldKey(chapter)) || chapter.segments.length === 0) {
      const durationMs = folded.has(foldKey(chapter)) ? chapter.durationMs : 0;
      spans.push({ key: foldKey(chapter), clipId: null, segmentId: null, startMs, durationMs, inMs: 0, left, width: BAND_TILE_WIDTH });
      startMs += durationMs;
      return;
    }
    chapter.segments.forEach((segment, position) => {
      const durationMs = segmentDurationMs(segment);
      const inMs = segment.tbNum > 0 && segment.tbDen > 0 ? (segment.inTicks * segment.tbNum * 1_000) / segment.tbDen : 0;
      spans.push({
        key: segment.key,
        clipId: segment.clipId,
        segmentId: segment.segmentId,
        startMs,
        durationMs,
        inMs,
        left: left + position * BAND_SEGMENT_PITCH,
        width: BAND_TILE_WIDTH,
      });
      startMs += durationMs;
    });
  });
  return spans;
}

/** 带上的总时长 = 最后一个 span 的终点。 */
export function timelineTotalMs(spans: readonly TimelineSpan[]): number {
  const last = spans[spans.length - 1];
  return last ? last.startMs + last.durationMs : 0;
}

/** 刻度步长按总时长自适应:≤ 1 分钟每秒(标签每 5 秒)、≤ 10 分钟每 10 秒(标签每 30 秒)、再长每分钟。 */
export function rulerStep(totalMs: number): { stepMs: number; labelEvery: number } {
  if (totalMs <= 60_000) return { stepMs: 1_000, labelEvery: 5 };
  if (totalMs <= 600_000) return { stepMs: 10_000, labelEvery: 3 };
  return { stepMs: 60_000, labelEvery: 1 };
}

/** 时刻 → 像素:落在哪个块里就在那个块内线性;0 秒的块跳过;越界夹到两端。 */
export function timeToPx(spans: readonly TimelineSpan[], ms: number): number {
  const first = spans[0];
  if (!first) return 0;
  if (ms <= 0) return first.left;
  for (const span of spans) {
    if (span.durationMs <= 0) continue;
    if (ms < span.startMs + span.durationMs || span === lastTimed(spans)) {
      return span.left + clamp01((ms - span.startMs) / span.durationMs) * span.width;
    }
  }
  const last = spans[spans.length - 1]!;
  return last.left + last.width;
}

function lastTimed(spans: readonly TimelineSpan[]): TimelineSpan | undefined {
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    if (spans[index]!.durationMs > 0) return spans[index];
  }
  return undefined;
}

/** 像素 → 块与块内比例(0..1)与素材内时刻;点在缝里归到左边那块的末尾。 */
export function pxToTime(
  spans: readonly TimelineSpan[],
  px: number,
): { span: TimelineSpan; ratio: number; clipMs: number } | null {
  if (spans.length === 0) return null;
  let hit: TimelineSpan = spans[0]!;
  for (const span of spans) {
    if (span.left <= px) hit = span;
    else break;
  }
  const ratio = clamp01((px - hit.left) / hit.width);
  return { span: hit, ratio, clipMs: hit.inMs + ratio * hit.durationMs };
}

/** 监视器的 `tripcut:seek-ratio` 只认整条素材的 0..1;素材时长未知(0)时无法换算。 */
export function seekRatioFor(span: TimelineSpan, ratio: number, clipDurationMs: number): number | null {
  if (clipDurationMs <= 0) return null;
  return clamp01((span.inMs + clamp01(ratio) * span.durationMs) / clipDurationMs);
}

export const timecode = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1_000));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
};

export interface RulerTick {
  ms: number;
  px: number;
  /** 只有整标签格才带文字(每 labelEvery 格一个),其余是短刻度。 */
  label: string | null;
}

/** 从 0 到总时长按步长出刻度;最后一格若不是整步长也补一条(带的终点)。 */
export function rulerTicks(spans: readonly TimelineSpan[], totalMs: number): RulerTick[] {
  if (spans.length === 0 || totalMs <= 0) return [];
  const { stepMs, labelEvery } = rulerStep(totalMs);
  const ticks: RulerTick[] = [];
  for (let ms = 0, index = 0; ms <= totalMs; ms += stepMs, index += 1) {
    ticks.push({ ms, px: timeToPx(spans, ms), label: index % labelEvery === 0 ? timecode(ms) : null });
  }
  if (ticks[ticks.length - 1]!.ms !== totalMs) ticks.push({ ms: totalMs, px: timeToPx(spans, totalMs), label: null });
  return ticks;
}

/**
 * 播放头:当前素材的 `position`(毫秒)落在它的哪个镜块上、块内多远。同一条素材在带上出现多次时
 * 取入出点覆盖当前时刻的那一块,都不覆盖就取最近的;素材不在带上 → null。
 */
export function playheadPx(spans: readonly TimelineSpan[], clipId: number | null, positionMs: number): number | null {
  if (clipId === null) return null;
  const mine = spans.filter((span) => span.clipId === clipId);
  if (mine.length === 0) return null;
  const distance = (span: TimelineSpan): number =>
    positionMs < span.inMs ? span.inMs - positionMs : positionMs > span.inMs + span.durationMs ? positionMs - span.inMs - span.durationMs : 0;
  const span = mine.reduce((best, candidate) => (distance(candidate) < distance(best) ? candidate : best));
  const ratio = span.durationMs > 0 ? clamp01((positionMs - span.inMs) / span.durationMs) : 0;
  return span.left + ratio * span.width;
}

/** 吸附到 0.1 s。 */
export const snapTenth = (seconds: number): number => Math.max(0, Math.round(seconds * 10) / 10);

/** 拖边的夹取:入点 ∈ [0, 出点 − 0.1],出点 ∈ [入点 + 0.1, 素材时长](时长未知时不封顶)。 */
export function clampTrim(
  base: { inSec: number; outSec: number; clipSec: number | null },
  edge: "in" | "out",
  deltaSec: number,
): { inSec: number; outSec: number } {
  if (edge === "in") {
    const inSec = snapTenth(Math.min(Math.max(0, base.inSec + deltaSec), snapTenth(base.outSec - 0.1)));
    return { inSec, outSec: base.outSec };
  }
  const ceiling = base.clipSec === null ? Number.POSITIVE_INFINITY : base.clipSec;
  const outSec = snapTenth(Math.max(Math.min(base.outSec + deltaSec, ceiling), base.inSec + 0.1));
  return { inSec: base.inSec, outSec };
}

/** 拖动时镜块上的新时长「3.2 s」。 */
export const trimDurationLabel = (seconds: number): string => `${secondsLabel(snapTenth(seconds))} s`;
