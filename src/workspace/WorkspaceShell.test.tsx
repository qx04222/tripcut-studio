// @vitest-environment jsdom
import { act } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";

// 三个模态懒加载的探针:模块顶层代码只有在 dynamic import() 真正触发时才跑,
// 首屏(什么都没打开)一次都不该碰它。
// 整份 api 替身由 `./testApiMock` 从 `src/api.ts` 的真实导出表生成 —— 挂壳会把
// 状态条/集切换/媒体池/镜头带/检查器的 effect 全部拉起来,少一条就是一串
// unhandled rejection。
const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMocks);

const deliverModuleFlag = vi.hoisted(() => ({ loaded: false }));
vi.mock("./DeliverDrawer", () => {
  deliverModuleFlag.loaded = true;
  return { DeliverDrawer: () => null };
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WorkspaceShell, autoCollapseFor, autoCollapseTransition, bandMinHeight } from "./WorkspaceShell";
import { bandMinHeight as modelBandMinHeight } from "./shotBandModel";
import {
  __resetWorkspaceForTests,
  dispatchWorkspace,
  getWorkspaceSnapshot,
  isPaneCollapsed,
  persistedPairs,
  workspaceReducer,
} from "./WorkspaceStore";
import { __resetClipsFeedForTests } from "./useClipsFeed";
import type { ClipListItem } from "../api";

/** 挂壳用的最小素材夹具(字段齐全,不走 as unknown)。 */
function shellClip(id: number): ClipListItem {
  return {
    id, episode_id: 1, folder_label: null, cover_url: null, path: `/Volumes/CARD/clip-${id}.mov`,
    file_name: `clip-${id}.mov`, byte_size: 2048, quick_hash: null, full_hash: null, tb_num: 1, tb_den: 1000,
    duration_ticks: 12_000, fps_num: 25, fps_den: 1, is_vfr: false, codec: "h264", width: 1920, height: 1080,
    captured_at: null, status: "ready", error: null, analysis: null, analysis_status: null, analysis_error: null,
    motion: null, motion_status: null, motion_error: null, binary_rating: null, star_rating: null, select_count: 0,
  };
}

function deliverModuleLoaded(): boolean {
  return deliverModuleFlag.loaded;
}

const WORKSPACE_CSS = readFileSync(resolve(process.cwd(), "src/styles/workspace.css"), "utf8");
// R9 主屏 chrome(顶栏 / 栏标题条 / 分隔条 / 状态条)的样式单独放在 chrome.css,由
// workspace.css 尾部一条 @import 挂进来 —— 断言分开读:令牌仍在 workspace.css,视觉在 chrome.css。
const CHROME_CSS = readFileSync(resolve(process.cwd(), "src/styles/workspace/chrome.css"), "utf8");

/** 改窗宽并把 resize 事件发出去 —— jsdom 不会因为改了 innerWidth 自己派发。 */
function resizeTo(width: number, height = 900): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true, writable: true });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

beforeEach(() => {
  resizeTo(1440);
  __resetWorkspaceForTests();
});
// 本仓没开 vitest globals,testing-library 的自动 cleanup 因此不会注册 ——
// 不手动清,同一文件里的上一次 render 会留在 document 上,把 getByRole 撞成「找到多个」。
afterEach(cleanup);

