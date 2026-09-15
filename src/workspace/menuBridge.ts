import { useEffect } from "react";

import { NOTHING_TO_UNDO_TOAST, undoneToast } from "./copy";
import { failureText } from "./errorText";
import { isAnyModalOpen } from "./modalStack";
import { openSettings } from "./openSettings";
import { showToast } from "./ui/toastStore";
import { takeStoryUndoSuffix } from "./storyUndo";
import { runUndo } from "./undoStack";
import { runUpdateCheck } from "./update/updateStore";
import { isTextFieldTarget } from "./useGlobalHotkeys";
import { dispatchWorkspace } from "./WorkspaceStore";

/**
 * R18 车道 native / M-01:原生菜单栏(`src-tauri/src/menu.rs`)的点击事件落到这里。
 *
 * 菜单**不新增第二套动作定义**——每一条都调用界面上已经有的那个入口
 * (设置 sheet / 导入抽屉 / 导出抽屉 / 命令面板 / 帮助浮层 / `undoStack`),
 * 菜单只是第二个入口。
 *
 * 为什么撤销要绕这一圈:macOS 的 key-equivalent 派发发生在
 * `NSApplication sendEvent:` → 主菜单 `performKeyEquivalent:`,**早于** WKWebView 的
 * `keydown`。默认菜单里那条启用状态的 `Edit ▸ Undo` 会把 ⌘Z 整个吃掉,
 * 于是 `useGlobalHotkeys` 的 ⌘Z 分支永远收不到事件(R18 头脑风暴 §1.2 实测)。
 * 所以菜单里的撤销/重做是自定义项,按下去只发事件,由这里判断:
 * 焦点在能打字的地方 → 让文本框自己撤销(`document.execCommand`);否则走应用撤销栈。
 */
export const MENU_EVENT = "tripcut:menu";

export type MenuAction =
  | "about"
  | "check-update"
  | "settings"
  | "import"
  | "export"
  | "undo"
  | "redo"
  | "command-palette"
  | "help-manual"
  | "help-shortcuts";

const ACTIONS: readonly string[] = [
  "about",
  "check-update",
  "settings",
  "import",
  "export",
  "undo",
  "redo",
  "command-palette",
  "help-manual",
  "help-shortcuts",
];

export function isMenuAction(value: unknown): value is MenuAction {
  return typeof value === "string" && ACTIONS.includes(value);
}

/** 文本框里的撤销/重做交还给系统;jsdom 没有 execCommand,缺了就当没发生。 */
function textFieldEdit(command: "undo" | "redo"): boolean {
  const target = typeof document === "undefined" ? null : document.activeElement;
  if (!isTextFieldTarget(target)) return false;
  const execCommand = (document as Document & { execCommand?: (name: string) => boolean }).execCommand;
  if (typeof execCommand === "function") execCommand.call(document, command);
  return true;
}

function runAppUndo(): void {
  // 模态开着(改名输入框等)让给那一层,与 ⌘Z 的键盘分支同一条规矩。
  if (isAnyModalOpen()) return;
  void runUndo()
    .then((entry) =>
      showToast(entry ? `${undoneToast(entry.label)}${takeStoryUndoSuffix()}` : NOTHING_TO_UNDO_TOAST, {
        tone: entry ? "success" : "neutral",
      }),
    )
    .catch((error) => showToast(failureText("撤销", error), { tone: "danger" }));
}

/**
 * 一条菜单动作该做什么。纯分发,没有自己的状态——所以能被单测按动作逐条判定。
 * 未知 id 一律忽略(菜单加了新项而前端还没跟上时,宁可什么都不做)。
 */
export function runMenuAction(action: string): void {
  if (!isMenuAction(action)) return;
  switch (action) {
    case "about":
      openSettings("about");
      return;
    case "check-update":
      // 结果(有新版本 / 已是最新 / 检查失败)由设置 › 关于那一段显示,所以先把它打开。
      openSettings("about");
      void runUpdateCheck("manual").catch(() => undefined);
      return;
    case "settings":
      dispatchWorkspace({ type: "open-drawer", drawer: "settings" });
      return;
    case "import":
      dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "source" });
      return;
    case "export":
      dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
      return;
    case "undo":
      if (textFieldEdit("undo")) return;
      runAppUndo();
      return;
    case "redo":
      if (textFieldEdit("redo")) return;
      // 应用级的重做还没有(R16 只做了撤销栈);说一句实话,不装作做了什么。
      showToast("这一步不能重做", { tone: "neutral" });
      return;
    case "command-palette":
      window.dispatchEvent(new CustomEvent("tripcut:open-command-palette"));
      return;
    case "help-manual":
    case "help-shortcuts":
      // 快捷键表就在帮助浮层里(`HelpOverlay` 没有分主题的入口)。
      window.dispatchEvent(new CustomEvent("tripcut:open-help"));
  }
}

/**
 * 挂上 Tauri 事件监听;非 Tauri 环境(vitest / `vite --mode mock`)静默退化为 no-op,
 * 与 `bridgeMusicAnalyzedEvents` 同一套约定。
 */
export async function startMenuBridge(): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<string>(MENU_EVENT, (event) => runMenuAction(event.payload));
  } catch {
    return () => undefined;
  }
}

/** 壳里挂一次即可。 */
export function useMenuBridge(): void {
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void startMenuBridge().then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
}
