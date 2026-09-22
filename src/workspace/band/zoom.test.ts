import { expect, it } from "vitest";
import { chapterWidth, segmentWidth } from "../bandGeometry";
import { timelineSpans } from "../bandTimeline";
import type { BandChapter, BandSegment } from "../shotBandModel";
const segment = { key: "segment:1", kind: "clip", mediaKind: "video", clipId: 1, segmentId: 1, inTicks: 0, outTicks: 2000, durationTicks: 2000, tbNum: 1, tbDen: 1000 } as BandSegment;
it("zoom changes cards, chapter width and ruler spans together, without shrinking gap prompts", () => {
  const chapter = { chapterId: 1, segments: [segment, segment], durationMs: 4000 } as BandChapter;
  expect(segmentWidth(segment, 0.35)).toBeCloseTo(49);
  expect(chapterWidth(chapter, false, 2)).toBe(568);
  expect(timelineSpans([chapter], [0], new Set(), 2)[1]!.left).toBe(288);
  expect(segmentWidth({ ...segment, kind: "slot" }, 0.35)).toBe(140);
});

it("keeps labels apart when a long chapter collapses into a single card", async () => {
  const { rulerTicks } = await import("../bandTimeline");
  const chapter = { chapterId: 1, segments: [segment], durationMs: 420000 } as BandChapter;
  const ticks = rulerTicks(timelineSpans([chapter], [0], new Set(["chapter:1"])), 420000);
  const labels = ticks.filter(tick => tick.label !== null);
  expect(labels.length).toBeGreaterThan(1);
  for (let index = 1; index < labels.length; index++) expect(labels[index]!.px - labels[index - 1]!.px).toBeGreaterThanOrEqual(48);
  expect(ticks.at(-1)?.ms).toBe(420000);
});
