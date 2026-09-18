import { useEffect } from "react";

import { bridgeMusicAnalyzedEvents } from "../api";
import { getClipsFeedSnapshot } from "./useClipsFeed";
import { selectionBelongsToEpisode } from "./useSelection";
import { dispatchWorkspace, getWorkspaceSnapshot, type DrawerKind } from "./WorkspaceStore";

/** 转接完就该被 `#/` 覆盖掉的那几条旧 hash(规格 §7 的"不留旧路由")。 */
const LEGACY_HASHES: readonly string[] = ["#/import", "#/deliver", "#/settings", "#/review"];
export function isLegacyHash(hash: string): boolean {
  return LEGACY_HASHES.includes(hash.startsWith("#/") ? hash : `#/${hash.replace(/^#/, "")}`);
}

/** 旧 hash → 新壳动作;无法识别的 hash 落到工作区本体。 */
export function drawerForLegacyHash(hash: string): DrawerKind {
  const route = hash.replace(/^#\/?/, "");
  if (route === "import") return "import";
  if (route === "deliver") return "deliver";
  if (route === "settings") return "settings";
  return null; // #/review 与其它一律落到工作区本体
}

/**
 * 壳挂在 window 上的三组监听(R19 从 WorkspaceShell.tsx 拆出来守 400 行;行为一字不改):
 * 1. 旧 hash 转接(#/import / #/deliver / #/settings → 抽屉,转接完收回 `#/`,R8 终审 L5);
 * 2. 历史集只读查看 / 换集清选中(`tripcut:view-episode`、`tripcut:episode-changed`,L6 / N-2 / R-06);
 * 3. 后端 `tripcut:music-analyzed` Tauri 事件桥接成同名 window 事件(R10 U-19)。
 */
export function useShellWindowEvents(): void {
  useEffect(() => {
    const apply = () => {
      const hash = window.location.hash;
      const drawer = drawerForLegacyHash(hash);
      if (drawer !== null) dispatchWorkspace({ type: "open-drawer", drawer });
      // 旧 hash 只用来"转接"一次,转接完就把地址栏收回 `#/`(R8 终审 L5)。
      // 不收的话刷新一次又会把同一个抽屉重新弹开——用户关掉的东西自己回来了。
      if (isLegacyHash(hash)) window.history.replaceState(null, "", "#/");
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  useEffect(() => {
    // 历史集只读查看(顶栏集切换里点一条已封存的集 → `openHistoricalEpisode`)。
    // 旧壳靠 SelectPage 接这个事件;新壳里没有 SelectPage,不接就等于点了没反应
    // (R8 终审 L6)。
    const onViewEpisode = (event: Event) => {
      const detail = (event as CustomEvent<{ id: number; title: string } | null>).detail;
      if (!detail || typeof detail.id !== "number") {
        // N-2:detail 为空 = 回到当前集(`returnToActiveEpisode`)。只读查看时选中的历史集素材
        // 不能带回当前集,按当前集校验一次。
        dispatchWorkspace({ type: "view-episode", episode: null });
        const { selection } = getWorkspaceSnapshot();
        const { clipsById, episode } = getClipsFeedSnapshot();
        if (!selectionBelongsToEpisode(selection, episode.activeId, clipsById)) {
          dispatchWorkspace({ type: "clear-selection" });
        }
        return;
      }
      dispatchWorkspace({ type: "view-episode", episode: { id: detail.id, title: detail.title } });
    };
    const onEpisodeChanged = (event: Event) => {
      dispatchWorkspace({ type: "view-episode", episode: null });
      // 新建 / 切换集后监视器与检查器不能还停在旧集的素材上(R-06):选中不在新集里就清掉。
      // 用未按集裁的 clipsById 判归属 —— feed 自己也在听这个事件,裁过的列表这一刻可能已经空了。
      const detail = (event as CustomEvent<{ id?: unknown } | null>).detail;
      const episodeId = typeof detail?.id === "number" ? detail.id : null;
      const { selection } = getWorkspaceSnapshot();
      if (!selectionBelongsToEpisode(selection, episodeId, getClipsFeedSnapshot().clipsById)) {
        dispatchWorkspace({ type: "clear-selection" });
      }
    };
    window.addEventListener("tripcut:view-episode", onViewEpisode);
    window.addEventListener("tripcut:episode-changed", onEpisodeChanged);
    return () => {
      window.removeEventListener("tripcut:view-episode", onViewEpisode);
      window.removeEventListener("tripcut:episode-changed", onEpisodeChanged);
    };
  }, []);

  useEffect(() => {
    // R10 U-19:后端的 `tripcut:music-analyzed` Tauri 事件在壳层桥接一次成同名 window 事件,
    // 音乐面板 / 状态条各自 addEventListener。非 Tauri 环境里桥是 no-op。
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void bridgeMusicAnalyzedEvents().then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
