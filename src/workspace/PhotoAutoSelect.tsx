import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { autoSelectEpisodeWith, undoAutoSelect } from "../api";
import { failureText } from "./errorText";
import { ResultsLayer, ResultsPanel } from "./results/ResultsPanel";
import { PromptInput } from "./results/PromptInput";
import { PHOTO_SELECT_PROMPT_PLACEHOLDER, parseSelectPromptSmart, toAutoSelectParams } from "./selectPrompt";
import { showToast } from "./ui/Toast";
import { pushUndo, runUndoById } from "./undoStack";
import { refreshClipsFeed } from "./useClipsFeed";
import { useWorkspace } from "./WorkspaceStore";

export function PhotoAutoSelect(): JSX.Element {
  const readOnly = useWorkspace((state) => state.viewingEpisode !== null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const undoIdRef = useRef<number | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (readOnly) setRunId(null); }, [readOnly]);

  const run = useCallback(async (sentence: string) => {
    if (readOnly) return;
    setBusy(true);
    try {
      const { parsed } = await parseSelectPromptSmart(sentence);
      const params = toAutoSelectParams(parsed, sentence, parsed.scope ?? "all");
      const { budgetSecs: _ignored, ...withoutVideoBudget } = params;
      const explicitCount = /(?:挑|选|要)?\s*(\d+)\s*张/.exec(sentence)?.[1];
      const photoCount = explicitCount ? Number.parseInt(explicitCount, 10) : parsed.photoCount;
      const outcome = await autoSelectEpisodeWith({
        ...withoutVideoBudget,
        mediaKind: "photo",
        photoCount: photoCount && photoCount > 0 ? photoCount : 20,
      });
      const id = pushUndo({
        label: `挑照片 ${outcome.created.length} 张`,
        undo: async () => {
          await undoAutoSelect(outcome.batch_id);
          setRunId(null);
          await refreshClipsFeed(true);
        },
      });
      undoIdRef.current = id;
      setRunId(outcome.run_id ?? outcome.batch_id);
      await refreshClipsFeed(true);
    } catch (error) {
      showToast(failureText("挑照片", error), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }, [readOnly]);

  const undoAll = useCallback(async () => {
    const id = undoIdRef.current;
    if (id === null) return false;
    undoIdRef.current = null;
    return runUndoById(id);
  }, []);

  return (
    <div ref={rootRef} className="photo-ws-auto" aria-label="一句话挑照片">
      <span className="photo-ws-auto-label">{readOnly ? "历史集为只读档案" : "一句话挑照片"}</span>
      <PromptInput
        busy={busy || readOnly}
        placeholder={PHOTO_SELECT_PROMPT_PLACEHOLDER}
        onSubmit={(sentence) => void run(sentence)}
      />
      <ResultsLayer open={runId !== null} container={rootRef.current?.closest(".photo-workspace") ?? null}>
        {runId ? <ResultsPanel mode="photo" runId={runId} busy={busy} onPrompt={(sentence) => void run(sentence)} onClose={() => setRunId(null)} onUndoAll={undoAll} /> : null}
      </ResultsLayer>
    </div>
  );
}
