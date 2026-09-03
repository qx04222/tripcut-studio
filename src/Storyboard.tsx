import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";

import {
  enqueueNarrateEpisode,
  getLlmStatus,
  getStoryboard,
  listShotStacks,
  mergeChapters,
  renameChapter,
  setDestinationCardVerified,
  setStoryOrder,
  setShotStackUserState,
  undoStoryChange,
  updateDestinationCard,
  type Chapter,
  type DestinationCard,
  type NarrativeBeat,
  type NarrativeChapter,
  type NarrativeChapterKind,
  type StoryItem,
  type StoryOrderRef,
  type Storyboard as StoryboardData,
  type ShotStack,
  type ShotStackMember,
  type ShotStackUserState,
  applyNarrativeOp,
  undoNarrativeOp,
  getNarrativeRevision,
  type RevisionInfo,
  type NarrativeOpPayload,
  setRoutineOverride,
  acceptAllRoutineSuggestions,
  setDestinationFieldState,
} from "./api";

const UNCHAPTERED = "unassigned";

const CHAPTER_KIND_LABELS: Record<NarrativeChapterKind, string> = {
  destination: "目的地",
  attraction: "景点介绍",
  journey: "在途旅程",
  experience: "体验活动",
  rv_life: "房车生活",
  people: "人物互动",
  unexpected: "意外事件",
  information: "信息知识",
  atmosphere: "氛围 B-roll",
  transition: "过渡",
};

export function chapterKindLabel(kind: NarrativeChapterKind): string {
  return CHAPTER_KIND_LABELS[kind];
}

export function destinationVerificationLabel(verified: boolean): string {
  return verified ? "已核实" : "待核实";
}

/** Routine 处理方式的中文标签。与后端 routine_override::TREATMENTS 同一套枚举。 */
export function routineTreatmentLabel(treatment: string): string {
  switch (treatment) {
    case "explained": return "首次·完整解释";
    case "story_event": return "变化·主故事事件";
    case "montage": return "重复·压成 Montage";
    case "transition": return "重复·压成过场";
    case "beat": return "保留为普通 Beat";
    case "full": return "整条保留";
    default: return treatment;
  }
}

export function storyboardModeCopy(mode: "legacy" | "narrative"): string {
  return mode === "narrative" ? "Episode / Chapter / Beat" : "D2 本地故事板";
}

function narrativeBeatKey(beat: NarrativeBeat): string {
  return beat.segment_id === null ? `whole:${beat.clip_id}` : `segment:${beat.segment_id}`;
}

export function itemChapterKey(item: StoryItem): string {
  return item.chapter_id === null ? UNCHAPTERED : String(item.chapter_id);
}

export function storyOrderRefs(items: StoryItem[]): StoryOrderRef[] {
  return items.map((item) => ({
    item_kind: item.item_kind,
    clip_id: item.clip_id,
    segment_id: item.segment_id,
  }));
}

export function flattenStoryByChapter(
  chapters: Chapter[],
  items: StoryItem[],
): StoryItem[] {
  const chapterOrder = new Map(chapters.map((chapter, index) => [String(chapter.id), index]));
  return [...items].sort((left, right) => {
    const leftChapter = chapterOrder.get(itemChapterKey(left)) ?? chapters.length;
    const rightChapter = chapterOrder.get(itemChapterKey(right)) ?? chapters.length;
    return (
      leftChapter - rightChapter ||
      (left.position ?? Number.MAX_SAFE_INTEGER) -
        (right.position ?? Number.MAX_SAFE_INTEGER) ||
      left.key.localeCompare(right.key)
    );
  });
}

export function reorderStoryItem(
  chapters: Chapter[],
  current: StoryItem[],
  incoming: StoryItem,
  beforeKey: string | null,
): StoryItem[] {
  const withoutIncoming = current.filter((item) => item.key !== incoming.key);
  const chapterKey = itemChapterKey(incoming);
  const chapterItems = withoutIncoming.filter((item) => itemChapterKey(item) === chapterKey);
  const targetIndex = beforeKey
    ? chapterItems.findIndex((item) => item.key === beforeKey)
    : chapterItems.length;
  if (beforeKey && targetIndex < 0) return flattenStoryByChapter(chapters, current);
  chapterItems.splice(targetIndex < 0 ? chapterItems.length : targetIndex, 0, incoming);
  const grouped = new Map<string, StoryItem[]>();
  withoutIncoming.forEach((item) => {
    const key = itemChapterKey(item);
    if (key !== chapterKey) grouped.set(key, [...(grouped.get(key) ?? []), item]);
  });
  grouped.set(chapterKey, chapterItems);
  const orderedKeys = chapters.map((chapter) => String(chapter.id));
  if (grouped.has(UNCHAPTERED)) orderedKeys.push(UNCHAPTERED);
  grouped.forEach((_items, key) => {
    if (!orderedKeys.includes(key)) orderedKeys.push(key);
  });
  return orderedKeys
    .flatMap((key) => grouped.get(key) ?? [])
    .map((item, position) => ({ ...item, position }));
}

export function moveStoryItemWithinChapter(
  chapters: Chapter[],
  current: StoryItem[],
  itemKey: string,
  direction: -1 | 1,
): StoryItem[] {
  const ordered = flattenStoryByChapter(chapters, current);
  const index = ordered.findIndex((item) => item.key === itemKey);
  const targetIndex = index + direction;
  if (
    index < 0 ||
    targetIndex < 0 ||
    targetIndex >= ordered.length ||
    itemChapterKey(ordered[index]) !== itemChapterKey(ordered[targetIndex])
  ) {
    return current;
  }
  [ordered[index], ordered[targetIndex]] = [ordered[targetIndex], ordered[index]];
  return ordered.map((item, position) => ({ ...item, position }));
}

