// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getClipsRevision: vi.fn(),
  listClips: vi.fn(),
  listShotStacks: vi.fn(),
  getStoryboard: vi.fn(),
  listStoryGaps: vi.fn(),
  listClipDimensions: vi.fn(),
  listAssetSafety: vi.fn(),
  searchClips: vi.fn(),
  searchTranscripts: vi.fn(),
  setSetting: vi.fn().mockResolvedValue(undefined),
  getCurrentEpisode: vi.fn(),
  rateClip: vi.fn().mockResolvedValue(undefined),
  clearClipRating: vi.fn().mockResolvedValue(undefined),
  setShotStackUserState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../api", () => apiMocks);

import type { ClipListItem, ShotStack } from "../api";
import { MediaPool } from "./MediaPool";
import { poolColumnCount } from "./poolModel";
import { __resetClipsFeedForTests } from "./useClipsFeed";
import { __resetWorkspaceForTests, dispatchWorkspace, getWorkspaceSnapshot } from "./WorkspaceStore";

function clip(id: number, overrides: Partial<ClipListItem> = {}): ClipListItem {
  return {
    id,
    episode_id: 1,
    folder_label: null,
    cover_url: `http://127.0.0.1/cache/${id}/cover.jpg`,
    path: `/Volumes/CARD/clip-${id}.mov`,
    file_name: `clip-${id}.mov`,
    byte_size: 2048,
    quick_hash: null,
    full_hash: null,
    tb_num: 1,
    tb_den: 1000,
    // 12.0s —— AX 名里的 "00:12" 就是这条算出来的。
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
    kind: "video",
    binary_rating: null,
    star_rating: null,
    select_count: 0,
    ...overrides,
  };
}

beforeEach(() => {
  __resetClipsFeedForTests();
  __resetWorkspaceForTests();
  apiMocks.getClipsRevision.mockResolvedValue("rev-1");
  apiMocks.listClips.mockResolvedValue([
    clip(1, { file_name: "DJI_0001.MP4", binary_rating: 1 }),
    clip(2),
    clip(3, { binary_rating: -1 }),
  ]);
  apiMocks.listShotStacks.mockResolvedValue([]);
  apiMocks.getStoryboard.mockResolvedValue(null);
  apiMocks.listStoryGaps.mockResolvedValue([]);
  apiMocks.listClipDimensions.mockResolvedValue([]);
  apiMocks.listAssetSafety.mockResolvedValue([]);
  apiMocks.searchClips.mockResolvedValue([]);
  apiMocks.searchTranscripts.mockResolvedValue([]);
  apiMocks.getCurrentEpisode.mockResolvedValue({ id: 1, title: "EP01" });
});

afterEach(() => {
  cleanup();
  __resetClipsFeedForTests();
  __resetWorkspaceForTests();
  vi.clearAllMocks();
});

async function renderPool(): Promise<void> {
  render(<MediaPool />);
  await waitFor(() => expect(screen.getAllByRole("gridcell").length).toBeGreaterThan(0));
}

