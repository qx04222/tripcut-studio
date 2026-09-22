import { useState, type JSX, type MouseEvent } from "react";
import { useSegmentDetails } from "./band/SegmentDetails";
import { segmentWidth } from "./bandGeometry";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { bandTileNameLabel, bandTileTooltip, slotIndexLabel } from "./BandSegmentLabel";
import { segmentAriaLabel, type BandSegment } from "./shotBandModel";
import { ShotMenu, ShotMoreButton } from "./BandSegmentMenu";
import { Badge, Button, Card, CoverImage } from "./ui";

// slotIndexLabel / bandTileNameLabel / bandTileTooltip(V-06 常显名与 tooltip)在
// BandSegmentLabel.ts 里(给这个文件腾行数,R13 给镜头带拆文件的同一条理由);
// re-export 保证外部导入路径不用变。
export { bandTileNameLabel, bandTileTooltip, slotIndexLabel } from "./BandSegmentLabel";

export { orderedTakes } from "./shotBandModel";

/**
 * 镜头带里的可视单元:分段瓦片、空槽位瓦片、拖动 ghost(规格 §3.7,基准稿 A)。
 * 瓦片 = `Card interactive selected` 160×130:缩略图 + Take / AI 角标 + 时长角标 +
 * 文件名一行 + 左下「槽位 nn」右下角色词;拖柄是 `grip` 图标按钮,AX 名 `拖动 …` 不变。
 */

/** 时长角标「m:ss」。默认 time base 是毫秒;素材段必须传自己的 tb(R-02:1/19200 的 ticks 当毫秒会把 1.2 s 显示成 0:23)。 */
export function bandDurationLabel(ticks: number, tbNum = 1, tbDen = 1_000): string {
  if (![ticks, tbNum, tbDen].every(Number.isFinite) || tbDen <= 0 || tbNum <= 0) return "0:00";
  const total = Math.max(0, Math.floor((ticks * tbNum) / tbDen));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

// R22-C:缺口卡及其判定 / 菜单项搬到 BandGapSlot.tsx(给镜块腾行数);导入路径不变。
export {
  GapMoreMenu,
  GapSlotBody,
  OPEN_SETTINGS_SECTION_EVENT,
  gapMenuItems,
  gapPrimaryAction,
  generationDisabledHint,
  openGenerationSettings,
  shortDisabledHint,
} from "./BandGapSlot";

export function SegmentCard({
  segment,
  zoom = 1,
  selected,
  playing = false,
  dragging,
  overSide,
  dragDisabled,
  onSelect,
  onStep,
  canStepBack = true,
  canStepForward = true,
  readOnly = false,
  children,
  extra,
}: {
  segment: BandSegment;
  /** R22-C:缩放档(0.35–3),镜块宽按 bandGeometry.segmentWidth 算;缺口卡不缩。 */
  zoom?: number;
  selected: boolean;
  /** R22-B 连播:这块正是在播的段(`data-playing="true"`)。 */
  playing?: boolean;
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
  /** R16 §1:只读历史集 —— 菜单里会改数据的项禁用(导出照常)。 */
  readOnly?: boolean;
  children?: JSX.Element | null;
  /** R13 §4:精选段镜块两侧的拖边把手(与默认瓦片内容并存)。 */
  extra?: JSX.Element | null;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: segment.key,
    disabled: dragDisabled,
  });
  const label = segmentAriaLabel(segment);
  // R22-C 第 7 项:角标(评级 / 收藏 / AI 理由)与 300 ms 悬停提示(原素材名 + in/out),见 band/SegmentDetails。
  const details = useSegmentDetails(segment);
  // R16 §1:镜块「···」与右键共用一份菜单锚点。
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  // Y-07(0.7.0 真机):按住镜块本体拖曾经等于页面选字,只有 ⠿ 把手能拖,而引导和手册都说
  // 「拖动镜块」。指针监听挂到整块上(传感器只有 PointerSensor,距离 6px 才起拖,所以块内
  // 按钮照常点击;拖边把手自己 stopPropagation);dnd 的 aria 属性只给把手,gridcell 根不沾。
  const draggable = segment.kind === "clip" && !dragDisabled;
  const tileListeners = draggable ? listeners : undefined;
  // 回显 id 由 useSelection.echoElementId 统一生成 —— 媒体池按同一套规则找它。
  const domId =
    segment.kind === "slot"
      ? `band-slot-${segment.chapterId}-${segment.slot}`
      : // R22-C:同一素材可以有多个精选段各自在带上,DOM id 按段 id 区分(useSelection 的回显按 data-clip-id 兜底)。
        segment.segmentId !== null ? `band-segment-${segment.segmentId}` : `band-clip-${segment.clipId}`;
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
      data-clip-id={segment.clipId}
      // R22-B 连播:当前段高亮的钩子(ShotBand 从连播 store 取 key 传下来;样式只在 band-r22.css 定义一处)。
      data-playing={playing ? "true" : undefined}
      {...details.handlers}
      // R13 车道 B 的新手引导按这个锚点找镜块 / 缺口卡(class 名之外的稳定钩子)。
      data-guide={segment.kind === "slot" ? "gap" : "shot"}
      className={classes}
      // R22-C:宽度随缩放;dnd 让位过渡走 --motion-fast 令牌(150 ms)。
      style={{ width: segmentWidth(segment, zoom), minWidth: segmentWidth(segment, zoom), flexBasis: segmentWidth(segment, zoom), transform: CSS.Transform.toString(transform), transition: transition ? "transform var(--motion-fast)" : undefined }}
      // 只认落在本块内的点击(portal 出去的 tooltip / 菜单不算)。
      onClick={(event) => { if (event.currentTarget.contains(event.target as Node)) onSelect(event); }}
      onContextMenu={(event) => {
        if (segment.kind !== "clip") return;
        event.preventDefault();
        setMenuAnchor({ x: event.clientX, y: event.clientY });
      }}
      {...tileListeners}
    >
      {children ?? (
        <>
          {/* V-06:常显只留封面 + 时长 + 一行名——第 n/m 条 / AI 生成 / 槽位 / 角色挪进
              这颗缩略图的 title(悬停 tooltip)与检查器;badges / meta 这两行仍在 DOM
              里(检查器与未来接线用),只是不再常驻占视觉(band-r19.css 隐藏)。 */}
          <span className="band-tile-thumb" aria-hidden="true" title={bandTileTooltip(segment)}>
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
            {bandTileNameLabel(segment.fileName)}
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
      {details.badges}
      {details.tooltip}
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
      {segment.kind === "clip" ? <ShotMoreButton expanded={menuAnchor !== null} onOpen={setMenuAnchor} /> : null}
      {menuAnchor && segment.kind === "clip" ? (
        <ShotMenu segment={segment} anchor={menuAnchor} canStepBack={canStepBack && !dragDisabled} canStepForward={canStepForward && !dragDisabled} readOnly={readOnly} onStep={onStep} onClose={() => setMenuAnchor(null)} />
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
