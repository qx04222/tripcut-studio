import type { TimelineSpan } from "../bandTimeline";

/**
 * R22-C 拖动 / ⌥滚轮缩放期间的**段级**窗口。章级虚拟化放宽成「视口 ±1 屏 + 源章」之后,300 段夹具上一次拖动仍会
 * 渲染 ~120 张 sortable,而 dnd-kit 每次指针移动都让每个 useSortable 重渲染 —— 5 s 拖动掉帧 5–6%。
 * 只在拖动 / 缩放连击中启用(`active` 为假时返回 undefined,媒体池 → 镜头带的回显滚动等照旧能按 DOM
 * 找到镜块):保留视口前后各一屏内的段,再无条件保留 `keep` 里的那几块(正在拖的块卸载了 dnd-kit 会取消拖动)。
 * ⌥滚轮缩放同样一步就重画所有可见镜块(300 段夹具上每步 60–120 张),连击 20 次掉帧 6.7%,套同一个窗口。
 */
export function dragRenderKeys(
  spans: readonly TimelineSpan[],
  active: boolean,
  keep: ReadonlySet<string> | undefined,
  viewportWidth: number,
  scrollLeft: number,
): Set<string> | undefined {
  if (!active) return undefined;
  const width = viewportWidth || 1_200;
  const start = scrollLeft - width;
  const end = scrollLeft + width * 2;
  const keys = new Set<string>();
  for (const span of spans) if (span.left + span.width >= start && span.left <= end) keys.add(span.key);
  keep?.forEach((key) => keys.add(key));
  return keys;
}

export type SegmentRun = { kind: "segment"; key: string } | { kind: "spacer"; key: string; width: number };

/** 把一章的段按 renderKeys 分成「渲染 / 占位」两种 run;连续不渲染的镜块合成一块占位(宽 = Σ(块宽 + 8) − 8,对应 flex gap 8)。缺口卡(slot)永远渲染。 */
export function spacerRuns<T extends { key: string; kind: "clip" | "slot" }>(
  segments: readonly T[],
  renderKeys: ReadonlySet<string> | undefined,
  widthOf: (segment: T) => number,
): SegmentRun[] {
  const runs: SegmentRun[] = [];
  let pending: { key: string; width: number } | null = null;
  const flush = () => {
    if (pending) runs.push({ kind: "spacer", key: `spacer:${pending.key}`, width: pending.width - 8 });
    pending = null;
  };
  for (const segment of segments) {
    if (renderKeys && segment.kind === "clip" && !renderKeys.has(segment.key)) {
      pending = pending ? { key: pending.key, width: pending.width + widthOf(segment) + 8 } : { key: segment.key, width: widthOf(segment) + 8 };
      continue;
    }
    flush();
    runs.push({ kind: "segment", key: segment.key });
  }
  flush();
  return runs;
}
