import { useSyncExternalStore } from "react";

import { getSettings, setSetting, type PlayerStatus } from "../api";
import { isAtEnd } from "./MonitorSeekBar";
import type { PipelineStep } from "./pipelineModel";

/**
 * R13 §3(车道 B):剪映式功能气泡。每个 guide 锚到一个界面元素,一段话 + 「知道了」+ 可选「试试」;
 * 只弹一次(键 `guide.<id>.viewed`,Rust 白名单按前缀 `guide.` 放行);同一时刻最多一个。
 * 触发条件是下面这张纯函数表 —— 谁先满足谁先出,按 `GUIDE_ORDER` 定序。
 */
export const GUIDE_IDS = ["nav", "photo", "notify", "heat", "autoselect", "shot", "gap", "export", "autoplay", "models"] as const;
export type GuideId = (typeof GUIDE_IDS)[number];

export function guideKey(id: GuideId): string {
  return `guide.${id}.viewed`;
}

/** 触发信号:由 GuideHost 从 feed / 流水线 / 工作区 store 推导,纯数据。 */
export interface GuideSignals {
  /** 首页没盖住、素材已读回 —— 用户真的在看工作区。 */
  inWorkspace: boolean;
  /** R21:当前是独立照片工作台；照片入口气泡绝不在视频工作台出现。 */
  photoWorkspace?: boolean;
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
  /** R18 F1:后台真的在分析素材 —— 完成通知即将发出,也是要系统通知权限的时机。 */
  backgroundRunning: boolean;
  /** R19 P-06(models 车道):清单里有这一档推荐、允许装、还没装也没在下的模型(由 modelStore 报)。
   *  可选:追加的信号不逼着既有的字面量对象都补一项。 */
  modelInstallSuggested?: boolean;
  /** 2026-09-19 frozen-video:播放器正在放(ready 且未暂停)。气泡压到画面又躲不开时据此让位,
   *  不再为了一只气泡把原生画面藏掉。可选,同上。 */
  playing?: boolean;
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
  backgroundRunning: false,
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
  photo: {
    text: "这里挑照片，那边挑视频。",
    anchor: '[data-guide="photo-workspace"], .photo-workspace',
    side: "bottom",
    when: (s) => s.inWorkspace && s.photoWorkspace === true,
  },
  // R18 车道 settings F1:通知权限的前置说明。macOS 只在第一次 `show()` 时弹权限框,
  // 那一刻用户如果没读过任何说明,本能就会点「不允许」,之后所有通知永久失效且软件不会再问。
  // 所以在后台真的开始干活、第一条通知发出去之前,先用一只气泡把「会通知什么 / 系统会问你」说清楚。
  notify: {
    text: "导出和批量分析完成时,软件会用系统通知提醒你一声;接下来系统会问你要不要允许。不想被打扰,可以在「设置 › 隐私与诊断」里关掉。",
    anchor: '[data-guide="notify"], .workspace-status',
    side: "top",
    when: (s) => s.inWorkspace && s.backgroundRunning,
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
  // R19 P-06(models 车道):首启按内存档提一句装模型。≥ 16 GB 推画面理解 + 转写默认档,≤ 8 GB 只推
  // 转写低内存档——「推荐哪几个」由后端清单按档位算好(ModelCard.recommended),这里只管出不出;
  // 「安装」= 与设置页模型卡同一个入口(modelStore.installRecommendedModels),后台下载,进度在状态条。
  models: {
    text: "装上「画面理解」和转写模型,搜索和挑选会更准。点「安装」后台下载,不影响你继续用;装完自动启用。",
    anchor: '[data-guide="models"], .workspace-status',
    tryLabel: "安装",
    tryEvent: "tripcut:install-models",
    side: "top",
    when: (s) => s.inWorkspace && s.modelInstallSuggested === true,
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
// R19 U-02:教学仲裁器。提示条 / 气泡 / 首启卡 / 空态卡四路教学归这一个 store,同一帧只出一个
// (DOM 上只有一个 `[data-teach]`)。顺序 = 用户在流水线上遇到它们的顺序:首启卡(库空、第一眼)→
// 当前步的空态卡 → 功能气泡;「知道了」把自己的 want 撤掉,槽就推进到下一路。
// `hint`(导航条下的提示条)不再拿槽:它的四句文案由首页四步卡 + 主按钮 tooltip 承接(shell 车道删 PipelineHint)。
// ---------------------------------------------------------------------------
export const TEACHING_CHANNELS = ["onboarding", "empty", "guide", "hint"] as const;
export type TeachingChannel = (typeof TEACHING_CHANNELS)[number];
export type TeachingWants = Readonly<Record<TeachingChannel, boolean>>;

/** 永远不拿槽的通道(文案已被别处承接)。 */
const TEACHING_SUPERSEDED: ReadonlySet<TeachingChannel> = new Set(["hint"]);

/** 纯判定:谁拿到这一帧的教学槽。 */
export function activeTeaching(wants: TeachingWants): TeachingChannel | null {
  for (const channel of TEACHING_CHANNELS) {
    if (TEACHING_SUPERSEDED.has(channel)) continue;
    if (wants[channel]) return channel;
  }
  return null;
}

const EMPTY_WANTS: TeachingWants = { onboarding: false, empty: false, guide: false, hint: false };
let teachingWants: TeachingWants = EMPTY_WANTS;
let teachingActive: TeachingChannel | null = null;
const teachingListeners = new Set<() => void>();

/** 某一路教学报「我现在想出 / 不想出」;guide 这一路由 store 自己按 nextGuide 报。 */
export function reportTeachingWant(channel: Exclude<TeachingChannel, "guide">, wants: boolean): void {
  if (teachingWants[channel] === wants) return;
  teachingWants = { ...teachingWants, [channel]: wants };
  recompute();
}

function getTeachingActive(): TeachingChannel | null {
  return teachingActive;
}

function subscribeTeaching(listener: () => void): () => void {
  teachingListeners.add(listener);
  return () => {
    teachingListeners.delete(listener);
  };
}

/** 这一路此刻是否拿到槽(拿到才渲染、才挂 `data-teach`)。 */
export function useTeaching(channel: TeachingChannel): boolean {
  return useSyncExternalStore(subscribeTeaching, getTeachingActive, getTeachingActive) === channel;
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
/** 气泡自己想出的那一只(仲裁前);`snapshot.active` 是仲裁后真正画出来的。 */
let candidate: GuideId | null = null;
const listeners = new Set<() => void>();

function seenCount(): number {
  let count = 0;
  for (const id of GUIDE_IDS) if (viewed?.has(guideKey(id)) || dismissed.has(id)) count += 1;
  return count;
}

function recompute(): void {
  // 正在显示的气泡不被后来的信号换掉;只有它关掉 / 让位 / 被抽屉盖住后才重新挑。
  const keep = candidate !== null && !dismissed.has(candidate) && !snoozed.has(candidate) && eligible(candidate, signals);
  candidate = keep ? candidate : nextGuide(signals, viewed, dismissed, snoozed);
  // R19 U-02:气泡只是四路教学之一 —— 先过仲裁器,槽不在 guide 这一路时 active 为 null(候选保留,轮到时再画)。
  teachingWants = teachingWants.guide === (candidate !== null) ? teachingWants : { ...teachingWants, guide: candidate !== null };
  const nextTeaching = activeTeaching(teachingWants);
  if (nextTeaching !== teachingActive) {
    teachingActive = nextTeaching;
    for (const listener of [...teachingListeners]) listener();
  }
  const active = teachingActive === "guide" ? candidate : null;
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
  const playing = status !== null && status.phase === "ready" && !status.paused;
  const patch: Partial<GuideSignals> = { playing };
  if (!signals.playbackEnded && isAtEnd(status)) patch.playbackEnded = true;
  reportGuideSignals(patch);
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
  candidate = null;
  teachingWants = EMPTY_WANTS;
  teachingActive = null;
}
