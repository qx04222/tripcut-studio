import type { ClipListItem, DuelMember, DuelSession, SelectSegment, ShotStack, SimilarGroup } from "../api";
interface State { clips: ClipListItem[]; segments: SelectSegment[]; similarGroups: SimilarGroup[]; stacks: ShotStack[]; revision: number }
interface RecordEntry { session: DuelSession; source: string; request: string; votes: Array<string | null>; snapshot?: Pick<State, "segments" | "similarGroups" | "stacks"> }
export function duelHandlers(state: State) {
  const sessions = new Map<number, RecordEntry>();
  const ensurePhotosAllowed = (members: readonly DuelMember[]) => {
    const rejected = members.some((member) => {
      const clip = state.clips.find((candidate) => candidate.id === member.clip_id);
      return clip?.kind === "photo" && clip.binary_rating === -1;
    });
    if (rejected) throw new Error("这张照片已明确拒绝；先按 F 保留、清除评级，或换一张再进擂台");
  };
  function replay(record: RecordEntry): DuelSession {
    const queue = record.session.members.map((m) => m.segment_id === null ? `photo:${m.clip_id}` : `video:${m.segment_id}`);
    const winners: string[] = [];
    for (const vote of record.votes) { const [left, right] = queue.splice(0, 2); if (vote === null) { winners.push(left!); queue.unshift(right!); } else queue.unshift(vote); }
    record.session = { ...record.session, round: record.votes.length, pair: queue.length > 1 ? queue.slice(0, 2) : [], winners: queue.length === 1 ? [...winners, queue[0]!] : winners };
    return structuredClone(record.session);
  }
  function counts() { for (const clip of state.clips) clip.select_count = state.segments.filter((s) => s.clip_id === clip.id).length; state.revision += 1; }
  return {
    start_duel: ({ members, source }: Record<string, unknown>) => {
      const list = members as DuelMember[];
      if (list.length < 2) throw new Error("至少两个成员");
      ensurePhotosAllowed(list);
      for (const record of sessions.values()) if (!record.session.finished && !record.session.undone && record.source === source && JSON.stringify(list) === record.request) return replay(record);
      const id = sessions.size + 1;
      const normalized = list.map((m) => {
        const clip = state.clips.find((c) => c.id === m.clip_id);
        if (clip?.kind !== "video" || m.segment_id !== null) return m;
        const candidate: SelectSegment = { id: 800000 + id * 1000 + m.clip_id, clip_id: m.clip_id, in_ticks: 0, out_ticks: clip.duration_ticks ?? 6000, tb_num: clip.tb_num ?? 1, tb_den: clip.tb_den ?? 1000, source: "duel" };
        return { ...m, segment_id: candidate.id, preview: candidate };
      });
      const record: RecordEntry = { source: String(source), request: JSON.stringify(list), votes: [], session: { id, members: normalized, pair: [], winners: [], round: 0, total: list.length - 1, finished: false, undone: false } };
      sessions.set(id, record); return replay(record);
    },
    duel_action: ({ sessionId, action, winner }: Record<string, unknown>) => {
      const record = sessions.get(Number(sessionId)); if (!record) throw new Error("擂台不存在");
      const s = replay(record);
      if (action === "get") return s;
      if (action === "undo_session") {
        if (!s.undone && record.snapshot) { state.segments = record.snapshot.segments; state.similarGroups = record.snapshot.similarGroups; state.stacks = record.snapshot.stacks; counts(); }
        record.votes = []; record.session.undone = true; return replay(record);
      }
      if (s.undone) throw new Error("这组已撤销");
      if (action === "decide") {
        if (s.finished || s.pair.length !== 2) throw new Error("这组已结束");
        if (winner !== null && !s.pair.includes(String(winner))) throw new Error("赢家不在当前场次");
        if (winner === null && s.pair[0]!.startsWith("photo:") === s.pair[1]!.startsWith("photo:")) throw new Error("仅跨媒体支持双保留");
        record.votes.push(winner === null ? null : String(winner));
      } else if (action === "undo_last") { if (s.finished) throw new Error("请撤销整组"); record.votes.pop(); }
      else if (action === "finish" && !s.finished) {
        if (s.pair.length) throw new Error("尚未裁决完成");
        ensurePhotosAllowed(s.members);
        record.snapshot = structuredClone({ segments: state.segments, similarGroups: state.similarGroups, stacks: state.stacks });
        const resultPhotoAnchor = record.source === "results"
          ? s.members.find((member) => member.segment_id === null && member.result_segment_id !== undefined)
          : undefined;
        const resultPhotoWinner = resultPhotoAnchor
          ? s.winners.find((key) => key.startsWith("photo:"))
          : undefined;
        if (resultPhotoAnchor && resultPhotoWinner) {
          const anchor = state.segments.find((segment) => segment.id === resultPhotoAnchor.result_segment_id);
          const winnerClipId = Number(resultPhotoWinner.slice("photo:".length));
          const memberClipIds = new Set(s.members.filter((member) => member.segment_id === null).map((member) => member.clip_id));
          state.segments = state.segments.filter((segment) => !memberClipIds.has(segment.clip_id));
          if (anchor) state.segments.push(winnerClipId === resultPhotoAnchor.clip_id
            ? anchor
            : { ...anchor, clip_id: winnerClipId });
        }
        for (const m of s.members) {
          const win = s.winners.includes(m.segment_id === null ? `photo:${m.clip_id}` : `video:${m.segment_id}`);
          if (m.segment_id === null && win) {
            for (const group of state.similarGroups) if (group.members.some((x) => x.clip_id === m.clip_id)) for (const x of group.members) x.is_primary = x.clip_id === m.clip_id;
            if (!resultPhotoAnchor && !state.segments.some((x) => x.clip_id === m.clip_id)) state.segments.push({ id: 90000 + m.clip_id, clip_id: m.clip_id, in_ticks: 0, out_ticks: 0, tb_num: 1, tb_den: 1000, source: "duel" });
          }
          if (win && m.preview && !state.segments.some((x) => x.id === m.segment_id)) state.segments.push(m.preview);
          if (!win && m.segment_id !== null) state.segments = state.segments.filter((x) => x.id !== m.segment_id);
          if (!win) for (const stack of state.stacks) for (const x of stack.members) if (x.clip_id === m.clip_id && x.segment_id === m.segment_id) x.user_state = "rejected";
        }
        record.session.finished = true; counts();
      }
      return replay(record);
    },
  };
}