describe("媒体池 —— AX 与网格结构", () => {
  it("网格是 role=grid,AX 名为「媒体池」,卡片是 gridcell", async () => {
    await renderPool();
    expect(screen.getByRole("grid", { name: "媒体池" })).toBeTruthy();
    expect(screen.getAllByRole("gridcell").length).toBeGreaterThan(0);
  });

  it("卡片 AX 名为「{文件名} · {时长} · {评级}」", async () => {
    await renderPool();
    expect(await screen.findByRole("gridcell", { name: "DJI_0001.MP4 · 00:12 · 收藏" })).toBeTruthy();
    expect(screen.getByRole("gridcell", { name: "clip-2.mov · 00:12 · 未评" })).toBeTruthy();
    expect(screen.getByRole("gridcell", { name: "clip-3.mov · 00:12 · 拒绝" })).toBeTruthy();
  });

  // WebKit(WKWebView 用的就是它)的 ARIA grid 映射只认 row 作为 table 的子节点:
  // gridcell 上面没有 role=row 时,整棵 AXTable 的后代被剪光 —— 真机上媒体池对
  // VoiceOver / AX 探针就是空的(R8 实测:同一份结构在 Safari 里 AXTable 零后代,
  // 套上 role=row 后才出现 AXRow → AXCell)。所以每张卡都必须有 row 祖先。
  it("卡片文件名分行,不含省略号,title 是完整名", async () => {
    apiMocks.listClips.mockResolvedValue([clip(1, { file_name: "20260812_昆明长水机场_出发_01.MP4" })]);
    await renderPool();
    const cell = screen.getAllByRole("gridcell")[0]!;
    const name = cell.querySelector(".pool-card-name")!;
    expect(name.textContent).not.toContain("…");
    expect(name.textContent).toBe("20260812_昆明长水机场_出发_01.MP4");
    expect(name.querySelectorAll(".pool-card-name-line").length).toBe(2);
    expect(name.getAttribute("title")).toBe("20260812_昆明长水机场_出发_01.MP4");
  });

  it("卡片是套件 Card:interactive,选中时 selected class", async () => {
    await renderPool();
    const cell = screen.getAllByRole("gridcell")[0]!;
    expect(cell.className).toContain("ui-card--interactive");
    fireEvent.click(cell);
    await waitFor(() => expect(cell.className).toContain("ui-card--selected"));
  });

  it("评级用图标:收藏 heart、拒绝 x(加斜纹遮罩)、星级实心 star", async () => {
    apiMocks.listClips.mockResolvedValue([
      clip(1, { binary_rating: 1 }),
      clip(2, { binary_rating: -1 }),
      clip(3, { star_rating: 3 }),
    ]);
    await renderPool();
    expect(document.querySelector(".pool-card-rating.favorite svg")).not.toBeNull();
    expect(document.querySelector(".pool-card-rating.rejected svg")).not.toBeNull();
    expect(document.querySelector(".pool-card-rejected-veil")).not.toBeNull();
    expect(document.querySelectorAll(".pool-card-rating.stars svg").length).toBe(3);
    // AX 名不变:评级仍是文字,图标只是装饰。
    expect(screen.getByRole("gridcell", { name: "clip-3.mov · 00:12 · 3 星" })).toBeTruthy();
  });

  it("筛选 chips 是套件 Chip(aria-pressed),更多筛选带 chevron", async () => {
    await renderPool();
    const all = screen.getByRole("button", { name: /^全部/ });
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(all.className).toContain("ui-chip");
    expect(screen.getByRole("button", { name: "更多筛选" }).querySelector("svg")).not.toBeNull();
  });

  it("每张卡都在 role=row 里 —— 少了 row,WebKit 会把整张表的后代剪光", async () => {
    await renderPool();
    const grid = screen.getByRole("grid", { name: "媒体池" });
    const rows = screen.getAllByRole("row");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(grid.contains(row)).toBe(true);
    const cells = screen.getAllByRole("gridcell");
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.closest('[role="row"]')).not.toBeNull();
    }
  });

  it("行是真实的 grid 盒子,不是 display:contents —— WebKit 把 display:contents 从 AX 树里剪掉", async () => {
    // R8 真机 #3:500 条素材下 AXTable「媒体池」只暴露 1 个 AXRow / 1 个 AXCell。
    // 根因是 `.pool-grid-row { display: contents }` —— 这层盒子在渲染树里根本不存在,
    // WebKit 的 AX 映射跟着把它(以及它带的 role=row)剪掉,gridcell 又没了合法父节点。
    // 修法:列模板搬到行自己身上,行成为真正的 grid 容器,像素排布不变。
    const css = readFileSync(resolve(process.cwd(), "src/styles/workspace.css"), "utf8");
    const rule = /\.pool-grid-row\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule?.[1] ?? "").not.toMatch(/display:\s*contents/);

    apiMocks.listClips.mockResolvedValue(
      Array.from({ length: 500 }, (_, index) => clip(index + 1)),
    );
    await renderPool();
    const rows = screen.getAllByRole("row");
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.style.gridTemplateColumns).toMatch(/^repeat\(/);
  });

  it("行带 aria-rowindex —— 虚拟化下 AT 才知道自己在第几行", async () => {
    apiMocks.listClips.mockResolvedValue(
      Array.from({ length: 500 }, (_, index) => clip(index + 1)),
    );
    await renderPool();
    const rows = screen.getAllByRole("row");
    expect(rows[0]?.getAttribute("aria-rowindex")).toBe("1");
    const cells = screen.getAllByRole("gridcell");
    expect(cells[0]?.getAttribute("aria-colindex")).toBe("1");
  });

  it("卡片带跨栏回显用的 id,规则与镜头带同一套", async () => {
    await renderPool();
    expect(document.getElementById("pool-clip-1")).toBeTruthy();
  });

  it("U-04/P-10:有拍摄时间的素材按「日期 › 时段」出一行分组摘要 chip", async () => {
    // 分组按本机钟面;夹具是 +08:00 的钟面,钉在东八区期望值才与字面一致。
    const tz = process.env.TZ;
    process.env.TZ = "Asia/Shanghai";
    onTestFinished(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });
    apiMocks.listClips.mockResolvedValue([
      clip(1, { captured_at: "2026-08-12T08:10:00+08:00" }),
      clip(2, { captured_at: "2026-08-12T08:40:00+08:00" }),
      clip(3, { captured_at: "2026-08-13T20:00:00+08:00" }),
    ]);
    await renderPool();
    const groups = await screen.findByLabelText("按日期分组");
    expect(within(groups).getByText("08/12 上午")).toBeTruthy();
    expect(within(groups).getByText("2")).toBeTruthy();
    expect(within(groups).getByText("08/13 夜间")).toBeTruthy();
  });

  it("只有一组(全部同一天同一时段,或全部时间未知)时,分组摘要行不出现", async () => {
    await renderPool();
    // beforeEach 里的三条默认夹具 captured_at 都是 null → 只有「时间未知」一组。
    expect(screen.queryByLabelText("按日期分组")).toBeNull();
  });

  it("列数随栏宽在 2–4 之间自适应", () => {
    expect(poolColumnCount(260)).toBe(2);
    expect(poolColumnCount(340)).toBe(3);
    expect(poolColumnCount(480)).toBe(4);
  });

  it("500 条只渲染视口内的行 + 2 行 overscan", async () => {
    apiMocks.listClips.mockResolvedValue(
      Array.from({ length: 500 }, (_, index) => clip(index + 1)),
    );
    await renderPool();
    await waitFor(() =>
      expect(screen.getByRole("grid").getAttribute("data-total-clips")).toBe("500"),
    );
    expect(screen.getAllByRole("gridcell").length).toBeLessThan(60);
  });

  it("缩略图带 loading=lazy 与 decoding=async(规格 §10)", async () => {
    await renderPool();
    const images = document.querySelectorAll(".pool-card-image img");
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image.getAttribute("loading")).toBe("lazy");
      expect(image.getAttribute("decoding")).toBe("async");
    }
  });
});

