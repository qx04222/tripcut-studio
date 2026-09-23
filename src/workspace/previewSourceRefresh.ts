import { useEffect } from "react";
import type { PlayerStatus } from "../api";

/**
 * 与 `PlayerOverlay.PLAYER_STATUS_REFRESH_EVENT` 同值(测试钉死;这里不 import 是为了不和
 * PlayerOverlay 形成循环依赖)。PlayerOverlay 收到后补读一次 `player_status`,监视器的状态随之更新。
 */
export const STATUS_REFRESH_EVENT = "tripcut:player-status-refresh";
/** 暂停后 Rust 150 ms 去抖 + 载入原片约 100–200 ms;分三次补读,换好就停。 */
export const PAUSED_REFRESH_DELAYS_MS = [300, 700, 1500] as const;

export function requestStatusRefreshSoon(delays: readonly number[] = PAUSED_REFRESH_DELAYS_MS): () => void {
  const timers = delays.map((delay) => window.setTimeout(() => window.dispatchEvent(new Event(STATUS_REFRESH_EVENT)), delay));
  return () => timers.forEach((timer) => window.clearTimeout(timer));
}

/**
 * 监视器暂停时停止轮询(PlayerOverlay `shouldPollStatus`),而自动档恰恰是在暂停之后才切到原片 ——
 * 不补读的话角标会一直停在「代理」。只在「自动档 · 已暂停 · 还不是原片」时补读,切到原片即停。
 */
export function usePausedSourceRefresh(status: PlayerStatus | null): void {
  const waiting = status?.phase === "ready" && status.paused && status.preview_quality === "auto"
    && status.source_kind !== undefined && status.source_kind !== null && status.source_kind !== "original";
  const clipId = status?.clip_id ?? null;
  useEffect(() => {
    if (!waiting) return undefined;
    return requestStatusRefreshSoon();
  }, [waiting, clipId]);
}
