// @vitest-environment jsdom
import { act } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

import { existsSync, readFileSync } from "node:fs";
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
import { __setShowAllFeaturesForTests } from "./showAllFeatures";
import { reportLibraryState } from "./homeStore";

/** 挂壳用的最小素材夹具(字段齐全,不走 as unknown)。 */
function shellClip(id: number): ClipListItem {
  return {
    kind: "video", id, episode_id: 1, folder_label: null, cover_url: null, path: `/Volumes/CARD/clip-${id}.mov`,
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
  // R19 P-05:这份文件描述的是「显示全部功能」打开后的形态(旅程 / 地点卡 / 模板 / 技术检查 / 快捷键 / 性能 / 云端补镜都在);默认态在 showAllFeaturesR19.test。
  __setShowAllFeaturesForTests(true);
  resizeTo(1440);
  __resetWorkspaceForTests();
});
// 本仓没开 vitest globals,testing-library 的自动 cleanup 因此不会注册 ——
// 不手动清,同一文件里的上一次 render 会留在 document 上,把 getByRole 撞成「找到多个」。
afterEach(cleanup);

describe("工作区骨架", () => {
  it("照片模式 F6 只聚焦三个真实栏，切回视频后重新绑定镜头带 ResizeObserver", () => {
    const observed: Element[] = [];
    const Original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { observe(node: Element) { observed.push(node); } unobserve() {} disconnect() {} };
    try {
      render(<WorkspaceShell />);
      act(() => reportLibraryState({ loading: false, clipCount: 3 }));
      fireEvent.click(screen.getByRole("tab", { name: "照片工作台" }));
      for (const name of ["照片静态检视", "照片精选带", "照片网格"] as const) {
        act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "F6", code: "F6", bubbles: true })));
        expect(document.activeElement?.getAttribute("aria-label")).toBe(name);
      }
      fireEvent.click(screen.getByRole("tab", { name: "视频工作台" }));
      expect(observed.filter((node) => node.classList.contains("workspace-band-fit")).length).toBe(2);
    } finally { globalThis.ResizeObserver = Original; }
  });
  it("五个 landmark 的 AX 名一字不差且同屏并存(冒烟 workspace.panes.* 的依据)", () => {
    render(<WorkspaceShell />);
    for (const name of ["媒体池", "预览监视器", "镜头带", "检查器", "后台状态"]) {
      expect(screen.getByRole(name === "后台状态" ? "status" : "region", { name })).toBeTruthy();
    }
  });
  it("顶栏三个按钮的 AX 名一字不差,且没有英文 kicker 式的旧四页导航", () => {
    render(<WorkspaceShell />);
    expect(screen.getByRole("button", { name: "导入素材" })).toBeTruthy();
    // R12:主按钮 AX 名迁为「流水线下一步」,空库时可见文案「下一步:导入素材」。
    expect(screen.getByRole("button", { name: "流水线下一步" }).textContent).toBe("下一步:导入素材");
    expect(screen.queryByRole("button", { name: "生成交付包" })).toBeNull();
    expect(screen.getByRole("button", { name: "设置" })).toBeTruthy();
    expect(screen.queryByText("01 导入 INGEST")).toBeNull();
    expect(screen.queryByText(/INGEST|ROUGH CUT|LOCAL-FIRST/)).toBeNull();
  });
  it("两条分隔条是 ARIA separator 且带 aria-valuenow", () => {
    render(<WorkspaceShell />);
    const separators = screen.getAllByRole("separator");
    expect(separators.length).toBeGreaterThanOrEqual(2); // 池 | 中栏,上层 / 带(R19 起检查器不是 Panel,没有第三条)
    for (const sep of separators) expect(sep.getAttribute("aria-valuenow")).not.toBeNull();
  });
  it("收缩:只剩媒体池一档(<1040),中栏永不折;检查器 R19 起是滑出层,不参与收缩", () => {
    expect(autoCollapseFor(1400)).toEqual({ pool: false });
    expect(autoCollapseFor(1160)).toEqual({ pool: false });
    expect(autoCollapseFor(900)).toEqual({ pool: true });
    // 旧的 1400 阈值与竖条一起删了(V-04):1399 / 1280 都不再折任何东西。
    expect(autoCollapseFor(1399)).toEqual({ pool: false });
    expect(autoCollapseFor(1280)).toEqual({ pool: false });
  });
  it("变窄不再折检查器(它不占横向空间),1040 以下折媒体池,中栏永不折", () => {
    render(<WorkspaceShell />);
    expect(getWorkspaceSnapshot().poolCollapsed).toBe(false);

    resizeTo(1160);
    expect(isPaneCollapsed(getWorkspaceSnapshot(), "pool")).toBe(false);
    expect(screen.getByRole("region", { name: "检查器" })).toBeTruthy();

    resizeTo(900);
    expect(isPaneCollapsed(getWorkspaceSnapshot(), "pool")).toBe(true);
    // 中栏没有「折叠」这一档 —— store 里根本没有它的开关。
    expect(screen.getByRole("region", { name: "预览监视器" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "镜头带" })).toBeTruthy();
  });

  it("挂载在窄窗上时当场就折媒体池,不用等一次 resize", () => {
    resizeTo(900);
    __resetWorkspaceForTests();
    render(<WorkspaceShell />);
    expect(isPaneCollapsed(getWorkspaceSnapshot(), "pool")).toBe(true);
    // 自动折叠不是用户偏好:手动位不动,也就不会被落盘。
    expect(getWorkspaceSnapshot().poolCollapsed).toBe(false);
  });

  it("折叠竖条宽 44px,带图标与「展开媒体池」按钮(检查器没有竖条了)", () => {
    __resetWorkspaceForTests({ poolCollapsed: true });
    render(<WorkspaceShell />);
    expect(screen.queryByRole("button", { name: "展开检查器" })).toBeNull();
    for (const name of ["展开媒体池"]) {
      const button = screen.getByRole("button", { name });
      expect(button.closest(".workspace-rail")).not.toBeNull();
      // 图标只给眼睛看,AX 名里一个字都不许多出来。
      expect(button.querySelector(".workspace-rail-icon")?.getAttribute("aria-hidden")).toBe("true");
      // R18 V-22:可见文字缩成栏名本身(40px 竖条里横排排得下「检查器」三个字),
      // 「展开…」这句话搬进 aria-label 与 tooltip —— AX 名一字不变,断言随之迁移。
      expect(button.getAttribute("aria-label")).toBe(name);
      expect(name).toContain(button.querySelector(".workspace-rail-label")?.textContent ?? "");
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

  it("镜头带栏 min 高来自 shotBandModel(故事 166 = 内容高,附属 266;R19 V-06 瓦片 112 高),壳不再自己算一份", () => {
    expect(bandMinHeight("story")).toBe(166);
    for (const mode of ["music", "journey", "destination", "template"] as const) {
      expect(bandMinHeight(mode)).toBe(266);
    }
    expect(bandMinHeight).toBe(modelBandMinHeight);
  });

  it("三个模态都是懒加载:首屏渲染不 import 它们", () => {
    render(<WorkspaceShell />);
    expect(deliverModuleLoaded()).toBe(false);
  });
});

describe("R19 shell · V-04 检查器滑出层(取代 U-04 折叠状态机)", () => {
  // 选中后检查器会挂起来拉 AI 描述;通用替身默认 resolve undefined,那里按 null 处理才不炸。
  beforeEach(() => apiMocks.getAiDescription.mockResolvedValue(null));
  const layer = () => screen.getByRole("region", { name: "检查器" });
  const isOpen = () => layer().classList.contains("is-open");
  const press = (init: KeyboardEventInit) => act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });

  it("跨阈值才派发(只剩媒体池):1512→1280 不派发、→900 折池、挂载一次到位", () => {
    expect(autoCollapseTransition(null, 1280)).toEqual({ pool: false });
    expect(autoCollapseTransition(1512, 1280)).toBeNull();
    expect(autoCollapseTransition(1280, 1200)).toBeNull();
    expect(autoCollapseTransition(1200, 900)).toEqual({ pool: true });
    expect(autoCollapseTransition(900, 1704)).toEqual({ pool: false });
  });

  it("自动折叠不落盘;📌 钉住是偏好(ui.inspector.pinned),收起是会话态(不落盘)", () => {
    const base = getWorkspaceSnapshot();
    const auto = workspaceReducer(base, { type: "set-auto-collapse", pool: true });
    expect(persistedPairs(base, auto)).toEqual([]);
    const pinned = workspaceReducer(base, { type: "set-inspector-pinned", pinned: true });
    expect(persistedPairs(base, pinned)).toEqual([["ui.inspector.pinned", "true"]]);
    const withSelection = { ...base, selection: { kind: "clip" as const, clipId: 3 } };
    const dismissed = workspaceReducer(withSelection, { type: "toggle-pane", pane: "inspector" });
    expect(dismissed.inspectorDismissed).toBe(true);
    expect(persistedPairs(withSelection, dismissed)).toEqual([]);
  });

  it("层挂在中栏里、不是 Panel:上层只有 池 / 中栏 两个 Panel,没有 inspector-pane / inspector-rail,也没有「调整检查器宽度」", () => {
    render(<WorkspaceShell />);
    const center = document.querySelector<HTMLElement>(".workspace-center")!;
    expect(center.contains(layer())).toBe(true);
    expect(layer().closest("[data-panel]")).toBe(center.closest("[data-panel]")); // 同一个 Panel(中栏)里,不是自己的 Panel
    expect(document.querySelectorAll(".workspace-upper-row > [data-panel]")).toHaveLength(2);
    expect(document.getElementById("inspector-pane")).toBeNull();
    expect(document.getElementById("inspector-rail")).toBeNull();
    expect(screen.queryByRole("separator", { name: "调整检查器宽度" })).toBeNull();
  });

  it("无选中时 region「检查器」在(冒烟锚点)但收着、没有内容;选中即出(is-open + 内容);Esc 收;再选中又出", () => {
    render(<WorkspaceShell />);
    expect(isOpen()).toBe(false);
    expect(layer().querySelector(".inspector")).toBeNull();

    act(() => dispatchWorkspace({ type: "select-clip", clipId: 3 }));
    expect(isOpen()).toBe(true);
    expect(layer().querySelector(".inspector")).not.toBeNull();

    press({ key: "Escape", code: "Escape" });
    expect(isOpen()).toBe(false);
    expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 3 }); // 收层不清选中
    expect(layer().querySelector(".inspector")).toBeNull();

    act(() => dispatchWorkspace({ type: "select-clip", clipId: 4 }));
    expect(isOpen()).toBe(true);
  });

  it("点空白收:选中后在监视器栏里(层之外)按下指针 → 收起;在层内按下不收", () => {
    render(<WorkspaceShell />);
    act(() => dispatchWorkspace({ type: "select-clip", clipId: 3 }));
    expect(isOpen()).toBe(true);
    const monitor = screen.getByRole("region", { name: "预览监视器" });
    act(() => {
      monitor.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(isOpen()).toBe(false);
    act(() => dispatchWorkspace({ type: "select-clip", clipId: 3 }));
    act(() => {
      layer().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(isOpen()).toBe(true);
  });

  it("📌 钉住:标题条「钉住检查器」按下 → is-pinned、Esc 不收、清掉选中也常驻;再点取消", () => {
    render(<WorkspaceShell />);
    act(() => dispatchWorkspace({ type: "select-clip", clipId: 3 }));
    const pin = screen.getByRole("button", { name: "钉住检查器" });
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    act(() => pin.click());
    expect(screen.getByRole("button", { name: "钉住检查器" }).getAttribute("aria-pressed")).toBe("true");
    expect(layer().classList.contains("is-pinned")).toBe(true);
    press({ key: "Escape", code: "Escape" });
    expect(isOpen()).toBe(true);
    act(() => dispatchWorkspace({ type: "clear-selection" }));
    expect(isOpen()).toBe(true);
    act(() => screen.getByRole("button", { name: "钉住检查器" }).click());
    expect(layer().classList.contains("is-pinned")).toBe(false);
    expect(isOpen()).toBe(false); // 没选中、没钉住 → 收着
  });

  it("⌘2 收起 / 找回:开着就收;收着且没选中 → 钉住找回(空态常驻);「收起检查器」按钮同义", () => {
    render(<WorkspaceShell />);
    act(() => dispatchWorkspace({ type: "select-clip", clipId: 3 }));
    press({ key: "2", code: "Digit2", metaKey: true });
    expect(isOpen()).toBe(false);
    press({ key: "2", code: "Digit2", metaKey: true });
    expect(isOpen()).toBe(true);
    act(() => screen.getByRole("button", { name: "收起检查器" }).click());
    expect(isOpen()).toBe(false);
    act(() => dispatchWorkspace({ type: "clear-selection" }));
    press({ key: "2", code: "Digit2", metaKey: true });
    expect(isOpen()).toBe(true);
    expect(getWorkspaceSnapshot().inspectorPinned).toBe(true);
  });

  it("旧机制真的删了:没有 InspectorCollapsed 模块与 INSPECTOR_AUTO_COLLAPSE_WIDTH 导出;层的 CSS 是 absolute + 令牌动效", () => {
    expect(existsSync(resolve(process.cwd(), "src/workspace/InspectorCollapsed.tsx"))).toBe(false);
    const shellModule = readFileSync(resolve(process.cwd(), "src/workspace/WorkspaceShell.tsx"), "utf8");
    expect(shellModule).not.toContain("INSPECTOR_AUTO_COLLAPSE_WIDTH");
    const layout = readFileSync(resolve(process.cwd(), "src/workspace/shellLayout.ts"), "utf8");
    expect(layout).not.toContain("INSPECTOR_AUTO_COLLAPSE_WIDTH");
    const css = readFileSync(resolve(process.cwd(), "src/styles/workspace/shell-r19.css"), "utf8");
    expect(css).toMatch(/\.workspace-inspector-layer\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\.workspace-inspector-layer\.is-open\s*\{[^}]*var\(--motion-slow\)/);
    expect(css).toMatch(/\.workspace-inspector-layer\s*\{[^}]*var\(--motion-exit\)/);
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
  it("顶栏三个按钮是套件按钮:导入素材 secondary、流水线下一步 primary(空库时首页盖着,它让位成 secondary)、设置 icon,都带图标", () => {
    render(<WorkspaceShell />);
    const importButton = screen.getByRole("button", { name: "导入素材" });
    expect(importButton.className).toContain("ui-button--secondary");
    expect(importButton.querySelector("svg")).not.toBeNull();
    // R19 V-01:空库 → 首页自动盖上,首页的「开始一个新旅程」是那一颗实心主按钮,顶栏「下一步」降 secondary;
    // 有素材(首页收起)时它是 primary —— 见「每屏一个主动作」那组。
    expect(screen.getByRole("button", { name: "流水线下一步" }).className).toContain("ui-button--secondary");
    expect(screen.getByRole("button", { name: "设置" }).className).toContain("ui-button--icon");
    expect(screen.getByRole("button", { name: "切换集" }).querySelector("svg")).not.toBeNull();
  });
  it("顶栏带 C 稿的键位提示:导入 ⌘I、命令面板 ⌘K 都是 <kbd>,且不进 AX 名(R12:主按钮上不再挂 ⌘⏎——那是沉浸预览的键,不是导出)", () => {
    render(<WorkspaceShell />);
    const topbar = document.querySelector(".workspace-topbar");
    expect(topbar).not.toBeNull();
    const keys = [...(topbar as HTMLElement).querySelectorAll("kbd.ui-kbd")].map((node) => node.textContent);
    expect(keys).toEqual(expect.arrayContaining(["⌘I", "⌘K"]));
    expect(keys).not.toContain("⌘⏎");
    // 键位是视觉提示,不能混进冻结的按钮名(冒烟按名找控件)。
    expect(screen.getByRole("button", { name: "导入素材" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "流水线下一步" })).toBeTruthy();
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
  it("两条分隔条各有一个可见抓手,宽 6px 由令牌控制(R19:检查器不是 Panel,第三条随之去掉)", () => {
    render(<WorkspaceShell />);
    const separators = screen.getAllByRole("separator");
    expect(separators).toHaveLength(2);
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

  it("R21:照片工作台启动时不恢复上次的视频选择", async () => {
    __resetClipsFeedForTests();
    apiMocks.getClipsRevision.mockResolvedValue("rev-photo-isolation" as never);
    apiMocks.getAiDescription.mockResolvedValue(null);
    apiMocks.listClips.mockResolvedValue([shellClip(7), { ...shellClip(8), kind: "photo", file_name: "IMG_0008.HEIC" }]);
    __resetWorkspaceForTests({ workspaceMode: "photo", restoreClipId: 7 });
    render(<WorkspaceShell />);
    await screen.findByRole("region", { name: "照片网格" });
    await act(async () => { await Promise.resolve(); });
    expect(getWorkspaceSnapshot().selection).toBeNull();
    expect(getWorkspaceSnapshot().restoreClipId).toBeNull();
  });

  it("R21:视频工作台启动时不恢复上次的照片选择", async () => {
    __resetClipsFeedForTests();
    apiMocks.getClipsRevision.mockResolvedValue("rev-video-isolation" as never);
    apiMocks.getAiDescription.mockResolvedValue(null);
    apiMocks.listClips.mockResolvedValue([{ ...shellClip(7), kind: "photo", file_name: "IMG_0007.HEIC" }, shellClip(8)]);
    __resetWorkspaceForTests({ workspaceMode: "video", restoreClipId: 7 });
    render(<WorkspaceShell />);
    await screen.findByRole("region", { name: "媒体池" });
    await act(async () => { await Promise.resolve(); });
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
    // R19 V-01:整屏(不只是每栏)最多一颗,且就是顶栏「下一步」。
    const all = document.querySelectorAll(".ui-button--primary:not([hidden])");
    expect(all.length, [...all].map((n) => n.getAttribute("aria-label") ?? n.textContent).join(" | ")).toBe(1);
    expect(all[0]!.getAttribute("aria-label")).toBe("流水线下一步");
  });

  it("R19 V-01:选中空槽位(检查器缺口分支「生成候选」)与无选中时,整屏实心主按钮同样 ≤ 1", async () => {
    apiMocks.getAiDescription.mockResolvedValue(null);
    apiMocks.getClipsRevision.mockResolvedValue("rev-primary-2" as never);
    apiMocks.listClips.mockResolvedValue([shellClip(3)]);
    __resetWorkspaceForTests({ selection: { kind: "slot", chapterId: 1, slot: "establishing" } });
    render(<WorkspaceShell />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const list = () => [...document.querySelectorAll(".ui-button--primary:not([hidden])")].map((n) => n.getAttribute("aria-label") ?? n.textContent).join(" | ");
    expect(document.querySelectorAll(".ui-button--primary:not([hidden])").length, list()).toBeLessThanOrEqual(1);
    act(() => dispatchWorkspace({ type: "clear-selection" }));
    expect(document.querySelectorAll(".ui-button--primary:not([hidden])").length, list()).toBeLessThanOrEqual(1);
  });

  it("F-R19-11:「自动挑选精选段」弹层开着时整屏仍只有顶栏「下一步」一颗实心主按钮(弹层里的「开始挑选」是 secondary)", async () => {
    apiMocks.getAiDescription.mockResolvedValue(null);
    apiMocks.getClipsRevision.mockResolvedValue("rev-primary-3" as never);
    apiMocks.listClips.mockResolvedValue([shellClip(3)]);
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 3 }, anchorClipId: 3, multiSelection: [3] });
    render(<WorkspaceShell />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const band = screen.getByRole("region", { name: "镜头带" });
    fireEvent.click(within(band).getByRole("button", { name: "自动挑选精选段" }));
    const panel = within(band).getByRole("group", { name: "自动挑选精选段" });
    const start = within(panel).getByRole("button", { name: "开始挑选" });
    expect(start.className).not.toContain("ui-button--primary");
    const all = document.querySelectorAll(".ui-button--primary:not([hidden])");
    expect(all.length, [...all].map((n) => n.getAttribute("aria-label") ?? n.textContent).join(" | ")).toBe(1);
    expect(all[0]!.getAttribute("aria-label")).toBe("流水线下一步");
  });
});

describe("R19 shell · V-03 镜头带通栏(方案 B 两层)", () => {
  it("外层 Group 是竖向(上层 / 镜头带 / 状态条),镜头带不在上层里、媒体池与监视器在上层里横排", () => {
    render(<WorkspaceShell />);
    const columns = document.querySelector<HTMLElement>(".workspace-columns")!;
    expect(columns.style.flexDirection).toBe("column");
    const upper = columns.querySelector<HTMLElement>(".workspace-upper")!;
    expect(upper).not.toBeNull();
    const upperRow = upper.querySelector<HTMLElement>("[data-group]")!;
    expect(upperRow.style.flexDirection).toBe("row");
    const pool = screen.getByRole("region", { name: "媒体池" });
    const monitor = screen.getByRole("region", { name: "预览监视器" });
    const band = screen.getByRole("region", { name: "镜头带" });
    expect(upper.contains(pool)).toBe(true);
    expect(upper.contains(monitor)).toBe(true);
    expect(upper.contains(band)).toBe(false);
    // 带是外层竖向 Group 的直接子 Panel:通栏,不被池 / 检查器夹着。
    expect(band.closest("[data-panel]")!.parentElement).toBe(columns);
  });
  it("三条分隔条的 AX 名不变(媒体池宽度 / 监视器高度 / 检查器宽度),监视器高度那条现在切的是上层与带", () => {
    render(<WorkspaceShell />);
    const names = screen.getAllByRole("separator").map((sep) => sep.getAttribute("aria-label"));
    expect(names).toContain("调整媒体池宽度");
    expect(names).toContain("调整监视器高度");
    const bandSep = screen.getByRole("separator", { name: "调整监视器高度" });
    expect(bandSep.parentElement).toBe(document.querySelector(".workspace-columns"));
  });
});

describe("R19 shell · V-02 顶部只有一行", () => {
  beforeEach(() => apiMocks.getAiDescription.mockResolvedValue(null));
  it("没有「第 n 步提示」status 条;提示句进了顶栏「下一步」的 title;PipelineHint 模块已删", async () => {
    apiMocks.getSettings.mockResolvedValue({}); // 四把 pipeline.hint_seen.* 都没看过 —— 0.9.1 会出提示条
    apiMocks.getClipsRevision.mockResolvedValue("rev-v02" as never);
    apiMocks.listClips.mockResolvedValue([shellClip(1)]);
    render(<WorkspaceShell />);
    await screen.findAllByRole("gridcell");
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("status", { name: /^第 \d 步提示$/ })).toBeNull();
    expect(document.querySelector(".pipeline-hint")).toBeNull();
    const next = screen.getByRole("button", { name: "流水线下一步" });
    const { PIPELINE_HINTS } = await import("./pipelineHints");
    const step = Number(next.getAttribute("data-step")) as 1 | 2 | 3 | 4;
    expect(next.getAttribute("title")).toContain(PIPELINE_HINTS[step]);
    expect(existsSync(resolve(process.cwd(), "src/workspace/PipelineHint.tsx"))).toBe(false);
  });
  it("工具链横幅不再是顶部一行:壳里没有 .toolchain-banner;缺 ffmpeg 时 ToolchainBanner 只发布状态,红点由 StatusStrip 订阅后渲染一处", async () => {
    const healthy = await apiMocks.getSettingsStatus();
    const missingTool = { configured_path: "", resolved_path: "", available: false, version: null, note: "not found" };
    apiMocks.getSettingsStatus.mockResolvedValue({ ...healthy, ffmpeg: missingTool, ffprobe: missingTool });
    const { useToolchainStatus, TOOLCHAIN_STATUS_EVENT } = await import("./ToolchainBanner");
    const heard: unknown[] = [];
    window.addEventListener(TOOLCHAIN_STATUS_EVENT, (event) => heard.push((event as CustomEvent).detail));
    render(<WorkspaceShell />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector(".toolchain-banner")).toBeNull();
    expect(screen.queryByRole("region", { name: "视频处理组件缺失" })).toBeNull();
    expect(heard.at(-1)).toEqual({ missing: true, text: "视频处理组件缺失" });
    // R19 接线:红点只渲染一处 —— StatusStrip 左端的按钮(band V-08 形态,在 status「后台状态」之内),
    // 它订阅的是壳里 ToolchainStatusProbe 发布的这同一份状态;壳里不再另画一颗。
    const dot = await screen.findByRole("button", { name: "视频处理组件缺失" });
    expect(dot.closest(".workspace-status-row")).not.toBeNull();
    expect(dot.closest('[aria-label="后台状态"]')).not.toBeNull();
    expect(dot.querySelector(".workspace-status-dot")).not.toBeNull();
    expect(screen.getAllByText("视频处理组件缺失")).toHaveLength(1);
    // 同一份状态谁都能订阅。
    function Probe() {
      const status = useToolchainStatus();
      return <span data-testid="probe">{status.missing ? status.text : "ok"}</span>;
    }
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("视频处理组件缺失");
  });
});

describe("R19 shell · V-11 单一断点 --bp-compact: 1366px", () => {
  it("tokens.css 声明 --bp-compact: 1366px,shellLayout 的 BP_COMPACT 与它同值;三处调用点不再有裸 1400 / 1440", async () => {
    const tokens = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
    expect(tokens).toMatch(/--bp-compact:\s*1366px;/);
    const { BP_COMPACT, COMPACT_WIDE_QUERY, isCompactWidth } = await import("./shellLayout");
    expect(BP_COMPACT).toBe(1366);
    expect(COMPACT_WIDE_QUERY).toBe("(min-width: 1366px)");
    expect(isCompactWidth(1365)).toBe(true);
    expect(isCompactWidth(1366)).toBe(false);
    for (const file of ["src/workspace/shellLayout.ts", "src/workspace/PipelineRail.tsx", "src/workspace/MediaPool.tsx"]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
      expect(source, `${file} 里还有裸 1400 / 1440`).not.toMatch(/\b14[04]0\b/);
    }
  });
  it("媒体池列数按 1366 分档:1366 三列、1365 两列(不再是 1440)", async () => {
    apiMocks.getClipsRevision.mockResolvedValue("rev-bp" as never);
    apiMocks.listClips.mockResolvedValue([shellClip(1), shellClip(2), shellClip(3)]);
    resizeTo(1366);
    render(<WorkspaceShell />);
    await screen.findAllByRole("gridcell");
    const grid = screen.getByRole("grid", { name: "媒体池" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(grid.getAttribute("aria-colcount")).toBe("3");
    resizeTo(1365);
    await act(async () => {
      await Promise.resolve();
    });
    expect(grid.getAttribute("aria-colcount")).toBe("2");
  });
});
