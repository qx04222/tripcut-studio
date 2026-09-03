import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";

import { HelpOverlay } from "./HelpOverlay";
import {
  clearCacheAndRebuild,
  getAppInfo,
  getLlmStatus,
  getSettings,
  getSettingsStatus,
  listDeviceClocks,
  listLlmLedger,
  openLogsDirectory,
  runClipSelfCheck,
  setSetting,
  setDeviceClockOffset,
  type AppInfo,
  type LlmLedgerEntry,
  type LlmStatus,
  type SettingsMap,
  type SettingsStatus,
  type ToolStatus,
  type DeviceClockSetting,
} from "./api";
import { HELP_FAQS, KEYBOARD_SHORTCUT_GROUPS, WORKFLOW_STEPS } from "./helpContent";
import { GENERATED_LICENSES } from "./licenses.generated";

export const DEFAULT_SETTINGS: SettingsMap = {
  "appearance.theme": "system",
  "appearance.ui_scale": "1.0",
  "performance.worker_count": "4",
  "performance.proxy_enabled": "true",
  "tools.ffmpeg_path": "",
  "tools.ffprobe_path": "",
  "tools.whisper_path": "",
  "tools.whisper_model_tier": "large-v3-turbo",
  "analysis.scene_threshold": "0.35",
  "analysis.similarity_threshold": "0.25",
  "analysis.jitter_threshold": "0.15",
  "best_take.weight.technical": "0.28",
  "best_take.weight.composition": "0.18",
  "best_take.weight.motion": "0.20",
  "best_take.weight.human": "0.14",
  "best_take.weight.audio": "0.12",
  "best_take.weight.narrative": "0.08",
  llm_enabled: "false",
  llm_provider: "none",
  llm_monthly_budget: "200",
};

const SCALE_DATA: Record<string, string> = {
  "0.9": "90",
  "1.0": "100",
  "1.15": "115",
  "1.3": "130",
};

const KEYBOARD_SHORTCUT_COUNT = KEYBOARD_SHORTCUT_GROUPS.reduce(
  (total, group) => total + group.shortcuts.length,
  0,
);

type SettingsSectionId = "appearance" | "performance" | "timeline" | "tools" | "analysis" | "about" | "cache";
type SettingsIconName = SettingsSectionId | "theme" | "scale" | "proxy" | "worker" | "model" | "clip" | "help";

export const SETTINGS_SECTIONS: ReadonlyArray<{
  id: SettingsSectionId;
  label: string;
  eyebrow: string;
  description: string;
}> = [
  { id: "appearance", label: "外观", eyebrow: "APPEARANCE", description: "主题与阅读尺度" },
  { id: "performance", label: "性能", eyebrow: "PERFORMANCE", description: "并发与代理文件" },
  { id: "timeline", label: "旅行时间", eyebrow: "JOURNEY TIME", description: "多设备时钟校正" },
  { id: "tools", label: "工具链", eyebrow: "TOOLCHAIN", description: "本地依赖与模型" },
  { id: "analysis", label: "分析与 AI", eyebrow: "ANALYSIS & AI", description: "阈值、预算与隐私" },
  { id: "about", label: "帮助与关于", eyebrow: "HELP & ABOUT", description: "指南、版本与许可" },
  { id: "cache", label: "缓存与重建", eyebrow: "CACHE & REBUILD", description: "可重建数据管理" },
] as const;

function SettingsIcon({ name }: { name: SettingsIconName }) {
  const paths: Record<SettingsIconName, ReactNode> = {
    appearance: <><circle cx="12" cy="12" r="7" /><path d="M12 5a7 7 0 0 0 0 14Z" /></>,
    performance: <><path d="M5 16a8 8 0 1 1 14 0" /><path d="m12 12 4-4" /><path d="M8 17h8" /></>,
    timeline: <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /><path d="M5 4v4H1" /></>,
    tools: <><path d="m14.5 6.5 3-3 3 3-3 3" /><path d="m16.5 8.5-9 9" /><path d="m8.5 15.5-2 5-3-3 5-2" /></>,
    analysis: <><path d="M4 18V9" /><path d="M10 18V5" /><path d="M16 18v-7" /><path d="M3 18h17" /></>,
    about: <><circle cx="12" cy="12" r="8" /><path d="M12 11v5" /><path d="M12 8h.01" /></>,
    cache: <><path d="M5 7c0-2 3-3 7-3s7 1 7 3-3 3-7 3-7-1-7-3Z" /><path d="M5 7v5c0 2 3 3 7 3s7-1 7-3V7" /><path d="M5 12v5c0 2 3 3 7 3s7-1 7-3v-5" /></>,
    theme: <><circle cx="12" cy="12" r="7" /><path d="M12 5v14" /></>,
    scale: <><path d="M5 8V5h3" /><path d="m5 5 4 4" /><path d="M19 8V5h-3" /><path d="m19 5-4 4" /><path d="M5 16v3h3" /><path d="m5 19 4-4" /><path d="M19 16v3h-3" /><path d="m19 19-4-4" /></>,
    proxy: <><rect x="4" y="6" width="16" height="12" rx="2" /><path d="m10 10 5 2-5 2Z" /></>,
    worker: <><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M19 9h3M2 15h3M19 15h3" /></>,
    model: <><path d="M7 7h10v10H7z" /><path d="M4 10h3M17 10h3M4 14h3M17 14h3M10 4v3M14 4v3M10 17v3M14 17v3" /></>,
    clip: <><path d="M8 4h8l3 4v8l-3 4H8l-3-4V8Z" /><path d="m9 12 2 2 4-5" /></>,
    help: <><circle cx="12" cy="12" r="8" /><path d="M9.8 9a2.3 2.3 0 0 1 4.4 1c0 2-2.2 2-2.2 4" /><path d="M12 17h.01" /></>,
  };

  return (
    <span className="settings-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        {paths[name]}
      </svg>
    </span>
  );
}

