import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSettingsStatus,
  importPaths,
  listWatchedFolders,
  pickImportFolder,
  removeWatchedFolder,
  rescanWatchedFolders,
  setWatchedFolderSync,
  startImport,
  type WatchedFolder,
} from "../../api";

export interface ImportSources {
  watched: readonly WatchedFolder[];
  /** 扫描 / 导入的一句话结果(文案逐字沿用 ImportPage)。 */
  notice: string | null;
  /** 导入失败;后台刷新成功也不清它(旧壳测试「keeps an import failure visible」)。 */
  error: string | null;
  choosing: boolean;
  dragActive: boolean;
  toolchainMissing: boolean;
  /** 本次会话里最近一次手选的文件夹。 */
  folder: string | null;
  chooseFolder(): Promise<void>;
  rescan(): Promise<void>;
  setAutoSync(id: number, on: boolean): Promise<void>;
  remove(id: number): Promise<void>;
  refreshWatched(): Promise<void>;
}

function importNotice(total: number, enqueued: number, skipped: number): string {
  const duplicateNote = skipped > 0 ? `，跳过 ${skipped} 项已入库或已排队素材（可能属于其他集）` : "";
  return `已发现 ${total} 个视频，新增 ${enqueued} 项${duplicateNote}`;
}

/**
 * 抽自 `ImportPage`:关注文件夹、选文件夹导入、立即扫描、拖放导入、工具链状态、
 * `tripcut:action` 的 `import-pick`。api 调用顺序与文案一字不改;
 * 导入成功后调 `onImported`(旧壳在这里 `refresh()` 素材表,新壳由任务 hook 负责)。
 */
export function useImportSources(options: { onImported?: () => void } = {}): ImportSources {
  const { onImported } = options;
  const [watched, setWatched] = useState<WatchedFolder[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [toolchainMissing, setToolchainMissing] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;

  const refreshWatched = useCallback(async () => {
    setWatched(await listWatchedFolders().catch(() => []));
  }, []);

  useEffect(() => {
    void refreshWatched();
  }, [refreshWatched]);

  useEffect(() => {
    let active = true;
    void getSettingsStatus()
      .then((status) => {
        if (active) setToolchainMissing(!status.ffmpeg.available || !status.ffprobe.available);
      })
      .catch(() => {
        if (active) setToolchainMissing(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const chooseFolder = useCallback(async () => {
    setChoosing(true);
    setError(null);
    setNotice(null);
    try {
      const selected = await pickImportFolder();
      if (!selected) return;
      setFolder(selected);
      const started = await startImport(selected);
      setNotice(importNotice(started.total, started.enqueued, started.skipped));
      onImportedRef.current?.();
    } catch (importError) {
      setError(String(importError));
    } finally {
      setChoosing(false);
    }
  }, []);

  useEffect(() => {
    const onAction = (event: Event) => {
      if ((event as CustomEvent<string>).detail === "import-pick") void chooseFolder();
    };
    window.addEventListener("tripcut:action", onAction);
    return () => window.removeEventListener("tripcut:action", onAction);
  }, [chooseFolder]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDragActive(true);
        } else if (payload.type === "leave") {
          setDragActive(false);
        } else if (payload.type === "drop") {
          setDragActive(false);
          if (payload.paths.length === 0) return;
          setError(null);
          setNotice(null);
          void importPaths(payload.paths)
            .then((results) => {
              const total = results.reduce((sum, result) => sum + result.total, 0);
              const enqueued = results.reduce((sum, result) => sum + result.enqueued, 0);
              const skipped = results.reduce((sum, result) => sum + result.skipped, 0);
              setNotice(importNotice(total, enqueued, skipped));
              onImportedRef.current?.();
            })
            .catch((importError) => setError(String(importError)));
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const rescan = useCallback(async () => {
    setNotice("正在扫描…");
    try {
      const outcome = await rescanWatchedFolders();
      // NAS 断线时必须说清「没扫成」,不能显示成「没有新素材」
      const parts: string[] = [];
      if (outcome.enqueued > 0) parts.push(`发现 ${outcome.enqueued} 条新素材,已开始导入`);
      else if (outcome.scanned > 0) parts.push("没有新素材");
      if (outcome.unavailable > 0) {
        parts.push(`${outcome.unavailable} 个文件夹当前不可用(未挂载或已移除),本轮未扫描`);
      }
      setNotice(parts.join(";") || "没有可扫描的关注文件夹");
      await refreshWatched();
    } catch (scanError) {
      setNotice(String(scanError));
    }
  }, [refreshWatched]);

  const setAutoSync = useCallback(async (id: number, on: boolean) => {
    try {
      await setWatchedFolderSync(id, on);
      await refreshWatched();
    } catch (syncError) {
      setNotice(String(syncError));
    }
  }, [refreshWatched]);

  const remove = useCallback(async (id: number) => {
    try {
      await removeWatchedFolder(id);
      await refreshWatched();
    } catch (removeError) {
      setNotice(String(removeError));
    }
  }, [refreshWatched]);

  return { watched, notice, error, choosing, dragActive, toolchainMissing, folder, chooseFolder, rescan, setAutoSync, remove, refreshWatched };
}
