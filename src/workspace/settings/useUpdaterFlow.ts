import { useCallback, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";

import {
  IDLE_UPDATER_VIEW,
  checkForUpdate,
  downloadAndInstall,
  downloadProgressLabel,
  restartApp,
  updateFoundMessage,
  updaterErrorMessage,
  type UpdaterView,
} from "../../updaterClient";

export interface UpdaterFlow {
  updater: UpdaterView;
  /** 有一个已找到、尚未装好的更新包(决定「下载并安装」按钮出不出现)。 */
  updatePending: boolean;
  runUpdateCheck(): Promise<void>;
  runUpdateInstall(): Promise<void>;
  runRestart(): Promise<void>;
}

/** 应用内更新三步(逐字迁自 SettingsPage.tsx 的 runUpdateCheck / runUpdateInstall / runRestart)。 */
export function useUpdaterFlow(): UpdaterFlow {
  const [updater, setUpdater] = useState<UpdaterView>(IDLE_UPDATER_VIEW);
  const [updatePending, setUpdatePending] = useState(false);
  const pendingUpdateRef = useRef<Update | null>(null);

  // 检查/下载/重启三步各自独立:下载失败(比如签名对不上)时不能把「检查更新」也锁死,
  // 否则用户只能重启应用才能再试一次。
  const runUpdateCheck = useCallback(async () => {
    pendingUpdateRef.current = null;
    setUpdatePending(false);
    setUpdater({ ...IDLE_UPDATER_VIEW, phase: "checking", message: "正在检查更新…" });
    try {
      const found = await checkForUpdate();
      if (!found) {
        setUpdater({ ...IDLE_UPDATER_VIEW, phase: "up-to-date", message: "已是最新版本。" });
        return;
      }
      pendingUpdateRef.current = found;
      setUpdatePending(true);
      const notes = found.body ?? null;
      setUpdater({
        phase: "available",
        version: found.version,
        notes,
        downloadedBytes: 0,
        totalBytes: null,
        message: updateFoundMessage(found.version, notes),
      });
    } catch (error) {
      setUpdater({ ...IDLE_UPDATER_VIEW, phase: "error", message: updaterErrorMessage(error) });
    }
  }, []);

  const runUpdateInstall = useCallback(async () => {
    const pending = pendingUpdateRef.current;
    if (!pending) return;
    setUpdater((previous) => ({
      ...previous,
      phase: "downloading",
      downloadedBytes: 0,
      totalBytes: null,
      message: "正在下载更新包…",
    }));
    try {
      await downloadAndInstall(pending, (downloadedBytes, totalBytes) => {
        setUpdater((previous) => ({
          ...previous,
          phase: "downloading",
          downloadedBytes,
          totalBytes,
          message: downloadProgressLabel(downloadedBytes, totalBytes),
        }));
      });
      setUpdater((previous) => ({
        ...previous,
        phase: "ready",
        message: `新版本 ${pending.version} 已安装，重启后生效。`,
      }));
    } catch (error) {
      // 装不上就必须回到「可以再试」的状态,并且如实说清是签名没过还是网络断了。
      pendingUpdateRef.current = pending;
      setUpdatePending(true);
      setUpdater((previous) => ({
        ...previous,
        phase: "error",
        message: updaterErrorMessage(error),
      }));
    }
  }, []);

  const runRestart = useCallback(async () => {
    try {
      await restartApp();
    } catch (error) {
      setUpdater((previous) => ({ ...previous, phase: "error", message: updaterErrorMessage(error) }));
    }
  }, []);

  return { updater, updatePending, runUpdateCheck, runUpdateInstall, runRestart };
}
