// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R10 U-03:模板套用 0 镜时不说「已生成」;套用前把候选池规则说出来;有 beats 时把顺序
 * 回写 story_order(镜头带画的是 story_order,不回写就永远 0 镜)。
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
  listStoryTemplates: vi.fn(),
  setStoryOrder: vi.fn().mockResolvedValue(undefined),
  getLlmStatus: vi.fn(),
  enqueueNarrateEpisode: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...apiMocks,
}));

import type { ClipListItem, Storyboard } from "../api";
import { BandAccessory, TEMPLATE_EMPTY_NOTICE } from "./BandAccessory";
import { __resetClipsFeedForTests } from "./useClipsFeed";
import { __resetWorkspaceForTests, dispatchWorkspace, getWorkspaceSnapshot } from "./WorkspaceStore";

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
    duration_ticks: 4_000,
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
  } as ClipListItem;
}

function board(overrides: Partial<Storyboard> = {}): Storyboard {
  return {
    chapters: [{ id: 1, title: "出发", start_at: "", end_at: "", clip_count: 0 }],
    items: [],
    candidates: [],
    can_undo: false,
    mode: "template",
    mode_notice: "",
    narrative: null,
    narration_job_status: null,
    current_template: null,
    ...overrides,
  };
}

const beatsBoard: Storyboard = board({
  narrative: {
    episode: { id: 1, title: "EP01", theme: "", created_at: "", template: "diary" },
    chapters: [
      {
        id: 1,
        kind: "regular",
        title: "旅行日记·第 1 段",
        order: 0,
        promoted: false,
        score: 1,
        rationale: "",
        promotion_reason: "",
        story_slots: [],
        missing_slots: [],
        digital_human_plan: null,
        beats: [
          { id: 1, clip_id: 7, segment_id: null, role: "beat", order: 1, score: 1, rationale: "", routine_suggestion: null, routine_cleared: false },
          { id: 2, clip_id: 8, segment_id: 3, role: "beat", order: 0, score: 1, rationale: "", routine_suggestion: null, routine_cleared: false },
        ],
      },
    ],
    destination_cards: [],
    boundary_signals: [],
    job_status: null,
    dh_guard: { historical_appearances: [], current_estimated_duration_s: 0, duration_warning_threshold_s: 90, warnings: [] },
  } as unknown as Storyboard["narrative"],
});

beforeEach(() => {
  __resetClipsFeedForTests();
  __resetWorkspaceForTests();
  for (const mock of Object.values(apiMocks)) mock.mockClear();
  apiMocks.getClipsRevision.mockResolvedValue("rev-1");
  apiMocks.listClips.mockResolvedValue([]);
  apiMocks.listShotStacks.mockResolvedValue([]);
  apiMocks.getStoryboard.mockResolvedValue(board());
  apiMocks.listStoryGaps.mockResolvedValue([]);
  apiMocks.listClipDimensions.mockResolvedValue([]);
  apiMocks.listAssetSafety.mockResolvedValue([]);
  apiMocks.getCurrentEpisode.mockResolvedValue({ id: 1, title: "EP01" });
  apiMocks.listStoryTemplates.mockResolvedValue([{ id: "diary", name_zh: "旅行日记", blurb_zh: "一条素材一个 Beat" }]);
  apiMocks.getLlmStatus.mockResolvedValue({ enabled: false, provider: "none", budget_exhausted: false, remaining_calls: 0 });
  apiMocks.enqueueNarrateEpisode.mockResolvedValue({ kind: "revision", id: 9 });
  apiMocks.setStoryOrder.mockResolvedValue(undefined);
  dispatchWorkspace({ type: "set-band-mode", mode: "template" });
});
afterEach(cleanup);

async function pickDiary(): Promise<void> {
  render(<BandAccessory />);
  const card = await screen.findByRole("button", { name: /旅行日记/ });
  await act(async () => {
    fireEvent.click(card);
  });
}

