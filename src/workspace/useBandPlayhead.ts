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
  source?: BandSeekSource;
}

export interface BandPlayhead {
  /** 播放头在节距轴上的像素;素材不在带上 / 播放器没就绪时 null。 */
  px: number | null;
  /** 正在播(播放头会动)。 */
  playing: boolean;
  positionSec: number | null;
  /** 把播放器定位到某条素材的 0..1 处;素材未就绪则等它就绪再发。 */
  /** `source: "band-trim"` = 拖边修剪的跟随 seek:不广播 manual-seek(连播不停,改为挂起),detail 带 source 递到走带(0.11.3 接线)。 */
  requestSeek(clipId: number, ratio: number, options?: { source: BandSeekSource }): void;
}

export type BandSeekSource = "band-trim";
export function dispatchSeekRatio(ratio: number, source?: BandSeekSource): void {
  window.dispatchEvent(new CustomEvent(SEEK_RATIO_EVENT, { detail: source ? { ratio, source } : { ratio } }));
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
            dispatchSeekRatio(waiting.ratio, waiting.source);
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

  const requestSeek = useCallback((clipId: number, ratio: number, options?: { source: BandSeekSource }) => {
    if (!options?.source) window.dispatchEvent(new Event("tripcut:manual-seek"));
    const current = latest.current;
    if (current && current.phase === "ready" && current.clip_id === clipId) {
      pending.current = null;
      dispatchSeekRatio(ratio, options?.source);
      return;
    }
    pending.current = { clipId, ratio, source: options?.source };
  }, []);

  const px = useMemo(() => {
    if (!status || status.phase !== "ready" || status.clip_id === null) return null;
    return playheadPx(spans, status.clip_id, status.pos * 1_000);
  }, [spans, status]);

  // R22-C `[` / `]`:只有播放器正放着**当前选中**这条素材时,播放头位置才能当它的入 / 出点用
  // (连播刚切到下一条、选择还没跟上的一瞬,status.clip_id ≠ selectedClipId → null,不把别条的时刻写进来)。
  // 播放头本身(px)不按选中过滤:它画的是播放器实际在放的那一格,与 R13 / R17 真机验收时一致。
  const positionSec = status?.phase === "ready" && status.clip_id !== null && status.clip_id === selectedClipId ? status.pos : null;
  return { px, positionSec, playing: status?.phase === "ready" && !status.paused, requestSeek };
}
