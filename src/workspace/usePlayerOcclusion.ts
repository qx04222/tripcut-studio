import { useEffect, useRef } from "react";

import { playerSetOccluded } from "../api";
import { isPlayerOccluded, popOccluder, pushOccluder, subscribeModalStack } from "./modalStack";

/** 解除遮挡后广播给 PlayerOverlay:把区域矩形重新提交一次,原生视图与 DOM 井对齐。 */
export const PLAYER_VIEWPORT_REFRESH_EVENT = "tripcut:player-viewport-refresh";

/**
 * 原生 mpv 视图是加在窗口 contentView 上、压在 WKWebView 之上的 NSView——
 * 任何 DOM 覆盖层(切换集 popover、更多筛选、导入/交付抽屉、设置 sheet、
 * 命令面板、帮助、生成对话框)打开时视频都会盖住它(R9 实机 D1)。
 *
 * 这个 hook 挂在监视器上(监视器在壳里常驻):模态栈一有变化就把
 * 「栈里有没有层」翻译成 `player_set_occluded`。旗标由 Rust 侧记住,所以
 * 遮挡中打开的会话一出生就是隐藏的;栈清空时先解除遮挡、再让 PlayerOverlay
 * 重新提交区域矩形。沉浸态不进模态栈(它自己就是画面),帮助层压在沉浸态上
 * 时同样会遮挡——这正是想要的。
 */
export function usePlayerOcclusion(): void {
  useEffect(() => {
    let sent: boolean | null = null;
    const sync = () => {
      const occluded = isPlayerOccluded();
      if (occluded === sent) return;
      sent = occluded;
      void playerSetOccluded(occluded)
        .then(() => {
          if (!occluded) window.dispatchEvent(new Event(PLAYER_VIEWPORT_REFRESH_EVENT));
        })
        .catch((reason) => console.warn("player_set_occluded failed", reason));
    };
    sync();
    const unsubscribe = subscribeModalStack(sync);
    return () => {
      unsubscribe();
      // 卸载时把旗标放回 false,否则下一次打开的会话会莫名其妙地一直隐藏。
      if (sent) void playerSetOccluded(false).catch(() => undefined);
    };
  }, []);
}

/**
 * 非模态覆盖物(首页、引导气泡)挂在监视器上方时登记为遮挡者(R13 真机 Y-01/Y-02):
 * `active` 为真期间原生视频视图藏起来,变假 / 卸载时撤掉。不进模态栈,Esc 语义不变。
 */
export function useOccludesPlayer(active = true): void {
  const token = useRef({});
  useEffect(() => {
    if (!active) return;
    const current = token.current;
    pushOccluder(current);
    return () => popOccluder(current);
  }, [active]);
}