describe("U-03:模板套用", () => {
  it("池子空着时套用前就说「没有素材满足『收藏或 ≥3 星』」并给「去媒体池」", async () => {
    render(<BandAccessory />);
    await screen.findByRole("button", { name: /旅行日记/ });
    const pool = document.querySelector(".band-template-pool")!;
    expect(pool.textContent).toContain(TEMPLATE_EMPTY_NOTICE);
    fireEvent.click(screen.getByRole("button", { name: "去媒体池" }));
    expect(getWorkspaceSnapshot().focusedPane).toBe("pool");
  });

  it("池子有素材时说明「模板会编排 n 条素材」", async () => {
    apiMocks.listClips.mockResolvedValue([clip(1, { binary_rating: 1 }), clip(2, { star_rating: 4 }), clip(3, { star_rating: 1 })]);
    render(<BandAccessory />);
    await screen.findByRole("button", { name: /旅行日记/ });
    await waitFor(() => expect(document.querySelector(".band-template-pool")!.textContent).toContain("模板会编排 2 条素材"));
  });

  it("结果 0 镜(没有 beats)时不说「已生成」,说 0 镜的原因并给「去媒体池」", async () => {
    await pickDiary();
    await waitFor(() => expect(apiMocks.enqueueNarrateEpisode).toHaveBeenCalled());
    const notice = await screen.findByText((_, node) => node?.classList.contains("band-accessory-notice") === true && (node.textContent ?? "").includes(TEMPLATE_EMPTY_NOTICE));
    expect(notice.textContent).not.toContain("已按模板生成");
    expect(apiMocks.setStoryOrder).not.toHaveBeenCalled();
  });

  it("后端因空池报错(「没有已收藏或已选片段」)时换成同一句解释", async () => {
    apiMocks.enqueueNarrateEpisode.mockRejectedValue(new Error("故事板没有已收藏或已选片段，无法编排 Episode"));
    await pickDiary();
    await screen.findByText((_, node) => node?.classList.contains("band-accessory-notice") === true && (node.textContent ?? "").includes(TEMPLATE_EMPTY_NOTICE));
    expect(screen.queryByText(/未创建叙事编排任务/)).toBeNull();
  });

  it("有 beats 时把模板顺序回写 story_order(按章 order、beat order),提示说出镜数", async () => {
    apiMocks.getStoryboard.mockResolvedValue(beatsBoard);
    apiMocks.listClips.mockResolvedValue([clip(7), clip(8, { kind: "photo" })]);
    await pickDiary();
    await waitFor(() =>
      expect(apiMocks.setStoryOrder).toHaveBeenCalledWith([
        { item_kind: "whole", clip_id: 7, segment_id: null },
      ]),
    );
    expect(await screen.findByText(/已按模板生成 1 镜/)).toBeTruthy();
  });

  it("story_order 已经与 beats 一致时不再写一次", async () => {
    apiMocks.listClips.mockResolvedValue([clip(7), clip(8)]);
    apiMocks.getStoryboard.mockResolvedValue({
      ...beatsBoard,
      items: [
        { key: "segment:3", item_kind: "segment", clip_id: 8, segment_id: 3, chapter_id: 1, file_name: "8.MP4", in_ticks: 0, out_ticks: 1, tb_num: 1, tb_den: 1000, position: 0, long_term_memory: {} },
        { key: "whole:7", item_kind: "whole", clip_id: 7, segment_id: null, chapter_id: 1, file_name: "7.MP4", in_ticks: 0, out_ticks: 1, tb_num: 1, tb_den: 1000, position: 1, long_term_memory: {} },
      ] as unknown as Storyboard["items"],
    });
    await pickDiary();
    expect(await screen.findByText(/已按模板生成 2 镜/)).toBeTruthy();
    expect(apiMocks.setStoryOrder).not.toHaveBeenCalled();
  });
});
