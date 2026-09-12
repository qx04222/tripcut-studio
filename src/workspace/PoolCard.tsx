import type { JSX } from "react";

import { AnalysisBadges, analysisBadgeKinds } from "../AnalysisPanel";
import type { ClipListItem } from "../api";
import { clipAriaLabel, fileNameLines, poolDateLabel, poolDurationLabel, poolRatingLabel } from "./poolModel";
import { Badge, Card, CoverImage, Icon } from "./ui";

/**
 * 媒体池的一张卡(规格 §3.5,视觉按 A 稿「编辑台密度」)。从 `MediaPool.tsx` 拆出来只为
 * 守住 400 行上限;`aria-label` 仍由 `clipAriaLabel` 一字不差地生成,回显 id 仍是
 * `pool-clip-{id}`。评级用图标画,但 AX 名里的评级还是文字 —— 图标全是 aria-hidden。
 */

function RatingMark({ clip }: { clip: ClipListItem }): JSX.Element {
  const label = poolRatingLabel(clip);
  if (label === "收藏") {
    return (
      <Badge tone="accent" icon="heart" className="pool-card-rating favorite">
        {label}
      </Badge>
    );
  }
  if (label === "拒绝") {
    return (
      <Badge tone="danger" icon="x" className="pool-card-rating rejected">
        {label}
      </Badge>
    );
  }
  const stars = /^(\d) 星$/.exec(label);
  if (stars) {
    const count = Number(stars[1]);
    const icons: JSX.Element[] = [];
    for (let index = 0; index < count; index += 1) {
      icons.push(<Icon key={index} name="star" size={12} filled />);
    }
    return (
      <span className="pool-card-rating stars" aria-hidden="true">
        {icons}
      </span>
    );
  }
  return <small className="pool-card-rating unrated">{label}</small>;
}

export function PoolCard({
  clip,
  columnIndex,
  semanticScore,
  stackCount,
  selected,
  isAnchor,
  inMultiSelection,
  onSelect,
}: {
  clip: ClipListItem;
  columnIndex: number;
  semanticScore?: number;
  stackCount?: number;
  selected: boolean;
  isAnchor: boolean;
  inMultiSelection: boolean;
  onSelect: (modifiers: { shift?: boolean; meta?: boolean }) => void;
}): JSX.Element {
  const [nameHead, nameTail] = fileNameLines(clip.file_name);
  const date = poolDateLabel(clip);
  const rating = poolRatingLabel(clip);
  // 没有任何提示、也不在分析中的卡片不画角标行 —— 60 张卡 60 条「—」就是这么来的。
  const showBadges =
    analysisBadgeKinds(clip).length > 0 ||
    clip.analysis_status === "pending" ||
    clip.analysis_status === "running";
  return (
    <Card
      as="button"
      interactive
      selected={selected}
      // 回显 id 由 useSelection.echoElementId 统一生成 —— 镜头带按同一套规则找它。
      id={`pool-clip-${clip.id}`}
      role="gridcell"
      aria-colindex={columnIndex}
      // roving tabindex:整张网格对 Tab 只有一个落点 —— 锚点卡片(没有锚点时是容器)。
      tabIndex={isAnchor ? 0 : -1}
      className={`pool-card${selected ? " selected" : ""}${inMultiSelection ? " multi" : ""}`}
      aria-selected={selected}
      aria-label={clipAriaLabel(clip)}
      onClick={(event) => onSelect({ shift: event.shiftKey, meta: event.metaKey || event.ctrlKey })}
    >
      <span className="pool-card-image">
        {/* 没封面 = 分析还没跑到;封面文件坏了(分析失败)= 中性胶片占位,不留坏图(R9 D4)。 */}
        <CoverImage
          src={clip.cover_url}
          crossOrigin="anonymous"
          lazy
          fallback={clip.cover_url ? undefined : <span className="pool-card-missing">等待封面</span>}
        />
        {rating === "拒绝" ? <span className="pool-card-rejected-veil" aria-hidden="true" /> : null}
        {rating === "收藏" ? (
          <span className="pool-card-fav" aria-hidden="true">
            <Icon name="heart" size={12} filled />
          </span>
        ) : null}
        <Badge tone="ink" className="pool-card-time">
          {poolDurationLabel(clip)}
        </Badge>
        {clip.generated_source ? (
          <Badge tone="ink" className="pool-card-generated">
            AI 生成
          </Badge>
        ) : null}
        {stackCount !== undefined ? (
          <Badge tone="ink" className="pool-card-stack">
            {stackCount} 条候选
          </Badge>
        ) : null}
        {semanticScore !== undefined ? (
          <Badge tone="ink" className="pool-card-match">
            匹配度 {Math.round(Math.min(1, Math.max(0, semanticScore)) * 100)}%
          </Badge>
        ) : null}
      </span>
      <span className="pool-card-name" title={clip.file_name}>
        <span className="pool-card-name-line">{nameHead}</span>
        {nameTail !== null ? <span className="pool-card-name-line">{nameTail}</span> : null}
      </span>
      <span className="pool-card-meta">
        {date ? <small className="pool-card-date">{date}</small> : null}
        <RatingMark clip={clip} />
      </span>
      {showBadges ? (
        <span className="pool-card-badges">
          <AnalysisBadges clip={clip} compact />
        </span>
      ) : null}
    </Card>
  );
}
