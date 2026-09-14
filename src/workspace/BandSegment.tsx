import { useState, type JSX, type MouseEvent } from "react";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { GenerationAvailability, StoryGap } from "../api";
import { GENERATION_STATUS_LABELS } from "../Storyboard";
import { segmentAriaLabel, slotLabelZh, type BandSegment } from "./shotBandModel";
import { GapMoreMenu } from "./BandGapMenu";
import { Badge, Button, Card, CoverImage, Icon, type MenuItem } from "./ui";
import { openSettings } from "./openSettings";

export { orderedTakes } from "./shotBandModel";

/**
 * 镜头带里的可视单元:分段瓦片、空槽位瓦片、拖动 ghost(规格 §3.7,基准稿 A)。
 * 瓦片 = `Card interactive selected` 160×130:缩略图 + Take / AI 角标 + 时长角标 +
 * 文件名一行 + 左下「槽位 nn」右下角色词;拖柄是 `grip` 图标按钮,AX 名 `拖动 …` 不变。
 */

/** 时长角标「m:ss」。默认 time base 是毫秒;素材段必须传自己的 tb(R-02:1/19200 的 ticks 当毫秒会把 1.2 s 显示成 0:23)。 */
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
  if (!availability.has_key) return "还没填云端补镜的密钥";
  if (availability.budget_remaining_usd <= 0) return "本月生成预算已用尽";
  return null;
}

/**
 * 打开设置 sheet 并请求跳到「云端补镜」分区(R10 U-17 的「去设置」链接)。设置 sheet 归
 * 车道 E;分区跳转通过一个自定义事件递过去,sheet 没接上事件时至少也打开了设置。
 */
export const OPEN_SETTINGS_SECTION_EVENT = "tripcut:open-settings-section";

/** 瓦片里只放得下一行:「云端补镜未启用；先在设置里启用」只留分号前半句,后半句由「去设置」链接代替。 */
export function shortDisabledHint(hint: string): string {
  return hint.split("；")[0] ?? hint;
}

export function openGenerationSettings(): void {
  // R10 接线:分区经 store 的 `settingsSection` 传给 sheet(车道 E 的 openSettings);事件保留给旧监听者。
  openSettings("generation");
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: { section: "generation" } }));
}

/** 缺口卡 / 空章卡的主动作(R12 §2):有挑好的片段 → 从里面选;没有 → 回到第 ② 步挑几条。 */
export function gapPrimaryAction(hasCandidates: boolean): { label: string; kind: "pick" | "back-to-select" } {
  return hasCandidates ? { label: "从挑好的片段里选", kind: "pick" } : { label: "回到第 2 步挑几条", kind: "back-to-select" };
}

/** 「···」菜单项(R12 §2:云端补镜降级到这里;未启用时禁用并把原因写在 AX 名里)。 */
export function gapMenuItems(disabledHint: string | null, includePick: boolean): MenuItem[] {
  const items: MenuItem[] = [];
  if (includePick) items.push({ id: "pick", label: "从挑好的片段里选" });
  items.push({
    id: "generate",
    label: "云端补镜生成候选",
    ariaLabel: "生成候选",
    disabled: disabledHint !== null,
  });
  if (disabledHint !== null) items.push({ id: "settings", label: `去设置（${shortDisabledHint(disabledHint)}）`, ariaLabel: "去设置" });
  items.push({ id: "dismiss", label: "忽略这个缺口", ariaLabel: "忽略" });
  return items;
}

/** 缺口卡的「···」搬到了 BandGapMenu.tsx(R13 给镜块腾出行数);导入路径不变。 */
export { GapMoreMenu };

/**
 * 空槽位卡片。**请求状态与只读态都必须分叉** —— 镜像 R7 的 `StoryGapCard`
 * (`src/Storyboard.tsx`):在飞的请求给「取消」、失败给「重新生成」+ 错误原文、
 * 已入库什么都不给,只读历史集里一律禁用并说明原因。少一条分叉,界面就会在
 * 一个已经排队的缺口上再给一次「生成候选」——那是重复付费。
 *
 * R12 §2:卡上只留**一个主动作**(从挑好的片段里选 / 回到第 2 步挑几条);云端补镜、
 * 忽略、去设置收进「···」。
 */
