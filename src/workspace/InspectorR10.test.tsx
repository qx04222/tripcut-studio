// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R10 车道 D 的检查器回归:U-11(精选段区:列表 / 复播 / 删除;自动收藏写在提示里)、
 * U-18(「加入当前章节」不靠拖拽)、U-27(「加载中」8 秒落终态;面板换素材重报计数)、
 * U-28(LUT 下拉有「添加 LUT…」)。
 */

const apiMocks = vi.hoisted(() => ({
  getClipsRevision: vi.fn(),
  listClips: vi.fn(),
  listShotStacks: vi.fn(),
  getStoryboard: vi.fn(),
  listStoryGaps: vi.fn(),
  listClipDimensions: vi.fn(),
  listAssetSafety: vi.fn(),
  getCurrentEpisode: vi.fn(),
  setSetting: vi.fn().mockResolvedValue(undefined),
  listAudioTracks: vi.fn(),
  probeAudioTracks: vi.fn().mockResolvedValue([]),
  listDisplayLuts: vi.fn().mockResolvedValue(["/luts/teal.cube"]),
  setDisplayLut: vi.fn().mockResolvedValue(undefined),
  clearDisplayLut: vi.fn().mockResolvedValue(undefined),
  setPlaybackTrack: vi.fn().mockResolvedValue(undefined),
  setTranscribeTrack: vi.fn().mockResolvedValue(undefined),
  listSimilarGroups: vi.fn(),
  setSimilarPrimary: vi.fn().mockResolvedValue(undefined),
  rateClip: vi.fn().mockResolvedValue({}),
  clearClipRating: vi.fn().mockResolvedValue(undefined),
  getAiDescription: vi.fn().mockResolvedValue(null),
  // R18 AI-A1:检查器的「AI 描述」段现在还会取一句本地描述(不联网、不花预算)。
  getClipBrief: vi.fn().mockResolvedValue(null),
  describeClipWithAi: vi.fn().mockResolvedValue(null),
  setClipTimeStage: vi.fn().mockResolvedValue(undefined),
  getSettings: vi.fn().mockResolvedValue({}),
  getLlmStatus: vi.fn().mockResolvedValue({ enabled: false, provider: "none", budget_exhausted: false, remaining_calls: 0, providers: [] }),
  dismissStoryGap: vi.fn().mockResolvedValue(undefined),
  applyNarrativeOp: vi.fn().mockResolvedValue(null),
  setStoryOrder: vi.fn().mockResolvedValue(undefined),
  undoStoryChange: vi.fn().mockResolvedValue(undefined),
  listSelectSegments: vi.fn(),
  deleteSelectSegment: vi.fn().mockResolvedValue(undefined),
  playerStatus: vi.fn().mockResolvedValue({ phase: "ready", clip_id: 1 }),
  playerCommand: vi.fn().mockResolvedValue(undefined),
  pickLutFile: vi.fn().mockResolvedValue(null),
  importLut: vi.fn().mockResolvedValue([]),
}));
vi.mock("../api", () => apiMocks);

import type { ClipListItem, SelectSegment, Storyboard, StoryItem } from "../api";
import { Inspector, COUNT_TIMED_OUT, SECTION_LOADING_TIMEOUT_MS, sectionStatusText } from "./Inspector";
import { SEGMENT_AUTOFAVORITE_HINT, segmentSecondsLabel } from "./InspectorSegments";
import { ADD_LUT_OPTION } from "../TechCheckPanel";
import { __resetClipsFeedForTests } from "./useClipsFeed";
import { __resetWorkspaceForTests, dispatchWorkspace, getWorkspaceSnapshot } from "./WorkspaceStore";
import { __setShowAllFeaturesForTests } from "./showAllFeatures";

