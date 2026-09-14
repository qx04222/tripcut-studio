import type { JSX } from "react";

import { requestClipRemoval } from "../clipRemoval";
import { VOLUME_GONE_LABEL, menuAriaLabel } from "../copy";
import { Button } from "../ui/Button";
import type { VolumeGroup } from "./importModel";

/** 确认卡标题:说清是哪个盘、几条。 */
export function volumeGoneTitle(group: Pick<VolumeGroup, "volumeLabel" | "volumeUuid" | "clips">): string {
  return `移除「${group.volumeLabel ?? group.volumeUuid}」上的 ${group.clips.length} 条素材`;
}

/**
 * R16 P2-9:缺失页卷组的「这个盘不会再回来了…」—— 硬盘真丢了,把这个卷上的素材从当前集移除,
 * 「缺失素材 n」不再永远挂着。走 P1-1 同一张后果预览确认卡(破坏性,确认);删完重取缺失清单。
 */
export function MissingVolumeRemove({ group, disabled, onRemoved }: { group: VolumeGroup; disabled?: boolean; onRemoved: () => void }): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      tone="danger"
      aria-label={menuAriaLabel(VOLUME_GONE_LABEL)}
      className="import-missing-gone"
      disabled={disabled}
      onClick={() => void requestClipRemoval(group.clips.map((clip) => clip.clip_id), { title: volumeGoneTitle(group), onRemoved })}
    >
      {VOLUME_GONE_LABEL}
    </Button>
  );
}
