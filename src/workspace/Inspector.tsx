import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";

import {
  clearClipRating,
  describeClipWithAi,
  getAiDescription,
  getLlmStatus,
  getSettings,
  rateClip,
  setClipTimeStage,
  applyNarrativeOp,
  undoNarrativeOp,
  type AiDescriptionResult,
} from "../api";
import {
  ChapterSlotSection,
  EmptyInspectorNote,
  RatingControls,
  TakeSwitcher,
} from "./inspectorFields";
import { InspectorTags } from "./InspectorTags";
import { InspectorHeader } from "./InspectorHeader";
import { InspectorCollapsibleSections } from "./InspectorCollapsible";
import { GapInspector } from "./InspectorSections";
import { SelectSegmentsSection } from "./InspectorSegments";
import { PaneHead } from "./PaneHead";
import {
  chapterSlotOptions,
  findClipPlacement,
  narrativeChapterOptions,
  techCheckIssueCount,
  visibleDefaultSections,
  type DefaultSectionId,
} from "./inspectorModel";
import { Button, Card, Icon, SectionHeader, type IconName } from "./ui";
import { planBandReorder, useBandDrag } from "./useBandDrag";
import { refreshClipsFeed, useClipsFeed } from "./useClipsFeed";
import { useSelection } from "./useSelection";
import { dispatchWorkspace, useWorkspace } from "./WorkspaceStore";
import { INSPECTOR_TITLES } from "./copy";
import { pushUndo } from "./undoStack";

export type InspectorSectionId = "techcheck" | "dimensions" | "ai" | "audio" | "similar";

export const INSPECTOR_SECTIONS: readonly { id: InspectorSectionId; title: string; icon: IconName }[] = [
  { id: "techcheck", title: "技术检查", icon: "check" },
  { id: "dimensions", title: INSPECTOR_TITLES.dimensions, icon: "settings-analysis" },
  { id: "ai", title: "AI 描述", icon: "settings-generation" },
  { id: "audio", title: INSPECTOR_TITLES.audio, icon: "volume" },
  { id: "similar", title: "相似镜头", icon: "similar" },
];

/** 默认层五张卡的标题与图标(R18:tag / slot / takes 是各自的图标,不再借用别的名字)。 */
const DEFAULT_SECTION_META: Record<DefaultSectionId, { title: string; icon: IconName }> = {
  rating: { title: "评级与收藏", icon: "star" },
  tags: { title: "标签", icon: "tag" },
  chapter: { title: "所属章节 / 槽位", icon: "slot" },
  segments: { title: "精选段", icon: "mark-in" },
  takes: { title: "同一镜头的多条", icon: "takes" },
};

/**
 * 「加载中」的终态窗口(R10 U-27):面板 8 秒内没上报计数就落到「未探测 / 暂无数据」,
 * 不再一直「加载中」;之后真正的计数到了照样覆盖。
 */
export const SECTION_LOADING_TIMEOUT_MS = 8_000;
/** 计数的哨兵值:超时未上报。与 0 分开,状态字才能说「暂无数据」而不是「无」。 */
export const COUNT_TIMED_OUT = -1;

/** 默认层的一张卡:铬条标题(图标 + 段名 + 右侧 meta)+ 内容。 */
function DefaultSectionCard({ id, meta, children }: { id: DefaultSectionId; meta?: string; children: ReactNode }): JSX.Element {
  const { title, icon } = DEFAULT_SECTION_META[id];
  return (
    <Card padding={3} className="inspector-default-section" data-section={id}>
      <SectionHeader size="pane" title={<><Icon name={icon} />{title}</>} meta={meta} />
      <div className="inspector-card-body">{children}</div>
    </Card>
  );
}

export interface InspectorStatusContext {
  techCheckIssues: number;
  aiDescribed: boolean;
  /** `null` = 面板尚未上报计数(加载中),不能当作 0 处理。 */
  audioTrackCount: number | null;
  /** `null` = 面板尚未上报计数(加载中),不能当作 0 处理。 */
  similarGroupCount: number | null;
  dimensionCount: number;
}

/** 每段标题右侧那个「极简状态字」,收起时也能判断要不要展开(规格 §4)。
 * 音轨数/相似组数在面板真正上报计数之前必须显示中性的「加载中」——
 * 不能因为 state 初值是 0/未知就误报「未探测」/「无」(假阴性)。 */
