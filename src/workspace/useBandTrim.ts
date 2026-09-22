import { useCallback, useRef, useState } from "react";

import { registerBandUndo } from "./useBandArrange";
import { trimBandSegment, type ClipListItem, type Storyboard } from "../api";
import { failureText } from "./errorText";
import type { BandSegment } from "./shotBandModel";
import { showToast } from "./ui/Toast";
import { getClipsFeedSnapshot, refreshClipsFeed } from "./useClipsFeed";

/**
 * R13 §4 → R22-C 第 3 项:拖边裁入出点的写入路径。**只改我们自己的精选段**(`segments`,kind = select),不动原片。
 *
 * R13 时后端没有「更新精选段入出点」的命令,走的是「建新 → 换引用 → 删旧」三步,段 id 每裁一次就换一个
 * (AI 来源 / 理由也跟着丢)。R22-C 加了原生 `trim_band_segment`:同一事务里按 `expected`(拖起时的旧入出点)
 * 校验后原位 UPDATE —— 段 id、评级、来源 / 理由都保留;旧值对不上(别处已改过)就拒绝,不会盖掉别人的修剪。
 * 撤销 = 用同一条命令把 bounds / expected 对调写回。素材时长未知的越界由原生端拒绝(前端只钳到已知边界)。
 */
export const TRIM_TOAST_PREFIX = "已裁成";

export interface BandTrimApi {
  busy: boolean;
  /** 素材总时长(秒);tb / 时长没就绪时 null(出点不封顶,由后端夹取)。 */
  clipSeconds(clipId: number | null): number | null;
  preview?(segment: BandSegment, seconds: number): void;
  frameStep?(clipId: number | null): number;
  commit(segment: BandSegment, inSec: number, outSec: number): void;
}

export function clipDurationSeconds(clip: Pick<ClipListItem, "duration_ticks" | "tb_num" | "tb_den"> | undefined): number | null {
  if (!clip || clip.duration_ticks === null || clip.tb_num === null || clip.tb_den === null || clip.tb_num <= 0 || clip.tb_den <= 0) return null;
  return (clip.duration_ticks * clip.tb_num) / clip.tb_den;
}

export function useBandTrim(board: Storyboard | null, clipsById: ReadonlyMap<number, ClipListItem>): BandTrimApi {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const clipSeconds = useCallback((clipId: number | null) => (clipId === null ? null : clipDurationSeconds(clipsById.get(clipId))), [clipsById]);

  const commit = useCallback(
    (segment: BandSegment, inSec: number, outSec: number) => {
      if (busyRef.current || board === null || segment.clipId === null || segment.segmentId === null) return;
      const oldId = segment.segmentId;
      busyRef.current = true;
      setBusy(true);
      void (async () => {
        try {
          const { episode } = getClipsFeedSnapshot();
          if (episode.viewing !== null || episode.activeId === null) return;
          const expected: [number, number] = [segment.inTicks, segment.outTicks];
          const bounds: [number, number] = [Math.round(inSec * segment.tbDen / segment.tbNum), Math.round(outSec * segment.tbDen / segment.tbNum)];
          await trimBandSegment(episode.activeId, oldId, expected, bounds);
          registerBandUndo("修剪 1 段", () => trimBandSegment(episode.activeId!, oldId, bounds, expected));
          await refreshClipsFeed(true);
        } catch (error) {
          showToast(failureText("裁剪", error), { tone: "danger" });
        } finally {
          busyRef.current = false;
          setBusy(false);
        }
      })();
    },
    [board],
  );

  const frameStep = (id: number | null) => {
    const clip = id === null ? null : clipsById.get(id);
    return clip?.fps_num && clip.fps_den ? clip.fps_den / clip.fps_num : 0.04;
  };
  return { busy, clipSeconds, commit, frameStep };
}
