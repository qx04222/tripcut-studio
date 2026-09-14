import { undoStoryChange } from "../api";
import { undoSkippedMovedSuffix } from "./copy";

/**
 * R17 epmove:`undo_story_change` 的前端包装。后端回放快照时会跳过「已移到别的集」的镜(不回排、不报错),
 * 这里把跳过数变成一段后缀「(n 条已移到别的集,没有放回)」留给**下一条**撤销 toast / 提示追加:
 * ⌘Z 那条 toast 在 `useGlobalHotkeys` 里、按钮那条在各自的调用处,谁先出谁取走(取一次就清空)。
 */
let pendingSuffix = "";

export async function undoStoryChangeNoticing(): Promise<number> {
  const outcome = await undoStoryChange();
  const skipped = typeof outcome?.skipped_moved === "number" ? outcome.skipped_moved : 0;
  pendingSuffix = skipped > 0 ? undoSkippedMovedSuffix(skipped) : "";
  return skipped;
}

export function takeStoryUndoSuffix(): string {
  const suffix = pendingSuffix;
  pendingSuffix = "";
  return suffix;
}

/** 逐条撤了多次(加入镜头带 n 条)时,按合计数留一份后缀。 */
export function noteStoryUndoSkipped(count: number): void {
  pendingSuffix = count > 0 ? undoSkippedMovedSuffix(count) : "";
}
