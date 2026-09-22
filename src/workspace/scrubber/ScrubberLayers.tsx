import { memo, type ReactNode } from "react";
import { ratioAt, tickStep, type Range } from "./model";
export const ScrubberLayers = memo(function ScrubberLayers({ range, width, duration, peaks, heat }: {
  range: Range; width: number; duration: number; peaks: readonly number[]; heat?: ReactNode;
}) {
  const step = tickStep(range[1] - range[0], width), minor = step / 5;
  const ticks = [];
  // Long clips retain the specified 60s major scale, while skipping offscreen-density ticks.
  const stride = Math.max(1, Math.ceil((range[1] - range[0]) / minor / 500));
  for (let index = Math.ceil(range[0] / minor); index * minor <= range[1] && ticks.length < 501; index += stride) {
    const seconds = index * minor, major = index % 5 === 0;
    ticks.push(<span key={index} className={major ? "major" : "minor"} style={{ left: `${ratioAt(seconds, range) * 100}%` }}>
      {major ? `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}` : null}
    </span>);
  }
  const span = range[1] - range[0] || 1;
  return <>
    <span className="scrubber-r22-ticks" aria-hidden="true">{ticks}</span>
    <span className="scrubber-r22-media">
      <span className="scrubber-r22-source" style={{ width: `${duration / span * 100}%`, left: `${-range[0] / span * 100}%` }}>
        <svg className="scrubber-r22-wave" viewBox="0 0 1000 30" preserveAspectRatio="none">
          {peaks.map((p, i) => <rect key={i} x={i / peaks.length * 1000} y={15 - p * 14} width={Math.max(1, 1000 / peaks.length - 1)} height={Math.max(1, p * 28)} />)}
        </svg>
        {heat}
      </span>
    </span>
  </>;
});
