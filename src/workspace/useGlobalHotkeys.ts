import { useEffect } from "react";

import { KEYMAP_ACTION_BY_ID, lookupAction, type KeymapIndex } from "./keymap";
import { getKeymap } from "./keymapStore";
import { isHomeOpen } from "./homeStore";
import { isAnyModalOpen } from "./modalStack";
import { NOTHING_TO_UNDO_TOAST, undoneToast } from "./copy";
import { failureText } from "./errorText";
import { showToast } from "./ui/toastStore";
import { takeStoryUndoSuffix } from "./storyUndo";
import { runUndo } from "./undoStack";
import {
  dispatchWorkspace,
  getWorkspaceSnapshot,
  useWorkspace,
  type PaneId,
  type WorkspaceState,
} from "./WorkspaceStore";

/**
 * 规格 §3.2 的全局键位。判定与副作用分开:`globalHotkeyIntent` 是纯函数
 * (一次按键该做什么),`useGlobalHotkeys` 只负责把 intent 翻成 dispatch。
 */
export type GlobalHotkeyIntent =
  | { kind: "command-palette" }
  | { kind: "settings" }
  | { kind: "import" }
  | { kind: "toggle-pane"; pane: "pool" | "inspector" }
  | { kind: "immersive" }
  | { kind: "help" }
  | { kind: "export" }
  | { kind: "switch-episode" }
  | { kind: "undo" }
  | { kind: "cycle-pane"; direction: 1 | -1 }
  | { kind: "escape"; target: "drawer" | "sheet" | "immersive" | "query" | "inspector" | null };

export type GlobalHotkeyState = Pick<WorkspaceState, "openDrawer" | "immersive" | "query"> &
  /** R19 V-04:Esc 第五级 —— 收起没钉住的检查器滑出层。旧调用点不传就当它没开着。 */
  Partial<Pick<WorkspaceState, "inspectorPinned" | "inspectorDismissed" | "selection">>;

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

/**
 * 焦点「不在任何控件上」(body / html / null)。R13 真机 Y-09:原生 mpv 视图压在 WKWebView 之上,
 * 点视频画面本身 DOM 收不到点击、焦点落回 body,此后空格没人接 —— 剪映用户的肌肉记忆是
 * 「空格随时播/停」。这种孤儿焦点下的空格由壳兜底(见 useGlobalHotkeys)。
 */
export function isOrphanFocusTarget(target: EventTarget | null): boolean {
  if (target === null || target === window || target === document) return true;
  return target === document.body || target === document.documentElement;
}

/** Esc 的五级优先级(规格 §3.2 + R19 V-04):抽屉 → 设置 sheet → 沉浸 → 清搜索 → 收起检查器滑出层。 */
function escapeTarget(state: GlobalHotkeyState): GlobalHotkeyIntent {
  if (state.openDrawer === "import" || state.openDrawer === "deliver") {
    return { kind: "escape", target: "drawer" };
  }
  if (state.openDrawer === "settings") return { kind: "escape", target: "sheet" };
  if (state.immersive) return { kind: "escape", target: "immersive" };
  if (state.query !== "") return { kind: "escape", target: "query" };
  const inspectorOpen = state.inspectorDismissed !== true && (state.inspectorPinned === true || (state.selection ?? null) !== null);
  if (inspectorOpen && state.inspectorPinned !== true) return { kind: "escape", target: "inspector" };
  return { kind: "escape", target: null };
}

/**
 * 纯函数:这一次 keydown 对应哪条全局键位;不认识的一律 null(交给栏内自己的键位)。
 * R13 §1:改为查键位表(`keymap.ts`,默认剪映预设),键本身不再写死在这里。
 */
export function globalHotkeyIntent(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey"> & Partial<Pick<KeyboardEvent, "altKey">>,
  state: GlobalHotkeyState,
  inTextField: boolean,
  index: KeymapIndex = getKeymap().index,
): GlobalHotkeyIntent | null {
  const action = lookupAction(index, "global", event);
  if (action === null) return null;
  // Esc、F6、⌘ 组合在输入框里照样要响(退层 / 换栏 / 开设置都不是在打字);
  // 裸键(? 帮助)与 ⌘I(文本框里是斜体 / 输入法的键)在输入框里让位。
  if (inTextField && !KEYMAP_ACTION_BY_ID.get(action)?.inTextField) return null;
  switch (action) {
    case "escape":
      return escapeTarget(state);
    case "cycle-pane":
      return { kind: "cycle-pane", direction: 1 };
    case "cycle-pane-back":
      return { kind: "cycle-pane", direction: -1 };
    case "toggle-pool":
      return { kind: "toggle-pane", pane: "pool" };
    case "toggle-inspector":
      return { kind: "toggle-pane", pane: "inspector" };
    case "fullscreen":
      return { kind: "immersive" };
    case "settings":
      return { kind: "settings" };
    case "import":
      return { kind: "import" };
    case "command-palette":
      return { kind: "command-palette" };
    case "help":
      return { kind: "help" };
    case "export":
      return { kind: "export" };
    case "switch-episode":
      return { kind: "switch-episode" };
    case "undo":
      // R16 P2-2:⌘Z 接全局撤销栈(undoStack.ts);redo 仍只登记键。
      return { kind: "undo" };
    default:
      return null;
  }
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
  const inspectorPinned = useWorkspace((state) => state.inspectorPinned);
  const inspectorDismissed = useWorkspace((state) => state.inspectorDismissed);
  const selection = useWorkspace((state) => state.selection);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Y-09:焦点在 body(点过原生视频画面)时,监视器 / 媒体池的「播放 / 暂停」键由壳兜底:
      // 把焦点交给监视器栏(之后 I/O/JKL 都有人接),这一下直接广播播放/暂停。
      // 模态开着、首页盖着(三栏 inert)、沉浸态(播放器自己接键)、焦点在控件上时都不抢。
      if (
        !isAnyModalOpen() &&
        !isHomeOpen() &&
        !immersive &&
        isOrphanFocusTarget(event.target) &&
        lookupAction(getKeymap().index, "monitor", event) === "play-pause"
      ) {
        event.preventDefault();
        focusPaneRegion("monitor");
        window.dispatchEvent(new CustomEvent("tripcut:toggle-playback"));
        return;
      }
      const intent = globalHotkeyIntent(
        event,
        { openDrawer, immersive, query, inspectorPinned, inspectorDismissed, selection },
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
          } else if (intent.target === "inspector") {
            event.preventDefault();
            dispatchWorkspace({ type: "toggle-pane", pane: "inspector" });
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
        case "export":
          event.preventDefault();
          dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
          return;
        case "switch-episode":
          event.preventDefault();
          window.dispatchEvent(new CustomEvent("tripcut:open-episode-switcher"));
          return;
        case "undo":
          // 模态开着(输入框改名等)让给那一层;工作区里 ⌘Z 弹栈顶一条,空栈说一句。
          if (isAnyModalOpen()) return;
          event.preventDefault();
          void runUndo()
            .then((entry) => showToast(entry ? `${undoneToast(entry.label)}${takeStoryUndoSuffix()}` : NOTHING_TO_UNDO_TOAST, { tone: entry ? "success" : "neutral" }))
            .catch((error) => showToast(failureText("撤销", error), { tone: "danger" }));
          return;
        case "command-palette":
          // ⌘K 由 CommandPalette 自己听(它要 toggle 自己的本地 open 状态)。
          // 这里认它只是为了让键位表完整,不重复派发,否则一次 ⌘K 开了又关。
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openDrawer, immersive, query, inspectorPinned, inspectorDismissed, selection]);
}
