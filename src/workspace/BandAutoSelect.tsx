import { useCallback, useEffect, useId, useRef, useState, type JSX } from "react";

import {
  autoSelectEpisodeWith,
  getCurrentEpisode,
  getMomentsProgress,
  listPlatformPresets,
  undoAutoSelect,
  type AutoSelectOutcome,
  type AutoSelectParamsInput,
  type AutoSelectScope,
  type ClipListItem,
} from "../api";
import { PLATFORM_LABELS } from "../EpisodePanel";
import { OPEN_AUTO_SELECT_EVENT } from "./onboarding";
import { PromptInput } from "./results/PromptInput";
import { ResultsLayer, ResultsPanel } from "./results/ResultsPanel";
import { parseSelectPromptSmart, SELECT_PRESETS, SELECT_PROMPT_EVENT, toAutoSelectParams } from "./selectPrompt";
import { pushUndo, runUndoById } from "./undoStack";
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
  /** R19 P-03:这一批在全局撤销栈(⌘Z)里的那一条;toast 的「撤销」与面板的「全部撤销」都走它,撤过一次不再撤第二次。 */
  undo_id?: number;
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
  // U-09:首次零决定时补一句平台来源「共 44.6 s(本集平台:抖音,目标约 45 s)」——
  // F-R19-07:实际时长(`total_secs`,与结果面板/镜头带同一个字段)才是真数,预算(`budget_secs`)只是目标,
  // 之前把预算当成实际报给用户,首挑与后续面板对不上。
  const secs =
    outcome.first_run && outcome.budget_secs
      ? `共 ${outcome.total_secs.toFixed(1)} s(本集平台:${outcome.platform_label ?? "通用"},目标约 ${outcome.budget_secs} s)`
      : `共 ${Math.round(outcome.total_secs)} s`;
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
  // P-03:挑完打开结果面板(按 run id 列这一批);「全部撤销」= 撤销栈里这一批那一条。
  const [runId, setRunId] = useState<string | null>(null);
  const undoIdRef = useRef<number | null>(null);

  const run = useCallback(
    async (chosen: AutoSelectScope, seconds: number | undefined, first: { budget: number; platform: string } | null, extra: AutoSelectParamsInput = {}) => {
      setBusy(true);
      try {
        const outcome = await autoSelectEpisodeWith({ ...extra, scope: chosen, budgetSecs: seconds });
        setOpen(false);
        // P-03:整批进 ⌘Z 栈 —— 面板「全部撤销」、toast「撤销」、⌘Z 三条路同一个闭包,只跑一次。
        const undoId = pushUndo({
          label: `自动挑选 ${outcome.created.length} 段`,
          undo: async () => {
            await undoAutoSelect(outcome.batch_id);
            setRunId((current) => (current === (outcome.run_id ?? outcome.batch_id) ? null : current));
            await refreshClipsFeed(true);
          },
        });
        undoIdRef.current = undoId;
        setRunId(outcome.run_id ?? null);
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
          undo_id: undoId,
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

  // P-01:一句话 → 本地规则(LLM 可用时增强)→ 参数 → 同一条 run();范围没说就按库状态推导的那个。
  const runSentence = useCallback(
    async (sentence: string) => {
      const { parsed } = await parseSelectPromptSmart(sentence);
      const params = toAutoSelectParams(parsed, sentence, chosenScope ?? defaultScopeFor(clips));
      setRunId(null);
      await run(params.scope ?? "all", params.budgetSecs, null, { weights: params.weights, pick: params.pick, prompt: params.prompt });
    },
    [chosenScope, clips, run],
  );

  useEffect(() => {
    // 首页预设卡 / 其它入口广播一句话:直接跑,不弹面板。
    const onPrompt = (event: Event) => {
      if (disabled) return;
      const sentence = (event as CustomEvent<{ sentence?: string } | undefined>).detail?.sentence;
      if (typeof sentence === "string" && sentence.trim().length > 0) void runSentence(sentence);
    };
    window.addEventListener(SELECT_PROMPT_EVENT, onPrompt);
    return () => window.removeEventListener(SELECT_PROMPT_EVENT, onPrompt);
  }, [disabled, runSentence]);

  const closeResults = useCallback(() => setRunId(null), []);
  const undoAll = useCallback(async () => {
    const id = undoIdRef.current;
    if (id === null) return false;
    undoIdRef.current = null;
    return runUndoById(id);
  }, []);
  // 滑出层挂到镜头带栏上(与检查器滑出层同一套机制);单测里没有栏就原地渲染。
  const [bandRegion, setBandRegion] = useState<Element | null>(null);
  useEffect(() => {
    setBandRegion(rootRef.current?.closest('[data-pane="band"]') ?? null);
  }, []);

  return (
    <div className="band-autoselect" ref={rootRef}>
      <ResultsLayer open={runId !== null} container={bandRegion}>
        {runId !== null ? <ResultsPanel runId={runId} onClose={closeResults} onUndoAll={undoAll} onPrompt={(sentence) => void runSentence(sentence)} busy={busy} /> : null}
      </ResultsLayer>
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
          {/* P-01:一句话挑片放在面板最上面 —— 会说话就不用碰下面的 chips 和数字。 */}
          <PromptInput busy={busy} onSubmit={(sentence) => void runSentence(sentence)} />
          {/* P-09:三条预设句(旅行日记 / 电影感 / 快节奏)= 三句现成的 P-01。 */}
          <div className="band-autoselect-presets" role="group" aria-label="现成的三句">
            {SELECT_PRESETS.map((preset) => (
              <Chip key={preset.id} title={preset.sentence} disabled={busy} onClick={() => void runSentence(preset.sentence)}>
                {preset.label}
              </Chip>
            ))}
          </div>
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
          {/* F-R19-11:弹层开着时顶栏「下一步」仍是整屏唯一的实心主按钮(V-01),这颗降 secondary。 */}
          <Button variant="secondary" size="sm" busy={busy} disabled={busy} onClick={() => void runFromPanel()}>
            开始挑选
          </Button>
        </div>
      ) : null}
    </div>
  );
}
