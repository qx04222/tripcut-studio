import { useCallback, useEffect, useState } from "react";
import { getExportStatus, type ExportStatus } from "../../api";
import { EMPTY_STATUS, isExportActive } from "./deliverModel";
import { failureText } from "../errorText";

export interface ExportProgress {
  status: ExportStatus;
  jobId: number | null;
  setJobId(id: number | null): void;
  setStatus(s: ExportStatus): void;
  /** 立刻拉一次;失败会抛(调用方决定吞不吞),同时留在 `error` 上。 */
  refresh(): Promise<void>;
  /** pending / running。 */
  active: boolean;
  /** 最近一次轮询 / refresh 的错误;下一次成功后清空。 */
  error: string | null;
}

/**
 * `getExportStatus` 轮询(从 `DeliverPage` 抽出,行为不变):进行中 750ms 一轮,
 * 空闲 2000ms 一轮;`tripcut:episode-changed` 清空 job 与状态并重取。
 */
export function useExportProgress(): ExportProgress {
  const [status, setStatus] = useState<ExportStatus>(EMPTY_STATUS);
  const [jobId, setJobId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await getExportStatus(jobId);
      setStatus(next);
      if (next.job_id !== null && jobId === null) setJobId(next.job_id);
      setError(null);
    } catch (refreshError) {
      setError(failureText("读取导出进度", refreshError));
      throw refreshError;
    }
  }, [jobId]);

  const active = isExportActive(status);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const next = await getExportStatus(jobId);
        if (!alive) return;
        setStatus(next);
        if (next.job_id !== null && jobId === null) setJobId(next.job_id);
        setError(null);
      } catch (pollError) {
        if (alive) setError(String(pollError));
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), active ? 750 : 2_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [jobId, active]);

  useEffect(() => {
    let alive = true;
    const resetForEpisode = () => {
      setJobId(null);
      setStatus(EMPTY_STATUS);
      setError(null);
      void getExportStatus(null)
        .then((next) => {
          if (!alive) return;
          setStatus(next);
          setJobId(next.job_id);
        })
        .catch((episodeError) => {
          if (alive) setError(String(episodeError));
        });
    };
    window.addEventListener("tripcut:episode-changed", resetForEpisode);
    return () => {
      alive = false;
      window.removeEventListener("tripcut:episode-changed", resetForEpisode);
    };
  }, []);

  return { status, jobId, setJobId, setStatus, refresh, active, error };
}