describe("工作区骨架", () => {
  it("五个 landmark 的 AX 名一字不差且同屏并存(冒烟 workspace.panes.* 的依据)", () => {
    render(<WorkspaceShell />);
    for (const name of ["媒体池", "预览监视器", "镜头带", "检查器", "后台状态"]) {
      expect(screen.getByRole(name === "后台状态" ? "status" : "region", { name })).toBeTruthy();
    }
  });
  it("顶栏三个按钮的 AX 名一字不差,且没有四步导航", () => {
    render(<WorkspaceShell />);
    expect(screen.getByRole("button", { name: "导入素材" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "生成交付包" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "设置" })).toBeTruthy();
    expect(screen.queryByText("01 导入 INGEST")).toBeNull();
    expect(screen.queryByText(/INGEST|ROUGH CUT|LOCAL-FIRST/)).toBeNull();
  });
  it("两条分隔条是 ARIA separator 且带 aria-valuenow", () => {
    render(<WorkspaceShell />);
    const separators = screen.getAllByRole("separator");
    expect(separators.length).toBeGreaterThanOrEqual(3); // 左、右、中栏上下
    for (const sep of separators) expect(sep.getAttribute("aria-valuenow")).not.toBeNull();
  });
  it("收缩顺序:先检查器,再媒体池,中栏永不折", () => {
    expect(autoCollapseFor(1400)).toEqual({ pool: false, inspector: false });
    expect(autoCollapseFor(1160)).toEqual({ pool: false, inspector: true });
    expect(autoCollapseFor(900)).toEqual({ pool: true, inspector: true });
  });
  it("U-04:检查器阈值 1400——1399 折、1400 恢复;1512 与 1704 都不折", () => {
    expect(autoCollapseFor(1399).inspector).toBe(true);
    expect(autoCollapseFor(1280).inspector).toBe(true);
    expect(autoCollapseFor(1400).inspector).toBe(false);
    expect(autoCollapseFor(1512).inspector).toBe(false);
    expect(autoCollapseFor(1704).inspector).toBe(false);
  });
  it("折叠后剩 44px 竖条,带「展开检查器」按钮", () => {
    __resetWorkspaceForTests({ inspectorCollapsed: true });
    render(<WorkspaceShell />);
    expect(screen.getByRole("button", { name: "展开检查器" })).toBeTruthy();
  });
  it("变窄先折检查器,再折媒体池,中栏永不折", () => {
    render(<WorkspaceShell />);
    expect(getWorkspaceSnapshot().inspectorCollapsed).toBe(false);
    expect(getWorkspaceSnapshot().poolCollapsed).toBe(false);

    resizeTo(1160);
    expect(isPaneCollapsed(getWorkspaceSnapshot(), "inspector")).toBe(true);
    expect(isPaneCollapsed(getWorkspaceSnapshot(), "pool")).toBe(false);

    resizeTo(900);
    expect(isPaneCollapsed(getWorkspaceSnapshot(), "pool")).toBe(true);
    // 中栏没有「折叠」这一档 —— store 里根本没有它的开关。
    expect(screen.getByRole("region", { name: "预览监视器" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "镜头带" })).toBeTruthy();
  });

  it("挂载在窄窗上时当场就按顺序折,不用等一次 resize", () => {
    resizeTo(900);
    __resetWorkspaceForTests();
    render(<WorkspaceShell />);
    expect(isPaneCollapsed(getWorkspaceSnapshot(), "pool")).toBe(true);
    expect(isPaneCollapsed(getWorkspaceSnapshot(), "inspector")).toBe(true);
    // 自动折叠不是用户偏好:手动位不动,也就不会被落盘。
    expect(getWorkspaceSnapshot().poolCollapsed).toBe(false);
    expect(getWorkspaceSnapshot().inspectorCollapsed).toBe(false);
  });

  it("折叠竖条宽 44px,带图标与「展开检查器」/「展开媒体池」按钮", () => {
    __resetWorkspaceForTests({ poolCollapsed: true, inspectorCollapsed: true });
    render(<WorkspaceShell />);
    for (const name of ["展开媒体池", "展开检查器"]) {
      const button = screen.getByRole("button", { name });
      expect(button.closest(".workspace-rail")).not.toBeNull();
      // 图标只给眼睛看,AX 名里一个字都不许多出来。
      expect(button.querySelector(".workspace-rail-icon")?.getAttribute("aria-hidden")).toBe("true");
      expect(button.textContent).toContain(name);
    }
    expect(WORKSPACE_CSS).toContain("--workspace-rail-width: 44px");
  });

  it("中栏 min 520,竖条 44 —— 壳的 min-width 不能超过这条收缩线算出来的地板", () => {
    // 两侧都折起来时 44 + 520 + 44 = 608。min-width 若还写 1280,窄窗照样出横向滚动条。
    const match = /\.workspace-shell\s*\{[^}]*min-width:\s*(\d+)px/.exec(WORKSPACE_CSS);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeLessThanOrEqual(608);
  });

  it("栏内各自滚动,整窗不出现纵向滚动条", () => {
    expect(/\.workspace-shell\s*\{[^}]*overflow:\s*hidden/.test(WORKSPACE_CSS)).toBe(true);
    expect(/\.workspace-pane\s*\{[^}]*overflow:\s*auto/.test(WORKSPACE_CSS)).toBe(true);
  });

  it("镜头带栏 min 高来自 shotBandModel(故事 184 = 内容高,附属 284),壳不再自己算一份", () => {
    expect(bandMinHeight("story")).toBe(184);
    for (const mode of ["music", "journey", "destination", "template"] as const) {
      expect(bandMinHeight(mode)).toBe(284);
    }
    expect(bandMinHeight).toBe(modelBandMinHeight);
  });

  it("三个模态都是懒加载:首屏渲染不 import 它们", () => {
    render(<WorkspaceShell />);
    expect(deliverModuleLoaded()).toBe(false);
  });
});

