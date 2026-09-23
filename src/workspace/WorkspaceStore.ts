import { MATERIAL_MODE_EVENT } from "./playthrough/selection";
import { useSyncExternalStore } from "react";
import type { ClipDimensionKey, SettingsMap } from "../api";
import type { SettingsSectionId } from "../settingsSections";
import type { SelectionFilter } from "./poolModel";
import {
  UI_SETTING_DEFAULTS,
  createUiSettingWriter,
  readUiBool,
  readUiList,
  readUiNumber,
  readUiSetting,
  type UiSettingWriter,
} from "./uiSettings";

export type Selection =
  | { kind: "clip"; clipId: number }
  | { kind: "slot"; chapterId: number; slot: string }
  | null;
export type BandMode = "story" | "music" | "journey" | "destination" | "template";
export type DrawerKind = "import" | "deliver" | "settings" | null;
export type PaneId = "pool" | "monitor" | "band" | "inspector";
export type WorkspaceMode = "video" | "photo";
/** 正在只读查看的历史集(规格 §4 的"历史集只读视角")。null = 看当前集。 */
export type ViewingEpisode = { id: number; title: string } | null;

export interface WorkspaceState {
  workspaceMode: WorkspaceMode;
  selection: Selection;
  anchorClipId: number | null;
  multiSelection: readonly number[];
  poolWidth: number;
  inspectorWidth: number;
  monitorRatio: number;
  /** 用户手动折叠媒体池(⌘1 或竖条按钮),落 `ui.pane.pool_collapsed`。 */
  poolCollapsed: boolean;
  /**
   * 窄窗自动折叠媒体池(R10 U-04)。与手动折叠**分开记**且永不落盘:此前自动折叠直接翻
   * 手动位,被 persistedPairs 写进设置表——窗口放大后没人把它翻回来。实际显示按
   * `isPaneCollapsed()`(二者取或)。
   */
  poolAutoCollapsed: boolean;
  /**
   * R19 shell(V-04):检查器不再是一栏,是监视器栏内的滑出层。可见 = `!inspectorDismissed &&
   * (inspectorPinned || selection !== null)`(见 `isInspectorOpen`)。
   * - `inspectorPinned` 是偏好(📌 钉住 → 常驻),落 `ui.inspector.pinned`;
   * - `inspectorDismissed` 是会话态(Esc / 点空白 / ⌘2 收起),任何一次选中都把它清零,永不落盘。
   */
  inspectorPinned: boolean;
  inspectorDismissed: boolean;
  bandMode: BandMode;
  openDrawer: DrawerKind;
  importTab: "source" | "jobs" | "missing";
  /** 打开设置 sheet 时要落到的分区(`openSettings(section)`);null = sheet 自己的默认分区。 */
  settingsSection: SettingsSectionId | null;
  /**
   * 启动时待恢复的选中(R10 U-23,`ui.selection.last_clip`)。素材表还没拉回来之前
   * 不能直接写进 `selection`(检查器会对着一个可能已删除的 id 转圈),壳在 clips feed
   * 首次落地后核对存在再选中,随后清掉。
   */
  restoreClipId: number | null;
  inspectorSections: readonly string[];
  filter: SelectionFilter;
  dimension: ClipDimensionKey | "";
  query: string;
  focusedPane: PaneId;
  immersive: boolean;
  /**
   * 新壳里历史集只读查看的落点(R8 终审 L6)。旧壳靠 `tripcut:view-episode` 让
   * `SelectPage` 切视角;新壳没有 `SelectPage`,事件此前无人接管——点历史集在
   * 新壳里什么都不会发生。媒体池按这个值把范围收到该集。
   */
  viewingEpisode: ViewingEpisode;
}

