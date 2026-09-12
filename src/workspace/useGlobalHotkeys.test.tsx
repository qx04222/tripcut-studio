// @vitest-environment jsdom
import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceShell } from "./WorkspaceShell";
import { globalHotkeyIntent, isTextFieldTarget } from "./useGlobalHotkeys";
import { __resetModalStackForTests, pushModal } from "./modalStack";
import { __resetWorkspaceForTests, getWorkspaceSnapshot, type WorkspaceState } from "./WorkspaceStore";

type EscState = Pick<WorkspaceState, "openDrawer" | "immersive" | "query">;
const IDLE: EscState = { openDrawer: null, immersive: false, query: "" };

function key(
  overrides: Partial<Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey">>,
): Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey"> {
  return { key: "", code: "", metaKey: false, ctrlKey: false, shiftKey: false, ...overrides };
}

/**
 * 按一下键。必须裹 act():store 是 useSyncExternalStore,不裹的话 React 不会在
 * 这一拍重渲染,壳里的 keydown 监听就还闭包着上一版 state —— 连按两下 Esc 会被
 * 当成同一层来退。
 */
function press(init: KeyboardEventInit & { key: string }): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

/** jsdom 默认 1024px —— 不撑开的话壳一挂载就按窄窗规则把两侧栏折了。 */
function widescreen(): void {
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true, writable: true });
}

beforeEach(() => {
  widescreen();
  __resetWorkspaceForTests();
  __resetModalStackForTests();
});
afterEach(cleanup);