describe("U-04 检查器折叠状态机:自动折叠与手动折叠分开", () => {
  const inspectorVisible = () => screen.queryByRole("region", { name: "检查器" }) !== null;
  const railVisible = () => screen.queryByRole("button", { name: "展开检查器" }) !== null;
  /** 走查里的「展开」:竖条在就点它;检查器已经在了就什么都不做(不是 toggle)。 */
  const expandIfRail = () => {
    const rail = screen.queryByRole("button", { name: "展开检查器" });
    if (rail) act(() => rail.click());
  };

  it("跨阈值才派发:1512→1280 折、1280→1200 不再派发、→1704 恢复、挂载一次到位", () => {
    expect(autoCollapseTransition(null, 1280)).toEqual({ pool: false, inspector: true });
    expect(autoCollapseTransition(1512, 1280)).toEqual({ inspector: true });
    expect(autoCollapseTransition(1280, 1200)).toBeNull();
    expect(autoCollapseTransition(1200, 1704)).toEqual({ inspector: false });
    expect(autoCollapseTransition(1704, 1512)).toBeNull();
    expect(autoCollapseTransition(1200, 900)).toEqual({ pool: true });
  });

  it("自动折叠不落盘:set-auto-collapse 一对 ui.* 键值都不产出;手动折叠才落", () => {
    const base = getWorkspaceSnapshot();
    const auto = workspaceReducer(base, { type: "set-auto-collapse", inspector: true });
    expect(persistedPairs(base, auto)).toEqual([]);
    const manual = workspaceReducer(base, { type: "toggle-pane", pane: "inspector" });
    expect(persistedPairs(base, manual)).toEqual([["ui.pane.inspector_collapsed", "true"]]);
  });

  it("走查序列 1512→1280→1704→展开→1512:检查器每一步该在就在,末了仍可见且是整栏 Panel", () => {
    resizeTo(1512);
    render(<WorkspaceShell />);
    expect(inspectorVisible()).toBe(true);

    resizeTo(1280);
    expect(railVisible()).toBe(true);
    expect(inspectorVisible()).toBe(false);

    resizeTo(1704);
    // 放大就自动展开——不用等用户点竖条(走查 75 那张图里它没展开)。
    expect(inspectorVisible()).toBe(true);
    expect(railVisible()).toBe(false);

    expandIfRail();
    resizeTo(1512);
    expect(inspectorVisible()).toBe(true);
    expect(railVisible()).toBe(false);
    // 整栏是自己的 Panel(id 不同于竖条),minSize 280 不是竖条的 44——真机上「整个消失」
    // 正是同一个 Panel 实例带着 44px 改成 min 280 + collapsible 后被库塌成 0。
    const pane = document.getElementById("inspector-pane");
    expect(pane).not.toBeNull();
    expect(document.getElementById("inspector-rail")).toBeNull();
    expect(pane?.contains(screen.getByRole("region", { name: "检查器" }))).toBe(true);
    // 用户全程没折过:手动位从头到尾是 false。
    expect(getWorkspaceSnapshot().inspectorCollapsed).toBe(false);
  });

  it("窄窗里手动展开后:再拖窗口(仍窄)不重新折;放大再缩回才重新折", () => {
    resizeTo(1280);
    render(<WorkspaceShell />);
    expect(railVisible()).toBe(true);

    expandIfRail();
    expect(inspectorVisible()).toBe(true);
    resizeTo(1200);
    expect(inspectorVisible()).toBe(true);
    resizeTo(1704);
    expect(inspectorVisible()).toBe(true);
    resizeTo(1280);
    expect(railVisible()).toBe(true);
  });

  it("手动折叠是用户偏好:窗口放大不会替用户展开", () => {
    resizeTo(1512);
    render(<WorkspaceShell />);
    act(() => dispatchWorkspace({ type: "toggle-pane", pane: "inspector" }));
    expect(railVisible()).toBe(true);
    resizeTo(1704);
    expect(railVisible()).toBe(true);
    expect(getWorkspaceSnapshot().inspectorCollapsed).toBe(true);
  });

  it("⌘2 在自动折叠状态下也能把检查器找回来", () => {
    resizeTo(1280);
    render(<WorkspaceShell />);
    expect(railVisible()).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", code: "Digit2", metaKey: true, bubbles: true }));
    });
    expect(inspectorVisible()).toBe(true);
    // 再按一次是手动折叠。
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", code: "Digit2", metaKey: true, bubbles: true }));
    });
    expect(railVisible()).toBe(true);
    expect(getWorkspaceSnapshot().inspectorCollapsed).toBe(true);
  });
});

