import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";

import { BandJianyingButton } from "./BandJianyingButton";
import { BandTimelineStage } from "./BandTimeRuler";
import { foldKey } from "./bandGeometry";
import { useBandTimeline } from "./useBandTimeline";

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

import {
  dismissStoryGap,
  generationAvailability,
  reopenStoryGap,
  type GenerationAvailability,
  type StoryGap,
  type Storyboard,
} from "../api";
import { GenerationDialog } from "../GenerationDialog";
import { BandAccessory, BandTabs, BandViewToggle, MusicRuler } from "./BandAccessory";
import { BandAutoSelect } from "./BandAutoSelect";
import { PaneHead } from "./PaneHead";
import { BandChapterSection } from "./BandChapters";
import { ChapterMenuOverlay } from "./BandChapterMenu";
import { useChapterActions } from "./useChapterActions";
import { DragGhost, generationDisabledHint } from "./BandSegment";
import { BandSegmentActions } from "./BandSegmentMenu";
import { ShotBandPicker } from "./ShotBandPicker";
import { bandPickerCandidates } from "./bandTemplateModel";
import { TakeStrip } from "./BandTakeStrip";
import {
  BAND_SEGMENT_PITCH,
  BAND_VIEWPORT_HEIGHT,
  applyBandView,
  bandCountLabel,
  buildBandChapters,
  renderableChapterRange,
  type BandChapter,
  type BandSegment,
  type BandView,
} from "./shotBandModel";
import { refreshClipsFeed, useClipsFeed } from "./useClipsFeed";
import { planBandReorder, planBandStep, useBandDrag } from "./useBandDrag";
import { useBandArrange } from "./useBandArrange";
import { useBandTakes, type BandTakesState } from "./useBandTakes";
import { useSelection } from "./useSelection";
import { dispatchWorkspace, useWorkspace } from "./WorkspaceStore";
import { BandEmpty } from "./emptyStates";
import { failureText } from "./errorText";
import { Button, showToast } from "./ui";

export { BAND_CHAPTER_HEADER_WIDTH, chapterOffsets } from "./bandGeometry";
export { ratingPatch } from "./useBandTakes";

