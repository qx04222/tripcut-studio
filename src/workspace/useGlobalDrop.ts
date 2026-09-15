import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";

import { downloadCloudFile, importPaths, inspectPaths, type PathCondition } from "../api";
import { showToast, type ToastTone } from "./ui/toastStore";

/**
 * R18 M-06①:拖放不再只属于导入抽屉,整个窗口都能接;Dock 图标拖入与
 * 「打开方式」也落到同一个入口(后端 `RunEvent::Opened` → `tripcut:opened-paths`)。
 *
 * 为什么要一个**模块级单例**而不是每个 hook 各挂各的:
 * 抽屉里的 `useImportSources` 和壳里的整窗高亮层会同时订阅。若各自
 * `onDragDropEvent`,一次松手会调两遍 `importPaths`——同一批文件导两次。
 * 所以监听按引用计数只装一份,结果向所有订阅者广播。
 */

export const OPENED_PATHS_EVENT = "tripcut:opened-paths";

export interface GlobalDropHandlers {
  /** 开始导入(清掉上一条提示/错误)。 */
  onStart?: () => void;
  onNotice?: (notice: string) => void;
  onError?: (message: string) => void;
  onImported?: () => void;
}

/** 文案逐字沿用 `ImportPage`——测试按字面量钉着,别顺手改标点。 */
export function importNotice(total: number, enqueued: number, skipped: number): string {
  const duplicateNote = skipped > 0 ? `，跳过 ${skipped} 项已入库或已排队素材（可能属于其他集）` : "";
  return `已发现 ${total} 个视频，新增 ${enqueued} 项${duplicateNote}`;
}

export interface DropTriage {
  /** 真能导的那几条。 */
  importable: string[];
  /** 在 iCloud 里只有占位的那几条——「现在下载」按钮要下的就是它们。 */
  cloudOnly: string[];
  /** 给用户的一句话;没什么可说的就是 null。 */
  message: string | null;
  tone: ToastTone;
}

/**
 * R18 M-10:导入前的体检结果翻成一句人话。
 *
 * 三件事看着都像"读不到",说法必须分开:盘拔了是**插回去就好**(不是错误),
 * iCloud 只有占位是**我们能替他下**,真没了才是找不到。混成一句"导入失败",
 * 用户只会以为软件坏了。
 *
 * `fallback` 是后端体检答非所问时(条数对不上、命令不存在)要照原样导的那批——
 * 体检没做成不该变成"不干活"。
 */
export function triageConditions(
  conditions: readonly PathCondition[],
  fallback: readonly string[] = [],
): DropTriage {
  // 体检没做成(命令不存在 / 返回空)就照原样导——不能因为体检失败变成"不干活"。
  if (conditions.length === 0) {
    return { importable: [...fallback], cloudOnly: [], message: null, tone: "neutral" };
  }
  const importable = conditions.filter((c) => c.state === "ok").map((c) => c.path);
  const cloudOnly = conditions.filter((c) => c.state === "cloud_only").map((c) => c.path);
  const ejected = conditions.filter((c) => c.state === "ejected");
  const gone = conditions.filter((c) => c.state === "gone");

  // 一次只说一件事,按"用户下一步能做什么"排序:插盘 > 下载 > 找不到。
  if (ejected.length > 0) {
    const volume = ejected[0].volume;
    return {
      importable,
      cloudOnly,
      message: volume ? `「${volume}」这块盘现在不在,插回去再试一次。` : "那块盘现在不在,插回去再试一次。",
      tone: "neutral",
    };
  }
  if (cloudOnly.length > 0) {
    const rest = importable.length > 0 ? `,其余 ${importable.length} 条已开始导入` : "";
    return {
      importable,
      cloudOnly,
      message: `有 ${cloudOnly.length} 条在 iCloud 里没下载到本机${rest}。`,
      tone: "neutral",
    };
  }
  if (gone.length > 0) {
    return {
      importable,
      cloudOnly,
      message: `有 ${gone.length} 条找不到了(可能被删了或改了名)。`,
      tone: "danger",
    };
  }
  return { importable, cloudOnly, message: null, tone: "neutral" };
}

const subscribers = new Set<GlobalDropHandlers>();
const listeners = new Set<() => void>();
let dragActive = false;
let refCount = 0;
let generation = 0;
let stopDrag: (() => void) | undefined;
let stopOpened: (() => void) | undefined;

