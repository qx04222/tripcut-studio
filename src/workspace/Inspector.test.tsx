// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  // useClipsFeed
  getClipsRevision: vi.fn(),
  listClips: vi.fn(),
  listShotStacks: vi.fn(),
  getStoryboard: vi.fn(),
  listStoryGaps: vi.fn(),
  listClipDimensions: vi.fn(),
  listAssetSafety: vi.fn(),
  getCurrentEpisode: vi.fn(),
  setSetting: vi.fn().mockResolvedValue(undefined),
  // TechCheckPanel
  listAudioTracks: vi.fn().mockResolvedValue([]),
  probeAudioTracks: vi.fn().mockResolvedValue([]),
  listDisplayLuts: vi.fn().mockResolvedValue([]),
  setDisplayLut: vi.fn().mockResolvedValue(undefined),
  clearDisplayLut: vi.fn().mockResolvedValue(undefined),
  setPlaybackTrack: vi.fn().mockResolvedValue(undefined),
  setTranscribeTrack: vi.fn().mockResolvedValue(undefined),
  // SimilarGroupsPanel
  listSimilarGroups: vi.fn().mockResolvedValue([]),
  setSimilarPrimary: vi.fn().mockResolvedValue(undefined),
  // GenerationDialog
  previewGeneration: vi.fn().mockResolvedValue({
    mode: "t2v",
    model: "MiniMax-H3-Max",
    resolution: "768P",
    duration_s: 6,
    ratio: "16:9",
    prompt: "",
    refs: [],
    estimated_cost_usd: 0.1,
    notes: [],
  }),
  submitGeneration: vi.fn().mockResolvedValue({
    id: 1,
    status: "submitted",
    error: null,
    estimated_cost_usd: 0.1,
    actual_cost_usd: null,
    result_clip_id: null,
  }),
  // Inspector itself
  rateClip: vi.fn().mockResolvedValue({}),
  clearClipRating: vi.fn().mockResolvedValue(undefined),
  getAiDescription: vi.fn().mockResolvedValue(null),
  listTags: vi.fn().mockResolvedValue([]),
  addTag: vi.fn(),
  removeTag: vi.fn().mockResolvedValue(undefined),
  describeClipWithAi: vi.fn().mockResolvedValue(null),
  setClipTimeStage: vi.fn().mockResolvedValue(undefined),
  getSettings: vi.fn().mockResolvedValue({}),
  getLlmStatus: vi.fn().mockResolvedValue({
    enabled: false,
    provider: "none",
    monthly_budget: 0,
    calls_this_month: 0,
    remaining_calls: 0,
    budget_exhausted: false,
    providers: [],
  }),
  dismissStoryGap: vi.fn().mockResolvedValue(undefined),
  applyNarrativeOp: vi.fn().mockResolvedValue(null),
  setStoryOrder: vi.fn().mockResolvedValue(undefined),
  undoStoryChange: vi.fn().mockResolvedValue(undefined),
  // R10 U-11 精选段区 / U-18 加入当前章节
  listSelectSegments: vi.fn().mockResolvedValue([]),
  deleteSelectSegment: vi.fn().mockResolvedValue(undefined),
  playerCommand: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../api", () => apiMocks);

import type { ClipAudioTrack, ClipListItem, ShotStack, SimilarGroup, StoryGap, Storyboard, StoryItem } from "../api";
import { Inspector, INSPECTOR_SECTIONS, sectionStatusText, type InspectorStatusContext } from "./Inspector";
import { __resetClipsFeedForTests } from "./useClipsFeed";
import { __resetWorkspaceForTests, dispatchWorkspace, getWorkspaceSnapshot } from "./WorkspaceStore";

