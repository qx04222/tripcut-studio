import { rateClips, type ClipListItem, type ClipRatingEntry } from "../api";
import type { RatingAction } from "../SelectPage";
import { failureText } from "./errorText";
import { showToast } from "./ui/Toast";
import { pushUndo } from "./undoBridge";
import { ratingPatch } from "./useBandTakes";
import { patchClipInFeed, refreshClipsFeed } from "./useClipsFeed";

/**
 * R16 车道 B P1-5:多选批量评级。热键(F/X/1–5/0)与卡片菜单三项都走 `applyBatchRating`:
 * 先按 feed 里的旧值记一份,乐观补丁,一次 `rate_clips`;成功 toast「已对 n 条…」+ 5 秒「撤销」
 * (回写旧值,同一闭包也推进 ⌘Z 栈,只跑一次);失败 toast 说清并整体重取把乐观补丁冲掉。
 */

/** 「撤销」停留 5 秒(与镜头带的可撤销提示一致)。 */
export const BATCH_UNDO_MS = 5_000;

export interface RatingBefore {
  clip_id: number;
  binary_rating: number | null;
  star_rating: number | null;
}

/** 一次动作展开成 `rate_clips` 的条目;清除 = 每条两维各写 0(与 `clear_clip_rating` 同一种标记)。 */
export function batchRatingEntries(clipIds: readonly number[], action: RatingAction): ClipRatingEntry[] {
  return clipIds.flatMap((clip_id): ClipRatingEntry[] => {
    if (action.kind === "clear") {
      return [
        { clip_id, rating_type: "binary", value: 0 },
        { clip_id, rating_type: "star", value: 0 },
      ];
    }
    return [{ clip_id, rating_type: action.kind === "binary" ? "binary" : "star", value: action.value }];
  });
}

/** 撤销回写:两维都按旧值写回;没评过(null)写 0。 */
export function restoreEntries(before: readonly RatingBefore[]): ClipRatingEntry[] {
  return before.flatMap((item): ClipRatingEntry[] => [
    { clip_id: item.clip_id, rating_type: "binary", value: item.binary_rating ?? 0 },
    { clip_id: item.clip_id, rating_type: "star", value: item.star_rating ?? 0 },
  ]);
}

export function ratingVerb(action: RatingAction): string {
  if (action.kind === "clear") return "清除评级";
  if (action.kind === "binary") return action.value > 0 ? "收藏" : "拒绝";
  return `打 ${action.value} 星`;
}

export function batchRatingToast(count: number, action: RatingAction): string {
  return `已对 ${count} 条${ratingVerb(action)}`;
}

export async function applyBatchRating(
  clipIds: readonly number[],
  action: RatingAction,
  clipsById: ReadonlyMap<number, ClipListItem>,
): Promise<void> {
  const ids = clipIds.filter((id) => clipsById.has(id));
  if (ids.length === 0) return;
  const before: RatingBefore[] = ids.map((clip_id) => {
    const clip = clipsById.get(clip_id)!;
    return { clip_id, binary_rating: clip.binary_rating ?? null, star_rating: clip.star_rating ?? null };
  });
  const patch = ratingPatch(action);
  for (const id of ids) patchClipInFeed(id, patch);
  try {
    await rateClips(batchRatingEntries(ids, action));
  } catch (error) {
    showToast(failureText("批量评级", error), { tone: "danger" });
    await refreshClipsFeed(true);
    return;
  }
  let undone = false;
  const undo = async () => {
    if (undone) return;
    undone = true;
    for (const item of before) patchClipInFeed(item.clip_id, { binary_rating: item.binary_rating, star_rating: item.star_rating } as Partial<ClipListItem>);
    try {
      await rateClips(restoreEntries(before));
      showToast(`已撤销对 ${ids.length} 条的${ratingVerb(action)}`, { tone: "neutral" });
    } catch (error) {
      showToast(failureText("撤销", error), { tone: "danger" });
    }
    await refreshClipsFeed(true);
  };
  showToast(batchRatingToast(ids.length, action), {
    tone: "success",
    durationMs: BATCH_UNDO_MS,
    action: { label: "撤销", onClick: () => void undo() },
  });
  pushUndo(`${ratingVerb(action)}(${ids.length} 条)`, undo);
  await refreshClipsFeed(true);
}
