import { useCallback, useMemo, useState } from "react";

import { deleteChapter, mergeChapters, renameChapter } from "../api";
import { undoStoryChangeNoticing } from "./storyUndo";
import type { ChapterActions } from "./BandChapterHeadActions";
import type { BandChapter } from "./shotBandModel";
import { failureText } from "./errorText";
import { showToast } from "./ui/Toast";
import { registerBandUndo } from "./useBandArrange";
import { refreshClipsFeed } from "./useClipsFeed";

export interface ChapterMenuState {
  chapter: BandChapter;
  x: number;
  y: number;
}

/** 「已并入 / 已删除」toast 与撤销 toast 的停留(与镜头带其它可撤销提示同 5 秒)。 */
export const CHAPTER_UNDO_MS = 5_000;

/** 上一章 / 下一章(按序号;「未分章」桶 chapterId 为 null,不算邻章)。 */
export function neighbourChapter(chapters: readonly BandChapter[], chapter: BandChapter, direction: -1 | 1): BandChapter | null {
  const index = chapters.findIndex((candidate) => candidate.chapterId === chapter.chapterId);
  if (index < 0) return null;
  const next = chapters[index + direction];
  return next && next.chapterId !== null ? next : null;
}

/** 删章时镜头的去向:先上一章,没有就下一章(与 Rust `delete_chapter` 同一条规则)。 */
export function deleteTarget(chapters: readonly BandChapter[], chapter: BandChapter): BandChapter | null {
  return neighbourChapter(chapters, chapter, -1) ?? neighbourChapter(chapters, chapter, 1);
}

/**
 * R16 车道 B:章头的改名 / 菜单 / 并入 / 删除状态与命令(P1-3、P2-1)。ShotBand 只拿 `actions` 传给每章带头,
 * 菜单与确认卡由 `ChapterMenuOverlay` 按这里的状态画。
 * 改名 / 并入 / 删除都走故事板快照(`undo_story_change` 整份恢复);并入可撤销(toast + ⌘Z 栈),删除先确认。
 */
export function useChapterActions({ chapters, readOnly }: { chapters: readonly BandChapter[]; readOnly: boolean }): {
  actions: ChapterActions;
  menu: ChapterMenuState | null;
  closeMenu(): void;
  deleting: BandChapter | null;
  cancelDelete(): void;
  confirmDelete(): Promise<void>;
  requestDelete(chapter: BandChapter): void;
  mergeUp(chapter: BandChapter): Promise<void>;
  busy: boolean;
} {
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [menu, setMenu] = useState<ChapterMenuState | null>(null);
  const [deleting, setDeleting] = useState<BandChapter | null>(null);
  const [busy, setBusy] = useState(false);

  const startRename = useCallback((chapter: BandChapter) => {
    if (chapter.chapterId === null) return;
    setMenu(null);
    setRenamingId(chapter.chapterId);
  }, []);
  const cancelRename = useCallback(() => setRenamingId(null), []);

  const commitRename = useCallback(async (chapter: BandChapter, title: string): Promise<boolean> => {
    if (readOnly || chapter.chapterId === null) return false;
    try {
      await renameChapter(chapter.chapterId, title);
    } catch (error) {
      showToast(failureText("改名", error), { tone: "danger" });
      return false;
    }
    setRenamingId(null);
    registerBandUndo("改名章节", undoStoryChangeNoticing, `已改名为「${title}」`);
    await refreshClipsFeed(true);
    return true;
  }, [readOnly]);

  const openMenu = useCallback((chapter: BandChapter, anchor: { x: number; y: number }) => {
    setRenamingId(null);
    setMenu({ chapter, ...anchor });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  // 并入上一章:一次 merge_chapters,toast「撤销」与 ⌘Z 栈共用同一个只跑一次的撤销闭包。
  const mergeUp = useCallback(
    async (chapter: BandChapter) => {
      const target = neighbourChapter(chapters, chapter, -1);
      if (chapter.chapterId === null || target === null || target.chapterId === null) return;
      try {
        await mergeChapters(chapter.chapterId, target.chapterId);
      } catch (error) {
        showToast(failureText("并入上一章", error), { tone: "danger" });
        return;
      }
      registerBandUndo("并入上一章", undoStoryChangeNoticing, `已把「${chapter.title}」并入「${target.title}」`);
      await refreshClipsFeed(true);
    },
    [chapters],
  );

  const requestDelete = useCallback((chapter: BandChapter) => {
    setMenu(null);
    setDeleting(chapter);
  }, []);
  const cancelDelete = useCallback(() => setDeleting(null), []);
  const confirmDelete = useCallback(async () => {
    if (deleting === null || deleting.chapterId === null) return;
    setBusy(true);
    try {
      await deleteChapter(deleting.chapterId);
      setDeleting(null);
      registerBandUndo("删除章节", undoStoryChangeNoticing, `已删除「${deleting.title}」`);
      await refreshClipsFeed(true);
    } catch (error) {
      showToast(failureText("删除", error), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }, [deleting]);

  const actions = useMemo<ChapterActions>(
    () => ({ readOnly, renamingId, startRename, cancelRename, commitRename, openMenu }),
    [readOnly, renamingId, startRename, cancelRename, commitRename, openMenu],
  );

  return { actions, menu, closeMenu, deleting, cancelDelete, confirmDelete, requestDelete, mergeUp, busy };
}