function clip(id: number, overrides: Partial<ClipListItem> = {}): ClipListItem {
  return {
    id,
    episode_id: 1,
    folder_label: null,
    cover_url: null,
    path: `/Volumes/CARD/clip-${id}.mov`,
    file_name: `clip-${id}.mov`,
    byte_size: 2048,
    quick_hash: null,
    full_hash: null,
    tb_num: 1,
    tb_den: 1000,
    duration_ticks: 12_000,
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

const stack: ShotStack = {
  id: 9,
  scene_id: 1,
  scene_name: "场景一",
  stack_type: "visual",
  subject_label: "人物",
  function_label: "过程",
  shot_size_label: "中景",
  movement_label: "手持",
  quality_exempt: false,
  members: [
    {
      clip_id: 1,
      segment_id: null,
      best_take_score: 0.8,
      user_state: "auto",
      is_preferred: true,
      long_term_memory: {
        used_episode_badges: [],
        repeated_signature_uses: 0,
        recent_episode_window: 0,
        routine_visual: false,
        novelty_context: false,
        narrative_adjustment: 0,
        routine_suggestion: null,
      },
      score_breakdown: {
        technical: { score: 0.8, confidence: 1, source: "auto", note: "" },
        composition: { score: 0.8, confidence: 1, source: "auto", note: "" },
        motion: { score: 0.8, confidence: 1, source: "auto", note: "" },
        human: { score: 0.8, confidence: 1, source: "auto", note: "" },
        audio: { score: 0.8, confidence: 1, source: "auto", note: "" },
        narrative: { score: 0.8, confidence: 1, source: "auto", note: "" },
        configured_weights: { technical: 1, composition: 1, motion: 1, human: 1, audio: 1, narrative: 1 },
        preference_boost: 0,
        total: 0.8,
      },
    },
    {
      clip_id: 2,
      segment_id: null,
      best_take_score: 0.5,
      user_state: "auto",
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
      score_breakdown: {
        technical: { score: 0.5, confidence: 1, source: "auto", note: "" },
        composition: { score: 0.5, confidence: 1, source: "auto", note: "" },
        motion: { score: 0.5, confidence: 1, source: "auto", note: "" },
        human: { score: 0.5, confidence: 1, source: "auto", note: "" },
        audio: { score: 0.5, confidence: 1, source: "auto", note: "" },
        narrative: { score: 0.5, confidence: 1, source: "auto", note: "" },
        configured_weights: { technical: 1, composition: 1, motion: 1, human: 1, audio: 1, narrative: 1 },
        preference_boost: 0,
        total: 0.5,
      },
    },
  ],
};

const MEMORY = {
  used_episode_badges: [],
  repeated_signature_uses: 0,
  recent_episode_window: 0,
  routine_visual: false,
  novelty_context: false,
  narrative_adjustment: 0,
  routine_suggestion: null,
};

function storyItem(clipId: number, chapterId: number, position: number): StoryItem {
  return {
    key: `whole:${clipId}`,
    item_kind: "whole",
    clip_id: clipId,
    segment_id: null,
    chapter_id: chapterId,
    file_name: `clip-${clipId}.mov`,
    in_ticks: 0,
    out_ticks: 12_000,
    tb_num: 1,
    tb_den: 1000,
    position,
    long_term_memory: MEMORY,
  };
}

/** 叙事模式的故事板:clip 1 / 2 在第 1 章(beat 可改章),第 2 章空着当改派目标。 */
const narrativeBoard: Storyboard = {
  chapters: [
    { id: 1, title: "出发", start_at: "", end_at: "", clip_count: 2 },
    { id: 2, title: "抵达", start_at: "", end_at: "", clip_count: 0 },
  ],
  items: [storyItem(1, 1, 0), storyItem(2, 1, 1)],
  candidates: [],
  can_undo: false,
  mode: "narrative",
  mode_notice: "",
  narrative: {
    chapters: [1, 2].map((id) => ({
      id,
      kind: "destination",
      title: id === 1 ? "出发" : "抵达",
      order: id - 1,
      promoted: false,
      score: 0,
      rationale: "",
      promotion_reason: "",
      story_slots: [],
      missing_slots: [],
      digital_human_plan: null,
      beats:
        id === 1
          ? [1, 2].map((clipId) => ({
              id: clipId * 10,
              clip_id: clipId,
              segment_id: null,
              role: "beat",
              order: clipId - 1,
              score: 0,
              rationale: "",
              routine_suggestion: null,
              routine_cleared: false,
            }))
          : [],
    })),
  } as unknown as Storyboard["narrative"],
  narration_job_status: null,
  current_template: null,
};

const gap: StoryGap = {
  id: 77,
  chapter_id: 3,
  chapter_title: "第三章",
  beat_id: null,
  slot: "ATMOSPHERE",
  slot_label_zh: "氛围",
  reason: "信息不足，缺一条氛围空镜",
  status: "open",
  latest_request: null,
};

beforeEach(() => {
  __resetClipsFeedForTests();
  __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 1 } });
  apiMocks.getClipsRevision.mockResolvedValue("rev-1");
  apiMocks.listClips.mockResolvedValue([clip(1), clip(2, { generated_source: "minimax" })]);
  apiMocks.listShotStacks.mockResolvedValue([stack]);
  apiMocks.getStoryboard.mockResolvedValue(null);
  apiMocks.listStoryGaps.mockResolvedValue([gap]);
  apiMocks.listClipDimensions.mockResolvedValue([]);
  apiMocks.listAssetSafety.mockResolvedValue([]);
  apiMocks.getCurrentEpisode.mockResolvedValue({ id: 1, title: "EP01" });
});

