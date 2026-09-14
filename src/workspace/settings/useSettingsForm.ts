import { useCallback, useEffect, useRef, useState } from "react";

import {
  clearCacheAndRebuild,
  generationAvailability,
  generationLedgerSummary,
  getAppInfo,
  getComponentStatuses,
  getLlmStatus,
  getSettings,
  getSettingsStatus,
  hasMinimaxKey,
  listDeviceClocks,
  listLlmLedger,
  openLogsDirectory,
  rollbackComponent,
  runClipSelfCheck,
  setDeviceClockOffset,
  setSetting,
  type AppInfo,
  type ComponentStatus,
  type DeviceClockSetting,
  type LlmLedgerEntry,
  type LlmStatus,
  type SettingsMap,
  type SettingsStatus,
} from "../../api";
import { DEFAULT_SETTINGS, applyAppearanceSettings } from "../../appearance";
import type { SettingsForm } from "./settingsFormTypes";
import { bytesLabel } from "./settingsModel";
import { useGenerationSettings } from "./useGenerationSettings";
import { describeError, failureText } from "../errorText";

export type { SettingsForm } from "./settingsFormTypes";

/**
 * 设置表单的全部状态与动作,逐段迁自 `src/SettingsPage.tsx`(载入、`save` 的版本号 +
 * 串行队列 + 失败回滚、MiniMax key、设备时钟、缓存、自检、日志)。
 * 文案一字不动——`SettingsSheet.test` 与 `useSettingsForm.test` 按原串断言。
 */
