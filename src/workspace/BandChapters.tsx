import type { JSX, ReactNode } from "react";

import { cancelGeneration, retryGeneration, type StoryGap } from "../api";
import { GapSlotBody, SegmentCard, bandDurationLabel, openGenerationSettings, shortDisabledHint } from "./BandSegment";
import { refreshClipsFeed } from "./useClipsFeed";
import { chapterWidth } from "./bandGeometry";
import { bandCountLabel, type BandChapter, type BandSegment } from "./shotBandModel";
import { Badge, Button, Icon, Toolbar } from "./ui";

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
}: {
  chapter: BandChapter;
  folded: boolean;
  selectedKey: string | undefined;
  draggingKey: string | null;
  overKey: string | null;
  indexOf: (key: string) => number;
  dragBusy: boolean;
  readOnly: boolean;
  disabledHint: string | null;
  onSelect: (segment: BandSegment) => void;
  onStep: (segment: BandSegment, direction: -1 | 1) => void;
  onGenerate: (gap: StoryGap) => void;
  /** 「忽略」缺口:由 ShotBand 发命令并给一条 5 秒可撤销的提示(R10 U-17)。 */
  onDismiss: (gap: StoryGap) => void;
  /** 「从媒体池选择…」:在这一章上打开小选择列表(R10 U-17 / U-18)。 */
  onPickFromPool: (chapter: BandChapter) => void;
}): JSX.Element {
  return (
    <section
      className="band-chapter"
      role="rowgroup"
      aria-label={`第 ${chapter.ordinal} 章 ${chapter.title}`}
      // 视口外的章节只画带头,但**必须占住自己的实宽**:章节偏移(chapterOffsets)与
      // 音乐刻度轨都按「每段一个节距」算,折叠章一缩,滚到底也到不了第 2 章的偏移,
      // 后面的章节就永远展不开(R8 设计轮实测:滚到底仍是「12 个镜头」三条折叠卡)。
      // 空章也占一个节距(chapterWidth ≥ 160):0 宽会让两条带头叠在一起(R9 D2)。
      style={{ width: chapterWidth(chapter) }}
    >
      <Toolbar dense className="band-chapter-head">
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
        ) : null}
      </Toolbar>
      {chapter.segments.length === 0 ? (
        <EmptyChapterTile readOnly={readOnly} disabledHint={disabledHint} onPickFromPool={() => onPickFromPool(chapter)} />
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
              onSelect={() => onSelect(segment)}
              onStep={(direction) => onStep(segment, direction)}
            >
              {segment.kind === "slot" && segment.gap ? (
                <GapSlotBody
                  gap={segment.gap}
                  slotIndex={segment.slotIndex}
                  readOnly={readOnly}
                  disabledHint={disabledHint}
                  onGenerate={onGenerate}
                  onDismiss={() => onDismiss(segment.gap!)}
                  onPickFromPool={() => onPickFromPool(chapter)}
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
 * R10 U-17:占位上有可点的入口 ——「从媒体池选择…」打开小选择列表;「生成候选」
 * 在这里永远是禁用的(生成要有一个缺口槽位,空章没有;云端补镜没启用时原因带
 * 「去设置」链接),不再是一句「从媒体池拖入或生成候选」却什么都点不了。
 */
function EmptyChapterTile({
  readOnly,
  disabledHint,
  onPickFromPool,
}: {
  readOnly: boolean;
  disabledHint: string | null;
  onPickFromPool: () => void;
}): JSX.Element {
  const hint = disabledHint ?? "先在「模板」里编排出缺口槽位";
  return (
    <div className="band-chapter-segments" role="row">
      <div className="band-chapter-empty" role="gridcell" aria-label="本章还没有镜头">
        <Icon name="film" size={20} className="band-chapter-empty-icon" />
        <span className="band-chapter-empty-title">本章还没有镜头</span>
        <span className="band-chapter-empty-actions">
          <Button size="sm" icon="plus" disabled={readOnly} onClick={onPickFromPool}>
            从媒体池选择…
          </Button>
          <Button size="sm" icon="settings-generation" disabled title={hint}>
            生成候选
          </Button>
        </span>
        <small className="band-chapter-empty-hint" title={hint}>
          {shortDisabledHint(hint)}
          {disabledHint !== null && !readOnly ? <GoToSettingsLink /> : null}
        </small>
      </div>
    </div>
  );
}

/** 「去设置」——打开设置 sheet 的云端补镜分区(R10 U-17;分区跳转靠 `tripcut:open-settings-section` 事件)。 */
export function GoToSettingsLink(): JSX.Element {
  return (
    <>
      {" "}
      <button type="button" className="band-link" onClick={openGenerationSettings}>
        去设置
      </button>
    </>
  );
}

/** 拖排后的提示条。文案本身就是关闭键 —— 点提示即消失,不用等那 4 秒。 */
export function BandToast({
  notice,
  undoable,
  onDismiss,
  onUndo,
}: {
  notice: string;
  undoable: boolean;
  onDismiss: () => void;
  onUndo: () => void;
}): JSX.Element {
  return (
    <p className="band-toast" role="status">
      <button type="button" className="band-toast-text" onClick={onDismiss}>
        {notice}
      </button>
      {undoable ? <BandToastUndo onUndo={onUndo} /> : null}
    </p>
  );
}

function BandToastUndo({ onUndo }: { onUndo: () => void }): ReactNode {
  return (
    <>
      <span aria-hidden="true"> · </span>
      <button type="button" onClick={onUndo}>
        撤销
      </button>
    </>
  );
}
