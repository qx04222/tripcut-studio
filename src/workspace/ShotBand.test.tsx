// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * dnd-kit 的指针物理依赖真实矩形,jsdom 里所有 getBoundingClientRect 都是 0 ——
 * 在那上面「模拟拖动」只能测出 dnd-kit 自己的碰撞算法,测不到本仓的落点语义。
 * 所以这里把 DndContext 换成一个只负责把 onDragEnd 递出来的壳:被测的是
 * `planBandReorder` → `setStoryOrder` 这条**我们自己写的**路径,而不是库。
 */
const dnd = vi.hoisted(() => ({
  onDragEnd: null as ((event: unknown) => void) | null,
  onDragStart: null as ((event: unknown) => void) | null,
  onDragOver: null as ((event: unknown) => void) | null,
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragEnd,
    onDragStart,
    onDragOver,
  }: {
    children: React.ReactNode;
    onDragEnd: (event: unknown) => void;
    onDragStart: (event: unknown) => void;
    onDragOver: (event: unknown) => void;
  }) => {
    dnd.onDragEnd = onDragEnd;
    dnd.onDragStart = onDragStart;
    dnd.onDragOver = onDragOver;
    return children;
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => children,
  PointerSensor: function PointerSensor() {},
  useSensor: () => ({}),
  useSensors: () => [],
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => children,
  horizontalListSortingStrategy: undefined,
  verticalListSortingStrategy: undefined,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => undefined,
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

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
  setBandOrder: vi.fn().mockResolvedValue(undefined),
  setStoryOrder: vi.fn().mockResolvedValue(undefined),
  undoStoryChange: vi.fn().mockResolvedValue(undefined),
  setShotStackUserState: vi.fn().mockResolvedValue(undefined),
  rateClips: vi.fn().mockResolvedValue([]),
  rateClip: vi.fn().mockResolvedValue(undefined),
  generationAvailability: vi.fn(),
  previewGeneration: vi.fn(),
  dismissStoryGap: vi.fn().mockResolvedValue(undefined),
  clearClipRating: vi.fn().mockResolvedValue(undefined),
  retryGeneration: vi.fn().mockResolvedValue(undefined),
  cancelGeneration: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...apiMocks,
}));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  ClipListItem,
  GenerationRequestSummary,
  ShotStack,
  Storyboard,
  StoryGap,
  StoryItem,
} from "../api";
import { MediaPool } from "./MediaPool";
import { ShotBand } from "./ShotBand";
import { BAND_TILE_WIDTH } from "./bandTimeline";
import { BAND_TILE_HEIGHT, BAND_VIEWPORT_HEIGHT } from "./shotBandModel";
import { isVideoBandClip, needsFavoriteBeforeInsert } from "./useBandDrag";
// R12 §3:提示改走全局 Toast(壳里挂一次的 ToastHost);单独渲染镜头带时得自己带上宿主。
import { ToastHost } from "./ui/Toast";
import { __resetToastsForTests } from "./ui/toastStore";
import { __resetClipsFeedForTests, getClipsFeedSnapshot } from "./useClipsFeed";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";
import { __setShowAllFeaturesForTests } from "./showAllFeatures";

/** 镜头带 / 检查器的样式在 `workspace/band.css` `workspace/inspector.css`,由 workspace.css `@import` 进来;结构断言两份一起看。 */
const WORKSPACE_CSS = ["src/styles/workspace.css", "src/styles/workspace/band.css", "src/styles/workspace/band-empty.css", "src/styles/workspace/inspector.css"]
  .map((file) => readFileSync(resolve(process.cwd(), file), "utf8"))
  .join("\n");

const MEMORY = {
  used_episode_badges: [],
  repeated_signature_uses: 0,
  recent_episode_window: 0,
  routine_visual: false,
  novelty_context: false,
  narrative_adjustment: 0,
  routine_suggestion: null,
};

function item(clipId: number, chapterId: number, fileName: string, position: number): StoryItem {
  return {
    key: `whole:${clipId}`,
    item_kind: "whole",
    clip_id: clipId,
    segment_id: null,
    chapter_id: chapterId,
    file_name: fileName,
    in_ticks: 0,
    out_ticks: 4_000,
    tb_num: 1,
    tb_den: 1_000,
    position,
    long_term_memory: MEMORY,
  } as StoryItem;
}

function clip(id: number, fileName: string, generated = false): ClipListItem {
  return {
    id,
    episode_id: 1,
    folder_label: null,
    cover_url: null,
    path: `/x/${fileName}`,
    file_name: fileName,
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
    ...(generated ? { generated_source: "minimax" } : {}),
  } as ClipListItem;
}

const board: Storyboard = {
  chapters: [
    { id: 1, title: "出发", start_at: "", end_at: "", clip_count: 5 },
    { id: 2, title: "抵达", start_at: "", end_at: "", clip_count: 1 },
  ],
  items: [
    item(1, 1, "A.MP4", 0),
    item(2, 1, "B.MP4", 1),
    item(3, 1, "C.MP4", 2),
    item(4, 1, "D.MP4", 3),
    item(5, 1, "E.MP4", 4),
    item(6, 2, "F.MP4", 5),
  ],
  candidates: [],
  can_undo: true,
  mode: "narrative",
  mode_notice: "",
  narrative: null,
  narration_job_status: null,
  current_template: null,
};

