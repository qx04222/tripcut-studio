// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
}));
vi.mock("../api", () => apiMocks);

import type { ClipListItem } from "../api";
import { MediaPool } from "./MediaPool";
import { poolColumnCount } from "./poolModel";
import { __resetClipsFeedForTests } from "./useClipsFeed";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";

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
    for (const label of ["八维筛选", "排除普通疑似废片", "只看 Stack 首选", "竖屏"]) {
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
    fireEvent.change(screen.getByRole("combobox", { name: /八维筛选/ }), {
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
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
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
