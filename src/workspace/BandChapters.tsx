import type { JSX, MouseEvent } from "react";

import { cancelGeneration, retryGeneration, type StoryGap } from "../api";
import { GapSlotBody, SegmentCard, bandDurationLabel, gapPrimaryAction } from "./BandSegment";
import { TrimHandles } from "./BandTrimHandles";
import { refreshClipsFeed } from "./useClipsFeed";
import { chapterWidth } from "./bandGeometry";
import { bandCountLabel, type BandChapter, type BandSegment } from "./shotBandModel";
import type { BandTrimApi } from "./useBandTrim";
import { Badge, Button, Icon } from "./ui";

/** R13 §4:点在镜块的横向几分之几处(0..1);没有几何(键盘 / jsdom)时 undefined = 只选中不定位。 */
export function clickRatio(event: MouseEvent<HTMLElement> | undefined): number | undefined {
  if (!event) return undefined;
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width <= 0) return undefined;
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
}

/** 轨头折叠按钮的 AX 名(R13 §4):「折叠第 n 章」/「展开第 n 章」。 */
export function foldButtonLabel(ordinal: number, folded: boolean): string {
  return `${folded ? "展开" : "折叠"}第 ${ordinal} 章`;
}

/** 拖动落点在哪一格的哪一侧:源在落点之前 → 线画在落点之后;反之画在之前。 */
export function overSideFor(
  segment: BandSegment,
  draggingKey: string | null,
  overKey: string | null,
  indexOf: (key: string) => number,
): "before" | "after" | null {
  if (draggingKey === null || overKey === null || segment.key !== overKey || overKey === draggingKey) return null;
  return indexOf(draggingKey) < indexOf(overKey) ? "after" : "before";
}

/**
 * 镜头带里"一章"的渲染(规格 §3.7,基准稿 A):章节头是一条 `Toolbar dense` ——
 * 序号 Badge(强调 tint)· 标题 · 时长 · n 镜 · 「n 处缺口」warn Badge(没缺口就不出);
 * 下面一排瓦片。视口外的章节仍然只画带头 + 一行"n 个镜头",空槽位的四个回调仍然是
 * "发一条命令再整体重取一次 feed"。
 */