afterEach(() => {
  cleanup();
  __resetClipsFeedForTests();
  __resetWorkspaceForTests();
  vi.clearAllMocks();
});

async function renderReady(): Promise<void> {
  render(<Inspector />);
  await screen.findByText("评级与收藏");
}

/** fixture:clip 1 在 stack 里、在第 1 章、有三个标签 —— 四段全有。 */
function selectClipInStack(): void {
  apiMocks.getAiDescription.mockResolvedValue({ description: "x", tags: ["机场", "出发", "清晨"], provider: "mock" });
  apiMocks.getStoryboard.mockResolvedValue(narrativeBoard);
  __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 1 } });
}

/** fixture:没 Stack、没标签、没故事板 —— 只剩评级段。 */
function selectLoneClip(): void {
  apiMocks.getAiDescription.mockResolvedValue(null);
  apiMocks.listShotStacks.mockResolvedValue([]);
  apiMocks.getStoryboard.mockResolvedValue(null);
  __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 1 } });
}

function defaultSectionTitles(): string[] {
  return [...document.querySelectorAll(".inspector-default-section .ui-section-header-title")].map((node) => node.textContent ?? "");
}

/**
 * `TechCheckPanel` / `SimilarGroupsPanel` 本体各自内部也有一个同名的 `<span>`
 * 标题(如 `<span>技术检查</span>`)——它们的组件本体不能改一行,所以折叠段的
 * `summary` 与面板内部标题文本必然重名。用 `.closest("summary")` 把落在
 * `<summary>` 里的那一个挑出来,不受面板内部同名文本干扰。
 */
function findSummary(title: string): HTMLElement {
  const matches = screen.getAllByText(new RegExp(`^${title}`));
  const summary = matches.map((el) => el.closest("summary")).find((el): el is HTMLElement => el !== null);
  if (!summary) throw new Error(`未找到折叠段 summary：${title}`);
  return summary;
}

