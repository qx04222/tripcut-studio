import { useCallback, useEffect, useRef, useState, type JSX } from "react";

import {
  archiveCurrentEpisode,
  getCurrentEpisode,
  listEpisodes,
  renameCurrentEpisode,
  setEpisodePlatform,
  type CanvasOrientation,
  type EpisodeSummary,
  type TargetPlatform,
} from "../api";
import {
  EpisodeArchiveControls,
  EpisodeList,
  EpisodeRenameForm,
  PLATFORM_LABELS,
  episodeErrorMessage,
} from "../EpisodePanel";
import { openHistoricalEpisode } from "../historyView";
import { LibraryPanel } from "../LibraryPanel";
import { useFocusTrap } from "../useFocusTrap";
import { isTopModal, popModal, pushModal } from "./modalStack";
import { Button, Icon } from "./ui";

/**
 * 顶栏「切换集」popover(规格 §1、Task 6c)。旗开路径下取代 `EpisodePanel` 的
 * 侧栏位置,但业务逻辑(刷新/重命名/封存)与 `EpisodePanel` 各自持有一份状态,
 * 只共用它导出的三个展示子组件——两处输出的 markup/行为因此保持一致。
 */
export function EpisodeSwitcher(): JSX.Element {
  const [current, setCurrent] = useState<EpisodeSummary | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [archiveArmed, setArchiveArmed] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftTheme, setDraftTheme] = useState("");
  const [draftPlatform, setDraftPlatform] = useState<TargetPlatform>("general");
  const [draftOrientation, setDraftOrientation] = useState<CanvasOrientation>("landscape");
  const [archivePlatform, setArchivePlatform] = useState<TargetPlatform>("general");
  const [archiveOrientation, setArchiveOrientation] = useState<CanvasOrientation>("landscape");
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const modalToken = useRef({});

  useFocusTrap(popoverRef, open);

  // popover 打开期间进模态栈:监视器据此把原生视频视图藏起来(R9 D1),
  // 壳的全局 Esc 也知道这一下轮不到它。
  useEffect(() => {
    if (!open) return;
    const token = modalToken.current;
    pushModal(token);
    return () => popModal(token);
  }, [open]);

  const refresh = useCallback(async () => {
    const [nextCurrent, nextList] = await Promise.all([getCurrentEpisode(), listEpisodes()]);
    setCurrent(nextCurrent);
    setEpisodes(nextList);
  }, []);

  useEffect(() => {
    void refresh().catch((error) => setNotice(String(error)));
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!isTopModal(modalToken.current)) return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // 点 popover 之外的任何地方都收起来(R8 终审 L8)。触发按钮自己排除在外,
  // 否则点它会先被这里关掉、再被 onClick 打开,看起来像"点了没反应"。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const archive = async () => {
    if (!archiveArmed) {
      if (current) {
        setArchivePlatform(current.target_platform);
        setArchiveOrientation(current.canvas_orientation);
      }
      setArchiveArmed(true);
      setNotice("再次点击确认:本集将封存为只读档案,并按下方选择开启下一集。");
      return;
    }
    setArchiveArmed(false);
    setBusy(true);
    try {
      const outcome = await archiveCurrentEpisode(null, archivePlatform, archiveOrientation);
      setNotice(`已封存「${outcome.archived.title}」,当前进入「${outcome.next.title}」`);
      window.dispatchEvent(
        new CustomEvent("tripcut:episode-changed", { detail: { id: outcome.next.id, title: outcome.next.title } }),
      );
      try {
        await refresh();
      } catch (refreshError) {
        console.error("episode list refresh failed after archive", refreshError);
        setCurrent(outcome.next);
        setNotice(`已封存「${outcome.archived.title}」，但集列表刷新失败；当前已切换到「${outcome.next.title}」。`);
      }
    } catch (error) {
      setNotice(episodeErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const saveRename = async () => {
    if (!current) return;
    setBusy(true);
    try {
      await renameCurrentEpisode(draftTitle, draftTheme);
      await setEpisodePlatform(current.id, draftPlatform, draftOrientation);
      setEditing(false);
      setNotice("集信息已更新");
      await refresh();
    } catch (error) {
      setNotice(episodeErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const archiveUnavailable = current ? current.clip_count === 0 : true;

  return (
    <div className="workspace-episode-switcher">
      <Button
        variant="secondary"
        className="workspace-episode-trigger"
        ref={triggerRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="切换集"
        onClick={() => {
          setOpen((value) => !value);
          setArchiveArmed(false);
          setEditing(false);
          setNotice(null);
        }}
      >
        <span className="workspace-episode-label">{current ? current.title : "切换集"}</span>
        {current ? (
          <>
            <span className="workspace-episode-sep" aria-hidden="true">
              ·
            </span>
            <span className="workspace-episode-platform">{PLATFORM_LABELS[current.target_platform]}</span>
          </>
        ) : null}
        <Icon name="chevron-down" size={12} className="workspace-episode-caret" />
      </Button>

      {open ? (
        <div
          ref={popoverRef}
          // 里面装的是重命名表单、封存控件、集列表和素材库切换——都是普通控件,
          // 不是 `menuitem`。既然做不成一致的 menu/menuitem 组合,就用 dialog
          // (R8 终审 L8);触发按钮的 aria-haspopup 跟着改成 "dialog"。
          role="dialog"
          aria-modal="false"
          aria-label="切换集"
          className="workspace-episode-popover"
          tabIndex={-1}
        >
          {current ? (
            editing ? (
              <EpisodeRenameForm
                busy={busy}
                draftTitle={draftTitle}
                draftTheme={draftTheme}
                draftPlatform={draftPlatform}
                draftOrientation={draftOrientation}
                onTitleChange={setDraftTitle}
                onThemeChange={setDraftTheme}
                onPlatformChange={setDraftPlatform}
                onOrientationChange={setDraftOrientation}
                onSave={() => void saveRename()}
                onCancel={() => {
                  setEditing(false);
                  setNotice(null);
                }}
              />
            ) : (
              <div className="episode-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDraftTitle(current.title);
                    setDraftTheme(current.theme);
                    setDraftPlatform(current.target_platform);
                    setDraftOrientation(current.canvas_orientation);
                    setEditing(true);
                    setNotice(null);
                  }}
                >
                  重命名本集
                </button>
                <EpisodeArchiveControls
                  busy={busy}
                  archiveArmed={archiveArmed}
                  archiveUnavailable={archiveUnavailable}
                  archivePlatform={archivePlatform}
                  archiveOrientation={archiveOrientation}
                  onArchivePlatformChange={setArchivePlatform}
                  onArchiveOrientationChange={setArchiveOrientation}
                  onArchive={() => void archive()}
                  onCancelArchive={() => {
                    setArchiveArmed(false);
                    setNotice(null);
                  }}
                />
              </div>
            )
          ) : null}

          <EpisodeList
            episodes={episodes}
            onSelectEpisode={(episode) => {
              if (episode.status !== "active") {
                openHistoricalEpisode(episode.id, episode.title);
              }
              setOpen(false);
            }}
          />

          {notice ? <p className="episode-notice" role="status">{notice}</p> : null}

          <div className="workspace-episode-popover-footer">
            <LibraryPanel />
          </div>
        </div>
      ) : null}
    </div>
  );
}
