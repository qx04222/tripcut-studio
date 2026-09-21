import { undoReplaceAutoSegment } from "../api";
import { pushUndo } from "./undoStack";
import { refreshClipsFeed } from "./useClipsFeed";

/** 换一段与整批挑选共享 ⌘Z 栈;后端原子恢复批次和原位置。 */
export function pushReplaceUndo(runId: string, replacedSegmentId: number, reload: () => Promise<unknown>): number {
  return pushUndo({
    label: "恢复旧段",
    undo: async () => {
      await undoReplaceAutoSegment(runId, replacedSegmentId);
      await refreshClipsFeed(true);
      await reload();
    },
  });
}
