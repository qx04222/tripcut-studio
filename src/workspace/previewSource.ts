import type { PlayerStatus, PreviewQuality } from "../api";

export function sourceBadgeLabel(status: PlayerStatus | null): string | null {
  if (!status?.source_kind) return null;
  const prefix = status.source_kind === "original" ? "原片" : "代理";
  const edge = Math.min(status.source_width ?? 0, status.source_height ?? 0);
  return edge > 0 ? `${prefix} ${edge}p` : prefix;
}
/** R28:角标后缀。标准机自动档一直原片,不再写「暂停看原片」;掉帧退代理时如实说明。 */
export function autoPolicySuffix(status: PlayerStatus | null): string {
  if (status?.preview_quality !== "auto") return "";
  const policy = status.auto_policy;
  if (policy !== "proxy" && policy !== "degraded") return "";
  if (status.source_kind === "original") return status.paused ? " · 暂停看原片" : "";
  return policy === "degraded" ? " · 原片掉帧,改播代理" : "";
}
export function qualityLabel(quality: PreviewQuality | string | null | undefined): string {
  const labels: Record<string, string> = { auto: "自动", high: "高画质", original: "原片", performance: "性能优先" };
  return labels[quality ?? "auto"] ?? "自动";
}

/** 帧号与累计掉帧按差值计数；时钟可注入，窗口永远只含最近三秒。 */
export function createDropMonitor(now: () => number = () => performance.now()) {
  let samples: { time: number; frame: number; dropped: number }[] = [];
  let source: string | null | undefined;
  return {
    feed(frame: number | null, dropped: number | null | undefined, paused: boolean, kind: string | null | undefined): { struggling: boolean } {
      const time = now();
      const previous = samples.at(-1);
      if (paused || !kind || kind === "proxy" || frame === null || dropped == null) {
        samples = []; source = kind; return { struggling: false };
      }
      if (source !== kind || (previous && (frame < previous.frame || dropped < previous.dropped))) samples = [];
      source = kind;
      samples.push({ time, frame, dropped });
      samples = samples.filter((sample) => time - sample.time <= 3000);
      const first = samples[0];
      const played = frame - first.frame;
      const lost = dropped - first.dropped;
      return { struggling: played > 0 && lost >= 10 && lost / played > 0.05 };
    },
  };
}