function clip(id: number, overrides: Partial<ClipListItem> = {}): ClipListItem {
  return {
    kind: "video",
    id,
    episode_id: 1,
    folder_label: null,
    cover_url: null,
    path: `/x/clip-${id}.mov`,
    file_name: `clip-${id}.mov`,
    byte_size: 1,
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

const MEMORY = {
  used_episode_badges: [],
  repeated_signature_uses: 0,
  recent_episode_window: 0,
  routine_visual: false,
  novelty_context: false,
  narrative_adjustment: 0,
  routine_suggestion: null,
};

function storyItem(clipId: number, chapterId: number, position: number | null): StoryItem {
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

const legacyBoard: Storyboard = {
  chapters: [{ id: 1, title: "出发", start_at: "", end_at: "", clip_count: 1 }],
  items: [storyItem(2, 1, 0)],
  candidates: [],
  can_undo: false,
  mode: "legacy",
  mode_notice: "",
  narrative: null,
  narration_job_status: null,
  current_template: null,
};

function segment(id: number, inSeconds: number, outSeconds: number): SelectSegment {
  return { id, clip_id: 1, in_ticks: inSeconds * 1000, out_ticks: outSeconds * 1000, tb_num: 1, tb_den: 1000 };
}

beforeEach(() => {
  // R19 P-05:这份文件描述的是「显示全部功能」打开后的形态(旅程 / 地点卡 / 模板 / 技术检查 / 快捷键 / 性能 / 云端补镜都在);默认态在 showAllFeaturesR19.test。
  __setShowAllFeaturesForTests(true);
  __resetClipsFeedForTests();
  __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 1 } });
  apiMocks.getClipsRevision.mockResolvedValue("rev-1");
  apiMocks.listClips.mockResolvedValue([clip(1), clip(2, { binary_rating: 1 })]);
  apiMocks.listShotStacks.mockResolvedValue([]);
  apiMocks.getStoryboard.mockResolvedValue(legacyBoard);
  apiMocks.listStoryGaps.mockResolvedValue([]);
  apiMocks.listClipDimensions.mockResolvedValue([]);
  apiMocks.listAssetSafety.mockResolvedValue([]);
  apiMocks.getCurrentEpisode.mockResolvedValue({ id: 1, title: "EP01" });
  apiMocks.listAudioTracks.mockResolvedValue([]);
  apiMocks.listSimilarGroups.mockResolvedValue([]);
  apiMocks.listSelectSegments.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  __resetClipsFeedForTests();
  __resetWorkspaceForTests();
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function renderReady(): Promise<void> {
  render(<Inspector />);
  await screen.findByText("评级与收藏");
}

function sectionCard(title: string): HTMLElement {
  const card = Array.from(document.querySelectorAll<HTMLElement>(".inspector-default-section")).find((node) =>
    node.querySelector(".ui-section-header-title")?.textContent?.includes(title),
  );
  if (!card) throw new Error(`未找到默认层卡：${title}`);
  return card;
}

describe("U-11:检查器「精选段」区", () => {
  it("列出每段的入出点与时长;提示写明「保存片段」会自动收藏整条", async () => {
    apiMocks.listSelectSegments.mockResolvedValue([segment(5, 1.5, 4), segment(6, 70, 75.25)]);
    apiMocks.listClips.mockResolvedValue([clip(1, { select_count: 2 })]);
    await renderReady();
    const card = sectionCard("精选段");
    const list = await within(card).findByRole("list", { name: "精选段列表" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("1.5s → 4.0s");
    expect(rows[0]!.textContent).toContain("2.5s");
    expect(rows[1]!.textContent).toContain("1:10.0 → 1:15.3");
    expect(card.textContent).toContain(SEGMENT_AUTOFAVORITE_HINT);
    expect(card.querySelector(".ui-section-header-meta, .ui-section-header")?.textContent).toContain("2 段");
  });

  it("复播 = seek 到入点再播;删除走 delete_select_segment 并重取", async () => {
    apiMocks.listSelectSegments.mockResolvedValue([segment(5, 1.5, 4)]);
    await renderReady();
    const card = sectionCard("精选段");
    await within(card).findByRole("list", { name: "精选段列表" });
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "复播精选段 1" }));
    });
    await waitFor(() => expect(apiMocks.playerCommand).toHaveBeenCalledWith({ type: "seek_abs", seconds: 1.5 }, expect.anything()));
    expect(apiMocks.playerCommand).toHaveBeenLastCalledWith({ type: "play" }, expect.anything());

    apiMocks.listSelectSegments.mockResolvedValue([]);
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "删除精选段 1" }));
    });
    await waitFor(() => expect(apiMocks.deleteSelectSegment).toHaveBeenCalledWith(5));
    expect(await within(card).findByText(/还没有精选段/)).toBeTruthy();
  });

  it("segmentSecondsLabel:分以下用 s,分以上 m:ss.s", () => {
    expect(segmentSecondsLabel(2500, 1, 1000)).toBe("2.5s");
    expect(segmentSecondsLabel(75_250, 1, 1000)).toBe("1:15.3");
    expect(segmentSecondsLabel(0, 0, 0)).toBe("0.0s");
  });
});