export function BandChapterSection({
  chapter,
  folded,
  selectedKey,
  draggingKey,
  overKey,
  indexOf,
  dragBusy,
  readOnly,
  disabledHint,
  onSelect,
  onStep,
  onGenerate,
  onDismiss,
  onPickFromPool,
  onBackToSelect,
  onSkipChapter,
  hasCandidates = true,
  collapsed = false,
  onToggleFold,
  trim,
}: {
  chapter: BandChapter;
  /** 视口外的虚拟化折叠:只画带头 + 一行「n 个镜头」。 */
  folded: boolean;
  selectedKey: string | undefined;
  draggingKey: string | null;
  overKey: string | null;
  indexOf: (key: string) => number;
  dragBusy: boolean;
  readOnly: boolean;
  disabledHint: string | null;
  /** 点选;R13 §4 第二个参数是点在块内的横向比例(0..1),镜头带按它 seek。 */
  onSelect: (segment: BandSegment, ratio?: number) => void;
  onStep: (segment: BandSegment, direction: -1 | 1) => void;
  onGenerate: (gap: StoryGap) => void;
  /** 「忽略」缺口:由 ShotBand 发命令并给一条 5 秒可撤销的提示(R10 U-17)。 */
  onDismiss: (gap: StoryGap) => void;
  /** 「从挑好的片段里选」:在这一章上打开小选择列表(R10 U-17 / U-18;R12 改名)。 */
  onPickFromPool: (chapter: BandChapter) => void;
  /** R12 §2:没有挑好的片段时缺口卡的主动作「回到第 2 步挑几条」。 */
  onBackToSelect?: () => void;
  /** R12 §2「这章够了」:把 0 镜章标成跳过 / 取消。 */
  onSkipChapter?: (chapter: BandChapter, skipped: boolean) => void;
  /** 有没有挑好的片段可选(缺口卡与空章卡按它选主动作)。 */
  hasCandidates?: boolean;
  /** R13 §4:用户手动折叠的章(轨头 aria-expanded=false):只占一个节距,镜块收起。 */
  collapsed?: boolean;
  onToggleFold?: (chapter: BandChapter) => void;
  /** R13 §4:精选段镜块的拖边裁剪;不传 = 没有把手。 */
  trim?: BandTrimApi;
}): JSX.Element {
  // 往前 / 往后的边界:章首禁「往前」、章尾禁「往后」(空槽位不参与)。
  const clipKeys = chapter.segments.filter((segment) => segment.kind === "clip").map((segment) => segment.key);
  return (
    <section
      className={chapter.skipped ? "band-chapter skipped" : "band-chapter"}
      role="rowgroup"
      aria-label={`第 ${chapter.ordinal} 章 ${chapter.title}`}
      // 视口外的章节只画带头,但**必须占住自己的实宽**:章节偏移(chapterOffsets)与
      // 音乐刻度轨都按「每段一个节距」算,折叠章一缩,滚到底也到不了第 2 章的偏移,
      // 后面的章节就永远展不开(R8 设计轮实测:滚到底仍是「12 个镜头」三条折叠卡)。
      // 空章也占一个节距(chapterWidth ≥ 160):0 宽会让两条带头叠在一起(R9 D2)。
      style={{ width: chapterWidth(chapter, collapsed) }}
    >
      {/*
        Y-12(0.7.0 真机):章头曾是 rowgroup 的裸子节点(Toolbar 生成的 div),WebKit 会把 grid
        里非 row 的子树整个从 AX 树剔掉 —— 「折叠第 n 章」VoiceOver 与自动化都摸不到。
        按 grid 的内容模型包一层 row > rowheader(章头就是这一行的行头;不用 gridcell,
        免得「所有 gridcell」的读法把章头也数进镜块);rowheader 本身就是那条 dense toolbar
        (Toolbar 组件不接 role,这里直接用它的 class)。
      */}
      <div className="band-chapter-headrow" role="row">
      <div className="ui-toolbar ui-toolbar--dense band-chapter-head" role="rowheader">
        {onToggleFold ? (
          <button
            type="button"
            className="band-chapter-fold"
            aria-label={foldButtonLabel(chapter.ordinal, collapsed)}
            aria-expanded={!collapsed}
            title={collapsed ? "展开这一章的镜头" : "把这一章的镜头收起来"}
            onClick={() => onToggleFold(chapter)}
          >
            <span className="band-chapter-fold-icon" aria-hidden="true" />
          </button>
        ) : null}
        <Badge tone="accent" className="band-chapter-ordinal">
          {String(chapter.ordinal).padStart(2, "0")}
        </Badge>
        <strong className="band-chapter-title" title={chapter.title}>
          {chapter.title}
        </strong>
        {/* 0:00 的时长不占带头的位置(空章的带头只有一格宽,R10 U-29)。 */}
        {chapter.durationMs > 0 ? <span className="band-chapter-meta">{bandDurationLabel(chapter.durationMs)}</span> : null}
        <span className="band-chapter-meta">{bandCountLabel(chapter.clipCount, chapter.gapCount)}</span>
        {chapter.gapCount > 0 ? (
          <Badge tone="warn" icon="warning" className="band-chapter-gaps">
            {chapter.isEmpty ? "空章" : `${chapter.gapCount} 处缺口`}
          </Badge>
        ) : chapter.isEmpty && chapter.skipped ? (
          <Badge tone="neutral" icon="check" className="band-chapter-gaps">
            这章够了
          </Badge>
        ) : null}
      </div>
      </div>
      {chapter.segments.length === 0 ? (
        <EmptyChapterTile
          readOnly={readOnly}
          skipped={chapter.skipped}
          hasCandidates={hasCandidates}
          onPickFromPool={() => onPickFromPool(chapter)}
          onBackToSelect={onBackToSelect}
          onSkip={onSkipChapter && chapter.chapterId !== null ? (skipped) => onSkipChapter(chapter, skipped) : undefined}
        />
      ) : collapsed ? (
        <div className="band-chapter-segments" role="row">
          <div role="gridcell" aria-label={`第 ${chapter.ordinal} 章已收起`}>
            <button type="button" className="band-chapter-folded band-chapter-collapsed" onClick={() => onToggleFold?.(chapter)}>
              {bandCountLabel(chapter.clipCount, chapter.gapCount)} · 已收起
            </button>
          </div>
        </div>
      ) : folded ? (
        <p className="band-chapter-folded">{chapter.segments.length} 个镜头</p>
      ) : (
        <div className="band-chapter-segments" role="row">
          {chapter.segments.map((segment) => (
            <SegmentCard
              key={segment.key}
              segment={segment}
              dragDisabled={dragBusy || segment.kind === "slot"}
              selected={selectedKey === segment.key}
              dragging={draggingKey === segment.key}
              overSide={overSideFor(segment, draggingKey, overKey, indexOf)}
              onSelect={(event) => onSelect(segment, clickRatio(event))}
              onStep={(direction) => onStep(segment, direction)}
              canStepBack={clipKeys.indexOf(segment.key) > 0}
              canStepForward={clipKeys.indexOf(segment.key) < clipKeys.length - 1}
              extra={trim && segment.kind === "clip" && segment.segmentId !== null ? <TrimHandles segment={segment} trim={trim} disabled={readOnly} /> : null}
            >
              {segment.kind === "slot" && segment.gap ? (
                <GapSlotBody
                  gap={segment.gap}
                  slotIndex={segment.slotIndex}
                  readOnly={readOnly}
                  disabledHint={disabledHint}
                  hasCandidates={hasCandidates}
                  onGenerate={onGenerate}
                  onDismiss={() => onDismiss(segment.gap!)}
                  onPickFromPool={() => onPickFromPool(chapter)}
                  onBackToSelect={onBackToSelect}
                  onRetry={(requestId) => {
                    void retryGeneration(requestId).then(() => refreshClipsFeed(true));
                  }}
                  onCancel={(requestId) => {
                    void cancelGeneration(requestId).then(() => refreshClipsFeed(true));
                  }}
                />
              ) : null}
            </SegmentCard>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * 空章的占位瓦片:与真实瓦片同尺寸(160×130)的虚线框。不折叠、不随视口
 * 虚拟化变形 —— 它就是这一章在横轴上的那一格(R9 D2)。
 *
 * R12 §2:一个主动作(有挑好的片段 →「从挑好的片段里选」;没有 →「回到第 2 步挑几条」)
 * + 一个 ghost「这章够了」(标成跳过,不再算缺口;再点一次取消)。云端补镜不在这里出现——
 * 空章没有可生成的槽位,给一个永远禁用的按钮只会让新手不知道点哪个(R11 真机走查)。
 */
function EmptyChapterTile({
  readOnly,
  skipped,
  hasCandidates,
  onPickFromPool,
  onBackToSelect,
  onSkip,
}: {
  readOnly: boolean;
  skipped: boolean;
  hasCandidates: boolean;
  onPickFromPool: () => void;
  onBackToSelect?: () => void;
  onSkip?: (skipped: boolean) => void;
}): JSX.Element {
  const primary = gapPrimaryAction(hasCandidates);
  const runPrimary = primary.kind === "pick" ? onPickFromPool : onBackToSelect;
  return (
    <div className="band-chapter-segments" role="row">
      <div className="band-chapter-empty" role="gridcell" aria-label={skipped ? "这章够了" : "本章还没有镜头"}>
        <Icon name={skipped ? "check" : "film"} size={20} className="band-chapter-empty-icon" />
        <span className="band-chapter-empty-title">{skipped ? "这章够了" : "本章还没有镜头"}</span>
        <span className="band-chapter-empty-actions">
          {skipped ? (
            <Button size="sm" variant="ghost" disabled={readOnly || !onSkip} onClick={() => onSkip?.(false)}>
              还是要镜头
            </Button>
          ) : (
            <>
              <Button size="sm" icon="plus" disabled={readOnly || !runPrimary} onClick={() => runPrimary?.()}>
                {primary.label}
              </Button>
              {onSkip ? (
                <Button size="sm" variant="ghost" className="band-chapter-enough" disabled={readOnly} onClick={() => onSkip(true)}>
                  这章够了
                </Button>
              ) : null}
            </>
          )}
        </span>
      </div>
    </div>
  );
}
