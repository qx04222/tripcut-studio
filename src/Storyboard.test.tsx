import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  StoryboardView,
  NarrativeBeatCard,
  chapterKindLabel,
  destinationVerificationLabel,
  flattenStoryByChapter,
  moveStoryItemWithinChapter,
  reorderStoryItem,
  storyboardModeCopy,
  storyOrderRefs,
  routineTreatmentLabel,
} from "./Storyboard";
import type { Chapter, NarrativeBeat, StoryItem } from "./api";

const chapters: Chapter[] = [
  { id: 1, title: "第1段·09:00-09:30", start_at: "09:00", end_at: "09:30", clip_count: 2 },
  { id: 2, title: "第2段·11:00-11:20", start_at: "11:00", end_at: "11:20", clip_count: 1 },
];

function item(key: string, chapterId: number, position: number | null): StoryItem {
  const clipId = Number(key.replace(/\D/g, ""));
  return {
    key,
    item_kind: "whole",
    clip_id: clipId,
    segment_id: null,
    chapter_id: chapterId,
    file_name: `${key}.mov`,
    in_ticks: 0,
    out_ticks: 10_000,
    tb_num: 1,
    tb_den: 1_000,
    position,
    long_term_memory: {
      used_episode_badges: [],
      repeated_signature_uses: 0,
      recent_episode_window: 4,
      routine_visual: false,
      novelty_context: false,
      narrative_adjustment: 0,
      routine_suggestion: null,
    },
  };
}

describe("storyboard", () => {
  it("flattens chapter groups chronologically while preserving in-chapter order", () => {
    const result = flattenStoryByChapter(chapters, [
      item("whole:3", 2, 0),
      item("whole:2", 1, 2),
      item("whole:1", 1, 1),
    ]);
    expect(result.map((candidate) => candidate.key)).toEqual(["whole:1", "whole:2", "whole:3"]);
  });

  it("moves a dragged item before its target and emits contiguous persisted positions", () => {
    const current = [item("whole:1", 1, 0), item("whole:2", 1, 1)];
    const result = reorderStoryItem(chapters, current, current[1], current[0].key);
    expect(result.map((candidate) => [candidate.key, candidate.position])).toEqual([
      ["whole:2", 0],
      ["whole:1", 1],
    ]);
  });

  it("offers a keyboard-safe one-step reorder within the same chapter", () => {
    const current = [item("whole:1", 1, 0), item("whole:2", 1, 1), item("whole:3", 2, 2)];

    expect(moveStoryItemWithinChapter(chapters, current, "whole:2", -1).map((entry) => entry.key))
      .toEqual(["whole:2", "whole:1", "whole:3"]);
    expect(moveStoryItemWithinChapter(chapters, current, "whole:1", -1)).toEqual(current);
  });

  it("converts mixed whole and segment cards into the backend order contract", () => {
    const segment = { ...item("segment:8", 1, 1), item_kind: "segment" as const, segment_id: 8 };
    expect(storyOrderRefs([item("whole:1", 1, 0), segment])).toEqual([
      { item_kind: "whole", clip_id: 1, segment_id: null },
      { item_kind: "segment", clip_id: 8, segment_id: 8 },
    ]);
  });

  it("renders the Chinese loading state before the local database responds", () => {
    expect(renderToStaticMarkup(<StoryboardView />)).toContain("正在装载旅行章节与故事顺序");
  });

  it("maps all narrative chapter kinds to the required Chinese badges", () => {
    expect(chapterKindLabel("destination")).toBe("目的地");
    expect(chapterKindLabel("rv_life")).toBe("房车生活");
    expect(chapterKindLabel("transition")).toBe("过渡");
  });

  it("keeps the L3-off mode visibly distinct from narrative v2", () => {
    expect(storyboardModeCopy("legacy")).toBe("D2 本地故事板");
    expect(storyboardModeCopy("narrative")).toBe("Episode / Chapter / Beat");
  });

  it("labels every newly generated destination card as pending verification", () => {
    expect(destinationVerificationLabel(false)).toBe("待核实");
    expect(destinationVerificationLabel(true)).toBe("已核实");
  });

  it("renders all routine treatments as non-binding editorial suggestions", () => {
    // AI 推导的三档
    expect(routineTreatmentLabel("explained")).toBe("首次·完整解释");
    expect(routineTreatmentLabel("story_event")).toBe("变化·主故事事件");
    expect(routineTreatmentLabel("montage")).toBe("重复·压成 Montage");
    // 人工可选的剪辑动作(与后端 routine_override::TREATMENTS 同一套枚举)
    expect(routineTreatmentLabel("transition")).toBe("重复·压成过场");
    expect(routineTreatmentLabel("beat")).toBe("保留为普通 Beat");
    expect(routineTreatmentLabel("full")).toBe("整条保留");
    // 未知值原样显示,不再被兜底误译
    expect(routineTreatmentLabel("unknown_kind")).toBe("unknown_kind");
  });

  it("keeps a recover control reachable after 'non-Routine' clears the AI suggestion", () => {
    // 回归说明：「非 Routine」一旦设置,恢复控件立即消失,形成不可逆
    // UI 死路——组件原先只在 beat.routine_suggestion 存在时渲染 Routine
    // 按钮;后端 cleared override 把 routine_suggestion 抹成 null 后,
    // 就再也没有任何控件能调用 setRoutineOverride(clipId, null, false) 恢复。
    const clearedBeat: NarrativeBeat = {
      id: 1,
      clip_id: 9,
      segment_id: null,
      role: "beat",
      order: 0,
      score: 0.5,
      rationale: "",
      routine_suggestion: null,
      routine_cleared: true,
    };
    const cleared = renderToStaticMarkup(<NarrativeBeatCard beat={clearedBeat} />);
    expect(cleared).toContain("恢复 AI 建议");

    // 对照组:从未有过建议(不是被清除)的 beat 不应该出现恢复按钮。
    const neverSuggestedBeat: NarrativeBeat = { ...clearedBeat, routine_cleared: false };
    const untouched = renderToStaticMarkup(<NarrativeBeatCard beat={neverSuggestedBeat} />);
    expect(untouched).not.toContain("恢复 AI 建议");
  });
});
