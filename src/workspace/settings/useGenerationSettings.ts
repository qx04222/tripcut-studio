import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import {
  clearMinimaxKey as clearMinimaxKeyApi,
  generationAvailability,
  generationLedgerSummary,
  hasMinimaxKey,
  setMinimaxKey,
  type GenerationAvailability,
  type GenerationLedgerSummary,
  type SettingsMap,
} from "../../api";
import { MINIMAX_MODEL_RESOLUTIONS, MINIMAX_MONTHLY_BUDGET_MAX, clampMinimaxBudgetInput } from "./settingsModel";
import { failureText } from "../errorText";

type Settled<T> = PromiseSettledResult<T>;
type Save = (key: string, value: string) => Promise<boolean>;

export interface GenerationSettings {
  minimaxHasKey: boolean;
  minimaxKeyDraft: string;
  setMinimaxKeyDraft(value: string): void;
  minimaxKeyBusy: boolean;
  minimaxKeyNotice: string | null;
  minimaxBudgetClampNote: string | null;
  generationStatus: GenerationAvailability | null;
  generationLedger: GenerationLedgerSummary | null;
  refreshGeneration(): Promise<void>;
  saveMinimaxKey(): Promise<void>;
  clearMinimaxKey(): Promise<void>;
  saveMinimaxEnabled(enabled: boolean): Promise<void>;
  saveMinimaxModel(model: string): Promise<void>;
  saveMinimaxResolution(resolution: string): Promise<void>;
  saveMinimaxBudget(raw: string): Promise<void>;
  /** 首次载入时把三条 allSettled 结果落进状态(失败的那条保持默认)。 */
  applyLoaded(
    hasKey: Settled<boolean>,
    availability: Settled<GenerationAvailability>,
    ledger: Settled<GenerationLedgerSummary>,
  ): void;
}

/**
 * 云端补镜(MiniMax)那一段状态与动作,逐字迁自 SettingsPage.tsx。Key 只经 `setMinimaxKey`
 * 写进钥匙串,保存后草稿立刻清空——状态里从不留已保存的值,界面也就无从回显。
 */
export function useGenerationSettings(
  saveRef: MutableRefObject<Save>,
  settingsRef: MutableRefObject<SettingsMap>,
  setSettings: Dispatch<SetStateAction<SettingsMap>>,
): GenerationSettings {
  const [minimaxHasKey, setMinimaxHasKey] = useState(false);
  const [minimaxKeyDraft, setMinimaxKeyDraft] = useState("");
  const [minimaxKeyBusy, setMinimaxKeyBusy] = useState(false);
  const [minimaxKeyNotice, setMinimaxKeyNotice] = useState<string | null>(null);
  const [generationStatus, setGenerationStatus] = useState<GenerationAvailability | null>(null);
  const [generationLedger, setGenerationLedger] = useState<GenerationLedgerSummary | null>(null);
  const [minimaxBudgetClampNote, setMinimaxBudgetClampNote] = useState<string | null>(null);

  const refreshGeneration = useCallback(async () => {
    const [nextHasKey, nextAvailability, nextLedger] = await Promise.all([
      hasMinimaxKey(),
      generationAvailability(),
      generationLedgerSummary(),
    ]);
    setMinimaxHasKey(nextHasKey);
    setGenerationStatus(nextAvailability);
    setGenerationLedger(nextLedger);
  }, []);
  const saveMinimaxKey = useCallback(async () => {
    // R10 U-34:空 Key 点「保存」要有话说,此前按钮禁用、什么都不发生。
    if (minimaxKeyDraft.trim().length === 0) {
      setMinimaxKeyNotice("请先粘贴 MiniMax API Key，再保存。");
      return;
    }
    setMinimaxKeyBusy(true);
    setMinimaxKeyNotice(null);
    try {
      await setMinimaxKey(minimaxKeyDraft);
      setMinimaxKeyDraft("");
      await refreshGeneration();
      setMinimaxKeyNotice("已保存");
    } catch (error) {
      setMinimaxKeyNotice(failureText("保存 Key", error));
    } finally {
      setMinimaxKeyBusy(false);
    }
  }, [minimaxKeyDraft, refreshGeneration]);

  const clearMinimaxKey = useCallback(async () => {
    setMinimaxKeyBusy(true);
    setMinimaxKeyNotice(null);
    try {
      await clearMinimaxKeyApi();
      setMinimaxKeyDraft("");
      await refreshGeneration();
      setMinimaxKeyNotice("已清除");
    } catch (error) {
      setMinimaxKeyNotice(failureText("清除 Key", error));
    } finally {
      setMinimaxKeyBusy(false);
    }
  }, [refreshGeneration]);

  const applyLoaded = useCallback((
    hasKey: Settled<boolean>,
    availability: Settled<GenerationAvailability>,
    ledger: Settled<GenerationLedgerSummary>,
  ) => {
    if (hasKey.status === "fulfilled") setMinimaxHasKey(hasKey.value);
    if (availability.status === "fulfilled") setGenerationStatus(availability.value);
    if (ledger.status === "fulfilled") setGenerationLedger(ledger.value);
  }, []);

  const saveMinimaxEnabled = useCallback(async (enabled: boolean) => {
    await saveRef.current("minimax_enabled", String(enabled));
    await refreshGeneration();
    // R10 U-34:没有 Key 也允许打开(先开开关再配 Key 是常见顺序),但要说清现在还不能用。
    setMinimaxKeyNotice(enabled && !minimaxHasKey ? "已启用，但还没有 API Key——生成请求会被拒绝；请在下方保存 Key。" : null);
  }, [saveRef, refreshGeneration, minimaxHasKey]);

  const saveMinimaxModel = useCallback(async (model: string) => {
    const resolutions = MINIMAX_MODEL_RESOLUTIONS[model] ?? [];
    const currentResolution = settingsRef.current.minimax_resolution;
    await saveRef.current("minimax_model", model).then(refreshGeneration);
    if (resolutions.length > 0 && !resolutions.includes(currentResolution)) {
      await saveRef.current("minimax_resolution", resolutions[0]!).then(refreshGeneration);
    }
  }, [saveRef, refreshGeneration]);

  const saveMinimaxResolution = useCallback(async (resolution: string) => {
    await saveRef.current("minimax_resolution", resolution);
    await refreshGeneration();
  }, [saveRef, refreshGeneration]);

  const saveMinimaxBudget = useCallback(async (raw: string) => {
    const { value, clamped } = clampMinimaxBudgetInput(raw);
    setSettings((current) => ({ ...current, minimax_monthly_budget_usd: String(value) }));
    setMinimaxBudgetClampNote(
      clamped ? `月度预算已从 ${raw} 调整为 ${value}（上限 ${MINIMAX_MONTHLY_BUDGET_MAX} 美元）` : null,
    );
    await saveRef.current("minimax_monthly_budget_usd", String(value));
    await refreshGeneration();
  }, [saveRef, refreshGeneration]);

  return {
    minimaxHasKey,
    minimaxKeyDraft,
    setMinimaxKeyDraft,
    minimaxKeyBusy,
    minimaxKeyNotice,
    minimaxBudgetClampNote,
    generationStatus,
    generationLedger,
    refreshGeneration,
    saveMinimaxKey,
    clearMinimaxKey,
    saveMinimaxEnabled,
    saveMinimaxModel,
    saveMinimaxResolution,
    saveMinimaxBudget,
    applyLoaded,
  };
}