const stack: ShotStack = {
  id: 77,
  scene_id: 1,
  scene_name: "出发",
  stack_type: "visual",
  subject_label: "",
  function_label: "",
  shot_size_label: "",
  movement_label: "",
  quality_exempt: false,
  members: [
    // 故意把生成片放在第一位:排序规则必须由前端保证,而不是指望后端顺序。
    { clip_id: 9, segment_id: null, best_take_score: 0.9, is_preferred: false, user_state: "auto", long_term_memory: MEMORY },
    { clip_id: 1, segment_id: null, best_take_score: 0.8, is_preferred: true, user_state: "auto", long_term_memory: MEMORY },
    { clip_id: 2, segment_id: null, best_take_score: 0.7, is_preferred: false, user_state: "auto", long_term_memory: MEMORY },
  ],
} as unknown as ShotStack;

beforeEach(() => {
  // R19 P-05:这份文件描述的是「显示全部功能」打开后的形态(旅程 / 地点卡 / 模板 / 技术检查 / 快捷键 / 性能 / 云端补镜都在);默认态在 showAllFeaturesR19.test。
  __setShowAllFeaturesForTests(true);
  __resetToastsForTests();
  __resetClipsFeedForTests();
  __resetWorkspaceForTests();
  dnd.onDragEnd = null;
  for (const mock of Object.values(apiMocks)) mock.mockClear();
  apiMocks.getClipsRevision.mockResolvedValue("rev-1");
  apiMocks.listClips.mockResolvedValue([
    clip(1, "A.MP4"),
    clip(2, "B.MP4"),
    clip(3, "C.MP4"),
    clip(4, "D.MP4"),
    clip(5, "E.MP4"),
    clip(6, "F.MP4"),
    clip(9, "GEN.MP4", true),
  ]);
  apiMocks.getStoryboard.mockResolvedValue(board);
  apiMocks.listShotStacks.mockResolvedValue([stack]);
  apiMocks.listStoryGaps.mockResolvedValue([]);
  apiMocks.listClipDimensions.mockResolvedValue([]);
  apiMocks.listAssetSafety.mockResolvedValue([]);
  apiMocks.rateClips.mockResolvedValue([]);
  apiMocks.getCurrentEpisode.mockResolvedValue({ id: 1, title: "EP01" });
  apiMocks.generationAvailability.mockResolvedValue({
    enabled: true,
    has_key: true,
    budget_remaining_usd: 10,
  });
  apiMocks.previewGeneration.mockResolvedValue({
    mode: "t2v",
    model: "MiniMax-H3-Max",
    resolution: "768P",
    duration_s: 6,
    ratio: "16:9",
    prompt: "山路清晨的建立镜头",
    refs: [],
    estimated_cost_usd: 0.4,
    notes: [],
  });
  apiMocks.setBandOrder.mockResolvedValue(undefined);
  apiMocks.undoStoryChange.mockResolvedValue(undefined);
  apiMocks.setShotStackUserState.mockResolvedValue(undefined);
  apiMocks.retryGeneration.mockResolvedValue({ id: 1, status: "queued", error: null, estimated_cost_usd: 0.4, actual_cost_usd: null, result_clip_id: null });
  apiMocks.cancelGeneration.mockResolvedValue(undefined);
});
afterEach(cleanup);

/** R12 §2:缺口卡只留一个主动作,云端补镜 / 忽略 / 去设置收进「···」(AX「更多」→ menu「缺口更多操作」)。 */
async function openMore(cell: HTMLElement): Promise<HTMLElement> {
  await act(async () => {
    fireEvent.click(within(cell).getByRole("button", { name: "更多" }));
  });
  return screen.getByRole("menu", { name: "缺口更多操作" });
}

async function renderBand(): Promise<void> {
  render(<><ShotBand /><ToastHost /></>);
  await screen.findByRole("gridcell", { name: "镜头 1：A.MP4" });
}

/**
 * 键盘事件一律打在当前焦点元素上,返回值就是「默认行为有没有被拦下」——
 * `dispatchEvent` 在 preventDefault 之后返回 false。Tab 不移动焦点这条只能这么证:
 * fireEvent 本来就不会移动焦点,断言「焦点没动」是永远为真的假绿。
 */
function press(key: string, code = key): boolean {
  const target = document.activeElement ?? document.body;
  return fireEvent.keyDown(target, { key, code });
}

function clickSegment(label: string): void {
  fireEvent.click(screen.getByRole("gridcell", { name: label }));
}

function keyOf(label: string): string {
  return screen.getByRole("gridcell", { name: label }).getAttribute("data-band-key")!;
}

async function dragSegment(fromLabel: string, toLabel: string): Promise<void> {
  const active = { id: keyOf(fromLabel) };
  const over = { id: keyOf(toLabel) };
  await act(async () => {
    dnd.onDragStart?.({ active });
    dnd.onDragEnd?.({ active, over });
  });
}

