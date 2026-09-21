import { describe, expect, it } from "vitest";

import type { Chapter, ClipListItem, NarrativeChapter, StoryGap, StoryItem, Storyboard } from "../api";
import { bandPickerCandidates, isTemplateCandidate, narrativeStoryOrder, storyOrderMatches } from "./bandTemplateModel";
import { bandDurationLabel } from "./BandSegment";
import { applyBandView, bandCountLabel, buildBandChapters } from "./shotBandModel";

/** R10 车道 D 的纯数据层回归:U-03(候选池 / 模板顺序回写)、U-17(空章算缺口)、U-29(计数分列)。 */

function chapter(id: number, title: string): Chapter {
  return { id, title, start_at: "", end_at: "", clip_count: 0 };
}

function item(clipId: number, chapterId: number | null, position: number, segmentId: number | null = null): StoryItem {
  return {
    key: segmentId === null ? `whole:${clipId}` : `segment:${segmentId}`,
    item_kind: segmentId === null ? "whole" : "segment",
    clip_id: clipId,
    segment_id: segmentId,
    chapter_id: chapterId,
    file_name: `${clipId}.MP4`,
    in_ticks: 0,
    out_ticks: 1_000,
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

function clip(id: number, overrides: Partial<ClipListItem> = {}): ClipListItem {
  return {
    id,
    episode_id: 1,
    folder_label: null,
    cover_url: null,
    path: `/x/${id}.MP4`,
    file_name: `${id}.MP4`,
    byte_size: 1,
    quick_hash: null,
    full_hash: null,
    tb_num: 1,
    tb_den: 1_000,
    duration_ticks: 1_000,
    fps_num: 25,
    fps_den: 1,
    is_vfr: false,
    codec: "h264",
    width: 1920,
    height: 1080,
    captured_at: null,
    status: "ready",
    error: null,
    analysis: null,
    analysis_status: null,
    analysis_error: null,
    motion: null,
    motion_status: null,
    motion_error: null,
    kind: "video",
    binary_rating: null,
    star_rating: null,
    select_count: 0,
    ...overrides,
  };
}

function board(overrides: Partial<Storyboard> = {}): Storyboard {
  return {
    chapters: [chapter(1, "出发"), chapter(2, "抵达")],
    items: [item(1, 1, 0)],
    candidates: [],
    can_undo: false,
    mode: "legacy",
    mode_notice: "",
    narrative: null,
    narration_job_status: null,
    current_template: null,
    ...overrides,
  };
}

describe("U-17:0 镜的章算一处缺口", () => {
  it("空章 gapCount = 1、clipCount = 0、isEmpty;「仅缺口」视图把它留下来", () => {
    const chapters = buildBandChapters(board(), [], [], new Map([[1, clip(1)]]));
    const [first, second] = chapters;
    expect(first!.clipCount).toBe(1);
    expect(first!.gapCount).toBe(0);
    expect(first!.isEmpty).toBe(false);
    expect(second!.clipCount).toBe(0);
    expect(second!.gapCount).toBe(1);
    expect(second!.isEmpty).toBe(true);
    expect(applyBandView(chapters, "gaps").map((entry) => entry.title)).toEqual(["抵达"]);
  });
});

describe("U-29:镜与缺口分列", () => {
  it("bandCountLabel:有缺口时「n 镜 · m 缺口」,没缺口只有「n 镜」", () => {
    expect(bandCountLabel(2, 1)).toBe("2 镜 · 1 缺口");
    expect(bandCountLabel(3, 0)).toBe("3 镜");
  });
});

describe("U-03:模板候选池 = 收藏 ∪ ≥3 星(拒绝的不算)", () => {
  it("isTemplateCandidate 逐条判定", () => {
    expect(isTemplateCandidate(clip(1, { binary_rating: 1 }))).toBe(true);
    expect(isTemplateCandidate(clip(2, { star_rating: 3 }))).toBe(true);
    expect(isTemplateCandidate(clip(3, { star_rating: 2 }))).toBe(false);
    expect(isTemplateCandidate(clip(4, { select_count: 1 }))).toBe(true);
    expect(isTemplateCandidate(clip(5, { binary_rating: -1, star_rating: 5 }))).toBe(false);
    expect(isTemplateCandidate(clip(6))).toBe(false);
  });

  it("bandPickerCandidates 去掉已经在带上的、未就绪的", () => {
    const picks = bandPickerCandidates(
      [clip(1, { binary_rating: 1 }), clip(2, { star_rating: 4 }), clip(3, { star_rating: 4, status: "duplicate" }), clip(4), clip(5, { kind: "photo", star_rating: 5 }), clip(6, { kind: undefined, star_rating: 5 })],
      board({ items: [item(1, 1, 0)] }),
    );
    expect(picks.map((entry) => entry.id)).toEqual([2]);
  });
});

describe("U-03:模板 beats → story_order 引用", () => {
  const narrativeChapter = (id: number, order: number, beats: Array<[number, number | null, number]>): NarrativeChapter =>
    ({
      id,
      order,
      title: `章 ${id}`,
      beats: beats.map(([clipId, segmentId, beatOrder], index) => ({
        id: id * 100 + index,
        clip_id: clipId,
        segment_id: segmentId,
        role: "beat",
        order: beatOrder,
        score: 1,
        rationale: "",
        routine_suggestion: null,
        routine_cleared: false,
      })),
    }) as unknown as NarrativeChapter;

  it("按章 order、beat order 展平,重复精选只留一次;没有编排时为空", () => {
    const withNarrative = board({
      narrative: {
        chapters: [narrativeChapter(2, 1, [[3, null, 0]]), narrativeChapter(1, 0, [[2, 7, 1], [1, null, 0], [1, null, 2]])],
      } as unknown as Storyboard["narrative"],
    });
    const clips = [clip(1), clip(2, { kind: "photo" }), clip(3, { kind: undefined })];
    expect(narrativeStoryOrder(withNarrative, clips)).toEqual([
      { item_kind: "whole", clip_id: 1, segment_id: null },
    ]);
    expect(narrativeStoryOrder(board(), clips)).toEqual([]);
    expect(narrativeStoryOrder(null, clips)).toEqual([]);
  });

  it("storyOrderMatches:顺序一致才为真,免得白写一次 story_order", () => {
    const refs = narrativeStoryOrder(
      board({ narrative: { chapters: [narrativeChapter(1, 0, [[1, null, 0], [2, null, 1]])] } as unknown as Storyboard["narrative"] }),
      [clip(1), clip(2)],
    );
    expect(storyOrderMatches([item(2, 1, 1), item(1, 1, 0)], refs)).toBe(true);
    expect(storyOrderMatches([item(1, 1, 0)], refs)).toBe(false);
    expect(storyOrderMatches([item(1, 1, 1), item(2, 1, 0)], refs)).toBe(false);
  });
});

describe("缺口 D2 章 id:缺口按 band_chapter_id 挂到镜头带的章,不再拿叙事章 id 巧合匹配", () => {
  function gap(id: number, chapterId: number, bandChapterId: number | null | undefined): StoryGap {
    return {
      id,
      chapter_id: chapterId,
      band_chapter_id: bandChapterId,
      chapter_title: "叙事章",
      beat_id: null,
      slot: "REAL/ESTABLISHING",
      slot_label_zh: "建立镜头",
      reason: "缺一条建立镜头",
      status: "open",
      latest_request: null,
    };
  }
  const clips = new Map([[1, clip(1)], [2, clip(2)]]);
  const withTwoChapters = () => board({ items: [item(1, 1, 0), item(2, 2, 1)] });

  it("叙事章 id 与 D2 章 id 错开时,缺口落在 band_chapter_id 指的那一章", () => {
    // 叙事章 7 → 镜头带第 2 章;叙事章 1(与 D2 章 1 同号)→ 镜头带第 2 章:两条都该在「抵达」下,「出发」下一条都没有。
    const gaps = [gap(10, 7, 2), gap(11, 1, 2)];
    const chapters = buildBandChapters(withTwoChapters(), gaps, [], clips);
    expect(chapters[0]!.segments.filter((s) => s.kind === "slot")).toHaveLength(0);
    expect(chapters[1]!.segments.filter((s) => s.kind === "slot").map((s) => s.gap!.id)).toEqual([10, 11]);
    expect(chapters[1]!.gapCount).toBe(2);
  });

  it("band_chapter_id 为 null / 缺席(旧后端)时才回落到 chapter_id", () => {
    const gaps = [gap(10, 1, null), gap(11, 2, undefined)];
    const chapters = buildBandChapters(withTwoChapters(), gaps, [], clips);
    expect(chapters[0]!.segments.filter((s) => s.kind === "slot").map((s) => s.gap!.id)).toEqual([10]);
    expect(chapters[1]!.segments.filter((s) => s.kind === "slot").map((s) => s.gap!.id)).toEqual([11]);
  });
});

describe("R-02:镜头带时长按素材的 time base 换算,不把 ticks 当毫秒", () => {
  it("1/19200 的素材:分段带 tbNum/tbDen,章节时长按各段换算成毫秒相加", () => {
    const tickItem: StoryItem = {
      ...item(1, 1, 0),
      in_ticks: 0,
      out_ticks: 19_200 * 23 + 9_600, // 23.5 s
      tb_num: 1,
      tb_den: 19_200,
    };
    const msItem: StoryItem = { ...item(2, 1, 1), in_ticks: 0, out_ticks: 1_500, tb_num: 1, tb_den: 1_000 };
    const board: Storyboard = {
      chapters: [{ id: 1, title: "出发", start_at: "", end_at: "", clip_count: 2 }],
      items: [tickItem, msItem],
      candidates: [],
      can_undo: false,
      mode: "legacy",
      mode_notice: "",
      narrative: null,
      narration_job_status: null,
      current_template: null,
    };
    const chapters = buildBandChapters(board, [], [], new Map([[1, clip(1)], [2, clip(2)]]));
    const [first, second] = chapters[0]!.segments;
    expect([first!.tbNum, first!.tbDen]).toEqual([1, 19_200]);
    expect(bandDurationLabel(first!.durationTicks, first!.tbNum, first!.tbDen)).toBe("0:23");
    expect([second!.tbNum, second!.tbDen]).toEqual([1, 1_000]);
    expect(chapters[0]!.durationMs).toBe(25_000);
    expect(bandDurationLabel(chapters[0]!.durationMs)).toBe("0:25");
  });
});
