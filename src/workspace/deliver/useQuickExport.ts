import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelExport,
  getSettings,
  pickQuickExportFolder,
  planQuickExport,
  quickExport,
  revealExport,
  setSetting,
  type QuickExportOutcome,
  type QuickExportSelection,
} from "../../api";
import { showToast } from "../ui/Toast";
import { readUiSetting } from "../uiSettings";
import { exportDoneToast, failedClipIds, isDestUnavailable, isQuickDone, takePendingQuickSelection } from "./quickExportModel";
import type { ExportProgress } from "./useExportProgress";

export const LAST_DIR_KEY = "ui.export.last_dir";

export interface QuickExport {
  /** 只导这些(来自「导出所选…」);null = 本集全部精选段 + 收藏。 */
  selection: QuickExportSelection | null;
  clearSelection(): void;
  /** 上次导出的文件夹;null = 还没选过。 */
  lastDir: string | null;
  /** 将写的文件夹与文件清单;还没算出来 / 算不出来时 null。 */
  plan: QuickExportOutcome | null;
  /** 清单算不出来的原因(通常是"还没有精选段或收藏")。 */
  planError: string | null;
  busy: boolean;
  error: string | null;
  canExport: boolean;
  /** 主动作:有记住的文件夹就直接导,没有(或用不了)才弹一次文件夹面板,然后记住。 */
  exportNow(): Promise<void>;
  changeFolder(): Promise<void>;
  cancel(): Promise<void>;
  /** 本次导出已完成(toast 用);job 是本次启动的那一个。 */
  done: boolean;
  reveal(): Promise<void>;
  /** R12 §6:只把上一次没导出来的那几条再导一遍(同一文件夹)。没有失败项时是 no-op。 */
  retryFailed(): Promise<void>;
}

/**
 * 交付抽屉「快速导出」模式的状态与动作(规格 R11 §2)。进度沿用 `useExportProgress`
 * 的轮询(同一个 export 作业,`mode = quick`)。
 */
