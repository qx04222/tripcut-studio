import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CompositionEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type UIEvent,
} from "react";

import {
  AnalysisBadges,
  analysisBadgeKinds,
  motionClassLabel,
  type AnalysisBadgeKind,
} from "./AnalysisPanel";
import { formatTimecode, PlayerOverlay } from "./PlayerOverlay";
import { Group, Panel, Separator } from "react-resizable-panels";
import { StoryboardView } from "./Storyboard";
import { SELECTION_SHORTCUTS } from "./helpContent";
import {
  applyRescueRange,
  askDirector,
  deleteSelectSegment,
  describeClipWithAi,
  getAiDescription,
  getClipArtifacts,
  listClipDimensions,
  listAssetSafety,
  getLlmStatus,
  getSettings,
  listClips,
  listSelectSegments,
  listShotStacks,
  clearClipRating,
  rateClip,
  searchClips,
  searchTranscripts,
  setClipTimeStage,
  setShotStackUserState,
  type AiDescriptionResult,
  type AssetSafetyInfo,
  type ClipArtifacts,
  type ClipDimension,
  type ClipDimensionKey,
  type ClipListItem,
  type ClipSearchHit,
  type ShotStack,
  type ShotStackMember,
  type ShotStackUserState,
  type LlmStatus,
  type SelectSegment,
  type TranscriptMatch,
  getMemoryLens,
  type MemoryLensEntry,
  getCurrentEpisode,
} from "./api";

export type SelectionFilter = "all" | "favorite" | "unrated" | "rejected";
export type RatingAction =
  | { kind: "binary"; value: -1 | 1 }
  | { kind: "star"; value: 1 | 2 | 3 | 4 | 5 }
  | { kind: "clear" };

export interface ShotStackWallItem {
  clip: ClipListItem;
  stack?: ShotStack;
  semanticScore?: number;
}

export function isFilmGridShortcutTarget(
  target: EventTarget | null,
  grid: EventTarget | null,
): boolean {
  return target === grid;
}

export function filterSearchHitsToVisibleClips<T extends { clip_id: number }>(
  hits: T[],
  visibleClipIds: ReadonlySet<number>,
): T[] {
  return hits.filter((hit) => visibleClipIds.has(hit.clip_id));
}

const SUSPECT_BADGES = new Set<AnalysisBadgeKind>([
  "dark",
  "overexposed",
  "clipped",
  "soft_focus",
]);
const GRID_GAP = 14;
export const FILM_GRID_MIN_WIDTH = 280;
const GRID_ROW_HEIGHT = 260;
const STACK_DETAIL_HEIGHT = 300;

export function filmRowTop(row: number, expandedRow: number | null): number {
  return row * GRID_ROW_HEIGHT + (expandedRow !== null && row > expandedRow ? STACK_DETAIL_HEIGHT : 0);
}

export function filmRowAtOffset(offset: number, expandedRow: number | null): number {
  if (expandedRow === null || offset < (expandedRow + 1) * GRID_ROW_HEIGHT) {
    return Math.max(0, Math.floor(offset / GRID_ROW_HEIGHT));
  }
  if (offset < (expandedRow + 1) * GRID_ROW_HEIGHT + STACK_DETAIL_HEIGHT) return expandedRow;
  return Math.max(0, Math.floor((offset - STACK_DETAIL_HEIGHT) / GRID_ROW_HEIGHT));
}
const GRID_OVERSCAN_ROWS = 2;
const GRID_HORIZONTAL_PADDING = 24;

export function filmGridColumnCount(viewportWidth: number): number {
  const contentWidth = Math.max(0, viewportWidth - GRID_HORIZONTAL_PADDING);
  return Math.max(
    1,
    Math.floor((contentWidth + GRID_GAP) / (FILM_GRID_MIN_WIDTH + GRID_GAP)),
  );
}

const FILTER_LABELS: Record<SelectionFilter, string> = {
  all: "全部",
  favorite: "收藏",
  unrated: "未评",
  rejected: "拒绝",
};

const DIMENSION_LABELS: Record<ClipDimensionKey, string> = {
  movement: "①运动",
  shot_size: "②景别",
  subject: "③主体",
  viewpoint: "④视角",
  function: "⑤功能",
  person_state: "⑥人物状态",
  time_stage: "⑦时间阶段",
  sound: "⑧声音",
};

const DIMENSION_KEYS = Object.keys(DIMENSION_LABELS) as ClipDimensionKey[];
const TIME_STAGE_LABELS = ["出发", "路上", "到达", "探索", "吃饭", "活动", "日落夜景", "返回"];

function activeRating(value: number | null): number | null {
  return value === 0 ? null : value;
}

export function isSuspectedWaste(clip: ClipListItem): boolean {
  return analysisBadgeKinds(clip).some((kind) => SUSPECT_BADGES.has(kind));
}

export function filterSelectionClips(
  clips: ClipListItem[],
  filter: SelectionFilter,
  excludeSuspect: boolean,
  qualityExemptClipIds: ReadonlySet<number> = new Set(),
): ClipListItem[] {
  return clips.filter((clip) => {
    if (clip.id === null || clip.status !== "ready") return false;
    if (excludeSuspect && isSuspectedWaste(clip) && !qualityExemptClipIds.has(clip.id)) {
      return false;
    }
    const binary = activeRating(clip.binary_rating);
    const star = activeRating(clip.star_rating);
    switch (filter) {
      case "favorite":
        return binary === 1;
      case "unrated":
        return binary === null && star === null;
      case "rejected":
        return binary === -1;
      default:
        return true;
    }
  });
}

export function filterClipsByDimension(
  clips: ClipListItem[],
  dimensions: ClipDimension[],
  dimension: ClipDimensionKey | "",
  label: string,
): ClipListItem[] {
  if (!dimension || !label) return clips;
  const matchingIds = new Set(
    dimensions
      .filter((item) => item.dimension === dimension && item.label === label)
      .map((item) => item.clip_id),
  );
  return clips.filter((clip) => clip.id !== null && matchingIds.has(clip.id));
}

export function replaceShotStackMemberState(
  stacks: ShotStack[],
  stackId: number,
  clipId: number,
  userState: ShotStackUserState,
): ShotStack[] {
  return stacks.map((stack) => {
    if (stack.id !== stackId) return stack;
    const members = stack.members
      .map((member) => ({
        ...member,
        user_state:
          member.clip_id === clipId
            ? userState
            : userState === "locked" || userState === "hero"
              ? member.user_state === "locked" || member.user_state === "hero"
                ? "auto" as const
                : member.user_state
              : member.user_state,
        is_preferred: false,
      }))
      .sort((left, right) => {
        const rank = (state: ShotStackUserState) =>
          state === "hero" ? 0 : state === "locked" ? 1 : state === "auto" ? 2 : 3;
        return (
          rank(left.user_state) - rank(right.user_state) ||
          (right.best_take_score ?? -1) - (left.best_take_score ?? -1) ||
          left.clip_id - right.clip_id
        );
      });
    const preferredIndex = members.findIndex((member) => member.user_state !== "rejected");
    if (preferredIndex >= 0) {
      members[preferredIndex] = { ...members[preferredIndex], is_preferred: true };
    }
    return { ...stack, members };
  });
}

export function buildShotStackWallItems(
  filteredClips: ClipListItem[],
  allClips: ClipListItem[],
  stacks: ShotStack[],
  hideCandidates: boolean,
  semanticScores: ReadonlyMap<number, number> = new Map(),
): ShotStackWallItem[] {
  const clipsById = new Map(
    allClips
      .filter((clip): clip is ClipListItem & { id: number } => clip.id !== null)
      .map((clip) => [clip.id, clip] as const),
  );
  const filteredIds = new Set(
    filteredClips
      .map((clip) => clip.id)
      .filter((clipId): clipId is number => clipId !== null),
  );
  const stackByClipId = new Map<number, ShotStack>();
  stacks.forEach((stack) => {
    stack.members.forEach((member) => stackByClipId.set(member.clip_id, stack));
  });
  const emitted = new Set<number>();
  const items: ShotStackWallItem[] = [];
  filteredClips.forEach((clip) => {
    if (clip.id === null) return;
    const stack = stackByClipId.get(clip.id);
    if (!stack) {
      items.push({ clip, semanticScore: semanticScores.get(clip.id) });
      return;
    }
    if (emitted.has(stack.id)) return;
    emitted.add(stack.id);
    const preferred =
      stack.members.find((member) => member.is_preferred && filteredIds.has(member.clip_id)) ??
      stack.members.find((member) => filteredIds.has(member.clip_id)) ??
      stack.members[0];
    const hasPreferred = stack.members.some((member) => member.is_preferred);
    const representative = clipsById.get(preferred.clip_id) ?? clip;
    items.push({
      clip: representative,
      stack:
        (hideCandidates && !stack.quality_exempt && hasPreferred) ||
        (stack.members.length === 1 && !stack.quality_exempt && hasPreferred)
          ? undefined
          : stack,
      semanticScore: representative.id === null ? undefined : semanticScores.get(representative.id),
    });
  });
  return items;
}

export function nextShotStackClipId(
  stack: ShotStack,
  selectedId: number,
  direction: -1 | 1,
): number {
  const currentIndex = Math.max(
    0,
    stack.members.findIndex((member) => member.clip_id === selectedId),
  );
  return stack.members[
    (currentIndex + direction + stack.members.length) % stack.members.length
  ].clip_id;
}

export function ratingActionForKey(key: string, composing: boolean): RatingAction | null {
  if (composing) return null;
  const normalized = key.toLowerCase();
  if (normalized === "f") return { kind: "binary", value: 1 };
  if (normalized === "x") return { kind: "binary", value: -1 };
  if (normalized === "0") return { kind: "clear" };
  if (/^[1-5]$/.test(normalized)) {
    return { kind: "star", value: Number(normalized) as 1 | 2 | 3 | 4 | 5 };
  }
  return null;
}

export function applyRatingAction(clip: ClipListItem, action: RatingAction): ClipListItem {
  if (action.kind === "clear") {
    return { ...clip, binary_rating: 0, star_rating: 0 };
  }
  if (action.kind === "binary") {
    return { ...clip, binary_rating: action.value };
  }
  return { ...clip, star_rating: action.value };
}

