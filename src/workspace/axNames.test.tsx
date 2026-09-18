// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import postcss from "postcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 整份 api 替身由 `./testApiMock` 从 `src/api.ts` 的真实导出表生成。
const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMocks);
// 导入抽屉里的 ImportPage 在 effect 里直接摸 webview 的拖放事件;jsdom 里没有宿主,
// 不打桩它就抛进 React 的 commit 阶段,把整棵树拆掉。
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import { DELIVER_DRAWER_TITLE, DELIVER_ORIENTATION_LABEL, DIMENSION_FILTER_LABEL, IMPORT_PROGRESS_LABEL, INSPECTOR_TITLES, OPTIONAL_TRANSCRIBE_TITLE, OPTIONAL_VISION_TITLE, ORIENTATION_LABEL, stackCountLabel, stackGroupLabel, takeLabel } from "./copy";
import { WorkspaceShell } from "./WorkspaceShell";
import { dispatchWorkspace, __resetWorkspaceForTests } from "./WorkspaceStore";
import { __setShowAllFeaturesForTests } from "./showAllFeatures";

/**
 * 冻结串。冒烟脚本(Task 8)按这些名字找元素 —— 改一个字这里就红,
 * 提醒你连带把冒烟脚本改掉,而不是让脚本在某个深夜自己找不到按钮。
 */
// R12 车道 A:顶栏主按钮「生成交付包」解冻,迁移为固定 AX 名「流水线下一步」(可见文案随步变化);
// X-05:抽屉标题「生成交付包」解冻改名「导出」(常量 DELIVER_DRAWER_TITLE),断言已迁移。
const FROZEN_BUTTONS = ["导入素材", "流水线下一步", "设置", "切换集"];
const FROZEN_REGIONS = ["媒体池", "预览监视器", "镜头带", "检查器"];
const FROZEN_TABS = ["故事", "音乐", "旅程", "地点卡", "模板"];
const FROZEN_STATUS = "后台状态";

/** 规格 §6:主屏一个英文 kicker / eyebrow 都不许有。 */
const BANNED_ON_MAIN_SCREEN = [
  "01 导入 INGEST",
  "02 筛片 SELECT",
  "03 交付 DELIVER",
  "04 设置 SETTINGS",
  "INGEST",
  "SELECT",
  "ROUGH CUT",
  "CHINESE-CLIP · LOCAL",
  "LIBRARY",
  "TRIPCUT / LOCAL-FIRST",
  "INSPECTOR",
  "LOCAL SQLITE",
  "PLACEHOLDER VIEW",
  "TRIPCUT STUDIO",
];

const WORKSPACE_CSS = readFileSync(resolve(process.cwd(), "src/styles/workspace.css"), "utf8");

beforeEach(() => {
  // R19 P-05:这份文件描述的是「显示全部功能」打开后的形态(旅程 / 地点卡 / 模板 / 技术检查 / 快捷键 / 性能 / 云端补镜都在);默认态在 showAllFeaturesR19.test。
  __setShowAllFeaturesForTests(true);
  __resetWorkspaceForTests();
  // R19 U-05:导入抽屉的「任务 / 缺失素材」分页各自计数 >0 才出 —— 冻结的三个分页名在「导过东西、有缺失」的库里断言。
  apiMocks.getImportProgress.mockResolvedValue({ total: 12, done: 12, failed: 0, running: 0, waiting_for_permit: 0, paused_for_memory: false } as never);
  apiMocks.listMissingClips.mockResolvedValue([{ clip_id: 9, file_name: "Z.MOV", volume_uuid: "vol-z", volume_label: null, rel_path: "Z.MOV", missing_since: "" }]);
});
afterEach(cleanup);