describe("检查器 · 默认层", () => {
  it("有内容时默认层五段顺序固定且永远展开;没有占位句", async () => {
    selectClipInStack();
    render(<Inspector />);
    // R11 术语清扫:「同镜头 Take 切换」→「同一镜头的多条」。
    await screen.findByText("同一镜头的多条");
    // R10 U-11 起多一段「精选段」,排在章节之后、Take 之前。
    await waitFor(() => expect(defaultSectionTitles()).toEqual(["评级与收藏", "标签", "所属章节 / 槽位", "精选段", "同一镜头的多条"]));
    expect(screen.queryByText(/暂无标签/)).toBeNull();
    expect(screen.queryByText(/不属于任何 Take Stack/)).toBeNull();
    expect(document.querySelectorAll(".inspector-default-section details").length).toBe(0);
  });

  it("没标签、没 Take、没故事板的素材:可编辑段常驻(R10 U-12),只少 Take 段;空态给出入口", async () => {
    selectLoneClip();
    await renderReady();
    expect(defaultSectionTitles()).toEqual(["评级与收藏", "标签", "所属章节 / 槽位", "精选段"]);
    expect(screen.queryByText("同一镜头的多条")).toBeNull();
    // R16 P2-10:「添加标签」从禁用占位变成真能用(断言迁移:原来钉 disabled=true)。
    expect(screen.getByRole("button", { name: "添加标签" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "加入当前章节" })).toBeTruthy();
    expect(screen.getByText(/还没有精选段/)).toBeTruthy();
  });

  it("检查器头部:缩略图 + 文件名 + 上一条 / 下一条,在两端各禁一个", async () => {
    apiMocks.listClips.mockResolvedValue([clip(1, { cover_url: "/mock-covers/1.jpg" }), clip(2)]);
    selectLoneClip();
    await renderReady();
    const head = document.querySelector(".inspector-head")!;
    expect(head.querySelector("img")!.getAttribute("src")).toBe("/mock-covers/1.jpg");
    expect(head.textContent).toContain("clip-1.mov");
    expect((screen.getByRole("button", { name: "上一条" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "下一条" }));
    expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 2 });
    await waitFor(() => expect((screen.getByRole("button", { name: "下一条" }) as HTMLButtonElement).disabled).toBe(true));
  });

  it("折叠行:图标 + 段名 + 状态字 + chevron;展开时 chevron 带 is-open", async () => {
    selectLoneClip();
    await renderReady();
    const row = findSummary("技术检查");
    expect(row.querySelectorAll("svg").length).toBeGreaterThanOrEqual(2);
    // svg 的 className 是 SVGAnimatedString,读 attribute 才是字符串。
    expect(row.querySelector(".inspector-chevron")!.getAttribute("class")).not.toContain("is-open");
    fireEvent.click(row);
    await waitFor(() => expect(row.closest("details")!.open).toBe(true));
    expect(row.querySelector(".inspector-chevron")!.getAttribute("class")).toContain("is-open");
  });

  it("「技术检查」与「声音与调色」展开体里没有 TechCheckPanel 自己那行重名小标题(R9 Task 8a)", async () => {
    selectLoneClip();
    await renderReady();
    const row = findSummary("技术检查");
    fireEvent.click(row);
    await waitFor(() => expect(row.closest("details")!.open).toBe(true));
    // 检查器里出现的「技术检查」只有 summary 这一处;面板本体的 <span>技术检查</span> 不再渲染。
    const titles = screen.getAllByText(/^技术检查$/).filter((el) => el.closest("summary") === null);
    expect(titles).toHaveLength(0);
    expect(document.querySelector(".inspector-tech-check > span")).toBeNull();
  });

  it("Take 条是缩略图卡,当前项 selected,带 Take n 与日期", async () => {
    apiMocks.listClips.mockResolvedValue([
      clip(1, { cover_url: "/mock-covers/1.jpg", captured_at: "2026-08-12T01:00:00Z" }),
      clip(2, { generated_source: "minimax", cover_url: "/mock-covers/2.jpg" }),
    ]);
    selectClipInStack();
    render(<Inspector />);
    const strip = await screen.findByRole("group", { name: /^同一镜头 · / });
    expect(strip.querySelectorAll("img").length).toBe(2);
    const current = strip.querySelector(".ui-card--selected")!;
    expect(current.textContent).toContain("第 1 条");
    expect(current.textContent).toContain("08-12");
    expect(current.textContent).toContain("clip-1.mov");
  });

  it("评级按钮带快捷键 Kbd,五星是图标按钮", async () => {
    selectLoneClip();
    await renderReady();
    expect(screen.getByRole("button", { name: "收藏" }).querySelector("kbd")!.textContent).toBe("F");
    expect(screen.getByRole("button", { name: "拒绝" }).querySelector("kbd")!.textContent).toBe("X");
    expect(screen.getByRole("button", { name: "清除" }).querySelector("kbd")!.textContent).toBe("0");
    const stars = screen.getAllByRole("button", { name: /^评 \d 星$/ });
    expect(stars.length).toBe(5);
    expect(stars.every((star) => star.querySelector("svg[data-icon='star']") !== null)).toBe(true);
    fireEvent.click(stars[2]!);
    await waitFor(() => expect(apiMocks.rateClip).toHaveBeenCalledWith(1, "star", 3));
  });

  it("所属章节 / 槽位是两个带标签的下拉:改章调 move_beat,改槽位调 setStoryOrder", async () => {
    selectClipInStack();
    await renderReady();
    const chapterSelect = (await screen.findByRole("combobox", { name: "改写所属章节" })) as HTMLSelectElement;
    expect(screen.getByText("章节")).toBeTruthy();
    expect(screen.getByText("槽位")).toBeTruthy();
    fireEvent.change(chapterSelect, { target: { value: "2" } });
    await waitFor(() =>
      expect(apiMocks.applyNarrativeOp).toHaveBeenCalledWith({ op: "move_beat", beat_id: 10, to_chapter_id: 2, to_order: 0 }),
    );
    const slotSelect = screen.getByRole("combobox", { name: "改写槽位" }) as HTMLSelectElement;
    expect([...slotSelect.options].map((option) => option.textContent)).toEqual(["槽位 01", "槽位 02"]);
    fireEvent.change(slotSelect, { target: { value: "whole:2" } });
    await waitFor(() => expect(apiMocks.setStoryOrder).toHaveBeenCalledTimes(1));
    expect((apiMocks.setStoryOrder.mock.lastCall![0] as { clip_id: number }[]).map((ref) => ref.clip_id)).toEqual([2, 1]);
  });

  it("折叠层用原生 details/summary,summary 文本即段名,默认全收起", async () => {
    await renderReady();
    for (const { title } of INSPECTOR_SECTIONS) {
      const summary = findSummary(title);
      expect(summary.closest("details")!.open).toBe(false);
    }
  });

  it("summary 常驻在树里,不需展开", async () => {
    await renderReady();
    expect(findSummary("相似镜头")).toBeTruthy();
    expect(findSummary("技术检查")).toBeTruthy();
  });

  it("每段标题右侧有状态字", () => {
    const ctx: InspectorStatusContext = {
      techCheckIssues: 0,
      aiDescribed: false,
      audioTrackCount: 0,
      similarGroupCount: 0,
      dimensionCount: 0,
    };
    expect(sectionStatusText("techcheck", { ...ctx, techCheckIssues: 2 })).toBe("2 项提示");
    expect(sectionStatusText("ai", { ...ctx, aiDescribed: false })).toBe("未生成");
    expect(sectionStatusText("similar", { ...ctx, similarGroupCount: 0 })).toBe("无");
  });

  it("音轨/相似组计数为 null(面板尚未上报)时状态字是中性的「加载中」,不是假阴性的「未探测」/「无」", () => {
    const ctx: InspectorStatusContext = {
      techCheckIssues: 0,
      aiDescribed: false,
      audioTrackCount: null,
      similarGroupCount: null,
      dimensionCount: 0,
    };
    expect(sectionStatusText("audio", ctx)).toBe("加载中");
    expect(sectionStatusText("similar", ctx)).toBe("加载中");
    expect(sectionStatusText("audio", { ...ctx, audioTrackCount: 2 })).toBe("2 条音轨");
    expect(sectionStatusText("similar", { ...ctx, similarGroupCount: 0 })).toBe("无");
  });

  it("面板上报真实计数前折叠段显示「加载中」,上报后才显示「n 条音轨」/「无」(回归:曾经硬编码 0 造成假阴性)", async () => {
    let resolveTracks: (value: ClipAudioTrack[]) => void = () => undefined;
    apiMocks.listAudioTracks.mockReturnValue(
      new Promise<ClipAudioTrack[]>((resolve) => {
        resolveTracks = resolve;
      }),
    );
    let resolveGroups: (value: SimilarGroup[]) => void = () => undefined;
    apiMocks.listSimilarGroups.mockReturnValue(
      new Promise<SimilarGroup[]>((resolve) => {
        resolveGroups = resolve;
      }),
    );

    await renderReady();
    expect(findSummary("声音与调色").textContent).toContain("加载中");
    expect(findSummary("相似镜头").textContent).toContain("加载中");

    resolveTracks([
      { clip_id: 1, stream_index: 0, channels: 2, channel_layout: "stereo", sample_rate: 48000, role_guess: "onboard_mic" },
      { clip_id: 1, stream_index: 1, channels: 1, channel_layout: null, sample_rate: 48000, role_guess: "wireless_mic" },
    ]);
    await waitFor(() => expect(findSummary("声音与调色").textContent).toContain("2 条音轨"));

    resolveGroups([]);
    await waitFor(() => expect(findSummary("相似镜头").textContent).toContain("无"));
  });

  // R16 P2-10(断言迁移):标签卡改从 `list_tags` 取(AI + 用户),「添加标签」真能用——
  // 原断言钉的是 disabled + tooltip「暂不支持手动标签」,现在钉「可用、点了出输入框」。
  it("「标签」段(有标签时)列出 list_tags 的标签,「添加标签」可用并打开输入框", async () => {
    apiMocks.listTags.mockResolvedValue([
      { id: 1, label: "机场", source: "ai_l3", deletable: false },
      { id: 2, label: "出发", source: "ai_l3", deletable: false },
    ]);
    selectClipInStack();
    render(<Inspector />);
    await screen.findByText("标签");
    // 「AI 描述」折叠段里也列同一批标签(常驻在树里),只看标签卡这一份。
    await waitFor(() => expect(document.querySelector(".inspector-tag-list")!.textContent).toContain("机场"));
    const addButton = screen.getByRole("button", { name: "添加标签" }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(false);
    fireEvent.click(addButton);
    expect(screen.getByRole("textbox", { name: "新标签" })).toBeTruthy();
  });

  it("开合状态逐段记忆并写 ui.inspector.sections_open", async () => {
    await renderReady();
    fireEvent.click(findSummary("相似镜头"));
    await waitFor(() => expect(getWorkspaceSnapshot().inspectorSections).toEqual(["similar"]));
  });

  it("重新挂载后按记忆恢复展开态", async () => {
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 1 }, inspectorSections: ["techcheck"] });
    await renderReady();
    expect(findSummary("技术检查").closest("details")!.open).toBe(true);
  });

  it("Take 列表里生成片排在后面并带徽章", async () => {
    await renderReady();
    const items = screen.getAllByRole("button", { name: /clip-\d\.mov/ });
    expect(items[0]!.textContent).toContain("clip-1.mov");
    expect(items[1]!.textContent).toContain("clip-2.mov");
    expect(items[1]!.textContent).toContain("AI 生成");
    expect(items[0]!.textContent).not.toContain("AI 生成");
  });

  it("主屏不出现英文 kicker", async () => {
    await renderReady();
    expect(screen.queryByText("INSPECTOR")).toBeNull();
    expect(screen.queryByText("SELECTED / 当前素材")).toBeNull();
  });
});

