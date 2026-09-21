// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => children,
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
  generationAvailability: vi.fn(),
  listStoryTemplates: vi.fn(),
  listMusicTracks: vi.fn(),
  getMusicAnalysis: vi.fn(),
  getJourneyTimeline: vi.fn(),
  updateDestinationCard: vi.fn().mockResolvedValue(undefined),
  setDestinationCardVerified: vi.fn().mockResolvedValue(undefined),
  setStoryOrder: vi.fn().mockResolvedValue(undefined),
  getLlmStatus: vi.fn(),
  enqueueNarrateEpisode: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...apiMocks,
}));

import type { DestinationCard, Storyboard, StoryItem } from "../api";
import { BAND_TABS, BandAccessory, BandTabs, RULER_SEGMENT_WIDTH, rulerMarks } from "./BandAccessory";
import { ShotBand } from "./ShotBand";
import { __resetClipsFeedForTests } from "./useClipsFeed";
import {
  INITIAL_WORKSPACE_STATE,
  __resetWorkspaceForTests,
  getWorkspaceSnapshot,
  persistedPairs,
} from "./WorkspaceStore";
import { __setShowAllFeaturesForTests } from "./showAllFeatures";

const destinationCard: DestinationCard = {
  id: 5,
  chapter_id: 1,
  name: "雪山垭口",
  geo_context: "川西",
  highlights: "日出",
  why_visit: "视野",
  personal_note: "",
  sources: [],
  verified: false,
  coverage: [],
  field_states: {},
};

const board: Storyboard = {
  chapters: [{ id: 1, title: "出发", start_at: "", end_at: "", clip_count: 0 }],
  items: [],
  candidates: [],
  can_undo: false,
  mode: "narrative",
  mode_notice: "",
  narrative: {
    episode: { id: 1, title: "EP01", theme: "", created_at: "", template: null },
    chapters: [],
    destination_cards: [destinationCard],
    boundary_signals: [],
    job_status: null,
    dh_guard: {
      historical_appearances: [],
      current_estimated_duration_s: 0,
      duration_warning_threshold_s: 90,
      warnings: [],
    },
  },
  narration_job_status: null,
  current_template: null,
};

beforeEach(() => {
  // R19 P-05:这份文件描述的是「显示全部功能」打开后的形态(旅程 / 地点卡 / 模板 / 技术检查 / 快捷键 / 性能 / 云端补镜都在);默认态在 showAllFeaturesR19.test。
  __setShowAllFeaturesForTests(true);
  __resetClipsFeedForTests();
  __resetWorkspaceForTests();
  for (const mock of Object.values(apiMocks)) mock.mockClear();
  apiMocks.getClipsRevision.mockResolvedValue("rev-1");
  apiMocks.listClips.mockResolvedValue([]);
  apiMocks.listShotStacks.mockResolvedValue([]);
  apiMocks.getStoryboard.mockResolvedValue(board);
  apiMocks.listStoryGaps.mockResolvedValue([]);
  apiMocks.listClipDimensions.mockResolvedValue([]);
  apiMocks.listAssetSafety.mockResolvedValue([]);
  apiMocks.getCurrentEpisode.mockResolvedValue({ id: 1, title: "EP01" });
  apiMocks.generationAvailability.mockResolvedValue({
    enabled: true,
    has_key: true,
    budget_remaining_usd: 5,
  });
  apiMocks.listStoryTemplates.mockResolvedValue([
    { id: "cinematic", name_zh: "电影感", blurb_zh: "慢节奏长镜头" },
    { id: "fastcut", name_zh: "快切", blurb_zh: "强节奏" },
  ]);
  apiMocks.listMusicTracks.mockResolvedValue([
    {
      id: 3,
      episode_id: 1,
      file_name: "road.mp3",
      rel_path: "road.mp3",
      quick_hash: null,
      duration_ticks: 2_000,
      tb_num: 1,
      tb_den: 1_000,
      bpm: 120,
      analysis_status: "done",
    },
  ]);
  apiMocks.getMusicAnalysis.mockResolvedValue({
    track: {
      id: 3,
      episode_id: 1,
      file_name: "road.mp3",
      rel_path: "road.mp3",
      quick_hash: null,
      duration_ticks: 2_000,
      tb_num: 1,
      tb_den: 1_000,
      bpm: 120,
      analysis_status: "done",
    },
    beats: [{ tick: 0, is_downbeat: true, strength: 1 }, { tick: 500, is_downbeat: false, strength: 1 }],
    sections: [{ start_tick: 0, end_tick: 1_000, label: "intro", energy: 0.2 }],
    suggested_cut_ticks: [1_000],
  });
  apiMocks.getJourneyTimeline.mockResolvedValue([]);
  apiMocks.getLlmStatus.mockResolvedValue({
    enabled: false,
    provider: "none",
    budget_exhausted: false,
    remaining_calls: 0,
  });
  apiMocks.enqueueNarrateEpisode.mockResolvedValue({ notice: "已重排" });
});
afterEach(cleanup);