describe("媒体池 —— 搜索与筛选条", () => {
  it("筛选条折叠成一行 chips,其余进「更多筛选」popover", async () => {
    await renderPool();
    expect(screen.getByRole("button", { name: "更多筛选" })).toBeTruthy();
    // 折叠起来的那些控件在 popover 打开前不在 DOM 里。
    expect(screen.queryByText("排除普通疑似废片")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更多筛选" }));
    expect(screen.getByRole("dialog", { name: "更多筛选" })).toBeTruthy();
    for (const label of ["画面筛选", "排除普通疑似废片", "只看每组首选", "竖屏"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("主屏不出现英文 kicker(规格 §6)", async () => {
    await renderPool();
    expect(screen.queryByText("CHINESE-CLIP · LOCAL")).toBeNull();
    expect(screen.queryByText("LIBRARY")).toBeNull();
    expect(screen.queryByText(/SELECT|ROUGH CUT|LOCAL-FIRST/)).toBeNull();
  });

  it("筛选写进 store 的 ui.pool.filter,并只留下该评级的素材", async () => {
    await renderPool();
    fireEvent.click(screen.getByRole("button", { name: /收藏/ }));
    await waitFor(() => expect(getWorkspaceSnapshot().filter).toBe("favorite"));
    await waitFor(() => expect(screen.getAllByRole("gridcell")).toHaveLength(1));
    expect(screen.getByRole("gridcell", { name: /DJI_0001\.MP4/ })).toBeTruthy();
  });

  it("八维维度写进 store 的 ui.pool.dimension", async () => {
    apiMocks.listClipDimensions.mockResolvedValue([
      { clip_id: 1, dimension: "function", label: "Orientation", score: 0.4, source: "test" },
    ]);
    await renderPool();
    fireEvent.click(screen.getByRole("button", { name: "更多筛选" }));
    fireEvent.change(screen.getByRole("combobox", { name: /画面筛选/ }), {
      target: { value: "function" },
    });
    await waitFor(() => expect(getWorkspaceSnapshot().dimension).toBe("function"));
  });

  it("搜索把关键词写进 store 并按后端命中收窄网格", async () => {
    apiMocks.searchClips.mockResolvedValue([{ clip_id: 2, score: 0.9 }]);
    await renderPool();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索画面或对白关键词" }), {
      target: { value: "雪山" },
    });
    // R18 V-18:框外那颗「搜索」按钮删了(框内已有放大镜),断言迁移到「回车即搜」。
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "搜索画面或对白关键词" }), { key: "Enter" });
    await waitFor(() => expect(getWorkspaceSnapshot().query).toBe("雪山"));
    await waitFor(() => expect(screen.getAllByRole("gridcell")).toHaveLength(1));
    expect(screen.getByRole("gridcell", { name: /clip-2\.mov/ })).toBeTruthy();
  });
});

