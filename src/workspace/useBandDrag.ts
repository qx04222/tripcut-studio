import { useCallback, useRef, useState } from "react";

import {
  flattenStoryByChapter,
  itemChapterKey,
  moveStoryItemWithinChapter,
  reorderStoryItem,
  storyOrderRefs,
} from "../Storyboard";
import {
  getStoryboard,
  rateClip,
  setStoryOrder,
  undoStoryChange,
  type Chapter,
  type ClipListItem,
  type StoryItem,
  type Storyboard,
} from "../api";
import { getClipsFeedSnapshot, refreshClipsFeed } from "./useClipsFeed";
import { failureText } from "./errorText";

/**
 * 镜头带拖排的写入路径(规格 §3.3)。顺序计算是纯函数,组件只负责把两个 key 交进来 ——
 * dnd-kit 的指针物理在 jsdom 里量不出矩形,唯一能被测试真正盯住的就是这一段。
 */

export type BandReorderPlan =
  | { kind: "reorder"; items: StoryItem[] }
  /**
   * 跨章节落点。`set_story_order` 只写顺序,**不写章节归属**
   * (`src-tauri/src/core/story.rs:600` 只更新 story_order 表),章节是按素材
   * 拍摄时间派生的 —— 所以这里沿用 `Storyboard.tsx:966` 的既有语义:拒绝并给
   * 中文提示,而不是假装改了章节然后被下一轮轮询打回原形。
   */
  | { kind: "cross-chapter" }
  | null;

/** 空槽位卡片的 key 前缀(见 `shotBandModel.buildBandChapters`)。 */
export const SLOT_KEY_PREFIX = "slot:";

export const CROSS_CHAPTER_NOTICE = "镜头仍归属原章节；请先合并章节再跨章排序";
export const REORDER_TOAST = "已调整顺序";
export const ALREADY_ON_BAND_NOTICE = "这条素材已经在镜头带上";

/**
 * 「加入当前章节」(R10 U-18)松手后的提示。章节是按拍摄时间派生的(`clips.chapter_id`),
 * 所以素材落在**它自己**的那一章 —— 提示里把章名说出来,别让用户以为它去了别处;
 * 没收藏过的素材会先被收藏(故事板只认收藏/精选),这一步也要说明(与 U-11 同一条纪律)。
 */
export function insertNotice(chapters: readonly Chapter[], item: StoryItem, favorited: boolean): string {
  const index = chapters.findIndex((chapter) => chapter.id === item.chapter_id);
  const where = index >= 0 ? `第 ${index + 1} 章「${chapters[index]!.title}」` : "镜头带(未分章)";
  return `已加入${where}${favorited ? "，并已自动收藏整条" : ""}`;
}

/** 加入镜头带前要不要先收藏:故事板(`get_storyboard`)只认收藏或有精选段的素材。 */
export function needsFavoriteBeforeInsert(clip: ClipListItem | undefined): boolean {
  if (!clip) return false;
  return clip.binary_rating !== 1 && clip.select_count === 0;
}

/** 把 activeKey 移到 overKey 所在的位次(与 dnd-kit sortable 的落点语义一致)。 */
export function planBandReorder(
  board: Storyboard,
  activeKey: string,
  overKey: string,
): BandReorderPlan {
  if (activeKey === overKey) return null;
  // 空槽位不是顺序表里的一行(`slot:{chapterId}:{slot}` 只活在前端),往它上面
  // 落什么都写不进去。以前这条路径 `to < 0` 直接 return null —— 松手后一点反馈
  // 都没有,和「拖成功了」长得一模一样。拒绝要说出来,用与跨章同一条提示。
  if (activeKey.startsWith(SLOT_KEY_PREFIX) || overKey.startsWith(SLOT_KEY_PREFIX)) {
    return { kind: "cross-chapter" };
  }
  const ordered = flattenStoryByChapter(board.chapters, board.items);
  const from = ordered.findIndex((item) => item.key === activeKey);
  const to = ordered.findIndex((item) => item.key === overKey);
  if (from < 0 || to < 0) return null;
  if (itemChapterKey(ordered[from]!) !== itemChapterKey(ordered[to]!)) return { kind: "cross-chapter" };
  const next = [...ordered];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return { kind: "reorder", items: next.map((item, position) => ({ ...item, position })) };
}

