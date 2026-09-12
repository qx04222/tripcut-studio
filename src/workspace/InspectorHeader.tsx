import type { JSX } from "react";

import type { ClipListItem } from "../api";
import { bandDurationLabel } from "./BandSegment";
import { takeDateLabel } from "./inspectorModel";
import { Button, CoverImage } from "./ui";

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
  const date = takeDateLabel(clip);
  const duration = clip.duration_ticks === null ? null : bandDurationLabel(clip.duration_ticks, clip.tb_num ?? 1, clip.tb_den ?? 1_000);
  const subtitle = [date, duration].filter((part): part is string => part !== null).join(" · ");
  return (
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
      </span>
    </div>
  );
}
