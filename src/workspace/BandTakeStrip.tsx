import type { JSX } from "react";

import type { ClipListItem, ShotStack, ShotStackMember } from "../api";
import { bandDurationLabel } from "./BandSegment";
import { orderedTakes } from "./shotBandModel";
import { Badge, Card, CoverImage } from "./ui";
import { stackGroupLabel } from "./copy";

/**
 * Tab 展开的同镜头 Take 条(规格 §3.2):带下方一排缩略图卡,↑↓ 移动、Enter 提为首选。
 * 每条是 `Card interactive`(96×54 缩略图 + Take n · 文件名),生成片带「AI 生成」Badge。
 */
export function TakeStrip({
  stack,
  clipsById,
  activeIndex,
  onPick,
}: {
  stack: ShotStack;
  clipsById: ReadonlyMap<number, ClipListItem>;
  activeIndex: number;
  onPick: (member: ShotStackMember) => void;
}): JSX.Element {
  const takes = orderedTakes(stack, clipsById);
  return (
    <div className="band-take-strip" role="group" aria-label={stackGroupLabel(stack.scene_name)}>
      {takes.map((member, index) => {
        const clip = clipsById.get(member.clip_id);
        const active = index === activeIndex;
        return (
          <Card
            as="button"
            interactive
            selected={active}
            key={`${member.clip_id}:${member.segment_id ?? "whole"}`}
            className="band-take-card"
            aria-current={active ? "true" : undefined}
            onClick={() => onPick(member)}
          >
            <span className="band-take-thumb" aria-hidden="true">
              <CoverImage src={clip?.cover_url} />
              {clip?.generated_source ? (
                <Badge tone="accent" className="band-take-generated">
                  AI 生成
                </Badge>
              ) : null}
              {clip && clip.duration_ticks !== null ? (
                <Badge tone="ink" className="band-take-time">
                  {bandDurationLabel(clip.duration_ticks, clip.tb_num ?? 1, clip.tb_den ?? 1_000)}
                </Badge>
              ) : null}
            </span>
            <span className="band-take-caption">
              <span className="band-take-order">{`第 ${index + 1} 条`}</span>
              <span className="band-take-name" title={clip?.file_name}>
                {clip?.file_name ?? `素材 #${member.clip_id}`}
              </span>
            </span>
          </Card>
        );
      })}
    </div>
  );
}
