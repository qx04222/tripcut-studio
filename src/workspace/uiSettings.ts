import { setSetting, type SettingsMap } from "../api";

/**
 * 规格 §5 的界面偏好键。这些键**不在** Rust 的 `defaults()` 里 —— 没写过的键
 * 根本不出现在 `get_settings()` 返回的 map 中,所以默认值必须由前端自带,
 * 读取一律走 `readUi*`,永远不要直接 `settings["ui.x"]`。
 */
export const UI_SETTING_DEFAULTS = {
  "ui.workspace_v2": "true", // Task 6d:旧四页壳全部有了新家,旗默认打开;设置 → 外观 → 「切回旧界面」写回 "false"
  "ui.pane.pool_width": "320",
  "ui.pane.inspector_width": "340",
  "ui.pane.monitor_height": "0.55",
  "ui.pane.pool_collapsed": "false",
  "ui.pane.inspector_collapsed": "false",
  "ui.band.mode": "story",
  "ui.inspector.sections_open": "[]",
  "ui.pool.filter": "all",
  "ui.pool.dimension": "",
} as const satisfies Readonly<Record<string, string>>;

export const WORKSPACE_FLAG_KEY = "ui.workspace_v2";

function defaultFor(key: string): string {
  return (UI_SETTING_DEFAULTS as Readonly<Record<string, string>>)[key] ?? "";
}

/** 读一个 `ui.*` 键:settings 里没有这个键时回落到 UI_SETTING_DEFAULTS,绝不返回 undefined。 */
export function readUiSetting(settings: SettingsMap, key: string): string {
  const stored = settings[key];
  return stored === undefined ? defaultFor(key) : stored;
}

export function readUiNumber(settings: SettingsMap, key: string): number {
  const parsed = Number.parseFloat(readUiSetting(settings, key));
  if (Number.isFinite(parsed)) return parsed;
  // 坏值(手改过设置表、旧版本写坏)不该让界面崩,回落到默认值。
  const fallback = Number.parseFloat(defaultFor(key));
  return Number.isFinite(fallback) ? fallback : 0;
}

export function readUiBool(settings: SettingsMap, key: string): boolean {
  const raw = readUiSetting(settings, key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return defaultFor(key) === "true";
}

export function readUiList(settings: SettingsMap, key: string): string[] {
  const parsed = parseList(readUiSetting(settings, key));
  return parsed ?? parseList(defaultFor(key)) ?? [];
}

function parseList(raw: string): string[] | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    return value.every((item): item is string => typeof item === "string") ? value : null;
  } catch {
    return null;
  }
}

export interface UiSettingWriter {
  queue(key: string, value: string): void;
  flush(): Promise<void>;
  pendingCount(): number;
}

/**
 * debounce 400ms + 串行队列(同 SettingsPage.tsx 的 saveQueueRef 模式)。
 * debounce 按键分别计时 —— 拖分隔条期间连写几十次只落最后一次;而真正的写入
 * 全部串在一条 promise 链上,后端一次只见到一条 set_setting。
 */
export function createUiSettingWriter(
  write: (key: string, value: string) => Promise<void> = setSetting,
  delayMs = 400,
): UiSettingWriter {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const latest = new Map<string, string>();
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;
  const send = (key: string) => {
    const value = latest.get(key);
    if (value === undefined) return;
    latest.delete(key);
    timers.delete(key);
    pending += 1;
    queue = queue
      .then(() => write(key, value))
      .catch(() => undefined) // 单条写失败不许卡死后面的键
      .finally(() => {
        pending -= 1;
      });
  };
  return {
    queue(key, value) {
      latest.set(key, value);
      const existing = timers.get(key);
      if (existing !== undefined) clearTimeout(existing);
      timers.set(key, setTimeout(() => send(key), delayMs));
    },
    flush() {
      for (const key of [...timers.keys()]) {
        clearTimeout(timers.get(key)!);
        send(key);
      }
      return queue;
    },
    pendingCount() {
      return pending + latest.size;
    },
  };
}
