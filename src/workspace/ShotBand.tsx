import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";

import { generationAvailability, type GenerationAvailability, type StoryGap, type Storyboard } from "../api";
import { GenerationDialog } from "../GenerationDialog";
import { BandAccessory, BandTabs, BandViewToggle, MusicRuler } from "./BandAccessory";
import { PaneHead } from "./PaneHead";
import { BandChapterSection, BandToast } from "./BandChapters";
import { DragGhost, generationDisabledHint } from "./BandSegment";
import { TakeStrip } from "./BandTakeStrip";
import { chapterOffsets } from "./bandGeometry";
import {
  BAND_SEGMENT_PITCH,
  BAND_VIEWPORT_HEIGHT,
  applyBandView,
  buildBandChapters,
  renderableChapterRange,
  type BandSegment,
  type BandView,
} from "./shotBandModel";
import { refreshClipsFeed, useClipsFeed } from "./useClipsFeed";
import { planBandReorder, planBandStep, useBandDrag } from "./useBandDrag";
import { useBandTakes, type BandTakesState } from "./useBandTakes";
import { useSelection } from "./useSelection";
import { dispatchWorkspace, useWorkspace } from "./WorkspaceStore";

export { BAND_CHAPTER_HEADER_WIDTH, chapterOffsets } from "./bandGeometry";
export { ratingPatch } from "./useBandTakes";

/** 一个分段的固定宽度(含间距);章节横向偏移按它算,虚拟化窗口才有尺可量。 */
export const BAND_SEGMENT_WIDTH = BAND_SEGMENT_PITCH;
/** 提示自动消失的时长。 */
export const BAND_TOAST_MS = 4_000;

