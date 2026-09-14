import { useEffect, useRef, useState, type JSX } from "react";

import { retryClipAnalysis, type ClipListItem } from "../api";
import { failureText } from "./errorText";
import { Button } from "./ui";
import { refreshClipsFeed } from "./useClipsFeed";

/**
 * R16 P2-4:技术检查段的「重新分析这条」。分析 / 运镜任一失败或受阻时是主要动作;
 * 正常时降级为 ghost,仍能点(想重跑就重跑)。返回两个 0 = 已经分析完,说一句「不用重跑」。
 */
export function InspectorRetryAnalysis({ clip }: { clip: ClipListItem }): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => setNotice(null), [clip.id]);
  if (clip.id === null) return null;
  const clipId = clip.id;
  const failed = clip.analysis_status === "failed" || clip.analysis_status === "blocked" || clip.motion_status === "failed" || clip.motion_status === "blocked";
  const running = clip.analysis_status === "running" || clip.analysis_status === "pending";

  const onRetry = () => {
    setBusy(true);
    setNotice(null);
    retryClipAnalysis(clipId)
      .then(async (outcome) => {
        await refreshClipsFeed(true).catch(() => undefined);
        if (!mounted.current) return;
        setNotice(outcome.reset + outcome.enqueued > 0 ? "已重新排队,分析在后台继续。" : "这条已经分析完,不用重跑。");
      })
      .catch((error) => {
        if (mounted.current) setNotice(failureText("重新分析", error));
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  return (
    <div className="inspector-retry-analysis">
      <Button size="sm" variant={failed ? "primary" : "ghost"} busy={busy} disabled={running} aria-label="重新分析这条" onClick={onRetry}>
        重新分析这条
      </Button>
      {notice ? (
        <p className="inspector-notice" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
