import { useCallback, useEffect, useMemo, useRef } from "react";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";

import { dismissStoryGap, reopenStoryGap, type StoryGap, type Storyboard } from "../../api";
import type { RatingAction } from "../../SelectPage";
import { applyBatchRating } from "../batchRating";
import { failureText } from "../errorText";
import type { BandChapter, BandSegment } from "../shotBandModel";
import { showToast } from "../ui/Toast";
import { releasePlaythrough } from "../playthrough/store";
import { registerBandUndo } from "../useBandArrange";
import { refreshClipsFeed } from "../useClipsFeed";
import type { ClipListItem } from "../../api";
import { bandCollision, chapterDragKey, CHAPTER_DRAG_PREFIX, magneticBand } from "./dragGeometry";
import { moveBandItems, removeBandItems } from "./order";
import type { useBandEdits } from "./useBandEdits";
import type { useBandSelection } from "./useBandSelection";

/**
 * R22-C 镜头带的「动作」层:拖排落点(段 / 整章 / 跨章 / 多选整组)、批量移出 / 移到章 / 评级、忽略缺口。
 * 从 ShotBand.tsx 拆出来(那边只剩装配与渲染,行数回到 400 以内);每个动作一次 `drag.save`
 * = 一次 set_band_order 写入 + 一条 ⌘Z 记录(useBandEdits.persist 登记)。
 */
export function useBandCommands({ drag, effectiveBoard, segments, chapters, multi, indexOf, readOnly, clipsById, setDraggingKey }: {
  drag: ReturnType<typeof useBandEdits>;
  effectiveBoard: Storyboard | null;
  segments: readonly BandSegment[];
  chapters: readonly BandChapter[];
  multi: ReturnType<typeof useBandSelection>;
  indexOf: (key: string) => number;
  readOnly: boolean;
  clipsById: ReadonlyMap<number, ClipListItem>;
  setDraggingKey: (key: string | null) => void;
}) {
  // 第 2 项:⌥ 按住 = 关磁吸(碰撞检测与吸附 modifier 都读这个 ref,不走 state 免得每帧重渲染)。
  const altKey = useRef(false);
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => { altKey.current = event.altKey; };
    const reset = () => { altKey.current = false; };
    window.addEventListener("keydown", key); window.addEventListener("keyup", key); window.addEventListener("blur", reset);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("keyup", key); window.removeEventListener("blur", reset); };
  }, []);
  const collision = useMemo(() => bandCollision(() => altKey.current), []);
  const magnet = useMemo(() => magneticBand(() => altKey.current), []);
  const { setOverKey } = drag;
  const onDragStart = useCallback((event: DragStartEvent) => {
    // 0.11.3 接线:拖动段 / 章 = 开始编辑镜头带 → 连播停、素材继续播(与拖进度条同语义)。
    releasePlaythrough();
    altKey.current = Boolean((event.activatorEvent as globalThis.PointerEvent | undefined)?.altKey);
    setDraggingKey(String(event.active.id));
  }, [setDraggingKey]);
  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggingKey(null);
      setOverKey(null);
      const { active, over } = event;
      if (!over || effectiveBoard === null) return;
      // 拖的是章头:整章换位,段的归属不动。
      if (String(active.id).startsWith(CHAPTER_DRAG_PREFIX)) {
        const next = [...effectiveBoard.chapters];
        const from = next.findIndex((chapter) => chapterDragKey(chapter.id) === String(active.id));
        const to = next.findIndex((chapter) => chapterDragKey(chapter.id) === String(over.id));
        if (from >= 0 && to >= 0 && from !== to) { const [moved] = next.splice(from, 1); next.splice(to, 0, moved!); void drag.save([...effectiveBoard.items], "移动章节", next).catch(() => undefined); }
        return;
      }
      // 落在某一块上 → 插到它前 / 后;落在章(空章 / 折叠章 / 缺口卡)上 → 追加到该章末尾。跨章只改这几段在带上的归属。
      const target = segments.find((segment) => segment.key === String(over.id));
      const chapter = chapters.find((chapter) => chapterDragKey(chapter.chapterId) === String(over.id) || chapter.segments.some((segment) => segment.key === String(over.id)));
      if (!chapter) return;
      const keys = multi.dragKeys(String(active.id));
      const next = moveBandItems(effectiveBoard, keys, target?.kind === "clip" ? target.key : null, chapter.chapterId, indexOf(String(active.id)) < indexOf(String(over.id)));
      void drag.save(next, `移动 ${keys.length} 段`).catch(() => undefined);
    },
    [drag, effectiveBoard, setOverKey, segments, chapters, multi, indexOf, setDraggingKey],
  );
  const onDismissGap = useCallback((gap: StoryGap) => {
    if (readOnly) return;
    void dismissStoryGap(gap.id).then(() => {
      registerBandUndo("忽略缺口", () => reopenStoryGap(gap.id), `已忽略缺口「${gap.slot_label_zh}」`);
      return refreshClipsFeed(true);
    }).catch((error) => showToast(failureText("忽略缺口", error), { tone: "danger" }));
  }, [readOnly]);
  const removeSelected = () => {
    if (readOnly || !effectiveBoard || !multi.keys.length) return;
    void drag.save(removeBandItems(effectiveBoard, multi.keys), `移出 ${multi.keys.length} 段`).catch(() => undefined);
  };
  const moveSelected = (chapterId: number | null) => {
    if (readOnly || !effectiveBoard || !multi.keys.length) return;
    void drag.save(moveBandItems(effectiveBoard, multi.keys, null, chapterId), `移动 ${multi.keys.length} 段`).catch(() => undefined);
  };
  // 批量评级作用于源素材;同一素材的多个段只评一次(applyBatchRating 内去重)。
  const rateSelected = (action: RatingAction) => {
    if (readOnly || drag.busy) return;
    const ids = segments.filter((segment) => multi.selected.has(segment.key)).flatMap((segment) => (segment.clipId === null ? [] : [segment.clipId]));
    void applyBatchRating(ids, action, clipsById, registerBandUndo);
  };
  return { collision, magnet, onDragStart, onDragEnd, onDismissGap, removeSelected, moveSelected, rateSelected };
}
