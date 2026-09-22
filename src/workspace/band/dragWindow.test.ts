import { describe, expect, it } from "vitest";

import { dragRenderKeys, spacerRuns } from "./dragWindow";

const span = (key: string, left: number, width = 152) => ({ key, clipId: null, segmentId: null, startMs: 0, durationMs: 0, inMs: 0, left, width });

describe("R22-C 拖动期间的段级窗口(300 段夹具:章级虚拟化放宽后仍有 120 张 sortable 逐帧重渲染)", () => {
  it("只保留视口前后各一屏内的段 + 正在拖的那几块;不拖(不缩放)时不启用", () => {
    const spans = Array.from({ length: 60 }, (_, i) => span(`segment:${i}`, i * 160));
    expect(dragRenderKeys(spans, false, undefined, 1_440, 0)).toBeUndefined();
    const keys = dragRenderKeys(spans, true, new Set(["segment:50", "segment:51"]), 1_440, 0)!;
    // 视口 [0, 1440) + 后一屏 → left ≤ 2880 的段(0–18)+ 拖动源 50/51。
    expect(keys.has("segment:0")).toBe(true);
    expect(keys.has("segment:18")).toBe(true);
    expect(keys.has("segment:19")).toBe(false);
    expect(keys.has("segment:50")).toBe(true);
    expect(keys.has("segment:51")).toBe(true);
    expect(keys.size).toBe(21);
  });

  it("连续的不渲染段合成一块占位,宽度 = Σ(块宽 + 8) − 8,让章宽与刻度不变;缺口卡永远渲染", () => {
    const segments = [
      { key: "a", kind: "clip" as const, width: 152 },
      { key: "b", kind: "clip" as const, width: 152 },
      { key: "gap", kind: "slot" as const, width: 152 },
      { key: "c", kind: "clip" as const, width: 76 },
      { key: "d", kind: "clip" as const, width: 76 },
      { key: "e", kind: "clip" as const, width: 152 },
    ];
    const runs = spacerRuns(segments, new Set(["e"]), (s) => s.width);
    expect(runs).toEqual([
      { kind: "spacer", key: "spacer:a", width: 152 + 8 + 152 },
      { kind: "segment", key: "gap" },
      { kind: "spacer", key: "spacer:c", width: 76 + 8 + 76 },
      { kind: "segment", key: "e" },
    ]);
    expect(spacerRuns(segments, undefined, (s) => s.width).every((run) => run.kind === "segment")).toBe(true);
  });
});
