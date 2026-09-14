import { useCallback, useEffect, useMemo, useState } from "react";
import { listMissingClips, pickRelinkFile, pickRelinkFolder, relinkClip, relinkVolume, type MissingClip, type RelinkOutcome } from "../../api";
import { groupByVolume, type VolumeGroup } from "./importModel";
import { failureText } from "../errorText";

export interface MissingMedia {
  clips: readonly MissingClip[];
  groups: readonly VolumeGroup[];
  /** 正在重连的卷 uuid。 */
  busy: string | null;
  results: Record<string, RelinkOutcome>;
  notice: string | null;
  relink(volumeUuid: string): Promise<void>;
  refresh(): void;
  /** R16 P1-7:正在单条重连的素材 id。 */
  busyClip: number | null;
  /** R16 P1-7:「找到它…」——文件面板选同名文件 → `relink_clip`;取消不调。 */
  relinkOne(clipId: number, fileName: string): Promise<void>;
}

/** 抽自 `MissingMediaPanel`:拉缺失清单、按卷分组、选新位置重绑(取消不调 relink)。 */
export function useMissingMedia(): MissingMedia {
  const [clips, setClips] = useState<MissingClip[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RelinkOutcome>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void listMissingClips().then(setClips).catch((error) => setNotice(failureText("读取缺失素材", error)));
  }, []);
  useEffect(refresh, [refresh]);

  const relink = useCallback(async (volumeUuid: string) => {
    setBusy(volumeUuid);
    setNotice(null);
    try {
      const folder = await pickRelinkFolder();
      if (!folder) return;
      const outcome = await relinkVolume(volumeUuid, folder);
      setResults((previous) => ({ ...previous, [volumeUuid]: outcome }));
      refresh();
    } catch (error) {
      setNotice(failureText("重新定位", error, "确认新位置里有同名文件后再试"));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const [busyClip, setBusyClip] = useState<number | null>(null);
  const relinkOne = useCallback(async (clipId: number, fileName: string) => {
    setBusyClip(clipId);
    setNotice(null);
    try {
      const path = await pickRelinkFile(fileName);
      if (!path) return;
      const outcome = await relinkClip(clipId, path);
      setNotice(`已找到 ${outcome.file_name},分析结果与评分都还在。`);
      // 成功那条立刻从本地清单拿掉,再对齐一次后端。
      setClips((current) => current.filter((clip) => clip.clip_id !== clipId));
      refresh();
    } catch (error) {
      setNotice(failureText("找到它", error, "请选同名、同一段视频的那个文件"));
    } finally {
      setBusyClip(null);
    }
  }, [refresh]);

  const groups = useMemo(() => groupByVolume(clips), [clips]);
  return { clips, groups, busy, results, notice, relink, refresh, busyClip, relinkOne };
}
