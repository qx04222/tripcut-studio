import { useCallback, useEffect, useMemo, useState } from "react";
import { listMissingClips, pickRelinkFolder, relinkVolume, type MissingClip, type RelinkOutcome } from "../../api";
import { groupByVolume, type VolumeGroup } from "./importModel";

export interface MissingMedia {
  clips: readonly MissingClip[];
  groups: readonly VolumeGroup[];
  /** 正在重连的卷 uuid。 */
  busy: string | null;
  results: Record<string, RelinkOutcome>;
  notice: string | null;
  relink(volumeUuid: string): Promise<void>;
  refresh(): void;
}

/** 抽自 `MissingMediaPanel`:拉缺失清单、按卷分组、选新位置重绑(取消不调 relink)。 */
export function useMissingMedia(): MissingMedia {
  const [clips, setClips] = useState<MissingClip[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RelinkOutcome>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void listMissingClips().then(setClips).catch((error) => setNotice(String(error)));
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
      setNotice(String(error));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const groups = useMemo(() => groupByVolume(clips), [clips]);
  return { clips, groups, busy, results, notice, relink, refresh };
}
