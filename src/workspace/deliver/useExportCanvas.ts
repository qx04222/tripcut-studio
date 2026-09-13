import { useEffect, useState } from "react";
import { previewExportCanvas, type CanvasOrientationSource, type ExportCanvas, type TargetPlatform } from "../../api";

export type ExportOrientation = "portrait" | "landscape";

/** 画布方向来源的中文短名(抽屉副标题「画布 W×H · 来源」)。 */
export const CANVAS_SOURCE_LABELS: Record<CanvasOrientationSource, string> = {
  override: "本次手动",
  episode: "本集设置",
  preset: "平台习惯",
  clips: "素材多数",
  fallback: "默认横版",
};

function isExportCanvas(value: unknown): value is ExportCanvas {
  if (!value || typeof value !== "object") return false;
  const { width, height, orientation } = value as Partial<ExportCanvas>;
  return typeof width === "number" && width > 0 && typeof height === "number" && height > 0 && typeof orientation === "string";
}

/**
 * R10 U-05:抽屉里「将要用的画布」——每次平台 / 手动方向变化都向后端重算一次
 * (`previewExportCanvas`,不建任务),换集也重算。后端读不到 / 旧桩回空时为 null,
 * 调用方回落到 `readCanvas(status, preset)` 的旧路径。
 */
export function useExportCanvas(
  overridePlatform: TargetPlatform | null,
  overrideOrientation: ExportOrientation | null,
): ExportCanvas | null {
  const [canvas, setCanvas] = useState<ExportCanvas | null>(null);
  const [episodeTick, setEpisodeTick] = useState(0);

  useEffect(() => {
    const onEpisodeChanged = () => setEpisodeTick((tick) => tick + 1);
    window.addEventListener("tripcut:episode-changed", onEpisodeChanged);
    return () => window.removeEventListener("tripcut:episode-changed", onEpisodeChanged);
  }, []);

  useEffect(() => {
    let alive = true;
    void previewExportCanvas(overridePlatform, overrideOrientation)
      .then((next) => {
        if (alive) setCanvas(isExportCanvas(next) ? next : null);
      })
      .catch(() => {
        if (alive) setCanvas(null);
      });
    return () => {
      alive = false;
    };
  }, [episodeTick, overrideOrientation, overridePlatform]);

  return canvas;
}