/** V-07:五个附属 tab 收进「附属：{当前} ⌄」触发钮下的浮层,平时不占标题条版面——
 * 测试要先展开它才摸得到 tablist(选中一个 tab 后面板会自动收起,不留浮层盖住
 * 下面的镜头带,所以每次点 tab 之前都要重新展开)。 */
async function openAccessoryPanel(): Promise<void> {
  const trigger = screen.getByRole("button", { name: /^附属：/ });
  if (trigger.getAttribute("aria-expanded") === "true") return; // 已经展开就别再点一次把它关掉
  await act(async () => {
    fireEvent.click(trigger);
  });
}

async function renderBand(): Promise<void> {
  render(<ShotBand />);
  await openAccessoryPanel();
  await screen.findByRole("tablist", { name: "镜头带附属视图" });
}

async function clickTab(label: string): Promise<void> {
  await openAccessoryPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole("tab", { name: label }));
  });
}

describe("附属带分段控件", () => {
  it("分段控件是 tablist,AX 名与五个 tab 名一字不差", async () => {
    await renderBand();
    const list = screen.getByRole("tablist", { name: "镜头带附属视图" });
    expect(within(list).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "故事",
      "音乐",
      "旅程",
      "地点卡",
      "模板",
    ]);
    expect(BAND_TABS.map((tab) => tab.mode)).toEqual([
      "story",
      "music",
      "journey",
      "destination",
      "template",
    ]);
  });

  it("默认「故事」不展开附属区,镜头带独占中下区", async () => {
    await renderBand();
    expect(screen.getByRole("tab", { name: "故事" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("band-accessory")).toBeNull();
  });

  it("选中项持久化到 ui.band.mode", async () => {
    await renderBand();
    await clickTab("音乐");
    expect(getWorkspaceSnapshot().bandMode).toBe("music");
    // 落盘那一步由 persistedPairs 决定(测试里的 writer 是空实现,不发 IPC)。
    expect(
      persistedPairs({ ...INITIAL_WORKSPACE_STATE, bandMode: "story" }, getWorkspaceSnapshot()),
    ).toContainEqual(["ui.band.mode", "music"]);
  });

  it("「音乐」在镜头带上方插刻度轨,切点标「建议」且点击只定位不改数据", async () => {
    await renderBand();
    await clickTab("音乐");
    expect(await screen.findByText("音乐与节奏")).toBeTruthy(); // 冒烟 band.music.content 的锚点
    const marks = await screen.findAllByTestId("ruler-suggestion");
    expect(screen.getByText("建议")).toBeTruthy();
    const seen: unknown[] = [];
    const listener = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener("tripcut:seek-ratio", listener);
    fireEvent.click(marks[0]!);
    window.removeEventListener("tripcut:seek-ratio", listener);
    expect(seen).toHaveLength(1);
    expect(apiMocks.setStoryOrder).not.toHaveBeenCalled();
    expect(apiMocks.updateDestinationCard).not.toHaveBeenCalled();
  });

  it("「旅程」在下方展开只读 JourneyTimeline", async () => {
    await renderBand();
    await clickTab("旅程");
    expect(await screen.findByText("旅程时间线")).toBeTruthy(); // 冒烟 band.journey.content
    expect(screen.getByTestId("band-accessory")).toBeTruthy();
  });

  it("「地点卡」展开当前章节的目的地卡编辑(R6 字段状态与校验照旧)", async () => {
    await renderBand();
    await clickTab("地点卡");
    // 迁移自 Storyboard.test.tsx:新卡永远是「待核实」。
    expect(await screen.findByDisplayValue("雪山垭口")).toBeTruthy();
    expect(screen.getAllByText("待核实").length).toBeGreaterThan(0);
  });

  it("「模板」展开四选一,「电影感」在树里", async () => {
    await renderBand();
    await clickTab("模板");
    expect(await screen.findByText("电影感")).toBeTruthy(); // 冒烟 band.template.content
    expect(screen.getByRole("button", { name: /不使用模板/ })).toBeTruthy();
  });

  it("刻度落在镜头带的序号轴上:每个分段一个瓦片节距,整条曲子铺满整条序列", () => {
    // 节距 = 镜头带瓦片 140 + 间距 8(R19 V-06 由 160 + 8 收小)—— 与 `.band-segment` 的实宽同一个数(R8 视觉审计 §1)。
    const P = RULER_SEGMENT_WIDTH;
    expect(P).toBe(148);
    // 4 个分段 = 4P。0/500/1000 tick(总长 2000)→ 0 / P / 2P。
    expect(rulerMarks([0, 500, 1_000], [0, 1_000], 2_000, 4).beats).toEqual([0, P, 2 * P]);
    expect(rulerMarks([0, 500, 1_000], [0, 1_000], 2_000, 4).sections).toEqual([0, 2 * P]);
    expect(rulerMarks([], [0, 1_000], 2_000, 4, [1_500]).suggestions).toEqual([3 * P]);
    // 分段数变了,同一 tick 就落在别的像素上 —— 这正是「共用序号轴」的意思。
    expect(rulerMarks([500], [], 2_000, 8).beats).toEqual([2 * P]);
  });

  it("BandTabs 单独渲染也给同一份 AX 名(容器可复用);展开触发钮之后才摸得到 tablist", () => {
    render(<BandTabs />);
    expect(screen.queryByRole("tablist", { name: "镜头带附属视图" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^附属：/ }));
    expect(screen.getByRole("tablist", { name: "镜头带附属视图" })).toBeTruthy();
  });

  it("「故事」模式下 BandAccessory 本体返回 null", () => {
    const { container } = render(<BandAccessory />);
    expect(container.firstChild).toBeNull();
  });
});

function storyItem(clipId: number, chapterId: number, position: number): StoryItem {
  return {
    key: `whole:${clipId}`,
    item_kind: "whole",
    clip_id: clipId,
    segment_id: null,
    chapter_id: chapterId,
    file_name: `C${clipId}.MP4`,
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
  } as StoryItem;
}

describe("音乐刻度轨与镜头带同一条序号轴", () => {
  beforeEach(() => {
    apiMocks.listClips.mockResolvedValue(
      [1, 2, 3, 4].map((id) => ({ id, kind: "video" })) as never,
    );
    apiMocks.getStoryboard.mockResolvedValue({
      ...board,
      items: [0, 1, 2, 3].map((offset) => storyItem(offset + 1, 1, offset)),
    });
  });

  it("轨道宽度 = 分段数 × 瓦片节距,刻度按序号轴落点", async () => {
    await renderBand();
    await clickTab("音乐");
    const track = await screen.findByTestId("ruler-track");
    expect(track.style.width).toBe(`${4 * RULER_SEGMENT_WIDTH}px`);
    const beats = track.querySelectorAll(".band-ruler-beat");
    expect(Array.from(beats).map((mark) => (mark as HTMLElement).style.left)).toEqual([
      "0px",
      `${RULER_SEGMENT_WIDTH}px`,
    ]);
  });

  it("镜头带滚动时刻度轨跟着平移(同一条轴才对得上)", async () => {
    await renderBand();
    await clickTab("音乐");
    const track = await screen.findByTestId("ruler-track");
    expect(track.style.transform).toBe("translateX(0px)");
    const viewport = screen.getByRole("grid", { name: "镜头序列" });
    Object.defineProperty(viewport, "scrollLeft", { value: 150, configurable: true });
    await act(async () => {
      fireEvent.scroll(viewport);
    });
    expect(track.style.transform).toBe("translateX(-150px)");
  });
});

describe("模板选择的只读门控", () => {
  it("只读历史集里模板按钮全禁用,且不发起任何 LLM 调用", async () => {
    await renderBand();
    await clickTab("模板");
    await screen.findByText("电影感");
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("tripcut:view-episode", { detail: { id: 1, title: "EP00" } }),
      );
    });
    expect(screen.getByText("历史集为只读档案")).toBeTruthy();
    const pick = screen.getByRole("button", { name: /不使用模板/ });
    expect(pick).toHaveProperty("disabled", true);
    await act(async () => {
      fireEvent.click(pick);
    });
    expect(apiMocks.getLlmStatus).not.toHaveBeenCalled();
    expect(apiMocks.enqueueNarrateEpisode).not.toHaveBeenCalled();
  });
});

