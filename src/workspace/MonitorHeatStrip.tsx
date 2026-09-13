import type { JSX } from "react";

import type { HeatPoint, SuggestionRange } from "./monitorSuggestions";

export interface MonitorHeatStripProps {
  points: readonly HeatPoint[];
  ranges: readonly SuggestionRange[];
  activeIndex: number;
  durationSeconds: number;
  /** 播放头(秒);null 不画。 */
  position: number | null;
}

/** SVG 内部坐标:横向 1000 单位、纵向 24 单位,`preserveAspectRatio="none"` 拉成条。 */
const W = 1000;
const H = 24;

/**
 * R11 §1.2:seek bar 下的热力条(AX 名「时刻热力」)。每格一根竖条,透明度随时刻分;
 * 建议段画成半透明区块,当前建议加边框高亮;播放头一根细线。纯展示 —— seek 仍走上方的
 * slider,这里不接指针事件,所以 role=img 就够。点数由 `heatPoints` 保证 ≤ 200。
 */
export function MonitorHeatStrip({ points, ranges, activeIndex, durationSeconds, position }: MonitorHeatStripProps): JSX.Element | null {
  if (points.length === 0 || durationSeconds <= 0) return null;
  const x = (seconds: number) => Math.min(W, Math.max(0, (seconds / durationSeconds) * W));
  const bars: JSX.Element[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    bars.push(
      <rect
        key={index}
        className="monitor-heat-bar"
        x={point.at * W}
        y={H - point.score * H}
        width={Math.max(0.5, point.width * W)}
        height={Math.max(0.5, point.score * H)}
        style={{ opacity: 0.25 + point.score * 0.75 }}
      />,
    );
  }
  const blocks: JSX.Element[] = [];
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index]!;
    blocks.push(
      <rect
        key={index}
        className={`monitor-heat-suggestion${index === activeIndex ? " active" : ""}`}
        data-active={index === activeIndex ? "true" : undefined}
        x={x(range.inSeconds)}
        y={0}
        width={Math.max(1, x(range.outSeconds) - x(range.inSeconds))}
        height={H}
        rx={2}
      />,
    );
  }
  const label =
    ranges.length > 0
      ? `时刻热力,${ranges.length} 条建议${activeIndex >= 0 ? `,当前第 ${activeIndex + 1} 条` : ""}`
      : "时刻热力";
  return (
    <svg
      className="monitor-heat"
      role="img"
      aria-label="时刻热力"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      focusable="false"
    >
      <title>{label}</title>
      {bars}
      {blocks}
      {position !== null ? <line className="monitor-heat-head" x1={x(position)} x2={x(position)} y1={0} y2={H} /> : null}
    </svg>
  );
}
