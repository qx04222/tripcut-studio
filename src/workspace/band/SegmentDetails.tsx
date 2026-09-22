import { createContext, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { listSelectSegments, type ClipListItem } from "../../api";
import type { BandSegment } from "../shotBandModel";

interface Details { enabled: boolean; clips: ReadonlyMap<number, ClipListItem>; reasons: ReadonlyMap<number, string> }
const Context = createContext<Details>({ enabled: false, clips: new Map(), reasons: new Map() });
export function BandDetailsProvider({ enabled, clips, segments, episodeId, children }: {
  enabled: boolean; clips: ReadonlyMap<number, ClipListItem>; segments: readonly BandSegment[]; episodeId: number | null; children: ReactNode;
}) {
  const [reasons, setReasons] = useState<ReadonlyMap<number, string>>(new Map());
  const signature = useMemo(() => JSON.stringify(segments.filter(segment => segment.segmentId !== null).map(segment => [segment.clipId, segment.segmentId])), [segments]);
  useEffect(() => {
    let live = true;
    setReasons(new Map());
    if (!enabled) return;
    const ids = [...new Set((JSON.parse(signature) as [number, number][]).map(([id]) => id))], next = new Map<number, string>();
    let cursor = 0;
    const worker = async () => {
      while (live && cursor < ids.length) {
        const id = ids[cursor++]!;
        const selected = await listSelectSegments(id).catch(() => []);
        for (const segment of selected) if (segment.source === "auto" && segment.reasons?.[0]) next.set(segment.id, segment.reasons[0].split(/[，、；\s]/)[0]!);
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker)).then(() => { if (live) setReasons(next); });
    return () => { live = false; };
  }, [enabled, signature, episodeId]);
  const value = useMemo(() => ({ enabled, clips, reasons }), [enabled, clips, reasons]);
  return <Context value={value}>{children}</Context>;
}

const timecode = (ticks: number, segment: BandSegment) => {
  const ms = segment.tbDen > 0 ? ticks * segment.tbNum * 1000 / segment.tbDen : 0;
  return new Date(Math.max(0, ms)).toISOString().slice(11, 23);
};
export function useSegmentDetails(segment: BandSegment) {
  const details = useContext(Context);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; setAnchor(null); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const clip = segment.clipId === null ? null : details.clips.get(segment.clipId);
  const reason = segment.segmentId === null ? null : details.reasons.get(segment.segmentId);
  return {
    handlers: {
      onMouseEnter: (event: MouseEvent<HTMLElement>) => {
        if (segment.kind !== "clip") return;
        const rect = event.currentTarget.getBoundingClientRect();
        timer.current = setTimeout(() => setAnchor({ x: Math.min(rect.left, Math.max(8, window.innerWidth - 320)), y: Math.max(8, rect.top - 56) }), 300);
      },
      onMouseLeave: clear, onPointerDownCapture: clear,
    },
    badges: details.enabled && segment.kind === "clip" ? <span className="band-detail-badges">
      {clip?.star_rating ? <span aria-label={`${clip.star_rating} 星`}>{"★".repeat(Math.max(0, Math.min(5, clip.star_rating)))}</span> : null}
      {clip?.binary_rating === 1 ? <span aria-label="已收藏">♥</span> : null}
      {reason ? <span title={reason}>AI · {reason}</span> : null}
    </span> : null,
    // 注意不能带 .shot-band:portal 到 body 后它会吃到栏根的 workspace-pane 布局,真机上变成一块拖到窗底的白板(F-R22C-07)。
    tooltip: anchor ? createPortal(<div className="band-tooltip-layer" role="tooltip" style={{ left: anchor.x, top: anchor.y }}>
      <strong>{segment.fileName}</strong><span>入 {timecode(segment.inTicks, segment)} · 出 {timecode(segment.outTicks, segment)}</span>
    </div>, document.body) : null,
  };
}
