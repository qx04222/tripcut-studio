import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";

import { CHAPTER_MENU_LABEL, CHAPTER_TITLE_INPUT_LABEL } from "./copy";
import type { BandChapter } from "./shotBandModel";
import { Button } from "./ui";

/**
 * R16 车道 B(规格 §1):章头上「人能点到的两样」——章名(双击改名)与「···」(章操作菜单)。
 * 状态与命令都在 `useChapterActions`,这里只画;BandChapters 把 `actions` 传进来,不传就还是
 * 原来的只读带头(测试与旧壳不受影响)。
 */
export interface ChapterActions {
  readOnly: boolean;
  /** 正在内联改名的章;null = 没在改。 */
  renamingId: number | null;
  startRename(chapter: BandChapter): void;
  cancelRename(): void;
  /** 提交改名;失败时 toast 已由 hook 给出,输入框留着(返回 false)。 */
  commitRename(chapter: BandChapter, title: string): Promise<boolean>;
  openMenu(chapter: BandChapter, anchor: { x: number; y: number }): void;
}

/** 章名:平时是 `strong`,双击进入内联输入框(AX 名「章节名」;Enter 提交,Esc 取消,不用 window.prompt)。 */
export function ChapterTitle({ chapter, actions }: { chapter: BandChapter; actions?: ChapterActions }): JSX.Element {
  const editable = Boolean(actions) && !actions!.readOnly && chapter.chapterId !== null;
  if (actions && chapter.chapterId !== null && actions.renamingId === chapter.chapterId) {
    return <ChapterRenameInput chapter={chapter} actions={actions} />;
  }
  return (
    <strong
      className="band-chapter-title"
      // tooltip 仍是章名本身(R10 U-29 的断言钉着它);「双击改名」写在菜单里,不塞进 title。
      title={chapter.title}
      onDoubleClick={editable ? () => actions!.startRename(chapter) : undefined}
    >
      {chapter.title}
    </strong>
  );
}

function ChapterRenameInput({ chapter, actions }: { chapter: BandChapter; actions: ChapterActions }): JSX.Element {
  const [value, setValue] = useState(chapter.title);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement | null>(null);
  // 提交 / 取消之后组件会被卸下;blur 在卸下时也会来一次,用它挡住「取消后再提交一次」。
  const settled = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = async () => {
    if (settled.current || busy) return;
    const title = value.trim();
    if (title === "" || title === chapter.title) {
      settled.current = true;
      actions.cancelRename();
      return;
    }
    setBusy(true);
    const ok = await actions.commitRename(chapter, title);
    setBusy(false);
    if (ok) settled.current = true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // 带本身是 grid,F/X/1–5 等单键都在它上面听;输入框里的键一律不往上冒(useRatingHotkeys 也认输入框,双保险)。
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      settled.current = true;
      actions.cancelRename();
    }
  };

  return (
    <input
      ref={ref}
      className="band-chapter-title-input"
      aria-label={CHAPTER_TITLE_INPUT_LABEL}
      value={value}
      maxLength={80}
      disabled={busy}
      onChange={(event) => setValue(event.currentTarget.value)}
      onKeyDown={onKeyDown}
      onBlur={() => void commit()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}

/** 章头「···」:AX 名「章操作 · <章名>」,点了把菜单开在按钮下方。 */
export function ChapterMoreButton({ chapter, actions }: { chapter: BandChapter; actions: ChapterActions }): JSX.Element | null {
  if (chapter.chapterId === null) return null;
  return (
    <Button
      variant="icon"
      size="sm"
      icon="more"
      className="band-chapter-more"
      aria-label={CHAPTER_MENU_LABEL(chapter.title)}
      aria-haspopup="menu"
      disabled={actions.readOnly}
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        actions.openMenu(chapter, { x: rect.left, y: rect.bottom + 4 });
      }}
    />
  );
}
