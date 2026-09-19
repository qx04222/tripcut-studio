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
  "performance.low_spec_mode": "auto",
  "performance.proxy_cache_limit_gb": "10",
  "performance.background_only_when_idle": "false",
  "tools.ffmpeg_path": "",
  "tools.ffprobe_path": "",
  "tools.whisper_path": "",
  "tools.whisper_model_tier": "large-v3-turbo",
  // R19 P-06(models 车道):画面理解模型目录的覆盖;留空 = 用自动安装目录。
  "tools.clip_model_dir": "",
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
  // R18 车道 settings F1/F5/F6:通知两开关默认开、缓存目录默认内置、自动清理默认「从不」。
  "notification.export_complete": "true",
  "notification.batch_complete": "true",
  "cache.custom_dir": "",
  "cache.auto_clean_days": "0",
};

const SCALE_DATA: Record<string, string> = {
  "0.9": "90",
  "1.0": "100",
  "1.15": "115",
  "1.3": "130",
};

/** 设置里可选的固定主题(`html[data-theme]` 的值)。R19 车道 tokens · V-09/Q-3:R13 §5 加的
 * 「剪映风格深色」升格为唯一深色,通用 `dark` 退役——两套收成一套,`FIXED_THEMES` 只剩两档。
 * system = 不写属性。 */
export const FIXED_THEMES = ["light", "dark"] as const;
export type FixedTheme = (typeof FIXED_THEMES)[number];

/** 旧偏好里存过的主题值到新两档的映射。`"jianying-dark"` 是唯一退役的旧值——它的调色板本身
 * 升格成了 `"dark"`,映射到 `"dark"` 是让用户睁眼看到自己原来选的那套深色,不是换了一套。 */
const LEGACY_THEME_ALIASES: Record<string, FixedTheme> = {
  "jianying-dark": "dark",
};

export function normalizeThemePref(raw: string | undefined): "system" | FixedTheme {
  if (!raw || raw === "system") return "system";
  if ((FIXED_THEMES as readonly string[]).includes(raw)) return raw as FixedTheme;
  return LEGACY_THEME_ALIASES[raw] ?? "system";
}

export function appearanceAttributes(settings: SettingsMap): {
  theme: FixedTheme | null;
  uiScale: string;
} {
  const theme = normalizeThemePref(settings["appearance.theme"] ?? DEFAULT_SETTINGS["appearance.theme"]);
  const scale = settings["appearance.ui_scale"] ?? DEFAULT_SETTINGS["appearance.ui_scale"];
  return {
    theme: theme === "system" ? null : theme,
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
