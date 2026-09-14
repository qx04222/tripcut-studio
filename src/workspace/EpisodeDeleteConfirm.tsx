import { useEffect, useRef, type JSX } from "react";

import type { EpisodeSummary } from "../api";
import { Button } from "./ui";

export interface EpisodeDeleteConfirmProps {
  episode: EpisodeSummary;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/** 删掉这一集之后会发生什么,一句话说清(切集弹层与首页共用同一段话)。 */
export function episodeDeleteConsequence(episode: EpisodeSummary, episodes: readonly EpisodeSummary[]): string {
  if (episode.status !== "active") return "";
  const fallback = episodes.filter((item) => item.id !== episode.id).sort((a, b) => b.id - a.id)[0];
  return fallback ? `删掉后回到「${fallback.title}」继续。` : "删掉后会新开一个空集。";
}

/**
 * R15:「删除这一集」的确认块。AX:alertdialog「确认删除集」;按钮「删除这一集」/「取消」。
 * 文案只说三件事:删的是哪一集、会一起没掉什么、原片不会被删。
 */
export function EpisodeDeleteConfirm({ episode, busy, onConfirm, onCancel, consequence }: EpisodeDeleteConfirmProps & { consequence?: string }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div ref={ref} tabIndex={-1} role="alertdialog" aria-label="确认删除集" className="episode-delete-confirm">
      <strong>{`删除「${episode.title}」?`}</strong>
      <p>
        {`这一集的 ${episode.clip_count} 条素材记录、收藏和顺序会一起删掉;原片不会被删。`}
        {consequence ? ` ${consequence}` : ""}
      </p>
      <div className="episode-delete-actions">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button variant="primary" tone="danger" size="sm" busy={busy} onClick={onConfirm}>
          删除这一集
        </Button>
      </div>
    </div>
  );
}