export type WorkspaceAction =
  | { type: "set-workspace-mode"; mode: WorkspaceMode }
  | {
      type: "select-clip";
      source?: "segment";
      clipId: number;
      shift?: boolean;
      meta?: boolean;
      /**
       * 调用点(useSelection)按**可见顺序**算好的多选集合。⇧ 连选的闭区间是
       * 「网格里看得见的那一段」,不是 id 数值区间 —— 筛选与搜索一变,两者就不是
       * 同一批素材。给了就直接用,没给才退回下面按 id 取区间的兜底。
       */
      ids?: readonly number[];
    }
  | { type: "select-slot"; chapterId: number; slot: string }
  | { type: "clear-selection" }
  | { type: "set-pane-size"; pane: "pool" | "inspector" | "monitor"; value: number }
  | { type: "toggle-pane"; pane: "pool" | "inspector" }
  /** 窄窗阈值跨越时由壳派发;只改媒体池的 auto 位,不碰用户手动位(检查器 R19 起没有自动折叠)。 */
  | { type: "set-auto-collapse"; pool?: boolean }
  /** R19 V-04:📌 钉住 / 取消钉住检查器(落盘的偏好)。 */
  | { type: "set-inspector-pinned"; pinned: boolean }
  | { type: "set-band-mode"; mode: BandMode }
  | {
      type: "open-drawer";
      drawer: Exclude<DrawerKind, null>;
      tab?: WorkspaceState["importTab"];
      section?: SettingsSectionId;
    }
  | { type: "consume-restore-clip" }
  | { type: "close-drawer" }
  | { type: "toggle-inspector-section"; id: string }
  | { type: "set-filter"; filter: SelectionFilter }
  | { type: "set-dimension"; dimension: ClipDimensionKey | "" }
  | { type: "set-query"; query: string }
  | { type: "focus-pane"; pane: PaneId }
  | { type: "cycle-pane-focus"; direction?: 1 | -1 }
  | { type: "set-immersive"; immersive: boolean }
  | { type: "view-episode"; episode: ViewingEpisode }
  | { type: "hydrate"; settings: SettingsMap };

// 规格 §2 的栏宽上下限。像素级的最小高度由 react-resizable-panels 的 minSize 在
// 运行时兜底,这里的比例夹取只是防止坏偏好把中栏压没。
export const POOL_WIDTH_MIN = 260;
export const POOL_WIDTH_MAX = 480;
export const INSPECTOR_WIDTH_MIN = 280;
export const INSPECTOR_WIDTH_MAX = 520;
export const MONITOR_RATIO_MIN = 0.2;
export const MONITOR_RATIO_MAX = 0.8;

const PANE_ORDER: readonly PaneId[] = ["pool", "monitor", "band", "inspector"];

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export const INITIAL_WORKSPACE_STATE: WorkspaceState = {
  workspaceMode: "video",
  selection: null,
  anchorClipId: null,
  multiSelection: [],
  poolWidth: Number(UI_SETTING_DEFAULTS["ui.pane.pool_width"]),
  inspectorWidth: Number(UI_SETTING_DEFAULTS["ui.pane.inspector_width"]),
  monitorRatio: Number(UI_SETTING_DEFAULTS["ui.pane.monitor_height"]),
  poolCollapsed: false,
  poolAutoCollapsed: false,
  inspectorPinned: false,
  inspectorDismissed: false,
  bandMode: "story",
  openDrawer: null,
  importTab: "source",
  settingsSection: null,
  restoreClipId: null,
  inspectorSections: [],
  filter: "all",
  dimension: "",
  query: "",
  focusedPane: "pool",
  immersive: false,
  viewingEpisode: null,
};

/**
 * 由 `hydrate` 产出的 state。`persistedPairs` 见到它就返回空数组 —— 刚从设置表读回来的
 * 值不该马上再写回去,否则每次启动都刷一轮 settings 表。用 WeakSet 而不是在
 * WorkspaceState 上加字段,是为了不让「其余每个 action 都记得把这个字段清掉」
 * 变成一条永远会被忘掉的纪律。
 */
const HYDRATED_STATES = new WeakSet<WorkspaceState>();

/** R19 V-04:检查器滑出层此刻是否展开(钉住则常驻;否则选中即出、收起即藏)。 */
export function isInspectorOpen(state: WorkspaceState): boolean {
  return !state.inspectorDismissed && (state.inspectorPinned || state.selection !== null);
}