describe("U-18:检查器「加入当前章节」", () => {
  it("未收藏的素材:先收藏整条,再重取故事板、把它追加到所属章末写 set_story_order;提示说明", async () => {
    apiMocks.getStoryboard.mockResolvedValueOnce(legacyBoard).mockResolvedValue({
      ...legacyBoard,
      candidates: [storyItem(1, 1, null)],
    });
    await renderReady();
    const card = sectionCard("所属章节 / 槽位");
    expect(within(card).getByText("还没有编入镜头带")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "加入当前章节" }));
    });
    await waitFor(() => expect(apiMocks.rateClip).toHaveBeenCalledWith(1, "binary", 1));
    await waitFor(() =>
      expect(apiMocks.setStoryOrder).toHaveBeenCalledWith([
        { item_kind: "whole", clip_id: 2, segment_id: null },
        { item_kind: "whole", clip_id: 1, segment_id: null },
      ]),
    );
    expect(await screen.findByText("已加入第 1 章「出发」，并已自动收藏整条")).toBeTruthy();
  });

  it("已在带上的素材不再显示「加入当前章节」", async () => {
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 2 } });
    await renderReady();
    const card = sectionCard("所属章节 / 槽位");
    expect(within(card).queryByRole("button", { name: "加入当前章节" })).toBeNull();
    expect((within(card).getByRole("combobox", { name: "改写所属章节" }) as HTMLSelectElement).value).toBe("1");
  });
});

describe("U-27:「加载中」要有终态", () => {
  it("sectionStatusText:超时哨兵值给「未探测」/「暂无数据」,与 0 的「无」分开", () => {
    const base = { techCheckIssues: 0, aiDescribed: false, dimensionCount: 0 };
    expect(sectionStatusText("audio", { ...base, audioTrackCount: COUNT_TIMED_OUT, similarGroupCount: null })).toBe("未探测");
    expect(sectionStatusText("similar", { ...base, audioTrackCount: null, similarGroupCount: COUNT_TIMED_OUT })).toBe("暂无数据");
    expect(sectionStatusText("similar", { ...base, audioTrackCount: null, similarGroupCount: 0 })).toBe("无");
  });

  it("面板 8 秒没上报计数,折叠行从「加载中」落到终态", async () => {
    // 让两条读永远不回来:这就是走查里「一直加载中」的现场。
    apiMocks.listAudioTracks.mockReturnValue(new Promise(() => undefined));
    apiMocks.listSimilarGroups.mockReturnValue(new Promise(() => undefined));
    await renderReady();
    const summaryOf = (title: string) =>
      Array.from(document.querySelectorAll("summary")).find((node) => node.textContent?.includes(title))!;
    expect(summaryOf("声音与调色").textContent).toContain("加载中");
    expect(summaryOf("相似镜头").textContent).toContain("加载中");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SECTION_LOADING_TIMEOUT_MS + 50));
    });
    expect(summaryOf("声音与调色").textContent).toContain("未探测");
    expect(summaryOf("相似镜头").textContent).toContain("暂无数据");
  }, 12_000);

  it("换到另一条素材时面板重报计数(回归:同样的 0 → 0 不重报,状态字停在「加载中」)", async () => {
    await renderReady();
    const summaryOf = (title: string) =>
      Array.from(document.querySelectorAll("summary")).find((node) => node.textContent?.includes(title))!;
    await waitFor(() => expect(summaryOf("相似镜头").textContent).toContain("无"));
    await act(async () => {
      dispatchWorkspace({ type: "select-clip", clipId: 2 });
    });
    await waitFor(() => expect(summaryOf("相似镜头").textContent).toContain("无"));
    await waitFor(() => expect(summaryOf("声音与调色").textContent).toContain("未探测"));
  });

  it("读音轨失败也是终态:上报 0 → 「未探测」", async () => {
    apiMocks.listAudioTracks.mockRejectedValue(new Error("ffprobe 不在"));
    await renderReady();
    const summary = () => Array.from(document.querySelectorAll("summary")).find((node) => node.textContent?.includes("声音与调色"))!;
    await waitFor(() => expect(summary().textContent).toContain("未探测"));
  });
});

