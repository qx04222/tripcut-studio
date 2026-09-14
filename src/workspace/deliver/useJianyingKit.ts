import { useCallback, useEffect, useRef, useState } from "react";
import {
  JIANYING_BUNDLE_ID,
  cancelExport,
  exportJianyingKit,
  getSettings,
  openApp,
  pickExportFolder,
  planJianyingKit,
  revealExport,
  setSetting,
  type KitExportOutcome,
} from "../../api";
import { failureText } from "../errorText";
import { showToast } from "../ui/Toast";
import { readUiSetting } from "../uiSettings";
import { OPEN_JIANYING_ACTION, isKitDone, kitDoneLine } from "./kitExportModel";
import { isDestUnavailable } from "./quickExportModel";
import type { ExportProgress } from "./useExportProgress";
import { LAST_DIR_KEY } from "./useQuickExport";

export interface JianyingKit {
  /** 上次导出的文件夹(与快速导出共用 `ui.export.last_dir`);null = 还没选过。 */
  lastDir: string | null;
  /** 将写的文件夹与编号清单;还没算出来 / 算不出来时 null。 */
  plan: KitExportOutcome | null;
  planError: string | null;
  busy: boolean;
  error: string | null;
  canExport: boolean;
  /** 主动作:有记住的文件夹直接导;没有(或用不了)才弹一次文件夹面板,然后记住。 */
  exportNow(): Promise<void>;
  changeFolder(): Promise<void>;
  cancel(): Promise<void>;
  /** 本次素材包已导完(结果卡 / toast 用)。 */
  done: boolean;
  reveal(): Promise<void>;
  openJianying(): void;
}

const KIT_DONE_TOAST_MS = 10_000;

/**
 * 交付抽屉「剪映素材包」模式的状态与动作(R14 §9 B)。进度沿用 `useExportProgress` 的轮询
 * (同一个 export 作业,`mode = kit`);文件夹记忆与快速导出同一把钥匙。
 */
export function useJianyingKit(progress: ExportProgress): JianyingKit {
  const { status, active, setJobId, refresh } = progress;
  const [lastDir, setLastDir] = useState<string | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [plan, setPlan] = useState<KitExportOutcome | null>(null);
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

  useEffect(() => {
    if (!settingsLoaded || active) return;
    let alive = true;
    void planJianyingKit(lastDir)
      .then((next) => {
        if (!alive) return;
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
  }, [active, lastDir, settingsLoaded, status.selected_count]);

  const remember = useCallback((dir: string) => {
    setLastDir(dir);
    void setSetting(LAST_DIR_KEY, dir).catch(() => undefined);
  }, []);

  const start = useCallback(
    async (dir: string) => {
      const outcome = await exportJianyingKit(dir);
      remember(dir);
      setStartedJobId(outcome.job_id);
      setJobId(outcome.job_id);
      await refresh().catch(() => undefined);
    },
    [refresh, remember, setJobId],
  );

  const openJianying = useCallback(() => {
    void openApp(JIANYING_BUNDLE_ID).catch((failure) => showToast(failureText("打开剪映", failure, "到剪映首页「本地草稿」旁新建草稿也一样"), { tone: "danger" }));
  }, []);

  // 完成 toast「已导出 n 个片段 · 打开剪映」(每个 job 只报一次;open_app 只放行剪映的 bundle id)。
  const announcedJob = useRef<number | null>(null);
  useEffect(() => {
    if (startedJobId === null || status.job_id !== startedJobId || announcedJob.current === startedJobId) return;
    if (status.status === "done") {
      announcedJob.current = startedJobId;
      showToast(kitDoneLine(status), {
        tone: status.failed_items > 0 ? "neutral" : "success",
        durationMs: KIT_DONE_TOAST_MS,
        action: { label: OPEN_JIANYING_ACTION, onClick: openJianying },
      });
    } else if (status.status === "failed" || status.status === "blocked") {
      announcedJob.current = startedJobId;
      showToast(`导出没成功:${status.error ?? "没有写出任何文件"}。再试一次`, { tone: "danger" });
    }
  }, [openJianying, startedJobId, status]);

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
        dir = await pickExportFolder();
        if (!dir) return;
      }
      try {
        await start(dir);
      } catch (startError) {
        if (!isDestUnavailable(startError)) throw startError;
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

  // 顶栏 / 命令面板的「导出」动作在这个模式下就是「导出素材包」。
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
    lastDir,
    plan,
    planError,
    busy,
    error: error ?? progress.error,
    canExport,
    exportNow,
    changeFolder,
    cancel,
    done: isKitDone(status, startedJobId),
    reveal,
    openJianying,
  };
}