/** 一个分段的固定宽度(含间距);章节横向偏移按它算,虚拟化窗口才有尺可量。 */
export const BAND_SEGMENT_WIDTH = BAND_SEGMENT_PITCH;
/** 提示自动消失的时长(R12 起走全局 Toast,这两个数只是它的停留时长)。 */
export const BAND_TOAST_MS = 4_000;
/** 「已忽略缺口 · 撤销」的窗口(R10 U-17)。 */
export const GAP_UNDO_MS = 5_000;
export { arrangeToast, autoSelectPlacedToast, skippedChaptersFrom } from "./useBandArrange";
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
  // 「从媒体池选择…」打开在哪一章上(R10 U-17 / U-18);null = 没开。
  const [picker, setPicker] = useState<BandChapter | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // R12 §2 / §3:一键排入、这章够了、回到第 2 步、自动挑选结果 toast(逻辑在 useBandArrange)。
  const { skipped, onSkipChapter, arranging, onArrange, onBackToSelect, onAutoSelected } = useBandArrange();

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
        : buildBandChapters(effectiveBoard, feed.gaps, feed.shotStacks, feed.clipsById, skipped),
    [effectiveBoard, feed.gaps, feed.shotStacks, feed.clipsById, skipped],
  );
  // R16 §1:章头改名 / 「···」菜单 / 并入 / 删除(状态与命令在 useChapterActions;菜单与确认卡画在栏根下)。
  const chapterActions = useChapterActions({ chapters: allChapters, readOnly });
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

  // R13 §4:时间线化 —— 折叠 / 刻度 / 播放头 / 点击定位 / 拖边裁剪(状态在 useBandTimeline,换算在 bandTimeline)。
  const selectedClipId = selection?.kind === "clip" ? selection.clipId : null;
  const timeline = useBandTimeline({ chapters, board: effectiveBoard, clipsById: feed.clipsById, selectedClipId, selectClip });
  const { offsets, folded, trim, seekInSegment } = timeline;
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
    (segment: BandSegment, ratio?: number) => {
      if (segment.kind === "slot" && segment.chapterId !== null && segment.slot !== null) {
        selectSlot(segment.chapterId, segment.slot);
      } else if (segment.clipId !== null) {
        selectClip(segment.clipId);
        // R13 §4:点在镜块几分之几处就定位到本段的那一刻(整条素材 = 素材的那一刻)。
        if (ratio !== undefined) seekInSegment(segment, ratio);
      }
      takesRef.current?.resetTakes();
      // 单键评级只认「事件目标就是容器本身」(useRatingHotkeys 的既有语义) ——
      // 点完分段把焦点交回带本身,否则点一下之后 F/X/1–5 就全哑了。
      viewportRef.current?.focus();
    },
    [selectClip, selectSlot, seekInSegment],
  );

  const takes = useBandTakes({ selection, selectedClip, selectedStack, clipsById: feed.clipsById, segments, selectedIndex, selectSegment });
  takesRef.current = takes;

  // R12 §3:拖排 / 加入镜头带的提示改走全局 Toast(带「撤销」时给 5 秒),镜头带底部那行小字退役。
  const { notice, undoable, undo: undoDrag, dismissNotice } = drag;
  useEffect(() => {
    if (notice === null) return;
    const failed = notice.includes("没成功");
    showToast(notice, {
      tone: failed ? "danger" : undoable ? "success" : "neutral",
      durationMs: undoable ? GAP_UNDO_MS : BAND_TOAST_MS,
      action: undoable ? { label: "撤销", onClick: undoDrag } : undefined,
    });
    dismissNotice();
  }, [notice, undoable, undoDrag, dismissNotice]);

  const onDismissGap = useCallback((gap: StoryGap) => {
    void dismissStoryGap(gap.id)
      .then(() => {
        showToast(`已忽略缺口「${gap.slot_label_zh}」`, {
          durationMs: GAP_UNDO_MS,
          action: {
            label: "撤销",
            onClick: () => {
              void reopenStoryGap(gap.id)
                .then(() => refreshClipsFeed(true))
                .catch((error) => showToast(failureText("撤销", error), { tone: "danger" }));
            },
          },
        });
        return refreshClipsFeed(true);
      })
      .catch((error) => showToast(failureText("忽略缺口", error), { tone: "danger" }));
  }, []);

  const closePicker = useCallback(() => setPicker(null), []);
  // 候选一直算着(不只在弹层打开时):缺口卡 / 空章卡按它决定主动作是「从挑好的片段里选」还是「回到第 2 步挑几条」。
  const pickerCandidates = useMemo(() => bandPickerCandidates(feed.clips, board), [feed.clips, board]);
  const hasCandidates = pickerCandidates.length > 0;
  const { insert } = drag;
  const onPick = useCallback(
    (clipId: number) => {
      setPicker(null);
      insert(clipId);
    },
    [insert],
  );

  const draggingSegment = draggingKey === null ? null : segments.find((segment) => segment.key === draggingKey) ?? null;
  const activeSegment = selectedIndex >= 0 ? segments[selectedIndex] : undefined;
  const clipTotal = chapters.reduce((sum, chapter) => sum + chapter.clipCount, 0);
  const gapTotal = chapters.reduce((sum, chapter) => sum + chapter.gapCount, 0);

  return (
    // 栏 landmark(规格 §7):`镜头带` 这个 AX 名是冒烟脚本的锚点,壳里不再包一层。
    <div className="shot-band workspace-pane" aria-label="镜头带" role="region" data-pane="band" tabIndex={-1}>
      <PaneHead title="镜头带" meta={chapters.length > 0 ? `${chapters.length} 章 · ${bandCountLabel(clipTotal, gapTotal)}` : "空"}>
        <BandViewToggle value={view} onChange={setView} />
        <BandAutoSelect disabled={readOnly} onOutcome={onAutoSelected} onError={(text) => showToast(text, { tone: "danger" })} />
        {/* R12 §2:镜头带唯一的主动作 —— 把挑好的片段按章排进带上。带还是空的时候这个入口
            由空态卡(BandEmpty,第 ③ 步文案)承担,工具条不重复出第二个同名主按钮。 */}
        {chapters.length > 0 ? (
          <Button variant="primary" size="sm" className="band-arrange" aria-label="一键排入" busy={arranging} disabled={readOnly} onClick={onArrange}>
            一键排入
          </Button>
        ) : null}
        <BandTabs />
      </PaneHead>
      {/* R13 §4:刻度 + 视口 + 播放头同在一个 stage 里;音乐模式的刻度轨仍在带上方,与镜头带共用同一条时间轴(规格 §3.4)。 */}
      <BandTimelineStage
        timeline={timeline}
        scrollLeft={scrollLeft ?? 0}
        ruler={bandMode === "music" ? <MusicRuler segmentCount={segments.length} scrollLeft={scrollLeft ?? 0} /> : chapters.length > 0 ? "time" : null}
        actions={<BandJianyingButton disabled={readOnly} />}
      >
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
                onDismiss={onDismissGap}
                onPickFromPool={setPicker}
                onBackToSelect={onBackToSelect}
                onSkipChapter={onSkipChapter}
                hasCandidates={hasCandidates}
                collapsed={folded.has(foldKey(chapter))}
                onToggleFold={timeline.toggleFold}
                trim={trim}
                actions={chapterActions.actions}
              />
            ))}
          </SortableContext>
          <DragOverlay>{draggingSegment ? <DragGhost segment={draggingSegment} /> : null}</DragOverlay>
        </DndContext>
        <BandSegmentActions board={effectiveBoard} drag={drag} />
      </div>
      </BandTimelineStage>
      {/* 空态放在 grid 外面(WebKit 会把 role=grid 的非 row 子节点从 AX 树剔掉,按钮在里面按名字找不到);
          R11 简化专项 #5:一句话 + 一个按钮。 */}
      {chapters.length === 0 ? (
        feed.loading ? (
          <p className="band-empty">正在整理镜头</p>
        ) : view === "gaps" ? (
          <BandEmpty variant="no-gaps" onAction={() => setView("chapter")} />
        ) : (
          <BandEmpty variant="no-chapters" />
        )
      ) : null}
      {takes.takesOpen && selectedStack ? (
        <TakeStrip
          stack={selectedStack}
          clipsById={feed.clipsById}
          activeIndex={takes.takeIndex}
          onPick={(member) => void takes.promoteTake(member)}
        />
      ) : null}
      {picker ? (
        <ShotBandPicker chapterTitle={picker.chapterId === null ? null : picker.title} candidates={pickerCandidates} busy={drag.busy} onPick={onPick} onClose={closePicker} />
      ) : null}
      <BandAccessory />
      <ChapterMenuOverlay state={chapterActions} chapters={allChapters} onSkipChapter={onSkipChapter} />
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
