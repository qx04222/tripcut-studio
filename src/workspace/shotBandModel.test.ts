import { MUSIC_RULER_HEIGHT } from "./MusicRuler";
import { describe, expect, it } from "vitest";

import type {
  Chapter,
  ClipListItem,
  ShotStack,
  StoryGap,
  StoryItem,
  Storyboard,
} from "../api";
import {
  applyBandView,
  bandMinHeight,
  bandPanelHeight,
  bandPanelMinHeight,
  BAND_MUSIC_RULER_HEIGHT,
  BAND_CHAPTER_HEAD_HEIGHT,
  BAND_TILE_HEIGHT,
  BAND_VIEWPORT_HEIGHT,
  buildBandChapters,
  renderableChapterRange,
  segmentAriaLabel,
  slotLabelZh,
  type BandChapter,
} from "./shotBandModel";

function chapter(id: number, title: string): Chapter {
  return { id, title, start_at: "", end_at: "", clip_count: 0 };
}

function item(clipId: number, chapterId: number | null, fileName: string, position: number): StoryItem {
  return {
    key: `whole:${clipId}`,
    item_kind: "whole",
    clip_id: clipId,
    segment_id: null,
    chapter_id: chapterId,
    file_name: fileName,
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

function gap(id: number, chapterId: number, slot: string, labelZh: string): StoryGap {
  return {
    id,
    chapter_id: chapterId,
    chapter_title: "出发",
    beat_id: null,
    slot,
    slot_label_zh: labelZh,
    reason: `本章缺一条${labelZh}`,
    status: "open",
    latest_request: null,
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
    binary_rating: null,
    star_rating: null,
    select_count: 0,
    ...overrides,
  };
}

const GENERATED_CLIP_ID = 5;

const board: Storyboard = {
  chapters: [chapter(1, "出发"), chapter(2, "抵达")],
  items: [
    item(1, 1, "A.MP4", 0),
    item(2, 1, "B.MP4", 1),
    item(3, 2, "C.MP4", 2),
    item(4, 2, "D.MP4", 3),
    item(GENERATED_CLIP_ID, 2, "GEN.MP4", 4),
  ],
  candidates: [],
  can_undo: false,
  mode: "narrative",
  mode_notice: "",
  narrative: null,
  narration_job_status: null,
  current_template: null,
};

const gaps: readonly StoryGap[] = [
  gap(10, 1, "REAL/ESTABLISHING", "建立镜头"),
  // 白名单外的两条:后端本就不产生它们,前端也必须自己挡一道。
  gap(11, 1, "DH INTRO", "数字人开场"),
  gap(12, 2, "MAP", "地图"),
  gap(13, 1, "ATMOSPHERE", "氛围镜头"),
];

const stacks: readonly ShotStack[] = [
  {
    id: 99,
    scene_id: 1,
    scene_name: "抵达",
    stack_type: "visual",
    subject_label: "",
    function_label: "",
    shot_size_label: "",
    movement_label: "",
    quality_exempt: false,
    members: [4, GENERATED_CLIP_ID, 3].map((clipId) => ({
      clip_id: clipId,
      segment_id: null,
      best_take_score: 0.5,
      score_breakdown: {} as ShotStack["members"][number]["score_breakdown"],
      user_state: "auto" as const,
      is_preferred: false,
      long_term_memory: {
        used_episode_badges: [],
        repeated_signature_uses: 0,
        recent_episode_window: 0,
        routine_visual: false,
        novelty_context: false,
        narrative_adjustment: 0,
        routine_suggestion: null,
      },
    })),
  },
];

const clipsById: ReadonlyMap<number, ClipListItem> = new Map(
  [1, 2, 3, 4, GENERATED_CLIP_ID].map((id) => [
    id,
    clip(id, id === GENERATED_CLIP_ID ? { generated_source: "minimax" } : {}),
  ]),
);

function build(): BandChapter[] {
  return buildBandChapters(board, gaps, stacks, clipsById);
}

const offsets = [0, 400, 800, 1_200, 1_600, 2_000, 2_400];

describe("镜头带数据模型", () => {
  it("按章节分组,带头带序号、标题、章节时长与缺口数", () => {
    const chapters = build();
    expect(chapters[0]!.title).toBe("出发");
    expect(chapters[0]!.gapCount).toBe(1 + 1); // 建立镜头 + 氛围镜头
    // 夹具全是 1/1000 的 tb,ticks 即毫秒;章节时长是各段换算后的毫秒和(R-02)。
    expect(chapters[0]!.durationMs).toBe(
      chapters[0]!.segments.reduce((sum, segment) => sum + segment.durationTicks, 0),
    );
  });

  it("空槽位以 slot 段出现在所属章节里,只来自白名单 slot(R7 规则不变)", () => {
    const slots = build()
      .flatMap((c) => c.segments)
      .filter((s) => s.kind === "slot")
      .map((s) => s.slot);
    expect(slots).toContain("REAL/ESTABLISHING");
    expect(slots).not.toContain("DH INTRO");
    expect(slots).not.toContain("MAP");
  });

  it("aria-label 一字不差", () => {
    const chapters = build();
    const all = chapters.flatMap((c) => c.segments);
    const clipSegment = all.find((s) => s.kind === "clip")!;
    const slotSegment = all.find((s) => s.kind === "slot")!;
    expect(segmentAriaLabel({ ...clipSegment, index: 4, fileName: "DJI_0004.MP4" })).toBe(
      "镜头 4：DJI_0004.MP4",
    );
    expect(
      segmentAriaLabel({
        ...slotSegment,
        index: 5,
        gap: { ...slotSegment.gap!, slot_label_zh: "建立镜头" },
      }),
    ).toBe("镜头 5：缺口 建立镜头");
  });

  it("序号在全带内连续,跨章节不重置", () => {
    const all = build().flatMap((c) => c.segments);
    expect(all.map((s) => s.index)).toEqual(all.map((_, index) => index + 1));
  });

  it("生成片带 AI 标记且 takeCount 来自它所属的 Stack", () => {
    const segment = build()
      .flatMap((c) => c.segments)
      .find((s) => s.clipId === GENERATED_CLIP_ID)!;
    expect(segment.isGenerated).toBe(true);
    expect(segment.takeCount).toBe(3);
  });

  it("不在任何 Stack 里的分段 takeCount 是 1(它自己)", () => {
    const segment = build()
      .flatMap((c) => c.segments)
      .find((s) => s.clipId === 1)!;
    expect(segment.takeCount).toBe(1);
    expect(segment.isGenerated).toBe(false);
  });

  it("故事板缺字段时给空带,不抛(拉取失败也不该整栏白屏)", () => {
    expect(buildBandChapters({} as Storyboard, [], [], new Map())).toEqual([]);
  });

  it("slotLabelZh 直接取后端给的中文名,不在前端重造映射", () => {
    expect(slotLabelZh(gap(1, 1, "REAL/DETAIL", "细节镜头"))).toBe("细节镜头");
  });

  it("拖动期间所有章全渲染(V14-02:虚拟化关掉,源章与每个目标章都得在,当前章 ±1 不够)", () => {
    const idle = renderableChapterRange(offsets, 900, 4, false);
    const dragging = renderableChapterRange(offsets, 900, 4, true);
    expect(dragging.fullyRendered).toEqual(offsets.map((_, index) => index));
    expect(dragging).toMatchObject({ from: 0, to: offsets.length - 1 });
    expect(idle.fullyRendered.length).toBeLessThanOrEqual(dragging.fullyRendered.length);
  });

  it("7 章、视口停在第 1 章、从第 7 章拖起:第 7 章(源)与第 1 章(目标)都全渲染", () => {
    const seven = [0, 336, 672, 1008, 1344, 1680, 2016];
    const idle = renderableChapterRange(seven, 1_200, 0, false, 0);
    expect(idle.fullyRendered).not.toContain(6);
    const dragging = renderableChapterRange(seven, 1_200, 0, true, 0);
    expect(dragging.fullyRendered).toContain(6);
    expect(dragging.fullyRendered).toContain(0);
  });

  it("视口外的章节只出带头", () => {
    const r = renderableChapterRange(offsets, 400, 0, false);
    expect(r.to).toBeLessThan(offsets.length - 1);
  });

  it("第一章拖动时也不越界(全渲染,越不了界)", () => {
    expect(renderableChapterRange(offsets, 900, 0, true).fullyRendered).toEqual(offsets.map((_, index) => index));
    expect(renderableChapterRange([], 900, 0, true)).toEqual({ from: 0, to: -1, fullyRendered: [] });
  });
});

describe("镜头带高度与视图(R9 规格 §3.7)", () => {
  it("镜头带最小高按内容算:故事模式 184,附属带展开 284", () => {
    expect(bandMinHeight("story")).toBe(184);
    for (const mode of ["music", "journey", "destination", "template"] as const) expect(bandMinHeight(mode)).toBe(284);
  });

  it("Panel 的 min 高 = 栏标题条 32 + 内容高:故事 216,附属 316,音乐再加刻度轨 36 = 352", () => {
    expect(bandPanelMinHeight("story")).toBe(216);
    expect(bandPanelMinHeight("journey")).toBe(316);
    expect(bandPanelMinHeight("music")).toBe(352);
    expect(BAND_MUSIC_RULER_HEIGHT).toBe(MUSIC_RULER_HEIGHT);
  });

  it("镜头带栏的实际高:故事模式跟内容走(不低于 min),附属模式按监视器比例分、不低于 min", () => {
    // 故事模式:瓦片下方不留一片壳底色 —— 栏高 = 量到的内容高;Take 条展开时内容更高就跟着高。
    expect(bandPanelHeight("story", { stackHeight: 900, monitorRatio: 0.5, contentHeight: 216 })).toBe(216);
    expect(bandPanelHeight("story", { stackHeight: 900, monitorRatio: 0.5, contentHeight: 308 })).toBe(308);
    // 还没量到内容(0)时退到 min。
    expect(bandPanelHeight("story", { stackHeight: 900, monitorRatio: 0.5, contentHeight: 0 })).toBe(216);
    // 附属模式:按持久化的监视器占比分,剩余给带;不够 316 就抬到 316。
    expect(bandPanelHeight("music", { stackHeight: 1000, monitorRatio: 0.6, contentHeight: 216 })).toBe(400);
    expect(bandPanelHeight("music", { stackHeight: 700, monitorRatio: 0.6, contentHeight: 216 })).toBe(352);
    expect(bandPanelHeight("journey", { stackHeight: 600, monitorRatio: 0.8, contentHeight: 216 })).toBe(316);
    expect(bandPanelHeight("template", { stackHeight: 0, monitorRatio: 0.6, contentHeight: 216 })).toBe(316);
  });
  it("视口高 = 章节头 28 + 瓦片 130 + 滚动条 10 + 上下 padding 16", () => {
    expect(BAND_CHAPTER_HEAD_HEIGHT).toBe(28);
    expect(BAND_TILE_HEIGHT).toBe(130);
    expect(BAND_VIEWPORT_HEIGHT).toBe(184);
  });

  it("每段带本章内的槽位序号(按章重置)与叙事角色词(无叙事时为 null)", () => {
    const chapters = build();
    expect(chapters[0]!.segments.map((segment) => segment.slotIndex)).toEqual([1, 2, 3, 4]);
    expect(chapters[1]!.segments.map((segment) => segment.slotIndex)).toEqual([1, 2, 3]);
    expect(chapters[0]!.segments[0]!.roleLabel).toBeNull();
  });

  it("叙事模式下角色词来自 beat.role:beat→叙事、montage→蒙太奇、transition→过渡", () => {
    const narrativeBoard: Storyboard = {
      ...board,
      narrative: {
        chapters: [
          {
            id: 1, kind: "destination", title: "出发", order: 0, promoted: false, score: 0, rationale: "",
            promotion_reason: "", story_slots: [], missing_slots: [], digital_human_plan: null,
            beats: [
              { id: 1, clip_id: 1, segment_id: null, role: "beat", order: 0, score: 0, rationale: "", routine_suggestion: null, routine_cleared: false },
              { id: 2, clip_id: 2, segment_id: null, role: "transition", order: 1, score: 0, rationale: "", routine_suggestion: null, routine_cleared: false },
            ],
          },
        ],
      } as unknown as Storyboard["narrative"],
    };
    const chapters = buildBandChapters(narrativeBoard, [], [], clipsById);
    expect(chapters[0]!.segments.map((segment) => segment.roleLabel)).toEqual(["叙事", "过渡"]);
  });

  it("按章节视图原样返回;仅缺口视图只留有缺口的章;按时间视图是一条按拍摄时间排的平坦序列(不含空槽位)", () => {
    const chapters = build();
    expect(applyBandView(chapters, "chapter")).toBe(chapters);
    const gapsOnly = applyBandView(chapters, "gaps");
    expect(gapsOnly.map((chapter) => chapter.title)).toEqual(["出发"]);
    const timed = new Map(clipsById);
    timed.set(1, clip(1, { captured_at: "2026-08-12T10:00:00Z" }));
    timed.set(2, clip(2, { captured_at: "2026-08-11T10:00:00Z" }));
    timed.set(3, clip(3, { captured_at: "2026-08-13T10:00:00Z" }));
    const byTime = applyBandView(chapters, "time", timed);
    expect(byTime).toHaveLength(1);
    expect(byTime[0]!.title).toBe("按时间");
    expect(byTime[0]!.gapCount).toBe(0);
    // 有拍摄时间的按时间升序,没有的按原序排在后面;序号与槽位序号都重新连续编号。
    expect(byTime[0]!.segments.map((segment) => segment.clipId)).toEqual([2, 1, 3, 4, GENERATED_CLIP_ID]);
    expect(byTime[0]!.segments.map((segment) => segment.index)).toEqual([1, 2, 3, 4, 5]);
    expect(byTime[0]!.segments.every((segment) => segment.kind === "clip")).toBe(true);
  });
});
