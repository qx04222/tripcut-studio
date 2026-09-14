import { applyBatchRating } from "./batchRating";
import { RATING_MENU_ITEMS, withCount } from "./copy";
import type { MenuItem } from "./ui/Menu";
import { getClipsFeedSnapshot } from "./useClipsFeed";

/**
 * R16 车道 B P1-5:素材卡菜单里的三项 —— 收藏 · 拒绝 · 清除评级(多选时带「(n 条)」)。
 * 菜单本体在 `deliver/QuickExportEntry.tsx`(车道 A 追加它的其它项),这里只给项与处理函数,不重排菜单。
 */
export const POOL_RATING_MENU_IDS = ["favorite", "reject", "clear-rating"] as const;

export function poolRatingMenuItems(count: number): MenuItem[] {
  return [
    { id: "favorite", label: withCount(RATING_MENU_ITEMS.favorite, count), ariaLabel: RATING_MENU_ITEMS.favorite },
    { id: "reject", label: withCount(RATING_MENU_ITEMS.reject, count), ariaLabel: RATING_MENU_ITEMS.reject },
    { id: "clear-rating", label: withCount(RATING_MENU_ITEMS.clear, count), ariaLabel: RATING_MENU_ITEMS.clear },
  ];
}

/** 是这三项之一就执行并返回 true;不是返回 false 让菜单的其它项接手。 */
export function runPoolRatingMenuItem(id: string, clipIds: readonly number[]): boolean {
  const clipsById = getClipsFeedSnapshot().clipsById;
  if (id === "favorite") void applyBatchRating(clipIds, { kind: "binary", value: 1 }, clipsById);
  else if (id === "reject") void applyBatchRating(clipIds, { kind: "binary", value: -1 }, clipsById);
  else if (id === "clear-rating") void applyBatchRating(clipIds, { kind: "clear" }, clipsById);
  else return false;
  return true;
}
