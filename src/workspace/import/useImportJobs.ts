import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelImportBatch,
  cancelJob,
  dismissImportNotices,
  getClipsRevision,
  getCurrentEpisode,
  getImportProgress,
  listClips,
  listImportBatches,
  listRunningJobs,
  previewImportRemoval,
  removeImportedMaterial,
  type ClipListItem,
  type ImportBatch,
  type ImportProgress,
  type RemovalPreview,
  type RemovalRequest,
  type RunningJob,
} from "../../api";
import { analysisProgress, type AnalysisProgress } from "./importModel";
import { failureText } from "../errorText";
import { refreshClipsFeed, removeClipsFromFeed } from "../useClipsFeed";

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
  /** A16-01:第一拍数据已经回来过。没回来之前界面不能把初始空状态冒充成「还没有素材 / 批次」。 */
  loaded: boolean;
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
  /** R16 P1-6:正在跑的任务行(随批次一起轮询;旧后端没有这条命令时为空)。 */
  runningJobs: readonly RunningJob[];
  /** R16 P1-6:取消一行(确认由界面做一次);取消后立即从本地列表拿掉。 */
  cancelRunningJob(id: number): Promise<void>;
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
  const [loaded, setLoaded] = useState(false);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [runningJobs, setRunningJobs] = useState<RunningJob[]>([]);
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

    // R16 P1-6:正在跑的任务行跟着同一拍轮询;旧后端 / 替身没有这条命令就当作空列表。
    const fetchRunning = () => Promise.resolve().then(() => listRunningJobs()).then((rows) => rows ?? []).catch(() => [] as RunningJob[]);

    if (!shouldFetchClips) {
      const [nextProgress, nextBatches, nextRunning] = await Promise.all([getImportProgress(), listImportBatches(), fetchRunning()]);
      if (!isActive() || request !== refreshRequest.current) return;
      setProgress(nextProgress);
      setBatches(nextBatches);
      setRunningJobs(nextRunning);
      setLoaded(true);
      return;
    }

    const [nextProgress, nextClips, currentEpisode, nextBatches, nextRunning] = await Promise.all([
      getImportProgress(),
      listClips(),
      getCurrentEpisode(),
      listImportBatches(),
      fetchRunning(),
    ]);
    if (!isActive() || request !== refreshRequest.current) return;
    setProgress(nextProgress);
    setClips(nextClips.filter((clip) => clip.episode_id === currentEpisode.id));
    setBatches(nextBatches);
    setRunningJobs(nextRunning);
    setLoaded(true);
    lastClipsRevision.current = nextRevision;
  }, []);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let inFlight = false;
    const pageVisible = () => document.visibilityState !== "hidden";
    // A16-01:第一拍不看 visibilityState —— WKWebView 在窗口被遮 / 锁屏后可能一直报 hidden,
    // 那样这一页会永远停在初始空状态(0 / 0 / 0、「还没有导入批次」)而池里明明有素材。
    // 停表只管定时器那条。
    const poll = async (force = false) => {
      if (!active || inFlight || (!force && !pageVisible())) return;
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
    void poll(true);
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
      setNotice(failureText("处理导入任务", error));
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
      const { request } = confirmation;
      const count = await removeImportedMaterial(request);
      setConfirmation(null);
      // R15:后端已在数据库里删掉,不等下一轮 1.5 s 轮询 —— 本地立刻拿掉,再强制对齐一次。
      // 「清空当前集」范围就是当前集全部;单条按 id;整批的成员前端不知道,只强制刷新。
      if (request.all) {
        const scope = new Set(clips.map((clip) => clip.id));
        setClips([]);
        removeClipsFromFeed((clip) => !scope.has(clip.id));
      } else if (request.clip_ids.length > 0) {
        const removed = new Set(request.clip_ids);
        setClips((current) => current.filter((clip) => clip.id === null || !removed.has(clip.id)));
        removeClipsFromFeed((clip) => clip.id === null || !removed.has(clip.id));
      }
      void refreshClipsFeed(true).catch(() => undefined);
      setNotice(`已移除 ${count} 条素材，原视频保留。缓存文件在后台清理。现在可以重新选择文件夹。`);
      await changed();
    });
  }, [changed, clips, confirmation, run]);

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

  const cancelRunningJob = useCallback(async (id: number) => {
    await run(async () => {
      await cancelJob(id);
      setRunningJobs((current) => current.filter((job) => job.id !== id));
      setNotice("已取消这项任务;已经完成的部分保留,需要时可以重新分析这条素材。");
    });
  }, [run]);

  const readyClips = useMemo(() => clips.filter((clip) => clip.status === "ready"), [clips]);
  const quality = useMemo(() => analysisProgress(readyClips, "analysis"), [readyClips]);
  const motion = useMemo(() => analysisProgress(readyClips, "motion"), [readyClips]);

  return {
    progress, clips, readyClips, quality, motion, refreshError, loaded, batches, busy, notice, confirmation,
    refresh: () => refresh(), arm, confirmRemoval, cancelConfirmation, cancelBatch, dismissNotices,
    runningJobs, cancelRunningJob,
  };
}