export function useQuickExport(progress: ExportProgress): QuickExport {
  const { status, active, setJobId, refresh } = progress;
  const [selection, setSelection] = useState<QuickExportSelection | null>(() => takePendingQuickSelection());
  const [lastDir, setLastDir] = useState<string | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [plan, setPlan] = useState<QuickExportOutcome | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startedJobId, setStartedJobId] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    void getSettings()
      .then((settings) => {
        if (!alive) return;
        const remembered = readUiSetting(settings ?? {}, LAST_DIR_KEY);
        setLastDir(remembered === "" ? null : remembered);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setSettingsLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 清单:文件夹 / 选择 / 交付项数一变就重算;任务进行中不算(清单已冻结在任务里)。
  useEffect(() => {
    if (!settingsLoaded || active) return;
    let alive = true;
    void planQuickExport(lastDir, selection)
      .then((next) => {
        if (!alive) return;
        // 旧桩 / 旧后端可能 resolve 成非对象:当作没算出来。
        if (next && typeof next === "object" && Array.isArray(next.files)) {
          setPlan(next);
          setPlanError(null);
        } else {
          setPlan(null);
        }
      })
      .catch((planFailure) => {
        if (!alive) return;
        setPlan(null);
        setPlanError(String(planFailure));
      });
    return () => {
      alive = false;
    };
  }, [active, lastDir, selection, settingsLoaded, status.selected_count]);

  const remember = useCallback((dir: string) => {
    setLastDir(dir);
    void setSetting(LAST_DIR_KEY, dir).catch(() => undefined);
  }, []);

  const startWith = useCallback(
    async (dir: string, picked: QuickExportSelection | null) => {
      const outcome = await quickExport(dir, picked);
      remember(dir);
      setStartedJobId(outcome.job_id);
      setJobId(outcome.job_id);
      await refresh().catch(() => undefined);
    },
    [refresh, remember, setJobId],
  );
  const start = useCallback((dir: string) => startWith(dir, selection), [selection, startWith]);

  // R12 §3:本次导出结束时给一条全局 toast(每个 job 只报一次)——全成功「n 个导好了 · 在 Finder 中显示」,
  // 部分失败「n 个导好了,m 个没导出来 · 只重试这 m 个」(重试 = 用失败项的素材 id 再跑一次 quick_export),
  // 整体失败「导出没成功:原因。再试一次」。抽屉里的结果卡照旧,toast 是给关了抽屉的人看的。
  const announcedJob = useRef<number | null>(null);
  useEffect(() => {
    if (startedJobId === null || status.job_id !== startedJobId || announcedJob.current === startedJobId) return;
    if (status.status === "done") {
      announcedJob.current = startedJobId;
      const failed = failedClipIds(status);
      const jobId = startedJobId;
      showToast(exportDoneToast(status), {
        tone: failed.length > 0 ? "neutral" : "success",
        action:
          failed.length > 0
            ? {
                label: `只重试这 ${status.failed_items} 个`,
                onClick: () => {
                  if (!lastDir) return;
                  void startWith(lastDir, { clip_ids: failed }).catch((failure) => showToast(`重试没成功:${String(failure)}。再试一次`, { tone: "danger" }));
                },
              }
            : { label: "在 Finder 中显示", onClick: () => void revealExport(jobId).catch(() => undefined) },
      });
    } else if (status.status === "failed" || status.status === "blocked") {
      announcedJob.current = startedJobId;
      showToast(`导出没成功:${status.error ?? "没有写出任何文件"}。再试一次`, { tone: "danger" });
    }
  }, [lastDir, startWith, startedJobId, status]);

  // Z-07:清单里有原片不在原位的素材就不放行(后端也会拒绝;这里先把按钮关掉并给出路)。
  const hasMissing = (plan?.missing?.length ?? 0) > 0;
  const canExport = !busy && !active && status.selected_count > 0 && planError === null && !hasMissing;

  const exportNow = useCallback(async () => {
    if (!canExport) return;
    setBusy(true);
    setError(null);
    try {
      let dir = lastDir;
      if (!dir) {
        dir = await pickQuickExportFolder();
        if (!dir) return;
      }
      try {
        await start(dir);
      } catch (startError) {
        if (!isDestUnavailable(startError)) throw startError;
        // 上次的文件夹不见了 / 不可写:回落到保存面板,选了就用新的并记住。
        const picked = await pickQuickExportFolder();
        if (!picked) {
          setError("上次的文件夹现在用不了。点「更改文件夹…」换一个再导出。");
          return;
        }
        await start(picked);
      }
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }, [canExport, lastDir, start]);

  const changeFolder = useCallback(async () => {
    setError(null);
    try {
      const picked = await pickQuickExportFolder();
      if (picked) remember(picked);
    } catch (failure) {
      setError(String(failure));
    }
  }, [remember]);

  const cancel = useCallback(async () => {
    if (status.job_id === null) return;
    setError(null);
    try {
      await cancelExport(status.job_id);
      await refresh();
    } catch (failure) {
      setError(String(failure));
    }
  }, [refresh, status.job_id]);

  const retryFailed = useCallback(async () => {
    const clipIds = failedClipIds(status);
    if (clipIds.length === 0 || busy || active) return;
    const dir = lastDir ?? status.output_path;
    if (!dir) return;
    setBusy(true);
    setError(null);
    try {
      // Z-11:带上上一次作业 id,后端写回同一个文件夹、沿用原编号(不再另开 -2 从 001 重排)。
      const retrySelection = status.job_id === null ? { clip_ids: clipIds } : { clip_ids: clipIds, retry_of_job_id: status.job_id };
      setSelection(retrySelection);
      const outcome = await quickExport(dir, retrySelection);
      setStartedJobId(outcome.job_id);
      setJobId(outcome.job_id);
      await refresh().catch(() => undefined);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }, [active, busy, lastDir, refresh, setJobId, status]);

  const reveal = useCallback(async () => {
    if (status.job_id === null) return;
    setError(null);
    try {
      await revealExport(status.job_id);
    } catch (failure) {
      setError(String(failure));
    }
  }, [status.job_id]);

  // 顶栏 / 命令面板的「生成交付包」动作在快速模式下就是「导出」。
  useEffect(() => {
    const onAction = (event: Event) => {
      if ((event as CustomEvent<string>).detail === "deliver-export") void exportNow();
    };
    window.addEventListener("tripcut:action", onAction);
    return () => window.removeEventListener("tripcut:action", onAction);
  }, [exportNow]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("tripcut:deliver-availability", { detail: canExport }));
    return () => {
      window.dispatchEvent(new CustomEvent("tripcut:deliver-availability", { detail: false }));
    };
  }, [canExport]);

  return {
    selection,
    clearSelection: () => setSelection(null),
    lastDir,
    plan,
    planError,
    busy,
    error: error ?? progress.error,
    canExport,
    exportNow,
    changeFolder,
    cancel,
    done: isQuickDone(status, startedJobId),
    reveal,
    retryFailed,
  };
}