describe("globalHotkeyIntent —— 纯判定", () => {
  const esc = key({ key: "Escape", code: "Escape" });

  it("Esc 按 抽屉 → sheet → 沉浸 → 清搜索 的优先级逐层退", () => {
    expect(globalHotkeyIntent(esc, { openDrawer: "import", immersive: true, query: "湖" }, false))
      .toEqual({ kind: "escape", target: "drawer" });
    expect(globalHotkeyIntent(esc, { openDrawer: "deliver", immersive: true, query: "湖" }, false))
      .toEqual({ kind: "escape", target: "drawer" });
    expect(globalHotkeyIntent(esc, { openDrawer: "settings", immersive: true, query: "湖" }, false))
      .toEqual({ kind: "escape", target: "sheet" });
    expect(globalHotkeyIntent(esc, { openDrawer: null, immersive: true, query: "湖" }, false))
      .toEqual({ kind: "escape", target: "immersive" });
    expect(globalHotkeyIntent(esc, { openDrawer: null, immersive: false, query: "湖" }, false))
      .toEqual({ kind: "escape", target: "query" });
    expect(globalHotkeyIntent(esc, { openDrawer: null, immersive: false, query: "" }, false))
      .toEqual({ kind: "escape", target: null });
  });

  it("Esc 在输入框里照样清搜索 —— 搜索框自己就是那个输入框", () => {
    expect(globalHotkeyIntent(esc, { openDrawer: null, immersive: false, query: "湖" }, true))
      .toEqual({ kind: "escape", target: "query" });
  });

  it("⌘1/⌘2 折叠媒体池/检查器,⌘⏎ 沉浸,⌘, 设置,? 帮助", () => {
    expect(globalHotkeyIntent(key({ key: "1", code: "Digit1", metaKey: true }), IDLE, false))
      .toEqual({ kind: "toggle-pane", pane: "pool" });
    expect(globalHotkeyIntent(key({ key: "2", code: "Digit2", metaKey: true }), IDLE, false))
      .toEqual({ kind: "toggle-pane", pane: "inspector" });
    expect(globalHotkeyIntent(key({ key: "Enter", code: "Enter", metaKey: true }), IDLE, false))
      .toEqual({ kind: "immersive" });
    expect(globalHotkeyIntent(key({ key: ",", code: "Comma", metaKey: true }), IDLE, false))
      .toEqual({ kind: "settings" });
    expect(globalHotkeyIntent(key({ key: "?", code: "Slash", shiftKey: true }), IDLE, false))
      .toEqual({ kind: "help" });
  });

  it("⌘I 打开导入抽屉(顶栏「导入素材」的键帽提示);在输入框里不响 —— 那是斜体/自动补全的地盘", () => {
    expect(globalHotkeyIntent(key({ key: "i", code: "KeyI", metaKey: true }), IDLE, false))
      .toEqual({ kind: "import" });
    expect(globalHotkeyIntent(key({ key: "I", code: "KeyI", metaKey: true, shiftKey: true }), IDLE, false))
      .toEqual({ kind: "import" });
    expect(globalHotkeyIntent(key({ key: "i", code: "KeyI", ctrlKey: true }), IDLE, false))
      .toEqual({ kind: "import" });
    expect(globalHotkeyIntent(key({ key: "i", code: "KeyI", metaKey: true }), IDLE, true)).toBeNull();
    // 裸 i 不是键位。
    expect(globalHotkeyIntent(key({ key: "i", code: "KeyI" }), IDLE, false)).toBeNull();
  });

  it("Ctrl 与 ⌘ 等价(Windows/Linux 键盘也要能用)", () => {
    expect(globalHotkeyIntent(key({ key: "1", code: "Digit1", ctrlKey: true }), IDLE, false))
      .toEqual({ kind: "toggle-pane", pane: "pool" });
    expect(globalHotkeyIntent(key({ key: "k", code: "KeyK", ctrlKey: true }), IDLE, false))
      .toEqual({ kind: "command-palette" });
  });

  it("F6 轮转,⇧F6 反向", () => {
    expect(globalHotkeyIntent(key({ key: "F6", code: "F6" }), IDLE, false))
      .toEqual({ kind: "cycle-pane", direction: 1 });
    expect(globalHotkeyIntent(key({ key: "F6", code: "F6", shiftKey: true }), IDLE, false))
      .toEqual({ kind: "cycle-pane", direction: -1 });
  });

  it("F6 在输入框里照样轮转 —— 它是换栏,不是打字", () => {
    expect(globalHotkeyIntent(key({ key: "F6", code: "F6" }), IDLE, true))
      .toEqual({ kind: "cycle-pane", direction: 1 });
  });

  it("空格在输入框里不劫持播放,? 在输入框里也不弹帮助", () => {
    expect(globalHotkeyIntent(key({ key: " ", code: "Space" }), IDLE, true)).toBeNull();
    expect(globalHotkeyIntent(key({ key: "?", code: "Slash", shiftKey: true }), IDLE, true)).toBeNull();
  });

  it("空格不是壳的键位 —— 播放归镜头带自己管", () => {
    expect(globalHotkeyIntent(key({ key: " ", code: "Space" }), IDLE, false)).toBeNull();
  });

  it("⌘\\ 旧的侧栏折叠键在新壳下不再生效", () => {
    expect(globalHotkeyIntent(key({ key: "\\", code: "Backslash", metaKey: true }), IDLE, false)).toBeNull();
  });

  it("isTextFieldTarget 认 input/textarea/contenteditable", () => {
    const input = document.createElement("input");
    const div = document.createElement("div");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isTextFieldTarget(input)).toBe(true);
    expect(isTextFieldTarget(document.createElement("textarea"))).toBe(true);
    expect(isTextFieldTarget(editable)).toBe(true);
    expect(isTextFieldTarget(div)).toBe(false);
    expect(isTextFieldTarget(null)).toBe(false);
  });
});

