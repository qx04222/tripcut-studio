import { deleteSelectSegment, restoreSelectSegment } from "../api";
import { SEGMENT_DELETED_TOAST, UNDO_ACTION_LABEL } from "./copy";
import { failureText } from "./errorText";
import { showToast } from "./ui/toastStore";
import { pushUndo, runUndoById } from "./undoStack";
import { refreshClipsFeed } from "./useClipsFeed";

/** 「删除精选段 · 撤销」toast 的停留(与镜头带的撤销窗口同一个数)。 */
export const SEGMENT_UNDO_TOAST_MS = 5_000;

/**
 * R16 P1-2 / P1-4:删一条精选段(软删)并给 5 秒「撤销」—— 检查器精选段行与镜块菜单共用。
 * toast 的「撤销」与 ⌘Z 走同一条栈(`runUndoById`),撤过一次不会再撤第二次。
 * `after` 在删除 / 恢复之后各调一次(检查器用它重取列表)。
 */
export async function deleteSegmentWithUndo(segmentId: number, after?: () => void): Promise<void> {
  await deleteSelectSegment(segmentId);
  const undoId = pushUndo({
    label: "删除精选段",
    undo: async () => {
      await restoreSelectSegment(segmentId);
      await refreshClipsFeed(true);
      after?.();
    },
  });
  showToast(SEGMENT_DELETED_TOAST, {
    durationMs: SEGMENT_UNDO_TOAST_MS,
    action: {
      label: UNDO_ACTION_LABEL,
      onClick: () => {
        void runUndoById(undoId)
          .then((restored) => showToast(restored ? "已恢复精选段" : "这段已经恢复过了"))
          .catch((error) => showToast(failureText("撤销", error), { tone: "danger" }));
      },
    },
  });
  await refreshClipsFeed(true);
  after?.();
}
