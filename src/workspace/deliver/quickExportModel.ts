import { QUICK_EXPORT_DEST_UNAVAILABLE, type ExportStatus, type QuickExportOutcome, type QuickExportSelection } from "../../api";
import { dispatchWorkspace } from "../WorkspaceStore";

/**
 * R11 车道 E:快速导出的纯常量 / 纯函数,以及「导出所选…」入口与抽屉之间的一次性交接。
 * 抽屉只在打开时挂载,入口先把选择放在这里、再开抽屉,抽屉挂载时取走(取过即清)。
 */

/** R12 §6:三枚模式 chip —— 导出片段(默认)/ 完整交付包 / 剪映草稿(= 完整交付包 + 强制出草稿);R14 §9 B 加「剪映素材包」。 */
export type ExportMode = "quick" | "full" | "jianying" | "kit";

/** 交付抽屉打开时的默认模式:导出片段(业主原则:新功能默认开、默认值合理,不用先去设置)。 */
export const DEFAULT_EXPORT_MODE: ExportMode = "quick";

export const EXPORT_MODE_LABELS: Record<ExportMode, string> = {
  quick: "导出片段",
  full: "完整交付包",
  jianying: "剪映草稿",
  kit: "剪映素材包",
};

export const EXPORT_MODE_HINTS: Record<ExportMode, string> = {
  quick: "只导片段和收藏的视频文件",
  full: "视频 + 参考粗剪 + 镜头表 + 说明",
  jianying: "在剪映里直接接着剪;自检不过会自动降级为完整交付包",
  kit: "剪映不管哪个版本都能用:导出编号好的片段,拖进剪映就是镜头带顺序",
};

/** 剪映 chip 的可见文案:不可用时带「(待验证)」;白话原因另起一句。 */
export function jianyingChipLabel(supported: boolean): string {
  return supported ? EXPORT_MODE_LABELS.jianying : `${EXPORT_MODE_LABELS.jianying}(待验证)`;
}

export function jianyingUnavailableLine(installedVersion: string | null, forceAllowed = false): string {
  // R14 §9 A / V14-03:待验证名单里的版本一句话说清「现在怎么办」—— 与下面剪映行的「可以试着生成」
  // 同一个方向,不再一边说「先用完整交付包」一边给「仍然试着生成」按钮;这一版的兜底是素材包。
  if (installedVersion && forceAllowed) {
    return `这个剪映版本(${installedVersion})还没核对过草稿格式。可以先导出素材包,或试着生成一份草稿在剪映里打开看看。`;
  }
  return installedVersion
    ? `检测到剪映 ${installedVersion},这个版本还没核对过草稿格式;先用「剪映素材包」。`
    : "没检测到剪映;装好剪映专业版再来,或先用「剪映素材包」。";
}

/** 失败项对应的素材 id(去重);「只重试失败的」按它发 quick_export selection。 */
export function failedClipIds(status: ExportStatus): number[] {
  return [...new Set(status.items.filter((item) => item.status === "failed").map((item) => item.clip_id))];
}

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

/**
 * R12 §3:导出结束的 toast 文案 ——「6 个导好了」/「6 个导好了,3 个没导出来」;
 * 失败原因取第一条失败项的一句人话(没有就不加)。
 */
export function exportDoneToast(status: ExportStatus): string {
  const ok = `${status.completed_items} 个导好了`;
  if (status.failed_items <= 0) return ok;
  const reason = status.items.find((item) => item.status === "failed" && item.note)?.note;
  return `${ok},${status.failed_items} 个没导出来${reason ? `(${reason})` : ""}`;
}


/** R13 §5:抽屉决定默认模式时用 —— 「导出所选…」进来的抽屉要停在导出片段,不能被「剪映可用默认剪映」抢走。 */
export function hasPendingQuickSelection(): boolean {
  return pendingSelection !== null;
}
