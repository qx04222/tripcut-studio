import { useSyncExternalStore } from "react";

/**
 * R13 §3(车道 B):首页的可见性。两条路进首页:素材库为空(自动),或点顶栏 logo(钉住);
 * 有素材时首页不再自动出现。三个动作(开始新旅程 / 点集卡 / 点模板卡)都会把钉住解开 ——
 * 库还空着时首页仍在导入抽屉底下,素材一到就让位给工作区。
 */
export interface HomeInput {
  loading: boolean;
  clipCount: number;
  pinned: boolean;
}

export function homeVisible(input: HomeInput): boolean {
  if (input.pinned) return true;
  return !input.loading && input.clipCount === 0;
}

let pinned = false;
/** 「库是空的且已读回」—— 由壳按 feed 报进来,顶栏等不碰 feed 的地方据此读 `isHomeOpen`。 */
let autoOpen = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function pinHome(next: boolean): void {
  if (pinned === next) return;
  pinned = next;
  emit();
}

export function isHomePinned(): boolean {
  return pinned;
}

export function reportLibraryState(input: Omit<HomeInput, "pinned">): void {
  const next = homeVisible({ ...input, pinned: false });
  if (autoOpen === next) return;
  autoOpen = next;
  emit();
}

export function isHomeOpen(): boolean {
  return pinned || autoOpen;
}

/** 顶栏 logo 的按下态 / 任何不想订阅 feed 的地方:首页此刻是否盖在工作区上。 */
export function useHomeOpen(): boolean {
  return useSyncExternalStore(subscribe, isHomeOpen, () => false);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useHomePinned(): boolean {
  return useSyncExternalStore(subscribe, isHomePinned, () => false);
}

export function __resetHomeForTests(): void {
  pinned = false;
  autoOpen = false;
}
