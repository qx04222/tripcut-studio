import { useEffect } from "react";
import type { ClipAnalysis, ClipListItem } from "./api";

export const DARK_YAVG_THRESHOLD = 40;
export const OVEREXPOSED_RATIO_THRESHOLD = 0.15;
export const SOFT_FOCUS_THRESHOLD = 60;

export type AnalysisBadgeKind =
  | "dark"
  | "overexposed"
  | "underexposed"
  | "clipped"
  | "silent"
  | "soft_focus"
  | "out_of_focus"
  | "handheld_shake"
  | "unanalyzed";

const BADGE_LABELS: Record<AnalysisBadgeKind, string> = {
  dark: "过暗",
  overexposed: "过曝",
  underexposed: "欠曝",
  clipped: "削波",
  silent: "静音",
  soft_focus: "疑似失焦",
  out_of_focus: "虚焦",
  handheld_shake: "手持抖动",
  unanalyzed: "无法分析",
};

const MOTION_CLASS_LABELS: Record<string, string> = {
  pan: "横摇 / Pan",
  tilt: "俯仰 / Tilt",
  zoom: "变焦 / Zoom",
  handheld: "手持 / Handheld",
  static: "静止 / Static",
};

function focusMean(analysis: ClipAnalysis): number | null {
  if (analysis.focus_scores.length === 0) return null;
  return (
    analysis.focus_scores.reduce((sum, score) => sum + score, 0) /
    analysis.focus_scores.length
  );
}

export function analysisBadgeKinds(clip: ClipListItem): AnalysisBadgeKind[] {
  if (clip.analysis_status === "failed" || clip.analysis_status === "blocked") {
    return ["unanalyzed"];
  }
  if (!clip.analysis) return [];

  const badges: AnalysisBadgeKind[] = [];
  if (clip.analysis.exposure_yavg < DARK_YAVG_THRESHOLD) badges.push("dark");
  if (clip.analysis.overexposed_ratio > OVEREXPOSED_RATIO_THRESHOLD) {
    badges.push("overexposed");
  }
  if (clip.analysis.underexposed_ratio > OVEREXPOSED_RATIO_THRESHOLD) {
    badges.push("underexposed");
  }
  if (clip.analysis.out_of_focus_ratio > OVEREXPOSED_RATIO_THRESHOLD) {
    badges.push("out_of_focus");
  }
  if (clip.analysis.audio_clipped) badges.push("clipped");
  if (!clip.analysis.has_audio) badges.push("silent");
  const mean = focusMean(clip.analysis);
  if (mean !== null && mean < SOFT_FOCUS_THRESHOLD) badges.push("soft_focus");
  if (clip.motion?.is_shaky) {
    badges.push("handheld_shake");
  }
  return badges;
}

export function motionClassLabel(value: string): string {
  return MOTION_CLASS_LABELS[value] ?? value;
}

export function AnalysisBadges({ clip, compact = false }: { clip: ClipListItem; compact?: boolean }) {
  const badges = analysisBadgeKinds(clip);
  if (badges.length === 0) {
    if (clip.analysis_status === "pending" || clip.analysis_status === "running") {
      return <span className="analysis-pending">分析中</span>;
    }
    return <span className="analysis-pending">—</span>;
  }

  const priority: AnalysisBadgeKind[] = ["unanalyzed", "clipped", "out_of_focus", "overexposed", "underexposed", "dark", "soft_focus", "handheld_shake", "silent"];
  const ordered = compact ? [...badges].sort((a, b) => priority.indexOf(a) - priority.indexOf(b)) : badges;
  const summary = ordered.map((kind) => BADGE_LABELS[kind]).join("、");
  return (
    <span className="analysis-badges" aria-label={`质量分析角标：${summary}`} title={summary}>
      {(compact ? ordered.slice(0, 2) : ordered).map((kind) => (
        <span className={`analysis-badge ${kind}`} key={kind}>
          {BADGE_LABELS[kind]}
        </span>
      ))}
      {compact && badges.length > 2 ? (
        <span className="analysis-badge analysis-more" title={ordered.slice(2).map((kind) => BADGE_LABELS[kind]).join("、")} aria-label={`另有 ${badges.length - 2} 项：${ordered.slice(2).map((kind) => BADGE_LABELS[kind]).join("、")}`}>
          +{badges.length - 2}
        </span>
      ) : null}
    </span>
  );
}