export function sectionStatusText(id: InspectorSectionId, ctx: InspectorStatusContext): string {
  switch (id) {
    case "techcheck":
      return ctx.techCheckIssues > 0 ? `${ctx.techCheckIssues} 项提示` : "正常";
    case "dimensions":
      return ctx.dimensionCount > 0 ? `${ctx.dimensionCount}/8 维已判定` : "待判定";
    case "ai":
      return ctx.aiDescribed ? "已生成" : "未生成";
    case "audio":
      if (ctx.audioTrackCount === null) return "加载中";
      return ctx.audioTrackCount > 0 ? `${ctx.audioTrackCount} 条音轨` : "未探测";
    case "similar":
      if (ctx.similarGroupCount === null) return "加载中";
      if (ctx.similarGroupCount < 0) return "暂无数据";
      return ctx.similarGroupCount > 0 ? `${ctx.similarGroupCount} 组` : "无";
  }
}

/** 折叠段的「安静」状态字:没东西可看 —— 这些段收进一个「更多信息」折叠,不占检查器版面(R11 简化专项 #4)。 */
export const QUIET_SECTION_STATUS: readonly string[] = ["待判定", "未探测", "暂无数据", "无"];

export function isQuietSection(id: InspectorSectionId, ctx: InspectorStatusContext): boolean {
  if (id === "techcheck" || id === "ai") return false;
  return QUIET_SECTION_STATUS.includes(sectionStatusText(id, ctx));
}

