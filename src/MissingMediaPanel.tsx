import { useEffect, useState } from "react";
import { listMissingClips, pickRelinkFolder, relinkVolume, type MissingClip, type RelinkOutcome } from "./api";

interface VolumeGroup {
  volumeUuid: string;
  volumeLabel: string | null;
  clips: MissingClip[];
}

function groupByVolume(clips: MissingClip[]): VolumeGroup[] {
  const groups = new Map<string, VolumeGroup>();
  for (const clip of clips) {
    let group = groups.get(clip.volume_uuid);
    if (!group) {
      group = { volumeUuid: clip.volume_uuid, volumeLabel: clip.volume_label, clips: [] };
      groups.set(clip.volume_uuid, group);
    }
    group.clips.push(clip);
  }
  return [...groups.values()];
}

export function MissingMediaPanel() {
  const [clips, setClips] = useState<MissingClip[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RelinkOutcome>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () => void listMissingClips().then(setClips).catch((error) => setNotice(String(error)));
  useEffect(refresh, []);

  const relink = (volumeUuid: string) => void (async () => {
    setBusy(volumeUuid);
    setNotice(null);
    try {
      const folder = await pickRelinkFolder();
      if (!folder) return;
      const outcome = await relinkVolume(volumeUuid, folder);
      setResults((previous) => ({ ...previous, [volumeUuid]: outcome }));
      await Promise.resolve(refresh());
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(null);
    }
  })();

  if (clips.length === 0) return null;

  const groups = groupByVolume(clips);

  return (
    <div className="missing-media-panel" aria-label="缺失素材重连">
      <strong>缺失素材需要重连</strong>
      {groups.map((group) => {
        const outcome = results[group.volumeUuid];
        return (
          <div className="missing-media-volume" key={group.volumeUuid}>
            <span>{group.volumeLabel ?? group.volumeUuid} · {group.clips.length} 个文件缺失</span>
            <ul>
              {group.clips.map((clip) => (
                <li key={clip.clip_id}>{clip.file_name}</li>
              ))}
            </ul>
            <button disabled={busy === group.volumeUuid} onClick={() => relink(group.volumeUuid)}>
              {busy === group.volumeUuid ? "正在重连…" : "选择新位置"}
            </button>
            {outcome ? (
              <p role="status">
                已重绑 {outcome.relinked}（已更新卷标识）、拒绝 {outcome.rejected.length}
                {outcome.rejected.length ? `（${outcome.rejected.join("、")}）` : ""}
                、仍缺失 {outcome.still_missing}
              </p>
            ) : null}
          </div>
        );
      })}
      {notice ? <p role="status">{notice}</p> : null}
    </div>
  );
}
