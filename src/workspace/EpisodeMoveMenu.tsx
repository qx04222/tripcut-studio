import { useEffect, useState, type JSX } from "react";

import { listEpisodes, type EpisodeSummary } from "../api";
import { moveClipsToOtherEpisode } from "./clipMenuModel";
import { EPISODE_MOVE_CURRENT_SUFFIX, EPISODE_MOVE_MENU_LABEL, episodeMoveTargetLabel } from "./copy";
import { episodeProgress } from "./homeModel";
import { Menu, type MenuItem } from "./ui/Menu";
import { useClipsFeed } from "./useClipsFeed";

/**
 * R17 epmove:素材菜单「移到其他集…」的后半步 —— 一个小 `Menu`(AX 名「选择目标集」)列出库里的集:
 * 集名 + 进度 + 素材数,当前集(素材现在所在的那一集)灰掉不可选;选中即移动(可撤销,所以不弹确认)。
 * 已封存的历史集也能作目标(后端允许),搬过去的素材在只读查看那一集时能看到。
 */

/**
 * 库里一共几集(菜单项「移到其他集…」恰好一集时禁用)。`open` 为真时才读 —— 菜单弹开那一下问一次后端,
 * 素材卡挂载不发 IPC;读不到就是「不知道」,菜单项照常可用(后端会再拒一次)。
 */
export function useEpisodeCount(open: boolean): number | undefined {
  const [count, setCount] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void Promise.resolve()
      .then(() => listEpisodes())
      .then((list) => {
        if (alive && Array.isArray(list)) setCount(list.length);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open]);
  return count;
}

export function episodeMoveMenuItems(episodes: readonly EpisodeSummary[], currentId: number | null): MenuItem[] {
  return episodes.map((episode) => {
    const current = episode.id === currentId;
    const done = episodeProgress(episode, null).filter(Boolean).length;
    return {
      id: String(episode.id),
      label: current ? `${episode.title} · ${EPISODE_MOVE_CURRENT_SUFFIX}` : episodeMoveTargetLabel(episode.title, done, episode.clip_count),
      ariaLabel: episode.title,
      disabled: current,
    };
  });
}

export interface EpisodeMoveMenuProps {
  x: number;
  y: number;
  clipIds: readonly number[];
  onClose(): void;
}

export function EpisodeMoveMenu({ x, y, clipIds, onClose }: EpisodeMoveMenuProps): JSX.Element | null {
  const [episodes, setEpisodes] = useState<EpisodeSummary[] | null>(null);
  const feed = useClipsFeed();
  useEffect(() => {
    let alive = true;
    void listEpisodes()
      .then((list) => {
        if (alive) setEpisodes(list);
      })
      .catch(() => {
        if (alive) setEpisodes([]);
      });
    return () => {
      alive = false;
    };
  }, []);
  if (episodes === null) return null;
  // 素材现在所在的集:多选里取第一条的归属;拿不到就按正在看的那一集。
  const first = feed.clipsById.get(clipIds[0] ?? -1);
  const currentId = first?.episode_id ?? feed.episode.scopeId ?? feed.episode.activeId;
  return (
    <div className="epmove-menu-host">
      <Menu
        x={x}
        y={y}
        ariaLabel={EPISODE_MOVE_MENU_LABEL}
        items={episodeMoveMenuItems(episodes, currentId)}
        onSelect={(id) => {
          const target = episodes.find((episode) => String(episode.id) === id);
          if (target) void moveClipsToOtherEpisode(clipIds, target);
        }}
        onClose={onClose}
      />
    </div>
  );
}
