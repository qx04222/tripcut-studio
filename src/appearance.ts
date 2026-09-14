import type { SettingsMap } from "./api";

/**
 * 外观相关的纯逻辑 + `<html>` 属性写入。
 *
 * 它从 `SettingsPage.tsx` 里被拆出来,唯一的原因是代码分割:`App.tsx` 启动时
 * 就要 `applyAppearanceSettings()`,如果这个函数还留在 `SettingsPage.tsx`,
 * 那么整张设置页(以及它拖着的 HelpOverlay/updater 等)就会被静态拉进首屏
 * chunk,`SettingsSheet` 的 `lazy()` 也就白写了(见 `WorkspaceShell.tsx` 的注释)。
 * `SettingsPage.tsx` 仍然把这三个符号原样 re-export,旧的导入路径不受影响。
 */
export const DEFAULT_SETTINGS: SettingsMap = {
  "appearance.theme": "system",
  "appearance.ui_scale": "1.0",
  "performance.worker_count": "4",
  "performance.proxy_enabled": "true",
  "performance.memory_profile": "auto",
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
  minimax_enabled: "false",
  minimax_model: "MiniMax-H3-Max",
  minimax_resolution: "768P",
  minimax_monthly_budget_usd: "10",
};

const SCALE_DATA: Record<string, string> = {
  "0.9": "90",
  "1.0": "100",
  "1.15": "115",
  "1.3": "130",
};

/** 设置里可选的固定主题(`html[data-theme]` 的值);R13 §5 加「剪映风格深色」。system = 不写属性。 */
export const FIXED_THEMES = ["light", "dark", "jianying-dark"] as const;
export type FixedTheme = (typeof FIXED_THEMES)[number];

export function appearanceAttributes(settings: SettingsMap): {
  theme: FixedTheme | null;
  uiScale: string;
} {
  const theme = settings["appearance.theme"] ?? DEFAULT_SETTINGS["appearance.theme"];
  const scale = settings["appearance.ui_scale"] ?? DEFAULT_SETTINGS["appearance.ui_scale"];
  return {
    theme: (FIXED_THEMES as readonly string[]).includes(theme) ? (theme as FixedTheme) : null,
    uiScale: SCALE_DATA[scale] ?? "100",
  };
}

export function applyAppearanceSettings(settings: SettingsMap) {
  const root = document.documentElement;
  const appearance = appearanceAttributes(settings);
  if (appearance.theme) root.dataset.theme = appearance.theme;
  else delete root.dataset.theme;
  root.dataset.uiScale = appearance.uiScale;
}
