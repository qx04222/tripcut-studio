import { useEffect, useRef, type JSX } from "react";

import { CHAPTER_DELETE_BUTTON, CHAPTER_DELETE_CONFIRM_LABEL, CHAPTER_MENU_ITEMS, CHAPTER_MENU_LABEL } from "./copy";
import type { BandChapter } from "./shotBandModel";
import { Button } from "./ui";
import { Menu, type MenuItem } from "./ui/Menu";
import { deleteTarget, neighbourChapter, type useChapterActions } from "./useChapterActions";

type ChapterActionsState = ReturnType<typeof useChapterActions>;

/** 章头菜单的项(规格 §1 顺序冻结):重命名 · 并入上一章 · 这章够了 / 还是要镜头 · 删除这一章…。 */
export function chapterMenuItems(chapters: readonly BandChapter[], chapter: BandChapter): MenuItem[] {
  return [
    { id: "rename", label: CHAPTER_MENU_ITEMS.rename },
    { id: "merge-up", label: CHAPTER_MENU_ITEMS.mergeUp, disabled: neighbourChapter(chapters, chapter, -1) === null },
    // 「这章够了」只对 0 镜的章有意义(有镜的章不算缺口);有镜时留着但禁用,菜单形状不变。
    { id: "skip", label: chapter.skipped ? CHAPTER_MENU_ITEMS.unskip : CHAPTER_MENU_ITEMS.skip, disabled: chapter.clipCount > 0 },
    { id: "delete", label: CHAPTER_MENU_ITEMS.delete, disabled: deleteTarget(chapters, chapter) === null },
  ];
}

/**
 * 章头「···」弹出的菜单 + 「删除这一章…」的确认卡;挂在 ShotBand 的根下,一次只开一个。
 * 确认卡列出后果数字(这一章的 n 个镜头会移到哪一章),AX:alertdialog「确认删除章」/ 按钮「删除这一章」「取消」。
 */
export function ChapterMenuOverlay({
  state,
  chapters,
  onSkipChapter,
}: {
  state: ChapterActionsState;
  chapters: readonly BandChapter[];
  onSkipChapter?: (chapter: BandChapter, skipped: boolean) => void;
}): JSX.Element | null {
  const { menu, actions, closeMenu, deleting } = state;
  return (
    <>
      {menu ? (
        <Menu
          x={menu.x}
          y={menu.y}
          ariaLabel={CHAPTER_MENU_LABEL(menu.chapter.title)}
          items={chapterMenuItems(chapters, menu.chapter)}
          onSelect={(id) => {
            if (id === "rename") actions.startRename(menu.chapter);
            else if (id === "merge-up") void state.mergeUp(menu.chapter);
            else if (id === "skip") onSkipChapter?.(menu.chapter, !menu.chapter.skipped);
            else if (id === "delete") state.requestDelete(menu.chapter);
          }}
          onClose={closeMenu}
        />
      ) : null}
      {deleting ? <ChapterDeleteConfirm chapter={deleting} target={deleteTarget(chapters, deleting)} busy={state.busy} onConfirm={() => void state.confirmDelete()} onCancel={state.cancelDelete} /> : null}
    </>
  );
}

function ChapterDeleteConfirm({
  chapter,
  target,
  busy,
  onConfirm,
  onCancel,
}: {
  chapter: BandChapter;
  target: BandChapter | null;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const consequence =
    chapter.clipCount > 0 && target
      ? `这一章的 ${chapter.clipCount} 个镜头会移到「${target.title}」;顺序与精选段都保留。`
      : "这一章没有镜头,删掉不影响别的章。";
  return (
    <div ref={ref} tabIndex={-1} role="alertdialog" aria-label={CHAPTER_DELETE_CONFIRM_LABEL} className="band-chapter-delete-confirm">
      <strong>{`删除「${chapter.title}」?`}</strong>
      <p>{consequence}</p>
      <div className="band-chapter-delete-actions">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button variant="primary" tone="danger" size="sm" busy={busy} onClick={onConfirm}>
          {CHAPTER_DELETE_BUTTON}
        </Button>
      </div>
    </div>
  );
}
