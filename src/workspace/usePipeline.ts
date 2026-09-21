import { useEffect, useMemo, useSyncExternalStore } from "react";

import { derivePhotoPipeline, photoPipelineInputFrom, type PhotoPipelineState } from "./photoPipelineModel";
import { derivePipeline, pipelineInputFrom, type PipelineState } from "./pipelineModel";
import { useClipsFeed } from "./useClipsFeed";

/**
 * 本次会话里在交付抽屉完成过的导出次数。集记录的 `export_count` 只数 `exports` 表里的
 * 交付包;快速导出完成的那一刻先在这里记一笔,导航条当场打勾,不等下一轮 getCurrentEpisode。
 */
export const EXPORT_DONE_EVENT = "tripcut:export-done";

/** R21 W3(F-W3-03):事件 detail 说明是哪条线导完的;不带 detail = 视频(旧调用方)。 */
export type ExportDoneKind = "video" | "photo";

let sessionExports = 0;
let sessionPhotoExports = 0;
const listeners = new Set<() => void>();

function onExportDone(event: Event): void {
  if ((event as CustomEvent<ExportDoneKind | undefined>).detail === "photo") sessionPhotoExports += 1;
  else sessionExports += 1;
  for (const listener of [...listeners]) listener();
}

function subscribeSessionExports(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener(EXPORT_DONE_EVENT, onExportDone);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener(EXPORT_DONE_EVENT, onExportDone);
  };
}

/** 车道 B「这章够了」的跳过章集合;合并前壳这边没有数据源,先给空集(见报告)。 */
const NO_SKIPPED: ReadonlySet<number> = new Set();

/** 壳 / 导航条 / 空态 / 首启卡共用的流水线状态(规格 §1:「与导航条同一套数据」)。 */
export function usePipeline(): PipelineState {
  const feed = useClipsFeed();
  const sessionCount = useSyncExternalStore(subscribeSessionExports, () => sessionExports, () => 0);
  return useMemo(() => {
    const input = pipelineInputFrom(feed.clips, feed.storyboard, feed.episode.current, NO_SKIPPED);
    return derivePipeline({ ...input, exportCount: Math.max(input.exportCount, sessionCount) });
  }, [feed.clips, feed.storyboard, feed.episode.current, sessionCount]);
}

/**
 * R21 W3 P1-1:照片工作台的三步流水线 —— 只看 `kind='photo'`,与视频那份互不掺和。
 * 会话内的导出计数也分开:照片导出完成广播 `EXPORT_DONE_EVENT` 带 detail "photo"。
 */
export function usePhotoPipeline(): PhotoPipelineState {
  const feed = useClipsFeed();
  const sessionCount = useSyncExternalStore(subscribeSessionExports, () => sessionPhotoExports, () => 0);
  return useMemo(() => {
    const input = photoPipelineInputFrom(feed.clips, feed.episode.current);
    return derivePhotoPipeline({ ...input, exportCount: Math.max(input.exportCount, sessionCount) });
  }, [feed.clips, feed.episode.current, sessionCount]);
}

/** 只在开发期用:把会话计数清零。 */
export function __resetPipelineForTests(): void {
  sessionExports = 0;
  sessionPhotoExports = 0;
}

/** 让「切集」把会话内的导出计数清掉 —— 换了集就是另一条流水线。 */
export function useResetSessionExportsOnEpisodeChange(): void {
  useEffect(() => {
    const reset = () => {
      sessionExports = 0;
      sessionPhotoExports = 0;
      for (const listener of [...listeners]) listener();
    };
    window.addEventListener("tripcut:episode-changed", reset);
    return () => window.removeEventListener("tripcut:episode-changed", reset);
  }, []);
}