describe("媒体池 —— 选择驱动监视器与检查器", () => {
  it("点卡片产生 clip 选择,store.selection 跟着换", async () => {
    await renderPool();
    fireEvent.click(screen.getByRole("gridcell", { name: /clip-2\.mov/ }));
    await waitFor(() =>
      expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 2 }),
    );
    expect(screen.getByRole("grid").getAttribute("aria-activedescendant")).toBe("pool-clip-2");
  });

  it("⇧ 连选按可见顺序取闭区间,但 selection 只跟最后一次点击", async () => {
    await renderPool();
    fireEvent.click(screen.getByRole("gridcell", { name: /DJI_0001\.MP4/ }));
    await waitFor(() => expect(getWorkspaceSnapshot().multiSelection).toEqual([1]));
    fireEvent.click(screen.getByRole("gridcell", { name: /clip-3\.mov/ }), { shiftKey: true });
    await waitFor(() => expect(getWorkspaceSnapshot().multiSelection).toEqual([1, 2, 3]));
    expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 3 });
  });
});

describe("媒体池 —— 只看当前集", () => {
  it("别的集的素材不进网格", async () => {
    apiMocks.listClips.mockResolvedValue([
      clip(1, { file_name: "本集.MP4" }),
      clip(2, { file_name: "上一集.MP4", episode_id: 2 }),
    ]);
    await renderPool();
    expect(await screen.findByRole("gridcell", { name: /本集\.MP4/ })).toBeTruthy();
    expect(screen.queryByRole("gridcell", { name: /上一集\.MP4/ })).toBeNull();
    expect(screen.getByRole("grid").getAttribute("data-total-clips")).toBe("1");
  });
});

describe("媒体池 —— 网格键盘漫游(roving tabindex)", () => {
  function columnsOf(): number {
    return Number(screen.getByRole("grid").getAttribute("aria-colcount"));
  }

  it("ArrowDown 把锚点下移一整行(columns 条)", async () => {
    apiMocks.listClips.mockResolvedValue(
      Array.from({ length: 24 }, (_, index) => clip(index + 1)),
    );
    await renderPool();
    fireEvent.click(screen.getByRole("gridcell", { name: /clip-1\.mov/ }));
    await waitFor(() => expect(getWorkspaceSnapshot().anchorClipId).toBe(1));
    const columns = columnsOf();
    fireEvent.keyDown(screen.getByRole("grid"), { key: "ArrowDown" });
    await waitFor(() => expect(getWorkspaceSnapshot().anchorClipId).toBe(1 + columns));
  });

  it("锚点被虚拟化卸载后,方向键仍然继续生效", async () => {
    apiMocks.listClips.mockResolvedValue(
      Array.from({ length: 500 }, (_, index) => clip(index + 1)),
    );
    await renderPool();
    fireEvent.click(screen.getByRole("gridcell", { name: /^clip-1\.mov/ }));
    await waitFor(() => expect(getWorkspaceSnapshot().anchorClipId).toBe(1));
    const columns = columnsOf();
    // 浏览器里点一下按钮就会聚焦它;fireEvent.click 不会,手动补上这一步。
    document.getElementById("pool-clip-1")!.focus();

    const viewport = screen.getByRole("grid");
    fireEvent.scroll(viewport, { target: { scrollTop: 6_000 } });
    await waitFor(() => expect(document.getElementById("pool-clip-1")).toBeNull());
    // 焦点回到网格容器,键盘不失灵。
    expect(document.activeElement).toBe(viewport);

    fireEvent.keyDown(viewport, { key: "ArrowDown" });
    await waitFor(() => expect(getWorkspaceSnapshot().anchorClipId).toBe(1 + columns));
  });

  it("网格里只有一个 tabIndex=0 的元素", async () => {
    await renderPool();
    const grid = screen.getByRole("grid");
    // 还没选中:入口在容器上。
    expect(grid.getAttribute("tabindex")).toBe("0");
    expect(grid.querySelectorAll('[tabindex="0"]').length).toBe(0);

    fireEvent.click(screen.getByRole("gridcell", { name: /clip-2\.mov/ }));
    await waitFor(() => expect(getWorkspaceSnapshot().anchorClipId).toBe(2));
    expect(grid.getAttribute("tabindex")).toBe("-1");
    const zeros = grid.querySelectorAll('[tabindex="0"]');
    expect(zeros.length).toBe(1);
    expect(zeros[0].id).toBe("pool-clip-2");
    expect(grid.getAttribute("aria-activedescendant")).toBe("pool-clip-2");
  });
});

