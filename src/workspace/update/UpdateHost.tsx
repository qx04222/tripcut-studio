import { useEffect, useRef, type JSX } from "react";

import { bridgeUpdateProgressEvents } from "../../api";
import { showToast } from "../ui";
import { AUTO_CHECK_DELAY_MS } from "./updateModel";
import {
  loadLastCheck,
  openDownloadPage,
  postponeUpdate,
  runAutoUpdate,
  runUpdateDownload,
  runUpdateRestart,
  skipCurrentVersion,
  useUpdateState,
} from "./updateStore";

/** R17:三条更新提示的文案(toast 无固定 AX 名,按钮名冻结在这里)。 */
export const UPDATE_TOAST = {
  available: (version: string) => `有新版本 ${version}`,
  ready: (version: string) => `更新已下载 ${version}`,
  failed: (reason: string) => `更新没成功:${reason}`,
  updateNow: "现在更新",
  later: "稍后",
  skip: "跳过这个版本",
  restart: "重启完成更新",
  openDownloadPage: "打开下载页",
} as const;

/**
 * R17 车道 B:应用内自动升级的宿主——壳里挂一次(与 ToastHost 并列)。
 * 启动 30 秒后跑一次自动流程(开关 / 24 小时节流 / 离线静默都在 store 里判);
 * 之后只看 store 的状态变化出 toast:
 *  - 「先问我再下载」开着且发现新版本 → 「有新版本 x · 现在更新 / 稍后 / 跳过这个版本」
 *  - 下载完成 → 「更新已下载 x · 重启完成更新 / 稍后 / 跳过这个版本」
 *  - 下载失败 → 「更新没成功:<白话原因> · 打开下载页」
 * 三条都不自动消失(sticky),也不挡操作;下载中可以照常用软件。
 */
export function UpdateHost({ autoCheckDelayMs = AUTO_CHECK_DELAY_MS }: { autoCheckDelayMs?: number } = {}): JSX.Element | null {
  const state = useUpdateState();
  const announced = useRef<string | null>(null);

  useEffect(() => {
    let unbridge: (() => void) | null = null;
    let active = true;
    void loadLastCheck();
    void bridgeUpdateProgressEvents().then((off) => {
      if (typeof off !== "function") return;
      if (active) unbridge = off;
      else off();
    });
    const timer = setTimeout(() => void runAutoUpdate(), autoCheckDelayMs);
    return () => {
      active = false;
      clearTimeout(timer);
      unbridge?.();
    };
  }, [autoCheckDelayMs]);

  useEffect(() => {
    const version = state.version ?? "";
    let key: string | null = null;
    if (state.awaitingConsent && state.phase === "available") key = `available:${version}`;
    else if (state.phase === "ready") key = `ready:${version}`;
    else if (state.phase === "error" && state.failedAt === "download") key = `failed:${version}:${state.failure?.detail ?? ""}`;
    if (key === null || key === announced.current) return;
    announced.current = key;

    if (key.startsWith("available:")) {
      showToast(UPDATE_TOAST.available(version), {
        sticky: true,
        action: { label: UPDATE_TOAST.updateNow, onClick: () => void runUpdateDownload() },
        actions: [
          { label: UPDATE_TOAST.later, onClick: () => void postponeUpdate() },
          { label: UPDATE_TOAST.skip, onClick: () => void skipCurrentVersion() },
        ],
      });
    } else if (key.startsWith("ready:")) {
      showToast(UPDATE_TOAST.ready(version), {
        tone: "success",
        sticky: true,
        action: { label: UPDATE_TOAST.restart, onClick: () => void runUpdateRestart() },
        actions: [
          { label: UPDATE_TOAST.later, onClick: () => void postponeUpdate() },
          { label: UPDATE_TOAST.skip, onClick: () => void skipCurrentVersion() },
        ],
      });
    } else {
      showToast(UPDATE_TOAST.failed(state.failure?.reason ?? "遇到了意外错误"), {
        tone: "danger",
        sticky: true,
        action: { label: UPDATE_TOAST.openDownloadPage, onClick: () => void openDownloadPage() },
      });
    }
  }, [state]);

  return null;
}
