// @vitest-environment jsdom
import { expect, it } from "vitest";
import type { Storyboard, StoryItem } from "../api";
import { photoFixture, videoFixture } from "./photoTestFixtures";
import { buildBandChapters } from "./shotBandModel";
import { chapterOffsets, chapterWidth, musicPitchCount } from "./bandGeometry";
import { timelineSpans, timelineTotalMs } from "./bandTimeline";
export function mixedBoard(): Storyboard {
  const sources = [videoFixture, photoFixture, { ...videoFixture, id: 3, file_name: "unknown.mov" }];
  return { chapters: [{ id: 1, title: "出发", start_at: "", end_at: "", clip_count: 3 }],
    items: sources.map((clip, position) => ({
      key: `whole:${clip.id}`, item_kind: "whole", clip_id: clip.id, segment_id: null,
      chapter_id: 1, file_name: clip.file_name, in_ticks: 0, out_ticks: clip.duration_ticks,
      tb_num: 1, tb_den: 1000, position,
    } as StoryItem)) } as Storyboard;
}
it("R21 §0.5 band: photos and unknown-kind clips are absent from the video shot band", () => {
  const board = mixedBoard();
  const chapters = buildBandChapters(board, [], [], new Map([[1, videoFixture], [2, photoFixture]]));
  expect(chapters[0]!.segments.map((segment) => segment.clipId)).toEqual([1]);
  expect(chapters[0]!.durationMs).toBe(12000);
  expect(chapters[0]!.clipCount).toBe(1);
});
it("R21 §0.5 band: photo hold_ms never changes video geometry or timeline", () => {
  const longer = { ...photoFixture, photo: { ...photoFixture.photo!, hold_ms: 6000 } };
  const chapters = buildBandChapters(mixedBoard(), [], [], new Map([[1, videoFixture], [2, longer]]));
  expect(chapterWidth(chapters[0]!)).toBe(140);
  const spans = timelineSpans(chapters, chapterOffsets(chapters), new Set());
  expect(spans).toHaveLength(1);
  expect(spans[0]).toMatchObject({ width: 140, durationMs: 12000, left: 0 });
  expect(timelineTotalMs(spans)).toBe(12000);
});

it("R21 §0.5 band: the music ruler keeps the fixed legacy video pitch", () => {
  expect(musicPitchCount([{ mediaKind: "video" }, { mediaKind: "video" }])).toBe(2);
  expect(musicPitchCount([{ mediaKind: "video" }, {}])).toBe(2);
});
