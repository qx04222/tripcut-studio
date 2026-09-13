import { describe, expect, it } from "vitest";

import type { ClipMoment } from "../api";
import {
  HEAT_MAX_POINTS,
  bestMomentStart,
  heatPoints,
  stepSuggestionIndex,
  suggestionRanges,
  suggestionStatusLine,
  ticksToSeconds,
} from "./monitorSuggestions";

const tb = { tb_num: 1, tb_den: 1000 };

function fullMoment(index: number, score: number): ClipMoment {
  return {
    clip_id: 9,
    win_index: index,
    t_start_ticks: index * 500,
    t_end_ticks: (index + 1) * 500,
    sharp: score,
    motion: 0.3,
    exposure_ok: true,
    loud: false,
    speech: false,
    scene_cut: false,
    score,
    reasons: score >= 0.6 ? ["清晰"] : [],
  };
}

function moments(count: number, score: (index: number) => number): ClipMoment[] {
  return Array.from({ length: count }, (_, index) => fullMoment(index, score(index)));
}

describe("monitorSuggestions", () => {
  it("ticks 按素材时基换算成秒,坏时基回 0", () => {
    expect(ticksToSeconds(1500, tb)).toBe(1.5);
    expect(ticksToSeconds(90_000, { tb_num: 1, tb_den: 90_000 })).toBe(1);
    expect(ticksToSeconds(10, { tb_num: null, tb_den: null })).toBe(0);
  });

  it("热力条最多 200 个点,每桶取最高分而不是平均", () => {
    // 20 分钟素材:2400 格 → 200 桶,每桶 12 格。第 100 格(50 s)是唯一的峰。
    const points = heatPoints(moments(2400, (index) => (index === 100 ? 1 : 0.1)), tb, 1200);
    expect(points).toHaveLength(HEAT_MAX_POINTS);
    const peak = points.find((point) => point.score === 1);
    expect(peak).toBeDefined();
    // 50 s / 1200 s ≈ 0.0417 → 第 8 桶
    expect(Math.round(peak!.at * HEAT_MAX_POINTS)).toBe(8);
    expect(points.every((point) => point.width > 0)).toBe(true);
  });

  it("短素材的点数就是格数;没有时刻分或时长为 0 不画", () => {
    expect(heatPoints(moments(20, () => 0.5), tb, 10)).toHaveLength(20);
    expect(heatPoints([], tb, 10)).toEqual([]);
    expect(heatPoints(moments(20, () => 0.5), tb, 0)).toEqual([]);
  });

  it("最高分时刻取那一格的起点秒;并列取最早的", () => {
    expect(bestMomentStart(moments(10, (index) => (index === 6 ? 0.9 : 0.2)), tb)).toBe(3);
    expect(bestMomentStart(moments(10, () => 0.5), tb)).toBe(0);
    expect(bestMomentStart([], tb)).toBeNull();
  });

  it("N / ⇧N 首尾相接;从「没选」出发 N 到第一条、⇧N 到最后一条", () => {
    expect(stepSuggestionIndex(0, 3, 1)).toBe(1);
    expect(stepSuggestionIndex(2, 3, 1)).toBe(0);
    expect(stepSuggestionIndex(0, 3, -1)).toBe(2);
    expect(stepSuggestionIndex(-1, 3, 1)).toBe(0);
    expect(stepSuggestionIndex(-1, 3, -1)).toBe(2);
    expect(stepSuggestionIndex(0, 0, 1)).toBe(-1);
  });

  it("状态行「建议 2/3 · 6.0 s · 清晰·运动适中」;反向区间被丢掉", () => {
    const ranges = suggestionRanges(
      [
        { in_ticks: 1000, out_ticks: 7000, score: 0.9, reasons: ["清晰", "运动适中"] },
        { in_ticks: 20_000, out_ticks: 26_000, score: 0.8, reasons: ["有人声"] },
        { in_ticks: 9000, out_ticks: 9000, score: 0.1, reasons: [] },
      ],
      tb,
    );
    expect(ranges).toHaveLength(2);
    expect(suggestionStatusLine(0, ranges)).toBe("建议 1/2 · 6.0 s · 清晰·运动适中");
    expect(suggestionStatusLine(1, ranges)).toBe("建议 2/2 · 6.0 s · 有人声");
    expect(suggestionStatusLine(5, ranges)).toBeNull();
  });
});