function stackOf(id: number, clipIds: number[]): ShotStack {
  return {
    id,
    scene_id: 1,
    scene_name: "登机口",
    stack_type: "visual",
    subject_label: "未知",
    function_label: "未知",
    shot_size_label: "未知",
    movement_label: "未知",
    quality_exempt: false,
    members: clipIds.map((clipId, index) => ({
      clip_id: clipId,
      segment_id: null,
      best_take_score: null,
      score_breakdown: {} as ShotStack["members"][number]["score_breakdown"],
      user_state: "none" as ShotStack["members"][number]["user_state"],
      is_preferred: index === 0,
      long_term_memory: {} as ShotStack["members"][number]["long_term_memory"],
    })),
  };
}

describe("媒体池 —— 单键评级(U-01)", () => {
  it("焦点在卡片上按 3 → 三星,按 F → 收藏;搜索框里按 3 不评级", async () => {
    // 后端写入后 feed 会强制刷新,让 listClips 回显评级,免得刷新把乐观补丁盖回去。
    apiMocks.rateClip.mockImplementation(async (id: number, kind: string, value: number) => {
      apiMocks.listClips.mockResolvedValue([
        clip(1, { file_name: "DJI_0001.MP4", binary_rating: 1 }),
        clip(2, kind === "star" ? { star_rating: value as 3 } : { binary_rating: value as 1 }),
        clip(3, { binary_rating: -1 }),
      ]);
    });
    await renderPool();
    const card = screen.getByRole("gridcell", { name: /clip-2\.mov/ });
    fireEvent.click(card);
    await waitFor(() => expect(getWorkspaceSnapshot().anchorClipId).toBe(2));
    card.focus();
    fireEvent.keyDown(card, { key: "3", code: "Digit3" });
    await waitFor(() => expect(apiMocks.rateClip).toHaveBeenCalledWith(2, "star", 3));
    await waitFor(() =>
      expect(screen.getByRole("gridcell", { name: "clip-2.mov · 00:12 · 3 星" })).toBeTruthy(),
    );
    fireEvent.keyDown(screen.getByRole("gridcell", { name: /clip-2\.mov/ }), { key: "f", code: "KeyF" });
    await waitFor(() => expect(apiMocks.rateClip).toHaveBeenCalledWith(2, "binary", 1));

    apiMocks.rateClip.mockClear();
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "搜索画面或对白关键词" }), { key: "3", code: "Digit3" });
    expect(apiMocks.rateClip).not.toHaveBeenCalled();
  });

  it("焦点在卡片上按 Space → 发出 tripcut:toggle-playback(监视器据此播放/暂停)", async () => {
    await renderPool();
    const card = screen.getByRole("gridcell", { name: /clip-2\.mov/ });
    fireEvent.click(card);
    await waitFor(() => expect(getWorkspaceSnapshot().anchorClipId).toBe(2));
    const seen: string[] = [];
    const listener = () => seen.push("toggle");
    window.addEventListener("tripcut:toggle-playback", listener);
    try {
      expect(fireEvent.keyDown(card, { key: " ", code: "Space" })).toBe(false);
      expect(seen).toEqual(["toggle"]);
    } finally {
      window.removeEventListener("tripcut:toggle-playback", listener);
    }
  });
});

