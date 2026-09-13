import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CLIP_COUNT,
  MOCK_COMMANDS,
  MockCommandMissing,
  __resetMockForTests,
  handleMockCommand,
} from "./fixture";
import type { ClipListItem, ShotStack, StoryGap, Storyboard } from "../api";

/** `src/api.ts` 里每一条 `invoke<T>("cmd")` 的命令名 —— 夹具漏登记一条这里就红。 */
function commandsInApi(): string[] {
  const source = readFileSync(resolve(import.meta.dirname, "../api.ts"), "utf8");
  return [...new Set([...source.matchAll(/invoke<[^>]*>\(\s*"([a-z_]+)"/g)].map((m) => m[1]!))].sort();
}

describe("devMock fixture", () => {
  beforeEach(() => __resetMockForTests());

  it("covers every command src/api.ts can invoke", () => {
    const expected = commandsInApi();
    expect(expected.length).toBeGreaterThan(100);
    const missing = expected.filter((command) => !MOCK_COMMANDS.includes(command));
    expect(missing).toEqual([]);
  });

  it("throws loudly, naming the command, for anything unregistered", () => {
    expect(() => handleMockCommand("no_such_command", {})).toThrow(MockCommandMissing);
    expect(() => handleMockCommand("no_such_command", {})).toThrow(/no_such_command/);
  });

  it("serves 60 clips with covers, one MiniMax alternative inside a stack, and two open gaps", () => {
    const clips = handleMockCommand("list_clips", {}) as ClipListItem[];
    expect(clips).toHaveLength(CLIP_COUNT);
    expect(clips.every((clip) => clip.cover_url?.startsWith("/mock-covers/"))).toBe(true);
    const generated = clips.filter((clip) => clip.generated_source === "minimax");
    expect(generated.length).toBeGreaterThanOrEqual(1);
    const stacks = handleMockCommand("list_shot_stacks", {}) as ShotStack[];
    expect(stacks.some((stack) => stack.members.some((m) => generated.some((g) => g.id === m.clip_id)))).toBe(true);
    expect(stacks.every((stack) => stack.members.length >= 2 && stack.members.length <= 3)).toBe(true);
    const gaps = handleMockCommand("list_story_gaps", {}) as StoryGap[];
    expect(gaps.map((gap) => gap.slot).sort()).toEqual(["REAL/ESTABLISHING", "TRANSITION"]);
    const board = handleMockCommand("get_storyboard", {}) as Storyboard;
    expect(board.chapters).toHaveLength(4);
    expect(board.narrative?.chapters.every((chapter) => chapter.beats.length > 0)).toBe(true);
    expect(clips.filter((clip) => clip.binary_rating === 1).length).toBeGreaterThan(0);
    expect(clips.filter((clip) => clip.binary_rating === -1).length).toBeGreaterThan(0);
  });

  it("bumps get_clips_revision when a rating changes so the feed refetches", () => {
    const before = handleMockCommand("get_clips_revision", {});
    expect(handleMockCommand("get_clips_revision", {})).toBe(before);
    handleMockCommand("rate_clip", { clipId: 1, ratingType: "binary", value: 1 });
    const after = handleMockCommand("get_clips_revision", {});
    expect(after).not.toBe(before);
    const clip = (handleMockCommand("list_clips", {}) as ClipListItem[]).find((c) => c.id === 1);
    expect(clip?.binary_rating).toBe(1);
    handleMockCommand("clear_clip_rating", { clipId: 1 });
    expect(handleMockCommand("get_clips_revision", {})).not.toBe(after);
  });

  it("answers player commands with a ready status so the monitor renders its controls", () => {
    const status = handleMockCommand("player_open", { clipId: 2 }) as { phase: string; duration: number };
    expect(status.phase).toBe("ready");
    expect(status.duration).toBeGreaterThan(0);
    expect(handleMockCommand("player_set_viewport", { viewport: { x: 0, y: 0, width: 1, height: 1 } })).toBeUndefined();
    handleMockCommand("player_command", { cmd: { type: "seek_abs", seconds: 2 } });
    expect((handleMockCommand("player_status", {}) as { pos: number }).pos).toBe(2);
  });
});

// R11 车道 B:时刻分 / 建议段 / 自动挑选的假后端形状与撤销语义。
describe("devMock moments (R11 lane B)", () => {
  beforeEach(() => __resetMockForTests());

  it("serves ≤200 moment points with plain-Chinese reasons and ≤3 suggestions inside the clip", () => {
    const moments = handleMockCommand("get_clip_moments", { clipId: 1 }) as Array<{ score: number; reasons: string[]; t_end_ticks: number }>;
    expect(moments.length).toBeGreaterThan(0);
    expect(moments.length).toBeLessThanOrEqual(200);
    expect(moments.every((m) => m.score >= 0 && m.score <= 1)).toBe(true);
    const allowed = new Set(["清晰", "运动适中", "曝光正常", "有人声", "有声音"]);
    expect(moments.every((m) => m.reasons.every((r) => allowed.has(r)))).toBe(true);
    const suggestions = handleMockCommand("suggest_segments", { clipId: 1, targetSecs: null }) as Array<{ in_ticks: number; out_ticks: number; score: number }>;
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    expect(suggestions.length).toBeLessThanOrEqual(3);
    const last = moments[moments.length - 1]!;
    expect(suggestions.every((s) => s.in_ticks >= 0 && s.out_ticks <= last.t_end_ticks && s.out_ticks > s.in_ticks)).toBe(true);
  });

  it("auto-selects within budget, covers more than one chapter, and undo removes only that batch", () => {
    const before = (handleMockCommand("list_clips", {}) as ClipListItem[]).reduce((sum, clip) => sum + clip.select_count, 0);
    const outcome = handleMockCommand("auto_select_episode", { budgetSecs: 30, scope: null }) as { created: number[]; total_secs: number; chapters_covered: number; batch_id: string };
    expect(outcome.created.length).toBeGreaterThanOrEqual(4);
    expect(outcome.total_secs).toBeLessThanOrEqual(30);
    expect(outcome.chapters_covered).toBeGreaterThanOrEqual(2);
    const manual = handleMockCommand("create_select_segment", { clipId: 2, inSeconds: 1, outSeconds: 3 }) as { id: number };
    const removed = handleMockCommand("undo_auto_select", { batchId: outcome.batch_id });
    expect(removed).toBe(outcome.created.length);
    const after = (handleMockCommand("list_clips", {}) as ClipListItem[]).reduce((sum, clip) => sum + clip.select_count, 0);
    expect(after).toBe(before + 1);
    const segments = handleMockCommand("list_select_segments", { clipId: 2 }) as Array<{ id: number }>;
    expect(segments.some((segment) => segment.id === manual.id)).toBe(true);
  });
});
