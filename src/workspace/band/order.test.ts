import { expect, it } from "vitest";
import type { StoryItem, Storyboard } from "../../api";
import { moveBandItems, removeBandItems } from "./order";
const item = (key: string, chapter_id: number, clip_id = 1) => ({ key, chapter_id, clip_id, item_kind: "segment", segment_id: Number(key.split(":")[1]) }) as StoryItem;
const board = { chapters: [{ id: 1 }, { id: 2 }], items: [item("segment:1", 1), item("segment:2", 1), item("segment:3", 2, 2)] } as Storyboard;
it("moves only selected cuts across chapters, preserving their internal order", () => {
  const next = moveBandItems(board, ["segment:1", "segment:2"], "segment:3", 2, true);
  expect(next.map(item => item.key)).toEqual(["segment:3", "segment:1", "segment:2"]);
  expect(next.map(item => item.chapter_id)).toEqual([2, 2, 2]);
  expect(board.items[0]!.chapter_id).toBe(1);
  expect(moveBandItems(board, ["segment:1"], "segment:3", 2, false)[0]!.key).toBe("segment:2");
});
it("deletes selected keys without deleting sibling cuts or the source", () => {
  expect(removeBandItems(board, ["segment:1"]).map(item => item.key)).toEqual(["segment:2", "segment:3"]);
});
