import { useEffect, type RefObject, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { POOL_ROW_HEIGHT, poolRowTop } from "./poolModel";

/** Existing grid focus/keyboard behavior extracted to keep MediaPool below 400 lines. */
export function usePoolGridNavigation({ viewportRef, gridHadFocus, anchorId, startRow, endRow, visibleCount, inTakes, visibleIds, navigationRows, columns, viewportHeight, setScrollTop, selectClip, hotkeys, selectFirstOnEntry = false }: {
  viewportRef: RefObject<HTMLDivElement | null>;
  gridHadFocus: RefObject<boolean>;
  anchorId: number | null; startRow: number; endRow: number; visibleCount: number;
  inTakes: boolean; visibleIds: readonly number[]; columns: number; viewportHeight: number;
  navigationRows?: readonly (readonly number[])[];
  setScrollTop(value: number): void; selectClip(id: number): void;
  hotkeys: { onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void };
  selectFirstOnEntry?: boolean;
}) {
  // 虚拟化会把锚点卡片整个卸载掉 —— 焦点跟着卡片一起消失,键盘就此失灵。 卡片还在就把焦点放回卡片,卡片没了就交还给容器(aria-activedescendant 仍指着锚点)。
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (!gridHadFocus.current) return;
    const active = document.activeElement;
    // 卡片被卸载时焦点会掉到 <body> —— 那正是要救的情形,所以 body 也算"还是我们的"。
    if (active !== null && active !== document.body && !viewport.contains(active)) return;
    const card = anchorId === null ? null : document.getElementById(`pool-clip-${anchorId}`);
    if (card) {
      if (active !== card) card.focus();
    } else if (active !== viewport) {
      viewport.focus();
    }
  }, [anchorId, startRow, endRow, visibleCount]);
  return (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Stack 展开时 ↑↓ 在候选里移动(useMediaPoolHotkeys),不做网格漫游。

    const takesKey = event.key === "ArrowUp" || event.key === "ArrowDown";
    if (anchorId === null && selectFirstOnEntry && visibleIds.length > 0 && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      selectClip(visibleIds[0]!);
      return;
    }
    if (anchorId === null || visibleIds.length === 0 || (inTakes && takesKey)) {
      hotkeys.onKeyDown(event);
      return;
    }
    const index = visibleIds.indexOf(anchorId);
    if (index < 0) {
      hotkeys.onKeyDown(event);
      return;
    }
    const step =
      event.key === "ArrowRight" ? 1
      : event.key === "ArrowLeft" ? -1
      : event.key === "ArrowDown" ? columns
      : event.key === "ArrowUp" ? -columns
      : 0;
    if (step === 0) {
      hotkeys.onKeyDown(event);
      return;
    }
    event.preventDefault();
    const vertical = event.key === "ArrowDown" || event.key === "ArrowUp";
    const currentRowIndex = vertical && navigationRows ? navigationRows.findIndex((row) => row.includes(anchorId)) : -1;
    const currentColumnIndex = currentRowIndex < 0 ? -1 : navigationRows![currentRowIndex]!.indexOf(anchorId);
    const targetRowIndex = currentRowIndex < 0
      ? Math.floor(Math.min(visibleIds.length - 1, Math.max(0, index + step)) / columns)
      : Math.min(navigationRows!.length - 1, Math.max(0, currentRowIndex + (event.key === "ArrowDown" ? 1 : -1)));
    const targetRow = currentRowIndex < 0 ? undefined : navigationRows![targetRowIndex];
    const next = targetRow?.[Math.min(currentColumnIndex, targetRow.length - 1)]
      ?? visibleIds[Math.min(visibleIds.length - 1, Math.max(0, index + step))];
    if (next === undefined) return;
    selectClip(next);
    // 目标行可能在渲染窗口之外(那时 DOM 里根本没有这张卡,scrollIntoView 无从谈起), 所以先把视口滚过去,再让已经渲染出来的那张自己对齐。
    const viewport = viewportRef.current;
    if (viewport) {
      const top = poolRowTop(targetRowIndex);
      const bottom = top + POOL_ROW_HEIGHT;
      const height = viewport.clientHeight || viewportHeight;
      let nextScrollTop = viewport.scrollTop;
      if (top < nextScrollTop) nextScrollTop = top;
      else if (bottom > nextScrollTop + height) nextScrollTop = bottom - height;
      if (nextScrollTop !== viewport.scrollTop) {
        viewport.scrollTop = nextScrollTop;
        setScrollTop(nextScrollTop);
      }
    }
    document.getElementById(`pool-clip-${next}`)?.scrollIntoView?.({ block: "nearest" });
  };
}