export function stripFrameCount(clip: ClipListItem): number {
  if (
    clip.duration_ticks === null ||
    clip.tb_num === null ||
    clip.tb_den === null ||
    clip.tb_den <= 0
  ) {
    return 1;
  }
  const seconds = Math.max(0, (clip.duration_ticks * clip.tb_num) / clip.tb_den);
  return Math.min(12, Math.max(1, Math.ceil(seconds / 5)));
}

export function matchPercentage(score: number): number {
  return Math.round(Math.min(1, Math.max(0, score)) * 100);
}

function durationLabel(clip: ClipListItem): string {
  if (
    clip.duration_ticks === null ||
    clip.tb_num === null ||
    clip.tb_den === null ||
    clip.tb_den <= 0
  ) {
    return "—";
  }
  const total = Math.max(0, Math.round((clip.duration_ticks * clip.tb_num) / clip.tb_den));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function clipFrameRate(clip: ClipListItem): number {
  if (clip.fps_num === null || clip.fps_den === null || clip.fps_den <= 0) return 30;
  return clip.fps_num / clip.fps_den;
}

function segmentSeconds(segment: SelectSegment, ticks: number): number {
  if (segment.tb_num <= 0 || segment.tb_den <= 0) return 0;
  return ticks * segment.tb_num / segment.tb_den;
}

function captureLabel(value: string | null): string {
  if (!value) return "未记录日期";
  return value.replace("T", " · ").replace(/:\d{2}(?:\.\d+)?Z$/, "").slice(0, 18);
}

export function transcriptTimeLabel(match: TranscriptMatch): string {
  if (match.tb_num <= 0 || match.tb_den <= 0) return "—";
  const total = Math.max(0, Math.floor((match.start_ticks * match.tb_num) / match.tb_den));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function ratingLabel(clip: ClipListItem): string {
  const binary = activeRating(clip.binary_rating);
  if (binary === 1) return "收藏";
  if (binary === -1) return "拒绝";
  const star = activeRating(clip.star_rating);
  return star === null ? "未评" : `${star} 星`;
}

function RatingMarks({ clip }: { clip: ClipListItem }) {
  const binary = activeRating(clip.binary_rating);
  const star = activeRating(clip.star_rating);
  return (
    <span className="rating-marks" aria-label={`评级：${ratingLabel(clip)}`}>
      {binary === 1 ? <span className="rating-pick">F</span> : null}
      {binary === -1 ? <span className="rating-reject">X</span> : null}
      {star !== null ? <span className="rating-stars">{"★".repeat(star)}</span> : null}
    </span>
  );
}

function FilmCard({
  clip,
  semanticScore,
  stackBadge,
  lens,
  selected,
  onSelect,
}: {
  clip: ClipListItem;
  semanticScore?: number;
  lens?: MemoryLensEntry;
  stackBadge?: { count: number; label: string; score: number | null; qualityExempt: boolean; expanded: boolean };
  selected: boolean;
  onSelect: () => void;
}) {
  const [artifacts, setArtifacts] = useState<ClipArtifacts | null>(null);
  const [skimming, setSkimming] = useState(false);
  const [frame, setFrame] = useState(0);
  const frames = stripFrameCount(clip);

  useEffect(() => {
    if (clip.id === null) return;
    let active = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const next = await getClipArtifacts(clip.id as number);
        if (!active) return;
        setArtifacts(next);
        if (!next.strip && next.statuses.strip !== "failed") {
          timer = window.setTimeout(() => void load(), 1_500);
        }
      } catch {
        if (active) timer = window.setTimeout(() => void load(), 2_500);
      }
    };
    void load();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [clip.id]);

  const moveSkimmer = (event: MouseEvent<HTMLButtonElement>) => {
    if (!artifacts?.strip) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = Math.min(0.999_999, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    setFrame(Math.min(frames - 1, Math.floor(position * frames)));
  };
  const stripPosition = frames <= 1 ? 0 : (frame / (frames - 1)) * 100;
  const stripStyle = artifacts?.strip
    ? ({
        backgroundImage: `url(${artifacts.strip})`,
        backgroundPosition: `${stripPosition}% center`,
        backgroundSize: `${frames * 100}% 100%`,
      } satisfies CSSProperties)
    : undefined;
  const cover = artifacts?.cover ?? clip.cover_url;

  return (
    <button
      id={`select-clip-${clip.id}`}
      className={`film-card${selected ? " selected" : ""}`}
      type="button"
      role="gridcell"
      aria-selected={selected}
      onClick={onSelect}
      onMouseEnter={() => setSkimming(true)}
      onMouseLeave={() => {
        setSkimming(false);
        setFrame(0);
      }}
      onMouseMove={moveSkimmer}
    >
      <span className="film-card-image">
        {cover ? (
          <img
            src={cover}
            alt=""
            crossOrigin="anonymous"
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        ) : null}
        {!cover ? <span className="film-card-missing">等待封面</span> : null}
        {skimming && artifacts?.strip ? (
          <span className="film-card-strip" style={stripStyle} aria-hidden="true" />
        ) : null}
        <span className="film-card-time">{durationLabel(clip)}</span>
        {semanticScore !== undefined ? (
          <span className="film-card-match">匹配度 {matchPercentage(semanticScore)}%</span>
        ) : null}
        {lens && lens.used_episode_badges.length > 0 ? (
          <span
            className={`memory-lens-badge${lens.novelty_context ? " novelty" : ""}`}
            title={`往集已用:${lens.used_episode_badges.join("、")}${lens.novelty_context ? ";新语境恢复候选" : ""}`}
          >
            {lens.novelty_context ? "新语境" : `已用×${lens.used_episode_badges.length}`}
          </span>
        ) : null}
        {stackBadge ? (
          <span className={`shot-stack-badge${stackBadge.qualityExempt ? " exempt" : ""}`}>
            <strong>{stackBadge.label} · {stackBadge.count} {stackBadge.expanded ? "▾" : "▸"}</strong>
            <small>
              {stackBadge.qualityExempt
                ? "全量保留"
                : stackBadge.score === null
                  ? "等待评分"
                  : `Best ${matchPercentage(stackBadge.score)}%`}
            </small>
          </span>
        ) : null}
        {clip.select_count > 0 ? (
          <span className="film-card-select-count">{clip.select_count} 段精选</span>
        ) : null}
        {skimming && artifacts?.strip ? (
          <span className="film-card-skimmer" style={{ left: `${stripPosition}%` }} aria-hidden="true" />
        ) : null}
        <RatingMarks clip={clip} />
      </span>
      <span className="film-card-copy">
        <strong title={clip.file_name}>{clip.file_name}</strong>
        <span>{captureLabel(clip.captured_at)}</span>
      </span>
      <span className="film-card-badges">
        <AnalysisBadges clip={clip} />
      </span>
    </button>
  );
}

function VirtualFilmGrid({
  items,
  clipsById,
  selectedId,
  expandedStackId,
  memoryLens,
  onSelect,
  onToggleStack,
  onSetMemberState,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
}: {
  items: ShotStackWallItem[];
  clipsById: ReadonlyMap<number, ClipListItem>;
  selectedId: number | null;
  expandedStackId: number | null;
  memoryLens: ReadonlyMap<number, MemoryLensEntry>;
  onSelect: (clipId: number) => void;
  onToggleStack: (stackId: number) => void;
  onSetMemberState: (
    stackId: number,
    member: ShotStackMember,
    state: ShotStackUserState,
  ) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onCompositionStart: (event: CompositionEvent<HTMLDivElement>) => void;
  onCompositionEnd: (event: CompositionEvent<HTMLDivElement>) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(560);
  const [columns, setColumns] = useState(3);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      setViewportHeight(Math.max(1, viewport.clientHeight));
      setColumns(filmGridColumnCount(viewport.clientWidth));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const rowCount = Math.ceil(items.length / columns);
  const expandedIndex = items.findIndex((item) => item.stack?.id === expandedStackId);
  const expandedRow = expandedIndex < 0 ? null : Math.floor(expandedIndex / columns);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || expandedRow === null) return;
    const detailTop = filmRowTop(expandedRow, expandedRow) + GRID_ROW_HEIGHT;
    if (detailTop + STACK_DETAIL_HEIGHT > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = detailTop;
      setScrollTop(viewport.scrollTop);
    }
  }, [expandedRow, expandedStackId]);
  const startRow = Math.min(
    Math.max(0, rowCount - 1),
    Math.max(0, filmRowAtOffset(scrollTop, expandedRow) - GRID_OVERSCAN_ROWS),
  );
  const visibleRows = Math.ceil(viewportHeight / GRID_ROW_HEIGHT) + GRID_OVERSCAN_ROWS * 2;
  const endRow = Math.min(rowCount, startRow + visibleRows);
  const visible = items.slice(startRow * columns, endRow * columns);
  const canvasHeight = filmRowTop(rowCount, expandedRow);

  return (
    <div
      className="film-grid-viewport"
      ref={viewportRef}
      role="grid"
      aria-label="Shot Stack 筛片胶片墙"
      aria-rowcount={rowCount}
      aria-colcount={columns}
      aria-activedescendant={selectedId === null ? undefined : `select-clip-${selectedId}`}
      tabIndex={0}
      onScroll={(event: UIEvent<HTMLDivElement>) => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
      onCompositionStart={onCompositionStart}
      onCompositionEnd={onCompositionEnd}
      data-total-clips={items.length}
    >
      <div className="film-grid-canvas" style={{ height: canvasHeight }}>
        <div
          className="film-grid-window"
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(${FILM_GRID_MIN_WIDTH}px, 1fr))`,
            gridTemplateRows: Array.from({ length: endRow - startRow }, (_, index) =>
              `${GRID_ROW_HEIGHT - 14 + (startRow + index === expandedRow ? STACK_DETAIL_HEIGHT : 0)}px`,
            ).join(" "),
            transform: `translateY(${filmRowTop(startRow, expandedRow)}px)`,
          }}
        >
          {visible.map((item, visibleIndex) => {
            const stack = item.stack;
            const stackSelected =
              stack?.members.some((member) => member.clip_id === selectedId) ?? false;
            const expanded = stack?.id === expandedStackId;
            const stackLabel =
              stack?.stack_type === "information"
                ? "信息 Stack"
                : stack?.stack_type === "human"
                  ? "人物 Stack"
                  : "视觉 Stack";
            return (
              <div
                className={`shot-stack-container${expanded ? " expanded" : ""}${stack ? ` ${stack.stack_type}` : ""}`}
                key={stack ? `stack-${stack.id}` : `clip-${item.clip.id}`}
              >
                <FilmCard
                  clip={item.clip}
                  semanticScore={item.semanticScore}
                  lens={item.clip.id === null ? undefined : memoryLens.get(item.clip.id)}
                  stackBadge={stack ? {
                    count: stack.members.length,
                    label: stackLabel,
                    score: stack.members.find((member) => member.is_preferred)
                      ?.best_take_score ?? null,
                    qualityExempt: stack.quality_exempt,
                    expanded: Boolean(expanded),
                  } : undefined}
                  selected={item.clip.id === selectedId || stackSelected}
                  onSelect={() => {
                    onSelect(item.clip.id as number);
                    if (stack) onToggleStack(stack.id);
                    viewportRef.current?.focus();
                  }}
                />
                {stack && expanded ? (
                  <div
                    className="shot-stack-member-strip"
                    style={{
                      left: `calc(-${visibleIndex % columns} * (100% + 14px))`,
                      width: `calc(${columns} * 100% + ${(columns - 1) * 14}px)`,
                    }}
                    role="group"
                    aria-label={`${stackLabel}，${stack.members.length} 条候选`}
                  >
                    <header>
                      <button type="button" onClick={() => onToggleStack(stack.id)} aria-label="收起候选组">收起候选 ↑</button>
                      <strong>{stack.scene_name}</strong>
                      <small>
                        {stack.subject_label} · {stack.function_label} · {stack.shot_size_label} · {stack.movement_label}
                      </small>
                      {stack.quality_exempt ? <span>不做画质淘汰</span> : null}
                    </header>
                    {stack.members.map((member) => {
                      const memberClip = clipsById.get(member.clip_id);
                      if (!memberClip) return null;
                      return (
                        <div
                          className={`shot-stack-member ${member.user_state}${member.is_preferred ? " preferred" : ""}${member.clip_id === selectedId ? " selected" : ""}`}
                          key={`${member.clip_id}-${member.segment_id ?? "whole"}`}
                        >
                          <button
                            className="shot-stack-member-select"
                            type="button"
                            aria-pressed={member.clip_id === selectedId}
                            onClick={() => {
                              onSelect(member.clip_id);
                              viewportRef.current?.focus();
                            }}
                          >
                            <span className="shot-stack-member-image">
                              {memberClip.cover_url ? (
                                <img src={memberClip.cover_url} alt="" crossOrigin="anonymous" />
                              ) : <span>等待封面</span>}
                              <RatingMarks clip={memberClip} />
                            </span>
                            <strong title={memberClip.file_name}>{memberClip.file_name}</strong>
                            <small>
                              {member.is_preferred ? "当前首选 · " : ""}
                              {member.best_take_score === null
                                ? "待评分"
                                : `Best ${matchPercentage(member.best_take_score)}%`}
                            </small>
                          </button>
                          <div className="shot-stack-member-actions">
                            <button
                              type="button"
                              className={member.user_state === "locked" ? "active" : undefined}
                              onClick={() => onSetMemberState(
                                stack.id,
                                member,
                                member.user_state === "locked" ? "auto" : "locked",
                              )}
                            >锁定</button>
                            <button
                              type="button"
                              className={member.user_state === "rejected" ? "active danger" : undefined}
                              onClick={() => onSetMemberState(
                                stack.id,
                                member,
                                member.user_state === "rejected" ? "auto" : "rejected",
                              )}
                            >排除</button>
                            <button
                              type="button"
                              className={member.user_state === "hero" ? "active hero" : undefined}
                              onClick={() => onSetMemberState(stack.id, member, "hero")}
                            >设为主镜头</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SelectionInspector({
  clip,
  safety,
  dimensions,
  stackMember,
  segments,
  deletingSegmentId,
  rescueBusy,
  llmEnabled,
  llmBudgetExhausted,
  aiDescription,
  aiBusy,
  onDeleteSegment,
  onApplyRescueRange,
  onTimeStageChange,
  onDescribe,
}: {
  clip: ClipListItem | null;
  safety: AssetSafetyInfo | null;
  dimensions: ClipDimension[];
  stackMember: ShotStackMember | null;
  segments: SelectSegment[];
  deletingSegmentId: number | null;
  rescueBusy: boolean;
  llmEnabled: boolean;
  llmBudgetExhausted: boolean;
  aiDescription: AiDescriptionResult | null;
  aiBusy: boolean;
  onDeleteSegment: (segmentId: number) => void;
  onApplyRescueRange: () => void;
  onTimeStageChange: (label: string) => void;
  onDescribe: () => void;
}) {
  if (!clip) {
    return (
      <aside className="selection-inspector empty" aria-label="素材信息">
        <span>INSPECTOR</span>
        <strong>选择一条素材</strong>
        <p>评级、分析理由与拍摄参数会固定显示在这里。</p>
      </aside>
    );
  }
  const star = activeRating(clip.star_rating);
  return (
    <aside className="selection-inspector" aria-label={`${clip.file_name} 素材信息`}>
      <div className="inspector-heading">
        <span>SELECTED / 当前素材</span>
        <strong title={clip.file_name}>{clip.file_name}</strong>
        <small title={clip.path}>{clip.path}</small>
      </div>
      <div className="inspector-rating">
        <span>评级</span>
        <strong>{ratingLabel(clip)}</strong>
        <div aria-label={star === null ? "未评星" : `${star} 星`}>
          {Array.from({ length: 5 }, (_, index) => (
            <span className={star !== null && index < star ? "filled" : undefined} key={index}>
              ★
            </span>
          ))}
        </div>
      </div>
      <div className="inspector-section">
        <span>L1 质量角标</span>
        <AnalysisBadges clip={clip} />
      </div>
      {safety && safety.safety_flag !== "normal" ? (
        <div className={`inspector-section asset-safety ${safety.safety_flag}`}>
          <span>
            {safety.safety_flag === "rescue_candidate"
              ? "RESCUE CANDIDATE / 叙事覆盖"
              : "LIKELY UNUSABLE / 仅降权"}
          </span>
          <strong>
            {safety.safety_flag === "rescue_candidate"
              ? "技术较差，但叙事信号要求保留并主动推荐"
              : "技术维度全低；只进入灰组，原片完整保留"}
          </strong>
          <dl className="asset-safety-scores">
            {([
              ["Image", safety.image_score],
              ["Motion", safety.motion_score],
              ["Audio", safety.audio_score],
              ["Narrative", safety.narrative_score],
            ] as const).map(([label, score]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{score === null ? "待证据" : `${matchPercentage(score)}%`}</dd>
              </div>
            ))}
          </dl>
          {safety.narrative_signals.length > 0 ? (
            <p>{safety.narrative_signals.join(" · ")}</p>
          ) : null}
          {safety.rescue_range ? (
            <div className="rescue-range">
              <strong>
                建议使用 {(safety.rescue_range.in_ticks * safety.rescue_range.tb_num / safety.rescue_range.tb_den).toFixed(1)}–
                {(safety.rescue_range.out_ticks * safety.rescue_range.tb_num / safety.rescue_range.tb_den).toFixed(1)}s
              </strong>
              <small title={safety.rescue_range.reason}>{safety.rescue_range.reason}</small>
              <button type="button" disabled={rescueBusy} onClick={onApplyRescueRange}>
                {rescueBusy ? "写入中…" : "一键设为精选段"}
              </button>
            </div>
          ) : safety.safety_flag === "rescue_candidate" ? (
            <p>等待 C6 v4 逐秒抖动采样后生成 ≥2 秒建议窗。</p>
          ) : null}
          {safety.rescue_suggestions.length > 0 ? (
            <div className="rescue-suggestions" aria-label="抢救建议">
              {safety.rescue_suggestions.map((suggestion) => (
                <span key={suggestion}>{suggestion}</span>
              ))}
              <small>仅文案建议，不自动执行处理。</small>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="inspector-section inspector-dimensions">
        <span>八维标签 · 分数可解释</span>
        {dimensions.length === 0 ? (
          <p>等待代表帧与八维分类任务。</p>
        ) : (
          <dl>
            {DIMENSION_KEYS.map((dimension) => {
              const item = dimensions.find((candidate) => candidate.dimension === dimension);
              return (
                <div key={dimension} title={item?.source}>
                  <dt>{DIMENSION_LABELS[dimension]}</dt>
                  <dd>
                    {dimension === "time_stage" && item ? (
                      <select
                        aria-label="改写时间阶段"
                        value={item.label}
                        onChange={(event) => onTimeStageChange(event.currentTarget.value)}
                      >
                        {TIME_STAGE_LABELS.map((label) => (
                          <option value={label} key={label}>{label}</option>
                        ))}
                      </select>
                    ) : (
                      <strong>{item?.label ?? "—"}</strong>
                    )}
                    <small>{item ? `置信 ${item.score.toFixed(2)}` : "—"}</small>
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
      </div>
      {stackMember ? (
        <div className="inspector-section best-take-breakdown">
          <span>AI Best Take · {matchPercentage(stackMember.score_breakdown.total)}%</span>
          <dl>
            {([
              ["technical", "Technical"],
              ["composition", "Composition"],
              ["motion", "Motion"],
              ["human", "Human"],
              ["audio", "Audio"],
              ["narrative", "Narrative"],
            ] as const).map(([key, label]) => {
              const axis = stackMember.score_breakdown[key];
              return (
                <div key={key} title={`${axis.source}｜${axis.note}`}>
                  <dt>{label}</dt>
                  <dd>
                    <strong>{axis.score === null ? "待回填" : `${matchPercentage(axis.score)}%`}</strong>
                    <small>置信 {axis.confidence.toFixed(2)}</small>
                  </dd>
                </div>
              );
            })}
          </dl>
          <p>
            Composition / Human 为明确标注的启发式代理；Narrative 接入真实反应、转写情绪词、unique_event 与 unexpected 章节。
            {stackMember.score_breakdown.preference_boost > 0
              ? ` 人工偏好加权 +${matchPercentage(stackMember.score_breakdown.preference_boost)}%。`
              : ""}
          </p>
        </div>
      ) : null}
      <div className="inspector-section inspector-ai-description">
        <span>AI 描述 · L3 可选增强</span>
        {aiDescription ? (
          <div className="ai-description-result">
            <p>{aiDescription.description}</p>
            <div>
              {aiDescription.tags.map((tag) => <span key={tag}>{tag}</span>)}
            </div>
            <small>由 {aiDescription.provider} 返回；3 个标签已写入 ai_l3</small>
          </div>
        ) : (
          <p>
            {!llmEnabled
              ? "设置页开启后才可调用。"
              : llmBudgetExhausted
                ? "本月预算已用尽，后端熔断且不会启动 CLI。"
                : "只发送文件名和 L1 / 运镜数值，不发送帧或原片。"}
          </p>
        )}
        <button type="button" disabled={!llmEnabled || llmBudgetExhausted || aiBusy} onClick={onDescribe}>
          {aiBusy
            ? "生成中…"
            : llmBudgetExhausted
              ? "预算已熔断"
              : aiDescription
                ? "重新生成 AI 描述"
                : "生成 AI 描述"}
        </button>
      </div>
      <div className="inspector-section inspector-segments">
        <span>精选片段 · {segments.length}</span>
        {segments.length === 0 ? (
          <p>尚无片段；在沉浸态用 I / O 打点，再按 S 保存。</p>
        ) : (
          <ol>
            {segments.map((segment, index) => {
              const start = segmentSeconds(segment, segment.in_ticks);
              const end = segmentSeconds(segment, segment.out_ticks);
              return (
                <li key={segment.id}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <strong>
                      {formatTimecode(start, clipFrameRate(clip))} – {formatTimecode(end, clipFrameRate(clip))}
                    </strong>
                    <small>时长 {formatTimecode(end - start, clipFrameRate(clip))}</small>
                  </div>
                  <button
                    type="button"
                    disabled={deletingSegmentId === segment.id}
                    onClick={() => onDeleteSegment(segment.id)}
                    aria-label={`删除精选段 ${index + 1}`}
                  >
                    {deletingSegmentId === segment.id ? "删除中" : "删除"}
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <dl className="inspector-metadata">
        <div><dt>时长</dt><dd>{durationLabel(clip)}</dd></div>
        <div><dt>尺寸</dt><dd>{clip.width && clip.height ? `${clip.width} × ${clip.height}` : "—"}</dd></div>
        <div><dt>编码</dt><dd>{clip.codec?.toUpperCase() ?? "—"}</dd></div>
        <div><dt>场景</dt><dd>{clip.analysis ? `${clip.analysis.scene_count} 段` : "—"}</dd></div>
        <div><dt>运镜</dt><dd>{clip.motion ? motionClassLabel(clip.motion.class) : "—"}</dd></div>
        <div><dt>横摇同向比</dt><dd>{clip.motion ? clip.motion.pan_ratio.toFixed(2) : "—"}</dd></div>
        <div><dt>俯仰同向比</dt><dd>{clip.motion ? clip.motion.tilt_ratio.toFixed(2) : "—"}</dd></div>
        <div><dt>缩放相关</dt><dd>{clip.motion ? clip.motion.zoom_corr.toFixed(2) : "—"}</dd></div>
        <div><dt>抖动分</dt><dd>{clip.motion ? clip.motion.shake_score.toFixed(2) : "—"}</dd></div>
        <div><dt>采样帧对</dt><dd>{clip.motion ? clip.motion.sample_pairs : "—"}</dd></div>
      </dl>
      <div className="inspector-note">
        <span>操作提示</span>
        <p>先点选卡片；空格进入原片沉浸播放，F / X / 1–5 / 0 评级。鼠标横移可浏览胶片条。</p>
      </div>
    </aside>
  );
}

export function SelectPage() {
  const [clips, setClips] = useState<ClipListItem[]>([]);
  const [assetSafety, setAssetSafety] = useState<AssetSafetyInfo[]>([]);
  const [dimensions, setDimensions] = useState<ClipDimension[]>([]);
  const [shotStacks, setShotStacks] = useState<ShotStack[]>([]);
  const [filter, setFilter] = useState<SelectionFilter>("all");
  const [excludeSuspect, setExcludeSuspect] = useState(false);
  const [hideDuplicates, setHideDuplicates] = useState(false);
  const [avoidCrossEpisodeReuse, setAvoidCrossEpisodeReuse] = useState(false);
  const [folderFilter, setFolderFilter] = useState("");
  const [memoryLens, setMemoryLens] = useState<Map<number, MemoryLensEntry>>(new Map());
  const [activeEpisodeId, setActiveEpisodeId] = useState<number | null>(null);
  const [viewingEpisode, setViewingEpisode] = useState<{ id: number; title: string } | null>(null);

  useEffect(() => {
    void getCurrentEpisode()
      .then((episode) => setActiveEpisodeId(episode.id))
      .catch(() => setActiveEpisodeId(null));
    const onView = (event: Event) => {
      setViewingEpisode((event as CustomEvent<{ id: number; title: string } | null>).detail);
    };
    // 封存本集(EpisodePanel)可以在不离开 /review 的情况下发生;没有这个订阅,
    // activeEpisodeId 会停留在刚封存的旧集上,连历史只读 banner 都不会出现
    // （回归修复）。同一路由内封存后应回到"当前集"视角,清掉 viewingEpisode。
    const onEpisodeChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ id: number; title: string } | null>).detail;
      setActiveEpisodeId(detail?.id ?? null);
      setViewingEpisode(null);
    };
    window.addEventListener("tripcut:view-episode", onView);
    window.addEventListener("tripcut:episode-changed", onEpisodeChanged);
    return () => {
      window.removeEventListener("tripcut:view-episode", onView);
      window.removeEventListener("tripcut:episode-changed", onEpisodeChanged);
    };
  }, []);

  useEffect(() => {
    void getMemoryLens()
      .then((entries) => setMemoryLens(new Map(entries.map((entry) => [entry.clip_id, entry]))))
      .catch(() => setMemoryLens(new Map()));
  }, []);
  const [expandedStackId, setExpandedStackId] = useState<number | null>(null);

  useEffect(() => {
    const onJump = (event: Event) => {
      const clipId = (event as CustomEvent<number>).detail;
      if (typeof clipId === "number") setSelectedId(clipId);
    };
    window.addEventListener("tripcut:select-clip", onJump);
    return () => window.removeEventListener("tripcut:select-clip", onJump);
  }, []);
  const [dimensionFilter, setDimensionFilter] = useState<ClipDimensionKey | "">("");
  const [dimensionLabelFilter, setDimensionLabelFilter] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ratingNotice, setRatingNotice] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [searchHits, setSearchHits] = useState<ClipSearchHit[]>([]);
  const [transcriptMatches, setTranscriptMatches] = useState<TranscriptMatch[]>([]);
  const [searchingClips, setSearchingClips] = useState(false);
  const [searchingTranscripts, setSearchingTranscripts] = useState(false);
  const [clipSearchError, setClipSearchError] = useState<string | null>(null);
  const [transcriptSearchError, setTranscriptSearchError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [immersiveClip, setImmersiveClip] = useState<ClipListItem | null>(null);
  const [selectSegments, setSelectSegments] = useState<SelectSegment[]>([]);
  const [deletingSegmentId, setDeletingSegmentId] = useState<number | null>(null);
  const [rescueBusy, setRescueBusy] = useState(false);
  const [viewMode, setViewMode] = useState<"film" | "story">("film");
  const [llmEnabled, setLlmEnabled] = useState(false);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [aiDescriptions, setAiDescriptions] = useState<Map<number, AiDescriptionResult>>(
    () => new Map(),
  );
  const [describingIds, setDescribingIds] = useState<Set<number>>(() => new Set());
  const [batchDescribing, setBatchDescribing] = useState(false);
  const [directorQuestion, setDirectorQuestion] = useState("");
  const [directorAnswer, setDirectorAnswer] = useState<string | null>(null);
  const [directorProvider, setDirectorProvider] = useState<string | null>(null);
  const [directorBusy, setDirectorBusy] = useState(false);
  const compositionRef = useRef(false);
  const searchRequestRef = useRef(0);

  const refreshRequest = useRef(0);
  const refresh = useCallback(async (isActive: () => boolean = () => true) => {
    const request = ++refreshRequest.current;
    const nextAssetSafety = await listAssetSafety();
    const [nextClips, nextDimensions, nextShotStacks] = await Promise.all([
      listClips(),
      listClipDimensions(),
      listShotStacks(),
    ]);
    if (!isActive() || request !== refreshRequest.current) return nextClips;
    setClips(nextClips);
    setAssetSafety(nextAssetSafety);
    setDimensions(nextDimensions);
    setShotStacks(nextShotStacks);
    return nextClips;
  }, []);

  const refreshSegments = useCallback(async (clipId: number | null) => {
    if (clipId === null) {
      setSelectSegments([]);
      return [];
    }
    const next = await listSelectSegments(clipId);
    setSelectSegments(next);
    return next;
  }, []);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let inFlight = false;
    const pageVisible = () => document.visibilityState !== "hidden";
    const load = async () => {
      if (!active || inFlight || !pageVisible()) return;
      inFlight = true;
      try {
        await refresh(() => active);
        if (active) setError(null);
      } catch (loadError) {
        if (active) setError(String(loadError));
      } finally {
        inFlight = false;
        if (active) {
          setLoading(false);
          if (pageVisible()) timer = window.setTimeout(() => void load(), 2_000);
        }
      }
    };
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (pageVisible()) void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void load();
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibility);
      ++refreshRequest.current;
      window.clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    void Promise.all([getSettings(), getLlmStatus()])
      .then(([settings, nextStatus]) => {
        if (!active) return;
        setLlmEnabled(settings.llm_enabled === "true" && nextStatus.enabled);
        setLlmStatus(nextStatus);
      })
      .catch(() => {
        if (active) {
          setLlmEnabled(false);
          setLlmStatus(null);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const readyClips = useMemo(
    () => clips.filter((clip) => clip.id !== null && clip.status === "ready"),
    [clips],
  );
  const safetyByClipId = useMemo(
    () => new Map(assetSafety.map((item) => [item.clip_id, item])),
    [assetSafety],
  );
  const qualityExemptClipIds = useMemo(() => {
    const labels = new Map<number, { subject?: string; function?: string }>();
    dimensions.forEach((dimension) => {
      if (dimension.dimension !== "subject" && dimension.dimension !== "function") return;
      const current = labels.get(dimension.clip_id) ?? {};
      current[dimension.dimension] = dimension.label;
      labels.set(dimension.clip_id, current);
    });
    const exempt = new Set(
      Array.from(labels.entries())
        .filter(([, value]) =>
          value.subject === "人" ||
          value.function === "Human-Reaction" ||
          value.function === "Orientation" ||
          value.function === "Information",
        )
        .map(([clipId]) => clipId),
    );
    assetSafety.forEach((item) => {
      if (item.safety_flag !== "normal") exempt.add(item.clip_id);
    });
    return exempt;
  }, [assetSafety, dimensions]);
  // G1/项8:筛片默认只看当前集;点集列表可只读查看历史集。episode_id 为空的旧数据归当前集。
  const episodeScopedClips = useMemo(() => {
    const scope = viewingEpisode?.id ?? activeEpisodeId;
    if (scope === null) return clips;
    return clips.filter((clip) => (clip.episode_id ?? activeEpisodeId) === scope);
  }, [activeEpisodeId, clips, viewingEpisode]);
  // 历史集只读:UI 禁用写操作(后端 ensure_clip_writable 独立强制,不把 UI 当权限边界)
  const readOnlyEpisode = viewingEpisode !== null;

  const folderScopedClips = useMemo(
    () => (folderFilter
      ? episodeScopedClips.filter((clip) => clip.folder_label === folderFilter)
      : episodeScopedClips),
    [episodeScopedClips, folderFilter],
  );
  const folderOptions = useMemo(
    () => Array.from(new Set(episodeScopedClips.map((clip) => clip.folder_label).filter((v): v is string => Boolean(v)))).sort(),
    [episodeScopedClips],
  );
  const ratingFiltered = useMemo(
    () => filterSelectionClips(folderScopedClips, filter, excludeSuspect, qualityExemptClipIds),
    [folderScopedClips, excludeSuspect, filter, qualityExemptClipIds],
  );
  const dimensionFiltered = useMemo(
    () => filterClipsByDimension(ratingFiltered, dimensions, dimensionFilter, dimensionLabelFilter),
    [dimensionFilter, dimensionLabelFilter, dimensions, ratingFiltered],
  );
  const dimensionLabelOptions = useMemo(
    () =>
      dimensionFilter
        ? Array.from(
            new Set(
              dimensions
                .filter((item) => item.dimension === dimensionFilter)
                .map((item) => item.label),
            ),
          ).sort((left, right) => left.localeCompare(right, "zh-CN"))
        : [],
    [dimensionFilter, dimensions],
  );
  const semanticScores = useMemo(
    () => new Map(searchHits.map((hit) => [hit.clip_id, hit.score])),
    [searchHits],
  );
  const transcriptClipIds = useMemo(
    () => new Set(transcriptMatches.map((match) => match.clip_id)),
    [transcriptMatches],
  );
  const filtered = useMemo(() => {
    // G3:跨集避重(新语境素材豁免——Novelty 恢复候选是规格 D.8 的硬约定)
    const base = avoidCrossEpisodeReuse
      ? dimensionFiltered.filter((clip) => {
          const lens = clip.id === null ? undefined : memoryLens.get(clip.id);
          if (!lens) return true;
          return lens.used_episode_badges.length === 0 || lens.novelty_context;
        })
      : dimensionFiltered;
    if (!submittedQuery) return base;
    return base
      .filter(
        (clip) =>
          clip.id !== null &&
          (semanticScores.has(clip.id) || transcriptClipIds.has(clip.id)),
      )
      .sort((left, right) => {
        const scoreDifference =
          (semanticScores.get(right.id as number) ?? -Infinity) -
          (semanticScores.get(left.id as number) ?? -Infinity);
        return scoreDifference || (left.id as number) - (right.id as number);
      });
  }, [avoidCrossEpisodeReuse, dimensionFiltered, memoryLens, semanticScores, submittedQuery, transcriptClipIds]);
  const counts = useMemo(
    () => ({
      all: filterSelectionClips(clips, "all", excludeSuspect, qualityExemptClipIds).length,
      favorite: filterSelectionClips(clips, "favorite", excludeSuspect, qualityExemptClipIds).length,
      unrated: filterSelectionClips(clips, "unrated", excludeSuspect, qualityExemptClipIds).length,
      rejected: filterSelectionClips(clips, "rejected", excludeSuspect, qualityExemptClipIds).length,
    }),
    [clips, excludeSuspect, qualityExemptClipIds],
  );

  const selectedClip = selectedId === null
    ? null
    : clips.find((clip) => clip.id === selectedId) ?? null;
  const selectedDimensions = useMemo(
    () => dimensions.filter((item) => item.clip_id === selectedId),
    [dimensions, selectedId],
  );
  const selectedSafety = selectedId === null ? null : safetyByClipId.get(selectedId) ?? null;

  useEffect(() => {
    let active = true;
    if (selectedId === null) {
      setSelectSegments([]);
      return () => {
        active = false;
      };
    }
    void listSelectSegments(selectedId)
      .then((items) => {
        if (active) setSelectSegments(items);
      })
      .catch((segmentError) => {
        if (active) setError(`精选段未载入：${String(segmentError)}`);
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    if (selectedId === null) return () => { active = false; };
    void getAiDescription(selectedId)
      .then((description) => {
        if (!active) return;
        setAiDescriptions((current) => {
          const next = new Map(current);
          if (description) next.set(selectedId, description);
          else next.delete(selectedId);
          return next;
        });
      })
      .catch((descriptionError) => {
        if (active) setError(`AI 描述未载入：${String(descriptionError)}`);
      });
    return () => { active = false; };
  }, [selectedId]);
  const clipsById = useMemo(
    () =>
      new Map<number, ClipListItem>(
        clips
          .filter((clip): clip is ClipListItem & { id: number } => clip.id !== null)
          .map((clip): [number, ClipListItem] => [clip.id, clip]),
      ),
    [clips],
  );
  const shotStackByClipId = useMemo(() => {
    const result = new Map<number, ShotStack>();
    shotStacks.forEach((stack) => {
      stack.members.forEach((member) => result.set(member.clip_id, stack));
    });
    return result;
  }, [shotStacks]);
  const selectedStack = selectedId === null ? null : shotStackByClipId.get(selectedId) ?? null;
  const selectedStackMember = selectedStack?.members.find(
    (member) => member.clip_id === selectedId,
  ) ?? null;
  const ordinaryFiltered = useMemo(
    () => filtered.filter((clip) => clip.id === null || safetyByClipId.get(clip.id)?.safety_flag === "normal" || !safetyByClipId.has(clip.id)),
    [filtered, safetyByClipId],
  );
  const rescueWallItems = useMemo(
    () => filtered
      .filter((clip) => clip.id !== null && safetyByClipId.get(clip.id)?.safety_flag === "rescue_candidate")
      .map((clip) => ({ clip, semanticScore: clip.id === null ? undefined : semanticScores.get(clip.id) })),
    [filtered, safetyByClipId, semanticScores],
  );
  const likelyUnusableWallItems = useMemo(
    () => filtered
      .filter((clip) => clip.id !== null && safetyByClipId.get(clip.id)?.safety_flag === "likely_unusable")
      .map((clip) => ({ clip, semanticScore: clip.id === null ? undefined : semanticScores.get(clip.id) })),
    [filtered, safetyByClipId, semanticScores],
  );
  const ordinaryShotStacks = useMemo(() => {
    const ordinaryIds = new Set(
      ordinaryFiltered
        .map((clip) => clip.id)
        .filter((clipId): clipId is number => clipId !== null),
    );
    return shotStacks
      .map((stack) => ({
        ...stack,
        members: stack.members.filter((member) => ordinaryIds.has(member.clip_id)),
      }))
      .filter((stack) => stack.members.length > 0);
  }, [ordinaryFiltered, shotStacks]);
  const wallItems = useMemo(
    () => buildShotStackWallItems(ordinaryFiltered, clips, ordinaryShotStacks, hideDuplicates, semanticScores),
    [clips, hideDuplicates, ordinaryFiltered, ordinaryShotStacks, semanticScores],
  );
  const allWallItems = useMemo<ShotStackWallItem[]>(
    () => [...rescueWallItems, ...wallItems, ...likelyUnusableWallItems],
    [likelyUnusableWallItems, rescueWallItems, wallItems],
  );

  useEffect(() => {
    if (allWallItems.length === 0) {
      setSelectedId(null);
      return;
    }
    const selectedIsVisible = allWallItems.some((item) =>
      item.stack
        ? item.stack.members.some((member) => member.clip_id === selectedId)
        : item.clip.id === selectedId,
    );
    if (!selectedIsVisible) {
      setSelectedId(allWallItems[0].clip.id);
    }
  }, [allWallItems, selectedId]);

  const persistRating = useCallback(
    async (action: RatingAction) => {
      if (selectedId === null) return;
      if (readOnlyEpisode) {
        setRatingNotice("历史集为只读档案;回到当前集才能修改评级");
        return;
      }
      const current = clips.find((clip) => clip.id === selectedId);
      if (!current) return;
      setClips((items) =>
        items.map((clip) => (clip.id === selectedId ? applyRatingAction(clip, action) : clip)),
      );
      setRatingNotice(null);
      try {
        if (action.kind === "clear") {
          await clearClipRating(selectedId);
          setRatingNotice("已清除评级");
        } else {
          await rateClip(selectedId, action.kind, action.value);
          setRatingNotice(
            action.kind === "binary"
              ? action.value === 1
                ? "已收藏"
                : "已拒绝"
              : `已评 ${action.value} 星`,
          );
        }
        window.dispatchEvent(new Event("tripcut:library-changed"));
      } catch (ratingError) {
        setError(`评级未保存：${String(ratingError)}`);
        setClips((items) => items.map((clip) => (clip.id === selectedId ? current : clip)));
        void refresh();
      }
    },
    [clips, readOnlyEpisode, refresh, selectedId],
  );

  const persistShotStackState = useCallback(
    async (stackId: number, member: ShotStackMember, userState: ShotStackUserState) => {
      const previous = shotStacks;
      setShotStacks((stacks) => replaceShotStackMemberState(
        stacks,
        stackId,
        member.clip_id,
        userState,
      ));
      setSelectedId(member.clip_id);
      setRatingNotice(
        userState === "hero"
          ? "已提升为 Hero Shot"
          : userState === "locked"
            ? "已锁定为 Stack 首选"
            : userState === "rejected"
              ? "已排除候选（原片未删除）"
              : "已恢复 AI 自动推荐",
      );
      try {
        await setShotStackUserState(
          stackId,
          member.clip_id,
          member.segment_id,
          userState,
        );
        await refresh();
      } catch (stateError) {
        setShotStacks(previous);
        setError(`Shot Stack 状态未保存：${String(stateError)}`);
        void refresh();
      }
    },
    [refresh, shotStacks],
  );

  const removeSelectSegment = useCallback(async (segmentId: number) => {
    if (selectedId === null || deletingSegmentId !== null) return;
    if (readOnlyEpisode) {
      setRatingNotice("历史集为只读档案;回到当前集才能删除精选段");
      return;
    }
    setDeletingSegmentId(segmentId);
    setRatingNotice(null);
    try {
      await deleteSelectSegment(segmentId);
      await Promise.all([refreshSegments(selectedId), refresh()]);
      setRatingNotice("精选段已删除");
    } catch (segmentError) {
      setError(`精选段未删除：${String(segmentError)}`);
    } finally {
      setDeletingSegmentId(null);
    }
  }, [deletingSegmentId, refresh, refreshSegments, selectedId, readOnlyEpisode]);

  const useSuggestedRescueRange = useCallback(async () => {
    if (selectedId === null || rescueBusy) return;
    setRescueBusy(true);
    setRatingNotice(null);
    try {
      await applyRescueRange(selectedId);
      await Promise.all([refreshSegments(selectedId), refresh()]);
      setRatingNotice("抢救建议已设为精选段；原片保持完整");
    } catch (rescueError) {
      setError(`抢救区间未保存：${String(rescueError)}`);
    } finally {
      setRescueBusy(false);
    }
  }, [refresh, refreshSegments, rescueBusy, selectedId]);

  const persistTimeStage = useCallback(async (label: string) => {
    if (selectedId === null) return;
    if (readOnlyEpisode) {
      setRatingNotice("历史集为只读档案;回到当前集才能修改时间阶段");
      return;
    }
    const previous = dimensions;
    setDimensions((items) => {
      const exists = items.some(
        (item) => item.clip_id === selectedId && item.dimension === "time_stage",
      );
      const updated = items.map((item) =>
        item.clip_id === selectedId && item.dimension === "time_stage"
          ? { ...item, label, score: 1, source: "user" }
          : item,
      );
      return exists
        ? updated
        : [
            ...updated,
            {
              clip_id: selectedId,
              dimension: "time_stage" as const,
              label,
              score: 1,
              source: "user",
            },
          ];
    });
    try {
      await setClipTimeStage(selectedId, label);
      setRatingNotice(`时间阶段已改为“${label}”`);
    } catch (stageError) {
      setDimensions(previous);
      setError(`时间阶段未保存：${String(stageError)}`);
    }
  }, [dimensions, selectedId, readOnlyEpisode]);

  const requestAiDescription = useCallback(async (clipId: number) => {
    setDescribingIds((current) => new Set(current).add(clipId));
    try {
      const result = await describeClipWithAi(clipId);
      setAiDescriptions((current) => {
        const next = new Map(current);
        next.set(clipId, result);
        return next;
      });
      return result;
    } finally {
      setDescribingIds((current) => {
        const next = new Set(current);
        next.delete(clipId);
        return next;
      });
      void getLlmStatus().then(setLlmStatus).catch(() => undefined);
    }
  }, []);

  const describeSelected = useCallback(async () => {
    if (selectedId === null || !llmEnabled) return;
    setError(null);
    setRatingNotice("正在生成 AI 描述；只发送结构化数值与文件名");
    try {
      const result = await requestAiDescription(selectedId);
      setRatingNotice(`AI 描述已返回（${result.provider}）`);
    } catch (descriptionError) {
      setError(`AI 描述失败：${String(descriptionError)}`);
    }
  }, [llmEnabled, requestAiDescription, selectedId]);

  const describeFilteredBatch = useCallback(async () => {
    if (!llmEnabled || batchDescribing) return;
    const clipIds = filtered
      .map((clip) => clip.id)
      .filter((clipId): clipId is number => clipId !== null)
      // 一键全读永不重复烧额度:已有描述的素材直接跳过
      .filter((clipId) => !aiDescriptions.has(clipId));
    if (clipIds.length === 0) {
      setError("当前过滤结果没有可生成描述的素材");
      return;
    }
    const roughTokens = clipIds.length * 700;
    const remaining = llmStatus?.remaining_calls ?? 0;
    const fallbackNote = llmStatus?.provider === "auto"
      ? "auto 路由失败回退时会增加调用次数与账本消耗。"
      : "provider 已锁定，失败不会切换其他 CLI。";
    const confirmed = window.confirm(
      `将为 ${clipIds.length} 条素材逐条生成 AI 描述。\n` +
        `预计至少 ${clipIds.length} 次调用，前端粗估约 ${roughTokens} tokens；本月显示剩余 ${remaining} 次。\n` +
        `${fallbackNote}\n\n确认继续？`,
    );
    if (!confirmed) return;

    setBatchDescribing(true);
    setError(null);
    let succeeded = 0;
    let failed = 0;
    let stopped = false;
    for (const clipId of clipIds) {
      try {
        await requestAiDescription(clipId);
        succeeded += 1;
        setRatingNotice(`批量 AI 描述：${succeeded + failed} / ${clipIds.length}`);
      } catch (descriptionError) {
        failed += 1;
        const message = String(descriptionError);
        if (message.includes("预算") || message.includes("已关闭")) {
          setError(`批量 AI 描述已停止：${message}`);
          stopped = true;
          break;
        }
      }
    }
    setBatchDescribing(false);
    setRatingNotice(
      stopped
        ? `批量 AI 描述已提前停止：成功 ${succeeded}，失败 ${failed}`
        : `批量 AI 描述完成：成功 ${succeeded}，失败 ${failed}`,
    );
    void getLlmStatus().then(setLlmStatus).catch(() => undefined);
  }, [aiDescriptions, batchDescribing, filtered, llmEnabled, llmStatus, requestAiDescription]);

  useEffect(() => {
    const onAction = (event: Event) => {
      if ((event as CustomEvent<string>).detail === "select-describe-all") void describeFilteredBatch();
    };
    window.addEventListener("tripcut:action", onAction);
    return () => window.removeEventListener("tripcut:action", onAction);
  }, [describeFilteredBatch]);

  const submitDirectorQuestion = useCallback(async () => {
    const question = directorQuestion.trim();
    if (!llmEnabled || !question || directorBusy) return;
    const selectedSummary = readyClips
      .filter((clip) => activeRating(clip.binary_rating) === 1 || clip.select_count > 0)
      .slice(0, 100)
      .map((clip) =>
        `${clip.file_name}｜${ratingLabel(clip)}｜精选段 ${clip.select_count}｜时长 ${durationLabel(clip)}`,
      );
    setDirectorBusy(true);
    setDirectorAnswer(null);
    setDirectorProvider(null);
    setError(null);
    try {
      const result = await askDirector(question, {
        current_filter: FILTER_LABELS[filter],
        total_clips: readyClips.length,
        visible_clips: filtered.length,
        favorites: counts.favorite,
        rejected: counts.rejected,
        unrated: counts.unrated,
        selected_summary: selectedSummary,
      });
      setDirectorAnswer(result.answer);
      setDirectorProvider(result.provider);
    } catch (directorError) {
      setError(`导演问答失败：${String(directorError)}`);
    } finally {
      setDirectorBusy(false);
      void getLlmStatus().then(setLlmStatus).catch(() => undefined);
    }
  }, [counts, directorBusy, directorQuestion, filter, filtered, llmEnabled, readyClips]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isFilmGridShortcutTarget(event.target, event.currentTarget)) return;
    const isComposing = compositionRef.current || event.nativeEvent.isComposing;
    // 物理键映射:中文输入法把字母/数字吃成候选(key=Process),code 不受影响。
    const code = event.code;
    const physicalKey = code.startsWith("Key") && code.length === 4
      ? code.slice(3).toLowerCase()
      : code.startsWith("Digit")
        ? code.slice(5)
        : event.key;
    if (event.key === "Tab" && !isComposing && selectedId !== null) {
      const stack = shotStackByClipId.get(selectedId);
      if (stack && stack.members.length > 1) {
        event.preventDefault();
        setExpandedStackId((current) => current === stack.id ? null : stack.id);
        return;
      }
    }
    if (
      !isComposing &&
      selectedId !== null &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      const stack = shotStackByClipId.get(selectedId);
      if (
        stack &&
        stack.members.length > 1 &&
        expandedStackId === stack.id
      ) {
        event.preventDefault();
        setSelectedId(nextShotStackClipId(
          stack,
          selectedId,
          event.key === "ArrowUp" ? -1 : 1,
        ));
        return;
      }
    }
    if (!isComposing && selectedStack && selectedStackMember) {
      const normalized = physicalKey.toLowerCase();
      let nextState: ShotStackUserState | null = null;
      if (event.key === "Enter") nextState = "locked";
      if (normalized === "l") {
        nextState = selectedStackMember.user_state === "locked" ? "auto" : "locked";
      }
      if (normalized === "r") {
        nextState = selectedStackMember.user_state === "rejected" ? "auto" : "rejected";
      }
      if (nextState) {
        event.preventDefault();
        void persistShotStackState(selectedStack.id, selectedStackMember, nextState);
        return;
      }
    }
    if ((event.key === " " || event.key === "Spacebar") && !isComposing && selectedClip) {
      event.preventDefault();
      setImmersiveClip(selectedClip);
      return;
    }
    const action = ratingActionForKey(physicalKey, false);
    if (!action) return;
    event.preventDefault();
    void persistRating(action);
  };
  const beginComposition = (_event: CompositionEvent<Element>) => {
    compositionRef.current = true;
    setComposing(true);
  };
  const endComposition = (_event: CompositionEvent<Element>) => {
    compositionRef.current = false;
    setComposing(false);
  };

  const executeSearch = useCallback(async () => {
    const query = searchQuery.trim();
    const requestId = ++searchRequestRef.current;
    if (!query) {
      setSubmittedQuery("");
      setSearchHits([]);
      setTranscriptMatches([]);
      setClipSearchError(null);
      setTranscriptSearchError(null);
      setSearchingClips(false);
      setSearchingTranscripts(false);
      return;
    }

    setSubmittedQuery(query);
    setSearchHits([]);
    setTranscriptMatches([]);
    setSearchingClips(true);
    setSearchingTranscripts(true);
    setClipSearchError(null);
    setTranscriptSearchError(null);

    const [clipResult, transcriptResult] = await Promise.allSettled([
      searchClips(query),
      searchTranscripts(query),
    ]);
    if (requestId !== searchRequestRef.current) return;

    if (clipResult.status === "fulfilled") {
      setSearchHits(clipResult.value);
    } else {
      setClipSearchError(`语义搜索不可用：${String(clipResult.reason)}`);
    }
    if (transcriptResult.status === "fulfilled") {
      setTranscriptMatches(transcriptResult.value);
    } else {
      setTranscriptSearchError(`对白搜索不可用：${String(transcriptResult.reason)}`);
    }
    setSearchingClips(false);
    setSearchingTranscripts(false);
  }, [searchQuery]);

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const nativeKeyCode = (event.nativeEvent as KeyboardEvent).keyCode;
    const isComposing =
      compositionRef.current || event.nativeEvent.isComposing || nativeKeyCode === 229;
    if (event.key !== "Enter" || isComposing) return;
    event.preventDefault();
    void executeSearch();
  };

  const updateSearchQuery = (value: string) => {
    setSearchQuery(value);
    if (!value.trim()) {
      searchRequestRef.current += 1;
      setSubmittedQuery("");
      setSearchHits([]);
      setTranscriptMatches([]);
      setClipSearchError(null);
      setTranscriptSearchError(null);
      setSearchingClips(false);
      setSearchingTranscripts(false);
    }
  };

  const searching = searchingClips || searchingTranscripts;
  const activeFilteredClipIds = useMemo(
    () => new Set(dimensionFiltered.flatMap((clip) => clip.id === null ? [] : [clip.id])),
    [dimensionFiltered],
  );
  const visibleSearchHits = useMemo(
    () => filterSearchHitsToVisibleClips(searchHits, activeFilteredClipIds),
    [activeFilteredClipIds, searchHits],
  );
  const visibleTranscriptMatches = useMemo(
    () => filterSearchHitsToVisibleClips(transcriptMatches, activeFilteredClipIds),
    [activeFilteredClipIds, transcriptMatches],
  );

  useEffect(() => {
    if (!submittedQuery) return;
    let active = true;
    const timer = window.setInterval(() => {
      void searchTranscripts(submittedQuery)
        .then((matches) => {
          if (!active) return;
          setTranscriptMatches(matches);
          setTranscriptSearchError(null);
        })
        .catch((searchFailure) => {
          if (active) setTranscriptSearchError(`对白搜索不可用：${String(searchFailure)}`);
        });
    }, 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [submittedQuery]);

  return (
    <section className="select-page" aria-label="筛片工作台">
      {composing ? (
        <div className="ime-notice" role="status">
          <span aria-hidden="true" />
          中文输入法组合中，单键评级已暂停
        </div>
      ) : null}
      {viewingEpisode ? (
        <div className="episode-viewing-banner" role="status">
          <span>正在只读查看已封存集「{viewingEpisode.title}」——评级与编排请回到当前集</span>
          <button type="button" onClick={() => setViewingEpisode(null)}>回到当前集</button>
        </div>
      ) : null}
      {!viewingEpisode && episodeScopedClips.length === 0 && clips.length > 0 ? (
        <div className="episode-viewing-banner empty" role="status">
          <span>本集还没有素材:去导入页添加素材,或从侧栏集列表查看历史集</span>
          <a href="#/import">去导入 →</a>
        </div>
      ) : null}
      <div className="select-modebar" aria-label="筛片视图模式">
        <button
          type="button"
          className={viewMode === "film" ? "active" : undefined}
          aria-pressed={viewMode === "film"}
          onClick={() => setViewMode("film")}
        >
          胶片墙
          <small>SELECT</small>
        </button>
        <button
          type="button"
          className={viewMode === "story" ? "active" : undefined}
          aria-pressed={viewMode === "story"}
          onClick={() => setViewMode("story")}
        >
          故事板
          <small>ROUGH CUT</small>
        </button>
      </div>
      {viewMode === "story" ? <StoryboardView /> : (
        <Group orientation="horizontal" className="select-layout">
          <Panel minSize={420} className="select-layout-main">
          <div className="film-wall">
          <div className="semantic-searchbar">
            <label htmlFor="clip-semantic-search">
              <span>素材搜索</span>
              <small>CHINESE-CLIP · LOCAL</small>
            </label>
            <div className={`semantic-search-field${submittedQuery ? " active" : ""}`}>
              <span aria-hidden="true">⌕</span>
              <input
                id="clip-semantic-search"
                type="search"
                value={searchQuery}
                placeholder="搜索画面或对白关键词"
                aria-label="搜索画面或对白关键词"
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="search"
                onChange={(event) => updateSearchQuery(event.currentTarget.value)}
                onKeyDown={handleSearchKeyDown}
                onCompositionStart={beginComposition}
                onCompositionEnd={endComposition}
              />
              {submittedQuery ? (
                <button
                  className="semantic-search-clear"
                  type="button"
                  aria-label="清除素材搜索"
                  onClick={() => updateSearchQuery("")}
                >
                  ×
                </button>
              ) : null}
            </div>
            <button
              className="semantic-search-submit"
              type="button"
              disabled={searching || composing || !searchQuery.trim()}
              onClick={() => void executeSearch()}
            >
              {searching ? "搜索中" : "搜索"}
            </button>
          </div>
          <div className="selection-filterbar">
            <div className="selection-library-summary">
              <span>LIBRARY</span>
              <strong>本地项目</strong>
              <small>{readyClips.length} 条素材</small>
            </div>
            <div className="filter-tabs" aria-label="评级过滤">
              {(Object.keys(FILTER_LABELS) as SelectionFilter[]).map((candidate) => (
                <button
                  type="button"
                  className={candidate === filter ? "active" : undefined}
                  onClick={() => setFilter(candidate)}
                  aria-pressed={candidate === filter}
                  key={candidate}
                >
                  {FILTER_LABELS[candidate]}
                  <span>{counts[candidate]}</span>
                </button>
              ))}
            </div>
            <div className="dimension-filter-controls" aria-label="八维标签过滤">
              <label>
                <span>八维筛选</span>
                <select
                  value={dimensionFilter}
                  onChange={(event) => {
                    setDimensionFilter(event.currentTarget.value as ClipDimensionKey | "");
                    setDimensionLabelFilter("");
                  }}
                >
                  <option value="">选择维度</option>
                  {DIMENSION_KEYS.map((dimension) => (
                    <option value={dimension} key={dimension}>
                      {DIMENSION_LABELS[dimension]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>标签</span>
                <select
                  value={dimensionLabelFilter}
                  disabled={!dimensionFilter}
                  onChange={(event) => setDimensionLabelFilter(event.currentTarget.value)}
                >
                  <option value="">全部标签</option>
                  {dimensionLabelOptions.map((label) => (
                    <option value={label} key={label}>{label}</option>
                  ))}
                </select>
              </label>
            </div>
            <label
              className="suspect-filter"
              title="信息镜头与人物镜头不受此画质过滤影响"
            >
              <input
                type="checkbox"
                checked={excludeSuspect}
                onChange={(event) => setExcludeSuspect(event.currentTarget.checked)}
              />
              <span aria-hidden="true" />
              排除普通疑似废片
            </label>
            <label className="suspect-filter duplicate-filter">
              <input
                type="checkbox"
                checked={hideDuplicates}
                onChange={(event) => setHideDuplicates(event.currentTarget.checked)}
              />
              <span aria-hidden="true" />
              只看 Stack 首选
            </label>
            {folderOptions.length > 0 ? (
              <select
                className="folder-filter"
                aria-label="按素材文件夹分类过滤"
                value={folderFilter}
                onChange={(event) => setFolderFilter(event.currentTarget.value)}
              >
                <option value="">全部文件夹</option>
                {folderOptions.map((label) => <option key={label} value={label}>📁 {label}</option>)}
              </select>
            ) : null}
            <label className="suspect-filter memory-filter" title="隐藏往集已用过的素材(跨集记忆);新语境素材保留">
              <input
                type="checkbox"
                checked={avoidCrossEpisodeReuse}
                onChange={(event) => setAvoidCrossEpisodeReuse(event.currentTarget.checked)}
              />
              <span aria-hidden="true" />
              本集避免重复
            </label>
            <button
              className="llm-batch-action"
              type="button"
              disabled={!llmEnabled || llmStatus?.budget_exhausted || batchDescribing || filtered.length === 0}
              onClick={() => void describeFilteredBatch()}
              title={llmEnabled ? "为当前过滤结果逐条生成描述" : "请先在设置页开启 L3 增强"}
            >
              {batchDescribing ? "AI 批量生成中…" : `批量 AI 描述 · ${filtered.length}`}
            </button>
            <div className={`shortcut-strip${composing ? " disabled" : ""}`} aria-disabled={composing}>
              {SELECTION_SHORTCUTS.slice(0, 4).map((shortcut) => (
                <span key={shortcut.id}>
                  {shortcut.keys.map((key) => <kbd key={key}>{key}</kbd>)}
                  {shortcut.action}
                </span>
              ))}
              <span><kbd>Tab</kbd>展开 Stack</span>
              <span><kbd>↑↓</kbd>切换候选</span>
              <span><kbd>Enter</kbd>替换首选</span>
              <span><kbd>L</kbd>锁定</span>
              <span><kbd>R</kbd>排除</span>
            </div>
            <div className="selection-toolbar-status" role="status" aria-live="polite">
              <strong>
                {loading
                  ? "装载中"
                  : submittedQuery
                    ? `${allWallItems.length} 个搜索结果`
                    : `${allWallItems.length} 个容器`}
              </strong>
              <span title={error ?? ratingNotice ?? undefined}>
                {error ??
                  ratingNotice ??
                  (submittedQuery
                    ? `画面与对白：${submittedQuery}`
                    : "L1 角标只作筛选辅助，原片只读")}
              </span>
            </div>
          </div>
          {llmEnabled ? (
            <section className="director-qa" aria-label="导演问答">
              <div className="director-qa-heading">
                <span>DIRECTOR Q&amp;A / 可选 L3</span>
                <small>
                  仅发送当前统计与 {readyClips.filter((clip) => activeRating(clip.binary_rating) === 1 || clip.select_count > 0).length} 条精选摘要
                </small>
              </div>
              <div className="director-qa-input">
                <textarea
                  value={directorQuestion}
                  maxLength={1000}
                  rows={2}
                  placeholder="例如：当前精选是否足够组成 60 秒节奏？信息不足时模型会明确说明。"
                  onChange={(event) => setDirectorQuestion(event.currentTarget.value)}
                />
                <button
                  type="button"
                  disabled={directorBusy || !directorQuestion.trim() || llmStatus?.budget_exhausted}
                  onClick={() => void submitDirectorQuestion()}
                >
                  {directorBusy ? "回答中…" : llmStatus?.budget_exhausted ? "预算已熔断" : "提问"}
                </button>
              </div>
              {directorAnswer ? (
                <div className="director-qa-answer" role="status">
                  <p>{directorAnswer}</p>
                  <small>回答由 {directorProvider} 返回，仅展示，不写入项目库。</small>
                </div>
              ) : null}
            </section>
          ) : null}
          {submittedQuery ? (
            <div className="selection-search-results" aria-live="polite">
              <section data-search-group="visual">
                <header>
                  <strong>画面匹配</strong>
                  <span>{searchingClips ? "…" : visibleSearchHits.length}</span>
                </header>
                {clipSearchError ? <p className="search-error">{clipSearchError}</p> : null}
                {!clipSearchError && !searchingClips && visibleSearchHits.length === 0 ? (
                  <p>没有命中已完成的画面索引</p>
                ) : null}
                <div className="transcript-match-list">
                  {visibleSearchHits.map((hit) => {
                    const clip = clipsById.get(hit.clip_id);
                    return (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(hit.clip_id);
                        }}
                        key={hit.clip_id}
                      >
                        <span>{clip?.file_name ?? `素材 ${hit.clip_id}`}</span>
                        <time>{matchPercentage(hit.score)}%</time>
                        <strong>Chinese-CLIP</strong>
                      </button>
                    );
                  })}
                </div>
              </section>
              <section data-search-group="transcript">
                <header>
                  <strong>对白匹配</strong>
                  <span>{searchingTranscripts ? "…" : visibleTranscriptMatches.length}</span>
                </header>
                {transcriptSearchError ? <p className="search-error">{transcriptSearchError}</p> : null}
                {!transcriptSearchError && !searchingTranscripts && visibleTranscriptMatches.length === 0 ? (
                  <p>没有命中已完成的转写</p>
                ) : null}
                <div className="transcript-match-list">
                  {visibleTranscriptMatches.map((match) => {
                    const clip = clipsById.get(match.clip_id);
                    return (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(match.clip_id);
                        }}
                        key={`${match.clip_id}-${match.seg}`}
                      >
                        <span>{clip?.file_name ?? `素材 ${match.clip_id}`}</span>
                        <time>{transcriptTimeLabel(match)}</time>
                        <strong>{match.text}</strong>
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>
          ) : null}
          {allWallItems.length > 0 ? (
            <div className="asset-safety-groups">
              {rescueWallItems.length > 0 ? (
                <section className="asset-safety-group rescue" aria-label="抢救候选">
                  <header>
                    <strong>抢救候选 · {rescueWallItems.length}</strong>
                    <span>叙事信号覆盖技术低分；独立显示，不受 Stack 淘汰。</span>
                  </header>
                  <VirtualFilmGrid
                    items={rescueWallItems}
                    clipsById={clipsById}
                    selectedId={selectedId}
                    expandedStackId={expandedStackId}
                    memoryLens={memoryLens}
                    onSelect={setSelectedId}
                    onToggleStack={(stackId) => setExpandedStackId((current) => current === stackId ? null : stackId)}
                    onSetMemberState={(stackId, member, state) => void persistShotStackState(stackId, member, state)}
                    onKeyDown={handleKeyDown}
                    onCompositionStart={beginComposition}
                    onCompositionEnd={endComposition}
                  />
                </section>
              ) : null}
              {wallItems.length > 0 ? (
                <section className="asset-safety-group normal" aria-label="常规素材">
                  {rescueWallItems.length > 0 || likelyUnusableWallItems.length > 0 ? (
                    <header><strong>常规素材 · {wallItems.length}</strong></header>
                  ) : null}
                  <VirtualFilmGrid
                    items={wallItems}
                    clipsById={clipsById}
                    selectedId={selectedId}
                    expandedStackId={expandedStackId}
                    memoryLens={memoryLens}
                    onSelect={setSelectedId}
                    onToggleStack={(stackId) => setExpandedStackId((current) => current === stackId ? null : stackId)}
                    onSetMemberState={(stackId, member, state) => void persistShotStackState(stackId, member, state)}
                    onKeyDown={handleKeyDown}
                    onCompositionStart={beginComposition}
                    onCompositionEnd={endComposition}
                  />
                </section>
              ) : null}
              {likelyUnusableWallItems.length > 0 ? (
                <details className="asset-safety-group likely-unusable">
                  <summary>
                    <strong>疑似不可用 · {likelyUnusableWallItems.length}</strong>
                    <span>仅降权并折叠；展开复核，原片不会删除。</span>
                  </summary>
                  <VirtualFilmGrid
                    items={likelyUnusableWallItems}
                    clipsById={clipsById}
                    selectedId={selectedId}
                    expandedStackId={expandedStackId}
                    memoryLens={memoryLens}
                    onSelect={setSelectedId}
                    onToggleStack={(stackId) => setExpandedStackId((current) => current === stackId ? null : stackId)}
                    onSetMemberState={(stackId, member, state) => void persistShotStackState(stackId, member, state)}
                    onKeyDown={handleKeyDown}
                    onCompositionStart={beginComposition}
                    onCompositionEnd={endComposition}
                  />
                </details>
              ) : null}
            </div>
          ) : (
            <div className="film-wall-empty">
              <span>
                {loading ? "BUILDING WALL" : readyClips.length === 0 ? "START HERE" : "NO MATCHES"}
              </span>
              <strong>
                {loading
                  ? "正在整理你的胶片墙"
                  : readyClips.length === 0
                    ? "先去导入一批旅途素材"
                    : submittedQuery
                      ? "这组关键词还没找到画面"
                      : "这个集合暂时是空的"}
              </strong>
              <p>
                {loading
                  ? "封面、评级与功能感知 Shot Stack 会在本地索引就绪后出现。"
                  : readyClips.length === 0
                    ? "从左侧“导入”选择相机卡或目录；原片始终保持只读。"
                    : submittedQuery
                      ? "试试地点、人物、动作或对白中的短词，也可等待本地索引完成。"
                      : "切回“全部”，或暂时关闭疑似废片与 Stack 首选过滤。"}
              </p>
            </div>
          )}
          </div>
          </Panel>
          <Separator className="select-layout-handle" />
          <Panel defaultSize={280} minSize={210} collapsible className="select-layout-side">
        <SelectionInspector
          clip={selectedClip}
          safety={selectedSafety}
          dimensions={selectedDimensions}
          stackMember={selectedStackMember}
          segments={selectSegments}
          deletingSegmentId={deletingSegmentId}
          rescueBusy={rescueBusy}
          llmEnabled={llmEnabled}
          llmBudgetExhausted={llmStatus?.budget_exhausted ?? false}
          aiDescription={selectedId === null ? null : aiDescriptions.get(selectedId) ?? null}
          aiBusy={batchDescribing || (selectedId !== null && describingIds.has(selectedId))}
          onDeleteSegment={(segmentId) => void removeSelectSegment(segmentId)}
          onApplyRescueRange={() => void useSuggestedRescueRange()}
          onTimeStageChange={(label) => void persistTimeStage(label)}
          onDescribe={() => void describeSelected()}
        />
          </Panel>
        </Group>
      )}
      {immersiveClip ? (
        <PlayerOverlay
          clip={immersiveClip}
          onSegmentsChange={() => {
            void refresh();
            void refreshSegments(immersiveClip.id);
          }}
          onExit={() => {
            setImmersiveClip(null);
            void refresh();
            void refreshSegments(immersiveClip.id);
          }}
        />
      ) : null}
    </section>
  );
}
