import { useEffect } from "react";
import { useClipsFeed } from "./useClipsFeed";
import { selectionBelongsToEpisode } from "./useSelection";
import { dispatchWorkspace, getWorkspaceSnapshot, useWorkspace } from "./WorkspaceStore";

/**
 * 壳的布局纯函数与启动恢复 hook(R10 U-04 / U-23),从 WorkspaceShell.tsx 拆出来
 * 守 400 行;WorkspaceShell 原样 re-export 三个布局符号,旧测试的导入路径不变。
 */

/** 检查器自动折叠的窗宽阈值(R10 U-04):低于它折成竖条,回到它以上自动展开。 */
export const INSPECTOR_AUTO_COLLAPSE_WIDTH = 1400;

/** 窄窗收缩顺序的纯函数:先折检查器,再折媒体池,中栏永不折(规格 §2)。 */
export function autoCollapseFor(windowWidth: number): { pool: boolean; inspector: boolean } {
  // 1400 以下先让检查器让位(折成 44px 竖条),低于 1040 连媒体池也收起来,
  // 好让中栏永远保住它的 min 520。阈值同时是「折」和「自动恢复」的分界,没有迟滞——
  // 用户在窄窗里手动展开的检查器由 store 的 auto 位清零来保住,不靠迟滞。
  return { pool: windowWidth < 1040, inspector: windowWidth < INSPECTOR_AUTO_COLLAPSE_WIDTH };
}

/**
 * 两次窗宽之间该派发什么(纯函数,U-04 的回归测试对着它写):
 * 只在**跨过阈值**时改 auto 位。窄窗里用户点了「展开检查器」之后再拖一拖窗口
 * (仍在阈值以下)不会把它重新折回去;放大到阈值以上才清 auto 位,再缩回去才重新折。
 * `previous === null` 是挂载:按当前窗宽一次到位(本来就开在 900px 的窗口等不到 resize)。
 */
export function autoCollapseTransition(
  previous: number | null,
  next: number,
): { pool?: boolean; inspector?: boolean } | null {
  const target = autoCollapseFor(next);
  if (previous === null) return target;
  const before = autoCollapseFor(previous);
  const patch: { pool?: boolean; inspector?: boolean } = {};
  if (before.pool !== target.pool) patch.pool = target.pool;
  if (before.inspector !== target.inspector) patch.inspector = target.inspector;
  return Object.keys(patch).length === 0 ? null : patch;
}

/**
 * 启动恢复选中(R10 U-23):设置表里的 `ui.selection.last_clip` 先落在 store 的
 * `restoreClipId`,等 clips feed 第一次拉回当前集素材后核对那条还在再选中;
 * 不在(已删除 / 换了集)就静默放弃。无论成败只试一次,之后用户的选择不再被它覆盖。
 */
export function useRestoreSelection(): void {
  const restoreClipId = useWorkspace((state) => state.restoreClipId);
  const feed = useClipsFeed();
  useEffect(() => {
    if (restoreClipId === null || feed.loading || feed.revision === undefined) return;
    // N-1:clipsById 是未按集裁的全量表 —— 「还在库里」不等于「在当前集」;新建集后重启,
    // 上次选中的旧集素材不能回到空的新集里(与 tripcut:episode-changed 那条同一把尺)。
    const candidate = { kind: "clip" as const, clipId: restoreClipId };
    if (
      getWorkspaceSnapshot().selection === null &&
      feed.clipsById.has(restoreClipId) &&
      selectionBelongsToEpisode(candidate, feed.episode.activeId, feed.clipsById)
    ) {
      dispatchWorkspace({ type: "select-clip", clipId: restoreClipId });
    }
    dispatchWorkspace({ type: "consume-restore-clip" });
  }, [feed.clipsById, feed.episode.activeId, feed.loading, feed.revision, restoreClipId]);
}