describe("镜头带", () => {
  it("拖排写入层严格拒绝照片和缺失 kind", () => {
    expect(isVideoBandClip(clip(1, "A.MP4"))).toBe(true);
    expect(isVideoBandClip({ ...clip(2, "photo.jpg"), kind: "photo" })).toBe(false);
    expect(isVideoBandClip({ ...clip(3, "legacy.mov"), kind: undefined })).toBe(false);
    expect(needsFavoriteBeforeInsert({ ...clip(2, "photo.jpg"), kind: "photo" })).toBe(false);
  });

  it("整带是 role=region aria-label=「镜头带」", async () => {
    await renderBand();
    expect(screen.getByRole("region", { name: "镜头带" })).toBeTruthy();
  });

  it("按章节出带头,带序号、标题与缺口数", async () => {
    await renderBand();
    expect(screen.getByRole("rowgroup", { name: "第 1 章 出发" })).toBeTruthy();
    expect(screen.getByRole("rowgroup", { name: "第 2 章 抵达" })).toBeTruthy();
  });

  it("两个空章各占一块:两条带头不重叠,各自一张「本章还没有镜头」占位瓦片(R9 D2)", async () => {
    apiMocks.getStoryboard.mockResolvedValue({
      ...board,
      chapters: [
        { id: 1, title: "出发", start_at: "", end_at: "", clip_count: 0 },
        { id: 2, title: "抵达", start_at: "", end_at: "", clip_count: 0 },
      ],
      items: [],
    });
    render(<><ShotBand /><ToastHost /></>);
    const first = await screen.findByRole("rowgroup", { name: "第 1 章 出发" });
    const second = screen.getByRole("rowgroup", { name: "第 2 章 抵达" });
    // 空章的宽必须是一个瓦片节距,而不是 0 —— 0 宽的两章会叠在同一位置。
    expect(parseInt(first.style.width, 10)).toBeGreaterThanOrEqual(BAND_TILE_WIDTH);
    expect(parseInt(second.style.width, 10)).toBeGreaterThanOrEqual(BAND_TILE_WIDTH);
    for (const section of [first, second]) {
      const placeholder = within(section).getByText("拖段进来或删除");
      expect(placeholder).toBeTruthy();
      // R10 U-17:占位上是可点的入口;R12 §2:一个主动作 + 「这章够了」,云端补镜不在空章上出现。
      // 这份夹具里没有收藏 / 评星的素材 → 主动作是「回到第 2 步挑几条」(有候选时才是「从挑好的片段里选」)。
      expect(within(section).getByRole("button", { name: "回到第 2 步挑几条" })).toBeTruthy();
      expect(within(section).getByRole("button", { name: "这章够了" })).toBeTruthy();
      expect(within(section).queryByRole("button", { name: "生成候选" })).toBeNull();
      expect(within(section).queryByText(/个镜头/)).toBeNull();
    }
    expect(screen.getAllByText("拖段进来或删除")).toHaveLength(2);
    // 占位瓦片有真实尺寸(R19 V-06:140×112,与 BAND_TILE_WIDTH / BAND_TILE_HEIGHT 同源),不是一条竖排文字。
    expect(WORKSPACE_CSS).toMatch(new RegExp(`\\.band-chapter-empty\\s*\\{[^}]*width:\\s*${BAND_TILE_WIDTH}px`));
    expect(WORKSPACE_CSS).toMatch(new RegExp(`\\.band-chapter-empty\\s*\\{[^}]*height:\\s*${BAND_TILE_HEIGHT}px`));
  });

  it("拖排调 setStoryOrder 一次,顺序按 storyOrderRefs 生成", async () => {
    await renderBand();
    await dragSegment("镜头 2：B.MP4", "镜头 4：D.MP4");
    await waitFor(() => expect(apiMocks.setBandOrder).toHaveBeenCalledTimes(1));
    expect(
      (apiMocks.setBandOrder.mock.lastCall![1] as { clip_id: number }[]).map((ref) => ref.clip_id),
    ).toEqual([1, 3, 4, 2, 5, 6]);
  });

  it("松手后 toast「已移动 1 段 · 撤销」,点撤销调 undoStoryChange", async () => {
    await renderBand();
    await dragSegment("镜头 2：B.MP4", "镜头 4：D.MP4");
    expect(await screen.findByText("已移动 1 段")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    await waitFor(() => expect(apiMocks.setBandOrder).toHaveBeenCalledTimes(2));
    expect((apiMocks.setBandOrder.mock.lastCall![1] as { clip_id: number }[]).map(ref => ref.clip_id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("跨章节拖动保存该段的新归属", async () => {
    await renderBand();
    await dragSegment("镜头 2：B.MP4", "镜头 6：F.MP4");
    expect(await screen.findByText("已移动 1 段")).toBeTruthy();
    expect(apiMocks.setBandOrder).toHaveBeenCalledTimes(1);
    expect((apiMocks.setBandOrder.mock.lastCall![1] as { clip_id: number; chapter_id: number }[]).find(ref => ref.clip_id === 2)?.chapter_id).toBe(2);
  });

  it("抓手上的 ←→ 是章内前后移一格,同样只写一次顺序", async () => {
    await renderBand();
    const grip = screen.getByRole("button", { name: "拖动 镜头 1：A.MP4" });
    grip.focus();
    fireEvent.keyDown(grip, { key: "ArrowRight", code: "ArrowRight" });
    await waitFor(() => expect(apiMocks.setBandOrder).toHaveBeenCalledTimes(1));
    expect(
      (apiMocks.setBandOrder.mock.lastCall![1] as { clip_id: number }[]).map((ref) => ref.clip_id),
    ).toEqual([2, 1, 3, 4, 5, 6]);
  });

  it("Tab 展开当前 Stack 的成员条,↑↓ 移动,Enter 提为首选", async () => {
    await renderBand();
    clickSegment("镜头 1：A.MP4");
    press("Tab");
    const group = await screen.findByRole("group", { name: /^同一镜头 · / });
    expect(group).toBeTruthy();
    press("ArrowDown");
    await act(async () => {
      press("Enter");
    });
    await waitFor(() => expect(apiMocks.setShotStackUserState).toHaveBeenCalledTimes(1));
    // 规格 §3.2:Enter = 把当前 Take 提为首选(hero);↓ 之后当前项是第二条(A→B)。
    expect(apiMocks.setShotStackUserState).toHaveBeenCalledWith(77, 2, null, "hero");
  });

  it("Tab 不移动焦点(与现状一致)", async () => {
    await renderBand();
    clickSegment("镜头 1：A.MP4");
    const before = document.activeElement;
    // 返回 false = 处理器调了 preventDefault,浏览器不会把焦点挪到下一个可聚焦元素。
    expect(press("Tab")).toBe(false);
    expect(document.activeElement).toBe(before);
  });

  it("生成片永远排在真实素材之后,并带「AI 生成」徽章(R7 §6 排序不变)", async () => {
    await renderBand();
    clickSegment("镜头 1：A.MP4");
    press("Tab");
    const group = await screen.findByRole("group", { name: /^同一镜头 · / });
    const members = within(group).getAllByRole("button");
    expect(members.at(-1)!.textContent).toContain("AI 生成");
    expect(members.at(-1)!.textContent).toContain("GEN.MP4");
  });

  it("L 键把当前 Take 锁定为首选(与 Enter 的 hero 分开)", async () => {
    await renderBand();
    clickSegment("镜头 1：A.MP4");
    await act(async () => {
      press("l", "KeyL");
    });
    await waitFor(() => expect(apiMocks.setShotStackUserState).toHaveBeenCalledWith(77, 1, null, "locked"));
  });

  it("点分段产生 clip 选择,媒体池对应卡片高亮(跨栏回显)", async () => {
    render(
      <>
        <MediaPool />
        <ShotBand />
        <ToastHost />
      </>,
    );
    await screen.findByRole("gridcell", { name: "镜头 3：C.MP4" });
    clickSegment("镜头 3：C.MP4");
    expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 3 });
    await waitFor(() =>
      expect(document.getElementById("pool-clip-3")?.getAttribute("aria-selected")).toBe("true"),
    );
  });

  it("镜头带有焦点时单键评级走 patchClipInFeed,不等下一轮轮询", async () => {
    await renderBand();
    clickSegment("镜头 1：A.MP4");
    await act(async () => {
      press("f", "KeyF");
    });
    await waitFor(() => expect(apiMocks.rateClips).toHaveBeenCalledWith([{ clip_id: 1, rating_type: "binary", value: 1 }]));
  });
});

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

describe("镜头带空槽位", () => {
  beforeEach(() => {
    apiMocks.listStoryGaps.mockResolvedValue([
      gap(10, 1, "REAL/ESTABLISHING", "建立镜头"),
      gap(11, 1, "MAP", "地图"),
    ]);
  });

  async function renderWithGap(): Promise<HTMLElement> {
    render(<><ShotBand /><ToastHost /></>);
    return screen.findByRole("gridcell", { name: "镜头 6：缺口 建立镜头" });
  }

  it("空槽位是虚线描边 + 槽位中文名 + reason 一行 + 一个主动作;「生成候选」在「···」里", async () => {
    const cell = await renderWithGap();
    expect(cell.className).toContain("slot");
    expect(within(cell).getByText("建立镜头")).toBeTruthy();
    expect(within(cell).getByText(/本章缺一条建立镜头/)).toBeTruthy();
    expect(within(cell).getByRole("button", { name: "回到第 2 步挑几条" })).toBeTruthy();
    expect(within(cell).queryByRole("button", { name: "生成候选" })).toBeNull();
    const menu = await openMore(cell);
    expect(within(menu).getByRole("menuitem", { name: "生成候选" })).toBeTruthy();
  });

  it("「···」→「生成候选」打开 GenerationDialog,参数预填不变", async () => {
    const cell = await renderWithGap();
    const menu = await openMore(cell);
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "生成候选" }));
    });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/生成候选/)).toBeTruthy();
    expect(apiMocks.previewGeneration).toHaveBeenCalledWith(10, {});
  });

  it("白名单外的槽位不产生空槽位卡片", async () => {
    await renderWithGap();
    expect(screen.queryByRole("gridcell", { name: /缺口 地图/ })).toBeNull();
  });

  it("未启用或预算耗尽时「生成候选」禁用并给出中文原因(不是静默无反应)", async () => {
    apiMocks.generationAvailability.mockResolvedValue({
      enabled: false,
      has_key: false,
      budget_remaining_usd: 0,
    });
    const cell = await renderWithGap();
    await waitFor(() => expect(apiMocks.generationAvailability).toHaveBeenCalled());
    const menu = await openMore(cell);
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: "生成候选" })).toHaveProperty("disabled", true));
    expect(within(menu).getByText(/云端补镜未启用/)).toBeTruthy();
  });

  it("预算耗尽时的中文原因指向预算,不是「未启用」", async () => {
    apiMocks.generationAvailability.mockResolvedValue({
      enabled: true,
      has_key: true,
      budget_remaining_usd: 0,
    });
    const cell = await renderWithGap();
    await waitFor(() => expect(apiMocks.generationAvailability).toHaveBeenCalled());
    const menu = await openMore(cell);
    await waitFor(() => expect(within(menu).getByText(/本月生成预算已用尽/)).toBeTruthy());
  });

  it("可用性拉不到时不崩,按「状态未知」禁用", async () => {
    apiMocks.generationAvailability.mockResolvedValue(undefined);
    const cell = await renderWithGap();
    const menu = await openMore(cell);
    await waitFor(() => expect(within(menu).getByText(/云端补镜状态未知/)).toBeTruthy());
    expect(within(menu).getByRole("menuitem", { name: "生成候选" })).toHaveProperty("disabled", true);
  });

  it("选中空槽位时监视器与检查器都进缺口分支(selection.kind === slot)", async () => {
    const cell = await renderWithGap();
    fireEvent.click(cell);
    expect(getWorkspaceSnapshot().selection).toEqual({
      kind: "slot",
      chapterId: 1,
      slot: "REAL/ESTABLISHING",
    });
  });
});