function itemTimeLabel(item: StoryItem): string {
  if (item.tb_num <= 0 || item.tb_den <= 0) return "时间码待就绪";
  const start = item.in_ticks * item.tb_num / item.tb_den;
  const end = item.out_ticks * item.tb_num / item.tb_den;
  const format = (seconds: number) => {
    const total = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(total / 60);
    const remainder = total % 60;
    return `${minutes}:${remainder.toString().padStart(2, "0")}`;
  };
  return item.item_kind === "whole" ? "整条素材" : `${format(start)}–${format(end)}`;
}

function StoryItemCard({
  item,
  stack,
  stackMember,
  candidate = false,
  dragged,
  onDragStart,
  onDragEnd,
  onDropBefore,
  onAdd,
  onRemove,
  onMove,
  canMoveEarlier = false,
  canMoveLater = false,
  disabled = false,
  onStackState,
}: {
  item: StoryItem;
  stack?: ShotStack;
  stackMember?: ShotStackMember;
  candidate?: boolean;
  dragged: boolean;
  onDragStart: (item: StoryItem) => void;
  onDragEnd: () => void;
  onDropBefore?: (item: StoryItem) => void;
  onAdd?: (item: StoryItem) => void;
  onRemove?: (item: StoryItem) => void;
  onMove?: (item: StoryItem, direction: -1 | 1) => void;
  canMoveEarlier?: boolean;
  canMoveLater?: boolean;
  disabled?: boolean;
  onStackState?: (
    stack: ShotStack,
    member: ShotStackMember,
    state: ShotStackUserState,
  ) => void;
}) {
  return (
    <article
      className={`story-item${candidate ? " candidate" : ""}${dragged ? " dragging" : ""}`}
      draggable
      data-story-key={item.key}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", item.key);
        onDragStart(item);
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (onDropBefore) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!onDropBefore) return;
        event.preventDefault();
        event.stopPropagation();
        onDropBefore(item);
      }}
    >
      <span className="story-grip" aria-hidden="true">⋮⋮</span>
      <span className="story-item-index">
        {candidate ? "候选" : String((item.position ?? 0) + 1).padStart(2, "0")}
      </span>
      <span className="story-item-copy">
        <strong>{item.file_name}</strong>
        <small>{itemTimeLabel(item)}</small>
        {stack && stackMember ? (
          <small className={`story-stack-state ${stackMember.user_state}`}>
            {stack.stack_type === "information"
              ? "信息 Stack · 全量保留"
              : stack.stack_type === "human"
                ? "人物 Stack · 叙事优先"
                : `视觉 Stack · Best ${Math.round((stackMember.best_take_score ?? 0) * 100)}%`}
          </small>
        ) : null}
        {item.long_term_memory?.used_episode_badges.length > 0 ? (
          <small className="episode-used-badges">
            {(item.long_term_memory?.used_episode_badges ?? []).map((episode) => (
              <span key={episode}>{episode} 已用</span>
            ))}
          </small>
        ) : null}
        {item.long_term_memory?.routine_visual ? (
          <small className={item.long_term_memory?.novelty_context ? "novelty-badge" : "routine-visual-badge"}>
            {item.long_term_memory?.novelty_context
              ? "Routine Visual · 新语境恢复候选"
              : `Routine Visual · Narrative ${Math.round(item.long_term_memory?.narrative_adjustment * 100)}%`}
          </small>
        ) : null}
        {item.long_term_memory?.routine_suggestion ? (
          <small className={`routine-treatment ${item.long_term_memory?.routine_suggestion.treatment}`}>
            {item.long_term_memory?.routine_suggestion.routine_kind} · {routineTreatmentLabel(item.long_term_memory?.routine_suggestion.treatment)}
          </small>
        ) : null}
      </span>
      {candidate ? (
        <button type="button" disabled={disabled} onClick={() => onAdd?.(item)}>加入</button>
      ) : (
        <div className="story-item-actions">
          <button
            type="button"
            aria-label={`${item.file_name} 上移`}
            disabled={disabled || !canMoveEarlier}
            onClick={() => onMove?.(item, -1)}
          >上移</button>
          <button
            type="button"
            aria-label={`${item.file_name} 下移`}
            disabled={disabled || !canMoveLater}
            onClick={() => onMove?.(item, 1)}
          >下移</button>
          <button type="button" disabled={disabled} onClick={() => onRemove?.(item)}>移回候选</button>
        </div>
      )}
      {stack && stackMember && onStackState ? (
        <div className="story-stack-actions" aria-label="Shot Stack 状态">
          <button
            type="button"
            className={stackMember.user_state === "locked" ? "active" : undefined}
            onClick={() => onStackState(
              stack,
              stackMember,
              stackMember.user_state === "locked" ? "auto" : "locked",
            )}
          >锁定</button>
          <button
            type="button"
            className={stackMember.user_state === "rejected" ? "active danger" : undefined}
            onClick={() => onStackState(
              stack,
              stackMember,
              stackMember.user_state === "rejected" ? "auto" : "rejected",
            )}
          >排除</button>
          <button
            type="button"
            className={stackMember.user_state === "hero" ? "active hero" : undefined}
            onClick={() => onStackState(stack, stackMember, "hero")}
          >Hero</button>
        </div>
      ) : null}
    </article>
  );
}

const BEAT_ROLE_CYCLE: Record<string, string> = { beat: "montage", montage: "transition", transition: "beat" };

