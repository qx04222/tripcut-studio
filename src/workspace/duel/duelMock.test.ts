import { expect, it } from "vitest";
import type { ClipListItem, DuelSession, SelectSegment, SimilarGroup } from "../../api";
import { duelHandlers } from "../../devMock/duel";

it("mock persists six-photo progress, creates a static winner, restores all primaries and selection counts", () => {
  const clips = Array.from({ length: 6 }, (_, i) => ({ id: 201 + i, kind: "photo", select_count: 0 }) as ClipListItem);
  const state = { clips, segments: [] as SelectSegment[], similarGroups: [{ id: 1, min_similarity: 1, members: clips.map((c, i) => ({ clip_id: c.id!, is_primary: i === 0 })) }] as SimilarGroup[], stacks: [], revision: 0 };
  const api = duelHandlers(state); const members = clips.map((c) => ({ clip_id: c.id!, segment_id: null }));
  let s = api.start_duel({ members, source: "similar_group" }) as DuelSession;
  s = api.duel_action({ sessionId: s.id, action: "decide", winner: s.pair[1] });
  expect(api.start_duel({ members, source: "similar_group" }).round).toBe(1);
  for (let i = 0; i < 4; i++) s = api.duel_action({ sessionId: s.id, action: "decide", winner: s.pair[1] });
  api.duel_action({ sessionId: s.id, action: "finish" });
  expect(state.segments).toMatchObject([{ clip_id: 206, in_ticks: 0, out_ticks: 0 }]);
  expect(clips[5]!.select_count).toBe(1);
  api.duel_action({ sessionId: s.id, action: "undo_session" });
  expect(state.segments).toHaveLength(0);
  expect(state.similarGroups[0]!.members.find((m) => m.is_primary)?.clip_id).toBe(201);
  expect(clips[5]!.select_count).toBe(0);
});

it("mock replaces a photo result row instead of adding a second selection", () => {
  const clips = Array.from({ length: 2 }, (_, i) => ({ id: i + 1, kind: "photo", select_count: i === 0 ? 1 : 0 }) as ClipListItem);
  const original: SelectSegment = { id: 101, clip_id: 1, in_ticks: 0, out_ticks: 0, tb_num: 1, tb_den: 1000, source: "auto", reasons: ["清晰"] };
  const state = {
    clips,
    segments: [original],
    similarGroups: [{ id: 1, min_similarity: 1, members: clips.map((clip, index) => ({ clip_id: clip.id!, is_primary: index === 0 })) }] as SimilarGroup[],
    stacks: [],
    revision: 0,
  };
  const api = duelHandlers(state);
  let session = api.start_duel({ members: [
    { clip_id: 1, segment_id: null, result_segment_id: 101 },
    { clip_id: 2, segment_id: null },
  ], source: "results" }) as DuelSession;
  session = api.duel_action({ sessionId: session.id, action: "decide", winner: "photo:2" });
  api.duel_action({ sessionId: session.id, action: "finish" });
  expect(state.segments).toEqual([{ ...original, clip_id: 2 }]);
  expect(state.similarGroups[0]!.members.find((member) => member.is_primary)?.clip_id).toBe(2);
  api.duel_action({ sessionId: session.id, action: "undo_session" });
  expect(state.segments).toEqual([original]);
  expect(state.similarGroups[0]!.members.find((member) => member.is_primary)?.clip_id).toBe(1);
});

it("mock rejects explicit X photos at start and revalidates rating drift before finish", () => {
  const clips = [1, 2].map((id) => ({ id, kind: "photo", binary_rating: null, select_count: 0 }) as ClipListItem);
  const state = {
    clips,
    segments: [] as SelectSegment[],
    similarGroups: [{ id: 1, min_similarity: 1, members: clips.map((clip, index) => ({ clip_id: clip.id!, is_primary: index === 0 })) }] as SimilarGroup[],
    stacks: [],
    revision: 0,
  };
  const api = duelHandlers(state);
  clips[0]!.binary_rating = -1;
  expect(() => api.start_duel({ members: [
    { clip_id: 1, segment_id: null },
    { clip_id: 2, segment_id: null },
  ], source: "similar_group" })).toThrow("先按 F 保留、清除评级，或换一张");
  expect(() => api.start_duel({ members: [
    { clip_id: 1, segment_id: null, result_segment_id: 101 },
    { clip_id: 2, segment_id: null },
  ], source: "results" })).toThrow("先按 F 保留、清除评级，或换一张");
  clips[0]!.binary_rating = null;
  let session = api.start_duel({ members: [
    { clip_id: 1, segment_id: null },
    { clip_id: 2, segment_id: null },
  ], source: "similar_group" }) as DuelSession;
  session = api.duel_action({ sessionId: session.id, action: "decide", winner: "photo:2" });
  clips[1]!.binary_rating = -1;
  expect(() => api.duel_action({ sessionId: session.id, action: "finish" })).toThrow("先按 F 保留、清除评级，或换一张");
  expect(state.segments).toEqual([]);
  expect(state.similarGroups[0]!.members.find((member) => member.is_primary)?.clip_id).toBe(1);
  expect(api.duel_action({ sessionId: session.id, action: "get" })).toMatchObject({ finished: false, undone: false, winners: ["photo:2"] });
});
