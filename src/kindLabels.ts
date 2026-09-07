import type { GlobalSearchHit } from "./api";

/**
 * 全局搜索命中类型 → 中文徽章文案。SidebarSearch 与 CommandPalette 此前
 * 各自维护一份措辞不一致的副本(R6 终审 P2);后端 `kind` 是自由 `String`,
 * 未来新增的取值这里不一定跟得上,调用点必须用 `KIND_LABEL[hit.kind] ?? hit.kind`
 * 兜底,不能让未知 kind 渲染成空徽章。
 */
export const KIND_LABEL: Record<GlobalSearchHit["kind"], string> = {
  file: "文件名",
  transcript: "对白转写",
  description: "AI 描述",
  dimension: "八维标签",
  ocr: "画面文字",
  pinyin: "拼音",
};