/** 默认层选中一条素材时的检查器主体。 */
function ClipInspector({ clipId }: { clipId: number }): JSX.Element {
  const feed = useClipsFeed();
  const { selectedClip: clip, selectedStack: stack, selectClip } = useSelection();
  // 「槽位」下拉的写入路径与镜头带拖排是同一条(planBandReorder → set_story_order)。
  const slotDrag = useBandDrag(feed.storyboard ?? null);
  const [aiDescription, setAiDescription] = useState<AiDescriptionResult | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [llmEnabled, setLlmEnabled] = useState(false);
  const [llmBudgetExhausted, setLlmBudgetExhausted] = useState(false);
  const [ratingBusy, setRatingBusy] = useState(false);
  // R16 P2-10:标签段自己拉 `list_tags`(AI + 用户),条数报上来给段标题与可见性。
  const [tagCount, setTagCount] = useState<{ clipId: number; count: number } | null>(null);
  const tagTotal = tagCount?.clipId === clipId ? tagCount.count : aiDescription?.tags.length ?? 0;
  const onTagCount = useCallback((count: number) => setTagCount({ clipId, count }), [clipId]);
  // 计数带着「是哪条素材的」:换素材不靠 effect 清零 —— 子面板的上报 effect 比父的清零 effect
  // 先跑,清零会把刚到的计数抹掉,状态字永远「加载中」(U-27 的第二个根因)。
  const [audioCount, setAudioCount] = useState<{ clipId: number; count: number } | null>(null);
  const [similarCount, setSimilarCount] = useState<{ clipId: number; count: number } | null>(null);
  const audioTrackCount = audioCount?.clipId === clipId ? audioCount.count : null;
  const similarGroupCount = similarCount?.clipId === clipId ? similarCount.count : null;
  const setAudioTrackCount = useCallback((count: number) => setAudioCount({ clipId, count }), [clipId]);
  const setSimilarGroupCount = useCallback((count: number) => setSimilarCount({ clipId, count }), [clipId]);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    // 8 秒没有上报就落终态(U-27);面板真的上报了会把哨兵值盖掉。
    const timer = window.setTimeout(() => {
      setAudioCount((current) => (current?.clipId === clipId ? current : { clipId, count: COUNT_TIMED_OUT }));
      setSimilarCount((current) => (current?.clipId === clipId ? current : { clipId, count: COUNT_TIMED_OUT }));
    }, SECTION_LOADING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [clipId]);

  useEffect(() => {
    setAiDescription(null);
    getAiDescription(clipId)
      .then((result) => {
        if (mounted.current) setAiDescription(result ?? null);
      })
      .catch(() => undefined);
  }, [clipId]);

  useEffect(() => {
    Promise.all([getSettings(), getLlmStatus()])
      .then(([settings, status]) => {
        if (!mounted.current) return;
        setLlmEnabled(settings.llm_enabled === "true" && status.enabled);
        setLlmBudgetExhausted(status.budget_exhausted);
      })
      .catch(() => {
        if (mounted.current) {
          setLlmEnabled(false);
          setLlmBudgetExhausted(false);
        }
      });
  }, []);

  const onDescribe = useCallback(() => {
    setAiBusy(true);
    describeClipWithAi(clipId)
      .then((result) => {
        if (mounted.current) setAiDescription(result);
      })
      .catch(() => undefined)
      .finally(() => {
        if (mounted.current) setAiBusy(false);
      });
  }, [clipId]);

  const onRate = useCallback(
    (kind: "binary" | "star", value: number) => {
      setRatingBusy(true);
      rateClip(clipId, kind, value)
        .then(() => refreshClipsFeed(true))
        .catch(() => undefined)
        .finally(() => {
          if (mounted.current) setRatingBusy(false);
        });
    },
    [clipId],
  );

  const onClearRating = useCallback(() => {
    setRatingBusy(true);
    clearClipRating(clipId)
      .then(() => refreshClipsFeed(true))
      .catch(() => undefined)
      .finally(() => {
        if (mounted.current) setRatingBusy(false);
      });
  }, [clipId]);

  const onTimeStageChange = useCallback(
    (label: string) => {
      setClipTimeStage(clipId, label)
        .then(() => refreshClipsFeed(true))
        .catch(() => undefined);
    },
    [clipId],
  );

  const placement = useMemo(() => findClipPlacement(feed.storyboard, clipId), [feed.storyboard, clipId]);
  const chapterOptions = useMemo(() => narrativeChapterOptions(feed.storyboard), [feed.storyboard]);
  const onMoveChapter = useCallback(
    (chapterId: number) => {
      if (!placement || placement.beatId === null) return;
      const beatId = placement.beatId;
      void applyNarrativeOp({ op: "move_beat", beat_id: beatId, to_chapter_id: chapterId, to_order: 0 })
        .then(() => {
          // R16 P2-2:叙事修改也进全局撤销栈(⌘Z → undo_narrative_op)。
          pushUndo({
            label: "移到别的章",
            undo: async () => {
              await undoNarrativeOp();
              await refreshClipsFeed(true);
            },
          });
          return refreshClipsFeed(true);
        })
        .catch(() => undefined);
    },
    [placement],
  );

  const slots = useMemo(() => chapterSlotOptions(feed.storyboard, clipId), [feed.storyboard, clipId]);
  const onAddToBand = useCallback(() => slotDrag.insert(clipId), [slotDrag, clipId]);
  const onMoveSlot = useCallback(
    (targetKey: string) => {
      if (feed.storyboard && slots.current !== null) slotDrag.apply(planBandReorder(feed.storyboard, slots.current, targetKey));
    },
    [feed.storyboard, slots, slotDrag],
  );

  const poolOrder = useMemo(
    () => feed.clips.map((item) => item.id).filter((id): id is number => id !== null),
    [feed.clips],
  );
  const poolIndex = poolOrder.indexOf(clipId);
  const onStepClip = useCallback(
    (direction: -1 | 1) => {
      const next = poolOrder[poolIndex + direction];
      if (next !== undefined) selectClip(next);
    },
    [poolOrder, poolIndex, selectClip],
  );

  const clipDimensions = useMemo(
    () => feed.dimensions.filter((dimension) => dimension.clip_id === clipId),
    [feed.dimensions, clipId],
  );

  if (!clip) return <EmptyInspectorNote />;

  const ctx: InspectorStatusContext = {
    techCheckIssues: techCheckIssueCount(clip),
    aiDescribed: aiDescription !== null,
    audioTrackCount,
    similarGroupCount,
    dimensionCount: clipDimensions.length,
  };

  const canReassign = Boolean(placement && placement.beatId !== null && chapterOptions.length > 0);
  const sections = visibleDefaultSections({
    tagCount: tagTotal,
    hasPlacement: placement !== null,
    canReassign,
    hasStack: stack !== null,
  });

  return (
    <div className="inspector-clip">
      <InspectorHeader clip={clip} index={poolIndex} total={poolOrder.length} onStep={onStepClip} />
      {sections.includes("rating") ? (
        <DefaultSectionCard id="rating">
          <RatingControls clip={clip} busy={ratingBusy} onRate={onRate} onClear={onClearRating} />
        </DefaultSectionCard>
      ) : null}
      {sections.includes("tags") ? (
        <DefaultSectionCard id="tags" meta={`${tagTotal} 个`}>
          <InspectorTags clipId={clipId} readOnly={feed.episode.viewing !== null} onCount={onTagCount} />
        </DefaultSectionCard>
      ) : null}
      {sections.includes("chapter") ? (
        <DefaultSectionCard id="chapter">
          <ChapterSlotSection
            chapterTitle={placement?.chapterTitle ?? null}
            canReassign={canReassign}
            chapterOptions={chapterOptions}
            currentChapterId={placement?.chapterId ?? null}
            slotOptions={slots.options}
            currentSlotKey={slots.current}
            readOnly={feed.episode.viewing !== null}
            onMoveChapter={onMoveChapter}
            onMoveSlot={onMoveSlot}
            onAddToBand={onAddToBand}
            addBusy={slotDrag.busy}
          />
          {slotDrag.notice ? (
            <p className="inspector-notice" role="status">
              {slotDrag.notice}
            </p>
          ) : null}
        </DefaultSectionCard>
      ) : null}
      {sections.includes("segments") ? (
        <DefaultSectionCard id="segments" meta={clip.select_count > 0 ? `${clip.select_count} 段` : undefined}>
          <SelectSegmentsSection clipId={clipId} selectCount={clip.select_count} readOnly={feed.episode.viewing !== null} />
        </DefaultSectionCard>
      ) : null}
      {sections.includes("takes") && stack ? (
        <DefaultSectionCard id="takes" meta={`${stack.members.length} 条`}>
          <TakeSwitcher stack={stack} clipsById={feed.clipsById} selectedClipId={clipId} onSelect={selectClip} />
        </DefaultSectionCard>
      ) : null}

      <InspectorCollapsibleSections
        clip={clip}
        ctx={ctx}
        clipDimensions={clipDimensions}
        clipsById={feed.clipsById}
        aiDescription={aiDescription}
        llmEnabled={llmEnabled}
        llmBudgetExhausted={llmBudgetExhausted}
        aiBusy={aiBusy}
        onDescribe={onDescribe}
        onTimeStageChange={onTimeStageChange}
        onAudioCount={setAudioTrackCount}
        onSimilarCount={setSimilarGroupCount}
      />
    </div>
  );
}

