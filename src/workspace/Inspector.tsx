import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";

import { AnalysisBadges } from "../AnalysisPanel";
import {
  clearClipRating,
  describeClipWithAi,
  getAiDescription,
  getLlmStatus,
  getSettings,
  rateClip,
  setClipTimeStage,
  applyNarrativeOp,
  type AiDescriptionResult,
} from "../api";
import { SimilarGroupsPanel } from "../SimilarGroupsPanel";
import { TechCheckPanel } from "../TechCheckPanel";
import {
  ChapterSlotSection,
  EmptyInspectorNote,
  RatingControls,
  TagsSection,
  TakeSwitcher,
  AiDescriptionSection,
} from "./inspectorFields";
import { InspectorHeader } from "./InspectorHeader";
import { CollapsibleSection, DimensionsGrid, GapInspector } from "./InspectorSections";
import { PaneHead } from "./PaneHead";
import {
  chapterSlotOptions,
  findClipPlacement,
  narrativeChapterOptions,
  techCheckIssueCount,
  visibleDefaultSections,
  type DefaultSectionId,
} from "./inspectorModel";
import { Card, Icon, SectionHeader, type IconName } from "./ui";
import { planBandReorder, useBandDrag } from "./useBandDrag";
import { refreshClipsFeed, useClipsFeed } from "./useClipsFeed";
import { useSelection } from "./useSelection";

export type InspectorSectionId = "techcheck" | "dimensions" | "ai" | "audio" | "similar";

export const INSPECTOR_SECTIONS: readonly { id: InspectorSectionId; title: string; icon: IconName }[] = [
  { id: "techcheck", title: "技术检查", icon: "check" },
  { id: "dimensions", title: "八维评分", icon: "settings-analysis" },
  { id: "ai", title: "AI 描述", icon: "settings-generation" },
  { id: "audio", title: "音轨与 LUT", icon: "volume" },
  { id: "similar", title: "相似镜头", icon: "search" },
];

/** 默认层四张卡的标题与图标(套件里没有 tag / copy 图标,标签用 search、Take 用 settings-cache 代)。 */
const DEFAULT_SECTION_META: Record<DefaultSectionId, { title: string; icon: IconName }> = {
  rating: { title: "评级与收藏", icon: "star" },
  tags: { title: "标签", icon: "search" },
  chapter: { title: "所属章节 / 槽位", icon: "settings-timeline" },
  takes: { title: "同镜头 Take 切换", icon: "settings-cache" },
};

function sectionIcon(id: InspectorSectionId): IconName {
  return INSPECTOR_SECTIONS.find((section) => section.id === id)?.icon ?? "info";
}

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
      return ctx.similarGroupCount > 0 ? `${ctx.similarGroupCount} 组` : "无";
  }
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
  const [audioTrackCount, setAudioTrackCount] = useState<number | null>(null);
  const [similarGroupCount, setSimilarGroupCount] = useState<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setAudioTrackCount(null);
    setSimilarGroupCount(null);
  }, [clipId]);

  useEffect(() => {
    setAiDescription(null);
    getAiDescription(clipId)
      .then((result) => {
        if (mounted.current) setAiDescription(result);
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
        .then(() => refreshClipsFeed(true))
        .catch(() => undefined);
    },
    [placement],
  );

  const slots = useMemo(() => chapterSlotOptions(feed.storyboard, clipId), [feed.storyboard, clipId]);
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
    tagCount: aiDescription?.tags.length ?? 0,
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
        <DefaultSectionCard id="tags" meta={`${aiDescription?.tags.length ?? 0} 个`}>
          <TagsSection aiDescription={aiDescription} />
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
          />
          {slotDrag.notice ? (
            <p className="inspector-notice" role="status">
              {slotDrag.notice}
            </p>
          ) : null}
        </DefaultSectionCard>
      ) : null}
      {sections.includes("takes") && stack ? (
        <DefaultSectionCard id="takes" meta={`${stack.members.length} 条`}>
          <TakeSwitcher stack={stack} clipsById={feed.clipsById} selectedClipId={clipId} onSelect={selectClip} />
        </DefaultSectionCard>
      ) : null}

      <CollapsibleSection id="techcheck" icon={sectionIcon("techcheck")} title="技术检查" status={sectionStatusText("techcheck", ctx)}>
        <>
          <AnalysisBadges clip={clip} compact />
          <div className="inspector-techcheck-scope">
            <TechCheckPanel clip={clip} readOnly={false} hideTitle />
          </div>
        </>
      </CollapsibleSection>
      <CollapsibleSection id="dimensions" icon={sectionIcon("dimensions")} title="八维评分" status={sectionStatusText("dimensions", ctx)}>
        <DimensionsGrid dimensions={clipDimensions} onTimeStageChange={onTimeStageChange} />
      </CollapsibleSection>
      <CollapsibleSection id="ai" icon={sectionIcon("ai")} title="AI 描述" status={sectionStatusText("ai", ctx)}>
        <AiDescriptionSection
          aiDescription={aiDescription}
          llmEnabled={llmEnabled}
          llmBudgetExhausted={llmBudgetExhausted}
          aiBusy={aiBusy}
          onDescribe={onDescribe}
        />
      </CollapsibleSection>
      <CollapsibleSection id="audio" icon={sectionIcon("audio")} title="音轨与 LUT" status={sectionStatusText("audio", ctx)}>
        <div className="inspector-audio-scope">
          <TechCheckPanel clip={clip} readOnly={false} hideTitle onCountChange={setAudioTrackCount} />
        </div>
      </CollapsibleSection>
      <CollapsibleSection id="similar" icon={sectionIcon("similar")} title="相似镜头" status={sectionStatusText("similar", ctx)}>
        <SimilarGroupsPanel
          clipId={clip.id}
          readOnly={false}
          clipsById={feed.clipsById}
          onCountChange={setSimilarGroupCount}
        />
      </CollapsibleSection>
    </div>
  );
}

/** R8 Task 5:检查器分层——默认层四段永远展开,五个折叠段用原生 details/summary
 * 逐段记忆。选中空槽位时默认层换成缺口三件套,折叠层整体隐藏(规格 §4)。
 * `WorkspaceShell` 的 `<section aria-label="检查器">` 已经是 landmark,这里不重复包一层。
 */
export function Inspector(): JSX.Element {
  const { selection, selectedClip } = useSelection();
  const meta =
    selection === null ? "未选择" : selection.kind === "slot" ? "空槽位" : selectedClip?.file_name ?? "载入中";
  // 栏标题条右侧仍报文件名(冒烟脚本按它对账);头部那一行才有缩略图与上一条 / 下一条。

  return (
    <div className="inspector">
      <PaneHead title="检查器" meta={meta} />
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