/**
 * 实际显示用的折叠判定。媒体池:手动折叠或窄窗自动折叠,任一为真就是竖条。
 * 检查器:R19 起等于「滑出层没展开」——F6 轮栏与「恢复默认布局」仍按这个名字问。
 */
export function isPaneCollapsed(state: WorkspaceState, pane: "pool" | "inspector"): boolean {
  return pane === "pool" ? state.poolCollapsed || state.poolAutoCollapsed : !isInspectorOpen(state);
}

/** `ui.selection.last_clip`:没写过 / 坏值 / 非正整数一律当没有。 */
function readRestoreClipId(settings: SettingsMap): number | null {
  const raw = readUiSetting(settings, "ui.selection.last_clip");
  if (raw === "") return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isBandMode(value: string): value is BandMode {
  return ["story", "music", "journey", "destination", "template"].includes(value);
}

function toggleMember(list: readonly number[], clipId: number): number[] {
  return list.includes(clipId) ? list.filter((id) => id !== clipId) : [...list, clipId];
}

function rangeBetween(anchor: number, target: number): number[] {
  const [low, high] = anchor <= target ? [anchor, target] : [target, anchor];
  const out: number[] = [];
  for (let id = low; id <= high; id += 1) out.push(id);
  return out;
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "set-workspace-mode":
      if (state.workspaceMode === action.mode) return state;
      return {
        ...state,
        workspaceMode: action.mode,
        selection: null,
        anchorClipId: null,
        multiSelection: [],
        inspectorDismissed: true,
      };
    case "select-clip": {
      const selection: Selection = { kind: "clip", clipId: action.clipId };
      // R19 V-04:选中即出 —— 任何一次选中都把「收起」清零。
      const base = { ...state, inspectorDismissed: false };
      if (action.ids) {
        return { ...base, selection, anchorClipId: action.clipId, multiSelection: action.ids };
      }
      if (action.shift && state.anchorClipId !== null) {
        // ⇧ 连选:锚点到目标的闭区间。锚点不动,监视器跟最后一次点击。
        return { ...base, selection, multiSelection: rangeBetween(state.anchorClipId, action.clipId) };
      }
      if (action.meta) {
        return {
          ...base,
          selection,
          anchorClipId: action.clipId,
          multiSelection: toggleMember(state.multiSelection, action.clipId),
        };
      }
      return { ...base, selection, anchorClipId: action.clipId, multiSelection: [action.clipId] };
    }
    case "select-slot":
      return {
        ...state,
        selection: { kind: "slot", chapterId: action.chapterId, slot: action.slot },
        anchorClipId: null,
        multiSelection: [],
        inspectorDismissed: false,
      };
    case "clear-selection":
      return { ...state, selection: null, anchorClipId: null, multiSelection: [] };
    case "set-pane-size":
      if (action.pane === "pool") {
        return { ...state, poolWidth: clamp(action.value, POOL_WIDTH_MIN, POOL_WIDTH_MAX) };
      }
      if (action.pane === "inspector") {
        return { ...state, inspectorWidth: clamp(action.value, INSPECTOR_WIDTH_MIN, INSPECTOR_WIDTH_MAX) };
      }
      return { ...state, monitorRatio: clamp(action.value, MONITOR_RATIO_MIN, MONITOR_RATIO_MAX) };
    case "toggle-pane": {
      // 「切换」按**实际显示**判:竖条状态下(不管是手动还是窄窗自动折的)一律展开,
      // 且把两个位都清掉——用户明确要看,窄窗的自动折叠让位;展开状态下折叠记为手动。
      if (action.pane === "pool") {
        const collapsed = isPaneCollapsed(state, "pool");
        return { ...state, poolCollapsed: !collapsed, poolAutoCollapsed: false };
      }
      // R19 V-04:⌘2 = 收起 / 找回滑出层。展开着就收起(会话态);收着就找回 —— 没有选中、
      // 也没钉住时「找回」唯一说得通的意思是钉住它(常驻,空态一句话),记为偏好。
      if (isInspectorOpen(state)) return { ...state, inspectorDismissed: true };
      return { ...state, inspectorDismissed: false, inspectorPinned: state.inspectorPinned || state.selection === null };
    }
    case "set-auto-collapse":
      return { ...state, poolAutoCollapsed: action.pool ?? state.poolAutoCollapsed };
    case "set-inspector-pinned":
      // 钉住的同时把「收起」清零 —— 用户点 📌 是想看见它,不是想记一个看不见的偏好。
      return { ...state, inspectorPinned: action.pinned, inspectorDismissed: action.pinned ? false : state.inspectorDismissed };
    case "set-band-mode":
      return { ...state, bandMode: action.mode };
    case "open-drawer":
      return {
        ...state,
        openDrawer: action.drawer,
        importTab: action.tab ?? state.importTab,
        settingsSection: action.drawer === "settings" ? (action.section ?? null) : state.settingsSection,
      };
    case "consume-restore-clip":
      return state.restoreClipId === null ? state : { ...state, restoreClipId: null };
    case "close-drawer":
      return { ...state, openDrawer: null };
    case "toggle-inspector-section":
      return {
        ...state,
        inspectorSections: state.inspectorSections.includes(action.id)
          ? state.inspectorSections.filter((id) => id !== action.id)
          : [...state.inspectorSections, action.id],
      };
    case "set-filter":
      return { ...state, filter: action.filter };
    case "set-dimension":
      return { ...state, dimension: action.dimension };
    case "set-query":
      return { ...state, query: action.query };
    case "focus-pane":
      return { ...state, focusedPane: action.pane };
    case "cycle-pane-focus": {
      const paneOrder = state.workspaceMode === "photo" ? (["pool", "monitor", "band"] as const) : PANE_ORDER;
      const start = paneOrder.indexOf(state.focusedPane as typeof paneOrder[number]);
      const direction = action.direction ?? 1;
      const size = paneOrder.length;
      for (let step = 1; step <= size; step += 1) {
        // +size 再取模:⇧F6 往回走时下标会变负,JS 的 % 保留负号。
        const candidate = paneOrder[(start + direction * step + size * size) % size]!;
        if (candidate === "pool" && state.workspaceMode !== "photo" && isPaneCollapsed(state, "pool")) continue;
        if (candidate === "inspector" && isPaneCollapsed(state, "inspector")) continue;
        return { ...state, focusedPane: candidate };
      }
      return state;
    }
    case "set-immersive":
      return { ...state, immersive: action.immersive };
    case "view-episode": {
      const current = state.viewingEpisode;
      const next = action.episode;
      if (current === next) return state;
      if (current && next && current.id === next.id && current.title === next.title) return state;
      // 换查看范围等于换了一池素材——旧的选择在新范围里不成立,一并清掉。
      return { ...state, viewingEpisode: next, selection: null, anchorClipId: null, multiSelection: [] };
    }
    case "hydrate": {
      const s = action.settings;
      const bandMode = readUiSetting(s, "ui.band.mode");
      const workspaceMode = readUiSetting(s, "ui.workspace.mode");
      const dimension = readUiSetting(s, "ui.pool.dimension") as ClipDimensionKey | "";
      const next: WorkspaceState = {
        ...state,
        workspaceMode: workspaceMode === "photo" ? "photo" : "video",
        poolWidth: clamp(readUiNumber(s, "ui.pane.pool_width"), POOL_WIDTH_MIN, POOL_WIDTH_MAX),
        inspectorWidth: clamp(
          readUiNumber(s, "ui.pane.inspector_width"),
          INSPECTOR_WIDTH_MIN,
          INSPECTOR_WIDTH_MAX,
        ),
        monitorRatio: clamp(
          readUiNumber(s, "ui.pane.monitor_height"),
          MONITOR_RATIO_MIN,
          MONITOR_RATIO_MAX,
        ),
        poolCollapsed: readUiBool(s, "ui.pane.pool_collapsed"),
        inspectorPinned: readUiBool(s, "ui.inspector.pinned"),
        bandMode: isBandMode(bandMode) ? bandMode : "story",
        inspectorSections: readUiList(s, "ui.inspector.sections_open"),
        filter: readUiSetting(s, "ui.pool.filter") as SelectionFilter,
        dimension,
        restoreClipId: readRestoreClipId(s),
      };
      HYDRATED_STATES.add(next);
      return next;
    }
    default:
      return state;
  }
}