describe("冻结的 AX 名(冒烟脚本的锚点)", () => {
  it("五个 landmark、四个顶栏按钮、五个附属带 tab 一字不差", () => {
    render(<WorkspaceShell />);
    for (const name of FROZEN_BUTTONS) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    for (const name of FROZEN_REGIONS) {
      expect(screen.getByRole("region", { name })).toBeTruthy();
    }
    expect(screen.getByRole("status", { name: FROZEN_STATUS })).toBeTruthy();

    // V-07:五个 tab 收进「附属：{当前} ⌄」触发钮下的浮层,平时不占标题条——先展开才摸得到。
    fireEvent.click(screen.getByRole("button", { name: /^附属：/ }));
    const list = screen.getByRole("tablist", { name: "镜头带附属视图" });
    expect(within(list).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(FROZEN_TABS);
  });

  it("导入抽屉打开时,附属带 tablist 仍然只有五个 tab —— 两张 tablist 互不嵌套", async () => {
    // R8 真机 #3 的开放疑点(a):AX 里数到 `AXTabGroup 镜头带附属视图` 下有 8 个
    // AXRadioButton(故事/音乐/旅程/地点卡/模板 + 来源/任务/缺失素材)。8 = 5 + 3,
    // 后三个正是导入抽屉的分页名。这条用例把"两张 tablist 在 DOM 上是否嵌套"这个
    // 唯一可能的产品侧成因钉死:抽屉开着的时候,附属带 tablist 里仍然**恰好**五个
    // tab,导入分页 tablist 也不是它的后代。若这条绿而真机仍数到 8,那 8 就是
    // 探针把整窗 AXRadioButton 数进来了,不是产品缺陷。
    render(<WorkspaceShell />);
    fireEvent.click(screen.getByRole("button", { name: /^附属：/ }));
    await act(async () => {
      dispatchWorkspace({ type: "open-drawer", drawer: "import" });
      await Promise.resolve();
    });
    const bandList = await screen.findByRole("tablist", { name: "镜头带附属视图" });
    const importList = await screen.findByRole("tablist", { name: "导入分页" });
    expect(within(bandList).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(FROZEN_TABS);
    expect(bandList.contains(importList)).toBe(false);
    expect(importList.contains(bandList)).toBe(false);
    await within(importList).findByRole("tab", { name: "缺失素材" });
    expect(within(importList).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "来源",
      "任务",
      "缺失素材",
    ]);
  });

  it("三个模态里的冒烟锚点一字不差(scripts/qa/smoke-gui.mjs §4–§6 + 附属带三串)", async () => {
    render(<WorkspaceShell />);
    // 附属带:冒烟按 containsText 找「音乐与节奏」「旅程时间线」;「电影感」是数据不是代码。
    for (const [tab, needle] of [["音乐", "音乐与节奏"], ["旅程", "旅程时间线"]] as const) {
      await act(async () => {
        dispatchWorkspace({ type: "set-band-mode", mode: tab === "音乐" ? "music" : "journey" });
        await Promise.resolve();
      });
      expect(await screen.findByText(needle)).toBeTruthy();
    }
    await act(async () => {
      dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "source" });
      await Promise.resolve();
    });
    const importDialog = await screen.findByRole("dialog", { name: "导入素材" });
    for (const tab of ["来源", "任务", "缺失素材"]) expect(await within(importDialog).findByRole("tab", { name: tab })).toBeTruthy();
    expect(screen.queryByText("松开即导入")).toBeNull();
    expect(within(importDialog).getByRole("button", { name: "关闭" })).toBeTruthy();

    await act(async () => {
      dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
      await Promise.resolve();
    });
    const deliver = await screen.findByRole("dialog", { name: DELIVER_DRAWER_TITLE });
    expect(DELIVER_DRAWER_TITLE).toBe("导出");
    // R19 U-06/P-04:首屏是三卡,既有四模式 chip 选择器搬进「更多方式 ⌄」——先展开它,冻结名不变。
    await act(async () => {
      within(deliver).getByRole("button", { name: "更多方式" }).click();
      await Promise.resolve();
    });
    // R11 车道 E:抽屉默认「快速导出」(新 AX 名:快速导出 / 完整交付包 / 导出到上次文件夹 / 更改文件夹);
    // 完整交付包那套冻结的名字在切过去之后照旧。
    // Y-08(R13 真机):还没记过文件夹时主按钮叫「导出…」;记过才是「导出到上次文件夹」。
    expect(within(deliver).getByRole("button", { name: "导出片段" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(deliver).getByRole("button", { name: "导出…" })).toBeTruthy();
    expect(within(deliver).getByRole("button", { name: "更改文件夹" })).toBeTruthy();
    await act(async () => {
      within(deliver).getByRole("button", { name: "完整交付包" }).click();
      await Promise.resolve();
    });
    expect(within(deliver).getByText("本次交付平台")).toBeTruthy();
    expect(within(deliver).getByRole("switch", { name: "联系表.pdf" })).toBeTruthy();
    // R10 U-20:抽屉里的主按钮叫「开始生成」(新 AX 名,冻结);R12 起顶栏没有「生成交付包」按钮了
    // (主按钮是「流水线下一步」),冒烟脚本按导航条「第 4 步 导出」开抽屉,按「开始生成」动手。
    expect(within(deliver).getByRole("button", { name: "开始生成" })).toBeTruthy();
    expect(within(deliver).queryByRole("button", { name: "生成交付包" })).toBeNull();

    await act(async () => {
      dispatchWorkspace({ type: "open-drawer", drawer: "settings" });
      await Promise.resolve();
    });
    const settings = await screen.findByRole("dialog", { name: "设置" });
    expect(within(settings).getByText("隐私与诊断")).toBeTruthy();
    expect(within(settings).getByText("云端补镜")).toBeTruthy();
  });

  it("折叠后媒体池竖条的按钮名冻结;R19 检查器改滑出层,新控件名「钉住检查器」「收起检查器」", () => {
    apiMocks.getAiDescription.mockResolvedValue(null); // 选中后检查器会拉 AI 描述;通用替身默认给 [],那里按 null 才不炸
    __resetWorkspaceForTests({ poolCollapsed: true, selection: { kind: "clip", clipId: 3 } });
    render(<WorkspaceShell />);
    expect(screen.getByRole("button", { name: "展开媒体池" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "展开检查器" })).toBeNull();
    expect(screen.getByRole("button", { name: "钉住检查器" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "收起检查器" })).toBeTruthy();
  });

  it("主屏不出现任何英文 kicker / eyebrow", () => {
    render(<WorkspaceShell />);
    for (const banned of BANNED_ON_MAIN_SCREEN) {
      expect(screen.queryByText(banned)).toBeNull();
    }
  });

  it("整棵主屏的可见文本里没有成串的大写拉丁字母(kicker 的形状)", () => {
    render(<WorkspaceShell />);
    const text = document.body.textContent ?? "";
    // 三个及以上连续大写字母就是 kicker 的形状;LUT/AI 这类两字母缩写不在此列。
    const hits = text.match(/[A-Z]{3,}/g) ?? [];
    expect(hits).toEqual([]);
  });
});

describe("R12 车道 C 改名后的冻结 AX 名(design-system.md §11 的对照表)", () => {
  it("旧名 → 新名一字不差;旧名不再出现在常量里", () => {
    // 旧「Take n · 文件名」→「第 n 条 · 文件名」;旧「{scene} 的候选」→「同一镜头 · {scene}」;旧「n 条候选」→「同一镜头 n 条」。
    expect(takeLabel(3, "clip-3.mov")).toBe("第 3 条 · clip-3.mov");
    expect(stackGroupLabel("登机口")).toBe("同一镜头 · 登机口");
    expect(stackCountLabel(8)).toBe("同一镜头 8 条");
    // 旧「八维评分」→「画面评分」;旧「音轨与 LUT」→「声音与调色」;旧「八维筛选」→「画面筛选」。
    expect(INSPECTOR_TITLES).toEqual({ techcheck: "技术检查", dimensions: "画面评分", ai: "AI 描述", audio: "声音与调色", similar: "相似镜头" });
    expect(DIMENSION_FILTER_LABEL).toBe("画面筛选");
    // 旧「画布方向」「本次交付画布方向」→「画面方向」「本次交付画面方向」;旧「索引进度」→「导入进度」。
    expect(ORIENTATION_LABEL).toBe("画面方向");
    expect(DELIVER_ORIENTATION_LABEL).toBe("本次交付画面方向");
    expect(IMPORT_PROGRESS_LABEL).toBe("导入进度");
    // 规格 §4:首启 / 安装检查卡的两项可选组件。
    expect(OPTIONAL_TRANSCRIBE_TITLE).toBe("转写(可选)");
    expect(OPTIONAL_VISION_TITLE).toBe("画面识别(可选)");
  });

  it("主屏渲染出来的文本里没有一个旧名", () => {
    render(<WorkspaceShell />);
    const text = document.body.textContent ?? "";
    for (const old of ["八维", "音轨与 LUT", "Take ", "Stack", "画布", "索引"]) expect(text).not.toContain(old);
  });
});

describe("workspace.css 的结构自检", () => {
  it("花括号配平 —— 少一个 `}` 就等于把后面整张表塞进上一条规则", () => {
    // 真事:R8 六条车道合并后,`.monitor`、`.monitor-placeholder-title`、
    // `.monitor-button`、`.monitor-button.primary`、`.monitor-duration/.monitor-marked`、
    // `.visually-hidden` 六条规则的 `}` 与尾部声明一起被合并冲掉了。WebKit 支持
    // CSS 嵌套,于是 `.monitor {` 之后的**整张表**(媒体池、抽屉、镜头带、检查器)
    // 都变成 `.monitor .xxx`,在真机上一条都不生效;jsdom 不跑 CSS,49 个测试文件
    // 全绿也看不见。这条断言就是那个缺失的探测器。
    const stack: string[] = [];
    for (const [index, line] of WORKSPACE_CSS.split("\n").entries()) {
      for (const char of line) {
        if (char === "{") stack.push(`${index + 1}: ${line.trim()}`);
        else if (char === "}") stack.pop();
      }
    }
    expect(stack).toEqual([]);
  });

  it("真解析器(postcss)能整份解析,且没有一条规则嵌在另一条规则里", () => {
    // 上面的花括号计数是手写的探测器;这条用 vite 自带的 postcss 再过一遍:
    // 少一个 `}` 它抛 "Unclosed block",多一个抛 "Unexpected }",字符串/注释里的
    // 括号它不会数错。同时断言 0 条嵌套规则 —— 这份表不用 CSS 嵌套,任何嵌套都
    // 只可能是合并把一条规则塞进了另一条(WebKit 会把它解释成 `.a .b`)。
    const root = postcss.parse(WORKSPACE_CSS, { from: "src/styles/workspace.css" });
    const nested: string[] = [];
    let rules = 0;
    root.walkRules((rule) => {
      rules += 1;
      if (rule.parent?.type === "rule") nested.push(rule.selector);
    });
    expect(nested).toEqual([]);
    expect(rules).toBeGreaterThan(150);
  });

  it("同一个选择器不重复出现两次(合并冲突的另一种形状)", () => {
    const selectors = [...WORKSPACE_CSS.matchAll(/^([.:#@][^{}\n]*?)\s*\{$/gm)].map(
      (match) => match[1]?.trim() ?? "",
    );
    const seen = new Set<string>();
    const duplicated = selectors.filter((selector) => {
      if (seen.has(selector)) return true;
      seen.add(selector);
      return false;
    });
    expect(duplicated).toEqual([]);
  });
});

describe("规格 §6 的密度与焦点环", () => {
  it("正文 13px / 元信息 12px / 控件 28px / 顶栏按钮 30px / 顶栏 44px / 状态条 28px", () => {
    expect(WORKSPACE_CSS).toContain("--workspace-topbar-height: 44px");
    expect(WORKSPACE_CSS).toContain("--workspace-status-height: 28px");
    expect(WORKSPACE_CSS).toContain("--workspace-rail-width: 44px");
    // 13px / 12px 走 styles.css 的 --font-sm / --font-xs,这里只证明壳用的是它们。
    expect(/\.workspace-shell\s*\{[^}]*font-size:\s*var\(--font-sm\)/.test(WORKSPACE_CSS)).toBe(true);
    expect(/\.workspace-shell\s*\{[^}]*line-height:\s*1\.45/.test(WORKSPACE_CSS)).toBe(true);
    // R9:顶栏按钮是套件 Button(kit.css 的 --control-md),旧 `.workspace-topbar-button` 规则已清。
    expect(WORKSPACE_CSS).not.toMatch(/\.workspace-topbar-button/);
    expect(WORKSPACE_CSS).toContain("--workspace-control-height: 28px");
  });

  it("键盘可达的每个控件都有一圈用强调色画的 :focus-visible", () => {
    expect(/:focus-visible\s*\{[^}]*outline:[^}]*var\(--accent\)/.test(WORKSPACE_CSS)).toBe(true);
    // 只有一种强调色(规格 §6):壳里不许出现颜色字面量。
    expect(/#[0-9a-fA-F]{3,8}\b/.test(WORKSPACE_CSS)).toBe(false);
  });
});
