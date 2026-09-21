import { describe, expect, it } from "vitest";

import type { Chapter, ClipListItem, StoryItem, Storyboard } from "../api";
import { applyBandView, buildBandChapters, segmentRangeLabel } from "./shotBandModel";

/** R12 车道 B 的纯数据层回归:精选段镜块的「片段 a–b s」小标;「这章够了」的章不算缺口。 */

function chapter(id: number, title: string): Chapter {
  return { id, title, start_at: "", end_at: "", clip_count: 0 };
}

function item(clipId: number, chapterId: number | null, position: number, segmentId: number | null = null, range: [number, number] = [0, 1_000]): StoryItem {
  return {
    key: segmentId === null ? `whole:${clipId}` : `segment:${segmentId}`,
    item_kind: segmentId === null ? "whole" : "segment",
    clip_id: clipId,
    segment_id: segmentId,
    chapter_id: chapterId,
    file_name: `${clipId}.MP4`,
    in_ticks: range[0],
    out_ticks: range[1],
    tb_num: 1,
    tb_den: 1_000,
    position,
    long_term_memory: {
      used_episode_badges: [],
      repeated_signature_uses: 0,
      recent_episode_window: 0,
      routine_visual: false,
      novelty_context: false,
      narrative_adjustment: 0,
      routine_suggestion: null,
    },
  };
}

function board(items: StoryItem[]): Storyboard {
  return {
    chapters: [chapter(1, "出发"), chapter(2, "抵达"), chapter(3, "夜色")],
    items,
    candidates: [],
    can_undo: false,
    mode: "legacy",
    mode_notice: "",
    narrative: null,
    narration_job_status: null,
    current_template: null,
  };
}

function videoMap(...ids: number[]): ReadonlyMap<number, ClipListItem> {
  return new Map(ids.map((id) => [id, { id, kind: "video" } as ClipListItem]));
}

describe("精选段成为镜块:「片段 a–b s」小标", () => {
  it("segmentRangeLabel 按素材自己的 time base 换算,保留一位小数、整数不带 .0", () => {
    expect(segmentRangeLabel(500, 4_500, 1, 1_000)).toBe("片段 0.5–4.5 s");
    expect(segmentRangeLabel(0, 3_000, 1, 1_000)).toBe("片段 0–3 s");
    // 1/19200 的 ticks:把它当毫秒会说成 0–0.4 s(R-02 同一个坑)。
    expect(segmentRangeLabel(19_200, 96_000, 1, 19_200)).toBe("片段 1–5 s");
    expect(segmentRangeLabel(0, 1_000, 0, 0)).toBe("片段");
  });

  it("segment 项带 rangeLabel,whole 项与空槽位为 null", () => {
    const chapters = buildBandChapters(board([item(1, 1, 0), item(2, 1, 1, 77, [500, 4_500])]), [], [], videoMap(1, 2));
    const [first] = chapters;
    expect(first!.segments.map((segment) => segment.rangeLabel)).toEqual([null, "片段 0.5–4.5 s"]);
    expect(first!.segments[1]!.segmentId).toBe(77);
  });
});

describe("「这章够了」:跳过的 0 镜章不算缺口", () => {
  it("skipped 集合里的空章 gapCount = 0、skipped = true;「仅缺口」视图不再留下它;有镜头的章不受影响", () => {
    const items = [item(1, 1, 0)];
    const plain = buildBandChapters(board(items), [], [], videoMap(1));
    expect(plain.map((entry) => entry.gapCount)).toEqual([0, 1, 1]);
    expect(plain.every((entry) => !entry.skipped)).toBe(true);

    const skipped = buildBandChapters(board(items), [], [], videoMap(1), new Set([2]));
    expect(skipped.map((entry) => entry.gapCount)).toEqual([0, 0, 1]);
    expect(skipped.map((entry) => entry.skipped)).toEqual([false, true, false]);
    expect(skipped[1]!.isEmpty).toBe(true);
    expect(applyBandView(skipped, "gaps").map((entry) => entry.title)).toEqual(["夜色"]);
    // 跳过一个有镜头的章:不改它的计数(跳过只对 0 镜章有意义),但记住标记。
    const withClips = buildBandChapters(board(items), [], [], videoMap(1), new Set([1]));
    expect(withClips[0]!.gapCount).toBe(0);
    expect(withClips[0]!.skipped).toBe(true);
  });
});
