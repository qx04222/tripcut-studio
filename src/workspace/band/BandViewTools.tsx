import { useState } from "react";
import { dismissStoryGap, reopenStoryGap, type StoryGap } from "../../api";
import { Button, Menu } from "../ui";
import type { useBandPreferences } from "./useBandPreferences";
import { registerBandUndo } from "../useBandArrange";
import { refreshClipsFeed } from "../useClipsFeed";
import { showToast } from "../ui/Toast";
import { failureText } from "../errorText";

export function BandViewTools({ preferences, gaps, disabled, zoomAt }: {
  preferences: ReturnType<typeof useBandPreferences>; gaps: readonly StoryGap[]; disabled: boolean; zoomAt(direction: number): void;
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  return <div className="band-view-tools">
    <Button size="sm" variant="ghost" aria-label="缩小镜头带" disabled={disabled || preferences.value.zoom <= 0.35} onClick={() => zoomAt(-1)}>−</Button>
    <Button size="sm" variant="ghost" aria-label="重置镜头带缩放" disabled={disabled} onClick={() => zoomAt(0)}>{Math.round(preferences.value.zoom * 100)}%</Button>
    <Button size="sm" variant="ghost" aria-label="放大镜头带" disabled={disabled || preferences.value.zoom >= 3} onClick={() => zoomAt(1)}>+</Button>
    <Button size="sm" variant="ghost" aria-label="镜头带更多" aria-haspopup="menu" onClick={event => { const r = event.currentTarget.getBoundingClientRect(); setAnchor({ x: r.left, y: r.bottom }); }}>···</Button>
    {anchor ? <Menu ariaLabel="镜头带显示与缺口" x={anchor.x} y={anchor.y} onClose={() => setAnchor(null)} items={[
      { id: "badges", label: `${preferences.value.badges ? "隐藏" : "显示"}评级、收藏与 AI 理由角标`, disabled },
      ...gaps.filter(gap => gap.status === "dismissed").map(gap => ({ id: `restore:${gap.id}`, label: `恢复缺口：${gap.slot_label_zh}`, disabled })),
    ]} onSelect={id => {
      if (id === "badges") preferences.toggleBadges();
      else if (!disabled) {
        const gapId = Number(id.split(":")[1]);
        void reopenStoryGap(gapId).then(() => { registerBandUndo("恢复缺口", () => dismissStoryGap(gapId)); return refreshClipsFeed(true); })
          .catch(error => showToast(failureText("恢复缺口", error), { tone: "danger" }));
      }
    }} /> : null}
  </div>;
}
