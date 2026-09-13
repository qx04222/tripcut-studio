import type { CSSProperties } from "react";

import { getClipArtifacts, type ClipArtifacts, type ClipListItem } from "../api";

/**
 * R11 §3 媒体池悬停刮擦的纯函数与帧条缓存。帧条(strip)是后端 `get_clip_artifacts` 给的
 * 一张横向拼图:`strip_frame_count` = ceil(时长/5) 夹在 1–12(与 Rust 同一条规则),每帧
 * 160px 宽、`tile=Nx1`。鼠标在卡片上的横向比例 → 第几帧 → `background-position`。
 */

/** 与 `src-tauri/src/core/artifacts.rs::strip_frame_count` 一致:每 5 s 一帧,1–12 帧。 */
export function stripFrameCount(clip: Pick<ClipListItem, "duration_ticks" | "tb_num" | "tb_den">): number {
  if (clip.duration_ticks === null || clip.tb_num === null || clip.tb_den === null || clip.tb_den <= 0) return 1;
  const seconds = Math.max(0, (clip.duration_ticks * clip.tb_num) / clip.tb_den);
  return Math.min(12, Math.max(1, Math.ceil(seconds / 5)));
}

/** 横向比例(0–1)→ 帧下标(0..frames-1)。 */
export function scrubFrameIndex(ratio: number, frames: number): number {
  if (frames <= 1) return 0;
  const safe = Math.min(0.999_999, Math.max(0, ratio));
  return Math.min(frames - 1, Math.floor(safe * frames));
}

/** 把帧条铺成封面大小、只露出第 frame 帧。 */
export function stripFrameStyle(stripUrl: string, frame: number, frames: number): CSSProperties {
  const position = frames <= 1 ? 0 : (frame / (frames - 1)) * 100;
  return {
    backgroundImage: `url(${stripUrl})`,
    backgroundPosition: `${position}% center`,
    backgroundSize: `${frames * 100}% 100%`,
  };
}

/** 用户开了「减弱动态效果」就不刮擦(规格 §3)。没有 matchMedia 的环境(测试)当作没开。 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const cache = new Map<number, Promise<string | null>>();

/**
 * 帧条 URL,按素材缓存。只在悬停时才问后端(60 张卡同时拉是 R9 就踩过的坑);还没生成
 * (statuses.strip 不是 ready/direct)就记成 null 且**不缓存**,下次悬停再问一次。
 */
export function stripUrlFor(clipId: number): Promise<string | null> {
  const existing = cache.get(clipId);
  if (existing) return existing;
  const request = getClipArtifacts(clipId)
    .then((artifacts: ClipArtifacts) => {
      if (artifacts.strip) return artifacts.strip;
      cache.delete(clipId);
      return null;
    })
    .catch(() => {
      cache.delete(clipId);
      return null;
    });
  cache.set(clipId, request);
  return request;
}

export function __resetPoolScrubCacheForTests(): void {
  cache.clear();
}
