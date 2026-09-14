import type { JSX } from "react";

import type { EpisodeSummary, StoryTemplate } from "../api";
import { PLATFORM_LABELS } from "../EpisodePanel";
import { PIPELINE_STEP_NAMES, PIPELINE_STEPS } from "./pipelineModel";
import type { HomeTemplate, StepDone } from "./homeModel";
import { Button, Card, CoverImage, Icon } from "./ui";

/** 集卡上的四个小格:①②③④ 各一格,完成的填色。AX 名「第 n 步 已完成 / 未完成」。 */
export function StepDots({ done }: { done: StepDone }): JSX.Element {
  return (
    <span className="home-steps" role="img" aria-label={`四步进度:${done.filter(Boolean).length}/4`}>
      {PIPELINE_STEPS.map((step, index) => (
        <span key={step} className="home-step" data-step-done={done[index] ? "true" : "false"} title={`${PIPELINE_STEP_NAMES[step]}${done[index] ? " 已完成" : ""}`}>
          {done[index] ? <Icon name="check" size={12} /> : <span className="home-step-index">{step}</span>}
        </span>
      ))}
    </span>
  );
}

export interface EpisodeCardProps {
  episode: EpisodeSummary;
  done: StepDone;
  /** 进行中的集用它的第一条素材封面;封存的集没有封面源,画大号集号。 */
  coverUrl: string | null;
  onOpen(episode: EpisodeSummary): void;
  /** R15:卡片右上角「···」(AX 名「集操作 · <标题>」),点了把菜单开在哪。不传就没有这个按钮。 */
  onMore?(episode: EpisodeSummary, anchor: { x: number; y: number }): void;
}

export function EpisodeCard({ episode, done, coverUrl, onOpen, onMore }: EpisodeCardProps): JSX.Element {
  const active = episode.status === "active";
  const numeral = episode.episode_number === null ? "—" : String(episode.episode_number).padStart(2, "0");
  return (
    <li className="home-episode">
      {/* 卡片本身是个 button,「···」不能嵌在里面(button 里不能再放 button),放成兄弟绝对定位到右上角。 */}
      {onMore ? (
        <Button
          variant="icon"
          size="sm"
          icon="more"
          className="home-episode-more"
          aria-label={`集操作 · ${episode.title}`}
          aria-haspopup="menu"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onMore(episode, { x: rect.left, y: rect.bottom + 4 });
          }}
        />
      ) : null}
      <Card as="button" interactive className="home-episode-card" onClick={() => onOpen(episode)}>
        <span className="home-episode-cover" aria-hidden="true">
          {coverUrl ? <CoverImage src={coverUrl} crossOrigin="anonymous" className="home-episode-image" /> : <span className="home-episode-numeral">{numeral}</span>}
          <span className={active ? "home-episode-state is-active" : "home-episode-state"}>{active ? "进行中" : "已封存"}</span>
        </span>
        <span className="home-episode-body">
          <strong className="home-episode-title">{episode.title}</strong>
          <span className="home-episode-meta">
            {`${PLATFORM_LABELS[episode.target_platform]} · ${episode.clip_count} 条素材`}
          </span>
          <StepDots done={done} />
        </span>
      </Card>
    </li>
  );
}

/** 三个模板各一枚自己画的小图(不抄剪映资源):日记 = 横线本,电影感 = 遮幅,快节奏 = 速度线。 */
function TemplateMotif({ id }: { id: StoryTemplate }): JSX.Element {
  if (id === "diary") {
    return (
      <svg viewBox="0 0 64 40" className="home-template-motif" aria-hidden="true">
        <rect x="6" y="4" width="52" height="32" rx="3" />
        <line x1="14" y1="13" x2="50" y2="13" />
        <line x1="14" y1="20" x2="42" y2="20" />
        <line x1="14" y1="27" x2="46" y2="27" />
        <circle cx="12" cy="9" r="1.2" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (id === "cinematic") {
    return (
      <svg viewBox="0 0 64 40" className="home-template-motif" aria-hidden="true">
        <rect x="4" y="4" width="56" height="32" rx="2" />
        <rect x="4" y="4" width="56" height="7" fill="currentColor" stroke="none" opacity="0.85" />
        <rect x="4" y="29" width="56" height="7" fill="currentColor" stroke="none" opacity="0.85" />
        <path d="M18 24c4-6 10-6 14 0s10 6 14 0" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 64 40" className="home-template-motif" aria-hidden="true">
      <rect x="10" y="8" width="14" height="24" rx="2" />
      <rect x="27" y="8" width="10" height="24" rx="2" />
      <rect x="40" y="8" width="6" height="24" rx="2" />
      <rect x="49" y="8" width="4" height="24" rx="2" />
      <line x1="4" y1="20" x2="8" y2="20" />
      <line x1="56" y1="14" x2="60" y2="14" />
      <line x1="56" y1="26" x2="60" y2="26" />
    </svg>
  );
}

export interface TemplateCardProps {
  template: HomeTemplate;
  disabled?: boolean;
  onPick(template: HomeTemplate): void;
}

export function TemplateCard({ template, disabled = false, onPick }: TemplateCardProps): JSX.Element {
  return (
    <Card as="button" interactive className={`home-template-card home-template-card--${template.id}`} disabled={disabled} onClick={() => onPick(template)}>
      <TemplateMotif id={template.id} />
      <strong className="home-template-title">{template.label}</strong>
      <span className="home-template-blurb">{template.blurb}</span>
    </Card>
  );
}