function request(
  status: GenerationRequestSummary["status"],
  error: string | null = null,
): GenerationRequestSummary {
  return { id: 42, status, error, estimated_cost_usd: 0.4, actual_cost_usd: null, result_clip_id: null };
}

/** 只读态:进入「查看历史集」视角。当前集 id 不变,素材仍在带上,写入必须全关。 */
async function viewHistoricalEpisode(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new CustomEvent("tripcut:view-episode", { detail: { id: 1, title: "EP00" } }));
  });
}

describe("镜头带空槽位按请求状态分叉(镜像 R7 StoryGapCard)", () => {
  function withRequest(summary: GenerationRequestSummary | null): void {
    apiMocks.listStoryGaps.mockResolvedValue([
      { ...gap(10, 1, "REAL/ESTABLISHING", "建立镜头"), status: summary ? "requested" : "open", latest_request: summary },
    ]);
  }

  async function renderSlot(): Promise<HTMLElement> {
    render(<><ShotBand /><ToastHost /></>);
    return screen.findByRole("gridcell", { name: "镜头 6：缺口 建立镜头" });
  }

  it("排队中的请求显示「排队中」与「取消」,不再给「生成候选」", async () => {
    withRequest(request("queued"));
    const cell = await renderSlot();
    expect(within(cell).getByText("排队中")).toBeTruthy();
    expect(within(cell).getByRole("button", { name: "取消" })).toBeTruthy();
    expect(within(cell).queryByRole("button", { name: "生成候选" })).toBeNull();
  });

  it("生成中(succeeded)同样只给「取消」,点它调 cancelGeneration", async () => {
    withRequest(request("succeeded"));
    const cell = await renderSlot();
    expect(within(cell).getByText("生成中")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(cell).getByRole("button", { name: "取消" }));
    });
    await waitFor(() => expect(apiMocks.cancelGeneration).toHaveBeenCalledWith(42));
  });

  it("失败的请求给「重新生成」并把错误原文说出来", async () => {
    withRequest(request("failed", "供应商超时"));
    const cell = await renderSlot();
    expect(within(cell).getByText(/失败：供应商超时/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(cell).getByRole("button", { name: "重新生成" }));
    });
    await waitFor(() => expect(apiMocks.retryGeneration).toHaveBeenCalledWith(42));
  });

  it("已入库的请求不再给任何写入按钮", async () => {
    withRequest(request("imported"));
    const cell = await renderSlot();
    expect(within(cell).getByText("已入库")).toBeTruthy();
    // R10 U-30 起缺口说明是一个可展开的 disclosure 按钮,它不是写入按钮,排除后其余必须为空。
    expect(within(cell).queryAllByRole("button").filter((button) => !button.classList.contains("band-slot-reason"))).toEqual([]);
  });

  it("只读历史集:生成/忽略全禁用,并说明「历史集为只读档案」", async () => {
    withRequest(null);
    const cell = await renderSlot();
    await viewHistoricalEpisode();
    // R12:主动作与「···」整个禁用 —— 只读态里既进不了菜单,也就没有生成 / 忽略可点。
    expect(within(cell).getByRole("button", { name: "回到第 2 步挑几条" })).toHaveProperty("disabled", true);
    expect(within(cell).getByRole("button", { name: "更多" })).toHaveProperty("disabled", true);
    expect(within(cell).getByText("历史集为只读档案")).toBeTruthy();
  });

  it("只读历史集:失败请求的「重新生成」也禁用", async () => {
    withRequest(request("failed", "供应商超时"));
    const cell = await renderSlot();
    await viewHistoricalEpisode();
    expect(within(cell).getByRole("button", { name: "重新生成" })).toHaveProperty("disabled", true);
    expect(apiMocks.retryGeneration).not.toHaveBeenCalled();
  });

  it("「···」→「忽略」调 dismissStoryGap", async () => {
    withRequest(null);
    const cell = await renderSlot();
    const menu = await openMore(cell);
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "忽略" }));
    });
    await waitFor(() => expect(apiMocks.dismissStoryGap).toHaveBeenCalledWith(10));
  });
});

