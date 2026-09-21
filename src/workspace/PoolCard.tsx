import { memo, useState, type JSX } from "react";

import { AnalysisBadges, analysisBadgeKinds } from "../AnalysisPanel";
import type { ClipListItem } from "../api";
import { clipAriaLabel, fileNameLines, poolDateLabel, poolDurationLabel, poolRatingLabel } from "./poolModel";
import { Badge, Card, CoverImage, Icon } from "./ui";
import { usePoolScrub } from "./usePoolScrub";
import { stackCountLabel } from "./copy";
import { companionRoleLabel } from "./photoModel";

/**
 * 媒体池的一张卡(规格 §3.5,视觉按 A 稿「编辑台密度」)。从 `MediaPool.tsx` 拆出来只为
 * 守住 400 行上限;`aria-label` 仍由 `clipAriaLabel` 一字不差地生成,回显 id 仍是
 * `pool-clip-{id}`。评级用图标画,但 AX 名里的评级还是文字 —— 图标全是 aria-hidden。
 */

/** R11 §1.2「有建议段」的小闪电(图标表不动:ICON_NAMES 的数量被测试钉死,别的车道也在加)。 */
function BoltMark(): JSX.Element {
  return (
    <span className="pool-card-bolt" aria-hidden="true" title="有建议段">
      <svg viewBox="0 0 16 16" width="11" height="11" focusable="false">
        <path d="M9 1.5L3.5 9h4l-.75 5.5L12.5 7h-4z" fill="currentColor" />
      </svg>
    </span>
  );
}

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

/**
 * R16 车道 E(§3 ④):`React.memo` —— 空闲态的重渲染主要靠 `useClipsFeed` 不换引用挡在上游;
 * memo 挡的是父组件(MediaPool)因选中 / 滚动窗口等原因重渲染时,props 没变的卡片。
 * R18 W-5:`onSelect` / `onToggleStack` 已经由 MediaPool 按 id 缓存成恒定引用
 * (`selectHandler` / `toggleHandler`),这条 memo 在「选中一条素材」这种交互态才真正生效。
 * 仍然不能自定义比较器忽略回调:`onToggleStack` 的语义依赖当前展开态,
 * 稳定的做法是让回调本身不捕获状态(函数式 setState),而不是让比较器装看不见。
 */
export const PoolCard = memo(PoolCardInner);

