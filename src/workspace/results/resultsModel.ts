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

/** 一行的理由句:「清晰 · 运动适中 · 有人声」;后端保证非空,空时兜底说「这一段分数最高」。 */
export function reasonText(reasons: readonly string[]): string {
  return reasons.length > 0 ? reasons.join(" · ") : "这一段分数最高";
}

/** 0–1 的分数 → 「86 分」。 */
export function scoreLabel(score: number): string {
  return `${Math.round(Math.min(1, Math.max(0, score)) * 100)} 分`;
}

/** 兄弟段折叠行的标题:「还有 2 条相似的没选」。 */
export function siblingsLabel(count: number): string {
  return `还有 ${count} 条相似的没选`;
}

/** 面板顶部的一句:「6 段 · 共 44.6 s」。 */
export function summaryText(rows: readonly AutoSelectRunRow[]): string {
  const total = rows.reduce((sum, row) => sum + row.secs, 0);
  return `${rows.length} 段 · 共 ${formatSecs(total)}`;
}

/** 面板顶部第二句:这批是怎么挑的(原句优先;没原句就说范围 + 挑法)。 */
export function paramsText(view: Pick<AutoSelectRunView, "params">): string {
  const { prompt, scope, pick, budget_secs } = view.params;
  if (prompt && prompt.trim().length > 0) return `「${prompt.trim()}」`;
  const scopeText = scope === "all" ? "全部素材" : scope === "favorites" ? "只看收藏" : scope === "rated3" ? "3 星以上" : "收藏 + 3 星以上";
  const pickText = pick === "score" ? "按分数" : "按时间顺序";
  const budget = budget_secs && budget_secs > 0 ? ` · 约 ${Math.round(budget_secs)} 秒` : "";
  return `${scopeText} · ${pickText}${budget}`;
}
