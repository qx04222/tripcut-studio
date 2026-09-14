import { useSyncExternalStore } from "react";

import { getSettings, setSetting, type PlayerStatus } from "../api";
import { isAtEnd } from "./MonitorSeekBar";
import type { PipelineStep } from "./pipelineModel";

/**
 * R13 §3(车道 B):剪映式功能气泡。每个 guide 锚到一个界面元素,一段话 + 「知道了」+ 可选「试试」;
 * 只弹一次(键 `guide.<id>.viewed`,Rust 白名单按前缀 `guide.` 放行);同一时刻最多一个。
 * 触发条件是下面这张纯函数表 —— 谁先满足谁先出,按 `GUIDE_ORDER` 定序。
 */
export const GUIDE_IDS = ["nav", "heat", "autoselect", "shot", "gap", "export", "autoplay"] as const;
export type GuideId = (typeof GUIDE_IDS)[number];

export function guideKey(id: GuideId): string {
  return `guide.${id}.viewed`;
}

/** 触发信号:由 GuideHost 从 feed / 流水线 / 工作区 store 推导,纯数据。 */
export interface GuideSignals {
  /** 首页没盖住、素材已读回 —— 用户真的在看工作区。 */
  inWorkspace: boolean;
  /** 当前选中的素材带「有建议段」。 */
  selectedClipHasSuggestions: boolean;
  pipelineStep: PipelineStep | 0;
  /** 镜头带上已有至少一个镜块(排入后)。 */
  bandHasShots: boolean;
  /** 镜头带上出现了缺口卡。 */
  gapVisible: boolean;
  exportDrawerOpen: boolean;
  /** 任一抽屉 / 设置 sheet 开着(Y-06):工作区里的锚点都被盖住,只有锚在抽屉里的气泡能出。 */
  overlayOpen: boolean;
  /** 一条素材播到了末尾(锁存,见 notePlayerStatus)。 */
  playbackEnded: boolean;
}

export const EMPTY_GUIDE_SIGNALS: GuideSignals = {
  inWorkspace: false,
  selectedClipHasSuggestions: false,
  pipelineStep: 0,
  bandHasShots: false,
  gapVisible: false,
  exportDrawerOpen: false,
  overlayOpen: false,
  playbackEnded: false,
};

export interface GuideSpec {
  /** 气泡里的一段话(白话,不带术语)。 */
  text: string;
  /** 锚点选择器:优先 `[data-guide=id]`,其次既有的稳定选择器(不改别的车道的文件)。 */
  anchor: string;
  /** 可选「试试」:点了做什么(自定义事件名,GuideHost 派发)。 */
  tryLabel?: string;
  tryEvent?: string;
  /** 气泡落在锚点的哪一侧。 */
  side: "top" | "bottom";
  /** 锚点在抽屉里(Y-06):抽屉开着时照出;其余气泡在抽屉 / 设置开着时一律暂缓。 */
  inOverlay?: boolean;
  when(signals: GuideSignals): boolean;
}

export const GUIDES: Readonly<Record<GuideId, GuideSpec>> = {
  nav: {
    text: "这一条就是流程:导入 → 挑选 → 排列 → 导出。点任一步能跳过去;右上角永远有「下一步」。",
    anchor: '[data-guide="nav"], nav.pipeline-rail',
    side: "bottom",
    when: (s) => s.inWorkspace,
  },
  heat: {
    text: "这条彩色条是「精彩程度」:越亮越精彩。软件已经框出几段建议,按 Enter 直接采用。",
    anchor: '[data-guide="heat"], .monitor-heat',
    side: "top",
    when: (s) => s.inWorkspace && s.selectedClipHasSuggestions,
  },
  autoselect: {
    text: "不想一条条看?点「自动挑选」,软件按收藏和星级替你挑好片段。",
    anchor: '[data-guide="autoselect"], button[aria-label="自动挑选精选段"]',
    tryLabel: "试试自动挑选",
    tryEvent: "tripcut:open-auto-select",
    side: "top",
    when: (s) => s.inWorkspace && s.pipelineStep === 2,
  },
  shot: {
    text: "片段已经排进镜头带。拖动镜块,或用「往前 / 往后」调顺序;选中它就能在上面预览。",
    anchor: '[data-guide="shot"], .band-segment:not(.slot)',
    side: "top",
    when: (s) => s.inWorkspace && s.bandHasShots,
  },
  gap: {
    text: "这一格是「缺口」:这一章还差一个镜头。点卡片上的按钮,从挑好的片段里补一条就行。",
    anchor: '[data-guide="gap"], .band-segment.slot',
    side: "top",
    when: (s) => s.inWorkspace && s.gapVisible,
  },
  export: {
    text: "导出很简单:默认把片段导到一个文件夹;想整包交给别人再切「完整交付包」。",
    anchor: '[data-guide="export"], .deliver-drawer',
    side: "bottom",
    inOverlay: true,
    when: (s) => s.exportDrawerOpen,
  },
  autoplay: {
    text: "播完了。打开「连播」,播完会自动接着放下一条,像看片一样把素材过一遍。",
    anchor: '[data-guide="autoplay"], .monitor-auto-advance',
    side: "top",
    when: (s) => s.inWorkspace && s.playbackEnded,
  },
};

/** 定序 = 用户在流水线上遇到它们的顺序。 */
export const GUIDE_ORDER: readonly GuideId[] = GUIDE_IDS;

