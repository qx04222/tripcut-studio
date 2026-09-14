// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HelpOverlay } from "./HelpOverlay";
import {
  HELP_FAQS,
  KEYBOARD_SHORTCUT_GROUPS,
  PIPELINE_MANUAL,
  PLAYER_SHORTCUTS,
  SELECTION_SHORTCUTS,
  SETTINGS_HELP_TOPICS,
  WORKSPACE_SHORTCUTS,
  WORKFLOW_STEPS,
  shortcutKeys,
  shortcutsById,
} from "./helpContent";
import { GENERATED_LICENSES } from "./licenses.generated";
import { globalHotkeyIntent } from "./workspace/useGlobalHotkeys";

// P2:帮助层压在命令面板之下打开时,Esc 只应关最上层——需要真的把 CommandPalette
// 挂上去验证,所以复用它测试文件里的同一套 api/pinyin mock。
const apiMock = vi.hoisted(() => ({
  listClips: vi.fn().mockResolvedValue([]),
  searchEverything: vi.fn().mockResolvedValue([]),
  listClipDimensions: vi.fn().mockResolvedValue([]),
  getStoryboard: vi.fn().mockResolvedValue(null),
  getCurrentEpisode: vi.fn().mockResolvedValue({ id: 100 }),
  listEpisodes: vi.fn().mockResolvedValue([{ id: 100, title: "当前集" }]),
  getClipsRevision: vi.fn().mockResolvedValue("rev-1"),
  listShotStacks: vi.fn().mockResolvedValue([]),
  listStoryGaps: vi.fn().mockResolvedValue([]),
  listAssetSafety: vi.fn().mockResolvedValue([]),
  // R12:引入 useGlobalHotkeys 会连带 WorkspaceStore(它在模块顶层建 setSetting 写手)。
  setSetting: vi.fn().mockResolvedValue(undefined),
  getSettings: vi.fn().mockResolvedValue({}),
  arrangeSelectedSegments: vi.fn().mockResolvedValue({ placed: 0, chapters: 0 }),
}));
vi.mock("./api", () => apiMock);
vi.mock("./historyView", () => ({ openHistoricalEpisode: vi.fn() }));
vi.mock("pinyin-pro", () => ({ pinyin: () => [] }));

