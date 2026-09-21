import { useCallback, useEffect, useRef, useState } from "react";
import { listSelectSegments, type ClipListItem, type DuelSession, type PlayerStatus, type SelectSegment } from "../../api";
import { PlayerOverlay, type EmbeddedPlayerControls } from "../../PlayerOverlay";
import { photoSizeLabel } from "../photoModel";
import { PHOTO_ZOOM_MODES, photoZoomLabel, usePhotoZoom } from "../photoZoom";
import { Button } from "../ui";
import { usePlayerOcclusion } from "../usePlayerOcclusion";

export const DUEL_PHOTO_ZOOM = "tripcut:duel-photo-zoom";

function memberKey(member: DuelSession["members"][number]): string {
  return member.segment_id === null ? `photo:${member.clip_id}` : `video:${member.segment_id}`;
}

function clipForKey(session: DuelSession, clips: readonly ClipListItem[], key: string): ClipListItem | undefined {
  const member = session.members.find((item) => memberKey(item) === key);
  return clips.find((clip) => clip.id === member?.clip_id);
}

type ExifItem = { label: string; value: string };
function exif(clip: ClipListItem | undefined): ExifItem[] {
  if (!clip) return [];
  const photo = clip.photo;
  return [
    { label: "尺寸", value: photo ? photoSizeLabel(clip) : "—" },
    { label: "拍摄时间", value: photo?.taken_at_local ?? "—" },
    { label: "机身", value: photo?.camera ?? "—" },
    { label: "镜头", value: photo?.lens ?? "—" },
    { label: "ISO", value: clip.iso_value != null ? String(clip.iso_value) : "—" },
    { label: "快门", value: clip.shutter_speed ?? "—" },
    { label: "光圈", value: clip.aperture ?? "—" },
  ];
}

function PhotoDuelPreview({ session, clips, active }: { session: DuelSession; clips: readonly ClipListItem[]; active: number; onActive(side: number): void }) {
  const pair = session.pair.map((key) => clipForKey(session, clips, key));
  const zoom = usePhotoZoom(session.pair.join("|"));
  const stageRef = useRef<HTMLDivElement | null>(null);
  const details = pair.map(exif);
  useEffect(() => {
    const cycle = () => zoom.cycle();
    window.addEventListener(DUEL_PHOTO_ZOOM, cycle);
    return () => window.removeEventListener(DUEL_PHOTO_ZOOM, cycle);
  }, [zoom]);
  useEffect(() => {
    const canvases = stageRef.current?.querySelectorAll<HTMLElement>(".photo-duel-canvas") ?? [];
    const onWheel = (event: WheelEvent) => { event.preventDefault(); zoom.wheel(event.deltaY); };
    canvases.forEach((canvas) => canvas.addEventListener("wheel", onWheel, { passive: false }));
    return () => canvases.forEach((canvas) => canvas.removeEventListener("wheel", onWheel));
  }, [zoom.wheel]);
  return <div className="duel-previews photo-duel-preview">
    <div className="photo-duel-tools" role="group" aria-label="照片对比缩放">
      <strong>同步检视</strong>
      {PHOTO_ZOOM_MODES.map((mode) => <Button key={mode} size="sm" aria-pressed={zoom.mode === mode} onClick={() => zoom.choose(mode)}>{photoZoomLabel(mode)}</Button>)}
    </div>
    <div className="photo-duel-stage" ref={stageRef}>{session.pair.map((key, side) => {
      const clip = pair[side];
      const values = details[side] ?? [];
      return <article key={key} className={active === side ? "photo-duel-side is-active" : "photo-duel-side"} aria-label={`${side === 0 ? "左侧" : "右侧"}照片 ${clip?.file_name ?? key}`}>
        <div className={`photo-duel-canvas is-${zoom.mode}`} role="group" aria-label={`${side === 0 ? "左侧" : "右侧"}照片查看区`} onPointerDown={zoom.onPointerDown} onPointerMove={zoom.onPointerMove} onPointerUp={zoom.onPointerUp} onPointerCancel={zoom.onPointerUp}>
          {clip && (clip.photo?.preview_url ?? clip.cover_url) ? <img style={zoom.imageStyle} src={clip.photo?.preview_url ?? clip.cover_url ?? undefined} alt={`${side === 0 ? "左侧" : "右侧"}对比照片 ${clip.file_name}`} crossOrigin="anonymous" draggable={false} /> : <span>照片预览准备中</span>}
        </div>
        <strong className="photo-duel-name">{clip?.file_name ?? key}</strong>
        <dl className="photo-duel-exif">{values.map((item, index) => {
          const other = details[1 - side]?.[index]?.value;
          const different = item.value !== other && (item.value !== "—" || other !== "—");
          return <div key={item.label} data-different={different ? "true" : undefined}><dt>{item.label}</dt><dd>{item.value}</dd></div>;
        })}</dl>
      </article>;
    })}</div>
    <div className="photo-duel-members" role="list" aria-label={`本组照片 ${session.members.length} 张`}>
      {session.members.map((member) => {
        const key = memberKey(member);
        const clip = clips.find((item) => item.id === member.clip_id);
        return <div role="listitem" key={key} className={session.pair.includes(key) ? "is-pair" : ""} aria-label={`组员照片 ${clip?.file_name ?? key}`}>
          {clip?.cover_url ? <img src={clip.cover_url} alt="" crossOrigin="anonymous" /> : <span />}
          <small>{clip?.file_name ?? key}</small>
        </div>;
      })}
    </div>
  </div>;
}