/** dnd-kit 包装:章内/跨章拖拽 Beat(MoveBeat 后端事务)。 */
function SortableBeat({ beat, chapterId, children }: { beat: NarrativeBeat; chapterId: number; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `beat-${beat.id}`,
    data: { beatId: beat.id, chapterId },
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="sortable-beat"
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}

export function NarrativeBeatCard({ beat, item, onOp, onRoutineOverride }: { beat: NarrativeBeat; item?: StoryItem; onOp?: (op: NarrativeOpPayload) => void; onRoutineOverride?: (clipId: number, treatment: string | null, cleared: boolean) => void }) {
  return (
    <article className={`narrative-beat ${beat.role}`}>
      <button
        type="button"
        className="narrative-beat-role"
        title="点击切换 Beat / Montage / Transition"
        disabled={!onOp}
        onClick={() => onOp?.({ op: "set_beat_role", beat_id: beat.id, role: BEAT_ROLE_CYCLE[beat.role] ?? "beat" })}
      >
        {beat.role === "montage" ? "MONTAGE" : beat.role === "transition" ? "TRANSITION" : "BEAT"}
      </button>
      <span className="story-item-copy">
        <strong>{item?.file_name ?? `素材 #${beat.clip_id}`}</strong>
        <small>{item ? itemTimeLabel(item) : "当前精选已变化，请重新编排"}</small>
      </span>
      <strong className="narrative-score">{Math.round(beat.score * 100)}%</strong>
      {beat.routine_suggestion ? (
        <button
          type="button"
          className={`routine-treatment ${beat.routine_suggestion.treatment}`}
          title="点击循环处理方式;循环到「非 Routine」可彻底豁免"
          disabled={!onRoutineOverride}
          onClick={() => {
            // 循环覆盖全部处理方式,AI 给出的 explained/story_event 也能被人工改
            const cycle: Record<string, string | "clear"> = {
              explained: "montage",
              story_event: "montage",
              montage: "transition",
              transition: "beat",
              beat: "full",
              full: "clear",
            };
            const next = cycle[beat.routine_suggestion!.treatment] ?? "montage";
            if (next === "clear") onRoutineOverride?.(beat.clip_id, null, true);
            else onRoutineOverride?.(beat.clip_id, next, false);
          }}
        >
          {beat.routine_suggestion.routine_kind} · {routineTreatmentLabel(beat.routine_suggestion.treatment)}
        </button>
      ) : beat.routine_cleared ? (
        // 已被人工标记为「非 Routine」——routine_suggestion 被抹成 null,
        // 若没有这个分支,恢复入口会随着建议一起消失,变成不可逆死路
        // （回归修复）。恢复即撤销 override(remove_override),AI 建议重新生效。
        <button
          type="button"
          className="routine-treatment cleared"
          title="已标记为非 Routine;点击恢复 AI 建议"
          disabled={!onRoutineOverride}
          onClick={() => onRoutineOverride?.(beat.clip_id, null, false)}
        >
          非 Routine · 恢复 AI 建议
        </button>
      ) : null}
      <p>{beat.rationale}</p>
      {beat.routine_suggestion ? <p>{beat.routine_suggestion.reason}</p> : null}
    </article>
  );
}

function DestinationCardEditor({
  card,
  disabled,
  onSaved,
  onNotice,
}: {
  card: DestinationCard;
  disabled: boolean;
  onSaved: () => Promise<void>;
  onNotice: (notice: string) => void;
}) {
  const [draft, setDraft] = useState(card);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(card), [card]);

  const save = async () => {
    if (disabled || saving) return;
    setSaving(true);
    try {
      await updateDestinationCard(draft);
      await onSaved();
      onNotice("地点卡编辑已保存；内容变化后核实状态已重置为待核实");
    } catch (error) {
      onNotice(`地点卡未保存：${String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleVerified = async () => {
    if (disabled || saving || !card.verified) return;
    setSaving(true);
    try {
      await setDestinationCardVerified(card.id, false);
      await onSaved();
      onNotice("整张地点卡已恢复为逐字段待核实");
    } catch (error) {
      onNotice(`地点卡核实状态未保存：${String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const FIELD_STATE_LABEL: Record<string, string> = { pending: "待核实", verified: "已核实", rejected: "不采用" };
  const cycleFieldState = async (fieldKey: string) => {
    const current = card.field_states[fieldKey] ?? "pending";
    const next = current === "pending" ? "verified" : current === "verified" ? "rejected" : "pending";
    try {
      await setDestinationFieldState(card.id, fieldKey, next as "pending" | "verified" | "rejected");
      onNotice(`「${fieldKey}」已标记为${FIELD_STATE_LABEL[next]};整卡状态随四字段聚合`);
      await onSaved();
    } catch (error) {
      onNotice(`字段核实状态未保存:${String(error)}`);
    }
  };

  const field = (
    key: "name" | "geo_context" | "highlights" | "why_visit" | "personal_note",
    label: string,
    multiline = true,
  ) => (
    <label>
      <span>
        {label}
        {key !== "name" ? (
          <button
            type="button"
            className={`field-state ${card.field_states[key] ?? "pending"}`}
            title="点击循环:待核实→已核实→不采用"
            disabled={disabled}
            onClick={(event) => {
              event.preventDefault();
              void cycleFieldState(key);
            }}
          >
            {FIELD_STATE_LABEL[card.field_states[key] ?? "pending"]}
          </button>
        ) : null}
      </span>
      {multiline ? (
        <textarea
          value={draft[key]}
          maxLength={key === "name" ? 120 : 1_200}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setDraft((current) => ({ ...current, [key]: value }));
          }}
        />
      ) : (
        <input
          value={draft[key]}
          maxLength={120}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setDraft((current) => ({ ...current, [key]: value }));
          }}
        />
      )}
    </label>
  );

  const covered = card.coverage.filter((item) => item.covered).length;
  return (
    <article className="destination-card">
      <header>
        <span className={card.verified ? "verified" : "unverified"}>
          {destinationVerificationLabel(card.verified)}
        </span>
        <small>Coverage {covered}/13</small>
      </header>
      {field("name", "地点名称", false)}
      {field("geo_context", "地理背景")}
      {field("highlights", "历史 / 文化 / 自然特点")}
      {field("why_visit", "为什么值得来")}
      {field("personal_note", "个人体验")}
      <details>
        <summary>覆盖缺口与模型自述依据</summary>
        <ul>
          {card.coverage.filter((item) => !item.covered).map((item) => (
            <li key={item.item}><strong>{item.item}</strong> · {item.suggestion || "待补充"}</li>
          ))}
          {card.sources.map((source, index) => (
            <li key={`${source.label}-${index}`}><strong>{source.label}</strong> · {source.basis}</li>
          ))}
        </ul>
      </details>
      <div className="destination-card-actions">
        <button type="button" disabled={disabled || saving} onClick={() => void save()}>
          {saving ? "保存中…" : "保存编辑"}
        </button>
        <button type="button" disabled={disabled || saving || !card.verified} onClick={() => void toggleVerified()}>
          {card.verified ? "整卡重新核实" : "逐字段核实后自动通过"}
        </button>
      </div>
    </article>
  );
}