describe("旧 hash 转接完就收回 #/(L5)", () => {
  for (const hash of ["#/import", "#/deliver", "#/settings", "#/review"]) {
    it(`${hash} 转接后地址栏回到 #/,刷新不会再把抽屉弹开`, () => {
      window.history.replaceState(null, "", hash);
      render(<WorkspaceShell />);
      expect(window.location.hash).toBe("#/");
    });
  }

  it("#/deliver 先把交付抽屉打开,再收回 hash(收 hash 不等于吞掉动作)", () => {
    window.history.replaceState(null, "", "#/deliver");
    render(<WorkspaceShell />);
    expect(getWorkspaceSnapshot().openDrawer).toBe("deliver");
    expect(window.location.hash).toBe("#/");
  });

  it("不认识的 hash 一个字都不动", () => {
    window.history.replaceState(null, "", "#/whatever");
    render(<WorkspaceShell />);
    expect(window.location.hash).toBe("#/whatever");
  });
});

describe("历史集只读查看落进新壳(L6)", () => {
  it("tripcut:view-episode 把 store 的 viewingEpisode 设上,媒体池把范围收到该集", async () => {
    render(<WorkspaceShell />);
    expect(getWorkspaceSnapshot().viewingEpisode).toBeNull();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("tripcut:view-episode", { detail: { id: 7, title: "EP00" } }),
      );
      await Promise.resolve();
    });

    expect(getWorkspaceSnapshot().viewingEpisode).toEqual({ id: 7, title: "EP00" });
    const pool = screen.getByRole("region", { name: "媒体池" });
    expect(pool.textContent).toContain("只读查看「EP00」");
  });

  /** N-2:只读查看的横幅上有「回到当前集」;回去时不属于当前集的选中一并清掉。 */
  it("横幅「回到当前集」解除只读查看,历史集里的选中不带回当前集", async () => {
    __resetClipsFeedForTests();
    apiMocks.getClipsRevision.mockResolvedValue("rev-n2" as never);
    apiMocks.getCurrentEpisode.mockResolvedValue({ id: 2, title: "EP01", status: "active" } as never);
    apiMocks.listClips.mockResolvedValue([{ ...shellClip(7), episode_id: 1 }, { ...shellClip(8), episode_id: 2 }]);
    apiMocks.getAiDescription.mockResolvedValue(null);
    __resetWorkspaceForTests({ viewingEpisode: { id: 1, title: "EP00" }, selection: { kind: "clip", clipId: 7 } });
    render(<WorkspaceShell />);
    await screen.findAllByRole("gridcell");
    const pool = screen.getByRole("region", { name: "媒体池" });
    expect(pool.textContent).toContain("只读查看「EP00」");

    await act(async () => {
      screen.getByRole("button", { name: "回到当前集" }).click();
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(getWorkspaceSnapshot().viewingEpisode).toBeNull();
    expect(getWorkspaceSnapshot().selection).toBeNull();
    expect(screen.getByRole("region", { name: "媒体池" }).textContent).not.toContain("只读查看");
    apiMocks.getCurrentEpisode.mockReset();
  });

  it("换当前集(tripcut:episode-changed)把只读查看解除", async () => {
    __resetWorkspaceForTests({ viewingEpisode: { id: 7, title: "EP00" } });
    render(<WorkspaceShell />);
    expect(screen.getByRole("region", { name: "媒体池" }).textContent).toContain("只读查看");

    await act(async () => {
      window.dispatchEvent(new CustomEvent("tripcut:episode-changed", { detail: { id: 9, title: "EP02" } }));
      await Promise.resolve();
    });
    expect(getWorkspaceSnapshot().viewingEpisode).toBeNull();
    expect(screen.getByRole("region", { name: "媒体池" }).textContent).not.toContain("只读查看");
  });
});

