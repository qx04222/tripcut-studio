import type {
  AppInfo,
  ComponentStatus,
  DeviceClockSetting,
  GenerationAvailability,
  GenerationLedgerSummary,
  LlmLedgerEntry,
  LlmStatus,
  SettingsMap,
  SettingsStatus,
} from "../../api";

export interface SettingsForm {
  settings: SettingsMap;
  settingsLoaded: boolean;
  notice: string;
  rollbackNotice: string | null;
  busy: boolean;
  status: SettingsStatus | null;
  componentStatuses: ComponentStatus[];
  appInfo: AppInfo | null;
  llmStatus: LlmStatus | null;
  llmLedger: LlmLedgerEntry[];
  minimaxHasKey: boolean;
  minimaxKeyDraft: string;
  setMinimaxKeyDraft(value: string): void;
  minimaxKeyBusy: boolean;
  minimaxKeyNotice: string | null;
  minimaxBudgetClampNote: string | null;
  generationStatus: GenerationAvailability | null;
  generationLedger: GenerationLedgerSummary | null;
  deviceClocks: DeviceClockSetting[];
  clockDrafts: Record<string, string>;
  setClockDraft(model: string, value: string): void;
  cacheConfirm: boolean;
  workspaceV2: boolean;
  /** 只改本地草稿(路径框 / 预算框逐字输入),不落盘。 */
  setDraft(key: string, value: string): void;
  /** 版本号 + 串行队列 + 失败回滚 + appearance 立即应用;返回"这次写入落盘了没有"。 */
  save(key: string, value: string): Promise<boolean>;
  savePath(key: string, value: string): Promise<void>;
  saveWhisperTier(value: string): Promise<void>;
  saveLlmBudget(raw: string): Promise<void>;
  setLlmEnabled(enabled: boolean): Promise<void>;
  saveLlmProvider(provider: string): Promise<void>;
  saveMinimaxEnabled(enabled: boolean): Promise<void>;
  saveMinimaxModel(model: string): Promise<void>;
  saveMinimaxResolution(resolution: string): Promise<void>;
  saveMinimaxBudget(raw: string): Promise<void>;
  saveMinimaxKey(): Promise<void>;
  clearMinimaxKey(): Promise<void>;
  saveDeviceClock(model: string): Promise<void>;
  runSelfCheck(): Promise<void>;
  openLogs(): Promise<void>;
  clearCache(): Promise<void>;
  rollbackTool(componentId: string): Promise<void>;
  toggleWorkspaceFlag(): Promise<void>;
  refreshStatus(): Promise<void>;
  refreshLlm(): Promise<void>;
  refreshGeneration(): Promise<void>;
}
