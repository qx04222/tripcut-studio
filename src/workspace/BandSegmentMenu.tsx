import { useEffect, type JSX } from "react";

import type { Storyboard } from "../api";
import { duelMenuItem, requestDuel } from "./duel/duelBus";
import { MORE_BUTTON_LABEL, SHOT_MENU, SHOT_MENU_LABEL, menuAriaLabel, type ShotMenuId } from "./copy";
import { requestQuickExport } from "./deliver/quickExportModel";
import { failureText } from "./errorText";
import { deleteSegmentWithUndo } from "./segmentDeletion";
import type { BandSegment } from "./shotBandModel";
import { Button, Menu, type MenuItem } from "./ui";
import { showToast } from "./ui/toastStore";
import { planBandRemove, planBandStep, type BandDragState } from "./useBandDrag";

/**
 * R16 §1 / P1-4(车道 A):镜块的「···」/ 右键菜单 —— 往前 · 往后 · 从镜头带移出 · 删除精选段 · 导出这一段…。
 * 菜单本体挂在镜块上(BandSegment.tsx),动作通过一个 window 事件交给带上的 `BandSegmentActions`
 * (它握着故事板与拖排写入路径);这样 ShotBand / BandChapters 一行 prop 都不用加。
 */
export const BAND_SEGMENT_ACTION_EVENT = "tripcut:band-segment-action";

export interface BandSegmentActionDetail {
  segment: BandSegment;
  action: ShotMenuId;
}

export const SHOT_MENU_ORDER: readonly ShotMenuId[] = ["stepBack", "stepForward", "removeFromBand", "deleteSegment", "exportSegment"];

export function shotMenuItems(
  segment: Pick<BandSegment, "segmentId">,
  options: { canStepBack: boolean; canStepForward: boolean; readOnly: boolean },
): MenuItem[] {
  return SHOT_MENU_ORDER.map((id) => {
    const label = SHOT_MENU[id];
    let disabled = false;
    if (id === "stepBack") disabled = options.readOnly || !options.canStepBack;
    else if (id === "stepForward") disabled = options.readOnly || !options.canStepForward;
    else if (id === "deleteSegment") disabled = options.readOnly || segment.segmentId === null;
    else if (id === "removeFromBand") disabled = options.readOnly;
    return { id, label, ariaLabel: menuAriaLabel(label), disabled };
  });
}

export function dispatchBandSegmentAction(detail: BandSegmentActionDetail): void {
  window.dispatchEvent(new CustomEvent<BandSegmentActionDetail>(BAND_SEGMENT_ACTION_EVENT, { detail }));
}

/** 镜块右上的「···」(X-03 同一套:选中 / 悬停 / 聚焦时露出,样式在 wire-r16.css)。 */
export function ShotMoreButton({ expanded, onOpen }: { expanded: boolean; onOpen: (anchor: { x: number; y: number }) => void }): JSX.Element {
  return (
    <Button
      variant="icon"
      size="sm"
      className="band-segment-more"
      aria-label={MORE_BUTTON_LABEL}
      aria-haspopup="menu"
      aria-expanded={expanded}
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        onOpen({ x: rect.left, y: rect.bottom + 2 });
      }}
    >
      <span aria-hidden="true">···</span>
    </Button>
  );
}

/** 镜块上就地弹出的菜单(状态由 SegmentCard 持有:按钮与右键共用)。 */
export function ShotMenu({
  segment,
  anchor,
  canStepBack,
  canStepForward,
  readOnly,
  onStep,
  onClose,
}: {
  segment: BandSegment;
  anchor: { x: number; y: number };
  canStepBack: boolean;
  canStepForward: boolean;
  readOnly: boolean;
  onStep: (direction: -1 | 1) => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <Menu
      x={anchor.x}
      y={anchor.y}
      ariaLabel={SHOT_MENU_LABEL}
      items={[...shotMenuItems(segment, { canStepBack, canStepForward, readOnly }), duelMenuItem(readOnly)]}
      onClose={onClose}
      onSelect={(id) => {
        if (id === "duel") requestDuel({ clipIds: segment.clipId === null ? [] : [segment.clipId], segmentId: segment.segmentId ?? undefined });
        else if (id === "stepBack") onStep(-1);
        else if (id === "stepForward") onStep(1);
        else dispatchBandSegmentAction({ segment, action: id as ShotMenuId });
      }}
    />
  );
}

/** 带上的动作执行者:ShotBand 里挂一份,握着故事板与 `useBandDrag`。 */
export function BandSegmentActions({ board, drag }: { board: Storyboard | null; drag: BandDragState }): null {
  useEffect(() => {
    const onAction = (event: Event) => {
      const { segment, action } = (event as CustomEvent<BandSegmentActionDetail>).detail;
      switch (action) {
        case "stepBack":
        case "stepForward":
          if (board) drag.apply(planBandStep(board, segment.key, action === "stepBack" ? -1 : 1));
          return;
        case "removeFromBand":
          // 顺序表里少传它那条 ref(精选段保留、仍在候选里);写入路径与拖排同一条,所以同样可撤销。
          if (board) drag.apply(planBandRemove(board, segment.key));
          return;
        case "deleteSegment":
          if (segment.segmentId === null) return;
          void deleteSegmentWithUndo(segment.segmentId).catch((error) => showToast(failureText("删除精选段", error), { tone: "danger" }));
          return;
        case "exportSegment":
          if (segment.segmentId !== null) requestQuickExport({ segment_ids: [segment.segmentId] });
          else if (segment.clipId !== null) requestQuickExport({ clip_ids: [segment.clipId] });
          return;
      }
    };
    window.addEventListener(BAND_SEGMENT_ACTION_EVENT, onAction);
    return () => window.removeEventListener(BAND_SEGMENT_ACTION_EVENT, onAction);
  }, [board, drag]);
  return null;
}
