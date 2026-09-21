import { poolCapturedAt } from "./poolOrder";
import { photoSizeLabel } from "./photoModel";
import type { JSX } from "react";

import type { ClipListItem } from "../api";
import { bandDurationLabel } from "./BandSegment";
import { takeDateLabel } from "./inspectorModel";
import { ClipMoreButton } from "./ClipMenu";
import { InspectorRelink } from "./InspectorRelink";
import { Button, CoverImage } from "./ui";
import { useWorkspace } from "./WorkspaceStore";

/**
 * 检查器头部(C 稿):缩略图 + 文件名 + 拍摄日期 · 时长,右侧「上一条 / 下一条」——
 * 顺序就是媒体池的顺序(useSelection 的默认序),两端各禁一个。
 */
export function InspectorHeader({
  clip,
  index,
  total,
  onStep,
}: {
  clip: ClipListItem;
  /** 在媒体池顺序里的 0 基位置;-1 = 不在当前列表里(筛选掉了)。 */
  index: number;
  total: number;
  onStep: (direction: -1 | 1) => void;
}): JSX.Element {
  const date = clip.kind === "photo" ? poolCapturedAt(clip)?.slice(0, 10) ?? null : takeDateLabel(clip);
  const duration = clip.kind === "photo" ? photoSizeLabel(clip) : clip.duration_ticks === null ? null : bandDurationLabel(clip.duration_ticks, clip.tb_num ?? 1, clip.tb_den ?? 1_000);
  const subtitle = [date, duration].filter((part): part is string => part !== null).join(" · ");
  // R16 §1:头部「···」与媒体池右键同一张菜单;这条在多选里时作用于整组。
  const multiSelection = useWorkspace((state) => state.multiSelection);
  return (
    <>
    <div className="inspector-head">
      <span className="inspector-head-thumb" aria-hidden="true">
        <CoverImage src={clip.cover_url} />
      </span>
      <span className="inspector-head-text">
        <span className="inspector-head-name" title={clip.file_name}>
          {clip.file_name}
        </span>
        {subtitle ? <span className="inspector-head-sub">{subtitle}</span> : null}
      </span>
      <span className="inspector-head-nav">
        <Button variant="icon" icon="prev" aria-label="上一条" disabled={index <= 0} onClick={() => onStep(-1)} />
        <Button variant="icon" icon="next" aria-label="下一条" disabled={index < 0 || index >= total - 1} onClick={() => onStep(1)} />
        {clip.id !== null ? <ClipMoreButton clipId={clip.id} multiSelection={multiSelection} context={{ canAddToBand: clip.kind === "video" }} /> : null}
      </span>
    </div>
    {/* R16 P1-7:原片不在原位时,头部下面一行「找到它…」(与缺失页同入口)。 */}
    <InspectorRelink clipId={clip.id ?? -1} fileName={clip.file_name} missing={Boolean(clip.missing_since) && clip.id !== null} />
    </>
  );
}
