import { useCallback, useEffect, useId, useRef, useState, type JSX } from "react";

import { autoSelectEpisode, getCurrentEpisode, listPlatformPresets, type AutoSelectOutcome, type AutoSelectScope } from "../api";
import { OPEN_AUTO_SELECT_EVENT } from "./onboarding";
import { refreshClipsFeed } from "./useClipsFeed";
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

/** toast 文案:「已挑选 n 段 · 共 m s · 覆盖 k 章」。 */
export function autoSelectToast(outcome: AutoSelectOutcome): string {
  return `已挑选 ${outcome.created.length} 段 · 共 ${Math.round(outcome.total_secs)} s · 覆盖 ${outcome.chapters_covered} 章`;
}

/** 当前集的平台预算(秒);拉不到就用兜底。 */
export async function platformBudgetSecs(): Promise<number> {
  try {
    const [episode, presets] = await Promise.all([getCurrentEpisode(), listPlatformPresets()]);
    const preset = presets.find((item) => item.platform === episode.target_platform);
    if (!preset || preset.tb_den <= 0) return AUTO_SELECT_FALLBACK_BUDGET_SECS;
    const seconds = Math.round((preset.duration_budget_ticks * preset.tb_num) / preset.tb_den);
    return seconds > 0 ? seconds : AUTO_SELECT_FALLBACK_BUDGET_SECS;
  } catch {
    return AUTO_SELECT_FALLBACK_BUDGET_SECS;
  }
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
  onOutcome(outcome: AutoSelectOutcome): void;
  onError(message: string): void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<AutoSelectScope>(AUTO_SELECT_DEFAULT_SCOPE);
  const [budget, setBudget] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const budgetId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // R11 简化专项 #1:首启三步引导的「自动挑选」按钮从预览区广播这个事件,面板直接打开。
    const onOpen = () => {
      if (!disabled) setOpen(true);
    };
    window.addEventListener(OPEN_AUTO_SELECT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_AUTO_SELECT_EVENT, onOpen);
  }, [disabled]);

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

  const run = useCallback(async () => {
    const seconds = Number.parseInt(budget, 10);
    setBusy(true);
    try {
      const outcome = await autoSelectEpisode({ scope, budgetSecs: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined });
      setOpen(false);
      onOutcome(outcome);
      await refreshClipsFeed(true);
    } catch (error) {
      onError(failureText("自动挑选", error, "先让画面分析跑完,再试一次"));
    } finally {
      setBusy(false);
    }
  }, [budget, scope, onOutcome, onError]);

  return (
    <div className="band-autoselect" ref={rootRef}>
      <Button
        variant="secondary"
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
          <Button variant="primary" size="sm" busy={busy} disabled={busy} onClick={() => void run()}>
            开始挑选
          </Button>
        </div>
      ) : null}
    </div>
  );
}