export function GapSlotBody({
  gap,
  slotIndex,
  readOnly,
  disabledHint,
  hasCandidates,
  onGenerate,
  onDismiss,
  onRetry,
  onCancel,
  onPickFromPool,
  onBackToSelect,
}: {
  gap: StoryGap;
  slotIndex: number;
  readOnly: boolean;
  disabledHint: string | null;
  /** 有没有挑好的片段可选(决定主动作是「从挑好的片段里选」还是「回到第 2 步挑几条」)。 */
  hasCandidates?: boolean;
  onGenerate: (gap: StoryGap) => void;
  onDismiss: (gapId: number) => void;
  onRetry: (requestId: number, gapId: number) => void;
  onCancel: (requestId: number) => void;
  /** 「从挑好的片段里选」:用真素材填这个槽位,不靠云端补镜。 */
  onPickFromPool?: () => void;
  /** 「回到第 2 步挑几条」:没有候选时的主动作。 */
  onBackToSelect?: () => void;
}): JSX.Element {
  // 缺口说明可展开(R10 U-30):默认一行省略,点一下展开成整段(再点收回)。
  const [reasonOpen, setReasonOpen] = useState(false);
  const request = gap.latest_request;
  const status = request?.status ?? null;
  const inFlight = status === "submitted" || status === "queued" || status === "succeeded";
  // 卡片本身可点(=选中这个槽位);按钮上的点击一律不能冒泡上去顺手换掉选择。
  const stop = (run: () => void) => (event: { stopPropagation(): void }) => {
    event.stopPropagation();
    run();
  };
  const primary = gapPrimaryAction(hasCandidates ?? Boolean(onPickFromPool));
  const runPrimary = primary.kind === "pick" ? onPickFromPool : onBackToSelect;
  const onMenu = (id: string) => {
    if (id === "pick") onPickFromPool?.();
    else if (id === "generate") onGenerate(gap);
    else if (id === "settings") openGenerationSettings();
    else if (id === "dismiss") onDismiss(gap.id);
  };

  return (
    <span className="band-slot">
      <span className="band-slot-title">
        <Icon name="warning" size={12} />
        <span className="band-slot-kicker">缺口 ·</span>
        <strong>{slotLabelZh(gap)}</strong>
      </span>
      <button
        type="button"
        className={reasonOpen ? "band-slot-reason is-open" : "band-slot-reason"}
        title={reasonOpen ? "收起说明" : gap.reason}
        aria-expanded={reasonOpen}
        onClick={stop(() => setReasonOpen((value) => !value))}
      >
        {/* R-08:截行打在 span 上 —— WebKit 的 <button> 不认 -webkit-box 的 line-clamp,原文会撑成四行把底行挤出卡片。 */}
        <span className="band-slot-reason-text">{gap.reason}</span>
      </button>
      {status ? (
        <small className={`band-slot-status band-slot-status-${status}`}>
          {GENERATION_STATUS_LABELS[status]}
          {status === "failed" && request?.error ? `：${request.error}` : ""}
        </small>
      ) : !readOnly ? (
        <small className="band-slot-index">{slotIndexLabel(slotIndex)}</small>
      ) : null}
      {status === "imported" ? null : inFlight ? (
        <span className="band-slot-buttons">
          <Button size="sm" disabled={readOnly} onClick={stop(() => request && onCancel(request.id))}>
            取消
          </Button>
        </span>
      ) : status === "failed" ? (
        <span className="band-slot-more">
          <Button size="sm" className="band-slot-primary" disabled={readOnly} onClick={stop(() => request && onRetry(request.id, gap.id))}>
            重新生成
          </Button>
          <GapMoreMenu items={gapMenuItems(disabledHint, Boolean(onPickFromPool)).filter((item) => item.id !== "generate")} disabled={readOnly} onSelect={onMenu} />
        </span>
      ) : (
        <span className="band-slot-more">
          <Button size="sm" className="band-slot-primary" disabled={readOnly || !runPrimary} onClick={stop(() => runPrimary?.())}>
            {primary.label}
          </Button>
          <GapMoreMenu items={gapMenuItems(disabledHint, false)} disabled={readOnly} onSelect={onMenu} />
        </span>
      )}
      {readOnly ? <small className="read-only-notice">历史集为只读档案</small> : null}
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
  canStepBack = true,
  canStepForward = true,
  children,
  extra,
}: {
  segment: BandSegment;
  selected: boolean;
  /** 拖动源:压暗留在原位,ghost 在 DragOverlay 里跟着指针走。 */
  dragging: boolean;
  /** 拖动落点:在这一格的前 / 后画 2px 强调插入线。 */
  overSide: "before" | "after" | null;
  dragDisabled: boolean;
  /** 点选;R13 §4 把点击事件递出去,镜头带按点在块内的位置 seek 到对应时刻。 */
  onSelect: (event?: MouseEvent<HTMLElement>) => void;
  onStep: (direction: -1 | 1) => void;
  /** R12 §2:「往前 / 往后」按钮能不能按(章首 / 章尾各禁一边);不传 = 都能。 */
  canStepBack?: boolean;
  canStepForward?: boolean;
  children?: JSX.Element | null;
  /** R13 §4:精选段镜块两侧的拖边把手(与默认瓦片内容并存)。 */
  extra?: JSX.Element | null;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: segment.key,
    disabled: dragDisabled,
  });
  const label = segmentAriaLabel(segment);
  // Y-07(0.7.0 真机):按住镜块本体拖曾经等于页面选字,只有 ⠿ 把手能拖,而引导和手册都说
  // 「拖动镜块」。指针监听挂到整块上(传感器只有 PointerSensor,距离 6px 才起拖,所以块内
  // 按钮照常点击;拖边把手自己 stopPropagation);dnd 的 aria 属性只给把手,gridcell 根不沾。
  const draggable = segment.kind === "clip" && !dragDisabled;
  const tileListeners = draggable ? listeners : undefined;
  // 回显 id 由 useSelection.echoElementId 统一生成 —— 媒体池按同一套规则找它。
  const domId =
    segment.kind === "slot"
      ? `band-slot-${segment.chapterId}-${segment.slot}`
      : `band-clip-${segment.clipId}`;
  const classes = [
    "band-segment",
    segment.kind === "slot" ? "slot" : "",
    dragging || isDragging ? "dragging" : "",
    draggable ? "band-segment--draggable" : "",
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
      // R13 车道 B 的新手引导按这个锚点找镜块 / 缺口卡(class 名之外的稳定钩子)。
      data-guide={segment.kind === "slot" ? "gap" : "shot"}
      className={classes}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={onSelect}
      {...tileListeners}
    >
      {children ?? (
        <>
          <span className="band-tile-thumb" aria-hidden="true">
            <CoverImage src={segment.coverUrl} lazy />
            <span className="band-tile-badges">
              {segment.takeCount > 1 ? (
                <Badge tone="ink" className="band-tile-take">{`第 ${segment.takeIndex}/${segment.takeCount} 条`}</Badge>
              ) : null}
              {segment.isGenerated ? (
                <Badge tone="accent" className="band-tile-ai">
                  AI 生成
                </Badge>
              ) : null}
            </span>
            <Badge tone="ink" className="band-tile-time">
              {bandDurationLabel(segment.durationTicks, segment.tbNum, segment.tbDen)}
            </Badge>
          </span>
          <span className="band-tile-name" title={segment.fileName ?? ""}>
            {segment.fileName}
          </span>
          <span className="band-tile-meta">
            {/* R12 §2:精选段镜块在左下标出它是素材里的哪一截(「片段 0.5–4.5 s」),整条素材仍是「槽位 nn」;130px 里只放得下一行。 */}
            {segment.rangeLabel ? (
              <span className="band-tile-slot band-tile-range" title={`${slotIndexLabel(segment.slotIndex)} · ${segment.rangeLabel}`}>
                {segment.rangeLabel}
              </span>
            ) : (
              <span className="band-tile-slot">{slotIndexLabel(segment.slotIndex)}</span>
            )}
            {segment.roleLabel ? <span className="band-tile-role">{segment.roleLabel}</span> : null}
          </span>
        </>
      )}
      {extra ?? null}
      {segment.kind === "clip" ? (
        // R12 §2:不靠拖拽的第二条路 —— 「往前 / 往后」按钮;X-03:选中的镜块常显(悬停 / 聚焦时也露出)。
        <span className="band-segment-steps">
          <Button
            variant="icon"
            size="sm"
            icon="arrow-left"
            aria-label="往前"
            title="往前"
            disabled={dragDisabled || !canStepBack}
            onClick={(event) => {
              event.stopPropagation();
              onStep(-1);
            }}
          />
          <Button
            variant="icon"
            size="sm"
            icon="arrow-right"
            aria-label="往后"
            title="往后"
            disabled={dragDisabled || !canStepForward}
            onClick={(event) => {
              event.stopPropagation();
              onStep(1);
            }}
          />
        </span>
      ) : null}
      {segment.kind === "clip" ? (
        <Button
          variant="icon"
          size="sm"
          icon="grip"
          className="band-segment-grip"
          aria-label={`拖动 ${label}`}
          disabled={dragDisabled}
          ref={setActivatorNodeRef}
          // 指针监听在镜块根上(Y-07),把手上的按下冒泡上去就够了;这里只留 aria 属性与键盘。
          {...attributes}
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