/** R11 简化专项 #4:音轨段在这些用例里是「未探测」,默认收在「更多信息」里 —— 先点开再操作它的 LUT 下拉。 */
async function revealQuietSections(): Promise<void> {
  const toggle = await screen.findByRole("button", { name: /更多信息/ });
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
}

describe("U-28:LUT 下拉有「添加 LUT…」", () => {
  it("选文件 → importLut → 列表按返回值刷新(不写 clip 的 LUT)", async () => {
    apiMocks.pickLutFile.mockResolvedValue("/Users/x/Downloads/Teal-Orange.cube");
    apiMocks.importLut.mockResolvedValue(["/luts/teal.cube", "/luts/Teal-Orange.cube"]);
    await renderReady();
    await revealQuietSections();
    const selects = await screen.findAllByRole("combobox", { name: "选择预览调色" });
    const select = selects[selects.length - 1] as HTMLSelectElement;
    fireEvent.change(select, { target: { value: ADD_LUT_OPTION } });
    await waitFor(() => expect(apiMocks.importLut).toHaveBeenCalledWith("/Users/x/Downloads/Teal-Orange.cube"));
    await waitFor(() =>
      expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["无", "teal.cube", "Teal-Orange.cube", "添加调色文件…"]),
    );
    expect(apiMocks.setDisplayLut).not.toHaveBeenCalled();
    expect(screen.queryByText(/luts\//)).toBeNull();
  });

  it("importLut 拒绝(同名不同内容等):错误原文可见,并给放置目录说明兜底", async () => {
    apiMocks.pickLutFile.mockResolvedValue("/Users/x/Downloads/teal.cube");
    apiMocks.importLut.mockRejectedValue(new Error("luts/ 里已有同名但内容不同的 teal.cube"));
    await renderReady();
    await revealQuietSections();
    const selects = await screen.findAllByRole("combobox", { name: "选择预览调色" });
    const select = selects[selects.length - 1] as HTMLSelectElement;
    fireEvent.change(select, { target: { value: ADD_LUT_OPTION } });
    expect((await screen.findByText(/同名但内容不同/)).textContent).toContain("添加调色文件没成功");
    expect(screen.getByRole("button", { name: "已放好，刷新列表" })).toBeTruthy();
  });

  it("取消文件选择:不导入,给放置目录说明与「刷新列表」(重新 list_display_luts)", async () => {
    apiMocks.pickLutFile.mockResolvedValue(null);
    await renderReady();
    await revealQuietSections();
    const selects = await screen.findAllByRole("combobox", { name: "选择预览调色" });
    const select = selects[selects.length - 1] as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["无", "teal.cube", "添加调色文件…"]);
    const callsBefore = apiMocks.listDisplayLuts.mock.calls.length;
    fireEvent.change(select, { target: { value: ADD_LUT_OPTION } });
    expect(apiMocks.setDisplayLut).not.toHaveBeenCalled();
    expect(apiMocks.importLut).not.toHaveBeenCalled();
    expect(await screen.findByText(/luts\//)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "已放好，刷新列表" }));
    expect(apiMocks.listDisplayLuts.mock.calls.length).toBe(callsBefore + 1);
  });
});

describe("U-14:AI 描述未启用时按钮禁用 + 「去设置」直落「分析与 AI」", () => {
  it("llm 未启用:「生成 AI 描述」disabled,「去设置」打开设置 sheet 且 section=analysis", async () => {
    await renderReady();
    await revealQuietSections();
    const button = await screen.findByRole("button", { name: "生成 AI 描述" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    const goto = screen.getByRole("button", { name: "去设置" });
    fireEvent.click(goto);
    expect(getWorkspaceSnapshot().openDrawer).toBe("settings");
    expect(getWorkspaceSnapshot().settingsSection).toBe("analysis");
  });

  it("llm 已启用:按钮可点,「去设置」不出现", async () => {
    apiMocks.getSettings.mockResolvedValueOnce({ llm_enabled: "true" });
    apiMocks.getLlmStatus.mockResolvedValueOnce({ enabled: true, provider: "claude", budget_exhausted: false, remaining_calls: 5, providers: [] });
    await renderReady();
    await revealQuietSections();
    const button = await screen.findByRole("button", { name: "生成 AI 描述" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("button", { name: "去设置" })).toBeNull();
  });
});

describe("R11 简化专项 #4:没东西可看的折叠段收进「更多信息」", () => {
  const summaryOf = (title: string) =>
    Array.from(document.querySelectorAll("summary")).find((node) => node.textContent?.includes(title))!;
  const slotOf = (title: string) => summaryOf(title).closest<HTMLElement>(".inspector-collapsible-slot")!;

  it("八维待判定、相似镜头无、音轨未探测 → 三段标成安静、默认藏起;技术检查与 AI 描述照常;点「更多信息」展开", async () => {
    apiMocks.listAudioTracks.mockRejectedValue(new Error("ffprobe 不在"));
    await renderReady();
    await waitFor(() => expect(summaryOf("声音与调色").textContent).toContain("未探测"));
    await waitFor(() => expect(summaryOf("相似镜头").textContent).toContain("无"));
    const toggle = screen.getByRole("button", { name: /更多信息/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("3 项暂无内容");
    for (const title of ["画面评分", "声音与调色", "相似镜头"]) {
      expect(slotOf(title).className).toContain("is-quiet");
      expect(slotOf(title).hidden).toBe(true);
    }
    for (const title of ["技术检查", "AI 描述"]) {
      expect(slotOf(title).className).not.toContain("is-quiet");
      expect(slotOf(title).hidden).toBe(false);
    }
    // DOM 顺序不变:五段仍按 技术检查 / 八维 / AI / 音轨 / 相似 排,安静的只是 hidden + order。
    expect(Array.from(document.querySelectorAll(".inspector-collapsible-slot summary")).map((node) => node.textContent?.slice(0, 4))).toEqual([
      "技术检查", "画面评分", "AI 描", "声音与调", "相似镜头",
    ]);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    for (const title of ["画面评分", "声音与调色", "相似镜头"]) expect(slotOf(title).hidden).toBe(false);
  });

  it("有内容的段不算安静:相似镜头有 1 组时照常显示,只有八维与音轨收进去", async () => {
    apiMocks.listSimilarGroups.mockResolvedValue([
      { id: 9, kind: "visual", primary_clip_id: 1, members: [{ clip_id: 1, segment_id: null, is_primary: true }, { clip_id: 2, segment_id: null, is_primary: false }] },
    ]);
    apiMocks.listAudioTracks.mockRejectedValue(new Error("ffprobe 不在"));
    await renderReady();
    await waitFor(() => expect(summaryOf("相似镜头").textContent).toContain("1 组"));
    await waitFor(() => expect(summaryOf("声音与调色").textContent).toContain("未探测"));
    expect(slotOf("相似镜头").hidden).toBe(false);
    expect(slotOf("画面评分").hidden).toBe(true);
    expect(slotOf("声音与调色").hidden).toBe(true);
    expect(screen.getByRole("button", { name: /更多信息/ }).textContent).toContain("2 项暂无内容");
  });
});
