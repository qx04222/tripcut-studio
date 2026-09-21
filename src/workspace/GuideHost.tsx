import { useCallback, useEffect, type JSX } from "react";

import { GUIDES, GUIDE_ORDER, dismissGuide, hydrateGuides, reportGuideSignals, snoozeGuide, useGuides } from "./guides";
import { homeVisible, useHomePinned } from "./homeStore";
import { Guide } from "./ui/Guide";
import { useClipsFeed } from "./useClipsFeed";
import { usePipeline } from "./usePipeline";
import { useWorkspace } from "./WorkspaceStore";

/**
 * R13 §3:功能气泡的宿主。把 feed / 流水线 / 工作区 store 折成 `GuideSignals` 喂给 guides store,
 * 再把唯一的 active 画成一个 `Guide`。播放器「播完」由 Monitor 用 `notePlayerStatus` 报上来。
 * 壳里只挂一次;各栏不各自挂。
 */
export function GuideHost(): JSX.Element | null {
  const feed = useClipsFeed();
  const pipeline = usePipeline();
  const pinned = useHomePinned();
  const selection = useWorkspace((state) => state.selection);
  const openDrawer = useWorkspace((state) => state.openDrawer);
  const workspaceMode = useWorkspace((state) => state.workspaceMode);
  const { active, seen, signals } = useGuides();

  useEffect(() => {
    void hydrateGuides();
  }, []);

  const selectedClip = selection?.kind === "clip" ? feed.clipsById.get(selection.clipId) : undefined;
  const selectedClipHasSuggestions = selectedClip?.has_suggestions === true;
  const inWorkspace = !feed.loading && !homeVisible({ loading: feed.loading, clipCount: feed.clips.length, pinned });
  const bandHasShots = (feed.storyboard?.items ?? []).length > 0;
  const gapVisible = feed.gaps.some((gap) => gap.status === "open" || gap.status === "requested");

  useEffect(() => {
    reportGuideSignals({
      inWorkspace,
      photoWorkspace: workspaceMode === "photo",
      selectedClipHasSuggestions,
      pipelineStep: pipeline.step,
      bandHasShots,
      gapVisible,
      exportDrawerOpen: openDrawer === "deliver",
      overlayOpen: openDrawer !== null,
      // R18 F1:还有素材在排队 / 分析 = 后台在干活,完成通知就在后面 —— 这只气泡要赶在它前面。
      backgroundRunning: pipeline.counts.analysisPending > 0,
    });
  }, [inWorkspace, workspaceMode, selectedClipHasSuggestions, pipeline.step, bandHasShots, gapVisible, openDrawer, pipeline.counts.analysisPending]);

  const onDismiss = useCallback(() => {
    if (active !== null) dismissGuide(active);
  }, [active]);
  const onAnchorMissing = useCallback(() => {
    if (active !== null) snoozeGuide(active);
  }, [active]);
  const onTry = useCallback(() => {
    const event = active === null ? undefined : GUIDES[active].tryEvent;
    if (event) window.dispatchEvent(new CustomEvent(event));
  }, [active]);

  if (active === null) return null;
  const spec = GUIDES[active];
  return (
    <Guide
      key={active}
      anchor={spec.anchor}
      text={spec.text}
      side={spec.side}
      tryLabel={spec.tryLabel}
      onTry={spec.tryEvent ? onTry : undefined}
      onDismiss={onDismiss}
      onAnchorMissing={onAnchorMissing}
      // 2026-09-19 frozen-video:播放中、气泡又压到画面躲不开时,气泡让位而不是藏画面。
      yieldWhilePlaying={signals.playing === true}
      // Y-05:编号按看到的顺序数,不是固定表里的序号(真机上看到 1 → 3 → 4 → 2 像漏看了)。
      counter={`${Math.min(seen + 1, GUIDE_ORDER.length)}/${GUIDE_ORDER.length}`}
    />
  );
}
