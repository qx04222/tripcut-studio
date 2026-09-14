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
  // R10 U-23:最近选中的素材 id(空串 = 没有);启动时核对存在后恢复选中。
  "ui.selection.last_clip": "",
  // R10 U-20:交付抽屉记住上次选择(平台 / 参考粗剪时长 / 联系表 / 剪映草稿)。
  // 平台空串 = 跟随本集设置;时长 "full" = 完整。
  "ui.deliver.platform": "",
  "ui.deliver.target_seconds": "",
  "ui.deliver.contact_sheet": "true",
  "ui.deliver.jianying_draft": "false",
  // R11 §1.2 / §3(车道 C):播放器偏好。R12 §5:点卡片 = 预览(停在最精彩处,不开播),
  // 「连播」是监视器上的显式开关、默认关 —— 默认开会让新手的选中自己跑走(verify-v1 V-05)。
  "ui.player.start_at_best": "true",
  "ui.player.auto_advance": "false",
  "ui.player.muted": "false",
  // R11 车道 E:快速导出上次用的文件夹(空串 = 还没选过;首次或目录不可用时弹一次文件夹面板)。
  "ui.export.last_dir": "",
  // R11 简化专项:首启三步引导「看过了」(库里一有素材或点关闭就写 true)。
  "onboarding.steps_seen": "false",
  // R12 §1:每步首次进入时导航条下方的一条提示,点「知道了」写 true(Rust ONBOARDING_FLAG_KEYS 白名单)。
  "pipeline.hint_seen.1": "false",
  "pipeline.hint_seen.2": "false",
  "pipeline.hint_seen.3": "false",
  "pipeline.hint_seen.4": "false",
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