function setDragActive(next: boolean): void {
  if (dragActive === next) return;
  dragActive = next;
  for (const listener of [...listeners]) listener();
}

function fanOut(call: (handlers: GlobalDropHandlers) => void): void {
  for (const handlers of [...subscribers]) call(handlers);
}

/** 拖放 / Dock 打开共用的那一段:导入并把结果广播出去。空列表只清高亮。 */
export function handleDroppedPaths(paths: readonly string[]): void {
  if (paths.length === 0) return;
  fanOut((handlers) => handlers.onStart?.());
  void inspectPaths([...paths])
    .catch(() => [] as PathCondition[])
    .then((conditions) => {
      const triage = triageConditions(conditions, paths);
      if (triage.message) {
        showToast(triage.message, {
          tone: triage.tone,
          action:
            triage.cloudOnly.length > 0
              ? {
                  label: "现在下载",
                  onClick: () => {
                    for (const path of triage.cloudOnly) void downloadCloudFile(path).catch(() => undefined);
                  },
                }
              : undefined,
        });
      }
      if (triage.importable.length === 0) {
        if (triage.message) fanOut((handlers) => handlers.onNotice?.(triage.message as string));
        return;
      }
      runImport(triage.importable);
    });
}

function runImport(paths: readonly string[]): void {
  void importPaths([...paths])
    .then((results) => {
      const total = results.reduce((sum, result) => sum + result.total, 0);
      const enqueued = results.reduce((sum, result) => sum + result.enqueued, 0);
      const skipped = results.reduce((sum, result) => sum + result.skipped, 0);
      const notice = importNotice(total, enqueued, skipped);
      fanOut((handlers) => {
        handlers.onNotice?.(notice);
        handlers.onImported?.();
      });
    })
    .catch((importError) => fanOut((handlers) => handlers.onError?.(String(importError))));
}

/** 非 Tauri 环境(vitest / `vite --mode mock`)静默退化为 no-op,与 `startMenuBridge` 同一套约定。 */
async function listenOpenedPaths(): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<string[]>(OPENED_PATHS_EVENT, (event) => {
      handleDroppedPaths(Array.isArray(event.payload) ? event.payload : []);
    });
  } catch {
    return () => undefined;
  }
}

function attach(): void {
  const mine = ++generation;
  // getCurrentWebview() 在没有 __TAURI_INTERNALS__ 的环境里同步抛错。
  try {
    const webview = getCurrentWebview();
    void webview
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDragActive(true);
        } else if (payload.type === "leave") {
          setDragActive(false);
        } else if (payload.type === "drop") {
          setDragActive(false);
          handleDroppedPaths(payload.paths);
        }
      })
      .then((fn) => {
        if (generation !== mine) fn();
        else stopDrag = fn;
      });
  } catch {
    stopDrag = undefined;
  }
  void listenOpenedPaths().then((fn) => {
    if (generation !== mine) fn();
    else stopOpened = fn;
  });
}

function detach(): void {
  generation += 1;
  stopDrag?.();
  stopDrag = undefined;
  stopOpened?.();
  stopOpened = undefined;
  setDragActive(false);
}

/**
 * 订阅整窗拖放。返回「现在有东西悬在窗口上」——拿它做整窗高亮。
 * handlers 用 ref 转发,所以调用方每次渲染传新对象也不会重挂监听。
 */
export function useGlobalDrop(handlers: GlobalDropHandlers = {}): boolean {
  const latest = useRef(handlers);
  latest.current = handlers;
  const [, bump] = useState(0);

  useEffect(() => {
    const stable: GlobalDropHandlers = {
      onStart: () => latest.current.onStart?.(),
      onNotice: (notice) => latest.current.onNotice?.(notice),
      onError: (message) => latest.current.onError?.(message),
      onImported: () => latest.current.onImported?.(),
    };
    const listener = () => bump((value) => value + 1);
    subscribers.add(stable);
    listeners.add(listener);
    refCount += 1;
    if (refCount === 1) attach();
    return () => {
      subscribers.delete(stable);
      listeners.delete(listener);
      refCount -= 1;
      if (refCount === 0) detach();
    };
  }, []);

  return dragActive;
}
