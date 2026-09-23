import { PlaythroughButton } from "./playthrough/PlaythroughOverlay";
import { useBandPlaythrough } from "./playthrough/useBandPlaythrough";
import { BandDetailsProvider } from "./band/SegmentDetails";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type MouseEvent } from "react";
import { BandJianyingButton } from "./BandJianyingButton";
import { BandTimelineStage } from "./BandTimeRuler";
import { foldKey, musicPitchCount } from "./bandGeometry";
import { useBandTimeline } from "./useBandTimeline";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragOverEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import {
  generationAvailability,
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
  type BandChapter,
  type BandSegment,
  type BandView,
} from "./shotBandModel";
import { refreshClipsFeed, useClipsFeed } from "./useClipsFeed";
import { planBandStep } from "./useBandDrag";
import { useBandArrange } from "./useBandArrange";
import { useBandTakes, type BandTakesState } from "./useBandTakes";
import { useSelection } from "./useSelection";
import { dispatchWorkspace, useWorkspace } from "./WorkspaceStore";
import { BandEmpty } from "./emptyStates";
import { Button, showToast } from "./ui";
import { BandViewTools } from "./band/BandViewTools";
import { groupAdjacentGaps } from "./band/gaps";
import { BandChapterFrame } from "./band/BandChapterFrame";
import { chapterDragKey } from "./band/dragGeometry";
import { useBandPreferences } from "./band/useBandPreferences";
import { useBandNavigation } from "./band/useBandNavigation";
import { bandKeyDown } from "./band/bandKeyboard";
import { BandEmptyGuide } from "./band/BandEmptyGuide";
import { useBandEdits } from "./band/useBandEdits";
import { useBandCommands } from "./band/useBandCommands";
import { useBandSelection } from "./band/useBandSelection";
import { BandSelectionTools } from "./band/BandSelectionTools";
import { dragRenderKeys } from "./band/dragWindow";
import { useBandViewport } from "./band/useBandViewport";
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
  // R22-C:拖排 / 移出 / 排入 / 跨章都走 useBandEdits(set_band_order 一次写入 + 统一撤销登记)。
  const drag = useBandEdits(board);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [view, setView] = useState<BandView>("chapter");
  // null = 这一栏还没被滚动过。有滚动位置时它才是「现在看的是哪一章」的权威,
  // 没有时才退回选中项 —— 反过来会让滚到第 4 章时第 1 章仍被展开(R8 复审 M3)。
  const [scrollLeft, setScrollLeft] = useState<number | null>(null);
  const [availability, setAvailability] = useState<GenerationAvailability | null>(null);
  const [generationGap, setGenerationGap] = useState<StoryGap | null>(null);
  // 「从媒体池选择…」打开在哪一章上(R10 U-17 / U-18);null = 没开。
  const [picker, setPicker] = useState<BandChapter | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // R12 §2 / §3:这章够了、回到第 2 步、自动挑选结果 toast(逻辑在 useBandArrange);一键排入自 R22-C 起在 useBandEdits.arrange。
  const { skipped, onSkipChapter, onBackToSelect, onAutoSelected } = useBandArrange();
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
  const preferences = useBandPreferences(feed.episode.scopeId, readOnly);

  const effectiveBoard = useMemo<Storyboard | null>(() => {
    if (board === null) return null;
    return drag.optimisticItems ? { ...board, items: [...drag.optimisticItems] } : board;
  }, [board, drag.optimisticItems]);
  const allChapters = useMemo(
    () =>
      effectiveBoard === null
        ? []
        : groupAdjacentGaps(buildBandChapters(effectiveBoard, feed.gaps, feed.shotStacks, feed.clipsById, skipped)),
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
  const multi = useBandSelection(segments, feed.episode.scopeId, viewportRef);
  const selectedIndex = useMemo(
    () =>
      segments.findIndex((segment) =>
        multi.activeKey ? segment.key === multi.activeKey : selection?.kind === "clip"
          ? segment.clipId === selection.clipId
          : selection?.kind === "slot"
            ? segment.chapterId === selection.chapterId && segment.slot === selection.slot
            : false,
      ),
    [segments, selection, multi.activeKey],
  );
  const indexMap = useMemo(() => new Map(segments.map((segment, index) => [segment.key, index])), [segments]);
  const indexOf = useCallback((key: string) => indexMap.get(key) ?? -1, [indexMap]);

  // R13 §4:时间线化 —— 折叠 / 刻度 / 播放头 / 点击定位 / 拖边裁剪(状态在 useBandTimeline,换算在 bandTimeline);R22-C 的缩放 / 折叠记忆从 preferences 注入。
  const selectedClipId = selection?.kind === "clip" ? selection.clipId : null;
  const timeline = useBandTimeline({ chapters, board: effectiveBoard, clipsById: feed.clipsById, selectedClipId, selectClip, preferences: { folded: preferences.folded, zoom: preferences.value.zoom, toggleFold: preferences.toggleFold } });
  // R22-B 连播:当前段 key(高亮 + 滚进视野);连播车道的钩子在 band 精修之后接回来(0.11.3 接线)。
  const playthroughKey = useBandPlaythrough(allChapters, feed.clipsById, viewportRef, timeline, setView);
  const { offsets, folded, trim, seekInSegment } = timeline;
  const navigation = useBandNavigation({ viewport: viewportRef, spans: timeline.spans, zoom: preferences.value.zoom, setZoom: preferences.zoom, previewZoom: preferences.previewZoom, commitZoom: preferences.commitZoom });

  // 视口宽 / 当前章 / 章级虚拟化窗口(band/useBandViewport)。
  const contentWidth = useMemo(() => timeline.spans.reduce((right, span) => Math.max(right, span.left + span.width), 0), [timeline.spans]);
  const { viewportWidth, rendered } = useBandViewport({ viewportRef, chapters, offsets, contentWidth, scrollLeft, selectedIndex, draggingKey });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const { setOverKey } = drag;
  const onDragOver = useCallback(
    (event: DragOverEvent) => setOverKey(event.over ? String(event.over.id) : null),
    [setOverKey],
  );
  // R22-C:落点 / 批量 / 忽略缺口等动作在 band/useBandCommands(⌥ 关磁吸的碰撞检测与吸附 modifier 也在那里)。
  const commands = useBandCommands({ drag, effectiveBoard, segments, chapters, multi, indexOf, readOnly, clipsById: feed.clipsById, setDraggingKey });
  const { collision, magnet, onDragStart, onDragEnd, onDismissGap, removeSelected, moveSelected, rateSelected } = commands;

  // Take 条的状态层在下面才装配(它需要 selectSegment),这里先留一个 ref 给 selectSegment 用。
  const takesRef = useRef<BandTakesState | null>(null);
  const selectSegment = useCallback(
    (segment: BandSegment, ratio?: number, event?: MouseEvent<HTMLElement>) => {
      // R22-C:多选层先吃点击(⇧ / ⌘ / 框选后的合成 click 会被它吞掉);单选照旧落到共享 selection。
      if (!multi.select(segment, event)) return;
      if (segment.kind === "slot" && segment.chapterId !== null && segment.slot !== null) {
        selectSlot(segment.chapterId, segment.slot);
      } else if (segment.clipId !== null) {
        if (segment.mediaKind === "photo") selectClip(segment.clipId);
        // R13 §4:点在镜块几分之几处就定位到本段的那一刻(整条素材 = 素材的那一刻)。
        seekInSegment(segment, ratio ?? 0);
      }
      takesRef.current?.resetTakes();
      // 单键评级只认「事件目标就是容器本身」(useRatingHotkeys 的既有语义) ——
      // 点完分段把焦点交回带本身,否则点一下之后 F/X/1–5 就全哑了。
      viewportRef.current?.focus();
    },
    [selectClip, selectSlot, seekInSegment, multi],
  );
  const takes = useBandTakes({ selection, selectedClip, selectedStack, clipsById: feed.clipsById, segments, selectedIndex, selectSegment });
  takesRef.current = takes;

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
  // dnd-kit 的 SortableContext 按 items 数组**引用**判「有没有变」:每次渲染都新建数组会让它在每一次指针
  // 移动时给所有 sortable 重算一遍(300 段夹具上是掉帧的主因之一);同理 draggingKeys 的 Set 只在拖动键 / 多选变时重建。
  const segmentKeys = useMemo(() => segments.map((segment) => segment.key), [segments]);
  const chapterKeys = useMemo(() => chapters.map((chapter) => chapterDragKey(chapter.chapterId)), [chapters]);
  const selectedKeys = multi.keys;
  const draggingKeys = useMemo(
    () => (draggingKey ? new Set(selectedKeys.includes(draggingKey) ? selectedKeys : [draggingKey]) : undefined),
    [draggingKey, selectedKeys],
  );
  // 拖动 / ⌥滚轮缩放期间只渲染视口 ±1 屏内的段(其余合成占位,章宽 / 刻度不变);见 band/dragWindow.ts。
  const renderKeys = useMemo(
    () => dragRenderKeys(timeline.spans, draggingKey !== null || navigation.zooming, draggingKeys, viewportWidth, scrollLeft ?? 0),
    [timeline.spans, draggingKey, navigation.zooming, draggingKeys, viewportWidth, scrollLeft],
  );
  const activeSegment = selectedIndex >= 0 ? segments[selectedIndex] : undefined;
  const clipTotal = chapters.reduce((sum, chapter) => sum + chapter.clipCount, 0);
  const gapTotal = chapters.reduce((sum, chapter) => sum + chapter.gapCount, 0);
  return (
    // 栏 landmark(规格 §7):`镜头带` 这个 AX 名是冒烟脚本的锚点,壳里不再包一层。
    <div className="shot-band workspace-pane" aria-label="镜头带" role="region" data-pane="band" data-zoom={preferences.value.zoom} data-panning={navigation.panning} tabIndex={-1}>
      <PaneHead title="镜头带" meta={chapters.length > 0 ? `${chapters.length} 章 · ${bandCountLabel(clipTotal, gapTotal)}` : "空"}>
        {/* R18 V-15:工具条分三组(视图 / 动作 / 附属视图),组间一条竖分隔线 + --space-3。
            R22-C 只在既有按钮**之后**追加缩放 / 「···」/ 已选工具,不重排(连播车道要在这里加「连播」)。 */}
        <BandViewToggle value={view} onChange={setView} />
        <div className="band-toolbar-actions">
          <PlaythroughButton />
          <BandAutoSelect disabled={readOnly} onOutcome={onAutoSelected} onError={(text) => showToast(text, { tone: "danger" })} />
          {/* R12 §2:镜头带唯一的主动作 —— 把挑好的片段按章排进带上。带还是空的时候这个入口
              由空态引导(BandEmptyGuide,第 ③ 步文案)承担,工具条不重复出第二个同名按钮。
              R19 V-01:降为 secondary —— 一屏只留顶栏「下一步」一颗实心主按钮。
              R22-C 第 9 项:带上已有镜头时视觉文案「补充排入」,AX 名仍是冻结的「一键排入」。 */}
          {clipTotal > 0 ? (
            <Button variant="secondary" size="sm" className="band-arrange" aria-label="一键排入" busy={drag.busy} disabled={readOnly} onClick={drag.arrange}>
              补充排入
            </Button>
          ) : null}
        </div>
        <BandTabs />
        <BandViewTools preferences={preferences} gaps={feed.gaps} disabled={readOnly} zoomAt={navigation.zoomAt} />
        <BandSelectionTools count={multi.keys.length} chapters={allChapters} disabled={readOnly || drag.busy} move={moveSelected} remove={removeSelected} rate={rateSelected} />
      </PaneHead>
      {/* R13 §4:刻度 + 视口 + 播放头同在一个 stage 里;音乐模式的刻度轨仍在带上方,与镜头带共用同一条时间轴(规格 §3.4)。 */}
      <BandDetailsProvider enabled={preferences.value.badges} clips={feed.clipsById} segments={segments} episodeId={feed.episode.scopeId}>
      <BandTimelineStage
        timeline={timeline}
        scrollLeft={scrollLeft ?? 0}
        ruler={bandMode === "music" ? <MusicRuler segmentCount={musicPitchCount(segments)} scrollLeft={scrollLeft ?? 0} /> : chapters.length > 0 ? "time" : null}
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
        aria-multiselectable="true"
        data-segment-count={clipTotal}
        aria-activedescendant={
          activeSegment
            ? activeSegment.kind === "slot"
              ? `band-slot-${activeSegment.chapterId}-${activeSegment.slot}`
              : activeSegment.segmentId !== null ? `band-segment-${activeSegment.segmentId}` : `band-clip-${activeSegment.clipId}`
            : undefined
        }
        // 视口高钉在内容高上(规格 §3.7):中栏再高,瓦片下方也不留白。
        style={{ "--band-content-height": `${BAND_VIEWPORT_HEIGHT}px` } as CSSProperties}
        onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
        {...multi.handlers}
        onPointerDownCapture={navigation.onPointerDownCapture}
        onPointerMove={event => { if (!navigation.move(event)) multi.handlers.onPointerMove(event); }}
        onPointerUp={() => { navigation.finish(); multi.handlers.onPointerUp(); }}
        onKeyUp={navigation.onKeyUp}
        onKeyDown={bandKeyDown({ navigate: navigation.keyDown, all: multi.all, count: multi.keys.length, readOnly, timeline, active: activeSegment, remove: removeSelected, rate: rateSelected, fallback: takes.hotkeys.onKeyDown })}
        onCompositionStart={takes.hotkeys.onCompositionStart}
        onCompositionEnd={takes.hotkeys.onCompositionEnd}
        onFocus={() => {
          takes.hotkeys.onFocus();
          dispatchWorkspace({ type: "focus-pane", pane: "band" });
        }}
      >
        <DndContext collisionDetection={collision} modifiers={[magnet]} autoScroll={{ enabled: true, threshold: { x: 0.12, y: 0 }, acceleration: 12, interval: 16, canScroll: node => node === viewportRef.current }} onDragCancel={() => { setDraggingKey(null); setOverKey(null); }} sensors={sensors} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
          <SortableContext items={chapterKeys} strategy={horizontalListSortingStrategy}>
            {chapters.map((chapter, index) => (
              <BandChapterFrame key={chapter.chapterId ?? `unchaptered-${index}`} id={chapter.chapterId} disabled={readOnly || drag.busy || view !== "chapter"}>
              <SortableContext items={segmentKeys} strategy={horizontalListSortingStrategy}>
              <BandChapterSection
                chapter={chapter}
                zoom={preferences.value.zoom}
                folded={!rendered.has(index)}
                selectedKey={activeSegment?.key}
                playingKey={playthroughKey}
                selectedKeys={multi.selected}
                draggingKey={draggingKey}
                draggingKeys={draggingKeys}
                renderKeys={renderKeys}
                overKey={drag.overKey}
                indexOf={indexOf}
                // 按时间的顺序是拍摄时间定的,不许拖排。
                dragBusy={drag.busy || readOnly || view === "time"}
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
              </SortableContext>
              </BandChapterFrame>
            ))}
          </SortableContext>
          <DragOverlay>{draggingSegment ? <div className="band-group-ghost"><DragGhost segment={draggingSegment} />{multi.dragKeys(draggingSegment.key).length > 1 ? <span className="band-drag-count">{multi.dragKeys(draggingSegment.key).length} 段</span> : null}</div> : null}</DragOverlay>
        </DndContext>
        <BandSegmentActions board={effectiveBoard} drag={drag} />
        {multi.box ? <div className="band-selection-box" aria-hidden="true" style={{ left: Math.min(multi.box.a.x, multi.box.b.x), top: Math.min(multi.box.a.y, multi.box.b.y), width: Math.abs(multi.box.a.x - multi.box.b.x), height: Math.abs(multi.box.a.y - multi.box.b.y) }} /> : null}
      </div>
      </BandTimelineStage>
      </BandDetailsProvider>
      {/* 空态放在 grid 外面(WebKit 会把 role=grid 的非 row 子节点从 AX 树剔掉,按钮在里面按名字找不到);
          R11 简化专项 #5:一句话 + 一个按钮;R22-C 第 9 项换成「按 F 收藏几条,再点一键排入」+ secondary 按钮。 */}
      {clipTotal === 0 ? (
        feed.loading ? (
          <p className="band-empty">正在整理镜头</p>
        ) : view === "gaps" ? (
          <BandEmpty variant="no-gaps" onAction={() => setView("chapter")} />
        ) : (
          <BandEmptyGuide disabled={readOnly} busy={drag.busy} arrange={drag.arrange} />
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
