import { useSyncExternalStore } from "react";

import { previewImportRemoval, removeImportedMaterial, type RemovalPreview, type RemovalRequest } from "../api";
import { failureText } from "./errorText";
import { showToast } from "./ui/toastStore";
import { refreshClipsFeed, removeClipsFromFeed } from "./useClipsFeed";
import { dispatchWorkspace, getWorkspaceSnapshot } from "./WorkspaceStore";

/**
 * R16 P1-1 / P2-9:工作区里「移除素材…」的状态层。媒体池右键、检查器头部、缺失页卷组都只调
 * `requestClipRemoval(clipIds)`;后果预览(`preview_import_removal`)、确认卡(`ClipRemovalHost`,
 * 复用导入页那张 alertdialog)、真正的 `remove_imported_material` 都在这里,全应用只有一份。
 * 删掉之后本地立刻从 feed 拿掉(不等轮询)、清掉落在这些素材上的选择,再强制对齐一次。
 */
export interface ClipRemovalState {
  request: RemovalRequest;
  preview: RemovalPreview;
  /** 覆盖确认卡标题(缺失页:「移除这个盘上的 n 条素材」)。 */
  title?: string;
  /** 删成功之后调一次(缺失页用它重取清单)。 */
  onRemoved?: () => void;
  busy: boolean;
}

let current: ClipRemovalState | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function set(next: ClipRemovalState | null): void {
  current = next;
  emit();
}

/** 先取后果预览,再弹确认卡;预览失败直接 toast,不弹卡。 */
export async function requestClipRemoval(clipIds: readonly number[], options: { title?: string; onRemoved?: () => void } = {}): Promise<void> {
  const ids = [...new Set(clipIds)].filter((id) => Number.isFinite(id));
  if (ids.length === 0) return;
  const request: RemovalRequest = { batch_id: null, clip_ids: ids, all: false };
  try {
    const preview = await previewImportRemoval(request);
    set({ request, preview, title: options.title, onRemoved: options.onRemoved, busy: false });
  } catch (error) {
    showToast(failureText("读取移除预览", error), { tone: "danger" });
  }
}

export function cancelClipRemoval(): void {
  set(null);
}

/** 确认:调后端、本地立刻拿掉、清掉指向它们的选择、toast 结果。 */
export async function confirmClipRemoval(): Promise<void> {
  if (!current || current.busy) return;
  const { request, onRemoved } = current;
  set({ ...current, busy: true });
  try {
    const count = await removeImportedMaterial(request);
    const removed = new Set(request.clip_ids);
    removeClipsFromFeed((clip) => clip.id === null || !removed.has(clip.id));
    const { selection, multiSelection } = getWorkspaceSnapshot();
    if ((selection?.kind === "clip" && removed.has(selection.clipId)) || multiSelection.some((id) => removed.has(id))) {
      dispatchWorkspace({ type: "clear-selection" });
    }
    set(null);
    showToast(`已移除 ${count} 条素材,原视频保留`, { tone: "success" });
    onRemoved?.();
    await refreshClipsFeed(true).catch(() => undefined);
  } catch (error) {
    set(current ? { ...current, busy: false } : null);
    showToast(failureText("移除素材", error), { tone: "danger" });
  }
}

export function getClipRemovalSnapshot(): ClipRemovalState | null {
  return current;
}

export function useClipRemoval(): ClipRemovalState | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getClipRemovalSnapshot,
    () => null,
  );
}

export function __resetClipRemovalForTests(): void {
  current = null;
  emit();
}

/** 确认卡标题:单条 / 多选。 */
export function clipRemovalTitleFor(count: number): string {
  return count > 1 ? `从当前集移除这 ${count} 条素材` : "从当前集移除这条素材";
}