export function ShotBand(): JSX.Element {
  const feed = useClipsFeed();
  const bandMode = useWorkspace((state) => state.bandMode);
  // 后端命令理论上总返回一份故事板,但「理论上」不该是整栏白屏的唯一防线:
  // 拉取失败/尚未返回时 feed 里可能是 undefined,`?? null` 让它走空态而不是抛。
  const board: Storyboard | null = feed.storyboard ?? null;
  const drag = useBandDrag(board);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [view, setView] = useState<BandView>("chapter");
  // null = 这一栏还没被滚动过。有滚动位置时它才是「现在看的是哪一章」的权威,
  // 没有时才退回选中项 —— 反过来会让滚到第 4 章时第 1 章仍被展开(R8 复审 M3)。
  const [scrollLeft, setScrollLeft] = useState<number | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [availability, setAvailability] = useState<GenerationAvailability | null>(null);
  const [generationGap, setGenerationGap] = useState<StoryGap | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    void generationAvailability()
      .then((next) => {
        if (active && next) setAvailability(next);
      })
      // 取不到就按「状态未知」处理 —— 按钮禁用并说明,而不是给一个会报错的入口。
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const disabledHint = generationDisabledHint(availability);
  // 查看历史集 = 只读档案:生成/取消/重试/忽略一律不许写(与 MusicPanel 同一条判定)。
  const readOnly = feed.episode.viewing !== null;

  const effectiveBoard = useMemo<Storyboard | null>(() => {
    if (board === null) return null;
    return drag.optimisticItems ? { ...board, items: [...drag.optimisticItems] } : board;
  }, [board, drag.optimisticItems]);

  const allChapters = useMemo(
    () =>
      effectiveBoard === null
        ? []
        : buildBandChapters(effectiveBoard, feed.gaps, feed.shotStacks, feed.clipsById),
    [effectiveBoard, feed.gaps, feed.shotStacks, feed.clipsById],
  );
  // 按时间 / 仅缺口是纯函数视图;按章节原样返回,不多算一遍。
  const chapters = useMemo(() => applyBandView(allChapters, view, feed.clipsById), [allChapters, view, feed.clipsById]);
  const segments = useMemo(() => chapters.flatMap((chapter) => chapter.segments), [chapters]);
  const visibleIds = useMemo(
    () => segments.map((segment) => segment.clipId).filter((id): id is number => id !== null),
    [segments],
  );
  const { selection, selectClip, selectSlot, selectedClip, selectedStack } = useSelection(visibleIds);

  const selectedIndex = useMemo(
    () =>
      segments.findIndex((segment) =>
        selection?.kind === "clip"
          ? segment.clipId === selection.clipId
          : selection?.kind === "slot"
            ? segment.chapterId === selection.chapterId && segment.slot === selection.slot
            : false,
      ),
    [segments, selection],
  );
  const indexOf = useCallback((key: string) => segments.findIndex((segment) => segment.key === key), [segments]);

  const offsets = useMemo(() => chapterOffsets(chapters), [chapters]);
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
  }, []);

  const range = useMemo(
    () =>
      renderableChapterRange(offsets, viewportWidth || 1_200, activeChapterIndex, draggingKey !== null, scrollLeft ?? undefined),
    [offsets, viewportWidth, activeChapterIndex, draggingKey, scrollLeft],
  );

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const { setOverKey } = drag;

  const onDragStart = useCallback((event: DragStartEvent) => {
    setDraggingKey(String(event.active.id));
  }, []);

  const onDragOver = useCallback(
    (event: DragOverEvent) => setOverKey(event.over ? String(event.over.id) : null),
    [setOverKey],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggingKey(null);
      setOverKey(null);
      const { active, over } = event;
      if (!over || effectiveBoard === null) return;
      drag.apply(planBandReorder(effectiveBoard, String(active.id), String(over.id)));
    },
    [drag, effectiveBoard, setOverKey],
  );

  // Take 条的状态层在下面才装配(它需要 selectSegment),这里先留一个 ref 给 selectSegment 用。
  const takesRef = useRef<BandTakesState | null>(null);
  const selectSegment = useCallback(
    (segment: BandSegment) => {
      if (segment.kind === "slot" && segment.chapterId !== null && segment.slot !== null) {
        selectSlot(segment.chapterId, segment.slot);
      } else if (segment.clipId !== null) {
        selectClip(segment.clipId);
      }
      takesRef.current?.resetTakes();
      // 单键评级只认「事件目标就是容器本身」(useRatingHotkeys 的既有语义) ——
      // 点完分段把焦点交回带本身,否则点一下之后 F/X/1–5 就全哑了。
      viewportRef.current?.focus();
    },
    [selectClip, selectSlot],
  );

  const takes = useBandTakes({ selection, selectedClip, selectedStack, clipsById: feed.clipsById, segments, selectedIndex, selectSegment });
  takesRef.current = takes;

  // 提示自己会走:4 秒后消失。之前 `dismissNotice` 根本没人调,一条「已调整顺序」
  // 会一直挂在带下面,直到下一次拖排把它换掉。
  const { notice, dismissNotice } = drag;
  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(dismissNotice, BAND_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [notice, dismissNotice]);

  const draggingSegment = draggingKey === null ? null : segments.find((segment) => segment.key === draggingKey) ?? null;
  const activeSegment = selectedIndex >= 0 ? segments[selectedIndex] : undefined;

  return (
    // 栏 landmark(规格 §7):`镜头带` 这个 AX 名是冒烟脚本的锚点,壳里不再包一层。
    <div className="shot-band workspace-pane" aria-label="镜头带" role="region" data-pane="band" tabIndex={-1}>
      <PaneHead title="镜头带" meta={chapters.length > 0 ? `${chapters.length} 章 · ${segments.length} 镜` : "空"}>
        <BandViewToggle value={view} onChange={setView} />
        <BandTabs />
      </PaneHead>
      {/* 音乐模式的刻度轨在带**上方**,与镜头带共用同一条时间轴(规格 §3.4)。 */}
      {bandMode === "music" ? <MusicRuler segmentCount={segments.length} scrollLeft={scrollLeft ?? 0} /> : null}
      <div
        className="band-viewport"
        ref={viewportRef}
        tabIndex={0}
        // 与媒体池同一套语义:整带是一张单行网格,分段是 gridcell,
        // 键盘入口只有容器一个(roving 由 aria-activedescendant 指路)。
        role="grid"
        aria-label="镜头序列"
        aria-activedescendant={
          activeSegment
            ? activeSegment.kind === "slot"
              ? `band-slot-${activeSegment.chapterId}-${activeSegment.slot}`
              : `band-clip-${activeSegment.clipId}`
            : undefined
        }
        // 视口高钉在内容高上(规格 §3.7):中栏再高,瓦片下方也不留白。
        style={{ "--band-content-height": `${BAND_VIEWPORT_HEIGHT}px` } as CSSProperties}
        onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
        onKeyDown={takes.hotkeys.onKeyDown}
        onCompositionStart={takes.hotkeys.onCompositionStart}
        onCompositionEnd={takes.hotkeys.onCompositionEnd}
        onFocus={() => {
          takes.hotkeys.onFocus();
          dispatchWorkspace({ type: "focus-pane", pane: "band" });
        }}
      >
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
          <SortableContext items={segments.map((segment) => segment.key)} strategy={horizontalListSortingStrategy}>
            {chapters.map((chapter, index) => (
              <BandChapterSection
                key={chapter.chapterId ?? `unchaptered-${index}`}
                chapter={chapter}
                folded={index < range.from || index > range.to}
                selectedKey={activeSegment?.key}
                draggingKey={draggingKey}
                overKey={drag.overKey}
                indexOf={indexOf}
                // 按时间的顺序是拍摄时间定的,不许拖排。
                dragBusy={drag.busy || view === "time"}
                readOnly={readOnly}
                disabledHint={disabledHint}
                onSelect={selectSegment}
                onStep={(segment, direction) => {
                  if (effectiveBoard) drag.apply(planBandStep(effectiveBoard, segment.key, direction));
                }}
                onGenerate={setGenerationGap}
              />
            ))}
          </SortableContext>
          <DragOverlay>{draggingSegment ? <DragGhost segment={draggingSegment} /> : null}</DragOverlay>
        </DndContext>
        {chapters.length === 0 ? (
          <p className="band-empty">
            {feed.loading ? "正在整理镜头" : view === "gaps" ? "所有章节都没有缺口。" : "导入完成后会按拍摄时间自动生成章节。"}
          </p>
        ) : null}
      </div>
      {takes.takesOpen && selectedStack ? (
        <TakeStrip
          stack={selectedStack}
          clipsById={feed.clipsById}
          activeIndex={takes.takeIndex}
          onPick={(member) => void takes.promoteTake(member)}
        />
      ) : null}
      {drag.notice ? (
        <BandToast notice={drag.notice} undoable={drag.undoable} onDismiss={drag.dismissNotice} onUndo={drag.undo} />
      ) : null}
      <BandAccessory />
      {generationGap ? (
        // `GenerationDialog` 本体一行不改,只是换了个宿主(R7 的参数预填照旧)。
        <GenerationDialog
          gap={generationGap}
          readOnly={readOnly}
          availability={availability}
          onClose={() => setGenerationGap(null)}
          onSubmitted={() => {
            setGenerationGap(null);
            void refreshClipsFeed(true);
          }}
        />
      ) : null}
    </div>
  );
}
