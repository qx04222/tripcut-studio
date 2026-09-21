import type { AutoSelectRunRow, AutoSelectRunView, ClipListItem } from "../../api";

/**
 * R19 P-03「为什么是这些」结果面板的纯函数:文案与数字都在这里,组件只负责摆。
 * 理由来自 `segments.reason_json`(R18 写的白话短语),这里不再翻译任何内部键。
 */

/** 「5.0 s」。 */
export function formatSecs(secs: number): string {
  return `${(Math.round(secs * 10) / 10).toFixed(1)} s`;
}

/** 素材显示名:文件名去扩展名;找不到素材(feed 还没刷到)就用编号。 */
export function clipName(clip: Partial<Pick<ClipListItem, "file_name">> | undefined, clipId: number): string {
  if (typeof clip?.file_name !== "string" || clip.file_name.length === 0) return `素材 ${clipId}`;
  return clip.file_name.replace(/\.[^.]+$/, "");
}

export type ResultsMode = "video" | "photo";

/** 一行的理由句;空理由按工作台使用对应的段/照片称呼。 */
export function reasonText(reasons: readonly string[], mode: ResultsMode = "video"): string {
  return reasons.length > 0 ? reasons.join(" · ") : mode === "photo" ? "这张照片分数最高" : "这一段分数最高";
}

/** 0–1 的分数 → 「86 分」。 */
export function scoreLabel(score: number): string {
  return `${Math.round(Math.min(1, Math.max(0, score)) * 100)} 分`;
}

/** 相似候选折叠行的标题。 */
export function siblingsLabel(count: number, mode: ResultsMode = "video"): string {
  return `还有 ${count} ${mode === "photo" ? "张" : "条"}相似的没选`;
}

/** 面板顶部的一句;照片没有播放时长，只报张数。 */
export function summaryText(rows: readonly AutoSelectRunRow[], mode: ResultsMode = "video"): string {
  if (mode === "photo") return `${rows.length} 张`;
  const total = rows.reduce((sum, row) => sum + row.secs, 0);
  return `${rows.length} 段 · 共 ${formatSecs(total)}`;
}

/** 面板顶部第二句:这批是怎么挑的(原句优先;没原句就说范围 + 挑法)。 */
export function paramsText(view: Pick<AutoSelectRunView, "params">, mode: ResultsMode = "video"): string {
  const { prompt, scope, pick, budget_secs } = view.params;
  if (prompt && prompt.trim().length > 0) return `「${prompt.trim()}」`;
  const scopeText = scope === "all" ? "全部素材" : scope === "favorites" ? "只看收藏" : scope === "rated3" ? "3 星以上" : "收藏 + 3 星以上";
  const pickText = pick === "score" ? "按分数" : "按时间顺序";
  const budget = mode === "video" && budget_secs && budget_secs > 0 ? ` · 约 ${Math.round(budget_secs)} 秒` : "";
  return `${scopeText} · ${pickText}${budget}`;
}


/** 与后端 smart_select_reason 中文表一致,未知标签不透出内部键。 */
export const QUALITY_LABELS: Readonly<Record<string, string>> = {
  exposure_bright: "曝光偏亮", exposure_dark: "曝光偏暗", slight_shake: "轻微手抖",
  bystander: "路人入镜", color_cast: "色偏", defocus: "失焦",
  excessive_shake: "抖动过大", bad_timing: "时机差", high_contrast: "大光比",
};
export function qualityText(values: readonly string[] | undefined, prefix: string): string {
  const known = Object.values(QUALITY_LABELS);
  const labels = [...new Set((values ?? []).flatMap((value) => QUALITY_LABELS[value] ? [QUALITY_LABELS[value]!] : known.includes(value) ? [value] : []))];
  return labels.length ? `${prefix}:${labels.join("、")}` : "";
}
