import { analysisBadgeKinds } from "../AnalysisPanel";
import type { ClipListItem, NarrativeChapter, ShotStackMember, Storyboard } from "../api";

/**
 * 检查器的纯函数层(同 Task 2 `poolModel.ts` 的技术)。`activeRatingValue` /
 * `ratingLabelFor` **逐字取自** `SelectPage.tsx` 的私有 `activeRating` / `ratingLabel` ——
 * 那两个函数改成委托到这里,调用点一行不改,`SelectPage.test.tsx` 因此保持绿。
 */
export function activeRatingValue(value: number | null): number | null {
  return value === 0 ? null : value;
}

export function ratingLabelFor(clip: ClipListItem): string {
  const binary = activeRatingValue(clip.binary_rating);
  if (binary === 1) return "收藏";
  if (binary === -1) return "拒绝";
  const star = activeRatingValue(clip.star_rating);
  return star === null ? "未评" : `${star} 星`;
}

/** 技术检查折叠段的状态字用它数「几项提示」——复用 L1 角标的判定,不重新发明一套阈值。 */
export function techCheckIssueCount(clip: ClipListItem): number {
  return analysisBadgeKinds(clip).length;
}

/**
 * 同镜头 Take 列表的显示顺序:真实素材在前,MiniMax 生成物排在后面,组内保持
 * 原有顺序(稳定排序)——`replaceShotStackMemberState` 那一套 hero/locked 排序
 * 是"该用哪条"的业务序,这里只管"人眼看列表该先看见哪条"的展示序,两者互不干扰。
 */
export function sortTakeMembers(
  members: readonly ShotStackMember[],
  clipsById: ReadonlyMap<number, ClipListItem>,
): ShotStackMember[] {
  const isGenerated = (member: ShotStackMember): boolean =>
    Boolean(clipsById.get(member.clip_id)?.generated_source);
  const real = members.filter((member) => !isGenerated(member));
  const generated = members.filter(isGenerated);
  return [...real, ...generated];
}

export interface ClipPlacement {
  chapterId: number;
  chapterTitle: string;
  /** 叙事模式下所属的 beat id;拿到它才能调 `move_beat` 改章节。legacy 模式下为 null。 */
  beatId: number | null;
}

/**
 * 「所属章节 / 槽位」段落要回答的问题:这条素材眼下落在故事板的哪一章。
 * 优先看叙事模式(`storyboard.narrative.chapters[].beats`),那里的 chapter 是
 * 真正参与编排的单位;legacy 模式退回 `storyboard.items[].chapter_id` + `chapters`。
 */
export function findClipPlacement(storyboard: Storyboard | null, clipId: number): ClipPlacement | null {
  if (!storyboard) return null;
  if (storyboard.narrative) {
    for (const chapter of storyboard.narrative.chapters) {
      const beat = chapter.beats.find((candidate) => candidate.clip_id === clipId);
      if (beat) return { chapterId: chapter.id, chapterTitle: chapter.title, beatId: beat.id };
    }
    return null;
  }
  const item = storyboard.items.find((candidate) => candidate.clip_id === clipId && candidate.chapter_id !== null);
  if (!item || item.chapter_id === null) return null;
  const chapter = storyboard.chapters.find((candidate) => candidate.id === item.chapter_id);
  return chapter ? { chapterId: chapter.id, chapterTitle: chapter.title, beatId: null } : null;
}

/** 「改写章节」下拉的候选列表——只有叙事模式的章节能接 `move_beat`。 */
export function narrativeChapterOptions(storyboard: Storyboard | null): readonly NarrativeChapter[] {
  return storyboard?.narrative?.chapters ?? [];
}

export type DefaultSectionId = "rating" | "tags" | "chapter" | "takes";

/**
 * 默认层只渲染有内容的段(规格 §3.8):评级永远在;标签要有标签;章节段要么已归章、
 * 要么可改章(有事可做);Take 段要在 Stack 里。顺序固定 rating → tags → chapter → takes,
 * **不再有「暂无标签」「不属于任何 Take Stack」这类占位句**。
 */
export function visibleDefaultSections(input: {
  tagCount: number;
  hasPlacement: boolean;
  canReassign: boolean;
  hasStack: boolean;
}): DefaultSectionId[] {
  const out: DefaultSectionId[] = ["rating"];
  if (input.tagCount > 0) out.push("tags");
  if (input.hasPlacement || input.canReassign) out.push("chapter");
  if (input.hasStack) out.push("takes");
  return out;
}

/** Take 卡片下那个「08-12」:`captured_at` 的月-日;没有拍摄时间就不显示。 */
export function takeDateLabel(clip: ClipListItem): string | null {
  const match = clip.captured_at?.match(/^\d{4}-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : null;
}

export interface SlotOption {
  key: string;
  label: string;
}

/**
 * 「槽位」下拉的候选:与这条素材同章的故事项,按顺序编成「槽位 01 / 02 / …」;
 * 当前项的 key 就是下拉的 value。改选 = 把自己移到那一格(走镜头带的 planBandReorder)。
 */
export function chapterSlotOptions(storyboard: Storyboard | null, clipId: number): { current: string | null; options: SlotOption[] } {
  const items = storyboard?.items ?? [];
  const self = items.find((item) => item.clip_id === clipId && item.chapter_id !== null);
  if (!self) return { current: null, options: [] };
  const siblings = items
    .filter((item) => item.chapter_id === self.chapter_id)
    .sort((left, right) => (left.position ?? 0) - (right.position ?? 0) || left.key.localeCompare(right.key));
  return {
    current: self.key,
    options: siblings.map((item, index) => ({ key: item.key, label: `槽位 ${String(index + 1).padStart(2, "0")}` })),
  };
}