describe("媒体池 —— Stack 展开(U-02 / U-26)", () => {
  beforeEach(() => {
    apiMocks.listClips.mockResolvedValue(
      Array.from({ length: 9 }, (_, index) => clip(index + 1)),
    );
    apiMocks.listShotStacks.mockResolvedValue([stackOf(7, [1, 2, 3, 4, 5, 6, 7, 8])]);
  });

  it("「同一镜头 8 条」角标可点展开候选条;卡片 aria-expanded 跟着变", async () => {
    await renderPool();
    await waitFor(() => expect(screen.getByText("同一镜头 8 条")).toBeTruthy());
    const card = screen.getByRole("gridcell", { name: /clip-1\.mov/ });
    expect(card.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group", { name: /同一镜头 · 登机口/ })).toBeNull();
    fireEvent.click(screen.getByText("同一镜头 8 条"));
    expect(await screen.findByRole("group", { name: /同一镜头 · 登机口/ })).toBeTruthy();
    expect(screen.getByRole("gridcell", { name: /clip-1\.mov/ }).getAttribute("aria-expanded")).toBe("true");
    // 点角标不改变选中(选中仍是点击卡片本体的事)。
    expect(getWorkspaceSnapshot().selection).toBeNull();
  });

  it("焦点在 Stack 卡片上按 Tab 也展开;再按 Tab 收起", async () => {
    await renderPool();
    await waitFor(() => expect(screen.getByText("同一镜头 8 条")).toBeTruthy());
    const card = screen.getByRole("gridcell", { name: /clip-1\.mov/ });
    fireEvent.click(card);
    await waitFor(() => expect(getWorkspaceSnapshot().anchorClipId).toBe(1));
    card.focus();
    expect(fireEvent.keyDown(card, { key: "Tab", code: "Tab" })).toBe(false);
    expect(await screen.findByRole("group", { name: /同一镜头 · 登机口/ })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("gridcell", { name: /clip-1\.mov/ }), { key: "Tab", code: "Tab" });
    await waitFor(() => expect(screen.queryByRole("group", { name: /同一镜头 · 登机口/ })).toBeNull());
  });

  it("U-26:候选条先露 6 条,尾部「还有 2 条」点开后全部列出,每条带缩略图", async () => {
    await renderPool();
    await waitFor(() => expect(screen.getByText("同一镜头 8 条")).toBeTruthy());
    fireEvent.click(screen.getByText("同一镜头 8 条"));
    const strip = await screen.findByRole("group", { name: /同一镜头 · 登机口/ });
    expect(strip.querySelectorAll(".pool-take-card").length).toBe(6);
    expect(strip.querySelectorAll(".pool-take-card img").length).toBe(6);
    fireEvent.click(screen.getByRole("button", { name: "还有 2 条" }));
    expect(strip.querySelectorAll(".pool-take-card").length).toBe(8);
    expect(screen.queryByRole("button", { name: /还有 \d+ 条/ })).toBeNull();
  });

  it("点候选条里的一条 → 选中那条素材", async () => {
    await renderPool();
    await waitFor(() => expect(screen.getByText("同一镜头 8 条")).toBeTruthy());
    fireEvent.click(screen.getByText("同一镜头 8 条"));
    await screen.findByRole("group", { name: /同一镜头 · 登机口/ });
    fireEvent.click(screen.getByRole("button", { name: /第 3 条 · clip-3\.mov/ }));
    await waitFor(() =>
      expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 3 }),
    );
  });
});

