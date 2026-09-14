import { describe, expect, it } from "vitest";

import { chapterOffsets, chapterWidth, foldKey } from "./bandGeometry";
import {
  BAND_TILE_WIDTH,
  clampTrim,
  playheadPx,
  pxToTime,
  rulerStep,
  rulerTicks,
  seekRatioFor,
  snapTenth,
  timelineSpans,
  timeToPx,
  trimDurationLabel,
} from "./bandTimeline";
import { BAND_SEGMENT_PITCH, type BandChapter, type BandSegment } from "./shotBandModel";

/**
 * R13 车道 C(规格 §4):镜头带时间线化的纯数据层 —— 时间刻度自适应、时间 ↔ 像素的分段线性映射、
 * 播放头位置、拖边裁剪的吸附与夹取、章节折叠后的几何。全部是纯函数,组件只负责画。
 */

function segment(key: string, clipId: number | null, inMs: number, durationMs: number, segmentId: number | null = null): BandSegment {
  return {
    key,
    kind: clipId === null ? "slot" : "clip",
    index: 1,
    clipId,
    segmentId,
    chapterId: 1,
    slot: clipId === null ? "ATMOSPHERE" : null,
    fileName: clipId === null ? null : `${key}.MP4`,
    inTicks: inMs,
    outTicks: inMs + durationMs,
    durationTicks: durationMs,
    tbNum: 1,
    tbDen: 1_000,
    takeCount: 1,
    takeIndex: 1,
    isGenerated: false,
    coverUrl: null,
    gap: null,
    slotIndex: 1,
    roleLabel: null,
    rangeLabel: null,
  };
}

function chapter(chapterId: number | null, segments: BandSegment[]): BandChapter {
  return {
    ordinal: 1,
    chapterId,
    title: chapterId === null ? "未分章" : `第 ${chapterId} 章`,
    durationMs: segments.reduce((sum, item) => sum + item.durationTicks, 0),
    gapCount: 0,
    clipCount: segments.filter((item) => item.kind === "clip").length,
    isEmpty: segments.length === 0,
    skipped: false,
    segments,
  };
}

// 第 1 章:A 整条 4 s、B 精选段 0.5–3.5 s(3 s);第 2 章:空;第 3 章:C 10 s。
const chapters: BandChapter[] = [
  chapter(1, [segment("whole:1", 1, 0, 4_000), segment("segment:77", 2, 500, 3_000, 77)]),
  chapter(2, []),
  chapter(3, [segment("whole:3", 3, 0, 10_000)]),
];

describe("时间刻度自适应", () => {
  it("≤ 1 分钟按秒,≤ 10 分钟按 10 秒,再长按分钟;标签每 5 格一个", () => {
    expect(rulerStep(30_000)).toEqual({ stepMs: 1_000, labelEvery: 5 });
    expect(rulerStep(60_000)).toEqual({ stepMs: 1_000, labelEvery: 5 });
    expect(rulerStep(61_000)).toEqual({ stepMs: 10_000, labelEvery: 3 });
    expect(rulerStep(600_000)).toEqual({ stepMs: 10_000, labelEvery: 3 });
    expect(rulerStep(1_800_000)).toEqual({ stepMs: 60_000, labelEvery: 1 });
    expect(rulerStep(0)).toEqual({ stepMs: 1_000, labelEvery: 5 });
  });
});

describe("时间 ↔ 像素:每个镜块固定一个节距,时间在块内线性", () => {
  const offsets = chapterOffsets(chapters);
  const spans = timelineSpans(chapters, offsets, new Set());

  it("镜块按节距排布;空章占一个 160 宽的 0 秒 span;总时长 17 s", () => {
    expect(spans.map((span) => [span.key, span.left, span.startMs, span.durationMs])).toEqual([
      ["whole:1", 0, 0, 4_000],
      ["segment:77", BAND_SEGMENT_PITCH, 4_000, 3_000],
      ["chapter:2", 2 * BAND_SEGMENT_PITCH, 7_000, 0],
      ["whole:3", 3 * BAND_SEGMENT_PITCH, 7_000, 10_000],
    ]);
    expect(spans[1]!.inMs).toBe(500);
    expect(spans[3]!.startMs + spans[3]!.durationMs).toBe(17_000);
  });

  it("timeToPx:2 s 落在第 1 块中点;7 s 落在第 3 块起点(跳过 0 秒的空章);越界夹到两端", () => {
    expect(timeToPx(spans, 2_000)).toBe(BAND_TILE_WIDTH / 2);
    expect(timeToPx(spans, 7_000)).toBe(3 * BAND_SEGMENT_PITCH);
    expect(timeToPx(spans, 12_000)).toBe(3 * BAND_SEGMENT_PITCH + BAND_TILE_WIDTH / 2);
    expect(timeToPx(spans, -5)).toBe(0);
    expect(timeToPx(spans, 99_000)).toBe(3 * BAND_SEGMENT_PITCH + BAND_TILE_WIDTH);
  });

  it("pxToTime:点在第 2 块 1/3 处 → B 的 0.5 + 1 = 1.5 s;点在缝里归到左块末尾;空章返回 clipId null", () => {
    const hit = pxToTime(spans, BAND_SEGMENT_PITCH + BAND_TILE_WIDTH / 3);
    expect(hit?.span.clipId).toBe(2);
    expect(hit?.clipMs).toBeCloseTo(1_500, 0);
    const gapHit = pxToTime(spans, BAND_TILE_WIDTH + 4);
    expect(gapHit?.span.key).toBe("whole:1");
    expect(gapHit?.ratio).toBe(1);
    expect(pxToTime(spans, 2 * BAND_SEGMENT_PITCH + 10)?.span.clipId).toBeNull();
    expect(pxToTime([], 10)).toBeNull();
  });

  it("刻度按 1 秒步进、每 5 秒一个 m:ss 标签;空章不出刻度", () => {
    const ticks = rulerTicks(spans, 17_000);
    expect(ticks[0]).toEqual({ ms: 0, px: 0, label: "0:00" });
    const five = ticks.find((tick) => tick.ms === 5_000)!;
    expect(five.label).toBe("0:05");
    expect(five.px).toBeCloseTo(BAND_SEGMENT_PITCH + BAND_TILE_WIDTH / 3, 6);
    expect(ticks.find((tick) => tick.ms === 1_000)?.label).toBeNull();
    expect(ticks.at(-1)?.ms).toBe(17_000);
    expect(rulerTicks([], 0)).toEqual([]);
  });

  it("seekRatioFor:把镜块内的时刻换成整条素材的 0..1 比例(监视器只认比例)", () => {
    expect(seekRatioFor(spans[1]!, 1 / 3, 6_000)).toBeCloseTo(1_500 / 6_000, 6);
    // 块内比例夹到 1 = 本块出点(3.5 s),不是整条素材的末尾。
    expect(seekRatioFor(spans[1]!, 5, 6_000)).toBeCloseTo(3_500 / 6_000, 6);
    expect(seekRatioFor(spans[1]!, 0.5, 0)).toBeNull();
  });
});

