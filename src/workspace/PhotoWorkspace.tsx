import type { JSX } from "react";
import { DuelHost } from "./duel/DuelHost";
import { PhotoAutoSelect } from "./PhotoAutoSelect";
import { PhotoFeaturedStrip } from "./PhotoFeaturedStrip";
import { PhotoGrid } from "./PhotoGrid";
import { PhotoMonitorHost } from "./PhotoMonitorHost";
import { PaneHead } from "./PaneHead";

export function PhotoWorkspace(): JSX.Element {
  return (
    <main className="photo-workspace" aria-label="照片工作台">
      <div className="photo-ws-upper">
        <PhotoGrid />
        <section className="photo-ws-monitor" aria-label="照片静态检视" data-pane="monitor" tabIndex={-1}>
          <PaneHead title="静态检视" />
          <div className="photo-ws-monitor-body"><DuelHost><PhotoMonitorHost /></DuelHost></div>
        </section>
      </div>
      <PhotoAutoSelect />
      <PhotoFeaturedStrip />
    </main>
  );
}
