import { useCallback, useEffect, useId, useRef, useState, type JSX } from "react";

import {
  autoSelectEpisode,
  getCurrentEpisode,
  getMomentsProgress,
  listPlatformPresets,
  type AutoSelectOutcome,
  type AutoSelectScope,
  type ClipListItem,
} from "../api";
import { PLATFORM_LABELS } from "../EpisodePanel";
import { OPEN_AUTO_SELECT_EVENT } from "./onboarding";
import { refreshClipsFeed, useClipsFeed } from "./useClipsFeed";
import { Button, Chip } from "./ui";
import { failureText } from "./errorText";

/** 平台预算拉不到时的兜底(秒)。 */
export const AUTO_SELECT_FALLBACK_BUDGET_SECS = 30;

/**
 * 范围 chips:默认「收藏 + ≥3 星」(业主原则:第一次用直接按就行)。
 * V-02:这枚 chip 发 `favorites_or_rated3`(并集);`rated3` 在 Rust 里是纯 ≥3 星,
 * 真机上 3 条只收藏不评星的素材因此一条都没被挑到。
 */
export const AUTO_SELECT_SCOPES: ReadonlyArray<{ scope: AutoSelectScope; label: string }> = [
  { scope: "favorites", label: "只看收藏" },
  { scope: "favorites_or_rated3", label: "收藏 + 3 星以上" },
  { scope: "all", label: "全部素材" },
];
export const AUTO_SELECT_DEFAULT_SCOPE: AutoSelectScope = "favorites_or_rated3";

/**
 * X-01:默认 chip 按库状态推导——一条收藏或 ≥3 星都没有的库(全新库)预选「全部素材」,
 * 否则才是「收藏 + 3 星以上」。后端对默认范围还有一道兜底降级(`fell_back`)。
 */
export function defaultScopeFor(clips: readonly Pick<ClipListItem, "binary_rating" | "star_rating">[]): AutoSelectScope {
  const curated = clips.some((clip) => clip.binary_rating === 1 || (clip.star_rating ?? 0) >= 3);
  return curated ? AUTO_SELECT_DEFAULT_SCOPE : "all";
}

/**
 * R19 U-01:挑选结果再带一个「还有几条在分析」—— 分析没跑完也能先挑已分析的部分,toast 要说清剩余数。
 * 只是给 toast 用的前端附加字段,后端 `AutoSelectOutcome` 不变。
 */
export type AutoSelectResult = AutoSelectOutcome & {
  pending_left?: number;
  /** R19 U-09:首次零决定 —— 没弹面板直接按全部 + 平台预算跑的;toast 要给「改范围 / 改时长」入口并写明预算来源。 */
  first_run?: boolean;
  budget_secs?: number;
  platform_label?: string;
};

/** R19 U-09:第一次(库里无收藏、无星、还没挑过)不该让用户做决定 —— 直接跑。 */
export function isFirstAutoSelect(clips: readonly Pick<ClipListItem, "binary_rating" | "star_rating" | "select_count">[]): boolean {
  return clips.length > 0 && defaultScopeFor(clips) === "all" && clips.every((clip) => (clip.select_count ?? 0) === 0);
}

/** `tripcut:open-auto-select` 的可选 detail:toast 的「改范围 / 改时长」带 `panel: true` 直接开面板。 */
export const OPEN_AUTO_SELECT_PANEL_DETAIL = { panel: true } as const;

/** U-09:首次零决定的结果 toast 多一个次要动作「改范围 / 改时长」= 开面板(决定留在结果之后,不在结果之前)。 */
export function autoSelectToastActions(outcome: AutoSelectResult): { label: string; onClick(): void }[] {
  if (!outcome.first_run) return [];
  return [{ label: "改范围 / 改时长", onClick: () => window.dispatchEvent(new CustomEvent(OPEN_AUTO_SELECT_EVENT, { detail: OPEN_AUTO_SELECT_PANEL_DETAIL })) }];
}