describe("播放头:按状态 position 与镜块入出点换算", () => {
  const spans = timelineSpans(chapters, chapterOffsets(chapters), new Set());

  it("B 精选段 0.5–3.5 s,播到 2 s → 块内 50%;越过出点钉在右沿;入点之前钉在左沿", () => {
    expect(playheadPx(spans, 2, 2_000)).toBe(BAND_SEGMENT_PITCH + BAND_TILE_WIDTH / 2);
    expect(playheadPx(spans, 2, 9_000)).toBe(BAND_SEGMENT_PITCH + BAND_TILE_WIDTH);
    expect(playheadPx(spans, 2, 0)).toBe(BAND_SEGMENT_PITCH);
  });

  it("同一条素材多块时选覆盖当前时刻的那一块;素材不在带上返回 null", () => {
    const twice = timelineSpans(
      [chapter(1, [segment("segment:1", 9, 0, 2_000, 1), segment("segment:2", 9, 5_000, 2_000, 2)])],
      [0],
      new Set(),
    );
    expect(playheadPx(twice, 9, 6_000)).toBe(BAND_SEGMENT_PITCH + BAND_TILE_WIDTH / 2);
    expect(playheadPx(twice, 9, 1_000)).toBe(BAND_TILE_WIDTH / 2);
    expect(playheadPx(spans, 42, 1_000)).toBeNull();
    expect(playheadPx(spans, null, 1_000)).toBeNull();
  });
});

describe("拖边裁入出点:吸附 0.1 s、夹在素材内、至少留 0.1 s", () => {
  it("snapTenth 四舍五入到 0.1", () => {
    expect(snapTenth(1.234)).toBe(1.2);
    expect(snapTenth(1.25)).toBe(1.3);
    expect(snapTenth(-0.04)).toBe(0);
  });

  it("拖入点:向左拉不能早于 0,向右推不能挤到出点 0.1 s 之内;拖出点对称,不能晚于素材时长", () => {
    const base = { inSec: 0.5, outSec: 3.5, clipSec: 6 };
    expect(clampTrim(base, "in", -1)).toEqual({ inSec: 0, outSec: 3.5 });
    expect(clampTrim(base, "in", 5)).toEqual({ inSec: 3.4, outSec: 3.5 });
    expect(clampTrim(base, "in", 0.26)).toEqual({ inSec: 0.8, outSec: 3.5 });
    expect(clampTrim(base, "out", 10)).toEqual({ inSec: 0.5, outSec: 6 });
    expect(clampTrim(base, "out", -10)).toEqual({ inSec: 0.5, outSec: 0.6 });
    expect(clampTrim({ ...base, clipSec: null }, "out", 10)).toEqual({ inSec: 0.5, outSec: 13.5 });
  });

  it("新时长标签「3.2 s」;整秒不带 .0", () => {
    expect(trimDurationLabel(3.2)).toBe("3.2 s");
    expect(trimDurationLabel(3)).toBe("3 s");
  });
});

describe("章节折叠后的几何", () => {
  it("折叠的章只占一个节距;偏移表跟着缩;折叠键用章 id(未分章用 none)", () => {
    const folded = new Set([foldKey(chapters[0]!)]);
    expect(foldKey(chapter(null, []))).toBe("chapter:none");
    expect(chapterWidth(chapters[0]!, true)).toBe(BAND_SEGMENT_PITCH - 8);
    expect(chapterWidth(chapters[0]!, false)).toBe(2 * BAND_SEGMENT_PITCH - 8);
    expect(chapterOffsets(chapters, folded)).toEqual([0, BAND_SEGMENT_PITCH, 2 * BAND_SEGMENT_PITCH]);
    // 折叠的章在时间轴上是一个 160 宽、时长为整章时长的 span,后面的块从它之后继续计时。
    const spans = timelineSpans(chapters, chapterOffsets(chapters, folded), folded);
    expect(spans[0]).toMatchObject({ key: "chapter:1", clipId: null, left: 0, startMs: 0, durationMs: 7_000 });
    expect(spans[2]).toMatchObject({ key: "whole:3", left: 2 * BAND_SEGMENT_PITCH, startMs: 7_000 });
  });
});
