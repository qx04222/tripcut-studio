import type { PlayerStatus, PreviewQuality } from "../api";

export function sourceBadgeLabel(status: PlayerStatus | null): string | null {
  if (!status?.source_kind) return null;
  const prefix = status.source_kind === "original" ? "原片" : "代理";
  const edge = Math.min(status.source_width ?? 0, status.source_height ?? 0);
  return edge > 0 ? `${prefix} ${edge}p` : prefix;
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
