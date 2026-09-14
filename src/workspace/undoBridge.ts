/**
 * R16 §1「统一 ⌘Z 栈」的约定(车道 A 做栈,车道 B 只往里推):
 * `window` 事件 `tripcut:undo-push`,`detail: { label, undo: () => Promise<void> }`。
 * 推进去的 `undo` 必须**只跑一次**(toast 上的「撤销」与 ⌘Z 共用同一个闭包,谁先来谁撤,第二次是空操作),
 * 栈那边不需要知道这一点。
 */
import { pushUndo as pushUndoEntry } from "./undoStack";

export interface UndoPushDetail {
  label: string;
  undo: () => Promise<void>;
}

export const UNDO_PUSH_EVENT = "tripcut:undo-push";

export function pushUndo(label: string, undo: () => Promise<void>): void {
  // 合并后:事件仍然广播(测试与旧监听者照旧),同时直接推进车道 A 的全局栈,⌘Z 与 toast「撤销」只有一条栈。
  window.dispatchEvent(new CustomEvent<UndoPushDetail>(UNDO_PUSH_EVENT, { detail: { label, undo } }));
  pushUndoEntry({ label, undo });
}
