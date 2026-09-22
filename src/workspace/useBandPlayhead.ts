import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { playerStatus, type PlayerStatus } from "../api";
import { playheadPx, type TimelineSpan } from "./bandTimeline";

/**
 * R13 §4:镜头带的播放头与「点哪就 seek 到哪」。
 *
 * 监视器是唯一握着嵌入通道的人,这里不碰 `player/mod.rs`,也不另开通道:播放头只是每
 * 250ms 读一次既有的 `player_status`(选中素材在带上时才读;窗口不可见就停表),按状态里的
 * `pos` 与镜块入出点换算出像素。seek 走既有的 `tripcut:seek-ratio` 广播(监视器收) ——
 * 目标素材还没就绪(刚切过去)时先记着,状态追上「就绪且是那条」再发。
 */

export const PLAYHEAD_POLL_MS = 250;
export const SEEK_RATIO_EVENT = "tripcut:seek-ratio";

interface PendingSeek {
  clipId: number;
  ratio: number;
}

export interface BandPlayhead {
  /** 播放头在节距轴上的像素;素材不在带上 / 播放器没就绪时 null。 */
  px: number | null;
  /** 正在播(播放头会动)。 */
  playing: boolean;
  /** 把播放器定位到某条素材的 0..1 处;素材未就绪则等它就绪再发。 */
  requestSeek(clipId: number, ratio: number): void;
}

export function dispatchSeekRatio(ratio: number): void {
  window.dispatchEvent(new CustomEvent(SEEK_RATIO_EVENT, { detail: { ratio } }));
}

export function useBandPlayhead(spans: readonly TimelineSpan[], selectedClipId: number | null): BandPlayhead {
  const [status, setStatus] = useState<PlayerStatus | null>(null);
  const pending = useRef<PendingSeek | null>(null);
  const latest = useRef<PlayerStatus | null>(null);
  latest.current = status;

  const onBand = useMemo(() => selectedClipId !== null && spans.some((span) => span.clipId === selectedClipId), [spans, selectedClipId]);

  // R17 playfix:待发的 seek 只对这一次选中有效 —— 选中换成别的素材就作废,免得几分钟后再选回
  // 目标素材时,它一就绪就被定位到早已过期的位置。
  useEffect(() => {
    if (pending.current && pending.current.clipId !== selectedClipId) pending.current = null;
  }, [selectedClipId]);

  useEffect(() => {
    if (!onBand) {
      setStatus(null);
      return;
    }
    let active = true;
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void playerStatus()
        .then((next) => {
          if (!active) return;
          setStatus(next);
          const waiting = pending.current;
          if (waiting && next.phase === "ready" && next.clip_id === waiting.clipId) {
            pending.current = null;
            dispatchSeekRatio(waiting.ratio);
          }
        })
        .catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, PLAYHEAD_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [onBand, selectedClipId]);

  const requestSeek = useCallback((clipId: number, ratio: number) => {
    window.dispatchEvent(new Event("tripcut:manual-seek"));
    const current = latest.current;
    if (current && current.phase === "ready" && current.clip_id === clipId) {
      pending.current = null;
      dispatchSeekRatio(ratio);
      return;
    }
    pending.current = { clipId, ratio };
  }, []);

  const px = useMemo(() => {
    if (!status || status.phase !== "ready" || status.clip_id === null) return null;
    return playheadPx(spans, status.clip_id, status.pos * 1_000);
  }, [spans, status]);

  return { px, playing: status?.phase === "ready" && !status.paused, requestSeek };
}
