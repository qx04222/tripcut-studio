import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PlayerStatus } from "../../api";
import { playthroughReadout, type PlaythroughRange } from "../playthrough/model";
import { usePlayerPrefs, writeScrubberView } from "../playerPrefs";
import { clamp, ratioAt, timecode, visibleRange } from "./model";
import { useScrubGesture, type Edge } from "./useScrubGesture";
import { ScrubberLayers } from "./ScrubberLayers";
import { useWheelFrames } from "./useWheelFrames";
import { useScrubberMedia } from "./useScrubberMedia";
export interface ScrubberProps {
  status: PlayerStatus | null; inPoint: number | null; outPoint: number | null;
  fps?: number; onSeek(seconds: number): void | Promise<unknown>; heat?: ReactNode;
  /** R22-B 镜头带连播:当前段在本素材内的 in→out 与第几段;不连播时不传、不画。用户在轨道上的任何 seek 仍走 `onSeek`(连播由走带那头收到人工 seek 后停止)。 */
  playthrough?: PlaythroughRange;
  onPause?(): void | Promise<void>; onResume?(): void | Promise<void>;
  onTrim?(edge: "in" | "out", seconds: number): void;
  onShuttle?(key: "j" | "k" | "l"): void; onMark?(edge: "in" | "out"): void;
}
export function Scrubber({ status, inPoint, outPoint, fps = 30, onSeek, heat, onPause, onResume, onTrim, onShuttle, onMark, playthrough }: ScrubberProps) {
  const ready = status?.phase === "ready" && status.duration > 0;
  const duration = ready ? status.duration : 0, clipId = ready ? status.clip_id : null;
  const zoom = usePlayerPrefs().scrubberView === "zoom";
  const [width, setWidth] = useState(600);
  const readout = playthrough ? playthroughReadout(playthrough, status?.pos ?? 0) : null;
  const snapshotPosition = readout?.position ?? status?.pos ?? 0;
  const range = useMemo((): readonly [number, number] => {
    const candidate = visibleRange(duration, playthrough?.inPoint ?? inPoint, playthrough?.outPoint ?? outPoint, zoom);
    // 越界时回完整视图,保留用户偏好;回到片段内会恢复放大。
    return snapshotPosition < candidate[0] || snapshotPosition > candidate[1] ? [0, duration] : candidate;
  }, [duration, inPoint, outPoint, zoom, playthrough, snapshotPosition]);
  const gesture = useScrubGesture({ ready, clipId, pos: status?.pos ?? 0, duration, fps, paused: status?.paused !== false,
    range, inPoint, outPoint, onSeek, onPause, onResume, onTrim });
  useWheelFrames(gesture.track, ready, fps, gesture.position, gesture.seek);
  const shownRange = gesture.frozenRange ?? range;
  const media = useScrubberMedia(clipId);
  const [hover, setHover] = useState<{ seconds: number; x: number; y: number } | null>(null);
  useEffect(() => {
    const element = gesture.track.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => setWidth(entries?.[0]?.contentRect.width ?? 600));
    observer.observe(element); return () => observer.disconnect();
  }, [gesture.track]);
  useEffect(() => { setHover(null); }, [clipId]);
  const pct = (n: number) => `${ratioAt(n, shownRange) * 100}%`;
  // R24:段号、指针与 AXValueDescription 共用一次快照;stopping 保留旧段真位置。
  // 指针、数字都等同一份实际状态回读;手势目标仅用于悬停预览,不冒充已解码位置。
  const value = snapshotPosition;
  const headPct = `${(value - shownRange[0]) / (shownRange[1] - shownRange[0] || 1) * 100}%`;
  const segmentLabel = readout ? `第 ${readout.index + 1}/${readout.total} 段` : null;
  const marked = inPoint !== null && outPoint !== null && outPoint > inPoint;
  // 指针不 clamp;选段越界保留诊断标记。
  const outOfSegment = playthrough !== undefined && ready && !playthrough.switching &&
    (value < playthrough.inPoint - 0.1 || value > playthrough.outPoint + 0.1);
  const keyboard = (event: KeyboardEvent, edge: Edge) => {
    if (!ready || event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
    const from = edge === "in" ? inPoint ?? 0 : edge === "out" ? outPoint ?? duration : gesture.position();
    let target: number;
    switch (event.key) {
      case "ArrowLeft": target = from - (event.shiftKey ? 10 : 1) / fps; break;
      case "ArrowRight": target = from + (event.shiftKey ? 10 : 1) / fps; break;
      case "Home": target = edge === "play" ? inPoint ?? 0 : 0; break;
      case "End": target = edge === "play" ? outPoint ?? duration : duration; break;
      default: {
        const key = event.key.toLowerCase();
        if (!event.shiftKey && (key === "j" || key === "k" || key === "l")) { event.preventDefault(); onShuttle?.(key); }
        if (key === "i" || key === "o") { event.preventDefault(); onMark?.(key === "i" ? "in" : "out"); }
        return;
      }
    }
    event.preventDefault(); event.stopPropagation(); gesture.seek(target, edge);
  };
  const enter = (x: number) => {
    if (!ready) return;
    const rect = gesture.track.current?.getBoundingClientRect();
    if (!rect) return;
    if (x < rect.left || x > rect.left + rect.width) { setHover(null); media.hide(); return; }
    const seconds = gesture.at(x);
    setHover({ seconds, x: clamp(x, 88, window.innerWidth - 88), y: Math.min(rect.bottom + 8, window.innerHeight - 128) });
    media.request(seconds);
  };
  const leave = () => { setHover(null); media.hide(); };
  const previewVisible = hover && (gesture.drag || media.preview);
  return <span className="scrubber-r22">
    <span className="scrubber-r22-track-wrap">
      <div ref={gesture.track} role="slider" tabIndex={ready ? 0 : -1} aria-label="播放位置" aria-valuemin={0} aria-valuemax={duration}
        aria-valuenow={value} aria-valuetext={segmentLabel ? `${timecode(value, fps)} · ${segmentLabel}` : timecode(value, fps)} aria-disabled={!ready} className="scrubber-r22-track"
        data-out-of-range={outOfSegment ? "" : undefined}
        onKeyDown={e => keyboard(e, "play")}
        onPointerDown={e => { gesture.start(e, "play"); enter(e.clientX); }}
        onPointerMove={e => { gesture.move(e); enter(e.clientX); }}
        onPointerUp={e => gesture.end(e)} onPointerCancel={() => { gesture.end(); setHover(null); media.hide(); }}
        onLostPointerCapture={() => gesture.end()} onPointerLeave={leave}>
        <ScrubberLayers range={shownRange} width={width} duration={duration} peaks={media.peaks} heat={heat} />
        <span className="scrubber-r22-fill" aria-hidden="true" style={{ width: pct(value) }} />
        {!playthrough && inPoint !== null && <span className="monitor-seek-range scrubber-r22-range" aria-hidden="true"
          style={{ left: pct(inPoint), width: outPoint === null ? "2px" : `calc(${pct(outPoint)} - ${pct(inPoint)})` }} />}
        {!playthrough && marked && <><span className="scrubber-r22-outside" style={{ left: 0, width: pct(inPoint) }} /><span className="scrubber-r22-outside" style={{ left: pct(outPoint), right: 0 }} /></>}
        {playthrough && <span className="scrubber-r22-playthrough" data-playing="" aria-hidden="true"
          style={{ left: pct(playthrough.inPoint), width: `calc(${pct(playthrough.outPoint)} - ${pct(playthrough.inPoint)})` }} />}
        <span className="scrubber-r22-head" aria-hidden="true" style={{ left: headPct }} />
      </div>
      {(["in", "out"] as const).map(edge => {
        const point = edge === "in" ? inPoint : outPoint;
        return point !== null && onTrim ? <div key={edge} role="slider" tabIndex={ready ? 0 : -1}
          aria-label={edge === "in" ? "入点" : "出点"} aria-valuemin={edge === "out" ? (inPoint ?? 0) + 1 / fps : 0}
          aria-valuemax={edge === "in" ? Math.max(0, (outPoint ?? duration) - 1 / fps) : duration}
          aria-valuenow={point} aria-valuetext={timecode(point, fps)} aria-disabled={!ready}
          className={`scrubber-r22-handle scrubber-r22-handle--${edge}`} style={{ left: pct(point) }}
          onKeyDown={e => keyboard(e, edge)} onPointerDown={e => { gesture.start(e, edge); enter(e.clientX); }}
          onPointerMove={e => { gesture.move(e); enter(e.clientX); }} onPointerUp={e => gesture.end(e)}
          onPointerCancel={() => { gesture.end(); setHover(null); media.hide(); }} onLostPointerCapture={() => gesture.end()}
          onPointerLeave={leave}>{edge === "in" ? "I" : "O"}</div> : null;
      })}
    </span>
    {playthrough && <span className="scrubber-r22-playthrough-label" title="镜头带连播:当前段">{segmentLabel}</span>}
    <button type="button" className="scrubber-r22-scope" aria-label="切换进度条范围" aria-pressed={zoom}
      title="完整素材 / 放大片段；放大时越界自动显示完整素材"
      onClick={() => void writeScrubberView(zoom ? "full" : "zoom")}>
      {zoom ? "放大片段" : "完整素材"}
    </button>
    {previewVisible && createPortal(<div className="scrubber-r22-preview" role="tooltip" style={{ left: hover.x, top: hover.y }}>
      {media.preview?.url ? <img src={media.preview.url} width={160} height={90} alt="悬停位置预览" crossOrigin="anonymous" /> : <span className="scrubber-r22-no-frame">{media.preview?.url === null ? "预览暂不可用" : "正在取帧…"}</span>}
      <span>{timecode(gesture.drag ? gesture.local ?? hover.seconds : media.preview?.seconds ?? hover.seconds, fps)}</span>
      {gesture.drag && gesture.drag !== "play" && marked && <span>区间 {timecode(outPoint - inPoint, fps, true)}</span>}
    </div>, document.body)}
  </span>;
}
