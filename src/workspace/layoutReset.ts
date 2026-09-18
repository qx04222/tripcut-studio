import { setSetting } from "../api";
import { UI_SETTING_DEFAULTS } from "./uiSettings";
import { dispatchWorkspace, getWorkspaceSnapshot, isPaneCollapsed } from "./WorkspaceStore";

/** 壳听这个事件换 key 重挂三栏(Panel 只认 defaultSize)。 */
export const LAYOUT_RESET_EVENT = "tripcut:layout-reset";

/** 布局五个键的默认值(与 UI_SETTING_DEFAULTS 同一份)。R19:检查器折叠位换成「钉住」偏好。 */
export const PANE_LAYOUT_KEYS = ["ui.pane.pool_width", "ui.pane.inspector_width", "ui.pane.monitor_height", "ui.pane.pool_collapsed", "ui.inspector.pinned"] as const;

/**
 * R16 P2-12「恢复默认布局」:栏宽 / 监视器占比 / 两侧折叠位全部写回默认,store 同步,壳重挂三栏。
 * 写设置失败就抛(设置页 toast);store 与壳只在写成功后动,免得重启后又弹回去。
 */
export async function resetLayout(): Promise<void> {
  for (const key of PANE_LAYOUT_KEYS) await setSetting(key, UI_SETTING_DEFAULTS[key]);
  const state = getWorkspaceSnapshot();
  dispatchWorkspace({ type: "set-pane-size", pane: "pool", value: Number(UI_SETTING_DEFAULTS["ui.pane.pool_width"]) });
  dispatchWorkspace({ type: "set-pane-size", pane: "inspector", value: Number(UI_SETTING_DEFAULTS["ui.pane.inspector_width"]) });
  dispatchWorkspace({ type: "set-pane-size", pane: "monitor", value: Number(UI_SETTING_DEFAULTS["ui.pane.monitor_height"]) });
  if (isPaneCollapsed(state, "pool")) dispatchWorkspace({ type: "toggle-pane", pane: "pool" });
  // R19 V-04:检查器回到默认 = 不钉住、不收起(选中即出)。
  if (state.inspectorPinned) dispatchWorkspace({ type: "set-inspector-pinned", pinned: false });
  if (state.inspectorDismissed) dispatchWorkspace({ type: "toggle-pane", pane: "inspector" });
  window.dispatchEvent(new CustomEvent(LAYOUT_RESET_EVENT));
}
