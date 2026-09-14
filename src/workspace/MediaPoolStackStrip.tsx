import { useState, type JSX } from "react";

import type { ClipListItem, ShotStack, ShotStackMember } from "../api";
import { orderedTakes } from "./shotBandModel";
import { poolDurationLabel } from "./poolModel";
import { Badge, Button, Card, CoverImage, Icon } from "./ui";
import { stackGroupLabel, takeLabel } from "./copy";

/** 候选条先露几条;其余折在尾部「还有 n 条」后面(U-26)。 */
export const POOL_STACK_PREVIEW = 6;

/**
 * 媒体池里的 Stack 展开视图(U-02 / U-26):点卡片角标「n 条候选」或在卡片上按 Tab
 * 展开,贴在网格下方 —— 不塞进虚拟化网格里,行高与 aria-rowcount 都不用动。
 * 每条是 `Card interactive`(缩略图 + Take n · 文件名);点一条即选中那条素材,
 * 监视器与检查器跟着走。默认只露 `POOL_STACK_PREVIEW` 条,尾部「还有 n 条」点开全列。
 *
 * 新 AX 名:group「{scene} 的候选」(与镜头带 Take 条同名,两者不会同时出现在同一栏);
 * 按钮「收起候选」「还有 n 条」;候选卡「Take n · {文件名}」。
 */
export function PoolStackStrip({
  stack,
  clipsById,
  activeClipId,
  onPick,
  onClose,
}: {
  stack: ShotStack;
  clipsById: ReadonlyMap<number, ClipListItem>;
  activeClipId: number | null;
  onPick: (member: ShotStackMember) => void;
  onClose: () => void;
}): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const takes = orderedTakes(stack, clipsById);
  const hidden = showAll ? 0 : Math.max(0, takes.length - POOL_STACK_PREVIEW);
  const shown = hidden > 0 ? takes.slice(0, POOL_STACK_PREVIEW) : takes;
  return (
    <div className="pool-stack-strip" role="group" aria-label={stackGroupLabel(stack.scene_name)}>
      <div className="pool-stack-head">
        <span className="pool-stack-title">
          <Icon name="chevron-down" size={12} />
          {stack.scene_name} · 同一镜头 {takes.length} 条
        </span>
        <Button variant="ghost" size="sm" aria-label="收起同一镜头" onClick={onClose}>
          收起
        </Button>
      </div>
      <div className="pool-stack-cards">
        {shown.map((member, index) => {
          const clip = clipsById.get(member.clip_id);
          const name = clip?.file_name ?? `素材 #${member.clip_id}`;
          const active = member.clip_id === activeClipId;
          return (
            <Card
              as="button"
              interactive
              selected={active}
              key={`${member.clip_id}:${member.segment_id ?? "whole"}`}
              className="pool-take-card"
              aria-current={active ? "true" : undefined}
              aria-label={takeLabel(index + 1, name)}
              onClick={() => onPick(member)}
            >
              <span className="pool-take-thumb" aria-hidden="true">
                <CoverImage src={clip?.cover_url} crossOrigin="anonymous" lazy />
                {member.is_preferred ? (
                  <Badge tone="accent" className="pool-take-hero">
                    首选
                  </Badge>
                ) : null}
                {clip ? (
                  <Badge tone="ink" className="pool-take-time">
                    {poolDurationLabel(clip)}
                  </Badge>
                ) : null}
              </span>
              <span className="pool-take-caption" aria-hidden="true">
                <span className="pool-take-order">{`第 ${index + 1} 条`}</span>
                <span className="pool-take-name" title={name}>
                  {name}
                </span>
              </span>
            </Card>
          );
        })}
        {hidden > 0 ? (
          <Button
            variant="secondary"
            size="sm"
            className="pool-take-more"
            onClick={() => setShowAll(true)}
          >
            还有 {hidden} 条
          </Button>
        ) : null}
      </div>
    </div>
  );
}
