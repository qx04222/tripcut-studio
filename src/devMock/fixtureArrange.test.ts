import { beforeEach, describe, expect, it } from "vitest";

import { __resetMockForTests, handleMockCommand } from "./fixture";
import type { AutoSelectOutcome, Storyboard } from "../api";

/** R12 车道 B:假后端里的「一键排入 / 只撤本批 / 这章够了」与 Rust 语义一致。 */
describe("devMock arrange", () => {
  beforeEach(() => __resetMockForTests());

  const segmentItems = () => (handleMockCommand("get_storyboard", {}) as Storyboard).items.filter((item) => item.item_kind === "segment");

  it("arrange_selected_segments 把精选段追加成镜块;再排一次 placed = 0;undo_arrange 只拿掉本批", () => {
    expect(segmentItems()).toHaveLength(0);
    const first = handleMockCommand("arrange_selected_segments", { mode: "append" }) as { placed: number; batch_id: string };
    expect(first.placed).toBe(1);
    expect(first.batch_id).toMatch(/^arr-/);
    expect(segmentItems().map((item) => item.segment_id)).toEqual([901]);

    handleMockCommand("create_select_segment", { clipId: 7, inSeconds: 1, outSeconds: 3 });
    const second = handleMockCommand("arrange_selected_segments", { mode: "append" }) as { placed: number; batch_id: string };
    expect(second.placed).toBe(1);
    expect(segmentItems()).toHaveLength(2);

    expect(handleMockCommand("undo_arrange", { batchId: first.batch_id })).toBe(1);
    expect(segmentItems().map((item) => item.segment_id)).toEqual([902]);
  });

  it("auto_select_episode 之后段已在带上(placed > 0,带排入批号);undo_auto_select 连带把镜块拿掉", () => {
    const outcome = handleMockCommand("auto_select_episode", {}) as AutoSelectOutcome;
    expect(outcome.placed).toBe(outcome.created.length + 1);
    expect(outcome.arrange_batch_id).toMatch(/^arr-/);
    expect(segmentItems().length).toBe(outcome.created.length + 1);
    handleMockCommand("undo_auto_select", { batchId: outcome.batch_id });
    expect(segmentItems()).toHaveLength(1);
  });

  it("skip_chapter 写 settings 键 story.chapter_skipped.<id>", () => {
    handleMockCommand("skip_chapter", { chapterId: 103, skipped: true });
    expect((handleMockCommand("get_settings", {}) as Record<string, string>)["story.chapter_skipped.103"]).toBe("true");
    handleMockCommand("skip_chapter", { chapterId: 103, skipped: false });
    expect((handleMockCommand("get_settings", {}) as Record<string, string>)["story.chapter_skipped.103"]).toBe("false");
  });
});