/** 还在排队 / 分析中的素材数(与 pipelineModel 同一条判定)。 */
export function pendingAnalysisCount(clips: readonly Pick<ClipListItem, "analysis_status">[]): number {
  return clips.filter((clip) => clip.analysis_status === "pending" || clip.analysis_status === "running").length;
}

/** toast 文案:「已挑选 n 段 · 共 m s · 覆盖 k 章」;后端降级到「全部」时先说明为什么;分析没跑完时补一句剩余数。 */
export function autoSelectToast(outcome: AutoSelectResult): string {
  // U-09:首次零决定时时长写明来源「共 45 s(本集平台:抖音)」—— 用户从没被问过平台,这里说清 30/45 秒从哪来。
  const secs = outcome.first_run && outcome.budget_secs ? `共 ${outcome.budget_secs} s(本集平台:${outcome.platform_label ?? "通用"})` : `共 ${Math.round(outcome.total_secs)} s`;
  const tail = `${secs}${outcome.first_run ? "" : " "}· 覆盖 ${outcome.chapters_covered} 章`;
  const left = outcome.pending_left && outcome.pending_left > 0 ? ` · 还有 ${outcome.pending_left} 条在分析,分析完可再挑一次` : "";
  if (outcome.fell_back) return `你还没收藏或打星,已按全部素材挑了 ${outcome.created.length} 段 · ${tail}${left}`;
  return `已挑选 ${outcome.created.length} 段 · ${tail}${left}`;
}

/** X-02:失败时的「下一步」——分析真没跑完才劝等分析,否则用兜底「再试一次」。 */
export async function autoSelectNextStep(): Promise<string | undefined> {
  try {
    const progress = await getMomentsProgress();
    return progress.pending + progress.running > 0 ? "先让画面分析跑完,再试一次" : undefined;
  } catch {
    return undefined;
  }
}

/** 当前集的平台预算(秒)与平台名;拉不到就用兜底(平台名「通用」)。 */
export async function platformBudget(): Promise<{ seconds: number; platform: string }> {
  try {
    const [episode, presets] = await Promise.all([getCurrentEpisode(), listPlatformPresets()]);
    const platform = PLATFORM_LABELS[episode.target_platform] ?? "通用";
    const preset = presets.find((item) => item.platform === episode.target_platform);
    if (!preset || preset.tb_den <= 0) return { seconds: AUTO_SELECT_FALLBACK_BUDGET_SECS, platform };
    const seconds = Math.round((preset.duration_budget_ticks * preset.tb_num) / preset.tb_den);
    return { seconds: seconds > 0 ? seconds : AUTO_SELECT_FALLBACK_BUDGET_SECS, platform };
  } catch {
    return { seconds: AUTO_SELECT_FALLBACK_BUDGET_SECS, platform: "通用" };
  }
}

/** 当前集的平台预算(秒);拉不到就用兜底。 */
export async function platformBudgetSecs(): Promise<number> {
  return (await platformBudget()).seconds;
}

/**
 * R11 §1.2:镜头带工具条的「自动挑选精选段」。按钮 + 小面板(范围 chips · 预算一个数字 ·
 * 一个「开始挑选」),缺省值预填,第一次用直接按就行。结果交给镜头带做 toast(带「撤销这批」)。
 */