/** reducer 之外的纯函数:这一次 action 产生了哪些需要落盘的 `ui.*` 键值对。 */
export function persistedPairs(
  previous: WorkspaceState,
  next: WorkspaceState,
): ReadonlyArray<readonly [string, string]> {
  if (HYDRATED_STATES.has(next)) return [];
  const pairs: Array<readonly [string, string]> = [];
  if (previous.workspaceMode !== next.workspaceMode) pairs.push(["ui.workspace.mode", next.workspaceMode]);
  // 选择、焦点、抽屉、搜索词都是会话态 —— 它们不在这张表里,所以永远不落盘。
  if (previous.poolWidth !== next.poolWidth) {
    pairs.push(["ui.pane.pool_width", String(Math.round(next.poolWidth))]);
  }
  if (previous.inspectorWidth !== next.inspectorWidth) {
    pairs.push(["ui.pane.inspector_width", String(Math.round(next.inspectorWidth))]);
  }
  if (previous.monitorRatio !== next.monitorRatio) {
    pairs.push(["ui.pane.monitor_height", String(next.monitorRatio)]);
  }
  if (previous.poolCollapsed !== next.poolCollapsed) {
    pairs.push(["ui.pane.pool_collapsed", String(next.poolCollapsed)]);
  }
  if (previous.inspectorPinned !== next.inspectorPinned) {
    pairs.push(["ui.inspector.pinned", String(next.inspectorPinned)]);
  }
  if (previous.bandMode !== next.bandMode) pairs.push(["ui.band.mode", next.bandMode]);
  if (previous.inspectorSections !== next.inspectorSections) {
    pairs.push(["ui.inspector.sections_open", JSON.stringify(next.inspectorSections)]);
  }
  if (previous.filter !== next.filter) pairs.push(["ui.pool.filter", next.filter]);
  if (previous.dimension !== next.dimension) pairs.push(["ui.pool.dimension", next.dimension]);
  // 选中本身是会话态,只有「最近选中的素材」落盘(U-23):重启后壳按它恢复选中。
  // 清除选中 / 选到槽位不改这个键——用户下次启动仍回到最后看过的那条。
  const nextClip = next.selection?.kind === "clip" ? next.selection.clipId : null;
  const previousClip = previous.selection?.kind === "clip" ? previous.selection.clipId : null;
  if (nextClip !== null && nextClip !== previousClip) {
    pairs.push(["ui.selection.last_clip", String(nextClip)]);
  }
  return pairs;
}

