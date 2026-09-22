import type { KeyboardEvent } from "react";
import { getWorkspaceSnapshot } from "../WorkspaceStore";
import { clampTrim } from "../bandTimeline";
import { ratingHotkeyIntent, isPaneShortcutTarget } from "../useRatingHotkeys";
import type { BandTimeline } from "../useBandTimeline";
import type { BandSegment } from "../shotBandModel";
import type { RatingAction } from "../../SelectPage";

export function bandKeyDown(options: {
  navigate(event: KeyboardEvent<HTMLDivElement>): boolean;
  all(): void; count: number; readOnly: boolean; timeline: BandTimeline;
  active?: BandSegment; remove(): void; rate(action: RatingAction): void;
  fallback(event: KeyboardEvent<HTMLDivElement>): void;
}) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (getWorkspaceSnapshot().focusedPane !== "band") return;
    if (options.navigate(event)) return;
    if (!isPaneShortcutTarget(event.target, event.currentTarget) || event.nativeEvent.isComposing) return;
    const consume = () => { event.preventDefault(); event.stopPropagation(); };
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") { consume(); options.all(); return; }
    if (event.key === "Delete" || event.key === "Backspace") { consume(); options.remove(); return; }
    const { active, timeline, readOnly } = options;
    if ((event.key === "[" || event.key === "]") && !event.metaKey && !event.ctrlKey && active?.segmentId != null && timeline.playhead.positionSec !== null) {
      consume();
      if (!readOnly) {
        const base = { inSec: active.inTicks * active.tbNum / active.tbDen, outSec: active.outTicks * active.tbNum / active.tbDen, clipSec: timeline.trim.clipSeconds(active.clipId) };
        const edge = event.key === "[" ? "in" : "out";
        const next = clampTrim(base, edge, timeline.playhead.positionSec - (edge === "in" ? base.inSec : base.outSec), timeline.trim.frameStep?.(active.clipId) ?? 0.04);
        timeline.trim.commit(active, next.inSec, next.outSec);
      }
      return;
    }
    const intent = ratingHotkeyIntent(event, false);
    if (intent?.kind === "rating" && options.count) { consume(); options.rate(intent.action); return; }
    if (readOnly && (intent?.kind === "rating" || intent?.kind === "stack-state" || intent?.kind === "promote-hero")) return;
    options.fallback(event);
  };
}