export function useSettingsForm(): SettingsForm {
  const [settings, setSettings] = useState<SettingsMap>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [componentStatuses, setComponentStatuses] = useState<ComponentStatus[]>([]);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [llmLedger, setLlmLedger] = useState<LlmLedgerEntry[]>([]);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [deviceClocks, setDeviceClocks] = useState<DeviceClockSetting[]>([]);
  const [clockDrafts, setClockDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("正在读取本地设置…");
  // R6 终审 P2:回滚的成败提示此前跟保存/日志/时钟/缓存共用同一个 `notice`——
  // 回滚一开始就会把用户刚看到的保存结果提示顶掉,回滚完成后的提示又会被
  // 紧接着的另一次保存悄悄盖掉。拆成独立状态,互不清除。
  const [rollbackNotice, setRollbackNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cacheConfirm, setCacheConfirm] = useState(false);
  const settingsRef = useRef<SettingsMap>(DEFAULT_SETTINGS);
  const confirmedSettingsRef = useRef<SettingsMap>(DEFAULT_SETTINGS);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveVersionRef = useRef(new Map<string, number>());

  const saveRef = useRef<(key: string, value: string) => Promise<boolean>>(async () => false);
  const generation = useGenerationSettings(saveRef, settingsRef, setSettings);
  const { applyLoaded: applyGenerationLoaded } = generation;

  const refreshStatus = useCallback(async () => {
    const next = await getSettingsStatus();
    setStatus(next);
  }, []);

  const refreshComponentStatuses = useCallback(async () => {
    const next = await getComponentStatuses();
    setComponentStatuses(next);
  }, []);

  const rollbackTool = useCallback(async (componentId: string) => {
    setBusy(true);
    setRollbackNotice("正在回滚到上一版…");
    try {
      const updated = await rollbackComponent(componentId);
      setComponentStatuses((current) => {
        const next = current.filter((entry) => entry.id !== updated.id);
        next.push(updated);
        return next;
      });
      await refreshStatus().catch(() => undefined);
      setRollbackNotice(`${updated.title} 已回滚到上一版`);
    } catch (error) {
      setRollbackNotice(failureText("回滚", error));
    } finally {
      setBusy(false);
    }
  }, [refreshStatus]);

  const refreshLlm = useCallback(async () => {
    const [nextStatus, nextLedger] = await Promise.all([getLlmStatus(), listLlmLedger()]);
    setLlmStatus(nextStatus);
    setLlmLedger(nextLedger);
  }, []);

  const refreshDeviceClocks = useCallback(async () => {
    const clocks = await listDeviceClocks();
    setDeviceClocks(clocks);
    setClockDrafts(Object.fromEntries(clocks.map((clock) => [
      clock.device_model,
      String(clock.journey_offset_ms / 1_000),
    ])));
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      getSettings(),
      getSettingsStatus(),
      getAppInfo(),
      getLlmStatus(),
      listLlmLedger(),
      listDeviceClocks(),
      getComponentStatuses(),
      hasMinimaxKey(),
      generationAvailability(),
      generationLedgerSummary(),
    ])
      .then(([
        savedResult,
        statusResult,
        infoResult,
        llmStatusResult,
        ledgerResult,
        clocksResult,
        componentsResult,
        minimaxKeyResult,
        generationStatusResult,
        generationLedgerResult,
      ]) => {
        if (!active) return;
        if (savedResult.status === "rejected") {
          setNotice(`核心设置读取失败：${String(savedResult.reason)}；编辑已停用`);
          return;
        }
        const saved = savedResult.value;
        const merged = { ...DEFAULT_SETTINGS, ...saved };
        settingsRef.current = merged;
        confirmedSettingsRef.current = merged;
        setSettings(merged);
        applyAppearanceSettings(merged);
        setSettingsLoaded(true);
        if (statusResult.status === "fulfilled") setStatus(statusResult.value);
        if (infoResult.status === "fulfilled") setAppInfo(infoResult.value);
        if (llmStatusResult.status === "fulfilled") setLlmStatus(llmStatusResult.value);
        if (ledgerResult.status === "fulfilled") setLlmLedger(ledgerResult.value);
        if (componentsResult.status === "fulfilled") setComponentStatuses(componentsResult.value);
        if (clocksResult.status === "fulfilled") {
          const clocks = clocksResult.value;
          setDeviceClocks(clocks);
          setClockDrafts(Object.fromEntries(clocks.map((clock) => [
            clock.device_model,
            String(clock.journey_offset_ms / 1_000),
          ])));
        }
        applyGenerationLoaded(minimaxKeyResult, generationStatusResult, generationLedgerResult);
        const optionalFailures = [
          statusResult,
          infoResult,
          llmStatusResult,
          ledgerResult,
          clocksResult,
          minimaxKeyResult,
          generationStatusResult,
          generationLedgerResult,
        ]
          .filter((result) => result.status === "rejected").length;
        setNotice(optionalFailures === 0
          ? "设置已从本地项目载入"
          : `核心设置已载入；${optionalFailures} 项状态暂时不可用，可稍后刷新`);
      });
    return () => {
      active = false;
    };
  }, [applyGenerationLoaded]);

  /**
   * 返回值是"这次写入落盘了没有"(R8 终审 M3)。界面开关必须先等到 true 才敢换壳——
   * 此前它 `void save(...)` 之后立刻广播换壳事件,写失败时壳照换,重启后又弹回去。
   */
  const save = useCallback(async (key: string, value: string): Promise<boolean> => {
    if (!settingsLoaded) {
      setNotice("核心设置尚未载入，暂不能编辑");
      return false;
    }
    const version = (saveVersionRef.current.get(key) ?? 0) + 1;
    saveVersionRef.current.set(key, version);
    setSettings((current) => {
      const next = { ...current, [key]: value };
      settingsRef.current = next;
      if (key.startsWith("appearance.")) applyAppearanceSettings(next);
      return next;
    });
    setNotice("正在保存…");
    try {
      const request = saveQueueRef.current.then(() => setSetting(key, value));
      saveQueueRef.current = request.catch(() => undefined);
      await request;
      confirmedSettingsRef.current = {
        ...confirmedSettingsRef.current,
        [key]: value,
      };
      setNotice(key === "performance.worker_count" ? "已保存,后台并行任务数将在重启后生效" : "已保存");
      return true;
    } catch (error) {
      if (saveVersionRef.current.get(key) === version) {
        setSettings((current) => {
          const confirmedValue = confirmedSettingsRef.current[key] ?? DEFAULT_SETTINGS[key] ?? "";
          const next = { ...current, [key]: confirmedValue };
          settingsRef.current = next;
          if (key.startsWith("appearance.")) applyAppearanceSettings(next);
          return next;
        });
      }
      setNotice(`保存失败:${describeError(error)}。再试一次`);
      return false;
    }
  }, [settingsLoaded]);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  const setDraft = useCallback((key: string, value: string) => {
    setSettings((current) => ({ ...current, [key]: value }));
  }, []);

  const savePath = useCallback(async (key: string, value: string) => {
    await save(key, value.trim());
    await refreshStatus().catch((error) => setNotice(failureText("检测工具", error)));
    await refreshComponentStatuses().catch(() => undefined);
  }, [save, refreshStatus, refreshComponentStatuses]);

  const saveWhisperTier = useCallback(async (value: string) => {
    await save("tools.whisper_model_tier", value);
    await refreshStatus();
  }, [save, refreshStatus]);

  const setLlmEnabled = useCallback(async (enabled: boolean) => {
    const current = settingsRef.current;
    if (enabled && (current.llm_provider === "none" || current.llm_provider === "auto")) {
      setNotice("请先明确锁定一个 LLM provider,再启用增强分析");
      return;
    }
    await save("llm_enabled", String(enabled));
    await refreshLlm();
  }, [save, refreshLlm]);

  const saveLlmProvider = useCallback(async (provider: string) => {
    await save("llm_provider", provider);
    await refreshLlm();
  }, [save, refreshLlm]);

  const saveLlmBudget = useCallback(async (value: string) => {
    const valid = /^\d+$/.test(value) && Number(value) <= 10_000;
    if (!valid) {
      const fallback = String(llmStatus?.monthly_budget ?? 200);
      setSettings((current) => ({ ...current, llm_monthly_budget: fallback }));
      setNotice("每月调用预算必须是 0–10000 的整数");
      return;
    }
    await save("llm_monthly_budget", value);
    await refreshLlm();
  }, [llmStatus, save, refreshLlm]);

  const runSelfCheck = useCallback(async () => {
    setBusy(true);
    setNotice("正在启动画面识别组件并自检…");
    try {
      const message = await runClipSelfCheck();
      setNotice(message);
      await refreshStatus();
    } catch (error) {
      console.error("clip self-check failed", error);
      setNotice("画面识别组件还没就绪。正式版不在线安装，请等待带签名的组件包。");
    } finally {
      setBusy(false);
    }
  }, [refreshStatus]);

  const openLogs = useCallback(async () => {
    setBusy(true);
    try {
      await openLogsDirectory();
      setNotice("已在访达中打开日志目录；panic 日志自动保留 7 天");
    } catch (error) {
      setNotice(failureText("打开日志目录", error, "可以在访达里手动找 ~/Library/Logs/TripCutStudio"));
    } finally {
      setBusy(false);
    }
  }, []);

  const clearCache = useCallback(async () => {
    if (!cacheConfirm) {
      setCacheConfirm(true);
      setNotice("请再点一次确认;素材、评分和片段都会留着,原片不会被删");
      return;
    }
    setBusy(true);
    setCacheConfirm(false);
    try {
      const result = await clearCacheAndRebuild();
      // R15:后端只换目录 + 重排任务就返回;旧文件由后台清理,预览由后台重新生成,进度在底栏。
      setNotice(
        `已清理 ${bytesLabel(result.removed_disk_bytes)} 缓存文件,后台正在重新生成 ${result.reset_jobs} 个预览文件;进度看底栏`,
      );
      await refreshStatus();
    } catch (error) {
      setNotice(failureText("重建缓存", error));
    } finally {
      setBusy(false);
    }
  }, [cacheConfirm, refreshStatus]);

  const setClockDraft = useCallback((deviceModel: string, value: string) => {
    setClockDrafts((current) => ({ ...current, [deviceModel]: value }));
  }, []);

  const saveDeviceClock = useCallback(async (deviceModel: string) => {
    const seconds = Number(clockDrafts[deviceModel]);
    if (!Number.isFinite(seconds)) {
      setNotice("设备时钟偏移必须是有效秒数");
      return;
    }
    setBusy(true);
    setNotice(`正在校正 ${deviceModel}…`);
    try {
      await setDeviceClockOffset(deviceModel, Math.round(seconds * 1_000));
      await refreshDeviceClocks();
      setNotice(`${deviceModel} 已按 Canonical Journey Time 重新排序`);
    } catch (error) {
      setNotice(failureText("校正设备时钟", error));
    } finally {
      setBusy(false);
    }
  }, [clockDrafts, refreshDeviceClocks]);

  return {
    settings,
    settingsLoaded,
    notice,
    rollbackNotice,
    busy,
    status,
    componentStatuses,
    appInfo,
    llmStatus,
    llmLedger,
    ...generation,
    deviceClocks,
    clockDrafts,
    setClockDraft,
    cacheConfirm,
    setDraft,
    save,
    savePath,
    saveWhisperTier,
    saveLlmBudget,
    setLlmEnabled,
    saveLlmProvider,
    saveDeviceClock,
    runSelfCheck,
    openLogs,
    clearCache,
    rollbackTool,
    refreshStatus,
    refreshLlm,
  };
}
