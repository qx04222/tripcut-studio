import type { ExportStatus, JianyingAvailability } from "../../api";
import type { ExportMode } from "./quickExportModel";

/**
 * R14 车道 B:「剪映素材包」的纯常量 / 纯函数 —— 剪映草稿走不通(版本没验证过)时永远可用的交接路:
 * 按镜头带顺序编号导出每个镜,用户在剪映里新建草稿、全选拖进时间线,顺序就是镜头带顺序。
 */

export const KIT_MODE_LABEL = "剪映素材包";
/** 抽屉面板与 chip 提示共用的一句话(业主原则:一句话说清现在会发生什么)。 */
export const KIT_LEAD_LINE = "按镜头带顺序编号导出,拖进剪映时间线就是这个顺序";
export const KIT_MODE_HINT = "剪映不管哪个版本都能用:导出编号好的片段,拖进剪映就是镜头带顺序";
/** 镜头带右上按钮在剪映不可用时的文案(AX 名同步)。 */
export const KIT_BAND_BUTTON_LABEL = "导出剪映素材包";
export const OPEN_JIANYING_ACTION = "打开剪映";

/** 结果卡上的三步:新建草稿 → 全选拖入 → 顺序即镜头带。 */
export const KIT_NEXT_STEPS: readonly string[] = [
  "打开剪映,新建一个草稿",
  "把文件夹里的片段全选,拖进时间线",
  "顺序就是镜头带的顺序;拿不准看「顺序.txt」",
];

/**
 * 四枚模式 chip 的顺序(R14 §9 B):剪映草稿 / 剪映素材包 / 导出片段 / 完整交付包。
 * 剪映可不可用都一样排 —— 不可用时草稿 chip 带「(待验证)」,默认落在素材包。
 */
export const EXPORT_MODES_R14: readonly ExportMode[] = ["jianying", "kit", "quick", "full"];

/** 没人指定模式时的默认:剪映可用 → 草稿;不可用 → 素材包(永远走得通的那条)。`null` = 可用性还没回来。 */
export function defaultExportMode(jianying: JianyingAvailability | null): ExportMode | null {
  if (jianying === null) return null;
  return jianying.supported ? "jianying" : "kit";
}

/** 路径的最后一段(与快速导出同一规则);空串原样返回。 */
function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length === 0 ? path : parts[parts.length - 1];
}

/** 页脚一句:「导出到 <上次文件夹>」;没记过就说第一次会选一次。 */
export function kitFolderLine(lastDir: string | null): string {
  return lastDir ? `导出到 ${folderName(lastDir)}` : "第一次导出会让你选一个文件夹,之后记住。";
}

/** 完成 toast 正文「已导出 n 个片段」(动作「打开剪映」另给);有失败补一句。 */
export function kitDoneLine(status: ExportStatus): string {
  const base = `已导出 ${status.completed_items} 个片段`;
  return status.failed_items > 0 ? `${base} · ${status.failed_items} 个没导出来` : base;
}

/** 这条完成状态是不是本次素材包导出(不是上一次快速导出、也不是别的集)。 */
export function isKitDone(status: ExportStatus, startedJobId: number | null): boolean {
  return status.status === "done" && status.mode === "kit" && startedJobId !== null && status.job_id === startedJobId;
}
