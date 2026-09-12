import { useEffect } from "react";

import { isAnyModalOpen } from "./modalStack";
import {
  dispatchWorkspace,
  getWorkspaceSnapshot,
  useWorkspace,
  type PaneId,
  type WorkspaceState,
} from "./WorkspaceStore";

/**
 * 规格 §3.2 的全局键位表。判定与副作用分开:`globalHotkeyIntent` 是纯函数
 * (一次按键该做什么),`useGlobalHotkeys` 只负责把 intent 翻成 dispatch。
 */
export type GlobalHotkeyIntent =
  | { kind: "command-palette" }
  | { kind: "settings" }
  | { kind: "import" }
  | { kind: "toggle-pane"; pane: "pool" | "inspector" }
  | { kind: "immersive" }
  | { kind: "help" }
  | { kind: "cycle-pane"; direction: 1 | -1 }
  | { kind: "escape"; target: "drawer" | "sheet" | "immersive" | "query" | null };

export type GlobalHotkeyState = Pick<WorkspaceState, "openDrawer" | "immersive" | "query">;

/**
 * 焦点是不是落在能打字的地方。用 tagName + contenteditable,不用元素白名单 ——
 * 黑名单式的 `closest("input")` 会漏掉 contenteditable 和自定义控件。
 */
export function isTextFieldTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // jsdom 不实现 isContentEditable(永远 undefined),所以属性也得看一眼。
  const attribute = target.getAttribute("contenteditable");
  return target.isContentEditable === true || attribute === "" || attribute === "true";
}

/** Esc 的四级优先级(规格 §3.2):抽屉 → 设置 sheet → 沉浸 → 清搜索。 */
function escapeTarget(state: GlobalHotkeyState): GlobalHotkeyIntent {
  if (state.openDrawer === "import" || state.openDrawer === "deliver") {
    return { kind: "escape", target: "drawer" };
  }
  if (state.openDrawer === "settings") return { kind: "escape", target: "sheet" };
  if (state.immersive) return { kind: "escape", target: "immersive" };
  if (state.query !== "") return { kind: "escape", target: "query" };
  return { kind: "escape", target: null };
}

/** 纯函数:这一次 keydown 对应哪条全局键位;不认识的一律 null(交给栏内自己的键位)。 */
export function globalHotkeyIntent(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey">,
  state: GlobalHotkeyState,
  inTextField: boolean,
): GlobalHotkeyIntent | null {
  // Esc 和 F6 在输入框里照样要响应:一个是「退出当前层」,一个是「换栏」,
  // 两者都不是在打字。其余裸键在输入框里一律让位。
  if (event.key === "Escape") return escapeTarget(state);
  if (event.key === "F6") return { kind: "cycle-pane", direction: event.shiftKey ? -1 : 1 };

  const mod = event.metaKey || event.ctrlKey;
  if (mod) {
    // ⌘/Ctrl 组合在输入框里也要能用 —— ⌘, 开设置不该因为光标在搜索框就失灵。
    const digit = event.code === "Digit1" ? "1" : event.code === "Digit2" ? "2" : event.key;
    if (digit === "1") return { kind: "toggle-pane", pane: "pool" };
    if (digit === "2") return { kind: "toggle-pane", pane: "inspector" };
    if (event.key === "Enter") return { kind: "immersive" };
    if (event.key === ",") return { kind: "settings" };
    // ⌘I 开导入抽屉(顶栏「导入素材」上的键帽提示)。输入框里让位 —— ⌘I 在文本框里
    // 是斜体 / 输入法的键,不该被壳抢走;⌘, 不受这条限制。
    if (!inTextField && (event.key.toLowerCase() === "i" || event.code === "KeyI")) return { kind: "import" };
    if (event.key.toLowerCase() === "k" || event.code === "KeyK") return { kind: "command-palette" };
    // ⌘\ 是旧壳的侧栏折叠键。新壳没有侧栏,这里显式什么都不做 —— 不写这一条,
    // 它会顺着掉进下面的裸键分支,将来某天被误认成别的键位。
    return null;
  }

  if (inTextField) return null;
  if (event.key === "?") return { kind: "help" };
  // 空格归镜头带/监视器自己管(useRatingHotkeys),壳不劫持。
  return null;
}

/** F6 之后把真正的 DOM 焦点送进那一栏的 landmark。 */
function focusPaneRegion(pane: PaneId): void {
  const region = document.querySelector<HTMLElement>(`[data-pane="${pane}"]`);
  region?.focus();
}

/**
 * 把全局键位挂到 window 上。**Esc 只处理沉浸与搜索两级** —— 抽屉/设置 sheet/
 * 命令面板/帮助浮层各自在模态栈上,由栈顶那层自己关;栈非空时本 hook 整个让开,
 * 否则一次 Esc 会同时退掉模态和它下面的沉浸。
 */
export function useGlobalHotkeys(): void {
  const openDrawer = useWorkspace((state) => state.openDrawer);
  const immersive = useWorkspace((state) => state.immersive);
  const query = useWorkspace((state) => state.query);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const intent = globalHotkeyIntent(
        event,
        { openDrawer, immersive, query },
        isTextFieldTarget(event.target),
      );
      if (intent === null) return;

      switch (intent.kind) {
        case "escape": {
          if (isAnyModalOpen()) return; // 栈顶那层自己关
          if (intent.target === "immersive") {
            event.preventDefault();
            dispatchWorkspace({ type: "set-immersive", immersive: false });
          } else if (intent.target === "query") {
            event.preventDefault();
            dispatchWorkspace({ type: "set-query", query: "" });
          }
          return;
        }
        case "cycle-pane": {
          event.preventDefault();
          dispatchWorkspace({ type: "cycle-pane-focus", direction: intent.direction });
          focusPaneRegion(getWorkspaceSnapshot().focusedPane);
          return;
        }
        case "toggle-pane":
          event.preventDefault();
          dispatchWorkspace({ type: "toggle-pane", pane: intent.pane });
          return;
        case "immersive":
          event.preventDefault();
          dispatchWorkspace({ type: "set-immersive", immersive: !immersive });
          return;
        case "settings":
          event.preventDefault();
          dispatchWorkspace({ type: "open-drawer", drawer: "settings" });
          return;
        case "import":
          event.preventDefault();
          dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "source" });
          return;
        case "help":
          event.preventDefault();
          window.dispatchEvent(new CustomEvent("tripcut:open-help"));
          return;
        case "command-palette":
          // ⌘K 由 CommandPalette 自己听(它要 toggle 自己的本地 open 状态)。
          // 这里认它只是为了让键位表完整,不重复派发,否则一次 ⌘K 开了又关。
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openDrawer, immersive, query]);
}