describe("检查器 · 空槽位分支", () => {
  it("选中空槽位时默认层换成缺口三件套,折叠层全部隐藏", async () => {
    dispatchWorkspace({ type: "select-slot", chapterId: 3, slot: "ATMOSPHERE" });
    render(<Inspector />);
    expect(await screen.findByText(/缺口原因/)).toBeTruthy();
    expect(screen.getByText("目标槽位：氛围")).toBeTruthy();
    expect(screen.getByRole("button", { name: "生成候选" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "忽略此缺口" })).toBeTruthy();
    expect(screen.queryByText(/^技术检查/)).toBeNull();
    expect(screen.queryByText(/^相似镜头/)).toBeNull();
  });

  it("「忽略此缺口」调 dismissStoryGap 并让该槽位从镜头带消失", async () => {
    dispatchWorkspace({ type: "select-slot", chapterId: 3, slot: "ATMOSPHERE" });
    render(<Inspector />);
    const button = await screen.findByRole("button", { name: "忽略此缺口" });
    fireEvent.click(button);
    await waitFor(() => expect(apiMocks.dismissStoryGap).toHaveBeenCalledWith(77));
  });

  it("空选中时显示中性引导,不是空白栏", () => {
    __resetWorkspaceForTests({ selection: null });
    render(<Inspector />);
    expect(screen.getByText(/从左侧媒体池选一条素材/)).toBeTruthy();
  });

  it("从槽位切回素材后折叠段记忆仍在", async () => {
    __resetWorkspaceForTests({
      selection: { kind: "slot", chapterId: 3, slot: "ATMOSPHERE" },
      inspectorSections: ["techcheck"],
    });
    const { rerender } = render(<Inspector />);
    await screen.findByText(/缺口原因/);
    dispatchWorkspace({ type: "select-clip", clipId: 1 });
    rerender(<Inspector />);
    await waitFor(() => expect(findSummary("技术检查").closest("details")!.open).toBe(true));
  });
});