describe("媒体池 —— 空态(U-06)", () => {
  it("库为空:「第 ① 步:先导入」+ 大号「导入素材」按钮打开导入抽屉", async () => {
    apiMocks.listClips.mockResolvedValue([]);
    render(<MediaPool />);
    // R12 §1 第三条:空态按当前步说话(原「还没有素材」退到正文)。
    expect(await screen.findByText("第 ① 步:先导入")).toBeTruthy();
    expect(screen.queryByText("没有匹配的素材")).toBeNull();
    // R-07:空态必须在 role=grid 之外 —— WebKit 会把 grid 的非 row 子节点从 AX 树剔掉,按钮按名字找不到。
    const importButton = screen.getByRole("button", { name: "导入第一批素材" });
    expect(importButton.closest('[role="grid"]')).toBeNull();
    expect(importButton.closest(".media-pool")).not.toBeNull();
    fireEvent.click(importButton);
    expect(getWorkspaceSnapshot().openDrawer).toBe("import");
  });

  it("筛选为空:「没有匹配的素材」+「清空筛选」复原,不出现导入按钮", async () => {
    await renderPool();
    fireEvent.click(screen.getByRole("button", { name: /^拒绝/ }));
    await waitFor(() => expect(screen.getAllByRole("gridcell")).toHaveLength(1));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索画面或对白关键词" }), {
      target: { value: "没有这个词" },
    });
    // R18 V-18:框外那颗「搜索」按钮删了(框内已有放大镜),断言迁移到「回车即搜」。
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "搜索画面或对白关键词" }), { key: "Enter" });
    expect(await screen.findByText("没有匹配的素材")).toBeTruthy();
    expect(screen.queryByText("第 ① 步:先导入")).toBeNull();
    expect(screen.queryByRole("button", { name: "导入第一批素材" })).toBeNull();
    const resetButton = screen.getByRole("button", { name: "清空筛选" });
    expect(resetButton.closest('[role="grid"]')).toBeNull();
    fireEvent.click(resetButton);
    await waitFor(() => expect(screen.getAllByRole("gridcell")).toHaveLength(3));
    expect(getWorkspaceSnapshot().query).toBe("");
  });
});

describe("媒体池 —— 搜索并入文件名(U-15)", () => {
  it("后端 0 命中时按文件名子串匹配;输入清空即自动复原", async () => {
    apiMocks.listClips.mockResolvedValue([
      clip(1, { file_name: "IMG_0813_登机口.mov" }),
      clip(2, { file_name: "DJI_0101.MP4" }),
      clip(3),
    ]);
    await renderPool();
    const box = screen.getByRole("searchbox", { name: "搜索画面或对白关键词" });
    fireEvent.change(box, { target: { value: "登机" } });
    // R18 V-18:框外那颗「搜索」按钮删了(框内已有放大镜),断言迁移到「回车即搜」。
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "搜索画面或对白关键词" }), { key: "Enter" });
    await waitFor(() => expect(screen.getAllByRole("gridcell")).toHaveLength(1));
    expect(screen.getByRole("gridcell", { name: /IMG_0813_登机口\.mov/ })).toBeTruthy();

    // 大小写不敏感。
    fireEvent.change(box, { target: { value: "dji" } });
    // R18 V-18:框外那颗「搜索」按钮删了(框内已有放大镜),断言迁移到「回车即搜」。
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "搜索画面或对白关键词" }), { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("gridcell", { name: /DJI_0101\.MP4/ })).toBeTruthy());
    expect(screen.getAllByRole("gridcell")).toHaveLength(1);

    // 清空输入,不点「搜索」也复原。
    fireEvent.change(box, { target: { value: "" } });
    await waitFor(() => expect(screen.getAllByRole("gridcell")).toHaveLength(3));
    expect(getWorkspaceSnapshot().query).toBe("");
  });

  it("Esc 清掉 store 的搜索词时网格同样复原", async () => {
    apiMocks.listClips.mockResolvedValue([clip(1, { file_name: "IMG_0813_登机口.mov" }), clip(2)]);
    await renderPool();
    const box = screen.getByRole("searchbox", { name: "搜索画面或对白关键词" });
    fireEvent.change(box, { target: { value: "登机" } });
    // R18 V-18:框外那颗「搜索」按钮删了(框内已有放大镜),断言迁移到「回车即搜」。
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "搜索画面或对白关键词" }), { key: "Enter" });
    await waitFor(() => expect(screen.getAllByRole("gridcell")).toHaveLength(1));
    dispatchWorkspace({ type: "set-query", query: "" });
    await waitFor(() => expect(screen.getAllByRole("gridcell")).toHaveLength(2));
  });
});

