import { useCallback, useEffect, useState } from "react";
import {
  cancelExport,
  getSettings,
  pickExportFolder,
  planQuickExport,
  quickExport,
  revealExport,
  setSetting,
  type QuickExportOutcome,
  type QuickExportSelection,
} from "../../api";
import { readUiSetting } from "../uiSettings";
import { isDestUnavailable, isQuickDone, takePendingQuickSelection } from "./quickExportModel";
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

  const start = useCallback(
    async (dir: string) => {
      const outcome = await quickExport(dir, selection);
      remember(dir);
      setStartedJobId(outcome.job_id);
      setJobId(outcome.job_id);
      await refresh().catch(() => undefined);
    },
    [refresh, remember, selection, setJobId],
  );

  const canExport = !busy && !active && status.selected_count > 0 && planError === null;

  const exportNow = useCallback(async () => {
    if (!canExport) return;
    setBusy(true);
    setError(null);
    try {
      let dir = lastDir;
      if (!dir) {
        dir = await pickExportFolder();
        if (!dir) return;
      }
      try {
        await start(dir);
      } catch (startError) {
        if (!isDestUnavailable(startError)) throw startError;
        // 上次的文件夹不见了 / 不可写:回落到保存面板,选了就用新的并记住。
        const picked = await pickExportFolder();
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
      const picked = await pickExportFolder();
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
  };
}
