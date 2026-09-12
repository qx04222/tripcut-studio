import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelImportBatch,
  dismissImportNotices,
  getClipsRevision,
  getCurrentEpisode,
  getImportProgress,
  listClips,
  listImportBatches,
  previewImportRemoval,
  removeImportedMaterial,
  type ClipListItem,
  type ImportBatch,
  type ImportProgress,
  type RemovalPreview,
  type RemovalRequest,
} from "../../api";
import { analysisProgress, type AnalysisProgress } from "./importModel";

export const EMPTY_PROGRESS: ImportProgress = {
  total: 0,
  done: 0,
  failed: 0,
  running: 0,
  waiting_for_permit: 0,
  paused_for_memory: false,
};

export interface ImportJobs {
  progress: ImportProgress;
  clips: readonly ClipListItem[];
  readyClips: readonly ClipListItem[];
  quality: AnalysisProgress;
  motion: AnalysisProgress;
  refreshError: string | null;
  batches: readonly ImportBatch[];
  busy: boolean;
  notice: string | null;
  confirmation: { request: RemovalRequest; preview: RemovalPreview } | null;
  refresh(): Promise<void>;
  arm(request: RemovalRequest): void;
  confirmRemoval(): Promise<void>;
  cancelConfirmation(): void;
  cancelBatch(id: number): Promise<void>;
  dismissNotices(): Promise<void>;
}

/**
 * 抽自 `ImportPage`(进度 + 素材轮询:1.5s、revision 门、visibility 停表、请求序号防回写)
 * 与 `ImportManagement`(批次轮询与停止 / 撤销 / 清理)。两条轮询合成一条表——
 * 旧壳里它们各自 1.5s,合并后每拍照旧各打一次 api。
 */
export function useImportJobs(options: { onChanged?: () => void; pollMs?: number } = {}): ImportJobs {
  const { onChanged, pollMs = 1_500 } = options;
  const [progress, setProgress] = useState<ImportProgress>(EMPTY_PROGRESS);
  const [clips, setClips] = useState<ClipListItem[]>([]);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ImportJobs["confirmation"]>(null);
  const refreshRequest = useRef(0);
  const lastClipsRevision = useRef<string | undefined>(undefined);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const refresh = useCallback(async (isActive: () => boolean = () => true) => {
    const request = ++refreshRequest.current;

    // 轮询先问一句「变了吗」——没变就跳过 listClips 整表拉取,只刷新进度。
    // 拿修订号本身失败(命令报错)就当作「变了」,退回全量拉取,不能卡死轮询。
    let nextRevision: string | undefined;
    let shouldFetchClips: boolean;
    try {
      nextRevision = await getClipsRevision();
      shouldFetchClips = nextRevision !== lastClipsRevision.current;
    } catch {
      shouldFetchClips = true;
    }

    if (!shouldFetchClips) {
      const [nextProgress, nextBatches] = await Promise.all([getImportProgress(), listImportBatches()]);
      if (!isActive() || request !== refreshRequest.current) return;
      setProgress(nextProgress);
      setBatches(nextBatches);
      return;
    }

    const [nextProgress, nextClips, currentEpisode, nextBatches] = await Promise.all([
      getImportProgress(),
      listClips(),
      getCurrentEpisode(),
      listImportBatches(),
    ]);
    if (!isActive() || request !== refreshRequest.current) return;
    setProgress(nextProgress);
    setClips(nextClips.filter((clip) => clip.episode_id === currentEpisode.id));
    setBatches(nextBatches);
    lastClipsRevision.current = nextRevision;
  }, []);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let inFlight = false;
    const pageVisible = () => document.visibilityState !== "hidden";
    const poll = async () => {
      if (!active || inFlight || !pageVisible()) return;
      inFlight = true;
      try {
        await refresh(() => active);
        if (active) setRefreshError(null);
      } catch (pollError) {
        if (active) setRefreshError(String(pollError));
      } finally {
        inFlight = false;
        if (active && pageVisible()) timer = window.setTimeout(() => void poll(), pollMs);
      }
    };
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (pageVisible()) void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void poll();
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibility);
      ++refreshRequest.current;
      window.clearTimeout(timer);
    };
  }, [refresh, pollMs]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const changed = useCallback(async () => {
    setBatches(await listImportBatches());
    onChangedRef.current?.();
  }, []);

  const arm = useCallback((request: RemovalRequest) => {
    void run(async () => {
      setConfirmation({ request, preview: await previewImportRemoval(request) });
    });
  }, [run]);

  const confirmRemoval = useCallback(async () => {
    if (!confirmation) return;
    await run(async () => {
      const count = await removeImportedMaterial(confirmation.request);
      setConfirmation(null);
      setNotice(`已移除 ${count} 条素材，原视频保留。现在可以重新选择文件夹。`);
      await changed();
    });
  }, [changed, confirmation, run]);

  const cancelConfirmation = useCallback(() => setConfirmation(null), []);

  const cancelBatch = useCallback(async (id: number) => {
    await run(async () => {
      await cancelImportBatch(id);
      setNotice("已停止本批后续导入和分析；已入库素材保留。相关文件夹自动同步已暂停。");
      await changed();
    });
  }, [changed, run]);

  const dismissNotices = useCallback(async () => {
    await run(async () => {
      await dismissImportNotices();
      setNotice("已清理重复/失败提示，原素材保留，可重新选择文件夹重试。");
      await changed();
    });
  }, [changed, run]);

  const readyClips = useMemo(() => clips.filter((clip) => clip.status === "ready"), [clips]);
  const quality = useMemo(() => analysisProgress(readyClips, "analysis"), [readyClips]);
  const motion = useMemo(() => analysisProgress(readyClips, "motion"), [readyClips]);

  return {
    progress, clips, readyClips, quality, motion, refreshError, batches, busy, notice, confirmation,
    refresh: () => refresh(), arm, confirmRemoval, cancelConfirmation, cancelBatch, dismissNotices,
  };
}
