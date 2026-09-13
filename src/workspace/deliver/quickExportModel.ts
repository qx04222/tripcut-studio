import { QUICK_EXPORT_DEST_UNAVAILABLE, type ExportStatus, type QuickExportOutcome, type QuickExportSelection } from "../../api";
import { dispatchWorkspace } from "../WorkspaceStore";

/**
 * R11 车道 E:快速导出的纯常量 / 纯函数,以及「导出所选…」入口与抽屉之间的一次性交接。
 * 抽屉只在打开时挂载,入口先把选择放在这里、再开抽屉,抽屉挂载时取走(取过即清)。
 */

export type ExportMode = "quick" | "full";

/** 交付抽屉打开时的默认模式:快速导出(业主原则:新功能默认开、默认值合理,不用先去设置)。 */
export const DEFAULT_EXPORT_MODE: ExportMode = "quick";

export const EXPORT_MODE_LABELS: Record<ExportMode, string> = {
  quick: "快速导出",
  full: "完整交付包",
};

let pendingSelection: QuickExportSelection | null = null;

/** 检查器 / 媒体池的「导出所选…」:记下只导这些,然后打开交付抽屉(默认就是快速导出)。 */
export function requestQuickExport(selection: QuickExportSelection): void {
  pendingSelection = selection;
  dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
}

/** 抽屉挂载时取走待处理的选择;没有就是 null(= 导本集全部)。 */
export function takePendingQuickSelection(): QuickExportSelection | null {
  const taken = pendingSelection;
  pendingSelection = null;
  return taken;
}

export function __resetQuickExportForTests(): void {
  pendingSelection = null;
}

/** 后端说"目标目录不存在 / 不可写"——换个文件夹就好,别的错不是。 */
export function isDestUnavailable(error: unknown): boolean {
  return String(error).includes(QUICK_EXPORT_DEST_UNAVAILABLE);
}

/** 路径的最后一段,给按钮 / 引导句用(`/Users/x/Desktop` → `Desktop`);空串原样返回。 */
export function folderDisplayName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length === 0 ? path : parts[parts.length - 1];
}

/** 选择里一共点了多少项(段 + 素材);null = 全部。 */
export function selectionCount(selection: QuickExportSelection | null): number {
  if (!selection) return 0;
  return (selection.segment_ids?.length ?? 0) + (selection.clip_ids?.length ?? 0);
}

/** 引导句:「这 n 个片段会导出到 <文件夹>」——数字来自清单(算好的),还没算出来先按状态计数。 */
export function quickLeadLine(plan: QuickExportOutcome | null, status: ExportStatus, lastDir: string | null): string {
  const count = plan ? plan.files.length : status.selected_count;
  const noun = count === 1 ? "这 1 个片段" : `这 ${count} 个片段`;
  if (!lastDir) return `${noun}会导出到你选的文件夹（点「导出」时选一次，以后记住）`;
  return `${noun}会导出到「${folderDisplayName(lastDir)}」`;
}

/** 完成 toast 的正文:「已导出 n 个文件」;有失败就补一句。 */
export function quickDoneLine(status: ExportStatus): string {
  const base = `已导出 ${status.completed_items} 个文件`;
  return status.failed_items > 0 ? `${base} · ${status.failed_items} 个没导出来` : base;
}

/** 这条完成状态是不是本次快速导出(而不是上一次交付包、也不是别的集)。 */
export function isQuickDone(status: ExportStatus, startedJobId: number | null): boolean {
  return status.status === "done" && status.mode === "quick" && startedJobId !== null && status.job_id === startedJobId;
}
