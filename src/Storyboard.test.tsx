// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ApiModule from "./api";

vi.mock("./JourneyTimeline", () => ({
  JourneyTimeline: () => <div data-testid="journey-timeline-mock" />,
}));

vi.mock("./api", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof ApiModule;
  return {
    ...actual,
    getStoryboard: vi.fn(),
    listShotStacks: vi.fn(),
    listStoryTemplates: vi.fn(),
    getNarrativeRevision: vi.fn(),
    listStoryGaps: vi.fn(async () => []),
    dismissStoryGap: vi.fn(async () => undefined),
    reopenStoryGap: vi.fn(async () => undefined),
    generationAvailability: vi.fn(async () => ({ enabled: false, has_key: false, budget_remaining_usd: 0 })),
    listGenerationRequests: vi.fn(async () => []),
    retryGeneration: vi.fn(),
    cancelGeneration: vi.fn(),
  };
});

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
import {
  getNarrativeRevision,
  getStoryboard,
  listShotStacks,
  listStoryTemplates,
  listStoryGaps,
  dismissStoryGap,
  reopenStoryGap,
  generationAvailability,
  listGenerationRequests,
  type Chapter,
  type GenerationRequestSummary,
  type NarrativeBeat,
  type Storyboard as StoryboardData,
  type StoryGap,
  type StoryItem,
} from "./api";

function emptyBoard(): StoryboardData {
  return {
    chapters: [],
    items: [],
    candidates: [],
    can_undo: false,
    mode: "legacy",
    mode_notice: "",
    narrative: null,
    narration_job_status: null,
    current_template: null,
  };
}

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

