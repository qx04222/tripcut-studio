import { type JSX } from "react";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { GenerationAvailability, StoryGap } from "../api";
import { GENERATION_STATUS_LABELS } from "../Storyboard";
import { segmentAriaLabel, slotLabelZh, type BandSegment } from "./shotBandModel";
import { Badge, Button, Card, CoverImage, Icon } from "./ui";

export { orderedTakes } from "./shotBandModel";

/**
 * 镜头带里的可视单元:分段瓦片、空槽位瓦片、拖动 ghost(规格 §3.7,基准稿 A)。
 * 瓦片 = `Card interactive selected` 160×130:缩略图 + Take / AI 角标 + 时长角标 +
 * 文件名一行 + 左下「槽位 nn」右下角色词;拖柄是 `grip` 图标按钮,AX 名 `拖动 …` 不变。
 */

export function bandDurationLabel(ticks: number, tbNum = 1, tbDen = 1_000): string {
  if (tbDen <= 0 || tbNum <= 0) return "0:00";
  const total = Math.max(0, Math.floor((ticks * tbNum) / tbDen));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

/** 「槽位 01」—— A 稿瓦片左下那个按章重置的序号。 */
export function slotIndexLabel(slotIndex: number): string {
  return `槽位 ${String(slotIndex).padStart(2, "0")}`;
}

/**
 * 「生成候选」为什么按不了 —— 必须说出中文原因,不能是一个按了没反应的按钮
 * (规格 §3.3;R7 的 StoryGapCard 也是这套判定,文案在这里统一)。
 */
export function generationDisabledHint(
  availability: GenerationAvailability | null | undefined,
): string | null {
  // 命令报错/返回空都算「状态未知」——宽松判空,不让一个 undefined 把整栏打崩。
  if (availability === null || availability === undefined) return "云端补镜状态未知；稍后重试";
  if (!availability.enabled) return "云端补镜未启用；先在设置里启用";
  if (!availability.has_key) return "尚未配置 MiniMax API Key";
  if (availability.budget_remaining_usd <= 0) return "本月生成预算已用尽";
  return null;
}

/**
 * 空槽位卡片。**请求状态与只读态都必须分叉** —— 镜像 R7 的 `StoryGapCard`
 * (`src/Storyboard.tsx`):在飞的请求给「取消」、失败给「重新生成」+ 错误原文、
 * 已入库什么都不给,只读历史集里一律禁用并说明原因。少一条分叉,界面就会在
 * 一个已经排队的缺口上再给一次「生成候选」——那是重复付费。
 */
export function GapSlotBody({
  gap,
  slotIndex,
  readOnly,
  disabledHint,
  onGenerate,
  onDismiss,
  onRetry,
  onCancel,
}: {
  gap: StoryGap;
  slotIndex: number;
  readOnly: boolean;
  disabledHint: string | null;
  onGenerate: (gap: StoryGap) => void;
  onDismiss: (gapId: number) => void;
  onRetry: (requestId: number, gapId: number) => void;
  onCancel: (requestId: number) => void;
}): JSX.Element {
  const request = gap.latest_request;
  const status = request?.status ?? null;
  const inFlight = status === "submitted" || status === "queued" || status === "succeeded";
  // 卡片本身可点(=选中这个槽位);按钮上的点击一律不能冒泡上去顺手换掉选择。
  const stop = (run: () => void) => (event: { stopPropagation(): void }) => {
    event.stopPropagation();
    run();
  };
  const hint = !readOnly && disabledHint !== null && status === null ? disabledHint : null;

  return (
    <span className="band-slot">
      <span className="band-slot-title">
        <Icon name="warning" size={12} />
        <span className="band-slot-kicker">缺口 ·</span>
        <strong>{slotLabelZh(gap)}</strong>
      </span>
      <small className="band-slot-reason" title={gap.reason}>
        {gap.reason}
      </small>
      {status ? (
        <small className={`band-slot-status band-slot-status-${status}`}>
          {GENERATION_STATUS_LABELS[status]}
          {status === "failed" && request?.error ? `：${request.error}` : ""}
        </small>
      ) : hint === null && !readOnly ? (
        // 130px 里放不下四行:有状态字 / 原因 / 只读说明时,槽位序号让位给它们。
        <small className="band-slot-index">{slotIndexLabel(slotIndex)}</small>
      ) : null}
      <span className="band-slot-buttons">
        {status === "imported" ? null : status === "failed" ? (
          <Button size="sm" disabled={readOnly} onClick={stop(() => request && onRetry(request.id, gap.id))}>
            重新生成
          </Button>
        ) : inFlight ? (
          <Button size="sm" disabled={readOnly} onClick={stop(() => request && onCancel(request.id))}>
            取消
          </Button>
        ) : (
          <Button
            size="sm"
            icon="settings-generation"
            disabled={readOnly || disabledHint !== null}
            title={disabledHint ?? undefined}
            onClick={stop(() => onGenerate(gap))}
          >
            生成候选
          </Button>
        )}
        {status === null || status === "failed" ? (
          <Button variant="ghost" size="sm" disabled={readOnly} onClick={stop(() => onDismiss(gap.id))}>
            忽略
          </Button>
        ) : null}
      </span>
      {readOnly ? <small className="read-only-notice">历史集为只读档案</small> : null}
      {hint !== null ? <small className="band-slot-hint">{hint}</small> : null}
    </span>
  );
}

export function SegmentCard({
  segment,
  selected,
  dragging,
  overSide,
  dragDisabled,
  onSelect,
  onStep,
  children,
}: {
  segment: BandSegment;
  selected: boolean;
  /** 拖动源:压暗留在原位,ghost 在 DragOverlay 里跟着指针走。 */
  dragging: boolean;
  /** 拖动落点:在这一格的前 / 后画 2px 强调插入线。 */
  overSide: "before" | "after" | null;
  dragDisabled: boolean;
  onSelect: () => void;
  onStep: (direction: -1 | 1) => void;
  children?: JSX.Element | null;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: segment.key,
    disabled: dragDisabled,
  });
  const label = segmentAriaLabel(segment);
  // 回显 id 由 useSelection.echoElementId 统一生成 —— 媒体池按同一套规则找它。
  const domId =
    segment.kind === "slot"
      ? `band-slot-${segment.chapterId}-${segment.slot}`
      : `band-clip-${segment.clipId}`;
  const classes = [
    "band-segment",
    segment.kind === "slot" ? "slot" : "",
    dragging || isDragging ? "dragging" : "",
    overSide ? `band-segment--over-${overSide}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    // 格子是 tabIndex={-1},永远拿不到焦点;整带的键盘入口只有 band-viewport 一个
    // 容器(roving 由 aria-activedescendant 指路),所以格子上不挂 onKeyDown。
    <Card
      as="div"
      interactive
      selected={selected}
      ref={setNodeRef}
      id={domId}
      role="gridcell"
      tabIndex={-1}
      aria-label={label}
      aria-selected={selected}
      data-band-key={segment.key}
      className={classes}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={onSelect}
    >
      {children ?? (
        <>
          <span className="band-tile-thumb" aria-hidden="true">
            <CoverImage src={segment.coverUrl} lazy />
            <span className="band-tile-badges">
              {segment.takeCount > 1 ? (
                <Badge tone="ink" className="band-tile-take">{`Take ${segment.takeIndex}/${segment.takeCount}`}</Badge>
              ) : null}
              {segment.isGenerated ? (
                <Badge tone="accent" className="band-tile-ai">
                  AI 生成
                </Badge>
              ) : null}
            </span>
            <Badge tone="ink" className="band-tile-time">
              {bandDurationLabel(segment.durationTicks)}
            </Badge>
          </span>
          <span className="band-tile-name" title={segment.fileName ?? ""}>
            {segment.fileName}
          </span>
          <span className="band-tile-meta">
            <span className="band-tile-slot">{slotIndexLabel(segment.slotIndex)}</span>
            {segment.roleLabel ? <span className="band-tile-role">{segment.roleLabel}</span> : null}
          </span>
        </>
      )}
      {segment.kind === "clip" ? (
        <Button
          variant="icon"
          size="sm"
          icon="grip"
          className="band-segment-grip"
          aria-label={`拖动 ${label}`}
          disabled={dragDisabled}
          {...attributes}
          {...listeners}
          onKeyDown={(event) => {
            // ←→ 在抓手上是「前移/后移一格」—— 不用指针也能重排(dnd-kit 的键盘
            // 传感器依赖矩形测量,在无布局的环境里量不出来,这条路才是可靠的)。
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            event.stopPropagation();
            onStep(event.key === "ArrowLeft" ? -1 : 1);
          }}
        />
      ) : null}
    </Card>
  );
}

/** DragOverlay 里跟着指针走的瓦片 ghost:同尺寸缩略图 + 文件名,半透明、raised 阴影、2° 倾斜(样式在 CSS)。 */
export function DragGhost({ segment }: { segment: BandSegment }): JSX.Element {
  return (
    <div className="band-drag-ghost" aria-hidden="true">
      <span className="band-tile-thumb">
        <CoverImage src={segment.coverUrl} />
      </span>
      <span className="band-tile-name">{segment.fileName ?? "镜头"}</span>
    </div>
  );
}
