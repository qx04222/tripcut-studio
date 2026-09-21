import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";

import type { ClipListItem } from "../api";
import { prefersReducedMotion, scrubFrameIndex, stripFrameCount, stripFrameStyle, stripUrlFor } from "./poolScrub";

export interface PoolScrub {
  /** 帧条铺在封面上的样式;没在刮擦 / 没帧条 = null(封面照常)。 */
  style: CSSProperties | null;
  /** 0–1 的横向位置,画一根细线;不在刮擦 = null。 */
  ratio: number | null;
  onMouseEnter(): void;
  onMouseMove(event: MouseEvent<HTMLElement>): void;
  onMouseLeave(): void;
}

/**
 * R11 §3 媒体池卡片的悬停刮擦。进卡片才去拿帧条(缓存在 poolScrub 里);鼠标横向滑过按
 * 比例切帧;移开恢复封面。无帧条 → 静态封面;`prefers-reduced-motion` → 整个关掉。
 */
export function usePoolScrub(clip: ClipListItem): PoolScrub {
  const clipId = clip.kind === "photo" ? null : clip.id;
  const frames = stripFrameCount(clip);
  const [strip, setStrip] = useState<string | null>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  const active = useRef(false);

  useEffect(() => {
    setStrip(null);
    setRatio(null);
    active.current = false;
  }, [clipId]);

  const onMouseEnter = useCallback(() => {
    if (clipId === null || prefersReducedMotion()) return;
    active.current = true;
    void stripUrlFor(clipId).then((url) => {
      if (active.current) setStrip(url);
    });
  }, [clipId]);

  const onMouseMove = useCallback((event: MouseEvent<HTMLElement>) => {
    if (!active.current) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return;
    setRatio(Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)));
  }, []);

  const onMouseLeave = useCallback(() => {
    active.current = false;
    setRatio(null);
  }, []);

  const style = strip !== null && ratio !== null ? stripFrameStyle(strip, scrubFrameIndex(ratio, frames), frames) : null;
  return { style, ratio: strip !== null ? ratio : null, onMouseEnter, onMouseMove, onMouseLeave };
}
