import { useRef, type JSX } from "react";
import { PhotoMonitor } from "./PhotoMonitor";
import { useClipsFeed } from "./useClipsFeed";
import { useWorkspace } from "./WorkspaceStore";

/** 独立照片工作台的检视入口：不挂视频 Monitor，也不会创建 PlayerOverlay/mpv。 */
export function PhotoMonitorHost(): JSX.Element {
  const selection = useWorkspace((state) => state.selection);
  const workspaceMode = useWorkspace((state) => state.workspaceMode);
  const feed = useClipsFeed();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedId = selection?.kind === "clip" ? selection.clipId : null;
  const clip = workspaceMode === "photo" ? feed.clips.find((item) => item.id === selectedId && item.kind === "photo") : undefined;
  if (!clip) return <div className="photo-monitor-empty">从照片网格选择一张照片</div>;
  return <PhotoMonitor clip={clip} clips={feed.clips} rootRef={rootRef} />;
}
