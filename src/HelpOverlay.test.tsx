// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HelpOverlay } from "./HelpOverlay";
import {
  HELP_FAQS,
  KEYBOARD_SHORTCUT_GROUPS,
  PLAYER_SHORTCUTS,
  SELECTION_SHORTCUTS,
  SETTINGS_HELP_TOPICS,
  WORKSPACE_SHORTCUTS,
  WORKFLOW_STEPS,
} from "./helpContent";
import { GENERATED_LICENSES } from "./licenses.generated";

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
}));
vi.mock("./api", () => apiMock);
vi.mock("./historyView", () => ({ openHistoricalEpisode: vi.fn() }));
vi.mock("pinyin-pro", () => ({ pinyin: () => [] }));

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
