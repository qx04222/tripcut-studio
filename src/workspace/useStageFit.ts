import { useLayoutEffect, useRef, type RefObject } from "react";

import { fitWell } from "../playerViewport";
import { PLAYER_VIEWPORT_REFRESH_EVENT } from "./usePlayerOcclusion";

/**
 * 井要同时装进舞台的宽和高(R9 D5)。纯 CSS 的 `min(100%, 100cqh × 16/9)` 在
 * Chromium 里对,WKWebView 实机却按 100% 宽画,井被舞台裁掉、原生视图压到控件条上。
 *
 * 量的是**栏根**(`.monitor`:栏标题条 + 舞台 + 控件条),舞台可用高 = 栏根高 −
 * 标题条 − 控件条 − 舞台 padding。不直接量舞台:舞台的高会被井的内联高撑起来
 * (真机复核二:旅程页签下量到 380 的舞台,井盖住了栏标题条),量它就是自己
 * 量自己,一轮一轮涨。栏根的高只由外层面板决定,和井无关。
 *
 * `active` = 嵌入播放分支是否在渲染。effect 只跟着它重跑;尺寸真变了才广播
 * 一次区域矩形重提交(没 deps 的版本每 80ms 状态轮询都重建观察者、重发广播,
 * 把 PlayerOverlay 的防抖饿死——真机 P0-A/P0-B)。
 */
export function useStageFit(active: boolean): RefObject<HTMLDivElement | null> {
  const stageRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const pane = stage?.parentElement;
    if (!active || !stage || !pane || typeof ResizeObserver === "undefined") return;
    let last = { width: -1, height: -1 };
    const apply = () => {
      const well = stage.querySelector<HTMLElement>(":scope > .monitor-well");
      if (!well) return;
      const style = window.getComputedStyle(stage);
      let siblings = 0;
      for (const child of Array.from(pane.children)) {
        if (child !== stage) siblings += (child as HTMLElement).offsetHeight;
      }
      const width = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height =
        pane.clientHeight - siblings - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const fit = fitWell(width, height);
      if (fit.width <= 0 || (fit.width === last.width && fit.height === last.height)) return;
      last = fit;
      well.style.width = `${fit.width}px`;
      well.style.height = `${fit.height}px`;
      window.dispatchEvent(new Event(PLAYER_VIEWPORT_REFRESH_EVENT));
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [active]);
  return stageRef;
}
