import type { Storyboard, StoryItem } from "../../api";
import { flattenStoryByChapter } from "../../Storyboard";

export function removeBandItems(board: Storyboard, keys: readonly string[]): StoryItem[] {
  const selected = new Set(keys);
  return flattenStoryByChapter(board.chapters, board.items).filter(item => !selected.has(item.key)).map((item, position) => ({ ...item, position }));
}

export function moveBandItems(board: Storyboard, keys: readonly string[], over: string | null, chapterId: number | null, after = false): StoryItem[] {
  const selected = new Set(keys);
  const ordered = flattenStoryByChapter(board.chapters, board.items);
  const moving = ordered.filter(item => selected.has(item.key)).map(item => ({ ...item, chapter_id: chapterId }));
  if (!moving.length || (over !== null && selected.has(over))) return ordered;
  const rest = ordered.filter(item => !selected.has(item.key));
  let index = over === null ? -1 : rest.findIndex(item => item.key === over);
  if (index >= 0) index += after ? 1 : 0;
  else {
    index = 0;
    rest.forEach((item, position) => { if (item.chapter_id === chapterId) index = position + 1; });
    if (!index) index = rest.length;
  }
  rest.splice(index, 0, ...moving);
  return rest.map((item, position) => ({ ...item, position }));
}
