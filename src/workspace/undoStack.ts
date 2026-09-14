import { useSyncExternalStore } from "react";

/**
 * R16 P2-2(车道 A):**一个**全局撤销栈。拖排 / 加入镜头带 / 从镜头带移出(后端 `undo_story_change`)、
 * 叙事修改(`undo_narrative_op`)、批量评级(记旧值回写)都往这里推一条;顶层 ⌘Z 弹最近一条。
 * 后端其实各有各的历史表,这里只记「按什么顺序、该叫谁」—— 谁推的谁负责 `undo()` 里把数据刷回来。
 * toast 上的「撤销」按钮走同一条栈(`runUndo`),所以 toast 撤了之后 ⌘Z 不会再撤第二次。
 */
export interface UndoEntry {
  /** 白话标签,进 toast:「已撤销 · 调整顺序」。 */
  label: string;
  undo(): Promise<void>;
}

const MAX_ENTRIES = 50;

let stack: Array<UndoEntry & { id: number }> = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** 推一条,返回它的 id(toast 的「撤销」按钮用 id 精确撤这一条,不误撤后来者)。 */
export function pushUndo(entry: UndoEntry): number {
  const id = nextId;
  nextId += 1;
  stack = [...stack.slice(-(MAX_ENTRIES - 1)), { ...entry, id }];
  emit();
  return id;
}

export function canUndo(): boolean {
  return stack.length > 0;
}

export function peekUndo(): UndoEntry | null {
  return stack.length === 0 ? null : stack[stack.length - 1]!;
}

/** 撤最近一条;栈空回 null。失败时把那条丢掉(再按 ⌘Z 不会反复撞同一个错)并把错抛出去。 */
export async function runUndo(): Promise<UndoEntry | null> {
  const top = stack[stack.length - 1];
  if (!top) return null;
  stack = stack.slice(0, -1);
  emit();
  await top.undo();
  return top;
}

/** 撤指定的那一条(toast 按钮):它已经不在栈里(被 ⌘Z 撤过)就什么都不做、回 false。 */
export async function runUndoById(id: number): Promise<boolean> {
  const index = stack.findIndex((entry) => entry.id === id);
  if (index < 0) return false;
  const [entry] = stack.splice(index, 1);
  stack = [...stack];
  emit();
  await entry!.undo();
  return true;
}

/** 某条已经通过别的路径失效(比如再排一次覆盖了历史)时把它拿掉。 */
export function dropUndo(id: number): void {
  const next = stack.filter((entry) => entry.id !== id);
  if (next.length === stack.length) return;
  stack = next;
  emit();
}

export function useCanUndo(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    canUndo,
    () => false,
  );
}

export function __resetUndoForTests(): void {
  stack = [];
  nextId = 1;
  emit();
}