describe("R-06:换集清选中", () => {
  it("新建集后原选中的素材不在新集里 → 监视器 / 检查器的选中清掉;同一集的事件(重命名)不清", async () => {
    apiMocks.getClipsRevision.mockResolvedValue("rev-6" as never);
    apiMocks.listClips.mockResolvedValue([shellClip(3)]);
    apiMocks.getAiDescription.mockResolvedValue(null);
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 3 }, anchorClipId: 3, multiSelection: [3] });
    render(<WorkspaceShell />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent("tripcut:episode-changed", { detail: { id: 1, title: "EP01 改名" } }));
      await Promise.resolve();
    });
    expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 3 });

    await act(async () => {
      window.dispatchEvent(new CustomEvent("tripcut:episode-changed", { detail: { id: 2, title: "第二集" } }));
      await Promise.resolve();
    });
    expect(getWorkspaceSnapshot().selection).toBeNull();
    expect(getWorkspaceSnapshot().multiSelection).toEqual([]);
    expect(screen.getByRole("region", { name: "预览监视器" }).textContent).toContain("从左侧媒体池选一条素材");
  });
});

describe("R9 主屏 chrome(Task 2)", () => {
  it("顶栏三个按钮是套件按钮:导入素材 secondary、生成交付包 primary、设置 icon,都带图标", () => {
    render(<WorkspaceShell />);
    const importButton = screen.getByRole("button", { name: "导入素材" });
    expect(importButton.className).toContain("ui-button--secondary");
    expect(importButton.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "生成交付包" }).className).toContain("ui-button--primary");
    expect(screen.getByRole("button", { name: "设置" }).className).toContain("ui-button--icon");
    expect(screen.getByRole("button", { name: "切换集" }).querySelector("svg")).not.toBeNull();
  });
  it("顶栏带 C 稿的键位提示:导入 ⌘I、交付 ⌘⏎、命令面板 ⌘K 都是 <kbd>,且不进 AX 名", () => {
    render(<WorkspaceShell />);
    const topbar = document.querySelector(".workspace-topbar");
    expect(topbar).not.toBeNull();
    const keys = [...(topbar as HTMLElement).querySelectorAll("kbd.ui-kbd")].map((node) => node.textContent);
    expect(keys).toEqual(expect.arrayContaining(["⌘I", "⌘⏎", "⌘K"]));
    // 键位是视觉提示,不能混进冻结的按钮名(冒烟按名找控件)。
    expect(screen.getByRole("button", { name: "导入素材" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "生成交付包" })).toBeTruthy();
  });
  it("栏标题条不是 heading,栏标题 + meta 都在", () => {
    render(<WorkspaceShell />);
    const pool = screen.getByRole("region", { name: "媒体池" });
    expect(within(pool).queryByRole("heading")).toBeNull();
    expect(within(pool).getByText("媒体池").className).toContain("ui-section-header-title");
  });
  it("chrome.css 由 workspace.css 一条 @import 挂进来(在所有规则之前,否则 postcss 会丢掉),且不含颜色字面量", () => {
    const imports = WORKSPACE_CSS.match(/^@import "\.\/workspace\/chrome\.css";$/gm) ?? [];
    expect(imports).toHaveLength(1);
    const firstRule = WORKSPACE_CSS.search(/^[.:#][^\n]*\{$/m);
    expect(WORKSPACE_CSS.indexOf('@import "./workspace/chrome.css";')).toBeLessThan(firstRule);
    expect(/#[0-9a-fA-F]{3,8}\b/.test(CHROME_CSS)).toBe(false);
    expect(/\.workspace-topbar\s*\{[^}]*box-shadow:\s*var\(--shadow-card\)/.test(CHROME_CSS)).toBe(true);
    // 顶部 @import 意味着声明顺序输给 workspace.css:每条规则都得靠 .workspace-shell 前缀抬特异性。
    for (const line of CHROME_CSS.split("\n")) {
      if (/^\.workspace-(?!shell )/.test(line)) throw new Error(`chrome.css 选择器缺 .workspace-shell 前缀: ${line}`);
    }
  });
  it("三条分隔条各有一个可见抓手,宽 6px 由令牌控制", () => {
    render(<WorkspaceShell />);
    const separators = screen.getAllByRole("separator");
    expect(separators).toHaveLength(3);
    for (const sep of separators) {
      expect(sep.querySelector(".workspace-handle-grip")).not.toBeNull();
      expect(sep.querySelector(".workspace-handle-grip")?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(WORKSPACE_CSS).toMatch(/--workspace-handle-size:\s*6px/);
    expect(WORKSPACE_CSS).toMatch(/\.workspace-handle:hover[^{]*\{[^}]*--accent/);
    expect(CHROME_CSS).toMatch(/\.workspace-handle:hover \.workspace-handle-grip[^{]*\{[^}]*var\(--accent\)/);
  });
  it("非空池时主屏只有一个「导入素材」按钮(顶栏)", async () => {
    // 空池的 EmptyState 也有一颗同名「导入素材」(emptyStates.tsx),所以这里要喂一条素材:
    // 断言的是"非空池不渲染第二颗",不是"池子本来就空"。
    __resetClipsFeedForTests();
    apiMocks.getClipsRevision.mockResolvedValue("rev-1" as never);
    apiMocks.listClips.mockResolvedValue([shellClip(1)]);
    render(<WorkspaceShell />);
    await screen.findAllByRole("gridcell");
    expect(screen.getAllByRole("button", { name: "导入素材" })).toHaveLength(1);
  });
});

describe("R10 U-23:启动恢复选中", () => {
  it("clips feed 落地后,restoreClipId 那条还在就选中它;之后不再重复恢复", async () => {
    __resetClipsFeedForTests();
    apiMocks.getClipsRevision.mockResolvedValue("rev-7" as never);
    apiMocks.listClips.mockResolvedValue([shellClip(7), shellClip(8)]);
    // 选中后检查器会挂起来拉 AI 描述;通用替身默认 resolve undefined,那里按 null 处理才不炸。
    apiMocks.getAiDescription.mockResolvedValue(null);
    __resetWorkspaceForTests({ restoreClipId: 7 });
    render(<WorkspaceShell />);
    await screen.findAllByRole("gridcell");
    await act(async () => {
      await Promise.resolve();
    });
    expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 7 });
    expect(getWorkspaceSnapshot().restoreClipId).toBeNull();
  });

  /**
   * N-1:「新建集」之后重启,上次的选中是已封存集里的素材。clipsById 是未按集裁的全量表,
   * 那条素材「还在库里」,但不在当前集 —— 恢复路径也得按活动集校验,不能让空的新集
   * 监视器 / 检查器停在旧集素材上。
   */
  it("那条素材属于已封存的集:不恢复,新集保持未选择", async () => {
    __resetClipsFeedForTests();
    apiMocks.getClipsRevision.mockResolvedValue("rev-9" as never);
    apiMocks.getCurrentEpisode.mockResolvedValue({ id: 2, title: "第二集", status: "active" } as never);
    apiMocks.listClips.mockResolvedValue([{ ...shellClip(7), episode_id: 1 }, { ...shellClip(8), episode_id: 2 }]);
    __resetWorkspaceForTests({ restoreClipId: 7 });
    render(<WorkspaceShell />);
    await screen.findAllByRole("gridcell");
    await act(async () => {
      await Promise.resolve();
    });
    expect(getWorkspaceSnapshot().selection).toBeNull();
    expect(getWorkspaceSnapshot().restoreClipId).toBeNull();
    // 这个文件不 reset mock:当前集的桩要还回去,后面的用例按 episode_id=1 裁池。
    apiMocks.getCurrentEpisode.mockReset();
  });

  it("那条已经不在库里:静默放弃,选中保持未选择", async () => {
    __resetClipsFeedForTests();
    apiMocks.getClipsRevision.mockResolvedValue("rev-8" as never);
    apiMocks.listClips.mockResolvedValue([shellClip(8)]);
    __resetWorkspaceForTests({ restoreClipId: 99 });
    render(<WorkspaceShell />);
    await screen.findAllByRole("gridcell");
    await act(async () => {
      await Promise.resolve();
    });
    expect(getWorkspaceSnapshot().selection).toBeNull();
    expect(getWorkspaceSnapshot().restoreClipId).toBeNull();
  });
});

describe("R10 U-19 音乐分析事件桥", () => {
  it("壳挂载时调一次 bridgeMusicAnalyzedEvents,卸载时调它返回的解除函数", () => {
    const unlisten = vi.fn();
    apiMocks.bridgeMusicAnalyzedEvents.mockClear();
    apiMocks.bridgeMusicAnalyzedEvents.mockResolvedValue(unlisten);
    const view = render(<WorkspaceShell />);
    expect(apiMocks.bridgeMusicAnalyzedEvents).toHaveBeenCalledTimes(1);
    view.rerender(<WorkspaceShell />);
    expect(apiMocks.bridgeMusicAnalyzedEvents).toHaveBeenCalledTimes(1);
    return act(async () => {
      await Promise.resolve();
      view.unmount();
      await Promise.resolve();
      expect(unlisten).toHaveBeenCalledTimes(1);
    });
  });
});

describe("R11 简化专项 #4:每屏一个主动作", () => {
  it("选中一条素材后:顶栏 / 媒体池 / 预览监视器 / 镜头带 / 检查器 各自最多一个 primary 按钮", async () => {
    apiMocks.getClipsRevision.mockResolvedValue("rev-primary" as never);
    apiMocks.listClips.mockResolvedValue([shellClip(3)]);
    apiMocks.getAiDescription.mockResolvedValue(null);
    apiMocks.playerOpen.mockResolvedValue({ state: "ready", pos: 0, duration: 12, paused: true, speed: 1 } as never);
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 3 }, anchorClipId: 3, multiSelection: [3] });
    render(<WorkspaceShell />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const surfaces: [string, HTMLElement][] = [
      ["顶栏", document.querySelector<HTMLElement>(".workspace-topbar")!],
      ["媒体池", screen.getByRole("region", { name: "媒体池" })],
      ["预览监视器", screen.getByRole("region", { name: "预览监视器" })],
      ["镜头带", screen.getByRole("region", { name: "镜头带" })],
      ["检查器", screen.getByRole("region", { name: "检查器" })],
    ];
    const counts = surfaces.map(([name, node]) => [name, node.querySelectorAll(".ui-button--primary").length] as const);
    for (const [name, count] of counts) expect(count, `${name} 有 ${count} 个 primary`).toBeLessThanOrEqual(1);
    expect(counts.find(([name]) => name === "顶栏")![1]).toBe(1);
  });
});