describe("镜头带提示与热键边界", () => {
  it("提示 4 秒后自行消失", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderBand();
      await dragSegment("镜头 2：B.MP4", "镜头 4：D.MP4");
      expect(await screen.findByText("已移动 1 段")).toBeTruthy();
      await act(async () => {
        // R12:带「撤销」的提示停 5 秒(GAP_UNDO_MS),不带的 4 秒。
        vi.advanceTimersByTime(5_000);
      });
      await waitFor(() => expect(screen.queryByText("已移动 1 段")).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it("提示上的「关闭提示」也能把它关掉(R12:顶部 Toast,role=status)", async () => {
    await renderBand();
    await dragSegment("镜头 2：B.MP4", "镜头 4：D.MP4");
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("已移动 1 段");
    await act(async () => {
      fireEvent.click(within(toast).getByRole("button", { name: "关闭提示" }));
    });
    expect(screen.queryByText("已移动 1 段")).toBeNull();
  });

  it("落到缺口上追加到其所在章节，不给缺口编造时间", async () => {
    apiMocks.listStoryGaps.mockResolvedValue([gap(10, 1, "REAL/ESTABLISHING", "建立镜头")]);
    render(<><ShotBand /><ToastHost /></>);
    await screen.findByRole("gridcell", { name: "镜头 6：缺口 建立镜头" });
    await dragSegment("镜头 2：B.MP4", "镜头 6：缺口 建立镜头");
    expect(await screen.findByText("已移动 1 段")).toBeTruthy();
    expect(apiMocks.setBandOrder).toHaveBeenCalledTimes(1);
    expect((apiMocks.setBandOrder.mock.lastCall![1] as { clip_id: number; chapter_id: number }[]).find(ref => ref.clip_id === 2)?.chapter_id).toBe(1);
  });

  it("评级先打乐观补丁,不等 rateClip 回来", async () => {
    // rateClip 永不 resolve —— 界面上的新评级只可能来自 patchClipInFeed。
    apiMocks.rateClips.mockReturnValue(new Promise(() => undefined));
    await renderBand();
    clickSegment("镜头 1：A.MP4");
    await act(async () => {
      press("f", "KeyF");
    });
    expect(getClipsFeedSnapshot().clipsById.get(1)?.binary_rating).toBe(1);
  });

  it("焦点在媒体池时,镜头带的单键评级什么都不做", async () => {
    render(
      <>
        <MediaPool />
        <ShotBand />
        <ToastHost />
      </>,
    );
    await screen.findByRole("gridcell", { name: "镜头 1：A.MP4" });
    clickSegment("镜头 1：A.MP4");
    fireEvent.focus(screen.getByRole("grid", { name: "媒体池" }));
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("grid", { name: "镜头序列" }), { key: "f", code: "KeyF" });
    });
    expect(apiMocks.rateClip).not.toHaveBeenCalled();
  });
});

