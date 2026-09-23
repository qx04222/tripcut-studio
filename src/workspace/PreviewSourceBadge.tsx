import { useEffect, useRef, useState } from "react";
import { playerSetPreviewQuality, setSetting, type PlayerStatus } from "../api";
import { autoPolicySuffix, createDropMonitor, qualityLabel, sourceBadgeLabel } from "./previewSource";
import { requestStatusRefreshSoon, usePausedSourceRefresh } from "./previewSourceRefresh";
import { isPlayerOccluded } from "./modalStack";

export function PreviewSourceBadge({ status }: { status: PlayerStatus | null }) {
  const monitor = useRef(createDropMonitor());
  const clip = useRef(status?.clip_id);
  const [struggling, setStruggling] = useState(false);
  usePausedSourceRefresh(status);
  useEffect(() => {
    if (clip.current !== status?.clip_id) {
      monitor.current = createDropMonitor();
      clip.current = status?.clip_id;
    }
    // R29:监视器被覆盖层盖住时原生视图不画帧,mpv 把每一帧都记成掉帧 —— 那段不算,按暂停处理(清零重计)。
    setStruggling(monitor.current.feed(status?.frame ?? null, status?.dropped_frames,
      (status?.paused ?? true) || isPlayerOccluded(), status?.source_kind).struggling);
  }, [status]);
  const label = sourceBadgeLabel(status);
  if (!label) return null;
  async function useProxy() {
    try { await setSetting("performance.preview_quality", "auto"); }
    catch (error) { console.warn("预览画质保存失败", error); }
    try { await playerSetPreviewQuality("auto"); requestStatusRefreshSoon(); }
    catch (error) { console.warn("预览画质切换失败", error); }
  }
  return (
    <div className="preview-source-badge" role="status" aria-label="预览来源" title={`预览画质：${qualityLabel(status?.preview_quality)}`}>
      <span>{label}{autoPolicySuffix(status)}</span>
      {/* R28:自动档由播放器自己在掉帧时退代理,只有手选的档位才需要提示 + 退路按钮。 */}
      {struggling && status?.preview_quality !== "auto" ? <>
        <span className="preview-source-badge-warning">原片播放掉帧</span>
        <button type="button" aria-label="改用代理播放" onClick={() => void useProxy()}>改用代理播放</button>
      </> : null}
    </div>
  );
}
