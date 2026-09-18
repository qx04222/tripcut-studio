import { useEffect, useRef, useState } from "react";

import { getImportProgress } from "../api";
import { analysisProgressFrom, estimateRemaining, formatRemaining, type ProgressSample } from "./StatusStrip";

/** 主按钮禁用期间的轮询间隔;状态条自己也在轮询,这里只在「一条都没分析完」的短窗口里多问几次。 */
export const ANALYSIS_ETA_POLL_MS = 1_000;

/**
 * R19 U-01:顶栏主按钮禁用时要说「大约还要 …」。估算与状态条同一套纯函数
 * (`estimateRemaining` / `formatRemaining`,StatusStrip 文件不改),样本自己攒;
 * `active` 为假时不轮询、不占资源。估不出(样本不够 / 没进展)返回 null。
 */
export function useAnalysisEta(active: boolean): string | null {
  const [eta, setEta] = useState<string | null>(null);
  const samples = useRef<ProgressSample[]>([]);

  useEffect(() => {
    if (!active) {
      samples.current = [];
      setEta(null);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const progress = await getImportProgress();
        if (!alive) return;
        const { analyzed, total } = analysisProgressFrom(progress);
        const now = Date.now();
        samples.current = [...samples.current, { at: now, done: analyzed }];
        const remaining = estimateRemaining(samples.current, total, now);
        setEta(remaining === null ? null : formatRemaining(remaining));
      } catch {
        if (alive) setEta(null);
      }
      if (alive) timer = setTimeout(() => void poll(), ANALYSIS_ETA_POLL_MS);
    };
    void poll();
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active]);

  return eta;
}
