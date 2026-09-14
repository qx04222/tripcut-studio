import { useSyncExternalStore } from "react";

import { getSettings, type SettingsMap } from "../api";
import {
  DEFAULT_KEYMAP_PRESET,
  KEYMAP_CUSTOM_KEY,
  KEYMAP_PRESET_KEY,
  indexKeymap,
  isPresetId,
  resolveKeymap,
  type KeymapIndex,
  type KeymapPresetId,
  type KeymapTable,
} from "./keymap";

/**
 * R13 §1:键位表的进程内小仓(与 `playerPrefs` 同一套路)。壳启动时读一次 settings,
 * 之后由设置 sheet 的写入方 `notifyKeymap` 推进来;四个 hotkey hook 每次 keydown 只读快照。
 */
export interface KeymapSnapshot {
  preset: KeymapPresetId;
  custom: string;
  table: KeymapTable;
  index: KeymapIndex;
}

function build(preset: string | undefined, custom: string | undefined): KeymapSnapshot {
  const id: KeymapPresetId = preset && isPresetId(preset) ? preset : DEFAULT_KEYMAP_PRESET;
  const table = resolveKeymap(id, custom);
  return { preset: id, custom: custom ?? "", table, index: indexKeymap(table) };
}

let snapshot: KeymapSnapshot = build(undefined, undefined);
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function keymapFromSettings(settings: SettingsMap): KeymapSnapshot {
  return build(settings[KEYMAP_PRESET_KEY], settings[KEYMAP_CUSTOM_KEY]);
}

/** 首次调用才真的读 settings 表;失败就保持默认(剪映键位)。 */
export function loadKeymap(): Promise<void> {
  loaded ??= getSettings()
    .then((settings) => {
      snapshot = keymapFromSettings(settings);
      emit();
    })
    .catch(() => undefined);
  return loaded;
}

/** 只更新进程内快照(设置 sheet 自己已经写过表了)。 */
export function notifyKeymap(preset: string, custom: string): void {
  snapshot = build(preset, custom);
  emit();
}

export function getKeymap(): KeymapSnapshot {
  return snapshot;
}

export function useKeymap(): KeymapSnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getKeymap,
    getKeymap,
  );
}

export function __resetKeymapForTests(): void {
  snapshot = build(undefined, undefined);
  loaded = null;
  emit();
}