describe("镜头带 R9 视觉(规格 §3.7,基准稿 A)", () => {
  it("带视口高度固定为内容高,不随中栏撑开(瓦片下方不留白)", async () => {
    await renderBand();
    const viewport = document.querySelector<HTMLElement>(".band-viewport")!;
    expect(viewport.style.getPropertyValue("--band-content-height")).toBe(`${BAND_VIEWPORT_HEIGHT}px`);
    expect(WORKSPACE_CSS).toMatch(/\.band-viewport\s*\{[^}]*height:\s*var\(--band-content-height\)/);
    expect(WORKSPACE_CSS).toMatch(/\.band-viewport\s*\{[^}]*overflow-x:\s*scroll/);
    expect(WORKSPACE_CSS).toMatch(/\.band-viewport\s*\{[^}]*scrollbar-gutter:\s*stable/);
  });

  it("章节头是 dense 工具条:序号 Badge、标题、时长、n 镜、缺口 Badge(warn)", async () => {
    apiMocks.listStoryGaps.mockResolvedValue([gap(10, 2, "REAL/ESTABLISHING", "建立镜头")]);
    render(<><ShotBand /><ToastHost /></>);
    await screen.findByRole("gridcell", { name: "镜头 7：缺口 建立镜头" });
    const chapter = screen.getAllByRole("rowgroup")[1]!;
    const head = chapter.querySelector(".band-chapter-head")!;
    expect(head.className).toContain("ui-toolbar");
    expect(head.querySelector(".ui-badge--accent")!.textContent).toBe("02");
    expect(head.querySelector(".ui-badge--warn")!.textContent).toContain("1 处缺口");
    // R10 U-29:镜与缺口分列 —— 1 条素材 + 1 个空槽位是「1 镜 · 1 缺口」,不再把缺口算成镜。
    expect(head.textContent).toContain("1 镜 · 1 缺口");
    expect(head.textContent).not.toContain("2 镜");
    // 第 1 章没有缺口:不渲染缺口 Badge(空段隐藏)。
    expect(screen.getAllByRole("rowgroup")[0]!.querySelector(".ui-badge--warn")).toBeNull();
  });

  it("瓦片是 Card interactive;拖柄是 grip 图标且 AX 名不变;左下槽位序号按章重置", async () => {
    await renderBand();
    const cells = screen.getAllByRole("gridcell");
    expect(cells[0]!.className).toContain("ui-card--interactive");
    expect(screen.getAllByRole("button", { name: /^拖动 镜头/ })[0]!.querySelector("svg[data-icon='grip']")).not.toBeNull();
    expect(within(cells[0]!).getByText("槽位 01")).toBeTruthy();
    expect(within(screen.getByRole("gridcell", { name: "镜头 6：F.MP4" })).getByText("槽位 01")).toBeTruthy();
    // 选中 = Card 的选中环。
    clickSegment("镜头 1：A.MP4");
    expect(screen.getByRole("gridcell", { name: "镜头 1：A.MP4" }).className).toContain("ui-card--selected");
  });

  it("「第 n/m 条」(原 Take n/m)与「AI 生成」是 Badge;单条素材不出候选角标", async () => {
    apiMocks.listClips.mockResolvedValue([
      clip(1, "A.MP4"), clip(2, "B.MP4"), clip(3, "C.MP4"), clip(4, "D.MP4"), clip(5, "E.MP4"), clip(6, "F.MP4"), clip(9, "GEN.MP4", true),
    ]);
    apiMocks.getStoryboard.mockResolvedValue({ ...board, items: [...board.items, item(9, 2, "GEN.MP4", 6)] });
    await renderBand();
    expect(within(screen.getByRole("gridcell", { name: "镜头 1：A.MP4" })).getByText("第 1/3 条").className).toContain("ui-badge");
    expect(within(screen.getByRole("gridcell", { name: "镜头 3：C.MP4" })).queryByText(/^Take/)).toBeNull();
    expect(within(screen.getByRole("gridcell", { name: "镜头 7：GEN.MP4" })).getByText("AI 生成").className).toContain("ui-badge");
  });

  it("拖动中 DragOverlay 是瓦片 ghost(含缩略图),源瓦片 dragging class,落点瓦片画插入线", async () => {
    apiMocks.listClips.mockResolvedValue([
      clip(1, "A.MP4"), clip(2, "B.MP4"), clip(3, "C.MP4"), clip(4, "D.MP4"), clip(5, "E.MP4"), clip(6, "F.MP4"),
    ].map((c) => ({ ...c, cover_url: `/mock-covers/${c.id}.jpg` })));
    await renderBand();
    const active = { id: keyOf("镜头 1：A.MP4") };
    await act(async () => {
      dnd.onDragStart?.({ active });
    });
    expect(document.querySelector(".band-drag-ghost img")).not.toBeNull();
    expect(screen.getByRole("gridcell", { name: "镜头 1：A.MP4" }).className).toContain("dragging");
    await act(async () => {
      dnd.onDragOver?.({ active, over: { id: keyOf("镜头 3：C.MP4") } });
    });
    expect(screen.getByRole("gridcell", { name: "镜头 3：C.MP4" }).className).toContain("band-segment--over-after");
    await act(async () => {
      dnd.onDragEnd?.({ active, over: null });
    });
    expect(document.querySelector(".band-drag-ghost")).toBeNull();
    expect(document.querySelector(".band-segment--over-after")).toBeNull();
  });

  it("空槽位是虚线 Card,自带一个 secondary 主动作与「···」图标按钮两个套件按钮(R12:忽略进菜单)", async () => {
    apiMocks.listStoryGaps.mockResolvedValue([gap(10, 1, "REAL/ESTABLISHING", "建立镜头")]);
    render(<><ShotBand /><ToastHost /></>);
    const cell = await screen.findByRole("gridcell", { name: "镜头 6：缺口 建立镜头" });
    expect(cell.className).toContain("ui-card");
    expect(cell.className).toContain("slot");
    expect(within(cell).getByRole("button", { name: "回到第 2 步挑几条" }).className).toContain("ui-button--secondary");
    expect(within(cell).getByRole("button", { name: "更多" }).className).toContain("ui-button--icon");
    expect(within(cell).queryByRole("button", { name: "忽略" })).toBeNull();
    const menu = await openMore(cell);
    expect(within(menu).getByRole("menuitem", { name: "忽略" })).toBeTruthy();
  });

  it("视图切换「按章节 / 按时间 / 仅缺口」在附属 tablist 旁,tablist 名与五个 tab 一字不变", async () => {
    apiMocks.listStoryGaps.mockResolvedValue([gap(10, 2, "REAL/ESTABLISHING", "建立镜头")]);
    apiMocks.listClips.mockResolvedValue([
      clip(1, "A.MP4"), clip(2, "B.MP4"), clip(3, "C.MP4"), clip(4, "D.MP4"), clip(5, "E.MP4"), clip(6, "F.MP4"), clip(9, "GEN.MP4", true),
    ].map((c) => ({ ...c, captured_at: c.id === 6 ? "2026-08-01T00:00:00Z" : `2026-08-1${c.id}T00:00:00Z` })));
    await renderBand();
    // V-07:两组控件此前平铺在标题条,现在收进各自的「… ⌄」触发钮,要先展开才摸得到里面
    // 的东西;选中一项就收起(不常驻盖住下面的镜头带),所以每次都要重新展开。
    const openViews = () => fireEvent.click(screen.getByRole("button", { name: /^(按章节|按时间|仅缺口) ⌄$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^附属：/ }));
    const tablist = screen.getByRole("tablist", { name: "镜头带附属视图" });
    expect(within(tablist).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["故事", "音乐", "旅程", "地点卡", "模板"]);
    openViews();
    let views = screen.getByRole("group", { name: "镜头带视图" });
    expect(within(views).getAllByRole("button").map((button) => button.textContent)).toEqual(["按章节", "按时间", "仅缺口"]);
    expect(within(views).getByRole("button", { name: "按章节" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(within(views).getByRole("button", { name: "仅缺口" }));
    expect(screen.getAllByRole("rowgroup").map((group) => group.getAttribute("aria-label"))).toEqual(["第 2 章 抵达"]);
    expect(screen.getByRole("gridcell", { name: "镜头 7：缺口 建立镜头" })).toBeTruthy();

    openViews();
    views = screen.getByRole("group", { name: "镜头带视图" });
    fireEvent.click(within(views).getByRole("button", { name: "按时间" }));
    expect(screen.getAllByRole("rowgroup")).toHaveLength(1);
    expect(screen.getAllByRole("gridcell").map((cell) => cell.getAttribute("aria-label"))).toEqual([
      "镜头 1：F.MP4", "镜头 2：A.MP4", "镜头 3：B.MP4", "镜头 4：C.MP4", "镜头 5：D.MP4", "镜头 6：E.MP4",
    ]);
    // 按时间的顺序是拍摄时间定的,不许拖排。
    expect(screen.getAllByRole("button", { name: /^拖动 镜头/ }).every((grip) => (grip as HTMLButtonElement).disabled)).toBe(true);

    openViews();
    views = screen.getByRole("group", { name: "镜头带视图" });
    fireEvent.click(within(views).getByRole("button", { name: "按章节" }));
    expect(screen.getAllByRole("rowgroup")).toHaveLength(2);
  });
});

describe("镜头带按滚动位置展开章节", () => {
  const wideBoard: Storyboard = {
    ...board,
    chapters: [1, 2, 3, 4].map((id) => ({
      id,
      title: `第${id}段`,
      start_at: "",
      end_at: "",
      clip_count: 3,
    })),
    items: [1, 2, 3, 4].flatMap((chapterId) =>
      [0, 1, 2].map((offset) => {
        const clipId = (chapterId - 1) * 3 + offset + 1;
        return item(clipId, chapterId, `C${clipId}.MP4`, clipId - 1);
      }),
    ),
  };

  it("章 1 有选中时,滚到章 4 仍会把章 4 的分段渲染出来", async () => {
    apiMocks.getStoryboard.mockResolvedValue(wideBoard);
    apiMocks.listClips.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => clip(index + 1, `C${index + 1}.MP4`)),
    );
    render(<><ShotBand /><ToastHost /></>);
    await screen.findByRole("gridcell", { name: "镜头 1：C1.MP4" });
    clickSegment("镜头 1：C1.MP4");
    expect(screen.queryByRole("gridcell", { name: "镜头 12：C12.MP4" })).toBeNull();

    const viewport = screen.getByRole("grid", { name: "镜头序列" });
    // 每章 = 头 128 + 3 × 132 = 524px;滚到第 4 章的起点。
    Object.defineProperty(viewport, "scrollLeft", { value: 524 * 3, configurable: true });
    await act(async () => {
      fireEvent.scroll(viewport);
    });
    expect(await screen.findByRole("gridcell", { name: "镜头 12：C12.MP4" })).toBeTruthy();
    expect(screen.queryByRole("gridcell", { name: "镜头 1：C1.MP4" })).toBeNull();
  });
});