function VideoDuelPreview({ session, clips, active, onActive }: { session: DuelSession; clips: readonly ClipListItem[]; active: number; onActive(side: number): void }) {
  const key = session.pair[active];
  const member = session.members.find((item) => key === memberKey(item));
  const clip = clips.find((item) => item.id === member?.clip_id);
  const [segment, setSegment] = useState<SelectSegment | null>(null);
  const controls = useRef<EmbeddedPlayerControls | null>(null);
  const started = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true; started.current = null; setSegment(null); setError(null);
    if (member?.preview) setSegment(member.preview);
    else if (member?.segment_id != null) void listSelectSegments(member.clip_id).then((rows) => {
      if (live) setSegment(rows.find((row) => row.id === member.segment_id) ?? null);
    }).catch((cause) => { if (live) setError(String(cause)); });
    return () => { live = false; };
  }, [member?.clip_id, member?.segment_id, member?.preview, key]);
  const status = useCallback((next: PlayerStatus | null) => {
    if (!next || next.phase !== "ready" || next.clip_id !== clip?.id || !segment || !controls.current || !key) return;
    const start = segment.in_ticks * segment.tb_num / segment.tb_den;
    const end = segment.out_ticks * segment.tb_num / segment.tb_den;
    if (started.current !== key) {
      started.current = key;
      void controls.current.send([{ type: "seek_abs", seconds: start }, { type: "play" }]).catch((cause) => setError(String(cause)));
    } else if (!next.paused && next.pos >= end) void controls.current.send([{ type: "pause" }]).catch((cause) => setError(String(cause)));
  }, [clip?.id, segment, key]);
  return <div className="duel-previews">
    <div className="duel-covers">{session.pair.map((id, side) => {
      const pairClip = clipForKey(session, clips, id);
      return <button type="button" className={active === side ? "is-active" : ""} key={id} aria-label={`预览${side === 0 ? "左" : "右"}边`} onMouseEnter={() => onActive(side)} onFocus={() => onActive(side)} onClick={() => onActive(side)}>
        {pairClip?.cover_url ? <img src={pairClip.kind === "photo" ? pairClip.photo?.preview_url ?? pairClip.cover_url : pairClip.cover_url} alt={pairClip.file_name} /> : <span>封面尚未生成</span>}
        <span>{pairClip?.file_name ?? id}</span>
      </button>;
    })}</div>
    {clip && clip.kind !== "photo" && segment ? <div className="duel-player"><PlayerOverlay clip={clip} variant="embedded" onExit={() => undefined} controlsRef={controls} onStatusChange={status} /></div> : null}
    {error ? <p role="alert">预览失败：{error}</p> : null}
  </div>;
}

/** 照片使用双静态画布；视频/混合继续只复用一个既有嵌入播放器。 */
export function DuelPreview(props: { session: DuelSession; clips: readonly ClipListItem[]; active: number; onActive(side: number): void }) {
  usePlayerOcclusion();
  const photoPair = props.session.pair.length === 2 && props.session.pair.every((key) => clipForKey(props.session, props.clips, key)?.kind === "photo");
  return photoPair ? <PhotoDuelPreview {...props} /> : <VideoDuelPreview {...props} />;
}
