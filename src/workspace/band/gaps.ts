import { useEffect } from "react";
import type { StoryGap } from "../../api";
import type { BandChapter, BandSegment } from "../shotBandModel";
import { dispatchWorkspace, getWorkspaceSnapshot } from "../WorkspaceStore";

export const GAP_POOL_EVENT = "tripcut:band-gap-pool";
export function groupAdjacentGaps(chapters: readonly BandChapter[]): BandChapter[] {
  return chapters.map(chapter => {
    const segments: BandSegment[] = [];
    for (const segment of chapter.segments) {
      const last = segments[segments.length - 1];
      if (segment.kind === "slot" && segment.gap && last?.kind === "slot" && last.gap) {
        segments[segments.length - 1] = { ...last, groupedGaps: [...(last.groupedGaps ?? [last.gap]), segment.gap] };
      } else segments.push(segment);
    }
    return { ...chapter, segments };
  });
}
export function openGapPool(gap: StoryGap): void {
  const state = getWorkspaceSnapshot();
  if (state.poolCollapsed) dispatchWorkspace({ type: "toggle-pane", pane: "pool" });
  dispatchWorkspace({ type: "set-auto-collapse", pool: false });
  dispatchWorkspace({ type: "set-filter", filter: "all" });
  dispatchWorkspace({ type: "set-dimension", dimension: "" });
  dispatchWorkspace({ type: "set-query", query: gap.slot_label_zh });
  dispatchWorkspace({ type: "focus-pane", pane: "pool" });
  window.dispatchEvent(new CustomEvent(GAP_POOL_EVENT, { detail: gap.slot_label_zh }));
}
export function useGapPoolSearch(search: (query: string) => Promise<void>, reset: () => void): void {
  useEffect(() => {
    const onSearch = (event: Event) => { reset(); void search((event as CustomEvent<string>).detail); };
    window.addEventListener(GAP_POOL_EVENT, onSearch);
    return () => window.removeEventListener(GAP_POOL_EVENT, onSearch);
  }, [search, reset]);
}