/** ←→ 的一步前后移:与故事板的「上移/下移」同一个纯函数,章内不越界。 */
export function planBandStep(
  board: Storyboard,
  itemKey: string,
  direction: -1 | 1,
): BandReorderPlan {
  const next = moveStoryItemWithinChapter(board.chapters, board.items, itemKey, direction);
  return next === board.items ? null : { kind: "reorder", items: next };
}

export interface BandDragState {
  /** 乐观顺序:写入进行中时盖住 feed 里的旧顺序,失败即丢弃回退。 */
  optimisticItems: readonly StoryItem[] | null;
  notice: string | null;
  /** 松手后的 toast:有值时显示「已调整顺序 · 撤销」。 */
  undoable: boolean;
  busy: boolean;
  /** 拖动中指针眼下压着的分段 key(dnd-kit 的 `over`);松手 / 取消即回 null。插入线按它画。 */
  overKey: string | null;
  setOverKey(key: string | null): void;
  apply(plan: BandReorderPlan): void;
  /**
   * 不靠拖拽的第二条路(R10 U-18):把媒体池里的一条素材追加到它所属章节的末尾。
   * 写入路径与拖排同一条(`reorderStoryItem` → `set_story_order`),所以同样可撤销。
   */
  insert(clipId: number): void;
  undo(): void;
  dismissNotice(): void;
}

export function useBandDrag(board: Storyboard | null): BandDragState {
  const [optimisticItems, setOptimisticItems] = useState<readonly StoryItem[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [undoable, setUndoable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [overKey, setOverKey] = useState<string | null>(null);
  const busyRef = useRef(false);

  const apply = useCallback(
    (plan: BandReorderPlan) => {
      if (plan === null || board === null) return;
      if (plan.kind === "cross-chapter") {
        setNotice(CROSS_CHAPTER_NOTICE);
        setUndoable(false);
        return;
      }
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setOptimisticItems(plan.items);
      void (async () => {
        try {
          await setStoryOrder(storyOrderRefs(plan.items));
          setNotice(REORDER_TOAST);
          setUndoable(true);
          await refreshClipsFeed(true);
          // 拉回权威顺序后必须把乐观值让开,否则它会永久盖住后续每一轮轮询。
          setOptimisticItems(null);
        } catch (error) {
          // 乐观顺序必须丢掉 —— 留着会让界面显示一个库里并不存在的排列。
          setOptimisticItems(null);
          setUndoable(false);
          setNotice(failureText("调整顺序", error));
        } finally {
          busyRef.current = false;
          setBusy(false);
        }
      })();
    },
    [board],
  );

  const insert = useCallback(
    (clipId: number) => {
      if (board === null || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      void (async () => {
        try {
          let favorited = false;
          if (needsFavoriteBeforeInsert(getClipsFeedSnapshot().clipsById.get(clipId))) {
            await rateClip(clipId, "binary", 1);
            favorited = true;
          }
          // 收藏之后候选表才有它;直接重取一份故事板,不等轮询(轮询在飞时 refresh 会被合并掉)。
          const latest = favorited ? await getStoryboard() : board;
          if (latest.items.some((item) => item.clip_id === clipId)) {
            setNotice(ALREADY_ON_BAND_NOTICE);
            setUndoable(false);
            return;
          }
          const candidate = latest.candidates.find((item) => item.clip_id === clipId);
          if (!candidate) throw new Error("素材还不在候选里；先在媒体池收藏它");
          const next = reorderStoryItem(latest.chapters, latest.items, candidate, null);
          await setStoryOrder(storyOrderRefs(next));
          setNotice(insertNotice(latest.chapters, candidate, favorited));
          setUndoable(true);
          await refreshClipsFeed(true);
        } catch (error) {
          setUndoable(false);
          setNotice(failureText("加入镜头带", error));
        } finally {
          busyRef.current = false;
          setBusy(false);
        }
      })();
    },
    [board],
  );

  const undo = useCallback(() => {
    void (async () => {
      try {
        await undoStoryChange();
        setOptimisticItems(null);
        setUndoable(false);
        setNotice("已撤销最近一次顺序调整");
        await refreshClipsFeed(true);
      } catch (error) {
        setNotice(failureText("撤销", error));
      }
    })();
  }, []);

  const dismissNotice = useCallback(() => {
    setNotice(null);
    setUndoable(false);
  }, []);

  return { optimisticItems, notice, undoable, busy, overKey, setOverKey, apply, insert, undo, dismissNotice };
}
