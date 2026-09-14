import { useSyncExternalStore } from "react";

/**
 * R12 §3 反馈系统的状态层:全应用只有**一条** toast(新来的顶掉旧的),3–5 秒自动消失,
 * 最多带一个动作。组件(`Toast.tsx` 的 `ToastHost`)只负责画;谁都可以在任何地方
 * `showToast(...)`——自动挑选 / 撤销 / 排入 / 导出完成与失败全走这一条路,镜头带底部
 * 那行 12px 小字因此退役。
 */

export type ToastTone = "neutral" | "success" | "danger";

export interface ToastAction {
  label: string;
  onClick(): void;
}

export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
  action: ToastAction | null;
  durationMs: number;
}

export interface ToastOptions {
  tone?: ToastTone;
  action?: ToastAction;
  /** 停留时长;夹在 3–5 秒之间(带动作的默认 5 秒,不带的 4 秒)。 */
  durationMs?: number;
}

export const TOAST_MIN_MS = 3_000;
export const TOAST_MAX_MS = 5_000;
export const TOAST_DEFAULT_MS = 4_000;
export const TOAST_WITH_ACTION_MS = 5_000;

const clampDuration = (value: number): number => Math.min(TOAST_MAX_MS, Math.max(TOAST_MIN_MS, Math.round(value)));

let current: ToastItem | null = null;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** 显示一条 toast(顶掉现有的那条),返回它的 id。 */
export function showToast(text: string, options: ToastOptions = {}): number {
  clearTimer();
  const id = nextId;
  nextId += 1;
  const durationMs = clampDuration(options.durationMs ?? (options.action ? TOAST_WITH_ACTION_MS : TOAST_DEFAULT_MS));
  current = { id, text, tone: options.tone ?? "neutral", action: options.action ?? null, durationMs };
  timer = setTimeout(() => {
    if (current?.id === id) {
      current = null;
      timer = null;
      emit();
    }
  }, durationMs);
  emit();
  return id;
}

/** 关掉当前 toast;传 id 时只在它还是当前那条时才关(动作回调里用,免得关掉后来者)。 */
export function dismissToast(id?: number): void {
  if (current === null) return;
  if (id !== undefined && current.id !== id) return;
  clearTimer();
  current = null;
  emit();
}

export function getToastSnapshot(): ToastItem | null {
  return current;
}

export function subscribeToast(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useToast(): ToastItem | null {
  return useSyncExternalStore(subscribeToast, getToastSnapshot, getToastSnapshot);
}

/** 测试用:清空状态与计时器。 */
export function __resetToastsForTests(): void {
  clearTimer();
  current = null;
  nextId = 1;
  emit();
}
