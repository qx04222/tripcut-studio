import { useCallback, useEffect, useRef, useState, type JSX } from "react";

import {
  archiveCurrentEpisode,
  createEpisode,
  deleteEpisode,
  getCurrentEpisode,
  listEpisodes,
  renameCurrentEpisode,
  setEpisodePlatform,
  type CanvasOrientation,
  type EpisodeSummary,
  type TargetPlatform,
} from "../api";
import { EpisodeArchiveControls, EpisodeList, PLATFORM_LABELS, episodeErrorMessage } from "../EpisodePanel";
import { EpisodeDeleteConfirm, episodeDeleteConsequence } from "./EpisodeDeleteConfirm";
import { EpisodeMenu, EpisodeRenameInline, type EpisodeMenuState } from "./EpisodeMenu";
import { WorkspaceEpisodeCreateForm, WorkspaceEpisodeRenameForm } from "./EpisodeForms";
import { openHistoricalEpisode, returnToActiveEpisode } from "../historyView";
import { LibraryPanel } from "../LibraryPanel";
import { useFocusTrap } from "../useFocusTrap";
import { isTopModal, popModal, pushModal } from "./modalStack";
import { Button, Icon } from "./ui";
import { failureText } from "./errorText";
import { useWorkspace } from "./WorkspaceStore";

/**
 * 顶栏「切换集」popover(规格 §1、Task 6c)。旗开路径下取代 `EpisodePanel` 的
 * 侧栏位置,但业务逻辑(刷新/重命名/封存)与 `EpisodePanel` 各自持有一份状态,
 * 只共用它导出的三个展示子组件——两处输出的 markup/行为因此保持一致。
 */
