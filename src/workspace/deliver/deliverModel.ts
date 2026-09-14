import type { ExportStatus, JianyingDraftResult, PlatformPreset, RoughCutTargetSeconds, SettingsMap, TargetPlatform } from "../../api";
import { readUiBool, readUiSetting } from "../uiSettings";

/** 交付表单的纯常量与纯函数(R9 Task 6a):从 `DeliverPage` 移入,那里 re-export。 */

export const PLATFORM_LABELS: Record<TargetPlatform, string> = {
  douyin: "抖音",
  xiaohongshu: "小红书",
  bilibili: "B站",
  moments: "朋友圈",
  family: "家庭纪录",
  general: "通用",
};

export const PLATFORM_OPTIONS = Object.keys(PLATFORM_LABELS) as TargetPlatform[];

/** R6 Task 6 G9:参考粗剪目标时长下拉——`null` 表示完整长度。 */
export type TargetSecondsOption = RoughCutTargetSeconds | null;

export const ROUGH_CUT_TARGET_OPTIONS: TargetSecondsOption[] = [null, 30, 60, 180];

export const ROUGH_CUT_TARGET_LABELS: Record<string, string> = {
  full: "完整",
  "30": "30 秒",
  "60": "60 秒",
  "180": "3 分钟",
};

export function roughCutTargetKey(option: TargetSecondsOption): string {
  return option === null ? "full" : String(option);
}

export function roughCutTargetFromKey(key: string): TargetSecondsOption {
  return key === "full" ? null : (Number(key) as RoughCutTargetSeconds);
}

/** 平台预设的时长预算(ticks -> 秒,整数除法,`0`/负数一律按不限时长处理)。 */
export function presetBudgetSeconds(preset: PlatformPreset | undefined): number {
  if (!preset || preset.duration_budget_ticks <= 0 || preset.tb_den <= 0) return 0;
  return Math.floor((preset.duration_budget_ticks * preset.tb_num) / preset.tb_den);
}

/** 预算内能选的最大档位;没有任何档位 ≤ 预算(含不限时长)时回退到"完整"。 */
export function closestTargetWithinBudget(budgetSeconds: number): TargetSecondsOption {
  if (budgetSeconds <= 0) return null;
  const candidates = ROUGH_CUT_TARGET_OPTIONS.filter(
    (option): option is RoughCutTargetSeconds => option !== null && option <= budgetSeconds,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, option) => (option > best ? option : best));
}

export const EMPTY_STATUS: ExportStatus = {
  job_id: null,
  status: "idle",
  stage: "idle",
  selected_count: 0,
  selected_segment_count: 0,
  selected_whole_count: 0,
  total_duration_seconds: 0,
  completed_items: 0,
  failed_items: 0,
  items: [],
  output_path: null,
  error: null,
  contact_sheet_glyph_fallbacks: null,
  contact_sheet_cover_failures: null,
  rough_cut_target_seconds: null,
  rough_cut_actual_ticks: null,
  rough_cut_actual_tb_num: null,
  rough_cut_actual_tb_den: null,
};

export const STAGE_LABELS: Record<ExportStatus["stage"], string> = {
  idle: "等待生成",
  queued: "已加入队列",
  remuxing: "整理精选片段",
  rough_cut: "生成参考粗剪",
  documents: "写入交付文档",
  finalizing: "完成原子交付",
  cancelling: "正在取消",
  cancelled: "已取消",
  complete: "交付完成",
  failed: "交付失败",
};

export function isExportActive(status: ExportStatus): boolean {
  return status.status === "pending" || status.status === "running";
}

export function formatDuration(totalSeconds: number): string {
  const rounded = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function itemStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "处理中";
    case "done":
      return "已完成";
    case "failed":
      return "失败";
    default:
      return "等待中";
  }
}

/**
 * 「收藏的整条视频 0 条」但精选段 > 0 时补一句(R10 U-33):有精选段的收藏按片段导出,不再整条
 * remux——池里明明收藏了 1 条,摘要却写 0,用户以为收藏丢了。
 */
export function wholeFavoritesNote(status: ExportStatus): string | null {
  return status.selected_whole_count === 0 && status.selected_segment_count > 0 ? "有精选段的收藏已按片段导出" : null;
}

/** 交付项汇总一行(规格 §4.2 第 2 条):「4 项 · 3 段精选片段 · 1 条收藏的整条视频 · 预计 3:05」。 */
export function summaryLine(status: ExportStatus): string {
  const note = wholeFavoritesNote(status);
  const whole = `${status.selected_whole_count} 条收藏的整条视频${note ? `（${note}）` : ""}`;
  return `${status.selected_count} 项 · ${status.selected_segment_count} 段精选片段 · ${whole} · 预计 ${formatDuration(status.total_duration_seconds)}`;
}

/** 抽屉记住的上次选择(R10 U-20,`ui.deliver.*`)。平台 / 时长为 null = 没记过,走本集默认。 */
export interface RememberedDeliverChoices {
  platform: TargetPlatform | null;
  /** `undefined` = 没记过(按平台预算预选);`null` = 记的是「完整」。 */
  targetSeconds: TargetSecondsOption | undefined;
  includeContactSheet: boolean;
  useJianyingDraft: boolean;
}

export function rememberedDeliverChoices(settings: SettingsMap): RememberedDeliverChoices {
  const platform = readUiSetting(settings, "ui.deliver.platform");
  const target = readUiSetting(settings, "ui.deliver.target_seconds");
  const validTarget = target === "full" ? null : (ROUGH_CUT_TARGET_OPTIONS.find((option) => option !== null && String(option) === target) ?? undefined);
  return {
    platform: (PLATFORM_OPTIONS as readonly string[]).includes(platform) ? (platform as TargetPlatform) : null,
    targetSeconds: target === "" ? undefined : validTarget,
    includeContactSheet: readUiBool(settings, "ui.deliver.contact_sheet"),
    useJianyingDraft: readUiBool(settings, "ui.deliver.jianying_draft"),
  };
}

/** 画布尺寸(U-20):车道 B 在 api 里追加的可选字段 `canvas?: {width,height}`,谁先带上就读谁;都没有就不显示。 */
export interface CanvasSize {
  width: number;
  height: number;
}

export function readCanvas(...sources: ReadonlyArray<unknown>): CanvasSize | null {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const canvas = (source as { canvas?: unknown }).canvas;
    if (!canvas || typeof canvas !== "object") continue;
    const { width, height } = canvas as { width?: unknown; height?: unknown };
    if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
      return { width, height };
    }
  }
  return null;
}

export function canvasLabel(canvas: CanvasSize | null): string | null {
  return canvas ? `${canvas.height > canvas.width ? "竖版" : "横版"} ${canvas.width}×${canvas.height}` : null;
}

/**
 * V14-05:草稿结果卡的内容一句「n 章 · 已带配乐 · m 段」—— 章数来自 `chapter_marks`(素材名前缀,0 = 没分章)、
 * 配乐来自 `has_music`(草稿里有没有音频轨),用户不用打开草稿就知道章节标记与配乐进没进去。
 */
export function draftContentLine(result: Pick<JianyingDraftResult, "chapter_marks" | "has_music" | "selected_count">): string {
  const chapters = result.chapter_marks > 0 ? `${result.chapter_marks} 章(看素材名前缀)` : "没分章";
  return `${chapters} · ${result.has_music ? "已带配乐" : "未带配乐"} · ${result.selected_count} 段`;
}
