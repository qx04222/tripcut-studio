import { useEffect, useRef, useState, type JSX } from "react";

import { getJobsPaused, setJobsPaused } from "../api";
import { Button } from "./ui";

/**
 * R16 P1-6:状态条「全部暂停 / 继续」。按下去 worker 不再领取新任务(导出 / 缓存清理除外),
 * 正在跑的跑完;后端持久化,重启照旧。挂载时问一次当前态;旧后端没有这条命令就当作没暂停。
 */
export function StatusPause(): JSX.Element {
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    Promise.resolve()
      .then(() => getJobsPaused())
      .then((value) => {
        if (mounted.current) setPaused(Boolean(value));
      })
      .catch(() => undefined);
    return () => {
      mounted.current = false;
    };
  }, []);

  const toggle = () => {
    const next = !paused;
    setBusy(true);
    Promise.resolve()
      .then(() => setJobsPaused(next))
      .then((value) => {
        if (mounted.current) setPaused(typeof value === "boolean" ? value : next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon={paused ? "play" : "pause"}
        className="workspace-status-pause"
        aria-pressed={paused}
        aria-label={paused ? "继续后台任务" : "全部暂停"}
        disabled={busy}
        title={paused ? "继续领取新的后台任务" : "不再领取新的后台任务;正在跑的会跑完"}
        onClick={toggle}
      >
        {paused ? "继续后台任务" : "全部暂停"}
      </Button>
      {paused ? (
        <span className="workspace-status-phrase workspace-status-paused" role="status">
          后台已暂停
        </span>
      ) : null}
    </>
  );
}
