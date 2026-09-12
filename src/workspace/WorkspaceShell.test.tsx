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
import { WorkspaceShell, autoCollapseFor, bandMinHeight } from "./WorkspaceShell";
import { bandMinHeight as modelBandMinHeight } from "./shotBandModel";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";
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
    expect(getWorkspaceSnapshot().inspectorCollapsed).toBe(true);
    expect(getWorkspaceSnapshot().poolCollapsed).toBe(false);

    resizeTo(900);
    expect(getWorkspaceSnapshot().poolCollapsed).toBe(true);
    // 中栏没有「折叠」这一档 —— store 里根本没有它的开关。
    expect(screen.getByRole("region", { name: "预览监视器" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "镜头带" })).toBeTruthy();
  });

  it("挂载在窄窗上时当场就按顺序折,不用等一次 resize", () => {
    resizeTo(900);
    __resetWorkspaceForTests();
    render(<WorkspaceShell />);
    expect(getWorkspaceSnapshot().poolCollapsed).toBe(true);
    expect(getWorkspaceSnapshot().inspectorCollapsed).toBe(true);
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
