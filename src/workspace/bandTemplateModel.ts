import type { ClipListItem, StoryItem, StoryOrderRef, Storyboard } from "../api";

/**
 * 镜头带的模板 / 候选池纯函数层(R10 U-03 / U-17 / U-18),从 `shotBandModel.ts` 拆出来
 * (那份已到 400 行上限)。组件只负责画;这里的每条规则都有 `shotBandModelR10.test.ts` 盯着。
 */

/**
 * 模板套用的候选池(R10 U-03,规格 §1):收藏 ∪ ≥3 星;拒绝的不算。这是**前端**对
 * 「哪些素材会被模板吃进去」的判定,用于套用前的提示与 0 镜时的解释。后端
 * `narrative::load_prompt_clips` 眼下只认「收藏 ∪ 有精选段」——≥3 星那一份要等 Rust 跟上
 * (见车道 D 报告);在那之前只有 ≥3 星的池会被后端拒绝,前端把后端的话原样给用户。
 */
export const TEMPLATE_POOL_RULE = "收藏或 ≥3 星";

export function isTemplateCandidate(clip: ClipListItem): boolean {
  if (clip.kind !== "video") return false;
  if (clip.binary_rating === -1) return false;
  if (clip.binary_rating === 1 || clip.select_count > 0) return true;
  return (clip.star_rating ?? 0) >= 3;
}

/** 媒体池里能进镜头带的素材:候选池规则同上,再去掉已经在带上的。 */
export function bandPickerCandidates(
  clips: readonly ClipListItem[],
  board: Storyboard | null,
): ClipListItem[] {
  const placed = new Set((board?.items ?? []).map((item) => item.clip_id));
  return clips.filter((clip) => clip.id !== null && clip.status === "ready" && !placed.has(clip.id) && isTemplateCandidate(clip));
}

/**
 * 模板套用(LLM 关闭时的确定性兜底)只写 narrative_revisions/beats,不写 story_order;
 * 镜头带画的是 story_order,所以套完模板带上仍是 0 镜(09-13 走查 U-03 的直接现象)。
 * 把 beats 的顺序换算成 `set_story_order` 的引用列表,套用后写一次——走的是拖排
 * 同一条写入路径,可撤销。beats 为空时返回空数组,调用方据此给「0 镜」的解释。
 */
export function narrativeStoryOrder(board: Storyboard | null, clips: readonly ClipListItem[]): StoryOrderRef[] {
  const chapters = [...(board?.narrative?.chapters ?? [])].sort((left, right) => left.order - right.order);
  const videoIds = new Set(clips.filter((clip) => clip.kind === "video" && clip.id !== null).map((clip) => clip.id));
  const seen = new Set<string>();
  const refs: StoryOrderRef[] = [];
  for (const chapter of chapters) {
    for (const beat of [...chapter.beats].sort((left, right) => left.order - right.order)) {
      if (!videoIds.has(beat.clip_id)) continue;
      const key = beat.segment_id === null ? `whole:${beat.clip_id}` : `segment:${beat.segment_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({
        item_kind: beat.segment_id === null ? "whole" : "segment",
        clip_id: beat.clip_id,
        segment_id: beat.segment_id,
      });
    }
  }
  return refs;
}

/** 两份顺序是否已经一致(一致就不再写一次 story_order,免得白留一条撤销记录)。 */
export function storyOrderMatches(items: readonly StoryItem[], refs: readonly StoryOrderRef[]): boolean {
  if (items.length !== refs.length) return false;
  const ordered = [...items].sort((left, right) => (left.position ?? 0) - (right.position ?? 0));
  return ordered.every(
    (item, index) => item.clip_id === refs[index]!.clip_id && (item.segment_id ?? null) === (refs[index]!.segment_id ?? null),
  );
}
