import type { DeviceClockSetting, LlmLedgerEntry } from "../../api";
import type { IconName } from "../ui/icons";
import type { SettingsSectionId } from "../../settingsSections";

/**
 * 设置 sheet 的纯逻辑与文案表。函数体逐字复制自 `src/SettingsPage.tsx`(旧壳 R10 删,
 * 本轮车道规则不许改它,所以这里是"复制 + 对等测试"而不是"搬走 + re-export";
 * `settingsModel.test.ts` 用旧文件的导出做对照,两边漂移即红)。
 */

/** 与后端 `settings::MINIMAX_MONTHLY_BUDGET_MAX` 保持一致——超出即被夹住。 */
export const MINIMAX_MONTHLY_BUDGET_MAX = 500;

export const MINIMAX_MODEL_RESOLUTIONS: Record<string, readonly string[]> = {
  "MiniMax-H3-Max": ["480P", "768P"],
  "MiniMax-H3": ["768P", "2K"],
};

export interface SettingsTab {
  id: SettingsSectionId;
  label: string;
  description: string;
  icon: IconName;
  danger?: boolean;
}

/** 左侧分区轨的九项(文案沿用 `SETTINGS_SECTIONS` 的 label / description,不渲染 eyebrow)。 */
export const SETTINGS_TABS: readonly SettingsTab[] = [
  { id: "appearance", label: "外观", description: "主题与阅读尺度", icon: "settings-appearance" },
  { id: "performance", label: "性能", description: "并发与代理文件", icon: "settings-performance" },
  { id: "timeline", label: "旅行时间", description: "多设备时钟校正", icon: "settings-timeline" },
  { id: "tools", label: "工具链", description: "本地依赖与模型", icon: "settings-tools" },
  { id: "analysis", label: "分析与 AI", description: "阈值、预算与隐私", icon: "settings-analysis" },
  { id: "generation", label: "云端补镜", description: "API Key、预算与生成账本", icon: "settings-generation" },
  { id: "privacy", label: "隐私与诊断", description: "本地优先、诊断日志与崩溃报告", icon: "settings-privacy" },
  { id: "about", label: "帮助与关于", description: "指南、版本与许可", icon: "settings-about" },
  { id: "cache", label: "缓存与重建", description: "可重建数据管理", icon: "settings-cache", danger: true },
] as const;

export function llmLedgerStatusLabel(status: LlmLedgerEntry["status"]): string {
  switch (status) {
    case "running":
      return "调用中";
    case "succeeded":
      return "已成功";
    case "failed":
      return "调用失败";
    case "parse_failed":
      return "解析失败";
  }
}

export function generationLedgerStatusLabel(status: string): string {
  switch (status) {
    case "draft": return "草稿";
    case "submitted": return "已提交";
    case "queued": return "排队中";
    case "succeeded": return "生成成功";
    case "failed": return "失败";
    case "cancelled": return "已取消";
    case "imported": return "已入库";
    default: return status;
  }
}

export function llmLedgerPurposeLabel(purpose: string): string {
  switch (purpose) {
    case "ai_description":
      return "AI 描述";
    case "director_qa":
      return "导演问答";
    case "narrate_episode":
      return "叙事编排";
    default:
      return purpose;
  }
}

/** 月度预算写入前的夹紧——与后端 `clamp_minimax_monthly_budget` 保持同一上限,
 * 便于在 `onBlur` 阶段就告诉用户"被夹住了",而不是等一次往返后才发现。 */
export function clampMinimaxBudgetInput(raw: string): { value: number; clamped: boolean } {
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    // 非法输入(空字符串/非数字)一律当成"需要被纠正"处理,落到 0——宁可保守地
    // 拒绝，也不让无效输入悄悄绕过预算闸。
    return { value: 0, clamped: true };
  }
  const clampedValue = Math.min(Math.max(parsed, 0), MINIMAX_MONTHLY_BUDGET_MAX);
  return { value: clampedValue, clamped: clampedValue !== parsed };
}

export function clockSourceLabel(source: DeviceClockSetting["source"]): string {
  switch (source) {
    case "manual": return "人工校正";
    case "auto": return "高置信自动对齐";
    case "reference": return "参考设备";
    default: return "待校正";
  }
}

export function bytesLabel(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_024;
  let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

export type NoticeTone = "info" | "ok" | "warn";

/** 页脚状态行的图标语气:失败/拒绝类文案 → warning;已保存/已释放/已回滚 → check;其余 info。 */
export function noticeTone(notice: string): NoticeTone {
  if (/失败|不能|必须|尚未载入|请先|请再次/.test(notice)) return "warn";
  if (/^已保存|^已释放|已回滚|已重新排序|已在访达/.test(notice)) return "ok";
  return "info";
}