export function BandAutoSelect({
  disabled = false,
  onOutcome,
  onError,
}: {
  disabled?: boolean;
  onOutcome(outcome: AutoSelectResult): void;
  onError(message: string): void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // 用户没点过 chip 之前,范围跟着库状态走(X-01);点过就以用户的为准。
  const [chosenScope, setScope] = useState<AutoSelectScope | null>(null);
  const { clips } = useClipsFeed();
  const scope = chosenScope ?? defaultScopeFor(clips);
  const [budget, setBudget] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const budgetId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  // U-09:本会话已经零决定跑过一次 —— 之后再按主按钮就出面板(第二次才有「改一改」的需求)。
  const ranOnceRef = useRef(false);

  const run = useCallback(
    async (chosen: AutoSelectScope, seconds: number | undefined, first: { budget: number; platform: string } | null) => {
      setBusy(true);
      try {
        const outcome = await autoSelectEpisode({ scope: chosen, budgetSecs: seconds });
        setOpen(false);
        // Y-03:全新库(0 收藏 0 打星)按「全部」挑时,后端的 fell_back 永远走不到 —— 前端已经预选了「全部」。
        // 「为什么按全部」由前端按同一份库状态说清,toast 文案与后端降级一致。
        const uncurated = chosen === "all" && defaultScopeFor(clips) === "all";
        // R19 U-01:分析没跑完也先挑已分析的部分,剩余数写进 toast。
        const pendingLeft = pendingAnalysisCount(clips);
        onOutcome({
          ...outcome,
          fell_back: uncurated ? true : outcome.fell_back,
          pending_left: pendingLeft,
          ...(first ? { first_run: true, budget_secs: first.budget, platform_label: first.platform } : {}),
        });
        await refreshClipsFeed(true);
      } catch (error) {
        onError(failureText("自动挑选", error, await autoSelectNextStep()));
      } finally {
        setBusy(false);
      }
    },
    [clips, onOutcome, onError],
  );

  useEffect(() => {
    // R11 简化专项 #1:首启三步引导的「自动挑选」按钮从预览区广播这个事件,面板直接打开。
    // R19 U-09:第一次(无收藏无星没挑过)不弹面板 —— 直接按全部 + 平台预算跑,决定留给结果 toast 的「改范围 / 改时长」;
    // 带 `panel: true` 的事件(就是那个入口)与第二次以后照旧开面板。
    const onOpen = (event: Event) => {
      if (disabled) return;
      const wantsPanel = (event as CustomEvent<{ panel?: boolean } | undefined>).detail?.panel === true;
      if (!wantsPanel && !ranOnceRef.current && isFirstAutoSelect(clips)) {
        ranOnceRef.current = true;
        void platformBudget().then((budget) => run("all", budget.seconds, { budget: budget.seconds, platform: budget.platform }));
        return;
      }
      setOpen(true);
    };
    window.addEventListener(OPEN_AUTO_SELECT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_AUTO_SELECT_EVENT, onOpen);
  }, [disabled, clips, run]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void platformBudgetSecs().then((seconds) => {
      if (active) setBudget((current) => (current === "" ? String(seconds) : current));
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      active = false;
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const runFromPanel = useCallback(() => {
    const seconds = Number.parseInt(budget, 10);
    return run(scope, Number.isFinite(seconds) && seconds > 0 ? seconds : undefined, null);
  }, [budget, scope, run]);

  return (
    <div className="band-autoselect" ref={rootRef}>
      <Button
        // R18 V-15:镜头带工具条同一组里此前两种按钮样式(这颗描边 + 「一键排入」实心)。
        // 第 ③ 步的主动作只有「一键排入」一个,这颗降为 ghost。
        variant="ghost"
        size="sm"
        aria-label="自动挑选精选段"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        自动挑选精选段
      </Button>
      {open ? (
        <div className="band-autoselect-panel" role="group" aria-label="自动挑选精选段">
          <div className="band-autoselect-scope" role="group" aria-label="挑选范围">
            {AUTO_SELECT_SCOPES.map((item) => (
              <Chip key={item.scope} selected={scope === item.scope} onClick={() => setScope(item.scope)}>
                {item.label}
              </Chip>
            ))}
          </div>
          <label className="band-autoselect-budget" htmlFor={budgetId}>
            总时长约
            <input
              id={budgetId}
              type="number"
              min={5}
              step={5}
              inputMode="numeric"
              value={budget}
              placeholder={String(AUTO_SELECT_FALLBACK_BUDGET_SECS)}
              onChange={(event) => setBudget(event.currentTarget.value)}
            />
            秒(按发布平台预填)
          </label>
          <Button variant="primary" size="sm" busy={busy} disabled={busy} onClick={() => void runFromPanel()}>
            开始挑选
          </Button>
        </div>
      ) : null}
    </div>
  );
}