function SettingsRow({
  icon,
  title,
  description,
  children,
  className = "",
}: {
  icon: SettingsIconName;
  title: string;
  description: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`settings-row${className ? ` ${className}` : ""}`} data-setting-row>
      <SettingsIcon name={icon} />
      <div className="settings-row-copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

export function appearanceAttributes(settings: SettingsMap): {
  theme: "light" | "dark" | null;
  uiScale: string;
} {
  const theme = settings["appearance.theme"] ?? DEFAULT_SETTINGS["appearance.theme"];
  const scale = settings["appearance.ui_scale"] ?? DEFAULT_SETTINGS["appearance.ui_scale"];
  return {
    theme: theme === "light" || theme === "dark" ? theme : null,
    uiScale: SCALE_DATA[scale] ?? "100",
  };
}

export function llmLedgerStatusLabel(status: LlmLedgerEntry["status"]): string {
  switch (status) {
    case "running":
      return "调用中";
    case "succeeded":
      return "已成功";
    case "failed":
      return "调用失败";
    case "parse_failed":
      return "解析失败";
  }
}

export function llmLedgerPurposeLabel(purpose: string): string {
  switch (purpose) {
    case "ai_description":
      return "AI 描述";
    case "director_qa":
      return "导演问答";
    case "narrate_episode":
      return "叙事编排";
    default:
      return purpose;
  }
}

function clockSourceLabel(source: DeviceClockSetting["source"]): string {
  switch (source) {
    case "manual": return "人工校正";
    case "auto": return "高置信自动对齐";
    case "reference": return "参考设备";
    default: return "待校正";
  }
}

export function applyAppearanceSettings(settings: SettingsMap) {
  const root = document.documentElement;
  const appearance = appearanceAttributes(settings);
  if (appearance.theme) root.dataset.theme = appearance.theme;
  else delete root.dataset.theme;
  root.dataset.uiScale = appearance.uiScale;
}

function bytesLabel(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_024;
  let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function StatusPill({ available, children }: { available: boolean; children: string }) {
  return (
    <span className={available ? "settings-status ok" : "settings-status missing"}>
      <span aria-hidden="true" />
      {children}
    </span>
  );
}

function ToolReadout({ label, status }: { label: string; status: ToolStatus | undefined }) {
  return (
    <div className="tool-readout">
      <div>
        <strong>{label}</strong>
        <StatusPill available={status?.available ?? false}>
          {status?.available ? "已就绪" : "未找到"}
        </StatusPill>
      </div>
      <code>{status?.resolved_path || "等待检测"}</code>
      <small>{status?.version ?? status?.note ?? "读取版本首行确认工具可执行"}</small>
    </div>
  );
}

interface ThresholdRowProps {
  label: string;
  description: string;
  settingKey: string;
  value: string;
  defaultValue: string;
  min: string;
  max: string;
  step: string;
  onChange: (key: string, value: string) => void;
  deferCommit?: boolean;
}

function ThresholdRow({
  label,
  description,
  settingKey,
  value,
  defaultValue,
  min,
  max,
  step,
  onChange,
  deferCommit = false,
}: ThresholdRowProps) {
  const [draft, setDraft] = useState(value);
  const lastSubmittedRef = useRef(value);
  useEffect(() => {
    setDraft(value);
    lastSubmittedRef.current = value;
  }, [value]);
  const shownValue = deferCommit ? draft : value;
  const commit = (nextValue: string) => {
    if (lastSubmittedRef.current === nextValue) return;
    lastSubmittedRef.current = nextValue;
    onChange(settingKey, nextValue);
  };
  return (
    <SettingsRow icon="analysis" title={label} description={description} className="threshold-row">
      <div className="threshold-control">
        <input
          aria-label={label}
          type="range"
          min={min}
          max={max}
          step={step}
          value={shownValue}
          onChange={(event) => {
            const nextValue = event.currentTarget.value;
            if (deferCommit) setDraft(nextValue);
            else onChange(settingKey, nextValue);
          }}
          onPointerUp={(event) => {
            if (deferCommit) commit(event.currentTarget.value);
          }}
          onKeyUp={(event) => {
            if (deferCommit && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
              commit(event.currentTarget.value);
            }
          }}
          onBlur={(event) => {
            if (deferCommit) commit(event.currentTarget.value);
          }}
        />
        <output>{Number(shownValue).toFixed(2)}</output>
        <button type="button" onClick={() => {
          if (deferCommit) setDraft(defaultValue);
          commit(defaultValue);
        }}>
          恢复默认
        </button>
      </div>
    </SettingsRow>
  );
}

export function SettingsPage() {
  const [settings, setSettings] = useState<SettingsMap>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [llmLedger, setLlmLedger] = useState<LlmLedgerEntry[]>([]);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [deviceClocks, setDeviceClocks] = useState<DeviceClockSetting[]>([]);
  const [clockDrafts, setClockDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("正在读取本地设置…");
  const [busy, setBusy] = useState(false);
  const [cacheConfirm, setCacheConfirm] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("appearance");
  const settingsRef = useRef<SettingsMap>(DEFAULT_SETTINGS);
  const confirmedSettingsRef = useRef<SettingsMap>(DEFAULT_SETTINGS);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveVersionRef = useRef(new Map<string, number>());
  const closeHelp = useCallback(() => setHelpOpen(false), []);

  const refreshStatus = useCallback(async () => {
    const next = await getSettingsStatus();
    setStatus(next);
  }, []);

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
    ])
      .then(([savedResult, statusResult, infoResult, llmStatusResult, ledgerResult, clocksResult]) => {
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
        if (clocksResult.status === "fulfilled") {
          const clocks = clocksResult.value;
          setDeviceClocks(clocks);
          setClockDrafts(Object.fromEntries(clocks.map((clock) => [
            clock.device_model,
            String(clock.journey_offset_ms / 1_000),
          ])));
        }
        const optionalFailures = [statusResult, infoResult, llmStatusResult, ledgerResult, clocksResult]
          .filter((result) => result.status === "rejected").length;
        setNotice(optionalFailures === 0
          ? "设置已从本地项目载入"
          : `核心设置已载入；${optionalFailures} 项状态暂时不可用，可稍后刷新`);
      });
    return () => {
      active = false;
    };
  }, []);

  const save = useCallback(async (key: string, value: string) => {
    if (!settingsLoaded) {
      setNotice("核心设置尚未载入，暂不能编辑");
      return;
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
      setNotice(key === "performance.worker_count" ? "已保存，worker 并发将在重启后生效" : "已保存");
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
      setNotice(`保存失败：${String(error)}`);
    }
  }, [settingsLoaded]);

  const savePath = async (key: string, event: ChangeEvent<HTMLInputElement>) => {
    await save(key, event.currentTarget.value.trim());
    await refreshStatus().catch((error) => setNotice(`工具检测失败：${String(error)}`));
  };

  const runSelfCheck = async () => {
    setBusy(true);
    setNotice("正在启动 Chinese-CLIP 并执行 ping…");
    try {
      const message = await runClipSelfCheck();
      setNotice(message);
      await refreshStatus();
    } catch (error) {
      console.error("Chinese-CLIP self-check failed", error);
      setNotice("本地智能分析服务尚未就绪。正式版不在线安装运行环境，请等待签名组件包。");
    } finally {
      setBusy(false);
    }
  };

  const openLogs = async () => {
    setBusy(true);
    try {
      await openLogsDirectory();
      setNotice("已在访达中打开日志目录；panic 日志自动保留 7 天");
    } catch (error) {
      setNotice(`日志目录打开失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const clearCache = async () => {
    if (!cacheConfirm) {
      setCacheConfirm(true);
      setNotice("请再次点击确认；评级、片段和原始素材不会被删除");
      return;
    }
    setBusy(true);
    setCacheConfirm(false);
    try {
      const result = await clearCacheAndRebuild();
      setNotice(
        `已释放 ${bytesLabel(result.removed_disk_bytes)}，清理 ${result.removed_database_rows} 条缓存记录，重置 ${result.reset_jobs} 个重建任务`,
      );
      await refreshStatus();
    } catch (error) {
      setNotice(`缓存重建失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveDeviceClock = async (deviceModel: string) => {
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
      setNotice(`设备时钟校正失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-page" aria-label="设置">
      <div className="settings-notice" role="status" aria-live="polite">
        <span aria-hidden="true" />
        {notice}
      </div>

      <div className="settings-layout">
        <aside className="settings-sidebar" aria-label="设置分类">
          <header>
            <span>SETTINGS</span>
            <h2>设置</h2>
          </header>
          <nav>
            {SETTINGS_SECTIONS.map((section) => (
              <button
                type="button"
                className={`${activeSection === section.id ? "active" : ""}${section.id === "cache" ? " danger" : ""}`.trim()}
                aria-controls={`settings-panel-${section.id}`}
                aria-current={activeSection === section.id ? "page" : undefined}
                data-settings-nav={section.id}
                key={section.id}
                onClick={() => {
                  setActiveSection(section.id);
                  document.getElementById(`settings-panel-${section.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                <SettingsIcon name={section.id} />
                <span>
                  <strong>{section.label}</strong>
                  <small>{section.description}</small>
                </span>
              </button>
            ))}
          </nav>
        </aside>

        <div
          className="settings-content settings-grid"
          aria-busy={!settingsLoaded}
          inert={settingsLoaded ? undefined : true}
        >
        <section className="settings-card appearance-card" id="settings-panel-appearance" data-settings-section="appearance">
          <header>
            <span>01 / APPEARANCE</span>
            <h2>外观</h2>
            <p>让全屏工作台保持舒展，同时按观看距离调整整套字号。</p>
          </header>
          <div className="settings-group">
          <SettingsRow icon="theme" title="主题" description="跟随 macOS 外观，或为工作台固定明暗主题。">
            <div className="segmented-control three">
              {[
                ["system", "跟随系统"],
                ["light", "浅色"],
                ["dark", "深色"],
              ].map(([value, label]) => (
                <button
                  type="button"
                  className={settings["appearance.theme"] === value ? "active" : undefined}
                  aria-pressed={settings["appearance.theme"] === value}
                  onClick={() => void save("appearance.theme", value)}
                  key={value}
                >
                  {label}
                </button>
              ))}
            </div>
          </SettingsRow>
          <SettingsRow icon="scale" title="界面缩放" description="同步调整筛片、导入、交付与设置页的阅读尺度。">
            <div className="segmented-control four">
              {[
                ["0.9", "90%"],
                ["1.0", "100%"],
                ["1.15", "115%"],
                ["1.3", "130%"],
              ].map(([value, label]) => (
                <button
                  type="button"
                  className={settings["appearance.ui_scale"] === value ? "active" : undefined}
                  aria-pressed={settings["appearance.ui_scale"] === value}
                  onClick={() => void save("appearance.ui_scale", value)}
                  key={value}
                >
                  {label}
                </button>
              ))}
            </div>
          </SettingsRow>
          </div>
        </section>

        <section className="settings-card performance-card" id="settings-panel-performance" data-settings-section="performance">
          <header>
            <span>02 / PERFORMANCE</span>
            <h2>性能</h2>
            <p>控制后台吞吐与代理文件占用；原片始终保持只读。</p>
          </header>
          <div className="settings-group">
          <SettingsRow icon="worker" title="worker 并发" description="可选 1–8；保存后在下次重启时生效。">
            <select
              aria-label="worker 并发"
              value={settings["performance.worker_count"]}
              onChange={(event) => void save("performance.worker_count", event.currentTarget.value)}
            >
              {Array.from({ length: 8 }, (_, index) => index + 1).map((count) => (
                <option value={count} key={count}>{count}</option>
              ))}
            </select>
          </SettingsRow>
          <SettingsRow icon="proxy" title="自动生成 540p 代理" description="关闭后播放器优先读取原片，新导入不再排队生成代理。">
            <label className="switch-control">
              <span className="sr-only">自动生成 540p 代理</span>
              <input
                type="checkbox"
                checked={settings["performance.proxy_enabled"] === "true"}
                onChange={(event) => void save("performance.proxy_enabled", String(event.currentTarget.checked))}
              />
              <span className="switch-track" aria-hidden="true" />
            </label>
          </SettingsRow>
          </div>
        </section>

        <section className="settings-card clock-card wide" id="settings-panel-timeline" data-settings-section="timeline">
          <header>
            <span>03 / CANONICAL JOURNEY TIME</span>
            <h2>设备时钟校正</h2>
            <p>偏移只参与旅行时间轴排序，不会改写素材原始 captured_at。正数让设备时间向后移动，负数向前移动。</p>
          </header>
          {deviceClocks.length === 0 ? (
            <div className="clock-empty">尚无可识别设备；元数据回填完成后会按 device_model 分组。</div>
          ) : (
            <div className="clock-device-list">
              {deviceClocks.map((clock) => (
                <div className={`clock-device${clock.needs_review ? " needs-review" : ""}`} key={clock.device_model}>
                  <div>
                    <strong>{clock.device_model}</strong>
                    <small>
                      {clock.clip_count} 条素材 · {clockSourceLabel(clock.source)}
                      {clock.confidence === null ? "" : ` · 置信度 ${Math.round(clock.confidence * 100)}%`}
                    </small>
                    {clock.timezone_conflicts > 0 ? (
                      <span className="clock-warning">
                        {clock.timezone_conflicts} 条素材的 GPS 推断时区与文件时区标记冲突
                      </span>
                    ) : null}
                  </div>
                  <label>
                    <span>偏移（秒）</span>
                    <input
                      type="number"
                      step="0.001"
                      min={-50_400}
                      max={50_400}
                      value={clockDrafts[clock.device_model] ?? "0"}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setClockDrafts((current) => ({ ...current, [clock.device_model]: value }));
                      }}
                    />
                  </label>
                  <button type="button" disabled={busy} onClick={() => void saveDeviceClock(clock.device_model)}>
                    应用到此设备
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="settings-card tools-card wide" id="settings-panel-tools" data-settings-section="tools">
          <header>
            <span>03 / TOOLCHAIN</span>
            <h2>工具链</h2>
            <p>留空时自动搜索环境变量与 PATH；填写路径后，失焦即保存并重新检测。</p>
          </header>
          <div className="tool-grid">
            <div className="tool-config" data-setting-row>
              <SettingsIcon name="tools" />
              <div className="tool-config-copy">
                <strong>FFmpeg 路径</strong>
                <small>负责代理、音频与导出处理；留空时自动检测。</small>
              </div>
              <div className="tool-config-control">
                <input
                  aria-label="FFmpeg 路径"
                  value={settings["tools.ffmpeg_path"]}
                  placeholder="自动检测 ffmpeg"
                  spellCheck={false}
                  onChange={(event) => { const value = event.currentTarget.value; setSettings((current) => ({ ...current, "tools.ffmpeg_path": value })); }}
                  onBlur={(event) => void savePath("tools.ffmpeg_path", event)}
                />
                <ToolReadout label="FFmpeg" status={status?.ffmpeg} />
              </div>
            </div>
            <div className="tool-config" data-setting-row>
              <SettingsIcon name="tools" />
              <div className="tool-config-copy">
                <strong>FFprobe 路径</strong>
                <small>负责读取媒体流与容器信息；留空时自动检测。</small>
              </div>
              <div className="tool-config-control">
                <input
                  aria-label="FFprobe 路径"
                  value={settings["tools.ffprobe_path"]}
                  placeholder="自动检测 ffprobe"
                  spellCheck={false}
                  onChange={(event) => { const value = event.currentTarget.value; setSettings((current) => ({ ...current, "tools.ffprobe_path": value })); }}
                  onBlur={(event) => void savePath("tools.ffprobe_path", event)}
                />
                <ToolReadout label="FFprobe" status={status?.ffprobe} />
              </div>
            </div>
            <div className="tool-config" data-setting-row>
              <SettingsIcon name="tools" />
              <div className="tool-config-copy">
                <strong>whisper-cli 路径</strong>
                <small>负责本地语音转写；留空时自动检测。</small>
              </div>
              <div className="tool-config-control">
                <input
                  aria-label="whisper-cli 路径"
                  value={settings["tools.whisper_path"]}
                  placeholder="自动检测 whisper-cli"
                  spellCheck={false}
                  onChange={(event) => { const value = event.currentTarget.value; setSettings((current) => ({ ...current, "tools.whisper_path": value })); }}
                  onBlur={(event) => void savePath("tools.whisper_path", event)}
                />
                <ToolReadout label="Whisper" status={status?.whisper.binary} />
              </div>
            </div>
            <div className="model-config" data-setting-row>
              <SettingsIcon name="model" />
              <div className="tool-config-copy">
                <strong>Whisper 模型档位</strong>
                <small>可选模型不由应用联网下载；按状态区路径放置已校验的 ggml 文件。</small>
              </div>
              <div className="tool-config-control">
                <select
                  aria-label="Whisper 模型档位"
                  value={settings["tools.whisper_model_tier"]}
                  onChange={(event) => void save("tools.whisper_model_tier", event.currentTarget.value).then(refreshStatus)}
                >
                  <option value="large-v3-turbo">large-v3-turbo / 默认质量</option>
                  <option value="small">small / 低内存</option>
                </select>
                <div className="model-readout">
                  <StatusPill available={status?.whisper.model_available ?? false}>
                    {status?.whisper.model_available ? "模型已安装" : "模型缺失"}
                  </StatusPill>
                  <code>{status?.whisper.model_path ?? "等待检测"}</code>
                  <small>
                    当前版本不提供在线下载。需要转写时，请自行核验来源与 SHA-256 后放入
                    {status?.whisper.models_directory ?? "应用 models 目录"}；缺失不影响核心工作流。
                  </small>
                </div>
              </div>
            </div>
            <div className="clip-config" data-setting-row>
              <SettingsIcon name="clip" />
              <div className="tool-config-copy">
                <strong>Chinese-CLIP sidecar</strong>
                <small>{status?.clip_sidecar.note ?? "本地视觉语义搜索服务。"}</small>
              </div>
              <div className="clip-config-control">
                <StatusPill available={status?.clip_sidecar.available ?? false}>
                  {status?.clip_sidecar.available
                    ? "venv 已安装"
                    : status?.clip_sidecar.service_available === false
                      ? "资源缺失"
                      : "venv 缺失"}
                </StatusPill>
                <code>{status?.clip_sidecar.venv_path ?? "等待检测"}</code>
                <button
                  className="settings-action"
                  type="button"
                  disabled={busy || !status?.clip_sidecar.available}
                  onClick={() => void runSelfCheck()}
                >
                  {status?.clip_sidecar.available ? "运行自检" : "组件尚未提供"}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="settings-card thresholds-card wide" id="settings-panel-analysis" data-settings-section="analysis">
          <header>
            <span>04 / ANALYSIS &amp; AI</span>
            <h2>分析与 AI</h2>
            <p>分析阈值与可选的大模型增强集中管理；既有结果不会被静默改写。</p>
          </header>
          <div className="settings-subsection-heading">
            <strong>分析阈值</strong>
            <small>新任务执行时读取当前值。</small>
          </div>
          <div className="settings-group">
          <ThresholdRow
            label="场景切分 T"
            description="越低越容易切出新场景"
            settingKey="analysis.scene_threshold"
            value={settings["analysis.scene_threshold"]}
            defaultValue={DEFAULT_SETTINGS["analysis.scene_threshold"]}
            min="0.10" max="0.80" step="0.01" onChange={(key, value) => void save(key, value)}
          />
          <ThresholdRow
            label="语义相似度"
            description="低于此值的 Chinese-CLIP 搜索结果不展示"
            settingKey="analysis.similarity_threshold"
            value={settings["analysis.similarity_threshold"]}
            defaultValue={DEFAULT_SETTINGS["analysis.similarity_threshold"]}
            min="0.00" max="1.00" step="0.01" onChange={(key, value) => void save(key, value)}
          />
          <ThresholdRow
            label="抖动阈值"
            description="抖动分 = 运镜轨迹高频能量占比（0–1）；高于此值显示“手持抖动”角标"
            settingKey="analysis.jitter_threshold"
            value={settings["analysis.jitter_threshold"]}
            defaultValue={DEFAULT_SETTINGS["analysis.jitter_threshold"]}
            min="0.00" max="1.00" step="0.01" onChange={(key, value) => void save(key, value)}
          />
          </div>
          <div className="settings-subsection-heading">
            <strong>AI Best Take 六轴权重</strong>
            <small>仅对已有轴归一化；Narrative 在 D3 回填前不会稀释总分。</small>
          </div>
          <div className="settings-group best-take-weight-settings">
          {([
            ["technical", "Technical", "对焦、曝光与画面技术质量"],
            ["composition", "Composition", "CLIP 构图启发式代理"],
            ["motion", "Motion", "稳定度与首尾抖动分差"],
            ["human", "Human", "CLIP 人物自然度启发式代理"],
            ["audio", "Audio", "astats 与转写清晰度代理"],
            ["narrative", "Narrative", "D3 故事位置回填"],
          ] as const).map(([key, label, description]) => {
            const settingKey = `best_take.weight.${key}`;
            return (
              <ThresholdRow
                key={key}
                label={label}
                description={description}
                settingKey={settingKey}
                value={settings[settingKey]}
                defaultValue={DEFAULT_SETTINGS[settingKey]}
                min="0.00" max="1.00" step="0.01"
                onChange={(changedKey, value) => void save(changedKey, value)}
                deferCommit
              />
            );
          })}
          </div>
        </section>

        <section className="settings-card llm-card wide analysis-companion" data-settings-section="analysis">
          <header>
            <span>OPTIONAL LLM</span>
            <h2>订阅大模型增强</h2>
            <p>默认关闭且不选择 provider。只在你明确触发 AI 描述、导演问答或叙事编排时启动一次短命 CLI 子进程。</p>
          </header>
          <div className="llm-controls">
            <SettingsRow icon="analysis" title="启用 L3 增强" description="关闭时后端在预算检查和 provider 路由之前拒绝全部 LLM 调用。">
              <label className="switch-control">
                <span className="sr-only">启用 L3 增强</span>
                <input
                  type="checkbox"
                  checked={settings.llm_enabled === "true"}
                  onChange={(event) => {
                    const enabled = event.currentTarget.checked;
                    if (enabled && (settings.llm_provider === "none" || settings.llm_provider === "auto")) {
                      setNotice("请先明确锁定一个 LLM provider，再启用 L3 增强");
                      return;
                    }
                    void save("llm_enabled", String(enabled)).then(refreshLlm);
                  }}
                />
                <span className="switch-track" aria-hidden="true" />
              </label>
            </SettingsRow>
            <SettingsRow icon="analysis" title="Provider" description="必须明确锁定单一 provider；失败即报错，不向其他服务自动转发。">
              <select
                aria-label="Provider"
                value={settings.llm_provider}
                onChange={(event) => {
                  void save("llm_provider", event.currentTarget.value).then(refreshLlm);
                }}
              >
                <option value="none">未选择 / 禁止调用</option>
                <option value="auto" disabled>旧版 Auto / 已禁用</option>
                <option value="claude">Claude / claude -p</option>
                <option value="codex">Codex / codex exec</option>
                <option value="kimi">Kimi / kimi -p</option>
              </select>
            </SettingsRow>
            <SettingsRow icon="analysis" title="每月调用预算" description="0–10000 次；达到上限后熔断，不启动 CLI。">
              <input
                aria-label="每月调用预算"
                className="llm-budget-input"
                type="number"
                min="0"
                max="10000"
                step="1"
                value={settings.llm_monthly_budget}
                onChange={(event) => {
                  // React 合成事件的 currentTarget 在同步阶段之外为 null;必须先取值再进 updater。
                  const value = event.currentTarget.value;
                  setSettings((current) => ({ ...current, llm_monthly_budget: value }));
                }}
                onBlur={(event) => {
                  const value = event.currentTarget.value;
                  const valid = /^\d+$/.test(value) && Number(value) <= 10_000;
                  if (!valid) {
                    const fallback = String(llmStatus?.monthly_budget ?? 200);
                    setSettings((current) => ({ ...current, llm_monthly_budget: fallback }));
                    setNotice("每月调用预算必须是 0–10000 的整数");
                    return;
                  }
                  void save("llm_monthly_budget", value).then(refreshLlm);
                }}
              />
            </SettingsRow>
          </div>
          <div className={`llm-budget-status${llmStatus?.budget_exhausted ? " exhausted" : ""}`}>
            <div>
              <span>本月调用</span>
              <strong>
                {llmStatus?.calls_this_month ?? 0} / {llmStatus?.monthly_budget ?? 200}
              </strong>
            </div>
            <div>
              <span>状态</span>
              <strong>
                {!llmStatus?.enabled
                  ? "已关闭"
                  : llmStatus?.budget_exhausted
                    ? "预算已熔断"
                    : `剩余 ${llmStatus?.remaining_calls ?? 0} 次`}
              </strong>
            </div>
          </div>
          <div className="llm-provider-grid" aria-label="LLM CLI 可用性">
            {(llmStatus?.providers ?? []).map((provider) => (
              <div key={provider.provider}>
                <strong>{provider.provider}</strong>
                <StatusPill available={provider.available}>
                  {provider.available ? "PATH 已找到" : "PATH 未找到"}
                </StatusPill>
                <code>{provider.executable}</code>
              </div>
            ))}
          </div>
          <div className="llm-privacy-note">
            <strong>发送内容明细</strong>
            <p>
              AI 描述只发送时长/时间基准、尺寸、L1 质量数值与运镜数值；不发送文件名、封面帧、图片、视频、音频、绝对路径或 GPS。
              导演问答只发送当前筛选统计、精选清单文字摘要和你的问题，不发送素材帧或转写。
              叙事编排只发送匿名 clip/segment ID、时长、尺寸、八维标签与镜头 Stack 数值，不发送文件名、拍摄时间、GPS、转写或频道记忆。所有输入通过标准输入传给你锁定的 provider，不出现在进程参数中。
            </p>
          </div>
          <div className="llm-ledger">
            <div className="llm-ledger-heading">
              <strong>最近 20 条调用账本</strong>
              <button type="button" onClick={() => void refreshLlm().catch((error) => setNotice(`账本刷新失败：${String(error)}`))}>
                刷新
              </button>
            </div>
            {llmLedger.length === 0 ? (
              <p>尚无调用记录。provider 缺失或开关关闭不会消耗预算。</p>
            ) : (
              <div className="llm-ledger-table" role="table" aria-label="最近 LLM 调用账本">
                {llmLedger.map((entry) => (
                  <div role="row" key={entry.id} title={entry.error_summary ?? undefined}>
                    <time role="cell">{entry.called_at.replace("T", " ").slice(0, 19)}</time>
                    <span role="cell">{entry.provider}</span>
                    <span role="cell">{llmLedgerPurposeLabel(entry.purpose)}</span>
                    <span role="cell">≈{entry.estimated_tokens} tokens</span>
                    <strong role="cell" data-status={entry.status}>
                      {llmLedgerStatusLabel(entry.status)}
                    </strong>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="settings-card help-card" id="settings-panel-about" data-settings-section="about">
          <header>
            <span>05 / HELP &amp; ABOUT</span>
            <h2>帮助与关于</h2>
            <p>中文工作指南、应用状态与第三方许可集中在一个低频分区。</p>
          </header>
          <div className="settings-group">
            <SettingsRow
              icon="help"
              title="中文工作指南"
              description={`${KEYBOARD_SHORTCUT_COUNT} 项快捷键 · ${String(WORKFLOW_STEPS.length).padStart(2, "0")} 步工作流 · ${String(HELP_FAQS.length).padStart(2, "0")} 类常见问题`}
            >
              <button
                className="settings-action"
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent("tripcut:open-wizard"))}
              >
                打开安装向导
              </button>
              <button className="settings-action help-open" type="button" onClick={() => setHelpOpen(true)}>
                打开中文帮助
                <span aria-hidden="true">↗</span>
              </button>
            </SettingsRow>
            <SettingsRow
              icon="help"
              title="诊断日志"
              description="panic 日志仅保留 7 天；素材路径脱敏为文件名。"
            >
              <button className="settings-action" type="button" disabled={busy} onClick={() => void openLogs()}>
                打开日志目录
                <span aria-hidden="true">↗</span>
              </button>
            </SettingsRow>
          </div>
        </section>

        <section className="settings-card about-card wide about-companion" data-settings-section="about">
          <header>
            <span>ABOUT</span>
            <h2>应用信息</h2>
            <p>本地优先的旅途素材筛选与交付工作台。</p>
          </header>
          <dl className="about-facts">
            <div><dt>应用版本</dt><dd>{appInfo?.version ?? "—"}</dd></div>
            <div><dt>Schema</dt><dd>V{appInfo?.db_schema_version ?? "—"}</dd></div>
            <div><dt>当前 worker</dt><dd>{appInfo?.worker_count ?? "—"}</dd></div>
            <div>
              <dt>项目模式</dt>
              <dd>{appInfo ? (appInfo.read_only ? "只读（另一实例持有写锁）" : "独占写入") : "—"}</dd>
            </div>
          </dl>
          <div className="license-list">
            <header>
              <div>
                <strong>开源许可清单</strong>
                <span>由 Cargo.toml 与 package.json 的直接依赖生成</span>
              </div>
              <small>{GENERATED_LICENSES.length} 项</small>
            </header>
            <div className="license-table" role="table" aria-label="开源直接依赖许可">
              {GENERATED_LICENSES.map((entry) => (
                <div role="row" key={`${entry.ecosystem}-${entry.name}`}>
                  <span role="cell">
                    <strong>{entry.name}</strong>
                    <small>{entry.ecosystem} · {entry.scope}</small>
                  </span>
                  <code role="cell">{entry.version.replace(/^=/, "")}</code>
                  <span role="cell">{entry.license}</span>
                </div>
              ))}
            </div>
            <p>这里只列直接依赖；最终发布包仍应保留各依赖的完整许可文本与第三方通知。</p>
          </div>
        </section>
        <section className="settings-card cache-card" id="settings-panel-cache" data-settings-section="cache">
          <header>
            <span>06 / CACHE &amp; REBUILD</span>
            <h2>缓存与重建</h2>
            <p>只管理可重建产物，不触碰原片、片段选择与评级。</p>
          </header>
          <div className="cache-meter" aria-label="缓存占用">
            <div><span>数据库记录</span><strong>{bytesLabel(status?.cache.database_bytes ?? 0)}</strong></div>
            <div><span>目录实测</span><strong>{bytesLabel(status?.cache.disk_bytes ?? 0)}</strong></div>
          </div>
          <div className="danger-zone">
            <div className="danger-copy">
              <SettingsIcon name="cache" />
              <span>
                <strong>清空缓存并重建</strong>
                <small>会移除可重建缓存并重置对应任务；评级、片段和原始素材不会被删除。</small>
              </span>
            </div>
            <button
              className={cacheConfirm ? "settings-action danger armed" : "settings-action danger"}
              type="button"
              disabled={busy}
              onClick={() => void clearCache()}
            >
              {cacheConfirm ? "再次点击确认清空" : "清空缓存并重建"}
            </button>
          </div>
        </section>
        </div>
      </div>
      <HelpOverlay open={helpOpen} onClose={closeHelp} />
    </section>
  );
}
