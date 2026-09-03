import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AnalysisBadges, AnalysisPanel } from "./AnalysisPanel";
import type { ClipListItem } from "./api";

const analyzedClip: ClipListItem = {
  id: 7,
  episode_id: 1,
    folder_label: null,
  cover_url: null,
  path: "/Volumes/CARD/clip.mov",
  file_name: "clip.mov",
  byte_size: 1024,
  quick_hash: "quick",
  full_hash: null,
  tb_num: 1,
  tb_den: 1000,
  duration_ticks: 2000,
  fps_num: 25,
  fps_den: 1,
  is_vfr: false,
  codec: "h264",
  width: 1920,
  height: 1080,
  captured_at: null,
  status: "ready",
  error: null,
  analysis_status: "done",
  analysis_error: null,
  motion_status: "done",
  motion_error: null,
  binary_rating: null,
  star_rating: null,
  select_count: 0,
  analysis: {
    clip_id: 7,
    exposure_yavg: 22.5,
    overexposed_ratio: 0.2,
    underexposed_ratio: 0.3,
    dynamic_range: 118.5,
    blur_mean: 11.25,
    entropy_mean: 5.75,
    motion_mean: 8.5,
    out_of_focus_ratio: 0.4,
    audio_peak_db: -0.05,
    audio_clipped: true,
    has_audio: false,
    focus_scores: [21.25, 30.5, 42.75],
    scene_count: 3,
    analyzed_at: "2026-08-31T12:00:00Z",
    tool_versions: { pipeline: "analyze_l1/v1" },
  },
  motion: {
    clip_id: 7,
    class: "handheld",
    pan_ratio: 0.21,
    tilt_ratio: 0.18,
    zoom_corr: -0.12,
    shake_score: 2.75,
    is_shaky: true,
    sample_pairs: 59,
    tool_version: "analyze_motion/v1",
  },
};

describe("L1 analysis presentation", () => {
  it("renders threshold-derived badges and every raw numeric value", () => {
    const badges = renderToStaticMarkup(<AnalysisBadges clip={analyzedClip} />);
    const panel = renderToStaticMarkup(
      <AnalysisPanel clip={analyzedClip} onClose={() => undefined} />,
    );

    for (const label of [
      "过暗",
      "过曝",
      "欠曝",
      "削波",
      "静音",
      "疑似失焦",
      "虚焦",
      "手持抖动",
    ]) {
      expect(badges).toContain(label);
    }
    for (const value of [
      "22.50 / 255",
      "20.00%",
      "30.00%",
      "40.00%",
      "118.50",
      "11.25",
      "5.75",
      "8.50",
      "-0.05 dBFS",
      "21.25",
      "30.50",
      "42.75",
    ]) {
      expect(panel).toContain(value);
    }
    expect(panel).toContain("场景片段");
    expect(panel).toContain("3");
    expect(panel).toContain("手持 / Handheld");
    for (const value of ["0.21", "0.18", "-0.12", "2.75", "59"]) {
      expect(panel).toContain(value);
    }
  });

  it("renders the unanalyzed badge and failure evidence", () => {
    const failedClip: ClipListItem = {
      ...analyzedClip,
      analysis: null,
      analysis_status: "blocked",
      analysis_error: "ffmpeg exited with code 1",
    };
    const badges = renderToStaticMarkup(<AnalysisBadges clip={failedClip} />);
    const panel = renderToStaticMarkup(
      <AnalysisPanel clip={failedClip} onClose={() => undefined} />,
    );

    expect(badges).toContain("无法分析");
    expect(panel).toContain("ffmpeg exited with code 1");
  });

  it("uses the backend threshold decision instead of a frontend constant", () => {
    const belowConfiguredThreshold: ClipListItem = {
      ...analyzedClip,
      motion: analyzedClip.motion
        ? { ...analyzedClip.motion, shake_score: 9.5, is_shaky: false }
        : null,
    };

    const badges = renderToStaticMarkup(
      <AnalysisBadges clip={belowConfiguredThreshold} />,
    );

    expect(badges).not.toContain("手持抖动");
  });
});
