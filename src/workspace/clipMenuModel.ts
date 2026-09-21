import { applyBatchRating } from "./batchRating";
import type { RatingAction } from "../SelectPage";
import { reorderStoryItem, storyOrderRefs } from "../Storyboard";
import { getStoryboard, moveClipsToEpisode, rateClip, revealClip, setStoryOrder, type EpisodeSummary } from "../api";
import {
  CLIP_MENU,
  EPISODE_MOVE_NEEDS_ANOTHER_EPISODE,
  EPISODE_MOVE_NOTHING_MOVED_TOAST,
  EPISODES_UPDATED_EVENT,
  episodeMoveUndoneToast,
  episodeMovedToast,
  menuAriaLabel,
  menuLabelWithCount,
  type ClipMenuId,
} from "./copy";
import { requestQuickExport } from "./deliver/quickExportModel";
import { failureText } from "./errorText";
import { clipRemovalTitleFor, requestClipRemoval } from "./clipRemoval";
import type { MenuItem } from "./ui/Menu";
import { noteStoryUndoSkipped, undoStoryChangeNoticing } from "./storyUndo";
import { showToast } from "./ui/toastStore";
import { pushUndo as pushUndoBridge } from "./undoBridge";
import { pushUndo } from "./undoStack";
import { needsFavoriteBeforeInsert } from "./useBandDrag";
import { getClipsFeedSnapshot, patchClipInFeed, refreshClipsFeed } from "./useClipsFeed";
import { dispatchWorkspace, getWorkspaceSnapshot } from "./WorkspaceStore";

/**
 * R16 §1 / P1-1(车道 A):素材卡菜单的「项目表」与「动作表」—— 媒体池右键与检查器头部「···」
 * 共用这两张表,所以两处的项目永远一致。多选 = 同一项 + `(n 条)`,动作作用于整组。
 * 「在 Finder 中显示」走车道 C 的 `reveal_clip`(默认接好,`canReveal: false` 才不出这一项);它只显示一条——
 * 多选时是右键点中的那一张(`revealClipId`),所以这一项不带「(n 条)」。
 */
export const CLIP_MENU_ORDER: readonly ClipMenuId[] = ["favorite", "reject", "clear", "addToBand", "moveToEpisode", "export", "reveal", "remove"];

export interface ClipMenuOptions {
  readOnly?: boolean;
  canReveal?: boolean;
  /** 照片检查器不提供视频镜头带动作；底层动作仍会再次校验素材类型。 */
  canAddToBand?: boolean;
  /** R17 epmove:库里一共几集。恰好一集时「移到其他集…」禁用并说明先去首页新建一集;不传 / 读不到(0)按「有别的集」处理。 */
  episodeCount?: number;
}

export function clipMenuItems(count: number, options: ClipMenuOptions = {}): MenuItem[] {
  const items: MenuItem[] = [];
  for (const id of CLIP_MENU_ORDER) {
    if (id === "reveal" && options.canReveal === false) continue;
    if (id === "addToBand" && options.canAddToBand === false) continue;
    const label = CLIP_MENU[id];
    const mutating = id !== "export" && id !== "reveal";
    const alone = id === "moveToEpisode" && options.episodeCount === 1;
    items.push({
      id,
      label: alone ? `${menuLabelWithCount(label, count)}(${EPISODE_MOVE_NEEDS_ANOTHER_EPISODE})` : id === "reveal" ? label : menuLabelWithCount(label, count),
      ariaLabel: menuAriaLabel(label),
      disabled: (mutating && options.readOnly === true) || alone,
    });
  }
  return items;
}

/**
 * R17 epmove:把整组素材移到 `target` 集。一次 `move_clips_to_episode` IPC;成功后媒体池里那几条立刻消失
 * (feed 按集裁,改 `episode_id` 即可)、指向它们的选择清掉、集卡计数事件派发;toast「已把 n 条移到「集名」」
 * 带「撤销」5 秒,同一闭包进 ⌘Z 栈 —— 撤销按每条的旧归属分组反向再调(一次移动可能来自多个集)。失败 toast,不推栈。
 */
export async function moveClipsToOtherEpisode(clipIds: readonly number[], target: EpisodeSummary): Promise<void> {
  if (clipIds.length === 0) return;
  let outcome;
  try {
    outcome = await moveClipsToEpisode(clipIds, target.id);
  } catch (error) {
    showToast(failureText(menuAriaLabel(CLIP_MENU.moveToEpisode), error), { tone: "danger" });
    return;
  }
  if (outcome.from.length === 0) {
    showToast(EPISODE_MOVE_NOTHING_MOVED_TOAST, { tone: "neutral" });
    return;
  }
  const movedIds = outcome.from.map(([clipId]) => clipId);
  const rehome = (ids: readonly number[], episodeId: number) => {
    for (const id of ids) patchClipInFeed(id, { episode_id: episodeId });
    const { selection, multiSelection } = getWorkspaceSnapshot();
    if ((selection?.kind === "clip" && ids.includes(selection.clipId)) || multiSelection.some((id) => ids.includes(id))) {
      dispatchWorkspace({ type: "clear-selection" });
    }
    window.dispatchEvent(new CustomEvent(EPISODES_UPDATED_EVENT));
  };
  rehome(movedIds, target.id);
  let undone = false;
  const undo = async () => {
    if (undone) return;
    undone = true;
    const byOrigin = new Map<number, number[]>();
    for (const [clipId, origin] of outcome.from) byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), clipId]);
    try {
      for (const [origin, ids] of byOrigin) {
        await moveClipsToEpisode(ids, origin);
        rehome(ids, origin);
      }
      showToast(episodeMoveUndoneToast(movedIds.length), { tone: "neutral" });
    } catch (error) {
      showToast(failureText("撤销", error), { tone: "danger" });
    }
    await refreshClipsFeed(true);
  };
  showToast(episodeMovedToast(movedIds.length, target.title), {
    tone: "success",
    durationMs: 5_000,
    action: { label: "撤销", onClick: () => void undo() },
  });
  pushUndoBridge(`${menuAriaLabel(CLIP_MENU.moveToEpisode)}(${movedIds.length} 条)`, undo);
  await refreshClipsFeed(true);
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
    const clip = getClipsFeedSnapshot().clipsById.get(clipId);
    if (clip?.kind !== "video") {
      skipped += 1;
      continue;
    }
    if (needsFavoriteBeforeInsert(clip)) {
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
  canAddToBand?: boolean;
  /** 传 false 才不出「在 Finder 中显示」(默认出)。 */
  canReveal?: boolean;
  /** 「在 Finder 中显示」的实现;默认 `reveal_clip`(测试可换)。 */
  onReveal?: (clipId: number) => Promise<void>;
  /** 多选时要显示的那一张(右键点中的);不传取整组第一条。 */
  revealClipId?: number;
  /** 缺失页传「移除这个盘上的素材」这类标题;不传按默认。 */
  removalTitle?: string;
  /** R17 epmove:「移到其他集…」要弹目标集菜单,由入口(ClipMenu)接管;不传就没有后半步。 */
  onMoveToEpisode?: (clipIds: readonly number[]) => void;
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
              let skipped = 0;
              for (let index = 0; index < added; index += 1) skipped += await undoStoryChangeNoticing();
              // 逐条撤时每次都会覆盖后缀,最后按总数留一份。
              if (skipped > 0) noteStoryUndoSkipped(skipped);
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
      case "moveToEpisode":
        context.onMoveToEpisode?.(clipIds);
        return;
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
