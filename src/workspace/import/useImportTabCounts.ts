import { useCallback, useEffect, useState } from "react";

import { getImportProgress, listMissingClips } from "../../api";

export interface ImportTabCounts {
  /** 进过导入队列的素材数(`ImportProgress.total`);0 = 这个库还没导过任何东西。 */
  jobs: number;
  /** 原片此刻不在原位的条数。 */
  missing: number;
}

/**
 * R19 U-05:导入抽屉的「任务 / 缺失素材」分页各自计数 >0 才显示。抽屉打开时读一次,
 * 素材表变化(`tripcut:library-changed`)后再读;读不到当 0(分页不出,来源页永远在)。
 */
export function useImportTabCounts(): ImportTabCounts {
  const [counts, setCounts] = useState<ImportTabCounts>({ jobs: 0, missing: 0 });
  const refresh = useCallback(async () => {
    const [progress, missing] = await Promise.allSettled([getImportProgress(), listMissingClips()]);
    setCounts({
      jobs: progress.status === "fulfilled" ? progress.value.total : 0,
      missing: missing.status === "fulfilled" ? missing.value.length : 0,
    });
  }, []);
  useEffect(() => {
    let alive = true;
    const run = () => {
      void refresh().then(() => undefined, () => undefined);
    };
    run();
    const onChanged = () => {
      if (alive) run();
    };
    window.addEventListener("tripcut:library-changed", onChanged);
    return () => {
      alive = false;
      window.removeEventListener("tripcut:library-changed", onChanged);
    };
  }, [refresh]);
  return counts;
}