export function StoryboardView() {
  const [board, setBoard] = useState<StoryboardData | null>(null);
  const [shotStacks, setShotStacks] = useState<ShotStack[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragged, setDragged] = useState<StoryItem | null>(null);
  const [titleDrafts, setTitleDrafts] = useState<Record<number, string>>({});
  const titleCompositionRef = useRef(false);

  const refresh = useCallback(async () => {
    const [next, nextShotStacks] = await Promise.all([getStoryboard(), listShotStacks()]);
    setBoard(next);
    setShotStacks(nextShotStacks);
    setTitleDrafts(
      Object.fromEntries(next.chapters.map((chapter) => [chapter.id, chapter.title])),
    );
    return next;
  }, []);

  const [revision, setRevision] = useState<RevisionInfo | null>(null);

  const refreshRevision = useCallback(async () => {
    setRevision(await getNarrativeRevision().catch(() => null));
  }, []);

  const runOp = useCallback(async (op: NarrativeOpPayload) => {
    try {
      const info = await applyNarrativeOp(op);
      setRevision(info);
      setNotice(info.kind === "confirmed" ? "已写入确认版(可撤销)" : "已应用");
      await refresh();
    } catch (error) {
      setNotice(`编辑失败：${String(error)}`);
    }
  }, [refresh]);

  const runRoutineOverride = useCallback(async (clipId: number, treatment: string | null, cleared: boolean) => {
    try {
      await setRoutineOverride(clipId, treatment, cleared);
      setNotice(cleared ? "已标记为非 Routine(可在循环中恢复)" : treatment ? "Routine 处理已人工确认" : "已恢复 AI 建议");
      await refresh();
    } catch (error) {
      setNotice(`Routine 裁量失败：${String(error)}`);
    }
  }, [refresh]);

  const acceptAllRoutines = useCallback(async () => {
    const suggestions: Array<[number, string]> = (board?.narrative?.chapters ?? [])
      .flatMap((chapter) => chapter.beats)
      .filter((beat) => beat.routine_suggestion && !beat.routine_suggestion.reason.startsWith("人工确认"))
      .map((beat) => [beat.clip_id, beat.routine_suggestion!.treatment]);
    if (suggestions.length === 0) {
      setNotice("没有待接受的 Routine 建议");
      return;
    }
    try {
      const accepted = await acceptAllRoutineSuggestions(suggestions);
      setNotice(`已接受 ${accepted} 条 Routine 降级建议(逐条仍可改)`);
      await refresh();
    } catch (error) {
      setNotice(`批量接受失败：${String(error)}`);
    }
  }, [board, refresh]);

  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [draggingBeatId, setDraggingBeatId] = useState<number | null>(null);
  const [sidePanel, setSidePanel] = useState<"candidates" | "destinations" | "dh">("candidates");
  const onBeatDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as { beatId: number } | undefined;
    setDraggingBeatId(data?.beatId ?? null);
  }, []);

  const onBeatDragEnd = useCallback((event: DragEndEvent) => {
    setDraggingBeatId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = active.data.current as { beatId: number; chapterId: number } | undefined;
    const to = over.data.current as { beatId: number; chapterId: number } | undefined;
    if (!from || !to) return;
    // 落点顺位 = 目标 beat 在其章 regular 列表中的序号
    const targetChapter = board?.narrative?.chapters.find((chapter) => chapter.id === to.chapterId);
    if (!targetChapter) return;
    const regular = targetChapter.beats.filter(
      (beat) => beat.routine_suggestion === null && beat.role !== "montage",
    );
    const index = regular.findIndex((beat) => beat.id === to.beatId);
    if (index < 0) return;
    void runOp({ op: "move_beat", beat_id: from.beatId, to_chapter_id: to.chapterId, to_order: index });
  }, [board, runOp]);

  const runUndo = useCallback(async () => {
    try {
      const info = await undoNarrativeOp();
      setRevision(info);
      setNotice(info ? "已撤销最近一次编辑" : "没有可撤销的编辑");
      await refresh();
    } catch (error) {
      setNotice(`撤销失败：${String(error)}`);
    }
  }, [refresh]);

  useEffect(() => {
    void refreshRevision();
  }, [refreshRevision]);

  useEffect(() => {
    let active = true;
    void refresh()
      .catch((error) => {
        if (active) setNotice(`故事板未载入：${String(error)}`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!board || !["pending", "running"].includes(board.narration_job_status ?? "")) return;
    const timer = window.setInterval(() => {
      void refresh().catch((error) => setNotice(`叙事任务状态未刷新：${String(error)}`));
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [board, refresh]);

  useEffect(() => {
    if (board?.narration_job_status === "done" && board.mode === "narrative") {
      setNotice("叙事编排已完成；当前粗剪与镜头表按 Beat 顺序读取。");
    } else if (board?.narration_job_status === "done" && board.mode === "legacy") {
      setNotice(board.mode_notice);
    } else if (["failed", "blocked"].includes(board?.narration_job_status ?? "")) {
      setNotice("叙事编排未生效；故事板继续保留当前 D2/上一版安全结果，请检查任务错误后重试。");
    }
  }, [board?.mode, board?.mode_notice, board?.narration_job_status]);

  const allItems = useMemo(
    () => [...(board?.items ?? []), ...(board?.candidates ?? [])],
    [board],
  );
  const itemByKey = useMemo(
    () => new Map(allItems.map((item) => [item.key, item])),
    [allItems],
  );
  const stackByClipId = useMemo(() => {
    const result = new Map<number, { stack: ShotStack; member: ShotStackMember }>();
    shotStacks.forEach((stack) => {
      stack.members.forEach((member) => result.set(member.clip_id, { stack, member }));
    });
    return result;
  }, [shotStacks]);

  const persistStackState = useCallback(async (
    stack: ShotStack,
    member: ShotStackMember,
    state: ShotStackUserState,
  ) => {
    if (busy) return;
    setBusy(true);
    setNotice("正在保存 Shot Stack 状态…");
    try {
      await setShotStackUserState(stack.id, member.clip_id, member.segment_id, state);
      await refresh();
      setNotice(
        state === "rejected"
          ? "候选已排除，素材与故事板条目均未删除"
          : state === "hero"
            ? "已提升为 Hero Shot"
            : state === "locked"
              ? "已锁定 Stack 首选"
              : "已恢复 AI 自动推荐",
      );
    } catch (error) {
      setNotice(`Shot Stack 状态未保存：${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, refresh]);

  const persistOrder = useCallback(async (nextItems: StoryItem[], success: string) => {
    if (!board || busy) return;
    const previous = board;
    const nextKeys = new Set(nextItems.map((item) => item.key));
    setBusy(true);
    setNotice("正在保存故事顺序…");
    setBoard({
      ...board,
      items: nextItems,
      candidates: allItems.filter((item) => !nextKeys.has(item.key)),
    });
    try {
      await setStoryOrder(storyOrderRefs(nextItems));
      await refresh();
      setNotice(success);
    } catch (error) {
      setBoard(previous);
      setNotice(`故事顺序未保存：${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [allItems, board, busy, refresh]);

  const addToChapterEnd = (item: StoryItem) => {
    if (!board) return;
    const next = reorderStoryItem(board.chapters, board.items, item, null);
    void persistOrder(next, "已加入故事板，可撤销");
  };

  const dropBefore = (target: StoryItem) => {
    if (!board || !dragged) return;
    if (itemChapterKey(dragged) !== itemChapterKey(target)) {
      setNotice("镜头仍归属原章节；请先合并章节再跨章排序");
      return;
    }
    const next = reorderStoryItem(board.chapters, board.items, dragged, target.key);
    setDragged(null);
    void persistOrder(next, "故事顺序已保存，可撤销");
  };

  const dropAtChapterEnd = (chapterId: number | null) => {
    if (!board || !dragged || dragged.chapter_id !== chapterId) return;
    const next = reorderStoryItem(board.chapters, board.items, dragged, null);
    setDragged(null);
    void persistOrder(next, "故事顺序已保存，可撤销");
  };

  const removeFromStory = (item: StoryItem) => {
    if (!board) return;
    const next = flattenStoryByChapter(
      board.chapters,
      board.items.filter((candidate) => candidate.key !== item.key),
    ).map((candidate, position) => ({ ...candidate, position }));
    void persistOrder(next, "已移回候选区，可撤销");
  };

  const moveWithinChapter = (item: StoryItem, direction: -1 | 1) => {
    if (!board || busy) return;
    const next = moveStoryItemWithinChapter(board.chapters, board.items, item.key, direction);
    if (next === board.items) return;
    void persistOrder(next, direction < 0 ? "镜头已上移，可撤销" : "镜头已下移，可撤销");
  };

  const saveChapterTitle = async (chapter: Chapter) => {
    const title = (titleDrafts[chapter.id] ?? chapter.title).trim();
    if (!title) {
      setTitleDrafts((drafts) => ({ ...drafts, [chapter.id]: chapter.title }));
      setNotice("章节名不能为空；已恢复原名称");
      return;
    }
    if (title === chapter.title) return;
    if (busy) {
      setTitleDrafts((drafts) => ({ ...drafts, [chapter.id]: chapter.title }));
      setNotice("故事板正在保存其他改动；章节名未提交并已恢复");
      return;
    }
    setBusy(true);
    try {
      await renameChapter(chapter.id, title);
      await refresh();
      setNotice("章节名已保存，可撤销");
    } catch (error) {
      setNotice(`章节名未保存：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const mergeWithPrevious = async (chapter: Chapter, index: number) => {
    if (!board || index <= 0 || busy) return;
    setBusy(true);
    try {
      await mergeChapters(chapter.id, board.chapters[index - 1].id);
      await refresh();
      setNotice("章节已合并，可撤销");
    } catch (error) {
      setNotice(`章节未合并：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!board?.can_undo || busy) return;
    setBusy(true);
    try {
      await undoStoryChange();
      await refresh();
      setNotice("已撤销上一步故事板操作");
    } catch (error) {
      setNotice(`未能撤销：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const narrate = async () => {
    if (busy || ["pending", "running"].includes(board?.narration_job_status ?? "")) return;
    setBusy(true);
    try {
      const status = await getLlmStatus();
      if (!status.enabled) {
        setNotice("L3 增强默认关闭；当前继续使用 D2 本地故事板。请先在设置页明确开启。");
        return;
      }
      if (status.provider === "none" || status.provider === "auto") {
        setNotice(status.provider === "none"
          ? "尚未选择 LLM provider；请先在设置页锁定单一 provider。"
          : "旧版自动回退已禁用；请先在设置页锁定单一 provider。");
        return;
      }
      if (status.budget_exhausted || status.remaining_calls < 1) {
        setNotice("L3 月度预算已用尽；未创建任务，当前继续使用 D2/上一版故事板。");
        return;
      }
      const confirmed = window.confirm(
        `重新编排会向已锁定的 ${status.provider} 发送匿名 clip/segment ID、时长、尺寸、八维标签与镜头 Stack 数值；不发送文件名、拍摄时间、GPS、转写或频道记忆。预计 1 次调用，不自动回退，并写入 E2 账本。当前剩余 ${status.remaining_calls} 次。继续吗？`,
      );
      if (!confirmed) return;
      const jobId = await enqueueNarrateEpisode();
      await refresh();
      setNotice(`叙事编排任务 #${jobId} 已排队；完成前继续显示当前故事板。`);
    } catch (error) {
      setNotice(`未创建叙事编排任务：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="storyboard-empty">正在装载旅行章节与故事顺序…</div>;
  }
  if (!board) {
    return <div className="storyboard-empty">{notice ?? "故事板暂不可用"}</div>;
  }

  const renderChapter = (chapter: Chapter | null, index: number) => {
    const chapterId = chapter?.id ?? null;
    const chapterItems = board.items.filter((item) => item.chapter_id === chapterId);
    return (
      <section className="story-chapter" key={chapter?.id ?? UNCHAPTERED}>
        <header>
          <span className="story-chapter-number">{String(index + 1).padStart(2, "0")}</span>
          {chapter ? (
            <label>
              <span className="sr-only">章节名</span>
              <input
                value={titleDrafts[chapter.id] ?? chapter.title}
                disabled={busy}
                maxLength={80}
                onChange={(event) => {
                  // React 合成事件在 updater 异步执行阶段已被回收(currentTarget
                  // 变 null),必须先同步取值再进 updater——本仓第 8 处同类修复
                  // （回归修复）。
                  const value = event.currentTarget.value;
                  setTitleDrafts((drafts) => ({
                    ...drafts,
                    [chapter.id]: value,
                  }));
                }}
                onBlur={() => void saveChapterTitle(chapter)}
                onCompositionStart={() => {
                  titleCompositionRef.current = true;
                }}
                onCompositionEnd={() => {
                  titleCompositionRef.current = false;
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !titleCompositionRef.current &&
                    !event.nativeEvent.isComposing &&
                    event.nativeEvent.keyCode !== 229
                  ) {
                    event.currentTarget.blur();
                  }
                }}
              />
            </label>
          ) : <strong>未分章</strong>}
          <small>{chapter ? `${chapter.clip_count} 条素材` : "等待拍摄时间"}</small>
          {chapter && index > 0 ? (
            <button type="button" disabled={busy} onClick={() => void mergeWithPrevious(chapter, index)}>
              与上一章合并
            </button>
          ) : null}
        </header>
        <div
          className="story-chapter-items"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event: DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            dropAtChapterEnd(chapterId);
          }}
        >
          {chapterItems.map((item, itemIndex) => (
            <StoryItemCard
              item={item}
              stack={stackByClipId.get(item.clip_id)?.stack}
              stackMember={stackByClipId.get(item.clip_id)?.member}
              dragged={dragged?.key === item.key}
              onDragStart={setDragged}
              onDragEnd={() => setDragged(null)}
              onDropBefore={dropBefore}
              onRemove={removeFromStory}
              onMove={moveWithinChapter}
              canMoveEarlier={itemIndex > 0}
              canMoveLater={itemIndex < chapterItems.length - 1}
              disabled={busy}
              onStackState={(stack, member, state) => void persistStackState(stack, member, state)}
              key={item.key}
            />
          ))}
          {chapterItems.length === 0 ? <p>从候选区拖入本章精选</p> : null}
        </div>
      </section>
    );
  };

  const renderNarrativeChapter = (chapter: NarrativeChapter, index: number) => {
    const routineBeats = chapter.beats.filter((beat) => beat.routine_suggestion !== null);
    const regularBeats = chapter.beats.filter(
      (beat) => beat.routine_suggestion === null && beat.role !== "montage",
    );
    const montageBeats = chapter.beats.filter(
      (beat) => beat.routine_suggestion === null && beat.role === "montage",
    );
    return (
      <section className="story-chapter narrative-chapter" key={chapter.id}>
        <header>
          <span className="story-chapter-number">{String(index + 1).padStart(2, "0")}</span>
          <div className="narrative-chapter-title">
            <select
              className="chapter-kind-select"
              aria-label="章节类型"
              value={chapter.kind}
              onChange={(event) => {
                const kind = event.currentTarget.value;
                void runOp({ op: "set_chapter_kind", chapter_id: chapter.id, kind });
              }}
            >
              {(["destination","attraction","journey","experience","rv_life","people","unexpected","information","atmosphere","transition"] as const).map((kind) => (
                <option key={kind} value={kind}>{chapterKindLabel(kind)}</option>
              ))}
            </select>
            <strong
              className="chapter-title-editable"
              title="双击重命名"
              onDoubleClick={() => {
                const title = window.prompt("章节标题", chapter.title);
                if (title && title.trim() && title.trim() !== chapter.title) {
                  void runOp({ op: "rename_chapter", chapter_id: chapter.id, title: title.trim() });
                }
              }}
            >{chapter.title}</strong>
          </div>
          <small>{chapter.beats.length} Beats · {Math.round(chapter.score * 100)}%</small>
          {chapter.promoted ? <span className="chapter-promoted">已升级主章</span> : null}
        </header>
        <details className="narrative-rationale">
          <summary>为什么这么分</summary>
          <p>{chapter.rationale}</p>
          {chapter.promotion_reason ? <p>升级依据：{chapter.promotion_reason}</p> : null}
          {chapter.digital_human_plan ? (
            <p>
              数字人规划 {chapter.digital_human_plan.mode}：{chapter.digital_human_plan.reason}
              （仅规划，不在本工具生成）
            </p>
          ) : null}
        </details>
        <div className="story-slot-flow" aria-label="叙事槽位">
          {chapter.story_slots.map((slot) => <span key={slot}>{slot}</span>)}
          {chapter.missing_slots.map((slot) => (
            <button
              type="button"
              className="missing"
              key={`missing-${slot}`}
              title="点击去筛片按该槽位关键词搜索候选素材"
              onClick={() => {
                window.location.hash = "/review";
                window.setTimeout(() => {
                  window.dispatchEvent(new CustomEvent("tripcut:search", { detail: slot }));
                }, 120);
              }}
            >缺 {slot} ⌕</button>
          ))}
        </div>
        <div className="story-chapter-items">
          <SortableContext
            items={regularBeats.map((beat) => `beat-${beat.id}`)}
            strategy={verticalListSortingStrategy}
          >
            {regularBeats.map((beat) => (
              <SortableBeat beat={beat} chapterId={chapter.id} key={beat.id}>
                <NarrativeBeatCard beat={beat} item={itemByKey.get(narrativeBeatKey(beat))} onOp={runOp} onRoutineOverride={runRoutineOverride} />
              </SortableBeat>
            ))}
          </SortableContext>
          {routineBeats.length > 0 ? (
            <details className="routine-group">
              <summary>
                Routine 素材 · {routineBeats.length} 条（建议，不强制）
                <button
                  type="button"
                  className="routine-accept-all"
                  onClick={(event) => {
                    event.preventDefault();
                    void acceptAllRoutines();
                  }}
                >全部接受降级</button>
              </summary>
              {routineBeats.map((beat) => (
                <NarrativeBeatCard beat={beat} item={itemByKey.get(narrativeBeatKey(beat))} onOp={runOp} onRoutineOverride={runRoutineOverride} key={beat.id} />
              ))}
            </details>
          ) : null}
          {montageBeats.length > 0 ? (
            <details className="montage-group">
              <summary>Montage 降级组 · {montageBeats.length} 条重复性内容</summary>
              {montageBeats.map((beat) => (
                <NarrativeBeatCard beat={beat} item={itemByKey.get(narrativeBeatKey(beat))} onOp={runOp} onRoutineOverride={runRoutineOverride} key={beat.id} />
              ))}
            </details>
          ) : null}
        </div>
      </section>
    );
  };

  const hasUnchaptered = allItems.some((item) => item.chapter_id === null);
  const narrativeActive = board.mode === "narrative" && board.narrative !== null;
  const narrationBusy = ["pending", "running"].includes(board.narration_job_status ?? "");

  return (
    <div className="storyboard-workbench">
      <div className="storyboard-toolbar">
        <span>ROUGH CUT / {storyboardModeCopy(board.mode)}</span>
        <strong>
          {board.narrative ? `${board.narrative.episode.title} · ` : ""}
          {narrativeActive
            ? `${board.narrative?.chapters.reduce((sum, chapter) => sum + chapter.beats.length, 0) ?? 0} Beats`
            : `${board.items.length} 条已编排 · ${board.candidates.length} 条候选`}
        </strong>
        <button type="button" disabled={busy || narrationBusy} onClick={() => void narrate()}>
          {narrationBusy ? "编排中…" : "重新编排"}
        </button>
        <button type="button" disabled={!board.can_undo || busy} onClick={() => void undo()}>
          撤销上一步
        </button>
        {revision ? (
          <span className={`revision-badge ${revision.kind}`} title="AI 建议版可编辑;首次编辑自动生成确认版,交付按确认版读取">
            {revision.kind === "confirmed"
              ? `确认版 · ${revision.pending_undo_count} 次修改`
              : "AI 建议版"}
          </span>
        ) : null}
        {revision?.kind === "confirmed" && revision.pending_undo_count > 0 ? (
          <button type="button" disabled={busy} onClick={() => void runUndo()}>
            撤销编排编辑
          </button>
        ) : null}
      </div>
      <div className="storyboard-status" aria-live="polite">
        {notice ?? board.mode_notice}
      </div>
      <div className={`storyboard-scroll${narrativeActive ? " narrative-layout" : ""}`}>
        <main className="story-sequence" aria-label="粗剪故事顺序">
          {narrativeActive && board.narrative ? (
            <section className="narrative-episode-header">
              <span>EPISODE</span>
              <div>
                <h2>{board.narrative.episode.title}</h2>
                <p>{board.narrative.episode.theme}</p>
              </div>
              <details>
                <summary>{board.narrative.boundary_signals.length} 个本地候选边界（仅信号）</summary>
                <ul>
                  {board.narrative.boundary_signals.map((boundary) => (
                    <li key={`${boundary.before_clip_id}-${boundary.after_clip_id}`}>
                      #{boundary.before_clip_id} → #{boundary.after_clip_id} · {boundary.reasons.join(" / ")}
                    </li>
                  ))}
                </ul>
              </details>
              {board.narrative.dh_guard.warnings.length > 0 ? (
                <details className="dh-guard-warning">
                  <summary>
                    数字人节奏警示 · 规划约 {Math.round(board.narrative.dh_guard.current_estimated_duration_s)} 秒
                  </summary>
                  <ul>
                    {board.narrative.dh_guard.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </section>
          ) : null}
          {narrativeActive
            ? (
              <DndContext sensors={dndSensors} onDragStart={onBeatDragStart} onDragEnd={onBeatDragEnd}>
                {board.narrative?.chapters.map((chapter, index) => renderNarrativeChapter(chapter, index))}
                <DragOverlay>
                  {draggingBeatId !== null ? (() => {
                    const beat = board.narrative?.chapters
                      .flatMap((chapter) => chapter.beats)
                      .find((candidate) => candidate.id === draggingBeatId);
                    return beat ? (
                      <div className="beat-drag-preview">
                        <span>{beat.role.toUpperCase()}</span>
                        <strong>{itemByKey.get(narrativeBeatKey(beat))?.file_name ?? `素材 #${beat.clip_id}`}</strong>
                      </div>
                    ) : null;
                  })() : null}
                </DragOverlay>
              </DndContext>
            )
            : board.chapters.map((chapter, index) => renderChapter(chapter, index))}
          {!narrativeActive && hasUnchaptered ? renderChapter(null, board.chapters.length) : null}
          {!narrativeActive && board.chapters.length === 0 && !hasUnchaptered ? (
            <div className="storyboard-empty">导入完成后会按拍摄时间自动生成章节。</div>
          ) : null}
        </main>
        <div className="story-side">
        <div className="story-side-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={sidePanel === "candidates"} className={sidePanel === "candidates" ? "active" : ""} onClick={() => setSidePanel("candidates")}>候选 {board.candidates.length}</button>
          {narrativeActive ? (
            <>
              <button type="button" role="tab" aria-selected={sidePanel === "destinations"} className={sidePanel === "destinations" ? "active" : ""} onClick={() => setSidePanel("destinations")}>地点卡 {board.narrative?.destination_cards.length ?? 0}</button>
              <button type="button" role="tab" aria-selected={sidePanel === "dh"} className={sidePanel === "dh" ? "active" : ""} onClick={() => setSidePanel("dh")}>DH 计划{(board.narrative?.dh_guard.warnings.length ?? 0) > 0 ? " ⚠" : ""}</button>
            </>
          ) : null}
        </div>
        <aside
          className="story-candidates"
          hidden={sidePanel !== "candidates"}
          aria-label="候选区"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const item = dragged ?? itemByKey.get(event.dataTransfer.getData("text/plain"));
            if (item && board.items.some((candidate) => candidate.key === item.key)) {
              removeFromStory(item);
            }
            setDragged(null);
          }}
        >
          <header>
            <span>CANDIDATES / 候选区</span>
            <strong>{board.candidates.length}</strong>
          </header>
          {board.chapters.map((chapter) => {
            const candidates = board.candidates.filter((item) => item.chapter_id === chapter.id);
            if (candidates.length === 0) return null;
            return (
              <section key={chapter.id}>
                <h3>{chapter.title}</h3>
                {candidates.map((item) => (
                  <StoryItemCard
                    item={item}
                    stack={stackByClipId.get(item.clip_id)?.stack}
                    stackMember={stackByClipId.get(item.clip_id)?.member}
                    candidate
                    dragged={dragged?.key === item.key}
                    onDragStart={setDragged}
                    onDragEnd={() => setDragged(null)}
                    onAdd={addToChapterEnd}
                    onStackState={(stack, member, state) => void persistStackState(stack, member, state)}
                    key={item.key}
                  />
                ))}
              </section>
            );
          })}
          {board.candidates.filter((item) => item.chapter_id === null).map((item) => (
            <StoryItemCard
              item={item}
              stack={stackByClipId.get(item.clip_id)?.stack}
              stackMember={stackByClipId.get(item.clip_id)?.member}
              candidate
              dragged={dragged?.key === item.key}
              onDragStart={setDragged}
              onDragEnd={() => setDragged(null)}
              onAdd={addToChapterEnd}
              onStackState={(stack, member, state) => void persistStackState(stack, member, state)}
              key={item.key}
            />
          ))}
          {board.candidates.length === 0 ? <p>所有精选都已进入故事板</p> : null}
        </aside>
        {narrativeActive ? (
          <aside className="destination-sidebar" hidden={sidePanel !== "destinations"} aria-label="Destination Cards">
            <header>
              <span>DESTINATION CARDS / 地点卡</span>
              <strong>{board.narrative?.destination_cards.length ?? 0}</strong>
            </header>
            {board.narrative?.destination_cards.map((card) => (
              <DestinationCardEditor
                card={card}
                disabled={busy}
                onSaved={async () => { await refresh(); }}
                onNotice={setNotice}
                key={card.id}
              />
            ))}
            {board.narrative?.destination_cards.length === 0 ? (
              <p>本次编排没有识别出需要地点卡的重要叙事节点。</p>
            ) : null}
          </aside>
        ) : null}
        {narrativeActive ? (
          <aside className="dh-planner" hidden={sidePanel !== "dh"} aria-label="数字人计划">
            <header>
              <span>DH PLANNER / 数字人计划</span>
              <strong>约 {Math.round(board.narrative?.dh_guard.current_estimated_duration_s ?? 0)}s</strong>
            </header>
            {(board.narrative?.dh_guard.warnings.length ?? 0) > 0 ? (
              <div className="dh-planner-warnings">
                {board.narrative?.dh_guard.warnings.map((warning) => (
                  <p key={warning}>⚠ {warning}</p>
                ))}
              </div>
            ) : (
              <p className="dh-planner-ok">节奏正常:无间距或时长警示。</p>
            )}
            <div className="dh-planner-slots">
              {(board.narrative?.chapters ?? []).map((chapter, index) => (
                <div className="dh-planner-slot" key={chapter.id} data-has-dh={chapter.digital_human_plan ? "1" : "0"}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{chapter.title}</strong>
                  {chapter.digital_human_plan ? (
                    <small>
                      模式 {chapter.digital_human_plan.mode} · {chapter.digital_human_plan.reason}
                    </small>
                  ) : (
                    <small className="none">无 DH</small>
                  )}
                </div>
              ))}
            </div>
            <p className="dh-planner-note">仅规划与节奏守卫;数字人不在本工具生成。历史出现频率随交付入账,重复过密会在此警示。</p>
          </aside>
        ) : null}
        </div>
      </div>
    </div>
  );
}
