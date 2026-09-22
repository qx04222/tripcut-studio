import type { StoryGap } from "../../api";
import { cancelGeneration, retryGeneration } from "../../api";
import { gapMenuItems } from "../BandSegment";
import { GapMoreMenu } from "../BandGapMenu";
import { openGapPool } from "./gaps";
import { openSettings } from "../openSettings";
import { refreshClipsFeed } from "../useClipsFeed";
import { showToast } from "../ui/Toast";
import { failureText } from "../errorText";

export function GroupedGapBody({ gaps, readOnly, disabledHint, onDismiss, onGenerate }: {
  gaps: readonly StoryGap[]; readOnly: boolean; disabledHint: string | null;
  onDismiss(gap: StoryGap): void; onGenerate(gap: StoryGap): void;
}) {
  return <span className="band-grouped-gaps">
    <strong>缺 {gaps.length} 类：{gaps.map(gap => gap.slot_label_zh).join(" / ")}</strong>
    {gaps.map(gap => {
      const request = gap.latest_request, status = request?.status;
      const inFlight = status === "submitted" || status === "queued" || status === "succeeded";
      const items = gapMenuItems(disabledHint, false).filter(item => item.id !== "generate" || (!inFlight && status !== "imported" && status !== "failed"));
      if (inFlight) items.unshift({ id: "cancel", label: "取消" });
      if (status === "failed") items.unshift({ id: "retry", label: "重新生成" });
      return <span key={gap.id} className="band-grouped-gap" title={gap.reason}>
        <span>{gap.slot_label_zh}</span>
        <GapMoreMenu disabled={readOnly} items={items} onSelect={id => {
          if (id === "pool") openGapPool(gap);
          else if (id === "dismiss") onDismiss(gap);
          else if (id === "generate") onGenerate(gap);
          else if (id === "settings") openSettings("generation");
          else if (request && (id === "cancel" || id === "retry")) void (id === "cancel" ? cancelGeneration(request.id) : retryGeneration(request.id))
            .then(() => refreshClipsFeed(true)).catch(error => showToast(failureText("更新缺口", error), { tone: "danger" }));
        }} />
      </span>;
    })}
  </span>;
}