function PoolCardInner({
  clip,
  columnIndex,
  semanticScore,
  semanticAtSeconds,
  onSeekToMatch,
  stackCount,
  stackExpanded,
  onToggleStack,
  selected,
  isAnchor,
  inMultiSelection,
  onSelect,
  standaloneGridCell = true,
}: {
  clip: ClipListItem;
  columnIndex: number;
  semanticScore?: number;
  /** R18 C-2:画面搜索命中的是第几秒(帧级向量精排出来的);老库只到素材级时不传。 */
  semanticAtSeconds?: number;
  /** 点「第 n 秒」角标时调:选中这条并把监视器定位到那一秒。 */
  onSeekToMatch?: () => void;
  stackCount?: number;
  /** Stack 卡片:池内候选条是否展开(U-02);非 Stack 卡片不传。 */
  stackExpanded?: boolean;
  /** 点「n 条候选」角标时调(不改选中)。 */
  onToggleStack?: () => void;
  selected: boolean;
  isAnchor: boolean;
  inMultiSelection: boolean;
  onSelect: (modifiers: { shift?: boolean; meta?: boolean }) => void;
  /** 独立媒体池卡自己是 gridcell；照片工作台把卡与擂台操作包进同一个外层 gridcell。 */
  standaloneGridCell?: boolean;
}): JSX.Element {
  const [companionsOpen, setCompanionsOpen] = useState(false);
  const hasCompanions = (clip.companions?.length ?? 0) > 0;
  const [nameHead, nameTail] = fileNameLines(clip.file_name);
  // R11 §3:悬停刮擦(帧条来自已有缓存;没有就静态封面)。
  const scrub = usePoolScrub(clip);
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
      role={standaloneGridCell ? "gridcell" : undefined}
      aria-colindex={standaloneGridCell ? columnIndex : undefined}
      // roving tabindex:整张网格对 Tab 只有一个落点 —— 锚点卡片(没有锚点时是容器)。
      tabIndex={isAnchor ? 0 : -1}
      className={`pool-card${clip.kind === "photo" ? " photo-r21-card" : ""}${selected ? " selected" : ""}${inMultiSelection ? " multi" : ""}`}
      aria-selected={standaloneGridCell ? selected : undefined}
      aria-expanded={hasCompanions ? companionsOpen : stackCount !== undefined && onToggleStack ? stackExpanded === true : undefined}
      aria-label={clipAriaLabel(clip)}
      onKeyDown={(event) => {
        if (hasCompanions && event.altKey && event.key === "Enter") {
          event.preventDefault(); event.stopPropagation(); setCompanionsOpen(open => !open);
        }
      }}
      onMouseEnter={scrub.onMouseEnter}
      onMouseMove={scrub.onMouseMove}
      onMouseLeave={scrub.onMouseLeave}
      onClick={(event) => {
        // 角标「n 条候选」是卡片(一个 <button>)里的一块,不能再嵌一个按钮 ——
        // 点在角标上就当作「展开/收起」,不改选中(U-02)。
        const target = event.target as HTMLElement | null;
        if (hasCompanions && target?.closest?.(".photo-r21-raw")) {
          setCompanionsOpen(open => !open);
          return;
        }
        if (onToggleStack && target?.closest?.(".pool-card-stack")) {
          onToggleStack();
          return;
        }
        // R18 C-2:点「第 n 秒」= 选中这条并把监视器拉到那一秒。和上面的「n 条候选」
        // 一样是卡片(一个 <button>)里的一块,不能再嵌一个按钮。
        if (onSeekToMatch && target?.closest?.(".pool-card-at")) {
          onSeekToMatch();
          return;
        }
        onSelect({ shift: event.shiftKey, meta: event.metaKey || event.ctrlKey });
      }}
    >
      <span className="pool-card-image">
        {clip.kind === "photo" ? <span className="photo-r21-badge" role="img" aria-label="照片">照片</span> : null}
        {hasCompanions ? <span className="photo-r21-raw" title="展开伴随文件 · ⌥Enter">{clip.companions?.some(file => file.role.toLowerCase() === "raw") ? "RAW" : "伴随"}</span> : null}
        {companionsOpen ? <span className="photo-r21-companions" role="list" aria-label="伴随文件">
          {clip.companions?.map(file => <span role="listitem" key={file.path}>
            <span className="photo-r21-companion-name">{file.path.split(/[\\/]/).pop()}</span>
            <span className="photo-r21-companion-role">{companionRoleLabel(file.role)}</span>
          </span>)}
        </span> : null}
        {/* 没封面 = 分析还没跑到;封面文件坏了(分析失败)= 中性胶片占位,不留坏图(R9 D4)。 */}
        <CoverImage
          src={clip.cover_url}
          crossOrigin="anonymous"
          lazy
          fallback={clip.cover_url ? undefined : <span className="pool-card-missing">等待封面</span>}
        />
        {scrub.style ? <span className="pool-card-scrub" data-testid="pool-card-scrub" style={scrub.style} aria-hidden="true" /> : null}
        {scrub.ratio !== null ? (
          <span className="pool-card-scrub-cursor" aria-hidden="true" style={{ left: `${scrub.ratio * 100}%` }} />
        ) : null}
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
        {clip.missing_since ? (
          <Badge tone="danger" icon="warning" className="pool-card-missing-source">
            缺失
          </Badge>
        ) : null}
        {stackCount !== undefined ? (
          <Badge
            tone="ink"
            className={`pool-card-stack${onToggleStack ? " expandable" : ""}${stackExpanded ? " expanded" : ""}`}
          >
            {/* R18 V-18:重复组此前是一条文字角标(和拒绝卡的斜线底纹一起,是全站唯二的孤立语言)。
                改成「图标 + ×n」,与时长 / AI 生成 / 匹配度那一排角标同一套语言。
                icons 车道还没加 `takes`(两张卡叠),先用 `film` 顶着 —— 车道报告里记了待换。
                原文「同一镜头 n 条」留在视觉隐藏的一段里:AX 名与既有断言都靠它。 */}
            <Icon name="film" size={12} />
            <span aria-hidden="true">{`×${stackCount}`}</span>
            <span className="visually-hidden">{stackCountLabel(stackCount)}</span>
          </Badge>
        ) : null}
        {semanticScore !== undefined ? (
          <Badge tone="ink" className="pool-card-match">
            匹配度 {Math.round(Math.min(1, Math.max(0, semanticScore)) * 100)}%
          </Badge>
        ) : null}
        {semanticAtSeconds !== undefined ? (
          <Badge tone="ink" className="pool-card-at">
            <span aria-hidden="true">{`第 ${Math.max(0, Math.round(semanticAtSeconds))} 秒`}</span>
            <span className="visually-hidden">
              {`画面在第 ${Math.max(0, Math.round(semanticAtSeconds))} 秒,点这里跳过去`}
            </span>
          </Badge>
        ) : null}
        {clip.has_suggestions === true ? <BoltMark /> : null}
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
