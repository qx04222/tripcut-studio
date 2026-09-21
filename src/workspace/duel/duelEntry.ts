import { listClips, listSelectSegments, listShotStacks, listSimilarGroups, type DuelMember, type DuelSource } from "../../api";
import { getWorkspaceSnapshot } from "../WorkspaceStore";
import type { DuelRequest } from "./duelBus";
export { OPEN_DUEL, requestDuel, type DuelRequest } from "./duelBus";
export const PHOTO_DUEL_REJECTED_ERROR = "已排除明确拒绝（X）的照片；至少需要两张可比较照片。先按 F 保留、清除评级，或换一张。";
export async function resolveDuel(request: DuelRequest): Promise<{ members: DuelMember[]; source: DuelSource }> {
  const snapshot = getWorkspaceSnapshot();
  if (snapshot.viewingEpisode !== null) throw new Error("历史集只读，不能进擂台");
  if (request.workspaceMode !== undefined && request.workspaceMode !== snapshot.workspaceMode) {
    throw new Error("工作台已切换，请重新打开擂台");
  }
  const clips = await listClips();
  const selection = snapshot.selection;
  const targetKind = request.workspaceMode ?? snapshot.workspaceMode;
  const requestedIds = request.clipIds ?? (selection?.kind === "clip" ? [selection.clipId] : []);
  const eligible = (id: number) => {
    const clip = clips.find((candidate) => candidate.id === id);
    return clip?.kind === targetKind && !clip.missing_since && !(targetKind === "photo" && clip.binary_rating === -1);
  };
  const rejectedPhoto = (id: number) => targetKind === "photo"
    && clips.find((candidate) => candidate.id === id)?.binary_rating === -1;
  let ids = requestedIds.filter(eligible);
  let source = request.source ?? "manual";
  if (source === "results" && ids.length < 2) {
    if (requestedIds.some(rejectedPhoto)) throw new Error(PHOTO_DUEL_REJECTED_ERROR);
    throw new Error("至少需要两张照片或两条已保存的精选段");
  }
  let stackMembers: DuelMember[] | undefined;
  if (ids.length < 2) {
    const [groups, stacks] = await Promise.all([
      listSimilarGroups(),
      targetKind === "video" ? listShotStacks() : Promise.resolve([]),
    ]);
    const relevantGroups = groups.filter((candidate) => requestedIds.length === 0
      || candidate.members.some((member) => requestedIds.includes(member.clip_id)));
    const group = relevantGroups.find((candidate) => candidate.members.filter((member) => eligible(member.clip_id)).length > 1);
    const stack = stacks.find((s) => s.members.some((m) => ids.includes(m.clip_id) && (request.segmentId === undefined || m.segment_id === request.segmentId)));
    if (stack && request.segmentId !== undefined) { stackMembers = stack.members; ids = stack.members.map((m) => m.clip_id); source = "shot_stack"; }
    else if (group) {
      ids = group.members
        .map((member) => member.clip_id)
        .filter(eligible);
      source = "similar_group";
    }
    else if (stack) { stackMembers = stack.members; ids = stack.members.map((m) => m.clip_id); source = "shot_stack"; }
    else if (targetKind === "photo" && (requestedIds.some(rejectedPhoto) || relevantGroups.some((candidate) => candidate.members.some((member) => rejectedPhoto(member.clip_id))))) {
      throw new Error(PHOTO_DUEL_REJECTED_ERROR);
    }
    else throw new Error("当前素材没有可比较的相似组；也可以在素材池多选后进擂台");
    ids = ids.filter(eligible);
  }
  if (source === "results") {
    ids = ids.filter(eligible);
  }
  const members: DuelMember[] = [];
  for (const id of [...new Set(ids)]) {
    const clip = clips.find((c) => c.id === id);
    if (!clip || clip.missing_since || clip.kind !== targetKind || (clip.kind === "photo" && clip.binary_rating === -1)) continue;
    if (clip.kind === "photo") members.push({
      clip_id: id,
      segment_id: null,
      ...(source === "results" && request.segmentId !== undefined && id === request.clipIds?.[0]
        ? { result_segment_id: request.segmentId }
        : {}),
    });
    else {
      const rows = await listSelectSegments(id);
      const inStack = stackMembers?.filter((m) => m.clip_id === id && m.segment_id !== null).map((m) => m.segment_id);
      const candidates = request.segmentId !== undefined && id === request.clipIds?.[0]
        ? rows.filter((s) => s.id === request.segmentId)
        : inStack?.length ? rows.filter((s) => inStack.includes(s.id)) : rows;
      for (const row of candidates) members.push({ clip_id: id, segment_id: row.id });
      if (candidates.length === 0) members.push({ clip_id: id, segment_id: null });
    }
  }
  if (members.length < 2) {
    if (targetKind === "photo" && requestedIds.some(rejectedPhoto)) throw new Error(PHOTO_DUEL_REJECTED_ERROR);
    throw new Error("至少需要两张照片或两条已保存的精选段");
  }
  return { members, source };
}
