import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelExport,
  exportSelectedPhotos,
  getSettings,
  pickExportFolder,
  planSelectedPhotos,
  revealExport,
  setSetting,
  type ExportStatus,
  type KitExportOutcome,
} from "../../api";
import { showToast } from "../ui/Toast";
import { readUiSetting } from "../uiSettings";
import { exportErrorLine, isDestUnavailable } from "./quickExportModel";
import type { ExportProgress } from "./useExportProgress";
import { LAST_DIR_KEY } from "./useQuickExport";
import { ensureCurrentPhotoOrderSaved } from "../photoOrderSettings";

/**
 * R21 照片线(业主拍板:照片不套视频那一套):照片工作台**唯一**的导出 ——「导出精选照片」。
 * winners = 收藏 + ≥3 星 + 擂台主图;选文件夹 → 复制(HEIC / RAW 转 JPG + 原件 + 伴随)+ 「顺序.txt」,
 * 走归档日志(可撤销、可对账)。没有「交给剪映」、素材包、整包。
 */
export interface PhotoExport {
  /** 上次导出的文件夹(与视频导出共用 `ui.export.last_dir`);null = 还没选过。 */
  lastDir: string | null;
  plan: KitExportOutcome | null;
  planError: string | null;
  busy: boolean;
  error: string | null;
  canExport: boolean;
  exportNow(): Promise<void>;
  changeFolder(): Promise<void>;
  cancel(): Promise<void>;
  done: boolean;
  reveal(): Promise<void>;
}

export const PHOTO_EXPORT_LABEL = "导出精选照片";
export const PHOTO_EXPORT_LEAD_LINE = "收藏、3 星以上和擂台选出的照片,按精选带顺序编号复制到一个文件夹";
export const PHOTO_EXPORT_EMPTY_TITLE = "还没有精选照片";
export const PHOTO_EXPORT_EMPTY_BODY = "在照片网格里收藏、打 3 星以上,或在擂台里选出主图,再回来导出。";
const PHOTO_DONE_TOAST_MS = 10_000;

/** 完成一句「已导出 n 张照片」;有失败补一句。 */
export function photoDoneLine(status: ExportStatus): string {
  const base = `已导出 ${status.completed_items} 张照片`;
  return status.failed_items > 0 ? `${base} · ${status.failed_items} 张没导出来` : base;
}

/** 这条完成状态是不是本次精选照片导出。 */
export function isPhotoExportDone(status: ExportStatus, startedJobId: number | null): boolean {
  return status.status === "done" && status.mode === "photos" && startedJobId !== null && status.job_id === startedJobId;
}

function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length === 0 ? path : parts[parts.length - 1];
}

export function photoFolderLine(lastDir: string | null): string {
  return lastDir ? `导出到 ${folderName(lastDir)}` : "第一次导出会让你选一个文件夹,之后记住。";
}

export function usePhotoExport(progress: ExportProgress): PhotoExport {
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
    void planSelectedPhotos(lastDir)
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
  }, [active, lastDir, settingsLoaded, status.selected_count, status.selected_photo_count]);

  const remember = useCallback((dir: string) => {
    setLastDir(dir);
    void setSetting(LAST_DIR_KEY, dir).catch(() => undefined);
  }, []);

  const start = useCallback(
    async (dir: string) => {
      // 精选带的顺序先落库,后端按它编号。
      await ensureCurrentPhotoOrderSaved();
      const outcome = await exportSelectedPhotos(dir);
      remember(dir);
      setStartedJobId(outcome.job_id);
      setJobId(outcome.job_id);
      await refresh().catch(() => undefined);
    },
    [refresh, remember, setJobId],
  );

  const announcedJob = useRef<number | null>(null);
  useEffect(() => {
    if (startedJobId === null || status.job_id !== startedJobId || announcedJob.current === startedJobId) return;
    if (status.status === "done") {
      announcedJob.current = startedJobId;
      showToast(photoDoneLine(status), { tone: status.failed_items > 0 ? "neutral" : "success", durationMs: PHOTO_DONE_TOAST_MS });
    } else if (status.status === "failed" || status.status === "blocked") {
      announcedJob.current = startedJobId;
      showToast(exportErrorLine(status.error ?? "没有写出任何文件"), { tone: "danger" });
    }
  }, [startedJobId, status]);

  const hasMissing = (plan?.missing?.length ?? 0) > 0;
  const canExport = !busy && !active && plan !== null && plan.files.length > 0 && planError === null && !hasMissing;

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
      setError(exportErrorLine(failure));
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
      setError(exportErrorLine(failure));
    }
  }, [remember]);

  const cancel = useCallback(async () => {
    if (status.job_id === null) return;
    setError(null);
    try {
      await cancelExport(status.job_id);
      await refresh();
    } catch (failure) {
      setError(exportErrorLine(failure));
    }
  }, [refresh, status.job_id]);

  const reveal = useCallback(async () => {
    if (status.job_id === null) return;
    setError(null);
    try {
      await revealExport(status.job_id);
    } catch (failure) {
      setError(exportErrorLine(failure));
    }
  }, [status.job_id]);

  // 顶栏 / 命令面板的「导出」动作在照片工作台就是「导出精选照片」。
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
    done: isPhotoExportDone(status, startedJobId),
    reveal,
  };
}
