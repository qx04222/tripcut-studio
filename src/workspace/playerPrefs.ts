import { useSyncExternalStore } from "react";

import { getSettings, setSetting, type SettingsMap } from "../api";
import { readUiBool, readUiSetting } from "./uiSettings";

/**
 * R11 §3 播放器偏好的进程内小仓:`ui.player.*` 静音、连播与范围偏好。壳的 store 只把 settings
 * 当水合来源、不留整张表,监视器又不该每换一条素材就拉一次 `get_settings`,所以这里
 * 首次读一次、之后由写入方(设置 sheet 的开关 / 监视器的静音键)同步推进来。
 */
export type PlayerPrefKey = "ui.player.start_at_best" | "ui.player.auto_advance" | "ui.player.muted";

export interface PlayerPrefs {
  scrubberView: "full" | "zoom";
  autoAdvance: boolean;
  muted: boolean;
}

let snapshot: PlayerPrefs = fromSettings({});
let loaded: Promise<void> | null = null;
let viewRevision = 0;
const listeners = new Set<() => void>();

function fromSettings(settings: SettingsMap): PlayerPrefs {
  return {
    scrubberView: readUiSetting(settings, "ui.player.scrubber_view") === "zoom" ? "zoom" : "full",
    autoAdvance: readUiBool(settings, "ui.player.auto_advance"),
    muted: readUiBool(settings, "ui.player.muted"),
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** 首次调用才真的读 settings 表;失败就保持默认值(完整素材、连播关、不静音)。 */
export function loadPlayerPrefs(): Promise<void> {
  const revision = viewRevision;
  loaded ??= getSettings()
    .then((settings) => {
      const stored = fromSettings(settings);
      snapshot = { ...stored, scrubberView: revision === viewRevision ? stored.scrubberView : snapshot.scrubberView };
      emit();
    })
    .catch(() => undefined);
  return loaded;
}

/** 只更新进程内快照(设置 sheet 自己已经写过表了)。 */
export function notifyPlayerPref(key: PlayerPrefKey, value: boolean): void {
  const next: PlayerPrefs = { ...snapshot };
  if (key === "ui.player.start_at_best") return; // 旧键不再影响播放。
  else if (key === "ui.player.auto_advance") next.autoAdvance = value;
  else next.muted = value;
  snapshot = next;
  emit();
}

/** 更新快照并写表(监视器的静音键走这条)。写失败不回滚 —— 这一次会话里照用户点的来。 */
export function writePlayerPref(key: PlayerPrefKey, value: boolean): Promise<void> {
  notifyPlayerPref(key, value);
  return setSetting(key, String(value)).catch(() => undefined);
}

export function getPlayerPrefs(): PlayerPrefs {
  return snapshot;
}

export function usePlayerPrefs(): PlayerPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPlayerPrefs,
    getPlayerPrefs,
  );
}

export function __resetPlayerPrefsForTests(): void {
  snapshot = fromSettings({});
  loaded = null;
  viewRevision = 0;
  emit();
}

export function writeScrubberView(value: "full" | "zoom"): Promise<void> {
  viewRevision++;
  snapshot = { ...snapshot, scrubberView: value };
  emit();
  return setSetting("ui.player.scrubber_view", value).catch(() => undefined);
}
