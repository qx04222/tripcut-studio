import { useEffect, useRef, type RefObject } from "react";

import { isActivatableControl, isPaneShortcutTarget, physicalKey } from "./useRatingHotkeys";
import { dispatchWorkspace, getWorkspaceSnapshot } from "./WorkspaceStore";

/**
 * 监视器栏的单键(R10 R-01):传输条上画着 `Kbd I` / `Kbd O`,帮助页也列了播放键,
 * 但新壳只把打点挂在按钮上 —— F6 聚焦监视器后按 I / O / ← / → 全无反应。
 * 键位与沉浸态 `PlayerOverlay` 一致:I/O 打点,←/→ ±1 s(同传输条的两枚按钮),
 * J/K/L 穿梭,空格播放/暂停。目标判定沿用媒体池那套:栏 landmark 本身或栏内任何
 * 非编辑控件;输入框/滑杆不接管;空格留给按钮自己。
 */
export type MonitorHotkeyIntent =
  | { kind: "mark"; edge: "in" | "out" }
  | { kind: "nudge"; seconds: -5 | -1 | 1 | 5 }
  | { kind: "shuttle"; key: "j" | "k" | "l" }
  | { kind: "toggle-playback" }
  // R11 §1.2 / §3 追加:建议段(Enter 采纳、N/⇧N 切换)、逐帧(, / .)、⌥←/→ ±5 s、
  // ⇧L 入出区间循环、S 保存(沉浸态早就有,嵌入态此前只有按钮)。
  | { kind: "adopt-suggestion" }
  | { kind: "step-suggestion"; direction: 1 | -1 }
  | { kind: "frame"; direction: 1 | -1 }
  | { kind: "toggle-loop" }
  | { kind: "save" };

export interface MonitorHotkeyHandlers {
  onMark(edge: "in" | "out"): void;
  onNudge(seconds: -5 | -1 | 1 | 5): void;
  onShuttle(key: "j" | "k" | "l"): void;
  onTogglePlayback(): void;
  onAdoptSuggestion?(): void;
  onStepSuggestion?(direction: 1 | -1): void;
  onFrame?(direction: 1 | -1): void;
  onToggleLoop?(): void;
  onSave?(): void;
}

type HotkeyEvent = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey"> & Partial<Pick<KeyboardEvent, "shiftKey" | "altKey">>;

/** 纯函数:一次 keydown 该做什么。composing=true(IME 组合中)与 ⌘/Ctrl 组合一律 null。 */
export function monitorHotkeyIntent(event: HotkeyEvent, composing: boolean): MonitorHotkeyIntent | null {
  if (composing || event.metaKey || event.ctrlKey) return null;
  const key = physicalKey(event).toLowerCase();
  const shift = event.shiftKey === true;
  const alt = event.altKey === true;
  switch (key) {
    case "i":
      return { kind: "mark", edge: "in" };
    case "o":
      return { kind: "mark", edge: "out" };
    case "l":
      return shift ? { kind: "toggle-loop" } : { kind: "shuttle", key };
    case "j":
    case "k":
      return { kind: "shuttle", key };
    case "n":
      return { kind: "step-suggestion", direction: shift ? -1 : 1 };
    case "s":
      return { kind: "save" };
    case "arrowleft":
      return { kind: "nudge", seconds: alt ? -5 : -1 };
    case "arrowright":
      return { kind: "nudge", seconds: alt ? 5 : 1 };
    case ",":
      return { kind: "frame", direction: -1 };
    case ".":
      return { kind: "frame", direction: 1 };
    case "enter":
      return { kind: "adopt-suggestion" };
    case " ":
    case "spacebar":
      return { kind: "toggle-playback" };
    default:
      return null;
  }
}

/** 栏的作用域:壳里的 `[data-pane="monitor"]` landmark(F6 的焦点落点);没有壳时就是监视器根节点。 */
function paneScope(root: HTMLElement | null): HTMLElement | null {
  return root?.closest<HTMLElement>('[data-pane="monitor"]') ?? root;
}

/**
 * 挂在 document 上而不是监视器根节点上:F6 把 DOM 焦点送到壳里的栏 landmark,
 * 那是监视器的**祖先**,根节点的 onKeyDown 收不到。栏内任何地方拿到焦点
 * (点按钮、点画面)都把 focusedPane 切成 monitor,与媒体池 / 镜头带同规则。
 */
export function useMonitorHotkeys(rootRef: RefObject<HTMLElement | null>, handlers: MonitorHotkeyHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const scope = paneScope(rootRef.current);
      if (!scope || !(event.target instanceof Node) || !scope.contains(event.target)) return;
      if (getWorkspaceSnapshot().focusedPane !== "monitor") dispatchWorkspace({ type: "focus-pane", pane: "monitor" });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const scope = paneScope(rootRef.current);
      if (!scope || !isPaneShortcutTarget(event.target, scope)) return;
      if (getWorkspaceSnapshot().focusedPane !== "monitor") return;
      const intent = monitorHotkeyIntent(event, event.isComposing || event.keyCode === 229);
      if (!intent) return;
      // 空格与 Enter 留给按钮 / 链接自己激活 —— 焦点在「保存片段」上按 Enter 是点它,不是采纳建议。
      if (
        (intent.kind === "toggle-playback" || intent.kind === "adopt-suggestion") &&
        event.target instanceof HTMLElement &&
        isActivatableControl(event.target)
      ) {
        return;
      }
      const current = handlersRef.current;
      switch (intent.kind) {
        case "adopt-suggestion":
          if (!current.onAdoptSuggestion) return;
          event.preventDefault();
          current.onAdoptSuggestion();
          return;
        case "step-suggestion":
          event.preventDefault();
          current.onStepSuggestion?.(intent.direction);
          return;
        case "frame":
          event.preventDefault();
          current.onFrame?.(intent.direction);
          return;
        case "toggle-loop":
          event.preventDefault();
          current.onToggleLoop?.();
          return;
        case "save":
          event.preventDefault();
          current.onSave?.();
          return;
        default:
          break;
      }
      event.preventDefault();
      switch (intent.kind) {
        case "mark":
          current.onMark(intent.edge);
          return;
        case "nudge":
          current.onNudge(intent.seconds);
          return;
        case "shuttle":
          current.onShuttle(intent.key);
          return;
        case "toggle-playback":
          current.onTogglePlayback();
      }
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [rootRef]);
}
