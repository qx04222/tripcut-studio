import type { DuelSource } from "../../api";
import type { MenuItem } from "../ui/Menu";

/**
 * R21 PH-05:擂台的入口总线。故意零依赖 —— 菜单/命令面板/结果面板只 import 这里,
 * 不把 WorkspaceStore、播放器整条链拖进它们的模块图(CommandPalette 的 api 全量 mock 会炸)。
 */
export const OPEN_DUEL = "tripcut:open-duel";
export const DUEL_CHANGED = "tripcut:duel-changed";
export const SIMILAR_GROUPS_CHANGED = "tripcut:similar-groups-changed";
export interface DuelRequest {
  clipIds?: number[];
  segmentId?: number;
  source?: DuelSource;
  /** 空选择入口必须携带发起时的工作台，避免异步解析跨入另一类素材。 */
  workspaceMode?: "video" | "photo";
}
export function requestDuel(request: DuelRequest = {}): void {
  window.dispatchEvent(new CustomEvent(OPEN_DUEL, { detail: request }));
}
export function notifySimilarGroupsChanged(): void {
  window.dispatchEvent(new Event(SIMILAR_GROUPS_CHANGED));
}
/** 三处菜单共用同一条「擂台」项;aria-label 与可见文字一致,旧菜单断言按 aria-label 对账。 */
export function duelMenuItem(readOnly: boolean): MenuItem {
  return { id: "duel", label: "擂台", ariaLabel: "擂台", disabled: readOnly };
}