describe("storyboard journey timeline tab", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.mocked(getStoryboard).mockResolvedValue(emptyBoard());
    vi.mocked(listShotStacks).mockResolvedValue([]);
    vi.mocked(listStoryTemplates).mockResolvedValue([]);
    vi.mocked(getNarrativeRevision).mockResolvedValue(null as never);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("offers a 「旅程时间线」 tab and mounts the read-only view only once selected", async () => {
    await act(async () => {
      root.render(<StoryboardView />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const tab = Array.from(container.querySelectorAll('[role="tab"]')).find((button) =>
      button.textContent?.includes("旅程时间线"),
    );
    expect(tab).toBeTruthy();
    expect(container.querySelector('[data-testid="journey-timeline-mock"]')).toBeNull();

    await act(async () => {
      (tab as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="journey-timeline-mock"]')).not.toBeNull();
  });
});

function narrativeBoard(): StoryboardData {
  return {
    ...emptyBoard(),
    mode: "narrative",
    narrative: {
      episode: { id: 1, title: "第一集", theme: "", created_at: "", template: null },
      chapters: [
        {
          id: 1,
          kind: "destination",
          title: "第1章",
          order: 0,
          promoted: false,
          score: 0.8,
          rationale: "",
          promotion_reason: "",
          story_slots: [],
          missing_slots: [],
          digital_human_plan: null,
          beats: [],
        },
      ],
      destination_cards: [],
      boundary_signals: [],
      job_status: null,
      dh_guard: {
        historical_appearances: [],
        current_estimated_duration_s: 0,
        duration_warning_threshold_s: 0,
        warnings: [],
      },
    },
  };
}

function request(overrides: Partial<GenerationRequestSummary> = {}): GenerationRequestSummary {
  return {
    id: 42,
    status: "queued",
    error: null,
    estimated_cost_usd: 0.3,
    actual_cost_usd: null,
    result_clip_id: null,
    ...overrides,
  };
}

function gap(overrides: Partial<StoryGap> = {}): StoryGap {
  return {
    id: 1,
    chapter_id: 1,
    chapter_title: "第1章",
    beat_id: null,
    slot: "establishing",
    slot_label_zh: "建立镜头",
    reason: "该章缺一个建立镜头",
    status: "open",
    latest_request: null,
    ...overrides,
  };
}

describe("story gap cards", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.mocked(getStoryboard).mockResolvedValue(narrativeBoard());
    vi.mocked(listShotStacks).mockResolvedValue([]);
    vi.mocked(listStoryTemplates).mockResolvedValue([]);
    vi.mocked(getNarrativeRevision).mockResolvedValue(null as never);
    vi.mocked(listStoryGaps).mockResolvedValue([gap()]);
    vi.mocked(generationAvailability).mockResolvedValue({
      enabled: true,
      has_key: true,
      budget_remaining_usd: 12,
    });
    vi.mocked(listGenerationRequests).mockResolvedValue([]);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders a gap card with the Chinese heading and reason", async () => {
    await act(async () => {
      root.render(<StoryboardView />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("缺口：建立镜头");
    expect(container.textContent).toContain("该章缺一个建立镜头");
  });

  it("collapses a dismissed gap under 「已忽略」 and restores it via 「恢复」", async () => {
    vi.mocked(dismissStoryGap).mockResolvedValue(undefined);
    vi.mocked(reopenStoryGap).mockResolvedValue(undefined);
    await act(async () => {
      root.render(<StoryboardView />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const ignoreButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "忽略",
    ) as HTMLButtonElement;
    vi.mocked(listStoryGaps).mockResolvedValue([gap({ status: "dismissed" })]);
    await act(async () => {
      ignoreButton.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dismissStoryGap).toHaveBeenCalledWith(1);
    expect(container.textContent).toContain("已忽略 (1)");

    const restoreButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "恢复",
    ) as HTMLButtonElement;
    vi.mocked(listStoryGaps).mockResolvedValue([gap({ status: "open" })]);
    await act(async () => {
      restoreButton.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reopenStoryGap).toHaveBeenCalledWith(1);
  });

  it("disables 「生成候选」 with a Chinese hint when cloud generation is unavailable", async () => {
    vi.mocked(generationAvailability).mockResolvedValue({
      enabled: false,
      has_key: false,
      budget_remaining_usd: 0,
    });
    await act(async () => {
      root.render(<StoryboardView />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const generateButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "生成候选",
    ) as HTMLButtonElement;
    expect(generateButton.disabled).toBe(true);
    expect(container.textContent).toContain("先在设置页启用云端补镜");
  });

  it("disables all gap actions for a read-only historical episode", async () => {
    await act(async () => {
      root.render(<StoryboardView readOnly />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const buttons = Array.from(container.querySelectorAll(".story-gap-card button")) as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(container.textContent).toContain("历史集为只读档案");
  });
});

describe("story gap polling", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.mocked(getStoryboard).mockResolvedValue(narrativeBoard());
    vi.mocked(listShotStacks).mockResolvedValue([]);
    vi.mocked(listStoryTemplates).mockResolvedValue([]);
    vi.mocked(getNarrativeRevision).mockResolvedValue(null as never);
    vi.mocked(generationAvailability).mockResolvedValue({
      enabled: true,
      has_key: true,
      budget_remaining_usd: 12,
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("keeps polling while the latest request is succeeded and stops once imported", async () => {
    vi.useFakeTimers();
    vi.mocked(listStoryGaps).mockResolvedValue([
      gap({ status: "requested", latest_request: request({ status: "queued" }) }),
    ]);
    vi.mocked(listGenerationRequests)
      .mockResolvedValueOnce([request({ status: "succeeded" })])
      .mockResolvedValueOnce([request({ status: "imported" })]);

    await act(async () => {
      root.render(<StoryboardView />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(listGenerationRequests).toHaveBeenCalledTimes(1);

    // latest_request is now "succeeded" (download/import still pending) — polling must continue.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(listGenerationRequests).toHaveBeenCalledTimes(2);

    // latest_request is now "imported" (terminal) — polling must stop.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(listGenerationRequests).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("生成中");
  });

  it("clears the polling interval on unmount", async () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    vi.mocked(listStoryGaps).mockResolvedValue([
      gap({ status: "requested", latest_request: request({ status: "queued" }) }),
    ]);
    vi.mocked(listGenerationRequests).mockResolvedValue([request({ status: "queued" })]);

    await act(async () => {
      root.render(<StoryboardView />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => root.unmount());
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