describe("useGlobalHotkeys —— 装进壳里的行为", () => {
  it("F6 在四栏之间轮转焦点,焦点真的落进对应 region", () => {
    render(<WorkspaceShell />);
    for (const name of ["预览监视器", "镜头带", "检查器", "媒体池"]) {
      press({ key: "F6", code: "F6" });
      const region = document.activeElement?.closest("[role=region]");
      expect(region?.getAttribute("aria-label")).toBe(name);
    }
  });

  it("⇧F6 反向轮转", () => {
    render(<WorkspaceShell />);
    press({ key: "F6", code: "F6", shiftKey: true });
    expect(document.activeElement?.closest("[role=region]")?.getAttribute("aria-label")).toBe("检查器");
  });

  it("折叠的栏被 F6 跳过", () => {
    __resetWorkspaceForTests({ inspectorCollapsed: true, focusedPane: "band" });
    render(<WorkspaceShell />);
    press({ key: "F6", code: "F6" });
    expect(getWorkspaceSnapshot().focusedPane).toBe("pool");
  });

  it("⌘1/⌘2 折叠与展开两侧栏", () => {
    render(<WorkspaceShell />);
    press({ key: "1", code: "Digit1", metaKey: true });
    expect(getWorkspaceSnapshot().poolCollapsed).toBe(true);
    expect(screen.getByRole("button", { name: "展开媒体池" })).toBeTruthy();
    press({ key: "2", code: "Digit2", metaKey: true });
    expect(getWorkspaceSnapshot().inspectorCollapsed).toBe(true);
    press({ key: "1", code: "Digit1", metaKey: true });
    expect(getWorkspaceSnapshot().poolCollapsed).toBe(false);
  });

  it("⌘⏎ 进出沉浸", () => {
    render(<WorkspaceShell />);
    press({ key: "Enter", code: "Enter", metaKey: true });
    expect(getWorkspaceSnapshot().immersive).toBe(true);
    press({ key: "Enter", code: "Enter", metaKey: true });
    expect(getWorkspaceSnapshot().immersive).toBe(false);
  });

  it("⌘, 打开设置 sheet", () => {
    render(<WorkspaceShell />);
    press({ key: ",", code: "Comma", metaKey: true });
    expect(getWorkspaceSnapshot().openDrawer).toBe("settings");
  });

  it("⌘I 打开导入抽屉并落到「来源」分页;光标在搜索框里时不开", () => {
    render(<WorkspaceShell />);
    press({ key: "i", code: "KeyI", metaKey: true });
    expect(getWorkspaceSnapshot().openDrawer).toBe("import");
    expect(getWorkspaceSnapshot().importTab).toBe("source");
  });

  it("⌘I 在输入框里不劫持(与 ⌘, 不同:那条在输入框里也要能用)", () => {
    render(<WorkspaceShell />);
    const input = screen.getByRole("searchbox");
    input.focus();
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "i", code: "KeyI", metaKey: true, bubbles: true, cancelable: true }));
    });
    expect(getWorkspaceSnapshot().openDrawer).toBeNull();
  });

  it("Esc 先退沉浸,再清搜索", () => {
    __resetWorkspaceForTests({ immersive: true, query: "湖" });
    render(<WorkspaceShell />);
    press({ key: "Escape", code: "Escape" });
    expect(getWorkspaceSnapshot().immersive).toBe(false);
    expect(getWorkspaceSnapshot().query).toBe("湖");
    press({ key: "Escape", code: "Escape" });
    expect(getWorkspaceSnapshot().query).toBe("");
  });

  it("有模态开着时 Esc 归模态自己处理,壳一律不抢(否则一次 Esc 退两层)", () => {
    __resetWorkspaceForTests({ immersive: true, query: "湖" });
    render(<WorkspaceShell />);
    pushModal({}); // 模拟抽屉/命令面板/帮助层已入栈
    press({ key: "Escape", code: "Escape" });
    expect(getWorkspaceSnapshot().immersive).toBe(true);
    expect(getWorkspaceSnapshot().query).toBe("湖");
  });

  it("? 打开帮助浮层(懒加载,按下去之前不拉 chunk)", async () => {
    render(<WorkspaceShell />);
    expect(screen.queryByRole("button", { name: "关闭帮助" })).toBeNull();
    press({ key: "?", code: "Slash", shiftKey: true });
    expect(await screen.findByRole("button", { name: "关闭帮助" })).toBeTruthy();
  });
});
