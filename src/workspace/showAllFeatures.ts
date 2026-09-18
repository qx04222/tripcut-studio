import { useEffect, useSyncExternalStore } from "react";

import { getSettings, setSetting } from "../api";
import { readUiBool } from "./uiSettings";

/**
 * R19 P-05:「显示全部功能」开关(设置 › 关于),默认关。关时只留四步流水线上的常规操作:
 * 镜头带附属只剩 故事 / 音乐,检查器折叠段只剩 AI 描述 / 相似镜头(评级 / 标签 / 章节 默认层照旧),
 * 设置只剩 项目 / 播放与导出 / 工具 / 关于;技术检查 / 画面评分(八维)/ 声音与调色(多音轨 + LUT)/
 * 旅程 / 地点卡 / 模板 / 快捷键(键位预设)/ 性能 / 云端补镜 进开关后。**不删代码**,开关打开原样回来。
 * 存本地偏好 `ui.show_all_features`(`ui.` 前缀走 Rust 白名单,不建迁移)。
 */
export const SHOW_ALL_FEATURES_KEY = "ui.show_all_features";

let showAll = false;
let hydrated: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function getSnapshot(): boolean {
  return showAll;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 启动后读一次设置;读不到就保持默认(关)。 */
export function hydrateShowAllFeatures(): Promise<void> {
  hydrated ??= getSettings()
    .then((settings) => {
      const next = readUiBool(settings ?? {}, SHOW_ALL_FEATURES_KEY);
      if (next !== showAll) {
        showAll = next;
        emit();
      }
    })
    .catch(() => undefined);
  return hydrated;
}

export function getShowAllFeatures(): boolean {
  return showAll;
}

/** 设置 › 关于 的开关写这里:先改内存(界面立刻变),再落设置。 */
export function setShowAllFeatures(next: boolean): void {
  if (next === showAll) return;
  showAll = next;
  emit();
  void setSetting(SHOW_ALL_FEATURES_KEY, next ? "true" : "false").catch(() => undefined);
}

/** 各消费点(附属 tab 列表 / 检查器段列表 / 设置分区)只读这一个布尔。 */
export function useShowAllFeatures(): boolean {
  useEffect(() => {
    void hydrateShowAllFeatures();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function __setShowAllFeaturesForTests(next: boolean): void {
  showAll = next;
  hydrated = Promise.resolve();
  emit();
}

export function __resetShowAllFeaturesForTests(): void {
  showAll = false;
  hydrated = null;
  emit();
}
