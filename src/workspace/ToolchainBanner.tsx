import { useEffect, useSyncExternalStore } from "react";

import { getSettingsStatus } from "../api";
import { requiredToolsMissing } from "../toolchainSteps";

/**
 * R12 §1 → R19 V-02:工具链缺失不再是顶栏下的一整条横幅。只有 ffmpeg / ffprobe 这种**必需**组件
 * 缺失时才有事;检测中 / 检测失败 / 只缺可选组件都没有。现在拆成三件:
 * - `ToolchainStatusProbe`:壳里跑一次检测,把结果写进这里的小 store,并广播 `tripcut:toolchain-status`;
 * - `useToolchainStatus()`:谁要渲染就订阅——R19 接线后唯一的渲染点是 `StatusStrip` 左端那颗
 *   红点按钮(AX 名「视频处理组件缺失」,点它打开设置 → 工具与模型)。
 * 旧的 region「视频处理组件缺失」/「关闭提示」不再有。
 */
export interface ToolchainStatus {
  missing: boolean;
  /** 状态条那一句;没事时是空串。 */
  text: string;
}

export const TOOLCHAIN_STATUS_EVENT = "tripcut:toolchain-status";
export const TOOLCHAIN_MISSING_TEXT = "视频处理组件缺失";

const OK: ToolchainStatus = { missing: false, text: "" };
let current: ToolchainStatus = OK;
const listeners = new Set<() => void>();

function publish(next: ToolchainStatus): void {
  if (next.missing === current.missing && next.text === current.text) return;
  current = next;
  for (const listener of listeners) listener();
  window.dispatchEvent(new CustomEvent<ToolchainStatus>(TOOLCHAIN_STATUS_EVENT, { detail: next }));
}

export function getToolchainStatusSnapshot(): ToolchainStatus {
  return current;
}

export function useToolchainStatus(): ToolchainStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getToolchainStatusSnapshot,
    () => OK,
  );
}

/** 仅供测试:把 store 清回「没事」。 */
export function __resetToolchainStatusForTests(): void {
  current = OK;
}

/** 壳里挂一次:检测必需组件,结果发布到 store / 事件。不渲染任何东西。 */
export function ToolchainStatusProbe(): null {
  useEffect(() => {
    let active = true;
    getSettingsStatus()
      .then((status) => {
        if (active && status) publish(requiredToolsMissing(status) ? { missing: true, text: TOOLCHAIN_MISSING_TEXT } : OK);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return null;
}