/** R8 Task 5:检查器分层——默认层四段永远展开,五个折叠段用原生 details/summary
 * 逐段记忆。选中空槽位时默认层换成缺口三件套,折叠层整体隐藏(规格 §4)。
 * `WorkspaceShell` 的 `<section aria-label="检查器">` 已经是 landmark,这里不重复包一层。
 */
export function Inspector(): JSX.Element {
  const { selection, selectedClip } = useSelection();
  const pinned = useWorkspace((state) => state.inspectorPinned);
  const meta =
    selection === null ? "未选择" : selection.kind === "slot" ? "空槽位" : selectedClip?.file_name ?? "载入中";
  // 栏标题条右侧仍报文件名(冒烟脚本按它对账);头部那一行才有缩略图与上一条 / 下一条。
  // R19 V-04:标题条右端两颗 —— 📌「钉住检查器」(偏好,常驻)与「收起检查器」(会话态;⌘2 / Esc 同义)。

  return (
    <div className="inspector">
      <PaneHead
        title="检查器"
        meta={meta}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              className="inspector-pin"
              aria-label="钉住检查器"
              aria-pressed={pinned}
              title={pinned ? "已钉住:常驻右侧,Esc 不收(再点取消)" : "钉住检查器:常驻右侧,不随 Esc 收起"}
              onClick={() => dispatchWorkspace({ type: "set-inspector-pinned", pinned: !pinned })}
            >
              {pinned ? "已钉住" : "钉住"}
            </Button>
            <Button
              variant="icon"
              icon="x"
              aria-label="收起检查器"
              title="收起检查器 Esc / ⌘2"
              onClick={() => dispatchWorkspace({ type: "toggle-pane", pane: "inspector" })}
            />
          </>
        }
      />
      {selection === null ? (
        <EmptyInspectorNote />
      ) : selection.kind === "slot" ? (
        <GapInspector chapterId={selection.chapterId} slot={selection.slot} />
      ) : (
        <ClipInspector clipId={selection.clipId} />
      )}
    </div>
  );
}