let state: WorkspaceState = INITIAL_WORKSPACE_STATE;
const listeners = new Set<() => void>();
let writer: UiSettingWriter = createUiSettingWriter();

export function getWorkspaceSnapshot(): WorkspaceState {
  return state;
}

export function subscribeWorkspace(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function dispatchWorkspace(action: WorkspaceAction): void {
  if (action.type === "select-clip" && action.source !== "segment") window.dispatchEvent(new Event(MATERIAL_MODE_EVENT));
  const next = workspaceReducer(state, action);
  if (next === state) return;
  const pairs = persistedPairs(state, next);
  state = next;
  for (const [key, value] of pairs) writer.queue(key, value);
  for (const listener of [...listeners]) listener();
}

export function useWorkspace<T>(selector: (snapshot: WorkspaceState) => T): T {
  // selector 的结果必须是标量或稳定引用;数组类选择器在调用点用 useMemo 包。
  return useSyncExternalStore(
    subscribeWorkspace,
    () => selector(state),
    () => selector(INITIAL_WORKSPACE_STATE),
  );
}

export function __resetWorkspaceForTests(partial?: Partial<WorkspaceState>): void {
  state = { ...INITIAL_WORKSPACE_STATE, ...partial };
  writer = createUiSettingWriter(async () => undefined);
  for (const listener of [...listeners]) listener();
}