describe("R12 §1:流水线手册", () => {
  it("四步各恰好 3 行「怎么做」,快捷键 id 全部能在总表里找到(不手抄键位)", () => {
    expect(PIPELINE_MANUAL.map((entry) => entry.step)).toEqual([1, 2, 3, 4]);
    expect(PIPELINE_MANUAL.map((entry) => entry.title)).toEqual(["导入", "挑选", "排列", "导出"]);
    for (const entry of PIPELINE_MANUAL) {
      expect(entry.howTo).toHaveLength(3);
      expect(shortcutsById(entry.shortcutIds).map((shortcut) => shortcut.id)).toEqual([...entry.shortcutIds]);
    }
  });

  it("总表里「工作区」那组的每一条都对应 useGlobalHotkeys 里一个真实 intent(表与实现同源)", () => {
    const idle = { openDrawer: null, immersive: false, query: "" } as const;
    const press: Record<string, { key: string; code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {
      "command-palette": { key: "k", code: "KeyK", metaKey: true, ctrlKey: false, shiftKey: false },
      "cycle-pane": { key: "F6", code: "F6", metaKey: false, ctrlKey: false, shiftKey: false },
      "toggle-pool": { key: "1", code: "Digit1", metaKey: true, ctrlKey: false, shiftKey: false },
      "toggle-inspector": { key: "2", code: "Digit2", metaKey: true, ctrlKey: false, shiftKey: false },
      immersive: { key: "Enter", code: "Enter", metaKey: true, ctrlKey: false, shiftKey: false },
      "open-import": { key: "i", code: "KeyI", metaKey: true, ctrlKey: false, shiftKey: false },
      "open-settings": { key: ",", code: "Comma", metaKey: true, ctrlKey: false, shiftKey: false },
      "open-help": { key: "?", code: "Slash", metaKey: false, ctrlKey: false, shiftKey: true },
      escape: { key: "Escape", code: "Escape", metaKey: false, ctrlKey: false, shiftKey: false },
    };
    for (const shortcut of WORKSPACE_SHORTCUTS) {
      expect(press[shortcut.id], `帮助表里的 ${shortcut.id} 没有对应的按键样例`).toBeTruthy();
      expect(globalHotkeyIntent(press[shortcut.id], idle, false), shortcut.id).not.toBeNull();
    }
  });

  it("帮助浮层标题「流水线手册」,第一节四步各带 3 行与该步快捷键", () => {
    const markup = renderToStaticMarkup(<HelpOverlay open onClose={() => undefined} />);
    expect(markup).toContain("流水线手册");
    for (const step of [1, 2, 3, 4]) {
      expect(markup).toContain(`data-pipeline-step="${step}"`);
      expect(markup).toContain(`第 ${step} 步快捷键`);
    }
    expect(markup).toContain("下一步:自动挑选");
    expect(markup).toContain("只重试失败的");
  });
});

describe("P5-F3 Chinese help and polish", () => {
  it("工作流一节讲的是一屏三栏,不是已经下线的四步页面(规格 §1)", () => {
    expect(WORKFLOW_STEPS.map((step) => step.label)).toEqual([
      "顶栏",
      "媒体池",
      "预览监视器",
      "镜头带",
      "检查器",
    ]);
    // 负向:旧四步页面的名字一个都不许再出现在帮助里 —— 它们在 0.3.0 里已经不是
    // 可导航的东西了,留着就是把用户往不存在的页面上指。
    const text = WORKFLOW_STEPS.map((step) => `${step.label}${step.description}`).join("");
    for (const banned of ["筛片页", "交付页", "设置页", "导入页"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("builds the complete shortcut table from shared screen constants", () => {
    // 按 id 取,不按下标 —— 新壳的「工作区」全局键位插在最前面,下标会变。
    const byId = (id: string) => KEYBOARD_SHORTCUT_GROUPS.find((group) => group.id === id);
    expect(byId("workspace")?.shortcuts).toBe(WORKSPACE_SHORTCUTS);
    expect(byId("selection")?.shortcuts).toBe(SELECTION_SHORTCUTS);
    expect(byId("player")?.shortcuts).toBe(PLAYER_SHORTCUTS);
    expect(KEYBOARD_SHORTCUT_GROUPS[0].id).toBe("workspace");
    expect(KEYBOARD_SHORTCUT_GROUPS.flatMap((group) => group.shortcuts)).toHaveLength(27);
  });

  it("帮助里的快捷键表覆盖新 IA 的每一条全局键位(规格 §3.2)", () => {
    expect(WORKSPACE_SHORTCUTS.map((shortcut) => shortcut.id)).toEqual([
      "command-palette",
      "cycle-pane",
      "toggle-pool",
      "toggle-inspector",
      "immersive",
      "open-import",
      "open-settings",
      "open-help",
      "escape",
    ]);
  });

  it("帮助浮层里没有英文 eyebrow(规格 §6)", () => {
    const markup = renderToStaticMarkup(<HelpOverlay open onClose={() => undefined} />);
    const visible = markup.replace(/<[^>]*>/g, " ");
    // Chinese-CLIP 与 PATH 是正文里的技术名词,不是装饰性抬头 —— 其余成串大写一律算 kicker。
    const allowed = new Set(["CLIP", "PATH"]);
    const hits = (visible.match(/[A-Z]{4,}/g) ?? []).filter((word) => !allowed.has(word));
    expect(hits).toEqual([]);
  });

  it("covers toolchain, Jianying compatibility and local encryption in the FAQ", () => {
    const faqText = HELP_FAQS.map((faq) => `${faq.question}${faq.answer}`).join(" ");
    expect(faqText).toContain("工具链");
    expect(faqText).toContain("剪映");
    expect(faqText).toContain("FileVault");
  });

  it("renders an accessible Chinese dialog with every generated help section", () => {
    const markup = renderToStaticMarkup(<HelpOverlay open onClose={() => undefined} />);
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("一屏三栏");
    expect(markup).toContain("快捷键总表");
    expect(markup).toContain("设置页导览");
    expect(markup).toContain("常见问题");
  });

  it("includes a settings topic and a privacy topic in the settings help section", () => {
    const markup = renderToStaticMarkup(<HelpOverlay open onClose={() => undefined} />);
    expect(SETTINGS_HELP_TOPICS.map((topic) => topic.id)).toEqual(["settings", "privacy"]);
    expect(markup).toContain('data-help-topic="settings"');
    expect(markup).toContain('data-help-topic="privacy"');
    expect(markup).toContain("隐私与诊断怎么读");
    expect(markup).toContain("崩溃报告");
  });

  it("ships a static direct-dependency license manifest for both ecosystems", () => {
    expect(GENERATED_LICENSES.some((entry) => entry.ecosystem === "Cargo")).toBe(true);
    expect(GENERATED_LICENSES.some((entry) => entry.ecosystem === "npm")).toBe(true);
    expect(GENERATED_LICENSES.every((entry) => entry.name && entry.version && entry.license)).toBe(true);
  });
});

describe("P2: HelpOverlay 挂上模态栈,Esc 只关最上层", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("命令面板压在帮助层之上时,第一下 Esc 只关命令面板,第二下才关帮助层", async () => {
    // 动态 import,避开文件顶部其它测试(渲染成静态 HTML)对模块缓存的影响。
    const { CommandPalette } = await import("./CommandPalette");
    const onCloseHelp = vi.fn();

    function Harness() {
      return (
        <>
          <HelpOverlay open onClose={onCloseHelp} />
          <CommandPalette onNavigate={() => undefined} onSelectClip={() => undefined} />
        </>
      );
    }

    await act(async () => {
      root.render(<Harness />);
    });
    expect(container.textContent).toContain("一屏三栏");

    // 打开命令面板,压在帮助层之上。
    await act(async () => {
      window.dispatchEvent(new CustomEvent("tripcut:open-command-palette"));
      await Promise.resolve();
    });
    expect(container.querySelector(".command-palette")).not.toBeNull();

    // 第一下 Esc:只关命令面板,帮助层还开着。
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector(".command-palette")).toBeNull();
    expect(onCloseHelp).not.toHaveBeenCalled();
    expect(container.textContent).toContain("一屏三栏");

    // 第二下 Esc:命令面板已经不在栈里了,这次轮到帮助层。
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCloseHelp).toHaveBeenCalledTimes(1);
  });
});

describe("R13 §1:帮助页键帽随预设变化", () => {
  it("shortcutKeys:有 actions 的行按键位表取键帽;Premiere 下沉浸预览显示 `", async () => {
    const { resolveKeymap } = await import("./workspace/keymap");
    const immersive = WORKSPACE_SHORTCUTS.find((shortcut) => shortcut.id === "immersive")!;
    expect(shortcutKeys(immersive, resolveKeymap("jianying", undefined))).toEqual(["⌘⏎"]);
    expect(shortcutKeys(immersive, resolveKeymap("premiere", undefined))).toEqual(["`"]);
    const frame = PLAYER_SHORTCUTS.find((shortcut) => shortcut.id === "step-frame")!;
    expect(shortcutKeys(frame, resolveKeymap("jianying", undefined))).toEqual(["←", "→"]);
    // 每一行帮助都绑了动作(不再手抄键位),只有「1–5 星级」保留静态写法。
    for (const shortcut of KEYBOARD_SHORTCUT_GROUPS.flatMap((group) => group.shortcuts)) {
      if (shortcut.id === "stars") continue;
      expect(shortcut.actions, shortcut.id).toBeTruthy();
    }
  });
});
