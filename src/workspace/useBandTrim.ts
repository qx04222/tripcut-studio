import { useCallback, useRef, useState } from "react";

import { flattenStoryByChapter, storyOrderRefs } from "../Storyboard";
import { createSelectSegment, deleteSelectSegment, setStoryOrder, type ClipListItem, type Storyboard } from "../api";
import { trimDurationLabel } from "./bandTimeline";
import { failureText } from "./errorText";
import type { BandSegment } from "./shotBandModel";
import { showToast } from "./ui/Toast";
import { refreshClipsFeed } from "./useClipsFeed";

/**
 * R13 §4:拖边裁入出点的写入路径。**只改我们自己的精选段**(`segments`,kind = select),不动原片。
 *
 * 后端没有「更新精选段入出点」的命令(`ratings.rs` 只有 create / delete / restore),所以这里走
 * 「建新 → 把故事板里那一格换成新段 → 删旧」三步,镜块在带上的位置不变、id 换成新段的:
 *   1. `create_select_segment(clip, in, out)`(新段自带一条 binary=1 评级,与手动保存精选段同一条路);
 *   2. `set_story_order` 把旧段的引用原位换成新段(顺序表按章节扁平化后整体重写,与拖排同一个函数);
 *   3. `delete_select_segment(旧)` —— 墓碑,不是物理删除,`restore_select_segment` 还能救回来。
 * 第 2 步失败就把第 1 步建的新段删掉,不留一条没人引用的段。
 */

export const TRIM_TOAST_PREFIX = "已裁成";

export interface BandTrimApi {
  busy: boolean;
  /** 素材总时长(秒);tb / 时长没就绪时 null(出点不封顶,由后端夹取)。 */
  clipSeconds(clipId: number | null): number | null;
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
      const clipId = segment.clipId;
      const oldId = segment.segmentId;
      busyRef.current = true;
      setBusy(true);
      void (async () => {
        try {
          const created = await createSelectSegment(clipId, inSec, outSec);
          try {
            const items = board.items.map((item) =>
              item.segment_id === oldId && item.clip_id === clipId
                ? { ...item, key: `segment:${created.id}`, segment_id: created.id, in_ticks: created.in_ticks, out_ticks: created.out_ticks }
                : item,
            );
            await setStoryOrder(storyOrderRefs(flattenStoryByChapter(board.chapters, items)));
          } catch (error) {
            await deleteSelectSegment(created.id).catch(() => undefined);
            throw error;
          }
          await deleteSelectSegment(oldId);
          showToast(`${TRIM_TOAST_PREFIX} ${trimDurationLabel(outSec - inSec)}`, { tone: "success" });
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

  return { busy, clipSeconds, commit };
}