function formatScore(value: number | null, suffix = ""): string {
  return value === null || !Number.isFinite(value) ? "—" : `${value.toFixed(2)}${suffix}`;
}

function pipelineName(analysis: ClipAnalysis): string {
  const value = analysis.tool_versions.pipeline;
  return typeof value === "string" ? value : "analyze_l1";
}

export function AnalysisPanel({ clip, onClose }: { clip: ClipListItem; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const failed = clip.analysis_status === "failed" || clip.analysis_status === "blocked";
  const analysis = clip.analysis;

  return (
    <aside className="analysis-panel" aria-label={`${clip.file_name} 分析数值`}>
      <div className="analysis-panel-heading">
        <div>
          <span>L1 / 原始证据</span>
          <strong>{clip.file_name}</strong>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭分析面板">
          ×
        </button>
      </div>

      {failed ? (
        <div className="analysis-panel-state danger">
          <strong>无法分析</strong>
          <span>{clip.analysis_error ?? "ffmpeg 未返回可解析的完整结果"}</span>
        </div>
      ) : analysis ? (
        <>
          <div className="analysis-metrics">
            <Metric label="曝光平均 Y" value={`${formatScore(analysis.exposure_yavg)} / 255`} />
            <Metric
              label="过曝采样帧"
              value={formatScore(analysis.overexposed_ratio * 100, "%")}
            />
            <Metric
              label="欠曝采样帧"
              value={formatScore(analysis.underexposed_ratio * 100, "%")}
            />
            <Metric label="动态范围" value={formatScore(analysis.dynamic_range)} />
            <Metric label="模糊度均值" value={formatScore(
              (analysis.tool_versions.signals as { blur_valid_samples?: number } | undefined)?.blur_valid_samples === 0
                ? null : analysis.blur_mean,
            )} />
            <Metric label="纹理熵均值" value={formatScore(analysis.entropy_mean)} />
            <Metric label="运动能量均值" value={formatScore(analysis.motion_mean)} />
            <Metric
              label="虚焦采样帧"
              value={formatScore(analysis.out_of_focus_ratio * 100, "%")}
            />
            <Metric label="音频峰值" value={formatScore(analysis.audio_peak_db, " dBFS")} />
            <Metric label="音频削波" value={analysis.audio_clipped ? "是" : "否"} />
            <Metric label="音轨" value={analysis.has_audio ? "有" : "无"} />
            <Metric label="场景片段" value={`${analysis.scene_count}`} />
            {analysis.focus_scores.map((score, index) => (
              <Metric
                label={`失焦分 · ${["10%", "50%", "90%"][index] ?? index + 1}`}
                value={formatScore(score)}
                key={`${index}-${score}`}
              />
            ))}
            <Metric label="失焦分均值" value={formatScore(focusMean(analysis))} />
            {clip.motion ? (
              <>
                <Metric label="运镜分类" value={motionClassLabel(clip.motion.class)} />
                <Metric label="横摇同向比" value={formatScore(clip.motion.pan_ratio)} />
                <Metric label="俯仰同向比" value={formatScore(clip.motion.tilt_ratio)} />
                <Metric label="缩放径向相关" value={formatScore(clip.motion.zoom_corr)} />
                <Metric label="抖动分" value={formatScore(clip.motion.shake_score)} />
                <Metric label="运镜采样帧对" value={`${clip.motion.sample_pairs}`} />
              </>
            ) : null}
          </div>
          <div className="analysis-panel-foot">
            <span>{pipelineName(analysis)}</span>
            {clip.motion ? <span>{clip.motion.tool_version}</span> : null}
            <span>{analysis.analyzed_at.replace("T", " ").replace("Z", " UTC")}</span>
          </div>
          {clip.motion_status === "failed" || clip.motion_status === "blocked" ? (
            <div className="analysis-panel-state danger">
              <strong>运镜分析失败</strong>
              <span>{clip.motion_error ?? "ffmpeg 未返回可用的灰度采样帧"}</span>
            </div>
          ) : null}
        </>
      ) : (
        <div className="analysis-panel-state">
          <strong>等待 L1 分析</strong>
          <span>完成后将在这里显示曝光、音频、失焦与场景原始值。</span>
        </div>
      )}
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="analysis-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
