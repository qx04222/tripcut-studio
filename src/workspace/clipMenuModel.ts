import { applyBatchRating } from "./batchRating";
import type { RatingAction } from "../SelectPage";
import { reorderStoryItem, storyOrderRefs } from "../Storyboard";
import { getStoryboard, rateClip, revealClip, setStoryOrder, undoStoryChange } from "../api";
import { CLIP_MENU, menuAriaLabel, menuLabelWithCount, type ClipMenuId } from "./copy";
import { requestQuickExport } from "./deliver/quickExportModel";
import { failureText } from "./errorText";
import { clipRemovalTitleFor, requestClipRemoval } from "./clipRemoval";
import type { MenuItem } from "./ui/Menu";
import { showToast } from "./ui/toastStore";
import { pushUndo } from "./undoStack";
import { needsFavoriteBeforeInsert } from "./useBandDrag";
import { getClipsFeedSnapshot, patchClipInFeed, refreshClipsFeed } from "./useClipsFeed";

/**
 * R16 §1 / P1-1(车道 A):素材卡菜单的「项目表」与「动作表」—— 媒体池右键与检查器头部「···」
 * 共用这两张表,所以两处的项目永远一致。多选 = 同一项 + `(n 条)`,动作作用于整组。
 * 「在 Finder 中显示」走车道 C 的 `reveal_clip`(默认接好,`canReveal: false` 才不出这一项);它只显示一条——
 * 多选时是右键点中的那一张(`revealClipId`),所以这一项不带「(n 条)」。
 */
export const CLIP_MENU_ORDER: readonly ClipMenuId[] = ["favorite", "reject", "clear", "addToBand", "export", "reveal", "remove"];

export function clipMenuItems(count: number, options: { readOnly?: boolean; canReveal?: boolean } = {}): MenuItem[] {
  const items: MenuItem[] = [];
  for (const id of CLIP_MENU_ORDER) {
    if (id === "reveal" && options.canReveal === false) continue;
    const label = CLIP_MENU[id];
    const mutating = id !== "export" && id !== "reveal";
    items.push({
      id,
      label: id === "reveal" ? label : menuLabelWithCount(label, count),
      ariaLabel: menuAriaLabel(label),
      disabled: mutating && options.readOnly === true,
    });
  }
  return items;
}




/** 收藏 / 拒绝 / 清除评级作用于整组 —— 与热键同一条路:车道 B 的 `applyBatchRating`(一次 `rate_clips` IPC、
 * 乐观补丁、toast「撤销」回写旧值、⌘Z 栈),这里只做动作名到 RatingAction 的翻译。 */
export async function rateClips(clipIds: readonly number[], action: "favorite" | "reject" | "clear"): Promise<void> {
  const { clipsById } = getClipsFeedSnapshot();
  const ratingAction: RatingAction =
    action === "clear" ? { kind: "clear" } : { kind: "binary", value: action === "favorite" ? 1 : -1 };
  await applyBatchRating(clipIds, ratingAction, clipsById);
}

/**
 * 加入镜头带(整组):与 `useBandDrag.insert` 同一条写入路径(先收藏 → 候选 → 追加到所属章末尾 →
 * `set_story_order`),逐条写;已在带上的跳过。撤销 = 按写入次数调 `undo_story_change`(由调用方推栈)。
 * 返回真正加进去的条数。
 */
export async function addClipsToBand(clipIds: readonly number[]): Promise<{ added: number; skipped: number }> {
  let added = 0;
  let skipped = 0;
  for (const clipId of clipIds) {
    if (needsFavoriteBeforeInsert(getClipsFeedSnapshot().clipsById.get(clipId))) {
      await rateClip(clipId, "binary", 1);
      patchClipInFeed(clipId, { binary_rating: 1 });
    }
    const board = await getStoryboard();
    if (board.items.some((item) => item.clip_id === clipId)) {
      skipped += 1;
      continue;
    }
    const candidate = board.candidates.find((item) => item.clip_id === clipId);
    if (!candidate) {
      skipped += 1;
      continue;
    }
    await setStoryOrder(storyOrderRefs(reorderStoryItem(board.chapters, board.items, candidate, null)));
    added += 1;
  }
  return { added, skipped };
}

export interface ClipMenuContext {
  readOnly?: boolean;
  /** 传 false 才不出「在 Finder 中显示」(默认出)。 */
  canReveal?: boolean;
  /** 「在 Finder 中显示」的实现;默认 `reveal_clip`(测试可换)。 */
  onReveal?: (clipId: number) => Promise<void>;
  /** 多选时要显示的那一张(右键点中的);不传取整组第一条。 */
  revealClipId?: number;
  /** 缺失页传「移除这个盘上的素材」这类标题;不传按默认。 */
  removalTitle?: string;
}

/** 菜单项 → 动作。所有失败都 toast,不抛。 */
export async function runClipMenuAction(id: string, clipIds: readonly number[], context: ClipMenuContext = {}): Promise<void> {
  if (clipIds.length === 0) return;
  const count = clipIds.length;
  try {
    switch (id as ClipMenuId) {
      case "favorite":
      case "reject":
      case "clear":
        await rateClips(clipIds, id as "favorite" | "reject" | "clear");
        return;
      case "addToBand": {
        const { added, skipped } = await addClipsToBand(clipIds);
        if (added > 0) {
          pushUndo({
            label: `加入镜头带${count > 1 ? `(${added} 条)` : ""}`,
            undo: async () => {
              for (let index = 0; index < added; index += 1) await undoStoryChange();
              await refreshClipsFeed(true);
            },
          });
        }
        await refreshClipsFeed(true);
        showToast(added === 0 ? "这些素材已经在镜头带上了" : skipped > 0 ? `已加入 ${added} 条,${skipped} 条本来就在带上` : count > 1 ? `已加入镜头带 ${added} 条` : "已加入镜头带", {
          tone: added > 0 ? "success" : "neutral",
        });
        return;
      }
      case "export":
        requestQuickExport({ clip_ids: [...clipIds] });
        return;
      case "reveal": {
        const target = context.revealClipId !== undefined && clipIds.includes(context.revealClipId) ? context.revealClipId : clipIds[0]!;
        await (context.onReveal ?? revealClip)(target);
        return;
      }
      case "remove":
        await requestClipRemoval(clipIds, { title: context.removalTitle ?? clipRemovalTitleFor(count) });
        return;
    }
  } catch (error) {
    showToast(failureText(menuAriaLabel(CLIP_MENU[id as ClipMenuId] ?? "操作"), error), { tone: "danger" });
  }
}
