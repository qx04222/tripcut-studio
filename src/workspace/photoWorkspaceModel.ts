import type { ClipListItem, SimilarGroup } from "../api";
import { timePeriodOf } from "./poolGrouping";
import { poolCapturedSortValue, poolWallClock } from "./poolOrder";

export interface PhotoGridItem {
  clip: ClipListItem;
  similarCount: number;
  similarClipIds: number[];
  similarGroupId: number | null;
  similarGroupExpanded: boolean;
  similarPrimary: boolean;
  suspectedJunk: boolean;
}
export interface PhotoSection { key: string; label: string; items: PhotoGridItem[]; }

export function isSuspectedJunk(clip: ClipListItem): boolean {
  const a = clip.analysis;
  return a !== null && (a.underexposed_ratio > 0.15 || a.overexposed_ratio > 0.15 || a.out_of_focus_ratio > 0.15);
}

function capturedTime(clip: ClipListItem): number {
  return poolCapturedSortValue(clip);
}

export function buildPhotoSections(clips: readonly ClipListItem[], groups: readonly SimilarGroup[], expandedGroups: ReadonlySet<number> = new Set()): PhotoSection[] {
  const photos = clips.filter((clip) => clip.kind === "photo" && clip.id !== null);
  const byId = new Map(photos.map((clip) => [clip.id!, clip]));
  const groupByMember = new Map<number, SimilarGroup>();
  for (const group of groups) for (const member of group.members) if (byId.has(member.clip_id)) groupByMember.set(member.clip_id, group);
  const consumed = new Set<number>();
  const blocks: PhotoGridItem[][] = [];
  for (const clip of photos) {
    if (consumed.has(clip.id!)) continue;
    const group = groupByMember.get(clip.id!);
    const members = group?.members.filter((member) => byId.has(member.clip_id)) ?? [];
    const primaryId = members.find((member) => member.is_primary)?.clip_id ?? clip.id!;
    const representative = byId.get(primaryId) ?? clip;
    const rest = members.map((member) => member.clip_id).filter((id) => id !== primaryId).sort((a, b) => {
      const first = byId.get(a)!;
      const second = byId.get(b)!;
      return Number(isSuspectedJunk(first)) - Number(isSuspectedJunk(second)) || capturedTime(first) - capturedTime(second) || a - b;
    });
    const ids = members.length > 1 ? [primaryId, ...rest] : [clip.id!];
    ids.forEach((id) => consumed.add(id));
    const expanded = group !== undefined && expandedGroups.has(group.id);
    const visibleIds = expanded ? ids : [primaryId];
    blocks.push(visibleIds.map((id) => {
      const member = byId.get(id) ?? representative;
      return {
        clip: member,
        similarCount: ids.length,
        similarClipIds: ids,
        similarGroupId: group?.id ?? null,
        similarGroupExpanded: expanded,
        similarPrimary: members.length > 1 && id === primaryId,
        suspectedJunk: isSuspectedJunk(member),
      };
    }));
  }
  blocks.sort((a, b) => Number(a[0]!.suspectedJunk) - Number(b[0]!.suspectedJunk) || capturedTime(a[0]!.clip) - capturedTime(b[0]!.clip));
  const items = blocks.flat();
  const sections: PhotoSection[] = [];
  const byKey = new Map<string, PhotoSection>();
  for (const item of items) {
    const local = poolWallClock(item.clip);
    const key = local ? `${local.date}-${timePeriodOf(local.hour)}` : "unknown";
    let section = byKey.get(key);
    if (!section) {
      section = { key, label: local ? `${local.date} · ${timePeriodOf(local.hour)}` : "时间未知", items: [] };
      byKey.set(key, section);
      sections.push(section);
    }
    section.items.push(item);
  }
  return sections;
}

export function featuredPhotos(clips: readonly ClipListItem[], order: readonly number[]): ClipListItem[] {
  const position = new Map(order.map((id, index) => [id, index]));
  return clips.filter((clip) => clip.kind === "photo" && clip.id !== null && clip.binary_rating !== -1)
    .filter((clip) => clip.binary_rating === 1 || (clip.star_rating ?? 0) >= 3 || clip.select_count > 0)
    .sort((a, b) => (position.get(a.id!) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.id!) ?? Number.MAX_SAFE_INTEGER) || capturedTime(a) - capturedTime(b) || a.id! - b.id!);
}

export function swapVisiblePhotos(order: readonly number[], firstId: number, secondId: number): number[] {
  const next = [...order];
  const first = next.indexOf(firstId);
  const second = next.indexOf(secondId);
  if (first < 0 || second < 0 || first === second) return next;
  [next[first], next[second]] = [next[second]!, next[first]!];
  return next;
}

export function moveVisiblePhoto(order: readonly number[], id: number, direction: -1 | 1, visibleIds: readonly number[]): number[] {
  const index = visibleIds.indexOf(id);
  const target = visibleIds[index + direction];
  return index < 0 || target === undefined ? [...order] : swapVisiblePhotos(order, id, target);
}

export function moveVisiblePhotoTo(order: readonly number[], sourceId: number, targetId: number, visibleIds: readonly number[]): number[] {
  const visible = new Set(visibleIds);
  const slots = order.map((id, index) => visible.has(id) ? index : -1).filter((index) => index >= 0);
  const sequence = slots.map((index) => order[index]!);
  const from = sequence.indexOf(sourceId);
  const to = sequence.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return [...order];
  sequence.splice(to, 0, sequence.splice(from, 1)[0]!);
  const next = [...order];
  slots.forEach((slot, index) => { next[slot] = sequence[index]!; });
  return next;
}
