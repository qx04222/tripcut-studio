import type { ClipListItem, ClipMoment, SegmentSuggestion } from "../api";

/**
 * R11 §1.2 监视器侧的纯函数:时刻分 → 热力条点位,建议段 → 秒与状态行文案。
 * ticks 全部按素材自己的时基换成秒,界面上永远只出现秒。
 */

/** 热力条最多画多少个点(规格:≤ 200)。 */
export const HEAT_MAX_POINTS = 200;

export interface HeatPoint {
  /** 0–1,沿时间轴的位置(点的起点)。 */
  at: number;
  /** 0–1,这一格的宽。 */
  width: number;
  /** 0–1。 */
  score: number;
}

export interface SuggestionRange {
  inSeconds: number;
  outSeconds: number;
  score: number;
  reasons: string[];
}

export function ticksToSeconds(ticks: number, clip: Pick<ClipListItem, "tb_num" | "tb_den">): number {
  if (clip.tb_num === null || clip.tb_den === null || clip.tb_den <= 0) return 0;
  return (ticks * clip.tb_num) / clip.tb_den;
}

export function suggestionRanges(suggestions: readonly SegmentSuggestion[], clip: Pick<ClipListItem, "tb_num" | "tb_den">): SuggestionRange[] {
  return suggestions
    .map((item) => ({
      inSeconds: ticksToSeconds(item.in_ticks, clip),
      outSeconds: ticksToSeconds(item.out_ticks, clip),
      score: item.score,
      reasons: item.reasons,
    }))
    .filter((item) => item.outSeconds > item.inSeconds)
    .sort((a, b) => a.inSeconds - b.inSeconds || a.outSeconds - b.outSeconds || b.score - a.score);
}

/**
 * 时刻分降采样成 ≤ maxPoints 个桶,每桶取最高分(峰不能被平均抹掉 —— 热力条的意义就是找峰)。
 * 时长为 0 或没有时刻分时返回空数组,热力条不画。
 */
export function heatPoints(
  moments: readonly ClipMoment[],
  clip: Pick<ClipListItem, "tb_num" | "tb_den">,
  durationSeconds: number,
  maxPoints = HEAT_MAX_POINTS,
): HeatPoint[] {
  if (moments.length === 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || maxPoints <= 0) return [];
  const buckets = Math.min(maxPoints, moments.length);
  const scores = new Array<number>(buckets).fill(0);
  for (const moment of moments) {
    const start = ticksToSeconds(moment.t_start_ticks, clip);
    const end = ticksToSeconds(moment.t_end_ticks, clip);
    const mid = Math.min(durationSeconds, Math.max(0, (start + end) / 2));
    const index = Math.min(buckets - 1, Math.floor((mid / durationSeconds) * buckets));
    scores[index] = Math.max(scores[index]!, Math.min(1, Math.max(0, moment.score)));
  }
  return scores.map((score, index) => ({ at: index / buckets, width: 1 / buckets, score }));
}

/** 最高分那一格的起点(秒);没有时刻分时 null。并列取最早的。 */
export function bestMomentStart(moments: readonly ClipMoment[], clip: Pick<ClipListItem, "tb_num" | "tb_den">): number | null {
  let best: ClipMoment | null = null;
  for (const moment of moments) {
    if (best === null || moment.score > best.score) best = moment;
  }
  return best === null ? null : ticksToSeconds(best.t_start_ticks, clip);
}

/** `N` / `⇧N` 的下一条 / 上一条,首尾相接;没有建议时 -1。 */
export function stepSuggestionIndex(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0) return direction === 1 ? 0 : total - 1;
  return (current + direction + total) % total;
}

/** 状态行:「建议 2/3 · 6.0 s · 清晰·运动适中」。 */
export function suggestionStatusLine(index: number, ranges: readonly SuggestionRange[]): string | null {
  const range = ranges[index];
  if (!range) return null;
  const seconds = (range.outSeconds - range.inSeconds).toFixed(1);
  const reasons = range.reasons.filter((reason) => reason.trim().length > 0).join("·");
  return `建议 ${index + 1}/${ranges.length} · ${seconds} s${reasons ? ` · ${reasons}` : ""}`;
}
