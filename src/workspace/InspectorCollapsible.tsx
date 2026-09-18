import { useState, type JSX } from "react";

import { AnalysisBadges } from "../AnalysisPanel";
import type { AiDescriptionResult, ClipDimension, ClipListItem } from "../api";
import { SimilarGroupsPanel } from "../SimilarGroupsPanel";
import { TechCheckPanel } from "../TechCheckPanel";
import { INSPECTOR_SECTIONS, isQuietSection, sectionStatusText, type InspectorSectionId, type InspectorStatusContext } from "./Inspector";
import { AiDescriptionSection } from "./inspectorFields";
import { InspectorRetryAnalysis } from "./InspectorRetryAnalysis";
import { CollapsibleSection, DimensionsGrid } from "./InspectorSections";
import { openSettings } from "./openSettings";
import { useShowAllFeatures } from "./showAllFeatures";
import { Icon, type IconName } from "./ui";
import { INSPECTOR_TITLES } from "./copy";

function sectionIcon(id: InspectorSectionId): IconName {
  return INSPECTOR_SECTIONS.find((section) => section.id === id)?.icon ?? "info";
}

export interface InspectorCollapsibleSectionsProps {
  clip: ClipListItem;
  ctx: InspectorStatusContext;
  clipDimensions: readonly ClipDimension[];
  clipsById: ReadonlyMap<number, ClipListItem>;
  aiDescription: AiDescriptionResult | null;
  llmEnabled: boolean;
  llmBudgetExhausted: boolean;
  aiBusy: boolean;
  onDescribe(): void;
  onTimeStageChange(label: string): void;
  onAudioCount(count: number): void;
  onSimilarCount(count: number): void;
}

/**
 * 检查器的五个折叠段(R11 简化专项 #4,从 `Inspector.tsx` 分出来守 400 行):状态字是
 * 「待判定 / 未探测 / 暂无数据 / 无」的段收进一个「更多信息」折叠,有内容的段照旧摆在外面 ——
 * 版面只留有东西可看的行。段仍是同一批 `<details>`,开合记忆不受影响。
 */
/** R19 P-05:「显示全部功能」关时藏 技术检查 / 画面评分(八维)/ 声音与调色(多音轨 + LUT);AI 描述与相似镜头照旧。 */
export const INSPECTOR_SECTIONS_ADVANCED: ReadonlySet<InspectorSectionId> = new Set(["techcheck", "dimensions", "audio"]);

export function InspectorCollapsibleSections(props: InspectorCollapsibleSectionsProps): JSX.Element {
  const { clip, ctx, clipDimensions, clipsById, aiDescription, llmEnabled, llmBudgetExhausted, aiBusy } = props;
  const showAll = useShowAllFeatures();
  const allSections: { id: InspectorSectionId; title: string; node: JSX.Element }[] = [
    {
      id: "techcheck",
      title: "技术检查",
      node: (
        <CollapsibleSection key="techcheck" id="techcheck" icon={sectionIcon("techcheck")} title="技术检查" status={sectionStatusText("techcheck", ctx)}>
          <>
            <AnalysisBadges clip={clip} compact />
            {/* R16 P2-4:分析卡在「失败」时这里能重跑。 */}
            <InspectorRetryAnalysis clip={clip} />
            <div className="inspector-techcheck-scope">
              <TechCheckPanel clip={clip} readOnly={false} hideTitle />
            </div>
          </>
        </CollapsibleSection>
      ),
    },
    {
      id: "dimensions",
      title: INSPECTOR_TITLES.dimensions,
      node: (
        <CollapsibleSection key="dimensions" id="dimensions" icon={sectionIcon("dimensions")} title={INSPECTOR_TITLES.dimensions} status={sectionStatusText("dimensions", ctx)}>
          <DimensionsGrid dimensions={clipDimensions} onTimeStageChange={props.onTimeStageChange} />
        </CollapsibleSection>
      ),
    },
    {
      id: "ai",
      title: "AI 描述",
      node: (
        <CollapsibleSection key="ai" id="ai" icon={sectionIcon("ai")} title="AI 描述" status={sectionStatusText("ai", ctx)}>
          <AiDescriptionSection
            clipId={clip.id ?? undefined}
            aiDescription={aiDescription}
            llmEnabled={llmEnabled}
            llmBudgetExhausted={llmBudgetExhausted}
            aiBusy={aiBusy}
            onDescribe={props.onDescribe}
            onOpenSettings={() => openSettings("analysis")}
          />
        </CollapsibleSection>
      ),
    },
    {
      id: "audio",
      title: INSPECTOR_TITLES.audio,
      node: (
        <CollapsibleSection key="audio" id="audio" icon={sectionIcon("audio")} title={INSPECTOR_TITLES.audio} status={sectionStatusText("audio", ctx)}>
          <div className="inspector-audio-scope">
            <TechCheckPanel clip={clip} readOnly={false} hideTitle onCountChange={props.onAudioCount} />
          </div>
        </CollapsibleSection>
      ),
    },
    {
      id: "similar",
      title: "相似镜头",
      node: (
        <CollapsibleSection key="similar" id="similar" icon={sectionIcon("similar")} title="相似镜头" status={sectionStatusText("similar", ctx)}>
          <SimilarGroupsPanel clipId={clip.id} readOnly={false} clipsById={clipsById} onCountChange={props.onSimilarCount} />
        </CollapsibleSection>
      ),
    },
  ];
  // R19 P-05(flow 车道,一行):关时按开关过滤;DOM 位置仍固定(见下),开关打开原样回来。
  const sections = showAll ? allSections : allSections.filter((section) => !INSPECTOR_SECTIONS_ADVANCED.has(section.id));
  const quiet = sections.filter((section) => isQuietSection(section.id, ctx));
  const [moreOpen, setMoreOpen] = useState(false);
  // 五个 `<details>` 的 DOM 位置永远不变(位置一变 React 就会把面板卸了重挂,TechCheckPanel 的
  // 状态与刚读到的计数全丢);「安静」的段只是换 class 走 CSS `order` 排到「更多信息」行之后,
  // 折叠时 `hidden`。
  return (
    <>
      {sections.map((section) => {
        const isQuiet = quiet.includes(section);
        return (
          <div key={section.id} className={isQuiet ? "inspector-collapsible-slot is-quiet" : "inspector-collapsible-slot"} hidden={isQuiet && !moreOpen}>
            {section.node}
          </div>
        );
      })}
      {quiet.length > 0 ? (
        <div className="inspector-more">
          <button type="button" className="inspector-more-toggle" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}>
            <Icon name="info" className="inspector-section-icon" />
            <span className="inspector-section-title">更多信息</span>
            <small className="inspector-section-status">{`${quiet.length} 项暂无内容`}</small>
            <Icon name="chevron-right" size={12} className={moreOpen ? "inspector-chevron is-open" : "inspector-chevron"} />
          </button>
        </div>
      ) : null}
    </>
  );
}
