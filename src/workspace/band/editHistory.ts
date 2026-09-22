import { getClipsFeedSnapshot, refreshClipsFeed } from "../useClipsFeed";
import { peekUndo, pushUndo, runUndoById } from "../undoStack";
import { showToast } from "../ui/Toast";
import { failureText } from "../errorText";

/** All band edits register one inverse here; a stale toast cannot undo past a newer edit. */
export function registerBandUndo(label: string, inverse: () => Promise<unknown>, message?: string, episodeId = getClipsFeedSnapshot().episode.activeId): number {
  let completed = false;
  const undo = async () => {
    if (completed) return;
    const now = getClipsFeedSnapshot().episode;
    if (now.viewing !== null || now.activeId !== episodeId) throw new Error("请回到编辑时的集再撤销");
    await inverse();
    completed = true;
    await refreshClipsFeed(true);
  };
  const id = pushUndo({ label, undo });
  window.dispatchEvent(new CustomEvent("tripcut:undo-push", { detail: { label, undo } }));
  showToast(message ?? `已${label}`, {
    tone: "success", durationMs: 5000,
    action: { label: "撤销", onClick: () => {
      if (peekUndo()?.undo !== undo) { showToast("请先撤销较新的操作"); return; }
      void runUndoById(id).then(ran => { if (ran) showToast(`已撤销 · ${label}`); })
        .catch(error => showToast(failureText("撤销", error), { tone: "danger" }));
    } },
  });
  return id;
}