/* ---------- R9 Task 8a:附属面板搬到套件上 ---------- */

describe("附属面板(R9 套件皮)", () => {
  const WORKSPACE_CSS = readFileSync(resolve(process.cwd(), "src/styles/workspace.css"), "utf8");

  it("band-accessory.css 由 workspace.css 顶部 @import(尾部 @import 会被 postcss-import 丢掉)", () => {
    const importLine = WORKSPACE_CSS.indexOf('@import "./workspace/band-accessory.css";');
    const firstRule = WORKSPACE_CSS.search(/^[.@a-z][^\n]*\{/m);
    expect(importLine).toBeGreaterThan(-1);
    expect(importLine).toBeLessThan(firstRule);
    // 桶 + 分册(单文件 < 400 行):门禁把 @import 的分册都读进来一起扫。
    const dir = resolve(process.cwd(), "src/styles/workspace");
    const barrel = readFileSync(resolve(dir, "band-accessory.css"), "utf8");
    const parts = [...barrel.matchAll(/@import "\.\/([^"]+)";/g)].map((m) => readFileSync(resolve(dir, m[1]!), "utf8"));
    expect(parts.length).toBeGreaterThan(0);
    const css = [barrel, ...parts].join("\n");
    // 令牌门禁:没有颜色字面量,font-size 只用 --text-*;每条选择器都挂在 .workspace-shell 下。
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    for (const m of css.matchAll(/font-size:\s*([^;]+);/g)) expect(m[1]).toMatch(/^var\(--text-\d+\)$/);
    for (const m of css.matchAll(/^([.a-z][^\n{]*)\{/gm)) expect(m[1]).toMatch(/^\.workspace-shell /);
  });

  it.each(["音乐", "旅程", "地点卡", "模板"])("「%s」面板头是套件栏标题条,没有英文 kicker", async (label) => {
    await renderBand();
    await clickTab(label);
    const panel = screen.getByTestId("band-accessory");
    expect(panel.querySelector(".ui-section-header--pane .ui-section-header-title")).toBeTruthy();
    expect(panel.querySelector(".band-accessory-head")).toBeNull();
    expect(panel.textContent).not.toMatch(/\b[A-Z]{3,}\s*\//);
    expect(panel.textContent).not.toMatch(/Coverage/);
  });

  it("音乐:没有曲目时是套件空状态,唯一动作是「导入音乐」", async () => {
    apiMocks.listMusicTracks.mockResolvedValue([]);
    await renderBand();
    await clickTab("音乐");
    const panel = screen.getByTestId("band-accessory");
    const empty = await within(panel).findByText("还没有导入音乐");
    expect(empty.closest(".ui-empty")).toBeTruthy();
    expect(within(panel).getAllByRole("button", { name: "导入音乐" })).toHaveLength(1);
    expect(within(panel).getByRole("button", { name: "导入音乐" }).closest(".ui-empty")).toBeTruthy();
  });

  it("音乐:有曲目时「导入音乐」在栏标题条里,曲目是卡片", async () => {
    await renderBand();
    await clickTab("音乐");
    const panel = screen.getByTestId("band-accessory");
    await within(panel).findByText("road.mp3");
    expect(within(panel).getByRole("button", { name: "导入音乐" }).closest(".ui-section-header")).toBeTruthy();
    expect(panel.querySelector(".music-tracks-empty")).toBeNull();
  });

  it("旅程:没有条目时是套件空状态,动作是打开导入抽屉", async () => {
    await renderBand();
    await clickTab("旅程");
    const panel = screen.getByTestId("band-accessory");
    const empty = await within(panel).findByText("这一集还没有可排列的素材或地点卡。");
    expect(empty.closest(".ui-empty")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "打开导入" }));
    expect(getWorkspaceSnapshot().openDrawer).toBe("import");
  });

  it("地点卡:没有卡片时是套件空状态,动作是切到「模板」去编排", async () => {
    apiMocks.getStoryboard.mockResolvedValue({
      ...board,
      narrative: { ...board.narrative!, destination_cards: [] },
    });
    await renderBand();
    await clickTab("地点卡");
    const panel = screen.getByTestId("band-accessory");
    const empty = await within(panel).findByText("本次编排没有识别出需要地点卡的重要叙事节点。");
    expect(empty.closest(".ui-empty")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "去编排故事" }));
    expect(getWorkspaceSnapshot().bandMode).toBe("template");
  });

  it("模板:模板卡是套件 Card 按钮,选中态带 selected", async () => {
    await renderBand();
    await clickTab("模板");
    const none = await screen.findByRole("button", { name: /不使用模板/ });
    expect(none.className).toContain("ui-card");
    expect(none.className).toContain("ui-card--selected");
    expect(screen.getByRole("button", { name: /电影感/ }).className).not.toContain("ui-card--selected");
  });
});
