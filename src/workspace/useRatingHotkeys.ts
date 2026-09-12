import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";

import type { RatingAction } from "../SelectPage";
import type { ShotStackUserState } from "../api";
import { dispatchWorkspace, useWorkspace } from "./WorkspaceStore";

export type HotkeyIntent =
  | { kind: "rating"; action: RatingAction }
  | { kind: "stack-state"; state: ShotStackUserState }
  | { kind: "promote-hero" }
  | { kind: "toggle-takes" }
  | { kind: "move-take"; direction: -1 | 1 }
  | { kind: "move-selection"; direction: -1 | 1 }
  | { kind: "toggle-playback" };

export interface RatingHotkeyHandlers {
  onRating(action: RatingAction): void | Promise<void>;
  onStackState(state: ShotStackUserState): void | Promise<void>;
  onPromoteHero(): void | Promise<void>;
  onToggleTakes(): void;
  onMoveTake(direction: -1 | 1): void;
  onMoveSelection(direction: -1 | 1): void;
  onTogglePlayback(): void;
}

/**
 * 沿用 `SelectPage.tsx:80` 的语义:只认「事件目标就是容器本身」。容器里的搜索框、
 * 按钮、输入框拿到的键一律不接管 —— 这条判定就是「不要在输入框里评级」的全部实现,
 * 不要改成 `closest("input")` 之类的黑名单,那样会漏掉 contenteditable 与自定义控件。
 */
function isPaneShortcutTarget(target: EventTarget | null, pane: EventTarget | null): boolean {
  return target === pane;
}

/**
 * 中文输入法会把字母/数字键吃成候选(`event.key` 变成 `Process`),但物理键 `code`
 * 不受影响 —— 评级键位因此不需要用户切回英文输入法。
 */
function physicalKey(event: Pick<KeyboardEvent, "key" | "code">): string {
  const code = event.code;
  if (code.startsWith("Key") && code.length === 4) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  return event.key;
}

/** 纯函数:一次 keydown 该做什么。composing=true 时单键一律返回 null(IME 组合保护)。 */
export function ratingHotkeyIntent(
  event: Pick<globalThis.KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey">,
  composing: boolean,
): HotkeyIntent | null {
  if (composing) return null;
  // ⌘/Ctrl 组合是壳的键位(⌘1/⌘2 折叠栏、⌘⏎ 全屏沉浸),一个都不能落进评级。
  if (event.metaKey || event.ctrlKey) return null;

  const key = physicalKey(event);
  const lower = key.toLowerCase();

  if (lower === "f") return { kind: "rating", action: { kind: "binary", value: 1 } };
  if (lower === "x") return { kind: "rating", action: { kind: "binary", value: -1 } };
  if (lower === "0") return { kind: "rating", action: { kind: "clear" } };
  if (/^[1-5]$/.test(lower)) {
    return { kind: "rating", action: { kind: "star", value: Number(lower) as 1 | 2 | 3 | 4 | 5 } };
  }
  if (lower === "l") return { kind: "stack-state", state: "locked" };
  if (lower === "r") return { kind: "stack-state", state: "rejected" };

  switch (event.key) {
    case "Enter":
      return { kind: "promote-hero" };
    case "Tab":
      return { kind: "toggle-takes" };
    case "ArrowUp":
      return { kind: "move-take", direction: -1 };
    case "ArrowDown":
      return { kind: "move-take", direction: 1 };
    case "ArrowLeft":
      return { kind: "move-selection", direction: -1 };
    case "ArrowRight":
      return { kind: "move-selection", direction: 1 };
    case " ":
    case "Spacebar":
      return { kind: "toggle-playback" };
    default:
      return null;
  }
}

// 「中文输入法组合中」要显示在状态条右槽,而状态条不是这两栏的祖先 —— 用一个
// 模块级的小订阅把真值送过去,免得为一条提示语在整棵树上串 prop。
let composingPanes = 0;
const composingListeners = new Set<() => void>();

function setComposingPane(active: boolean): void {
  const next = Math.max(0, composingPanes + (active ? 1 : -1));
  if (next === composingPanes) return;
  composingPanes = next;
  for (const listener of [...composingListeners]) listener();
}

/** 状态条用它读「此刻是否有栏正在 IME 组合」。 */
export function useComposingIndicator(): boolean {
  return useSyncExternalStore(
    (listener) => {
      composingListeners.add(listener);
      return () => composingListeners.delete(listener);
    },
    () => composingPanes > 0,
    () => false,
  );
}

export function __resetComposingForTests(): void {
  composingPanes = 0;
  for (const listener of [...composingListeners]) listener();
}

export function useRatingHotkeys(
  pane: "pool" | "band",
  handlers: RatingHotkeyHandlers,
): {
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  onCompositionStart(): void;
  onCompositionEnd(): void;
  onFocus(): void;
  composing: boolean;
} {
  const focusedPane = useWorkspace((state) => state.focusedPane);
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  // handlers 常常是行内对象;用 ref 读它,免得 onKeyDown 每次渲染都换身份。
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!isPaneShortcutTarget(event.target, event.currentTarget)) return;
      if (focusedPane !== pane) return;
      const native = event.nativeEvent;
      const isComposing = composingRef.current || native.isComposing || native.keyCode === 229;
      const intent = ratingHotkeyIntent(
        {
          key: event.key,
          code: event.code,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
        },
        isComposing,
      );
      if (!intent) return;
      event.preventDefault();
      const current = handlersRef.current;
      switch (intent.kind) {
        case "rating":
          void current.onRating(intent.action);
          return;
        case "stack-state":
          void current.onStackState(intent.state);
          return;
        case "promote-hero":
          void current.onPromoteHero();
          return;
        case "toggle-takes":
          current.onToggleTakes();
          return;
        case "move-take":
          current.onMoveTake(intent.direction);
          return;
        case "move-selection":
          current.onMoveSelection(intent.direction);
          return;
        case "toggle-playback":
          current.onTogglePlayback();
      }
    },
    [focusedPane, pane],
  );

  const onCompositionStart = useCallback(() => {
    if (composingRef.current) return;
    composingRef.current = true;
    setComposing(true);
    setComposingPane(true);
  }, []);

  const onCompositionEnd = useCallback(() => {
    if (!composingRef.current) return;
    composingRef.current = false;
    setComposing(false);
    setComposingPane(false);
  }, []);

  const onFocus = useCallback(() => {
    dispatchWorkspace({ type: "focus-pane", pane });
  }, [pane]);

  // 组合中途把栏卸载掉(切 bandMode、折叠媒体池)时 compositionend 永远不会来,
  // 计数不还回去的话状态条会永久挂着「中文输入法组合中」。
  useEffect(() => () => {
    if (composingRef.current) {
      composingRef.current = false;
      setComposingPane(false);
    }
  }, []);

  return { onKeyDown, onCompositionStart, onCompositionEnd, onFocus, composing };
}
