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
import { lookupAction, type KeymapIndex } from "./keymap";
import { getKeymap } from "./keymapStore";
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

const EDITABLE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);

/** 能打字/能选值的控件:input、textarea、select、contenteditable、textbox 类角色。 */
function isEditableTarget(target: HTMLElement): boolean {
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  const editable = target.getAttribute("contenteditable");
  if (target.isContentEditable === true || editable === "" || editable === "true") return true;
  const role = target.getAttribute("role");
  return role !== null && EDITABLE_ROLES.has(role);
}

/** 自己有激活键(Enter/Space)的普通控件:按钮、链接、菜单项。gridcell/row 不算。 */
export function isActivatableControl(target: HTMLElement): boolean {
  const role = target.getAttribute("role");
  if (role === "gridcell" || role === "row") return false;
  if (role === "button" || role === "link" || role === "menuitem" || role === "tab") return true;
  return target.tagName === "BUTTON" || target.tagName === "A";
}

/**
 * 目标判定(U-01,R10)。R8 沿用 `SelectPage.tsx:80` 的「事件目标就是容器本身」,
 * R9 把卡片改成可聚焦的 `<button role=gridcell>` 之后焦点永远落在卡片上、不再等于
 * 容器 —— 真机上 F/X/1–5/Space 全哑就是这一条造成的。现在认「容器本身,或容器内
 * 任何**非编辑**控件」;输入框、textarea、select、contenteditable、textbox/searchbox/
 * combobox 角色一律不接管 —— 「不要在输入框里评级」仍然成立。
 */
export function isPaneShortcutTarget(target: EventTarget | null, pane: EventTarget | null): boolean {
  if (target === pane) return true;
  if (!(target instanceof HTMLElement) || !(pane instanceof Node) || !pane.contains(target)) return false;
  return !isEditableTarget(target);
}

/**
 * 栏内的普通按钮(不是 gridcell)自己要用 Enter/Space 激活 —— 这两个键留给按钮,
 * 其余单键(F/X/1–5/Tab/方向键)照常接管。
 */
function reservedForControl(target: EventTarget | null, intent: HotkeyIntent): boolean {
  if (!(target instanceof HTMLElement) || !isActivatableControl(target)) return false;
  return intent.kind === "promote-hero" || intent.kind === "toggle-playback";
}

/**
 * 中文输入法会把字母/数字键吃成候选(`event.key` 变成 `Process`),但物理键 `code`
 * 不受影响 —— 评级键位因此不需要用户切回英文输入法。
 */
export function physicalKey(event: Pick<KeyboardEvent, "key" | "code">): string {
  const code = event.code;
  if (code.startsWith("Key") && code.length === 4) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  return event.key;
}

/**
 * 纯函数:一次 keydown 该做什么。composing=true 时单键一律返回 null(IME 组合保护)。
 * R13 §1:改为查键位表(`keymap.ts` 的 `pool` 栏;默认剪映预设 F/X/1–5/0/L/R/Tab/↑↓/←→/空格/K)。
 */
export function ratingHotkeyIntent(
  event: Pick<globalThis.KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey"> & Partial<Pick<globalThis.KeyboardEvent, "altKey">>,
  composing: boolean,
  index: KeymapIndex = getKeymap().index,
): HotkeyIntent | null {
  if (composing) return null;
  const action = lookupAction(index, "pool", event);
  switch (action) {
    case "favorite":
      return { kind: "rating", action: { kind: "binary", value: 1 } };
    case "reject":
      return { kind: "rating", action: { kind: "binary", value: -1 } };
    case "clear-rating":
      return { kind: "rating", action: { kind: "clear" } };
    case "star-1":
    case "star-2":
    case "star-3":
    case "star-4":
    case "star-5":
      return { kind: "rating", action: { kind: "star", value: Number(action.slice(-1)) as 1 | 2 | 3 | 4 | 5 } };
    case "lock-stack":
      return { kind: "stack-state", state: "locked" };
    case "reject-stack":
      return { kind: "stack-state", state: "rejected" };
    case "promote-hero":
      return { kind: "promote-hero" };
    case "expand-stack":
      return { kind: "toggle-takes" };
    case "prev-take":
      return { kind: "move-take", direction: -1 };
    case "next-take":
      return { kind: "move-take", direction: 1 };
    case "prev-clip":
      return { kind: "move-selection", direction: -1 };
    case "next-clip":
      return { kind: "move-selection", direction: 1 };
    case "play-pause":
    case "shuttle-pause":
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
          altKey: event.altKey,
        },
        isComposing,
      );
      if (!intent) return;
      if (reservedForControl(event.target, intent)) return;
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