/** R18 车道 layout · V-18:搜索/筛选/角标/列数四条版面项的回归。 */
describe("媒体池 —— R18 版面打磨(V-18)", () => {
  it("框外那颗「搜索」按钮没有了;「搜索」这个词仍在输入框自己的 AX 名里,回车即搜", async () => {
    apiMocks.searchClips.mockResolvedValue([{ clip_id: 2, score: 0.9 }]);
    await renderPool();
    expect(screen.queryByRole("button", { name: "搜索" })).toBeNull();
    expect(screen.queryByRole("button", { name: "搜索中" })).toBeNull();
    const box = screen.getByRole("searchbox", { name: "搜索画面或对白关键词" });
    expect(box.getAttribute("aria-label")).toContain("搜索");
    fireEvent.change(box, { target: { value: "雪山" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(getWorkspaceSnapshot().query).toBe("雪山"));
  });

  it("筛选芯片与「更多筛选⌄」在同一行:芯片进可横向滚动的一段,「更多筛选」是它的兄弟", async () => {
    await renderPool();
    const chips = screen.getByRole("group", { name: "评级筛选" });
    const scroll = chips.querySelector(".pool-chip-scroll");
    expect(scroll).not.toBeNull();
    // 四个评级芯片全在滚动段里,「更多筛选」在它外面(所以它不跟着滚)。
    expect(scroll!.querySelectorAll(".ui-chip").length).toBeGreaterThanOrEqual(4);
    const more = screen.getByRole("button", { name: "更多筛选" });
    expect(more.closest(".pool-chip-scroll")).toBeNull();
    expect(more.closest('[role="group"]')).toBe(chips);
  });

  it("重复组角标是「图标 + ×n」,原文「同一镜头 n 条」留在视觉隐藏的一段里(AX 不变)", async () => {
    apiMocks.listClips.mockResolvedValue(Array.from({ length: 9 }, (_, index) => clip(index + 1)));
    apiMocks.listShotStacks.mockResolvedValue([stackOf(7, [1, 2, 3, 4, 5, 6, 7, 8])]);
    await renderPool();
    const badge = await waitFor(() => {
      const found = document.querySelector(".pool-card-stack");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(badge.querySelector(".ui-icon")).not.toBeNull();
    expect(badge.textContent).toContain("×8");
    const hidden = badge.querySelector(".visually-hidden");
    expect(hidden?.textContent).toBe("同一镜头 8 条");
  });

  it("列数两档:同一个栏宽(320)在 1440 下三列、窄到 1280 变两列", async () => {
    // test-setup 把 window.innerWidth 钉在 1440。先看宽屏这一档,再把窗口调窄。
    await renderPool();
    const grid = screen.getByRole("grid", { name: "媒体池" });
    expect(poolColumnCount(320)).toBe(3);
    expect(grid.getAttribute("aria-colcount")).toBe("3");

    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true, writable: true });
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(grid.getAttribute("aria-colcount")).toBe("2"));

    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true, writable: true });
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(grid.getAttribute("aria-colcount")).toBe("3"));
  });
});

describe("R21 §0.5 视频工作台隔离", () => {
  it("媒体池只显示视频，照片与疑似废片提示都不进入视频池", async () => {
    const analysis = { clip_id: 1, exposure_yavg: 12, overexposed_ratio: 0, audio_peak_db: null, audio_clipped: false, has_audio: false, focus_scores: [20], scene_count: 0, analyzed_at: "now", tool_versions: {}, underexposed_ratio: 1, dynamic_range: 20, blur_mean: 0, entropy_mean: 6, motion_mean: 0, out_of_focus_ratio: 0 };
    apiMocks.listClips.mockResolvedValue([
      clip(1, { kind: "photo", duration_ticks: 0, analysis, analysis_status: "done" }),
      clip(2, { kind: "video", analysis: { ...analysis, clip_id: 2, underexposed_ratio: 0 }, analysis_status: "done" }),
    ]);
    render(<MediaPool />);
    await waitFor(() => expect(screen.getAllByRole("gridcell")).toHaveLength(1));
    const cells = within(screen.getByRole("grid", { name: "媒体池" })).getAllByRole("gridcell");
    expect(cells).toHaveLength(1);
    expect(cells[0]!.textContent).toContain("clip-2");
    expect(screen.queryByText(/疑似废片/)).toBeNull();
    expect(apiMocks.rateClip).not.toHaveBeenCalled();
  });
});