export function EpisodeSwitcher(): JSX.Element {
  const viewingEpisode = useWorkspace((state) => state.viewingEpisode);
  const [current, setCurrent] = useState<EpisodeSummary | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [archiveArmed, setArchiveArmed] = useState(false);
  // R15:「···」菜单开在哪一集、哪个位置;「删除这一集」的确认块针对哪一集。
  const [menu, setMenu] = useState<EpisodeMenuState | null>(null);
  const [deleting, setDeleting] = useState<EpisodeSummary | null>(null);
  // R16 P2-3:任意集的内联改名针对哪一集。
  const [renaming, setRenaming] = useState<EpisodeSummary | null>(null);
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

  // R13 §1:全局键位「切换集」(默认 ⇧⌘E)发这个事件,这里开 popover。
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("tripcut:open-episode-switcher", onOpen);
    return () => window.removeEventListener("tripcut:open-episode-switcher", onOpen);
  }, []);

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
    void refresh().catch((error) => setNotice(failureText("读取集列表", error)));
  }, [refresh]);

  // R10 U-16:走查里弹层写「0 素材」——后端 clip_count 是现算的,这里以前只在挂载时
  // 读过一次,导入 21 条之后再点开仍是旧值。每次打开都重读一遍。
  useEffect(() => {
    if (!open) return;
    void refresh().catch((error) => setNotice(failureText("读取集列表", error)));
  }, [open, refresh]);

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

  // R10 U-16:「新建集」。后端按当前集是否为空决定「封存 + 开新集」还是「就地改名复用」;
  // 两种结果都要派发 tripcut:episode-changed(与封存同一条约定),媒体池 / 镜头带据此换范围。
  const create = async (title: string) => {
    setBusy(true);
    try {
      const outcome = await createEpisode(title);
      setCreating(false);
      setNotice(
        outcome.reused_empty
          ? `当前集还是空的,已就地改名为「${outcome.episode.title}」(没有新建档案)`
          : `已封存「${outcome.archived?.title ?? "上一集"}」,新建并进入「${outcome.episode.title}」`,
      );
      window.dispatchEvent(
        new CustomEvent("tripcut:episode-changed", { detail: { id: outcome.episode.id, title: outcome.episode.title } }),
      );
      await refresh().catch(() => setCurrent(outcome.episode));
    } catch (error) {
      setNotice(episodeErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  // R15:删除一集。后端删完告诉我们现在哪一集在进行中;删的是当前集时媒体池 / 镜头带要换范围,
  // 删的是正在只读查看的历史集时要回到当前集 —— 两种情况都派发 tripcut:episode-changed。
  const remove = async (episode: EpisodeSummary) => {
    setBusy(true);
    try {
      const outcome = await deleteEpisode(episode.id);
      setDeleting(null);
      setNotice(
        outcome.created_fresh
          ? `已删除「${outcome.deleted.title}」,新开了空集「${outcome.active.title}」;原片没有动。`
          : `已删除「${outcome.deleted.title}」;现在在「${outcome.active.title}」;原片没有动。`,
      );
      if (episode.status === "active" || viewingEpisode?.id === episode.id) {
        if (viewingEpisode?.id === episode.id) returnToActiveEpisode();
        window.dispatchEvent(
          new CustomEvent("tripcut:episode-changed", { detail: { id: outcome.active.id, title: outcome.active.title } }),
        );
      }
      await refresh().catch(() => setCurrent(outcome.active));
    } catch (error) {
      setNotice(episodeErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const archiveUnavailable = current ? current.clip_count === 0 : true;
  // 弹层里一次只开一块(改名表单 / 新建 / 封存确认 / 删除确认 / 内联改名 / 菜单),开任何一块前先全收起。
  const closePanels = () => {
    setArchiveArmed(false);
    setEditing(false);
    setCreating(false);
    setDeleting(null);
    setRenaming(null);
    setMenu(null);
    setNotice(null);
  };
  // R16 P2-3:任意集内联改名成功后收起表单、报一句、重读列表(当前集改了名,胶囊也跟着换)。
  const afterRename = async (renamed: EpisodeSummary) => {
    closePanels();
    setNotice(`已改名为「${renamed.title}」`);
    await refresh().catch(() => undefined);
  };

  return (
    <div className="workspace-episode-switcher">
      <Button
        variant="secondary"
        className="workspace-episode-trigger"
        ref={triggerRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="切换集"
        onClick={() => { setOpen((value) => !value); closePanels(); }}
      >
        {/* Z-14:只读查看已封存集时胶囊写被查看的集名(此前仍写当前集,和媒体池对不上)。 */}
        <span className="workspace-episode-label">{viewingEpisode ? `只读 · ${viewingEpisode.title}` : current ? current.title : "切换集"}</span>
        {current && !viewingEpisode ? (
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
              <WorkspaceEpisodeRenameForm
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
                onCancel={closePanels}
              />
            ) : creating ? (
              <WorkspaceEpisodeCreateForm
                busy={busy}
                onCreate={(title) => void create(title)}
                onCancel={closePanels}
              />
            ) : (
              <div className="episode-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    closePanels();
                    setCreating(true);
                  }}
                >
                  新建集
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDraftTitle(current.title);
                    setDraftTheme(current.theme);
                    setDraftPlatform(current.target_platform);
                    setDraftOrientation(current.canvas_orientation);
                    closePanels();
                    setEditing(true);
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
                  onCancelArchive={closePanels}
                />
              </div>
            )
          ) : null}

          {renaming ? <EpisodeRenameInline episode={renaming} onSaved={afterRename} onCancel={closePanels} onError={setNotice} /> : null}

          {deleting ? (
            <EpisodeDeleteConfirm
              episode={deleting}
              busy={busy}
              consequence={episodeDeleteConsequence(deleting, episodes)}
              onConfirm={() => void remove(deleting)}
              onCancel={closePanels}
            />
          ) : null}

          <EpisodeList
            episodes={episodes}
            renderActions={(episode) => (
              <Button
                variant="icon"
                size="sm"
                icon="more"
                className="episode-row-more"
                aria-label={`集操作 · ${episode.title}`}
                aria-haspopup="menu"
                disabled={busy}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setMenu({ episode, x: rect.left, y: rect.bottom + 4 });
                }}
              />
            )}
            onSelectEpisode={(episode) => {
              if (episode.status !== "active") {
                openHistoricalEpisode(episode.id, episode.title);
              } else if (viewingEpisode) {
                // N-2:只读查看历史集时点当前集 = 回到当前集(此前只是关掉弹层,池仍停在历史集)。
                returnToActiveEpisode();
              }
              setOpen(false);
            }}
          />

          {menu ? (
            <EpisodeMenu
              menu={menu}
              onRename={(episode) => {
                closePanels();
                setRenaming(episode);
              }}
              onDelete={(episode) => {
                closePanels();
                setDeleting(episode);
              }}
              onClose={() => setMenu(null)}
            />
          ) : null}

          {notice ? <p className="episode-notice" role="status">{notice}</p> : null}

          <div className="workspace-episode-popover-footer">
            <LibraryPanel />
          </div>
        </div>
      ) : null}
    </div>
  );
}
