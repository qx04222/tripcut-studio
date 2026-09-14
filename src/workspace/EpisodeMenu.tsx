import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";

import { renameEpisode, type EpisodeSummary } from "../api";
import { EPISODE_MENU_ITEMS, EPISODE_RENAME_FORM_LABEL, EPISODE_RENAME_INPUT_LABEL } from "./copy";
import { failureText } from "./errorText";
import { Button, Menu } from "./ui";
import type { MenuItem } from "./ui/Menu";

/**
 * R16 车道 B P2-3:集的「···」菜单(切集弹层与首页卡共用同一份项;规格 §1 同一实体同一菜单)
 * + 任意集的内联改名表单(不限当前集;`rename_episode(id)`)。
 */
export interface EpisodeMenuState {
  episode: EpisodeSummary;
  x: number;
  y: number;
}

/** 菜单项顺序冻结:重命名 · 删除这一集(「删除这一集」是 R15 的冻结名)。 */
export function episodeMenuItems(): MenuItem[] {
  return [
    { id: "rename", label: EPISODE_MENU_ITEMS.rename },
    { id: "delete", label: EPISODE_MENU_ITEMS.delete, ariaLabel: EPISODE_MENU_ITEMS.delete },
  ];
}

export function EpisodeMenu({
  menu,
  onRename,
  onDelete,
  onClose,
}: {
  menu: EpisodeMenuState;
  onRename(episode: EpisodeSummary): void;
  onDelete(episode: EpisodeSummary): void;
  onClose(): void;
}): JSX.Element {
  return (
    <Menu
      items={episodeMenuItems()}
      x={menu.x}
      y={menu.y}
      ariaLabel={`集操作 · ${menu.episode.title}`}
      onSelect={(id) => {
        if (id === "rename") onRename(menu.episode);
        else if (id === "delete") onDelete(menu.episode);
      }}
      onClose={onClose}
    />
  );
}

/**
 * 任意集的内联改名:一行输入框(AX 名「新的集标题」)+「保存」/「取消」;Enter 提交、Esc 取消。
 * 只改标题,主题原样带回(主题与平台仍走「重命名本集」那张完整表单)。失败时表单留着,错误由宿主的 status 行说。
 */
export function EpisodeRenameInline({
  episode,
  onSaved,
  onCancel,
  onError,
}: {
  episode: EpisodeSummary;
  onSaved(renamed: EpisodeSummary): void | Promise<void>;
  onCancel(): void;
  onError(text: string): void;
}): JSX.Element {
  const [title, setTitle] = useState(episode.title);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const save = async () => {
    const next = title.trim();
    if (next === "" || busy) return;
    if (next === episode.title) {
      onCancel();
      return;
    }
    setBusy(true);
    try {
      const renamed = await renameEpisode(episode.id, next, episode.theme);
      await onSaved(renamed);
    } catch (error) {
      onError(failureText("改名", error));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

  return (
    <form
      className="episode-rename-inline"
      aria-label={EPISODE_RENAME_FORM_LABEL}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <input
        ref={ref}
        className="episode-rename-input"
        aria-label={EPISODE_RENAME_INPUT_LABEL}
        value={title}
        maxLength={120}
        disabled={busy}
        onChange={(event) => setTitle(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
        取消
      </Button>
      <Button variant="primary" size="sm" type="submit" busy={busy} disabled={title.trim() === ""}>
        保存
      </Button>
    </form>
  );
}
