import { useEffect, useMemo, useState, type RefObject } from "react";

import { chapterDragKey } from "./dragGeometry";
import { renderableChapterRange, type BandChapter } from "../shotBandModel";

/**
 * 视口宽度 + 「现在看的是哪一章」+ 章级虚拟化窗口(R22-C 从 ShotBand.tsx 拆出来,那边只剩装配与渲染)。
 */
export function useBandViewport({ viewportRef, chapters, offsets, contentWidth, scrollLeft, selectedIndex, draggingKey }: {
  viewportRef: RefObject<HTMLDivElement | null>;
  chapters: readonly BandChapter[];
  offsets: readonly number[];
  /** 整条带的内容宽(最后一个 span 的右缘);没滚动过时用它钳「选中章」起点,见 renderableChapterRange。 */
  contentWidth: number;
  scrollLeft: number | null;
  selectedIndex: number;
  draggingKey: string | null;
}) {
  const [viewportWidth, setViewportWidth] = useState(0);
  // 视口宽度必须是 state:`viewportRef.current?.clientWidth` 读在 useMemo 里,
  // ref 在第一次渲染时还是 null,之后窗口再怎么改宽也不会重算(读的是渲染期的
  // 可变值,React 不会为它重跑)。ResizeObserver 把它变成一个真的会更新的输入。
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    setViewportWidth(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setViewportWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, [viewportRef]);
  // 有滚动位置时它才是「现在看的是哪一章」的权威,没有时才退回选中项(R8 复审 M3)。
  const activeChapterIndex = useMemo(() => {
    if (scrollLeft !== null) {
      let active = 0;
      offsets.forEach((offset, index) => {
        if (offset <= scrollLeft) active = index;
      });
      return active;
    }
    if (selectedIndex >= 0) {
      let seen = 0;
      for (let index = 0; index < chapters.length; index += 1) {
        seen += chapters[index]!.segments.length;
        if (selectedIndex < seen) return index;
      }
    }
    return 0;
  }, [chapters, offsets, scrollLeft, selectedIndex]);
  // 拖动源所在章:拖动期间无条件全渲染(卸载了 dnd-kit 会取消这次拖动);见 renderableChapterRange 的注释。
  const draggingChapterIndex = useMemo(
    () => (draggingKey === null ? undefined : chapters.findIndex((chapter) => chapterDragKey(chapter.chapterId) === draggingKey || chapter.segments.some((segment) => segment.key === draggingKey))),
    [chapters, draggingKey],
  );
  const rendered = useMemo(
    () => new Set(renderableChapterRange(offsets, viewportWidth || 1_200, activeChapterIndex, draggingKey !== null, scrollLeft ?? undefined, draggingChapterIndex, contentWidth).fullyRendered),
    [offsets, viewportWidth, activeChapterIndex, draggingKey, scrollLeft, draggingChapterIndex, contentWidth],
  );
  return { viewportWidth, activeChapterIndex, rendered };
}
