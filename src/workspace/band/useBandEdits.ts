import { useCallback, useRef, useState } from "react";
import { getStoryboard, rateClip, setBandOrder, type Storyboard, type StoryItem, type Chapter } from "../../api";
import { flattenStoryByChapter } from "../../Storyboard";
import { registerBandUndo } from "../useBandArrange";
import { getClipsFeedSnapshot, refreshClipsFeed } from "../useClipsFeed";
import { failureText } from "../errorText";
import { showToast } from "../ui/Toast";
import { insertNotice, type BandDragState, type BandReorderPlan } from "../useBandDrag";

const refs = (items: readonly StoryItem[]) => items.map(({ item_kind, clip_id, segment_id, chapter_id }) => ({ item_kind, clip_id, segment_id, chapter_id }));
function ensureScope(id: number): void {
  const { episode } = getClipsFeedSnapshot();
  if (episode.activeId !== id || episode.viewing !== null) throw new Error("当前集已切换，请重试");
}
export function useBandEdits(board: Storyboard | null): BandDragState & {
  save(items: StoryItem[], label: string, chapters?: Chapter[]): Promise<void>;
  arrange(): void;
} {
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [optimisticItems, setOptimistic] = useState<StoryItem[] | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const run = useCallback(async (label: string, work: (episodeId: number) => Promise<void>) => {
    const { episode } = getClipsFeedSnapshot();
    if (episode.viewing !== null || episode.activeId === null || locked.current) return;
    locked.current = true; setBusy(true);
    try { await work(episode.activeId); }
    catch (error) { showToast(failureText(label, error), { tone: "danger" }); }
    finally { locked.current = false; setBusy(false); setOptimistic(null); }
  }, []);
  const persist = useCallback(async (episodeId: number, before: Storyboard, items: StoryItem[], label: string, chapters = before.chapters, inverseExtra?: () => Promise<unknown>, message?: string) => {
    ensureScope(episodeId);
    if (JSON.stringify(refs(items)) === JSON.stringify(refs(before.items)) && JSON.stringify(chapters.map(chapter => chapter.id)) === JSON.stringify(before.chapters.map(chapter => chapter.id))) return;
    const { clipsById } = getClipsFeedSnapshot();
    if (items.some(item => clipsById.get(item.clip_id)?.kind !== "video")) throw new Error("照片请在照片工作台挑选");
    setOptimistic(items);
    await setBandOrder(episodeId, refs(items), chapters.map(chapter => chapter.id));
    registerBandUndo(label, async () => {
      await setBandOrder(episodeId, refs(before.items), before.chapters.map(chapter => chapter.id));
      await inverseExtra?.();
    }, message, episodeId);
    await refreshClipsFeed(true);
  }, []);
  const save = useCallback(async (items: StoryItem[], label: string, chapters?: Chapter[]) => {
    if (board) await run(label, id => persist(id, board, items, label, chapters));
  }, [board, persist, run]);
  const apply = useCallback((plan: BandReorderPlan) => {
    if (plan?.kind === "reorder") void save(plan.items, plan.label === "已从镜头带移出" ? "移出 1 段" : "移动 1 段");
  }, [save]);
  const insert = useCallback((clipId: number) => {
    if (!board) return;
    void run("加入镜头带", async episodeId => {
      const clip = getClipsFeedSnapshot().clipsById.get(clipId);
      if (clip?.kind !== "video") throw new Error("照片请在照片工作台挑选");
      if (board.items.some(item => item.clip_id === clipId)) { showToast("这条素材已经在镜头带上"); return; }
      const favorite = clip.binary_rating !== 1 && !clip.select_count;
      let favorited = false;
      try {
        if (favorite) { await rateClip(clipId, "binary", 1); favorited = true; }
        const latest = await getStoryboard(); ensureScope(episodeId);
        const candidate = latest.candidates.find(item => item.clip_id === clipId);
        if (!candidate) throw new Error("素材还不在候选里");
        await persist(episodeId, latest, flattenStoryByChapter(latest.chapters, [...latest.items, candidate]), "加入 1 段", undefined,
          favorite ? () => rateClip(clipId, "binary", clip.binary_rating ?? 0) : undefined, insertNotice(latest.chapters, candidate, favorite));
      } catch (error) {
        if (favorited) await rateClip(clipId, "binary", clip.binary_rating ?? 0);
        throw error;
      }
    });
  }, [board, persist, run]);
  const arrange = useCallback(() => {
    void run("排入", async episodeId => {
      const latest = await getStoryboard(); ensureScope(episodeId);
      const candidates = latest.candidates;
      if (!candidates.length) { showToast("挑好的片段都已经在镜头带上了"); return; }
      await persist(episodeId, latest, flattenStoryByChapter(latest.chapters, [...latest.items, ...candidates]), `排入 ${candidates.length} 段`);
    });
  }, [persist, run]);
  return { optimisticItems, busy, overKey, setOverKey, save, apply, insert, arrange, notice: null, undoable: false, undo: () => undefined, dismissNotice: () => undefined };
}