/** 此刻能不能出:条件满足,且没被抽屉盖住(Y-06)。 */
function eligible(id: GuideId, s: GuideSignals): boolean {
  const spec = GUIDES[id];
  if (s.overlayOpen && !spec.inOverlay) return false;
  return spec.when(s);
}

/**
 * 纯判定:该出哪一个。`viewed` 为 null = 设置还没读回来(一个都不出,免得闪一下再消失);
 * `dismissed` 本会话点过「知道了」;`snoozed` 锚点暂时不在(让位给后面的)。
 */
export function nextGuide(
  signals: GuideSignals,
  viewed: ReadonlySet<string> | null,
  dismissed: ReadonlySet<GuideId>,
  snoozed: ReadonlySet<GuideId>,
): GuideId | null {
  if (viewed === null) return null;
  for (const id of GUIDE_ORDER) {
    if (viewed.has(guideKey(id)) || dismissed.has(id) || snoozed.has(id)) continue;
    if (eligible(id, signals)) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// store(模块级,useSyncExternalStore):信号 + 已看 + 本会话关过 + 暂缓 → 恰好一个 active。
// ---------------------------------------------------------------------------
export interface GuideSnapshot {
  active: GuideId | null;
  signals: GuideSignals;
  /** 已看过几只(设置里已看 ∪ 本会话关过),编号按它数(Y-05):当前这只是第 `seen + 1` 只。 */
  seen: number;
}

let viewed: ReadonlySet<string> | null = null;
let dismissed: Set<GuideId> = new Set();
let snoozed: Set<GuideId> = new Set();
let signals: GuideSignals = EMPTY_GUIDE_SIGNALS;
let snapshot: GuideSnapshot = { active: null, signals, seen: 0 };
const listeners = new Set<() => void>();

function seenCount(): number {
  let count = 0;
  for (const id of GUIDE_IDS) if (viewed?.has(guideKey(id)) || dismissed.has(id)) count += 1;
  return count;
}

function recompute(): void {
  // 正在显示的气泡不被后来的信号换掉;只有它关掉 / 让位 / 被抽屉盖住后才重新挑。
  const keep = snapshot.active !== null && !dismissed.has(snapshot.active) && !snoozed.has(snapshot.active) && eligible(snapshot.active, signals);
  const active = keep ? snapshot.active : nextGuide(signals, viewed, dismissed, snoozed);
  const seen = seenCount();
  if (active === snapshot.active && signals === snapshot.signals && seen === snapshot.seen) return;
  snapshot = { active, signals, seen };
  for (const listener of [...listeners]) listener();
}

export function getGuideSnapshot(): GuideSnapshot {
  return snapshot;
}

export function subscribeGuides(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useGuides(): GuideSnapshot {
  return useSyncExternalStore(subscribeGuides, getGuideSnapshot, getGuideSnapshot);
}

/** 启动时读一次设置。读不到就当全看过 —— 宁可少一条,不能每次启动都重复出现。 */
export async function hydrateGuides(): Promise<void> {
  try {
    const settings = (await getSettings()) ?? {};
    const next = new Set<string>();
    for (const id of GUIDE_IDS) if (settings[guideKey(id)] === "true") next.add(guideKey(id));
    viewed = next;
  } catch {
    viewed = new Set(GUIDE_IDS.map(guideKey));
  }
  recompute();
}

export function reportGuideSignals(patch: Partial<GuideSignals>): void {
  let changed = false;
  const next = { ...signals };
  for (const key of Object.keys(patch) as (keyof GuideSignals)[]) {
    const value = patch[key];
    if (value === undefined || next[key] === value) continue;
    (next as Record<keyof GuideSignals, GuideSignals[keyof GuideSignals]>)[key] = value;
    changed = true;
  }
  if (!changed) return;
  signals = next;
  // 条件从真变假的暂缓项解除暂缓:下次条件再真时可以出。
  for (const id of [...snoozed]) if (!eligible(id, signals)) snoozed.delete(id);
  recompute();
}

/** 播放器状态一到末尾就锁存「播完过」;换素材后回到开头也不丢。 */
export function notePlayerStatus(status: PlayerStatus | null): void {
  if (signals.playbackEnded || !isAtEnd(status)) return;
  reportGuideSignals({ playbackEnded: true });
}

/** 「知道了」:本会话不再出,并把 `guide.<id>.viewed` 写成 true。 */
export function dismissGuide(id: GuideId): void {
  dismissed = new Set([...dismissed, id]);
  void setSetting(guideKey(id), "true").catch(() => undefined);
  recompute();
}

/** 锚点找不到(元素还没画出来 / 被折叠):先让位,不算看过。 */
export function snoozeGuide(id: GuideId): void {
  snoozed = new Set([...snoozed, id]);
  recompute();
}

/** 设置「关于」→「重置新手引导」:七把键写回 false,本会话的关过 / 暂缓全清。 */
export async function resetGuides(): Promise<void> {
  await Promise.all(GUIDE_IDS.map((id) => setSetting(guideKey(id), "false").catch(() => undefined)));
  viewed = new Set();
  dismissed = new Set();
  snoozed = new Set();
  recompute();
}

export function __resetGuidesForTests(): void {
  viewed = null;
  dismissed = new Set();
  snoozed = new Set();
  signals = EMPTY_GUIDE_SIGNALS;
  snapshot = { active: null, signals, seen: 0 };
}
