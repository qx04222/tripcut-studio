import { useEffect, useRef, useState } from "react";
import { frameAt, getClipArtifacts } from "../../api";
import { PreviewCache, PreviewScheduler } from "./preview";
export function useScrubberMedia(clipId: number | null) {
  const [peaks, setPeaks] = useState<readonly number[]>([]);
  const [preview, setPreview] = useState<{ seconds: number; url: string | null | undefined } | null>(null);
  const scheduler = useRef<PreviewScheduler | null>(null);
  if (!scheduler.current) scheduler.current = new PreviewScheduler(new PreviewCache(frameAt), (seconds, url) => setPreview({ seconds, url }));
  useEffect(() => {
    const abort = new AbortController(); setPeaks([]); setPreview(null);
    scheduler.current!.cancel();
    if (clipId !== null) void (async () => {
      try {
        const artifacts = await getClipArtifacts(clipId);
        if (!artifacts?.waveform || abort.signal.aborted) return;
        const response = await fetch(artifacts.waveform, { signal: abort.signal });
        if (!response.ok) return;
        const data = await response.json() as { peaks?: unknown };
        if (!Array.isArray(data.peaks) || abort.signal.aborted) return;
        const values = data.peaks.map((pair: unknown) => Array.isArray(pair) ? Math.min(1, Math.max(...pair.map(v => typeof v === "number" && Number.isFinite(v) ? Math.abs(v) : 0))) : 0);
        // Downsample once, outside pointer handlers; SVG stays bounded to 240 bars.
        const stride = Math.max(1, Math.ceil(values.length / 240));
        const bars = Array.from({ length: Math.ceil(values.length / stride) }, (_, i) => Math.max(...values.slice(i * stride, (i + 1) * stride)));
        // 按素材自己的最大峰值归一化:安静素材(峰值 ±0.03)按绝对幅度画只有 1px,轨道看着是空的。
        const loudest = Math.max(0, ...bars);
        setPeaks(loudest > 0 ? bars.map(v => v / loudest) : bars);
      } catch { /* Missing/offline waveform leaves the track usable. */ }
    })();
    return () => { abort.abort(); scheduler.current!.cancel(); };
  }, [clipId]);
  return { peaks, preview, request: (seconds: number) => { if (clipId !== null) scheduler.current!.request(clipId, seconds); },
    hide: () => { scheduler.current!.cancel(); setPreview(null); } };
}
